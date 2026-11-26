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
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { clearCommentDrafts } from '~/features/comments/CommentComposer';
import { resetTimelinePreferences } from '~/features/comments/TaskTimeline';
import { resetFieldToastForTests, TaskFieldToast } from '~/features/task-fields/toast';
import { createFakeApi, FAKE_DEFAULT_DONE_ITEMS, FAKE_PEOPLE, type FakeApi } from '~/features/tasks/fake-api';
import { resetFromFile } from '~/features/tasks/MirroredTask';
import { TaskPage } from '~/features/tasks/TaskPage';
import { testWorkspace } from '~/lib/testing';
import { WorkspaceProvider } from '~/lib/workspace';
import { UIProvider } from '~/ui';
import { FinishingHost } from './FinishingHost';

// The work record in the task view (M6-07), against the in-memory /api/v1 client: the order of the
// sections, every edit of criteria and done items with its keys, the finishing step, the timeline's
// filters and notes, the composer's note mode, the plan, and the read-only mirrored view.

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

function renderApp(url: string) {
  const queryClient = new QueryClient({
    defaultOptions: { queries: { retry: false, refetchOnWindowFocus: false, refetchInterval: false } },
  });
  const root = createRootRoute({
    component: () => (
      <UIProvider>
        <Outlet />
        <TaskFieldToast />
        <FinishingHost />
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

const criteria = () => screen.getByRole('group', { name: 'Acceptance criteria' });
const doneItems = () => screen.getByRole('group', { name: 'Definition of done' });
const line = (name: string | RegExp) => within(criteria()).getByRole('checkbox', { name });
const history = () => screen.getByRole('region', { name: 'Activity' });
const properties = () => screen.getByRole('complementary', { name: 'Properties' });
const lastUpdate = () => fake().calls.update.at(-1);

async function openTask(key: string) {
  renderApp(`/w/acme/p/PAY/${key}`);
  await screen.findByRole('heading', { level: 1 });
  const region = await screen.findByRole('region', { name: 'Activity' });
  await waitFor(() => expect(within(region).getAllByRole('listitem').length).toBeGreaterThan(0));
}

/** jsdom lays nothing out: make every clipped block read as taller than its cut. */
function longContent() {
  vi.spyOn(HTMLElement.prototype, 'scrollHeight', 'get').mockReturnValue(500);
}

beforeEach(() => {
  api.current = createFakeApi({ workRecord: true });
  window.sessionStorage.clear();
  clearCommentDrafts();
  resetTimelinePreferences();
  resetFromFile();
  resetFieldToastForTests();
});

afterEach(() => {
  vi.restoreAllMocks();
});

describe('order and reading', () => {
  it('reads title, summary, description, criteria, done items, plan, relations, activity', async () => {
    (fake().tasks[1] as Task).description = 'Payouts that fail at the provider are dropped today.';
    longContent();
    await openTask('PAY-2');
    const labels = [
      ...document.querySelectorAll(
        'article h1, article section[aria-label], article section[aria-labelledby]',
      ),
    ].map((element) =>
      element.tagName === 'H1'
        ? 'title'
        : (element.getAttribute('aria-label') ??
          document.getElementById(element.getAttribute('aria-labelledby') ?? '')?.textContent),
    );
    expect(labels).toEqual([
      'title',
      'Summary',
      'Acceptance criteria',
      'Definition of done',
      'Plan',
      'Subtasks',
      'Blocked by',
      'Activity',
    ]);
    // The description sits between the summary and the criteria, clipped to two lines.
    const summary = screen.getByRole('region', { name: 'Summary' });
    const description = screen.getByText('Payouts that fail at the provider are dropped today.');
    expect(summary.compareDocumentPosition(description) & Node.DOCUMENT_POSITION_FOLLOWING).toBeTruthy();
    expect(description.compareDocumentPosition(criteria()) & Node.DOCUMENT_POSITION_FOLLOWING).toBeTruthy();
    expect(screen.getByRole('button', { name: /Show the description/ })).toHaveAttribute(
      'aria-expanded',
      'false',
    );
    expect(within(summary).getByText(/Failed payouts now retry/)).toBeInTheDocument();
    expect(within(summary).getByText('claude-dev for Ana')).toBeInTheDocument();
  });

  it('shows the description in full with D under a summary, and edits it with the next D', async () => {
    const user = userEvent.setup();
    (fake().tasks[1] as Task).description = 'Payouts that fail at the provider are dropped today.';
    longContent();
    await openTask('PAY-2');
    await user.keyboard('d');
    await waitFor(() =>
      expect(screen.queryByRole('button', { name: /Show the description/ })).not.toBeInTheDocument(),
    );
    await user.keyboard('d');
    expect(await screen.findByRole('textbox', { name: 'Description' })).toBeInTheDocument();
  });

  it('shows the counts on the lists and in the sidebar', async () => {
    await openTask('PAY-2');
    const head = screen.getByRole('heading', { name: 'Acceptance criteria' }).parentElement as HTMLElement;
    expect(within(head).getByRole('img', { name: '4 of 6 criteria checked, 1 waived' })).toBeInTheDocument();
    expect(head).toHaveTextContent('1 waived · 1 open');
    expect(within(properties()).getByRole('button', { name: 'Criteria' })).toHaveTextContent(
      '4 of 61 waived · 1 open',
    );
    expect(within(properties()).getByRole('button', { name: 'Done items' })).toHaveTextContent('1 of 2');
    // Waived is the word and the reason, never colour alone.
    expect(line(/The schedule holds/)).toHaveAccessibleDescription(
      /Waived by Ana Ruiz: load test replaced by a replay/,
    );
  });

  it('collapses the plan in review and opens it while work is in progress', async () => {
    const user = userEvent.setup();
    await openTask('PAY-2');
    const plan = screen.getByRole('region', { name: 'Plan' });
    const toggle = within(plan).getByRole('button', { name: /Plan/ });
    expect(toggle).toHaveAttribute('aria-expanded', 'false');
    expect(toggle).toHaveTextContent('2 steps, by claude-dev');
    expect(within(plan).queryByText('Store the attempt count')).not.toBeInTheDocument();
    await user.click(toggle);
    expect(within(plan).getByText('Store the attempt count')).toBeInTheDocument();
  });
});

describe('editing criteria and done items', () => {
  it('checks with a click and with X, optimistically', async () => {
    const user = userEvent.setup();
    const release = fake().hold();
    await openTask('PAY-2');
    await user.click(line(/The on-call runbook/));
    // Checked on screen before the server answers.
    await waitFor(() => expect(line(/The on-call runbook/)).toHaveAttribute('aria-checked', 'true'));
    release();
    await waitFor(() => expect(lastUpdate()).toEqual({ key: 'PAY-2', checkCriteria: [6] }));
    fake().control.holdUpdates = null;

    line(/The on-call runbook/).focus();
    await user.keyboard('x');
    await waitFor(() => expect(lastUpdate()).toEqual({ key: 'PAY-2', uncheckCriteria: [6] }));
    await waitFor(() => expect(line(/The on-call runbook/)).toHaveAttribute('aria-checked', 'false'));
  });

  it('puts the list back when the server refuses', async () => {
    const user = userEvent.setup();
    await openTask('PAY-2');
    fake().control.failUpdates = true;
    await user.click(line(/The on-call runbook/));
    expect(await screen.findByText(/Couldn't change PAY-2/)).toBeInTheDocument();
    await waitFor(() => expect(line(/The on-call runbook/)).toHaveAttribute('aria-checked', 'false'));
  });

  it('waives with W and a reason, and W again removes the waiver', async () => {
    const user = userEvent.setup();
    await openTask('PAY-2');
    line(/The on-call runbook/).focus();
    await user.keyboard('w');
    const step = await screen.findByRole('dialog', { name: 'Waive criterion 6' });
    await user.keyboard('{Enter}');
    expect(within(step).getByText('Give a reason')).toBeInTheDocument();
    await user.keyboard('Covered by the alert docs{Enter}');
    await waitFor(() =>
      expect(lastUpdate()).toEqual({
        key: 'PAY-2',
        waiveCriteria: [{ number: 6, reason: 'Covered by the alert docs' }],
      }),
    );
    await waitFor(() => expect(line(/The on-call runbook/)).toHaveAccessibleDescription(/Waived/));

    line(/The schedule holds/).focus();
    await user.keyboard('w');
    await waitFor(() => expect(lastUpdate()).toEqual({ key: 'PAY-2', unwaiveCriteria: [5] }));
  });

  it('rewords with E, reorders with Alt+arrows and adds with Shift+A', async () => {
    const user = userEvent.setup();
    await openTask('PAY-1');
    line(/Every attempt reuses/).focus();
    await user.keyboard('e');
    const field = await screen.findByRole('textbox', { name: 'Reword criterion 2' });
    await user.clear(field);
    await user.type(field, 'Every attempt reuses the payout key{Enter}');
    await waitFor(() =>
      expect(lastUpdate()).toEqual({
        key: 'PAY-1',
        editCriteria: [{ number: 2, text: 'Every attempt reuses the payout key' }],
      }),
    );

    await waitFor(() => expect(line(/Every attempt reuses the payout key/)).toHaveFocus());
    await user.keyboard('{Alt>}{ArrowDown}{/Alt}');
    await waitFor(() => expect(lastUpdate()).toEqual({ key: 'PAY-1', moveCriteria: [{ from: 2, to: 3 }] }));
    await waitFor(() =>
      expect(
        within(criteria())
          .getAllByRole('checkbox')
          .map((box) => box.textContent),
      ).toEqual([
        'A failed payout is retried up to 8 times',
        'On-call is alerted once after the last attempt',
        'Every attempt reuses the payout key',
      ]),
    );

    await user.keyboard('{Escape}');
    await user.click(document.body);
    await user.keyboard('{Shift>}A{/Shift}');
    const add = await screen.findByRole('textbox', { name: 'Add a criterion' });
    await waitFor(() => expect(add).toHaveFocus());
    await user.keyboard('The alert names the payout{Enter}');
    await waitFor(() =>
      expect(lastUpdate()).toEqual({ key: 'PAY-1', addCriteria: ['The alert names the payout'] }),
    );
    // The field stays open for the next line.
    expect(screen.getByRole('textbox', { name: 'Add a criterion' })).toHaveValue('');
  });

  it('removes with Backspace and puts the line back with Undo', async () => {
    const user = userEvent.setup();
    await openTask('PAY-2');
    line(/account_closed skips/).focus();
    await user.keyboard('{Backspace}');
    await waitFor(() => expect(lastUpdate()).toEqual({ key: 'PAY-2', removeCriteria: [4] }));
    expect(await screen.findByText('Removed criterion 4')).toBeInTheDocument();
    await user.click(screen.getByRole('button', { name: 'Undo' }));
    await waitFor(() =>
      expect(fake().calls.update.slice(-2)).toEqual([
        { key: 'PAY-2', addCriteria: ['account_closed skips the retries'] },
        { key: 'PAY-2', checkCriteria: [6], moveCriteria: [{ from: 6, to: 4 }] },
      ]),
    );
    await waitFor(() => expect(line(/account_closed skips/)).toHaveAttribute('aria-checked', 'true'));
    expect(within(criteria()).getAllByRole('checkbox')[3]).toHaveTextContent('account_closed skips');
  });

  it('moves focus to the first open criterion with Shift+X', async () => {
    const user = userEvent.setup();
    await openTask('PAY-2');
    await user.keyboard('{Shift>}X{/Shift}');
    await waitFor(() => expect(line(/The on-call runbook/)).toHaveFocus());
  });

  it('checks done items, named by their text', async () => {
    const user = userEvent.setup();
    await openTask('PAY-2');
    await user.click(within(doneItems()).getByRole('checkbox', { name: 'Changelog has a line' }));
    await waitFor(() => expect(lastUpdate()).toEqual({ key: 'PAY-2', checkDoneItems: [2] }));
  });

  it('starts empty with the quiet add lines and the project defaults', async () => {
    const user = userEvent.setup();
    (fake().tasks[2] as Task).doneItems = FAKE_DEFAULT_DONE_ITEMS.map((text, index) => ({
      number: index + 1,
      text,
      state: 'open' as const,
      waivedReason: null,
      waivedBy: null,
      locked: false,
    }));
    await openTask('PAY-3');
    expect(within(criteria()).getByRole('button', { name: /Add a criterion/ })).toHaveTextContent(
      'What must be true when this is done',
    );
    const doneHead = screen.getByRole('heading', { name: 'Definition of done' }).parentElement as HTMLElement;
    expect(doneHead).toHaveTextContent('from the project defaults');
    expect(within(properties()).getByRole('button', { name: 'Criteria' })).toHaveTextContent('None yet');
    expect(within(properties()).getByRole('button', { name: 'Done items' })).toHaveTextContent(
      'project defaults',
    );

    const plan = screen.getByRole('region', { name: 'Plan' });
    await user.click(within(plan).getByRole('button', { name: /Write a plan/ }));
    await user.type(await screen.findByRole('textbox', { name: 'Plan' }), '1. Read the statement');
    await user.keyboard('{Control>}{Enter}{/Control}');
    await waitFor(() => expect(lastUpdate()).toEqual({ key: 'PAY-3', plan: '1. Read the statement' }));
    expect(await within(plan).findByText('Read the statement')).toBeInTheDocument();
  });
});

describe('finishing with open items', () => {
  it('asks before moving to In review, checks with X in place, and cancels', async () => {
    const user = userEvent.setup();
    await openTask('PAY-1');
    await user.keyboard('s');
    const statuses = await screen.findByRole('dialog', { name: 'Status' });
    await user.click(within(statuses).getByRole('menuitemradio', { name: /In review/ }));
    const dialog = await screen.findByRole('dialog', { name: '5 items are still open' });
    expect(dialog).toHaveTextContent('PAY-1 is moving to In review.');
    const items = within(dialog).getAllByRole('checkbox');
    expect(items.map((item) => item.textContent)).toEqual([
      'A failed payout is retried up to 8 times',
      'Every attempt reuses the idempotency key',
      'On-call is alerted once after the last attempt',
      'Tests and lint passDefinition of done',
      'Changelog has a lineDefinition of done',
    ]);
    await waitFor(() => expect(items[0]).toHaveFocus());
    await user.keyboard('x');
    await waitFor(() => expect(lastUpdate()).toEqual({ key: 'PAY-1', checkCriteria: [1] }));
    // Checked in place: the line stays, the title counts what is still open.
    expect(await screen.findByRole('dialog', { name: '4 items are still open' })).toBeInTheDocument();
    expect(within(screen.getByRole('dialog')).getAllByRole('checkbox')[0]).toHaveAttribute(
      'aria-checked',
      'true',
    );
    await user.click(within(screen.getByRole('dialog')).getByRole('button', { name: 'Cancel' }));
    await waitFor(() => expect(screen.queryByRole('dialog')).not.toBeInTheDocument());
    expect(fake().calls.update.some((call) => call.status !== undefined)).toBe(false);
  });

  it('waives with W and moves anyway', async () => {
    const user = userEvent.setup();
    await openTask('PAY-1');
    await user.click(within(properties()).getByRole('button', { name: 'Status' }));
    await user.click(
      within(await screen.findByRole('dialog', { name: 'Status' })).getByRole('menuitemradio', {
        name: /Done/,
      }),
    );
    const dialog = await screen.findByRole('dialog', { name: /still open/ });
    await waitFor(() => expect(within(dialog).getAllByRole('checkbox')[0]).toHaveFocus());
    await user.keyboard('{ArrowDown}w');
    const reason = await screen.findByRole('textbox', { name: 'Waive criterion 2' });
    await waitFor(() => expect(reason).toHaveFocus());
    await user.keyboard('Not this time{Enter}');
    await waitFor(() =>
      expect(lastUpdate()).toEqual({ key: 'PAY-1', waiveCriteria: [{ number: 2, reason: 'Not this time' }] }),
    );
    await user.click(
      within(screen.getByRole('dialog', { name: /still open/ })).getByRole('button', {
        name: /Move to Done/,
      }),
    );
    await waitFor(() => expect(lastUpdate()).toMatchObject({ key: 'PAY-1', status: 'done' }));
    await waitFor(() => expect(screen.queryByRole('dialog', { name: /still open/ })).not.toBeInTheDocument());
  });

  it('moves at once when nothing is open', async () => {
    const user = userEvent.setup();
    await openTask('PAY-3');
    await user.keyboard('s');
    await user.click(
      within(await screen.findByRole('dialog', { name: 'Status' })).getByRole('menuitemradio', {
        name: /Done/,
      }),
    );
    await waitFor(() => expect(lastUpdate()).toMatchObject({ key: 'PAY-3', status: 'done' }));
    expect(screen.queryByRole('dialog', { name: /still open/ })).not.toBeInTheDocument();
  });
});

describe('timeline', () => {
  it('draws notes as notes and filters by Comments, Notes and History', async () => {
    const user = userEvent.setup();
    await openTask('PAY-2');
    const notes = within(history()).getAllByRole('article', { name: 'Note by claude-dev for Ana' });
    expect(notes).toHaveLength(2);
    expect(within(notes[0] as HTMLElement).getByText('Note')).toBeInTheDocument();
    expect(within(history()).getByText('checked criterion 2')).toBeInTheDocument();

    await user.click(within(history()).getByRole('button', { name: 'Notes' }));
    expect(within(history()).getAllByRole('listitem')).toHaveLength(2);
    expect(within(history()).queryByText('checked criterion 2')).not.toBeInTheDocument();

    await user.click(within(history()).getByRole('button', { name: 'History' }));
    expect(within(history()).queryAllByRole('article', { name: /Note by/ })).toHaveLength(0);
    // Under History the machine and branch always show.
    const checked = within(history()).getByText('checked criterion 2').closest('[data-activity]');
    expect(checked?.querySelector('[data-source]')).toHaveTextContent(/laptop.*feat\/payout-retries/);
    expect(checked?.querySelector('[data-source]')).not.toHaveClass('opacity-0');

    await user.click(within(history()).getByRole('button', { name: 'All' }));
    const again = within(history()).getByText('checked criterion 2').closest('[data-activity]');
    expect(again?.querySelector('[data-source]')).toHaveClass('opacity-0');
  });

  it('shows the counts from the API once the history is long', async () => {
    const at = Date.now() - 3_600_000;
    for (let index = 0; index < 25; index++) {
      fake().activity.push({
        id: `40000000-0000-4000-8000-${String(700 + index).padStart(12, '0')}`,
        type: 'task.updated',
        taskKey: 'PAY-2',
        actor: FAKE_PEOPLE.ana,
        onBehalfOf: null,
        changes: [{ field: 'priority', from: 'none', to: 'high' }],
        createdAt: new Date(at + index * 1000).toISOString(),
      } satisfies Activity);
    }
    await openTask('PAY-2');
    const tabs = within(history()).getByRole('group', { name: 'Show' });
    expect(within(tabs).getByRole('button', { name: /^All/ })).toHaveTextContent('All29');
    expect(within(tabs).getByRole('button', { name: /^Comments/ })).toHaveTextContent('Comments0');
    expect(within(tabs).getByRole('button', { name: /^Notes/ })).toHaveTextContent('Notes2');
    expect(within(tabs).getByRole('button', { name: /^History/ })).toHaveTextContent('History27');
  });

  it('opens the composer as a note with N and as a comment with M', async () => {
    const user = userEvent.setup();
    await openTask('PAY-2');
    expect(screen.getByRole('button', { name: 'Leave a comment or a note' })).toBeInTheDocument();
    await user.keyboard('n');
    const note = await screen.findByRole('textbox', { name: 'Note' });
    await waitFor(() => expect(note).toHaveFocus());
    expect(screen.getByRole('switch', { name: 'Note' })).toBeChecked();
    expect(screen.getByText('A note tells nobody unless it mentions them.')).toBeInTheDocument();
    await user.keyboard('Checked the alert by hand{Control>}{Enter}{/Control}');
    await waitFor(() =>
      expect(fake().calls.comments).toContainEqual({
        op: 'create',
        key: 'PAY-2',
        body: 'Checked the alert by hand',
        kind: 'note',
      }),
    );
    await waitFor(() =>
      expect(within(history()).getAllByRole('article', { name: 'Note by Ana Ruiz' })).toHaveLength(1),
    );

    await user.keyboard('m');
    const comment = await screen.findByRole('textbox', { name: 'Comment' });
    await waitFor(() => expect(comment).toHaveFocus());
    expect(screen.getByRole('switch', { name: 'Note' })).not.toBeChecked();
    await user.click(screen.getByRole('switch', { name: 'Note' }));
    expect(screen.getByRole('button', { name: /Add note/ })).toBeInTheDocument();
  });
});

describe('mirrored task', () => {
  function mirrorPay1() {
    const task = fake().tasks[0] as Task;
    task.locked = ['title', 'description', 'status', 'priority', 'assignee'];
    task.criteria = (task.criteria ?? []).map((item, index) => ({
      ...item,
      state: index === 0 ? ('checked' as const) : item.state,
    }));
    task.doneItems = [];
    task.planMeta = null;
    task.backlog = {
      id: 'BACK-1',
      file: 'backlog/tasks/back-1.md',
      fileUrl: null,
      data: {
        kind: 'task',
        implementationNotes: 'Moved the group names into the shared namespace.',
        status: 'In Progress',
        priority: 'high',
        milestone: null,
        assignees: [],
        reporter: null,
        labels: [],
        dependencies: [],
        parent: null,
        subtasks: [],
        dueDate: null,
        type: null,
        references: [],
        documentation: [],
        modifiedFiles: [],
        createdDate: null,
        updatedDate: null,
        ordinal: null,
        other: {},
      },
    } as Task['backlog'];
  }

  it('shows the same sections read-only, the notes from the file, and comments only', async () => {
    const user = userEvent.setup();
    mirrorPay1();
    await openTask('PAY-1');
    const head = screen.getByRole('heading', { name: 'Acceptance criteria' }).parentElement as HTMLElement;
    expect(head).toHaveTextContent('from the file');
    for (const box of within(criteria()).getAllByRole('checkbox')) {
      expect(box).toHaveAttribute('aria-readonly', 'true');
    }
    expect(within(criteria()).queryByRole('button', { name: /Add a criterion/ })).not.toBeInTheDocument();
    expect(screen.getByRole('region', { name: 'Definition of done' })).toHaveTextContent('None in the file');
    expect(
      within(screen.getByRole('region', { name: 'Plan' })).getByRole('button', { name: /Plan/ }),
    ).toHaveTextContent('from the file');
    expect(screen.getByRole('region', { name: 'Notes from the file' })).toHaveTextContent(
      'Moved the group names into the shared namespace.',
    );
    // A click on a line changes nothing.
    await user.click(line(/A failed payout/));
    expect(fake().calls.update).toHaveLength(0);
    // Shift+A does nothing; the composer takes comments only.
    await user.keyboard('{Shift>}A{/Shift}');
    expect(screen.queryByRole('textbox', { name: 'Add a criterion' })).not.toBeInTheDocument();
    expect(
      screen.getByRole('button', {
        name: 'Leave a comment. It stays in the app and isn’t written to the file.',
      }),
    ).toBeInTheDocument();
    await user.keyboard('n');
    expect(screen.queryByRole('textbox', { name: 'Note' })).not.toBeInTheDocument();
  });
});
