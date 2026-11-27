import { ORPCError } from '@orpc/client';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import {
  createMemoryHistory,
  createRootRoute,
  createRoute,
  createRouter,
  Outlet,
  RouterProvider,
} from '@tanstack/react-router';
import { act, configure, fireEvent, render, screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import type { MilestonePlan, TaskListItem, TaskStatus, Wave, WaveTask } from '@zamu/contracts';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { closePeek } from '~/features/peek/store';
import { TaskFieldToast } from '~/features/task-fields';
import { resetFieldToastForTests } from '~/features/task-fields/toast';
import { createFakeApi, FAKE_MILESTONES, FAKE_PEOPLE, type FakeApi } from '~/features/tasks/fake-api';
import { resetDisplayOptionsForTests } from '~/features/views/useDisplayOptions';
import { forwardingClient, testWorkspace } from '~/lib/testing';
import { WorkspaceProvider } from '~/lib/workspace';
import { UIProvider } from '~/ui';
import { MilestonePage } from './MilestonePage';
import { MilestonesScreen } from './MilestonesScreen';
import { RemoveWaveText, visibleTaskKeys } from './WavePlan';
import {
  foldedRun,
  moreTasksText,
  moveStep,
  shownTasks,
  startsExpanded,
  stoppedAt,
  waveSections,
} from './waves';

// The milestone page grouped by wave (M8, frames 103 to 126): the wave model, the frames' states, the
// keys (G, Alt+↑ / Alt+↓, ← / →, Shift+N, ⌘↵ and Esc in the gate step), the folding rule, and the
// milestone without waves (frame 117).

configure({ asyncUtilTimeout: 5000 });
vi.setConfig({ testTimeout: 30_000 });

const api = vi.hoisted(() => ({ current: null as FakeApi | null }));
const workspace = testWorkspace(forwardingClient(() => api.current?.client));
const fake = () => api.current as FakeApi;

const MILESTONE = FAKE_MILESTONES.pci;
const waveId = (n: number) => `91000000-0000-4000-8000-${String(n).padStart(12, '0')}`;
const NAMES = [
  'Data and contracts',
  'Screens',
  'End-to-end tests',
  'Release',
  'Docs',
  'Rollout',
  'Follow-up',
  'Wrap',
];

type GateState = Wave['gate']['state'];

interface WaveSpec {
  gate: GateState;
  /** Keys PAY-n in the wave, with their status. */
  tasks: [number, TaskStatus][];
  description?: string | null;
}

/**
 * Puts the fake's tasks in the PCI audit milestone and in waves, and sets the plan the page reads. The
 * lock and current wave follow the rule: the current wave is the first not passed, the ones after it
 * are locked until it passes.
 */
function setUpPlan(specs: WaveSpec[], notInWave: [number, TaskStatus][] = [], planUrl: string | null = null) {
  const f = fake();
  const milestone = f.milestones.find((item) => item.id === MILESTONE);
  if (!milestone) throw new Error('no milestone');
  const ref = {
    id: milestone.id,
    name: milestone.name,
    status: milestone.status,
    targetDate: milestone.targetDate,
  };
  const firstOpen = specs.findIndex((spec) => spec.gate !== 'passed');
  const waves: Wave[] = specs.map((spec, index) => {
    const number = index + 1;
    const locked = firstOpen >= 0 && index > firstOpen;
    const lockedUntil = locked ? { number: firstOpen + 1, name: NAMES[firstOpen] ?? '' } : null;
    const tasks: WaveTask[] = spec.tasks.map(([n, status]) => ({
      key: `PAY-${n}`,
      title: `Task number ${n}`,
      status,
      assignee: null,
      archived: false,
    }));
    const done = spec.tasks.filter(([, status]) => status === 'done').length;
    const canceled = spec.tasks.filter(([, status]) => status === 'canceled').length;
    const open = spec.tasks.length - done - canceled;
    const result =
      spec.gate === 'open'
        ? null
        : {
            state: spec.gate,
            note: spec.gate === 'failed' ? 'The retry button wraps at 1024px.' : 'Checks pass.',
            recordedBy: FAKE_PEOPLE.claude,
            onBehalfOf: FAKE_PEOPLE.ana,
            at: new Date(Date.now() - 20 * 60_000).toISOString(),
          };
    const wave: Wave = {
      id: waveId(number),
      milestoneId: milestone.id,
      number,
      name: NAMES[index] ?? `Wave ${number}`,
      gate: {
        description: spec.description === undefined ? 'All checks pass.' : spec.description,
        state: spec.gate,
        result,
      },
      current: index === firstOpen,
      locked,
      lockedUntil,
      progress: { total: spec.tasks.length, done, canceled, open },
      canPass: open === 0,
      openKeys: tasks
        .filter((task) => task.status !== 'done' && task.status !== 'canceled')
        .map((task) => task.key),
      tasks,
    };
    f.waveRefs.set(wave.id, {
      id: wave.id,
      number,
      name: wave.name,
      locked,
      lockedUntil,
    });
    for (const [n, status] of spec.tasks) {
      const task = f.tasks.find((item) => item.number === n);
      if (!task) throw new Error(`no PAY-${n}`);
      task.status = status;
      task.milestone = ref;
      task.wave = f.waveRefs.get(wave.id) ?? null;
    }
    return wave;
  });
  for (const [n, status] of notInWave) {
    const task = f.tasks.find((item) => item.number === n);
    if (!task) throw new Error(`no PAY-${n}`);
    task.status = status;
    task.milestone = ref;
    task.wave = null;
  }
  const passed = specs.length > 0 && firstOpen < 0;
  milestone.waves = specs.length
    ? {
        count: specs.length,
        current: passed ? null : firstOpen + 1,
        currentState: passed ? null : specs[firstOpen]?.gate === 'failed' ? 'failed' : 'open',
        allPassed: passed,
      }
    : null;
  milestone.planUrl = planUrl;
  const plan: MilestonePlan = {
    milestone,
    planUrl,
    waves,
    notInWave: notInWave.map(([n, status]) => ({
      key: `PAY-${n}`,
      title: `Task number ${n}`,
      status,
      assignee: null,
      archived: false,
    })),
  };
  f.plans.set(MILESTONE, plan);
  return plan;
}

function renderPage(url = `/w/acme/p/PAY/milestones/${MILESTONE}`) {
  const queryClient = new QueryClient({
    defaultOptions: { queries: { retry: false, refetchOnWindowFocus: false } },
  });
  const root = createRootRoute({
    component: () => (
      <UIProvider>
        <Outlet />
        <TaskFieldToast />
      </UIProvider>
    ),
  });
  const page = createRoute({
    getParentRoute: () => root,
    path: '/w/$workspace/p/$projectKey/milestones/$milestoneId',
    component: function Route() {
      const { projectKey, milestoneId } = page.useParams();
      return <MilestonePage projectKey={projectKey} milestoneId={milestoneId} />;
    },
  });
  const taskPage = createRoute({
    getParentRoute: () => root,
    path: '/w/$workspace/p/$projectKey/$taskKey',
    component: () => <p>Task page</p>,
  });
  const list = createRoute({
    getParentRoute: () => root,
    path: '/w/$workspace/p/$projectKey/milestones',
    component: function Route() {
      const { projectKey } = list.useParams();
      return <MilestonesScreen projectKey={projectKey} />;
    },
  });
  const router = createRouter({
    routeTree: root.addChildren([page, list, taskPage]),
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

const header = (ref: string) => screen.getByRole('button', { name: new RegExp(`^${ref} · `) });
const findHeader = (ref: string) => screen.findByRole('button', { name: new RegExp(`^${ref} · `) });
const row = (key: string) => document.querySelector(`li[data-key="${key}"]`) as HTMLElement | null;
const waveCalls = (op: string) => fake().calls.waves.filter((call) => call.op === op);

beforeEach(() => {
  api.current = createFakeApi({ tasks: 12 });
  resetFieldToastForTests();
  resetDisplayOptionsForTests();
});

afterEach(() => {
  closePeek();
  sessionStorage.clear();
  localStorage.clear();
});

// ---------------------------------------------------------------------------
// The model
// ---------------------------------------------------------------------------

const gateOnly = (state: string) => ({ gate: { state } }) as unknown as Pick<Wave, 'gate'>;

describe('the wave model', () => {
  it('folds the leading passed waves only past six waves, never the last one', () => {
    expect(
      foldedRun(['passed', 'passed', 'passed', 'open', 'open', 'open'].map(gateOnly) as never),
    ).toBeNull();
    expect(
      foldedRun(['passed', 'passed', 'passed', 'passed', 'open', 'open', 'open'].map(gateOnly) as never),
    ).toEqual({ from: 1, to: 4 });
    expect(
      foldedRun(['passed', 'failed', 'open', 'open', 'open', 'open', 'open'].map(gateOnly) as never),
    ).toBeNull();
    expect(foldedRun(Array.from({ length: 8 }, () => gateOnly('passed')) as never)).toEqual({
      from: 1,
      to: 7,
    });
  });

  it('shows six rows of a wave with more than eight, and the rest behind Show all', () => {
    const nine = Array.from({ length: 9 }, (_, index) => index);
    expect(shownTasks(nine.slice(0, 8), false)).toEqual({ shown: nine.slice(0, 8), more: 0 });
    expect(shownTasks(nine, false)).toEqual({ shown: nine.slice(0, 6), more: 3 });
    expect(shownTasks(nine, true).more).toBe(0);
    expect(moreTasksText(24)).toBe('24 more tasks in this wave');
    expect(moreTasksText(1)).toBe('1 more task in this wave');
  });

  it('moves between waves with Alt+↓ / Alt+↑, past the last wave to no wave', () => {
    const waves = [{ id: 'a' }, { id: 'b' }];
    expect(moveStep(waves, 'a', 1)).toBe('b');
    expect(moveStep(waves, 'b', 1)).toBeNull();
    expect(moveStep(waves, null, 1)).toBeUndefined();
    expect(moveStep(waves, null, -1)).toBe('b');
    expect(moveStep(waves, 'a', -1)).toBeUndefined();
    expect(moveStep([], null, -1)).toBeUndefined();
  });

  it('opens the current wave, and the last one once every gate passed', () => {
    const waves = ['passed', 'open', 'open'].map(gateOnly);
    expect(startsExpanded({ current: false, number: 1 }, waves)).toBe(false);
    expect(startsExpanded({ current: true, number: 2 }, waves)).toBe(true);
    expect(startsExpanded({ current: false, number: 3 }, waves)).toBe(false);
    const passed = ['passed', 'passed'].map(gateOnly);
    expect(startsExpanded({ current: false, number: 2 }, passed)).toBe(true);
    expect(startsExpanded({ current: false, number: 1 }, passed)).toBe(false);
  });

  it('puts rows in their waves, unknown waves in no wave, and walks the open ones in order', () => {
    const plan = {
      waves: [
        { id: 'w1', number: 1, current: false, gate: { state: 'passed' } },
        { id: 'w2', number: 2, current: true, gate: { state: 'failed' } },
      ] as Wave[],
    };
    const rows = [
      { key: 'PAY-1', wave: { id: 'w2' } },
      { key: 'PAY-2', wave: { id: 'w1' } },
      { key: 'PAY-3', wave: null },
      { key: 'PAY-4', wave: { id: 'gone' } },
    ] as TaskListItem[];
    const sections = waveSections(plan, rows);
    expect(sections.waves.map((section) => section.tasks.map((task) => task.key))).toEqual([
      ['PAY-2'],
      ['PAY-1'],
    ]);
    expect(sections.none.map((task) => task.key)).toEqual(['PAY-3', 'PAY-4']);
    expect(stoppedAt(plan.waves)?.id).toBe('w2');
    // W1 passed starts folded, W2 (current) open, Not in a wave collapsed until every gate passed.
    expect(visibleTaskKeys(sections, new Map(), new Set())).toEqual(['PAY-1']);
    expect(
      visibleTaskKeys(
        sections,
        new Map([
          ['w1', true],
          ['none', true],
        ]),
        new Set(),
      ),
    ).toEqual(['PAY-2', 'PAY-1', 'PAY-3', 'PAY-4']);
  });

  it('says where the tasks of a removed wave go', () => {
    const { container } = render(
      <p>
        <RemoveWaveText
          wave={{ progress: { total: 6, done: 0, canceled: 0, open: 6 }, gate: { result: {} } } as never}
        />
      </p>,
    );
    expect(container).toHaveTextContent(
      'Its 6 tasks go to Not in a wave. Its gate and its recorded results go with it, and the waves after it move up one.',
    );
  });
});

// ---------------------------------------------------------------------------
// The page
// ---------------------------------------------------------------------------

/** Frame 103: W1 passed, W2 current with its gate open (one task open), W3 and W4 locked. */
function frame103() {
  return setUpPlan(
    [
      {
        gate: 'passed',
        tasks: [
          [1, 'done'],
          [2, 'done'],
        ],
      },
      {
        gate: 'open',
        tasks: [
          [3, 'done'],
          [4, 'in_progress'],
        ],
      },
      {
        gate: 'open',
        tasks: [
          [5, 'todo'],
          [6, 'todo'],
        ],
      },
      { gate: 'open', tasks: [[7, 'todo']] },
    ],
    [
      [8, 'todo'],
      [9, 'in_progress'],
    ],
    'plans/payouts-v2.html',
  );
}

describe('the milestone page with waves', () => {
  it('groups by wave with the gate pills, the locks, the gate box and Not in a wave (frame 103)', async () => {
    frame103();
    renderPage();
    const w2 = await findHeader('W2');
    expect(w2).toHaveAttribute('aria-expanded', 'true');
    expect(header('W1')).toHaveAttribute('aria-expanded', 'false');
    expect(header('W3')).toHaveAttribute('aria-expanded', 'false');
    // The numbers: tasks, done, waves; the plan link with Copy.
    expect(screen.getByText('waves')).toBeInTheDocument();
    expect(screen.getByText('plans/payouts-v2.html')).toBeInTheDocument();
    expect(screen.getByRole('button', { name: 'Copy the plan link' })).toBeInTheDocument();
    // Pills: passed, open, "Locked until W2 passes" on W3, "Locked" on W4.
    expect(screen.getByText('Gate passed')).toBeInTheDocument();
    expect(screen.getByText('Locked until W2 passes')).toBeInTheDocument();
    expect(screen.getByText('Locked')).toBeInTheDocument();
    // W2's rows and gate: Pass waits for the open task.
    expect(await screen.findByText('Task number 4')).toBeInTheDocument();
    const gate = screen.getByRole('group', { name: 'Gate of W2 · Screens' });
    expect(within(gate).getByText('Pass unlocks when the open task is done')).toBeInTheDocument();
    expect(within(gate).getByRole('button', { name: /^Pass/ })).toBeDisabled();
    expect(within(gate).getByRole('button', { name: 'Fail' })).toBeEnabled();
    // Not in a wave: collapsed, with its count and its note.
    const none = screen.getByRole('button', { name: 'Not in a wave' });
    expect(none).toHaveAttribute('aria-expanded', 'false');
    expect(screen.getByText('No gate. These never hold a wave up.')).toBeInTheDocument();
    expect(screen.getByText('2 tasks')).toBeInTheDocument();
    // Display offers Wave and picks it.
    await userEvent.click(screen.getByRole('button', { name: 'Display' }));
    expect(await screen.findByRole('button', { name: /Wave/ })).toBeInTheDocument();
  });

  it('draws the lock on the rows of a locked wave', async () => {
    frame103();
    renderPage();
    await userEvent.click(await findHeader('W3'));
    expect(await screen.findByText('Task number 5')).toBeInTheDocument();
    expect(
      within(row('PAY-5') as HTMLElement).getByRole('img', { name: 'Locked until W2 passes' }),
    ).toBeVisible();
  });

  it('collapses and expands a wave with ← and → on its header', async () => {
    frame103();
    renderPage();
    const w2 = await findHeader('W2');
    act(() => w2.focus());
    await userEvent.keyboard('{ArrowLeft}');
    expect(w2).toHaveAttribute('aria-expanded', 'false');
    expect(screen.queryByText('Task number 4')).not.toBeInTheDocument();
    await userEvent.keyboard('{ArrowRight}');
    expect(w2).toHaveAttribute('aria-expanded', 'true');
  });

  it('records a gate from G on the header: ⌘↵ records, Esc cancels (frame 107)', async () => {
    setUpPlan([
      { gate: 'passed', tasks: [[1, 'done']] },
      {
        gate: 'open',
        tasks: [
          [3, 'done'],
          [4, 'canceled'],
        ],
      },
      { gate: 'open', tasks: [[5, 'todo']] },
    ]);
    renderPage();
    const w2 = await findHeader('W2');
    act(() => w2.focus());
    await userEvent.keyboard('g');
    const step = await screen.findByRole('dialog', { name: 'Gate of W2 · Screens' });
    expect(within(step).getByRole('radio', { name: 'Passed' })).toBeChecked();
    expect(
      within(step).getByText('The note stays with the gate. W3 unlocks as soon as this passes.'),
    ).toBeVisible();
    // Esc leaves it as it was.
    await userEvent.keyboard('{Escape}');
    await waitFor(() =>
      expect(screen.queryByRole('dialog', { name: 'Gate of W2 · Screens' })).not.toBeInTheDocument(),
    );
    expect(waveCalls('recordGate')).toHaveLength(0);
    // Pass in the box opens it again; ⌘↵ with a note records it.
    await userEvent.click(screen.getByRole('button', { name: /^Pass/ }));
    const again = await screen.findByRole('dialog', { name: 'Gate of W2 · Screens' });
    await userEvent.type(within(again).getByLabelText('Note'), 'Walked every screen in both themes.');
    await userEvent.keyboard('{Meta>}{Enter}{/Meta}');
    await waitFor(() =>
      expect(waveCalls('recordGate')).toEqual([
        { op: 'recordGate', id: waveId(2), state: 'passed', note: 'Walked every screen in both themes.' },
      ]),
    );
    await waitFor(() =>
      expect(screen.queryByRole('dialog', { name: 'Gate of W2 · Screens' })).not.toBeInTheDocument(),
    );
  });

  it('shows the server refusing a pass in the step', async () => {
    setUpPlan([{ gate: 'open', tasks: [[3, 'done']] }]);
    renderPage();
    await userEvent.click(await screen.findByRole('button', { name: /^Pass/ }));
    const step = await screen.findByRole('dialog', { name: 'Gate of W1 · Data and contracts' });
    await userEvent.type(within(step).getByLabelText('Note'), 'Checked.');
    fake().control.failNext = new ORPCError('GATE_TASKS_OPEN', {
      status: 409,
      message: 'W1 has open tasks: PAY-3. Finish or cancel them first.',
    });
    await userEvent.click(within(step).getByRole('button', { name: 'Record' }));
    expect(await within(step).findByRole('alert')).toHaveTextContent('W1 has open tasks: PAY-3.');
  });

  it('puts the stop line across the top when the current gate failed, and goes to it (frame 108)', async () => {
    setUpPlan([
      { gate: 'passed', tasks: [[1, 'done']] },
      {
        gate: 'failed',
        tasks: [
          [3, 'done'],
          [4, 'todo'],
        ],
      },
      { gate: 'open', tasks: [[5, 'todo']] },
      { gate: 'open', tasks: [[6, 'todo']] },
    ]);
    renderPage();
    expect(await screen.findByText('The gate of W2 · Screens failed.')).toBeInTheDocument();
    expect(
      screen.getByText('The plan stops here: W3 and W4 stay locked until it passes.'),
    ).toBeInTheDocument();
    const gate = screen.getByRole('group', { name: 'Gate of W2 · Screens' });
    expect(within(gate).getByText('Failed')).toBeInTheDocument();
    expect(within(gate).getByText('The retry button wraps at 1024px.')).toBeInTheDocument();
    expect(within(gate).getByRole('button', { name: /Record again/ })).toBeInTheDocument();
    await userEvent.click(screen.getByRole('button', { name: 'Go to the gate' }));
    await waitFor(() => expect(gate).toHaveFocus());
  });

  it('says every gate passed and how many tasks are still open (frame 109)', async () => {
    setUpPlan(
      [
        { gate: 'passed', tasks: [[1, 'done']] },
        { gate: 'passed', tasks: [[2, 'done']] },
      ],
      [
        [8, 'todo'],
        [9, 'in_progress'],
      ],
    );
    renderPage();
    expect(
      await screen.findByText('All two gates passed. Two tasks outside the waves are still open.'),
    ).toBeVisible();
    // The last wave and Not in a wave are open.
    expect(await findHeader('W2')).toHaveAttribute('aria-expanded', 'true');
    expect(screen.getByRole('button', { name: 'Not in a wave' })).toHaveAttribute('aria-expanded', 'true');
  });

  it('moves the focused task to the next wave with Alt+↓, showing the hint (frame 113)', async () => {
    frame103();
    const user = userEvent.setup();
    renderPage();
    await screen.findByText('Task number 4');
    await user.keyboard('j');
    await waitFor(() => expect(row('PAY-4')).toHaveAttribute('data-focused'));
    await user.keyboard('{Alt>}{ArrowDown}');
    expect(await screen.findByText('Moving PAY-4 to W3')).toBeInTheDocument();
    await user.keyboard('{ArrowDown}');
    expect(screen.getByText('Moving PAY-4 to W4')).toBeInTheDocument();
    await user.keyboard('{/Alt}');
    await waitFor(() =>
      expect(waveCalls('putTasks')).toEqual([
        { op: 'putTasks', milestone: MILESTONE, wave: waveId(4), keys: ['PAY-4'] },
      ]),
    );
    expect(screen.queryByText(/^Moving PAY-4/)).not.toBeInTheDocument();
  });

  it('cancels a keyboard move with Esc, and moves out of the waves past the last one', async () => {
    frame103();
    renderPage();
    await screen.findByText('Task number 4');
    await userEvent.keyboard('j');
    await userEvent.keyboard('{Alt>}{ArrowUp}');
    expect(screen.getByText('Moving PAY-4 to W1')).toBeInTheDocument();
    await userEvent.keyboard('{Escape}{/Alt}');
    expect(screen.queryByText(/^Moving PAY-4/)).not.toBeInTheDocument();
    expect(waveCalls('putTasks')).toHaveLength(0);
    await userEvent.keyboard('{Alt>}{ArrowDown}{ArrowDown}{ArrowDown}');
    expect(screen.getByText('Moving PAY-4 out of the waves')).toBeInTheDocument();
    await userEvent.keyboard('{/Alt}');
    await waitFor(() =>
      expect(waveCalls('putTasks')).toEqual([
        { op: 'putTasks', milestone: MILESTONE, wave: null, keys: ['PAY-4'] },
      ]),
    );
  });

  it('adds a wave with Shift+N and the next number', async () => {
    frame103();
    renderPage();
    await findHeader('W2');
    await userEvent.keyboard('{Shift>}N{/Shift}');
    const field = await screen.findByRole('textbox', { name: 'Name of W5' });
    expect(field).toHaveFocus();
    await userEvent.type(field, 'Follow-up after the first week{Enter}');
    await waitFor(() =>
      expect(waveCalls('create')).toEqual([
        { op: 'create', milestone: MILESTONE, name: 'Follow-up after the first week' },
      ]),
    );
  });

  it('renames, moves and removes a wave from its menu; removing says where the tasks go', async () => {
    frame103();
    renderPage();
    await findHeader('W2');
    await userEvent.click(screen.getByRole('button', { name: 'Actions for W2' }));
    await userEvent.click(await screen.findByRole('menuitem', { name: 'Move down' }));
    await waitFor(() => expect(waveCalls('update')).toEqual([{ op: 'update', id: waveId(2), position: 3 }]));

    await userEvent.click(screen.getByRole('button', { name: 'Actions for W2' }));
    await userEvent.click(await screen.findByRole('menuitem', { name: 'Rename' }));
    const name = await screen.findByRole('textbox', { name: 'Name of W2' });
    await userEvent.clear(name);
    await userEvent.type(name, 'Screens and states{Enter}');
    await waitFor(() =>
      expect(waveCalls('update').at(-1)).toEqual({ op: 'update', id: waveId(2), name: 'Screens and states' }),
    );

    await userEvent.click(screen.getByRole('button', { name: 'Actions for W3' }));
    await userEvent.click(await screen.findByRole('menuitem', { name: 'Remove wave' }));
    const confirm = await screen.findByRole('alertdialog');
    expect(confirm).toHaveTextContent('Remove W3 · End-to-end tests?');
    expect(confirm).toHaveTextContent('Its 2 tasks go to Not in a wave.');
    await userEvent.click(within(confirm).getByRole('button', { name: 'Remove wave' }));
    await waitFor(() => expect(waveCalls('delete')).toEqual([{ op: 'delete', id: waveId(3) }]));
  });

  it('edits what the gate checks in the gate box', async () => {
    frame103();
    renderPage();
    const gate = await screen.findByRole('group', { name: 'Gate of W2 · Screens' });
    await userEvent.click(within(gate).getByRole('button', { name: 'Edit' }));
    const field = within(gate).getByRole('textbox', { name: 'What the gate of W2 checks' });
    await userEvent.clear(field);
    await userEvent.type(field, 'Every screen in light and dark.');
    await userEvent.keyboard('{Meta>}{Enter}{/Meta}');
    await waitFor(() =>
      expect(waveCalls('update')).toEqual([
        { op: 'update', id: waveId(2), gateDescription: 'Every screen in light and dark.' },
      ]),
    );
  });

  it('folds the passed waves past six, and shows six rows of a long wave (frame 121)', async () => {
    // Seven waves, four passed; the current wave has nine tasks.
    const twelve = Array.from({ length: 12 }, (_, index) => index + 1);
    api.current = createFakeApi({ tasks: 20 });
    setUpPlan([
      { gate: 'passed', tasks: [[1, 'done']] },
      { gate: 'passed', tasks: [[2, 'done']] },
      { gate: 'passed', tasks: [[13, 'done']] },
      { gate: 'passed', tasks: [[14, 'done']] },
      { gate: 'open', tasks: twelve.slice(2, 11).map((n) => [n, 'todo'] as [number, TaskStatus]) },
      { gate: 'open', tasks: [[15, 'todo']] },
      { gate: 'open', tasks: [[16, 'todo']] },
    ]);
    renderPage();
    const folded = await screen.findByRole('button', { name: 'W1 to W4, 4 waves, all passed' });
    expect(folded).toHaveAttribute('aria-expanded', 'false');
    expect(screen.queryByRole('button', { name: /^W1 · / })).not.toBeInTheDocument();
    expect(screen.getByText('4 gates passed')).toBeInTheDocument();
    await screen.findByText('3 more tasks in this wave');
    expect(document.querySelectorAll('li[data-key]')).toHaveLength(6);
    await userEvent.click(screen.getByRole('button', { name: 'Show all' }));
    expect(document.querySelectorAll('li[data-key]')).toHaveLength(9);
    await userEvent.click(folded);
    expect(header('W1')).toBeInTheDocument();
  });

  it('shows skeleton waves while the plan loads, and Try again when it fails (frames 122, 123)', async () => {
    frame103();
    let fail = true;
    let release = () => {};
    const held = new Promise<void>((resolve) => {
      release = resolve;
    });
    const real = fake().client.milestones.plan;
    fake().client.milestones.plan = async (input) => {
      await held;
      if (fail) throw new ORPCError('INTERNAL_SERVER_ERROR', { status: 500, message: 'boom' });
      return real(input);
    };
    renderPage();
    expect(await screen.findByRole('status', { name: 'Loading the waves' })).toBeInTheDocument();
    release();
    expect(await screen.findByText('Couldn’t load the waves of this milestone.')).toBeInTheDocument();
    fail = false;
    await userEvent.click(screen.getByRole('button', { name: 'Try again' }));
    expect(await findHeader('W2')).toBeInTheDocument();
  });

  it('adds the plan link from the header', async () => {
    const plan = frame103();
    plan.planUrl = null;
    const milestone = fake().milestones.find((item) => item.id === MILESTONE);
    if (milestone) milestone.planUrl = null;
    renderPage();
    await userEvent.click(await screen.findByRole('button', { name: 'Add a link to the plan' }));
    const dialog = await screen.findByRole('dialog', { name: 'Link the plan' });
    await userEvent.type(
      within(dialog).getByLabelText('Web address or file path'),
      'https://wiki.northwind.dev/plans/payouts',
    );
    await userEvent.click(within(dialog).getByRole('button', { name: /^Save/ }));
    await waitFor(() =>
      expect(waveCalls('milestone')).toEqual([
        { op: 'milestone', id: MILESTONE, planUrl: 'https://wiki.northwind.dev/plans/payouts' },
      ]),
    );
    expect(
      await screen.findByRole('link', { name: 'wiki.northwind.dev/plans/payouts, opens in a new tab' }),
    ).toBeVisible();
  });
});

describe('a milestone without waves (frame 117)', () => {
  it('groups by status as before, with "+ Add waves" on the first group and the plan link button', async () => {
    setUpPlan(
      [],
      [
        [3, 'todo'],
        [4, 'in_progress'],
      ],
    );
    renderPage();
    const add = await screen.findByRole('button', { name: 'Add waves' });
    expect(screen.getByRole('button', { name: 'Add a link to the plan' })).toBeInTheDocument();
    expect(screen.queryByText('waves')).not.toBeInTheDocument();
    await userEvent.click(add);
    expect(await screen.findByRole('textbox', { name: 'Name of W1' })).toHaveFocus();
    expect(screen.getByRole('button', { name: 'Not in a wave' })).toHaveAttribute('aria-expanded', 'true');
  });

  it('opens the wave grouping with Shift+N', async () => {
    setUpPlan([], [[3, 'todo']]);
    renderPage();
    await screen.findByRole('button', { name: 'Add waves' });
    fireEvent.keyDown(document.body, { key: 'N', shiftKey: true });
    expect(await screen.findByRole('textbox', { name: 'Name of W1' })).toBeInTheDocument();
  });
});

describe('the milestone list (frame 118)', () => {
  it('says the wave status under each name', async () => {
    const [pci, webhooks] = fake().milestones;
    if (!pci || !webhooks) throw new Error('no milestones');
    pci.waves = { count: 12, current: 8, currentState: 'failed', allPassed: false };
    webhooks.waves = { count: 4, current: null, currentState: null, allPassed: true };
    renderPage('/w/acme/p/PAY/milestones');
    expect(await screen.findByText('Gate failed in wave 8 of 12')).toBeInTheDocument();
    // Webhooks v2: 4 tasks, 2 done, none canceled: 2 still open.
    expect(screen.getByText('All 4 gates passed · 2 tasks open')).toBeInTheDocument();
  });

  it('says No waves for a milestone without any', async () => {
    const [pci] = fake().milestones;
    if (pci) pci.waves = null;
    renderPage('/w/acme/p/PAY/milestones');
    expect(await screen.findByText('No waves')).toBeInTheDocument();
  });
});
