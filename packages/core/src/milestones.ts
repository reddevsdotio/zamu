// Milestones: per-project goals with an optional target date. Planned until a task in them starts
// (activateMilestoneForTask), Active then, Completed only by hand. Progress comes from task counts.
// M3: milestones of a project mirrored from Backlog.md come from its files. Creating, changing and
// deleting them in the app fails with MILESTONE_MIRRORED; hidden ones (file gone) leave the list.
// M8: the plan link (planUrl, not a Backlog.md field, so mirrored milestones take it too) and the
// wave summary of list and get rows, from waveStates in waves.ts for every milestone at once.
import {
  CreateMilestoneInput,
  DeleteMilestoneInput,
  GetMilestoneInput,
  ListMilestonesInput,
  MILESTONE_OWNED_FIELDS,
  MilestoneList,
  type MilestoneOwnedField,
  type MilestoneProgress,
  MilestoneWithProgress,
  UpdateMilestoneInput,
} from '@zamu/contracts';
import { type DbOrTx, schema, type Tx } from '@zamu/db';
import { and, asc, eq, inArray, isNull, type SQL, sql } from 'drizzle-orm';
import type { z } from 'zod';
import { type ActivityEntry, recordActivities } from './activity';
import { type Actor, authorize } from './authz';
import type { DbContext } from './context';
import { type ClockContext, calendarDaysBetween, clockNow, todayIn } from './cycles';
import { Conflict, isUniqueViolation, MilestoneMirrored, NotFound, parseInput } from './errors';
import {
  type BacklogSourceRow,
  backlogFilePath,
  findProjectByKey,
  isMirrored,
  loadBacklogSource,
  loadUsers,
  type ProjectRow,
  shellWord,
  sourceMirrors,
  userRef,
} from './internal';
import { type WaveState, waveStates, waveSummaryOf } from './waves';

const { milestone, project, task } = schema;

const MILESTONE_NAME_UNIQUE = 'milestone_projectId_name_unique';

export type MilestoneRow = typeof milestone.$inferSelect;

type MilestoneContext = DbContext & ClockContext;

/**
 * Sets a Planned milestone to Active, inside the caller's transaction. Task services call it when
 * a task in the milestone moves to In progress or In review. Active and Completed milestones stay
 * as they are; null or an unknown id does nothing. Returns true when the status changed.
 */
export async function activateMilestoneForTask(
  tx: Tx,
  milestoneId: string | null | undefined,
): Promise<boolean> {
  if (!milestoneId) return false;
  const rows = await tx
    .update(milestone)
    .set({ status: 'active' })
    .where(and(eq(milestone.id, milestoneId), eq(milestone.status, 'planned')))
    .returning({ id: milestone.id });
  return rows.length > 0;
}

// ---------------------------------------------------------------------------
// Mapping
// ---------------------------------------------------------------------------

const countWhere = (condition: SQL) => sql<number>`count(*) filter (where ${condition})`.mapWith(Number);

const EMPTY_PROGRESS: MilestoneProgress = { total: 0, done: 0, inProgress: 0, open: 0, canceled: 0 };

async function milestoneProgress(db: DbOrTx, ids: string[]): Promise<Map<string, MilestoneProgress>> {
  const result = new Map<string, MilestoneProgress>();
  if (ids.length === 0) return result;
  const rows = await db
    .select({
      milestoneId: task.milestoneId,
      total: sql<number>`count(*)`.mapWith(Number),
      done: countWhere(sql`${task.status} = 'done'`),
      inProgress: countWhere(sql`${task.status} in ('in_progress', 'in_review')`),
      open: countWhere(sql`${task.status} in ('backlog', 'todo')`),
      canceled: countWhere(sql`${task.status} = 'canceled'`),
    })
    .from(task)
    // Hidden tasks (file gone from Backlog.md) do not count. M7: archived tasks do, so archiving
    // never lowers a progress bar.
    .where(and(inArray(task.milestoneId, ids), isNull(task.hiddenAt)))
    .groupBy(task.milestoneId);
  for (const { milestoneId, ...progress } of rows) if (milestoneId) result.set(milestoneId, progress);
  return result;
}

/**
 * Milestones with progress and (M8) the wave summary. `states` passes wave states the caller read
 * already (the plan); otherwise one waveStates query covers every row.
 */
async function toMilestones(
  db: DbOrTx,
  projectRow: ProjectRow,
  rows: MilestoneRow[],
  clock: ClockContext,
  states?: Map<string, WaveState[]>,
): Promise<MilestoneWithProgress[]> {
  const today = todayIn(clock);
  const locked: MilestoneOwnedField[] = (await isMirrored(db, projectRow.id))
    ? [...MILESTONE_OWNED_FIELDS]
    : [];
  const ids = rows.map((row) => row.id);
  // Sequential: callers run this inside transactions, where queries share one connection.
  const progress = await milestoneProgress(db, ids);
  const users = await loadUsers(
    db,
    rows.map((row) => row.createdById),
  );
  const waves = states ?? (await waveStates(db, ids));
  return rows.map((row) => {
    const creator = users.get(row.createdById);
    if (!creator) throw new Error(`user ${row.createdById} referenced by a milestone does not exist`);
    return MilestoneWithProgress.parse({
      id: row.id,
      project: { id: projectRow.id, key: projectRow.key, name: projectRow.name },
      name: row.name,
      description: row.description,
      targetDate: row.targetDate,
      status: row.status,
      completedAt: row.completedAt,
      createdBy: userRef(creator),
      backlogId: row.backlogId,
      locked,
      hidden: row.hiddenAt !== null,
      planUrl: row.planUrl,
      createdAt: row.createdAt,
      updatedAt: row.updatedAt,
      progress: progress.get(row.id) ?? EMPTY_PROGRESS,
      daysLeft: row.targetDate ? calendarDaysBetween(today, row.targetDate) : null,
      overdue: row.targetDate !== null && row.targetDate < today && row.status !== 'completed',
      waves: waveSummaryOf(waves.get(row.id)),
    });
  });
}

/** One milestone with progress and its wave summary (`states` when the caller has them). */
export async function toMilestoneWithProgress(
  db: DbOrTx,
  projectRow: ProjectRow,
  row: MilestoneRow,
  clock: ClockContext,
  states?: Map<string, WaveState[]>,
): Promise<MilestoneWithProgress> {
  const [item] = await toMilestones(db, projectRow, [row], clock, states);
  if (!item) throw new Error('milestone mapping returned nothing');
  return item;
}

const toMilestone = toMilestoneWithProgress;

// ---------------------------------------------------------------------------
// Shared checks
// ---------------------------------------------------------------------------

/** Conflict when the project has milestones turned off. Wave writes check it too. */
export function requireMilestones(projectRow: ProjectRow): void {
  if (!projectRow.usesMilestones) {
    throw new Conflict(`${projectRow.key} does not use milestones. Turn them on in the project settings.`);
  }
}

/** How a MilestoneMirrored message names each owned field. */
const OWNED_FIELD_LABELS: Record<MilestoneOwnedField, string> = {
  name: 'name',
  description: 'description',
  targetDate: 'target date',
  status: 'status',
};

/** MilestoneMirrored for a new milestone in a mirrored project: milestones are added in Backlog.md. */
function milestoneCreateRefused(projectRow: ProjectRow, name: string, targetDate: string | null | undefined) {
  const due = targetDate ? ` --due-date ${targetDate}` : '';
  return new MilestoneMirrored(
    `Milestones in ${projectRow.name} come from Backlog.md. Run backlog milestone add and push. It shows up here after the next refresh.`,
    { hint: `backlog milestone add ${shellWord(name)}${due}` },
  );
}

/**
 * MilestoneMirrored for a change (`field`) or the deletion (field undefined) of a milestone of a
 * mirrored project, with its file, Backlog.md id and a hint. Hints use Backlog.md's milestone
 * commands (rename, archive, remove) where one exists.
 */
async function milestoneMirrored(
  db: DbOrTx,
  source: BacklogSourceRow,
  row: MilestoneRow,
  change: { field: MilestoneOwnedField; to: string | null } | null,
): Promise<MilestoneMirrored> {
  const file = await backlogFilePath(db, source, { milestoneId: row.id });
  const id = shellWord(row.backlogId ?? row.name);
  let hint: string;
  if (!change) hint = `backlog milestone remove ${id}`;
  else if (change.field === 'name') hint = `backlog milestone rename ${id} ${shellWord(change.to ?? '')}`;
  else if (change.field === 'status' && change.to === 'completed') hint = `backlog milestone archive ${id}`;
  else if (change.field === 'status') hint = 'Move the milestone file out of the archive and push';
  else if (change.field === 'targetDate') hint = 'Change due_date in the milestone file and push';
  else hint = 'Change the Description section of the milestone file and push';
  const message = change
    ? `${row.name} is mirrored from Backlog.md, so its ${OWNED_FIELD_LABELS[change.field]} can't change here`
    : `${row.name} is mirrored from Backlog.md, so it can't be deleted here`;
  return new MilestoneMirrored(message, {
    ...(change ? { field: change.field } : {}),
    ...(file ? { file } : {}),
    ...(row.backlogId ? { backlogId: row.backlogId } : {}),
    hint,
  });
}

function nameTaken(name: string): Conflict {
  return new Conflict(`A milestone named "${name}" already exists in this project`);
}

/**
 * The milestone with `id` and its project, after the read check. NotFound outside the actor's
 * workspace; Forbidden outside the key's scope. `forUpdate` locks the milestone row (wave writes
 * take it to keep positions dense).
 */
export async function findMilestone(
  db: DbOrTx,
  actor: Actor,
  id: string,
  options: { forUpdate?: boolean } = {},
): Promise<{ project: ProjectRow; milestone: MilestoneRow }> {
  const query = db
    .select({ milestone, project })
    .from(milestone)
    .innerJoin(project, eq(project.id, milestone.projectId))
    .where(and(eq(milestone.id, id), eq(milestone.workspaceId, actor.workspaceId)))
    .limit(1);
  const [row] = options.forUpdate ? await query.for('update', { of: milestone }) : await query;
  if (!row) throw new NotFound('Milestone not found');
  authorize(actor, 'project.read', { type: 'project', projectId: row.project.id });
  return row;
}

// ---------------------------------------------------------------------------
// Read
// ---------------------------------------------------------------------------

/**
 * A project's milestones with progress, by target date (none last), then name. Milestones whose
 * Backlog.md file is gone (hidden) are left out; getMilestone still finds them.
 */
export async function listMilestones(
  ctx: MilestoneContext,
  actor: Actor,
  input: z.input<typeof ListMilestonesInput>,
): Promise<MilestoneList> {
  const parsed = parseInput(ListMilestonesInput, input);
  const projectRow = await findProjectByKey(ctx.db, actor, parsed.project);
  const rows = await ctx.db
    .select()
    .from(milestone)
    .where(
      and(
        eq(milestone.projectId, projectRow.id),
        isNull(milestone.hiddenAt),
        parsed.status ? inArray(milestone.status, parsed.status) : undefined,
      ),
    )
    .orderBy(sql`${milestone.targetDate} asc nulls last`, sql`lower(${milestone.name})`, asc(milestone.id));
  return MilestoneList.parse({ items: await toMilestones(ctx.db, projectRow, rows, ctx) });
}

export async function getMilestone(
  ctx: MilestoneContext,
  actor: Actor,
  input: z.input<typeof GetMilestoneInput>,
): Promise<MilestoneWithProgress> {
  const { id } = parseInput(GetMilestoneInput, input);
  const found = await findMilestone(ctx.db, actor, id);
  return toMilestone(ctx.db, found.project, found.milestone, ctx);
}

// ---------------------------------------------------------------------------
// Write
// ---------------------------------------------------------------------------

/**
 * Creates a Planned milestone. Conflict when the name is taken in the project (ignoring case);
 * MilestoneMirrored when the project mirrors Backlog.md.
 */
export async function createMilestone(
  ctx: MilestoneContext,
  actor: Actor,
  input: z.input<typeof CreateMilestoneInput>,
): Promise<MilestoneWithProgress> {
  const parsed = parseInput(CreateMilestoneInput, input);
  const projectRow = await findProjectByKey(ctx.db, actor, parsed.project);
  authorize(actor, 'task.write', { type: 'project', projectId: projectRow.id });
  requireMilestones(projectRow);
  if (await isMirrored(ctx.db, projectRow.id)) {
    throw milestoneCreateRefused(projectRow, parsed.name, parsed.targetDate);
  }
  try {
    const [row] = await ctx.db
      .insert(milestone)
      .values({
        workspaceId: projectRow.workspaceId,
        projectId: projectRow.id,
        name: parsed.name,
        description: parsed.description || null,
        targetDate: parsed.targetDate ?? null,
        createdById: actor.userId,
      })
      .returning();
    if (!row) throw new Error('milestone insert returned no row');
    return await toMilestone(ctx.db, projectRow, row, ctx);
  } catch (error) {
    if (isUniqueViolation(error, MILESTONE_NAME_UNIQUE)) throw nameTaken(parsed.name);
    throw error;
  }
}

/**
 * Changes name, description, target date or status. Completed is set by hand only; any other
 * status on a Completed milestone reopens it as Active. MilestoneMirrored for a real change in a
 * project that mirrors Backlog.md (sending the stored values changes nothing and passes).
 * M8: planUrl sets the plan link (null clears it); it is not a Backlog.md field, so mirrored
 * milestones take it, and a request that changes only it passes the mirror check.
 */
export async function updateMilestone(
  ctx: MilestoneContext,
  actor: Actor,
  input: z.input<typeof UpdateMilestoneInput>,
): Promise<MilestoneWithProgress> {
  const parsed = parseInput(UpdateMilestoneInput, input);
  try {
    return await ctx.db.transaction(async (tx) => {
      const { project: projectRow, milestone: current } = await findMilestone(tx, actor, parsed.id, {
        forUpdate: true,
      });
      authorize(actor, 'task.write', { type: 'project', projectId: projectRow.id });
      requireMilestones(projectRow);

      const set: Partial<typeof milestone.$inferInsert> = {};
      if (parsed.name !== undefined && parsed.name !== current.name) set.name = parsed.name;
      if (parsed.description !== undefined) {
        const description = parsed.description || null;
        if (description !== current.description) set.description = description;
      }
      if (parsed.targetDate !== undefined && parsed.targetDate !== current.targetDate) {
        set.targetDate = parsed.targetDate;
      }
      if (parsed.status !== undefined && parsed.status !== current.status) {
        if (parsed.status === 'completed') {
          set.status = 'completed';
          set.completedAt = clockNow(ctx);
        } else if (current.status === 'completed') {
          set.status = 'active';
          set.completedAt = null;
        } else {
          set.status = parsed.status;
        }
      }
      if (parsed.planUrl !== undefined && parsed.planUrl !== current.planUrl) set.planUrl = parsed.planUrl;
      if (Object.keys(set).length === 0) return toMilestone(tx, projectRow, current, ctx);
      const ownedChange = MILESTONE_OWNED_FIELDS.some((name) => name in set) || 'completedAt' in set;
      const source = ownedChange ? await loadBacklogSource(tx, projectRow.id) : null;
      if (ownedChange && sourceMirrors(source)) {
        const field = MILESTONE_OWNED_FIELDS.find(
          (name) => name in set || (name === 'status' && 'completedAt' in set),
        );
        const to = field ? ((set as Record<string, unknown>)[field] as string | null | undefined) : undefined;
        throw await milestoneMirrored(tx, source as BacklogSourceRow, current, {
          field: field ?? 'status',
          to: to ?? null,
        });
      }

      const [row] = await tx.update(milestone).set(set).where(eq(milestone.id, current.id)).returning();
      if (!row) throw new Error('milestone update returned no row');
      return toMilestone(tx, projectRow, row, ctx);
    });
  } catch (error) {
    if (parsed.name && isUniqueViolation(error, MILESTONE_NAME_UNIQUE)) throw nameTaken(parsed.name);
    throw error;
  }
}

/**
 * Deletes a milestone. Its tasks lose it, each with a task.updated activity entry, in the same
 * transaction. MilestoneMirrored when the project mirrors Backlog.md. M8: its waves and their gate
 * results go with it; a task that was in a wave records that change in the same row.
 */
export async function deleteMilestone(
  ctx: MilestoneContext,
  actor: Actor,
  input: z.input<typeof DeleteMilestoneInput>,
): Promise<void> {
  const { id } = parseInput(DeleteMilestoneInput, input);
  await ctx.db.transaction(async (tx) => {
    const { project: projectRow, milestone: current } = await findMilestone(tx, actor, id, {
      forUpdate: true,
    });
    authorize(actor, 'task.write', { type: 'project', projectId: projectRow.id });
    requireMilestones(projectRow);
    const source = await loadBacklogSource(tx, projectRow.id);
    if (sourceMirrors(source)) throw await milestoneMirrored(tx, source as BacklogSourceRow, current, null);

    const waves = (await waveStates(tx, [current.id])).get(current.id) ?? [];
    const waveById = new Map(waves.map((state) => [state.id, state]));
    const before = await tx
      .select({ id: task.id, waveId: task.waveId })
      .from(task)
      .where(eq(task.milestoneId, current.id));
    const waveOfTask = new Map(before.map((row) => [row.id, row.waveId]));
    const cleared = await tx
      .update(task)
      .set({ milestoneId: null, waveId: null })
      .where(eq(task.milestoneId, current.id))
      .returning({ id: task.id });
    const entries: ActivityEntry[] = cleared.map((row) => {
      const state = waveById.get(waveOfTask.get(row.id) ?? '');
      return {
        projectId: projectRow.id,
        taskId: row.id,
        type: 'task.updated',
        changes: [
          { field: 'milestone', from: current.id, to: null },
          ...(state
            ? [
                {
                  field: 'wave' as const,
                  from: { id: state.id, number: state.number, name: state.name },
                  to: null,
                },
              ]
            : []),
        ],
      };
    });
    await recordActivities(tx, actor, entries);
    await tx.delete(milestone).where(eq(milestone.id, current.id));
  });
}
