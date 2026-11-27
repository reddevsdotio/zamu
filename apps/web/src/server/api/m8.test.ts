// M8 through /api/v1: the milestone plan, the plan link (also on a mirrored milestone), waves
// (add, change, move, remove), putting tasks in waves and gate results, each with who may call it:
// a member's session, an admin's, an agent's write key, a read-only key and a key scoped to
// another project. Then the two refusals: GATE_TASKS_OPEN for a pass with open tasks and
// WAVE_LOCKED for an agent starting a task in a locked wave, against a person's pass-through.
// Fresh data in a throwaway database: the Northwind workspace with a native project, another
// project for the scoped key, and a mirrored project.
import { createAuth } from '@zamu/auth';
import { type CoreContext, createApiKey, createMilestone, createProject, createTask } from '@zamu/core';
import { createMirroredProject, type MirroredProject } from '@zamu/core/testing/backlog';
import {
  addMember,
  createUser,
  createWorld,
  randomWorkspaceSlug,
  type World,
} from '@zamu/core/testing/fixtures';
import { schema } from '@zamu/db';
import { createTestDatabase, type TestDatabase } from '@zamu/db/test';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { createApiFetchHandler } from './index';

const ORIGIN = 'http://localhost:3000';
const SECRET = 'test-secret-test-secret-test-secret-0123';
const PASSWORD = 'correct horse battery';

let database: TestDatabase;
let core: CoreContext;
let handle: (request: Request) => Promise<Response>;
let world: World;
let slug: string;
/** Native project with milestones. */
let pay: string;
/** The project the scoped key may write. */
let ops: string;
let mirror: MirroredProject;
const cookies = {} as { admin: string; member: string };
const keys = {} as { agent: string; read: string; scoped: string };

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

const admin = (): Auth => ({ cookie: cookies.admin });
const member = (): Auth => ({ cookie: cookies.member });
const agent = (): Auth => ({ key: keys.agent });
const readOnly = (): Auth => ({ key: keys.read });
const scoped = (): Auth => ({ key: keys.scoped });

function expectProblem(result: Awaited<ReturnType<typeof call>>, status: number, code: string): void {
  expect(result.status, JSON.stringify(result.body)).toBe(status);
  expect(result.body).toMatchObject({ status, code, type: 'about:blank' });
  expect(result.body.requestId).toBe(result.headers.get('x-request-id'));
}

function expectOk(result: Awaited<ReturnType<typeof call>>, status = 200): void {
  expect(result.status, JSON.stringify(result.body)).toBe(status);
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

/** A milestone of PAY with waves named `names`, through the API as the admin. */
async function milestoneWithWaves(...names: string[]) {
  const milestone = await createMilestone(core, world.ownerActor, {
    project: pay,
    name: `Payouts ${crypto.randomUUID().slice(0, 6)}`,
  });
  const waves: { id: string; number: number }[] = [];
  for (const name of names) {
    const created = await call('POST', `/api/v1/milestones/${milestone.id}/waves`, {
      auth: admin(),
      body: { name, gateDescription: `Checks for ${name}` },
    });
    expectOk(created, 201);
    waves.push(created.body);
  }
  return { milestone, waves };
}

beforeAll(async () => {
  database = await createTestDatabase({ prefix: 'pm_web_m8' });
  database.pool.on('error', () => {});
  const auth = createAuth({ db: database.db, secret: SECRET, baseUrl: ORIGIN });
  core = { db: database.db, auth, publicUrl: ORIGIN, timeZone: 'UTC' };
  handle = createApiFetchHandler(core);

  slug = randomWorkspaceSlug('northwind');
  world = await createWorld(database.db, 'Northwind', { slug });
  const adminUser = await createUser(database.db, { name: 'Ines Admin' });
  await addMember(database.db, world.workspaceId, { id: adminUser.id, kind: 'person' }, 'admin');
  for (const user of [world.member, adminUser]) await withPassword(user.id);
  cookies.admin = await signIn(adminUser.email);
  cookies.member = await signIn(world.member.email);

  pay = (await createProject(core, world.ownerActor, { key: 'PAY', name: 'Payments' })).key;
  const opsProject = await createProject(core, world.ownerActor, { key: 'OPS', name: 'Operations' });
  ops = opsProject.key;
  mirror = await createMirroredProject(database.db, world, { key: 'BACK' });

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
  keys.scoped = (
    await createApiKey(core, world.ownerActor, {
      name: 'ops only',
      ownerId: world.agent.id,
      scope: { projects: [opsProject.id], access: 'write' },
    })
  ).key;
}, 60_000);

afterAll(async () => {
  await database?.drop();
});

describe('M8: the plan and the plan link', () => {
  it('reads the plan and sets the plan link, with the wave summary on milestone reads', async () => {
    const { milestone, waves } = await milestoneWithWaves('Ledger', 'Screens');
    const linked = await call('PATCH', `/api/v1/milestones/${milestone.id}`, {
      auth: member(),
      body: { planUrl: 'https://wiki.northwind.dev/plans/payouts-v2' },
    });
    expectOk(linked);
    expect(linked.body).toMatchObject({
      planUrl: 'https://wiki.northwind.dev/plans/payouts-v2',
      waves: { count: 2, current: 1, currentState: 'open', allPassed: false },
    });

    for (const auth of [member(), admin(), agent(), readOnly()]) {
      const plan = await call('GET', `/api/v1/milestones/${milestone.id}/plan`, { auth });
      expectOk(plan);
      expect(plan.body).toMatchObject({
        planUrl: 'https://wiki.northwind.dev/plans/payouts-v2',
        milestone: { id: milestone.id, waves: { count: 2 } },
        waves: [
          { id: waves[0]?.id, number: 1, current: true, locked: false, gate: { state: 'open' } },
          { id: waves[1]?.id, number: 2, locked: true, lockedUntil: { number: 1, name: 'Ledger' } },
        ],
        notInWave: [],
      });
    }
    expectProblem(
      await call('GET', `/api/v1/milestones/${milestone.id}/plan`, { auth: scoped() }),
      403,
      'FORBIDDEN',
    );
    expectProblem(
      await call('GET', `/api/v1/milestones/${crypto.randomUUID()}/plan`, { auth: member() }),
      404,
      'NOT_FOUND',
    );

    const list = await call('GET', `/api/v1/projects/${pay}/milestones`, { auth: member() });
    expect(list.body.items.find((item: { id: string }) => item.id === milestone.id)).toMatchObject({
      planUrl: 'https://wiki.northwind.dev/plans/payouts-v2',
      waves: { count: 2, current: 1 },
    });
    const one = await call('GET', `/api/v1/milestones/${milestone.id}`, { auth: agent() });
    expect(one.body).toMatchObject({ planUrl: expect.any(String), waves: { count: 2 } });

    const cleared = await call('PATCH', `/api/v1/milestones/${milestone.id}`, {
      auth: agent(),
      body: { planUrl: null },
    });
    expect(cleared.body.planUrl).toBeNull();
    expectProblem(
      await call('PATCH', `/api/v1/milestones/${milestone.id}`, { auth: readOnly(), body: { planUrl: 'x' } }),
      403,
      'FORBIDDEN',
    );
    expectProblem(
      await call('PATCH', `/api/v1/milestones/${milestone.id}`, { auth: member(), body: { planUrl: '   ' } }),
      400,
      'BAD_REQUEST',
    );
  });

  it('takes a plan link on a mirrored milestone, which still refuses its Backlog.md fields', async () => {
    const id = mirror.milestone.id;
    const linked = await call('PATCH', `/api/v1/milestones/${id}`, {
      auth: agent(),
      body: { planUrl: 'plans/webhooks-v2.html' },
    });
    expectOk(linked);
    expect(linked.body.planUrl).toBe('plans/webhooks-v2.html');
    expectProblem(
      await call('PATCH', `/api/v1/milestones/${id}`, { auth: agent(), body: { name: 'Renamed' } }),
      409,
      'MILESTONE_MIRRORED',
    );
    const wave = await call('POST', `/api/v1/milestones/${id}/waves`, {
      auth: agent(),
      body: { name: 'Delivery' },
    });
    expectOk(wave, 201);
  });
});

describe('M8: waves', () => {
  it('adds, changes, moves and removes waves, with permissions', async () => {
    const { milestone, waves } = await milestoneWithWaves('Ledger', 'Screens');
    const added = await call('POST', `/api/v1/milestones/${milestone.id}/waves`, {
      auth: agent(),
      body: { name: 'Groundwork', position: 1 },
    });
    expectOk(added, 201);
    expect(added.body).toMatchObject({
      number: 1,
      name: 'Groundwork',
      current: true,
      gate: { description: null },
    });
    expectProblem(
      await call('POST', `/api/v1/milestones/${milestone.id}/waves`, {
        auth: member(),
        body: { name: 'ledger' },
      }),
      409,
      'CONFLICT',
    );
    expectProblem(
      await call('POST', `/api/v1/milestones/${milestone.id}/waves`, {
        auth: readOnly(),
        body: { name: 'No' },
      }),
      403,
      'FORBIDDEN',
    );
    expectProblem(
      await call('POST', `/api/v1/milestones/${milestone.id}/waves`, {
        auth: scoped(),
        body: { name: 'No' },
      }),
      403,
      'FORBIDDEN',
    );
    expectProblem(
      await call('POST', `/api/v1/milestones/${milestone.id}/waves`, { auth: member(), body: { name: '' } }),
      400,
      'BAD_REQUEST',
    );

    const moved = await call('PATCH', `/api/v1/waves/${waves[1]?.id}`, {
      auth: member(),
      body: { position: 1, name: 'Payout screens', gateDescription: 'Light and dark' },
    });
    expectOk(moved);
    expect(moved.body).toMatchObject({
      number: 1,
      name: 'Payout screens',
      gate: { description: 'Light and dark' },
    });
    expectProblem(
      await call('PATCH', `/api/v1/waves/${waves[1]?.id}`, { auth: readOnly(), body: { name: 'x' } }),
      403,
      'FORBIDDEN',
    );
    expectProblem(
      await call('PATCH', `/api/v1/waves/${waves[1]?.id}`, { auth: scoped(), body: { name: 'x' } }),
      403,
      'FORBIDDEN',
    );
    expectProblem(
      await call('PATCH', `/api/v1/waves/${crypto.randomUUID()}`, { auth: admin(), body: { name: 'x' } }),
      404,
      'NOT_FOUND',
    );

    expectProblem(
      await call('DELETE', `/api/v1/waves/${waves[0]?.id}`, { auth: readOnly() }),
      403,
      'FORBIDDEN',
    );
    expectProblem(
      await call('DELETE', `/api/v1/waves/${waves[0]?.id}`, { auth: scoped() }),
      403,
      'FORBIDDEN',
    );
    const removed = await call('DELETE', `/api/v1/waves/${waves[0]?.id}`, { auth: agent() });
    expect(removed.status).toBe(204);
    const plan = await call('GET', `/api/v1/milestones/${milestone.id}/plan`, { auth: member() });
    expect(plan.body.waves.map((wave: { number: number; name: string }) => [wave.number, wave.name])).toEqual(
      [
        [1, 'Payout screens'],
        [2, 'Groundwork'],
      ],
    );
    expectProblem(await call('DELETE', `/api/v1/waves/${waves[0]?.id}`, { auth: admin() }), 404, 'NOT_FOUND');
  });

  it('puts tasks in a wave and takes them out, all or nothing', async () => {
    const { milestone, waves } = await milestoneWithWaves('Ledger');
    const first = (await createTask(core, world.ownerActor, { project: pay, title: 'Ledger table' })).key;
    const second = (await createTask(core, world.ownerActor, { project: pay, title: 'Post entries' })).key;
    const outside = (await createTask(core, world.ownerActor, { project: ops, title: 'Elsewhere' })).key;
    const path = `/api/v1/milestones/${milestone.id}/wave-tasks`;

    const put = await call('POST', path, {
      auth: member(),
      body: { wave: waves[0]?.id, keys: [first, second] },
    });
    expectOk(put);
    expect(put.body.waves[0].tasks.map((task: { key: string }) => task.key).sort()).toEqual(
      [first, second].sort(),
    );
    const task = await call('GET', `/api/v1/tasks/${first}`, { auth: agent() });
    expect(task.body).toMatchObject({
      milestone: { id: milestone.id },
      wave: { id: waves[0]?.id, number: 1 },
    });
    const rows = await call('GET', `/api/v1/tasks?project=${pay}`, { auth: agent() });
    const row = rows.body.items.find((item: { key: string }) => item.key === first);
    expect(row.wave).toMatchObject({ id: waves[0]?.id, locked: false });

    const refused = await call('POST', path, {
      auth: agent(),
      body: { wave: waves[0]?.id, keys: [outside] },
    });
    expectProblem(refused, 422, 'UNPROCESSABLE_CONTENT');
    expectProblem(
      await call('POST', path, { auth: readOnly(), body: { wave: null, keys: [first] } }),
      403,
      'FORBIDDEN',
    );
    expectProblem(
      await call('POST', path, { auth: scoped(), body: { wave: null, keys: [first] } }),
      403,
      'FORBIDDEN',
    );

    const out = await call('POST', path, { auth: agent(), body: { wave: null, keys: [second] } });
    expectOk(out);
    expect(out.body.notInWave.map((t: { key: string }) => t.key)).toEqual([second]);
  });
});

describe('M8: gate results', () => {
  it('refuses a pass with open tasks (GATE_TASKS_OPEN), fails at any time, passes once they are done', async () => {
    const { milestone, waves } = await milestoneWithWaves('Ledger', 'Screens');
    const key = (await createTask(core, world.ownerActor, { project: pay, title: 'Ledger table' })).key;
    await call('POST', `/api/v1/milestones/${milestone.id}/wave-tasks`, {
      auth: member(),
      body: { wave: waves[0]?.id, keys: [key] },
    });
    const path = `/api/v1/waves/${waves[0]?.id}/gate`;

    const open = await call('POST', path, { auth: agent(), body: { state: 'passed', note: 'All green' } });
    expectProblem(open, 409, 'GATE_TASKS_OPEN');
    expect(open.body.openKeys).toEqual([key]);
    expect(open.body.detail).toContain(`W1 · Ledger has 1 open task: ${key}`);

    expectProblem(
      await call('POST', path, { auth: readOnly(), body: { state: 'failed', note: 'x' } }),
      403,
      'FORBIDDEN',
    );
    expectProblem(
      await call('POST', path, { auth: scoped(), body: { state: 'failed', note: 'x' } }),
      403,
      'FORBIDDEN',
    );
    expectProblem(
      await call('POST', path, { auth: member(), body: { state: 'failed', note: '  ' } }),
      400,
      'BAD_REQUEST',
    );

    const failed = await call('POST', path, {
      auth: agent(),
      body: { state: 'failed', note: 'Entries do not balance.' },
    });
    expectOk(failed);
    expect(failed.body.gate).toMatchObject({
      state: 'failed',
      result: {
        state: 'failed',
        note: 'Entries do not balance.',
        recordedBy: { id: world.agent.id, kind: 'agent' },
        onBehalfOf: { id: world.member.id },
      },
    });

    await call('PATCH', `/api/v1/tasks/${key}`, { auth: member(), body: { status: 'done' } });
    const passed = await call('POST', path, {
      auth: admin(),
      body: { state: 'passed', note: 'Balanced now.' },
    });
    expectOk(passed);
    expect(passed.body).toMatchObject({
      gate: { state: 'passed', result: { onBehalfOf: null } },
      canPass: true,
    });
    const plan = await call('GET', `/api/v1/milestones/${milestone.id}/plan`, { auth: member() });
    expect(plan.body.waves[1]).toMatchObject({ current: true, locked: false });
  });
});

describe('M8: WAVE_LOCKED', () => {
  it('refuses an agent starting a task in a locked wave and lets a person start it', async () => {
    const { milestone, waves } = await milestoneWithWaves('Ledger', 'Screens');
    const key = (await createTask(core, world.ownerActor, { project: pay, title: 'Failed payout banner' }))
      .key;
    await call('POST', `/api/v1/milestones/${milestone.id}/wave-tasks`, {
      auth: member(),
      body: { wave: waves[1]?.id, keys: [key] },
    });

    const refused = await call('PATCH', `/api/v1/tasks/${key}`, {
      auth: agent(),
      body: { status: 'in_progress' },
    });
    expectProblem(refused, 409, 'WAVE_LOCKED');
    expect(refused.body).toMatchObject({
      waveLock: { task: key, wave: { number: 2, name: 'Screens' }, waitsFor: { number: 1, name: 'Ledger' } },
      hint: `zamu milestones show ${JSON.stringify(milestone.name)} --project ${pay}`,
    });
    expect(refused.body.detail).toContain(
      `${key} is in W2 · Screens, which is locked until W1 · Ledger passes.`,
    );

    const bulk = await call('POST', '/api/v1/tasks/bulk', {
      auth: agent(),
      body: { keys: [key], status: 'in_review' },
    });
    expectProblem(bulk, 409, 'WAVE_LOCKED');
    expect(bulk.body.issues).toEqual([{ path: 'keys.0', message: expect.stringContaining(key) }]);

    const created = await call('POST', '/api/v1/tasks', {
      auth: agent(),
      body: { project: pay, title: 'Started', wave: waves[1]?.id, status: 'in_progress' },
    });
    expectProblem(created, 409, 'WAVE_LOCKED');

    const started = await call('PATCH', `/api/v1/tasks/${key}`, {
      auth: member(),
      body: { status: 'in_progress' },
    });
    expectOk(started);
    expect(started.body).toMatchObject({
      status: 'in_progress',
      wave: { id: waves[1]?.id, locked: true, lockedUntil: { number: 1, name: 'Ledger' } },
    });

    // The wave field on PATCH /tasks/{key}: out of the wave.
    const out = await call('PATCH', `/api/v1/tasks/${key}`, { auth: agent(), body: { wave: null } });
    expectOk(out);
    expect(out.body.wave).toBeNull();
  });
});
