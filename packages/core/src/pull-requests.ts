// Pull and merge requests on tasks (M7). Webhook events, the hourly check and links made by hand
// all go through applyRequest, so a request is stored, linked and acted on the same way whatever
// brought it in.
//
// Rules:
// - An event older than the stored host_updated_at is dropped, so deliveries out of order never
//   move a task back. A null author or merged-by keeps the stored name (some payloads leave them out).
// - Links follow the request: by branch, the tasks of the project whose work branch is the head
//   branch; by description, the task keys on `Closes:` lines, in this project only; by hand,
//   whatever a person linked. A link removed by hand stays removed until linked by hand again.
//   Automatic links and unlinks are history rows with no actor, origin git and the request as
//   cause. Archived tasks are left as they are.
// - Status moves happen only for live events (webhooks, hand links and checks after the first)
//   at or after the link's moves_from. Opened, reopened or ready moves linked tasks in Backlog,
//   Todo or In progress to In review; drafts move nothing. A merge into the default branch moves
//   linked tasks to Done when the project closes on merge and no other linked request of the task
//   is still open or a draft. Mirrored projects never move (setStatusFromSource skips them).
import {
  type ActivityCause,
  formatBacklogId,
  LinkPullRequestInput,
  type PullRequestCauseEvent,
  type PullRequestLink,
  type PullRequestLinkHow,
  PullRequestLink as PullRequestLinkSchema,
  parseBacklogId,
  splitTaskKey,
  type TaskStatus,
  UnlinkPullRequestInput,
} from '@zamu/contracts';
import { type DbOrTx, schema, type Tx } from '@zamu/db';
import {
  PROVIDER_KINDS,
  type ProviderKind,
  parseRequestUrl,
  type RequestAction,
  type RequestInfo,
  verifyWebhook,
  type WebhookHeaders,
  type WebhookVerification,
} from '@zamu/git-providers';
import { and, eq, inArray, isNull, ne, or, type SQL } from 'drizzle-orm';
import type { z } from 'zod';
import { recordActivities, recordActivity, type SystemActivityEntry } from './activity';
import { assertTaskWritable } from './archive';
import { type Actor, authorize } from './authz';
import { clockNow } from './cycles';
import { Conflict, Invalid, NotFound, parseInput } from './errors';
import { findTask, loadBacklogSource, loadUsers, type ProjectRow, sourceMirrors, userRef } from './internal';
import { type JobPayload, type JobQueue, REPOSITORY_EVENT } from './jobs';
import {
  describeReadError,
  ensureRepositoryLink,
  type LinkReader,
  loadLinkWithProject,
  lockLink,
  projectRepository,
  providerForHost,
  type RepositoryContext,
  type RepositoryJobContext,
  type RepositoryLinkRow,
  readerFailure,
  readerFor,
  repositoryHost,
  sameHost,
} from './repository';
import { decryptSecret, EncryptionKeyMissing, SecretUnreadable } from './secrets';
import { requestProvider, setStatusFromSource, type TaskContext } from './tasks';

const { gitConnection, project, pullRequest, task, taskPullRequest } = schema;

export type PullRequestRow = typeof pullRequest.$inferSelect;
type TaskPullRequestRow = typeof taskPullRequest.$inferSelect;

// ---------------------------------------------------------------------------
// Errors
// ---------------------------------------------------------------------------
// The contract codes travel on subclasses like the M5 codes (see relations.ts): adapters read
// them with problemCodeOf().

/** An address that is not a pull or merge request (422 NOT_A_REQUEST). */
export class NotARequest extends Invalid {
  readonly problemCode = 'NOT_A_REQUEST' as const;
}

/** A request of another repository than the project's (422 REQUEST_OTHER_REPOSITORY). */
export class RequestOtherRepository extends Invalid {
  readonly problemCode = 'REQUEST_OTHER_REPOSITORY' as const;
  /** The project's repository, short form (github.com/northwind/payments). */
  readonly repository: string;

  constructor(message: string, repository: string) {
    super(message, { issues: [{ path: 'url', message }] });
    this.repository = repository;
  }
}

/** The host has no such request, or the task does not link that number (404 REQUEST_NOT_FOUND). */
export class RequestNotFound extends NotFound {
  readonly problemCode = 'REQUEST_NOT_FOUND' as const;
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

/** Most task keys read from one description. */
export const MAX_CLOSES_KEYS = 50;

const CLOSES_LINE = /^[ \t]*(?:[-*+>][ \t]*)*closes:(.*)$/gim;

/**
 * The task keys on a description's `Closes:` lines (any case, comma or space separated),
 * uppercase, in order of first mention, at most MAX_CLOSES_KEYS. Tokens that are neither a task
 * key nor a Backlog.md id are ignored.
 */
export function closesKeys(body: string): string[] {
  const keys: string[] = [];
  for (const match of body.matchAll(CLOSES_LINE)) {
    for (const raw of (match[1] ?? '').split(/[\s,]+/)) {
      const token = raw.replace(/^[^A-Za-z0-9]+|[^A-Za-z0-9]+$/g, '').toUpperCase();
      if (!token || keys.includes(token)) continue;
      if (!splitTaskKey(token) && !parseBacklogId(token)) continue;
      keys.push(token);
      if (keys.length >= MAX_CLOSES_KEYS) return keys;
    }
  }
  return keys;
}

/** How people write a request number: !12 on GitLab, #12 elsewhere. */
export function requestRef(provider: ProviderKind, number: number): string {
  return provider === 'gitlab' ? `!${number}` : `#${number}`;
}

/** Whether a request's web address is in `repository` (by path: hosts may serve another name). */
function inRepository(webUrl: string, repository: { path: string }): boolean {
  const address = parseRequestUrl(webUrl);
  return address !== null && address.path.toLowerCase() === repository.path.toLowerCase();
}

/** A link shows while not removed by hand and made some way. */
function shows(row: Pick<TaskPullRequestRow, 'removedAt' | 'viaHand' | 'viaBranch' | 'viaDescription'>) {
  return row.removedAt === null && (row.viaHand || row.viaBranch || row.viaDescription);
}

/** How a link shows: the first of hand, branch, description that is true. */
function linkHow(row: { viaHand: boolean; viaBranch: boolean }): PullRequestLinkHow {
  return row.viaHand ? 'hand' : row.viaBranch ? 'branch' : 'description';
}

const visibleLink = () =>
  and(
    isNull(taskPullRequest.removedAt),
    or(taskPullRequest.viaHand, taskPullRequest.viaBranch, taskPullRequest.viaDescription),
  ) as SQL;

/** Branch names a repository's default branch has while Zamu has not read it. */
const USUAL_DEFAULT_BRANCHES: ReadonlySet<string> = new Set(['main', 'master']);

const REVIEW_FROM: ReadonlySet<TaskStatus> = new Set(['backlog', 'todo', 'in_progress']);
const CLOSED: ReadonlySet<TaskStatus> = new Set(['done', 'canceled']);

type MoveEvent = Extract<PullRequestCauseEvent, 'opened' | 'ready' | 'reopened' | 'merged' | 'closed'>;

/**
 * What changed about the request's state: opened (first seen open), ready (a draft no more),
 * reopened, merged, closed; null when the state is what Zamu had. The webhook action names
 * reopened and ready when the stored state can't tell.
 */
function stateEvent(
  before: PullRequestRow['state'] | null,
  after: PullRequestRow['state'],
  action: RequestAction | undefined,
): MoveEvent | null {
  if (after === before) return null;
  switch (after) {
    case 'open':
      if (action === 'reopened' || before === 'closed') return 'reopened';
      if (action === 'ready' || before === 'draft') return 'ready';
      return 'opened';
    case 'merged':
      return 'merged';
    case 'closed':
      return 'closed';
    case 'draft':
      return null;
  }
}

/** The event a history row names for the request in `state` when nothing changed. */
function eventOfState(state: PullRequestRow['state']): MoveEvent {
  return state === 'merged' ? 'merged' : state === 'closed' ? 'closed' : 'opened';
}

function causeOf(pr: PullRequestRow, event: MoveEvent): ActivityCause {
  const by = event === 'merged' ? pr.mergedBy : event === 'closed' ? null : pr.author;
  return {
    kind: 'pull_request',
    provider: requestProvider(pr.webUrl),
    number: pr.number,
    title: pr.title,
    url: pr.webUrl,
    event,
    by,
  };
}

function refOf(pr: PullRequestRow, how: PullRequestLinkHow) {
  return { provider: requestProvider(pr.webUrl), number: pr.number, title: pr.title, url: pr.webUrl, how };
}

/** Ids of the project's tasks named by `keys` (task keys of this project, Backlog.md ids). */
async function tasksForKeys(tx: DbOrTx, projectRow: ProjectRow, keys: string[]): Promise<string[]> {
  const conditions: SQL[] = [];
  const backlogIds: string[] = [];
  for (const key of keys) {
    const parts = splitTaskKey(key);
    if (parts && parts.projectKey === projectRow.key) {
      conditions.push(
        and(
          eq(task.number, parts.number),
          parts.suffix === null ? isNull(task.keySuffix) : eq(task.keySuffix, parts.suffix),
        ) as SQL,
      );
    }
    const backlog = parseBacklogId(key);
    if (backlog) backlogIds.push(formatBacklogId(backlog));
  }
  if (backlogIds.length > 0) conditions.push(inArray(task.backlogId, backlogIds));
  if (conditions.length === 0) return [];
  const rows = await tx
    .select({ id: task.id })
    .from(task)
    .where(and(eq(task.projectId, projectRow.id), or(...conditions)));
  return rows.map((row) => row.id);
}

// ---------------------------------------------------------------------------
// applyRequest
// ---------------------------------------------------------------------------

export interface ApplyRequestOptions {
  /** Whether the request may move tasks (still only at or after the link's moves_from). */
  live: boolean;
  /** The webhook action, when a webhook brought the request. */
  action?: RequestAction;
  /** A link by hand to make in the same pass: as the actor, restoring a link removed by hand. */
  hand?: { taskId: string; actor: Actor };
}

export interface ApplyRequestResult {
  /** False when nothing was stored: an older event, or a request of another repository. */
  applied: boolean;
  reason: 'stored' | 'stale' | 'other_repository' | 'no_repository';
  pullRequest: PullRequestRow | null;
  /** Tasks the request started to show on, and stopped showing on. */
  linked: string[];
  unlinked: string[];
  moved: { taskId: string; from: TaskStatus; to: 'in_review' | 'done' }[];
}

/**
 * Stores one request of the link's repository and acts on it: links and unlinks tasks by branch,
 * description and hand, writes their history rows, and moves tasks per the rules in the file
 * comment. Locks the project first (like every status change), then the request. Run inside the
 * caller's transaction; the workspace is the link's.
 */
export async function applyRequest(
  tx: Tx,
  ctx: TaskContext,
  link: RepositoryLinkRow,
  request: RequestInfo,
  options: ApplyRequestOptions,
): Promise<ApplyRequestResult> {
  const nothing = (reason: ApplyRequestResult['reason'], pr: PullRequestRow | null = null) => ({
    applied: false,
    reason,
    pullRequest: pr,
    linked: [],
    unlinked: [],
    moved: [],
  });
  const [projectRow] = await tx
    .select()
    .from(project)
    .where(and(eq(project.id, link.projectId), eq(project.workspaceId, link.workspaceId)))
    .for('update');
  const repository = projectRow ? projectRepository(projectRow) : null;
  if (!projectRow || !repository || projectRow.repositoryKey !== link.repositoryKey) {
    return nothing('no_repository');
  }
  if (!inRepository(request.webUrl, repository)) return nothing('other_repository');

  const [existing] = await tx
    .select()
    .from(pullRequest)
    .where(and(eq(pullRequest.projectId, projectRow.id), eq(pullRequest.number, request.number)))
    .for('update');
  const updatedAt = new Date(request.updatedAt);
  const stale = existing !== undefined && updatedAt.getTime() < existing.hostUpdatedAt.getTime();
  if (stale && !options.hand) return nothing('stale', existing);

  let pr: PullRequestRow;
  if (stale && existing) {
    pr = existing;
  } else {
    const values = {
      title: request.title,
      bodyKeys: closesKeys(request.body),
      state: request.state,
      headBranch: request.headBranch,
      baseBranch: request.baseBranch,
      author: request.author ?? existing?.author ?? null,
      mergedBy: request.mergedBy ?? existing?.mergedBy ?? null,
      webUrl: request.webUrl,
      openedAt: new Date(request.openedAt),
      mergedAt: request.mergedAt ? new Date(request.mergedAt) : null,
      closedAt: request.closedAt ? new Date(request.closedAt) : null,
      hostUpdatedAt: updatedAt,
    };
    const [row] = existing
      ? await tx.update(pullRequest).set(values).where(eq(pullRequest.id, existing.id)).returning()
      : await tx
          .insert(pullRequest)
          .values({
            ...values,
            workspaceId: link.workspaceId,
            projectId: projectRow.id,
            number: request.number,
          })
          .returning();
    if (!row) throw new Error('pull request upsert returned no row');
    pr = row;
  }
  const event = stale ? null : stateEvent(existing?.state ?? null, pr.state, options.action);

  // Links: what each task should have, against what it has.
  const byBranch = new Set(
    (
      await tx
        .select({ id: task.id })
        .from(task)
        .where(and(eq(task.projectId, projectRow.id), eq(task.workBranch, pr.headBranch)))
    ).map((row) => row.id),
  );
  const byDescription = new Set(await tasksForKeys(tx, projectRow, pr.bodyKeys));
  const rows = new Map(
    (await tx.select().from(taskPullRequest).where(eq(taskPullRequest.pullRequestId, pr.id))).map((row) => [
      row.taskId,
      row,
    ]),
  );
  const hand = options.hand ?? null;
  const candidates = [
    ...new Set([...byBranch, ...byDescription, ...rows.keys(), ...(hand ? [hand.taskId] : [])]),
  ];
  const tasks = new Map(
    candidates.length === 0
      ? []
      : (
          await tx
            .select({ id: task.id, status: task.status, archivedAt: task.archivedAt })
            .from(task)
            .where(and(eq(task.projectId, projectRow.id), inArray(task.id, candidates)))
        ).map((row) => [row.id, row]),
  );

  const linked: string[] = [];
  const unlinked: string[] = [];
  const visible = new Set<string>();
  const gitEntries: SystemActivityEntry[] = [];
  const linkCause = causeOf(pr, event ?? eventOfState(pr.state));
  for (const taskId of candidates) {
    const current = tasks.get(taskId);
    if (!current) continue;
    const row = rows.get(taskId);
    const isHand = hand?.taskId === taskId;
    // Archived tasks are read-only; a removed link stays removed unless linked by hand again.
    if (current.archivedAt !== null && !isHand) {
      if (row && shows(row)) visible.add(taskId);
      continue;
    }
    if (row?.removedAt && !isHand) continue;
    const next = {
      viaBranch: byBranch.has(taskId),
      viaDescription: byDescription.has(taskId),
      viaHand: isHand || (row?.viaHand ?? false),
    };
    const before = row ? shows(row) : false;
    const after = next.viaHand || next.viaBranch || next.viaDescription;
    if (!row) {
      if (after) {
        await tx.insert(taskPullRequest).values({
          taskId,
          pullRequestId: pr.id,
          ...next,
          linkedById: isHand ? (hand?.actor.userId ?? null) : null,
        });
      }
    } else if (
      isHand ||
      row.viaBranch !== next.viaBranch ||
      row.viaDescription !== next.viaDescription ||
      row.viaHand !== next.viaHand
    ) {
      await tx
        .update(taskPullRequest)
        .set({
          ...next,
          ...(isHand
            ? {
                removedAt: null,
                removedById: null,
                linkedById: row.viaHand && !row.removedAt ? row.linkedById : (hand?.actor.userId ?? null),
              }
            : {}),
        })
        .where(and(eq(taskPullRequest.taskId, taskId), eq(taskPullRequest.pullRequestId, pr.id)));
    }
    if (after) visible.add(taskId);
    if (before === after) continue;
    if (after) linked.push(taskId);
    else unlinked.push(taskId);
    const change = after
      ? { field: 'pullRequest' as const, from: null, to: refOf(pr, linkHow(next)) }
      : { field: 'pullRequest' as const, from: refOf(pr, linkHow(row ?? next)), to: null };
    const entry = {
      projectId: projectRow.id,
      taskId,
      type: after ? ('task.pull_request_linked' as const) : ('task.pull_request_unlinked' as const),
      changes: [change],
    };
    if (isHand && hand) await recordActivity(tx, hand.actor, entry);
    else
      gitEntries.push({
        ...entry,
        workspaceId: link.workspaceId,
        origin: 'git',
        originRef: pr.webUrl,
        cause: linkCause,
      });
  }
  await recordActivities(tx, null, gitEntries);

  // Moves.
  const moved: ApplyRequestResult['moved'] = [];
  const movesNow = options.live && !stale && pr.hostUpdatedAt.getTime() >= link.movesFrom.getTime();
  if (movesNow && pr.state !== 'draft' && pr.state !== 'closed') {
    const fresh = new Set(linked);
    const targets = [...visible].filter((taskId) => {
      if (fresh.has(taskId)) return true;
      return pr.state === 'open'
        ? event === 'opened' || event === 'ready' || event === 'reopened'
        : event === 'merged';
    });
    if (pr.state === 'open') {
      const cause = causeOf(pr, event ?? 'opened');
      for (const taskId of targets) {
        const current = tasks.get(taskId);
        if (!current || !REVIEW_FROM.has(current.status)) continue;
        const result = await setStatusFromSource(tx, ctx, {
          workspaceId: link.workspaceId,
          taskId,
          status: 'in_review',
          cause,
        });
        if (result.changed) moved.push({ taskId, from: result.from, to: 'in_review' });
      }
    } else if (pr.state === 'merged' && (await closesOnMerge(tx, link, projectRow, pr))) {
      const open = await tasksWithOtherOpenRequests(tx, targets, pr.id);
      const cause = causeOf(pr, 'merged');
      for (const taskId of targets) {
        const current = tasks.get(taskId);
        if (!current || CLOSED.has(current.status) || open.has(taskId)) continue;
        const result = await setStatusFromSource(tx, ctx, {
          workspaceId: link.workspaceId,
          taskId,
          status: 'done',
          cause,
        });
        if (result.changed) moved.push({ taskId, from: result.from, to: 'done' });
      }
    }
  }
  return { applied: !stale, reason: stale ? 'stale' : 'stored', pullRequest: pr, linked, unlinked, moved };
}

/** A merge into the default branch of a project that closes on merge and does not mirror Backlog.md. */
async function closesOnMerge(
  tx: Tx,
  link: RepositoryLinkRow,
  projectRow: ProjectRow,
  pr: PullRequestRow,
): Promise<boolean> {
  if (!link.closeOnMerge) return false;
  const intoDefault = link.defaultBranch
    ? pr.baseBranch === link.defaultBranch
    : USUAL_DEFAULT_BRANCHES.has(pr.baseBranch);
  if (!intoDefault) return false;
  return !sourceMirrors(await loadBacklogSource(tx, projectRow.id));
}

/** Of `taskIds`, those that show another request that is open or a draft. */
async function tasksWithOtherOpenRequests(
  tx: Tx,
  taskIds: string[],
  pullRequestId: string,
): Promise<Set<string>> {
  if (taskIds.length === 0) return new Set();
  const rows = await tx
    .select({ taskId: taskPullRequest.taskId })
    .from(taskPullRequest)
    .innerJoin(pullRequest, eq(pullRequest.id, taskPullRequest.pullRequestId))
    .where(
      and(
        inArray(taskPullRequest.taskId, taskIds),
        ne(taskPullRequest.pullRequestId, pullRequestId),
        visibleLink(),
        inArray(pullRequest.state, ['open', 'draft']),
      ),
    );
  return new Set(rows.map((row) => row.taskId));
}

// ---------------------------------------------------------------------------
// Links by hand
// ---------------------------------------------------------------------------

export type PullRequestContext = RepositoryContext & TaskContext;

function toLink(
  pr: Pick<
    PullRequestRow,
    | 'number'
    | 'title'
    | 'state'
    | 'headBranch'
    | 'baseBranch'
    | 'author'
    | 'mergedBy'
    | 'webUrl'
    | 'openedAt'
    | 'mergedAt'
    | 'closedAt'
    | 'hostUpdatedAt'
  >,
  link: { how: PullRequestLinkHow; linkedBy: PullRequestLink['linkedBy']; linkedAt: Date },
): PullRequestLink {
  return PullRequestLinkSchema.parse({
    provider: requestProvider(pr.webUrl),
    number: pr.number,
    title: pr.title,
    url: pr.webUrl,
    state: pr.state,
    headBranch: pr.headBranch,
    baseBranch: pr.baseBranch,
    author: pr.author,
    mergedBy: pr.mergedBy,
    how: link.how,
    linkedBy: link.linkedBy,
    linkedAt: link.linkedAt,
    openedAt: pr.openedAt,
    mergedAt: pr.mergedAt,
    closedAt: pr.closedAt,
    updatedAt: pr.hostUpdatedAt,
  });
}

async function userRefOf(db: DbOrTx, userId: string | null): Promise<PullRequestLink['linkedBy']> {
  if (!userId) return null;
  const user = (await loadUsers(db, [userId])).get(userId);
  return user ? userRef(user) : null;
}

/** A reading failure as a refusal: no reader, or a provider error, in a token-free sentence. */
function readRefusal(error: unknown, reader: LinkReader | null): Conflict | null {
  const message = reader ? describeReadError(error, reader) : readerFailure(error);
  return message === null ? null : new Conflict(message);
}

/**
 * POST /tasks/{key}/pull-requests: links a request of the project's repository by hand, reading
 * it from the host through the link (its connection, or a public read). Refusals: NOT_A_REQUEST
 * for an address that is not a request, REQUEST_OTHER_REPOSITORY for another repository,
 * REQUEST_NOT_FOUND when the host has no such request, TASK_ARCHIVED, Conflict without a
 * repository or when the host can't be read. dryRun returns the link as it would be and writes
 * nothing. Linking a request removed by hand brings it back. The request is applied like a
 * webhook event, so a link to an open or merged request may move the task.
 */
export async function linkPullRequest(
  ctx: PullRequestContext,
  actor: Actor,
  input: z.input<typeof LinkPullRequestInput>,
): Promise<PullRequestLink> {
  const parsed = parseInput(LinkPullRequestInput, input);
  const found = await findTask(ctx.db, actor, parsed.key, parsed.project ? { project: parsed.project } : {});
  authorize(actor, 'task.write', { type: 'project', projectId: found.project.id });
  assertTaskWritable(found.project, found.task);
  const repository = projectRepository(found.project);
  if (!repository) {
    throw new Conflict(`${found.project.key} has no repository. Set one in the project settings first.`);
  }
  const address = parseRequestUrl(parsed.url);
  if (!address) {
    throw new NotARequest('That address is not a pull or merge request.', {
      issues: [{ path: 'url', message: 'That address is not a pull or merge request.' }],
    });
  }
  if (
    !sameHost(address.host, repository.host) ||
    address.path.toLowerCase() !== repository.path.toLowerCase()
  ) {
    throw new RequestOtherRepository(
      `That request is in another repository. ${found.project.key} links ${repository.short}.`,
      repository.short,
    );
  }

  const link = await ctx.db.transaction(async (tx) => {
    const [locked] = await tx.select().from(project).where(eq(project.id, found.project.id)).for('update');
    return locked ? ensureRepositoryLink(tx, ctx, locked) : null;
  });
  if (!link)
    throw new Conflict(`${found.project.key} has no repository. Set one in the project settings first.`);

  let reader: LinkReader | null = null;
  let info: RequestInfo | null;
  try {
    reader = await readerFor(ctx, link, found.project, address.provider);
    if (!reader.provider.getRequest) throw new Conflict(`Zamu can't read requests on ${reader.host}.`);
    info = await reader.provider.getRequest(reader.path, address.number);
  } catch (error) {
    const refusal = readRefusal(error, reader);
    if (refusal) throw refusal;
    throw error;
  }
  const ref = requestRef(reader.kind, address.number);
  if (!info || !inRepository(info.webUrl, repository)) {
    throw new RequestNotFound(`${repository.short} has no pull or merge request ${ref}.`);
  }

  if (parsed.dryRun) {
    return toLink(
      {
        ...info,
        openedAt: new Date(info.openedAt),
        mergedAt: info.mergedAt ? new Date(info.mergedAt) : null,
        closedAt: info.closedAt ? new Date(info.closedAt) : null,
        hostUpdatedAt: new Date(info.updatedAt),
      },
      { how: 'hand', linkedBy: await userRefOf(ctx.db, actor.userId), linkedAt: clockNow(ctx) },
    );
  }

  const request = info;
  return ctx.db.transaction(async (tx) => {
    const locked = await lockLink(tx, ctx, link.id);
    if (!locked?.link || locked.link.repositoryKey !== link.repositoryKey) {
      throw new Conflict(`The repository of ${found.project.key} changed. Try again.`);
    }
    const [taskRow] = await tx.select().from(task).where(eq(task.id, found.task.id)).for('update');
    if (!taskRow) throw new NotFound(`Task ${parsed.key} not found`);
    assertTaskWritable(locked.project, taskRow);
    const result = await applyRequest(tx, ctx, locked.link, request, {
      live: true,
      hand: { taskId: taskRow.id, actor },
    });
    const pr = result.pullRequest;
    if (!pr) throw new RequestNotFound(`${repository.short} has no pull or merge request ${ref}.`);
    const [row] = await tx
      .select()
      .from(taskPullRequest)
      .where(and(eq(taskPullRequest.taskId, taskRow.id), eq(taskPullRequest.pullRequestId, pr.id)));
    if (!row) throw new Error('hand link returned no row');
    return toLink(pr, {
      how: linkHow(row),
      linkedBy: await userRefOf(tx, row.linkedById),
      linkedAt: row.createdAt,
    });
  });
}

/**
 * DELETE /tasks/{key}/pull-requests/{number}: removes the link. It stays removed: neither the
 * branch nor a `Closes:` line brings it back; linking it by hand does. REQUEST_NOT_FOUND when the
 * task does not show that request; TASK_ARCHIVED for an archived task. One history row as the actor.
 */
export async function unlinkPullRequest(
  ctx: PullRequestContext,
  actor: Actor,
  input: z.input<typeof UnlinkPullRequestInput>,
): Promise<void> {
  const parsed = parseInput(UnlinkPullRequestInput, input);
  await ctx.db.transaction(async (tx) => {
    const { project: projectRow, task: taskRow } = await findTask(tx, actor, parsed.key, {
      forUpdate: true,
      lockProject: true,
      ...(parsed.project ? { project: parsed.project } : {}),
    });
    authorize(actor, 'task.write', { type: 'project', projectId: projectRow.id });
    assertTaskWritable(projectRow, taskRow);
    const [pr] = await tx
      .select()
      .from(pullRequest)
      .where(and(eq(pullRequest.projectId, projectRow.id), eq(pullRequest.number, parsed.number)));
    const [row] = pr
      ? await tx
          .select()
          .from(taskPullRequest)
          .where(and(eq(taskPullRequest.taskId, taskRow.id), eq(taskPullRequest.pullRequestId, pr.id)))
          .for('update')
      : [];
    const key = parsed.key;
    if (!pr || !row || !shows(row)) {
      const kind: ProviderKind = pr ? requestProvider(pr.webUrl) : 'github';
      throw new RequestNotFound(`${key} does not link ${requestRef(kind, parsed.number)}.`);
    }
    await tx
      .update(taskPullRequest)
      .set({ removedAt: clockNow(ctx), removedById: actor.userId, viaHand: false })
      .where(and(eq(taskPullRequest.taskId, taskRow.id), eq(taskPullRequest.pullRequestId, pr.id)));
    await recordActivity(tx, actor, {
      projectId: projectRow.id,
      taskId: taskRow.id,
      type: 'task.pull_request_unlinked',
      changes: [{ field: 'pullRequest', from: refOf(pr, linkHow(row)), to: null }],
    });
  });
}

// ---------------------------------------------------------------------------
// Webhooks and the event job
// ---------------------------------------------------------------------------

/** Webhook ids are random base64url strings. */
const WEBHOOK_ID = /^[A-Za-z0-9_-]{8,64}$/;

export interface RepositoryWebhookDecision {
  status: 200 | 202 | 401 | 404 | 410;
  /** For logs only; the route sends no detail. */
  reason: 'event_queued' | 'ignored' | 'bad_payload' | 'unknown_webhook' | 'bad_signature' | 'no_repository';
}

/** A verified request event, as the job carries it. */
type RequestEvent = Extract<WebhookVerification, { event: 'pull_request' }>;

async function queueEvent(
  ctx: { jobs?: JobQueue },
  tx: Tx,
  linkId: string,
  event: Pick<RequestEvent, 'action' | 'request'>,
): Promise<void> {
  if (!ctx.jobs) throw new Error('Repository webhooks need the job queue in the core context');
  await ctx.jobs.enqueue(tx, REPOSITORY_EVENT, { linkId, request: event.request, action: event.action });
}

/**
 * POST /api/webhooks/repository/{webhookId}. The route reads the raw body once and maps the
 * decision to a response. Unknown id: 404. The project lost its repository: 410. No secret issued,
 * an unreadable secret, a missing or wrong signature: 401, recorded as bad_signature. A signed
 * payload Zamu can't read: 200, recorded as bad_payload. A request event: 202 and a
 * repository.event job. Other events (push, ping): 200. Every delivery that reaches the signature
 * check sets webhook_last_at. Never throws for bad input.
 */
export async function receiveRepositoryWebhook(
  ctx: RepositoryJobContext,
  input: { webhookId: string; headers: WebhookHeaders; rawBody: Uint8Array | string },
): Promise<RepositoryWebhookDecision> {
  if (!WEBHOOK_ID.test(input.webhookId)) return { status: 404, reason: 'unknown_webhook' };
  const [hit] = await ctx.db
    .select({ id: schema.repositoryLink.id })
    .from(schema.repositoryLink)
    .where(eq(schema.repositoryLink.webhookId, input.webhookId))
    .limit(1);
  const found = hit ? await loadLinkWithProject(ctx.db, hit.id) : null;
  if (!found) return { status: 404, reason: 'unknown_webhook' };
  const { link, project: projectRow } = found;
  const repository = projectRepository(projectRow);
  if (!repository || !projectRow.repository) return { status: 410, reason: 'no_repository' };

  const record = async (status: 'ok' | 'bad_signature' | 'bad_payload', event?: RequestEvent) =>
    ctx.db.transaction(async (tx) => {
      const locked = await lockLink(tx, ctx, link.id);
      if (!locked?.link) return false;
      await tx
        .update(schema.repositoryLink)
        .set({ webhookLastAt: clockNow(ctx), webhookLastStatus: status })
        .where(eq(schema.repositoryLink.id, locked.link.id));
      if (event) await queueEvent(ctx, tx, locked.link.id, event);
      return true;
    });

  let secret: string | null = null;
  if (link.webhookSecretCiphertext) {
    try {
      secret = decryptSecret(ctx, link.webhookSecretCiphertext);
    } catch (error) {
      if (!(error instanceof EncryptionKeyMissing || error instanceof SecretUnreadable)) throw error;
    }
  }
  if (!secret) {
    await record('bad_signature');
    return { status: 401, reason: 'bad_signature' };
  }

  const kinds = await providerKindsOf(ctx.db, link, repositoryHost(projectRow.repository, repository));
  let verified: Exclude<WebhookVerification, { ok: false }> | null = null;
  let badPayload = false;
  for (const kind of kinds) {
    const result = verifyWebhook(kind, input.headers, input.rawBody, secret);
    if (result.ok) {
      verified = result;
      break;
    }
    if (result.reason === 'bad_payload') badPayload = true;
  }
  if (!verified) {
    if (badPayload) {
      await record('bad_payload');
      return { status: 200, reason: 'bad_payload' };
    }
    await record('bad_signature');
    return { status: 401, reason: 'bad_signature' };
  }
  if (verified.event !== 'pull_request') {
    await record('ok');
    return { status: 200, reason: 'ignored' };
  }
  const queued = await record('ok', verified);
  return queued ? { status: 202, reason: 'event_queued' } : { status: 410, reason: 'no_repository' };
}

/** The host kinds whose signatures count: the connection's, else the host name's, else any. */
async function providerKindsOf(
  db: DbOrTx,
  link: Pick<RepositoryLinkRow, 'connectionId' | 'workspaceId'>,
  host: string,
): Promise<readonly ProviderKind[]> {
  if (link.connectionId) {
    const [connection] = await db
      .select({ provider: gitConnection.provider })
      .from(gitConnection)
      .where(and(eq(gitConnection.id, link.connectionId), eq(gitConnection.workspaceId, link.workspaceId)))
      .limit(1);
    if (connection) return [connection.provider];
  }
  const kind = providerForHost(host);
  return kind ? [kind] : PROVIDER_KINDS;
}

/**
 * M7: a request event delivered to a project's Backlog.md webhook (backlog/webhook.ts): recorded
 * on the project's repository link like a delivery to its own webhook, and queued the same way.
 * False when the project has no repository. Run inside the caller's transaction.
 */
export async function queueBacklogRequestEvent(
  ctx: { jobs?: JobQueue; now?: () => Date },
  tx: Tx,
  projectId: string,
  event: Pick<RequestEvent, 'action' | 'request'>,
): Promise<boolean> {
  // The source's project names the workspace; the link and the job carry it from here.
  const [projectRow] = await tx.select().from(project).where(eq(project.id, projectId)).for('update');
  const link = projectRow ? await ensureRepositoryLink(tx, ctx, projectRow) : null;
  if (!link) return false;
  await tx
    .update(schema.repositoryLink)
    .set({ webhookLastAt: clockNow(ctx), webhookLastStatus: 'ok' })
    .where(eq(schema.repositoryLink.id, link.id));
  await queueEvent(ctx, tx, link.id, event);
  return true;
}

/**
 * repository.event: applies one webhook event (live). A merge before the first check reads the
 * default branch first, so it counts only into the right branch (main or master when the host
 * can't be read).
 */
export async function handleRepositoryEvent(
  ctx: RepositoryJobContext & TaskContext,
  payload: JobPayload<typeof REPOSITORY_EVENT>,
): Promise<ApplyRequestResult | { applied: false; reason: 'no_link' }> {
  const found = await loadLinkWithProject(ctx.db, payload.linkId);
  if (!found) return { applied: false, reason: 'no_link' };
  const request = payload.request as RequestInfo;
  let defaultBranch = found.link.defaultBranch;
  if (!defaultBranch && request.state === 'merged') {
    try {
      const reader = await readerFor(ctx, found.link, found.project);
      defaultBranch = (await reader.provider.getRepository(reader.path)).defaultBranch;
    } catch {
      // Unreadable now: the merge counts into main or master, and the next check stores the branch.
    }
  }
  return ctx.db.transaction(async (tx) => {
    const locked = await lockLink(tx, ctx, payload.linkId);
    if (!locked?.link) return { applied: false, reason: 'no_link' } as const;
    // A branch read for the repository the link described then, not one it was reset to since.
    const branch = locked.link.repositoryKey === found.link.repositoryKey ? defaultBranch : null;
    if (!locked.link.defaultBranch && branch) {
      await tx
        .update(schema.repositoryLink)
        .set({ defaultBranch: branch })
        .where(eq(schema.repositoryLink.id, locked.link.id));
    }
    return applyRequest(
      tx,
      ctx,
      { ...locked.link, defaultBranch: locked.link.defaultBranch ?? branch },
      request,
      { live: true, ...(payload.action ? { action: payload.action } : {}) },
    );
  });
}
