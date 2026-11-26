import { useQuery } from '@tanstack/react-query';
import { useNavigate } from '@tanstack/react-router';
import type { MilestoneWithProgress, StatusCounts } from '@zamu/contracts';
import { type ReactNode, useState } from 'react';
import { isMirrored } from '~/features/project-header';
import { useOptionalQuickCreate } from '~/features/shell/quick-create';
import { Markdown } from '~/features/tasks/Markdown';
import { clearedFilter, DisplayButton, FilterButton, FilterChips } from '~/features/views';
import { useApi, useWorkspaceSlug } from '~/lib/workspace';
import { workspacePath } from '~/lib/workspace-paths';
import { Button, EmptyState, Skeleton, SourceBadge, useHotkeys } from '~/ui';
import { formatDay } from './dates';
import { EditMilestoneDialog } from './MilestoneDialogHost';
import { PlanningHeader } from './PlanningHeader';
import { PlanningTaskTable } from './PlanningTaskTable';
import {
  LoadError,
  PageHead,
  PageKind,
  PageTitle,
  type StatItem,
  Stats,
  StatusBar,
  StatusLegend,
  type StatusSplit,
  splitOf,
  useServerToday,
} from './parts';
import { milestoneQuery } from './queries';
import { planningGroupChoices, usePlanningTasks } from './usePlanningTasks';

// /p/HBR/milestones/<id> (frame 108): kind and source, serif title, description, the numbers, the
// segmented bar with its legend, then the milestone's tasks in the list rows. Filter and Display work
// as in the list (the filter lives in the URL: ?status=todo&assignee=me&label=…). Edit opens the
// milestone dialog in native projects; mirrored milestones change in their Backlog.md file.

export interface MilestonePageProps {
  projectKey: string;
  milestoneId: string;
}

/** "30 tasks  18 done  11 days left" (or "4 days late", or no third number without a target). */
export function milestoneStats(milestone: MilestoneWithProgress): StatItem[] {
  const { progress } = milestone;
  const counted = progress.total - progress.canceled;
  const items: StatItem[] = [
    { value: counted, label: counted === 1 ? 'task' : 'tasks' },
    { value: progress.done, label: 'done' },
  ];
  const days = milestone.daysLeft;
  if (milestone.status !== 'completed' && days != null) {
    items.push(
      days < 0
        ? { value: -days, label: days === -1 ? 'day late' : 'days late' }
        : { value: days, label: days === 1 ? 'day left' : 'days left' },
    );
  }
  return items;
}

/** The bar's split from the milestone's task counts, or from its progress until those load. */
export function milestoneSplit(
  milestone: MilestoneWithProgress | undefined,
  counts: StatusCounts | undefined,
): StatusSplit {
  if (counts) return splitOf(counts);
  const progress = milestone?.progress;
  return {
    done: progress?.done ?? 0,
    review: 0,
    progress: progress?.inProgress ?? 0,
    todo: progress?.open ?? 0,
  };
}

export function MilestonePage({ projectKey, milestoneId }: MilestonePageProps) {
  const workspace = useWorkspaceSlug();
  const api = useApi();
  const navigate = useNavigate();
  const quickCreate = useOptionalQuickCreate();
  const milestone = useQuery(milestoneQuery(api, milestoneId));
  const today = useServerToday(projectKey);
  const [editing, setEditing] = useState(false);
  const view = usePlanningTasks(projectKey, { milestone: milestoneId });
  const { project, filter, setFilter, fields, display, tasks, all } = view;

  const data = milestone.data;
  const mirrored = isMirrored(project);
  const isLocked = (data?.locked ?? []).length > 0;
  const newTask = () => quickCreate?.open(projectKey);
  const toBoard = () =>
    void navigate({ href: workspacePath(workspace, `/p/${projectKey}?view=board&milestone=${milestoneId}`) });
  useHotkeys({ v: toBoard });

  const newTaskButton = (
    <Button kbd="C" aria-keyshortcuts="c" onPress={newTask}>
      New task
    </Button>
  );

  if (milestone.isError && !data) {
    const missing = (milestone.error as { code?: string }).code === 'NOT_FOUND';
    return (
      <Frame>
        <PlanningHeader projectKey={projectKey} section="milestones" title="Milestone" />
        {missing ? (
          <div className="flex px-4.5 py-12">
            <EmptyState
              title="This milestone does not exist"
              text="It may have been deleted. Its tasks keep their other fields."
              action={
                <Button
                  variant="secondary"
                  onPress={() =>
                    void navigate({ href: workspacePath(workspace, `/p/${projectKey}/milestones`) })
                  }
                >
                  All milestones
                </Button>
              }
            />
          </div>
        ) : (
          <LoadError
            what="this milestone"
            error={milestone.error}
            onRetry={() => void milestone.refetch()}
            isRetrying={milestone.isFetching}
          />
        )}
      </Frame>
    );
  }

  const split = milestoneSplit(data, all.data?.counts);
  const target = data?.targetDate
    ? `Target ${formatDay(data.targetDate, today ?? data.targetDate)}`
    : 'No target date';

  return (
    <Frame>
      <PlanningHeader
        projectKey={projectKey}
        section="milestones"
        title={data?.name ?? '…'}
        filter={<FilterButton fields={fields} filter={filter} onChange={setFilter} />}
        display={
          <DisplayButton
            projectKey={projectKey}
            view="list"
            groupChoices={planningGroupChoices('milestone')}
            onLayoutChange={(layout) => {
              if (layout === 'board') toBoard();
            }}
          />
        }
        actions={
          <>
            {data && !isLocked && !mirrored ? (
              <Button variant="secondary" isDisabled={!today} onPress={() => setEditing(true)}>
                Edit
              </Button>
            ) : null}
            {newTaskButton}
          </>
        }
      />
      <FilterChips
        fields={fields}
        filter={filter}
        onChange={setFilter}
        {...(tasks.data ? { matchCount: view.shown.length } : {})}
      />
      <div className="min-h-0 flex-1 overflow-auto">
        <PageHead className="pt-5.5">
          {data ? (
            <>
              <PageKind kind="milestone">
                Milestone
                {data.backlogId || isLocked ? <SourceBadge /> : null}
              </PageKind>
              <PageTitle>{data.name}</PageTitle>
              <div className="flex flex-wrap items-end gap-x-6 gap-y-3">
                <div className="min-w-0 flex-1 basis-120 text-md leading-prose text-fg-2">
                  {data.description ? (
                    <Markdown source={data.description} size="page" className="max-w-190" />
                  ) : (
                    <span className="text-fg-3">No description.</span>
                  )}
                </div>
                <Stats items={milestoneStats(data)} />
              </div>
              <StatusBar split={split} label="Milestone progress" className="mt-1.5" />
              <StatusLegend split={split} end={<LegendEnd text={target} view={view} />} />
            </>
          ) : (
            <div aria-busy="true" className="flex flex-col gap-3">
              <Skeleton width={120} height={10} />
              <Skeleton width={320} height={24} />
              <Skeleton width="60%" />
              <Skeleton height={8} />
            </div>
          )}
        </PageHead>
        {tasks.isError && !tasks.data ? (
          <LoadError
            what="the tasks"
            error={tasks.error}
            onRetry={() => void tasks.refetch()}
            isRetrying={tasks.isFetching}
          />
        ) : (
          <PlanningTaskTable
            aria-label={`Tasks in ${data?.name ?? 'the milestone'}`}
            projectKey={projectKey}
            tasks={view.shown}
            display={display}
            from="Milestone"
            hide="milestone"
            isLoading={tasks.isPending}
            renderEmptyState={() => (
              <EmptyTasks
                text={
                  view.filtered
                    ? 'No tasks in this milestone match these filters.'
                    : view.hiddenClosed
                      ? 'Every task in this milestone is done.'
                      : 'No tasks in this milestone yet. Set the milestone from a task, or create one here.'
                }
                action={
                  view.filtered ? (
                    <Button variant="secondary" size="sm" onPress={() => setFilter(clearedFilter(filter))}>
                      Clear filters
                    </Button>
                  ) : view.hiddenClosed ? null : (
                    <Button variant="secondary" size="sm" onPress={newTask}>
                      New task
                    </Button>
                  )
                }
              />
            )}
          />
        )}
      </div>
      {data && today ? (
        <EditMilestoneDialog
          projectKey={projectKey}
          milestone={data}
          isOpen={editing}
          onClose={() => setEditing(false)}
          today={today}
        />
      ) : null}
    </Frame>
  );
}

function Frame({ children }: { children: ReactNode }) {
  return (
    <section aria-label="Milestone" className="flex h-dvh min-h-0 min-w-0 flex-1 flex-col bg-bg text-fg">
      {children}
    </section>
  );
}

/** "Target Nov 14 · done tasks hidden": the hidden part shows them, and hides them again. */
export function LegendEnd({
  text,
  view,
}: {
  text: string;
  view: { hiddenClosed: number; showClosed: boolean; setShowClosed: (show: boolean) => void };
}) {
  const toggle =
    view.hiddenClosed > 0 ? (
      <button
        type="button"
        onClick={() => view.setShowClosed(true)}
        aria-label={`Show ${view.hiddenClosed} done ${view.hiddenClosed === 1 ? 'task' : 'tasks'}`}
        className="cursor-pointer rounded-sm text-fg-3 outline-none hover:text-fg hover:underline focus-visible:shadow-[var(--focus-ring)]"
      >
        done tasks hidden
      </button>
    ) : view.showClosed ? (
      <button
        type="button"
        onClick={() => view.setShowClosed(false)}
        className="cursor-pointer rounded-sm text-fg-3 outline-none hover:text-fg hover:underline focus-visible:shadow-[var(--focus-ring)]"
      >
        hide done tasks
      </button>
    ) : null;
  return (
    <span>
      {text}
      {toggle ? <> · {toggle}</> : null}
    </span>
  );
}

export function EmptyTasks({ text, action }: { text: string; action?: ReactNode }) {
  return (
    <div className="flex flex-col items-start gap-2.5 px-4.5 py-8 text-md text-fg-2">
      <span>{text}</span>
      {action}
    </div>
  );
}
