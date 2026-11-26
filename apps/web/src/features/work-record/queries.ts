import { type QueryClient, useMutation, useQueryClient } from '@tanstack/react-query';
import type { Task, UserRef } from '@zamu/contracts';
import {
  type CacheSnapshot,
  cancelTaskQueries,
  editTaskCaches,
  invalidateTask,
  meQuery,
  restoreTaskCaches,
} from '~/features/tasks/queries';
import type { WorkspaceApi } from '~/lib/orpc';
import { useApi } from '~/lib/workspace';
import { applyWorkPatch, toWorkInput, type WorkPatch } from './ops';

// Work-record writes from the task view: criteria and done items (check, waive, reword, move, remove,
// add), the plan and the summary. Each is one PATCH /tasks/{key}. Every cached copy of the task changes
// at once (the detail's lists, the counts on rows, cards and Home) and goes back when the server
// refuses. Writes to one task run one after the other, so item numbers always refer to the list the
// server has.

export interface WorkUpdateVariables {
  key: string;
  patch: WorkPatch;
}

const workKey = (key: string) => ['work-record', key] as const;

/** The signed-in person as a waiver records them, from the cache. */
function signedIn(api: WorkspaceApi, queryClient: QueryClient): UserRef | null {
  const me = queryClient.getQueryData(meQuery(api).queryKey);
  return me ? { id: me.user.id, name: me.user.name, kind: me.user.kind } : null;
}

/** Applies a work-record change to every cached copy of the task. Returns what to put back. */
export function applyOptimisticWork(
  api: WorkspaceApi,
  queryClient: QueryClient,
  key: string,
  patch: WorkPatch,
): CacheSnapshot {
  const by = signedIn(api, queryClient);
  const full = queryClient.getQueryData(api.orpc.tasks.get.queryKey({ input: { key } })) as Task | undefined;
  return editTaskCaches(api, queryClient, new Map([[key, (item) => applyWorkPatch(item, patch, by, full)]]));
}

export function useWorkRecordUpdate(taskKey: string) {
  const api = useApi();
  const queryClient = useQueryClient();
  return useMutation({
    mutationKey: workKey(taskKey),
    // One at a time per task: numbers in a request refer to the list after the one before it.
    scope: { id: `work-record:${taskKey}` },
    mutationFn: ({ key, patch }: WorkUpdateVariables) => api.client.tasks.update(toWorkInput(key, patch)),
    onMutate: async ({ key, patch }): Promise<CacheSnapshot> => {
      await cancelTaskQueries(api, queryClient);
      return applyOptimisticWork(api, queryClient, key, patch);
    },
    onError: (_error, _variables, snapshot) => restoreTaskCaches(queryClient, snapshot),
    onSuccess: (task) => {
      queryClient.setQueryData(api.orpc.tasks.get.queryKey({ input: { key: task.key } }), task);
    },
    onSettled: (_task, _error, { key }) => {
      // Refetch once the last queued write has answered, so a refetch never undoes a pending one.
      if (queryClient.isMutating({ mutationKey: workKey(key) }) <= 1)
        void invalidateTask(api, queryClient, key);
    },
  });
}
