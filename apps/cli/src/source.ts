// Where a change comes from (M6): the machine zamu runs on and the git branch of the working
// directory. Every request carries them in the x-zamu-machine and x-zamu-branch headers, so history
// entries and notes say "laptop · feat/payout-retries". The server stores what it gets and ignores
// what it can't read, so a missing branch or an odd host name never fails a command.
import { hostname } from 'node:os';
import { MAX_SOURCE_LENGTH, SOURCE_HEADERS } from '@zamu/contracts';
import type { CliIo, FetchLike } from './io';
import { git } from './project';

export interface RequestSource {
  machine: string | null;
  branch: string | null;
}

/**
 * A header value: control characters dropped, trimmed, cut to the length the server keeps. Header
 * values are bytes, so characters outside ASCII are percent-encoded rather than lost.
 */
export function headerValue(value: string | null | undefined): string | null {
  // biome-ignore lint/suspicious/noControlCharactersInRegex: strips control characters
  const cleaned = [...(value ?? '').replace(/[\u0000-\u001f\u007f-\u009f]/g, '').trim()]
    .slice(0, MAX_SOURCE_LENGTH)
    .join('')
    .trim();
  if (!cleaned) return null;
  return /^[ -~]*$/.test(cleaned) ? cleaned : encodeURIComponent(cleaned);
}

/** ZAMU_MACHINE, else the host name. */
export function machineName(io: Pick<CliIo, 'env'>): string | null {
  return headerValue(io.env.ZAMU_MACHINE?.trim() || hostname());
}

/** The branch checked out in the working directory; null outside a repository or on a detached HEAD. */
export async function currentBranch(io: Pick<CliIo, 'cwd'>): Promise<string | null> {
  return headerValue(await git(io, ['branch', '--show-current']));
}

export async function requestSource(io: Pick<CliIo, 'env' | 'cwd'>): Promise<RequestSource> {
  return { machine: machineName(io), branch: await currentBranch(io) };
}

/** The two headers for a source; a part that is null is left out. */
export function sourceHeaders(source: RequestSource): Record<string, string> {
  return {
    ...(source.machine ? { [SOURCE_HEADERS.machine]: source.machine } : {}),
    ...(source.branch ? { [SOURCE_HEADERS.branch]: source.branch } : {}),
  };
}

/**
 * A fetch that adds the source headers to every request, then hands it to `fetch` (the global one
 * when none is given). The API client takes it through its `fetch` option.
 */
export function withSourceHeaders(source: RequestSource, fetch?: FetchLike): FetchLike {
  const headers = sourceHeaders(source);
  return (request) => {
    for (const [name, value] of Object.entries(headers)) request.headers.set(name, value);
    return fetch ? fetch(request) : globalThis.fetch(request);
  };
}
