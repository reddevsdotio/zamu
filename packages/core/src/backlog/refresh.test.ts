// Refresh engine on Postgres with a fake provider serving in-memory repositories and the
// parser's fixture folders.
import { BacklogBlock, formatTaskKey } from '@zamu/contracts';
import { schema } from '@zamu/db';
import { GitUnauthorized } from '@zamu/git-providers';
import { and, eq, isNull } from 'drizzle-orm';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { runJob } from '../job-handlers';
import { BACKLOG_REFRESH } from '../jobs';
import { REPOSITORY_CLEARED_ERROR } from '../projects';
import {
  createCommentRow,
  createWorld,
  scopeOf,
  type TestContext,
  testContext,
  type World,
} from '../testing/fixtures';
import { createWave, putTasksInWave } from '../waves';
import { holdSourceLock, loadSource, pollBacklogSources, refreshBacklogSource } from './refresh';
import { previewBacklog } from './setup';
import {
  configFile,
  createMirror,
  FakeProvider,
  FakeRepository,
  mirrorContext,
  projectActivity,
  type RecordingJobQueue,
  taskFile,
  taskPath,
  tasksByKey,
} from './testing';

const FOLDER = 'backlog';

/** A small repository: config, two tasks, a subtask, a draft and a milestone. */
function smallRepo(path = `reddevs/small-${crypto.randomUUID().slice(0, 8)}`): FakeRepository {
  return new FakeRepository(path, {
    'README.md': '# Payments',
    [`${FOLDER}/config.yml`]: configFile({ statuses: ['To Do', 'In Progress', 'Done', 'Blocked'] }),
    [taskPath(FOLDER, 'back-1', 'First')]: taskFile({
      id: 'BACK-1',
      title: 'First',
      status: 'In Progress',
      priority: 'high',
      milestone: 'm-1',
      assignee: ['@ana'],
      ordinal: 100,
    }),
    [taskPath(FOLDER, 'back-2', 'Second')]: taskFile({ id: 'BACK-2', title: 'Second', status: 'Blocked' }),
    [taskPath(FOLDER, 'back-2.1', 'Sub')]: taskFile({ id: 'BACK-2.1', title: 'Sub', parent: 'BACK-2' }),
    [`${FOLDER}/drafts/draft-1 - Idea.md`]: taskFile({ id: 'DRAFT-1', title: 'Idea' }),
    [`${FOLDER}/milestones/m-1 - Launch.md`]:
      '---\nid: m-1\ntitle: "Launch"\n---\n\n## Description\n\nShip it.\n',
  });
}

const MAPPINGS = {
  status: [
    { from: 'To Do', to: 'todo' as const, how: 'name' as const },
    { from: 'In Progress', to: 'in_progress' as const, how: 'name' as const },
    { from: 'Done', to: 'done' as const, how: 'name' as const },
  ],
  priority: [{ from: 'high', to: 'high' as const, how: 'name' as const }],
  assignee: [] as { from: string; userId: string | null; how: 'name' | 'fallback' | 'manual' }[],
};

describe('refreshBacklogSource', () => {
  let base: TestContext;
  let world: World;
  let provider: FakeProvider;
  let ctx: ReturnType<typeof mirrorContext>;

  beforeAll(async () => {
    base = testContext();
    world = await createWorld(base.db);
    provider = new FakeProvider([]);
    ctx = mirrorContext(base, provider);
  });
  afterAll(async () => {
    await base?.close();
  });
  beforeEach(() => {
    provider.failWith = null;
    provider.failAlways = false;
  });

  /** Registers a repository with the shared fake provider. */
  function serve(repo: FakeRepository): FakeRepository {
    return provider.add(repo);
  }

  async function mirror(repo: FakeRepository, options: Parameters<typeof createMirror>[3] = {}) {
    serve(repo);
    const mappings = {
      ...MAPPINGS,
      assignee: [{ from: '@ana', userId: world.owner.id, how: 'manual' as const }],
    };
    return createMirror(ctx, world, repo, { mappings, ...options });
  }

  it('first read creates tasks, milestones and one project activity row', async () => {
    const repo = smallRepo();
    const { project, key, sourceId, first } = await mirror(repo);
    expect(first).toMatchObject({ outcome: 'applied', state: 'warnings', commit: repo.head });
    const tasks = await tasksByKey(ctx.db, project.id, key);
    expect([...tasks.keys()].sort()).toEqual([`${key}-1`, `${key}-2`, `${key}-2.1`, `${key}-3`].sort());
    const firstTask = tasks.get(`${key}-1`);
    expect(firstTask).toMatchObject({
      title: 'First',
      status: 'in_progress',
      priority: 3,
      assigneeId: world.owner.id,
      backlogId: 'BACK-1',
      rank: 100,
      createdById: world.owner.id,
    });
    expect(firstTask?.createdAt.toISOString()).toBe('2026-10-01T10:00:00.000Z');
    expect(tasks.get(`${key}-3`)).toMatchObject({ backlogId: 'DRAFT-1', status: 'backlog' });
    expect(tasks.get(`${key}-2`)?.status).toBe('todo'); // Blocked has no mapping

    const [milestone] = await ctx.db
      .select()
      .from(schema.milestone)
      .where(eq(schema.milestone.projectId, project.id));
    expect(milestone).toMatchObject({ name: 'Launch', backlogId: 'm-1', status: 'active' });
    expect(firstTask?.milestoneId).toBe(milestone?.id);

    const activity = await projectActivity(ctx.db, project.id);
    expect(activity).toHaveLength(1);
    expect(activity[0]).toMatchObject({
      type: 'project.backlog_imported',
      taskId: null,
      actorId: null,
      origin: 'backlog',
      originRef: repo.head,
    });

    const source = await loadSource(ctx.db, sourceId);
    expect(source).toMatchObject({
      state: 'warnings',
      folder: 'backlog',
      prefix: 'BACK',
      defaultBranch: 'main',
      lastReadCommit: repo.head,
      headCommit: repo.head,
      lastTrigger: 'setup',
      lastError: null,
    });
    expect(source?.warnings).toEqual([
      expect.objectContaining({ kind: 'value', field: 'status', value: 'Blocked', fallback: 'Todo' }),
    ]);
    const [projectAfter] = await ctx.db
      .select()
      .from(schema.project)
      .where(eq(schema.project.id, project.id));
    expect(projectAfter).toMatchObject({ nextTaskNumber: 4, usesMilestones: true });
    const files = await ctx.db
      .select()
      .from(schema.backlogFile)
      .where(eq(schema.backlogFile.sourceId, sourceId));
    expect(files.map((file) => file.path).sort()).toEqual(
      [...repo.files().filter((file) => file.startsWith('backlog/'))].sort(),
    );
    expect(files.every((file) => file.error === null)).toBe(true);
    expect(files.find((file) => file.backlogId === 'BACK-1')?.taskId).toBe(firstTask?.id);
  });

  it('preview equals the first refresh', async () => {
    const repo = serve(
      FakeRepository.fromFixture(
        'eras/2025-09-markers',
        `reddevs/markers-${crypto.randomUUID().slice(0, 6)}`,
      ),
    );
    const { createLinkedProject } = await import('./testing');
    const linked = await createLinkedProject(ctx, world, repo);
    const preview = await previewBacklog(ctx, world.ownerActor, {
      projectKey: linked.key,
      connectionId: linked.connection.id,
      mappings: MAPPINGS,
    });
    const { startBacklog } = await import('./setup');
    const status = await startBacklog(ctx, world.ownerActor, {
      projectKey: linked.key,
      connectionId: linked.connection.id,
      mode: 'mirror',
      mappings: MAPPINGS,
    });
    const outcome = await refreshBacklogSource(ctx, status.id, 'setup');
    expect(outcome.outcome).toBe('applied');
    const tasks = await tasksByKey(ctx.db, linked.project.id, linked.key);
    expect(preview.counts.tasks + preview.counts.drafts + preview.counts.archived).toBe(tasks.size);
    for (const row of preview.sample) {
      const task = tasks.get(row.key);
      expect(task, row.key).toBeDefined();
      expect(task).toMatchObject({ backlogId: row.backlogId, title: row.title, status: row.status });
    }
    const source = await loadSource(ctx.db, status.id);
    expect(source?.warnings).toEqual([...preview.files, ...preview.fallbacks]);
  });

  it('a second refresh of the same commit changes nothing, writes no activity and downloads nothing', async () => {
    const repo = smallRepo();
    const { project, sourceId } = await mirror(repo);
    const before = await ctx.db.select().from(schema.task).where(eq(schema.task.projectId, project.id));
    const activityBefore = await projectActivity(ctx.db, project.id);
    provider.resetCalls();
    const outcome = await refreshBacklogSource(ctx, sourceId, 'manual');
    expect(outcome).toMatchObject({ outcome: 'applied', downloads: 0 });
    expect(outcome.result).toMatchObject({ created: 0, updated: 0, hidden: 0, restored: 0 });
    expect(provider.calls.readBlob).toBe(0);
    const after = await ctx.db.select().from(schema.task).where(eq(schema.task.projectId, project.id));
    expect(after.map((row) => [row.id, row.updatedAt.getTime()]).sort()).toEqual(
      before.map((row) => [row.id, row.updatedAt.getTime()]).sort(),
    );
    expect(await projectActivity(ctx.db, project.id)).toHaveLength(activityBefore.length);
  });

  it('a poll stops when the head did not move', async () => {
    const repo = smallRepo();
    const { sourceId } = await mirror(repo);
    provider.resetCalls();
    const outcome = await refreshBacklogSource(ctx, sourceId, 'poll');
    expect(outcome).toMatchObject({ outcome: 'unchanged', downloads: 0 });
    expect(provider.calls).toMatchObject({ getRepository: 1, getBranchHead: 1, listTree: 0, readBlob: 0 });
    repo.set(taskPath(FOLDER, 'back-9', 'Ninth'), taskFile({ id: 'BACK-9', title: 'Ninth' }));
    repo.commit();
    const moved = await refreshBacklogSource(ctx, sourceId, 'poll');
    expect(moved).toMatchObject({ outcome: 'applied', downloads: 1 });
  });

  it('a rename keeps the task; changes write task.updated from the Backlog.md actor', async () => {
    const repo = smallRepo();
    const { project, key, sourceId } = await mirror(repo);
    const before = (await tasksByKey(ctx.db, project.id, key)).get(`${key}-2`);
    repo.remove(taskPath(FOLDER, 'back-2', 'Second'));
    repo.set(
      taskPath(FOLDER, 'back-2', 'Second renamed'),
      taskFile({ id: 'BACK-2', title: 'Second renamed', status: 'Done', labels: ['api'] }),
    );
    const commit = repo.commit();
    const outcome = await refreshBacklogSource(ctx, sourceId, 'webhook');
    expect(outcome.result).toMatchObject({ created: 0, updated: 1, hidden: 0 });
    const after = (await tasksByKey(ctx.db, project.id, key)).get(`${key}-2`);
    expect(after?.id).toBe(before?.id);
    expect(after).toMatchObject({ title: 'Second renamed', status: 'done' });
    expect(BacklogBlock.parse(after?.backlogData).labels).toEqual(['api']);
    const activity = await ctx.db
      .select()
      .from(schema.activity)
      .where(eq(schema.activity.taskId, before?.id as string));
    expect(activity).toEqual([
      expect.objectContaining({
        type: 'task.updated',
        actorId: null,
        origin: 'backlog',
        originRef: commit,
        changes: [
          { field: 'title', from: 'Second', to: 'Second renamed' },
          { field: 'description', from: 'About Second.', to: 'About Second renamed.' },
          { field: 'status', from: 'todo', to: 'done' },
          // M5: labels are a native field with their own change; the raw status shows through the
          // status change, so no block-only field is listed.
          { field: 'labels', from: [], to: [{ id: expect.any(String), name: 'api' }] },
        ],
      }),
    ]);
    const file = await ctx.db
      .select()
      .from(schema.backlogFile)
      .where(and(eq(schema.backlogFile.sourceId, sourceId), eq(schema.backlogFile.backlogId, 'BACK-2')));
    expect(file.map((row) => row.path)).toEqual([taskPath(FOLDER, 'back-2', 'Second renamed')]);
  });

  it('a deleted file hides its task; re-adding restores it with its comments, cycle and rank', async () => {
    const repo = smallRepo();
    const { project, key, sourceId } = await mirror(repo);
    const task = (await tasksByKey(ctx.db, project.id, key)).get(`${key}-1`);
    const comment = await createCommentRow(ctx.db, scopeOf(project), {
      taskId: task?.id as string,
      authorId: world.owner.id,
    });
    await ctx.db
      .update(schema.task)
      .set({ rank: 42 })
      .where(eq(schema.task.id, task?.id as string));
    const path = taskPath(FOLDER, 'back-1', 'First');
    const text = repo.get(path) as string;
    repo.remove(path);
    repo.commit();
    const hidden = await refreshBacklogSource(ctx, sourceId, 'webhook');
    expect(hidden.result).toMatchObject({ hidden: 1 });
    const row = (await tasksByKey(ctx.db, project.id, key)).get(`${key}-1`);
    expect(row?.hiddenAt).not.toBeNull();
    repo.set(path, text);
    repo.commit();
    const restored = await refreshBacklogSource(ctx, sourceId, 'webhook');
    expect(restored.result).toMatchObject({ restored: 1, created: 0 });
    const back = (await tasksByKey(ctx.db, project.id, key)).get(`${key}-1`);
    expect(back).toMatchObject({ id: task?.id, hiddenAt: null, rank: 42 });
    const comments = await ctx.db
      .select()
      .from(schema.comment)
      .where(eq(schema.comment.taskId, task?.id as string));
    expect(comments.map((row) => row.id)).toEqual([comment.id]);
    const types = (
      await ctx.db
        .select()
        .from(schema.activity)
        .where(eq(schema.activity.taskId, task?.id as string))
    ).map((row) => row.type);
    expect(types.sort()).toEqual(['task.hidden', 'task.restored']);
  });

  it('two files with the same id: the newest wins, the other is a problem', async () => {
    const repo = smallRepo();
    repo.set(
      taskPath(FOLDER, 'back-1', 'First copy'),
      taskFile({ id: 'BACK-1', title: 'First copy', updated: '2026-10-10 10:00' }),
    );
    repo.commit();
    const { project, key, sourceId } = await mirror(repo);
    expect((await tasksByKey(ctx.db, project.id, key)).get(`${key}-1`)?.title).toBe('First copy');
    const source = await loadSource(ctx.db, sourceId);
    expect(source?.warnings).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ kind: 'file', skipped: true, path: taskPath(FOLDER, 'back-1', 'First') }),
      ]),
    );
    const [loser] = await ctx.db
      .select()
      .from(schema.backlogFile)
      .where(
        and(
          eq(schema.backlogFile.sourceId, sourceId),
          eq(schema.backlogFile.path, taskPath(FOLDER, 'back-1', 'First')),
        ),
      );
    expect(loser?.error).toContain('Duplicate id BACK-1');
    expect(loser?.taskId).toBeNull();
  });

  it('draft numbers stay across refreshes', async () => {
    const repo = smallRepo();
    const { project, key, sourceId } = await mirror(repo);
    const draft = (await tasksByKey(ctx.db, project.id, key)).get(`${key}-3`);
    repo.set(`${FOLDER}/drafts/draft-2 - Other.md`, taskFile({ id: 'DRAFT-2', title: 'Other' }));
    repo.set(taskPath(FOLDER, 'back-7', 'Seventh'), taskFile({ id: 'BACK-7', title: 'Seventh' }));
    repo.commit();
    await refreshBacklogSource(ctx, sourceId, 'webhook');
    const tasks = await tasksByKey(ctx.db, project.id, key);
    expect(tasks.get(`${key}-3`)?.id).toBe(draft?.id);
    expect(tasks.get(`${key}-7`)?.backlogId).toBe('BACK-7');
    expect(tasks.get(`${key}-8`)?.backlogId).toBe('DRAFT-2');
  });

  it('edited mappings are reapplied on the next refresh', async () => {
    const repo = smallRepo();
    const { project, key, sourceId } = await mirror(repo);
    const { updateBacklogMappings } = await import('./settings');
    await updateBacklogMappings(ctx, world.ownerActor, {
      projectKey: key,
      mappings: {
        ...MAPPINGS,
        status: [...MAPPINGS.status, { from: 'Blocked', to: 'in_review', how: 'manual' }],
        assignee: [{ from: '@ana', userId: world.owner.id, how: 'manual' }],
      },
    });
    expect((ctx.jobs as RecordingJobQueue).sent.at(-1)).toMatchObject({
      name: BACKLOG_REFRESH,
      data: { sourceId, trigger: 'manual' },
    });
    const outcome = await refreshBacklogSource(ctx, sourceId, 'manual');
    expect(outcome).toMatchObject({ state: 'healthy', downloads: 0 });
    expect((await tasksByKey(ctx.db, project.id, key)).get(`${key}-2`)?.status).toBe('in_review');
    expect((await loadSource(ctx.db, sourceId))?.warnings).toEqual([]);
  });

  it('a config that does not parse fails the refresh and keeps the last good state', async () => {
    const repo = smallRepo();
    const { project, key, sourceId } = await mirror(repo);
    repo.set(`${FOLDER}/config.yml`, 'statuses: [unclosed\n');
    repo.set(taskPath(FOLDER, 'back-1', 'First'), taskFile({ id: 'BACK-1', title: 'Changed' }));
    repo.commit();
    const outcome = await refreshBacklogSource(ctx, sourceId, 'webhook');
    expect(outcome.outcome).toBe('failed');
    expect(outcome.error).toContain('config');
    expect((await tasksByKey(ctx.db, project.id, key)).get(`${key}-1`)?.title).toBe('First');
    const source = await loadSource(ctx.db, sourceId);
    expect(source).toMatchObject({ state: 'failed', lastReadCommit: expect.any(String) });
    expect(source?.lastReadCommit).not.toBe(repo.head);
  });

  it('a failure mid-apply rolls the whole refresh back', async () => {
    const repo = smallRepo();
    const { project, key, sourceId } = await mirror(repo);
    const before = await ctx.db.select().from(schema.task).where(eq(schema.task.projectId, project.id));
    const filesBefore = await ctx.db
      .select()
      .from(schema.backlogFile)
      .where(eq(schema.backlogFile.sourceId, sourceId));
    repo.set(taskPath(FOLDER, 'back-1', 'First'), taskFile({ id: 'BACK-1', title: 'Changed' }));
    repo.set(taskPath(FOLDER, 'back-9', 'Ninth'), taskFile({ id: 'BACK-9', title: 'Ninth' }));
    repo.remove(taskPath(FOLDER, 'back-2.1', 'Sub'));
    repo.commit();
    const outcome = await refreshBacklogSource(ctx, sourceId, 'webhook', {
      beforeCommit: async () => {
        throw new Error('injected failure');
      },
    });
    expect(outcome).toMatchObject({ outcome: 'failed', state: 'failed' });
    expect(outcome.error).toContain('injected failure');
    const after = await ctx.db.select().from(schema.task).where(eq(schema.task.projectId, project.id));
    expect(after).toEqual(before);
    const filesAfter = await ctx.db
      .select()
      .from(schema.backlogFile)
      .where(eq(schema.backlogFile.sourceId, sourceId));
    expect(filesAfter.map((row) => [row.path, row.blobSha]).sort()).toEqual(
      filesBefore.map((row) => [row.path, row.blobSha]).sort(),
    );
    expect(await projectActivity(ctx.db, project.id)).toHaveLength(1);
    // The next run applies everything.
    const retry = await refreshBacklogSource(ctx, sourceId, 'manual');
    expect(retry.result).toMatchObject({ created: 1, updated: 2, hidden: 1 });
    expect((await tasksByKey(ctx.db, project.id, key)).get(`${key}-1`)?.title).toBe('Changed');
  });

  it('a second worker skips while the lock is held', async () => {
    const repo = smallRepo();
    const { sourceId } = await mirror(repo);
    const lock = await holdSourceLock(ctx.db, sourceId);
    try {
      expect(await refreshBacklogSource(ctx, sourceId, 'webhook')).toEqual({
        outcome: 'locked',
        state: null,
      });
    } finally {
      await lock.release();
    }
    expect((await refreshBacklogSource(ctx, sourceId, 'webhook')).outcome).toBe('applied');
  });

  it('a rejected token pauses the mirror and the connection; a working read resumes them', async () => {
    const repo = smallRepo();
    const { sourceId, connection } = await mirror(repo);
    provider.failWith = new GitUnauthorized('token rejected', { status: 401 });
    const paused = await refreshBacklogSource(ctx, sourceId, 'webhook');
    expect(paused).toMatchObject({ outcome: 'paused', state: 'paused' });
    expect(paused.error).not.toContain('glpat');
    const [conn] = await ctx.db
      .select()
      .from(schema.gitConnection)
      .where(eq(schema.gitConnection.id, connection.id));
    expect(conn?.status).toBe('rejected');
    expect((await loadSource(ctx.db, sourceId))?.state).toBe('paused');
    const polled = await refreshBacklogSource(ctx, sourceId, 'poll');
    expect(polled).toMatchObject({ outcome: 'unchanged', state: 'warnings' });
    const [connAfter] = await ctx.db
      .select()
      .from(schema.gitConnection)
      .where(eq(schema.gitConnection.id, connection.id));
    expect(connAfter?.status).toBe('working');
    expect(await loadSource(ctx.db, sourceId)).toMatchObject({ state: 'warnings', lastError: null });
  });

  it('a cleared repository pauses; a repository again resumes on the next run', async () => {
    const repo = smallRepo();
    const { project, sourceId } = await mirror(repo);
    const { repository, repositoryKey } = project;
    await ctx.db
      .update(schema.project)
      .set({ repository: null, repositoryKey: null })
      .where(eq(schema.project.id, project.id));
    const paused = await refreshBacklogSource(ctx, sourceId, 'poll');
    expect(paused).toMatchObject({ outcome: 'paused', error: REPOSITORY_CLEARED_ERROR });
    await ctx.db
      .update(schema.project)
      .set({ repository, repositoryKey })
      .where(eq(schema.project.id, project.id));
    const resumed = await refreshBacklogSource(ctx, sourceId, 'poll');
    expect(resumed.state).toBe('warnings');
    expect((await loadSource(ctx.db, sourceId))?.lastError).toBeNull();
  });

  it('import mode detaches right after the first read', async () => {
    const repo = smallRepo();
    const { project, sourceId, first } = await mirror(repo, { mode: 'import' });
    expect(first).toMatchObject({ outcome: 'applied', state: 'detached' });
    const source = await loadSource(ctx.db, sourceId);
    expect(source).toMatchObject({
      state: 'detached',
      webhookSecretCiphertext: null,
      detachedById: world.owner.id,
    });
    expect(source?.detachedAt).not.toBeNull();
    const activity = await projectActivity(ctx.db, project.id);
    expect(activity.map((row) => row.type)).toEqual(['project.backlog_imported']);
    expect(activity[0]?.changes).toEqual(
      expect.arrayContaining([{ field: 'mode', from: null, to: 'import' }]),
    );
    expect((await refreshBacklogSource(ctx, sourceId, 'manual')).outcome).toBe('skipped');
  });

  it('runs through the job handler and the poll enqueues every mirror that is not detached', async () => {
    const repo = smallRepo();
    const { sourceId } = await mirror(repo, { refresh: false });
    const outcome = await runJob(ctx, BACKLOG_REFRESH, { sourceId, trigger: 'setup' });
    expect(outcome).toMatchObject({ outcome: 'applied' });
    const jobs = ctx.jobs as RecordingJobQueue;
    jobs.clear();
    const polled = await pollBacklogSources(ctx);
    expect(polled.enqueued).toBeGreaterThan(0);
    const polledIds = jobs.sent.map((job) => (job.data as { sourceId: string }).sourceId);
    expect(polledIds).toContain(sourceId);
    const detached = await ctx.db
      .select({ id: schema.backlogSource.id })
      .from(schema.backlogSource)
      .where(eq(schema.backlogSource.state, 'detached'));
    for (const row of detached) expect(polledIds).not.toContain(row.id);
    expect(jobs.sent.every((job) => (job.data as { trigger: string }).trigger === 'poll')).toBe(true);
  });

  it('refreshes 1,000 task files with 10 changed by downloading 10 blobs in under 5 seconds', async () => {
    const files: Record<string, string> = { [`${FOLDER}/config.yml`]: configFile() };
    for (let n = 1; n <= 1000; n++) {
      files[taskPath(FOLDER, `back-${n}`, `Task ${n}`)] = taskFile({
        id: `BACK-${n}`,
        title: `Task ${n}`,
        status: n % 3 === 0 ? 'Done' : 'To Do',
        labels: ['bulk'],
      });
    }
    const repo = new FakeRepository(`reddevs/bulk-${crypto.randomUUID().slice(0, 6)}`, files);
    const { project, key, sourceId, first } = await mirror(repo);
    expect(first?.result?.created).toBe(1000);
    for (let n = 1; n <= 10; n++) {
      repo.set(
        taskPath(FOLDER, `back-${n * 7}`, `Task ${n * 7}`),
        taskFile({ id: `BACK-${n * 7}`, title: `Task ${n * 7} changed`, status: 'Done' }),
      );
    }
    repo.commit();
    provider.resetCalls();
    const started = performance.now();
    const outcome = await refreshBacklogSource(ctx, sourceId, 'webhook');
    const elapsed = performance.now() - started;
    console.info(
      `refresh of 1,000 files with 10 changed: ${Math.round(elapsed)} ms, ${provider.calls.readBlob} blobs`,
    );
    expect(outcome.result).toMatchObject({ updated: 10, created: 0, hidden: 0 });
    expect(provider.calls.readBlob).toBe(10);
    expect(elapsed).toBeLessThan(5000);
    const changed = (await tasksByKey(ctx.db, project.id, key)).get(formatTaskKey(key, 70, null));
    expect(changed?.title).toBe('Task 70 changed');
    const visible = await ctx.db
      .select({ id: schema.task.id })
      .from(schema.task)
      .where(and(eq(schema.task.projectId, project.id), isNull(schema.task.hiddenAt)));
    expect(visible).toHaveLength(1000);
  }, 60_000);

  it("mirrors Backlog.md's own backlog folder and refreshes it again without changes", async () => {
    const repo = FakeRepository.fromFixture(
      'snapshot',
      `mrlesk/backlog-md-${crypto.randomUUID().slice(0, 6)}`,
    );
    const { project, sourceId, first } = await mirror(repo);
    expect(first?.outcome).toBe('applied');
    expect(first?.result?.created).toBeGreaterThan(700);
    const source = await loadSource(ctx.db, sourceId);
    expect(source?.state).toMatch(/healthy|warnings/);
    const again = await refreshBacklogSource(ctx, sourceId, 'manual');
    expect(again.result).toMatchObject({ created: 0, updated: 0, hidden: 0, restored: 0 });
    // Only files that were skipped are downloaded again.
    const skipped = await ctx.db
      .select({ path: schema.backlogFile.path, error: schema.backlogFile.error })
      .from(schema.backlogFile)
      .where(eq(schema.backlogFile.sourceId, sourceId));
    expect(again.downloads).toBe(skipped.filter((row) => row.error !== null).length);
    const activity = await projectActivity(ctx.db, project.id);
    expect(activity).toHaveLength(1);
  }, 60_000);

  it('M8: a milestone change in the files takes the task out of its wave; locked waves refuse nothing', async () => {
    const repo = smallRepo();
    repo.set(
      `${FOLDER}/milestones/m-2 - Later.md`,
      '---\nid: m-2\ntitle: "Later"\n---\n\n## Description\n\nAfter launch.\n',
    );
    repo.commit();
    const { project, key, sourceId } = await mirror(repo);
    const launch = (
      await ctx.db
        .select()
        .from(schema.milestone)
        .where(and(eq(schema.milestone.projectId, project.id), eq(schema.milestone.backlogId, 'm-1')))
    )[0];
    if (!launch) throw new Error('milestone m-1 missing');
    const w1 = await createWave(ctx, world.ownerActor, { milestone: launch.id, name: 'Build' });
    const w2 = await createWave(ctx, world.ownerActor, { milestone: launch.id, name: 'Ship' });
    // BACK-2 joins m-1 in the files first, then both tasks sit in waves of m-1.
    repo.set(
      taskPath(FOLDER, 'back-2', 'Second'),
      taskFile({ id: 'BACK-2', title: 'Second', milestone: 'm-1' }),
    );
    repo.commit();
    await refreshBacklogSource(ctx, sourceId, 'manual');
    await putTasksInWave(ctx, world.ownerActor, { milestone: launch.id, wave: w1.id, keys: [`${key}-1`] });
    await putTasksInWave(ctx, world.ownerActor, { milestone: launch.id, wave: w2.id, keys: [`${key}-2`] });

    // The files move BACK-1 to m-2 and start BACK-2, whose wave is locked: both apply.
    repo.set(
      taskPath(FOLDER, 'back-1', 'First'),
      taskFile({
        id: 'BACK-1',
        title: 'First',
        status: 'In Progress',
        priority: 'high',
        milestone: 'm-2',
        assignee: ['@ana'],
        ordinal: 100,
      }),
    );
    repo.set(
      taskPath(FOLDER, 'back-2', 'Second'),
      taskFile({ id: 'BACK-2', title: 'Second', milestone: 'm-1', status: 'In Progress' }),
    );
    repo.commit();
    const outcome = await refreshBacklogSource(ctx, sourceId, 'manual');
    expect(outcome.outcome).toBe('applied');
    const tasks = await tasksByKey(ctx.db, project.id, key);
    const first = tasks.get(`${key}-1`);
    expect(first?.waveId).toBeNull();
    expect(first?.milestoneId).not.toBe(launch.id);
    expect(tasks.get(`${key}-2`)).toMatchObject({ status: 'in_progress', waveId: w2.id });
    const rows = await ctx.db
      .select()
      .from(schema.activity)
      .where(eq(schema.activity.taskId, first?.id as string));
    const last = rows
      .sort((a, b) => a.createdAt.getTime() - b.createdAt.getTime() || (a.id < b.id ? -1 : 1))
      .at(-1);
    expect(last).toMatchObject({ actorId: null, origin: 'backlog', type: 'task.updated' });
    expect(last?.changes).toContainEqual({
      field: 'wave',
      from: { id: w1.id, number: 1, name: 'Build' },
      to: null,
    });
  });
});
