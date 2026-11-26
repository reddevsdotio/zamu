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
import type { PullRequestLink, Task } from '@zamu/contracts';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { closePeek } from '~/features/peek/store';
import { PageSearchProvider } from '~/features/shell/page-search';
import { QuickCreateProvider } from '~/features/shell/quick-create';
import { resetFieldToastForTests, TaskFieldToast } from '~/features/task-fields/toast';
import { displayStorageKey, resetDisplayOptionsForTests } from '~/features/views/useDisplayOptions';
import { testWorkspace } from '~/lib/testing';
import { WorkspaceProvider } from '~/lib/workspace';
import { localToday, UIProvider } from '~/ui';
import { addDays } from '../task-fields/dates';
import { createFakeApi, FAKE_PEOPLE, FAKE_REPOSITORY, type FakeApi } from './fake-api';
import { hasFilters, parseTaskListSearch } from './search';
import { describeTaskFilter, TaskListScreen } from './TaskListScreen';

// The project list's M7 parts (frames 083 to 085, 101): the request marker and the check-again chip on
// rows, waiting rows dimmed or left out by "Waiting tasks", archived rows with a quiet title, the archive
// day and Restore, the Archived filter that keeps Backlog and Done open, Archive in the action bar with
// the "2 tasks archived" toast and Undo, and the search params and empty-state words of the two filters.

configure({ asyncUtilTimeout: 5000 });
vi.setConfig({ testTimeout: 30_000 });

const api = vi.hoisted(() => ({ current: null as FakeApi | null }));

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
  return testWorkspace(forward([]));
})();

const fake = () => api.current as FakeApi;
const task = (key: string) => fake().tasks.find((item) => item.key === key) as Task;

function renderList(url = '/w/acme/p/PAY') {
  const queryClient = new QueryClient({
    defaultOptions: { queries: { retry: false, refetchOnWindowFocus: false, refetchInterval: false } },
  });
  const root = createRootRoute({
    component: () => (
      <UIProvider>
        <PageSearchProvider>
          <QuickCreateProvider>
            <Outlet />
            <TaskFieldToast />
          </QuickCreateProvider>
        </PageSearchProvider>
      </UIProvider>
    ),
  });
  const list = createRoute({
    getParentRoute: () => root,
    path: '/w/$workspace/p/$projectKey/',
    validateSearch: parseTaskListSearch,
    component: function ListRoute() {
      const { projectKey } = list.useParams();
      return <TaskListScreen projectKey={projectKey} search={list.useSearch()} />;
    },
  });
  const page = createRoute({
    getParentRoute: () => root,
    path: '/w/$workspace/p/$projectKey/$taskKey',
    component: () => <h1>Task view</h1>,
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
  return router;
}

const row = (key: string) => screen.getByRole('row', { name: new RegExp(`^${key}\\b`) });
const findRow = (key: string) => screen.findByRole('row', { name: new RegExp(`^${key}\\b`) });
const queryRow = (key: string) => screen.queryByRole('row', { name: new RegExp(`^${key}\\b`) });
const groupRows = () =>
  screen
    .getAllByRole('row')
    .filter((element) => element.hasAttribute('data-group-row'))
    .map((element) => element.textContent);

function setDisplay(options: Record<string, unknown>) {
  localStorage.setItem(
    displayStorageKey(workspace.id, FAKE_PEOPLE.ana.id, 'PAY', 'list'),
    JSON.stringify(options),
  );
}

function request(number: number, extra: Partial<PullRequestLink> = {}): PullRequestLink {
  const at = new Date(Date.now() - 3_600_000).toISOString();
  return {
    provider: 'github',
    number,
    title: `Request ${number}`,
    url: `https://${FAKE_REPOSITORY}/pull/${number}`,
    state: 'open',
    headBranch: 'feat/x',
    baseBranch: 'main',
    author: null,
    mergedBy: null,
    how: 'branch',
    linkedBy: null,
    linkedAt: at,
    openedAt: at,
    mergedAt: null,
    closedAt: null,
    updatedAt: at,
    ...extra,
  };
}

beforeEach(() => {
  api.current = createFakeApi({ fields: true, repository: true });
  localStorage.clear();
  sessionStorage.clear();
  resetDisplayOptionsForTests();
  resetFieldToastForTests();
});

afterEach(() => closePeek());

// Fake PAY: PAY-1 in progress (labels, due in 2 days), PAY-2 in review, PAY-3 and PAY-4 todo, PAY-5
// backlog (a subtask of PAY-1), PAY-6 done.

describe('markers on rows (frame 101)', () => {
  it('puts the check-again chip after the labels and before the due date, and the request marker when on', async () => {
    task('PAY-1').checkAgain = { on: addDays(localToday(), 5), reason: 'Vendor fix' };
    task('PAY-1').pullRequests = [request(482)];
    renderList();
    const pay1 = await findRow('PAY-1');
    const chip = within(pay1).getByText(/^Waiting until /);
    const label = within(pay1).getByText('payouts');
    const due = pay1.querySelector('[data-due]') as HTMLElement;
    expect(label.compareDocumentPosition(chip) & Node.DOCUMENT_POSITION_FOLLOWING).toBeTruthy();
    expect(chip.compareDocumentPosition(due) & Node.DOCUMENT_POSITION_FOLLOWING).toBeTruthy();
    // The request marker is off by default.
    expect(pay1.querySelector('[data-part="request-marker"]')).toBeNull();
  });

  it('shows the request marker with the Pull request chip on', async () => {
    task('PAY-2').pullRequests = [request(482)];
    setDisplay({ properties: { pullRequest: true } });
    renderList();
    const pay2 = await findRow('PAY-2');
    expect(pay2.querySelector('[data-part="request-marker"]')).toHaveTextContent('#482 open');
  });

  it('dims a waiting row by default, never a ready one, and hides waiting rows when asked', async () => {
    task('PAY-3').checkAgain = { on: addDays(localToday(), 3), reason: 'Waiting on legal' };
    task('PAY-4').checkAgain = { on: localToday(), reason: 'Today' };
    renderList();
    await findRow('PAY-3');
    expect(row('PAY-3')).toHaveAttribute('data-waiting', 'dimmed');
    expect(row('PAY-3').className).toMatch(/opacity-62/);
    expect(row('PAY-4')).not.toHaveAttribute('data-waiting');
    expect(within(row('PAY-4')).getByText('Check again: today')).toBeInTheDocument();
  });

  it('leaves waiting rows out under "Waiting tasks: Hidden"', async () => {
    task('PAY-3').checkAgain = { on: addDays(localToday(), 3), reason: 'Waiting on legal' };
    setDisplay({ waiting: 'hidden' });
    renderList();
    await findRow('PAY-4');
    expect(queryRow('PAY-3')).toBeNull();
  });
});

describe('archived tasks (frames 083 to 085)', () => {
  it('lists archived rows under the Archived filter with Backlog and Done open, a quiet title and Restore', async () => {
    const user = userEvent.setup();
    task('PAY-6').archivedAt = new Date(Date.now() - 86_400_000 * 3).toISOString();
    task('PAY-3').archivedAt = new Date(Date.now() - 86_400_000).toISOString();
    renderList('/w/acme/p/PAY?archived=only');
    const pay6 = await findRow('PAY-6');
    // Most archived tasks are Done: nothing starts folded.
    expect(groupRows().every((text) => text?.endsWith('expanded'))).toBe(true);
    expect(queryRow('PAY-1')).toBeNull();
    expect(within(pay6).getByText('Task number 6')).toHaveClass('text-fg-3');
    expect(within(pay6).getByText(/^Archived [A-Z][a-z]{2} \d+/)).toBeInTheDocument();
    expect(pay6).toHaveAttribute('data-archived');

    await user.click(within(pay6).getByRole('button', { name: /Restore/ }));
    await waitFor(() => expect(fake().calls.restore.at(-1)).toEqual({ keys: ['PAY-6'] }));
    expect(await screen.findByRole('status')).toHaveTextContent('1 task restored');
  });

  it('archives the selection from the action bar, says how many, and Undo restores them', async () => {
    const user = userEvent.setup();
    renderList();
    await findRow('PAY-1');
    await user.keyboard('jx{Shift>}{ArrowDown}{/Shift}');
    const bar = screen.getByRole('toolbar', { name: '2 selected' });
    await user.click(within(bar).getByRole('button', { name: /^Archive/ }));
    await waitFor(() => expect(fake().calls.archive.at(-1)).toEqual({ keys: ['PAY-1', 'PAY-2'] }));
    const toast = await screen.findByRole('status');
    expect(toast).toHaveTextContent('2 tasks archived');
    await waitFor(() => expect(queryRow('PAY-1')).toBeNull());
    await user.click(within(toast).getByRole('button', { name: 'Undo' }));
    await waitFor(() => expect(fake().calls.restore.at(-1)).toEqual({ keys: ['PAY-1', 'PAY-2'] }));
    await findRow('PAY-1');
  });
});

describe('the M7 filters in the URL and the empty state', () => {
  it('keeps checkAgain and archived in the search and counts them as filters', () => {
    const search = parseTaskListSearch({ checkAgain: 'waiting', archived: 'only', junk: 'x' });
    expect(search).toEqual({ checkAgain: 'waiting', archived: 'only' });
    expect(hasFilters(search)).toBe(true);
    expect(parseTaskListSearch({ checkAgain: 'soon', archived: 'all' })).toEqual({});
    expect(hasFilters({})).toBe(false);
  });

  it('says them in the no-results sentence', () => {
    expect(describeTaskFilter({ checkAgain: 'waiting' }, [])).toEqual(['is waiting to be checked again']);
    expect(describeTaskFilter({ checkAgain: 'ready' }, [])).toEqual(['is ready to check again']);
    expect(describeTaskFilter({ archived: 'only' }, [])).toEqual(['is archived']);
    expect(describeTaskFilter({ archived: 'include' }, [])).toEqual(['is archived or active']);
  });
});
