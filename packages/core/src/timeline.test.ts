import { schema } from '@zamu/db';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { recordActivities, recordActivity } from './activity';
import { createComment, deleteComment } from './comments';
import { Forbidden, NotFound } from './errors';
import { createWorld, randomProjectKey, type TestContext, testContext, type World } from './testing/fixtures';
import { listTaskTimeline } from './timeline';

describe('timeline', () => {
  let ctx: TestContext;
  let world: World;
  let projectId: string;
  let projectKey: string;
  let nextNumber = 1;

  // Local fixtures: rows are written directly so this suite does not depend on tasks.ts.
  async function newTask() {
    const number = nextNumber++;
    const [row] = await ctx.db
      .insert(schema.task)
      .values({ projectId, number, title: `Task ${number}`, createdById: world.owner.id })
      .returning();
    if (!row) throw new Error('task insert failed');
    return { row, key: `${projectKey}-${number}` };
  }

  beforeAll(async () => {
    ctx = testContext();
    world = await createWorld(ctx.db);
    projectKey = randomProjectKey();
    const [row] = await ctx.db
      .insert(schema.project)
      .values({ workspaceId: world.workspaceId, key: projectKey, name: 'Payments' })
      .returning();
    if (!row) throw new Error('project insert failed');
    projectId = row.id;
  });
  afterAll(async () => {
    await ctx?.close();
  });

  it('merges activity and comments oldest first, with deleted comments in place', async () => {
    const { row: task, key } = await newTask();
    const [cycle] = await ctx.db
      .insert(schema.cycle)
      .values({
        workspaceId: world.workspaceId,
        projectId,
        number: 1,
        startsOn: '2026-01-01',
        endsOn: '2026-01-14',
      })
      .returning();
    if (!cycle) throw new Error('cycle insert failed');

    await ctx.db.transaction((tx) =>
      recordActivity(tx, world.ownerActor, {
        projectId,
        taskId: task.id,
        type: 'task.created',
        changes: [{ field: 'title', from: null, to: task.title }],
      }),
    );
    const first = await createComment(ctx, world.agentActor, {
      key,
      body: `Picked up. @${world.owner.email}`,
    });
    await ctx.db.transaction((tx) =>
      recordActivity(tx, world.agentActor, {
        projectId,
        taskId: task.id,
        type: 'task.updated',
        changes: [{ field: 'status', from: 'todo', to: 'in_progress' }],
      }),
    );
    const second = await createComment(ctx, world.memberActor, { key, body: 'Never mind' });
    await deleteComment(ctx, world.memberActor, { id: second.id });
    await ctx.db.transaction((tx) =>
      recordActivities(tx, null, [
        {
          workspaceId: world.workspaceId,
          projectId,
          taskId: task.id,
          type: 'cycle.ended',
          changes: [{ field: 'cycle', from: cycle.id, to: null }],
        },
      ]),
    );

    const { items } = await listTaskTimeline(ctx, world.memberActor, { key: key.toLowerCase() });
    expect(items.map((item) => [item.kind, item.id])).toEqual([
      ['activity', expect.any(String)],
      ['comment', first.id],
      ['activity', expect.any(String)],
      ['comment', second.id],
      ['activity', expect.any(String)],
    ]);
    expect(items[0]).toMatchObject({ kind: 'activity', type: 'task.created', taskKey: key });
    expect(items[1]).toMatchObject({
      kind: 'comment',
      taskKey: key,
      author: { id: world.agent.id, kind: 'agent' },
      onBehalfOf: { id: world.member.id },
      mentions: [{ id: world.owner.id }],
    });
    expect(items[2]).toMatchObject({ kind: 'activity', actor: { id: world.agent.id } });
    // Deleted: no body, and the author is who deleted it.
    expect(items[3]).toMatchObject({ kind: 'comment', body: null, author: { id: world.member.id } });
    expect(items[3]?.kind === 'comment' && items[3].deletedAt).toBeTruthy();
    expect(items[4]).toMatchObject({
      kind: 'activity',
      type: 'cycle.ended',
      actor: null,
      changes: [{ field: 'cycle', from: { id: cycle.id, number: 1 }, to: null }],
    });
  });

  it('breaks ties on the same timestamp by id', async () => {
    const { row: task, key } = await newTask();
    // One transaction: every row gets the same now(), so only the ids order them.
    await ctx.db.transaction(async (tx) => {
      await tx.insert(schema.comment).values({
        workspaceId: world.workspaceId,
        projectId,
        taskId: task.id,
        authorId: world.owner.id,
        body: 'b',
      });
      await recordActivity(tx, world.ownerActor, {
        projectId,
        taskId: task.id,
        type: 'task.updated',
        changes: [{ field: 'priority', from: 'none', to: 'high' }],
      });
      await tx.insert(schema.comment).values({
        workspaceId: world.workspaceId,
        projectId,
        taskId: task.id,
        authorId: world.member.id,
        body: 'd',
      });
    });

    const { items } = await listTaskTimeline(ctx, world.ownerActor, { key });
    expect(items).toHaveLength(3);
    expect(new Set(items.map((item) => item.createdAt)).size).toBe(1);
    const ids = items.map((item) => item.id);
    expect(ids).toEqual([...ids].sort());
    expect(items.map((item) => item.kind)).toEqual(['comment', 'activity', 'comment']);
  });

  it('returns an empty list for a task without history', async () => {
    const { key } = await newTask();
    expect(await listTaskTimeline(ctx, world.ownerActor, { key })).toEqual({
      items: [],
      counts: { all: 0, comments: 0, notes: 0, history: 0 },
    });
  });

  it('honours key scope and workspaces', async () => {
    const { key } = await newTask();
    const elsewhere = {
      ...world.agentActor,
      scope: { projects: [crypto.randomUUID()], access: 'read' as const },
    };
    await expect(listTaskTimeline(ctx, elsewhere, { key })).rejects.toBeInstanceOf(Forbidden);
    const other = await createWorld(ctx.db, 'Elsewhere');
    await expect(listTaskTimeline(ctx, other.ownerActor, { key })).rejects.toBeInstanceOf(NotFound);
  });
});
