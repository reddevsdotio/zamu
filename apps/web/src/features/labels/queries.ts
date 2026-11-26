import { type QueryClient, useMutation, useQueryClient } from '@tanstack/react-query';
import type { CreateLabelInput, DeleteLabelInput, UpdateLabelInput } from '@zamu/contracts';
import type { z } from 'zod';
import { retryOnce } from '~/features/tasks/errors';
import type { WorkspaceApi } from '~/lib/orpc';
import { useApi } from '~/lib/workspace';

// Labels of a project (M5). Shared by the filter menu (features/views), the label picker
// (features/task-fields) and project settings, Labels. Writes refresh the label list and every task
// list, since rows and cards show label names and colours.

/** Every label of a project, with usage counts (hidden tasks left out). */
export const labelsQuery = (api: WorkspaceApi, projectKey: string) =>
  api.orpc.labels.list.queryOptions({ input: { project: projectKey }, retry: retryOnce });

export function invalidateLabels(api: WorkspaceApi, queryClient: QueryClient) {
  return Promise.all([
    queryClient.invalidateQueries({ queryKey: api.orpc.labels.key() }),
    queryClient.invalidateQueries({ queryKey: api.orpc.tasks.key() }),
    queryClient.invalidateQueries({ queryKey: api.orpc.home.key() }),
  ]);
}

export function useCreateLabel() {
  const api = useApi();
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: (input: z.input<typeof CreateLabelInput>) => api.client.labels.create(input),
    onSuccess: () => void invalidateLabels(api, queryClient),
  });
}

export function useUpdateLabel() {
  const api = useApi();
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: (input: z.input<typeof UpdateLabelInput>) => api.client.labels.update(input),
    onSuccess: () => void invalidateLabels(api, queryClient),
  });
}

export function useDeleteLabel() {
  const api = useApi();
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: (input: z.input<typeof DeleteLabelInput>) => api.client.labels.delete(input),
    onSuccess: () => void invalidateLabels(api, queryClient),
  });
}
