// TanStack Query wiring for the Git connections page. Connections are settings-only data, so every
// call goes through the server functions in ./server and comes back as a SettingsResult. Tokens are
// sent, never received.

import { queryOptions, useMutation, useQueryClient } from '@tanstack/react-query';
import type {
  CreateGitConnectionInput,
  DeleteGitConnectionInput,
  GitConnection,
  GitConnectionDeleted,
  GitConnectionList,
  GitConnectionTestResult,
  TestGitConnectionInput,
  UpdateGitConnectionInput,
} from '@zamu/contracts';
import type { z } from 'zod';
import type { WorkspaceApi } from '~/lib/orpc';
import { useApi } from '~/lib/workspace';
import { workspaceKeyPath } from '~/lib/workspace-api';
import { SettingsError, unwrap } from '../settings/result';

/** Loaded on first use, so jsdom tests of these screens do not pull server-only modules in. */
const server = () => import('./server');

/** Connections of one workspace: ['w', slug, 'connections', …]. */
export const connectionsKey = (api: WorkspaceApi) => [...workspaceKeyPath(api.slug), 'connections'] as const;

/** Errors the server answered on purpose (forbidden, not found) do not get better on retry. */
const retry = (failures: number, error: unknown) => !(error instanceof SettingsError) && failures < 2;

/** Every connection of the workspace with `usedBy` and `encryptionReady`. */
export const connectionsQuery = (api: WorkspaceApi) =>
  queryOptions({
    queryKey: [...connectionsKey(api), 'list'],
    queryFn: async (): Promise<GitConnectionList> =>
      unwrap((await server()).listConnectionsFn({ data: { workspace: api.slug } })),
    retry,
  });

/** Refetches the list and the project shapes (a paused or resumed mirror changes their summary). */
function useInvalidate() {
  const api = useApi();
  const queryClient = useQueryClient();
  return () =>
    Promise.all([
      queryClient.invalidateQueries({ queryKey: connectionsKey(api) }),
      queryClient.invalidateQueries({ queryKey: api.orpc.projects.key() }),
    ]);
}

export function useCreateConnection() {
  const { slug: workspace } = useApi();
  const invalidate = useInvalidate();
  return useMutation({
    mutationFn: async (input: z.input<typeof CreateGitConnectionInput>): Promise<GitConnection> =>
      unwrap((await server()).createConnectionFn({ data: { workspace, input } })),
    onSuccess: invalidate,
  });
}

export function useUpdateConnection() {
  const { slug: workspace } = useApi();
  const invalidate = useInvalidate();
  return useMutation({
    mutationFn: async (input: z.input<typeof UpdateGitConnectionInput>): Promise<GitConnection> =>
      unwrap((await server()).updateConnectionFn({ data: { workspace, input } })),
    onSuccess: invalidate,
  });
}

export function useDeleteConnection() {
  const { slug: workspace } = useApi();
  const invalidate = useInvalidate();
  return useMutation({
    mutationFn: async (input: z.input<typeof DeleteGitConnectionInput>): Promise<GitConnectionDeleted> =>
      unwrap((await server()).deleteConnectionFn({ data: { workspace, input } })),
    onSettled: invalidate,
  });
}

/** Tests a token. A saved connection's own test stores the result, so the list refetches then. */
export function useTestConnection() {
  const { slug: workspace } = useApi();
  const invalidate = useInvalidate();
  return useMutation({
    mutationFn: async (input: z.input<typeof TestGitConnectionInput>): Promise<GitConnectionTestResult> =>
      unwrap((await server()).testConnectionFn({ data: { workspace, input } })),
    onSuccess: (_result, input) => {
      if ('id' in input && !input.token) void invalidate();
    },
  });
}
