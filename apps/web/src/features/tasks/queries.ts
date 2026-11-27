import {
  type InfiniteData,
  type QueryClient,
  type QueryKey,
  queryOptions,
  useMutation,
  useQueryClient,
} from '@tanstack/react-query';
import {
  type AssigneeRef,
  type BulkUpdateTasksInput,
  type CheckAgain,
  type CreateTaskInput,
  type CycleRef,
  type Home,
  isOpenStatus,
  type Label,
  type ListTasksInput,
  MAX_BULK_TASKS,
  MAX_TASK_LIST_LIMIT,
  type MilestoneRef,
  type Priority,
  type RelatedTask,
  type StatusCounts,
  type Task,
  type TaskBulkResult,
  type TaskListItem,
  type TaskListPage,
  type TaskStatus,
  type TaskWave,
  type UpdateTaskInput,
} from '@zamu/contracts';
import type { z } from 'zod';
// Pure helpers only (no runtime import of board/queries, which imports this module).
import {
  findCard,
  insertCard,
  removeCard,
  replaceCard,
  shiftCounts,
  shiftedCounts,
} from '~/features/board/board-cache';
import { progressOf as workProgressOf } from '~/features/work-record/ops';
import type { WorkspaceApi } from '~/lib/orpc';
import { useApi } from '~/lib/workspace';
import { retryOnce, withTimeout } from './errors';

// Data for the task screens. Lists load every page (300 tasks are two requests), so grouping, counts and
// J/K always see the whole project. Edits are optimistic and roll back when the server refuses them:
// every cached copy of a task changes at once (the detail, lists, board columns, Home), and the
// queries refetch when the server has answered.

/** A board column's cache: pages of tasks.list (features/board/queries.ts). */
type BoardColumnData = InfiniteData<TaskListPage, unknown>;

/** A request that has not answered after this long shows the error banner. */
export const REQUEST_TIMEOUT_MS = 20_000;

export interface TaskListData {
  items: TaskListItem[];
  counts: StatusCounts;
}

type ListInput = Omit<z.input<typeof ListTasksInput>, 'limit' | 'cursor'>;

/** Fetches every page of tasks.list for one filter set. */
export async function fetchAllTasks(
  api: WorkspaceApi,
  input: ListInput,
  signal?: AbortSignal,
): Promise<TaskListData> {
  const items: TaskListItem[] = [];
  let counts: StatusCounts | undefined;
  let cursor: string | undefined;
  do {
    const page = await api.client.tasks.list(
      { ...input, limit: MAX_TASK_LIST_LIMIT, ...(cursor ? { cursor } : {}) },
      { signal },
    );
    items.push(...page.items);
    counts ??= page.counts;
    cursor = page.nextCursor ?? undefined;
  } while (cursor);
  return { items, counts: counts ?? emptyCounts() };
}

export function emptyCounts(): StatusCounts {
  return { backlog: 0, todo: 0, in_progress: 0, in_review: 0, done: 0, canceled: 0 };
}

/** Every task of a project matching `input`, across pages. Keyed under orpc.tasks.list for invalidation. */
export function taskListQuery(api: WorkspaceApi, input: ListInput) {
  return queryOptions({
    queryKey: [...api.orpc.tasks.list.key({ type: 'query', input }), 'all-pages'] as const,
    queryFn: ({ signal }) => fetchAllTasks(api, input, withTimeout(signal, REQUEST_TIMEOUT_MS)),
    retry: retryOnce,
    // Keep the previous rows on screen while a new search or filter loads, within the same project.
    placeholderData: (previous, previousQuery) => {
      const previousInput = (previousQuery?.queryKey[1] as { input?: ListInput } | undefined)?.input;
      return previousInput?.project === input.project ? previous : undefined;
    },
  });
}

export function taskQuery(api: WorkspaceApi, key: string) {
  return api.orpc.tasks.get.queryOptions({
    input: { key },
    retry: retryOnce,
  });
}

export function activityQuery(api: WorkspaceApi, key: string) {
  return api.orpc.tasks.activity.queryOptions({ input: { key }, retry: retryOnce });
}

/** Activity and comments of a task, oldest first. */
export function timelineQuery(api: WorkspaceApi, key: string) {
  return api.orpc.tasks.timeline.queryOptions({ input: { key }, retry: retryOnce });
}

/** Milestones of a project, with progress, for the milestone pickers. */
export function milestonesQuery(api: WorkspaceApi, project: string) {
  return api.orpc.milestones.list.queryOptions({ input: { project }, retry: retryOnce });
}

/** Cycles of a project, oldest first, for the cycle pickers. */
export function cyclesQuery(api: WorkspaceApi, project: string) {
  return api.orpc.cycles.list.queryOptions({ input: { project }, retry: retryOnce });
}

export const projectsQuery = (api: WorkspaceApi) => api.orpc.projects.list.queryOptions({ retry: retryOnce });
export const membersQuery = (api: WorkspaceApi) =>
  api.orpc.members.list.queryOptions({ retry: retryOnce, staleTime: 60_000 });
export const meQuery = (api: WorkspaceApi) =>
  api.orpc.me.get.queryOptions({ retry: retryOnce, staleTime: 5 * 60_000 });

// ---------------------------------------------------------------------------
// Optimistic edits
// ---------------------------------------------------------------------------

/**
 * Fields an edit can change, with references in the shape the screens display (the assignee, labels
 * and related tasks as objects; the request sends ids, names and keys).
 */
export interface TaskPatch {
  title?: string;
  description?: string | null;
  status?: TaskStatus;
  priority?: Priority;
  assignee?: AssigneeRef | null;
  /** The new milestone (sent as its id), or null to clear it. */
  milestone?: MilestoneRef | null;
  /** The new cycle (sent as its number), or null to clear it. */
  cycle?: CycleRef | null;
  /** M5: replaces every label (sent by name). Not with addLabels or removeLabels. */
  labels?: Label[];
  /** M5: labels to add (sent by name; the project's labels, so the cache can show their colour). */
  addLabels?: Label[];
  /** M5: label names to take off, ignoring case. */
  removeLabels?: string[];
  /** M5: YYYY-MM-DD, or null to clear it. */
  dueDate?: string | null;
  /** M5: the new parent (sent as its key), or null to make the task top level. */
  parent?: RelatedTask | null;
  /** M5: tasks this one starts waiting on (sent as keys). */
  addBlockers?: RelatedTask[];
  /** M5: keys of blockers to drop. */
  removeBlockers?: string[];
  /** M7: the day to look at the task again with its reason, or null to clear it. One task at a time. */
  checkAgain?: CheckAgain | null;
  /**
   * M8: the wave of the task's milestone (sent as its id), or null to take it out. A milestone change
   * without a wave takes the task out of its wave, as the server does.
   */
  wave?: TaskWave | null;
}

/** The fields POST /tasks/bulk can change (native projects only). */
export type BulkTaskPatch = Pick<
  TaskPatch,
  'status' | 'priority' | 'assignee' | 'milestone' | 'cycle' | 'dueDate' | 'addLabels' | 'removeLabels'
>;

export interface UpdateTaskVariables {
  key: string;
  patch: TaskPatch;
  /** The updatedAt the caller last saw; a newer task fails with TASK_CHANGED. */
  ifUpdatedAt?: string;
}

/** Any cached shape of one task: the detail, or a row of a list, board or Home. */
export type CachedTask = Task | TaskListItem;

const isFullTask = (item: CachedTask): item is Task => 'createdBy' in item;

function isListData(value: unknown): value is TaskListData {
  return (
    typeof value === 'object' &&
    value !== null &&
    Array.isArray((value as TaskListData).items) &&
    typeof (value as TaskListData).counts === 'object'
  );
}

function isPagedData(value: unknown): value is BoardColumnData {
  return (
    typeof value === 'object' &&
    value !== null &&
    Array.isArray((value as BoardColumnData).pages) &&
    (value as BoardColumnData).pages.every((page) => isListData(page))
  );
}

function isHomeData(value: unknown): value is Home {
  return (
    typeof value === 'object' &&
    value !== null &&
    Array.isArray((value as Home).groups) &&
    typeof (value as Home).tab === 'string'
  );
}

const byName = (a: { name: string }, b: { name: string }) =>
  a.name.localeCompare(b.name, undefined, { sensitivity: 'base' });
const lower = (name: string) => name.toLocaleLowerCase();

/** The labels after a patch: replaced, or with some added and removed (ignoring case), by name. */
export function patchedLabels(current: readonly Label[], patch: TaskPatch): Label[] {
  if (patch.labels) return [...patch.labels].sort(byName);
  const removed = new Set((patch.removeLabels ?? []).map(lower));
  const kept = current.filter((label) => !removed.has(lower(label.name)));
  for (const label of patch.addLabels ?? []) {
    if (!kept.some((other) => lower(other.name) === lower(label.name))) kept.push(label);
  }
  return kept.sort(byName);
}

const touchesLabels = (patch: TaskPatch) =>
  patch.labels !== undefined || patch.addLabels !== undefined || patch.removeLabels !== undefined;
const touchesBlockers = (patch: TaskPatch) =>
  patch.addBlockers !== undefined || patch.removeBlockers !== undefined;
const touchesRelations = (patch: TaskPatch) => patch.parent !== undefined || touchesBlockers(patch);

/**
 * One cached task with a patch applied: the fields, the labels, the parent (`parentKey` on rows),
 * blockers and the blocked flag. Rows don't list their blockers: adding an open one marks them
 * blocked, and the refetch after the save settles the rest.
 */
export function applyTaskPatch<T extends CachedTask>(item: T, patch: TaskPatch, updatedAt?: string): T {
  const next: CachedTask = { ...item };
  if (patch.title !== undefined) next.title = patch.title;
  if (patch.description !== undefined && isFullTask(next)) next.description = patch.description;
  if (patch.status !== undefined) next.status = patch.status;
  if (patch.priority !== undefined) next.priority = patch.priority;
  if (patch.assignee !== undefined) next.assignee = patch.assignee;
  if (patch.milestone !== undefined) next.milestone = patch.milestone;
  if (patch.cycle !== undefined) next.cycle = patch.cycle;
  if (touchesLabels(patch)) next.labels = patchedLabels(item.labels ?? [], patch);
  if (patch.dueDate !== undefined) next.dueDate = patch.dueDate;
  if (patch.checkAgain !== undefined) next.checkAgain = patch.checkAgain;
  if (patch.wave !== undefined) next.wave = patch.wave;
  else if (patch.milestone !== undefined && (patch.milestone?.id ?? null) !== (item.milestone?.id ?? null)) {
    next.wave = null;
  }
  if (patch.parent !== undefined) {
    if (isFullTask(next)) next.parent = patch.parent;
    else next.parentKey = patch.parent?.key ?? null;
  }
  if (touchesBlockers(patch)) {
    if (isFullTask(next)) {
      const removed = new Set(patch.removeBlockers ?? []);
      const blockers = (next.blockedBy ?? []).filter((blocker) => !blocker || !removed.has(blocker.key));
      for (const blocker of patch.addBlockers ?? []) {
        if (!blockers.some((other) => other?.key === blocker.key)) blockers.push(blocker);
      }
      next.blockedBy = blockers;
      next.blocked = blockers.some((blocker) => blocker !== null && isOpenStatus(blocker.status));
    } else if (patch.addBlockers?.some((blocker) => isOpenStatus(blocker.status))) {
      next.blocked = true;
    }
  }
  if (updatedAt) next.updatedAt = updatedAt;
  return next as T;
}

/** The patch that puts back what `patch` changed on `before` (the Undo of a toast). */
export function inversePatch(before: CachedTask, patch: TaskPatch): TaskPatch {
  const inverse: TaskPatch = {};
  if (patch.title !== undefined) inverse.title = before.title;
  if (patch.description !== undefined && isFullTask(before)) inverse.description = before.description;
  if (patch.status !== undefined) inverse.status = before.status;
  if (patch.priority !== undefined) inverse.priority = before.priority;
  if (patch.assignee !== undefined) inverse.assignee = before.assignee;
  if (patch.milestone !== undefined) inverse.milestone = before.milestone;
  if (patch.cycle !== undefined) inverse.cycle = before.cycle;
  if (patch.dueDate !== undefined) inverse.dueDate = before.dueDate ?? null;
  if (patch.checkAgain !== undefined) inverse.checkAgain = before.checkAgain ?? null;
  if (patch.wave !== undefined) inverse.wave = before.wave ?? null;
  // Undoing a milestone change puts the task back in the wave it left.
  else if (patch.milestone !== undefined && before.wave) inverse.wave = before.wave;
  const labels = before.labels ?? [];
  const has = (name: string) => labels.some((label) => lower(label.name) === lower(name));
  if (patch.labels) inverse.labels = [...labels];
  else {
    const added = (patch.addLabels ?? []).filter((label) => !has(label.name)).map((label) => label.name);
    const removed = labels.filter((label) =>
      (patch.removeLabels ?? []).some((name) => lower(name) === lower(label.name)),
    );
    if (added.length) inverse.removeLabels = added;
    if (removed.length) inverse.addLabels = removed;
  }
  if (patch.parent !== undefined) {
    inverse.parent = isFullTask(before)
      ? (before.parent ?? null)
      : before.parentKey
        ? relatedStub(before.parentKey)
        : null;
  }
  if (touchesBlockers(patch)) {
    const current = isFullTask(before) ? (before.blockedBy ?? []) : [];
    const isBlocker = (key: string) => current.some((blocker) => blocker?.key === key);
    const added = (patch.addBlockers ?? []).filter((blocker) => !isBlocker(blocker.key));
    const removed = current.filter(
      (blocker): blocker is RelatedTask =>
        blocker !== null && (patch.removeBlockers ?? []).includes(blocker.key),
    );
    if (added.length) inverse.removeBlockers = added.map((blocker) => blocker.key);
    if (removed.length) inverse.addBlockers = removed;
  }
  return inverse;
}

/** True when the patch changes nothing on `item` (the same status, a label it already has, …). */
export function isNoopPatch(item: CachedTask, patch: TaskPatch): boolean {
  const after = applyTaskPatch(item, patch);
  const id = (value: { id: string } | null | undefined) => value?.id ?? null;
  const names = (labels: readonly Label[] | undefined) =>
    (labels ?? []).map((label) => lower(label.name)).join(',');
  const blockers = (task: CachedTask) =>
    isFullTask(task) ? (task.blockedBy ?? []).map((blocker) => blocker?.key ?? '').join(',') : '';
  const parent = (task: CachedTask) =>
    isFullTask(task) ? (task.parent?.key ?? null) : (task.parentKey ?? null);
  return (
    after.title === item.title &&
    after.status === item.status &&
    after.priority === item.priority &&
    id(after.assignee) === id(item.assignee) &&
    id(after.milestone) === id(item.milestone) &&
    id(after.cycle) === id(item.cycle) &&
    names(after.labels) === names(item.labels) &&
    (after.dueDate ?? null) === (item.dueDate ?? null) &&
    sameCheckAgain(after.checkAgain, item.checkAgain) &&
    id(after.wave) === id(item.wave) &&
    parent(after) === parent(item) &&
    blockers(after) === blockers(item) &&
    // Rows don't list their blockers: a blocker change on a row always goes to the server.
    !(touchesBlockers(patch) && !isFullTask(item)) &&
    !(patch.description !== undefined && isFullTask(item) && patch.description !== item.description)
  );
}

/** M7: the same check-again day and reason (both unset counts as the same). */
function sameCheckAgain(a: CheckAgain | null | undefined, b: CheckAgain | null | undefined): boolean {
  return (a?.on ?? null) === (b?.on ?? null) && (a?.reason ?? null) === (b?.reason ?? null);
}

/** A related task known only by key (a row's parentKey): enough to send and to undo. */
function relatedStub(key: string): RelatedTask {
  return { key, title: '', status: 'todo', assignee: null };
}

/** A cached task as another task's relation shows it. */
export function relatedOf(item: CachedTask): RelatedTask {
  return {
    key: item.key,
    title: item.title,
    status: item.status,
    assignee: item.assignee
      ? { id: item.assignee.id, name: item.assignee.name, kind: item.assignee.kind }
      : null,
  };
}

/**
 * Applies a patch to one cached list: the row's fields, and the per-status counts when the status moves.
 * Kept for the M1–M4 callers; the optimistic edits use applyTaskPatch.
 */
export function patchList(
  data: TaskListData,
  key: string,
  patch: TaskPatch,
  previousStatus: TaskStatus | undefined,
  updatedAt: string,
): TaskListData {
  const items = data.items.map((item) => (item.key === key ? applyTaskPatch(item, patch, updatedAt) : item));
  let counts = data.counts;
  if (patch.status && previousStatus && patch.status !== previousStatus) {
    counts = {
      ...counts,
      [previousStatus]: Math.max(0, counts[previousStatus] - 1),
      [patch.status]: counts[patch.status] + 1,
    };
  }
  return { ...data, items, counts };
}

/** The tasks.update input for a patch. */
export function toUpdateInput({ key, patch, ifUpdatedAt }: UpdateTaskVariables) {
  return {
    key,
    ...(patch.title !== undefined ? { title: patch.title } : {}),
    ...(patch.description !== undefined ? { description: patch.description } : {}),
    ...(patch.status !== undefined ? { status: patch.status } : {}),
    ...(patch.priority !== undefined ? { priority: patch.priority } : {}),
    ...(patch.assignee !== undefined ? { assignee: patch.assignee?.id ?? null } : {}),
    ...(patch.milestone !== undefined ? { milestone: patch.milestone?.id ?? null } : {}),
    ...(patch.cycle !== undefined ? { cycle: patch.cycle?.number ?? null } : {}),
    ...(patch.labels !== undefined ? { labels: patch.labels.map((label) => label.name) } : {}),
    ...(patch.addLabels?.length ? { addLabels: patch.addLabels.map((label) => label.name) } : {}),
    ...(patch.removeLabels?.length ? { removeLabels: patch.removeLabels } : {}),
    ...(patch.dueDate !== undefined ? { dueDate: patch.dueDate } : {}),
    ...(patch.parent !== undefined ? { parent: patch.parent?.key ?? null } : {}),
    ...(patch.addBlockers?.length ? { addBlockers: patch.addBlockers.map((task) => task.key) } : {}),
    ...(patch.removeBlockers?.length ? { removeBlockers: patch.removeBlockers } : {}),
    ...(patch.checkAgain !== undefined
      ? { checkAgain: patch.checkAgain ? { on: patch.checkAgain.on, reason: patch.checkAgain.reason } : null }
      : {}),
    ...(patch.wave !== undefined ? { wave: patch.wave?.id ?? null } : {}),
    ...(ifUpdatedAt ? { ifUpdatedAt } : {}),
  } satisfies z.input<typeof UpdateTaskInput>;
}

/** The tasks.bulkUpdate input for a patch. */
export function toBulkInput(keys: readonly string[], patch: BulkTaskPatch) {
  return {
    keys: [...keys],
    ...(patch.status !== undefined ? { status: patch.status } : {}),
    ...(patch.priority !== undefined ? { priority: patch.priority } : {}),
    ...(patch.assignee !== undefined ? { assignee: patch.assignee?.id ?? null } : {}),
    ...(patch.milestone !== undefined ? { milestone: patch.milestone?.id ?? null } : {}),
    ...(patch.cycle !== undefined ? { cycle: patch.cycle?.number ?? null } : {}),
    ...(patch.dueDate !== undefined ? { dueDate: patch.dueDate } : {}),
    ...(patch.addLabels?.length ? { addLabels: patch.addLabels.map((label) => label.name) } : {}),
    ...(patch.removeLabels?.length ? { removeLabels: patch.removeLabels } : {}),
  } satisfies z.input<typeof BulkUpdateTasksInput>;
}

// ── Cache walking ───────────────────────────────────────────────────────────────────────────────────

/** Saved cache entries, put back when the server refuses the change. */
export interface CacheSnapshot {
  entries: [QueryKey, unknown][];
  /** Each changed task as it was before (detail when cached, else a row), by key. */
  before: Map<string, CachedTask>;
}

type Edit = <T extends CachedTask>(item: T) => T;

/** The latest cached copy of a task: the detail when cached, else the first row found. */
export function cachedTask(api: WorkspaceApi, queryClient: QueryClient, key: string): CachedTask | undefined {
  const task = queryClient.getQueryData(api.orpc.tasks.get.queryKey({ input: { key } }));
  if (task) return task;
  for (const [, data] of queryClient.getQueriesData({ queryKey: api.orpc.tasks.list.key() })) {
    const items = isListData(data)
      ? data.items
      : isPagedData(data)
        ? data.pages.flatMap((page) => page.items)
        : [];
    const found = items.find((item) => item.key === key);
    if (found) return found;
  }
  for (const [, data] of queryClient.getQueriesData({ queryKey: api.orpc.home.key() })) {
    if (!isHomeData(data)) continue;
    for (const group of data.groups) {
      const found = group.items.find((item) => item.task.key === key);
      if (found) return found.task;
    }
  }
  return undefined;
}

/** The board column a cached infinite list holds: the single status of its input (board columns). */
function columnStatus(queryKey: QueryKey): TaskStatus | undefined {
  const status = (queryKey[1] as { input?: { status?: unknown } } | undefined)?.input?.status;
  return Array.isArray(status) && status.length === 1 ? (status[0] as TaskStatus) : undefined;
}

function editList(data: TaskListData, edits: ReadonlyMap<string, Edit>): TaskListData {
  let counts = data.counts;
  let changed = false;
  const items = data.items.map((item) => {
    const edit = edits.get(item.key);
    if (!edit) return item;
    changed = true;
    const next = edit(item);
    if (next.status !== item.status) counts = shiftedCounts(counts, item.status, next.status);
    return next;
  });
  return changed ? { ...data, items, counts } : data;
}

function editColumn(
  queryKey: QueryKey,
  data: BoardColumnData,
  edits: ReadonlyMap<string, Edit>,
  before: ReadonlyMap<string, CachedTask>,
): BoardColumnData {
  const status = columnStatus(queryKey);
  let next = data;
  for (const [key, edit] of edits) {
    const current = findCard(next, key);
    const known = current ?? before.get(key);
    if (!known) continue;
    const card = edit(toListItem(known));
    if (status && known.status !== card.status) {
      next = shiftCounts(next, known.status, card.status);
      if (current && card.status !== status) next = removeCard(next, key);
      else if (!current && card.status === status) next = insertCard(next, card, 'rank');
      else if (current) next = replaceCard(next, card);
    } else if (current) {
      next = replaceCard(next, card);
    }
  }
  return next;
}

function editHome(data: Home, edits: ReadonlyMap<string, Edit>): Home {
  let changed = false;
  const groups = data.groups.map((group) => {
    if (!group.items.some((item) => edits.has(item.task.key))) return group;
    changed = true;
    return {
      ...group,
      items: group.items.map((item) => {
        const edit = edits.get(item.task.key);
        return edit ? { ...item, task: edit(item.task) } : item;
      }),
    };
  });
  return changed ? { ...data, groups } : data;
}

/** A full task as a row (the shape lists, boards and Home cache). */
export function toListItem(task: CachedTask): TaskListItem {
  if (!isFullTask(task)) return task;
  const {
    description: _d,
    createdBy: _c,
    createdOnBehalfOf: _o,
    backlog,
    parent,
    subtasks: _s,
    blockedBy: _b,
    blocks: _r,
    criteria,
    doneItems,
    plan: _plan,
    planMeta: _planMeta,
    finalSummary,
    finalSummaryMeta: _summaryMeta,
    ...item
  } = task;
  return {
    ...item,
    ...(backlog !== undefined ? { backlogId: backlog?.id ?? null } : {}),
    ...(parent !== undefined ? { parentKey: parent?.key ?? null } : {}),
    // M6: rows carry counts, not the lists.
    ...(criteria !== undefined ? { criteriaProgress: workProgressOf(criteria) } : {}),
    ...(doneItems !== undefined ? { doneProgress: workProgressOf(doneItems) } : {}),
    ...(finalSummary !== undefined ? { hasFinalSummary: Boolean(finalSummary) } : {}),
  };
}

/**
 * Applies edits to every cached copy of the tasks: details, lists (counts follow status changes),
 * board columns (cards move between status columns) and Home. Returns what to put back on error.
 */
export function editTaskCaches(
  api: WorkspaceApi,
  queryClient: QueryClient,
  edits: ReadonlyMap<string, Edit>,
): CacheSnapshot {
  const entries: [QueryKey, unknown][] = [];
  const before = new Map<string, CachedTask>();
  for (const key of edits.keys()) {
    const found = cachedTask(api, queryClient, key);
    if (found) before.set(key, found);
  }
  const save = (queryKey: QueryKey, data: unknown, next: unknown) => {
    if (next === data) return;
    entries.push([queryKey, data]);
    queryClient.setQueryData(queryKey, next);
  };
  for (const [key, edit] of edits) {
    const queryKey = api.orpc.tasks.get.queryKey({ input: { key } });
    const task = queryClient.getQueryData(queryKey);
    if (task) save(queryKey, task, edit(task));
  }
  for (const [queryKey, data] of queryClient.getQueriesData({ queryKey: api.orpc.tasks.list.key() })) {
    if (isListData(data)) save(queryKey, data, editList(data, edits));
    else if (isPagedData(data)) save(queryKey, data, editColumn(queryKey, data, edits, before));
  }
  for (const [queryKey, data] of queryClient.getQueriesData({ queryKey: api.orpc.home.key() })) {
    if (isHomeData(data)) save(queryKey, data, editHome(data, edits));
  }
  return { entries, before };
}

/** Puts the saved entries back, newest change last. */
export function restoreTaskCaches(queryClient: QueryClient, snapshot: CacheSnapshot | undefined) {
  if (!snapshot) return;
  for (const [queryKey, data] of [...snapshot.entries].reverse()) queryClient.setQueryData(queryKey, data);
}

function progressOf(subtasks: readonly RelatedTask[]): { done: number; total: number } {
  const counted = subtasks.filter((task) => task.status !== 'canceled');
  return { done: counted.filter((task) => task.status === 'done').length, total: counted.length };
}

/** Edits of the other end of a relation: the parent's subtasks, a blocker's "Blocks" list. */
function relativeEdits(before: CachedTask | undefined, key: string, patch: TaskPatch): Map<string, Edit> {
  const edits = new Map<string, Edit>();
  if (!before) return edits;
  const self = relatedOf(applyTaskPatch(before, patch));
  const counted = self.status !== 'canceled';
  if (patch.parent !== undefined) {
    const oldKey = isFullTask(before) ? (before.parent?.key ?? null) : (before.parentKey ?? null);
    const newKey = patch.parent?.key ?? null;
    if (oldKey !== newKey) {
      const change =
        (delta: 1 | -1): Edit =>
        (item) => {
          if (isFullTask(item)) {
            const others = (item.subtasks ?? []).filter((task) => task.key !== key);
            const subtasks =
              delta === 1 ? [...others, self].sort((a, b) => a.key.localeCompare(b.key)) : others;
            return { ...item, subtasks, subtaskProgress: progressOf(subtasks) };
          }
          const progress = item.subtaskProgress ?? { done: 0, total: 0 };
          if (!counted) return item;
          return {
            ...item,
            subtaskProgress: {
              total: Math.max(0, progress.total + delta),
              done: Math.max(0, progress.done + (self.status === 'done' ? delta : 0)),
            },
          };
        };
      if (oldKey) edits.set(oldKey, change(-1));
      if (newKey) edits.set(newKey, change(1));
    }
  }
  const blocks =
    (add: boolean): Edit =>
    (item) => {
      if (!isFullTask(item)) return item;
      const others = (item.blocks ?? []).filter((task) => task?.key !== key);
      return { ...item, blocks: add ? [...others, self] : others };
    };
  for (const blocker of patch.addBlockers ?? []) edits.set(blocker.key, blocks(true));
  for (const blocker of patch.removeBlockers ?? []) edits.set(blocker, blocks(false));
  return edits;
}

/**
 * Invalidates everything a task change can affect: the task, its activity and timeline, lists and
 * board columns, project counts, milestone and cycle progress, and Home.
 */
export function invalidateTask(api: WorkspaceApi, queryClient: QueryClient, key: string) {
  return Promise.all([
    queryClient.invalidateQueries({ queryKey: api.orpc.tasks.get.key({ input: { key } }) }),
    queryClient.invalidateQueries({ queryKey: api.orpc.tasks.activity.key({ input: { key } }) }),
    queryClient.invalidateQueries({ queryKey: api.orpc.tasks.timeline.key({ input: { key } }) }),
    queryClient.invalidateQueries({ queryKey: api.orpc.tasks.list.key() }),
    queryClient.invalidateQueries({ queryKey: api.orpc.projects.key() }),
    queryClient.invalidateQueries({ queryKey: api.orpc.milestones.key() }),
    queryClient.invalidateQueries({ queryKey: api.orpc.cycles.key() }),
    queryClient.invalidateQueries({ queryKey: api.orpc.home.key() }),
    queryClient.invalidateQueries({ queryKey: api.orpc.dashboard.key() }),
  ]);
}

/** After a change settles: the tasks, the other ends of relations, and label usage counts. */
function invalidateAfter(
  api: WorkspaceApi,
  queryClient: QueryClient,
  keys: readonly string[],
  patch: TaskPatch,
) {
  for (const key of keys) void invalidateTask(api, queryClient, key);
  // Parents, subtasks and blockers show each other: refresh every open task detail.
  if (touchesRelations(patch)) void queryClient.invalidateQueries({ queryKey: api.orpc.tasks.get.key() });
  if (touchesLabels(patch)) void queryClient.invalidateQueries({ queryKey: api.orpc.labels.key() });
}

/** Stops task reads in flight, so they don't overwrite an optimistic edit. */
export async function cancelTaskQueries(api: WorkspaceApi, queryClient: QueryClient) {
  await Promise.all([
    queryClient.cancelQueries({ queryKey: api.orpc.tasks.get.key() }),
    queryClient.cancelQueries({ queryKey: api.orpc.tasks.list.key() }),
    queryClient.cancelQueries({ queryKey: api.orpc.home.key() }),
  ]);
}

/**
 * Patches every cached copy of one task (and the other ends of its relations) at once. Returns the
 * snapshot to restore when the server refuses it.
 */
export function applyOptimisticPatch(
  api: WorkspaceApi,
  queryClient: QueryClient,
  key: string,
  patch: TaskPatch,
  updatedAt = new Date().toISOString(),
): CacheSnapshot {
  const before = cachedTask(api, queryClient, key);
  const edits = new Map<string, Edit>([[key, (item) => applyTaskPatch(item, patch, updatedAt)]]);
  for (const [other, edit] of relativeEdits(before, key, patch)) if (other !== key) edits.set(other, edit);
  return editTaskCaches(api, queryClient, edits);
}

/**
 * Saves task edits. Every cached copy of the task (detail, lists, board columns, Home) changes at once;
 * on error they go back to what they were, and the mutation's `error` explains why. The mutation
 * context (`onMutateResult` in mutate callbacks) carries the snapshot, with the task as it was in
 * `before`, for an Undo.
 */
export function useUpdateTask() {
  const api = useApi();
  const queryClient = useQueryClient();
  return useMutation({
    mutationKey: api.orpc.tasks.update.mutationKey(),
    mutationFn: (variables: UpdateTaskVariables) => api.client.tasks.update(toUpdateInput(variables)),
    onMutate: async ({ key, patch }): Promise<CacheSnapshot> => {
      await cancelTaskQueries(api, queryClient);
      return applyOptimisticPatch(api, queryClient, key, patch);
    },
    onError: (_error, _variables, snapshot) => restoreTaskCaches(queryClient, snapshot),
    onSuccess: (task) => {
      queryClient.setQueryData(api.orpc.tasks.get.queryKey({ input: { key: task.key } }), task);
    },
    // Not awaited: the rollback and the error show at once instead of after the refetch.
    onSettled: (_task, _error, { key, patch }) => invalidateAfter(api, queryClient, [key], patch),
  });
}

// ── Bulk ────────────────────────────────────────────────────────────────────────────────────────────

/** A bulk change the client refuses before sending: mirrored tasks in the selection, too many tasks. */
export class BulkRefusedError extends Error {
  override readonly name = 'BulkRefusedError';
}

/**
 * Why a selection can't change in one go, or null when it can: bulk changes are for native projects
 * only (design call 1), at most MAX_BULK_TASKS at once.
 */
export function bulkRefusal(targets: readonly CachedTask[]): string | null {
  if (targets.length > MAX_BULK_TASKS) return `Change ${MAX_BULK_TASKS} tasks or fewer at once.`;
  const mirrored = targets.filter((target) => (target.locked?.length ?? 0) > 0).length;
  if (mirrored === 0) return null;
  if (mirrored === targets.length) return 'Read-only: fields come from Backlog.md';
  return `Read-only: ${mirrored} of ${targets.length} selected tasks come from Backlog.md. Change those in the files.`;
}

export interface BulkUpdateVariables {
  keys: readonly string[];
  patch: BulkTaskPatch;
  /** The selected tasks as shown, for the mirrored check. Defaults to the cached copies. */
  targets?: readonly CachedTask[];
}

/**
 * One change for several tasks (POST /tasks/bulk, native projects only). Optimistic like
 * useUpdateTask; a selection with mirrored tasks fails at once with a BulkRefusedError and sends
 * nothing.
 */
export function useBulkUpdateTasks() {
  const api = useApi();
  const queryClient = useQueryClient();
  return useMutation({
    mutationKey: api.orpc.tasks.bulkUpdate.mutationKey(),
    mutationFn: (variables: BulkUpdateVariables) => {
      const refusal = refusalFor(api, queryClient, variables);
      if (refusal) return Promise.reject(new BulkRefusedError(refusal));
      return api.client.tasks.bulkUpdate(toBulkInput(variables.keys, variables.patch));
    },
    onMutate: async (variables): Promise<CacheSnapshot> => {
      if (refusalFor(api, queryClient, variables)) return { entries: [], before: new Map() };
      await cancelTaskQueries(api, queryClient);
      const updatedAt = new Date().toISOString();
      const edit: Edit = (item) => applyTaskPatch(item, variables.patch, updatedAt);
      return editTaskCaches(api, queryClient, new Map(variables.keys.map((key) => [key, edit])));
    },
    onError: (_error, _variables, snapshot) => restoreTaskCaches(queryClient, snapshot),
    onSuccess: (result: TaskBulkResult) => {
      for (const item of result.items) {
        const queryKey = api.orpc.tasks.get.queryKey({ input: { key: item.key } });
        const task = queryClient.getQueryData(queryKey);
        if (task) queryClient.setQueryData(queryKey, { ...task, ...item });
      }
    },
    onSettled: (_result, error, { keys, patch }) => {
      if (error instanceof BulkRefusedError) return;
      invalidateAfter(api, queryClient, keys, patch);
    },
  });
}

function refusalFor(
  api: WorkspaceApi,
  queryClient: QueryClient,
  { keys, targets }: BulkUpdateVariables,
): string | null {
  if (keys.length > MAX_BULK_TASKS) return `Change ${MAX_BULK_TASKS} tasks or fewer at once.`;
  const shown =
    targets ??
    keys.map((key) => cachedTask(api, queryClient, key)).filter((task): task is CachedTask => task != null);
  return bulkRefusal(shown);
}

// ── Create ──────────────────────────────────────────────────────────────────────────────────────────

/**
 * Creates a task, primes its detail cache and refreshes lists, project counts and Home. A subtask
 * (`parent`) shows in the parent's cached detail at once.
 */
export function useCreateTask() {
  const api = useApi();
  const queryClient = useQueryClient();
  return useMutation({
    mutationKey: api.orpc.tasks.create.mutationKey(),
    mutationFn: (input: z.input<typeof CreateTaskInput>) => api.client.tasks.create(input),
    onSuccess: (task, input) => {
      queryClient.setQueryData(api.orpc.tasks.get.queryKey({ input: { key: task.key } }), task);
      if (input.parent) {
        const parentKey = api.orpc.tasks.get.queryKey({ input: { key: input.parent.toUpperCase() } });
        const parent = queryClient.getQueryData(parentKey);
        if (parent) {
          const subtasks = [
            ...(parent.subtasks ?? []).filter((item) => item.key !== task.key),
            relatedOf(task),
          ];
          queryClient.setQueryData(parentKey, { ...parent, subtasks, subtaskProgress: progressOf(subtasks) });
        }
      }
      // Not awaited: the dialog can take the next task while the list refreshes.
      void queryClient.invalidateQueries({ queryKey: api.orpc.tasks.list.key() });
      void queryClient.invalidateQueries({ queryKey: api.orpc.projects.key() });
      void queryClient.invalidateQueries({ queryKey: api.orpc.milestones.key() });
      void queryClient.invalidateQueries({ queryKey: api.orpc.cycles.key() });
      void queryClient.invalidateQueries({ queryKey: api.orpc.home.key() });
      if (input.parent || input.blockedBy?.length)
        void queryClient.invalidateQueries({ queryKey: api.orpc.tasks.get.key() });
      if (input.labels?.length) void queryClient.invalidateQueries({ queryKey: api.orpc.labels.key() });
    },
  });
}
