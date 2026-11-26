import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { act, renderHook, waitFor } from '@testing-library/react';
import type { Home, TaskListItem, TaskListPage, TaskStatus } from '@zamu/contracts';
import type { ReactNode } from 'react';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { testWorkspace } from '~/lib/testing';
import { WorkspaceProvider } from '~/lib/workspace';
import { createFakeApi, type FakeApi } from './fake-api';
import {
  applyTaskPatch,
  BulkRefusedError,
  bulkRefusal,
  inversePatch,
  isNoopPatch,
  taskListQuery,
  taskQuery,
  useBulkUpdateTasks,
  useCreateTask,
  useUpdateTask,
} from './queries';

// Optimistic task edits: every cached copy changes at once (detail, all-pages lists, board columns,
// Home) and goes back when the server refuses; bulk changes refuse mirrored selections up front.

const api = vi.hoisted(() => ({ current: null as FakeApi | null }));

/** The test workspace (/w/acme) around the fake client. */
const workspace = (() => {
  const forward = (path: string[]): unknown =>
    new Proxy(() => {}, {
      get: (_target, key) => (typeof key === 'string' ? forward([...path, key]) : undefined),
      apply: (_target, _this, args) => {
        // biome-ignore lint/suspicious/noExplicitAny: walking the fake client by path
        const fn = path.reduce<any>((node, key) => node[key], api.current?.client);
        return fn(...args);
      },
    });
  const client = forward([]);
  return testWorkspace(client);
})();

const fake = () => api.current as FakeApi;

/** A board column cache, keyed as features/board/queries.ts keys it. */
function boardKey(status: TaskStatus) {
  const input = { project: ['PAY'], status: [status], order: 'board' as const };
  return [...workspace.api.orpc.tasks.list.key({ type: 'infinite', input }), 'board'];
}

async function seed() {
  const queryClient = new QueryClient({ defaultOptions: { queries: { retry: false, staleTime: Infinity } } });
  const client = fake().client;
  queryClient.setQueryData(
    taskQuery(workspace.api, 'PAY-1').queryKey,
    await client.tasks.get({ key: 'PAY-1' }),
  );
  const list = await client.tasks.list({ project: ['PAY'], limit: 100 });
  queryClient.setQueryData(taskListQuery(workspace.api, { project: ['PAY'] }).queryKey, {
    items: list.items,
    counts: list.counts,
  });
  for (const status of ['in_progress', 'done'] as const) {
    const page = await client.tasks.list({ project: ['PAY'], status: [status], order: 'board', limit: 50 });
    queryClient.setQueryData(boardKey(status), { pages: [page], pageParams: [undefined] });
  }
  const pay1 = list.items.find((item) => item.key === 'PAY-1') as TaskListItem;
  const home: Home = {
    tab: 'mine',
    generatedAt: new Date().toISOString(),
    counts: {
      review: 0,
      mentions: 0,
      blocked: 0,
      overdue: 0,
      assigned: 1,
      dueThisWeek: 0,
      waiting: 0,
    } as never,
    deadlines: [],
    groups: [
      {
        key: 'assigned',
        total: 1,
        items: [{ task: pay1, reason: { kind: 'assigned' } as never, relation: 'agent', pills: [] }],
      },
    ],
    agents: [],
  };
  queryClient.setQueryData(workspace.api.orpc.home.get.queryKey({ input: { tab: 'mine' } }), home);
  const wrapper = ({ children }: { children: ReactNode }) => (
    <QueryClientProvider client={queryClient}>
      <WorkspaceProvider workspace={workspace}>{children}</WorkspaceProvider>
    </QueryClientProvider>
  );
  return { queryClient, wrapper };
}

function cards(queryClient: QueryClient, status: TaskStatus): string[] {
  const data = queryClient.getQueryData<{ pages: TaskListPage[] }>(boardKey(status));
  return data?.pages.flatMap((page) => page.items.map((item) => item.key)) ?? [];
}

function listItem(queryClient: QueryClient, key: string) {
  const data = queryClient.getQueryData<{ items: TaskListItem[] }>(
    taskListQuery(workspace.api, { project: ['PAY'] }).queryKey,
  );
  return data?.items.find((item) => item.key === key);
}

function homeTask(queryClient: QueryClient) {
  return queryClient.getQueryData<Home>(workspace.api.orpc.home.get.queryKey({ input: { tab: 'mine' } }))
    ?.groups[0]?.items[0]?.task;
}

beforeEach(() => {
  api.current = createFakeApi({ fields: true });
});

describe('useUpdateTask', () => {
  it('changes the detail, lists, board columns and Home at once', async () => {
    const { queryClient, wrapper } = await seed();
    const release = fake().hold();
    const { result } = renderHook(() => useUpdateTask(), { wrapper });
    expect(cards(queryClient, 'in_progress')).toContain('PAY-1');
    act(() => {
      result.current.mutate({
        key: 'PAY-1',
        patch: {
          status: 'done',
          dueDate: '2026-12-01',
          addLabels: [{ id: 'x', name: 'api', color: 1, source: 'app' }],
        },
      });
    });
    await waitFor(() =>
      expect(queryClient.getQueryData(taskQuery(workspace.api, 'PAY-1').queryKey)?.status).toBe('done'),
    );
    expect(
      queryClient
        .getQueryData(taskQuery(workspace.api, 'PAY-1').queryKey)
        ?.labels?.map((label) => label.name),
    ).toEqual(['api', 'backend', 'payouts']);
    expect(listItem(queryClient, 'PAY-1')).toMatchObject({ status: 'done', dueDate: '2026-12-01' });
    expect(cards(queryClient, 'in_progress')).not.toContain('PAY-1');
    expect(cards(queryClient, 'done')).toContain('PAY-1');
    const counts = queryClient.getQueryData<{ pages: TaskListPage[] }>(boardKey('done'))?.pages[0]?.counts;
    expect(counts?.done).toBe(2);
    expect(homeTask(queryClient)?.status).toBe('done');
    release();
    await waitFor(() => expect(result.current.isSuccess).toBe(true));
    expect(fake().calls.update.at(-1)).toEqual({
      key: 'PAY-1',
      status: 'done',
      dueDate: '2026-12-01',
      addLabels: ['api'],
    });
  });

  it('puts every copy back when the server refuses', async () => {
    const { queryClient, wrapper } = await seed();
    fake().control.failUpdates = true;
    const { result } = renderHook(() => useUpdateTask(), { wrapper });
    act(() => result.current.mutate({ key: 'PAY-1', patch: { status: 'done' } }));
    await waitFor(() => expect(result.current.isError).toBe(true));
    expect(queryClient.getQueryData(taskQuery(workspace.api, 'PAY-1').queryKey)?.status).toBe('in_progress');
    expect(listItem(queryClient, 'PAY-1')?.status).toBe('in_progress');
    expect(cards(queryClient, 'in_progress')).toContain('PAY-1');
    expect(cards(queryClient, 'done')).not.toContain('PAY-1');
    expect(homeTask(queryClient)?.status).toBe('in_progress');
  });

  it('shows a new parent and its progress at once', async () => {
    const { queryClient, wrapper } = await seed();
    queryClient.setQueryData(
      taskQuery(workspace.api, 'PAY-3').queryKey,
      await fake().client.tasks.get({ key: 'PAY-3' }),
    );
    const release = fake().hold();
    const { result } = renderHook(() => useUpdateTask(), { wrapper });
    act(() =>
      result.current.mutate({
        key: 'PAY-3',
        patch: { parent: { key: 'PAY-1', title: 'Task number 1', status: 'in_progress', assignee: null } },
      }),
    );
    await waitFor(() =>
      expect(
        queryClient
          .getQueryData(taskQuery(workspace.api, 'PAY-1').queryKey)
          ?.subtasks?.map((task) => task.key),
      ).toEqual(['PAY-3', 'PAY-5']),
    );
    expect(listItem(queryClient, 'PAY-3')?.parentKey).toBe('PAY-1');
    expect(listItem(queryClient, 'PAY-1')?.subtaskProgress).toEqual({ done: 0, total: 2 });
    release();
    await waitFor(() => expect(result.current.isSuccess).toBe(true));
    expect(fake().calls.update.at(-1)).toEqual({ key: 'PAY-3', parent: 'PAY-1' });
  });
});

describe('patches and their inverse', () => {
  it('undoes what a patch changed, and knows when nothing changes', async () => {
    const task = await fake().client.tasks.get({ key: 'PAY-2' });
    const api_ = { id: 'x', name: 'api', color: 1, source: 'app' as const };
    expect(inversePatch(task, { status: 'done', addLabels: [api_], addBlockers: [] })).toEqual({
      status: task.status,
      removeLabels: ['api'],
    });
    expect(inversePatch(task, { removeBlockers: ['PAY-3'] })).toEqual({
      addBlockers: [expect.objectContaining({ key: 'PAY-3' })],
    });
    const after = applyTaskPatch(task, { removeBlockers: ['PAY-3'] });
    expect(after.blockedBy).toEqual([]);
    expect(after.blocked).toBe(false);
    expect(isNoopPatch(task, { status: task.status })).toBe(true);
    expect(isNoopPatch(task, { removeLabels: ['nothing'] })).toBe(true);
    expect(isNoopPatch(task, { dueDate: '2030-01-01' })).toBe(false);
  });
});

describe('useBulkUpdateTasks', () => {
  it('changes native tasks in one request', async () => {
    const { queryClient, wrapper } = await seed();
    const { result } = renderHook(() => useBulkUpdateTasks(), { wrapper });
    act(() => result.current.mutate({ keys: ['PAY-1', 'PAY-2'], patch: { priority: 'urgent' } }));
    await waitFor(() => expect(listItem(queryClient, 'PAY-2')?.priority).toBe('urgent'));
    await waitFor(() => expect(result.current.isSuccess).toBe(true));
    expect(fake().calls.bulk).toEqual([{ keys: ['PAY-1', 'PAY-2'], priority: 'urgent' }]);
    expect(
      fake()
        .tasks.slice(0, 2)
        .map((task) => task.priority),
    ).toEqual(['urgent', 'urgent']);
  });

  it('refuses a selection with mirrored tasks without sending it', async () => {
    const { queryClient, wrapper } = await seed();
    const mirrored = { ...(listItem(queryClient, 'PAY-2') as TaskListItem), locked: ['status' as const] };
    const native = listItem(queryClient, 'PAY-1') as TaskListItem;
    expect(bulkRefusal([native, mirrored])).toBe(
      'Read-only: 1 of 2 selected tasks come from Backlog.md. Change those in the files.',
    );
    const { result } = renderHook(() => useBulkUpdateTasks(), { wrapper });
    act(() =>
      result.current.mutate({
        keys: ['PAY-1', 'PAY-2'],
        patch: { status: 'done' },
        targets: [native, mirrored],
      }),
    );
    await waitFor(() => expect(result.current.isError).toBe(true));
    expect(result.current.error).toBeInstanceOf(BulkRefusedError);
    expect(fake().calls.bulk).toHaveLength(0);
    expect(listItem(queryClient, 'PAY-1')?.status).toBe('in_progress');
  });
});

describe('useCreateTask', () => {
  it('creates a subtask that takes the parent assignee and shows under the parent', async () => {
    const { queryClient, wrapper } = await seed();
    const { result } = renderHook(() => useCreateTask(), { wrapper });
    act(() => result.current.mutate({ project: 'PAY', title: 'Alert copy', parent: 'PAY-1' }));
    await waitFor(() => expect(result.current.isSuccess).toBe(true));
    expect(result.current.data?.assignee?.name).toBe('claude-dev');
    expect(
      queryClient.getQueryData(taskQuery(workspace.api, 'PAY-1').queryKey)?.subtasks?.map((task) => task.key),
    ).toContain(result.current.data?.key);
  });
});
