// M3 through /api/v1 and the webhook route, against a throwaway database seeded with the mirrored
// demo project BACK (seedDevData with `backlog`). Jobs go to a recording queue; the worker's side
// is tested in apps/worker.
import { createHmac } from 'node:crypto';
import { createAuth } from '@zamu/auth';
import {
  type Actor,
  type CoreContext,
  createApiKey,
  createCycle,
  detachBacklog,
  getBacklogWebhookInfo,
  listProjects,
  updateProject,
} from '@zamu/core';
import { type RecordingJobQueue, recordingJobQueue, TEST_ENCRYPTION_KEY } from '@zamu/core/backlog/testing';
import { createTestDatabase, type TestDatabase } from '@zamu/db/test';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { seedDevData } from '../seed';
import { BACKLOG_SEED } from '../seed-backlog';
import { handleBacklogWebhook } from '../webhooks';
import { createApiFetchHandler } from './index';

const ORIGIN = 'http://localhost:3000';
const SECRET = 'test-secret-test-secret-test-secret-0123';

let database: TestDatabase;
let core: CoreContext & { jobs: RecordingJobQueue };
let handle: (request: Request) => Promise<Response>;
let admin: Actor;
const keys = {} as { agent: string; adminRead: string; agentPayOnly: string };

async function call(method: string, path: string, options: { key?: string; body?: unknown } = {}) {
  const headers: Record<string, string> = {};
  if (options.key) headers.authorization = `Bearer ${options.key}`;
  const init: RequestInit = { method, headers };
  if (options.body !== undefined) {
    headers['content-type'] = 'application/json';
    init.body = JSON.stringify(options.body);
  }
  const response = await handle(new Request(`${ORIGIN}${path}`, init));
  const text = await response.text();
  // biome-ignore lint/suspicious/noExplicitAny: response bodies are checked field by field
  const body: any = text ? JSON.parse(text) : null;
  return { status: response.status, body };
}

const agent = () => ({ key: keys.agent });

beforeAll(async () => {
  database = await createTestDatabase({ prefix: 'pm_web_backlog' });
  database.pool.on('error', () => {});
  const auth = createAuth({ db: database.db, secret: SECRET, baseUrl: ORIGIN });
  core = {
    db: database.db,
    auth,
    publicUrl: ORIGIN,
    encryptionKey: TEST_ENCRYPTION_KEY,
    jobs: recordingJobQueue(),
  };
  handle = createApiFetchHandler(core);

  const seeded = await seedDevData(core, { backlog: true });
  expect(seeded.createdProjects.map((p) => p.key)).toEqual(['PAY', 'WEB', 'BACK']);
  keys.agent = seeded.agentKey;
  admin = {
    userId: seeded.admin.id,
    kind: 'person',
    workspaceId: seeded.workspaceId,
    role: 'owner',
    onBehalfOfId: null,
  };
  const pay = (await listProjects(core, admin)).items.find((p) => p.key === 'PAY');
  if (!pay) throw new Error('PAY not seeded');
  keys.adminRead = (
    await createApiKey(core, admin, { name: 'read only', scope: { projects: 'all', access: 'read' } })
  ).key;
  keys.agentPayOnly = (
    await createApiKey(core, admin, {
      name: 'PAY only',
      ownerId: seeded.agent.id,
      scope: { projects: [pay.id], access: 'write' },
    })
  ).key;
}, 60_000);

afterAll(async () => {
  await database?.drop();
});

beforeEach(() => {
  core.jobs.clear();
});

describe('the dev seed with backlog', () => {
  it('mirrors BACK through the engine: tasks, subtasks, a draft, a hidden task, warnings, history', async () => {
    const { status, body } = await call('GET', '/api/v1/projects/BACK/backlog', agent());
    expect(status).toBe(200);
    expect(body).toMatchObject({
      project: { key: 'BACK', name: 'Payments API' },
      mode: 'mirror',
      state: 'warnings',
      repository: `https://${BACKLOG_SEED.host}/${BACKLOG_SEED.repositoryPath}`,
      defaultBranch: 'main',
      folder: 'backlog',
      prefix: 'BACK',
      connection: { name: BACKLOG_SEED.connectionName, provider: 'gitlab' },
      lastTrigger: 'webhook',
      counts: { drafts: 1, archived: 1, hidden: 1, milestones: 2 },
    });
    expect(body.counts.subtasks).toBe(2);
    expect(body.lastRead.commit).toMatch(/^[0-9a-f]{40}$/);
    expect(body.nextPollAt).toEqual(expect.any(String));
    // The broken file and the unmapped status.
    const problems = JSON.stringify(body.problems.items);
    expect(problems).toContain('back-790');
    expect(problems).toContain('Blocked');
    expect(body.history.map((entry: { type: string }) => entry.type)).toEqual(['project.backlog_imported']);
    // Settings-only fields stay out of the API body.
    expect(JSON.stringify(body)).not.toContain(BACKLOG_SEED.token);
  });

  it('pages problems', async () => {
    const first = await call('GET', '/api/v1/projects/BACK/backlog?problemsLimit=1', agent());
    expect(first.status).toBe(200);
    expect(first.body.problems.items).toHaveLength(1);
    expect(first.body.problems.nextCursor).toEqual(expect.any(String));
    const cursor = encodeURIComponent(first.body.problems.nextCursor);
    const second = await call(
      'GET',
      `/api/v1/projects/BACK/backlog?problemsLimit=1&problemsCursor=${cursor}`,
      agent(),
    );
    expect(second.status).toBe(200);
    expect(second.body.problems.items).toHaveLength(1);
    expect(second.body.problems.items[0]).not.toEqual(first.body.problems.items[0]);
  });

  it('adds the backlog summary to project shapes', async () => {
    const { body } = await call('GET', '/api/v1/projects', agent());
    const back = body.items.find((p: { key: string }) => p.key === 'BACK');
    const pay = body.items.find((p: { key: string }) => p.key === 'PAY');
    expect(back.backlog).toMatchObject({ mode: 'mirror', state: 'warnings', hidden: 1 });
    expect(back.backlog.lastReadCommit).toMatch(/^[0-9a-f]{40}$/);
    expect(pay.backlog).toBeNull();
  });
});

describe('GET /projects/{project}/backlog', () => {
  it('returns 404 for a project without a source and 401 without credentials', async () => {
    expect((await call('GET', '/api/v1/projects/PAY/backlog', agent())).body).toMatchObject({
      status: 404,
      code: 'NOT_FOUND',
    });
    expect((await call('GET', '/api/v1/projects/BACK/backlog')).status).toBe(401);
  });

  it('is readable with a read-only key; a key scoped to other projects gets 403', async () => {
    expect((await call('GET', '/api/v1/projects/BACK/backlog', { key: keys.adminRead })).status).toBe(200);
    expect((await call('GET', '/api/v1/projects/BACK/backlog', { key: keys.agentPayOnly })).status).toBe(403);
  });

  it('validates the page size', async () => {
    const { status, body } = await call('GET', '/api/v1/projects/BACK/backlog?problemsLimit=0', agent());
    expect(status).toBe(400);
    expect(body.code).toBe('BAD_REQUEST');
  });
});

describe('POST /projects/{project}/backlog/refresh', () => {
  it('queues a refresh with trigger cli and returns 202 with the state', async () => {
    const { status, body } = await call('POST', '/api/v1/projects/BACK/backlog/refresh', agent());
    expect(status).toBe(202);
    expect(body).toMatchObject({ project: 'BACK', state: 'warnings', queued: true });
    expect(core.jobs.sent).toEqual([
      expect.objectContaining({ name: 'backlog.refresh', data: expect.objectContaining({ trigger: 'cli' }) }),
    ]);
  });

  it('refuses read-only keys (403) and projects without a source (404)', async () => {
    const readOnly = await call('POST', '/api/v1/projects/BACK/backlog/refresh', { key: keys.adminRead });
    expect(readOnly.status).toBe(403);
    expect((await call('POST', '/api/v1/projects/PAY/backlog/refresh', agent())).status).toBe(404);
    expect(core.jobs.sent).toEqual([]);
  });
});

describe('mirrored tasks through /api/v1', () => {
  it('GET /tasks/{key} accepts suffixed keys and returns the Backlog.md block, locks and hidden', async () => {
    const { status, body } = await call('GET', '/api/v1/tasks/BACK-786.1', agent());
    expect(status).toBe(200);
    expect(body).toMatchObject({
      key: 'BACK-786.1',
      title: 'Parse the folder',
      status: 'done',
      hidden: false,
      backlog: { id: 'BACK-786.1', file: expect.stringMatching(/^backlog\/tasks\/back-786\.1 - /) },
    });
    expect(body.locked).toEqual(expect.arrayContaining(['title', 'status', 'priority']));
    const lower = await call('GET', '/api/v1/tasks/back-786.1.2', agent());
    expect(lower.body.key).toBe('BACK-786.1.2');
    const parent = await call('GET', '/api/v1/tasks/BACK-786', agent());
    expect(parent.body.backlog.data).toMatchObject({ labels: ['sync'] });
    expect(JSON.stringify(parent.body.backlog.data)).toContain('BACK-999');
  });

  it('the draft takes the number after the highest task', async () => {
    const { body } = await call('GET', '/api/v1/tasks/BACK-787', agent());
    expect(body).toMatchObject({ title: 'Spike: two-way sync', status: 'backlog' });
  });

  it('GET /tasks leaves hidden tasks out unless hidden=only or include', async () => {
    const all = await call('GET', '/api/v1/tasks?project=BACK&limit=100', agent());
    const keysOf = (items: { key: string }[]) => items.map((item) => item.key);
    expect(keysOf(all.body.items)).not.toContain('BACK-12');
    expect(keysOf(all.body.items)).toContain('BACK-786.1.2');
    const only = await call('GET', '/api/v1/tasks?project=BACK&hidden=only', agent());
    expect(keysOf(only.body.items)).toEqual(['BACK-12']);
    expect(only.body.items[0].hidden).toBe(true);
    const include = await call('GET', '/api/v1/tasks?project=BACK&hidden=include&limit=100', agent());
    expect(include.body.items).toHaveLength(all.body.items.length + 1);
    expect((await call('GET', '/api/v1/tasks/BACK-12', agent())).body).toMatchObject({ hidden: true });
  });

  it('PATCH an owned field: 409 TASK_MIRRORED with field, file, backlogId and hint', async () => {
    const { status, body } = await call('PATCH', '/api/v1/tasks/BACK-786', {
      ...agent(),
      body: { status: 'done' },
    });
    expect(status).toBe(409);
    expect(body).toMatchObject({
      type: 'about:blank',
      status: 409,
      code: 'TASK_MIRRORED',
      title: 'Field comes from Backlog.md',
      field: 'status',
      backlogId: 'BACK-786',
      file: expect.stringMatching(/^backlog\/tasks\/back-786 - /),
      hint: expect.stringContaining('backlog task edit 786'),
    });
    expect(body.detail).toEqual(expect.any(String));
    expect(body.requestId).toEqual(expect.any(String));
    const unchanged = await call('GET', '/api/v1/tasks/BACK-786', agent());
    expect(unchanged.body.status).toBe('in_progress');
  });

  it('cycles, rank within the column and comments still work', async () => {
    await updateProject(core, admin, { project: 'BACK', usesCycles: true });
    await createCycle(core, admin, { project: 'BACK' });
    const cycle = await call('PATCH', '/api/v1/tasks/BACK-781', { ...agent(), body: { cycle: 'next' } });
    expect(cycle.status, JSON.stringify(cycle.body)).toBe(200);
    expect(cycle.body.cycle).toMatchObject({ number: 1 });
    const moved = await call('PATCH', '/api/v1/tasks/BACK-782', {
      ...agent(),
      body: { position: { before: 'BACK-786.1.2' } },
    });
    expect(moved.status, JSON.stringify(moved.body)).toBe(200);
    const comment = await call('POST', '/api/v1/tasks/BACK-786/comments', {
      ...agent(),
      body: { body: 'Picked this up from the app.' },
    });
    expect(comment.status).toBe(201);
  });

  it('POST /tasks in a mirrored project: 409 PROJECT_MIRRORED with a hint', async () => {
    const { status, body } = await call('POST', '/api/v1/tasks', {
      ...agent(),
      body: { project: 'BACK', title: 'From the API' },
    });
    expect(status).toBe(409);
    expect(body).toMatchObject({
      code: 'PROJECT_MIRRORED',
      hint: expect.stringContaining('backlog task create'),
    });
  });

  it('milestone writes: 409 MILESTONE_MIRRORED', async () => {
    const { status, body } = await call('POST', '/api/v1/projects/BACK/milestones', {
      ...agent(),
      body: { name: 'From the API' },
    });
    expect(status).toBe(409);
    expect(body.code).toBe('MILESTONE_MIRRORED');
  });

  it('timeline entries carry origin and originRef; Backlog.md entries have no actor', async () => {
    const { body } = await call('GET', '/api/v1/tasks/BACK-781/timeline', agent());
    const fromBacklog = body.items.filter(
      (item: { kind: string; origin?: string }) => item.kind === 'activity' && item.origin === 'backlog',
    );
    expect(fromBacklog.length).toBeGreaterThan(0);
    expect(fromBacklog[0]).toMatchObject({ actor: null, originRef: expect.stringMatching(/^[0-9a-f]{40}$/) });
  });
});

describe('OpenAPI document (M3)', () => {
  it('lists the backlog routes and the new problem codes', async () => {
    const { body } = await call('GET', '/api/v1/openapi.json');
    expect(body.paths['/api/v1/projects/{project}/backlog'].get.tags).toEqual(['backlog']);
    expect(Object.keys(body.paths['/api/v1/projects/{project}/backlog/refresh'].post.responses)).toContain(
      '202',
    );
    const codes: string[] = body.components.schemas.Problem.properties.code.enum;
    expect(codes).toEqual(
      expect.arrayContaining([
        'TASK_MIRRORED',
        'MILESTONE_MIRRORED',
        'PROJECT_MIRRORED',
        'PROJECT_NOT_EMPTY',
        'BACKLOG_PAUSED',
        'BACKLOG_DETACHED',
      ]),
    );
    expect(Object.keys(body.components.schemas.Problem.properties)).toEqual(
      expect.arrayContaining(['field', 'file', 'backlogId', 'hint']),
    );
  });
});

// ---------------------------------------------------------------------------
// Webhook route
// ---------------------------------------------------------------------------

const hmac = (secret: string, body: string) => createHmac('sha256', secret).update(body).digest('hex');

function delivery(webhookId: string, body: string, headers: Record<string, string>) {
  return handleBacklogWebhook(
    core,
    new Request(`${ORIGIN}/api/webhooks/backlog/${webhookId}`, {
      method: 'POST',
      headers: { 'content-type': 'application/json', ...headers },
      body,
    }),
    webhookId,
  );
}

/** Test-only: switches the provider of BACK's connection, so one source covers every signature scheme. */
async function setProvider(provider: 'github' | 'gitlab' | 'gitea') {
  const result = await database.pool.query(
    `UPDATE git_connection SET provider = $1
       WHERE id = (SELECT s.connection_id FROM backlog_source s JOIN project p ON p.id = s.project_id
                    WHERE p.key = 'BACK')`,
    [provider],
  );
  if (result.rowCount !== 1) throw new Error('BACK has no connection');
}

describe('POST /api/webhooks/backlog/{webhookId}', () => {
  let webhookId: string;
  let secret: string;
  const push = (branch: string) =>
    JSON.stringify({ ref: `refs/heads/${branch}`, after: 'a'.repeat(40), object_kind: 'push' });

  beforeAll(async () => {
    const info = await getBacklogWebhookInfo(core, admin, { projectKey: 'BACK' });
    if (!info.secret) throw new Error('no webhook secret');
    secret = info.secret;
    webhookId = new URL(info.url).pathname.split('/').at(-1) as string;
    expect(info.url).toBe(`${ORIGIN}/api/webhooks/backlog/${webhookId}`);
  });

  afterAll(async () => {
    await setProvider('gitlab');
  });

  it('404 with no body for an unknown id and for a bad signature', async () => {
    const unknown = await delivery('nope', push('main'), {
      'x-gitlab-token': 'x',
      'x-gitlab-event': 'Push Hook',
    });
    expect(unknown.status).toBe(404);
    expect(await unknown.text()).toBe('');
    const bad = await delivery(webhookId, push('main'), {
      'x-gitlab-token': 'wrong',
      'x-gitlab-event': 'Push Hook',
    });
    expect(bad.status).toBe(404);
    expect(await bad.text()).toBe('');
    expect(core.jobs.sent).toEqual([]);
  });

  it('GitLab: 202 and a refresh for a push to the default branch, 204 for another branch', async () => {
    await setProvider('gitlab');
    const headers = { 'x-gitlab-token': secret, 'x-gitlab-event': 'Push Hook' };
    const accepted = await delivery(webhookId, push('main'), headers);
    expect(accepted.status).toBe(202);
    expect(core.jobs.sent).toEqual([
      expect.objectContaining({
        name: 'backlog.refresh',
        data: expect.objectContaining({ trigger: 'webhook' }),
      }),
    ]);
    core.jobs.clear();
    expect((await delivery(webhookId, push('feature/x'), headers)).status).toBe(204);
    expect(core.jobs.sent).toEqual([]);
    const status = await call('GET', '/api/v1/projects/BACK/backlog', agent());
    expect(status.body.webhookLastAt).toEqual(expect.any(String));
  });

  it('GitHub: X-Hub-Signature-256 over the raw body', async () => {
    await setProvider('github');
    const body = push('main');
    const signed = { 'x-github-event': 'push', 'x-hub-signature-256': `sha256=${hmac(secret, body)}` };
    expect((await delivery(webhookId, body, signed)).status).toBe(202);
    // The same signature over other bytes fails: the route hands core the exact body it received.
    expect((await delivery(webhookId, `${body} `, signed)).status).toBe(404);
    const ping = JSON.stringify({ zen: 'Keep it logically awesome.' });
    expect(
      (
        await delivery(webhookId, ping, {
          'x-github-event': 'ping',
          'x-hub-signature-256': `sha256=${hmac(secret, ping)}`,
        })
      ).status,
    ).toBe(204);
  });

  it('Gitea/Forgejo: X-Gitea-Signature or X-Forgejo-Signature', async () => {
    await setProvider('gitea');
    const body = push('main');
    expect(
      (await delivery(webhookId, body, { 'x-gitea-event': 'push', 'x-gitea-signature': hmac(secret, body) }))
        .status,
    ).toBe(202);
    expect(
      (
        await delivery(webhookId, body, {
          'x-forgejo-event': 'push',
          'x-forgejo-signature': hmac(secret, body),
        })
      ).status,
    ).toBe(202);
    expect(
      (await delivery(webhookId, body, { 'x-gitea-event': 'push', 'x-gitea-signature': hmac('nope', body) }))
        .status,
    ).toBe(404);
  });

  it('413 for a body over the limit, before core sees it', async () => {
    const response = await handleBacklogWebhook(
      core,
      new Request(`${ORIGIN}/api/webhooks/backlog/${webhookId}`, { method: 'POST', body: 'x'.repeat(100) }),
      webhookId,
      { maxBodyBytes: 10 },
    );
    expect(response.status).toBe(413);
  });

  it('410 once the source is detached; the API then refuses refreshes with BACKLOG_DETACHED', async () => {
    await setProvider('gitlab');
    await detachBacklog(core, admin, { projectKey: 'BACK', confirmKey: 'back' });
    const gone = await delivery(webhookId, push('main'), {
      'x-gitlab-token': secret,
      'x-gitlab-event': 'Push Hook',
    });
    expect(gone.status).toBe(410);
    const refresh = await call('POST', '/api/v1/projects/BACK/backlog/refresh', agent());
    expect(refresh.status).toBe(409);
    expect(refresh.body.code).toBe('BACKLOG_DETACHED');
    // Detached projects are fully editable.
    // In progress, not Done: the task has an open criterion, and an agent can't finish it with one.
    const patched = await call('PATCH', '/api/v1/tasks/BACK-786', {
      ...agent(),
      body: { status: 'in_progress' },
    });
    expect(patched.status, JSON.stringify(patched.body)).toBe(200);
  });
});
