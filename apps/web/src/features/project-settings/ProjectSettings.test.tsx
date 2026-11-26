import { ORPCError } from '@orpc/client';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { act, render, screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { type ReactNode, useState } from 'react';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { meQuery, projectsQuery } from '~/features/projects/queries';
import { renderInWorkspace, testWorkspace } from '~/lib/testing';
import { WorkspaceProvider } from '~/lib/workspace';
import { BacklogStatusView, NoSource, setupHref } from './BacklogSettings';
import {
  announceProjectDeleted,
  DELETED_TOAST_MS,
  DeletedProjectToast,
  DeleteProjectDialog,
} from './DeleteProjectDialog';
import { CONNECTION, sourceStatus } from './fixtures';
import { GeneralForm, GeneralSettings } from './GeneralSettings';
import { type GeneralProject, generalFailure, keyLockReason, projectChanges } from './general';
import { webhookSteps } from './WebhookDialog';

// These screens are rendered from props; the stub keeps the API and server modules out. Only
// client.projects.delete answers, through `api.deleteProject`.
const api = vi.hoisted(() => ({ deleteProject: vi.fn(), navigate: vi.fn() }));
/** The test workspace (/w/acme) around the fake client. */
const workspace = (() => {
  const fail = (path: string[] = []): unknown =>
    new Proxy(() => {}, {
      get: (_target, key) => (typeof key === 'string' ? fail([...path, key]) : undefined),
      apply: (_target, _this, args) =>
        path.join('.') === 'projects.delete'
          ? api.deleteProject(...args)
          : Promise.reject(new Error('no API in these tests')),
    });
  const client = fail();
  return testWorkspace(client);
})();
vi.mock('@tanstack/react-router', async (original) => ({
  ...(await original<typeof import('@tanstack/react-router')>()),
  useNavigate: () => api.navigate,
}));

function withQuery(children: ReactNode) {
  return (
    <QueryClientProvider client={new QueryClient()}>
      <WorkspaceProvider workspace={workspace}>{children}</WorkspaceProvider>
    </QueryClientProvider>
  );
}

const PROJECT: GeneralProject = {
  key: 'OPS',
  name: 'Operations',
  description: 'Runbooks',
  usesMilestones: true,
  usesCycles: true,
  repository: 'https://gitlab.com/reddevs/ops-runbooks.git',
  locked: [],
};

const MIRRORED: GeneralProject = {
  ...PROJECT,
  key: 'PAY',
  name: 'Payments',
  locked: ['key', 'repository', 'usesMilestones'],
};

describe('General settings', () => {
  it('sends only what changed, the key included while the project has no tasks', async () => {
    const user = userEvent.setup();
    const onSubmit = vi.fn().mockResolvedValue(null);
    render(<GeneralForm project={PROJECT} hasTasks={false} onSubmit={onSubmit} />);
    const key = screen.getByLabelText('Key');
    expect(key).not.toHaveAttribute('readonly');
    await user.clear(key);
    await user.type(key, 'opx');
    await user.click(screen.getByRole('switch', { name: 'Cycles' }));
    await user.click(screen.getByRole('button', { name: 'Save changes' }));
    expect(onSubmit).toHaveBeenCalledWith({ key: 'OPX', usesCycles: false });
    expect(await screen.findByText('Saved.')).toBeVisible();
  });

  it('Discard puts the saved values back', async () => {
    const user = userEvent.setup();
    render(<GeneralForm project={PROJECT} hasTasks onSubmit={vi.fn()} />);
    const discard = screen.getByRole('button', { name: 'Discard' });
    expect(discard).toBeDisabled();
    await user.clear(screen.getByLabelText('Name'));
    await user.type(screen.getByLabelText('Name'), 'Ops');
    expect(discard).toBeEnabled();
    await user.click(discard);
    expect(screen.getByLabelText('Name')).toHaveValue('Operations');
    expect(discard).toBeDisabled();
  });

  it('locks the key and the milestones switch of a mirrored project, saying why', () => {
    render(<GeneralForm project={MIRRORED} hasTasks onSubmit={vi.fn()} />);
    expect(screen.getByLabelText('Key')).toHaveAttribute('readonly');
    expect(
      screen.getByText("Task keys embed it, and this project has tasks, so it can't change."),
    ).toBeVisible();
    expect(screen.getByRole('switch', { name: 'Milestones' })).toBeDisabled();
    expect(screen.getByText(/stays on while Backlog\.md is mirrored/)).toBeVisible();
    expect(
      screen.getByText(
        'Matches gitlab.com/reddevs/ops-runbooks. The Backlog.md mirror reads this repository, so clearing it pauses the mirror.',
      ),
    ).toBeVisible();
  });

  it('refuses an empty name and shows server errors on their field', async () => {
    const user = userEvent.setup();
    const onSubmit = vi
      .fn()
      .mockResolvedValue({ field: 'repository', message: 'PAY reads Backlog.md from …' });
    render(<GeneralForm project={MIRRORED} hasTasks onSubmit={onSubmit} />);
    await user.clear(screen.getByLabelText('Name'));
    await user.click(screen.getByRole('button', { name: 'Save changes' }));
    expect(screen.getByText('Enter a project name.')).toBeVisible();
    expect(onSubmit).not.toHaveBeenCalled();
    await user.type(screen.getByLabelText('Name'), 'Payments');
    await user.clear(screen.getByLabelText(/Repository/));
    await user.type(screen.getByLabelText(/Repository/), 'https://gitlab.com/x/y.git');
    await user.click(screen.getByRole('button', { name: 'Save changes' }));
    expect(onSubmit).toHaveBeenCalledWith({ repository: 'https://gitlab.com/x/y.git' });
    expect(await screen.findByText('PAY reads Backlog.md from …')).toBeVisible();
  });

  it('computes changes, failures and the key lock', () => {
    expect(projectChanges(PROJECT, { ...PROJECT, description: '  ', repository: '', key: 'OPS' })).toEqual({
      description: null,
      repository: null,
    });
    expect(
      generalFailure(
        new ORPCError('CONFLICT', { message: 'Milestones stay on', data: { field: 'usesMilestones' } }),
      ),
    ).toEqual({ field: 'usesMilestones', message: 'Milestones stay on' });
    expect(generalFailure(new ORPCError('FORBIDDEN'))).toEqual({
      message: "You don't have permission to change this project.",
    });
    expect(generalFailure(new Error('offline')).message).toMatch(/Couldn't save the project/);
    expect(keyLockReason(PROJECT, false)).toBeNull();
    expect(keyLockReason(PROJECT, undefined)).not.toBeNull();
    expect(keyLockReason({ ...PROJECT, locked: ['key'] }, false)).toMatch(/Backlog\.md files/);
  });
});

function statusView(props: Partial<Parameters<typeof BacklogStatusView>[0]> = {}) {
  const handlers = {
    onRefresh: vi.fn(),
    onOpenWebhook: vi.fn(),
    onSwitch: vi.fn(),
    onUseAnotherConnection: vi.fn(),
  };
  render(
    withQuery(
      <BacklogStatusView
        status={sourceStatus()}
        projectName="Payments"
        canManage
        canRefresh
        {...handlers}
        {...props}
      />,
    ),
  );
  return handlers;
}

describe('Backlog.md settings', () => {
  it('shows a healthy mirror with its facts, mappings and actions', async () => {
    const user = userEvent.setup();
    const handlers = statusView();
    const source = screen.getByRole('region', { name: 'Source' });
    expect(source).toHaveTextContent('Mirroring');
    expect(source).toHaveTextContent('Mirror · follows the default branch');
    expect(within(source).getByRole('link', { name: 'gitlab.com/reddevs/payments' })).toHaveAttribute(
      'href',
      'https://gitlab.com/reddevs/payments',
    );
    expect(within(source).getByRole('link', { name: '9 hidden, removed from Backlog.md' })).toHaveAttribute(
      'href',
      '/w/acme/p/PAY?hidden=only',
    );
    expect(screen.getByText('None. Every file was read and every value is mapped.')).toBeVisible();
    expect(screen.getByRole('link', { name: 'Edit mappings' })).toHaveAttribute(
      'href',
      '/w/acme/p/PAY/backlog-setup?step=mappings&edit=1',
    );
    expect(screen.getByText('fallback')).toBeVisible();
    await user.click(within(source).getByRole('button', { name: 'Refresh now' }));
    expect(handlers.onRefresh).toHaveBeenCalled();
    await user.click(within(source).getByRole('button', { name: 'Setup' }));
    expect(handlers.onOpenWebhook).toHaveBeenCalled();
    const card = screen.getByRole('region', { name: 'Switch to Zamu' });
    expect(card).toHaveTextContent('Make Zamu the owner of these tasks');
    expect(screen.queryByRole('button', { name: 'Detach…' })).toBeNull();
    await user.click(within(card).getByRole('button', { name: 'Switch to Zamu…' }));
    expect(handlers.onSwitch).toHaveBeenCalled();
  });

  it('gives members a read-only page', () => {
    statusView({ canManage: false, canRefresh: false });
    expect(screen.getByText(/You can read this page\. Owners and admins can refresh/)).toBeVisible();
    expect(screen.queryByRole('button', { name: 'Refresh now' })).toBeNull();
    expect(screen.queryByRole('link', { name: 'Edit mappings' })).toBeNull();
    expect(screen.queryByRole('button', { name: 'Switch to Zamu…' })).toBeNull();
    expect(screen.queryByRole('button', { name: 'Setup' })).toBeNull();
  });

  it('lists the problems of a refresh with warnings', () => {
    statusView({
      status: sourceStatus({
        state: 'warnings',
        problems: {
          nextCursor: 'next',
          counts: { files: 30, values: 1 },
          items: [
            {
              kind: 'file',
              path: 'backlog/tasks/back-12 - Split.md',
              backlogId: 'BACK-12',
              skipped: true,
              message: 'dependencies must be a flat list (line 9)',
            },
          ],
        },
      }),
    });
    const problems = screen.getByRole('list', { name: 'Problems in the last refresh' });
    expect(problems).toHaveTextContent('dependencies must be a flat list (line 9)');
    expect(screen.getByRole('button', { name: 'Show more (30 left)' })).toBeVisible();
    expect(screen.getByText('Skipped files keep their last good version, if they had one.')).toBeVisible();
  });

  it('explains a failed and a paused mirror', async () => {
    const user = userEvent.setup();
    const handlers = statusView({
      status: sourceStatus({
        state: 'paused',
        connection: { ...CONNECTION, status: 'unreachable' },
      }),
      canRefresh: false,
    });
    expect(screen.getByRole('note')).toHaveTextContent(
      "The mirror is paused: the connection GitLab · reddevs can't reach gitlab.com",
    );
    expect(screen.getByText('Host unreachable')).toBeVisible();
    await user.click(screen.getByRole('button', { name: 'Use another connection' }));
    expect(handlers.onUseAnotherConnection).toHaveBeenCalled();
  });

  it('shows an import as owned by Zamu, with the export command and its history', () => {
    statusView({
      status: sourceStatus({
        state: 'detached',
        mode: 'import',
        detachedAt: '2026-10-23T14:02:00Z',
        detachedBy: sourceStatus().createdBy,
        history: [
          {
            id: '00000000-0000-7000-8000-000000000e01',
            type: 'project.backlog_imported',
            actor: null,
            onBehalfOf: null,
            origin: 'backlog',
            originRef: 'a1b2c3d4e5',
            details: { mode: 'import', repository: 'gitlab.com/reddevs/payments', tasks: 412, milestones: 6 },
            createdAt: '2026-10-23T14:02:00Z',
          },
        ],
      }),
    });
    const owned = screen.getByRole('note');
    expect(owned).toHaveTextContent(/Owned by Zamu since Oct 23/);
    expect(owned).toHaveTextContent('Imported once by Ana Ruiz. The task files are no longer read.');
    expect(screen.getByRole('region', { name: 'Keep a copy as files' })).toHaveTextContent(
      'zamu backlog export --project PAY',
    );
    expect(screen.getByRole('region', { name: 'History' })).toHaveTextContent(
      'Backlog.md imported 412 tasks and 6 milestones from gitlab.com/reddevs/payments a1b2c3d',
    );
    expect(screen.queryByRole('region', { name: 'Mappings' })).toBeNull();
    expect(screen.queryByRole('button', { name: 'Refresh now' })).toBeNull();
    expect(screen.queryByRole('button', { name: 'Switch to Zamu…' })).toBeNull();
  });

  it('offers mirror and import on an empty project', () => {
    renderInWorkspace(
      <NoSource project={{ key: 'OPS', repository: PROJECT.repository }} hasTasks={false} canManage />,
    );
    expect(screen.getByRole('link', { name: 'Set up a mirror' })).toHaveAttribute(
      'href',
      '/w/acme/p/OPS/backlog-setup?mode=mirror',
    );
    expect(screen.getByRole('link', { name: 'Import' })).toHaveAttribute(
      'href',
      setupHref(workspace.slug, 'OPS', { mode: 'import' }),
    );
    expect(screen.getByText(/Repository: gitlab\.com\/reddevs\/ops-runbooks, from General/)).toBeVisible();
  });

  it('turns setup off for a project that has tasks', () => {
    renderInWorkspace(
      <NoSource project={{ key: 'WEB', repository: PROJECT.repository }} hasTasks canManage />,
    );
    expect(screen.getByRole('button', { name: 'Set up a mirror' })).toBeDisabled();
    expect(screen.getByText(/already has tasks/)).toBeVisible();
  });
});

describe('Webhook steps', () => {
  it('has four steps per provider', () => {
    for (const provider of ['github', 'gitlab', 'gitea'] as const) {
      expect(webhookSteps(provider, 'gitlab.com/reddevs/payments', 'main')).toHaveLength(4);
    }
  });
});

/** General settings until the delete navigates away; then Home, where the shell shows the toast. */
function DeleteHarness() {
  const [onProjects, setOnProjects] = useState(false);
  api.navigate.mockImplementation(async () => setOnProjects(true));
  return onProjects ? <DeletedProjectToast /> : <GeneralSettings projectKey="OPS" />;
}

describe('Delete project', () => {
  afterEach(() => {
    api.deleteProject.mockReset();
    api.navigate.mockReset();
    vi.useRealTimers();
  });

  const TEXT =
    "Deletes its tasks, comments, history, milestones, cycles and Backlog.md mirror. This can't be undone.";

  it('enables Delete project only once the key is typed', async () => {
    const user = userEvent.setup();
    const onDelete = vi.fn().mockResolvedValue(undefined);
    render(
      <DeleteProjectDialog
        isOpen
        onOpenChange={vi.fn()}
        projectKey="OPS"
        mirrored={false}
        onDelete={onDelete}
      />,
    );
    const dialog = screen.getByRole('alertdialog', { name: 'Delete OPS?' });
    expect(dialog).toHaveTextContent(TEXT);
    expect(dialog).not.toHaveTextContent('Remove the webhook on the git host too.');
    const remove = within(dialog).getByRole('button', { name: 'Delete project' });
    const field = within(dialog).getByLabelText('Type OPS to confirm');
    expect(remove).toBeDisabled();
    await user.type(field, 'OP');
    expect(remove).toBeDisabled();
    await user.type(field, 'X');
    expect(remove).toBeDisabled();
    await user.clear(field);
    await user.type(field, ' ops ');
    expect(remove).toBeEnabled();
    await user.click(remove);
    expect(onDelete).toHaveBeenCalledWith('ops');
  });

  it('asks a mirrored project to remove its webhook and shows a refusal', async () => {
    const user = userEvent.setup();
    const onDelete = vi
      .fn()
      .mockRejectedValue(
        new ORPCError('FORBIDDEN', { message: 'Only owners and admins can delete a project.' }),
      );
    render(
      <DeleteProjectDialog isOpen onOpenChange={vi.fn()} projectKey="PAY" mirrored onDelete={onDelete} />,
    );
    const dialog = screen.getByRole('alertdialog', { name: 'Delete PAY?' });
    expect(dialog).toHaveTextContent(`${TEXT} Remove the webhook on the git host too.`);
    await user.type(within(dialog).getByLabelText('Type PAY to confirm'), 'PAY{Enter}');
    expect(await within(dialog).findByText('Only owners and admins can delete a project.')).toBeVisible();
    expect(within(dialog).getByRole('button', { name: 'Delete project' })).toBeEnabled();
  });

  function queryClientWith(role: 'owner' | 'admin' | 'member') {
    const queryClient = new QueryClient({ defaultOptions: { queries: { retry: false } } });
    const project = (key: string, name: string) => ({
      ...PROJECT,
      id: crypto.randomUUID(),
      key,
      name,
      currentCycle: null,
      backlog: null,
      openCount: 0,
      openCounts: { backlog: 0, todo: 0, in_progress: 0, in_review: 0 },
      openAssignees: [],
      lastActivityAt: null,
      createdAt: '2026-10-01T10:00:00.000Z',
      updatedAt: '2026-10-01T10:00:00.000Z',
    });
    queryClient.setQueryData(projectsQuery(workspace.api).queryKey, {
      items: [project('OPS', 'Operations'), project('WEB', 'Website')],
    } as never);
    queryClient.setQueryData(meQuery(workspace.api).queryKey, { role } as never);
    return queryClient;
  }

  it('is offered to owners and admins only', () => {
    const member = render(
      <QueryClientProvider client={queryClientWith('member')}>
        <WorkspaceProvider workspace={workspace}>
          <GeneralSettings projectKey="OPS" />
        </WorkspaceProvider>
      </QueryClientProvider>,
    );
    expect(screen.getByRole('form', { name: 'General' })).toBeVisible();
    expect(screen.queryByText('Delete this project')).toBeNull();
    member.unmount();
    render(
      <QueryClientProvider client={queryClientWith('admin')}>
        <WorkspaceProvider workspace={workspace}>
          <GeneralSettings projectKey="OPS" />
        </WorkspaceProvider>
      </QueryClientProvider>,
    );
    expect(screen.getByText('Delete this project')).toBeVisible();
    expect(screen.getByText(TEXT)).toBeVisible();
  });

  it('deletes, goes to Home, drops the project from the cache and shows the toast', async () => {
    const user = userEvent.setup();
    api.deleteProject.mockResolvedValue(undefined);
    api.navigate.mockResolvedValue(undefined);
    const queryClient = queryClientWith('owner');
    const invalidate = vi.spyOn(queryClient, 'invalidateQueries');
    render(
      <QueryClientProvider client={queryClient}>
        <WorkspaceProvider workspace={workspace}>
          <DeleteHarness />
        </WorkspaceProvider>
      </QueryClientProvider>,
    );
    await user.click(screen.getByRole('button', { name: 'Delete project' }));
    const dialog = screen.getByRole('alertdialog', { name: 'Delete OPS?' });
    await user.type(within(dialog).getByLabelText('Type OPS to confirm'), 'ops');
    await user.click(within(dialog).getByRole('button', { name: 'Delete project' }));

    expect(await screen.findByRole('status')).toHaveTextContent('Deleted OPS');
    expect(api.deleteProject).toHaveBeenCalledWith({ project: 'OPS', confirmKey: 'ops' });
    expect(api.navigate).toHaveBeenCalledWith({ to: '/w/$workspace', params: { workspace: 'acme' } });
    const cached = queryClient.getQueryData(projectsQuery(workspace.api).queryKey) as {
      items: { key: string }[];
    };
    expect(cached.items.map((item) => item.key)).toEqual(['WEB']);
    await waitFor(() => {
      const keys = invalidate.mock.calls.map(([filters]) => JSON.stringify(filters?.queryKey));
      for (const procedure of ['projects', 'tasks', 'dashboard', 'milestones', 'cycles']) {
        expect(
          keys.some((key) => key.includes(`"${procedure}"`)),
          procedure,
        ).toBe(true);
      }
    });
  });

  it('shows the toast once, and not for a stale deletion', () => {
    vi.useFakeTimers();
    announceProjectDeleted('PAY');
    const first = render(<DeletedProjectToast />);
    expect(screen.getByRole('status')).toHaveTextContent('Deleted PAY');
    act(() => {
      vi.advanceTimersByTime(DELETED_TOAST_MS + 10);
    });
    expect(screen.queryByRole('status')).toBeNull();
    first.unmount();
    announceProjectDeleted('WEB', Date.now() - DELETED_TOAST_MS - 1);
    render(<DeletedProjectToast />);
    expect(screen.queryByRole('status')).toBeNull();
  });
});
