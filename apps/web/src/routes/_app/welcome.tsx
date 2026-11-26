import { createFileRoute, redirect, useRouter } from '@tanstack/react-router';
import type { CreateWorkspaceInput } from '@zamu/contracts';
import { useCreateWorkspace } from '~/features/workspaces/NewWorkspaceHost';
import { suggestSlug } from '~/features/workspaces/queries';
import { listMyWorkspacesFn } from '~/features/workspaces/server';
import { WelcomeScreen } from '~/features/workspaces/Welcome';
import { useSignOut } from '~/lib/auth-client';
import { asWorkspaceSlug, workspacePath } from '~/lib/workspace-paths';

// No workspace yet: the person belongs to none (they left or deleted their last one, or were removed
// from it). Creating one opens its Home. Someone who is in a workspace goes back to `/`, which lands
// in it.
export const Route = createFileRoute('/_app/welcome')({
  loader: async () => {
    const result = await listMyWorkspacesFn();
    if (result.ok && result.data.items.length > 0) throw redirect({ to: '/', replace: true });
    return { canCreate: result.ok ? result.data.canCreate : false };
  },
  head: () => ({ meta: [{ title: 'Welcome · Zamu' }] }),
  component: WelcomeRoute,
});

function WelcomeRoute() {
  const { canCreate } = Route.useLoaderData();
  const { session } = Route.useRouteContext();
  const signOut = useSignOut();
  const router = useRouter();
  const create = useCreateWorkspace();
  const onCreate = async (input: CreateWorkspaceInput) => {
    const result = await create(input);
    if ('failure' in result) return result.failure;
    void router.navigate({ href: workspacePath(asWorkspaceSlug(result.slug)) });
    return null;
  };
  return (
    <WelcomeScreen
      canCreate={canCreate}
      user={{ name: session.user.name, email: session.user.email }}
      onSignOut={() => void signOut()}
      onCreate={onCreate}
      suggestSlug={suggestSlug}
    />
  );
}
