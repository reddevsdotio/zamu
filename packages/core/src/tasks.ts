// Tasks: list, get by key, create, update. Every write records activity in the same transaction.
// M3: tasks of a project mirrored from Backlog.md carry their Backlog.md block, keep the fields
// Backlog.md owns locked (TASK_MIRRORED), and hide while their file is gone from the default branch.
// M5: labels, due dates, blockers and parents (see labels.ts and relations.ts for their rules),
// list filters and orderings over them, and bulk changes of native tasks.
// M6: the work record (criteria and done items in criteria.ts, plan and final summary on the row),
// the project's default done items on create, the ifStatus precondition, and the finishing rule.
import {
  ASSIGNEE_AGENTS,
  ASSIGNEE_ME,
  BacklogBlock,
  type BacklogTaskLink,
  BulkUpdateTasksInput,
  CalendarDate,
  CreateTaskInput,
  type CycleSelector,
  DEFAULT_TASK_PRIORITY,
  DEFAULT_TASK_STATUS,
  DUE_SOON_DAYS,
  FILTER_NONE,
  formatBacklogId,
  formatTaskKey,
  GetTaskInput,
  ListTasksInput,
  MAX_TASK_LABELS,
  MAX_WORK_ITEMS,
  OPEN_TASK_STATUSES,
  type Priority,
  parseBacklogId,
  parseRepositoryUrl,
  parseTaskKey,
  priorityFromValue,
  priorityToValue,
  TASK_OWNED_FIELDS,
  TASK_SORTS,
  TASK_STATUS_LABELS,
  TASK_STATUSES,
  Task,
  type TaskBacklog,
  TaskBulkResult,
  type TaskListItem,
  TaskListPage,
  type TaskOwnedField,
  type TaskPosition,
  type TaskSort,
  type TaskStatus,
  UpdateTaskInput,
  type WorkItemKind,
  type WorkTextMeta,
} from '@zamu/contracts';
import { type DbOrTx, schema, type Tx } from '@zamu/db';
import { createProvider, hostnameOf } from '@zamu/git-providers';
import {
  and,
  asc,
  desc,
  eq,
  getTableColumns,
  ilike,
  inArray,
  isNotNull,
  isNull,
  ne,
  or,
  type SQL,
  sql,
} from 'drizzle-orm';
import { z } from 'zod';
import {
  compareLabelNames,
  compareTaskKeys,
  recordActivity,
  type StoredChange,
  type StoredLabelRef,
  type StoredTaskRef,
} from './activity';
import { type Actor, authorize } from './authz';
import type { DbContext, GitContext } from './context';
import {
  FINISHING_STATUSES,
  finishingRuleApplies,
  hasItemOperations,
  type ItemOperations,
  type ItemPlan,
  itemOperationsOf,
  itemsOfKind,
  loadTaskItemRows,
  OpenItems,
  openItemsByTask,
  openItemsError,
  openItemsOf,
  planItemOperations,
  progressFor,
  type TaskItemRow,
  toWorkItems,
  WORK_ITEM_LIST_KINDS,
  workItemProgressOf,
  writeItemPlan,
} from './criteria';
import {
  addCalendarDays,
  type ClockContext,
  type CycleRow,
  cycleStateOn,
  resolveCycleSelector,
  todayIn,
} from './cycles';
import { Invalid, NotFound, ProjectMirrored, parseInput, TaskChanged, TaskMirrored } from './errors';
import {
  type BacklogSourceRow,
  backlogEditCommand,
  backlogFilePath,
  findProjectByKey,
  findTask,
  loadBacklogSource,
  loadUsers,
  type MilestoneRow,
  mirroredProjectIds,
  type ProjectRow,
  readableProjects,
  shellWord,
  sourceIsActive,
  sourceMirrors,
  type TaskRow,
  type UserRow,
  userRef,
  workspaceMember,
} from './internal';
import { findOrCreateLabels, type LabelRow, labelsOfTasks, loadTaskLabelRows, setTaskLabels } from './labels';
import { activateMilestoneForTask } from './milestones';
import {
  assertNoDependencyLoop,
  assertParentAllowed,
  blockedTaskIds,
  deleteBlockers,
  hasOpenBlockerSql,
  insertBlockers,
  loadBlockers,
  loadTaskRelations,
  NotSameProject,
  type ProjectTask,
  resolveProjectTasks,
  storedTaskRef,
  subtaskProgressOf,
  taskKeysById,
} from './relations';

const { activity, comment, cycle, gitConnection, milestone, project, task, taskLabel, user } = schema;
type TaskInsert = typeof task.$inferInsert;

/**
 * Context of the task services: the database plus the optional clock that dates cycles, and the
 * git host settings that decide whether file links use http (GIT_HTTP_HOSTS).
 */
export type TaskContext = DbContext & ClockContext & Pick<GitContext, 'gitHosts'>;

/** What mapping a task needs besides its row: today (cycle states) and the git host settings. */
interface TaskView {
  today: string;
  gitHosts?: GitContext['gitHosts'];
}

function viewOf(ctx: TaskContext): TaskView {
  return { today: todayIn(ctx), gitHosts: ctx.gitHosts };
}

/** The locked fields of a task in a project that does (true) or does not mirror Backlog.md. */
function lockedFields(mirrored: boolean): TaskOwnedField[] {
  return mirrored ? [...TASK_OWNED_FIELDS] : [];
}

/** Statuses that count as started: moving a task into one activates its milestone. */
const STARTED_STATUSES: ReadonlySet<TaskStatus> = new Set(['in_progress', 'in_review']);

/** Below this gap between two neighbouring ranks, a board column is renumbered 1..n. */
export const MIN_RANK_GAP = 1e-9;

// ---------------------------------------------------------------------------
// Mapping rows to contract shapes
// ---------------------------------------------------------------------------

function assigneeRef(id: string | null, users: Map<string, UserRow>) {
  if (!id) return null;
  const row = users.get(id);
  if (!row) return null;
  const responsible = row.responsibleUserId ? users.get(row.responsibleUserId) : undefined;
  return { ...userRef(row), responsible: responsible ? userRef(responsible) : null };
}

/** Loads the users with `ids`, plus the responsible humans of the agents among them. */
async function usersFor(db: DbOrTx, ids: (string | null)[]) {
  const users = await loadUsers(
    db,
    ids.filter((id): id is string => id !== null),
  );
  const responsibleIds = [...users.values()]
    .map((row) => row.responsibleUserId)
    .filter((id): id is string => id !== null && !users.has(id));
  for (const [id, row] of await loadUsers(db, responsibleIds)) users.set(id, row);
  return users;
}

function requireUser(users: Map<string, UserRow>, id: string) {
  const row = users.get(id);
  if (!row) throw new Error(`user ${id} referenced by a task does not exist`);
  return userRef(row);
}

type PlanningRow = Pick<TaskRow, 'milestoneId' | 'cycleId'>;

/** Milestone and cycle references of `rows`, in two queries. Cycle states are derived for `today`. */
async function planningRefs(db: DbOrTx, rows: PlanningRow[], today: string) {
  const milestoneIds = [...new Set(rows.map((row) => row.milestoneId).filter((id) => id !== null))];
  const cycleIds = [...new Set(rows.map((row) => row.cycleId).filter((id) => id !== null))];
  // Sequential: inside a transaction both queries share one connection.
  const milestones =
    milestoneIds.length === 0
      ? []
      : await db
          .select({
            id: milestone.id,
            name: milestone.name,
            status: milestone.status,
            targetDate: milestone.targetDate,
          })
          .from(milestone)
          .where(inArray(milestone.id, milestoneIds));
  const cycles =
    cycleIds.length === 0
      ? []
      : await db
          .select({
            id: cycle.id,
            number: cycle.number,
            name: cycle.name,
            startsOn: cycle.startsOn,
            endsOn: cycle.endsOn,
            completedAt: cycle.completedAt,
          })
          .from(cycle)
          .where(inArray(cycle.id, cycleIds));
  const milestoneById = new Map(milestones.map((row) => [row.id, row]));
  const cycleById = new Map(
    cycles.map(({ completedAt, ...row }) => [
      row.id,
      { ...row, state: cycleStateOn({ ...row, completedAt }, today) },
    ]),
  );
  return {
    milestone: (row: PlanningRow) => (row.milestoneId ? (milestoneById.get(row.milestoneId) ?? null) : null),
    cycle: (row: PlanningRow) => (row.cycleId ? (cycleById.get(row.cycleId) ?? null) : null),
  };
}

/** A Backlog.md id in canonical form (BACK-12), or the value upper-cased when it is not one. */
function canonicalBacklogId(value: string): string {
  const parts = parseBacklogId(value);
  return parts ? formatBacklogId(parts) : value.trim().toUpperCase();
}

/** Web page of a Backlog.md file on the provider, or null when the source cannot say. */
async function backlogFileUrl(
  db: DbOrTx,
  projectRow: ProjectRow,
  source: BacklogSourceRow,
  file: string,
  gitHosts: TaskView['gitHosts'],
): Promise<string | null> {
  if (!source.connectionId || !source.defaultBranch || !projectRow.repository) return null;
  const repository = parseRepositoryUrl(projectRow.repository);
  if (!repository) return null;
  const [connection] = await db
    .select({ provider: gitConnection.provider, host: gitConnection.host })
    .from(gitConnection)
    .where(eq(gitConnection.id, source.connectionId))
    .limit(1);
  if (!connection) return null;
  const hostname = hostnameOf(connection.host);
  const allowHttp = (gitHosts?.httpHosts ?? []).some((host) => host === connection.host || host === hostname);
  try {
    // No token: fileUrl only builds a link and never calls the provider.
    const provider = createProvider({
      provider: connection.provider,
      host: connection.host,
      token: '',
      allowHttp,
    });
    return provider.fileUrl(repository.path, source.defaultBranch, file);
  } catch {
    return null;
  }
}

/**
 * The Backlog.md origin of a task as task shapes carry it: the block with dependencies, parent and
 * subtasks resolved to tasks of the same project and assignee values to members, plus the file
 * it was last read from (null once the file is gone or after detach).
 */
async function taskBacklog(
  db: DbOrTx,
  projectRow: ProjectRow,
  row: TaskRow & { backlogId: string },
  source: BacklogSourceRow | null,
  gitHosts: TaskView['gitHosts'],
): Promise<z.input<typeof TaskBacklog>> {
  const parsed = BacklogBlock.safeParse(row.backlogData ?? {});
  const block = parsed.success ? parsed.data : BacklogBlock.parse({});
  const linkIds = [
    ...new Set(
      [...block.dependencies, ...(block.parentId ? [block.parentId] : []), ...block.subtasks].map(
        canonicalBacklogId,
      ),
    ),
  ];
  const linked =
    linkIds.length === 0
      ? []
      : await db
          .select({
            backlogId: task.backlogId,
            number: task.number,
            keySuffix: task.keySuffix,
            title: task.title,
            status: task.status,
            hiddenAt: task.hiddenAt,
          })
          .from(task)
          .where(and(eq(task.projectId, projectRow.id), inArray(task.backlogId, linkIds)))
          // Visible tasks win when an id is (briefly) on two tasks.
          .orderBy(sql`${task.hiddenAt} is not null`, asc(task.id));
  const byId = new Map<string, (typeof linked)[number]>();
  for (const item of linked) if (item.backlogId && !byId.has(item.backlogId)) byId.set(item.backlogId, item);
  const link = (id: string): BacklogTaskLink => {
    const found = byId.get(canonicalBacklogId(id));
    return {
      id,
      task: found
        ? {
            key: formatTaskKey(projectRow.key, found.number, found.keySuffix),
            title: found.title,
            status: found.status,
            hidden: found.hiddenAt !== null,
          }
        : null,
    };
  };
  const users = await loadUsers(
    db,
    block.assignees.flatMap((value) => (value.userId ? [value.userId] : [])),
  );
  // Detach keeps the backlog_file rows, so a detached task still links to the file it came from.
  const file = source ? await backlogFilePath(db, source, { taskId: row.id }) : null;
  const fileUrl = file && source ? await backlogFileUrl(db, projectRow, source, file, gitHosts) : null;
  const { assignees, dependencies, parentId, subtasks, ...rest } = block;
  return {
    id: row.backlogId,
    file,
    fileUrl,
    data: {
      ...rest,
      assignees: assignees.map((value) => {
        const member = value.userId ? users.get(value.userId) : undefined;
        return { value: value.value, user: member ? userRef(member) : null };
      }),
      dependencies: dependencies.map(link),
      parent: parentId ? link(parentId) : null,
      subtasks: subtasks.map(link),
    },
  };
}

async function toTask(db: DbOrTx, projectRow: ProjectRow, row: TaskRow, view: TaskView): Promise<Task> {
  // Sequential: toTask runs inside transactions, where queries share one connection.
  const users = await usersFor(db, [row.assigneeId, row.createdById, row.createdOnBehalfOfId]);
  const refs = await planningRefs(db, [row], view.today);
  const source = await loadBacklogSource(db, projectRow.id);
  const backlog = row.backlogId
    ? await taskBacklog(db, projectRow, { ...row, backlogId: row.backlogId }, source, view.gitHosts)
    : null;
  const labels = (await labelsOfTasks(db, [row.id])).get(row.id) ?? [];
  const relations = await loadTaskRelations(db, projectRow, row);
  const items = await toWorkItems(db, await loadTaskItemRows(db, [row.id]), sourceMirrors(source));
  const meta = await workTextMeta(db, row);
  return Task.parse({
    id: row.id,
    key: formatTaskKey(projectRow.key, row.number, row.keySuffix),
    number: row.number,
    project: { id: projectRow.id, key: projectRow.key, name: projectRow.name },
    title: row.title,
    description: row.description,
    status: row.status,
    priority: priorityFromValue(row.priority),
    assignee: assigneeRef(row.assigneeId, users),
    createdBy: requireUser(users, row.createdById),
    createdOnBehalfOf: row.createdOnBehalfOfId ? requireUser(users, row.createdOnBehalfOfId) : null,
    milestone: refs.milestone(row),
    cycle: refs.cycle(row),
    cycleAddedAt: row.cycleAddedAt,
    rank: row.rank,
    backlog,
    locked: lockedFields(sourceMirrors(source)),
    hidden: row.hiddenAt !== null,
    hiddenAt: row.hiddenAt,
    labels,
    dueDate: row.dueDate,
    ...relations,
    criteria: items.criteria,
    doneItems: items.doneItems,
    plan: row.plan,
    planMeta: meta.plan,
    finalSummary: row.finalSummary,
    finalSummaryMeta: meta.finalSummary,
    createdAt: row.createdAt,
    updatedAt: row.updatedAt,
  });
}

/** The two Markdown texts of the work record, as activity changes name them. */
const WORK_TEXT_FIELDS = ['plan', 'finalSummary'] as const;

/**
 * M6: who last wrote the plan and the final summary, and when: the latest activity entry that
 * changed the field (null while the field is empty). A mirrored task whose text came in with the
 * upgrade, before any refresh recorded it, reads as written by Backlog.md at its last update.
 */
async function workTextMeta(
  db: DbOrTx,
  row: TaskRow,
): Promise<Record<(typeof WORK_TEXT_FIELDS)[number], z.input<typeof WorkTextMeta> | null>> {
  const result: Record<(typeof WORK_TEXT_FIELDS)[number], z.input<typeof WorkTextMeta> | null> = {
    plan: null,
    finalSummary: null,
  };
  const found = new Map<
    string,
    { actorId: string | null; onBehalfOfId: string | null; origin: 'app' | 'backlog'; createdAt: Date }
  >();
  // Sequential: toTask runs inside transactions, where queries share one connection.
  for (const field of WORK_TEXT_FIELDS) {
    if (row[field] === null) continue;
    const [entry] = await db
      .select({
        actorId: activity.actorId,
        onBehalfOfId: activity.onBehalfOfId,
        origin: activity.origin,
        createdAt: activity.createdAt,
      })
      .from(activity)
      .where(
        and(eq(activity.taskId, row.id), sql`${activity.changes} @> ${JSON.stringify([{ field }])}::jsonb`),
      )
      .orderBy(desc(activity.createdAt), desc(activity.id))
      .limit(1);
    if (entry) found.set(field, entry);
  }
  const users = await loadUsers(
    db,
    [...found.values()].flatMap((entry) => [entry.actorId, entry.onBehalfOfId].filter((id) => id !== null)),
  );
  const ref = (id: string | null) => {
    const user = id ? users.get(id) : undefined;
    return user ? userRef(user) : null;
  };
  for (const field of WORK_TEXT_FIELDS) {
    if (row[field] === null) continue;
    const entry = found.get(field);
    if (entry) {
      result[field] = {
        author: ref(entry.actorId),
        onBehalfOf: ref(entry.onBehalfOfId),
        origin: entry.origin,
        at: entry.createdAt,
      };
    } else if (row.backlogId) {
      result[field] = { author: null, onBehalfOf: null, origin: 'backlog', at: row.updatedAt };
    }
  }
  return result;
}

// ---------------------------------------------------------------------------
// Cursor
// ---------------------------------------------------------------------------

/** Position after the last row of a page in list order (status, priority desc, updated_at desc, id desc). */
const ListCursor = z.tuple([
  z.enum(TASK_STATUSES),
  z.number().int().min(0).max(4),
  /** updated_at as Postgres text, so microseconds survive the round trip. */
  z.string().min(1).max(64),
  z.uuid(),
]);
/** Position after the last row of a page in board order (status, rank, id). */
const BoardCursor = z.tuple([z.literal('board'), z.enum(TASK_STATUSES), z.number(), z.uuid()]);
/**
 * M5: position after the last row of a page in one `sort` ordering: 'sort', the sort, then the
 * row's value for each part of SORT_PARTS[sort] (timestamps as Postgres text, a null due date as
 * null).
 */
const SortCursor = z
  .tuple([z.literal('sort'), z.enum(TASK_SORTS)])
  .rest(z.union([z.string().max(64), z.number(), z.null()]));
const Cursor = z.union([ListCursor, BoardCursor, SortCursor]);
type ListCursor = z.infer<typeof ListCursor>;
type BoardCursor = z.infer<typeof BoardCursor>;
type SortCursor = z.infer<typeof SortCursor>;
type Cursor = z.infer<typeof Cursor>;

/** A task row as lists read it: without the plan and final summary texts (M6), which rows don't show. */
type ListTaskRow = Omit<TaskRow, 'plan' | 'finalSummary'>;

const { plan: _plan, finalSummary: _finalSummary, ...listTaskColumns } = getTableColumns(task);

/** What a page query selects per row: the task, its project, and timestamps as text for cursors. */
interface ListRow {
  task: ListTaskRow;
  project: { id: string; key: string; name: string };
  /** M6: the task has a final summary. */
  hasFinalSummary: boolean;
  updatedAtText: string;
  createdAtText: string;
}

type SortValue = string | number | null;

/** One key of a `sort` ordering. Nullable keys sort nulls last. */
interface SortPart {
  column: SQL;
  dir: 'asc' | 'desc';
  /** Postgres type the cursor value is cast to. */
  type: 'smallint' | 'timestamptz' | 'uuid' | 'date' | 'double precision';
  nullable?: boolean;
  value: (row: ListRow) => SortValue;
}

const UPDATED_PART: SortPart = {
  column: sql`${task.updatedAt}`,
  dir: 'desc',
  type: 'timestamptz',
  value: (row) => row.updatedAtText,
};
const ID_PART: SortPart = { column: sql`${task.id}`, dir: 'desc', type: 'uuid', value: (row) => row.task.id };

/**
 * M5 orderings of ListTasksInput.sort. Ties fall back to the last update (newest first), then the
 * id, so every ordering is total and keyset cursors stay exact.
 */
const SORT_PARTS: Record<TaskSort, SortPart[]> = {
  priority: [
    { column: sql`${task.priority}`, dir: 'desc', type: 'smallint', value: (row) => row.task.priority },
    UPDATED_PART,
    ID_PART,
  ],
  due: [
    {
      column: sql`${task.dueDate}`,
      dir: 'asc',
      type: 'date',
      nullable: true,
      value: (row) => row.task.dueDate,
    },
    UPDATED_PART,
    ID_PART,
  ],
  updated: [UPDATED_PART, ID_PART],
  created: [
    { column: sql`${task.createdAt}`, dir: 'desc', type: 'timestamptz', value: (row) => row.createdAtText },
    ID_PART,
  ],
  manual: [
    { column: sql`${task.rank}`, dir: 'asc', type: 'double precision', value: (row) => row.task.rank },
    UPDATED_PART,
    ID_PART,
  ],
};

function sortOrderBy(parts: SortPart[]): SQL[] {
  return parts.map((part) =>
    part.nullable
      ? sql`${part.column} ${sql.raw(part.dir)} nulls last`
      : part.dir === 'asc'
        ? asc(part.column)
        : desc(part.column),
  );
}

/** Whether `value` fits the part's type (cursor values come from the client). */
function sortValueValid(part: SortPart, value: SortValue): boolean {
  if (value === null) return part.nullable === true;
  switch (part.type) {
    case 'smallint':
      return typeof value === 'number' && Number.isInteger(value) && value >= 0 && value <= 4;
    case 'double precision':
      return typeof value === 'number' && Number.isFinite(value);
    case 'timestamptz':
      return typeof value === 'string' && !Number.isNaN(Date.parse(value));
    case 'uuid':
      return z.uuid().safeParse(value).success;
    case 'date':
      return CalendarDate.safeParse(value).success;
  }
}

/** Rows after `values` in the ordering `parts`: the keyset condition, nulls last on nullable parts. */
function afterSortCursor(parts: SortPart[], values: SortValue[]): SQL {
  const clauses: SQL[] = [];
  const equal: SQL[] = [];
  parts.forEach((part, index) => {
    const value = values[index] ?? null;
    const cast = sql.raw(part.type);
    if (value !== null) {
      const beyond =
        part.dir === 'asc'
          ? sql`${part.column} > ${value}::${cast}`
          : sql`${part.column} < ${value}::${cast}`;
      const after = part.nullable ? sql`(${beyond} or ${part.column} is null)` : beyond;
      clauses.push(and(...equal, after) as SQL);
    }
    // After a null (nulls last) only rows with null in this part and later parts beyond follow.
    equal.push(value === null ? sql`${part.column} is null` : sql`${part.column} = ${value}::${cast}`);
  });
  return clauses.length === 0 ? sql`false` : (or(...clauses) as SQL);
}

function encodeCursor(cursor: Cursor): string {
  return Buffer.from(JSON.stringify(cursor)).toString('base64url');
}

function invalidCursor(): Invalid {
  return new Invalid('The cursor is not valid', { issues: [{ path: 'cursor', message: 'Invalid cursor' }] });
}

/** Decodes a cursor and checks it came from the same ordering: `sort` when set, else `order`. */
function decodeCursor(value: string, order: 'list' | 'board', sort: TaskSort | undefined): Cursor {
  let cursor: Cursor;
  try {
    cursor = Cursor.parse(JSON.parse(Buffer.from(value, 'base64url').toString('utf8')));
  } catch {
    throw invalidCursor();
  }
  if (cursor[0] === 'sort') {
    const [, cursorSort, ...values] = cursor as SortCursor;
    if (cursorSort !== sort) throw invalidCursor();
    const parts = SORT_PARTS[cursorSort];
    if (values.length !== parts.length || parts.some((part, i) => !sortValueValid(part, values[i] ?? null))) {
      throw invalidCursor();
    }
    return cursor;
  }
  if (sort) throw invalidCursor();
  const isBoard = cursor[0] === 'board';
  if (isBoard !== (order === 'board')) throw invalidCursor();
  if (!isBoard && Number.isNaN(Date.parse((cursor as ListCursor)[2]))) throw invalidCursor();
  return cursor;
}

function afterListCursor([status, priority, updatedAt, id]: ListCursor): SQL {
  const sameStatus = sql`${task.status} = ${status}::task_status`;
  const samePriority = eq(task.priority, priority);
  const sameUpdatedAt = sql`${task.updatedAt} = ${updatedAt}::timestamptz`;
  return or(
    sql`${task.status} > ${status}::task_status`,
    and(sameStatus, sql`${task.priority} < ${priority}`),
    and(sameStatus, samePriority, sql`${task.updatedAt} < ${updatedAt}::timestamptz`),
    and(sameStatus, samePriority, sameUpdatedAt, sql`${task.id} < ${id}::uuid`),
  ) as SQL;
}

function afterBoardCursor([, status, rank, id]: BoardCursor): SQL {
  return or(
    sql`${task.status} > ${status}::task_status`,
    and(
      sql`${task.status} = ${status}::task_status`,
      sql`(${task.rank}, ${task.id}) > (${rank}::double precision, ${id}::uuid)`,
    ),
  ) as SQL;
}

// ---------------------------------------------------------------------------
// List
// ---------------------------------------------------------------------------

function escapeLike(value: string): string {
  return value.replace(/[\\%_]/g, (char) => `\\${char}`);
}

/** Ids of the cycles `selector` names in each project; projects without such a cycle add none. */
async function cycleIdsFor(
  ctx: TaskContext,
  projects: ProjectRow[],
  selector: CycleSelector,
): Promise<string[]> {
  const { db } = ctx;
  const projectIds = projects.map((row) => row.id);
  if (typeof selector === 'number') {
    const rows = await db
      .select({ id: cycle.id })
      .from(cycle)
      .where(and(inArray(cycle.projectId, projectIds), eq(cycle.number, selector)));
    return rows.map((row) => row.id);
  }
  // current and next resolve per project.
  const found = await Promise.all(projects.map((row) => resolveCycleSelector(db, row.id, selector, ctx)));
  return found.filter((row) => row !== null).map((row) => row.id);
}

/**
 * Tasks assigned to any of `values`: the caller (`me`), any agent (`agents`), nobody (`none`) or
 * a user id.
 */
function assigneeCondition(db: DbOrTx, actor: Actor, values: string[]): SQL {
  const ids = new Set<string>();
  const parts: (SQL | undefined)[] = [];
  for (const value of values) {
    if (value === FILTER_NONE) parts.push(isNull(task.assigneeId));
    else if (value === ASSIGNEE_AGENTS) {
      parts.push(
        inArray(task.assigneeId, db.select({ id: user.id }).from(user).where(eq(user.kind, 'agent'))),
      );
    } else ids.add(value === ASSIGNEE_ME ? actor.userId : value);
  }
  if (ids.size > 0) parts.push(inArray(task.assigneeId, [...ids]));
  return or(...parts) as SQL;
}

/** Open: any status but Done and Canceled. */
const isOpenTask = () => inArray(task.status, [...OPEN_TASK_STATUSES]);

/**
 * One page of tasks. Without `sort`: list order (status, then priority highest first, then last
 * update newest first) or board order (status, then rank). With `sort` (M5): one ordering over the
 * whole result (SORT_PARTS), without the status grouping. Without `project`, the page spans every
 * project the actor can read in the workspace. `counts` covers every status for the same filters,
 * ignoring the status filter, so the UI can show group sizes. Hidden tasks (file gone from
 * Backlog.md) are left out of the page and the counts unless `hidden` is only or include.
 *
 * Assignee, milestone and cycle take one value or several (M5); a task matches any of them, `none`
 * matching tasks without one. M5 filters: label ids (any of), due (overdue and soon count open tasks only, judged on today in
 * the context's time zone), blocked (an open, visible blocker), topLevel and parent. Items carry
 * labels, dueDate, blocked, subtaskProgress and parentKey, read for the whole page in a fixed
 * number of queries.
 */
export async function listTasks(
  ctx: TaskContext,
  actor: Actor,
  input: z.input<typeof ListTasksInput>,
): Promise<TaskListPage> {
  const { db } = ctx;
  const filters = parseInput(ListTasksInput, input);
  const cursor = filters.cursor ? decodeCursor(filters.cursor, filters.order, filters.sort) : null;
  const projects = await readableProjects(db, actor, filters.project);
  const counts = Object.fromEntries(TASK_STATUSES.map((status) => [status, 0])) as Record<TaskStatus, number>;
  if (projects.length === 0) return TaskListPage.parse({ items: [], nextCursor: null, counts });

  const conditions: (SQL | undefined)[] = [
    inArray(
      task.projectId,
      projects.map((row) => row.id),
    ),
  ];
  if (filters.priority) conditions.push(inArray(task.priority, filters.priority.map(priorityToValue)));
  if (filters.assignee) conditions.push(assigneeCondition(db, actor, filters.assignee));
  if (filters.milestone) {
    const ids = filters.milestone.filter((value) => value !== FILTER_NONE);
    conditions.push(
      or(
        filters.milestone.includes(FILTER_NONE) ? isNull(task.milestoneId) : undefined,
        ids.length > 0 ? inArray(task.milestoneId, ids) : undefined,
      ),
    );
  }
  if (filters.cycle) {
    const selectors = filters.cycle.filter((value) => value !== FILTER_NONE);
    // Sequential: one selector set per project; current and next resolve per project.
    const ids: string[] = [];
    for (const selector of selectors) ids.push(...(await cycleIdsFor(ctx, projects, selector)));
    const none = filters.cycle.includes(FILTER_NONE);
    // No such cycle anywhere and no `none`: nothing matches.
    conditions.push(
      none || ids.length > 0
        ? or(
            none ? isNull(task.cycleId) : undefined,
            ids.length > 0 ? inArray(task.cycleId, [...new Set(ids)]) : undefined,
          )
        : sql`false`,
    );
  }
  if (filters.hidden === 'only') conditions.push(isNotNull(task.hiddenAt));
  else if (filters.hidden !== 'include') conditions.push(isNull(task.hiddenAt));
  if (filters.q) {
    const pattern = `%${escapeLike(filters.q)}%`;
    conditions.push(
      or(
        ilike(task.title, pattern),
        ilike(
          sql`${project.key} || '-' || ${task.number}::text || coalesce('.' || ${task.keySuffix}, '')`,
          pattern,
        ),
        ilike(task.backlogId, pattern),
      ),
    );
  }
  if (filters.label) {
    conditions.push(
      inArray(
        task.id,
        db
          .select({ id: taskLabel.taskId })
          .from(taskLabel)
          .where(inArray(taskLabel.labelId, [...new Set(filters.label)])),
      ),
    );
  }
  if (filters.due) {
    const today = todayIn(ctx);
    if (filters.due === 'overdue') conditions.push(isOpenTask(), sql`${task.dueDate} < ${today}::date`);
    else if (filters.due === 'soon') {
      const last = addCalendarDays(today, DUE_SOON_DAYS);
      conditions.push(isOpenTask(), sql`${task.dueDate} between ${today}::date and ${last}::date`);
    } else if (filters.due === 'none') conditions.push(isNull(task.dueDate));
    else conditions.push(isNotNull(task.dueDate));
  }
  if (filters.blocked !== undefined) {
    const blocked = hasOpenBlockerSql(task.id);
    conditions.push(filters.blocked ? blocked : sql`not ${blocked}`);
  }
  if (filters.topLevel) conditions.push(isNull(task.parentId));
  if (filters.parent) {
    const parent = await findTask(db, actor, filters.parent);
    conditions.push(eq(task.parentId, parent.task.id));
  }
  const statusCondition = filters.status ? inArray(task.status, filters.status) : undefined;
  const sortParts = filters.sort ? SORT_PARTS[filters.sort] : null;
  const board = filters.order === 'board';
  let after: SQL | undefined;
  if (cursor && cursor[0] === 'sort' && sortParts) {
    const [, , ...values] = cursor as SortCursor;
    after = afterSortCursor(sortParts, values);
  } else if (cursor) {
    after =
      cursor[0] === 'board' ? afterBoardCursor(cursor as BoardCursor) : afterListCursor(cursor as ListCursor);
  }
  const orderBy = sortParts
    ? sortOrderBy(sortParts)
    : board
      ? [asc(task.status), asc(task.rank), asc(task.id)]
      : [asc(task.status), desc(task.priority), desc(task.updatedAt), desc(task.id)];

  const [rows, countRows] = await Promise.all([
    db
      .select({
        task: listTaskColumns,
        project: { id: project.id, key: project.key, name: project.name },
        hasFinalSummary: sql<boolean>`${task.finalSummary} is not null`,
        updatedAtText: sql<string>`${task.updatedAt}::text`,
        createdAtText: sql<string>`${task.createdAt}::text`,
      })
      .from(task)
      .innerJoin(project, eq(project.id, task.projectId))
      .where(and(...conditions, statusCondition, after))
      .orderBy(...orderBy)
      .limit(filters.limit + 1),
    db
      .select({ status: task.status, count: sql<number>`count(*)`.mapWith(Number) })
      .from(task)
      .innerJoin(project, eq(project.id, task.projectId))
      .where(and(...conditions))
      .groupBy(task.status),
  ]);

  const page = rows.slice(0, filters.limit);
  const last = page.at(-1);
  let nextCursor: string | null = null;
  if (rows.length > filters.limit && last) {
    if (filters.sort && sortParts) {
      nextCursor = encodeCursor(['sort', filters.sort, ...sortParts.map((part) => part.value(last))]);
    } else {
      nextCursor = encodeCursor(
        board
          ? ['board', last.task.status, last.task.rank, last.task.id]
          : [last.task.status, last.task.priority, last.updatedAtText, last.task.id],
      );
    }
  }
  for (const row of countRows) counts[row.status] = row.count;

  return TaskListPage.parse({ items: await toListItems(db, page, todayIn(ctx)), nextCursor, counts });
}

/**
 * Tasks as list rows, with everything a row shows. A fixed number of queries for the whole set
 * (users, milestones, cycles, mirrors, comment counts, labels, blockers, subtask progress, parent
 * keys, M6 criteria and done item counts), whatever its size.
 */
async function toListItems(
  db: DbOrTx,
  rows: Pick<ListRow, 'task' | 'project' | 'hasFinalSummary'>[],
  today: string,
  options: { inTransaction?: boolean } = {},
): Promise<z.input<typeof TaskListItem>[]> {
  const ids = rows.map((row) => row.task.id);
  const reads = [
    () =>
      usersFor(
        db,
        rows.map((row) => row.task.assigneeId),
      ),
    () =>
      planningRefs(
        db,
        rows.map((row) => row.task),
        today,
      ),
    () =>
      mirroredProjectIds(
        db,
        rows.map((row) => row.project.id),
      ),
    () => liveCommentCounts(db, ids),
    () => labelsOfTasks(db, ids),
    () => blockedTaskIds(db, ids),
    () => subtaskProgressOf(db, ids),
    () =>
      taskKeysById(
        db,
        rows.flatMap((row) => (row.task.parentId ? [row.task.parentId] : [])),
      ),
    () => workItemProgressOf(db, ids),
  ] as const;
  // A transaction has one connection: run its reads one after the other.
  const [users, refs, mirrored, comments, labels, blocked, progress, parentKeys, items] = await runReads(
    reads,
    options.inTransaction === true,
  );
  return rows.map(({ task: row, project: projectRef, hasFinalSummary }) => ({
    id: row.id,
    key: formatTaskKey(projectRef.key, row.number, row.keySuffix),
    number: row.number,
    project: projectRef,
    title: row.title,
    status: row.status,
    priority: priorityFromValue(row.priority),
    assignee: assigneeRef(row.assigneeId, users),
    milestone: refs.milestone(row),
    cycle: refs.cycle(row),
    cycleAddedAt: row.cycleAddedAt,
    rank: row.rank,
    backlogId: row.backlogId,
    locked: lockedFields(mirrored.has(projectRef.id)),
    hidden: row.hiddenAt !== null,
    hiddenAt: row.hiddenAt,
    commentCount: comments.get(row.id) ?? 0,
    labels: labels.get(row.id) ?? [],
    dueDate: row.dueDate,
    blocked: blocked.has(row.id),
    subtaskProgress: progress.get(row.id) ?? { done: 0, total: 0 },
    parentKey: row.parentId ? (parentKeys.get(row.parentId) ?? null) : null,
    criteriaProgress: progressFor(items, row.id).criteria,
    doneProgress: progressFor(items, row.id).done,
    hasFinalSummary,
    createdAt: row.createdAt,
    updatedAt: row.updatedAt,
  }));
}

type ReadResults<T extends readonly (() => Promise<unknown>)[]> = {
  -readonly [K in keyof T]: T[K] extends () => Promise<infer R> ? R : never;
};

/** Runs `reads` at once, or one after the other when `sequential` (inside a transaction). */
async function runReads<T extends readonly (() => Promise<unknown>)[]>(
  reads: T,
  sequential: boolean,
): Promise<ReadResults<T>> {
  if (!sequential) return (await Promise.all(reads.map((read) => read()))) as ReadResults<T>;
  const results: unknown[] = [];
  for (const read of reads) results.push(await read());
  return results as ReadResults<T>;
}

/** Comments that are not deleted, per task id; tasks without any are left out. */
async function liveCommentCounts(db: DbOrTx, taskIds: string[]): Promise<Map<string, number>> {
  if (taskIds.length === 0) return new Map();
  const rows = await db
    .select({ taskId: comment.taskId, count: sql<number>`count(*)`.mapWith(Number) })
    .from(comment)
    .where(and(inArray(comment.taskId, taskIds), isNull(comment.deletedAt)))
    .groupBy(comment.taskId);
  return new Map(rows.map((row) => [row.taskId, row.count]));
}

// ---------------------------------------------------------------------------
// Get
// ---------------------------------------------------------------------------

/**
 * A task by key (PAY-142, PAY-786.1) or by Backlog.md id (BACK-786.1, narrowed by `project` when
 * given). Hidden tasks are found too. NotFound outside the workspace; Forbidden outside the key's
 * scope.
 */
export async function getTask(ctx: TaskContext, actor: Actor, input: z.input<typeof GetTaskInput>) {
  const { key, project: projectKey } = parseInput(GetTaskInput, input);
  const found = await findTask(ctx.db, actor, key, { project: projectKey });
  return toTask(ctx.db, found.project, found.task, viewOf(ctx));
}

// ---------------------------------------------------------------------------
// Validation of task fields
// ---------------------------------------------------------------------------

function invalidField(path: string, message: string): Invalid {
  return new Invalid(message, { issues: [{ path, message }] });
}

/** Resolves `me` or a user id to a workspace member's id. Invalid when the user is not a member. */
async function resolveAssignee(tx: Tx, actor: Actor, value: string | null | undefined) {
  if (value === undefined) return undefined;
  if (value === null) return null;
  const id = value === ASSIGNEE_ME ? actor.userId : value;
  if (id === actor.userId) return id;
  const member = await workspaceMember(tx, actor.workspaceId, id);
  if (!member) throw invalidField('assignee', 'The assignee is not a member of this workspace');
  return id;
}

/**
 * Checks a milestone id against the task's project: the project must use milestones and the
 * milestone must belong to it. null clears.
 */
async function resolveMilestone(
  tx: Tx,
  projectRow: ProjectRow,
  value: string | null | undefined,
): Promise<MilestoneRow | null | undefined> {
  if (value === undefined || value === null) return value;
  if (!projectRow.usesMilestones) {
    throw invalidField('milestone', `Project ${projectRow.key} does not use milestones`);
  }
  const [row] = await tx
    .select()
    .from(milestone)
    .where(and(eq(milestone.id, value), eq(milestone.projectId, projectRow.id)))
    .limit(1);
  if (!row) throw invalidField('milestone', `The milestone is not in project ${projectRow.key}`);
  return row;
}

/**
 * Resolves a cycle selector in the task's project: the project must use cycles, the cycle must
 * exist and must not be completed. null clears.
 */
async function resolveCycle(
  tx: Tx,
  clock: ClockContext,
  projectRow: ProjectRow,
  value: CycleSelector | null | undefined,
): Promise<CycleRow | null | undefined> {
  if (value === undefined || value === null) return value;
  if (!projectRow.usesCycles) throw invalidField('cycle', `Project ${projectRow.key} does not use cycles`);
  const row = await resolveCycleSelector(tx, projectRow.id, value, clock);
  if (!row) {
    const message =
      typeof value === 'number'
        ? `Cycle ${value} does not exist in project ${projectRow.key}`
        : `Project ${projectRow.key} has no ${value === 'current' ? 'current' : 'upcoming'} cycle`;
    throw invalidField('cycle', message);
  }
  // Completed includes a cycle past its end date that the hourly job has not ended yet.
  if (row.state === 'completed') {
    throw invalidField('cycle', `Cycle ${row.number} is completed and takes no new tasks`);
  }
  return row;
}

// ---------------------------------------------------------------------------
// Ranks
// ---------------------------------------------------------------------------

/** Rank for the top of a status column: the column minimum - 1, or 0 for an empty column. */
async function topRank(tx: Tx, projectId: string, status: TaskStatus, excludeId?: string): Promise<number> {
  const [row] = await tx
    .select({ min: sql<number | string | null>`min(${task.rank})` })
    .from(task)
    .where(
      and(
        eq(task.projectId, projectId),
        eq(task.status, status),
        excludeId ? ne(task.id, excludeId) : undefined,
      ),
    );
  return row?.min === null || row?.min === undefined ? 0 : Number(row.min) - 1;
}

/**
 * Renumbers a status column 1..n in board order (rank, id), leaving out `excludeId` (the task being
 * moved). Raw SQL on purpose: renumbering is not a change of those tasks, so their updated_at stays.
 */
async function renumberColumn(tx: Tx, projectId: string, status: TaskStatus, excludeId: string) {
  await tx.execute(sql`
    update ${task} set rank = ordered.n
    from (
      select id, row_number() over (order by rank, id) as n
      from ${task}
      where project_id = ${projectId} and status = ${status}::task_status and id <> ${excludeId}
    ) as ordered
    where ${task.id} = ordered.id`);
}

/**
 * Rank that places `movingId` right before or after the reference task of `position` in the
 * `status` column: the midpoint between the reference and its neighbour on that side, or one step
 * past the reference at the column's end. Renumbers the column when the gap is too small.
 * The caller holds the project row lock.
 */
async function rankForPosition(
  tx: Tx,
  projectRow: ProjectRow,
  movingId: string,
  status: TaskStatus,
  position: TaskPosition,
): Promise<number> {
  const before = 'before' in position;
  const refKey = before ? position.before : position.after;
  const path = before ? 'position.before' : 'position.after';
  const { projectKey, number, suffix } = parseTaskKey(refKey);
  if (projectKey !== projectRow.key) {
    throw invalidField(path, `${refKey} is not in project ${projectRow.key}`);
  }

  for (let attempt = 0; attempt < 2; attempt++) {
    const [ref] = await tx
      .select({ id: task.id, rank: task.rank, status: task.status })
      .from(task)
      .where(
        and(
          eq(task.projectId, projectRow.id),
          eq(task.number, number),
          suffix === null ? isNull(task.keySuffix) : eq(task.keySuffix, suffix),
        ),
      )
      .limit(1);
    if (!ref) throw invalidField(path, `Task ${refKey} not found`);
    if (ref.id === movingId) throw invalidField(path, 'A task cannot be placed next to itself');
    if (ref.status !== status) {
      throw invalidField(path, `${refKey} is not in the ${TASK_STATUS_LABELS[status]} column`);
    }

    const refTuple = sql`(${ref.rank}::double precision, ${ref.id}::uuid)`;
    const [neighbour] = await tx
      .select({ rank: task.rank })
      .from(task)
      .where(
        and(
          eq(task.projectId, projectRow.id),
          eq(task.status, status),
          ne(task.id, movingId),
          before
            ? sql`(${task.rank}, ${task.id}) < ${refTuple}`
            : sql`(${task.rank}, ${task.id}) > ${refTuple}`,
        ),
      )
      .orderBy(...(before ? [desc(task.rank), desc(task.id)] : [asc(task.rank), asc(task.id)]))
      .limit(1);
    if (!neighbour) return before ? ref.rank - 1 : ref.rank + 1;

    const mid = (ref.rank + neighbour.rank) / 2;
    const gap = Math.abs(ref.rank - neighbour.rank);
    if (gap >= MIN_RANK_GAP && mid !== ref.rank && mid !== neighbour.rank) return mid;
    await renumberColumn(tx, projectRow.id, status, movingId);
  }
  throw new Error('board column renumbering did not open a gap');
}

// ---------------------------------------------------------------------------
// Create and update
// ---------------------------------------------------------------------------

/** Labels as a stored change lists them: by name ignoring case. */
function storedLabels(rows: Pick<LabelRow, 'id' | 'name'>[]): StoredLabelRef[] {
  return [...rows].sort(compareLabelNames).map((row) => ({ id: row.id, name: row.name }));
}

/** Blockers as a stored change lists them: by key. */
function storedBlockers(projectRow: ProjectRow, rows: ProjectTask[]): StoredTaskRef[] {
  return rows.map((row) => storedTaskRef(projectRow, row)).sort((a, b) => compareTaskKeys(a.key, b.key));
}

function labelScope(projectRow: ProjectRow) {
  return { workspaceId: projectRow.workspaceId, projectId: projectRow.id };
}

function asProjectTask(row: TaskRow): ProjectTask {
  return {
    id: row.id,
    number: row.number,
    keySuffix: row.keySuffix,
    title: row.title,
    parentId: row.parentId,
    assigneeId: row.assigneeId,
  };
}

/**
 * Creates a task at the top of its status column. Its number comes from the project counter in
 * the same transaction. A milestone and a cycle of the same project may be set; a started task
 * activates its milestone.
 *
 * M5: `labels` are found by name ignoring case or created; `dueDate` is stored as given; `parent`
 * makes it a subtask (same project, the parent top level), which takes the parent's assignee when
 * no assignee is sent (an explicit null leaves it unassigned); `blockedBy` lists tasks of the same
 * project it waits on (a new task can't close a loop: nothing waits on it yet).
 *
 * M6: `criteria` and `doneItems` start the work record, numbered in order; the project's default
 * done items come first unless `skipDefaultDoneItems` (a given item equal to a default one is not
 * added twice). At most MAX_WORK_ITEMS per list, defaults included. `plan` sets the plan. The
 * task.created entry lists each item added and the plan.
 */
export async function createTask(
  ctx: TaskContext,
  actor: Actor,
  input: z.input<typeof CreateTaskInput>,
): Promise<Task> {
  const parsed = parseInput(CreateTaskInput, input);
  return ctx.db.transaction(async (tx) => {
    // Row lock on the project first: concurrent creations queue here and each gets the next number
    // and a rank above the column's current top; a cycle cannot end while the task joins it; a
    // parent cannot become a subtask meanwhile.
    const projectRow = await findProjectByKey(tx, actor, parsed.project, { forUpdate: true });
    authorize(actor, 'task.write', { type: 'project', projectId: projectRow.id });
    const source = await loadBacklogSource(tx, projectRow.id);
    if (sourceMirrors(source)) throw projectMirroredCreate(projectRow, source, parsed.title);
    // An import that has not finished its first read still needs every number it will take.
    if (sourceIsActive(source)) {
      throw new ProjectMirrored(
        `${projectRow.name} is importing from Backlog.md. Add tasks once the import has finished.`,
      );
    }
    const [parentRow] = parsed.parent
      ? await resolveProjectTasks(tx, projectRow, [parsed.parent], 'parent')
      : [];
    if (parentRow) await assertParentAllowed(tx, projectRow, null, parentRow);
    const assigneeId =
      parsed.assignee === undefined && parentRow
        ? parentRow.assigneeId
        : ((await resolveAssignee(tx, actor, parsed.assignee)) ?? null);
    const milestoneRow = (await resolveMilestone(tx, projectRow, parsed.milestone)) ?? null;
    const cycleRow = (await resolveCycle(tx, ctx, projectRow, parsed.cycle)) ?? null;
    const blockers = await resolveProjectTasks(tx, projectRow, parsed.blockedBy ?? [], 'blockedBy');
    const labelRows = await findOrCreateLabels(tx, labelScope(projectRow), parsed.labels ?? []);
    const doneTexts = initialDoneItems(projectRow, parsed.doneItems ?? [], parsed.skipDefaultDoneItems);

    const [counter] = await tx
      .update(project)
      .set({ nextTaskNumber: sql`${project.nextTaskNumber} + 1`, updatedAt: sql`${project.updatedAt}` })
      .where(eq(project.id, projectRow.id))
      .returning({ number: sql<number>`${project.nextTaskNumber} - 1`.mapWith(Number) });
    if (!counter) throw new NotFound(`Project ${projectRow.key} not found`);
    const rank = await topRank(tx, projectRow.id, parsed.status);

    const description = parsed.description ? parsed.description : null;
    const dueDate = parsed.dueDate ?? null;
    const plan = parsed.plan ? parsed.plan : null;
    const [row] = await tx
      .insert(task)
      .values({
        projectId: projectRow.id,
        number: counter.number,
        title: parsed.title,
        description,
        status: parsed.status,
        priority: priorityToValue(parsed.priority),
        assigneeId,
        createdById: actor.userId,
        createdOnBehalfOfId: actor.onBehalfOfId,
        milestoneId: milestoneRow?.id ?? null,
        cycleId: cycleRow?.id ?? null,
        cycleAddedAt: cycleRow ? sql`now()` : null,
        rank,
        dueDate,
        parentId: parentRow?.id ?? null,
        plan,
      })
      .returning();
    if (!row) throw new Error('task insert returned no row');
    const itemPlans = [
      planItemOperations('criterion', [], { add: parsed.criteria ?? [] }, actor.userId),
      planItemOperations('done', [], { add: doneTexts }, actor.userId),
    ];
    for (const itemPlan of itemPlans) await writeItemPlan(tx, row.id, [], itemPlan);
    await setTaskLabels(
      tx,
      row.id,
      labelRows.map((label) => label.id),
    );
    await insertBlockers(
      tx,
      row.id,
      blockers.map((blocker) => blocker.id),
    );

    if (milestoneRow && STARTED_STATUSES.has(row.status)) await activateMilestoneForTask(tx, milestoneRow.id);

    // task.created lists the title and every initial value that differs from the defaults.
    const changes: StoredChange[] = [{ field: 'title', from: null, to: row.title }];
    if (description !== null) changes.push({ field: 'description', from: null, to: description });
    if (parsed.status !== DEFAULT_TASK_STATUS)
      changes.push({ field: 'status', from: null, to: parsed.status });
    if (parsed.priority !== DEFAULT_TASK_PRIORITY) {
      changes.push({ field: 'priority', from: null, to: parsed.priority });
    }
    if (assigneeId) changes.push({ field: 'assignee', from: null, to: assigneeId });
    if (milestoneRow) changes.push({ field: 'milestone', from: null, to: milestoneRow.id });
    if (cycleRow) changes.push({ field: 'cycle', from: null, to: cycleRow.id });
    if (labelRows.length > 0) changes.push({ field: 'labels', from: [], to: storedLabels(labelRows) });
    if (dueDate !== null) changes.push({ field: 'dueDate', from: null, to: dueDate });
    if (parentRow) changes.push({ field: 'parent', from: null, to: storedTaskRef(projectRow, parentRow) });
    if (blockers.length > 0) {
      changes.push({ field: 'blockedBy', from: [], to: storedBlockers(projectRow, blockers) });
    }
    if (plan !== null) changes.push({ field: 'plan', from: null, to: plan });
    for (const itemPlan of itemPlans) changes.push(...itemPlan.changes);
    await recordActivity(tx, actor, {
      projectId: projectRow.id,
      taskId: row.id,
      type: 'task.created',
      changes,
    });

    return toTask(tx, projectRow, row, viewOf(ctx));
  });
}

/**
 * M6: the done items a new task starts with: the project's defaults (unless skipped), then the
 * given ones that are not a default already. Invalid past MAX_WORK_ITEMS.
 */
function initialDoneItems(
  projectRow: ProjectRow,
  given: string[],
  skipDefaults: boolean | undefined,
): string[] {
  const defaults = skipDefaults
    ? []
    : (projectRow.defaultDoneItems ?? [])
        .filter((text): text is string => typeof text === 'string')
        .map((text) => text.trim())
        .filter((text) => text !== '');
  const known = new Set(defaults);
  const texts = [...defaults, ...given.filter((text) => !known.has(text))];
  if (texts.length > MAX_WORK_ITEMS) {
    throw invalidField(
      'doneItems',
      `A task holds ${MAX_WORK_ITEMS} done items or fewer; ${projectRow.key} adds ${defaults.length} default ones, so send ${Math.max(0, MAX_WORK_ITEMS - defaults.length)} or fewer, or skip the defaults`,
    );
  }
  return texts;
}

/** The fields one task write changes: UpdateTaskInput without the key and the preconditions. */
type TaskPatch = Omit<UpdateTaskInput, 'key' | 'project' | 'ifUpdatedAt' | 'ifStatus'>;

/** Whether applying `patch` needs the project lock: rank changes, cycles, blockers and parents. */
function patchNeedsProjectLock(patch: TaskPatch): boolean {
  return (
    patch.status !== undefined ||
    patch.position !== undefined ||
    patch.cycle !== undefined ||
    patch.parent !== undefined ||
    (patch.addBlockers?.length ?? 0) > 0
  );
}

/** The label names a task ends up with after `patch`, or null when the patch leaves labels alone. */
function targetLabelNames(patch: TaskPatch, current: Pick<LabelRow, 'name'>[]): string[] | null {
  if (patch.labels !== undefined) return patch.labels;
  if (!patch.addLabels && !patch.removeLabels) return null;
  const removed = new Set((patch.removeLabels ?? []).map((name) => name.toLowerCase()));
  const names = current.map((row) => row.name).filter((name) => !removed.has(name.toLowerCase()));
  const kept = new Set(names.map((name) => name.toLowerCase()));
  for (const name of patch.addLabels ?? []) {
    if (!kept.has(name.toLowerCase())) {
      kept.add(name.toLowerCase());
      names.push(name);
    }
  }
  return names;
}

function sameNames(a: string[], b: string[]): boolean {
  const left = new Set(a.map((name) => name.toLowerCase()));
  const right = new Set(b.map((name) => name.toLowerCase()));
  return left.size === right.size && [...left].every((name) => right.has(name));
}

/**
 * Applies `patch` to `current` (locked by the caller, with the project lock when
 * patchNeedsProjectLock) and records one task.updated row with every change. Returns the row as
 * it is now. See updateTask for the rules.
 */
async function applyTaskPatch(
  tx: Tx,
  ctx: TaskContext,
  actor: Actor,
  projectRow: ProjectRow,
  current: TaskRow,
  patch: TaskPatch,
): Promise<TaskRow> {
  const set: Partial<TaskInsert> = {};
  /** now() of the transaction when the cycle changes, null when it is cleared. */
  let cycleAddedAt: SQL | null | undefined;
  const changes: StoredChange[] = [];
  if (patch.title !== undefined && patch.title !== current.title) {
    set.title = patch.title;
    changes.push({ field: 'title', from: current.title, to: patch.title });
  }
  if (patch.description !== undefined) {
    const description = patch.description ? patch.description : null;
    if (description !== current.description) {
      set.description = description;
      changes.push({ field: 'description', from: current.description, to: description });
    }
  }
  if (patch.status !== undefined && patch.status !== current.status) {
    set.status = patch.status;
    changes.push({ field: 'status', from: current.status, to: patch.status });
  }
  if (patch.priority !== undefined) {
    const value = priorityToValue(patch.priority);
    if (value !== current.priority) {
      set.priority = value;
      const from: Priority = priorityFromValue(current.priority);
      changes.push({ field: 'priority', from, to: patch.priority });
    }
  }
  const assigneeId = await resolveAssignee(tx, actor, patch.assignee);
  if (assigneeId !== undefined && assigneeId !== current.assigneeId) {
    set.assigneeId = assigneeId;
    changes.push({ field: 'assignee', from: current.assigneeId, to: assigneeId });
  }
  if (patch.milestone !== undefined && patch.milestone !== current.milestoneId) {
    const milestoneRow = await resolveMilestone(tx, projectRow, patch.milestone);
    const milestoneId = milestoneRow?.id ?? null;
    set.milestoneId = milestoneId;
    changes.push({ field: 'milestone', from: current.milestoneId, to: milestoneId });
  }
  if (patch.cycle !== undefined) {
    // Same cycle again is no change, even when that cycle has completed since.
    const unchanged =
      patch.cycle === null
        ? current.cycleId === null
        : current.cycleId !== null && (await sameCycle(tx, current.cycleId, patch.cycle));
    if (!unchanged) {
      const cycleRow = await resolveCycle(tx, ctx, projectRow, patch.cycle);
      const cycleId = cycleRow?.id ?? null;
      if (cycleId !== current.cycleId) {
        set.cycleId = cycleId;
        cycleAddedAt = cycleId ? sql`now()` : null;
        changes.push({ field: 'cycle', from: current.cycleId, to: cycleId });
      }
    }
  }

  // M6: the plan and the final summary. '' clears like null.
  for (const field of WORK_TEXT_FIELDS) {
    const value = patch[field];
    if (value === undefined) continue;
    const next = value ? value : null;
    if (next !== current[field]) {
      set[field] = next;
      changes.push({ field, from: current[field], to: next });
    }
  }
  const itemOps: Record<WorkItemKind, ItemOperations> = {
    criterion: itemOperationsOf(patch, 'criterion'),
    done: itemOperationsOf(patch, 'done'),
  };

  // M5 fields: work out what changes first, so a mirrored task is refused before anything is written.
  const currentLabels =
    patch.labels || patch.addLabels || patch.removeLabels ? await loadTaskLabelRows(tx, current.id) : [];
  const labelNames = targetLabelNames(patch, currentLabels);
  const labelsChange =
    labelNames !== null &&
    !sameNames(
      labelNames,
      currentLabels.map((row) => row.name),
    );
  if (labelsChange && labelNames.length > MAX_TASK_LABELS) {
    throw invalidField('labels', `Use ${MAX_TASK_LABELS} labels or fewer on a task`);
  }
  const dueChange = patch.dueDate !== undefined && patch.dueDate !== current.dueDate;
  let parentTarget: ProjectTask | null | undefined;
  if (patch.parent === null) parentTarget = current.parentId === null ? undefined : null;
  else if (patch.parent !== undefined) {
    const [found] = await resolveProjectTasks(tx, projectRow, [patch.parent], 'parent');
    parentTarget = found && found.id !== current.parentId ? found : undefined;
  }
  const blockersTouched = (patch.addBlockers?.length ?? 0) > 0 || (patch.removeBlockers?.length ?? 0) > 0;
  const currentBlockers = blockersTouched ? await loadBlockers(tx, current.id) : [];
  const currentBlockerIds = new Set(currentBlockers.map((row) => row.id));
  const addedBlockers = (
    await resolveProjectTasks(tx, projectRow, patch.addBlockers ?? [], 'addBlockers')
  ).filter((row) => !currentBlockerIds.has(row.id));
  const removedKeys = new Set(patch.removeBlockers ?? []);
  const removedBlockers = currentBlockers.filter((row) =>
    removedKeys.has(formatTaskKey(projectRow.key, row.number, row.keySuffix)),
  );
  const blockersChange = addedBlockers.length > 0 || removedBlockers.length > 0;

  const locked: LockedChange[] = changes.filter(isOwnedChange);
  if (labelsChange) locked.push({ field: 'labels', to: labelNames });
  if (dueChange) locked.push({ field: 'dueDate', from: current.dueDate, to: patch.dueDate ?? null });
  if (parentTarget !== undefined) locked.push({ field: 'parent', to: parentTarget?.id ?? null });
  if (blockersChange) {
    const removedIds = new Set(removedBlockers.map((row) => row.id));
    locked.push({
      field: 'blockedBy',
      to: [...currentBlockers.filter((row) => !removedIds.has(row.id)), ...addedBlockers].map(
        (row) => row.id,
      ),
    });
  }
  // M6: any item operation on a mirrored task is refused, even one that would change nothing.
  if (hasItemOperations(itemOps.criterion)) locked.push({ field: 'criteria', ops: itemOps.criterion });
  if (hasItemOperations(itemOps.done)) locked.push({ field: 'doneItems', ops: itemOps.done });
  const [owned] = locked;
  if (owned) {
    const source = await loadBacklogSource(tx, projectRow.id);
    if (sourceMirrors(source)) {
      throw await taskMirrored(tx, projectRow, current, source as BacklogSourceRow, owned);
    }
  }

  // M6: plan the item operations, then apply the finishing rule to the lists as they will be.
  const finishing = finishingRuleApplies(actor, current.status, set.status);
  const itemsTouched = hasItemOperations(itemOps.criterion) || hasItemOperations(itemOps.done);
  let itemRows: TaskItemRow[] = [];
  const itemPlans: ItemPlan[] = [];
  if (itemsTouched || finishing) {
    itemRows = await loadTaskItemRows(tx, [current.id]);
    for (const kind of WORK_ITEM_LIST_KINDS) {
      itemPlans.push(planItemOperations(kind, itemsOfKind(itemRows, kind), itemOps[kind], actor.userId));
    }
  }
  if (finishing && set.status) {
    const [criteria, done] = itemPlans;
    const open = openItemsOf({ criterion: criteria?.items ?? [], done: done?.items ?? [] });
    if (open.length > 0) {
      throw openItemsError(
        formatTaskKey(projectRow.key, current.number, current.keySuffix),
        set.status,
        open,
      );
    }
  }

  if (labelsChange) {
    const rows = await findOrCreateLabels(tx, labelScope(projectRow), labelNames);
    await setTaskLabels(
      tx,
      current.id,
      rows.map((row) => row.id),
    );
    changes.push({ field: 'labels', from: storedLabels(currentLabels), to: storedLabels(rows) });
  }
  if (dueChange) {
    set.dueDate = patch.dueDate ?? null;
    changes.push({ field: 'dueDate', from: current.dueDate, to: patch.dueDate ?? null });
  }
  if (parentTarget !== undefined) {
    if (parentTarget) await assertParentAllowed(tx, projectRow, asProjectTask(current), parentTarget);
    const [from] = current.parentId
      ? await resolveProjectTasksById(tx, projectRow, [current.parentId])
      : [undefined];
    set.parentId = parentTarget?.id ?? null;
    changes.push({
      field: 'parent',
      from: from ? storedTaskRef(projectRow, from) : null,
      to: parentTarget ? storedTaskRef(projectRow, parentTarget) : null,
    });
  }
  if (blockersChange) {
    // Removals first: dropping a link can only open paths, never close a loop.
    await deleteBlockers(
      tx,
      current.id,
      removedBlockers.map((row) => row.id),
    );
    const waiting = asProjectTask(current);
    for (const blocker of addedBlockers) {
      await assertNoDependencyLoop(tx, projectRow, waiting, blocker);
      await insertBlockers(tx, current.id, [blocker.id]);
    }
    const removedIds = new Set(removedBlockers.map((row) => row.id));
    const after = [...currentBlockers.filter((row) => !removedIds.has(row.id)), ...addedBlockers];
    changes.push({
      field: 'blockedBy',
      from: storedBlockers(projectRow, currentBlockers),
      to: storedBlockers(projectRow, after),
    });
  }
  if (itemsTouched) {
    for (const itemPlan of itemPlans) {
      await writeItemPlan(tx, current.id, itemsOfKind(itemRows, itemPlan.kind), itemPlan);
      changes.push(...itemPlan.changes);
    }
  }

  const status = set.status ?? current.status;
  if (patch.position) {
    set.rank = await rankForPosition(tx, projectRow, current.id, status, patch.position);
  } else if (set.status !== undefined) {
    set.rank = await topRank(tx, projectRow.id, status, current.id);
  }

  // Label, blocker and item changes live in other tables; they still make the task updated.
  if (Object.keys(set).length === 0 && changes.length > 0) set.updatedAt = new Date();
  if (Object.keys(set).length === 0) return current;

  const [row] = await tx
    .update(task)
    .set(cycleAddedAt === undefined ? set : { ...set, cycleAddedAt })
    .where(eq(task.id, current.id))
    .returning();
  if (!row) throw new Error('task update returned no row');
  const startedOrMoved = set.status !== undefined || set.milestoneId !== undefined;
  if (row.milestoneId && startedOrMoved && STARTED_STATUSES.has(row.status)) {
    await activateMilestoneForTask(tx, row.milestoneId);
  }
  if (changes.length > 0) {
    await recordActivity(tx, actor, {
      projectId: projectRow.id,
      taskId: row.id,
      type: 'task.updated',
      changes,
    });
  }
  return row;
}

/** Tasks of the project by id, as project tasks (for the parent a stored change names). */
async function resolveProjectTasksById(
  tx: Tx,
  projectRow: ProjectRow,
  ids: string[],
): Promise<ProjectTask[]> {
  if (ids.length === 0) return [];
  return tx
    .select({
      id: task.id,
      number: task.number,
      keySuffix: task.keySuffix,
      title: task.title,
      parentId: task.parentId,
      assigneeId: task.assigneeId,
    })
    .from(task)
    .where(and(eq(task.projectId, projectRow.id), inArray(task.id, ids)));
}

/**
 * Updates the fields that differ from the stored task and records them as one task.updated entry.
 * - ifUpdatedAt: TaskChanged (409, with the current task) when the stored task is newer, compared
 *   at millisecond precision.
 * - position places the task before or after a task of the target column (the new status when
 *   status changes); a status change without position puts it at the top of the new column.
 *   Rank is not recorded as activity.
 * - A task that ends up started (In progress, In review) after a status or milestone change
 *   activates its milestone.
 * - M3: in a project that mirrors Backlog.md, a change to a field Backlog.md owns (title,
 *   description, status, priority, assignee, milestone, and from M5 labels, dueDate, parent and
 *   blockers) fails with TaskMirrored, which names the field, the file and a `backlog task edit`
 *   hint. A board move to another column is a status change and fails the same way. Cycle and
 *   rank within the column stay editable.
 * - M5: labels replaces the labels by name (missing ones are created), addLabels and removeLabels
 *   change some; dueDate sets or clears the due date; parent sets (same project, one level:
 *   SubtaskDepth) or clears the parent; addBlockers and removeBlockers change what the task waits
 *   on (same project; a loop fails with DependencyLoop). Each records the whole list before and
 *   after.
 * - M6: ifStatus fails with TaskChanged when the stored status differs (nothing is written). Item
 *   operations (criteria.ts), plan and finalSummary change the work record; on a mirrored task
 *   each fails with TaskMirrored. An agent moving the task to In review or Done while an item is
 *   open after this request's operations fails with OpenItems; people are never refused.
 */
export async function updateTask(
  ctx: TaskContext,
  actor: Actor,
  input: z.input<typeof UpdateTaskInput>,
): Promise<Task> {
  const { key, project: narrow, ifUpdatedAt, ifStatus, ...patch } = parseInput(UpdateTaskInput, input);
  const view = viewOf(ctx);
  return ctx.db.transaction(async (tx) => {
    // Rank changes may renumber the column, ending a cycle moves tasks under the project lock, and
    // the blocker loop and subtask depth checks need a stable project: take it first for those
    // changes (see findTask).
    const { project: projectRow, task: current } = await findTask(tx, actor, key, {
      forUpdate: true,
      lockProject: patchNeedsProjectLock(patch),
      project: narrow,
    });
    authorize(actor, 'task.write', { type: 'project', projectId: projectRow.id });

    if (ifUpdatedAt) {
      const [check] = await tx
        .select({
          stale: sql<boolean>`date_trunc('milliseconds', ${task.updatedAt}) > ${ifUpdatedAt}::timestamptz`,
        })
        .from(task)
        .where(eq(task.id, current.id));
      if (check?.stale) throw new TaskChanged(await toTask(tx, projectRow, current, view));
    }
    if (ifStatus && ifStatus !== current.status) {
      const taskKey = formatTaskKey(projectRow.key, current.number, current.keySuffix);
      throw new TaskChanged(
        await toTask(tx, projectRow, current, view),
        `${taskKey} is in ${TASK_STATUS_LABELS[current.status]} now, not ${TASK_STATUS_LABELS[ifStatus]}`,
      );
    }

    const row = await applyTaskPatch(tx, ctx, actor, projectRow, current, patch);
    return toTask(tx, projectRow, row, view);
  });
}

/**
 * M5: one change for up to MAX_BULK_TASKS tasks of native projects, in one transaction: every task
 * changes or none does. Each changed task gets its own task.updated row; tasks that have the
 * values already get none. Rules:
 * - Any task of a project that mirrors Backlog.md fails the request with TaskMirrored.
 * - A milestone or cycle (not null) needs every task in one project (NotSameProject).
 * - Labels resolve by name per project (missing ones are created); a status change puts each task
 *   at the top of its new column.
 * - Locks: projects, then tasks, each in id order, so concurrent bulk changes can't deadlock.
 * - M6: an agent moving tasks to In review or Done fails with OpenItems when any of them has an
 *   open item; the issues name each refused task (path keys.<index>), and openItems lists the
 *   items when only one task is refused. Nothing changes then.
 * Returns every task as a list row, in the order of the keys sent.
 */
export async function bulkUpdateTasks(
  ctx: TaskContext,
  actor: Actor,
  input: z.input<typeof BulkUpdateTasksInput>,
): Promise<TaskBulkResult> {
  const { keys, ...patch } = parseInput(BulkUpdateTasksInput, input);
  return ctx.db.transaction(async (tx) => {
    const hits: { project: ProjectRow; task: TaskRow }[] = [];
    for (const key of keys) hits.push(await findTask(tx, actor, key));
    const projectIds = [...new Set(hits.map((hit) => hit.project.id))].sort();
    for (const projectId of projectIds) authorize(actor, 'task.write', { type: 'project', projectId });

    const mirrored = await mirroredProjectIds(tx, projectIds);
    const mirroredHit = hits.find((hit) => mirrored.has(hit.project.id));
    if (mirroredHit) {
      const source = await loadBacklogSource(tx, mirroredHit.project.id);
      const field = bulkOwnedField(patch);
      const key = formatTaskKey(mirroredHit.project.key, mirroredHit.task.number, mirroredHit.task.keySuffix);
      const file = await backlogFilePath(tx, source, { taskId: mirroredHit.task.id });
      throw new TaskMirrored(
        `${key} is mirrored from Backlog.md. Change several tasks at once in native projects only.`,
        {
          ...(field ? { field } : {}),
          ...(file ? { file } : {}),
          ...(mirroredHit.task.backlogId ? { backlogId: mirroredHit.task.backlogId } : {}),
        },
      );
    }
    if (projectIds.length > 1 && (patch.milestone || (patch.cycle !== undefined && patch.cycle !== null))) {
      const what = patch.milestone ? 'milestone' : 'cycle';
      throw new NotSameProject(`Pick tasks of one project to set a ${what} on all of them`, {
        issues: [{ path: what, message: 'The tasks are in different projects' }],
      });
    }

    const lockedProjects = await tx
      .select()
      .from(project)
      .where(inArray(project.id, projectIds))
      .orderBy(asc(project.id))
      .for('update');
    const projectById = new Map(lockedProjects.map((row) => [row.id, row]));
    const taskIds = [...new Set(hits.map((hit) => hit.task.id))].sort();
    const lockedTasks = await tx
      .select()
      .from(task)
      .where(inArray(task.id, taskIds))
      .orderBy(asc(task.id))
      .for('update');
    const taskById = new Map(lockedTasks.map((row) => [row.id, row]));
    await assertBulkMayFinish(tx, actor, hits, lockedTasks, patch.status);

    // Resolve the assignee once; applyTaskPatch then compares ids.
    const assignee = await resolveAssignee(tx, actor, patch.assignee);
    const updated = new Map<string, TaskRow>();
    for (const hit of hits) {
      if (updated.has(hit.task.id)) continue;
      const projectRow = projectById.get(hit.project.id);
      const current = taskById.get(hit.task.id);
      if (!projectRow || !current) throw new NotFound(`Task ${hit.task.id} not found`);
      const row = await applyTaskPatch(tx, ctx, actor, projectRow, current, {
        ...patch,
        ...(assignee === undefined ? {} : { assignee }),
      });
      updated.set(row.id, row);
    }

    const rows = hits.map((hit) => {
      const projectRow = projectById.get(hit.project.id) as ProjectRow;
      const row = updated.get(hit.task.id) as TaskRow;
      return {
        task: row,
        project: { id: projectRow.id, key: projectRow.key, name: projectRow.name },
        hasFinalSummary: row.finalSummary !== null,
      };
    });
    return TaskBulkResult.parse({
      items: await toListItems(tx, rows, todayIn(ctx), { inTransaction: true }),
    });
  });
}

/** M6: the finishing rule for a bulk status change (see bulkUpdateTasks). */
async function assertBulkMayFinish(
  tx: Tx,
  actor: Actor,
  hits: { project: ProjectRow; task: TaskRow }[],
  lockedTasks: TaskRow[],
  status: TaskStatus | undefined,
): Promise<void> {
  if (actor.kind !== 'agent' || !status || !FINISHING_STATUSES.has(status)) return;
  const moving = lockedTasks.filter((row) => row.status !== status).map((row) => row.id);
  const open = await openItemsByTask(tx, moving);
  if (open.size === 0) return;
  const refused = hits.flatMap((hit, index) => {
    const items = open.get(hit.task.id);
    return items
      ? [{ index, key: formatTaskKey(hit.project.key, hit.task.number, hit.task.keySuffix), items }]
      : [];
  });
  const seen = new Set<string>();
  const unique = refused.filter((entry) => !seen.has(entry.key) && seen.add(entry.key));
  const target = status === 'done' ? 'Done' : 'In review';
  const issues = unique.map((entry) => {
    const single = openItemsError(entry.key, status, entry.items);
    return { path: `keys.${entry.index}`, message: single.message };
  });
  const [first] = unique;
  if (unique.length === 1 && first) {
    throw new OpenItems(openItemsError(first.key, status, first.items).message, first.items, { issues });
  }
  throw new OpenItems(
    `${unique.map((entry) => entry.key).join(', ')} have open items, so no task moved to ${target}. Check or waive them first.`,
    [],
    { issues },
  );
}

/** The first field of a bulk change Backlog.md owns, for TaskMirrored; undefined for cycle only. */
function bulkOwnedField(patch: Omit<BulkUpdateTasksInput, 'keys'>): TaskOwnedField | undefined {
  if (patch.status !== undefined) return 'status';
  if (patch.priority !== undefined) return 'priority';
  if (patch.assignee !== undefined) return 'assignee';
  if (patch.milestone !== undefined) return 'milestone';
  if (patch.dueDate !== undefined) return 'dueDate';
  if (patch.addLabels !== undefined || patch.removeLabels !== undefined) return 'labels';
  return undefined;
}

/** Whether `selector` names the cycle `cycleId` already points at, without resolving current/next. */
async function sameCycle(tx: Tx, cycleId: string, selector: CycleSelector): Promise<boolean> {
  if (typeof selector !== 'number') return false;
  const [row] = await tx.select({ number: cycle.number }).from(cycle).where(eq(cycle.id, cycleId)).limit(1);
  return row?.number === selector;
}

// ---------------------------------------------------------------------------
// Backlog.md locks (M3)
// ---------------------------------------------------------------------------

/** How a TaskMirrored message names each owned field. */
const OWNED_FIELD_LABELS: Record<TaskOwnedField, string> = {
  title: 'title',
  description: 'description',
  status: 'status',
  priority: 'priority',
  assignee: 'assignee',
  milestone: 'milestone',
  createdAt: 'created date',
  labels: 'labels',
  dueDate: 'due date',
  blockedBy: 'blockers',
  criteria: 'criteria',
  doneItems: 'done items',
  plan: 'plan',
  finalSummary: 'final summary',
  parent: 'parent',
};

/** A change updateTask can make to a field of the task row (M6: plan and finalSummary included). */
type RowChange = Exclude<
  Extract<StoredChange, { field: TaskOwnedField | 'cycle' }>,
  { field: 'labels' | 'blockedBy' | 'parent' }
>;

/**
 * A change to a field Backlog.md owns, as the lock check sees it before anything is written:
 * label names, blocker task ids and the parent task id for the M5 relations, and the item
 * operations of a list for M6.
 */
type LockedChange =
  | RowChange
  | { field: 'labels'; to: string[] }
  | { field: 'blockedBy'; to: string[] }
  | { field: 'parent'; to: string | null }
  | { field: 'criteria' | 'doneItems'; ops: ItemOperations };

/** True for changes to fields Backlog.md owns (every task field but cycle). */
function isOwnedChange(change: StoredChange): change is RowChange {
  return (TASK_OWNED_FIELDS as readonly string[]).includes(change.field);
}

/** The Backlog.md value a mapping turns into `to`: a row chosen by name or by hand before a fallback. */
function mappedFrom<T extends { from: string; how: string }>(
  rows: T[] | undefined,
  matches: (row: T) => boolean,
) {
  const candidates = (rows ?? []).filter(matches);
  return (candidates.find((row) => row.how !== 'fallback') ?? candidates[0])?.from ?? null;
}

/**
 * The `backlog task edit` arguments that make the same change in Backlog.md, or a sentence when
 * the CLI has no flag for it. Flags from Backlog.md's CLI (src/cli.ts, configureEditCommand).
 */
async function editArguments(
  tx: Tx,
  source: BacklogSourceRow,
  change: LockedChange,
): Promise<{ flags: string } | { text: string }> {
  const mappings = source.mappings;
  switch (change.field) {
    case 'title':
      return { flags: `-t ${shellWord(change.to ?? '')}` };
    case 'description': {
      const text = change.to ?? '';
      const short = text.length <= 80 && !text.includes('\n');
      return { flags: `-d ${short ? shellWord(text) : '"<description>"'}` };
    }
    case 'status': {
      if (!change.to) return { text: 'Change status in the task file and push' };
      const status = change.to;
      const value = mappedFrom(mappings.status, (row) => row.to === status) ?? TASK_STATUS_LABELS[status];
      return { flags: `-s ${shellWord(value)}` };
    }
    case 'priority': {
      const priority = change.to ?? 'none';
      const value =
        mappedFrom(mappings.priority, (row) => row.to === priority) ??
        (priority === 'none' ? null : priority);
      return value
        ? { flags: `--priority ${shellWord(value)}` }
        : { text: 'Remove priority from the task file and push' };
    }
    case 'assignee': {
      if (!change.to) return { flags: '-a ""' };
      const userId = change.to;
      const mapped = mappedFrom(mappings.assignee, (row) => row.userId === userId);
      if (mapped) return { flags: `-a ${shellWord(mapped)}` };
      const member = (await loadUsers(tx, [userId])).get(userId);
      return { flags: `-a ${shellWord(`@${member?.name ?? 'name'}`)}` };
    }
    case 'milestone': {
      if (!change.to) return { flags: '--clear-milestone' };
      const [target] = await tx
        .select({ name: milestone.name, backlogId: milestone.backlogId })
        .from(milestone)
        .where(eq(milestone.id, change.to))
        .limit(1);
      return { flags: `-m ${shellWord(target?.backlogId ?? target?.name ?? '')}` };
    }
    case 'cycle':
      // Not owned (isOwnedChange leaves it out); here for completeness.
      return { text: 'Cycles are set here, not in Backlog.md' };
    case 'labels':
      return change.to.length === 0
        ? { flags: '--clear-labels' }
        : { flags: `-l ${shellWord(change.to.join(','))}` };
    case 'dueDate':
      return change.to ? { flags: `--due-date ${change.to}` } : { flags: '--clear-due-date' };
    case 'blockedBy': {
      if (change.to.length === 0) return { flags: '--clear-deps' };
      const rows = await tx
        .select({ id: task.id, backlogId: task.backlogId })
        .from(task)
        .where(inArray(task.id, change.to));
      const byId = new Map(rows.map((row) => [row.id, row.backlogId]));
      const ids = change.to.flatMap((id) => {
        const backlogId = byId.get(id);
        return backlogId ? [backlogId] : [];
      });
      return ids.length === change.to.length
        ? { flags: `--dep ${shellWord(ids.join(','))}` }
        : { text: 'Change dependencies in the task file and push' };
    }
    case 'parent':
      // Backlog.md's CLI has no flag for the parent.
      return { text: 'Change parent_task_id in the task file and push' };
    case 'plan':
    case 'finalSummary': {
      const [flag, name] = change.field === 'plan' ? ['--plan', 'plan'] : ['--final-summary', 'summary'];
      if (!change.to) return { text: `Remove the ${name} from the task file and push` };
      const short = change.to.length <= 80 && !change.to.includes('\n');
      return { flags: `${flag} ${short ? shellWord(change.to) : `"<${name}>"`}` };
    }
    case 'criteria':
    case 'doneItems':
      return itemEditArguments(change.field, change.ops);
  }
}

/** Backlog.md's `task edit` flags for item operations; waive, unwaive, edit and move have none. */
const ITEM_FLAGS = {
  criteria: { add: '--ac', check: '--check-ac', uncheck: '--uncheck-ac', remove: '--remove-ac' },
  doneItems: { add: '--dod', check: '--check-dod', uncheck: '--uncheck-dod', remove: '--remove-dod' },
} as const;

function itemEditArguments(
  field: 'criteria' | 'doneItems',
  ops: ItemOperations,
): { flags: string } | { text: string } {
  const unflagged = [ops.waive, ops.unwaive, ops.edit, ops.move].some((list) => (list?.length ?? 0) > 0);
  if (unflagged) {
    const name = field === 'criteria' ? 'acceptance criteria' : 'definition of done';
    return { text: `Change the ${name} in the task file and push` };
  }
  const flags = ITEM_FLAGS[field];
  return {
    flags: [
      ...(ops.add ?? []).map((text) => `${flags.add} ${shellWord(text)}`),
      ...(ops.check ?? []).map((number) => `${flags.check} ${number}`),
      ...(ops.uncheck ?? []).map((number) => `${flags.uncheck} ${number}`),
      ...(ops.remove ?? []).map((number) => `${flags.remove} ${number}`),
    ].join(' '),
  };
}

/** A `backlog task edit` (or `backlog draft edit`) hint for `change` on the task with `backlogId`. */
async function taskEditHint(
  tx: Tx,
  source: BacklogSourceRow,
  row: TaskRow,
  change: LockedChange,
): Promise<string> {
  const command = backlogEditCommand(row);
  const args = await editArguments(tx, source, change);
  return 'flags' in args && command ? `${command} ${args.flags}` : 'text' in args ? args.text : '';
}

/** TaskMirrored for `change` on a task of a mirrored project, with field, file, Backlog.md id and hint. */
async function taskMirrored(
  tx: Tx,
  projectRow: ProjectRow,
  row: TaskRow,
  source: BacklogSourceRow,
  change: LockedChange,
): Promise<TaskMirrored> {
  const key = formatTaskKey(projectRow.key, row.number, row.keySuffix);
  const file = await backlogFilePath(tx, source, { taskId: row.id });
  const hint = row.backlogId ? await taskEditHint(tx, source, row, change) : undefined;
  return new TaskMirrored(
    `${key} is mirrored from Backlog.md, so its ${OWNED_FIELD_LABELS[change.field as TaskOwnedField]} can't change here`,
    {
      field: change.field,
      ...(file ? { file } : {}),
      ...(row.backlogId ? { backlogId: row.backlogId } : {}),
      ...(hint ? { hint } : {}),
    },
  );
}

/** ProjectMirrored for a new task in a mirrored project: tasks are added in Backlog.md. */
function projectMirroredCreate(projectRow: ProjectRow, source: BacklogSourceRow | null, title: string) {
  const folder = source?.folder ?? source?.folderOverride ?? 'backlog';
  return new ProjectMirrored(
    `Tasks in ${projectRow.name} come from Backlog.md. Add a file under ${folder}/tasks/, or run backlog task create, and push. It shows up here after the next refresh.`,
    { hint: `backlog task create ${shellWord(title)}` },
  );
}
