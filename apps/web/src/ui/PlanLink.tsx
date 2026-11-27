import { Button as AriaButton } from 'react-aria-components';
import { Button } from './Button';
import { useCopy } from './CodeBlock';
import { cn } from './cn';
import { ExternalGlyph, PlusGlyph } from './Glyphs';

/*
 * The link from a milestone to its plan document (m8.css .pl, frames 103, 117, 121). A value that starts
 * with http:// or https:// is a web address: it opens in a new tab and reads without its scheme. Anything
 * else is a file path in the code font. Both have Copy, which copies the value as it was set. Without a
 * value, the dashed "Add a link to the plan" button takes its place.
 */

/** True for a web address: the plan link opens it; anything else is a file path. */
export function isWebLink(value: string): boolean {
  return /^https?:\/\//i.test(value.trim());
}

/** A web address without its scheme and trailing slash: "wiki.northwind.dev/plans/refunds". */
export function planLinkText(value: string): string {
  const trimmed = value.trim();
  return isWebLink(trimmed) ? trimmed.replace(/^https?:\/\//i, '').replace(/\/$/, '') : trimmed;
}

export interface PlanLinkProps {
  /** The plan link as stored, or null when the milestone has none. */
  value: string | null;
  /** No value: draws "+ Add a link to the plan". Leave it out where the viewer can't change it. */
  onAdd?: () => void;
  /** With a value: draws Change after Copy. */
  onEdit?: () => void;
  className?: string;
}

/** The plan link in a milestone's header: a file path or a web address with Copy, or the add button. */
export function PlanLink({ value, onAdd, onEdit, className }: PlanLinkProps) {
  const { copied, copy } = useCopy();
  if (!value) {
    if (!onAdd) return null;
    return (
      <AriaButton
        onPress={onAdd}
        data-part="plan-link"
        data-kind="none"
        className={cn(
          'inline-flex h-7 shrink-0 cursor-pointer items-center gap-1.5 rounded-sm border border-dashed border-line px-2.5 text-sm whitespace-nowrap text-fg-3 outline-none hover:border-fg-3 hover:text-fg-2 focus-visible:focus-ring',
          className,
        )}
      >
        <PlusGlyph className="h-2.25 w-2.25" />
        Add a link to the plan
      </AriaButton>
    );
  }
  const web = isWebLink(value);
  return (
    <span
      data-part="plan-link"
      data-kind={web ? 'web' : 'path'}
      className={cn(
        'inline-flex h-7 max-w-full min-w-0 items-center gap-2 rounded-sm bg-bg-lane pr-1.25 pl-2.5 text-sm whitespace-nowrap text-fg-2',
        className,
      )}
    >
      <span className="shrink-0">Plan</span>
      {web ? (
        <a
          href={value.trim()}
          target="_blank"
          rel="noreferrer"
          title={value}
          aria-label={`${planLinkText(value)}, opens in a new tab`}
          className="inline-flex min-w-0 items-center gap-1 rounded-sm font-medium text-accent-text no-underline outline-none hover:underline focus-visible:focus-ring"
        >
          <span className="truncate">{planLinkText(value)}</span>
          <ExternalGlyph />
        </a>
      ) : (
        <code title={value} className="min-w-0 truncate font-mono text-xs text-fg">
          {value}
        </code>
      )}
      <Button
        variant="quiet"
        size="sm"
        className="h-5.5 px-1.5"
        aria-label={copied ? 'Copied the plan link' : 'Copy the plan link'}
        onPress={() => copy(value.trim())}
      >
        {copied ? 'Copied' : 'Copy'}
      </Button>
      {onEdit ? (
        <Button variant="quiet" size="sm" className="h-5.5 px-1.5" onPress={onEdit}>
          Change
        </Button>
      ) : null}
    </span>
  );
}
