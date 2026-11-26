import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import {
  createMemoryHistory,
  createRootRoute,
  createRoute,
  createRouter,
  RouterProvider,
} from '@tanstack/react-router';
import { configure, render, screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { testWorkspace } from '~/lib/testing';
import { WorkspaceProvider } from '~/lib/workspace';
import { UIProvider } from '~/ui';
import { MembersPage } from './MembersPage';

// Removing a member from Settings › Members: the confirm, and the refusal while the person is
// responsible for agents in the workspace, which lists those agents.

configure({ asyncUtilTimeout: 3000 });
vi.setConfig({ testTimeout: 20_000 });

const server = vi.hoisted(() => ({ removed: [] as string[], refuse: false }));

vi.mock('./server', () => ({
  listInvitationsFn: async () => ({ ok: true, data: [] }),
  removeMemberFn: async ({ data }: { data: { input: { userId: string } } }) => {
    if (server.refuse) {
      return {
        ok: false,
        error: {
          code: 'CONFLICT',
          message:
            'Tomás Berg is responsible for claude-dev here. Hand them to someone else or remove them first.',
          issues: [{ path: 'agents', message: 'claude-dev' }],
        },
      };
    }
    server.removed.push(data.input.userId);
    return { ok: true, data: { id: data.input.userId, name: 'Tomás Berg', kind: 'person' } };
  },
}));

const person = (id: string, name: string, role: 'owner' | 'member') => ({
  id,
  name,
  email: `${name.split(' ')[0]?.toLowerCase()}@example.com`,
  kind: 'person',
  role,
  responsible: null,
  lastActiveAt: null,
  apiKeyCount: 0,
  joinedAt: '2026-10-01T09:00:00.000Z',
});

const workspace = testWorkspace({
  me: {
    get: async () => ({
      user: { id: 'u1', name: 'Ana Ruiz', email: 'ana@example.com', kind: 'person', responsible: null },
      workspace: { id: 'w1', name: 'Acme', slug: 'acme' },
      role: 'owner',
      auth: { method: 'session', scope: null },
    }),
  },
  members: {
    list: async () => ({
      items: [person('u1', 'Ana Ruiz', 'owner'), person('u2', 'Tomás Berg', 'member')],
    }),
  },
  projects: { list: async () => ({ items: [] }) },
});

function renderPage() {
  const queryClient = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  const root = createRootRoute();
  const page = createRoute({
    getParentRoute: () => root,
    path: '/w/$workspace/settings/members',
    component: MembersPage,
  });
  const router = createRouter({
    routeTree: root.addChildren([page]),
    history: createMemoryHistory({ initialEntries: ['/w/acme/settings/members'] }),
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
}

async function openRemove() {
  const user = userEvent.setup();
  renderPage();
  await user.click(await screen.findByRole('button', { name: 'Actions for Tomás Berg' }));
  await user.click(await screen.findByRole('menuitem', { name: 'Remove' }));
  const dialog = await screen.findByRole('alertdialog', { name: 'Remove Tomás Berg?' });
  return { user, dialog };
}

beforeEach(() => {
  server.removed = [];
  server.refuse = false;
});

describe('Remove member', () => {
  it('removes after the confirm', async () => {
    const { user, dialog } = await openRemove();
    expect(dialog).toHaveTextContent('Tomás Berg loses access to Acme. Their tasks and activity stay.');
    await user.click(within(dialog).getByRole('button', { name: 'Remove' }));
    await waitFor(() => expect(screen.queryByRole('alertdialog')).not.toBeInTheDocument());
    expect(server.removed).toEqual(['u2']);
  });

  it('shows the refusal for the person responsible for agents and lists them', async () => {
    server.refuse = true;
    const { user, dialog } = await openRemove();
    await user.click(within(dialog).getByRole('button', { name: 'Remove' }));
    expect(await within(dialog).findByRole('alert')).toHaveTextContent(
      'Tomás Berg is responsible for claude-dev here. Hand them to someone else or remove them first.',
    );
    const agents = within(dialog).getByRole('list', { name: 'Agents in the way' });
    expect(within(agents).getByText('claude-dev')).toBeInTheDocument();
    expect(within(dialog).queryByRole('button', { name: 'Remove' })).not.toBeInTheDocument();
    // Show agents closes the dialog on the Agents tab.
    await user.click(within(dialog).getByRole('button', { name: 'Show agents' }));
    await waitFor(() => expect(screen.queryByRole('alertdialog')).not.toBeInTheDocument());
    expect(screen.getByRole('tab', { name: /Agents/ })).toHaveAttribute('aria-selected', 'true');
  });
});
