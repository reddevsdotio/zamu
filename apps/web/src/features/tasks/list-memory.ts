import { workspaceStorageKey } from '~/lib/storage-keys';
import type { TaskListSearch, TaskView } from './search';

// Remembers, per workspace and project (lib/storage-keys.ts):
// - the last filters used on its tasks (in memory), so "Back to list" from a task page returns to the
//   same view with that task focused (?focus=, which the list reads once and drops);
// - the List / Board choice (in local storage), so opening the project again shows the same view.

const lastSearch = new Map<string, TaskListSearch>();
const searchKey = (workspaceId: string, projectKey: string) => `${workspaceId}:${projectKey}`;

export function rememberListSearch(workspaceId: string, projectKey: string, search: TaskListSearch): void {
  const { task: _task, focus: _focus, ...filters } = search;
  lastSearch.set(searchKey(workspaceId, projectKey), filters);
}

/**
 * The list (or board) search to return to with `taskKey` focused. ?task= would open the task view
 * again (old links redirect there), so the row comes back through ?focus=.
 */
export function listSearchFor(workspaceId: string, projectKey: string, taskKey: string): TaskListSearch {
  return { ...lastSearch.get(searchKey(workspaceId, projectKey)), focus: taskKey };
}

/** zamu:view:v2:<workspace id>:<project key> = "list" | "board" */
export const viewStorageKey = (workspaceId: string, projectKey: string) =>
  workspaceStorageKey('view', workspaceId, projectKey);

function storage(): Storage | null {
  try {
    return typeof window === 'undefined' ? null : window.localStorage;
  } catch {
    // Storage can be blocked (privacy settings); the view then simply is not remembered.
    return null;
  }
}

/** Saves the List / Board choice of a project. */
export function rememberProjectView(workspaceId: string, projectKey: string, view: TaskView): void {
  try {
    storage()?.setItem(viewStorageKey(workspaceId, projectKey), view);
  } catch {
    // Quota or privacy errors: not remembering is fine.
  }
}

/** The saved List / Board choice of a project, or null when there is none (or on the server). */
export function rememberedView(workspaceId: string, projectKey: string): TaskView | null {
  try {
    const value = storage()?.getItem(viewStorageKey(workspaceId, projectKey));
    return value === 'board' || value === 'list' ? value : null;
  } catch {
    return null;
  }
}
