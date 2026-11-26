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
import { useMemo } from 'react';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { testWorkspace } from '~/lib/testing';
import { WorkspaceProvider } from '~/lib/workspace';
import { UIProvider, useHotkeys } from '~/ui';
import { CommandPalette } from './CommandPalette';
import { RECENT_LIMIT, rememberTask, resetRecentForTests } from './recent';
import {
  type Command,
  openPalette,
  resetPaletteForTests,
  usePaletteOpen,
  useRegisterCommands,
} from './registry';

// The ⌘K palette against a fake tasks.list, inside a real router so opening a task navigates.

configure({ asyncUtilTimeout: 3000 });

const api = vi.hoisted(() => ({
  queries: [] as string[],
  /** M7: searches for archived tasks (archived: 'only'), asked separately. */
  archivedQueries: [] as string[],
  tasks: [
    { key: 'HBR-166', title: 'Offline cache: browse every tab without a connection', status: 'in_progress' },
    { key: 'HBR-48', title: 'Cache exchange rates for offline use', status: 'todo' },
    { key: 'PAY-142', title: 'Retry failed payouts with exponential backoff', status: 'in_progress' },
    {
      key: 'PAY-118',
      title: 'Payout CSV export for accountants',
      status: 'done',
      archivedAt: '2026-11-12T10:00:00.000Z',
    },
    { key: 'PAY-150', title: 'Payout report export', status: 'done' },
    {
      key: 'PAY-97',
      title: 'Payout export to the old ledger',
      status: 'canceled',
      archivedAt: '2026-11-03T10:00:00.000Z',
    },
  ] as { key: string; title: string; status: string; archivedAt?: string }[],
}));

/** The test workspace (/w/acme) around the fake client. */
const workspace = (() => {
  const client = {
    tasks: {
      list: async (input: { q?: string; limit?: number; archived?: 'only' | 'include' }) => {
        (input.archived === 'only' ? api.archivedQueries : api.queries).push(input.q ?? '');
        const q = (input.q ?? '').toLowerCase();
        const words = q.split(/\s+/).filter(Boolean);
        // Like core, an unsorted mix: archived tasks are left out unless asked for.
        const items = api.tasks
          .filter((task) =>
            input.archived === 'only' ? task.archivedAt != null : task.archivedAt == null || input.archived,
          )
          .filter((task) =>
            words.every(
              (word) => task.key.toLowerCase().includes(word) || task.title.toLowerCase().includes(word),
            ),
          )
          .slice(0, input.limit ?? 50)
          .map((task) => ({
            ...task,
            project: {
              id: 'p',
              key: task.key.split('-')[0],
              name: task.key.startsWith('PAY') ? 'Payments' : 'Harbor',
            },
          }));
        return { items, nextCursor: null };
      },
    },
  };
  return testWorkspace(client);
})();

const ran = vi.hoisted(() => ({ calls: [] as string[] }));

function Commands({ commands }: { commands: readonly Command[] }) {
  useRegisterCommands(commands);
  return null;
}

function OpenState() {
  const mode = usePaletteOpen();
  return <output aria-label="palette state">{mode ? mode.kind : 'closed'}</output>;
}

function Shortcut() {
  useHotkeys({ 'Mod+k': () => openPalette() });
  return null;
}

function statusStep(): Command['run'] {
  return () => ({
    title: 'Set status',
    placeholder: 'Pick a status…',
    commands: ['Backlog', 'Todo', 'In progress', 'In review'].map((title, index) => ({
      id: `status.${title}`,
      title,
      section: 'task' as const,
      shortcut: String(index + 1),
      checked: title === 'In progress',
      run: () => {
        ran.calls.push(`status:${title}`);
      },
    })),
  });
}

function BaseCommands() {
  const commands = useMemo<Command[]>(
    () => [
      {
        id: 'navigate.home',
        title: 'Go to Home',
        section: 'navigate',
        shortcut: 'g h',
        run: () => {
          ran.calls.push('home');
        },
      },
      {
        id: 'navigate.project.PAY',
        title: 'Go to Payments',
        section: 'navigate',
        keywords: ['PAY'],
        hint: 'Project',
        run: () => {
          ran.calls.push('project:PAY');
        },
      },
      {
        id: 'navigate.project.HBR',
        title: 'Go to Harbor',
        section: 'navigate',
        keywords: ['HBR'],
        hint: 'Project',
        run: () => {
          ran.calls.push('project:HBR');
        },
      },
      {
        id: 'create.task',
        title: 'Create task',
        section: 'create',
        shortcut: 'c',
        run: () => {
          ran.calls.push('create');
        },
      },
    ],
    [],
  );
  return <Commands commands={commands} />;
}

function renderPalette(extra?: readonly Command[]) {
  const queryClient = new QueryClient({
    defaultOptions: { queries: { retry: false, refetchOnWindowFocus: false, refetchInterval: false } },
  });
  const root = createRootRoute({
    component: () => (
      <UIProvider>
        <Shortcut />
        <BaseCommands />
        {extra ? <Commands commands={extra} /> : null}
        <OpenState />
        <Outlet />
        <CommandPalette userId="u1" suggested={['create.task', 'navigate.home', 'navigate.project.PAY']} />
      </UIProvider>
    ),
  });
  const routes = [
    createRoute({ getParentRoute: () => root, path: '/', component: () => <p>home</p> }),
    createRoute({
      getParentRoute: () => root,
      path: '/w/$workspace/p/$projectKey/$taskKey',
      component: () => <p>task page</p>,
    }),
  ];
  const router = createRouter({
    routeTree: root.addChildren(routes),
    history: createMemoryHistory({ initialEntries: ['/'] }),
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

const input = () => screen.getByRole('combobox');
const options = () => within(screen.getByRole('listbox')).queryAllByRole('option');
const optionNames = () => options().map((option) => option.getAttribute('aria-label'));
const active = () => options().find((option) => option.getAttribute('aria-selected') === 'true');

beforeEach(() => {
  resetPaletteForTests();
  resetRecentForTests();
  window.localStorage.clear();
  api.queries = [];
  api.archivedQueries = [];
  ran.calls = [];
});

describe('command palette', () => {
  it('opens with ⌘K on an empty input with Recent and Suggested, first item highlighted', async () => {
    rememberTask('u1', {
      key: 'PAY-142',
      title: 'Retry failed payouts',
      status: 'in_progress',
      projectName: 'Payments',
    });
    rememberTask('u1', {
      key: 'HBR-164',
      title: 'Savings goals',
      status: 'in_progress',
      projectName: 'Harbor',
    });
    const user = userEvent.setup();
    renderPalette();
    await screen.findByText('home');
    await user.keyboard('{Control>}k{/Control}');
    const dialog = await screen.findByRole('dialog', { name: 'Command palette' });
    expect(input()).toHaveFocus();
    expect(input()).toHaveAttribute('placeholder', 'Type a command, or search tasks and projects…');
    expect(within(dialog).getByRole('group', { name: 'Recent' })).toBeInTheDocument();
    expect(optionNames()).toEqual([
      'HBR-164 Savings goals',
      'PAY-142 Retry failed payouts',
      'Create task',
      'Go to Home',
      'Go to Payments',
    ]);
    expect(active()).toHaveAttribute('aria-label', 'HBR-164 Savings goals');
    expect(input()).toHaveAttribute('aria-activedescendant', active()?.id);
    // Esc closes it.
    await user.keyboard('{Escape}');
    await waitFor(() => expect(screen.queryByRole('dialog')).not.toBeInTheDocument());
    expect(screen.getByLabelText('palette state')).toHaveTextContent('closed');
  });

  it('keeps the last five opened tasks, newest first', () => {
    for (let n = 1; n <= RECENT_LIMIT + 2; n++) {
      rememberTask('u1', { key: `PAY-${n}`, title: `Task ${n}`, status: 'todo', projectName: 'Payments' });
    }
    rememberTask('u1', { key: 'PAY-4', title: 'Task 4', status: 'todo', projectName: 'Payments' });
    const saved = JSON.parse(window.localStorage.getItem('zamu.palette.recent:u1') ?? '[]') as {
      key: string;
    }[];
    expect(saved.map((task) => task.key)).toEqual(['PAY-4', 'PAY-7', 'PAY-6', 'PAY-5', 'PAY-3']);
  });

  it('searches tasks by title through tasks.list with q, and opens the picked one', async () => {
    const user = userEvent.setup();
    const { router } = renderPalette();
    await screen.findByText('home');
    act(() => openPalette());
    await user.type(input(), 'offline');
    const tasks = await screen.findByRole('group', { name: 'Tasks' });
    expect(
      within(tasks)
        .getAllByRole('option')
        .map((option) => option.getAttribute('aria-label')),
    ).toEqual([
      'HBR-166 Offline cache: browse every tab without a connection',
      'HBR-48 Cache exchange rates for offline use',
    ]);
    // Debounced: one request for the whole word.
    expect(api.queries).toEqual(['offline']);
    expect(screen.getByText('2 tasks · 0 projects')).toBeInTheDocument();
    // The match is highlighted.
    expect(within(tasks).getAllByText('Offline')[0]?.tagName).toBe('MARK');
    // Typing on never leaves an older answer under Enter.
    await user.type(input(), ' rates');
    expect(optionNames()).toEqual(['HBR-48 Cache exchange rates for offline use']);
    await user.keyboard('{Backspace>6/}');
    await waitFor(() => expect(optionNames()).toHaveLength(2));
    await user.keyboard('{ArrowDown}{Enter}');
    await waitFor(() => expect(router.state.location.pathname).toBe('/w/acme/p/HBR/HBR-48'));
    expect(screen.queryByRole('dialog')).not.toBeInTheDocument();
  });

  it('offers the typed text to commands that take it: Create task “offline” under Actions, last', async () => {
    const user = userEvent.setup();
    renderPalette([
      {
        id: 'create.task',
        title: 'Create task',
        section: 'create',
        shortcut: 'c',
        run: () => {
          ran.calls.push('create');
        },
        withText: {
          title: (text) => `Create task “${text}”`,
          run: (text) => {
            ran.calls.push(`create:${text}`);
          },
        },
      },
    ]);
    await screen.findByText('home');
    act(() => openPalette());
    await user.type(input(), 'offline');
    const actions = await screen.findByRole('group', { name: 'Actions' });
    expect(within(actions).getByRole('option')).toHaveAccessibleName('Create task “offline”');
    // After the tasks, so Enter still opens the best match.
    expect(optionNames().at(-1)).toBe('Create task “offline”');
    await user.keyboard('{ArrowUp}{Enter}');
    expect(ran.calls).toEqual(['create:offline']);
    expect(screen.queryByRole('dialog')).not.toBeInTheDocument();
  });

  it('finds tasks by key and projects by name', async () => {
    const user = userEvent.setup();
    renderPalette();
    await screen.findByText('home');
    act(() => openPalette());
    await user.type(input(), 'pay');
    await screen.findByRole('group', { name: 'Tasks' });
    expect(optionNames()).toContain('PAY-142 Retry failed payouts with exponential backoff');
    expect(within(screen.getByRole('group', { name: 'Projects' })).getByRole('option')).toHaveAccessibleName(
      'Go to Payments',
    );
  });

  it('lists registered commands and runs them; disabled ones say why and do not run', async () => {
    const user = userEvent.setup();
    renderPalette([
      {
        id: 'task.assign-me',
        title: 'Assign to me',
        section: 'task',
        shortcut: 'i',
        context: 'PAY-142',
        run: () => {
          ran.calls.push('assign');
        },
      },
      {
        id: 'task.subtask',
        title: 'Add subtask',
        section: 'task',
        disabledReason: 'Read-only: mirrored from Backlog.md',
        run: () => {
          ran.calls.push('subtask');
        },
      },
    ]);
    await screen.findByText('home');
    act(() => openPalette());
    // The selection's actions come first, with the context pill and the footer note.
    expect(screen.getByTestId('palette-context')).toHaveTextContent('PAY-142');
    expect(screen.getByText('Actions apply to PAY-142')).toBeInTheDocument();
    expect(optionNames().slice(0, 2)).toEqual([
      'Assign to me',
      'Add subtask. Read-only: mirrored from Backlog.md',
    ]);
    await user.type(input(), 'subtask');
    await user.keyboard('{Enter}');
    expect(ran.calls).toEqual([]);
    expect(screen.getByRole('dialog')).toBeInTheDocument();
    await user.clear(input());
    await user.type(input(), 'assign');
    await user.keyboard('{Enter}');
    expect(ran.calls).toEqual(['assign']);
    await waitFor(() => expect(screen.queryByRole('dialog')).not.toBeInTheDocument());
  });

  it('runs a step: crumb, check on the current value, Backspace on the empty input backs out', async () => {
    const user = userEvent.setup();
    renderPalette([
      {
        id: 'task.status',
        title: 'Set status',
        section: 'task',
        shortcut: 's',
        context: 'HBR-146',
        run: statusStep(),
      },
    ]);
    await screen.findByText('home');
    act(() => openPalette());
    await user.type(input(), 'status');
    await user.keyboard('{Enter}');
    expect(await screen.findByText('Set status', { selector: 'span' })).toBeInTheDocument();
    expect(input()).toHaveValue('');
    expect(input()).toHaveAttribute('placeholder', 'Pick a status…');
    expect(optionNames()).toEqual(['Backlog', 'Todo', 'In progress', 'In review']);
    expect(screen.getByTestId('palette-context')).toHaveTextContent('HBR-146');
    expect(screen.getByText('back')).toBeInTheDocument();
    // Typing filters the step; Backspace with text only edits it.
    await user.type(input(), 'rev');
    expect(optionNames()).toEqual(['In review']);
    await user.keyboard('{Backspace}{Backspace}{Backspace}');
    expect(optionNames()).toHaveLength(4);
    // On the empty input it backs out to where the step started.
    await user.keyboard('{Backspace}');
    expect(input()).toHaveAttribute('placeholder', 'Type a command, or search tasks and projects…');
    expect(optionNames()).toContain('Set status');
    // Into the step again, and pick.
    await user.keyboard('{Enter}');
    await user.keyboard('{ArrowDown}{ArrowDown}{ArrowDown}{Enter}');
    expect(ran.calls).toEqual(['status:In review']);
    await waitFor(() => expect(screen.queryByRole('dialog')).not.toBeInTheDocument());
  });

  it('opens straight into a step, where a digit picks', async () => {
    const user = userEvent.setup();
    renderPalette();
    await screen.findByText('home');
    const step = statusStep()() as Exclude<ReturnType<Command['run']>, Promise<unknown> | undefined>;
    act(() => openPalette({ kind: 'step', step }));
    expect(optionNames()).toEqual(['Backlog', 'Todo', 'In progress', 'In review']);
    expect(input()).toHaveFocus();
    await user.keyboard('2');
    expect(ran.calls).toEqual(['status:Todo']);
    await waitFor(() => expect(screen.queryByRole('dialog')).not.toBeInTheDocument());
  });

  it('lists archived results last with the tag, and offers the project’s archived tasks', async () => {
    const user = userEvent.setup();
    renderPalette([
      {
        id: 'navigate.archived.PAY',
        title: 'Show archived tasks in Payments',
        section: 'navigate',
        keywords: ['archive', 'archived'],
        run: () => {
          ran.calls.push('archived:PAY');
        },
      },
    ]);
    await screen.findByText('home');
    act(() => openPalette());
    await user.type(input(), 'payout export');
    const tasks = await screen.findByRole('group', { name: 'Tasks' });
    await waitFor(() => expect(within(tasks).getAllByRole('option')).toHaveLength(3));
    // Live first, then archived (asked for separately), each archived one with its tag.
    expect(
      within(tasks)
        .getAllByRole('option')
        .map((option) => option.getAttribute('aria-label')),
    ).toEqual([
      'PAY-150 Payout report export',
      'PAY-118 Payout CSV export for accountants, archived',
      'PAY-97 Payout export to the old ledger, archived',
    ]);
    expect(api.archivedQueries).toEqual(['payout export']);
    const [live, first, second] = within(tasks).getAllByRole('option');
    expect(live?.querySelector('[data-part="archived-tag"]')).toBeNull();
    expect(first?.querySelector('[data-part="archived-tag"]')).toHaveTextContent('Archived');
    expect(second?.querySelector('[data-part="archived-tag"]')).toHaveTextContent('Archived');
    expect(screen.getByText('Archived tasks come last and carry the tag')).toBeInTheDocument();
    // Actions: the project's archived tasks, once.
    const actions = screen.getByRole('group', { name: 'Actions' });
    expect(
      within(actions).getByRole('option', { name: 'Show archived tasks in Payments' }),
    ).toBeInTheDocument();
    expect(screen.getAllByRole('option', { name: 'Show archived tasks in Payments' })).toHaveLength(1);
    await user.click(within(actions).getByRole('option', { name: 'Show archived tasks in Payments' }));
    expect(ran.calls).toEqual(['archived:PAY']);
  });

  it('G then P mode lists only projects, and Backspace widens it to everything', async () => {
    const user = userEvent.setup();
    renderPalette();
    await screen.findByText('home');
    act(() => openPalette({ kind: 'projects' }));
    expect(input()).toHaveAttribute('placeholder', 'Jump to a project…');
    expect(optionNames()).toEqual(['Go to Payments', 'Go to Harbor']);
    await user.type(input(), 'harb');
    expect(optionNames()).toEqual(['Go to Harbor']);
    await user.clear(input());
    await user.keyboard('{Backspace}');
    expect(input()).toHaveAttribute('placeholder', 'Type a command, or search tasks and projects…');
    await user.type(input(), 'harb');
    await user.keyboard('{Enter}');
    expect(ran.calls).toEqual(['project:HBR']);
  });
});
