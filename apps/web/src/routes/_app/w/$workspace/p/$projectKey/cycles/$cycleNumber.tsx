import { createFileRoute, notFound, redirect } from '@tanstack/react-router';
import { CyclePage, parseCycleParam } from '~/features/planning/CyclePage';
import { prefetchCycle, settleOnServer } from '~/features/planning/prefetch';
import { parsePlanningSearch, planningFilter } from '~/features/planning/search';

// One cycle: /p/PAY/cycles/12, or /p/PAY/cycles/current and /p/PAY/cycles/next.
export const Route = createFileRoute('/_app/w/$workspace/p/$projectKey/cycles/$cycleNumber')({
  validateSearch: parsePlanningSearch,
  beforeLoad: ({ params, search }) => {
    if (parseCycleParam(params.cycleNumber) === null) throw notFound();
    const upper = params.projectKey.toUpperCase();
    if (upper !== params.projectKey) {
      throw redirect({
        to: '/w/$workspace/p/$projectKey/cycles/$cycleNumber',
        params: { ...params, projectKey: upper, cycleNumber: params.cycleNumber },
        search,
        replace: true,
      });
    }
  },
  loaderDeps: ({ search }) => search,
  loader: ({ context, params, deps }) => {
    const selector = parseCycleParam(params.cycleNumber);
    return selector === null
      ? undefined
      : settleOnServer(
          prefetchCycle(context.api, context.queryClient, params.projectKey, selector, planningFilter(deps)),
        );
  },
  head: ({ params }) => ({
    meta: [{ title: `Cycle ${params.cycleNumber} · ${params.projectKey} · Zamu` }],
  }),
  component: CycleRoute,
});

function CycleRoute() {
  const { projectKey, cycleNumber } = Route.useParams();
  const selector = parseCycleParam(cycleNumber);
  if (selector === null) return null;
  return <CyclePage key={cycleNumber} projectKey={projectKey} selector={selector} />;
}
