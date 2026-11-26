// GitHub and GitHub Enterprise Server, REST API version 2022-11-28 (supported on github.com until
// March 2028 and the version GHES releases understand).
// Docs: https://docs.github.com/en/rest/git/trees, /git/blobs, /branches/branches, /repos/repos,
// /users/users, /pulls/pulls (list pull requests, get a pull request, list pull request files).

import { GitNotFound, GitUnexpected } from './errors';
import { type FetchTree, listTreeByWalk, rawEntry, readFileByWalk } from './git-trees';
import {
  asArray,
  asRecord,
  decodeBase64,
  encodeSegments,
  type HttpClient,
  nextLink,
  stringField,
} from './http';
import { changedPaths, loginOf, requestsUnderFolder } from './open-requests';
import { repoSegments } from './paths';
import { githubRequest, pageSize, updatedSince } from './requests';
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

export const GITHUB_API_VERSION = '2022-11-28';

export class GitHubProvider implements GitProvider {
  readonly provider = 'github' as const;

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
    const user = asRecord(data, 'user');
    const login = stringField(user, 'login', 'the user');
    const { public_repos: publicRepos, total_private_repos: privateRepos } = user;
    if (typeof publicRepos !== 'number') return { login };
    return { login, repoCount: publicRepos + (typeof privateRepos === 'number' ? privateRepos : 0) };
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
    return stringField(
      asRecord(asRecord(data, 'branch').commit, 'branch commit'),
      'sha',
      'the branch commit',
    );
  }

  private fetchTree(path: string): FetchTree {
    return async (sha, recursive) => {
      const { data } = await this.http.getJson(
        this.http.url(`${this.repo(path)}/git/trees/${encodeURIComponent(sha)}`, {
          recursive: recursive ? 1 : undefined,
        }),
      );
      const tree = asRecord(data, 'tree');
      return { entries: asArray(tree.tree, 'tree').map(rawEntry), truncated: tree.truncated === true };
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
    const content = typeof blob.content === 'string' ? blob.content : '';
    return blob.encoding === 'utf-8' ? content : decodeBase64(content);
  }

  readFile(path: string, ref: string, filePath: string): Promise<FileContent | null> {
    return readFileByWalk(this.fetchTree(path), (sha) => this.readBlob(path, sha), ref, filePath);
  }

  async listOpenRequests(path: string, folder: string): Promise<OpenRequestList> {
    // One page of the newest open pull requests (100 is GitHub's page limit).
    const { data, response } = await this.http.getJson(
      this.http.url(`${this.repo(path)}/pulls`, {
        state: 'open',
        sort: 'created',
        direction: 'desc',
        per_page: MAX_OPEN_REQUESTS,
      }),
    );
    const requests = asArray(data, 'pull request list').map((value): OpenRequest => {
      const pull = asRecord(value, 'pull request');
      const number = pull.number;
      if (typeof number !== 'number')
        throw new GitUnexpected('The provider sent a pull request without a number.');
      return {
        number,
        title: typeof pull.title === 'string' ? pull.title : '',
        author: loginOf(pull.user, 'login'),
        headBranch: stringField(asRecord(pull.head, 'pull request head'), 'ref', 'a pull request head'),
        webUrl: stringField(pull, 'html_url', 'a pull request'),
      };
    });
    return requestsUnderFolder(
      {
        requests,
        more: nextLink(response.headers.get('link')) !== null,
        listUrl: `${this.webBaseUrl}/${repoSegments(path, false).join('/')}/pulls`,
      },
      folder,
      async (request) => {
        const files = await this.http.getJson(
          this.http.url(`${this.repo(path)}/pulls/${request.number}/files`, { per_page: 100 }),
        );
        const entries = asArray(files.data, 'pull request file list');
        return {
          paths: changedPaths(entries, ['filename', 'previous_filename']),
          more: nextLink(files.response.headers.get('link')) !== null,
        };
      },
    );
  }

  async getRequest(path: string, number: number): Promise<RequestInfo | null> {
    const repo = this.repo(path);
    if (!Number.isSafeInteger(number) || number < 1) return null;
    try {
      const { data } = await this.http.getJson(this.http.url(`${repo}/pulls/${number}`));
      return githubRequest(data);
    } catch (error) {
      if (error instanceof GitNotFound && error.status === 404) return null;
      throw error;
    }
  }

  async listRequestsUpdatedSince(path: string, since: Date | null, limit: number): Promise<RequestInfo[]> {
    // GitHub has no "updated since" filter on pulls: newest updates first, then cut at `since`.
    const { data } = await this.http.getJson(
      this.http.url(`${this.repo(path)}/pulls`, {
        state: 'all',
        sort: 'updated',
        direction: 'desc',
        per_page: pageSize(limit),
      }),
    );
    return updatedSince(asArray(data, 'pull request list').map(githubRequest), since, limit);
  }

  fileUrl(path: string, branch: string, filePath: string): string {
    return `${this.webBaseUrl}/${repoSegments(path, false).join('/')}/blob/${encodeSegments(branch)}/${encodeSegments(filePath)}`;
  }

  verifyWebhook: GitProvider['verifyWebhook'] = (headers, rawBody, secret) =>
    verifyWebhook('github', headers, rawBody, secret);
}
