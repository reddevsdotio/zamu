import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import {
  createMemoryHistory,
  createRootRoute,
  createRoute,
  createRouter,
  Outlet,
  RouterProvider,
} from '@tanstack/react-router';
import { render, screen, within } from '@testing-library/react';
import { describe, expect, it } from 'vitest';
import { createFakeApi } from '~/features/tasks/fake-api';
import { testWorkspace } from '~/lib/testing';
import { WorkspaceProvider } from '~/lib/workspace';
import { UIProvider } from '~/ui';
import { ProjectSettingsLayout, projectSettingsHref } from './ProjectSettingsLayout';

// The project settings nav links each section under the workspace: /w/acme/p/PAY/settings/labels,
// never a URL built with the project key where the workspace goes.

function renderSettings(url: string) {
  const fake = createFakeApi({});
  const workspace = testWorkspace(fake.client);
  const queryClient = new QueryClient({
    defaultOptions: { queries: { retry: false, refetchOnWindowFocus: false, refetchInterval: false } },
  });
  const root = createRootRoute({ component: () => <Outlet /> });
  const settings = createRoute({
    getParentRoute: () => root,
    path: '/w/$workspace/p/$projectKey/settings/$',
    component: () => (
      <ProjectSettingsLayout projectKey="PAY">
        <p>section</p>
      </ProjectSettingsLayout>
    ),
  });
  const router = createRouter({
    routeTree: root.addChildren([settings]),
    history: createMemoryHistory({ initialEntries: [url] }),
  });
  render(
    <QueryClientProvider client={queryClient}>
      <WorkspaceProvider workspace={workspace}>
        <UIProvider>
          <RouterProvider router={router} />
        </UIProvider>
      </WorkspaceProvider>
    </QueryClientProvider>,
  );
}

describe('project settings nav', () => {
  it('links every section under the workspace and marks the current one', async () => {
    renderSettings('/w/acme/p/PAY/settings/labels');
    const nav = await screen.findByRole('navigation', { name: 'Settings sections' });
    const href = (name: string) => within(nav).getByRole('link', { name: new RegExp(`^${name}`) });
    expect(href('General')).toHaveAttribute('href', '/w/acme/p/PAY/settings');
    expect(href('Labels')).toHaveAttribute('href', '/w/acme/p/PAY/settings/labels');
    expect(href('Labels')).toHaveAttribute('aria-current', 'page');
    expect(href('Task defaults')).toHaveAttribute('href', '/w/acme/p/PAY/settings/defaults');
  });

  it('refuses a project key where the workspace slug goes', () => {
    // @ts-expect-error The slug is branded (WorkspaceUrlSlug): a plain string such as a project key fails.
    expect(projectSettingsHref('PAY', 'labels')).toBe('/w/PAY/p/labels/settings');
  });
});
