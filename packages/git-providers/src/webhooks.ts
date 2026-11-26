// Webhook verification. GitHub signs the raw body with HMAC-SHA256 (X-Hub-Signature-256:
// sha256=<hex>); Gitea and Forgejo do the same in hex without a prefix (X-Forgejo-Signature,
// X-Gitea-Signature); GitLab sends the secret itself in X-Gitlab-Token. Comparisons are constant
// time. The payload is parsed only after the signature checks out.
//
// M7 adds request events: GitHub and Gitea/Forgejo `pull_request`, GitLab `Merge Request Hook`. Each
// host's action names map onto RequestAction, and the request comes from the payload, so a delivery
// needs no API call to be applied. Actions Zamu does not read (labels, assignees, reviews) verify as
// `other`, like any other event.

import { createHash, createHmac, timingSafeEqual } from 'node:crypto';
import { isGitProviderError } from './errors';
import { giteaRequest, githubRequest, gitlabHookRequest, hasDraftPrefix } from './requests';
import type { ProviderKind, RequestAction, RequestInfo, WebhookHeaders, WebhookVerification } from './types';

function header(headers: WebhookHeaders, name: string): string | undefined {
  if (headers instanceof Headers) return headers.get(name) ?? undefined;
  const wanted = name.toLowerCase();
  for (const [key, value] of Object.entries(headers)) {
    if (key.toLowerCase() !== wanted || value === undefined) continue;
    return Array.isArray(value) ? value[0] : value;
  }
  return undefined;
}

function bytesOf(body: string | Uint8Array): Buffer {
  return typeof body === 'string' ? Buffer.from(body, 'utf8') : Buffer.from(body);
}

/** Constant-time string equality that does not leak the length either. */
function sameSecret(received: string, expected: string): boolean {
  const a = createHash('sha256').update(received, 'utf8').digest();
  const b = createHash('sha256').update(expected, 'utf8').digest();
  return timingSafeEqual(a, b) && received.length === expected.length;
}

function hmacHex(secret: string, body: Buffer): string {
  return createHmac('sha256', secret).update(body).digest('hex');
}

function parsePayload(body: Buffer): Record<string, unknown> | null {
  let text = body.toString('utf8');
  // "application/x-www-form-urlencoded" deliveries (GitHub, Gitea) carry the JSON in payload=.
  if (text.startsWith('payload=')) text = new URLSearchParams(text).get('payload') ?? '';
  try {
    const value: unknown = JSON.parse(text);
    return value && typeof value === 'object' && !Array.isArray(value)
      ? (value as Record<string, unknown>)
      : null;
  } catch {
    return null;
  }
}

const ZERO_SHA = /^0+$/;

function pushResult(eventName: string, payload: Record<string, unknown>): WebhookVerification {
  const ref = typeof payload.ref === 'string' ? payload.ref : '';
  const after = typeof payload.after === 'string' ? payload.after : '';
  const deleted = payload.deleted === true || (after !== '' && ZERO_SHA.test(after));
  return {
    ok: true,
    event: 'push',
    eventName,
    deleted,
    ...(ref.startsWith('refs/heads/') ? { branch: ref.slice('refs/heads/'.length) } : {}),
    ...(after && !deleted ? { headCommit: after } : {}),
  };
}

// --- Request events ---------------------------------------------------------------------------

/** What a delivery is, once its signature checks out. */
type Kind = 'push' | 'ping' | 'pull_request' | 'other';

function record(value: unknown): Record<string, unknown> | null {
  return value && typeof value === 'object' && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : null;
}

/** `{ previous, current }` of a GitLab `changes` entry, or null when the entry is absent. */
function gitlabChange(changes: Record<string, unknown> | null, key: string) {
  const change = record(changes?.[key]);
  return change ? { previous: change.previous, current: change.current } : null;
}

function githubAction(action: unknown, request: RequestInfo): RequestAction | null {
  switch (action) {
    case 'opened':
    case 'reopened':
    case 'edited':
    case 'converted_to_draft':
      return action;
    case 'ready_for_review':
      return 'ready';
    case 'synchronize':
      return 'synchronized';
    case 'closed':
      return request.state === 'merged' ? 'merged' : 'closed';
    default:
      return null;
  }
}

function giteaAction(
  action: unknown,
  payload: Record<string, unknown>,
  request: RequestInfo,
): RequestAction | null {
  switch (action) {
    case 'opened':
    case 'reopened':
    case 'synchronized':
      return action;
    case 'closed':
      return request.state === 'merged' ? 'merged' : 'closed';
    case 'edited': {
      // Drafts are a title prefix here: an edit that adds or drops it changes the draft state.
      const from = record(record(payload.changes)?.title)?.from;
      if (typeof from === 'string' && request.state !== 'merged' && request.state !== 'closed') {
        const wasDraft = hasDraftPrefix(from);
        const isDraft = request.state === 'draft';
        if (wasDraft && !isDraft) return 'ready';
        if (!wasDraft && isDraft) return 'converted_to_draft';
      }
      return 'edited';
    }
    default:
      return null;
  }
}

/** GitLab fields whose change counts as an edit of the request; labels and people do not. */
const GITLAB_EDITS = ['title', 'description', 'target_branch', 'source_branch'];

function gitlabAction(payload: Record<string, unknown>): RequestAction | null {
  const attributes = record(payload.object_attributes);
  switch (attributes?.action) {
    case 'open':
      return 'opened';
    case 'reopen':
      return 'reopened';
    case 'close':
      return 'closed';
    case 'merge':
      return 'merged';
    case 'update': {
      const changes = record(payload.changes);
      const draft = gitlabChange(changes, 'draft') ?? gitlabChange(changes, 'work_in_progress');
      if (draft && draft.previous === true && draft.current === false) return 'ready';
      if (draft && draft.previous === false && draft.current === true) return 'converted_to_draft';
      // oldrev is present only when the update pushed commits.
      if (typeof attributes.oldrev === 'string' && attributes.oldrev) return 'synchronized';
      if (GITLAB_EDITS.some((key) => gitlabChange(changes, key))) return 'edited';
      return null;
    }
    default:
      return null;
  }
}

/** The request event of a verified delivery, `other` for an action Zamu does not read. */
function requestResult(
  provider: ProviderKind,
  eventName: string,
  payload: Record<string, unknown>,
): WebhookVerification {
  let request: RequestInfo;
  let action: RequestAction | null;
  try {
    switch (provider) {
      case 'github':
        request = githubRequest(payload.pull_request);
        action = githubAction(payload.action, request);
        break;
      case 'gitea':
        request = giteaRequest(payload.pull_request);
        action = giteaAction(payload.action, payload, request);
        break;
      case 'gitlab':
        action = gitlabAction(payload);
        if (action === null) return { ok: true, event: 'other', eventName };
        request = gitlabHookRequest(payload);
        break;
    }
  } catch (error) {
    // A signed payload without the documented request fields.
    if (isGitProviderError(error)) return { ok: false, reason: 'bad_payload' };
    throw error;
  }
  if (action === null) return { ok: true, event: 'other', eventName };
  return { ok: true, event: 'pull_request', eventName, action, request };
}

/**
 * Verifies one delivery for a source's secret and extracts what a refresh needs: the branch and
 * head of a push, or the action and request of a request event. `rawBody` must be the exact bytes
 * received. An empty secret never verifies.
 */
export function verifyWebhook(
  provider: ProviderKind,
  headers: WebhookHeaders,
  rawBody: string | Uint8Array,
  secret: string,
): WebhookVerification {
  const body = bytesOf(rawBody);
  let eventName: string;
  let kind: Kind;
  // Forgejo and Gitea also send GitHub's headers, so their deliveries verify as GitHub's too. Their
  // request payloads use their own action names (`synchronized`, drafts as title edits).
  let payloadShape = provider;

  switch (provider) {
    case 'github': {
      const signature = header(headers, 'x-hub-signature-256');
      if (!signature) return { ok: false, reason: 'missing_signature' };
      if (!secret || !sameSecret(signature.trim().toLowerCase(), `sha256=${hmacHex(secret, body)}`)) {
        return { ok: false, reason: 'bad_signature' };
      }
      eventName = header(headers, 'x-github-event') ?? '';
      kind =
        eventName === 'ping'
          ? 'ping'
          : eventName === 'push'
            ? 'push'
            : eventName === 'pull_request'
              ? 'pull_request'
              : 'other';
      if (
        header(headers, 'x-forgejo-event') !== undefined ||
        header(headers, 'x-gitea-event') !== undefined
      ) {
        payloadShape = 'gitea';
      }
      break;
    }
    case 'gitlab': {
      const token = header(headers, 'x-gitlab-token');
      if (!token) return { ok: false, reason: 'missing_signature' };
      if (!secret || !sameSecret(token, secret)) return { ok: false, reason: 'bad_signature' };
      eventName = header(headers, 'x-gitlab-event') ?? '';
      kind =
        eventName === 'Push Hook' ? 'push' : eventName === 'Merge Request Hook' ? 'pull_request' : 'other';
      break;
    }
    case 'gitea': {
      const signature = header(headers, 'x-forgejo-signature') ?? header(headers, 'x-gitea-signature');
      if (!signature) return { ok: false, reason: 'missing_signature' };
      if (!secret || !sameSecret(signature.trim().toLowerCase(), hmacHex(secret, body))) {
        return { ok: false, reason: 'bad_signature' };
      }
      eventName = header(headers, 'x-forgejo-event') ?? header(headers, 'x-gitea-event') ?? '';
      // Forgejo sends assignee, label, milestone, review request and sync changes as `pull_request`
      // too; the action tells them apart.
      kind = eventName === 'push' ? 'push' : eventName === 'pull_request' ? 'pull_request' : 'other';
      break;
    }
  }

  if (kind === 'ping') return { ok: true, event: 'ping', eventName };
  if (kind === 'other') return { ok: true, event: 'other', eventName };
  const payload = parsePayload(body);
  if (!payload) return { ok: false, reason: 'bad_payload' };
  return kind === 'push' ? pushResult(eventName, payload) : requestResult(payloadShape, eventName, payload);
}

/** Signature header a provider would send for `rawBody`, for tests and fixtures. GitLab sends the secret. */
export function signWebhook(
  provider: ProviderKind,
  rawBody: string | Uint8Array,
  secret: string,
): Record<string, string> {
  const body = bytesOf(rawBody);
  switch (provider) {
    case 'github':
      return { 'X-Hub-Signature-256': `sha256=${hmacHex(secret, body)}` };
    case 'gitlab':
      return { 'X-Gitlab-Token': secret };
    case 'gitea':
      return { 'X-Forgejo-Signature': hmacHex(secret, body), 'X-Gitea-Signature': hmacHex(secret, body) };
  }
}
