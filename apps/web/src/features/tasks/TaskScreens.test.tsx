import { ORPCError } from '@orpc/client';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import {
  createMemoryHistory,
  createRootRoute,
  createRoute,
  createRouter,
  Outlet,
  RouterProvider,
  redirect,
} from '@tanstack/react-router';
import { act, configure, render, screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { closePeek, usePeek } from '~/features/peek/store';
import { PageSearchProvider, useFocusPageSearch } from '~/features/shell/page-search';
import { QuickCreateProvider, useQuickCreate } from '~/features/shell/quick-create';
import { readTaskNavigation } from '~/features/views';
import { displayStorageKey, resetDisplayOptionsForTests } from '~/features/views/useDisplayOptions';
import { testWorkspace } from '~/lib/testing';
import { WorkspaceProvider } from '~/lib/workspace';
import { UIProvider, useHotkeys } from '~/ui';
import { createFakeApi, FAKE_PEOPLE, type FakeApi } from './fake-api';
import { parseTaskListSearch, taskLinkRedirect } from './search';
import { TaskListScreen } from './TaskListScreen';

// Component tests of the project list (M5-11) against an in-memory /api/v1 client, inside a real TanStack
// router (memory history), so filters, ?focus= and the redirect of old ?task= links go through the URL.
// The task view and quick create are stand-ins: their own tests cover them.

configure({ asyncUtilTimeout: 5000 });
vi.setConfig({ testTimeout: 30_000 });

const api = vi.hoisted(() => ({ current: null as FakeApi | null }));

/** The test workspace (/w/acme) around the fake client. */
const workspace = (() => {
  // Forwards every call to the current test's fake, so each test gets fresh data.
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

/** The shell binds / to the page search; the tests stand in for it. */
function SlashFocusesSearch() {
  const focus = useFocusPageSearch();
  useHotkeys({ '/': () => focus() });
  return null;
}

/** What quick create was asked for (the dialog has its own tests). */
function QuickCreateProbe() {
  const quickCreate = useQuickCreate();
  return (
    <output data-testid="quick-create">
      {quickCreate.isOpen
        ? `open ${quickCreate.projectKey ?? ''} ${quickCreate.status ?? ''}`.trim()
        : 'closed'}
    </output>
  );
}

/** The peek's request (PeekHost, the real component, is the task view workstream's). */
function PeekProbe() {
  const peek = usePeek();
  return (
    <output data-testid="peek">{peek ? `${peek.key} of ${peek.keys.length} in ${peek.from}` : ''}</output>
  );
}

function renderApp(url: string) {
  const queryClient = new QueryClient({
    defaultOptions: { queries: { retry: false, refetchOnWindowFocus: false, refetchInterval: false } },
  });
  const root = createRootRoute({
    component: () => (
      <UIProvider>
        <PageSearchProvider>
          <QuickCreateProvider>
            <SlashFocusesSearch />
            <QuickCreateProbe />
            <PeekProbe />
            <Outlet />
          </QuickCreateProvider>
        </PageSearchProvider>
      </UIProvider>
    ),
  });
  const list = createRoute({
    getParentRoute: () => root,
    path: '/w/$workspace/p/$projectKey/',
    validateSearch: parseTaskListSearch,
    beforeLoad: ({ params, search }) => {
      const target = taskLinkRedirect(workspace.slug, params.projectKey, search);
      if (target) throw redirect({ ...target, replace: true });
    },
    component: function ListRoute() {
      const { projectKey } = list.useParams();
      return <TaskListScreen projectKey={projectKey} search={list.useSearch()} />;
    },
  });
  const page = createRoute({
    getParentRoute: () => root,
    path: '/w/$workspace/p/$projectKey/$taskKey',
    component: function PageRoute() {
      const { taskKey } = page.useParams();
      return <h1>Task view {taskKey}</h1>;
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
  return { router, queryClient };
}

type Router = ReturnType<typeof renderApp>['router'];
const searchOf = (router: Router) => router.state.location.search as Record<string, unknown>;
const row = (key: string) => screen.getByRole('row', { name: new RegExp(`^${key}\\b`) });
const findRow = (key: string) => screen.findByRole('row', { name: new RegExp(`^${key}\\b`) });
const groupRows = () =>
  screen
    .getAllByRole('row')
    .filter((element) => element.hasAttribute('data-group-row'))
    .map((element) => element.textContent);
const group = (name: string) =>
  screen
    .getAllByRole('row')
    .find(
      (element) => element.hasAttribute('data-group-row') && element.textContent?.startsWith(name),
    ) as HTMLElement;
const isCursor = (element: HTMLElement) => element.hasAttribute('data-cursor');
const lastListCall = () => fake().calls.list.at(-1) as Record<string, unknown>;

beforeEach(() => {
  api.current = createFakeApi({ fields: true });
  localStorage.clear();
  sessionStorage.clear();
  resetDisplayOptionsForTests();
});

afterEach(() => closePeek());

// Fake PAY: PAY-1 in progress (claude-dev, labels backend and payouts, due in 2 days, parent of PAY-5),
// PAY-2 in review (Tomás, high, blocked by PAY-3), PAY-3 todo (low), PAY-4 todo (claude-dev, urgent),
// PAY-5 backlog (Tomás, medium, subtask of PAY-1), PAY-6 done. The viewer is Ana Ruiz.

describe('list rows and groups', () => {
  it('groups by status with Backlog and Done folded, rows show their properties', async () => {
    const user = userEvent.setup();
    renderApp('/w/acme/p/PAY');
    await findRow('PAY-1');

    expect(groupRows()).toEqual([
      'In progress1, expanded',
      'In review1, expanded',
      'Todo2, expanded',
      'Backlog1, collapsed',
      'Done1, collapsed',
    ]);
    // Urgent first in Todo (priority order).
    const keys = screen
      .getAllByRole('row')
      .map((element) => element.getAttribute('data-task-key'))
      .filter(Boolean);
    expect(keys).toEqual(['PAY-1', 'PAY-2', 'PAY-4', 'PAY-3']);

    const pay1 = row('PAY-1');
    expect(within(pay1).getByText('backend')).toBeInTheDocument();
    expect(within(pay1).getByText('payouts')).toBeInTheDocument();
    expect(within(pay1).getByRole('img', { name: '0 of 1 subtasks done' })).toBeInTheDocument();
    expect(pay1.querySelector('[data-due="soon"]')).not.toBeNull();
    // claude-dev's avatar shows (not the viewer's); PAY-3 has no one, so no avatar.
    expect(within(pay1).getByRole('img', { name: /claude-dev/ })).toBeInTheDocument();
    expect(within(row('PAY-2')).getByText('Blocked')).toBeInTheDocument();
    // Priority shows for urgent and high only.
    expect(within(row('PAY-4')).getByRole('img', { name: 'Priority: Urgent' })).toBeInTheDocument();
    expect(within(row('PAY-3')).queryByRole('img', { name: /Priority/ })).toBeNull();

    // Unfolding Backlog loads it; PAY-5 nests under its parent.
    await user.click(within(group('Backlog')).getByText('Backlog'));
    const pay5 = await findRow('PAY-5');
    expect(pay5).toHaveAttribute('aria-level', '3');
    expect(row('PAY-1')).toHaveAttribute('aria-level', '2');
    const order = screen
      .getAllByRole('row')
      .map((element) => element.getAttribute('data-task-key'))
      .filter(Boolean);
    expect(order.slice(0, 2)).toEqual(['PAY-1', 'PAY-5']);
    expect(lastListCall()).toMatchObject({ project: ['PAY'], status: ['backlog'] });
  });

  it('groups by label from the display options, a task in each of its label groups', async () => {
    localStorage.setItem(
      displayStorageKey(workspace.id, FAKE_PEOPLE.ana.id, 'PAY', 'list'),
      JSON.stringify({ groupBy: 'label', listSubtasks: 'flat' }),
    );
    renderApp('/w/acme/p/PAY');
    await waitFor(() => expect(groupRows()[0]).toMatch(/^backend1/));
    expect(groupRows()).toEqual(['backend1, expanded', 'payouts1, expanded', 'No labels5, expanded']);
    // PAY-1 shows twice (backend and payouts); every other task is under No labels.
    expect(screen.getAllByRole('row', { name: /^PAY-1\b/ })).toHaveLength(2);
    // Every status loads at once (no folded groups), ordered by priority.
    expect(lastListCall()).toMatchObject({ project: ['PAY'], sort: 'priority' });
    expect(lastListCall().status).toBeUndefined();
  });

  it('renders only the rows in view of a long list, and still reaches the last one', async () => {
    api.current = createFakeApi({ tasks: 600 });
    const user = userEvent.setup();
    renderApp('/w/acme/p/PAY');
    const grid = await screen.findByRole('treegrid');
    const total = Number(grid.getAttribute('aria-rowcount'));
    expect(total).toBeGreaterThan(300);
    expect(screen.getAllByRole('row').length).toBeLessThan(120);

    // K from nothing goes to the last task row, which renders although it is far below.
    await user.keyboard('k');
    const last = screen.getAllByRole('row').find(isCursor) as HTMLElement;
    expect(last).toHaveFocus();
    // The rows after it are the folded Backlog and Done group rows.
    expect(Number(last.getAttribute('aria-rowindex'))).toBe(total - 2);
    expect(last).toHaveAttribute('data-task-key');
  });
});

describe('keyboard', () => {
  it('moves with J/K, opens with Enter (remembering the list) and peeks with Space', async () => {
    const user = userEvent.setup();
    const { router } = renderApp('/w/acme/p/PAY');
    await findRow('PAY-1');

    // J from the page puts the cursor and focus on the first task.
    await user.keyboard('j');
    expect(row('PAY-1')).toHaveFocus();
    expect(isCursor(row('PAY-1'))).toBe(true);
    await user.keyboard('j');
    expect(row('PAY-2')).toHaveFocus();
    await user.keyboard('jk');
    expect(row('PAY-2')).toHaveFocus();
    expect(isCursor(row('PAY-1'))).toBe(false);

    // Quick presses move one row each, and stop at the last task.
    await user.keyboard('jjjkkj');
    expect(row('PAY-4')).toHaveFocus();

    // Space peeks the cursor task with the list's keys.
    await user.keyboard(' ');
    expect(screen.getByTestId('peek')).toHaveTextContent('PAY-4 of 4 in List');

    act(() => closePeek());
    await user.keyboard('{Enter}');
    await waitFor(() => expect(router.state.location.pathname).toBe('/w/acme/p/PAY/PAY-4'));
    expect(readTaskNavigation(workspace.id)).toMatchObject({
      keys: ['PAY-1', 'PAY-2', 'PAY-4', 'PAY-3'],
      from: 'List',
    });
    expect(await screen.findByRole('heading', { name: 'Task view PAY-4' })).toBeInTheDocument();
  });

  it('comes back from the task view with the task focused (?focus=), then drops the param', async () => {
    const { router } = renderApp('/w/acme/p/PAY?focus=PAY-3');
    await findRow('PAY-3');
    await waitFor(() => expect(row('PAY-3')).toHaveFocus());
    expect(isCursor(row('PAY-3'))).toBe(true);
    await waitFor(() => expect(searchOf(router).focus).toBeUndefined());
  });

  it('sends old ?task= links to the task view', async () => {
    const { router } = renderApp('/w/acme/p/PAY?task=PAY-3');
    await waitFor(() => expect(router.state.location.pathname).toBe('/w/acme/p/PAY/PAY-3'));
  });

  it('moves with the arrow keys over group rows, and folds groups with Left and Right (PM-3)', async () => {
    // Order: PAY-1 (in progress), PAY-2 (in review), PAY-4, PAY-3 (todo); Backlog and Done folded.
    const user = userEvent.setup();
    renderApp('/w/acme/p/PAY?focus=PAY-2');
    await findRow('PAY-2');
    await waitFor(() => expect(row('PAY-2')).toHaveFocus());

    await user.keyboard('{ArrowDown}'); // over the Todo group row
    expect(row('PAY-4')).toHaveFocus();
    await user.keyboard('{ArrowUp}{ArrowUp}{ArrowUp}'); // PAY-2, PAY-1, then stays
    expect(row('PAY-1')).toHaveFocus();

    // Left folds the task's group and puts the cursor on the group row.
    await user.keyboard('{ArrowLeft}');
    expect(group('In progress')).toHaveFocus();
    expect(group('In progress')).toHaveAttribute('aria-expanded', 'false');
    expect(screen.queryByRole('row', { name: /^PAY-1\b/ })).not.toBeInTheDocument();
    await user.keyboard('{ArrowLeft}'); // folded already: nothing
    expect(group('In progress')).toHaveFocus();
    // Down from a group row goes to the next task; Right unfolds onto the first task.
    await user.keyboard('{ArrowRight}');
    expect(group('In progress')).toHaveAttribute('aria-expanded', 'true');
    await waitFor(() => expect(row('PAY-1')).toHaveFocus());

    // A lazily loaded group: Right loads its tasks and focuses the first one.
    await user.click(within(group('Done')).getByText('Done'));
    expect(group('Done')).toHaveFocus();
    await user.keyboard('{ArrowRight}');
    await waitFor(() => expect(row('PAY-6')).toHaveFocus());
    await user.keyboard('{ArrowUp}'); // over the Done and Backlog group rows to the last Todo task
    expect(row('PAY-3')).toHaveFocus();
  });

  it('focuses the search with / and filters by the typed text', async () => {
    const user = userEvent.setup();
    const { router } = renderApp('/w/acme/p/PAY');
    await findRow('PAY-1');

    await user.keyboard('/');
    expect(screen.getByRole('searchbox', { name: 'Search tasks' })).toHaveFocus();
    await user.keyboard('number 3');
    await waitFor(() => expect(searchOf(router).q).toBe('number 3'));
    await waitFor(() => expect(screen.queryByRole('row', { name: /^PAY-1\b/ })).not.toBeInTheDocument());
    expect(row('PAY-3')).toBeInTheDocument();
    // Enter goes from the search to the list.
    await user.keyboard('{Enter}');
    expect(row('PAY-3')).toHaveFocus();
  });
});

describe('selection and the action bar', () => {
  it('selects with X, Shift+↓ and ⌘A, shows the action bar for two or more, and clears with Esc', async () => {
    const user = userEvent.setup();
    renderApp('/w/acme/p/PAY');
    await findRow('PAY-1');

    await user.keyboard('jx');
    expect(row('PAY-1')).toHaveAttribute('aria-selected', 'true');
    // Every row shows its checkbox while anything is selected; one selected task has no bar.
    expect(within(row('PAY-3')).getByRole('checkbox', { name: 'Select PAY-3' })).not.toBeChecked();
    expect(screen.queryByRole('toolbar', { name: /selected/ })).toBeNull();

    await user.keyboard('{Shift>}{ArrowDown}{/Shift}');
    expect(row('PAY-2')).toHaveAttribute('aria-selected', 'true');
    const bar = screen.getByRole('toolbar', { name: '2 selected' });
    for (const name of ['Status', 'Assignee', 'Labels', 'Priority', 'Due']) {
      expect(within(bar).getByRole('button', { name: new RegExp(`^${name}`) })).toBeInTheDocument();
    }

    // Shift+click on a checkbox selects the range.
    await user.keyboard('{Shift>}');
    await user.click(within(row('PAY-3')).getByRole('checkbox'));
    await user.keyboard('{/Shift}');
    expect(screen.getByRole('toolbar', { name: '4 selected' })).toBeInTheDocument();

    await user.keyboard('{Escape}');
    expect(screen.queryByRole('toolbar', { name: /selected/ })).toBeNull();
    expect(screen.queryAllByRole('checkbox')).toHaveLength(0);

    await user.keyboard('{Control>}a{/Control}');
    expect(screen.getByRole('toolbar', { name: '4 selected' })).toBeInTheDocument();
  });

  it('changes the status of the selection from the action bar in one bulk request', async () => {
    const user = userEvent.setup();
    renderApp('/w/acme/p/PAY');
    await findRow('PAY-1');
    await user.keyboard('jx{Shift>}{ArrowDown}{/Shift}');
    const bar = screen.getByRole('toolbar', { name: '2 selected' });

    await user.click(within(bar).getByRole('button', { name: /^Status/ }));
    const dialog = await screen.findByRole('dialog', { name: 'Status' });
    await user.click(within(dialog).getByRole('menuitemradio', { name: /Done/ }));
    await waitFor(() => expect(fake().calls.bulk).toHaveLength(1));
    expect(fake().calls.bulk[0]).toMatchObject({ keys: ['PAY-1', 'PAY-2'], status: 'done' });
  });

  it('offers copy and Backlog.md links instead of field changes in a mirrored project', async () => {
    const api = fake();
    api.mirror.summary = {
      mode: 'mirror',
      state: 'healthy',
      defaultBranch: 'main',
      lastReadAt: new Date().toISOString(),
      lastReadCommit: 'e91b07fdeadbeef',
      lastTrigger: 'webhook',
      problems: { files: 0, values: 0 },
      hidden: 0,
      detachedAt: null,
    };
    for (const task of api.tasks) task.locked = ['title', 'status', 'priority', 'assignee'];
    const user = userEvent.setup();
    renderApp('/w/acme/p/PAY');
    await findRow('PAY-1');
    await user.keyboard('jx{Shift>}{ArrowDown}{/Shift}');
    const bar = await screen.findByRole('toolbar', { name: '2 selected' });
    expect(within(bar).getByRole('button', { name: /^Copy keys/ })).toBeInTheDocument();
    expect(within(bar).getByRole('button', { name: /^Copy links/ })).toBeInTheDocument();
    expect(within(bar).getByRole('button', { name: 'Open in Backlog.md' })).toBeInTheDocument();
    expect(within(bar).queryByRole('button', { name: /^Status/ })).toBeNull();
  });
});

describe('filters and states', () => {
  it('sends the whole filter to tasks.list and shows it as chips with a Clear', async () => {
    const user = userEvent.setup();
    const payouts = fake().labels.find((label) => label.name === 'payouts')?.id ?? '';
    const { router } = renderApp(`/w/acme/p/PAY?label=${payouts}&assignee=agents,none`);
    await findRow('PAY-1');
    expect(lastListCall()).toMatchObject({ label: [payouts], assignee: ['agents', 'none'] });
    expect(screen.queryByRole('row', { name: /^PAY-3\b/ })).toBeNull();

    const chips = screen.getByRole('toolbar', { name: 'Filters' });
    expect(within(chips).getByRole('button', { name: /^Labels is payouts/ })).toBeInTheDocument();
    expect(within(chips).getByText(/1 of \d+ tasks/)).toBeInTheDocument();

    await user.click(within(chips).getByRole('button', { name: 'Clear' }));
    await waitFor(() => expect(searchOf(router).label).toBeUndefined());
    expect(screen.queryByRole('toolbar', { name: 'Filters' })).toBeNull();
    expect(await findRow('PAY-3')).toBeInTheDocument();
  });

  it('says why nothing matches and clears the filters', async () => {
    const user = userEvent.setup();
    const { router } = renderApp('/w/acme/p/PAY?due=overdue&q=refund');
    expect(await screen.findByRole('heading', { name: 'No tasks match these filters' })).toBeInTheDocument();
    expect(
      screen.getByText(
        'Nothing in Payments is overdue and matches "refund". Remove a filter or clear them all.',
      ),
    ).toBeInTheDocument();
    await user.click(screen.getByRole('button', { name: 'Clear filters' }));
    await waitFor(() => expect(searchOf(router).q).toBeUndefined());
    expect(searchOf(router).due).toBeUndefined();
    expect(await findRow('PAY-1')).toBeInTheDocument();
  });

  it('shows the empty project with New task, and + on a group presets its status', async () => {
    api.current = createFakeApi({ tasks: 0 });
    const user = userEvent.setup();
    renderApp('/w/acme/p/PAY');
    expect(await screen.findByRole('heading', { name: 'No tasks in Payments yet' })).toBeInTheDocument();
    await user.click(screen.getAllByRole('button', { name: /^New task/ }).at(-1) as HTMLElement);
    expect(screen.getByTestId('quick-create')).toHaveTextContent('open PAY');
  });

  it('opens quick create in a group status from its +', async () => {
    const user = userEvent.setup();
    renderApp('/w/acme/p/PAY');
    await findRow('PAY-1');
    await user.click(screen.getByRole('button', { name: 'New task in In review' }));
    expect(screen.getByTestId('quick-create')).toHaveTextContent('open PAY in_review');
  });

  it('shows skeleton rows while loading and an error banner with Try again', async () => {
    const api = fake();
    const list = api.client.tasks.list;
    let release: () => void = () => {};
    const gate = new Promise<void>((resolve) => {
      release = resolve;
    });
    api.client.tasks.list = async () => {
      await gate;
      throw new ORPCError('INTERNAL_SERVER_ERROR', { data: { requestId: 'req_list1' } });
    };
    const user = userEvent.setup();
    renderApp('/w/acme/p/PAY');
    expect(await screen.findByRole('status', { name: 'Loading tasks' })).toBeInTheDocument();

    act(() => release());
    expect(await screen.findByRole('alert')).toHaveTextContent(
      'Couldn’t load tasks. The server ran into an error.',
    );
    expect(screen.getByText('req_list1')).toBeInTheDocument();
    api.client.tasks.list = list;
    await user.click(screen.getByRole('button', { name: 'Try again' }));
    expect(await findRow('PAY-1')).toBeInTheDocument();
  });
});
