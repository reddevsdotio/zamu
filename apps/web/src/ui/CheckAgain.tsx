import type { ReactNode } from 'react';
import { cn } from './cn';
import { daysBetween, formatShortDate } from './DueChip';
import { ClockGlyph } from './Glyphs';

/*
 * The check-again day (m7.css .chk): a task waits until a day, with a reason, and comes back on that day.
 * While it waits the chip is grey with a clock; from the day on it takes the accent colour and says how long
 * ago the day was. It never uses the overdue colour: the day is a reminder, not a deadline.
 */

export type CheckAgainState = 'waiting' | 'ready';

/** Waiting while the day is after `today`; ready on the day and after. Both are YYYY-MM-DD. */
export function checkAgainState(on: string, today: string): CheckAgainState {
  return daysBetween(today, on) > 0 ? 'waiting' : 'ready';
}

/**
 * The chip's words. Waiting: "Waiting until Dec 3" ("Until Dec 3" when compact). Ready: "Check again: today",
 * "Check again: yesterday", "Check again: 3 days ago".
 */
export function checkAgainText(on: string, today: string, compact = false): string {
  const days = daysBetween(today, on);
  if (days > 0) return `${compact ? 'Until' : 'Waiting until'} ${formatShortDate(on, today)}`;
  if (days === 0) return 'Check again: today';
  if (days === -1) return 'Check again: yesterday';
  return `Check again: ${-days} days ago`;
}

export interface CheckAgainChipProps {
  /** The day, YYYY-MM-DD. */
  on: string;
  /**
   * Today as YYYY-MM-DD in APP_TIME_ZONE. Pass it once useNow() has a value, or the server's day; while it
   * is null the chip shows the plain date in the waiting look ("Check again Dec 3").
   */
  today: string | null;
  /** Rows and cards: "Until Dec 3" instead of "Waiting until Dec 3". */
  compact?: boolean;
  className?: string;
}

/** Check-again chip on rows, cards, the peek, Home and the task sidebar (frames 096, 097, 101). */
export function CheckAgainChip({ on, today, compact = false, className }: CheckAgainChipProps) {
  const state = today ? checkAgainState(on, today) : null;
  const text = today ? checkAgainText(on, today, compact) : `Check again ${formatShortDate(on)}`;
  const dated = state === 'ready' || (state === 'waiting' && compact);
  return (
    <span
      data-state={state ?? 'unknown'}
      title={dated && today ? `Check again on ${formatShortDate(on, today)}` : undefined}
      className={cn(
        'inline-flex items-center gap-1.25 text-xs whitespace-nowrap tabular-nums',
        state === 'ready' ? 'font-semibold text-accent-text' : 'text-fg-3',
        className,
      )}
    >
      <ClockGlyph />
      <span>{text}</span>
    </span>
  );
}

export interface CheckAgainReasonProps {
  /** Why the task waits. */
  children: ReactNode;
  className?: string;
}

/** The reason under the chip in the sidebar and the peek (m7.css .chk-why). */
export function CheckAgainReason({ children, className }: CheckAgainReasonProps) {
  return <p className={cn('m-0 text-sm leading-normal text-pretty text-fg-2', className)}>{children}</p>;
}
