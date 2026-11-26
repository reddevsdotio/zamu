import {
  type InfiniteData,
  infiniteQueryOptions,
  type QueryClient,
  type QueryKey,
} from '@tanstack/react-query';
import type { ListTasksInput, TaskListPage, TaskStatus } from '@zamu/contracts';
import type { z } from 'zod';
import { retryOnce, withTimeout } from '~/features/tasks/errors';
import { REQUEST_TIMEOUT_MS } from '~/features/tasks/queries';
import { type DisplayOptions, displayListInput, type TaskFilter, toListTasksInput } from '~/features/views';
import type { WorkspaceApi } from '~/lib/orpc';

// One query per status column: tasks.list with one status and the display options' sort (and topLevel
// while subtasks are hidden), 50 cards per page, more on scroll. The keys sit under orpc.tasks.list.key(), so every task change that invalidates lists (the
// panel, quick create) refreshes the board too. They end with BOARD_TAG so board code can find them.

export const BOARD_PAGE_SIZE = 50;
export const BOARD_TAG = 'board';

export type BoardInput = Omit<z.input<typeof ListTasksInput>, 'limit' | 'cursor'> & {
  project: string[];
  status: TaskStatus[];
};

export type BoardColumnData = InfiniteData<TaskListPage, unknown>;

/**
 * The tasks.list input of one status column: the filter (its status part is the column), the display
 * options' order and subtask choice. Route loaders can prefetch with the default display options.
 */
export function boardColumnInput(
  projectKey: string,
  filter: TaskFilter,
  options: DisplayOptions,
  status: TaskStatus,
): BoardInput {
  const { status: _status, ...rest } = toListTasksInput(filter);
  return { project: [projectKey], order: 'board', ...rest, ...displayListInput(options), status: [status] };
}

/** The tasks.list input of a board grouped by another field: every task under the filter, loaded at once. */
export function boardListInput(projectKey: string, filter: TaskFilter, options: DisplayOptions) {
  return { project: projectKey, ...toListTasksInput(filter), ...displayListInput(options) };
}

export function boardColumnKey(api: WorkspaceApi, input: BoardInput): QueryKey {
  return [...api.orpc.tasks.list.key({ type: 'infinite', input }), BOARD_TAG];
}

export function boardColumnQuery(api: WorkspaceApi, input: BoardInput) {
  return infiniteQueryOptions({
    queryKey: boardColumnKey(api, input),
    queryFn: ({ pageParam, signal }): Promise<TaskListPage> =>
      api.client.tasks.list(
        { ...input, limit: BOARD_PAGE_SIZE, ...(typeof pageParam === 'string' ? { cursor: pageParam } : {}) },
        { signal: withTimeout(signal, REQUEST_TIMEOUT_MS) },
      ),
    initialPageParam: undefined as string | undefined,
    getNextPageParam: (last: TaskListPage) => last.nextCursor ?? undefined,
    retry: retryOnce,
    // Keep the cards on screen while new filters load, within the same project and column.
    placeholderData: (previous, previousQuery) => {
      const before = inputOf(previousQuery?.queryKey);
      return before && sameColumn(before, input) ? previous : undefined;
    },
  });
}

/** The tasks.list input stored in a board query key. */
export function inputOf(queryKey: QueryKey | undefined): BoardInput | undefined {
  const meta = queryKey?.[1] as { input?: BoardInput } | undefined;
  return meta?.input;
}

function sameColumn(a: BoardInput, b: BoardInput): boolean {
  return a.project.join(',') === b.project.join(',') && a.status.join(',') === b.status.join(',');
}

/**
 * Every cached board column of a project, with its status. Columns on screen come first: columns of
 * other display options (another order, subtasks shown) stay cached and are kept in step, but the
 * board's own order decides where a card is.
 */
export function boardQueries(
  api: WorkspaceApi,
  queryClient: QueryClient,
  projectKey: string,
): { queryKey: QueryKey; status: TaskStatus; data: BoardColumnData; active: boolean }[] {
  const found = queryClient.getQueryCache().findAll({
    queryKey: api.orpc.tasks.list.key(),
    predicate: (query) => query.queryKey.at(-1) === BOARD_TAG,
  });
  const result: { queryKey: QueryKey; status: TaskStatus; data: BoardColumnData; active: boolean }[] = [];
  for (const query of found) {
    const data = query.state.data as BoardColumnData | undefined;
    const input = inputOf(query.queryKey);
    const status = input?.status[0];
    if (!data || !status || !input?.project.includes(projectKey)) continue;
    result.push({ queryKey: query.queryKey, status, data, active: query.getObserversCount() > 0 });
  }
  return result.sort((a, b) => Number(b.active) - Number(a.active));
}

/** Refetches the project's board columns (after moves settle). */
export async function invalidateBoard(api: WorkspaceApi, queryClient: QueryClient, projectKey: string) {
  const isBoard = (queryKey: QueryKey) =>
    queryKey.at(-1) === BOARD_TAG && (inputOf(queryKey)?.project.includes(projectKey) ?? false);
  // A first load still running (a column unfolded by the move) started before the move was saved:
  // drop it, or the refetch below would reuse its answer.
  await queryClient.cancelQueries({
    queryKey: api.orpc.tasks.list.key(),
    predicate: (query) => isBoard(query.queryKey) && query.state.data === undefined,
  });
  await queryClient.invalidateQueries({
    queryKey: api.orpc.tasks.list.key(),
    predicate: (query) => isBoard(query.queryKey),
  });
}
