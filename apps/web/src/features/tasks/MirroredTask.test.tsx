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
import type { Activity, Task } from '@zamu/contracts';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { clearCommentDrafts } from '~/features/comments/CommentComposer';
import { resetTimelinePreferences } from '~/features/comments/TaskTimeline';
import { testWorkspace } from '~/lib/testing';
import { WorkspaceProvider } from '~/lib/workspace';
import { UIProvider } from '~/ui';
import { createFakeApi, FAKE_MILESTONES, FAKE_PEOPLE, type FakeApi } from './fake-api';
import { resetFromFile } from './MirroredTask';
import { canonicalTaskPath } from './prefetch';
import { TaskPage } from './TaskPage';

// Mirrored tasks in the task view (frames 054, 055): the Backlog.md badge, locks on hover or on an edit
// attempt, "From the file", the history from the file, against the in-memory /api/v1 client.

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

const fake = () => api.current as FakeApi;
const FILE = 'backlog/tasks/back-1 - Retry-failed-webhook-deliveries.md';
const FILE_URL = 'https://gitlab.example.com/reddevs/payments/-/blob/main/backlog/tasks/back-1.md';
const DESCRIPTION = [
  'Deliveries that fail should retry with backoff.',
  '',
  '## Acceptance criteria',
  '',
  '- [x] #1 Retries follow 30s, 1m, 2m',
  '- [ ] #2 4xx stops retrying',
  '',
  '## Implementation notes',
  '',
  'pg-boss doubles the delay.',
].join('\n');

/** Turns PAY-1 into a task mirrored from BACK-1, with history from the Backlog.md actor. */
function mirrorPay1({ detached = false, hidden = false }: { detached?: boolean; hidden?: boolean } = {}) {
  const api = fake();
  const now = Date.now();
  const at = (minutesAgo: number) => new Date(now - minutesAgo * 60_000).toISOString();
  const webhooks = api.milestones.find((item) => item.id === FAKE_MILESTONES.webhooks);
  if (webhooks) webhooks.backlogId = 'm-3';
  const task = api.tasks[0] as Task;
  const pay2 = api.tasks[1] as Task;
  Object.assign(task, {
    description: DESCRIPTION,
    milestone: webhooks
      ? { id: webhooks.id, name: webhooks.name, status: webhooks.status, targetDate: webhooks.targetDate }
      : null,
    locked: detached
      ? []
      : ['title', 'description', 'status', 'priority', 'assignee', 'milestone', 'createdAt'],
    hidden,
    hiddenAt: hidden ? at(60) : null,
    backlog: {
      id: 'BACK-1',
      file: hidden || detached ? null : FILE,
      fileUrl: hidden || detached ? null : FILE_URL,
      data: {
        kind: 'task',
        implementationNotes: null,
        status: 'In Progress',
        priority: 'high',
        milestone: 'm-3',
        assignees: [
          { value: '@claude', user: FAKE_PEOPLE.claude },
          { value: '@tomas', user: FAKE_PEOPLE.tomas },
          { value: '@francis', user: null },
        ],
        reporter: '@ana',
        labels: ['webhooks', 'retries'],
        dependencies: [
          { id: 'BACK-2', task: { key: 'PAY-2', title: pay2.title, status: pay2.status, hidden: false } },
          { id: 'BACK-12', task: null },
        ],
        parent: null,
        subtasks: [{ id: 'BACK-1.1', task: null }],
        dueDate: '2026-11-14',
        type: 'feature',
        references: ['https://docs.stripe.com/webhooks#retries', 'src/webhooks/delivery.ts'],
        documentation: [],
        modifiedFiles: [],
        createdDate: '2026-10-02 09:14',
        updatedDate: null,
        ordinal: null,
        other: { estimate: 5 },
      },
    },
  } satisfies Partial<Task>);
  api.mirror.summary = {
    mode: 'mirror',
    state: detached ? 'detached' : 'healthy',
    defaultBranch: 'main',
    lastReadAt: at(3),
    lastReadCommit: 'e91b07fdeadbeef',
    lastTrigger: 'webhook',
    problems: { files: 0, values: 0 },
    hidden: hidden ? 1 : 0,
    detachedAt: detached ? at(1) : null,
  };
  api.mirror.history = [
    {
      id: '80000000-0000-4000-8000-000000000001',
      type: 'project.backlog_imported',
      actor: null,
      onBehalfOf: null,
      origin: 'backlog',
      originRef: 'a1b2c3d4e5f6',
      details: {
        mode: 'mirror',
        repository: 'gitlab.example.com/reddevs/payments',
        tasks: 412,
        milestones: 6,
      },
      createdAt: at(600),
    },
    ...(detached
      ? [
          {
            id: '80000000-0000-4000-8000-000000000002',
            type: 'project.backlog_detached' as const,
            actor: FAKE_PEOPLE.ana,
            onBehalfOf: null,
            origin: 'app' as const,
            originRef: null,
            details: { mode: 'mirror' as const, repository: null, tasks: null, milestones: null },
            createdAt: at(1),
          },
        ]
      : []),
  ];
  const backlogEntry = (minutesAgo: number, entry: Partial<Activity>): Activity => ({
    id: `90000000-0000-4000-8000-${String(minutesAgo).padStart(12, '0')}`,
    type: 'task.updated',
    taskKey: 'PAY-1',
    actor: null,
    onBehalfOf: null,
    changes: [],
    origin: 'backlog',
    originRef: null,
    backlogFields: [],
    createdAt: at(minutesAgo),
    ...entry,
  });
  api.activity.push(
    backlogEntry(120, {
      changes: [{ field: 'status', from: 'todo', to: 'in_progress' }],
      originRef: '3f2a1c9aaaaaaa',
    }),
    backlogEntry(40, { backlogFields: ['labels', 'updatedDate'], originRef: 'c4d81e2bbbbbbb' }),
  );
  if (hidden) api.activity.push(backlogEntry(60, { type: 'task.hidden', originRef: '77ab210ccccccc' }));
}

function renderApp(url: string) {
  const queryClient = new QueryClient({
    defaultOptions: { queries: { retry: false, refetchOnWindowFocus: false, refetchInterval: false } },
  });
  const root = createRootRoute({
    component: () => (
      <UIProvider>
        <Outlet />
      </UIProvider>
    ),
  });
  const list = createRoute({
    getParentRoute: () => root,
    path: '/w/$workspace/p/$projectKey/',
    component: () => <p>List</p>,
  });
  const page = createRoute({
    getParentRoute: () => root,
    path: '/w/$workspace/p/$projectKey/$taskKey',
    component: function PageRoute() {
      const { projectKey, taskKey } = page.useParams();
      return <TaskPage key={taskKey} projectKey={projectKey} taskKey={taskKey} />;
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

const historyRegion = () => screen.getByRole('region', { name: 'Activity' });
const properties = () => screen.getByRole('complementary', { name: 'Properties' });

beforeEach(() => {
  api.current = createFakeApi();
  resetFromFile();
  clearCommentDrafts();
  resetTimelinePreferences();
});

describe('mirrored task in the task view', () => {
  it('shows one Backlog.md badge to the file, no banners, and the comment note', async () => {
    mirrorPay1();
    renderApp('/w/acme/p/PAY/PAY-1');
    const badge = await screen.findByRole('link', { name: /Backlog\.md/ });
    expect(badge).toHaveAttribute('href', FILE_URL);
    expect(screen.queryByText(/Fields with a hatch/)).not.toBeInTheDocument();
    expect(document.querySelector('[data-locked] .locked-hatch')).toBeNull();
    expect(
      await screen.findByRole('button', {
        name: 'Leave a comment. It stays in the app and isn’t written to the file.',
      }),
    ).toBeInTheDocument();
  });

  it('marks owned fields and says where to change them on an edit attempt', async () => {
    const user = userEvent.setup();
    mirrorPay1();
    renderApp('/w/acme/p/PAY/PAY-1');
    const status = await within(await screen.findByRole('complementary', { name: 'Properties' })).findByRole(
      'button',
      { name: 'Status, set in Backlog.md' },
    );
    expect(status).toHaveAttribute('data-locked');
    // Cycles are the app's, even in mirrored projects.
    expect(within(properties()).getByRole('button', { name: 'Cycle' })).not.toHaveAttribute('data-locked');

    await user.click(status);
    expect(await screen.findByRole('tooltip')).toHaveTextContent(
      'Set in Backlog.md. Edit the file to change it.',
    );
    expect(screen.queryByRole('dialog', { name: 'Status' })).not.toBeInTheDocument();
    expect(fake().calls.update).toHaveLength(0);

    // E on the title does the same.
    await user.click(document.body);
    await user.keyboard('e');
    await waitFor(() => expect(screen.queryByRole('textbox', { name: 'Title' })).not.toBeInTheDocument());
    expect(await screen.findByRole('tooltip')).toBeInTheDocument();
  });

  it('shows the description from the file, read-only', async () => {
    mirrorPay1();
    renderApp('/w/acme/p/PAY/PAY-1');
    expect(await screen.findByText(/Retries follow 30s, 1m, 2m/)).toBeInTheDocument();
    expect(screen.queryByRole('checkbox')).not.toBeInTheDocument();
    expect(screen.queryByRole('button', { name: 'Add a description…' })).not.toBeInTheDocument();
  });

  it('keeps the fields with no native home in "From the file", collapsed at first', async () => {
    const user = userEvent.setup();
    mirrorPay1();
    renderApp('/w/acme/p/PAY/PAY-1');
    const section = await screen.findByRole('region', { name: 'From the file' });
    const toggle = within(section).getByRole('button', { name: /From the file/ });
    expect(toggle).toHaveAttribute('aria-expanded', 'false');
    expect(toggle).toHaveTextContent('6 fields');
    await user.click(toggle);
    const keys = within(section)
      .getAllByRole('term')
      .map((term) => term.textContent);
    expect(keys).toEqual(['type', 'reporter', 'assignee', 'references', 'created_date', 'estimate']);
    expect(keys).not.toContain('labels');
    expect(keys).not.toContain('due_date');
    expect(within(section).getByText('feature')).toBeInTheDocument();
    expect(within(section).getByText('2026-10-02 09:14')).toBeInTheDocument();
  });

  it('shows Backlog.md history "in the file" with commits, and the import', async () => {
    mirrorPay1();
    renderApp('/w/acme/p/PAY/PAY-1');
    const region = await screen.findByRole('region', { name: 'Activity' });
    const moved = await within(region).findByText(/moved this to In progress in the file/);
    expect(moved.closest('[data-origin]')).toHaveAttribute('data-origin', 'backlog');
    expect(within(region).getByText('3f2a1c9')).toBeInTheDocument();
    expect(within(region).getByText(/changed the labels in the file/)).toBeInTheDocument();
    expect(within(region).getByText(`imported this from ${FILE}`)).toBeInTheDocument();
  });
});

describe('hidden and detached tasks', () => {
  it('shows the removed banner on a hidden task and keeps comments', async () => {
    mirrorPay1({ hidden: true });
    renderApp('/w/acme/p/PAY/PAY-1');
    expect(await screen.findByText(/Removed from Backlog\.md/)).toBeInTheDocument();
    expect(
      await screen.findByRole('button', { name: 'Comments still work on hidden tasks.' }),
    ).toBeInTheDocument();
    expect(historyRegion()).toBeInTheDocument();
  });

  it('unlocks every field after detach', async () => {
    mirrorPay1({ detached: true });
    renderApp('/w/acme/p/PAY/PAY-1');
    const status = await within(await screen.findByRole('complementary', { name: 'Properties' })).findByRole(
      'button',
      { name: 'Status' },
    );
    expect(status).not.toHaveAttribute('data-locked');
    expect(await within(historyRegion()).findByText(/switched Payments to Zamu/)).toBeInTheDocument();
  });
});

describe('canonicalTaskPath', () => {
  const client = () => new QueryClient({ defaultOptions: { queries: { retry: false } } });

  it('keeps task keys of the project, upper-cased, without asking the server', async () => {
    const get = vi.spyOn(fake().client.tasks, 'get');
    expect(await canonicalTaskPath(workspace.api, client(), 'pay', 'pay-1')).toEqual({
      projectKey: 'PAY',
      taskKey: 'PAY-1',
    });
    expect(await canonicalTaskPath(workspace.api, client(), 'PAY', 'PAY-786.1')).toEqual({
      projectKey: 'PAY',
      taskKey: 'PAY-786.1',
    });
    expect(get).not.toHaveBeenCalled();
  });

  it('resolves a Backlog.md ID to the task key', async () => {
    fake().client.tasks.get = async (input: Record<string, unknown>) => {
      expect(input).toEqual({ key: 'BACK-007', project: 'PAY' });
      return { ...(fake().tasks[0] as Task), key: 'PAY-7' };
    };
    expect(await canonicalTaskPath(workspace.api, client(), 'PAY', 'back-007')).toEqual({
      projectKey: 'PAY',
      taskKey: 'PAY-7',
    });
  });

  it('returns null for keys that match nothing', async () => {
    expect(await canonicalTaskPath(workspace.api, client(), 'PAY', 'not a key')).toBeNull();
    expect(await canonicalTaskPath(workspace.api, client(), 'PAY', 'BACK-9999')).toBeNull();
  });
});
