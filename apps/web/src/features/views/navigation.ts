import { useCallback, useMemo, useSyncExternalStore } from 'react';
import { workspaceStorageKey } from '~/lib/storage-keys';

// Navigation memory (plan call 6, shortcuts.md "Task view"): when a task is opened from a view, the
// view's task keys in order and its name are kept in sessionStorage (per tab), so the task view can
// walk them with J / K and show "12 of 40 in List". One list per workspace: PAY-12 in one workspace is
// another task than PAY-12 in the next.
//   sessionStorage zamu:task-nav:v2:<workspace id> = { keys: [...], from: "List", returnTo?: "/w/acme/p/PAY?status=todo" }

/** The sessionStorage key of a workspace's list. */
export function taskNavStorageKey(workspaceId: string): string {
  return workspaceStorageKey('task-nav', workspaceId);
}
/** Longer lists keep the keys around the opened task. */
const MAX_KEYS = 2000;

export interface TaskNavigationList {
  /** Task keys in the order the view showed them. */
  keys: readonly string[];
  /** The view's name as the task view says it: "List", "Board", "Home". */
  from: string;
  /** Where Esc / "Back" goes: the view's URL with its filters. */
  returnTo?: string;
}

function storage(): Storage | null {
  try {
    return typeof window === 'undefined' ? null : window.sessionStorage;
  } catch {
    return null;
  }
}

const listeners = new Set<() => void>();
const cache = new Map<string, { raw: string | null; value: TaskNavigationList | null }>();

function read(workspaceId: string): TaskNavigationList | null {
  const key = taskNavStorageKey(workspaceId);
  let raw: string | null = null;
  try {
    raw = storage()?.getItem(key) ?? null;
  } catch {
    raw = null;
  }
  const cached = cache.get(key);
  if (cached && raw === cached.raw) return cached.value;
  let value: TaskNavigationList | null = null;
  if (raw) {
    try {
      const parsed = JSON.parse(raw) as Partial<TaskNavigationList>;
      if (Array.isArray(parsed.keys) && typeof parsed.from === 'string') {
        value = {
          keys: parsed.keys.filter((key): key is string => typeof key === 'string'),
          from: parsed.from,
          ...(typeof parsed.returnTo === 'string' ? { returnTo: parsed.returnTo } : {}),
        };
      }
    } catch {
      value = null;
    }
  }
  cache.set(key, { raw, value });
  return value;
}

/**
 * Remember the view a task is being opened from. Call it right before navigating to the task
 * (Enter, a click, the peek's "Open"). `openedKey` keeps a long list centred on that task.
 */
export function rememberTaskNavigation(
  workspaceId: string,
  list: TaskNavigationList,
  openedKey?: string,
): void {
  let keys = [...list.keys];
  if (keys.length > MAX_KEYS) {
    const index = openedKey ? Math.max(0, keys.indexOf(openedKey)) : 0;
    const start = Math.max(0, Math.min(keys.length - MAX_KEYS, index - MAX_KEYS / 2));
    keys = keys.slice(start, start + MAX_KEYS);
  }
  try {
    storage()?.setItem(
      taskNavStorageKey(workspaceId),
      JSON.stringify({ keys, from: list.from, ...(list.returnTo ? { returnTo: list.returnTo } : {}) }),
    );
  } catch {
    // Quota or privacy errors: the task view then has no J / K.
  }
  for (const listener of listeners) listener();
}

/** Forget the workspace's list (the person left the views). */
export function forgetTaskNavigation(workspaceId: string): void {
  try {
    storage()?.removeItem(taskNavStorageKey(workspaceId));
  } catch {
    // ignore
  }
  for (const listener of listeners) listener();
}

/** The workspace's remembered list, or null. */
export function readTaskNavigation(workspaceId: string): TaskNavigationList | null {
  return read(workspaceId);
}

function subscribe(listener: () => void) {
  listeners.add(listener);
  return () => {
    listeners.delete(listener);
  };
}

export interface TaskNavigation {
  /** 1-based position of the task in the list; null when the task isn't in it (opened from a link). */
  position: number | null;
  total: number;
  /** Previous and next task keys (K and J); null at the ends or without a list. */
  prev: string | null;
  next: string | null;
  /** "List", "Board", "Home"; null without a list. */
  from: string | null;
  returnTo: string | null;
  /** "12 of 40 in List"; null when the task isn't in the list. */
  label: string | null;
}

/** Position of `taskKey` in a remembered list. */
export function taskNavigationFor(list: TaskNavigationList | null, taskKey: string): TaskNavigation {
  const index = list ? list.keys.indexOf(taskKey) : -1;
  if (!list || index < 0) {
    return {
      position: null,
      total: 0,
      prev: null,
      next: null,
      from: null,
      returnTo: list?.returnTo ?? null,
      label: null,
    };
  }
  const total = list.keys.length;
  return {
    position: index + 1,
    total,
    prev: list.keys[index - 1] ?? null,
    next: list.keys[index + 1] ?? null,
    from: list.from,
    returnTo: list.returnTo ?? null,
    label: `${index + 1} of ${total} in ${list.from}`,
  };
}

/** For the task view: where this task sits in the list it was opened from. */
export function useTaskNavigation(workspaceId: string, taskKey: string): TaskNavigation {
  const snapshot = useCallback(() => read(workspaceId), [workspaceId]);
  const list = useSyncExternalStore(subscribe, snapshot, () => null);
  return useMemo(() => taskNavigationFor(list, taskKey), [list, taskKey]);
}
