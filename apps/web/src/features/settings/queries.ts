// TanStack Query wiring for the settings screens. Reads of /api/v1 data (me, members, projects) go
// through oRPC; everything else calls the settings server functions. Created API keys are never put
// in the query cache: the secret lives only in the reveal dialog's state.

import { queryOptions, useMutation, useQueryClient } from '@tanstack/react-query';
import type {
  AgentCreated,
  ApiKeyCreated,
  ApiKeySummary,
  CreateApiKeyInput,
  CreateInvitationInput,
  Invitation,
  ListApiKeysInput,
} from '@zamu/contracts';
import type { z } from 'zod';
import type { WorkspaceApi } from '~/lib/orpc';
import { useApi } from '~/lib/workspace';
import { workspaceKeyPath } from '~/lib/workspace-api';
import { SettingsError, unwrap } from './result';
import {
  cancelInvitationFn,
  createAgentFn,
  createApiKeyFn,
  createInvitationFn,
  listApiKeysFn,
  listInvitationsFn,
  removeMemberFn,
  revokeApiKeyFn,
} from './server';
import type { CreateAgentValues } from './types';

/** all, me or a user id. */
export type KeyOwnerFilter = ListApiKeysInput['owner'];

/** Settings data of one workspace, beside its /api/v1 queries: ['w', slug, 'settings', …]. */
const settingsKey = (api: WorkspaceApi) => [...workspaceKeyPath(api.slug), 'settings'] as const;

/** Errors the server answered on purpose (forbidden, not found) do not get better on retry. */
const retry = (failures: number, error: unknown) => !(error instanceof SettingsError) && failures < 2;

export const meQuery = (api: WorkspaceApi) => api.orpc.me.get.queryOptions();
export const membersQuery = (api: WorkspaceApi) => api.orpc.members.list.queryOptions();
export const projectsQuery = (api: WorkspaceApi) => api.orpc.projects.list.queryOptions();

export const invitationsQuery = (api: WorkspaceApi) =>
  queryOptions({
    queryKey: [...settingsKey(api), 'invitations'],
    queryFn: (): Promise<Invitation[]> => unwrap(listInvitationsFn({ data: { workspace: api.slug } })),
    retry,
  });

export const apiKeysQuery = (api: WorkspaceApi, owner: KeyOwnerFilter) =>
  queryOptions({
    queryKey: [...settingsKey(api), 'api-keys', owner],
    queryFn: (): Promise<ApiKeySummary[]> =>
      unwrap(listApiKeysFn({ data: { workspace: api.slug, input: { owner } } })),
    retry,
  });

/** Refetches everything a members or keys change can affect. */
function useInvalidateSettings() {
  const api = useApi();
  const queryClient = useQueryClient();
  return () =>
    Promise.all([
      queryClient.invalidateQueries({ queryKey: settingsKey(api) }),
      queryClient.invalidateQueries({ queryKey: api.orpc.members.key() }),
    ]);
}

export function useCreateInvitation() {
  const { slug: workspace } = useApi();
  const invalidate = useInvalidateSettings();
  return useMutation({
    mutationFn: (input: z.input<typeof CreateInvitationInput>) =>
      unwrap(createInvitationFn({ data: { workspace, input } })),
    onSuccess: invalidate,
  });
}

export function useCancelInvitation() {
  const { slug: workspace } = useApi();
  const invalidate = useInvalidateSettings();
  return useMutation({
    mutationFn: (id: string) => unwrap(cancelInvitationFn({ data: { workspace, input: { id } } })),
    onSettled: invalidate,
  });
}

export function useRemoveMember() {
  const { slug: workspace } = useApi();
  const invalidate = useInvalidateSettings();
  return useMutation({
    mutationFn: (userId: string) => unwrap(removeMemberFn({ data: { workspace, input: { userId } } })),
    onSettled: invalidate,
  });
}

export function useRevokeApiKey() {
  const { slug: workspace } = useApi();
  const invalidate = useInvalidateSettings();
  return useMutation({
    mutationFn: (id: string) => unwrap(revokeApiKeyFn({ data: { workspace, input: { id } } })),
    onSettled: invalidate,
  });
}

/**
 * Creating agents and keys returns the secret once. These are plain async functions rather than
 * mutations so the secret never sits in a mutation cache entry; callers refetch the lists afterwards.
 */
export function useCreateAgent(): (values: CreateAgentValues) => Promise<AgentCreated> {
  const { slug: workspace } = useApi();
  const invalidate = useInvalidateSettings();
  return async (values) => {
    const created = await unwrap(createAgentFn({ data: { workspace, input: values } }));
    void invalidate();
    return created;
  };
}

export function useCreateApiKey(): (input: z.input<typeof CreateApiKeyInput>) => Promise<ApiKeyCreated> {
  const { slug: workspace } = useApi();
  const invalidate = useInvalidateSettings();
  return async (input) => {
    const created = await unwrap(createApiKeyFn({ data: { workspace, input } }));
    void invalidate();
    return created;
  };
}
