// M6: shared part of listOpenRequests. Each adapter lists the open requests and reads one page of
// changed files per request; this keeps the requests with a file under the folder, a few file
// pages at a time, and works out whether the answer may be incomplete.
import { asRecord } from './http';
import { isUnderFolder } from './paths';
import { MAX_OPEN_REQUESTS, type OpenRequest, type OpenRequestList } from './types';

/** File pages read at the same time. */
const FILE_CONCURRENCY = 4;

/** One page of a request's changed files: old and new paths, and whether more pages may follow. */
export interface ChangedFilesPage {
  paths: string[];
  more: boolean;
}

export async function requestsUnderFolder(
  listed: { requests: OpenRequest[]; more: boolean; listUrl: string },
  folder: string,
  filesOf: (request: OpenRequest) => Promise<ChangedFilesPage>,
): Promise<OpenRequestList> {
  const candidates = [...listed.requests].sort((a, b) => b.number - a.number);
  const examined = candidates.slice(0, MAX_OPEN_REQUESTS);
  let truncated = listed.more || candidates.length > MAX_OPEN_REQUESTS;
  const matches = new Array<boolean>(examined.length).fill(false);
  let next = 0;
  const workers = Array.from({ length: Math.min(FILE_CONCURRENCY, examined.length) }, async () => {
    while (next < examined.length) {
      const index = next++;
      const page = await filesOf(examined[index] as OpenRequest);
      matches[index] = page.paths.some((path) => isUnderFolder(path, folder));
      if (!matches[index] && page.more) truncated = true;
    }
  });
  await Promise.all(workers);
  return {
    requests: examined.filter((_, index) => matches[index]),
    truncated,
    listUrl: listed.listUrl,
  };
}

/** A login from a user object (`login` or `username`), or null. */
export function loginOf(value: unknown, key: 'login' | 'username'): string | null {
  if (!value || typeof value !== 'object') return null;
  const login = (value as Record<string, unknown>)[key];
  return typeof login === 'string' && login ? login : null;
}

/** The old and new paths of changed-file entries, skipping fields that are not strings. */
export function changedPaths(entries: unknown[], keys: readonly string[]): string[] {
  const paths: string[] = [];
  for (const entry of entries) {
    const record = asRecord(entry, 'changed file');
    for (const key of keys) {
      const value = record[key];
      if (typeof value === 'string' && value) paths.push(value);
    }
  }
  return paths;
}
