import type { CheckAgain } from '@zamu/contracts';
import { MAX_CHECK_AGAIN_REASON_LENGTH } from '@zamu/contracts';
import { useId, useRef, useState } from 'react';
import {
  Button as AriaButton,
  TextArea as AriaTextArea,
  TextField as AriaTextField,
} from 'react-aria-components';
import { Calendar, cn, formatShortDate, inputBase, localToday, PickerMenu, type PickerMenuItem } from '~/ui';
import { useFieldChange } from './apply';
import { checkAgainPicks, formatDayWithWeekday, parseDueText, relativeDay } from './dates';
import type { FieldPickerProps } from './StatusPicker';
import { FieldPopover, type PickerAnchorProps } from './shared';
import { toTargets } from './targets';

// The check-again picker (frames 095, 098), built from the due-date picker: type a day ("dec 3", "in 2
// weeks") or pick In a week, In two weeks, In a month or a day in the calendar, then say why the task
// waits. The reason is required: the field says so in its label, and an attempt without one marks it
// and says why. ↵ in the reason sets both; Esc cancels; Clear takes the day off the task.

export interface CheckAgainMenuProps {
  /** The task's day and reason, or null. */
  value: CheckAgain | null;
  onChange: (value: CheckAgain | null) => void;
  /** Today as YYYY-MM-DD (defaults to the browser's day). */
  today?: string;
  onClose?: () => void;
  autoFocus?: boolean;
}

/** Why the reason is asked for, under the field. */
export const CHECK_AGAIN_HELP = 'It is what you read when the task comes back.';

export function CheckAgainMenu({
  value,
  onChange,
  today = localToday(),
  onClose,
  autoFocus,
}: CheckAgainMenuProps) {
  const [query, setQuery] = useState('');
  const [day, setDay] = useState<string | null>(value?.on ?? null);
  const [reason, setReason] = useState(value?.reason ?? '');
  const [error, setError] = useState<'day' | 'reason' | null>(null);
  const reasonRef = useRef<HTMLTextAreaElement>(null);
  /** A pick in the list closes PickerMenu's way: this one stays open for the reason. */
  const picked = useRef(false);
  const helpId = useId();

  const typed = query.trim() ? parseDueText(query, today) : null;
  const chosen = typed ?? day;
  const items: PickerMenuItem[] = query.trim()
    ? typed
      ? [{ id: `date:${typed}`, label: formatDayWithWeekday(typed, today), meta: relativeDay(typed, today) }]
      : []
    : checkAgainPicks(today).map((pick) => ({
        id: `${pick.id}:${pick.date}`,
        label: pick.label,
        meta: formatShortDate(pick.date, today),
      }));

  const pickDay = (date: string) => {
    setDay(date);
    setQuery('');
    if (error === 'day') setError(null);
    // The reason comes next.
    requestAnimationFrame(() => reasonRef.current?.focus());
  };

  const submit = () => {
    if (!chosen) {
      setError('day');
      return;
    }
    const text = reason.trim();
    if (!text) {
      setError('reason');
      reasonRef.current?.focus();
      return;
    }
    onChange({ on: chosen, reason: text.replace(/\s+/g, ' ') });
    onClose?.();
  };

  return (
    // ↵ in the search field with no day highlighted sets what is chosen (or says what is missing).
    <div
      onKeyDownCapture={(event) => {
        const target = event.target as HTMLElement;
        if (event.key !== 'Enter' || target.tagName !== 'INPUT' || event.nativeEvent.isComposing) return;
        const menu = target.closest('[data-check-again]');
        if (menu?.querySelector('[role^="menuitem"][data-focused]')) return;
        event.preventDefault();
        event.stopPropagation();
        submit();
      }}
      data-check-again
    >
      <PickerMenu
        aria-label="Check again"
        selectionMode="none"
        items={items}
        query={query}
        onQueryChange={setQuery}
        onAction={(id) => {
          picked.current = true;
          pickDay(id.slice(id.indexOf(':') + 1));
        }}
        search={{ placeholder: 'Type a day: dec 3, in 2 weeks', kbd: '⇧W', filter: false }}
        emptyText="Type a day like dec 3, fri or +2w"
        footer={{
          hints: [
            { keys: '↵', label: 'set' },
            { keys: 'Esc', label: 'cancel' },
          ],
          end: value ? (
            <AriaButton
              onPress={() => {
                onChange(null);
                onClose?.();
              }}
              className="cursor-pointer rounded-sm px-1 text-xs font-semibold text-accent-text outline-none hover:underline focus-visible:focus-ring"
            >
              Clear
            </AriaButton>
          ) : undefined,
        }}
        onClose={() => {
          if (picked.current) {
            picked.current = false;
            return;
          }
          onClose?.();
        }}
        autoFocus={autoFocus}
      >
        <div className="-mx-1.5 border-t border-line-soft pt-1">
          <Calendar value={chosen} onChange={pickDay} />
        </div>
        <div className="-mx-1.5 flex flex-col gap-1.5 border-t border-line-soft px-3 pt-2.5 pb-1">
          <AriaTextField
            aria-label="Why wait (required)"
            aria-describedby={helpId}
            value={reason}
            onChange={(next) => {
              setReason(next);
              if (error === 'reason' && next.trim()) setError(null);
            }}
            isInvalid={error === 'reason'}
            maxLength={MAX_CHECK_AGAIN_REASON_LENGTH}
            className="flex flex-col gap-1.5"
          >
            <span aria-hidden className="text-sm font-medium text-fg-2">
              Why wait <span className="font-normal text-fg-3">· required</span>
            </span>
            <AriaTextArea
              ref={reasonRef}
              rows={2}
              placeholder="What are you waiting for?"
              onKeyDown={(event) => {
                if (event.key === 'Enter' && !event.shiftKey && !event.nativeEvent.isComposing) {
                  event.preventDefault();
                  submit();
                }
              }}
              className={cn(
                inputBase,
                'min-h-9 resize-none py-1.75 leading-snug [field-sizing:content]',
                error === 'reason' &&
                  'border-danger focus:border-danger focus:shadow-[0_0_0_3px_var(--danger-soft)]',
              )}
            />
          </AriaTextField>
          <p
            id={helpId}
            role={error ? 'alert' : undefined}
            className={cn('m-0 text-xs leading-snug', error ? 'font-medium text-danger' : 'text-fg-3')}
          >
            {error === 'day'
              ? 'Pick a day first.'
              : error === 'reason'
                ? `Say why it waits. ${CHECK_AGAIN_HELP}`
                : CHECK_AGAIN_HELP}
          </p>
        </div>
      </PickerMenu>
    </div>
  );
}

/**
 * The picker is tall (picks, a calendar and the reason). Under a narrow anchor such as a sidebar row it
 * would run off the window, so it opens beside it; under a list row or a card it opens below.
 */
function placementFor(anchor: PickerAnchorProps): PickerAnchorProps['placement'] {
  if (anchor.placement) return anchor.placement;
  const width = anchor.triggerRef?.current?.getBoundingClientRect().width ?? 0;
  return width > 0 && width < 400 ? 'left top' : 'bottom start';
}

export function CheckAgainPicker({ targets, onChanged, ...anchor }: FieldPickerProps) {
  const list = toTargets(targets);
  const { apply } = useFieldChange();
  const value = list.length === 1 ? (list[0]?.checkAgain ?? null) : null;
  return (
    <FieldPopover label="Check again" width={262} {...anchor} placement={placementFor(anchor)}>
      {(close) => (
        <CheckAgainMenu
          value={value}
          onClose={close}
          onChange={(checkAgain) => {
            void apply(list, { checkAgain });
            onChanged?.();
          }}
        />
      )}
    </FieldPopover>
  );
}
