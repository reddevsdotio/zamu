import type { Member } from '@zamu/contracts';
import { useRef, useState } from 'react';
import { Button as AriaButton } from 'react-aria-components';
import { describeError, isClientError } from '~/features/tasks/errors';
import { cn, Kbd, Switch, useHotkeys } from '~/ui';
import { CommentBox, type CommentBoxHandle } from './CommentBox';
import { useCreateComment } from './queries';

// The comment box at the end of a task's history (frames 051, 054, 058; M6 004, 013, 014). Closed it reads
// "Leave a comment or a note" with the N and M hints; N opens it as a note, M as a comment, a click as a
// comment. Open, it has Write / Preview, @ mentions, the Note switch, Cancel and Comment (or Add note)
// ⌘↵. A failed send keeps the text. Unsent text survives switching tasks for the session, and a task
// with a draft opens with the box open. Mirrored tasks take comments only: notes are the file's.

const drafts = new Map<string, { text: string; note: boolean }>();

/** Forgets every unsent draft (tests, sign-out). */
export function clearCommentDrafts() {
  drafts.clear();
}

export const SEND_FAILED = "Couldn't send. Your text is still here.";

export interface CommentComposerProps {
  taskKey: string;
  members: readonly Member[];
  /** Called with the new comment's id once the server saved it. */
  onSent?: (commentId: string) => void;
  /** Overrides "Leave a comment" (mirrored and hidden tasks). */
  placeholder?: string | undefined;
  /** M (and N) open the box (default true; off while another screen owns them). */
  hotkey?: boolean;
  /** M6: offer work notes (the Note switch and N). Off for mirrored tasks. */
  notes?: boolean;
  className?: string;
}

export function CommentComposer({
  taskKey,
  members,
  onSent,
  placeholder,
  hotkey = true,
  notes = false,
  className,
}: CommentComposerProps) {
  const saved = drafts.get(taskKey);
  const [value, setValueState] = useState(() => saved?.text ?? '');
  const [isNote, setNoteState] = useState(() => (notes && saved?.note) ?? false);
  const [isOpen, setOpen] = useState(() => saved != null);
  const box = useRef<CommentBoxHandle>(null);
  const create = useCreateComment(taskKey);
  const closedLabel = placeholder ?? (notes ? 'Leave a comment or a note' : 'Leave a comment');

  const remember = (text: string, note: boolean) => {
    if (text) drafts.set(taskKey, { text, note });
    else drafts.delete(taskKey);
  };
  const setValue = (next: string) => {
    setValueState(next);
    remember(next, isNote);
    if (create.isError) create.reset();
  };
  const setNote = (next: boolean) => {
    setNoteState(next);
    remember(value, next);
  };

  const open = (note: boolean) => {
    setNote(notes && note);
    if (isOpen) box.current?.focus();
    else setOpen(true);
  };

  useHotkeys({ m: hotkey ? () => open(false) : null, n: hotkey && notes ? () => open(true) : null });

  const close = () => {
    setValue('');
    setNoteState(false);
    create.reset();
    setOpen(false);
  };

  const submit = () => {
    if (create.isPending) return;
    const body = value.trim();
    if (!body) return;
    create.mutate(
      { body, kind: isNote ? 'note' : 'comment' },
      {
        onSuccess: (comment) => {
          setValue('');
          setNoteState(false);
          create.reset();
          setOpen(false);
          onSent?.(comment.id);
        },
      },
    );
  };

  if (!isOpen) {
    return (
      <AriaButton
        onPress={() => open(false)}
        aria-label={closedLabel}
        aria-keyshortcuts={notes ? 'm n' : 'm'}
        className={cn(
          'flex w-full cursor-text items-center gap-2 rounded-md border border-line px-3.25 py-2.75 text-left text-md text-fg-3 outline-none hover:border-fg-3 focus-visible:focus-ring',
          className,
        )}
      >
        <span className="min-w-0 flex-1 truncate">{closedLabel}</span>
        {notes ? (
          <>
            <span aria-hidden className="text-xs">
              note
            </span>
            <Kbd aria-hidden>N</Kbd>
            <span aria-hidden className="text-xs">
              comment
            </span>
          </>
        ) : null}
        <Kbd aria-hidden>M</Kbd>
      </AriaButton>
    );
  }

  const error = create.isError
    ? isClientError(create.error)
      ? `${SEND_FAILED} ${describeError(create.error).message}`
      : SEND_FAILED
    : null;

  return (
    <CommentBox
      handleRef={box}
      label={isNote ? 'Note' : 'Comment'}
      value={value}
      onChange={setValue}
      onSubmit={submit}
      onCancel={close}
      // Esc leaves the box and keeps the text, so the next Esc reaches the page (back to the list).
      onEscape={() => {
        if (!value.trim()) close();
        else (document.activeElement as HTMLElement | null)?.blur();
      }}
      members={members}
      submitLabel={isNote ? 'Add note' : 'Comment'}
      placeholder={placeholder ?? (isNote ? 'Write a note' : 'Leave a comment')}
      isSending={create.isPending}
      error={error}
      autoFocus
      tone={isNote ? 'note' : 'comment'}
      {...(notes
        ? {
            footerStart: (
              <Switch isSelected={isNote} onChange={setNote} className="shrink-0 font-medium">
                Note
              </Switch>
            ),
            hint: isNote ? 'A note tells nobody unless it mentions them.' : 'Markdown · @ to mention',
          }
        : {})}
      className={className}
    />
  );
}
