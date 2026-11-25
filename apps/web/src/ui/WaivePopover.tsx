import { MAX_WORK_ITEM_LENGTH } from '@zamu/contracts';
import { type ReactNode, type RefObject, useEffect, useId, useRef, useState } from 'react';
import { Popover as AriaPopover, Dialog } from 'react-aria-components';
import { cn } from './cn';
import { inputBase } from './Field';
import { MenuFooter } from './PickerMenu';

/*
 * The waive step (m6.css .wv-pop, frame 010): a small popover under a criterion or done item with one
 * reason field. Enter waives, Esc cancels. Waiving needs a reason, so an empty Enter marks the field and
 * says why instead of closing. The panel works on its own (galleries, the finishing dialog) and inside
 * WaivePopover, which anchors it to the line.
 */

export interface WaivePanelProps {
  /** "Waive criterion 5", "Waive “Changelog has a line”". Also the dialog's accessible name. */
  title: string;
  /** Reason already typed (galleries, or reopening after an error). */
  defaultReason?: string;
  /** Called with the trimmed reason when Enter is pressed on a non-empty field. */
  onWaive: (reason: string) => void;
  /** Esc in the field. */
  onCancel: () => void;
  /** Focus the field on mount. On in WaivePopover. */
  autoFocus?: boolean;
  /** Help under the field. Defaults to "The reason stays on the task and in its history." */
  help?: ReactNode;
  className?: string;
}

export function WaivePanel({
  title,
  defaultReason = '',
  onWaive,
  onCancel,
  autoFocus = false,
  help = 'The reason stays on the task and in its history.',
  className,
}: WaivePanelProps) {
  const [reason, setReason] = useState(defaultReason);
  const [missing, setMissing] = useState(false);
  const titleId = useId();
  const helpId = useId();
  const field = useRef<HTMLInputElement>(null);
  // Focused in an effect, not with the autoFocus attribute: React focuses an autoFocus field while it
  // commits, before the popover's focus scope is registered. Inside a modal dialog the dialog's scope
  // then sees focus leave it, pulls it back, and the popover ends up focusing its own frame. By the
  // time effects run the scopes are in place, and the popover's dialog finds focus already inside.
  useEffect(() => {
    if (autoFocus) field.current?.focus({ preventScroll: true });
  }, [autoFocus]);
  return (
    <div className={cn('flex flex-col text-sm text-fg', className)}>
      <div id={titleId} className="px-3.5 pt-3 pb-1.5 text-xs font-medium text-fg-3">
        {title}
      </div>
      <div className="flex flex-col gap-1.5 px-3 pb-3">
        <input
          ref={field}
          type="text"
          value={reason}
          maxLength={MAX_WORK_ITEM_LENGTH}
          placeholder="Why it no longer applies"
          aria-labelledby={titleId}
          aria-describedby={helpId}
          aria-invalid={missing || undefined}
          data-invalid={missing || undefined}
          className={cn(inputBase, 'h-9')}
          onChange={(event) => {
            setReason(event.target.value);
            if (missing) setMissing(false);
          }}
          onKeyDown={(event) => {
            if (event.nativeEvent.isComposing) return;
            if (event.key === 'Enter') {
              event.preventDefault();
              const trimmed = reason.trim();
              if (trimmed) onWaive(trimmed);
              else setMissing(true);
            } else if (event.key === 'Escape') {
              // Handled here so the popover (or a dialog around the list) does not close a second time.
              event.preventDefault();
              event.stopPropagation();
              onCancel();
            }
          }}
        />
        <span id={helpId} className={cn('text-xs', missing ? 'font-medium text-danger' : 'text-fg-3')}>
          {missing ? 'Give a reason' : help}
        </span>
      </div>
      <MenuFooter
        hints={[
          { keys: '↵', label: 'waive' },
          { keys: 'Esc', label: 'cancel' },
        ]}
      />
    </div>
  );
}

export interface WaivePopoverProps extends Omit<WaivePanelProps, 'autoFocus' | 'className'> {
  /** The line being waived: the popover opens under it, at its right edge. */
  triggerRef: RefObject<Element | null>;
  isOpen: boolean;
}

/** WaivePanel in a 360px popover anchored to the line. Clicking outside cancels, like Esc. */
export function WaivePopover({ triggerRef, isOpen, onCancel, ...panel }: WaivePopoverProps) {
  return (
    <AriaPopover
      triggerRef={triggerRef}
      isOpen={isOpen}
      onOpenChange={(open) => {
        if (!open) onCancel();
      }}
      placement="bottom end"
      offset={4}
      crossOffset={-10}
      className="w-90 max-w-[calc(100vw-24px)] overflow-hidden rounded-lg bg-surface-pop text-fg shadow-pop outline-none"
    >
      <Dialog aria-label={panel.title} className="outline-none">
        <WaivePanel {...panel} onCancel={onCancel} autoFocus />
      </Dialog>
    </AriaPopover>
  );
}
