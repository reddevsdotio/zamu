import { type ReactNode, useEffect, useRef, useState } from 'react';
import { Button } from './Button';
import { cn } from './cn';

/** Copies text to the clipboard; returns false when the browser refuses. */
export async function copyText(text: string): Promise<boolean> {
  try {
    await navigator.clipboard.writeText(text);
    return true;
  } catch {
    const area = document.createElement('textarea');
    area.value = text;
    area.setAttribute('readonly', '');
    area.style.position = 'fixed';
    area.style.opacity = '0';
    document.body.append(area);
    area.select();
    const ok = document.execCommand('copy');
    area.remove();
    return ok;
  }
}

/** `copied` turns true for two seconds after a successful copy. */
export function useCopy(timeout = 2000) {
  const [copied, setCopied] = useState(false);
  const timer = useRef<ReturnType<typeof setTimeout>>(undefined);
  useEffect(() => () => clearTimeout(timer.current), []);
  const copy = async (text: string) => {
    const ok = await copyText(text);
    if (!ok) return false;
    setCopied(true);
    clearTimeout(timer.current);
    timer.current = setTimeout(() => setCopied(false), timeout);
    return true;
  };
  return { copied, copy };
}

export interface CodeBlockProps {
  /** One-line command or value. */
  children: string;
  /**
   * `default`: band box, mono 11px (CLI hints).
   * `secret`: accent-bordered 40px box with an accent Copy button beside it (a new API key).
   * `command`: 40px --bg-lane box, mono 12.5px cut at the end, a small outlined Copy inside on the right
   * (m6.css .cmd: the export command on the Backlog.md settings page).
   */
  variant?: 'default' | 'secret' | 'command';
  /** Show a Copy button. Always on for `secret` and `command`. */
  copyable?: boolean;
  /** Accessible label for the copy button, for example "Copy API key". */
  copyLabel?: string;
  className?: string;
}

export function CodeBlock({
  children,
  variant = 'default',
  copyable = false,
  copyLabel,
  className,
}: CodeBlockProps) {
  const { copied, copy } = useCopy();
  if (variant === 'secret') {
    return (
      <div className={cn('flex items-center gap-2', className)}>
        <code className="flex h-10 min-w-0 flex-1 items-center overflow-hidden rounded-md border border-accent bg-accent-soft px-3 font-mono text-sm whitespace-nowrap text-fg select-all">
          {children}
        </code>
        <Button variant="accent" size="lg" aria-label={copyLabel} onPress={() => copy(children)}>
          {copied ? 'Copied' : 'Copy'}
        </Button>
      </div>
    );
  }
  if (variant === 'command') {
    return (
      <div
        className={cn(
          'flex h-10 min-w-0 items-center gap-2.5 rounded-md bg-bg-lane pr-1.5 pl-3.5',
          className,
        )}
      >
        <code title={children} className="min-w-0 flex-1 truncate font-mono text-sm text-fg">
          {children}
        </code>
        <Button
          variant="secondary"
          size="sm"
          className="bg-surface hover:bg-surface-hover pressed:bg-surface-hover"
          aria-label={copyLabel}
          onPress={() => copy(children)}
        >
          {copied ? 'Copied' : 'Copy'}
        </Button>
      </div>
    );
  }
  return (
    <div
      className={cn(
        'flex min-w-0 items-center gap-2 rounded-md border border-line-soft bg-bg-grp py-2 pr-2.5 pl-2.5 font-mono text-xs text-fg',
        copyable && 'py-1 pr-1',
        className,
      )}
    >
      <code className="min-w-0 flex-1 truncate">{children}</code>
      {copyable ? (
        <Button
          variant="ghost"
          size="sm"
          className="h-6 px-2 font-sans text-xs"
          aria-label={copyLabel}
          onPress={() => copy(children)}
        >
          {copied ? 'Copied' : 'Copy'}
        </Button>
      ) : null}
    </div>
  );
}

/** Inline code inside prose: `30s × 2^n`, request ids. */
export function InlineCode({ children, className }: { children: ReactNode; className?: string }) {
  return (
    <code className={cn('rounded-sm bg-bg-grp px-1 py-px font-mono text-xs', className)}>{children}</code>
  );
}
