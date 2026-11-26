import type { ReactNode } from 'react';
import { Button } from './Button';
import { cn } from './cn';
import { ArchiveGlyph } from './Glyphs';

/*
 * Archived tasks (m7.css .arch-bar, .tagq): the bar at the top of an archived task with its date, what
 * archiving means and Restore; and the quiet "Archived" tag on search and palette results, which come last.
 */

export interface ArchivedBarProps {
  /** The day it was archived, formatted by the screen ("Nov 12") once useNow() has a value. */
  on: ReactNode;
  /** Why, after a comma: "14 days after it was done", "by Ana Ruiz". */
  cause?: ReactNode;
  /** What archiving means. Defaults to "It stays out of lists, boards and counts." */
  note?: ReactNode;
  /** Draws Restore. Leave it out when the viewer can't restore (a mirrored task, no permission). */
  onRestore?: () => void;
  /** Restore is running: the button shows its pending dot. */
  isRestoring?: boolean;
  /** Key hint drawn on Restore. Defaults to ⇧E; the screen binds the key. Null hides it. */
  restoreKbd?: string | null;
  className?: string;
}

/** Bar at the top of an archived task (frame 087): "Archived on Nov 12, 14 days after it was done." */
export function ArchivedBar({
  on,
  cause,
  note = 'It stays out of lists, boards and counts.',
  onRestore,
  isRestoring = false,
  restoreKbd = '⇧E',
  className,
}: ArchivedBarProps) {
  return (
    <div
      role="note"
      data-part="archived-bar"
      className={cn(
        'flex items-center gap-2.5 rounded-md bg-bg-lane py-2 pr-2 pl-3.5 text-sm text-fg-2',
        className,
      )}
    >
      <ArchiveGlyph />
      <p className="m-0 min-w-0 flex-1">
        <b className="font-semibold text-fg">Archived on {on}</b>
        {cause ? <>, {cause}.</> : '.'} {note}
      </p>
      {onRestore ? (
        <Button
          variant="secondary"
          size="sm"
          kbd={restoreKbd ?? undefined}
          isPending={isRestoring}
          onPress={onRestore}
        >
          Restore
        </Button>
      ) : null}
    </div>
  );
}

export interface ArchivedTagProps {
  /** Defaults to "Archived". */
  children?: ReactNode;
  className?: string;
}

/** Outlined tag on an archived search or palette result (frame 086). */
export function ArchivedTag({ children = 'Archived', className }: ArchivedTagProps) {
  return (
    <span
      data-part="archived-tag"
      className={cn(
        'box-border inline-flex h-5 shrink-0 items-center gap-1.25 rounded-pill border border-line px-2 text-xs font-medium whitespace-nowrap text-fg-3',
        className,
      )}
    >
      <ArchiveGlyph className="h-2.25 w-2.5" />
      {children}
    </span>
  );
}
