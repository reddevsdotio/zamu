// M8: waves through the task services: `wave` on create and update (the wave's milestone comes
// along, leaving the milestone leaves the wave), the agent-only WAVE_LOCKED refusal for single,
// bulk and create next to a person's pass-through, the system moves that are never refused, and
// the wave with its lock on task, list and Home rows.
import type { ActivityCause } from '@zamu/contracts';
import { schema } from '@zamu/db';
import { eq } from 'drizzle-orm';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { listTaskActivity } from './activity';
import { archiveTasks, TaskArchived } from './archive';
import type { Actor } from './authz';
import { Invalid, WaveLocked } from './errors';
import { getHome } from './home';
import { createMilestone } from './milestones';
import { createProject } from './projects';
import { bulkUpdateTasks, createTask, getTask, listTasks, setStatusFromSource, updateTask } from './tasks';
import { createWorld, randomProjectKey, type TestContext, testContext, type World } from './testing/fixtures';
import { createWave, putTasksInWave, recordGateResult } from './waves';

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

describe('tasks in waves', () => {
  let ctx: TestContext;
  let world: World;
  /** The agent through a key, as the CLI sends it. */
  let agent: Actor;
  /** A person through an API key: people are never refused, keys or not. */
  let personKey: Actor;

  beforeAll(async () => {
    ctx = testContext();
    world = await createWorld(ctx.db);
    agent = world.agentActor;
    personKey = {
      ...world.memberActor,
      scope: { projects: 'all', access: 'write' },
      apiKeyId: crypto.randomUUID(),
    };
  });
  afterAll(async () => {
    await ctx?.close();
  });

  /** Payments with milestone Payouts v2: W1 Ledger (gate open), W2 Screens (locked until W1). */
  async function setup() {
    const project = await createProject(ctx, world.ownerActor, { name: 'Payments', key: randomProjectKey() });
    const milestone = await createMilestone(ctx, world.ownerActor, {
      project: project.key,
      name: 'Payouts v2',
    });
    const w1 = await createWave(ctx, world.ownerActor, { milestone: milestone.id, name: 'Ledger' });
    const w2 = await createWave(ctx, world.ownerActor, { milestone: milestone.id, name: 'Screens' });
    const other = await createMilestone(ctx, world.ownerActor, { project: project.key, name: 'Later' });
    const later = await createWave(ctx, world.ownerActor, { milestone: other.id, name: 'Rollout' });
    return { project, milestone, w1, w2, other, later };
  }

  async function lastChanges(key: string) {
    const { items } = await listTaskActivity(ctx, world.memberActor, { key });
    return items.at(-1)?.changes;
  }

  describe('the wave field', () => {
    it('puts a task in a wave with its milestone, moves it, and takes it out', async () => {
      const { project, milestone, w1, w2, other, later } = await setup();
      const task = await createTask(ctx, world.memberActor, { project: project.key, title: 'Ledger table' });
      const placed = await updateTask(ctx, world.memberActor, { key: task.key, wave: w1.id });
      expect(placed.milestone?.id).toBe(milestone.id);
      expect(placed.wave).toEqual({ id: w1.id, number: 1, name: 'Ledger', locked: false, lockedUntil: null });
      expect(await lastChanges(task.key)).toEqual([
        { field: 'milestone', from: null, to: { id: milestone.id, name: 'Payouts v2' } },
        { field: 'wave', from: null, to: { id: w1.id, number: 1, name: 'Ledger', removed: false } },
      ]);

      const moved = await updateTask(ctx, world.memberActor, { key: task.key, wave: w2.id });
      expect(moved.wave).toEqual({
        id: w2.id,
        number: 2,
        name: 'Screens',
        locked: true,
        lockedUntil: { number: 1, name: 'Ledger' },
      });
      expect(await lastChanges(task.key)).toEqual([
        {
          field: 'wave',
          from: { id: w1.id, number: 1, name: 'Ledger', removed: false },
          to: { id: w2.id, number: 2, name: 'Screens', removed: false },
        },
      ]);

      // Another milestone without a wave: out of the wave, in the same row.
      const elsewhere = await updateTask(ctx, world.memberActor, { key: task.key, milestone: other.id });
      expect(elsewhere.wave).toBeNull();
      expect(await lastChanges(task.key)).toEqual([
        {
          field: 'milestone',
          from: { id: milestone.id, name: 'Payouts v2' },
          to: { id: other.id, name: 'Later' },
        },
        { field: 'wave', from: { id: w2.id, number: 2, name: 'Screens', removed: false }, to: null },
      ]);
      // A wave with its own milestone named: fine. A wave of another milestone than the one sent: Invalid.
      await expect(
        updateTask(ctx, world.memberActor, { key: task.key, milestone: other.id, wave: later.id }),
      ).resolves.toMatchObject({ wave: { id: later.id } });
      const mismatch = await rejection(
        updateTask(ctx, world.memberActor, { key: task.key, milestone: milestone.id, wave: later.id }),
        Invalid,
      );
      expect(mismatch.issues).toEqual([
        { path: 'wave', message: 'The wave is in another milestone than the one sent' },
      ]);
      const out = await updateTask(ctx, world.memberActor, { key: task.key, wave: null });
      expect(out).toMatchObject({ wave: null, milestone: { id: other.id } });
      // Clearing the milestone clears the wave.
      await updateTask(ctx, world.memberActor, { key: task.key, wave: later.id });
      await expect(
        updateTask(ctx, world.memberActor, { key: task.key, milestone: null }),
      ).resolves.toMatchObject({
        wave: null,
        milestone: null,
      });
    });

    it('refuses a wave of another project and writes to archived tasks', async () => {
      const { project, w1 } = await setup();
      const second = await setup();
      const task = await createTask(ctx, world.memberActor, { project: project.key, title: 'Ledger table' });
      const elsewhere = await rejection(
        updateTask(ctx, world.memberActor, { key: task.key, wave: second.w1.id }),
        Invalid,
      );
      expect(elsewhere.issues).toEqual([
        { path: 'wave', message: `The wave is not in project ${project.key}` },
      ]);
      await expect(
        createTask(ctx, world.memberActor, { project: project.key, title: 'x', wave: second.w1.id }),
      ).rejects.toBeInstanceOf(Invalid);
      await archiveTasks(ctx, world.ownerActor, { keys: [task.key] });
      await expect(updateTask(ctx, world.memberActor, { key: task.key, wave: w1.id })).rejects.toBeInstanceOf(
        TaskArchived,
      );
    });

    it('creates a task in a wave, taking the wave milestone', async () => {
      const { project, milestone, w1 } = await setup();
      const task = await createTask(ctx, agent, { project: project.key, title: 'Ledger table', wave: w1.id });
      expect(task).toMatchObject({
        milestone: { id: milestone.id },
        wave: { id: w1.id, number: 1, locked: false },
      });
      const { items } = await listTaskActivity(ctx, world.memberActor, { key: task.key });
      expect(items[0]?.changes).toContainEqual({
        field: 'wave',
        from: null,
        to: { id: w1.id, number: 1, name: 'Ledger', removed: false },
      });
    });
  });

  describe('the lock rule', () => {
    it('refuses an agent starting a task in a locked wave and lets people start it', async () => {
      const { project, milestone, w2 } = await setup();
      const task = await createTask(ctx, world.memberActor, {
        project: project.key,
        title: 'Failed payout banner',
        wave: w2.id,
      });
      for (const status of ['in_progress', 'in_review'] as const) {
        const refused = await rejection(updateTask(ctx, agent, { key: task.key, status }), WaveLocked);
        expect(refused.problemCode).toBe('WAVE_LOCKED');
        expect(refused.message).toBe(
          `${task.key} is in W2 · Screens, which is locked until W1 · Ledger passes. Wait for the gate of W1 to pass, or ask a person to start it.`,
        );
        expect(refused.waveLock).toEqual({
          task: task.key,
          wave: { number: 2, name: 'Screens' },
          waitsFor: { number: 1, name: 'Ledger' },
        });
        expect(refused.hint).toBe(`zamu milestones show "Payouts v2" --project ${project.key}`);
      }
      // Nothing changed, the milestone stayed Planned.
      expect((await getTask(ctx, world.memberActor, { key: task.key })).status).toBe('todo');
      const [row] = await ctx.db.select().from(schema.milestone).where(eq(schema.milestone.id, milestone.id));
      expect(row?.status).toBe('planned');

      // Agents may change everything else on it.
      await expect(
        updateTask(ctx, agent, { key: task.key, title: 'Banner', status: 'backlog' }),
      ).resolves.toMatchObject({
        title: 'Banner',
      });
      // People are never refused, with a session or a key; the task shows its lock.
      const started = await updateTask(ctx, personKey, { key: task.key, status: 'in_progress' });
      expect(started).toMatchObject({
        status: 'in_progress',
        wave: { locked: true, lockedUntil: { number: 1 } },
      });
      // A task already started is not started again: In progress to In review passes for agents.
      await expect(updateTask(ctx, agent, { key: task.key, status: 'in_review' })).resolves.toMatchObject({
        status: 'in_review',
      });
      // Reopening a done task is not starting it either.
      await updateTask(ctx, world.memberActor, { key: task.key, status: 'done' });
      await expect(updateTask(ctx, agent, { key: task.key, status: 'in_progress' })).resolves.toMatchObject({
        status: 'in_progress',
      });
    });

    it('applies to the wave the task ends up in, and frees it once the gate before passes', async () => {
      const { project, w1, w2 } = await setup();
      const open = await createTask(ctx, world.memberActor, {
        project: project.key,
        title: 'In W1',
        wave: w1.id,
      });
      // Into the locked wave and started in one request: refused, nothing written.
      const refused = await rejection(
        updateTask(ctx, agent, { key: open.key, wave: w2.id, status: 'in_progress' }),
        WaveLocked,
      );
      expect(refused.waveLock?.wave.number).toBe(2);
      expect((await getTask(ctx, world.memberActor, { key: open.key })).wave?.id).toBe(w1.id);
      // Out of the locked wave and started: passes (the move is in the history).
      const task = await createTask(ctx, world.memberActor, {
        project: project.key,
        title: 'In W2',
        wave: w2.id,
      });
      await expect(
        updateTask(ctx, agent, { key: task.key, wave: null, status: 'in_progress' }),
      ).resolves.toMatchObject({ wave: null, status: 'in_progress' });
      // W1 passes: W2 unlocks.
      await updateTask(ctx, world.memberActor, { key: open.key, status: 'done' });
      await recordGateResult(ctx, agent, { id: w1.id, state: 'passed', note: 'Balanced' });
      const later = await createTask(ctx, world.memberActor, {
        project: project.key,
        title: 'Also W2',
        wave: w2.id,
      });
      await expect(updateTask(ctx, agent, { key: later.key, status: 'in_progress' })).resolves.toMatchObject({
        status: 'in_progress',
        wave: { locked: false, lockedUntil: null },
      });
    });

    it('refuses agents in bulk, naming each task, and lets people through', async () => {
      const { project, w1, w2, other } = await setup();
      const free = await createTask(ctx, world.memberActor, {
        project: project.key,
        title: 'Free',
        wave: w1.id,
      });
      const first = await createTask(ctx, world.memberActor, {
        project: project.key,
        title: 'One',
        wave: w2.id,
      });
      const second = await createTask(ctx, world.memberActor, {
        project: project.key,
        title: 'Two',
        wave: w2.id,
      });
      const one = await rejection(
        bulkUpdateTasks(ctx, agent, { keys: [free.key, first.key], status: 'in_progress' }),
        WaveLocked,
      );
      expect(one.message).toContain(`${first.key} is in W2 · Screens`);
      expect(one.issues).toEqual([
        {
          path: 'keys.1',
          message: `${first.key} is in W2 · Screens, which is locked until W1 · Ledger passes.`,
        },
      ]);
      const both = await rejection(
        bulkUpdateTasks(ctx, agent, { keys: [free.key, first.key, second.key], status: 'in_review' }),
        WaveLocked,
      );
      expect(both.message).toBe(
        `${first.key}, ${second.key} are in locked waves, so no task started. Pass the gates they wait for first.`,
      );
      expect(both.issues?.map((issue) => issue.path)).toEqual(['keys.1', 'keys.2']);
      expect(both.waveLock?.task).toBe(first.key);
      expect((await getTask(ctx, world.memberActor, { key: free.key })).status).toBe('todo');

      // A milestone change in the same request takes them out of the wave first.
      const moved = await bulkUpdateTasks(ctx, agent, {
        keys: [first.key],
        status: 'in_progress',
        milestone: other.id,
      });
      expect(moved.items[0]).toMatchObject({ status: 'in_progress', wave: null });
      // People pass.
      const done = await bulkUpdateTasks(ctx, world.memberActor, {
        keys: [free.key, second.key],
        status: 'in_progress',
      });
      expect(done.items.map((item) => [item.status, item.wave?.locked])).toEqual([
        ['in_progress', false],
        ['in_progress', true],
      ]);
    });

    it('refuses an agent creating a started task in a locked wave', async () => {
      const { project, w2 } = await setup();
      const before = await listTasks(ctx, world.memberActor, { project: [project.key] });
      const refused = await rejection(
        createTask(ctx, agent, { project: project.key, title: 'Banner', wave: w2.id, status: 'in_progress' }),
        WaveLocked,
      );
      expect(refused.waveLock).toMatchObject({ task: `${project.key}-1`, wave: { number: 2 } });
      const after = await listTasks(ctx, world.memberActor, { project: [project.key] });
      expect(after.items).toHaveLength(before.items.length);
      // The number was not used.
      const created = await createTask(ctx, agent, { project: project.key, title: 'Banner', wave: w2.id });
      expect(created).toMatchObject({ key: `${project.key}-1`, status: 'todo', wave: { locked: true } });
      await expect(
        createTask(ctx, world.memberActor, {
          project: project.key,
          title: 'Started',
          wave: w2.id,
          status: 'in_review',
        }),
      ).resolves.toMatchObject({ status: 'in_review' });
    });

    it('never refuses moves the system makes', async () => {
      const { project, w2 } = await setup();
      const task = await createTask(ctx, world.memberActor, {
        project: project.key,
        title: 'Banner',
        wave: w2.id,
      });
      const cause: ActivityCause = {
        kind: 'pull_request',
        provider: 'github',
        number: 482,
        title: 'Banner',
        url: 'https://github.com/northwind/payments/pull/482',
        event: 'opened',
        by: null,
      };
      const result = await ctx.db.transaction((tx) =>
        setStatusFromSource(tx, ctx, {
          workspaceId: world.workspaceId,
          taskId: task.id,
          status: 'in_review',
          cause,
        }),
      );
      expect(result).toEqual({ changed: true, from: 'todo' });
      expect(await getTask(ctx, world.memberActor, { key: task.key })).toMatchObject({
        status: 'in_review',
        wave: { locked: true },
      });
    });
  });

  it('carries the wave with its lock on list and Home rows', async () => {
    const { project, milestone, w1, w2 } = await setup();
    const free = await createTask(ctx, world.memberActor, {
      project: project.key,
      title: 'Free',
      wave: w1.id,
      assignee: 'me',
    });
    const locked = await createTask(ctx, world.memberActor, {
      project: project.key,
      title: 'Locked',
      wave: w2.id,
      assignee: 'me',
      dueDate: '2020-01-01',
    });
    const none = await createTask(ctx, world.memberActor, {
      project: project.key,
      title: 'None',
      milestone: milestone.id,
    });
    const { items } = await listTasks(ctx, world.memberActor, { project: [project.key] });
    const byKey = new Map(items.map((item) => [item.key, item.wave]));
    expect(byKey.get(free.key)).toEqual({
      id: w1.id,
      number: 1,
      name: 'Ledger',
      locked: false,
      lockedUntil: null,
    });
    expect(byKey.get(locked.key)).toEqual({
      id: w2.id,
      number: 2,
      name: 'Screens',
      locked: true,
      lockedUntil: { number: 1, name: 'Ledger' },
    });
    expect(byKey.get(none.key)).toBeNull();
    const home = await getHome(ctx, world.memberActor, { tab: 'mine' });
    const row = home.groups.flatMap((group) => group.items).find((item) => item.task.key === locked.key);
    expect(row?.task.wave).toMatchObject({ id: w2.id, locked: true });
  });

  it('puts tasks in waves through putTasksInWave without the lock rule', async () => {
    const { project, milestone, w2 } = await setup();
    const started = await createTask(ctx, world.memberActor, {
      project: project.key,
      title: 'Started',
      status: 'in_progress',
    });
    // Moving a started task into a locked wave is not starting it.
    const plan = await putTasksInWave(ctx, agent, {
      milestone: milestone.id,
      wave: w2.id,
      keys: [started.key],
    });
    expect(plan.waves[1]?.tasks.map((task) => task.key)).toEqual([started.key]);
  });
});
