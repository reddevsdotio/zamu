import { useQuery } from '@tanstack/react-query';
import { useCallback, useSyncExternalStore } from 'react';
import { meQuery } from '~/features/tasks/queries';
import type { GroupBy } from '~/features/views';
import { storageKeyPrefix, workspaceStorageKey } from '~/lib/storage-keys';
import { useApi, useWorkspaceId } from '~/lib/workspace';

// Collapsed columns of a board, remembered per workspace, person, project and column field in localStorage:
//   zamu:board-columns:v2:<workspace id>:<user id>:<project key>:<group by>  = { "done": true, "todo": false }
// Columns saved before 0.10 (zamu:board-columns:v1:…, without the workspace) are not read.
// Only the person's changes are stored; a column without an entry takes the default (Done and Canceled
// start collapsed on a status board).

const PREFIX = storageKeyPrefix('board-columns');

/** The localStorage key of one person's columns on one board; `userId` null until me.get answers. */
export function foldedColumnsKey(
  workspaceId: string,
  userId: string | null,
  projectKey: string,
  groupBy: GroupBy,
): string {
  return workspaceStorageKey('board-columns', workspaceId, userId ?? '~', projectKey, groupBy);
}

export type FoldOverrides = Readonly<Record<string, boolean>>;

const EMPTY: FoldOverrides = {};
const memory = new Map<string, FoldOverrides>();
const cache = new Map<string, { raw: string | null; value: FoldOverrides }>();
const listeners = new Set<() => void>();

function storage(): Storage | null {
  try {
    return typeof window === 'undefined' ? null : window.localStorage;
  } catch {
    return null;
  }
}

function subscribe(listener: () => void) {
  listeners.add(listener);
  const onStorage = (event: StorageEvent) => {
    if (event.key === null || event.key.startsWith(PREFIX)) listener();
  };
  if (typeof window !== 'undefined') window.addEventListener('storage', onStorage);
  return () => {
    listeners.delete(listener);
    if (typeof window !== 'undefined') window.removeEventListener('storage', onStorage);
  };
}

function parse(raw: string | null): FoldOverrides {
  if (!raw) return EMPTY;
  try {
    const value = JSON.parse(raw) as unknown;
    if (!value || typeof value !== 'object' || Array.isArray(value)) return EMPTY;
    return Object.fromEntries(
      Object.entries(value as Record<string, unknown>).filter(
        (entry): entry is [string, boolean] => typeof entry[1] === 'boolean',
      ),
    );
  } catch {
    return EMPTY;
  }
}

function read(key: string): FoldOverrides {
  const kept = memory.get(key);
  if (kept) return kept;
  let raw: string | null = null;
  try {
    raw = storage()?.getItem(key) ?? null;
  } catch {
    raw = null;
  }
  const cached = cache.get(key);
  if (cached && cached.raw === raw) return cached.value;
  const value = parse(raw);
  cache.set(key, { raw, value });
  return value;
}

function write(key: string, value: FoldOverrides, persist: boolean) {
  if (persist) {
    try {
      if (Object.keys(value).length) storage()?.setItem(key, JSON.stringify(value));
      else storage()?.removeItem(key);
      memory.delete(key);
    } catch {
      memory.set(key, value);
    }
  } else {
    memory.set(key, value);
  }
  for (const listener of listeners) listener();
}

/**
 * The person's collapsed and expanded columns on this board: [overrides, setFolded]. Until the
 * signed-in person is known, changes stay in memory.
 */
export function useFoldedColumns(projectKey: string, groupBy: GroupBy) {
  const api = useApi();
  const workspaceId = useWorkspaceId();
  const userId = useQuery(meQuery(api)).data?.user.id ?? null;
  const key = foldedColumnsKey(workspaceId, userId, projectKey, groupBy);
  const overrides = useSyncExternalStore(
    subscribe,
    () => read(key),
    () => EMPTY,
  );
  const setFolded = useCallback(
    (column: string, folded: boolean) => {
      const previous = read(key);
      if (previous[column] === folded) return;
      write(key, { ...previous, [column]: folded }, userId !== null);
    },
    [key, userId],
  );
  return [overrides, setFolded] as const;
}

/** Test helper. */
export function resetFoldedColumnsForTests() {
  memory.clear();
  cache.clear();
}
