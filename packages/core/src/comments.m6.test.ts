// M6: work notes (comments of kind note): mentions, the machine and branch, mirrored tasks, and
// the timeline's show filter with its four counts.
import { schema } from '@zamu/db';
import { eq } from 'drizzle-orm';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import type { Actor } from './authz';
import { createComment, deleteComment, listComments } from './comments';
import { TaskMirrored } from './errors';
import { formatMention } from './mentions';
import { createProject } from './projects';
import { createTask, updateTask } from './tasks';
import { createMirroredProject, type MirroredProject } from './testing/backlog';
import { createWorld, randomProjectKey, type TestContext, testContext, type World } from './testing/fixtures';
import { listTaskTimeline } from './timeline';

describe('work notes and the timeline filter', () => {
  let ctx: TestContext;
  let world: World;
  let key: string;
  let cliAgent: Actor;
  let mirror: MirroredProject;

  beforeAll(async () => {
    ctx = testContext();
    world = await createWorld(ctx.db);
    key = randomProjectKey();
    await createProject(ctx, world.ownerActor, { key, name: 'Payments API' });
    cliAgent = { ...world.agentActor, source: { machine: 'kaggia', branch: null } };
    mirror = await createMirroredProject(ctx.db, world);
  });
  afterAll(async () => {
    await ctx?.close();
  });

  async function mentionRows(commentId: string) {
    return ctx.db
      .select({ userId: schema.commentMention.userId })
      .from(schema.commentMention)
      .where(eq(schema.commentMention.commentId, commentId));
  }

  it('writes notes with their kind and source; they notify only the people they mention', async () => {
    const task = await createTask(ctx, world.memberActor, { project: key, title: 'Notes' });
    const quiet = await createComment(ctx, cliAgent, {
      key: task.key,
      kind: 'note',
      body: 'Migration written and tested',
    });
    expect(quiet).toMatchObject({ kind: 'note', source: { machine: 'kaggia', branch: null }, mentions: [] });
    expect(await mentionRows(quiet.id)).toEqual([]);

    const mention = formatMention(world.owner.name, world.owner.id);
    const loud = await createComment(ctx, cliAgent, {
      key: task.key,
      kind: 'note',
      body: `Needs a decision from ${mention}`,
    });
    expect(loud.mentions.map((user) => user.id)).toEqual([world.owner.id]);
    expect(await mentionRows(loud.id)).toEqual([{ userId: world.owner.id }]);

    const plain = await createComment(ctx, world.memberActor, { key: task.key, body: 'A comment' });
    expect(plain).toMatchObject({ kind: 'comment', source: null });
    const listed = await listComments(ctx, world.memberActor, { key: task.key });
    expect(listed.items.map((item) => item.kind)).toEqual(['note', 'note', 'comment']);
  });

  it('narrows the timeline by show and counts every filter, deleted entries included', async () => {
    const task = await createTask(ctx, world.memberActor, { project: key, title: 'Filtered' });
    await updateTask(ctx, world.memberActor, { key: task.key, status: 'in_progress' });
    const note = await createComment(ctx, world.agentActor, {
      key: task.key,
      kind: 'note',
      body: 'Step one',
    });
    await createComment(ctx, world.agentActor, { key: task.key, kind: 'note', body: 'Step two' });
    const comment = await createComment(ctx, world.memberActor, { key: task.key, body: 'Looks good' });
    await deleteComment(ctx, world.memberActor, { id: comment.id });

    const counts = { all: 5, comments: 1, notes: 2, history: 2 };
    const all = await listTaskTimeline(ctx, world.memberActor, { key: task.key });
    expect(all.counts).toEqual(counts);
    expect(all.items.map((item) => item.kind)).toEqual(['activity', 'activity', 'note', 'note', 'comment']);
    expect(all.items[2]).toMatchObject({ id: note.id, kind: 'note', body: 'Step one' });

    for (const [show, kinds] of [
      ['comments', ['comment']],
      ['notes', ['note', 'note']],
      ['history', ['activity', 'activity']],
      ['all', ['activity', 'activity', 'note', 'note', 'comment']],
    ] as const) {
      const timeline = await listTaskTimeline(ctx, world.memberActor, { key: task.key, show });
      expect(
        timeline.items.map((item) => item.kind),
        show,
      ).toEqual(kinds);
      expect(timeline.counts).toEqual(counts);
    }
  });

  it('refuses notes on mirrored tasks with a Backlog.md hint; comments still work there', async () => {
    const key = `${mirror.key}-786`;
    const error = await createComment(ctx, world.agentActor, {
      key,
      kind: 'note',
      body: 'Retries added',
    }).then(
      () => null,
      (caught: unknown) => caught,
    );
    expect(error).toBeInstanceOf(TaskMirrored);
    expect((error as TaskMirrored).extensions).toMatchObject({
      field: 'notes',
      backlogId: 'BACK-786',
      hint: 'backlog task edit 786 --append-notes "Retries added"',
    });
    await expect(createComment(ctx, world.agentActor, { key, body: 'A question' })).resolves.toMatchObject({
      kind: 'comment',
    });
  });
});
