import { ORPCError } from '@orpc/client';
import { useMutation, useQueryClient } from '@tanstack/react-query';
import type { TaskBulkResult } from '@zamu/contracts';
import { useCallback } from 'react';
import { showFieldToast } from '~/features/task-fields/toast';
import { useApi } from '~/lib/workspace';
import { describeError } from './errors';
import {
  type CachedTask,
  cancelTaskQueries,
  editTaskCaches,
  invalidateTask,
  restoreTaskCaches,
} from './queries';

// Archiving and restoring tasks by hand (M7, POST /tasks/archive and /tasks/restore, all or nothing).
// The cached copies change at once: archivedAt set or cleared, so an open task view turns read-only
// before the server answers. Lists, boards and Home drop archived tasks when they read again. A
// mirrored task is refused: Backlog.md's archive/tasks/ folder decides.

/** The toast for a task of a mirrored project. */
export const MIRRORED_ARCHIVE_TEXT =
  "Backlog.md decides: move the task's file into or out of archive/tasks/ in the repository.";

type Op = 'archive' | 'restore';

function useArchiveOp(op: Op) {
  const api = useApi();
  const queryClient = useQueryClient();
  const procedure = op === 'archive' ? api.orpc.tasks.archive : api.orpc.tasks.restore;
  return useMutation({
    mutationKey: procedure.mutationKey(),
    mutationFn: (keys: readonly string[]): Promise<TaskBulkResult> =>
      op === 'archive'
        ? api.client.tasks.archive({ keys: [...keys] })
        : api.client.tasks.restore({ keys: [...keys] }),
    onMutate: async (keys) => {
      await cancelTaskQueries(api, queryClient);
      const at = op === 'archive' ? new Date().toISOString() : null;
      const edit = <T extends CachedTask>(item: T): T => ({ ...item, archivedAt: at });
      return editTaskCaches(api, queryClient, new Map(keys.map((key) => [key, edit])));
    },
    onError: (_error, _keys, snapshot) => restoreTaskCaches(queryClient, snapshot),
    onSuccess: (result) => {
      for (const item of result.items) {
        const queryKey = api.orpc.tasks.get.queryKey({ input: { key: item.key } });
        const task = queryClient.getQueryData(queryKey);
        if (task) queryClient.setQueryData(queryKey, { ...task, ...item });
      }
    },
    onSettled: (_result, _error, keys) => {
      for (const key of keys) void invalidateTask(api, queryClient, key);
    },
  });
}

/** The toast after it worked (frame 085): "3 tasks archived", "1 task restored". */
export function doneText(op: Op, count: number): string {
  return `${count} ${count === 1 ? 'task' : 'tasks'} ${op === 'archive' ? 'archived' : 'restored'}`;
}

/** "PAY-118" or "3 tasks". */
const subjectOf = (keys: readonly string[]) => (keys.length === 1 ? (keys[0] ?? '') : `${keys.length} tasks`);

/** Why archiving or restoring failed, as a toast. */
export function archiveFailureText(op: Op, keys: readonly string[], error: unknown): string {
  if (error instanceof ORPCError && error.code === 'TASK_MIRRORED') return MIRRORED_ARCHIVE_TEXT;
  return `Couldn't ${op} ${subjectOf(keys)}. ${describeError(error).message}`;
}

/**
 * Archive and restore with the toast and its Undo (⌘Z while it shows): "3 tasks archived · Undo".
 * Each resolves true when the server saved it.
 */
export function useArchiveActions() {
  const archive = useArchiveOp('archive');
  const restore = useArchiveOp('restore');
  const { mutateAsync: archiveAsync } = archive;
  const { mutateAsync: restoreAsync } = restore;

  const run = useCallback(
    async (op: Op, keys: readonly string[], withUndo: boolean): Promise<boolean> => {
      if (keys.length === 0) return false;
      try {
        await (op === 'archive' ? archiveAsync(keys) : restoreAsync(keys));
      } catch (error) {
        showFieldToast({ text: archiveFailureText(op, keys, error), tone: 'error' });
        return false;
      }
      const other: Op = op === 'archive' ? 'restore' : 'archive';
      showFieldToast({
        text: doneText(op, keys.length),
        ...(withUndo ? { undo: () => void run(other, keys, false) } : {}),
      });
      return true;
    },
    [archiveAsync, restoreAsync],
  );

  return {
    archive: useCallback((keys: readonly string[]) => run('archive', keys, true), [run]),
    restore: useCallback((keys: readonly string[]) => run('restore', keys, true), [run]),
    isPending: archive.isPending || restore.isPending,
  };
}
