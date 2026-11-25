import { cn } from './cn';
import { CheckGlyph } from './Glyphs';

/*
 * Blocked marker, subtask progress and criteria progress (margin.css .blk, .subp, .ring; m6.css .critp).
 */

export interface BlockedMarkerProps {
  /** Open blockers. The marker shows while any is open; with 0 it renders nothing. Omit when unknown. */
  count?: number;
  className?: string;
}

/** 20px --danger-soft pill "Blocked" on cards and rows. The count goes into the accessible name. */
export function BlockedMarker({ count, className }: BlockedMarkerProps) {
  if (count === 0) return null;
  return (
    <span
      data-blocked
      title={count != null ? `Blocked by ${count} open ${count === 1 ? 'task' : 'tasks'}` : undefined}
      className={cn(
        'inline-flex h-5 shrink-0 items-center rounded-pill bg-danger-soft px-1.75 text-xs font-semibold whitespace-nowrap text-danger',
        className,
      )}
    >
      Blocked
      {count != null ? (
        <span className="sr-only">
          {' '}
          by {count} open {count === 1 ? 'task' : 'tasks'}
        </span>
      ) : null}
    </span>
  );
}

/** The task view's line over the properties: "Blocked  by 2 open tasks" on --danger-soft. */
export function BlockedNotice({ count, className }: { count: number; className?: string }) {
  if (count <= 0) return null;
  return (
    <div
      role="note"
      className={cn(
        'flex items-center gap-3.5 rounded-md bg-danger-soft px-4 py-2.5 text-sm text-danger',
        className,
      )}
    >
      <b className="font-semibold">Blocked</b>
      <span className="font-medium">
        by {count} open {count === 1 ? 'task' : 'tasks'}
      </span>
    </div>
  );
}

/** 11px progress ring: --status-done arc on a --line track. Decorative; pair it with the count. */
export function SubtaskRing({
  done,
  total,
  size = 11,
  className,
}: {
  done: number;
  total: number;
  size?: number;
  className?: string;
}) {
  const share = total > 0 ? Math.max(0, Math.min(1, done / total)) : 0;
  const radius = 4.1;
  const length = 2 * Math.PI * radius;
  return (
    <svg
      aria-hidden
      viewBox="0 0 11 11"
      width={size}
      height={size}
      fill="none"
      className={cn('shrink-0 -rotate-90', className)}
    >
      <circle cx="5.5" cy="5.5" r={radius} strokeWidth="2.8" className="stroke-line" />
      {share > 0 ? (
        <circle
          cx="5.5"
          cy="5.5"
          r={radius}
          strokeWidth="2.8"
          className="stroke-status-done"
          strokeDasharray={`${share * length} ${length}`}
        />
      ) : null}
    </svg>
  );
}

export interface SubtaskProgressProps {
  /** Done subtasks (canceled ones excluded from both numbers by the caller). */
  done: number;
  total: number;
  /** `short` (default): "2/7" on cards and rows. `long`: "3 of 4 done" in the task view. */
  format?: 'short' | 'long';
  className?: string;
}

/** Ring plus count. Accessible name "2 of 7 subtasks done". */
export function SubtaskProgress({ done, total, format = 'short', className }: SubtaskProgressProps) {
  const label = `${done} of ${total} subtasks done`;
  return (
    <span
      role="img"
      aria-label={label}
      data-subtasks={`${done}/${total}`}
      className={cn(
        'inline-flex shrink-0 items-center gap-1.25 text-xs whitespace-nowrap text-fg-2 tabular-nums',
        format === 'long' && 'font-semibold',
        className,
      )}
    >
      <SubtaskRing done={done} total={total} />
      <span aria-hidden>{format === 'long' ? `${done} of ${total} done` : `${done}/${total}`}</span>
    </span>
  );
}

export interface ProgressMarkProps {
  /** Items settled: checked plus waived (WorkItemProgress.settled). */
  settled: number;
  /** Waived items among the settled ones (WorkItemProgress.waived). The count shows checked items only. */
  waived?: number;
  /** Open items (WorkItemProgress.open). Not drawn; accepted so a WorkItemProgress can be spread in. */
  open?: number;
  /** All items. With 0 the mark renders nothing: a task without criteria shows no marker. */
  total: number;
  /**
   * `short` (default): "4/6" on rows and cards. `long`: "4 of 6" in section headers, the sidebar and the
   * peek's chips.
   */
  format?: 'short' | 'long';
  /** What is counted, for the accessible name and for `showNoun`: "criteria", "done items". */
  noun?: string;
  /** Write the noun after the count: "4 of 6 criteria" (peek chips). */
  showNoun?: boolean;
  className?: string;
}

/**
 * Criteria or done-item progress (m6.css .critp + .cbx): an 11px box and the count of checked items, as in
 * frame 001 ("4 of 6" with one waived and one open). The box fills with --status-done and a tick once every
 * item is checked or waived, so complete never rests on colour alone. Accessible name: "4 of 6 criteria
 * checked, 1 waived", or "All 6 criteria checked or waived".
 */
export function ProgressMark({
  settled,
  waived = 0,
  total,
  format = 'short',
  noun = 'items',
  showNoun = false,
  className,
}: ProgressMarkProps) {
  if (total <= 0) return null;
  const done = Math.max(0, Math.min(settled, total));
  const skipped = Math.max(0, Math.min(waived, done));
  const checked = done - skipped;
  const complete = done === total;
  const count = format === 'long' ? `${checked} of ${total}` : `${checked}/${total}`;
  const label = complete
    ? `All ${total} ${noun} ${skipped ? 'checked or waived' : 'checked'}`
    : `${checked} of ${total} ${noun} checked${skipped ? `, ${skipped} waived` : ''}`;
  return (
    <span
      role="img"
      aria-label={label}
      data-progress={`${checked}/${total}`}
      data-complete={complete || undefined}
      className={cn(
        'inline-flex shrink-0 items-center gap-1.25 text-xs whitespace-nowrap text-fg-2 tabular-nums',
        className,
      )}
    >
      <ProgressBox complete={complete} />
      <span aria-hidden>{showNoun ? `${count} ${noun}` : count}</span>
    </span>
  );
}

/** The 11px box of a progress mark on its own: outlined, or filled with a tick when complete. Decorative. */
export function ProgressBox({ complete, className }: { complete: boolean; className?: string }) {
  return (
    <span
      aria-hidden
      data-complete={complete || undefined}
      className={cn(
        // 3px corner: below the radius scale, like the other marks.
        'grid size-2.75 shrink-0 place-items-center rounded-[3px] border-[1.5px]',
        complete ? 'border-status-done bg-status-done text-bg' : 'border-fg-3',
        className,
      )}
    >
      {complete ? <CheckGlyph className="h-1.5 w-1.75" /> : null}
    </span>
  );
}
