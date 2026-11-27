import { type Db, schema } from '@zamu/db';
import { eq, sql } from 'drizzle-orm';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { listTaskActivity } from './activity';
import type { ClockContext } from './cycles';
import { Conflict, Forbidden, Invalid, NotFound } from './errors';
import {
  activateMilestoneForTask,
  createMilestone,
  deleteMilestone,
  getMilestone,
  listMilestones,
  updateMilestone,
} from './milestones';
import { createProject, updateProject } from './projects';
import { createWorld, randomProjectKey, type TestContext, testContext, type World } from './testing/fixtures';
import { createWave } from './waves';

function clockAt(iso: string, timeZone = 'UTC'): ClockContext {
  const now = new Date(iso);
  return { timeZone, now: () => now };
}

type TaskStatus = 'backlog' | 'todo' | 'in_progress' | 'in_review' | 'done' | 'canceled';

/** Inserts a task directly, so these tests do not depend on the task service. */
async function insertTask(
  db: Db,
  world: World,
  projectId: string,
  milestoneId: string | null,
  status: TaskStatus,
) {
  const [row] = await db
    .insert(schema.task)
    .values({
      projectId,
      number: sql`(select coalesce(max(${schema.task.number}), 0) + 1 from ${schema.task} where ${schema.task.projectId} = ${projectId})`,
      title: 'A task',
      createdById: world.owner.id,
      status,
      milestoneId,
    })
    .returning();
  if (!row) throw new Error('task insert failed');
  return row;
}

describe('milestones', () => {
  let ctx: TestContext;
  let world: World;

  beforeAll(async () => {
    ctx = testContext();
    world = await createWorld(ctx.db);
  });
  afterAll(async () => {
    await ctx?.close();
  });

  const newProject = () =>
    createProject(ctx, world.ownerActor, { name: 'Payments', key: randomProjectKey() });

  it('creates Planned milestones with names unique per project, ignoring case', async () => {
    const project = await newProject();
    const created = await createMilestone(ctx, world.agentActor, {
      project: project.key,
      name: ' Webhooks v2 ',
      description: 'Retry and signing',
      targetDate: '2040-11-14',
    });
    expect(created).toMatchObject({
      project: { id: project.id, key: project.key },
      name: 'Webhooks v2',
      description: 'Retry and signing',
      targetDate: '2040-11-14',
      status: 'planned',
      completedAt: null,
      createdBy: { id: world.agent.id, kind: 'agent' },
      progress: { total: 0, done: 0, inProgress: 0, open: 0, canceled: 0 },
      overdue: false,
    });

    await expect(
      createMilestone(ctx, world.ownerActor, { project: project.key, name: 'WEBHOOKS V2' }),
    ).rejects.toThrow(Conflict);
    const other = await newProject();
    await expect(
      createMilestone(ctx, world.ownerActor, { project: other.key, name: 'Webhooks v2' }),
    ).resolves.toMatchObject({
      targetDate: null,
      description: null,
    });
    await expect(
      createMilestone(ctx, world.ownerActor, { project: project.key, name: '  ' }),
    ).rejects.toThrow(Invalid);
  });

  it('lists milestones with progress, days left and overdue', async () => {
    const project = await newProject();
    const clock = { ...ctx, ...clockAt('2040-03-10T12:00:00Z') };
    const late = await createMilestone(clock, world.ownerActor, {
      project: project.key,
      name: 'Late',
      targetDate: '2040-03-01',
    });
    const soon = await createMilestone(clock, world.ownerActor, {
      project: project.key,
      name: 'Soon',
      targetDate: '2040-03-13',
    });
    await createMilestone(clock, world.ownerActor, { project: project.key, name: 'Someday' });
    for (const status of [
      'backlog',
      'todo',
      'in_progress',
      'in_review',
      'done',
      'done',
      'canceled',
    ] as const) {
      await insertTask(ctx.db, world, project.id, soon.id, status);
    }
    await insertTask(ctx.db, world, project.id, null, 'todo');

    const { items } = await listMilestones(clock, world.memberActor, { project: project.key });
    expect(items.map((m) => m.name)).toEqual(['Late', 'Soon', 'Someday']);
    expect(items[0]).toMatchObject({ daysLeft: -9, overdue: true });
    expect(items[1]).toMatchObject({
      daysLeft: 3,
      overdue: false,
      progress: { total: 7, done: 2, inProgress: 2, open: 2, canceled: 1 },
    });
    expect(items[2]).toMatchObject({ daysLeft: null, overdue: false });

    // Completed milestones are never overdue; the status filter narrows the list.
    await updateMilestone(clock, world.ownerActor, { id: late.id, status: 'completed' });
    expect((await getMilestone(clock, world.memberActor, { id: late.id })).overdue).toBe(false);
    const completed = await listMilestones(clock, world.memberActor, {
      project: project.key,
      status: 'completed',
    });
    expect(completed.items.map((m) => m.id)).toEqual([late.id]);
  });

  it('updates fields and status: completed by hand, reopened as active', async () => {
    const project = await newProject();
    const clock = { ...ctx, ...clockAt('2040-03-10T12:00:00Z') };
    const m = await createMilestone(clock, world.ownerActor, { project: project.key, name: 'Launch' });
    const taken = await createMilestone(clock, world.ownerActor, { project: project.key, name: 'Beta' });

    const edited = await updateMilestone(clock, world.memberActor, {
      id: m.id,
      name: 'Launch day',
      description: 'Go live',
      targetDate: '2040-04-01',
    });
    expect(edited).toMatchObject({ name: 'Launch day', description: 'Go live', targetDate: '2040-04-01' });
    const cleared = await updateMilestone(clock, world.memberActor, {
      id: m.id,
      description: null,
      targetDate: null,
    });
    expect(cleared).toMatchObject({ description: null, targetDate: null });
    await expect(updateMilestone(clock, world.memberActor, { id: m.id, name: 'beta' })).rejects.toThrow(
      /already exists/,
    );
    // Renaming to a different case of its own name is fine.
    expect((await updateMilestone(clock, world.memberActor, { id: taken.id, name: 'BETA' })).name).toBe(
      'BETA',
    );

    const done = await updateMilestone(clock, world.memberActor, { id: m.id, status: 'completed' });
    expect(done).toMatchObject({ status: 'completed', completedAt: '2040-03-10T12:00:00.000Z' });
    const reopened = await updateMilestone(clock, world.memberActor, { id: m.id, status: 'planned' });
    expect(reopened).toMatchObject({ status: 'active', completedAt: null });
    const planned = await updateMilestone(clock, world.memberActor, { id: m.id, status: 'planned' });
    expect(planned.status).toBe('planned');
  });

  it('activates a Planned milestone when a task in it starts', async () => {
    const project = await newProject();
    const m = await createMilestone(ctx, world.ownerActor, { project: project.key, name: 'Start' });

    expect(await ctx.db.transaction((tx) => activateMilestoneForTask(tx, m.id))).toBe(true);
    expect((await getMilestone(ctx, world.ownerActor, { id: m.id })).status).toBe('active');
    expect(await ctx.db.transaction((tx) => activateMilestoneForTask(tx, m.id))).toBe(false);

    await updateMilestone(ctx, world.ownerActor, { id: m.id, status: 'completed' });
    expect(await ctx.db.transaction((tx) => activateMilestoneForTask(tx, m.id))).toBe(false);
    expect((await getMilestone(ctx, world.ownerActor, { id: m.id })).status).toBe('completed');

    expect(await ctx.db.transaction((tx) => activateMilestoneForTask(tx, null))).toBe(false);
    expect(await ctx.db.transaction((tx) => activateMilestoneForTask(tx, crypto.randomUUID()))).toBe(false);

    // It joins the caller's transaction: a rollback undoes it.
    const other = await createMilestone(ctx, world.ownerActor, { project: project.key, name: 'Rolled back' });
    await expect(
      ctx.db.transaction(async (tx) => {
        await activateMilestoneForTask(tx, other.id);
        throw new Error('roll back');
      }),
    ).rejects.toThrow('roll back');
    expect((await getMilestone(ctx, world.ownerActor, { id: other.id })).status).toBe('planned');
  });

  it('deletes a milestone and clears it from its tasks with activity', async () => {
    const project = await newProject();
    const m = await createMilestone(ctx, world.ownerActor, { project: project.key, name: 'Doomed' });
    const task = await insertTask(ctx.db, world, project.id, m.id, 'todo');

    await deleteMilestone(ctx, world.agentActor, { id: m.id });
    await expect(getMilestone(ctx, world.ownerActor, { id: m.id })).rejects.toThrow(NotFound);
    const [row] = await ctx.db.select().from(schema.task).where(eq(schema.task.id, task.id));
    expect(row?.milestoneId).toBeNull();
    const { items } = await listTaskActivity(ctx, world.ownerActor, { key: `${project.key}-${task.number}` });
    expect(items).toEqual([
      expect.objectContaining({
        type: 'task.updated',
        actor: expect.objectContaining({ id: world.agent.id }),
        changes: [{ field: 'milestone', from: { id: m.id, name: 'Deleted milestone' }, to: null }],
      }),
    ]);
  });

  it('rejects writes when the project does not use milestones, and keeps reads', async () => {
    const project = await newProject();
    const m = await createMilestone(ctx, world.ownerActor, { project: project.key, name: 'Kept' });
    await updateProject(ctx, world.ownerActor, { project: project.key, usesMilestones: false });

    await expect(
      createMilestone(ctx, world.ownerActor, { project: project.key, name: 'New' }),
    ).rejects.toThrow(/does not use milestones/);
    await expect(updateMilestone(ctx, world.ownerActor, { id: m.id, name: 'x' })).rejects.toThrow(Conflict);
    await expect(deleteMilestone(ctx, world.ownerActor, { id: m.id })).rejects.toThrow(Conflict);
    expect((await listMilestones(ctx, world.ownerActor, { project: project.key })).items).toHaveLength(1);

    await updateProject(ctx, world.ownerActor, { project: project.key, usesMilestones: true });
    await expect(updateMilestone(ctx, world.ownerActor, { id: m.id, name: 'Back' })).resolves.toMatchObject({
      name: 'Back',
    });
  });

  it('checks workspace, key scope and access', async () => {
    const project = await newProject();
    const other = await newProject();
    const m = await createMilestone(ctx, world.ownerActor, { project: project.key, name: 'Scoped' });
    const readOnly = { ...world.agentActor, scope: { projects: 'all' as const, access: 'read' as const } };
    const scoped = { ...world.agentActor, scope: { projects: [other.id], access: 'write' as const } };

    expect((await getMilestone(ctx, readOnly, { id: m.id })).name).toBe('Scoped');
    await expect(createMilestone(ctx, readOnly, { project: project.key, name: 'No' })).rejects.toThrow(
      Forbidden,
    );
    await expect(updateMilestone(ctx, readOnly, { id: m.id, name: 'No' })).rejects.toThrow(Forbidden);
    await expect(deleteMilestone(ctx, readOnly, { id: m.id })).rejects.toThrow(Forbidden);
    await expect(getMilestone(ctx, scoped, { id: m.id })).rejects.toThrow(Forbidden);
    await expect(listMilestones(ctx, scoped, { project: project.key })).rejects.toThrow(Forbidden);

    const elsewhere = await createWorld(ctx.db, 'Elsewhere');
    await expect(getMilestone(ctx, elsewhere.ownerActor, { id: m.id })).rejects.toThrow(NotFound);
    await expect(deleteMilestone(ctx, elsewhere.ownerActor, { id: m.id })).rejects.toThrow(NotFound);
  });

  it('M8: sets and clears the plan link, and lists it with the wave summary', async () => {
    const project = await newProject();
    const m = await createMilestone(ctx, world.ownerActor, { project: project.key, name: 'Payouts v2' });
    expect(m).toMatchObject({ planUrl: null, waves: null });
    const linked = await updateMilestone(ctx, world.agentActor, {
      id: m.id,
      planUrl: '  https://wiki.northwind.dev/plans/payouts-v2  ',
    });
    expect(linked.planUrl).toBe('https://wiki.northwind.dev/plans/payouts-v2');
    const path = await updateMilestone(ctx, world.memberActor, {
      id: m.id,
      planUrl: 'plans/payouts-v2.html',
    });
    expect(path.planUrl).toBe('plans/payouts-v2.html');
    await expect(updateMilestone(ctx, world.memberActor, { id: m.id, planUrl: 'a\nb' })).rejects.toThrow(
      Invalid,
    );
    await createWave(ctx, world.ownerActor, { milestone: m.id, name: 'Ledger' });
    await createWave(ctx, world.ownerActor, { milestone: m.id, name: 'Screens' });
    const { items } = await listMilestones(ctx, world.memberActor, { project: project.key });
    expect(items[0]).toMatchObject({
      planUrl: 'plans/payouts-v2.html',
      waves: { count: 2, current: 1, currentState: 'open', allPassed: false },
    });
    const cleared = await updateMilestone(ctx, world.memberActor, { id: m.id, planUrl: null });
    expect(cleared.planUrl).toBeNull();
  });

  it('M8: deleting a milestone deletes its waves; its tasks record leaving the wave', async () => {
    const project = await newProject();
    const m = await createMilestone(ctx, world.ownerActor, { project: project.key, name: 'Payouts v2' });
    const wave = await createWave(ctx, world.ownerActor, { milestone: m.id, name: 'Ledger' });
    const task = await insertTask(ctx.db, world, project.id, m.id, 'todo');
    await ctx.db.update(schema.task).set({ waveId: wave.id }).where(eq(schema.task.id, task.id));
    await deleteMilestone(ctx, world.ownerActor, { id: m.id });
    const [row] = await ctx.db.select().from(schema.task).where(eq(schema.task.id, task.id));
    expect(row).toMatchObject({ milestoneId: null, waveId: null });
    const waves = await ctx.db.select().from(schema.wave).where(eq(schema.wave.milestoneId, m.id));
    expect(waves).toEqual([]);
    const { items } = await listTaskActivity(ctx, world.memberActor, {
      key: `${project.key}-${task.number}`,
    });
    expect(items.at(-1)?.changes).toEqual([
      { field: 'milestone', from: { id: m.id, name: 'Deleted milestone' }, to: null },
      { field: 'wave', from: { id: wave.id, number: 1, name: 'Ledger', removed: true }, to: null },
    ]);
  });
});
