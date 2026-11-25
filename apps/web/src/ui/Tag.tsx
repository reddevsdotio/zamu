import type { HTMLAttributes } from 'react';
import { cn } from './cn';

export interface TagProps extends HTMLAttributes<HTMLSpanElement> {
  /**
   * `accent` marks agents; `default` is used for people, roles and states such as Revoked. `outline` is the
   * quiet 16px tag on a work note in the timeline (m6.css .note-tag): a --line border, no fill.
   */
  tone?: 'default' | 'accent' | 'outline';
}

const TONE: Record<NonNullable<TagProps['tone']>, string> = {
  default: 'h-5 px-2 bg-bg-lane text-fg-2',
  accent: 'h-5 px-2 bg-accent-soft text-accent-text',
  outline: 'h-4 px-1.5 border border-line text-fg-3',
};

/**
 * Small role or state tag: Person, Agent, Revoked, Note. Margin has no caps captions, so it is a Pill: --bg-lane,
 * or --accent-soft for agents. Pass the text in sentence case.
 */
export function Tag({ tone = 'default', className, ...props }: TagProps) {
  return (
    <span
      {...props}
      className={cn(
        'inline-flex shrink-0 items-center rounded-pill text-xs font-medium whitespace-nowrap',
        TONE[tone],
        className,
      )}
    />
  );
}
