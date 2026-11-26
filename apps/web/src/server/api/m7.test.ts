// M7 through /api/v1: archiving and restoring tasks (all or nothing, the read-only rule, the
// archived list filter), the archive setting and its preview, check-again days, pull request links
// and the repository settings, each with who may call it: a member's session, an owner's or an
// admin's, an agent's write key and a read-only key. Then the two webhook routes with request
// events: the repository webhook (signed, unsigned, unknown ids) and a mirror's Backlog.md webhook.
// Fresh data in a throwaway database: the Northwind workspace with a native project linked to a
// GitHub repository read through a fake host, a project without one and a mirrored project.
import { createHmac } from 'node:crypto';
import { createAuth } from '@zamu/auth';
import {
  type CoreContext,
  createApiKey,
  createProject,
  createTask,
  encryptSecret,
  type JobPayload,
  REPOSITORY_EVENT,
  REPOSITORY_SYNC,
} from '@zamu/core';
import {
  FakeProvider,
  fakeProviderFactory,
  type RecordingJobQueue,
  recordingJobQueue,
  TEST_ENCRYPTION_KEY,
} from '@zamu/core/backlog/testing';
import { createBacklogSourceRow, createGitConnectionRow } from '@zamu/core/testing/backlog';
import {
  addMember,
  createTaskRow,
  createUser,
  createWorld,
  isoDate,
  projectRow,
  randomWorkspaceSlug,
  type World,
} from '@zamu/core/testing/fixtures';
import { schema } from '@zamu/db';
import { createTestDatabase, type TestDatabase } from '@zamu/db/test';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { handleBacklogWebhook, handleRepositoryWebhook } from '../webhooks';
import { createApiFetchHandler } from './index';

const ORIGIN = 'http://localhost:3000';
const SECRET = 'test-secret-test-secret-test-secret-0123';
const PASSWORD = 'correct horse battery';
const REPOSITORY = 'https://github.com/northwind/payments';
const BACKLOG_SECRET = 'backlog-webhook-secret';

type RequestInfo = JobPayload<typeof REPOSITORY_EVENT>['request'];

/** The fake host with requests: getRequest answers from `requests`, like the GitHub adapter. */
class RequestHost extends FakeProvider {
  readonly requests = new Map<number, RequestInfo>();

  async getRequest(_path: string, number: number): Promise<RequestInfo | null> {
    return this.requests.get(number) ?? null;
  }

  async listRequestsUpdatedSince(): Promise<RequestInfo[]> {
    return [...this.requests.values()];
  }
}

/** A request of github.com/northwind/payments (or `repository`), open, updated an hour ago. */
function request(
  number: number,
  values: Partial<RequestInfo> = {},
  repository = 'northwind/payments',
): RequestInfo {
  const at = new Date(Date.now() - 3_600_000).toISOString();
  return {
    number,
    title: `Retry failed card payments ${number}`,
    body: '',
    state: 'open',
    headBranch: `task/${number}`,
    baseBranch: 'main',
    author: 'claude-dev',
    mergedBy: null,
    webUrl: `https://github.com/${repository}/pull/${number}`,
    openedAt: at,
    mergedAt: null,
    closedAt: null,
    updatedAt: at,
    ...values,
  };
}

let database: TestDatabase;
let core: CoreContext & { jobs: RecordingJobQueue };
let provider: RequestHost;
let handle: (request: Request) => Promise<Response>;
let world: World;
let slug: string;
/** Native project linked to github.com/northwind/payments. */
let pay: string;
/** Native project without a repository. */
let ops: string;
/** Mirrored from Backlog.md, linked to github.com/northwind/ledger. */
let back: string;
let backTask: string;
let backWebhookId: string;
const cookies = {} as { owner: string; admin: string; member: string };
const keys = {} as { agent: string; read: string };

type Auth = { cookie: string } | { key: string } | null;

async function call(method: string, path: string, options: { auth?: Auth; body?: unknown } = {}) {
  const headers: Record<string, string> = { 'x-zamu-workspace': slug };
  const { auth = null } = options;
  if (auth && 'cookie' in auth) headers.cookie = auth.cookie;
  if (auth && 'key' in auth) headers.authorization = `Bearer ${auth.key}`;
  const init: RequestInit = { method, headers };
  if (options.body !== undefined) {
    headers['content-type'] = 'application/json';
    init.body = JSON.stringify(options.body);
  }
  const response = await handle(new Request(`${ORIGIN}${path}`, init));
  const text = await response.text();
  // biome-ignore lint/suspicious/noExplicitAny: response bodies are checked field by field
  const body: any = text ? JSON.parse(text) : null;
  return { status: response.status, headers: response.headers, body };
}

const owner = (): Auth => ({ cookie: cookies.owner });
const admin = (): Auth => ({ cookie: cookies.admin });
const member = (): Auth => ({ cookie: cookies.member });
const agent = (): Auth => ({ key: keys.agent });
const readOnly = (): Auth => ({ key: keys.read });

function expectProblem(result: Awaited<ReturnType<typeof call>>, status: number, code: string): void {
  expect(result.status, JSON.stringify(result.body)).toBe(status);
  expect(result.body).toMatchObject({ status, code, type: 'about:blank' });
  expect(result.body.requestId).toBe(result.headers.get('x-request-id'));
}

async function withPassword(userId: string): Promise<void> {
  const context = await core.auth.$context;
  await database.db.insert(schema.account).values({
    accountId: userId,
    providerId: 'credential',
    userId,
    password: await context.password.hash(PASSWORD),
  });
}

async function signIn(email: string): Promise<string> {
  const result = await core.auth.api.signInEmail({
    body: { email, password: PASSWORD },
    returnHeaders: true,
  });
  return result.headers
    .getSetCookie()
    .map((c) => c.split(';')[0])
    .join('; ');
}

async function newTask(project: string, title = 'Task'): Promise<string> {
  return (await createTask(core, world.ownerActor, { project, title })).key;
}

async function taskRowOf(key: string) {
  const [prefix, number] = key.split('-');
  const projectId = (await projectRow(database.db, world.workspaceId, prefix as string)).id;
  const { rows } = await database.pool.query<{ archived_at: Date | null }>(
    'SELECT archived_at FROM task WHERE project_id = $1 AND number = $2',
    [projectId, Number(number)],
  );
  if (!rows[0]) throw new Error(`task ${key} not found`);
  return { archivedAt: rows[0].archived_at };
}

beforeAll(async () => {
  database = await createTestDatabase({ prefix: 'pm_web_m7' });
  database.pool.on('error', () => {});
  const auth = createAuth({ db: database.db, secret: SECRET, baseUrl: ORIGIN });
  provider = new RequestHost([], 'github', 'github.com');
  core = {
    db: database.db,
    auth,
    publicUrl: ORIGIN,
    timeZone: 'UTC',
    encryptionKey: TEST_ENCRYPTION_KEY,
    providerFactory: fakeProviderFactory(provider),
    jobs: recordingJobQueue(),
  };
  handle = createApiFetchHandler(core);

  slug = randomWorkspaceSlug('northwind');
  world = await createWorld(database.db, 'Northwind', { slug });
  const adminUser = await createUser(database.db, { name: 'Ines Admin' });
  await addMember(database.db, world.workspaceId, { id: adminUser.id, kind: 'person' }, 'admin');
  for (const user of [world.owner, world.member, adminUser]) await withPassword(user.id);
  cookies.owner = await signIn(world.owner.email);
  cookies.admin = await signIn(adminUser.email);
  cookies.member = await signIn(world.member.email);
  keys.agent = (
    await createApiKey(core, world.ownerActor, {
      name: 'claude-dev',
      ownerId: world.agent.id,
      scope: { projects: 'all', access: 'write' },
    })
  ).key;
  keys.read = (
    await createApiKey(core, world.ownerActor, {
      name: 'read only',
      scope: { projects: 'all', access: 'read' },
    })
  ).key;

  pay = (
    await createProject(core, world.ownerActor, { key: 'PAY', name: 'Payments', repository: REPOSITORY })
  ).key;
  ops = (await createProject(core, world.ownerActor, { key: 'OPS', name: 'Operations' })).key;
  back = (await createProject(core, world.ownerActor, { key: 'BACK', name: 'Mirrored' })).key;
  const backRow = await projectRow(database.db, world.workspaceId, back);
  // Raw rows: the mirror engine writes these itself. No connection, so any host's signature counts.
  await database.pool.query('UPDATE project SET repository = $1, repository_key = $2 WHERE id = $3', [
    'https://github.com/northwind/ledger',
    'github.com/northwind/ledger',
    backRow.id,
  ]);
  const source = await createBacklogSourceRow(database.db, backRow.id, {
    createdById: world.owner.id,
    webhookSecretCiphertext: encryptSecret(core, BACKLOG_SECRET),
  });
  backWebhookId = source.webhookId as string;
  const mirroredTask = await createTaskRow(database.db, backRow.id, {
    createdById: world.owner.id,
    title: 'Mirrored task',
  });
  backTask = `${back}-${mirroredTask.number}`;
}, 60_000);

afterAll(async () => {
  await database?.drop();
});

describe('M7: archiving tasks', () => {
  it('archives and restores several tasks, which leave lists and refuse writes meanwhile', async () => {
    const first = await newTask(ops, 'Archive me');
    const second = await newTask(ops, 'And me');

    const archived = await call('POST', '/api/v1/tasks/archive', {
      auth: member(),
      body: { keys: [second, first] },
    });
    expect(archived.status, JSON.stringify(archived.body)).toBe(200);
    expect(archived.body.items.map((item: { key: string }) => item.key)).toEqual([second, first]);
    for (const item of archived.body.items) expect(item.archivedAt).toEqual(expect.any(String));

    const listed = await call('GET', `/api/v1/tasks?project=${ops}`, { auth: member() });
    expect(listed.status).toBe(200);
    const listedKeys = listed.body.items.map((item: { key: string }) => item.key);
    expect(listedKeys).not.toContain(first);
    expect(listedKeys).not.toContain(second);
    const only = await call('GET', `/api/v1/tasks?project=${ops}&archived=only`, { auth: member() });
    expect(only.body.items.map((item: { key: string }) => item.key).sort()).toEqual([first, second].sort());
    const included = await call('GET', `/api/v1/tasks?project=${ops}&archived=include`, { auth: member() });
    expect(included.body.items.map((item: { key: string }) => item.key)).toEqual(
      expect.arrayContaining([first, second]),
    );
    expectProblem(
      await call('GET', `/api/v1/tasks?project=${ops}&archived=maybe`, { auth: member() }),
      400,
      'BAD_REQUEST',
    );

    const shown = await call('GET', `/api/v1/tasks/${first}`, { auth: agent() });
    expect(shown.status).toBe(200);
    expect(shown.body).toMatchObject({ key: first, archivedAt: expect.any(String) });
    expect(shown.body.archivedBy).toMatchObject({ id: world.member.id });

    expectProblem(
      await call('PATCH', `/api/v1/tasks/${first}`, { auth: member(), body: { title: 'Changed' } }),
      409,
      'TASK_ARCHIVED',
    );
    expectProblem(
      await call('POST', '/api/v1/tasks/bulk', { auth: member(), body: { keys: [first], priority: 'high' } }),
      409,
      'TASK_ARCHIVED',
    );
    expectProblem(
      await call('POST', `/api/v1/tasks/${first}/comments`, {
        auth: agent(),
        body: { body: 'Still there?' },
      }),
      409,
      'TASK_ARCHIVED',
    );

    const restored = await call('POST', '/api/v1/tasks/restore', {
      auth: agent(),
      body: { keys: [first, second] },
    });
    expect(restored.status, JSON.stringify(restored.body)).toBe(200);
    for (const item of restored.body.items) expect(item.archivedAt ?? null).toBeNull();
    const patched = await call('PATCH', `/api/v1/tasks/${first}`, {
      auth: member(),
      body: { title: 'Changed' },
    });
    expect(patched.status, JSON.stringify(patched.body)).toBe(200);
  });

  it('lets owners, admins, members and agent keys archive; a read-only key and no credentials may not', async () => {
    for (const auth of [owner(), admin(), member(), agent()]) {
      const key = await newTask(ops);
      const result = await call('POST', '/api/v1/tasks/archive', { auth, body: { keys: [key] } });
      expect(result.status, JSON.stringify(result.body)).toBe(200);
    }
    const key = await newTask(ops);
    expectProblem(
      await call('POST', '/api/v1/tasks/archive', { auth: readOnly(), body: { keys: [key] } }),
      403,
      'FORBIDDEN',
    );
    expectProblem(
      await call('POST', '/api/v1/tasks/restore', { auth: readOnly(), body: { keys: [key] } }),
      403,
      'FORBIDDEN',
    );
    expectProblem(
      await call('POST', '/api/v1/tasks/archive', { body: { keys: [key] } }),
      401,
      'UNAUTHORIZED',
    );
    expect((await taskRowOf(key)).archivedAt).toBeNull();
  });

  it('archives all or nothing: a mirrored or unknown task fails the whole request', async () => {
    const native = await newTask(ops);

    const mixed = await call('POST', '/api/v1/tasks/archive', {
      auth: owner(),
      body: { keys: [native, backTask] },
    });
    expectProblem(mixed, 409, 'TASK_MIRRORED');
    expect(mixed.body.detail).toContain('archive/tasks/');
    expect((await taskRowOf(native)).archivedAt).toBeNull();

    expectProblem(
      await call('POST', '/api/v1/tasks/archive', { auth: owner(), body: { keys: [native, `${ops}-9999`] } }),
      404,
      'NOT_FOUND',
    );
    expect((await taskRowOf(native)).archivedAt).toBeNull();

    expectProblem(
      await call('POST', '/api/v1/tasks/restore', { auth: owner(), body: { keys: [backTask] } }),
      409,
      'TASK_MIRRORED',
    );
    expectProblem(
      await call('POST', '/api/v1/tasks/archive', { auth: owner(), body: { keys: [] } }),
      400,
      'BAD_REQUEST',
    );
    const tooMany = Array.from({ length: 101 }, (_, i) => `${ops}-${i + 1}`);
    expectProblem(
      await call('POST', '/api/v1/tasks/archive', { auth: owner(), body: { keys: tooMany } }),
      400,
      'BAD_REQUEST',
    );
  });
});

describe('M7: the archive setting', () => {
  it('owners and admins set archiveAfterDays; members and agents get 403; mirrored projects 409', async () => {
    const created = await call('POST', '/api/v1/projects', {
      auth: owner(),
      body: { key: 'NEW', name: 'New one' },
    });
    expect(created.status, JSON.stringify(created.body)).toBe(201);
    expect(created.body.archiveAfterDays).toBe(14);

    const byOwner = await call('PATCH', `/api/v1/projects/${ops}`, {
      auth: owner(),
      body: { archiveAfterDays: 30 },
    });
    expect(byOwner.status, JSON.stringify(byOwner.body)).toBe(200);
    expect(byOwner.body.archiveAfterDays).toBe(30);
    const byAdmin = await call('PATCH', `/api/v1/projects/${ops}`, {
      auth: admin(),
      body: { archiveAfterDays: null },
    });
    expect(byAdmin.status, JSON.stringify(byAdmin.body)).toBe(200);
    expect(byAdmin.body.archiveAfterDays).toBeNull();

    const byMember = await call('PATCH', `/api/v1/projects/${ops}`, {
      auth: member(),
      body: { archiveAfterDays: 7 },
    });
    expectProblem(byMember, 403, 'FORBIDDEN');
    expect(byMember.body.detail).toContain('archive setting');
    expectProblem(
      await call('PATCH', `/api/v1/projects/${ops}`, { auth: agent(), body: { archiveAfterDays: 7 } }),
      403,
      'FORBIDDEN',
    );
    expectProblem(
      await call('PATCH', `/api/v1/projects/${back}`, { auth: owner(), body: { archiveAfterDays: 7 } }),
      409,
      'PROJECT_MIRRORED',
    );
    expectProblem(
      await call('PATCH', `/api/v1/projects/${ops}`, { auth: owner(), body: { archiveAfterDays: 0 } }),
      400,
      'BAD_REQUEST',
    );
    expectProblem(
      await call('PATCH', `/api/v1/projects/${ops}`, { auth: owner(), body: { archiveAfterDays: 366 } }),
      400,
      'BAD_REQUEST',
    );
    const listed = await call('GET', '/api/v1/projects', { auth: member() });
    const mirrored = listed.body.items.find((p: { key: string }) => p.key === back);
    expect(mirrored.archiveAfterDays).toBeNull();
  });

  it('previews how many closed tasks the nightly run would archive with N days', async () => {
    const preview = await createProject(core, world.ownerActor, { key: 'PRE', name: 'Preview' });
    const row = await projectRow(database.db, world.workspaceId, preview.key);
    const daysAgo = (days: number) => new Date(Date.now() - days * 86_400_000);
    await createTaskRow(database.db, row.id, {
      createdById: world.owner.id,
      status: 'done',
      closedAt: daysAgo(30),
    });
    await createTaskRow(database.db, row.id, {
      createdById: world.owner.id,
      status: 'canceled',
      closedAt: daysAgo(10),
    });
    await createTaskRow(database.db, row.id, {
      createdById: world.owner.id,
      status: 'done',
      closedAt: daysAgo(1),
    });
    await createTaskRow(database.db, row.id, { createdById: world.owner.id, status: 'todo' });

    const counts: Record<number, number> = {};
    for (const days of [5, 14, 60]) {
      const result = await call('GET', `/api/v1/projects/${preview.key}/archive-preview?days=${days}`, {
        auth: member(),
      });
      expect(result.status, JSON.stringify(result.body)).toBe(200);
      expect(result.body).toMatchObject({ project: preview.key, days });
      counts[days] = result.body.count;
    }
    expect(counts).toEqual({ 5: 2, 14: 1, 60: 0 });

    const byKey = await call('GET', `/api/v1/projects/${preview.key}/archive-preview?days=5`, {
      auth: readOnly(),
    });
    expect(byKey.body.count).toBe(2);
    const mirrored = await call('GET', `/api/v1/projects/${back}/archive-preview?days=1`, { auth: owner() });
    expect(mirrored.status).toBe(200);
    expect(mirrored.body.count).toBe(0);
    // Nothing was archived.
    const { rows: archivedRows } = await database.pool.query(
      'SELECT 1 FROM task WHERE project_id = $1 AND archived_at IS NOT NULL',
      [row.id],
    );
    expect(archivedRows).toHaveLength(0);

    for (const days of ['0', '366', 'soon']) {
      expectProblem(
        await call('GET', `/api/v1/projects/${preview.key}/archive-preview?days=${days}`, { auth: member() }),
        400,
        'BAD_REQUEST',
      );
    }
    expectProblem(
      await call('GET', '/api/v1/projects/NOPE/archive-preview?days=5', { auth: member() }),
      404,
      'NOT_FOUND',
    );
    expectProblem(
      await call('GET', `/api/v1/projects/${preview.key}/archive-preview?days=5`),
      401,
      'UNAUTHORIZED',
    );
  });
});

describe('M7: check-again days', () => {
  it('sets a day with its reason, filters lists by it and clears it', async () => {
    const waiting = await newTask(ops, 'Waiting on the bank');
    const ready = await newTask(ops, 'Look again');
    const later = isoDate(5);
    const past = isoDate(-1);

    const set = await call('PATCH', `/api/v1/tasks/${waiting}`, {
      auth: agent(),
      body: { checkAgain: { on: later, reason: 'The bank answers on Monday' } },
    });
    expect(set.status, JSON.stringify(set.body)).toBe(200);
    expect(set.body.checkAgain).toEqual({ on: later, reason: 'The bank answers on Monday' });
    const setReady = await call('PATCH', `/api/v1/tasks/${ready}`, {
      auth: member(),
      body: { checkAgain: { on: past, reason: 'Was due yesterday' } },
    });
    expect(setReady.status, JSON.stringify(setReady.body)).toBe(200);

    const keysOf = async (filter: string) => {
      const result = await call('GET', `/api/v1/tasks?project=${ops}&checkAgain=${filter}`, {
        auth: member(),
      });
      expect(result.status, JSON.stringify(result.body)).toBe(200);
      return result.body.items.map((item: { key: string }) => item.key);
    };
    expect(await keysOf('waiting')).toEqual([waiting]);
    expect(await keysOf('ready')).toEqual([ready]);
    expect((await keysOf('set')).sort()).toEqual([waiting, ready].sort());
    expect(await keysOf('none')).not.toContain(waiting);
    const row = (await call('GET', `/api/v1/tasks?project=${ops}&checkAgain=waiting`, { auth: member() }))
      .body.items[0];
    expect(row.checkAgain).toMatchObject({ on: later, reason: 'The bank answers on Monday' });

    expectProblem(
      await call('PATCH', `/api/v1/tasks/${waiting}`, {
        auth: member(),
        body: { checkAgain: { on: later } },
      }),
      400,
      'BAD_REQUEST',
    );
    expectProblem(
      await call('PATCH', `/api/v1/tasks/${waiting}`, {
        auth: member(),
        body: { checkAgain: { on: later, reason: '   ' } },
      }),
      400,
      'BAD_REQUEST',
    );
    expectProblem(
      await call('PATCH', `/api/v1/tasks/${waiting}`, {
        auth: readOnly(),
        body: { checkAgain: { on: later, reason: 'Read only' } },
      }),
      403,
      'FORBIDDEN',
    );

    const cleared = await call('PATCH', `/api/v1/tasks/${waiting}`, {
      auth: member(),
      body: { checkAgain: null },
    });
    expect(cleared.status).toBe(200);
    expect(cleared.body.checkAgain ?? null).toBeNull();
    expect(await keysOf('waiting')).toEqual([]);
    expectProblem(
      await call('GET', `/api/v1/tasks?project=${ops}&checkAgain=soon`, { auth: member() }),
      400,
      'BAD_REQUEST',
    );
  });

  it('a mirrored task may hold a check-again day', async () => {
    const result = await call('PATCH', `/api/v1/tasks/${backTask}`, {
      auth: owner(),
      body: { checkAgain: { on: isoDate(3), reason: 'Waiting on the vendor' } },
    });
    expect(result.status, JSON.stringify(result.body)).toBe(200);
    expect(result.body.checkAgain).toMatchObject({ reason: 'Waiting on the vendor' });
  });
});

describe('M7: pull requests on a task', () => {
  it('previews with dryRun, links by hand, shows on the task and unlinks', async () => {
    const key = await newTask(pay, 'Retry failed payments');
    provider.requests.set(482, request(482));
    const url = 'https://github.com/northwind/payments/pull/482';

    const preview = await call('POST', `/api/v1/tasks/${key}/pull-requests`, {
      auth: member(),
      body: { url, dryRun: true },
    });
    expect(preview.status, JSON.stringify(preview.body)).toBe(200);
    expect(preview.body).toMatchObject({ number: 482, state: 'open', how: 'hand', url });
    const untouched = await call('GET', `/api/v1/tasks/${key}`, { auth: member() });
    expect(untouched.body.pullRequests ?? []).toEqual([]);

    const linked = await call('POST', `/api/v1/tasks/${key}/pull-requests`, { auth: agent(), body: { url } });
    expect(linked.status, JSON.stringify(linked.body)).toBe(200);
    expect(linked.body).toMatchObject({ number: 482, how: 'hand', headBranch: 'task/482' });
    const shown = await call('GET', `/api/v1/tasks/${key}`, { auth: member() });
    expect(shown.body.pullRequests).toEqual([expect.objectContaining({ number: 482, how: 'hand' })]);
    const row = (await call('GET', `/api/v1/tasks?project=${pay}`, { auth: member() })).body.items.find(
      (item: { key: string }) => item.key === key,
    );
    expect(row).toMatchObject({ pullRequestCount: 1, pullRequest: expect.objectContaining({ number: 482 }) });

    const unlinked = await call('DELETE', `/api/v1/tasks/${key}/pull-requests/482`, { auth: member() });
    expect(unlinked.status, JSON.stringify(unlinked.body)).toBe(204);
    expect(unlinked.body).toBeNull();
    const after = await call('GET', `/api/v1/tasks/${key}`, { auth: member() });
    expect(after.body.pullRequests ?? []).toEqual([]);
    expectProblem(
      await call('DELETE', `/api/v1/tasks/${key}/pull-requests/482`, { auth: member() }),
      404,
      'REQUEST_NOT_FOUND',
    );

    // Linking it by hand again restores it.
    const again = await call('POST', `/api/v1/tasks/${key}/pull-requests`, { auth: owner(), body: { url } });
    expect(again.status, JSON.stringify(again.body)).toBe(200);
  });

  it('refuses other repositories, addresses that are not requests and unknown requests', async () => {
    const key = await newTask(pay);
    const link = (url: string, auth: Auth = member()) =>
      call('POST', `/api/v1/tasks/${key}/pull-requests`, { auth, body: { url } });

    const other = await link('https://github.com/northwind/website/pull/12');
    expectProblem(other, 422, 'REQUEST_OTHER_REPOSITORY');
    expect(other.body.repository).toBe('github.com/northwind/payments');
    expectProblem(await link('https://github.com/northwind/payments/issues/12'), 422, 'NOT_A_REQUEST');
    expectProblem(await link('https://github.com/northwind/payments/pull/9999'), 404, 'REQUEST_NOT_FOUND');
    expectProblem(await link('not an address'), 400, 'BAD_REQUEST');
    provider.requests.set(483, request(483));
    expectProblem(await link('https://github.com/northwind/payments/pull/483', readOnly()), 403, 'FORBIDDEN');
    expectProblem(
      await call('POST', `/api/v1/tasks/${key}/pull-requests`, {
        body: { url: 'https://github.com/northwind/payments/pull/483' },
      }),
      401,
      'UNAUTHORIZED',
    );
    expectProblem(
      await call('DELETE', `/api/v1/tasks/${key}/pull-requests/abc`, { auth: member() }),
      400,
      'BAD_REQUEST',
    );
    expectProblem(
      await call('DELETE', `/api/v1/tasks/${key}/pull-requests/483`, { auth: readOnly() }),
      403,
      'FORBIDDEN',
    );

    // A project without a repository has nothing to link from.
    const native = await newTask(ops);
    expectProblem(
      await call('POST', `/api/v1/tasks/${native}/pull-requests`, {
        auth: member(),
        body: { url: 'https://github.com/northwind/payments/pull/483' },
      }),
      409,
      'CONFLICT',
    );

    // An archived task refuses links and unlinks.
    await call('POST', '/api/v1/tasks/archive', { auth: member(), body: { keys: [key] } });
    expectProblem(await link('https://github.com/northwind/payments/pull/483'), 409, 'TASK_ARCHIVED');
    expectProblem(
      await call('DELETE', `/api/v1/tasks/${key}/pull-requests/483`, { auth: member() }),
      409,
      'TASK_ARCHIVED',
    );
  });
});

describe('M7: repository settings', () => {
  it('everyone reads; the webhook URL is built from the public URL; members may not edit', async () => {
    const byMember = await call('GET', `/api/v1/projects/${pay}/repository`, { auth: member() });
    expect(byMember.status, JSON.stringify(byMember.body)).toBe(200);
    expect(byMember.body).toMatchObject({
      project: { key: pay },
      repository: REPOSITORY,
      provider: 'github',
      connection: null,
      closeOnMerge: true,
      mirrored: false,
      canEdit: false,
      webhook: { secretSet: false, lastAt: null, lastStatus: null, coveredByBacklog: false },
      sync: { nextAt: expect.any(String) },
    });
    expect(byMember.body.webhook.url).toMatch(
      new RegExp(`^${ORIGIN}/api/webhooks/repository/[A-Za-z0-9_-]+$`),
    );
    expect(byMember.body.secret).toBeUndefined();
    expect((await call('GET', `/api/v1/projects/${pay}/repository`, { auth: owner() })).body.canEdit).toBe(
      true,
    );
    expect((await call('GET', `/api/v1/projects/${pay}/repository`, { auth: admin() })).body.canEdit).toBe(
      true,
    );
    expect((await call('GET', `/api/v1/projects/${pay}/repository`, { auth: agent() })).body.canEdit).toBe(
      false,
    );
    expect((await call('GET', `/api/v1/projects/${pay}/repository`, { auth: readOnly() })).status).toBe(200);

    const none = await call('GET', `/api/v1/projects/${ops}/repository`, { auth: member() });
    expect(none.status).toBe(200);
    expect(none.body).toMatchObject({ repository: null, webhook: null });
    expectProblem(
      await call('GET', '/api/v1/projects/NOPE/repository', { auth: member() }),
      404,
      'NOT_FOUND',
    );
    expectProblem(await call('GET', `/api/v1/projects/${pay}/repository`), 401, 'UNAUTHORIZED');

    for (const auth of [member(), agent(), readOnly()]) {
      expectProblem(
        await call('PATCH', `/api/v1/projects/${pay}/repository`, { auth, body: { closeOnMerge: false } }),
        403,
        'FORBIDDEN',
      );
      expectProblem(
        await call('POST', `/api/v1/projects/${pay}/repository/webhook-secret`, { auth }),
        403,
        'FORBIDDEN',
      );
      expectProblem(
        await call('POST', `/api/v1/projects/${pay}/repository/sync`, { auth }),
        403,
        'FORBIDDEN',
      );
    }
  });

  it('owners and admins switch close on merge, pick a connection and queue a check', async () => {
    const off = await call('PATCH', `/api/v1/projects/${pay}/repository`, {
      auth: admin(),
      body: { closeOnMerge: false },
    });
    expect(off.status, JSON.stringify(off.body)).toBe(200);
    expect(off.body.closeOnMerge).toBe(false);
    const on = await call('PATCH', `/api/v1/projects/${pay}/repository`, {
      auth: owner(),
      body: { closeOnMerge: true },
    });
    expect(on.body.closeOnMerge).toBe(true);
    expectProblem(
      await call('PATCH', `/api/v1/projects/${pay}/repository`, { auth: owner(), body: {} }),
      400,
      'BAD_REQUEST',
    );

    const gitlab = await createGitConnectionRow(database.db, world, {
      tokenCiphertext: encryptSecret(core, 'glpat-test'),
    });
    const wrongHost = await call('PATCH', `/api/v1/projects/${pay}/repository`, {
      auth: owner(),
      body: { connectionId: gitlab.id },
    });
    expectProblem(wrongHost, 422, 'UNPROCESSABLE_CONTENT');

    const github = await createGitConnectionRow(database.db, world, {
      name: 'GitHub · Northwind',
      provider: 'github',
      host: 'github.com',
      apiBaseUrl: 'https://api.github.com',
      tokenCiphertext: encryptSecret(core, 'ghp_test'),
    });
    core.jobs.clear();
    const picked = await call('PATCH', `/api/v1/projects/${pay}/repository`, {
      auth: owner(),
      body: { connectionId: github.id },
    });
    expect(picked.status, JSON.stringify(picked.body)).toBe(200);
    expect(picked.body.connection).toMatchObject({ id: github.id, provider: 'github' });
    expect(core.jobs.sent.map((job) => job.name)).toEqual([REPOSITORY_SYNC]);
    const back = await call('PATCH', `/api/v1/projects/${pay}/repository`, {
      auth: owner(),
      body: { connectionId: null },
    });
    expect(back.body.connection).toBeNull();

    core.jobs.clear();
    const sync = await call('POST', `/api/v1/projects/${pay}/repository/sync`, { auth: admin() });
    expect(sync.status, JSON.stringify(sync.body)).toBe(202);
    expect(sync.body).toBeNull();
    expect(core.jobs.sent).toEqual([expect.objectContaining({ name: REPOSITORY_SYNC })]);
    expectProblem(
      await call('POST', `/api/v1/projects/${ops}/repository/sync`, { auth: owner() }),
      409,
      'CONFLICT',
    );
  });

  it('a mirrored project reads close on merge as off and refuses to change it', async () => {
    const settings = await call('GET', `/api/v1/projects/${back}/repository`, { auth: owner() });
    expect(settings.status, JSON.stringify(settings.body)).toBe(200);
    expect(settings.body).toMatchObject({ mirrored: true, closeOnMerge: false });
    expect(settings.body.webhook.coveredByBacklog).toBe(true);
    expectProblem(
      await call('PATCH', `/api/v1/projects/${back}/repository`, {
        auth: owner(),
        body: { closeOnMerge: false },
      }),
      409,
      'PROJECT_MIRRORED',
    );
  });
});

// ---------------------------------------------------------------------------
// Webhook routes
// ---------------------------------------------------------------------------

const hmac = (secret: string, body: string) => createHmac('sha256', secret).update(body).digest('hex');

/** A GitHub pull_request delivery body for `info` with `action`. */
function pullRequestBody(info: RequestInfo, action = 'opened', repository = 'northwind/payments'): string {
  return JSON.stringify({
    action,
    number: info.number,
    pull_request: {
      html_url: info.webUrl,
      number: info.number,
      state: info.state === 'merged' || info.state === 'closed' ? 'closed' : 'open',
      title: info.title,
      user: { login: info.author },
      body: info.body,
      created_at: info.openedAt,
      updated_at: info.updatedAt,
      closed_at: info.closedAt,
      merged_at: info.mergedAt,
      draft: info.state === 'draft',
      head: { ref: info.headBranch },
      base: { ref: info.baseBranch },
      merged: info.state === 'merged',
      merged_by: null,
    },
    repository: { full_name: repository },
    sender: { login: 'ana-dev' },
  });
}

function github(body: string, secret: string | null, event = 'pull_request'): Record<string, string> {
  return {
    'x-github-event': event,
    ...(secret === null ? {} : { 'x-hub-signature-256': `sha256=${hmac(secret, body)}` }),
  };
}

function post(path: string, body: string, headers: Record<string, string>): Request {
  return new Request(`${ORIGIN}${path}`, {
    method: 'POST',
    headers: { 'content-type': 'application/json', ...headers },
    body,
  });
}

function repositoryDelivery(webhookId: string, body: string, headers: Record<string, string>) {
  return handleRepositoryWebhook(
    core,
    post(`/api/webhooks/repository/${webhookId}`, body, headers),
    webhookId,
  );
}

describe('POST /api/webhooks/repository/{webhookId}', () => {
  let webhookId: string;
  let secret: string;
  let project: string;

  beforeAll(async () => {
    project = (
      await createProject(core, world.ownerActor, {
        key: 'HOOK',
        name: 'Hooks',
        repository: 'https://github.com/northwind/hooks',
      })
    ).key;
    const settings = await call('GET', `/api/v1/projects/${project}/repository`, { auth: owner() });
    webhookId = new URL(settings.body.webhook.url).pathname.split('/').at(-1) as string;
  });

  const lastStatus = async () =>
    (await call('GET', `/api/v1/projects/${project}/repository`, { auth: member() })).body.webhook;

  it('404 with no body for an unknown id; 401 before a secret is issued', async () => {
    core.jobs.clear();
    const info = request(7, {}, 'northwind/hooks');
    const body = pullRequestBody(info, 'opened', 'northwind/hooks');
    const unknown = await repositoryDelivery('no-such-webhook', body, github(body, 'whatever'));
    expect(unknown.status).toBe(404);
    expect(await unknown.text()).toBe('');
    expect((await repositoryDelivery('no', body, github(body, 'whatever'))).status).toBe(404);

    const early = await repositoryDelivery(webhookId, body, github(body, 'whatever'));
    expect(early.status).toBe(401);
    expect(await early.text()).toBe('');
    expect(core.jobs.sent).toEqual([]);
  });

  it('401 for unsigned and badly signed deliveries, recorded for the Repository page', async () => {
    const issued = await call('POST', `/api/v1/projects/${project}/repository/webhook-secret`, {
      auth: owner(),
    });
    expect(issued.status, JSON.stringify(issued.body)).toBe(200);
    expect(issued.body.url).toBe(`${ORIGIN}/api/webhooks/repository/${webhookId}`);
    secret = issued.body.secret;
    expect(secret).toEqual(expect.any(String));
    expect((await lastStatus()).secretSet).toBe(true);
    core.jobs.clear();

    const body = pullRequestBody(request(7, {}, 'northwind/hooks'), 'opened', 'northwind/hooks');
    const unsigned = await repositoryDelivery(webhookId, body, github(body, null));
    expect(unsigned.status).toBe(401);
    expect(await lastStatus()).toMatchObject({ lastStatus: 'bad_signature', lastAt: expect.any(String) });
    expect((await repositoryDelivery(webhookId, body, github(body, `${secret}x`))).status).toBe(401);
    // The same signature over other bytes fails: the route hands core the exact body it received.
    expect((await repositoryDelivery(webhookId, `${body} `, github(body, secret))).status).toBe(401);
    expect(core.jobs.sent).toEqual([]);
  });

  it('202 and a repository.event job for a signed request event; 200 for a ping', async () => {
    core.jobs.clear();
    const info = request(7, {}, 'northwind/hooks');
    const body = pullRequestBody(info, 'opened', 'northwind/hooks');
    const accepted = await repositoryDelivery(webhookId, body, github(body, secret));
    expect(accepted.status).toBe(202);
    expect(await accepted.text()).toBe('');
    expect(core.jobs.sent).toEqual([
      expect.objectContaining({
        name: REPOSITORY_EVENT,
        data: expect.objectContaining({
          linkId: expect.any(String),
          action: 'opened',
          request: expect.objectContaining({ number: 7, state: 'open', headBranch: 'task/7' }),
        }),
      }),
    ]);
    expect(await lastStatus()).toMatchObject({ lastStatus: 'ok' });

    core.jobs.clear();
    const ping = JSON.stringify({ zen: 'Keep it logically awesome.' });
    expect((await repositoryDelivery(webhookId, ping, github(ping, secret, 'ping'))).status).toBe(200);
    expect(core.jobs.sent).toEqual([]);
  });

  it('413 for a body over the limit, before core sees it', async () => {
    const response = await handleRepositoryWebhook(
      core,
      post(`/api/webhooks/repository/${webhookId}`, 'x'.repeat(100), {}),
      webhookId,
      { maxBodyBytes: 10 },
    );
    expect(response.status).toBe(413);
  });

  it('410 once the project has no repository', async () => {
    const cleared = await call('PATCH', `/api/v1/projects/${project}`, {
      auth: owner(),
      body: { repository: null },
    });
    expect(cleared.status, JSON.stringify(cleared.body)).toBe(200);
    const body = pullRequestBody(request(7, {}, 'northwind/hooks'), 'opened', 'northwind/hooks');
    expect((await repositoryDelivery(webhookId, body, github(body, secret))).status).toBe(410);
  });
});

describe('POST /api/webhooks/backlog/{webhookId} with request events', () => {
  it('queues a request event on the Backlog.md webhook for the mirrored project', async () => {
    core.jobs.clear();
    const info = request(31, {}, 'northwind/ledger');
    const body = pullRequestBody(info, 'opened', 'northwind/ledger');
    const response = await handleBacklogWebhook(
      core,
      post(`/api/webhooks/backlog/${backWebhookId}`, body, github(body, BACKLOG_SECRET)),
      backWebhookId,
    );
    expect(response.status).toBe(202);
    expect(core.jobs.sent).toEqual([
      expect.objectContaining({
        name: REPOSITORY_EVENT,
        data: expect.objectContaining({ request: expect.objectContaining({ number: 31 }) }),
      }),
    ]);
    const settings = await call('GET', `/api/v1/projects/${back}/repository`, { auth: member() });
    expect(settings.body.webhook).toMatchObject({ lastStatus: 'ok', lastAt: expect.any(String) });

    core.jobs.clear();
    const bad = await handleBacklogWebhook(
      core,
      post(`/api/webhooks/backlog/${backWebhookId}`, body, github(body, 'nope')),
      backWebhookId,
    );
    expect(bad.status).toBe(404);
    expect(core.jobs.sent).toEqual([]);
  });
});

describe('M7: the OpenAPI document', () => {
  it('lists the new routes with their success statuses and the new problem codes', async () => {
    const { body } = await call('GET', '/api/v1/openapi.json');
    const responses = (path: string, method: string) => Object.keys(body.paths[path][method].responses);
    expect(responses('/api/v1/projects/{project}/repository/sync', 'post')).toContain('202');
    expect(responses('/api/v1/tasks/{key}/pull-requests/{number}', 'delete')).toContain('204');
    expect(responses('/api/v1/tasks/{key}/pull-requests', 'post')).toContain('200');
    expect(responses('/api/v1/tasks/archive', 'post')).toContain('200');
    expect(responses('/api/v1/projects/{project}/archive-preview', 'get')).toContain('200');
    expect(Object.keys(body.paths['/api/v1/projects/{project}/repository']).sort()).toEqual(['get', 'patch']);
    const codes: string[] = body.components.schemas.Problem.properties.code.enum;
    expect(codes).toEqual(
      expect.arrayContaining([
        'TASK_ARCHIVED',
        'REQUEST_OTHER_REPOSITORY',
        'NOT_A_REQUEST',
        'REQUEST_NOT_FOUND',
      ]),
    );
    expect(Object.keys(body.components.schemas.Problem.properties)).toContain('repository');
  });
});
