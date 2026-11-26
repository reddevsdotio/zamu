import { type QueryClient, queryOptions } from '@tanstack/react-query';
import type { GetHomeInput, Home } from '@zamu/contracts';
import { retryOnce, withTimeout } from '~/features/tasks/errors';
import { membersQuery, meQuery, projectsQuery, REQUEST_TIMEOUT_MS } from '~/features/tasks/queries';
import type { WorkspaceApi } from '~/lib/orpc';

// Home data. It refreshes on the app-wide cadence (router.tsx: on window focus and every 30 seconds),
// and after every successful edit (features/shell/home-count.ts). Field changes patch the cached rows
// at once (features/tasks/queries.ts editHome). While a filter change loads, the last answer of the
// same tab stays on screen; switching tabs shows the new tab's loading rows instead.

export function homeQuery(api: WorkspaceApi, input: GetHomeInput) {
  return queryOptions<Home>({
    queryKey: api.orpc.home.get.queryKey({ input }),
    queryFn: ({ signal }) => api.client.home.get(input, { signal: withTimeout(signal, REQUEST_TIMEOUT_MS) }),
    retry: retryOnce,
    placeholderData: (previous: Home | undefined) =>
      previous && previous.tab === input.tab ? previous : undefined,
  });
}

/** Requests the Home route loader starts. */
export function prefetchHome(api: WorkspaceApi, queryClient: QueryClient, input: GetHomeInput) {
  return Promise.all([
    queryClient.prefetchQuery(homeQuery(api, input)),
    queryClient.prefetchQuery(meQuery(api)),
    queryClient.prefetchQuery(membersQuery(api)),
    queryClient.prefetchQuery(projectsQuery(api)),
  ]);
}
