import { ORPCError } from '@orpc/client';
import { MutationCache, QueryCache, QueryClient } from '@tanstack/react-query';
import { createRouter } from '@tanstack/react-router';
import { setupRouterSsrQueryIntegration } from '@tanstack/react-router-ssr-query';
import { LEFT_WORKSPACE_CODES, SettingsError } from './features/settings/result';
import { routeTree } from './routeTree.gen';

export type RouterContext = {
  queryClient: QueryClient;
};

/**
 * Whether a request failed because the person is not in the page's workspace (any more): removed by an
 * owner, or the workspace was deleted while the page was open.
 */
export function isLeftWorkspaceError(error: unknown): boolean {
  if (error instanceof SettingsError) return error.leftWorkspace;
  return error instanceof ORPCError && (LEFT_WORKSPACE_CODES as readonly string[]).includes(error.code);
}

export function getRouter() {
  // Set once the router exists; the caches below only call it in the browser, after a request failed.
  let leaveWorkspace = () => {};
  const onError = (error: unknown) => {
    if (typeof window !== 'undefined' && isLeftWorkspaceError(error)) leaveWorkspace();
  };

  const queryClient = new QueryClient({
    queryCache: new QueryCache({ onError }),
    mutationCache: new MutationCache({ onError }),
    defaultOptions: {
      // M1 has no real-time updates: data refetches on window focus and every 30 seconds.
      queries: { staleTime: 10_000, refetchOnWindowFocus: true, refetchInterval: 30_000 },
    },
  });

  const router = createRouter({
    routeTree,
    context: { queryClient } satisfies RouterContext,
    scrollRestoration: true,
    defaultPreload: 'intent',
    // Let TanStack Query decide freshness for preloaded data.
    defaultPreloadStaleTime: 0,
  });

  // `/` lands in a workspace the person still belongs to, or on /welcome.
  leaveWorkspace = () => void router.navigate({ to: '/', replace: true });

  setupRouterSsrQueryIntegration({ router, queryClient });

  return router;
}

declare module '@tanstack/react-router' {
  interface Register {
    router: ReturnType<typeof getRouter>;
  }
}
