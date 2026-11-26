// Webhooks from GitHub, GitLab and Gitea/Forgejo. Framework-free so tests call them directly; the
// routes under routes/api/webhooks/ mount them. Not oRPC: the senders are git hosts, not API clients,
// and they get bare status codes. The raw body is read once (signatures are computed over its exact
// bytes) and handed to core, which verifies it, records the delivery and enqueues the job.
//
//   POST /api/webhooks/backlog/{webhookId}      Backlog.md mirrors: pushes enqueue a refresh; M7:
//                                               request events go on to the project's repository link
//   POST /api/webhooks/repository/{webhookId}   M7: pull and merge request events of a project's
//                                               repository, enqueued as repository.event
import { acceptBacklogWebhook, receiveRepositoryWebhook, type WebhookContext } from '@zamu/core';

/** Larger payloads are refused before reading. GitHub caps deliveries at 25 MB. */
export const MAX_WEBHOOK_BODY_BYTES = 25 * 1024 * 1024;

function empty(status: number): Response {
  return new Response(null, { status, headers: { 'cache-control': 'no-store' } });
}

/** Any other method: 405, instead of the app's HTML page. */
export function webhookMethodNotAllowed(): Response {
  return new Response(null, { status: 405, headers: { allow: 'POST', 'cache-control': 'no-store' } });
}

/** Reads at most `limit` bytes; null when the body is longer. */
async function readBody(request: Request, limit: number): Promise<Uint8Array | null> {
  const declared = Number(request.headers.get('content-length'));
  if (Number.isFinite(declared) && declared > limit) return null;
  if (!request.body) return new Uint8Array();
  const chunks: Uint8Array[] = [];
  let size = 0;
  const reader = request.body.getReader();
  for (;;) {
    const { done, value } = await reader.read();
    if (done) break;
    size += value.byteLength;
    if (size > limit) {
      await reader.cancel().catch(() => {});
      return null;
    }
    chunks.push(value);
  }
  const body = new Uint8Array(size);
  let offset = 0;
  for (const chunk of chunks) {
    body.set(chunk, offset);
    offset += chunk.byteLength;
  }
  return body;
}

/**
 * 202 refresh queued (or one already waiting), or M7 a request event queued for the project's
 * repository link; 204 accepted but nothing to do (other branch, not a push, a request event for a
 * project without a repository); 404 unknown id or bad signature (no detail); 410 detached; 413
 * body too large.
 */
export async function handleBacklogWebhook(
  ctx: WebhookContext,
  request: Request,
  webhookId: string,
  options: { maxBodyBytes?: number } = {},
): Promise<Response> {
  const body = await readBody(request, options.maxBodyBytes ?? MAX_WEBHOOK_BODY_BYTES);
  if (!body) return empty(413);
  try {
    const decision = await acceptBacklogWebhook(ctx, webhookId, request.headers, body);
    return empty(decision.status);
  } catch (error) {
    // Database or queue failures: the git host retries or shows the failed delivery.
    console.error('webhooks: delivery failed:', error instanceof Error ? error.message : error);
    return empty(500);
  }
}

/**
 * 202 event queued, 200 accepted with nothing to do (a ping, another event), 401 unsigned or badly
 * signed (recorded on the link, so the Repository page says the last event failed its signature
 * check), 404 unknown id, 410 the project no longer has a repository, 413 body too large.
 */
export async function handleRepositoryWebhook(
  ctx: WebhookContext,
  request: Request,
  webhookId: string,
  options: { maxBodyBytes?: number } = {},
): Promise<Response> {
  const body = await readBody(request, options.maxBodyBytes ?? MAX_WEBHOOK_BODY_BYTES);
  if (!body) return empty(413);
  try {
    const decision = await receiveRepositoryWebhook(ctx, {
      webhookId,
      headers: request.headers,
      rawBody: body,
    });
    return empty(decision.status);
  } catch (error) {
    console.error('webhooks: repository delivery failed:', error instanceof Error ? error.message : error);
    return empty(500);
  }
}
