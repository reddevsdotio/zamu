import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import {
  createMemoryHistory,
  createRootRoute,
  createRoute,
  createRouter,
  Outlet,
  RouterProvider,
} from '@tanstack/react-router';
import { act, configure, render, screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { QuickCreateProvider, useQuickCreate } from '~/features/shell/quick-create';
import { createFakeApi, FAKE_MILESTONES, FAKE_PEOPLE, type FakeApi } from '~/features/tasks/fake-api';
import { QuickCreateDialog } from '~/features/tasks/QuickCreateDialog';
import { TaskPage } from '~/features/tasks/TaskPage';
import { rememberTaskNavigation } from '~/features/views';
import { testWorkspace } from '~/lib/testing';
import { WorkspaceProvider } from '~/lib/workspace';
import { Button, UIProvider } from '~/ui';
import { clearCommentDrafts } from './CommentComposer';
import { resetTimelinePreferences } from './TaskTimeline';

// Component tests of the task view (M5-13): the history, the comment box, the properties and their
// pickers, the title and description keys, J / K and Esc, and quick create, against the in-memory
// /api/v1 client inside a real TanStack router.

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

function NewTaskButton({ projectKey }: { projectKey: string }) {
  const quickCreate = useQuickCreate();
  return <Button onPress={() => quickCreate.open(projectKey)}>New</Button>;
}

function renderApp(url: string) {
  const queryClient = new QueryClient({
    defaultOptions: { queries: { retry: false, refetchOnWindowFocus: false, refetchInterval: false } },
  });
  const root = createRootRoute({
    component: () => (
      <UIProvider>
        <QuickCreateProvider>
          <Outlet />
          <QuickCreateDialog />
        </QuickCreateProvider>
      </UIProvider>
    ),
  });
  // Stand-in for the list: the New button and the search it was opened with.
  const list = createRoute({
    getParentRoute: () => root,
    path: '/w/$workspace/p/$projectKey/',
    component: function ListRoute() {
      const { projectKey } = list.useParams();
      return (
        <>
          <NewTaskButton projectKey={projectKey} />
          <p>List of {projectKey}</p>
        </>
      );
    },
  });
  const page = createRoute({
    getParentRoute: () => root,
    path: '/w/$workspace/p/$projectKey/$taskKey',
    component: function PageRoute() {
      const { projectKey, taskKey } = page.useParams();
      return <TaskPage key={taskKey} projectKey={projectKey} taskKey={taskKey} />;
    },
  });
  const cyclePage = createRoute({
    getParentRoute: () => root,
    path: '/w/$workspace/p/$projectKey/cycles/$number',
    component: function CycleRoute() {
      const { projectKey } = cyclePage.useParams();
      return <NewTaskButton projectKey={projectKey} />;
    },
  });
  const router = createRouter({
    routeTree: root.addChildren([list, page, cyclePage]),
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

const history = () => screen.getByRole('region', { name: 'Activity' });
const properties = () => screen.getByRole('complementary', { name: 'Properties' });
const comment = (author: string) =>
  within(history()).getAllByRole('article', { name: `Comment by ${author}` });
const composer = () => screen.getByRole('textbox', { name: 'Comment' });
const fake = () => api.current as FakeApi;

beforeEach(() => {
  api.current = createFakeApi();
  window.sessionStorage.clear();
  clearCommentDrafts();
  resetTimelinePreferences();
});

describe('history', () => {
  it('shows activity and comments in time order, with agent, edited and deleted states', async () => {
    renderApp('/w/acme/p/PAY/PAY-1');
    const anaComment = await waitFor(() => {
      const [found] = comment('Ana Ruiz');
      if (!found) throw new Error('not yet');
      return found;
    });

    expect(within(history()).getByText('created this task')).toBeInTheDocument();
    const [tomas] = comment('Tomás Berg');
    expect(within(tomas as HTMLElement).getByText('· edited')).toBeInTheDocument();
    const [claude] = comment('claude-dev');
    expect(claude).toHaveAttribute('data-agent');
    expect(within(claude as HTMLElement).getByText('acting for Ana')).toBeInTheDocument();
    expect(within(claude as HTMLElement).getByText('4xx stops retrying')).toBeInTheDocument();
    expect(within(history()).getByText(/Comment deleted by Tomás Berg/)).toBeInTheDocument();

    // Mention, kept http link, dropped javascript: link.
    expect(anaComment.querySelector('[data-mention]')).toHaveTextContent('@claude-dev');
    expect(within(anaComment).getByRole('link', { name: 'docs' })).toHaveAttribute(
      'href',
      'https://example.com/retry',
    );
    expect(within(anaComment).queryByRole('link', { name: 'bad' })).not.toBeInTheDocument();
    expect(anaComment).toHaveTextContent('bad');

    const authors = within(history())
      .getAllByRole('article')
      .map((element) => element.getAttribute('aria-label'));
    expect(authors).toEqual(['Comment by Tomás Berg', 'Comment by Ana Ruiz', 'Comment by claude-dev']);
  });

  it('shows cycle ends by the hourly job as a system line', async () => {
    const ref = (number: number) => ({
      id: `60000000-0000-4000-8000-0000000000${number}`,
      number,
      name: null,
    });
    fake().activity.push({
      id: '40000000-0000-4000-8000-000000000999',
      type: 'cycle.ended',
      taskKey: 'PAY-1',
      actor: null,
      onBehalfOf: null,
      changes: [{ field: 'cycle', from: ref(12), to: ref(13) }],
      createdAt: new Date(Date.now() - 120_000).toISOString(),
    });
    renderApp('/w/acme/p/PAY/PAY-1');
    const line = await within(await screen.findByRole('region', { name: 'Activity' })).findByText(
      'Cycle 12 ended. Moved to Cycle 13.',
    );
    expect(line.closest('[data-activity]')).toHaveAttribute('data-activity', 'cycle.ended');
  });

  it('shows comments only with Comments', async () => {
    const user = userEvent.setup();
    renderApp('/w/acme/p/PAY/PAY-1');
    await within(await screen.findByRole('region', { name: 'Activity' })).findByText('created this task');
    await user.click(within(history()).getByRole('button', { name: 'Comments' }));
    expect(within(history()).getByRole('button', { name: 'Comments' })).toHaveAttribute(
      'aria-pressed',
      'true',
    );
    expect(within(history()).queryByText('created this task')).not.toBeInTheDocument();
    expect(comment('claude-dev')).toHaveLength(1);
    await user.click(within(history()).getByRole('button', { name: 'All' }));
    expect(within(history()).getByText('created this task')).toBeInTheDocument();
  });

  it('folds long histories under "N earlier · Show all"', async () => {
    for (let index = 0; index < 30; index++) {
      fake().activity.push({
        id: `40000000-0000-4000-8000-${String(500 + index).padStart(12, '0')}`,
        type: 'task.updated',
        taskKey: 'PAY-1',
        actor: FAKE_PEOPLE.ana,
        onBehalfOf: null,
        changes: [{ field: 'priority', from: 'none', to: 'high' }],
        createdAt: new Date(Date.now() - 60_000 + index).toISOString(),
      });
    }
    const user = userEvent.setup();
    renderApp('/w/acme/p/PAY/PAY-1');
    const more = await within(await screen.findByRole('region', { name: 'Activity' })).findByRole('button', {
      name: /earlier · Show all/,
    });
    expect(within(history()).getAllByRole('listitem')).toHaveLength(15);
    expect(more.textContent).toMatch(/^\d+ earlier · Show all$/);
    await user.click(more);
    expect(within(history()).getAllByRole('listitem').length).toBeGreaterThan(30);
  });
});

describe('author-only actions', () => {
  it('offers Edit and Delete on your own comments only', async () => {
    renderApp('/w/acme/p/PAY/PAY-1');
    await waitFor(() => expect(comment('Ana Ruiz')).toHaveLength(1));
    const [own] = comment('Ana Ruiz');
    expect(within(own as HTMLElement).getByRole('button', { name: 'Edit' })).toBeInTheDocument();
    expect(within(own as HTMLElement).getByRole('button', { name: 'Delete' })).toBeInTheDocument();
    for (const other of [...comment('Tomás Berg'), ...comment('claude-dev')]) {
      expect(within(other).queryByRole('button', { name: 'Edit' })).not.toBeInTheDocument();
      expect(within(other).queryByRole('button', { name: 'Delete' })).not.toBeInTheDocument();
    }
  });

  it('edits in place and saves with Ctrl+Enter', async () => {
    const user = userEvent.setup();
    renderApp('/w/acme/p/PAY/PAY-1');
    await waitFor(() => expect(comment('Ana Ruiz')).toHaveLength(1));
    await user.click(within(comment('Ana Ruiz')[0] as HTMLElement).getByRole('button', { name: 'Edit' }));
    const editor = await screen.findByRole('textbox', { name: 'Edit comment' });
    await user.clear(editor);
    await user.type(editor, 'Updated text');
    await user.keyboard('{Control>}{Enter}{/Control}');

    await waitFor(() =>
      expect(fake().calls.comments).toContainEqual({
        op: 'update',
        id: '70000000-0000-4000-8000-000000000002',
        body: 'Updated text',
      }),
    );
    await waitFor(() =>
      expect(screen.queryByRole('textbox', { name: 'Edit comment' })).not.toBeInTheDocument(),
    );
    const [own] = comment('Ana Ruiz');
    expect(within(own as HTMLElement).getByText('Updated text')).toBeInTheDocument();
    expect(within(own as HTMLElement).getByText('· edited')).toBeInTheDocument();
  });

  it('deletes after the confirmation and leaves the placeholder', async () => {
    const user = userEvent.setup();
    renderApp('/w/acme/p/PAY/PAY-1');
    await waitFor(() => expect(comment('Ana Ruiz')).toHaveLength(1));
    await user.click(within(comment('Ana Ruiz')[0] as HTMLElement).getByRole('button', { name: 'Delete' }));
    const confirm = await screen.findByRole('alertdialog', { name: 'Delete this comment?' });
    await user.click(within(confirm).getByRole('button', { name: 'Delete' }));

    await waitFor(() =>
      expect(fake().calls.comments).toContainEqual({
        op: 'delete',
        id: '70000000-0000-4000-8000-000000000002',
      }),
    );
    expect(await within(history()).findByText(/Comment deleted by Ana Ruiz/)).toBeInTheDocument();
    expect(within(history()).queryAllByRole('article', { name: 'Comment by Ana Ruiz' })).toHaveLength(0);
  });
});

describe('comment box', () => {
  it('opens with M, mentions with @ and Enter, and sends with Ctrl+Enter', async () => {
    const user = userEvent.setup();
    renderApp('/w/acme/p/PAY/PAY-1');
    await waitFor(() => expect(comment('Ana Ruiz')).toHaveLength(1));
    expect(screen.getByRole('button', { name: 'Leave a comment or a note' })).toBeInTheDocument();

    await user.keyboard('m');
    await waitFor(() => expect(composer()).toHaveFocus());
    await user.keyboard('Thanks @cl');

    const picker = await screen.findByRole('listbox', { name: 'Mention' });
    const options = within(picker).getAllByRole('option');
    expect(options.map((option) => option.textContent)).toEqual([expect.stringContaining('claude-dev')]);
    expect(options[0]).toHaveTextContent('for Ana');
    expect(composer()).toHaveAttribute('aria-activedescendant', options[0]?.id);

    await user.keyboard('{Enter}');
    const link = `[@claude-dev](mention:${FAKE_PEOPLE.claude.id}) `;
    await waitFor(() => expect(composer()).toHaveValue(`Thanks ${link}`));
    expect(screen.queryByRole('listbox', { name: 'Mention' })).not.toBeInTheDocument();

    await user.keyboard('for the tests{Control>}{Enter}{/Control}');
    await waitFor(() =>
      expect(fake().calls.comments).toContainEqual({
        op: 'create',
        key: 'PAY-1',
        body: `Thanks ${link}for the tests`,
      }),
    );
    // Sent: the box closes again.
    await screen.findByRole('button', { name: 'Leave a comment or a note' });
    await waitFor(() => expect(comment('Ana Ruiz')).toHaveLength(2));
    const sent = comment('Ana Ruiz')[1] as HTMLElement;
    expect(sent.querySelector('[data-mention]')).toHaveTextContent('@claude-dev');
  });

  it('filters the picker as you type and closes it with Esc', async () => {
    const user = userEvent.setup();
    renderApp('/w/acme/p/PAY/PAY-1');
    await waitFor(() => expect(comment('Ana Ruiz')).toHaveLength(1));
    await user.click(screen.getByRole('button', { name: 'Leave a comment or a note' }));
    await waitFor(() => expect(composer()).toHaveFocus());
    await user.keyboard('@');
    const picker = await screen.findByRole('listbox', { name: 'Mention' });
    expect(within(picker).getAllByRole('option')).toHaveLength(3);
    await user.keyboard('to');
    await waitFor(() =>
      expect(
        within(picker)
          .getAllByRole('option')
          .map((option) => option.textContent),
      ).toEqual([expect.stringContaining('Tomás Berg')]),
    );
    await user.keyboard('{Escape}');
    await waitFor(() => expect(screen.queryByRole('listbox', { name: 'Mention' })).not.toBeInTheDocument());
    expect(composer()).toHaveValue('@to');
  });

  it('keeps the text when sending fails and sends it on Try again', async () => {
    const user = userEvent.setup();
    renderApp('/w/acme/p/PAY/PAY-1');
    await waitFor(() => expect(comment('Ana Ruiz')).toHaveLength(1));
    fake().control.failComments = true;
    let release = () => {};
    fake().control.holdComments = new Promise<void>((resolve) => {
      release = resolve;
    });

    await user.keyboard('m');
    await waitFor(() => expect(composer()).toHaveFocus());
    await user.keyboard('Looks good{Control>}{Enter}{/Control}');
    expect(await screen.findByText('Sending…')).toBeInTheDocument();
    await act(async () => release());

    const alert = await screen.findByRole('alert');
    expect(alert).toHaveTextContent("Couldn't send. Your text is still here.");
    expect(composer()).toHaveValue('Looks good');

    fake().control.failComments = false;
    fake().control.holdComments = null;
    await user.click(screen.getByRole('button', { name: /Try again/ }));
    await screen.findByRole('button', { name: 'Leave a comment or a note' });
    expect(fake().calls.comments.filter((call) => call.op === 'create')).toHaveLength(2);
    await waitFor(() => expect(comment('Ana Ruiz')).toHaveLength(2));
  });

  it('shows the Markdown in Preview and drops the text on Cancel', async () => {
    const user = userEvent.setup();
    renderApp('/w/acme/p/PAY/PAY-1');
    await waitFor(() => expect(comment('Ana Ruiz')).toHaveLength(1));
    await user.keyboard('m');
    await waitFor(() => expect(composer()).toHaveFocus());
    await user.keyboard('Some **bold**');
    await user.click(screen.getByRole('tab', { name: 'Preview' }));
    const preview = await screen.findByRole('tabpanel');
    expect(within(preview).getByText('bold').tagName).toBe('STRONG');
    await user.click(screen.getByRole('button', { name: 'Cancel' }));
    await user.click(await screen.findByRole('button', { name: 'Leave a comment or a note' }));
    await waitFor(() => expect(composer()).toHaveValue(''));
  });
});

describe('properties', () => {
  it('lists every field with placeholders and opens a picker from its row or its key', async () => {
    const user = userEvent.setup();
    renderApp('/w/acme/p/PAY/PAY-2');
    const props = await screen.findByRole('complementary', { name: 'Properties' });
    await within(props).findByRole('button', { name: 'Cycle' });
    for (const placeholder of ['Add labels', 'Set due date', 'Add to cycle']) {
      expect(within(props).getByText(placeholder)).toBeInTheDocument();
    }
    expect(within(props).getByText('Parent')).toBeInTheDocument();

    await user.click(within(props).getByRole('button', { name: 'Cycle' }));
    const cycles = await screen.findByRole('dialog', { name: 'Cycle' });
    await user.click(within(cycles).getByRole('menuitemradio', { name: /Cycle 13/ }));
    await waitFor(() =>
      expect(fake().calls.update).toContainEqual(expect.objectContaining({ key: 'PAY-2', cycle: 13 })),
    );
    await within(properties()).findByText('Cycle 13');

    await waitFor(() => expect(screen.queryByRole('dialog', { name: 'Cycle' })).not.toBeInTheDocument());
    await user.keyboard('s');
    const statuses = await screen.findByRole('dialog', { name: 'Status' });
    await user.click(within(statuses).getByRole('menuitemradio', { name: /Done/ }));
    await waitFor(() =>
      expect(fake().calls.update).toContainEqual(expect.objectContaining({ key: 'PAY-2', status: 'done' })),
    );
  });

  it('hides milestone and cycle when the project does not use them', async () => {
    api.current = createFakeApi({ usesMilestones: false, usesCycles: false });
    renderApp('/w/acme/p/PAY/PAY-1');
    await waitFor(() => expect(comment('Ana Ruiz')).toHaveLength(1));
    expect(within(properties()).getByRole('button', { name: 'Assignee' })).toBeInTheDocument();
    expect(within(properties()).queryByRole('button', { name: 'Milestone' })).not.toBeInTheDocument();
    expect(within(properties()).queryByRole('button', { name: 'Cycle' })).not.toBeInTheDocument();
  });

  it('shows labels, due date, subtasks, blockers and the reverse relation', async () => {
    api.current = createFakeApi({ fields: true });
    renderApp('/w/acme/p/PAY/PAY-1');
    const props = await screen.findByRole('complementary', { name: 'Properties' });
    await within(props).findByText('payouts');
    expect(within(props).getByText('backend')).toBeInTheDocument();
    expect(within(props).getByText('In 2 days')).toBeInTheDocument();
    const subtasks = screen.getByRole('region', { name: 'Subtasks' });
    expect(within(subtasks).getByRole('link', { name: /PAY-5/ })).toBeInTheDocument();
    expect(within(subtasks).getByRole('button', { name: /Add subtask/ })).toBeInTheDocument();
  });
});

describe('title, description and navigation', () => {
  it('edits the title with E and the description with D', async () => {
    const user = userEvent.setup();
    renderApp('/w/acme/p/PAY/PAY-1');
    await screen.findByRole('heading', { level: 1, name: /Task number 1/ });
    await waitFor(() => expect(comment('Ana Ruiz')).toHaveLength(1));
    await user.keyboard('e');
    const title = await screen.findByRole('textbox', { name: 'Title' });
    await user.clear(title);
    await user.type(title, 'Retry webhooks{Enter}');
    await waitFor(() =>
      expect(fake().calls.update).toContainEqual(
        expect.objectContaining({ key: 'PAY-1', title: 'Retry webhooks' }),
      ),
    );

    await user.keyboard('d');
    const description = await screen.findByRole('textbox', { name: 'Description' });
    await user.clear(description);
    await user.type(description, 'Six attempts.');
    await user.keyboard('{Control>}{Enter}{/Control}');
    await waitFor(() =>
      expect(fake().calls.update).toContainEqual(
        expect.objectContaining({ key: 'PAY-1', description: 'Six attempts.' }),
      ),
    );
  });

  it('walks the list it came from with J and K and goes back with Esc', async () => {
    const user = userEvent.setup();
    rememberTaskNavigation(workspace.id, {
      keys: ['PAY-3', 'PAY-1', 'PAY-2'],
      from: 'List',
      returnTo: '/w/acme/p/PAY?q=retry',
    });
    const { router } = renderApp('/w/acme/p/PAY/PAY-1');
    expect(await screen.findByText('2 of 3 in List')).toBeInTheDocument();
    await screen.findByRole('heading', { level: 1, name: /Task number 1/ });
    await user.keyboard('j');
    await waitFor(() => expect(router.state.location.pathname).toBe('/w/acme/p/PAY/PAY-2'));
    expect(await screen.findByText('3 of 3 in List')).toBeInTheDocument();
    await screen.findByRole('heading', { level: 1, name: /Task number 2/ });
    await user.keyboard('k');
    await waitFor(() => expect(router.state.location.pathname).toBe('/w/acme/p/PAY/PAY-1'));
    await screen.findByRole('heading', { level: 1, name: /Task number 1/ });
    await user.keyboard('{Escape}');
    await waitFor(() => expect(router.state.location.pathname).toBe('/w/acme/p/PAY'));
    expect(router.state.location.search).toMatchObject({ q: 'retry', focus: 'PAY-1' });
  });
});

describe('quick create', () => {
  it('prefills the cycle from the cycle page and sends it', async () => {
    const user = userEvent.setup();
    renderApp('/w/acme/p/PAY/cycles/13');
    await user.click(await screen.findByRole('button', { name: 'New' }));
    const dialog = await screen.findByRole('dialog', { name: 'New task' });
    expect(await within(dialog).findByRole('button', { name: 'Cycle' })).toHaveTextContent('Cycle 13');
    expect(within(dialog).getByRole('button', { name: 'Milestone' })).toHaveTextContent('Milestone');

    await user.type(within(dialog).getByRole('textbox', { name: 'Title' }), 'Alert merchants');
    await user.keyboard('{Control>}{Enter}{/Control}');
    await waitFor(() => expect(fake().calls.create).toHaveLength(1));
    expect(fake().calls.create[0]).toMatchObject({ project: 'PAY', title: 'Alert merchants', cycle: 13 });
    expect(fake().calls.create[0]).not.toHaveProperty('milestone');
  });

  it('prefills the milestone from the list filter and lets Shift+C pick a cycle', async () => {
    const user = userEvent.setup();
    renderApp(`/w/acme/p/PAY?milestone=${FAKE_MILESTONES.pci}`);
    await user.click(await screen.findByRole('button', { name: 'New' }));
    const dialog = await screen.findByRole('dialog', { name: 'New task' });
    expect(await within(dialog).findByRole('button', { name: 'Milestone' })).toHaveTextContent('PCI audit');

    // Shift+C works once focus leaves the title field.
    await user.click(within(dialog).getByText('New task'));
    await user.keyboard('{Shift>}C{/Shift}');
    const menu = await screen.findByRole('dialog', { name: 'Cycle' });
    await user.click(within(menu).getByRole('menuitemradio', { name: /Cycle 12/ }));
    await waitFor(() =>
      expect(within(dialog).getByRole('button', { name: 'Cycle' })).toHaveTextContent('Cycle 12'),
    );

    await user.type(within(dialog).getByRole('textbox', { name: 'Title' }), 'Audit logs');
    await user.keyboard('{Control>}{Enter}{/Control}');
    await waitFor(() => expect(fake().calls.create).toHaveLength(1));
    expect(fake().calls.create[0]).toMatchObject({ milestone: FAKE_MILESTONES.pci, cycle: 12 });
  });

  it('sets priority, labels, due date and parent, and keeps going with Create more', async () => {
    api.current = createFakeApi({ fields: true });
    const user = userEvent.setup();
    renderApp('/w/acme/p/PAY');
    await user.click(await screen.findByRole('button', { name: 'New' }));
    const dialog = await screen.findByRole('dialog', { name: 'New task' });
    await user.type(within(dialog).getByRole('textbox', { name: 'Title' }), 'Show fees');

    await user.click(within(dialog).getByRole('button', { name: 'Priority' }));
    await user.click(
      within(await screen.findByRole('dialog', { name: 'Priority' })).getByRole('menuitemradio', {
        name: /High/,
      }),
    );
    await user.click(within(dialog).getByRole('button', { name: 'Labels' }));
    const labels = await screen.findByRole('dialog', { name: 'Labels' });
    await user.click(await within(labels).findByRole('menuitemcheckbox', { name: /payouts/ }));
    await user.keyboard('{Escape}');
    await user.click(within(dialog).getByRole('button', { name: 'More properties' }));
    await user.click(within(dialog).getByRole('button', { name: 'Parent' }));
    const parents = await screen.findByRole('dialog', { name: 'Parent' });
    await user.click(await within(parents).findByRole('menuitemradio', { name: /Task number 1/ }));

    await user.click(within(dialog).getByRole('switch', { name: 'Create more' }));
    await user.click(within(dialog).getByRole('button', { name: /Create task/ }));
    await waitFor(() => expect(fake().calls.create).toHaveLength(1));
    expect(fake().calls.create[0]).toMatchObject({
      project: 'PAY',
      title: 'Show fees',
      priority: 'high',
      labels: ['payouts'],
      parent: 'PAY-1',
    });
    // A subtask without an assignee takes its parent's: none is sent.
    expect(fake().calls.create[0]).not.toHaveProperty('assignee');
    expect(await within(dialog).findByText(/^Created PAY-/)).toBeInTheDocument();
    expect(within(dialog).getByRole('textbox', { name: 'Title' })).toHaveValue('');
  });
});
