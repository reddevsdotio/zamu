// Git connections: a workspace's access tokens for GitHub, GitLab and Gitea/Forgejo hosts. Projects
// read Backlog.md folders through them. Tokens are encrypted at rest (secrets.ts) and never leave
// the server: not in results, errors, logs or activity. Saving a token tests it first.
//
// Rules (M3 plan, section 5 "Connections and secrets" and "Authorization (additions)"):
// - Everyone in the workspace lists connections (without tokens). Owners and admins add, change,
//   test and delete them (connection.manage).
// - The host must resolve to a public address unless GIT_ALLOW_PRIVATE_HOSTS is on; link-local and
//   metadata addresses are always refused. GIT_HTTP_HOSTS hosts are reached over plain HTTP.
// - A rejected or unreachable check pauses the mirrors that use the connection; a later working
//   check resumes them. Deleting a connection pauses its mirrors in the same transaction.
// - M7: repository links read requests through a connection too. Deleting it leaves them with
//   none (a public read) and restarts their moves_from; a failed check shows on their Repository
//   page as the sync error, and a working one clears it.
import {
  CreateGitConnectionInput,
  DeleteGitConnectionInput,
  type GitConnection,
  type GitConnectionDeleted,
  type GitConnectionList,
  GitConnection as GitConnectionSchema,
  type GitConnectionStatus,
  type GitConnectionTestResult,
  GitConnectionTestResult as GitConnectionTestResultSchema,
  type GitConnectionUse,
  type GitProvider as GitProviderName,
  type ProjectRef,
  TestGitConnectionInput,
  UpdateGitConnectionInput,
} from '@zamu/contracts';
import { type DbOrTx, schema } from '@zamu/db';
import {
  createProvider,
  deriveApiBaseUrl,
  type GitProvider,
  type GitProviderError,
  hostnameOf,
  isAllowedHost,
  isGitProviderError,
  type LookupFn,
  normalizeHost,
} from '@zamu/git-providers';
import { and, asc, eq, inArray, isNotNull, ne, notInArray, sql } from 'drizzle-orm';
import { type Actor, authorize } from './authz';
// Runtime-only cycle: backlog/refresh imports this module too; both use each other inside functions.
import { enqueueBacklogRefreshes } from './backlog/refresh';
import type { GitContext, ProviderFactory } from './context';
import { Conflict, Invalid, isUniqueViolation, NotFound, parseInput } from './errors';
import { loadUsers, userRef } from './internal';
import type { JobQueue } from './jobs';
import { decryptSecret, EncryptionKeyMissing, encryptSecret, isEncryptionReady } from './secrets';

const { backlogSource, gitConnection, project, repositoryLink } = schema;

const NAME_UNIQUE = 'git_connection_workspaceId_name_unique';

export type GitConnectionRow = typeof gitConnection.$inferSelect;

/** Statuses a check can end in. */
export type GitCheckStatus = Exclude<GitConnectionStatus, 'unchecked'>;

/**
 * GitContext plus a DNS resolver override for the host safety check, so tests do not depend on
 * DNS. Production leaves it unset (system resolver).
 */
export interface GitConnectionContext extends GitContext {
  hostLookup?: LookupFn;
  /** Producer for refresh jobs: mirrors a working check resumes get a refresh right away. */
  jobs?: JobQueue;
}

// ---------------------------------------------------------------------------
// Configuration
// ---------------------------------------------------------------------------

/**
 * GIT_ALLOW_PRIVATE_HOSTS and GIT_HTTP_HOSTS as GitContext.gitHosts. The web server and the worker
 * call this at startup (next to loadEncryptionKey). Throws on values it cannot read.
 */
export function loadGitHosts(env: {
  GIT_ALLOW_PRIVATE_HOSTS?: string | undefined;
  GIT_HTTP_HOSTS?: string | undefined;
}): { allowPrivate: boolean; httpHosts: string[] } {
  const flag = env.GIT_ALLOW_PRIVATE_HOSTS?.trim().toLowerCase() ?? '';
  let allowPrivate: boolean;
  if (['', 'false', '0', 'no', 'off'].includes(flag)) allowPrivate = false;
  else if (['true', '1', 'yes', 'on'].includes(flag)) allowPrivate = true;
  else throw new Error('GIT_ALLOW_PRIVATE_HOSTS must be true or false');

  const httpHosts: string[] = [];
  for (const entry of (env.GIT_HTTP_HOSTS ?? '').split(',')) {
    if (!entry.trim()) continue;
    const host = normalizeHost(entry);
    if (!host) throw new Error(`GIT_HTTP_HOSTS: "${entry.trim()}" is not a host name`);
    httpHosts.push(host);
  }
  return { allowPrivate, httpHosts };
}

/** Whether `host` is reached over plain HTTP (listed in GIT_HTTP_HOSTS with or without its port). */
function usesHttp(ctx: GitContext, host: string): boolean {
  const listed = (ctx.gitHosts?.httpHosts ?? []).map((entry) => normalizeHost(entry));
  return listed.includes(host) || listed.includes(hostnameOf(host));
}

function factoryOf(ctx: GitContext): ProviderFactory {
  return ctx.providerFactory ?? createProvider;
}

function nowOf(ctx: GitContext): Date {
  return ctx.now?.() ?? new Date();
}

/**
 * M7: the adapter for a public repository, without a token, with the context's host policy and
 * HTTP for GIT_HTTP_HOSTS. Repository links without a connection read through it.
 */
export function publicProvider(
  ctx: GitConnectionContext,
  provider: GitProviderName,
  host: string,
): GitProvider {
  return buildProvider(ctx, provider, host, '');
}

/** Builds the adapter for a host and token with the context's host policy. */
function buildProvider(
  ctx: GitConnectionContext,
  provider: GitProviderName,
  host: string,
  token: string,
): GitProvider {
  return factoryOf(ctx)({
    provider,
    host,
    token,
    allowHttp: usesHttp(ctx, host),
    hostPolicy: {
      allowPrivate: ctx.gitHosts?.allowPrivate ?? false,
      ...((ctx.hostLookup ?? ctx.gitHosts?.lookup) ? { lookup: ctx.hostLookup ?? ctx.gitHosts?.lookup } : {}),
    },
  });
}

// ---------------------------------------------------------------------------
// Key
// ---------------------------------------------------------------------------

function requireKey(ctx: GitContext): void {
  if (!isEncryptionReady(ctx)) throw new EncryptionKeyMissing();
}

// ---------------------------------------------------------------------------
// Checks: host safety, whoami, error descriptions
// ---------------------------------------------------------------------------

const PROVIDER_LABELS: Record<GitProviderName, string> = {
  github: 'GitHub',
  gitlab: 'GitLab',
  gitea: 'Gitea/Forgejo',
};

const SCOPE_HINTS: Record<GitProviderName, string> = {
  github: 'read access to repository contents',
  gitlab: 'the read_api scope',
  gitea: 'the read:user and read:repository scopes',
};

export interface ConnectionFailure {
  status: 'rejected' | 'unreachable';
  /** Short, token-free reason, written here (never copied from a provider response). */
  detail: string;
}

/**
 * The connection status and a short reason for a provider error, or null for anything that is
 * not a GitProviderError. Messages are written here and carry no token.
 */
export function describeProviderError(
  error: unknown,
  connection: { provider: GitProviderName; host: string },
): ConnectionFailure | null {
  if (!isGitProviderError(error)) return null;
  const { host, provider } = connection;
  const label = PROVIDER_LABELS[provider];
  const e = error as GitProviderError;
  switch (e.kind) {
    case 'unauthorized':
      if (e.code === 'forbidden' || e.status === 403) {
        return {
          status: 'rejected',
          detail: `${host} answered 403. The token has no access; it needs ${SCOPE_HINTS[provider]}.`,
        };
      }
      return {
        status: 'rejected',
        detail: `${host} answered ${e.status ?? 401}. The token may have expired or been revoked, or it lacks ${SCOPE_HINTS[provider]}.`,
      };
    case 'host_refused':
      // GitHostRefused messages come from the host check: host name and address only.
      return { status: 'unreachable', detail: e.message };
    case 'rate_limited':
      return { status: 'unreachable', detail: `${host} asked to slow down. Try again later.` };
    case 'unreachable':
      if (e.code === 'timeout') return { status: 'unreachable', detail: `${host} did not answer in time.` };
      if (e.status) return { status: 'unreachable', detail: `${host} answered ${e.status}.` };
      return {
        status: 'unreachable',
        detail: e.code ? `Could not reach ${host} (${e.code}).` : `Could not reach ${host}.`,
      };
    case 'not_found':
      return {
        status: 'unreachable',
        detail: `${host} has no ${label} API where it was expected. Check the provider and the host.`,
      };
    case 'unexpected':
      return {
        status: 'unreachable',
        detail: `${host} answered in a way the ${label} API does not. Check the provider and the host.`,
      };
  }
}

/**
 * Whether a provider error during a refresh means the connection itself is at fault (token
 * rejected, host unreachable or refused), so its mirrors pause. A missing repository or file does
 * not: that fails the one refresh.
 */
export function pausesConnection(error: unknown): boolean {
  return isGitProviderError(error) && ['unauthorized', 'unreachable', 'host_refused'].includes(error.kind);
}

interface CheckResult {
  status: GitCheckStatus;
  login: string | null;
  repoCount: number | null;
  detail: string | null;
  /** Normalised host and the API base URL derived for it. */
  host: string;
  apiBaseUrl: string;
}

/** Host safety check, then whoami. Never throws for provider errors; Invalid for a bad host. */
async function runCheck(
  ctx: GitConnectionContext,
  provider: GitProviderName,
  hostInput: string,
  token: string,
): Promise<CheckResult> {
  const host = normalizeHost(hostInput);
  if (!host)
    throw new Invalid('Not a valid host', { issues: [{ path: 'host', message: 'Not a valid host name' }] });
  const apiBaseUrl = deriveApiBaseUrl(provider, host, { allowHttp: usesHttp(ctx, host) });
  const base = { host, apiBaseUrl, login: null, repoCount: null };

  const check = await isAllowedHost(host, {
    allowPrivate: ctx.gitHosts?.allowPrivate ?? false,
    httpHosts: ctx.gitHosts?.httpHosts ?? [],
    ...((ctx.hostLookup ?? ctx.gitHosts?.lookup) ? { lookup: ctx.hostLookup ?? ctx.gitHosts?.lookup } : {}),
  });
  if (!check.ok) return { ...base, status: 'unreachable', detail: check.message };

  try {
    const who = await buildProvider(ctx, provider, host, token).whoami();
    return { ...base, status: 'working', login: who.login, repoCount: who.repoCount ?? null, detail: null };
  } catch (error) {
    const failure = describeProviderError(error, { provider, host });
    if (!failure) throw error;
    return { ...base, ...failure };
  }
}

function toTestResult(check: CheckResult, checkedAt: Date): GitConnectionTestResult {
  return GitConnectionTestResultSchema.parse({
    status: check.status,
    login: check.login,
    repoCount: check.repoCount,
    detail: check.detail,
    checkedAt,
  });
}

/** Invalid for a failed check on save: nothing is stored. */
function checkFailed(check: CheckResult): Invalid {
  const detail = check.detail ?? 'The check failed.';
  const path = check.status === 'rejected' ? 'token' : 'host';
  return new Invalid(`${detail} Nothing was saved.`, { issues: [{ path, message: detail }] });
}

/** Last 3 characters of the token, for recognition. Short tokens get none. */
function tokenHint(token: string): string {
  return token.length >= 12 ? token.slice(-3) : '';
}

// ---------------------------------------------------------------------------
// Reading
// ---------------------------------------------------------------------------

async function findConnection(
  db: DbOrTx,
  workspaceId: string,
  id: string,
  options: { forUpdate?: boolean } = {},
): Promise<GitConnectionRow> {
  const query = db
    .select()
    .from(gitConnection)
    .where(and(eq(gitConnection.id, id), eq(gitConnection.workspaceId, workspaceId)))
    .limit(1);
  const [row] = options.forUpdate ? await query.for('update') : await query;
  if (!row) throw new NotFound('Git connection not found');
  return row;
}

/** Projects with a non-detached Backlog.md source on each connection, by project key. */
async function usesOf(db: DbOrTx, connectionIds: string[]): Promise<Map<string, GitConnectionUse[]>> {
  const uses = new Map<string, GitConnectionUse[]>();
  if (connectionIds.length === 0) return uses;
  const rows = await db
    .select({
      connectionId: backlogSource.connectionId,
      state: backlogSource.state,
      id: project.id,
      key: project.key,
      name: project.name,
    })
    .from(backlogSource)
    .innerJoin(project, eq(project.id, backlogSource.projectId))
    .where(and(inArray(backlogSource.connectionId, connectionIds), ne(backlogSource.state, 'detached')))
    .orderBy(asc(project.key));
  for (const row of rows) {
    if (!row.connectionId) continue;
    const list = uses.get(row.connectionId) ?? [];
    list.push({ id: row.id, key: row.key, name: row.name, paused: row.state === 'paused' });
    uses.set(row.connectionId, list);
  }
  return uses;
}

async function toConnections(db: DbOrTx, rows: GitConnectionRow[]): Promise<GitConnection[]> {
  const [uses, users] = await Promise.all([
    usesOf(
      db,
      rows.map((row) => row.id),
    ),
    loadUsers(
      db,
      rows.map((row) => row.createdById),
    ),
  ]);
  return rows.flatMap((row) => {
    const creator = users.get(row.createdById);
    if (!creator) return [];
    return [
      GitConnectionSchema.parse({
        id: row.id,
        name: row.name,
        provider: row.provider,
        host: row.host,
        status: row.status,
        apiBaseUrl: row.apiBaseUrl,
        tokenHint: row.tokenHint,
        checkedAt: row.checkedAt,
        checkedLogin: row.checkedLogin,
        checkedDetail: row.checkedDetail,
        usedBy: uses.get(row.id) ?? [],
        createdBy: userRef(creator),
        createdAt: row.createdAt,
        updatedAt: row.updatedAt,
      }),
    ];
  });
}

async function connectionById(db: DbOrTx, workspaceId: string, id: string): Promise<GitConnection> {
  const [connection] = await toConnections(db, [await findConnection(db, workspaceId, id)]);
  if (!connection) throw new NotFound('Git connection not found');
  return connection;
}

/** Every connection in the workspace, by name, without tokens. Any member may list them. */
export async function listConnections(ctx: GitContext, actor: Actor): Promise<GitConnectionList> {
  // Sequential: the second query reads rows of the first, and `ctx.db` may be a transaction.
  const rows = await ctx.db
    .select()
    .from(gitConnection)
    .where(eq(gitConnection.workspaceId, actor.workspaceId))
    .orderBy(asc(sql`lower(${gitConnection.name})`), asc(gitConnection.id));
  return { items: await toConnections(ctx.db, rows), encryptionReady: isEncryptionReady(ctx) };
}

/** One connection without its token. Any member may read it. */
export async function getConnection(ctx: GitContext, actor: Actor, id: string): Promise<GitConnection> {
  return connectionById(ctx.db, actor.workspaceId, id);
}

// ---------------------------------------------------------------------------
// Writing
// ---------------------------------------------------------------------------

function nameTaken(name: string): Conflict {
  return new Conflict(`A git connection named "${name}" already exists in this workspace`);
}

/**
 * Tests the token, then saves the connection with the encrypted token and the check result.
 * A token that does not work saves nothing (Invalid, with the reason on the token or host field).
 */
export async function createConnection(
  ctx: GitConnectionContext,
  actor: Actor,
  input: CreateGitConnectionInput,
): Promise<GitConnection> {
  authorize(actor, 'connection.manage');
  const parsed = parseInput(CreateGitConnectionInput, input);
  requireKey(ctx);

  const check = await runCheck(ctx, parsed.provider, parsed.host, parsed.token);
  if (check.status !== 'working') throw checkFailed(check);

  try {
    const [row] = await ctx.db
      .insert(gitConnection)
      .values({
        workspaceId: actor.workspaceId,
        name: parsed.name,
        provider: parsed.provider,
        host: check.host,
        apiBaseUrl: check.apiBaseUrl,
        tokenCiphertext: encryptSecret(ctx, parsed.token),
        tokenHint: tokenHint(parsed.token),
        status: 'working',
        checkedAt: nowOf(ctx),
        checkedLogin: check.login,
        checkedDetail: null,
        createdById: actor.userId,
      })
      .returning({ id: gitConnection.id });
    if (!row) throw new Error('git connection insert failed');
    return connectionById(ctx.db, actor.workspaceId, row.id);
  } catch (error) {
    if (isUniqueViolation(error, NAME_UNIQUE)) throw nameTaken(parsed.name);
    throw error;
  }
}

/**
 * Renames a connection and/or replaces its token. A new token is tested first and saved only when
 * it works; it then resumes mirrors paused by an earlier failed check.
 */
export async function updateConnection(
  ctx: GitConnectionContext,
  actor: Actor,
  input: UpdateGitConnectionInput,
): Promise<GitConnection> {
  authorize(actor, 'connection.manage');
  const parsed = parseInput(UpdateGitConnectionInput, input);
  const current = await findConnection(ctx.db, actor.workspaceId, parsed.id);

  let check: CheckResult | null = null;
  if (parsed.token !== undefined) {
    requireKey(ctx);
    check = await runCheck(ctx, current.provider, current.host, parsed.token);
    if (check.status !== 'working') throw checkFailed(check);
  }
  const token = parsed.token;

  try {
    await ctx.db.transaction(async (tx) => {
      await findConnection(tx, actor.workspaceId, parsed.id, { forUpdate: true });
      const values: Partial<typeof gitConnection.$inferInsert> = {};
      if (parsed.name !== undefined) values.name = parsed.name;
      if (token !== undefined) {
        values.tokenCiphertext = encryptSecret(ctx, token);
        values.tokenHint = tokenHint(token);
      }
      await tx.update(gitConnection).set(values).where(eq(gitConnection.id, parsed.id));
      if (check) {
        const change = await markConnectionStatus(tx, parsed.id, 'working', null, {
          now: nowOf(ctx),
          login: check.login,
        });
        // Without a queue (tests, scripts) the hourly poll picks the resumed mirrors up.
        if (ctx.jobs) await enqueueBacklogRefreshes(ctx, tx, change.resumedSourceIds, 'manual');
      }
    });
  } catch (error) {
    if (parsed.name !== undefined && isUniqueViolation(error, NAME_UNIQUE)) throw nameTaken(parsed.name);
    throw error;
  }
  return connectionById(ctx.db, actor.workspaceId, parsed.id);
}

/**
 * Deletes a connection. Mirrors that used it pause in the same transaction (their source keeps
 * the project, with no connection) and are returned so the UI can name them.
 */
export async function deleteConnection(
  ctx: GitContext,
  actor: Actor,
  input: DeleteGitConnectionInput,
): Promise<GitConnectionDeleted> {
  authorize(actor, 'connection.manage');
  const parsed = parseInput(DeleteGitConnectionInput, input);
  return ctx.db.transaction(async (tx) => {
    const row = await findConnection(tx, actor.workspaceId, parsed.id, { forUpdate: true });
    const affected = await tx
      .select({ sourceId: backlogSource.id, id: project.id, key: project.key, name: project.name })
      .from(backlogSource)
      .innerJoin(project, eq(project.id, backlogSource.projectId))
      .where(and(eq(backlogSource.connectionId, row.id), ne(backlogSource.state, 'detached')))
      .orderBy(asc(project.key))
      .for('update', { of: backlogSource });
    if (affected.length > 0) {
      await tx
        .update(backlogSource)
        .set({
          state: 'paused',
          lastError: `The git connection "${row.name}" was deleted. Pick another connection in the project settings.`,
        })
        .where(
          inArray(
            backlogSource.id,
            affected.map((source) => source.sourceId),
          ),
        );
    }
    // M7: repository links read a public repository from now on, and requests seen before the
    // change move nothing (moves_from). The foreign key would clear connection_id on its own.
    await tx
      .update(repositoryLink)
      .set({ connectionId: null, movesFrom: nowOf(ctx), syncError: null })
      .where(and(eq(repositoryLink.connectionId, row.id), eq(repositoryLink.workspaceId, actor.workspaceId)));
    // connection_id of Backlog.md sources is set null by the foreign key.
    await tx.delete(gitConnection).where(eq(gitConnection.id, row.id));
    const pausedProjects: ProjectRef[] = affected.map(({ id, key, name }) => ({ id, key, name }));
    return { id: row.id, pausedProjects };
  });
}

/**
 * Tests a token: an unsaved one (add dialog), a saved connection, or a saved connection with a
 * replacement token (edit dialog). Only the plain saved-connection test stores its result, and a
 * stored result pauses or resumes the connection's mirrors.
 */
export async function testConnection(
  ctx: GitConnectionContext,
  actor: Actor,
  input: TestGitConnectionInput,
): Promise<GitConnectionTestResult> {
  authorize(actor, 'connection.manage');
  const parsed = parseInput(TestGitConnectionInput, input);

  if ('provider' in parsed) {
    const check = await runCheck(ctx, parsed.provider, parsed.host, parsed.token);
    return toTestResult(check, nowOf(ctx));
  }

  requireKey(ctx);
  const row = await findConnection(ctx.db, actor.workspaceId, parsed.id);
  if (parsed.token !== undefined) {
    const check = await runCheck(ctx, row.provider, row.host, parsed.token);
    return toTestResult(check, nowOf(ctx));
  }

  const check = await runCheck(ctx, row.provider, row.host, decryptSecret(ctx, row.tokenCiphertext));
  const checkedAt = nowOf(ctx);
  await ctx.db.transaction(async (tx) => {
    const change = await markConnectionStatus(tx, row.id, check.status, check.detail, {
      now: checkedAt,
      login: check.login,
    });
    // Without a queue (tests, scripts) the hourly poll picks the resumed mirrors up.
    if (ctx.jobs) await enqueueBacklogRefreshes(ctx, tx, change.resumedSourceIds, 'manual');
  });
  return toTestResult(check, checkedAt);
}

// ---------------------------------------------------------------------------
// For the Backlog.md engine (M3-06)
// ---------------------------------------------------------------------------

/**
 * The adapter for a saved connection, with its decrypted token, the host policy and HTTP for
 * GIT_HTTP_HOSTS. NotFound for a missing connection (or one outside `workspaceId` when given);
 * EncryptionKeyMissing without a key; SecretUnreadable when the token does not decrypt.
 */
export async function providerForConnection(
  ctx: GitConnectionContext,
  connectionId: string,
  options: { db?: DbOrTx; workspaceId?: string } = {},
): Promise<{ provider: GitProvider; connection: GitConnectionRow }> {
  requireKey(ctx);
  const db = options.db ?? ctx.db;
  const [connection] = await db
    .select()
    .from(gitConnection)
    .where(
      and(
        eq(gitConnection.id, connectionId),
        options.workspaceId ? eq(gitConnection.workspaceId, options.workspaceId) : undefined,
      ),
    )
    .limit(1);
  if (!connection) throw new NotFound('Git connection not found');
  const token = decryptSecret(ctx, connection.tokenCiphertext);
  return { provider: buildProvider(ctx, connection.provider, connection.host, token), connection };
}

/** What markConnectionStatus changed on the connection's Backlog.md sources. */
export interface ConnectionStatusChange {
  /** Sources that paused now (they were not paused or detached before). */
  pausedSourceIds: string[];
  /** Sources that were paused and resume now: a working check. */
  resumedSourceIds: string[];
}

/**
 * Records a check result on a connection: status, checked_at, detail (and login when given).
 * rejected and unreachable pause every mirror on the connection that is not paused or detached.
 * working resumes the paused ones whose project still has a repository, back to healthy or
 * warnings after a read, setup before the first. Callers enqueue refreshes for resumed sources.
 * M7: a failed check also becomes the sync error of the repository links reading through the
 * connection; a working check clears that error. Run it inside the caller's transaction.
 */
export async function markConnectionStatus(
  tx: DbOrTx,
  connectionId: string,
  status: GitCheckStatus,
  detail?: string | null,
  options: { now?: Date; login?: string | null } = {},
): Promise<ConnectionStatusChange> {
  const [connection] = await tx
    .update(gitConnection)
    .set({
      status,
      checkedAt: options.now ?? new Date(),
      checkedDetail: status === 'working' ? null : (detail ?? null),
      ...(options.login !== undefined && status === 'working' ? { checkedLogin: options.login } : {}),
    })
    .where(eq(gitConnection.id, connectionId))
    .returning({ name: gitConnection.name });
  if (!connection) throw new NotFound('Git connection not found');

  if (status !== 'working') {
    const label = status === 'rejected' ? 'rejected its token' : 'could not reach its host';
    // M7: the Repository page of every project reading through it says so until a check works.
    await tx
      .update(repositoryLink)
      .set({ syncError: `The git connection "${connection.name}" ${label}${detail ? `: ${detail}` : '.'}` })
      .where(eq(repositoryLink.connectionId, connectionId));
    const paused = await tx
      .update(backlogSource)
      .set({
        state: 'paused',
        lastError: `The git connection "${connection.name}" ${label}${detail ? `: ${detail}` : '.'}`,
      })
      .where(
        and(
          eq(backlogSource.connectionId, connectionId),
          notInArray(backlogSource.state, ['paused', 'detached']),
        ),
      )
      .returning({ id: backlogSource.id });
    return { pausedSourceIds: paused.map((row) => row.id), resumedSourceIds: [] };
  }

  // M7: clear the failed check from the Repository pages; the next sync reports its own result.
  await tx
    .update(repositoryLink)
    .set({ syncError: null })
    .where(
      and(
        eq(repositoryLink.connectionId, connectionId),
        sql`starts_with(${repositoryLink.syncError}, ${`The git connection "${connection.name}" `})`,
      ),
    );

  const resumable = tx
    .select({ id: backlogSource.id })
    .from(backlogSource)
    .innerJoin(project, eq(project.id, backlogSource.projectId))
    .where(
      and(
        eq(backlogSource.connectionId, connectionId),
        eq(backlogSource.state, 'paused'),
        isNotNull(project.repository),
      ),
    );
  const resumed = await tx
    .update(backlogSource)
    .set({
      state: sql`case
        when ${backlogSource.lastReadCommit} is null then 'setup'
        when jsonb_array_length(${backlogSource.warnings}) > 0 then 'warnings'
        else 'healthy' end`,
      lastError: null,
    })
    .where(inArray(backlogSource.id, resumable))
    .returning({ id: backlogSource.id });
  return { pausedSourceIds: [], resumedSourceIds: resumed.map((row) => row.id) };
}
