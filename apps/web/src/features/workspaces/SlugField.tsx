// The workspace address field of the New workspace dialog and General settings: the server's address
// and /w/ as a fixed prefix inside the input (frame 127's "Web address"), then the slug the person
// types. Errors and hints sit under it like any kit field.
import type { ReactNode, Ref } from 'react';
import { useSyncExternalStore } from 'react';
import { TextField as AriaTextField, Input } from 'react-aria-components';
import { cn, FieldDescription, FieldError, Label } from '~/ui';

const noSubscribe = () => () => {};

/** The host the app is open on; null during the server render. */
export function useHost(): string | null {
  return useSyncExternalStore(
    noSubscribe,
    () => window.location.host,
    () => null,
  );
}

export interface SlugFieldProps {
  label?: ReactNode;
  value: string;
  onChange: (value: string) => void;
  description?: ReactNode;
  errorMessage?: string;
  isReadOnly?: boolean;
  autoFocus?: boolean;
  inputRef?: Ref<HTMLInputElement>;
  name?: string;
}

export function SlugField({
  label = 'Address',
  value,
  onChange,
  description,
  errorMessage,
  isReadOnly,
  autoFocus,
  inputRef,
  name = 'slug',
}: SlugFieldProps) {
  const host = useHost();
  return (
    <AriaTextField
      name={name}
      value={value}
      onChange={onChange}
      isReadOnly={isReadOnly}
      autoFocus={autoFocus}
      isInvalid={Boolean(errorMessage)}
      validationBehavior="aria"
      autoComplete="off"
      spellCheck="false"
      className="flex flex-col gap-1.5"
    >
      {({ isInvalid }) => (
        <>
          <Label>{label}</Label>
          <span
            className={cn(
              'flex h-9 min-w-0 items-center rounded-sm border border-line bg-surface text-md',
              'focus-within:border-accent focus-within:shadow-[0_0_0_3px_var(--accent-soft)]',
              isInvalid && 'border-danger shadow-[0_0_0_3px_var(--danger-soft)]',
              isReadOnly && 'border-transparent bg-bg-lane shadow-none',
            )}
          >
            <span aria-hidden className="shrink-0 truncate pl-2.75 text-fg-3">
              {host ? `${host}/w/` : '/w/'}
            </span>
            <Input
              ref={inputRef}
              className={cn(
                'h-full w-full min-w-0 bg-transparent pr-2.75 pl-0.5 text-fg tabular-nums outline-none',
                isReadOnly && 'text-fg-2',
              )}
            />
          </span>
          {description && !isInvalid ? <FieldDescription>{description}</FieldDescription> : null}
          <FieldError>{errorMessage}</FieldError>
        </>
      )}
    </AriaTextField>
  );
}
