import {
  HOME_GROUP_ITEM_LIMIT,
  type Home,
  type HomeGroupKey,
  type HomeItem,
  type HomeTab,
} from '@zamu/contracts';
import { schema } from '@zamu/db';
import { eq } from 'drizzle-orm';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import type { Actor } from './authz';
import { createComment } from './comments';
import { addCalendarDays, type ClockContext, nextMonday, todayIn } from './cycles';
import { getHome, getHomeCounts } from './home';
import { formatMention } from './mentions';
import { createProject } from './projects';
import {
  createCycleRow,
  createMilestoneRow,
  createTaskRow,
  createUser,
  createWorld,
  projectRow,
  randomProjectKey,
  scopeOf,
  type TestContext,
  testContext,
  type World,
} from './testing/fixtures';

const HOUR = 3_600_000;
const { activity, label, member, task, taskDependency, taskItem, taskLabel } = schema;

let ctx: TestContext;

beforeAll(() => {
  ctx = testContext();
});
afterAll(async () => {
  await ctx?.close();
});

function clock(): TestContext & ClockContext {
  const now = new Date();
  return { ...ctx, timeZone: 'UTC', now: () => now };
}

const today = () => todayIn(clock());
const day = (days: number) => addCalendarDays(today(), days);
const ago = (hours: number) => new Date(Date.now() - hours * HOUR);
const mention = (user: { id: string; name: string }) => formatMention(user.name, user.id);

function home(actor: Actor, tab: HomeTab = 'mine', filters: Record<string, unknown> = {}): Promise<Home> {
  return getHome(clock(), actor, { tab, ...filters });
}

type ProjectRow = Awaited<ReturnType<typeof projectRow>>;
type TaskRow = typeof task.$inferSelect;

async function newProject(world: World, name?: string): Promise<ProjectRow> {
  const key = randomProjectKey();
  await createProject(ctx, world.ownerActor, { key, name: name ?? `Project ${key}` });
  return projectRow(ctx.db, world.workspaceId, key);
}

/** A raw task row in `p`, created by the owner unless given. */
function rawTask(world: World, p: ProjectRow, values: Partial<typeof task.$inferInsert> = {}) {
  return createTaskRow(ctx.db, p.id, { createdById: world.owner.id, ...values });
}

const keyOf = (p: ProjectRow, row: { number: number }) => `${p.key}-${row.number}`;
const group = (result: Home, key: HomeGroupKey) => {
  const found = result.groups.find((g) => g.key === key);
  if (!found) throw new Error(`no group ${key}`);
  return found;
};
const keys = (items: HomeItem[]) => items.map((item) => item.task.key);
const itemOf = (result: Home, key: string) => {
  for (const g of result.groups) {
    const item = g.items.find((i) => i.task.key === key);
    if (item) return { group: g.key, item };
  }
  return null;
};

async function blockedBy(blocked: TaskRow, ...blockers: TaskRow[]) {
  await ctx.db.insert(taskDependency).values(blockers.map((b) => ({ taskId: blocked.id, blockerId: b.id })));
}

async function addLabel(p: ProjectRow, name: string, color = 1) {
  const [row] = await ctx.db
    .insert(label)
    .values({ workspaceId: p.workspaceId, projectId: p.id, name, color })
    .returning();
  if (!row) throw new Error('label insert failed');
  return row;
}

async function tag(t: TaskRow, ...labels: { id: string }[]) {
  await ctx.db.insert(taskLabel).values(labels.map((l) => ({ taskId: t.id, labelId: l.id })));
}

async function activityRow(
  world: World,
  p: ProjectRow,
  t: TaskRow,
  values: Partial<typeof activity.$inferInsert> = {},
) {
  await ctx.db.insert(activity).values({
    workspaceId: world.workspaceId,
    projectId: p.id,
    taskId: t.id,
    type: 'task.updated',
    changes: [{ field: 'title', from: 'a', to: 'b' }],
    ...values,
  });
}

// ---------------------------------------------------------------------------

describe('Mine', () => {
  // Me is the member (Tomás); world.agent acts for him.
  let world: World;
  let p: ProjectRow;
  const t: Record<string, TaskRow> = {};
  let result: Home;

  beforeAll(async () => {
    world = await createWorld(ctx.db);
    p = await newProject(world, 'Harbor');
    const me = world.member.id;
    const other = world.owner.id;
    const openBlocker = await rawTask(world, p, { status: 'todo', title: 'Open blocker' });
    const doneBlocker = await rawTask(world, p, { status: 'done' });
    const hiddenBlocker = await rawTask(world, p, { status: 'todo', hiddenAt: new Date() });

    // review: my agent's task, blocked and overdue too (pills); the agent asked.
    t.agentReview = await rawTask(world, p, {
      status: 'in_review',
      assigneeId: world.agent.id,
      dueDate: day(-3),
      priority: 3,
    });
    await blockedBy(t.agentReview, openBlocker);
    await activityRow(world, p, t.agentReview, {
      actorId: world.agent.id,
      onBehalfOfId: me,
      changes: [{ field: 'status', from: 'in_progress', to: 'in_review' }],
      createdAt: ago(2),
    });
    // review: a teammate's task I created waits on me.
    t.createdReview = await rawTask(world, p, { status: 'in_review', assigneeId: other, createdById: me });
    // not review: my own task In review waits on its creator (the owner); lands in assigned.
    t.ownReview = await rawTask(world, p, { status: 'in_review', assigneeId: me, priority: 1 });
    // mentions: the owner asks me on their task; it also blocks a task of mine.
    t.mentioned = await rawTask(world, p, {
      assigneeId: other,
      cycleId: (await createCycleRow(ctx.db, scopeOf(p))).id,
    });
    await createComment(ctx, world.ownerActor, {
      key: keyOf(p, t.mentioned),
      body: `${mention(world.member)} ok?`,
    });
    // mentions: the agent asks me (question pill).
    t.agentAsks = await rawTask(world, p, { assigneeId: other });
    await createComment(ctx, world.agentActor, {
      key: keyOf(p, t.agentAsks),
      body: `${mention(world.member)} which retry policy?`,
    });
    // answered mention: gone.
    t.answered = await rawTask(world, p, { assigneeId: other });
    await createComment(ctx, world.ownerActor, {
      key: keyOf(p, t.answered),
      body: `${mention(world.member)}?`,
    });
    await createComment(ctx, world.memberActor, { key: keyOf(p, t.answered), body: 'Done.' });
    // blocked: mine, waits on an open blocker and on the mentioned task.
    t.blocked = await rawTask(world, p, { assigneeId: me, dueDate: day(5) });
    await blockedBy(t.blocked, openBlocker, t.mentioned);
    // not blocked: only a done and a hidden blocker.
    t.notBlocked = await rawTask(world, p, { assigneeId: me, priority: 2 });
    await blockedBy(t.notBlocked, doneBlocker, hiddenBlocker);
    // overdue: mine, and one I created that nobody holds.
    t.overdue = await rawTask(world, p, { assigneeId: me, dueDate: day(-2), priority: 4 });
    t.needsOwner = await rawTask(world, p, { createdById: me, dueDate: day(-1) });
    // assigned: by due date (none last), then priority.
    t.dueToday = await rawTask(world, p, { assigneeId: me, dueDate: day(0), priority: 1 });
    t.dueLater = await rawTask(world, p, { assigneeId: me, dueDate: day(9), priority: 4 });
    // my agent's own work: not in Mine (Agents tab), even when overdue or blocked.
    t.agentTask = await rawTask(world, p, { assigneeId: world.agent.id, priority: 4 });
    t.agentOverdue = await rawTask(world, p, { assigneeId: world.agent.id, dueDate: day(-1) });
    t.agentBlocked = await rawTask(world, p, { assigneeId: world.agent.id });
    await blockedBy(t.agentBlocked, openBlocker);
    // never: hidden, done, someone else's.
    t.hidden = await rawTask(world, p, { assigneeId: me, hiddenAt: new Date(), dueDate: day(-1) });
    t.done = await rawTask(world, p, { assigneeId: me, status: 'done', dueDate: day(-1) });
    t.others = await rawTask(world, p, { assigneeId: other, dueDate: day(-1) });

    result = await home(world.memberActor);
  });

  const k = (name: string) => keyOf(p, t[name] as TaskRow);

  it('returns the Mine groups in order, each task once, in its first group', () => {
    expect(result.tab).toBe('mine');
    expect(result.groups.map((g) => g.key)).toEqual([
      'review',
      'mergedOpen',
      'checkAgain',
      'mentions',
      'blocked',
      'overdue',
      'assigned',
    ]);
    const all = result.groups.flatMap((g) => keys(g.items));
    expect(new Set(all).size).toBe(all.length);
    expect(keys(group(result, 'review').items).sort()).toEqual([k('agentReview'), k('createdReview')].sort());
    expect(keys(group(result, 'mentions').items).sort()).toEqual([k('agentAsks'), k('mentioned')].sort());
    expect(keys(group(result, 'blocked').items)).toEqual([k('blocked')]);
    expect(keys(group(result, 'overdue').items)).toEqual([k('overdue'), k('needsOwner')]);
    expect(keys(group(result, 'assigned').items)).toEqual([
      k('dueToday'),
      k('dueLater'),
      k('notBlocked'),
      k('ownReview'),
    ]);
    for (const name of [
      'hidden',
      'done',
      'others',
      'answered',
      'agentTask',
      'agentOverdue',
      'agentBlocked',
    ]) {
      expect(itemOf(result, k(name))).toBeNull();
    }
  });

  it('gives the review reason with who asked and who it waits on, and the other states as pills', () => {
    const review = itemOf(result, k('agentReview'));
    expect(review?.item.reason).toMatchObject({
      kind: 'review',
      requestedBy: { id: world.agent.id },
      onBehalfOf: { id: world.member.id },
      waitingOn: { id: world.member.id },
    });
    expect(review?.item.relation).toBe('agent');
    expect(review?.item.pills).toEqual([{ kind: 'blocked' }, { kind: 'overdue', daysOverdue: 3 }]);
    expect(review?.item.task).toMatchObject({ blocked: true, dueDate: day(-3), priority: 'high' });

    const created = itemOf(result, k('createdReview'));
    expect(created?.item.reason).toMatchObject({
      kind: 'review',
      requestedBy: null,
      waitingOn: { id: world.member.id },
    });
    expect(created?.item.relation).toBeNull();
  });

  it('gives mentions their comment, the question pill for agents and the blocks count', () => {
    const asks = itemOf(result, k('agentAsks'));
    expect(asks?.item.reason).toMatchObject({
      kind: 'mention',
      author: { id: world.agent.id },
      onBehalfOf: { id: world.member.id },
      mentioned: { id: world.member.id },
    });
    expect(asks?.item.reason.kind === 'mention' && asks.item.reason.comment.excerpt).toBe(
      `@${world.member.name} which retry policy?`,
    );
    expect(asks?.item.pills).toEqual([{ kind: 'question' }]);
    const mentioned = itemOf(result, k('mentioned'));
    expect(mentioned?.item.pills).toEqual([
      { kind: 'blocks', count: 1 },
      { kind: 'cycle', cycle: { number: 1, name: null } },
    ]);
  });

  it('names the open blockers, and the overdue and creator rows', () => {
    const blocked = itemOf(result, k('blocked'));
    expect(blocked?.item.reason).toEqual({
      kind: 'blocked',
      blockers: [
        { key: `${p.key}-1`, title: 'Open blocker', status: 'todo', assignee: null },
        expect.objectContaining({
          key: k('mentioned'),
          assignee: expect.objectContaining({ id: world.owner.id }),
        }),
      ],
    });
    expect(blocked?.item.relation).toBe('assignee');
    const owner = itemOf(result, k('needsOwner'));
    expect(owner?.item).toMatchObject({
      reason: { kind: 'overdue', dueDate: day(-1), daysOverdue: 1 },
      relation: 'creator',
      pills: [{ kind: 'unassigned' }],
    });
    const dueToday = itemOf(result, k('dueToday'));
    expect(dueToday?.item).toMatchObject({
      reason: { kind: 'assigned' },
      pills: [{ kind: 'due', daysLeft: 0 }],
    });
  });

  it('counts review, mentions, blocked and overdue for the sidebar and the Mine tab', async () => {
    const counts = await getHomeCounts(clock(), world.memberActor);
    expect(counts).toEqual({
      review: 2,
      mergedOpen: 0,
      checkAgain: 0,
      mentions: 2,
      blocked: 1,
      overdue: 2,
      total: 7,
    });
    expect(result.counts.mine).toBe(7);
    expect(result.counts.agents).toBe(1);
    expect(group(result, 'assigned').total).toBe(4);
  });

  it('shows the same tasks to the owner from their side', async () => {
    const owner = await home(world.ownerActor);
    // The member's own review task waits on the owner, who created it.
    expect(keys(group(owner, 'review').items)).toEqual([k('ownReview')]);
    expect(keys(group(owner, 'mentions').items)).toEqual([]);
    // Overdue and assigned to the owner.
    expect(keys(group(owner, 'overdue').items)).toEqual([k('others')]);
  });
});

describe('Everyone', () => {
  let world: World;
  let p: ProjectRow;
  const t: Record<string, TaskRow> = {};
  let result: Home;

  beforeAll(async () => {
    world = await createWorld(ctx.db);
    p = await newProject(world);
    const blocker = await rawTask(world, p, { status: 'in_progress' });
    t.review = await rawTask(world, p, { status: 'in_review', assigneeId: world.agent.id, dueDate: day(-1) });
    t.blocked = await rawTask(world, p, { assigneeId: world.owner.id, dueDate: day(-4) });
    await blockedBy(t.blocked, blocker);
    t.overdue = await rawTask(world, p, { dueDate: day(-2) });
    t.week = await rawTask(world, p, { dueDate: today(), priority: 2 });
    const weekEnd = addCalendarDays(nextMonday(today()), -1);
    t.weekEnd = await rawTask(world, p, { dueDate: weekEnd });
    t.nextWeek = await rawTask(world, p, { dueDate: addCalendarDays(weekEnd, 1) });
    t.mentioned = await rawTask(world, p);
    await createComment(ctx, world.ownerActor, {
      key: keyOf(p, t.mentioned),
      body: `${mention(world.member)}?`,
    });
    result = await home(world.memberActor, 'everyone');
  });

  const k = (name: string) => keyOf(p, t[name] as TaskRow);

  it('groups needs review, blocked, overdue and due this week, without mentions', () => {
    expect(result.groups.map((g) => g.key)).toEqual([
      'review',
      'mergedOpen',
      'blocked',
      'overdue',
      'dueThisWeek',
    ]);
    expect(keys(group(result, 'review').items)).toEqual([k('review')]);
    expect(keys(group(result, 'blocked').items)).toEqual([k('blocked')]);
    expect(keys(group(result, 'overdue').items)).toEqual([k('overdue')]);
    const week = keys(group(result, 'dueThisWeek').items);
    expect(week[0]).toBe(k('week'));
    expect(week).toContain(k('weekEnd'));
    expect(week).not.toContain(k('nextWeek'));
    expect(itemOf(result, k('mentioned'))).toBeNull();
    expect(result.groups.flatMap((g) => g.items).every((item) => item.relation === null)).toBe(true);
  });

  it('says who a review waits on and counts the tab', () => {
    const review = itemOf(result, k('review'));
    expect(review?.item.reason).toMatchObject({ kind: 'review', waitingOn: { id: world.member.id } });
    expect(review?.item.pills).toEqual([{ kind: 'overdue', daysOverdue: 1 }]);
    const week = itemOf(result, k('week'));
    expect(week?.item.reason).toEqual({ kind: 'due', dueDate: today(), daysLeft: 0 });
    expect(result.counts.everyone).toBe(result.groups.reduce((sum, g) => sum + g.total, 0));
  });

  it('puts open tasks due within 2 days or overdue in the deadlines strip, soonest first', () => {
    const tasks = result.deadlines.filter((d) => d.kind === 'task').map((d) => d.task.key);
    // Already in due order (and creation order on equal days); the week's end may fall within 2 days.
    const expected = ['blocked', 'overdue', 'review', 'week', 'weekEnd', 'nextWeek'].filter(
      (name) => (t[name]?.dueDate as string) <= day(2),
    );
    expect(tasks).toEqual(expected.map(k));
  });
});

describe('deadlines', () => {
  let world: World;
  let p: ProjectRow;
  let result: Home;

  beforeAll(async () => {
    world = await createWorld(ctx.db);
    p = await newProject(world, 'Deadlines');
    await ctx.db
      .update(schema.project)
      .set({ usesMilestones: true, usesCycles: true })
      .where(eq(schema.project.id, p.id));
    const scope = scopeOf(p);
    const me = world.member.id;
    const soon = await createMilestoneRow(ctx.db, scope, {
      createdById: me,
      name: 'Soon',
      targetDate: day(1),
    });
    const late = await createMilestoneRow(ctx.db, scope, {
      createdById: me,
      name: 'Late',
      targetDate: day(-3),
    });
    const far = await createMilestoneRow(ctx.db, scope, { createdById: me, name: 'Far', targetDate: day(5) });
    const others = await createMilestoneRow(ctx.db, scope, {
      createdById: me,
      name: 'Others',
      targetDate: day(0),
    });
    const cycle = await createCycleRow(ctx.db, scope, { startsOn: day(-5), endsOn: day(2) });
    await rawTask(world, p, { milestoneId: soon.id, assigneeId: me });
    await rawTask(world, p, { milestoneId: soon.id, status: 'done' });
    await rawTask(world, p, { milestoneId: soon.id, status: 'canceled' });
    await rawTask(world, p, { milestoneId: late.id, assigneeId: world.agent.id });
    await rawTask(world, p, { milestoneId: far.id, assigneeId: me });
    await rawTask(world, p, { milestoneId: others.id, assigneeId: world.owner.id });
    await rawTask(world, p, { cycleId: cycle.id, assigneeId: me, dueDate: day(2), title: 'Due in two' });
    await rawTask(world, p, { cycleId: cycle.id, status: 'done' });
    await rawTask(world, p, { assigneeId: me, dueDate: day(3) });
    result = await home(world.memberActor);
  });

  it('lists milestones, cycles and tasks of mine due within 2 days or overdue, soonest first', () => {
    // Late only holds my agent's task: not mine.
    expect(
      result.deadlines.map((d) =>
        d.kind === 'milestone'
          ? `m:${d.milestone.name}:${d.daysLeft}`
          : d.kind === 'cycle'
            ? `c:${d.daysLeft}`
            : `t:${d.daysLeft}`,
      ),
    ).toEqual(['m:Soon:1', 'c:3', 't:2']);
    const soon = result.deadlines.find((d) => d.kind === 'milestone' && d.milestone.name === 'Soon');
    expect(soon?.kind === 'milestone' && soon.progress).toEqual({ done: 1, total: 2 });
    const cycle = result.deadlines.find((d) => d.kind === 'cycle');
    expect(cycle?.kind === 'cycle' && cycle.progress).toEqual({ done: 1, total: 2 });
  });

  it('shows every milestone on Everyone and none on Agents', async () => {
    const everyone = await home(world.memberActor, 'everyone');
    expect(
      everyone.deadlines
        .filter((d) => d.kind === 'milestone')
        .map((d) => d.kind === 'milestone' && d.milestone.name),
    ).toEqual(['Late', 'Others', 'Soon']);
    expect((await home(world.memberActor, 'agents')).deadlines).toEqual([]);
  });
});

describe('filters and readable projects', () => {
  let world: World;
  let a: ProjectRow;
  let b: ProjectRow;
  const t: Record<string, TaskRow> = {};

  beforeAll(async () => {
    world = await createWorld(ctx.db);
    a = await newProject(world, 'A');
    b = await newProject(world, 'B');
    const me = world.member.id;
    const payA = await addLabel(a, 'Payouts');
    const payB = await addLabel(b, 'payouts', 2);
    const other = await addLabel(a, 'frontend');
    t.a1 = await rawTask(world, a, { assigneeId: me, priority: 4 });
    await tag(t.a1, payA, other);
    t.a2 = await rawTask(world, a, { assigneeId: me, priority: 1 });
    await tag(t.a2, other);
    t.b1 = await rawTask(world, b, { assigneeId: me, priority: 1, dueDate: day(-1) });
    await tag(t.b1, payB);
    // Milestones due tomorrow: one holds the labelled task, the other the unlabelled one.
    for (const [name, row] of [
      ['Labelled', t.a1],
      ['Unlabelled', t.a2],
    ] as const) {
      const m = await createMilestoneRow(ctx.db, scopeOf(a), { createdById: me, name, targetDate: day(1) });
      await ctx.db
        .update(task)
        .set({ milestoneId: m.id })
        .where(eq(task.id, (row as TaskRow).id));
    }
  });

  it('merges labels by name across projects, ignoring case', async () => {
    const result = await home(world.memberActor, 'mine', { label: 'PAYOUTS' });
    const all = result.groups.flatMap((g) => keys(g.items)).sort();
    expect(all).toEqual([keyOf(a, t.a1 as TaskRow), keyOf(b, t.b1 as TaskRow)].sort());
    const a1 = itemOf(result, keyOf(a, t.a1 as TaskRow));
    expect(a1?.item.task.labels?.map((l) => l.name)).toEqual(['frontend', 'Payouts']);
    expect(result.counts.mine).toBe(1);
    // The deadlines follow the filter: milestones only with a matching open task.
    expect(result.deadlines.map((d) => (d.kind === 'milestone' ? d.milestone.name : d.kind))).toEqual([
      'task',
      'Labelled',
    ]);
    const unfiltered = await home(world.memberActor, 'mine');
    expect(unfiltered.deadlines.filter((d) => d.kind === 'milestone')).toHaveLength(2);
    const unknown = await home(world.memberActor, 'everyone', { label: 'no such label' });
    expect(unknown.groups.every((g) => g.total === 0)).toBe(true);
    expect(unknown.deadlines).toEqual([]);
  });

  it('filters by priority and project', async () => {
    const urgent = await home(world.memberActor, 'mine', { priority: 'urgent' });
    expect(urgent.groups.flatMap((g) => keys(g.items))).toEqual([keyOf(a, t.a1 as TaskRow)]);
    const onlyB = await home(world.memberActor, 'mine', { project: b.key });
    expect(onlyB.groups.flatMap((g) => keys(g.items))).toEqual([keyOf(b, t.b1 as TaskRow)]);
    expect(onlyB.deadlines.map((d) => d.kind === 'task' && d.task.key)).toEqual([keyOf(b, t.b1 as TaskRow)]);
  });

  it('reads only the projects a key covers', async () => {
    const scoped: Actor = {
      ...world.memberActor,
      scope: { projects: [a.id], access: 'read' },
      apiKeyId: crypto.randomUUID(),
    };
    const result = await home(scoped);
    expect(result.groups.flatMap((g) => g.items).every((item) => item.task.project.key === a.key)).toBe(true);
    expect(await getHomeCounts(clock(), scoped)).toEqual({
      review: 0,
      mergedOpen: 0,
      checkAgain: 0,
      mentions: 0,
      blocked: 0,
      overdue: 0,
      total: 0,
    });
    expect((await getHomeCounts(clock(), world.memberActor)).overdue).toBe(1);
  });

  it('caps a group at the item limit and keeps the total', async () => {
    const many = await newProject(world, 'Many');
    for (let i = 0; i < HOME_GROUP_ITEM_LIMIT + 2; i++)
      await rawTask(world, many, { assigneeId: world.owner.id });
    const result = await home(world.ownerActor, 'mine', { project: many.key });
    const assigned = group(result, 'assigned');
    expect(assigned.total).toBe(HOME_GROUP_ITEM_LIMIT + 2);
    expect(assigned.items).toHaveLength(HOME_GROUP_ITEM_LIMIT);
  });
});

describe('work record on rows', () => {
  let world: World;
  let p: ProjectRow;
  const t: Record<string, TaskRow> = {};

  /** Criteria or done items on `row`, numbered from 1 in the order given. */
  async function items(
    row: TaskRow,
    kind: 'criterion' | 'done',
    states: ('open' | 'checked' | 'waived')[],
  ): Promise<void> {
    await ctx.db.insert(taskItem).values(
      states.map((state, index) => ({
        taskId: row.id,
        kind,
        position: index + 1,
        text: `${kind} ${index + 1}`,
        state,
        waivedReason: state === 'waived' ? 'Replaced by a replay' : null,
        waivedById: state === 'waived' ? world.owner.id : null,
      })),
    );
  }

  /** getHome with every db.select and db.execute call counted. */
  async function countedHome(actor: Actor, tab: HomeTab): Promise<{ result: Home; queries: number }> {
    let queries = 0;
    const db = new Proxy(ctx.db, {
      get(target, property, receiver) {
        const value = Reflect.get(target, property, receiver);
        if ((property === 'select' || property === 'execute') && typeof value === 'function') {
          return (...args: unknown[]) => {
            queries += 1;
            return value.apply(target, args);
          };
        }
        return value;
      },
    });
    const result = await getHome({ ...clock(), db }, actor, { tab });
    return { result, queries };
  }

  beforeAll(async () => {
    world = await createWorld(ctx.db);
    p = await newProject(world);
    t.full = await rawTask(world, p, {
      status: 'in_review',
      assigneeId: world.agent.id,
      finalSummary: 'Retries back off and stop on 4xx answers.',
    });
    await items(t.full, 'criterion', ['checked', 'checked', 'checked', 'checked', 'waived', 'open']);
    await items(t.full, 'done', ['checked', 'checked']);
    t.bare = await rawTask(world, p, { status: 'in_review', assigneeId: world.agent.id });
  });

  const k = (name: string) => keyOf(p, t[name] as TaskRow);

  it('fills criteria and done-item counts and the summary flag on Needs review rows', async () => {
    const result = await home(world.memberActor, 'everyone');
    const full = itemOf(result, k('full'));
    expect(full?.group).toBe('review');
    expect(full?.item.task).toMatchObject({
      criteriaProgress: { settled: 5, open: 1, waived: 1, total: 6 },
      doneProgress: { settled: 2, open: 0, waived: 0, total: 2 },
      hasFinalSummary: true,
    });
    const bare = itemOf(result, k('bare'));
    expect(bare?.item.task).toMatchObject({
      criteriaProgress: { settled: 0, open: 0, waived: 0, total: 0 },
      doneProgress: { settled: 0, open: 0, waived: 0, total: 0 },
      hasFinalSummary: false,
    });
  });

  it('reads the counts in one query per page, not one per row', async () => {
    const before = await countedHome(world.memberActor, 'everyone');
    for (let i = 0; i < 3; i++) {
      const row = await rawTask(world, p, { status: 'in_review', assigneeId: world.agent.id });
      await items(row, 'criterion', ['open', 'checked']);
    }
    const after = await countedHome(world.memberActor, 'everyone');
    expect(group(after.result, 'review').items.length).toBe(group(before.result, 'review').items.length + 3);
    expect(before.queries).toBeGreaterThan(5);
    expect(after.queries).toBe(before.queries);
  });
});

describe('Agents', () => {
  let world: World;
  let p: ProjectRow;
  let idle: typeof schema.user.$inferSelect;
  const t: Record<string, TaskRow> = {};
  let result: Home;

  beforeAll(async () => {
    world = await createWorld(ctx.db);
    p = await newProject(world, 'Agents');
    idle = await createUser(ctx.db, {
      name: `a-idle-${crypto.randomUUID().slice(0, 6)}`,
      kind: 'agent',
      responsibleUserId: world.owner.id,
    });
    await ctx.db
      .insert(member)
      .values({ organizationId: world.workspaceId, userId: idle.id, role: 'member' });
    const agent = world.agent.id;
    // The working agent: an In progress task touched just now, plus an older one.
    t.current = await rawTask(world, p, { status: 'in_progress', assigneeId: agent, title: 'Current' });
    await activityRow(world, p, t.current, {
      actorId: agent,
      onBehalfOfId: world.member.id,
      changes: [{ field: 'status', from: 'todo', to: 'in_progress' }],
      createdAt: ago(0.3),
    });
    t.older = await rawTask(world, p, { status: 'in_progress', assigneeId: agent, updatedAt: ago(5) });
    // In review, requested by the agent: waits on the member.
    t.review = await rawTask(world, p, { status: 'in_review', assigneeId: agent });
    await activityRow(world, p, t.review, {
      actorId: agent,
      onBehalfOfId: world.member.id,
      changes: [{ field: 'status', from: 'in_progress', to: 'in_review' }],
      createdAt: ago(0.5),
    });
    // A person's task In review does not wait on a person for an agent.
    t.personReview = await rawTask(world, p, { status: 'in_review', assigneeId: world.owner.id });
    t.blocked = await rawTask(world, p, { assigneeId: agent });
    await blockedBy(t.blocked, t.older);
    // An unanswered question to the owner and an answered one.
    t.asks = await rawTask(world, p, { assigneeId: agent });
    await createComment(ctx, world.agentActor, {
      key: keyOf(p, t.asks),
      body: `${mention(world.owner)} which one?`,
    });
    t.answered = await rawTask(world, p);
    await createComment(ctx, world.agentActor, {
      key: keyOf(p, t.answered),
      body: `${mention(world.owner)} ok?`,
    });
    await createComment(ctx, world.ownerActor, { key: keyOf(p, t.answered), body: 'Yes.' });
    // A row from yesterday that does not count today, and the idle agent's old action.
    await activityRow(world, p, t.older, { actorId: agent, createdAt: ago(30) });
    t.idleTask = await rawTask(world, p, { status: 'in_progress', assigneeId: idle.id, updatedAt: ago(3) });
    await activityRow(world, p, t.idleTask, { actorId: idle.id, createdAt: ago(3) });
    result = await home(world.memberActor, 'agents');
  });

  const k = (name: string) => keyOf(p, t[name] as TaskRow);

  it('shows one card per agent, working first', () => {
    expect(result.agents.map((a) => a.agent.id)).toEqual([world.agent.id, idle.id]);
    const [working, idleCard] = result.agents;
    expect(working).toMatchObject({
      agent: { id: world.agent.id, responsible: { id: world.member.id } },
      state: 'working',
      currentTask: { key: k('current'), title: 'Current' },
      counts: { assigned: 5, inReview: 1, blocked: 1 },
    });
    expect(idleCard).toMatchObject({
      state: 'idle',
      currentTask: null,
      counts: { assigned: 1, changesToday: 1 },
    });
    expect(result.counts.agents).toBe(2);
    expect(result.deadlines).toEqual([]);
  });

  it("counts today's activity rows and comments, and lists the last 5 actions newest first", () => {
    const working = result.agents[0];
    // Two activity rows and two comments today; the 30-hour-old row is yesterday (UTC, unless
    // the run starts in the first 6 hours of the day).
    const expected = new Date().getUTCHours() >= 6 ? 4 : 5;
    expect(working?.counts.changesToday).toBe(expected);
    expect(working?.recent).toHaveLength(5);
    const times = working?.recent.map((a) => a.at) ?? [];
    expect([...times].sort().reverse()).toEqual(times);
    const comment = working?.recent.find((a) => a.kind === 'comment');
    expect(comment).toMatchObject({ kind: 'comment', mentions: [{ id: world.owner.id }] });
    const moved = working?.recent.find((a) => a.kind === 'activity' && a.task.key === k('review'));
    expect(moved).toMatchObject({ changes: [{ field: 'status', from: 'in_progress', to: 'in_review' }] });
    expect(working?.lastActivityAt).toBe(working?.recent[0]?.at);
  });

  it('lists what agents wait on a person for', () => {
    const waiting = group(result, 'waiting');
    expect(result.groups.map((g) => g.key)).toEqual(['waiting']);
    expect(keys(waiting.items).sort()).toEqual([k('asks'), k('review')].sort());
    expect(itemOf(result, k('personReview'))).toBeNull();
    expect(itemOf(result, k('review'))?.item.reason).toMatchObject({
      kind: 'review',
      requestedBy: { id: world.agent.id },
      waitingOn: { id: world.member.id },
    });
    expect(itemOf(result, k('asks'))?.item.reason).toMatchObject({
      kind: 'mention',
      author: { id: world.agent.id },
      mentioned: { id: world.owner.id },
    });
  });
});
