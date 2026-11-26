import { createFileRoute, redirect, useNavigate } from '@tanstack/react-router';
import { settleOnServer } from '~/features/planning/prefetch';
import { backlogStatusQuery } from '~/features/project-header';
import { BacklogSettings } from '~/features/project-settings/BacklogSettings';
import { projectsQuery } from '~/features/tasks/queries';

export interface BacklogSettingsSearch {
  /** 1 opens the webhook dialog (setup links here after the first read). */
  webhook?: 1;
}

// Backlog.md settings of a project: /p/PAY/settings/backlog, ?webhook=1 opens the webhook setup.
export const Route = createFileRoute('/_app/w/$workspace/p/$projectKey/settings/backlog')({
  validateSearch: (search: Record<string, unknown>): BacklogSettingsSearch =>
    search.webhook === 1 || search.webhook === '1' || search.webhook === true ? { webhook: 1 } : {},
  beforeLoad: ({ params, search }) => {
    const upper = params.projectKey.toUpperCase();
    if (upper !== params.projectKey) {
      throw redirect({
        to: '/w/$workspace/p/$projectKey/settings/backlog',
        params: { ...params, projectKey: upper },
        search,
        replace: true,
      });
    }
  },
  loader: ({ context: { queryClient, api }, params }) =>
    settleOnServer(
      (async () => {
        const projects = await queryClient.ensureQueryData(projectsQuery(api));
        const project = projects.items.find((item) => item.key === params.projectKey);
        if (project?.backlog) await queryClient.prefetchQuery(backlogStatusQuery(api, params.projectKey));
      })(),
    ),
  head: ({ params }) => ({ meta: [{ title: `Backlog.md · ${params.projectKey} · Zamu` }] }),
  component: BacklogRoute,
});

function BacklogRoute() {
  const { projectKey } = Route.useParams();
  const search = Route.useSearch();
  const navigate = useNavigate({ from: Route.fullPath });
  return (
    <BacklogSettings
      projectKey={projectKey}
      webhookOpen={search.webhook === 1}
      onWebhookOpenChange={(open) => void navigate({ search: open ? { webhook: 1 } : {}, replace: true })}
    />
  );
}
