import { type WorkspaceUrlSlug, workspacePath } from '~/lib/workspace-paths';
// URLs around the Backlog.md setup.

/** Project settings (M3-09): where Cancel goes and the source is managed. */
export function projectSettingsHref(workspace: WorkspaceUrlSlug, projectKey: string): string {
  return workspacePath(workspace, `/p/${encodeURIComponent(projectKey)}/settings`);
}

/** Settings → Backlog.md with the webhook dialog open. */
export function backlogWebhookHref(workspace: WorkspaceUrlSlug, projectKey: string): string {
  return `${projectSettingsHref(workspace, projectKey)}/backlog?webhook=1`;
}
