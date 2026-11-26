// /settings/api-keys (every key in the workspace, admins; or one agent's keys via ?owner=) and
// /settings/my-keys (your own keys). New key, then the reveal-once dialog; Revoke with confirmation.

import { useQuery } from '@tanstack/react-query';
import { Link } from '@tanstack/react-router';
import type { ApiKeySummary } from '@zamu/contracts';
import { useCallback, useState } from 'react';
import { useApi, useWorkspaceSlug } from '~/lib/workspace';
import { Banner, Button, EmptyState, FilterBar, MemberLabel, PageHeader } from '~/ui';
import { ConfirmDialog } from './ConfirmDialog';
import { KeyCreation } from './CreationFlows';
import { isAdminRole } from './format';
import { KeysTable } from './KeysTable';
import {
  apiKeysQuery,
  membersQuery,
  meQuery,
  projectsQuery,
  useCreateApiKey,
  useRevokeApiKey,
} from './queries';
import { errorMessage, SettingsError } from './result';

export interface KeysPageProps {
  /** `workspace`: /settings/api-keys. `mine`: /settings/my-keys. */
  mode: 'workspace' | 'mine';
  /** Workspace mode only: list the keys of this member (Manage keys on an agent). */
  ownerId?: string;
}

const SUBTITLES = {
  workspace: 'Keys let agents and the zamu CLI act in this workspace. Each key belongs to one member.',
  mine: 'Keys that act as you, for the zamu CLI and your scripts. Agents get their own keys.',
};

function revokeText(key: ApiKeySummary): string {
  const who = key.owner.kind === 'agent' ? key.owner.name : 'anything using it';
  return `"${key.name}" stops working right away, and ${who} gets errors until it has a new key. You can't undo this.`;
}

export function KeysPage({ mode, ownerId }: KeysPageProps) {
  const workspace = useWorkspaceSlug();
  const api = useApi();
  const me = useQuery(meQuery(api));
  const members = useQuery(membersQuery(api));
  const projects = useQuery(projectsQuery(api));
  const owner = mode === 'mine' ? 'me' : (ownerId ?? 'all');
  const isAdmin = isAdminRole(me.data?.role);
  // Only admins list every key; the server refuses it too, this just skips the round trip.
  const adminOnly = owner === 'all' && me.data !== undefined && !isAdmin;
  const keys = useQuery({ ...apiKeysQuery(api, owner), enabled: !adminOnly });

  const [newKeyOpen, setNewKeyOpen] = useState(false);
  const [revoking, setRevoking] = useState<ApiKeySummary | null>(null);
  const createKey = useCreateApiKey();
  const revokeKey = useRevokeApiKey();

  const ownerMember = ownerId ? members.data?.items.find((member) => member.id === ownerId) : undefined;
  const agent = ownerMember?.kind === 'agent' ? ownerMember : undefined;
  const showOwner = mode === 'workspace' && !ownerId;
  const forbidden = adminOnly || (keys.error instanceof SettingsError && keys.error.code === 'FORBIDDEN');
  // Keys for yourself, or for the agent being managed. Admins never create keys for other people.
  const canCreate = mode === 'mine' || !ownerId || agent !== undefined || ownerId === me.data?.user.id;

  const onRevoke = useCallback((key: ApiKeySummary) => setRevoking(key), []);

  const empty = () => (
    <div className="px-6 py-8">
      <EmptyState
        title={
          mode === 'mine' ? 'You have no API keys' : agent ? `${agent.name} has no keys` : 'No API keys yet'
        }
        text={
          mode === 'mine'
            ? 'Create one to use the zamu CLI as yourself.'
            : 'Keys let agents and the zamu CLI act in this workspace.'
        }
        action={canCreate ? <Button onPress={() => setNewKeyOpen(true)}>New key</Button> : undefined}
      />
    </div>
  );

  return (
    <>
      <PageHeader
        title={mode === 'mine' ? 'Your API keys' : 'API keys'}
        subtitle={SUBTITLES[mode]}
        actions={
          canCreate && !forbidden ? <Button onPress={() => setNewKeyOpen(true)}>New key</Button> : null
        }
      />
      {ownerId ? (
        <FilterBar
          end={
            isAdmin ? (
              <Link
                to="/w/$workspace/settings/api-keys"
                params={{ workspace }}
                className="text-fg-2 outline-none hover:text-fg focus-visible:focus-ring"
              >
                Show all keys
              </Link>
            ) : undefined
          }
        >
          <span className="flex min-w-0 items-center gap-1.5">
            Keys of
            {ownerMember ? (
              <MemberLabel
                name={ownerMember.name}
                kind={ownerMember.kind}
                onBehalfOf={ownerMember.responsible?.name}
                className="font-medium text-fg"
              />
            ) : (
              <span className="text-fg">one member</span>
            )}
          </span>
        </FilterBar>
      ) : null}
      {forbidden ? (
        <div className="px-6 py-8">
          <EmptyState
            title="Only admins see every key"
            text="Your own keys, and keys of agents you are responsible for, are under Your API keys and Members."
            action={
              <Link
                to="/w/$workspace/settings/my-keys"
                params={{ workspace }}
                className="font-medium text-accent outline-none focus-visible:focus-ring"
              >
                Go to Your API keys
              </Link>
            }
          />
        </div>
      ) : keys.error ? (
        <div className="p-6">
          <Banner
            action={
              <Button variant="secondary" size="sm" onPress={() => void keys.refetch()}>
                Retry
              </Button>
            }
          >
            Couldn't load API keys. {errorMessage(keys.error)}
          </Banner>
        </div>
      ) : (
        <KeysTable
          keys={keys.data ?? []}
          showOwner={showOwner}
          isLoading={keys.isPending}
          onRevoke={onRevoke}
          renderEmptyState={empty}
        />
      )}

      <KeyCreation
        isOpen={newKeyOpen}
        onOpenChange={setNewKeyOpen}
        agent={agent ? { id: agent.id, name: agent.name } : null}
        actsFor={agent?.responsible?.name}
        projects={projects.data?.items ?? []}
        onSubmit={createKey}
      />
      <ConfirmDialog
        isOpen={revoking !== null}
        onOpenChange={(open) => {
          if (!open) setRevoking(null);
        }}
        title="Revoke key?"
        confirmLabel="Revoke"
        onConfirm={() => (revoking ? revokeKey.mutateAsync(revoking.id) : Promise.resolve())}
      >
        {revoking ? revokeText(revoking) : null}
      </ConfirmDialog>
    </>
  );
}
