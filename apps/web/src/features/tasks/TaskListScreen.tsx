import { useQueries, useQuery, useQueryClient } from '@tanstack/react-query';
import { Link, useNavigate, useRouter } from '@tanstack/react-router';
import { FILTER_NONE, type TaskListItem, type TaskStatus } from '@zamu/contracts';
import { type RefObject, useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { labelsQuery } from '~/features/labels/queries';
import { useRegisterCommands } from '~/features/palette/registry';
import { closePeek, isPeekOpen, togglePeek, usePeek } from '~/features/peek/store';
import {
  DetachedToast,
  HiddenTasksStrip,
  isDetached,
  isMirrored,
  MirrorCreateButton,
  MirrorEmptyState,
  MirrorFailedBanner,
  ProjectHeader,
  useProjectSummary,
  ViewSwitch,
} from '~/features/project-header';
import { useSearchText } from '~/features/project-header/useSearchText';
import { usePageSearchRef } from '~/features/shell/page-search';
import { useOptionalQuickCreate } from '~/features/shell/quick-create';
import { type FieldAnchors, type TaskFieldKey, useTaskFieldKeys } from '~/features/task-fields';
import {
  activeFilterFields,
  DisplayButton,
  FilterButton,
  FilterChips,
  type FilterFieldConfig,
  fieldValues,
  hideOldDone,
  rememberTaskNavigation,
  type TaskFilter,
  useDisplayOptions,
  useProjectFilterFields,
  useTaskSelection,
  useUrlTaskFilter,
  useViewCommands,
  type ViewLayout,
} from '~/features/views';
import { useApi, useWorkspaceId, useWorkspaceSlug } from '~/lib/workspace';
import {
  Banner,
  Button,
  buttonStyles,
  EmptyState,
  localToday,
  Menu,
  MenuItem,
  MenuTrigger,
  OPEN_STATUSES,
  SearchField,
  STATUS_LABELS,
  useHotkeys,
} from '~/ui';
import { useNow } from './clock';
import { describeError } from './errors';
import { formatDay } from './format';
import {
  buildListGroups,
  flattenListRows,
  hiddenListGroup,
  type ListGroupRow,
  type ListTaskRow,
  orderedTaskKeys,
} from './groups';
import { rememberListSearch, rememberProjectView } from './list-memory';
import { cyclesQuery, membersQuery, meQuery, milestonesQuery, taskListQuery, taskQuery } from './queries';
import {
  GROUP_ORDER,
  hasFilters,
  LAZY_STATUSES,
  listMainInput,
  type TaskListSearch,
  withProjectFeatures,
} from './search';
import { firstRowOfGroup, moveListCursor } from './selection';
import { type RowPressModifiers, TaskList, type TaskListHandle, TaskListSkeleton } from './TaskTable';

// /p/$projectKey: the project's tasks as a list (frames 011–028).
//
//   [H] Harbor  [List|Board]  ≡ Filter  Display   ● Backlog.md synced 38 min ago  [Search /]  [New task C]
//   Labels is any of 3 labels ×   Assignee is claude-dev ×   + Filter          21 of 123 tasks  Clear
//   ▾ ◐ In progress 13                                                                              +
//   ▮▮ HBR-164  ◐ Savings goals                               • frontend • mobile ◔ 2/7            2m
//
// Grouping, order, subtasks, hidden done tasks and the row properties come from the person's display
// options for this list (useDisplayOptions); the filter lives in the URL (useUrlTaskFilter) and goes to
// tasks.list whole. Grouped by status without a status filter, Backlog, Done and Canceled start folded
// and load when unfolded.
//
// Keys (shortcuts.md "Lists and boards"): J / K and ↓ / ↑ move the cursor over task rows (group rows are
// skipped); ← folds the row's group and puts the cursor on the group row, → unfolds it onto its first
// task (PM-3); Enter opens the task view (the list's keys and position are remembered for its J / K),
// Space peeks; X selects, Shift+↓ / ↑ and Shift+click extend, ⌘A selects everything, Esc clears; the task
// keys (S, P, A, I, L, ⇧D …) act on the cursor task or the selection (useTaskFieldKeys), V switches to the
// board. With two or more tasks selected the action bar shows (frame 014): field pickers in native
// projects, Copy keys, Copy links and Open in Backlog.md in mirrored ones (design call 1).
//
// A mirrored project (M3) keeps its notices: the failed-refresh banner, the detach toast, its empty
// state, the dashed New task, and the tasks removed from Backlog.md (?hidden=only, one group under a strip).

export interface TaskListScreenProps {
  projectKey: string;
  search: TaskListSearch;
}

const LIST_VIEW_NAME = 'List';

const pickItems = (results: { data?: { items: TaskListItem[] } }[]) =>
  results.map((result) => result.data?.items);

/** "a", "a and b", "a, b and c". */
function joinWords(words: readonly string[]): string {
  if (words.length <= 1) return words[0] ?? '';
  return `${words.slice(0, -1).join(', ')} and ${words.at(-1)}`;
}

function optionNames(config: FilterFieldConfig | undefined, ids: readonly string[]): string[] {
  return ids.map((id) => {
    const option = config?.options.find((item) => item.id === id);
    return typeof option?.label === 'string' ? option.label : id;
  });
}

/** "is labelled design and assigned to review-bot", for the no-results sentence (frame 017). */
export function describeTaskFilter(filter: TaskFilter, fields: readonly FilterFieldConfig[]): string[] {
  const configOf = (field: FilterFieldConfig['field']) => fields.find((config) => config.field === field);
  const or = (names: string[]) =>
    names.length > 1 ? `${names.slice(0, -1).join(', ')} or ${names.at(-1)}` : (names[0] ?? '');
  const parts: string[] = [];
  for (const field of activeFilterFields(filter)) {
    const ids = fieldValues(filter, field);
    switch (field) {
      case 'status':
        parts.push(`is ${or((filter.status ?? []).map((status) => STATUS_LABELS[status]))}`);
        break;
      case 'priority':
        parts.push(`has priority ${or(optionNames(configOf(field), ids))}`);
        break;
      case 'assignee': {
        const names = (filter.assignee ?? []).map((value) =>
          value === 'me'
            ? 'you'
            : value === 'agents'
              ? 'an agent'
              : (optionNames(configOf(field), [value])[0] ?? value),
        );
        const none = (filter.assignee ?? []).includes(FILTER_NONE);
        const assigned = names.filter((_, index) => filter.assignee?.[index] !== FILTER_NONE);
        parts.push(
          none && assigned.length === 0
            ? 'is unassigned'
            : `is assigned to ${or(assigned)}${none ? ' or unassigned' : ''}`,
        );
        break;
      }
      case 'label':
        parts.push(`is labelled ${or(optionNames(configOf(field), ids))}`);
        break;
      case 'due':
        parts.push(
          filter.due === 'overdue'
            ? 'is overdue'
            : filter.due === 'soon'
              ? 'is due soon'
              : filter.due === 'none'
                ? 'has no due date'
                : 'has a due date',
        );
        break;
      case 'blocked':
        parts.push(filter.blocked ? 'is blocked' : 'is not blocked');
        break;
      case 'milestone':
        parts.push(`is in ${or(optionNames(configOf(field), ids))}`);
        break;
      case 'cycle':
        parts.push(`is in ${or(optionNames(configOf(field), ids))}`);
        break;
    }
  }
  if (filter.q?.trim()) parts.push(`matches "${filter.q.trim()}"`);
  return parts;
}

/** Status grouping without a status filter: these start folded and load when unfolded. */
function initialCollapsed(statusGrouping: boolean, filter: TaskFilter): Set<string> {
  return new Set<string>(statusGrouping && !filter.status ? LAZY_STATUSES : []);
}

export function TaskListScreen({ projectKey, search }: TaskListScreenProps) {
  const workspace = useWorkspaceSlug();
  const workspaceId = useWorkspaceId();
  const api = useApi();
  const navigate = useNavigate();
  const router = useRouter();
  const queryClient = useQueryClient();
  const quickCreate = useOptionalQuickCreate();
  const project = useProjectSummary(projectKey);
  const usesMilestones = project?.usesMilestones ?? false;
  const usesCycles = project?.usesCycles ?? false;
  const mirrored = isMirrored(project);
  const detached = isDetached(project);
  const wideKeys = project?.backlog != null;
  const projectName = project?.name ?? projectKey;
  const viewerId = useQuery(meQuery(api)).data?.user.id ?? null;
  const now = useNow();
  const today = useMemo(() => (now == null ? '' : localToday(new Date(now))), [now]);

  // ---- Filter, display options, search text --------------------------------------------------------
  const [urlFilter, setFilter] = useUrlTaskFilter();
  // Milestone and cycle filters only apply while the project uses them.
  const filter = useMemo<TaskFilter>(
    () => withProjectFeatures(urlFilter, project ? { usesMilestones, usesCycles } : undefined),
    [urlFilter, project, usesMilestones, usesCycles],
  );
  const filterRef = useRef(filter);
  filterRef.current = filter;
  const fields = useProjectFilterFields(projectKey, { projectName, usesMilestones, usesCycles });
  const [display] = useDisplayOptions(projectKey, 'list');
  const showHidden = search.hidden === 'only';
  const statusGrouping = display.groupBy === 'status' && !showHidden;

  useEffect(() => rememberListSearch(workspaceId, projectKey, search), [workspaceId, projectKey, search]);

  const [query, setQuery, resetQuery] = useSearchText(filter.q, (q) =>
    setFilter({ ...filterRef.current, ...(q ? { q } : { q: undefined }) }),
  );
  const searchRef = usePageSearchRef();

  // ---- Data ------------------------------------------------------------------------------------------
  const collapseScope = `${display.groupBy}|${filter.status?.join(',') ?? ''}|${showHidden}`;
  const [collapsedState, setCollapsedState] = useState(() => ({
    scope: collapseScope,
    set: initialCollapsed(statusGrouping, filter),
  }));
  const collapsed =
    collapsedState.scope === collapseScope ? collapsedState.set : initialCollapsed(statusGrouping, filter);
  const setCollapsed = useCallback(
    (update: (previous: Set<string>) => Set<string>) =>
      setCollapsedState((previous) => {
        const base =
          previous.scope === collapseScope
            ? previous.set
            : initialCollapsed(statusGrouping, filterRef.current);
        return { scope: collapseScope, set: update(base) };
      }),
    [collapseScope, statusGrouping],
  );

  const mainInput = listMainInput(projectKey, filter, display, showHidden);
  const main = useQuery(taskListQuery(api, mainInput));
  const lazyStatuses =
    statusGrouping && !filter.status ? LAZY_STATUSES.filter((status) => !collapsed.has(status)) : [];
  const lazyItems = useQueries({
    queries: lazyStatuses.map((status) => taskListQuery(api, { ...mainInput, status: [status] })),
    combine: pickItems,
  });
  const counts = main.data?.counts;

  const labels = useQuery(labelsQuery(api, projectKey)).data?.items;
  const members = useQuery(membersQuery(api)).data?.items;
  const wantsMilestones = display.showEmptyGroups && display.groupBy === 'milestone' && usesMilestones;
  const wantsCycles = display.showEmptyGroups && display.groupBy === 'cycle' && usesCycles;
  const milestones = useQuery({ ...milestonesQuery(api, projectKey), enabled: wantsMilestones }).data?.items;
  const cycles = useQuery({ ...cyclesQuery(api, projectKey), enabled: wantsCycles }).data?.items;

  const lazyKey = lazyItems.map((items) => items?.length ?? -1).join(',');
  // biome-ignore lint/correctness/useExhaustiveDependencies: lazyKey stands for lazyItems' contents
  const groups = useMemo(() => {
    const at = now == null ? undefined : new Date(now);
    const visible = (items: readonly TaskListItem[]) =>
      at ? hideOldDone(items, display.hideDoneAfterDays, at) : [...items];
    if (showHidden) return hiddenListGroup(main.data?.items ?? []);
    const pendingCounts: Partial<Record<TaskStatus, number>> = {};
    if (statusGrouping && !filter.status) {
      LAZY_STATUSES.forEach((status) => {
        const index = lazyStatuses.indexOf(status);
        if (index < 0 || lazyItems[index] === undefined) pendingCounts[status] = counts?.[status] ?? 0;
      });
    }
    return buildListGroups({
      lists: [visible(main.data?.items ?? []), ...lazyItems.map((items) => visible(items ?? []))],
      groupBy: display.groupBy,
      nested: display.listSubtasks === 'nested',
      pendingCounts,
      context: {
        statuses: filter.status
          ? GROUP_ORDER.filter((status) => filter.status?.includes(status))
          : GROUP_ORDER,
        viewerId,
        showEmptyGroups: display.showEmptyGroups,
        ...(members
          ? { members: members.map((m) => ({ id: m.id, name: m.name, kind: m.kind, responsible: null })) }
          : {}),
        ...(labels ? { labels } : {}),
        ...(milestones
          ? {
              milestones: milestones.map((m) => ({
                id: m.id,
                name: m.name,
                status: m.status,
                targetDate: m.targetDate,
              })),
            }
          : {}),
        ...(cycles
          ? {
              cycles: cycles.map((c) => ({
                id: c.id,
                number: c.number,
                name: c.name,
                startsOn: c.startsOn,
                endsOn: c.endsOn,
                state: c.state,
              })),
            }
          : {}),
      },
    });
  }, [
    main.data,
    lazyKey,
    lazyStatuses.join(','),
    display,
    filter.status,
    counts,
    statusGrouping,
    showHidden,
    now,
    viewerId,
    members,
    labels,
    milestones,
    cycles,
  ]);

  const headers = showHidden || display.groupBy !== 'none';
  const rows = useMemo(() => flattenListRows(groups, collapsed, headers), [groups, collapsed, headers]);
  const orderedKeys = useMemo(() => orderedTaskKeys(rows), [rows]);
  const itemsByKey = useMemo(() => {
    const map = new Map<string, TaskListItem>();
    for (const row of rows) if (row.type === 'task') map.set(row.task.key, row.task);
    return map;
  }, [rows]);

  // ---- Cursor and selection ----------------------------------------------------------------------------
  const listRef = useRef<TaskListHandle>(null);
  const rowsRef = useRef(rows);
  rowsRef.current = rows;
  const [cursorId, setCursorId] = useState<string | null>(null);
  const cursorRef = useRef<string | null>(null);
  // These read the latest rows through the ref, so they never change.
  const rowOf = useCallback(
    (id: string | null) => (id == null ? undefined : rowsRef.current.find((row) => row.id === id)),
    [],
  );
  const taskOfRow = useCallback(
    (id: string | null) => {
      const row = rowOf(id);
      return row?.type === 'task' ? row.task.key : null;
    },
    [rowOf],
  );
  const firstRowOfKey = useCallback(
    (key: string) => rowsRef.current.find((row) => row.type === 'task' && row.task.key === key)?.id ?? null,
    [],
  );

  const selectionRef = useRef<ReturnType<typeof useTaskSelection> | null>(null);
  /** Moves the cursor; `focus` puts DOM focus on the row (keys pressed, a row clicked). */
  const placeCursor = useCallback(
    (id: string | null, { focus = false }: { focus?: boolean } = {}) => {
      cursorRef.current = id;
      setCursorId(id);
      selectionRef.current?.focus(taskOfRow(id));
      if (id) listRef.current?.reveal(id, { focus });
    },
    [taskOfRow],
  );

  const selection = useTaskSelection(orderedKeys, {
    hotkeys: false,
    view: LIST_VIEW_NAME,
    onFocusChange: (key) => {
      // The selection moved the focus itself (X on a row, Shift+↓, Shift+click, Esc): follow it.
      if (key === taskOfRow(cursorRef.current)) return;
      const id = key
        ? firstRowOfKey(key)
        : rowOf(cursorRef.current)?.type === 'group'
          ? cursorRef.current
          : null;
      cursorRef.current = id;
      setCursorId(id);
      if (id) {
        const inList = listRef.current?.hasFocus() ?? false;
        listRef.current?.reveal(id, { focus: inList || document.activeElement === document.body });
      }
    },
  });
  selectionRef.current = selection;
  const selectedSet = useMemo(() => new Set(selection.selectedKeys), [selection.selectedKeys]);

  // The cursor's row went away (filtered out, folded): drop it; a folded task's group row takes it.
  useEffect(() => {
    const id = cursorRef.current;
    if (id == null || rows.some((row) => row.id === id)) return;
    const key = id.includes('\u001f') ? id.slice(id.lastIndexOf('\u001f') + 1) : null;
    const again = key ? firstRowOfKey(key) : null;
    cursorRef.current = again;
    setCursorId(again);
  }, [rows, firstRowOfKey]);

  // Back from the task view (?focus=PAY-142): put the cursor on that task once its row is there, and
  // unfold its group when it sits in a folded one.
  const pendingFocus = useRef<string | null>(search.focus ?? null);
  useEffect(() => {
    if (!search.focus) return;
    pendingFocus.current = search.focus;
    void navigate({
      to: '.',
      search: ((previous: TaskListSearch) => ({ ...previous, focus: undefined })) as never,
      replace: true,
    });
  }, [search.focus, navigate]);
  const lazyLoading = lazyItems.some((items) => items === undefined);
  // biome-ignore lint/correctness/useExhaustiveDependencies: runs when the rows change (rows stands for them)
  useEffect(() => {
    const key = pendingFocus.current;
    if (!key || main.isPending) return;
    const id = firstRowOfKey(key);
    if (id) {
      pendingFocus.current = null;
      placeCursor(id, { focus: true });
      return;
    }
    const status = queryClient.getQueryData(taskQuery(api, key).queryKey)?.status;
    if (status && statusGrouping && collapsed.has(status)) {
      setCollapsed((previous) => {
        const next = new Set(previous);
        next.delete(status);
        return next;
      });
    } else if (!status || !collapsed.has(status)) {
      // Not in this list (filtered out, or gone): forget it once the rows have settled.
      if (!lazyLoading) pendingFocus.current = null;
    }
  }, [
    rows,
    main.isPending,
    lazyLoading,
    collapsed,
    statusGrouping,
    queryClient,
    setCollapsed,
    firstRowOfKey,
    placeCursor,
  ]);

  // → on a folded group whose rows still load: put the cursor on its first task once it is there.
  const pendingGroup = useRef<string | null>(null);
  useEffect(() => {
    const groupRow = pendingGroup.current;
    if (!groupRow) return;
    const first = firstRowOfGroup(rows, groupRow);
    if (first) {
      pendingGroup.current = null;
      if (cursorRef.current === groupRow) placeCursor(first, { focus: listRef.current?.hasFocus() ?? false });
    }
  }, [rows, placeCursor]);

  const toggleGroup = useCallback(
    (groupKey: string, expand: boolean) =>
      setCollapsed((previous) => {
        const next = new Set(previous);
        if (expand) next.delete(groupKey);
        else next.add(groupKey);
        return next;
      }),
    [setCollapsed],
  );

  // ---- Navigation ----------------------------------------------------------------------------------------
  const setView = useCallback(
    (layout: ViewLayout) => {
      if (layout !== 'board') return;
      rememberProjectView(workspaceId, projectKey, 'board');
      void navigate({
        to: '/w/$workspace/p/$projectKey',
        params: { workspace, projectKey },
        search: ((previous: TaskListSearch) => ({
          ...previous,
          view: 'board',
          hidden: undefined,
          focus: undefined,
        })) as never,
      });
    },
    [navigate, projectKey, workspace, workspaceId],
  );
  const orderedKeysRef = useRef(orderedKeys);
  orderedKeysRef.current = orderedKeys;
  const openTask = useCallback(
    (key: string) => {
      const location = router.state.location;
      rememberTaskNavigation(
        workspaceId,
        { keys: orderedKeysRef.current, from: LIST_VIEW_NAME, returnTo: location.href },
        key,
      );
      closePeek();
      void navigate({
        to: '/w/$workspace/p/$projectKey/$taskKey',
        params: { workspace, projectKey, taskKey: key },
      });
    },
    [navigate, projectKey, router, workspace, workspaceId],
  );
  const peek = useCallback(
    (key: string) =>
      togglePeek({
        key,
        keys: orderedKeysRef.current,
        from: LIST_VIEW_NAME,
        onMove: (next) => {
          const id = firstRowOfKey(next);
          if (id) placeCursor(id);
        },
      }),
    [placeCursor, firstRowOfKey],
  );
  const peekOpen = usePeek() != null;
  const newTask = useCallback(
    (status?: TaskStatus) => quickCreate?.open(projectKey, status ? { status } : undefined),
    [quickCreate, projectKey],
  );

  // ---- Keys ------------------------------------------------------------------------------------------------
  /** Arrows, Enter and Space act from the page or a row, not from a button or a segmented control. */
  const onRowsOrPage = (event: KeyboardEvent) => {
    const target = event.target;
    if (target === document.body || target === document.documentElement) return true;
    return target instanceof HTMLElement && target.dataset.rowId != null;
  };
  const move = (step: 1 | -1) => {
    const target = moveListCursor(rowsRef.current, cursorRef.current, step);
    if (target) placeCursor(target, { focus: true });
  };
  const fold = () => {
    const row = rowOf(cursorRef.current);
    if (row?.type === 'task' && row.groupRowId) {
      placeCursor(row.groupRowId, { focus: true });
      toggleGroup(row.groupKey, false);
    } else if (row?.type === 'group' && !row.collapsed) {
      toggleGroup(row.group.key, false);
    }
  };
  const unfold = () => {
    const row = rowOf(cursorRef.current);
    if (row?.type !== 'group') return;
    const first = firstRowOfGroup(rowsRef.current, row.id);
    if (first) {
      placeCursor(first, { focus: true });
      return;
    }
    pendingGroup.current = row.id;
    toggleGroup(row.group.key, true);
  };
  const activate = (kind: 'open' | 'peek') => {
    const row = rowOf(cursorRef.current);
    if (row?.type === 'group') {
      if (kind === 'open') toggleGroup(row.group.key, row.collapsed);
      return;
    }
    if (row?.type !== 'task') return;
    if (kind === 'open') openTask(row.task.key);
    else peek(row.task.key);
  };
  const keysEnabled = !peekOpen;
  const guarded = (handler: () => void) => ({
    enabled: keysEnabled,
    preventDefault: false,
    handler: (event: KeyboardEvent) => {
      if (!onRowsOrPage(event)) return;
      event.preventDefault();
      handler();
    },
  });
  useHotkeys({
    j: { enabled: keysEnabled, handler: () => move(1) },
    k: { enabled: keysEnabled, handler: () => move(-1) },
    ArrowDown: guarded(() => move(1)),
    ArrowUp: guarded(() => move(-1)),
    ArrowLeft: guarded(fold),
    ArrowRight: guarded(unfold),
    'Shift+ArrowDown': guarded(() => selection.extend(1)),
    'Shift+ArrowUp': guarded(() => selection.extend(-1)),
    Enter: guarded(() => activate('open')),
    Space: guarded(() => activate('peek')),
    x: () => {
      const key = taskOfRow(cursorRef.current);
      if (key) selection.toggle(key);
    },
    'Mod+a': { allowInInputs: false, handler: () => selection.selectAll() },
    Escape: {
      enabled: keysEnabled,
      preventDefault: false,
      handler: (event) => {
        if (isPeekOpen()) return;
        if (selection.escape()) event.preventDefault();
      },
    },
  });

  useViewCommands({ layout: 'list', onLayoutChange: setView, fields, filter, onFilterChange: setFilter });

  // ---- Task keys and pickers -----------------------------------------------------------------------------
  const targets = useMemo(
    () =>
      selection.targetKeys
        .map((key) => itemsByKey.get(key))
        .filter((task): task is TaskListItem => task !== undefined),
    [selection.targetKeys, itemsByKey],
  );
  const multi = selection.selectedKeys.length >= 2;
  const statusRef = useRef<HTMLSpanElement>(null);
  const assigneeRef = useRef<HTMLSpanElement>(null);
  const labelsRef = useRef<HTMLSpanElement>(null);
  const priorityRef = useRef<HTMLSpanElement>(null);
  const dueRef = useRef<HTMLSpanElement>(null);
  const moreRef = useRef<HTMLSpanElement>(null);
  const barRefs = {
    status: statusRef,
    assignee: assigneeRef,
    labels: labelsRef,
    priority: priorityRef,
    dueDate: dueRef,
    more: moreRef,
  };
  // The cursor row, read when a picker opens (rows re-render as the cursor moves).
  const cursorAnchor = useMemo<RefObject<Element | null>>(
    () => ({
      get current() {
        const id = cursorRef.current;
        return id ? (listRef.current?.rowElement(id) ?? null) : null;
      },
    }),
    [],
  );
  // Refs are stable, so this object is made once.
  const barAnchors = useMemo<FieldAnchors>(
    () => ({
      status: statusRef,
      assignee: assigneeRef,
      labels: labelsRef,
      priority: priorityRef,
      dueDate: dueRef,
      milestone: moreRef,
      cycle: moreRef,
    }),
    [],
  );
  const fieldKeys = useTaskFieldKeys({
    targets,
    enabled: !peekOpen,
    anchors: multi && !mirrored ? barAnchors : cursorAnchor,
  });

  // ---- Hidden tasks (mirrored projects) --------------------------------------------------------------------
  const hiddenCount = mirrored
    ? showHidden
      ? (main.data?.items.length ?? project?.backlog?.hidden ?? 0)
      : (project?.backlog?.hidden ?? 0)
    : 0;
  const showHiddenTasks = useCallback(
    (show: boolean) =>
      void navigate({
        to: '.',
        search: ((previous: TaskListSearch) => ({ ...previous, hidden: show ? 'only' : undefined })) as never,
        replace: true,
      }),
    [navigate],
  );
  const hiddenCommands = useMemo(
    () =>
      mirrored && (hiddenCount > 0 || showHidden)
        ? [
            {
              id: 'view.hidden-tasks',
              title: showHidden ? 'Show the tasks in Backlog.md' : 'Show tasks removed from Backlog.md',
              section: 'view' as const,
              keywords: ['hidden', 'removed', 'deleted', 'backlog'],
              run: () => {
                showHiddenTasks(!showHidden);
                return undefined;
              },
            },
          ]
        : [],
    [mirrored, hiddenCount, showHidden, showHiddenTasks],
  );
  useRegisterCommands(hiddenCommands);

  // ---- Rows: clicks and checkboxes ---------------------------------------------------------------------------
  const onRowPress = useCallback(
    (row: ListTaskRow, modifiers: RowPressModifiers) => {
      cursorRef.current = row.id;
      setCursorId(row.id);
      if (selection.handleClick(row.task.key, modifiers)) return;
      openTask(row.task.key);
    },
    [selection, openTask],
  );
  const onCheckbox = useCallback(
    (row: ListTaskRow, modifiers: RowPressModifiers) => {
      cursorRef.current = row.id;
      setCursorId(row.id);
      if (modifiers.shiftKey) selection.selectRange(row.task.key);
      else selection.toggle(row.task.key);
    },
    [selection],
  );
  const onGroupToggle = useCallback(
    (row: ListGroupRow) => {
      placeCursor(row.id);
      toggleGroup(row.group.key, row.collapsed);
    },
    [placeCursor, toggleGroup],
  );
  const onGroupAdd = useCallback(
    (row: ListGroupRow) => newTask(row.group.value.field === 'status' ? row.group.value.status : undefined),
    [newTask],
  );
  const onRowFocus = useCallback(
    (id: string) => {
      if (cursorRef.current !== id) placeCursor(id);
    },
    [placeCursor],
  );

  // ---- States ------------------------------------------------------------------------------------------------
  const filtered = hasFilters({ ...search, hidden: undefined }) || Boolean(filter.q);
  const matchStatuses = filter.status ?? OPEN_STATUSES;
  const matchCount = counts
    ? matchStatuses.reduce((sum, status) => sum + (counts[status] ?? 0), 0)
    : undefined;
  const total = filter.status?.some((status) => !OPEN_STATUSES.includes(status))
    ? undefined
    : project?.openCount;
  const serverTotal = counts ? Object.values(counts).reduce((sum, value) => sum + value, 0) : undefined;
  const isEmptyProject = !showHidden && !filtered && serverTotal === 0;
  const listError = main.isError && !main.data ? describeError(main.error) : null;
  const clearFilters = () => {
    resetQuery();
    setFilter({});
  };
  const detachedAt = detached ? project?.backlog?.detachedAt : null;
  const detachedNote =
    detachedAt && now != null ? `detached from Backlog.md on ${formatDay(detachedAt, new Date(now))}` : null;
  const subtitle = isEmptyProject
    ? 'no tasks yet'
    : project?.openCount != null
      ? `${project.openCount} open${detachedNote ? ` · ${detachedNote}` : ''}`
      : (detachedNote ?? undefined);

  const renderBody = () => {
    if (listError) {
      return (
        <div className="px-4.5 py-3.5">
          <Banner
            action={
              <Button
                variant="secondary"
                size="sm"
                isPending={main.isFetching}
                onPress={() => main.refetch()}
              >
                Try again
              </Button>
            }
          >
            Couldn’t load tasks. {listError.message}
          </Banner>
          {listError.requestId ? (
            <p className="m-0 mt-2 text-xs text-fg-3">
              Request ID <span className="tabular-nums">{listError.requestId}</span>
            </p>
          ) : null}
        </div>
      );
    }
    if (main.isPending) return <TaskListSkeleton />;
    if (showHidden && rows.length === 0) {
      return (
        <div className="flex flex-1">
          <EmptyState
            align="center"
            className="m-auto"
            title="No tasks were removed from Backlog.md"
            text={filtered ? 'None of them match these filters.' : undefined}
            action={
              <Button variant="secondary" onPress={() => showHiddenTasks(false)}>
                Show the other tasks
              </Button>
            }
          />
        </div>
      );
    }
    if (isEmptyProject && mirrored && project) return <MirrorEmptyState project={project} />;
    if (isEmptyProject) {
      return (
        <div className="flex flex-1">
          <EmptyState
            align="center"
            className="m-auto"
            title={`No tasks in ${projectName} yet`}
            text="Create the first task, or mirror an existing Backlog.md folder from a repository."
            action={
              <>
                <Button kbd="C" onPress={() => newTask()}>
                  New task
                </Button>
                <Link
                  to="/w/$workspace/p/$projectKey/backlog-setup"
                  params={{ workspace, projectKey }}
                  className={buttonStyles({ variant: 'secondary' })}
                >
                  Mirror Backlog.md
                </Link>
              </>
            }
          />
        </div>
      );
    }
    if (rows.length === 0 && !filtered) {
      return (
        <div className="flex flex-1">
          <EmptyState
            align="center"
            className="m-auto"
            title="Nothing to show"
            text={`Done tasks last updated more than ${display.hideDoneAfterDays} days ago are hidden. Change it in Display.`}
          />
        </div>
      );
    }
    if (rows.length === 0) {
      const words = describeTaskFilter(filter, fields);
      return (
        <div className="flex flex-1">
          <EmptyState
            align="center"
            className="m-auto"
            title="No tasks match these filters"
            text={
              words.length
                ? `Nothing in ${projectName} ${joinWords(words)}. Remove a filter or clear them all.`
                : `Nothing in ${projectName} matches. Remove a filter or clear them all.`
            }
            action={
              <Button variant="secondary" onPress={clearFilters}>
                Clear filters
              </Button>
            }
          />
        </div>
      );
    }
    return (
      <TaskList
        ref={listRef}
        aria-label={`Tasks in ${projectName}`}
        rows={rows}
        cursorId={cursorId}
        selectedKeys={selectedSet}
        checkboxes={selection.selectedKeys.length > 0}
        display={display}
        viewerId={viewerId}
        now={now}
        today={today}
        headers={headers}
        wideKeys={wideKeys}
        hiddenView={showHidden}
        onRowPress={onRowPress}
        onCheckbox={onCheckbox}
        onGroupToggle={onGroupToggle}
        onGroupAdd={showHidden ? undefined : onGroupAdd}
        onRowFocus={onRowFocus}
        footer={
          mirrored && !showHidden && hiddenCount > 0 ? (
            <p className="m-0 flex items-center gap-1.5 px-4.5 py-4 text-sm text-fg-3">
              {hiddenCount === 1 ? '1 task was' : `${hiddenCount} tasks were`} removed from Backlog.md and{' '}
              {hiddenCount === 1 ? 'is' : 'are'} hidden.
              <Button
                variant="ghost"
                size="sm"
                className="text-sm text-accent-text"
                onPress={() => showHiddenTasks(true)}
              >
                Show {hiddenCount === 1 ? 'it' : 'them'}
              </Button>
            </p>
          ) : null
        }
      />
    );
  };

  const header = (
    <ProjectHeader
      projectKey={projectKey}
      current="tasks"
      subtitle={subtitle}
      viewSwitch={<ViewSwitch view="list" onChange={(view) => setView(view)} />}
      filter={<FilterButton fields={fields} filter={filter} onChange={setFilter} />}
      display={<DisplayButton projectKey={projectKey} view="list" onLayoutChange={setView} />}
      search={
        <SearchField
          width={200}
          placeholder="Search"
          value={query}
          onChange={setQuery}
          inputRef={searchRef}
          aria-label="Search tasks"
          onKeyDown={(event) => {
            if (event.key === 'Enter' || event.key === 'ArrowDown') {
              event.preventDefault();
              const first = cursorRef.current ?? moveListCursor(rowsRef.current, null, 1);
              if (first) placeCursor(first, { focus: true });
            } else {
              event.continuePropagation();
            }
          }}
        />
      }
      actions={
        mirrored ? (
          <MirrorCreateButton projectName={projectName} onPress={() => newTask()} aria-keyshortcuts="c">
            New task
          </MirrorCreateButton>
        ) : (
          <Button kbd="C" onPress={() => newTask()} aria-keyshortcuts="c">
            New task
          </Button>
        )
      }
    />
  );

  return (
    <section aria-label="Tasks" className="relative flex h-dvh min-h-0 min-w-0 flex-1 flex-col bg-bg text-fg">
      {header}
      {showHidden ? null : (
        <FilterChips
          fields={fields}
          filter={filter}
          onChange={setFilter}
          {...(matchCount !== undefined ? { matchCount } : {})}
          {...(total !== undefined && matchCount !== undefined ? { total } : {})}
        />
      )}
      <MirrorFailedBanner project={project} />
      {showHidden && rows.length ? (
        <HiddenTasksStrip count={hiddenCount} branch={project?.backlog?.defaultBranch ?? null} />
      ) : null}
      <div className="flex min-h-0 flex-1 flex-col">{renderBody()}</div>
      {multi ? (
        <ActionBar
          count={selection.selectedKeys.length}
          mirrored={mirrored}
          selectedKeys={selection.selectedKeys}
          refs={barRefs}
          usesMilestones={usesMilestones}
          usesCycles={usesCycles}
          onField={(field) => fieldKeys.openField(field)}
          onCopyKeys={fieldKeys.copyKeys}
          onCopyLinks={fieldKeys.copyLinks}
          onClear={() => selection.clear()}
        />
      ) : null}
      {fieldKeys.pickers}
      <DetachedToast project={project} />
    </section>
  );
}

// ---------------------------------------------------------------------------
// Action bar (frame 014)
// ---------------------------------------------------------------------------

interface ActionBarProps {
  count: number;
  mirrored: boolean;
  selectedKeys: readonly string[];
  refs: Record<
    'status' | 'assignee' | 'labels' | 'priority' | 'dueDate' | 'more',
    RefObject<HTMLSpanElement | null>
  >;
  usesMilestones: boolean;
  usesCycles: boolean;
  onField: (field: TaskFieldKey) => void;
  onCopyKeys: () => void;
  onCopyLinks: () => void;
  onClear: () => void;
}

const BAR_FIELDS: readonly {
  field: TaskFieldKey;
  ref: keyof ActionBarProps['refs'];
  label: string;
  kbd: string;
}[] = [
  { field: 'status', ref: 'status', label: 'Status', kbd: 'S' },
  { field: 'assignee', ref: 'assignee', label: 'Assignee', kbd: 'A' },
  { field: 'labels', ref: 'labels', label: 'Labels', kbd: 'L' },
  { field: 'priority', ref: 'priority', label: 'Priority', kbd: 'P' },
  { field: 'dueDate', ref: 'dueDate', label: 'Due', kbd: '⇧D' },
];

function ActionBar({
  count,
  mirrored,
  selectedKeys,
  refs,
  usesMilestones,
  usesCycles,
  onField,
  onCopyKeys,
  onCopyLinks,
  onClear,
}: ActionBarProps) {
  return (
    <div
      role="toolbar"
      aria-label={`${count} selected`}
      className="absolute bottom-5.5 left-1/2 z-25 flex h-11.5 -translate-x-1/2 items-center gap-1 rounded-lg bg-surface-pop pr-1.5 pl-3.5 whitespace-nowrap shadow-lift"
    >
      <span className="mr-2 font-semibold">{count} selected</span>
      {mirrored ? (
        <>
          <Button variant="quiet" kbd="⌘C" onPress={onCopyKeys}>
            Copy keys
          </Button>
          <Button variant="quiet" kbd="⌘⇧C" onPress={onCopyLinks}>
            Copy links
          </Button>
          <OpenInBacklogMenu keys={selectedKeys} />
        </>
      ) : (
        <>
          {BAR_FIELDS.map((item) => (
            <span key={item.field} ref={refs[item.ref]} className="inline-flex">
              <Button variant="quiet" kbd={item.kbd} onPress={() => onField(item.field)}>
                {item.label}
              </Button>
            </span>
          ))}
          <span aria-hidden className="mx-1 h-5.5 w-px bg-line" />
          <span ref={refs.more} className="inline-flex">
            <MenuTrigger>
              <Button variant="quiet" aria-label="More actions">
                ···
              </Button>
              <Menu placement="top end">
                {usesMilestones ? (
                  <MenuItem id="milestone" kbd="⇧M" onAction={() => onField('milestone')}>
                    Milestone
                  </MenuItem>
                ) : null}
                {usesCycles ? (
                  <MenuItem id="cycle" kbd="⇧C" onAction={() => onField('cycle')}>
                    Cycle
                  </MenuItem>
                ) : null}
                <MenuItem id="copy-keys" kbd="⌘C" onAction={onCopyKeys}>
                  Copy keys
                </MenuItem>
                <MenuItem id="copy-links" kbd="⌘⇧C" onAction={onCopyLinks}>
                  Copy links
                </MenuItem>
              </Menu>
            </MenuTrigger>
          </span>
        </>
      )}
      <Button variant="quiet" kbd="Esc" aria-label="Clear the selection" onPress={onClear} />
    </div>
  );
}

/** Mirrored projects: the selected tasks' files on the git provider, one link each. */
function OpenInBacklogMenu({ keys }: { keys: readonly string[] }) {
  const api = useApi();
  const [open, setOpen] = useState(false);
  const tasks = useQueries({
    queries: keys.map((key) => ({ ...taskQuery(api, key), enabled: open })),
    combine: (results) => results.map((result) => result.data),
  });
  return (
    <MenuTrigger isOpen={open} onOpenChange={setOpen}>
      <Button variant="quiet">Open in Backlog.md</Button>
      <Menu
        placement="top end"
        aria-label="Backlog.md files"
        items={keys.map((key, index) => ({ key, task: tasks[index] }))}
      >
        {(item) => {
          const url = item.task?.backlog?.fileUrl ?? null;
          return (
            <MenuItem
              id={item.key}
              textValue={item.key}
              isDisabled={!url}
              {...(url ? { href: url, target: '_blank', rel: 'noreferrer' } : {})}
            >
              <span className="flex min-w-0 items-baseline gap-2">
                <span className="text-xs font-medium text-fg-3 tabular-nums">{item.key}</span>
                <span className="truncate">{item.task ? item.task.title : 'Loading…'}</span>
                {item.task && !url ? <span className="text-xs text-fg-3">No file link</span> : null}
              </span>
            </MenuItem>
          );
        }}
      </Menu>
    </MenuTrigger>
  );
}
