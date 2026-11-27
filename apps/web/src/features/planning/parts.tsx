import { ORPCError } from '@orpc/client';
import type { StatusCounts } from '@zamu/contracts';
import type { ReactNode } from 'react';
import { Button as AriaButton } from 'react-aria-components';
import { useProjectSummary } from '~/features/project-header';
import { useNow } from '~/features/tasks/clock';
import { describeError } from '~/features/tasks/errors';
import { Banner, Button, CaretGlyph, CycleGlyph, cn, MilestoneGlyph } from '~/ui';
import { planningToday } from './dates';

// Pieces shared by the milestone and cycle screens (frames 107 to 114; screens.css .page-hd, .ms-row,
// .stat, .seg-bar, .legend): error banners, the page head with its stats and segmented bar, the rows of
// the milestone and cycle lists, and their folding group.

/** The sentence after "Couldn't load milestones." */
export function loadErrorText(error: unknown): string {
  if (error instanceof ORPCError && error.status >= 500) return 'The server returned an error.';
  if (error instanceof TypeError) return 'Check your connection and try again.';
  const { message } = describeError(error);
  return message === 'The server could not be reached.' ? 'Check your connection and try again.' : message;
}

export interface LoadErrorProps {
  /** "milestones", "cycles", "this milestone". */
  what: string;
  error: unknown;
  onRetry: () => void;
  isRetrying?: boolean;
}

export function LoadError({ what, error, onRetry, isRetrying }: LoadErrorProps) {
  return (
    <div className="px-4.5 py-4">
      <Banner
        action={
          <Button variant="secondary" size="sm" isPending={isRetrying} onPress={onRetry}>
            Retry
          </Button>
        }
      >
        Couldn't load {what}. {loadErrorText(error)}
      </Banner>
    </div>
  );
}

/** Today in the server's time zone once hydrated; null during SSR and hydration. */
export function useServerToday(projectKey: string): string | null {
  const now = useNow();
  const project = useProjectSummary(projectKey);
  if (now == null) return null;
  return planningToday(now, project?.currentCycle ?? null);
}

// ---------------------------------------------------------------------------
// Page head
// ---------------------------------------------------------------------------

/** The block under the view header: title, meta or description, stats, bar (.page-hd). */
export function PageHead({ children, className }: { children: ReactNode; className?: string }) {
  return (
    <div
      className={cn('flex shrink-0 flex-col gap-2 border-b border-line-soft px-4.5 pt-6.5 pb-3.5', className)}
    >
      {children}
    </div>
  );
}

/** Serif page title (.page-t). The list pages use `h2`: the project header holds their `h1`. */
export function PageTitle({
  children,
  as: Tag = 'h1',
  className,
}: {
  children: ReactNode;
  as?: 'h1' | 'h2';
  className?: string;
}) {
  return (
    <Tag className={cn('m-0 font-serif text-2xl leading-tight font-medium text-fg', className)}>
      {children}
    </Tag>
  );
}

/** "2 open  1 completed  Milestones come from Backlog.md…" (.page-meta). */
export function PageMeta({ children }: { children: ReactNode }) {
  return <div className="flex flex-wrap items-center gap-x-3.5 gap-y-1 text-sm text-fg-2">{children}</div>;
}

/** "Milestone [Backlog.md]", "Cycle · current" over the page title. */
export function PageKind({ kind, children }: { kind: 'milestone' | 'cycle'; children: ReactNode }) {
  return (
    <div className="flex items-center gap-2 text-sm text-fg-3">
      <PlanIcon kind={kind} />
      {children}
    </div>
  );
}

/** The outline diamond or circle of the list rows and page heads (screens.css .dl-ico). */
export function PlanIcon({ kind, className }: { kind: 'milestone' | 'cycle'; className?: string }) {
  return kind === 'milestone' ? (
    <MilestoneGlyph size={9} className={cn('mx-0.5 rounded-[1.5px] text-fg-2', className)} />
  ) : (
    <CycleGlyph size={12} className={cn('text-fg-2', className)} />
  );
}

export interface StatItem {
  value: ReactNode;
  label: string;
}

/** "30 tasks  18 done  11 days left": serif numbers with a caption (.stat). */
export function Stats({ items, className }: { items: readonly StatItem[]; className?: string }) {
  return (
    <dl className={cn('m-0 flex shrink-0 gap-6.5', className)}>
      {items.map((item) => (
        <div key={item.label} className="flex flex-col-reverse gap-0.5">
          <dt className="text-xs text-fg-3">{item.label}</dt>
          <dd className="m-0 font-serif text-xl leading-tight font-medium text-fg tabular-nums">
            {item.value}
          </dd>
        </div>
      ))}
    </dl>
  );
}

/** Task counts as the segmented bar shows them: done, in review, in progress, and the rest. */
export interface StatusSplit {
  done: number;
  review: number;
  progress: number;
  /** Backlog and Todo. */
  todo: number;
}

export function splitOf(counts: Pick<StatusCounts, keyof StatusCounts>): StatusSplit {
  return {
    done: counts.done,
    review: counts.in_review,
    progress: counts.in_progress,
    todo: counts.todo + counts.backlog,
  };
}

export function splitTotal(split: StatusSplit): number {
  return split.done + split.review + split.progress + split.todo;
}

const SEGMENTS = [
  { part: 'done', label: 'Done', fill: 'bg-status-done' },
  { part: 'review', label: 'In review', fill: 'bg-status-rev' },
  { part: 'progress', label: 'In progress', fill: 'bg-status-prog' },
] as const;

const pct = (part: number, total: number) => (total > 0 ? `${(part / total) * 100}%` : '0%');

/** 8px bar: done, in review, in progress on --line (.seg-bar). */
export function StatusBar({
  split,
  label,
  className,
}: {
  split: StatusSplit;
  label: string;
  className?: string;
}) {
  const total = splitTotal(split);
  return (
    <div
      role="img"
      aria-label={`${label}: ${split.done} done, ${split.review} in review, ${split.progress} in progress, ${split.todo} to do`}
      className={cn('flex h-2 min-w-10 overflow-hidden rounded-full bg-line', className)}
    >
      {SEGMENTS.map((segment) => (
        <span
          key={segment.part}
          data-part={segment.part}
          className={cn('block h-full', segment.fill)}
          style={{ width: pct(split[segment.part], total) }}
        />
      ))}
    </div>
  );
}

/** "■ Done 9  ■ In review 5  ■ In progress 4  ■ Todo 6", then `end` on the right (.legend). */
export function StatusLegend({ split, end }: { split: StatusSplit; end?: ReactNode }) {
  const items = [...SEGMENTS, { part: 'todo', label: 'Todo', fill: 'bg-line' } as const];
  return (
    <div className="flex flex-wrap items-center gap-x-3.5 gap-y-1 text-xs text-fg-3">
      {items.map((item) => (
        <span key={item.part} aria-hidden className="inline-flex items-center gap-1.25 tabular-nums">
          <i className={cn('inline-block size-2 rounded-[2px]', item.fill)} />
          {item.label} {split[item.part]}
        </span>
      ))}
      {end ? <span className="ml-auto">{end}</span> : null}
    </div>
  );
}

// ---------------------------------------------------------------------------
// Milestone and cycle lists (.ms-row)
// ---------------------------------------------------------------------------

/** Icon, name, progress, date, tasks, pill. */
export const PLAN_ROW_GRID =
  'grid grid-cols-[18px_minmax(0,1fr)_160px_200px_120px_90px] items-center gap-3.5 px-4.5 max-[1180px]:grid-cols-[18px_minmax(0,1fr)_140px_150px_80px_90px]';

export function PlanListHead({ first, date }: { first: string; date: string }) {
  return (
    <div aria-hidden className={cn(PLAN_ROW_GRID, 'h-8.5 shrink-0 text-xs font-medium text-fg-3')}>
      <span />
      <span>{first}</span>
      <span>Progress</span>
      <span>{date}</span>
      <span>Tasks</span>
      <span />
    </div>
  );
}

/** Done share of a row (.bar.wide): 4px, done only. Empty with `total` 0. */
export function RowBar({ done, total, label }: { done: number; total: number; label: string }) {
  const percent = total > 0 ? Math.round((done / total) * 100) : null;
  return (
    <span className="flex min-w-0 items-center gap-2.5 text-sm text-fg-2 tabular-nums">
      <span
        role="progressbar"
        aria-label={label}
        aria-valuemin={0}
        aria-valuemax={100}
        aria-valuenow={percent ?? 0}
        className="relative h-1 min-w-10 flex-1 overflow-hidden rounded-full bg-line"
      >
        <span
          className="absolute inset-y-0 left-0 rounded-full bg-status-done"
          style={{ width: `${percent ?? 0}%` }}
        />
      </span>
      <span aria-hidden className="w-9 shrink-0 text-right">
        {percent == null ? '' : `${percent}%`}
      </span>
    </span>
  );
}

export interface FoldGroupProps {
  label: string;
  count: number;
  expanded: boolean;
  onToggle: () => void;
  /** Glyph before the label (a task status). */
  glyph?: ReactNode;
  /** M8: an action at the end of the row ("+ Add waves"). */
  end?: ReactNode;
  className?: string;
}

/** "▸ Completed 1": a 40px group row that folds what follows (.grp). ← and → fold and unfold it too. */
export function FoldGroup({ label, count, expanded, onToggle, glyph, end, className }: FoldGroupProps) {
  if (end) {
    // An action at the end of the row ("+ Add waves", M8): drawn over the row, outside its button. The
    // row's top margin collapses through the wrapper, so the action sits at its top.
    return (
      <div className="relative">
        <FoldGroup
          label={label}
          count={count}
          expanded={expanded}
          onToggle={onToggle}
          glyph={glyph}
          className={className}
        />
        <span className="absolute top-0 right-4.5 flex h-10 items-center">{end}</span>
      </div>
    );
  }
  return (
    <AriaButton
      aria-expanded={expanded}
      onPress={onToggle}
      onKeyDown={(event) => {
        if ((event.key === 'ArrowLeft' && expanded) || (event.key === 'ArrowRight' && !expanded)) {
          event.preventDefault();
          onToggle();
        }
      }}
      className={cn(
        'mt-1.5 flex h-10 w-full shrink-0 cursor-pointer items-center gap-2.25 border-b border-line pr-4.5 pl-4 text-left text-md font-medium text-fg outline-none',
        'hover:bg-surface-hover focus-visible:shadow-[inset_0_0_0_2px_var(--accent)]',
        className,
      )}
    >
      <CaretGlyph className={cn('mr-0.5 transition-transform', !expanded && '-rotate-90')} />
      {glyph}
      <span>{label}</span>
      <span className="font-normal text-fg-3 tabular-nums">{count}</span>
    </AriaButton>
  );
}
