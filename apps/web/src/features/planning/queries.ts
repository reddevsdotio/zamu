import { type QueryClient, useMutation, useQueryClient } from '@tanstack/react-query';
import type {
  CreateCycleInput,
  CreateMilestoneInput,
  CreateWaveInput,
  CycleSelector,
  EndCycleInput,
  GateResultState,
  MilestonePlan,
  TaskWave,
  UpdateCycleInput,
  UpdateMilestoneInput,
  UpdateWaveInput,
} from '@zamu/contracts';
import type { z } from 'zod';
import { retryOnce } from '~/features/tasks/errors';
import { applyOptimisticPatch, cancelTaskQueries, restoreTaskCaches } from '~/features/tasks/queries';
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

/** M8: the milestone's waves in order, with their gates and tasks, and the tasks in no wave. */
export const milestonePlanQuery = (api: WorkspaceApi, id: string) =>
  api.orpc.milestones.plan.queryOptions({ input: { id }, retry: retryOnce });

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

// ── Waves and gates (M8) ────────────────────────────────────────────────────────────────────────────────

/** After a wave write: the plan, the milestone (its wave summary), and every task row (their `wave`). */
function invalidateWaves(api: WorkspaceApi, queryClient: QueryClient) {
  return Promise.all([
    queryClient.invalidateQueries({ queryKey: api.orpc.milestones.key() }),
    queryClient.invalidateQueries({ queryKey: api.orpc.tasks.key() }),
  ]);
}

export function useUpdatePlanUrl() {
  const api = useApi();
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: ({ id, planUrl }: { id: string; planUrl: string | null }) =>
      api.client.milestones.update({ id, planUrl }),
    onSuccess: (milestone) => {
      queryClient.setQueryData(api.orpc.milestones.get.queryKey({ input: { id: milestone.id } }), milestone);
      queryClient.setQueryData(
        api.orpc.milestones.plan.queryKey({ input: { id: milestone.id } }),
        (plan: MilestonePlan | undefined) => (plan ? { ...plan, planUrl: milestone.planUrl ?? null } : plan),
      );
      void queryClient.invalidateQueries({ queryKey: api.orpc.milestones.key() });
    },
  });
}

export function useCreateWave() {
  const api = useApi();
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: (input: z.input<typeof CreateWaveInput>) => api.client.waves.create(input),
    onSettled: () => void invalidateWaves(api, queryClient),
  });
}

export function useUpdateWave() {
  const api = useApi();
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: (input: z.input<typeof UpdateWaveInput>) => api.client.waves.update(input),
    onSettled: () => void invalidateWaves(api, queryClient),
  });
}

export function useDeleteWave() {
  const api = useApi();
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: (id: string) => api.client.waves.delete({ id }),
    onSettled: () => void invalidateWaves(api, queryClient),
  });
}

export interface PutInWaveVariables {
  milestone: string;
  /** The wave, as task rows show it; null takes the tasks out of their wave. */
  wave: TaskWave | null;
  keys: readonly string[];
}

/**
 * Puts tasks in a wave, or takes them out (a drag, Alt+↑ / Alt+↓). The rows move at once; the plan
 * comes back from the server, and the caches go back if it refuses.
 */
export function usePutTasksInWave() {
  const api = useApi();
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: ({ milestone, wave, keys }: PutInWaveVariables) =>
      api.client.waves.putTasks({ milestone, wave: wave?.id ?? null, keys: [...keys] }),
    onMutate: async ({ wave, keys }) => {
      await cancelTaskQueries(api, queryClient);
      const snapshots = keys.map((key) => applyOptimisticPatch(api, queryClient, key, { wave }));
      return snapshots;
    },
    onError: (_error, _variables, snapshots) => {
      for (const snapshot of [...(snapshots ?? [])].reverse()) restoreTaskCaches(queryClient, snapshot);
    },
    onSuccess: (plan) => {
      queryClient.setQueryData(api.orpc.milestones.plan.queryKey({ input: { id: plan.milestone.id } }), plan);
    },
    onSettled: () => void invalidateWaves(api, queryClient),
  });
}

export function useRecordGate() {
  const api = useApi();
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: (input: { id: string; state: GateResultState; note: string }) =>
      api.client.waves.recordGate(input),
    onSuccess: () => void invalidateWaves(api, queryClient),
  });
}
