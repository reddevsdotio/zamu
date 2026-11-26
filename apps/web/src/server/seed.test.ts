// The dev seed with its second workspace, through /api/v1 against a throwaway database: each
// workspace has its own PAY and its own claude-dev, every key stays in its workspace, the admin
// still lands on the first workspace, and a second run adds keys without duplicating anything.
// With pullRequests, PAY has requests in every state, archived tasks and check-again days.
import { createAuth } from '@zamu/auth';
import type { CoreContext } from '@zamu/core';
import { createTestDatabase, type TestDatabase } from '@zamu/db/test';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { createApiFetchHandler } from './api/index';
import { type SeedResult, seedDevData } from './seed';

const ORIGIN = 'http://localhost:3000';
const SECRET = 'test-secret-test-secret-test-secret-0123';

let database: TestDatabase;
let core: CoreContext;
let handle: (request: Request) => Promise<Response>;
let first: SeedResult;
let again: SeedResult;

async function get(path: string, key: string, headers: Record<string, string> = {}) {
  const response = await handle(
    new Request(`${ORIGIN}${path}`, { headers: { authorization: `Bearer ${key}`, ...headers } }),
  );
  // biome-ignore lint/suspicious/noExplicitAny: response bodies are checked field by field
  const body: any = await response.json();
  return { status: response.status, body };
}

beforeAll(async () => {
  database = await createTestDatabase({ prefix: 'pm_web_seed_two' });
  database.pool.on('error', () => {});
  core = {
    db: database.db,
    auth: createAuth({ db: database.db, secret: SECRET, baseUrl: ORIGIN }),
    publicUrl: ORIGIN,
  };
  handle = createApiFetchHandler(core);
  const options = { planning: true, dashboard: true, secondWorkspace: true, pullRequests: true };
  first = await seedDevData(core, options);
  again = await seedDevData(core, options);
});

afterAll(async () => {
  await database?.drop();
});

describe('dev seed with a second workspace', () => {
  it('creates Globex with its own PAY and its own claude-dev', () => {
    expect(first.workspace).toMatchObject({ name: 'Reddevs', slug: 'reddevs' });
    expect(first.second).toMatchObject({
      workspace: { name: 'Globex', slug: 'globex' },
      created: true,
      agent: { name: 'claude-dev' },
      createdProjects: [{ key: 'PAY', tasks: 5 }],
    });
    expect(first.second?.agent.id).not.toBe(first.agent.id);
  });

  it('keeps every key in its own workspace', async () => {
    const second = first.second as NonNullable<SeedResult['second']>;
    const firstMe = await get('/api/v1/me', first.agentKey);
    const secondMe = await get('/api/v1/me', second.agentKey);
    expect(firstMe.body.workspace).toMatchObject({ slug: 'reddevs' });
    expect(secondMe.body.workspace).toMatchObject({ slug: 'globex' });

    const firstTask = await get('/api/v1/tasks/PAY-1', first.adminKey);
    const secondTask = await get('/api/v1/tasks/PAY-1', second.adminKey);
    expect(firstTask.body.title).toBe('Remove legacy v0 checkout routes');
    expect(secondTask.body.title).toBe('Holiday pay rounds down for part-time staff');

    const names = async (key: string) =>
      (await get('/api/v1/projects', key)).body.items.map((p: { key: string; name: string }) => p.name);
    expect(await names(first.adminKey)).toEqual(expect.arrayContaining(['Payments', 'Web app']));
    expect(await names(second.adminKey)).toEqual(['Payroll']);

    const mismatch = await get('/api/v1/me', second.adminKey, { 'x-zamu-workspace': 'reddevs' });
    expect(mismatch.status).toBe(403);
    expect(mismatch.body.code).toBe('WORKSPACE_MISMATCH');
  });

  it('leaves the first workspace as the one the admin lands on', async () => {
    const row = await database.db.query.user.findFirst({
      columns: { lastWorkspaceId: true },
      where: { id: first.admin.id },
    });
    expect(row?.lastWorkspaceId).toBe(first.workspaceId);
  });

  it('runs again without duplicating workspaces, projects or agents', async () => {
    expect(again.bootstrapped).toBe(false);
    expect(again.createdProjects).toEqual([]);
    expect(again.agent.id).toBe(first.agent.id);
    expect(again.second).toMatchObject({
      workspace: { id: first.second?.workspace.id },
      created: false,
      agent: { id: first.second?.agent.id },
      createdProjects: [],
    });
    expect(again.second?.agentKey).not.toBe(first.second?.agentKey);
    const organizations = await database.db.query.organization.findMany({ columns: { slug: true } });
    expect(organizations.map((o) => o.slug).sort()).toEqual(['globex', 'reddevs']);
    const tasks = await get('/api/v1/tasks?project=PAY', again.second?.adminKey as string);
    expect(tasks.body.items).toHaveLength(5);
  });
});

describe('dev seed with pull requests, archive and check again', () => {
  // PAY-12 onward, in the order of REQUEST_TASKS in seed.ts.
  const keys = {
    refundCap: 'PAY-12',
    payoutTimeout: 'PAY-13',
    payoutsHang: 'PAY-14',
    webhookWorker: 'PAY-15',
    statementFees: 'PAY-16',
    fxCache: 'PAY-17',
    currencyColumn: 'PAY-18',
    secondProcessor: 'PAY-19',
    rotateSecret: 'PAY-20',
    sftpHost: 'PAY-21',
    payoutTotals: 'PAY-22',
  };
  const task = async (key: string) => (await get(`/api/v1/tasks/${key}`, first.adminKey)).body;
  const requests = (body: { pullRequests: { number: number; state: string; how: string }[] }) =>
    body.pullRequests.map((pr) => ({ number: pr.number, state: pr.state, how: pr.how }));

  it('counts the added tasks in PAY', () => {
    expect(first.createdProjects).toEqual(
      expect.arrayContaining([
        { key: 'PAY', tasks: 22 },
        { key: 'WEB', tasks: 4 },
      ]),
    );
  });

  it('links PAY to its repository, checked and with close on merge', async () => {
    const { status, body } = await get('/api/v1/projects/PAY/repository', first.adminKey);
    expect(status).toBe(200);
    expect(body).toMatchObject({
      repository: 'https://github.com/northwind/payments',
      provider: 'github',
      connection: null,
      defaultBranch: 'main',
      closeOnMerge: true,
      mirrored: false,
      sync: { lastAt: expect.any(String), error: null },
    });
  });

  it('moves tasks through a merge, leaving one Done with open criteria', async () => {
    const merged = await task(keys.refundCap);
    expect(merged).toMatchObject({
      status: 'done',
      workBranch: 'claude/pay-refund-cap',
      mergedOpen: { openCriteria: 2, openDoneItems: 0 },
    });
    expect(requests(merged)).toEqual([{ number: 45, state: 'merged', how: 'branch' }]);
    const fees = await task(keys.statementFees);
    expect(fees).toMatchObject({ status: 'done', mergedOpen: null });
    expect(requests(fees)).toEqual([{ number: 46, state: 'merged', how: 'description' }]);
  });

  it('links by branch, by description and by hand, and moves only for open requests', async () => {
    const timeout = await task(keys.payoutTimeout);
    expect(timeout.status).toBe('in_review');
    expect(requests(timeout)).toEqual([{ number: 47, state: 'open', how: 'branch' }]);
    const hang = await task(keys.payoutsHang);
    expect(hang.status).toBe('in_review');
    expect(requests(hang)).toEqual([{ number: 47, state: 'open', how: 'description' }]);
    const draft = await task(keys.webhookWorker);
    expect(draft.status).toBe('in_progress');
    expect(requests(draft)).toEqual([{ number: 48, state: 'draft', how: 'branch' }]);
    const closed = await task(keys.fxCache);
    expect(closed.status).toBe('todo');
    expect(requests(closed)).toEqual([{ number: 44, state: 'closed', how: 'hand' }]);
  });

  it('names the host on the moves in history', async () => {
    const { body } = await get(`/api/v1/tasks/${keys.refundCap}/activity`, first.adminKey);
    const moves = body.items.filter(
      (entry: { changes: { field: string }[] }) => entry.changes[0]?.field === 'status',
    );
    expect(moves.map((entry: { cause: { event: string } | null }) => entry.cause?.event)).toEqual(
      expect.arrayContaining(['opened', 'merged']),
    );
    expect(moves.at(-1) ?? moves[0]).toMatchObject({ actor: null, system: { kind: 'git' } });
  });

  it('archives by hand and by the nightly job, out of the default list', async () => {
    const list = await get('/api/v1/tasks?project=PAY&archived=only&limit=50', first.adminKey);
    expect(list.body.items.map((item: { key: string }) => item.key).sort()).toEqual(
      [keys.currencyColumn, keys.rotateSecret, keys.secondProcessor].sort(),
    );
    const all = await get('/api/v1/tasks?project=PAY&limit=50', first.adminKey);
    expect(all.body.items.map((item: { key: string }) => item.key)).not.toContain(keys.rotateSecret);

    const byJob = await get(`/api/v1/tasks/${keys.rotateSecret}/activity`, first.adminKey);
    expect(byJob.body.items.find((entry: { type: string }) => entry.type === 'task.archived')).toMatchObject({
      actor: null,
      cause: { kind: 'archive', afterDays: 14 },
    });
    expect((await task(keys.currencyColumn)).archivedBy).toMatchObject({ id: first.admin.id });
    expect((await task(keys.secondProcessor)).archivedBy).toMatchObject({ id: first.agent.id });
  });

  it('has tasks waiting and ready to check again, the ready one in Home', async () => {
    const waiting = await get('/api/v1/tasks?project=PAY&checkAgain=waiting', first.adminKey);
    expect(waiting.body.items.map((item: { key: string }) => item.key)).toEqual([keys.sftpHost]);
    const ready = await get('/api/v1/tasks?project=PAY&checkAgain=ready', first.adminKey);
    expect(ready.body.items.map((item: { key: string }) => item.key)).toEqual([keys.payoutTotals]);

    const home = await get('/api/v1/home', first.adminKey);
    const group = (key: string) =>
      home.body.groups
        .find((g: { key: string }) => g.key === key)
        ?.items.map((item: { task: { key: string } }) => item.task.key) ?? [];
    expect(group('checkAgain')).toEqual([keys.payoutTotals]);
    expect(group('mergedOpen')).toEqual([keys.refundCap]);
  });

  it('keeps archiving on for PAY and off for WEB', async () => {
    const projects = (await get('/api/v1/projects', first.adminKey)).body.items as {
      key: string;
      archiveAfterDays: number | null;
    }[];
    expect(projects.find((p) => p.key === 'PAY')?.archiveAfterDays).toBe(14);
    expect(projects.find((p) => p.key === 'WEB')?.archiveAfterDays).toBeNull();
  });
});
