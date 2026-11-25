import { MAX_WORK_ITEM_LENGTH, type WorkItemState } from '@zamu/contracts';
import {
  type KeyboardEvent,
  type ReactNode,
  type Ref,
  useEffect,
  useId,
  useImperativeHandle,
  useLayoutEffect,
  useRef,
  useState,
} from 'react';
import { Button as AriaButton, Focusable } from 'react-aria-components';
import { Button } from './Button';
import { CheckboxBox } from './Checkbox';
import { cn } from './cn';
import { inputBase } from './Field';
import { CloseGlyph, GripGlyph, LockGlyph, PlusGlyph } from './Glyphs';
import { Kbd } from './Kbd';
import { Tooltip, TooltipTrigger } from './Tooltip';
import { WaivePopover } from './WaivePopover';

/*
 * Checklists. CheckMark is the small box in rendered Markdown task lists. Checklist is the work record's
 * list of acceptance criteria or done items (m6.css .mbox + .crit, frames 001, 003, 004, 009, 010, 019, 021):
 * lines that are open, checked or waived, with keys from the design's shortcut list. The list holds no data
 * of its own: every change goes out through a callback and comes back in `items`.
 */

/** 12px box: filled --status-done with a tick when checked, outlined otherwise. Announced as "Done" / "Not done". */
export function CheckMark({ checked, className }: { checked: boolean; className?: string }) {
  return (
    <span
      role="img"
      aria-label={checked ? 'Done' : 'Not done'}
      className={cn(
        'relative mt-1 box-border size-3 shrink-0',
        checked
          ? 'bg-status-done after:absolute after:top-px after:left-[3.5px] after:h-[6.5px] after:w-[3px] after:rotate-45 after:border-r-[1.5px] after:border-b-[1.5px] after:border-bg after:content-[""]'
          : 'border-[1.5px] border-fg-2',
        className,
      )}
    />
  );
}

/** One line. A WorkItem from the contracts fits as it is. */
export interface ChecklistItem {
  /** Key for React and for focus. Defaults to `number`; set it when one list mixes kinds (the finishing dialog). */
  id?: string | number;
  /** Position from 1. Drawn in front of the box when the list is numbered. */
  number: number;
  text: string;
  state: WorkItemState;
  /** Set while waived. */
  waivedReason?: string | null;
  /** Who waived it; null for a waiver read from a Backlog.md file ("Waived: reason"). */
  waivedBy?: { name: string } | null;
  /** Comes from a Backlog.md file: read-only with a lock and a tooltip. */
  locked?: boolean;
  /** Second line in --fg-3 under the text: "Definition of done" in the finishing dialog. */
  detail?: ReactNode;
  /** Overrides the list's `numbered` for this line. */
  numbered?: boolean;
  /** Galleries and static frames only: draw the hover or keyboard-focus look without the pointer or focus. */
  look?: 'hover' | 'focus';
}

/** Moves focus into the list, or opens the add field: bind Shift+X and Shift+A to these in the screen. */
export interface ChecklistHandle {
  /** Focus the first open line, or the first line when none is open. Returns false when the list is empty. */
  focusFirstOpen: () => boolean;
  /** Open the add field and focus it. Does nothing without `onAdd`. */
  startAdding: () => void;
}

export interface ChecklistProps {
  /** "Acceptance criteria", "Definition of done". */
  'aria-label': string;
  items: readonly ChecklistItem[];
  /** "criterion", "done item": used in "Waive criterion 5", "Remove criterion 5", "Reword criterion 5". */
  noun?: string;
  /** Draw the numbers (criteria). Done items are named by their text and have none. */
  numbered?: boolean;
  /** Every line read-only with a lock (a mirrored task). Lines can also be locked one by one. */
  readOnly?: boolean;
  /** Tooltip on a locked line. Defaults to "Set in Backlog.md. Edit the file to change it." */
  lockedReason?: ReactNode;
  /**
   * `hover` (default): grip, Waive and remove show on the hovered or focused line. `always`: Waive shows on
   * every line (the finishing dialog).
   */
  actions?: 'hover' | 'always';
  /** X, Space, or a click on the box. Checking a waived line clears the waiver. */
  onToggle?: (item: ChecklistItem) => void;
  /** Enter in the waive step, with the trimmed reason. Without it there is no Waive. */
  onWaive?: (item: ChecklistItem, reason: string) => void;
  /** W on a waived line, or its Unwaive button. */
  onUnwaive?: (item: ChecklistItem) => void;
  /** Enter (or leaving the field) after rewording, with the trimmed text when it changed. */
  onEdit?: (item: ChecklistItem, text: string) => void;
  /** Alt+↑ / Alt+↓. Without it there is no grip. */
  onMove?: (item: ChecklistItem, direction: -1 | 1) => void;
  /** Backspace or Delete, or the × button. The screen shows the Undo toast. */
  onRemove?: (item: ChecklistItem) => void;
  /** Enter in the add field, with the trimmed text. The field stays open for the next line. */
  onAdd?: (text: string) => void;
  /** Esc on a line. Without it, Esc only moves focus out of the list. */
  onLeave?: () => void;
  /** "Add a criterion". */
  addLabel?: string;
  /** Quiet text after the add label while the list is empty: "What must be true when this is done". */
  addHint?: ReactNode;
  /** Key hint on the add line, for example "⇧A". */
  addKbd?: string;
  /** Galleries: start with this line in the reword field (not focused). */
  defaultEditingId?: string | number;
  /** Galleries: start with the add field open (not focused) holding this text. */
  defaultAddValue?: string;
  ref?: Ref<ChecklistHandle>;
  className?: string;
}

type Key = string | number;
const keyOf = (item: ChecklistItem): Key => item.id ?? item.number;

function lineName(item: ChecklistItem, noun: string, numbered: boolean) {
  return numbered ? `${noun} ${item.number}` : `“${item.text}”`;
}

/**
 * The criteria or done-items list. Each line is a checkbox named by its text; a waived line is described by
 * "Waived by Ana: reason". One line at a time is in the tab order; inside the list ↑/↓ move, X or Space
 * checks, W waives or removes a waiver, E rewords, Alt+↑/↓ reorder, Backspace removes and Esc leaves. Keys on
 * a line are marked handled, so the screen's single-key shortcuts don't also fire; text fields keep theirs.
 */
export function Checklist({
  'aria-label': ariaLabel,
  items,
  noun = 'item',
  numbered = true,
  readOnly = false,
  lockedReason = 'Set in Backlog.md. Edit the file to change it.',
  actions = 'hover',
  onToggle,
  onWaive,
  onUnwaive,
  onEdit,
  onMove,
  onRemove,
  onAdd,
  onLeave,
  addLabel = 'Add an item',
  addHint,
  addKbd,
  defaultEditingId,
  defaultAddValue,
  ref,
  className,
}: ChecklistProps) {
  const [active, setActive] = useState(0);
  const [editing, setEditing] = useState<{ key: Key; focus: boolean } | null>(
    defaultEditingId != null ? { key: defaultEditingId, focus: false } : null,
  );
  const [waiving, setWaiving] = useState<Key | null>(null);
  const [adding, setAdding] = useState(defaultAddValue !== undefined);
  const [addValue, setAddValue] = useState(defaultAddValue ?? '');
  const lineRefs = useRef<(HTMLElement | null)[]>([]);
  const rowRefs = useRef<(HTMLLIElement | null)[]>([]);
  const addRef = useRef<HTMLInputElement>(null);
  const waiveAnchor = useRef<HTMLLIElement | null>(null);
  // Index to focus after the next change of `items` (a move or a removal), or now (closing a field).
  const pendingFocus = useRef<number | null>(null);
  const focusAddOnRender = useRef(false);

  const activeIndex = Math.min(active, Math.max(items.length - 1, 0));
  const editable = (item: ChecklistItem) => !readOnly && !item.locked;
  const canAdd = !readOnly && onAdd != null;

  const focusLine = (index: number) => {
    const target = lineRefs.current[index];
    if (!target) return;
    setActive(index);
    target.focus();
  };

  useLayoutEffect(() => {
    if (pendingFocus.current == null) return;
    const index = Math.min(pendingFocus.current, items.length - 1);
    pendingFocus.current = null;
    if (index >= 0) focusLine(index);
  });

  useEffect(() => {
    if (adding && focusAddOnRender.current) {
      focusAddOnRender.current = false;
      addRef.current?.focus();
    }
  }, [adding]);

  useImperativeHandle(ref, () => ({
    focusFirstOpen: () => {
      if (items.length === 0) return false;
      const open = items.findIndex((item) => item.state === 'open');
      focusLine(open === -1 ? 0 : open);
      return true;
    },
    startAdding: () => {
      if (!canAdd) return;
      if (adding) addRef.current?.focus();
      else {
        focusAddOnRender.current = true;
        setAdding(true);
      }
    },
  }));

  const toggle = (item: ChecklistItem) => {
    if (editable(item)) onToggle?.(item);
  };
  const startWaive = (item: ChecklistItem, index: number) => {
    if (!editable(item)) return;
    if (item.state === 'waived') onUnwaive?.(item);
    else if (onWaive) {
      setActive(index);
      waiveAnchor.current = rowRefs.current[index] ?? null;
      setWaiving(keyOf(item));
    }
  };
  const remove = (item: ChecklistItem, index: number) => {
    if (!editable(item) || !onRemove) return;
    pendingFocus.current = index < items.length - 1 ? index : index - 1;
    onRemove(item);
  };
  const move = (item: ChecklistItem, index: number, direction: -1 | 1) => {
    const to = index + direction;
    if (!editable(item) || !onMove || to < 0 || to >= items.length) return;
    pendingFocus.current = to;
    onMove(item, direction);
  };

  const onLineKeyDown = (event: KeyboardEvent<HTMLElement>, item: ChecklistItem, index: number) => {
    if (event.nativeEvent.isComposing || event.ctrlKey || event.metaKey) return;
    const key = event.key.length === 1 ? event.key.toLowerCase() : event.key;
    const plain = !event.altKey && !event.shiftKey;
    let handled = true;
    if ((key === 'ArrowDown' || key === 'ArrowUp') && event.altKey && !event.shiftKey) {
      move(item, index, key === 'ArrowDown' ? 1 : -1);
    } else if (key === 'ArrowDown' && plain) {
      focusLine(Math.min(index + 1, items.length - 1));
    } else if (key === 'ArrowUp' && plain) {
      focusLine(Math.max(index - 1, 0));
    } else if (key === 'Home' && plain) {
      focusLine(0);
    } else if (key === 'End' && plain) {
      focusLine(items.length - 1);
    } else if ((key === 'x' || key === ' ') && plain) {
      toggle(item);
    } else if (key === 'w' && plain) {
      startWaive(item, index);
    } else if (key === 'e' && plain) {
      if (editable(item) && onEdit) setEditing({ key: keyOf(item), focus: true });
    } else if ((key === 'Backspace' || key === 'Delete') && plain) {
      remove(item, index);
    } else if (key === 'Escape') {
      // Not stopped: a dialog around the list (the finishing step) closes on the same Esc.
      if (onLeave) onLeave();
      else event.currentTarget.blur();
    } else {
      handled = false;
    }
    if (handled) event.preventDefault();
  };

  const finishEdit = (item: ChecklistItem, index: number, text: string | null, refocus: boolean) => {
    setEditing(null);
    const trimmed = text?.trim();
    if (trimmed && trimmed !== item.text) onEdit?.(item, trimmed);
    if (refocus) pendingFocus.current = index;
  };

  const showBox = items.length > 0 || adding;
  const hasActions =
    !readOnly && (onWaive != null || onUnwaive != null || onRemove != null || onMove != null);

  const addField = adding ? (
    <li className="flex items-start gap-2.5 border-t border-line-soft px-2.5 py-2 first:border-t-0">
      {numbered ? <LineNumber value={items.length + 1} /> : null}
      <CheckboxBox checked={false} className="mt-0.5" />
      <input
        ref={addRef}
        type="text"
        value={addValue}
        maxLength={MAX_WORK_ITEM_LENGTH}
        aria-label={addLabel}
        placeholder={typeof addHint === 'string' ? addHint : undefined}
        className={cn(inputBase, '-my-1.25 h-7.5 flex-1 px-2.5')}
        onChange={(event) => setAddValue(event.target.value)}
        onKeyDown={(event) => {
          if (event.nativeEvent.isComposing) return;
          if (event.key === 'Enter') {
            event.preventDefault();
            const trimmed = addValue.trim();
            if (trimmed) {
              onAdd?.(trimmed);
              setAddValue('');
            } else setAdding(false);
          } else if (event.key === 'Escape') {
            event.preventDefault();
            event.stopPropagation();
            setAdding(false);
            setAddValue('');
          }
        }}
        onBlur={() => {
          if (!addValue.trim()) setAdding(false);
        }}
      />
      <Kbd aria-hidden className="mt-0.5">
        ↵
      </Kbd>
    </li>
  ) : null;

  const addLine =
    canAdd && !adding ? (
      <AriaButton
        onPress={() => {
          focusAddOnRender.current = true;
          setAdding(true);
        }}
        className={cn(
          'flex h-8.5 w-full cursor-pointer items-center gap-2 text-left text-sm text-fg-3 outline-none hover:text-fg-2 focus-visible:focus-ring-inset',
          showBox ? 'rounded-b-md border-t border-line-soft px-2.5 hover:bg-bg-grp' : 'rounded-sm px-0.5',
        )}
      >
        <PlusGlyph className="size-2.25" />
        <span>{addLabel}</span>
        {!showBox && addHint ? <span className="text-xs text-fg-3">{addHint}</span> : null}
        <span className="flex-1" />
        {addKbd ? <Kbd aria-hidden>{addKbd}</Kbd> : null}
      </AriaButton>
    ) : null;

  if (!showBox) {
    return (
      <fieldset aria-label={ariaLabel} className={cn('m-0 min-w-0 border-0 p-0', className)}>
        {addLine}
      </fieldset>
    );
  }

  return (
    <fieldset
      aria-label={ariaLabel}
      className={cn('m-0 min-w-0 rounded-md border border-line-soft bg-surface p-0', className)}
    >
      <ul className="m-0 list-none p-0">
        {items.map((item, index) => {
          const key = keyOf(item);
          if (editing?.key === key && editable(item)) {
            return (
              <EditLine
                key={key}
                item={item}
                numbered={item.numbered ?? numbered}
                numberColumn={numbered}
                label={`Reword ${lineName(item, noun, item.numbered ?? numbered)}`}
                autoFocus={editing.focus}
                onDone={(text, refocus) => finishEdit(item, index, text, refocus)}
              />
            );
          }
          return (
            <Line
              key={key}
              item={item}
              noun={noun}
              numbered={item.numbered ?? numbered}
              numberColumn={numbered}
              waiving={waiving === key}
              tabbable={index === activeIndex}
              locked={!editable(item)}
              lockedReason={lockedReason}
              actions={hasActions ? actions : null}
              canToggle={onToggle != null}
              canEdit={onEdit != null}
              canWaive={onWaive != null}
              canUnwaive={onUnwaive != null}
              canMove={onMove != null}
              canRemove={onRemove != null}
              lineRef={(element) => {
                lineRefs.current[index] = element;
              }}
              rowRef={(element) => {
                rowRefs.current[index] = element;
              }}
              onFocus={() => setActive(index)}
              onKeyDown={(event) => onLineKeyDown(event, item, index)}
              onToggle={() => toggle(item)}
              onStartEdit={() => setEditing({ key, focus: true })}
              onWaive={() => startWaive(item, index)}
              onRemove={() => remove(item, index)}
            />
          );
        })}
        {addField}
      </ul>
      {addLine}
      {items.map((item, index) =>
        waiving === keyOf(item) ? (
          <WaivePopover
            key={`waive-${keyOf(item)}`}
            isOpen
            triggerRef={waiveAnchor}
            title={`Waive ${lineName(item, noun, item.numbered ?? numbered)}`}
            onWaive={(reason) => {
              setWaiving(null);
              pendingFocus.current = index;
              onWaive?.(item, reason);
            }}
            onCancel={() => {
              setWaiving(null);
              pendingFocus.current = index;
            }}
          />
        ) : null,
      )}
    </fieldset>
  );
}

/** The number column; empty for an unnumbered line in a numbered list, so the boxes stay aligned. */
function LineNumber({ value }: { value?: number }) {
  return (
    <span
      aria-hidden
      className="mt-px w-3.5 shrink-0 text-right text-xs text-fg-3 tabular-nums"
      data-part="number"
    >
      {value}
    </span>
  );
}

interface LineProps {
  item: ChecklistItem;
  noun: string;
  numbered: boolean;
  numberColumn: boolean;
  /** The waive step is open on this line: keep its hover look under the popover (frame 010). */
  waiving: boolean;
  tabbable: boolean;
  locked: boolean;
  lockedReason: ReactNode;
  actions: 'hover' | 'always' | null;
  canToggle: boolean;
  canEdit: boolean;
  canWaive: boolean;
  canUnwaive: boolean;
  canMove: boolean;
  canRemove: boolean;
  lineRef: (element: HTMLElement | null) => void;
  rowRef: (element: HTMLLIElement | null) => void;
  onFocus: () => void;
  onKeyDown: (event: KeyboardEvent<HTMLElement>) => void;
  onToggle: () => void;
  onStartEdit: () => void;
  onWaive: () => void;
  onRemove: () => void;
}

/** A line at rest: number, box, text (and the waiver line), then its actions or its lock. */
function Line({
  item,
  noun,
  numbered,
  numberColumn,
  waiving,
  tabbable,
  locked,
  lockedReason,
  actions,
  canToggle,
  canEdit,
  canWaive,
  canUnwaive,
  canMove,
  canRemove,
  lineRef,
  rowRef,
  onFocus,
  onKeyDown,
  onToggle,
  onStartEdit,
  onWaive,
  onRemove,
}: LineProps) {
  const textId = useId();
  const numberId = useId();
  const whyId = useId();
  const detailId = useId();
  const waived = item.state === 'waived';
  const checked = item.state === 'checked';
  const name = lineName(item, noun, numbered);
  const describedBy = [numbered && numberId, waived && whyId, item.detail != null && detailId]
    .filter(Boolean)
    .join(' ');
  const shortcuts = locked
    ? undefined
    : [
        canToggle && 'X',
        (canWaive || canUnwaive) && 'W',
        canEdit && 'E',
        canMove && 'Alt+ArrowUp Alt+ArrowDown',
        canRemove && 'Backspace',
      ]
        .filter(Boolean)
        .join(' ') || undefined;
  const hover = item.look === 'hover' || waiving;
  const focus = item.look === 'focus';
  const shown = hover || focus;

  const checkbox = (
    // biome-ignore lint/a11y/useSemanticElements: a native checkbox cannot hold the line's text and waiver, and the line needs three states with its own keys.
    <span
      ref={lineRef}
      role="checkbox"
      aria-checked={checked}
      aria-labelledby={textId}
      aria-describedby={describedBy || undefined}
      aria-readonly={locked || !canToggle || undefined}
      aria-keyshortcuts={shortcuts}
      tabIndex={tabbable ? 0 : -1}
      data-line-check
      onFocus={onFocus}
      onKeyDown={onKeyDown}
      onClick={() => onToggle()}
      className={cn(
        'flex min-w-0 flex-1 items-start gap-2.5 outline-none',
        !locked && canToggle ? 'cursor-pointer' : 'cursor-default',
      )}
    >
      <CheckboxBox checked={checked} waived={waived} className={cn('mt-0.5', locked && 'opacity-70')} />
      <span className="flex min-w-0 flex-1 flex-col gap-0.5 text-pretty">
        {/* biome-ignore lint/a11y/useKeyWithClickEvents lint/a11y/noStaticElementInteractions: a pointer shortcut to rewording; the keyboard has E on the line. */}
        <span
          id={textId}
          data-part="text"
          className={cn(
            waived && 'text-fg-3 line-through decoration-line',
            checked && 'text-fg-2',
            !locked && canEdit && 'cursor-text',
          )}
          onClick={
            !locked && canEdit
              ? (event) => {
                  // Clicking the words rewords the line; the box checks it.
                  event.stopPropagation();
                  onStartEdit();
                }
              : undefined
          }
        >
          {item.text}
        </span>
        {waived ? (
          <span id={whyId} className="text-xs text-fg-2">
            <b className="font-semibold">Waived</b>
            {item.waivedBy ? ` by ${item.waivedBy.name}` : null}
            {item.waivedReason ? `: ${item.waivedReason}` : null}
          </span>
        ) : null}
        {item.detail != null ? (
          <span id={detailId} className="text-xs text-fg-3">
            {item.detail}
          </span>
        ) : null}
      </span>
    </span>
  );

  // Actions show on hover and keyboard focus; in `always` mode Waive stays, and the key hint marks the
  // focused line.
  // Hidden lines take no room, so the words use the full width until the line is hovered or focused.
  const reveal = shown ? 'flex' : 'hidden group-focus-within/line:flex group-hover/line:flex';
  const kbdReveal = cn(
    'group-hover/line:inline-grid group-focus-within/line:inline-grid',
    shown ? 'inline-grid' : 'hidden',
  );
  const waiveAction = waived ? canUnwaive : canWaive;

  return (
    <li
      ref={rowRef}
      data-state={item.state}
      data-locked={locked || undefined}
      className={cn(
        'group/line relative flex items-start gap-2.5 border-b border-line-soft px-2.5 py-2 leading-normal last:border-b-0',
        'hover:bg-bg-grp has-[[data-line-check]:focus-visible]:z-1 has-[[data-line-check]:focus-visible]:rounded-sm has-[[data-line-check]:focus-visible]:shadow-[var(--focus-ring)]',
        hover && 'bg-bg-grp',
        focus && 'z-1 rounded-sm shadow-[var(--focus-ring)]',
      )}
    >
      {numbered ? (
        <>
          <LineNumber value={item.number} />
          <span id={numberId} hidden>
            {`${noun} ${item.number}`}
          </span>
        </>
      ) : numberColumn ? (
        <LineNumber />
      ) : null}
      {locked ? (
        <TooltipTrigger>
          <Focusable>{checkbox}</Focusable>
          <Tooltip placement="top end">{lockedReason}</Tooltip>
        </TooltipTrigger>
      ) : (
        checkbox
      )}
      {locked ? (
        <LockGlyph
          className={cn(
            'mt-1.25 text-fg-3 group-focus-within/line:opacity-100 group-hover/line:opacity-100',
            shown ? 'opacity-100' : 'opacity-0',
          )}
        />
      ) : actions ? (
        <span
          data-part="actions"
          className={cn(
            '-my-0.75 -mr-1 shrink-0 items-center gap-0.5 text-fg-3',
            actions === 'always' ? 'flex' : reveal,
          )}
        >
          {canMove && actions === 'hover' ? (
            <span className="mx-1.5 flex">
              <GripGlyph />
            </span>
          ) : null}
          {waiveAction ? (
            <Button
              variant="quiet"
              size="sm"
              excludeFromTabOrder
              aria-label={`${waived ? 'Unwaive' : 'Waive'} ${name}`}
              onPress={onWaive}
            >
              {waived ? 'Unwaive' : 'Waive'}
              <Kbd aria-hidden className={kbdReveal}>
                W
              </Kbd>
            </Button>
          ) : null}
          {canRemove && actions === 'hover' ? (
            <Button
              variant="quiet"
              size="sm"
              iconOnly
              excludeFromTabOrder
              aria-label={`Remove ${name}`}
              onPress={onRemove}
            >
              <CloseGlyph />
            </Button>
          ) : null}
        </span>
      ) : null}
    </li>
  );
}

/** A line in the reword field. Enter or leaving the field saves; Esc puts the old words back. */
function EditLine({
  item,
  numbered,
  numberColumn,
  label,
  autoFocus,
  onDone,
}: {
  item: ChecklistItem;
  numbered: boolean;
  numberColumn: boolean;
  label: string;
  autoFocus: boolean;
  onDone: (text: string | null, refocus: boolean) => void;
}) {
  const [value, setValue] = useState(item.text);
  const settled = useRef(false);
  const finish = (text: string | null, refocus: boolean) => {
    if (settled.current) return;
    settled.current = true;
    onDone(text, refocus);
  };
  return (
    <li
      data-state={item.state}
      data-editing
      className="flex items-start gap-2.5 border-b border-line-soft px-2.5 py-2 last:border-b-0"
    >
      {numbered || numberColumn ? <LineNumber value={numbered ? item.number : undefined} /> : null}
      <CheckboxBox checked={item.state === 'checked'} waived={item.state === 'waived'} className="mt-0.5" />
      <input
        // biome-ignore lint/a11y/noAutofocus: E opens this field to type in it straight away.
        autoFocus={autoFocus}
        type="text"
        value={value}
        maxLength={MAX_WORK_ITEM_LENGTH}
        aria-label={label}
        className={cn(inputBase, '-my-1.25 h-7.5 flex-1 px-2.5')}
        onChange={(event) => setValue(event.target.value)}
        onKeyDown={(event) => {
          if (event.nativeEvent.isComposing) return;
          if (event.key === 'Enter') {
            event.preventDefault();
            finish(value, true);
          } else if (event.key === 'Escape') {
            event.preventDefault();
            event.stopPropagation();
            finish(null, true);
          }
        }}
        onBlur={() => finish(value, false)}
      />
    </li>
  );
}
