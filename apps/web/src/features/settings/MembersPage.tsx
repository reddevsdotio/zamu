// /settings/members: people and agents with tabs, invite person, add agent, row actions. Removing a
// person who is responsible for agents here is refused; the dialog lists those agents.

import { useQuery } from '@tanstack/react-query';
import { useNavigate } from '@tanstack/react-router';
import type { Member } from '@zamu/contracts';
import { useCallback, useMemo, useState } from 'react';
import { ConfirmAction } from '~/features/workspaces/ConfirmAction';
import { useApi, useWorkspaceSlug } from '~/lib/workspace';
import { Banner, Button, copyText, PageHeader, Tab, TabList, TabPanel, Tabs } from '~/ui';
import { AgentCreation } from './CreationFlows';
import { isAdminRole, membersSummary } from './format';
import { InviteDialog } from './InviteDialog';
import { type MemberAction, MembersTable, memberRows } from './MembersTable';
import {
  invitationsQuery,
  membersQuery,
  meQuery,
  projectsQuery,
  useCancelInvitation,
  useCreateAgent,
  useCreateInvitation,
  useRemoveMember,
} from './queries';
import { errorMessage } from './result';

type TabId = 'all' | 'people' | 'agents';

export function MembersPage() {
  const workspace = useWorkspaceSlug();
  const api = useApi();
  const navigate = useNavigate();
  const me = useQuery(meQuery(api));
  const members = useQuery(membersQuery(api));
  const invitations = useQuery(invitationsQuery(api));
  const isAdmin = isAdminRole(me.data?.role);
  const projects = useQuery({ ...projectsQuery(api), enabled: isAdmin });

  const [tab, setTab] = useState<TabId>('all');
  const [inviteOpen, setInviteOpen] = useState(false);
  const [addAgentOpen, setAddAgentOpen] = useState(false);
  const [removing, setRemoving] = useState<Member | null>(null);
  const [actionError, setActionError] = useState<string | null>(null);

  const createInvitation = useCreateInvitation();
  const cancelInvitation = useCancelInvitation();
  const removeMember = useRemoveMember();
  const createAgent = useCreateAgent();

  const meId = me.data?.user.id;
  const rows = useMemo(
    () => memberRows(members.data?.items ?? [], invitations.data ?? [], meId),
    [members.data, invitations.data, meId],
  );
  const people = members.data?.items.filter((m) => m.kind === 'person') ?? [];
  const peopleCount = people.length + (invitations.data?.length ?? 0);
  const agentCount = (members.data?.items.length ?? 0) - people.length;
  const visible = {
    all: rows,
    people: rows.filter((row) => row.type === 'invitation' || row.member.kind === 'person'),
    agents: rows.filter((row) => row.type === 'member' && row.member.kind === 'agent'),
  } satisfies Record<TabId, unknown>;

  const onAction = useCallback(
    (action: MemberAction) => {
      setActionError(null);
      switch (action.type) {
        case 'manage-keys':
          void navigate({
            to: '/w/$workspace/settings/api-keys',
            params: { workspace },
            search: { owner: action.member.id },
          });
          break;
        case 'remove':
          setRemoving(action.member);
          break;
        case 'copy-link':
          if (action.invitation.link) void copyText(action.invitation.link);
          break;
        case 'cancel-invitation':
          cancelInvitation.mutate(action.invitation.id, {
            onError: (error) => setActionError(errorMessage(error)),
          });
          break;
      }
    },
    [navigate, cancelInvitation.mutate, workspace],
  );

  const loadError = members.error ?? invitations.error;
  return (
    <>
      <PageHeader
        title="Members"
        subtitle={members.data ? membersSummary(peopleCount, agentCount, me.data?.workspace.name) : ' '}
        actions={
          isAdmin ? (
            <>
              <Button variant="secondary" onPress={() => setInviteOpen(true)}>
                Invite person
              </Button>
              <Button onPress={() => setAddAgentOpen(true)}>Add agent</Button>
            </>
          ) : null
        }
      />
      <Tabs selectedKey={tab} onSelectionChange={(key) => setTab(key as TabId)} className="min-h-0 flex-1">
        <div className="flex h-9 shrink-0 items-center border-b border-line px-6">
          <TabList aria-label="Members">
            <Tab id="all" count={members.data ? rows.length : undefined}>
              All
            </Tab>
            <Tab id="people" count={members.data ? peopleCount : undefined}>
              People
            </Tab>
            <Tab id="agents" count={members.data ? agentCount : undefined}>
              Agents
            </Tab>
          </TabList>
        </div>
        {actionError ? (
          <Banner
            className="mx-6 mt-3"
            action={
              <Button variant="secondary" size="sm" onPress={() => setActionError(null)}>
                Dismiss
              </Button>
            }
          >
            {actionError}
          </Banner>
        ) : null}
        {(['all', 'people', 'agents'] as const).map((id) => (
          <TabPanel key={id} id={id} className="flex min-h-0 flex-col">
            {loadError ? (
              <div className="p-6">
                <Banner
                  action={
                    <Button
                      variant="secondary"
                      size="sm"
                      onPress={() => {
                        void members.refetch();
                        void invitations.refetch();
                      }}
                    >
                      Retry
                    </Button>
                  }
                >
                  Couldn't load members. {errorMessage(loadError)}
                </Banner>
              </div>
            ) : (
              <MembersTable
                rows={visible[id]}
                isAdmin={isAdmin}
                meId={meId}
                isLoading={members.isPending || invitations.isPending}
                onAction={onAction}
              />
            )}
          </TabPanel>
        ))}
      </Tabs>

      <InviteDialog
        isOpen={inviteOpen}
        onOpenChange={setInviteOpen}
        onSubmit={(input) => createInvitation.mutateAsync(input)}
      />
      <AgentCreation
        isOpen={addAgentOpen}
        onOpenChange={setAddAgentOpen}
        people={people}
        defaultResponsibleId={meId ?? ''}
        projects={projects.data?.items ?? []}
        onSubmit={createAgent}
      />
      <ConfirmAction
        isOpen={removing !== null}
        onOpenChange={(open) => {
          if (!open) setRemoving(null);
        }}
        title={removing ? `Remove ${removing.name}?` : 'Remove member'}
        confirmLabel="Remove"
        onConfirm={() => (removing ? removeMember.mutateAsync(removing.id) : Promise.resolve())}
        refusalHelp={() => (
          <div>
            <Button
              variant="secondary"
              size="sm"
              onPress={() => {
                setRemoving(null);
                setTab('agents');
              }}
            >
              Show agents
            </Button>
          </div>
        )}
      >
        {removing?.kind === 'agent'
          ? 'The agent loses access to this workspace and its API keys stop working. Its tasks and activity stay.'
          : `${removing?.name ?? 'This person'} loses access to ${me.data?.workspace.name ?? 'this workspace'}. Their tasks and activity stay.`}
      </ConfirmAction>
    </>
  );
}
