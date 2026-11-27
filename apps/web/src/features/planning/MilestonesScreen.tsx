import { useQuery } from '@tanstack/react-query';
import { useNavigate } from '@tanstack/react-router';
import type { MilestoneWithProgress } from '@zamu/contracts';
import { type MouseEvent, useMemo, useState } from 'react';
import { Link } from 'react-aria-components';
import { isMirrored, MilestoneRefusal, ProjectHeader, useProjectSummary } from '~/features/project-header';
import { useOptionalQuickCreate } from '~/features/shell/quick-create';
import { taskListQuery } from '~/features/tasks/queries';
import { useApi, useWorkspaceSlug } from '~/lib/workspace';
import { type WorkspaceUrlSlug, workspacePath } from '~/lib/workspace-paths';
import {
  Button,
  cn,
  EmptyState,
  OPEN_STATUSES,
  Pill,
  type PillTone,
  Skeleton,
  useHotkeys,
  WaveStatusLine,
} from '~/ui';
import { formatDay } from './dates';
import { FeatureOff } from './FeatureOff';
import { NewMilestoneDialog } from './MilestoneDialogHost';
import {
  FoldGroup,
  LoadError,
  PageHead,
  PageMeta,
  PageTitle,
  PLAN_ROW_GRID,
  PlanIcon,
  PlanListHead,
  RowBar,
  useServerToday,
} from './parts';
import { milestonesQuery } from './queries';

// /p/HBR/milestones (frame 107): the open milestones with progress, target, task count and a status
// pill (On track, 2 blocked), the completed ones folded at the bottom. J / K or ↓ / ↑ move the
// highlight, Enter or a click opens the milestone. New milestone in native projects only: mirrored
// milestones come from the Backlog.md files (notes.md call 3). M8 (frame 118): the wave status under each
// name ("Wave 3 of 5 · gate open", "Gate failed in wave 8 of 12", "All 4 gates passed", "No waves").

export function milestoneHref(workspace: WorkspaceUrlSlug, projectKey: string, id: string): string {
  return workspacePath(
    workspace,
    `/p/${encodeURIComponent(projectKey)}/milestones/${encodeURIComponent(id)}`,
  );
}

/** Target date first (none last), then name. */
export function sortMilestones(items: readonly MilestoneWithProgress[]): MilestoneWithProgress[] {
  return [...items].sort((a, b) => {
    if (a.targetDate !== b.targetDate) {
      if (!a.targetDate) return 1;
      if (!b.targetDate) return -1;
      return a.targetDate.localeCompare(b.targetDate);
    }
    return a.name.localeCompare(b.name, undefined, { sensitivity: 'base' });
  });
}

/** The Target cell: "Nov 14 · in 11 days", "Oct 30 · 4 days late", "Nov 14 · today", "No date". */
export function targetText(
  milestone: Pick<MilestoneWithProgress, 'targetDate' | 'daysLeft' | 'status'>,
  today: string | null,
): { text: string; tone: 'default' | 'late' | 'none' } {
  if (!milestone.targetDate) return { text: 'No date', tone: 'none' };
  const date = formatDay(milestone.targetDate, today ?? milestone.targetDate);
  const days = milestone.daysLeft;
  if (milestone.status === 'completed' || days == null) return { text: date, tone: 'default' };
  if (days < 0) return { text: `${date} · ${-days} ${days === -1 ? 'day' : 'days'} late`, tone: 'late' };
  if (days === 0) return { text: `${date} · today`, tone: 'default' };
  return { text: `${date} · in ${days} ${days === 1 ? 'day' : 'days'}`, tone: 'default' };
}

/** The pill at the end of a row: Completed, "2 blocked", Overdue, On track, or the status. */
export function milestonePill(
  milestone: Pick<MilestoneWithProgress, 'status' | 'overdue' | 'targetDate'>,
  blocked: number,
): { text: string; tone: PillTone } {
  if (milestone.status === 'completed') return { text: 'Completed', tone: 'default' };
  if (blocked > 0) return { text: `${blocked} blocked`, tone: 'warn' };
  if (milestone.overdue) return { text: 'Overdue', tone: 'warn' };
  if (milestone.targetDate) return { text: 'On track', tone: 'ok' };
  return { text: milestone.status === 'active' ? 'Active' : 'Planned', tone: 'default' };
}

/** "18 of 30": done of the tasks that count (canceled left out). */
export function taskCountText(progress: MilestoneWithProgress['progress']): string {
  return `${progress.done} of ${progress.total - progress.canceled}`;
}

function isControl(target: EventTarget | null): boolean {
  return target instanceof Element && target.closest('a, button, input, textarea, select') != null;
}

export interface MilestonesScreenProps {
  projectKey: string;
}

export function MilestonesScreen({ projectKey }: MilestonesScreenProps) {
  const workspace = useWorkspaceSlug();
  const api = useApi();
  const navigate = useNavigate();
  const quickCreate = useOptionalQuickCreate();
  const project = useProjectSummary(projectKey);
  const milestones = useQuery(milestonesQuery(api, projectKey));
  const today = useServerToday(projectKey);
  const [creating, setCreating] = useState(false);
  const [completedOpen, setCompletedOpen] = useState(false);
  const [focused, setFocused] = useState<string | null>(null);

  const isOff = project != null && !project.usesMilestones;
  const mirrored = isMirrored(project);
  const projectName = project?.name ?? projectKey;
  const items = milestones.data?.items;

  // Open blocked tasks per milestone, for the "2 blocked" pills: one request for the project.
  const blockedTasks = useQuery({
    ...taskListQuery(api, { project: projectKey, blocked: true, status: [...OPEN_STATUSES] }),
    enabled: Boolean(items?.length),
  });
  const blockedBy = useMemo(() => {
    const counts = new Map<string, number>();
    for (const task of blockedTasks.data?.items ?? []) {
      if (task.milestone) counts.set(task.milestone.id, (counts.get(task.milestone.id) ?? 0) + 1);
    }
    return counts;
  }, [blockedTasks.data]);

  const { open, completed } = useMemo(() => {
    const sorted = sortMilestones(items ?? []);
    return {
      open: sorted.filter((item) => item.status !== 'completed'),
      completed: sorted.filter((item) => item.status === 'completed'),
    };
  }, [items]);
  const rowIds = useMemo(
    () => [...open, ...(completedOpen ? completed : [])].map((item) => item.id),
    [open, completed, completedOpen],
  );

  const openMilestone = (id: string) => void navigate({ href: milestoneHref(workspace, projectKey, id) });
  const move = (step: 1 | -1) => {
    if (!rowIds.length) return;
    const index = focused ? rowIds.indexOf(focused) : -1;
    const next = index < 0 ? (step > 0 ? 0 : rowIds.length - 1) : index + step;
    setFocused(rowIds[Math.max(0, Math.min(rowIds.length - 1, next))] ?? null);
  };
  useHotkeys(
    {
      j: () => move(1),
      k: () => move(-1),
      down: () => move(1),
      up: () => move(-1),
      Enter: {
        preventDefault: false,
        handler: (event) => {
          if (!focused || isControl(event.target)) return;
          event.preventDefault();
          openMilestone(focused);
        },
      },
      Escape: { preventDefault: false, handler: () => setFocused(null) },
    },
    { enabled: Boolean(rowIds.length) },
  );

  const newMilestone = mirrored ? null : (
    <Button variant="secondary" isDisabled={!today} onPress={() => setCreating(true)}>
      New milestone
    </Button>
  );

  const body = () => {
    if (isOff) return <FeatureOff projectKey={projectKey} feature="milestones" />;
    if (milestones.isError && !milestones.data) {
      return (
        <LoadError
          what="milestones"
          error={milestones.error}
          onRetry={() => void milestones.refetch()}
          isRetrying={milestones.isFetching}
        />
      );
    }
    if (milestones.isPending) return <RowsSkeleton />;
    if (!items?.length) {
      return (
        <div className="flex px-4.5 py-12">
          {mirrored ? (
            <EmptyState
              className="max-w-160"
              title="No milestones in Backlog.md yet"
              text={<MilestoneRefusal projectName={projectName} />}
            />
          ) : (
            <EmptyState
              className="max-w-160"
              title="Group work toward a goal"
              text="A milestone collects the tasks behind one outcome, like a release or an audit, and tracks how many are done. Give it a target date if there is one. Each task belongs to at most one milestone."
              action={newMilestone}
              cli={{
                command: `zamu milestones create --project ${projectKey} "Webhooks v2" --target 2026-11-14`,
              }}
            />
          )}
        </div>
      );
    }
    return (
      <div className="min-h-0 flex-1 overflow-auto">
        <PlanListHead first="Milestone" date="Target" />
        <ul aria-label={`Open milestones of ${projectName}`} className="m-0 list-none p-0">
          {open.map((milestone) => (
            <MilestoneRow
              key={milestone.id}
              projectKey={projectKey}
              milestone={milestone}
              today={today}
              blocked={blockedBy.get(milestone.id) ?? 0}
              isFocused={focused === milestone.id}
              onFocus={() => setFocused(milestone.id)}
            />
          ))}
        </ul>
        {completed.length ? (
          <>
            <FoldGroup
              label="Completed"
              count={completed.length}
              expanded={completedOpen}
              onToggle={() => setCompletedOpen(!completedOpen)}
              className="mt-0 border-line-soft"
            />
            {completedOpen ? (
              <ul aria-label="Completed milestones" className="m-0 list-none p-0">
                {completed.map((milestone) => (
                  <MilestoneRow
                    key={milestone.id}
                    projectKey={projectKey}
                    milestone={milestone}
                    today={today}
                    blocked={0}
                    isFocused={focused === milestone.id}
                    onFocus={() => setFocused(milestone.id)}
                  />
                ))}
              </ul>
            ) : null}
          </>
        ) : null}
      </div>
    );
  };

  return (
    <section aria-label="Milestones" className="flex h-dvh min-h-0 min-w-0 flex-1 flex-col bg-bg text-fg">
      <ProjectHeader
        projectKey={projectKey}
        current="milestones"
        actions={
          isOff ? undefined : (
            <>
              {newMilestone}
              <Button kbd="C" aria-keyshortcuts="c" onPress={() => quickCreate?.open(projectKey)}>
                New task
              </Button>
            </>
          )
        }
      />
      {isOff ? null : (
        <PageHead>
          <PageTitle as="h2">Milestones</PageTitle>
          <PageMeta>
            {items ? (
              <>
                <span>{open.length} open</span>
                <span>{completed.length} completed</span>
              </>
            ) : (
              <Skeleton width={120} height={8} />
            )}
            {mirrored ? (
              <span className="text-fg-3">Milestones come from Backlog.md. Edit them in the files.</span>
            ) : null}
          </PageMeta>
        </PageHead>
      )}
      {body()}
      {today && !mirrored ? (
        <NewMilestoneDialog
          projectKey={projectKey}
          isOpen={creating}
          onClose={() => setCreating(false)}
          today={today}
        />
      ) : null}
    </section>
  );
}

interface MilestoneRowProps {
  projectKey: string;
  milestone: MilestoneWithProgress;
  today: string | null;
  blocked: number;
  isFocused: boolean;
  onFocus: () => void;
}

function MilestoneRow({ projectKey, milestone, today, blocked, isFocused, onFocus }: MilestoneRowProps) {
  const workspace = useWorkspaceSlug();
  const navigate = useNavigate();
  const href = milestoneHref(workspace, projectKey, milestone.id);
  const { progress } = milestone;
  const counted = progress.total - progress.canceled;
  const target = targetText(milestone, today);
  const pill = milestonePill(milestone, blocked);
  const done = milestone.status === 'completed';
  const onClick = (event: MouseEvent<HTMLLIElement>) => {
    if ((event.target as Element).closest('a, button')) return;
    if (window.getSelection()?.toString()) return;
    void navigate({ href });
  };
  return (
    // biome-ignore lint/a11y/useKeyWithClickEvents: the name link and J / K with Enter are the keyboard path
    <li
      data-focused={isFocused || undefined}
      onClick={onClick}
      className={cn(
        PLAN_ROW_GRID,
        'h-14 cursor-pointer border-b border-line-soft',
        isFocused ? 'bg-accent-soft' : 'hover:bg-surface-hover',
      )}
    >
      <PlanIcon kind="milestone" className="ml-0.75" />
      <span className="flex min-w-0 flex-col gap-0.5">
        <Link
          href={href}
          onFocus={onFocus}
          className={cn(
            'w-fit max-w-full cursor-pointer truncate rounded-sm text-md font-semibold outline-none focus-visible:shadow-[var(--focus-ring)]',
            done ? 'text-fg-2' : 'text-fg',
          )}
        >
          {milestone.name}
        </Link>
        {milestone.waves !== undefined ? (
          <WaveStatusLine
            waves={milestone.waves}
            openTasks={progress.total - progress.done - progress.canceled}
          />
        ) : milestone.description ? (
          <span className="truncate text-xs text-fg-3">{firstLine(milestone.description)}</span>
        ) : null}
      </span>
      <RowBar done={progress.done} total={counted} label={`${milestone.name} progress`} />
      <span
        className={cn(
          'truncate text-sm tabular-nums',
          target.tone === 'late'
            ? 'font-semibold text-danger'
            : target.tone === 'none'
              ? 'text-fg-3'
              : 'text-fg-2',
        )}
      >
        {target.text}
      </span>
      <span className="text-sm text-fg-2 tabular-nums">{taskCountText(progress)}</span>
      <span className="justify-self-end">
        <Pill tone={pill.tone}>{pill.text}</Pill>
      </span>
    </li>
  );
}

function RowsSkeleton() {
  return (
    <div role="status" aria-busy="true" aria-label="Loading milestones">
      {[42, 30, 55].map((width) => (
        <div key={width} className={cn(PLAN_ROW_GRID, 'h-14 border-b border-line-soft')}>
          <Skeleton width={12} height={12} />
          <Skeleton width={`${width}%`} height={9} />
          <Skeleton height={4} />
          <Skeleton width={90} height={8} />
          <Skeleton width={40} height={8} />
          <span />
        </div>
      ))}
    </div>
  );
}

/** First line of a Markdown description, without its marks. */
export function firstLine(markdown: string | null): string {
  if (!markdown) return '';
  return (
    markdown
      .split('\n')
      .map((line) => line.replace(/^[#>*\-+\s]+/, '').trim())
      .find(Boolean) ?? ''
  );
}
