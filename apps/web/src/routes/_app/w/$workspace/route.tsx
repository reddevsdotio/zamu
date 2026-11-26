import { createFileRoute, Outlet, redirect } from '@tanstack/react-router';
import { useEffect, useMemo } from 'react';
import { meQuery, projectsQuery } from '~/features/projects/queries';
import { AppShell } from '~/features/shell/AppShell';
import { openWorkspace, rememberOpenedWorkspace } from '~/lib/open-workspace';
import { workspaceApi } from '~/lib/orpc';
import { WorkspaceProvider } from '~/lib/workspace';
import { asWorkspaceSlug, withWorkspaceSlug } from '~/lib/workspace-paths';

// One workspace: /w/<slug>/… with the sidebar, the palette and the global shortcuts around its pages.
// The slug decides everything below: its /api/v1 client sends it as x-zamu-workspace, its query keys
// start with ['w', slug], and server functions get it as data. An old slug redirects to the current one
// with the rest of the URL kept; a workspace the person is not in sends them to `/`, which lands in one
// of theirs. Entering a workspace (not a preload) remembers it as the one used last.

export const Route = createFileRoute('/_app/w/$workspace')({
  // Not serialized for hydration (unlike beforeLoad's context): each side builds its own client.
  context: ({ params }) => ({ api: workspaceApi(params.workspace) }),
  beforeLoad: async ({ params, location, cause, preload }) => {
    const opened = await openWorkspace({ slug: params.workspace, href: location.href, cause, preload });
    // An old slug, or the slug in another case: the same page under the current one.
    if (opened.workspace.slug !== params.workspace) {
      throw redirect({
        href: withWorkspaceSlug(location.href, opened.workspace.slug),
        replace: true,
        statusCode: 307,
      });
    }
    return { workspace: { ...opened.workspace, role: opened.role } };
  },
  // Prefetch what the sidebar shows so the first render (and SSR) has it; failures surface in the pages.
  loader: async ({ context }) => {
    await Promise.all([
      context.queryClient.prefetchQuery(meQuery(context.api)),
      context.queryClient.prefetchQuery(projectsQuery(context.api)),
    ]);
  },
  component: WorkspaceLayout,
});

function WorkspaceLayout() {
  const { session, workspace, api } = Route.useRouteContext();
  const { id, name, slug, role } = workspace;
  const current = useMemo(() => ({ id, name, slug: asWorkspaceSlug(slug), api }), [id, name, slug, api]);
  // After a server render the tab is in this workspace already: the next navigation inside it needs
  // no new lookup.
  useEffect(() => {
    rememberOpenedWorkspace({ workspace: { id, name, slug }, current: true, role });
  }, [id, name, slug, role]);
  return (
    <WorkspaceProvider workspace={current}>
      {/* A new workspace starts from a clean shell: no peek, selection or dialog carries over. */}
      <AppShell key={id} user={{ id: session.user.id, name: session.user.name }}>
        <Outlet />
      </AppShell>
    </WorkspaceProvider>
  );
}
