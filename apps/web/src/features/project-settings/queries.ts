// TanStack Query wiring for project settings. The source status and Refresh now are shared with the
// project header (backlogStatusQuery, useBacklogStatus and useRefreshNow in features/project-header),
// so the header button and this page read one cache. Settings-only data (webhook secret, the switch to
// Zamu, another connection) goes through the server functions in features/backlog/server.ts, loaded on first use so
// that jsdom tests of these screens do not pull server-only modules in.

import { queryOptions, useMutation, useQueryClient } from '@tanstack/react-query';
import { useNavigate } from '@tanstack/react-router';
import type { BacklogProblemPage, BacklogWebhookInfo, ProjectList } from '@zamu/contracts';
import type { WorkspaceApi } from '~/lib/orpc';
import { useApi } from '~/lib/workspace';
import { workspaceKeyPath } from '~/lib/workspace-api';
import { connectionsKey } from '../connections/queries';
import { SettingsError, unwrap } from '../settings/result';
import { announceProjectDeleted } from './DeleteProjectDialog';
import type { SwitchCheck, SwitchResult } from './switch';

export const backlogSettingsKey = (api: WorkspaceApi, projectKey: string) =>
  [...workspaceKeyPath(api.slug), 'backlog-settings', projectKey] as const;

const retry = (failures: number, error: unknown) => !(error instanceof SettingsError) && failures < 2;

const backlogServer = () => import('../backlog/server');

/** Webhook URL, secret (admins) and last delivery; the webhook dialog polls it every 5 seconds. */
export const webhookInfoQuery = (api: WorkspaceApi, projectKey: string) =>
  queryOptions({
    queryKey: [...backlogSettingsKey(api, projectKey), 'webhook'],
    queryFn: async (): Promise<BacklogWebhookInfo> => {
      const { backlogWebhookInfoFn } = await backlogServer();
      return unwrap(backlogWebhookInfoFn({ data: { workspace: api.slug, input: { projectKey } } }));
    },
    retry,
  });

/** Whether the project has any task at all, hidden ones included (its key is fixed then). */
export const hasTasksQuery = (api: WorkspaceApi, projectKey: string) =>
  api.orpc.tasks.list.queryOptions({
    input: { project: projectKey, limit: 1, hidden: 'include' },
    select: (data) => data.items.length > 0,
  });

/** A further page of problems, through GET /projects/{project}/backlog. */
export async function loadProblemPage(
  api: WorkspaceApi,
  projectKey: string,
  cursor: string,
): Promise<BacklogProblemPage> {
  const status = await api.client.backlog.status({ project: projectKey, problemsCursor: cursor });
  return status.problems;
}

/** Refetches the section and every shape that carries the source summary. */
export function useInvalidateBacklog(projectKey: string) {
  const api = useApi();
  const queryClient = useQueryClient();
  return () =>
    Promise.all([
      queryClient.invalidateQueries({ queryKey: backlogSettingsKey(api, projectKey) }),
      queryClient.invalidateQueries({ queryKey: api.orpc.projects.key() }),
      queryClient.invalidateQueries({ queryKey: api.orpc.backlog.key() }),
    ]);
}

/** The check before the switch: open requests that change the Backlog.md folder, or why there are none. */
export async function checkSwitch(api: WorkspaceApi, projectKey: string): Promise<SwitchCheck> {
  const { checkBacklogSwitchFn } = await backlogServer();
  return unwrap(checkBacklogSwitchFn({ data: { workspace: api.slug, input: { projectKey } } }));
}

/**
 * Switches the project to Zamu after the typed key. Every task, milestone and label unlocks, and the
 * settings nav shows Task defaults, so every shape that carries the source refetches.
 */
export function useSwitchToZamu(projectKey: string) {
  const api = useApi();
  const queryClient = useQueryClient();
  const invalidate = useInvalidateBacklog(projectKey);
  return useMutation({
    mutationFn: async (confirmKey: string): Promise<SwitchResult> => {
      const { switchBacklogToZamuFn } = await backlogServer();
      const { project, switchedAt, switchedBy } = await unwrap(
        switchBacklogToZamuFn({ data: { workspace: api.slug, input: { projectKey, confirmKey } } }),
      );
      return { project, switchedAt, switchedBy };
    },
    onSuccess: () =>
      Promise.all([
        invalidate(),
        queryClient.invalidateQueries({ queryKey: api.orpc.tasks.key() }),
        queryClient.invalidateQueries({ queryKey: api.orpc.milestones.key() }),
        queryClient.invalidateQueries({ queryKey: api.orpc.labels.key() }),
        queryClient.invalidateQueries({ queryKey: connectionsKey(api) }),
      ]),
  });
}

/**
 * Saves the project's default done items (the whole list each time, so the last save wins). The list
 * of projects carries them, so it refetches afterwards.
 */
export function useSaveDefaultDoneItems(projectKey: string) {
  const api = useApi();
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: (defaultDoneItems: string[]) =>
      api.client.projects.update({ project: projectKey, defaultDoneItems }),
    onSuccess: () => queryClient.invalidateQueries({ queryKey: api.orpc.projects.key() }),
  });
}

export function useSetConnection(projectKey: string) {
  const api = useApi();
  const queryClient = useQueryClient();
  const invalidate = useInvalidateBacklog(projectKey);
  return useMutation({
    mutationFn: async (connectionId: string) => {
      const { setBacklogConnectionFn } = await backlogServer();
      return unwrap(
        setBacklogConnectionFn({ data: { workspace: api.slug, input: { projectKey, connectionId } } }),
      );
    },
    onSuccess: () =>
      Promise.all([invalidate(), queryClient.invalidateQueries({ queryKey: connectionsKey(api) })]),
  });
}

/**
 * Deletes the project (DELETE /projects/{project}). On success: the toast is queued, the page goes
 * to Home (where the shell shows "Deleted {KEY}"), the project leaves the cached list at once, and every query that could show its
 * tasks refetches: projects, tasks (lists, My tasks, boards), the dashboard and planning.
 */
export function useDeleteProject(projectKey: string) {
  const api = useApi();
  const queryClient = useQueryClient();
  const navigate = useNavigate();
  return useMutation({
    mutationFn: (confirmKey: string) => api.client.projects.delete({ project: projectKey, confirmKey }),
    onSuccess: async () => {
      announceProjectDeleted(projectKey);
      await navigate({ to: '/w/$workspace', params: { workspace: api.slug } });
      queryClient.setQueriesData<ProjectList>({ queryKey: api.orpc.projects.list.key() }, (data) =>
        data ? { ...data, items: data.items.filter((item) => item.key !== projectKey) } : data,
      );
      queryClient.removeQueries({ queryKey: backlogSettingsKey(api, projectKey) });
      await Promise.all([
        queryClient.invalidateQueries({ queryKey: api.orpc.projects.key() }),
        queryClient.invalidateQueries({ queryKey: api.orpc.tasks.key() }),
        queryClient.invalidateQueries({ queryKey: api.orpc.dashboard.key() }),
        queryClient.invalidateQueries({ queryKey: api.orpc.milestones.key() }),
        queryClient.invalidateQueries({ queryKey: api.orpc.cycles.key() }),
        queryClient.invalidateQueries({ queryKey: api.orpc.comments.key() }),
        queryClient.invalidateQueries({ queryKey: api.orpc.backlog.key() }),
        // Connections list the projects that use them.
        queryClient.invalidateQueries({ queryKey: connectionsKey(api) }),
      ]);
    },
  });
}

/** GET /projects/{project}/repository: the Repository settings page. */
export const repositorySettingsQuery = (api: WorkspaceApi, projectKey: string) =>
  api.orpc.repository.get.queryOptions({ input: { project: projectKey } });

/** GET /projects/{project}/archive-preview?days=N: what the next nightly run would archive. */
export const archivePreviewQuery = (api: WorkspaceApi, projectKey: string, days: number) =>
  api.orpc.projects.archivePreview.queryOptions({ input: { project: projectKey, days } });

/** Done and Canceled tasks of the project that are not archived, for the Archive page's off state. */
export const finishedCountsQuery = (api: WorkspaceApi, projectKey: string) =>
  api.orpc.tasks.list.queryOptions({
    input: { project: projectKey, limit: 1 },
    select: (data) => ({ done: data.counts.done, canceled: data.counts.canceled }),
  });
