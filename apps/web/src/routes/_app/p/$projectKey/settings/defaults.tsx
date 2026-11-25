import { createFileRoute, redirect } from '@tanstack/react-router';
import { TaskDefaultsSettings } from '~/features/project-settings/TaskDefaultsSettings';

// Task defaults of a project (M6): the done items every new task starts with, /p/PAY/settings/defaults.
// The project list the settings layout loads carries them.
export const Route = createFileRoute('/_app/p/$projectKey/settings/defaults')({
  beforeLoad: ({ params }) => {
    const upper = params.projectKey.toUpperCase();
    if (upper !== params.projectKey) {
      throw redirect({
        to: '/p/$projectKey/settings/defaults',
        params: { projectKey: upper },
        replace: true,
      });
    }
  },
  head: ({ params }) => ({ meta: [{ title: `Task defaults · ${params.projectKey} · Zamu` }] }),
  component: TaskDefaultsRoute,
});

function TaskDefaultsRoute() {
  const { projectKey } = Route.useParams();
  return <TaskDefaultsSettings projectKey={projectKey} />;
}
