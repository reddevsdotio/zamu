// "Change" on the Repository settings page (and "Link a repository" in its empty state): the
// repository URL, saved through the project update, and the connection Zamu reads it with, chosen among
// the workspace's connections for that host or "None: public repository". A mirrored project keeps its
// URL here: the Backlog.md mirror reads it, so only General can unlink it.

import type { GitConnection } from '@zamu/contracts';
import { type FormEvent, useRef, useState } from 'react';
import { Link } from 'react-aria-components';
import { repositoryError } from '~/features/projects/validation';
import {
  Banner,
  Button,
  CONNECTION_STATUS_LABELS,
  Dialog,
  DialogBody,
  DialogFooter,
  DialogHeader,
  InlineCode,
  Modal,
  ProviderBadge,
  RadioCard,
  RadioGroup,
  Skeleton,
  TextField,
} from '~/ui';
import { connectionsForHost, initialConnection, repositoryFailure, repositoryHostOf } from './repository';

/** What the dialog saves: a new repository URL (when it changed) and the connection (null: none). */
export interface RepositoryChanges {
  repository?: string;
  connectionId: string | null;
}

export interface RepositoryDialogProps {
  isOpen: boolean;
  onOpenChange: (isOpen: boolean) => void;
  /** The project's repository URL; null links one. */
  repository: string | null;
  /** The connection the link reads with now. */
  connectionId: string | null;
  /** The URL belongs to the Backlog.md mirror and can't change here. */
  locked?: boolean;
  /** The workspace's connections; undefined while they load. */
  connections: readonly GitConnection[] | undefined;
  /** Workspace settings › Git connections. */
  connectionsHref: string;
  /** Saves; the dialog shows the error when it rejects. */
  onSave: (changes: RepositoryChanges) => Promise<unknown>;
}

const NONE = 'none';

export function RepositoryDialog({ isOpen, onOpenChange, ...props }: RepositoryDialogProps) {
  return (
    <Modal width={520} top={120} isOpen={isOpen} onOpenChange={onOpenChange}>
      <Content {...props} close={() => onOpenChange(false)} />
    </Modal>
  );
}

function Content({
  repository,
  connectionId,
  locked = false,
  connections,
  connectionsHref,
  onSave,
  close,
}: Omit<RepositoryDialogProps, 'isOpen' | 'onOpenChange'> & { close: () => void }) {
  const [url, setUrl] = useState(repository ?? '');
  const [urlError, setUrlError] = useState<string | undefined>();
  const [picked, setPicked] = useState<string | null>(null);
  const [pending, setPending] = useState(false);
  const [failure, setFailure] = useState<string | null>(null);
  const urlRef = useRef<HTMLInputElement>(null);

  const host = repositoryHostOf(url);
  const matching = connectionsForHost(connections ?? [], host);
  const fits = (id: string | null) => id === NONE || matching.some((connection) => connection.id === id);
  // A pick that no longer fits the typed host falls back to what the server would choose.
  const value = picked && fits(picked) ? picked : (initialConnection(connectionId, matching) ?? NONE);

  const submit = async (event?: FormEvent) => {
    event?.preventDefault();
    if (pending) return;
    const trimmed = url.trim();
    const error = trimmed ? repositoryError(trimmed) : 'Enter the URL you clone the repository from.';
    if (error) {
      setUrlError(error);
      urlRef.current?.focus();
      return;
    }
    setPending(true);
    setFailure(null);
    try {
      await onSave({
        ...(trimmed !== (repository ?? '') ? { repository: trimmed } : {}),
        connectionId: value === NONE ? null : value,
      });
      close();
    } catch (failed) {
      setPending(false);
      setFailure(repositoryFailure(failed));
    }
  };

  return (
    <Dialog>
      <form noValidate onSubmit={submit} className="flex min-h-0 flex-1 flex-col">
        <DialogHeader title={repository ? 'Change the repository' : 'Link a repository'} />
        <DialogBody className="gap-4">
          {failure ? <Banner>{failure}</Banner> : null}
          <p className="m-0 leading-prose text-pretty text-fg-2">
            Zamu reads this repository’s pull requests and never writes to it.
          </p>
          <TextField
            label="Repository URL"
            name="repository"
            inputRef={urlRef}
            mono
            locked={locked}
            autoFocus={!locked}
            autoComplete="off"
            spellCheck="false"
            placeholder="https://github.com/northwind/payments"
            value={url}
            onChange={(next) => {
              setUrl(next);
              setUrlError(undefined);
              setFailure(null);
            }}
            onBlur={() => {
              if (url.trim()) setUrlError(repositoryError(url.trim()));
            }}
            description={
              locked ? (
                'The Backlog.md mirror reads this repository, so it can’t change here. Unlinking it in General pauses the mirror.'
              ) : (
                <>
                  The URL you clone from, HTTPS or SSH. From a clone, <InlineCode>zamu link</InlineCode> sets
                  it too.
                </>
              )
            }
            isInvalid={Boolean(urlError)}
            errorMessage={urlError}
            validationBehavior="aria"
          />
          {connections === undefined ? (
            <div aria-busy className="flex flex-col gap-2">
              <Skeleton width={120} />
              <Skeleton height={44} />
              <Skeleton height={44} />
            </div>
          ) : (
            <RadioGroup
              label="Read it with"
              value={value}
              onChange={setPicked}
              description={
                host && matching.length === 0 ? (
                  <>
                    No connection of this workspace reads {host}.{' '}
                    <Link
                      href={connectionsHref}
                      className="text-accent-text outline-none hover:underline focus-visible:focus-ring"
                    >
                      Add one in Git connections
                    </Link>{' '}
                    to read a private repository.
                  </>
                ) : !host ? (
                  'Enter the repository URL to see the connections for its host.'
                ) : undefined
              }
            >
              {matching.map((connection) => (
                <RadioCard
                  key={connection.id}
                  value={connection.id}
                  label={
                    <span className="inline-flex items-center gap-2">
                      <ProviderBadge provider={connection.provider} size="sm" decorative />
                      <span className="font-medium text-fg">{connection.name}</span>
                    </span>
                  }
                  description={`${connection.host} · ${CONNECTION_STATUS_LABELS[connection.status]}`}
                />
              ))}
              <RadioCard
                value={NONE}
                label={<span className="font-medium text-fg">None: public repository</span>}
                description="Zamu reads it without a token, so a private repository can’t be read."
              />
            </RadioGroup>
          )}
        </DialogBody>
        <DialogFooter>
          <Button variant="secondary" onPress={close}>
            Cancel
          </Button>
          <Button type="submit" isPending={pending}>
            {repository ? 'Save' : 'Link repository'}
          </Button>
        </DialogFooter>
      </form>
    </Dialog>
  );
}
