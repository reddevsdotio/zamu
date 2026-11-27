import { useQueryClient } from '@tanstack/react-query';
import { configure, screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import type { TaskListItem, TaskStatus, TaskWave } from '@zamu/contracts';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { Command } from '~/features/palette/registry';
import { createFakeApi, type FakeApi } from '~/features/tasks/fake-api';
import { meQuery } from '~/features/tasks/queries';
import { forwardingClient, testWorkspace } from '~/lib/testing';
import { Button, localToday } from '~/ui';
import { useFieldChange } from './apply';
import { fieldStep } from './palette';
import { manyStartingText, StartGuardHost } from './StartGuardHost';
import { StatusPicker } from './StatusPicker';
import { resetStartingForTests, startingRequest, startsInLockedWave } from './starting';
import { newQueryClient, renderWith } from './test-utils';
import { resetFieldToastForTests } from './toast';

// The start guard (M8, frame 114) outside the board and the task view: the rule, the status picker
// on a list row, a selection, and the command palette's status step.

configure({ asyncUtilTimeout: 5000 });
vi.setConfig({ testTimeout: 30_000 });

const api = vi.hoisted(() => ({ current: null as FakeApi | null }));
const workspace = testWorkspace(forwardingClient(() => api.current?.client));
const fake = () => api.current as FakeApi;

const W3: TaskWave = {
  id: '91000000-0000-4000-8000-000000000003',
  number: 3,
  name: 'Release',
  locked: true,
  lockedUntil: { number: 2, name: 'Screens' },
};
const W1: TaskWave = {
  id: '91000000-0000-4000-8000-000000000001',
  number: 1,
  name: 'Data',
  locked: false,
  lockedUntil: null,
};

beforeEach(() => {
  api.current = createFakeApi();
  resetFieldToastForTests();
  // PAY-3 and PAY-4 are Todo: PAY-3 in the locked W3, PAY-4 in the open W1.
  const pay3 = fake().tasks.find((task) => task.key === 'PAY-3');
  const pay4 = fake().tasks.find((task) => task.key === 'PAY-4');
  if (pay3) pay3.wave = W3;
  if (pay4) pay4.wave = W1;
});

afterEach(() => resetStartingForTests());

async function rows(...keys: string[]): Promise<TaskListItem[]> {
  const page = (await fake().client.tasks.list({ project: ['PAY'] })) as { items: TaskListItem[] };
  return keys.map((key) => page.items.find((item) => item.key === key) as TaskListItem);
}

function row(key: string, status: TaskStatus, wave: TaskWave | null): TaskListItem {
  return { key, status, wave, locked: [] } as unknown as TaskListItem;
}

const statusWrites = () => [
  ...fake().calls.update.filter((call) => call.status !== undefined),
  ...fake().calls.bulk.filter((call) => call.status !== undefined),
];

describe('the rule', () => {
  it('asks when a task in a locked wave starts, and only then', () => {
    const client = newQueryClient();
    expect(startsInLockedWave(row('PAY-1', 'todo', W3), 'in_progress')).toBe(true);
    expect(startsInLockedWave(row('PAY-1', 'backlog', W3), 'in_review')).toBe(true);
    // Not a start: already started, or moving elsewhere.
    expect(startsInLockedWave(row('PAY-1', 'in_progress', W3), 'in_review')).toBe(false);
    expect(startsInLockedWave(row('PAY-1', 'todo', W3), 'done')).toBe(false);
    // An open wave, no wave, a mirrored task.
    expect(startsInLockedWave(row('PAY-1', 'todo', W1), 'in_progress')).toBe(false);
    expect(startsInLockedWave(row('PAY-1', 'todo', null), 'in_progress')).toBe(false);
    expect(
      startsInLockedWave({ ...row('PAY-1', 'todo', W3), locked: ['status'] } as TaskListItem, 'in_progress'),
    ).toBe(false);
    expect(startingRequest(workspace.api, client, [row('PAY-1', 'todo', W3)], 'in_progress')).toEqual({
      kind: 'task',
      key: 'PAY-1',
      wave: W3,
      waitsFor: { number: 2, name: 'Screens' },
    });
    expect(
      startingRequest(
        workspace.api,
        client,
        [row('PAY-1', 'todo', W3), row('PAY-2', 'todo', W1), row('PAY-3', 'backlog', W3)],
        'in_progress',
      ),
    ).toEqual({ kind: 'tasks', status: 'in_progress', total: 3, locked: ['PAY-1', 'PAY-3'] });
  });

  it('never asks an agent: the server refuses it with WAVE_LOCKED', () => {
    const client = newQueryClient();
    client.setQueryData(meQuery(workspace.api).queryKey, { user: { kind: 'agent' } } as never);
    expect(startingRequest(workspace.api, client, [row('PAY-1', 'todo', W3)], 'in_progress')).toBeNull();
  });

  it('words the confirm for several tasks', () => {
    expect(manyStartingText('in_progress', 5, ['PAY-174', 'PAY-175'])).toEqual({
      title: '2 of 5 tasks are in a locked wave',
      body: 'PAY-174 and PAY-175 wait for an earlier gate to pass. Starting them now works ahead of the plan. Move all 5 to In progress anyway, or cancel to keep their status.',
    });
    expect(manyStartingText('in_review', 2, ['PAY-174']).title).toBe('1 of 2 tasks is in a locked wave');
  });
});

async function pickStatus(targets: TaskListItem | TaskListItem[], status: RegExp) {
  const user = userEvent.setup();
  const view = renderWith(
    workspace,
    <>
      <StatusPicker targets={targets} trigger={<Button>Open</Button>} />
      <StartGuardHost />
    </>,
  );
  await user.click(await screen.findByRole('button', { name: 'Open' }));
  const menu = await screen.findByRole('dialog', { name: 'Status' });
  await user.click(within(menu).getByRole('menuitemradio', { name: status }));
  return { user, ...view };
}

describe('a list row', () => {
  it('warns before starting a task in a locked wave; Cancel keeps the status', async () => {
    const [pay3] = await rows('PAY-3');
    const { user } = await pickStatus(pay3 as TaskListItem, /In progress/);
    const dialog = await screen.findByRole('alertdialog', { name: 'W3 is still locked' });
    expect(dialog).toHaveTextContent(
      'The gate of W2 · Screens hasn’t passed yet. Starting PAY-3 now works ahead of the plan, and its result may have to be redone.',
    );
    expect(dialog).toHaveTextContent('Agents can’t start tasks in a locked wave.');
    await user.click(within(dialog).getByRole('button', { name: 'Cancel' }));
    await waitFor(() => expect(screen.queryByRole('alertdialog')).toBeNull());
    expect(statusWrites()).toHaveLength(0);
  });

  it('starts it anyway with ⌘↵', async () => {
    const [pay3] = await rows('PAY-3');
    const { user } = await pickStatus(pay3 as TaskListItem, /In progress/);
    await screen.findByRole('alertdialog', { name: 'W3 is still locked' });
    await user.keyboard('{Control>}{Enter}{/Control}');
    await waitFor(() => expect(statusWrites().at(-1)).toMatchObject({ key: 'PAY-3', status: 'in_progress' }));
    expect(await screen.findByText('Moved PAY-3 to In progress')).toBeInTheDocument();
  });

  it('starts a task in an open wave at once', async () => {
    const [pay4] = await rows('PAY-4');
    await pickStatus(pay4 as TaskListItem, /In progress/);
    await waitFor(() => expect(statusWrites().at(-1)).toMatchObject({ key: 'PAY-4', status: 'in_progress' }));
    expect(screen.queryByRole('alertdialog')).toBeNull();
  });
});

describe('a selection', () => {
  it('asks once with how many are in locked waves, and Start anyway moves them all', async () => {
    const { user } = await pickStatus(await rows('PAY-3', 'PAY-4'), /In progress/);
    const dialog = await screen.findByRole('alertdialog', { name: '1 of 2 tasks is in a locked wave' });
    await user.click(within(dialog).getByRole('button', { name: /Start anyway/ }));
    await waitFor(() => expect(fake().calls.bulk).toHaveLength(1));
    expect(fake().calls.bulk[0]).toMatchObject({ keys: ['PAY-3', 'PAY-4'], status: 'in_progress' });
  });
});

/** Runs the palette's "Set status" step for the targets, as the palette would on Enter. */
function PaletteStatus({ targets, status }: { targets: TaskListItem[]; status: string }) {
  const { apply } = useFieldChange();
  const queryClient = useQueryClient();
  const run = async () => {
    const step = await fieldStep(workspace.api, 'status', {
      targets,
      apply,
      queryClient,
      context: targets[0]?.key ?? '',
      today: localToday(),
    });
    const command = step.commands.find((candidate: Command) => candidate.title === status);
    await command?.run();
  };
  return <Button onPress={() => void run()}>Run</Button>;
}

describe('the command palette', () => {
  it('reaches the same warning from its status step', async () => {
    const user = userEvent.setup();
    const [pay3] = await rows('PAY-3');
    renderWith(
      workspace,
      <>
        <PaletteStatus targets={[pay3 as TaskListItem]} status="In review" />
        <StartGuardHost />
      </>,
    );
    await user.click(screen.getByRole('button', { name: 'Run' }));
    const dialog = await screen.findByRole('alertdialog', { name: 'W3 is still locked' });
    await user.click(within(dialog).getByRole('button', { name: /Start anyway/ }));
    await waitFor(() => expect(statusWrites().at(-1)).toMatchObject({ key: 'PAY-3', status: 'in_review' }));
  });
});
