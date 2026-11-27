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
import type { MilestonePlan, Task, TaskWave, Wave } from '@zamu/contracts';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { resetTimelinePreferences } from '~/features/comments/TaskTimeline';
import { StartGuardHost } from '~/features/task-fields';
import { resetStartingForTests } from '~/features/task-fields/starting';
import { resetFieldToastForTests, TaskFieldToast } from '~/features/task-fields/toast';
import { forwardingClient, testWorkspace } from '~/lib/testing';
import { WorkspaceProvider } from '~/lib/workspace';
import { UIProvider } from '~/ui';
import { createFakeApi, FAKE_MILESTONES, FAKE_PEOPLE, type FakeApi } from './fake-api';
import { TaskPage } from './TaskPage';

// The task view's M8 parts: the Wave row under Milestone with its lock, picking a wave, the start
// guard on the status field and its key, and the history lines of wave changes.

configure({ asyncUtilTimeout: 5000 });
vi.setConfig({ testTimeout: 30_000 });

const api = vi.hoisted(() => ({ current: null as FakeApi | null }));
const workspace = testWorkspace(forwardingClient(() => api.current?.client));
const fake = () => api.current as FakeApi;

const ID = (n: number) => `91000000-0000-4000-8000-00000000000${n}`;
const W1: TaskWave = { id: ID(1), number: 1, name: 'Data and contracts', locked: false, lockedUntil: null };
const W2: TaskWave = { id: ID(2), number: 2, name: 'Screens', locked: false, lockedUntil: null };
const W3: TaskWave = {
  id: ID(3),
  number: 3,
  name: 'Release',
  locked: true,
  lockedUntil: { number: 2, name: 'Screens' },
};

function planWave(ref: TaskWave, gate: 'open' | 'passed'): Wave {
  return {
    ...ref,
    milestoneId: FAKE_MILESTONES.pci,
    gate: { description: null, state: gate, result: null },
    current: ref.number === 2,
    progress: { total: 0, done: 0, canceled: 0, open: 0 },
    canPass: true,
    openKeys: [],
    tasks: [],
  } as Wave;
}

beforeEach(() => {
  api.current = createFakeApi();
  resetFieldToastForTests();
  resetTimelinePreferences();
  const f = fake();
  const milestone = f.milestones.find((item) => item.id === FAKE_MILESTONES.pci);
  if (!milestone) throw new Error('no milestone');
  milestone.waves = { count: 3, current: 2, currentState: 'open', allPassed: false };
  for (const wave of [W1, W2, W3]) f.waveRefs.set(wave.id, wave);
  const plan: MilestonePlan = {
    milestone,
    planUrl: null,
    waves: [planWave(W1, 'passed'), planWave(W2, 'open'), planWave(W3, 'open')],
    notInWave: [],
  };
  f.plans.set(milestone.id, plan);
  // PAY-3 (Todo) is in the locked W3.
  const pay3 = f.tasks.find((item) => item.key === 'PAY-3') as Task;
  pay3.milestone = {
    id: milestone.id,
    name: milestone.name,
    status: milestone.status,
    targetDate: milestone.targetDate,
  };
  pay3.wave = W3;
});

afterEach(() => resetStartingForTests());

function renderTask(key: string) {
  const queryClient = new QueryClient({
    defaultOptions: { queries: { retry: false, refetchOnWindowFocus: false, refetchInterval: false } },
  });
  const root = createRootRoute({
    component: () => (
      <UIProvider>
        <Outlet />
        <TaskFieldToast />
        <StartGuardHost />
      </UIProvider>
    ),
  });
  const page = createRoute({
    getParentRoute: () => root,
    path: '/w/$workspace/p/$projectKey/$taskKey',
    component: function PageRoute() {
      const { projectKey, taskKey } = page.useParams();
      return <TaskPage key={taskKey} projectKey={projectKey} taskKey={taskKey} />;
    },
  });
  const list = createRoute({
    getParentRoute: () => root,
    path: '/w/$workspace/p/$projectKey/',
    component: () => null,
  });
  const router = createRouter({
    routeTree: root.addChildren([list, page]),
    history: createMemoryHistory({ initialEntries: [`/w/acme/p/PAY/${key}`] }),
  });
  render(
    <QueryClientProvider client={queryClient}>
      <WorkspaceProvider workspace={workspace}>
        <RouterProvider router={router} />
      </WorkspaceProvider>
    </QueryClientProvider>,
  );
}

const properties = () => screen.getByRole('complementary', { name: 'Properties' });
const statusWrites = () => fake().calls.update.filter((call) => call.status !== undefined);

describe('the task view', () => {
  it('shows the wave under Milestone with its lock', async () => {
    renderTask('PAY-3');
    const row = await screen.findByRole('button', { name: 'Wave, W3 · Release, locked' });
    expect(row).toHaveTextContent('W3');
    expect(row).toHaveTextContent('Release');
    expect(row).toHaveTextContent('Locked until W2 passes');
    expect(within(properties()).getByText('PCI audit')).toBeInTheDocument();
  });

  it('picks another wave of the milestone, or none', async () => {
    const user = userEvent.setup();
    renderTask('PAY-3');
    await user.click(await screen.findByRole('button', { name: /^Wave, W3/ }));
    await user.click(await screen.findByRole('menuitem', { name: 'W1 · Data and contracts' }));
    await waitFor(() => expect(fake().calls.update.at(-1)).toEqual({ key: 'PAY-3', wave: W1.id }));
    expect(await screen.findByText('Moved PAY-3 to W1 · Data and contracts')).toBeInTheDocument();
    await user.click(await screen.findByRole('button', { name: /^Wave, W1/ }));
    await user.click(await screen.findByRole('menuitem', { name: 'No wave' }));
    await waitFor(() => expect(fake().calls.update.at(-1)).toEqual({ key: 'PAY-3', wave: null }));
  });

  it('warns before the status field starts a task in a locked wave', async () => {
    const user = userEvent.setup();
    renderTask('PAY-3');
    await screen.findByRole('button', { name: /^Wave, W3/ });
    await user.keyboard('s');
    const menu = await screen.findByRole('dialog', { name: 'Status' });
    await user.click(within(menu).getByRole('menuitemradio', { name: /In progress/ }));
    const dialog = await screen.findByRole('alertdialog', { name: 'W3 is still locked' });
    expect(statusWrites()).toHaveLength(0);
    await user.click(within(dialog).getByRole('button', { name: /Start anyway/ }));
    await waitFor(() => expect(statusWrites().at(-1)).toMatchObject({ key: 'PAY-3', status: 'in_progress' }));
  });

  it('says wave changes in the history, naming a removed wave', async () => {
    const at = new Date(Date.now() - 5 * 60_000).toISOString();
    fake().activity.push(
      {
        id: '40000000-0000-4000-8000-000000009991',
        type: 'task.updated',
        taskKey: 'PAY-3',
        actor: FAKE_PEOPLE.claude,
        onBehalfOf: FAKE_PEOPLE.ana,
        changes: [{ field: 'wave', from: null, to: { ...W2, removed: false } }],
        createdAt: at,
      },
      {
        id: '40000000-0000-4000-8000-000000009992',
        type: 'task.updated',
        taskKey: 'PAY-3',
        actor: FAKE_PEOPLE.ana,
        onBehalfOf: null,
        changes: [
          {
            field: 'wave',
            from: { id: ID(9), number: 4, name: 'Old', removed: true },
            to: { ...W3, removed: false },
          },
        ],
        createdAt: at,
      },
      {
        id: '40000000-0000-4000-8000-000000009993',
        type: 'task.updated',
        taskKey: 'PAY-3',
        actor: FAKE_PEOPLE.ana,
        onBehalfOf: null,
        changes: [{ field: 'wave', from: { id: ID(8), number: 5, name: 'Gone', removed: true }, to: null }],
        createdAt: at,
      },
    );
    renderTask('PAY-3');
    const activity = await screen.findByRole('region', { name: 'Activity' });
    expect(await within(activity).findByText(/put this in W2 · Screens$/)).toBeInTheDocument();
    expect(within(activity).getByText(/put this in W3 · Release$/)).toBeInTheDocument();
    expect(within(activity).getByText(/took this out of a removed wave$/)).toBeInTheDocument();
  });
});
