// M7: pull and merge requests as one shape. Each host names the same facts differently (GitHub and
// Gitea/Forgejo pulls, GitLab merge requests, REST answers and webhook payloads); the mappers here
// turn them into RequestInfo so core links and moves tasks without knowing the host. Also parses a
// request's web address, so a person can link one by pasting it.

import { GitUnexpected } from './errors';
import { normalizeHost } from './hosts';
import { asRecord, stringField } from './http';
import { loginOf } from './open-requests';
import type { ProviderKind, RequestInfo, RequestState, RequestUrl } from './types';

/** Most requests listRequestsUpdatedSince returns: one page on every host. */
export const MAX_UPDATED_REQUESTS = 100;

/**
 * Title prefixes that mark a Gitea or Forgejo pull request as work in progress. Forgejo's default
 * WORK_IN_PROGRESS_PREFIXES is `WIP:,[WIP]`; `Draft:` is what people bring from GitLab. Matched
 * without regard to case, as the hosts do.
 */
const DRAFT_PREFIXES = ['wip:', '[wip]', 'draft:'];

export function hasDraftPrefix(title: string): boolean {
  const lower = title.trimStart().toLowerCase();
  return DRAFT_PREFIXES.some((prefix) => lower.startsWith(prefix));
}

// GitLab webhooks from older releases write `2013-12-03 17:23:34 UTC`; everything else is ISO 8601.
const SPACED_TIME = /^(\d{4}-\d{2}-\d{2}) (\d{2}:\d{2}:\d{2})(?:\.\d+)? ?(UTC|Z|[+-]\d{2}:?\d{2})$/;

/** An ISO 8601 UTC timestamp for a host's time field, or null when it is missing or not a time. */
export function isoTime(value: unknown): string | null {
  if (typeof value !== 'string' || !value) return null;
  let text = value.trim();
  const spaced = SPACED_TIME.exec(text);
  if (spaced) {
    const zone = spaced[3] as string;
    text = `${spaced[1]}T${spaced[2]}${zone === 'UTC' ? 'Z' : zone}`;
  }
  const time = Date.parse(text);
  return Number.isNaN(time) ? null : new Date(time).toISOString();
}

function requiredTime(record: Record<string, unknown>, key: string, what: string): string {
  const time = isoTime(record[key]);
  if (time === null) throw new GitUnexpected(`The provider sent ${what} without ${key}.`);
  return time;
}

function requestNumber(record: Record<string, unknown>, key: 'number' | 'iid', what: string): number {
  const number = record[key];
  if (typeof number !== 'number' || !Number.isSafeInteger(number) || number < 1) {
    throw new GitUnexpected(`The provider sent ${what} without ${key === 'iid' ? 'an iid' : 'a number'}.`);
  }
  return number;
}

function text(value: unknown): string {
  return typeof value === 'string' ? value : '';
}

/**
 * Fills the fields every host agrees on. A request still open has no closing time even when the
 * host kept the one from before a reopen; a merged request counts as closed when it was merged.
 */
function finish(info: RequestInfo): RequestInfo {
  if (info.state === 'open' || info.state === 'draft') return { ...info, mergedAt: null, closedAt: null };
  if (info.state === 'merged') return { ...info, closedAt: info.closedAt ?? info.mergedAt };
  return { ...info, mergedAt: null };
}

/** A GitHub pull request from the REST API or a `pull_request` webhook payload. */
export function githubRequest(value: unknown): RequestInfo {
  const pull = asRecord(value, 'pull request');
  const mergedAt = isoTime(pull.merged_at);
  const merged = pull.merged === true || mergedAt !== null;
  const state: RequestState = merged
    ? 'merged'
    : pull.state === 'closed'
      ? 'closed'
      : pull.draft === true
        ? 'draft'
        : 'open';
  return finish({
    number: requestNumber(pull, 'number', 'a pull request'),
    title: text(pull.title),
    body: text(pull.body),
    state,
    headBranch: stringField(asRecord(pull.head, 'pull request head'), 'ref', 'a pull request head'),
    baseBranch: stringField(asRecord(pull.base, 'pull request base'), 'ref', 'a pull request base'),
    author: loginOf(pull.user, 'login'),
    mergedBy: loginOf(pull.merged_by, 'login'),
    webUrl: stringField(pull, 'html_url', 'a pull request'),
    openedAt: requiredTime(pull, 'created_at', 'a pull request'),
    mergedAt,
    closedAt: isoTime(pull.closed_at),
    updatedAt: requiredTime(pull, 'updated_at', 'a pull request'),
  });
}

/**
 * A Gitea or Forgejo pull request from the REST API or a `pull_request` webhook payload. Recent
 * releases send `draft`; older ones only mark drafts with a title prefix.
 */
export function giteaRequest(value: unknown): RequestInfo {
  const pull = asRecord(value, 'pull request');
  const title = text(pull.title);
  const mergedAt = isoTime(pull.merged_at);
  const merged = pull.merged === true || mergedAt !== null;
  const draft = typeof pull.draft === 'boolean' ? pull.draft : hasDraftPrefix(title);
  const state: RequestState = merged
    ? 'merged'
    : pull.state === 'closed'
      ? 'closed'
      : draft
        ? 'draft'
        : 'open';
  return finish({
    number: requestNumber(pull, 'number', 'a pull request'),
    title,
    body: text(pull.body),
    state,
    headBranch: stringField(asRecord(pull.head, 'pull request head'), 'ref', 'a pull request head'),
    baseBranch: stringField(asRecord(pull.base, 'pull request base'), 'ref', 'a pull request base'),
    author: loginOf(pull.user, 'login') ?? loginOf(pull.user, 'username'),
    mergedBy: loginOf(pull.merged_by, 'login') ?? loginOf(pull.merged_by, 'username'),
    webUrl: stringField(pull, 'html_url', 'a pull request'),
    openedAt: requiredTime(pull, 'created_at', 'a pull request'),
    mergedAt,
    closedAt: isoTime(pull.closed_at),
    updatedAt: requiredTime(pull, 'updated_at', 'a pull request'),
  });
}

/** GitLab state and draft flag as one RequestState. `locked` is an open request being merged. */
function gitlabState(record: Record<string, unknown>): RequestState {
  const draft = record.draft === true || record.work_in_progress === true;
  switch (record.state) {
    case 'merged':
      return 'merged';
    case 'closed':
      return 'closed';
    case 'opened':
    case 'locked':
      return draft ? 'draft' : 'open';
    default:
      throw new GitUnexpected('The provider sent a merge request in an unknown state.');
  }
}

/** A GitLab merge request from the REST API. */
export function gitlabRequest(value: unknown): RequestInfo {
  const request = asRecord(value, 'merge request');
  return finish({
    number: requestNumber(request, 'iid', 'a merge request'),
    title: text(request.title),
    body: text(request.description),
    state: gitlabState(request),
    headBranch: stringField(request, 'source_branch', 'a merge request'),
    baseBranch: stringField(request, 'target_branch', 'a merge request'),
    author: loginOf(request.author, 'username'),
    // `merged_by` is deprecated in favour of `merge_user`; older releases send only the former.
    mergedBy: loginOf(request.merge_user, 'username') ?? loginOf(request.merged_by, 'username'),
    webUrl: stringField(request, 'web_url', 'a merge request'),
    openedAt: requiredTime(request, 'created_at', 'a merge request'),
    mergedAt: isoTime(request.merged_at),
    closedAt: isoTime(request.closed_at),
    updatedAt: requiredTime(request, 'updated_at', 'a merge request'),
  });
}

/**
 * A GitLab merge request from a `Merge Request Hook` payload. The payload names people by id only,
 * except `user`, who triggered the event: it is the author when the request was opened and the
 * merger when it was merged, and the other names stay null.
 */
export function gitlabHookRequest(payload: Record<string, unknown>): RequestInfo {
  const request = asRecord(payload.object_attributes, 'merge request');
  const action = request.action;
  const actor = loginOf(payload.user, 'username');
  const state = gitlabState(request);
  const closedAt =
    isoTime(request.closed_at) ??
    (state === 'closed' && action === 'close'
      ? (isoTime(request.actioned_at) ?? isoTime(request.updated_at))
      : null);
  return finish({
    number: requestNumber(request, 'iid', 'a merge request'),
    title: text(request.title),
    body: text(request.description),
    state,
    headBranch: stringField(request, 'source_branch', 'a merge request'),
    baseBranch: stringField(request, 'target_branch', 'a merge request'),
    author: action === 'open' ? actor : null,
    mergedBy: action === 'merge' ? actor : null,
    webUrl: stringField(request, 'url', 'a merge request'),
    openedAt: requiredTime(request, 'created_at', 'a merge request'),
    mergedAt:
      isoTime(request.merged_at) ??
      (state === 'merged' && action === 'merge'
        ? (isoTime(request.actioned_at) ?? isoTime(request.updated_at))
        : null),
    closedAt,
    updatedAt: requiredTime(request, 'updated_at', 'a merge request'),
  });
}

// --- Request addresses ----------------------------------------------------------------------------

function positiveNumber(segment: string | undefined): number | null {
  if (!segment || !/^\d{1,15}$/.test(segment)) return null;
  const number = Number(segment);
  return number >= 1 ? number : null;
}

/**
 * The repository and number of a request's web address, or null when the address is not one:
 * `https://github.com/o/r/pull/12` (GitHub and GitHub Enterprise), `https://host/g/s/r/-/merge_requests/12`
 * (GitLab, any depth of groups) and `https://host/o/r/pulls/12` (Gitea and Forgejo). Anything after
 * the number (`/files`, `/diffs`), the query and the fragment are ignored. The host is normalised
 * like a connection's host (lowercase, port kept); the path keeps its case.
 */
export function parseRequestUrl(input: string): RequestUrl | null {
  const raw = input.trim();
  if (!raw || raw.length > 2000 || /\s/.test(raw)) return null;
  let url: URL;
  try {
    url = new URL(raw);
  } catch {
    return null;
  }
  if (url.protocol !== 'https:' && url.protocol !== 'http:') return null;
  if (url.username || url.password) return null;
  const host = normalizeHost(`${url.protocol}//${url.host}`);
  if (!host) return null;

  let segments: string[];
  try {
    segments = url.pathname.split('/').filter(Boolean).map(decodeURIComponent);
  } catch {
    return null;
  }
  if (segments.some((segment) => segment === '.' || segment === '..' || segment.includes('/'))) {
    return null;
  }

  const dash = segments.indexOf('-');
  if (dash >= 2 && segments[dash + 1] === 'merge_requests') {
    const number = positiveNumber(segments[dash + 2]);
    if (number === null || host === 'github.com') return null;
    return { provider: 'gitlab', host, path: segments.slice(0, dash).join('/'), number };
  }

  if (segments.length < 4) return null;
  const number = positiveNumber(segments[3]);
  if (number === null) return null;
  const path = segments.slice(0, 2).join('/');
  let provider: ProviderKind;
  if (segments[2] === 'pull') provider = 'github';
  else if (segments[2] === 'pulls') provider = 'gitea';
  else return null;
  if (host === 'gitlab.com' || (host === 'github.com' && provider !== 'github')) return null;
  return { provider, host, path, number };
}

// --- Lists -----------------------------------------------------------------------------------------

/** Page size to ask for: the caller's limit, between 1 and MAX_UPDATED_REQUESTS. */
export function pageSize(limit: number): number {
  if (!Number.isFinite(limit)) return MAX_UPDATED_REQUESTS;
  return Math.min(MAX_UPDATED_REQUESTS, Math.max(1, Math.floor(limit)));
}

/**
 * The requests updated at or after `since`, newest update first, at most `limit`. Hosts sort by
 * update already; sorting again keeps the answer right when one does not.
 */
export function updatedSince(requests: RequestInfo[], since: Date | null, limit: number): RequestInfo[] {
  const from = since ? since.getTime() : Number.NEGATIVE_INFINITY;
  return requests
    .filter((request) => Date.parse(request.updatedAt) >= from)
    .sort((a, b) => Date.parse(b.updatedAt) - Date.parse(a.updatedAt) || b.number - a.number)
    .slice(0, pageSize(limit));
}
