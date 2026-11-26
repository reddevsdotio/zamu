// M7 archive: archiving and restoring by hand (bulk, all or nothing, mirrored refused), the
// read-only rule on every task write, the Archived list filter and the counts that leave archived
// tasks out, and the nightly job with its preview, on an injected clock.
//
// The nightly job reads every project of the shared test database, so its clock sits in 1999:
// tasks other test files close (now, or on their own clocks from 2000 on) are never due then.
import { schema } from '@zamu/db';
import { and, eq, inArray } from 'drizzle-orm';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { listTaskActivity } from './activity';
import { archiveDueTasks, archivePreview, archiveTasks, restoreTasks, TaskArchived } from './archive';
import type { Actor } from './authz';
import { createComment, deleteComment, updateComment } from './comments';
import type { ClockContext } from './cycles';
import { getDashboard } from './dashboard';
import { Forbidden, NotFound, TaskMirrored } from './errors';
import { getHome } from './home';
import { createProject, listProjects } from './projects';
import { problemCodeOf } from './relations';
import { bulkUpdateTasks, createTask, getTask, listTasks, updateTask } from './tasks';
import { createMirroredProject } from './testing/backlog';
import {
  createTaskItemRows,
  createTaskRow,
  createWorld,
  keyActor,
  projectRow,
  randomProjectKey,
  type TestContext,
  testContext,
  type World,
} from './testing/fixtures';
import { listTaskTimeline } from './timeline';

const { activity, project, task } = schema;

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

async function newProject() {
  const key = randomProjectKey();
  await createProject(ctx, world.ownerActor, { key, name: `Payments ${key}` });
  return projectRow(ctx.db, world.workspaceId, key);
}

async function rowsOf(ids: string[]) {
  return ctx.db.select().from(task).where(inArray(task.id, ids));
}

describe('archiving by hand', () => {
  it('archives tasks in any status, all at once, and returns them in the order sent', async () => {
    const p = await newProject();
    const a = await createTask(clocked, world.memberActor, { project: p.key, title: 'Open' });
    const b = await createTask(clocked, world.memberActor, { project: p.key, title: 'Done', status: 'done' });
    const c = await createTask(clocked, world.memberActor, {
      project: p.key,
      title: 'Review',
      status: 'in_review',
    });
    const result = await archiveTasks(clocked, world.agentActor, { keys: [c.key, a.key, b.key] });
    expect(result.items.map((item) => [item.key, item.archivedAt])).toEqual([
      [c.key, NOW.toISOString()],
      [a.key, NOW.toISOString()],
      [b.key, NOW.toISOString()],
    ]);
    const got = await getTask(clocked, world.memberActor, { key: a.key });
    expect(got).toMatchObject({
      archivedAt: NOW.toISOString(),
      archivedBy: { id: world.agent.id },
      status: 'todo',
    });

    const history = (await listTaskActivity(ctx, world.memberActor, { key: a.key })).items;
    expect(history.at(-1)).toMatchObject({
      type: 'task.archived',
      actor: { id: world.agent.id },
      changes: [],
    });

    // Archiving again changes nothing and writes no row.
    await archiveTasks(clocked, world.memberActor, { keys: [a.key] });
    const again = (await listTaskActivity(ctx, world.memberActor, { key: a.key })).items;
    expect(again.filter((entry) => entry.type === 'task.archived')).toHaveLength(1);
  });

  it('is all or nothing', async () => {
    const p = await newProject();
    const a = await createTask(clocked, world.memberActor, { project: p.key, title: 'Kept' });
    await rejection(archiveTasks(clocked, world.memberActor, { keys: [a.key, `${p.key}-999`] }), NotFound);
    const [row] = await rowsOf([a.id]);
    expect(row?.archivedAt).toBeNull();
  });

  it('refuses mirrored tasks and read-only keys', async () => {
    const p = await newProject();
    const a = await createTask(clocked, world.memberActor, { project: p.key, title: 'Native' });
    const mirror = await createMirroredProject(ctx.db, world);
    const mirrored = `${mirror.key}-${mirror.tasks.parent.number}`;
    const error = await rejection(
      archiveTasks(clocked, world.ownerActor, { keys: [a.key, mirrored] }),
      TaskMirrored,
    );
    expect(error.message).toContain('archive/tasks/');
    await rejection(restoreTasks(clocked, world.ownerActor, { keys: [mirrored] }), TaskMirrored);
    expect((await rowsOf([a.id]))[0]?.archivedAt).toBeNull();

    const reader: Actor = keyActor(world, { projects: 'all', access: 'read' });
    await rejection(archiveTasks(clocked, reader, { keys: [a.key] }), Forbidden);
  });

  it('restores tasks, giving closed ones their days again from now', async () => {
    const p = await newProject();
    const open = await createTask(clocked, world.memberActor, { project: p.key, title: 'Open' });
    const done = await createTask(clocked, world.memberActor, {
      project: p.key,
      title: 'Done',
      status: 'done',
    });
    await archiveTasks(clocked, world.memberActor, { keys: [open.key, done.key] });
    const later = new Date(NOW.getTime() + 86_400_000);
    const result = await restoreTasks({ ...clocked, now: () => later }, world.memberActor, {
      keys: [open.key, done.key],
    });
    expect(result.items.map((item) => item.archivedAt)).toEqual([null, null]);
    const rows = new Map((await rowsOf([open.id, done.id])).map((row) => [row.id, row]));
    expect(rows.get(open.id)).toMatchObject({ archivedAt: null, archivedById: null, closedAt: null });
    expect(rows.get(done.id)?.closedAt?.toISOString()).toBe(later.toISOString());
    const history = (await listTaskActivity(ctx, world.memberActor, { key: done.key })).items;
    expect(history.at(-1)).toMatchObject({ type: 'task.unarchived', actor: { id: world.member.id } });
  });
});

describe('the read-only rule', () => {
  it('refuses every task write but restore with TASK_ARCHIVED', async () => {
    const p = await newProject();
    const t = await createTask(clocked, world.memberActor, {
      project: p.key,
      title: 'Read-only',
      criteria: ['Ledger entry'],
    });
    const other = await createTask(clocked, world.memberActor, { project: p.key, title: 'Other' });
    await archiveTasks(clocked, world.memberActor, { keys: [t.key] });

    const refused = await rejection(
      updateTask(clocked, world.memberActor, { key: t.key, title: 'New' }),
      TaskArchived,
    );
    expect(problemCodeOf(refused)).toBe('TASK_ARCHIVED');
    expect(refused.message).toBe(`${t.key} is archived, so it can't change. Restore it first.`);
    await rejection(updateTask(clocked, world.memberActor, { key: t.key, checkCriteria: [1] }), TaskArchived);
    await rejection(
      updateTask(clocked, world.memberActor, {
        key: t.key,
        checkAgain: { on: '2026-12-01', reason: 'Later' },
      }),
      TaskArchived,
    );
    // A no-op patch is refused too: the task is read-only.
    await rejection(updateTask(clocked, world.memberActor, { key: t.key, title: 'Read-only' }), TaskArchived);

    const bulk = await rejection(
      bulkUpdateTasks(clocked, world.memberActor, { keys: [other.key, t.key], priority: 'high' }),
      TaskArchived,
    );
    expect(bulk.issues).toEqual([
      { path: 'keys.1', message: `${t.key} is archived, so it can't change. Restore it first.` },
    ]);
    const [otherRow] = await rowsOf([other.id]);
    expect(otherRow?.priority).toBe(0);

    await restoreTasks(clocked, world.memberActor, { keys: [t.key] });
    expect((await updateTask(clocked, world.memberActor, { key: t.key, title: 'Writable' })).title).toBe(
      'Writable',
    );
  });

  it('refuses comments and notes on an archived task, new ones and edits', async () => {
    const p = await newProject();
    const t = await createTask(clocked, world.memberActor, { project: p.key, title: 'Quiet' });
    const before = await createComment(clocked, world.memberActor, { key: t.key, body: 'Written before' });
    await archiveTasks(clocked, world.memberActor, { keys: [t.key] });

    await rejection(createComment(clocked, world.memberActor, { key: t.key, body: 'Hello' }), TaskArchived);
    await rejection(
      createComment(clocked, world.agentActor, { key: t.key, body: 'A note', kind: 'note' }),
      TaskArchived,
    );
    await rejection(
      updateComment(clocked, world.memberActor, { id: before.id, body: 'Changed' }),
      TaskArchived,
    );
    await rejection(deleteComment(clocked, world.memberActor, { id: before.id }), TaskArchived);

    await restoreTasks(clocked, world.memberActor, { keys: [t.key] });
    const after = await createComment(clocked, world.memberActor, { key: t.key, body: 'Back again' });
    expect(after.body).toBe('Back again');
  });
});

describe('where archived tasks show', () => {
  it('lists leave them out unless asked, and counts leave them out', async () => {
    const p = await newProject();
    const kept = await createTask(clocked, world.memberActor, {
      project: p.key,
      title: 'Kept',
      status: 'in_review',
    });
    const gone = await createTask(clocked, world.memberActor, {
      project: p.key,
      title: 'Gone',
      status: 'in_review',
      assignee: world.member.id,
    });
    await archiveTasks(clocked, world.memberActor, { keys: [gone.key] });

    const list = async (archived?: 'exclude' | 'include' | 'only') =>
      listTasks(clocked, world.memberActor, { project: [p.key], ...(archived ? { archived } : {}) });
    expect((await list()).items.map((item) => item.key)).toEqual([kept.key]);
    expect((await list()).counts.in_review).toBe(1);
    expect((await list('exclude')).items.map((item) => item.key)).toEqual([kept.key]);
    expect((await list('include')).items.map((item) => item.key).sort()).toEqual([kept.key, gone.key].sort());
    expect((await list('only')).items.map((item) => [item.key, item.archivedAt])).toEqual([
      [gone.key, NOW.toISOString()],
    ]);

    const projects = await listProjects(clocked, world.memberActor);
    expect(projects.items.find((item) => item.key === p.key)?.openCounts.in_review).toBe(1);

    const dashboard = await getDashboard(clocked, world.ownerActor, { scope: 'everyone' });
    const reviewKeys = dashboard.groups.review.items.map((item) => item.task.key);
    expect(reviewKeys).toContain(kept.key);
    expect(reviewKeys).not.toContain(gone.key);
    expect(dashboard.projects.find((row) => row.key === p.key)?.openCounts.in_review).toBe(1);

    const home = await getHome(clocked, world.ownerActor, { tab: 'everyone', project: [p.key] });
    const homeKeys = home.groups.flatMap((group) => group.items.map((item) => item.task.key));
    expect(homeKeys).toEqual([kept.key]);

    // An archived task still opens by key, with its timeline.
    expect((await getTask(clocked, world.memberActor, { key: gone.key })).archivedAt).toBe(NOW.toISOString());
    expect((await listTaskTimeline(ctx, world.memberActor, { key: gone.key })).items.length).toBeGreaterThan(
      0,
    );
  });
});

describe('archive setting, preview and the nightly job', () => {
  // 1999-06-15 03:00 UTC: today is the 15th in UTC, still the 14th in New York.
  const JOB_NOW = new Date('1999-06-15T03:00:00.000Z');
  const at = (iso: string) => new Date(iso);

  it('archives Done and Canceled tasks the set days after they closed, except merged ones with open items', async () => {
    const p = await newProject();
    expect(p.archiveAfterDays).toBe(14);
    const make = (values: Partial<typeof task.$inferInsert>) =>
      createTaskRow(ctx.db, p.id, { createdById: world.owner.id, status: 'done', ...values });
    const due = await make({ closedAt: at('1999-05-20T12:00:00Z') });
    const edge = await make({ status: 'canceled', closedAt: at('1999-06-01T23:59:00Z') });
    const young = await make({ closedAt: at('1999-06-02T00:00:00Z') });
    const open = await make({ status: 'in_progress', closedAt: null });
    const mergedOpen = await make({
      closedAt: at('1999-05-01T00:00:00Z'),
      mergedDoneAt: at('1999-05-01T00:00:00Z'),
    });
    await createTaskItemRows(ctx.db, mergedOpen.id, 'criterion', ['Still open']);
    const mergedSettled = await make({
      closedAt: at('1999-05-01T00:00:00Z'),
      mergedDoneAt: at('1999-05-01T00:00:00Z'),
    });
    await createTaskItemRows(ctx.db, mergedSettled.id, 'criterion', [{ text: 'Checked', state: 'checked' }]);
    const already = await make({
      closedAt: at('1999-05-01T00:00:00Z'),
      archivedAt: at('1999-05-20T00:00:00Z'),
    });

    const jobCtx = { ...ctx, timeZone: 'UTC', now: () => JOB_NOW };
    const preview = await archivePreview(jobCtx, world.memberActor, { project: p.key, days: 14 });
    expect(preview).toEqual({ project: p.key, days: 14, count: 3 });
    expect((await archivePreview(jobCtx, world.memberActor, { project: p.key, days: 30 })).count).toBe(1);
    // In New York it is still the 14th: the task closed on the 1st waits one more day.
    const newYork = { ...jobCtx, timeZone: 'America/New_York' };
    expect((await archivePreview(newYork, world.memberActor, { project: p.key, days: 14 })).count).toBe(2);

    const first = await archiveDueTasks(jobCtx, { now: JOB_NOW });
    expect(first.archived).toBeGreaterThanOrEqual(3);
    const rows = new Map(
      (await rowsOf([due.id, edge.id, young.id, open.id, mergedOpen.id, mergedSettled.id, already.id])).map(
        (row) => [row.id, row],
      ),
    );
    const archived = (id: string) => rows.get(id)?.archivedAt?.toISOString() ?? null;
    expect(archived(due.id)).toBe(JOB_NOW.toISOString());
    expect(archived(edge.id)).toBe(JOB_NOW.toISOString());
    expect(archived(mergedSettled.id)).toBe(JOB_NOW.toISOString());
    expect(archived(young.id)).toBeNull();
    expect(archived(open.id)).toBeNull();
    expect(archived(mergedOpen.id)).toBeNull();
    expect(archived(already.id)).toBe('1999-05-20T00:00:00.000Z');
    expect(rows.get(due.id)?.archivedById).toBeNull();

    const entries = await ctx.db
      .select()
      .from(activity)
      .where(and(eq(activity.projectId, p.id), eq(activity.type, 'task.archived')));
    expect(entries.map((entry) => entry.taskId).sort()).toEqual([due.id, edge.id, mergedSettled.id].sort());
    expect(entries[0]).toMatchObject({
      actorId: null,
      origin: 'app',
      cause: { kind: 'archive', afterDays: 14 },
    });
    const timeline = await listTaskTimeline(ctx, world.memberActor, { key: `${p.key}-${due.number}` });
    expect(timeline.items.at(-1)).toMatchObject({
      type: 'task.archived',
      actor: null,
      system: { kind: 'zamu' },
      cause: { kind: 'archive', afterDays: 14 },
    });

    // Idempotent: a second run archives nothing more here.
    await archiveDueTasks(jobCtx, { now: JOB_NOW });
    const after = await ctx.db
      .select()
      .from(activity)
      .where(and(eq(activity.projectId, p.id), eq(activity.type, 'task.archived')));
    expect(after).toHaveLength(3);
  });

  it('skips projects with archiving off and mirrored projects', async () => {
    const off = await newProject();
    await ctx.db.update(project).set({ archiveAfterDays: null }).where(eq(project.id, off.id));
    const offTask = await createTaskRow(ctx.db, off.id, {
      createdById: world.owner.id,
      status: 'done',
      closedAt: at('1999-01-01T00:00:00Z'),
    });
    const mirror = await createMirroredProject(ctx.db, world);
    await ctx.db.update(project).set({ archiveAfterDays: 1 }).where(eq(project.id, mirror.project.id));
    await ctx.db
      .update(task)
      .set({ closedAt: at('1999-01-01T00:00:00Z') })
      .where(eq(task.id, mirror.tasks.hidden.id));

    const jobCtx = { ...ctx, timeZone: 'UTC', now: () => JOB_NOW };
    await archiveDueTasks(jobCtx, { now: JOB_NOW });
    const rows = await rowsOf([offTask.id, mirror.tasks.hidden.id]);
    expect(rows.map((row) => row.archivedAt)).toEqual([null, null]);
    expect((await archivePreview(jobCtx, world.memberActor, { project: mirror.key, days: 1 })).count).toBe(0);
  });
});
