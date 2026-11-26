import {
  type CYCLE_CURRENT,
  type CYCLE_NEXT,
  type DueFilter,
  type FILTER_NONE,
  type ListTasksInput,
  type Priority,
  safeParseTaskKey,
  type TaskStatus,
} from '@zamu/contracts';
import { type DisplayOptions, displayListInput } from '~/features/views/display-options';
import {
  parseTaskFilter,
  type TaskFilter,
  taskFilterSearch,
  toListTasksInput,
} from '~/features/views/filters';
import type { WorkspaceUrlSlug } from '~/lib/workspace-paths';

// URL state of a project's tasks, list and board:
//   /p/PAY?q=webhook&status=todo,in_progress&priority=high&assignee=me,agents&label=<id>,<id>
//          &due=overdue&blocked=true&milestone=<id>,none&cycle=12|current,next&view=board&lanes=assignee
//          &hidden=only   (mirrored projects: tasks whose Backlog.md file is gone; list only)
//          &focus=PAY-142 (the list focuses this row once, then drops the param: "back to the list")
// The filter params are the M5 filter model's (features/views/filters.ts); a single value reads as in
// M1–M4, so old links keep working. ?task=PAY-142 (the M1–M4 detail pane) now redirects to the task
// view (taskLinkRedirect). Everything lives in the URL so a reload, a shared link or the back button
// restores the same view.

/** Swimlanes of the board. */
export type BoardLanes = 'assignee' | 'milestone';
export const BOARD_LANES: readonly BoardLanes[] = ['assignee', 'milestone'];

/** List (the default, absent from the URL) or board. */
export type TaskView = 'list' | 'board';

/** Cycle filter: a cycle number, current, next, or none (tasks without a cycle). */
export type CycleFilterValue = number | typeof CYCLE_CURRENT | typeof CYCLE_NEXT | typeof FILTER_NONE;

export interface TaskListSearch {
  /** M1–M4 selected task. Links carrying it redirect to the task view (taskLinkRedirect). */
  task?: string;
  /** The list focuses this task's row once (coming back from the task view), then drops the param. */
  focus?: string;
  /** Search text: matches the title or the key. */
  q?: string;
  status?: TaskStatus[];
  priority?: Priority[];
  /** 'me', 'agents', 'none' or user ids; several are one comma-separated string ("me,agents"). */
  assignee?: string;
  /** Milestone ids or 'none'; several are one comma-separated string. */
  milestone?: string;
  /**
   * One cycle filter value. Several (M5's filter menu) arrive as one comma-separated string such as
   * "12,current": read filters through parseTaskFilter (taskFilterOf) rather than this field.
   */
  cycle?: CycleFilterValue;
  /** M5: label ids, comma separated; any of them. */
  label?: string;
  /** M5: overdue, soon, none or set. */
  due?: DueFilter;
  /** M5: only blocked tasks (true) or only tasks that aren't (false). */
  blocked?: boolean;
  /** 'board' shows the board; absent means the list. */
  view?: 'board';
  /** Board only: swimlanes by assignee or by milestone. */
  lanes?: BoardLanes;
  /** List only: show the tasks removed from Backlog.md instead of the visible ones. */
  hidden?: 'only';
}

/** Display order of the groups: active work first, then the collapsed ones. */
export const GROUP_ORDER: readonly TaskStatus[] = [
  'in_progress',
  'in_review',
  'todo',
  'backlog',
  'done',
  'canceled',
];

/** Fetched with the page. The other groups load when someone expands them. */
export const EAGER_STATUSES: readonly TaskStatus[] = ['in_progress', 'in_review', 'todo'];

/** Collapsed until expanded (when no status filter is set). */
export const LAZY_STATUSES: readonly TaskStatus[] = ['backlog', 'done', 'canceled'];

function taskKeyParam(value: unknown): string | undefined {
  if (typeof value !== 'string') return undefined;
  const key = value.trim().toUpperCase();
  return safeParseTaskKey(key) ? key : undefined;
}

/**
 * validateSearch for the task list route. Keeps the M5 filter params (several values, label, due,
 * blocked) and the M1–M4 ones, and drops anything it does not understand.
 */
export function parseTaskListSearch(search: Record<string, unknown>): TaskListSearch {
  const result: TaskListSearch = {};
  const task = taskKeyParam(search.task);
  if (task) result.task = task;
  const focus = taskKeyParam(search.focus);
  if (focus) result.focus = focus;
  const filter = parseTaskFilter(search);
  const url = taskFilterSearch(filter);
  if (filter.q) result.q = filter.q;
  if (filter.status) result.status = filter.status;
  if (filter.priority) result.priority = filter.priority;
  if (typeof url.assignee === 'string') result.assignee = url.assignee;
  if (typeof url.milestone === 'string') result.milestone = url.milestone;
  // A number for one cycle (cycle=12, as before M5), else the canonical comma list.
  if (url.cycle !== undefined) result.cycle = url.cycle as CycleFilterValue;
  if (typeof url.label === 'string') result.label = url.label;
  if (filter.due) result.due = filter.due;
  if (filter.blocked !== undefined) result.blocked = filter.blocked;
  if (search.view === 'board') result.view = 'board';
  if (typeof search.lanes === 'string' && (BOARD_LANES as readonly string[]).includes(search.lanes)) {
    result.lanes = search.lanes as BoardLanes;
  }
  if (search.hidden === 'only') result.hidden = 'only';
  return result;
}

/** The M5 filter model of a list or board search (every value, any form the URL holds). */
export function taskFilterOf(search: TaskListSearch | TaskListFilters): TaskFilter {
  return parseTaskFilter(search as Record<string, unknown>);
}

export function hasFilters(search: TaskListSearch): boolean {
  return Boolean(
    search.q?.trim() ||
      search.status ||
      search.priority ||
      search.assignee ||
      search.milestone ||
      search.cycle !== undefined ||
      search.label ||
      search.due ||
      search.blocked !== undefined ||
      search.hidden,
  );
}

/** The filters only (no selection, focus, view or lanes), so selecting a task never changes a query key. */
export type TaskListFilters = Omit<TaskListSearch, 'task' | 'focus' | 'view' | 'lanes'>;

export function filtersOf(search: TaskListSearch): TaskListFilters {
  const { task: _task, focus: _focus, view: _view, lanes: _lanes, ...filters } = search;
  return filters;
}

/** Drops the milestone and cycle filters when the project has the feature turned off. */
export function applyProjectFeatures(
  filters: TaskListFilters,
  project: { usesMilestones: boolean; usesCycles: boolean } | undefined,
): TaskListFilters {
  if (!project) return filters;
  const { milestone, cycle, ...rest } = filters;
  return {
    ...rest,
    ...(project.usesMilestones && milestone ? { milestone } : {}),
    ...(project.usesCycles && cycle !== undefined ? { cycle } : {}),
  };
}

/** The same for the M5 filter model: what the list and the route's prefetch send. */
export function withProjectFeatures(
  filter: TaskFilter,
  project: { usesMilestones: boolean; usesCycles: boolean } | undefined,
): TaskFilter {
  if (!project) return filter;
  const { milestone, cycle, ...rest } = filter;
  return {
    ...rest,
    ...(project.usesMilestones && milestone ? { milestone } : {}),
    ...(project.usesCycles && cycle ? { cycle } : {}),
  };
}

/**
 * The list's main tasks.list request: the eager groups (or the filtered statuses, or every task when the
 * list isn't grouped by status) under the filter and display options. The list and the route's prefetch
 * both build it here, so a fresh page reuses the server's answer instead of asking again.
 */
export function listMainInput(
  projectKey: string,
  filter: TaskFilter,
  display: DisplayOptions,
  hidden: boolean,
): Omit<ListTasksInput, 'limit' | 'cursor'> & { project: string[] } {
  const statusGrouping = display.groupBy === 'status' && !hidden;
  const { status: _status, ...filterPart } = toListTasksInput(filter);
  const options = displayListInput(display);
  // Grouped by status and ordered by priority, the server's list order is already the one shown.
  const ordering = statusGrouping && options.sort === 'priority' ? {} : { sort: options.sort };
  const filtered = filter.status ? GROUP_ORDER.filter((status) => filter.status?.includes(status)) : null;
  const statuses: TaskStatus[] | undefined =
    filtered ?? (hidden ? [...GROUP_ORDER] : statusGrouping ? [...EAGER_STATUSES] : undefined);
  return {
    project: [projectKey],
    order: 'list',
    ...(statuses ? { status: statuses } : {}),
    ...filterPart,
    ...ordering,
    ...(options.topLevel ? { topLevel: true } : {}),
    ...(hidden ? { hidden: 'only' as const } : {}),
  };
}

/** The filter part of a tasks.list input (everything but project, order and status). */
function filterInput(filters: TaskListFilters) {
  const { status: _status, ...input } = toListTasksInput(taskFilterOf(filters));
  return input;
}

/** tasks.list input for a set of statuses under the current filters (hidden tasks when asked). */
export function listInput(
  projectKey: string,
  filters: TaskListFilters,
  statuses: readonly TaskStatus[],
): Omit<ListTasksInput, 'limit' | 'cursor'> {
  return {
    project: [projectKey],
    order: 'list',
    status: [...statuses],
    ...filterInput(filters),
    ...(filters.hidden ? { hidden: filters.hidden } : {}),
  };
}

/**
 * Where an M1–M4 link to the list with ?task=PAY-142 goes now: the task view of that task (the list has
 * no detail pane). Null when the search has no task.
 */
export function taskLinkRedirect(
  workspace: WorkspaceUrlSlug,
  projectKey: string,
  search: TaskListSearch,
): {
  to: '/w/$workspace/p/$projectKey/$taskKey';
  params: { workspace: string; projectKey: string; taskKey: string };
} | null {
  if (!search.task) return null;
  return {
    to: '/w/$workspace/p/$projectKey/$taskKey',
    params: { workspace, projectKey, taskKey: search.task },
  };
}

/** Statuses of the hidden-tasks list: all of them, or the status filter. */
export function hiddenStatuses(filters: TaskListFilters): TaskStatus[] {
  return filters.status ? GROUP_ORDER.filter((status) => filters.status?.includes(status)) : [...GROUP_ORDER];
}

/**
 * Which statuses load with the page. Without a status filter: in progress, in review and todo (backlog,
 * done and canceled wait until expanded). With one: exactly the filtered statuses, all expanded.
 */
export function eagerStatuses(filters: TaskListFilters): TaskStatus[] {
  if (filters.status) return GROUP_ORDER.filter((status) => filters.status?.includes(status));
  return [...EAGER_STATUSES];
}

/** Groups shown in the table, in display order. */
export function visibleStatuses(filters: TaskListFilters): TaskStatus[] {
  if (filters.status) return GROUP_ORDER.filter((status) => filters.status?.includes(status));
  return [...GROUP_ORDER];
}

/** Columns folded on a fresh board: Done and Canceled. */
export const BOARD_FOLDED: readonly TaskStatus[] = ['done', 'canceled'];
