import { useQuery } from '@tanstack/react-query';
import { useCallback, useMemo, useSyncExternalStore } from 'react';
import { meQuery } from '~/features/tasks/queries';
import { storageKeyPrefix, workspaceStorageKey } from '~/lib/storage-keys';
import { useApi, useWorkspaceId } from '~/lib/workspace';
import {
  type DisplayOptions,
  defaultDisplayOptions,
  normalizeDisplayOptions,
  sameDisplayOptions,
  type TaskViewName,
} from './display-options';

// Display options in localStorage, per workspace, person, project and view (plan call 4):
//   zamu:display:v2:<workspace id>:<user id>:<project key>:<view>     (Home: project key "~home")
// Options saved before 0.10 (zamu:display:v1:…, without the workspace) are not read.
// Every component reading the same key shares one value (the Display popover and the list it
// changes), and other tabs follow through the storage event. Until the signed-in user is known
// the defaults show and changes stay in memory.

const PREFIX = storageKeyPrefix('display');
/** Stands in for the project key on Home. */
export const HOME_DISPLAY_SCOPE = '~home';

/** The localStorage key of one person's options for one view of a workspace. */
export function displayStorageKey(
  workspaceId: string,
  userId: string,
  projectKey: string | null,
  view: TaskViewName,
): string {
  return workspaceStorageKey('display', workspaceId, userId, projectKey ?? HOME_DISPLAY_SCOPE, view);
}

function storage(): Storage | null {
  try {
    return typeof window === 'undefined' ? null : window.localStorage;
  } catch {
    // Blocked storage (privacy settings): options are not remembered.
    return null;
  }
}

/** Values not yet persisted (no user id) and the parsed value of each key, so reads are stable. */
const memory = new Map<string, DisplayOptions>();
const cache = new Map<string, { raw: string | null; value: DisplayOptions }>();
const listeners = new Set<() => void>();

function notify() {
  for (const listener of listeners) listener();
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

function read(key: string | null, view: TaskViewName, memoryKey: string): DisplayOptions {
  if (key === null) return memory.get(memoryKey) ?? defaultDisplayOptions(view);
  let raw: string | null = null;
  try {
    raw = storage()?.getItem(key) ?? null;
  } catch {
    raw = null;
  }
  const cached = cache.get(key);
  if (cached && cached.raw === raw) return cached.value;
  let value = defaultDisplayOptions(view);
  if (raw !== null) {
    try {
      value = normalizeDisplayOptions(view, JSON.parse(raw));
    } catch {
      value = defaultDisplayOptions(view);
    }
  }
  cache.set(key, { raw, value });
  return value;
}

function write(key: string | null, memoryKey: string, view: TaskViewName, value: DisplayOptions | null) {
  if (key === null) {
    if (value) memory.set(memoryKey, value);
    else memory.delete(memoryKey);
  } else {
    try {
      // The defaults are not stored, so a later change of defaults reaches people who never changed them.
      if (value === null || sameDisplayOptions(value, defaultDisplayOptions(view)))
        storage()?.removeItem(key);
      else storage()?.setItem(key, JSON.stringify(value));
    } catch {
      // Quota or privacy errors: the change applies until reload.
      if (value) memory.set(key, value);
    }
  }
  notify();
}

export type DisplayOptionsUpdate = Partial<DisplayOptions> | ((previous: DisplayOptions) => DisplayOptions);

export type UseDisplayOptionsResult = readonly [
  options: DisplayOptions,
  /** Merge a partial change, or map the previous options. */
  set: (update: DisplayOptionsUpdate) => void,
  /** Back to the view's defaults ("Reset to default"). */
  reset: () => void,
  /** True while the options equal the view's defaults. */
  isDefault: boolean,
];

/**
 * The display options of a view for the signed-in person: `useDisplayOptions('PAY', 'board')`, or
 * `useDisplayOptions(null, 'home')` on Home. Returns [options, set, reset, isDefault].
 * Needs a QueryClientProvider (it reads the user from me.get, which the app shell prefetches).
 */
export function useDisplayOptions(projectKey: string | null, view: TaskViewName): UseDisplayOptionsResult {
  const api = useApi();
  const workspaceId = useWorkspaceId();
  const userId = useQuery(meQuery(api)).data?.user.id ?? null;
  const key = userId ? displayStorageKey(workspaceId, userId, projectKey, view) : null;
  const memoryKey = `${workspaceId}:${projectKey ?? HOME_DISPLAY_SCOPE}:${view}`;

  const options = useSyncExternalStore(
    subscribe,
    () => (key && memory.has(key) ? (memory.get(key) as DisplayOptions) : read(key, view, memoryKey)),
    () => defaultDisplayOptions(view),
  );

  const set = useCallback(
    (update: DisplayOptionsUpdate) => {
      const previous =
        key && memory.has(key) ? (memory.get(key) as DisplayOptions) : read(key, view, memoryKey);
      const next =
        typeof update === 'function'
          ? update(previous)
          : { ...previous, ...update, properties: { ...previous.properties, ...update.properties } };
      write(key, memoryKey, view, normalizeDisplayOptions(view, next));
    },
    [key, memoryKey, view],
  );

  const reset = useCallback(() => {
    if (key) memory.delete(key);
    write(key, memoryKey, view, null);
  }, [key, memoryKey, view]);

  const isDefault = useMemo(() => sameDisplayOptions(options, defaultDisplayOptions(view)), [options, view]);
  return [options, set, reset, isDefault] as const;
}

/** Test helper: forget in-memory options and parsed values (localStorage is the test's to clear). */
export function resetDisplayOptionsForTests() {
  memory.clear();
  cache.clear();
}
