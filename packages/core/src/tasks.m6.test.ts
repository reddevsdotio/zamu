// M6: the work record through the task services: create with criteria, done items (project
// defaults first) and a plan; item operations, plan and summary on update with their history;
// the ifStatus precondition; the finishing rule for agents and people, single and bulk; list
// counts; the machine and branch on history; mirrored tasks read-only.
import { MAX_WORK_ITEMS } from '@zamu/contracts';
import { schema } from '@zamu/db';
import { eq } from 'drizzle-orm';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { listTaskActivity } from './activity';
import type { Actor } from './authz';
import { OpenItems } from './criteria';
import { Invalid, TaskChanged, TaskMirrored } from './errors';
import { createProject, updateProject } from './projects';
import { bulkUpdateTasks, createTask, getTask, listTasks, updateTask } from './tasks';
import { createMirroredProject, type MirroredProject } from './testing/backlog';
import {
  createTaskItemRows,
  createWorld,
  randomProjectKey,
  type TestContext,
  testContext,
  type World,
} from './testing/fixtures';
import { listTaskTimeline } from './timeline';

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

describe('the work record of native tasks', () => {
  let ctx: TestContext;
  let world: World;
  let key: string;
  /** The agent with the CLI's machine and branch. */
  let cliAgent: Actor;

  beforeAll(async () => {
    ctx = testContext();
    world = await createWorld(ctx.db);
    key = randomProjectKey();
    await createProject(ctx, world.ownerActor, { key, name: 'Payments API' });
    cliAgent = { ...world.agentActor, source: { machine: 'kaggia', branch: 'feat/refund-ledger' } };
  });
  afterAll(async () => {
    await ctx?.close();
  });

  describe('create', () => {
    it('numbers criteria and done items in order, stores the plan and records them', async () => {
      const task = await createTask(ctx, cliAgent, {
        project: key,
        title: 'Refund ledger',
        criteria: ['Refunds post a ledger entry', 'Partial refunds keep the remainder'],
        doneItems: ['Tests pass'],
        plan: '1. Add the table\n2. Post entries',
      });
      expect(task.criteria).toEqual([
        {
          number: 1,
          text: 'Refunds post a ledger entry',
          state: 'open',
          waivedReason: null,
          waivedBy: null,
          locked: false,
        },
        {
          number: 2,
          text: 'Partial refunds keep the remainder',
          state: 'open',
          waivedReason: null,
          waivedBy: null,
          locked: false,
        },
      ]);
      expect(task.doneItems?.map((item) => item.text)).toEqual(['Tests pass']);
      expect(task.plan).toBe('1. Add the table\n2. Post entries');
      expect(task.planMeta).toMatchObject({
        author: { id: world.agent.id, kind: 'agent' },
        onBehalfOf: { id: world.member.id },
        origin: 'app',
      });
      expect(task.finalSummary).toBeNull();
      expect(task.finalSummaryMeta).toBeNull();

      const [created] = (await listTaskActivity(ctx, world.ownerActor, { key: task.key })).items;
      expect(created?.changes).toEqual(
        expect.arrayContaining([
          { field: 'plan', from: null, to: '1. Add the table\n2. Post entries' },
          { field: 'criterion.added', number: 1, text: 'Refunds post a ledger entry' },
          { field: 'criterion.added', number: 2, text: 'Partial refunds keep the remainder' },
          { field: 'doneItem.added', number: 1, text: 'Tests pass' },
        ]),
      );
      expect(created?.source).toEqual({ machine: 'kaggia', branch: 'feat/refund-ledger' });
    });

    it("starts with the project's default done items unless skipped, without doubles", async () => {
      const projectKey = randomProjectKey();
      await createProject(ctx, world.ownerActor, { key: projectKey, name: 'Webhooks' });
      await updateProject(ctx, world.ownerActor, {
        project: projectKey,
        defaultDoneItems: ['Tests pass', 'Docs updated'],
      });
      const withDefaults = await createTask(ctx, world.memberActor, {
        project: projectKey,
        title: 'With defaults',
        doneItems: ['Docs updated', 'Changelog line'],
      });
      expect(withDefaults.doneItems?.map((item) => item.text)).toEqual([
        'Tests pass',
        'Docs updated',
        'Changelog line',
      ]);
      const skipped = await createTask(ctx, world.memberActor, {
        project: projectKey,
        title: 'Without defaults',
        skipDefaultDoneItems: true,
      });
      expect(skipped.doneItems).toEqual([]);

      // Changing the defaults leaves existing tasks alone.
      await updateProject(ctx, world.ownerActor, { project: projectKey, defaultDoneItems: [] });
      const again = await getTask(ctx, world.memberActor, { key: withDefaults.key });
      expect(again.doneItems).toHaveLength(3);
    });

    it(`refuses more than ${MAX_WORK_ITEMS} done items with the defaults counted`, async () => {
      const projectKey = randomProjectKey();
      await createProject(ctx, world.ownerActor, { key: projectKey, name: 'Limits' });
      await updateProject(ctx, world.ownerActor, { project: projectKey, defaultDoneItems: ['Tests pass'] });
      const many = Array.from({ length: MAX_WORK_ITEMS }, (_, i) => `Item ${i + 1}`);
      const error = await rejection(
        createTask(ctx, world.memberActor, { project: projectKey, title: 'Too many', doneItems: many }),
        Invalid,
      );
      expect(error.issues?.[0]?.path).toBe('doneItems');
      await expect(
        createTask(ctx, world.memberActor, {
          project: projectKey,
          title: 'Fits',
          doneItems: many,
          skipDefaultDoneItems: true,
        }),
      ).resolves.toMatchObject({ doneItems: expect.any(Array) });
      // The contract limits each list and each line.
      await rejection(
        createTask(ctx, world.memberActor, {
          project: projectKey,
          title: 'Long',
          criteria: ['x'.repeat(501)],
        }),
        Invalid,
      );
      await rejection(
        createTask(ctx, world.memberActor, { project: projectKey, title: 'Lines', criteria: ['one\ntwo'] }),
        Invalid,
      );
    });
  });

  describe('update', () => {
    it('applies each operation, records one change per operation and marks the task updated', async () => {
      const task = await createTask(ctx, world.memberActor, {
        project: key,
        title: 'Operations',
        criteria: ['A', 'B', 'C'],
        doneItems: ['Tests pass'],
      });
      const updated = await updateTask(ctx, cliAgent, {
        key: task.key,
        checkCriteria: [1],
        waiveCriteria: [{ number: 2, reason: 'Load test replaced by a replay' }],
        editCriteria: [{ number: 3, text: 'C, reworded' }],
        addCriteria: ['D'],
        moveCriteria: [{ from: 3, to: 1 }],
        checkDoneItems: [1],
      });
      expect(updated.criteria?.map(({ number, text, state }) => [number, text, state])).toEqual([
        [1, 'C, reworded', 'open'],
        [2, 'A', 'checked'],
        [3, 'B', 'waived'],
        [4, 'D', 'open'],
      ]);
      expect(updated.criteria?.[2]).toMatchObject({
        waivedReason: 'Load test replaced by a replay',
        waivedBy: { id: world.agent.id },
      });
      expect(updated.doneItems?.[0]?.state).toBe('checked');
      expect(Date.parse(updated.updatedAt)).toBeGreaterThan(Date.parse(task.updatedAt));

      const entries = (await listTaskActivity(ctx, world.ownerActor, { key: task.key })).items;
      const last = entries.at(-1);
      expect(last?.type).toBe('task.updated');
      expect(last?.source).toEqual({ machine: 'kaggia', branch: 'feat/refund-ledger' });
      expect(last?.changes).toEqual([
        { field: 'criterion.edited', number: 3, text: 'C, reworded', from: 'C' },
        { field: 'criterion.checked', number: 1, text: 'A' },
        { field: 'criterion.waived', number: 2, text: 'B', reason: 'Load test replaced by a replay' },
        { field: 'criterion.moved', text: 'C, reworded', from: 3, to: 1 },
        { field: 'criterion.added', number: 4, text: 'D' },
        { field: 'doneItem.checked', number: 1, text: 'Tests pass' },
      ]);

      // Remove renumbers; unwaive and uncheck reopen.
      const removed = await updateTask(ctx, world.memberActor, {
        key: task.key,
        removeCriteria: [1],
        unwaiveCriteria: [3],
        uncheckDoneItems: [1],
      });
      expect(removed.criteria?.map(({ number, text, state }) => [number, text, state])).toEqual([
        [1, 'A', 'checked'],
        [2, 'B', 'open'],
        [3, 'D', 'open'],
      ]);
      expect(removed.doneItems?.[0]?.state).toBe('open');
    });

    it('refuses unknown numbers without writing anything', async () => {
      const task = await createTask(ctx, world.memberActor, {
        project: key,
        title: 'Unknown',
        criteria: ['A'],
      });
      const error = await rejection(
        updateTask(ctx, world.memberActor, { key: task.key, title: 'Renamed', checkCriteria: [2] }),
        Invalid,
      );
      expect(error.issues).toEqual([
        { path: 'checkCriteria', message: 'There is no criterion 2: the task has 1 criterion' },
      ]);
      expect((await getTask(ctx, world.memberActor, { key: task.key })).title).toBe('Unknown');
    });

    it('sets and clears the plan and the final summary; meta comes from the latest change', async () => {
      const task = await createTask(ctx, world.memberActor, {
        project: key,
        title: 'Texts',
        plan: 'First plan',
      });
      expect(task.planMeta?.author?.id).toBe(world.member.id);
      const byAgent = await updateTask(ctx, world.agentActor, {
        key: task.key,
        plan: 'Second plan',
        finalSummary: 'Ledger entries post on every refund.',
      });
      expect(byAgent).toMatchObject({
        plan: 'Second plan',
        finalSummary: 'Ledger entries post on every refund.',
      });
      expect(byAgent.planMeta).toMatchObject({
        author: { id: world.agent.id },
        onBehalfOf: { id: world.member.id },
      });
      expect(byAgent.finalSummaryMeta).toMatchObject({ author: { id: world.agent.id }, origin: 'app' });
      // A change of another field leaves the meta alone.
      const renamed = await updateTask(ctx, world.ownerActor, { key: task.key, title: 'Texts, renamed' });
      expect(renamed.planMeta?.author?.id).toBe(world.agent.id);

      const cleared = await updateTask(ctx, world.ownerActor, {
        key: task.key,
        plan: null,
        finalSummary: '',
      });
      expect(cleared).toMatchObject({
        plan: null,
        planMeta: null,
        finalSummary: null,
        finalSummaryMeta: null,
      });
      const last = (await listTaskActivity(ctx, world.ownerActor, { key: task.key })).items.at(-1);
      expect(last?.changes).toEqual([
        { field: 'plan', from: 'Second plan', to: null },
        { field: 'finalSummary', from: 'Ledger entries post on every refund.', to: null },
      ]);
    });

    it('ifStatus: a task whose status differs fails with TaskChanged and nothing is written', async () => {
      const task = await createTask(ctx, world.memberActor, {
        project: key,
        title: 'Queued',
        criteria: ['A'],
      });
      await updateTask(ctx, world.memberActor, { key: task.key, status: 'done' });
      const error = await rejection(
        updateTask(ctx, world.agentActor, {
          key: task.key,
          ifStatus: 'todo',
          status: 'in_progress',
          checkCriteria: [1],
        }),
        TaskChanged,
      );
      expect(error.task).toMatchObject({ key: task.key, status: 'done' });
      expect(error.message).toBe(`${task.key} is in Done now, not Todo`);
      const now = await getTask(ctx, world.memberActor, { key: task.key });
      expect(now.criteria?.[0]?.state).toBe('open');
      // The same status passes.
      await expect(
        updateTask(ctx, world.agentActor, { key: task.key, ifStatus: 'done', checkCriteria: [1] }),
      ).resolves.toMatchObject({ status: 'done' });
    });
  });

  describe('the finishing rule', () => {
    it('refuses an agent moving a task to In review or Done with open items, and writes nothing', async () => {
      const task = await createTask(ctx, world.memberActor, {
        project: key,
        title: 'Finish',
        status: 'in_progress',
        criteria: ['A', 'B'],
        doneItems: ['Tests pass'],
      });
      const error = await rejection(
        updateTask(ctx, world.agentActor, { key: task.key, status: 'in_review', checkCriteria: [1] }),
        OpenItems,
      );
      expect(error.problemCode).toBe('OPEN_ITEMS');
      expect(error.openItems).toEqual([
        { kind: 'criterion', number: 2, text: 'B' },
        { kind: 'done', number: 1, text: 'Tests pass' },
      ]);
      expect(error.message).toBe(
        `${task.key} has open items: criterion 2 and done item 1. Check or waive them before moving it to In review.`,
      );
      const unchanged = await getTask(ctx, world.memberActor, { key: task.key });
      expect(unchanged.status).toBe('in_progress');
      expect(unchanged.criteria?.[0]?.state).toBe('open');

      // Settling everything in the same request lets it through; a waived item counts as settled.
      const moved = await updateTask(ctx, world.agentActor, {
        key: task.key,
        status: 'in_review',
        checkCriteria: [1],
        waiveCriteria: [{ number: 2, reason: 'Covered by the replay test' }],
        checkDoneItems: [1],
      });
      expect(moved.status).toBe('in_review');
    });

    it('lets agents make other changes and people finish with open items', async () => {
      const task = await createTask(ctx, world.memberActor, {
        project: key,
        title: 'Open',
        status: 'in_review',
        criteria: ['A'],
      });
      // Already In review: no move, no refusal.
      await expect(
        updateTask(ctx, world.agentActor, { key: task.key, status: 'in_review', title: 'Open, renamed' }),
      ).resolves.toMatchObject({ title: 'Open, renamed' });
      await expect(
        updateTask(ctx, world.agentActor, { key: task.key, status: 'todo' }),
      ).resolves.toMatchObject({
        status: 'todo',
      });
      await expect(
        updateTask(ctx, world.memberActor, { key: task.key, status: 'done' }),
      ).resolves.toMatchObject({
        status: 'done',
      });
      // A task without items is never refused.
      const bare = await createTask(ctx, world.memberActor, { project: key, title: 'Bare' });
      await expect(
        updateTask(ctx, world.agentActor, { key: bare.key, status: 'done' }),
      ).resolves.toMatchObject({
        status: 'done',
      });
    });

    it('bulk: refuses an agent when any task has open items, naming each; people go through', async () => {
      const open = await createTask(ctx, world.memberActor, {
        project: key,
        title: 'Bulk open',
        criteria: ['A'],
      });
      const ready = await createTask(ctx, world.memberActor, { project: key, title: 'Bulk ready' });
      const error = await rejection(
        bulkUpdateTasks(ctx, world.agentActor, { keys: [ready.key, open.key], status: 'done' }),
        OpenItems,
      );
      expect(error.issues).toEqual([
        {
          path: 'keys.1',
          message: `${open.key} has open items: criterion 1. Check or waive them before moving it to Done.`,
        },
      ]);
      expect(error.openItems).toEqual([{ kind: 'criterion', number: 1, text: 'A' }]);
      expect((await getTask(ctx, world.memberActor, { key: ready.key })).status).toBe('todo');

      const other = await createTask(ctx, world.memberActor, {
        project: key,
        title: 'Bulk open 2',
        doneItems: ['D'],
      });
      const several = await rejection(
        bulkUpdateTasks(ctx, world.agentActor, { keys: [open.key, other.key], status: 'in_review' }),
        OpenItems,
      );
      expect(several.issues?.map((issue) => issue.path)).toEqual(['keys.0', 'keys.1']);
      expect(several.message).toBe(
        `${open.key}, ${other.key} have open items, so no task moved to In review. Check or waive them first.`,
      );

      const done = await bulkUpdateTasks(ctx, world.memberActor, {
        keys: [ready.key, open.key],
        status: 'done',
      });
      expect(done.items.map((item) => item.status)).toEqual(['done', 'done']);
    });
  });

  describe('reads', () => {
    it('lists counts and whether a summary exists with every row', async () => {
      const task = await createTask(ctx, world.memberActor, {
        project: key,
        title: 'Counted',
        criteria: ['A', 'B', 'C'],
        doneItems: ['D'],
      });
      await updateTask(ctx, world.memberActor, {
        key: task.key,
        checkCriteria: [1],
        waiveCriteria: [{ number: 2, reason: 'Later' }],
        finalSummary: 'Shipped',
      });
      const page = await listTasks(ctx, world.memberActor, { project: key, q: 'Counted' });
      expect(page.items[0]).toMatchObject({
        key: task.key,
        criteriaProgress: { settled: 2, open: 1, waived: 1, total: 3 },
        doneProgress: { settled: 0, open: 1, waived: 0, total: 1 },
        hasFinalSummary: true,
      });
      const bare = await createTask(ctx, world.memberActor, { project: key, title: 'Uncounted' });
      const barePage = await listTasks(ctx, world.memberActor, { project: key, q: 'Uncounted' });
      expect(barePage.items.find((item) => item.key === bare.key)).toMatchObject({
        criteriaProgress: { settled: 0, open: 0, waived: 0, total: 0 },
        doneProgress: { total: 0 },
        hasFinalSummary: false,
      });
    });

    it('returns the machine and branch on history entries and nothing for the web app', async () => {
      const task = await createTask(ctx, world.memberActor, { project: key, title: 'Sourced' });
      await updateTask(ctx, cliAgent, { key: task.key, status: 'in_progress' });
      const { items } = await listTaskTimeline(ctx, world.memberActor, { key: task.key, show: 'history' });
      expect(items.map((item) => (item.kind === 'activity' ? item.source : 'other'))).toEqual([
        null,
        { machine: 'kaggia', branch: 'feat/refund-ledger' },
      ]);
      const [row] = await ctx.db
        .select({ machine: schema.activity.machine, branch: schema.activity.branch })
        .from(schema.activity)
        .where(eq(schema.activity.taskId, task.id))
        .orderBy(schema.activity.createdAt);
      expect(row).toEqual({ machine: null, branch: null });
    });
  });
});

describe('the work record of mirrored tasks', () => {
  let ctx: TestContext;
  let world: World;
  let mirror: MirroredProject;

  beforeAll(async () => {
    ctx = testContext();
    world = await createWorld(ctx.db);
    mirror = await createMirroredProject(ctx.db, world);
    await createTaskItemRows(ctx.db, mirror.tasks.parent.id, 'criterion', [
      { text: 'Webhooks retry', source: 'backlog' },
      { text: 'Signed payloads', state: 'checked', source: 'backlog' },
    ]);
    await ctx.db
      .update(schema.task)
      .set({ plan: 'Plan from the file' })
      .where(eq(schema.task.id, mirror.tasks.parent.id));
  });
  afterAll(async () => {
    await ctx?.close();
  });

  it('reads the items locked, and the plan as written by Backlog.md', async () => {
    const task = await getTask(ctx, world.memberActor, { key: `${mirror.key}-786` });
    expect(task.criteria?.map(({ text, state, locked }) => [text, state, locked])).toEqual([
      ['Webhooks retry', 'open', true],
      ['Signed payloads', 'checked', true],
    ]);
    expect(task.plan).toBe('Plan from the file');
    expect(task.planMeta).toMatchObject({ author: null, onBehalfOf: null, origin: 'backlog' });
    expect(task.locked).toEqual(expect.arrayContaining(['criteria', 'doneItems', 'plan', 'finalSummary']));
  });

  it('refuses every work-record write with TaskMirrored and a Backlog.md hint', async () => {
    const key = `${mirror.key}-786`;
    const check = await rejection(
      updateTask(ctx, world.agentActor, { key, checkCriteria: [1] }),
      TaskMirrored,
    );
    expect(check.extensions).toMatchObject({
      field: 'criteria',
      backlogId: 'BACK-786',
      hint: 'backlog task edit 786 --check-ac 1',
    });
    const dod = await rejection(
      updateTask(ctx, world.agentActor, { key, addDoneItems: ['Tests pass'] }),
      TaskMirrored,
    );
    expect(dod.extensions).toMatchObject({
      field: 'doneItems',
      hint: 'backlog task edit 786 --dod "Tests pass"',
    });
    const waive = await rejection(
      updateTask(ctx, world.agentActor, { key, waiveCriteria: [{ number: 1, reason: 'Later' }] }),
      TaskMirrored,
    );
    expect(waive.extensions.hint).toBe('Change the acceptance criteria in the task file and push');
    const plan = await rejection(updateTask(ctx, world.ownerActor, { key, plan: 'New plan' }), TaskMirrored);
    expect(plan.extensions).toMatchObject({ field: 'plan', hint: 'backlog task edit 786 --plan "New plan"' });
    const summary = await rejection(
      updateTask(ctx, world.ownerActor, { key, finalSummary: 'Done' }),
      TaskMirrored,
    );
    expect(summary.extensions).toMatchObject({
      field: 'finalSummary',
      hint: 'backlog task edit 786 --final-summary Done',
    });
    // Nothing changed.
    const task = await getTask(ctx, world.memberActor, { key });
    expect(task.criteria?.[0]?.state).toBe('open');
  });
});
