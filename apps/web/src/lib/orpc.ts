// The web app's /api/v1 client and TanStack Query helpers, one set per workspace (lib/workspace-api.ts).
//
// Every page lives under /w/<slug>/, and every call names that workspace with the x-zamu-workspace
// header, so two tabs on two workspaces never act in each other's.
//
// On the server (SSR, loaders) the client calls the router in-process with the incoming request's
// headers plus the workspace header, so there is no HTTP round trip to ourselves. In the browser it sends
// RPC requests to /api/v1/rpc with the session cookie. Both go through the same auth middleware and
// throw ORPCError with the contract's codes (UNAUTHORIZED, NOT_A_MEMBER, FORBIDDEN, NOT_FOUND, ...) and
// ProblemData ({ requestId, issues }) as `data`.
//
// Components get their workspace's set from useApi() (lib/workspace.tsx); loaders from the route
// context (`context.api`, set by the /w/$workspace layout).
//
//   const api = useApi();
//   const { data } = useQuery(api.orpc.projects.list.queryOptions());
//   await queryClient.invalidateQueries({ queryKey: api.orpc.tasks.key() });
import { createORPCClient } from '@orpc/client';
import { RPCLink } from '@orpc/client/fetch';
import { createIsomorphicFn } from '@tanstack/react-start';
import { getRequestHeaders } from '@tanstack/react-start/server';
import { API_PREFIX, WORKSPACE_HEADER } from '@zamu/contracts';
import { type ApiClient, createApiClient } from '../server/api';
import { type WorkspaceApi, workspaceApiOf } from './workspace-api';

export type { ApiClient, ApiUtils, WorkspaceApi } from './workspace-api';

/** Must match RPC_PREFIX in server/api/handler.ts (not imported: that module is server-only). */
const RPC_PATH = `${API_PREFIX}/rpc`;

const clientFor = createIsomorphicFn()
  .server(
    (slug: string): ApiClient =>
      createApiClient(() => {
        const headers = new Headers(getRequestHeaders());
        headers.set(WORKSPACE_HEADER, slug);
        return headers;
      }),
  )
  .client(
    (slug: string): ApiClient =>
      createORPCClient(
        new RPCLink({ url: `${window.location.origin}${RPC_PATH}`, headers: { [WORKSPACE_HEADER]: slug } }),
      ),
  );

// The browser keeps one set per slug, so query options and callbacks stay referentially stable. The
// server builds a set per call: it is cheap, and slugs in request URLs are not trusted to be few.
const browserCache = new Map<string, WorkspaceApi>();

/** The /api/v1 client and query helpers of the workspace `slug`. */
export function workspaceApi(slug: string): WorkspaceApi {
  if (typeof window === 'undefined') return workspaceApiOf(slug, clientFor(slug));
  let api = browserCache.get(slug);
  if (!api) {
    api = workspaceApiOf(slug, clientFor(slug));
    browserCache.set(slug, api);
  }
  return api;
}
