// Gitea and Forgejo, API v1. Checked against the Forgejo 17 swagger (codeberg.org/swagger.v1.json)
// and its source (services/repository/files/tree.go). Pull request lists and their changed files
// (repos/{owner}/{repo}/pulls, pulls/{index}/files) page with page and limit; the server caps limit
// at [api] MAX_RESPONSE_ITEMS (50 by default) and sends the total in X-Total-Count. M7 reads single
// pull requests (pulls/{index}) and the most recently updated ones (pulls?state=all&sort=recentupdate,
// one page: the API has no "updated since" filter).
//
// Tree listings are paged with page and per_page; the server caps per_page at
// [api] DEFAULT_GIT_TREES_PER_PAGE (1000 by default). Forgejo sets `truncated` to true on every page
// whenever the tree has more entries than one page holds, the last page included, so the loop
// follows total_count and stops at an empty page instead of trusting `truncated`.

import { GitNotFound, GitUnauthorized, GitUnexpected } from './errors';
import { type FetchTree, listTreeByWalk, type RawTreeEntry, rawEntry, readFileByWalk } from './git-trees';
import { asArray, asRecord, decodeBase64, encodeSegments, type HttpClient, stringField } from './http';
import { changedPaths, loginOf, requestsUnderFolder } from './open-requests';
import { repoSegments } from './paths';
import { giteaRequest, pageSize, updatedSince } from './requests';
import {
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

const TREE_PAGE_SIZE = 1000;
const MAX_TREE_PAGES = 10_000;
/** Page size for pull requests and their files: Forgejo's default MAX_RESPONSE_ITEMS. */
const PULL_PAGE_SIZE = 50;

export class GiteaProvider implements GitProvider {
  readonly provider = 'gitea' as const;

  constructor(
    readonly host: string,
    readonly apiBaseUrl: string,
    readonly webBaseUrl: string,
    private readonly http: HttpClient,
  ) {}

  private repo(path: string): string {
    const [owner, name] = repoSegments(path, false) as [string, string];
    return `/repos/${encodeURIComponent(owner)}/${encodeURIComponent(name)}`;
  }

  async whoami(): Promise<Whoami> {
    const { data } = await this.http.getJson(this.http.url('/user'));
    const login = stringField(asRecord(data, 'user'), 'login', 'the user');
    try {
      const { response } = await this.http.getJson(this.http.url('/user/repos', { limit: 1 }));
      const total = Number(response.headers.get('x-total-count'));
      return Number.isFinite(total) && response.headers.has('x-total-count')
        ? { login, repoCount: total }
        : { login };
    } catch (error) {
      // A token scoped without repository access still identifies its user.
      if (error instanceof GitUnauthorized || error instanceof GitNotFound) return { login };
      throw error;
    }
  }

  async getRepository(path: string): Promise<RepositoryInfo> {
    const { data } = await this.http.getJson(this.http.url(this.repo(path)));
    const repo = asRecord(data, 'repository');
    return {
      defaultBranch: stringField(repo, 'default_branch', 'the repository'),
      webUrl: stringField(repo, 'html_url', 'the repository'),
    };
  }

  async getBranchHead(path: string, branch: string): Promise<string> {
    const { data } = await this.http.getJson(
      this.http.url(`${this.repo(path)}/branches/${encodeSegments(branch)}`),
    );
    return stringField(asRecord(asRecord(data, 'branch').commit, 'branch commit'), 'id', 'the branch commit');
  }

  private fetchTree(path: string): FetchTree {
    return async (sha, recursive) => {
      const entries: RawTreeEntry[] = [];
      for (let page = 1; page <= MAX_TREE_PAGES; page++) {
        const { data } = await this.http.getJson(
          this.http.url(`${this.repo(path)}/git/trees/${encodeURIComponent(sha)}`, {
            recursive: recursive ? true : undefined,
            page,
            per_page: TREE_PAGE_SIZE,
          }),
        );
        const tree = asRecord(data, 'tree');
        // An empty tree comes back with "tree": null.
        const pageEntries = tree.tree === null || tree.tree === undefined ? [] : asArray(tree.tree, 'tree');
        entries.push(...pageEntries.map(rawEntry));
        const total = tree.total_count;
        const done =
          pageEntries.length === 0 ||
          (typeof total === 'number' ? entries.length >= total : tree.truncated !== true);
        if (done) return { entries, truncated: false };
      }
      throw new GitUnexpected('The provider kept sending tree pages.');
    };
  }

  listTree(path: string, commit: string, folder: string): Promise<TreeEntry[]> {
    return listTreeByWalk(this.fetchTree(path), commit, folder);
  }

  async readBlob(path: string, blobSha: string): Promise<string> {
    const { data } = await this.http.getJson(
      this.http.url(`${this.repo(path)}/git/blobs/${encodeURIComponent(blobSha)}`),
    );
    const blob = asRecord(data, 'blob');
    return decodeBase64(typeof blob.content === 'string' ? blob.content : '');
  }

  readFile(path: string, ref: string, filePath: string): Promise<FileContent | null> {
    return readFileByWalk(this.fetchTree(path), (sha) => this.readBlob(path, sha), ref, filePath);
  }

  async listOpenRequests(path: string, folder: string): Promise<OpenRequestList> {
    const requests: OpenRequest[] = [];
    let more = false;
    // Newest first (the default order), until MAX_OPEN_REQUESTS are in or a page comes back short.
    for (let page = 1; requests.length < MAX_OPEN_REQUESTS; page++) {
      const { data, response } = await this.http.getJson(
        this.http.url(`${this.repo(path)}/pulls`, { state: 'open', page, limit: PULL_PAGE_SIZE }),
      );
      const entries = asArray(data, 'pull request list');
      for (const value of entries) {
        const pull = asRecord(value, 'pull request');
        const number = pull.number;
        if (typeof number !== 'number') {
          throw new GitUnexpected('The provider sent a pull request without a number.');
        }
        requests.push({
          number,
          title: typeof pull.title === 'string' ? pull.title : '',
          author: loginOf(pull.user, 'login'),
          headBranch: stringField(asRecord(pull.head, 'pull request head'), 'ref', 'a pull request head'),
          webUrl: stringField(pull, 'html_url', 'a pull request'),
        });
      }
      const total = Number(response.headers.get('x-total-count'));
      const known = response.headers.has('x-total-count') && Number.isFinite(total);
      if (known && total <= requests.length) break;
      if (entries.length === 0 || (!known && entries.length < PULL_PAGE_SIZE)) break;
      if (requests.length >= MAX_OPEN_REQUESTS) {
        more = known ? total > MAX_OPEN_REQUESTS : true;
        break;
      }
    }
    return requestsUnderFolder(
      {
        requests,
        more,
        listUrl: `${this.webBaseUrl}/${repoSegments(path, false).join('/')}/pulls`,
      },
      folder,
      async (request) => {
        const { data, response } = await this.http.getJson(
          this.http.url(`${this.repo(path)}/pulls/${request.number}/files`, {
            page: 1,
            limit: PULL_PAGE_SIZE,
          }),
        );
        const entries = asArray(data, 'pull request file list');
        const total = Number(response.headers.get('x-total-count'));
        const more =
          response.headers.has('x-total-count') && Number.isFinite(total)
            ? total > entries.length
            : entries.length >= PULL_PAGE_SIZE;
        return { paths: changedPaths(entries, ['filename', 'previous_filename']), more };
      },
    );
  }

  async getRequest(path: string, number: number): Promise<RequestInfo | null> {
    const repo = this.repo(path);
    if (!Number.isSafeInteger(number) || number < 1) return null;
    try {
      const { data } = await this.http.getJson(this.http.url(`${repo}/pulls/${number}`));
      return giteaRequest(data);
    } catch (error) {
      if (error instanceof GitNotFound && error.status === 404) return null;
      throw error;
    }
  }

  async listRequestsUpdatedSince(path: string, since: Date | null, limit: number): Promise<RequestInfo[]> {
    const { data } = await this.http.getJson(
      this.http.url(`${this.repo(path)}/pulls`, {
        state: 'all',
        sort: 'recentupdate',
        page: 1,
        limit: pageSize(limit),
      }),
    );
    return updatedSince(asArray(data, 'pull request list').map(giteaRequest), since, limit);
  }

  fileUrl(path: string, branch: string, filePath: string): string {
    return `${this.webBaseUrl}/${repoSegments(path, false).join('/')}/src/branch/${encodeSegments(branch)}/${encodeSegments(filePath)}`;
  }

  verifyWebhook: GitProvider['verifyWebhook'] = (headers, rawBody, secret) =>
    verifyWebhook('gitea', headers, rawBody, secret);
}
