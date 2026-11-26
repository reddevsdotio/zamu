// Archive (M7): archiving and restoring tasks by hand, the nightly job that archives Done and
// Canceled tasks a set number of days after they closed, and the preview of that setting. An
// archived task leaves lists, boards, Home and counts and is read-only: every write but restore is
// refused with 409 TASK_ARCHIVED (assertTaskWritable), so the archive never hides a change.
// Mirrored projects follow Backlog.md's archive folder instead: people can't archive or restore
// their tasks here, and the nightly job skips them.
import {
  ArchivePreview,
  ArchivePreviewInput,
  ArchiveTasksInput,
  formatTaskKey,
  RestoreTasksInput,
  TaskBulkResult,
} from '@zamu/contracts';
import { type DbOrTx, schema, type Tx } from '@zamu/db';
import { and, asc, eq, inArray, isNotNull, isNull, type SQL, sql } from 'drizzle-orm';
import type { z } from 'zod';
import { recordActivities, type SystemActivityEntry } from './activity';
import { type Actor, authorize } from './authz';
import type { DbContext } from './context';
import {
  addCalendarDays,
  type ClockContext,
  calendarDateIn,
  clockNow,
  DEFAULT_TIME_ZONE,
  todayIn,
} from './cycles';
import { Conflict, parseInput, TaskMirrored } from './errors';
import {
  backlogFilePath,
  findProjectByKey,
  findTask,
  isMirrored,
  loadBacklogSource,
  mirroredProjectIds,
  type ProjectRow,
  type TaskRow,
} from './internal';
import { type TaskContext, toTaskListItems } from './tasks';

const { backlogSource, project, task, taskItem } = schema;

// ---------------------------------------------------------------------------
// The read-only rule
// ---------------------------------------------------------------------------

/**
 * A write to an archived task (409 TASK_ARCHIVED): updates, bulk changes, item operations,
 * comments and notes. Restore the task first. Adapters read the code with problemCodeOf().
 */
export class TaskArchived extends Conflict {
  readonly problemCode = 'TASK_ARCHIVED' as const;
}

/** TaskArchived for the task with `key`. */
export function taskArchived(key: string): TaskArchived {
  return new TaskArchived(`${key} is archived, so it can't change. Restore it first.`);
}

/**
 * Throws TaskArchived when the task is archived. Every write path calls it before changing
 * anything: tasks.ts (updates, bulk changes, item operations) and comments and notes.
 */
export function assertTaskWritable(
  projectRow: Pick<ProjectRow, 'key'>,
  row: Pick<TaskRow, 'number' | 'keySuffix' | 'archivedAt'>,
): void {
  if (row.archivedAt) throw taskArchived(formatTaskKey(projectRow.key, row.number, row.keySuffix));
}

// ---------------------------------------------------------------------------
// By hand
// ---------------------------------------------------------------------------

interface Hit {
  project: ProjectRow;
  task: TaskRow;
}

/**
 * The tasks of `keys`, write-checked and locked in id order (as bulkUpdateTasks does), or
 * TaskMirrored when any of them belongs to a mirrored project.
 */
async function lockedHits(tx: Tx, actor: Actor, keys: string[], verb: 'archive' | 'restore'): Promise<Hit[]> {
  const found: Hit[] = [];
  for (const key of keys) found.push(await findTask(tx, actor, key));
  const projectIds = [...new Set(found.map((hit) => hit.project.id))].sort();
  for (const projectId of projectIds) authorize(actor, 'task.write', { type: 'project', projectId });

  const mirrored = await mirroredProjectIds(tx, projectIds);
  const mirroredHit = found.find((hit) => mirrored.has(hit.project.id));
  if (mirroredHit) {
    const source = await loadBacklogSource(tx, mirroredHit.project.id);
    const key = formatTaskKey(mirroredHit.project.key, mirroredHit.task.number, mirroredHit.task.keySuffix);
    const file = await backlogFilePath(tx, source, { taskId: mirroredHit.task.id });
    const where = verb === 'archive' ? 'under archive/tasks/' : 'back under tasks/';
    throw new TaskMirrored(
      `${key} is mirrored from Backlog.md, so its folder decides whether it is archived. Move its file ${where} and push.`,
      {
        ...(file ? { file } : {}),
        ...(mirroredHit.task.backlogId ? { backlogId: mirroredHit.task.backlogId } : {}),
      },
    );
  }

  const ids = [...new Set(found.map((hit) => hit.task.id))].sort();
  const rows = await tx.select().from(task).where(inArray(task.id, ids)).orderBy(asc(task.id)).for('update');
  const byId = new Map(rows.map((row) => [row.id, row]));
  return found.map((hit) => ({ project: hit.project, task: byId.get(hit.task.id) ?? hit.task }));
}

/** The result of archiveTasks and restoreTasks: every task as a list row, in the order sent. */
async function bulkResult(
  tx: Tx,
  ctx: TaskContext,
  hits: Hit[],
  changed: TaskRow[],
): Promise<TaskBulkResult> {
  const byId = new Map(changed.map((row) => [row.id, row]));
  const rows = hits.map((hit) => {
    const row = byId.get(hit.task.id) ?? hit.task;
    return {
      task: row,
      project: { id: hit.project.id, key: hit.project.key, name: hit.project.name },
      hasFinalSummary: row.finalSummary !== null,
    };
  });
  return TaskBulkResult.parse({
    items: await toTaskListItems(tx, rows, todayIn(ctx), { inTransaction: true }),
  });
}

/**
 * Archives up to MAX_BULK_TASKS tasks in any status, all or nothing, as the actor (people and
 * agents alike, with write access). One task.archived row per task that was not archived yet;
 * tasks archived already are returned as they are. Archiving clears no field. Tasks of a mirrored
 * project fail the request with TaskMirrored. Returns the tasks in the order sent.
 */
export async function archiveTasks(
  ctx: TaskContext,
  actor: Actor,
  input: z.input<typeof ArchiveTasksInput>,
): Promise<TaskBulkResult> {
  const { keys } = parseInput(ArchiveTasksInput, input);
  const now = clockNow(ctx);
  return ctx.db.transaction(async (tx) => {
    const hits = await lockedHits(tx, actor, keys, 'archive');
    const ids = [...new Set(hits.filter((hit) => hit.task.archivedAt === null).map((hit) => hit.task.id))];
    const changed =
      ids.length === 0
        ? []
        : await tx
            .update(task)
            .set({ archivedAt: now, archivedById: actor.userId })
            .where(and(inArray(task.id, ids), isNull(task.archivedAt)))
            .returning();
    await recordActivities(
      tx,
      actor,
      changed.map((row) => ({
        projectId: row.projectId,
        taskId: row.id,
        type: 'task.archived',
        changes: [],
      })),
    );
    return bulkResult(tx, ctx, hits, changed);
  });
}

/**
 * Restores up to MAX_BULK_TASKS archived tasks, all or nothing. A restored Done or Canceled task
 * gets closed_at = now, so the nightly job counts its days again from the start. One
 * task.unarchived row per task restored; tasks that were not archived are returned as they are.
 * Tasks of a mirrored project fail the request with TaskMirrored.
 */
export async function restoreTasks(
  ctx: TaskContext,
  actor: Actor,
  input: z.input<typeof RestoreTasksInput>,
): Promise<TaskBulkResult> {
  const { keys } = parseInput(RestoreTasksInput, input);
  const now = clockNow(ctx);
  return ctx.db.transaction(async (tx) => {
    const hits = await lockedHits(tx, actor, keys, 'restore');
    const ids = [...new Set(hits.filter((hit) => hit.task.archivedAt !== null).map((hit) => hit.task.id))];
    const changed =
      ids.length === 0
        ? []
        : await tx
            .update(task)
            .set({
              archivedAt: null,
              archivedById: null,
              closedAt: sql`case when ${task.status} in ('done', 'canceled') then ${now.toISOString()}::timestamptz else ${task.closedAt} end`,
            })
            .where(and(inArray(task.id, ids), isNotNull(task.archivedAt)))
            .returning();
    await recordActivities(
      tx,
      actor,
      changed.map((row) => ({
        projectId: row.projectId,
        taskId: row.id,
        type: 'task.unarchived',
        changes: [],
      })),
    );
    return bulkResult(tx, ctx, hits, changed);
  });
}

// ---------------------------------------------------------------------------
// The nightly job and its preview
// ---------------------------------------------------------------------------

/**
 * Tasks of `projectId` the nightly job archives on `today` with `days`: Done and Canceled, not
 * archived, closed on or before the day `days` days before today (in `timeZone`), except tasks a
 * merge closed while an item is still open (the merged-with-open-items group of Home). The preview
 * counts with the same condition. Statuses are literals so the planner matches the job's partial
 * index (project_id, status, closed_at).
 */
function dueCondition(projectId: string, days: number, today: string, timeZone: string): SQL {
  const firstKeptDay = addCalendarDays(today, 1 - days);
  return and(
    eq(task.projectId, projectId),
    isNull(task.archivedAt),
    sql`${task.status} in ('done', 'canceled')`,
    sql`${task.closedAt} < (${firstKeptDay}::date::timestamp at time zone ${timeZone})`,
    sql`not (${task.mergedDoneAt} is not null and ${task.status} = 'done' and exists (
      select 1 from ${taskItem} where ${taskItem.taskId} = ${task.id} and ${taskItem.state} = 'open'))`,
  ) as SQL;
}

async function countDue(
  db: DbOrTx,
  projectId: string,
  days: number,
  today: string,
  timeZone: string,
): Promise<number> {
  const [row] = await db
    .select({ n: sql<number>`count(*)`.mapWith(Number) })
    .from(task)
    .where(dueCondition(projectId, days, today, timeZone));
  return row?.n ?? 0;
}

/**
 * How many tasks the next nightly run would archive in the project with `days`: the job's own
 * condition on today in APP_TIME_ZONE. Anyone who can read the project may ask. A mirrored
 * project counts 0: the job skips it, Backlog.md's archive folder decides.
 */
export async function archivePreview(
  ctx: DbContext & ClockContext,
  actor: Actor,
  input: z.input<typeof ArchivePreviewInput>,
): Promise<ArchivePreview> {
  const parsed = parseInput(ArchivePreviewInput, input);
  const projectRow = await findProjectByKey(ctx.db, actor, parsed.project);
  const timeZone = ctx.timeZone ?? DEFAULT_TIME_ZONE;
  const count = (await isMirrored(ctx.db, projectRow.id))
    ? 0
    : await countDue(ctx.db, projectRow.id, parsed.days, todayIn(ctx), timeZone);
  return ArchivePreview.parse({ project: projectRow.key, days: parsed.days, count });
}

/**
 * The nightly archive (tasks.archive-due, 02:30 in APP_TIME_ZONE): in every project with
 * archive_after_days set that does not mirror Backlog.md, archives the due tasks (dueCondition on
 * the day of `now` in the context's time zone) as the system: no actor, origin app, cause
 * { kind: 'archive', afterDays }, one task.archived row per task. One transaction per project.
 * Tasks locked by a write in progress are skipped and archived on the next run, so the job never
 * waits on people. Runs are idempotent.
 */
export async function archiveDueTasks(
  ctx: DbContext & ClockContext,
  options: { now?: Date } = {},
): Promise<{ archived: number; projects: number }> {
  const now = options.now ?? clockNow(ctx);
  const timeZone = ctx.timeZone ?? DEFAULT_TIME_ZONE;
  const today = calendarDateIn(timeZone, now);
  const projects = await ctx.db
    .select({ id: project.id, workspaceId: project.workspaceId, days: project.archiveAfterDays })
    .from(project)
    .where(
      and(
        isNotNull(project.archiveAfterDays),
        sql`not exists (
          select 1 from ${backlogSource}
          where ${backlogSource.projectId} = ${project.id} and ${backlogSource.mode} = 'mirror'
            and ${backlogSource.state} <> 'detached')`,
      ),
    )
    .orderBy(asc(project.id));

  let archived = 0;
  let touched = 0;
  for (const { id, workspaceId, days } of projects) {
    if (days === null) continue;
    const count = await ctx.db.transaction(async (tx) => {
      const due = await tx
        .select({ id: task.id })
        .from(task)
        .where(dueCondition(id, days, today, timeZone))
        .orderBy(asc(task.id))
        .for('update', { skipLocked: true });
      if (due.length === 0) return 0;
      const rows = await tx
        .update(task)
        .set({ archivedAt: now, archivedById: null })
        .where(
          and(
            inArray(
              task.id,
              due.map((row) => row.id),
            ),
            isNull(task.archivedAt),
          ),
        )
        .returning({ id: task.id });
      const entries: SystemActivityEntry[] = rows.map((row) => ({
        workspaceId,
        projectId: id,
        taskId: row.id,
        type: 'task.archived',
        changes: [],
        origin: 'app',
        cause: { kind: 'archive', afterDays: days },
      }));
      await recordActivities(tx, null, entries);
      return rows.length;
    });
    archived += count;
    if (count > 0) touched += 1;
  }
  return { archived, projects: touched };
}
