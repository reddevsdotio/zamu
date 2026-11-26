import { createFileRoute, redirect } from '@tanstack/react-router';
import { labelsQuery } from '~/features/labels/queries';
import { settleOnServer } from '~/features/planning/prefetch';
import { LabelsSettings } from '~/features/project-settings/LabelsSettings';

// Labels of a project (frames 115 to 126): /p/PAY/settings/labels.
export const Route = createFileRoute('/_app/w/$workspace/p/$projectKey/settings/labels')({
  beforeLoad: ({ params }) => {
    const upper = params.projectKey.toUpperCase();
    if (upper !== params.projectKey) {
      throw redirect({
        to: '/w/$workspace/p/$projectKey/settings/labels',
        params: { ...params, projectKey: upper },
        replace: true,
      });
    }
  },
  loader: ({ context: { queryClient, api }, params }) =>
    settleOnServer(queryClient.prefetchQuery(labelsQuery(api, params.projectKey))),
  head: ({ params }) => ({ meta: [{ title: `Labels · ${params.projectKey} · Zamu` }] }),
  component: LabelsRoute,
});

function LabelsRoute() {
  const { projectKey } = Route.useParams();
  return <LabelsSettings projectKey={projectKey} />;
}
