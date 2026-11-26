import { QueryClientProvider } from '@tanstack/react-query';
import {
  createMemoryHistory,
  createRootRoute,
  createRoute,
  createRouter,
  Outlet,
  RouterProvider,
} from '@tanstack/react-router';
import { act, render, screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import type { TaskListItem } from '@zamu/contracts';
import { afterEach, describe, expect, it } from 'vitest';
import { closePeek, isPeekOpen } from '~/features/peek/store';
import { type DisplayOptions, defaultDisplayOptions, readTaskNavigation } from '~/features/views';
import { fakeViewsClient, newQueryClient } from '~/features/views/testing';
import { testWorkspace } from '~/lib/testing';
import { WorkspaceProvider } from '~/lib/workspace';
import { UIProvider } from '~/ui';
import { PlanningTaskTable, planningGroupBy, visibleKeys } from './PlanningTaskTable';

/** The test workspace (/w/acme) around the fake client. */
const workspace = (() => {
  // The views' fake procedures, and a rejecting stub for anything else (task writes, projects).
  const never = () => Promise.reject(new Error('not in these tests'));
  const stub = new Proxy({}, { get: () => never });
  const client = new Proxy(fakeViewsClient as Record<string, unknown>, {
    get: (target, key) => (typeof key === 'string' && key in target ? target[key] : stub),
  });
  return testWorkspace(client);
})();

// The Margin rows of the milestone and cycle pages: groups, keys, peek and opening the task view.

const PROJECT = { id: '00000000-0000-7000-8000-000000000001', key: 'PAY', name: 'Payments' };

function task(number: number, partial: Partial<TaskListItem> = {}): TaskListItem {
  return {
    id: `00000000-0000-7000-9000-${String(number).padStart(12, '0')}`,
    key: `PAY-${number}`,
    number,
    project: PROJECT,
    title: `Task ${number}`,
    status: 'todo',
    priority: 'medium',
    assignee: null,
    milestone: null,
    cycle: null,
    cycleAddedAt: null,
    rank: number,
    labels: [],
    dueDate: null,
    blocked: false,
    createdAt: '2026-10-01T10:00:00.000Z',
    updatedAt: '2026-10-01T10:00:00.000Z',
    ...partial,
  };
}

// Groups: In progress PAY-1; Todo PAY-2, PAY-3; Done PAY-4 (folded).
const TASKS = [
  task(1, { status: 'in_progress', title: 'Offline cache', blocked: true }),
  task(2, { priority: 'urgent', labels: [{ id: 'l1', name: 'mobile', color: 3 } as never] }),
  task(3),
  task(4, { status: 'done' }),
];

function renderTable(
  tasks: readonly TaskListItem[] = TASKS,
  display: DisplayOptions = defaultDisplayOptions('list'),
) {
  const root = createRootRoute({
    component: () => (
      <UIProvider>
        <Outlet />
      </UIProvider>
    ),
  });
  const cycle = createRoute({
    getParentRoute: () => root,
    path: '/w/$workspace/p/$projectKey/cycles/$cycleNumber',
    component: () => (
      <PlanningTaskTable
        aria-label="Tasks in Cycle 12"
        projectKey="PAY"
        tasks={tasks}
        display={display}
        from="Cycle 12"
        hide="cycle"
      />
    ),
  });
  const taskPage = createRoute({
    getParentRoute: () => root,
    path: '/w/$workspace/p/$projectKey/$taskKey',
    component: () => <p>Task page</p>,
  });
  const history = createMemoryHistory({ initialEntries: ['/w/acme/p/PAY/cycles/12?status=todo'] });
  const router = createRouter({ routeTree: root.addChildren([cycle, taskPage]), history });
  const { unmount } = render(
    <QueryClientProvider client={newQueryClient()}>
      <WorkspaceProvider workspace={workspace}>
        <RouterProvider router={router} />
      </WorkspaceProvider>
    </QueryClientProvider>,
  );
  return Object.assign(router, { unmount });
}

const row = (key: string) => document.querySelector(`li[data-key="${key}"]`) as HTMLElement | null;

afterEach(() => {
  closePeek();
  sessionStorage.clear();
});

describe('PlanningTaskTable', () => {
  it('groups by status in the list order with Done folded, and draws the row properties', async () => {
    renderTable();
    const region = await screen.findByRole('region', { name: 'Tasks in Cycle 12' });
    const groups = within(region).getAllByRole('button', { expanded: true });
    expect(groups.map((group) => group.textContent)).toEqual(['In progress1', 'Todo2']);
    expect(within(region).getByRole('button', { expanded: false })).toHaveTextContent('Done1');
    expect(row('PAY-4')).toBeNull();
    expect(row('PAY-1')).toHaveTextContent('Blocked');
    expect(row('PAY-2')).toHaveTextContent('mobile');
    expect(within(row('PAY-2') as HTMLElement).getByRole('img', { name: 'Priority: Urgent' })).toBeTruthy();

    await userEvent.setup().click(screen.getByRole('button', { name: /Done/ }));
    expect(row('PAY-4')).not.toBeNull();
  });

  it('draws the criteria marker after subtasks and before the due date once Criteria is on', async () => {
    const progress = { settled: 3, open: 2, waived: 1, total: 5 };
    const tasks = [
      task(1, {
        title: 'Retry payouts',
        dueDate: '2099-11-07',
        subtaskProgress: { done: 1, total: 4 },
        criteriaProgress: progress,
      }),
      task(2, { title: 'No criteria', criteriaProgress: { settled: 0, open: 0, waived: 0, total: 0 } }),
    ];
    const name = '2 of 5 criteria checked, 1 waived';
    const defaults = defaultDisplayOptions('list');
    const { unmount } = renderTable(tasks);
    await screen.findByRole('region', { name: 'Tasks in Cycle 12' });
    expect(row('PAY-1')).not.toBeNull();
    expect(screen.queryByRole('img', { name })).toBeNull();
    unmount();

    renderTable(tasks, { ...defaults, properties: { ...defaults.properties, criteria: true } });
    await screen.findByRole('region', { name: 'Tasks in Cycle 12' });
    const first = row('PAY-1') as HTMLElement;
    const mark = within(first).getByRole('img', { name });
    expect(mark).toHaveTextContent('2/5');
    const subtasks = within(first).getByRole('img', { name: '1 of 4 subtasks done' });
    const due = within(first).getByText(/Nov 7/);
    const follows = (a: Node, b: Node) =>
      Boolean(a.compareDocumentPosition(b) & Node.DOCUMENT_POSITION_FOLLOWING);
    expect(follows(subtasks, mark)).toBe(true);
    expect(follows(mark, due)).toBe(true);
    expect(within(row('PAY-2') as HTMLElement).queryByRole('img', { name: /criteria/ })).toBeNull();
  });

  it('moves with J / K, peeks with Space, opens with Enter and remembers the list', async () => {
    const user = userEvent.setup();
    const router = renderTable();
    await screen.findByRole('region', { name: 'Tasks in Cycle 12' });

    await user.keyboard('j');
    expect(row('PAY-1')).toHaveAttribute('data-focused');
    await user.keyboard('jj');
    expect(row('PAY-3')).toHaveAttribute('data-focused');
    await user.keyboard('j'); // Done is folded: stays on the last open row
    expect(row('PAY-3')).toHaveAttribute('data-focused');
    await user.keyboard('k');
    expect(row('PAY-2')).toHaveAttribute('data-focused');

    await user.keyboard(' ');
    expect(isPeekOpen()).toBe(true);
    await user.keyboard(' ');
    expect(isPeekOpen()).toBe(false);

    await user.keyboard('{Enter}');
    await screen.findByText('Task page');
    expect(router.state.location.pathname).toBe('/w/acme/p/PAY/PAY-2');
    expect(readTaskNavigation(workspace.id)).toEqual({
      keys: ['PAY-1', 'PAY-2', 'PAY-3'],
      from: 'Cycle 12',
      returnTo: '/w/acme/p/PAY/cycles/12?status=todo',
    });
  });

  it('selects with X and Shift+click, and opens on a plain click', async () => {
    const user = userEvent.setup();
    const router = renderTable();
    await screen.findByRole('region', { name: 'Tasks in Cycle 12' });
    await user.keyboard('jx');
    expect(row('PAY-1')).toHaveAttribute('data-selected');
    await user.keyboard('{Shift>}');
    await user.click(within(row('PAY-3') as HTMLElement).getByText('PAY-3'));
    await user.keyboard('{/Shift}');
    expect(row('PAY-2')).toHaveAttribute('data-selected');
    expect(row('PAY-3')).toHaveAttribute('data-selected');
    expect(router.state.location.pathname).toBe('/w/acme/p/PAY/cycles/12');

    await act(async () => {
      await user.click(screen.getByRole('link', { name: /Task 3/ }));
    });
    await waitFor(() => expect(router.state.location.pathname).toBe('/w/acme/p/PAY/PAY-3'));
    expect(readTaskNavigation(workspace.id)?.from).toBe('Cycle 12');
  });
});

describe('planning groups', () => {
  it('falls back to status when grouping by the page itself', () => {
    expect(planningGroupBy('cycle', 'cycle')).toBe('status');
    expect(planningGroupBy('milestone', 'cycle')).toBe('milestone');
    expect(planningGroupBy('label', undefined)).toBe('label');
  });

  it('lists the visible keys once, skipping folded groups', () => {
    const groups = [
      {
        key: 'a',
        label: 'A',
        value: { field: 'none' as const },
        tasks: [{ key: 'PAY-1' }, { key: 'PAY-2' }],
      },
      {
        key: 'b',
        label: 'B',
        value: { field: 'none' as const },
        tasks: [{ key: 'PAY-2' }, { key: 'PAY-3' }],
      },
      { key: 'c', label: 'C', value: { field: 'none' as const }, tasks: [{ key: 'PAY-4' }] },
    ];
    expect(visibleKeys(groups, new Set(['c']))).toEqual(['PAY-1', 'PAY-2', 'PAY-3']);
  });
});
