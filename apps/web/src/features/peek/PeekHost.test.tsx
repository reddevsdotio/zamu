import { QueryClient, QueryClientProvider, useQuery } from '@tanstack/react-query';
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
import { TaskFieldToast, useTaskFieldKeys } from '~/features/task-fields';
import { resetFieldToastForTests } from '~/features/task-fields/toast';
import { createFakeApi, FAKE_REPOSITORY, type FakeApi } from '~/features/tasks/fake-api';
import { taskQuery } from '~/features/tasks/queries';
import { readTaskNavigation } from '~/features/views';
import { testWorkspace } from '~/lib/testing';
import { useApi, WorkspaceProvider } from '~/lib/workspace';
import { UIProvider } from '~/ui';
import { PeekHost } from './PeekHost';
import { closePeek, openPeek, usePeek } from './store';

/**
 * Stands in for a list: like the list, the board and Home, it binds the task keys (⇧W included) for its
 * focused task and turns them off while the peek is open.
 */
function StandInList() {
  const api = useApi();
  const peekOpen = usePeek() != null;
  const task = useQuery(taskQuery(api, 'PAY-1')).data;
  const keys = useTaskFieldKeys({ targets: task ? [task] : [], enabled: !peekOpen, commands: false });
  return (
    <>
      <p>List</p>
      {keys.pickers}
    </>
  );
}

// The peek (frames 067–070; M6 frame 023 for the work record) over a stand-in list, against the
// in-memory /api/v1 client.

configure({ asyncUtilTimeout: 5000 });
vi.setConfig({ testTimeout: 30_000 });

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

function renderApp(url = '/w/acme/p/PAY') {
  const queryClient = new QueryClient({
    defaultOptions: { queries: { retry: false, refetchOnWindowFocus: false, refetchInterval: false } },
  });
  const root = createRootRoute({
    component: () => (
      <UIProvider>
        <Outlet />
        <PeekHost />
        <TaskFieldToast />
      </UIProvider>
    ),
  });
  const list = createRoute({
    getParentRoute: () => root,
    path: '/w/$workspace/p/$projectKey/',
    component: StandInList,
  });
  const page = createRoute({
    getParentRoute: () => root,
    path: '/w/$workspace/p/$projectKey/$taskKey',
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
      <WorkspaceProvider workspace={workspace}>
        <RouterProvider router={router} />
      </WorkspaceProvider>
    </QueryClientProvider>,
  );
  return { router };
}

const peek = () => screen.getByRole('region', { name: /^Peek: / });

beforeEach(() => {
  api.current = createFakeApi({ fields: true });
  window.sessionStorage.clear();
});

afterEach(() => {
  act(() => closePeek());
  resetFieldToastForTests();
});

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
    const { router } = renderApp('/w/acme/p/PAY');
    await screen.findByText('List');
    act(() => openPeek({ key: 'PAY-2', keys: ['PAY-1', 'PAY-2'], from: 'Board' }));
    await within(await screen.findByRole('region', { name: 'Peek: PAY-2' })).findByRole('heading', {
      name: /Task number 2/,
    });
    await userEvent.setup().keyboard('{Enter}');
    await screen.findByText('Task view PAY-2');
    expect(router.state.location.pathname).toBe('/w/acme/p/PAY/PAY-2');
    expect(readTaskNavigation(workspace.id)).toMatchObject({
      keys: ['PAY-1', 'PAY-2'],
      from: 'Board',
      returnTo: '/w/acme/p/PAY',
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

  describe('M7', () => {
    beforeEach(() => {
      vi.useFakeTimers({ toFake: ['Date'], shouldAdvanceTime: true });
      vi.setSystemTime(new Date(2026, 10, 26, 12));
    });
    afterEach(() => {
      vi.useRealTimers();
    });

    it('shows the newest request, the check-again chip and its reason under the chips', async () => {
      const task = fake().tasks[0] as Task;
      Object.assign(task, {
        checkAgain: { on: '2026-12-03', reason: 'the bank issues the new certificate on Dec 1.' },
        pullRequests: [
          {
            provider: 'github',
            number: 482,
            title: 'Retry failed payouts',
            url: 'https://github.com/northwind/payments/pull/482',
            state: 'open',
            headBranch: 'pay-1-retry',
            baseBranch: 'main',
            author: 'claude-dev',
            mergedBy: null,
            how: 'branch',
            linkedBy: null,
            linkedAt: '2026-11-20T10:00:00.000Z',
            openedAt: '2026-11-20T10:00:00.000Z',
            mergedAt: null,
            closedAt: null,
            updatedAt: '2026-11-20T10:00:00.000Z',
          },
        ],
      });
      renderApp();
      await screen.findByText('List');
      act(() => openPeek({ key: 'PAY-1', keys: ['PAY-1'], from: 'List' }));
      const panel = await screen.findByRole('region', { name: 'Peek: PAY-1' });
      await within(panel).findByRole('heading', { name: /Task number 1/ });
      expect(panel.querySelector('[data-request-chip]')).toHaveTextContent('#482 open');
      const chip = within(panel).getByRole('button', { name: 'Check again' });
      expect(chip).toHaveTextContent('Waiting until Dec 3');
      expect(
        within(panel).getByText('Why it waits: the bank issues the new certificate on Dec 1.'),
      ).toBeInTheDocument();
      // Shift+W opens the check-again picker.
      const user = userEvent.setup();
      await user.keyboard('{Shift>}W{/Shift}');
      expect(await screen.findByRole('dialog', { name: /Check again/ })).toBeInTheDocument();
    });

    it('opens one check-again picker for one ⇧W, while the list behind keeps its keys off', async () => {
      const task = fake().tasks[0] as Task;
      Object.assign(task, { checkAgain: { on: '2026-12-03', reason: 'The bank answers' } });
      const user = userEvent.setup();
      renderApp();
      await screen.findByText('List');
      act(() => openPeek({ key: 'PAY-1', keys: ['PAY-1'], from: 'List' }));
      const panel = await screen.findByRole('region', { name: 'Peek: PAY-1' });
      await within(panel).findByRole('button', { name: 'Check again' });
      await user.keyboard('{Shift>}W{/Shift}');
      await screen.findByRole('dialog', { name: /Check again/ });
      // Give a second picker the time to show up.
      await new Promise((resolve) => setTimeout(resolve, 200));
      expect(screen.getAllByRole('dialog', { name: /Check again/ })).toHaveLength(1);
    });

    it('⇧P opens the paste field under the chips, and ↵ links the request', async () => {
      api.current = createFakeApi({ fields: true, repository: true });
      const linked = {
        provider: 'github' as const,
        number: 485,
        title: 'Runbook entry for payout retries',
        url: `https://${FAKE_REPOSITORY}/pull/485`,
        state: 'open' as const,
        headBranch: 'runbook',
        baseBranch: 'main',
        author: 'claude-dev',
        mergedBy: null,
        openedAt: '2026-11-20T10:00:00.000Z',
        mergedAt: null,
        closedAt: null,
        updatedAt: '2026-11-20T10:00:00.000Z',
      };
      fake().requests.set(485, linked);
      const user = userEvent.setup();
      renderApp();
      await screen.findByText('List');
      act(() => openPeek({ key: 'PAY-1', keys: ['PAY-1'], from: 'List' }));
      const panel = await screen.findByRole('region', { name: 'Peek: PAY-1' });
      await within(panel).findByRole('heading', { name: /Task number 1/ });
      expect(within(panel).queryByRole('textbox', { name: 'Pull request address' })).toBeNull();

      await user.keyboard('{Shift>}P{/Shift}');
      const field = await within(panel).findByRole('textbox', { name: 'Pull request address' });
      expect(field).toHaveFocus();
      await user.paste(`https://${FAKE_REPOSITORY}/pull/485`);
      await waitFor(() => expect(panel.querySelector('[data-preview]')).not.toBeNull());
      // Typing in the field never moves or closes the peek.
      expect(screen.getByRole('region', { name: 'Peek: PAY-1' })).toBeInTheDocument();
      await user.keyboard('{Enter}');
      await waitFor(() => expect(fake().calls.link.at(-1)).toEqual({ key: 'PAY-1', url: linked.url }));
      await waitFor(() =>
        expect(within(panel).queryByRole('textbox', { name: 'Pull request address' })).toBeNull(),
      );
      expect(await screen.findByText('Linked #485 to PAY-1')).toBeInTheDocument();
      // The chip shows the new request; the peek stays open.
      await waitFor(() => expect(panel.querySelector('[data-request-chip]')).toHaveTextContent('#485 open'));
      expect(screen.getByRole('region', { name: 'Peek: PAY-1' })).toBeInTheDocument();
    });

    it('Esc in the paste field closes the field, not the peek', async () => {
      api.current = createFakeApi({ fields: true, repository: true });
      const user = userEvent.setup();
      renderApp();
      await screen.findByText('List');
      act(() => openPeek({ key: 'PAY-1', keys: ['PAY-1'], from: 'List' }));
      const panel = await screen.findByRole('region', { name: 'Peek: PAY-1' });
      await within(panel).findByRole('heading', { name: /Task number 1/ });
      await user.keyboard('{Shift>}P{/Shift}');
      await within(panel).findByRole('textbox', { name: 'Pull request address' });
      await user.keyboard('{Escape}');
      await waitFor(() =>
        expect(within(panel).queryByRole('textbox', { name: 'Pull request address' })).toBeNull(),
      );
      expect(screen.getByRole('region', { name: 'Peek: PAY-1' })).toBeInTheDocument();
    });

    it('⇧P on a project without a repository shows the task view’s toast', async () => {
      const user = userEvent.setup();
      renderApp();
      await screen.findByText('List');
      act(() => openPeek({ key: 'PAY-1', keys: ['PAY-1'], from: 'List' }));
      const panel = await screen.findByRole('region', { name: 'Peek: PAY-1' });
      await within(panel).findByRole('heading', { name: /Task number 1/ });
      // Let the project list (no repository) load: until it has, ⇧P opens the field.
      await new Promise((resolve) => setTimeout(resolve, 100));
      await user.keyboard('{Shift>}P{/Shift}');
      expect(
        await screen.findByText('Payments has no repository. Link one in the project settings first.'),
      ).toBeInTheDocument();
      expect(within(panel).queryByRole('textbox', { name: 'Pull request address' })).toBeNull();
    });

    it('tags an archived task and keeps its day read-only', async () => {
      const task = fake().tasks[0] as Task;
      Object.assign(task, {
        archivedAt: '2026-11-12T10:00:00.000Z',
        checkAgain: { on: '2026-11-20', reason: 'Look again' },
      });
      renderApp();
      await screen.findByText('List');
      act(() => openPeek({ key: 'PAY-1', keys: ['PAY-1'], from: 'List' }));
      const panel = await screen.findByRole('region', { name: 'Peek: PAY-1' });
      await within(panel).findByRole('heading', { name: /Task number 1/ });
      expect(panel.querySelector('[data-part="archived-tag"]')).toHaveTextContent('Archived');
      expect(within(panel).queryByRole('button', { name: 'Check again' })).toBeNull();
      expect(panel).toHaveTextContent('Check again: 6 days ago');
      expect(within(panel).getByText('Look again')).toBeInTheDocument();
    });
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
