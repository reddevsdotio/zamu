// M7 projects: the archive setting. New projects start with 14 days, owners and admins change it
// (1 to 365, null is off), and a mirrored project follows Backlog.md's archive folder instead.
import { schema } from '@zamu/db';
import { eq } from 'drizzle-orm';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { Forbidden, Invalid, ProjectMirrored } from './errors';
import { createProject, listProjects, updateProject } from './projects';
import { createMirroredProject } from './testing/backlog';
import { createWorld, randomProjectKey, type TestContext, testContext, type World } from './testing/fixtures';

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

describe('archive setting', () => {
  let ctx: TestContext;
  let world: World;

  beforeAll(async () => {
    ctx = testContext();
    world = await createWorld(ctx.db);
  });
  afterAll(async () => {
    await ctx?.close();
  });

  it('starts new projects at 14 days and lets owners and admins change or turn it off', async () => {
    const key = randomProjectKey();
    const created = await createProject(ctx, world.ownerActor, { key, name: 'Payments' });
    expect(created.archiveAfterDays).toBe(14);
    expect(
      (await updateProject(ctx, world.ownerActor, { project: key, archiveAfterDays: 30 })).archiveAfterDays,
    ).toBe(30);
    expect(
      (await updateProject(ctx, world.ownerActor, { project: key, archiveAfterDays: null })).archiveAfterDays,
    ).toBe(null);
    const listed = await listProjects(ctx, world.memberActor);
    expect(listed.items.find((item) => item.key === key)?.archiveAfterDays).toBeNull();

    await rejection(updateProject(ctx, world.memberActor, { project: key, archiveAfterDays: 7 }), Forbidden);
    await rejection(updateProject(ctx, world.agentActor, { project: key, archiveAfterDays: 7 }), Forbidden);
    await rejection(updateProject(ctx, world.ownerActor, { project: key, archiveAfterDays: 0 }), Invalid);
    await rejection(updateProject(ctx, world.ownerActor, { project: key, archiveAfterDays: 366 }), Invalid);
  });

  it('refuses the setting on a mirrored project and reads it as off there', async () => {
    const mirror = await createMirroredProject(ctx.db, world);
    await ctx.db
      .update(schema.project)
      .set({ archiveAfterDays: 14 })
      .where(eq(schema.project.id, mirror.project.id));
    const error = await rejection(
      updateProject(ctx, world.ownerActor, { project: mirror.key, archiveAfterDays: 7 }),
      ProjectMirrored,
    );
    expect(error.message).toContain('archive/tasks/');
    const listed = await listProjects(ctx, world.ownerActor);
    expect(listed.items.find((item) => item.key === mirror.key)?.archiveAfterDays).toBeNull();
  });
});
