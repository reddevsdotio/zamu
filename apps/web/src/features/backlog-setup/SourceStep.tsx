import {
  type BacklogDetection,
  BacklogFolder,
  type GitConnection,
  PROJECT_KEY_PATTERN,
  parseRepositoryUrl,
} from '@zamu/contracts';
import { type FormEvent, useState } from 'react';
import { errorMessage } from '~/features/settings/result';
import { connectionsHref } from '~/features/shell/paths';
import { useWorkspaceSlug } from '~/lib/workspace';
import {
  Banner,
  Button,
  FactList,
  InlineCode,
  lockedHatch,
  NoticeStrip,
  type OptionItem,
  ProviderBadge,
  Select,
  SourceStatusDot,
  TextField,
} from '~/ui';
import { connectionReads } from './connections';
import { DetailBox, Mono, Question, QuietAction, TextLink } from './parts';
import { RelativeTime } from './time';

// Step 2 (frames 3d to 3h): connection, the project's repository, and what detection found.

export interface SourceStepProps {
  projectKey: string;
  projectName: string;
  repository: string | null;
  settingsHref: string;
  connections: readonly GitConnection[] | undefined;
  connectionsError: unknown;
  encryptionReady: boolean;
  connectionId: string | null;
  onConnectionChange: (id: string) => void;
  detection: BacklogDetection | undefined;
  detectionPending: boolean;
  detectionError: unknown;
  onRetryDetection: () => void;
  /** The folder typed by hand (search param), if any. */
  folder: string | undefined;
  onFolderChange: (folder: string | undefined) => void;
}

/** Example number in the key notes: "BACK-1 becomes PAY-1". */
const EXAMPLE = 1;

function connectionItems(connections: readonly GitConnection[], repositoryHost: string | null): OptionItem[] {
  return connections.map((connection) => {
    const fits = repositoryHost ? connectionReads(connection, repositoryHost) : true;
    return {
      id: connection.id,
      label: connection.name,
      prefix: <ProviderBadge provider={connection.provider} size="sm" decorative />,
      isDisabled: !fits,
      ...(fits ? {} : { description: `Reads ${connection.host}` }),
    };
  });
}

function AccessProblem({
  detection,
  connection,
  repository,
}: {
  detection: BacklogDetection;
  connection: GitConnection | undefined;
  /** The project's repository URL; detection only has the short form. */
  repository: string | null;
}) {
  const workspace = useWorkspaceSlug();
  const repo = repository ? parseRepositoryUrl(repository) : null;
  const host = repo?.host ?? detection.repository.split('/')[0] ?? detection.repository;
  const path = repo?.path ?? detection.repository;
  const name = connection?.name ?? 'This connection';
  const login = connection?.checkedLogin;
  const role =
    connection?.provider === 'gitlab'
      ? 'at least the Reporter role in the project'
      : 'read access to the repository';
  if (detection.access === 'not_found') {
    return (
      <DetailBox tone="error">
        <b className="font-semibold">{name} can't read this repository.</b> {host} answered 404 for {path}.
        Give the token's user{login ? `, ${login},` : ''} {role}, or pick another connection.
      </DetailBox>
    );
  }
  if (detection.access === 'no_access') {
    return (
      <DetailBox tone="error">
        <b className="font-semibold">
          {host} rejected the token of {name}.
        </b>{' '}
        Replace the token in <TextLink href={connectionsHref(workspace)}>Git connections</TextLink>, or pick
        another connection.
      </DetailBox>
    );
  }
  return (
    <DetailBox tone="error">
      <b className="font-semibold">{host} could not be reached.</b> Check that the host is up and reachable
      from the server, then look again.
    </DetailBox>
  );
}

function FolderField({
  initial,
  onSubmit,
  onClear,
}: {
  initial: string;
  onSubmit: (folder: string) => void;
  onClear: (() => void) | null;
}) {
  const [value, setValue] = useState(initial);
  const [error, setError] = useState<string | undefined>();
  const submit = (event?: FormEvent) => {
    event?.preventDefault();
    const parsed = BacklogFolder.safeParse(value);
    if (!parsed.success) {
      setError(parsed.error.issues[0]?.message ?? 'Name a folder, e.g. backlog');
      return;
    }
    setError(undefined);
    onSubmit(parsed.data);
  };
  return (
    <form noValidate onSubmit={submit} className="flex items-start gap-2">
      <TextField
        label="Folder"
        name="folder"
        mono
        autoComplete="off"
        spellCheck="false"
        placeholder="docs/backlog"
        value={value}
        onChange={(next) => {
          setValue(next);
          setError(undefined);
        }}
        description="Path from the repository root. It must hold a config.yml."
        isInvalid={Boolean(error)}
        errorMessage={error}
        validationBehavior="aria"
        className="min-w-0 flex-1"
      />
      <Button type="submit" variant="secondary" className="mt-5.75 h-9.5">
        Look again
      </Button>
      {onClear ? (
        <Button variant="ghost" className="mt-5.75 h-9.5" onPress={onClear}>
          Detect the folder
        </Button>
      ) : null}
    </form>
  );
}

function KeyNote({ detection, projectKey }: { detection: BacklogDetection; projectKey: string }) {
  const prefix = detection.config?.taskPrefix;
  if (!prefix || detection.keyMatchesPrefix) return null;
  const from = `${prefix}-${EXAMPLE}`;
  const to = `${projectKey}-${EXAMPLE}`;
  if (PROJECT_KEY_PATTERN.test(prefix)) {
    return (
      <NoticeStrip marker={<span className="w-2 text-center text-fg-3">i</span>}>
        <span>
          <Mono>{from}</Mono> becomes <Mono>{to}</Mono>. Search and <InlineCode>zamu</InlineCode> accept both.
          To keep them identical, change the project key to {prefix} in General first.
        </span>
      </NoticeStrip>
    );
  }
  const why = prefix.length > 6 ? 'is longer than a project key can be' : "doesn't fit a project key";
  return (
    <DetailBox tone="warn">
      The task prefix <Mono>{prefix}</Mono> {why} (2 to 6 letters). Tasks get the key {projectKey}:{' '}
      <Mono>{from}</Mono> becomes <Mono>{to}</Mono>. Search and <InlineCode>zamu</InlineCode> still accept{' '}
      {from}.
    </DetailBox>
  );
}

/** Subfolders in the order Backlog.md users think of them; ignored ones last. */
const FOLDER_ORDER = [
  'tasks/',
  'drafts/',
  'archive/tasks/',
  'completed/',
  'milestones/',
  'archive/milestones/',
  'archive/drafts/',
];

export function orderFolders<T extends { path: string; ignored: boolean }>(folders: readonly T[]): T[] {
  const rank = (entry: T) => {
    const index = FOLDER_ORDER.indexOf(entry.path);
    return (entry.ignored ? 100 : 0) + (index === -1 ? FOLDER_ORDER.length : index);
  };
  return [...folders].sort((a, b) => rank(a) - rank(b) || a.path.localeCompare(b.path));
}

function FolderFound({
  detection,
  onUseAnother,
}: {
  detection: BacklogDetection;
  onUseAnother: (() => void) | null;
}) {
  const config = detection.config;
  const statuses = config?.statuses.length ?? 0;
  return (
    <DetailBox
      tone="ok"
      trailing={onUseAnother ? <QuietAction onPress={onUseAnother}>Use another folder</QuietAction> : null}
    >
      <b className="font-semibold">
        Found a Backlog.md folder at <Mono>{detection.folder}/</Mono>
      </b>
      {detection.folderSource === 'config' ? (
        <span className="text-fg-2"> · set in backlog.config.yml</span>
      ) : null}
      {config ? (
        <div className="text-sm text-fg-2">
          {config.projectName ? <>Project “{config.projectName}”, task prefix </> : <>Task prefix </>}
          <Mono>{config.taskPrefix}</Mono>, {statuses} {statuses === 1 ? 'status' : 'statuses'}.
        </div>
      ) : null}
      {detection.folders.length ? (
        <div className="mt-1 flex flex-wrap gap-x-3.5 gap-y-1 font-mono text-xs text-fg-2">
          {orderFolders(detection.folders).map((entry) => (
            <span key={entry.path}>
              {entry.path} {entry.count.toLocaleString('en-US')}
              {entry.ignored ? ' · ignored' : ''}
            </span>
          ))}
        </div>
      ) : null}
    </DetailBox>
  );
}

export function SourceStep({
  projectKey,
  projectName,
  repository,
  settingsHref,
  connections,
  connectionsError,
  encryptionReady,
  connectionId,
  onConnectionChange,
  detection,
  detectionPending,
  detectionError,
  onRetryDetection,
  folder,
  onFolderChange,
}: SourceStepProps) {
  const workspace = useWorkspaceSlug();
  const [editingFolder, setEditingFolder] = useState(false);
  const repo = repository ? parseRepositoryUrl(repository) : null;
  const connection = connections?.find((item) => item.id === connectionId);
  const fitting = connections?.filter((item) => !repo || connectionReads(item, repo.host)) ?? [];
  const showFolderField =
    Boolean(detection && detection.access === 'ok' && !detection.folder) || editingFolder || Boolean(folder);

  const connectionHint = (
    <>
      Or{' '}
      <TextLink href={connectionsHref(workspace)} newTab>
        add a connection
      </TextLink>{' '}
      in a new tab; this list updates when you come back.
    </>
  );

  return (
    <>
      <Question>Where are the files?</Question>
      {!encryptionReady ? (
        <Banner>Set APP_ENCRYPTION_KEY on the server to add connections and read repositories.</Banner>
      ) : null}
      <div className="grid grid-cols-2 items-start gap-2.5">
        <Select
          label="Connection"
          items={connections ? connectionItems(connections, repo?.host ?? null) : []}
          value={connectionId}
          onChange={(key) => {
            if (key != null) onConnectionChange(String(key));
          }}
          placeholder={connections ? 'Pick a connection' : 'Loading connections…'}
          description={connectionHint}
          isDisabled={!connections?.length}
        />
        <TextField
          label="Repository"
          name="repository"
          mono
          isReadOnly
          value={repo?.short ?? repository ?? ''}
          placeholder="No repository"
          inputClassName={`${lockedHatch} text-xs`}
          description={
            <>
              From the project. Change it in <TextLink href={settingsHref}>General</TextLink>.
            </>
          }
        />
      </div>

      {connectionsError ? (
        <Banner>{errorMessage(connectionsError)}</Banner>
      ) : connections && fitting.length === 0 && repo ? (
        <DetailBox tone="error">
          <b className="font-semibold">No connection reads {repo.host} yet.</b> Add one in{' '}
          <TextLink href={connectionsHref(workspace)} newTab>
            Git connections
          </TextLink>
          , then come back to this page.
        </DetailBox>
      ) : null}

      {!repository ? (
        <DetailBox tone="error">
          <b className="font-semibold">{projectName} has no repository.</b> The setup reads the Backlog.md
          files from it. Link one in <TextLink href={settingsHref}>General</TextLink> first.
        </DetailBox>
      ) : null}

      {connectionId && repository ? (
        detectionError ? (
          <Banner
            action={
              <Button variant="secondary" size="sm" onPress={onRetryDetection}>
                Look again
              </Button>
            }
          >
            {errorMessage(detectionError)}
          </Banner>
        ) : detectionPending || !detection ? (
          <NoticeStrip marker={<SourceStatusDot state="reading" decorative />}>
            <span>Reading {repo?.short ?? repository}…</span>
          </NoticeStrip>
        ) : detection.access !== 'ok' ? (
          <>
            <AccessProblem detection={detection} connection={connection} repository={repository} />
            {detection.access === 'unreachable' ? (
              <span>
                <Button variant="secondary" size="sm" onPress={onRetryDetection}>
                  Look again
                </Button>
              </span>
            ) : null}
          </>
        ) : (
          <>
            {detection.defaultBranch ? (
              <FactList
                className="py-1"
                labelWidth={140}
                items={[
                  {
                    id: 'branch',
                    label: 'Default branch',
                    value: (
                      <span>
                        <Mono>{detection.defaultBranch}</Mono>
                        {detection.headCommit ? (
                          <span className="text-fg-3">
                            {' '}
                            · at {detection.headCommit.slice(0, 7)}
                            {detection.headCommittedAt ? (
                              <>
                                , <RelativeTime iso={detection.headCommittedAt} />
                              </>
                            ) : null}
                          </span>
                        ) : null}
                      </span>
                    ),
                  },
                ]}
              />
            ) : null}
            {detection.folder ? (
              detection.configError ? (
                <DetailBox tone="error">
                  <b className="font-semibold">
                    The config.yml in <Mono>{detection.folder}/</Mono> can't be read.
                  </b>{' '}
                  {detection.configError}
                </DetailBox>
              ) : (
                <>
                  <FolderFound
                    detection={detection}
                    onUseAnother={showFolderField ? null : () => setEditingFolder(true)}
                  />
                  <KeyNote detection={detection} projectKey={projectKey} />
                </>
              )
            ) : (
              <DetailBox tone="error">
                {folder ? (
                  <>
                    <b className="font-semibold">
                      No Backlog.md folder at <Mono>{folder}/</Mono> on {detection.defaultBranch}.
                    </b>{' '}
                    Check the path, or let the setup detect it.
                  </>
                ) : (
                  <>
                    <b className="font-semibold">No Backlog.md folder on {detection.defaultBranch}.</b> Looked
                    for <InlineCode>backlog_directory</InlineCode> in backlog.config.yml, then{' '}
                    <InlineCode>backlog/</InlineCode>, then <InlineCode>.backlog/</InlineCode>.
                  </>
                )}
              </DetailBox>
            )}
            {showFolderField ? (
              <FolderField
                key={folder ?? ''}
                initial={folder ?? ''}
                onSubmit={(value) => onFolderChange(value)}
                onClear={
                  folder
                    ? () => {
                        setEditingFolder(false);
                        onFolderChange(undefined);
                      }
                    : null
                }
              />
            ) : null}
          </>
        )
      ) : null}
    </>
  );
}
