import type { WorkspaceApi } from '~/lib/orpc';

/** Projects with open counts, most recently active first (rail, projects screen, "/" redirect). */
export const projectsQuery = (api: WorkspaceApi) => api.orpc.projects.list.queryOptions();

/** The caller and their workspace (workspace name in the rail and the projects subtitle). */
export const meQuery = (api: WorkspaceApi) => api.orpc.me.get.queryOptions({ staleTime: 5 * 60_000 });
