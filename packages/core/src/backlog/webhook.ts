// Push webhooks: POST /api/webhooks/backlog/{webhookId}. The route reads the raw body once and
// maps this decision to a response. Unknown id or a bad signature: 404 with no detail. Detached:
// 410. Pushes to other branches and other events: 204. A push to the default branch: 202 and a
// refresh (trigger webhook). Every accepted delivery sets webhook_last_at. M7: a pull or merge
// request event goes to the project's repository link, as if delivered to its own webhook: 202
// and a repository.event job (204 when the project has no repository).
import { schema } from '@zamu/db';
import { PROVIDER_KINDS, type ProviderKind, verifyWebhook, type WebhookHeaders } from '@zamu/git-providers';
import { eq } from 'drizzle-orm';
import type { DbContext, GitContext } from '../context';
import { clockNow } from '../cycles';
import type { JobQueue } from '../jobs';
import { queueBacklogRequestEvent } from '../pull-requests';
import { decryptSecret, EncryptionKeyMissing, SecretUnreadable } from '../secrets';
import { enqueueBacklogRefresh, loadSource } from './refresh';

const { backlogSource, gitConnection } = schema;

export interface BacklogWebhookDecision {
  status: 202 | 204 | 404 | 410;
  /** For logs only; the route sends no detail on 404. */
  reason:
    | 'refresh_queued'
    | 'refresh_pending'
    | 'other_branch'
    | 'branch_deleted'
    | 'not_a_push'
    | 'request_queued'
    | 'unknown_webhook'
    | 'bad_signature'
    | 'detached';
}

/** Webhook ids are random base64url strings (see newWebhookCredentials). */
const WEBHOOK_ID = /^[A-Za-z0-9_-]{8,64}$/;

export interface WebhookContext extends DbContext, GitContext {
  jobs?: JobQueue;
}

/** Decides what to do with one delivery; see the file comment. Never throws for bad input. */
export async function acceptBacklogWebhook(
  ctx: WebhookContext,
  webhookId: string,
  headers: WebhookHeaders,
  rawBody: string | Uint8Array,
): Promise<BacklogWebhookDecision> {
  if (!WEBHOOK_ID.test(webhookId)) return { status: 404, reason: 'unknown_webhook' };
  const [found] = await ctx.db
    .select({ id: backlogSource.id })
    .from(backlogSource)
    .where(eq(backlogSource.webhookId, webhookId))
    .limit(1);
  const source = found ? await loadSource(ctx.db, found.id) : null;
  if (!source) return { status: 404, reason: 'unknown_webhook' };
  if (source.state === 'detached' || !source.webhookSecretCiphertext) {
    return { status: 410, reason: 'detached' };
  }

  let secret: string;
  try {
    secret = decryptSecret(ctx, source.webhookSecretCiphertext);
  } catch (error) {
    if (error instanceof EncryptionKeyMissing || error instanceof SecretUnreadable) {
      return { status: 404, reason: 'bad_signature' };
    }
    throw error;
  }
  // The connection names the provider; without one (deleted), any provider's signature counts.
  const [connection] = source.connectionId
    ? await ctx.db
        .select({ provider: gitConnection.provider })
        .from(gitConnection)
        .where(eq(gitConnection.id, source.connectionId))
        .limit(1)
    : [];
  const kinds: readonly ProviderKind[] = connection ? [connection.provider] : PROVIDER_KINDS;
  let verified: ReturnType<typeof verifyWebhook> | null = null;
  for (const kind of kinds) {
    const result = verifyWebhook(kind, headers, rawBody, secret);
    if (result.ok) {
      verified = result;
      break;
    }
  }
  if (!verified?.ok) return { status: 404, reason: 'bad_signature' };

  const now = clockNow(ctx);
  return ctx.db.transaction(async (tx) => {
    if (verified.event === 'pull_request') {
      // The project lock comes first, as everywhere else that also touches the source row.
      const queued = await queueBacklogRequestEvent(ctx, tx, source.projectId, verified);
      await tx.update(backlogSource).set({ webhookLastAt: now }).where(eq(backlogSource.id, source.id));
      return queued
        ? ({ status: 202, reason: 'request_queued' } as const)
        : ({ status: 204, reason: 'not_a_push' } as const);
    }
    await tx.update(backlogSource).set({ webhookLastAt: now }).where(eq(backlogSource.id, source.id));
    if (verified.event !== 'push') return { status: 204, reason: 'not_a_push' } as const;
    if (verified.deleted || !verified.headCommit) return { status: 204, reason: 'branch_deleted' } as const;
    if (source.defaultBranch && verified.branch !== source.defaultBranch) {
      return { status: 204, reason: 'other_branch' } as const;
    }
    const jobId = await enqueueBacklogRefresh(ctx, tx, source.id, 'webhook');
    return { status: 202, reason: jobId ? 'refresh_queued' : 'refresh_pending' } as const;
  });
}
