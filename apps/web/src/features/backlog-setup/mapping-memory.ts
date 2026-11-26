import { BacklogMappings } from '@zamu/contracts';
import { workspaceStorageKey } from '~/lib/storage-keys';

// Mappings picked during setup, kept in session storage per workspace and project so a reload on
// Mappings or Preview keeps them. Cleared once the source is created.

/** zamu:backlog-mappings:v2:<workspace id>:<project key> */
export const mappingsStorageKey = (workspaceId: string, projectKey: string) =>
  workspaceStorageKey('backlog-mappings', workspaceId, projectKey);

function storage(): Storage | null {
  try {
    return typeof window === 'undefined' ? null : window.sessionStorage;
  } catch {
    return null;
  }
}

export function loadSavedMappings(workspaceId: string, projectKey: string): BacklogMappings | null {
  try {
    const raw = storage()?.getItem(mappingsStorageKey(workspaceId, projectKey));
    if (!raw) return null;
    const parsed = BacklogMappings.safeParse(JSON.parse(raw));
    return parsed.success ? parsed.data : null;
  } catch {
    return null;
  }
}

export function saveMappings(workspaceId: string, projectKey: string, mappings: BacklogMappings): void {
  try {
    storage()?.setItem(mappingsStorageKey(workspaceId, projectKey), JSON.stringify(mappings));
  } catch {
    // Full or blocked storage: the picks only last until the next reload.
  }
}

export function forgetMappings(workspaceId: string, projectKey: string): void {
  try {
    storage()?.removeItem(mappingsStorageKey(workspaceId, projectKey));
  } catch {
    // Nothing to clean up.
  }
}
