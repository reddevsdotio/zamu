// Repository links: made on demand with the connection of call 9, started over when the project's
// repository changes, the settings and who may change them, the webhook secret, Check now, the
// hourly check (first check moves nothing, later ones do, errors stored without the token), the
// poll, and what deleting or failing a connection does to links.
import { schema } from '@zamu/db';
import { GitUnauthorized } from '@zamu/git-providers';
import { eq } from 'drizzle-orm';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { recordingJobQueue, TEST_ENCRYPTION_KEY, TEST_TOKEN } from './backlog/testing';
import { Forbidden, Invalid, NotFound } from './errors';
import { deleteConnection, markConnectionStatus } from './git-connections';
import { REPOSITORY_SYNC } from './jobs';
import { createProject, updateProject } from './projects';
import type { PullRequestContext } from './pull-requests';
import {
  ensureRepositoryLink,
  getRepositorySettings,
  nextRepositoryCheckAt,
  pollRepositories,
  providerForHost,
  repositoryHost,
  sameHost,
  syncRepository,
  syncRepositoryNow,
  updateRepositorySettings,
} from './repository';
import { encryptSecret } from './secrets';
import { createTask } from './tasks';
import { createGitConnectionRow, createMirroredProject } from './testing/backlog';
import {
  createPullRequestRow,
  createWorld,
  projectRow,
  randomProjectKey,
  scopeOf,
  type TestContext,
  testContext,
  type World,
} from './testing/fixtures';
import { FakeRequestHost, fakeRequestFactory, requestInfo } from './testing/requests';

const { pullRequest, repositoryLink, task } = schema;

let base: TestContext;
let host: FakeRequestHost;
let clock: Date;
let ctx: PullRequestContext & { jobs: ReturnType<typeof recordingJobQueue> };
let world: World;

beforeAll(async () => {
  base = testContext();
  host = new FakeRequestHost('github', 'github.com');
  clock = new Date('2040-01-10T10:00:00.000Z');
  ctx = {
    ...base,
    encryptionKey: TEST_ENCRYPTION_KEY,
    providerFactory: fakeRequestFactory(host),
    jobs: recordingJobQueue(),
    now: () => clock,
  };
  world = await createWorld(base.db, 'Northwind');
});
afterAll(async () => {
  await base?.close();
});

async function rejection<T extends Error>(
  promise: Promise<unknown>,
  type: abstract new (...args: never[]) => T,
): Promise<T> {
  const error = await promise.then(
    () => null,
    (caught: unknown) => caught,
  );
  expect(error).toBeInstanceOf(type);
  return error as T;
}

async function newProject(repository: string | null = null) {
  const key = randomProjectKey();
  await createProject(ctx, world.ownerActor, {
    key,
    name: `Payments ${key}`,
    ...(repository ? { repository } : {}),
  });
  return projectRow(base.db, world.workspaceId, key);
}

async function linkOf(projectId: string) {
  const [row] = await base.db.select().from(repositoryLink).where(eq(repositoryLink.projectId, projectId));
  return row ?? null;
}

describe('helpers', () => {
  it('reads hosts and kinds', () => {
    expect(repositoryHost('http://localhost:3300/o/r', { host: 'localhost' } as never)).toBe(
      'localhost:3300',
    );
    expect(repositoryHost('git@gitlab.com:o/r.git', { host: 'gitlab.com' } as never)).toBe('gitlab.com');
    expect(sameHost('localhost:3300', 'localhost')).toBe(true);
    expect(sameHost('gitlab.example.com', 'gitlab.com')).toBe(false);
    expect(providerForHost('github.com')).toBe('github');
    expect(providerForHost('gitlab.example.com')).toBe('gitlab');
    expect(providerForHost('codeberg.org')).toBe('gitea');
    expect(providerForHost('git.example.com')).toBeNull();
    expect(nextRepositoryCheckAt(new Date('2040-01-10T10:50:00Z')).toISOString()).toBe(
      '2040-01-10T11:45:00.000Z',
    );
    expect(nextRepositoryCheckAt(new Date('2040-01-10T10:10:00Z')).toISOString()).toBe(
      '2040-01-10T10:45:00.000Z',
    );
  });
});

describe('the link row', () => {
  it('is made on first use with the only working connection for the host', async () => {
    const working = await createGitConnectionRow(base.db, world, {
      host: 'gitea.northwind.test',
      provider: 'gitea',
    });
    await createGitConnectionRow(base.db, world, {
      host: 'gitea.northwind.test',
      provider: 'gitea',
      status: 'rejected',
    });
    const p = await newProject('https://gitea.northwind.test/northwind/ledger');
    expect(await linkOf(p.id)).toBeNull();
    const settings = await getRepositorySettings(ctx, world.memberActor, { project: p.key });
    expect(settings).toMatchObject({
      repository: 'https://gitea.northwind.test/northwind/ledger',
      provider: 'gitea',
      connection: { id: working.id },
      closeOnMerge: true,
      mirrored: false,
      canEdit: false,
      sync: { lastAt: null, error: null, nextAt: '2040-01-10T10:45:00.000Z' },
    });
    const link = await linkOf(p.id);
    expect(settings.webhook).toEqual({
      url: `${base.publicUrl}/api/webhooks/repository/${link?.webhookId}`,
      secretSet: false,
      lastAt: null,
      lastStatus: null,
      coveredByBacklog: false,
    });
    expect(link?.movesFrom).toEqual(clock);

    // Two working connections for one host: none is picked.
    await createGitConnectionRow(base.db, world, { host: 'gitea.northwind.test', provider: 'gitea' });
    const q = await newProject('https://gitea.northwind.test/northwind/other');
    expect((await getRepositorySettings(ctx, world.memberActor, { project: q.key })).connection).toBeNull();
  });

  it('uses the Backlog.md connection of a mirrored project', async () => {
    const mirror = await createMirroredProject(base.db, world);
    const settings = await getRepositorySettings(ctx, world.ownerActor, { project: mirror.key });
    expect(settings.connection?.id).toBe(mirror.connection.id);
  });

  it('describes a project without a repository and makes no row', async () => {
    const p = await newProject();
    const settings = await getRepositorySettings(ctx, world.ownerActor, { project: p.key });
    expect(settings).toMatchObject({ repository: null, webhook: null, connection: null, canEdit: true });
    expect(settings.sync).toEqual({ lastAt: null, error: null, nextAt: null });
    expect(await linkOf(p.id)).toBeNull();
  });

  it('starts over when the repository changes, deleting the old requests', async () => {
    const p = await newProject('https://github.com/northwind/one');
    await getRepositorySettings(ctx, world.ownerActor, { project: p.key });
    const before = await linkOf(p.id);
    await base.db
      .update(repositoryLink)
      .set({ syncedAt: clock, syncError: 'old', defaultBranch: 'trunk', webhookLastStatus: 'ok' })
      .where(eq(repositoryLink.projectId, p.id));
    await createPullRequestRow(base.db, scopeOf(p), { number: 1 });
    clock = new Date('2040-01-10T11:00:00.000Z');
    await updateProject(ctx, world.ownerActor, {
      project: p.key,
      repository: 'https://github.com/northwind/two',
    });
    // The project update resets the link in its own transaction, before anything reads it again.
    expect(await base.db.select().from(pullRequest).where(eq(pullRequest.projectId, p.id))).toEqual([]);
    expect((await linkOf(p.id))?.repositoryKey).toBe('github.com/northwind/two');
    await getRepositorySettings(ctx, world.ownerActor, { project: p.key });
    const after = await linkOf(p.id);
    expect(after).toMatchObject({
      id: before?.id,
      webhookId: before?.webhookId,
      repositoryKey: 'github.com/northwind/two',
      syncedAt: null,
      syncError: null,
      defaultBranch: null,
      webhookLastStatus: null,
      movesFrom: clock,
    });
    expect(await base.db.select().from(pullRequest).where(eq(pullRequest.projectId, p.id))).toEqual([]);
  });
});

describe('settings', () => {
  it('lets owners and admins pick a connection for the host or none, and restarts moves_from', async () => {
    const p = await newProject('https://gitlab.com/northwind/api');
    const gitlab = await createGitConnectionRow(base.db, world, { host: 'gitlab.com', provider: 'gitlab' });
    const github = await createGitConnectionRow(base.db, world, {
      host: 'github.com',
      provider: 'github',
      status: 'rejected',
    });
    await getRepositorySettings(ctx, world.ownerActor, { project: p.key });
    await rejection(
      updateRepositorySettings(ctx, world.memberActor, { project: p.key, connectionId: gitlab.id }),
      Forbidden,
    );
    await rejection(
      updateRepositorySettings(ctx, world.ownerActor, { project: p.key, connectionId: github.id }),
      Invalid,
    );
    await rejection(
      updateRepositorySettings(ctx, world.ownerActor, { project: p.key, connectionId: crypto.randomUUID() }),
      NotFound,
    );
    clock = new Date('2040-01-10T12:00:00.000Z');
    ctx.jobs.clear();
    const updated = await updateRepositorySettings(ctx, world.ownerActor, {
      project: p.key,
      connectionId: gitlab.id,
      closeOnMerge: false,
    });
    expect(updated).toMatchObject({ connection: { id: gitlab.id }, closeOnMerge: false });
    const link = await linkOf(p.id);
    expect(link?.movesFrom).toEqual(clock);
    expect(ctx.jobs.sent).toEqual([
      expect.objectContaining({
        name: REPOSITORY_SYNC,
        data: { linkId: link?.id },
        options: { singletonKey: link?.id },
      }),
    ]);
    const publicRead = await updateRepositorySettings(ctx, world.ownerActor, {
      project: p.key,
      connectionId: null,
    });
    expect(publicRead.connection).toBeNull();
  });

  it('queues a check now for owners and admins', async () => {
    const p = await newProject('https://github.com/northwind/check-now');
    ctx.jobs.clear();
    await rejection(syncRepositoryNow(ctx, world.memberActor, { project: p.key }), Forbidden);
    await syncRepositoryNow(ctx, world.ownerActor, { project: p.key });
    const link = await linkOf(p.id);
    expect(ctx.jobs.sent).toEqual([
      expect.objectContaining({ name: REPOSITORY_SYNC, data: { linkId: link?.id } }),
    ]);
    const none = await newProject();
    await rejection(syncRepositoryNow(ctx, world.ownerActor, { project: none.key }), Error);
  });
});

describe('syncRepository', () => {
  it('moves nothing on the first check, then applies later requests like events', async () => {
    clock = new Date('2040-01-10T10:00:00.000Z');
    const path = `northwind/sync-${crypto.randomUUID().slice(0, 6)}`;
    const p = await newProject(`https://github.com/${path}`);
    const repo = host.repository(path, 'trunk');
    const started = await createTask(ctx, world.memberActor, {
      project: p.key,
      title: 'One',
      status: 'todo',
    });
    await base.db.update(task).set({ workBranch: 'feat/a' }).where(eq(task.id, started.id));
    host.put(
      path,
      requestInfo({ number: 1, headBranch: 'feat/a', updatedAt: '2039-11-01T10:00:00.000Z' }, { path }),
    );
    host.put(
      path,
      requestInfo({ number: 2, state: 'closed', updatedAt: '2039-12-01T10:00:00.000Z' }, { path }),
    );
    host.put(
      path,
      requestInfo(
        { number: 3, state: 'merged', mergedBy: 'tomas', updatedAt: '2040-01-05T10:00:00.000Z' },
        { path },
      ),
    );
    await getRepositorySettings(ctx, world.ownerActor, { project: p.key });
    const link = await linkOf(p.id);

    const first = await syncRepository(ctx, link?.id as string);
    expect(first).toMatchObject({ status: 'synced', read: 2, applied: 2, live: false });
    const stored = await base.db.select().from(pullRequest).where(eq(pullRequest.projectId, p.id));
    expect(stored.map((row) => row.number).sort()).toEqual([1, 3]);
    // The list leaves out who merged #3; the check reads it on its own to learn it.
    expect(stored.find((row) => row.number === 3)?.mergedBy).toBe('tomas');
    const [row] = await base.db.select().from(task).where(eq(task.id, started.id));
    expect(row?.status).toBe('todo');
    expect(await linkOf(p.id)).toMatchObject({
      defaultBranch: 'trunk',
      syncedAt: clock,
      syncCursor: new Date('2040-01-05T10:00:00.000Z'),
      syncError: null,
    });

    // Later: a new request on the branch, into the default branch.
    clock = new Date('2040-01-11T10:00:00.000Z');
    const callsBefore = host.calls.length;
    host.put(
      path,
      requestInfo(
        { number: 4, headBranch: 'feat/a', baseBranch: 'trunk', updatedAt: '2040-01-11T09:00:00.000Z' },
        { path },
      ),
    );
    const second = await syncRepository(ctx, link?.id as string);
    expect(second).toMatchObject({ status: 'synced', live: true });
    const list = host.calls.slice(callsBefore).find((call) => call.method === 'listRequestsUpdatedSince');
    expect(list?.since).toBe('2040-01-05T09:50:00.000Z');
    const [moved] = await base.db.select().from(task).where(eq(task.id, started.id));
    expect(moved?.status).toBe('in_review');
    expect(repo.requests.size).toBe(4);
  });

  it('stores errors without the token and keeps going on the next check', async () => {
    const path = `northwind/err-${crypto.randomUUID().slice(0, 6)}`;
    const p = await newProject(`https://github.com/${path}`);
    host.repository(path);
    await getRepositorySettings(ctx, world.ownerActor, { project: p.key });
    const link = await linkOf(p.id);

    // Public read: the host refuses, so the page asks for a connection.
    host.failWith = new GitUnauthorized('401', { status: 401 });
    const failed = await syncRepository(ctx, link?.id as string);
    expect(failed).toMatchObject({
      status: 'failed',
      error: "Zamu can't read this repository: link a connection.",
    });
    expect((await linkOf(p.id))?.syncError).toBe("Zamu can't read this repository: link a connection.");

    // Through a connection: the token's sentence, never the token.
    const connection = await createGitConnectionRow(base.db, world, {
      host: 'github.com',
      provider: 'github',
      tokenCiphertext: encryptSecret(ctx, TEST_TOKEN),
    });
    await updateRepositorySettings(ctx, world.ownerActor, { project: p.key, connectionId: connection.id });
    host.failWith = new GitUnauthorized('401', { status: 401 });
    const rejected = await syncRepository(ctx, link?.id as string);
    expect(rejected.error).toContain('github.com answered 401');
    expect(rejected.error).not.toContain(TEST_TOKEN);
    expect((ctx.providerFactory as ReturnType<typeof fakeRequestFactory>).built.at(-1)?.token).toBe(
      TEST_TOKEN,
    );

    const ok = await syncRepository(ctx, link?.id as string);
    expect(ok.status).toBe('synced');
    expect((await linkOf(p.id))?.syncError).toBeNull();
  });

  it('skips links whose project lost its repository', async () => {
    const p = await newProject('https://github.com/northwind/gone');
    await getRepositorySettings(ctx, world.ownerActor, { project: p.key });
    const link = await linkOf(p.id);
    await updateProject(ctx, world.ownerActor, { project: p.key, repository: null });
    expect((await syncRepository(ctx, link?.id as string)).status).toBe('skipped');
  });
});

describe('pollRepositories', () => {
  it('makes missing links and queues a check for every project with a repository', async () => {
    const p = await newProject('https://github.com/northwind/polled');
    const none = await newProject();
    ctx.jobs.clear();
    const result = await pollRepositories(ctx, { workspaceIds: [world.workspaceId] });
    expect(result.created).toBeGreaterThanOrEqual(1);
    const link = await linkOf(p.id);
    expect(link).not.toBeNull();
    expect(await linkOf(none.id)).toBeNull();
    expect(ctx.jobs.sent).toContainEqual(
      expect.objectContaining({ name: REPOSITORY_SYNC, data: { linkId: link?.id } }),
    );
  });
});

describe('connections and links', () => {
  it('shows a failed check as the sync error, clears it when the check works, and goes public on delete', async () => {
    const connection = await createGitConnectionRow(base.db, world, {
      host: 'gitlab.com',
      provider: 'gitlab',
    });
    const p = await newProject('https://gitlab.com/northwind/conn');
    await getRepositorySettings(ctx, world.ownerActor, { project: p.key });
    await updateRepositorySettings(ctx, world.ownerActor, { project: p.key, connectionId: connection.id });

    await base.db.transaction((tx) =>
      markConnectionStatus(tx, connection.id, 'rejected', 'gitlab.com answered 401.'),
    );
    expect((await linkOf(p.id))?.syncError).toBe(
      `The git connection "${connection.name}" rejected its token: gitlab.com answered 401.`,
    );
    await base.db.transaction((tx) => markConnectionStatus(tx, connection.id, 'working'));
    expect((await linkOf(p.id))?.syncError).toBeNull();

    clock = new Date('2040-01-12T10:00:00.000Z');
    await deleteConnection(ctx, world.ownerActor, { id: connection.id });
    expect(await linkOf(p.id)).toMatchObject({ connectionId: null, movesFrom: clock });
  });

  it('makes a link inside a caller transaction only for projects with a repository', async () => {
    const p = await newProject();
    expect(await base.db.transaction((tx) => ensureRepositoryLink(tx, ctx, p))).toBeNull();
  });
});
