// Switch to Zamu (M6 frames 032 to 037): the dialog first checks the git host for open pull or merge
// requests that change the task files, because their edits would never arrive after the switch. While
// the check runs, and when it fails, the confirm field and the button stay locked: there is no switch
// without a check. With open requests the person can still confirm; the dialog lists what will be lost.
// The project key typed again confirms it, since the switch can't be undone.
import type { BacklogSourceStatus, GitConnectionRef } from '@zamu/contracts';
import { type FormEvent, useCallback, useEffect, useRef, useState } from 'react';
import { Link } from 'react-aria-components';
import { errorMessage } from '~/features/settings/result';
import {
  Avatar,
  Banner,
  Button,
  CheckGlyph,
  Dialog,
  DialogBody,
  DialogFooter,
  DialogHeader,
  InlineCode,
  Modal,
  Skeleton,
  TextField,
} from '~/ui';
import { sourceTaskTotals } from './format';
import {
  checkingText,
  failureHeadline,
  hostLabel,
  keyMatches,
  loseText,
  noneOpenText,
  requestNumber,
  type SwitchCheck,
  type SwitchRequest,
  shownRequests,
} from './switch';

type Provider = GitConnectionRef['provider'] | null;

export interface SwitchDialogProps {
  isOpen: boolean;
  onOpenChange: (isOpen: boolean) => void;
  status: BacklogSourceStatus;
  projectName: string;
  /** Runs the check; a rejection reads like a failed check with the error's message. */
  onCheck: () => Promise<SwitchCheck>;
  /** Resolves when switched (the dialog closes); rejects with the error to show. */
  onSwitch: (confirmKey: string) => Promise<unknown>;
}

export function SwitchDialog({ isOpen, onOpenChange, ...props }: SwitchDialogProps) {
  return (
    <Modal width={600} top={110} isOpen={isOpen} onOpenChange={onOpenChange}>
      <SwitchContent {...props} close={() => onOpenChange(false)} />
    </Modal>
  );
}

/** Where the check is: running, answered, or failed with the words to show. */
type CheckState =
  | { kind: 'checking' }
  | { kind: 'done'; check: Extract<SwitchCheck, { ok: true }> }
  | { kind: 'failed'; reason: Extract<SwitchCheck, { ok: false }>['reason'] | null; message: string };

/** Runs the check when the dialog opens and again on Try again; a late answer of an older run is dropped. */
function useSwitchCheck(onCheck: () => Promise<SwitchCheck>) {
  const [state, setState] = useState<CheckState>({ kind: 'checking' });
  const run = useRef(0);
  const latest = useRef(onCheck);
  latest.current = onCheck;
  const start = useCallback(() => {
    const id = ++run.current;
    setState({ kind: 'checking' });
    latest
      .current()
      .then((check) => {
        if (id !== run.current) return;
        setState(
          check.ok
            ? { kind: 'done', check }
            : { kind: 'failed', reason: check.reason, message: check.message },
        );
      })
      .catch((failure: unknown) => {
        if (id !== run.current) return;
        setState({ kind: 'failed', reason: null, message: errorMessage(failure) });
      });
  }, []);
  useEffect(() => {
    start();
    return () => {
      run.current += 1;
    };
  }, [start]);
  return { state, retry: start };
}

function SwitchContent({
  status,
  projectName,
  onCheck,
  onSwitch,
  close,
}: Omit<SwitchDialogProps, 'isOpen' | 'onOpenChange'> & { close: () => void }) {
  const key = status.project.key;
  const provider: Provider = status.connection?.provider ?? null;
  const { state, retry } = useSwitchCheck(onCheck);
  const [typed, setTyped] = useState('');
  const [pending, setPending] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const checked = state.kind === 'done';
  const matches = keyMatches(typed, key);
  const canSwitch = checked && matches && !pending;
  const tasks = sourceTaskTotals(status.counts).total;
  const folder = `${status.folder ?? 'backlog'}/`;

  const submit = async (event?: FormEvent) => {
    event?.preventDefault();
    if (!canSwitch) return;
    setPending(true);
    setError(null);
    try {
      await onSwitch(typed.trim());
      close();
    } catch (failure) {
      setPending(false);
      setError(errorMessage(failure));
    }
  };

  return (
    <Dialog role="alertdialog">
      <form noValidate onSubmit={submit} className="flex min-h-0 flex-1 flex-col">
        <DialogHeader title={`Switch ${projectName} to Zamu`} showEsc={false} className="pt-4" />
        <DialogBody className="gap-3">
          <p className="m-0 leading-prose text-pretty text-fg-2">
            Zamu stops reading the task files in{' '}
            <InlineCode className="bg-transparent px-0">{folder}</InlineCode>. All {tasks}{' '}
            {tasks === 1 ? 'task keeps its number' : 'tasks keep their numbers'}, comments and history and
            become editable here.
          </p>
          {error ? <Banner>{error}</Banner> : null}
          {state.kind === 'checking' ? (
            <div role="status" aria-busy="true" className="flex flex-col gap-2">
              <span className="text-sm font-medium text-fg">{checkingText(status.connection)}</span>
              <RequestSkeleton />
            </div>
          ) : null}
          {state.kind === 'done' ? (
            <CheckAnswer
              provider={provider}
              requests={state.check.requests}
              truncated={state.check.truncated}
              listUrl={state.check.listUrl}
              host={hostLabel(status.connection)}
            />
          ) : null}
          {state.kind === 'failed' ? (
            <>
              <Banner
                action={
                  <Button variant="secondary" size="sm" onPress={retry}>
                    Try again
                  </Button>
                }
              >
                {state.reason ? failureHeadline(status.connection, state.reason) : 'The check didn’t finish.'}{' '}
                <span className="font-normal">{state.message}</span>
              </Banner>
              <p className="m-0 text-xs leading-normal text-fg-3">
                The switch stays locked until the check works, so no edit is lost without you seeing it first.
              </p>
            </>
          ) : null}
          <TextField
            label={`Type ${key} to confirm`}
            name="confirmKey"
            placeholder={key}
            mono
            autoComplete="off"
            spellCheck="false"
            value={typed}
            onChange={setTyped}
            isDisabled={!checked}
          />
        </DialogBody>
        <DialogFooter start={<span className="text-xs text-fg-3">This can’t be undone.</span>}>
          <Button variant="secondary" onPress={close}>
            Cancel
          </Button>
          <Button type="submit" variant="danger" isDisabled={!checked || !matches} isPending={pending}>
            Switch to Zamu
          </Button>
        </DialogFooter>
      </form>
    </Dialog>
  );
}

/** None open (frame 033), or the list with what will be lost (frames 034 to 036). */
function CheckAnswer({
  provider,
  requests,
  truncated,
  listUrl,
  host,
}: {
  provider: Provider;
  requests: readonly SwitchRequest[];
  truncated: boolean;
  listUrl: string;
  host: string;
}) {
  if (requests.length === 0 && !truncated) {
    return (
      <p
        role="status"
        className="m-0 flex items-center gap-2.25 rounded-md bg-ok-soft px-3 py-2.75 text-sm font-medium text-ok"
      >
        <CheckGlyph className="mx-0.5" />
        {noneOpenText(provider)}
      </p>
    );
  }
  const { shown, more } = shownRequests(requests);
  return (
    <>
      <p
        role="status"
        className="m-0 flex gap-2.25 rounded-md bg-danger-soft px-3 py-2.5 text-sm leading-normal font-medium text-danger"
      >
        <WarnGlyph />
        <span>{loseText(provider, requests.length, truncated)}</span>
      </p>
      <div className="overflow-hidden rounded-md border border-line-soft bg-bg">
        {shown.length ? (
          <ul aria-label="Open requests that change task files" className="m-0 list-none p-0">
            {shown.map((request) => (
              <RequestRow key={request.number} provider={provider} request={request} />
            ))}
          </ul>
        ) : null}
        {more || truncated ? (
          <div
            className={
              shown.length
                ? 'flex h-8.5 items-center gap-2 border-t border-line-soft px-3 text-sm text-fg-3'
                : 'flex h-8.5 items-center gap-2 px-3 text-sm text-fg-3'
            }
          >
            <span>{more ? `${more} more` : 'Others may be open'}</span>
            <span className="flex-1" />
            <Link
              href={listUrl}
              target="_blank"
              rel="noreferrer"
              className="text-accent-text outline-none hover:underline focus-visible:focus-ring"
            >
              Open the list on {host} ↗
            </Link>
          </div>
        ) : null}
      </div>
    </>
  );
}

function RequestRow({ provider, request }: { provider: Provider; request: SwitchRequest }) {
  return (
    <li className="flex h-9 items-center gap-2.5 border-b border-line-soft pr-2.5 pl-3 text-sm whitespace-nowrap last:border-b-0">
      <span className="w-10 shrink-0 font-medium text-fg-3 tabular-nums">
        {requestNumber(provider, request.number)}
      </span>
      <Link
        href={request.webUrl}
        target="_blank"
        rel="noreferrer"
        className="min-w-0 flex-1 truncate font-medium text-fg outline-none hover:underline focus-visible:focus-ring"
      >
        {request.title}
      </Link>
      {request.author ? <Avatar name={request.author} size={18} /> : null}
      <span title={request.headBranch} className="max-w-45 shrink-0 truncate font-mono text-xs text-fg-3">
        {request.headBranch}
      </span>
    </li>
  );
}

/** Three skeleton rows while the check runs (frame 032). */
function RequestSkeleton() {
  return (
    <div aria-hidden className="overflow-hidden rounded-md border border-line-soft bg-bg">
      {['45%', '60%', '30%'].map((width) => (
        <div
          key={width}
          className="flex h-9 items-center gap-3 border-b border-line-soft px-3 last:border-b-0"
        >
          <Skeleton width={48} />
          <Skeleton width={width} />
        </div>
      ))}
    </div>
  );
}

/** The ring with "!" in front of what will be lost (m6.css .glyph-warn); the words carry the meaning. */
function WarnGlyph() {
  return (
    <svg aria-hidden viewBox="0 0 16 16" width="15" height="15" className="mt-px shrink-0" fill="none">
      <circle cx="8" cy="8" r="6.75" stroke="currentColor" strokeWidth="1.5" />
      <path d="M8 4.5v4.25" stroke="currentColor" strokeWidth="1.6" strokeLinecap="round" />
      <circle cx="8" cy="11.25" r="0.95" fill="currentColor" />
    </svg>
  );
}
