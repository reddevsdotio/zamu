import { createFileRoute } from '@tanstack/react-router';
import { HomeScreen } from '~/features/home/HomeScreen';
import { prefetchHome } from '~/features/home/queries';
import { homeFilterOf, homeInput, homeTabOf, parseHomeSearch } from '~/features/home/search';
import { settleOnServer } from '~/features/tasks/prefetch';

// /w/<slug> is the workspace's Home (frames 099–106): `/` lands here after signing in. The tab and the
// filter are in the search (?tab=everyone&project=PAY&label=backend&priority=urgent).
export const Route = createFileRoute('/_app/w/$workspace/')({
  validateSearch: parseHomeSearch,
  loaderDeps: ({ search }) => ({ input: homeInput(homeTabOf(search), homeFilterOf({ ...search })) }),
  loader: ({ context, deps }) => settleOnServer(prefetchHome(context.api, context.queryClient, deps.input)),
  head: () => ({ meta: [{ title: 'Home · Zamu' }] }),
  component: HomeRoute,
});

function HomeRoute() {
  return <HomeScreen search={Route.useSearch()} />;
}
