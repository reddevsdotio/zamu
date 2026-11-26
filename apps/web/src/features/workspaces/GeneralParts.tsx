// The pieces of Settings › General, without the server: the name and address form, the Leave row, the
// danger zone and the Delete dialog. GeneralSettings wires them; the /__ui gallery draws them as they are.
import type { UpdateWorkspaceInput, WorkspaceContents } from '@zamu/contracts';
import { type FormEvent, type ReactNode, useRef, useState } from 'react';
import { errorMessage, SettingsError } from '~/features/settings/result';
import {
  Banner,
  Button,
  Dialog,
  DialogBody,
  DialogFooter,
  DialogHeader,
  Modal,
  Skeleton,
  TextField,
  useHotkeys,
} from '~/ui';
import { DELETE_WORKSPACE_TEXT, deleteSentence, nameError, normalizeSlugInput, slugError } from './format';
import { SlugField } from './SlugField';

export const LEAVE_TEXT =
  'You lose access to its projects and tasks, and your API keys for it are deleted. Your tasks, comments and history stay.';

export type GeneralField = 'name' | 'slug';

/** What the server said: an error on one field (address taken or reserved) or a message for the banner. */
export interface GeneralFailure {
  field?: GeneralField;
  message: string;
}

export function generalFailure(error: unknown): GeneralFailure {
  if (error instanceof SettingsError) {
    const slug = error.issueFor('slug');
    if (slug) return { field: 'slug', message: slug };
    const name = error.issueFor('name');
    if (name) return { field: 'name', message: name };
  }
  return { message: errorMessage(error) };
}

export interface WorkspaceFormProps {
  workspace: { name: string; slug: string };
  /** Owners and admins; everyone else sees the fields read-only. */
  canEdit: boolean;
  /** Saves the changed fields; resolves to null on success or to the error to show. */
  onSubmit: (changes: UpdateWorkspaceInput) => Promise<GeneralFailure | null>;
}

/** Name and address, then Save changes and Discard. */
export function WorkspaceForm({ workspace, canEdit, onSubmit }: WorkspaceFormProps) {
  const [name, setName] = useState(workspace.name);
  const [slug, setSlug] = useState(workspace.slug);
  const [errors, setErrors] = useState<Partial<Record<GeneralField, string>>>({});
  const [failure, setFailure] = useState<string | null>(null);
  const [pending, setPending] = useState(false);
  const [saved, setSaved] = useState(false);
  const nameRef = useRef<HTMLInputElement>(null);
  const slugRef = useRef<HTMLInputElement>(null);

  const changes: UpdateWorkspaceInput = {
    ...(name.trim() !== workspace.name ? { name: name.trim() } : {}),
    ...(slug !== workspace.slug ? { slug } : {}),
  };
  const dirty = Object.keys(changes).length > 0;

  const touch = () => {
    setFailure(null);
    setSaved(false);
  };

  const submit = async (event?: FormEvent) => {
    event?.preventDefault();
    if (pending || !canEdit) return;
    if (!dirty) {
      setSaved(true);
      return;
    }
    const next: Partial<Record<GeneralField, string>> = {};
    const badName = changes.name !== undefined ? nameError(name) : null;
    if (badName) next.name = badName;
    const badSlug = changes.slug !== undefined ? slugError(slug) : null;
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
      const error = await onSubmit(changes);
      if (!error) {
        setSaved(true);
        return;
      }
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

  useHotkeys({ 'Mod+Enter': () => void submit() }, { enabled: canEdit });

  const discard = () => {
    setName(workspace.name);
    setSlug(workspace.slug);
    setErrors({});
    touch();
  };

  const slugChanged = slug !== workspace.slug;
  return (
    <form noValidate onSubmit={submit} aria-label="Workspace" className="flex flex-col gap-5.5">
      {failure ? <Banner>{failure}</Banner> : null}
      {canEdit ? null : (
        <Banner tone="note">Only owners and admins can rename the workspace or change its address.</Banner>
      )}
      <TextField
        label="Name"
        name="name"
        inputRef={nameRef}
        autoComplete="off"
        locked={!canEdit}
        value={name}
        onChange={(value) => {
          setName(value);
          setErrors((current) => ({ ...current, name: undefined }));
          touch();
        }}
        description="Shown in the switcher, on the sign-in page and in invitations."
        isInvalid={Boolean(errors.name)}
        errorMessage={errors.name}
        validationBehavior="aria"
      />
      <SlugField
        inputRef={slugRef}
        value={slug}
        isReadOnly={!canEdit}
        onChange={(value) => {
          setSlug(normalizeSlugInput(value));
          setErrors((current) => ({ ...current, slug: undefined }));
          touch();
        }}
        description={
          slugChanged
            ? `Links to /w/${workspace.slug} keep working: they open the new address.`
            : 'Old links keep working after a change: they open the new address.'
        }
        errorMessage={errors.slug}
      />
      {canEdit ? (
        <div className="flex items-center gap-2">
          <Button type="submit" isPending={pending} aria-keyshortcuts="Meta+Enter Control+Enter">
            Save changes
          </Button>
          <Button variant="secondary" onPress={discard} isDisabled={!dirty || pending}>
            Discard
          </Button>
          {saved ? (
            <span role="status" className="ml-1 text-sm text-fg-2">
              Saved.
            </span>
          ) : null}
        </div>
      ) : null}
    </form>
  );
}

function SettingsRow({
  title,
  text,
  action,
  danger = false,
}: {
  title: string;
  text: ReactNode;
  action: ReactNode;
  danger?: boolean;
}) {
  return (
    <div
      className={
        danger
          ? 'flex items-center gap-3.5 rounded-md border border-[color-mix(in_oklch,var(--danger)_35%,transparent)] p-3.5'
          : 'flex items-center gap-3.5 rounded-md border border-line p-3.5'
      }
    >
      <div className="flex min-w-0 flex-1 flex-col gap-0.5">
        <b className="font-semibold text-fg">{title}</b>
        <span className="text-sm leading-normal text-fg-3">{text}</span>
      </div>
      {action}
    </div>
  );
}

/** Leave: anyone. The server refuses the last owner and the person responsible for agents here. */
export function LeaveRow({ name, onLeave }: { name: string; onLeave: () => void }) {
  return (
    <section
      aria-labelledby="workspace-leave"
      className="flex flex-col gap-3.5 border-t border-line-soft pt-4.5"
    >
      <h3 id="workspace-leave" className="m-0 text-md font-semibold text-fg">
        Leave
      </h3>
      <SettingsRow
        title={`Leave ${name}`}
        text="You lose access to its projects and tasks. Your API keys for it are deleted."
        action={
          <Button variant="secondary" onPress={onLeave}>
            Leave workspace
          </Button>
        }
      />
    </section>
  );
}

/** The danger zone with Delete (owners only). */
export function DeleteRow({ name, onDelete }: { name: string; onDelete: () => void }) {
  return (
    <section aria-labelledby="danger-zone" className="flex flex-col gap-3.5 border-t border-line-soft pt-4.5">
      <h3 id="danger-zone" className="m-0 text-md font-semibold text-fg">
        Danger zone
      </h3>
      <SettingsRow
        danger
        title={`Delete ${name}`}
        text="Deletes its projects, tasks, agents and API keys for every member. This can't be undone."
        action={
          <Button
            variant="destructive"
            size="md"
            className="border-[color-mix(in_oklch,var(--danger)_40%,transparent)]"
            onPress={onDelete}
          >
            Delete workspace
          </Button>
        }
      />
    </section>
  );
}

export interface DeleteWorkspaceDialogProps {
  isOpen: boolean;
  onOpenChange: (isOpen: boolean) => void;
  name: string;
  slug: string;
  /** What goes with it; undefined while it loads. */
  contents: WorkspaceContents | undefined;
  contentsError?: string | null;
  /** Resolves when deleted (the caller navigates away); rejects with the error to show. */
  onDelete: (confirmSlug: string) => Promise<unknown>;
}

/** Delete with the counts and the slug typed again (frame 119's confirm, the Delete project dialog). */
export function DeleteWorkspaceDialog({ isOpen, onOpenChange, ...props }: DeleteWorkspaceDialogProps) {
  return (
    <Modal width={440} top={140} isOpen={isOpen} onOpenChange={onOpenChange}>
      <DeleteContent {...props} close={() => onOpenChange(false)} />
    </Modal>
  );
}

export function DeleteContent({
  name,
  slug,
  contents,
  contentsError,
  onDelete,
  close,
  autoFocus = true,
  initialTyped,
}: Omit<DeleteWorkspaceDialogProps, 'isOpen' | 'onOpenChange'> & {
  close: () => void;
  /** Focus the confirm field (default). The gallery turns it off. */
  autoFocus?: boolean;
  /** Starting text of the confirm field, for the gallery. */
  initialTyped?: string;
}) {
  const [typed, setTyped] = useState(initialTyped ?? '');
  const [pending, setPending] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [fieldError, setFieldError] = useState<string | null>(null);
  const matches = typed.trim().toLowerCase() === slug;

  const submit = async (event?: FormEvent) => {
    event?.preventDefault();
    if (!matches || pending) return;
    setPending(true);
    setError(null);
    setFieldError(null);
    try {
      await onDelete(typed.trim());
    } catch (failure) {
      setPending(false);
      const onField = failure instanceof SettingsError ? failure.issueFor('confirmSlug') : undefined;
      if (onField) setFieldError(onField);
      else setError(errorMessage(failure));
    }
  };

  return (
    <Dialog role="alertdialog">
      <form noValidate onSubmit={submit} className="flex min-h-0 flex-1 flex-col">
        <DialogHeader title={`Delete ${name}?`} showEsc={false} className="pt-4.5" />
        <DialogBody className="gap-3">
          {error ? <Banner>{error}</Banner> : null}
          {contentsError ? <Banner>Couldn't count what it holds. {contentsError}</Banner> : null}
          <p className="m-0 leading-prose text-fg-2">
            {contents ? (
              <b className="font-semibold text-fg">{deleteSentence(name, contents)}</b>
            ) : contentsError ? null : (
              <Skeleton width={260} className="mb-1 inline-block align-middle" />
            )}{' '}
            {DELETE_WORKSPACE_TEXT}
          </p>
          <TextField
            label={`Type ${slug} to confirm`}
            name="confirmSlug"
            autoFocus={autoFocus}
            autoComplete="off"
            spellCheck="false"
            value={typed}
            onChange={(value) => {
              setTyped(value);
              setFieldError(null);
            }}
            isInvalid={Boolean(fieldError)}
            errorMessage={fieldError ?? undefined}
            validationBehavior="aria"
          />
        </DialogBody>
        <DialogFooter>
          <Button variant="secondary" onPress={close}>
            Cancel
          </Button>
          <Button type="submit" variant="danger" isDisabled={!matches} isPending={pending}>
            Delete workspace
          </Button>
        </DialogFooter>
      </form>
    </Dialog>
  );
}
