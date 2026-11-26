import { createFileRoute, redirect } from '@tanstack/react-router';
import { CyclesScreen } from '~/features/planning/CyclesScreen';
import { prefetchCycles, settleOnServer } from '~/features/planning/prefetch';

// Cycles of one project: /p/PAY/cycles.
export const Route = createFileRoute('/_app/w/$workspace/p/$projectKey/cycles/')({
  beforeLoad: ({ params }) => {
    const upper = params.projectKey.toUpperCase();
    if (upper !== params.projectKey) {
      throw redirect({
        to: '/w/$workspace/p/$projectKey/cycles',
        params: { ...params, projectKey: upper },
        replace: true,
      });
    }
  },
  loader: ({ context, params }) =>
    settleOnServer(prefetchCycles(context.api, context.queryClient, params.projectKey)),
  head: ({ params }) => ({ meta: [{ title: `Cycles · ${params.projectKey} · Zamu` }] }),
  component: CyclesRoute,
});

function CyclesRoute() {
  const { projectKey } = Route.useParams();
  return <CyclesScreen projectKey={projectKey} />;
}
