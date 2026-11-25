import type { Member } from '@zamu/contracts';
import { type ReactNode, type Ref, useEffect, useImperativeHandle, useRef, useState } from 'react';
import {
  Tab as AriaTab,
  TabList as AriaTabList,
  TabPanel as AriaTabPanel,
  Tabs as AriaTabs,
  TextArea as AriaTextArea,
  TextField as AriaTextField,
} from 'react-aria-components';
import { Button, cn } from '~/ui';
import { CommentMarkdownContent, commentProse } from './CommentMarkdown';
import { useMentionPicker } from './useMentionPicker';

// The open comment box (screens.css .composer.open, frame 058): Write / Preview, the text, and a footer
// with "Markdown · @ to mention", Cancel and the submit button with ⌘↵. The composer and the in-place
// comment editor both use it. @ opens the mention menu under the text; Esc closes the menu first, then
// the box (onEscape).

export interface CommentBoxHandle {
  focus: () => void;
}

export interface CommentBoxProps {
  value: string;
  onChange: (value: string) => void;
  onSubmit: () => void;
  onCancel: () => void;
  /** Esc in the text with the mention menu closed. */
  onEscape: () => void;
  members: readonly Member[];
  /** "Comment" or "Save". */
  submitLabel: string;
  /** Accessible name of the text box. */
  label: string;
  placeholder?: string;
  isSending?: boolean;
  /** Failed send or save: the message in the footer; the text stays. */
  error?: string | null;
  autoFocus?: boolean;
  /** Lets the owner focus the text (M focuses the composer). */
  handleRef?: Ref<CommentBoxHandle>;
  /** Left of the footer, before the hint: the composer's Note switch. */
  footerStart?: ReactNode;
  /** Replaces "Markdown · @ to mention" (the note mode's "A note tells nobody unless it mentions them."). */
  hint?: ReactNode;
  /** Draw the box as a note: a side rule in --fg-3 (m6.css .composer.note-on). */
  tone?: 'comment' | 'note';
  className?: string;
}

export function CommentBox({
  value,
  onChange,
  onSubmit,
  onCancel,
  onEscape,
  members,
  submitLabel,
  label,
  placeholder,
  isSending = false,
  error,
  autoFocus = false,
  handleRef,
  footerStart,
  hint = 'Markdown · @ to mention',
  tone = 'comment',
  className,
}: CommentBoxProps) {
  const [mode, setMode] = useState<'write' | 'preview'>('write');
  const picker = useMentionPicker({
    value,
    onChange,
    members,
    enabled: mode === 'write',
    overlayClassName: 'absolute top-full left-50 z-20 -mt-12 w-65',
  });
  useImperativeHandle(handleRef, () => ({
    focus: () => {
      if (mode === 'write') return picker.focus();
      setMode('write');
      requestAnimationFrame(() => picker.focus());
    },
  }));
  // An opened box comes into view (M from the top of a long task).
  const boxRef = useRef<HTMLFieldSetElement>(null);
  useEffect(() => {
    if (autoFocus) boxRef.current?.scrollIntoView?.({ block: 'nearest' });
  }, [autoFocus]);
  // The mention menu hangs under the box: bring it into view when it opens at the foot of the page.
  useEffect(() => {
    if (!picker.isOpen) return;
    const frame = requestAnimationFrame(() =>
      boxRef.current?.querySelector('[role="listbox"]')?.scrollIntoView?.({ block: 'nearest' }),
    );
    return () => cancelAnimationFrame(frame);
  }, [picker.isOpen]);
  const canSubmit = !isSending && value.trim().length > 0;
  const submit = () => {
    if (canSubmit) onSubmit();
  };
  return (
    <fieldset
      ref={boxRef}
      aria-label={label}
      data-error={error ? true : undefined}
      className={cn(
        'relative m-0 flex min-w-0 flex-col gap-2.5 rounded-md border bg-surface px-3.25 py-2.75',
        error
          ? 'border-danger'
          : tone === 'note'
            ? 'border-line border-l-2 border-l-fg-3 shadow-[0_0_0_3px_var(--bg-lane)]'
            : 'halo',
        className,
      )}
      onKeyDown={(event) => {
        if (event.defaultPrevented) return;
        if (event.key === 'Enter' && (event.metaKey || event.ctrlKey)) {
          event.preventDefault();
          submit();
        }
      }}
    >
      {picker.overlay}
      <AriaTabs
        selectedKey={mode}
        onSelectionChange={(key) => setMode(key as 'write' | 'preview')}
        className="flex flex-col gap-2.5"
      >
        <AriaTabList aria-label="Comment mode" className="flex gap-3 text-sm">
          <AriaTab id="write" className={tabClass}>
            Write
          </AriaTab>
          <AriaTab id="preview" className={tabClass}>
            Preview
          </AriaTab>
        </AriaTabList>
        <AriaTabPanel id="write" className="outline-none">
          <AriaTextField aria-label={label} value={value} onChange={picker.onChange} className="flex">
            <AriaTextArea
              {...picker.textAreaProps}
              ref={picker.textAreaRef}
              autoFocus={autoFocus}
              placeholder={placeholder}
              onKeyDown={(event) => {
                picker.onKeyDown(event);
                if (event.defaultPrevented) return;
                if (event.key === 'Escape') {
                  event.preventDefault();
                  event.stopPropagation();
                  onEscape();
                }
              }}
              rows={2}
              className="max-h-80 min-h-12 w-full resize-none border-0 bg-transparent p-0 text-md leading-prose text-fg outline-none [field-sizing:content] placeholder:text-fg-3"
            />
          </AriaTextField>
        </AriaTabPanel>
        <AriaTabPanel id="preview" className="min-h-12 rounded-sm outline-none focus-visible:focus-ring">
          {value.trim() ? (
            <div className={commentProse}>
              <CommentMarkdownContent source={value} members={members} />
            </div>
          ) : (
            <p className="m-0 text-md text-fg-3">Nothing to preview.</p>
          )}
        </AriaTabPanel>
      </AriaTabs>
      <div className="flex items-center gap-2">
        {footerStart}
        {error ? (
          <span role="alert" className="min-w-0 text-xs text-danger">
            {error}
          </span>
        ) : (
          <span className="min-w-0 truncate text-xs text-fg-3">{hint}</span>
        )}
        <span className="flex-1" />
        {isSending ? (
          <span role="status" className="text-xs text-fg-3">
            Sending…
          </span>
        ) : null}
        <Button variant="secondary" onPress={onCancel}>
          Cancel
        </Button>
        <Button isDisabled={!canSubmit} onPress={submit} kbd="⌘↵" aria-keyshortcuts="Meta+Enter">
          {error ? 'Try again' : submitLabel}
        </Button>
      </div>
    </fieldset>
  );
}

const tabClass = ({ isSelected }: { isSelected: boolean }) =>
  cn(
    'cursor-pointer rounded-sm outline-none focus-visible:focus-ring',
    isSelected ? 'font-semibold text-fg' : 'text-fg-3 hover:text-fg-2',
  );
