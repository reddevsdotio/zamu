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
import type { Activity, PullRequestLink, Task } from '@zamu/contracts';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { clearCommentDrafts } from '~/features/comments/CommentComposer';
import { resetTimelinePreferences } from '~/features/comments/TaskTimeline';
import { resetFieldToastForTests, TaskFieldToast } from '~/features/task-fields/toast';
import { FinishingHost } from '~/features/work-record/FinishingHost';
import { testWorkspace } from '~/lib/testing';
import { WorkspaceProvider } from '~/lib/workspace';
import { localToday, UIProvider } from '~/ui';
import { addDays } from '../task-fields/dates';
import { createFakeApi, FAKE_PEOPLE, FAKE_REPOSITORY, type FakeApi } from './fake-api';
import { resetFromFile } from './MirroredTask';
import { TaskPage } from './TaskPage';

// The task view's M7 states (frames 051 to 063, 087, 095 to 100) against the in-memory /api/v1 client:
// the requests with how they were linked, the branch line, the link field with its preview and refusals
// (⇧P), unlinking with Undo, the sidebar's request, flag and check-again rows, history lines written by a
// git host or Zamu with their causes, the archived task (⇧E, Restore, read-only, the composer message)
// and the check-again picker with its required reason (⇧W).

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

function renderTask(key: string) {
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
    history: createMemoryHistory({ initialEntries: [`/w/acme/p/PAY/${key}`] }),
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

async function openTask(key: string) {
  const result = renderTask(key);
  await screen.findByRole('heading', { level: 1 });
  const region = await screen.findByRole('region', { name: 'Activity' });
  await waitFor(() => expect(within(region).getAllByRole('listitem').length).toBeGreaterThan(0));
  return result;
}

const task = (key: string) => fake().tasks.find((item) => item.key === key) as Task;
const properties = () => screen.getByRole('complementary', { name: 'Properties' });
const requestsBox = () => screen.getByRole('region', { name: 'Pull requests' });
const history = () => screen.getByRole('region', { name: 'Activity' });
const toast = () => screen.findByRole('status');
const ago = (minutes: number) => new Date(Date.now() - minutes * 60_000).toISOString();
const today = () => localToday();

function request(number: number, extra: Partial<PullRequestLink> = {}): PullRequestLink {
  return {
    provider: 'github',
    number,
    title: `Request ${number}`,
    url: `https://${FAKE_REPOSITORY}/pull/${number}`,
    state: 'open',
    headBranch: `feat/branch-${number}`,
    baseBranch: 'main',
    author: 'claude-dev',
    mergedBy: null,
    how: 'branch',
    linkedBy: null,
    linkedAt: ago(120),
    openedAt: ago(120 - number),
    mergedAt: null,
    closedAt: null,
    updatedAt: ago(60),
    ...extra,
  };
}

/** A history entry written by the system (no actor). */
function systemEntry(key: string, entry: Partial<Activity>): Activity {
  return {
    id: `40000000-0000-4000-8000-${String(9000 + fake().activity.length).padStart(12, '0')}`,
    type: 'task.updated',
    taskKey: key,
    actor: null,
    onBehalfOf: null,
    changes: [],
    createdAt: ago(30),
    ...entry,
  };
}

beforeEach(() => {
  api.current = createFakeApi({ workRecord: true, repository: true });
  window.sessionStorage.clear();
  clearCommentDrafts();
  resetTimelinePreferences();
  resetFromFile();
  resetFieldToastForTests();
});

afterEach(() => {
  vi.restoreAllMocks();
});

describe('requests on a task (frames 051 to 053)', () => {
  it('lists each request with how it was linked and its state, between the description and the criteria', async () => {
    task('PAY-2').pullRequests = [
      request(485, { state: 'draft', how: 'hand', linkedBy: FAKE_PEOPLE.ana }),
      request(482, { title: 'Retry failed payouts with backoff', headBranch: 'feat/payout-retries' }),
      request(479, { state: 'merged', how: 'description', mergedAt: ago(1500), mergedBy: 'Tomás Ferrer' }),
      request(471, { state: 'closed', how: 'hand', closedAt: ago(2000) }),
    ];
    await openTask('PAY-2');
    const box = requestsBox();
    const rows = within(box).getAllByRole('listitem');
    expect(rows.map((row) => row.textContent)).toEqual([
      expect.stringMatching(/#485Request 485linked by handDraft/),
      expect.stringMatching(/#482Retry failed payouts with backoffstarted onfeat\/payout-retriesOpen/),
      expect.stringMatching(/#479Request 479named in the descriptionMerged/),
      expect.stringMatching(/#471Request 471linked by handClosed/),
    ]);
    expect(within(box).getByText('2 still open')).toBeInTheDocument();
    expect(
      within(box).getByText(
        'PAY-2 moves to Done when #485 and #482 are merged or closed. A request closed without merging changes nothing.',
      ),
    ).toBeInTheDocument();
    expect(within(box).getByRole('link', { name: 'Open #482 on GitHub' })).toHaveAttribute(
      'href',
      `https://${FAKE_REPOSITORY}/pull/482`,
    );
    // Between the description (or summary) and the criteria.
    const order = [...document.querySelectorAll('article section')].map(
      (section) => section.getAttribute('aria-label') ?? section.getAttribute('aria-labelledby'),
    );
    expect(order.indexOf('pull-requests-title')).toBeLessThan(order.indexOf('work-criterion-title'));
    // The sidebar names the open one first, with how many more.
    const row = within(properties()).getByText('Pull request').parentElement as HTMLElement;
    expect(row).toHaveTextContent('#482+3Open');
  });

  it('says one open, or when the last one merged and by whom', async () => {
    task('PAY-1').pullRequests = [request(482)];
    task('PAY-3').pullRequests = [
      request(479, { state: 'merged', mergedAt: ago(30), mergedBy: 'Tomás Ferrer' }),
    ];
    await openTask('PAY-1');
    expect(within(requestsBox()).getByText('1 open')).toBeInTheDocument();
    expect(screen.queryByText(/moves to Done when/)).not.toBeInTheDocument();
  });

  it('shows the work branch while it has no request (frame 053)', async () => {
    const pay1 = task('PAY-1');
    pay1.workBranch = 'feat/payout-alert';
    fake().activity.push({
      id: '40000000-0000-4000-8000-000000009999',
      type: 'task.updated',
      taskKey: 'PAY-1',
      actor: FAKE_PEOPLE.claude,
      onBehalfOf: FAKE_PEOPLE.ana,
      changes: [
        { field: 'status', from: 'todo', to: 'in_progress' },
        { field: 'workBranch', from: null, to: 'feat/payout-alert' },
      ],
      source: { machine: 'laptop', branch: 'feat/payout-alert' },
      createdAt: ago(10),
    });
    await openTask('PAY-1');
    const box = requestsBox();
    expect(box.querySelector('[data-part="branch-line"]')).toHaveTextContent(
      /Work started onfeat\/payout-alertby claude-dev on laptop.*No pull request yet/,
    );
    expect(within(box).getByRole('button', { name: /Link a pull request/ })).toBeInTheDocument();
    // The history line says the move, not the branch: the source tag names it.
    expect(within(history()).getByText(/moved this to In progress$/)).toBeInTheDocument();
  });

  it('leaves the section out when there is no request and no branch', async () => {
    await openTask('PAY-3');
    expect(screen.queryByRole('region', { name: 'Pull requests' })).not.toBeInTheDocument();
  });
});

describe('linking by hand (frames 057 to 059)', () => {
  it('⇧P opens the field; a pasted address shows the request as it would link, ↵ links it', async () => {
    const user = userEvent.setup();
    fake().requests.set(485, request(485, { state: 'draft', title: 'Runbook entry for payout retries' }));
    task('PAY-2').pullRequests = [request(482)];
    await openTask('PAY-2');
    await user.keyboard('{Shift>}P{/Shift}');
    const field = await screen.findByRole('textbox', { name: 'Pull request address' });
    expect(field).toHaveFocus();
    await user.click(field);
    await user.paste(`https://${FAKE_REPOSITORY}/pull/485`);
    const preview = await waitFor(() => {
      const node = document.querySelector('[data-preview]');
      expect(node).not.toBeNull();
      return node as HTMLElement;
    });
    expect(preview).toHaveTextContent('#485Runbook entry for payout retriesEnter links itDraft');
    expect(fake().calls.link.at(-1)).toMatchObject({ key: 'PAY-2', dryRun: true });
    expect(task('PAY-2').pullRequests).toHaveLength(1);

    await user.keyboard('{Enter}');
    expect(await toast()).toHaveTextContent('Linked #485 to PAY-2');
    expect(fake().calls.link.at(-1)).toEqual({ key: 'PAY-2', url: `https://${FAKE_REPOSITORY}/pull/485` });
    await waitFor(() =>
      expect(within(requestsBox()).getAllByRole('listitem')[0]).toHaveTextContent(/#485.*linked by hand/),
    );
    expect(screen.queryByRole('textbox', { name: 'Pull request address' })).not.toBeInTheDocument();
  });

  it('says an issue address is not a request, without asking the server', async () => {
    const user = userEvent.setup();
    await openTask('PAY-2');
    await user.keyboard('{Shift>}P{/Shift}');
    const field = await screen.findByRole('textbox', { name: 'Pull request address' });
    await user.type(field, 'github.com/northwind/payments/issues/485');
    expect(await screen.findByRole('alert')).toHaveTextContent(
      "That isn't a pull or merge request address. Paste the link from GitHub, GitLab or Forgejo.",
    );
    expect(field).toHaveAttribute('aria-invalid', 'true');
    expect(fake().calls.link).toHaveLength(0);
  });

  it('refuses a request of another repository and names both (frame 059)', async () => {
    const user = userEvent.setup();
    await openTask('PAY-2');
    await user.keyboard('{Shift>}P{/Shift}');
    const field = await screen.findByRole('textbox', { name: 'Pull request address' });
    await user.click(field);
    await user.paste('https://github.com/northwind/storefront/pull/77');
    expect(await screen.findByRole('alert')).toHaveTextContent(
      '#77 is in northwind/storefront. Payments is linked to northwind/payments, and only its requests can be linked here.',
    );
  });

  it('Esc closes the field and stays on the task', async () => {
    const user = userEvent.setup();
    const { router } = await openTask('PAY-2');
    await user.keyboard('{Shift>}P{/Shift}');
    await screen.findByRole('textbox', { name: 'Pull request address' });
    await user.keyboard('{Escape}');
    await waitFor(() =>
      expect(screen.queryByRole('textbox', { name: 'Pull request address' })).not.toBeInTheDocument(),
    );
    expect(router.state.location.pathname).toBe('/w/acme/p/PAY/PAY-2');
  });

  it('⇧P on a project without a repository says where to link one', async () => {
    const user = userEvent.setup();
    fake().repo.repository = null;
    await openTask('PAY-2');
    await waitFor(() => expect(fake().repo.repository).toBeNull());
    // The project list has loaded once the sidebar shows.
    await user.keyboard('{Shift>}P{/Shift}');
    expect(await toast()).toHaveTextContent(
      'Payments has no repository. Link one in the project settings first.',
    );
    expect(screen.queryByRole('textbox', { name: 'Pull request address' })).not.toBeInTheDocument();
  });

  it('removes a link with Undo, which links it again by hand', async () => {
    const user = userEvent.setup();
    const linked = request(482);
    task('PAY-2').pullRequests = [linked];
    fake().requests.set(482, linked);
    await openTask('PAY-2');
    await user.click(within(requestsBox()).getByRole('button', { name: 'Unlink #482' }));
    expect(await toast()).toHaveTextContent('Unlinked #482 from PAY-2');
    expect(fake().calls.unlink.at(-1)).toEqual({ key: 'PAY-2', number: 482 });
    // Its last request gone and no branch, the section leaves.
    await waitFor(() =>
      expect(screen.queryByRole('region', { name: 'Pull requests' })).not.toBeInTheDocument(),
    );
    await user.click(screen.getByRole('button', { name: 'Undo' }));
    await waitFor(() =>
      expect(fake().calls.link.at(-1)).toEqual({ key: 'PAY-2', url: `https://${FAKE_REPOSITORY}/pull/482` }),
    );
    await waitFor(() =>
      expect(within(requestsBox()).getAllByRole('listitem')[0]).toHaveTextContent(/#482.*linked by hand/),
    );
  });
});

describe('merged with open criteria (frame 063)', () => {
  it('flags the sidebar and says what was open in the merge line', async () => {
    const pay2 = task('PAY-2');
    pay2.status = 'done';
    pay2.pullRequests = [
      request(479, {
        state: 'merged',
        mergedAt: ago(1500),
        mergedBy: 'Tomás Ferrer',
        title: 'Payout report',
      }),
    ];
    pay2.mergedOpen = { at: ago(20), openCriteria: 2, openDoneItems: 0 };
    fake().activity.push(
      systemEntry('PAY-2', {
        type: 'task.pull_request_linked',
        origin: 'git',
        system: { kind: 'git', provider: 'github' },
        changes: [
          {
            field: 'pullRequest',
            from: null,
            to: {
              provider: 'github',
              number: 479,
              title: 'x',
              url: 'https://x.test/pull/479',
              how: 'branch',
            },
          },
        ],
        cause: {
          kind: 'pull_request',
          provider: 'github',
          number: 479,
          title: 'x',
          url: 'https://x.test/pull/479',
          event: 'opened',
          by: 'claude-dev',
        },
        createdAt: ago(60),
      }),
      systemEntry('PAY-2', {
        origin: 'git',
        system: { kind: 'git', provider: 'github' },
        changes: [{ field: 'status', from: 'in_review', to: 'done' }],
        cause: {
          kind: 'pull_request',
          provider: 'github',
          number: 479,
          title: 'x',
          url: 'https://x.test/pull/479',
          event: 'merged',
          by: 'Tomás Ferrer',
        },
        createdAt: ago(20),
      }),
    );
    await openTask('PAY-2');
    expect(within(properties()).getByRole('note')).toHaveTextContent('Merged with 2 open criteria');
    const lines = within(history());
    expect(
      lines.getByText(
        (_, node) => node?.textContent === 'GitHub linked #479 · work started on feat/branch-479',
      ),
    ).toBeInTheDocument();
    expect(
      lines.getByText(
        (_, node) =>
          node?.textContent ===
          'GitHub moved this to Done · #479 merged by Tomás Ferrer, 2 criteria still open',
      ),
    ).toBeInTheDocument();
    expect(
      within(requestsBox()).getByText(/^merged (today|yesterday|on .+) by Tomás Ferrer$/),
    ).toBeInTheDocument();
  });

  it('names Forgejo and Zamu, and the Backlog.md archive', async () => {
    fake().activity.push(
      systemEntry('PAY-1', {
        origin: 'git',
        system: { kind: 'git', provider: 'gitea' },
        changes: [{ field: 'status', from: 'in_progress', to: 'in_review' }],
        cause: {
          kind: 'pull_request',
          provider: 'gitea',
          number: 12,
          title: 'x',
          url: 'https://forgejo.test/o/r/pulls/12',
          event: 'ready',
          by: null,
        },
      }),
      systemEntry('PAY-1', {
        type: 'task.archived',
        origin: 'app',
        system: { kind: 'zamu' },
        cause: { kind: 'archive', afterDays: 14 },
      }),
      systemEntry('PAY-1', { type: 'task.unarchived', origin: 'backlog', system: { kind: 'backlog' } }),
    );
    await openTask('PAY-1');
    const text = within(history());
    expect(
      text.getByText((_, node) => node?.textContent === 'Forgejo moved this to In review · #12 marked ready'),
    ).toBeInTheDocument();
    expect(
      text.getByText((_, node) => node?.textContent === 'Zamu archived this · 14 days after it was done'),
    ).toBeInTheDocument();
    expect(
      text.getByText(
        (_, node) => node?.textContent === 'Backlog.md restored this from the archive in the file',
      ),
    ).toBeInTheDocument();
  });
});

describe('an archived task (frame 087)', () => {
  function archive(key: string) {
    const item = task(key);
    item.archivedAt = ago(60);
    item.archivedBy = null;
    fake().activity.push(
      systemEntry(key, {
        type: 'task.archived',
        origin: 'app',
        system: { kind: 'zamu' },
        cause: { kind: 'archive', afterDays: 14 },
        createdAt: ago(60),
      }),
    );
  }

  it('opens with the bar, keeps every field as it is and asks to restore before commenting', async () => {
    const user = userEvent.setup();
    task('PAY-6').description = 'Accountants asked for the month as a CSV.';
    archive('PAY-6');
    await openTask('PAY-6');
    const bar = screen.getByText(/^Archived on/).closest('[data-part="archived-bar"]') as HTMLElement;
    expect(bar).toHaveTextContent(/14 days after it was done\. It stays out of lists, boards and counts\./);
    expect(within(bar).getByRole('button', { name: /Restore/ })).toBeInTheDocument();
    expect(screen.getByText('Restore the task to comment on it or change it.')).toBeInTheDocument();
    expect(screen.queryByRole('button', { name: /Leave a comment/ })).not.toBeInTheDocument();
    // No add lines, no empty lists.
    expect(screen.queryByRole('button', { name: /Add a criterion/ })).not.toBeInTheDocument();
    expect(screen.queryByRole('region', { name: 'Subtasks' })).not.toBeInTheDocument();
    expect(within(properties()).getByText('Updated').parentElement).toHaveTextContent(/, archived$/);

    // Keys and presses change nothing and say why.
    await user.keyboard('s');
    expect(await toast()).toHaveTextContent('Archived: restore the task to change it.');
    await user.keyboard('e');
    expect(screen.queryByRole('textbox', { name: 'Title' })).not.toBeInTheDocument();
    await user.keyboard('{Shift>}W{/Shift}');
    expect(screen.queryByRole('dialog', { name: 'Check again' })).not.toBeInTheDocument();
    await user.keyboard('{Shift>}P{/Shift}');
    expect(screen.queryByRole('textbox', { name: 'Pull request address' })).not.toBeInTheDocument();
    expect(fake().calls.update).toHaveLength(0);
  });

  it('Restore and ⇧E bring it back, with Undo', async () => {
    const user = userEvent.setup();
    archive('PAY-6');
    await openTask('PAY-6');
    await user.keyboard('{Shift>}E{/Shift}');
    expect(await toast()).toHaveTextContent('1 task restored');
    expect(fake().calls.restore.at(-1)).toEqual({ keys: ['PAY-6'] });
    await waitFor(() => expect(screen.queryByText(/^Archived on/)).not.toBeInTheDocument());
    expect(screen.getByRole('button', { name: /Leave a comment/ })).toBeInTheDocument();
    // ⌘Z puts it back in the archive.
    await user.keyboard('{Control>}z{/Control}');
    await waitFor(() => expect(fake().calls.archive.at(-1)).toEqual({ keys: ['PAY-6'] }));
    await screen.findByText(/^Archived on/);
  });

  it('⇧E archives an open task; the toast offers Undo', async () => {
    const user = userEvent.setup();
    await openTask('PAY-3');
    await user.keyboard('{Shift>}E{/Shift}');
    expect(await toast()).toHaveTextContent('1 task archived');
    expect(fake().calls.archive.at(-1)).toEqual({ keys: ['PAY-3'] });
    const bar = await screen.findByText(/^Archived on/);
    expect(bar.closest('[data-part="archived-bar"]')).toHaveTextContent('by Ana Ruiz');
    await user.click(screen.getByRole('button', { name: 'Undo' }));
    await waitFor(() => expect(fake().calls.restore.at(-1)).toEqual({ keys: ['PAY-3'] }));
  });

  it('a mirrored task shows the bar without Restore, and ⇧E says where to change it', async () => {
    const user = userEvent.setup();
    const item = task('PAY-6');
    item.locked = ['title', 'description', 'status'];
    archive('PAY-6');
    await openTask('PAY-6');
    const bar = screen.getByText(/^Archived on/).closest('[data-part="archived-bar"]') as HTMLElement;
    expect(within(bar).queryByRole('button', { name: /Restore/ })).not.toBeInTheDocument();
    expect(bar).toHaveTextContent('Move its file out of archive/tasks/ to restore it.');
    await user.keyboard('{Shift>}E{/Shift}');
    expect(await toast()).toHaveTextContent('Backlog.md decides');
    expect(fake().calls.restore).toHaveLength(0);
  });
});

describe('check again (frames 095 to 100)', () => {
  const checkAgainRow = () => within(properties()).getByRole('button', { name: 'Check again' });

  it('⇧W opens the picker over the row; a day needs a reason, which the field asks for', async () => {
    const user = userEvent.setup();
    await openTask('PAY-3');
    expect(checkAgainRow()).toHaveTextContent('Set a day');
    await user.keyboard('{Shift>}W{/Shift}');
    const picker = await screen.findByRole('dialog', { name: 'Check again' });
    expect(within(picker).getByText('In a week')).toBeInTheDocument();
    expect(within(picker).getByText('In two weeks')).toBeInTheDocument();
    expect(within(picker).getByText('In a month')).toBeInTheDocument();
    expect(within(picker).getByText('It is what you read when the task comes back.')).toBeInTheDocument();

    await user.keyboard('in 2 weeks');
    await user.keyboard('{Enter}');
    const reason = within(picker).getByRole('textbox', { name: 'Why wait (required)' });
    await waitFor(() => expect(reason).toHaveFocus());
    // Without a reason nothing is sent; the field is marked and says why.
    await user.keyboard('{Enter}');
    expect(within(picker).getByRole('alert')).toHaveTextContent(
      'Say why it waits. It is what you read when the task comes back.',
    );
    expect(reason).toHaveAttribute('aria-invalid', 'true');
    expect(fake().calls.update).toHaveLength(0);

    await user.keyboard('The bank issues the new certificate{Enter}');
    await waitFor(() =>
      expect(fake().calls.update.at(-1)).toEqual({
        key: 'PAY-3',
        checkAgain: { on: addDays(today(), 14), reason: 'The bank issues the new certificate' },
      }),
    );
    expect(await toast()).toHaveTextContent(/^PAY-3 waits until/);
    await waitFor(() =>
      expect(checkAgainRow()).toHaveTextContent(/Waiting until .*The bank issues the new certificate/),
    );
  });

  it('shows the day that came in the accent words, and Clear takes it off', async () => {
    const user = userEvent.setup();
    task('PAY-3').checkAgain = { on: today(), reason: 'The vendor said today' };
    await openTask('PAY-3');
    expect(checkAgainRow()).toHaveTextContent('Check again: todayThe vendor said today');
    await user.click(checkAgainRow());
    const picker = await screen.findByRole('dialog', { name: 'Check again' });
    await user.click(within(picker).getByRole('button', { name: 'Clear' }));
    await waitFor(() => expect(fake().calls.update.at(-1)).toEqual({ key: 'PAY-3', checkAgain: null }));
    await waitFor(() => expect(checkAgainRow()).toHaveTextContent('Set a day'));
  });

  it('records the day in the history', async () => {
    fake().activity.push({
      id: '40000000-0000-4000-8000-000000009998',
      type: 'task.updated',
      taskKey: 'PAY-3',
      actor: FAKE_PEOPLE.tomas,
      onBehalfOf: null,
      changes: [{ field: 'checkAgain', from: null, to: { on: '2026-12-03', reason: 'Bank' } }],
      createdAt: ago(5),
    });
    await openTask('PAY-3');
    expect(within(history()).getByText(/set check again to Dec 3/)).toBeInTheDocument();
  });
});
