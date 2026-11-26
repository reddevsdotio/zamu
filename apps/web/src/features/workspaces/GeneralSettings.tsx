// Workspace settings, General (PM-39): the name and the address (owners and admins; everyone else sees
// them read-only), Leave for anyone, and the danger zone with Delete for owners. A new address keeps the
// old one working as a redirect, so links and bookmarks survive it. Laid out like the other workspace
// settings pages (page header, then a 720px column) with the project General page's form and danger
// zone (frame 127).
import { useQuery, useQueryClient } from '@tanstack/react-query';
import { useRouter } from '@tanstack/react-router';
import type { Me, UpdateWorkspaceInput, Workspace } from '@zamu/contracts';
import { useState } from 'react';
import { isAdminRole } from '~/features/settings/format';
import { meQuery } from '~/features/settings/queries';
import { errorMessage } from '~/features/settings/result';
import { useApi, useWorkspace } from '~/lib/workspace';
import { withWorkspaceSlug } from '~/lib/workspace-paths';
import { Banner, Button, PageHeader, Skeleton } from '~/ui';
import { ConfirmAction } from './ConfirmAction';
import {
  DeleteRow,
  DeleteWorkspaceDialog,
  type GeneralFailure,
  generalFailure,
  LEAVE_TEXT,
  LeaveRow,
  WorkspaceForm,
} from './GeneralParts';
import { announceWorkspace } from './notice';
import {
  deleteWorkspace,
  leaveWorkspace,
  updateWorkspace,
  useRefreshMyWorkspaces,
  workspaceContentsQuery,
} from './queries';

/** The General page wired to the server. */
export function GeneralSettings() {
  const api = useApi();
  const current = useWorkspace();
  const me = useQuery(meQuery(api));
  const queryClient = useQueryClient();
  const router = useRouter();
  const refreshMine = useRefreshMyWorkspaces();
  const [leaveOpen, setLeaveOpen] = useState(false);
  const [deleteOpen, setDeleteOpen] = useState(false);
  const contents = useQuery({ ...workspaceContentsQuery(api), enabled: deleteOpen });

  // me answers after a rename; the route holds what the page was entered with.
  const workspace = { name: me.data?.workspace.name ?? current.name, slug: current.slug };
  const role = me.data?.role;

  const leaveToLanding = () => {
    void refreshMine();
    void router.navigate({ to: '/', replace: true });
  };

  const onSave = async (changes: UpdateWorkspaceInput): Promise<GeneralFailure | null> => {
    let updated: Workspace;
    try {
      updated = await updateWorkspace(current.slug, changes);
    } catch (error) {
      return generalFailure(error);
    }
    void refreshMine();
    if (updated.slug !== current.slug) {
      announceWorkspace(`${updated.name} now lives at /w/${updated.slug}. Old links keep working.`);
      void router.navigate({
        href: withWorkspaceSlug(router.state.location.href, updated.slug),
        replace: true,
      });
      return null;
    }
    // The sidebar and this form read the name from me.
    // Not invalidated: the theme's cache reader observes the same key with a queryFn that answers null,
    // so a refetch triggered from here could blank it.
    queryClient.setQueryData(meQuery(api).queryKey, (old: Me | undefined) =>
      old ? { ...old, workspace: { ...old.workspace, name: updated.name } } : old,
    );
    return null;
  };

  return (
    <>
      <PageHeader title="General" subtitle={me.data ? workspace.name : ' '} />
      <div className="flex min-h-0 flex-1 flex-col overflow-y-auto px-10 py-7">
        <div className="flex max-w-180 flex-col gap-7">
          {me.isError ? (
            <Banner
              action={
                <Button variant="secondary" size="sm" onPress={() => void me.refetch()}>
                  Try again
                </Button>
              }
            >
              Couldn't load the workspace. {errorMessage(me.error)}
            </Banner>
          ) : !me.data ? (
            <GeneralSkeleton />
          ) : (
            <>
              <WorkspaceForm
                key={workspace.slug}
                workspace={workspace}
                canEdit={isAdminRole(role)}
                onSubmit={onSave}
              />
              <LeaveRow name={workspace.name} onLeave={() => setLeaveOpen(true)} />
              {role === 'owner' ? (
                <DeleteRow name={workspace.name} onDelete={() => setDeleteOpen(true)} />
              ) : null}
            </>
          )}
        </div>
      </div>
      <ConfirmAction
        isOpen={leaveOpen}
        onOpenChange={setLeaveOpen}
        title={`Leave ${workspace.name}?`}
        confirmLabel="Leave workspace"
        onConfirm={async () => {
          await leaveWorkspace(current.slug);
          announceWorkspace(`You left ${workspace.name}.`);
          leaveToLanding();
        }}
      >
        {LEAVE_TEXT}
      </ConfirmAction>
      <DeleteWorkspaceDialog
        isOpen={deleteOpen}
        onOpenChange={setDeleteOpen}
        name={workspace.name}
        slug={workspace.slug}
        contents={contents.data}
        contentsError={contents.isError ? errorMessage(contents.error) : null}
        onDelete={async (confirmSlug) => {
          await deleteWorkspace(current.slug, confirmSlug);
          announceWorkspace(`Deleted ${workspace.name}.`);
          leaveToLanding();
        }}
      />
    </>
  );
}

function GeneralSkeleton() {
  return (
    <div aria-busy className="flex flex-col gap-5.5">
      {[0, 1].map((index) => (
        <div key={index} className="flex flex-col gap-2">
          <Skeleton width={80} />
          <Skeleton height={36} />
        </div>
      ))}
    </div>
  );
}
