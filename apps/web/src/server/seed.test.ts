// The dev seed with its second workspace, through /api/v1 against a throwaway database: each
// workspace has its own PAY and its own claude-dev, every key stays in its workspace, the admin
// still lands on the first workspace, and a second run adds keys without duplicating anything.
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
  first = await seedDevData(core, { planning: true, dashboard: true, secondWorkspace: true });
  again = await seedDevData(core, { planning: true, dashboard: true, secondWorkspace: true });
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
