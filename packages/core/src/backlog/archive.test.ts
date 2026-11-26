// M7: Backlog.md's archive folder on Postgres. A refresh archives a task whose file moves to
// archive/tasks/ (or the legacy completed/) and restores it when the file moves back; status changes
// keep closed_at right. The export writes archived tasks to archive/tasks/, and an import of that
// folder brings them back archived.
import type { BacklogMappings } from '@zamu/contracts';
import { schema } from '@zamu/db';
import { eq } from 'drizzle-orm';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import {
  createTaskRow,
  createWorld,
  randomProjectKey,
  type TestContext,
  testContext,
  type World,
} from '../testing/fixtures';
import { exportBacklog } from './export';
import { refreshBacklogSource } from './refresh';
import { previewBacklog, startBacklog } from './setup';
import {
  configFile,
  createLinkedProject,
  createMirror,
  FakeProvider,
  FakeRepository,
  mirrorContext,
  projectActivity,
  taskFile,
  taskPath,
  tasksByKey,
} from './testing';

const FOLDER = 'backlog';
const STATUSES = ['Backlog', 'To Do', 'In Progress', 'In Review', 'Done', 'Canceled'];

const status = (from: string, to: BacklogMappings['status'][number]['to']) => ({
  from,
  to,
  how: 'name' as const,
});
const MAPPINGS: BacklogMappings = {
  status: [
    status('Backlog', 'backlog'),
    status('To Do', 'todo'),
    status('In Progress', 'in_progress'),
    status('In Review', 'in_review'),
    status('Done', 'done'),
    status('Canceled', 'canceled'),
  ],
  priority: [],
  assignee: [],
};

const T0 = new Date('2031-05-01T08:00:00.000Z');
const T1 = new Date('2031-05-02T08:00:00.000Z');
const T2 = new Date('2031-05-03T08:00:00.000Z');
const T3 = new Date('2031-05-04T08:00:00.000Z');

describe('Backlog.md archive folder', () => {
  let base: TestContext;
  let world: World;
  let provider: FakeProvider;
  let ctx: ReturnType<typeof mirrorContext>;
  let clock = T0;

  beforeAll(async () => {
    base = testContext();
    world = await createWorld(base.db);
    provider = new FakeProvider([]);
    ctx = { ...mirrorContext(base, provider), now: () => clock };
  });
  afterAll(async () => {
    await base?.close();
  });

  /** Config, two open tasks and a Done one. */
  function repository(extra: Record<string, string> = {}) {
    return provider.add(
      new FakeRepository(`northwind/archive-${crypto.randomUUID().slice(0, 8)}`, {
        [`${FOLDER}/config.yml`]: configFile({ statuses: STATUSES }),
        [taskPath(FOLDER, 'back-1', 'Ledger')]: taskFile({ id: 'BACK-1', title: 'Ledger', status: 'To Do' }),
        [taskPath(FOLDER, 'back-2', 'Refunds')]: taskFile({
          id: 'BACK-2',
          title: 'Refunds',
          status: 'In Progress',
        }),
        [taskPath(FOLDER, 'back-3', 'Payouts')]: taskFile({ id: 'BACK-3', title: 'Payouts', status: 'Done' }),
        ...extra,
      }),
    );
  }

  async function taskRow(projectId: string, key: string, number: number) {
    return (await tasksByKey(ctx.db, projectId, key)).get(
      `${key}-${number}`,
    ) as typeof schema.task.$inferSelect;
  }

  async function activityOf(projectId: string, taskId: string) {
    return (await projectActivity(ctx.db, projectId)).filter((row) => row.taskId === taskId);
  }

  it('moving a file into archive/tasks/ archives the task, and moving it back restores it', async () => {
    clock = T0;
    const repo = repository();
    const { project, key, sourceId } = await createMirror(ctx, world, repo, { mappings: MAPPINGS });
    const ledger = await taskRow(project.id, key, 1);
    expect(ledger).toMatchObject({ archivedAt: null, archivedById: null, closedAt: null });

    clock = T1;
    repo.rename(taskPath(FOLDER, 'back-1', 'Ledger'), taskPath(FOLDER, 'back-1', 'Ledger', 'archive/tasks'));
    const archivedCommit = repo.commit();
    const archived = await refreshBacklogSource(ctx, sourceId, 'webhook');
    expect(archived.result).toMatchObject({ updated: 1, archived: 1, unarchived: 0, created: 0, hidden: 0 });
    expect(await taskRow(project.id, key, 1)).toMatchObject({
      id: ledger.id,
      archivedAt: T1,
      archivedById: null,
      hiddenAt: null,
      status: 'todo',
    });
    // One task.archived row from the Backlog.md actor; the block's kind is not listed as a change.
    expect(await activityOf(project.id, ledger.id)).toEqual([
      expect.objectContaining({
        type: 'task.archived',
        actorId: null,
        origin: 'backlog',
        originRef: archivedCommit,
        changes: [],
      }),
    ]);

    // Re-reads change nothing: the same commit, then a new commit with the same files.
    clock = T2;
    const again = await refreshBacklogSource(ctx, sourceId, 'manual');
    expect(again.result).toMatchObject({ updated: 0, archived: 0, unarchived: 0 });
    repo.set('README.md', '# Payments');
    repo.commit();
    const unrelated = await refreshBacklogSource(ctx, sourceId, 'webhook');
    expect(unrelated.result).toMatchObject({ updated: 0, archived: 0, unarchived: 0 });
    expect(await taskRow(project.id, key, 1)).toMatchObject({ archivedAt: T1 });
    expect(await activityOf(project.id, ledger.id)).toHaveLength(1);

    // Back to tasks/: unarchived, by the Backlog.md actor.
    clock = T3;
    repo.rename(taskPath(FOLDER, 'back-1', 'Ledger', 'archive/tasks'), taskPath(FOLDER, 'back-1', 'Ledger'));
    const restoredCommit = repo.commit();
    const restored = await refreshBacklogSource(ctx, sourceId, 'webhook');
    expect(restored.result).toMatchObject({ updated: 1, archived: 0, unarchived: 1 });
    expect(await taskRow(project.id, key, 1)).toMatchObject({ archivedAt: null, archivedById: null });
    expect((await activityOf(project.id, ledger.id)).map((row) => [row.type, row.originRef])).toEqual([
      ['task.archived', archivedCommit],
      ['task.unarchived', restoredCommit],
    ]);
  });

  it('an archived task keeps its first archived_at through edits and a move to completed/', async () => {
    clock = T0;
    const repo = repository();
    const { project, key, sourceId } = await createMirror(ctx, world, repo, { mappings: MAPPINGS });
    clock = T1;
    repo.rename(
      taskPath(FOLDER, 'back-3', 'Payouts'),
      taskPath(FOLDER, 'back-3', 'Payouts', 'archive/tasks'),
    );
    repo.commit();
    await refreshBacklogSource(ctx, sourceId, 'webhook');
    const payouts = await taskRow(project.id, key, 3);
    expect(payouts.archivedAt).toEqual(T1);

    clock = T2;
    repo.set(
      taskPath(FOLDER, 'back-3', 'Payouts', 'archive/tasks'),
      taskFile({ id: 'BACK-3', title: 'Payouts v2', status: 'Done' }),
    );
    repo.commit();
    const edited = await refreshBacklogSource(ctx, sourceId, 'webhook');
    expect(edited.result).toMatchObject({ updated: 1, archived: 0, unarchived: 0 });

    clock = T3;
    repo.rename(
      taskPath(FOLDER, 'back-3', 'Payouts', 'archive/tasks'),
      `${FOLDER}/completed/back-3 - Payouts.md`,
    );
    repo.commit();
    const moved = await refreshBacklogSource(ctx, sourceId, 'webhook');
    expect(moved.result).toMatchObject({ archived: 0, unarchived: 0 });
    expect(await taskRow(project.id, key, 3)).toMatchObject({ title: 'Payouts v2', archivedAt: T1 });
    expect((await activityOf(project.id, payouts.id)).map((row) => row.type)).toEqual([
      'task.archived',
      'task.updated',
    ]);
  });

  it('the first read archives files in archive/tasks/ and completed/; the preview counts them as before', async () => {
    clock = T0;
    const repo = repository({
      [taskPath(FOLDER, 'back-4', 'Old', 'archive/tasks')]: taskFile({
        id: 'BACK-4',
        title: 'Old',
        status: 'Done',
      }),
      [`${FOLDER}/completed/back-5 - Older.md`]: taskFile({ id: 'BACK-5', title: 'Older', status: 'Done' }),
    });
    const linked = await createLinkedProject(ctx, world, repo);
    const preview = await previewBacklog(ctx, world.ownerActor, {
      projectKey: linked.key,
      connectionId: linked.connection.id,
      mappings: MAPPINGS,
    });
    expect(preview.counts).toMatchObject({ tasks: 3, open: 2, archived: 2, completed: 1 });

    const started = await startBacklog(ctx, world.ownerActor, {
      projectKey: linked.key,
      connectionId: linked.connection.id,
      mode: 'mirror',
      mappings: MAPPINGS,
    });
    const first = await refreshBacklogSource(ctx, started.id, 'setup');
    expect(first.result).toMatchObject({ created: 5, archived: 2 });
    const { project, key } = linked;
    const tasks = await tasksByKey(ctx.db, project.id, key);
    const state = (number: number) => {
      const row = tasks.get(`${key}-${number}`);
      return { archivedAt: row?.archivedAt ?? null, closedAt: row?.closedAt ?? null };
    };
    expect(state(1)).toEqual({ archivedAt: null, closedAt: null });
    expect(state(3)).toEqual({ archivedAt: null, closedAt: T0 });
    expect(state(4)).toEqual({ archivedAt: T0, closedAt: T0 });
    expect(state(5)).toEqual({ archivedAt: T0, closedAt: T0 });
    // The first read writes one project row, no per-task history.
    expect((await projectActivity(ctx.db, project.id)).map((row) => row.type)).toEqual([
      'project.backlog_imported',
    ]);
  });

  it('a new file in the archive folder creates an archived task', async () => {
    clock = T0;
    const repo = repository();
    const { project, key, sourceId } = await createMirror(ctx, world, repo, { mappings: MAPPINGS });
    clock = T1;
    repo.set(
      `${FOLDER}/completed/back-9 - Late.md`,
      taskFile({ id: 'BACK-9', title: 'Late', status: 'Done' }),
    );
    repo.commit();
    const outcome = await refreshBacklogSource(ctx, sourceId, 'webhook');
    expect(outcome.result).toMatchObject({ created: 1, archived: 1 });
    const late = await taskRow(project.id, key, 9);
    expect(late).toMatchObject({ archivedAt: T1, closedAt: T1, status: 'done' });
    expect((await activityOf(project.id, late.id)).map((row) => row.type)).toEqual([
      'task.created',
      'task.archived',
    ]);
  });

  it('status changes keep closed_at right and closing clears the check-again day', async () => {
    clock = T0;
    const repo = repository();
    const { project, key, sourceId } = await createMirror(ctx, world, repo, { mappings: MAPPINGS });
    const refunds = await taskRow(project.id, key, 2);
    await ctx.db
      .update(schema.task)
      .set({ checkAgainOn: '2031-05-10', checkAgainReason: 'Waiting on the bank' })
      .where(eq(schema.task.id, refunds.id));

    const write = (status: string) => {
      repo.set(taskPath(FOLDER, 'back-2', 'Refunds'), taskFile({ id: 'BACK-2', title: 'Refunds', status }));
      repo.commit();
      return refreshBacklogSource(ctx, sourceId, 'webhook');
    };
    clock = T1;
    await write('Done');
    expect(await taskRow(project.id, key, 2)).toMatchObject({
      status: 'done',
      closedAt: T1,
      checkAgainOn: null,
      checkAgainReason: null,
    });
    const [closed] = (await activityOf(project.id, refunds.id)).slice(-1);
    expect(closed).toMatchObject({ type: 'task.updated', origin: 'backlog' });
    expect(closed?.changes).toEqual([
      { field: 'status', from: 'in_progress', to: 'done' },
      { field: 'checkAgain', from: { on: '2031-05-10', reason: 'Waiting on the bank' }, to: null },
    ]);

    // Done to Canceled stays closed since T1; reopening clears it; closing again starts over.
    clock = T2;
    await write('Canceled');
    expect(await taskRow(project.id, key, 2)).toMatchObject({ status: 'canceled', closedAt: T1 });
    await write('In Review');
    expect(await taskRow(project.id, key, 2)).toMatchObject({ status: 'in_review', closedAt: null });
    clock = T3;
    await write('Done');
    expect(await taskRow(project.id, key, 2)).toMatchObject({ status: 'done', closedAt: T3 });
  });

  it('a closed task taken out of the archive gets closed_at now, as a restore by hand does', async () => {
    clock = T0;
    const repo = repository({
      [taskPath(FOLDER, 'back-4', 'Old', 'archive/tasks')]: taskFile({
        id: 'BACK-4',
        title: 'Old',
        status: 'Done',
      }),
    });
    const { project, key, sourceId } = await createMirror(ctx, world, repo, { mappings: MAPPINGS });
    expect(await taskRow(project.id, key, 4)).toMatchObject({ archivedAt: T0, closedAt: T0 });
    clock = T2;
    repo.rename(taskPath(FOLDER, 'back-4', 'Old', 'archive/tasks'), taskPath(FOLDER, 'back-4', 'Old'));
    repo.commit();
    await refreshBacklogSource(ctx, sourceId, 'webhook');
    expect(await taskRow(project.id, key, 4)).toMatchObject({ archivedAt: null, closedAt: T2 });
  });

  it('a deleted file hides the task; it comes back archived from archive/tasks/', async () => {
    clock = T0;
    const repo = repository();
    const { project, key, sourceId } = await createMirror(ctx, world, repo, { mappings: MAPPINGS });
    const ledger = await taskRow(project.id, key, 1);
    const path = taskPath(FOLDER, 'back-1', 'Ledger');
    const text = repo.get(path) as string;
    repo.remove(path);
    repo.commit();
    await refreshBacklogSource(ctx, sourceId, 'webhook');
    expect((await taskRow(project.id, key, 1)).hiddenAt).not.toBeNull();
    clock = T1;
    repo.set(taskPath(FOLDER, 'back-1', 'Ledger', 'archive/tasks'), text);
    repo.commit();
    const back = await refreshBacklogSource(ctx, sourceId, 'webhook');
    expect(back.result).toMatchObject({ restored: 1, archived: 1 });
    expect(await taskRow(project.id, key, 1)).toMatchObject({
      id: ledger.id,
      hiddenAt: null,
      archivedAt: T1,
    });
    expect((await activityOf(project.id, ledger.id)).map((row) => row.type)).toEqual([
      'task.hidden',
      'task.restored',
      'task.archived',
    ]);
  });

  it('an import brings archive-folder tasks in archived, and the project is Zamu-owned afterwards', async () => {
    clock = T0;
    const repo = repository({
      [taskPath(FOLDER, 'back-4', 'Old', 'archive/tasks')]: taskFile({
        id: 'BACK-4',
        title: 'Old',
        status: 'Done',
      }),
    });
    const { project, key, first } = await createMirror(ctx, world, repo, {
      mode: 'import',
      mappings: MAPPINGS,
    });
    expect(first?.result).toMatchObject({ created: 4, archived: 1, detached: true });
    const tasks = await tasksByKey(ctx.db, project.id, key);
    expect(tasks.get(`${key}-4`)).toMatchObject({ archivedAt: T0, archivedById: null, closedAt: T0 });
    expect(tasks.get(`${key}-1`)).toMatchObject({ archivedAt: null });
  });

  describe('export', () => {
    /** A native project with an open task, a Done one, an archived Done one and an archived open one. */
    async function seed() {
      const key = randomProjectKey();
      const [project] = await base.db
        .insert(schema.project)
        .values({ workspaceId: world.workspaceId, key, name: `Payments ${key}` })
        .returning();
      if (!project) throw new Error('project insert failed');
      const by = { createdById: world.owner.id };
      const open = await createTaskRow(base.db, project.id, { ...by, title: 'Open', status: 'todo' });
      const done = await createTaskRow(base.db, project.id, {
        ...by,
        title: 'Shipped',
        status: 'done',
        closedAt: T0,
      });
      const archivedDone = await createTaskRow(base.db, project.id, {
        ...by,
        title: 'Old release',
        status: 'done',
        closedAt: T0,
        archivedAt: T1,
        archivedById: world.owner.id,
      });
      const archivedOpen = await createTaskRow(base.db, project.id, {
        ...by,
        title: 'Shelved idea',
        status: 'backlog',
        archivedAt: T1,
      });
      const prefix = key.replace(/[^A-Z]/g, '').toLowerCase();
      return { project, key, prefix, open, done, archivedDone, archivedOpen };
    }

    /** What `zamu backlog export` leaves in a folder: writes every file, prunes the rest of the owned folders. */
    function applyExport(folder: Map<string, string>, exported: Awaited<ReturnType<typeof exportBacklog>>) {
      const kept = new Set(exported.files.map((file) => file.path));
      for (const path of [...folder.keys()]) {
        if (exported.removedPrefixes.some((prefix) => path.startsWith(prefix)) && !kept.has(path)) {
          folder.delete(path);
        }
      }
      for (const file of exported.files) folder.set(file.path, file.content);
      return folder;
    }

    it('writes archived tasks to archive/tasks/ and moves restored ones back without a stale copy', async () => {
      const seeded = await seed();
      const file = (row: { number: number }, slug: string) => `${seeded.prefix}-${row.number} - ${slug}.md`;
      const first = await exportBacklog(ctx, world.memberActor, { project: seeded.key });
      expect(first.files.map((entry) => entry.path)).toEqual([
        `archive/tasks/${file(seeded.archivedDone, 'Old-release')}`,
        `archive/tasks/${file(seeded.archivedOpen, 'Shelved-idea')}`,
        `tasks/${file(seeded.open, 'Open')}`,
        `tasks/${file(seeded.done, 'Shipped')}`,
      ]);
      const folder = applyExport(new Map(), first);

      // Restore one, archive another, export again.
      await base.db
        .update(schema.task)
        .set({ archivedAt: null, archivedById: null })
        .where(eq(schema.task.id, seeded.archivedOpen.id));
      await base.db.update(schema.task).set({ archivedAt: T2 }).where(eq(schema.task.id, seeded.done.id));
      applyExport(folder, await exportBacklog(ctx, world.memberActor, { project: seeded.key }));
      expect([...folder.keys()].sort()).toEqual(
        [
          `archive/tasks/${file(seeded.archivedDone, 'Old-release')}`,
          `archive/tasks/${file(seeded.done, 'Shipped')}`,
          `tasks/${file(seeded.open, 'Open')}`,
          `tasks/${file(seeded.archivedOpen, 'Shelved-idea')}`,
        ].sort(),
      );
    });

    it('a round trip keeps archived tasks archived: export, then import the folder into a new project', async () => {
      const seeded = await seed();
      const exported = await exportBacklog(ctx, world.ownerActor, { project: seeded.key });
      const repo = provider.add(
        new FakeRepository(`northwind/round-trip-${crypto.randomUUID().slice(0, 8)}`, {
          [`${FOLDER}/config.yml`]: configFile({ prefix: seeded.prefix, statuses: STATUSES }),
          ...Object.fromEntries(exported.files.map((entry) => [`${FOLDER}/${entry.path}`, entry.content])),
        }),
      );
      clock = T3;
      const imported = await createMirror(ctx, world, repo, { mode: 'import', mappings: MAPPINGS });
      expect(imported.first?.result).toMatchObject({ created: 4, archived: 2, detached: true });
      const rows = await base.db
        .select()
        .from(schema.task)
        .where(eq(schema.task.projectId, imported.project.id));
      const byNumber = new Map(rows.map((row) => [row.number, row]));
      const state = (row: { number: number }) => {
        const match = byNumber.get(row.number);
        return {
          status: match?.status,
          archived: match?.archivedAt !== null,
          archivedById: match?.archivedById,
          closedAt: match?.closedAt ?? null,
        };
      };
      expect(state(seeded.open)).toEqual({
        status: 'todo',
        archived: false,
        archivedById: null,
        closedAt: null,
      });
      expect(state(seeded.done)).toEqual({
        status: 'done',
        archived: false,
        archivedById: null,
        closedAt: T3,
      });
      expect(state(seeded.archivedDone)).toEqual({
        status: 'done',
        archived: true,
        archivedById: null,
        closedAt: T3,
      });
      expect(state(seeded.archivedOpen)).toEqual({
        status: 'backlog',
        archived: true,
        archivedById: null,
        closedAt: null,
      });

      // The imported project exports the same folders again.
      const again = await exportBacklog(ctx, world.ownerActor, { project: imported.key });
      expect(again.files.map((entry) => entry.path)).toEqual(exported.files.map((entry) => entry.path));
    });
  });
});
