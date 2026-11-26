import type { QueryClient } from '@tanstack/react-query';
import type { Task, TaskListItem, TaskStatus } from '@zamu/contracts';
import { useSyncExternalStore } from 'react';
import { type CachedTask, cachedTask, meQuery } from '~/features/tasks/queries';
import { FINISHING, openItemsOf } from '~/features/work-record/ops';
import type { WorkspaceApi } from '~/lib/orpc';
import { isMirroredTarget } from './targets';

// The finishing warning on every way a person sets a status (M6 design call 15). A move to In review or
// Done of a task with open criteria or done items waits for an answer: for one task the finishing
// dialog lists the open items (check, waive, cancel or move anyway); for a selection one confirm says
// how many of the tasks have open items. The rule lives here so the pickers, the palette, the board
// and the task view all reach it through useFieldChange or confirmFinishing. The dialogs are drawn by
// the host in features/work-record (mounted once by the app shell), which settles the request.
//
// Rows carry criteriaProgress and doneProgress, so whether a task has open items is known without a
// request; the dialog for one task reads the full task for the items themselves. Agents never see
// it: the server refuses them with OPEN_ITEMS. Mirrored tasks are skipped: their status is read-only.

export type FinishingRequest =
  | {
      kind: 'task';
      /** The task moving. */
      key: string;
      status: TaskStatus;
    }
  | {
      kind: 'tasks';
      status: TaskStatus;
      /** How many tasks move. */
      total: number;
      /** Keys of the moving tasks with open items, in selection order. */
      withOpenItems: string[];
    };

interface Pending {
  id: number;
  request: FinishingRequest;
  resolve: (move: boolean) => void;
}

let pending: Pending | null = null;
let nextId = 1;
let hosts = 0;
const listeners = new Set<() => void>();

function emit() {
  for (const listener of listeners) listener();
}

function subscribe(listener: () => void) {
  listeners.add(listener);
  return () => listeners.delete(listener);
}

const isFullTask = (task: CachedTask): task is Task => Array.isArray((task as Task).criteria);

/** True when the task has an open criterion or done item, as far as the cache knows. */
export function hasOpenItems(task: CachedTask): boolean {
  if (isFullTask(task)) return openItemsOf(task).length > 0;
  const row = task as TaskListItem;
  return (row.criteriaProgress?.open ?? 0) + (row.doneProgress?.open ?? 0) > 0;
}

/**
 * The warning a move of `targets` to `status` needs, or null when it goes through at once: the status
 * doesn't finish, the signed-in member is an agent, or no moving task has open items.
 */
export function finishingRequest(
  api: WorkspaceApi,
  queryClient: QueryClient,
  targets: readonly CachedTask[],
  status: TaskStatus,
): FinishingRequest | null {
  if (!FINISHING.includes(status)) return null;
  if (queryClient.getQueryData(meQuery(api).queryKey)?.user.kind === 'agent') return null;
  const moving = targets
    .map((target) => cachedTask(api, queryClient, target.key) ?? target)
    .filter((task) => task.status !== status && !isMirroredTarget(task));
  const withOpenItems = moving.filter(hasOpenItems).map((task) => task.key);
  if (withOpenItems.length === 0) return null;
  if (moving.length === 1) return { kind: 'task', key: withOpenItems[0] ?? '', status };
  return { kind: 'tasks', status, total: moving.length, withOpenItems };
}

/**
 * Resolves true when the move may go ahead: at once when no warning is needed (or no host is mounted
 * to show one), else once the person answers the dialog.
 */
export function confirmFinishing(
  api: WorkspaceApi,
  queryClient: QueryClient,
  targets: readonly CachedTask[],
  status: TaskStatus,
): Promise<boolean> {
  const request = finishingRequest(api, queryClient, targets, status);
  if (!request || hosts === 0) return Promise.resolve(true);
  return new Promise((resolve) => {
    // One question at a time: a newer move replaces an unanswered one, which stays where it was.
    pending?.resolve(false);
    pending = { id: nextId++, request, resolve };
    emit();
  });
}

/** The question waiting for an answer, for the host. */
export function useFinishingRequest(): { id: number; request: FinishingRequest } | null {
  return useSyncExternalStore(
    subscribe,
    () => pending,
    () => null,
  );
}

/** The host's answer to request `id`: move (true) or keep the status (false). */
export function settleFinishing(id: number, move: boolean) {
  if (!pending || pending.id !== id) return;
  const { resolve } = pending;
  pending = null;
  emit();
  resolve(move);
}

/** Called by the host while it is mounted; returns the cleanup. */
export function registerFinishingHost(): () => void {
  hosts++;
  return () => {
    hosts--;
    if (hosts === 0 && pending) settleFinishing(pending.id, false);
  };
}

/** Test helper. */
export function resetFinishingForTests() {
  pending?.resolve(false);
  pending = null;
  emit();
}
