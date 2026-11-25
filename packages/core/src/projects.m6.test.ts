// M6: a project's default done items: who may set them, how they read back, and the limits.
import { MAX_WORK_ITEMS } from '@zamu/contracts';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { Forbidden, Invalid } from './errors';
import { createProject, listProjects, updateProject } from './projects';
import {
  createWorld,
  keyActor,
  randomProjectKey,
  type TestContext,
  testContext,
  type World,
} from './testing/fixtures';

describe('default done items', () => {
  let ctx: TestContext;
  let world: World;
  let key: string;

  beforeAll(async () => {
    ctx = testContext();
    world = await createWorld(ctx.db);
    key = randomProjectKey();
    await createProject(ctx, world.ownerActor, { key, name: 'Payments API' });
  });
  afterAll(async () => {
    await ctx?.close();
  });

  it('start empty and are replaced by owners and admins', async () => {
    const listed = await listProjects(ctx, world.memberActor);
    expect(listed.items.find((item) => item.key === key)?.defaultDoneItems).toEqual([]);
    const updated = await updateProject(ctx, world.ownerActor, {
      project: key,
      defaultDoneItems: ['Tests pass', '  Docs updated  '],
    });
    expect(updated.defaultDoneItems).toEqual(['Tests pass', 'Docs updated']);
    const cleared = await updateProject(ctx, world.ownerActor, { project: key, defaultDoneItems: [] });
    expect(cleared.defaultDoneItems).toEqual([]);
  });

  it('refuse members, agents and project-scoped keys', async () => {
    await expect(
      updateProject(ctx, world.memberActor, { project: key, defaultDoneItems: ['A'] }),
    ).rejects.toThrow(Forbidden);
    await expect(
      updateProject(ctx, world.agentActor, { project: key, defaultDoneItems: ['A'] }),
    ).rejects.toThrow(Forbidden);
    const ownerKey = { ...keyActor(world, { projects: 'all', access: 'read' }), ...world.ownerActor };
    await expect(
      updateProject(
        ctx,
        { ...ownerKey, scope: { projects: 'all', access: 'read' } },
        { project: key, defaultDoneItems: ['A'] },
      ),
    ).rejects.toThrow(Forbidden);
    // Members still rename the project.
    await expect(
      updateProject(ctx, world.memberActor, { project: key, name: 'Payments' }),
    ).resolves.toMatchObject({
      name: 'Payments',
    });
  });

  it(`take at most ${MAX_WORK_ITEMS} one-line items`, async () => {
    const many = Array.from({ length: MAX_WORK_ITEMS + 1 }, (_, i) => `Item ${i}`);
    await expect(
      updateProject(ctx, world.ownerActor, { project: key, defaultDoneItems: many }),
    ).rejects.toThrow(Invalid);
    await expect(
      updateProject(ctx, world.ownerActor, { project: key, defaultDoneItems: ['a\nb'] }),
    ).rejects.toThrow(Invalid);
  });
});
