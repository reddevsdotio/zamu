import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import {
  createMemoryHistory,
  createRootRoute,
  createRoute,
  createRouter,
  Outlet,
  RouterProvider,
} from '@tanstack/react-router';
import { act, configure, render, screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import type { Task } from '@zamu/contracts';
import { ana, claudeDev, workItemFixtures } from '@zamu/contracts/testing/fixtures';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { createFakeApi, type FakeApi } from '~/features/tasks/fake-api';
import { readTaskNavigation } from '~/features/views';
import { UIProvider } from '~/ui';
import { PeekHost } from './PeekHost';
import { closePeek, openPeek } from './store';

// The peek (frames 067–070; M6 frame 023 for the work record) over a stand-in list, against the
// in-memory /api/v1 client.

configure({ asyncUtilTimeout: 5000 });
vi.setConfig({ testTimeout: 30_000 });

const api = vi.hoisted(() => ({ current: null as FakeApi | null }));

vi.mock('~/lib/orpc', async () => {
  const { createTanstackQueryUtils } = await import('@orpc/tanstack-query');
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
  return { client, orpc: createTanstackQueryUtils(client as never) };
});

function renderApp(url = '/p/PAY') {
  const queryClient = new QueryClient({
    defaultOptions: { queries: { retry: false, refetchOnWindowFocus: false, refetchInterval: false } },
  });
  const root = createRootRoute({
    component: () => (
      <UIProvider>
        <Outlet />
        <PeekHost />
      </UIProvider>
    ),
  });
  const list = createRoute({
    getParentRoute: () => root,
    path: '/p/$projectKey/',
    component: () => <p>List</p>,
  });
  const page = createRoute({
    getParentRoute: () => root,
    path: '/p/$projectKey/$taskKey',
    component: function Page() {
      const { taskKey } = page.useParams();
      return <p>Task view {taskKey}</p>;
    },
  });
  const router = createRouter({
    routeTree: root.addChildren([list, page]),
    history: createMemoryHistory({ initialEntries: [url] }),
  });
  render(
    <QueryClientProvider client={queryClient}>
      <RouterProvider router={router} />
    </QueryClientProvider>,
  );
  return { router };
}

const peek = () => screen.getByRole('region', { name: /^Peek: / });

beforeEach(() => {
  api.current = createFakeApi({ fields: true });
  window.sessionStorage.clear();
});

afterEach(() => act(() => closePeek()));

describe('peek', () => {
  it('shows the title, the properties as chips and the latest comment, without a scrim', async () => {
    renderApp();
    await screen.findByText('List');
    act(() => openPeek({ key: 'PAY-1', keys: ['PAY-1', 'PAY-2'], from: 'List' }));
    const panel = await screen.findByRole('region', { name: 'Peek: PAY-1' });
    expect(await within(panel).findByRole('heading', { name: /Task number 1/ })).toBeInTheDocument();
    expect(within(panel).getByRole('button', { name: 'Status' })).toBeInTheDocument();
    expect(within(panel).getAllByRole('button', { name: 'Labels' })).toHaveLength(2);
    expect(await within(panel).findByRole('article', { name: /^Comment by / })).toBeInTheDocument();
    expect(within(panel).getByText(/more in the task/)).toBeInTheDocument();
    // No scrim: the view behind stays usable.
    expect(document.querySelector('.bg-scrim')).toBeNull();
    expect(screen.getByText('List')).toBeVisible();
  });

  it('moves with J and K inside the keys it was given, and tells the view', async () => {
    const onMove = vi.fn();
    renderApp();
    await screen.findByText('List');
    act(() => openPeek({ key: 'PAY-1', keys: ['PAY-1', 'PAY-2', 'PAY-3'], from: 'List', onMove }));
    await screen.findByRole('region', { name: 'Peek: PAY-1' });
    const user = userEvent.setup();
    await user.keyboard('j');
    await screen.findByRole('region', { name: 'Peek: PAY-2' });
    expect(onMove).toHaveBeenLastCalledWith('PAY-2');
    await user.keyboard('j');
    await user.keyboard('j');
    await screen.findByRole('region', { name: 'Peek: PAY-3' });
    await user.keyboard('k');
    await screen.findByRole('region', { name: 'Peek: PAY-2' });
  });

  it('closes with Esc and with Space', async () => {
    renderApp();
    await screen.findByText('List');
    const user = userEvent.setup();
    act(() => openPeek({ key: 'PAY-1', keys: ['PAY-1'], from: 'List' }));
    await screen.findByRole('region', { name: 'Peek: PAY-1' });
    await user.keyboard('{Escape}');
    await waitFor(() => expect(screen.queryByRole('region', { name: /^Peek: / })).not.toBeInTheDocument());

    act(() => openPeek({ key: 'PAY-1', keys: ['PAY-1'], from: 'List' }));
    await screen.findByRole('region', { name: 'Peek: PAY-1' });
    await user.keyboard(' ');
    await waitFor(() => expect(screen.queryByRole('region', { name: /^Peek: / })).not.toBeInTheDocument());
  });

  it('opens the task view with Enter and remembers the list for J / K there', async () => {
    const { router } = renderApp('/p/PAY');
    await screen.findByText('List');
    act(() => openPeek({ key: 'PAY-2', keys: ['PAY-1', 'PAY-2'], from: 'Board' }));
    await within(await screen.findByRole('region', { name: 'Peek: PAY-2' })).findByRole('heading', {
      name: /Task number 2/,
    });
    await userEvent.setup().keyboard('{Enter}');
    await screen.findByText('Task view PAY-2');
    expect(router.state.location.pathname).toBe('/p/PAY/PAY-2');
    expect(readTaskNavigation()).toMatchObject({
      keys: ['PAY-1', 'PAY-2'],
      from: 'Board',
      returnTo: '/p/PAY',
    });
    expect(screen.queryByRole('region', { name: /^Peek: / })).not.toBeInTheDocument();
  });

  it('shows both work-record counts as chips and opens on the final summary', async () => {
    const task = fake().tasks[0] as Task;
    Object.assign(task, {
      criteria: [workItemFixtures.checked, workItemFixtures.open, workItemFixtures.waived],
      doneItems: [
        { ...workItemFixtures.checked, text: 'Tests pass' },
        { ...workItemFixtures.checked, number: 2 },
      ],
      finalSummary: 'Failed payouts now retry on a backoff schedule.',
      finalSummaryMeta: { author: claudeDev, onBehalfOf: ana, origin: 'app', at: '2026-10-22T18:00:00.000Z' },
    });
    renderApp();
    await screen.findByText('List');
    act(() => openPeek({ key: 'PAY-1', keys: ['PAY-1'], from: 'List' }));
    const panel = await screen.findByRole('region', { name: 'Peek: PAY-1' });
    await within(panel).findByRole('heading', { name: /Task number 1/ });
    // Checked of total; the waived one counts as settled, not as checked.
    const criteria = within(panel).getByRole('img', { name: '1 of 3 criteria checked, 1 waived' });
    expect(criteria).toHaveTextContent('1 of 3 criteria');
    expect(criteria).not.toHaveAttribute('data-complete');
    const done = within(panel).getByRole('img', { name: 'All 2 done items checked' });
    expect(done).toHaveTextContent('2 of 2 done items');
    expect(done).toHaveAttribute('data-complete', 'true');
    // The summary in place of the description, with who wrote it.
    const summary = within(panel).getByRole('region', { name: 'Summary' });
    expect(summary).toHaveTextContent('Failed payouts now retry on a backoff schedule.');
    expect(summary).toHaveTextContent('claude-dev for Ana');
    expect(within(panel).queryByText('First line.')).not.toBeInTheDocument();
  });

  it('shows no count chips and the description for a task without a work record', async () => {
    renderApp();
    await screen.findByText('List');
    act(() => openPeek({ key: 'PAY-1', keys: ['PAY-1'], from: 'List' }));
    const panel = await screen.findByRole('region', { name: 'Peek: PAY-1' });
    await within(panel).findByRole('heading', { name: /Task number 1/ });
    expect(within(panel).queryByRole('img', { name: /criteri|done item/ })).not.toBeInTheDocument();
    expect(within(panel).queryByRole('region', { name: 'Summary' })).not.toBeInTheDocument();
    expect(within(panel).getByText('First line.')).toBeInTheDocument();
  });

  it('is read-only in mirrored projects and says so', async () => {
    const task = fake().tasks[0] as Task;
    Object.assign(task, { locked: ['status', 'priority', 'labels'] });
    renderApp();
    await screen.findByText('List');
    act(() => openPeek({ key: 'PAY-1', keys: ['PAY-1'], from: 'List' }));
    const panel = await screen.findByRole('region', { name: 'Peek: PAY-1' });
    await within(panel).findByRole('heading', { name: /Task number 1/ });
    expect(within(peek()).queryByRole('button', { name: 'Status' })).not.toBeInTheDocument();
    expect(within(peek()).getByText('Read-only: Payments mirrors Backlog.md')).toBeInTheDocument();
  });
});

const fake = () => api.current as FakeApi;
