import { useQuery } from '@tanstack/react-query';
import { useNavigate } from '@tanstack/react-router';
import type { CycleDetail, CycleRollover, CycleSelector, TaskListItem } from '@zamu/contracts';
import { type ReactNode, useMemo, useState } from 'react';
import { Link } from 'react-aria-components';
import { useOptionalQuickCreate } from '~/features/shell/quick-create';
import { taskListQuery } from '~/features/tasks/queries';
import { clearedFilter, DisplayButton, FilterButton, FilterChips } from '~/features/views';
import { useApi, useWorkspaceSlug } from '~/lib/workspace';
import { workspacePath } from '~/lib/workspace-paths';
import {
  Button,
  CycleGlyph,
  EmptyState,
  OPEN_STATUSES,
  type PickerItem,
  PickerPopover,
  Skeleton,
  STATUS_LABELS,
  StatusGlyph,
  useCopy,
  useHotkeys,
} from '~/ui';
import { EditCycleDialog, nextCycleNumber } from './CycleDialogHost';
import { cycleDay, cycleHref, daysAfterToday, splitCycles } from './CyclesScreen';
import { daysBetween, formatRange, formatShortRange, lengthInDays } from './dates';
import { EndCycleDialog } from './EndCycleDialog';
import { EmptyTasks, LegendEnd } from './MilestonePage';
import { PlanningHeader } from './PlanningHeader';
import { PlanningTaskTable } from './PlanningTaskTable';
import {
  FoldGroup,
  LoadError,
  PageHead,
  PageKind,
  PageTitle,
  type StatItem,
  Stats,
  StatusBar,
  StatusLegend,
  splitOf,
  useServerToday,
} from './parts';
import { cycleQuery, cyclesQuery, useAddToCycle, useEndCycle } from './queries';
import { planningGroupChoices, usePlanningTasks } from './usePlanningTasks';

// /p/HBR/cycles/12 (frame 110): kind, serif title, the cycle's goal (its name), the numbers, the
// segmented bar and legend, then its tasks in the list rows with Filter and Display. A current cycle
// has End cycle; an upcoming one has Edit. A completed cycle shows its summary, what rolled over and
// where to, then the tasks that stayed (done and canceled, folded).

/** Route param to a cycle selector: 12, current or next. */
export function parseCycleParam(value: string): CycleSelector | null {
  if (value === 'current' || value === 'next') return value;
  return /^[1-9][0-9]{0,8}$/.test(value) ? Number(value) : null;
}

export interface CyclePageProps {
  projectKey: string;
  selector: CycleSelector;
}

export function CyclePage({ projectKey, selector }: CyclePageProps) {
  const workspace = useWorkspaceSlug();
  const api = useApi();
  const navigate = useNavigate();
  const cycle = useQuery(cycleQuery(api, projectKey, selector));
  const data = cycle.data;
  const title = data ? `Cycle ${data.number}` : typeof selector === 'number' ? `Cycle ${selector}` : 'Cycle';

  if (cycle.isError && !data) {
    const missing = (cycle.error as { code?: string }).code === 'NOT_FOUND';
    return (
      <Frame label="Cycle">
        <PlanningHeader projectKey={projectKey} section="cycles" title={title} />
        {missing ? (
          <div className="flex px-4.5 py-12">
            <EmptyState
              title={
                selector === 'current'
                  ? 'No cycle is running'
                  : selector === 'next'
                    ? 'No upcoming cycle'
                    : 'This cycle does not exist'
              }
              text="Cycles of this project are listed on the Cycles page."
              action={
                <Button
                  variant="secondary"
                  onPress={() => void navigate({ href: workspacePath(workspace, `/p/${projectKey}/cycles`) })}
                >
                  All cycles
                </Button>
              }
            />
          </div>
        ) : (
          <LoadError
            what="this cycle"
            error={cycle.error}
            onRetry={() => void cycle.refetch()}
            isRetrying={cycle.isFetching}
          />
        )}
      </Frame>
    );
  }

  if (!data) {
    return (
      <Frame label="Cycle">
        <PlanningHeader projectKey={projectKey} section="cycles" title={title} />
        <PageHead>
          <div aria-busy="true" className="flex flex-col gap-3">
            <Skeleton width={120} height={10} />
            <Skeleton width={200} height={24} />
            <Skeleton height={8} />
          </div>
        </PageHead>
      </Frame>
    );
  }

  return data.state === 'completed' ? (
    <CompletedCycle projectKey={projectKey} cycle={data} />
  ) : (
    <ActiveCycle projectKey={projectKey} cycle={data} selector={selector} />
  );
}

function Frame({ label, children }: { label: string; children: ReactNode }) {
  return (
    <section aria-label={label} className="flex h-dvh min-h-0 min-w-0 flex-1 flex-col bg-bg text-fg">
      {children}
    </section>
  );
}

/** "24 in scope  9 done  6 days left", or "6 planned  starts in 4 days" for an upcoming cycle. */
export function activeCycleStats(cycle: CycleDetail, today: string | null): StatItem[] {
  const scope = cycle.counts.total - cycle.counts.canceled;
  if (cycle.state === 'current') {
    const left = daysAfterToday(cycle);
    return [
      { value: scope, label: 'in scope' },
      { value: cycle.counts.done, label: 'done' },
      { value: left, label: left === 1 ? 'day left' : 'days left' },
    ];
  }
  const items: StatItem[] = [{ value: scope, label: 'planned' }];
  if (today) {
    const days = Math.max(0, daysBetween(today, cycle.startsOn));
    items.push({ value: days, label: days === 1 ? 'day to start' : 'days to start' });
  }
  return items;
}

// ---------------------------------------------------------------------------
// Current and upcoming
// ---------------------------------------------------------------------------

interface ActiveCycleProps {
  projectKey: string;
  cycle: CycleDetail;
  selector: CycleSelector;
}

function ActiveCycle({ projectKey, cycle, selector }: ActiveCycleProps) {
  const workspace = useWorkspaceSlug();
  const api = useApi();
  const navigate = useNavigate();
  const quickCreate = useOptionalQuickCreate();
  const today = useServerToday(projectKey);
  const isCurrent = cycle.state === 'current';
  const number = cycle.number;
  const view = usePlanningTasks(projectKey, { cycle: number });
  const { filter, setFilter, fields, display, tasks, all } = view;
  const cycles = useQuery(cyclesQuery(api, projectKey));
  const [ending, setEnding] = useState(false);
  const [editing, setEditing] = useState(false);
  const end = useEndCycle();
  const from = `Cycle ${number}`;

  const unfinished = useMemo(
    () => (all.data?.items ?? []).filter((task) => task.status !== 'done' && task.status !== 'canceled'),
    [all.data],
  );
  const split = cycles.data ? splitCycles(cycles.data.items) : undefined;
  const next = split?.upcoming.find((item) => item.number !== number);
  const newTask = () => quickCreate?.open(projectKey);
  const toBoard = () =>
    void navigate({ href: workspacePath(workspace, `/p/${projectKey}?view=board&cycle=${number}`) });
  useHotkeys({ v: toBoard });

  const onEnd = async (moveTo: number | 'none' | undefined) => {
    try {
      await end.mutateAsync({ project: projectKey, number, ...(moveTo !== undefined ? { moveTo } : {}) });
    } catch (error) {
      return (error as Error).message || "Couldn't end the cycle. Try again.";
    }
    setEnding(false);
    // A "current" link would now show the next cycle: stay on this one.
    if (selector !== number) {
      void navigate({
        to: '/w/$workspace/p/$projectKey/cycles/$cycleNumber',
        params: { workspace, projectKey, cycleNumber: String(number) },
      });
    }
    return null;
  };

  const counts = splitOf(cycle.counts);
  const length = lengthInDays(cycle.startsOn, cycle.endsOn);
  const range = formatShortRange(cycle.startsOn, cycle.endsOn);
  const added = cycle.counts.addedAfterStart;

  return (
    <Frame label={from}>
      <PlanningHeader
        projectKey={projectKey}
        section="cycles"
        title={from}
        filter={<FilterButton fields={fields} filter={filter} onChange={setFilter} />}
        display={
          <DisplayButton
            projectKey={projectKey}
            view="list"
            groupChoices={planningGroupChoices('cycle')}
            onLayoutChange={(layout) => {
              if (layout === 'board') toBoard();
            }}
          />
        }
        actions={
          <>
            {isCurrent ? (
              <Button variant="secondary" isDisabled={!all.data} onPress={() => setEnding(true)}>
                End cycle
              </Button>
            ) : (
              <Button variant="secondary" isDisabled={!today} onPress={() => setEditing(true)}>
                Edit
              </Button>
            )}
            <AddTasks projectKey={projectKey} number={number} />
            <Button kbd="C" aria-keyshortcuts="c" onPress={newTask}>
              New task
            </Button>
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
          <PageKind kind="cycle">Cycle · {isCurrent ? 'current' : 'upcoming'}</PageKind>
          <PageTitle>{from}</PageTitle>
          <div className="flex flex-wrap items-end gap-x-6 gap-y-3">
            <p className="m-0 min-w-0 flex-1 basis-120 text-md leading-prose text-fg-2">
              {cycle.name ?? (
                <span className="text-fg-3">
                  {isCurrent
                    ? `Day ${cycleDay(cycle)} of ${length}.`
                    : `${length} days from ${formatRange(cycle.startsOn, cycle.endsOn)}.`}
                  {added ? ` ${added} ${added === 1 ? 'task was' : 'tasks were'} added after the start.` : ''}
                </span>
              )}
            </p>
            <Stats items={activeCycleStats(cycle, today)} />
          </div>
          <StatusBar split={counts} label={`${from} progress`} className="mt-1.5" />
          <StatusLegend split={counts} end={<LegendEnd text={range} view={view} />} />
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
            aria-label={`Tasks in ${from}`}
            projectKey={projectKey}
            tasks={view.shown}
            display={display}
            from={from}
            hide="cycle"
            isLoading={tasks.isPending}
            renderEmptyState={() => (
              <EmptyTasks
                text={
                  view.filtered
                    ? 'No tasks in this cycle match these filters.'
                    : view.hiddenClosed
                      ? 'Every task in this cycle is done.'
                      : 'No tasks in this cycle yet. Add the ones you mean to finish in it.'
                }
                action={
                  view.filtered ? (
                    <Button variant="secondary" size="sm" onPress={() => setFilter(clearedFilter(filter))}>
                      Clear filters
                    </Button>
                  ) : null
                }
              />
            )}
          />
        )}
      </div>
      {isCurrent ? (
        <EndCycleDialog
          isOpen={ending}
          onClose={() => setEnding(false)}
          cycle={cycle}
          next={next}
          newNumber={cycles.data ? nextCycleNumber(cycles.data.items) : number + 1}
          unfinished={unfinished}
          onSubmit={onEnd}
        />
      ) : today ? (
        <EditCycleDialog
          projectKey={projectKey}
          cycle={cycle}
          isOpen={editing}
          onClose={() => setEditing(false)}
          today={today}
        />
      ) : null}
    </Frame>
  );
}

/** "Add tasks": a searchable list of the project's open tasks outside this cycle; picking one moves it in. */
function AddTasks({ projectKey, number }: { projectKey: string; number: number }) {
  const api = useApi();
  const [open, setOpen] = useState(false);
  const candidates = useQuery({
    ...taskListQuery(api, { project: projectKey, status: [...OPEN_STATUSES] }),
    enabled: open,
  });
  const add = useAddToCycle();
  const items = useMemo<PickerItem[]>(
    () =>
      (candidates.data?.items ?? [])
        .filter((task) => task.cycle?.number !== number)
        .map((task) => ({
          id: task.key,
          label: task.title,
          lead: <StatusGlyph status={task.status} decorative />,
          meta: task.cycle ? `${task.key} · Cycle ${task.cycle.number}` : task.key,
          textValue: `${task.key} ${task.title}`,
        })),
    [candidates.data, number],
  );
  return (
    <PickerPopover
      aria-label={`Add tasks to Cycle ${number}`}
      items={items}
      value={null}
      isOpen={open}
      onOpenChange={setOpen}
      onChange={(key) => {
        if (key) add.mutate({ key, cycle: number });
      }}
      searchPlaceholder="Add a task to the cycle"
      emptyText={candidates.isPending ? 'Loading tasks…' : 'No open tasks outside this cycle'}
      footer={
        add.isError
          ? "Couldn't add the task. Try again."
          : 'Open tasks of the project. Picking one moves it here.'
      }
      placement="bottom end"
      width={420}
    >
      <Button variant="secondary" isPending={add.isPending}>
        Add tasks
      </Button>
    </PickerPopover>
  );
}

// ---------------------------------------------------------------------------
// Completed
// ---------------------------------------------------------------------------

/** Text copied by "Copy summary". */
export function cycleSummaryText(cycle: CycleDetail, canceled: readonly TaskListItem[]): string {
  const summary = cycle.summary;
  const title = cycle.name ? `Cycle ${cycle.number} · ${cycle.name}` : `Cycle ${cycle.number}`;
  const lines = [`${title} (${formatRange(cycle.startsOn, cycle.endsOn)})`];
  if (summary) {
    const percent = summary.scope ? Math.round((summary.completed / summary.scope) * 100) : 0;
    lines.push(
      `Scope ${summary.scope} · Completed ${summary.completed} (${percent}%) · Rolled over ${summary.rolledOver} · Canceled ${summary.canceled}`,
    );
  }
  if (cycle.rollovers.length) {
    lines.push('', 'Rolled over:');
    for (const roll of cycle.rollovers) {
      const to = roll.movedTo ? `Cycle ${roll.movedTo.number}` : 'no cycle';
      lines.push(`- ${roll.task.key} ${roll.task.title} (${STATUS_LABELS[roll.statusAtEnd]}, to ${to})`);
    }
  }
  if (canceled.length) {
    lines.push('', 'Canceled:');
    for (const task of canceled) lines.push(`- ${task.key} ${task.title}`);
  }
  return lines.join('\n');
}

/** "to Cycle 12", "to no cycle", "to Cycle 12 and no cycle". */
export function rolledOverTo(rollovers: readonly CycleRollover[]): string {
  if (!rollovers.length) return 'nothing moved';
  const targets = [
    ...new Set(rollovers.map((roll) => (roll.movedTo ? `Cycle ${roll.movedTo.number}` : 'no cycle'))),
  ];
  return `to ${targets.join(' and ')}`;
}

function CompletedCycle({ projectKey, cycle }: { projectKey: string; cycle: CycleDetail }) {
  const view = usePlanningTasks(projectKey, { cycle: cycle.number });
  const { all, display } = view;
  const { copied, copy } = useCopy();
  const [rolledOpen, setRolledOpen] = useState(true);
  const from = `Cycle ${cycle.number}`;
  const summary = cycle.summary;
  const tasks = all.data?.items ?? [];
  const canceled = tasks.filter((task) => task.status === 'canceled');
  const scope = summary?.scope ?? cycle.counts.total;
  const completed = summary?.completed ?? cycle.counts.done;
  const percent = scope ? Math.round((completed / scope) * 100) : 0;
  const rolled = summary?.rolledOver ?? cycle.rollovers.length;

  return (
    <Frame label={from}>
      <PlanningHeader
        projectKey={projectKey}
        section="cycles"
        title={from}
        actions={
          <Button variant="secondary" onPress={() => void copy(cycleSummaryText(cycle, canceled))}>
            {copied ? 'Copied' : 'Copy summary'}
          </Button>
        }
      />
      <div className="min-h-0 flex-1 overflow-auto">
        <PageHead className="pt-5.5">
          <PageKind kind="cycle">Cycle · completed</PageKind>
          <PageTitle>{from}</PageTitle>
          <div className="flex flex-wrap items-end gap-x-6 gap-y-3">
            <p className="m-0 min-w-0 flex-1 basis-120 text-md leading-prose text-fg-2">
              {cycle.name ? `${cycle.name}. ` : ''}
              <span className="text-fg-3">
                {formatShortRange(cycle.startsOn, cycle.endsOn)}. {percent}% done
                {rolled ? `, ${rolled} rolled over ${rolledOverTo(cycle.rollovers)}` : ''}.
              </span>
            </p>
            <Stats
              items={[
                { value: scope, label: 'in scope' },
                { value: completed, label: 'completed' },
                { value: rolled, label: 'rolled over' },
                { value: summary?.canceled ?? canceled.length, label: 'canceled' },
              ]}
            />
          </div>
          <StatusBar
            split={{ done: completed, review: 0, progress: 0, todo: Math.max(0, scope - completed) }}
            label={`${from} result`}
            className="mt-1.5"
          />
        </PageHead>
        <section aria-label={`Rolled over, ${cycle.rollovers.length}`}>
          <FoldGroup
            label="Rolled over"
            count={cycle.rollovers.length}
            expanded={rolledOpen}
            onToggle={() => setRolledOpen(!rolledOpen)}
          />
          {rolledOpen ? (
            cycle.rollovers.length ? (
              <ul className="m-0 list-none p-0">
                {cycle.rollovers.map((roll) => (
                  <RolloverRow key={roll.task.id} projectKey={projectKey} roll={roll} />
                ))}
              </ul>
            ) : (
              <p className="m-0 px-4.5 py-3 text-md text-fg-2">Every task was finished or canceled.</p>
            )
          ) : null}
        </section>
        {all.isError && !all.data ? (
          <LoadError
            what="the tasks"
            error={all.error}
            onRetry={() => void all.refetch()}
            isRetrying={all.isFetching}
          />
        ) : (
          <PlanningTaskTable
            aria-label={`Tasks left in ${from}`}
            projectKey={projectKey}
            tasks={tasks}
            display={{ ...display, groupBy: 'status' }}
            from={from}
            hide="cycle"
            isLoading={all.isPending}
            renderEmptyState={() => <EmptyTasks text="No tasks stayed in this cycle." />}
          />
        )}
      </div>
    </Frame>
  );
}

function RolloverRow({ projectKey, roll }: { projectKey: string; roll: CycleRollover }) {
  const workspace = useWorkspaceSlug();
  const href = workspacePath(
    workspace,
    `/p/${encodeURIComponent(projectKey)}/${encodeURIComponent(roll.task.key)}`,
  );
  return (
    <li className="flex h-9.5 items-center gap-2.5 pr-4.5 pl-4 whitespace-nowrap hover:bg-surface-hover">
      <span aria-hidden className="w-3.5 shrink-0" />
      <span className="w-15.5 shrink-0 text-xs font-medium text-fg-3 tabular-nums">{roll.task.key}</span>
      <StatusGlyph status={roll.task.status} />
      <Link
        href={href}
        className="min-w-0 flex-1 cursor-pointer truncate rounded-sm font-[450] text-fg outline-none hover:underline focus-visible:shadow-[var(--focus-ring)]"
      >
        {roll.task.title}
      </Link>
      <span className="flex shrink-0 items-center gap-1.5 text-xs text-fg-2">
        <span>{STATUS_LABELS[roll.statusAtEnd]} when it ended</span>
        <span aria-hidden className="text-fg-3">
          →
        </span>
        {roll.movedTo ? (
          <Link
            href={cycleHref(workspace, projectKey, roll.movedTo.number)}
            className="inline-flex cursor-pointer items-center gap-1.5 rounded-sm text-fg-2 outline-none hover:text-fg focus-visible:shadow-[var(--focus-ring)]"
          >
            <CycleGlyph className="text-fg-3" />
            Cycle {roll.movedTo.number}
          </Link>
        ) : (
          <span>No cycle</span>
        )}
      </span>
    </li>
  );
}
