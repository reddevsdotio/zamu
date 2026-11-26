// M7 through the task services: closed_at on every status path, the check-again day (pair rule,
// clearing on close with a history line, list filters), the work branch from the CLI with the
// requests it links in the same transaction, the request fields of tasks and rows, and
// setStatusFromSource, the move a request makes (no actor, origin git, the cause).
import type { ActivityCause } from '@zamu/contracts';
import { schema } from '@zamu/db';
import { and, eq } from 'drizzle-orm';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { listTaskActivity } from './activity';
import type { Actor } from './authz';
import type { ClockContext } from './cycles';
import { Invalid, NotFound } from './errors';
import { createProject } from './projects';
import { bulkUpdateTasks, createTask, getTask, listTasks, setStatusFromSource, updateTask } from './tasks';
import { createMirroredProject } from './testing/backlog';
import {
  createMilestoneRow,
  createPullRequestRow,
  createRepositoryLinkRow,
  createTaskItemRows,
  createWorld,
  linkPullRequestRow,
  projectRow,
  randomProjectKey,
  scopeOf,
  type TestContext,
  testContext,
  type World,
} from './testing/fixtures';
import { listTaskTimeline } from './timeline';

const { task } = schema;

/** Runs `promise`, expecting it to reject with `type`, and returns the error. */
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

const NOW = new Date('2026-11-20T10:00:00.000Z');

let ctx: TestContext;
let clocked: TestContext & ClockContext;
let world: World;

beforeAll(async () => {
  ctx = testContext();
  clocked = { ...ctx, timeZone: 'UTC', now: () => NOW };
  world = await createWorld(ctx.db);
});
afterAll(async () => {
  await ctx?.close();
});

async function newProject(values: { repository?: string } = {}) {
  const key = randomProjectKey();
  await createProject(ctx, world.ownerActor, { key, name: `Payments ${key}`, ...values });
  return projectRow(ctx.db, world.workspaceId, key);
}

async function rowOf(id: string) {
  const [row] = await ctx.db.select().from(task).where(eq(task.id, id));
  if (!row) throw new Error('task not found');
  return row;
}

describe('closed_at', () => {
  it('is set on entering Done or Canceled and cleared on leaving them, on every path', async () => {
    const p = await newProject();
    const created = await createTask(clocked, world.memberActor, {
      project: p.key,
      title: 'Born done',
      status: 'done',
    });
    expect(created.closedAt).toBe(NOW.toISOString());
    const open = await createTask(clocked, world.memberActor, { project: p.key, title: 'Open' });
    expect(open.closedAt).toBeNull();

    const later = new Date(NOW.getTime() + 60_000);
    const laterCtx = { ...clocked, now: () => later };
    const done = await updateTask(laterCtx, world.memberActor, { key: open.key, status: 'canceled' });
    expect(done.closedAt).toBe(later.toISOString());
    // Done to Canceled stays closed since the first close.
    const moved = await updateTask(clocked, world.memberActor, { key: open.key, status: 'done' });
    expect(moved.closedAt).toBe(later.toISOString());
    const reopened = await updateTask(clocked, world.memberActor, { key: open.key, status: 'todo' });
    expect(reopened.closedAt).toBeNull();

    const bulk = await bulkUpdateTasks(clocked, world.memberActor, {
      keys: [open.key, created.key],
      status: 'done',
    });
    expect(bulk.items.map((item) => item.status)).toEqual(['done', 'done']);
    expect((await rowOf(open.id)).closedAt?.toISOString()).toBe(NOW.toISOString());
    // Already Done: the bulk change leaves its closed_at alone.
    expect((await rowOf(created.id)).closedAt?.toISOString()).toBe(NOW.toISOString());
  });

  it('reopening a task a merge closed clears the merged flag', async () => {
    const p = await newProject();
    const t = await createTask(clocked, world.memberActor, {
      project: p.key,
      title: 'Merged',
      status: 'done',
    });
    await ctx.db.update(task).set({ mergedDoneAt: NOW }).where(eq(task.id, t.id));
    await updateTask(clocked, world.memberActor, { key: t.key, status: 'in_progress' });
    expect((await rowOf(t.id)).mergedDoneAt).toBeNull();
  });
});

describe('check-again days', () => {
  it('sets, changes and clears the day with its reason, each with a history line', async () => {
    const p = await newProject();
    const created = await createTask(clocked, world.memberActor, {
      project: p.key,
      title: 'Wait for the bank',
      checkAgain: { on: '2026-12-03', reason: "Wait for the bank's answer" },
    });
    expect(created.checkAgain).toEqual({ on: '2026-12-03', reason: "Wait for the bank's answer" });
    const changed = await updateTask(clocked, world.memberActor, {
      key: created.key,
      checkAgain: { on: '2026-12-05', reason: 'Still waiting' },
    });
    expect(changed.checkAgain).toEqual({ on: '2026-12-05', reason: 'Still waiting' });
    // The same day and reason again change nothing.
    await updateTask(clocked, world.memberActor, {
      key: created.key,
      checkAgain: { on: '2026-12-05', reason: 'Still waiting' },
    });
    const cleared = await updateTask(clocked, world.memberActor, { key: created.key, checkAgain: null });
    expect(cleared.checkAgain).toBeNull();

    const history = (await listTaskActivity(ctx, world.memberActor, { key: created.key })).items;
    expect(
      history.flatMap((entry) => entry.changes.filter((change) => change.field === 'checkAgain')),
    ).toEqual([
      { field: 'checkAgain', from: null, to: { on: '2026-12-03', reason: "Wait for the bank's answer" } },
      {
        field: 'checkAgain',
        from: { on: '2026-12-03', reason: "Wait for the bank's answer" },
        to: { on: '2026-12-05', reason: 'Still waiting' },
      },
      { field: 'checkAgain', from: { on: '2026-12-05', reason: 'Still waiting' }, to: null },
    ]);
  });

  it('needs the day and the reason together', async () => {
    const p = await newProject();
    const t = await createTask(clocked, world.memberActor, { project: p.key, title: 'Pair' });
    await rejection(
      updateTask(clocked, world.memberActor, { key: t.key, checkAgain: { on: '2026-12-03' } as never }),
      Invalid,
    );
    await rejection(
      updateTask(clocked, world.memberActor, { key: t.key, checkAgain: { on: '2026-12-03', reason: '  ' } }),
      Invalid,
    );
  });

  it('clears the day with a history line when the task closes, also in bulk', async () => {
    const p = await newProject();
    const t = await createTask(clocked, world.memberActor, {
      project: p.key,
      title: 'Close me',
      checkAgain: { on: '2026-11-01', reason: 'Ping the vendor' },
    });
    const done = await updateTask(clocked, world.memberActor, { key: t.key, status: 'done' });
    expect(done.checkAgain).toBeNull();
    const [last] = (await listTaskActivity(ctx, world.memberActor, { key: t.key })).items.slice(-1);
    expect(last?.changes).toEqual([
      { field: 'status', from: 'todo', to: 'done' },
      { field: 'checkAgain', from: { on: '2026-11-01', reason: 'Ping the vendor' }, to: null },
    ]);

    const other = await createTask(clocked, world.memberActor, {
      project: p.key,
      title: 'Bulk close',
      checkAgain: { on: '2026-11-01', reason: 'Ping the vendor' },
    });
    await bulkUpdateTasks(clocked, world.memberActor, { keys: [other.key], status: 'canceled' });
    expect((await getTask(clocked, world.memberActor, { key: other.key })).checkAgain).toBeNull();

    // A task created closed keeps no day.
    const closed = await createTask(clocked, world.memberActor, {
      project: p.key,
      title: 'Closed already',
      status: 'done',
      checkAgain: { on: '2026-11-01', reason: 'Ping the vendor' },
    });
    expect(closed.checkAgain).toBeNull();
  });

  it('filters waiting, ready, set and none on today in the time zone', async () => {
    const p = await newProject();
    const waiting = await createTask(clocked, world.memberActor, {
      project: p.key,
      title: 'Waiting',
      checkAgain: { on: '2026-11-21', reason: 'Tomorrow' },
    });
    const today = await createTask(clocked, world.memberActor, {
      project: p.key,
      title: 'Today',
      checkAgain: { on: '2026-11-20', reason: 'Today' },
    });
    const past = await createTask(clocked, world.memberActor, {
      project: p.key,
      title: 'Past',
      checkAgain: { on: '2026-11-02', reason: 'Long ago' },
    });
    const none = await createTask(clocked, world.memberActor, { project: p.key, title: 'None' });
    const list = async (checkAgain: 'waiting' | 'ready' | 'set' | 'none', clock = clocked) =>
      (await listTasks(clock, world.memberActor, { project: [p.key], checkAgain })).items
        .map((item) => item.key)
        .sort();
    expect(await list('waiting')).toEqual([waiting.key]);
    expect(await list('ready')).toEqual([today.key, past.key].sort());
    expect(await list('set')).toEqual([waiting.key, today.key, past.key].sort());
    expect(await list('none')).toEqual([none.key]);
    // 11:30 UTC is 00:30 on the 21st in Auckland: the waiting task is ready there.
    const auckland = {
      ...clocked,
      timeZone: 'Pacific/Auckland',
      now: () => new Date('2026-11-20T11:30:00Z'),
    };
    expect(await list('waiting', auckland)).toEqual([]);

    const rows = (await listTasks(clocked, world.memberActor, { project: [p.key] })).items;
    expect(rows.find((row) => row.key === waiting.key)?.checkAgain).toEqual({
      on: '2026-11-21',
      reason: 'Tomorrow',
    });
    expect(rows.find((row) => row.key === none.key)?.checkAgain).toBeNull();
  });

  it('mirrored tasks may hold one: it is not a Backlog.md field', async () => {
    const mirror = await createMirroredProject(ctx.db, world);
    const key = `${mirror.key}-${mirror.tasks.parent.number}`;
    const updated = await updateTask(clocked, world.ownerActor, {
      key,
      checkAgain: { on: '2026-12-01', reason: 'Wait for the release' },
    });
    expect(updated.checkAgain).toEqual({ on: '2026-12-01', reason: 'Wait for the release' });
  });
});

describe('work branch', () => {
  const cli = (branch: string | null): Actor => ({
    ...world.agentActor,
    source: { machine: 'kaggia', branch },
  });

  it('records the CLI branch on a move to In progress or In review, replacing an older one', async () => {
    const p = await newProject();
    const t = await createTask(clocked, world.memberActor, { project: p.key, title: 'Start me' });
    const started = await updateTask(clocked, cli('feat/retry'), { key: t.key, status: 'in_progress' });
    expect(started.workBranch).toBe('feat/retry');
    // Other writes leave it alone.
    const titled = await updateTask(clocked, cli('feat/other'), { key: t.key, title: 'Started' });
    expect(titled.workBranch).toBe('feat/retry');
    const review = await updateTask(clocked, cli('feat/retry-2'), { key: t.key, status: 'in_review' });
    expect(review.workBranch).toBe('feat/retry-2');
    // Done is not a start.
    const done = await updateTask(clocked, cli('feat/late'), { key: t.key, status: 'done' });
    expect(done.workBranch).toBe('feat/retry-2');

    const history = (await listTaskActivity(ctx, world.memberActor, { key: t.key })).items;
    expect(
      history.flatMap((entry) => entry.changes.filter((change) => change.field === 'workBranch')),
    ).toEqual([
      { field: 'workBranch', from: null, to: 'feat/retry' },
      { field: 'workBranch', from: 'feat/retry', to: 'feat/retry-2' },
    ]);

    const fresh = await createTask(clocked, cli('feat/fresh'), {
      project: p.key,
      title: 'Created started',
      status: 'in_progress',
    });
    expect(fresh.workBranch).toBe('feat/fresh');
  });

  it('skips the default branch, main and master while unknown, and people in the web app', async () => {
    const p = await newProject();
    const t = await createTask(clocked, world.memberActor, { project: p.key, title: 'Main' });
    expect(
      (await updateTask(clocked, cli('main'), { key: t.key, status: 'in_progress' })).workBranch,
    ).toBeNull();
    expect(
      (await updateTask(clocked, cli('master'), { key: t.key, status: 'in_review' })).workBranch,
    ).toBeNull();
    expect(
      (await updateTask(clocked, cli(null), { key: t.key, status: 'in_progress' })).workBranch,
    ).toBeNull();
    const session: Actor = { ...world.memberActor, source: { machine: null, branch: 'feat/web' } };
    expect((await updateTask(clocked, session, { key: t.key, status: 'in_review' })).workBranch).toBeNull();

    await createRepositoryLinkRow(ctx.db, scopeOf(p), { defaultBranch: 'trunk' });
    expect(
      (await updateTask(clocked, cli('trunk'), { key: t.key, status: 'in_progress' })).workBranch,
    ).toBeNull();
    // With the default branch known, main is an ordinary branch.
    expect((await updateTask(clocked, cli('main'), { key: t.key, status: 'in_review' })).workBranch).toBe(
      'main',
    );
  });

  it('links the open requests of the branch at once, keeping removed links removed', async () => {
    const p = await newProject({ repository: `https://github.com/northwind/payments-${randomProjectKey()}` });
    const scope = scopeOf(p);
    const open = await createPullRequestRow(ctx.db, scope, { number: 41, headBranch: 'feat/ledger' });
    const draft = await createPullRequestRow(ctx.db, scope, {
      number: 42,
      headBranch: 'feat/ledger',
      state: 'draft',
    });
    await createPullRequestRow(ctx.db, scope, { number: 43, headBranch: 'feat/ledger', state: 'closed' });
    const removed = await createPullRequestRow(ctx.db, scope, { number: 44, headBranch: 'feat/ledger' });
    await createPullRequestRow(ctx.db, scope, { number: 45, headBranch: 'feat/elsewhere' });
    const t = await createTask(clocked, world.memberActor, { project: p.key, title: 'Ledger' });
    await linkPullRequestRow(ctx.db, t.id, removed.id, {
      viaHand: true,
      removedAt: new Date(),
      removedById: world.member.id,
    });

    const started = await updateTask(clocked, cli('feat/ledger'), { key: t.key, status: 'in_progress' });
    expect(started.pullRequests?.map((request) => [request.number, request.how, request.state])).toEqual([
      [42, 'branch', 'draft'],
      [41, 'branch', 'open'],
    ]);
    const links = await ctx.db
      .select()
      .from(schema.taskPullRequest)
      .where(eq(schema.taskPullRequest.taskId, t.id));
    expect(links.find((link) => link.pullRequestId === removed.id)).toMatchObject({ viaBranch: false });
    expect(links.map((link) => link.pullRequestId).sort()).toEqual([open.id, draft.id, removed.id].sort());

    const history = (await listTaskActivity(ctx, world.memberActor, { key: t.key })).items;
    const linked = history.filter((entry) => entry.type === 'task.pull_request_linked');
    expect(linked.map((entry) => entry.changes)).toEqual([
      [
        {
          field: 'pullRequest',
          from: null,
          to: {
            provider: 'github',
            number: 41,
            title: 'Request 41',
            url: 'https://github.com/northwind/payments/pull/41',
            how: 'branch',
          },
        },
      ],
      [
        {
          field: 'pullRequest',
          from: null,
          to: {
            provider: 'github',
            number: 42,
            title: 'Request 42',
            url: 'https://github.com/northwind/payments/pull/42',
            how: 'branch',
          },
        },
      ],
    ]);
    expect(linked.every((entry) => entry.actor?.id === world.agent.id)).toBe(true);

    // Recording the same branch again links nothing new.
    await updateTask(clocked, cli('feat/ledger'), { key: t.key, status: 'in_review' });
    const again = (await listTaskActivity(ctx, world.memberActor, { key: t.key })).items;
    expect(again.filter((entry) => entry.type === 'task.pull_request_linked')).toHaveLength(2);
  });
});

describe('request fields', () => {
  it('shows linked requests on the task and the newest with a count on rows', async () => {
    const p = await newProject();
    const scope = scopeOf(p);
    const t = await createTask(clocked, world.memberActor, { project: p.key, title: 'Two requests' });
    const older = await createPullRequestRow(ctx.db, scope, {
      number: 7,
      openedAt: new Date('2026-11-01T00:00:00Z'),
      state: 'merged',
      mergedAt: new Date('2026-11-03T00:00:00Z'),
      mergedBy: 'ana',
      author: 'claude-dev',
      webUrl: 'https://gitlab.example.com/northwind/payments/-/merge_requests/7',
    });
    const newer = await createPullRequestRow(ctx.db, scope, {
      number: 9,
      openedAt: new Date('2026-11-05T00:00:00Z'),
      webUrl: 'https://gitlab.example.com/northwind/payments/-/merge_requests/9',
    });
    const gone = await createPullRequestRow(ctx.db, scope, { number: 11 });
    await linkPullRequestRow(ctx.db, t.id, older.id, { viaHand: true, linkedById: world.owner.id });
    await linkPullRequestRow(ctx.db, t.id, newer.id, { viaDescription: true });
    await linkPullRequestRow(ctx.db, t.id, gone.id, { removedAt: new Date(), removedById: world.owner.id });

    const got = await getTask(clocked, world.memberActor, { key: t.key });
    expect(got.pullRequests).toMatchObject([
      { provider: 'gitlab', number: 9, how: 'description', state: 'open', linkedBy: null },
      {
        provider: 'gitlab',
        number: 7,
        how: 'hand',
        state: 'merged',
        mergedBy: 'ana',
        author: 'claude-dev',
        linkedBy: { id: world.owner.id },
        mergedAt: '2026-11-03T00:00:00.000Z',
      },
    ]);
    const [row] = (await listTasks(clocked, world.memberActor, { project: [p.key] })).items;
    expect(row?.pullRequest).toEqual({
      provider: 'gitlab',
      number: 9,
      title: 'Request 9',
      url: 'https://gitlab.example.com/northwind/payments/-/merge_requests/9',
      state: 'open',
    });
    expect(row?.pullRequestCount).toBe(2);
  });
});

describe('setStatusFromSource', () => {
  const cause = (event: 'opened' | 'merged', number = 482): ActivityCause => ({
    kind: 'pull_request',
    provider: 'github',
    number,
    title: 'Retry webhooks',
    url: `https://github.com/northwind/payments/pull/${number}`,
    event,
    by: 'claude-dev',
  });

  it('moves the task as the system with the cause, origin git and the request URL', async () => {
    const p = await newProject();
    const milestone = await createMilestoneRow(ctx.db, scopeOf(p), { createdById: world.owner.id });
    const t = await createTask(clocked, world.memberActor, {
      project: p.key,
      title: 'Retry',
      status: 'in_progress',
      milestone: milestone.id,
    });
    const other = await createTask(clocked, world.memberActor, {
      project: p.key,
      title: 'Top',
      status: 'in_review',
    });
    const result = await ctx.db.transaction((tx) =>
      setStatusFromSource(tx, clocked, {
        workspaceId: world.workspaceId,
        taskId: t.id,
        status: 'in_review',
        cause: cause('opened'),
      }),
    );
    expect(result).toEqual({ changed: true, from: 'in_progress' });
    const row = await rowOf(t.id);
    const otherRow = await rowOf(other.id);
    expect(row.status).toBe('in_review');
    expect(row.rank).toBeLessThan(otherRow.rank);

    const timeline = await listTaskTimeline(ctx, world.memberActor, { key: t.key, show: 'history' });
    const last = timeline.items.at(-1);
    expect(last).toMatchObject({
      kind: 'activity',
      type: 'task.updated',
      actor: null,
      origin: 'git',
      originRef: 'https://github.com/northwind/payments/pull/482',
      cause: cause('opened'),
      system: { kind: 'git', provider: 'github' },
      changes: [{ field: 'status', from: 'in_progress', to: 'in_review' }],
    });
    // A person's entry names no system actor.
    expect(timeline.items[0]).toMatchObject({ system: null, cause: null });
  });

  it('a merge to Done sets closed_at, clears the day and flags open items', async () => {
    const p = await newProject();
    const t = await createTask(clocked, world.memberActor, {
      project: p.key,
      title: 'Merged with open criteria',
      status: 'in_review',
      criteria: ['Refunds post a ledger entry', 'Partial refunds keep the remainder'],
      checkAgain: { on: '2026-12-01', reason: 'Check the rollout' },
    });
    await updateTask(clocked, world.memberActor, { key: t.key, checkCriteria: [1] });
    const result = await ctx.db.transaction((tx) =>
      setStatusFromSource(tx, clocked, {
        workspaceId: world.workspaceId,
        taskId: t.id,
        status: 'done',
        cause: cause('merged'),
      }),
    );
    expect(result.changed).toBe(true);
    const got = await getTask(clocked, world.memberActor, { key: t.key });
    expect(got).toMatchObject({
      status: 'done',
      closedAt: NOW.toISOString(),
      checkAgain: null,
      mergedOpen: { at: NOW.toISOString(), openCriteria: 1, openDoneItems: 0 },
    });
    const [last] = (await listTaskActivity(ctx, world.memberActor, { key: t.key })).items.slice(-1);
    expect(last?.changes).toEqual([
      { field: 'status', from: 'in_review', to: 'done' },
      { field: 'checkAgain', from: { on: '2026-12-01', reason: 'Check the rollout' }, to: null },
    ]);

    // Settling the last item ends the flag.
    const settled = await updateTask(clocked, world.memberActor, {
      key: t.key,
      waiveCriteria: [{ number: 2, reason: 'Out of scope' }],
    });
    expect(settled.mergedOpen).toBeNull();

    // A merge of a task without open items sets no flag.
    const clean = await createTask(clocked, world.memberActor, {
      project: p.key,
      title: 'Clean',
      status: 'in_review',
    });
    await ctx.db.transaction((tx) =>
      setStatusFromSource(tx, clocked, {
        workspaceId: world.workspaceId,
        taskId: clean.id,
        status: 'done',
        cause: cause('merged', 483),
      }),
    );
    expect((await rowOf(clean.id)).mergedDoneAt).toBeNull();
  });

  it('skips mirrored and archived tasks and tasks with the status already', async () => {
    const p = await newProject();
    const same = await createTask(clocked, world.memberActor, {
      project: p.key,
      title: 'Same',
      status: 'in_review',
    });
    const archived = await createTask(clocked, world.memberActor, { project: p.key, title: 'Archived' });
    await ctx.db.update(task).set({ archivedAt: NOW }).where(eq(task.id, archived.id));
    const mirror = await createMirroredProject(ctx.db, world);
    const run = (taskId: string) =>
      ctx.db.transaction((tx) =>
        setStatusFromSource(tx, clocked, {
          workspaceId: world.workspaceId,
          taskId,
          status: 'in_review',
          cause: cause('opened'),
        }),
      );
    expect(await run(same.id)).toEqual({ changed: false, from: 'in_review' });
    expect(await run(archived.id)).toEqual({ changed: false, from: 'todo' });
    expect(await run(mirror.tasks.parent.id)).toEqual({ changed: false, from: 'in_progress' });
    expect((await rowOf(mirror.tasks.parent.id)).status).toBe('in_progress');
    const entries = await ctx.db
      .select()
      .from(schema.activity)
      .where(and(eq(schema.activity.taskId, archived.id), eq(schema.activity.origin, 'git')));
    expect(entries).toEqual([]);
  });

  it('finds tasks of the named workspace only', async () => {
    const other = await createWorld(ctx.db, 'Globex');
    const key = randomProjectKey();
    await createProject(ctx, other.ownerActor, { key, name: 'Elsewhere' });
    const t = await createTask(clocked, other.memberActor, { project: key, title: 'Not yours' });
    await rejection(
      ctx.db.transaction((tx) =>
        setStatusFromSource(tx, clocked, {
          workspaceId: world.workspaceId,
          taskId: t.id,
          status: 'in_review',
          cause: cause('opened'),
        }),
      ),
      NotFound,
    );
    expect((await rowOf(t.id)).status).toBe('todo');
  });
});

describe('item operations count towards the merged flag', () => {
  it('reads open done items too', async () => {
    const p = await newProject();
    const t = await createTask(clocked, world.memberActor, {
      project: p.key,
      title: 'Done items',
      status: 'in_review',
    });
    await createTaskItemRows(ctx.db, t.id, 'done', ['Docs updated', 'Changelog line']);
    await ctx.db.transaction((tx) =>
      setStatusFromSource(tx, clocked, {
        workspaceId: world.workspaceId,
        taskId: t.id,
        status: 'done',
        cause: {
          kind: 'pull_request',
          provider: 'gitea',
          number: 5,
          title: 'Docs',
          url: 'https://forgejo.example.com/northwind/payments/pulls/5',
          event: 'merged',
          by: null,
        },
      }),
    );
    const got = await getTask(clocked, world.memberActor, { key: t.key });
    expect(got.mergedOpen).toMatchObject({ openCriteria: 0, openDoneItems: 2 });
    const timeline = await listTaskTimeline(ctx, world.memberActor, { key: t.key, show: 'history' });
    expect(timeline.items.at(-1)).toMatchObject({ system: { kind: 'git', provider: 'gitea' } });
  });
});
