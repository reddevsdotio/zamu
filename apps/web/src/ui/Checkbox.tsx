import type { ReactNode } from 'react';
import {
  Checkbox as AriaCheckbox,
  CheckboxGroup as AriaCheckboxGroup,
  type CheckboxGroupProps as AriaCheckboxGroupProps,
  type CheckboxProps as AriaCheckboxProps,
} from 'react-aria-components';
import { cn, composeTw } from './cn';
import { type FieldChromeProps, FieldDescription, FieldError, Label } from './Field';
import { CheckGlyph } from './Glyphs';

/**
 * The 14px box on its own (margin.css .box); also used for read-only markers and multi-pick menus.
 * `waived` draws a dashed outline with a short bar (m6.css .box.wv): a criterion or done item that no
 * longer applies. Pair it with struck text and the word "Waived", never with the box alone.
 */
export function CheckboxBox({
  checked,
  indeterminate,
  waived,
  className,
}: {
  checked: boolean;
  indeterminate?: boolean;
  waived?: boolean;
  className?: string;
}) {
  if (waived) {
    return (
      <span
        aria-hidden
        data-waived
        className={cn(
          'grid size-3.5 shrink-0 place-items-center rounded-[4px] border-[1.5px] border-dashed border-fg-3',
          className,
        )}
      >
        <span className="h-[1.5px] w-1.5 bg-fg-3" />
      </span>
    );
  }
  return (
    <span
      aria-hidden
      data-checked={checked || undefined}
      className={cn(
        'grid size-3.5 shrink-0 place-items-center rounded-[4px] border-[1.5px]',
        checked || indeterminate ? 'border-accent bg-accent text-accent-ink' : 'border-fg-3',
        className,
      )}
    >
      {indeterminate ? (
        <span className="h-0.5 w-1.75 rounded-full bg-current" />
      ) : checked ? (
        <CheckGlyph className="h-1.75 w-2.25" />
      ) : null}
    </span>
  );
}

export interface CheckboxProps extends Omit<AriaCheckboxProps, 'children'> {
  children?: ReactNode;
}

export function Checkbox({ children, ...props }: CheckboxProps) {
  return (
    <AriaCheckbox
      {...props}
      className={composeTw(
        props.className,
        'group inline-flex cursor-pointer items-center gap-2 text-sm text-fg outline-none disabled:cursor-default disabled:opacity-45',
      )}
    >
      {({ isSelected, isIndeterminate, isFocusVisible }) => (
        <>
          <span className={cn('inline-flex rounded-[4px]', isFocusVisible && 'shadow-[var(--focus-ring)]')}>
            <CheckboxBox checked={isSelected} indeterminate={isIndeterminate} />
          </span>
          {children}
        </>
      )}
    </AriaCheckbox>
  );
}

export interface CheckboxGroupProps extends Omit<AriaCheckboxGroupProps, 'children'>, FieldChromeProps {
  children: ReactNode;
  /** Number of columns for the options (the agent project picker uses 2). */
  columns?: 1 | 2;
}

export function CheckboxGroup({
  label,
  description,
  errorMessage,
  columns = 1,
  children,
  ...props
}: CheckboxGroupProps) {
  return (
    <AriaCheckboxGroup {...props} className={composeTw(props.className, 'flex flex-col gap-2')}>
      {label ? <Label>{label}</Label> : null}
      <div className={cn('grid gap-1.5', columns === 2 && 'grid-cols-2')}>{children}</div>
      {description ? <FieldDescription>{description}</FieldDescription> : null}
      <FieldError>{errorMessage as ReactNode}</FieldError>
    </AriaCheckboxGroup>
  );
}
