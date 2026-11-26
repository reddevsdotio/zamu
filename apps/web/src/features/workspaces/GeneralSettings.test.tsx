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
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { testWorkspace } from '~/lib/testing';
import { WorkspaceProvider } from '~/lib/workspace';
import { UIProvider } from '~/ui';
import { GeneralSettings } from './GeneralSettings';

// Settings › General against fake server functions: rename and re-address, the read-only view for
// members, Leave refused for the last owner and for the person responsible for agents, and Delete with
// the counts and the typed slug.

configure({ asyncUtilTimeout: 3000 });
vi.setConfig({ testTimeout: 20_000 });

type Failure = { code: string; message: string; issues: { path: string; message: string }[] };

const server = vi.hoisted(() => ({
  role: 'owner' as 'owner' | 'admin' | 'member',
  updates: [] as unknown[],
  updateFailure: null as Failure | null,
  leaveFailure: null as Failure | null,
  deleted: [] as string[],
  left: 0,
}));

vi.mock('./server', () => ({
  updateWorkspaceFn: async ({ data }: { data: { input: { name?: string; slug?: string } } }) => {
    server.updates.push(data.input);
    if (server.updateFailure) return { ok: false, error: server.updateFailure };
    return {
      ok: true,
      data: {
        id: 'w1',
        name: data.input.name ?? 'Acme',
        slug: data.input.slug ?? 'acme',
        role: server.role,
      },
    };
  },
  leaveWorkspaceFn: async () => {
    if (server.leaveFailure) return { ok: false, error: server.leaveFailure };
    server.left += 1;
    return { ok: true, data: { id: 'w1', name: 'Acme', slug: 'acme' } };
  },
  workspaceContentsFn: async () => ({ ok: true, data: { projects: 3, tasks: 120, agents: 2, keys: 0 } }),
  deleteWorkspaceFn: async ({ data }: { data: { input: { confirmSlug: string } } }) => {
    server.deleted.push(data.input.confirmSlug);
    return { ok: true, data: { projects: 3, tasks: 120, agents: 2, keys: 0 } };
  },
  listMyWorkspacesFn: async () => ({ ok: true, data: { items: [], canCreate: true } }),
}));

// The settings queries module sits next to its own server functions; General reads only me from it.
vi.mock('~/features/settings/server', () => ({}));

const workspace = testWorkspace({
  me: {
    get: async () => ({
      user: { id: 'u1', name: 'Ana Ruiz', email: 'ana@example.com', kind: 'person', responsible: null },
      workspace: { id: 'w1', name: 'Acme', slug: 'acme' },
      role: server.role,
      auth: { method: 'session', scope: null },
    }),
  },
});

function renderPage(url = '/w/acme/settings/general') {
  const queryClient = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  const root = createRootRoute({ component: () => <Outlet /> });
  const routes = [
    createRoute({ getParentRoute: () => root, path: '/', component: () => <p>landing page</p> }),
    createRoute({
      getParentRoute: () => root,
      path: '/w/$workspace/settings/general',
      component: GeneralSettings,
    }),
  ];
  const router = createRouter({
    routeTree: root.addChildren(routes),
    history: createMemoryHistory({ initialEntries: [url] }),
  });
  render(
    <QueryClientProvider client={queryClient}>
      <UIProvider>
        <WorkspaceProvider workspace={workspace}>
          <RouterProvider router={router} />
        </WorkspaceProvider>
      </UIProvider>
    </QueryClientProvider>,
  );
  return { router };
}

beforeEach(() => {
  server.role = 'owner';
  server.updates = [];
  server.updateFailure = null;
  server.leaveFailure = null;
  server.deleted = [];
  server.left = 0;
});

describe('General settings', () => {
  it('renames the workspace and says it saved', async () => {
    const user = userEvent.setup();
    renderPage();
    const name = await screen.findByRole('textbox', { name: 'Name' });
    expect(name).toHaveValue('Acme');
    expect(screen.getByRole('textbox', { name: 'Address' })).toHaveValue('acme');
    await user.clear(name);
    await user.type(name, 'Acme Corp');
    await user.click(screen.getByRole('button', { name: 'Save changes' }));
    expect(await screen.findByRole('status')).toHaveTextContent('Saved.');
    expect(server.updates).toEqual([{ name: 'Acme Corp' }]);
  });

  it('changes the address, says old links keep working and opens the page at the new one', async () => {
    const user = userEvent.setup();
    const { router } = renderPage();
    const slug = await screen.findByRole('textbox', { name: 'Address' });
    await user.clear(slug);
    await user.type(slug, 'acme-corp');
    expect(screen.getByText('Links to /w/acme keep working: they open the new address.')).toBeInTheDocument();
    await user.click(screen.getByRole('button', { name: 'Save changes' }));
    await waitFor(() => expect(router.state.location.pathname).toBe('/w/acme-corp/settings/general'));
    expect(server.updates).toEqual([{ slug: 'acme-corp' }]);
  });

  it('shows a taken address under the field', async () => {
    const user = userEvent.setup();
    const message = 'The address globex is taken. Pick another.';
    server.updateFailure = { code: 'SLUG_TAKEN', message, issues: [{ path: 'slug', message }] };
    renderPage();
    const slug = await screen.findByRole('textbox', { name: 'Address' });
    await user.clear(slug);
    await user.type(slug, 'globex');
    await user.click(screen.getByRole('button', { name: 'Save changes' }));
    expect(await screen.findByText(message)).toBeInTheDocument();
    expect(slug).toHaveAttribute('aria-invalid', 'true');
  });

  it('shows members the name and address read-only, with Leave and without Delete', async () => {
    server.role = 'member';
    renderPage();
    expect(
      await screen.findByText('Only owners and admins can rename the workspace or change its address.'),
    ).toBeInTheDocument();
    expect(screen.getByRole('textbox', { name: 'Name' })).toHaveAttribute('readonly');
    expect(screen.getByRole('textbox', { name: 'Address' })).toHaveAttribute('readonly');
    expect(screen.queryByRole('button', { name: 'Save changes' })).not.toBeInTheDocument();
    expect(screen.getByRole('button', { name: 'Leave workspace' })).toBeInTheDocument();
    expect(screen.queryByRole('button', { name: 'Delete workspace' })).not.toBeInTheDocument();
  });

  it('refuses Leave for the last owner and offers Close only', async () => {
    const user = userEvent.setup();
    server.leaveFailure = {
      code: 'LAST_OWNER',
      message: "You are the only owner of Acme, so you can't leave it. Delete the workspace instead.",
      issues: [],
    };
    renderPage();
    await user.click(await screen.findByRole('button', { name: 'Leave workspace' }));
    const dialog = await screen.findByRole('alertdialog', { name: 'Leave Acme?' });
    await user.click(within(dialog).getByRole('button', { name: 'Leave workspace' }));
    expect(await within(dialog).findByRole('alert')).toHaveTextContent(
      "You are the only owner of Acme, so you can't leave it. Delete the workspace instead.",
    );
    expect(within(dialog).queryByRole('button', { name: 'Leave workspace' })).not.toBeInTheDocument();
    await user.click(within(dialog).getByRole('button', { name: 'Close' }));
    await waitFor(() => expect(screen.queryByRole('alertdialog')).not.toBeInTheDocument());
    expect(server.left).toBe(0);
  });

  it('lists the agents that keep the person from leaving', async () => {
    const user = userEvent.setup();
    server.role = 'admin';
    server.leaveFailure = {
      code: 'CONFLICT',
      message:
        'You are responsible for claude-dev and codex-ci here. Hand them to someone else or remove them first.',
      issues: [
        { path: 'agents', message: 'claude-dev' },
        { path: 'agents', message: 'codex-ci' },
      ],
    };
    renderPage();
    await user.click(await screen.findByRole('button', { name: 'Leave workspace' }));
    const dialog = await screen.findByRole('alertdialog', { name: 'Leave Acme?' });
    await user.click(within(dialog).getByRole('button', { name: 'Leave workspace' }));
    const agents = await within(dialog).findByRole('list', { name: 'Agents in the way' });
    // Each row starts with the agent's avatar mark (its initials), then the name.
    expect(
      within(agents)
        .getAllByRole('listitem')
        .map((item) => item.textContent),
    ).toEqual(['cdclaude-dev', 'cccodex-ci']);
  });

  it('leaves and goes to the landing page', async () => {
    const user = userEvent.setup();
    server.role = 'member';
    const { router } = renderPage();
    await user.click(await screen.findByRole('button', { name: 'Leave workspace' }));
    const dialog = await screen.findByRole('alertdialog', { name: 'Leave Acme?' });
    await user.click(within(dialog).getByRole('button', { name: 'Leave workspace' }));
    await waitFor(() => expect(router.state.location.pathname).toBe('/'));
    expect(server.left).toBe(1);
  });

  it('deletes with the counts and the slug typed again', async () => {
    const user = userEvent.setup();
    const { router } = renderPage();
    await user.click(await screen.findByRole('button', { name: 'Delete workspace' }));
    const dialog = await screen.findByRole('alertdialog', { name: 'Delete Acme?' });
    expect(
      await within(dialog).findByText('Deletes Acme with 3 projects, 120 tasks and 2 agents.'),
    ).toBeInTheDocument();
    const confirm = within(dialog).getByRole('button', { name: 'Delete workspace' });
    expect(confirm).toBeDisabled();
    const typed = within(dialog).getByRole('textbox', { name: 'Type acme to confirm' });
    await user.type(typed, 'acm');
    expect(confirm).toBeDisabled();
    await user.type(typed, 'E');
    expect(confirm).toBeEnabled();
    await user.click(confirm);
    await waitFor(() => expect(router.state.location.pathname).toBe('/'));
    expect(server.deleted).toEqual(['acmE']);
  });
});
