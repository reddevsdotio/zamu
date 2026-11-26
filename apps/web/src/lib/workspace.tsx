// The workspace the current page is in, for components: its name and slug, and its /api/v1 client and
// query helpers. The /w/$workspace layout provides it; loaders read the same values from the route
// context instead. Links into the workspace take `workspace` from here:
//
//   const { slug } = useWorkspace();
//   <Link to="/w/$workspace/p/$projectKey" params={{ workspace: slug, projectKey }} />
import type { WorkspaceRef } from '@zamu/contracts';
import { createContext, type ReactNode, useContext } from 'react';
import type { WorkspaceApi } from './workspace-api';
import type { WorkspaceUrlSlug } from './workspace-paths';

export interface CurrentWorkspace extends WorkspaceRef {
  /** Branded for the href helpers (lib/workspace-paths.ts). */
  slug: WorkspaceUrlSlug;
  api: WorkspaceApi;
}

const WorkspaceContext = createContext<CurrentWorkspace | null>(null);

export function WorkspaceProvider({
  workspace,
  children,
}: {
  workspace: CurrentWorkspace;
  children: ReactNode;
}) {
  return <WorkspaceContext.Provider value={workspace}>{children}</WorkspaceContext.Provider>;
}

/** The page's workspace. Throws outside /w/$workspace (and outside a test's WorkspaceProvider). */
export function useWorkspace(): CurrentWorkspace {
  const workspace = useContext(WorkspaceContext);
  if (!workspace) throw new Error('useWorkspace() needs a WorkspaceProvider (the /w/$workspace layout).');
  return workspace;
}

/** The page's workspace, or null outside one (signed-out screens, /welcome). */
export function useOptionalWorkspace(): CurrentWorkspace | null {
  return useContext(WorkspaceContext);
}

/** The /api/v1 client and query helpers of the page's workspace. */
export function useApi(): WorkspaceApi {
  return useWorkspace().api;
}

/** The page's workspace slug, for link params. */
export function useWorkspaceSlug(): WorkspaceUrlSlug {
  return useWorkspace().slug;
}

/** The page's workspace id, for what the browser remembers per workspace (lib/storage-keys.ts). */
export function useWorkspaceId(): string {
  return useWorkspace().id;
}
