// Where the workspace screens live inside a workspace. Kept apart from the settings layout so the shell
// can link here without loading the settings screens and their server functions.
import { type WorkspaceUrlSlug, workspacePath } from '~/lib/workspace-paths';

/** Settings › General: name, address, Leave and Delete. The settings index opens it. */
export const GENERAL_SETTINGS_PATH = '/settings/general';

export function generalSettingsHref(workspace: WorkspaceUrlSlug): string {
  return workspacePath(workspace, GENERAL_SETTINGS_PATH);
}
