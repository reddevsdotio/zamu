// M7 Home: the merged-with-open-items group (Mine for the review rule's person, Everyone for
// all), the check-again group (Mine), their reasons and pills, the counts, and archived tasks left
// out of every group.
import type { Home, HomeGroupKey, HomeItem } from '@zamu/contracts';
import { schema } from '@zamu/db';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import type { Actor } from './authz';
import { addCalendarDays, type ClockContext, todayIn } from './cycles';
import { getHome, getHomeCounts } from './home';
import { createProject } from './projects';
import {
  createPullRequestRow,
  createTaskItemRows,
  createTaskRow,
  createWorld,
  linkPullRequestRow,
  projectRow,
  randomProjectKey,
  scopeOf,
  type TestContext,
  testContext,
  type World,
} from './testing/fixtures';

const { task } = schema;
const NOW = new Date('2026-11-20T10:00:00.000Z');

let ctx: TestContext;
let clocked: TestContext & ClockContext;

beforeAll(() => {
  ctx = testContext();
  clocked = { ...ctx, timeZone: 'UTC', now: () => NOW };
});
afterAll(async () => {
  await ctx?.close();
});

const today = () => todayIn(clocked);
const day = (days: number) => addCalendarDays(today(), days);

type ProjectRow = Awaited<ReturnType<typeof projectRow>>;
type TaskRow = typeof task.$inferSelect;

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

describe('M7 Home groups', () => {
  let world: World;
  let p: ProjectRow;
  const t: Record<string, TaskRow> = {};
  let mine: Home;
  let everyone: Home;
  const k = (name: string) => `${p.key}-${(t[name] as TaskRow).number}`;

  beforeAll(async () => {
    world = await createWorld(ctx.db);
    const key = randomProjectKey();
    await createProject(ctx, world.ownerActor, { key, name: 'Harbor' });
    p = await projectRow(ctx.db, world.workspaceId, key);
    const me = world.member.id;
    const raw = (values: Partial<typeof task.$inferInsert>) =>
      createTaskRow(ctx.db, p.id, { createdById: world.owner.id, ...values });
    const merged = new Date(NOW.getTime() - 3_600_000);

    // mergedOpen for me: my agent holds it, so it waits on me; one criterion and one done item open.
    t.mergedMine = await raw({
      status: 'done',
      assigneeId: world.agent.id,
      mergedDoneAt: merged,
      closedAt: merged,
    });
    await createTaskItemRows(ctx.db, t.mergedMine.id, 'criterion', [
      'Ledger entry',
      { text: 'Ok', state: 'checked' },
    ]);
    await createTaskItemRows(ctx.db, t.mergedMine.id, 'done', ['Docs']);
    const request = await createPullRequestRow(ctx.db, scopeOf(p), {
      number: 482,
      title: 'Retry webhooks',
      state: 'merged',
      mergedAt: merged,
      mergedBy: 'tomas',
    });
    const later = await createPullRequestRow(ctx.db, scopeOf(p), { number: 490, title: 'Follow-up' });
    await linkPullRequestRow(ctx.db, t.mergedMine.id, request.id);
    await linkPullRequestRow(ctx.db, t.mergedMine.id, later.id, { viaDescription: true });
    // mergedOpen for everyone only: the owner created it and nobody holds it.
    t.mergedOther = await raw({ status: 'done', mergedDoneAt: merged, closedAt: merged });
    await createTaskItemRows(ctx.db, t.mergedOther.id, 'criterion', ['Still open']);
    // Not flagged: every item settled; archived; reopened (not Done).
    t.mergedSettled = await raw({ status: 'done', assigneeId: world.agent.id, mergedDoneAt: merged });
    await createTaskItemRows(ctx.db, t.mergedSettled.id, 'criterion', [{ text: 'Ok', state: 'checked' }]);
    t.mergedArchived = await raw({
      status: 'done',
      assigneeId: world.agent.id,
      mergedDoneAt: merged,
      archivedAt: merged,
    });
    await createTaskItemRows(ctx.db, t.mergedArchived.id, 'criterion', ['Open']);

    // checkAgain: ready and mine, also overdue (pill); ready today, created by me and unassigned.
    t.checkPast = await raw({
      assigneeId: me,
      checkAgainOn: day(-2),
      checkAgainReason: "Wait for the bank's answer",
      dueDate: day(-1),
    });
    t.checkToday = await raw({
      createdById: me,
      checkAgainOn: today(),
      checkAgainReason: 'Ask Ana',
    });
    // Waiting: stays in assigned. Someone else's ready day: not my group.
    t.checkWaiting = await raw({ assigneeId: me, checkAgainOn: day(3), checkAgainReason: 'Later' });
    t.checkOther = await raw({
      assigneeId: world.owner.id,
      checkAgainOn: day(-1),
      checkAgainReason: 'Theirs',
    });
    // In review and ready: review wins, with the pill.
    t.reviewReady = await raw({
      status: 'in_review',
      assigneeId: world.agent.id,
      checkAgainOn: day(-1),
      checkAgainReason: 'Ping',
    });
    // Archived and ready: nowhere.
    t.checkArchived = await raw({
      assigneeId: me,
      checkAgainOn: day(-1),
      checkAgainReason: 'Gone',
      archivedAt: NOW,
    });

    mine = await getHome(clocked, world.memberActor, { tab: 'mine' });
    everyone = await getHome(clocked, world.memberActor, { tab: 'everyone' });
  });

  it('puts merged tasks with open items first after review, with the merged request', () => {
    expect(keys(group(mine, 'mergedOpen').items)).toEqual([k('mergedMine')]);
    const item = itemOf(mine, k('mergedMine'))?.item;
    expect(item?.reason).toEqual({
      kind: 'mergedOpen',
      pullRequest: {
        provider: 'github',
        number: 482,
        title: 'Retry webhooks',
        url: 'https://github.com/northwind/payments/pull/482',
      },
      mergedBy: 'tomas',
      openCriteria: 1,
      openDoneItems: 1,
      at: new Date(NOW.getTime() - 3_600_000).toISOString(),
    });
    // The row's request marker shows the newest request and the count.
    expect(item?.task).toMatchObject({ pullRequest: { number: 490, state: 'open' }, pullRequestCount: 2 });
    expect(keys(group(everyone, 'mergedOpen').items).sort()).toEqual(
      [k('mergedMine'), k('mergedOther')].sort(),
    );
    for (const name of ['mergedSettled', 'mergedArchived']) {
      expect(itemOf(mine, k(name))).toBeNull();
      expect(itemOf(everyone, k(name))).toBeNull();
    }
  });

  it('brings back ready check-again days in Mine, oldest first, before later groups', () => {
    expect(keys(group(mine, 'checkAgain').items)).toEqual([k('checkPast'), k('checkToday')]);
    const past = itemOf(mine, k('checkPast'))?.item;
    expect(past?.reason).toEqual({
      kind: 'checkAgain',
      on: day(-2),
      reason: "Wait for the bank's answer",
      daysAgo: 2,
    });
    expect(past?.pills).toContainEqual({ kind: 'overdue', daysOverdue: 1 });
    expect(past?.task.checkAgain).toEqual({ on: day(-2), reason: "Wait for the bank's answer" });
    expect(itemOf(mine, k('checkToday'))?.item.reason).toMatchObject({ kind: 'checkAgain', daysAgo: 0 });

    expect(itemOf(mine, k('checkWaiting'))?.group).toBe('assigned');
    expect(itemOf(mine, k('checkWaiting'))?.item.pills).not.toContainEqual(
      expect.objectContaining({ kind: 'checkAgain' }),
    );
    expect(itemOf(mine, k('checkOther'))).toBeNull();
    expect(itemOf(mine, k('checkArchived'))).toBeNull();

    const review = itemOf(mine, k('reviewReady'));
    expect(review?.group).toBe('review');
    expect(review?.item.pills).toContainEqual({ kind: 'checkAgain', on: day(-1) });
    // Everyone has no checkAgain group: the overdue task shows as overdue with the pill.
    const overdue = itemOf(everyone, k('checkPast'));
    expect(overdue?.group).toBe('overdue');
    expect(overdue?.item.pills).toContainEqual({ kind: 'checkAgain', on: day(-2) });
  });

  it('counts both groups in Mine and the sidebar', async () => {
    const counts = await getHomeCounts(clocked, world.memberActor);
    expect(counts).toMatchObject({ review: 1, mergedOpen: 1, checkAgain: 2 });
    expect(counts.total).toBe(
      counts.review +
        (counts.mergedOpen ?? 0) +
        (counts.checkAgain ?? 0) +
        counts.mentions +
        counts.blocked +
        counts.overdue,
    );
    expect(mine.counts.mine).toBe(counts.total);
    expect(group(everyone, 'mergedOpen').total).toBe(2);
  });

  it('keeps the filters on the merged branch', async () => {
    const scoped: Actor = {
      ...world.memberActor,
      scope: { projects: [crypto.randomUUID()], access: 'read' },
      apiKeyId: crypto.randomUUID(),
    };
    const none = await getHome(clocked, scoped, { tab: 'everyone' });
    expect(group(none, 'mergedOpen').total).toBe(0);
    const high = await getHome(clocked, world.memberActor, { tab: 'everyone', priority: ['urgent'] });
    expect(group(high, 'mergedOpen').total).toBe(0);
  });
});
