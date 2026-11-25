import type { ReactNode } from 'react';
import { cn } from './cn';

/*
 * Small line glyphs drawn in currentColor (margin.css .lock, .check, .ico-plus, .filters-glyph, .caret).
 * All are decorative: put the meaning in the text next to them or in an aria-label on the control.
 */

interface GlyphProps {
  className?: string;
}

/** 9×11 padlock: mirrored (read-only) fields and labels. */
export function LockGlyph({ className }: GlyphProps) {
  return (
    <svg
      aria-hidden
      viewBox="0 0 9 11"
      width="9"
      height="11"
      fill="none"
      data-glyph="lock"
      className={cn('shrink-0', className)}
    >
      <path d="M2.25 4.5V3a2.25 2.25 0 0 1 4.5 0v1.5" stroke="currentColor" strokeWidth="1.5" />
      <rect x="0" y="4.25" width="9" height="6.75" rx="1.5" fill="currentColor" />
    </svg>
  );
}

/** 10×8 check mark: checked menu items, checkboxes. */
export function CheckGlyph({ className }: GlyphProps) {
  return (
    <svg
      aria-hidden
      viewBox="0 0 10 8"
      width="10"
      height="8"
      fill="none"
      data-glyph="check"
      className={cn('shrink-0', className)}
    >
      <path d="M1 4.2 3.7 6.8 9 1.2" stroke="currentColor" strokeWidth="1.6" strokeLinecap="round" />
    </svg>
  );
}

/** 10×10 plus: create items, "Add subtask". */
export function PlusGlyph({ className }: GlyphProps) {
  return (
    <svg
      aria-hidden
      viewBox="0 0 10 10"
      width="10"
      height="10"
      fill="none"
      data-glyph="plus"
      className={cn('shrink-0', className)}
    >
      <path d="M5 1v8M1 5h8" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" />
    </svg>
  );
}

/** 8×8 cross: remove a blocker, clear a value, close a chip. */
export function CloseGlyph({ className }: GlyphProps) {
  return (
    <svg
      aria-hidden
      viewBox="0 0 8 8"
      width="8"
      height="8"
      fill="none"
      data-glyph="close"
      className={cn('shrink-0', className)}
    >
      <path d="M1 1l6 6M7 1 1 7" stroke="currentColor" strokeWidth="1.4" strokeLinecap="round" />
    </svg>
  );
}

/** 6×12 grip of two dot columns: a line that can be dragged or moved with Alt+arrows (margin.css .grip). */
export function GripGlyph({ className }: GlyphProps) {
  return (
    <svg
      aria-hidden
      viewBox="0 0 6 12"
      width="6"
      height="12"
      fill="currentColor"
      data-glyph="grip"
      className={cn('shrink-0 opacity-80', className)}
    >
      {[1.5, 4.5].map((x) =>
        [1.5, 4.5, 7.5, 10.5].map((y) => <circle key={`${x}-${y}`} cx={x} cy={y} r="1" />),
      )}
    </svg>
  );
}

/** Small ▾ after a select's value. */
export function CaretGlyph({ className }: GlyphProps) {
  return (
    <svg
      aria-hidden
      viewBox="0 0 7 5"
      width="7"
      height="5"
      data-glyph="caret"
      className={cn('shrink-0 text-fg-3', className)}
    >
      <path d="M0 0h7L3.5 5z" fill="currentColor" />
    </svg>
  );
}

/** Three lines, the middle one shorter: the Filter button. */
export function FiltersGlyph({ className }: GlyphProps) {
  return (
    <svg
      aria-hidden
      viewBox="0 0 11 8"
      width="11"
      height="8"
      fill="none"
      data-glyph="filters"
      className={cn('shrink-0', className)}
    >
      <path d="M0 .75h11M2 4h7M0 7.25h11" stroke="currentColor" strokeWidth="1.5" />
    </svg>
  );
}

/**
 * Frame for an SVG glyph that may carry meaning: role="img" with the label, or hidden when `label` is unset
 * (the name is visible next to it). The SVG inside is always aria-hidden.
 */
export function GlyphBox({
  label,
  className,
  children,
  ...data
}: {
  label?: string;
  className?: string;
  children: ReactNode;
} & Record<`data-${string}`, string | undefined>) {
  const box = cn('inline-flex shrink-0 items-center justify-center', className);
  return label ? (
    <span role="img" aria-label={label} className={box} {...data}>
      {children}
    </span>
  ) : (
    <span aria-hidden className={box} {...data}>
      {children}
    </span>
  );
}
