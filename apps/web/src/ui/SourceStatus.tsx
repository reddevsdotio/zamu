import { cn } from './cn';

/*
 * Mirror and connection state markers, Margin dots (margin.css .dot): --status-done healthy, --status-prog
 * while reading (pulsing) and for problems, --danger failed, and a --fg-3 ring for paused and detached.
 */

export const SOURCE_DOT_STATES = ['healthy', 'reading', 'warnings', 'failed', 'paused', 'detached'] as const;
export type SourceDotState = (typeof SOURCE_DOT_STATES)[number];

export const SOURCE_DOT_LABELS: Record<SourceDotState, string> = {
  healthy: 'Healthy',
  reading: 'Refreshing',
  warnings: 'Problems',
  failed: 'Failed',
  paused: 'Paused',
  // PM-33: the switch replaced Detach, so a source that no longer reads the files is owned by Zamu.
  // An import that finished passes its own label ("Imported").
  detached: 'Owned by Zamu',
};

const DOT_CLASS: Record<SourceDotState, string> = {
  healthy: 'bg-status-done',
  reading: 'bg-status-prog motion-safe:animate-pulse',
  warnings: 'bg-status-prog',
  failed: 'bg-danger',
  paused: 'border-[1.5px] border-fg-3',
  detached: 'border-[1.5px] border-fg-3',
};

export interface SourceStatusDotProps {
  state: SourceDotState;
  /**
   * Accessible name; defaults to the state name ("Healthy"). Pass `decorative` when visible text next to
   * the dot already says the state.
   */
  label?: string;
  decorative?: boolean;
  className?: string;
}

/** 7px round state marker for a mirror (or a connection): healthy, reading, warnings, failed, paused, detached. */
export function SourceStatusDot({ state, label, decorative = false, className }: SourceStatusDotProps) {
  return (
    <span
      {...(decorative
        ? { 'aria-hidden': true }
        : { role: 'img', 'aria-label': label ?? SOURCE_DOT_LABELS[state] })}
      data-state={state}
      className={cn('box-border inline-block size-1.75 shrink-0 rounded-full', DOT_CLASS[state], className)}
    />
  );
}
