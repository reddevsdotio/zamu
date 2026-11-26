import { createFileRoute } from '@tanstack/react-router';
import { KeysPage } from '~/features/settings/KeysPage';
import { apiKeysQuery } from '~/features/settings/queries';

export const Route = createFileRoute('/_app/w/$workspace/settings/my-keys')({
  loader: ({ context: { queryClient, api } }) => queryClient.prefetchQuery(apiKeysQuery(api, 'me')),
  head: () => ({ meta: [{ title: 'Your API keys · Settings' }] }),
  component: () => <KeysPage mode="mine" />,
});
