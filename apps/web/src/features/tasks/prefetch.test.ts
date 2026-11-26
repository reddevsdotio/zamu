import { QueryClient } from '@tanstack/react-query';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { boardColumnInput, boardColumnKey } from '~/features/board/queries';
import { defaultDisplayOptions } from '~/features/views/display-options';
import { testWorkspace } from '~/lib/testing';
import { createFakeApi, type FakeApi } from './fake-api';
import { prefetchTaskList } from './prefetch';
import { taskListQuery } from './queries';
import { listMainInput, parseTaskListSearch, taskFilterOf } from './search';

// The route's prefetch asks for exactly what the list and the board ask for with the default display
// options, so the first render reuses the server's answer (a hard reload makes no second request).

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

beforeEach(() => {
  api.current = createFakeApi({ fields: true });
});

const newClient = () => new QueryClient({ defaultOptions: { queries: { retry: false } } });

describe('task list prefetch', () => {
  it('caches the list request the list screen makes', async () => {
    const queryClient = newClient();
    const search = parseTaskListSearch({ q: 'task', priority: 'high' });
    await prefetchTaskList(workspace.api, queryClient, 'PAY', search);
    const input = listMainInput('PAY', taskFilterOf(search), defaultDisplayOptions('list'), false);
    expect(queryClient.getQueryData(taskListQuery(workspace.api, input).queryKey)).toBeDefined();
    expect(api.current?.calls.list).toHaveLength(1);
  });

  it('caches the open board columns the board makes, Done and Canceled folded', async () => {
    const queryClient = newClient();
    const search = parseTaskListSearch({ view: 'board' });
    await prefetchTaskList(workspace.api, queryClient, 'PAY', search);
    const filter = taskFilterOf(search);
    const options = defaultDisplayOptions('board');
    for (const status of ['backlog', 'todo', 'in_progress', 'in_review'] as const) {
      const key = boardColumnKey(workspace.api, boardColumnInput('PAY', filter, options, status));
      expect(queryClient.getQueryData(key), status).toBeDefined();
    }
    expect(api.current?.calls.list).toHaveLength(4);
  });
});
