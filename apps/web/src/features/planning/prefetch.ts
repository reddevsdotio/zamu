import type { QueryClient } from '@tanstack/react-query';
import type { CycleSelector } from '@zamu/contracts';
import { membersQuery, projectsQuery, taskListQuery } from '~/features/tasks/queries';
import { defaultDisplayOptions, type TaskFilter } from '~/features/views';
import type { WorkspaceApi } from '~/lib/orpc';
import { cycleQuery, cyclesQuery, milestoneQuery, milestonesQuery } from './queries';
import { planningListInput } from './usePlanningTasks';

// Route loaders of the milestone and cycle screens. The server awaits them so the first HTML has the
// data; in the browser they run in the background. Task lists use the default Display options: the
// person's own live in localStorage, which the server cannot read.

export function prefetchMilestones(api: WorkspaceApi, queryClient: QueryClient, projectKey: string) {
  return Promise.all([
    queryClient.prefetchQuery(milestonesQuery(api, projectKey)),
    queryClient.prefetchQuery(projectsQuery(api)),
  ]);
}

function prefetchPlanningTasks(
  api: WorkspaceApi,
  queryClient: QueryClient,
  projectKey: string,
  scope: { milestone: string } | { cycle: number },
  filter: TaskFilter,
) {
  return Promise.all([
    queryClient.prefetchQuery(
      taskListQuery(api, planningListInput(projectKey, scope, filter, defaultDisplayOptions('list'))),
    ),
    queryClient.prefetchQuery(taskListQuery(api, planningListInput(projectKey, scope, {}))),
  ]);
}

export function prefetchMilestone(
  api: WorkspaceApi,
  queryClient: QueryClient,
  projectKey: string,
  id: string,
  filter: TaskFilter,
) {
  return Promise.all([
    queryClient.prefetchQuery(milestoneQuery(api, id)),
    prefetchPlanningTasks(api, queryClient, projectKey, { milestone: id }, filter),
    queryClient.prefetchQuery(projectsQuery(api)),
    queryClient.prefetchQuery(membersQuery(api)),
  ]);
}

export function prefetchCycles(api: WorkspaceApi, queryClient: QueryClient, projectKey: string) {
  return Promise.all([
    queryClient.prefetchQuery(cyclesQuery(api, projectKey)),
    queryClient.prefetchQuery(projectsQuery(api)),
  ]);
}

export function prefetchCycle(
  api: WorkspaceApi,
  queryClient: QueryClient,
  projectKey: string,
  selector: CycleSelector,
  filter: TaskFilter = {},
) {
  return Promise.all([
    queryClient.prefetchQuery(cycleQuery(api, projectKey, selector)),
    queryClient.prefetchQuery(cyclesQuery(api, projectKey)),
    ...(typeof selector === 'number'
      ? [prefetchPlanningTasks(api, queryClient, projectKey, { cycle: selector }, filter)]
      : []),
    queryClient.prefetchQuery(projectsQuery(api)),
    queryClient.prefetchQuery(membersQuery(api)),
  ]);
}

/** Awaits on the server only. */
export async function settleOnServer(work: Promise<unknown>): Promise<void> {
  if (import.meta.env.SSR) await work;
  else void work;
}
