// Project settings, Backlog.md (M3 frames 2b to 2o, on the M5 settings page and Margin components):
// not set up, mirroring, refreshing, warnings with the paged problem list, failed, paused, the member
// view and loading. Owners and admins refresh (⇧R), open the webhook setup, edit mappings in the setup
// route and switch the project to Zamu (M6 frame 031, the dialog in SwitchDialog). Once switched, or
// imported, Zamu owns the tasks: the page says since when and by whom, and offers the export command
// that writes the tasks back out as files (M6 frame 038).

import { useQuery } from '@tanstack/react-query';
import {
  type BacklogMappingsView,
  type BacklogProblem,
  type BacklogSourceStatus,
  type ProjectActivity,
  type ProjectWithCounts,
  parseRepositoryUrl,
} from '@zamu/contracts';
import { type ReactNode, useEffect, useState } from 'react';
import { Link } from 'react-aria-components';
import { isMirrored, useBacklogStatus, useProjectSummary, useRefreshNow } from '~/features/project-header';
import { isAdminRole } from '~/features/settings/format';
import { errorMessage } from '~/features/settings/result';
import { useNow } from '~/features/tasks/clock';
import { meQuery } from '~/features/tasks/queries';
import { useApi, useWorkspaceSlug } from '~/lib/workspace';
import { type WorkspaceUrlSlug, workspacePath } from '~/lib/workspace-paths';
import {
  Banner,
  Button,
  buttonStyles,
  CheckGlyph,
  CodeBlock,
  ConnectionStatusTag,
  type Fact,
  FactList,
  InlineCode,
  Kbd,
  MappingRow,
  MappingTable,
  NoticeStrip,
  type OptionItem,
  PRIORITIES,
  PRIORITY_LABELS,
  PriorityGlyph,
  ProblemList,
  ProblemRow,
  ProviderBadge,
  Skeleton,
  SourceStatusDot,
  STATUS_LABELS,
  StatusSquare,
  SystemActorDot,
  TASK_STATUSES,
  Tab,
  TabList,
  TabPanel,
  Tabs,
  useHotkeys,
} from '~/ui';
import {
  contentsText,
  dateText,
  failedBanner,
  isDetached,
  modeText,
  nextCheckText,
  pausedBanner,
  problemCount,
  problemRow,
  readText,
  shortCommit,
  sourceDot,
  stampText,
  statusHeading,
  webhookText,
} from './format';
import { SettingsPage } from './ProjectSettingsLayout';
import { checkSwitch, hasTasksQuery, loadProblemPage, useSetConnection, useSwitchToZamu } from './queries';
import { SwitchDialog } from './SwitchDialog';
import { exportCommand } from './switch';
import { UseConnectionDialog } from './UseConnectionDialog';
import { WebhookDialog } from './WebhookDialog';

/** Setup route of M3-10: `?mode=mirror|import` starts it, `?step=mappings&edit=1` edits mappings. */
export function setupHref(
  workspace: WorkspaceUrlSlug,
  projectKey: string,
  search: Record<string, string>,
): string {
  const path = `/p/${encodeURIComponent(projectKey)}/backlog-setup?${new URLSearchParams(search).toString()}`;
  return workspacePath(workspace, path);
}

/** Hidden tasks of a project in the task list. */
export function hiddenTasksHref(workspace: WorkspaceUrlSlug, projectKey: string): string {
  return workspacePath(workspace, `/p/${encodeURIComponent(projectKey)}?hidden=only`);
}

export interface BacklogSettingsProps {
  projectKey: string;
  /** The webhook dialog is a search param (`?webhook=1`) so setup can open it after the first read. */
  webhookOpen: boolean;
  onWebhookOpenChange: (isOpen: boolean) => void;
}

/**
 * The Backlog.md section. The status and Refresh now are the project header's (one cache for the
 * header button and this page); the header leaves ⇧R to this page here.
 */
export function BacklogSettings(props: BacklogSettingsProps) {
  const project = useProjectSummary(props.projectKey);
  return (
    <SettingsPage
      title="Backlog.md"
      description={pageDescription(project)}
      // Once Zamu owns the tasks the page is one column of text (frame 038); the mirror needs the width.
      className={project?.backlog && !isMirrored(project) ? undefined : 'max-w-239'}
    >
      <BacklogSettingsBody {...props} />
    </SettingsPage>
  );
}

function BacklogSettingsBody({ projectKey, webhookOpen, onWebhookOpenChange }: BacklogSettingsProps) {
  const api = useApi();
  const project = useProjectSummary(projectKey);
  const me = useQuery(meQuery(api));
  const canManage = isAdminRole(me.data?.role);
  const hasSource = Boolean(project?.backlog);
  const [switchOpen, setSwitchOpen] = useState(false);
  const [connectionOpen, setConnectionOpen] = useState(false);

  const refresh = useRefreshNow(projectKey);
  const status = useBacklogStatus(projectKey, hasSource, refresh.isRefreshing);
  const hasTasks = useQuery({
    ...hasTasksQuery(api, projectKey),
    enabled: project !== undefined && !hasSource,
  }).data;
  const switchToZamu = useSwitchToZamu(projectKey);
  const setConnection = useSetConnection(projectKey);

  const data = status.data;
  const canRefresh =
    canManage &&
    data !== undefined &&
    !refresh.isRefreshing &&
    (data.state === 'healthy' || data.state === 'warnings' || data.state === 'failed');
  const onRefresh = () => {
    if (canRefresh) refresh.refresh();
  };

  useHotkeys({ 'Shift+r': { enabled: canRefresh, handler: onRefresh } });

  if (!project) return <BacklogSkeleton />;
  if (!project.backlog) {
    return <NoSource project={project} hasTasks={hasTasks} canManage={canManage} />;
  }
  if (status.error) {
    return (
      <Banner
        action={
          <Button variant="secondary" size="sm" onPress={() => void status.refetch()}>
            Try again
          </Button>
        }
      >
        Couldn't load the Backlog.md settings. {loadErrorText(status.error)}
      </Banner>
    );
  }
  if (!data) return <BacklogSkeleton />;

  const repository = data.repository ? (parseRepositoryUrl(data.repository)?.short ?? data.repository) : null;

  return (
    <>
      <BacklogStatusView
        status={data}
        projectName={project.name}
        canManage={canManage}
        queued={refresh.isRefreshing}
        canRefresh={canRefresh}
        actionError={refresh.error}
        onDismissError={refresh.reset}
        onRefresh={onRefresh}
        onOpenWebhook={() => onWebhookOpenChange(true)}
        onSwitch={() => setSwitchOpen(true)}
        onUseAnotherConnection={() => setConnectionOpen(true)}
      />
      {canManage && !isDetached(data) ? (
        <>
          <WebhookDialog
            projectKey={projectKey}
            isOpen={webhookOpen}
            onOpenChange={onWebhookOpenChange}
            repository={repository}
            defaultBranch={data.defaultBranch}
          />
          <SwitchDialog
            isOpen={switchOpen}
            onOpenChange={setSwitchOpen}
            status={data}
            projectName={project.name}
            onCheck={() => checkSwitch(api, projectKey)}
            onSwitch={(confirmKey) => switchToZamu.mutateAsync(confirmKey)}
          />
          <UseConnectionDialog
            isOpen={connectionOpen}
            onOpenChange={setConnectionOpen}
            status={data}
            onPick={(connectionId) => setConnection.mutateAsync(connectionId)}
          />
        </>
      ) : null}
    </>
  );
}

/** The sentence under the title: none once Zamu owns the tasks (frame 038). */
function pageDescription(project: ProjectWithCounts | undefined): string | undefined {
  if (!project) return undefined;
  if (!project.backlog) {
    return 'Where this project reads its tasks from, how values map, and how it stays in step.';
  }
  if (isMirrored(project)) {
    return `${project.name} copies its tasks from the task files in a git repository. They are read-only here.`;
  }
  return undefined;
}

/** Message of a failed status load (an API error carries its own message). */
function loadErrorText(error: unknown): string {
  if (error instanceof Error && error.name !== 'TypeError' && error.message) return error.message;
  return errorMessage(error);
}

// ---------------------------------------------------------------------------
// Not set up (frame 2b)
// ---------------------------------------------------------------------------

export function NoSource({
  project,
  hasTasks,
  canManage,
}: {
  project: Pick<ProjectWithCounts, 'key' | 'repository'>;
  hasTasks: boolean | undefined;
  canManage: boolean;
}) {
  const workspace = useWorkspaceSlug();
  const repository = project.repository
    ? (parseRepositoryUrl(project.repository)?.short ?? project.repository)
    : null;
  const blocked = hasTasks === true || !repository || !canManage;
  const linkClass = (variant: 'primary' | 'secondary') =>
    buttonStyles({ variant, size: 'md', className: 'mt-1.5 self-start' });
  const action = (mode: 'mirror' | 'import', label: string, variant: 'primary' | 'secondary') =>
    blocked ? (
      <Button variant={variant} className="mt-1.5 self-start" isDisabled>
        {label}
      </Button>
    ) : (
      <Link href={setupHref(workspace, project.key, { mode })} className={linkClass(variant)}>
        {label}
      </Link>
    );

  let note: ReactNode;
  if (!repository) {
    note = 'Add the repository under General first. Works on a project with no tasks.';
  } else if (hasTasks) {
    note = (
      <>
        Repository: {repository}, from General. This project already has tasks, so it can't read Backlog.md;
        use New project from Backlog.md on the Projects page instead.
      </>
    );
  } else {
    note = <>Repository: {repository}, from General. Works on a project with no tasks.</>;
  }

  return (
    <div className="flex flex-col items-start gap-3">
      <h3 className="m-0 font-serif text-xl leading-tight font-medium text-fg">
        Bring in tasks from Backlog.md
      </h3>
      <p className="m-0 leading-prose text-fg-2">
        If the repository keeps tasks as Markdown files in a <InlineCode>backlog/</InlineCode> folder, this
        project can read them from the default branch.
      </p>
      <div className="grid w-full grid-cols-2 gap-4">
        <div className="flex flex-col items-start gap-1.5 rounded-lg border border-line-soft bg-surface p-3.5">
          <b className="font-semibold">Mirror</b>
          <span className="text-sm leading-normal text-fg-2">
            Keeps following the repository. Agents keep editing the files; the project updates on every push.
            Comments and cycles stay editable here.
          </span>
          {action('mirror', 'Set up a mirror', 'primary')}
        </div>
        <div className="flex flex-col items-start gap-1.5 rounded-lg border border-line-soft bg-surface p-3.5">
          <b className="font-semibold">Import once</b>
          <span className="text-sm leading-normal text-fg-2">
            Reads the files one time, then the project is yours to edit. Use it to move off Backlog.md.
          </span>
          {action('import', 'Import', 'secondary')}
        </div>
      </div>
      <span className="text-xs text-fg-3">{note}</span>
      {!canManage ? (
        <span className="text-xs text-fg-3">Only owners and admins can set up Backlog.md.</span>
      ) : null}
    </div>
  );
}

// ---------------------------------------------------------------------------
// A source (frames 2d to 2n)
// ---------------------------------------------------------------------------

export interface BacklogStatusViewProps {
  status: BacklogSourceStatus;
  projectName: string;
  /** Owners and admins. */
  canManage: boolean;
  /** A refresh was asked for and has not finished yet. */
  queued?: boolean;
  canRefresh: boolean;
  actionError?: string | null;
  onDismissError?: () => void;
  onRefresh: () => void;
  onOpenWebhook: () => void;
  /** Opens the switch dialog. */
  onSwitch: () => void;
  onUseAnotherConnection: () => void;
}

export function BacklogStatusView({
  status,
  projectName,
  canManage,
  queued = false,
  canRefresh,
  actionError,
  onDismissError,
  onRefresh,
  onOpenWebhook,
  onSwitch,
  onUseAnotherConnection,
}: BacklogStatusViewProps) {
  const now = useNow();
  if (isDetached(status)) return <OwnedView status={status} projectName={projectName} />;
  return (
    <MirrorView
      status={status}
      canManage={canManage}
      queued={queued}
      canRefresh={canRefresh}
      actionError={actionError}
      onDismissError={onDismissError}
      onRefresh={onRefresh}
      onOpenWebhook={onOpenWebhook}
      onSwitch={onSwitch}
      onUseAnotherConnection={onUseAnotherConnection}
      now={now}
    />
  );
}

/** A source that still follows the repository (frames 2d to 2i, and the switch card of M6 frame 031). */
function MirrorView({
  status,
  canManage,
  queued,
  canRefresh,
  actionError,
  onDismissError,
  onRefresh,
  onOpenWebhook,
  onSwitch,
  onUseAnotherConnection,
  now,
}: Omit<BacklogStatusViewProps, 'projectName'> & { queued: boolean; now: number | null }) {
  const workspace = useWorkspaceSlug();
  const reading = status.state === 'reading' || status.state === 'setup';
  const heading = statusHeading(status, now, { queued });
  const canAct = canManage;
  const showProblems = status.state !== 'failed';

  let banner: ReactNode = null;
  if (status.state === 'failed') {
    banner = (
      <Banner
        action={
          canManage ? (
            <Button variant="secondary" size="sm" onPress={onRefresh} isDisabled={!canRefresh}>
              Refresh now
            </Button>
          ) : null
        }
      >
        <span className="leading-normal">{failedBanner(status, now)}</span>
      </Banner>
    );
  } else if (status.state === 'paused') {
    banner = (
      <NeutralBanner
        action={
          canManage && status.repository ? (
            <Button variant="secondary" size="sm" onPress={onUseAnotherConnection}>
              Use another connection
            </Button>
          ) : null
        }
      >
        {pausedBanner(status, now)}
      </NeutralBanner>
    );
  } else if (!canManage) {
    banner = (
      <NeutralBanner>
        You can read this page. Owners and admins can refresh, change mappings or switch the project to Zamu.
        You can still comment on tasks and put them in cycles.
      </NeutralBanner>
    );
  }

  return (
    <>
      {actionError ? (
        <Banner
          action={
            <Button variant="secondary" size="sm" onPress={onDismissError}>
              Dismiss
            </Button>
          }
        >
          {actionError}
        </Banner>
      ) : null}
      {banner}
      <Section
        aria-label="Source"
        title={
          <>
            <SourceStatusDot state={queued && !reading ? 'reading' : sourceDot(status.state)} decorative />
            <b className="font-semibold">{heading.title}</b>
            {heading.note ? <span className="text-sm text-fg-3">{heading.note}</span> : null}
          </>
        }
        actions={
          canAct ? (
            <>
              <Kbd aria-hidden>⇧R</Kbd>
              <Button
                variant="secondary"
                size="sm"
                onPress={onRefresh}
                isDisabled={!canRefresh}
                aria-keyshortcuts="Shift+R"
              >
                {queued || reading ? 'Refreshing…' : 'Refresh now'}
              </Button>
            </>
          ) : null
        }
      >
        <FactList items={sourceFacts(workspace, status, now, { canManage, onOpenWebhook })} />
      </Section>
      {reading && status.headCommit ? (
        <NoticeStrip marker={<SourceStatusDot state="reading" decorative />}>
          <span>
            Reading commit <span className="font-mono text-xs text-fg">{shortCommit(status.headCommit)}</span>
            {status.defaultBranch ? <> at the head of {status.defaultBranch}</> : null}. Tasks update when the
            whole folder is read.
          </span>
        </NoticeStrip>
      ) : null}
      {showProblems ? <ProblemsSection status={status} /> : null}
      <MappingsSection status={status} canEdit={canAct} />
      {canAct && status.mode === 'mirror' ? (
        <SettingsSection title="Switch to Zamu">
          <div className="flex items-center gap-4 rounded-md border border-line bg-surface p-4">
            <div className="flex min-w-0 flex-1 flex-col gap-1">
              <b className="font-semibold">Make Zamu the owner of these tasks</b>
              <span className="text-sm leading-normal text-pretty text-fg-2">
                From then on tasks are edited here and through the CLI, and the files are no longer read. Task
                numbers, comments and history stay as they are. This can’t be undone.
              </span>
            </div>
            <Button variant="secondary" onPress={onSwitch}>
              Switch to Zamu…
            </Button>
          </div>
        </SettingsSection>
      ) : null}
    </>
  );
}

// ---------------------------------------------------------------------------
// Owned by Zamu (M6 frame 038): after the switch, or after an import
// ---------------------------------------------------------------------------

export function OwnedView({ status, projectName }: { status: BacklogSourceStatus; projectName: string }) {
  const now = useNow();
  const repo = status.repository ? parseRepositoryUrl(status.repository) : null;
  const who =
    status.mode === 'import'
      ? `Imported once by ${status.createdBy.name}.`
      : status.detachedBy
        ? `Switched by ${status.detachedBy.name}.`
        : null;
  return (
    <>
      <div
        role="note"
        className="flex flex-wrap items-center gap-x-2.5 gap-y-1 rounded-md bg-ok-soft px-3.5 py-3 font-medium text-ok"
      >
        <CheckGlyph />
        <span>
          Owned by Zamu
          {status.detachedAt && now !== null ? ` since ${dateText(status.detachedAt, now)}` : null}
        </span>
        <span className="flex-1" />
        <span className="text-sm font-normal text-fg-2">
          {who ? `${who} ` : null}The task files are no longer read.
        </span>
      </div>
      <SettingsSection title="Keep a copy as files">
        <p className="m-0 max-w-160 leading-prose text-pretty text-fg-2">
          This command writes {projectName} back out as Backlog.md task files, into the{' '}
          <InlineCode>backlog/</InlineCode> folder of the repository you run it in. Use it to keep a copy in
          the repository, or to leave Zamu.
        </p>
        <CodeBlock variant="command" copyLabel="Copy the export command">
          {exportCommand(status.project.key)}
        </CodeBlock>
        <p className="m-0 text-xs leading-normal text-fg-3">
          The copy is as fresh as the last time the command ran. Edits made to the exported files are not read
          back.
        </p>
      </SettingsSection>
      <SettingsSection title="Repository">
        <dl className="m-0 grid grid-cols-[150px_minmax(0,1fr)] items-center gap-x-3.5 gap-y-2">
          <dt className="text-sm text-fg-3">Still linked</dt>
          <dd className="m-0 min-w-0 font-medium">
            {repo ? (
              <Link
                href={repo.webUrl}
                target="_blank"
                rel="noreferrer"
                className={`${mono} text-fg outline-none hover:underline focus-visible:focus-ring`}
              >
                {repo.short}
              </Link>
            ) : (
              <span className="font-normal text-fg-2">
                {status.repository ?? 'None. Add it under General.'}
              </span>
            )}
          </dd>
        </dl>
      </SettingsSection>
      <HistorySection status={status} projectName={projectName} />
    </>
  );
}

/** A titled part of a settings page under a rule (screens.css .set-sec, .set-sec-t). */
function SettingsSection({ title, children }: { title: string; children: ReactNode }) {
  return (
    <section aria-label={title} className="flex flex-col gap-3 border-t border-line-soft pt-5">
      <h3 className="m-0 text-md font-semibold text-fg">{title}</h3>
      {children}
    </section>
  );
}

function NeutralBanner({ children, action }: { children: ReactNode; action?: ReactNode }) {
  return (
    <div
      role="note"
      className="flex items-center gap-2.5 rounded-md bg-bg-lane px-3 py-2.5 text-sm text-fg-2"
    >
      <SourceStatusDot state="paused" decorative />
      <div className="min-w-0 flex-1 leading-normal">{children}</div>
      {action}
    </div>
  );
}

function Section({
  title,
  actions,
  children,
  ...props
}: {
  'aria-label': string;
  title: ReactNode;
  actions?: ReactNode;
  children: ReactNode;
}) {
  return (
    <section
      aria-label={props['aria-label']}
      className="flex flex-col rounded-lg border border-line-soft bg-surface"
    >
      <div className="flex min-h-12 items-center gap-2.5 border-b border-line-soft px-4 py-2.5">
        {title}
        {actions ? <span className="ml-auto flex items-center gap-2">{actions}</span> : null}
      </div>
      <div className="flex flex-col gap-3 px-4 py-3.5">{children}</div>
    </section>
  );
}

const mono = 'font-mono text-xs';

function sourceFacts(
  workspace: WorkspaceUrlSlug,
  status: BacklogSourceStatus,
  now: number | null,
  { canManage, onOpenWebhook }: { canManage: boolean; onOpenWebhook: () => void },
): Fact[] {
  const detached = isDetached(status);
  const repo = status.repository ? parseRepositoryUrl(status.repository) : null;
  const facts: Fact[] = [{ id: 'mode', label: 'Mode', value: modeText(status) }];
  facts.push({
    id: 'repository',
    label: 'Repository',
    value: repo ? (
      <Link
        href={repo.webUrl}
        target="_blank"
        rel="noreferrer"
        className={`${mono} text-fg outline-none hover:underline focus-visible:focus-ring`}
      >
        {repo.short}
      </Link>
    ) : (
      <span className="text-fg-2">{status.repository ?? 'None. Add it under General.'}</span>
    ),
  });
  if (!detached) {
    const connection = status.connection;
    facts.push({
      id: 'connection',
      label: 'Connection',
      value: connection ? (
        <span className="flex items-center gap-2">
          <ProviderBadge provider={connection.provider} size="sm" decorative />
          {connection.name}
          {connection.status === 'rejected' || connection.status === 'unreachable' ? (
            <ConnectionStatusTag status={connection.status} withDot={false} />
          ) : null}
        </span>
      ) : (
        <span className="text-fg-2">Deleted. Pick another connection to resume.</span>
      ),
    });
  }
  facts.push({
    id: 'branch',
    label: 'Branch and folder',
    value: (
      <span>
        <span className={mono}>{status.defaultBranch ?? 'default branch'}</span>{' '}
        <span className="text-fg-3">(default branch)</span> ·{' '}
        <span className={mono}>{status.folder ? `${status.folder}/` : 'not found yet'}</span>{' '}
        <span className="text-fg-3">({status.folderOverride ? 'set by hand' : 'found automatically'})</span>
      </span>
    ),
  });
  const read = status.lastRead;
  facts.push({
    id: 'read',
    label: detached ? 'Read from' : 'Last good read',
    value:
      now === null ? (
        <Skeleton width={220} />
      ) : read ? (
        <span>
          {readText(status, now)}{' '}
          {read.commitUrl ? (
            <Link
              href={read.commitUrl}
              target="_blank"
              rel="noreferrer"
              className={`${mono} text-fg outline-none hover:underline focus-visible:focus-ring`}
            >
              {shortCommit(read.commit)}
            </Link>
          ) : (
            <span className={mono}>{shortCommit(read.commit)}</span>
          )}{' '}
          {read.commitTitle ? <span className="text-fg-3">{read.commitTitle}</span> : null}
        </span>
      ) : (
        <span className="text-fg-2">Not read yet</span>
      ),
  });
  if (!detached && status.mode === 'mirror') {
    facts.push({
      id: 'next',
      label: 'Next check',
      value: now === null ? <Skeleton width={140} /> : nextCheckText(status, now),
    });
    facts.push({
      id: 'webhook',
      label: 'Webhook',
      value: (
        <span>
          {now === null ? '' : webhookText(status.webhookLastAt, now)}
          {canManage ? (
            <>
              {' '}
              <button
                type="button"
                onClick={onOpenWebhook}
                className="cursor-pointer border-0 bg-transparent p-0 text-accent outline-none hover:underline focus-visible:focus-ring"
              >
                Setup
              </button>
            </>
          ) : null}
        </span>
      ),
    });
  }
  const hidden = status.counts.hidden;
  facts.push({
    id: 'contents',
    label: 'Contents',
    value: (
      <span>
        {contentsText(status)}
        {!detached && hidden ? (
          <>
            {' · '}
            <Link
              href={hiddenTasksHref(workspace, status.project.key)}
              className="text-fg underline decoration-line outline-none focus-visible:focus-ring"
            >
              {hidden} hidden, removed from Backlog.md
            </Link>
          </>
        ) : null}
      </span>
    ),
  });
  return facts;
}

// ---------------------------------------------------------------------------
// Problems (frame 2g)
// ---------------------------------------------------------------------------

function ProblemsSection({ status }: { status: BacklogSourceStatus }) {
  const api = useApi();
  const [more, setMore] = useState<{ items: BacklogProblem[]; cursor: string | null } | null>(null);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  // A new first page (after a refresh) starts the list over.
  const firstPage = status.problems;
  // biome-ignore lint/correctness/useExhaustiveDependencies: reset when the first page changes
  useEffect(() => setMore(null), [firstPage]);

  const items = [...firstPage.items, ...(more?.items ?? [])];
  const cursor = more ? more.cursor : firstPage.nextCursor;
  const count = problemCount(status);

  const loadMore = async () => {
    if (!cursor || loading) return;
    setLoading(true);
    setError(null);
    try {
      const page = await loadProblemPage(api, status.project.key, cursor);
      setMore((current) => ({ items: [...(current?.items ?? []), ...page.items], cursor: page.nextCursor }));
    } catch (failure) {
      setError(errorMessage(failure));
    } finally {
      setLoading(false);
    }
  };

  return (
    <section aria-label="Problems in the last refresh" className="flex flex-col gap-2">
      <div className="flex items-baseline gap-2.5">
        <h3 className="m-0 text-md font-semibold text-fg">Problems in the last refresh</h3>
        <span className="text-sm text-fg-3 tabular-nums">{count}</span>
        {count ? (
          <span className="ml-auto text-xs text-fg-3">
            Skipped files keep their last good version, if they had one.
          </span>
        ) : null}
      </div>
      {count === 0 ? (
        <NoticeStrip marker={<SourceStatusDot state="healthy" decorative />}>
          None. Every file was read and every value is mapped.
        </NoticeStrip>
      ) : (
        <>
          <ProblemList aria-label="Problems in the last refresh">
            {items.map((problem) => {
              const row = problemRow(problem);
              return (
                <ProblemRow key={`${problem.kind}:${row.file}`} severity={row.severity} file={row.file}>
                  {row.text}
                </ProblemRow>
              );
            })}
          </ProblemList>
          {error ? <Banner>Couldn't load more problems. {error}</Banner> : null}
          {cursor ? (
            <Button
              variant="secondary"
              size="sm"
              className="self-start"
              onPress={() => void loadMore()}
              isPending={loading}
            >
              Show more ({count - items.length} left)
            </Button>
          ) : null}
        </>
      )}
    </section>
  );
}

// ---------------------------------------------------------------------------
// Mappings
// ---------------------------------------------------------------------------

const STATUS_ITEMS: OptionItem[] = TASK_STATUSES.map((status) => ({
  id: status,
  label: STATUS_LABELS[status],
  prefix: <StatusSquare status={status} />,
}));

const PRIORITY_ITEMS: OptionItem[] = PRIORITIES.map((priority) => ({
  id: priority,
  label: PRIORITY_LABELS[priority],
  prefix: <PriorityGlyph priority={priority} />,
}));

const NO_ONE = '__none__';

function assigneeItems(mappings: BacklogMappingsView): OptionItem[] {
  const items = new Map<string, OptionItem>([[NO_ONE, { id: NO_ONE, label: 'No one' }]]);
  for (const row of mappings.assignee) {
    if (row.user && !items.has(row.user.id)) {
      items.set(row.user.id, {
        id: row.user.id,
        label: row.user.name,
        avatar: { name: row.user.name, kind: row.user.kind },
      });
    }
  }
  return [...items.values()];
}

function MappingsSection({ status, canEdit }: { status: BacklogSourceStatus; canEdit: boolean }) {
  const workspace = useWorkspaceSlug();
  const { mappings } = status;
  const detached = isDetached(status);
  const people = assigneeItems(mappings);
  const empty = (what: string) => (
    <p className="m-0 py-1.5 text-sm text-fg-2">No {what} seen in the files.</p>
  );
  return (
    <Section
      aria-label="Mappings"
      title={
        <>
          <b className="font-semibold">Mappings</b>
          <span className="text-sm text-fg-3">
            {detached ? 'used for the import' : 'applied on every refresh'}
          </span>
        </>
      }
      actions={
        canEdit ? (
          <Link
            href={setupHref(workspace, status.project.key, { step: 'mappings', edit: '1' })}
            className={buttonStyles({ variant: 'secondary', size: 'sm' })}
          >
            Edit mappings
          </Link>
        ) : null
      }
    >
      <Tabs defaultSelectedKey="status">
        <div className="border-b border-line-soft">
          <TabList aria-label="Mapping kind">
            <Tab id="status" count={mappings.status.length} className="h-8">
              Status
            </Tab>
            <Tab id="priority" count={mappings.priority.length} className="h-8">
              Priority
            </Tab>
            <Tab id="assignee" count={mappings.assignee.length} className="h-8">
              Assignees
            </Tab>
          </TabList>
        </div>
        <TabPanel id="status">
          {mappings.status.length ? (
            <MappingTable aria-label="Status mapping" variant="summary">
              {mappings.status.map((row) => (
                <MappingRow
                  key={row.from}
                  from={row.from}
                  items={STATUS_ITEMS}
                  value={row.to}
                  how={row.how}
                  count={row.count}
                  isReadOnly
                />
              ))}
            </MappingTable>
          ) : (
            empty('statuses')
          )}
        </TabPanel>
        <TabPanel id="priority">
          {mappings.priority.length ? (
            <MappingTable aria-label="Priority mapping" variant="summary">
              {mappings.priority.map((row) => (
                <MappingRow
                  key={row.from}
                  from={row.from}
                  items={PRIORITY_ITEMS}
                  value={row.to}
                  how={row.how}
                  count={row.count}
                  isReadOnly
                />
              ))}
            </MappingTable>
          ) : (
            empty('priorities')
          )}
        </TabPanel>
        <TabPanel id="assignee">
          {mappings.assignee.length ? (
            <MappingTable aria-label="Assignee mapping" variant="summary">
              {mappings.assignee.map((row) => (
                <MappingRow
                  key={row.from}
                  from={row.from}
                  items={people}
                  value={row.userId ?? NO_ONE}
                  how={row.how}
                  count={row.count}
                  isReadOnly
                />
              ))}
            </MappingTable>
          ) : (
            empty('assignees')
          )}
        </TabPanel>
      </Tabs>
    </Section>
  );
}

// ---------------------------------------------------------------------------
// History (frame 2j)
// ---------------------------------------------------------------------------

function HistorySection({ status, projectName }: { status: BacklogSourceStatus; projectName: string }) {
  const now = useNow();
  if (!status.history.length) return null;
  return (
    <Section
      aria-label="History"
      title={
        <>
          <b className="font-semibold">History</b>
          <span className="text-sm text-fg-3">project-level entries</span>
        </>
      }
    >
      <ol className="m-0 flex list-none flex-col gap-2.5 p-0">
        {status.history.map((entry) => (
          <li
            key={entry.id}
            className="grid grid-cols-[18px_minmax(0,1fr)_auto] items-center gap-2.5 text-sm text-fg-2"
          >
            {entry.actor ? (
              <span aria-hidden className="size-1.75 justify-self-center rounded-full bg-line" />
            ) : (
              <SystemActorDot />
            )}
            <span className="min-w-0 [&_b]:font-semibold [&_b]:text-fg">
              {historyText(entry, projectName)}
            </span>
            <span className="text-xs text-fg-3 tabular-nums">
              {now === null ? '' : stampText(entry.createdAt, now)}
            </span>
          </li>
        ))}
      </ol>
    </Section>
  );
}

function historyText(entry: ProjectActivity, projectName: string): ReactNode {
  const who = <b>{entry.actor?.name ?? 'Backlog.md'}</b>;
  const { tasks, milestones, repository } = entry.details;
  if (entry.type === 'project.backlog_imported') {
    const what = [
      tasks != null ? `${tasks} ${tasks === 1 ? 'task' : 'tasks'}` : null,
      milestones != null ? `${milestones} ${milestones === 1 ? 'milestone' : 'milestones'}` : null,
    ]
      .filter(Boolean)
      .join(' and ');
    return (
      <>
        {who} imported {what || 'the files'}
        {repository ? ` from ${repository}` : ''}
        {entry.originRef ? (
          <>
            {' '}
            <span className="font-mono text-xs text-fg">{shortCommit(entry.originRef)}</span>
          </>
        ) : null}
      </>
    );
  }
  if (entry.type === 'project.backlog_webhook_secret_reissued') {
    return <>{who} issued a new webhook secret</>;
  }
  return (
    <>
      {who} switched {projectName} to Zamu. Every field is editable now.
    </>
  );
}

// ---------------------------------------------------------------------------
// Loading (frame 2o)
// ---------------------------------------------------------------------------

export function BacklogSkeleton() {
  return (
    <div aria-busy className="flex flex-col gap-4">
      <div className="flex flex-col rounded-lg border border-line-soft bg-surface">
        <div className="border-b border-line-soft px-4 py-3">
          <Skeleton width={140} />
        </div>
        <div className="flex flex-col gap-3 px-4 py-3.5">
          {[220, 160, 260, 180, 200, 140].map((width) => (
            <div key={width} className="grid grid-cols-[140px_minmax(0,1fr)] gap-4">
              <Skeleton width={90} />
              <Skeleton width={width} />
            </div>
          ))}
        </div>
      </div>
      <div className="flex flex-col rounded-lg border border-line-soft bg-surface">
        <div className="border-b border-line-soft px-4 py-3">
          <Skeleton width={100} />
        </div>
        <div className="flex flex-col gap-3 px-4 py-3.5">
          <Skeleton width="60%" />
          <Skeleton width="40%" />
        </div>
      </div>
    </div>
  );
}
