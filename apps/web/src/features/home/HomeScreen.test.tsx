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
import type {
  GetHomeInput,
  Home,
  HomeAgent,
  HomeGroup,
  HomeItem,
  HomeTab,
  Me,
  TaskListItem,
  UserRef,
} from '@zamu/contracts';
import { HOME_GROUPS_BY_TAB } from '@zamu/contracts';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { closePeek, usePeek } from '~/features/peek/store';
import { readTaskNavigation } from '~/features/views';
import { testWorkspace } from '~/lib/testing';
import { WorkspaceProvider } from '~/lib/workspace';
import { UIProvider } from '~/ui';
import { HomeScreen } from './HomeScreen';
import { parseHomeSearch } from './search';

// Home against an in-memory /api/v1 client inside a real TanStack router, so the tab and the filter
// go through the URL.

configure({ asyncUtilTimeout: 5000 });
vi.setConfig({ testTimeout: 30_000 });

const api = vi.hoisted(() => ({ current: null as null | { client: unknown; calls: GetHomeInput[] } }));

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

// ---------------------------------------------------------------------------
// Fixtures
// ---------------------------------------------------------------------------

const MIN = 60_000;
// useNow() moves in 30-second steps: 45 seconds keep each time on the minute it names.
const ago = (ms: number) => new Date(Date.now() - ms - 45_000).toISOString();

const ANA: UserRef = { id: '00000000-0000-4000-8000-000000000001', name: 'Ana Ruiz', kind: 'person' };
const TOMAS: UserRef = { id: '00000000-0000-4000-8000-000000000002', name: 'Tomás Berg', kind: 'person' };
const CLAUDE = { id: '00000000-0000-4000-8000-000000000003', name: 'claude-dev', kind: 'agent' as const };
const PAY = { id: '10000000-0000-4000-8000-000000000001', key: 'PAY', name: 'Payments' };
const WEB = { id: '10000000-0000-4000-8000-000000000002', key: 'WEB', name: 'Website' };

let ids = 0;
function task(key: string, title: string, overrides: Partial<TaskListItem> = {}): TaskListItem {
  ids += 1;
  const project = key.startsWith('PAY') ? PAY : WEB;
  return {
    id: `20000000-0000-4000-8000-${String(ids).padStart(12, '0')}`,
    key,
    number: Number(key.split('-')[1]),
    project,
    title,
    status: 'todo',
    priority: 'medium',
    assignee: null,
    milestone: null,
    cycle: null,
    cycleAddedAt: null,
    rank: 'a',
    locked: [],
    hidden: false,
    hiddenAt: null,
    labels: [],
    dueDate: null,
    subtaskProgress: { done: 0, total: 0 },
    blocked: false,
    createdAt: ago(600 * MIN),
    updatedAt: ago(60 * MIN),
    ...overrides,
  } as TaskListItem;
}

const asAssignee = (user: UserRef, responsible: UserRef | null = null) => ({ ...user, responsible });

const REVIEW: HomeItem = {
  task: task('PAY-120', 'Idempotency keys for payouts', {
    status: 'in_review',
    priority: 'high',
    assignee: asAssignee(CLAUDE, ANA),
    // M6: four checked, one waived, one open.
    criteriaProgress: { settled: 5, open: 1, waived: 1, total: 6 },
  }),
  reason: { kind: 'review', requestedBy: CLAUDE, onBehalfOf: ANA, waitingOn: ANA, at: ago(40 * MIN) },
  relation: 'agent',
  pills: [{ kind: 'blocks', count: 2 }],
};
const MENTION: HomeItem = {
  task: task('PAY-142', 'Retry failed payouts with exponential backoff', {
    status: 'in_progress',
    assignee: asAssignee(CLAUDE, ANA),
    dueDate: '2026-10-31',
    criteriaProgress: { settled: 1, open: 1, waived: 0, total: 2 },
  }),
  reason: {
    kind: 'mention',
    author: TOMAS,
    onBehalfOf: null,
    mentioned: ANA,
    comment: { id: '30000000-0000-4000-8000-000000000001', excerpt: 'Can you check this?' },
    at: ago(25 * 60 * MIN),
  },
  relation: null,
  pills: [
    { kind: 'blocked' },
    { kind: 'overdue', daysOverdue: 3 },
    { kind: 'cycle', cycle: { number: 12, name: null } },
  ],
};
const BLOCKED: HomeItem = {
  task: task('WEB-193', 'Store release 1.22.0 with the offline cache', {
    assignee: asAssignee(ANA),
    blocked: true,
  }),
  reason: {
    kind: 'blocked',
    blockers: [{ key: 'WEB-166', title: 'Offline cache', status: 'in_progress', assignee: null }],
  },
  relation: 'assignee',
  pills: [],
};
const ASSIGNED: HomeItem = {
  task: task('WEB-13', 'Answer the open store-review questions', {
    assignee: asAssignee(ANA),
    priority: 'urgent',
  }),
  reason: { kind: 'assigned' },
  relation: 'assignee',
  pills: [],
};

function group(key: HomeGroup['key'], items: HomeItem[], total = items.length): HomeGroup {
  return { key, total, items };
}

const CLAUDE_CARD: HomeAgent = {
  agent: asAssignee(CLAUDE, ANA),
  state: 'working',
  currentTask: {
    key: 'WEB-146',
    title: 'Long labels clip on the home screen',
    status: 'in_progress',
    project: WEB,
    since: ago(22 * MIN),
  },
  counts: { assigned: 58, inReview: 6, blocked: 2, changesToday: 41 },
  recent: [
    {
      kind: 'activity',
      id: '7',
      task: { key: 'PAY-120', title: 'Idempotency keys', status: 'in_review', project: PAY },
      type: 'task.updated',
      changes: [{ field: 'status', from: 'in_progress', to: 'in_review' }],
      at: ago(120 * MIN),
    },
  ],
  lastActivityAt: ago(120 * MIN),
};

interface FakeOptions {
  /** A new workspace: no projects yet. */
  noProjects?: boolean;
  /** Mine with nothing waiting (frame 102). */
  clear?: boolean;
}

function homeFor(tab: HomeTab, options: FakeOptions): Home {
  const byTab: Record<HomeTab, HomeGroup[]> = {
    mine: options.clear
      ? [
          group('review', []),
          group('mentions', []),
          group('blocked', []),
          group('overdue', []),
          group('assigned', [ASSIGNED], 4),
        ]
      : [
          group('review', [REVIEW]),
          group('mentions', [MENTION]),
          group('blocked', [BLOCKED]),
          group('overdue', []),
          group('assigned', [ASSIGNED], 34),
        ],
    everyone: [
      group('review', [{ ...REVIEW, relation: null }]),
      group('blocked', [{ ...BLOCKED, relation: null }]),
      group('overdue', []),
      group('dueThisWeek', []),
    ],
    agents: [group('waiting', [{ ...REVIEW, relation: null }])],
  };
  const groups = byTab[tab];
  expect(groups.map((entry) => entry.key)).toEqual(HOME_GROUPS_BY_TAB[tab]);
  return {
    tab,
    generatedAt: new Date().toISOString(),
    counts: { mine: options.clear ? 0 : 3, everyone: 2, agents: 1 },
    deadlines:
      tab === 'agents'
        ? []
        : [
            {
              kind: 'cycle',
              project: PAY,
              cycle: { number: 12, name: null, startsOn: '2026-10-27', endsOn: '2026-11-09' },
              daysLeft: 7,
              progress: { done: 3, total: 9 },
            },
          ],
    groups,
    agents: tab === 'agents' ? [CLAUDE_CARD] : [],
  };
}

function createFake(options: FakeOptions = {}) {
  const calls: GetHomeInput[] = [];
  const me: Me = {
    user: { ...ANA, email: 'ana@example.com', responsible: null, theme: 'system' },
    workspace: { id: '40000000-0000-4000-8000-000000000001', name: 'Northwind Labs', slug: 'northwind' },
    role: 'owner',
    auth: { method: 'session', scope: null },
  } as Me;
  const client = {
    home: {
      get: async (input: GetHomeInput) => {
        calls.push(input);
        return homeFor(input.tab, options);
      },
      counts: async () => ({ review: 1, mentions: 1, blocked: 1, overdue: 0, total: 3 }),
    },
    me: { get: async () => me },
    members: { list: async () => ({ items: [] }) },
    projects: {
      list: async () => ({
        items: (options.noProjects ? [] : [PAY, WEB]).map((project) => ({
          ...project,
          description: null,
          usesMilestones: true,
          usesCycles: true,
          currentCycle: null,
          repository: null,
          createdAt: ago(0),
          updatedAt: ago(0),
          openCounts: { backlog: 0, todo: 0, in_progress: 0, in_review: 0 },
          openCount: 0,
          lastActivityAt: ago(0),
          assignees: [],
        })),
      }),
    },
    labels: {
      list: async ({ project }: { project: string }) => ({
        items: [
          {
            id: `${project === 'PAY' ? '5' : '6'}0000000-0000-4000-8000-000000000001`,
            name: 'backend',
            color: 3,
            source: 'app',
            usageCount: 2,
          },
        ],
      }),
    },
    milestones: { list: async () => ({ items: [] }) },
    cycles: { list: async () => ({ items: [] }) },
  };
  return { client, calls };
}

function PeekProbe() {
  const peek = usePeek();
  return <output aria-label="peek">{peek ? `${peek.key} from ${peek.from}` : 'closed'}</output>;
}

function renderHome(url = '/w/acme') {
  const queryClient = new QueryClient({
    defaultOptions: { queries: { retry: false, refetchOnWindowFocus: false, refetchInterval: false } },
  });
  const root = createRootRoute({
    component: () => (
      <UIProvider>
        <Outlet />
        <PeekProbe />
      </UIProvider>
    ),
  });
  const home = createRoute({
    getParentRoute: () => root,
    path: '/w/$workspace',
    validateSearch: parseHomeSearch,
    component: function HomeRoute() {
      return <HomeScreen search={home.useSearch()} />;
    },
  });
  const taskPage = createRoute({
    getParentRoute: () => root,
    path: '/w/$workspace/p/$projectKey/$taskKey',
    component: function TaskRoute() {
      return <p>task page {(taskPage.useParams() as { taskKey: string }).taskKey}</p>;
    },
  });
  const membersPage = createRoute({
    getParentRoute: () => root,
    path: '/w/$workspace/settings/members',
    component: () => <p>members page</p>,
  });
  const router = createRouter({
    routeTree: root.addChildren([home, taskPage, membersPage]),
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

const row = (key: string) => {
  const element = document.querySelector<HTMLElement>(`[data-task-key="${key}"]`);
  if (!element) throw new Error(`no row ${key}`);
  return element;
};

beforeEach(() => {
  api.current = createFake();
  sessionStorage.clear();
});

afterEach(() => {
  act(() => closePeek());
});

describe('Home', () => {
  it('shows Mine: deadlines, the groups in order, and each row with its pills and reason', async () => {
    renderHome();
    await screen.findByText('Idempotency keys for payouts');
    expect(screen.getByRole('tab', { name: /Mine/ })).toHaveAttribute('aria-selected', 'true');
    expect(screen.getByRole('tab', { name: /Everyone/ })).toHaveTextContent('Everyone2');
    expect(screen.getAllByRole('heading', { level: 2 }).map((heading) => heading.textContent)).toEqual([
      'Needs your review1Agents and teammates asked you to look',
      'Mentions1Unanswered',
      'Blocked1Your tasks waiting on another task',
      'Assigned to you34By due date, then priority',
    ]);
    const deadlines = screen.getByRole('region', { name: 'Deadlines' });
    expect(
      within(deadlines).getByRole('link', { name: /Cycle 12, ends Nov 9, in 6 days/ }),
    ).toBeInTheDocument();

    expect(row('PAY-120')).toHaveTextContent('blocks 2');
    // Needs review rows carry the criteria pill; rows of other groups don't.
    expect(row('PAY-120')).toHaveTextContent('4 of 6 criteria');
    expect(row('PAY-142')).not.toHaveTextContent(/criteri/);
    expect(row('WEB-193')).not.toHaveTextContent(/criteri/);
    expect(row('PAY-120')).toHaveTextContent(/claude-dev · 40 min ago/);
    expect(within(row('PAY-120')).getByRole('img', { name: 'claude-dev' })).toBeInTheDocument();
    expect(row('PAY-142')).toHaveTextContent('blocked');
    expect(row('PAY-142')).toHaveTextContent('3 d overdue');
    expect(row('PAY-142')).toHaveTextContent('in Cycle 12');
    expect(row('PAY-142')).toHaveTextContent('Tomás · 1 d ago');
    // The overdue pill says it: no due chip as well.
    expect(row('PAY-142').querySelector('[data-due]')).toBeNull();
    expect(row('WEB-193')).toHaveTextContent('by WEB-166');
    // Ana's own tasks carry no avatar on Mine.
    expect(within(row('WEB-193')).queryByRole('img', { name: 'Ana Ruiz' })).toBeNull();
    expect(
      screen.getByText('Showing 1 of 34. Filter by project or label to see the rest.'),
    ).toBeInTheDocument();
    expect(api.current?.calls[0]).toEqual({ tab: 'mine' });
  });

  it('switches tabs through the URL', async () => {
    const user = userEvent.setup();
    const { router } = renderHome();
    await screen.findByText('Idempotency keys for payouts');
    await user.click(screen.getByRole('tab', { name: /Everyone/ }));
    await waitFor(() => expect(router.state.location.search).toEqual({ tab: 'everyone' }));
    expect(await screen.findByRole('heading', { level: 1, name: 'Everyone' })).toBeInTheDocument();
    expect(screen.getByText('What needs attention across Northwind Labs')).toBeInTheDocument();
    expect(await screen.findByText(/Needs review/)).toBeInTheDocument();
    expect(row('PAY-120')).toHaveTextContent('waits on Ana');
    expect(row('PAY-120')).toHaveTextContent('4 of 6 criteria');
  });

  it('shows agent cards and what waits on a person on Agents, without deadlines', async () => {
    renderHome('/w/acme?tab=agents');
    const card = await screen.findByRole('article', { name: 'claude-dev' });
    expect(within(card).getByText('Working')).toBeInTheDocument();
    expect(within(card).getByText('acts for Ana')).toBeInTheDocument();
    expect(within(card).getByText('Long labels clip on the home screen')).toBeInTheDocument();
    expect(within(card).getByText('for 22 min')).toBeInTheDocument();
    expect(card).toHaveTextContent('58 assigned');
    expect(card).toHaveTextContent('41 changes today');
    expect(within(card).getByText('moved to In review')).toBeInTheDocument();
    expect(screen.getByText('What claude-dev is doing')).toBeInTheDocument();
    expect(screen.getByRole('heading', { level: 2, name: /Waiting on a person/ })).toBeInTheDocument();
    expect(row('PAY-120')).toHaveTextContent('review by Ana · 40 min ago');
    expect(screen.queryByRole('region', { name: 'Deadlines' })).toBeNull();
  });

  it('says all clear when nothing waits, and can still show the assigned tasks', async () => {
    api.current = createFake({ clear: true });
    const user = userEvent.setup();
    renderHome();
    expect(await screen.findByRole('heading', { name: 'All clear' })).toBeInTheDocument();
    expect(
      screen.getByText(
        'Nothing waits on you: no reviews, mentions, blocked or overdue work. Your 4 assigned tasks are on track.',
      ),
    ).toBeInTheDocument();
    await user.click(screen.getByRole('button', { name: 'See assigned tasks' }));
    expect(await screen.findByRole('heading', { level: 2, name: /Assigned to you/ })).toBeInTheDocument();
    expect(row('WEB-13')).toBeInTheDocument();
  });

  it('shows the first steps in a workspace without projects', async () => {
    api.current = createFake({ clear: true, noProjects: true });
    const user = userEvent.setup();
    const { router } = renderHome();
    expect(await screen.findByRole('heading', { name: 'Nothing to show yet' })).toBeInTheDocument();
    expect(screen.queryByRole('heading', { name: 'All clear' })).not.toBeInTheDocument();
    expect(screen.getByRole('heading', { name: 'Create a project' })).toBeInTheDocument();
    expect(screen.getByRole('button', { name: 'New project' })).toBeInTheDocument();
    // Ana owns the workspace, so she sees the agent step too.
    await user.click(screen.getByRole('button', { name: 'Open Members' }));
    await waitFor(() => expect(router.state.location.pathname).toBe('/w/acme/settings/members'));
  });

  it('moves with J / K, peeks with Space and opens the task view with Enter', async () => {
    const user = userEvent.setup();
    const { router } = renderHome();
    await screen.findByText('Idempotency keys for payouts');
    await user.keyboard('j');
    await waitFor(() => expect(row('PAY-120')).toHaveAttribute('data-focused', 'true'));
    await user.keyboard('j');
    await waitFor(() => expect(row('PAY-142')).toHaveAttribute('data-focused', 'true'));
    await user.keyboard('k');
    await waitFor(() => expect(row('PAY-120')).toHaveAttribute('data-focused', 'true'));

    await user.keyboard(' ');
    expect(screen.getByRole('status', { name: 'peek' })).toHaveTextContent('PAY-120 from Home');
    act(() => closePeek());

    await user.keyboard('x');
    expect(row('PAY-120')).toHaveAttribute('data-selected', 'true');

    await user.keyboard('{Enter}');
    expect(await screen.findByText('task page PAY-120')).toBeInTheDocument();
    expect(router.state.location.pathname).toBe('/w/acme/p/PAY/PAY-120');
    expect(readTaskNavigation(workspace.id)).toMatchObject({
      keys: ['PAY-120', 'PAY-142', 'WEB-193', 'WEB-13'],
      from: 'Home',
      returnTo: '/w/acme',
    });
  });

  it('opens a task on click and selects with Shift or ⌘ clicks', async () => {
    const user = userEvent.setup();
    renderHome();
    await screen.findByText('Idempotency keys for payouts');
    await user.keyboard('{Meta>}');
    await user.click(row('PAY-142'));
    await user.keyboard('{/Meta}');
    expect(row('PAY-142')).toHaveAttribute('data-selected', 'true');
    await user.click(row('WEB-193'));
    expect(await screen.findByText('task page WEB-193')).toBeInTheDocument();
  });

  it('reads the filter from the URL, sends it, and clears it from the chips', async () => {
    const user = userEvent.setup();
    const { router } = renderHome('/w/acme?project=PAY&label=backend&priority=high');
    await screen.findByText('Idempotency keys for payouts');
    expect(api.current?.calls[0]).toEqual({
      tab: 'mine',
      project: ['PAY'],
      label: ['backend'],
      priority: ['high'],
    });
    const chips = screen.getByRole('toolbar', { name: 'Filters' });
    expect(
      await within(chips).findByRole('button', { name: 'Project is Payments. Change' }),
    ).toBeInTheDocument();
    expect(within(chips).getByRole('button', { name: 'Labels is backend. Change' })).toBeInTheDocument();
    expect(within(chips).getByRole('button', { name: 'Priority is High. Change' })).toBeInTheDocument();
    await user.click(within(chips).getByRole('button', { name: 'Remove the project filter' }));
    await waitFor(() => expect(router.state.location.search).toEqual({ label: 'backend', priority: 'high' }));
    await user.click(
      within(screen.getByRole('toolbar', { name: 'Filters' })).getByRole('button', { name: 'Clear' }),
    );
    await waitFor(() => expect(router.state.location.search).toEqual({}));
    expect(screen.queryByRole('toolbar', { name: 'Filters' })).toBeNull();
  });

  it('filters the rows with the page search', async () => {
    const user = userEvent.setup();
    renderHome();
    await screen.findByText('Idempotency keys for payouts');
    await user.type(screen.getByRole('searchbox', { name: 'Search Home' }), 'offline');
    expect(screen.queryByText('Idempotency keys for payouts')).toBeNull();
    expect(row('WEB-193')).toBeInTheDocument();
  });
});
