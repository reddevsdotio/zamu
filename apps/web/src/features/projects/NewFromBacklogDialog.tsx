import { useQuery } from '@tanstack/react-query';
import {
  type BacklogDetection,
  type BacklogMode,
  CreateProjectFromBacklogInput,
  type GitConnection,
  PROJECT_KEY_PATTERN,
  parseRepositoryUrl,
} from '@zamu/contracts';
import { type FormEvent, type ReactNode, useEffect, useRef, useState } from 'react';
import { Link } from 'react-aria-components';
import { connectionReads, pickConnection } from '~/features/backlog-setup/connections';
import { SettingsError } from '~/features/settings/result';
import { connectionsHref } from '~/features/shell/paths';
import { useWorkspaceSlug } from '~/lib/workspace';
import {
  Banner,
  Button,
  Dialog,
  DialogBody,
  DialogFooter,
  DialogHeader,
  Modal,
  type OptionItem,
  ProviderBadge,
  RadioCard,
  RadioGroup,
  Select,
  SourceStatusDot,
  TextField,
  useHotkeys,
} from '~/ui';
import { useSubmitHint } from './NewProjectDialog';
import { normalizeKeyInput, repositoryError, suggestKey } from './validation';

// New project from Backlog.md (frames 6a to 6c): repository, the connection picked by host, name and
// key, mode. Create and continue opens the setup at Mappings with the mode and connection filled.

/**
 * Reads a repository before the project exists (the box the frames show under the repository).
 * Without it the box is left out and name and key are suggested from the repository.
 */
export type DetectRepository = (input: {
  repository: string;
  connectionId: string;
}) => Promise<BacklogDetection>;

export type NewFromBacklogField = 'repository' | 'connectionId' | 'name' | 'key';

export interface NewFromBacklogFailure {
  field?: NewFromBacklogField;
  message: string;
}

export interface NewFromBacklogDialogProps {
  isOpen: boolean;
  onClose: () => void;
  /** Undefined while loading. */
  connections: readonly GitConnection[] | undefined;
  /** False when APP_ENCRYPTION_KEY is missing on the server. */
  encryptionReady: boolean;
  /** Creates the project; resolves to null on success or to the error to show. */
  onSubmit: (input: CreateProjectFromBacklogInput) => Promise<NewFromBacklogFailure | null>;
  detect?: DetectRepository | undefined;
}

export function NewFromBacklogDialog({ isOpen, onClose, ...props }: NewFromBacklogDialogProps) {
  return (
    <Modal
      isOpen={isOpen}
      onOpenChange={(open) => {
        if (!open) onClose();
      }}
      width={640}
      top={40}
    >
      <Dialog>
        <NewFromBacklogForm onCancel={onClose} {...props} />
      </Dialog>
    </Modal>
  );
}

/** Pause after typing before the repository is read. */
const DETECT_DELAY_MS = 400;

const FIELDS: readonly NewFromBacklogField[] = ['repository', 'connectionId', 'name', 'key'];

function messageFor(field: NewFromBacklogField, code: string, message: string): string {
  if (field === 'name') {
    if (code === 'too_small') return 'Enter a project name.';
    if (code === 'too_big') return 'Use 100 characters or fewer.';
  }
  if (field === 'key') return 'Use 2 to 6 letters or digits, starting with a letter.';
  if (field === 'connectionId') return 'Pick a connection that reads this repository.';
  return message;
}

/** The repository name as a project name: "reddevs/notes-sync" → "notes-sync". */
function nameFromRepository(repository: string): string {
  const parsed = parseRepositoryUrl(repository);
  return parsed?.path.split('/').at(-1) ?? '';
}

/** Key from the Backlog.md prefix when it is a valid project key, else suggested from the name. */
export function keyForDetection(prefix: string | null | undefined, name: string): string {
  if (prefix && PROJECT_KEY_PATTERN.test(prefix)) return prefix;
  return suggestKey(name);
}

function connectionItems(connections: readonly GitConnection[], host: string | null): OptionItem[] {
  return connections.map((connection) => ({
    id: connection.id,
    label: connection.name,
    prefix: <ProviderBadge provider={connection.provider} size="sm" decorative />,
    ...(host && !connectionReads(connection, host)
      ? { isDisabled: true, description: `Reads ${connection.host}` }
      : {}),
  }));
}

function folderCount(detection: BacklogDetection, ...paths: string[]): number {
  return detection.folders
    .filter((entry) => paths.includes(entry.path))
    .reduce((sum, entry) => sum + entry.count, 0);
}

function DetectionBox({ detection, host }: { detection: BacklogDetection; host: string }) {
  if (detection.access !== 'ok') {
    const why =
      detection.access === 'not_found'
        ? `${host} answered 404: the token can't see this repository.`
        : detection.access === 'no_access'
          ? `${host} rejected the connection's token.`
          : `${host} could not be reached.`;
    return <DetectionStrip tone="failed">{why}</DetectionStrip>;
  }
  if (!detection.folder) {
    return (
      <DetectionStrip tone="failed">
        <b className="font-semibold">No Backlog.md folder on {detection.defaultBranch}.</b> The setup can
        point at another folder after you create the project.
      </DetectionStrip>
    );
  }
  const count = (value: number, one: string, many: string) =>
    `${value.toLocaleString('en-US')} ${value === 1 ? one : many}`;
  return (
    <DetectionStrip tone="healthy">
      <div className="min-w-0">
        <b className="font-semibold">
          Found <span className="font-mono text-xs">{detection.folder}/</span> on {detection.defaultBranch}
        </b>
        {detection.config ? (
          <>
            {' '}
            ·{detection.config.projectName ? ` project “${detection.config.projectName}”,` : ''} prefix{' '}
            <span className="tabular-nums text-xs font-medium">{detection.config.taskPrefix}</span>
          </>
        ) : null}
        <div className="mt-0.5 flex flex-wrap gap-x-3 gap-y-0.5 tabular-nums text-xs text-fg-2">
          <span>{count(folderCount(detection, 'tasks/'), 'task', 'tasks')}</span>
          <span>{count(folderCount(detection, 'drafts/'), 'draft', 'drafts')}</span>
          <span>{count(folderCount(detection, 'archive/tasks/', 'completed/'), 'archived', 'archived')}</span>
          <span>
            {count(folderCount(detection, 'milestones/', 'archive/milestones/'), 'milestone', 'milestones')}
          </span>
        </div>
      </div>
    </DetectionStrip>
  );
}

function DetectionStrip({ tone, children }: { tone: 'healthy' | 'failed' | 'reading'; children: ReactNode }) {
  return (
    <div className="flex items-start gap-2.5 rounded-md border border-line bg-bg-lane px-3 py-2.5 text-sm leading-normal">
      <SourceStatusDot state={tone} decorative className="mt-1.25" />
      <div className="min-w-0 flex-1">{children}</div>
    </div>
  );
}

function AddConnectionLink({ children }: { children: ReactNode }) {
  const workspace = useWorkspaceSlug();
  return (
    <Link
      href={connectionsHref(workspace)}
      target="_blank"
      rel="noreferrer"
      className="cursor-pointer text-accent outline-none hover:underline focus-visible:focus-ring"
    >
      {children}
    </Link>
  );
}

interface FormProps extends Omit<NewFromBacklogDialogProps, 'isOpen' | 'onClose'> {
  onCancel: () => void;
}

type Errors = Partial<Record<NewFromBacklogField, string>>;

export function NewFromBacklogForm({ onCancel, connections, encryptionReady, onSubmit, detect }: FormProps) {
  const [repository, setRepository] = useState('');
  const [connectionId, setConnectionId] = useState<string | null>(null);
  const [name, setName] = useState('');
  const [key, setKey] = useState('');
  const [mode, setMode] = useState<BacklogMode>('mirror');
  // Name and key follow the repository (and detection) until the person types their own.
  const [nameEdited, setNameEdited] = useState(false);
  const [keyEdited, setKeyEdited] = useState(false);
  const [connectionEdited, setConnectionEdited] = useState(false);
  const [errors, setErrors] = useState<Errors>({});
  const [failure, setFailure] = useState<string | null>(null);
  const [pending, setPending] = useState(false);
  const submitHint = useSubmitHint();
  const inputs = {
    repository: useRef<HTMLInputElement>(null),
    name: useRef<HTMLInputElement>(null),
    key: useRef<HTMLInputElement>(null),
  };

  const parsed = parseRepositoryUrl(repository);
  const picked = connections ? pickConnection(connections, repository) : null;
  const effectiveConnection = connectionEdited ? connectionId : (picked?.id ?? null);

  // Read the repository once typing pauses, not on every keystroke.
  const [settled, setSettled] = useState('');
  useEffect(() => {
    const timer = setTimeout(() => setSettled(repository.trim()), DETECT_DELAY_MS);
    return () => clearTimeout(timer);
  }, [repository]);
  const settledRepository = settled === repository.trim() ? parseRepositoryUrl(settled) : null;
  const detection = useQuery({
    queryKey: ['backlog-setup', 'detect-repository', settledRepository?.key ?? null, effectiveConnection],
    queryFn: () =>
      (detect as DetectRepository)({ repository: settled, connectionId: effectiveConnection as string }),
    enabled: Boolean(detect && settledRepository && effectiveConnection),
    retry: false,
    staleTime: 5 * 60_000,
  });
  const detected = detection.data;

  // Follow the repository (and what detection read) until the person edits the field.
  const suggestedName = detected?.config?.projectName ?? (parsed ? nameFromRepository(repository) : '');
  const shownName = nameEdited ? name : suggestedName;
  const suggestedKey = keyForDetection(detected?.config?.taskPrefix, shownName);
  const shownKey = keyEdited ? key : suggestedKey;

  // A prefix too long for a key (frame 6c): put the person in the key field, once per repository.
  const prefix = detected?.config?.taskPrefix ?? null;
  const prefixFits = prefix ? PROJECT_KEY_PATTERN.test(prefix) : false;
  const focusedFor = useRef<string | null>(null);
  useEffect(() => {
    if (!detected || !prefix || prefixFits || keyEdited) return;
    if (focusedFor.current === detected.repository) return;
    focusedFor.current = detected.repository;
    if (document.activeElement === inputs.name.current) return;
    inputs.key.current?.focus();
  }, [detected, prefix, prefixFits, keyEdited, inputs.key, inputs.name]);

  useEffect(() => {
    if (errors.connectionId && effectiveConnection)
      setErrors((current) => ({ ...current, connectionId: undefined }));
  }, [effectiveConnection, errors.connectionId]);

  // A cleared key follows the suggestion again once the name or the repository changes.
  const releaseEmptyKey = () => {
    if (keyEdited && key === '') setKeyEdited(false);
  };

  const clear = (field: NewFromBacklogField) => {
    setErrors((current) => ({ ...current, [field]: undefined }));
    setFailure(null);
  };

  const submit = async () => {
    if (pending) return;
    const result = CreateProjectFromBacklogInput.safeParse({
      repository: repository.trim(),
      connectionId: effectiveConnection ?? '',
      name: shownName,
      key: shownKey,
      mode,
    });
    if (!result.success) {
      const next: Errors = {};
      for (const issue of result.error.issues) {
        const field = issue.path[0];
        if (typeof field !== 'string' || !FIELDS.includes(field as NewFromBacklogField)) continue;
        const named = field as NewFromBacklogField;
        next[named] ??=
          named === 'repository'
            ? repository.trim()
              ? (repositoryError(repository) ?? issue.message)
              : 'Paste the repository URL.'
            : messageFor(named, issue.code, issue.message);
      }
      setErrors(next);
      const first = (['repository', 'name', 'key'] as const).find((field) => next[field]);
      if (first) inputs[first].current?.focus();
      return;
    }
    setErrors({});
    setFailure(null);
    setPending(true);
    try {
      const error = await onSubmit(result.data);
      if (!error) return;
      if (error.field) {
        setErrors({ [error.field]: error.message });
        if (error.field !== 'connectionId') inputs[error.field].current?.focus();
      } else {
        setFailure(error.message);
      }
    } finally {
      setPending(false);
    }
  };

  useHotkeys({ 'Mod+Enter': () => void submit() }, { allowInOverlays: true });

  const onFormSubmit = (event: FormEvent<HTMLFormElement>) => {
    event.preventDefault();
    void submit();
  };

  // The too-long prefix warning stays while the person types a key of their own (frame 6c).
  const keyHint: { text: string; warn: boolean } =
    prefix && !prefixFits
      ? {
          text: `${prefix} is ${prefix.length} letters; keys have 2 to 6. Tasks read ${shownKey || 'KEY'}-1, and ${prefix}-1 still finds them.`,
          warn: true,
        }
      : keyEdited
        ? {
            text: shownKey ? `Task IDs will look like ${shownKey}-1.` : 'It prefixes task IDs, like PAY-42.',
            warn: false,
          }
        : prefix && shownKey === prefix
          ? { text: `From the prefix, so ${prefix}-1 stays ${prefix}-1.`, warn: false }
          : {
              text: shownKey
                ? `Suggested from the name. Task IDs will look like ${shownKey}-1.`
                : 'It prefixes task IDs, like PAY-42.',
              warn: false,
            };

  const connectionHint =
    connections && parsed && !picked ? (
      <>
        No connection reads {parsed.host}. <AddConnectionLink>Add one</AddConnectionLink>
      </>
    ) : (
      <>
        Picked by host. <AddConnectionLink>Add one</AddConnectionLink>
      </>
    );
  const branch = detected?.defaultBranch ?? null;

  return (
    <form noValidate onSubmit={onFormSubmit} className="flex min-h-0 flex-1 flex-col">
      <DialogHeader title="New project from Backlog.md" />
      <DialogBody className="gap-3.5">
        {!encryptionReady ? (
          <Banner>Set APP_ENCRYPTION_KEY on the server to add connections and read repositories.</Banner>
        ) : null}
        {failure ? <Banner>{failure}</Banner> : null}
        <div className="grid grid-cols-[minmax(0,1fr)_220px] items-start gap-3">
          <TextField
            label="Repository"
            name="repository"
            inputRef={inputs.repository}
            autoFocus
            mono
            autoComplete="off"
            spellCheck="false"
            placeholder="https://gitlab.com/team/repo.git"
            value={repository}
            onChange={(value) => {
              setRepository(value);
              releaseEmptyKey();
              clear('repository');
            }}
            onBlur={() => {
              if (!repository.trim()) return;
              const error = repositoryError(repository);
              if (error) setErrors((current) => ({ ...current, repository: error }));
            }}
            description={
              parsed ? (
                <>
                  Matches <span className="font-mono text-xs text-fg">{parsed.short}</span>
                </>
              ) : (
                'The URL you clone from, HTTPS or SSH.'
              )
            }
            isInvalid={Boolean(errors.repository)}
            errorMessage={errors.repository}
            validationBehavior="aria"
          />
          <Select
            label="Connection"
            items={connections ? connectionItems(connections, parsed?.host ?? null) : []}
            value={effectiveConnection}
            onChange={(value) => {
              if (value == null) return;
              setConnectionEdited(true);
              setConnectionId(String(value));
              clear('connectionId');
            }}
            placeholder={connections ? (connections.length ? 'Pick one' : 'No connections yet') : 'Loading…'}
            isDisabled={!connections?.length}
            description={connectionHint}
            isInvalid={Boolean(errors.connectionId)}
            errorMessage={errors.connectionId}
          />
        </div>
        {detect && parsed && effectiveConnection ? (
          detection.isPending ? (
            <DetectionStrip tone="reading">Reading {parsed.short}…</DetectionStrip>
          ) : detection.isError ? (
            <DetectionStrip tone="failed">
              {detection.error instanceof SettingsError
                ? detection.error.message
                : `Couldn't read ${parsed.short}. You can still create the project.`}
            </DetectionStrip>
          ) : detected ? (
            <DetectionBox detection={detected} host={parsed.host} />
          ) : null
        ) : null}
        <div className="grid grid-cols-[minmax(0,1fr)_220px] items-start gap-3">
          <TextField
            label="Name"
            name="name"
            inputRef={inputs.name}
            autoComplete="off"
            value={shownName}
            onChange={(value) => {
              setNameEdited(true);
              setName(value);
              releaseEmptyKey();
              clear('name');
            }}
            description={
              !nameEdited && detected?.config?.projectName
                ? 'From project_name in config.yml.'
                : !nameEdited && parsed
                  ? 'From the repository name.'
                  : undefined
            }
            isInvalid={Boolean(errors.name)}
            errorMessage={errors.name}
            validationBehavior="aria"
          />
          <TextField
            label="Key"
            name="key"
            inputRef={inputs.key}
            mono
            autoComplete="off"
            spellCheck="false"
            inputClassName="text-sm tracking-[0.04em]"
            value={shownKey}
            onChange={(raw) => {
              const next = normalizeKeyInput(raw);
              setKey(next);
              setKeyEdited(true);
              clear('key');
            }}
            description={<span className={keyHint.warn ? 'text-danger' : undefined}>{keyHint.text}</span>}
            isInvalid={Boolean(errors.key)}
            errorMessage={errors.key}
            validationBehavior="aria"
          />
        </div>
        <RadioGroup
          label="Mode"
          layout="grid"
          value={mode}
          onChange={(value) => setMode(value as BacklogMode)}
        >
          <RadioCard
            value="mirror"
            label="Mirror"
            description={`Keep following ${branch ?? 'the default branch'}`}
          />
          <RadioCard value="import" label="Import once" description="Read now, then detach" />
        </RadioGroup>
      </DialogBody>
      <DialogFooter
        start={
          <span className="max-w-75 text-xs leading-snug text-fg-2">
            Creates the project, then continues with mappings and a preview. Nothing is read in yet.
          </span>
        }
      >
        <Button variant="secondary" onPress={onCancel}>
          Cancel
        </Button>
        <Button
          type="submit"
          kbd={submitHint}
          aria-keyshortcuts="Meta+Enter Control+Enter"
          isPending={pending}
        >
          Create and continue
        </Button>
      </DialogFooter>
    </form>
  );
}

/** Turns a createProjectFromBacklog failure into a field error or a banner message. */
export function newFromBacklogFailure(error: unknown, key: string): NewFromBacklogFailure {
  if (error instanceof SettingsError) {
    const issue = error.issues.find((item) =>
      FIELDS.includes(item.path.split('.')[0] as NewFromBacklogField),
    );
    if (issue) return { field: issue.path.split('.')[0] as NewFromBacklogField, message: issue.message };
    if (error.code === 'CONFLICT') {
      return { field: 'key', message: `${key} is already used by another project. Pick another key.` };
    }
    if (error.code === 'FORBIDDEN') return { message: error.message };
    if (error.code === 'UNAUTHORIZED')
      return { message: 'Your session ended. Sign in again to create the project.' };
    return { message: error.message || 'Check the fields and try again.' };
  }
  return { message: "Couldn't create the project. Check your connection and try again." };
}
