// M8: waves and gates against Postgres: the lock rule with passed, failed and open gates in
// several orders, dense numbers through adds, reorders (two at once included) and removals, gate
// results (the pass rule, failing at any time, who and where), putting tasks in waves across
// milestones and in a mirrored project, the plan, and who may do what.
import { schema } from '@zamu/db';
import { and, asc, eq } from 'drizzle-orm';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { archiveTasks, TaskArchived } from './archive';
import type { Actor } from './authz';
import { Conflict, Forbidden, GateTasksOpen, Invalid, NotFound, TaskMirrored } from './errors';
import { createMilestone, getMilestone, listMilestones } from './milestones';
import { createProject } from './projects';
import { createTask, updateTask } from './tasks';
import { createMirroredProject } from './testing/backlog';
import {
  createWorld,
  keyActor,
  randomProjectKey,
  type TestContext,
  testContext,
  type World,
} from './testing/fixtures';
import { listTaskTimeline } from './timeline';
import {
  createWave,
  deleteWave,
  getMilestonePlan,
  putTasksInWave,
  recordGateResult,
  updateWave,
  waveStates,
} from './waves';

async function failure(promise: Promise<unknown>): Promise<Error> {
  const error = await promise.then(
    () => null,
    (caught: unknown) => caught,
  );
  expect(error, 'expected the call to fail').toBeInstanceOf(Error);
  return error as Error;
}

describe('waves and gates', () => {
  let ctx: TestContext;
  let world: World;

  beforeAll(async () => {
    ctx = testContext();
    world = await createWorld(ctx.db);
  });
  afterAll(async () => {
    await ctx?.close();
  });

  /** A project with one milestone and `count` waves named A, B, C ... in order. */
  async function setup(count = 3, actor: Actor = world.ownerActor) {
    const project = await createProject(ctx, world.ownerActor, { name: 'Payments', key: randomProjectKey() });
    const milestone = await createMilestone(ctx, actor, { project: project.key, name: 'Payouts v2' });
    const waves = [];
    for (let index = 0; index < count; index++) {
      waves.push(
        await createWave(ctx, actor, {
          milestone: milestone.id,
          name: String.fromCharCode(65 + index),
          gateDescription: `Checks for ${String.fromCharCode(65 + index)}`,
        }),
      );
    }
    return { project, milestone, waves };
  }

  async function stored(milestoneId: string) {
    return ctx.db
      .select({ id: schema.wave.id, name: schema.wave.name, position: schema.wave.position })
      .from(schema.wave)
      .where(eq(schema.wave.milestoneId, milestoneId))
      .orderBy(asc(schema.wave.position), asc(schema.wave.id));
  }

  /** Records results straight into gate_result (skips the pass rule), oldest first. */
  async function results(waveId: string, ...states: ('passed' | 'failed')[]) {
    for (const [index, state] of states.entries()) {
      await ctx.db.insert(schema.gateResult).values({
        workspaceId: world.workspaceId,
        waveId,
        state,
        note: `Result ${index + 1}`,
        actorId: world.owner.id,
        createdAt: new Date(Date.now() - (states.length - index) * 60_000),
      });
    }
  }

  async function lockOf(milestoneId: string) {
    const states = (await waveStates(ctx.db, [milestoneId])).get(milestoneId) ?? [];
    return states.map((state) => ({
      n: state.number,
      gate: state.gateState,
      current: state.current,
      locked: state.locked,
      until: state.lockedUntil?.number ?? null,
    }));
  }

  describe('the lock rule', () => {
    it('locks every wave after the first one whose gate has not passed', async () => {
      const { milestone, waves } = await setup(4);
      expect(await lockOf(milestone.id)).toEqual([
        { n: 1, gate: 'open', current: true, locked: false, until: null },
        { n: 2, gate: 'open', current: false, locked: true, until: 1 },
        { n: 3, gate: 'open', current: false, locked: true, until: 1 },
        { n: 4, gate: 'open', current: false, locked: true, until: 1 },
      ]);
      const [w1, w2, w3] = waves;
      await results(w1?.id as string, 'passed');
      await results(w2?.id as string, 'failed');
      // W3 passed while W2 failed: still locked, waiting for W2.
      await results(w3?.id as string, 'passed');
      expect(await lockOf(milestone.id)).toEqual([
        { n: 1, gate: 'passed', current: false, locked: false, until: null },
        { n: 2, gate: 'failed', current: true, locked: false, until: null },
        { n: 3, gate: 'passed', current: false, locked: true, until: 2 },
        { n: 4, gate: 'open', current: false, locked: true, until: 2 },
      ]);
    });

    it('reads the latest result, either way, and frees the rest once every earlier gate passed', async () => {
      const { milestone, waves } = await setup(3);
      const [w1, w2, w3] = waves;
      // Failed, then passed: passed. Passed, then failed: failed.
      await results(w1?.id as string, 'failed', 'passed');
      await results(w2?.id as string, 'passed', 'failed');
      expect(await lockOf(milestone.id)).toEqual([
        { n: 1, gate: 'passed', current: false, locked: false, until: null },
        { n: 2, gate: 'failed', current: true, locked: false, until: null },
        { n: 3, gate: 'open', current: false, locked: true, until: 2 },
      ]);
      await results(w2?.id as string, 'passed');
      await results(w3?.id as string, 'passed');
      expect(await lockOf(milestone.id)).toEqual([
        { n: 1, gate: 'passed', current: false, locked: false, until: null },
        { n: 2, gate: 'passed', current: false, locked: false, until: null },
        { n: 3, gate: 'passed', current: false, locked: false, until: null },
      ]);
      expect((await getMilestone(ctx, world.memberActor, { id: milestone.id })).waves).toEqual({
        count: 3,
        current: null,
        currentState: null,
        allPassed: true,
      });
    });

    it('a wave whose first gate failed holds every later wave, passed or not', async () => {
      const { milestone, waves } = await setup(3);
      const [w1, w2] = waves;
      await results(w1?.id as string, 'failed');
      await results(w2?.id as string, 'passed');
      expect(await lockOf(milestone.id)).toEqual([
        { n: 1, gate: 'failed', current: true, locked: false, until: null },
        { n: 2, gate: 'passed', current: false, locked: true, until: 1 },
        { n: 3, gate: 'open', current: false, locked: true, until: 1 },
      ]);
      expect((await getMilestone(ctx, world.memberActor, { id: milestone.id })).waves).toEqual({
        count: 3,
        current: 1,
        currentState: 'failed',
        allPassed: false,
      });
    });

    it('reads many milestones in one call and leaves milestones without waves out', async () => {
      const first = await setup(2);
      const second = await setup(1);
      const empty = await createMilestone(ctx, world.ownerActor, {
        project: second.project.key,
        name: 'Later',
      });
      const states = await waveStates(ctx.db, [first.milestone.id, second.milestone.id, empty.id]);
      expect(states.get(first.milestone.id)?.map((state) => state.name)).toEqual(['A', 'B']);
      expect(states.get(second.milestone.id)?.map((state) => state.number)).toEqual([1]);
      expect(states.has(empty.id)).toBe(false);
      expect((await waveStates(ctx.db, [])).size).toBe(0);
    });
  });

  describe('numbers', () => {
    it('adds at the end or at a position, and refuses a name the milestone has, ignoring case', async () => {
      const { milestone, waves } = await setup(2);
      expect(waves.map((wave) => [wave.number, wave.name])).toEqual([
        [1, 'A'],
        [2, 'B'],
      ]);
      const first = await createWave(ctx, world.agentActor, {
        milestone: milestone.id,
        name: 'Zero',
        position: 1,
      });
      expect(first).toMatchObject({
        number: 1,
        name: 'Zero',
        current: true,
        locked: false,
        gate: { description: null, state: 'open', result: null },
        progress: { total: 0, done: 0, canceled: 0, open: 0 },
        canPass: true,
        openKeys: [],
        tasks: [],
      });
      const last = await createWave(ctx, world.memberActor, {
        milestone: milestone.id,
        name: 'Far',
        position: 99,
      });
      expect(last.number).toBe(4);
      expect((await stored(milestone.id)).map((row) => [row.position, row.name])).toEqual([
        [1, 'Zero'],
        [2, 'A'],
        [3, 'B'],
        [4, 'Far'],
      ]);
      const taken = await failure(
        createWave(ctx, world.ownerActor, { milestone: milestone.id, name: ' zero ' }),
      );
      expect(taken).toBeInstanceOf(Conflict);
      expect(taken.message).toBe('A wave named "zero" already exists in this milestone');
      // Another milestone may use the name.
      const other = await createMilestone(ctx, world.ownerActor, {
        project: milestone.project.key,
        name: 'Other',
      });
      await expect(
        createWave(ctx, world.ownerActor, { milestone: other.id, name: 'Zero' }),
      ).resolves.toMatchObject({
        number: 1,
      });
    });

    it('renames, describes and moves a wave, renumbering the others', async () => {
      const { milestone, waves } = await setup(4);
      const [a, b, c, d] = waves.map((wave) => wave.id);
      const moved = await updateWave(ctx, world.agentActor, { id: c as string, position: 1 });
      expect(moved).toMatchObject({ number: 1, name: 'C' });
      expect((await stored(milestone.id)).map((row) => row.name)).toEqual(['C', 'A', 'B', 'D']);
      await updateWave(ctx, world.ownerActor, { id: c as string, position: 3 });
      expect((await stored(milestone.id)).map((row) => row.name)).toEqual(['A', 'B', 'C', 'D']);
      await updateWave(ctx, world.ownerActor, { id: a as string, position: 50 });
      expect((await stored(milestone.id)).map((row) => [row.position, row.name])).toEqual([
        [1, 'B'],
        [2, 'C'],
        [3, 'D'],
        [4, 'A'],
      ]);
      const renamed = await updateWave(ctx, world.memberActor, {
        id: d as string,
        name: 'Rollout',
        gateDescription: 'Flag on for 5%',
      });
      expect(renamed).toMatchObject({ number: 3, name: 'Rollout', gate: { description: 'Flag on for 5%' } });
      const cleared = await updateWave(ctx, world.memberActor, { id: d as string, gateDescription: null });
      expect(cleared.gate.description).toBeNull();
      const taken = await failure(updateWave(ctx, world.memberActor, { id: b as string, name: 'ROLLOUT' }));
      expect(taken).toBeInstanceOf(Conflict);
    });

    it('keeps numbers dense when two reorders run at once', async () => {
      const { milestone, waves } = await setup(5);
      const [a, , , , e] = waves.map((wave) => wave.id);
      await Promise.all([
        updateWave(ctx, world.ownerActor, { id: e as string, position: 1 }),
        updateWave(ctx, world.memberActor, { id: a as string, position: 5 }),
        createWave(ctx, world.agentActor, { milestone: milestone.id, name: 'F', position: 2 }),
      ]);
      const rows = await stored(milestone.id);
      expect(rows.map((row) => row.position)).toEqual([1, 2, 3, 4, 5, 6]);
      expect(new Set(rows.map((row) => row.name)).size).toBe(6);
    });

    it('locks tasks before the milestone, so a task start racing a put or a removal never deadlocks', async () => {
      // A task start holds the task row, then activates its Planned milestone. Here a transaction
      // does the same by hand and waits until the wave write is under way before touching the
      // milestone: with the milestone locked first, Postgres would abort one side with a deadlock.
      for (const write of ['put', 'remove'] as const) {
        const { project, milestone, waves } = await setup(2);
        const [a, b] = waves;
        const created = await createTask(ctx, world.ownerActor, {
          project: project.key,
          title: `Race ${write}`,
          milestone: milestone.id,
        });
        await putTasksInWave(ctx, world.ownerActor, {
          milestone: milestone.id,
          wave: a?.id as string,
          keys: [created.key],
        });
        let release = () => {};
        const held = new Promise<void>((resolve) => {
          release = resolve;
        });
        let locked = () => {};
        const taskLocked = new Promise<void>((resolve) => {
          locked = resolve;
        });
        const start = ctx.db.transaction(async (tx) => {
          await tx.select().from(schema.task).where(eq(schema.task.id, created.id)).for('update');
          locked();
          await held;
          await tx
            .update(schema.milestone)
            .set({ status: 'active' })
            .where(eq(schema.milestone.id, milestone.id));
        });
        await taskLocked;
        const waveWrite =
          write === 'put'
            ? putTasksInWave(ctx, world.memberActor, {
                milestone: milestone.id,
                wave: b?.id as string,
                keys: [created.key],
              })
            : deleteWave(ctx, world.memberActor, { id: a?.id as string });
        // Let the wave write reach its first lock before the start asks for the milestone.
        await new Promise((resolve) => setTimeout(resolve, 200));
        release();
        const outcomes = await Promise.allSettled([start, waveWrite]);
        expect(outcomes.map((outcome) => outcome.status)).toEqual(['fulfilled', 'fulfilled']);
      }
    });

    it('removes a wave: its tasks go to Not in a wave with a history line, the rest renumber', async () => {
      const { project, milestone, waves } = await setup(3);
      const [, b, c] = waves;
      const task = await createTask(ctx, world.ownerActor, { project: project.key, title: 'Ledger table' });
      await putTasksInWave(ctx, world.ownerActor, {
        milestone: milestone.id,
        wave: b?.id as string,
        keys: [task.key],
      });
      await deleteWave(ctx, world.agentActor, { id: b?.id as string });
      expect((await stored(milestone.id)).map((row) => [row.position, row.name])).toEqual([
        [1, 'A'],
        [2, 'C'],
      ]);
      const plan = await getMilestonePlan(ctx, world.memberActor, { id: milestone.id });
      expect(plan.waves.map((wave) => [wave.number, wave.name])).toEqual([
        [1, 'A'],
        [2, 'C'],
      ]);
      expect(plan.notInWave.map((row) => row.key)).toEqual([task.key]);
      expect(plan.waves.find((wave) => wave.id === c?.id)?.number).toBe(2);
      // The history names the removed wave with its number and name at the time.
      const timeline = await listTaskTimeline(ctx, world.memberActor, { key: task.key });
      const waveChanges = timeline.items.flatMap((item) =>
        item.kind === 'activity' ? item.changes.filter((change) => change.field === 'wave') : [],
      );
      expect(waveChanges).toEqual([
        { field: 'wave', from: null, to: { id: b?.id, number: 2, name: 'B', removed: true } },
        { field: 'wave', from: { id: b?.id, number: 2, name: 'B', removed: true }, to: null },
      ]);
      const [gone] = await ctx.db
        .select()
        .from(schema.wave)
        .where(eq(schema.wave.id, b?.id as string));
      expect(gone).toBeUndefined();
      await expect(deleteWave(ctx, world.ownerActor, { id: b?.id as string })).rejects.toBeInstanceOf(
        NotFound,
      );
    });
  });

  describe('gate results', () => {
    it('refuses a pass while tasks are open, fails at any time, and passes once they are done', async () => {
      const { project, milestone, waves } = await setup(2);
      const [w1] = waves;
      const keys: string[] = [];
      for (const title of ['Ledger table', 'Post entries', 'Reverse entries']) {
        keys.push((await createTask(ctx, world.ownerActor, { project: project.key, title })).key);
      }
      await putTasksInWave(ctx, world.ownerActor, { milestone: milestone.id, wave: w1?.id as string, keys });
      await updateTask(ctx, world.ownerActor, { key: keys[0] as string, status: 'done' });

      const refused = await failure(
        recordGateResult(ctx, world.agentActor, { id: w1?.id as string, state: 'passed', note: 'All green' }),
      );
      expect(refused).toBeInstanceOf(GateTasksOpen);
      expect((refused as GateTasksOpen).openKeys.sort()).toEqual([keys[1], keys[2]].sort());
      expect(refused.message).toMatch(
        /^W1 · A has 2 open tasks: .+\. Finish or cancel them before passing its gate\.$/,
      );

      const failed = await recordGateResult(
        { ...ctx },
        { ...world.agentActor, source: { machine: 'ana-mbp', branch: 'feat/ledger' } },
        { id: w1?.id as string, state: 'failed', note: 'Entries do not balance.' },
      );
      expect(failed.gate).toMatchObject({
        state: 'failed',
        result: {
          state: 'failed',
          note: 'Entries do not balance.',
          recordedBy: { id: world.agent.id, kind: 'agent' },
          onBehalfOf: { id: world.member.id },
          source: { machine: 'ana-mbp', branch: 'feat/ledger' },
        },
      });
      // Failing changed no task.
      const statuses = (
        await getMilestonePlan(ctx, world.memberActor, { id: milestone.id })
      ).waves[0]?.tasks.map((row) => row.status);
      expect(statuses?.sort()).toEqual(['done', 'todo', 'todo']);

      await updateTask(ctx, world.ownerActor, { key: keys[1] as string, status: 'canceled' });
      // An archived task counts by its status (archived tasks are read-only: close, then archive).
      await updateTask(ctx, world.ownerActor, { key: keys[2] as string, status: 'done' });
      await archiveTasks(ctx, world.ownerActor, { keys: [keys[2] as string] });
      // A hidden open task in the wave does not hold the gate.
      const [hiddenRow] = await ctx.db
        .insert(schema.task)
        .values({
          projectId: project.id,
          number: 900,
          title: 'Gone from the files',
          createdById: world.owner.id,
          status: 'todo',
          milestoneId: milestone.id,
          waveId: w1?.id as string,
          hiddenAt: new Date(),
        })
        .returning();
      expect(hiddenRow).toBeDefined();
      const passed = await recordGateResult(ctx, world.memberActor, {
        id: w1?.id as string,
        state: 'passed',
        note: '  Ran the staging batch: all balanced.  ',
      });
      expect(passed).toMatchObject({
        current: false,
        canPass: true,
        progress: { total: 3, done: 2, canceled: 1, open: 0 },
        gate: {
          state: 'passed',
          result: {
            note: 'Ran the staging batch: all balanced.',
            recordedBy: { id: world.member.id },
            onBehalfOf: null,
            source: null,
          },
        },
      });
      expect(passed.tasks.find((row) => row.key === keys[2])?.archived).toBe(true);
      const plan = await getMilestonePlan(ctx, world.memberActor, { id: milestone.id });
      expect(plan.waves.map((wave) => [wave.current, wave.locked])).toEqual([
        [false, false],
        [true, false],
      ]);
      // Results stay as evidence.
      const rows = await ctx.db
        .select()
        .from(schema.gateResult)
        .where(eq(schema.gateResult.waveId, w1?.id as string));
      expect(rows.map((row) => row.state).sort()).toEqual(['failed', 'passed']);
    });

    it('keeps a pass after a task reopens, showing the open task', async () => {
      const { project, milestone, waves } = await setup(1);
      const task = await createTask(ctx, world.ownerActor, {
        project: project.key,
        title: 'Done one',
        status: 'done',
      });
      await putTasksInWave(ctx, world.ownerActor, {
        milestone: milestone.id,
        wave: waves[0]?.id as string,
        keys: [task.key],
      });
      await recordGateResult(ctx, world.ownerActor, {
        id: waves[0]?.id as string,
        state: 'passed',
        note: 'Checked',
      });
      await updateTask(ctx, world.ownerActor, { key: task.key, status: 'in_progress' });
      const [wave] = (await getMilestonePlan(ctx, world.memberActor, { id: milestone.id })).waves;
      expect(wave).toMatchObject({ gate: { state: 'passed' }, canPass: false, openKeys: [task.key] });
    });
  });

  describe('putting tasks in waves', () => {
    it('moves tasks within the milestone and from others, in one history row each', async () => {
      const { project, milestone, waves } = await setup(2);
      const [w1, w2] = waves;
      const other = await createMilestone(ctx, world.ownerActor, { project: project.key, name: 'Other' });
      const inMilestone = await createTask(ctx, world.ownerActor, {
        project: project.key,
        title: 'In the milestone',
        milestone: milestone.id,
      });
      const elsewhere = await createTask(ctx, world.ownerActor, {
        project: project.key,
        title: 'In another milestone',
        milestone: other.id,
        status: 'in_progress',
      });
      const none = await createTask(ctx, world.ownerActor, {
        project: project.key,
        title: 'In no milestone',
      });
      const plan = await putTasksInWave(ctx, world.agentActor, {
        milestone: milestone.id,
        wave: w1?.id as string,
        keys: [inMilestone.key, elsewhere.key, none.key],
      });
      expect(plan.waves[0]?.tasks.map((row) => row.key).sort()).toEqual(
        [inMilestone.key, elsewhere.key, none.key].sort(),
      );
      expect(plan.notInWave).toEqual([]);
      // Planned milestone: a started task that moves in activates it.
      expect(plan.milestone.status).toBe('active');

      const timeline = await listTaskTimeline(ctx, world.memberActor, { key: elsewhere.key });
      const last = timeline.items.filter((item) => item.kind === 'activity').at(-1);
      expect(last?.kind === 'activity' && last.changes).toEqual([
        {
          field: 'milestone',
          from: { id: other.id, name: 'Other' },
          to: { id: milestone.id, name: 'Payouts v2' },
        },
        { field: 'wave', from: null, to: { id: w1?.id, number: 1, name: 'A', removed: false } },
      ]);

      // Again: nothing changes, no new rows. Then out of the wave with null.
      const before = await ctx.db.select().from(schema.activity).where(eq(schema.activity.taskId, none.id));
      await putTasksInWave(ctx, world.agentActor, {
        milestone: milestone.id,
        wave: w1?.id as string,
        keys: [none.key],
      });
      const again = await ctx.db.select().from(schema.activity).where(eq(schema.activity.taskId, none.id));
      expect(again).toHaveLength(before.length);
      await putTasksInWave(ctx, world.agentActor, {
        milestone: milestone.id,
        wave: w2?.id as string,
        keys: [none.key],
      });
      const out = await putTasksInWave(ctx, world.agentActor, {
        milestone: milestone.id,
        wave: null,
        keys: [none.key],
      });
      expect(out.notInWave.map((row) => row.key)).toEqual([none.key]);
      const [row] = await ctx.db.select().from(schema.task).where(eq(schema.task.id, none.id));
      expect(row).toMatchObject({ milestoneId: milestone.id, waveId: null });
    });

    it('refuses tasks it cannot place, all or nothing', async () => {
      const { project, milestone, waves } = await setup(1);
      const otherProject = await createProject(ctx, world.ownerActor, {
        name: 'Ops',
        key: randomProjectKey(),
      });
      const outside = await createTask(ctx, world.ownerActor, {
        project: otherProject.key,
        title: 'Elsewhere',
      });
      const mine = await createTask(ctx, world.ownerActor, { project: project.key, title: 'Mine' });
      const wave = waves[0]?.id as string;
      const wrongProject = await failure(
        putTasksInWave(ctx, world.ownerActor, {
          milestone: milestone.id,
          wave,
          keys: [mine.key, outside.key],
        }),
      );
      expect(wrongProject).toBeInstanceOf(Invalid);
      expect((wrongProject as Invalid).issues).toEqual([
        { path: 'keys.1', message: `${outside.key} is not in project ${project.key}` },
      ]);
      const [mineRow] = await ctx.db.select().from(schema.task).where(eq(schema.task.id, mine.id));
      expect(mineRow?.waveId).toBeNull();

      // Taking out needs the tasks in this milestone.
      const notHere = await failure(
        putTasksInWave(ctx, world.ownerActor, { milestone: milestone.id, wave: null, keys: [mine.key] }),
      );
      expect(notHere).toBeInstanceOf(Invalid);

      // A wave of another milestone is not found here.
      const other = await setup(1);
      await expect(
        putTasksInWave(ctx, world.ownerActor, {
          milestone: milestone.id,
          wave: other.waves[0]?.id as string,
          keys: [mine.key],
        }),
      ).rejects.toBeInstanceOf(NotFound);

      // Archived tasks are read-only.
      const archived = await createTask(ctx, world.ownerActor, { project: project.key, title: 'Old' });
      await archiveTasks(ctx, world.ownerActor, { keys: [archived.key] });
      const refused = await failure(
        putTasksInWave(ctx, world.ownerActor, {
          milestone: milestone.id,
          wave,
          keys: [mine.key, archived.key],
        }),
      );
      expect(refused).toBeInstanceOf(TaskArchived);
      expect((refused as TaskArchived).issues).toEqual([
        { path: 'keys.1', message: `${archived.key} is archived, so it can't change. Restore it first.` },
      ]);
      const [still] = await ctx.db.select().from(schema.task).where(eq(schema.task.id, mine.id));
      expect(still?.waveId).toBeNull();
    });

    it('in a mirrored project: waves within a milestone pass, milestone moves are refused', async () => {
      const mirror = await createMirroredProject(ctx.db, world);
      const wave = await createWave(ctx, world.agentActor, {
        milestone: mirror.milestone.id,
        name: 'Delivery',
      });
      const parentKey = `${mirror.key}-786`;
      const plan = await putTasksInWave(ctx, world.agentActor, {
        milestone: mirror.milestone.id,
        wave: wave.id,
        keys: [parentKey],
      });
      expect(plan.waves[0]?.tasks.map((row) => row.key)).toEqual([parentKey]);
      // The draft has no milestone: putting it in the wave would change its milestone.
      const draftKey = `${mirror.key}-787`;
      const refused = await failure(
        putTasksInWave(ctx, world.agentActor, {
          milestone: mirror.milestone.id,
          wave: wave.id,
          keys: [draftKey],
        }),
      );
      expect(refused).toBeInstanceOf(TaskMirrored);
      expect((refused as TaskMirrored).extensions.field).toBe('milestone');
      // Gates and the plan link work in mirrored projects too.
      await expect(
        recordGateResult(ctx, world.agentActor, { id: wave.id, state: 'failed', note: 'Not yet' }),
      ).resolves.toMatchObject({ gate: { state: 'failed' } });
    });
  });

  describe('who may do what', () => {
    it('reads with project.read and writes with task.write, inside the key scope', async () => {
      const { project, milestone, waves } = await setup(1);
      const wave = waves[0]?.id as string;
      const readOnly = keyActor(world, { projects: 'all', access: 'read' });
      await expect(getMilestonePlan(ctx, readOnly, { id: milestone.id })).resolves.toMatchObject({
        waves: [{ id: wave }],
      });
      for (const call of [
        () => createWave(ctx, readOnly, { milestone: milestone.id, name: 'Nope' }),
        () => updateWave(ctx, readOnly, { id: wave, name: 'Nope' }),
        () => deleteWave(ctx, readOnly, { id: wave }),
        () => recordGateResult(ctx, readOnly, { id: wave, state: 'failed', note: 'x' }),
        () => putTasksInWave(ctx, readOnly, { milestone: milestone.id, wave, keys: [`${project.key}-1`] }),
      ]) {
        await expect(call()).rejects.toBeInstanceOf(Forbidden);
      }
      const otherProject = await createProject(ctx, world.ownerActor, {
        name: 'Ops',
        key: randomProjectKey(),
      });
      const scoped = keyActor(world, { projects: [otherProject.id], access: 'write' });
      await expect(getMilestonePlan(ctx, scoped, { id: milestone.id })).rejects.toBeInstanceOf(Forbidden);
      await expect(updateWave(ctx, scoped, { id: wave, name: 'Nope' })).rejects.toBeInstanceOf(Forbidden);
      await expect(
        recordGateResult(ctx, scoped, { id: wave, state: 'failed', note: 'x' }),
      ).rejects.toBeInstanceOf(Forbidden);
      // Unknown ids are not found.
      await expect(
        getMilestonePlan(ctx, world.ownerActor, { id: crypto.randomUUID() }),
      ).rejects.toBeInstanceOf(NotFound);
      await expect(
        updateWave(ctx, world.ownerActor, { id: crypto.randomUUID(), name: 'x' }),
      ).rejects.toBeInstanceOf(NotFound);
    });

    it('takes edits and results on a Completed milestone', async () => {
      const { milestone, waves } = await setup(1);
      await ctx.db
        .update(schema.milestone)
        .set({ status: 'completed', completedAt: new Date() })
        .where(eq(schema.milestone.id, milestone.id));
      await expect(
        updateWave(ctx, world.memberActor, { id: waves[0]?.id as string, name: 'Tidied' }),
      ).resolves.toMatchObject({
        name: 'Tidied',
      });
      await expect(
        recordGateResult(ctx, world.memberActor, {
          id: waves[0]?.id as string,
          state: 'passed',
          note: 'After the fact',
        }),
      ).resolves.toMatchObject({ gate: { state: 'passed' } });
    });
  });

  it('returns the plan: milestone with summary, plan link, waves in order with their tasks, the rest', async () => {
    const { project, milestone, waves } = await setup(3);
    const [w1, w2, w3] = waves;
    const make = (title: string, values: Partial<Parameters<typeof createTask>[2]> = {}) =>
      createTask(ctx, world.ownerActor, { project: project.key, title, milestone: milestone.id, ...values });
    const done = await make('Ledger table', { status: 'done', assignee: world.agent.id });
    const review = await make('Retry button', { status: 'in_review' });
    const todo = await make('Banner', { status: 'todo', priority: 'urgent' });
    const later = await make('Feature flag');
    const loose = await make('Docs');
    await putTasksInWave(ctx, world.ownerActor, {
      milestone: milestone.id,
      wave: w1?.id as string,
      keys: [done.key],
    });
    await putTasksInWave(ctx, world.ownerActor, {
      milestone: milestone.id,
      wave: w2?.id as string,
      keys: [review.key, todo.key],
    });
    await putTasksInWave(ctx, world.ownerActor, {
      milestone: milestone.id,
      wave: w3?.id as string,
      keys: [later.key],
    });
    await recordGateResult(ctx, world.agentActor, {
      id: w1?.id as string,
      state: 'passed',
      note: 'Balanced',
    });
    await ctx.db
      .update(schema.milestone)
      .set({ planUrl: 'plans/payouts-v2.html' })
      .where(eq(schema.milestone.id, milestone.id));

    const plan = await getMilestonePlan(ctx, world.memberActor, { id: milestone.id });
    expect(plan.planUrl).toBe('plans/payouts-v2.html');
    expect(plan.milestone).toMatchObject({
      id: milestone.id,
      planUrl: 'plans/payouts-v2.html',
      waves: { count: 3, current: 2, currentState: 'open', allPassed: false },
      progress: { total: 5 },
    });
    expect(plan.waves.map((wave) => [wave.number, wave.current, wave.locked, wave.lockedUntil])).toEqual([
      [1, false, false, null],
      [2, true, false, null],
      [3, false, true, { number: 2, name: 'B' }],
    ]);
    expect(plan.waves[0]).toMatchObject({
      gate: { description: 'Checks for A', state: 'passed', result: { recordedBy: { id: world.agent.id } } },
      tasks: [
        { key: done.key, status: 'done', assignee: { id: world.agent.id, kind: 'agent' }, archived: false },
      ],
    });
    // Task list order: status, then priority.
    expect(plan.waves[1]?.tasks.map((row) => row.key)).toEqual([todo.key, review.key]);
    expect(plan.waves[1]).toMatchObject({ canPass: false, openKeys: [todo.key, review.key] });
    expect(plan.notInWave.map((row) => row.key)).toEqual([loose.key]);

    const list = await listMilestones(ctx, world.memberActor, { project: project.key });
    expect(list.items[0]).toMatchObject({
      planUrl: 'plans/payouts-v2.html',
      waves: { count: 3, current: 2 },
    });
  });

  it('stores waves and results in the milestone workspace', async () => {
    const { milestone, waves } = await setup(1);
    await recordGateResult(ctx, world.ownerActor, { id: waves[0]?.id as string, state: 'failed', note: 'x' });
    const rows = await ctx.db
      .select({ w: schema.wave.workspaceId, g: schema.gateResult.workspaceId })
      .from(schema.wave)
      .innerJoin(schema.gateResult, eq(schema.gateResult.waveId, schema.wave.id))
      .where(and(eq(schema.wave.milestoneId, milestone.id)));
    expect(rows).toEqual([{ w: world.workspaceId, g: world.workspaceId }]);
  });
});
