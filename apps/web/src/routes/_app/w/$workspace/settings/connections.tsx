import { createFileRoute } from '@tanstack/react-router';
import { ConnectionsPage } from '~/features/connections/ConnectionsPage';
import { connectionsQuery } from '~/features/connections/queries';
import { settleOnServer } from '~/features/tasks/prefetch';

// Workspace git connections (M3): every member reads the list, owners and admins manage it.
export const Route = createFileRoute('/_app/w/$workspace/settings/connections')({
  // The server waits for the list; in the browser the page shows its skeleton while it loads.
  loader: ({ context: { queryClient, api } }) =>
    settleOnServer(queryClient.prefetchQuery(connectionsQuery(api))),
  head: () => ({ meta: [{ title: 'Git connections · Settings' }] }),
  component: ConnectionsPage,
});
