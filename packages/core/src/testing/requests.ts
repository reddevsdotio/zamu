// M7 test support: a git host that serves pull or merge requests from memory (getRequest,
// listRequestsUpdatedSince, getRepository) with a call log and failure injection, a factory that
// records how core built each adapter (token, host, kind), and a builder for RequestInfo values.
// Test-only.
import {
  GitNotFound,
  type GitProvider,
  type ProviderKind,
  type RequestInfo,
  verifyWebhook,
} from '@zamu/git-providers';
import type { ProviderFactory } from '../context';

/** One repository on the fake host. */
export interface FakeRequestRepository {
  defaultBranch: string;
  requests: Map<number, RequestInfo>;
}

/** A call the fake host received. */
export interface FakeHostCall {
  method: 'getRepository' | 'getRequest' | 'listRequestsUpdatedSince';
  path: string;
  number?: number;
  since?: string | null;
  limit?: number;
}

/** Web address of a request in the form each host writes it. */
export function requestUrl(provider: ProviderKind, host: string, path: string, number: number): string {
  switch (provider) {
    case 'github':
      return `https://${host}/${path}/pull/${number}`;
    case 'gitlab':
      return `https://${host}/${path}/-/merge_requests/${number}`;
    case 'gitea':
      return `https://${host}/${path}/pulls/${number}`;
  }
}

/**
 * A RequestInfo with defaults: open, head feat/<number>, base main, opened and updated at `at`
 * (default 2040-01-01T10:00:00Z), a GitHub address under github.com/northwind/payments.
 */
export function requestInfo(
  values: Partial<RequestInfo> & { number: number },
  where: { provider?: ProviderKind; host?: string; path?: string } = {},
): RequestInfo {
  const at = values.updatedAt ?? '2040-01-01T10:00:00.000Z';
  const state = values.state ?? 'open';
  const closed = state === 'merged' || state === 'closed' ? at : null;
  return {
    title: `Request ${values.number}`,
    body: '',
    state,
    headBranch: `feat/${values.number}`,
    baseBranch: 'main',
    author: 'claude-dev',
    mergedBy: state === 'merged' ? 'ana' : null,
    webUrl: requestUrl(
      where.provider ?? 'github',
      where.host ?? 'github.com',
      where.path ?? 'northwind/payments',
      values.number,
    ),
    openedAt: values.openedAt ?? at,
    mergedAt: state === 'merged' ? at : null,
    closedAt: closed,
    updatedAt: at,
    ...values,
  };
}

/** A GitProvider that serves requests per repository path (case ignored). Other reads throw. */
export class FakeRequestHost implements GitProvider {
  readonly provider: ProviderKind;
  readonly host: string;
  readonly apiBaseUrl: string;
  readonly webBaseUrl: string;
  readonly calls: FakeHostCall[] = [];
  /** Thrown by the next call when set; cleared after throwing unless `failAlways`. */
  failWith: Error | null = null;
  failAlways = false;
  readonly #repos = new Map<string, FakeRequestRepository>();

  constructor(provider: ProviderKind = 'github', host = 'github.com') {
    this.provider = provider;
    this.host = host;
    this.apiBaseUrl = `https://${host}/api`;
    this.webBaseUrl = `https://${host}`;
  }

  /** Serves a repository; returns it so tests can add requests. */
  repository(path: string, defaultBranch = 'main'): FakeRequestRepository {
    const key = path.toLowerCase();
    let repo = this.#repos.get(key);
    if (!repo) {
      repo = { defaultBranch, requests: new Map() };
      this.#repos.set(key, repo);
    }
    return repo;
  }

  /** Stores (or replaces) a request of `path`. */
  put(path: string, request: RequestInfo): RequestInfo {
    this.repository(path).requests.set(request.number, request);
    return request;
  }

  #call(call: FakeHostCall): FakeRequestRepository {
    this.calls.push(call);
    if (this.failWith) {
      const error = this.failWith;
      if (!this.failAlways) this.failWith = null;
      throw error;
    }
    const repo = this.#repos.get(call.path.toLowerCase());
    if (!repo) throw new GitNotFound('repository not found');
    return repo;
  }

  async whoami() {
    return { login: 'tester', repoCount: this.#repos.size };
  }

  async getRepository(path: string) {
    const repo = this.#call({ method: 'getRepository', path });
    return { defaultBranch: repo.defaultBranch, webUrl: `${this.webBaseUrl}/${path}` };
  }

  async getRequest(path: string, number: number): Promise<RequestInfo | null> {
    const repo = this.#call({ method: 'getRequest', path, number });
    return repo.requests.get(number) ?? null;
  }

  async listRequestsUpdatedSince(path: string, since: Date | null, limit: number): Promise<RequestInfo[]> {
    const repo = this.#call({
      method: 'listRequestsUpdatedSince',
      path,
      since: since ? since.toISOString() : null,
      limit,
    });
    const from = since ? since.getTime() : Number.NEGATIVE_INFINITY;
    return (
      [...repo.requests.values()]
        .filter((request) => Date.parse(request.updatedAt) >= from)
        .sort((a, b) => Date.parse(b.updatedAt) - Date.parse(a.updatedAt))
        .slice(0, limit)
        // Like GitHub and Forgejo, the list leaves out who merged; getRequest has it.
        .map((request) => ({ ...request, mergedBy: null }))
    );
  }

  async getBranchHead(): Promise<string> {
    throw new GitNotFound('not served');
  }

  async listTree(): Promise<never[]> {
    throw new GitNotFound('not served');
  }

  async readBlob(): Promise<string> {
    throw new GitNotFound('not served');
  }

  async readFile() {
    return null;
  }

  fileUrl(path: string, branch: string, filePath: string) {
    return `${this.webBaseUrl}/${path}/blob/${branch}/${filePath}`;
  }

  verifyWebhook(
    headers: Parameters<GitProvider['verifyWebhook']>[0],
    rawBody: string | Uint8Array,
    secret: string,
  ) {
    return verifyWebhook(this.provider, headers, rawBody, secret);
  }
}

/** How core asked for an adapter. */
export interface BuiltProvider {
  provider: ProviderKind;
  host: string;
  token: string;
}

/** A factory that hands out `host` for every adapter and records what was asked. */
export function fakeRequestFactory(host: FakeRequestHost): ProviderFactory & { built: BuiltProvider[] } {
  const built: BuiltProvider[] = [];
  const factory: ProviderFactory = (options) => {
    built.push({ provider: options.provider, host: options.host, token: options.token });
    return host;
  };
  return Object.assign(factory, { built });
}
