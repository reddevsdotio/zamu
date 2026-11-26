// GitLab (gitlab.com and self-managed), REST API v4.
// Docs: https://docs.gitlab.com/api/repositories/ (tree with keyset pagination, raw blobs),
// /api/branches/, /api/projects/, /api/rest/ (URL-encoded namespaced paths, Link headers),
// /api/merge_requests/ (list merge requests, get a single merge request, list merge request diffs).
//
// Blob contents come in batches of BATCH_SIZE through GraphQL (repository.blobs): one REST call per
// file would exceed gitlab.com's 100 requests a minute on the free plan for a few hundred tasks.
//
// The tree endpoint answers 404 "invalid revision or path" for a folder that does not exist, the
// same status as for a missing project. To tell them apart, listTree first checks the folder in its
// parent's listing; the recursive listing then only runs on a folder known to exist.

import { GitNotFound, GitUnauthorized, GitUnexpected } from './errors';
import {
  asArray,
  asRecord,
  decodeUtf8,
  encodeSegments,
  type HttpClient,
  nextLink,
  stringField,
} from './http';
import { changedPaths, loginOf, requestsUnderFolder } from './open-requests';
import { isRegularFileMode, normalizeFolder, repoSegments, splitFilePath } from './paths';
import { gitlabRequest, pageSize, updatedSince } from './requests';
import {
  type BlobRef,
  type FileContent,
  type GitProvider,
  MAX_OPEN_REQUESTS,
  type OpenRequest,
  type OpenRequestList,
  type RepositoryInfo,
  type RequestInfo,
  type TreeEntry,
  type Whoami,
} from './types';
import { verifyWebhook } from './webhooks';

const PAGE_SIZE = 100;
const MAX_PAGES = 10_000;
const BATCH_SIZE = 100;

const BLOBS_QUERY = `query($project: ID!, $ref: String!, $paths: [String!]!, $after: String) {
  project(fullPath: $project) {
    repository {
      blobs(ref: $ref, paths: $paths, first: ${BATCH_SIZE}, after: $after) {
        pageInfo { hasNextPage endCursor }
        nodes { path oid rawTextBlob }
      }
    }
  }
}`;

interface GitLabEntry {
  id: string;
  name: string;
  type: string;
  path: string;
  mode: string;
}

function gitLabEntry(value: unknown): GitLabEntry {
  const record = asRecord(value, 'tree entry');
  return {
    id: stringField(record, 'id', 'a tree entry'),
    name: stringField(record, 'name', 'a tree entry'),
    type: stringField(record, 'type', 'a tree entry'),
    path: stringField(record, 'path', 'a tree entry'),
    mode: typeof record.mode === 'string' ? record.mode : '',
  };
}

export class GitLabProvider implements GitProvider {
  readonly provider = 'gitlab' as const;

  constructor(
    readonly host: string,
    readonly apiBaseUrl: string,
    readonly webBaseUrl: string,
    private readonly http: HttpClient,
  ) {}

  private project(path: string): string {
    return `/projects/${encodeURIComponent(repoSegments(path, true).join('/'))}`;
  }

  async whoami(): Promise<Whoami> {
    const { data } = await this.http.getJson(this.http.url('/user'));
    const login = stringField(asRecord(data, 'user'), 'username', 'the user');
    // X-Total is left out above 10,000 results and on some gitlab.com endpoints; the count is optional.
    try {
      const { response } = await this.http.getJson(
        this.http.url('/projects', { membership: true, simple: true, per_page: 1 }),
      );
      const total = response.headers.get('x-total');
      return total !== null && /^\d+$/.test(total) ? { login, repoCount: Number(total) } : { login };
    } catch (error) {
      // A token limited to read_user still identifies its user.
      if (error instanceof GitUnauthorized || error instanceof GitNotFound) return { login };
      throw error;
    }
  }

  async getRepository(path: string): Promise<RepositoryInfo> {
    const { data } = await this.http.getJson(this.http.url(this.project(path)));
    const project = asRecord(data, 'project');
    if (project.default_branch === null) {
      // GitLab reports no default branch until the first push.
      throw new GitNotFound('The repository is empty: it has no default branch yet.', {
        code: 'empty_repository',
      });
    }
    return {
      defaultBranch: stringField(project, 'default_branch', 'the project'),
      webUrl: stringField(project, 'web_url', 'the project'),
    };
  }

  async getBranchHead(path: string, branch: string): Promise<string> {
    const { data } = await this.http.getJson(
      this.http.url(`${this.project(path)}/repository/branches/${encodeURIComponent(branch)}`),
    );
    return stringField(asRecord(asRecord(data, 'branch').commit, 'branch commit'), 'id', 'the branch commit');
  }

  /** One folder level (or everything below it), all pages, following the Link header. */
  private async listLevel(
    path: string,
    ref: string,
    folder: string,
    recursive: boolean,
  ): Promise<GitLabEntry[]> {
    const entries: GitLabEntry[] = [];
    let url: URL | null = this.http.url(`${this.project(path)}/repository/tree`, {
      ref,
      path: folder || undefined,
      recursive: recursive || undefined,
      per_page: PAGE_SIZE,
      pagination: 'keyset',
    });
    for (let page = 0; url && page < MAX_PAGES; page++) {
      const { data, response } = await this.http.getJson(url);
      entries.push(...asArray(data, 'tree').map(gitLabEntry));
      const next = nextLink(response.headers.get('link'));
      url = next ? this.http.followLink(next) : null;
    }
    if (url) throw new GitUnexpected('The provider kept sending tree pages.');
    return entries;
  }

  /** Direct children of `folder`, or null when the folder does not exist at `ref`. */
  private async childrenOf(path: string, ref: string, folder: string): Promise<GitLabEntry[] | null> {
    let listing = await this.listLevel(path, ref, '', false);
    let current = '';
    for (const segment of folder ? folder.split('/') : []) {
      const entry = listing.find((candidate) => candidate.name === segment);
      if (entry?.type !== 'tree') return null;
      current = current ? `${current}/${segment}` : segment;
      listing = await this.listLevel(path, ref, current, false);
    }
    return listing;
  }

  async listTree(path: string, commit: string, folder: string): Promise<TreeEntry[]> {
    const normalized = normalizeFolder(folder);
    if (normalized) {
      const { parent, name } = splitFilePath(normalized);
      const siblings = await this.childrenOf(path, commit, parent);
      if (!siblings?.some((entry) => entry.name === name && entry.type === 'tree')) return [];
    }
    const entries = await this.listLevel(path, commit, normalized, true);
    return entries
      .filter((entry) => entry.type === 'blob' && isRegularFileMode(entry.mode))
      .map((entry) => ({ path: entry.path, blobSha: entry.id, size: null }));
  }

  async readBlob(path: string, blobSha: string): Promise<string> {
    const bytes = await this.http.getBytes(
      this.http.url(`${this.project(path)}/repository/blobs/${encodeURIComponent(blobSha)}/raw`),
      '*/*',
    );
    return decodeUtf8(bytes);
  }

  async readBlobs(path: string, commit: string, files: readonly BlobRef[]): Promise<Map<string, string>> {
    const project = repoSegments(path, true).join('/');
    const wanted = new Set(files.map((file) => file.blobSha));
    const contents = new Map<string, string>();
    const paths = [...new Set(files.map((file) => file.path))];
    for (let start = 0; start < paths.length; start += BATCH_SIZE) {
      const batch = paths.slice(start, start + BATCH_SIZE);
      let after: string | null = null;
      for (let page = 0; page < MAX_PAGES; page++) {
        const { data } = await this.http.postJson(this.http.originUrl('/api/graphql'), {
          query: BLOBS_QUERY,
          variables: { project, ref: commit, paths: batch, after },
        });
        const body = asRecord(data, 'GraphQL answer');
        if (Array.isArray(body.errors) && body.errors.length > 0) {
          throw new GitUnexpected('The provider refused the batch read of files.');
        }
        // GraphQL answers null for a project the token cannot see, where REST answers 404.
        const found = asRecord(body.data, 'GraphQL data').project;
        if (found === null) {
          throw new GitNotFound(
            'The provider has no such repository, branch or object, or the token cannot see it.',
          );
        }
        const repository = asRecord(asRecord(found, 'project').repository, 'repository');
        const blobs = asRecord(repository.blobs, 'blob list');
        for (const node of asArray(blobs.nodes, 'blob list')) {
          const record = asRecord(node, 'blob');
          const oid = record.oid;
          const text = record.rawTextBlob;
          // Binary or oversized blobs come back without text; the caller reads them one by one.
          if (typeof oid === 'string' && typeof text === 'string' && wanted.has(oid)) {
            contents.set(oid, text.replace(/^\uFEFF/, ''));
          }
        }
        const info = asRecord(blobs.pageInfo, 'page info');
        if (info.hasNextPage !== true || typeof info.endCursor !== 'string') break;
        after = info.endCursor;
      }
    }
    return contents;
  }

  async readFile(path: string, ref: string, filePath: string): Promise<FileContent | null> {
    const { parent, name } = splitFilePath(filePath);
    if (!name) return null;
    const siblings = await this.childrenOf(path, ref, parent);
    const entry = siblings?.find((candidate) => candidate.name === name);
    if (entry?.type !== 'blob' || !isRegularFileMode(entry.mode)) return null;
    return { content: await this.readBlob(path, entry.id), blobSha: entry.id };
  }

  async listOpenRequests(path: string, folder: string): Promise<OpenRequestList> {
    // One page of the newest open merge requests (100 is GitLab's page limit), then one page of
    // diffs per request: on gitlab.com free plans that stays near the 100 requests a minute.
    const { data, response } = await this.http.getJson(
      this.http.url(`${this.project(path)}/merge_requests`, {
        state: 'opened',
        order_by: 'created_at',
        sort: 'desc',
        per_page: MAX_OPEN_REQUESTS,
      }),
    );
    const requests = asArray(data, 'merge request list').map((value): OpenRequest => {
      const request = asRecord(value, 'merge request');
      const iid = request.iid;
      if (typeof iid !== 'number')
        throw new GitUnexpected('The provider sent a merge request without an iid.');
      return {
        number: iid,
        title: typeof request.title === 'string' ? request.title : '',
        author: loginOf(request.author, 'username'),
        headBranch: stringField(request, 'source_branch', 'a merge request'),
        webUrl: stringField(request, 'web_url', 'a merge request'),
      };
    });
    const nextPage = response.headers.get('x-next-page');
    return requestsUnderFolder(
      {
        requests,
        more: Boolean(nextPage) || nextLink(response.headers.get('link')) !== null,
        listUrl: `${this.webBaseUrl}/${repoSegments(path, true).join('/')}/-/merge_requests`,
      },
      folder,
      async (request) => {
        const diffs = await this.http.getJson(
          this.http.url(`${this.project(path)}/merge_requests/${request.number}/diffs`, {
            page: 1,
            per_page: 100,
          }),
        );
        const entries = asArray(diffs.data, 'merge request diff list');
        const next = diffs.response.headers.get('x-next-page');
        return {
          paths: changedPaths(entries, ['new_path', 'old_path']),
          more: Boolean(next) || nextLink(diffs.response.headers.get('link')) !== null,
        };
      },
    );
  }

  async getRequest(path: string, number: number): Promise<RequestInfo | null> {
    const project = this.project(path);
    if (!Number.isSafeInteger(number) || number < 1) return null;
    try {
      const { data } = await this.http.getJson(this.http.url(`${project}/merge_requests/${number}`));
      return gitlabRequest(data);
    } catch (error) {
      if (error instanceof GitNotFound && error.status === 404) return null;
      throw error;
    }
  }

  async listRequestsUpdatedSince(path: string, since: Date | null, limit: number): Promise<RequestInfo[]> {
    // updated_after is inclusive ("on or after"); the filter below keeps the same rule.
    const { data } = await this.http.getJson(
      this.http.url(`${this.project(path)}/merge_requests`, {
        state: 'all',
        order_by: 'updated_at',
        sort: 'desc',
        updated_after: since ? since.toISOString() : undefined,
        per_page: pageSize(limit),
      }),
    );
    return updatedSince(asArray(data, 'merge request list').map(gitlabRequest), since, limit);
  }

  fileUrl(path: string, branch: string, filePath: string): string {
    return `${this.webBaseUrl}/${repoSegments(path, true).join('/')}/-/blob/${encodeSegments(branch)}/${encodeSegments(filePath)}`;
  }

  verifyWebhook: GitProvider['verifyWebhook'] = (headers, rawBody, secret) =>
    verifyWebhook('gitlab', headers, rawBody, secret);
}
