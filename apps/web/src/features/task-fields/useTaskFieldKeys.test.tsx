import { useQuery } from '@tanstack/react-query';
import { act, configure, screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import type { Task, TaskListItem } from '@zamu/contracts';
import { useRef } from 'react';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import {
  type Command,
  resetPaletteForTests,
  usePaletteOpen,
  useRegisteredCommands,
} from '~/features/palette/registry';
import { createFakeApi, type FakeApi } from '~/features/tasks/fake-api';
import { taskListQuery } from '~/features/tasks/queries';
import { testWorkspace } from '~/lib/testing';
import { renderWith } from './test-utils';
import { resetFieldToastForTests } from './toast';
import { type UseTaskFieldKeysOptions, useTaskFieldKeys } from './useTaskFieldKeys';

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

beforeEach(() => {
  api.current = createFakeApi({ fields: true });
  resetPaletteForTests();
  resetFieldToastForTests();
});

/** A list screen in miniature: the selected rows, a focused row as the anchor, the palette's state. */
function Screen({ keys, anchored = true }: { keys: string[]; anchored?: boolean }) {
  const list = useQuery(taskListQuery(workspace.api, { project: ['PAY'] })).data;
  const targets = (list?.items ?? []).filter((item) => keys.includes(item.key));
  const row = useRef<HTMLDivElement>(null);
  const options: UseTaskFieldKeysOptions = { targets, ...(anchored ? { anchors: row } : {}) };
  const fields = useTaskFieldKeys(options);
  const commands = useRegisteredCommands();
  const palette = usePaletteOpen();
  return (
    <div>
      <p data-testid="text">Some text to copy</p>
      <div ref={row} data-testid="row">
        {targets.map((task: TaskListItem | Task) => (
          <span key={task.key}>
            {task.key} {task.status} {task.assignee?.name ?? 'nobody'}
          </span>
        ))}
      </div>
      <ul aria-label="Commands">
        {commands.map((command) => (
          <li key={command.id} data-shortcut={command.shortcut} data-context={command.context}>
            {command.title}
            {command.disabledReason ? ` (${command.disabledReason})` : ''}
          </li>
        ))}
      </ul>
      {palette?.kind === 'step' ? <p>Palette step: {palette.step.title}</p> : null}
      {fields.pickers}
    </div>
  );
}

async function renderScreen(keys: string[], anchored = true) {
  const user = userEvent.setup();
  renderWith(workspace, <Screen keys={keys} anchored={anchored} />);
  await screen.findByText(new RegExp(`^${keys[0]} `));
  return user;
}

describe('task keys', () => {
  it('S opens the status picker over the row; a number key sets it', async () => {
    const user = await renderScreen(['PAY-1']);
    await user.keyboard('s');
    const dialog = await screen.findByRole('dialog', { name: 'Status' });
    await user.keyboard('5');
    await waitFor(() => expect(fake().calls.update.at(-1)).toMatchObject({ key: 'PAY-1', status: 'done' }));
    expect(screen.queryByRole('dialog')).toBeNull();
    expect(dialog).not.toBeInTheDocument();
    expect(await screen.findByText('Moved PAY-1 to Done')).toBeInTheDocument();
  });

  it('I assigns to me; ⌘C copies the key when no text is highlighted', async () => {
    const user = await renderScreen(['PAY-2']);
    await user.keyboard('i');
    await waitFor(() =>
      expect(fake().calls.update.at(-1)).toMatchObject({
        key: 'PAY-2',
        assignee: fake().tasks[0]?.createdBy.id,
      }),
    );
    await user.keyboard('{Control>}c{/Control}');
    expect(await screen.findByText('Copied PAY-2')).toBeInTheDocument();
    await expect(navigator.clipboard.readText()).resolves.toBe('PAY-2');
  });

  it('⌘C leaves highlighted text to the browser', async () => {
    const user = await renderScreen(['PAY-2']);
    const range = document.createRange();
    range.selectNodeContents(screen.getByTestId('text'));
    window.getSelection()?.removeAllRanges();
    window.getSelection()?.addRange(range);
    await user.keyboard('{Control>}c{/Control}');
    await act(async () => {});
    expect(screen.queryByText('Copied PAY-2')).toBeNull();
    window.getSelection()?.removeAllRanges();
  });

  it('opens the palette at the step when the screen has no anchor', async () => {
    const user = await renderScreen(['PAY-1'], false);
    await user.keyboard('{Shift>}d{/Shift}');
    expect(await screen.findByText('Palette step: Set due date')).toBeInTheDocument();
  });

  it('acts on a selection in one request, and leaves out Shift+S', async () => {
    const user = await renderScreen(['PAY-1', 'PAY-2', 'PAY-3']);
    await user.keyboard('p');
    await screen.findByRole('dialog', { name: 'Priority' });
    await user.keyboard('2');
    // PAY-2 is High already: only the other two change.
    await waitFor(() =>
      expect(fake().calls.bulk.at(-1)).toEqual({ keys: ['PAY-3', 'PAY-1'], priority: 'high' }),
    );
    expect(await screen.findByText('Set 2 tasks to High priority')).toBeInTheDocument();
    await user.keyboard('{Shift>}s{/Shift}');
    expect(screen.queryByRole('dialog')).toBeNull();
  });

  it('refuses keys on a selection with a mirrored task and says why', async () => {
    const pay2 = fake().tasks[1];
    if (pay2) pay2.locked = ['status', 'priority'];
    const user = await renderScreen(['PAY-1', 'PAY-2']);
    await user.keyboard('s');
    expect(
      await screen.findByText(
        'Read-only: 1 of 2 selected tasks come from Backlog.md. Change those in the files.',
      ),
    ).toBeInTheDocument();
    expect(screen.queryByRole('dialog')).toBeNull();
    expect(fake().calls.bulk).toHaveLength(0);
  });
});

describe('palette commands', () => {
  it('registers the task actions with their keys and the task as context', async () => {
    await renderScreen(['PAY-1']);
    const commands = within(screen.getByRole('list', { name: 'Commands' })).getAllByRole('listitem');
    expect(commands.map((item) => item.textContent)).toEqual([
      'Change status',
      'Set priority',
      'Assign',
      'Add labels',
      'Set due date',
      'Move to milestone',
      'Add to cycle',
      'Add blocker',
      'Add subtask',
      'Set parent…',
      'Assign to me',
      'Copy key',
      'Copy link',
    ]);
    expect(commands[0]).toHaveAttribute('data-shortcut', 's');
    expect(commands[4]).toHaveAttribute('data-shortcut', 'Shift+d');
    expect(commands[0]).toHaveAttribute('data-context', 'PAY-1');
  });

  it('says "3 selected" and disables actions on mirrored selections', async () => {
    const pay2 = fake().tasks[1];
    if (pay2) pay2.locked = ['status'];
    await renderScreen(['PAY-1', 'PAY-2', 'PAY-3']);
    const list = screen.getByRole('list', { name: 'Commands' });
    const status = within(list).getByText(/^Change status/);
    expect(status).toHaveAttribute('data-context', '3 selected');
    expect(status).toHaveTextContent('Read-only: 1 of 3 selected tasks come from Backlog.md');
    expect(within(list).queryByText('Add subtask')).toBeNull();
    expect(within(list).getByText('Copy 3 keys')).toBeInTheDocument();
  });

  it('runs a step from the palette', async () => {
    renderWith(
      workspace,
      <>
        <Screen keys={['PAY-1']} />
        <CommandsSpy />
      </>,
    );
    await screen.findByText(/^PAY-1 /);
    const status = spied.find((command) => command.id === 'task.status');
    const step = await status?.run();
    expect(step?.title).toBe('Set status');
    expect(step?.commands.map((command) => command.title)).toEqual([
      'Backlog',
      'Todo',
      'In progress',
      'In review',
      'Done',
      'Canceled',
    ]);
    expect(step?.commands[3]?.shortcut).toBe('4');
    await act(async () => {
      await step?.commands[3]?.run();
    });
    await waitFor(() =>
      expect(fake().calls.update.at(-1)).toMatchObject({ key: 'PAY-1', status: 'in_review' }),
    );
    const labels = await spied.find((command) => command.id === 'task.labels')?.run();
    expect(labels?.commands.map((command) => command.title)).toEqual([
      'Add api',
      'Remove backend',
      'Remove payouts',
      'Add refunds',
      'Add reliability',
    ]);
  });
});

let spied: readonly Command[] = [];
function CommandsSpy() {
  spied = useRegisteredCommands();
  return null;
}

it('unregisters the commands on unmount', async () => {
  const view = renderWith(workspace, <Screen keys={['PAY-1']} />);
  await screen.findByText(/^PAY-1 /);
  view.unmount();
  const spy = renderWith(workspace, <CommandsSpy />);
  expect(spied).toEqual([]);
  spy.unmount();
});
