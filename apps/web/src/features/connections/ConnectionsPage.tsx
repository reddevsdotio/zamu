// /settings/connections: the workspace's git connections (frames 1a to 1j). Owners and admins add,
// edit, test and delete them; members see the list without actions. Tokens never come back.

import { useQuery } from '@tanstack/react-query';
import type { GitConnection, GitConnectionList } from '@zamu/contracts';
import { type ReactNode, useState } from 'react';
import { Link } from 'react-aria-components';
import { useNow } from '~/features/tasks/clock';
import { useApi, useWorkspaceSlug } from '~/lib/workspace';
import { workspacePath } from '~/lib/workspace-paths';
import {
  Banner,
  Button,
  ConnectionStatusTag,
  Menu,
  MenuItem,
  MenuTrigger,
  PageHeader,
  PROVIDER_LABELS,
  ProviderBadge,
  Skeleton,
} from '~/ui';
import { isAdminRole } from '../settings/format';
import { errorMessage } from '../settings/result';
import { meQuery } from '../tasks/queries';
import { ConnectionDialog, type ConnectionDialogTarget, type ConnectionSave } from './ConnectionDialog';
import { DeleteConnectionDialog, ProjectKeyChip } from './DeleteConnectionDialog';
import { type ConnectionsState, checkedText, connectionsSubtitle } from './format';
import {
  connectionsQuery,
  useCreateConnection,
  useDeleteConnection,
  useTestConnection,
  useUpdateConnection,
} from './queries';

export const ENCRYPTION_KEY_MISSING = 'Set APP_ENCRYPTION_KEY on the server to add connections.';

export function ConnectionsPage() {
  const api = useApi();
  const me = useQuery(meQuery(api));
  const list = useQuery(connectionsQuery(api));
  const canManage = isAdminRole(me.data?.role);
  const [dialog, setDialog] = useState<ConnectionDialogTarget | null>(null);
  const [deleting, setDeleting] = useState<GitConnection | null>(null);
  const [actionError, setActionError] = useState<string | null>(null);

  const create = useCreateConnection();
  const update = useUpdateConnection();
  const remove = useDeleteConnection();
  const test = useTestConnection();

  const onSave = (input: ConnectionSave) => {
    if (input.kind === 'add') {
      const { kind: _kind, ...values } = input;
      return create.mutateAsync(values);
    }
    const { kind: _kind, ...values } = input;
    return update.mutateAsync(values);
  };

  const onTestAgain = (connection: GitConnection) => {
    setActionError(null);
    test.mutate({ id: connection.id }, { onError: (error) => setActionError(errorMessage(error)) });
  };

  return (
    <ConnectionsView
      list={list.data}
      isLoading={list.isPending}
      error={list.error ? errorMessage(list.error) : null}
      onRetry={() => void list.refetch()}
      canManage={canManage}
      actionError={actionError}
      onDismissError={() => setActionError(null)}
      onAdd={() => setDialog({ kind: 'add' })}
      onEdit={(connection) => setDialog({ kind: 'edit', connection })}
      onDelete={setDeleting}
      onTestAgain={onTestAgain}
      testingId={test.isPending && test.variables && 'id' in test.variables ? test.variables.id : null}
    >
      <ConnectionDialog
        target={dialog}
        onClose={() => setDialog(null)}
        onTest={(input) => test.mutateAsync(input)}
        onSave={onSave}
      />
      <DeleteConnectionDialog
        connection={deleting}
        onClose={() => setDeleting(null)}
        onDelete={(connection) => remove.mutateAsync({ id: connection.id })}
      />
    </ConnectionsView>
  );
}

export interface ConnectionsViewProps {
  list: GitConnectionList | undefined;
  isLoading: boolean;
  /** Message of a failed load. */
  error: string | null;
  onRetry: () => void;
  /** Owners and admins. */
  canManage: boolean;
  actionError?: string | null;
  onDismissError?: () => void;
  onAdd: () => void;
  onEdit: (connection: GitConnection) => void;
  onDelete: (connection: GitConnection) => void;
  onTestAgain: (connection: GitConnection) => void;
  /** Connection whose saved token is being tested from the row menu. */
  testingId?: string | null;
  /** The dialogs. */
  children?: ReactNode;
}

/** The page without data fetching, so every state can be rendered on its own. */
export function ConnectionsView({
  list,
  isLoading,
  error,
  onRetry,
  canManage,
  actionError,
  onDismissError,
  onAdd,
  onEdit,
  onDelete,
  onTestAgain,
  testingId,
  children,
}: ConnectionsViewProps) {
  const items = list?.items ?? [];
  const view: ConnectionsState = error
    ? 'error'
    : isLoading || !list
      ? 'loading'
      : items.length
        ? 'list'
        : 'empty';
  const encryptionReady = list?.encryptionReady ?? true;
  const showAdd = canManage && view !== 'empty';

  return (
    <>
      <PageHeader
        title="Git connections"
        subtitle={connectionsSubtitle(view, items.length, canManage)}
        actions={
          showAdd ? (
            <Button onPress={onAdd} isDisabled={!encryptionReady}>
              Add connection
            </Button>
          ) : null
        }
      />
      <div className="min-h-0 flex-1 overflow-auto">
        {!encryptionReady && view !== 'error' ? (
          <div className="px-6 pt-5">
            <Banner>{ENCRYPTION_KEY_MISSING}</Banner>
          </div>
        ) : null}
        {actionError ? (
          <div className="px-6 pt-5">
            <Banner
              action={
                <Button variant="secondary" size="sm" onPress={onDismissError}>
                  Dismiss
                </Button>
              }
            >
              {actionError}
            </Banner>
          </div>
        ) : null}
        {view === 'error' ? (
          <div className="px-6 py-5">
            <Banner
              action={
                <Button variant="secondary" size="sm" onPress={onRetry}>
                  Try again
                </Button>
              }
            >
              Couldn't load connections. {error}
            </Banner>
          </div>
        ) : view === 'empty' ? (
          <EmptyConnections canManage={canManage} canAdd={encryptionReady} onAdd={onAdd} />
        ) : (
          <ConnectionsTable
            items={items}
            isLoading={view === 'loading'}
            canManage={canManage}
            onEdit={onEdit}
            onDelete={onDelete}
            onTestAgain={onTestAgain}
            testingId={testingId ?? null}
          />
        )}
        {view === 'list' && !canManage ? (
          <p className="m-0 max-w-190 px-6 pt-4 text-sm leading-normal text-fg-2">
            Only owners and admins can add, change or delete connections. Tokens are never shown, to anyone,
            after they are saved.
          </p>
        ) : null}
      </div>
      {children}
    </>
  );
}

function EmptyConnections({
  canManage,
  canAdd,
  onAdd,
}: {
  canManage: boolean;
  canAdd: boolean;
  onAdd: () => void;
}) {
  return (
    <div className="px-12 py-14">
      <div className="flex max-w-120 flex-col items-start gap-3">
        <h2 className="m-0 text-lg leading-tight font-semibold tracking-[-0.01em]">No git connections yet</h2>
        <p className="m-0 leading-normal text-fg-2">
          A connection lets projects read files from GitHub, GitLab or a Gitea/Forgejo server with an access
          token. Projects use it to mirror or import a Backlog.md folder. One connection can serve every
          project on the same account.
        </p>
        <p className="m-0 text-sm leading-normal text-fg-3">
          The token only needs read access. You add webhooks yourself, so the app never asks for admin rights.
        </p>
        {canManage ? (
          <Button onPress={onAdd} isDisabled={!canAdd}>
            Add connection
          </Button>
        ) : (
          <p className="m-0 text-sm text-fg-2">Ask an owner or admin to add one.</p>
        )}
      </div>
    </div>
  );
}

const th = 'h-7 border-b border-line p-0 text-left align-middle';
const td = 'h-14 border-b border-line-soft p-0 align-middle';

function ConnectionsTable({
  items,
  isLoading,
  canManage,
  onEdit,
  onDelete,
  onTestAgain,
  testingId,
}: {
  items: GitConnection[];
  isLoading: boolean;
  canManage: boolean;
  onEdit: (connection: GitConnection) => void;
  onDelete: (connection: GitConnection) => void;
  onTestAgain: (connection: GitConnection) => void;
  testingId: string | null;
}) {
  const workspace = useWorkspaceSlug();
  const now = useNow();
  // Column widths of frame 1a; the 24px page gutter is the first and last cell's padding.
  const gutter = 'first:pl-6 last:pr-6';
  return (
    <table
      aria-label="Git connections"
      aria-busy={isLoading || undefined}
      className="mt-2 w-full table-fixed border-separate border-spacing-0"
    >
      <colgroup>
        <col />
        <col className="w-33" />
        <col className="w-40.5" />
        <col className="w-27" />
        <col className="w-50.5" />
        {canManage ? <col className="w-32" /> : null}
      </colgroup>
      <thead>
        <tr className="text-xs font-medium text-fg-3">
          <th className={`${th} ${gutter}`}>Connection</th>
          <th className={th}>Provider</th>
          <th className={th}>Status</th>
          <th className={th}>Checked</th>
          <th className={`${th} ${gutter}`}>Used by</th>
          {canManage ? (
            <th className={`${th} ${gutter}`}>
              <span className="sr-only">Actions</span>
            </th>
          ) : null}
        </tr>
      </thead>
      <tbody>
        {isLoading
          ? [150, 120, 170, 140].map((width) => (
              <tr key={width}>
                <td className={`${td} ${gutter}`}>
                  <span className="flex items-center gap-2.5">
                    <Skeleton width={26} height={26} />
                    <Skeleton width={width} />
                  </span>
                </td>
                <td className={td}>
                  <Skeleton width={60} />
                </td>
                <td className={td}>
                  <Skeleton width={80} />
                </td>
                <td className={td}>
                  <Skeleton width={40} />
                </td>
                <td className={`${td} ${gutter}`}>
                  <Skeleton width={110} />
                </td>
                {canManage ? <td className={`${td} ${gutter}`} /> : null}
              </tr>
            ))
          : items.map((connection) => (
              <tr key={connection.id}>
                <td className={`${td} ${gutter}`}>
                  <span className="flex min-w-0 items-center gap-2.5 pr-3">
                    <ProviderBadge provider={connection.provider} decorative />
                    <span className="min-w-0">
                      <span className="block truncate font-semibold">{connection.name}</span>
                      <span className="block truncate font-mono text-xs text-fg-3">{connection.host}</span>
                    </span>
                  </span>
                </td>
                <td className={`${td} text-fg-2`}>{PROVIDER_LABELS[connection.provider]}</td>
                <td className={td}>
                  {testingId === connection.id ? (
                    <span className="text-sm text-fg-2">Testing…</span>
                  ) : (
                    <ConnectionStatusTag status={connection.status} />
                  )}
                </td>
                <td className={`${td} tabular-nums text-xs text-fg-3`}>
                  {connection.checkedAt && now !== null ? checkedText(connection.checkedAt, now) : ''}
                </td>
                <td className={`${td} ${gutter}`}>
                  <span className="flex flex-wrap items-center gap-1 text-sm text-fg-2">
                    {connection.usedBy.length ? (
                      <>
                        {connection.usedBy.map((project) => (
                          <Link
                            key={project.key}
                            href={workspacePath(
                              workspace,
                              `/p/${encodeURIComponent(project.key)}/settings/backlog`,
                            )}
                            aria-label={`${project.name} (${project.key})`}
                            className="outline-none focus-visible:focus-ring"
                          >
                            <ProjectKeyChip projectKey={project.key} />
                          </Link>
                        ))}
                        {connection.usedBy.some((project) => project.paused) ? (
                          <span className="text-xs text-danger">mirror paused</span>
                        ) : null}
                      </>
                    ) : (
                      <span className="text-fg-3">No projects</span>
                    )}
                  </span>
                </td>
                {canManage ? (
                  <td className={`${td} ${gutter}`}>
                    <span className="flex justify-end gap-1.5">
                      <Button variant="secondary" size="sm" onPress={() => onEdit(connection)}>
                        Edit
                      </Button>
                      <MenuTrigger>
                        <Button
                          variant="ghost"
                          size="sm"
                          iconOnly
                          aria-label={`More actions for ${connection.name}`}
                        >
                          <span aria-hidden className="text-lg leading-none">
                            ⋯
                          </span>
                        </Button>
                        <Menu
                          onAction={(key) => {
                            if (key === 'test') onTestAgain(connection);
                            if (key === 'delete') onDelete(connection);
                          }}
                        >
                          <MenuItem id="test">Test again</MenuItem>
                          <MenuItem id="delete" tone="danger">
                            Delete…
                          </MenuItem>
                        </Menu>
                      </MenuTrigger>
                    </span>
                  </td>
                ) : null}
              </tr>
            ))}
      </tbody>
    </table>
  );
}
