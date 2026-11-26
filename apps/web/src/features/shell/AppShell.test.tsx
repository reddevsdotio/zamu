import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import {
  createMemoryHistory,
  createRootRoute,
  createRoute,
  createRouter,
  Outlet,
  RouterProvider,
} from '@tanstack/react-router';
import { act, configure, fireEvent, render, screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { resetPaletteForTests } from '~/features/palette/registry';
import { viewStorageKey } from '~/features/tasks/list-memory';
import { testWorkspace } from '~/lib/testing';
import { WorkspaceProvider } from '~/lib/workspace';
import { asWorkspaceSlug } from '~/lib/workspace-paths';
import { UIProvider } from '~/ui';
import { AppShell } from './AppShell';

// The signed-in shell against a small fake API: the sidebar (projects, pages, count, collapse), its
// menus, the palette's built-ins and the G keys.

configure({ asyncUtilTimeout: 3000 });
vi.setConfig({ testTimeout: 20_000 });

const api = vi.hoisted(() => ({
  theme: 'system' as 'system' | 'light' | 'dark',
  themeUpdates: [] as string[],
  homeTotal: 8,
}));

vi.mock('~/lib/auth-client', () => ({ useSignOut: () => async () => {} }));

// The person's workspaces (the switcher and the palette) and the New workspace dialog's calls.
const workspaces = vi.hoisted(() => ({
  canCreate: true,
  created: [] as { name: string; slug?: string }[],
}));
vi.mock('~/features/workspaces/server', () => ({
  listMyWorkspacesFn: async () => ({
    ok: true,
    data: {
      items: [
        { id: 'w2', name: 'Globex', slug: 'globex', role: 'member' },
        { id: 'w1', name: 'Northwind Labs', slug: 'acme', role: 'admin' },
      ],
      canCreate: workspaces.canCreate,
    },
  }),
  suggestWorkspaceSlugFn: async ({ data }: { data: { name: string } }) => ({
    ok: true,
    data: data.name.toLowerCase().replace(/[^a-z0-9]+/g, '-'),
  }),
  createWorkspaceFn: async ({ data }: { data: { name: string; slug?: string } }) => {
    workspaces.created.push(data);
    if (data.slug === 'globex') {
      const message = 'The address globex is taken. Pick another.';
      return { ok: false, error: { code: 'SLUG_TAKEN', message, issues: [{ path: 'slug', message }] } };
    }
    return { ok: true, data: { id: 'w3', name: data.name, slug: data.slug ?? 'new', role: 'owner' } };
  },
}));

/** The test workspace (/w/acme) around the fake client. */
const workspace = (() => {
  const project = (key: string, name: string, extra: Record<string, unknown> = {}) => ({
    id: `id-${key}`,
    key,
    name,
    description: null,
    usesMilestones: true,
    usesCycles: true,
    currentCycle: null,
    repository: null,
    backlog: null,
    locked: [],
    createdAt: '2026-10-01T09:00:00.000Z',
    updatedAt: '2026-10-20T10:30:00.000Z',
    openCounts: { backlog: 0, todo: 1, in_progress: 0, in_review: 0 },
    openCount: 1,
    lastActivityAt: '2026-10-22T18:00:00.000Z',
    assignees: [],
    ...extra,
  });
  const me = () => ({
    user: {
      id: 'u1',
      name: 'Ana Ruiz',
      email: 'ana@northwind.dev',
      kind: 'person',
      responsible: null,
      theme: api.theme,
    },
    workspace: { id: 'w1', name: 'Northwind Labs', slug: 'northwind' },
    role: 'admin',
  });
  const client = {
    me: {
      get: async () => me(),
      update: async ({ theme }: { theme: 'system' | 'light' | 'dark' }) => {
        api.themeUpdates.push(theme);
        api.theme = theme;
        return me();
      },
    },
    projects: {
      list: async () => ({
        items: [
          project('PAY', 'Payments', { openCount: 40 }),
          project('HBR', 'Harbor', { openCount: 123, usesMilestones: false }),
        ],
      }),
    },
    home: {
      counts: async () => ({
        review: api.homeTotal,
        mentions: 0,
        blocked: 0,
        overdue: 0,
        total: api.homeTotal,
      }),
    },
    tasks: { list: async () => ({ items: [], nextCursor: null }), get: async () => null },
    members: { list: async () => ({ items: [] }) },
    milestones: { list: async () => ({ items: [] }) },
    cycles: { list: async () => ({ items: [] }) },
    dashboard: { counts: async () => ({}), get: async () => ({}) },
  };
  // Procedures the fake leaves out (quick create's, New project's) exist and answer an empty list.
  const forward = (node: unknown): unknown =>
    new Proxy(typeof node === 'function' ? node : () => ({ items: [] }), {
      get: (target, key) =>
        typeof key === 'string'
          ? forward((node as Record<string, unknown> | undefined)?.[key])
          : Reflect.get(target, key),
      apply: (target, _this, args) => (target as (...a: unknown[]) => unknown)(...args),
    });
  return testWorkspace(forward(client), { id: 'w1', name: 'Northwind Labs', slug: asWorkspaceSlug('acme') });
})();

function renderShell(url: string) {
  const queryClient = new QueryClient({
    defaultOptions: { queries: { retry: false, refetchOnWindowFocus: false, refetchInterval: false } },
  });
  const root = createRootRoute({
    component: () => (
      <UIProvider>
        <AppShell user={{ id: 'u1', name: 'Ana Ruiz' }}>
          <Outlet />
        </AppShell>
      </UIProvider>
    ),
  });
  const page = (path: string, text: string) =>
    createRoute({ getParentRoute: () => root, path, component: () => <p>{text}</p> });
  const routes = [
    page('/w/$workspace', 'home page'),
    page('/w/$workspace/p/$projectKey', 'list page'),
    page('/w/$workspace/p/$projectKey/milestones', 'milestones page'),
    page('/w/$workspace/p/$projectKey/cycles', 'cycles page'),
    page('/w/$workspace/p/$projectKey/settings', 'settings page'),
    page('/w/$workspace/settings/members', 'members page'),
    page('/w/$workspace/settings/my-keys', 'my keys page'),
    page('/w/$workspace/settings/general', 'general page'),
  ];
  const router = createRouter({
    routeTree: root.addChildren(routes),
    history: createMemoryHistory({ initialEntries: [url] }),
  });
  render(
    <QueryClientProvider client={queryClient}>
      <WorkspaceProvider workspace={workspace}>
        <RouterProvider router={router} />
      </WorkspaceProvider>
    </QueryClientProvider>,
  );
  return { router };
}

const sidebar = () => screen.getByRole('navigation', { name: 'Main' });

beforeEach(() => {
  resetPaletteForTests();
  window.localStorage.clear();
  api.theme = 'system';
  api.themeUpdates = [];
  api.homeTotal = 8;
  workspaces.canCreate = true;
  workspaces.created = [];
});

describe('sidebar', () => {
  it('lists Home with its count and the projects by name; the current project shows its pages', async () => {
    const { router } = renderShell('/w/acme/p/PAY');
    await screen.findByText('list page');
    const nav = sidebar();
    expect(await within(nav).findByRole('link', { name: 'Home, 8 items need you' })).toHaveAttribute(
      'href',
      '/w/acme',
    );
    const projects = within(nav).getByRole('list', { name: 'Projects' });
    const rows = within(projects).getAllByRole('link', { name: /open$/ });
    expect(rows.map((row) => row.getAttribute('aria-label'))).toEqual([
      'Harbor, 123 open',
      'Payments, 40 open',
    ]);
    // Payments is current: List (current), Board, Milestones, Cycles, Settings.
    const pages = within(nav).getByRole('list', { name: 'Payments pages' });
    expect(
      within(pages)
        .getAllByRole('link')
        .map((link) => link.textContent),
    ).toEqual(['List', 'Board', 'Milestones', 'Cycles', 'Settings']);
    expect(within(pages).getByRole('link', { name: 'List' })).toHaveAttribute('aria-current', 'page');
    expect(within(nav).queryByRole('list', { name: 'Harbor pages' })).not.toBeInTheDocument();

    // Opening another project expands it instead; Harbor has no milestones.
    await userEvent.setup().click(within(nav).getByRole('link', { name: 'Harbor, 123 open' }));
    await waitFor(() => expect(router.state.location.pathname).toBe('/w/acme/p/HBR'));
    const harbor = await within(nav).findByRole('list', { name: 'Harbor pages' });
    expect(
      within(harbor)
        .getAllByRole('link')
        .map((link) => link.textContent),
    ).toEqual(['List', 'Board', 'Cycles', 'Settings']);
    expect(within(nav).queryByRole('list', { name: 'Payments pages' })).not.toBeInTheDocument();
  });

  it('highlights Board on ?view=board and the page links pin the List / Board choice', async () => {
    const user = userEvent.setup();
    const { router } = renderShell('/w/acme/p/PAY?view=board');
    await screen.findByText('list page');
    const pages = await within(sidebar()).findByRole('list', { name: 'Payments pages' });
    expect(within(pages).getByRole('link', { name: 'Board' })).toHaveAttribute('aria-current', 'page');
    await user.click(within(pages).getByRole('link', { name: 'List' }));
    await waitFor(() => expect(router.state.location.search).toEqual({}));
    expect(window.localStorage.getItem(viewStorageKey(workspace.id, 'PAY'))).toBe('list');
  });

  it('collapses to icons with [ and keeps names in tooltips', async () => {
    renderShell('/w/acme/p/PAY');
    await screen.findByText('list page');
    expect(within(sidebar()).getByText('Projects')).toBeInTheDocument();
    act(() => {
      fireEvent.keyDown(document.body, { key: '[', code: 'BracketLeft' });
    });
    const nav = sidebar();
    expect(nav).toHaveAttribute('data-collapsed', 'true');
    expect(within(nav).queryByText('Projects')).not.toBeInTheDocument();
    expect(within(nav).queryByRole('list', { name: 'Payments pages' })).not.toBeInTheDocument();
    // Still reachable by name.
    expect(within(nav).getByRole('link', { name: 'Payments, 40 open' })).toBeInTheDocument();
    expect(within(nav).getByRole('button', { name: 'Search or jump to' })).toBeInTheDocument();
    expect(window.localStorage.getItem('zamu.sidebar.collapsed:u1')).toBe('1');
  });

  it('the workspace menu and the Projects "+" open New project', async () => {
    const user = userEvent.setup();
    renderShell('/w/acme');
    await screen.findByText('home page');
    await user.click(
      await within(sidebar()).findByRole('button', { name: 'Northwind Labs: workspace menu' }),
    );
    const menu = await screen.findByRole('menu', { name: 'Northwind Labs: workspace menu' });
    expect(
      within(menu)
        .getAllByRole('menuitem')
        .map((item) => item.textContent),
    ).toEqual([
      'GGlobex',
      'NNorthwind Labs, current',
      'New workspace',
      'Workspace settings',
      'Invite people',
      'New project',
      'New from Backlog.md',
    ]);
    await user.click(within(menu).getByRole('menuitem', { name: 'New project' }));
    expect(await screen.findByRole('dialog', { name: 'New project' })).toBeInTheDocument();
    await user.keyboard('{Escape}');
    await waitFor(() => expect(screen.queryByRole('dialog')).not.toBeInTheDocument());

    await user.click(within(sidebar()).getByRole('button', { name: 'New project' }));
    const plus = await screen.findByRole('menu', { name: 'New project' });
    await user.click(within(plus).getByRole('menuitem', { name: 'New project' }));
    expect(await screen.findByRole('dialog', { name: 'New project' })).toBeInTheDocument();
  });

  it('the switcher lists every workspace, checks the current one and opens another', async () => {
    const user = userEvent.setup();
    const { router } = renderShell('/w/acme');
    await screen.findByText('home page');
    await user.click(
      await within(sidebar()).findByRole('button', { name: 'Northwind Labs: workspace menu' }),
    );
    const menu = await screen.findByRole('menu', { name: 'Northwind Labs: workspace menu' });
    const list = within(menu).getByRole('group', { name: 'Workspaces' });
    expect(
      within(list)
        .getAllByRole('menuitem')
        .map((item) => item.textContent),
    ).toEqual(['GGlobex', 'NNorthwind Labs, current', 'New workspace']);
    expect(within(list).getByRole('menuitem', { name: 'Globex' })).toHaveAttribute('href', '/w/globex');
    expect(within(menu).getByRole('menuitem', { name: 'Workspace settings' })).toHaveAttribute(
      'href',
      '/w/acme/settings/general',
    );
    await user.click(within(list).getByRole('menuitem', { name: 'Globex' }));
    await waitFor(() => expect(router.state.location.pathname).toBe('/w/globex'));
  });

  it('hides New workspace when the creation policy does not allow it', async () => {
    workspaces.canCreate = false;
    const user = userEvent.setup();
    renderShell('/w/acme');
    await screen.findByText('home page');
    await user.click(
      await within(sidebar()).findByRole('button', { name: 'Northwind Labs: workspace menu' }),
    );
    const menu = await screen.findByRole('menu', { name: 'Northwind Labs: workspace menu' });
    // The list has loaded (Globex shows) and still offers no New workspace.
    await within(menu).findByRole('menuitem', { name: 'Globex' });
    expect(within(menu).queryByRole('menuitem', { name: 'New workspace' })).not.toBeInTheDocument();
  });

  it('New workspace creates one from the switcher and opens its Home', async () => {
    const user = userEvent.setup();
    const { router } = renderShell('/w/acme');
    await screen.findByText('home page');
    await user.click(
      await within(sidebar()).findByRole('button', { name: 'Northwind Labs: workspace menu' }),
    );
    const menu = await screen.findByRole('menu', { name: 'Northwind Labs: workspace menu' });
    await user.click(await within(menu).findByRole('menuitem', { name: 'New workspace' }));
    const dialog = await screen.findByRole('dialog', { name: 'New workspace' });
    await user.type(within(dialog).getByRole('textbox', { name: 'Name' }), 'Initech Labs');
    expect(within(dialog).getByRole('textbox', { name: 'Address' })).toHaveValue('initech-labs');
    await user.click(within(dialog).getByRole('button', { name: /Create workspace/ }));
    await waitFor(() => expect(router.state.location.pathname).toBe('/w/initech-labs'));
    expect(workspaces.created).toEqual([{ name: 'Initech Labs', slug: 'initech-labs' }]);
    await waitFor(() => expect(screen.queryByRole('dialog')).not.toBeInTheDocument());
  });

  it('the person menu switches the theme (System / Light / Dark) and opens the shortcut list', async () => {
    const user = userEvent.setup();
    renderShell('/w/acme');
    await screen.findByText('home page');
    await user.click(await within(sidebar()).findByRole('button', { name: 'Ana Ruiz: account menu' }));
    const account = await screen.findByRole('dialog', { name: 'Account' });
    expect(account).toHaveTextContent('ana@northwind.dev');
    const theme = within(account).getByRole('radiogroup', { name: 'Theme' });
    expect(
      within(theme)
        .getAllByRole('radio')
        .map((radio) => radio.textContent),
    ).toEqual(['System', 'Light', 'Dark']);
    await user.click(within(theme).getByRole('radio', { name: 'Dark' }));
    await waitFor(() => expect(api.themeUpdates).toEqual(['dark']));
    expect(within(account).getByRole('menuitem', { name: 'My API keys' })).toHaveAttribute(
      'href',
      '/w/acme/settings/my-keys',
    );
    await user.click(within(account).getByRole('menuitem', { name: /Keyboard shortcuts/ }));
    expect(await screen.findByRole('dialog', { name: 'Keyboard shortcuts' })).toBeInTheDocument();
  });
});

describe('palette built-ins and G keys', () => {
  it('Search or jump to opens the palette; Go to commands navigate', async () => {
    const user = userEvent.setup();
    const { router } = renderShell('/w/acme');
    await screen.findByText('home page');
    await user.click(await within(sidebar()).findByRole('button', { name: 'Search or jump to' }));
    const palette = await screen.findByRole('dialog', { name: 'Command palette' });
    const suggested = within(palette).getByRole('group', { name: 'Suggested' });
    expect(
      within(suggested)
        .getAllByRole('option')
        .map((option) => option.getAttribute('aria-label')),
    ).toEqual(['Create task', 'Go to Home', 'Go to Harbor', 'Switch to dark theme', 'Create project']);
    await user.type(within(palette).getByRole('combobox'), 'payments milestones');
    await user.keyboard('{Enter}');
    await waitFor(() => expect(router.state.location.pathname).toBe('/w/acme/p/PAY/milestones'));
  });

  it('lists Switch to <workspace> for the other workspaces and New workspace', async () => {
    const user = userEvent.setup();
    const { router } = renderShell('/w/acme');
    await screen.findByText('home page');
    await user.keyboard('{Control>}k{/Control}');
    const palette = await screen.findByRole('dialog', { name: 'Command palette' });
    await user.type(within(palette).getByRole('combobox'), 'workspace');
    await waitFor(() =>
      expect(within(palette).getByRole('option', { name: 'Switch to Globex' })).toBeInTheDocument(),
    );
    expect(within(palette).getByRole('option', { name: 'New workspace' })).toBeInTheDocument();
    expect(
      within(palette).queryByRole('option', { name: 'Switch to Northwind Labs' }),
    ).not.toBeInTheDocument();
    await user.clear(within(palette).getByRole('combobox'));
    await user.type(within(palette).getByRole('combobox'), 'switch to globex');
    await user.keyboard('{Enter}');
    await waitFor(() => expect(router.state.location.pathname).toBe('/w/globex'));
  });

  it('switches the theme through a step and toggles the sidebar', async () => {
    const user = userEvent.setup();
    renderShell('/w/acme');
    await screen.findByText('home page');
    await user.keyboard('{Control>}k{/Control}');
    const palette = await screen.findByRole('dialog', { name: 'Command palette' });
    await user.type(within(palette).getByRole('combobox'), 'switch theme');
    await user.keyboard('{Enter}');
    expect(
      within(palette)
        .getAllByRole('option')
        .map((option) => option.getAttribute('aria-label')),
    ).toEqual(['System', 'Light', 'Dark']);
    await user.keyboard('{ArrowDown}{Enter}');
    await waitFor(() => expect(api.themeUpdates).toEqual(['light']));

    await user.keyboard('{Control>}k{/Control}');
    await user.type(await screen.findByRole('combobox'), 'collapse sidebar');
    await user.keyboard('{Enter}');
    await waitFor(() => expect(sidebar()).toHaveAttribute('data-collapsed', 'true'));
  });

  it('G then P opens the palette on projects; G then H goes Home; G then Y opens the cycles', async () => {
    const user = userEvent.setup();
    const { router } = renderShell('/w/acme/p/PAY');
    await screen.findByText('list page');
    await user.keyboard('gp');
    const palette = await screen.findByRole('dialog', { name: 'Command palette' });
    expect(within(palette).getByRole('combobox')).toHaveAttribute('placeholder', 'Jump to a project…');
    await user.keyboard('harb{Enter}');
    await waitFor(() => expect(router.state.location.pathname).toBe('/w/acme/p/HBR'));
    await waitFor(() => expect(screen.queryByRole('dialog')).not.toBeInTheDocument());
    await user.keyboard('gy');
    await waitFor(() => expect(router.state.location.pathname).toBe('/w/acme/p/HBR/cycles'));
    await user.keyboard('gh');
    await waitFor(() => expect(router.state.location.pathname).toBe('/w/acme'));
    // Away from a project, G then L uses the last one.
    await user.keyboard('gl');
    await waitFor(() => expect(router.state.location.pathname).toBe('/w/acme/p/HBR'));
  });
});
