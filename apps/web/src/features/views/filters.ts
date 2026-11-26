import {
  ASSIGNEE_AGENTS,
  ASSIGNEE_ME,
  CYCLE_CURRENT,
  CYCLE_NEXT,
  DUE_FILTERS,
  type DueFilter,
  dueState,
  FILTER_NONE,
  type GetHomeInput,
  type ListTasksInput,
  PRIORITIES,
  type Priority,
  TASK_STATUSES,
  type TaskListItem,
  type TaskStatus,
} from '@zamu/contracts';
import { checkAgainState } from '~/ui';

// The filter model shared by the list, the board and Home (frames 013, 046, 047), its URL form and
// its tasks.list / home.get input.
//
// URL search params (shareable; the names of M1–M4 are kept, lists are comma separated and a single
// value reads as before):
//   status=todo,in_progress   priority=urgent,high   assignee=me,agents,none,<user id>
//   label=<label id>,…        (Home: label names)    due=overdue|soon|none|set
//   blocked=true|false        milestone=<id>,none     cycle=12,current,next,none   q=<search text>
//   checkAgain=waiting|ready  archived=only|include   (M7)
// Other params (task, view, lanes, hidden) are left alone.

/** Assignee filter value for tasks with nobody assigned. */
export const ASSIGNEE_NONE = FILTER_NONE;

/** Cycle filter values: a cycle number, current, next or none. */
export type CycleFilterValue = number | typeof CYCLE_CURRENT | typeof CYCLE_NEXT | typeof FILTER_NONE;

export interface TaskFilter {
  status?: TaskStatus[];
  priority?: Priority[];
  /** 'me', 'agents', 'none' (unassigned) or user ids; a task matches any of them. */
  assignee?: string[];
  /** Label ids in a project; label names on Home (Home merges labels by name). Any of them. */
  label?: string[];
  due?: DueFilter;
  /** true: only blocked tasks; false: only tasks that aren't. */
  blocked?: boolean;
  /** Milestone ids or 'none'. */
  milestone?: string[];
  cycle?: CycleFilterValue[];
  /** M7: waiting (the check-again day is ahead) or ready to check (the day has come). */
  checkAgain?: TaskCheckAgainFilter;
  /**
   * M7: archived tasks, left out when unset. only: just the archived ones ("Archived is shown", what
   * Display's "Archived tasks: Shown" and the palette's "Show archived tasks" set); include: with the rest.
   */
  archived?: TaskArchivedFilter;
  /** The view's search text (the header's search, `/`). Never a chip. */
  q?: string;
}

/** M7: the check-again values the filter offers (the API also takes set and none). */
export type TaskCheckAgainFilter = 'waiting' | 'ready';
export const TASK_CHECK_AGAIN_FILTERS: readonly TaskCheckAgainFilter[] = ['waiting', 'ready'];

/** M7: archived tasks in the view (exclude, the API's default, is "unset"). */
export type TaskArchivedFilter = 'only' | 'include';
export const TASK_ARCHIVED_FILTERS: readonly TaskArchivedFilter[] = ['only', 'include'];

/** Fields the filter menu offers, in its order (frame 046; M7 adds check again and archived). */
export type FilterField =
  | 'status'
  | 'priority'
  | 'assignee'
  | 'label'
  | 'due'
  | 'blocked'
  | 'milestone'
  | 'cycle'
  | 'checkAgain'
  | 'archived';
export const FILTER_FIELDS: readonly FilterField[] = [
  'status',
  'priority',
  'assignee',
  'label',
  'due',
  'blocked',
  'milestone',
  'cycle',
  'checkAgain',
  'archived',
];

/** The URL params the filter owns. */
export const FILTER_PARAMS = [...FILTER_FIELDS, 'q'] as const;
export type FilterParam = (typeof FILTER_PARAMS)[number];

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const CYCLE_NUMBER = /^[1-9][0-9]{0,8}$/;
const MAX_VALUES = 50;
const MAX_LABEL_NAME = 40;

/** A param as a list: an array (TanStack's JSON form), a comma list, or one value. */
function rawList(value: unknown): string[] {
  const items = Array.isArray(value)
    ? value
    : typeof value === 'number'
      ? [value]
      : typeof value === 'string'
        ? value.split(',')
        : [];
  const out: string[] = [];
  for (const item of items) {
    const text = typeof item === 'number' ? String(item) : typeof item === 'string' ? item.trim() : '';
    if (text && !out.includes(text)) out.push(text);
  }
  return out.slice(0, MAX_VALUES);
}

function enumList<T extends string>(value: unknown, allowed: readonly T[]): T[] | undefined {
  const raw = rawList(value);
  // Kept in the canonical order, so the same filter always gives the same URL and query key.
  const picked = allowed.filter((item) => raw.includes(item));
  return picked.length ? picked : undefined;
}

function nonEmpty<T>(list: T[]): T[] | undefined {
  return list.length ? list : undefined;
}

export interface ParseTaskFilterOptions {
  /** 'name' on Home: label values are names, not ids. */
  labels?: 'id' | 'name';
}

/** Reads the filter from URL search params. Drops anything it does not understand. */
export function parseTaskFilter(
  search: Record<string, unknown>,
  options: ParseTaskFilterOptions = {},
): TaskFilter {
  const filter: TaskFilter = {};
  const status = enumList(search.status, TASK_STATUSES);
  if (status) filter.status = status;
  const priority = enumList(search.priority, PRIORITIES);
  if (priority) filter.priority = priority;
  const assignee = nonEmpty(
    rawList(search.assignee)
      .filter(
        (value) =>
          value === ASSIGNEE_ME || value === ASSIGNEE_AGENTS || value === ASSIGNEE_NONE || UUID.test(value),
      )
      .map((value) => (UUID.test(value) ? value.toLowerCase() : value)),
  );
  if (assignee) filter.assignee = assignee;
  const label = nonEmpty(
    options.labels === 'name'
      ? rawList(search.label).filter((value) => value.length <= MAX_LABEL_NAME)
      : rawList(search.label)
          .filter((value) => UUID.test(value))
          .map((value) => value.toLowerCase()),
  );
  if (label) filter.label = label;
  if (typeof search.due === 'string' && (DUE_FILTERS as readonly string[]).includes(search.due)) {
    filter.due = search.due as DueFilter;
  }
  if (search.blocked === true || search.blocked === 'true') filter.blocked = true;
  else if (search.blocked === false || search.blocked === 'false') filter.blocked = false;
  const milestone = nonEmpty(
    rawList(search.milestone)
      .filter((value) => value === FILTER_NONE || UUID.test(value))
      .map((value) => value.toLowerCase()),
  );
  if (milestone) filter.milestone = milestone;
  const cycle = nonEmpty(
    rawList(search.cycle).flatMap((value): CycleFilterValue[] => {
      if (value === CYCLE_CURRENT || value === CYCLE_NEXT || value === FILTER_NONE) return [value];
      return CYCLE_NUMBER.test(value) ? [Number(value)] : [];
    }),
  );
  if (cycle) filter.cycle = cycle;
  if (
    typeof search.checkAgain === 'string' &&
    (TASK_CHECK_AGAIN_FILTERS as readonly string[]).includes(search.checkAgain)
  ) {
    filter.checkAgain = search.checkAgain as TaskCheckAgainFilter;
  }
  if (
    typeof search.archived === 'string' &&
    (TASK_ARCHIVED_FILTERS as readonly string[]).includes(search.archived)
  ) {
    filter.archived = search.archived as TaskArchivedFilter;
  }
  if (typeof search.q === 'string' && search.q.trim()) filter.q = search.q.slice(0, 200);
  return filter;
}

/** URL form of the filter: one entry per FILTER_PARAMS name, undefined when unset. */
export type TaskFilterSearch = Record<FilterParam, string | number | boolean | undefined>;

/**
 * The filter as URL search values. Lists are comma separated; a single cycle number stays a
 * number (cycle=12, as before M5); blocked is a boolean.
 */
export function taskFilterSearch(filter: TaskFilter): TaskFilterSearch {
  const list = (values: readonly (string | number)[] | undefined) =>
    values?.length ? values.join(',') : undefined;
  const cycle =
    filter.cycle?.length === 1 && typeof filter.cycle[0] === 'number' ? filter.cycle[0] : list(filter.cycle);
  return {
    status: list(filter.status),
    priority: list(filter.priority),
    assignee: list(filter.assignee),
    label: list(filter.label),
    due: filter.due,
    blocked: filter.blocked,
    milestone: list(filter.milestone),
    cycle,
    checkAgain: filter.checkAgain,
    archived: filter.archived,
    q: filter.q?.trim() ? filter.q : undefined,
  };
}

/**
 * Replaces the filter params of a search object and keeps the others (task, view, lanes, hidden).
 * Unset params are removed, so the URL carries only what is set.
 */
export function withTaskFilter<S extends Record<string, unknown>>(search: S, filter: TaskFilter): S {
  const next: Record<string, unknown> = { ...search };
  for (const [param, value] of Object.entries(taskFilterSearch(filter))) {
    if (value === undefined) delete next[param];
    else next[param] = value;
  }
  return next as S;
}

/** True when any field filters (the search text included). */
export function hasTaskFilter(filter: TaskFilter): boolean {
  return activeFilterFields(filter).length > 0 || Boolean(filter.q?.trim());
}

/** The fields that are set, in menu order: one chip each. */
export function activeFilterFields(filter: TaskFilter): FilterField[] {
  return FILTER_FIELDS.filter((field) => {
    const value = filter[field];
    return Array.isArray(value) ? value.length > 0 : value !== undefined;
  });
}

/** The filter without one field (a chip's ×). */
export function withoutField(filter: TaskFilter, field: FilterField): TaskFilter {
  const { [field]: _removed, ...rest } = filter;
  return rest;
}

/** Every field cleared ("Clear"); the search text stays, it has its own field. */
export function clearedFilter(filter: TaskFilter): TaskFilter {
  return filter.q ? { q: filter.q } : {};
}

/** Same filter (order of values ignored). */
export function sameTaskFilter(a: TaskFilter, b: TaskFilter): boolean {
  const sa = taskFilterSearch(normalizeOrder(a));
  const sb = taskFilterSearch(normalizeOrder(b));
  return FILTER_PARAMS.every((param) => sa[param] === sb[param]);
}

function normalizeOrder(filter: TaskFilter): TaskFilter {
  const sorted = <T extends string | number>(values?: T[]) =>
    values ? [...values].sort((x, y) => String(x).localeCompare(String(y))) : undefined;
  return {
    ...filter,
    status: sorted(filter.status),
    priority: sorted(filter.priority),
    assignee: sorted(filter.assignee),
    label: sorted(filter.label),
    milestone: sorted(filter.milestone),
    cycle: sorted(filter.cycle),
  };
}

// ---------------------------------------------------------------------------
// Queries
// ---------------------------------------------------------------------------

/** The tasks.list fields a filter sets (everything but project, order, sort, cursor and limit). */
export type TaskFilterInput = Pick<
  ListTasksInput,
  | 'status'
  | 'priority'
  | 'assignee'
  | 'label'
  | 'due'
  | 'blocked'
  | 'milestone'
  | 'cycle'
  | 'checkAgain'
  | 'archived'
  | 'q'
>;

/** The part of the filter tasks.list applies: all of it (assignee, milestone and cycle take several values and 'none'). */
export function toListTasksInput(filter: TaskFilter): Partial<TaskFilterInput> {
  return {
    ...(filter.status?.length ? { status: [...filter.status] } : {}),
    ...(filter.priority?.length ? { priority: [...filter.priority] } : {}),
    ...(filter.assignee?.length ? { assignee: [...filter.assignee] } : {}),
    ...(filter.label?.length ? { label: [...filter.label] } : {}),
    ...(filter.due ? { due: filter.due } : {}),
    ...(filter.blocked !== undefined ? { blocked: filter.blocked } : {}),
    ...(filter.milestone?.length ? { milestone: [...filter.milestone] } : {}),
    ...(filter.cycle?.length ? { cycle: [...filter.cycle] } : {}),
    ...(filter.checkAgain ? { checkAgain: filter.checkAgain } : {}),
    ...(filter.archived ? { archived: filter.archived } : {}),
    ...(filter.q?.trim() ? { q: filter.q.trim() } : {}),
  };
}

/** The fields toListTasksInput could not send. Empty now that the server applies the whole filter. */
export function clientFilterFields(_filter: TaskFilter): FilterField[] {
  return [];
}

/** True when tasks.list applies the whole filter, so its counts and pages are exact. */
export function isServerFilterComplete(filter: TaskFilter): boolean {
  return clientFilterFields(filter).length === 0;
}

/** home.get filters: label names and priorities (Home filters nothing else). */
export function toHomeInput(filter: TaskFilter): Pick<GetHomeInput, 'label' | 'priority'> {
  return {
    ...(filter.label?.length ? { label: [...filter.label] } : {}),
    ...(filter.priority?.length ? { priority: [...filter.priority] } : {}),
  };
}

export interface ClientFilterContext {
  viewerId?: string | null;
  /** Today in the app's time zone (YYYY-MM-DD), for the due filter. */
  today?: string;
}

type FilterableTask = Pick<TaskListItem, 'status' | 'priority' | 'assignee'> &
  Partial<
    Pick<TaskListItem, 'labels' | 'dueDate' | 'blocked' | 'milestone' | 'cycle' | 'checkAgain' | 'archivedAt'>
  >;

function assigneeMatches(task: FilterableTask, value: string, viewerId: string | null | undefined): boolean {
  if (value === ASSIGNEE_NONE) return !task.assignee;
  if (!task.assignee) return false;
  if (value === ASSIGNEE_ME) return task.assignee.id === viewerId;
  if (value === ASSIGNEE_AGENTS) return task.assignee.kind === 'agent';
  return task.assignee.id === value;
}

function cycleMatches(task: FilterableTask, value: CycleFilterValue): boolean {
  if (value === FILTER_NONE) return !task.cycle;
  if (!task.cycle) return false;
  if (value === CYCLE_CURRENT) return task.cycle.state === 'current';
  // "Next" is the first upcoming cycle; rows don't say which that is, so any upcoming one matches.
  if (value === CYCLE_NEXT) return task.cycle.state === 'upcoming';
  return task.cycle.number === value;
}

/**
 * Whether a task matches the filter, field by field (the search text is left to the server). Use
 * it for the fields clientFilterFields() names, or to check a task patched in the cache.
 */
export function matchesTaskFilter(
  task: FilterableTask,
  filter: TaskFilter,
  context: ClientFilterContext = {},
  fields: readonly FilterField[] = FILTER_FIELDS,
): boolean {
  for (const field of fields) {
    switch (field) {
      case 'status':
        if (filter.status && !filter.status.includes(task.status)) return false;
        break;
      case 'priority':
        if (filter.priority && !filter.priority.includes(task.priority)) return false;
        break;
      case 'assignee':
        if (
          filter.assignee &&
          !filter.assignee.some((value) => assigneeMatches(task, value, context.viewerId))
        )
          return false;
        break;
      case 'label':
        if (
          filter.label &&
          !(task.labels ?? []).some(
            (label) =>
              filter.label?.includes(label.id) ||
              filter.label?.some((name) => name.toLocaleLowerCase() === label.name.toLocaleLowerCase()),
          )
        )
          return false;
        break;
      case 'due': {
        if (!filter.due) break;
        const due = task.dueDate ?? null;
        if (filter.due === 'none' && due !== null) return false;
        if (filter.due === 'set' && due === null) return false;
        if (filter.due === 'overdue' || filter.due === 'soon') {
          if (!context.today) break;
          const state = dueState(due, task.status, context.today);
          if (filter.due === 'overdue' && state !== 'overdue') return false;
          if (filter.due === 'soon' && state !== 'soon' && state !== 'today') return false;
        }
        break;
      }
      case 'blocked':
        if (filter.blocked !== undefined && Boolean(task.blocked) !== filter.blocked) return false;
        break;
      case 'milestone':
        if (
          filter.milestone &&
          !filter.milestone.some((value) =>
            value === FILTER_NONE ? !task.milestone : task.milestone?.id === value,
          )
        )
          return false;
        break;
      case 'cycle':
        if (filter.cycle && !filter.cycle.some((value) => cycleMatches(task, value))) return false;
        break;
      case 'checkAgain': {
        if (!filter.checkAgain) break;
        const on = task.checkAgain?.on;
        if (!on) return false;
        if (context.today && checkAgainState(on, context.today) !== filter.checkAgain) return false;
        break;
      }
      case 'archived': {
        const archived = task.archivedAt != null;
        if (filter.archived === 'only' ? !archived : filter.archived === undefined && archived) return false;
        break;
      }
    }
  }
  return true;
}

/** Keeps the tasks matching the fields tasks.list could not apply. Returns the same array when none. */
export function clientFilter<T extends FilterableTask>(
  tasks: readonly T[],
  filter: TaskFilter,
  context: ClientFilterContext = {},
): readonly T[] {
  const fields = clientFilterFields(filter);
  if (fields.length === 0) return tasks;
  return tasks.filter((task) => matchesTaskFilter(task, filter, context, fields));
}
