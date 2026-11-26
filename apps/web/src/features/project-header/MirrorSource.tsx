import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import type { BacklogSourceStatus, ProjectWithCounts } from '@zamu/contracts';
import { useEffect, useRef, useState } from 'react';
import { Button as AriaButton, Dialog, Link } from 'react-aria-components';
import { errorMessage, unwrap } from '~/features/settings/result';
import { useNow } from '~/features/tasks/clock';
import { retryOnce } from '~/features/tasks/errors';
import { formatAge } from '~/features/tasks/format';
import { meQuery } from '~/features/tasks/queries';
import type { WorkspaceApi } from '~/lib/orpc';
import { useApi, useWorkspaceSlug } from '~/lib/workspace';
import { Button, DialogTrigger, type Fact, FactList, Kbd, Popover, SourceStatusDot, useHotkeys } from '~/ui';
import {
  describeProblems,
  plural,
  problemCount,
  repositoryShort,
  SOURCE_TITLES,
  sourceDotState,
  triggerText,
} from './mirror';
import { projectViewHref } from './tabs';

// The Backlog.md sync status in a mirrored project's header (M5 frame 003: "● Backlog.md synced 38 min ago")
// and its status popover: state, source, last refresh, next check, problems, Refresh now (⇧R) and a link to the
// Backlog.md settings. The full status comes from GET /projects/{key}/backlog, loaded when the popover
// opens or the mirror failed (the button and the failed banner need the time and the error).

const MAX_PROBLEMS = 200;
/** How often the status reloads while a refresh runs. */
const POLL_MS = 2_000;
/** Stop waiting for a queued refresh after this long. */
const WAIT_LIMIT_MS = 5 * 60_000;

type Summary = NonNullable<ProjectWithCounts['backlog']>;

/** Full status of the project's source. */
export function backlogStatusQuery(api: WorkspaceApi, projectKey: string) {
  return api.orpc.backlog.status.queryOptions({
    input: { project: projectKey, problemsLimit: MAX_PROBLEMS },
    retry: retryOnce,
  });
}

/** The source status, loaded only while `enabled`. Polls while a refresh is under way. */
export function useBacklogStatus(projectKey: string, enabled: boolean, poll = false) {
  const api = useApi();
  return useQuery({
    ...backlogStatusQuery(api, projectKey),
    enabled,
    refetchInterval: (query) => {
      const state = query.state.data?.state;
      return poll || state === 'reading' || state === 'setup' ? POLL_MS : false;
    },
  });
}

/** Owners and admins refresh mirrors (agents too, through the API). */
export function useCanRefresh(): boolean {
  const api = useApi();
  const role = useQuery(meQuery(api)).data?.role;
  return role === 'owner' || role === 'admin';
}

/**
 * Refresh now for one project. While the queued run has not finished, `isRefreshing` stays true and
 * the status polls; when it ends, the project's lists, counts and milestones reload.
 */
export function useRefreshNow(projectKey: string) {
  const api = useApi();
  const queryClient = useQueryClient();
  const [since, setSince] = useState<number | null>(null);
  const status = useBacklogStatus(projectKey, since != null, since != null);
  const mutation = useMutation({
    // Loaded on first use: the server function module pulls server-only code into test environments.
    mutationFn: async () => {
      const { refreshBacklogNowFn } = await import('~/features/backlog/server');
      return unwrap(refreshBacklogNowFn({ data: { workspace: api.slug, input: { projectKey } } }));
    },
    onMutate: () => setSince(Date.now()),
    onError: () => setSince(null),
    onSuccess: () => void queryClient.invalidateQueries({ queryKey: api.orpc.backlog.key() }),
  });

  const data = status.data;
  useEffect(() => {
    if (since == null || !data) return;
    const attempted = data.lastAttemptAt ? Date.parse(data.lastAttemptAt) : 0;
    const finished = attempted >= since - 1_000 && data.state !== 'reading' && data.state !== 'setup';
    if (!finished && Date.now() - since < WAIT_LIMIT_MS) return;
    setSince(null);
    void Promise.all([
      queryClient.invalidateQueries({ queryKey: api.orpc.projects.key() }),
      queryClient.invalidateQueries({ queryKey: api.orpc.tasks.key() }),
      queryClient.invalidateQueries({ queryKey: api.orpc.milestones.key() }),
    ]);
  }, [since, data, queryClient, api]);

  return {
    refresh: () => {
      if (!mutation.isPending && since == null) mutation.mutate();
    },
    isRefreshing: mutation.isPending || since != null,
    error: mutation.error ? errorMessage(mutation.error) : null,
    reset: mutation.reset,
  };
}

/** Faint note on the button: "synced 3m ago", "31 problems", "failed 14m ago", "refreshing", "paused". */
function buttonNote(summary: Summary, status: BacklogSourceStatus | undefined, now: number | null) {
  const at = (value: string | null | undefined) =>
    value && now != null ? formatAge(value, new Date(now)) : '';
  switch (summary.state) {
    case 'setup':
    case 'reading':
      return 'refreshing';
    case 'paused':
      return 'paused';
    case 'failed': {
      const age = at(status?.lastAttemptAt);
      return age ? `failed ${age === 'now' ? 'just now' : `${age} ago`}` : 'failed';
    }
    case 'warnings':
      return plural(problemCount(summary.problems), 'problem');
    default: {
      const age = at(summary.lastReadAt);
      return age === 'now' ? 'synced just now' : age ? `synced ${age} ago` : '';
    }
  }
}

/** "3m ago by webhook, commit a1b2c3d". */
function lastRefreshText(summary: Summary, now: number | null) {
  if (!summary.lastReadAt) return 'Not read yet';
  const age = now != null ? formatAge(summary.lastReadAt, new Date(now)) : '';
  const when = age === 'now' ? 'just now' : age ? `${age} ago` : '';
  const trigger = triggerText(summary.lastTrigger);
  return (
    <>
      {[when, trigger].filter(Boolean).join(' ')}
      {summary.lastReadCommit ? (
        <>
          , commit <span className="font-mono text-xs">{summary.lastReadCommit.slice(0, 7)}</span>
        </>
      ) : null}
    </>
  );
}

/** "in 57m", "in 2h"; "Paused" when there is no scheduled check. */
function nextCheckText(status: BacklogSourceStatus | undefined, now: number | null) {
  if (!status) return '…';
  if (!status.nextPollAt) return status.state === 'paused' ? 'Retries every hour' : 'None';
  if (now == null) return '';
  const minutes = Math.max(0, Math.round((Date.parse(status.nextPollAt) - now) / 60_000));
  if (minutes < 1) return 'any moment';
  if (minutes < 60) return `in ${minutes}m`;
  return `in ${Math.floor(minutes / 60)}h ${minutes % 60}m`;
}

export interface MirrorSourceButtonProps {
  project: ProjectWithCounts;
  /** Binds ⇧R to Refresh now (off where the page binds it itself). */
  refreshHotkey?: boolean;
}

/** The source button and its status popover. Render only for mirrored projects. */
export function MirrorSourceButton({ project, refreshHotkey = true }: MirrorSourceButtonProps) {
  const workspace = useWorkspaceSlug();
  const summary = project.backlog as Summary;
  const [isOpen, setOpen] = useState(false);
  const now = useNow();
  const canRefresh = useCanRefresh();
  const refresh = useRefreshNow(project.key);
  const needsStatus = isOpen || summary.state === 'failed';
  const status = useBacklogStatus(project.key, needsStatus).data;
  const state = refresh.isRefreshing ? 'reading' : summary.state;
  const shownSummary: Summary = { ...summary, state };

  const refreshRef = useRef(refresh.refresh);
  refreshRef.current = refresh.refresh;
  useHotkeys({
    'Shift+r': {
      enabled: refreshHotkey && canRefresh && summary.state !== 'paused',
      handler: () => {
        refreshRef.current();
        setOpen(true);
      },
    },
  });

  const repository = repositoryShort(status?.repository ?? project.repository);
  const branch = status?.defaultBranch ?? summary.defaultBranch;
  const facts: Fact[] = [
    {
      id: 'source',
      label: 'Source',
      value: (
        <span className="font-mono text-xs break-words">
          {[repository ?? 'No repository', branch].filter(Boolean).join(' · ')}
        </span>
      ),
    },
    { id: 'last', label: 'Last refresh', value: lastRefreshText(summary, now) },
  ];
  if ((summary.state === 'failed' || summary.state === 'paused') && status?.lastError) {
    facts.push({
      id: 'error',
      label: summary.state === 'failed' ? 'Error' : 'Why',
      value: <span className="text-danger">{status.lastError}</span>,
    });
  }
  facts.push({ id: 'next', label: 'Next check', value: nextCheckText(status, now) });
  const problems = problemCount(summary.problems);
  facts.push({
    id: 'problems',
    label: 'Problems',
    value: problems ? (
      <span className="text-danger">{describeProblems(summary.problems, status?.problems.items)}</span>
    ) : (
      'None'
    ),
  });

  const settingsHref = projectViewHref(workspace, project.key, 'settings');

  return (
    <DialogTrigger
      isOpen={isOpen}
      onOpenChange={(open) => {
        setOpen(open);
        if (!open) refresh.reset();
      }}
    >
      <AriaButton
        aria-label={`Backlog.md: ${SOURCE_TITLES[state]}`}
        aria-keyshortcuts={canRefresh ? 'Shift+R' : undefined}
        className="inline-flex h-7.5 shrink-0 cursor-pointer items-center gap-1.75 rounded-md px-2 text-sm whitespace-nowrap text-fg-3 outline-none hover:bg-bg-lane focus-visible:shadow-[var(--focus-ring)] aria-expanded:bg-bg-lane"
      >
        <SourceStatusDot state={sourceDotState(shownSummary.state)} decorative />
        <b className="font-medium text-fg-2">Backlog.md</b>
        <span>{buttonNote(shownSummary, status, now)}</span>
      </AriaButton>
      <Popover placement="bottom end" className="w-95 min-w-0">
        <Dialog aria-label="Backlog.md mirror" className="outline-none">
          <div className="flex items-center gap-2 border-b border-line-soft px-3 py-2.5">
            <SourceStatusDot state={sourceDotState(state)} decorative />
            <b className="font-semibold">{SOURCE_TITLES[state]}</b>
            <span className="flex-1" />
            {canRefresh ? <Kbd aria-hidden>⇧R</Kbd> : null}
          </div>
          <FactList size="sm" labelWidth={96} className="px-3 py-2.5" items={facts} />
          {refresh.error ? <p className="m-0 px-3 pb-2 text-sm text-danger">{refresh.error}</p> : null}
          <div className="flex items-center gap-2 border-t border-line-soft px-3 py-2">
            <Link
              href={settingsHref}
              className="cursor-pointer text-sm text-fg-3 outline-none hover:text-fg hover:underline focus-visible:shadow-[var(--focus-ring)]"
            >
              Open Backlog.md settings
            </Link>
            <span className="flex-1" />
            {canRefresh ? (
              <Button
                size="sm"
                isPending={refresh.isRefreshing}
                isDisabled={summary.state === 'paused'}
                onPress={refresh.refresh}
              >
                {refresh.isRefreshing ? 'Refreshing…' : 'Refresh now'}
              </Button>
            ) : (
              <span className="text-xs text-fg-3">Owners and admins can refresh.</span>
            )}
          </div>
        </Dialog>
      </Popover>
    </DialogTrigger>
  );
}
