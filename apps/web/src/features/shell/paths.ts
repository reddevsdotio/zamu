import { pathInWorkspace, type WorkspaceUrlSlug, workspacePath } from '~/lib/workspace-paths';

// URLs the shell links to, all under /w/<workspace>/. Task screens own /p/$projectKey; settings own
// /settings/*. The readers below take full URLs (/w/acme/p/PAY) and workspace-relative ones (/p/PAY).

/** Home: what needs you across every project of the workspace. */
export function homeHref(workspace: WorkspaceUrlSlug): string {
  return workspacePath(workspace);
}

export function membersHref(workspace: WorkspaceUrlSlug): string {
  return workspacePath(workspace, '/settings/members');
}

export function myKeysHref(workspace: WorkspaceUrlSlug): string {
  return workspacePath(workspace, '/settings/my-keys');
}

export function appearanceHref(workspace: WorkspaceUrlSlug): string {
  return workspacePath(workspace, '/settings/appearance');
}

export function connectionsHref(workspace: WorkspaceUrlSlug): string {
  return workspacePath(workspace, '/settings/connections');
}

/** A project's pages, as linked from the sidebar and the palette. */
export type ProjectPage = 'list' | 'board' | 'milestones' | 'cycles' | 'settings';

/** Task list of a project. */
export function projectHref(workspace: WorkspaceUrlSlug, projectKey: string): string {
  return workspacePath(workspace, `/p/${encodeURIComponent(projectKey)}`);
}

/** /p/PAY, /p/PAY?view=board, /p/PAY/milestones, /p/PAY/cycles, /p/PAY/settings, under the workspace. */
export function projectPageHref(workspace: WorkspaceUrlSlug, projectKey: string, page: ProjectPage): string {
  const base = projectHref(workspace, projectKey);
  if (page === 'list') return base;
  if (page === 'board') return `${base}?view=board`;
  return `${base}/${page}`;
}

/** The task view of a task. */
export function taskHref(workspace: WorkspaceUrlSlug, taskKey: string): string {
  const projectKey = taskKey.replace(/-[^-]*$/, '');
  return `${projectHref(workspace, projectKey)}/${encodeURIComponent(taskKey)}`;
}

/** Whether the URL is the workspace's Home (/w/acme, or / inside it). */
export function isHomePath(pathname: string): boolean {
  const inner = pathInWorkspace(pathname);
  return inner === '/' || inner === '';
}

/** Whether the URL is one of the workspace's settings pages. */
export function isSettingsPath(pathname: string): boolean {
  return pathInWorkspace(pathname).startsWith('/settings');
}

/** The project key in /p/PAY or /p/PAY/PAY-142, upper-cased; undefined elsewhere. */
export function projectKeyFromPath(pathname: string): string | undefined {
  const match = /^\/p\/([^/]+)/.exec(pathInWorkspace(pathname));
  if (!match?.[1]) return undefined;
  try {
    return decodeURIComponent(match[1]).toUpperCase();
  } catch {
    return undefined;
  }
}

const PROJECT_SUBPAGES = new Set(['milestones', 'cycles', 'settings', 'backlog-setup']);

/** The task key in /p/PAY/PAY-142 (the task view), upper-cased; undefined elsewhere. */
export function taskKeyFromPath(pathname: string): string | undefined {
  const match = /^\/p\/[^/]+\/([^/]+)\/?$/.exec(pathInWorkspace(pathname));
  if (!match?.[1] || PROJECT_SUBPAGES.has(match[1])) return undefined;
  try {
    return decodeURIComponent(match[1]).toUpperCase();
  } catch {
    return undefined;
  }
}

/**
 * Which of a project's pages the URL shows, for the sidebar highlight: the list or board (by ?view), or a
 * sub-page. undefined for the task view and pages outside the project.
 */
export function projectPageFromLocation(
  pathname: string,
  search: { view?: unknown },
): ProjectPage | undefined {
  const match = /^\/p\/[^/]+(?:\/([^/]+))?/.exec(pathInWorkspace(pathname));
  if (!match) return undefined;
  const sub = match[1];
  if (!sub) return search.view === 'board' ? 'board' : 'list';
  if (sub === 'milestones' || sub === 'cycles' || sub === 'settings') return sub;
  return undefined;
}

/** The project key and view of a list or board href (/w/acme/p/PAY?view=board), for remembering the view. */
export function projectViewOfHref(href: string): { projectKey: string; view: 'list' | 'board' } | undefined {
  const match = /^\/p\/([^/?]+)(\?view=board)?$/.exec(pathInWorkspace(href));
  if (!match?.[1]) return undefined;
  try {
    return { projectKey: decodeURIComponent(match[1]), view: match[2] ? 'board' : 'list' };
  } catch {
    return undefined;
  }
}
