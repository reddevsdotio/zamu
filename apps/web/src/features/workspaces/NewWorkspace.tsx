// New workspace (PM-39): a name and the address it gets, as the New project dialog asks for a name
// and a key. The address follows the name until the person types their own: suggested at once from
// the name, then replaced by the server's free suggestion (acme-2 while acme is taken). A reserved
// address shows its error while typing; a taken one comes back from the server under the field.
// The same form sits in the dialog (switcher, palette) and on /welcome.
import type { CreateWorkspaceInput } from '@zamu/contracts';
import { isReservedWorkspaceSlug, suggestWorkspaceSlug, WORKSPACE_SLUG_MESSAGES } from '@zamu/contracts';
import { type FormEvent, useEffect, useRef, useState } from 'react';
import { useSubmitHint } from '~/features/projects/NewProjectDialog';
import {
  Banner,
  Button,
  Dialog,
  DialogBody,
  DialogFooter,
  DialogHeader,
  Modal,
  TextField,
  useHotkeys,
} from '~/ui';
import { errorMessage, SettingsError } from '../settings/result';
import { addressHint, nameError, normalizeSlugInput, slugError } from './format';
import { SlugField } from './SlugField';

export type NewWorkspaceField = 'name' | 'slug';

/** What the server said: an error on one field (address taken) or a message for the banner. */
export interface NewWorkspaceFailure {
  field?: NewWorkspaceField;
  message: string;
}

/** A failed create as the form shows it: under the name or the address, else in the banner. */
export function newWorkspaceFailure(error: unknown): NewWorkspaceFailure {
  if (error instanceof SettingsError) {
    const slug = error.issueFor('slug');
    if (slug) return { field: 'slug', message: slug };
    const name = error.issueFor('name');
    if (name) return { field: 'name', message: name };
  }
  return { message: errorMessage(error) };
}

export interface NewWorkspaceFormProps {
  /** Creates the workspace; resolves to null on success (the caller navigates) or to the error to show. */
  onSubmit: (input: CreateWorkspaceInput) => Promise<NewWorkspaceFailure | null>;
  /** A free address for the name, from the server; null keeps the one suggested in the browser. */
  suggestSlug?: (name: string) => Promise<string | null>;
  /** Shown as Cancel in the dialog; the /welcome form has none. */
  onCancel?: () => void;
  /** `dialog`: header, body and footer of the kit's dialog. `page`: a plain column for /welcome. */
  layout?: 'dialog' | 'page';
  /** Focus the name on open (default). The gallery turns it off. */
  autoFocus?: boolean;
  /** Starting values, for the /__ui gallery's states: a typed address, an error on a field. */
  initial?: {
    name?: string;
    slug?: string;
    errors?: Partial<Record<NewWorkspaceField, string>>;
  };
}

/** How long typing pauses before the server is asked for a free address. */
export const SUGGEST_DELAY_MS = 250;

function slugHint(slug: string, suggested: boolean): string {
  const prefix = suggested && slug ? 'Suggested from the name. ' : '';
  return `${prefix}${addressHint(slug)} You can change it later in General settings.`;
}

export function NewWorkspaceForm({
  onSubmit,
  suggestSlug,
  onCancel,
  layout = 'dialog',
  autoFocus = true,
  initial,
}: NewWorkspaceFormProps) {
  const [name, setName] = useState(initial?.name ?? '');
  const [slug, setSlug] = useState(
    () => initial?.slug ?? (initial?.name ? suggestWorkspaceSlug(initial.name) : ''),
  );
  // The address follows the name until the person types their own.
  const [slugEdited, setSlugEdited] = useState(initial?.slug !== undefined);
  const [errors, setErrors] = useState<Partial<Record<NewWorkspaceField, string>>>(initial?.errors ?? {});
  const [failure, setFailure] = useState<string | null>(null);
  const [pending, setPending] = useState(false);
  const submitHint = useSubmitHint();
  const nameRef = useRef<HTMLInputElement>(null);
  const slugRef = useRef<HTMLInputElement>(null);

  // The server's free suggestion, once typing pauses. A newer name, or a typed address, wins.
  const suggestFor = useRef(suggestSlug);
  suggestFor.current = suggestSlug;
  useEffect(() => {
    const wanted = name.trim();
    if (slugEdited || !wanted || !suggestFor.current) return;
    let current = true;
    const timer = setTimeout(() => {
      void suggestFor
        .current?.(wanted)
        .then((free) => {
          if (current && free) setSlug(free);
        })
        .catch(() => {});
    }, SUGGEST_DELAY_MS);
    return () => {
      current = false;
      clearTimeout(timer);
    };
  }, [name, slugEdited]);

  const onNameChange = (next: string) => {
    setName(next);
    if (!slugEdited) setSlug(next.trim() ? suggestWorkspaceSlug(next) : '');
    setErrors((current) => ({ ...current, name: undefined, ...(slugEdited ? {} : { slug: undefined }) }));
    setFailure(null);
  };

  const onSlugChange = (raw: string) => {
    const next = normalizeSlugInput(raw);
    setSlug(next);
    // Clearing the address hands it back to the suggestion, which the next change of the name fills.
    setSlugEdited(next !== '');
    setErrors((current) => ({ ...current, slug: undefined }));
    setFailure(null);
  };

  const submit = async () => {
    if (pending) return;
    const next: Partial<Record<NewWorkspaceField, string>> = {};
    const badName = nameError(name);
    if (badName) next.name = badName;
    const badSlug = slug ? slugError(slug) : null;
    if (badSlug) next.slug = badSlug;
    if (next.name || next.slug) {
      setErrors(next);
      (next.name ? nameRef : slugRef).current?.focus();
      return;
    }
    setErrors({});
    setFailure(null);
    setPending(true);
    try {
      const error = await onSubmit({ name: name.trim(), ...(slug ? { slug } : {}) });
      if (!error) return;
      if (error.field) {
        setErrors({ [error.field]: error.message });
        (error.field === 'name' ? nameRef : slugRef).current?.focus();
      } else {
        setFailure(error.message);
      }
    } finally {
      setPending(false);
    }
  };

  const inDialog = layout === 'dialog';
  useHotkeys({ 'Mod+Enter': () => void submit() }, { allowInOverlays: true, enabled: inDialog });

  const onFormSubmit = (event: FormEvent<HTMLFormElement>) => {
    event.preventDefault();
    void submit();
  };

  // Reserved words are known in the browser: say so while typing instead of after Create.
  const slugMessage =
    errors.slug ?? (slug && isReservedWorkspaceSlug(slug) ? WORKSPACE_SLUG_MESSAGES.reserved : undefined);

  const fields = (
    <>
      {failure ? <Banner>{failure}</Banner> : null}
      <TextField
        label="Name"
        name="name"
        inputRef={nameRef}
        autoFocus={autoFocus}
        autoComplete="off"
        placeholder="Acme"
        value={name}
        onChange={onNameChange}
        isInvalid={Boolean(errors.name)}
        errorMessage={errors.name}
        validationBehavior="aria"
      />
      <SlugField
        inputRef={slugRef}
        value={slug}
        onChange={onSlugChange}
        description={slugHint(slug, !slugEdited)}
        errorMessage={slugMessage}
      />
    </>
  );

  const create = (
    <Button
      type="submit"
      isPending={pending}
      {...(inDialog ? { kbd: submitHint, 'aria-keyshortcuts': 'Meta+Enter Control+Enter' } : {})}
    >
      Create workspace
    </Button>
  );

  if (!inDialog) {
    return (
      <form noValidate aria-label="New workspace" onSubmit={onFormSubmit} className="flex flex-col gap-4.5">
        {fields}
        <div className="flex">{create}</div>
      </form>
    );
  }

  return (
    <form noValidate onSubmit={onFormSubmit} className="flex min-h-0 flex-1 flex-col">
      <DialogHeader title="New workspace" />
      <DialogBody>
        <p className="m-0 leading-prose text-fg-2">
          You become its owner. Projects, members and API keys stay inside it.
        </p>
        {fields}
      </DialogBody>
      <DialogFooter>
        <Button variant="secondary" onPress={onCancel}>
          Cancel
        </Button>
        {create}
      </DialogFooter>
    </form>
  );
}

export interface NewWorkspaceDialogProps extends Omit<NewWorkspaceFormProps, 'onCancel' | 'layout'> {
  isOpen: boolean;
  onClose: () => void;
}

/** The New workspace dialog, 500 wide like New project. */
export function NewWorkspaceDialog({ isOpen, onClose, ...props }: NewWorkspaceDialogProps) {
  return (
    <Modal
      isOpen={isOpen}
      onOpenChange={(open) => {
        if (!open) onClose();
      }}
      width={500}
      top={120}
    >
      <Dialog>
        <NewWorkspaceForm {...props} onCancel={onClose} layout="dialog" />
      </Dialog>
    </Modal>
  );
}
