import { createFileRoute, redirect } from '@tanstack/react-router';
import { GeneralSettings } from '~/features/project-settings/GeneralSettings';

// General settings of a project: name, key, repository, description, the milestones and cycles
// switches, and Delete project. The Edit action of the projects table opens this page.
export const Route = createFileRoute('/_app/w/$workspace/p/$projectKey/settings/')({
  beforeLoad: ({ params }) => {
    const upper = params.projectKey.toUpperCase();
    if (upper !== params.projectKey) {
      throw redirect({
        to: '/w/$workspace/p/$projectKey/settings',
        params: { ...params, projectKey: upper },
        replace: true,
      });
    }
  },
  head: ({ params }) => ({ meta: [{ title: `Settings · ${params.projectKey} · Zamu` }] }),
  component: GeneralRoute,
});

function GeneralRoute() {
  const { projectKey } = Route.useParams();
  return <GeneralSettings projectKey={projectKey} />;
}
