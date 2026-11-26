// /api/v1 through the HTTP handler against a throwaway database, with a session cookie and with API
// keys of different scopes. Data comes from the dev seed (PAY with 11 tasks, WEB with 4).
import { createORPCClient } from '@orpc/client';
import { RPCLink } from '@orpc/client/fetch';
import { createAuth } from '@zamu/auth';
import {
  type Actor,
  type CoreContext,
  createApiKey,
  createProject,
  createTask,
  listProjects,
  revokeApiKey,
} from '@zamu/core';
import { createLabelRow, createWorld, projectRow, scopeOf } from '@zamu/core/testing/fixtures';
import { createTestDatabase, type TestDatabase } from '@zamu/db/test';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { seedDevData } from '../seed';
import { type ApiClient, createApiClient, createApiFetchHandler, RPC_PREFIX } from './index';

const ORIGIN = 'http://localhost:3000';
const SECRET = 'test-secret-test-secret-test-secret-0123';

let database: TestDatabase;
let core: CoreContext;
let handle: (request: Request) => Promise<Response>;
let cookie: string;
let admin: Actor;
const keys = {} as {
  agent: string;
  admin: string;
  adminRead: string;
  agentPayOnly: string;
  revoked: string;
};
let otherWorkspaceTask: string;
let agentId: string;
let adminEmail: string;

type Auth = { cookie: string } | { key: string } | null;

interface CallOptions {
  auth?: Auth;
  body?: unknown;
  headers?: Record<string, string>;
}

async function call(method: string, path: string, { auth = null, body, headers = {} }: CallOptions = {}) {
  const init: RequestInit = { method, headers: { ...headers } };
  const h = init.headers as Record<string, string>;
  if (auth && 'cookie' in auth) h.cookie = auth.cookie;
  if (auth && 'key' in auth) h.authorization = `Bearer ${auth.key}`;
  if (body !== undefined) {
    h['content-type'] = 'application/json';
    init.body = JSON.stringify(body);
  }
  const response = await handle(new Request(`${ORIGIN}${path}`, init));
  const text = await response.text();
  // biome-ignore lint/suspicious/noExplicitAny: response bodies are checked field by field
  const json: any = text ? JSON.parse(text) : null;
  return { status: response.status, headers: response.headers, body: json };
}

const session = (): Auth => ({ cookie });
const key = (name: keyof typeof keys): Auth => ({ key: keys[name] });

function expectProblem(result: Awaited<ReturnType<typeof call>>, status: number, code: string): void {
  expect(result.status, JSON.stringify(result.body)).toBe(status);
  expect(result.body).toMatchObject({ status, code, type: 'about:blank' });
  expect(result.body.title).toEqual(expect.any(String));
  expect(result.body.requestId).toBe(result.headers.get('x-request-id'));
}

beforeAll(async () => {
  database = await createTestDatabase({ prefix: 'pm_web_api' });
  database.pool.on('error', () => {});
  const auth = createAuth({ db: database.db, secret: SECRET, baseUrl: ORIGIN });
  core = { db: database.db, auth, publicUrl: ORIGIN };
  handle = createApiFetchHandler(core);

  const seeded = await seedDevData(core);
  keys.agent = seeded.agentKey;
  keys.admin = seeded.adminKey;
  agentId = seeded.agent.id;
  adminEmail = seeded.admin.email;

  const signIn = await auth.api.signInEmail({
    body: { email: seeded.admin.email, password: seeded.admin.password as string },
    returnHeaders: true,
  });
  cookie = signIn.headers
    .getSetCookie()
    .map((c) => c.split(';')[0])
    .join('; ');

  admin = {
    userId: seeded.admin.id,
    kind: 'person',
    workspaceId: seeded.workspaceId,
    role: 'owner',
    onBehalfOfId: null,
  };
  const projects = await listProjects(core, admin);
  const pay = projects.items.find((p) => p.key === 'PAY');
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
  const revoked = await createApiKey(core, admin, {
    name: 'revoked',
    scope: { projects: 'all', access: 'write' },
  });
  await revokeApiKey(core, admin, { id: revoked.id });
  keys.revoked = revoked.key;

  // A second workspace on the same instance; its tasks must look like they do not exist.
  const world = await createWorld(database.db, 'Elsewhere');
  await createProject(core, world.ownerActor, { key: 'ELSE', name: 'Their project' });
  otherWorkspaceTask = (await createTask(core, world.ownerActor, { project: 'ELSE', title: 'Theirs' })).key;
}, 60_000);

afterAll(async () => {
  await database?.drop();
});

describe('OpenAPI document', () => {
  it('is served without auth and lists every contract path', async () => {
    const result = await call('GET', '/api/v1/openapi.json');
    const problemRef = { $ref: '#/components/schemas/Problem' };
    expect(result.status).toBe(200);
    expect(result.body.openapi).toMatch(/^3\.1/);
    expect(Object.keys(result.body.paths).sort()).toEqual([
      '/api/v1/comments/{id}',
      '/api/v1/cycles/{project}/{number}',
      '/api/v1/cycles/{project}/{number}/end',
      '/api/v1/dashboard',
      '/api/v1/dashboard/counts',
      '/api/v1/home',
      '/api/v1/home/counts',
      '/api/v1/me',
      '/api/v1/members',
      '/api/v1/milestones/{id}',
      '/api/v1/projects',
      '/api/v1/projects/{project}',
      '/api/v1/projects/{project}/archive-preview',
      '/api/v1/projects/{project}/backlog',
      '/api/v1/projects/{project}/backlog/export',
      '/api/v1/projects/{project}/backlog/refresh',
      '/api/v1/projects/{project}/cycles',
      '/api/v1/projects/{project}/labels',
      '/api/v1/projects/{project}/labels/{id}',
      '/api/v1/projects/{project}/milestones',
      '/api/v1/projects/{project}/repository',
      '/api/v1/projects/{project}/repository/sync',
      '/api/v1/projects/{project}/repository/webhook-secret',
      '/api/v1/tasks',
      '/api/v1/tasks/archive',
      '/api/v1/tasks/bulk',
      '/api/v1/tasks/restore',
      '/api/v1/tasks/{key}',
      '/api/v1/tasks/{key}/activity',
      '/api/v1/tasks/{key}/comments',
      '/api/v1/tasks/{key}/pull-requests',
      '/api/v1/tasks/{key}/pull-requests/{number}',
      '/api/v1/tasks/{key}/timeline',
    ]);
    // Every operation has an id, a summary and a tag; ids are unique.
    const operations = Object.values(result.body.paths).flatMap((item) => Object.values(item as object));
    expect(operations).toHaveLength(48);
    const ids = operations.map((op: { operationId: string }) => op.operationId);
    expect(new Set(ids).size).toBe(ids.length);
    for (const op of operations) {
      expect(op.summary, op.operationId).toEqual(expect.any(String));
      expect(op.tags, op.operationId).toHaveLength(1);
    }
    // Assignee, milestone and cycle take one value or several, like status and priority (M5).
    const listParameters = result.body.paths['/api/v1/tasks'].get.parameters as {
      name: string;
      schema: unknown;
    }[];
    for (const name of ['status', 'assignee', 'milestone', 'cycle', 'label']) {
      const parameter = listParameters.find((p) => p.name === name);
      expect(JSON.stringify(parameter?.schema), name).toContain('"type":"array"');
    }
    expect(JSON.stringify(listParameters.find((p) => p.name === 'assignee')?.schema)).toContain('"none"');
    expect(result.body.paths['/api/v1/me'].patch).toBeDefined();
    // The dashboard scope is a query parameter; the counts take no input.
    const dashboard = result.body.paths['/api/v1/dashboard'].get;
    expect(dashboard.tags).toEqual(['dashboard']);
    expect(dashboard.parameters).toEqual([
      expect.objectContaining({
        name: 'scope',
        in: 'query',
        schema: expect.objectContaining({ enum: ['mine', 'everyone'], default: 'mine' }),
      }),
    ]);
    expect(dashboard.parameters[0].required).toBeFalsy();
    expect(result.body.paths['/api/v1/dashboard/counts'].get.parameters ?? []).toEqual([]);
    expect(Object.keys(result.body.paths['/api/v1/milestones/{id}'].delete.responses)).toContain('204');
    expect(Object.keys(result.body.paths['/api/v1/tasks/{key}/comments'].post.responses)).toContain('201');
    // TASK_CHANGED shares the 409 response (and its Problem body) with CONFLICT.
    expect(
      result.body.paths['/api/v1/tasks/{key}'].patch.responses['409'].content['application/json'].schema,
    ).toEqual(problemRef);
    // Shared components keep the document small: Task is not inlined in every error response.
    expect(JSON.stringify(result.body).length).toBeLessThan(250_000);
    expect(result.body.components.securitySchemes.apiKey).toMatchObject({ type: 'http', scheme: 'bearer' });
    // Error responses use the shared Problem body.
    const getTask = result.body.paths['/api/v1/tasks/{key}'].get;
    expect(getTask.responses['404'].content['application/json'].schema).toEqual(problemRef);
    const problem = result.body.components.schemas.Problem;
    expect(Object.keys(problem.properties)).toEqual(
      expect.arrayContaining(['code', 'requestId', 'issues', 'task']),
    );
    expect(problem.properties.code.enum).toContain('TASK_CHANGED');
    expect(problem.properties.task).toEqual({ $ref: '#/components/schemas/Task' });
  });
});

describe('authentication', () => {
  it('returns 401 without credentials', async () => {
    const result = await call('GET', '/api/v1/projects');
    expectProblem(result, 401, 'UNAUTHORIZED');
    expect(result.headers.get('www-authenticate')).toMatch(/^Bearer/);
  });

  it('returns 401 before validating input', async () => {
    expectProblem(await call('POST', '/api/v1/tasks', { body: {} }), 401, 'UNAUTHORIZED');
  });

  it('returns 401 for unknown and revoked keys', async () => {
    expectProblem(await call('GET', '/api/v1/me', { auth: { key: 'zamu_live_nope' } }), 401, 'UNAUTHORIZED');
    expectProblem(await call('GET', '/api/v1/me', { auth: key('revoked') }), 401, 'UNAUTHORIZED');
  });

  it('echoes a caller request id', async () => {
    const result = await call('GET', '/api/v1/me', { headers: { 'x-request-id': 'trace-123' } });
    expect(result.headers.get('x-request-id')).toBe('trace-123');
    expect(result.body.requestId).toBe('trace-123');
  });

  it('returns a Problem for unknown routes', async () => {
    expectProblem(await call('GET', '/api/v1/nope', { auth: session() }), 404, 'NOT_FOUND');
  });

  it('refuses cross-site cookie writes but allows same-origin ones', async () => {
    const body = { project: 'PAY', title: 'From another site' };
    expectProblem(
      await call('POST', '/api/v1/tasks', {
        auth: session(),
        body,
        headers: { origin: 'https://evil.example' },
      }),
      403,
      'FORBIDDEN',
    );
    const same = await call('POST', '/api/v1/tasks', {
      auth: session(),
      body: { project: 'PAY', title: 'From the app' },
      headers: { origin: ORIGIN },
    });
    expect(same.status).toBe(201);
    // API keys carry no ambient credentials, so Origin does not matter.
    const withKey = await call('POST', '/api/v1/tasks', {
      auth: key('agent'),
      body: { project: 'PAY', title: 'From a script' },
      headers: { origin: 'https://evil.example' },
    });
    expect(withKey.status).toBe(201);
  });
});

describe('with a session', () => {
  it('GET /me', async () => {
    const result = await call('GET', '/api/v1/me', { auth: session() });
    expect(result.status).toBe(200);
    expect(result.body).toMatchObject({
      user: { name: 'Ana Ruiz', kind: 'person' },
      workspace: { name: 'Reddevs' },
      role: 'owner',
      auth: { method: 'session', scope: null },
    });
  });

  it('GET /projects', async () => {
    const result = await call('GET', '/api/v1/projects', { auth: session() });
    expect(result.status).toBe(200);
    const keysOf = result.body.items.map((p: { key: string }) => p.key);
    expect(keysOf).toEqual(expect.arrayContaining(['PAY', 'WEB']));
    const pay = result.body.items.find((p: { key: string }) => p.key === 'PAY');
    expect(pay.openCounts).toMatchObject({ in_progress: expect.any(Number), todo: expect.any(Number) });
  });

  it('POST /projects, then 409 for a duplicate key and 400 for a bad one', async () => {
    const created = await call('POST', '/api/v1/projects', {
      auth: session(),
      body: { name: 'Docs', key: 'docs', description: 'Guides' },
    });
    expect(created.status).toBe(201);
    expect(created.body).toMatchObject({ key: 'DOCS', name: 'Docs' });
    expectProblem(
      await call('POST', '/api/v1/projects', { auth: session(), body: { name: 'Again', key: 'DOCS' } }),
      409,
      'CONFLICT',
    );
    const bad = await call('POST', '/api/v1/projects', { auth: session(), body: { name: '', key: '1' } });
    expectProblem(bad, 400, 'BAD_REQUEST');
    expect(bad.body.issues.map((i: { path: string }) => i.path)).toEqual(
      expect.arrayContaining(['name', 'key']),
    );
  });

  it('PATCH /projects/{project}: renames, changes an empty key, refuses a key change with tasks', async () => {
    await call('POST', '/api/v1/projects', { auth: session(), body: { name: 'Tmp', key: 'TMP' } });
    const renamed = await call('PATCH', '/api/v1/projects/tmp', {
      auth: session(),
      body: { key: 'TMQ', name: 'Temporary' },
    });
    expect(renamed.status).toBe(200);
    expect(renamed.body).toMatchObject({ key: 'TMQ', name: 'Temporary' });
    expectProblem(
      await call('PATCH', '/api/v1/projects/PAY', { auth: session(), body: { key: 'PAYS' } }),
      409,
      'CONFLICT',
    );
    expectProblem(
      await call('PATCH', '/api/v1/projects/NOPE', { auth: session(), body: { name: 'x' } }),
      404,
      'NOT_FOUND',
    );
    expectProblem(
      await call('PATCH', '/api/v1/projects/PAY', { auth: session(), body: {} }),
      400,
      'BAD_REQUEST',
    );
  });

  it('GET /tasks with filters and pagination', async () => {
    const all = await call('GET', '/api/v1/tasks?project=pay', { auth: session() });
    expect(all.status).toBe(200);
    expect(all.body.items.length).toBeGreaterThanOrEqual(11);
    expect(all.body.counts).toMatchObject({ backlog: 1, done: 1 });

    const one = await call('GET', '/api/v1/tasks?project=PAY&status=in_review', { auth: session() });
    expect(one.status).toBe(200);
    expect(one.body.items.length).toBeGreaterThan(0);
    expect(one.body.items.every((t: { status: string }) => t.status === 'in_review')).toBe(true);

    const many = await call('GET', '/api/v1/tasks?project=PAY&status[]=in_review&status[]=backlog', {
      auth: session(),
    });
    expect(many.status, JSON.stringify(many.body)).toBe(200);
    expect(new Set(many.body.items.map((t: { status: string }) => t.status))).toEqual(
      new Set(['in_review', 'backlog']),
    );
    // A repeated plain key also arrives as a list.
    const repeated = await call('GET', '/api/v1/tasks?project=PAY&status=in_review&status=backlog', {
      auth: session(),
    });
    expect(repeated.status, JSON.stringify(repeated.body)).toBe(200);
    expect(repeated.body.items).toHaveLength(many.body.items.length);

    const agents = await call('GET', '/api/v1/tasks?project=PAY&assignee=agents', { auth: session() });
    expect(agents.body.items.every((t: { assignee: { kind: string } }) => t.assignee.kind === 'agent')).toBe(
      true,
    );

    const page1 = await call('GET', '/api/v1/tasks?project=PAY&limit=4', { auth: session() });
    expect(page1.body.items).toHaveLength(4);
    expect(page1.body.nextCursor).toEqual(expect.any(String));
    const page2 = await call(
      'GET',
      `/api/v1/tasks?project=PAY&limit=4&cursor=${encodeURIComponent(page1.body.nextCursor)}`,
      { auth: session() },
    );
    expect(page2.status).toBe(200);
    const seen = new Set(page1.body.items.map((t: { key: string }) => t.key));
    expect(page2.body.items.some((t: { key: string }) => seen.has(t.key))).toBe(false);

    expectProblem(
      await call('GET', '/api/v1/tasks?project=PAY&limit=500', { auth: session() }),
      400,
      'BAD_REQUEST',
    );
    expectProblem(await call('GET', '/api/v1/tasks?project=NOPE', { auth: session() }), 404, 'NOT_FOUND');
  });

  it('POST, GET and PATCH /tasks, and the activity', async () => {
    const created = await call('POST', '/api/v1/tasks', {
      auth: session(),
      body: { project: 'WEB', title: 'Fix the footer', priority: 'high', assignee: 'me' },
    });
    expect(created.status).toBe(201);
    expect(created.body).toMatchObject({
      key: expect.stringMatching(/^WEB-\d+$/),
      status: 'todo',
      priority: 'high',
      assignee: { name: 'Ana Ruiz', kind: 'person' },
    });
    const taskKey: string = created.body.key;

    const fetched = await call('GET', `/api/v1/tasks/${taskKey.toLowerCase()}`, { auth: session() });
    expect(fetched.status).toBe(200);
    expect(fetched.body.key).toBe(taskKey);

    const updated = await call('PATCH', `/api/v1/tasks/${taskKey}`, {
      auth: session(),
      body: { status: 'in_progress', assignee: null, description: '**bold**' },
    });
    expect(updated.status).toBe(200);
    expect(updated.body).toMatchObject({ status: 'in_progress', assignee: null, description: '**bold**' });

    const activity = await call('GET', `/api/v1/tasks/${taskKey}/activity`, { auth: session() });
    expect(activity.status).toBe(200);
    expect(activity.body.items.map((a: { type: string }) => a.type)).toEqual([
      'task.created',
      'task.updated',
    ]);

    expectProblem(
      await call('PATCH', `/api/v1/tasks/${taskKey}`, { auth: session(), body: {} }),
      400,
      'BAD_REQUEST',
    );
    expectProblem(
      await call('POST', '/api/v1/tasks', {
        auth: session(),
        body: { project: 'WEB', title: 'x', assignee: crypto.randomUUID() },
      }),
      422,
      'UNPROCESSABLE_CONTENT',
    );
    expectProblem(await call('GET', '/api/v1/tasks/WEB-9999', { auth: session() }), 404, 'NOT_FOUND');
    expectProblem(await call('GET', '/api/v1/tasks/not-a-key', { auth: session() }), 400, 'BAD_REQUEST');
  });

  it('hides other workspaces', async () => {
    expectProblem(
      await call('GET', `/api/v1/tasks/${otherWorkspaceTask}`, { auth: session() }),
      404,
      'NOT_FOUND',
    );
    expectProblem(await call('GET', '/api/v1/tasks?project=ELSE', { auth: session() }), 404, 'NOT_FOUND');
  });

  it('GET /members lists people and agents with their responsible human', async () => {
    const result = await call('GET', '/api/v1/members', { auth: session() });
    expect(result.status).toBe(200);
    const agent = result.body.items.find((m: { name: string }) => m.name === 'claude-dev');
    expect(agent).toMatchObject({ kind: 'agent', email: null, responsible: { name: 'Ana Ruiz' } });
  });
});

describe('with API keys', () => {
  it('an agent key with all projects can read and write', async () => {
    const me = await call('GET', '/api/v1/me', { auth: key('agent') });
    expect(me.body).toMatchObject({
      user: { name: 'claude-dev', kind: 'agent', responsible: { name: 'Ana Ruiz' } },
      auth: { method: 'api_key', scope: { projects: 'all', access: 'write' } },
    });
    const created = await call('POST', '/api/v1/tasks', {
      auth: key('agent'),
      body: { project: 'WEB', title: 'Agent work', assignee: 'me' },
    });
    expect(created.status).toBe(201);
    expect(created.body).toMatchObject({
      createdBy: { name: 'claude-dev', kind: 'agent' },
      createdOnBehalfOf: { name: 'Ana Ruiz' },
    });
  });

  it('a project-scoped key works inside its scope and gets 403 outside it', async () => {
    const projects = await call('GET', '/api/v1/projects', { auth: key('agentPayOnly') });
    expect(projects.body.items.map((p: { key: string }) => p.key)).toEqual(['PAY']);

    expect((await call('GET', '/api/v1/tasks?project=PAY', { auth: key('agentPayOnly') })).status).toBe(200);
    expect(
      (
        await call('POST', '/api/v1/tasks', {
          auth: key('agentPayOnly'),
          body: { project: 'PAY', title: 'In scope' },
        })
      ).status,
    ).toBe(201);

    expectProblem(
      await call('GET', '/api/v1/tasks?project=WEB', { auth: key('agentPayOnly') }),
      403,
      'FORBIDDEN',
    );
    expectProblem(await call('GET', '/api/v1/tasks/WEB-1', { auth: key('agentPayOnly') }), 403, 'FORBIDDEN');
    expectProblem(
      await call('GET', '/api/v1/tasks/WEB-1/activity', { auth: key('agentPayOnly') }),
      403,
      'FORBIDDEN',
    );
    expectProblem(
      await call('POST', '/api/v1/tasks', {
        auth: key('agentPayOnly'),
        body: { project: 'WEB', title: 'Out' },
      }),
      403,
      'FORBIDDEN',
    );
    expectProblem(
      await call('PATCH', '/api/v1/tasks/WEB-1', { auth: key('agentPayOnly'), body: { status: 'done' } }),
      403,
      'FORBIDDEN',
    );
    // Creating projects needs a key over all projects.
    expectProblem(
      await call('POST', '/api/v1/projects', {
        auth: key('agentPayOnly'),
        body: { name: 'New', key: 'NEW' },
      }),
      403,
      'FORBIDDEN',
    );
  });

  it('a read-only key can read but gets 403 on every write route', async () => {
    for (const path of [
      '/api/v1/me',
      '/api/v1/projects',
      '/api/v1/members',
      '/api/v1/tasks?project=PAY',
      '/api/v1/tasks/PAY-1',
      '/api/v1/tasks/PAY-1/activity',
    ]) {
      expect((await call('GET', path, { auth: key('adminRead') })).status, path).toBe(200);
    }
    expectProblem(
      await call('POST', '/api/v1/tasks', { auth: key('adminRead'), body: { project: 'PAY', title: 'No' } }),
      403,
      'FORBIDDEN',
    );
    expectProblem(
      await call('PATCH', '/api/v1/tasks/PAY-1', { auth: key('adminRead'), body: { title: 'No' } }),
      403,
      'FORBIDDEN',
    );
    expectProblem(
      await call('POST', '/api/v1/projects', { auth: key('adminRead'), body: { name: 'No', key: 'NOPE' } }),
      403,
      'FORBIDDEN',
    );
    expectProblem(
      await call('PATCH', '/api/v1/projects/PAY', { auth: key('adminRead'), body: { name: 'No' } }),
      403,
      'FORBIDDEN',
    );
  });

  it("a person's key acts with that person's role", async () => {
    const me = await call('GET', '/api/v1/me', { auth: key('admin') });
    expect(me.body).toMatchObject({ user: { kind: 'person' }, role: 'owner', auth: { method: 'api_key' } });
  });
});

describe('clients', () => {
  it('the RPC endpoint serves the browser client with the session cookie', async () => {
    const browser: ApiClient = createORPCClient(
      new RPCLink({
        url: `${ORIGIN}${RPC_PREFIX}`,
        headers: { cookie },
        fetch: (request) => handle(request),
      }),
    );
    const projects = await browser.projects.list();
    expect(projects.items.map((p) => p.key)).toEqual(expect.arrayContaining(['PAY', 'WEB']));
    await expect(browser.tasks.get({ key: 'PAY-9999' })).rejects.toMatchObject({
      code: 'NOT_FOUND',
      status: 404,
      data: { requestId: expect.any(String) },
    });
  });

  it('the server-side client calls the router in-process with the request headers', async () => {
    const server = createApiClient(
      () => new Headers({ cookie }),
      () => core,
    );
    const me = await server.me.get();
    expect(me.user.name).toBe('Ana Ruiz');
    const anonymous = createApiClient(
      () => new Headers(),
      () => core,
    );
    await expect(anonymous.projects.list()).rejects.toMatchObject({ code: 'UNAUTHORIZED', status: 401 });
  });
});

// ---------------------------------------------------------------------------
// M2: theme, project switches, cross-project tasks, board moves, milestones, cycles, comments
// ---------------------------------------------------------------------------

/** Today and later days as calendar dates in UTC, the default APP_TIME_ZONE. */
function day(offset = 0): string {
  const date = new Date();
  date.setUTCDate(date.getUTCDate() + offset);
  return date.toISOString().slice(0, 10);
}

describe('M2: me and project switches', () => {
  it('PATCH /me sets the theme for a session and returns 403 to API keys', async () => {
    const updated = await call('PATCH', '/api/v1/me', { auth: session(), body: { theme: 'dark' } });
    expect(updated.status, JSON.stringify(updated.body)).toBe(200);
    expect(updated.body).toMatchObject({ user: { name: 'Ana Ruiz', theme: 'dark' } });
    expect((await call('GET', '/api/v1/me', { auth: session() })).body.user.theme).toBe('dark');

    expectProblem(
      await call('PATCH', '/api/v1/me', { auth: key('admin'), body: { theme: 'light' } }),
      403,
      'FORBIDDEN',
    );
    expectProblem(
      await call('PATCH', '/api/v1/me', { auth: key('agent'), body: { theme: 'light' } }),
      403,
      'FORBIDDEN',
    );
    expectProblem(
      await call('PATCH', '/api/v1/me', { auth: session(), body: { theme: 'sepia' } }),
      400,
      'BAD_REQUEST',
    );
    await call('PATCH', '/api/v1/me', { auth: session(), body: { theme: 'system' } });
  });

  it('PATCH /projects/{project} turns milestones and cycles off and on', async () => {
    await call('POST', '/api/v1/projects', { auth: session(), body: { name: 'Switches', key: 'SW' } });
    const off = await call('PATCH', '/api/v1/projects/SW', {
      auth: session(),
      body: { usesMilestones: false, usesCycles: false },
    });
    expect(off.status, JSON.stringify(off.body)).toBe(200);
    expect(off.body).toMatchObject({
      key: 'SW',
      usesMilestones: false,
      usesCycles: false,
      currentCycle: null,
    });

    expectProblem(
      await call('POST', '/api/v1/projects/SW/milestones', { auth: session(), body: { name: 'v1' } }),
      409,
      'CONFLICT',
    );
    expectProblem(
      await call('POST', '/api/v1/projects/SW/cycles', { auth: session(), body: {} }),
      409,
      'CONFLICT',
    );
    const on = await call('PATCH', '/api/v1/projects/SW', {
      auth: session(),
      body: { usesMilestones: true },
    });
    expect(on.body).toMatchObject({ usesMilestones: true, usesCycles: false });
    expectProblem(
      await call('PATCH', '/api/v1/projects/SW', { auth: key('adminRead'), body: { usesCycles: true } }),
      403,
      'FORBIDDEN',
    );
  });
});

describe('M2: tasks across projects and on the board', () => {
  it('GET /tasks without a project spans every readable project', async () => {
    const all = await call('GET', '/api/v1/tasks?limit=200', { auth: session() });
    expect(all.status, JSON.stringify(all.body)).toBe(200);
    const projects = new Set(all.body.items.map((t: { project: { key: string } }) => t.project.key));
    expect([...projects]).toEqual(expect.arrayContaining(['PAY', 'WEB']));
    expect(all.body.items[0]).toMatchObject({
      project: { key: expect.any(String), name: expect.any(String) },
      milestone: null,
      cycle: null,
      rank: expect.any(Number),
    });

    // The plan's "My tasks" call, as the agent.
    const mine = await call('GET', '/api/v1/tasks?assignee=me', { auth: key('agent') });
    expect(mine.status).toBe(200);
    expect(mine.body.items.length).toBeGreaterThan(0);
    expect(
      mine.body.items.every((t: { assignee: { name: string } }) => t.assignee.name === 'claude-dev'),
    ).toBe(true);

    // Two projects by key.
    const two = await call('GET', '/api/v1/tasks?project=PAY&project=web&limit=200', { auth: session() });
    expect(two.status, JSON.stringify(two.body)).toBe(200);
    expect(new Set(two.body.items.map((t: { project: { key: string } }) => t.project.key))).toEqual(
      new Set(['PAY', 'WEB']),
    );

    // A key scoped to PAY sees only PAY without a project, and 403 when it names WEB.
    const scoped = await call('GET', '/api/v1/tasks?limit=200', { auth: key('agentPayOnly') });
    expect(scoped.status).toBe(200);
    expect(new Set(scoped.body.items.map((t: { project: { key: string } }) => t.project.key))).toEqual(
      new Set(['PAY']),
    );
    expectProblem(
      await call('GET', '/api/v1/tasks?project=PAY&project=WEB', { auth: key('agentPayOnly') }),
      403,
      'FORBIDDEN',
    );
    expectProblem(await call('GET', '/api/v1/tasks?cycle=later', { auth: session() }), 400, 'BAD_REQUEST');
    expectProblem(await call('GET', '/api/v1/tasks?order=random', { auth: session() }), 400, 'BAD_REQUEST');
  });

  it('PATCH /tasks/{key} moves a card with position and maps a stale ifUpdatedAt to 409 TASK_CHANGED', async () => {
    await call('POST', '/api/v1/projects', { auth: session(), body: { name: 'Board', key: 'BRD' } });
    const a = (await call('POST', '/api/v1/tasks', { auth: session(), body: { project: 'BRD', title: 'A' } }))
      .body;
    const b = (await call('POST', '/api/v1/tasks', { auth: session(), body: { project: 'BRD', title: 'B' } }))
      .body;
    const column = async () =>
      (
        await call('GET', '/api/v1/tasks?project=BRD&status=todo&order=board', { auth: session() })
      ).body.items.map((t: { key: string }) => t.key);
    // New tasks go to the top of their column.
    expect(await column()).toEqual([b.key, a.key]);

    const moved = await call('PATCH', `/api/v1/tasks/${a.key}`, {
      auth: session(),
      body: { position: { before: b.key }, ifUpdatedAt: a.updatedAt },
    });
    expect(moved.status, JSON.stringify(moved.body)).toBe(200);
    expect(await column()).toEqual([a.key, b.key]);

    // The anchor must sit in the target column.
    const wrongColumn = await call('PATCH', `/api/v1/tasks/${b.key}`, {
      auth: key('agent'),
      body: { status: 'in_progress', position: { after: a.key } },
    });
    expectProblem(wrongColumn, 422, 'UNPROCESSABLE_CONTENT');
    expect(wrongColumn.body.issues).toEqual([{ path: 'position.after', message: expect.any(String) }]);

    // Status and position in one write: A moves to In progress, after C.
    const c = (
      await call('POST', '/api/v1/tasks', {
        auth: session(),
        body: { project: 'BRD', title: 'C', status: 'in_progress' },
      })
    ).body;
    const across = await call('PATCH', `/api/v1/tasks/${a.key}`, {
      auth: key('agent'),
      body: { status: 'in_progress', position: { after: c.key } },
    });
    expect(across.status, JSON.stringify(across.body)).toBe(200);
    const progress = await call('GET', '/api/v1/tasks?project=BRD&status=in_progress&order=board', {
      auth: session(),
    });
    expect(progress.body.items.map((t: { key: string }) => t.key)).toEqual([c.key, a.key]);

    const stale = await call('PATCH', `/api/v1/tasks/${a.key}`, {
      auth: key('agent'),
      body: { title: 'A, again', ifUpdatedAt: '2000-01-01T00:00:00Z' },
    });
    expectProblem(stale, 409, 'TASK_CHANGED');
    expect(stale.body.task).toMatchObject({ key: a.key, title: 'A', status: 'in_progress' });
    expect(stale.body.task.updatedAt).toBe(across.body.updatedAt);

    expectProblem(
      await call('PATCH', `/api/v1/tasks/${a.key}`, {
        auth: session(),
        body: { position: { before: b.key, after: b.key } },
      }),
      400,
      'BAD_REQUEST',
    );
  });
});

describe('M2: milestones and cycles', () => {
  let milestoneId: string;

  it('milestones: create, list, get, update, filter tasks, delete', async () => {
    await call('POST', '/api/v1/projects', { auth: session(), body: { name: 'Planning', key: 'PLN' } });
    const created = await call('POST', '/api/v1/projects/pln/milestones', {
      auth: session(),
      body: { name: 'Webhooks v2', targetDate: day(30) },
    });
    expect(created.status, JSON.stringify(created.body)).toBe(201);
    expect(created.body).toMatchObject({
      name: 'Webhooks v2',
      status: 'planned',
      project: { key: 'PLN' },
      progress: { total: 0, done: 0 },
      overdue: false,
    });
    milestoneId = created.body.id;

    expectProblem(
      await call('POST', '/api/v1/projects/PLN/milestones', {
        auth: session(),
        body: { name: 'webhooks V2' },
      }),
      409,
      'CONFLICT',
    );
    expectProblem(
      await call('POST', '/api/v1/projects/PLN/milestones', { auth: session(), body: { name: '' } }),
      400,
      'BAD_REQUEST',
    );

    const task = await call('POST', '/api/v1/tasks', {
      auth: key('agent'),
      body: { project: 'PLN', title: 'Retry webhooks', milestone: milestoneId },
    });
    expect(task.status, JSON.stringify(task.body)).toBe(201);
    expect(task.body.milestone).toMatchObject({ id: milestoneId, name: 'Webhooks v2' });

    // Starting a task turns the milestone Active.
    await call('PATCH', `/api/v1/tasks/${task.body.key}`, {
      auth: key('agent'),
      body: { status: 'in_progress' },
    });
    const fetched = await call('GET', `/api/v1/milestones/${milestoneId}`, { auth: key('adminRead') });
    expect(fetched.status).toBe(200);
    expect(fetched.body).toMatchObject({ status: 'active', progress: { total: 1, inProgress: 1 } });

    const list = await call('GET', '/api/v1/projects/PLN/milestones?status=active', {
      auth: key('adminRead'),
    });
    expect(list.status, JSON.stringify(list.body)).toBe(200);
    expect(list.body.items.map((m: { id: string }) => m.id)).toEqual([milestoneId]);

    const inMilestone = await call('GET', `/api/v1/tasks?project=PLN&milestone=${milestoneId}`, {
      auth: session(),
    });
    expect(inMilestone.body.items.map((t: { key: string }) => t.key)).toEqual([task.body.key]);
    const without = await call('GET', '/api/v1/tasks?project=PLN&milestone=none', { auth: session() });
    expect(without.body.items).toHaveLength(0);

    const updated = await call('PATCH', `/api/v1/milestones/${milestoneId}`, {
      auth: session(),
      body: { status: 'completed', targetDate: null },
    });
    expect(updated.status, JSON.stringify(updated.body)).toBe(200);
    expect(updated.body).toMatchObject({
      status: 'completed',
      targetDate: null,
      completedAt: expect.any(String),
    });

    const extra = await call('POST', '/api/v1/projects/PLN/milestones', {
      auth: session(),
      body: { name: 'Tmp' },
    });
    const deleted = await call('DELETE', `/api/v1/milestones/${extra.body.id}`, { auth: key('agent') });
    expect(deleted.status).toBe(204);
    expect(deleted.body).toBeNull();
    expectProblem(
      await call('GET', `/api/v1/milestones/${extra.body.id}`, { auth: session() }),
      404,
      'NOT_FOUND',
    );
    expectProblem(await call('GET', '/api/v1/milestones/not-an-id', { auth: session() }), 400, 'BAD_REQUEST');
  });

  it('milestones: a read-only key reads only, a PAY-only key gets 403 elsewhere', async () => {
    expectProblem(
      await call('POST', '/api/v1/projects/PLN/milestones', { auth: key('adminRead'), body: { name: 'No' } }),
      403,
      'FORBIDDEN',
    );
    expectProblem(
      await call('PATCH', `/api/v1/milestones/${milestoneId}`, {
        auth: key('adminRead'),
        body: { name: 'No' },
      }),
      403,
      'FORBIDDEN',
    );
    expectProblem(
      await call('DELETE', `/api/v1/milestones/${milestoneId}`, { auth: key('adminRead') }),
      403,
      'FORBIDDEN',
    );
    expectProblem(
      await call('GET', '/api/v1/projects/PLN/milestones', { auth: key('agentPayOnly') }),
      403,
      'FORBIDDEN',
    );
    expectProblem(
      await call('GET', `/api/v1/milestones/${milestoneId}`, { auth: key('agentPayOnly') }),
      403,
      'FORBIDDEN',
    );
    expect((await call('GET', '/api/v1/projects/PAY/milestones', { auth: key('agentPayOnly') })).status).toBe(
      200,
    );
  });

  it('cycles: create, get by number, current and next, update, filter tasks, end with rollover', async () => {
    const created = await call('POST', '/api/v1/projects/PLN/cycles', {
      auth: session(),
      body: { startsOn: day(0), endsOn: day(6), name: 'Kickoff' },
    });
    expect(created.status, JSON.stringify(created.body)).toBe(201);
    expect(created.body).toMatchObject({ number: 1, state: 'current', daysLeft: 7, rollovers: [] });

    expectProblem(
      await call('POST', '/api/v1/projects/PLN/cycles', {
        auth: session(),
        body: { startsOn: day(3), endsOn: day(10) },
      }),
      409,
      'CONFLICT',
    );
    expectProblem(
      await call('POST', '/api/v1/projects/PLN/cycles', {
        auth: session(),
        body: { startsOn: day(10), endsOn: day(5) },
      }),
      400,
      'BAD_REQUEST',
    );

    const current = await call('GET', '/api/v1/cycles/pln/current', { auth: key('adminRead') });
    expect(current.status, JSON.stringify(current.body)).toBe(200);
    expect(current.body).toMatchObject({ number: 1, name: 'Kickoff' });
    expect((await call('GET', '/api/v1/cycles/PLN/1', { auth: session() })).body.id).toBe(created.body.id);
    expectProblem(await call('GET', '/api/v1/cycles/PLN/next', { auth: session() }), 404, 'NOT_FOUND');
    expectProblem(await call('GET', '/api/v1/cycles/PLN/7', { auth: session() }), 404, 'NOT_FOUND');
    expectProblem(await call('GET', '/api/v1/cycles/PLN/last', { auth: session() }), 400, 'BAD_REQUEST');

    const listed = await call('GET', '/api/v1/projects/PLN/cycles?state=current', { auth: key('adminRead') });
    expect(listed.status, JSON.stringify(listed.body)).toBe(200);
    expect(listed.body.items.map((c: { number: number }) => c.number)).toEqual([1]);
    const project = (await call('GET', '/api/v1/projects', { auth: session() })).body.items.find(
      (p: { key: string }) => p.key === 'PLN',
    );
    expect(project.currentCycle).toMatchObject({ number: 1, name: 'Kickoff' });

    const renamed = await call('PATCH', '/api/v1/cycles/PLN/current', {
      auth: session(),
      body: { name: 'Start' },
    });
    expect(renamed.status, JSON.stringify(renamed.body)).toBe(200);
    expect(renamed.body.name).toBe('Start');
    expectProblem(
      await call('PATCH', '/api/v1/cycles/PLN/1', { auth: session(), body: { startsOn: day(1) } }),
      409,
      'CONFLICT',
    );

    const open = await call('POST', '/api/v1/tasks', {
      auth: key('agent'),
      body: { project: 'PLN', title: 'Ship it', cycle: 'current' },
    });
    expect(open.status, JSON.stringify(open.body)).toBe(201);
    expect(open.body.cycle).toMatchObject({ number: 1 });
    const done = await call('POST', '/api/v1/tasks', {
      auth: key('agent'),
      body: { project: 'PLN', title: 'Done already', cycle: 1, status: 'done' },
    });
    expect(done.status).toBe(201);
    const inCycle = await call('GET', '/api/v1/tasks?project=PLN&cycle=current', { auth: session() });
    expect(inCycle.body.items.map((t: { key: string }) => t.key).sort()).toEqual(
      [open.body.key, done.body.key].sort(),
    );
    expectProblem(
      await call('POST', '/api/v1/tasks', {
        auth: session(),
        body: { project: 'PLN', title: 'x', cycle: 'next' },
      }),
      422,
      'UNPROCESSABLE_CONTENT',
    );

    expectProblem(
      await call('POST', '/api/v1/cycles/PLN/1/end', { auth: key('adminRead'), body: {} }),
      403,
      'FORBIDDEN',
    );
    expectProblem(
      await call('POST', '/api/v1/cycles/PLN/1/end', { auth: session(), body: { moveTo: 'later' } }),
      400,
      'BAD_REQUEST',
    );
    expectProblem(
      await call('POST', '/api/v1/cycles/PLN/1/end', { auth: session(), body: { moveTo: 9 } }),
      422,
      'UNPROCESSABLE_CONTENT',
    );

    const ended = await call('POST', '/api/v1/cycles/PLN/current/end', { auth: key('agent'), body: {} });
    expect(ended.status, JSON.stringify(ended.body)).toBe(200);
    expect(ended.body).toMatchObject({
      number: 1,
      state: 'completed',
      endedBy: { name: 'claude-dev' },
      summary: { scope: 2, completed: 1, rolledOver: 1 },
    });
    expect(ended.body.rollovers).toEqual([
      expect.objectContaining({
        task: expect.objectContaining({ key: open.body.key }),
        movedTo: expect.objectContaining({ number: 2 }),
      }),
    ]);

    // The next cycle was created with the same length; ending again changes nothing.
    const next = await call('GET', '/api/v1/cycles/PLN/next', { auth: session() });
    expect(next.body).toMatchObject({ number: 2, startsOn: day(7), endsOn: day(13), state: 'upcoming' });
    const again = await call('POST', '/api/v1/cycles/PLN/1/end', { auth: session() });
    expect(again.status, JSON.stringify(again.body)).toBe(200);
    expect(again.body.completedAt).toBe(ended.body.completedAt);

    const timeline = await call('GET', `/api/v1/tasks/${open.body.key}/timeline`, { auth: key('adminRead') });
    expect(timeline.status).toBe(200);
    expect(timeline.body.items.map((i: { kind: string; type?: string }) => i.type)).toEqual([
      'task.created',
      'cycle.ended',
    ]);
  });

  it('cycles: scope checks', async () => {
    expectProblem(
      await call('POST', '/api/v1/projects/PLN/cycles', { auth: key('adminRead'), body: {} }),
      403,
      'FORBIDDEN',
    );
    expectProblem(
      await call('PATCH', '/api/v1/cycles/PLN/2', { auth: key('adminRead'), body: { name: 'No' } }),
      403,
      'FORBIDDEN',
    );
    expectProblem(await call('GET', '/api/v1/cycles/PLN/1', { auth: key('agentPayOnly') }), 403, 'FORBIDDEN');
    expectProblem(
      await call('GET', '/api/v1/projects/PLN/cycles', { auth: key('agentPayOnly') }),
      403,
      'FORBIDDEN',
    );
    expectProblem(await call('GET', '/api/v1/cycles/ELSE/current', { auth: session() }), 404, 'NOT_FOUND');
  });
});

describe('M2: comments and the timeline', () => {
  let commentId: string;

  it('an agent comments with mentions (the Gate G2 call)', async () => {
    const created = await call('POST', '/api/v1/tasks/PAY-1/comments', {
      auth: key('agent'),
      body: { body: `Done. @claude-dev, see @${adminEmail} and @nobody` },
    });
    expect(created.status, JSON.stringify(created.body)).toBe(201);
    expect(created.body).toMatchObject({
      taskKey: 'PAY-1',
      author: { name: 'claude-dev', kind: 'agent' },
      onBehalfOf: { name: 'Ana Ruiz' },
      editedAt: null,
      deletedAt: null,
    });
    expect(created.body.body).toContain(`(mention:${agentId})`);
    expect(created.body.body).toContain('@nobody');
    expect(created.body.mentions.map((m: { name: string }) => m.name)).toEqual(['claude-dev', 'Ana Ruiz']);
    commentId = created.body.id;

    const list = await call('GET', '/api/v1/tasks/pay-1/comments', { auth: key('adminRead') });
    expect(list.status).toBe(200);
    expect(list.body.items.map((c: { id: string }) => c.id)).toContain(commentId);

    const timeline = await call('GET', '/api/v1/tasks/PAY-1/timeline', { auth: session() });
    expect(timeline.status).toBe(200);
    const kinds = timeline.body.items.map((i: { kind: string }) => i.kind);
    expect(kinds[0]).toBe('activity');
    expect(kinds.at(-1)).toBe('comment');
    expect(timeline.body.items.at(-1)).toMatchObject({ id: commentId, kind: 'comment' });
  });

  it('only the author edits or deletes; deleted comments stay with a null body', async () => {
    // The responsible human cannot edit or delete the agent's comment.
    expectProblem(
      await call('PATCH', `/api/v1/comments/${commentId}`, { auth: session(), body: { body: 'Mine now' } }),
      403,
      'FORBIDDEN',
    );
    expectProblem(
      await call('DELETE', `/api/v1/comments/${commentId}`, { auth: session() }),
      403,
      'FORBIDDEN',
    );

    const edited = await call('PATCH', `/api/v1/comments/${commentId}`, {
      auth: key('agent'),
      body: { body: 'Done, tests pass.' },
    });
    expect(edited.status, JSON.stringify(edited.body)).toBe(200);
    expect(edited.body).toMatchObject({
      body: 'Done, tests pass.',
      editedAt: expect.any(String),
      mentions: [],
    });
    expectProblem(
      await call('PATCH', `/api/v1/comments/${commentId}`, { auth: key('agent'), body: { body: '   ' } }),
      400,
      'BAD_REQUEST',
    );

    const deleted = await call('DELETE', `/api/v1/comments/${commentId}`, { auth: key('agent') });
    expect(deleted.status, JSON.stringify(deleted.body)).toBe(200);
    expect(deleted.body).toMatchObject({ id: commentId, body: null, deletedAt: expect.any(String) });
    expectProblem(
      await call('DELETE', `/api/v1/comments/${commentId}`, { auth: key('agent') }),
      409,
      'CONFLICT',
    );
    expectProblem(
      await call('PATCH', `/api/v1/comments/${commentId}`, { auth: key('agent'), body: { body: 'Back' } }),
      409,
      'CONFLICT',
    );

    const timeline = await call('GET', '/api/v1/tasks/PAY-1/timeline', { auth: session() });
    expect(timeline.body.items.find((i: { id: string }) => i.id === commentId)).toMatchObject({
      kind: 'comment',
      body: null,
    });
    expectProblem(
      await call('DELETE', `/api/v1/comments/${crypto.randomUUID()}`, { auth: key('agent') }),
      404,
      'NOT_FOUND',
    );
    expectProblem(await call('DELETE', '/api/v1/comments/nope', { auth: key('agent') }), 400, 'BAD_REQUEST');
  });

  it('comment scope checks', async () => {
    expectProblem(
      await call('POST', '/api/v1/tasks/PAY-1/comments', { auth: key('adminRead'), body: { body: 'No' } }),
      403,
      'FORBIDDEN',
    );
    expectProblem(
      await call('POST', '/api/v1/tasks/WEB-1/comments', { auth: key('agentPayOnly'), body: { body: 'No' } }),
      403,
      'FORBIDDEN',
    );
    expectProblem(
      await call('GET', '/api/v1/tasks/WEB-1/comments', { auth: key('agentPayOnly') }),
      403,
      'FORBIDDEN',
    );
    expectProblem(
      await call('GET', '/api/v1/tasks/WEB-1/timeline', { auth: key('agentPayOnly') }),
      403,
      'FORBIDDEN',
    );
    expect(
      (
        await call('POST', '/api/v1/tasks/PAY-1/comments', {
          auth: key('agentPayOnly'),
          body: { body: 'In scope' },
        })
      ).status,
    ).toBe(201);
    expectProblem(
      await call('GET', `/api/v1/tasks/${otherWorkspaceTask}/comments`, { auth: session() }),
      404,
      'NOT_FOUND',
    );
    expectProblem(
      await call('POST', '/api/v1/tasks/PAY-1/comments', {
        auth: key('agent'),
        body: { body: 'x'.repeat(20_001) },
      }),
      400,
      'BAD_REQUEST',
    );
  });
});

describe('M2: clients', () => {
  it('the RPC client receives TASK_CHANGED with the current task', async () => {
    const browser: ApiClient = createORPCClient(
      new RPCLink({
        url: `${ORIGIN}${RPC_PREFIX}`,
        headers: { cookie },
        fetch: (request) => handle(request),
      }),
    );
    const task = await browser.tasks.create({ project: 'BRD', title: 'Conflict me' });
    await browser.tasks.update({ key: task.key, title: 'Changed elsewhere' });
    await expect(
      browser.tasks.update({ key: task.key, status: 'in_review', ifUpdatedAt: task.updatedAt }),
    ).rejects.toMatchObject({
      code: 'TASK_CHANGED',
      status: 409,
      defined: true,
      data: { task: { key: task.key, title: 'Changed elsewhere' } },
    });
  });
});

describe('M4: dashboard', () => {
  type Item = { task: { key: string; project: { key: string } }; assignee?: { id: string } | null };
  const groupNames = ['review', 'mentions', 'stalled', 'deadlines'] as const;
  const allItems = (body: { groups: Record<string, { items: Item[] }> }) =>
    groupNames.flatMap((name) => body.groups[name]?.items ?? []);
  const totals = (body: { groups: Record<string, { total: number }> }) =>
    Object.fromEntries(groupNames.map((name) => [name, body.groups[name]?.total]));

  it('GET /dashboard with a session: Mine by default, Everyone on request, totals match /dashboard/counts', async () => {
    // An agent task in review and an agent question for its person.
    const created = await call('POST', '/api/v1/tasks', {
      auth: key('agent'),
      body: { project: 'WEB', title: 'Dashboard review', status: 'in_review', assignee: 'me' },
    });
    expect(created.status).toBe(201);
    const asked = await call('POST', `/api/v1/tasks/${created.body.key}/comments`, {
      auth: key('agent'),
      body: { body: `@${adminEmail} can you review this?` },
    });
    expect(asked.status).toBe(201);

    const mine = await call('GET', '/api/v1/dashboard', { auth: session() });
    expect(mine.status, JSON.stringify(mine.body)).toBe(200);
    expect(mine.body).toMatchObject({ scope: 'mine', generatedAt: expect.any(String) });
    const review = mine.body.groups.review.items as Item[];
    expect(review.map((item) => item.task.key)).toContain(created.body.key);
    expect(review.every((item) => [admin.userId, agentId].includes(item.assignee?.id ?? ''))).toBe(true);
    expect(mine.body.groups.mentions.items).toContainEqual(
      expect.objectContaining({
        task: expect.objectContaining({ key: created.body.key }),
        comment: {
          id: asked.body.id,
          excerpt: '@Ana Ruiz can you review this?',
          createdAt: asked.body.createdAt,
        },
        author: { id: agentId, name: 'claude-dev', kind: 'agent' },
        onBehalfOf: expect.objectContaining({ id: admin.userId }),
        mentioned: expect.objectContaining({ id: admin.userId, responsible: null }),
      }),
    );
    expect(mine.body.projects.map((p: { key: string }) => p.key)).toEqual(
      expect.arrayContaining(['PAY', 'WEB']),
    );
    expect(mine.body.agents.map((a: { agent: { id: string } }) => a.agent.id)).toContain(agentId);

    const counts = await call('GET', '/api/v1/dashboard/counts', { auth: session() });
    expect(counts.status).toBe(200);
    expect(counts.body).toEqual({
      ...totals(mine.body),
      total: Object.values(totals(mine.body)).reduce((sum: number, n) => sum + (n ?? 0), 0),
    });

    const everyone = await call('GET', '/api/v1/dashboard?scope=everyone', { auth: session() });
    expect(everyone.status).toBe(200);
    expect(everyone.body.scope).toBe('everyone');
    expect(everyone.body.groups.review.total).toBeGreaterThanOrEqual(mine.body.groups.review.total);
  });

  it('with an agent key, Mine is the agent; both routes answer', async () => {
    const result = await call('GET', '/api/v1/dashboard', { auth: key('agent') });
    expect(result.status).toBe(200);
    const review = result.body.groups.review.items as Item[];
    expect(review.length).toBeGreaterThan(0);
    expect(review.every((item) => item.assignee?.id === agentId)).toBe(true);
    expect(result.body.groups.mentions.total).toBe(0);
    expect(result.body.agents).toEqual([]);
    const counts = await call('GET', '/api/v1/dashboard/counts', { auth: key('agent') });
    expect(counts.status).toBe(200);
    expect(counts.body.review).toBe(result.body.groups.review.total);
  });

  it('a read-only key may call both routes', async () => {
    expect((await call('GET', '/api/v1/dashboard?scope=everyone', { auth: key('adminRead') })).status).toBe(
      200,
    );
    expect((await call('GET', '/api/v1/dashboard/counts', { auth: key('adminRead') })).status).toBe(200);
  });

  it('a project-scoped key sees only its projects', async () => {
    const result = await call('GET', '/api/v1/dashboard?scope=everyone', { auth: key('agentPayOnly') });
    expect(result.status).toBe(200);
    expect(result.body.projects.map((p: { key: string }) => p.key)).toEqual(['PAY']);
    const items = allItems(result.body);
    expect(items.length).toBeGreaterThan(0);
    expect(items.every((item) => item.task === undefined || item.task.project.key === 'PAY')).toBe(true);
    const all = await call('GET', '/api/v1/dashboard?scope=everyone', { auth: key('agent') });
    expect(
      allItems(all.body).some((item) => item.task !== undefined && item.task.project.key !== 'PAY'),
    ).toBe(true);
  });

  it('the dev seed with planning and dashboard data fills every group for the admin', async () => {
    const fresh = await createTestDatabase({ prefix: 'pm_web_seed' });
    fresh.pool.on('error', () => {});
    try {
      const freshCore: CoreContext = {
        db: fresh.db,
        auth: createAuth({ db: fresh.db, secret: SECRET, baseUrl: ORIGIN }),
        publicUrl: ORIGIN,
      };
      const seeded = await seedDevData(freshCore, { planning: true, dashboard: true });
      expect(seeded.member).toMatchObject({ name: 'Tomás Berg' });
      const freshHandle = createApiFetchHandler(freshCore);
      const get = async (path: string) => {
        const response = await freshHandle(
          new Request(`${ORIGIN}${path}`, { headers: { authorization: `Bearer ${seeded.adminKey}` } }),
        );
        expect(response.status).toBe(200);
        return response.json();
      };
      const result = await get('/api/v1/dashboard');
      expect(totals(result)).toEqual({ review: 3, mentions: 2, stalled: 1, deadlines: 3 });
      const keysOf = (name: (typeof groupNames)[number]) =>
        (result.groups[name].items as Item[]).map((item) => item.task.key).sort();
      expect(keysOf('review')).toEqual(['PAY-3', 'PAY-5', 'WEB-3']);
      expect(keysOf('mentions')).toEqual(['PAY-8', 'WEB-3']);
      expect(keysOf('stalled')).toEqual(['WEB-1']);
      expect(result.groups.deadlines.items).toEqual([
        expect.objectContaining({
          kind: 'milestone',
          milestone: expect.objectContaining({ name: 'PCI audit' }),
        }),
        expect.objectContaining({ kind: 'cycle', project: { key: 'WEB', name: 'Web app' }, daysLeft: 2 }),
        expect.objectContaining({ kind: 'cycle', project: { key: 'PAY', name: 'Payments' }, daysLeft: 3 }),
      ]);
      expect(result.agents).toEqual([
        expect.objectContaining({ stalled: true, currentTask: expect.objectContaining({ key: 'WEB-1' }) }),
      ]);
      expect(await get('/api/v1/dashboard/counts')).toEqual({ ...totals(result), total: 9 });
    } finally {
      await fresh.drop();
    }
  }, 60_000);

  it('rejects an unknown scope and requests without credentials', async () => {
    expectProblem(await call('GET', '/api/v1/dashboard?scope=all', { auth: session() }), 400, 'BAD_REQUEST');
    expectProblem(await call('GET', '/api/v1/dashboard'), 401, 'UNAUTHORIZED');
    expectProblem(await call('GET', '/api/v1/dashboard/counts'), 401, 'UNAUTHORIZED');
  });
});

describe('0.6.0: deleting a project', () => {
  it('DELETE /projects/{project} with the key confirmed in the body returns 204 and removes it', async () => {
    await call('POST', '/api/v1/projects', { auth: session(), body: { name: 'Doomed', key: 'DOOM' } });
    await call('POST', '/api/v1/tasks', { auth: session(), body: { project: 'DOOM', title: 'Goes too' } });

    const missing = await call('DELETE', '/api/v1/projects/DOOM', { auth: session() });
    expectProblem(missing, 400, 'BAD_REQUEST');
    const wrong = await call('DELETE', '/api/v1/projects/DOOM', {
      auth: session(),
      body: { confirmKey: 'PAY' },
    });
    expectProblem(wrong, 400, 'BAD_REQUEST');
    expect(wrong.body.issues).toEqual([
      expect.objectContaining({ path: 'confirmKey', message: 'Type the project key to confirm' }),
    ]);
    expectProblem(
      await call('DELETE', '/api/v1/projects/NOPE', { auth: session(), body: { confirmKey: 'NOPE' } }),
      404,
      'NOT_FOUND',
    );
    expectProblem(
      await call('DELETE', '/api/v1/projects/ELSE', { auth: session(), body: { confirmKey: 'ELSE' } }),
      404,
      'NOT_FOUND',
    );

    const deleted = await call('DELETE', '/api/v1/projects/doom', {
      auth: session(),
      body: { confirmKey: ' doom ' },
    });
    expect(deleted.status, JSON.stringify(deleted.body)).toBe(204);
    expect(deleted.body).toBeNull();
    const projects = await call('GET', '/api/v1/projects', { auth: session() });
    expect(projects.body.items.map((p: { key: string }) => p.key)).not.toContain('DOOM');
    expectProblem(await call('GET', '/api/v1/tasks/DOOM-1', { auth: session() }), 404, 'NOT_FOUND');
    expectProblem(
      await call('DELETE', '/api/v1/projects/DOOM', { auth: session(), body: { confirmKey: 'DOOM' } }),
      404,
      'NOT_FOUND',
    );
  });

  it('returns 403 to agents, read-only and project-scoped keys; an owner key over all projects may delete', async () => {
    await call('POST', '/api/v1/projects', { auth: session(), body: { name: 'Kept', key: 'KEPT' } });
    const body = { confirmKey: 'KEPT' };
    for (const name of ['agent', 'adminRead'] as const) {
      expectProblem(
        await call('DELETE', '/api/v1/projects/KEPT', { auth: key(name), body }),
        403,
        'FORBIDDEN',
      );
    }
    expectProblem(
      await call('DELETE', '/api/v1/projects/PAY', {
        auth: key('agentPayOnly'),
        body: { confirmKey: 'PAY' },
      }),
      403,
      'FORBIDDEN',
    );
    const agentResult = await call('DELETE', '/api/v1/projects/KEPT', { auth: key('agent'), body });
    expect(agentResult.body.detail).toBe('Only owners and admins can delete a project.');
    expect(
      (await call('GET', '/api/v1/projects', { auth: session() })).body.items.map(
        (p: { key: string }) => p.key,
      ),
    ).toEqual(expect.arrayContaining(['PAY', 'KEPT']));

    const deleted = await call('DELETE', '/api/v1/projects/KEPT', { auth: key('admin'), body });
    expect(deleted.status).toBe(204);
  });
});

describe('M5: labels, due dates, blockers and subtasks', () => {
  const project = 'MFIVE';

  beforeAll(async () => {
    const created = await call('POST', '/api/v1/projects', {
      auth: session(),
      body: { name: 'Native fields', key: project },
    });
    expect(created.status).toBe(201);
  });

  async function newTask(body: Record<string, unknown>) {
    const result = await call('POST', '/api/v1/tasks', { auth: session(), body: { project, ...body } });
    expect(result.status, JSON.stringify(result.body)).toBe(201);
    return result.body;
  }

  it('creates and reads tasks with labels, a due date, a parent and blockers', async () => {
    const parent = await newTask({ title: 'Parent', assignee: agentId, labels: ['Backend'] });
    const blocker = await newTask({ title: 'Blocker' });
    const child = await newTask({
      title: 'Child',
      parent: parent.key.toLowerCase(),
      blockedBy: [blocker.key],
      dueDate: '2099-11-20',
      labels: ['backend', 'payouts'],
    });
    expect(child).toMatchObject({
      dueDate: '2099-11-20',
      parent: { key: parent.key, title: 'Parent' },
      assignee: { id: agentId },
      blocked: true,
      blockedBy: [{ key: blocker.key, title: 'Blocker', status: 'todo' }],
      labels: [
        { name: 'Backend', source: 'app' },
        { name: 'payouts', source: 'app' },
      ],
    });
    const fetched = await call('GET', `/api/v1/tasks/${parent.key}`, { auth: key('agent') });
    expect(fetched.body).toMatchObject({
      subtasks: [{ key: child.key }],
      subtaskProgress: { done: 0, total: 1 },
      blocks: [],
    });
    const activity = await call('GET', `/api/v1/tasks/${child.key}/activity`, { auth: session() });
    expect(activity.body.items[0].changes.map((change: { field: string }) => change.field)).toEqual(
      expect.arrayContaining(['labels', 'dueDate', 'parent', 'blockedBy']),
    );
  });

  it('answers loops, deep subtasks and other projects with their problem codes', async () => {
    const a = await newTask({ title: 'Loop A' });
    const b = await newTask({ title: 'Loop B', blockedBy: [a.key] });
    const loop = await call('PATCH', `/api/v1/tasks/${a.key}`, {
      auth: session(),
      body: { addBlockers: [b.key] },
    });
    expectProblem(loop, 409, 'DEPENDENCY_LOOP');
    expect(loop.body.detail).toBe(`Can't add: ${b.key} already waits on ${a.key}.`);
    expect(loop.body.issues).toEqual([{ path: 'addBlockers', message: loop.body.detail }]);
    expect(loop.body.loop).toEqual({ task: a.key, blocker: b.key });

    const top = await newTask({ title: 'Top' });
    const sub = await newTask({ title: 'Sub', parent: top.key });
    expectProblem(
      await call('POST', '/api/v1/tasks', {
        auth: session(),
        body: { project, title: 'Deep', parent: sub.key },
      }),
      409,
      'SUBTASK_DEPTH',
    );
    const pay = await call('GET', '/api/v1/tasks?project=PAY&limit=1', { auth: session() });
    expectProblem(
      await call('PATCH', `/api/v1/tasks/${a.key}`, {
        auth: session(),
        body: { addBlockers: [pay.body.items[0].key] },
      }),
      422,
      'NOT_SAME_PROJECT',
    );
    expectProblem(
      await call('PATCH', `/api/v1/tasks/${a.key}`, {
        auth: session(),
        body: { labels: ['x'], addLabels: ['y'] },
      }),
      400,
      'BAD_REQUEST',
    );
  });

  it('filters and sorts lists from the query string, with cursors', async () => {
    await newTask({ title: 'Due early', dueDate: '2020-01-01', labels: ['filters'] });
    await newTask({ title: 'Due late', dueDate: '2099-01-01', labels: ['filters'] });
    const labels = await call('GET', `/api/v1/projects/${project}/labels`, { auth: session() });
    const filters = labels.body.items.find((label: { name: string }) => label.name === 'filters');
    expect(filters).toMatchObject({ usageCount: 2, source: 'app' });

    const byLabel = await call('GET', `/api/v1/tasks?project=${project}&label=${filters.id}&sort=due`, {
      auth: session(),
    });
    expect(byLabel.body.items.map((item: { title: string }) => item.title)).toEqual([
      'Due early',
      'Due late',
    ]);
    const overdue = await call('GET', `/api/v1/tasks?project=${project}&due=overdue`, { auth: session() });
    expect(overdue.body.items.map((item: { title: string }) => item.title)).toEqual(['Due early']);
    const blocked = await call('GET', `/api/v1/tasks?project=${project}&blocked=true&topLevel=true`, {
      auth: session(),
    });
    expect(
      blocked.body.items.every(
        (item: { blocked: boolean; parentKey: string | null }) => item.blocked && !item.parentKey,
      ),
    ).toBe(true);
    expectProblem(
      await call('GET', `/api/v1/tasks?project=${project}&blocked=yes`, { auth: session() }),
      400,
      'BAD_REQUEST',
    );

    const all = await call('GET', `/api/v1/tasks?project=${project}&sort=created&limit=200`, {
      auth: session(),
    });
    const seen: string[] = [];
    let cursor: string | null = null;
    do {
      const query = `/api/v1/tasks?project=${project}&sort=created&limit=3${cursor ? `&cursor=${encodeURIComponent(cursor)}` : ''}`;
      const page = await call('GET', query, { auth: session() });
      expect(page.status).toBe(200);
      seen.push(...page.body.items.map((item: { key: string }) => item.key));
      cursor = page.body.nextCursor;
    } while (cursor);
    expect(seen).toEqual(all.body.items.map((item: { key: string }) => item.key));
  });

  it('filters by several assignees, milestones and cycles from the query string, with none', async () => {
    await newTask({ title: 'Many: mine', assignee: 'me' });
    await newTask({ title: 'Many: agent', assignee: agentId });
    await newTask({ title: 'Many: nobody' });
    const titles = async (query: string) => {
      const result = await call('GET', `/api/v1/tasks?project=${project}&q=Many&limit=200&${query}`, {
        auth: session(),
      });
      expect(result.status, JSON.stringify(result.body)).toBe(200);
      return result.body.items.map((item: { title: string }) => item.title).sort();
    };
    await expect(titles('assignee=none')).resolves.toEqual(['Many: nobody']);
    await expect(titles('assignee=me&assignee=none')).resolves.toEqual(['Many: mine', 'Many: nobody']);
    await expect(titles(`assignee[]=agents&assignee[]=none`)).resolves.toEqual([
      'Many: agent',
      'Many: nobody',
    ]);
    await expect(titles('milestone=none&cycle=none&cycle=current')).resolves.toEqual([
      'Many: agent',
      'Many: mine',
      'Many: nobody',
    ]);
    const counts = await call('GET', `/api/v1/tasks?project=${project}&q=Many&assignee=me&assignee=agents`, {
      auth: session(),
    });
    expect(counts.body.counts.todo).toBe(2);
    expectProblem(
      await call('GET', `/api/v1/tasks?project=${project}&assignee=me&assignee=ana`, { auth: session() }),
      400,
      'BAD_REQUEST',
    );
  });

  it('changes several tasks at once and refuses read-only keys', async () => {
    const one = await newTask({ title: 'Bulk one' });
    const two = await newTask({ title: 'Bulk two' });
    const result = await call('POST', '/api/v1/tasks/bulk', {
      auth: key('agent'),
      body: { keys: [two.key, one.key], status: 'in_review', addLabels: ['bulk'], dueDate: '2099-12-01' },
    });
    expect(result.status, JSON.stringify(result.body)).toBe(200);
    expect(result.body.items.map((item: { key: string }) => item.key)).toEqual([two.key, one.key]);
    expect(result.body.items[0]).toMatchObject({
      status: 'in_review',
      dueDate: '2099-12-01',
      labels: [{ name: 'bulk' }],
    });
    expectProblem(
      await call('POST', '/api/v1/tasks/bulk', {
        auth: key('adminRead'),
        body: { keys: [one.key], status: 'done' },
      }),
      403,
      'FORBIDDEN',
    );
    expectProblem(
      await call('POST', '/api/v1/tasks/bulk', { auth: session(), body: { keys: [one.key] } }),
      400,
      'BAD_REQUEST',
    );
    expectProblem(
      await call('POST', '/api/v1/tasks/bulk', {
        auth: session(),
        body: { keys: Array.from({ length: 101 }, (_, i) => `${project}-${i + 1}`), status: 'done' },
      }),
      400,
      'BAD_REQUEST',
    );
  });

  it('GET /home: Mine by default, Everyone and Agents on request, with label filters', async () => {
    const review = await newTask({
      title: 'Home review',
      status: 'in_review',
      assignee: 'me',
      labels: ['home'],
    });
    const overdue = await newTask({ title: 'Home overdue', assignee: 'me', dueDate: '2020-02-02' });
    const mine = await call('GET', '/api/v1/home', { auth: session() });
    expect(mine.status, JSON.stringify(mine.body)).toBe(200);
    expect(mine.body).toMatchObject({ tab: 'mine', generatedAt: expect.any(String), agents: [] });
    expect(mine.body.groups.map((group: { key: string }) => group.key)).toEqual([
      'review',
      'mergedOpen',
      'checkAgain',
      'mentions',
      'blocked',
      'overdue',
      'assigned',
    ]);
    const keysOf = (body: { groups: { key: string; items: { task: { key: string } }[] }[] }, group: string) =>
      body.groups.find((g) => g.key === group)?.items.map((item) => item.task.key) ?? [];
    expect(keysOf(mine.body, 'review')).toContain(review.key);
    expect(keysOf(mine.body, 'overdue')).toContain(overdue.key);

    const filtered = await call('GET', '/api/v1/home?label=HOME', { auth: session() });
    expect(filtered.status).toBe(200);
    expect(
      filtered.body.groups.flatMap((g: { items: { task: { key: string } }[] }) =>
        g.items.map((i) => i.task.key),
      ),
    ).toEqual([review.key]);

    const everyone = await call('GET', '/api/v1/home?tab=everyone', { auth: key('agent') });
    expect(everyone.status).toBe(200);
    expect(everyone.body.groups.map((group: { key: string }) => group.key)).toEqual([
      'review',
      'mergedOpen',
      'blocked',
      'overdue',
      'dueThisWeek',
    ]);
    const agents = await call('GET', '/api/v1/home?tab=agents', { auth: session() });
    expect(agents.status).toBe(200);
    expect(agents.body.agents.map((card: { agent: { id: string } }) => card.agent.id)).toContain(agentId);

    expectProblem(await call('GET', '/api/v1/home?tab=nope', { auth: session() }), 400, 'BAD_REQUEST');
    expectProblem(await call('GET', '/api/v1/home'), 401, 'UNAUTHORIZED');
  });

  it('GET /home/counts: the Mine count the sidebar shows', async () => {
    const counts = await call('GET', '/api/v1/home/counts', { auth: session() });
    expect(counts.status, JSON.stringify(counts.body)).toBe(200);
    const { review, mentions, blocked, overdue, total } = counts.body;
    expect(total).toBe(review + mentions + blocked + overdue);
    expect(review).toBeGreaterThan(0);
    const mine = await call('GET', '/api/v1/home', { auth: session() });
    expect(mine.body.counts.mine).toBe(total);
    expectProblem(await call('GET', '/api/v1/home/counts'), 401, 'UNAUTHORIZED');
  });

  it('manages labels: create, clash, rename, recolour, delete, and locked Backlog.md names', async () => {
    const created = await call('POST', `/api/v1/projects/${project}/labels`, {
      auth: session(),
      body: { name: 'Docs' },
    });
    expect(created.status).toBe(201);
    expect(created.body).toMatchObject({
      name: 'Docs',
      source: 'app',
      usageCount: 0,
      color: expect.any(Number),
    });
    expectProblem(
      await call('POST', `/api/v1/projects/${project}/labels`, { auth: session(), body: { name: 'docs' } }),
      409,
      'LABEL_EXISTS',
    );
    const renamed = await call('PATCH', `/api/v1/projects/${project}/labels/${created.body.id}`, {
      auth: session(),
      body: { name: 'Guides', color: 9 },
    });
    expect(renamed.body).toMatchObject({ name: 'Guides', color: 9 });
    expectProblem(
      await call('POST', `/api/v1/projects/${project}/labels`, {
        auth: key('adminRead'),
        body: { name: 'ro' },
      }),
      403,
      'FORBIDDEN',
    );
    const deleted = await call('DELETE', `/api/v1/projects/${project}/labels/${created.body.id}`, {
      auth: session(),
    });
    expect(deleted.status).toBe(204);
    expectProblem(
      await call('DELETE', `/api/v1/projects/${project}/labels/${created.body.id}`, { auth: session() }),
      404,
      'NOT_FOUND',
    );

    // A label read from Backlog.md files keeps its name.
    const row = await projectRow(database.db, admin.workspaceId, project);
    const mirrored = await createLabelRow(database.db, scopeOf(row), {
      name: 'from-file',
      color: 2,
      source: 'backlog',
    });
    const path = `/api/v1/projects/${project}/labels/${mirrored.id}`;
    expectProblem(
      await call('PATCH', path, { auth: session(), body: { name: 'renamed' } }),
      409,
      'LABEL_MIRRORED',
    );
    expectProblem(await call('DELETE', path, { auth: session() }), 409, 'LABEL_MIRRORED');
    expect((await call('PATCH', path, { auth: session(), body: { color: 4 } })).body).toMatchObject({
      name: 'from-file',
      color: 4,
      source: 'backlog',
    });
  });
});
