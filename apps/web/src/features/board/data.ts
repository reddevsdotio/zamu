import { useInfiniteQuery, useQuery } from '@tanstack/react-query';
import type { StatusCounts, TaskListItem, TaskStatus } from '@zamu/contracts';
import { useEffect, useMemo } from 'react';
import { taskListQuery } from '~/features/tasks/queries';
import { type DisplayOptions, hideOldDone, type TaskFilter } from '~/features/views';
import { useApi } from '~/lib/workspace';
import { cardsOf } from './board-cache';
import { boardColumnInput, boardColumnQuery, boardListInput } from './queries';

// Data of the board. Status columns: one infinite query per open column; folded columns do not load,
// their count comes from the counts every page carries (they cover all statuses under the filters).
// Other groupings (priority, assignee, …): every task under the filter in one list, grouped on the client.

export interface ColumnState {
  status: TaskStatus;
  /** Loaded cards, Done and Canceled ones past "Hide done tasks after" left out. */
  cards: TaskListItem[];
  /** Loaded cards before that, for the "N more" count. */
  loaded: number;
  /** Loaded and counted: the column has more pages. */
  hasMore: boolean;
  isLoading: boolean;
  isFetchingMore: boolean;
  error: unknown;
  fetchMore: () => Promise<unknown>;
  refetch: () => Promise<unknown>;
}

export interface BoardData {
  columns: Partial<Record<TaskStatus, ColumnState>>;
  /** Counts under the current filters, once any column answered. */
  counts: StatusCounts | undefined;
  /** True while no open column has data yet. */
  isLoading: boolean;
  /** The first column error without data. */
  error: unknown;
  refetch: () => void;
}

type ColumnQuery = ReturnType<typeof useColumn>;

interface ColumnArgs {
  projectKey: string;
  filter: TaskFilter;
  options: DisplayOptions;
}

function useColumn({ projectKey, filter, options }: ColumnArgs, status: TaskStatus, enabled: boolean) {
  const api = useApi();
  return useInfiniteQuery({
    ...boardColumnQuery(api, boardColumnInput(projectKey, filter, options, status)),
    enabled,
  });
}

/**
 * Loads the open status columns. `loadAll` keeps fetching pages until every card is loaded (swimlanes
 * need every card to group them). `enabled` false loads nothing (the board groups by another field).
 */
export function useBoardData(
  projectKey: string,
  filter: TaskFilter,
  options: DisplayOptions,
  openStatuses: ReadonlySet<TaskStatus>,
  loadAll: boolean,
  enabled = true,
): BoardData {
  const args = { projectKey, filter, options };
  const open = enabled ? openStatuses : NONE;
  // A fixed number of hooks, one per status, so the hook order never changes.
  const backlog = useColumn(args, 'backlog', open.has('backlog'));
  // With every column folded, todo still loads: its pages carry the counts of all columns.
  const todo = useColumn(args, 'todo', enabled && (open.has('todo') || open.size === 0));
  const inProgress = useColumn(args, 'in_progress', open.has('in_progress'));
  const inReview = useColumn(args, 'in_review', open.has('in_review'));
  const done = useColumn(args, 'done', open.has('done'));
  const canceled = useColumn(args, 'canceled', open.has('canceled'));
  const hideAfter = options.hideDoneAfterDays;

  const queries: [TaskStatus, ColumnQuery][] = [
    ['backlog', backlog],
    ['todo', todo],
    ['in_progress', inProgress],
    ['in_review', inReview],
    ['done', done],
    ['canceled', canceled],
  ];

  useEffect(() => {
    if (!loadAll) return;
    for (const [status, query] of queries) {
      if (open.has(status) && query.hasNextPage && !query.isFetchingNextPage && !query.isError) {
        void query.fetchNextPage();
      }
    }
  });

  const dataKey = queries.map(([, query]) => query.dataUpdatedAt).join(',');
  const stateKey = queries
    .map(([, query]) => `${query.isPending}${query.isFetchingNextPage}${query.hasNextPage}${query.isError}`)
    .join(',');
  // biome-ignore lint/correctness/useExhaustiveDependencies: dataKey and stateKey stand for the queries
  return useMemo(() => {
    const columns: Partial<Record<TaskStatus, ColumnState>> = {};
    let counts: StatusCounts | undefined;
    let error: unknown = null;
    let anyData = false;
    for (const [status, query] of queries) {
      counts ??= query.data?.pages[0]?.counts;
      if (!open.has(status)) continue;
      if (query.data) anyData = true;
      if (query.isError && !query.data) error ??= query.error;
      const loaded = cardsOf(query.data);
      columns[status] = {
        status,
        cards: status === 'done' || status === 'canceled' ? hideOldDone(loaded, hideAfter) : loaded,
        loaded: loaded.length,
        hasMore: Boolean(query.hasNextPage),
        isLoading: query.isPending && query.fetchStatus !== 'idle',
        isFetchingMore: query.isFetchingNextPage,
        error: query.isError ? query.error : null,
        fetchMore: () => query.fetchNextPage(),
        refetch: () => query.refetch(),
      };
    }
    const isLoading = open.size > 0 ? !anyData && !error : todo.isPending;
    return {
      columns,
      counts,
      isLoading,
      error,
      refetch: () => {
        for (const [status, query] of queries) if (open.has(status)) void query.refetch();
      },
    };
  }, [dataKey, stateKey, open, hideAfter]);
}

const NONE: ReadonlySet<TaskStatus> = new Set();

export interface GroupedBoardData {
  /** Every task under the filter, in the display options' order. */
  tasks: TaskListItem[];
  /** Tasks under the filter, per status (for the header's count). */
  counts: StatusCounts | undefined;
  isLoading: boolean;
  error: unknown;
  refetch: () => void;
}

/** Every task of the board in one list, for columns by priority, assignee, milestone, cycle or label. */
export function useGroupedBoardData(
  projectKey: string,
  filter: TaskFilter,
  options: DisplayOptions,
  enabled: boolean,
): GroupedBoardData {
  const api = useApi();
  const query = useQuery({ ...taskListQuery(api, boardListInput(projectKey, filter, options)), enabled });
  const hideAfter = options.hideDoneAfterDays;
  const items = query.data?.items;
  const tasks = useMemo(() => hideOldDone(items ?? [], hideAfter), [items, hideAfter]);
  return {
    tasks,
    counts: query.data?.counts,
    isLoading: enabled && query.isPending,
    error: query.isError && !query.data ? query.error : null,
    refetch: () => void query.refetch(),
  };
}
