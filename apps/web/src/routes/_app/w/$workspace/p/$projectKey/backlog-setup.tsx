import { createFileRoute, redirect } from '@tanstack/react-router';
import { BacklogSetupScreen } from '~/features/backlog-setup/BacklogSetupScreen';
import { projectsQuery } from '~/features/backlog-setup/queries';
import { parseSetupSearch } from '~/features/backlog-setup/search';

// Backlog.md setup of one project (five steps), and Edit mappings of an existing source:
//   /p/PAY/backlog-setup?mode=mirror | ?mode=import | ?step=mappings&edit=1
// The step and its inputs are search params, so a reload keeps them (features/backlog-setup/search.ts).
export const Route = createFileRoute('/_app/w/$workspace/p/$projectKey/backlog-setup')({
  validateSearch: parseSetupSearch,
  beforeLoad: ({ params, search }) => {
    const upper = params.projectKey.toUpperCase();
    if (upper !== params.projectKey) {
      throw redirect({
        to: '/w/$workspace/p/$projectKey/backlog-setup',
        params: { ...params, projectKey: upper },
        search,
        replace: true,
      });
    }
  },
  loader: ({ context }) => context.queryClient.prefetchQuery(projectsQuery(context.api)),
  head: ({ params }) => ({
    meta: [{ title: `Backlog.md setup · ${params.projectKey} · Zamu` }],
  }),
  component: BacklogSetupRoute,
});

function BacklogSetupRoute() {
  const { projectKey } = Route.useParams();
  const search = Route.useSearch();
  return <BacklogSetupScreen key={projectKey} projectKey={projectKey} search={search} />;
}
