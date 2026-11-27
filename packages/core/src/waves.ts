// Waves and gates (M8): ordered groups of a milestone's tasks, each ending in a gate whose state is
// its latest recorded result. The lock rule lives here, in waveStates, and only here: the plan,
// the task rows, the milestone summaries and the WAVE_LOCKED refusal in tasks.ts all read it.
//
// Rules (calls 2 to 9 of the M8 plan):
// - A wave's number is its position in the milestone, from 1, dense. Every wave write locks the
//   milestone row and rewrites the positions in one statement, so concurrent reorders queue and
//   never leave a gap or a duplicate. Names are unique per milestone, ignoring case.
// - A wave is locked while a wave before it has a gate that has not passed; it waits for the first
//   such wave. The current wave is the first wave whose gate has not passed. W1 is never locked.
// - A gate is open until its first result, then passed or failed; results are kept. Passing needs
//   every task of the wave Done or Canceled (hidden tasks ignored, archived ones counted by their
//   status), else GATE_TASKS_OPEN; failing is allowed at any time and changes no task.
// - A task is in at most one wave, of its own milestone. Putting a task in a wave moves it to the
//   wave's milestone (one task.updated row with both changes; refused for mirrored tasks, whose
//   milestone Backlog.md owns); tasks.ts applies it. Removing a wave takes its tasks out of it.
// - Anyone with task.write on the project changes waves and records results, agents included,
//   also on Completed milestones and in mirrored projects.
//
// Lock order: task rows (by id) before the milestone row, in putTasksInWave and deleteWave, because a
// task start locks the task and then activates its Planned milestone (lockMilestoneRow).
import {
  type CreateWaveInput,
  CreateWaveInput as CreateWaveInputSchema,
  DeleteWaveInput,
  formatTaskKey,
  formatWaveNumber,
  type GateState,
  GetMilestonePlanInput,
  MAX_WAVE_OPEN_KEYS,
  MilestonePlan,
  type PutTasksInWaveInput,
  PutTasksInWaveInput as PutTasksInWaveInputSchema,
  type RecordGateInput,
  RecordGateInput as RecordGateInputSchema,
  type TaskStatus,
  type TaskWave,
  type UpdateWaveInput,
  UpdateWaveInput as UpdateWaveInputSchema,
  Wave,
  type WaveNumberRef,
  type WaveTask,
} from '@zamu/contracts';
import { type DbOrTx, type GateResultState, schema, type Tx } from '@zamu/db';
import { and, asc, desc, eq, inArray, isNull, sql } from 'drizzle-orm';
import type { z } from 'zod';
import { entrySourceOf, recordActivities, type StoredWaveRef } from './activity';
import { TaskArchived, taskArchived } from './archive';
import { type Actor, authorize } from './authz';
import type { DbContext } from './context';
import type { ClockContext } from './cycles';
import {
  Conflict,
  GateTasksOpen,
  Invalid,
  isUniqueViolation,
  NotFound,
  parseInput,
  WaveLocked,
} from './errors';
import {
  findTask,
  loadUsers,
  type MilestoneRow,
  type ProjectRow,
  shellWord,
  type TaskRow,
  userRef,
} from './internal';
import { findMilestone, requireMilestones, toMilestoneWithProgress } from './milestones';
import { applyTaskPatch, type TaskContext } from './tasks';

const { gateResult, milestone, task, wave } = schema;

const WAVE_NAME_UNIQUE = 'wave_milestoneId_name_unique';

type WaveContext = DbContext & ClockContext;

// ---------------------------------------------------------------------------
// The lock rule
// ---------------------------------------------------------------------------

/** The latest result of a gate as stored. */
export interface GateResultRow {
  state: GateResultState;
  note: string;
  actorId: string;
  onBehalfOfId: string | null;
  machine: string | null;
  branch: string | null;
  createdAt: Date;
}

/** A wave with its gate's state and its place in the lock rule. */
export interface WaveState {
  id: string;
  milestoneId: string;
  /** Its position in the milestone, from 1 (W1). */
  number: number;
  name: string;
  gateDescription: string | null;
  gateState: GateState;
  /** The latest recorded result; null while the gate is open. */
  result: GateResultRow | null;
  /** The first wave whose gate has not passed. */
  current: boolean;
  /** A wave before it has a gate that has not passed. */
  locked: boolean;
  /** The first earlier wave whose gate has not passed; null while unlocked. */
  lockedUntil: WaveNumberRef | null;
}

/**
 * The waves of each milestone among `milestoneIds`, in order, with their gate states and the lock
 * rule applied: one query for the waves and their latest results, whatever the number of
 * milestones. Milestones without waves are left out. The ids come from rows the caller already
 * read within the actor's workspace.
 */
export async function waveStates(db: DbOrTx, milestoneIds: string[]): Promise<Map<string, WaveState[]>> {
  const result = new Map<string, WaveState[]>();
  const ids = [...new Set(milestoneIds)];
  if (ids.length === 0) return result;
  const latest = db
    .select({
      state: gateResult.state,
      note: gateResult.note,
      actorId: gateResult.actorId,
      onBehalfOfId: gateResult.onBehalfOfId,
      machine: gateResult.machine,
      branch: gateResult.branch,
      createdAt: gateResult.createdAt,
    })
    .from(gateResult)
    .where(eq(gateResult.waveId, wave.id))
    .orderBy(desc(gateResult.createdAt), desc(gateResult.id))
    .limit(1)
    .as('latest');
  const rows = await db
    .select({
      id: wave.id,
      milestoneId: wave.milestoneId,
      name: wave.name,
      gateDescription: wave.gateDescription,
      result: {
        state: latest.state,
        note: latest.note,
        actorId: latest.actorId,
        onBehalfOfId: latest.onBehalfOfId,
        machine: latest.machine,
        branch: latest.branch,
        createdAt: latest.createdAt,
      },
    })
    .from(wave)
    .leftJoinLateral(latest, sql`true`)
    .where(inArray(wave.milestoneId, ids))
    .orderBy(asc(wave.milestoneId), asc(wave.position), asc(wave.id));
  for (const row of rows) {
    const list = result.get(row.milestoneId) ?? [];
    const stored = row.result;
    const resultRow: GateResultRow | null =
      stored?.state && stored.note !== null && stored.actorId && stored.createdAt
        ? {
            state: stored.state,
            note: stored.note,
            actorId: stored.actorId,
            onBehalfOfId: stored.onBehalfOfId,
            machine: stored.machine,
            branch: stored.branch,
            createdAt: stored.createdAt,
          }
        : null;
    list.push({
      id: row.id,
      milestoneId: row.milestoneId,
      // Numbers come from the order, so a gap (never written by core) still reads densely.
      number: list.length + 1,
      name: row.name,
      gateDescription: row.gateDescription,
      gateState: resultRow?.state ?? 'open',
      result: resultRow,
      current: false,
      locked: false,
      lockedUntil: null,
    });
    result.set(row.milestoneId, list);
  }
  for (const list of result.values()) applyLockRule(list);
  return result;
}

/** Marks the current wave and the locked ones of one milestone's waves, in order. */
function applyLockRule(waves: WaveState[]): void {
  let waitingFor: WaveNumberRef | null = null;
  for (const state of waves) {
    state.locked = waitingFor !== null;
    state.lockedUntil = waitingFor;
    state.current = waitingFor === null && state.gateState !== 'passed';
    if (waitingFor === null && state.gateState !== 'passed') {
      waitingFor = { number: state.number, name: state.name };
    }
  }
}

/** The wave with `id` among the states, or null. */
export function findWaveState(states: Map<string, WaveState[]>, id: string | null): WaveState | null {
  if (!id) return null;
  for (const list of states.values()) {
    const found = list.find((state) => state.id === id);
    if (found) return found;
  }
  return null;
}

/** A task's wave as task shapes carry it; null when the task is in no wave. */
export function taskWaveOf(states: Map<string, WaveState[]>, waveId: string | null): TaskWave | null {
  const state = findWaveState(states, waveId);
  return state
    ? {
        id: state.id,
        number: state.number,
        name: state.name,
        locked: state.locked,
        lockedUntil: state.lockedUntil,
      }
    : null;
}

/** A wave as a stored activity change names it. */
export function storedWaveRef(state: Pick<WaveState, 'id' | 'number' | 'name'>): StoredWaveRef {
  return { id: state.id, number: state.number, name: state.name };
}

/** The wave summary of a milestone for the milestone list; null without waves. */
export function waveSummaryOf(waves: WaveState[] | undefined) {
  if (!waves || waves.length === 0) return null;
  const current = waves.find((state) => state.current) ?? null;
  return {
    count: waves.length,
    current: current?.number ?? null,
    currentState: current ? (current.gateState === 'failed' ? 'failed' : 'open') : null,
    allPassed: current === null,
  } as const;
}

/** Statuses that start a task when it comes from Backlog or Todo. */
const STARTED: ReadonlySet<TaskStatus> = new Set(['in_progress', 'in_review']);
const NOT_STARTED: ReadonlySet<TaskStatus> = new Set(['backlog', 'todo']);

/**
 * Whether the lock rule may refuse this change: an agent starting a task, meaning a status change
 * from Backlog or Todo to In progress or In review, or (from null) creating it there. People are
 * never refused; system moves never come through here.
 */
export function waveLockApplies(actor: Actor, from: TaskStatus | null, to: TaskStatus | undefined): boolean {
  if (actor.kind !== 'agent' || to === undefined || !STARTED.has(to)) return false;
  return from === null || NOT_STARTED.has(from);
}

/** "PAY-174 is in W4 · Rollout, which is locked until W3 · Payout screens passes." */
export function waveLockedMessage(key: string, state: WaveState): string {
  const waitsFor = state.lockedUntil;
  const until = waitsFor ? ` until ${formatWaveNumber(waitsFor.number)} · ${waitsFor.name} passes` : '';
  return `${key} is in ${formatWaveNumber(state.number)} · ${state.name}, which is locked${until}.`;
}

/**
 * WaveLocked for an agent starting `key` in the locked wave `state`, with the hint that shows the
 * plan (zamu milestones show). `message` replaces the one-task message (bulk changes).
 */
export function waveLockedError(
  key: string,
  state: WaveState,
  place: { milestoneName: string; projectKey: string },
  options: { issues?: { path: string; message: string }[]; message?: string } = {},
): WaveLocked {
  const waitsFor = state.lockedUntil ?? { number: state.number, name: state.name };
  const message =
    options.message ??
    `${waveLockedMessage(key, state)} Wait for the gate of ${formatWaveNumber(waitsFor.number)} to pass, or ask a person to start it.`;
  return new WaveLocked(
    message,
    { task: key, wave: { number: state.number, name: state.name }, waitsFor },
    `zamu milestones show ${shellWord(place.milestoneName)} --project ${place.projectKey}`,
    options.issues ? { issues: options.issues } : undefined,
  );
}

// ---------------------------------------------------------------------------
// Lookups
// ---------------------------------------------------------------------------

export type WaveRow = typeof wave.$inferSelect;

/**
 * The wave with `id`, its milestone and its project, after the read check. NotFound outside the
 * actor's workspace; Forbidden outside the key's scope. `lockMilestone` locks the milestone row
 * first and reads the wave after the lock, so a wave removed meanwhile is not found.
 */
async function findWave(
  db: DbOrTx,
  actor: Actor,
  id: string,
  options: { lockMilestone?: boolean } = {},
): Promise<{ project: ProjectRow; milestone: MilestoneRow; wave: WaveRow }> {
  const [hit] = await db
    .select({ milestoneId: wave.milestoneId })
    .from(wave)
    .where(and(eq(wave.id, id), eq(wave.workspaceId, actor.workspaceId)))
    .limit(1);
  if (!hit) throw new NotFound('Wave not found');
  const found = await findMilestone(db, actor, hit.milestoneId, { forUpdate: options.lockMilestone });
  const [row] = await db
    .select()
    .from(wave)
    .where(and(eq(wave.id, id), eq(wave.milestoneId, found.milestone.id)))
    .limit(1);
  if (!row) throw new NotFound('Wave not found');
  return { ...found, wave: row };
}

/**
 * Locks a milestone row. Lock order across Zamu: task rows first (by id), the milestone last. A task
 * update that starts a task holds the task and then activates its Planned milestone, so a wave write
 * that touches tasks must lock them before the milestone, or the two deadlock.
 */
async function lockMilestoneRow(tx: Tx, milestoneId: string): Promise<void> {
  await tx.select({ id: milestone.id }).from(milestone).where(eq(milestone.id, milestoneId)).for('update');
}

/** Locks the rows of `ids` in id order (the order bulk task changes use) and returns them. */
async function lockTaskRows(tx: Tx, ids: string[]): Promise<TaskRow[]> {
  if (ids.length === 0) return [];
  return tx
    .select()
    .from(task)
    .where(inArray(task.id, [...new Set(ids)].sort()))
    .orderBy(asc(task.id))
    .for('update');
}

function nameTaken(name: string): Conflict {
  return new Conflict(`A wave named "${name}" already exists in this milestone`);
}

/**
 * Rewrites the positions of a milestone's waves to 1..n in the order of `orderedIds`, in one
 * statement, touching only the rows whose position changes. Raw SQL on purpose: renumbering is
 * not a change of those waves, so their updated_at stays. The caller holds the milestone lock.
 */
async function writePositions(tx: Tx, current: WaveRow[], orderedIds: string[]): Promise<void> {
  const before = new Map(current.map((row) => [row.id, row.position]));
  const changed = orderedIds
    .map((id, index) => ({ id, position: index + 1 }))
    .filter((entry) => before.get(entry.id) !== entry.position);
  if (changed.length === 0) return;
  const values = sql.join(
    changed.map((entry) => sql`(${entry.id}::uuid, ${entry.position}::integer)`),
    sql`, `,
  );
  await tx.execute(sql`
    update ${wave} set position = v.position
    from (values ${values}) as v(id, position)
    where ${wave.id} = v.id`);
}

/** The waves of a milestone in order (position, then id). */
async function milestoneWaveRows(db: DbOrTx, milestoneId: string): Promise<WaveRow[]> {
  return db
    .select()
    .from(wave)
    .where(eq(wave.milestoneId, milestoneId))
    .orderBy(asc(wave.position), asc(wave.id));
}

/** `ids` with `id` moved to `position` (from 1, clamped to the list). */
function moveTo(ids: string[], id: string, position: number): string[] {
  const rest = ids.filter((other) => other !== id);
  const index = Math.min(Math.max(position, 1), rest.length + 1) - 1;
  return [...rest.slice(0, index), id, ...rest.slice(index)];
}

// ---------------------------------------------------------------------------
// Mapping
// ---------------------------------------------------------------------------

interface PlanTaskRow {
  id: string;
  number: number;
  keySuffix: string | null;
  title: string;
  status: TaskStatus;
  assigneeId: string | null;
  archivedAt: Date | null;
  waveId: string | null;
}

/**
 * The visible tasks of a milestone (or of one wave of it), archived ones included, in the order the
 * task list uses: status, priority highest first, last update newest first, id.
 */
async function planTaskRows(db: DbOrTx, milestoneId: string, waveId?: string): Promise<PlanTaskRow[]> {
  return db
    .select({
      id: task.id,
      number: task.number,
      keySuffix: task.keySuffix,
      title: task.title,
      status: task.status,
      assigneeId: task.assigneeId,
      archivedAt: task.archivedAt,
      waveId: task.waveId,
    })
    .from(task)
    .where(
      and(
        eq(task.milestoneId, milestoneId),
        isNull(task.hiddenAt),
        waveId ? eq(task.waveId, waveId) : undefined,
      ),
    )
    .orderBy(asc(task.status), desc(task.priority), desc(task.updatedAt), desc(task.id));
}

const CLOSED: ReadonlySet<TaskStatus> = new Set(['done', 'canceled']);

/** Builds the Wave shapes and the tasks in no wave from the states and the milestone's tasks. */
async function toWaves(
  db: DbOrTx,
  projectRow: ProjectRow,
  states: WaveState[],
  tasks: PlanTaskRow[],
): Promise<{ waves: Wave[]; notInWave: WaveTask[] }> {
  const users = await loadUsers(db, [
    ...tasks.flatMap((row) => (row.assigneeId ? [row.assigneeId] : [])),
    ...states.flatMap((state) =>
      state.result
        ? [state.result.actorId, ...(state.result.onBehalfOfId ? [state.result.onBehalfOfId] : [])]
        : [],
    ),
  ]);
  const ref = (id: string | null) => {
    const row = id ? users.get(id) : undefined;
    return row ? userRef(row) : null;
  };
  const keyOf = (row: PlanTaskRow) => formatTaskKey(projectRow.key, row.number, row.keySuffix);
  const waveTask = (row: PlanTaskRow): WaveTask => ({
    key: keyOf(row),
    title: row.title,
    status: row.status,
    assignee: ref(row.assigneeId),
    archived: row.archivedAt !== null,
  });
  const byWave = new Map<string, PlanTaskRow[]>();
  const notInWave: WaveTask[] = [];
  const known = new Set(states.map((state) => state.id));
  for (const row of tasks) {
    if (row.waveId && known.has(row.waveId)) {
      const list = byWave.get(row.waveId) ?? [];
      list.push(row);
      byWave.set(row.waveId, list);
    } else notInWave.push(waveTask(row));
  }
  const waves = states.map((state) => {
    const own = byWave.get(state.id) ?? [];
    const done = own.filter((row) => row.status === 'done').length;
    const canceled = own.filter((row) => row.status === 'canceled').length;
    const open = own.filter((row) => !CLOSED.has(row.status));
    const result = state.result;
    const recordedBy = result ? ref(result.actorId) : null;
    return Wave.parse({
      id: state.id,
      milestoneId: state.milestoneId,
      number: state.number,
      name: state.name,
      gate: {
        description: state.gateDescription,
        state: state.gateState,
        result: result
          ? {
              state: result.state,
              note: result.note,
              // restrict on user deletes keeps the recorder; Unknown only if that ever breaks.
              recordedBy: recordedBy ?? { id: result.actorId, name: 'Unknown', kind: 'person' },
              onBehalfOf: ref(result.onBehalfOfId),
              at: result.createdAt,
              source: entrySourceOf(result),
            }
          : null,
      },
      current: state.current,
      locked: state.locked,
      lockedUntil: state.lockedUntil,
      progress: { total: own.length, done, canceled, open: open.length },
      canPass: open.length === 0,
      openKeys: open.slice(0, MAX_WAVE_OPEN_KEYS).map(keyOf),
      tasks: own.map(waveTask),
    });
  });
  return { waves, notInWave };
}

/** The plan of a milestone the caller found (and may read). */
async function planOf(
  db: DbOrTx,
  projectRow: ProjectRow,
  milestoneRow: MilestoneRow,
  clock: ClockContext,
): Promise<MilestonePlan> {
  // Sequential: inside a transaction the queries share one connection.
  const states = await waveStates(db, [milestoneRow.id]);
  const tasks = await planTaskRows(db, milestoneRow.id);
  const { waves, notInWave } = await toWaves(db, projectRow, states.get(milestoneRow.id) ?? [], tasks);
  const withProgress = await toMilestoneWithProgress(db, projectRow, milestoneRow, clock, states);
  return MilestonePlan.parse({
    milestone: withProgress,
    planUrl: milestoneRow.planUrl,
    waves,
    notInWave,
  });
}

/** One wave as it is now. */
async function waveOf(
  db: DbOrTx,
  projectRow: ProjectRow,
  milestoneId: string,
  waveId: string,
): Promise<Wave> {
  const states = await waveStates(db, [milestoneId]);
  const state = (states.get(milestoneId) ?? []).find((entry) => entry.id === waveId);
  if (!state) throw new NotFound('Wave not found');
  const tasks = await planTaskRows(db, milestoneId, waveId);
  const { waves } = await toWaves(db, projectRow, [state], tasks);
  const [result] = waves;
  if (!result) throw new Error('wave mapping returned nothing');
  return result;
}

// ---------------------------------------------------------------------------
// Read
// ---------------------------------------------------------------------------

/**
 * GET /milestones/{id}/plan: the milestone with its progress and wave summary, the plan link, the
 * waves in order with their gates, locks, progress and tasks, and the tasks in no wave. Hidden
 * tasks are left out; archived ones show with their flag. NotFound outside the workspace,
 * Forbidden outside the key's scope.
 */
export async function getMilestonePlan(
  ctx: WaveContext,
  actor: Actor,
  input: z.input<typeof GetMilestonePlanInput>,
): Promise<MilestonePlan> {
  const { id } = parseInput(GetMilestonePlanInput, input);
  const found = await findMilestone(ctx.db, actor, id);
  return planOf(ctx.db, found.project, found.milestone, ctx);
}

// ---------------------------------------------------------------------------
// Write
// ---------------------------------------------------------------------------

/**
 * Adds a wave to a milestone, at the end or at `position` (the waves from there move down one; past
 * the end goes last). Conflict when the name is taken in the milestone, ignoring case.
 */
export async function createWave(
  ctx: WaveContext,
  actor: Actor,
  input: z.input<typeof CreateWaveInputSchema>,
): Promise<Wave> {
  const parsed: CreateWaveInput = parseInput(CreateWaveInputSchema, input);
  try {
    return await ctx.db.transaction(async (tx) => {
      const found = await findMilestone(tx, actor, parsed.milestone, { forUpdate: true });
      authorize(actor, 'task.write', { type: 'project', projectId: found.project.id });
      requireMilestones(found.project);
      const current = await milestoneWaveRows(tx, found.milestone.id);
      const [row] = await tx
        .insert(wave)
        .values({
          workspaceId: found.milestone.workspaceId,
          milestoneId: found.milestone.id,
          position: current.length + 1,
          name: parsed.name,
          gateDescription: parsed.gateDescription ?? null,
          createdById: actor.userId,
        })
        .returning();
      if (!row) throw new Error('wave insert returned no row');
      if (parsed.position !== undefined && parsed.position <= current.length) {
        const ids = moveTo([...current.map((entry) => entry.id), row.id], row.id, parsed.position);
        await writePositions(tx, [...current, row], ids);
      }
      return waveOf(tx, found.project, found.milestone.id, row.id);
    });
  } catch (error) {
    if (isUniqueViolation(error, WAVE_NAME_UNIQUE)) throw nameTaken(parsed.name);
    throw error;
  }
}

/**
 * Renames a wave, sets or clears (null) its gate description, or moves it to `position` (the
 * others renumber; past the end goes last). Conflict when the new name is taken.
 */
export async function updateWave(
  ctx: WaveContext,
  actor: Actor,
  input: z.input<typeof UpdateWaveInputSchema>,
): Promise<Wave> {
  const parsed: UpdateWaveInput = parseInput(UpdateWaveInputSchema, input);
  try {
    return await ctx.db.transaction(async (tx) => {
      const found = await findWave(tx, actor, parsed.id, { lockMilestone: true });
      authorize(actor, 'task.write', { type: 'project', projectId: found.project.id });
      requireMilestones(found.project);
      const set: Partial<typeof wave.$inferInsert> = {};
      if (parsed.name !== undefined && parsed.name !== found.wave.name) set.name = parsed.name;
      if (parsed.gateDescription !== undefined && parsed.gateDescription !== found.wave.gateDescription) {
        set.gateDescription = parsed.gateDescription;
      }
      if (Object.keys(set).length > 0) await tx.update(wave).set(set).where(eq(wave.id, found.wave.id));
      if (parsed.position !== undefined) {
        const current = await milestoneWaveRows(tx, found.milestone.id);
        const ids = moveTo(
          current.map((row) => row.id),
          found.wave.id,
          parsed.position,
        );
        await writePositions(tx, current, ids);
      }
      return waveOf(tx, found.project, found.milestone.id, found.wave.id);
    });
  } catch (error) {
    if (parsed.name && isUniqueViolation(error, WAVE_NAME_UNIQUE)) throw nameTaken(parsed.name);
    throw error;
  }
}

/**
 * Removes a wave with its gate results. Its tasks go to Not in a wave, each with a task.updated row
 * (wave to none), and the waves after it renumber.
 */
export async function deleteWave(
  ctx: WaveContext,
  actor: Actor,
  input: z.input<typeof DeleteWaveInput>,
): Promise<void> {
  const { id } = parseInput(DeleteWaveInput, input);
  await ctx.db.transaction(async (tx) => {
    const seen = await findWave(tx, actor, id);
    authorize(actor, 'task.write', { type: 'project', projectId: seen.project.id });
    requireMilestones(seen.project);
    // Lock order (lockMilestoneRow): the wave's tasks, then the milestone. A task put in the wave
    // meanwhile is still cleared below: the update re-reads wave_id once its row lock is free.
    const inWave = await tx.select({ id: task.id }).from(task).where(eq(task.waveId, seen.wave.id));
    await lockTaskRows(
      tx,
      inWave.map((row) => row.id),
    );
    const found = await findWave(tx, actor, id, { lockMilestone: true });
    const current = await milestoneWaveRows(tx, found.milestone.id);
    const number = current.findIndex((row) => row.id === found.wave.id) + 1;
    const cleared = await tx
      .update(task)
      .set({ waveId: null })
      .where(eq(task.waveId, found.wave.id))
      .returning({ id: task.id });
    await recordActivities(
      tx,
      actor,
      cleared.map((row) => ({
        projectId: found.project.id,
        taskId: row.id,
        type: 'task.updated' as const,
        changes: [
          {
            field: 'wave' as const,
            from: storedWaveRef({ id: found.wave.id, number, name: found.wave.name }),
            to: null,
          },
        ],
      })),
    );
    await tx.delete(wave).where(eq(wave.id, found.wave.id));
    const rest = current.filter((row) => row.id !== found.wave.id);
    await writePositions(
      tx,
      rest,
      rest.map((row) => row.id),
    );
  });
}

/**
 * Puts up to MAX_BULK_TASKS tasks of the milestone's project in a wave of the milestone, or takes
 * them out of their wave (wave null; every task must be in this milestone then). All or nothing.
 * A task of another milestone (or none) moves to this one in the same task.updated row as its
 * wave change; in a mirrored project that is refused with TaskMirrored (Backlog.md owns the
 * milestone), while a wave change within the milestone passes. Archived tasks fail the request
 * with TaskArchived, the issues naming each. Tasks already where they should be get no row.
 * Returns the plan as it is now.
 */
export async function putTasksInWave(
  ctx: TaskContext,
  actor: Actor,
  input: z.input<typeof PutTasksInWaveInputSchema>,
): Promise<MilestonePlan> {
  const parsed: PutTasksInWaveInput = parseInput(PutTasksInWaveInputSchema, input);
  return ctx.db.transaction(async (tx) => {
    // Lock order (lockMilestoneRow): the tasks, then the milestone, then the wave is checked, so a
    // removal of the wave queues ahead of or behind the whole put.
    const found = await findMilestone(tx, actor, parsed.milestone);
    authorize(actor, 'task.write', { type: 'project', projectId: found.project.id });
    requireMilestones(found.project);
    const checkWave = async () => {
      if (parsed.wave === null) return;
      const [target] = await tx
        .select({ id: wave.id })
        .from(wave)
        .where(and(eq(wave.id, parsed.wave), eq(wave.milestoneId, found.milestone.id)))
        .limit(1);
      if (!target) {
        const message = `The wave is not in ${found.milestone.name}`;
        throw new NotFound(message, { issues: [{ path: 'wave', message }] });
      }
    };
    await checkWave();

    const hits: { key: string; task: TaskRow }[] = [];
    for (const key of parsed.keys) {
      const hit = await findTask(tx, actor, key, { project: found.project.key });
      const taskKey = formatTaskKey(hit.project.key, hit.task.number, hit.task.keySuffix);
      if (hit.project.id !== found.project.id) {
        const message = `${taskKey} is not in project ${found.project.key}`;
        throw new Invalid(message, { issues: [{ path: `keys.${hits.length}`, message }] });
      }
      hits.push({ key: taskKey, task: hit.task });
    }
    if (parsed.wave === null) {
      const outside = hits.flatMap((hit, index) =>
        hit.task.milestoneId === found.milestone.id ? [] : [{ index, key: hit.key }],
      );
      const [first] = outside;
      if (first) {
        const message = (key: string) => `${key} is not in ${found.milestone.name}`;
        throw new Invalid(
          outside.length === 1
            ? message(first.key)
            : `${outside.map((e) => e.key).join(', ')} are not in ${found.milestone.name}`,
          {
            issues: outside.map((entry) => ({ path: `keys.${entry.index}`, message: message(entry.key) })),
          },
        );
      }
    }
    const archived = hits.flatMap((hit, index) => (hit.task.archivedAt ? [{ index, key: hit.key }] : []));
    const [firstArchived] = archived;
    if (firstArchived) {
      throw new TaskArchived(
        archived.length === 1
          ? taskArchived(firstArchived.key).message
          : `${archived.map((entry) => entry.key).join(', ')} are archived, so no task changed. Restore them first.`,
        {
          issues: archived.map((entry) => ({
            path: `keys.${entry.index}`,
            message: taskArchived(entry.key).message,
          })),
        },
      );
    }

    // Tasks in id order, like bulk changes, then the milestone; the wave may be gone by then.
    const locked = await lockTaskRows(
      tx,
      hits.map((hit) => hit.task.id),
    );
    await lockMilestoneRow(tx, found.milestone.id);
    await checkWave();
    const byId = new Map(locked.map((row) => [row.id, row]));
    for (const hit of hits) {
      const current = byId.get(hit.task.id);
      if (!current) throw new NotFound(`Task ${hit.key} not found`);
      const row = await applyTaskPatch(tx, ctx, actor, found.project, current, { wave: parsed.wave });
      byId.set(row.id, row);
    }
    const [milestoneRow] = await tx.select().from(milestone).where(eq(milestone.id, found.milestone.id));
    return planOf(tx, found.project, milestoneRow ?? found.milestone, ctx);
  });
}

/**
 * Records a result on a wave's gate: passed or failed, with the note, the actor, the person an
 * agent acts for, and the machine and branch the CLI sent (as activity rows record them). A pass
 * while a visible task of the wave is neither Done nor Canceled fails with GateTasksOpen and the
 * open keys; a fail is accepted at any time and changes no task. Returns the wave.
 */
export async function recordGateResult(
  ctx: WaveContext,
  actor: Actor,
  input: z.input<typeof RecordGateInputSchema>,
): Promise<Wave> {
  const parsed: RecordGateInput = parseInput(RecordGateInputSchema, input);
  return ctx.db.transaction(async (tx) => {
    const found = await findWave(tx, actor, parsed.id, { lockMilestone: true });
    authorize(actor, 'task.write', { type: 'project', projectId: found.project.id });
    requireMilestones(found.project);
    if (parsed.state === 'passed') {
      const open = (await planTaskRows(tx, found.milestone.id, found.wave.id)).filter(
        (row) => !CLOSED.has(row.status),
      );
      if (open.length > 0) {
        const keys = open
          .map((row) => formatTaskKey(found.project.key, row.number, row.keySuffix))
          .slice(0, MAX_WAVE_OPEN_KEYS);
        const number = (await milestoneWaveRows(tx, found.milestone.id)).findIndex(
          (row) => row.id === found.wave.id,
        );
        const shown =
          keys.length < open.length
            ? `${keys.join(', ')} and ${open.length - keys.length} more`
            : keys.join(', ');
        throw new GateTasksOpen(
          `${formatWaveNumber(number + 1)} · ${found.wave.name} has ${open.length === 1 ? '1 open task' : `${open.length} open tasks`}: ${shown}. Finish or cancel ${open.length === 1 ? 'it' : 'them'} before passing its gate.`,
          keys,
        );
      }
    }
    await tx.insert(gateResult).values({
      workspaceId: found.wave.workspaceId,
      waveId: found.wave.id,
      state: parsed.state,
      note: parsed.note,
      actorId: actor.userId,
      onBehalfOfId: actor.onBehalfOfId,
      // M6: what the CLI sent (x-zamu-machine, x-zamu-branch); the web app sends neither.
      machine: actor.source?.machine ?? null,
      branch: actor.source?.branch ?? null,
    });
    return waveOf(tx, found.project, found.milestone.id, found.wave.id);
  });
}
