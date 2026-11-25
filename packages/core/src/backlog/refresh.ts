// The refresh engine: one run reads a source's folder at the default branch head and applies the
// difference in one transaction. Runs take a Postgres advisory lock on the source, so a second
// worker skips. Also the enqueue helper every trigger uses, and the hourly poll.
// Steps and states: M3 plan, section 5 "Refresh".

import type { WorkRecordItem } from '@zamu/backlog-md';
import type { BacklogState, BacklogTrigger } from '@zamu/contracts';
import { BacklogMappings, BacklogProblem } from '@zamu/contracts';
import { type Db, type DbHandle, type DbOrTx, schema, type Tx } from '@zamu/db';
import { GitNotFound, type GitProvider, GitRateLimited } from '@zamu/git-providers';
import { and, asc, eq, ne, sql } from 'drizzle-orm';
import { z } from 'zod';
import type { DbContext, GitContext } from '../context';
import { clockNow } from '../cycles';
import { isCoreError, NotFound } from '../errors';
import {
  describeProviderError,
  type GitConnectionRow,
  markConnectionStatus,
  pausesConnection,
  providerForConnection,
} from '../git-connections';
import { BACKLOG_POLL_CRON_MINUTE, BACKLOG_REFRESH, type EnqueueOptions, type JobQueue } from '../jobs';
import { REPOSITORY_CLEARED_ERROR } from '../projects';
import { EncryptionKeyMissing, SecretUnreadable } from '../secrets';
import { type ApplyResult, applyPlan, type BacklogSourceRow } from './apply';
import {
  type ExistingFile,
  type ExistingLabel,
  type ExistingMilestone,
  type ExistingState,
  type ExistingTask,
  planRefresh,
} from './plan';
import { locateFolder, type PreviousRead, readFolder, repositoryRef } from './reader';

const {
  backlogFile,
  backlogSource,
  label,
  member,
  milestone,
  project,
  task,
  taskDependency,
  taskItem,
  taskLabel,
} = schema;

/** Triggers a person or an agent asked for: queued without the debounce slot. */
const ASKED_TRIGGERS: ReadonlySet<BacklogTrigger> = new Set(['setup', 'manual', 'cli']);

/** Webhook bursts and repeated triggers within this window collapse into one run. */
export const REFRESH_THROTTLE_SECONDS = 60;

/** What the engine needs: the database, git settings and (to enqueue follow-ups) the job queue. */
export interface RefreshContext extends DbContext, GitContext {
  jobs?: JobQueue;
}

// ---------------------------------------------------------------------------
// Enqueueing
// ---------------------------------------------------------------------------

/**
 * Enqueues a backlog.refresh for one source inside `tx` (the job exists only if `tx` commits).
 * singletonKey = source id on a stately queue: at most one queued run per source; with the
 * 60-second debounce slot a burst of triggers collapses into one run, and a trigger during a
 * running refresh queues exactly one more. Returns the job id, or null when a queued run already
 * covers this trigger. An asked refresh (Refresh now, zamu backlog refresh) replaces a queued run that
 * waits for the next slot and returns the new run's id, so it starts as soon as nothing else runs.
 */
export async function enqueueBacklogRefresh(
  ctx: { jobs?: JobQueue },
  tx: Tx,
  sourceId: string,
  trigger: BacklogTrigger,
  options: { startAfterSeconds?: number } = {},
): Promise<string | null> {
  if (!ctx.jobs) throw new Error('Backlog.md refreshes need the job queue in the core context');
  // A delayed retry (rate limits) skips the debounce slot, which would replace its start time.
  // Someone who asked for a refresh (setup, Refresh now, zamu backlog refresh) skips it too: the
  // stately queue still keeps at most one queued run per source, but they never wait for the
  // next minute: a queued webhook or poll run waiting for its slot gives way to theirs (PM-10).
  // Setup creates the source, so nothing can be queued for it yet. Webhooks and the poll keep the
  // debounce, so bursts of pushes collapse.
  const send: EnqueueOptions = options.startAfterSeconds
    ? { singletonKey: sourceId, startAfter: options.startAfterSeconds }
    : ASKED_TRIGGERS.has(trigger)
      ? trigger === 'setup'
        ? { singletonKey: sourceId }
        : { singletonKey: sourceId, replaceDebounced: true }
      : { singletonKey: sourceId, singletonSeconds: REFRESH_THROTTLE_SECONDS, singletonNextSlot: true };
  return ctx.jobs.enqueue(tx, BACKLOG_REFRESH, { sourceId, trigger }, send);
}

/** enqueueBacklogRefresh for several sources (e.g. the ones markConnectionStatus resumed). */
export async function enqueueBacklogRefreshes(
  ctx: { jobs?: JobQueue },
  tx: Tx,
  sourceIds: string[],
  trigger: BacklogTrigger,
): Promise<void> {
  for (const sourceId of sourceIds) await enqueueBacklogRefresh(ctx, tx, sourceId, trigger);
}

/** The next hourly check after `now` (backlog.poll runs at :15 UTC). */
export function nextPollAt(now: Date): Date {
  const next = new Date(now);
  next.setUTCMinutes(BACKLOG_POLL_CRON_MINUTE, 0, 0);
  if (next.getTime() <= now.getTime()) next.setUTCHours(next.getUTCHours() + 1);
  return next;
}

/**
 * The hourly job: enqueues a refresh (trigger poll) for every mirror that is not detached. Paused
 * mirrors are included, so a connection that works again resumes them; each run stops after two
 * provider calls when the head has not moved.
 */
export async function pollBacklogSources(ctx: RefreshContext): Promise<{ enqueued: number }> {
  return ctx.db.transaction(async (tx) => {
    const rows = await tx
      .select({ id: backlogSource.id })
      .from(backlogSource)
      .where(and(eq(backlogSource.mode, 'mirror'), ne(backlogSource.state, 'detached')));
    let enqueued = 0;
    for (const row of rows) if (await enqueueBacklogRefresh(ctx, tx, row.id, 'poll')) enqueued += 1;
    return { enqueued };
  });
}

// ---------------------------------------------------------------------------
// Lock
// ---------------------------------------------------------------------------

const LOCKED = Symbol('locked');

/**
 * Runs `work` while holding a session advisory lock on the source, on a dedicated connection of
 * the pool; returns LOCKED without running it when another run holds the lock.
 */
async function withSourceLock<T>(
  db: Db,
  sourceId: string,
  work: () => Promise<T>,
): Promise<T | typeof LOCKED> {
  const pool = (db as unknown as { $client?: DbHandle['pool'] }).$client;
  if (!pool || typeof pool.connect !== 'function') throw new Error('The database handle has no pg pool');
  const client = await pool.connect();
  const key = `backlog_source:${sourceId}`;
  try {
    const result = await client.query<{ ok: boolean }>(
      'select pg_try_advisory_lock(hashtextextended($1, 0)) as ok',
      [key],
    );
    if (!result.rows[0]?.ok) return LOCKED;
    try {
      return await work();
    } finally {
      await client.query('select pg_advisory_unlock(hashtextextended($1, 0))', [key]);
    }
  } finally {
    client.release();
  }
}

/** Holds the advisory lock of a source until `release` is called. For tests of the skip rule. */
export async function holdSourceLock(db: Db, sourceId: string): Promise<{ release: () => Promise<void> }> {
  let release!: () => void;
  const held = new Promise<void>((resolve) => {
    release = resolve;
  });
  let acquired!: () => void;
  const ready = new Promise<void>((resolve) => {
    acquired = resolve;
  });
  const done = withSourceLock(db, sourceId, async () => {
    acquired();
    await held;
  });
  await Promise.race([ready, done]);
  return {
    release: async () => {
      release();
      await done;
    },
  };
}

// ---------------------------------------------------------------------------
// Loading state
// ---------------------------------------------------------------------------

export async function loadSource(db: DbOrTx, sourceId: string, options: { forUpdate?: boolean } = {}) {
  const query = db.select().from(backlogSource).where(eq(backlogSource.id, sourceId)).limit(1);
  const [row] = options.forUpdate ? await query.for('update') : await query;
  return row ?? null;
}

/** The stored mappings, read leniently (a row that no longer parses counts as empty). */
export function storedMappings(source: Pick<BacklogSourceRow, 'mappings'>): BacklogMappings {
  const parsed = BacklogMappings.safeParse(source.mappings);
  return parsed.success ? parsed.data : { status: [], priority: [], assignee: [] };
}

/** The stored problems of the last read. */
export function storedProblems(source: Pick<BacklogSourceRow, 'warnings'>): BacklogProblem[] {
  const parsed = z.array(BacklogProblem).safeParse(source.warnings);
  return parsed.success ? parsed.data : [];
}

/** Rows of a project and source as the planner and reader need them (M6: with the work record). */
export async function loadExisting(
  db: DbOrTx,
  source: Pick<BacklogSourceRow, 'id' | 'lastReadCommit' | 'warnings'>,
  projectRow: { id: string; nextTaskNumber: number },
): Promise<ExistingState> {
  const [rows, milestones, files, labels, taskLabels, dependencies, items] = await Promise.all([
    db
      .select({
        id: task.id,
        number: task.number,
        keySuffix: task.keySuffix,
        backlogId: task.backlogId,
        title: task.title,
        description: task.description,
        status: task.status,
        priority: task.priority,
        assigneeId: task.assigneeId,
        milestoneId: task.milestoneId,
        createdAt: task.createdAt,
        backlogData: task.backlogData,
        hiddenAt: task.hiddenAt,
        dueDate: task.dueDate,
        parentId: task.parentId,
        plan: task.plan,
        finalSummary: task.finalSummary,
      })
      .from(task)
      .where(eq(task.projectId, projectRow.id)),
    db
      .select({
        id: milestone.id,
        backlogId: milestone.backlogId,
        name: milestone.name,
        description: milestone.description,
        targetDate: milestone.targetDate,
        status: milestone.status,
        completedAt: milestone.completedAt,
        hiddenAt: milestone.hiddenAt,
      })
      .from(milestone)
      .where(eq(milestone.projectId, projectRow.id)) as Promise<ExistingMilestone[]>,
    db
      .select({
        path: backlogFile.path,
        blobSha: backlogFile.blobSha,
        kind: backlogFile.kind,
        backlogId: backlogFile.backlogId,
        taskId: backlogFile.taskId,
        milestoneId: backlogFile.milestoneId,
        error: backlogFile.error,
      })
      .from(backlogFile)
      .where(eq(backlogFile.sourceId, source.id)) as Promise<ExistingFile[]>,
    db
      .select({ id: label.id, name: label.name, color: label.color, source: label.source })
      .from(label)
      .where(eq(label.projectId, projectRow.id)) as Promise<ExistingLabel[]>,
    db
      .select({ taskId: taskLabel.taskId, labelId: taskLabel.labelId })
      .from(taskLabel)
      .innerJoin(task, eq(task.id, taskLabel.taskId))
      .where(eq(task.projectId, projectRow.id)),
    db
      .select({ taskId: taskDependency.taskId, blockerId: taskDependency.blockerId })
      .from(taskDependency)
      .innerJoin(task, eq(task.id, taskDependency.taskId))
      .where(eq(task.projectId, projectRow.id)),
    db
      .select({
        taskId: taskItem.taskId,
        kind: taskItem.kind,
        text: taskItem.text,
        state: taskItem.state,
        waivedReason: taskItem.waivedReason,
      })
      .from(taskItem)
      .innerJoin(task, eq(task.id, taskItem.taskId))
      .where(eq(task.projectId, projectRow.id))
      .orderBy(asc(taskItem.taskId), asc(taskItem.kind), asc(taskItem.position)),
  ]);
  const labelIds = new Map<string, string[]>();
  for (const row of taskLabels) labelIds.set(row.taskId, [...(labelIds.get(row.taskId) ?? []), row.labelId]);
  const blockerIds = new Map<string, string[]>();
  for (const row of dependencies) {
    blockerIds.set(row.taskId, [...(blockerIds.get(row.taskId) ?? []), row.blockerId]);
  }
  const lists = new Map<string, { criteria: WorkRecordItem[]; doneItems: WorkRecordItem[] }>();
  for (const item of items) {
    const entry = lists.get(item.taskId) ?? { criteria: [], doneItems: [] };
    (item.kind === 'criterion' ? entry.criteria : entry.doneItems).push({
      text: item.text,
      state: item.state,
      waivedReason: item.waivedReason,
    });
    lists.set(item.taskId, entry);
  }
  const tasks: ExistingTask[] = rows.map((row) => ({
    ...row,
    labelIds: labelIds.get(row.id) ?? [],
    blockerIds: blockerIds.get(row.id) ?? [],
    criteria: lists.get(row.id)?.criteria ?? [],
    doneItems: lists.get(row.id)?.doneItems ?? [],
  }));
  return {
    labels,
    tasks,
    milestones,
    files,
    nextTaskNumber: projectRow.nextTaskNumber,
    firstRead: source.lastReadCommit === null,
    problems: storedProblems(source),
  };
}

/** User ids of the workspace's members (assignee mappings to anyone else count as no one). */
export async function memberIds(db: DbOrTx, workspaceId: string): Promise<Set<string>> {
  const rows = await db
    .select({ userId: member.userId })
    .from(member)
    .where(eq(member.organizationId, workspaceId));
  return new Set(rows.map((row) => row.userId));
}

// ---------------------------------------------------------------------------
// Refresh
// ---------------------------------------------------------------------------

export type RefreshOutcomeKind =
  /** The plan was applied. */
  | 'applied'
  /** A poll found the head unchanged and stopped. */
  | 'unchanged'
  /** The source is detached or gone. */
  | 'skipped'
  /** Another run holds the source's lock. */
  | 'locked'
  | 'failed'
  | 'paused';

export interface RefreshOutcome {
  outcome: RefreshOutcomeKind;
  state: BacklogState | null;
  commit?: string;
  /** Blobs downloaded (config included). */
  downloads?: number;
  result?: ApplyResult;
  /** Why the run failed or paused; never contains a token. */
  error?: string;
}

export interface RefreshOptions {
  /** Test hook: runs inside the apply transaction after the plan was written. Throwing rolls it back. */
  beforeCommit?: (tx: Tx) => Promise<void>;
}

const MAX_ERROR_LENGTH = 500;

function shortMessage(error: unknown): string {
  const text = error instanceof Error ? error.message : String(error);
  return text.length > MAX_ERROR_LENGTH ? `${text.slice(0, MAX_ERROR_LENGTH - 1)}…` : text;
}

/**
 * Reads the source's folder at the default branch head and applies the difference. Never throws
 * for provider, config or apply failures: they end in the failed or paused state with a reason.
 */
export async function refreshBacklogSource(
  ctx: RefreshContext,
  sourceId: string,
  trigger: BacklogTrigger,
  options: RefreshOptions = {},
): Promise<RefreshOutcome> {
  const outcome = await withSourceLock(ctx.db, sourceId, () => runRefresh(ctx, sourceId, trigger, options));
  return outcome === LOCKED ? { outcome: 'locked', state: null } : outcome;
}

async function runRefresh(
  ctx: RefreshContext,
  sourceId: string,
  trigger: BacklogTrigger,
  options: RefreshOptions,
): Promise<RefreshOutcome> {
  const { db } = ctx;
  const source = await loadSource(db, sourceId);
  if (!source || source.state === 'detached') return { outcome: 'skipped', state: source?.state ?? null };
  const [projectRow] = await db.select().from(project).where(eq(project.id, source.projectId)).limit(1);
  if (!projectRow) return { outcome: 'skipped', state: source.state };
  const now = clockNow(ctx);

  const stop = async (state: 'failed' | 'paused', message: string): Promise<RefreshOutcome> => {
    await db
      .update(backlogSource)
      .set({ state, lastError: message, lastAttemptAt: now, lastTrigger: trigger })
      .where(and(eq(backlogSource.id, source.id), ne(backlogSource.state, 'detached')));
    return { outcome: state, state, error: message };
  };

  const repository = repositoryRef(projectRow.repository);
  if (!repository) {
    return stop('paused', REPOSITORY_CLEARED_ERROR);
  }
  if (!source.connectionId) {
    return stop('paused', 'The git connection was deleted. Choose another connection in project settings.');
  }
  let provider: GitProvider;
  let connection: GitConnectionRow;
  try {
    ({ provider, connection } = await providerForConnection(ctx, source.connectionId, {
      workspaceId: projectRow.workspaceId,
    }));
  } catch (error) {
    if (error instanceof EncryptionKeyMissing || error instanceof SecretUnreadable) {
      return stop('paused', error.message);
    }
    if (error instanceof NotFound) {
      return stop('paused', 'The git connection was deleted. Choose another connection in project settings.');
    }
    throw error;
  }

  try {
    const info = await provider.getRepository(repository.path);
    const head = await provider.getBranchHead(repository.path, info.defaultBranch);

    // The provider answered, so the connection works: resume it (and its other mirrors).
    if (connection.status !== 'working') {
      await db.transaction(async (tx) => {
        const change = await markConnectionStatus(tx, connection.id, 'working', null, { now });
        const others = change.resumedSourceIds.filter((id) => id !== source.id);
        if (others.length > 0 && ctx.jobs) await enqueueBacklogRefreshes(ctx, tx, others, 'poll');
      });
    }
    if (trigger === 'poll' && head === source.lastReadCommit && source.state !== 'failed') {
      const state: BacklogState =
        source.state === 'paused'
          ? storedProblems(source).length > 0
            ? 'warnings'
            : 'healthy'
          : source.state;
      await db
        .update(backlogSource)
        .set({
          headCommit: head,
          defaultBranch: info.defaultBranch,
          lastAttemptAt: now,
          state,
          ...(source.state === 'paused' ? { lastError: null } : {}),
        })
        .where(and(eq(backlogSource.id, source.id), ne(backlogSource.state, 'detached')));
      return { outcome: 'unchanged', state, commit: head, downloads: 0 };
    }

    await db
      .update(backlogSource)
      .set({ state: 'reading', lastAttemptAt: now, headCommit: head, defaultBranch: info.defaultBranch })
      .where(and(eq(backlogSource.id, source.id), ne(backlogSource.state, 'detached')));

    const location = await locateFolder(provider, repository.path, head, source.folderOverride);
    if (!location.folder) {
      const where = source.folderOverride ?? 'backlog/ or .backlog/';
      return stop(
        'failed',
        `No Backlog.md folder at ${where} on ${info.defaultBranch} (${head.slice(0, 7)}).`,
      );
    }
    const existing = await loadExisting(db, source, projectRow);
    const previous: PreviousRead | null =
      source.lastReadCommit === null
        ? null
        : {
            folder: source.folder,
            config: (source.config as PreviousRead['config']) ?? null,
            files: existing.files,
            tasks: existing.tasks,
            milestones: existing.milestones,
          };
    const read = await readFolder(
      provider,
      repository.path,
      { ...location, folder: location.folder },
      previous,
    );
    if (read.configError) {
      return stop(
        'failed',
        `The Backlog.md config could not be read, so nothing changed: ${read.configError}`,
      );
    }
    const plan = planRefresh({
      projectKey: projectRow.key,
      folder: read.folder,
      commit: head,
      now,
      config: read.config,
      configFile: read.configFile,
      files: read.files,
      mappings: storedMappings(source),
      memberIds: await memberIds(db, projectRow.workspaceId),
      existing,
    });

    const result = await db.transaction(async (tx) => {
      // Project first (the task services' lock order), then the source. Both may have changed
      // while the files were read.
      const [locked] = await tx.select().from(project).where(eq(project.id, projectRow.id)).for('update');
      const current = await loadSource(tx, source.id, { forUpdate: true });
      if (!locked || !current || current.state === 'detached') return 'detached' as const;
      if (repositoryRef(locked.repository)?.path !== repository.path) return 'repository' as const;
      const [count] = await tx
        .select({ n: sql<number>`count(*)`.mapWith(Number) })
        .from(task)
        .where(eq(task.projectId, projectRow.id));
      if ((count?.n ?? 0) !== existing.tasks.length) return 'tasks' as const;
      const applied = await applyPlan(tx, {
        source: current,
        project: projectRow,
        plan,
        previousFiles: existing.files,
        trigger,
        defaultBranch: info.defaultBranch,
        headCommit: head,
        repository: repository.short,
        now,
      });
      if (options.beforeCommit) await options.beforeCommit(tx);
      return applied;
    });
    if (result === 'detached') return { outcome: 'skipped', state: 'detached' };
    if (result === 'repository') {
      const [row] = await db
        .select({ repository: project.repository })
        .from(project)
        .where(eq(project.id, projectRow.id));
      return row?.repository
        ? stop(
            'failed',
            'The project repository changed during the read; the next refresh reads the new one.',
          )
        : stop('paused', REPOSITORY_CLEARED_ERROR);
    }
    if (result === 'tasks') {
      return stop(
        'failed',
        'Tasks were added to the project during the read, so nothing was written. Try again.',
      );
    }
    const state: BacklogState = result.detached
      ? 'detached'
      : plan.problems.length > 0
        ? 'warnings'
        : 'healthy';
    return { outcome: 'applied', state, commit: head, downloads: read.downloads, result };
  } catch (error) {
    if (pausesConnection(error)) {
      const failure = describeProviderError(error, connection) ?? {
        status: 'unreachable' as const,
        detail: `Could not reach ${connection.host}.`,
      };
      // Pauses every mirror on the connection, this one included, with the reason in last_error.
      await db.transaction(async (tx) => {
        await markConnectionStatus(tx, connection.id, failure.status, failure.detail, { now });
      });
      const [row] = await db
        .update(backlogSource)
        .set({ state: 'paused', lastAttemptAt: now, lastTrigger: trigger })
        .where(and(eq(backlogSource.id, source.id), ne(backlogSource.state, 'detached')))
        .returning({ lastError: backlogSource.lastError });
      return { outcome: 'paused', state: 'paused', error: row?.lastError ?? failure.detail };
    }
    if (error instanceof GitRateLimited) {
      const wait = Math.max(60, error.retryAfterSeconds ?? 300);
      const outcome = await stop(
        'failed',
        `${connection.host} asked to slow down; trying again in ${wait} seconds.`,
      );
      if (ctx.jobs) {
        await db.transaction((tx) =>
          enqueueBacklogRefresh(ctx, tx, source.id, trigger, { startAfterSeconds: wait }),
        );
      }
      return outcome;
    }
    if (error instanceof GitNotFound) {
      return stop('failed', `${repository.short} or its default branch was not found on ${connection.host}.`);
    }
    if (isCoreError(error)) return stop('failed', shortMessage(error));
    return stop('failed', `The refresh failed: ${shortMessage(error)}`);
  }
}
