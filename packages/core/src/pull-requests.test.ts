// Requests on tasks through a fake host: links by branch, description and hand, description edits,
// removal tombstones, the state moves (open, draft, ready, reopen, merge into the default branch
// and another one, close without merge), several requests on one task, the close-on-merge switch,
// mirrored projects, old and out-of-order events, and the webhook for each host.
import { schema } from '@zamu/db';
import { type ProviderKind, type RequestAction, type RequestInfo, signWebhook } from '@zamu/git-providers';
import { and, asc, eq } from 'drizzle-orm';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { recordingJobQueue, TEST_ENCRYPTION_KEY } from './backlog/testing';
import { ProjectMirrored } from './errors';
import { REPOSITORY_EVENT } from './jobs';
import { createProject, updateProject } from './projects';
import {
  closesKeys,
  handleRepositoryEvent,
  linkPullRequest,
  NotARequest,
  type PullRequestContext,
  RequestNotFound,
  RequestOtherRepository,
  receiveRepositoryWebhook,
  unlinkPullRequest,
} from './pull-requests';
import {
  getRepositorySettings,
  newRepositoryWebhookSecret,
  type RepositoryLinkRow,
  updateRepositorySettings,
} from './repository';
import { createTask, getTask, updateTask } from './tasks';
import { createMirroredProject } from './testing/backlog';
import {
  createTaskItemRows,
  createWorld,
  projectRow,
  randomProjectKey,
  type TestContext,
  testContext,
  type World,
} from './testing/fixtures';
import { FakeRequestHost, fakeRequestFactory, requestInfo, requestUrl } from './testing/requests';

const { activity, pullRequest, repositoryLink, task, taskPullRequest } = schema;

let base: TestContext;
let host: FakeRequestHost;
let ctx: PullRequestContext & { jobs: ReturnType<typeof recordingJobQueue> };
let world: World;

beforeAll(async () => {
  base = testContext();
  host = new FakeRequestHost('github', 'github.com');
  ctx = {
    ...base,
    encryptionKey: TEST_ENCRYPTION_KEY,
    providerFactory: fakeRequestFactory(host),
    jobs: recordingJobQueue(),
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

interface Repo {
  key: string;
  path: string;
  link: RepositoryLinkRow;
  /** A request of this repository with defaults (GitHub form). */
  request(values: Partial<RequestInfo> & { number: number }): RequestInfo;
  /** Applies a webhook event through the repository.event handler. */
  event(request: RequestInfo, action?: RequestAction): Promise<unknown>;
}

async function newRepo(options: { closeOnMerge?: boolean } = {}): Promise<Repo> {
  const key = randomProjectKey();
  const path = `northwind/payments-${key.toLowerCase()}`;
  await createProject(ctx, world.ownerActor, {
    key,
    name: `Payments ${key}`,
    repository: `https://github.com/${path}`,
  });
  host.repository(path);
  await getRepositorySettings(ctx, world.ownerActor, { project: key });
  if (options.closeOnMerge === false) {
    await updateRepositorySettings(ctx, world.ownerActor, { project: key, closeOnMerge: false });
  }
  const project = await projectRow(base.db, world.workspaceId, key);
  const [link] = await base.db.select().from(repositoryLink).where(eq(repositoryLink.projectId, project.id));
  if (!link) throw new Error('no link');
  // Events in these tests happen after the link was made (requests default to 2040).
  return {
    key,
    path,
    link,
    request: (values) => requestInfo(values, { path }),
    event: (request, action) =>
      handleRepositoryEvent(ctx, { linkId: link.id, request, ...(action ? { action } : {}) }),
  };
}

async function taskRow(id: string) {
  const [row] = await base.db.select().from(task).where(eq(task.id, id));
  if (!row) throw new Error('no task');
  return row;
}

async function newTask(repo: Repo, values: { status?: 'todo' | 'in_progress'; branch?: string } = {}) {
  const created = await createTask(ctx, world.memberActor, {
    project: repo.key,
    title: 'Retry webhooks',
    status: values.status ?? 'in_progress',
  });
  if (values.branch) {
    await base.db.update(task).set({ workBranch: values.branch }).where(eq(task.id, created.id));
  }
  return created;
}

async function linksOf(taskId: string) {
  return base.db
    .select({
      number: pullRequest.number,
      viaBranch: taskPullRequest.viaBranch,
      viaDescription: taskPullRequest.viaDescription,
      viaHand: taskPullRequest.viaHand,
      removedAt: taskPullRequest.removedAt,
    })
    .from(taskPullRequest)
    .innerJoin(pullRequest, eq(pullRequest.id, taskPullRequest.pullRequestId))
    .where(eq(taskPullRequest.taskId, taskId))
    .orderBy(asc(pullRequest.number));
}

async function historyOf(taskId: string) {
  return base.db
    .select({
      type: activity.type,
      actorId: activity.actorId,
      origin: activity.origin,
      originRef: activity.originRef,
      cause: activity.cause,
      changes: activity.changes,
    })
    .from(activity)
    .where(eq(activity.taskId, taskId))
    .orderBy(asc(activity.createdAt), asc(activity.id));
}

describe('closesKeys', () => {
  it('reads keys on Closes: lines in any case, comma or space separated', () => {
    expect(
      closesKeys(
        'Retries webhooks.\n\nCloses: PAY-1, pay-2 PAY-3.1\ncloses:BACK-007\n- Closes: PAY-4.\nNot closes: PAY-9\nCloses PAY-8',
      ),
    ).toEqual(['PAY-1', 'PAY-2', 'PAY-3.1', 'BACK-007', 'PAY-4']);
    expect(closesKeys('Closes: nothing here, #12')).toEqual([]);
    expect(closesKeys('')).toEqual([]);
  });
});

describe('links by branch and description', () => {
  it('links the tasks on the head branch and moves them to In review when the request opens', async () => {
    const repo = await newRepo();
    const t = await newTask(repo, { branch: 'feat/retry' });
    const other = await newTask(repo, { branch: 'feat/other' });
    await repo.event(repo.request({ number: 12, headBranch: 'feat/retry', author: 'claude-dev' }), 'opened');

    expect(await linksOf(t.id)).toEqual([
      { number: 12, viaBranch: true, viaDescription: false, viaHand: false, removedAt: null },
    ]);
    expect(await linksOf(other.id)).toEqual([]);
    expect((await taskRow(t.id)).status).toBe('in_review');

    const history = await historyOf(t.id);
    const url = requestUrl('github', 'github.com', repo.path, 12);
    expect(history.filter((row) => row.type === 'task.pull_request_linked')).toEqual([
      expect.objectContaining({
        actorId: null,
        origin: 'git',
        originRef: url,
        cause: expect.objectContaining({
          kind: 'pull_request',
          event: 'opened',
          number: 12,
          by: 'claude-dev',
        }),
        changes: [
          {
            field: 'pullRequest',
            from: null,
            to: { provider: 'github', number: 12, title: 'Request 12', url, how: 'branch' },
          },
        ],
      }),
    ]);
    const moved = history.find((row) => row.type === 'task.updated' && row.origin === 'git');
    expect(moved).toMatchObject({ actorId: null, cause: { event: 'opened' } });
    const view = await getTask(ctx, world.memberActor, { key: t.key });
    expect(view.pullRequests).toEqual([
      expect.objectContaining({ number: 12, how: 'branch', state: 'open' }),
    ]);
  });

  it('links Closes: keys of the project only and follows description edits', async () => {
    const repo = await newRepo();
    const elsewhere = await newRepo();
    const one = await newTask(repo, { status: 'todo' });
    const two = await newTask(repo, { status: 'todo', branch: 'feat/both' });
    const foreign = await newTask(elsewhere, { status: 'todo' });
    const body = `Closes: ${one.key}, ${two.key} ${foreign.key} ${repo.key}-9999`;
    await repo.event(repo.request({ number: 5, headBranch: 'feat/both', body }), 'opened');
    expect(await linksOf(one.id)).toEqual([
      expect.objectContaining({ viaDescription: true, viaBranch: false }),
    ]);
    expect(await linksOf(two.id)).toEqual([
      expect.objectContaining({ viaDescription: true, viaBranch: true }),
    ]);
    expect(await linksOf(foreign.id)).toEqual([]);
    expect((await taskRow(one.id)).status).toBe('in_review');

    // The edit drops both keys: one unlinks; two stays linked by its branch.
    const edited = repo.request({
      number: 5,
      headBranch: 'feat/both',
      body: 'No keys now',
      updatedAt: '2040-01-01T11:00:00.000Z',
    });
    await repo.event(edited, 'edited');
    expect(await linksOf(one.id)).toEqual([
      expect.objectContaining({ viaDescription: false, viaBranch: false, viaHand: false }),
    ]);
    expect(await linksOf(two.id)).toEqual([
      expect.objectContaining({ viaDescription: false, viaBranch: true }),
    ]);
    const unlinked = (await historyOf(one.id)).filter((row) => row.type === 'task.pull_request_unlinked');
    expect(unlinked).toEqual([
      expect.objectContaining({
        actorId: null,
        origin: 'git',
        changes: [
          expect.objectContaining({ from: expect.objectContaining({ how: 'description' }), to: null }),
        ],
      }),
    ]);
    // A task that left the review is not moved back by an edit.
    expect((await getTask(ctx, world.memberActor, { key: one.key })).pullRequests).toEqual([]);
  });

  it('clears the branch link of a task whose work branch moved on', async () => {
    const repo = await newRepo();
    const t = await newTask(repo, { branch: 'feat/old' });
    await repo.event(repo.request({ number: 7, headBranch: 'feat/old', state: 'draft' }), 'opened');
    expect(await linksOf(t.id)).toEqual([expect.objectContaining({ viaBranch: true })]);
    await base.db.update(task).set({ workBranch: 'feat/new' }).where(eq(task.id, t.id));
    await repo.event(
      repo.request({
        number: 7,
        headBranch: 'feat/old',
        state: 'draft',
        updatedAt: '2040-01-01T12:00:00.000Z',
      }),
      'synchronized',
    );
    expect(await linksOf(t.id)).toEqual([expect.objectContaining({ viaBranch: false })]);
    expect((await getTask(ctx, world.memberActor, { key: t.key })).pullRequests).toEqual([]);
  });

  it('keeps the stored author and merged-by when an event leaves them out', async () => {
    const repo = await newRepo();
    await repo.event(repo.request({ number: 3, author: 'claude-dev' }), 'opened');
    await repo.event(
      repo.request({
        number: 3,
        author: null,
        state: 'merged',
        mergedBy: 'ana',
        updatedAt: '2040-01-01T11:00:00.000Z',
      }),
      'merged',
    );
    await repo.event(
      repo.request({
        number: 3,
        author: null,
        state: 'merged',
        mergedBy: null,
        updatedAt: '2040-01-01T12:00:00.000Z',
      }),
      'edited',
    );
    const [row] = await base.db
      .select()
      .from(pullRequest)
      .where(and(eq(pullRequest.projectId, repo.link.projectId), eq(pullRequest.number, 3)));
    expect(row).toMatchObject({ author: 'claude-dev', mergedBy: 'ana', state: 'merged' });
  });

  it('ignores a request of another repository delivered to the link', async () => {
    const repo = await newRepo();
    const t = await newTask(repo, { branch: 'feat/x' });
    const result = await repo.event(
      requestInfo({ number: 4, headBranch: 'feat/x' }, { path: 'someone/else' }),
      'opened',
    );
    expect(result).toMatchObject({ applied: false, reason: 'other_repository' });
    expect(await linksOf(t.id)).toEqual([]);
  });
});

describe('status moves', () => {
  it('links drafts without moving, and moves on ready', async () => {
    const repo = await newRepo();
    const t = await newTask(repo, { branch: 'feat/d', status: 'todo' });
    await repo.event(repo.request({ number: 20, headBranch: 'feat/d', state: 'draft' }), 'opened');
    expect((await taskRow(t.id)).status).toBe('todo');
    await repo.event(
      repo.request({ number: 20, headBranch: 'feat/d', updatedAt: '2040-01-01T11:00:00.000Z' }),
      'synchronized',
    );
    const row = await taskRow(t.id);
    expect(row.status).toBe('in_review');
    const moved = (await historyOf(t.id)).find(
      (entry) => entry.type === 'task.updated' && entry.origin === 'git',
    );
    expect(moved?.cause).toMatchObject({ event: 'ready' });
  });

  it('moves to Done on a merge into the default branch only, and not on a close', async () => {
    const repo = await newRepo();
    const merged = await newTask(repo, { branch: 'feat/m' });
    const other = await newTask(repo, { branch: 'feat/o' });
    const closed = await newTask(repo, { branch: 'feat/c' });
    await repo.event(repo.request({ number: 30, headBranch: 'feat/m' }), 'opened');
    await repo.event(repo.request({ number: 31, headBranch: 'feat/o' }), 'opened');
    await repo.event(repo.request({ number: 32, headBranch: 'feat/c' }), 'opened');
    const later = '2040-01-02T10:00:00.000Z';
    await repo.event(
      repo.request({ number: 30, headBranch: 'feat/m', state: 'merged', updatedAt: later }),
      'merged',
    );
    await repo.event(
      repo.request({
        number: 31,
        headBranch: 'feat/o',
        baseBranch: 'release',
        state: 'merged',
        updatedAt: later,
      }),
      'merged',
    );
    await repo.event(
      repo.request({ number: 32, headBranch: 'feat/c', state: 'closed', updatedAt: later }),
      'closed',
    );
    expect((await taskRow(merged.id)).status).toBe('done');
    expect((await taskRow(merged.id)).closedAt).not.toBeNull();
    expect((await taskRow(other.id)).status).toBe('in_review');
    expect((await taskRow(closed.id)).status).toBe('in_review');
    const done = (await historyOf(merged.id)).filter(
      (entry) => entry.type === 'task.updated' && entry.origin === 'git',
    );
    expect(done.at(-1)?.cause).toMatchObject({ event: 'merged', by: 'ana' });

    // A closed request reopened moves back to In review only from Backlog, Todo or In progress.
    await updateTask(ctx, world.memberActor, { key: closed.key, status: 'todo' });
    await repo.event(
      repo.request({ number: 32, headBranch: 'feat/c', updatedAt: '2040-01-03T10:00:00.000Z' }),
      'reopened',
    );
    expect((await taskRow(closed.id)).status).toBe('in_review');
  });

  it('flags a merge with open criteria and keeps a task with another open request', async () => {
    const repo = await newRepo();
    const flagged = await newTask(repo, { branch: 'feat/f' });
    await createTaskItemRows(base.db, flagged.id, 'criterion', ['Retries back off']);
    const two = await newTask(repo, { branch: 'feat/two' });
    await repo.event(repo.request({ number: 40, headBranch: 'feat/f' }), 'opened');
    await repo.event(repo.request({ number: 41, headBranch: 'feat/two' }), 'opened');
    await repo.event(
      repo.request({ number: 42, headBranch: 'feat/x', body: `Closes: ${two.key}` }),
      'opened',
    );
    const later = '2040-01-02T10:00:00.000Z';
    await repo.event(
      repo.request({ number: 40, headBranch: 'feat/f', state: 'merged', updatedAt: later }),
      'merged',
    );
    await repo.event(
      repo.request({ number: 41, headBranch: 'feat/two', state: 'merged', updatedAt: later }),
      'merged',
    );
    const row = await taskRow(flagged.id);
    expect(row.status).toBe('done');
    expect(row.mergedDoneAt).not.toBeNull();
    // #42 is still open for two.
    expect((await taskRow(two.id)).status).toBe('in_review');
    await repo.event(
      repo.request({
        number: 42,
        headBranch: 'feat/x',
        body: `Closes: ${two.key}`,
        state: 'merged',
        updatedAt: '2040-01-03T10:00:00.000Z',
      }),
      'merged',
    );
    expect((await taskRow(two.id)).status).toBe('done');
  });

  it('stops only the Done step when the project does not close on merge', async () => {
    const repo = await newRepo({ closeOnMerge: false });
    const t = await newTask(repo, { branch: 'feat/s', status: 'todo' });
    await repo.event(repo.request({ number: 50, headBranch: 'feat/s' }), 'opened');
    expect((await taskRow(t.id)).status).toBe('in_review');
    await repo.event(
      repo.request({
        number: 50,
        headBranch: 'feat/s',
        state: 'merged',
        updatedAt: '2040-01-02T10:00:00.000Z',
      }),
      'merged',
    );
    expect((await taskRow(t.id)).status).toBe('in_review');
  });

  it('drops events older than the stored request and moves nothing for events before moves_from', async () => {
    const repo = await newRepo();
    const t = await newTask(repo, { branch: 'feat/late' });
    await repo.event(
      repo.request({
        number: 60,
        headBranch: 'feat/late',
        state: 'merged',
        updatedAt: '2040-01-02T10:00:00.000Z',
      }),
      'merged',
    );
    expect((await taskRow(t.id)).status).toBe('done');
    // The open event arrives late: dropped, so the task stays Done and the request merged.
    const late = await repo.event(repo.request({ number: 60, headBranch: 'feat/late' }), 'opened');
    expect(late).toMatchObject({ applied: false, reason: 'stale' });
    expect((await taskRow(t.id)).status).toBe('done');

    const old = await newTask(repo, { branch: 'feat/old', status: 'todo' });
    await repo.event(
      repo.request({ number: 61, headBranch: 'feat/old', updatedAt: '2020-01-01T10:00:00.000Z' }),
      'opened',
    );
    expect(await linksOf(old.id)).toHaveLength(1);
    expect((await taskRow(old.id)).status).toBe('todo');
  });

  it('links requests of a mirrored project without moving its tasks', async () => {
    const mirror = await createMirroredProject(base.db, world);
    const path = mirror.project.repository?.replace('https://gitlab.com/', '') as string;
    const gitlab = new FakeRequestHost('gitlab', 'gitlab.com');
    const glCtx = { ...ctx, providerFactory: fakeRequestFactory(gitlab) };
    const settings = await getRepositorySettings(glCtx, world.ownerActor, { project: mirror.key });
    expect(settings).toMatchObject({
      mirrored: true,
      closeOnMerge: false,
      connection: { id: mirror.connection.id },
    });
    expect(settings.webhook?.coveredByBacklog).toBe(true);
    await rejection(
      updateRepositorySettings(glCtx, world.ownerActor, { project: mirror.key, closeOnMerge: true }),
      ProjectMirrored,
    );
    const [link] = await base.db
      .select()
      .from(repositoryLink)
      .where(eq(repositoryLink.projectId, mirror.project.id));
    const request = requestInfo(
      { number: 9, body: 'Closes: BACK-786', state: 'merged' },
      { provider: 'gitlab', host: 'gitlab.com', path },
    );
    await handleRepositoryEvent(glCtx, { linkId: link?.id as string, request, action: 'merged' });
    expect(await linksOf(mirror.tasks.parent.id)).toEqual([
      expect.objectContaining({ viaDescription: true }),
    ]);
    expect((await taskRow(mirror.tasks.parent.id)).status).toBe('in_progress');
  });
});

describe('links by hand', () => {
  it('previews, links, refuses other addresses, and keeps a removed link removed', async () => {
    const repo = await newRepo();
    const t = await newTask(repo, { status: 'todo', branch: 'feat/h' });
    host.put(repo.path, repo.request({ number: 70, headBranch: 'feat/h', title: 'Retry with backoff' }));
    const url = requestUrl('github', 'github.com', repo.path, 70);

    const preview = await linkPullRequest(ctx, world.memberActor, { key: t.key, url, dryRun: true });
    expect(preview).toMatchObject({ number: 70, how: 'hand', title: 'Retry with backoff', state: 'open' });
    expect(await linksOf(t.id)).toEqual([]);

    await rejection(
      linkPullRequest(ctx, world.memberActor, { key: t.key, url: 'https://github.com/x' }),
      NotARequest,
    );
    const other = await rejection(
      linkPullRequest(ctx, world.memberActor, { key: t.key, url: 'https://github.com/someone/else/pull/1' }),
      RequestOtherRepository,
    );
    expect(other.repository).toBe(`github.com/${repo.path}`);
    await rejection(
      linkPullRequest(ctx, world.memberActor, {
        key: t.key,
        url: requestUrl('github', 'github.com', repo.path, 404),
      }),
      RequestNotFound,
    );

    const linked = await linkPullRequest(ctx, world.memberActor, { key: t.key, url: `${url}/files#diff` });
    expect(linked).toMatchObject({ number: 70, how: 'hand', linkedBy: { id: world.member.id } });
    expect((await taskRow(t.id)).status).toBe('in_review');
    const handRow = (await historyOf(t.id)).find((row) => row.type === 'task.pull_request_linked');
    expect(handRow).toMatchObject({ actorId: world.member.id, origin: 'app' });
    // Read without a token through the public adapter for the repository's host.
    expect(
      ctx.providerFactory && (ctx.providerFactory as ReturnType<typeof fakeRequestFactory>).built.at(-1),
    ).toEqual({
      provider: 'github',
      host: 'github.com',
      token: '',
    });

    await unlinkPullRequest(ctx, world.memberActor, { key: t.key, number: 70 });
    await rejection(unlinkPullRequest(ctx, world.memberActor, { key: t.key, number: 70 }), RequestNotFound);
    // The branch would link it again; the tombstone keeps it out.
    await repo.event(
      repo.request({ number: 70, headBranch: 'feat/h', updatedAt: '2040-01-02T10:00:00.000Z' }),
      'synchronized',
    );
    expect(await linksOf(t.id)).toEqual([expect.objectContaining({ removedAt: expect.any(Date) })]);
    expect((await getTask(ctx, world.memberActor, { key: t.key })).pullRequests).toEqual([]);

    // Linking by hand again brings it back.
    host.put(
      repo.path,
      repo.request({ number: 70, headBranch: 'feat/h', updatedAt: '2040-01-02T10:00:00.000Z' }),
    );
    await linkPullRequest(ctx, world.memberActor, { key: t.key, url });
    expect(await linksOf(t.id)).toEqual([
      expect.objectContaining({ removedAt: null, viaHand: true, viaBranch: true }),
    ]);
  });

  it('compares the host without its port and reads through the connection', async () => {
    const forgejo = new FakeRequestHost('gitea', 'localhost:3300');
    const fCtx = { ...ctx, providerFactory: fakeRequestFactory(forgejo) };
    const key = randomProjectKey();
    await createProject(fCtx, world.ownerActor, {
      key,
      name: 'Local',
      repository: 'http://localhost:3300/northwind/ledger',
    });
    const t = await createTask(fCtx, world.memberActor, { project: key, title: 'Local task' });
    forgejo.put(
      'northwind/ledger',
      requestInfo({ number: 2 }, { provider: 'gitea', host: 'localhost:3300', path: 'northwind/ledger' }),
    );
    const url = 'http://localhost:3300/northwind/ledger/pulls/2';
    const linked = await linkPullRequest(fCtx, world.memberActor, { key: t.key, url });
    expect(linked).toMatchObject({ provider: 'gitea', number: 2 });
    expect((fCtx.providerFactory as ReturnType<typeof fakeRequestFactory>).built.at(-1)).toMatchObject({
      provider: 'gitea',
      host: 'localhost:3300',
    });
    await rejection(
      linkPullRequest(fCtx, world.memberActor, {
        key: t.key,
        url: 'http://localhost:3300/northwind/other/pulls/2',
      }),
      RequestOtherRepository,
    );
  });

  it('refuses archived tasks and members of other projects keys', async () => {
    const repo = await newRepo();
    const t = await newTask(repo, { status: 'todo' });
    await base.db.update(task).set({ archivedAt: new Date() }).where(eq(task.id, t.id));
    const url = requestUrl('github', 'github.com', repo.path, 1);
    const error = await linkPullRequest(ctx, world.memberActor, { key: t.key, url }).catch((e: unknown) => e);
    expect((error as { problemCode?: string }).problemCode).toBe('TASK_ARCHIVED');
  });
});

describe('receiveRepositoryWebhook', () => {
  const HOSTS: Record<ProviderKind, string> = {
    github: 'github.com',
    gitlab: 'gitlab.com',
    gitea: 'codeberg.org',
  };
  const EVENT: Record<ProviderKind, Record<string, string>> = {
    github: { 'X-GitHub-Event': 'pull_request' },
    gitlab: { 'X-Gitlab-Event': 'Merge Request Hook' },
    gitea: { 'X-Forgejo-Event': 'pull_request', 'X-Gitea-Event': 'pull_request' },
  };
  const payloads: Record<ProviderKind, (path: string) => string> = {
    github: (path) =>
      JSON.stringify({
        action: 'opened',
        number: 8,
        pull_request: {
          number: 8,
          title: 'Retry',
          body: '',
          state: 'open',
          draft: false,
          merged: false,
          head: { ref: 'feat/hook' },
          base: { ref: 'main' },
          user: { login: 'claude-dev' },
          html_url: `https://github.com/${path}/pull/8`,
          created_at: '2040-01-01T10:00:00Z',
          updated_at: '2040-01-01T10:00:00Z',
          closed_at: null,
          merged_at: null,
        },
      }),
    gitlab: (path) =>
      JSON.stringify({
        object_kind: 'merge_request',
        user: { username: 'claude-dev' },
        object_attributes: {
          iid: 8,
          title: 'Retry',
          description: '',
          state: 'opened',
          action: 'open',
          draft: false,
          source_branch: 'feat/hook',
          target_branch: 'main',
          url: `https://gitlab.com/${path}/-/merge_requests/8`,
          created_at: '2040-01-01T10:00:00Z',
          updated_at: '2040-01-01T10:00:00Z',
        },
      }),
    gitea: (path) =>
      JSON.stringify({
        action: 'opened',
        number: 8,
        pull_request: {
          number: 8,
          title: 'Retry',
          body: '',
          state: 'open',
          draft: false,
          merged: false,
          head: { ref: 'feat/hook' },
          base: { ref: 'main' },
          user: { login: 'claude-dev' },
          html_url: `https://codeberg.org/${path}/pulls/8`,
          created_at: '2040-01-01T10:00:00Z',
          updated_at: '2040-01-01T10:00:00Z',
          closed_at: null,
          merged_at: null,
        },
      }),
  };

  for (const provider of ['github', 'gitlab', 'gitea'] as const) {
    it(`verifies a ${provider} request event, records it and queues it`, async () => {
      const key = randomProjectKey();
      const path = `northwind/hook-${key.toLowerCase()}`;
      await createProject(ctx, world.ownerActor, {
        key,
        name: key,
        repository: `https://${HOSTS[provider]}/${path}`,
      });
      const { secret, url } = await newRepositoryWebhookSecret(ctx, world.ownerActor, { project: key });
      const webhookId = url.split('/').at(-1) as string;
      const project = await projectRow(base.db, world.workspaceId, key);
      const body = payloads[provider](path);
      ctx.jobs.clear();

      const signed = { ...signWebhook(provider, body, secret), ...EVENT[provider] };
      expect(await receiveRepositoryWebhook(ctx, { webhookId, headers: signed, rawBody: body })).toEqual({
        status: 202,
        reason: 'event_queued',
      });
      expect(ctx.jobs.sent).toEqual([
        expect.objectContaining({
          name: REPOSITORY_EVENT,
          data: expect.objectContaining({
            action: 'opened',
            request: expect.objectContaining({ number: 8 }),
          }),
        }),
      ]);
      const settings = await getRepositorySettings(ctx, world.memberActor, { project: key });
      expect(settings.webhook).toMatchObject({ lastStatus: 'ok', secretSet: true });
      expect(settings.webhook?.lastAt).not.toBeNull();

      const bad = { ...signWebhook(provider, body, `${secret}x`), ...EVENT[provider] };
      expect(await receiveRepositoryWebhook(ctx, { webhookId, headers: bad, rawBody: body })).toEqual({
        status: 401,
        reason: 'bad_signature',
      });
      expect(
        await receiveRepositoryWebhook(ctx, { webhookId, headers: EVENT[provider], rawBody: body }),
      ).toMatchObject({
        status: 401,
      });
      const [row] = await base.db
        .select()
        .from(repositoryLink)
        .where(eq(repositoryLink.projectId, project.id));
      expect(row?.webhookLastStatus).toBe('bad_signature');
      expect(ctx.jobs.sent).toHaveLength(1);
    });
  }

  it('answers 404 to unknown ids, 401 without a secret and 410 without a repository', async () => {
    expect(await receiveRepositoryWebhook(ctx, { webhookId: 'nope', headers: {}, rawBody: '' })).toEqual({
      status: 404,
      reason: 'unknown_webhook',
    });
    expect(
      await receiveRepositoryWebhook(ctx, { webhookId: 'a'.repeat(24), headers: {}, rawBody: '' }),
    ).toMatchObject({
      status: 404,
    });
    const repo = await newRepo();
    expect(
      await receiveRepositoryWebhook(ctx, { webhookId: repo.link.webhookId, headers: {}, rawBody: '{}' }),
    ).toMatchObject({ status: 401 });
    await updateProject(ctx, world.ownerActor, { project: repo.key, repository: null });
    expect(
      await receiveRepositoryWebhook(ctx, { webhookId: repo.link.webhookId, headers: {}, rawBody: '{}' }),
    ).toEqual({ status: 410, reason: 'no_repository' });
  });

  it('is for owners and admins to issue a secret, shown once', async () => {
    const repo = await newRepo();
    await rejection(newRepositoryWebhookSecret(ctx, world.memberActor, { project: repo.key }), Error);
    const first = await newRepositoryWebhookSecret(ctx, world.ownerActor, { project: repo.key });
    expect(first.secret.length).toBeGreaterThan(30);
    const settings = await getRepositorySettings(ctx, world.memberActor, { project: repo.key });
    expect(JSON.stringify(settings)).not.toContain(first.secret);
    expect(settings.canEdit).toBe(false);
  });
});
