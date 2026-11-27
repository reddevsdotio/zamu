import { type QueryClient, useQueryClient } from '@tanstack/react-query';
import type { TaskStatus, TaskWave } from '@zamu/contracts';
import { useCallback, useSyncExternalStore } from 'react';
import { type CachedTask, cachedTask, meQuery } from '~/features/tasks/queries';
import type { WorkspaceApi } from '~/lib/orpc';
import { useApi } from '~/lib/workspace';
import { isMirroredTarget } from './targets';

// The start guard (M8, frame 114): every way a person starts a task (Backlog or Todo to In progress or
// In review) asks first when the task's wave is locked, because an earlier gate has not passed. Agents
// are refused by the server (WAVE_LOCKED) and never see the question; people may start anyway. The
// rule lives here so the pickers, the status keys, the palette, the board's drag and keys, the peek and
// the task view all reach it, through useFieldChange (apply.ts) or useStartGuard. StartGuardHost,
// mounted once by the app shell, draws the dialog and settles the request.
//
// Rows, cards and the full task carry `wave` with its lock, so no request is needed to know.

/** Statuses a task starts from. */
const NOT_STARTED: readonly TaskStatus[] = ['backlog', 'todo'];
/** Statuses that start it. */
const STARTED: readonly TaskStatus[] = ['in_progress', 'in_review'];

export type StartingRequest =
  | {
      kind: 'task';
      key: string;
      /** The locked wave: number and name. */
      wave: TaskWave;
      /** The earlier wave whose gate it waits for. */
      waitsFor: { number: number; name: string };
    }
  | {
      kind: 'tasks';
      status: TaskStatus;
      /** How many tasks move. */
      total: number;
      /** Keys of the moving tasks in a locked wave, in selection order. */
      locked: string[];
    };

/** True when moving `task` to `status` starts it inside a locked wave. */
export function startsInLockedWave(task: CachedTask, status: TaskStatus): boolean {
  return (
    NOT_STARTED.includes(task.status) &&
    STARTED.includes(status) &&
    task.wave?.locked === true &&
    !isMirroredTarget(task)
  );
}

/**
 * The question a move of `targets` to `status` needs, or null when it goes through at once: it starts
 * nothing, the signed-in member is an agent, or no moving task is in a locked wave.
 */
export function startingRequest(
  api: WorkspaceApi,
  queryClient: QueryClient,
  targets: readonly CachedTask[],
  status: TaskStatus,
): StartingRequest | null {
  if (!STARTED.includes(status)) return null;
  if (queryClient.getQueryData(meQuery(api).queryKey)?.user.kind === 'agent') return null;
  const moving = targets
    .map((target) => cachedTask(api, queryClient, target.key) ?? target)
    .filter((task) => task.status !== status);
  const locked = moving.filter((task) => startsInLockedWave(task, status));
  if (locked.length === 0) return null;
  const first = locked[0];
  if (moving.length === 1 && first?.wave) {
    return {
      kind: 'task',
      key: first.key,
      wave: first.wave,
      waitsFor: first.wave.lockedUntil ?? { number: Math.max(1, first.wave.number - 1), name: '' },
    };
  }
  return { kind: 'tasks', status, total: moving.length, locked: locked.map((task) => task.key) };
}

interface Pending {
  id: number;
  request: StartingRequest;
  resolve: (start: boolean) => void;
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

/**
 * Resolves true when the move may go ahead: at once when nothing needs asking (or no host is mounted
 * to ask), else once the person answers the dialog.
 */
export function confirmStarting(
  api: WorkspaceApi,
  queryClient: QueryClient,
  targets: readonly CachedTask[],
  status: TaskStatus,
): Promise<boolean> {
  const request = startingRequest(api, queryClient, targets, status);
  if (!request || hosts === 0) return Promise.resolve(true);
  return new Promise((resolve) => {
    // One question at a time: a newer move replaces an unanswered one, which keeps its status.
    pending?.resolve(false);
    pending = { id: nextId++, request, resolve };
    emit();
  });
}

/**
 * The start guard for screens that move tasks without useFieldChange (the board's drag and status
 * keys): resolves true when the move may go ahead.
 */
export function useStartGuard(): (targets: readonly CachedTask[], status: TaskStatus) => Promise<boolean> {
  const api = useApi();
  const queryClient = useQueryClient();
  return useCallback(
    (targets, status) => confirmStarting(api, queryClient, targets, status),
    [api, queryClient],
  );
}

/** The question waiting for an answer, for the host. */
export function useStartingRequest(): { id: number; request: StartingRequest } | null {
  return useSyncExternalStore(
    subscribe,
    () => pending,
    () => null,
  );
}

/** The host's answer to request `id`: start (true) or keep the status (false). */
export function settleStarting(id: number, start: boolean) {
  if (!pending || pending.id !== id) return;
  const { resolve } = pending;
  pending = null;
  emit();
  resolve(start);
}

/** Called by the host while it is mounted; returns the cleanup. */
export function registerStartingHost(): () => void {
  hosts++;
  return () => {
    hosts--;
    if (hosts === 0 && pending) settleStarting(pending.id, false);
  };
}

/** Test helper. */
export function resetStartingForTests() {
  pending?.resolve(false);
  pending = null;
  emit();
}
