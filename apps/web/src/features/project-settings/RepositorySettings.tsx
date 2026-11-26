// Project settings, Repository (M7 frames 069 to 080): the repository Zamu reads pull requests from,
// its default branch and connection with Change, the close-on-merge switch, and "Pull-request events":
// whether webhook deliveries arrive, the payload URL and the secret (shown once after New secret, masked
// afterwards), the setup steps per host, and the hourly check with Check now. Zamu never writes to the
// repository, so the empty state says so. Owners and admins edit; everyone else reads. A mirrored
// project keeps close-on-merge off (the files own the status), and its Backlog.md webhook already carries
// request events when it is set up.

import { useQuery, useQueryClient } from '@tanstack/react-query';
import type { GitConnection, RepositorySettings, RepositoryWebhookSecret } from '@zamu/contracts';
import { type ReactNode, useEffect, useId, useState } from 'react';
import { Link } from 'react-aria-components';
import { useProjectSummary } from '~/features/project-header';
import { connectionsHref } from '~/features/shell/paths';
import { useNow } from '~/features/tasks/clock';
import { useApi, useWorkspaceSlug } from '~/lib/workspace';
import {
  Banner,
  Button,
  CONNECTION_STATUS_LABELS,
  ConfirmDialog,
  CopyField,
  HostSteps,
  InlineCode,
  ProviderBadge,
  ReadOnlyNote,
  Skeleton,
  Switch,
  WebhookStatusLine,
} from '~/ui';
import { connectionsQuery } from '../connections/queries';
import { projectSettingsHref, SettingsPage } from './ProjectSettingsLayout';
import { repositorySettingsQuery } from './queries';
import { type RepositoryChanges, RepositoryDialog } from './RepositoryDialog';
import {
  agoLong,
  closeOnMergeText,
  MIRRORED_CLOSE_TEXT,
  repositoryFailure,
  repositoryShort,
  syncText,
  webhookStatus,
} from './repository';

export const REPOSITORY_DESCRIPTION =
  'Links pull requests to tasks and moves tasks when a request opens or merges.';

/** How long the page polls after Check now for the check to finish. */
const CHECK_POLL_MS = 3_000;
const CHECK_POLL_LIMIT_MS = 60_000;

/** The Repository page wired to the API. */
export function RepositorySettingsPage({ projectKey }: { projectKey: string }) {
  const api = useApi();
  const queryClient = useQueryClient();
  const project = useProjectSummary(projectKey);
  const [checkSince, setCheckSince] = useState<number | null>(null);
  const settingsQuery = repositorySettingsQuery(api, projectKey);
  const settings = useQuery({
    ...settingsQuery,
    refetchInterval: checkSince !== null ? CHECK_POLL_MS : false,
  }).data;
  const connections = useQuery({ ...connectionsQuery(api), enabled: settings?.canEdit === true }).data;

  // Check now polls until the check reports back, for a minute at most.
  const lastCheck = settings?.sync.lastAt ?? null;
  useEffect(() => {
    if (checkSince === null) return;
    if (lastCheck && Date.parse(lastCheck) >= checkSince) {
      setCheckSince(null);
      return;
    }
    const stop = setTimeout(() => setCheckSince(null), CHECK_POLL_LIMIT_MS);
    return () => clearTimeout(stop);
  }, [checkSince, lastCheck]);

  const put = (next: RepositorySettings) => queryClient.setQueryData(settingsQuery.queryKey, next);

  return (
    <RepositoryView
      projectKey={projectKey}
      settings={settings}
      repository={project?.repository}
      locked={project?.locked?.includes('repository') ?? false}
      connections={connections?.items}
      checkPending={checkSince !== null}
      onCloseOnMergeChange={async (closeOnMerge) =>
        put(await api.client.repository.update({ project: projectKey, closeOnMerge }))
      }
      onNewSecret={async () => {
        const issued = await api.client.repository.newWebhookSecret({ project: projectKey });
        await queryClient.invalidateQueries({ queryKey: settingsQuery.queryKey });
        return issued;
      }}
      onCheckNow={async () => {
        const since = Date.now();
        await api.client.repository.sync({ project: projectKey });
        setCheckSince(since);
      }}
      onSave={async ({ repository, connectionId }) => {
        let next = settings;
        if (repository !== undefined) {
          await api.client.projects.update({ project: projectKey, repository });
          // The rail, General and the task views read the project's repository; requests of the old
          // repository leave the tasks.
          void queryClient.invalidateQueries({ queryKey: api.orpc.projects.key() });
          void queryClient.invalidateQueries({ queryKey: api.orpc.tasks.key() });
          next = await api.client.repository.get({ project: projectKey });
        }
        if (connectionId !== (next?.connection?.id ?? null)) {
          next = await api.client.repository.update({ project: projectKey, connectionId });
        }
        if (next) put(next);
      }}
    />
  );
}

export interface RepositoryViewProps {
  projectKey: string;
  /** undefined while loading. */
  settings: RepositorySettings | undefined;
  /** The project's repository from the project list, shown while the settings load. */
  repository?: string | null;
  /** The URL belongs to the Backlog.md mirror. */
  locked?: boolean;
  /** The workspace's connections, for the Change dialog; undefined while they load. */
  connections?: readonly GitConnection[];
  /** A check is queued and the page waits for it. */
  checkPending?: boolean;
  onCloseOnMergeChange: (closeOnMerge: boolean) => Promise<unknown>;
  /** Issues a new secret; the page shows it once. */
  onNewSecret: () => Promise<RepositoryWebhookSecret>;
  onCheckNow: () => Promise<unknown>;
  onSave: (changes: RepositoryChanges) => Promise<unknown>;
}

export function RepositoryView({
  projectKey,
  settings,
  repository,
  locked = false,
  connections,
  checkPending = false,
  onCloseOnMergeChange,
  onNewSecret,
  onCheckNow,
  onSave,
}: RepositoryViewProps) {
  const workspace = useWorkspaceSlug();
  const [changeOpen, setChangeOpen] = useState(false);
  const [failure, setFailure] = useState<string | null>(null);

  const run = async (action: () => Promise<unknown>) => {
    setFailure(null);
    try {
      await action();
    } catch (error) {
      setFailure(repositoryFailure(error));
    }
  };

  const canEdit = settings?.canEdit ?? false;
  const current = settings ? settings.repository : repository;
  const failureBanner = failure ? (
    <Banner
      action={
        <Button variant="secondary" size="sm" onPress={() => setFailure(null)}>
          Dismiss
        </Button>
      }
    >
      {failure}
    </Banner>
  ) : null;

  const dialog = settings ? (
    <RepositoryDialog
      isOpen={changeOpen}
      onOpenChange={setChangeOpen}
      repository={settings.repository}
      connectionId={settings.connection?.id ?? null}
      locked={locked && settings.repository !== null}
      connections={connections}
      connectionsHref={connectionsHref(workspace)}
      onSave={onSave}
    />
  ) : null;

  if (current === null) {
    return (
      <SettingsPage title="Repository" description={REPOSITORY_DESCRIPTION}>
        {failureBanner}
        <div className="flex flex-col gap-3">
          <div className="rounded-lg border border-line-soft bg-surface">
            <EmptyRepository
              action={canEdit ? <Button onPress={() => setChangeOpen(true)}>Link a repository</Button> : null}
            />
          </div>
          <p className="m-0 text-xs text-fg-2">
            An agent links it for you when it runs <InlineCode>zamu link</InlineCode> in a clone.
            {settings && !canEdit ? ' Owners and admins can link it here.' : null}
          </p>
        </div>
        {dialog}
      </SettingsPage>
    );
  }

  return (
    <SettingsPage title="Repository" description={REPOSITORY_DESCRIPTION}>
      {settings && !canEdit ? (
        <ReadOnlyNote>
          You can read this page. Owners and admins change the repository, closing on merge and the webhook.
        </ReadOnlyNote>
      ) : null}
      {failureBanner}
      <RepositoryFacts
        settings={settings}
        repository={current}
        onChange={canEdit ? () => setChangeOpen(true) : undefined}
      />
      <hr className="m-0 border-0 border-t border-line-soft" />
      <CloseOnMerge settings={settings} onChange={(next) => run(() => onCloseOnMergeChange(next))} />
      <hr className="m-0 border-0 border-t border-line-soft" />
      <section aria-labelledby="pull-request-events" className="flex flex-col gap-3">
        <h3 id="pull-request-events" className="m-0 text-md font-semibold text-fg">
          Pull-request events
        </h3>
        {settings ? (
          <PullRequestEvents
            // A new repository starts the webhook over, and with it the secret shown once.
            key={settings.webhook?.url ?? 'none'}
            projectKey={projectKey}
            settings={settings}
            checkPending={checkPending}
            onNewSecret={onNewSecret}
            onCheckNow={() => run(onCheckNow)}
            onChange={() => setChangeOpen(true)}
            onFailure={setFailure}
          />
        ) : (
          <WebhookStatusLine status="loading" />
        )}
      </section>
      {dialog}
    </SettingsPage>
  );
}

/** No repository yet (frame 069): what linking does, and what Zamu never does. */
function EmptyRepository({ action }: { action: ReactNode }) {
  return (
    <div className="mx-auto flex max-w-100 flex-col items-center gap-2 px-5 py-8.5 text-center">
      <h3 className="m-0 font-serif text-xl font-medium text-fg">No repository linked</h3>
      <p className="m-0 leading-normal text-pretty text-fg-2">
        Link the repository this project’s code lives in. Zamu only reads from it: it never comments, commits
        or changes a request.
      </p>
      {action ? <div className="mt-1.5">{action}</div> : null}
    </div>
  );
}

/** Repository, default branch and connection rows (frame 070's .kv), with Change. */
function RepositoryFacts({
  settings,
  repository,
  onChange,
}: {
  settings: RepositorySettings | undefined;
  repository: string | undefined;
  onChange?: () => void;
}) {
  const label = 'text-sm text-fg-2';
  return (
    <dl className="m-0 grid grid-cols-[164px_minmax(0,1fr)] items-baseline gap-x-0 gap-y-2.5">
      <dt className={label}>Repository</dt>
      <dd className="m-0 flex min-w-0 items-center gap-2">
        {settings?.provider ? <ProviderBadge provider={settings.provider} size="sm" decorative /> : null}
        {repository ? (
          <code className="min-w-0 truncate font-mono text-sm text-fg" title={repository}>
            {repositoryShort(repository)}
          </code>
        ) : (
          <Skeleton width={220} />
        )}
        <span className="flex-1" />
        {onChange ? (
          <Button variant="secondary" size="sm" onPress={onChange}>
            Change
          </Button>
        ) : null}
      </dd>
      <dt className={label}>Default branch</dt>
      <dd className="m-0 flex min-w-0 items-baseline gap-2 text-sm">
        {!settings ? (
          <Skeleton width={160} />
        ) : settings.defaultBranch ? (
          <>
            <code className="font-mono text-sm text-fg">{settings.defaultBranch}</code>
            <span className="text-fg-2">
              {settings.mirrored
                ? 'The branch requests merge into.'
                : 'Only merges into this branch close tasks.'}
            </span>
          </>
        ) : (
          <span className="text-fg-2">Known after the first check.</span>
        )}
      </dd>
      <dt className={label}>Connection</dt>
      <dd className="m-0 min-w-0 text-sm">
        {!settings ? (
          <Skeleton width={180} />
        ) : settings.connection ? (
          <span className="text-fg">
            {settings.connection.name}
            {settings.connection.status !== 'working' ? (
              <span className="text-danger"> · {CONNECTION_STATUS_LABELS[settings.connection.status]}</span>
            ) : null}
          </span>
        ) : (
          <span className="text-fg-2">None: Zamu reads it as a public repository, without a token.</span>
        )}
      </dd>
    </dl>
  );
}

/** The close-on-merge switch (frames 071, 073); off and locked while the project mirrors Backlog.md. */
function CloseOnMerge({
  settings,
  onChange,
}: {
  settings: RepositorySettings | undefined;
  onChange: (next: boolean) => Promise<void>;
}) {
  const descriptionId = useId();
  const [pending, setPending] = useState<boolean | null>(null);
  const on = pending ?? settings?.closeOnMerge ?? true;
  const text = !settings
    ? closeOnMergeText(true, null)
    : settings.mirrored
      ? MIRRORED_CLOSE_TEXT
      : closeOnMergeText(on, settings.defaultBranch);
  return (
    <div className="flex flex-col gap-1">
      <Switch
        isSelected={on}
        isDisabled={!settings?.canEdit || settings.mirrored || pending !== null}
        aria-describedby={descriptionId}
        onChange={async (next) => {
          setPending(next);
          try {
            await onChange(next);
          } finally {
            setPending(null);
          }
        }}
        className="items-start gap-3.5 text-md font-semibold text-fg"
      >
        Close tasks when their pull request merges
      </Switch>
      <p id={descriptionId} className="m-0 max-w-170 pl-11 text-sm leading-prose text-pretty text-fg-2">
        {text}
      </p>
    </div>
  );
}

/** The webhook part (frames 070 to 072, 074) and the hourly check. */
function PullRequestEvents({
  projectKey,
  settings,
  checkPending,
  onNewSecret,
  onCheckNow,
  onChange,
  onFailure,
}: {
  projectKey: string;
  settings: RepositorySettings;
  checkPending: boolean;
  onNewSecret: () => Promise<RepositoryWebhookSecret>;
  onCheckNow: () => Promise<void>;
  onChange: () => void;
  onFailure: (message: string) => void;
}) {
  const workspace = useWorkspaceSlug();
  const now = useNow();
  const [stepsOpen, setStepsOpen] = useState(false);
  const [issued, setIssued] = useState<string | null>(null);
  const [confirmOpen, setConfirmOpen] = useState(false);
  const [issuing, setIssuing] = useState(false);
  const [checking, setChecking] = useState(false);
  const { webhook, sync, canEdit } = settings;
  const status = webhookStatus(settings);
  const covered = webhook?.coveredByBacklog ?? false;
  const host = settings.provider ?? undefined;
  const showSetup = !covered && (status !== 'ok' || stepsOpen || issued !== null);

  const issue = async () => {
    const result = await onNewSecret();
    setIssued(result.secret);
  };
  const onNewSecretPress = async () => {
    if (webhook?.secretSet) {
      setConfirmOpen(true);
      return;
    }
    setIssuing(true);
    try {
      await issue();
    } catch (error) {
      onFailure(repositoryFailure(error));
    } finally {
      setIssuing(false);
    }
  };

  const syncLine = (
    <div className="flex flex-wrap items-center gap-x-3 gap-y-1.5">
      <p className="m-0 min-w-0 flex-1 text-xs text-fg-2">
        {now !== null ? syncText(sync, now) : 'Zamu checks the repository once an hour.'}
      </p>
      {canEdit ? (
        checkPending ? (
          <span role="status" className="text-xs text-fg-2">
            Checking now…
          </span>
        ) : (
          <Button
            variant="secondary"
            size="sm"
            isPending={checking}
            onPress={async () => {
              setChecking(true);
              try {
                await onCheckNow();
              } finally {
                setChecking(false);
              }
            }}
          >
            Check now
          </Button>
        )
      ) : null}
    </div>
  );

  return (
    <>
      {sync.error ? (
        <Banner
          action={
            canEdit ? (
              <Button variant="secondary" size="sm" onPress={onChange}>
                Change
              </Button>
            ) : undefined
          }
        >
          The last check failed. {sync.error.replace(/\.?$/, '.')}
        </Banner>
      ) : null}
      <WebhookStatusLine
        status={status}
        provider={host}
        when={webhook?.lastAt && now !== null ? agoLong(webhook.lastAt, now) : undefined}
        detail={
          status === 'never' && covered
            ? 'Until requests arrive through the Backlog.md webhook, Zamu checks the repository once an hour.'
            : undefined
        }
        action={
          status === 'ok' && !covered ? (
            <Button
              variant="ghost"
              size="sm"
              className="text-accent-text hover:text-accent-text hover:underline"
              aria-expanded={showSetup}
              onPress={() => setStepsOpen((open) => !open)}
            >
              {showSetup ? 'Hide steps' : 'Setup steps'}
            </Button>
          ) : undefined
        }
      />
      {covered ? (
        <p className="m-0 text-sm leading-prose text-pretty text-fg-2">
          The Backlog.md webhook already covers this project: Zamu takes pull-request events from it too, so
          no second webhook is needed. Make sure it sends pull-request events as well as pushes, in{' '}
          <Link
            href={projectSettingsHref(workspace, projectKey, 'backlog')}
            className="text-accent-text outline-none hover:underline focus-visible:focus-ring"
          >
            Backlog.md settings
          </Link>{' '}
          and on the host.
        </p>
      ) : null}
      {showSetup && webhook ? (
        <div className="flex flex-col gap-3">
          <div className="grid grid-cols-2 items-start gap-3.5 max-[1199px]:grid-cols-1">
            <CopyField label="Payload URL" value={webhook.url} />
            <div className="flex min-w-0 flex-col gap-1.5">
              <div className="flex min-w-0 items-end gap-1.5">
                {issued ? (
                  <CopyField label="Secret" value={issued} className="flex-1" />
                ) : (
                  <CopyField
                    label="Secret"
                    maskedValue={webhook.secretSet ? '••••••••••••••••••••••••' : 'None yet'}
                    className="flex-1"
                  />
                )}
                {canEdit ? (
                  <Button
                    variant="secondary"
                    className="h-8.5"
                    isPending={issuing}
                    onPress={onNewSecretPress}
                  >
                    New secret
                  </Button>
                ) : null}
              </div>
              {issued ? (
                <p role="status" className="m-0 text-xs text-fg-2">
                  Shown once. Copy it now and paste it into the webhook; it’s masked when you leave this page.
                </p>
              ) : !webhook.secretSet ? (
                <p className="m-0 text-xs text-fg-2">
                  {canEdit
                    ? 'Issue a secret, then paste it into the webhook with the payload URL.'
                    : 'Owners and admins issue the secret.'}
                </p>
              ) : !canEdit ? (
                <p className="m-0 text-xs text-fg-2">Only owners and admins can issue a new secret.</p>
              ) : null}
            </div>
          </div>
          <HostSteps key={host ?? 'github'} defaultHost={host ?? 'github'} />
          <p className="m-0 text-xs text-fg-2">
            Without a webhook Zamu still finds requests, by checking once an hour.
          </p>
        </div>
      ) : null}
      {syncLine}
      <ConfirmDialog
        isOpen={confirmOpen}
        onOpenChange={setConfirmOpen}
        title="Issue a new webhook secret?"
        confirmLabel="Issue new secret"
        onConfirm={async () => {
          try {
            await issue();
          } catch (error) {
            // The kit dialog shows the error's message.
            throw new Error(repositoryFailure(error));
          }
        }}
      >
        The current secret stops working at once. Pull-request events fail until you paste the new secret into
        the webhook on the host. Zamu still checks the repository once an hour.
      </ConfirmDialog>
    </>
  );
}
