import { type QueryClient, useMutation, useQueryClient } from '@tanstack/react-query';
import type {
  CreateCycleInput,
  CreateMilestoneInput,
  CycleSelector,
  EndCycleInput,
  UpdateCycleInput,
  UpdateMilestoneInput,
} from '@zamu/contracts';
import type { z } from 'zod';
import { retryOnce } from '~/features/tasks/errors';
import type { WorkspaceApi } from '~/lib/orpc';
import { useApi } from '~/lib/workspace';

// Data for the milestone and cycle screens, through the same /api/v1 client the CLI uses.
// Writes refresh every list a milestone or cycle shows up in: the planning lists, the task lists (chips,
// filters, counts) and the projects list (the header's Cycles tab note).

/** Every milestone of a project. Same input as the project header's tab count, so they share a cache entry. */
export const milestonesQuery = (api: WorkspaceApi, projectKey: string) =>
  api.orpc.milestones.list.queryOptions({ input: { project: projectKey }, retry: retryOnce });

export const milestoneQuery = (api: WorkspaceApi, id: string) =>
  api.orpc.milestones.get.queryOptions({ input: { id }, retry: retryOnce });

/** Every cycle of a project, oldest first. */
export const cyclesQuery = (api: WorkspaceApi, projectKey: string) =>
  api.orpc.cycles.list.queryOptions({ input: { project: projectKey }, retry: retryOnce });

/** One cycle by number, or the current or next one. */
export const cycleQuery = (api: WorkspaceApi, projectKey: string, number: CycleSelector) =>
  api.orpc.cycles.get.queryOptions({ input: { project: projectKey, number }, retry: retryOnce });

export function invalidatePlanning(api: WorkspaceApi, queryClient: QueryClient) {
  return Promise.all([
    queryClient.invalidateQueries({ queryKey: api.orpc.milestones.key() }),
    queryClient.invalidateQueries({ queryKey: api.orpc.cycles.key() }),
    queryClient.invalidateQueries({ queryKey: api.orpc.tasks.key() }),
    queryClient.invalidateQueries({ queryKey: api.orpc.projects.key() }),
  ]);
}

export function useCreateMilestone() {
  const api = useApi();
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: (input: z.input<typeof CreateMilestoneInput>) => api.client.milestones.create(input),
    onSuccess: (milestone) => {
      queryClient.setQueryData(api.orpc.milestones.get.queryKey({ input: { id: milestone.id } }), milestone);
      void invalidatePlanning(api, queryClient);
    },
  });
}

export function useUpdateMilestone() {
  const api = useApi();
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: (input: z.input<typeof UpdateMilestoneInput>) => api.client.milestones.update(input),
    onSuccess: (milestone) => {
      queryClient.setQueryData(api.orpc.milestones.get.queryKey({ input: { id: milestone.id } }), milestone);
      void invalidatePlanning(api, queryClient);
    },
  });
}

export function useDeleteMilestone() {
  const api = useApi();
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: (id: string) => api.client.milestones.delete({ id }),
    onSuccess: (_result, id) => {
      queryClient.removeQueries({ queryKey: api.orpc.milestones.get.key({ input: { id } }) });
      void invalidatePlanning(api, queryClient);
    },
  });
}

export function useCreateCycle() {
  const api = useApi();
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: (input: z.input<typeof CreateCycleInput>) => api.client.cycles.create(input),
    onSuccess: () => void invalidatePlanning(api, queryClient),
  });
}

export function useUpdateCycle() {
  const api = useApi();
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: (input: z.input<typeof UpdateCycleInput>) => api.client.cycles.update(input),
    onSuccess: () => void invalidatePlanning(api, queryClient),
  });
}

export function useEndCycle() {
  const api = useApi();
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: (input: z.input<typeof EndCycleInput>) => api.client.cycles.end(input),
    onSuccess: () => void invalidatePlanning(api, queryClient),
  });
}

/** Moves tasks into a cycle ("Add tasks" on a cycle page). */
export function useAddToCycle() {
  const api = useApi();
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: ({ key, cycle }: { key: string; cycle: number }) => api.client.tasks.update({ key, cycle }),
    onSuccess: () => void invalidatePlanning(api, queryClient),
  });
}
