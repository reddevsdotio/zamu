import { ORPCError } from '@orpc/client';
import { useQueryClient } from '@tanstack/react-query';
import { useCallback, useRef } from 'react';
import { describeError } from '~/features/tasks/errors';
import {
  BulkRefusedError,
  type BulkTaskPatch,
  bulkRefusal,
  cachedTask,
  inversePatch,
  isNoopPatch,
  type TaskPatch,
  useBulkUpdateTasks,
  useUpdateTask,
} from '~/features/tasks/queries';
import { useApi } from '~/lib/workspace';
import { localToday } from '~/ui';
import { describeChange } from './describe';
import { confirmFinishing } from './finishing';
import { type FieldTarget, READ_ONLY_TEXT, subjectOf } from './targets';
import { showFieldToast } from './toast';

// Applies a picker's change to its targets: one task through tasks.update, a selection through
// tasks.bulkUpdate (native projects only). The caches change at once (features/tasks/queries.ts),
// a toast says what changed, and its Undo applies the inverse patch. A move to In review or Done of
// tasks with open items waits for the finishing warning (finishing.ts); Cancel sends nothing.

export interface ApplyOptions {
  /** The error was shown elsewhere (the blocker picker's loop note): return true to skip the toast. */
  onError?: (error: unknown) => boolean | undefined;
  /** No toast on success (the caller says it another way). */
  quiet?: boolean;
}

/** The sentence for a failed change. */
export function failureText(subject: string, error: unknown): string {
  if (error instanceof BulkRefusedError) return error.message;
  if (error instanceof ORPCError && error.code === 'TASK_MIRRORED') return READ_ONLY_TEXT;
  return `Couldn't change ${subject}. ${describeError(error).message}`;
}

export interface FieldChange {
  /**
   * Changes the targets. Resolves true when the server saved it, false when it refused (the caches
   * are back as they were) or nothing had to change.
   */
  apply: (targets: readonly FieldTarget[], patch: TaskPatch, options?: ApplyOptions) => Promise<boolean>;
}

type Run = (
  targets: readonly FieldTarget[],
  patch: TaskPatch,
  options: ApplyOptions & { isUndo?: boolean },
) => Promise<boolean>;

/** Puts every task back: tasks that need the same inverse go together in one bulk change. */
async function undoAll(run: Run, inverses: { task: FieldTarget; patch: TaskPatch }[]) {
  const groups = new Map<string, { tasks: FieldTarget[]; patch: TaskPatch }>();
  for (const inverse of inverses) {
    const id = JSON.stringify(inverse.patch);
    const group = groups.get(id) ?? { tasks: [], patch: inverse.patch };
    group.tasks.push(inverse.task);
    groups.set(id, group);
  }
  await Promise.all([...groups.values()].map((group) => run(group.tasks, group.patch, { isUndo: true })));
}

export function useFieldChange(): FieldChange {
  const api = useApi();
  const queryClient = useQueryClient();
  const update = useUpdateTask();
  const bulk = useBulkUpdateTasks();
  const { mutateAsync: updateAsync } = update;
  const { mutateAsync: bulkAsync } = bulk;
  const runRef = useRef<Run>(async () => false);

  const run = useCallback(
    async (
      targets: readonly FieldTarget[],
      patch: TaskPatch,
      options: ApplyOptions & { isUndo?: boolean },
    ): Promise<boolean> => {
      const today = localToday();
      const current = targets.map((target) => cachedTask(api, queryClient, target.key) ?? target);
      const changing = current.filter((task) => !isNoopPatch(task, patch));
      if (changing.length === 0) return false;
      const subject = subjectOf(changing);
      if (changing.length > 1) {
        const refusal = bulkRefusal(changing);
        if (refusal) {
          showFieldToast({ text: refusal, tone: 'error' });
          return false;
        }
      }
      // A person moving tasks with open items to In review or Done answers the finishing warning
      // first. An Undo puts back a status the person already had, so it never asks.
      if (patch.status !== undefined && !options.isUndo) {
        if (!(await confirmFinishing(api, queryClient, changing, patch.status))) return false;
      }
      const inverses = changing.map((task) => ({ task, patch: inversePatch(task, patch) }));
      try {
        if (changing.length === 1) {
          await updateAsync({ key: changing[0]?.key ?? '', patch });
        } else {
          await bulkAsync({
            keys: changing.map((task) => task.key),
            patch: patch as BulkTaskPatch,
            targets: changing,
          });
        }
      } catch (error) {
        if (!options.onError?.(error)) showFieldToast({ text: failureText(subject, error), tone: 'error' });
        return false;
      }
      if (!options.quiet) {
        showFieldToast({
          text: describeChange(subject, patch, today),
          ...(options.isUndo
            ? {}
            : {
                undo: () => {
                  void undoAll(runRef.current, inverses);
                },
              }),
        });
      }
      return true;
    },
    [queryClient, updateAsync, bulkAsync, api],
  );
  runRef.current = run;

  const apply = useCallback(
    (targets: readonly FieldTarget[], patch: TaskPatch, options: ApplyOptions = {}) =>
      run(targets, patch, options),
    [run],
  );
  return { apply };
}
