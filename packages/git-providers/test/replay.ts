// Replays recorded HTTP exchanges as a fetch function. Requests match on method, origin, path and
// the set of query parameters (order ignored); each exchange answers once. An unmatched request
// fails the test with the URL it asked for.

import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import type { FetchFn } from '../src/types';

export interface Exchange {
  request: { method?: string; url: string };
  response: {
    status: number;
    headers?: Record<string, string>;
    json?: unknown;
    text?: string;
  };
}

export interface Fixture {
  description: string;
  source: string;
  exchanges: Exchange[];
}

export interface Call {
  method: string;
  url: string;
  headers: Record<string, string>;
  redirect: RequestInit['redirect'];
}

export const FIXTURE_TOKEN = 'fixture-token-123';

const fixturesDir = join(import.meta.dirname, 'fixtures');

export function loadFixture(provider: string, name: string): Fixture {
  return JSON.parse(readFileSync(join(fixturesDir, provider, `${name}.json`), 'utf8')) as Fixture;
}

export function loadJson<T>(provider: string, name: string): T {
  return JSON.parse(readFileSync(join(fixturesDir, provider, `${name}.json`), 'utf8')) as T;
}

function key(method: string, url: string): string {
  const parsed = new URL(url);
  const params = [...parsed.searchParams.entries()]
    .map(([name, value]) => `${name}=${value}`)
    .sort()
    .join('&');
  return `${method.toUpperCase()} ${parsed.origin}${parsed.pathname}?${params}`;
}

export function replay(...fixtures: Fixture[]) {
  const exchanges = fixtures.flatMap((fixture) => fixture.exchanges);
  const used = new Set<number>();
  const calls: Call[] = [];

  const fetch: FetchFn = async (input, init) => {
    const url = typeof input === 'string' ? input : input instanceof URL ? input.toString() : input.url;
    const method = init?.method ?? 'GET';
    const headers: Record<string, string> = {};
    new Headers(init?.headers).forEach((value, name) => {
      headers[name] = value;
    });
    calls.push({ method: method.toUpperCase(), url, headers, redirect: init?.redirect });
    const wanted = key(method, url);
    const index = exchanges.findIndex(
      (exchange, i) => !used.has(i) && key(exchange.request.method ?? 'GET', exchange.request.url) === wanted,
    );
    if (index === -1) throw new Error(`No recorded exchange for ${method} ${url}`);
    used.add(index);
    const { response } = exchanges[index] as Exchange;
    const body =
      response.json !== undefined
        ? JSON.stringify(response.json)
        : response.text === ''
          ? null
          : response.text;
    const responseHeaders = new Headers(response.headers);
    if (response.json !== undefined && !responseHeaders.has('content-type')) {
      responseHeaders.set('content-type', 'application/json; charset=utf-8');
    }
    return new Response(body ?? null, { status: response.status, headers: responseHeaders });
  };

  return {
    fetch,
    calls,
    /** Exchanges that were never requested. */
    unused: () => exchanges.filter((_, i) => !used.has(i)).map((exchange) => exchange.request.url),
  };
}
