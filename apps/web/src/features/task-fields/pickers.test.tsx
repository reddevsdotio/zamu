import { ORPCError } from '@orpc/client';
import { act, configure, getConfig, screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { createFakeApi, type FakeApi } from '~/features/tasks/fake-api';
import { taskQuery } from '~/features/tasks/queries';
import { testWorkspace } from '~/lib/testing';
import { localToday } from '~/ui';
import { AssigneePicker } from './AssigneePicker';
import { BlockerPicker } from './BlockerPicker';
import { DuePicker } from './DuePicker';
import { addDays } from './dates';
import { LabelPicker } from './LabelPicker';
import { ParentPicker } from './ParentPicker';
import { CyclePicker, MilestonePicker } from './PlanningPickers';
import { PriorityPicker, StatusPicker } from './StatusPicker';
import { SubtaskPicker } from './SubtaskPicker';
import { renderWith, WiredPicker } from './test-utils';
import { resetFieldToastForTests } from './toast';

configure({ asyncUtilTimeout: 5000 });

// React Aria's virtual focus (search field keeps focus, results get aria-activedescendant) sends the
// search field a synthetic blur from an effect when results render. user-event answers the blur of a
// typed-in field with a change event wrapped in act(), and React refuses act() while it flushes those
// effects ("Should not already be working."). The change event itself has run by then; only the
// nested flush fails, so that one error is dropped here. Browsers have no act().
const { eventWrapper } = getConfig();
configure({
  eventWrapper: (callback) => {
    let result: unknown;
    try {
      eventWrapper(() => {
        result = callback();
      });
    } catch (error) {
      if (!(error instanceof Error && error.message === 'Should not already be working.')) throw error;
    }
    return result;
  },
});
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

beforeEach(() => {
  api.current = createFakeApi({ fields: true });
  resetFieldToastForTests();
});

const fake = () => api.current as FakeApi;

async function openPicker(Picker: Parameters<typeof WiredPicker>[0]['Picker'], taskKey = 'PAY-1') {
  const user = userEvent.setup();
  const view = renderWith(workspace, <WiredPicker taskKey={taskKey} Picker={Picker} />);
  await user.click(await screen.findByRole('button', { name: 'Open' }));
  const dialog = await screen.findByRole('dialog');
  return { user, dialog, ...view };
}

/**
 * Lets search results arrive inside act(), so the virtual focus settles on the first result.
 */
async function settle() {
  await act(async () => {
    await new Promise((resolve) => setTimeout(resolve, 50));
  });
}

describe('status and priority', () => {
  it('picks a status with a number key, shows it at once, and undoes it', async () => {
    const { user, dialog, queryClient } = await openPicker(StatusPicker);
    expect(within(dialog).getByRole('menuitemradio', { name: /In progress/ })).toHaveAttribute(
      'aria-checked',
      'true',
    );
    await user.keyboard('4');
    expect(queryClient.getQueryData(taskQuery(workspace.api, 'PAY-1').queryKey)?.status).toBe('in_review');
    await waitFor(() => expect(screen.queryByRole('dialog')).toBeNull());
    expect(fake().calls.update.at(-1)).toMatchObject({ key: 'PAY-1', status: 'in_review' });
    const toast = await screen.findByText('Moved PAY-1 to In review');
    await user.click(
      within(toast.closest('[role="status"]') as HTMLElement).getByRole('button', { name: 'Undo' }),
    );
    await waitFor(() =>
      expect(fake().calls.update.at(-1)).toMatchObject({ key: 'PAY-1', status: 'in_progress' }),
    );
    expect(await screen.findByText('Moved PAY-1 to In progress')).toBeInTheDocument();
  });

  it('undoes with ⌘Z while the toast shows', async () => {
    const { user } = await openPicker(PriorityPicker);
    await user.keyboard('1');
    await screen.findByText('Set PAY-1 to Urgent priority');
    const before = fake().calls.update.length;
    await user.keyboard('{Control>}z{/Control}');
    await waitFor(() => expect(fake().calls.update.length).toBe(before + 1));
    expect(fake().calls.update.at(-1)).toMatchObject({ key: 'PAY-1', priority: 'none' });
  });

  it('rolls back when the server refuses, and says why', async () => {
    fake().control.failNext = new ORPCError('UNPROCESSABLE_CONTENT', { message: 'Status is not allowed' });
    const { user, queryClient } = await openPicker(StatusPicker);
    await user.keyboard('5');
    expect(await screen.findByText("Couldn't change PAY-1. Status is not allowed")).toBeInTheDocument();
    expect(queryClient.getQueryData(taskQuery(workspace.api, 'PAY-1').queryKey)?.status).toBe('in_progress');
  });

  it('opens read-only on a mirrored task and changes nothing', async () => {
    const task = fake().tasks[0];
    if (task) task.locked = ['status', 'priority', 'assignee', 'labels', 'dueDate', 'blockedBy', 'parent'];
    const { user, dialog } = await openPicker(StatusPicker);
    expect(within(dialog).getByRole('note')).toHaveTextContent('Read-only: fields come from Backlog.md');
    await user.click(within(dialog).getByRole('menuitemradio', { name: /Todo/ }));
    // Number keys don't pick either: they type into the search.
    await user.keyboard('2');
    expect(fake().calls.update).toHaveLength(0);
    expect(screen.getByRole('dialog')).toBeInTheDocument();
  });
});

describe('assignee', () => {
  it('lists no assignee, you first, and agents for their person; 0 unassigns', async () => {
    const { user, dialog } = await openPicker(AssigneePicker);
    const items = within(dialog).getAllByRole('menuitemradio');
    expect(items.map((item) => item.textContent)).toEqual([
      expect.stringContaining('No assignee'),
      expect.stringContaining('Ana Ruiz'),
      expect.stringContaining('Tomás Berg'),
      expect.stringContaining('claude-dev'),
    ]);
    expect(items[1]).toHaveTextContent('you');
    expect(items[3]).toHaveTextContent('for Ana');
    expect(items[3]).toHaveAttribute('aria-checked', 'true');
    await user.keyboard('0');
    await waitFor(() => expect(fake().calls.update.at(-1)).toMatchObject({ key: 'PAY-1', assignee: null }));
  });
});

describe('labels', () => {
  it('toggles labels with Enter and stays open', async () => {
    const { user, dialog } = await openPicker(LabelPicker);
    await waitFor(() => expect(within(dialog).getByText('On this task')).toBeInTheDocument());
    expect(within(dialog).getByText('All labels in Payments · 5')).toBeInTheDocument();
    expect(within(dialog).getByText('2 selected')).toBeInTheDocument();
    await user.keyboard('api');
    expect(within(dialog).getByText('1 match')).toBeInTheDocument();
    await user.keyboard('{ArrowDown}{Enter}');
    await waitFor(() =>
      expect(fake().calls.update.at(-1)).toMatchObject({ key: 'PAY-1', addLabels: ['api'] }),
    );
    expect(screen.getByRole('dialog')).toBeInTheDocument();
    await user.clear(within(dialog).getByRole('searchbox'));
    await user.click(within(dialog).getByRole('menuitemcheckbox', { name: /payouts/ }));
    await waitFor(() => expect(fake().calls.update.at(-1)).toMatchObject({ removeLabels: ['payouts'] }));
    expect(screen.getByRole('dialog')).toBeInTheDocument();
  });

  it('creates a label with a colour picked by Tab and adds it', async () => {
    const { user, dialog } = await openPicker(LabelPicker);
    await waitFor(() => expect(within(dialog).getByText('On this task')).toBeInTheDocument());
    await user.keyboard('billing');
    expect(within(dialog).getByText('No label named “billing” in Payments')).toBeInTheDocument();
    expect(within(dialog).getByText(/Labels named “billing” in other projects/)).toBeInTheDocument();
    await user.tab();
    expect(document.activeElement).toHaveAttribute('type', 'radio');
    await user.keyboard('{ArrowRight}{Enter}');
    await waitFor(() => expect(fake().calls.update.at(-1)).toMatchObject({ addLabels: ['billing'] }));
    const created = fake().calls.labels.find((call) => call.op === 'create');
    expect(created).toMatchObject({ project: 'PAY', name: 'billing' });
    expect(typeof created?.color).toBe('number');
    expect(fake().labels.some((label) => label.name === 'billing')).toBe(true);
  });
});

describe('due date', () => {
  it('reads a typed date and sets it on Enter', async () => {
    const { user, dialog } = await openPicker(DuePicker);
    await user.keyboard('tomorrow');
    expect(within(dialog).getAllByRole('menuitem')).toHaveLength(1);
    await user.keyboard('{Enter}');
    await waitFor(() =>
      expect(fake().calls.update.at(-1)).toMatchObject({ key: 'PAY-1', dueDate: addDays(localToday(), 1) }),
    );
  });

  it('clears the due date', async () => {
    const { user, dialog } = await openPicker(DuePicker);
    expect(within(dialog).getByText(/^Now: /)).toBeInTheDocument();
    await user.click(within(dialog).getByRole('button', { name: /Clear due date/ }));
    await waitFor(() => expect(fake().calls.update.at(-1)).toMatchObject({ dueDate: null }));
  });
});

describe('blockers', () => {
  it('refuses a loop: from the task view right away, and from the server under the result', async () => {
    // PAY-2 waits on PAY-3 (sample); PAY-4 waits on PAY-2, so PAY-3 can't wait on PAY-4 either.
    fake().blockers.set('PAY-4', ['PAY-2']);
    const { user, dialog } = await openPicker(BlockerPicker, 'PAY-3');
    await settle();
    await user.keyboard('PAY-2');
    await settle();
    const direct = await within(dialog).findByRole('menuitem', { name: /Task number 2/ });
    expect(direct).toHaveTextContent('Can’t add: PAY-2 already waits on PAY-3.');
    await user.keyboard('{ArrowDown}{Enter}');
    expect(fake().calls.update).toHaveLength(0);

    await user.clear(within(dialog).getByRole('searchbox'));
    await settle();
    await user.keyboard('PAY-4');
    await settle();
    await user.click(await within(dialog).findByRole('menuitem', { name: /Task number 4/ }));
    await settle();
    await waitFor(() => expect(fake().calls.update.at(-1)).toMatchObject({ addBlockers: ['PAY-4'] }));
    expect(await within(dialog).findByText('Can’t add: PAY-4 already waits on PAY-3.')).toBeInTheDocument();
    expect(screen.getByRole('dialog')).toBeInTheDocument();
    expect(screen.queryByText(/Couldn't change/)).toBeNull();
  });

  it('adds and removes blockers and keeps the current ones while searching', async () => {
    const { user, dialog } = await openPicker(BlockerPicker, 'PAY-2');
    expect(await within(dialog).findByText('Blocked by')).toBeInTheDocument();
    expect(within(dialog).getByText('Only tasks in Payments')).toBeInTheDocument();
    await user.keyboard('PAY-1');
    await settle();
    await user.click(await within(dialog).findByRole('menuitem', { name: /Task number 1/ }));
    await settle();
    await waitFor(() =>
      expect(fake().calls.update.at(-1)).toMatchObject({ key: 'PAY-2', addBlockers: ['PAY-1'] }),
    );
    await waitFor(() => expect(fake().blockers.get('PAY-2')).toEqual(['PAY-3', 'PAY-1']));
    const current = await within(dialog).findByRole('menuitem', { name: /Task number 3/ });
    await user.click(current.querySelector('[data-remove]') as HTMLElement);
    await settle();
    await waitFor(() => expect(fake().calls.update.at(-1)).toMatchObject({ removeBlockers: ['PAY-3'] }));
  });
});

describe('subtasks', () => {
  it('creates a subtask from the typed text with ⌘Enter and says who it goes to', async () => {
    const { user, dialog } = await openPicker(SubtaskPicker, 'PAY-1');
    await settle();
    await user.keyboard('Alert copy');
    await settle();
    expect(
      within(dialog).getByText(/New subtasks are assigned to claude-dev, like PAY-1/),
    ).toBeInTheDocument();
    await user.keyboard('{Meta>}{Enter}{/Meta}');
    await waitFor(() =>
      expect(fake().calls.create.at(-1)).toMatchObject({
        project: 'PAY',
        title: 'Alert copy',
        parent: 'PAY-1',
      }),
    );
    expect(await screen.findByText(/Created PAY-7 under PAY-1/)).toBeInTheDocument();
    expect(fake().tasks.at(-1)?.assignee?.name).toBe('claude-dev');
  });

  it('adds an existing top-level task, leaving out tasks with a parent', async () => {
    const { user, dialog } = await openPicker(SubtaskPicker, 'PAY-1');
    await waitFor(() => expect(within(dialog).getByText('Add an existing task')).toBeInTheDocument());
    expect(within(dialog).queryByRole('menuitem', { name: /Task number 5/ })).toBeNull();
    await user.click(within(dialog).getByRole('menuitem', { name: /Task number 3/ }));
    await waitFor(() => expect(fake().calls.update.at(-1)).toMatchObject({ key: 'PAY-3', parent: 'PAY-1' }));
    expect(await screen.findByText('Made PAY-3 a subtask of PAY-1')).toBeInTheDocument();
  });
});

describe('parent', () => {
  it('sets an open top-level task of the project as the parent', async () => {
    const { user, dialog } = await openPicker(ParentPicker, 'PAY-3');
    await settle();
    expect(within(dialog).getByText('Only tasks in Payments')).toBeInTheDocument();
    // Not itself, not a subtask (PAY-5 sits under PAY-1), and no "No parent" while it has none.
    expect(within(dialog).queryByRole('menuitemradio', { name: /Task number 3/ })).toBeNull();
    expect(within(dialog).queryByRole('menuitemradio', { name: /Task number 5/ })).toBeNull();
    expect(within(dialog).queryByRole('menuitemradio', { name: 'No parent' })).toBeNull();
    await user.click(await within(dialog).findByRole('menuitemradio', { name: /Task number 2/ }));
    await waitFor(() => expect(fake().calls.update.at(-1)).toMatchObject({ key: 'PAY-3', parent: 'PAY-2' }));
    expect(await screen.findByText('Made PAY-3 a subtask of PAY-2')).toBeInTheDocument();
    await waitFor(() => expect(screen.queryByRole('dialog')).toBeNull());
  });

  it('clears the parent with No parent', async () => {
    const { user, dialog } = await openPicker(ParentPicker, 'PAY-5');
    await settle();
    await user.click(await within(dialog).findByRole('menuitemradio', { name: 'No parent' }));
    await waitFor(() => expect(fake().calls.update.at(-1)).toMatchObject({ key: 'PAY-5', parent: null }));
    expect(await screen.findByText('Made PAY-5 a top-level task')).toBeInTheDocument();
  });

  it('says why a task with subtasks takes no parent', async () => {
    const { dialog } = await openPicker(ParentPicker, 'PAY-1');
    expect(
      await within(dialog).findByText('PAY-1 has subtasks. Subtasks go one level deep.'),
    ).toBeInTheDocument();
  });

  it('shows a refusal from the server under the result and stays open', async () => {
    fake().control.failNext = new ORPCError('NOT_SAME_PROJECT', {
      status: 422,
      message: 'Different projects',
    });
    const { user, dialog } = await openPicker(ParentPicker, 'PAY-3');
    await settle();
    await user.click(await within(dialog).findByRole('menuitemradio', { name: /Task number 2/ }));
    expect(await within(dialog).findByText('Can’t set: PAY-2 is in another project.')).toBeInTheDocument();
    expect(screen.getByRole('dialog')).toBeInTheDocument();
    expect(screen.queryByText(/Couldn't change/)).toBeNull();
  });
});

describe('milestone and cycle', () => {
  it('sets a milestone and a cycle', async () => {
    const { user, dialog } = await openPicker(MilestonePicker);
    await user.click(await within(dialog).findByRole('menuitemradio', { name: /Webhooks v2/ }));
    await waitFor(() => expect(fake().calls.update.at(-1)).toMatchObject({ milestone: expect.any(String) }));
    await act(async () => {});
  });

  it('sets a cycle', async () => {
    const { user, dialog } = await openPicker(CyclePicker);
    await user.click(await within(dialog).findByRole('menuitemradio', { name: /Cycle 12/ }));
    await waitFor(() => expect(fake().calls.update.at(-1)).toMatchObject({ cycle: 12 }));
  });
});
