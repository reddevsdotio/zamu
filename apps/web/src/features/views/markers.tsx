import type { TaskListItem } from '@zamu/contracts';
import { formatDay } from '~/features/tasks/format';
import { ArchiveGlyph, Button, CheckAgainChip, cn, RequestMarker } from '~/ui';
import type { DisplayOptions } from './display-options';

// The M7 markers of a list row, a board card and the peek (frame 101, design calls 8, 12 to 14):
//
//   … • payouts  ⎇ #482 open  ◷ Waiting until Dec 3  Nov 7  [cd]  2h
//
// The request marker shows while the "Pull request" chip is on in Display options (off by default);
// the check-again chip while "Check again" is on (the default), whenever a day is set, before the due
// date. Archived rows trade "updated" for "Archived Nov 12" with Restore on hover (frame 083).

type MarkerTask = Partial<Pick<TaskListItem, 'checkAgain' | 'pullRequest' | 'archivedAt'>>;

/** The newest request ("⎇ #482 open"), when the display options show it and the task has one. */
export function TaskRequestMarker({
  task,
  display,
  className,
}: {
  task: MarkerTask;
  display: Pick<DisplayOptions, 'properties'>;
  className?: string;
}) {
  const request = task.pullRequest;
  if (!display.properties.pullRequest || !request) return null;
  return <RequestMarker request={request} className={className} />;
}

/**
 * The check-again chip, when the display options show it and a day is set. `today` (YYYY-MM-DD) is null
 * or empty until useNow() has a value: the chip then shows the plain date ("Check again Dec 3"), never
 * a guess at waiting or ready. Rows say "Waiting until Dec 3", cards the compact "Until Dec 3".
 */
export function TaskCheckAgainChip({
  task,
  display,
  today,
  compact = false,
  className,
}: {
  task: MarkerTask;
  display: Pick<DisplayOptions, 'properties'>;
  today: string | null;
  compact?: boolean;
  className?: string;
}) {
  const on = task.checkAgain?.on;
  if (!display.properties.checkAgain || !on) return null;
  return <CheckAgainChip on={on} today={today || null} compact={compact} className={className} />;
}

/** "Archived Nov 12" (the day it was archived, once useNow() has a value). */
export function archivedDayText(archivedAt: string, now: number | null): string {
  return now == null ? 'Archived' : `Archived ${formatDay(archivedAt, new Date(now))}`;
}

/**
 * The end of an archived row (frame 083): Restore (⇧E), shown while the row is hovered or has the
 * cursor, then "Archived Nov 12" where "updated" was. `onRestore` left out (mirrored projects, where
 * Backlog.md's archive folder decides) draws no button.
 */
export function ArchivedRowEnd({
  archivedAt,
  now,
  onRestore,
  className,
}: {
  archivedAt: string;
  now: number | null;
  onRestore?: () => void;
  className?: string;
}) {
  return (
    <span className={cn('flex shrink-0 items-center gap-2', className)} data-archived-row="">
      {onRestore ? (
        <Button
          variant="secondary"
          size="sm"
          kbd="⇧E"
          onPress={onRestore}
          className={cn(
            'invisible focus-visible:visible',
            '[[data-task-key]:hover_&]:visible [[data-cursor]_&]:visible [[data-card-key]:hover_&]:visible',
          )}
        >
          Restore
        </Button>
      ) : null}
      <time
        dateTime={archivedAt}
        className="text-right text-xs whitespace-nowrap text-fg-3 tabular-nums"
        title="Archived tasks stay out of lists, boards and counts"
      >
        {archivedDayText(archivedAt, now)}
      </time>
    </span>
  );
}

/** A quiet "Archived" note for places without room for the date (board cards in the archived view). */
export function ArchivedNote({ archivedAt, now }: { archivedAt: string; now: number | null }) {
  return (
    <span className="inline-flex items-center gap-1.25 text-xs whitespace-nowrap text-fg-3 tabular-nums">
      <ArchiveGlyph className="h-2.25 w-2.5" />
      <time dateTime={archivedAt}>{archivedDayText(archivedAt, now)}</time>
    </span>
  );
}
