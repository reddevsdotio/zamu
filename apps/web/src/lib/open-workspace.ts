// Which workspace a /w/<slug>/ URL opens, for the workspace layout's beforeLoad. The browser keeps the
// answers for the tab, so navigations inside a workspace ask the server nothing; entering a workspace
// (from another one, or from outside) asks again and remembers it as the one used last.
//
// This lives outside the route file on purpose: the router splits a route's component into its own
// chunk, and module state in the route file would then exist twice.
import { redirect } from '@tanstack/react-router';
import {
  type OpenedWorkspace,
  resolveWorkspaceFn,
  touchLastWorkspaceFn,
} from '../features/workspaces/server';

const resolved = new Map<string, OpenedWorkspace>();
let browserWorkspace: string | undefined;

const isBrowser = () => typeof window !== 'undefined';

export interface OpenWorkspaceInput {
  /** The slug in the URL. */
  slug: string;
  /** The URL, for the sign-in redirect. */
  href: string;
  /** The router's cause: 'stay' within the same route, which a move to another workspace also is. */
  cause: 'enter' | 'stay' | 'preload';
  preload: boolean;
}

/**
 * The workspace `slug` names, for a member. Redirects to /signin when signed out and to `/` when the
 * person is not in it (unknown slugs included). Remembers it as the one used last when entered.
 */
export async function openWorkspace({
  slug,
  href,
  cause,
  preload,
}: OpenWorkspaceInput): Promise<OpenedWorkspace> {
  const staying = isBrowser() && cause === 'stay' && browserWorkspace === slug;
  let opened = staying ? resolved.get(slug) : undefined;
  if (!opened) {
    const result = await resolveWorkspaceFn({ data: { workspace: slug } });
    if (!result.ok) {
      if (result.error.code === 'UNAUTHORIZED') throw redirect({ to: '/signin', search: { redirect: href } });
      throw redirect({ to: '/' });
    }
    opened = result.data;
    if (isBrowser()) resolved.set(slug, opened);
  }
  // Old and differently cased slugs redirect before anything is remembered.
  if (!preload && !staying && opened.workspace.slug === slug) {
    await touchLastWorkspaceFn({ data: { workspace: slug } });
    if (isBrowser()) browserWorkspace = slug;
  }
  return opened;
}

/** After a server render: the tab is in `opened` already, so the next navigation inside it asks nothing. */
export function rememberOpenedWorkspace(opened: OpenedWorkspace): void {
  browserWorkspace = opened.workspace.slug;
  if (!resolved.has(opened.workspace.slug)) resolved.set(opened.workspace.slug, opened);
}
