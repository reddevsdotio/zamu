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
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { usePeek } from '~/features/peek/store';
import { PageSearchProvider } from '~/features/shell/page-search';
import { QuickCreateProvider, useQuickCreate } from '~/features/shell/quick-create';
import { TaskFieldToast } from '~/features/task-fields';
import { resetFieldToastForTests } from '~/features/task-fields/toast';
import { parseTaskListSearch } from '~/features/tasks/search';
import { type DisplayOptions, displayStorageKey, taskNavStorageKey } from '~/features/views';
import { resetDisplayOptionsForTests } from '~/features/views/useDisplayOptions';
import { FinishingHost } from '~/features/work-record/FinishingHost';
import { testWorkspace } from '~/lib/testing';
import { WorkspaceProvider } from '~/lib/workspace';
import { UIProvider } from '~/ui';
import { BoardScreen } from './BoardScreen';
import { foldedColumnsKey, resetFoldedColumnsForTests } from './collapsed';
import { BOARD_PEOPLE, createFakeBoardApi, type FakeBoardApi } from './fake-board-api';

// Component tests of the board against an in-memory /api/v1 client inside a real TanStack router:
// columns and display options, keyboard focus, moves, undo through the field toast, the rollback when
// someone else changed the task, swimlanes, subtasks and mirrored projects.

configure({ asyncUtilTimeout: 5000 });
vi.setConfig({ testTimeout: 30_000 });

const api = vi.hoisted(() => ({ current: null as FakeBoardApi | null }));

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

/** Stands in for the quick create dialog: shows what the board opened it with. */
function QuickCreateProbe() {
  const { isOpen, projectKey, status } = useQuickCreate();
  return (
    <output aria-label="Quick create">{isOpen ? `${projectKey} ${status ?? 'default'}` : 'closed'}</output>
  );
}

/** Stands in for the peek host: shows the peeked task. */
function PeekProbe() {
  const peek = usePeek();
  return <output aria-label="Peek">{peek ? `${peek.key} from ${peek.from}` : 'closed'}</output>;
}

/** Saves the viewer's board display options before the board renders. */
function setDisplay(options: Partial<DisplayOptions>) {
  window.localStorage.setItem(
    displayStorageKey(workspace.id, BOARD_PEOPLE.ANA.id, 'PAY', 'board'),
    JSON.stringify({ layout: 'board', ...options }),
  );
}

function renderBoard(
  url = '/w/acme/p/PAY?view=board',
  { quickCreate = false }: { quickCreate?: boolean } = {},
) {
  const queryClient = new QueryClient({
    defaultOptions: { queries: { retry: false, refetchOnWindowFocus: false } },
  });
  const root = createRootRoute({
    component: () => (
      <UIProvider>
        <PageSearchProvider>
          {quickCreate ? (
            <QuickCreateProvider>
              <Outlet />
              <QuickCreateProbe />
            </QuickCreateProvider>
          ) : (
            <Outlet />
          )}
          <PeekProbe />
          <TaskFieldToast />
          <FinishingHost />
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
  const page = createRoute({
    getParentRoute: () => root,
    path: '/w/$workspace/p/$projectKey/$taskKey',
    component: () => <p>Task page</p>,
  });
  const router = createRouter({
    routeTree: root.addChildren([board, page]),
    history: createMemoryHistory({ initialEntries: [url] }),
  });
  render(
    <QueryClientProvider client={queryClient}>
      <WorkspaceProvider workspace={workspace}>
        <RouterProvider router={router} />
      </WorkspaceProvider>
    </QueryClientProvider>,
  );
  return { router, queryClient };
}

const column = (name: RegExp | string) => screen.getByRole('region', { name });
const keysIn = (name: RegExp) =>
  [...column(name).querySelectorAll('[data-card-key]')].map((card) => card.getAttribute('data-card-key'));
const focusedKey = () => document.activeElement?.closest('[data-card-key]')?.getAttribute('data-card-key');
const toast = () =>
  screen.queryAllByRole('status').find((node) => node.getAttribute('aria-live') === 'polite');

beforeEach(() => {
  window.localStorage.clear();
  window.sessionStorage.clear();
  resetDisplayOptionsForTests();
  resetFoldedColumnsForTests();
  resetFieldToastForTests();
  api.current = createFakeBoardApi();
});

afterEach(() => {
  resetFieldToastForTests();
});

describe('board', () => {
  it('shows the columns with tasks, Done folded, and loads by the display options', async () => {
    renderBoard();
    await screen.findByText('Card 4');
    expect(keysIn(/^Backlog, 1 tasks$/)).toEqual(['PAY-1']);
    // Priority order (the default): all medium, so the newest update first.
    expect(keysIn(/^Todo, 2 tasks$/)).toEqual(['PAY-3', 'PAY-2']);
    expect(screen.getByRole('button', { name: 'Expand Done, 1 tasks' })).toBeInTheDocument();
    // Canceled has no tasks and empty columns are off.
    expect(screen.queryByRole('button', { name: /Canceled/ })).not.toBeInTheDocument();
    // Only open columns load, top-level tasks in priority order.
    const inputs = api.current?.calls.list ?? [];
    expect(inputs.map((input) => (input.status as string[])[0])).not.toContain('done');
    expect(inputs[0]).toMatchObject({ sort: 'priority', topLevel: true });
  });

  it('shows the criteria marker only once Criteria is on, after subtasks and before the due date', async () => {
    api.current = createFakeBoardApi({
      criteria: {
        'PAY-2': { settled: 1, open: 2, waived: 0, total: 3 },
        'PAY-3': { settled: 5, open: 0, waived: 1, total: 5 },
      },
      dueDates: { 'PAY-2': '2026-11-07' },
      subtasks: { parent: 'PAY-2', count: 4, done: 3 },
    });
    // Subtasks as cards: the parent's progress then sits in its meta line, next to the marker.
    setDisplay({ boardSubtasks: 'cards' });
    renderBoard();
    await screen.findByText('Card 4');
    // Off by default.
    expect(screen.queryByRole('img', { name: /criteria/ })).toBeNull();
    const user = userEvent.setup();
    await user.click(screen.getByRole('button', { name: 'Display' }));
    const dialog = await screen.findByRole('dialog', { name: 'Display options' });
    expect(within(dialog).getByText('Shown on cards')).toBeInTheDocument();
    await user.click(within(dialog).getByRole('button', { name: 'Criteria', pressed: false }));
    await user.keyboard('{Escape}');

    const partial = await screen.findByRole('img', { name: '1 of 3 criteria checked' });
    expect(partial).toHaveTextContent('1/3');
    const card = partial.closest('[data-card-key]') as HTMLElement;
    expect(card).toHaveAttribute('data-card-key', 'PAY-2');
    const text = card.textContent ?? '';
    expect(text.indexOf('3/4')).toBeGreaterThan(-1);
    expect(text.indexOf('1/3')).toBeGreaterThan(text.indexOf('3/4'));
    const due = card.querySelector('[data-due]')?.textContent ?? '';
    expect(due).not.toBe('');
    expect(text.indexOf(due)).toBeGreaterThan(text.indexOf('1/3'));

    const complete = screen.getByRole('img', { name: 'All 5 criteria checked or waived' });
    expect(complete).toHaveAttribute('data-complete', 'true');
    expect(complete.closest('[data-card-key]')).toHaveAttribute('data-card-key', 'PAY-3');
    // A card without criteria shows nothing.
    const plain = document.querySelector('[data-card-key="PAY-4"]') as HTMLElement;
    expect(within(plain).queryByRole('img', { name: /criteri/ })).toBeNull();
  });

  it('shows empty columns with their note when the option is on', async () => {
    setDisplay({ showEmptyGroups: true });
    renderBoard();
    await screen.findByText('Card 4');
    expect(screen.getByRole('button', { name: 'Expand Canceled, 0 tasks' })).toBeInTheDocument();
    const user = userEvent.setup();
    await user.click(screen.getByRole('button', { name: 'Expand Canceled, 0 tasks' }));
    expect(
      await within(column(/^Canceled, 0 tasks$/)).findByText(/No tasks in Canceled\./),
    ).toBeInTheDocument();
    // Remembered for the board.
    expect(
      window.localStorage.getItem(foldedColumnsKey(workspace.id, BOARD_PEOPLE.ANA.id, 'PAY', 'status')),
    ).toBe('{"canceled":false}');
  });

  it('leaves out Done tasks past "Hide done tasks after", count included', async () => {
    const user = userEvent.setup();
    renderBoard();
    await screen.findByText('Card 4');
    // The Done card was last updated weeks ago.
    await user.click(screen.getByRole('button', { name: 'Expand Done, 1 tasks' }));
    const done = await screen.findByRole('region', { name: /^Done, 0 tasks$/ });
    expect(await within(done).findByText('Nothing done in the last 14 days.')).toBeInTheDocument();
  });

  it('comes back from the task view with the card focused (?focus=), then drops the param', async () => {
    const { router } = renderBoard('/w/acme/p/PAY?view=board&focus=PAY-3');
    await screen.findByText('Card 4');
    await waitFor(() => expect(focusedKey()).toBe('PAY-3'));
    await waitFor(() => expect(router.state.location.search).not.toHaveProperty('focus'));
    expect(router.state.location.search).toMatchObject({ view: 'board' });
  });

  it('moves the focus with J/K and the arrows, peeks with Space and opens with Enter', async () => {
    setDisplay({ orderBy: 'manual' });
    const user = userEvent.setup();
    const { router } = renderBoard();
    await screen.findByText('Card 4');

    await user.keyboard('j');
    await waitFor(() => expect(focusedKey()).toBe('PAY-1'));
    await user.keyboard('{ArrowRight}');
    await waitFor(() => expect(focusedKey()).toBe('PAY-2'));
    await user.keyboard('{ArrowDown}');
    await waitFor(() => expect(focusedKey()).toBe('PAY-3'));
    await user.keyboard('{ArrowRight}');
    await waitFor(() => expect(focusedKey()).toBe('PAY-5'));
    await user.keyboard('k');
    await waitFor(() => expect(focusedKey()).toBe('PAY-4'));

    await user.keyboard(' ');
    expect(screen.getByLabelText('Peek')).toHaveTextContent('PAY-4 from Board');

    act(() => {
      (document.querySelector('[data-card-key="PAY-4"]') as HTMLElement).focus();
    });
    await act(async () => {
      const { closePeek } = await import('~/features/peek/store');
      closePeek();
    });
    await user.keyboard('{Enter}');
    await waitFor(() => expect(router.state.location.pathname).toBe('/w/acme/p/PAY/PAY-4'));
    const remembered = JSON.parse(window.sessionStorage.getItem(taskNavStorageKey(workspace.id)) ?? '{}');
    expect(remembered.from).toBe('Board');
    expect(remembered.keys).toEqual(['PAY-1', 'PAY-2', 'PAY-3', 'PAY-4', 'PAY-5', 'PAY-6']);
  });

  it('selects with X and extends with Shift+↓ inside the column', async () => {
    setDisplay({ orderBy: 'manual' });
    const user = userEvent.setup();
    renderBoard();
    await screen.findByText('Card 4');
    await user.keyboard('j');
    await user.keyboard('{ArrowRight}{ArrowRight}');
    await waitFor(() => expect(focusedKey()).toBe('PAY-4'));
    await user.keyboard('x');
    expect(document.querySelector('[data-card-key="PAY-4"]')).toHaveAttribute('data-multi', 'true');
    await user.keyboard('{Shift>}{ArrowDown}{/Shift}');
    await waitFor(() =>
      expect(document.querySelector('[data-card-key="PAY-5"]')).toHaveAttribute('data-multi', 'true'),
    );
    await user.keyboard('{Escape}');
    await waitFor(() =>
      expect(document.querySelector('[data-card-key="PAY-4"]')).not.toHaveAttribute('data-multi'),
    );
  });

  it('changes status with Shift+→ in one PATCH and undoes it from the field toast', async () => {
    setDisplay({ orderBy: 'manual' });
    const user = userEvent.setup();
    renderBoard();
    await screen.findByText('Card 4');
    await user.keyboard('j{ArrowRight}');
    await waitFor(() => expect(focusedKey()).toBe('PAY-2'));

    await user.keyboard('{Shift>}{ArrowRight}{/Shift}');
    // The board changes at once.
    expect(keysIn(/^In progress/)).toEqual(['PAY-2', 'PAY-4', 'PAY-5']);
    expect(keysIn(/^Todo/)).toEqual(['PAY-3']);
    await waitFor(() => expect(toast()).toHaveTextContent('Moved PAY-2 to In progress'));
    await waitFor(() => expect(api.current?.calls.update).toHaveLength(1));
    const [first] = api.current?.calls.update ?? [];
    expect(first).toEqual({
      key: 'PAY-2',
      status: 'in_progress',
      ifUpdatedAt: '2026-10-20T10:00:02.000Z',
    });
    await waitFor(() => expect(focusedKey()).toBe('PAY-2'));
    await waitFor(() =>
      expect(api.current?.tasks.find((task) => task.key === 'PAY-2')?.status).toBe('in_progress'),
    );

    // One ⌘Z: the field toast's.
    await user.keyboard('{Control>}z{/Control}');
    await waitFor(() => expect(api.current?.calls.update).toHaveLength(2));
    const second = api.current?.calls.update[1];
    expect(second).toMatchObject({ key: 'PAY-2', status: 'todo', position: { before: 'PAY-3' } });
    // The undo sends the updatedAt the first move returned.
    expect(second?.ifUpdatedAt).not.toBe(first?.ifUpdatedAt);
    await waitFor(() => expect(keysIn(/^Todo/)).toEqual(['PAY-2', 'PAY-3']));
    await waitFor(() => expect(toast()).toHaveTextContent('Moved PAY-2 back to Todo'));
    await waitFor(() => expect(api.current?.tasks.find((task) => task.key === 'PAY-2')?.status).toBe('todo'));
  });

  it('warns before moving a card with open criteria to In review; Cancel leaves it in place', async () => {
    api.current = createFakeBoardApi({ criteria: { 'PAY-5': { settled: 1, open: 2, waived: 0, total: 3 } } });
    setDisplay({ orderBy: 'manual' });
    const user = userEvent.setup();
    renderBoard();
    await screen.findByText('Card 4');
    await user.keyboard('j{ArrowRight}{ArrowRight}{ArrowDown}');
    await waitFor(() => expect(focusedKey()).toBe('PAY-5'));

    await user.keyboard('{Shift>}{ArrowRight}{/Shift}');
    const dialog = await screen.findByRole('dialog', { name: '2 items are still open' });
    expect(dialog).toHaveTextContent('PAY-5 is moving to In review.');
    expect(
      within(dialog)
        .getAllByRole('checkbox')
        .map((item) => item.textContent),
    ).toEqual(['Criterion 2 of PAY-5', 'Criterion 3 of PAY-5']);
    // Nothing moved while the person decides.
    expect(api.current?.calls.update).toHaveLength(0);
    await user.keyboard('{Escape}');
    await waitFor(() => expect(screen.queryByRole('dialog', { name: /still open/ })).toBeNull());
    expect(keysIn(/^In progress/)).toEqual(['PAY-4', 'PAY-5']);
    expect(api.current?.calls.update).toHaveLength(0);
  });

  it('moves the card once the person moves it anyway, and moves a card without open items at once', async () => {
    api.current = createFakeBoardApi({ criteria: { 'PAY-5': { settled: 1, open: 2, waived: 0, total: 3 } } });
    setDisplay({ orderBy: 'manual' });
    const user = userEvent.setup();
    renderBoard();
    await screen.findByText('Card 4');
    await user.keyboard('j{ArrowRight}{ArrowRight}{ArrowDown}');
    await waitFor(() => expect(focusedKey()).toBe('PAY-5'));
    await user.keyboard('{Shift>}{ArrowRight}{/Shift}');
    const dialog = await screen.findByRole('dialog', { name: /still open/ });
    await user.click(within(dialog).getByRole('button', { name: /Move to In review/ }));
    await waitFor(() => expect(keysIn(/^In review/)).toContain('PAY-5'));
    await waitFor(() =>
      expect(api.current?.calls.update.at(-1)).toMatchObject({ key: 'PAY-5', status: 'in_review' }),
    );
    await waitFor(() => expect(focusedKey()).toBe('PAY-5'));

    // PAY-4 has no criteria: no question.
    await user.keyboard('{ArrowLeft}');
    await waitFor(() => expect(focusedKey()).toBe('PAY-4'));
    await user.keyboard('{Shift>}{ArrowRight}{/Shift}');
    expect(keysIn(/^In review/)).toContain('PAY-4');
    expect(screen.queryByRole('dialog', { name: /still open/ })).toBeNull();
  });

  it('sends no position when the columns follow priority order', async () => {
    const user = userEvent.setup();
    renderBoard();
    await screen.findByText('Card 4');
    await user.keyboard('j{ArrowRight}');
    await waitFor(() => expect(focusedKey()).toBe('PAY-3'));
    await user.keyboard('{Shift>}{ArrowRight}{/Shift}');
    await waitFor(() => expect(api.current?.calls.update).toHaveLength(1));
    expect(api.current?.calls.update[0]).toEqual({
      key: 'PAY-3',
      status: 'in_progress',
      ifUpdatedAt: '2026-10-20T10:00:03.000Z',
    });
    // Newest update first among equal priorities: the moved card leads its new column.
    expect(keysIn(/^In progress/)[0]).toBe('PAY-3');
  });

  it('reorders inside a column with Shift+J and Shift+K (manual order)', async () => {
    setDisplay({ orderBy: 'manual' });
    const user = userEvent.setup();
    renderBoard();
    await screen.findByText('Card 4');
    await user.keyboard('j{ArrowRight}{ArrowRight}');
    await waitFor(() => expect(focusedKey()).toBe('PAY-4'));

    await user.keyboard('{Shift>}J{/Shift}');
    expect(keysIn(/^In progress/)).toEqual(['PAY-5', 'PAY-4']);
    await waitFor(() => expect(api.current?.calls.update).toHaveLength(1));
    expect(api.current?.calls.update[0]).toMatchObject({ key: 'PAY-4', position: { after: 'PAY-5' } });
    expect(api.current?.calls.update[0]).not.toHaveProperty('status');

    // At the bottom of the column Shift+J does nothing; Shift+K moves it back up.
    await waitFor(() => expect(focusedKey()).toBe('PAY-4'));
    await user.keyboard('{Shift>}J{/Shift}');
    await user.keyboard('{Shift>}K{/Shift}');
    await waitFor(() => expect(api.current?.calls.update).toHaveLength(2));
    expect(api.current?.calls.update[1]).toMatchObject({ key: 'PAY-4', position: { before: 'PAY-5' } });
    await waitFor(() => expect(keysIn(/^In progress/)).toEqual(['PAY-4', 'PAY-5']));
  });

  it('rolls the card back and explains when someone else changed the task', async () => {
    setDisplay({ orderBy: 'manual' });
    const user = userEvent.setup();
    renderBoard();
    await screen.findByText('Card 4');
    await user.keyboard('j{ArrowRight}{ArrowRight}');
    await waitFor(() => expect(focusedKey()).toBe('PAY-4'));

    // Meanwhile someone moved PAY-4 to In review.
    if (api.current) api.current.control.changedBehindYourBack = { key: 'PAY-4', status: 'in_review' };
    await user.keyboard('{Shift>}{ArrowLeft}{/Shift}');

    const alert = await screen.findByRole('alert');
    expect(alert).toHaveTextContent("Couldn't move PAY-4 to Todo. It went back to In review.");
    expect(
      screen.getByText(
        'Someone else changed the task while you moved it. The board shows the latest version.',
      ),
    ).toBeInTheDocument();
    // The card shows where the server has it, and the move's toast is gone.
    await waitFor(() => expect(keysIn(/^Todo/)).toEqual(['PAY-2', 'PAY-3']));
    await waitFor(() => expect(keysIn(/^In review/)).toContain('PAY-4'));
    await waitFor(() => expect(toast()).toBeUndefined());

    // Try again sends the move with the current updatedAt and works.
    await user.click(within(alert).getByRole('button', { name: 'Try again' }));
    await waitFor(() => expect(api.current?.calls.update).toHaveLength(2));
    await waitFor(() => expect(keysIn(/^Todo/)).toEqual(['PAY-4', 'PAY-2', 'PAY-3']));
    expect(screen.queryByRole('alert')).not.toBeInTheDocument();
    await waitFor(() => expect(api.current?.tasks.find((task) => task.key === 'PAY-4')?.status).toBe('todo'));
  });

  it('opens a folded column when a card moves into it', async () => {
    setDisplay({ orderBy: 'manual', hideDoneAfterDays: 0 });
    const user = userEvent.setup();
    renderBoard();
    await screen.findByText('Card 4');
    await user.keyboard('j{ArrowRight}{ArrowRight}{ArrowRight}');
    await waitFor(() => expect(focusedKey()).toBe('PAY-6'));
    await user.keyboard('{Shift>}{ArrowRight}{/Shift}');
    expect(await screen.findByRole('region', { name: /^Done, 2 tasks$/ })).toBeInTheDocument();
    await waitFor(() => expect(keysIn(/^Done/)).toContain('PAY-6'));
  });

  it('loads 50 cards per column and the next page when J passes the last one', async () => {
    setDisplay({ orderBy: 'manual' });
    api.current = createFakeBoardApi({ layout: { todo: 52 } });
    const user = userEvent.setup();
    renderBoard();
    await screen.findByText('Card 50');
    expect(screen.queryByText('Card 51')).not.toBeInTheDocument();
    expect(screen.getByText('2 more · scroll or press J')).toBeInTheDocument();

    act(() => {
      (document.querySelector('[data-card-key="PAY-50"]') as HTMLElement).focus();
    });
    await user.keyboard('j');
    await waitFor(() => expect(focusedKey()).toBe('PAY-51'));
    expect(screen.queryByText(/more · scroll or press J/)).not.toBeInTheDocument();
  });

  it('groups cards into swimlanes by assignee and caps each cell', async () => {
    setDisplay({ swimlanes: 'assignee', orderBy: 'manual' });
    api.current = createFakeBoardApi({ layout: { todo: 9, in_progress: 1 } });
    const user = userEvent.setup();
    renderBoard();
    await screen.findByText('Card 1');
    const lanes = screen
      .getAllByRole('region')
      .map((region) => region.getAttribute('aria-label'))
      .filter((name) => name && /tasks$/.test(name));
    // The viewer's lane would come first; here: people, then agents, then nobody.
    expect(lanes).toEqual(['Tomás Berg, 3 tasks', 'claude-dev, 4 tasks', 'No assignee, 3 tasks']);
    const cell = screen.getByRole('grid', { name: 'Todo, claude-dev' });
    expect(within(cell).getAllByRole('row')).toHaveLength(2);
    await user.click(screen.getByRole('button', { name: 'Show 1 more in Todo, claude-dev' }));
    expect(within(screen.getByRole('grid', { name: 'Todo, claude-dev' })).getAllByRole('row')).toHaveLength(
      3,
    );
  });

  it('hides subtasks under their parent card, which expands in place', async () => {
    api.current = createFakeBoardApi({ subtasks: { parent: 'PAY-4', count: 3, done: 1 } });
    const user = userEvent.setup();
    renderBoard();
    await screen.findByText('Card 4');
    expect(screen.queryByText('Subtask 1')).not.toBeInTheDocument();
    const toggle = screen.getByRole('button', { name: 'Show the 3 subtasks of PAY-4, 1 done' });
    expect(toggle).toHaveTextContent('3 subtasks · 1 done');
    await user.click(toggle);
    expect(await screen.findByRole('button', { name: /Subtask 1, Done/ })).toBeInTheDocument();
    expect(screen.getByRole('button', { name: /Subtask 3, Todo/ })).toBeInTheDocument();
    expect(api.current?.calls.list.some((input) => input.parent === 'PAY-4')).toBe(true);
  });

  it('shows subtasks as their own cards with the parent above the title', async () => {
    setDisplay({ boardSubtasks: 'cards' });
    api.current = createFakeBoardApi({ subtasks: { parent: 'PAY-4', count: 2, done: 1 } });
    renderBoard();
    await screen.findByText('Subtask 2');
    const card = screen.getByText('Subtask 2').closest('[data-card-key]') as HTMLElement;
    expect(card).toHaveTextContent('↳Subtask of PAY-4 Card 4');
    expect(api.current?.calls.list.at(-1)).not.toHaveProperty('topLevel');
    // The parent shows its progress on the meta line instead of the toggle.
    expect(screen.getByRole('img', { name: '1 of 2 subtasks done' })).toBeInTheDocument();
  });

  it('groups columns by priority and changes the priority with Shift+→', async () => {
    setDisplay({ groupBy: 'priority' });
    api.current = createFakeBoardApi({ layout: { todo: 2 } });
    const pay1 = api.current.tasks.find((task) => task.key === 'PAY-1');
    if (pay1) pay1.priority = 'high';
    const user = userEvent.setup();
    renderBoard();
    await screen.findByText('Card 2');
    expect(keysIn(/^High, 1 tasks$/)).toEqual(['PAY-1']);
    expect(keysIn(/^Medium, 1 tasks$/)).toEqual(['PAY-2']);
    await user.keyboard('j');
    await waitFor(() => expect(focusedKey()).toBe('PAY-1'));
    await user.keyboard('{Shift>}{ArrowRight}{/Shift}');
    await waitFor(() => expect(api.current?.calls.update).toHaveLength(1));
    expect(api.current?.calls.update[0]).toMatchObject({ key: 'PAY-1', priority: 'medium' });
    await waitFor(() => expect(toast()).toHaveTextContent('Set PAY-1 to Medium priority'));
  });

  it("opens quick create with the column's status from its +", async () => {
    const user = userEvent.setup();
    renderBoard('/w/acme/p/PAY?view=board', { quickCreate: true });
    await screen.findByText('Card 4');
    const probe = screen.getByLabelText('Quick create');
    expect(probe).toHaveTextContent('closed');

    await user.click(screen.getByRole('button', { name: 'New task in In progress' }));
    expect(probe).toHaveTextContent('PAY in_progress');

    // The header's New task opens it without a status.
    await user.click(screen.getByRole('button', { name: /^New task(?! in)/ }));
    expect(probe).toHaveTextContent('PAY default');
  });

  it('shows the empty state when nothing matches the filters', async () => {
    renderBoard('/w/acme/p/PAY?view=board&assignee=agents&cycle=12');
    expect(await screen.findByRole('heading', { name: 'No tasks match these filters' })).toBeInTheDocument();
    expect(screen.getByRole('toolbar', { name: 'Filters' })).toBeInTheDocument();
  });
});

describe('board of a project mirrored from Backlog.md', () => {
  beforeEach(() => {
    api.current = createFakeBoardApi({ mirrored: true });
  });

  it('explains instead of changing status with Shift+→, and still reorders with Shift+J', async () => {
    setDisplay({ orderBy: 'manual' });
    const user = userEvent.setup();
    renderBoard();
    await screen.findByText('Card 4');
    await user.keyboard('j{ArrowRight}');
    await waitFor(() => expect(focusedKey()).toBe('PAY-2'));

    await user.keyboard('{Shift>}{ArrowRight}{/Shift}');
    await waitFor(() =>
      expect(toast()).toHaveTextContent('PAY-2 stays in Todo: its status comes from Backlog.md.'),
    );
    expect(keysIn(/^Todo/)).toEqual(['PAY-2', 'PAY-3']);
    expect(api.current?.calls.update).toHaveLength(0);

    await user.keyboard('{Shift>}J{/Shift}');
    await waitFor(() => expect(api.current?.calls.update).toHaveLength(1));
    expect(api.current?.calls.update[0]).toMatchObject({ key: 'PAY-2', position: { after: 'PAY-3' } });
    expect(api.current?.calls.update[0]).not.toHaveProperty('status');
    await waitFor(() => expect(keysIn(/^Todo/)).toEqual(['PAY-3', 'PAY-2']));
  });

  it('shows a New task that does not create, and no + on the columns', async () => {
    const user = userEvent.setup();
    renderBoard('/w/acme/p/PAY?view=board', { quickCreate: true });
    await screen.findByText('Card 4');
    expect(screen.queryByRole('button', { name: 'New task in In progress' })).not.toBeInTheDocument();
    const create = screen.getByRole('button', { name: /^New/ });
    expect(create).toHaveAttribute('aria-disabled', 'true');
    // Keyboard focus opens the tooltip (React Aria shows it for keyboard focus at once).
    await user.tab();
    act(() => create.focus());
    expect(await screen.findByRole('tooltip')).toHaveTextContent(
      'Tasks in Payments come from Backlog.md. Add a file under backlog/tasks/, or run backlog task create, and push. It shows up here after the next refresh.',
    );
  });
});
