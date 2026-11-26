// Cycles: numbered, dated time boxes per project. List, get, create, update, end (with rollover of
// unfinished tasks) and the hourly job that ends due cycles. See "Ending a cycle" in section 5 of
// the M2 plan.
//
// "Today" is the calendar day in APP_TIME_ZONE (ClockContext.timeZone, default UTC) at
// ClockContext.now (default: the current time). Dates are CalendarDate strings (YYYY-MM-DD),
// both ends included.
import {
  CreateCycleInput,
  type CurrentCycle,
  CYCLE_CURRENT,
  CYCLE_NEXT,
  Cycle,
  type CycleCounts,
  CycleDetail,
  CycleList,
  type CycleSelector,
  type CycleState,
  cycleLengthDays,
  DEFAULT_CYCLE_DAYS,
  EndCycleInput,
  formatTaskKey,
  GetCycleInput,
  ListCyclesInput,
  MAX_CYCLE_DAYS,
  MIN_CYCLE_DAYS,
  type MOVE_TO_NONE,
  type ProjectRef,
  UpdateCycleInput,
} from '@zamu/contracts';
import { type DbOrTx, schema, type Tx } from '@zamu/db';
import { and, asc, eq, gt, gte, inArray, isNull, lt, lte, ne, type SQL, sql } from 'drizzle-orm';
import { alias } from 'drizzle-orm/pg-core';
import type { z } from 'zod';
import { type ActivityEntry, recordActivities } from './activity';
import { type Actor, authorize } from './authz';
import type { DbContext } from './context';
import { Conflict, Invalid, NotFound, parseInput } from './errors';
import { findProjectByKey, loadUsers, type ProjectRow, userRef } from './internal';

const { cycle, cycleRollover, project, task, user } = schema;

// ---------------------------------------------------------------------------
// Clock and calendar dates
// ---------------------------------------------------------------------------

/** What decides "today" for milestones and cycles. Adapters pass APP_TIME_ZONE; tests fix `now`. */
export interface ClockContext {
  /** IANA time zone (APP_TIME_ZONE). Default UTC. */
  timeZone?: string;
  /** The current time. Default: new Date(). */
  now?: () => Date;
}

export const DEFAULT_TIME_ZONE = 'UTC';

/** True when `timeZone` is an IANA name this runtime knows. Adapters check APP_TIME_ZONE with it at startup. */
export function isValidTimeZone(timeZone: string): boolean {
  try {
    new Intl.DateTimeFormat('en-US', { timeZone });
    return true;
  } catch {
    return false;
  }
}

export function clockNow(clock: ClockContext = {}): Date {
  return clock.now ? clock.now() : new Date();
}

const dayFormatters = new Map<string, Intl.DateTimeFormat>();

/** The calendar day (YYYY-MM-DD) of `at` in `timeZone`. */
export function calendarDateIn(timeZone: string, at: Date): string {
  let format = dayFormatters.get(timeZone);
  if (!format) {
    // en-CA formats as YYYY-MM-DD.
    format = new Intl.DateTimeFormat('en-CA', {
      timeZone,
      year: 'numeric',
      month: '2-digit',
      day: '2-digit',
    });
    dayFormatters.set(timeZone, format);
  }
  return format.format(at);
}

/** Today in the clock's time zone. */
export function todayIn(clock: ClockContext = {}): string {
  return calendarDateIn(clock.timeZone ?? DEFAULT_TIME_ZONE, clockNow(clock));
}

function dateToUtc(date: string): number {
  return Date.parse(`${date}T00:00:00Z`);
}

/** `date` plus `days` calendar days (negative goes back). */
export function addCalendarDays(date: string, days: number): string {
  return new Date(dateToUtc(date) + days * 86_400_000).toISOString().slice(0, 10);
}

/** Whole days from `from` to `to`: 0 on the same day, negative when `to` is earlier. */
export function calendarDaysBetween(from: string, to: string): number {
  return Math.round((dateToUtc(to) - dateToUtc(from)) / 86_400_000);
}

/** The first Monday strictly after `date`. */
export function nextMonday(date: string): string {
  const weekday = new Date(dateToUtc(date)).getUTCDay(); // 0 Sunday .. 6 Saturday
  return addCalendarDays(date, (8 - weekday) % 7 || 7);
}

// ---------------------------------------------------------------------------
// State
// ---------------------------------------------------------------------------

export type CycleRow = typeof cycle.$inferSelect;

/**
 * Completed once ended. A cycle past its end date that the hourly job has not ended yet also reads
 * as Completed: it accepts no tasks and is no longer current. Current while today is within the
 * dates; Upcoming before.
 */
export function cycleStateOn(
  row: Pick<CycleRow, 'startsOn' | 'endsOn' | 'completedAt'>,
  today: string,
): CycleState {
  if (row.completedAt || row.endsOn < today) return 'completed';
  if (row.startsOn <= today) return 'current';
  return 'upcoming';
}

/** Days left including today (1 on the last day) for a current cycle; null otherwise. */
export function cycleDaysLeft(row: Pick<CycleRow, 'startsOn' | 'endsOn' | 'completedAt'>, today: string) {
  return cycleStateOn(row, today) === 'current' ? calendarDaysBetween(today, row.endsOn) + 1 : null;
}

/** A cycle row with its state for `today`. */
export type ResolvedCycle = CycleRow & { state: CycleState };

/**
 * The cycle of `projectId` that `selector` names: a number, `current` (today within its dates, not
 * ended) or `next` (the earliest Upcoming cycle). Null when there is none. Callers decide the
 * error: NotFound for cycle routes, Invalid for task inputs. Completed cycles are returned with
 * state 'completed' so task services can reject them.
 */
export async function resolveCycleSelector(
  db: DbOrTx,
  projectId: string,
  selector: CycleSelector,
  clock: ClockContext = {},
): Promise<ResolvedCycle | null> {
  const today = todayIn(clock);
  let condition: SQL | undefined;
  if (selector === CYCLE_CURRENT) {
    condition = and(isNull(cycle.completedAt), lte(cycle.startsOn, today), gte(cycle.endsOn, today));
  } else if (selector === CYCLE_NEXT) {
    condition = and(isNull(cycle.completedAt), gt(cycle.startsOn, today));
  } else {
    condition = eq(cycle.number, selector);
  }
  const [row] = await db
    .select()
    .from(cycle)
    .where(and(eq(cycle.projectId, projectId), condition))
    .orderBy(asc(cycle.startsOn))
    .limit(1);
  return row ? { ...row, state: cycleStateOn(row, today) } : null;
}

/**
 * The current cycle of each project in `projectIds`, keyed by project id. Projects without one are
 * left out. Used by the project shapes ("C12 · 3d left").
 */
export async function currentCycles(
  db: DbOrTx,
  projectIds: string[],
  clock: ClockContext = {},
): Promise<Map<string, CurrentCycle>> {
  const result = new Map<string, CurrentCycle>();
  if (projectIds.length === 0) return result;
  const today = todayIn(clock);
  const rows = await db
    .select()
    .from(cycle)
    .where(
      and(
        inArray(cycle.projectId, projectIds),
        isNull(cycle.completedAt),
        lte(cycle.startsOn, today),
        gte(cycle.endsOn, today),
      ),
    );
  for (const row of rows) {
    result.set(row.projectId, {
      id: row.id,
      number: row.number,
      name: row.name,
      startsOn: row.startsOn,
      endsOn: row.endsOn,
      daysLeft: calendarDaysBetween(today, row.endsOn) + 1,
    });
  }
  return result;
}

// ---------------------------------------------------------------------------
// Mapping
// ---------------------------------------------------------------------------

const countWhere = (condition: SQL) => sql<number>`count(*) filter (where ${condition})`.mapWith(Number);

/** "Added after start": entered the cycle after midnight of its first day in the time zone. */
function addedAfterStartSql(timeZone: string) {
  return sql`${task.cycleAddedAt} > (${cycle.startsOn}::timestamp at time zone ${timeZone})`;
}

const EMPTY_COUNTS: CycleCounts = {
  backlog: 0,
  todo: 0,
  in_progress: 0,
  in_review: 0,
  done: 0,
  canceled: 0,
  total: 0,
  addedAfterStart: 0,
  unassigned: 0,
  agents: 0,
};

/** Live counts of the tasks in each cycle. */
async function cycleCounts(
  db: DbOrTx,
  cycleIds: string[],
  timeZone: string,
): Promise<Map<string, CycleCounts>> {
  const result = new Map<string, CycleCounts>();
  if (cycleIds.length === 0) return result;
  const status = (value: string) => countWhere(sql`${task.status} = ${value}`);
  const rows = await db
    .select({
      cycleId: cycle.id,
      backlog: status('backlog'),
      todo: status('todo'),
      in_progress: status('in_progress'),
      in_review: status('in_review'),
      done: status('done'),
      canceled: status('canceled'),
      total: sql<number>`count(*)`.mapWith(Number),
      addedAfterStart: countWhere(addedAfterStartSql(timeZone)),
      unassigned: countWhere(sql`${task.assigneeId} is null`),
      agents: countWhere(sql`${user.kind} = 'agent'`),
    })
    .from(task)
    .innerJoin(cycle, eq(cycle.id, task.cycleId))
    .leftJoin(user, eq(user.id, task.assigneeId))
    // Tasks removed from Backlog.md stay in their cycle but count nowhere. M7: archived tasks
    // count, so archiving never lowers a progress bar.
    .where(and(inArray(task.cycleId, cycleIds), isNull(task.hiddenAt)))
    .groupBy(cycle.id);
  for (const { cycleId, ...counts } of rows) result.set(cycleId, counts);
  return result;
}

function projectRef(row: ProjectRow): ProjectRef {
  return { id: row.id, key: row.key, name: row.name };
}

async function toCycles(
  db: DbOrTx,
  projectRow: ProjectRow,
  rows: CycleRow[],
  clock: ClockContext,
): Promise<Cycle[]> {
  const today = todayIn(clock);
  const [counts, users] = await Promise.all([
    cycleCounts(
      db,
      rows.map((row) => row.id),
      clock.timeZone ?? DEFAULT_TIME_ZONE,
    ),
    loadUsers(
      db,
      rows.flatMap((row) => (row.endedById ? [row.endedById] : [])),
    ),
  ]);
  return rows.map((row) => {
    const endedBy = row.endedById ? users.get(row.endedById) : undefined;
    return Cycle.parse({
      id: row.id,
      project: projectRef(projectRow),
      number: row.number,
      name: row.name,
      startsOn: row.startsOn,
      endsOn: row.endsOn,
      state: cycleStateOn(row, today),
      daysLeft: cycleDaysLeft(row, today),
      counts: counts.get(row.id) ?? EMPTY_COUNTS,
      completedAt: row.completedAt,
      endedBy: endedBy ? userRef(endedBy) : null,
      summary: row.completedAt
        ? {
            scope: row.scopeCount ?? 0,
            completed: row.completedCount ?? 0,
            rolledOver: row.rolledOverCount ?? 0,
            canceled: row.canceledCount ?? 0,
            addedAfterStart: row.addedAfterStartCount ?? 0,
          }
        : null,
    });
  });
}

async function toCycleDetail(
  db: DbOrTx,
  projectRow: ProjectRow,
  row: CycleRow,
  clock: ClockContext,
): Promise<CycleDetail> {
  const [base] = await toCycles(db, projectRow, [row], clock);
  const target = alias(cycle, 'target');
  const rollovers = await db
    .select({
      taskId: task.id,
      number: task.number,
      keySuffix: task.keySuffix,
      title: task.title,
      status: task.status,
      statusAtEnd: cycleRollover.statusAtEnd,
      createdAt: cycleRollover.createdAt,
      toId: target.id,
      toNumber: target.number,
      toName: target.name,
    })
    .from(cycleRollover)
    .innerJoin(task, eq(task.id, cycleRollover.taskId))
    .leftJoin(target, eq(target.id, cycleRollover.toCycleId))
    .where(eq(cycleRollover.cycleId, row.id))
    .orderBy(asc(task.number));
  return CycleDetail.parse({
    ...base,
    rollovers: rollovers.map((r) => ({
      task: {
        id: r.taskId,
        key: formatTaskKey(projectRow.key, r.number, r.keySuffix),
        title: r.title,
        status: r.status,
      },
      statusAtEnd: r.statusAtEnd,
      movedTo: r.toId && r.toNumber !== null ? { id: r.toId, number: r.toNumber, name: r.toName } : null,
      createdAt: r.createdAt,
    })),
  });
}

// ---------------------------------------------------------------------------
// Shared checks
// ---------------------------------------------------------------------------

type CycleContext = DbContext & ClockContext;

function requireCycles(projectRow: ProjectRow): void {
  if (!projectRow.usesCycles) {
    throw new Conflict(`${projectRow.key} does not use cycles. Turn them on in the project settings.`);
  }
}

function invalidDates(path: 'startsOn' | 'endsOn', message: string): Invalid {
  return new Invalid(message, { issues: [{ path, message }] });
}

/** Length 1 to 56 days, end not before today. */
function checkDates(startsOn: string, endsOn: string, today: string): void {
  const days = cycleLengthDays(startsOn, endsOn);
  if (days < MIN_CYCLE_DAYS) throw invalidDates('endsOn', 'End on or after the start date');
  if (days > MAX_CYCLE_DAYS) throw invalidDates('endsOn', `Keep cycles to ${MAX_CYCLE_DAYS} days or fewer`);
  if (endsOn < today) throw invalidDates('endsOn', 'A cycle cannot end before today');
}

/** Conflict when another cycle of the project shares a day with [startsOn, endsOn]. Call under the project lock. */
async function assertNoOverlap(
  tx: Tx,
  projectId: string,
  startsOn: string,
  endsOn: string,
  exceptId?: string,
): Promise<void> {
  const [other] = await tx
    .select({ number: cycle.number, startsOn: cycle.startsOn, endsOn: cycle.endsOn })
    .from(cycle)
    .where(
      and(
        eq(cycle.projectId, projectId),
        lte(cycle.startsOn, endsOn),
        gte(cycle.endsOn, startsOn),
        exceptId ? ne(cycle.id, exceptId) : undefined,
      ),
    )
    .orderBy(asc(cycle.startsOn))
    .limit(1);
  if (other) {
    throw new Conflict(`The dates overlap Cycle ${other.number} (${other.startsOn} to ${other.endsOn})`);
  }
}

/** The cycle with the latest end date, or null for a project without cycles. */
async function lastCycle(tx: Tx, projectId: string): Promise<CycleRow | null> {
  const [row] = await tx
    .select()
    .from(cycle)
    .where(eq(cycle.projectId, projectId))
    .orderBy(sql`${cycle.endsOn} desc`, sql`${cycle.number} desc`)
    .limit(1);
  return row ?? null;
}

/** Takes the next cycle number from the project counter. Call under the project lock. */
async function takeCycleNumber(tx: Tx, projectId: string): Promise<number> {
  const [counter] = await tx
    .update(project)
    .set({ nextCycleNumber: sql`${project.nextCycleNumber} + 1`, updatedAt: sql`${project.updatedAt}` })
    .where(eq(project.id, projectId))
    .returning({ number: sql<number>`${project.nextCycleNumber} - 1`.mapWith(Number) });
  if (!counter) throw new NotFound('Project not found');
  return counter.number;
}

/** Inserts a cycle after the overlap check. Call under the project lock. */
async function insertCycle(
  tx: Tx,
  projectRow: ProjectRow,
  values: { name: string | null; startsOn: string; endsOn: string },
): Promise<CycleRow> {
  await assertNoOverlap(tx, projectRow.id, values.startsOn, values.endsOn);
  const number = await takeCycleNumber(tx, projectRow.id);
  const [row] = await tx
    .insert(cycle)
    .values({ workspaceId: projectRow.workspaceId, projectId: projectRow.id, number, ...values })
    .returning();
  if (!row) throw new Error('cycle insert returned no row');
  return row;
}

async function findCycle(db: DbOrTx, projectRow: ProjectRow, selector: CycleSelector, clock: ClockContext) {
  const row = await resolveCycleSelector(db, projectRow.id, selector, clock);
  if (!row) {
    const what =
      selector === CYCLE_CURRENT ? 'No current cycle' : selector === CYCLE_NEXT ? 'No upcoming cycle' : null;
    throw new NotFound(
      what ? `${what} in ${projectRow.key}` : `Cycle ${selector} not found in ${projectRow.key}`,
    );
  }
  return row;
}

/** Locks the cycle row and returns its current version. */
async function lockCycle(tx: Tx, cycleId: string): Promise<CycleRow> {
  const [row] = await tx.select().from(cycle).where(eq(cycle.id, cycleId)).for('update');
  if (!row) throw new NotFound('Cycle not found');
  return row;
}

// ---------------------------------------------------------------------------
// Read
// ---------------------------------------------------------------------------

/** A project's cycles, oldest first, with state, days left and live task counts. */
export async function listCycles(
  ctx: CycleContext,
  actor: Actor,
  input: z.input<typeof ListCyclesInput>,
): Promise<CycleList> {
  const parsed = parseInput(ListCyclesInput, input);
  const projectRow = await findProjectByKey(ctx.db, actor, parsed.project);
  const rows = await ctx.db
    .select()
    .from(cycle)
    .where(eq(cycle.projectId, projectRow.id))
    .orderBy(asc(cycle.startsOn), asc(cycle.number));
  const items = await toCycles(ctx.db, projectRow, rows, ctx);
  return CycleList.parse({
    items: parsed.state ? items.filter((item) => parsed.state?.includes(item.state)) : items,
  });
}

/** One cycle by number, current or next, with its rollover record. */
export async function getCycle(
  ctx: CycleContext,
  actor: Actor,
  input: z.input<typeof GetCycleInput>,
): Promise<CycleDetail> {
  const parsed = parseInput(GetCycleInput, input);
  const projectRow = await findProjectByKey(ctx.db, actor, parsed.project);
  const row = await findCycle(ctx.db, projectRow, parsed.number, ctx);
  return toCycleDetail(ctx.db, projectRow, row, ctx);
}

// ---------------------------------------------------------------------------
// Create and update
// ---------------------------------------------------------------------------

/**
 * Creates the next cycle. Omitted dates default from the last cycle: start the day after it ends
 * (or today, when that day has passed), same length. The first cycle starts next Monday and lasts
 * 14 days. Conflict when the dates overlap another cycle.
 */
export async function createCycle(
  ctx: CycleContext,
  actor: Actor,
  input: z.input<typeof CreateCycleInput>,
): Promise<CycleDetail> {
  const parsed = parseInput(CreateCycleInput, input);
  const today = todayIn(ctx);
  return ctx.db.transaction(async (tx) => {
    // The project row lock serialises cycle creation and the overlap check.
    const projectRow = await findProjectByKey(tx, actor, parsed.project, { forUpdate: true });
    authorize(actor, 'task.write', { type: 'project', projectId: projectRow.id });
    requireCycles(projectRow);

    const last = await lastCycle(tx, projectRow.id);
    const length = last ? cycleLengthDays(last.startsOn, last.endsOn) : DEFAULT_CYCLE_DAYS;
    const afterLast = last ? addCalendarDays(last.endsOn, 1) : null;
    const defaultStart = afterLast === null ? nextMonday(today) : ([afterLast, today].sort()[1] ?? today);
    const startsOn = parsed.startsOn ?? defaultStart;
    const endsOn = parsed.endsOn ?? addCalendarDays(startsOn, length - 1);
    checkDates(startsOn, endsOn, today);

    const row = await insertCycle(tx, projectRow, { name: parsed.name ?? null, startsOn, endsOn });
    return toCycleDetail(tx, projectRow, row, ctx);
  });
}

/** Renames a cycle before it ends; moves its dates only while it is Upcoming. */
export async function updateCycle(
  ctx: CycleContext,
  actor: Actor,
  input: z.input<typeof UpdateCycleInput>,
): Promise<CycleDetail> {
  const parsed = parseInput(UpdateCycleInput, input);
  const today = todayIn(ctx);
  return ctx.db.transaction(async (tx) => {
    const projectRow = await findProjectByKey(tx, actor, parsed.project, { forUpdate: true });
    authorize(actor, 'task.write', { type: 'project', projectId: projectRow.id });
    requireCycles(projectRow);
    const found = await findCycle(tx, projectRow, parsed.number, ctx);
    const current = await lockCycle(tx, found.id);
    const state = cycleStateOn(current, today);
    if (state === 'completed') throw new Conflict(`Cycle ${current.number} has ended and cannot change`);

    const set: Partial<typeof cycle.$inferInsert> = {};
    if (parsed.name !== undefined && parsed.name !== current.name) set.name = parsed.name;
    const startsOn = parsed.startsOn ?? current.startsOn;
    const endsOn = parsed.endsOn ?? current.endsOn;
    if (startsOn !== current.startsOn || endsOn !== current.endsOn) {
      if (state !== 'upcoming') {
        throw new Conflict(`Cycle ${current.number} has started: only its name can change`);
      }
      checkDates(startsOn, endsOn, today);
      await assertNoOverlap(tx, projectRow.id, startsOn, endsOn, current.id);
      set.startsOn = startsOn;
      set.endsOn = endsOn;
    }
    if (Object.keys(set).length === 0) return toCycleDetail(tx, projectRow, current, ctx);

    const [row] = await tx.update(cycle).set(set).where(eq(cycle.id, current.id)).returning();
    if (!row) throw new Error('cycle update returned no row');
    return toCycleDetail(tx, projectRow, row, ctx);
  });
}

// ---------------------------------------------------------------------------
// Ending a cycle
// ---------------------------------------------------------------------------

/**
 * Ends `current` (already locked, not completed) under the project lock: counts the summary,
 * picks the target (moveTo, else the next Upcoming cycle, else a new cycle of the same length
 * starting the day after this one ends), moves every unfinished task with a rollover row and one
 * cycle.ended activity row each, then marks the cycle completed. `actor` null is the hourly job.
 */
async function endLockedCycle(
  tx: Tx,
  clock: ClockContext,
  actor: Actor | null,
  projectRow: ProjectRow,
  current: CycleRow,
  moveTo: number | typeof MOVE_TO_NONE | undefined,
): Promise<void> {
  const now = clockNow(clock);
  const timeZone = clock.timeZone ?? DEFAULT_TIME_ZONE;

  // Lock the cycle's tasks so concurrent task updates queue behind the rollover.
  const tasks = await tx
    .select({
      id: task.id,
      status: task.status,
      afterStart: sql<boolean>`coalesce(${task.cycleAddedAt} > (${current.startsOn}::date::timestamp at time zone ${timeZone}), false)`,
    })
    .from(task)
    // Hidden tasks (removed from Backlog.md) do not roll over; they stay in the ended cycle. M7:
    // nor do archived ones, which are read-only.
    .where(and(eq(task.cycleId, current.id), isNull(task.hiddenAt), isNull(task.archivedAt)))
    .for('update');
  const unfinished = tasks.filter((t) => t.status !== 'done' && t.status !== 'canceled');

  let target: CycleRow | null = null;
  if (typeof moveTo === 'number') {
    const [row] = await tx
      .select()
      .from(cycle)
      .where(and(eq(cycle.projectId, projectRow.id), eq(cycle.number, moveTo)))
      .limit(1);
    const message = !row
      ? `Cycle ${moveTo} not found in ${projectRow.key}`
      : row.id === current.id
        ? 'Move unfinished tasks to another cycle'
        : cycleStateOn(row, calendarDateIn(timeZone, now)) === 'completed'
          ? `Cycle ${moveTo} has ended`
          : null;
    if (message) throw new Invalid(message, { issues: [{ path: 'moveTo', message }] });
    target = row ?? null;
  } else if (moveTo === undefined) {
    const [next] = await tx
      .select()
      .from(cycle)
      .where(
        and(
          eq(cycle.projectId, projectRow.id),
          isNull(cycle.completedAt),
          gt(cycle.startsOn, current.endsOn),
        ),
      )
      .orderBy(asc(cycle.startsOn))
      .limit(1);
    target =
      next ??
      (await insertCycle(tx, projectRow, {
        name: null,
        startsOn: addCalendarDays(current.endsOn, 1),
        endsOn: addCalendarDays(current.endsOn, cycleLengthDays(current.startsOn, current.endsOn)),
      }));
  }

  if (unfinished.length > 0) {
    const ids = unfinished.map((t) => t.id);
    await tx.insert(cycleRollover).values(
      unfinished.map((t) => ({
        cycleId: current.id,
        taskId: t.id,
        toCycleId: target?.id ?? null,
        statusAtEnd: t.status,
        createdAt: now,
      })),
    );
    await tx
      .update(task)
      .set({ cycleId: target?.id ?? null, cycleAddedAt: now })
      .where(inArray(task.id, ids));
    const entries: ActivityEntry[] = ids.map((taskId) => ({
      projectId: projectRow.id,
      taskId,
      type: 'cycle.ended',
      changes: [{ field: 'cycle', from: current.id, to: target?.id ?? null }],
    }));
    if (actor) await recordActivities(tx, actor, entries);
    else {
      await recordActivities(
        tx,
        null,
        entries.map((entry) => ({ ...entry, workspaceId: projectRow.workspaceId })),
      );
    }
  }

  await tx
    .update(cycle)
    .set({
      completedAt: now,
      endedById: actor?.userId ?? null,
      scopeCount: tasks.length,
      completedCount: tasks.filter((t) => t.status === 'done').length,
      canceledCount: tasks.filter((t) => t.status === 'canceled').length,
      rolledOverCount: unfinished.length,
      addedAfterStartCount: tasks.filter((t) => t.afterStart).length,
    })
    .where(eq(cycle.id, current.id));
}

/**
 * Ends a cycle now (by number, current or next). Unfinished tasks move to `moveTo`, to the next
 * Upcoming cycle, or to a new cycle of the same length. Ending a cycle that has already ended
 * changes nothing and returns it as it is.
 */
export async function endCycle(
  ctx: CycleContext,
  actor: Actor,
  input: z.input<typeof EndCycleInput>,
): Promise<CycleDetail> {
  const parsed = parseInput(EndCycleInput, input);
  return ctx.db.transaction(async (tx) => {
    const projectRow = await findProjectByKey(tx, actor, parsed.project, { forUpdate: true });
    authorize(actor, 'task.write', { type: 'project', projectId: projectRow.id });
    requireCycles(projectRow);
    const found = await findCycle(tx, projectRow, parsed.number, ctx);
    const current = await lockCycle(tx, found.id);
    if (!current.completedAt) {
      await endLockedCycle(tx, ctx, actor, projectRow, current, parsed.moveTo);
    }
    return toCycleDetail(tx, projectRow, await lockCycle(tx, current.id), ctx);
  });
}

/**
 * Ends every cycle whose end date is before today, in projects that use cycles, as the system
 * (null actor) with the default target. Earlier cycles first. Each cycle ends in its own
 * transaction; cycles already ended (by hand or by another run) are skipped, so runs are idempotent.
 */
export async function endDueCycles(ctx: CycleContext): Promise<{ ended: number }> {
  const today = todayIn(ctx);
  const due = await ctx.db
    .select({ id: cycle.id, projectId: cycle.projectId })
    .from(cycle)
    .innerJoin(project, eq(project.id, cycle.projectId))
    .where(and(isNull(cycle.completedAt), lt(cycle.endsOn, today), eq(project.usesCycles, true)))
    .orderBy(asc(cycle.projectId), asc(cycle.startsOn));

  let ended = 0;
  for (const { id, projectId } of due) {
    const done = await ctx.db.transaction(async (tx) => {
      const [projectRow] = await tx.select().from(project).where(eq(project.id, projectId)).for('update');
      if (!projectRow?.usesCycles) return false;
      const current = await lockCycle(tx, id);
      if (current.completedAt || current.endsOn >= today) return false;
      await endLockedCycle(tx, ctx, null, projectRow, current, undefined);
      return true;
    });
    if (done) ended++;
  }
  return { ended };
}
