// Activity: one row per task change, written in the transaction of the change. M3 adds the
// origin (app or a Backlog.md refresh), the commit a refresh read, and project-level rows. M5 adds
// labels, dueDate, blockedBy and parent changes. M6 adds the work record changes (criteria, done
// items, plan, final summary) and the machine and branch the CLI sent with the change. M7 adds the
// cause of system changes (a request event, the archive job), origin git, the system actor a
// history line names, and the work branch, check-again and pull request changes.
import {
  type Activity,
  ActivityCause,
  type ActivityChange,
  ActivityList,
  type ActivityOrigin,
  type ActivitySystemActor,
  type EntrySource,
  formatTaskKey,
  ListTaskActivityInput,
  type Priority,
  ProjectActivity,
  ProjectActivityDetails,
  type ProjectActivityType,
  type TaskActivityType,
  type TaskStatus,
  WORK_RECORD_CHANGE_FIELDS,
} from '@zamu/contracts';
import { type DbOrTx, schema, type Tx } from '@zamu/db';
import { and, asc, eq, inArray, isNull, sql } from 'drizzle-orm';
import { z } from 'zod';
import type { Actor } from './authz';
import type { DbContext } from './context';
import { parseInput } from './errors';
import { findTask, loadUsers, userRef } from './internal';

/**
 * M5: a label inside a stored change: its id and the name it had when the change was recorded.
 * Reads keep that name (renames don't rewrite history) and add the label's current colour.
 */
export interface StoredLabelRef {
  id: string;
  name: string;
}

/**
 * M5: a task inside a stored change (blockers, parent): its id with the key and title it had then.
 * Reads return the current key and title while the task exists, and mark it removed once it is
 * deleted or hidden.
 */
export interface StoredTaskRef {
  id: string;
  key: string;
  title: string;
}

/**
 * A change as stored in activity.changes: priority by name; assignee, milestone and cycle by id.
 * listTaskActivity resolves the ids to references.
 *
 * M3: `backlog` lists the Backlog.md-only fields a refresh changed (BacklogBlock keys such as
 * references, and createdAt); reads return them as Activity.backlogFields. Write at most one per
 * row.
 *
 * M5: labels and blockedBy store the whole list before and after (labels sorted by name, ignoring
 * case; blockers by key, see compareTaskRefs); dueDate stores YYYY-MM-DD; parent a task reference.
 * task.created rows start from [] and null.
 */
export type StoredChange =
  | { field: 'title' | 'description'; from: string | null; to: string | null }
  | { field: 'status'; from: TaskStatus | null; to: TaskStatus | null }
  | { field: 'priority'; from: Priority | null; to: Priority | null }
  | { field: 'assignee' | 'milestone' | 'cycle'; from: string | null; to: string | null }
  | { field: 'backlog'; from: null; to: string[] }
  | { field: 'labels'; from: StoredLabelRef[]; to: StoredLabelRef[] }
  | { field: 'dueDate'; from: string | null; to: string | null }
  | { field: 'blockedBy'; from: StoredTaskRef[]; to: StoredTaskRef[] }
  | { field: 'parent'; from: StoredTaskRef | null; to: StoredTaskRef | null }
  | StoredWorkRecordChange
  | StoredM7Change;

/**
 * M7: the work branch, the check-again day and a request linked or unlinked. Stored in the
 * contract's shape: they hold text, days and request references, nothing to resolve.
 */
export type StoredM7Change = Extract<ActivityChange, { field: (typeof M7_CHANGE_FIELDS)[number] }>;

/** M7 change kinds, stored and returned as they are. */
export const M7_CHANGE_FIELDS = ['workBranch', 'checkAgain', 'pullRequest'] as const;

/**
 * M6: a change of a criterion or done item (criterion.checked, doneItem.waived, ...) or of the plan
 * or final summary. Stored in the contract's shape: they hold numbers and text, nothing to resolve.
 */
export type StoredWorkRecordChange = Extract<
  ActivityChange,
  { field: (typeof WORK_RECORD_CHANGE_FIELDS)[number] }
>;

/** Fields of StoredChange that map to an ActivityChange of the contract. */
const CONTRACT_FIELDS = new Set<string>([
  'title',
  'description',
  'status',
  'priority',
  'assignee',
  'milestone',
  'cycle',
  'labels',
  'dueDate',
  'blockedBy',
  'parent',
  ...WORK_RECORD_CHANGE_FIELDS,
  ...M7_CHANGE_FIELDS,
]);

/** Orders labels as stored changes and task shapes list them: by name ignoring case, then by name. */
export function compareLabelNames(a: { name: string }, b: { name: string }): number {
  const folded = a.name.toLowerCase().localeCompare(b.name.toLowerCase());
  return folded !== 0 ? folded : a.name.localeCompare(b.name);
}

/** Orders task references by key: project key, then number, then suffix part by part (PAY-9 < PAY-10). */
export function compareTaskKeys(a: string, b: string): number {
  const split = (key: string) => {
    const dash = key.lastIndexOf('-');
    return {
      project: key.slice(0, dash),
      parts: key
        .slice(dash + 1)
        .split('.')
        .map(Number),
    };
  };
  const left = split(a);
  const right = split(b);
  if (left.project !== right.project) return left.project < right.project ? -1 : 1;
  const length = Math.max(left.parts.length, right.parts.length);
  for (let i = 0; i < length; i++) {
    const x = left.parts[i] ?? -1;
    const y = right.parts[i] ?? -1;
    if (x !== y) return x - y;
  }
  return 0;
}

/**
 * Where a row comes from. Defaults to the app; a Backlog.md refresh passes its commit, and (M7) a
 * request event passes origin git with the request URL.
 */
export interface ActivityOriginFields {
  /**
   * Default app. backlog rows must be written with a null actor (the Backlog.md actor); so must
   * git rows (M7: the host of a request event).
   */
  origin?: ActivityOrigin;
  /** The commit a Backlog.md refresh read, or (M7) the request URL of a git row. */
  originRef?: string | null;
  /** M7: why the system made the change: a request event or the archive job. */
  cause?: ActivityCause | null;
}

export interface ActivityEntry extends ActivityOriginFields {
  projectId: string;
  taskId: string;
  type: TaskActivityType;
  changes: StoredChange[];
}

/**
 * A system entry has no actor (the hourly cycle job, a Backlog.md refresh, M7: a request event or
 * the archive job), so it names its workspace.
 */
export interface SystemActivityEntry extends ActivityEntry {
  workspaceId: string;
}

/** M3: a project-level entry (no task): project.backlog_imported, project.backlog_detached. */
export interface ProjectActivityEntry extends ActivityOriginFields {
  projectId: string;
  type: ProjectActivityType;
  details: z.input<typeof ProjectActivityDetails>;
}

export interface SystemProjectActivityEntry extends ProjectActivityEntry {
  workspaceId: string;
}

type AnyEntry = ActivityEntry | ProjectActivityEntry;
type AnySystemEntry = SystemActivityEntry | SystemProjectActivityEntry;

export type ActivityRow = typeof schema.activity.$inferSelect;

/** Project details are stored as one change per field, like task changes: { field, from: null, to }. */
const DETAIL_FIELDS = ['mode', 'repository', 'tasks', 'milestones'] as const;

function detailsToChanges(details: z.input<typeof ProjectActivityDetails>) {
  const parsed = ProjectActivityDetails.parse(details);
  return DETAIL_FIELDS.filter((field) => parsed[field] !== null).map((field) => ({
    field,
    from: null,
    to: parsed[field],
  }));
}

function changesToDetails(changes: ActivityRow['changes']): ProjectActivityDetails {
  const values: Record<string, unknown> = {};
  for (const change of changes) {
    if ((DETAIL_FIELDS as readonly string[]).includes(change.field)) values[change.field] = change.to;
  }
  const parsed = ProjectActivityDetails.safeParse(values);
  return parsed.success ? parsed.data : ProjectActivityDetails.parse({});
}

function activityValues(actor: Actor | null, entry: AnyEntry | AnySystemEntry) {
  const workspaceId = actor ? actor.workspaceId : (entry as AnySystemEntry).workspaceId;
  if (!workspaceId) throw new Error('A system activity entry needs its workspaceId');
  const origin = entry.origin ?? 'app';
  if (origin === 'backlog' && actor) {
    throw new Error('Backlog.md activity is written without an actor (the Backlog.md actor)');
  }
  if (origin === 'git' && actor) {
    throw new Error('Git host activity is written without an actor (the host)');
  }
  const cause = entry.cause ? ActivityCause.parse(entry.cause) : null;
  const isProject = 'details' in entry;
  return {
    workspaceId,
    projectId: entry.projectId,
    taskId: isProject ? null : entry.taskId,
    actorId: actor?.userId ?? null,
    onBehalfOfId: actor?.onBehalfOfId ?? null,
    type: entry.type,
    changes: isProject ? detailsToChanges(entry.details) : entry.changes,
    origin,
    originRef: entry.originRef ?? null,
    // M6: what the CLI sent (x-zamu-machine, x-zamu-branch); the web app and jobs send neither.
    machine: actor?.source?.machine ?? null,
    branch: actor?.source?.branch ?? null,
    cause,
  };
}

/**
 * M7: who a history line names when the row has no actor: the git host of a request event (origin
 * git, the provider from the cause), Backlog.md (origin backlog), or Zamu's own jobs (origin app:
 * the hourly cycle job, the archive job). Null when a person or an agent acted.
 */
export function systemActorOf(
  row: Pick<ActivityRow, 'actorId' | 'origin'> & { cause?: ActivityRow['cause'] },
): ActivitySystemActor | null {
  if (row.actorId) return null;
  if (row.origin === 'backlog') return { kind: 'backlog' };
  if (row.origin === 'git') {
    const cause = ActivityCause.safeParse(row.cause ?? null);
    if (cause.success && cause.data.kind === 'pull_request')
      return { kind: 'git', provider: cause.data.provider };
    // A git row always has a request cause; an unreadable one still names a host.
    return { kind: 'git', provider: 'github' };
  }
  return { kind: 'zamu' };
}

/** M7: a stored cause as the contract reads it; null when none or unreadable. */
export function causeOf(row: { cause?: ActivityRow['cause'] }): ActivityCause | null {
  const parsed = ActivityCause.safeParse(row.cause ?? null);
  return parsed.success ? parsed.data : null;
}

/**
 * M6: the source of an activity row or comment: null when neither machine nor branch was sent.
 * Rows selected without the two columns (some home and dashboard reads) read as null too.
 */
export function entrySourceOf(row: { machine?: string | null; branch?: string | null }): EntrySource | null {
  const machine = row.machine ?? null;
  const branch = row.branch ?? null;
  return machine === null && branch === null ? null : { machine, branch };
}

/**
 * Writes an activity row as `actor` (and the responsible human for agents), or as the system
 * when `actor` is null (the hourly cycle job; a Backlog.md refresh with origin backlog). Call
 * inside the change's transaction.
 */
export async function recordActivity(tx: Tx, actor: Actor, entry: AnyEntry): Promise<void>;
export async function recordActivity(tx: Tx, actor: null, entry: AnySystemEntry): Promise<void>;
export async function recordActivity(
  tx: Tx,
  actor: Actor | null,
  entry: AnyEntry | AnySystemEntry,
): Promise<void> {
  await tx.insert(schema.activity).values(activityValues(actor, entry));
}

/** Writes several activity rows in one insert, e.g. one cycle.ended row per task moved. */
export async function recordActivities(tx: Tx, actor: Actor, entries: AnyEntry[]): Promise<void>;
export async function recordActivities(tx: Tx, actor: null, entries: AnySystemEntry[]): Promise<void>;
export async function recordActivities(
  tx: Tx,
  actor: Actor | null,
  entries: (AnyEntry | AnySystemEntry)[],
): Promise<void> {
  if (entries.length === 0) return;
  await tx.insert(schema.activity).values(entries.map((entry) => activityValues(actor, entry)));
}

/** Name shown for a milestone that was deleted after the change was recorded. */
export const DELETED_MILESTONE_NAME = 'Deleted milestone';

/** M5: current colours of the labels in `ids` (deleted ones are left out). */
async function labelColors(db: DbOrTx, ids: Set<string>): Promise<Map<string, number>> {
  if (ids.size === 0) return new Map();
  const rows = await db
    .select({ id: schema.label.id, color: schema.label.color })
    .from(schema.label)
    .where(inArray(schema.label.id, [...ids]));
  return new Map(rows.map((row) => [row.id, row.color]));
}

/** M5: current key, title and visibility of the tasks in `ids` (deleted ones are left out). */
async function currentTaskRefs(
  db: DbOrTx,
  ids: Set<string>,
): Promise<Map<string, { key: string; title: string; hidden: boolean }>> {
  if (ids.size === 0) return new Map();
  const rows = await db
    .select({
      id: schema.task.id,
      projectKey: schema.project.key,
      number: schema.task.number,
      keySuffix: schema.task.keySuffix,
      title: schema.task.title,
      hidden: sql<boolean>`${schema.task.hiddenAt} is not null`,
    })
    .from(schema.task)
    .innerJoin(schema.project, eq(schema.project.id, schema.task.projectId))
    .where(inArray(schema.task.id, [...ids]));
  return new Map(
    rows.map((row) => [
      row.id,
      { key: formatTaskKey(row.projectKey, row.number, row.keySuffix), title: row.title, hidden: row.hidden },
    ]),
  );
}

/** Actor and on-behalf-of references of activity rows, resolved in one query. */
async function loadActors(db: DbOrTx, rows: ActivityRow[], extraUserIds: Iterable<string> = []) {
  const userIds = new Set<string>(extraUserIds);
  for (const row of rows) {
    if (row.actorId) userIds.add(row.actorId);
    if (row.onBehalfOfId) userIds.add(row.onBehalfOfId);
  }
  const users = await loadUsers(db, userIds);
  const user = (id: string | null) => {
    const row = id ? users.get(id) : undefined;
    return row ? userRef(row) : null;
  };
  // A null actor_id is the system or Backlog.md; a missing user (should not happen: restrict) stays visible.
  const actor = (id: string | null) =>
    id ? (user(id) ?? { id, name: 'Unknown', kind: 'person' as const }) : null;
  return { user, actor };
}

/**
 * Maps activity rows of one task to the contract shape, resolving user, milestone and cycle ids
 * in three queries. Rows keep their order. Shared with the timeline.
 */
export async function toActivities(db: DbOrTx, taskKey: string, rows: ActivityRow[]): Promise<Activity[]> {
  const userIds = new Set<string>();
  const milestoneIds = new Set<string>();
  const cycleIds = new Set<string>();
  const labelIds = new Set<string>();
  const taskIds = new Set<string>();
  for (const row of rows) {
    for (const change of row.changes as StoredChange[]) {
      switch (change.field) {
        case 'labels':
          for (const ref of [...(change.from ?? []), ...(change.to ?? [])]) labelIds.add(ref.id);
          continue;
        case 'blockedBy':
          for (const ref of [...(change.from ?? []), ...(change.to ?? [])]) taskIds.add(ref.id);
          continue;
        case 'parent':
          if (change.from) taskIds.add(change.from.id);
          if (change.to) taskIds.add(change.to.id);
          continue;
        case 'assignee':
        case 'milestone':
        case 'cycle': {
          const ids =
            change.field === 'assignee' ? userIds : change.field === 'milestone' ? milestoneIds : cycleIds;
          if (change.from) ids.add(change.from);
          if (change.to) ids.add(change.to);
          continue;
        }
        default:
          continue;
      }
    }
  }

  // Sequential: `db` may be a transaction, whose queries share one connection.
  const colors = await labelColors(db, labelIds);
  const tasks = await currentTaskRefs(db, taskIds);
  const [{ user, actor }, milestones, cycles] = await Promise.all([
    loadActors(db, rows, userIds),
    milestoneIds.size === 0
      ? []
      : db
          .select({ id: schema.milestone.id, name: schema.milestone.name })
          .from(schema.milestone)
          .where(inArray(schema.milestone.id, [...milestoneIds])),
    cycleIds.size === 0
      ? []
      : db
          .select({ id: schema.cycle.id, number: schema.cycle.number, name: schema.cycle.name })
          .from(schema.cycle)
          .where(inArray(schema.cycle.id, [...cycleIds])),
  ]);
  const milestoneById = new Map(milestones.map((row) => [row.id, row]));
  const cycleById = new Map(cycles.map((row) => [row.id, row]));

  const milestone = (id: string | null) =>
    id ? (milestoneById.get(id) ?? { id, name: DELETED_MILESTONE_NAME }) : null;
  // Cycles are never deleted on their own (only with their project, which takes the task along).
  const cycle = (id: string | null) => (id ? (cycleById.get(id) ?? null) : null);
  const label = (ref: StoredLabelRef) => ({ id: ref.id, name: ref.name, color: colors.get(ref.id) ?? null });
  const taskRef = (ref: StoredTaskRef) => {
    const now = tasks.get(ref.id);
    return now
      ? { key: now.key, title: now.title, removed: now.hidden }
      : { key: ref.key, title: ref.title, removed: true };
  };

  const resolve = (change: StoredChange): z.input<typeof ActivityChange> => {
    switch (change.field) {
      case 'assignee':
        return { field: 'assignee', from: user(change.from), to: user(change.to) };
      case 'milestone':
        return { field: 'milestone', from: milestone(change.from), to: milestone(change.to) };
      case 'cycle':
        return { field: 'cycle', from: cycle(change.from), to: cycle(change.to) };
      case 'labels':
        return { field: 'labels', from: (change.from ?? []).map(label), to: (change.to ?? []).map(label) };
      case 'blockedBy':
        return {
          field: 'blockedBy',
          from: (change.from ?? []).map(taskRef),
          to: (change.to ?? []).map(taskRef),
        };
      case 'parent':
        return {
          field: 'parent',
          from: change.from ? taskRef(change.from) : null,
          to: change.to ? taskRef(change.to) : null,
        };
      default:
        return change as z.input<typeof ActivityChange>;
    }
  };

  return ActivityList.parse({
    items: rows.map((row): z.input<typeof Activity> => {
      const changes = row.changes as StoredChange[];
      return {
        id: row.id,
        type: row.type,
        taskKey,
        actor: actor(row.actorId),
        onBehalfOf: user(row.onBehalfOfId),
        changes: changes.filter((change) => CONTRACT_FIELDS.has(change.field)).map(resolve),
        origin: row.origin,
        originRef: row.originRef,
        backlogFields: changes.flatMap((change) =>
          change.field === 'backlog' && Array.isArray(change.to) ? change.to.map(String) : [],
        ),
        source: entrySourceOf(row),
        cause: causeOf(row),
        system: systemActorOf(row),
        createdAt: row.createdAt,
      };
    }),
  }).items;
}

/** Maps project-level activity rows to the contract shape. Rows keep their order. */
export async function toProjectActivities(db: DbOrTx, rows: ActivityRow[]): Promise<ProjectActivity[]> {
  const { user, actor } = await loadActors(db, rows);
  return z.array(ProjectActivity).parse(
    rows.map(
      (row): z.input<typeof ProjectActivity> => ({
        id: row.id,
        type: row.type as ProjectActivityType,
        actor: actor(row.actorId),
        onBehalfOf: user(row.onBehalfOfId),
        origin: row.origin,
        originRef: row.originRef,
        details: changesToDetails(row.changes),
        createdAt: row.createdAt,
      }),
    ),
  );
}

/** The activity rows of a task, oldest first (ties by id). */
export async function loadTaskActivityRows(db: DbOrTx, taskId: string): Promise<ActivityRow[]> {
  return db
    .select()
    .from(schema.activity)
    .where(eq(schema.activity.taskId, taskId))
    .orderBy(asc(schema.activity.createdAt), asc(schema.activity.id));
}

/** The project-level rows of a project (no task), oldest first (ties by id). */
export async function loadProjectActivityRows(db: DbOrTx, projectId: string): Promise<ActivityRow[]> {
  return db
    .select()
    .from(schema.activity)
    .where(and(eq(schema.activity.projectId, projectId), isNull(schema.activity.taskId)))
    .orderBy(asc(schema.activity.createdAt), asc(schema.activity.id));
}

/**
 * The activity of a task, oldest first, with user, milestone and cycle ids resolved to references,
 * labels to their recorded name and current colour, and blockers and parents to their current key.
 */
export async function listTaskActivity(
  { db }: DbContext,
  actor: Actor,
  input: z.input<typeof ListTaskActivityInput>,
): Promise<ActivityList> {
  const { key, project: narrow } = parseInput(ListTaskActivityInput, input);
  const { project, task } = await findTask(db, actor, key, { project: narrow });
  const rows = await loadTaskActivityRows(db, task.id);
  return { items: await toActivities(db, formatTaskKey(project.key, task.number, task.keySuffix), rows) };
}
