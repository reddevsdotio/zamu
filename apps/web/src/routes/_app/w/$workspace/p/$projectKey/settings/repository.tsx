import { createFileRoute, redirect } from '@tanstack/react-router';
import { settleOnServer } from '~/features/planning/prefetch';
import { repositorySettingsQuery } from '~/features/project-settings/queries';
import { RepositorySettingsPage } from '~/features/project-settings/RepositorySettings';

// Repository settings of a project (M7): the repository Zamu reads pull requests from, close on merge
// and the webhook, /p/PAY/settings/repository.
export const Route = createFileRoute('/_app/w/$workspace/p/$projectKey/settings/repository')({
  beforeLoad: ({ params }) => {
    const upper = params.projectKey.toUpperCase();
    if (upper !== params.projectKey) {
      throw redirect({
        to: '/w/$workspace/p/$projectKey/settings/repository',
        params: { ...params, projectKey: upper },
        replace: true,
      });
    }
  },
  loader: ({ context: { queryClient, api }, params }) =>
    settleOnServer(queryClient.prefetchQuery(repositorySettingsQuery(api, params.projectKey))),
  head: ({ params }) => ({ meta: [{ title: `Repository · ${params.projectKey} · Zamu` }] }),
  component: RepositoryRoute,
});

function RepositoryRoute() {
  const { projectKey } = Route.useParams();
  return <RepositorySettingsPage projectKey={projectKey} />;
}
