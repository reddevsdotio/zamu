// Typed /api/v1 client: the contract from @zamu/contracts over OpenAPILink (plain REST + JSON), with
// Problem bodies decoded into ORPCErrors that carry the contract's codes. Every request has 5 seconds
// to connect and answer (M6): an agent's command never hangs on a server that is down or restarting,
// and a write the offline queue accepts (queue.ts) is stored instead. The Backlog.md export (PM-32)
// gets 2 minutes: it sends a whole project in one answer, which can take longer on a slow link. A login's requests name its
// workspace in the x-zamu-workspace header (0.10), so a key used for another workspace fails loudly
// with WORKSPACE_MISMATCH instead of reading the wrong data.
import { createORPCClient } from '@orpc/client';
import type { ContractRouterClient } from '@orpc/contract';
import { OpenAPILink } from '@orpc/openapi-client/fetch';
import { type Contract, contract, decodeProblem, WORKSPACE_HEADER } from '@zamu/contracts';
import type { FetchLike } from './io';

export type ApiClient = ContractRouterClient<Contract>;

// The build replaces __ZAMU_CLI_VERSION__ with the release version (tsdown.config.ts); from source it is
// unset. Declared here as in main.ts: importing the version from main.ts would make an import cycle.
declare const __ZAMU_CLI_VERSION__: string | undefined;

export const USER_AGENT = `zamu/${typeof __ZAMU_CLI_VERSION__ === 'string' ? __ZAMU_CLI_VERSION__ : '0.0.0-dev'}`;

/** How long one request may take, connecting and reading the answer included. */
export const REQUEST_TIMEOUT_MS = 5_000;

/** The limit for requests that send a whole project back (PM-32). None of them can be queued. */
export const LONG_REQUEST_TIMEOUT_MS = 120_000;

/** GET paths that get LONG_REQUEST_TIMEOUT_MS: the Backlog.md export. */
const LONG_REQUEST_PATHS = [/\/api\/v1\/projects\/[^/]+\/backlog\/export$/];

/** The limit for one request: long for the export, REQUEST_TIMEOUT_MS for everything else. */
export function requestTimeout(request: Request): number {
  if (request.method !== 'GET') return REQUEST_TIMEOUT_MS;
  const { pathname } = new URL(request.url);
  return LONG_REQUEST_PATHS.some((path) => path.test(pathname))
    ? LONG_REQUEST_TIMEOUT_MS
    : REQUEST_TIMEOUT_MS;
}

export interface ClientOptions {
  /** Server origin (the contract paths already start with /api/v1). */
  url: string;
  key: string;
  /** Slug of the workspace the key is for, sent as x-zamu-workspace. Omitted when not known. */
  workspace?: string | null;
  fetch?: FetchLike;
  /** Limit per request in milliseconds, or a function of the request (default requestTimeout). */
  timeoutMs?: number | ((request: Request) => number);
}

/** "5 seconds", "2 minutes", "50 ms". */
export function formatLimit(ms: number): string {
  if (ms >= 60_000 && ms % 60_000 === 0) return ms === 60_000 ? '1 minute' : `${ms / 60_000} minutes`;
  if (ms >= 1000 && ms % 1000 === 0) return ms === 1000 ? '1 second' : `${ms / 1000} seconds`;
  return `${ms} ms`;
}

/**
 * The cause of the network failure a request without an answer in time becomes. `started` is true
 * when the server had sent its status and headers but not the whole body: it is working, just slowly.
 */
export class NoAnswerError extends Error {
  constructor(
    readonly ms: number,
    readonly started = false,
  ) {
    super(`${started ? 'answer not finished' : 'no answer'} within ${formatLimit(ms)}`);
    this.name = 'NoAnswerError';
  }
}

/**
 * True for a request that got no answer: the connection failed, broke off, or timed out. A server
 * that answered, with any status, is not a network failure.
 */
export function isNetworkFailure(error: unknown): boolean {
  return error instanceof TypeError && /fetch failed|Failed to fetch|NetworkError/i.test(error.message);
}

/** A network failure, shaped like the one fetch throws, so every caller reports both the same way. */
export function networkFailure(cause: unknown): TypeError {
  return new TypeError('fetch failed', { cause });
}

// Statuses whose response can't carry a body (the Response constructor refuses one).
const NULL_BODY_STATUSES = new Set([101, 103, 204, 205, 304]);

/**
 * Wraps fetch so the whole request, reading the body included, ends within `limit` (milliseconds, or
 * a function of the request). On time out the request is aborted (no socket keeps the process alive)
 * and the call fails as a network failure whose cause says whether the answer had started.
 */
export function withTimeout(
  fetch: (request: Request, init?: RequestInit) => Promise<Response>,
  limit: number | ((request: Request) => number),
) {
  return async (request: Request, init?: RequestInit): Promise<Response> => {
    const ms = typeof limit === 'number' ? limit : limit(request);
    const controller = new AbortController();
    let started = false;
    const timedOut = new Promise<never>((_, reject) => {
      const timer = setTimeout(() => {
        const cause = new NoAnswerError(ms, started);
        controller.abort(cause);
        reject(networkFailure(cause));
      }, ms);
      timer.unref?.();
      controller.signal.addEventListener('abort', () => clearTimeout(timer), { once: true });
    });
    const timed = new Request(request, { signal: AbortSignal.any([request.signal, controller.signal]) });
    const exchange = (async () => {
      const response = await fetch(timed, init);
      started = true;
      if (NULL_BODY_STATUSES.has(response.status) || response.body === null) return response;
      const body = await response.arrayBuffer();
      return new Response(body, {
        status: response.status,
        statusText: response.statusText,
        headers: response.headers,
      });
    })();
    // The losing side must not surface as an unhandled rejection.
    exchange.catch(() => {});
    try {
      return await Promise.race([exchange, timedOut]);
    } finally {
      if (!controller.signal.aborted) controller.abort();
    }
  };
}

export function createApiClient({
  url,
  key,
  workspace,
  fetch,
  timeoutMs = requestTimeout,
}: ClientOptions): ApiClient {
  // Without a fetch of its own the link calls the global fetch with its init (redirect: manual), as
  // before; a given fetch (the source headers, a test handler) gets the request alone, as before.
  const send = (request: Request, init?: RequestInit) =>
    fetch ? fetch(request) : globalThis.fetch(request, init);
  const link = new OpenAPILink(contract, {
    url,
    headers: {
      authorization: `Bearer ${key}`,
      'user-agent': USER_AGENT,
      accept: 'application/json',
      ...(workspace ? { [WORKSPACE_HEADER]: workspace } : {}),
    },
    customErrorResponseBodyDecoder: (body) => decodeProblem(body),
    fetch: withTimeout(send, timeoutMs),
  });
  return createORPCClient<ApiClient>(link);
}

type Procedure = (...args: unknown[]) => Promise<unknown>;

/** Calls the procedure at `path` (["tasks", "update"]) of a client. */
export function callProcedure(client: ApiClient, path: readonly string[], args: unknown[]): Promise<unknown> {
  let target: unknown = client;
  for (const part of path) target = (target as Record<string, unknown>)[part];
  return (target as Procedure)(...args);
}

/**
 * A client whose every procedure call goes through `call`, with the procedure's path. The offline
 * queue and the clone match wrap the real client with it.
 */
export function proxyClient(call: (path: string[], args: unknown[]) => Promise<unknown>): ApiClient {
  const proxy = (path: string[]): unknown =>
    new Proxy(() => {}, {
      // `then` must stay undefined, or awaiting the client would call it.
      get: (_target, property) =>
        typeof property === 'string' && property !== 'then' ? proxy([...path, property]) : undefined,
      apply: (_target, _this, args: unknown[]) => call(path, args),
    });
  return proxy([]) as ApiClient;
}
