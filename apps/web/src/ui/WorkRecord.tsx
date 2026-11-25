import { type CSSProperties, type ReactNode, useCallback, useEffect, useId, useRef, useState } from 'react';
import { Button as AriaButton } from 'react-aria-components';
import { Avatar, type MemberKind } from './Avatar';
import { cn } from './cn';
import { Kbd } from './Kbd';
import { Tag } from './Tag';

/*
 * Pieces of a task's work record that are not lists (m6.css): the final summary block, a clipped block
 * with its "Show" line, a work note in the timeline, and the machine-and-branch tag on history entries
 * and notes. Markdown and times come in as nodes: screens render the Markdown, and render relative times
 * only once useNow() has a value.
 */

/** Who wrote something: a UserRef from the contracts fits. */
export interface WorkAuthor {
  name: string;
  kind: MemberKind;
}

function Byline({
  author,
  onBehalfOf,
  className,
}: {
  author: WorkAuthor;
  onBehalfOf?: string | null;
  className?: string;
}) {
  return (
    <span className={cn('inline-flex min-w-0 items-center gap-2', className)}>
      <Avatar name={author.name} kind={author.kind} decorative />
      <span className="truncate">
        {author.name}
        {onBehalfOf ? ` for ${onBehalfOf}` : null}
      </span>
    </span>
  );
}

// ── Summary ─────────────────────────────────────────────────────────────────────────────────────────────

export interface SummaryBlockProps {
  /** The Markdown body, already rendered. */
  children: ReactNode;
  /** Who wrote it last. Leave it out for a summary read from a Backlog.md file and pass `byline`. */
  author?: WorkAuthor | null;
  /** The agent's person: "claude-dev for Ana". */
  onBehalfOf?: string | null;
  /** Replaces the author: "From the file". */
  byline?: ReactNode;
  /** "2 h ago". Pass it once useNow() has a value. */
  time?: ReactNode;
  /** Defaults to "Summary". */
  title?: ReactNode;
  /**
   * `card` (default): the task view's card at the top of a finished task (frame 001). `plain`: no card,
   * the author and time at the right of the title (the peek, frame 023).
   */
  variant?: 'card' | 'plain';
  className?: string;
}

/** The final summary (m6.css .sum): "Summary", author and time over the Markdown body. */
export function SummaryBlock({
  children,
  author,
  onBehalfOf,
  byline,
  time,
  title = 'Summary',
  variant = 'card',
  className,
}: SummaryBlockProps) {
  const titleId = useId();
  const plain = variant === 'plain';
  const name = author ? `${author.name}${onBehalfOf ? ` for ${onBehalfOf}` : ''}` : null;
  return (
    <section
      aria-labelledby={titleId}
      data-variant={variant}
      className={cn(
        'flex min-w-0 flex-col gap-2',
        !plain && 'rounded-md bg-surface px-4 pt-3.5 pb-1.5 shadow-card',
        className,
      )}
    >
      <div className="flex min-w-0 items-center gap-2 text-sm whitespace-nowrap text-fg-3">
        <b id={titleId} className="font-semibold text-fg">
          {title}
        </b>
        {plain ? (
          <>
            <span className="flex-1" />
            <span className="min-w-0 truncate">
              {byline ?? name}
              {time ? (
                <>
                  {byline || name ? ', ' : null}
                  {time}
                </>
              ) : null}
            </span>
          </>
        ) : (
          <>
            {byline ? (
              <span className="min-w-0 truncate">{byline}</span>
            ) : author ? (
              <Byline author={author} onBehalfOf={onBehalfOf} />
            ) : null}
            <span className="flex-1" />
            {time ? <span className="shrink-0">{time}</span> : null}
          </>
        )}
      </div>
      <div className="min-w-0 text-md leading-prose text-fg">{children}</div>
    </section>
  );
}

// ── Clipped block ───────────────────────────────────────────────────────────────────────────────────────

export interface ClippedTextProps {
  /** The content: a description, a plan. */
  children: ReactNode;
  /** Lines shown while clipped, counted in the block's line height: 2 for a description under a summary. */
  lines: number;
  /** The line under the clipped block: "Show the description", "Show all 60 lines". */
  showLabel: ReactNode;
  /** Key hint after the label, for example "D". Bind the key in the screen. */
  kbd?: string;
  /** "Show less" once open. Without it the line goes away when the block opens. */
  lessLabel?: ReactNode;
  expanded?: boolean;
  defaultExpanded?: boolean;
  onExpandedChange?: (expanded: boolean) => void;
  className?: string;
  /** Classes for the clipped box, for example the text style of the content. */
  contentClassName?: string;
}

const FADE: CSSProperties = {
  maskImage: 'linear-gradient(to bottom, black calc(100% - 28px), transparent)',
  WebkitMaskImage: 'linear-gradient(to bottom, black calc(100% - 28px), transparent)',
};

/**
 * A block cut after `lines` lines with a fade (m6.css .clip + .more-l), and the accent "Show" line under it.
 * The fade is a mask, so it works on any ground. The Show line appears only when the content is taller than
 * the cut.
 */
export function ClippedText({
  children,
  lines,
  showLabel,
  kbd,
  lessLabel,
  expanded: expandedProp,
  defaultExpanded = false,
  onExpandedChange,
  className,
  contentClassName,
}: ClippedTextProps) {
  const [expandedState, setExpandedState] = useState(defaultExpanded);
  const expanded = expandedProp ?? expandedState;
  const setExpanded = (next: boolean) => {
    setExpandedState(next);
    onExpandedChange?.(next);
  };
  const contentId = useId();
  const boxRef = useRef<HTMLDivElement>(null);
  // Assume the content is long until measured, so the server render already holds the Show line.
  const [overflows, setOverflows] = useState(true);
  const measure = useCallback(() => {
    const box = boxRef.current;
    if (box) setOverflows(box.scrollHeight > box.clientHeight + 1);
  }, []);
  useEffect(() => {
    if (expanded) return;
    measure();
    const box = boxRef.current;
    if (!box || typeof ResizeObserver === 'undefined') return;
    const observer = new ResizeObserver(measure);
    observer.observe(box);
    for (const child of Array.from(box.children)) observer.observe(child);
    return () => observer.disconnect();
  }, [expanded, measure]);
  const clipped = !expanded && overflows;
  const showLine = expanded ? lessLabel != null : overflows;
  return (
    <div className={cn('flex min-w-0 flex-col', className)}>
      <div
        ref={boxRef}
        id={contentId}
        data-clipped={clipped || undefined}
        className={cn('min-w-0', !expanded && 'overflow-hidden', contentClassName)}
        style={expanded ? undefined : { maxHeight: `${lines}lh`, ...(clipped ? FADE : null) }}
      >
        {children}
      </div>
      {showLine ? (
        <AriaButton
          aria-expanded={expanded}
          aria-controls={contentId}
          onPress={() => setExpanded(!expanded)}
          className="inline-flex h-6.5 cursor-pointer items-center gap-2 self-start rounded-sm text-sm font-medium text-accent-text outline-none hover:underline focus-visible:focus-ring"
        >
          {expanded ? lessLabel : showLabel}
          {kbd && !expanded ? <Kbd aria-hidden>{kbd}</Kbd> : null}
        </AriaButton>
      ) : null}
    </div>
  );
}

// ── Source tag ──────────────────────────────────────────────────────────────────────────────────────────

export interface SourceTagProps {
  /** The machine the CLI ran on (EntrySource.machine). */
  machine?: string | null;
  /** The git branch it ran in (EntrySource.branch), set in the code font. */
  branch?: string | null;
  className?: string;
}

/**
 * Where a history entry or a note came from (m6.css .src): "laptop · feat/payout-retries" in --fg-3. Renders
 * nothing for changes made in the web app, which carry neither. Read as "from laptop, branch feat/…".
 */
export function SourceTag({ machine, branch, className }: SourceTagProps) {
  if (!machine && !branch) return null;
  return (
    <span
      data-source
      className={cn(
        'inline-flex min-w-0 shrink items-center gap-1.25 text-xs whitespace-nowrap text-fg-3',
        className,
      )}
    >
      <span className="sr-only">from </span>
      {machine ? <span className="truncate">{machine}</span> : null}
      {machine && branch ? <span aria-hidden>·</span> : null}
      {branch ? (
        <>
          <span className="sr-only">{machine ? ', branch ' : 'branch '}</span>
          <code title={branch} className="max-w-60 truncate font-mono text-xs">
            {branch}
          </code>
        </>
      ) : null}
    </span>
  );
}

// ── Work note ───────────────────────────────────────────────────────────────────────────────────────────

export interface NoteItemProps {
  /** The note's text, already rendered from Markdown. */
  children: ReactNode;
  author: WorkAuthor;
  /** The agent's person: "claude-dev for Ana". */
  onBehalfOf?: string | null;
  /** "Nov 4", "2 h ago". Pass it once useNow() has a value. */
  time?: ReactNode;
  /** Machine and branch, when the CLI sent them. */
  source?: { machine: string | null; branch: string | null } | null;
  /**
   * `always` (default) shows the source, `hover` only while the note is hovered or holds focus (the
   * timeline under All, frame 013).
   */
  sourceVisibility?: 'always' | 'hover';
  /** Tag after the name. Defaults to "Note". */
  tag?: ReactNode;
  className?: string;
}

/**
 * A work note in the timeline (m6.css .note): quieter than a comment. No card, a 2px --line rule on the left,
 * a small header with the "Note" tag, and the body in --fg-2.
 */
export function NoteItem({
  children,
  author,
  onBehalfOf,
  time,
  source,
  sourceVisibility = 'always',
  tag = 'Note',
  className,
}: NoteItemProps) {
  const who = `${author.name}${onBehalfOf ? ` for ${onBehalfOf}` : ''}`;
  return (
    <article
      aria-label={`Note by ${who}`}
      data-kind="note"
      className={cn('group/note flex min-w-0 flex-col gap-0.75 border-l-2 border-line py-px pl-3', className)}
    >
      <div className="flex min-w-0 items-center gap-2 text-xs whitespace-nowrap text-fg-3">
        <Avatar name={author.name} kind={author.kind} decorative />
        <b className="min-w-0 truncate text-sm font-semibold text-fg-2">{who}</b>
        <Tag tone="outline">{tag}</Tag>
        {source ? (
          <SourceTag
            machine={source.machine}
            branch={source.branch}
            className={cn(
              sourceVisibility === 'hover' &&
                'opacity-0 group-hover/note:opacity-100 group-focus-within/note:opacity-100',
            )}
          />
        ) : null}
        <span className="flex-1" />
        {time ? <span className="shrink-0">{time}</span> : null}
      </div>
      <div className="min-w-0 text-md leading-prose text-pretty text-fg-2">{children}</div>
    </article>
  );
}
