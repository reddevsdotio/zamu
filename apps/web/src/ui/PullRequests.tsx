import type { ReactNode } from 'react';
import { Button } from './Button';
import { type GitProviderKind, PROVIDER_LABELS, ProviderBadge } from './Connection';
import { cn } from './cn';
import { AlertGlyph, BranchGlyph, CloseGlyph, ExternalGlyph } from './Glyphs';

/*
 * Pull and merge requests on a task (m7.css .prq, .prs, .brline, .flagline, .prm): the request row with its
 * host, number, title, how it was linked and a state pill; the box that holds the rows; the work-branch line
 * shown before a request exists; the "merged with open criteria" flag; and the compact marker for rows and
 * cards. Props are plain values, so the task view, Home and the lists can feed them from any shape.
 */

export const REQUEST_STATES = ['open', 'draft', 'merged', 'closed'] as const;
export type RequestState = (typeof REQUEST_STATES)[number];

export const REQUEST_STATE_LABELS: Record<RequestState, string> = {
  open: 'Open',
  draft: 'Draft',
  merged: 'Merged',
  closed: 'Closed',
};

/** How a request came to be linked: started on the task's branch, a `Closes:` line, or by hand. */
export const REQUEST_LINK_HOWS = ['branch', 'description', 'hand'] as const;
export type RequestLinkHow = (typeof REQUEST_LINK_HOWS)[number];

export const REQUEST_LINK_HOW_LABELS: Record<RequestLinkHow, string> = {
  branch: 'started on',
  description: 'named in the description',
  hand: 'linked by hand',
};

/** "#482" for GitHub and Forgejo pull requests, "!482" for GitLab merge requests. */
export function requestRef(provider: GitProviderKind, number: number): string {
  return `${provider === 'gitlab' ? '!' : '#'}${number}`;
}

// ── State pill ──────────────────────────────────────────────────────────────────────────────────────────

const PILL_STATE: Record<RequestState, string> = {
  open: 'bg-ok-soft text-ok',
  merged: 'bg-accent-soft text-accent-text',
  // Dashed: a draft is not ready, so its pill looks unfinished.
  draft: 'border border-dashed border-line bg-bg-lane text-fg-2',
  closed: 'bg-bg-lane text-fg-3',
};

export interface RequestStatePillProps {
  state: RequestState;
  className?: string;
}

/** The request's state as a word in a 20px pill: Open, Draft (dashed), Merged, Closed. Colour only backs it. */
export function RequestStatePill({ state, className }: RequestStatePillProps) {
  return (
    <span
      data-state={state}
      className={cn(
        'box-border inline-flex h-5 shrink-0 items-center rounded-pill px-2 text-xs font-semibold whitespace-nowrap',
        PILL_STATE[state],
        className,
      )}
    >
      {REQUEST_STATE_LABELS[state]}
    </span>
  );
}

// ── Box ─────────────────────────────────────────────────────────────────────────────────────────────────

export interface PullRequestBoxProps {
  /** Rows (in a PullRequestList), the branch line, the "Link a pull request" line or the link field. */
  children: ReactNode;
  className?: string;
}

/** The bordered surface that holds a task's requests, with a hairline between its parts (m7 .mbox). */
export function PullRequestBox({ children, className }: PullRequestBoxProps) {
  return (
    <div
      data-part="pull-requests"
      className={cn(
        'flex flex-col divide-y divide-line-soft overflow-hidden rounded-md border border-line bg-surface',
        className,
      )}
    >
      {children}
    </div>
  );
}

export interface PullRequestListProps {
  'aria-label'?: string;
  /** PullRequestRow elements. */
  children: ReactNode;
  className?: string;
}

/** The list of request rows inside a PullRequestBox. */
export function PullRequestList({ children, className, ...props }: PullRequestListProps) {
  return (
    <ul
      aria-label={props['aria-label'] ?? 'Pull requests'}
      className={cn('m-0 flex list-none flex-col p-0', className)}
    >
      {children}
    </ul>
  );
}

// ── Row ─────────────────────────────────────────────────────────────────────────────────────────────────

export interface PullRequestRowProps {
  provider: GitProviderKind;
  number: number;
  title: string;
  state: RequestState;
  /** How it was linked; leave it out in the preview, where `hint` takes its place. */
  how?: RequestLinkHow | null;
  /** The head branch, shown after "started on" when `how` is `branch`. */
  branch?: string | null;
  /** Replaces the how-linked words: "Enter links it" in the preview. */
  hint?: ReactNode;
  /** The request on its host. Draws the ↗ link at the end of the row. */
  url?: string | null;
  /** Draws the remove button, shown on hover and keyboard focus. Leave it out on a read-only task. */
  onRemove?: () => void;
  /** The dimmed row under the link field while an address is being linked (frame 057). */
  preview?: boolean;
  /**
   * Galleries and static frames only: draw the hover look, or the keyboard-focus look (remove focused),
   * without the pointer or focus.
   */
  look?: 'hover' | 'focus';
  className?: string;
}

/**
 * One request on a task (m7.css .prq): host mark, number, title, how it was linked, the state pill, then
 * remove (on hover and focus) and the ↗ link to the host. A list item: put it in a PullRequestList.
 */
export function PullRequestRow({
  provider,
  number,
  title,
  state,
  how,
  branch,
  hint,
  url,
  onRemove,
  preview = false,
  look,
  className,
}: PullRequestRowProps) {
  const ref = requestRef(provider, number);
  const host = PROVIDER_LABELS[provider];
  const shown = look != null;
  const Element = preview ? 'div' : 'li';
  return (
    <Element
      data-state={state}
      data-preview={preview || undefined}
      className={cn(
        'group/prq relative flex min-h-9.5 items-center gap-2.5 pr-2.5 pl-3 text-md whitespace-nowrap',
        // Rows divide each other; the box draws the line between the list and what follows it.
        !preview && 'border-b border-line-soft last:border-b-0 hover:bg-bg-grp',
        shown && 'bg-bg-grp',
        className,
      )}
    >
      <ProviderBadge provider={provider} size="sm" className="border-0 bg-bg-lane text-fg-2" />
      <span className="min-w-8.5 shrink-0 text-sm font-semibold text-fg-2 tabular-nums">{ref}</span>
      <span
        title={title}
        className={cn('min-w-0 flex-1 truncate font-medium', preview ? 'text-fg-2' : 'text-fg')}
      >
        {title}
      </span>
      {hint != null ? (
        <span className="shrink-0 text-xs text-fg-3">{hint}</span>
      ) : how ? (
        <span className="inline-flex min-w-0 shrink items-center gap-1 text-xs text-fg-3">
          <span className="shrink-0">{REQUEST_LINK_HOW_LABELS[how]}</span>
          {how === 'branch' && branch ? (
            <code title={branch} className="max-w-48 truncate font-mono text-xs">
              {branch}
            </code>
          ) : null}
        </span>
      ) : null}
      <RequestStatePill state={state} />
      {onRemove && !preview ? (
        <Button
          variant="quiet"
          size="sm"
          iconOnly
          aria-label={`Unlink ${ref}`}
          onPress={onRemove}
          className={cn(
            'size-5.5 text-fg-3 opacity-0 group-focus-within/prq:opacity-100 group-hover/prq:opacity-100 focus-visible:opacity-100',
            shown && 'opacity-100',
            look === 'focus' && 'shadow-[var(--focus-ring)]',
          )}
        >
          <CloseGlyph />
        </Button>
      ) : null}
      {url && !preview ? (
        <a
          href={url}
          target="_blank"
          rel="noreferrer"
          aria-label={`Open ${ref} on ${host}`}
          className="grid size-5.5 shrink-0 place-items-center rounded-sm text-fg-3 outline-none hover:bg-bg-lane hover:text-fg focus-visible:shadow-[var(--focus-ring)]"
        >
          <ExternalGlyph />
        </a>
      ) : null}
    </Element>
  );
}

// ── Branch line ─────────────────────────────────────────────────────────────────────────────────────────

export interface BranchLineProps {
  /** The task's work branch. */
  branch: string;
  /** Who started it, where and when: "by claude-dev on laptop, Nov 3". Pass times once useNow() has a value. */
  by?: ReactNode;
  /** Text at the end of the line. Defaults to "No pull request yet". */
  end?: ReactNode;
  className?: string;
}

/** Work started on a branch, no request yet (m7.css .brline, frame 053). Sits inside a PullRequestBox. */
export function BranchLine({ branch, by, end = 'No pull request yet', className }: BranchLineProps) {
  return (
    <div
      data-part="branch-line"
      className={cn('flex min-h-9.5 items-center gap-2 px-3 text-sm whitespace-nowrap text-fg-2', className)}
    >
      <BranchGlyph className="mx-0.5" />
      <span className="inline-flex min-w-0 items-center gap-1">
        <span className="shrink-0">Work started on</span>
        <code title={branch} className="min-w-0 truncate font-mono text-xs text-fg">
          {branch}
        </code>
      </span>
      {by ? <span className="min-w-0 truncate text-fg-3">{by}</span> : null}
      <span className="flex-1" />
      {end ? <span className="shrink-0 text-fg-3">{end}</span> : null}
    </div>
  );
}

// ── Flag line ───────────────────────────────────────────────────────────────────────────────────────────

/**
 * The flag's words for a task merged with open items: "Merged with 2 open criteria" when every open item is a
 * criterion, "Merged with 3 open items" otherwise.
 */
export function mergedOpenText({
  openCriteria,
  openDoneItems,
}: {
  openCriteria: number;
  openDoneItems: number;
}): string {
  if (openDoneItems === 0) {
    return `Merged with ${openCriteria} open ${openCriteria === 1 ? 'criterion' : 'criteria'}`;
  }
  const total = openCriteria + openDoneItems;
  return `Merged with ${total} open ${total === 1 ? 'item' : 'items'}`;
}

export interface FlagLineProps {
  /** "Merged with 2 open criteria": see mergedOpenText(). */
  children: ReactNode;
  /** Trailing action, such as a quiet link to the criteria. */
  action?: ReactNode;
  className?: string;
}

/** Accent line at the top of the task sidebar (m7.css .flagline, frame 063): the task needs a look. */
export function FlagLine({ children, action, className }: FlagLineProps) {
  return (
    <div
      role="note"
      data-part="flag-line"
      className={cn(
        'flex items-center gap-2 rounded-md bg-accent-soft px-2.5 py-2 text-sm font-medium text-accent-text',
        className,
      )}
    >
      <AlertGlyph />
      <span className="min-w-0 flex-1">{children}</span>
      {action}
    </div>
  );
}

// ── Marker on rows and cards ────────────────────────────────────────────────────────────────────────────

export interface RequestMarkerProps {
  /** The newest request. Leave it out for a task with a work branch and no request: the marker says "branch". */
  request?: { provider: GitProviderKind; number: number; state: RequestState } | null;
  className?: string;
}

/** Compact request marker for list rows, cards and the peek (m7.css .prm, frame 101): "⎇ #482 open", "⎇ branch". */
export function RequestMarker({ request, className }: RequestMarkerProps) {
  return (
    <span
      data-part="request-marker"
      data-state={request?.state ?? 'branch'}
      className={cn(
        'inline-flex items-center gap-1 text-xs whitespace-nowrap text-fg-2 tabular-nums',
        className,
      )}
    >
      <BranchGlyph className="h-2.5 w-2" />
      {request ? (
        <span>
          <span className="sr-only">Pull request </span>
          {requestRef(request.provider, request.number)} {REQUEST_STATE_LABELS[request.state].toLowerCase()}
        </span>
      ) : (
        <span>
          <span className="sr-only">Work </span>branch<span className="sr-only">, no pull request yet</span>
        </span>
      )}
    </span>
  );
}
