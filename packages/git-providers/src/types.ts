import type { HostPolicy } from './hosts';

/** `gitea` covers Gitea and Forgejo: same API under /api/v1. */
export type ProviderKind = 'github' | 'gitlab' | 'gitea';

export const PROVIDER_KINDS: readonly ProviderKind[] = ['github', 'gitlab', 'gitea'];

export interface Whoami {
  login: string;
  /** Repositories the account has, when the provider offers a count. */
  repoCount?: number;
}

export interface RepositoryInfo {
  defaultBranch: string;
  /** Repository page in a browser, as the provider reports it. */
  webUrl: string;
}

export interface TreeEntry {
  /** Full path from the repository root, e.g. `backlog/tasks/back-1 - Title.md`. */
  path: string;
  /** Git blob hash. Unchanged content keeps the same hash, so callers can skip re-reading it. */
  blobSha: string;
  /** Size in bytes. Null on GitLab, whose tree listing does not report sizes. */
  size: number | null;
}

/** A file to read in a batch: its path and the blob hash the tree listing reported. */
export interface BlobRef {
  path: string;
  blobSha: string;
}

export interface FileContent {
  content: string;
  blobSha: string;
}

/** Most open pull or merge requests listOpenRequests looks at. */
export const MAX_OPEN_REQUESTS = 100;

/** An open pull request (GitHub, Gitea/Forgejo) or merge request (GitLab). */
export interface OpenRequest {
  /** The number people use: #12 on GitHub and Forgejo, !12 on GitLab (its iid). */
  number: number;
  title: string;
  /** Login of who opened it; null when the host does not say (a deleted account). */
  author: string | null;
  /** The branch it would merge. */
  headBranch: string;
  /** Its page in a browser. */
  webUrl: string;
}

export interface OpenRequestList {
  /** Requests with a changed file under the folder, newest first. */
  requests: OpenRequest[];
  /**
   * True when the list may be incomplete: more than MAX_OPEN_REQUESTS requests were open, or a
   * request changes more files than one page holds and none on that page was under the folder.
   */
  truncated: boolean;
  /** The host's page of open requests, for "see them all". */
  listUrl: string;
}

/**
 * M7: where a pull or merge request stands. `draft` is open but marked as not ready (a draft flag,
 * or a `WIP:`/`Draft:` title prefix on Gitea and Forgejo releases without the flag).
 */
export type RequestState = 'open' | 'draft' | 'merged' | 'closed';

export const REQUEST_STATES: readonly RequestState[] = ['open', 'draft', 'merged', 'closed'];

/**
 * M7: one pull request (GitHub, Gitea/Forgejo) or merge request (GitLab), from the REST API or a
 * webhook payload. Times are ISO 8601 in UTC (`2026-11-20T09:30:00.000Z`).
 */
export interface RequestInfo {
  /** The number people use: #12 on GitHub and Forgejo, !12 on GitLab (its iid). */
  number: number;
  title: string;
  /** Description as written, '' when there is none. */
  body: string;
  state: RequestState;
  /** The branch it would merge. */
  headBranch: string;
  /** The branch it merges into. */
  baseBranch: string;
  /**
   * Login of who opened it. Null when the host does not say: a deleted account, or a GitLab
   * webhook for anything but the opening (its payloads name people by id only).
   */
  author: string | null;
  /**
   * Login of who merged it. Null until merged, and when the host does not say: the pull request
   * lists of GitHub and Forgejo leave it out (getRequest and their webhooks carry it), as do GitLab
   * webhooks for anything but the merge.
   */
  mergedBy: string | null;
  /** Its page in a browser. */
  webUrl: string;
  openedAt: string;
  /** When it was merged; null unless the state is `merged`. */
  mergedAt: string | null;
  /**
   * When it was closed or merged; null while open or a draft, and for a closed GitLab merge request
   * when a webhook other than the closing one does not say.
   */
  closedAt: string | null;
  /** The host's last change to it; later events about the same request carry a later time. */
  updatedAt: string;
}

/** M7: a request's web address, taken apart by parseRequestUrl. */
export interface RequestUrl {
  /** Inferred from the address form: `/pull/` GitHub, `/-/merge_requests/` GitLab, `/pulls/` Gitea. */
  provider: ProviderKind;
  /** Normalised like a connection's host: lowercase, `host` or `host:port`. */
  host: string;
  /** Repository path, case kept: `owner/name`, or the full namespace on GitLab. */
  path: string;
  number: number;
}

/**
 * M7: what happened to a request, as a webhook reports it. GitHub's `ready_for_review` and GitLab's
 * draft changes become `ready` and `converted_to_draft`; Gitea and Forgejo report them as a title
 * edit that adds or drops the prefix. `synchronized` is new commits on the head branch; `merged` is
 * a close that merged.
 */
export type RequestAction =
  | 'opened'
  | 'reopened'
  | 'ready'
  | 'converted_to_draft'
  | 'edited'
  | 'synchronized'
  | 'closed'
  | 'merged';

export const REQUEST_ACTIONS: readonly RequestAction[] = [
  'opened',
  'reopened',
  'ready',
  'converted_to_draft',
  'edited',
  'synchronized',
  'closed',
  'merged',
];

/** Header bag as received by a server route. Names are matched case-insensitively. */
export type WebhookHeaders = Headers | Record<string, string | string[] | undefined>;

export type WebhookRefusal = 'missing_signature' | 'bad_signature' | 'bad_payload';

/** A verified delivery that is a push, GitHub's ping, or an event Zamu does not read. */
export interface WebhookPushOrOther {
  ok: true;
  /**
   * `push` for branch and tag pushes, `ping` for GitHub's hook test, `other` for any other event,
   * request events with an action outside RequestAction (labels, assignees, reviews) included.
   */
  event: 'push' | 'ping' | 'other';
  /** Provider event name as sent (`push`, `Push Hook`, `ping`…). */
  eventName: string;
  /** Branch name for pushes to `refs/heads/…`; absent for tags and other events. */
  branch?: string;
  /** Commit the branch points at after the push; absent when the push deleted the branch. */
  headCommit?: string;
  /** True when the push deleted the ref. */
  deleted?: boolean;
}

/**
 * M7: a verified pull or merge request event (GitHub and Gitea/Forgejo `pull_request`, GitLab
 * `Merge Request Hook`) with the request as the payload describes it.
 */
export interface WebhookRequestEvent {
  ok: true;
  event: 'pull_request';
  /** Provider event name as sent (`pull_request`, `Merge Request Hook`). */
  eventName: string;
  action: RequestAction;
  request: RequestInfo;
}

export type WebhookVerification =
  | { ok: false; reason: WebhookRefusal }
  | WebhookPushOrOther
  | WebhookRequestEvent;

/**
 * One repository host behind one token. `path` is `owner/name` (GitLab: the full namespace path,
 * `group/subgroup/name`). Every method throws a GitProviderError subclass on failure.
 */
export interface GitProvider {
  readonly provider: ProviderKind;
  /** Normalised host, `host` or `host:port`. */
  readonly host: string;
  readonly apiBaseUrl: string;
  readonly webBaseUrl: string;

  /** The token's account, used to test a connection. */
  whoami(): Promise<Whoami>;
  /** Default branch (follows renames) and web URL. */
  getRepository(path: string): Promise<RepositoryInfo>;
  /** Commit hash the branch points at. */
  getBranchHead(path: string, branch: string): Promise<string>;
  /**
   * Every file under `folder` at `commit`, recursively, all pages. Blobs only: directories,
   * submodules and symlinks are left out. Empty when the folder does not exist at that commit.
   * `folder` is relative to the repository root; '' lists the whole repository.
   */
  listTree(path: string, commit: string, folder: string): Promise<TreeEntry[]>;
  /** Blob content decoded as UTF-8 (a byte-order mark is dropped). */
  readBlob(path: string, blobSha: string): Promise<string>;
  /**
   * Many files at `commit` in a few requests, keyed by blob hash, for providers whose per-file reads
   * hit rate limits (GitLab.com allows 100 API requests a minute on the free plan). A file missing
   * from the result (binary, too large, or changed) is read with readBlob. Absent on providers
   * without a batch read.
   */
  readBlobs?(path: string, commit: string, files: readonly BlobRef[]): Promise<Map<string, string>>;
  /** One file at `ref` (commit or branch), or null when there is no file at that path. */
  readFile(path: string, ref: string, filePath: string): Promise<FileContent | null>;
  /**
   * M6: open pull or merge requests that change a file under `folder` ('' is the whole
   * repository), renamed-away files included. Looks at the newest MAX_OPEN_REQUESTS requests and
   * one page of changed files for each (100 on GitHub and GitLab, 50 on Gitea/Forgejo). Read-only:
   * GitHub fine-grained tokens need "Pull requests: Read-only", GitLab read_api, Gitea/Forgejo
   * read:repository. Optional so test doubles can leave it out; the three adapters implement it.
   */
  listOpenRequests?(path: string, folder: string): Promise<OpenRequestList>;
  /**
   * M7: one pull or merge request by its number, or null when the host answers 404 (no such
   * request, an issue number, or a repository the token cannot see). One GET. Read-only, with the
   * same token scopes as listOpenRequests. Optional so test doubles can leave it out; the three
   * adapters implement it.
   */
  getRequest?(path: string, number: number): Promise<RequestInfo | null>;
  /**
   * M7: requests in any state, most recently updated first, updated at or after `since` (every
   * request when null), at most `limit` (capped at MAX_UPDATED_REQUESTS). One GET of one page: a
   * Gitea or Forgejo server returns at most its MAX_RESPONSE_ITEMS (50 by default) per page.
   */
  listRequestsUpdatedSince?(path: string, since: Date | null, limit: number): Promise<RequestInfo[]>;
  /** Link to a file on the branch in the provider's web UI, for "Open file". */
  fileUrl(path: string, branch: string, filePath: string): string;
  /** Checks a webhook delivery against the source's secret. Same as the standalone verifyWebhook. */
  verifyWebhook(headers: WebhookHeaders, rawBody: string | Uint8Array, secret: string): WebhookVerification;
}

export type FetchFn = (input: string | URL | Request, init?: RequestInit) => Promise<Response>;

export interface CreateProviderOptions {
  provider: ProviderKind;
  /** Host as stored on the connection (normalised by normalizeHost; a typed URL is accepted too). */
  host: string;
  /** Access token. An empty string sends no Authorization header (public repositories only). */
  token: string;
  /** Replaces the global fetch, for tests. */
  fetch?: FetchFn;
  /** Use http:// (hosts listed in GIT_HTTP_HOSTS). Ignored for github.com. */
  allowHttp?: boolean;
  /**
   * When set, every request (and every redirect hop) first runs isAllowedHost on the host it is
   * about to call and throws GitHostRefused when the policy refuses it. Core always sets this.
   */
  hostPolicy?: Omit<HostPolicy, 'httpHosts'>;
  /** Per-request timeout. Default 30 seconds. */
  timeoutMs?: number;
  /** Clock for rate-limit reset headers, for tests. */
  now?: () => number;
}
