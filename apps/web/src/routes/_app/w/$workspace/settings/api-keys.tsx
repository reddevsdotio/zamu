import { createFileRoute } from '@tanstack/react-router';
import { UserId } from '@zamu/contracts';
import { z } from 'zod';
import { KeysPage } from '~/features/settings/KeysPage';
import { apiKeysQuery, membersQuery } from '~/features/settings/queries';

/** `owner` narrows the list to one member's keys (Manage keys on an agent). */
const KeysSearch = z.object({ owner: UserId.optional().catch(undefined) });

export const Route = createFileRoute('/_app/w/$workspace/settings/api-keys')({
  validateSearch: KeysSearch,
  loaderDeps: ({ search }) => ({ owner: search.owner }),
  loader: ({ context: { queryClient, api }, deps }) =>
    Promise.all([
      queryClient.prefetchQuery(apiKeysQuery(api, deps.owner ?? 'all')),
      queryClient.prefetchQuery(membersQuery(api)),
    ]),
  head: () => ({ meta: [{ title: 'API keys · Settings' }] }),
  component: ApiKeysRoute,
});

function ApiKeysRoute() {
  const { owner } = Route.useSearch();
  return <KeysPage key={owner ?? 'all'} mode="workspace" ownerId={owner} />;
}
