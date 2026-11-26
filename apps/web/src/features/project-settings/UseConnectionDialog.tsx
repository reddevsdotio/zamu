// "Use another connection" on a paused mirror (frame 2i): read the repository through another git
// connection of the workspace. The source resumes when the new connection works.

import { useQuery } from '@tanstack/react-query';
import { type BacklogSourceStatus, parseRepositoryUrl } from '@zamu/contracts';
import { type FormEvent, useState } from 'react';
import { Link } from 'react-aria-components';
import { connectionsHref } from '~/features/shell/paths';
import { useApi, useWorkspaceSlug } from '~/lib/workspace';
import {
  Banner,
  Button,
  CONNECTION_STATUS_LABELS,
  Dialog,
  DialogBody,
  DialogFooter,
  DialogHeader,
  Modal,
  type OptionItem,
  ProviderBadge,
  Select,
  Skeleton,
} from '~/ui';
import { connectionsQuery } from '../connections/queries';
import { errorMessage } from '../settings/result';

export interface UseConnectionDialogProps {
  isOpen: boolean;
  onOpenChange: (isOpen: boolean) => void;
  status: BacklogSourceStatus;
  onPick: (connectionId: string) => Promise<unknown>;
}

export function UseConnectionDialog({ isOpen, onOpenChange, ...props }: UseConnectionDialogProps) {
  return (
    <Modal width={480} top={120} isOpen={isOpen} onOpenChange={onOpenChange}>
      <Content {...props} close={() => onOpenChange(false)} />
    </Modal>
  );
}

function Content({
  status,
  onPick,
  close,
}: Omit<UseConnectionDialogProps, 'isOpen' | 'onOpenChange'> & { close: () => void }) {
  const api = useApi();
  const workspace = useWorkspaceSlug();
  const list = useQuery(connectionsQuery(api));
  const current = status.connection?.id ?? null;
  const items: OptionItem[] = (list.data?.items ?? []).map((connection) => ({
    id: connection.id,
    label: connection.name,
    description: `${connection.host} · ${CONNECTION_STATUS_LABELS[connection.status]}`,
    prefix: <ProviderBadge provider={connection.provider} size="sm" decorative />,
  }));
  const firstOther = items.find((item) => item.id !== current)?.id ?? null;
  const [picked, setPicked] = useState<string | null>(null);
  const value = picked ?? (firstOther as string | null);
  const [pending, setPending] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const submit = async (event?: FormEvent) => {
    event?.preventDefault();
    if (!value || pending) return;
    setPending(true);
    setError(null);
    try {
      await onPick(value);
      close();
    } catch (failure) {
      setPending(false);
      setError(errorMessage(failure));
    }
  };

  return (
    <Dialog>
      <form noValidate onSubmit={submit} className="flex min-h-0 flex-1 flex-col">
        <DialogHeader title="Use another connection" />
        <DialogBody>
          {error ? <Banner>{error}</Banner> : null}
          <p className="m-0 leading-prose text-fg-2">
            The mirror reads{' '}
            {status.repository
              ? (parseRepositoryUrl(status.repository)?.short ?? status.repository)
              : 'the repository'}{' '}
            through this connection from now on. It resumes on the next refresh if the connection can read the
            repository.
          </p>
          {list.isPending ? (
            <Skeleton height={38} />
          ) : items.length ? (
            <Select
              label="Connection"
              items={items}
              value={value}
              onChange={(key) => setPicked(key == null ? null : String(key))}
            />
          ) : (
            <p className="m-0 text-fg-2">
              The workspace has no git connections.{' '}
              <Link
                href={connectionsHref(workspace)}
                className="text-accent-text outline-none hover:underline focus-visible:focus-ring"
              >
                Add one in Settings
              </Link>
              .
            </p>
          )}
        </DialogBody>
        <DialogFooter>
          <Button variant="secondary" onPress={close}>
            Cancel
          </Button>
          <Button type="submit" isDisabled={!value || value === current} isPending={pending}>
            Use this connection
          </Button>
        </DialogFooter>
      </form>
    </Dialog>
  );
}
