import { useQuery } from '@tanstack/react-query';
import type { ProjectBacklogSummary, Task } from '@zamu/contracts';
import { useState } from 'react';
import { Button as AriaButton } from 'react-aria-components';
import type { WorkspaceApi } from '~/lib/orpc';
import { useApi } from '~/lib/workspace';
import { CaretGlyph, cn, SourceBadge, SourceStatusDot } from '~/ui';
import { useNow } from './clock';
import { atTime, formatDay } from './format';
import { fileFields } from './mirror';
import { projectsQuery, timelineQuery } from './queries';

// Pieces of a task mirrored from (or once imported from) Backlog.md in the task view (frames 054, 055):
// the Backlog.md badge over the title, "From the file" at the foot of the properties, and the banner
// of a task whose file is gone.

/** The project's Backlog.md summary and name, from the cached project list. */
export function useBacklogSummary(projectKey: string): {
  summary: ProjectBacklogSummary | null;
  projectName: string | undefined;
} {
  const api = useApi();
  const project = useQuery({
    ...projectsQuery(api),
    select: (data) => data.items.find((item) => item.key === projectKey),
  }).data;
  return { summary: project?.backlog ?? null, projectName: project?.name };
}

/** Project-level Backlog.md history (first read, detach), for tasks that came from Backlog.md. */
export function backlogHistoryQuery(api: WorkspaceApi, projectKey: string) {
  return api.orpc.backlog.status.queryOptions({
    input: { project: projectKey, problemsLimit: 1 },
    retry: false,
    staleTime: 60_000,
    select: (data) => data.history,
  });
}

/** The task view's "Backlog.md ↗" badge over the title, linking to the file when its address is known. */
export function TaskFileBadge({ task, className }: { task: Task; className?: string }) {
  const backlog = task.backlog;
  if (!backlog) return null;
  const label = (
    <span className="inline-flex items-center gap-1.25">
      <span
        aria-hidden
        className="block h-2.75 w-2.25 shrink-0 rounded-[2px] border-[1.5px] border-current"
      />
      Backlog.md
      {backlog.fileUrl ? (
        <span aria-hidden className="text-fg-3">
          ↗
        </span>
      ) : null}
    </span>
  );
  return (
    <SourceBadge
      label={label}
      {...(backlog.fileUrl ? { href: backlog.fileUrl, external: true } : {})}
      className={className}
    />
  );
}

/** "From the file" stays open or closed while moving between tasks; closed at first. */
let fromFileOpen = false;

/** Closed again (tests). */
export function resetFromFile() {
  fromFileOpen = false;
}

/**
 * "From the file" at the foot of the properties (frames 054, 055): the task file's fields that have no
 * native home, raw keys and values as written. Labels, due, dependencies, parent and subtasks are native
 * fields and show above.
 */
export function FromTheFile({ task, className }: { task: Task; className?: string }) {
  const [open, setOpenState] = useState(fromFileOpen);
  const rows = fileFields(task);
  if (!task.backlog || rows.length === 0) return null;
  const setOpen = (next: boolean) => {
    fromFileOpen = next;
    setOpenState(next);
  };
  return (
    <section aria-label="From the file" className={cn('mt-auto border-t border-line-soft pt-2.5', className)}>
      <AriaButton
        onPress={() => setOpen(!open)}
        aria-expanded={open}
        className="-mx-1.5 flex h-7.5 w-[calc(100%+12px)] cursor-pointer items-center gap-2 rounded-sm px-1.5 text-sm font-semibold text-fg-2 outline-none hover:bg-bg-grp focus-visible:focus-ring"
      >
        <CaretGlyph className={cn('transition-transform', !open && '-rotate-90')} />
        From the file
        <span className="ml-auto text-xs font-normal text-fg-3">
          {rows.length} {rows.length === 1 ? 'field' : 'fields'}
        </span>
      </AriaButton>
      {open ? (
        <dl className="m-0 mt-1 flex flex-col">
          {rows.map((row) => (
            <div
              key={row.key}
              className="grid min-h-8 grid-cols-[108px_minmax(0,1fr)] items-start gap-2 py-1.5"
            >
              <dt className="font-mono text-xs leading-5 text-fg-3">{row.key}</dt>
              <dd className="m-0 font-mono text-xs leading-5 break-all text-fg-2">{row.value}</dd>
            </div>
          ))}
        </dl>
      ) : null}
    </section>
  );
}

/** Banner on a hidden task opened by URL: the file is gone from the default branch. */
export function RemovedBanner({
  task,
  branch,
  className,
}: {
  task: Task;
  branch: string | null | undefined;
  className?: string;
}) {
  const api = useApi();
  const now = useNow();
  const commit = useQuery({
    ...timelineQuery(api, task.key),
    select: (data) => {
      const hides = data.items.filter((item) => item.kind === 'activity' && item.type === 'task.hidden');
      const last = hides[hides.length - 1];
      return last?.kind === 'activity' ? (last.originRef ?? null) : null;
    },
  }).data;
  const day = task.hiddenAt ? atTime(formatDay, now)(task.hiddenAt) : '';
  return (
    <div
      role="status"
      className={cn(
        'flex shrink-0 items-start gap-2.5 rounded-md bg-bg-lane px-3.5 py-2.5 text-sm leading-normal text-fg-2 [&_b]:font-semibold [&_b]:text-fg',
        className,
      )}
    >
      <SourceStatusDot state="paused" decorative className="mt-1.5" />
      <span>
        <b>Removed from Backlog.md{day ? ` on ${day}` : ''}.</b> Its file is no longer on{' '}
        <span className="font-mono text-xs text-fg">{branch ?? 'the default branch'}</span>
        {commit ? ` (last seen at commit ${commit.slice(0, 7)})` : ''}, so the task is hidden from lists, the
        board and Home. The comments stay. If the file comes back, so does the task.
      </span>
    </div>
  );
}
