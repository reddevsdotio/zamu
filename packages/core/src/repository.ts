// Repository links (M7): how Zamu reads a project's pull or merge requests. One row per project
// with a repository, made the first time something needs it (the Repository page, the hourly
// check, a webhook delivery). The row records which repository it describes: when the project's
// repository changes, the row starts over and the requests of the old repository are deleted.
//
// Rules:
// - The connection is the Backlog.md source's for a project that reads Backlog.md, else the only
//   working connection of the workspace for the repository's host, else none: a public read
//   without a token. moves_from is set when the row is made and whenever its connection changes,
//   so requests seen before then link without moving tasks.
// - Everyone who reads the project reads the settings. Owners and admins change the connection
//   and close-on-merge, issue a webhook secret and ask for a check now.
// - The webhook secret is random, stored encrypted like connection tokens, and returned once.
// - The hourly check (repository.sync, run by syncRepository) lists the requests updated since
//   the last one and applies each like a webhook event. Its errors are stored on the row without
//   the token.
import { randomBytes } from 'node:crypto';
import {
  type GitProvider as GitProviderName,
  parseRepositoryUrl,
  type Repository,
  RepositoryProjectInput,
  type RepositorySettings,
  RepositorySettings as RepositorySettingsSchema,
  type RepositoryWebhookSecret,
  UpdateRepositoryInput,
} from '@zamu/contracts';
import { type DbOrTx, schema, type Tx } from '@zamu/db';
import {
  type GitProvider,
  hostnameOf,
  isGitProviderError,
  MAX_UPDATED_REQUESTS,
  normalizeHost,
  type RequestInfo,
} from '@zamu/git-providers';
import { and, asc, eq, inArray, isNotNull, notExists } from 'drizzle-orm';
import type { z } from 'zod';
import { type Actor, can } from './authz';
import type { LinkContext } from './context';
import { clockNow } from './cycles';
import { Conflict, Forbidden, Invalid, NotFound, ProjectMirrored, parseInput } from './errors';
import {
  describeProviderError,
  type GitConnectionContext,
  providerForConnection,
  publicProvider,
} from './git-connections';
import {
  findProjectByKey,
  loadBacklogSource,
  type ProjectRow,
  sourceIsActive,
  sourceMirrors,
} from './internal';
import { type JobQueue, REPOSITORY_POLL_CRON_MINUTE, REPOSITORY_SYNC } from './jobs';
import { applyRequest } from './pull-requests';
import { EncryptionKeyMissing, encryptSecret, isEncryptionReady, SecretUnreadable } from './secrets';
import { requestProvider } from './tasks';

const { gitConnection, project, pullRequest, repositoryLink } = schema;

export type RepositoryLinkRow = typeof repositoryLink.$inferSelect;

/** What the repository services need: the database, git settings, the public URL and the queue. */
export interface RepositoryContext extends GitConnectionContext, LinkContext {
  jobs?: JobQueue;
}

/** What the jobs and the webhook need: no public URL. */
export interface RepositoryJobContext extends GitConnectionContext {
  jobs?: JobQueue;
}

/** Requests listed by the first check: the open ones plus those updated in this many days. */
/** Most merged requests a check reads one by one to learn who merged them. */
const MERGED_BY_READS_PER_SYNC = 10;

export const FIRST_SYNC_DAYS = 7;

/** Each check lists from this long before the newest update the previous one read. */
export const SYNC_OVERLAP_MS = 10 * 60_000;

// ---------------------------------------------------------------------------
// Repository, host and provider
// ---------------------------------------------------------------------------

/** The project's repository as parseRepositoryUrl reads it, or null. */
export function projectRepository(row: Pick<ProjectRow, 'repository'>): Repository | null {
  return row.repository ? parseRepositoryUrl(row.repository) : null;
}

/**
 * The host to call for the project's repository, with the port the URL names
 * (`localhost:3300`). parseRepositoryUrl drops the port; reads without a connection need it.
 */
export function repositoryHost(repositoryUrl: string, repository: Repository): string {
  try {
    const url = new URL(repositoryUrl.trim());
    if (url.protocol === 'https:' || url.protocol === 'http:') {
      const host = normalizeHost(`${url.protocol}//${url.host}`);
      if (host) return host;
    }
  } catch {
    // An SSH address (git@host:path) names no port.
  }
  return repository.host;
}

/** Hosts compared without port and IPv6 brackets: a connection's `host:port` and a repository's host. */
export function sameHost(a: string, b: string): boolean {
  const bare = (host: string) => hostnameOf(host.toLowerCase()).replace(/^\[|\]$/g, '');
  return bare(a) === bare(b);
}

/**
 * The host kind a host name implies, for links without a connection: github.com, gitlab.com and
 * codeberg.org, and host names that start with the product name. Null when the name says nothing.
 */
export function providerForHost(host: string): GitProviderName | null {
  const name = hostnameOf(host.toLowerCase());
  if (name === 'github.com' || name.startsWith('github.')) return 'github';
  if (name === 'gitlab.com' || name.startsWith('gitlab.')) return 'gitlab';
  if (name === 'codeberg.org' || /^(gitea|forgejo)\./.test(name)) return 'gitea';
  return null;
}

/** POST target for the host: {PUBLIC_URL}/api/webhooks/repository/{webhookId}. */
export function repositoryWebhookUrl(publicUrl: string, webhookId: string): string {
  return `${publicUrl.replace(/\/+$/, '')}/api/webhooks/repository/${webhookId}`;
}

/** A random URL-safe webhook id (24 characters), like the Backlog.md webhook ids. */
function newWebhookId(): string {
  return randomBytes(18).toString('base64url');
}

// ---------------------------------------------------------------------------
// The link row
// ---------------------------------------------------------------------------

/**
 * The connection a link starts with (and returns to when its repository changes): the Backlog.md
 * source's connection while one is set up, else the only working connection of the workspace for
 * the repository's host, else none.
 */
export async function chooseConnection(db: DbOrTx, projectRow: ProjectRow): Promise<string | null> {
  const repository = projectRepository(projectRow);
  if (!repository) return null;
  const source = await loadBacklogSource(db, projectRow.id);
  if (sourceIsActive(source) && source?.connectionId) return source.connectionId;
  const rows = await db
    .select({ id: gitConnection.id, host: gitConnection.host })
    .from(gitConnection)
    .where(and(eq(gitConnection.workspaceId, projectRow.workspaceId), eq(gitConnection.status, 'working')));
  const matching = rows.filter((row) => sameHost(row.host, repository.host));
  return matching.length === 1 ? (matching[0]?.id ?? null) : null;
}

/** The project's link row, locked when asked; null when it has none. */
async function loadLink(
  db: DbOrTx,
  projectId: string,
  options: { forUpdate?: boolean } = {},
): Promise<RepositoryLinkRow | null> {
  const query = db.select().from(repositoryLink).where(eq(repositoryLink.projectId, projectId)).limit(1);
  const [row] = options.forUpdate ? await query.for('update') : await query;
  return row ?? null;
}

/**
 * The link of a project with a repository, made on first use and started over when the project's
 * repository changed since the row was made: the requests of the old repository are deleted (with
 * their task links), the connection is chosen again, the check and webhook state are cleared and
 * moves_from restarts. The webhook id and secret stay, so the same URL can serve the new
 * repository. Null when the project has no repository; the row of an earlier one is kept then.
 * Run inside the caller's transaction; locks the link row.
 */
export async function ensureRepositoryLink(
  tx: Tx,
  ctx: { now?: () => Date },
  projectRow: ProjectRow,
): Promise<RepositoryLinkRow | null> {
  if (!projectRow.repository || !projectRow.repositoryKey) return null;
  const now = clockNow(ctx);
  const current = await loadLink(tx, projectRow.id, { forUpdate: true });
  if (!current) {
    const connectionId = await chooseConnection(tx, projectRow);
    await tx
      .insert(repositoryLink)
      .values({
        workspaceId: projectRow.workspaceId,
        projectId: projectRow.id,
        repositoryKey: projectRow.repositoryKey,
        connectionId,
        webhookId: newWebhookId(),
        movesFrom: now,
      })
      .onConflictDoNothing({ target: repositoryLink.projectId });
    const made = await loadLink(tx, projectRow.id, { forUpdate: true });
    if (!made) throw new Error('repository link insert returned no row');
    return made.repositoryKey === projectRow.repositoryKey ? made : resetLink(tx, now, projectRow, made);
  }
  if (current.repositoryKey === projectRow.repositoryKey) return current;
  return resetLink(tx, now, projectRow, current);
}

async function resetLink(
  tx: Tx,
  now: Date,
  projectRow: ProjectRow,
  link: RepositoryLinkRow,
): Promise<RepositoryLinkRow> {
  // The requests belong to the old repository; their task links go with them (cascade).
  await tx.delete(pullRequest).where(eq(pullRequest.projectId, projectRow.id));
  const [row] = await tx
    .update(repositoryLink)
    .set({
      repositoryKey: projectRow.repositoryKey as string,
      connectionId: await chooseConnection(tx, projectRow),
      defaultBranch: null,
      webhookLastAt: null,
      webhookLastStatus: null,
      syncedAt: null,
      syncCursor: null,
      syncError: null,
      movesFrom: now,
    })
    .where(eq(repositoryLink.id, link.id))
    .returning();
  if (!row) throw new Error('repository link update returned no row');
  return row;
}

/**
 * M7: brings the project's link in line with its repository after the repository changed (the
 * project update calls it in its transaction): a new repository starts the row over, see
 * ensureRepositoryLink. Does nothing when the project has no link yet.
 */
export async function syncRepositoryLinkKey(
  tx: Tx,
  ctx: { now?: () => Date },
  projectRow: ProjectRow,
): Promise<void> {
  const link = await loadLink(tx, projectRow.id);
  if (!link || !projectRow.repositoryKey || link.repositoryKey === projectRow.repositoryKey) return;
  await ensureRepositoryLink(tx, ctx, projectRow);
}

/** The link row with its project, by id, for jobs and webhooks; null when it is gone. */
export async function loadLinkWithProject(
  db: DbOrTx,
  linkId: string,
): Promise<{ link: RepositoryLinkRow; project: ProjectRow } | null> {
  const [row] = await db
    .select({ link: repositoryLink, project })
    .from(repositoryLink)
    .innerJoin(
      project,
      and(eq(project.id, repositoryLink.projectId), eq(project.workspaceId, repositoryLink.workspaceId)),
    )
    .where(eq(repositoryLink.id, linkId))
    .limit(1);
  return row ?? null;
}

/** Locks the project of a link, then brings the link in line with its repository. */
export async function lockLink(
  tx: Tx,
  ctx: { now?: () => Date },
  linkId: string,
): Promise<{ link: RepositoryLinkRow | null; project: ProjectRow } | null> {
  const found = await loadLinkWithProject(tx, linkId);
  if (!found) return null;
  const [locked] = await tx
    .select()
    .from(project)
    .where(and(eq(project.id, found.project.id), eq(project.workspaceId, found.link.workspaceId)))
    .for('update');
  if (!locked) return null;
  return { link: await ensureRepositoryLink(tx, ctx, locked), project: locked };
}

// ---------------------------------------------------------------------------
// Reading through the link
// ---------------------------------------------------------------------------

/** How a link reads its repository: the adapter, the repository path and the host kind. */
export interface LinkReader {
  provider: GitProvider;
  kind: GitProviderName;
  /** The host the adapter calls. */
  host: string;
  path: string;
  /** False for a public read without a token. */
  withConnection: boolean;
}

/** Why a link cannot read: said on the Repository page as the sync error. */
export class LinkUnreadable extends Error {}

const LINK_A_CONNECTION = "Zamu can't read this repository: link a connection.";

/**
 * The adapter for a link: through its connection, else a public read with the host kind the host
 * name implies (or `kindHint`, the kind of a request address). LinkUnreadable when no kind is known.
 */
export async function readerFor(
  ctx: GitConnectionContext,
  link: Pick<RepositoryLinkRow, 'connectionId' | 'workspaceId'>,
  projectRow: ProjectRow,
  kindHint?: GitProviderName,
): Promise<LinkReader> {
  const repository = projectRepository(projectRow);
  if (!repository || !projectRow.repository) throw new LinkUnreadable('The project has no repository.');
  if (link.connectionId) {
    const { provider, connection } = await providerForConnection(ctx, link.connectionId, {
      workspaceId: link.workspaceId,
    });
    return {
      provider,
      kind: connection.provider,
      host: connection.host,
      path: repository.path,
      withConnection: true,
    };
  }
  const host = repositoryHost(projectRow.repository, repository);
  const kind = kindHint ?? providerForHost(host);
  if (!kind) {
    throw new LinkUnreadable(
      `Zamu can't tell which kind of host ${repository.host} is: link a connection for it.`,
    );
  }
  return {
    provider: publicProvider(ctx, kind, host),
    kind,
    host,
    path: repository.path,
    withConnection: false,
  };
}

/** A token-free sentence for a provider error while reading the link's repository; null for others. */
export function describeReadError(error: unknown, reader: LinkReader): string | null {
  if (!isGitProviderError(error)) return null;
  if (!reader.withConnection && (error.kind === 'unauthorized' || error.kind === 'not_found')) {
    return LINK_A_CONNECTION;
  }
  if (error.kind === 'not_found') {
    return `${reader.host} has no repository ${reader.path}, or the connection's token can't see it.`;
  }
  return describeProviderError(error, { provider: reader.kind, host: reader.host })?.detail ?? null;
}

// ---------------------------------------------------------------------------
// Settings
// ---------------------------------------------------------------------------

const EDIT_MESSAGE = 'Only owners and admins can change the repository settings of a project';

function canEdit(actor: Actor, projectRow: ProjectRow): boolean {
  return can(actor, 'project.defaults', { type: 'project', projectId: projectRow.id });
}

function assertCanEdit(actor: Actor, projectRow: ProjectRow): void {
  if (!canEdit(actor, projectRow)) throw new Forbidden(EDIT_MESSAGE);
}

function noRepository(projectRow: ProjectRow): Conflict {
  return new Conflict(`${projectRow.key} has no repository. Set one in the project settings first.`);
}

/** The next hourly check after `now` (repository.poll runs at :45). */
export function nextRepositoryCheckAt(now: Date): Date {
  const next = new Date(now);
  next.setUTCMinutes(REPOSITORY_POLL_CRON_MINUTE, 0, 0);
  if (next.getTime() <= now.getTime()) next.setUTCHours(next.getUTCHours() + 1);
  return next;
}

async function toSettings(
  ctx: RepositoryContext,
  db: DbOrTx,
  actor: Actor,
  projectRow: ProjectRow,
  link: RepositoryLinkRow | null,
): Promise<RepositorySettings> {
  const source = await loadBacklogSource(db, projectRow.id);
  const mirrored = sourceMirrors(source);
  const repository = projectRepository(projectRow);
  const live = repository !== null && link !== null;
  const [connection] =
    live && link.connectionId
      ? await db
          .select({
            id: gitConnection.id,
            name: gitConnection.name,
            provider: gitConnection.provider,
            host: gitConnection.host,
            status: gitConnection.status,
          })
          .from(gitConnection)
          .where(
            and(eq(gitConnection.id, link.connectionId), eq(gitConnection.workspaceId, actor.workspaceId)),
          )
          .limit(1)
      : [];
  const host = repository && projectRow.repository ? repositoryHost(projectRow.repository, repository) : null;
  return RepositorySettingsSchema.parse({
    project: { id: projectRow.id, key: projectRow.key, name: projectRow.name },
    repository: projectRow.repository,
    provider: connection?.provider ?? (host ? providerForHost(host) : null),
    connection: connection ?? null,
    defaultBranch: live ? link.defaultBranch : null,
    closeOnMerge: mirrored ? false : (link?.closeOnMerge ?? true),
    mirrored,
    webhook: live
      ? {
          url: repositoryWebhookUrl(ctx.publicUrl, link.webhookId),
          secretSet: link.webhookSecretCiphertext !== null,
          lastAt: link.webhookLastAt,
          lastStatus: link.webhookLastStatus,
          coveredByBacklog: mirrored && source !== null && source.webhookSecretCiphertext !== null,
        }
      : null,
    sync: {
      lastAt: live ? link.syncedAt : null,
      error: live ? link.syncError : null,
      nextAt: repository ? nextRepositoryCheckAt(clockNow(ctx)) : null,
    },
    canEdit: canEdit(actor, projectRow),
  });
}

/**
 * GET /projects/{project}/repository. Anyone who reads the project. Makes the link on first use
 * (or starts it over after a repository change); repository null is the "No repository" state.
 */
export async function getRepositorySettings(
  ctx: RepositoryContext,
  actor: Actor,
  input: z.input<typeof RepositoryProjectInput>,
): Promise<RepositorySettings> {
  const parsed = parseInput(RepositoryProjectInput, input);
  return ctx.db.transaction(async (tx) => {
    const projectRow = await findProjectByKey(tx, actor, parsed.project);
    const link = projectRow.repository
      ? await ensureRepositoryLink(tx, ctx, projectRow)
      : await loadLink(tx, projectRow.id);
    return toSettings(ctx, tx, actor, projectRow, link);
  });
}

/**
 * PATCH /projects/{project}/repository. Owners and admins. connectionId: a connection of the
 * workspace for the repository's host (Invalid for another host), or null for a public read; a
 * change restarts moves_from and queues a check. closeOnMerge: PROJECT_MIRRORED while the project
 * mirrors Backlog.md, whose files own the status. Conflict without a repository.
 */
export async function updateRepositorySettings(
  ctx: RepositoryContext,
  actor: Actor,
  input: z.input<typeof UpdateRepositoryInput>,
): Promise<RepositorySettings> {
  const parsed = parseInput(UpdateRepositoryInput, input);
  return ctx.db.transaction(async (tx) => {
    const projectRow = await findProjectByKey(tx, actor, parsed.project, { forUpdate: true });
    assertCanEdit(actor, projectRow);
    const repository = projectRepository(projectRow);
    const link = await ensureRepositoryLink(tx, ctx, projectRow);
    if (!link || !repository) throw noRepository(projectRow);
    const set: Partial<typeof repositoryLink.$inferInsert> = {};

    if (parsed.closeOnMerge !== undefined) {
      if (sourceMirrors(await loadBacklogSource(tx, projectRow.id))) {
        throw new ProjectMirrored(
          `${projectRow.key} mirrors Backlog.md: its files own the status, so a merge never moves a task.`,
        );
      }
      if (parsed.closeOnMerge !== link.closeOnMerge) set.closeOnMerge = parsed.closeOnMerge;
    }

    let connectionChanged = false;
    if (parsed.connectionId !== undefined && parsed.connectionId !== link.connectionId) {
      if (parsed.connectionId !== null) {
        const [connection] = await tx
          .select({ id: gitConnection.id, name: gitConnection.name, host: gitConnection.host })
          .from(gitConnection)
          .where(
            and(eq(gitConnection.id, parsed.connectionId), eq(gitConnection.workspaceId, actor.workspaceId)),
          )
          .limit(1);
        if (!connection) throw new NotFound('Git connection not found');
        if (!sameHost(connection.host, repository.host)) {
          const message = `${connection.name} reads ${connection.host}, but the repository is on ${repository.host}`;
          throw new Invalid(message, { issues: [{ path: 'connectionId', message }] });
        }
      }
      set.connectionId = parsed.connectionId;
      set.movesFrom = clockNow(ctx);
      set.syncError = null;
      connectionChanged = true;
    }

    let row = link;
    if (Object.keys(set).length > 0) {
      const [updated] = await tx
        .update(repositoryLink)
        .set(set)
        .where(eq(repositoryLink.id, link.id))
        .returning();
      if (!updated) throw new Error('repository link update returned no row');
      row = updated;
    }
    // A new connection reads at once (without moving anything: see moves_from).
    if (connectionChanged && ctx.jobs) await enqueueRepositorySync(ctx, tx, row.id);
    return toSettings(ctx, tx, actor, projectRow, row);
  });
}

/**
 * POST /projects/{project}/repository/webhook-secret. Owners and admins. A new random secret,
 * stored encrypted; deliveries signed with the old one fail from now on. The URL stays. Returns
 * the secret once. EncryptionKeyMissing without APP_ENCRYPTION_KEY; Conflict without a repository.
 */
export async function newRepositoryWebhookSecret(
  ctx: RepositoryContext,
  actor: Actor,
  input: z.input<typeof RepositoryProjectInput>,
): Promise<RepositoryWebhookSecret> {
  const parsed = parseInput(RepositoryProjectInput, input);
  return ctx.db.transaction(async (tx) => {
    const projectRow = await findProjectByKey(tx, actor, parsed.project, { forUpdate: true });
    assertCanEdit(actor, projectRow);
    const link = await ensureRepositoryLink(tx, ctx, projectRow);
    if (!link) throw noRepository(projectRow);
    if (!isEncryptionReady(ctx)) throw new EncryptionKeyMissing();
    const secret = randomBytes(32).toString('base64url');
    await tx
      .update(repositoryLink)
      .set({ webhookSecretCiphertext: encryptSecret(ctx, secret) })
      .where(eq(repositoryLink.id, link.id));
    return { url: repositoryWebhookUrl(ctx.publicUrl, link.webhookId), secret };
  });
}

/** Queues a check of one link (stately: at most one queued per link). Null when one is queued. */
export async function enqueueRepositorySync(
  ctx: { jobs?: JobQueue },
  tx: Tx,
  linkId: string,
): Promise<string | null> {
  if (!ctx.jobs) throw new Error('Repository checks need the job queue in the core context');
  return ctx.jobs.enqueue(tx, REPOSITORY_SYNC, { linkId }, { singletonKey: linkId });
}

/**
 * POST /projects/{project}/repository/sync ("Check now"). Owners and admins. Queues the check now;
 * a check already queued counts. Conflict without a repository.
 */
export async function syncRepositoryNow(
  ctx: RepositoryContext,
  actor: Actor,
  input: z.input<typeof RepositoryProjectInput>,
): Promise<void> {
  const parsed = parseInput(RepositoryProjectInput, input);
  await ctx.db.transaction(async (tx) => {
    const projectRow = await findProjectByKey(tx, actor, parsed.project, { forUpdate: true });
    assertCanEdit(actor, projectRow);
    const link = await ensureRepositoryLink(tx, ctx, projectRow);
    if (!link) throw noRepository(projectRow);
    await enqueueRepositorySync(ctx, tx, link.id);
  });
}

// ---------------------------------------------------------------------------
// The hourly check
// ---------------------------------------------------------------------------

export interface RepositorySyncResult {
  status: 'synced' | 'failed' | 'skipped';
  /** Requests the host listed. */
  read: number;
  /** Requests stored (the rest were older than what Zamu had). */
  applied: number;
  /** Whether request events moved tasks: false for the first check after setup or a new connection. */
  live: boolean;
  error: string | null;
}

/**
 * Why a link has no reader, as a sentence for the page: no known host kind, a connection gone, or
 * a token that can't be decrypted (their messages carry no secret). Null for anything else.
 */
export function readerFailure(error: unknown): string | null {
  if (error instanceof LinkUnreadable) return error.message;
  if (error instanceof NotFound) return LINK_A_CONNECTION;
  if (error instanceof EncryptionKeyMissing || error instanceof SecretUnreadable) return error.message;
  return null;
}

async function storeSyncError(ctx: RepositoryJobContext, linkId: string, error: string): Promise<void> {
  await ctx.db.update(repositoryLink).set({ syncError: error }).where(eq(repositoryLink.id, linkId));
}

/**
 * repository.sync: reads the default branch and the requests updated since the newest update the
 * last check read, minus 10 minutes (the first check: the open requests and those updated in the
 * last 7 days), at most 100, and applies each, oldest first, like a webhook event. The first check
 * after the link was made or its connection changed moves no task. Provider errors are stored on
 * the link as a token-free sentence and end the check; nothing else pauses.
 */
export async function syncRepository(
  ctx: RepositoryJobContext,
  linkId: string,
): Promise<RepositorySyncResult> {
  const skipped: RepositorySyncResult = { status: 'skipped', read: 0, applied: 0, live: false, error: null };
  const prepared = await ctx.db.transaction((tx) => lockLink(tx, ctx, linkId));
  if (!prepared?.link) return skipped;
  const { project: projectRow } = prepared;
  const link = prepared.link;
  const now = clockNow(ctx);

  let reader: LinkReader;
  try {
    // Without a connection: the kind the host name implies, else the kind of a stored request.
    const repository = projectRepository(projectRow);
    const named =
      repository && projectRow.repository
        ? providerForHost(repositoryHost(projectRow.repository, repository))
        : null;
    reader = await readerFor(ctx, link, projectRow, named ?? (await storedRequestKind(ctx.db, link)));
  } catch (error) {
    const message = readerFailure(error);
    if (message === null) throw error;
    await storeSyncError(ctx, link.id, message);
    return { ...skipped, status: 'failed', error: message };
  }
  if (!reader.provider.listRequestsUpdatedSince) {
    const message = `Zamu can't list the requests of ${reader.host}.`;
    await storeSyncError(ctx, link.id, message);
    return { ...skipped, status: 'failed', error: message };
  }

  const first = link.syncCursor === null;
  const since = link.syncCursor ? new Date(link.syncCursor.getTime() - SYNC_OVERLAP_MS) : null;
  let defaultBranch: string;
  let requests: RequestInfo[];
  try {
    defaultBranch = (await reader.provider.getRepository(reader.path)).defaultBranch;
    requests = await reader.provider.listRequestsUpdatedSince(reader.path, since, MAX_UPDATED_REQUESTS);
  } catch (error) {
    const message = describeReadError(error, reader);
    if (message === null) throw error;
    await storeSyncError(ctx, link.id, message);
    return { ...skipped, status: 'failed', error: message };
  }
  if (first) {
    const from = now.getTime() - FIRST_SYNC_DAYS * 86_400_000;
    requests = requests.filter(
      (request) =>
        request.state === 'open' || request.state === 'draft' || Date.parse(request.updatedAt) >= from,
    );
  }

  // Hosts leave who merged out of their request lists (GitHub, Forgejo): read those requests one by
  // one, a few per check, so history can say "merged by …". A failed read keeps the list's version.
  if (reader.provider.getRequest) {
    const unnamed = requests.filter((request) => request.state === 'merged' && request.mergedBy === null);
    for (const request of unnamed.slice(0, MERGED_BY_READS_PER_SYNC)) {
      const full = await reader.provider.getRequest(reader.path, request.number).catch(() => null);
      if (full?.mergedBy) request.mergedBy = full.mergedBy;
    }
  }

  const live = link.syncedAt !== null && link.syncedAt.getTime() >= link.movesFrom.getTime();
  let applied = 0;
  let cursor = link.syncCursor;
  const ordered = [...requests].sort(
    (a, b) => Date.parse(a.updatedAt) - Date.parse(b.updatedAt) || a.number - b.number,
  );
  for (const request of ordered) {
    const result = await ctx.db.transaction(async (tx) => {
      const locked = await lockLink(tx, ctx, link.id);
      // The repository changed during the check: what was read belongs to the old one.
      if (!locked?.link || locked.link.repositoryKey !== link.repositoryKey) return null;
      return applyRequest(tx, ctx, { ...locked.link, defaultBranch }, request, { live });
    });
    if (result === null) return skipped;
    if (result.applied) applied += 1;
    const updated = new Date(request.updatedAt);
    if (!cursor || updated > cursor) cursor = updated;
  }

  await ctx.db
    .update(repositoryLink)
    .set({ defaultBranch, syncedAt: now, syncCursor: cursor ?? now, syncError: null })
    .where(and(eq(repositoryLink.id, link.id), eq(repositoryLink.repositoryKey, link.repositoryKey)));
  return { status: 'synced', read: requests.length, applied, live, error: null };
}

/** The host kind of a request Zamu stored for the link's project, to read a public host by it. */
async function storedRequestKind(
  db: DbOrTx,
  link: Pick<RepositoryLinkRow, 'projectId' | 'connectionId'>,
): Promise<GitProviderName | undefined> {
  if (link.connectionId) return undefined;
  const [row] = await db
    .select({ webUrl: pullRequest.webUrl })
    .from(pullRequest)
    .where(eq(pullRequest.projectId, link.projectId))
    .orderBy(asc(pullRequest.number))
    .limit(1);
  return row ? requestProvider(row.webUrl) : undefined;
}

/**
 * repository.poll: makes the link of every project with a repository that has none yet, then
 * queues a check for every link whose project has a repository. One transaction. `workspaceIds`
 * narrows it to those workspaces (tests and scripts); the job reads them all.
 */
export async function pollRepositories(
  ctx: RepositoryJobContext,
  options: { workspaceIds?: string[] } = {},
): Promise<{ enqueued: number; created: number }> {
  const scope = options.workspaceIds ? inArray(project.workspaceId, options.workspaceIds) : undefined;
  return ctx.db.transaction(async (tx) => {
    const missing = await tx
      .select()
      .from(project)
      .where(
        and(
          scope,
          isNotNull(project.repository),
          notExists(
            tx
              .select({ id: repositoryLink.id })
              .from(repositoryLink)
              .where(eq(repositoryLink.projectId, project.id)),
          ),
        ),
      )
      .orderBy(asc(project.id));
    for (const row of missing) await ensureRepositoryLink(tx, ctx, row);
    const links = await tx
      .select({ id: repositoryLink.id })
      .from(repositoryLink)
      .innerJoin(project, eq(project.id, repositoryLink.projectId))
      .where(and(scope, isNotNull(project.repositoryKey)))
      .orderBy(asc(repositoryLink.id));
    let enqueued = 0;
    for (const link of links) if (await enqueueRepositorySync(ctx, tx, link.id)) enqueued += 1;
    return { enqueued, created: missing.length };
  });
}
