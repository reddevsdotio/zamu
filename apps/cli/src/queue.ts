// The offline queue (M6). When the server doesn't answer (down, restarting, unreachable, or no answer
// within client.ts's 5 seconds), a few writes on an existing task are stored in
// $XDG_STATE_HOME/zamu/queue.json and sent at the start of the next command that reaches the server:
// checking, unchecking, waiving and unwaiving items, a status change, a check-again day, a work note
// and a comment, (M7) archiving, restoring, and linking or unlinking a request, and (M8) putting the
// task in a wave or taking it out (the wave id comes from the plans zamu remembers, waves-memory.ts). They either apply
// whatever else happened to the task meanwhile, or (the status change) carry the status zamu last saw
// as a precondition. Everything else fails as before, so nothing that depends on the
// task's current shape is ever sent blind.
//
// Sub-agents on one machine run zamu at the same time, so every change to the file happens under a
// lock file and lands by writing a temporary file and renaming it over the old one.
//
// To know "the status zamu last saw", every task the server returns (show, list, create, update) is
// remembered per server and workspace in statuses.json next to the queue. A queued status change takes
// the status of an earlier queued move of the same task, else the remembered one; with neither, it is
// not queued.
//
// From 0.10 an entry carries the workspace of the login that queued it, and replay sends it with that
// stored login, whichever login the command itself uses. An entry from 0.9 (no workspace) goes out
// with the stored login that has its key, else with the command's login when that key matches.
import { randomBytes } from 'node:crypto';
import { readFile, rename } from 'node:fs/promises';
import { join } from 'node:path';
import { ORPCError } from '@orpc/client';
import {
  CLI_QUEUE_FILE_NAME,
  CliQueueEntry,
  CliQueueFile,
  type CliQueueProcedure,
  ProjectKey,
  splitTaskKey,
  TaskStatus,
} from '@zamu/contracts';
import { z } from 'zod';
import { type ApiClient, callProcedure, isNetworkFailure, proxyClient } from './client';
import { type CommandContext, emit } from './context';
import { CliError, toCliError, usageError } from './errors';
import { FileLockedError, LOCK_STALE_MS, stateDir, withLock, writeAtomically } from './files';
import { formatTime, statusLabel } from './format';
import type { CliIo } from './io';
import { rememberedWaves, rememberWaves } from './waves-memory';

export { LOCK_STALE_MS, stateDir, withLock };
/** Another zamu process held the queue's lock for longer than a command waits. */
export const QueueLockedError = FileLockedError;

export const QUEUED_MESSAGE = "Queued: the server didn't answer. It will be sent on your next zamu command.";

/** Remembered task statuses per server and workspace (the most recent ones are kept). */
const MAX_REMEMBERED = 1_000;
const STATUSES_FILE_NAME = 'statuses.json';

type Io = Pick<CliIo, 'env' | 'homeDir'>;

// ---------------------------------------------------------------------------
// Files
// ---------------------------------------------------------------------------

export function queuePath(io: Io): string {
  return join(stateDir(io), CLI_QUEUE_FILE_NAME);
}

function statusesPath(io: Io): string {
  return join(stateDir(io), STATUSES_FILE_NAME);
}

/**
 * The entries in the queue file, oldest first. A missing file is an empty queue. A file zamu can't
 * read is an error; with `repair` (under the lock) it is moved aside instead, with a warning, so one
 * broken file doesn't stop every later command. A file from a newer zamu is never touched.
 */
async function readQueue(io: CliIo, { repair = false } = {}): Promise<CliQueueEntry[]> {
  const path = queuePath(io);
  let text: string;
  try {
    text = await readFile(path, 'utf8');
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') return [];
    throw usageError(`Cannot read the offline queue ${path}: ${(error as Error).message}`);
  }
  let json: unknown;
  try {
    json = JSON.parse(text);
  } catch {
    json = undefined;
  }
  const parsed = CliQueueFile.safeParse(json);
  if (parsed.success) return parsed.data.entries;
  const version = (json as { version?: unknown } | undefined)?.version;
  if (typeof version === 'number' && version > 1) {
    throw usageError(`The offline queue ${path} was written by a newer zamu. Update zamu to use it.`);
  }
  if (!repair) throw usageError(`The offline queue ${path} is not readable.`);
  const aside = `${path}.unreadable-${Date.now()}`;
  await rename(path, aside);
  io.stderr(`zamu: the offline queue was not readable; moved it to ${aside} and started a new one.\n`);
  return [];
}

function writeQueue(io: Io, entries: CliQueueEntry[]): Promise<void> {
  const file: CliQueueFile = { version: 1, entries };
  return writeAtomically(queuePath(io), file);
}

/** Every queued write, oldest first, for every server. */
export function listQueue(io: CliIo): Promise<CliQueueEntry[]> {
  return readQueue(io);
}

/**
 * How many writes wait for the server at `url`, in the workspace when it is known. Entries from 0.9
 * name no workspace and count everywhere on their server.
 */
export async function countQueued(io: CliIo, url: string, workspaceId?: string | null): Promise<number> {
  return (await readQueue(io)).filter(
    (entry) => entry.url === url && (!workspaceId || !entry.workspaceId || entry.workspaceId === workspaceId),
  ).length;
}

/** Removes one entry by id; null when there is none with that id. */
export function dropQueued(io: CliIo, id: string): Promise<CliQueueEntry | null> {
  return withLock(queuePath(io), async () => {
    const entries = await readQueue(io, { repair: true });
    const found = entries.find((entry) => entry.id === id.trim());
    if (!found) return null;
    await writeQueue(
      io,
      entries.filter((entry) => entry !== found),
    );
    return found;
  });
}

// ---------------------------------------------------------------------------
// Remembered statuses
// ---------------------------------------------------------------------------

const RememberedStatuses = z.object({
  version: z.literal(1),
  servers: z.record(z.string(), z.record(z.string(), z.object({ status: TaskStatus, at: z.string() }))),
});
type RememberedStatuses = z.output<typeof RememberedStatuses>;

/** What a server response says about a task's status. */
export interface SeenTask {
  key: string;
  status: TaskStatus;
  project?: { key: string };
  /** Backlog.md id: from a list item ... */
  backlogId?: string | null;
  /** ... or from a full task. */
  backlog?: { id: string } | null;
}

/** The names a task is remembered under: its app key, and project:id for a Backlog.md id. */
function seenNames(task: SeenTask): string[] {
  const names = [task.key.toUpperCase()];
  const backlogId = task.backlogId ?? task.backlog?.id;
  if (backlogId && task.project?.key) names.push(`${task.project.key}:${backlogId}`.toUpperCase());
  return names;
}

/** The names to look a task reference up under. */
function refNames(key: string, project: string | null | undefined): string[] {
  const upper = key.toUpperCase();
  return project ? [upper, `${project}:${key}`.toUpperCase()] : [upper];
}

async function readStatuses(io: Io): Promise<RememberedStatuses> {
  const text = await readFile(statusesPath(io), 'utf8').catch(() => null);
  if (text === null) return { version: 1, servers: {} };
  try {
    const parsed = RememberedStatuses.safeParse(JSON.parse(text));
    if (parsed.success) return parsed.data;
  } catch {
    // Unreadable: start again. It only ever makes a status change unqueueable.
  }
  return { version: 1, servers: {} };
}

/**
 * Where statuses are remembered: per server and workspace, so PAY-1 of one workspace never lends its
 * status to PAY-1 of another. Per server alone when the workspace is not known (ZAMU_KEY).
 */
export function statusBucket(url: string, workspaceId: string | null | undefined): string {
  return workspaceId ? `${url} ${workspaceId}` : url;
}

/**
 * Remembers the status of tasks the server returned. Best effort: a failure here never fails the
 * command, it only means a later status change can't be queued.
 */
export async function rememberStatuses(io: CliIo, bucket: string, tasks: readonly SeenTask[]): Promise<void> {
  if (tasks.length === 0) return;
  try {
    const path = statusesPath(io);
    await withLock(
      path,
      async () => {
        const file = await readStatuses(io);
        const server = { ...(file.servers[bucket] ?? {}) };
        const at = new Date(io.now?.() ?? Date.now()).toISOString();
        let changed = false;
        for (const task of tasks) {
          for (const name of seenNames(task)) {
            if (server[name]?.status === task.status) continue;
            server[name] = { status: task.status, at };
            changed = true;
          }
        }
        if (!changed) return;
        const kept = Object.entries(server)
          .sort(([, a], [, b]) => b.at.localeCompare(a.at))
          .slice(0, MAX_REMEMBERED);
        await writeAtomically(path, {
          ...file,
          servers: { ...file.servers, [bucket]: Object.fromEntries(kept) },
        });
      },
      { waitMs: 2_000 },
    );
  } catch {
    // See above.
  }
}

async function rememberedStatus(
  io: CliIo,
  bucket: string,
  key: string,
  project: string | null,
): Promise<TaskStatus | null> {
  const server = (await readStatuses(io)).servers[bucket] ?? {};
  for (const name of refNames(key, project)) {
    const found = server[name];
    if (found) return found.status;
  }
  return null;
}

/** The tasks in a procedure's result, for rememberStatuses. */
function seenTasks(procedure: string, result: unknown): SeenTask[] {
  if (!result || typeof result !== 'object') return [];
  if (
    procedure === 'tasks.list' ||
    procedure === 'tasks.bulk' ||
    procedure === 'tasks.archive' ||
    procedure === 'tasks.restore'
  ) {
    const items = (result as { items?: unknown }).items;
    return Array.isArray(items) ? items.filter(isSeenTask) : [];
  }
  if (procedure === 'tasks.get' || procedure === 'tasks.update' || procedure === 'tasks.create') {
    return isSeenTask(result) ? [result] : [];
  }
  return [];
}

function isSeenTask(value: unknown): value is SeenTask {
  const task = value as Partial<SeenTask> | null;
  return typeof task?.key === 'string' && TaskStatus.safeParse(task.status).success;
}

// ---------------------------------------------------------------------------
// What can be queued
// ---------------------------------------------------------------------------

/** The update fields a queued write may carry, besides the task reference. */
const ITEM_OPERATIONS = {
  checkCriteria: ['check', 'criterion', 'criteria'],
  uncheckCriteria: ['uncheck', 'criterion', 'criteria'],
  waiveCriteria: ['waive', 'criterion', 'criteria'],
  unwaiveCriteria: ['unwaive', 'criterion', 'criteria'],
  checkDoneItems: ['check', 'done item', 'done items'],
  uncheckDoneItems: ['uncheck', 'done item', 'done items'],
  waiveDoneItems: ['waive', 'done item', 'done items'],
  unwaiveDoneItems: ['unwaive', 'done item', 'done items'],
} as const satisfies Record<string, readonly [string, string, string]>;

const REFERENCE_FIELDS = new Set(['key', 'project']);

/**
 * Update fields that queue besides the item operations and the status (M7: the check-again day; M8:
 * the wave, which the server checks against the lock rule when the write is sent).
 */
const QUEUEABLE_FIELDS = new Set(['status', 'checkAgain', 'wave']);

/** The procedures that are queueable whatever their input (M7): they work on tasks that exist. */
const TASK_WRITES = new Set<string>([
  'tasks.archive',
  'tasks.restore',
  'pullRequests.link',
  'pullRequests.unlink',
]);

/** The zamu flag behind an update field that can't be queued, for the error. */
const FIELD_FLAGS: Record<string, string> = {
  title: '--title',
  description: '--description',
  priority: '--priority',
  assignee: '--assignee/--unassign',
  milestone: '--milestone',
  cycle: '--cycle',
  labels: '--label',
  addLabels: '--label',
  removeLabels: '--remove-label',
  dueDate: '--due',
  parent: '--parent',
  addBlockers: '--blocked-by',
  removeBlockers: '--unblock',
  addCriteria: '--ac',
  removeCriteria: '--remove-ac',
  addDoneItems: '--dod',
  removeDoneItems: '--remove-dod',
  plan: '--plan',
  finalSummary: '--final-summary',
};

export type Queueability =
  | { queueable: true; summary: string; status: TaskStatus | null }
  | { queueable: false; flags: string[] };

function itemNumbers(value: unknown): number[] {
  if (!Array.isArray(value)) return [];
  return value
    .map((item) => (typeof item === 'number' ? item : (item as { number?: unknown })?.number))
    .filter((number): number is number => typeof number === 'number');
}

function excerpt(text: string, max = 50): string {
  const line = text.replace(/\s+/g, ' ').trim();
  return [...line].length <= max ? line : `${[...line].slice(0, max - 1).join('')}…`;
}

/** The keys of an archive or restore input, as sent. */
function inputKeys(input: Record<string, unknown>): string[] {
  return Array.isArray(input.keys) ? input.keys.filter((key): key is string => typeof key === 'string') : [];
}

/**
 * One line for zamu queue: "check criteria 1, 2, move to In review", "note "Migration written"",
 * "put in W3 · Payout screens". `waveLabel` names the wave of a --wave change, when zamu knows it.
 */
export function summarize(
  procedure: CliQueueProcedure,
  input: Record<string, unknown>,
  waveLabel?: string,
): string {
  if (procedure === 'comments.create') {
    const body = typeof input.body === 'string' ? input.body : '';
    return `${input.kind === 'note' ? 'note' : 'comment'} "${excerpt(body)}"`;
  }
  if (procedure === 'tasks.archive' || procedure === 'tasks.restore') {
    return `${procedure === 'tasks.archive' ? 'archive' : 'restore'} ${inputKeys(input).join(', ')}`;
  }
  if (procedure === 'pullRequests.link') return `link request ${String(input.url ?? '')}`;
  if (procedure === 'pullRequests.unlink') return `unlink request ${String(input.number ?? '')}`;
  const parts: string[] = [];
  for (const [field, [verb, one, many]] of Object.entries(ITEM_OPERATIONS)) {
    const numbers = itemNumbers(input[field]);
    if (numbers.length) parts.push(`${verb} ${numbers.length === 1 ? one : many} ${numbers.join(', ')}`);
  }
  const status = TaskStatus.safeParse(input.status);
  if (status.success) parts.push(`move to ${statusLabel(status.data)}`);
  if (input.checkAgain === null) parts.push('clear the check-again day');
  else if (input.checkAgain && typeof input.checkAgain === 'object') {
    const { on } = input.checkAgain as { on?: unknown };
    parts.push(`check again ${String(on ?? '')}`);
  }
  if (input.wave === null) parts.push('take out of its wave');
  else if (typeof input.wave === 'string') parts.push(`put in ${waveLabel ?? 'a wave'}`);
  return parts.join(', ');
}

/**
 * Whether a write can wait for the server: a note or comment; an update of an existing task that
 * only checks, unchecks, waives or unwaives items, changes the status or sets the check-again day;
 * and (M7) archiving, restoring, linking or unlinking a request, but not a dry run. M8: an update
 * may also put the task in a wave or take it out of one. Otherwise the flags that keep it from being
 * queued.
 */
export function queueability(procedure: string, input: unknown): Queueability | null {
  if (procedure !== 'tasks.update' && procedure !== 'comments.create' && !TASK_WRITES.has(procedure)) {
    return null;
  }
  if (!input || typeof input !== 'object') return { queueable: false, flags: [] };
  const fields = input as Record<string, unknown>;
  if (procedure === 'comments.create' || TASK_WRITES.has(procedure)) {
    // A dry run only answers with a preview: there is nothing to send later.
    if (procedure === 'pullRequests.link' && fields.dryRun === true)
      return { queueable: false, flags: ['--dry-run'] };
    return { queueable: true, summary: summarize(procedure as CliQueueProcedure, fields), status: null };
  }
  const flags: string[] = [];
  for (const [name, value] of Object.entries(fields)) {
    if (
      value === undefined ||
      REFERENCE_FIELDS.has(name) ||
      name in ITEM_OPERATIONS ||
      QUEUEABLE_FIELDS.has(name)
    )
      continue;
    const flag = FIELD_FLAGS[name] ?? name;
    if (!flags.includes(flag)) flags.push(flag);
  }
  if (flags.length) return { queueable: false, flags };
  const status = fields.status === undefined ? null : TaskStatus.safeParse(fields.status);
  if (status && !status.success) return { queueable: false, flags: ['--status'] };
  return { queueable: true, summary: summarize('tasks.update', fields), status: status?.data ?? null };
}

// ---------------------------------------------------------------------------
// Queueing
// ---------------------------------------------------------------------------

/**
 * Thrown by a write the queue accepted. main() prints the queued message (zamu.v1.queued with
 * --json) and exits with CLI_EXIT_QUEUED.
 */
export class QueuedWrite extends Error {
  readonly entries: CliQueueEntry[];
  readonly #append: (procedure: CliQueueProcedure, input: Record<string, unknown>) => Promise<CliQueueEntry>;

  constructor(
    entry: CliQueueEntry,
    append: (procedure: CliQueueProcedure, input: Record<string, unknown>) => Promise<CliQueueEntry>,
  ) {
    super(QUEUED_MESSAGE);
    this.name = 'QueuedWrite';
    this.entries = [entry];
    this.#append = append;
  }

  /** Queues a follow-up write behind this one (the note of tasks update --append-notes). */
  async queueAlso(procedure: CliQueueProcedure, input: Record<string, unknown>): Promise<void> {
    this.entries.push(await this.#append(procedure, input));
  }
}

/**
 * For a command that sends a second write after a first (tasks update --append-notes): when the first
 * was queued, the second is queued behind it. Always rethrows `error`.
 */
export async function queueBehind(
  error: unknown,
  procedure: CliQueueProcedure,
  input: Record<string, unknown>,
): Promise<never> {
  if (error instanceof QueuedWrite) await error.queueAlso(procedure, input);
  throw error;
}

/** Prints what a QueuedWrite queued. */
export function reportQueued(context: CommandContext, queued: QueuedWrite): void {
  const first = queued.entries[0] as CliQueueEntry;
  emit(context, 'queued', { entry: first }, () => {
    const lines = queued.entries.map((entry) => `  ${entry.id}  ${entry.taskKey}  ${entry.summary}`);
    return `${QUEUED_MESSAGE}\n${lines.join('\n')}\n`;
  });
}

interface QueueSession {
  io: CliIo;
  url: string;
  /** Fingerprint of the key this invocation uses. */
  keyId: string | null;
  /** The workspace of the login this invocation uses; null when not known (ZAMU_KEY). */
  workspaceId: string | null;
  /** Finds the stored login a write was queued with (CommandContext.loginFor). */
  loginFor: CommandContext['loginFor'];
  /** Set once a request of this invocation got no answer: the rest fail (or queue) without waiting. */
  offline: unknown;
  replay?: Promise<void>;
}

function newId(taken: readonly CliQueueEntry[]): string {
  for (;;) {
    const id = randomBytes(4).toString('hex');
    if (!taken.some((entry) => entry.id === id)) return id;
  }
}

/** The project an input names: its project field, else the prefix of an app key. */
function inputProject(input: Record<string, unknown>): string | null {
  const named = typeof input.project === 'string' ? input.project : undefined;
  const key = typeof input.key === 'string' ? input.key : '';
  const candidate = (named ?? splitTaskKey(key.toUpperCase())?.projectKey ?? '').toUpperCase();
  const parsed = ProjectKey.safeParse(candidate);
  return parsed.success ? parsed.data : null;
}

/** "--status (zamu hasn't seen ...)" when a status change has no known status to check against. */
class NoKnownStatus extends Error {}

/**
 * Appends one write to the queue. A status change takes the target of the last queued move of the
 * same task, else the remembered status; with neither it throws NoKnownStatus and queues nothing.
 */
async function append(
  session: QueueSession,
  procedure: CliQueueProcedure,
  input: Record<string, unknown>,
  status: TaskStatus | null,
): Promise<CliQueueEntry> {
  const { io, url, workspaceId } = session;
  // Archive and restore name several tasks: the first stands for them (the summary lists them all).
  const taskKey = String(input.key ?? inputKeys(input)[0] ?? '').toUpperCase();
  const project = inputProject({ ...input, key: taskKey });
  return withLock(queuePath(io), async () => {
    const entries = await readQueue(io, { repair: true });
    let lastSeenStatus: TaskStatus | null = null;
    if (status !== null) {
      const earlier = entries
        .filter(
          (entry) =>
            entry.url === url &&
            (entry.workspaceId ?? null) === workspaceId &&
            entry.taskKey === taskKey &&
            entry.procedure === 'tasks.update',
        )
        .map((entry) => TaskStatus.safeParse(entry.input.status))
        .filter((parsed) => parsed.success)
        .at(-1);
      lastSeenStatus =
        earlier?.data ?? (await rememberedStatus(io, statusBucket(url, workspaceId), taskKey, project));
      if (lastSeenStatus === null) throw new NoKnownStatus();
    }
    const waveLabel =
      typeof input.wave === 'string'
        ? await rememberedWaveLabel(io, statusBucket(url, workspaceId), input.wave)
        : undefined;
    const entry = CliQueueEntry.parse({
      id: newId(entries),
      queuedAt: new Date(io.now?.() ?? Date.now()).toISOString(),
      url,
      ...(session.keyId ? { keyId: session.keyId } : {}),
      ...(workspaceId ? { workspaceId } : {}),
      project,
      taskKey,
      procedure,
      input,
      lastSeenStatus,
      summary: summarize(procedure, input, waveLabel),
    });
    await writeQueue(io, [...entries, entry]);
    return entry;
  });
}

/** "W3 · Payout screens" for a remembered wave id. */
async function rememberedWaveLabel(io: CliIo, bucket: string, id: string): Promise<string | undefined> {
  const { milestones } = await rememberedWaves(io, bucket);
  for (const milestone of Object.values(milestones)) {
    const wave = milestone.waves.find((candidate) => candidate.id === id);
    if (wave) return `W${wave.number} · ${wave.name}`;
  }
  return undefined;
}

/**
 * The CliError for a request that got no answer, saying why the write was not queued: under the
 * message in human output, in the detail with --json.
 */
function unreachable(session: QueueSession, error: unknown, why: string[] = []): CliError {
  const failure = toCliError(error, session.url);
  if (why.length === 0) return failure;
  const detail = [failure.problem.detail ?? failure.message, ...why].join(' ');
  return new CliError(
    { ...failure.problem, detail },
    failure.exitCode,
    [...failure.hints, ...why],
    failure.message,
  );
}

function notQueuedHint(flags: string[]): string {
  const named = flags.length ? `${flags.join(', ')} can't wait for the server` : "this write can't wait";
  return (
    `Nothing was queued: ${named}. Run the command again once the server answers. Checks, waivers, ` +
    'status changes, check-again days, notes and comments on their own are queued, and so are ' +
    'archiving, restoring, linking or unlinking a request, and putting a task in a wave.'
  );
}

function unknownStatusHint(taskKey: string): string {
  return (
    `Nothing was queued: zamu hasn't seen ${taskKey}'s status on this machine, so a queued --status ` +
    `couldn't be checked when it is sent. Run zamu tasks show ${taskKey} once the server answers.`
  );
}

async function queueOrFail(
  session: QueueSession,
  procedure: CliQueueProcedure,
  input: Record<string, unknown>,
  plan: Extract<Queueability, { queueable: true }>,
  error: unknown,
): Promise<never> {
  const add = (next: CliQueueProcedure, nextInput: Record<string, unknown>) =>
    append(session, next, nextInput, null);
  let entry: CliQueueEntry;
  try {
    entry = await append(session, procedure, input, plan.status);
  } catch (failure) {
    if (failure instanceof NoKnownStatus) {
      throw unreachable(session, error, [unknownStatusHint(String(input.key ?? '').toUpperCase())]);
    }
    if (failure instanceof QueueLockedError) {
      throw unreachable(session, error, [`Nothing was queued: ${failure.message}`]);
    }
    throw failure;
  }
  throw new QueuedWrite(entry, add);
}

// ---------------------------------------------------------------------------
// Replay
// ---------------------------------------------------------------------------

type SendOutcome = 'done' | 'stop';

function problemText(error: ORPCError<string, unknown>): string {
  const detail = (error.message || error.code).trim().replace(/\.$/, '');
  return `${detail} (${error.code.toLowerCase()})`;
}

/** Sends one queued write and reports it on stderr. 'stop' keeps it and ends the replay. */
async function send(client: ApiClient, session: QueueSession, entry: CliQueueEntry): Promise<SendOutcome> {
  const { io } = session;
  const bucket = statusBucket(entry.url, entry.workspaceId ?? session.workspaceId);
  const label = `${entry.taskKey} ${entry.summary} (queued ${formatTime(entry.queuedAt)})`;
  const guarded =
    entry.procedure === 'tasks.update' && entry.input.status !== undefined && entry.lastSeenStatus !== null;
  const input = guarded ? { ...entry.input, ifStatus: entry.lastSeenStatus } : entry.input;
  try {
    const result = await callProcedure(client, entry.procedure.split('.'), [input]);
    await rememberStatuses(io, bucket, seenTasks(entry.procedure, result));
    io.stderr(`Sent: ${label}\n`);
    return 'done';
  } catch (error) {
    if (isNetworkFailure(error)) {
      session.offline = error;
      return 'stop';
    }
    if (!(error instanceof ORPCError)) {
      io.stderr(`zamu: stopped sending queued writes: ${toCliError(error, session.url).message}\n`);
      return 'stop';
    }
    const status = typeof error.status === 'number' ? error.status : 500;
    if (error.code === 'TASK_CHANGED' && guarded) {
      const current = (error.data as { task?: unknown } | undefined)?.task;
      if (isSeenTask(current)) await rememberStatuses(io, bucket, [current]);
      const where = isSeenTask(current)
        ? `already moved to ${statusLabel(current.status)}`
        : 'moved meanwhile';
      io.stderr(
        `Skipped: ${entry.taskKey} was ${where} (queued ${formatTime(entry.queuedAt)}: ${entry.summary})\n`,
      );
      // The rest of the write (checks, waivers) doesn't depend on the status: it still goes.
      const { status: _status, ...rest } = entry.input;
      const plan = queueability('tasks.update', rest);
      if (plan?.queueable && plan.summary) {
        return send(client, session, { ...entry, input: rest, lastSeenStatus: null, summary: plan.summary });
      }
      return 'done';
    }
    // The key, the server or a rate limit: not this write's fault, so it waits for the next command.
    if (status === 401 || status === 408 || status === 429 || status >= 500) {
      io.stderr(`zamu: stopped sending queued writes: ${problemText(error)}\n`);
      return 'stop';
    }
    io.stderr(`Dropped: ${label}: ${problemText(error)}\n`);
    return 'done';
  }
}

/**
 * The client a queued write goes out with: the stored login of its workspace and key, else this
 * command's own when the key matches. Null when neither fits: the write waits for that key.
 */
async function replayClient(
  client: ApiClient,
  session: QueueSession,
  entry: CliQueueEntry,
  found: Map<string, ApiClient | null>,
): Promise<ApiClient | null> {
  const ownKey = !entry.keyId || entry.keyId === session.keyId;
  const ownWorkspace =
    !entry.workspaceId || !session.workspaceId || entry.workspaceId === session.workspaceId;
  if (ownKey && ownWorkspace) return client;
  const id = `${entry.workspaceId ?? ''} ${entry.keyId ?? ''}`;
  if (!found.has(id)) {
    const login = await session
      .loginFor({ url: entry.url, workspaceId: entry.workspaceId, keyId: entry.keyId })
      .catch(() => null);
    found.set(id, login?.client ?? null);
  }
  return found.get(id) ?? null;
}

/**
 * Sends this server's queued writes, oldest first, holding the lock so two processes never send one
 * twice, each with the login that queued it. A network failure (or a 401, 408, 429 or 5xx) stops it
 * and keeps the rest; any other answer removes the entry. Reports go to stderr, so --json output
 * stays one result.
 */
async function replay(client: ApiClient, session: QueueSession): Promise<void> {
  const { io } = session;
  // A request already got no answer (while picking the login): don't wait for another.
  if (session.offline) return;
  try {
    await withLock(queuePath(io), async (lock) => {
      let entries = await readQueue(io, { repair: true });
      const here = entries.filter((entry) => entry.url === session.url);
      // A write goes out under the key that queued it, so its author stays right. Writes queued by
      // a key no stored login holds wait for a command that uses that key.
      const found = new Map<string, ApiClient | null>();
      const pending: { entry: CliQueueEntry; client: ApiClient }[] = [];
      for (const entry of here) {
        const sender = await replayClient(client, session, entry, found);
        if (sender) pending.push({ entry, client: sender });
      }
      const others = here.length - pending.length;
      if (others > 0) {
        io.stderr(
          `zamu: ${others === 1 ? '1 queued write was' : `${others} queued writes were`} made with another key and ${others === 1 ? 'waits' : 'wait'} for it (zamu queue lists them).\n`,
        );
      }
      for (const [index, { entry, client: sender }] of pending.entries()) {
        if ((await send(sender, session, entry)) === 'stop') {
          const left = pending.length - index;
          if (session.offline) {
            io.stderr(
              `zamu: the server didn't answer; ${left === 1 ? '1 queued write waits' : `${left} queued writes wait`} (zamu queue lists them).\n`,
            );
          }
          return;
        }
        entries = entries.filter((candidate) => candidate.id !== entry.id);
        await writeQueue(io, entries);
        await lock.touch();
      }
    });
  } catch (error) {
    // A queue that can't be read or locked must not block the command itself.
    io.stderr(`zamu: queued writes not sent: ${error instanceof Error ? error.message : String(error)}\n`);
  }
}

// ---------------------------------------------------------------------------
// The client every command gets
// ---------------------------------------------------------------------------

/**
 * Wraps an API client for one invocation: the first call sends the queued writes, every task the
 * server returns is remembered, and a queueable write that gets no answer is queued (QueuedWrite).
 * Once a request got no answer, later ones in the same invocation fail at once (or queue) instead of
 * waiting another 5 seconds, which also keeps queued writes in order.
 */
function queueingClient(client: ApiClient, session: QueueSession): ApiClient {
  const call = async (path: string[], args: unknown[]): Promise<unknown> => {
    const procedure = path.join('.');
    session.replay ??= replay(client, session);
    await session.replay;
    const input = (args[0] ?? {}) as Record<string, unknown>;
    const plan = queueability(procedure, input);
    const name = procedure as CliQueueProcedure;
    if (session.offline) {
      const failure = session.offline;
      if (plan?.queueable) return queueOrFail(session, name, input, plan, failure);
      throw unreachable(session, failure, notQueued(plan));
    }
    const bucket = statusBucket(session.url, session.workspaceId);
    try {
      const result = await callProcedure(client, path, args);
      await rememberStatuses(session.io, bucket, seenTasks(procedure, result));
      await rememberWaves(session.io, bucket, procedure, result);
      return result;
    } catch (error) {
      if (isNetworkFailure(error)) {
        session.offline = error;
        if (plan?.queueable) return queueOrFail(session, name, input, plan, error);
        throw unreachable(session, error, notQueued(plan));
      }
      if (error instanceof ORPCError && error.code === 'TASK_CHANGED') {
        const current = (error.data as { task?: unknown } | undefined)?.task;
        if (isSeenTask(current)) await rememberStatuses(session.io, bucket, [current]);
      }
      throw error;
    }
  };
  return proxyClient(call);
}

function notQueued(plan: Queueability | null): string[] {
  return plan && !plan.queueable ? [notQueuedHint(plan.flags)] : [];
}

/**
 * Gives a command context the offline queue: every client it hands out replays queued writes first
 * and queues what it may. Commands that never reach the server (zamu queue) never touch it.
 */
export function withOfflineQueue(context: CommandContext): CommandContext {
  const base = context.client;
  let session: QueueSession | undefined;
  context.client = async () => {
    const client = await base();
    const url = context.url as string;
    const keyId = context.keyId ?? null;
    const workspaceId = context.workspaceId ?? null;
    if (!session || session.url !== url || session.keyId !== keyId || session.workspaceId !== workspaceId) {
      session = {
        io: context.io,
        url,
        keyId,
        workspaceId,
        loginFor: context.loginFor,
        offline: context.offline ?? null,
      };
    }
    return queueingClient(client, session);
  };
  return context;
}
