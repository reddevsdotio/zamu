import { createFileRoute, Outlet } from '@tanstack/react-router';
import { settleOnServer } from '~/features/planning/prefetch';
import { ProjectSettingsLayout } from '~/features/project-settings/ProjectSettingsLayout';
import { projectsQuery } from '~/features/tasks/queries';

// Project settings: /p/PAY/settings (General), /p/PAY/settings/labels (Labels),
// /p/PAY/settings/defaults (Task defaults), /p/PAY/settings/repository (Repository),
// /p/PAY/settings/archive (Archive) and /p/PAY/settings/backlog (Backlog.md), under the project header
// with the settings nav.
export const Route = createFileRoute('/_app/w/$workspace/p/$projectKey/settings')({
  loader: ({ context }) => settleOnServer(context.queryClient.prefetchQuery(projectsQuery(context.api))),
  component: ProjectSettingsRoute,
});

function ProjectSettingsRoute() {
  const { projectKey } = Route.useParams();
  return (
    <ProjectSettingsLayout projectKey={projectKey}>
      <Outlet />
    </ProjectSettingsLayout>
  );
}
