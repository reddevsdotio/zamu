// M6 item operations: the in-memory plan (order of operations, numbering, no-op detection, limits,
// waivers) and writing it back with a renumbering that passes through duplicate positions.
import { MAX_WORK_ITEMS } from '@zamu/contracts';
import { schema } from '@zamu/db';
import { asc, eq } from 'drizzle-orm';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import {
  describeOpenItems,
  finishingRuleApplies,
  hasItemOperations,
  itemOperationsOf,
  loadTaskItemRows,
  openItemsOf,
  planItemOperations,
  type TaskItemRow,
  workItemProgressOf,
  writeItemPlan,
} from './criteria';
import { Invalid } from './errors';
import {
  createTaskItemRows,
  createTaskRow,
  createWorld,
  randomProjectKey,
  type TestContext,
  testContext,
  type World,
} from './testing/fixtures';

const ACTOR = '00000000-0000-7000-8000-000000000001';

/** Rows of one list as the planner sees them, without a database. */
function rows(...items: (string | Partial<TaskItemRow>)[]): TaskItemRow[] {
  return items.map((item, index) => ({
    id: `00000000-0000-7000-8000-${String(index + 1).padStart(12, '0')}`,
    taskId: '00000000-0000-7000-8000-00000000aaaa',
    kind: 'criterion',
    position: index + 1,
    text: typeof item === 'string' ? item : (item.text ?? `Item ${index + 1}`),
    state: 'open',
    waivedReason: null,
    waivedById: null,
    source: 'app',
    createdAt: new Date('2000-01-01T00:00:00Z'),
    updatedAt: new Date('2000-01-01T00:00:00Z'),
    ...(typeof item === 'string' ? {} : item),
  }));
}

function invalid(run: () => unknown): Invalid {
  try {
    run();
  } catch (error) {
    expect(error).toBeInstanceOf(Invalid);
    return error as Invalid;
  }
  throw new Error('expected Invalid');
}

describe('planItemOperations', () => {
  it('adds at the end and records each item with its number', () => {
    const plan = planItemOperations(
      'criterion',
      rows('Refunds post a ledger entry'),
      { add: ['A', 'B'] },
      ACTOR,
    );
    expect(plan.items.map((item) => item.text)).toEqual(['Refunds post a ledger entry', 'A', 'B']);
    expect(plan.changes).toEqual([
      { field: 'criterion.added', number: 2, text: 'A' },
      { field: 'criterion.added', number: 3, text: 'B' },
    ]);
  });

  it('names done item changes doneItem.*', () => {
    const plan = planItemOperations('done', [], { add: ['Tests pass'] }, ACTOR);
    expect(plan.changes).toEqual([{ field: 'doneItem.added', number: 1, text: 'Tests pass' }]);
  });

  it('checks, unchecks, waives with a reason and unwaives; checking a waived item clears its waiver', () => {
    const before = rows(
      'One',
      { text: 'Two', state: 'checked' },
      { text: 'Three', state: 'waived', waivedReason: 'Out of scope', waivedById: ACTOR },
      'Four',
    );
    const plan = planItemOperations(
      'criterion',
      before,
      { check: [1, 3], uncheck: [2], waive: [{ number: 4, reason: 'Replaced by a replay' }] },
      ACTOR,
    );
    expect(
      plan.items.map(({ state, waivedReason, waivedById }) => ({ state, waivedReason, waivedById })),
    ).toEqual([
      { state: 'checked', waivedReason: null, waivedById: null },
      { state: 'open', waivedReason: null, waivedById: null },
      { state: 'checked', waivedReason: null, waivedById: null },
      { state: 'waived', waivedReason: 'Replaced by a replay', waivedById: ACTOR },
    ]);
    expect(plan.changes).toEqual([
      { field: 'criterion.checked', number: 1, text: 'One' },
      { field: 'criterion.checked', number: 3, text: 'Three' },
      { field: 'criterion.unchecked', number: 2, text: 'Two' },
      { field: 'criterion.waived', number: 4, text: 'Four', reason: 'Replaced by a replay' },
    ]);

    const unwaived = planItemOperations('criterion', before, { unwaive: [3] }, ACTOR);
    expect(unwaived.items[2]).toMatchObject({ state: 'open', waivedReason: null, waivedById: null });
    expect(unwaived.changes).toEqual([{ field: 'criterion.unwaived', number: 3, text: 'Three' }]);
  });

  it('records nothing for operations that change nothing', () => {
    const before = rows({ text: 'Done already', state: 'checked' }, 'Open', {
      text: 'Waived',
      state: 'waived',
      waivedReason: 'Why',
      waivedById: ACTOR,
    });
    const plan = planItemOperations(
      'criterion',
      before,
      {
        check: [1],
        uncheck: [2, 3],
        unwaive: [1, 2],
        waive: [{ number: 3, reason: 'Why' }],
        edit: [{ number: 2, text: 'Open' }],
        move: [{ from: 2, to: 2 }],
      },
      ACTOR,
    );
    expect(plan.changes).toEqual([]);
    expect(plan.removedIds).toEqual([]);
  });

  it('applies edits first, then removes, then moves in order, then adds', () => {
    const before = rows('A', 'B', 'C', 'D', 'E');
    const plan = planItemOperations(
      'criterion',
      before,
      {
        add: ['F'],
        remove: [2],
        // On the list after the remove: A C D E. Move E (4) to the top, then C (3 then) to the end.
        move: [
          { from: 4, to: 1 },
          { from: 3, to: 4 },
        ],
        edit: [{ number: 2, text: 'B, reworded' }],
        check: [5],
      },
      ACTOR,
    );
    expect(plan.items.map((item) => item.text)).toEqual(['E', 'A', 'D', 'C', 'F']);
    expect(plan.items[0]).toMatchObject({ state: 'checked' });
    expect(plan.removedIds).toEqual([before[1]?.id]);
    expect(plan.changes).toEqual([
      { field: 'criterion.edited', number: 2, text: 'B, reworded', from: 'B' },
      { field: 'criterion.checked', number: 5, text: 'E' },
      { field: 'criterion.removed', number: 2, text: 'B, reworded' },
      { field: 'criterion.moved', text: 'E', from: 4, to: 1 },
      { field: 'criterion.moved', text: 'C', from: 3, to: 4 },
      { field: 'criterion.added', number: 5, text: 'F' },
    ]);
  });

  it('refuses numbers the list does not have, naming the operation', () => {
    const before = rows('A', 'B');
    expect(invalid(() => planItemOperations('criterion', before, { check: [3] }, ACTOR)).issues).toEqual([
      { path: 'checkCriteria', message: 'There is no criterion 3: the task has 2 criteria' },
    ]);
    expect(invalid(() => planItemOperations('done', [], { remove: [1] }, ACTOR)).issues?.[0]).toMatchObject({
      path: 'removeDoneItems',
      message: 'There is no done item 1: the task has 0 done items',
    });
    // Moves count on the list as it stands after removes.
    expect(
      invalid(() =>
        planItemOperations('criterion', before, { remove: [1], move: [{ from: 2, to: 1 }] }, ACTOR),
      ).issues?.[0],
    ).toMatchObject({ path: 'moveCriteria' });
  });

  it(`refuses a list longer than ${MAX_WORK_ITEMS} items`, () => {
    const full = rows(...Array.from({ length: MAX_WORK_ITEMS }, (_, i) => `Item ${i + 1}`));
    expect(
      invalid(() => planItemOperations('criterion', full, { add: ['One more'] }, ACTOR)).issues?.[0],
    ).toMatchObject({
      path: 'addCriteria',
    });
    // Removing one first makes room.
    const plan = planItemOperations('criterion', full, { remove: [1], add: ['One more'] }, ACTOR);
    expect(plan.items).toHaveLength(MAX_WORK_ITEMS);
  });
});

describe('operation helpers', () => {
  it('reads the operations of each list from an update input', () => {
    const input = { checkCriteria: [1], addDoneItems: ['Docs'], removeDoneItems: [] };
    expect(itemOperationsOf(input, 'criterion')).toMatchObject({ check: [1] });
    expect(itemOperationsOf(input, 'done')).toMatchObject({ add: ['Docs'], remove: [] });
    expect(hasItemOperations(itemOperationsOf(input, 'criterion'))).toBe(true);
    expect(hasItemOperations({ remove: [], add: [] })).toBe(false);
  });

  it('lists open items criteria first and words them', () => {
    const open = openItemsOf({
      criterion: [
        { text: 'A', state: 'checked' },
        { text: 'B', state: 'open' },
      ],
      done: [
        { text: 'Tests pass', state: 'open' },
        { text: 'Docs', state: 'waived' },
      ],
    });
    expect(open).toEqual([
      { kind: 'criterion', number: 2, text: 'B' },
      { kind: 'done', number: 1, text: 'Tests pass' },
    ]);
    expect(describeOpenItems(open)).toBe('criterion 2 and done item 1');
    expect(describeOpenItems(open.slice(0, 1))).toBe('criterion 2');
  });

  it('applies the finishing rule to agents moving into In review or Done only', () => {
    const agent = {
      userId: ACTOR,
      kind: 'agent',
      workspaceId: ACTOR,
      role: 'member',
      onBehalfOfId: null,
    } as const;
    const person = { ...agent, kind: 'person' } as const;
    expect(finishingRuleApplies(agent, 'in_progress', 'in_review')).toBe(true);
    expect(finishingRuleApplies(agent, 'in_review', 'done')).toBe(true);
    expect(finishingRuleApplies(agent, 'in_review', 'in_review')).toBe(false);
    expect(finishingRuleApplies(agent, 'todo', 'in_progress')).toBe(false);
    expect(finishingRuleApplies(agent, 'todo', undefined)).toBe(false);
    expect(finishingRuleApplies(person, 'in_progress', 'done')).toBe(false);
  });
});

describe('writing item plans', () => {
  let ctx: TestContext;
  let world: World;
  let projectId: string;

  beforeAll(async () => {
    ctx = testContext();
    world = await createWorld(ctx.db);
    const [row] = await ctx.db
      .insert(schema.project)
      .values({ workspaceId: world.workspaceId, key: randomProjectKey(), name: 'Payments API' })
      .returning();
    if (!row) throw new Error('project insert failed');
    projectId = row.id;
  });
  afterAll(async () => {
    await ctx?.close();
  });

  async function stored(taskId: string) {
    return ctx.db
      .select()
      .from(schema.taskItem)
      .where(eq(schema.taskItem.taskId, taskId))
      .orderBy(asc(schema.taskItem.kind), asc(schema.taskItem.position));
  }

  it('renumbers through duplicate positions in one transaction and keeps unchanged rows', async () => {
    const task = await createTaskRow(ctx.db, projectId, { createdById: world.owner.id });
    const before = await createTaskItemRows(ctx.db, task.id, 'criterion', ['A', 'B', 'C', 'D']);
    await createTaskItemRows(ctx.db, task.id, 'done', ['Tests pass']);
    const plan = planItemOperations(
      'criterion',
      before,
      // After the remove the list is A C D: D (3 then) goes to the top.
      { move: [{ from: 3, to: 1 }], remove: [2], add: ['E'] },
      world.owner.id,
    );
    await ctx.db.transaction((tx) => writeItemPlan(tx, task.id, before, plan));
    const after = await stored(task.id);
    expect(after.map((row) => [row.kind, row.position, row.text])).toEqual([
      ['criterion', 1, 'D'],
      ['criterion', 2, 'A'],
      ['criterion', 3, 'C'],
      ['criterion', 4, 'E'],
      ['done', 1, 'Tests pass'],
    ]);
    // Rows keep their ids; the removed one is gone.
    expect(after.find((row) => row.text === 'D')?.id).toBe(before[3]?.id);
    expect(after.some((row) => row.id === before[1]?.id)).toBe(false);
  });

  it('stores waivers with their author and clears them on check', async () => {
    const task = await createTaskRow(ctx.db, projectId, { createdById: world.owner.id });
    const before = await createTaskItemRows(ctx.db, task.id, 'criterion', ['Load test']);
    const waive = planItemOperations(
      'criterion',
      before,
      { waive: [{ number: 1, reason: 'Replay' }] },
      world.member.id,
    );
    await ctx.db.transaction((tx) => writeItemPlan(tx, task.id, before, waive));
    const [waived] = await loadTaskItemRows(ctx.db, [task.id]);
    expect(waived).toMatchObject({ state: 'waived', waivedReason: 'Replay', waivedById: world.member.id });

    const check = planItemOperations('criterion', [waived as TaskItemRow], { check: [1] }, world.owner.id);
    await ctx.db.transaction((tx) => writeItemPlan(tx, task.id, [waived as TaskItemRow], check));
    const [checked] = await loadTaskItemRows(ctx.db, [task.id]);
    expect(checked).toMatchObject({ state: 'checked', waivedReason: null, waivedById: null });
  });

  it('counts both lists per task in one query', async () => {
    const task = await createTaskRow(ctx.db, projectId, { createdById: world.owner.id });
    const empty = await createTaskRow(ctx.db, projectId, { createdById: world.owner.id });
    await createTaskItemRows(ctx.db, task.id, 'criterion', [
      'Open',
      { text: 'Checked', state: 'checked' },
      { text: 'Waived', state: 'waived', waivedReason: 'Why' },
    ]);
    await createTaskItemRows(ctx.db, task.id, 'done', [{ text: 'Tests pass', state: 'checked' }]);
    const progress = await workItemProgressOf(ctx.db, [task.id, empty.id]);
    expect(progress.get(task.id)).toEqual({
      criteria: { settled: 2, open: 1, waived: 1, total: 3 },
      done: { settled: 1, open: 0, waived: 0, total: 1 },
    });
    expect(progress.has(empty.id)).toBe(false);
  });
});
