import { createFileRoute } from '@tanstack/react-router';
import { MembersPage } from '~/features/settings/MembersPage';
import { invitationsQuery, membersQuery } from '~/features/settings/queries';

export const Route = createFileRoute('/_app/w/$workspace/settings/members')({
  loader: ({ context: { queryClient, api } }) =>
    Promise.all([
      queryClient.prefetchQuery(membersQuery(api)),
      queryClient.prefetchQuery(invitationsQuery(api)),
    ]),
  head: () => ({ meta: [{ title: 'Members · Settings' }] }),
  component: MembersPage,
});
