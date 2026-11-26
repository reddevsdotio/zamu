import { createFileRoute, redirect } from '@tanstack/react-router';
import { ArchiveSettings } from '~/features/project-settings/ArchiveSettings';

// Archive settings of a project (M7): archive finished tasks after a number of days, with a preview of
// what the next nightly run takes, /p/PAY/settings/archive. The project list the settings layout loads
// carries the setting.
export const Route = createFileRoute('/_app/w/$workspace/p/$projectKey/settings/archive')({
  beforeLoad: ({ params }) => {
    const upper = params.projectKey.toUpperCase();
    if (upper !== params.projectKey) {
      throw redirect({
        to: '/w/$workspace/p/$projectKey/settings/archive',
        params: { ...params, projectKey: upper },
        replace: true,
      });
    }
  },
  head: ({ params }) => ({ meta: [{ title: `Archive · ${params.projectKey} · Zamu` }] }),
  component: ArchiveRoute,
});

function ArchiveRoute() {
  const { projectKey } = Route.useParams();
  return <ArchiveSettings projectKey={projectKey} />;
}
