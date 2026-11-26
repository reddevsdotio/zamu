// Confirm dialogs that the server may refuse for good: leaving a workspace (its last owner, or the person
// responsible for agents there) and removing a member (the same agent rule). A refusal replaces the
// confirm button with Close and, when agents are the reason, lists them, so the person knows what to
// hand over or remove first. Other failures show in the banner and the action can be tried again.
import { type ReactNode, useState } from 'react';
import { Avatar, Banner, Button, Dialog, DialogBody, DialogFooter, DialogHeader, Modal } from '~/ui';
import { errorMessage, SettingsError } from '../settings/result';

/** Why the server refused for good, from a failed leave or remove. Null for errors worth retrying. */
export interface Refusal {
  message: string;
  /** Agents the person is responsible for, when that is the reason. */
  agents: string[];
}

export function refusalOf(error: unknown): Refusal | null {
  if (!(error instanceof SettingsError)) return null;
  if (error.code === 'LAST_OWNER') return { message: error.message, agents: [] };
  const agents = error.issues.filter((issue) => issue.path === 'agents').map((issue) => issue.message);
  if (error.code === 'CONFLICT' && agents.length) return { message: error.message, agents };
  return null;
}

/** The refusal: its message, then the agents in the way. */
export function RefusalNote({ refusal }: { refusal: Refusal }) {
  return (
    <div className="flex flex-col gap-2.5">
      <Banner>{refusal.message}</Banner>
      {refusal.agents.length ? (
        <ul aria-label="Agents in the way" className="m-0 flex list-none flex-col gap-1.5 p-0">
          {refusal.agents.map((name) => (
            <li key={name} className="flex items-center gap-2">
              <Avatar name={name} kind="agent" size="sm" decorative />
              <span className="font-medium">{name}</span>
            </li>
          ))}
        </ul>
      ) : null}
    </div>
  );
}

export interface ConfirmActionProps {
  isOpen: boolean;
  onOpenChange: (isOpen: boolean) => void;
  title: string;
  children: ReactNode;
  confirmLabel: string;
  /** Runs the action. The dialog closes when it resolves; a rejection shows as a refusal or an error. */
  onConfirm: () => Promise<unknown>;
  /** Shown under a refusal, e.g. a link to the agents. */
  refusalHelp?: (refusal: Refusal) => ReactNode;
}

export function ConfirmAction({ isOpen, onOpenChange, ...props }: ConfirmActionProps) {
  return (
    <Modal width={440} top={140} isOpen={isOpen} onOpenChange={onOpenChange}>
      <ConfirmContent {...props} close={() => onOpenChange(false)} />
    </Modal>
  );
}

function ConfirmContent({
  title,
  children,
  confirmLabel,
  onConfirm,
  refusalHelp,
  close,
}: Omit<ConfirmActionProps, 'isOpen' | 'onOpenChange'> & { close: () => void }) {
  const [pending, setPending] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [refusal, setRefusal] = useState<Refusal | null>(null);

  const confirm = async () => {
    setPending(true);
    setError(null);
    try {
      await onConfirm();
      close();
    } catch (failure) {
      setPending(false);
      const refused = refusalOf(failure);
      if (refused) setRefusal(refused);
      else setError(errorMessage(failure));
    }
  };

  return (
    <Dialog role="alertdialog">
      <DialogHeader title={title} showEsc={false} className="pt-4.5" />
      <DialogBody>
        {refusal ? (
          <>
            <RefusalNote refusal={refusal} />
            {refusalHelp?.(refusal)}
          </>
        ) : (
          <>
            {error ? <Banner>{error}</Banner> : null}
            <div className="leading-normal text-fg-2">{children}</div>
          </>
        )}
      </DialogBody>
      <DialogFooter>
        {refusal ? (
          <Button variant="secondary" onPress={close} autoFocus>
            Close
          </Button>
        ) : (
          <>
            <Button variant="secondary" onPress={close}>
              Cancel
            </Button>
            <Button variant="destructive" size="md" isPending={pending} onPress={confirm}>
              {confirmLabel}
            </Button>
          </>
        )}
      </DialogFooter>
    </Dialog>
  );
}
