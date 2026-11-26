// URLs of a workspace: every page lives under /w/<slug>/. Pure string helpers, shared by the routes
// (redirects from old slugs and old paths) and the screens (hrefs, reading the current page from the URL).

const WORKSPACE_PREFIX = /^\/w\/([^/?#]+)/;

declare const slugBrand: unique symbol;

/**
 * A workspace slug on its way into a URL. Href helpers take the slug first and a project or task key
 * next, both strings, so the slug is branded: passing a project key where the slug goes fails to
 * typecheck. useWorkspaceSlug() and the workspace context hand out branded slugs; asWorkspaceSlug
 * brands one read from somewhere else (route params, the server).
 */
export type WorkspaceUrlSlug = string & { readonly [slugBrand]: true };

/** Brands a slug that comes from route params, the server or a test. */
export function asWorkspaceSlug(slug: string): WorkspaceUrlSlug {
  return slug as WorkspaceUrlSlug;
}

/** `/w/<slug>` + `path` (`/`, `/p/PAY`, `/settings/members?x=1`). The workspace's Home is `/w/<slug>`. */
export function workspacePath(slug: WorkspaceUrlSlug, path = '/'): string {
  const base = `/w/${encodeURIComponent(slug)}`;
  return path === '/' || path === '' ? base : `${base}${path.startsWith('/') ? path : `/${path}`}`;
}

/** The slug in /w/<slug>/…, or undefined outside a workspace. */
export function workspaceSlugFromPath(pathname: string): WorkspaceUrlSlug | undefined {
  const match = WORKSPACE_PREFIX.exec(pathname);
  if (!match?.[1]) return undefined;
  try {
    return asWorkspaceSlug(decodeURIComponent(match[1]));
  } catch {
    return undefined;
  }
}

/** The path inside the workspace: /w/acme/p/PAY → /p/PAY, /w/acme → /. Other paths come back as they are. */
export function pathInWorkspace(pathname: string): string {
  const match = WORKSPACE_PREFIX.exec(pathname);
  if (!match) return pathname;
  const rest = pathname.slice(match[0].length);
  return rest === '' ? '/' : rest;
}

/** `href` (path, search and hash) with its workspace slug replaced: an old slug's URL under the new one. */
export function withWorkspaceSlug(href: string, slug: string): string {
  return href.replace(WORKSPACE_PREFIX, `/w/${encodeURIComponent(slug)}`);
}
