import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { useRouter } from '@tanstack/react-router';
import type { CreateProjectFromBacklogInput } from '@zamu/contracts';
import { createProjectFromBacklogFn, detectBacklogRepositoryFn } from '~/features/backlog/server';
import {
  type DetectRepository,
  NewFromBacklogDialog,
  newFromBacklogFailure,
} from '~/features/projects/NewFromBacklogDialog';
import { unwrap } from '~/features/settings/result';
import { useApi, useWorkspaceSlug } from '~/lib/workspace';
import { connectionsQuery } from './queries';

// New project from Backlog.md wired to the server (the projects page and the setup's Mode step open it).

export interface NewFromBacklogDialogHostProps {
  isOpen: boolean;
  onClose: () => void;
  /** Defaults to reading the repository on the server (detectBacklogRepositoryFn). */
  detect?: DetectRepository;
}

/** Reads the repository on the server, in the workspace `workspace`. */
const detectOnServer =
  (workspace: string): DetectRepository =>
  (input) =>
    unwrap(detectBacklogRepositoryFn({ data: { workspace, input } }));

/** The dialog wired to the server: creates the project, then opens its setup at Mappings. */
export function NewFromBacklogDialogHost({
  isOpen,
  onClose,
  detect: detectProp,
}: NewFromBacklogDialogHostProps) {
  const workspace = useWorkspaceSlug();
  const api = useApi();
  const detect = detectProp ?? detectOnServer(workspace);
  const router = useRouter();
  const queryClient = useQueryClient();
  const connections = useQuery({ ...connectionsQuery(api), enabled: isOpen });
  const create = useMutation({
    mutationFn: (input: CreateProjectFromBacklogInput) =>
      unwrap(createProjectFromBacklogFn({ data: { workspace: api.slug, input } })),
  });

  const onSubmit = async (input: CreateProjectFromBacklogInput) => {
    let key: string;
    try {
      key = (await create.mutateAsync(input)).key;
    } catch (error) {
      return newFromBacklogFailure(error, input.key);
    }
    void queryClient.invalidateQueries({ queryKey: api.orpc.projects.key() });
    onClose();
    void router.navigate({
      to: '/w/$workspace/p/$projectKey/backlog-setup',
      params: { workspace, projectKey: key },
      search: { mode: input.mode, step: 'mappings', connection: input.connectionId },
    });
    return null;
  };

  return (
    <NewFromBacklogDialog
      isOpen={isOpen}
      onClose={onClose}
      connections={connections.data?.items}
      encryptionReady={connections.data?.encryptionReady ?? true}
      onSubmit={onSubmit}
      detect={detect}
    />
  );
}
