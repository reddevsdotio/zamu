import { useQueryClient } from '@tanstack/react-query';
import { configure, screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import type { Task, TaskListItem } from '@zamu/contracts';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { Command } from '~/features/palette/registry';
import { createFakeApi, type FakeApi } from '~/features/tasks/fake-api';
import { meQuery, taskQuery } from '~/features/tasks/queries';
import { FinishingHost, keyList, manyFinishingText } from '~/features/work-record/FinishingHost';
import { Button, localToday } from '~/ui';
import { useFieldChange } from './apply';
import { finishingRequest, hasOpenItems, resetFinishingForTests } from './finishing';
import { fieldStep } from './palette';
import { StatusPicker } from './StatusPicker';
import { newQueryClient, renderWith } from './test-utils';
import { resetFieldToastForTests } from './toast';

// The finishing warning outside the task view: the status picker on a row, a selection, and the
// command palette's status step all wait for it before a move to In review or Done.

configure({ asyncUtilTimeout: 5000 });
vi.setConfig({ testTimeout: 30_000 });

const api = vi.hoisted(() => ({ current: null as FakeApi | null }));

vi.mock('~/lib/orpc', async () => {
  const { createTanstackQueryUtils } = await import('@orpc/tanstack-query');
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
  return { client, orpc: createTanstackQueryUtils(client as never) };
});

const fake = () => api.current as FakeApi;

beforeEach(() => {
  api.current = createFakeApi({ workRecord: true });
  resetFieldToastForTests();
});

afterEach(() => resetFinishingForTests());

/** The rows the list shows: PAY-1 (in progress, 5 open), PAY-2 (in review, 2 open), PAY-3 (none open). */
async function rows(): Promise<TaskListItem[]> {
  const page = (await fake().client.tasks.list({ project: ['PAY'] })) as { items: TaskListItem[] };
  return ['PAY-1', 'PAY-2', 'PAY-3'].map(
    (key) => page.items.find((item) => item.key === key) as TaskListItem,
  );
}

function progress(open: number, total = 3) {
  return { settled: total - open, open, waived: 0, total };
}

function row(key: string, partial: Partial<TaskListItem> = {}): TaskListItem {
  return { key, status: 'in_progress', locked: [], ...partial } as unknown as TaskListItem;
}

describe('finishingRequest', () => {
  it('asks for In review and Done when a row counts open criteria or done items', () => {
    const client = newQueryClient();
    const open = row('PAY-1', { criteriaProgress: progress(1) });
    const doneOpen = row('PAY-2', { criteriaProgress: progress(0), doneProgress: progress(1, 2) });
    expect(finishingRequest(client, [open], 'in_review')).toEqual({
      kind: 'task',
      key: 'PAY-1',
      status: 'in_review',
    });
    expect(finishingRequest(client, [doneOpen], 'done')).toMatchObject({ kind: 'task', key: 'PAY-2' });
    expect(finishingRequest(client, [open], 'todo')).toBeNull();
    expect(finishingRequest(client, [open], 'canceled')).toBeNull();
  });

  it('lets a move through with nothing open, the same status, a mirrored task, or an agent signed in', () => {
    const client = newQueryClient();
    expect(finishingRequest(client, [row('PAY-1', { criteriaProgress: progress(0) })], 'done')).toBeNull();
    expect(finishingRequest(client, [row('PAY-1')], 'done')).toBeNull();
    expect(
      finishingRequest(client, [row('PAY-1', { status: 'done', criteriaProgress: progress(2) })], 'done'),
    ).toBeNull();
    expect(
      finishingRequest(client, [row('PAY-1', { locked: ['status'], criteriaProgress: progress(2) })], 'done'),
    ).toBeNull();
    client.setQueryData(meQuery().queryKey, { user: { kind: 'agent' } } as never);
    expect(finishingRequest(client, [row('PAY-1', { criteriaProgress: progress(2) })], 'done')).toBeNull();
  });

  it('reads the cached full task over the row, and counts a selection', () => {
    const client = newQueryClient();
    const stale = row('PAY-1', { criteriaProgress: progress(1) });
    const full = {
      ...stale,
      criteria: [{ number: 1, text: 'Retries', state: 'checked', waivedReason: null, waivedBy: null }],
      doneItems: [],
    } as unknown as Task;
    client.setQueryData(taskQuery('PAY-1').queryKey, full);
    expect(hasOpenItems(full)).toBe(false);
    expect(finishingRequest(client, [stale], 'done')).toBeNull();

    const selection = [
      stale,
      row('PAY-2', { criteriaProgress: progress(2) }),
      row('PAY-3', { doneProgress: progress(1) }),
      row('PAY-4', { status: 'done', criteriaProgress: progress(1) }),
    ];
    expect(finishingRequest(client, selection, 'done')).toEqual({
      kind: 'tasks',
      status: 'done',
      total: 3,
      withOpenItems: ['PAY-2', 'PAY-3'],
    });
  });
});

describe('the words of the confirm for several tasks', () => {
  it('names the tasks with open items and how many move', () => {
    expect(keyList(['PAY-1'])).toBe('PAY-1');
    expect(keyList(['PAY-1', 'PAY-2'])).toBe('PAY-1 and PAY-2');
    expect(keyList(['PAY-1', 'PAY-2', 'PAY-3'])).toBe('PAY-1, PAY-2 and PAY-3');
    expect(keyList(['PAY-1', 'PAY-2', 'PAY-3', 'PAY-4', 'PAY-5'])).toBe('PAY-1, PAY-2 and 3 more');
    expect(manyFinishingText('done', 5, ['PAY-1', 'PAY-2'])).toEqual({
      title: '2 of 5 tasks have open items',
      body: 'PAY-1 and PAY-2 have criteria or done items that are not checked or waived. Move all 5 to Done anyway, or cancel to keep their status.',
    });
    expect(manyFinishingText('in_review', 3, ['PAY-4']).title).toBe('1 of 3 tasks has open items');
    expect(manyFinishingText('in_review', 1, ['PAY-4']).title).toBe('PAY-4 has open items');
  });
});

async function pickStatus(targets: TaskListItem | TaskListItem[], status: RegExp) {
  const user = userEvent.setup();
  const view = renderWith(
    <>
      <StatusPicker targets={targets} trigger={<Button>Open</Button>} />
      <FinishingHost />
    </>,
  );
  await user.click(await screen.findByRole('button', { name: 'Open' }));
  const menu = await screen.findByRole('dialog', { name: 'Status' });
  await user.click(within(menu).getByRole('menuitemradio', { name: status }));
  return { user, ...view };
}

const statusWrites = () => fake().calls.update.filter((call) => call.status !== undefined);

describe('the status picker on a row', () => {
  it('opens the finishing dialog with the open items, and Cancel keeps the status', async () => {
    const [pay1] = await rows();
    const { user, queryClient } = await pickStatus(pay1 as TaskListItem, /In review/);
    const dialog = await screen.findByRole('dialog', { name: '5 items are still open' });
    expect(dialog).toHaveTextContent('PAY-1 is moving to In review.');
    expect(within(dialog).getAllByRole('checkbox')).toHaveLength(5);
    await user.click(within(dialog).getByRole('button', { name: 'Cancel' }));
    await waitFor(() => expect(screen.queryByRole('dialog')).toBeNull());
    expect(statusWrites()).toHaveLength(0);
    expect(queryClient.getQueryData(taskQuery('PAY-1').queryKey)?.status).toBe('in_progress');
  });

  it('checks an item in place and moves anyway with Mod+Enter', async () => {
    const [pay1] = await rows();
    const { user } = await pickStatus(pay1 as TaskListItem, /Done/);
    const dialog = await screen.findByRole('dialog', { name: /still open/ });
    await waitFor(() => expect(within(dialog).getAllByRole('checkbox')[0]).toHaveFocus());
    await user.keyboard('x');
    await waitFor(() => expect(fake().calls.update.at(-1)).toEqual({ key: 'PAY-1', checkCriteria: [1] }));
    await user.keyboard('{Control>}{Enter}{/Control}');
    await waitFor(() => expect(statusWrites().at(-1)).toMatchObject({ key: 'PAY-1', status: 'done' }));
    expect(await screen.findByText('Moved PAY-1 to Done')).toBeInTheDocument();
  });

  it('stays open when the last item is settled, until the person moves', async () => {
    const [pay1] = await rows();
    const { user } = await pickStatus(pay1 as TaskListItem, /Done/);
    const dialog = await screen.findByRole('dialog', { name: '5 items are still open' });
    await waitFor(() => expect(within(dialog).getAllByRole('checkbox')[0]).toHaveFocus());
    for (let line = 0; line < 5; line += 1) {
      await user.keyboard('x');
      await user.keyboard('{ArrowDown}');
    }
    expect(
      await screen.findByRole('dialog', { name: 'Every item is checked or waived' }),
    ).toBeInTheDocument();
    expect(statusWrites()).toHaveLength(0);
    await user.click(screen.getByRole('button', { name: /Move to Done/ }));
    await waitFor(() => expect(statusWrites().at(-1)).toMatchObject({ key: 'PAY-1', status: 'done' }));
  });

  it('moves at once when the row has nothing open', async () => {
    const [, , pay3] = await rows();
    await pickStatus(pay3 as TaskListItem, /Done/);
    await waitFor(() => expect(statusWrites().at(-1)).toMatchObject({ key: 'PAY-3', status: 'done' }));
    expect(screen.queryByRole('dialog', { name: /still open/ })).toBeNull();
  });
});

describe('a selection', () => {
  it('asks once with the count, and Cancel sends nothing', async () => {
    const { user } = await pickStatus(await rows(), /Done/);
    const dialog = await screen.findByRole('alertdialog', { name: '2 of 3 tasks have open items' });
    expect(dialog).toHaveTextContent(
      'PAY-1 and PAY-2 have criteria or done items that are not checked or waived. Move all 3 to Done anyway, or cancel to keep their status.',
    );
    expect(screen.queryByRole('dialog', { name: /still open/ })).toBeNull();
    await user.click(within(dialog).getByRole('button', { name: 'Cancel' }));
    await waitFor(() => expect(screen.queryByRole('alertdialog')).toBeNull());
    expect(fake().calls.bulk).toHaveLength(0);
  });

  it('moves every selected task with Move anyway', async () => {
    const { user } = await pickStatus(await rows(), /In review/);
    // PAY-2 is in review already: two tasks move, one of them with open items.
    const dialog = await screen.findByRole('alertdialog', { name: '1 of 2 tasks has open items' });
    await user.click(within(dialog).getByRole('button', { name: /Move anyway/ }));
    await waitFor(() => expect(fake().calls.bulk).toHaveLength(1));
    expect(fake().calls.bulk[0]).toMatchObject({ keys: ['PAY-1', 'PAY-3'], status: 'in_review' });
  });
});

/** Runs the palette's "Set status" step for the targets, as the palette would on Enter. */
function PaletteStatus({ targets, status }: { targets: TaskListItem[]; status: string }) {
  const { apply } = useFieldChange();
  const queryClient = useQueryClient();
  const run = async () => {
    const step = await fieldStep('status', {
      targets,
      apply,
      queryClient,
      context: targets.length === 1 ? (targets[0]?.key ?? '') : `${targets.length} selected`,
      today: localToday(),
    });
    const command = step.commands.find((candidate: Command) => candidate.title === status);
    await command?.run();
  };
  return <Button onPress={() => void run()}>Run</Button>;
}

describe('the command palette', () => {
  it('reaches the same dialog from its status step', async () => {
    const user = userEvent.setup();
    const [pay1] = await rows();
    renderWith(
      <>
        <PaletteStatus targets={[pay1 as TaskListItem]} status="In review" />
        <FinishingHost />
      </>,
    );
    await user.click(screen.getByRole('button', { name: 'Run' }));
    const dialog = await screen.findByRole('dialog', { name: '5 items are still open' });
    await user.click(within(dialog).getByRole('button', { name: /Move to In review/ }));
    await waitFor(() => expect(statusWrites().at(-1)).toMatchObject({ key: 'PAY-1', status: 'in_review' }));
  });
});
