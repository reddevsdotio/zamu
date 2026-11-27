// M3: milestones of a project mirrored from Backlog.md are read-only in the app.
import { MILESTONE_OWNED_FIELDS } from '@zamu/contracts';
import { schema } from '@zamu/db';
import { eq } from 'drizzle-orm';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { MilestoneMirrored, mirroredExtensions } from './errors';
import {
  createMilestone,
  deleteMilestone,
  getMilestone,
  listMilestones,
  updateMilestone,
} from './milestones';
import { createMirroredProject, createMirroredTaskRow, type MirroredProject } from './testing/backlog';
import {
  createMilestoneRow,
  createWorld,
  type TestContext,
  testContext,
  type World,
} from './testing/fixtures';
import { createWave, recordGateResult } from './waves';

async function rejection(promise: Promise<unknown>): Promise<MilestoneMirrored> {
  const error = await promise.then(
    () => null,
    (caught: unknown) => caught,
  );
  expect(error).toBeInstanceOf(MilestoneMirrored);
  return error as MilestoneMirrored;
}

describe('milestones of a project mirrored from Backlog.md', () => {
  let ctx: TestContext;
  let world: World;
  let mirror: MirroredProject;

  beforeAll(async () => {
    ctx = testContext();
    world = await createWorld(ctx.db);
    mirror = await createMirroredProject(ctx.db, world);
  });
  afterAll(async () => {
    await ctx?.close();
  });

  it('lists them locked, with their Backlog.md id, leaving hidden milestones and tasks out', async () => {
    const hidden = await createMilestoneRow(ctx.db, mirror.scope, {
      name: 'Old plan',
      backlogId: 'm-0',
      hiddenAt: new Date(),
      createdById: world.owner.id,
    });
    // A hidden open task in the milestone does not count towards its progress.
    await createMirroredTaskRow(ctx.db, mirror.scope, {
      number: 790,
      backlogId: 'BACK-790',
      status: 'todo',
      milestoneId: mirror.milestone.id,
      hiddenAt: new Date(),
      createdById: world.owner.id,
    });
    const { items } = await listMilestones(ctx, world.memberActor, { project: mirror.key });
    expect(items.map((item) => item.id)).toEqual([mirror.milestone.id]);
    expect(items[0]).toMatchObject({
      name: 'Webhooks v2',
      backlogId: 'm-1',
      locked: [...MILESTONE_OWNED_FIELDS],
      hidden: false,
      progress: { total: 1, inProgress: 1, open: 0 },
    });
    await expect(getMilestone(ctx, world.memberActor, { id: hidden.id })).resolves.toMatchObject({
      hidden: true,
      backlogId: 'm-0',
    });
  });

  it('refuses creating one with a backlog milestone add hint', async () => {
    const error = await rejection(
      createMilestone(ctx, world.ownerActor, {
        project: mirror.key,
        name: 'Payouts',
        targetDate: '2026-12-01',
      }),
    );
    expect(error.code).toBe('MILESTONE_MIRRORED');
    expect(error.message).toContain('Milestones in Payments API come from Backlog.md');
    expect(mirroredExtensions(error)).toEqual({
      hint: 'backlog milestone add Payouts --due-date 2026-12-01',
    });
  });

  it('refuses changes with field, file, Backlog.md id and hint', async () => {
    const { id } = mirror.milestone;
    const renamed = await rejection(updateMilestone(ctx, world.agentActor, { id, name: 'Webhooks v3' }));
    expect(renamed.message).toBe("Webhooks v2 is mirrored from Backlog.md, so its name can't change here");
    expect(renamed.extensions).toEqual({
      field: 'name',
      file: mirror.files.milestone,
      backlogId: 'm-1',
      hint: 'backlog milestone rename m-1 "Webhooks v3"',
    });
    const done = await rejection(updateMilestone(ctx, world.memberActor, { id, status: 'completed' }));
    expect(done.extensions).toMatchObject({ field: 'status', hint: 'backlog milestone archive m-1' });
    const dated = await rejection(updateMilestone(ctx, world.memberActor, { id, targetDate: '2026-12-24' }));
    expect(dated.extensions).toMatchObject({ field: 'targetDate' });
    expect(dated.message).toContain('target date');
    const described = await rejection(updateMilestone(ctx, world.memberActor, { id, description: 'More' }));
    expect(described.extensions.field).toBe('description');

    // Sending the stored values changes nothing and passes.
    await expect(
      updateMilestone(ctx, world.memberActor, { id, name: 'Webhooks v2', status: 'active' }),
    ).resolves.toMatchObject({ name: 'Webhooks v2', status: 'active' });
  });

  it('refuses deleting one, keeping its tasks', async () => {
    const error = await rejection(deleteMilestone(ctx, world.ownerActor, { id: mirror.milestone.id }));
    expect(error.message).toBe("Webhooks v2 is mirrored from Backlog.md, so it can't be deleted here");
    expect(error.extensions).toEqual({
      file: mirror.files.milestone,
      backlogId: 'm-1',
      hint: 'backlog milestone remove m-1',
    });
    const [task] = await ctx.db
      .select({ milestoneId: schema.task.milestoneId })
      .from(schema.task)
      .where(eq(schema.task.id, mirror.tasks.parent.id));
    expect(task?.milestoneId).toBe(mirror.milestone.id);
  });

  it('makes everything editable once detached', async () => {
    const w = await createWorld(ctx.db);
    const detached = await createMirroredProject(ctx.db, w, { state: 'detached' });
    const updated = await updateMilestone(ctx, w.memberActor, { id: detached.milestone.id, name: 'Renamed' });
    expect(updated).toMatchObject({ name: 'Renamed', locked: [], backlogId: 'm-1' });
    await expect(
      createMilestone(ctx, w.memberActor, { project: detached.key, name: 'New one' }),
    ).resolves.toMatchObject({ locked: [], backlogId: null });
    await expect(deleteMilestone(ctx, w.memberActor, { id: detached.milestone.id })).resolves.toBeUndefined();
  });

  it('M8: takes a plan link, waves and gates: Zamu holds them, not Backlog.md', async () => {
    const w = await createWorld(ctx.db);
    const own = await createMirroredProject(ctx.db, w);
    const { id } = own.milestone;
    const linked = await updateMilestone(ctx, w.agentActor, { id, planUrl: 'plans/webhooks-v2.html' });
    expect(linked).toMatchObject({ planUrl: 'plans/webhooks-v2.html', locked: [...MILESTONE_OWNED_FIELDS] });
    // The plan link with an owned field still refuses, naming the owned field.
    const refused = await rejection(
      updateMilestone(ctx, w.agentActor, { id, planUrl: 'plans/other.html', name: 'Webhooks v3' }),
    );
    expect(refused.extensions.field).toBe('name');
    const [row] = await ctx.db.select().from(schema.milestone).where(eq(schema.milestone.id, id));
    expect(row?.planUrl).toBe('plans/webhooks-v2.html');
    const wave = await createWave(ctx, w.memberActor, { milestone: id, name: 'Delivery' });
    await expect(getMilestone(ctx, w.memberActor, { id })).resolves.toMatchObject({
      waves: { count: 1, current: 1, currentState: 'open' },
    });
    await expect(
      recordGateResult(ctx, w.memberActor, { id: wave.id, state: 'failed', note: 'Retries still loop' }),
    ).resolves.toMatchObject({ gate: { state: 'failed' } });
  });
});
