import type { ProjectWithCounts } from '@zamu/contracts';
import { type ReactNode, useEffect, useState } from 'react';
import { Link } from 'react-aria-components';
import { useNow } from '~/features/tasks/clock';
import { formatAge } from '~/features/tasks/format';
import { workspaceStorageKey } from '~/lib/storage-keys';
import { useWorkspaceId, useWorkspaceSlug } from '~/lib/workspace';
import { Banner, buttonStyles, CodeBlock, InlineCode, NoticeStrip, SourceStatusDot, Toast } from '~/ui';
import { useBacklogStatus } from './MirrorSource';
import { detachedText, isDetached, isMirrored, plural, repositoryShort } from './mirror';
import { projectViewHref } from './tabs';

// Notices of a mirrored project's task views: the failed-refresh banner (frame 4e), the strip over
// hidden tasks (4i), the empty mirror (4n) and the toast after detach (4l).

function ago(value: string | null | undefined, now: number | null): string {
  if (!value || now == null) return '';
  const age = formatAge(value, new Date(now));
  if (age === 'now') return 'just now';
  return /\d[mhd]$/.test(age) ? `${age} ago` : `on ${age}`;
}

function sentence(text: string): string {
  const trimmed = text.trim();
  return /[.!?]$/.test(trimmed) ? trimmed : `${trimmed}.`;
}

/** Splits "backlog/config.yml couldn't …" so file paths read as code. */
function withPaths(text: string): ReactNode {
  const parts = text.split(/(\S+\.(?:ya?ml|md))/g);
  return parts.map((part, index) =>
    index % 2 ? (
      // biome-ignore lint/suspicious/noArrayIndexKey: static split of one sentence
      <InlineCode key={index}>{part}</InlineCode>
    ) : (
      part
    ),
  );
}

export interface MirrorFailedBannerProps {
  project: ProjectWithCounts | undefined;
}

/**
 * "The last Backlog.md refresh failed 14m ago: … Tasks show commit 9f8e7d6 from 2h ago." with Details
 * (the Backlog.md settings). Nothing unless the mirror's last refresh failed.
 */
export function MirrorFailedBanner({ project }: MirrorFailedBannerProps) {
  const workspace = useWorkspaceSlug();
  const failed = isMirrored(project) && project?.backlog?.state === 'failed';
  const status = useBacklogStatus(project?.key ?? '', failed).data;
  const now = useNow();
  if (!failed || !project?.backlog) return null;
  const summary = project.backlog;
  const when = ago(status?.lastAttemptAt, now);
  const reason = status?.lastError ? withPaths(sentence(status.lastError)) : null;
  return (
    <div className="shrink-0 border-b border-line px-6 py-3">
      <Banner
        action={
          <Link
            href={projectViewHref(workspace, project.key, 'settings')}
            className={buttonStyles({ variant: 'secondary', size: 'sm' })}
          >
            Details
          </Link>
        }
      >
        <span className="leading-normal">
          The last Backlog.md refresh failed{when ? ` ${when}` : ''}
          {reason ? <>: {reason}</> : '.'}
          {summary.lastReadCommit ? (
            <>
              {' '}
              Tasks show commit {summary.lastReadCommit.slice(0, 7)}
              {summary.lastReadAt && now != null ? ` from ${ago(summary.lastReadAt, now)}` : ''}.
            </>
          ) : null}
        </span>
      </Banner>
    </div>
  );
}

/** Over the hidden tasks: why they are hidden and what brings them back. */
export function HiddenTasksStrip({ count, branch }: { count: number; branch: string | null }) {
  return (
    <div className="shrink-0 border-b border-line px-6 py-2.5">
      <NoticeStrip marker={<SourceStatusDot state="paused" decorative />}>
        <span className="leading-normal">
          {plural(count, 'task')} whose files are gone from{' '}
          <span className="font-mono text-xs text-fg">{branch ?? 'the default branch'}</span>. They're hidden
          from lists, the board, My tasks and the dashboard, and come back if their file returns. Comments are
          kept.
        </span>
      </NoticeStrip>
    </div>
  );
}

/**
 * The list of a mirror with no task files (frame 4n), or before its first read finished. The folder,
 * repository and last check come from the source status.
 */
export function MirrorEmptyState({ project }: { project: ProjectWithCounts }) {
  const status = useBacklogStatus(project.key, true).data;
  const now = useNow();
  const summary = project.backlog;
  const folder = `${(status?.folder ?? 'backlog').replace(/\/+$/, '')}/`;
  const repository = repositoryShort(status?.repository ?? project.repository) ?? 'the repository';
  const branch = status?.defaultBranch ?? summary?.defaultBranch ?? 'the default branch';
  if (summary && !summary.lastReadAt) {
    return (
      <div className="flex px-6 py-12">
        <div className="flex max-w-130 flex-col items-start gap-3">
          <h2 className="m-0 font-serif text-2xl font-medium">Reading {folder} for the first time</h2>
          <p className="m-0 leading-prose text-fg-2">
            The mirror reads <span className="font-mono text-xs text-fg">{repository}</span>. Tasks show up
            here when the first read finishes.
          </p>
        </div>
      </div>
    );
  }
  const checked = ago(status?.lastAttemptAt ?? summary?.lastReadAt, now);
  return (
    <div className="flex px-6 py-12">
      <div className="flex w-full max-w-130 flex-col items-start gap-3">
        <h2 className="m-0 font-serif text-2xl font-medium">No tasks in {folder} yet</h2>
        <p className="m-0 leading-prose text-fg-2">
          The mirror is set up and reads <span className="font-mono text-xs text-fg">{repository}</span>, but
          the folder has no task files on {branch}. Create one, push it, and it shows up here.
        </p>
        <CodeBlock copyable copyLabel="Copy command" className="w-full">
          {'backlog task create "Retry failed webhook deliveries" && git push'}
        </CodeBlock>
        {checked || summary?.lastReadCommit ? (
          <span className="text-xs text-fg-3">
            {[
              checked ? `Last checked ${checked}` : null,
              summary?.lastReadCommit ? `commit ${summary.lastReadCommit.slice(0, 7)}` : null,
            ]
              .filter(Boolean)
              .join(' · ')}
          </span>
        ) : null}
      </div>
    </div>
  );
}

/** A detach this recent still gets its toast on the project's task views. */
const DETACH_TOAST_WINDOW_MS = 10 * 60_000;
const DETACH_TOAST_MS = 8_000;
/** zamu:detached-toast:v2:<workspace id>:<project key>:<detached at>, in sessionStorage. */
export const detachedToastKey = (workspaceId: string, projectKey: string, detachedAt: string) =>
  workspaceStorageKey('detached-toast', workspaceId, projectKey, detachedAt);

/**
 * "Payments is owned by Zamu now. Everything is editable here." once per browser session,
 * on the first task view after a recent detach.
 */
export function DetachedToast({ project }: { project: ProjectWithCounts | undefined }) {
  const workspaceId = useWorkspaceId();
  const [show, setShow] = useState(false);
  const detachedAt = isDetached(project) ? (project?.backlog?.detachedAt ?? null) : null;
  const projectKey = project?.key;
  useEffect(() => {
    if (!detachedAt || !projectKey) return;
    if (Date.now() - Date.parse(detachedAt) > DETACH_TOAST_WINDOW_MS) return;
    try {
      const key = detachedToastKey(workspaceId, projectKey, detachedAt);
      if (window.sessionStorage.getItem(key)) return;
      window.sessionStorage.setItem(key, '1');
    } catch {
      // Storage off: show it anyway.
    }
    setShow(true);
  }, [workspaceId, detachedAt, projectKey]);
  if (!show || !project) return null;
  return (
    <Toast floating timeout={DETACH_TOAST_MS} onDismiss={() => setShow(false)}>
      {detachedText(project.name)}
    </Toast>
  );
}
