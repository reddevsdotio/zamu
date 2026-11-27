import type { ReactNode } from 'react';
import { ToggleButton, ToggleButtonGroup } from 'react-aria-components';
import { cn } from './cn';

export interface SegmentedItem<K extends string = string> {
  id: K;
  label: string;
  /** Optional leading glyph. */
  icon?: ReactNode;
  /** This segment can't be picked (the Passed segment while a wave has open tasks). */
  isDisabled?: boolean;
}

export interface SegmentedControlProps<K extends string = string> {
  items: readonly SegmentedItem<K>[];
  value: K;
  onChange: (value: K) => void;
  'aria-label': string;
  /** Stretch to the container with equal segments and dividers (user menu theme switch). */
  fullWidth?: boolean;
  isDisabled?: boolean;
  className?: string;
}

/**
 * One-of-n switch (margin.css .seg): List / Board, Light / Dark / System. A --bg-grp track with the chosen
 * segment raised on --surface-pop. React Aria ToggleButtonGroup with
 * single selection: arrow keys move between segments, Space or Enter picks one, a selection is required.
 */
export function SegmentedControl<K extends string = string>({
  items,
  value,
  onChange,
  fullWidth = false,
  isDisabled,
  className,
  ...props
}: SegmentedControlProps<K>) {
  return (
    <ToggleButtonGroup
      aria-label={props['aria-label']}
      selectionMode="single"
      disallowEmptySelection
      isDisabled={isDisabled}
      selectedKeys={[value]}
      onSelectionChange={(keys) => {
        const next = [...keys][0];
        if (next != null && next !== value) onChange(String(next) as K);
      }}
      className={cn(
        'shrink-0 gap-0.5 rounded-md border border-line-soft bg-bg-grp p-0.5',
        fullWidth ? 'flex w-full' : 'inline-flex',
        className,
      )}
    >
      {items.map((item) => (
        <ToggleButton
          key={item.id}
          id={item.id}
          isDisabled={item.isDisabled}
          className={({ isSelected }) =>
            cn(
              'inline-flex h-6.5 cursor-pointer items-center justify-center gap-1.5 rounded-[calc(var(--radius-md)-2px)] px-2.75 text-sm font-medium outline-none select-none',
              'focus-visible:shadow-[var(--focus-ring)] disabled:cursor-default disabled:opacity-45',
              fullWidth && 'flex-1',
              isSelected ? 'bg-surface-pop text-fg shadow-card' : 'text-fg-2 hover:text-fg',
            )
          }
        >
          {item.icon}
          {item.label}
        </ToggleButton>
      ))}
    </ToggleButtonGroup>
  );
}
