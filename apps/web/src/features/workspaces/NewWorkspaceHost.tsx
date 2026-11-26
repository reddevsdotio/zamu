// The New workspace dialog wired to the server: create, refresh the switcher's list, then open the new
// workspace's Home (its "new workspace" state). The shell renders it once; the switcher and the
// palette open it.
import { useRouter } from '@tanstack/react-router';
import type { CreateWorkspaceInput } from '@zamu/contracts';
import { useNewProject } from '~/features/shell/new-project';
import { asWorkspaceSlug, workspacePath } from '~/lib/workspace-paths';
import { NewWorkspaceDialog, type NewWorkspaceFailure, newWorkspaceFailure } from './NewWorkspace';
import { createWorkspace, suggestSlug, useRefreshMyWorkspaces } from './queries';

/** Creates the workspace; resolves to its slug, or to the failure to show. */
export function useCreateWorkspace(): (
  input: CreateWorkspaceInput,
) => Promise<{ slug: string } | { failure: NewWorkspaceFailure }> {
  const refresh = useRefreshMyWorkspaces();
  return async (input) => {
    try {
      const created = await createWorkspace(input);
      void refresh();
      return { slug: created.slug };
    } catch (error) {
      return { failure: newWorkspaceFailure(error) };
    }
  };
}

export function NewWorkspaceDialogHost() {
  const { isWorkspaceOpen, closeWorkspace } = useNewProject();
  const router = useRouter();
  const create = useCreateWorkspace();

  const onSubmit = async (input: CreateWorkspaceInput) => {
    const result = await create(input);
    if ('failure' in result) return result.failure;
    closeWorkspace();
    void router.navigate({ href: workspacePath(asWorkspaceSlug(result.slug)) });
    return null;
  };

  return (
    <NewWorkspaceDialog
      isOpen={isWorkspaceOpen}
      onClose={closeWorkspace}
      onSubmit={onSubmit}
      suggestSlug={suggestSlug}
    />
  );
}
