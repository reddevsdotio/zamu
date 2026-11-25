// M6 work record: a task's acceptance criteria and definition-of-done items (task_item rows).
// - Item operations of PATCH /tasks/{key} are planned in memory, then written inside the task's
//   transaction. Per list: edits, checks, unchecks, waives and unwaives (numbers of the list before
//   the request), then removes, then moves in order (each on the list as it stands then), then adds
//   at the end. Every operation that changes something records one activity change with the item's
//   number and text, so history reads right after a reorder.
// - Numbers are positions counted from 1. Removes and moves renumber the list; the unique
//   (task_id, kind, position) constraint is deferred, so rows can pass through duplicates.
// - A waiver needs a reason; checking or unwaiving a waived item clears it.
// - The finishing rule: an agent can't move a task to In review or Done while an item is open
//   (OpenItems, 409 OPEN_ITEMS). People are never refused; the web app warns them first.
import {
  MAX_WORK_ITEMS,
  type OpenItem,
  type TaskStatus,
  type UpdateTaskInput,
  WORK_ITEM_CHANGE_PREFIXES,
  type WorkItem,
  type WorkItemKind,
  type WorkItemProgress,
} from '@zamu/contracts';
import { type DbOrTx, schema, type Tx } from '@zamu/db';
import { asc, eq, inArray, sql } from 'drizzle-orm';
import type { z } from 'zod';
import type { StoredWorkRecordChange } from './activity';
import type { Actor } from './authz';
import { Conflict, Invalid } from './errors';
import { loadUsers, userRef } from './internal';

const { taskItem } = schema;

export type TaskItemRow = typeof taskItem.$inferSelect;

/** The two lists in the order clients show them: criteria first. */
export const WORK_ITEM_LIST_KINDS = ['criterion', 'done'] as const satisfies readonly WorkItemKind[];

/** How messages name one item of each list. */
const ITEM_NAMES: Record<WorkItemKind, string> = { criterion: 'criterion', done: 'done item' };

/** The suffix of each list's operation fields in UpdateTaskInput (checkCriteria, checkDoneItems). */
const LIST_FIELDS: Record<WorkItemKind, 'Criteria' | 'DoneItems'> = {
  criterion: 'Criteria',
  done: 'DoneItems',
};

/** Statuses an agent can't move a task to while an item is open. */
export const FINISHING_STATUSES: ReadonlySet<TaskStatus> = new Set(['in_review', 'done']);

// ---------------------------------------------------------------------------
// Operations
// ---------------------------------------------------------------------------

/** The operations of one list in one request, as UpdateTaskInput carries them after parsing. */
export interface ItemOperations {
  add?: string[];
  check?: number[];
  uncheck?: number[];
  waive?: { number: number; reason: string }[];
  unwaive?: number[];
  edit?: { number: number; text: string }[];
  move?: { from: number; to: number }[];
  remove?: number[];
}

/** The operations of the `kind` list in an update input (addCriteria, checkDoneItems, ...). */
export function itemOperationsOf(input: Partial<UpdateTaskInput>, kind: WorkItemKind): ItemOperations {
  const list = LIST_FIELDS[kind];
  return {
    add: input[`add${list}`],
    check: input[`check${list}`],
    uncheck: input[`uncheck${list}`],
    waive: input[`waive${list}`],
    unwaive: input[`unwaive${list}`],
    edit: input[`edit${list}`],
    move: input[`move${list}`],
    remove: input[`remove${list}`],
  };
}

/** True when `ops` asks for anything (empty lists ask for nothing). */
export function hasItemOperations(ops: ItemOperations): boolean {
  return Object.values(ops).some((value) => Array.isArray(value) && value.length > 0);
}

/** One item of a planned list. `id` is null for items the request adds. */
export interface PlannedItem {
  id: string | null;
  text: string;
  state: TaskItemRow['state'];
  waivedReason: string | null;
  waivedById: string | null;
  source: TaskItemRow['source'];
}

/** A list after a request's operations, with the changes to record and the rows to delete. */
export interface ItemPlan {
  kind: WorkItemKind;
  items: PlannedItem[];
  changes: StoredWorkRecordChange[];
  removedIds: string[];
}

function invalidField(path: string, message: string): Invalid {
  return new Invalid(message, { issues: [{ path, message }] });
}

function plannedOf(row: TaskItemRow): PlannedItem {
  return {
    id: row.id,
    text: row.text,
    state: row.state,
    waivedReason: row.waivedReason,
    waivedById: row.waivedById,
    source: row.source,
  };
}

/** `count` items of a list in words: "1 criterion", "3 done items". */
function itemCount(kind: WorkItemKind, count: number): string {
  if (kind === 'criterion') return `${count} ${count === 1 ? 'criterion' : 'criteria'}`;
  return `${count} done ${count === 1 ? 'item' : 'items'}`;
}

/**
 * Applies `ops` to the `kind` list `rows` (in position order) in memory, as `actorId`. Throws
 * Invalid for a number the list doesn't have (path: the operation field) and for a list longer
 * than MAX_WORK_ITEMS. Operations that change nothing (checking a checked item, an edit to the
 * same text, a move to the same place) record nothing.
 */
export function planItemOperations(
  kind: WorkItemKind,
  rows: TaskItemRow[],
  ops: ItemOperations,
  actorId: string | null,
): ItemPlan {
  const prefix = WORK_ITEM_CHANGE_PREFIXES[kind];
  const list = LIST_FIELDS[kind];
  const name = ITEM_NAMES[kind];
  const changes: StoredWorkRecordChange[] = [];
  const record = (change: { field: string } & Record<string, unknown>) =>
    changes.push({ ...change, field: `${prefix}.${change.field}` } as StoredWorkRecordChange);

  // Numbers of the first phase and of removes refer to the list before the request.
  const before = rows.map(plannedOf);
  const at = (number: number, operation: string): PlannedItem => {
    const item = before[number - 1];
    if (!item) {
      throw invalidField(
        `${operation}${list}`,
        `There is no ${name} ${number}: the task has ${itemCount(kind, before.length)}`,
      );
    }
    return item;
  };

  for (const { number, text } of ops.edit ?? []) {
    const item = at(number, 'edit');
    if (item.text === text) continue;
    record({ field: 'edited', number, text, from: item.text });
    item.text = text;
  }
  for (const number of ops.check ?? []) {
    const item = at(number, 'check');
    if (item.state === 'checked') continue;
    Object.assign(item, { state: 'checked', waivedReason: null, waivedById: null });
    record({ field: 'checked', number, text: item.text });
  }
  for (const number of ops.uncheck ?? []) {
    const item = at(number, 'uncheck');
    // Only checked items uncheck; a waived item stays waived (unwaive it instead).
    if (item.state !== 'checked') continue;
    item.state = 'open';
    record({ field: 'unchecked', number, text: item.text });
  }
  for (const { number, reason } of ops.waive ?? []) {
    const item = at(number, 'waive');
    if (item.state === 'waived' && item.waivedReason === reason) continue;
    Object.assign(item, { state: 'waived', waivedReason: reason, waivedById: actorId });
    record({ field: 'waived', number, text: item.text, reason });
  }
  for (const number of ops.unwaive ?? []) {
    const item = at(number, 'unwaive');
    if (item.state !== 'waived') continue;
    Object.assign(item, { state: 'open', waivedReason: null, waivedById: null });
    record({ field: 'unwaived', number, text: item.text });
  }

  const removed = new Set<number>();
  for (const number of ops.remove ?? []) {
    const item = at(number, 'remove');
    removed.add(number);
    record({ field: 'removed', number, text: item.text });
  }
  const items = before.filter((_, index) => !removed.has(index + 1));
  const removedIds = before.flatMap((item, index) => (removed.has(index + 1) && item.id ? [item.id] : []));

  for (const { from, to } of ops.move ?? []) {
    for (const [value, path] of [
      [from, 'from'],
      [to, 'to'],
    ] as const) {
      if (value > items.length) {
        throw invalidField(
          `move${list}`,
          `Can't move ${path === 'from' ? `${name} ${value}` : `to ${value}`}: the list has ${itemCount(kind, items.length)} then`,
        );
      }
    }
    if (from === to) continue;
    const [item] = items.splice(from - 1, 1);
    if (!item) continue;
    items.splice(to - 1, 0, item);
    record({ field: 'moved', text: item.text, from, to });
  }

  for (const text of ops.add ?? []) {
    items.push({ id: null, text, state: 'open', waivedReason: null, waivedById: null, source: 'app' });
    record({ field: 'added', number: items.length, text });
  }
  if (items.length > MAX_WORK_ITEMS) {
    throw invalidField(
      `add${list}`,
      `A task holds ${MAX_WORK_ITEMS} ${kind === 'criterion' ? 'criteria' : 'done items'} or fewer; this would make ${items.length}`,
    );
  }
  return { kind, items, changes, removedIds };
}

/**
 * Writes a planned list of task `taskId`: deletes removed rows, inserts added ones and updates
 * rows whose position, text or state changed. `before` is the list the plan started from.
 */
export async function writeItemPlan(tx: Tx, taskId: string, before: TaskItemRow[], plan: ItemPlan) {
  if (plan.changes.length === 0 && plan.removedIds.length === 0) return;
  if (plan.removedIds.length > 0) await tx.delete(taskItem).where(inArray(taskItem.id, plan.removedIds));
  const byId = new Map(before.map((row) => [row.id, row]));
  const inserts: (typeof taskItem.$inferInsert)[] = [];
  for (const [index, item] of plan.items.entries()) {
    const position = index + 1;
    const values = {
      position,
      text: item.text,
      state: item.state,
      waivedReason: item.waivedReason,
      waivedById: item.waivedById,
    };
    const row = item.id ? byId.get(item.id) : undefined;
    if (!row) {
      inserts.push({ taskId, kind: plan.kind, source: item.source, ...values });
      continue;
    }
    const same =
      row.position === position &&
      row.text === item.text &&
      row.state === item.state &&
      row.waivedReason === item.waivedReason &&
      row.waivedById === item.waivedById;
    if (!same) {
      await tx
        .update(taskItem)
        .set({ ...values, updatedAt: sql`now()` })
        .where(eq(taskItem.id, row.id));
    }
  }
  if (inserts.length > 0) await tx.insert(taskItem).values(inserts);
}

// ---------------------------------------------------------------------------
// Reads
// ---------------------------------------------------------------------------

/** The items of tasks `taskIds`, both lists, in position order. */
export async function loadTaskItemRows(db: DbOrTx, taskIds: string[]): Promise<TaskItemRow[]> {
  if (taskIds.length === 0) return [];
  return db
    .select()
    .from(taskItem)
    .where(inArray(taskItem.taskId, taskIds))
    .orderBy(asc(taskItem.taskId), asc(taskItem.kind), asc(taskItem.position));
}

/** The `kind` list of one task's rows (as loadTaskItemRows returns them). */
export function itemsOfKind(rows: TaskItemRow[], kind: WorkItemKind): TaskItemRow[] {
  return rows.filter((row) => row.kind === kind);
}

/**
 * The two lists of a task in the contract shape, with waivers resolved to members. `locked` marks
 * every item of a task whose project mirrors Backlog.md (writes fail with TASK_MIRRORED).
 */
export async function toWorkItems(
  db: DbOrTx,
  rows: TaskItemRow[],
  locked: boolean,
): Promise<{ criteria: z.input<typeof WorkItem>[]; doneItems: z.input<typeof WorkItem>[] }> {
  const users = await loadUsers(
    db,
    rows.flatMap((row) => (row.waivedById ? [row.waivedById] : [])),
  );
  const map = (list: TaskItemRow[]) =>
    list.map((row, index) => {
      const waiver = row.waivedById ? users.get(row.waivedById) : undefined;
      return {
        number: index + 1,
        text: row.text,
        state: row.state,
        waivedReason: row.state === 'waived' ? row.waivedReason : null,
        waivedBy: row.state === 'waived' && waiver ? userRef(waiver) : null,
        locked,
      };
    });
  return { criteria: map(itemsOfKind(rows, 'criterion')), doneItems: map(itemsOfKind(rows, 'done')) };
}

const NO_PROGRESS: WorkItemProgress = { settled: 0, open: 0, waived: 0, total: 0 };

/** Counts of both lists per task id, in one grouped query. Tasks without items get zeros. */
export async function workItemProgressOf(
  db: DbOrTx,
  taskIds: string[],
): Promise<Map<string, { criteria: WorkItemProgress; done: WorkItemProgress }>> {
  const result = new Map<string, { criteria: WorkItemProgress; done: WorkItemProgress }>();
  if (taskIds.length === 0) return result;
  const rows = await db
    .select({
      taskId: taskItem.taskId,
      kind: taskItem.kind,
      total: sql<number>`count(*)`.mapWith(Number),
      open: sql<number>`count(*) filter (where ${taskItem.state} = 'open')`.mapWith(Number),
      waived: sql<number>`count(*) filter (where ${taskItem.state} = 'waived')`.mapWith(Number),
    })
    .from(taskItem)
    .where(inArray(taskItem.taskId, [...new Set(taskIds)]))
    .groupBy(taskItem.taskId, taskItem.kind);
  for (const row of rows) {
    const entry = result.get(row.taskId) ?? { criteria: NO_PROGRESS, done: NO_PROGRESS };
    const progress = { settled: row.total - row.open, open: row.open, waived: row.waived, total: row.total };
    result.set(
      row.taskId,
      row.kind === 'criterion' ? { ...entry, criteria: progress } : { ...entry, done: progress },
    );
  }
  return result;
}

/** Progress of one task from workItemProgressOf, zeros when it has no items. */
export function progressFor(
  progress: Map<string, { criteria: WorkItemProgress; done: WorkItemProgress }>,
  taskId: string,
): { criteria: WorkItemProgress; done: WorkItemProgress } {
  return progress.get(taskId) ?? { criteria: NO_PROGRESS, done: NO_PROGRESS };
}

// ---------------------------------------------------------------------------
// The finishing rule
// ---------------------------------------------------------------------------

/**
 * An agent moved a task to In review or Done while criteria or done items are open (409
 * OPEN_ITEMS). `openItems` lists them, criteria first, each list by number. In a bulk change the
 * issues name each refused task.
 */
export class OpenItems extends Conflict {
  readonly problemCode = 'OPEN_ITEMS' as const;
  readonly openItems: OpenItem[];

  constructor(
    message: string,
    openItems: OpenItem[],
    options?: { issues?: { path: string; message: string }[] },
  ) {
    super(message, options);
    this.openItems = openItems;
  }
}

/** The open items of a task's lists, criteria first, each by number. */
export function openItemsOf(lists: Record<WorkItemKind, Pick<PlannedItem, 'text' | 'state'>[]>): OpenItem[] {
  return WORK_ITEM_LIST_KINDS.flatMap((kind) =>
    lists[kind].flatMap((item, index) =>
      item.state === 'open' ? [{ kind, number: index + 1, text: item.text }] : [],
    ),
  );
}

/** "criterion 2 and done item 1": the open items in words. */
export function describeOpenItems(items: OpenItem[]): string {
  const names = items.map((item) => `${ITEM_NAMES[item.kind]} ${item.number}`);
  if (names.length <= 1) return names.join('');
  return `${names.slice(0, -1).join(', ')} and ${names.at(-1)}`;
}

/** Whether the finishing rule applies: an agent moving a task into In review or Done. */
export function finishingRuleApplies(actor: Actor, from: TaskStatus, to: TaskStatus | undefined): boolean {
  return actor.kind === 'agent' && to !== undefined && to !== from && FINISHING_STATUSES.has(to);
}

/** OpenItems for moving task `key` to `status` with `items` open. */
export function openItemsError(key: string, status: TaskStatus, items: OpenItem[]): OpenItems {
  const target = status === 'done' ? 'Done' : 'In review';
  return new OpenItems(
    `${key} has open items: ${describeOpenItems(items)}. Check or waive them before moving it to ${target}.`,
    items,
  );
}

/** The open items of each task among `taskIds` that has any, from the stored lists. */
export async function openItemsByTask(db: DbOrTx, taskIds: string[]): Promise<Map<string, OpenItem[]>> {
  const rows = await loadTaskItemRows(db, taskIds);
  const result = new Map<string, OpenItem[]>();
  for (const taskId of new Set(rows.map((row) => row.taskId))) {
    const own = rows.filter((row) => row.taskId === taskId);
    const open = openItemsOf({ criterion: itemsOfKind(own, 'criterion'), done: itemsOfKind(own, 'done') });
    if (open.length > 0) result.set(taskId, open);
  }
  return result;
}
