// Backlog.md settings of a project: mappings, folder, connection, Refresh now (web) and refresh
// requests from the API (zamu backlog refresh), webhook info, a new webhook secret, and detach
// (also the last step of the M6 switch to Zamu, ./switch).
// Rules: M3 plan, section 5 "Setup, import and detach" and "Authorization (additions)".
import {
  type BacklogRefreshResult,
  type BacklogSourceStatus,
  type BacklogTrigger,
  BacklogWebhookInfo,
  BacklogWebhookInfoInput,
  BacklogWebhookSecret,
  type BacklogWebhookSecretState,
  DetachBacklogInput,
  RefreshBacklogInput,
  RefreshBacklogNowInput,
  ReissueBacklogWebhookSecretInput,
  SetBacklogConnectionInput,
  SetBacklogFolderInput,
  UpdateBacklogMappingsInput,
} from '@zamu/contracts';
import { schema, type Tx } from '@zamu/db';
import { hostnameOf } from '@zamu/git-providers';
import { and, eq, inArray } from 'drizzle-orm';
import type { z } from 'zod';
import { recordActivity } from '../activity';
import { type Actor, can } from '../authz';
import type { DbContext, GitContext, LinkContext } from '../context';
import { clockNow } from '../cycles';
import { BacklogDetached, BacklogPaused, Conflict, Invalid, parseInput } from '../errors';
import { providerForConnection } from '../git-connections';
import type { ProjectRow } from '../internal';
import type { JobQueue } from '../jobs';
import {
  decryptSecret,
  EncryptionKeyMissing,
  encryptSecret,
  isEncryptionReady,
  SecretUnreadable,
} from '../secrets';
import { type BacklogSourceRow, releaseBacklogLabels } from './apply';
import { repositoryRef } from './reader';
import { enqueueBacklogRefresh, storedProblems } from './refresh';
import { assertMappedMembers, newWebhookCredentials } from './setup';
import { backlogStatus, sourceForProject } from './status';

const { backlogSource, gitConnection, task, taskItem } = schema;

export interface BacklogSettingsContext extends DbContext, GitContext {
  jobs?: JobQueue;
}

export function assertNotDetached(projectRow: ProjectRow, source: BacklogSourceRow): void {
  if (source.state === 'detached') {
    throw new BacklogDetached(
      `${projectRow.key} was detached from Backlog.md; it no longer reads the repository`,
    );
  }
}

/** The state a source returns to when it resumes: setup before the first read, else by its problems. */
function resumedState(source: BacklogSourceRow): BacklogSourceRow['state'] {
  if (source.lastReadCommit === null) return 'setup';
  return storedProblems(source).length > 0 ? 'warnings' : 'healthy';
}

/** Runs a settings change on the locked source and enqueues a refresh (manual) unless it is paused. */
async function changeSource(
  ctx: BacklogSettingsContext,
  actor: Actor,
  projectKey: string,
  change: (tx: Tx, projectRow: ProjectRow, source: BacklogSourceRow) => Promise<Partial<BacklogSourceRow>>,
): Promise<BacklogSourceStatus> {
  const { project, source } = await ctx.db.transaction(async (tx) => {
    const found = await sourceForProject(tx, actor, projectKey, 'backlog.manage', { forUpdate: true });
    assertNotDetached(found.project, found.source);
    const set = await change(tx, found.project, found.source);
    const [row] = await tx
      .update(backlogSource)
      .set(set)
      .where(eq(backlogSource.id, found.source.id))
      .returning();
    if (!row) throw new Error('backlog source update returned no row');
    if (row.state !== 'paused') await enqueueBacklogRefresh(ctx, tx, row.id, 'manual');
    return { project: found.project, source: row };
  });
  return backlogStatus(ctx, project, source, { limit: 50 });
}

/** New mappings, reapplied to every task by the refresh this enqueues. backlog.manage. */
export async function updateBacklogMappings(
  ctx: BacklogSettingsContext,
  actor: Actor,
  input: z.input<typeof UpdateBacklogMappingsInput>,
): Promise<BacklogSourceStatus> {
  const parsed = parseInput(UpdateBacklogMappingsInput, input);
  return changeSource(ctx, actor, parsed.projectKey, async (tx, projectRow) => {
    await assertMappedMembers(tx, projectRow.workspaceId, parsed.mappings);
    return { mappings: parsed.mappings };
  });
}

/** A folder chosen by hand, or null to detect it again; the next refresh reads everything. backlog.manage. */
export async function setBacklogFolder(
  ctx: BacklogSettingsContext,
  actor: Actor,
  input: z.input<typeof SetBacklogFolderInput>,
): Promise<BacklogSourceStatus> {
  const parsed = parseInput(SetBacklogFolderInput, input);
  return changeSource(ctx, actor, parsed.projectKey, async () => ({ folderOverride: parsed.folderOverride }));
}

/**
 * Reads through another connection of the workspace (a paused mirror whose connection was deleted
 * or rejected). Resumes a paused source and enqueues a refresh. backlog.manage.
 */
export async function setBacklogConnection(
  ctx: BacklogSettingsContext,
  actor: Actor,
  input: z.input<typeof SetBacklogConnectionInput>,
): Promise<BacklogSourceStatus> {
  const parsed = parseInput(SetBacklogConnectionInput, input);
  const opened = await providerForConnection(ctx, parsed.connectionId, { workspaceId: actor.workspaceId });
  return changeSource(ctx, actor, parsed.projectKey, async (_tx, projectRow, source) => {
    const repository = repositoryRef(projectRow.repository);
    if (repository && hostnameOf(opened.connection.host) !== repository.host) {
      const message = `${opened.connection.name} reads ${opened.connection.host}, but the repository is on ${repository.host}`;
      throw new Invalid(message, { issues: [{ path: 'connectionId', message }] });
    }
    const resume = source.state === 'paused' && repository !== null;
    return {
      connectionId: opened.connection.id,
      ...(resume ? { state: resumedState(source), lastError: null } : {}),
    };
  });
}

async function requestRefresh(
  ctx: BacklogSettingsContext,
  actor: Actor,
  projectKey: string,
  trigger: BacklogTrigger,
): Promise<BacklogRefreshResult> {
  return ctx.db.transaction(async (tx) => {
    const { project, source } = await sourceForProject(tx, actor, projectKey, 'backlog.refresh', {
      forUpdate: true,
    });
    assertNotDetached(project, source);
    if (source.state === 'paused') {
      throw new BacklogPaused(
        `The Backlog.md mirror of ${project.key} is paused${source.lastError ? `: ${source.lastError}` : ''}`,
      );
    }
    const jobId = await enqueueBacklogRefresh(ctx, tx, source.id, trigger);
    return {
      project: project.key,
      state: source.state,
      queued: jobId !== null,
      lastAttemptAt: source.lastAttemptAt ? source.lastAttemptAt.toISOString() : null,
    };
  });
}

/** Refresh now in the web app (trigger manual). backlog.refresh; 409 when paused or detached. */
export async function refreshBacklogNow(
  ctx: BacklogSettingsContext,
  actor: Actor,
  input: z.input<typeof RefreshBacklogNowInput>,
): Promise<BacklogRefreshResult> {
  const parsed = parseInput(RefreshBacklogNowInput, input);
  return requestRefresh(ctx, actor, parsed.projectKey, 'manual');
}

/** POST /projects/{project}/backlog/refresh, zamu backlog refresh (trigger cli). backlog.refresh. */
export async function requestBacklogRefresh(
  ctx: BacklogSettingsContext,
  actor: Actor,
  input: z.input<typeof RefreshBacklogInput>,
): Promise<BacklogRefreshResult> {
  const parsed = parseInput(RefreshBacklogInput, input);
  return requestRefresh(ctx, actor, parsed.project, 'cli');
}

/** Path of the webhook route under PUBLIC_URL. */
export function backlogWebhookUrl(publicUrl: string, webhookId: string): string {
  return `${publicUrl.replace(/\/+$/, '')}/api/webhooks/backlog/${webhookId}`;
}

/**
 * The webhook URL (always), the secret (owners and admins: backlog.manage; null for others and
 * after detach), the provider and the last delivery. backlog.read. secretState says why the secret
 * is null: hidden (not backlog.manage, or no secret after detach) or unreadable (the stored secret
 * doesn't decrypt with the current APP_ENCRYPTION_KEY; issue a new one). Without any key it throws
 * EncryptionKeyMissing, since a new secret can't be stored either.
 */
export async function getBacklogWebhookInfo(
  ctx: DbContext & GitContext & LinkContext,
  actor: Actor,
  input: z.input<typeof BacklogWebhookInfoInput>,
): Promise<BacklogWebhookInfo> {
  const parsed = parseInput(BacklogWebhookInfoInput, input);
  const { project, source } = await sourceForProject(ctx.db, actor, parsed.projectKey, 'backlog.read');
  const manage = can(actor, 'backlog.manage', { type: 'project', projectId: project.id });
  const [connection] = source.connectionId
    ? await ctx.db
        .select({ provider: gitConnection.provider })
        .from(gitConnection)
        .where(eq(gitConnection.id, source.connectionId))
        .limit(1)
    : [];
  const { secret, secretState } =
    manage && source.webhookSecretCiphertext
      ? readWebhookSecret(ctx, source.webhookSecretCiphertext)
      : { secret: null, secretState: 'hidden' as const };
  return BacklogWebhookInfo.parse({
    url: backlogWebhookUrl(ctx.publicUrl, source.webhookId),
    secret,
    secretState,
    provider: connection?.provider ?? null,
    lastAt: source.webhookLastAt,
  });
}

function readWebhookSecret(
  ctx: GitContext,
  ciphertext: string,
): { secret: string | null; secretState: BacklogWebhookSecretState } {
  try {
    return { secret: decryptSecret(ctx, ciphertext), secretState: 'ok' };
  } catch (error) {
    if (error instanceof SecretUnreadable) return { secret: null, secretState: 'unreadable' };
    throw error;
  }
}

/**
 * Issues a new webhook secret (owners and admins: backlog.manage) for a mirror: same webhook id and
 * URL, a new secret stored encrypted, so deliveries signed with the old one answer 404 from now on.
 * Works when the old secret is unreadable. Conflict for detached sources and imports;
 * EncryptionKeyMissing without APP_ENCRYPTION_KEY. One project.backlog_webhook_secret_reissued
 * activity row. Returns the URL and the secret, shown once.
 */
export async function reissueBacklogWebhookSecret(
  ctx: DbContext & GitContext & LinkContext,
  actor: Actor,
  input: z.input<typeof ReissueBacklogWebhookSecretInput>,
): Promise<BacklogWebhookSecret> {
  const parsed = parseInput(ReissueBacklogWebhookSecretInput, input);
  return ctx.db.transaction(async (tx) => {
    const { project, source } = await sourceForProject(tx, actor, parsed.projectKey, 'backlog.manage', {
      forUpdate: true,
    });
    if (source.state === 'detached' || source.mode !== 'mirror') {
      throw new Conflict('This project no longer mirrors Backlog.md.');
    }
    if (!isEncryptionReady(ctx)) throw new EncryptionKeyMissing();
    const { secret } = newWebhookCredentials();
    await tx
      .update(backlogSource)
      .set({ webhookSecretCiphertext: encryptSecret(ctx, secret) })
      .where(eq(backlogSource.id, source.id));
    await recordActivity(tx, actor, {
      projectId: project.id,
      type: 'project.backlog_webhook_secret_reissued',
      details: { mode: source.mode, repository: repositoryRef(project.repository)?.short ?? null },
    });
    return BacklogWebhookSecret.parse({ url: backlogWebhookUrl(ctx.publicUrl, source.webhookId), secret });
  });
}

/**
 * Detaches the locked source in `tx`: the source is detached (when and by whom), the webhook secret
 * dropped (the URL answers 410), labels from the files become app labels, and (M6) criteria and
 * done items become the app's, so native writes work on them. One project.backlog_detached
 * activity row. Shared by detach and the switch to Zamu.
 */
export async function detachSource(
  tx: Tx,
  actor: Actor,
  found: { project: ProjectRow; source: BacklogSourceRow },
  now: Date,
): Promise<BacklogSourceRow> {
  const [row] = await tx
    .update(backlogSource)
    .set({
      state: 'detached',
      detachedAt: now,
      detachedById: actor.userId,
      webhookSecretCiphertext: null,
      lastError: null,
    })
    .where(eq(backlogSource.id, found.source.id))
    .returning();
  if (!row) throw new Error('backlog source update returned no row');
  // M5: labels from the files become app labels (names editable); tasks keep them.
  await releaseBacklogLabels(tx, found.project.id);
  // M6: items read from the files are the app's from now on.
  await tx
    .update(taskItem)
    .set({ source: 'app' })
    .where(
      and(
        eq(taskItem.source, 'backlog'),
        inArray(
          taskItem.taskId,
          tx.select({ id: task.id }).from(task).where(eq(task.projectId, found.project.id)),
        ),
      ),
    );
  await recordActivity(tx, actor, {
    projectId: found.project.id,
    type: 'project.backlog_detached',
    details: {
      mode: found.source.mode,
      repository: repositoryRef(found.project.repository)?.short ?? null,
    },
  });
  return row;
}

/**
 * Detaches for good (owners and admins, after typing the key): the source is detached, the
 * webhook secret dropped (the URL answers 410), the project and its milestones become editable,
 * tasks keep their Backlog.md id and block, hidden tasks stay hidden. One project.backlog_detached
 * activity row. BacklogDetached when it already is.
 */
export async function detachBacklog(
  ctx: BacklogSettingsContext,
  actor: Actor,
  input: z.input<typeof DetachBacklogInput>,
): Promise<BacklogSourceStatus> {
  const parsed = parseInput(DetachBacklogInput, input);
  const now = clockNow(ctx);
  const { project, source } = await ctx.db.transaction(async (tx) => {
    const found = await sourceForProject(tx, actor, parsed.projectKey, 'backlog.manage', { forUpdate: true });
    assertNotDetached(found.project, found.source);
    const row = await detachSource(tx, actor, found, now);
    return { project: found.project, source: row };
  });
  return backlogStatus(ctx, project, source, { limit: 50 });
}
