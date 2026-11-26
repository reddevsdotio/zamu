import { useQueries, useQuery } from '@tanstack/react-query';
import { useNavigate } from '@tanstack/react-router';
import type { Cycle } from '@zamu/contracts';
import { type MouseEvent, useMemo, useState } from 'react';
import { Link } from 'react-aria-components';
import { ProjectHeader, useProjectSummary } from '~/features/project-header';
import { useOptionalQuickCreate } from '~/features/shell/quick-create';
import { useApi, useWorkspaceSlug } from '~/lib/workspace';
import { type WorkspaceUrlSlug, workspacePath } from '~/lib/workspace-paths';
import { Button, cn, Pill, Skeleton, useHotkeys } from '~/ui';
import { cycleDefaults } from './CycleDialog';
import { NewCycleDialog } from './CycleDialogHost';
import {
  describeStart,
  formatLength,
  formatLengthSentence,
  formatLongWeekdayDay,
  formatShortRange,
  lengthInDays,
  weekday,
} from './dates';
import { FeatureOff } from './FeatureOff';
import {
  LoadError,
  PageHead,
  PageMeta,
  PageTitle,
  PLAN_ROW_GRID,
  PlanIcon,
  PlanListHead,
  RowBar,
  Stats,
  StatusBar,
  StatusLegend,
  splitOf,
  splitTotal,
  useServerToday,
} from './parts';
import { cycleQuery, cyclesQuery } from './queries';

// /p/HBR/cycles (frame 109): the current cycle card (dates, "day 8 of 14", segmented progress with its
// legend, the scope note and the numbers), then the upcoming and completed cycles with what carried
// over. Cycles are app-side even in mirrored projects, so New cycle is always there (notes.md call 3).

const WEEKDAYS = ['Sundays', 'Mondays', 'Tuesdays', 'Wednesdays', 'Thursdays', 'Fridays', 'Saturdays'];
/** Completed cycles whose carry-over note reads the cycle detail ("moved to Cycle 12"). */
const DETAILED_COMPLETED = 12;

export function cycleHref(workspace: WorkspaceUrlSlug, projectKey: string, number: number): string {
  return workspacePath(workspace, `/p/${encodeURIComponent(projectKey)}/cycles/${number}`);
}

export function cycleTitle(cycle: Pick<Cycle, 'number' | 'name'>): string {
  return cycle.name ? `Cycle ${cycle.number} · ${cycle.name}` : `Cycle ${cycle.number}`;
}

/** Day of a current cycle: 8 on the eighth day. daysLeft counts today. */
export function cycleDay(cycle: Pick<Cycle, 'startsOn' | 'endsOn' | 'daysLeft'>): number {
  const length = lengthInDays(cycle.startsOn, cycle.endsOn);
  return cycle.daysLeft == null ? 0 : Math.max(1, Math.min(length, length - cycle.daysLeft + 1));
}

/** Days gone in a current cycle before today: 7 on the eighth day. */
export function elapsedDays(cycle: Pick<Cycle, 'startsOn' | 'endsOn' | 'daysLeft'>): number {
  return Math.max(0, cycleDay(cycle) - 1);
}

/** Whole days after today: 6 on day 8 of 14. */
export function daysAfterToday(cycle: Pick<Cycle, 'daysLeft'>): number {
  return Math.max(0, (cycle.daysLeft ?? 1) - 1);
}

export interface SplitCycles {
  current: Cycle | undefined;
  upcoming: Cycle[];
  completed: Cycle[];
}

/** Current, upcoming (soonest first) and completed (latest first). */
export function splitCycles(cycles: readonly Cycle[]): SplitCycles {
  return {
    current: cycles.find((cycle) => cycle.state === 'current'),
    upcoming: cycles
      .filter((cycle) => cycle.state === 'upcoming')
      .sort((a, b) => a.startsOn.localeCompare(b.startsOn)),
    completed: cycles.filter((cycle) => cycle.state === 'completed').sort((a, b) => b.number - a.number),
  };
}

/** "Two weeks, starting Mondays", from the latest cycle. */
export function cadenceText(cycles: readonly Pick<Cycle, 'number' | 'startsOn' | 'endsOn'>[]): string | null {
  const latest = [...cycles].sort((a, b) => b.number - a.number)[0];
  if (!latest) return null;
  const length = lengthInDays(latest.startsOn, latest.endsOn);
  const words = length % 7 === 0 ? formatLengthSentence(length) : capitalize(formatLength(length));
  return `${words}, starting ${WEEKDAYS[weekday(latest.startsOn)]}`;
}

function capitalize(text: string): string {
  return text.charAt(0).toUpperCase() + text.slice(1);
}

/** The note under a cycle's name in the list. */
export function cycleNoteText(
  cycle: Cycle,
  today: string | null,
  movedTo?: readonly (number | null)[],
): string {
  if (cycle.state === 'upcoming') {
    const planned = `${cycle.counts.total} ${cycle.counts.total === 1 ? 'task' : 'tasks'} planned`;
    return today ? `${describeStart(cycle.startsOn, today)} · ${planned}` : planned;
  }
  if (cycle.state === 'current') return 'In progress';
  const moved = cycle.summary?.rolledOver ?? 0;
  if (!moved) return 'Everything done';
  const tasks = `${moved} unfinished ${moved === 1 ? 'task' : 'tasks'}`;
  const targets = [...new Set(movedTo ?? [])];
  if (!movedTo?.length) return `${tasks} rolled over`;
  const words = targets.map((number) => (number == null ? 'no cycle' : `Cycle ${number}`)).join(' and ');
  return `${tasks} moved to ${words}`;
}

function isControl(target: EventTarget | null): boolean {
  return target instanceof Element && target.closest('a, button, input, textarea, select') != null;
}

export function CyclesScreen({ projectKey }: { projectKey: string }) {
  const workspace = useWorkspaceSlug();
  const api = useApi();
  const navigate = useNavigate();
  const quickCreate = useOptionalQuickCreate();
  const project = useProjectSummary(projectKey);
  const cycles = useQuery(cyclesQuery(api, projectKey));
  const today = useServerToday(projectKey);
  const [creating, setCreating] = useState(false);
  const [focused, setFocused] = useState<number | null>(null);

  const isOff = project != null && !project.usesCycles;
  const items = cycles.data?.items;
  const split = useMemo(() => (items ? splitCycles(items) : undefined), [items]);
  const others = useMemo(() => (split ? [...split.upcoming, ...split.completed] : []), [split]);

  // What the latest completed cycles carried over, and where to: their detail has the record.
  const detailed =
    split?.completed.filter((cycle) => cycle.summary?.rolledOver).slice(0, DETAILED_COMPLETED) ?? [];
  const details = useQueries({
    queries: detailed.map((cycle) => ({
      ...cycleQuery(api, projectKey, cycle.number),
      staleTime: 10 * 60_000,
    })),
  });
  const movedTo = new Map<number, (number | null)[]>();
  detailed.forEach((cycle, index) => {
    const detail = details[index]?.data;
    if (detail)
      movedTo.set(
        cycle.number,
        detail.rollovers.map((roll) => roll.movedTo?.number ?? null),
      );
  });

  const rowNumbers = useMemo(
    () => [...(split?.current ? [split.current.number] : []), ...others.map((cycle) => cycle.number)],
    [split, others],
  );
  const move = (step: 1 | -1) => {
    if (!rowNumbers.length) return;
    const index = focused == null ? -1 : rowNumbers.indexOf(focused);
    const next = index < 0 ? (step > 0 ? 0 : rowNumbers.length - 1) : index + step;
    setFocused(rowNumbers[Math.max(0, Math.min(rowNumbers.length - 1, next))] ?? null);
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
          if (focused == null || isControl(event.target)) return;
          event.preventDefault();
          void navigate({ href: cycleHref(workspace, projectKey, focused) });
        },
      },
      Escape: { preventDefault: false, handler: () => setFocused(null) },
    },
    { enabled: rowNumbers.length > 0 },
  );

  const body = () => {
    if (isOff) return <FeatureOff projectKey={projectKey} feature="cycles" />;
    if (cycles.isError && !cycles.data) {
      return (
        <LoadError
          what="cycles"
          error={cycles.error}
          onRetry={() => void cycles.refetch()}
          isRetrying={cycles.isFetching}
        />
      );
    }
    if (cycles.isPending || !split) return <CurrentCardSkeleton />;
    if (!items?.length) {
      const first = today ? cycleDefaults([], today) : null;
      return (
        <div className="flex px-4.5 py-12">
          <div className="flex max-w-125 flex-col items-start gap-3">
            <h3 className="m-0 font-serif text-xl leading-tight font-medium">Work in fixed-length cycles</h3>
            <p className="m-0 leading-prose text-fg-2">
              A cycle is a sprint with a start and an end date. Put the tasks you mean to finish in it. When
              it ends, anything unfinished moves to the next cycle and the finished cycle keeps a record of
              what moved.
            </p>
            <Button isDisabled={!today} onPress={() => setCreating(true)}>
              Start Cycle 1
            </Button>
            {first ? (
              <p className="m-0 text-xs text-fg-3">
                {formatLengthSentence(lengthInDays(first.startsOn, first.endsOn))} from{' '}
                {formatLongWeekdayDay(first.startsOn)}. You can change the length.
              </p>
            ) : null}
          </div>
        </div>
      );
    }
    return (
      <div className="flex min-h-0 flex-1 flex-col overflow-auto">
        {split.current ? (
          <CurrentCycleCard
            projectKey={projectKey}
            cycle={split.current}
            isFocused={focused === split.current.number}
            onFocus={() => setFocused(split.current?.number ?? null)}
          />
        ) : null}
        {others.length ? (
          <>
            <h3 className="m-0 px-4.5 pt-4.5 pb-1.5 text-xs font-medium text-fg-3">
              {split.current ? 'Other cycles' : 'Cycles'}
            </h3>
            <PlanListHead first="Cycle" date="Dates" />
            <ul aria-label="Other cycles" className="m-0 list-none border-t border-line-soft p-0">
              {others.map((cycle) => (
                <CycleRow
                  key={cycle.id}
                  projectKey={projectKey}
                  cycle={cycle}
                  note={cycleNoteText(cycle, today, movedTo.get(cycle.number))}
                  isFocused={focused === cycle.number}
                  onFocus={() => setFocused(cycle.number)}
                />
              ))}
            </ul>
          </>
        ) : null}
      </div>
    );
  };

  const cadence = items ? cadenceText(items) : null;

  return (
    <section aria-label="Cycles" className="flex h-dvh min-h-0 min-w-0 flex-1 flex-col bg-bg text-fg">
      <ProjectHeader
        projectKey={projectKey}
        current="cycles"
        actions={
          isOff ? undefined : (
            <>
              <Button variant="secondary" isDisabled={!today || !items} onPress={() => setCreating(true)}>
                New cycle
              </Button>
              <Button kbd="C" aria-keyshortcuts="c" onPress={() => quickCreate?.open(projectKey)}>
                New task
              </Button>
            </>
          )
        }
      />
      {isOff ? null : (
        <PageHead>
          <PageTitle as="h2">Cycles</PageTitle>
          <PageMeta>
            {cadence ? <span>{cadence}</span> : null}
            <span className="text-fg-3">Unfinished tasks move to the next cycle when one ends.</span>
          </PageMeta>
        </PageHead>
      )}
      {body()}
      {today && items ? (
        <NewCycleDialog
          projectKey={projectKey}
          cycles={items}
          isOpen={creating}
          onClose={() => setCreating(false)}
          today={today}
        />
      ) : null}
    </section>
  );
}

// ---------------------------------------------------------------------------
// Current cycle card (.cyc-cur)
// ---------------------------------------------------------------------------

export interface CurrentCycleCardProps {
  projectKey: string;
  cycle: Cycle;
  isFocused?: boolean;
  onFocus?: () => void;
}

export function CurrentCycleCard({ projectKey, cycle, isFocused, onFocus }: CurrentCycleCardProps) {
  const workspace = useWorkspaceSlug();
  const navigate = useNavigate();
  const href = cycleHref(workspace, projectKey, cycle.number);
  const { counts } = cycle;
  const split = splitOf(counts);
  const scope = splitTotal(split);
  const length = lengthInDays(cycle.startsOn, cycle.endsOn);
  const added = counts.addedAfterStart;
  const onClick = (event: MouseEvent<HTMLElement>) => {
    if ((event.target as Element).closest('a, button')) return;
    if (window.getSelection()?.toString()) return;
    void navigate({ href });
  };
  return (
    // biome-ignore lint/a11y/useKeyWithClickEvents: the title link is the keyboard path
    <section
      aria-label={`Current cycle: Cycle ${cycle.number}`}
      onClick={onClick}
      className={cn(
        'mx-4.5 mt-4 mb-1.5 grid shrink-0 cursor-pointer grid-cols-[minmax(0,1fr)_auto] gap-3.5 rounded-lg bg-surface px-4.5 py-4 shadow-card',
        isFocused && 'shadow-[0_0_0_2px_var(--accent),var(--shadow-card)]',
      )}
    >
      <div className="flex min-w-0 flex-col gap-2.5">
        <div className="flex min-w-0 items-baseline gap-2.5">
          <Link
            href={href}
            onFocus={onFocus}
            className="shrink-0 cursor-pointer rounded-sm font-serif text-xl font-medium text-fg outline-none focus-visible:shadow-[var(--focus-ring)]"
          >
            {cycleTitle(cycle)}
          </Link>
          <Pill tone="accent" className="self-center">
            Current
          </Pill>
          <span className="truncate text-sm text-fg-3">
            {formatShortRange(cycle.startsOn, cycle.endsOn)}
            {cycle.daysLeft != null ? ` · day ${cycleDay(cycle)} of ${length}` : ''}
          </span>
        </div>
        <StatusBar split={split} label={`Cycle ${cycle.number} progress`} />
        <StatusLegend split={split} />
        {added ? (
          <p className="m-0 text-xs text-fg-3">
            {added} {added === 1 ? 'task' : 'tasks'} added after the cycle started
          </p>
        ) : null}
      </div>
      <Stats
        className="self-start"
        items={[
          { value: scope, label: 'in scope' },
          { value: counts.done, label: 'done' },
          { value: daysAfterToday(cycle), label: daysAfterToday(cycle) === 1 ? 'day left' : 'days left' },
        ]}
      />
    </section>
  );
}

function CurrentCardSkeleton() {
  return (
    <div
      role="status"
      aria-busy="true"
      aria-label="Loading cycles"
      className="mx-4.5 mt-4 flex flex-col gap-3 rounded-lg bg-surface px-4.5 py-4 shadow-card"
    >
      <Skeleton width={220} height={14} />
      <Skeleton height={8} />
      <Skeleton width={300} height={8} />
    </div>
  );
}

// ---------------------------------------------------------------------------
// Rows
// ---------------------------------------------------------------------------

interface CycleRowProps {
  projectKey: string;
  cycle: Cycle;
  note: string;
  isFocused: boolean;
  onFocus: () => void;
}

function CycleRow({ projectKey, cycle, note, isFocused, onFocus }: CycleRowProps) {
  const workspace = useWorkspaceSlug();
  const navigate = useNavigate();
  const href = cycleHref(workspace, projectKey, cycle.number);
  const completed = cycle.state === 'completed';
  const scope = completed && cycle.summary ? cycle.summary.scope : cycle.counts.total - cycle.counts.canceled;
  const done = completed && cycle.summary ? cycle.summary.completed : cycle.counts.done;
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
      <PlanIcon kind="cycle" className="ml-0.5" />
      <span className="flex min-w-0 flex-col gap-0.5">
        <Link
          href={href}
          onFocus={onFocus}
          className="w-fit max-w-full cursor-pointer truncate rounded-sm text-md font-semibold text-fg outline-none focus-visible:shadow-[var(--focus-ring)]"
        >
          {cycleTitle(cycle)}
        </Link>
        <span className="truncate text-xs text-fg-3">{note}</span>
      </span>
      {completed ? (
        <RowBar done={done} total={scope} label={`Cycle ${cycle.number} result`} />
      ) : (
        <RowBar done={0} total={0} label={`Cycle ${cycle.number} progress`} />
      )}
      <span className="truncate text-sm text-fg-2 tabular-nums">
        {formatShortRange(cycle.startsOn, cycle.endsOn)}
      </span>
      <span className="text-sm text-fg-2 tabular-nums">{completed ? `${done} of ${scope}` : scope}</span>
      <span className="justify-self-end">
        <Pill>{completed ? 'Completed' : cycle.state === 'current' ? 'Current' : 'Upcoming'}</Pill>
      </span>
    </li>
  );
}
