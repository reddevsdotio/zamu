// TanStack Query wiring for the workspace screens. The list of the person's workspaces spans every
// workspace, so its key sits outside ['w', slug]; what one workspace holds (the Delete counts) sits
// under it. Writes go through the server functions in server.ts.
import { queryOptions, useQueryClient } from '@tanstack/react-query';
import type {
  CreateWorkspaceInput,
  MyWorkspaces,
  UpdateWorkspaceInput,
  Workspace,
  WorkspaceContents,
} from '@zamu/contracts';
import { useCallback } from 'react';
import type { z } from 'zod';
import type { WorkspaceApi } from '~/lib/workspace-api';
import { workspaceKeyPath } from '~/lib/workspace-api';
import { SettingsError, unwrap } from '../settings/result';
import {
  createWorkspaceFn,
  deleteWorkspaceFn,
  leaveWorkspaceFn,
  listMyWorkspacesFn,
  suggestWorkspaceSlugFn,
  updateWorkspaceFn,
  workspaceContentsFn,
} from './server';

/** Errors the server answered on purpose do not get better on retry. */
const retry = (failures: number, error: unknown) => !(error instanceof SettingsError) && failures < 2;

export const MY_WORKSPACES_KEY = ['workspaces', 'mine'] as const;

/** Every workspace the signed-in person belongs to, and whether they may create one. */
export const myWorkspacesQuery = () =>
  queryOptions({
    queryKey: MY_WORKSPACES_KEY,
    queryFn: (): Promise<MyWorkspaces> => unwrap(listMyWorkspacesFn()),
    staleTime: 30_000,
    retry,
  });

/** What deleting the page's workspace would remove. Always fresh: the dialog asks when it opens. */
export const workspaceContentsQuery = (api: Pick<WorkspaceApi, 'slug'>) =>
  queryOptions({
    queryKey: [...workspaceKeyPath(api.slug), 'workspace', 'contents'],
    queryFn: (): Promise<WorkspaceContents> => unwrap(workspaceContentsFn({ data: { workspace: api.slug } })),
    staleTime: 0,
    retry,
  });

/** A free slug for `name` (the dialog's suggestion), or null when the server could not say. */
export async function suggestSlug(name: string): Promise<string | null> {
  const result = await suggestWorkspaceSlugFn({ data: { name } });
  return result.ok ? result.data : null;
}

export function createWorkspace(input: z.input<typeof CreateWorkspaceInput>): Promise<Workspace> {
  return unwrap(createWorkspaceFn({ data: input }));
}

export function updateWorkspace(
  workspace: string,
  input: z.input<typeof UpdateWorkspaceInput>,
): Promise<Workspace> {
  return unwrap(updateWorkspaceFn({ data: { workspace, input } }));
}

export function leaveWorkspace(workspace: string): Promise<unknown> {
  return unwrap(leaveWorkspaceFn({ data: { workspace, input: {} } }));
}

export function deleteWorkspace(workspace: string, confirmSlug: string): Promise<WorkspaceContents> {
  return unwrap(deleteWorkspaceFn({ data: { workspace, input: { confirmSlug } } }));
}

/** Refetches the switcher's list after a workspace was created, renamed, left or deleted. */
export function useRefreshMyWorkspaces(): () => Promise<void> {
  const queryClient = useQueryClient();
  return useCallback(() => queryClient.invalidateQueries({ queryKey: MY_WORKSPACES_KEY }), [queryClient]);
}
