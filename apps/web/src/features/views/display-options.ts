import {
  type CycleRef,
  type ListTasksInput,
  type MilestoneRef,
  PRIORITIES,
  type Priority,
  TASK_SORTS,
  TASK_STATUSES,
  type TaskListItem,
  type TaskSort,
  type TaskStatus,
} from '@zamu/contracts';
import { PRIORITY_LABELS, STATUS_LABELS, showsPriorityOnCards } from '~/ui';

// Display options of a task view (brief "Display options", frame 045): how the list, the board and
// Home lay out, group, order and decorate tasks. Remembered per person, project and view in
// localStorage (plan call 4; see useDisplayOptions). Named, shared views come with PM-15.

/** The views that keep their own display options. Home has only the list layout. */
export type TaskViewName = 'list' | 'board' | 'home';
export const TASK_VIEW_NAMES: readonly TaskViewName[] = ['list', 'board', 'home'];

export type ViewLayout = 'list' | 'board';
export const VIEW_LAYOUTS: readonly ViewLayout[] = ['list', 'board'];

/** Group rows (list), columns and swimlanes (board) by one field, or not at all. */
export type GroupBy = 'status' | 'priority' | 'assignee' | 'milestone' | 'cycle' | 'label' | 'none';
export const GROUP_BYS: readonly GroupBy[] = [
  'status',
  'priority',
  'assignee',
  'milestone',
  'cycle',
  'label',
  'none',
];

/** "Order by": the tasks.list `sort` values. */
export type OrderBy = TaskSort;
export const ORDER_BYS: readonly OrderBy[] = TASK_SORTS;

/** List: subtasks nested under their parent (tree lines), as plain rows, or left out. */
export type ListSubtasks = 'nested' | 'flat' | 'hidden';
export const LIST_SUBTASKS: readonly ListSubtasks[] = ['nested', 'flat', 'hidden'];

/** Board: subtasks hidden with the parent card expanding in place ("2 subtasks"), or their own cards. */
export type BoardSubtasks = 'expandable' | 'cards';
export const BOARD_SUBTASKS: readonly BoardSubtasks[] = ['expandable', 'cards'];

/** Properties a row or card can show ("Shown on cards"), in the popover's order. */
export type TaskProperty =
  | 'priority'
  | 'key'
  | 'labels'
  | 'subtasks'
  | 'criteria'
  | 'due'
  | 'blocked'
  | 'assignee'
  | 'milestone'
  | 'cycle'
  | 'created'
  | 'updated';
export const TASK_PROPERTIES: readonly TaskProperty[] = [
  'priority',
  'key',
  'labels',
  'subtasks',
  'criteria',
  'due',
  'blocked',
  'assignee',
  'milestone',
  'cycle',
  'created',
  'updated',
];

/** "Hide done tasks after": days, 0 for never. */
export const HIDE_DONE_CHOICES: readonly number[] = [0, 1, 3, 7, 14, 30];

export interface DisplayOptions {
  /** The view's layout. Changing it switches the view (the screen navigates). */
  layout: ViewLayout;
  /** List groups, board columns. */
  groupBy: GroupBy;
  /** Board only: swimlanes (a sub-grouping); 'none' for none. */
  swimlanes: GroupBy;
  orderBy: OrderBy;
  listSubtasks: ListSubtasks;
  boardSubtasks: BoardSubtasks;
  /** Show groups (columns) that have no tasks. */
  showEmptyGroups: boolean;
  /** Hide Done and Canceled tasks last updated more than this many days ago; 0 never hides them. */
  hideDoneAfterDays: number;
  /**
   * Which properties rows and cards show. Two rules hold whatever is on: priority shows only for
   * Urgent and High, and the assignee avatar only when the task is someone else's (see showsProperty).
   */
  properties: Readonly<Record<TaskProperty, boolean>>;
}

/**
 * Brief "Default card and row content": shown by default; milestone, cycle and created hidden. The
 * M6 criteria marker is hidden too: it is one more chip people switch on.
 */
const DEFAULT_PROPERTIES: Record<TaskProperty, boolean> = {
  priority: true,
  key: true,
  labels: true,
  subtasks: true,
  // M6 design call 7: the criteria marker is off by default on rows and cards.
  criteria: false,
  due: true,
  blocked: true,
  assignee: true,
  milestone: false,
  cycle: false,
  created: false,
  updated: false,
};

const BASE: DisplayOptions = {
  layout: 'list',
  groupBy: 'status',
  swimlanes: 'none',
  orderBy: 'priority',
  listSubtasks: 'nested',
  boardSubtasks: 'expandable',
  showEmptyGroups: false,
  hideDoneAfterDays: 14,
  properties: DEFAULT_PROPERTIES,
};

/** Defaults per view (brief, frames 011, 029, 045, 099). */
export const DEFAULT_DISPLAY_OPTIONS: Readonly<Record<TaskViewName, DisplayOptions>> = {
  // The list shows when a task was last updated at the end of the row ("2m", frame 011).
  list: { ...BASE, properties: { ...DEFAULT_PROPERTIES, updated: true } },
  board: { ...BASE, layout: 'board' },
  // Home groups by why a task is there; its rows carry the project, so grouping stays off.
  home: { ...BASE, groupBy: 'none', listSubtasks: 'flat' },
};

export function defaultDisplayOptions(view: TaskViewName): DisplayOptions {
  return DEFAULT_DISPLAY_OPTIONS[view];
}

const pick = <T extends string | number>(value: unknown, allowed: readonly T[], fallback: T): T =>
  (allowed as readonly unknown[]).includes(value) ? (value as T) : fallback;

/**
 * Reads stored options: anything missing or not understood takes the view's default, so options
 * saved by an older build (or edited by hand) never break the view. The layout always follows the view.
 */
export function normalizeDisplayOptions(view: TaskViewName, raw: unknown): DisplayOptions {
  const base = defaultDisplayOptions(view);
  if (!raw || typeof raw !== 'object') return base;
  const value = raw as Partial<Record<keyof DisplayOptions, unknown>>;
  const rawProps = (
    value.properties && typeof value.properties === 'object' ? value.properties : {}
  ) as Record<string, unknown>;
  const properties = Object.fromEntries(
    TASK_PROPERTIES.map((property) => [
      property,
      typeof rawProps[property] === 'boolean' ? rawProps[property] : base.properties[property],
    ]),
  ) as Record<TaskProperty, boolean>;
  const groupBy = view === 'home' ? base.groupBy : pick(value.groupBy, GROUP_BYS, base.groupBy);
  const swimlanes = pick(value.swimlanes, GROUP_BYS, base.swimlanes);
  return {
    layout: base.layout,
    groupBy,
    // Lanes by the column field would repeat the columns.
    swimlanes: swimlanes !== 'none' && swimlanes === groupBy ? 'none' : swimlanes,
    orderBy: pick(value.orderBy, ORDER_BYS, base.orderBy),
    listSubtasks: pick(value.listSubtasks, LIST_SUBTASKS, base.listSubtasks),
    boardSubtasks: pick(value.boardSubtasks, BOARD_SUBTASKS, base.boardSubtasks),
    showEmptyGroups:
      typeof value.showEmptyGroups === 'boolean' ? value.showEmptyGroups : base.showEmptyGroups,
    hideDoneAfterDays:
      typeof value.hideDoneAfterDays === 'number' &&
      Number.isInteger(value.hideDoneAfterDays) &&
      value.hideDoneAfterDays >= 0 &&
      value.hideDoneAfterDays <= 365
        ? value.hideDoneAfterDays
        : base.hideDoneAfterDays,
    properties,
  };
}

export function sameDisplayOptions(a: DisplayOptions, b: DisplayOptions): boolean {
  return (
    a.layout === b.layout &&
    a.groupBy === b.groupBy &&
    a.swimlanes === b.swimlanes &&
    a.orderBy === b.orderBy &&
    a.listSubtasks === b.listSubtasks &&
    a.boardSubtasks === b.boardSubtasks &&
    a.showEmptyGroups === b.showEmptyGroups &&
    a.hideDoneAfterDays === b.hideDoneAfterDays &&
    TASK_PROPERTIES.every((property) => a.properties[property] === b.properties[property])
  );
}

// ---------------------------------------------------------------------------
// Words
// ---------------------------------------------------------------------------

export const GROUP_BY_LABELS: Record<GroupBy, string> = {
  status: 'Status',
  priority: 'Priority',
  assignee: 'Assignee',
  milestone: 'Milestone',
  cycle: 'Cycle',
  label: 'Label',
  none: 'None',
};

export const ORDER_BY_LABELS: Record<OrderBy, string> = {
  priority: 'Priority',
  due: 'Due date',
  updated: 'Last updated',
  created: 'Created',
  manual: 'Manual',
};

export const LIST_SUBTASK_LABELS: Record<ListSubtasks, string> = {
  nested: 'Nested',
  flat: 'As rows',
  hidden: 'Hidden',
};

export const PROPERTY_LABELS: Record<TaskProperty, string> = {
  priority: 'Priority',
  key: 'Key',
  labels: 'Labels',
  subtasks: 'Subtasks',
  criteria: 'Criteria',
  due: 'Due date',
  blocked: 'Blocked',
  assignee: 'Assignee',
  milestone: 'Milestone',
  cycle: 'Cycle',
  created: 'Created',
  updated: 'Updated',
};

export function hideDoneLabel(days: number): string {
  if (days === 0) return 'Never';
  return days === 1 ? '1 day' : `${days} days`;
}

// ---------------------------------------------------------------------------
// Queries
// ---------------------------------------------------------------------------

/**
 * The tasks.list fields the display options decide: `sort` (Order by) and `topLevel` (subtasks
 * left out of the list, or hidden on the board where the parent card expands and loads them with
 * `parent`). Spread it into the screen's input next to the filter part (toListTasksInput).
 */
export function displayListInput(options: DisplayOptions): Pick<ListTasksInput, 'sort' | 'topLevel'> {
  const topLevel =
    options.layout === 'board' ? options.boardSubtasks === 'expandable' : options.listSubtasks === 'hidden';
  return { sort: options.orderBy, ...(topLevel ? { topLevel: true } : {}) };
}

/** A task as the display helpers read it: a TaskListItem or anything shaped like one. */
export type DisplayTask = Pick<TaskListItem, 'key' | 'status' | 'priority' | 'updatedAt'> &
  Partial<Pick<TaskListItem, 'assignee' | 'milestone' | 'cycle' | 'labels' | 'parentKey'>>;

/**
 * Whether a row or card shows a property for this task. Priority: only Urgent and High. Assignee:
 * only someone else's (the viewer's own avatar stays hidden). Others: as switched in the options.
 */
export function showsProperty(
  options: DisplayOptions,
  property: TaskProperty,
  task: Pick<DisplayTask, 'priority' | 'assignee'>,
  viewerId?: string | null,
): boolean {
  if (!options.properties[property]) return false;
  if (property === 'priority') return showsPriorityOnCards(task.priority);
  if (property === 'assignee') return Boolean(task.assignee) && task.assignee?.id !== viewerId;
  return true;
}

const CLOSED: ReadonlySet<TaskStatus> = new Set(['done', 'canceled']);
const DAY_MS = 86_400_000;

/**
 * Leaves out Done and Canceled tasks last updated more than `days` days before `now` ("Hide done
 * tasks after 14 days"). `days` 0 keeps everything. The task's last update stands in for when it
 * was closed (the API has no closed-at time).
 */
export function hideOldDone<T extends Pick<DisplayTask, 'status' | 'updatedAt'>>(
  tasks: readonly T[],
  days: number,
  now: Date = new Date(),
): T[] {
  if (days <= 0) return [...tasks];
  const cutoff = now.getTime() - days * DAY_MS;
  return tasks.filter((task) => !CLOSED.has(task.status) || Date.parse(task.updatedAt) >= cutoff);
}

// ---------------------------------------------------------------------------
// Grouping
// ---------------------------------------------------------------------------

/** Order of status groups in the list: active work first (as in M1–M4). */
export const LIST_STATUS_ORDER: readonly TaskStatus[] = [
  'in_progress',
  'in_review',
  'todo',
  'backlog',
  'done',
  'canceled',
];
/** Order of status columns on the board: the flow, backlog first. */
export const BOARD_STATUS_ORDER: readonly TaskStatus[] = TASK_STATUSES;
/** Priority groups: most urgent first, no priority last. */
export const PRIORITY_GROUP_ORDER: readonly Priority[] = [...PRIORITIES].reverse();

/** Key of the group of tasks without a value ("No assignee", "No labels"). */
export const NO_VALUE_GROUP = 'none';

/** What a group header shows: the value behind the group, for its glyph. */
export type TaskGroupValue =
  | { field: 'status'; status: TaskStatus }
  | { field: 'priority'; priority: Priority }
  | { field: 'assignee'; assignee: NonNullable<TaskListItem['assignee']> | null }
  | { field: 'milestone'; milestone: MilestoneRef | null }
  | { field: 'cycle'; cycle: CycleRef | null }
  | { field: 'label'; label: { id: string; name: string; color: number } | null }
  | { field: 'none' };

export interface TaskGroup<T> {
  /** Stable within the field: a status, a priority, an id, or NO_VALUE_GROUP. */
  key: string;
  /** Header text: "In progress", "Urgent", "Ana Ruiz", "No milestone", "Cycle 12". */
  label: string;
  value: TaskGroupValue;
  /** In the order given (the server's sort). */
  tasks: T[];
}

/** Known values, so empty groups can show (showEmptyGroups) and headers have names. All optional. */
export interface GroupContext {
  /** Status order: LIST_STATUS_ORDER (default) or BOARD_STATUS_ORDER; also limits the statuses shown. */
  statuses?: readonly TaskStatus[];
  members?: readonly NonNullable<TaskListItem['assignee']>[];
  milestones?: readonly MilestoneRef[];
  cycles?: readonly CycleRef[];
  labels?: readonly { id: string; name: string; color: number }[];
  /** Puts the viewer's own group first when grouping by assignee. */
  viewerId?: string | null;
  showEmptyGroups?: boolean;
}

function cycleLabel(cycle: CycleRef): string {
  return `Cycle ${cycle.number}`;
}

/**
 * Splits tasks into ordered groups by a field. Statuses and priorities keep their fixed order;
 * assignees go by name (the viewer first), milestones by target date, cycles by number, labels by
 * name, and the "No …" group comes last. A task with several labels shows in each of its label
 * groups. Empty groups show only with `showEmptyGroups` (for known values in `context`).
 * groupBy 'none' gives one group with key 'all'.
 */
export function groupTasks<T extends DisplayTask>(
  tasks: readonly T[],
  groupBy: GroupBy,
  context: GroupContext = {},
): TaskGroup<T>[] {
  const showEmpty = context.showEmptyGroups ?? false;
  if (groupBy === 'none')
    return [{ key: 'all', label: 'All tasks', value: { field: 'none' }, tasks: [...tasks] }];

  if (groupBy === 'status' || groupBy === 'priority') {
    const order: readonly string[] =
      groupBy === 'status' ? (context.statuses ?? LIST_STATUS_ORDER) : PRIORITY_GROUP_ORDER;
    const buckets = new Map<string, T[]>(order.map((key) => [key, []]));
    for (const task of tasks) buckets.get(groupBy === 'status' ? task.status : task.priority)?.push(task);
    return order
      .map((key): TaskGroup<T> => {
        const value: TaskGroupValue =
          groupBy === 'status'
            ? { field: 'status', status: key as TaskStatus }
            : { field: 'priority', priority: key as Priority };
        const label =
          groupBy === 'status' ? STATUS_LABELS[key as TaskStatus] : PRIORITY_LABELS[key as Priority];
        return {
          key,
          label: groupBy === 'priority' && key === 'none' ? 'No priority' : label,
          value,
          tasks: buckets.get(key) ?? [],
        };
      })
      .filter((group) => showEmpty || group.tasks.length > 0);
  }

  interface Bucket {
    key: string;
    label: string;
    value: TaskGroupValue;
    sort: (string | number)[];
    tasks: T[];
  }
  const buckets = new Map<string, Bucket>();
  const none: Bucket = {
    key: NO_VALUE_GROUP,
    label: '',
    value: { field: 'none' },
    sort: [],
    tasks: [],
  };
  const add = (bucket: Omit<Bucket, 'tasks'>, task?: T) => {
    let current = buckets.get(bucket.key);
    if (!current) {
      current = { ...bucket, tasks: [] };
      buckets.set(bucket.key, current);
    }
    if (task) current.tasks.push(task);
  };

  const FAR = Number.MAX_SAFE_INTEGER;
  switch (groupBy) {
    case 'assignee': {
      none.label = 'No assignee';
      none.value = { field: 'assignee', assignee: null };
      const bucket = (assignee: NonNullable<TaskListItem['assignee']>) => ({
        key: assignee.id,
        label: assignee.name,
        value: { field: 'assignee' as const, assignee },
        // The viewer first, then people, then agents, each by name.
        sort: [
          assignee.id === context.viewerId ? 0 : assignee.kind === 'agent' ? 2 : 1,
          assignee.name.toLocaleLowerCase(),
        ],
      });
      if (showEmpty) for (const member of context.members ?? []) add(bucket(member));
      for (const task of tasks) {
        if (task.assignee) add(bucket(task.assignee), task);
        else none.tasks.push(task);
      }
      break;
    }
    case 'milestone': {
      none.label = 'No milestone';
      none.value = { field: 'milestone', milestone: null };
      const bucket = (milestone: MilestoneRef) => ({
        key: milestone.id,
        label: milestone.name,
        value: { field: 'milestone' as const, milestone },
        sort: [milestone.targetDate ?? '9999-99-99', milestone.name.toLocaleLowerCase()],
      });
      if (showEmpty) for (const milestone of context.milestones ?? []) add(bucket(milestone));
      for (const task of tasks) {
        if (task.milestone) add(bucket(task.milestone), task);
        else none.tasks.push(task);
      }
      break;
    }
    case 'cycle': {
      none.label = 'No cycle';
      none.value = { field: 'cycle', cycle: null };
      const bucket = (cycle: CycleRef) => ({
        key: cycle.id,
        label: cycleLabel(cycle),
        value: { field: 'cycle' as const, cycle },
        sort: [cycle.number],
      });
      if (showEmpty) for (const cycle of context.cycles ?? []) add(bucket(cycle));
      for (const task of tasks) {
        if (task.cycle) add(bucket(task.cycle), task);
        else none.tasks.push(task);
      }
      break;
    }
    case 'label': {
      none.label = 'No labels';
      none.value = { field: 'label', label: null };
      const bucket = (label: { id: string; name: string; color: number }) => ({
        key: label.id,
        label: label.name,
        value: { field: 'label' as const, label: { id: label.id, name: label.name, color: label.color } },
        sort: [label.name.toLocaleLowerCase()],
      });
      if (showEmpty) for (const label of context.labels ?? []) add(bucket(label));
      for (const task of tasks) {
        if (task.labels?.length) for (const label of task.labels) add(bucket(label), task);
        else none.tasks.push(task);
      }
      break;
    }
  }

  const compare = (a: Bucket, b: Bucket) => {
    for (let index = 0; index < Math.max(a.sort.length, b.sort.length); index += 1) {
      const x = a.sort[index] ?? FAR;
      const y = b.sort[index] ?? FAR;
      if (x < y) return -1;
      if (x > y) return 1;
    }
    return 0;
  };
  const groups = [...buckets.values()].sort(compare);
  if (showEmpty || none.tasks.length > 0) groups.push(none);
  return groups
    .filter((group) => showEmpty || group.tasks.length > 0)
    .map(({ key, label, value, tasks: groupTasks }) => ({ key, label, value, tasks: groupTasks }));
}
