import { useQuery, useQueryClient } from '@tanstack/react-query';
import { useNavigate, useRouter } from '@tanstack/react-router';
import { type AssigneeRef, TASK_STATUSES, type TaskListItem, type TaskStatus } from '@zamu/contracts';
import {
  type FocusEvent,
  type KeyboardEvent,
  type PointerEvent,
  type ReactNode,
  useCallback,
  useEffect,
  useMemo,
  useRef,
  useState,
} from 'react';
import { labelsQuery } from '~/features/labels/queries';
import { closePeek, togglePeek, usePeek } from '~/features/peek/store';
import {
  DetachedToast,
  DRAG_REFUSAL_TEXT,
  isMirrored,
  MirrorCreateButton,
  MirrorEmptyState,
  MirrorFailedBanner,
  ProjectHeader,
  statusRefusalText,
  useProjectSummary,
  ViewSwitch,
} from '~/features/project-header';
import { useSearchText } from '~/features/project-header/useSearchText';
import { usePageSearchRef } from '~/features/shell/page-search';
import { useOptionalQuickCreate } from '~/features/shell/quick-create';
import { confirmFinishing, finishingRequest, useFieldChange, useTaskFieldKeys } from '~/features/task-fields';
import { toCycleRef, toMilestoneRef } from '~/features/task-fields/planning';
import { showFieldToast } from '~/features/task-fields/toast';
import { useNow } from '~/features/tasks/clock';
import { describeError } from '~/features/tasks/errors';
import { formatAge } from '~/features/tasks/format';
import { rememberListSearch, rememberProjectView } from '~/features/tasks/list-memory';
import { membersQuery, meQuery } from '~/features/tasks/queries';
import { BOARD_FOLDED, type TaskListSearch, type TaskView } from '~/features/tasks/search';
import {
  BOARD_STATUS_ORDER,
  clearedFilter,
  DisplayButton,
  FilterButton,
  FilterChips,
  type GroupBy,
  type GroupContext,
  groupTasks,
  hasTaskFilter,
  rememberTaskNavigation,
  showsProperty,
  type TaskProperty,
  useDisplayOptions,
  useProjectFilterFields,
  useTaskSelection,
  useUrlTaskFilter,
  useViewCommands,
  waitingLook,
  withoutHiddenWaiting,
} from '~/features/views';
import { ArchivedNote, TaskCheckAgainChip, TaskRequestMarker } from '~/features/views/markers';
import { useApi, useWorkspaceId, useWorkspaceSlug } from '~/lib/workspace';
import {
  Banner,
  BoardCardContent,
  BoardDragHint,
  BoardSubtaskToggle,
  Button,
  EmptyState,
  isEditableTarget,
  localToday,
  SearchField,
  STATUS_LABELS,
  useHotkeys,
} from '~/ui';
import {
  type BoardColumnModel,
  BoardColumns,
  BoardLanes,
  BoardSkeleton,
  type CellProps,
  cellId,
} from './BoardColumns';
import { type Placement, sortPlacement } from './board-cache';
import type { CardDrop } from './CardList';
import { useFoldedColumns } from './collapsed';
import { useBoardData, useGroupedBoardData } from './data';
import { buildLanes, groupKeysOf, groupPatch, inGroup, type Lane, patchField } from './lanes';
import {
  columnStep,
  type Direction,
  focusTarget,
  hasNeighbour,
  type NavColumn,
  reorderPlacement,
} from './layout';
import { type MovePatch, useBoardMoves } from './moves';
import { SubtaskRows } from './Subtasks';

// /p/$projectKey?view=board (frames 029–045): columns by status (or by the display options' field),
// boxless cards, collapsed columns, swimlanes, subtasks hidden under their parent or as their own cards.
//
// Keys (shortcuts.md "Lists and boards"): J / K or ↓ / ↑ move within a column, ← / → between columns,
// X selects, Shift+↓ / Shift+↑ extend the selection, ⌘A selects all, Space peeks, Enter opens the task
// view, Esc clears the selection, V switches to the list. Card moves: Shift+← / Shift+→ to the next
// column, Shift+J / Shift+K reorder (manual order only). The task keys (S, P, A, L, …) act on the
// selection or the focused card. Undo goes through the shared field toast: one Undo, one ⌘Z.
// Mirrored projects: a card whose status comes from Backlog.md can't change column; the board says so.
// M7 (frame 101): cards carry the check-again chip and, when switched on, the request marker; tasks
// waiting for their day are dimmed (the default) or left out with "2 waiting, hidden" at the column's
// end; Shift+E archives the selection or the focused card (views/archive.tsx, mounted by the shell).

export interface BoardScreenProps {
  projectKey: string;
  /** The route's search (`focus` puts the keyboard on a card, as Esc in the task view leaves it). */
  search: TaskListSearch;
}

/** Columns folded on a fresh status board. */
const FOLDED_BY_DEFAULT: readonly string[] = BOARD_FOLDED;
/** Cards a swimlane cell shows before "+ N more" (plan call 3). */
const LANE_CELL_CAP = 2;

type Locked = 'status' | 'priority' | 'assignee' | 'milestone';

/** Runs `run` after `count` animation frames. */
function afterFrames(count: number, run: () => void) {
  if (count <= 0) run();
  else requestAnimationFrame(() => afterFrames(count - 1, run));
}

/** A move the board can't make: the field toast says why. */
const refuse = (text: string) => showFieldToast({ text, tone: 'error' });

export function BoardScreen({ projectKey, search }: BoardScreenProps) {
  const workspace = useWorkspaceSlug();
  const workspaceId = useWorkspaceId();
  const api = useApi();
  const navigate = useNavigate();
  const router = useRouter();
  const quickCreate = useOptionalQuickCreate();
  const project = useProjectSummary(projectKey);
  const usesMilestones = project?.usesMilestones ?? false;
  const usesCycles = project?.usesCycles ?? false;
  const mirrored = isMirrored(project);
  const viewerId = useQuery(meQuery(api)).data?.user.id ?? null;
  const { apply } = useFieldChange();
  const queryClient = useQueryClient();
  const peek = usePeek();
  const peekOpen = peek !== null;

  // ---- View state: display options, filter, folded columns --------------------------------------
  const [options] = useDisplayOptions(projectKey, 'board');
  const [filter, setFilter] = useUrlTaskFilter();
  const filterRef = useRef(filter);
  filterRef.current = filter;
  const usable = useCallback(
    (field: GroupBy): boolean =>
      !(field === 'milestone' && !usesMilestones) && !(field === 'cycle' && !usesCycles),
    [usesMilestones, usesCycles],
  );
  const groupBy: GroupBy = usable(options.groupBy) ? options.groupBy : 'status';
  const lanesField: GroupBy | null =
    options.swimlanes !== 'none' && options.swimlanes !== groupBy && usable(options.swimlanes)
      ? options.swimlanes
      : null;
  const statusMode = groupBy === 'status';
  const manual = options.orderBy === 'manual';
  const subtaskCards = options.boardSubtasks === 'cards';
  const groupChoices = useMemo<GroupBy[]>(
    () => (['status', 'priority', 'assignee', 'milestone', 'cycle', 'label', 'none'] as const).filter(usable),
    [usable],
  );

  useEffect(() => rememberListSearch(workspaceId, projectKey, search), [workspaceId, projectKey, search]);

  const setView = useCallback(
    (view: TaskView) => {
      rememberProjectView(workspaceId, projectKey, view);
      void navigate({
        to: '/w/$workspace/p/$projectKey',
        params: { workspace, projectKey },
        search: ((previous: TaskListSearch) => ({
          ...previous,
          view: view === 'board' ? 'board' : undefined,
        })) as never,
      });
    },
    [navigate, projectKey, workspace, workspaceId],
  );

  const [query, setQuery, resetQuery] = useSearchText(filter.q, (q) =>
    setFilter({ ...filterRef.current, q }),
  );
  const searchRef = usePageSearchRef();
  const clearFilters = () => {
    resetQuery();
    setFilter({ ...clearedFilter(filter), q: undefined });
  };
  const fields = useProjectFilterFields(projectKey, {
    ...(project ? { projectName: project.name } : {}),
    usesMilestones,
    usesCycles,
  });
  useViewCommands({
    layout: 'board',
    onLayoutChange: setView,
    fields,
    filter,
    onFilterChange: setFilter,
    hotkeys: !peekOpen,
  });

  const [foldOverrides, setFolded] = useFoldedColumns(projectKey, groupBy);
  const statusFiltered = Boolean(filter.status?.length);
  const isFolded = useCallback(
    (column: string) =>
      foldOverrides[column] ?? (statusMode && !statusFiltered && FOLDED_BY_DEFAULT.includes(column)),
    [foldOverrides, statusMode, statusFiltered],
  );

  // ---- Data --------------------------------------------------------------------------------------
  const statuses = useMemo<TaskStatus[]>(
    () =>
      filter.status?.length ? TASK_STATUSES.filter((s) => filter.status?.includes(s)) : [...TASK_STATUSES],
    [filter.status],
  );
  const openKey = statuses.filter((status) => !isFolded(status)).join(',');
  // biome-ignore lint/correctness/useExhaustiveDependencies: openKey stands for the open statuses
  const openStatuses = useMemo(() => new Set(statuses.filter((status) => !isFolded(status))), [openKey]);
  const statusData = useBoardData(projectKey, filter, options, openStatuses, lanesField != null, statusMode);
  const groupedData = useGroupedBoardData(projectKey, filter, options, !statusMode);
  const moves = useBoardMoves(projectKey, { onUndone: (key) => focusCard(key) });

  const members = useQuery(membersQuery(api)).data?.items;
  const milestones = useQuery({
    ...api.orpc.milestones.list.queryOptions({ input: { project: projectKey } }),
    enabled: usesMilestones,
  }).data?.items;
  const cycles = useQuery({
    ...api.orpc.cycles.list.queryOptions({ input: { project: projectKey } }),
    enabled: usesCycles,
  }).data?.items;
  const labels = useQuery(labelsQuery(api, projectKey)).data?.items;
  const groupContext = useMemo<GroupContext>(
    () => ({
      statuses: BOARD_STATUS_ORDER,
      members: (members ?? []).map(
        (member): AssigneeRef => ({
          id: member.id,
          name: member.name,
          kind: member.kind,
          responsible: member.responsible ?? null,
        }),
      ),
      milestones: (milestones ?? []).map(toMilestoneRef),
      cycles: (cycles ?? []).map(toCycleRef),
      labels: labels ?? [],
      viewerId,
    }),
    [members, milestones, cycles, labels, viewerId],
  );

  const counts = statusMode ? statusData.counts : groupedData.counts;
  const allColumns = useMemo<BoardColumnModel[]>(() => {
    if (statusMode) {
      const known = statusData.counts;
      return statuses
        .map((status): BoardColumnModel => {
          const column = statusData.columns[status];
          // Done and Canceled cards past "Hide done tasks after" are left out of the count too.
          const hidden = column ? column.loaded - column.cards.length : 0;
          const count = Math.max((known?.[status] ?? 0) - hidden, column?.cards.length ?? 0);
          return {
            id: status,
            label: STATUS_LABELS[status],
            value: { field: 'status', status },
            count,
            cards: column?.cards ?? [],
            folded: isFolded(status),
            isLoading: column ? column.isLoading : false,
            hasMore: column?.hasMore ?? false,
            isFetchingMore: column?.isFetchingMore ?? false,
            ...(column ? { fetchMore: column.fetchMore, loaded: column.loaded } : {}),
          };
        })
        .filter(
          (column) =>
            options.showEmptyGroups ||
            !known ||
            (known[column.id as TaskStatus] ?? 0) > 0 ||
            column.cards.length > 0,
        );
    }
    return groupTasks(groupedData.tasks, groupBy, {
      ...groupContext,
      showEmptyGroups: options.showEmptyGroups,
    }).map((group) => ({
      id: group.key,
      label: group.label,
      value: group.value,
      count: group.tasks.length,
      cards: group.tasks,
      folded: isFolded(group.key),
      isLoading: false,
    }));
  }, [
    statusMode,
    statusData,
    statuses,
    isFolded,
    options.showEmptyGroups,
    groupedData.tasks,
    groupBy,
    groupContext,
  ]);
  // M7: "Waiting tasks: Hidden" leaves out tasks whose check-again day is ahead; a column's Show brings
  // them back for this visit. Nothing is hidden until the browser's day is known (useNow).
  const now = useNow();
  const checkToday = now == null ? null : localToday(new Date(now));
  const [shownWaiting, setShownWaiting] = useState<ReadonlySet<string>>(() => new Set());
  const columns = useMemo<BoardColumnModel[]>(
    () =>
      allColumns.map((column) => {
        if (shownWaiting.has(column.id)) return column;
        const { tasks, hidden } = withoutHiddenWaiting(column.cards, options, checkToday);
        return hidden ? { ...column, cards: [...tasks], hiddenWaiting: hidden } : column;
      }),
    [allColumns, options, checkToday, shownWaiting],
  );
  const columnsRef = useRef(columns);
  columnsRef.current = columns;
  const openColumns = useMemo(() => columns.filter((column) => !column.folded), [columns]);

  const cardsByKey = useMemo(() => {
    const map = new Map<string, TaskListItem>();
    for (const column of columns) for (const card of column.cards) map.set(card.key, card);
    return map;
  }, [columns]);
  const cardsRef = useRef(cardsByKey);
  cardsRef.current = cardsByKey;

  const lanes = useMemo<Lane[] | null>(
    () =>
      lanesField
        ? buildLanes(
            lanesField,
            openColumns.map((column) => ({ id: column.id, cards: column.cards })),
            groupContext,
          )
        : null,
    [lanesField, openColumns, groupContext],
  );
  const [collapsedLanes, setCollapsedLanes] = useState<ReadonlySet<string>>(() => new Set());
  const [expandedCells, setExpandedCells] = useState<ReadonlySet<string>>(() => new Set());

  /** The keyboard map of the board as drawn. */
  const nav = useMemo<NavColumn[]>(
    () =>
      openColumns.map((column) => ({
        id: column.id,
        cells: lanes
          ? lanes
              .filter((lane) => !collapsedLanes.has(lane.id))
              .map((lane) => {
                const cards = lane.cells[column.id] ?? [];
                const shown = expandedCells.has(cellId(lane.id, column.id))
                  ? cards
                  : cards.slice(0, LANE_CELL_CAP);
                return { lane: lane.id, keys: shown.map((card) => card.key) };
              })
          : [{ lane: null, keys: column.cards.map((card) => card.key) }],
      })),
    [openColumns, lanes, collapsedLanes, expandedCells],
  );
  const navRef = useRef(nav);
  navRef.current = nav;
  const orderedKeys = useMemo(() => {
    const seen = new Set<string>();
    const keys: string[] = [];
    for (const column of nav)
      for (const cell of column.cells)
        for (const key of cell.keys) {
          if (seen.has(key)) continue;
          seen.add(key);
          keys.push(key);
        }
    return keys;
  }, [nav]);
  const orderedRef = useRef(orderedKeys);
  orderedRef.current = orderedKeys;

  // ---- Focus and selection -----------------------------------------------------------------------
  const boardRef = useRef<HTMLDivElement>(null);
  const cardElement = useCallback(
    (key: string) => boardRef.current?.querySelector<HTMLElement>(`[data-card-key="${CSS.escape(key)}"]`),
    [],
  );
  const selection = useTaskSelection(orderedKeys, {
    hotkeys: false,
    view: 'Board',
    initialFocus: search.focus ?? null,
  });
  const selectionRef = useRef(selection);
  selectionRef.current = selection;
  const current = () => selectionRef.current.focusedKey;

  /**
   * Puts the keyboard on a card. After a move the card renders in another list first: wait two frames
   * (one for the cache update to render, one for React Aria to register the item). A card already on
   * screen (J/K) takes focus at once.
   */
  const focusCard = useCallback(
    (key: string, { afterRender = true }: { afterRender?: boolean } = {}) => {
      selectionRef.current.focus(key);
      const element = afterRender ? null : cardElement(key);
      if (element) {
        element.focus();
        return;
      }
      requestAnimationFrame(() => requestAnimationFrame(() => cardElement(key)?.focus()));
    },
    [cardElement],
  );

  // The keyboard cursor moved without a DOM focus change (Shift+↓ extends): follow it when the board
  // (or nothing) has focus.
  const cursorKey = selection.focusedKey;
  useEffect(() => {
    if (!cursorKey) return;
    const active = document.activeElement;
    if (active !== document.body && !boardRef.current?.contains(active)) return;
    const element = cardElement(cursorKey);
    if (element && element !== active) element.focus();
  }, [cursorKey, cardElement]);

  // Coming back from the task view (?focus=KEY): the keyboard starts on that card. The param is read once
  // and dropped, as the list does.
  const initialTask = useRef(search.focus ?? null);
  useEffect(() => {
    if (!search.focus) return;
    initialTask.current = search.focus;
    void navigate({
      to: '.',
      search: ((previous: TaskListSearch) => ({ ...previous, focus: undefined })) as never,
      replace: true,
    });
  }, [search.focus, navigate]);
  useEffect(() => {
    const key = initialTask.current;
    if (!key || !cardsByKey.has(key)) return;
    initialTask.current = null;
    focusCard(key);
  }, [cardsByKey, focusCard]);

  const pendingDown = useRef<string | null>(null);
  const moveFocus = (direction: Direction) => {
    const target = focusTarget(navRef.current, current(), direction);
    if (!target) return;
    if ('end' in target) {
      const column = columnsRef.current.find((candidate) => candidate.id === target.end);
      const from = current();
      if (column?.hasMore && from) {
        // J past the last loaded card: load the next page, then move (see the effect below).
        pendingDown.current = from;
        if (!column.isFetchingMore) void column.fetchMore?.();
      }
      return;
    }
    pendingDown.current = null;
    focusCard(target.key, { afterRender: false });
  };
  useEffect(() => {
    const from = pendingDown.current;
    if (!from) return;
    const next = focusTarget(nav, from, 'down');
    if (next && 'key' in next) {
      pendingDown.current = null;
      focusCard(next.key, { afterRender: false });
    }
  });

  // ---- Opening -----------------------------------------------------------------------------------
  const openTask = useCallback(
    (key: string) => {
      rememberTaskNavigation(
        workspaceId,
        { keys: orderedRef.current, from: 'Board', returnTo: router.state.location.href },
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
  const peekCard = (key: string) =>
    togglePeek({
      key,
      keys: orderedRef.current,
      from: 'Board',
      onMove: (next) => {
        if (cardsRef.current.has(next)) focusCard(next);
      },
    });

  // ---- Moves -------------------------------------------------------------------------------------
  /** The card's field comes from Backlog.md (its own lock list, or the project's while mirrored). */
  const isLocked = useCallback(
    (card: TaskListItem, field: Locked) => (card.locked ? card.locked.includes(field) : mirrored),
    [mirrored],
  );
  const fieldWord = (field: GroupBy) => (field === 'assignee' ? 'assignee' : field);

  /** What a move into a lane sets, or a refusal. */
  const lanePatchFor = (card: TaskListItem, laneId: string | null): MovePatch | 'refused' | undefined => {
    if (!lanesField || laneId === null || inGroup(lanesField, card, laneId)) return undefined;
    const lane = lanes?.find((candidate) => candidate.id === laneId);
    const patch = lane ? groupPatch(lane.value) : null;
    if (!patch) {
      refuse(`${card.key} stays in its lane: drop it in another column of the same lane.`);
      return 'refused';
    }
    const locked = patchField(lanesField);
    if (locked && isLocked(card, locked)) {
      refuse(`${card.key} keeps its ${fieldWord(lanesField)}: it comes from Backlog.md.`);
      return 'refused';
    }
    return patch;
  };

  /**
   * Moves a card into a column (and lane). `hint` is the manual-order position, when known. `onMoved`
   * runs when the card moved at once. A move that waits for the finishing warning focuses the card
   * itself once the person moves it anyway.
   */
  const dropTo = (
    key: string,
    columnId: string,
    laneId: string | null,
    hint: Placement | null,
    via: 'drag' | 'keyboard',
    onMoved: () => void,
  ): void => {
    const card = cardsRef.current.get(key);
    const column = columnsRef.current.find((candidate) => candidate.id === columnId);
    if (!card || !column) return;
    const lanePatch = lanePatchFor(card, laneId);
    if (lanePatch === 'refused') return;
    if (statusMode) {
      const to = columnId as TaskStatus;
      if (to !== card.status && isLocked(card, 'status')) {
        refuse(statusRefusalText(card.key, STATUS_LABELS[card.status]));
        return;
      }
      const target = column.cards.filter((other) => other.key !== card.key);
      const placement: Placement = manual
        ? (hint ?? 'top')
        : sortPlacement(
            target,
            { ...card, ...lanePatch, status: to, updatedAt: new Date().toISOString() },
            options.orderBy,
          );
      const move = () =>
        moves.move({
          key: card.key,
          to,
          placement,
          ...(lanePatch ? { patch: lanePatch } : {}),
          sendPosition: manual,
          via,
        });
      // Into In review or Done with open items: the card stays until the person answers the warning.
      if (finishingRequest(api, queryClient, [card], to)) {
        void confirmFinishing(api, queryClient, [card], to).then((ok) => {
          // The dialog hands focus back in a frame after it closes (to a card still in the old column,
          // as this one moved): the card takes the keyboard once that has happened.
          if (ok && move()) afterFrames(4, () => focusCard(card.key, { afterRender: false }));
        });
      } else if (move()) onMoved();
      return;
    }
    const sameColumn = inGroup(groupBy, card, columnId);
    if (sameColumn && !lanePatch) return;
    const columnPatch = sameColumn ? {} : groupPatch(column.value);
    if (columnPatch === null) {
      refuse(
        `Cards can't move between ${groupBy === 'label' ? 'label' : 'these'} columns. Change the field instead.`,
      );
      return;
    }
    const locked = sameColumn ? null : patchField(groupBy);
    if (locked && isLocked(card, locked)) {
      refuse(`${card.key} keeps its ${fieldWord(groupBy)}: it comes from Backlog.md.`);
      return;
    }
    // A status lane goes through the field change, and so through the finishing warning.
    void apply([card], { ...columnPatch, ...lanePatch });
    onMoved();
  };

  const onDrop = (drop: CardDrop, columnId: string, laneId: string | null) => {
    setDrag(null);
    if (drop.target?.key === drop.key) return;
    const hint: Placement | null = drop.target
      ? drop.target.position === 'before'
        ? { before: drop.target.key }
        : { after: drop.target.key }
      : null;
    dropTo(drop.key, columnId, laneId, hint, 'drag', () => selectionRef.current.focus(drop.key));
  };

  /** Shift+← / Shift+→: the card to the neighbouring column, folded or not. */
  const moveColumn = (direction: 'left' | 'right') => {
    const key = current();
    const card = key ? cardsByKey.get(key) : undefined;
    if (!card) return;
    const from = statusMode ? card.status : (groupKeysOf(groupBy, card)[0] ?? '');
    const to = columnStep(
      columnsRef.current.map((column) => column.id),
      from,
      direction,
    );
    if (!to) return;
    if (statusMode && to !== card.status && isLocked(card, 'status')) {
      refuse(statusRefusalText(card.key, STATUS_LABELS[card.status]));
      return;
    }
    if (isFolded(to)) setFolded(to, false);
    let hint: Placement | null = null;
    if (lanesField && lanes) {
      // Top of the same lane in the next column.
      const lane = lanes.find((candidate) => inGroup(lanesField, card, candidate.id));
      const first = lane?.cells[to]?.[0];
      if (first) hint = { before: first.key };
    }
    dropTo(card.key, to, null, hint, 'keyboard', () => focusCard(card.key));
  };

  /** Shift+J / Shift+K: up or down within the cell (manual order, status columns). */
  const reorder = (direction: 'up' | 'down') => {
    const key = current();
    const card = key ? cardsByKey.get(key) : undefined;
    if (!card || !statusMode) return;
    if (!manual) {
      refuse('Cards keep the board’s order. Choose Manual in Display to move them by hand.');
      return;
    }
    const placement = reorderPlacement(navRef.current, card.key, direction);
    if (!placement) return;
    if (moves.move({ key: card.key, to: card.status, placement, via: 'keyboard' })) focusCard(card.key);
  };

  // A move that failed put the card back: keep the keyboard on it.
  const problemKey = moves.problem?.key;
  useEffect(() => {
    if (problemKey && selectionRef.current.focusedKey === problemKey) focusCard(problemKey);
  }, [problemKey, focusCard]);

  // ---- Drag --------------------------------------------------------------------------------------
  const [drag, setDrag] = useState<{
    key: string;
    home: string;
    over: string;
    refused: ReadonlySet<string>;
  } | null>(null);
  const onCardDragStart = useCallback(
    (key: string) => {
      const card = cardsRef.current.get(key);
      if (!card) return;
      const home = statusMode ? card.status : (groupKeysOf(groupBy, card)[0] ?? '');
      const others = columnsRef.current.map((column) => column.id).filter((id) => id !== home);
      let refused: string[] = [];
      if (statusMode && isLocked(card, 'status')) {
        refused = others;
        refuse(DRAG_REFUSAL_TEXT);
      } else if (!statusMode) {
        const field = patchField(groupBy);
        const fixed = groupBy === 'label' || groupBy === 'none' || (field !== null && isLocked(card, field));
        if (fixed) refused = others;
      }
      setDrag({ key, home, over: home, refused: new Set(refused) });
    },
    [statusMode, groupBy, isLocked],
  );
  const onCardDragEnd = useCallback(() => setDrag(null), []);
  const onDragOver = useCallback(
    (column: string) => setDrag((previous) => (previous ? { ...previous, over: column } : previous)),
    [],
  );

  // ---- Task keys and palette ---------------------------------------------------------------------
  const targets = useMemo(
    () =>
      selection.targetKeys
        .map((key) => cardsByKey.get(key))
        .filter((card): card is TaskListItem => card !== undefined),
    [selection.targetKeys, cardsByKey],
  );
  const anchorRef = useRef<Element | null>(null);
  const focusedKey = selection.focusedKey;
  useEffect(() => {
    anchorRef.current = (focusedKey ? cardElement(focusedKey) : null) ?? null;
  });
  const fieldKeys = useTaskFieldKeys({ targets, enabled: !peekOpen, anchors: anchorRef });

  // ---- Keyboard ----------------------------------------------------------------------------------
  /** Board keys. True when the key was handled. */
  const handleKey = (key: string, shift: boolean): boolean => {
    const sel = selectionRef.current;
    switch (key) {
      case 'j':
        if (shift) reorder('down');
        else moveFocus('down');
        return true;
      case 'k':
        if (shift) reorder('up');
        else moveFocus('up');
        return true;
      case 'arrowdown':
      case 'arrowup': {
        const direction = key === 'arrowdown' ? 'down' : 'up';
        if (!shift) moveFocus(direction);
        else {
          const from = sel.focusedKey;
          if (!from) moveFocus(direction);
          // Extend within the column only.
          else if (hasNeighbour(navRef.current, from, direction)) sel.extend(direction === 'down' ? 1 : -1);
          else if (!sel.isSelected(from)) sel.toggle(from);
        }
        return true;
      }
      case 'arrowleft':
      case 'arrowright':
        if (shift) moveColumn(key === 'arrowleft' ? 'left' : 'right');
        else moveFocus(key === 'arrowleft' ? 'left' : 'right');
        return true;
      case 'x':
        if (shift || !sel.focusedKey) return false;
        sel.toggle(sel.focusedKey);
        return true;
      case ' ':
        if (shift || !sel.focusedKey) return false;
        peekCard(sel.focusedKey);
        return true;
      case 'enter':
        if (shift || !sel.focusedKey) return false;
        openTask(sel.focusedKey);
        return true;
      case 'escape': {
        if (shift || (!sel.selectedKeys.length && !sel.focusedKey)) return false;
        const had = sel.selectedKeys.length > 0;
        sel.escape();
        if (!had) (document.activeElement as HTMLElement | null)?.blur?.();
        return true;
      }
      default:
        return false;
    }
  };
  const handleKeyRef = useRef(handleKey);
  handleKeyRef.current = handleKey;

  // Keys pressed on a card: handled here before the GridList sees them.
  const onBoardKeyDownCapture = (event: KeyboardEvent<HTMLDivElement>) => {
    if (peekOpen || event.ctrlKey || event.metaKey || event.altKey) return;
    if (isEditableTarget(event.target)) return;
    const onCard = (event.target as HTMLElement).closest('[data-card-key]') != null;
    const onButton = (event.target as HTMLElement).closest('button') != null;
    if (!onCard || onButton) return;
    if (handleKeyRef.current(event.key.toLowerCase(), event.shiftKey)) {
      event.preventDefault();
      event.stopPropagation();
    }
  };
  const onBoardFocus = (event: FocusEvent<HTMLDivElement>) => {
    const key = (event.target as HTMLElement).closest<HTMLElement>('[data-card-key]')?.dataset.cardKey;
    if (key && key !== selectionRef.current.focusedKey) selectionRef.current.focus(key);
  };
  /** Shift and ⌘/Ctrl on the press that opens a card: select instead. */
  const pressModifiers = useRef({ shiftKey: false, metaKey: false, ctrlKey: false });
  const onBoardPointerDown = (event: PointerEvent<HTMLDivElement>) => {
    pressModifiers.current = { shiftKey: event.shiftKey, metaKey: event.metaKey, ctrlKey: event.ctrlKey };
  };
  const onCardAction = useCallback(
    (key: string) => {
      const modifiers = pressModifiers.current;
      pressModifiers.current = { shiftKey: false, metaKey: false, ctrlKey: false };
      if (selectionRef.current.handleClick(key, modifiers)) return;
      openTask(key);
    },
    [openTask],
  );

  /** Keys from the page (focus not on a card): only when nothing else has focus. */
  const fromPage =
    (key: string, shift = false, needsBody = false) =>
    (event: globalThis.KeyboardEvent) => {
      const target = event.target as HTMLElement | null;
      const onBody = target === document.body || target === document.documentElement;
      if (needsBody && !onBody && !target?.closest('[data-card-key]')) return;
      handleKeyRef.current(key, shift);
    };
  useHotkeys(
    {
      j: fromPage('j'),
      k: fromPage('k'),
      'Shift+j': fromPage('j', true),
      'Shift+k': fromPage('k', true),
      ArrowDown: fromPage('arrowdown', false, true),
      ArrowUp: fromPage('arrowup', false, true),
      ArrowLeft: fromPage('arrowleft', false, true),
      ArrowRight: fromPage('arrowright', false, true),
      'Shift+ArrowDown': fromPage('arrowdown', true, true),
      'Shift+ArrowUp': fromPage('arrowup', true, true),
      'Shift+ArrowLeft': fromPage('arrowleft', true, true),
      'Shift+ArrowRight': fromPage('arrowright', true, true),
      x: fromPage('x'),
      Space: { handler: fromPage(' ', false, true), enabled: selection.focusedKey != null },
      Enter: { handler: fromPage('enter', false, true), enabled: selection.focusedKey != null },
      'Mod+a': { handler: () => selectionRef.current.selectAll(), allowInInputs: false },
      Escape: {
        preventDefault: false,
        enabled: selection.focusedKey != null || selection.selectedKeys.length > 0,
        handler: (event) => {
          if (handleKeyRef.current('escape', false)) event.preventDefault();
        },
      },
    },
    { enabled: !peekOpen },
  );

  // ---- Cards -------------------------------------------------------------------------------------
  const today = localToday();
  const [expanded, setExpanded] = useState<ReadonlySet<string>>(() => new Set());
  const toggleExpanded = useCallback(
    (key: string, open: boolean) =>
      setExpanded((previous) => {
        const next = new Set(previous);
        if (open) next.add(key);
        else next.delete(key);
        return next;
      }),
    [],
  );
  const parentTitle = useCallback((key: string) => cardsRef.current.get(key)?.title ?? null, []);
  const renderCard = useCallback(
    (card: TaskListItem): ReactNode => {
      const shows = (property: TaskProperty) => showsProperty(options, property, card, viewerId);
      const progress = card.subtaskProgress;
      const hasSubtasks = shows('subtasks') && progress != null && progress.total > 0;
      const parentRef = subtaskCards && card.parentKey ? [card.parentKey, parentTitle(card.parentKey)] : null;
      const isOpen = expanded.has(card.key);
      const times: string[] = [];
      if (shows('created')) times.push(`Created ${formatAge(card.createdAt)}`);
      if (shows('updated')) times.push(`Updated ${formatAge(card.updatedAt)}`);
      const due = shows('due') && card.dueDate ? { dueDate: card.dueDate, status: card.status, today } : null;
      // The criteria marker (off by default): the kit draws it after subtasks, before the due date.
      const criteria = shows('criteria') ? (card.criteriaProgress ?? null) : null;
      // M7: the request marker (off by default), the check-again chip, and the day an archived card left.
      const request = <TaskRequestMarker task={card} display={options} />;
      const checkAgain = <TaskCheckAgainChip task={card} display={options} today={checkToday} compact />;
      const archived = card.archivedAt ? <ArchivedNote archivedAt={card.archivedAt} now={now} /> : null;
      const hasM7 =
        archived != null ||
        (options.properties.pullRequest && card.pullRequest != null) ||
        (options.properties.checkAgain && card.checkAgain != null);
      return (
        <>
          <BoardCardContent
            taskKey={card.key}
            title={card.title}
            showKey={options.properties.key}
            priority={
              shows('priority') && groupBy !== 'priority' && lanesField !== 'priority' ? card.priority : null
            }
            labels={shows('labels') ? (card.labels ?? []) : null}
            subtasks={hasSubtasks && subtaskCards ? progress : null}
            criteria={criteria}
            due={due}
            blocked={shows('blocked') && card.blocked === true}
            milestone={
              shows('milestone') && usesMilestones && card.milestone && groupBy !== 'milestone'
                ? { name: card.milestone.name, filled: card.milestone.status !== 'planned' }
                : null
            }
            cycle={
              shows('cycle') && usesCycles && card.cycle && groupBy !== 'cycle'
                ? { label: `C${card.cycle.number}` }
                : null
            }
            assignee={
              shows('assignee') && card.assignee && groupBy !== 'assignee' && lanesField !== 'assignee'
                ? { name: card.assignee.name, kind: card.assignee.kind }
                : null
            }
            parentRef={parentRef ? parentRef.filter(Boolean).join(' ') : null}
            extra={
              times.length || hasM7 ? (
                <>
                  {request}
                  {checkAgain}
                  {archived}
                  {times.length ? (
                    <span className="text-xs whitespace-nowrap text-fg-3">{times.join(' · ')}</span>
                  ) : null}
                </>
              ) : null
            }
          />
          {selectionRef.current.isSelected(card.key) ? <span className="sr-only">Selected</span> : null}
          {hasSubtasks && !subtaskCards ? (
            <>
              <BoardSubtaskToggle
                taskKey={card.key}
                done={progress.done}
                total={progress.total}
                isExpanded={isOpen}
                onExpandedChange={(open) => toggleExpanded(card.key, open)}
              />
              {isOpen ? (
                <SubtaskRows
                  projectKey={projectKey}
                  parentKey={card.key}
                  viewerId={viewerId}
                  onOpen={openTask}
                />
              ) : null}
            </>
          ) : null}
        </>
      );
    },
    [
      options,
      viewerId,
      subtaskCards,
      parentTitle,
      expanded,
      today,
      checkToday,
      now,
      usesMilestones,
      usesCycles,
      groupBy,
      lanesField,
      toggleExpanded,
      projectKey,
      openTask,
    ],
  );
  const isChild = useCallback(
    (card: TaskListItem) => subtaskCards && Boolean(card.parentKey),
    [subtaskCards],
  );
  const isSelected = selection.isSelected;
  const isDimmed = useCallback(
    (card: TaskListItem) => waitingLook(options, card, checkToday) === 'dimmed',
    [options, checkToday],
  );

  const cell: CellProps = {
    cursor: selection.focusedKey,
    isSelected,
    onAction: onCardAction,
    renderCard,
    isChild,
    isDimmed,
    reorderable: manual && statusMode,
    onDragStart: onCardDragStart,
    onDragEnd: onCardDragEnd,
    dependencies: [selection.selectedKeys],
  };

  // ---- Rendering ---------------------------------------------------------------------------------
  const filtered = hasTaskFilter(filter);
  const total = statusMode
    ? counts
      ? statuses.reduce((sum, status) => sum + (counts[status] ?? 0), 0)
      : undefined
    : groupedData.isLoading
      ? undefined
      : groupedData.tasks.length;
  const isLoading = statusMode ? statusData.isLoading : groupedData.isLoading;
  const loadError = statusMode ? statusData.error : groupedData.error;
  const error = loadError ? describeError(loadError) : null;
  const subtitle = filtered
    ? `${total ?? 0} matching tasks`
    : project
      ? `${project.openCount} open · board`
      : 'board';
  const newTask = () => quickCreate?.open(projectKey);

  const emptyText = (column: BoardColumnModel): ReactNode => {
    const closed = column.id === 'done' || column.id === 'canceled';
    if (statusMode && closed && options.hideDoneAfterDays > 0 && (column.loaded ?? 0) > 0) {
      return `Nothing ${column.id === 'done' ? 'done' : 'canceled'} in the last ${options.hideDoneAfterDays} days.`;
    }
    if (column.value.field !== 'status' || mirrored) return `No tasks in ${column.label}.`;
    return (
      <>
        No tasks in {column.label}.
        <br />
        Drag a card here, or press C.
      </>
    );
  };

  const renderBody = () => {
    if (error) {
      return (
        <div className="px-4.5 py-4">
          <Banner
            action={
              <Button
                variant="secondary"
                size="sm"
                onPress={() => (statusMode ? statusData : groupedData).refetch()}
              >
                Retry
              </Button>
            }
          >
            Couldn't load tasks. {error.message}
          </Banner>
          <p className="m-0 mt-2.5 text-xs text-fg-3">
            Your filters are kept.{error.requestId ? ` Request ${error.requestId}.` : ''}
          </p>
        </div>
      );
    }
    if (isLoading) return <BoardSkeleton columns={Math.max(openColumns.length, 3)} />;
    if (total === 0 && !filtered && mirrored && project) return <MirrorEmptyState project={project} />;
    if (total === 0) {
      return (
        <div className="flex px-6 py-12">
          {filtered ? (
            <EmptyState
              title="No tasks match these filters"
              text="Nothing on the board matches. Clear the filters, or create a task."
              action={
                <div className="flex gap-2">
                  <Button variant="secondary" onPress={clearFilters}>
                    Clear filters
                  </Button>
                  {mirrored ? null : (
                    <Button kbd="C" onPress={newTask}>
                      New task
                    </Button>
                  )}
                </div>
              }
            />
          ) : (
            <EmptyState
              title="No tasks yet"
              text="Create the first one here, or have an agent create it from the CLI."
              action={
                <Button kbd="C" onPress={newTask}>
                  New task
                </Button>
              }
              cli={{
                command: `zamu tasks create --project ${projectKey} "Match Stripe payouts to invoices"`,
              }}
            />
          )}
        </div>
      );
    }
    const body = {
      columns,
      onFoldChange: setFolded,
      onDrop,
      // The column's "+" preselects that column's status. Mirrored projects take no new tasks.
      onAdd:
        quickCreate && !mirrored && statusMode
          ? (column: BoardColumnModel) =>
              column.value.field === 'status'
                ? quickCreate.open(projectKey, { status: column.value.status })
                : undefined
          : undefined,
      cell,
      refused: drag?.refused ?? null,
      onDragOver,
      dropTarget: drag && drag.over !== drag.home ? drag.over : null,
      emptyText,
      onShowWaiting: (column: BoardColumnModel) =>
        setShownWaiting((previous) => new Set(previous).add(column.id)),
    };
    return lanes ? (
      <BoardLanes
        {...body}
        lanes={lanes}
        collapsed={collapsedLanes}
        onCollapsedChange={(laneId, collapsed) =>
          setCollapsedLanes((previous) => {
            const next = new Set(previous);
            if (collapsed) next.add(laneId);
            else next.delete(laneId);
            return next;
          })
        }
        expandedCells={expandedCells}
        onExpandCell={(laneId, columnId) =>
          setExpandedCells((previous) => new Set(previous).add(cellId(laneId, columnId)))
        }
        cap={LANE_CELL_CAP}
      />
    ) : (
      <BoardColumns {...body} />
    );
  };

  const problem = moves.problem;
  const dragTarget = drag ? columns.find((column) => column.id === drag.over) : undefined;

  return (
    <section aria-label="Board" className="relative flex h-dvh min-h-0 min-w-0 flex-1 flex-col bg-bg text-fg">
      <ProjectHeader
        projectKey={projectKey}
        current="tasks"
        subtitle={subtitle}
        viewSwitch={<ViewSwitch view="board" onChange={setView} />}
        filter={<FilterButton fields={fields} filter={filter} onChange={setFilter} />}
        display={
          <DisplayButton
            projectKey={projectKey}
            view="board"
            onLayoutChange={setView}
            groupChoices={groupChoices}
          />
        }
        search={
          <SearchField
            width={200}
            value={query}
            onChange={setQuery}
            inputRef={searchRef}
            aria-label="Search tasks"
            onKeyDown={(event) => {
              if (event.key === 'Enter' || event.key === 'ArrowDown') {
                event.preventDefault();
                const first = focusTarget(navRef.current, null, 'down');
                if (first && 'key' in first) focusCard(first.key, { afterRender: false });
              } else {
                event.continuePropagation();
              }
            }}
          />
        }
        actions={
          mirrored ? (
            <MirrorCreateButton
              projectName={project?.name ?? projectKey}
              onPress={newTask}
              aria-keyshortcuts="c"
            />
          ) : (
            <Button kbd="C" onPress={newTask} aria-keyshortcuts="c">
              New task
            </Button>
          )
        }
      />
      <FilterChips
        fields={fields}
        filter={filter}
        onChange={setFilter}
        {...(total !== undefined ? { matchCount: total } : {})}
      />
      <MirrorFailedBanner project={project} />
      {problem ? (
        <div className="border-b border-line-soft px-4.5 py-3">
          <Banner
            action={
              <Button variant="secondary" size="sm" onPress={problem.retry}>
                Try again
              </Button>
            }
          >
            {problem.text}
          </Banner>
          {problem.hint ? <p className="m-0 mt-2 text-xs text-fg-3">{problem.hint}</p> : null}
        </div>
      ) : null}
      <div
        ref={boardRef}
        onKeyDownCapture={onBoardKeyDownCapture}
        onFocusCapture={onBoardFocus}
        onPointerDownCapture={onBoardPointerDown}
        className="flex min-h-0 flex-1 flex-col"
      >
        {renderBody()}
      </div>
      {drag && dragTarget ? <BoardDragHint target={dragTarget.label} /> : null}
      <div aria-live="polite" className="sr-only">
        {moves.announcement?.text}
      </div>
      {fieldKeys.pickers}
      <DetachedToast project={project} />
    </section>
  );
}
