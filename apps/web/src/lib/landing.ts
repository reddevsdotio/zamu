// Where a signed-in person lands outside a workspace URL: `/` and the pre-0.10 paths (/p/…, /settings/…,
// /dashboard, /my-tasks, /projects) go to the same path under the workspace they used last, or to
// /welcome when they belong to no workspace. For `beforeLoad` of those routes.
import { redirect } from '@tanstack/react-router';
import { landingWorkspaceFn } from '../features/workspaces/server';
import { asWorkspaceSlug, workspacePath } from './workspace-paths';

/**
 * Throws the redirect to `path` (with its search and hash) under the workspace used last: 307, so a
 * bookmark keeps the old URL. Sends people without a workspace to /welcome.
 */
export async function redirectToLastWorkspace(path: string): Promise<never> {
  const landing = await landingWorkspaceFn();
  if (landing.status === 'signed-out') throw redirect({ to: '/signin', search: { redirect: path } });
  if (landing.status === 'none') throw redirect({ to: '/welcome', replace: true });
  throw redirect({
    href: workspacePath(asWorkspaceSlug(landing.slug), path),
    replace: true,
    statusCode: 307,
  });
}
