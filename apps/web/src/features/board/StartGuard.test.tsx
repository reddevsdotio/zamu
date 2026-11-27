import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import {
  createMemoryHistory,
  createRootRoute,
  createRoute,
  createRouter,
  Outlet,
  RouterProvider,
} from '@tanstack/react-router';
import { configure, render, screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import type { TaskWave } from '@zamu/contracts';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { PageSearchProvider } from '~/features/shell/page-search';
import { StartGuardHost, TaskFieldToast } from '~/features/task-fields';
import { resetStartingForTests } from '~/features/task-fields/starting';
import { resetFieldToastForTests } from '~/features/task-fields/toast';
import { parseTaskListSearch } from '~/features/tasks/search';
import { displayStorageKey } from '~/features/views';
import { resetDisplayOptionsForTests } from '~/features/views/useDisplayOptions';
import { FinishingHost } from '~/features/work-record/FinishingHost';
import { forwardingClient, testWorkspace } from '~/lib/testing';
import { WorkspaceProvider } from '~/lib/workspace';
import { UIProvider } from '~/ui';
import { BoardScreen } from './BoardScreen';
import { resetFoldedColumnsForTests } from './collapsed';
import { BOARD_PEOPLE, createFakeBoardApi, type FakeBoardApi } from './fake-board-api';

// The start guard on the board (M8, frame 114): a card in a locked wave moved into In progress, by its
// status keys or a drag (both end in the board's dropTo), waits for the warning; Cancel leaves it in
// its column, Start anyway moves it.

configure({ asyncUtilTimeout: 5000 });
vi.setConfig({ testTimeout: 30_000 });

const api = vi.hoisted(() => ({ current: null as FakeBoardApi | null }));
const workspace = testWorkspace(forwardingClient(() => api.current?.client));

const LOCKED: TaskWave = {
  id: '91000000-0000-4000-8000-000000000004',
  number: 4,
  name: 'End-to-end tests',
  locked: true,
  lockedUntil: { number: 3, name: 'Screens' },
};

function renderBoard() {
  window.localStorage.setItem(
    displayStorageKey(workspace.id, BOARD_PEOPLE.ANA.id, 'PAY', 'board'),
    JSON.stringify({ layout: 'board', orderBy: 'manual' }),
  );
  const queryClient = new QueryClient({
    defaultOptions: { queries: { retry: false, refetchOnWindowFocus: false } },
  });
  const root = createRootRoute({
    component: () => (
      <UIProvider>
        <PageSearchProvider>
          <Outlet />
          <TaskFieldToast />
          <FinishingHost />
          <StartGuardHost />
        </PageSearchProvider>
      </UIProvider>
    ),
  });
  const board = createRoute({
    getParentRoute: () => root,
    path: '/w/$workspace/p/$projectKey/',
    validateSearch: parseTaskListSearch,
    component: function BoardRoute() {
      const { projectKey } = board.useParams();
      return <BoardScreen projectKey={projectKey} search={board.useSearch()} />;
    },
  });
  const router = createRouter({
    routeTree: root.addChildren([board]),
    history: createMemoryHistory({ initialEntries: ['/w/acme/p/PAY?view=board'] }),
  });
  render(
    <QueryClientProvider client={queryClient}>
      <WorkspaceProvider workspace={workspace}>
        <RouterProvider router={router} />
      </WorkspaceProvider>
    </QueryClientProvider>,
  );
}

const column = (name: RegExp) => screen.getByRole('region', { name, hidden: true });
const keysIn = (name: RegExp) =>
  [...column(name).querySelectorAll('[data-card-key]')].map((card) => card.getAttribute('data-card-key'));
const focusedKey = () => document.activeElement?.closest('[data-card-key]')?.getAttribute('data-card-key');

beforeEach(() => {
  window.localStorage.clear();
  window.sessionStorage.clear();
  resetDisplayOptionsForTests();
  resetFoldedColumnsForTests();
  resetFieldToastForTests();
  api.current = createFakeBoardApi();
  const pay2 = api.current.tasks.find((task) => task.key === 'PAY-2');
  if (pay2) pay2.wave = LOCKED;
});

afterEach(() => resetStartingForTests());

describe('the board', () => {
  it('asks before Shift+→ starts a card in a locked wave; Cancel keeps it in Todo', async () => {
    const user = userEvent.setup();
    renderBoard();
    await screen.findByText('Card 4');
    await user.keyboard('j{ArrowRight}');
    await waitFor(() => expect(focusedKey()).toBe('PAY-2'));
    await user.keyboard('{Shift>}{ArrowRight}{/Shift}');
    const dialog = await screen.findByRole('alertdialog', { name: 'W4 is still locked' });
    expect(dialog).toHaveTextContent('The gate of W3 · Screens hasn’t passed yet. Starting PAY-2 now');
    expect(keysIn(/^Todo/)).toContain('PAY-2');
    await user.click(within(dialog).getByRole('button', { name: 'Cancel' }));
    await waitFor(() => expect(screen.queryByRole('alertdialog')).toBeNull());
    expect(api.current?.calls.update).toHaveLength(0);
    expect(keysIn(/^Todo/)).toContain('PAY-2');
  });

  it('moves the card with Start anyway', async () => {
    const user = userEvent.setup();
    renderBoard();
    await screen.findByText('Card 4');
    await user.keyboard('j{ArrowRight}');
    await waitFor(() => expect(focusedKey()).toBe('PAY-2'));
    await user.keyboard('{Shift>}{ArrowRight}{/Shift}');
    const dialog = await screen.findByRole('alertdialog', { name: 'W4 is still locked' });
    await user.click(within(dialog).getByRole('button', { name: /Start anyway/ }));
    await waitFor(() => expect(api.current?.calls.update).toHaveLength(1));
    expect(api.current?.calls.update[0]).toMatchObject({ key: 'PAY-2', status: 'in_progress' });
    await waitFor(() => expect(keysIn(/^In progress/)).toContain('PAY-2'));
  });

  it('asks from the S status picker too', async () => {
    const user = userEvent.setup();
    renderBoard();
    await screen.findByText('Card 4');
    await user.keyboard('j{ArrowRight}');
    await waitFor(() => expect(focusedKey()).toBe('PAY-2'));
    await user.keyboard('s');
    const menu = await screen.findByRole('dialog', { name: 'Status' });
    await user.click(within(menu).getByRole('menuitemradio', { name: /In review/ }));
    expect(await screen.findByRole('alertdialog', { name: 'W4 is still locked' })).toBeInTheDocument();
    expect(api.current?.calls.update).toHaveLength(0);
  });
});
