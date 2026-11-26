import { describe, expect, it } from 'vitest';
import { FIXTURE_TOKEN, loadFixture, replay } from '../test/replay';
import { createProvider } from './create';
import { GitNotFound, GitRateLimited, GitUnauthorized, GitUnreachable } from './errors';
import type { GitLabProvider } from './gitlab';
import type { FetchFn } from './types';

const HEAD = 'a6fd50cecb4bbe630dfb03a621cbe2cedfef4aef';

function gitlab(fixture: string) {
  const server = replay(loadFixture('gitlab', fixture));
  const provider = createProvider({
    provider: 'gitlab',
    host: 'gitlab.com',
    token: FIXTURE_TOKEN,
    fetch: server.fetch,
  });
  return { provider, server };
}

/** The GitLab adapter over `fetch`, typed so its batch read is not optional. */
function gitlabOver(fetch: FetchFn): GitLabProvider {
  return createProvider({
    provider: 'gitlab',
    host: 'gitlab.com',
    token: FIXTURE_TOKEN,
    fetch,
  }) as GitLabProvider;
}

describe('GitLab adapter', () => {
  it('derives the API base URL and sends the token as a bearer token', async () => {
    const { provider, server } = gitlab('whoami');
    expect(provider.apiBaseUrl).toBe('https://gitlab.com/api/v4');
    await expect(provider.whoami()).resolves.toEqual({ login: 'john_smith', repoCount: 12 });
    expect(server.calls.every((call) => call.headers.authorization === `Bearer ${FIXTURE_TOKEN}`)).toBe(true);
    expect(server.unused()).toEqual([]);
  });

  it('whoami still answers when the token cannot list projects', async () => {
    const fetch: FetchFn = async (input) =>
      String(input).endsWith('/user')
        ? Response.json({ username: 'reader' })
        : Response.json({ message: '403 Forbidden' }, { status: 403 });
    const provider = createProvider({ provider: 'gitlab', host: 'gitlab.com', token: FIXTURE_TOKEN, fetch });
    await expect(provider.whoami()).resolves.toEqual({ login: 'reader' });
  });

  it('reads the project with a URL-encoded path, and the branch head', async () => {
    const { provider, server } = gitlab('repository');
    await expect(provider.getRepository('gitlab-org/cli')).resolves.toEqual({
      defaultBranch: 'main',
      webUrl: 'https://gitlab.com/gitlab-org/cli',
    });
    await expect(provider.getBranchHead('gitlab-org/cli', 'main')).resolves.toBe(HEAD);
    expect(server.calls[0]?.url).toBe('https://gitlab.com/api/v4/projects/gitlab-org%2Fcli');
  });

  it('reports an empty project as not found', async () => {
    const { provider } = gitlab('repository-empty');
    await expect(provider.getRepository('acme/empty')).rejects.toMatchObject({
      kind: 'not_found',
      code: 'empty_repository',
    });
  });

  it('lists a folder over keyset pages, following the Link header', async () => {
    const { provider, server } = gitlab('tree');
    const entries = await provider.listTree('gitlab-org/cli', HEAD, 'scripts');
    expect(entries).toEqual([
      { path: 'scripts/bootstrap.sh', blobSha: '6fa64cadf880782844e1c06b89a552efc119532a', size: null },
      {
        path: 'scripts/changed-test-pkgs.sh',
        blobSha: '0eb453a67ec1f140ada18146d48c089cd72d17ec',
        size: null,
      },
      { path: 'scripts/changelog', blobSha: 'dfa6ce431acd893317971096b49b20558065b6e8', size: null },
      {
        path: 'scripts/check-go-version.sh',
        blobSha: 'd350a7e5fef032b49d98b541ce9a850ee1a15fd8',
        size: null,
      },
    ]);
    expect(server.calls).toHaveLength(4);
    expect(server.unused()).toEqual([]);
  });

  it('returns no entries for a missing folder without asking for it', async () => {
    const { provider, server } = gitlab('tree');
    await expect(provider.listTree('gitlab-org/cli', HEAD, 'backlog')).resolves.toEqual([]);
    expect(server.calls).toHaveLength(1);
  });

  it('walks nested folders of a subgroup project and keeps links on the configured origin', async () => {
    const { provider, server } = gitlab('tree-nested');
    const commit = '0000000000000000000000000000000000000001';
    const entries = await provider.listTree('group/sub/app', commit, 'docs/backlog');
    expect(entries.map((entry) => entry.path)).toEqual([
      'docs/backlog/config.yml',
      'docs/backlog/tasks/task-1 - One.md',
    ]);
    expect(
      server.calls.every((call) =>
        call.url.startsWith('https://gitlab.com/api/v4/projects/group%2Fsub%2Fapp/'),
      ),
    ).toBe(true);
    expect(server.unused()).toEqual([]);
  });

  it('reads a raw blob as UTF-8', async () => {
    const { provider } = gitlab('blob');
    const text = await provider.readBlob('gitlab-org/cli', '0eb453a67ec1f140ada18146d48c089cd72d17ec');
    expect(text.startsWith('#!/usr/bin/env bash\n')).toBe(true);
    expect(text.length).toBeGreaterThan(2000);
  });

  it('reads blobs in batches of 100 over GraphQL, keyed by blob hash', async () => {
    const bodies: { project: string; ref: string; paths: string[]; after: string | null }[] = [];
    const urls: string[] = [];
    const fetch: FetchFn = async (input, init) => {
      urls.push(String(input));
      const { variables } = JSON.parse(String(init?.body));
      bodies.push(variables);
      const nodes = (variables.paths as string[]).map((path) => ({
        path,
        oid: `sha-${path}`,
        // A binary file comes back without text; the BOM of a text file is dropped.
        rawTextBlob: path === 'b/image.png' ? null : `\uFEFFtext of ${path}`,
      }));
      return Response.json({
        data: {
          project: { repository: { blobs: { pageInfo: { hasNextPage: false, endCursor: null }, nodes } } },
        },
      });
    };
    const provider = gitlabOver(fetch);
    const files = Array.from({ length: 250 }, (_, index) => ({
      path: `b/t-${index}.md`,
      blobSha: `sha-b/t-${index}.md`,
    }));
    files.push({ path: 'b/image.png', blobSha: 'sha-b/image.png' });
    // Changed since the listing: the hash no longer matches, so the caller reads it alone.
    files.push({ path: 'b/stale.md', blobSha: 'old-sha' });
    const contents = await provider.readBlobs('group/sub/repo', HEAD, files);
    expect(urls).toEqual(Array(3).fill('https://gitlab.com/api/graphql'));
    expect(bodies.map((body) => body.paths.length)).toEqual([100, 100, 52]);
    expect(bodies[0]).toMatchObject({ project: 'group/sub/repo', ref: HEAD, after: null });
    expect(contents.size).toBe(250);
    expect(contents.get('sha-b/t-0.md')).toBe('text of b/t-0.md');
    expect(contents.has('sha-b/image.png')).toBe(false);
    expect(contents.has('old-sha')).toBe(false);
  });

  it('follows GraphQL pages within a batch', async () => {
    let calls = 0;
    const fetch: FetchFn = async (_input, init) => {
      const { variables } = JSON.parse(String(init?.body));
      calls += 1;
      const first = variables.after === null;
      return Response.json({
        data: {
          project: {
            repository: {
              blobs: {
                pageInfo: { hasNextPage: first, endCursor: first ? 'cursor-1' : null },
                nodes: [{ path: first ? 'a.md' : 'b.md', oid: first ? 'a' : 'b', rawTextBlob: 'x' }],
              },
            },
          },
        },
      });
    };
    const provider = gitlabOver(fetch);
    const contents = await provider.readBlobs('acme/repo', HEAD, [
      { path: 'a.md', blobSha: 'a' },
      { path: 'b.md', blobSha: 'b' },
    ]);
    expect(calls).toBe(2);
    expect([...contents.keys()]).toEqual(['a', 'b']);
  });

  it('maps GraphQL failures to typed errors', async () => {
    const answer =
      (body: unknown, status = 200): FetchFn =>
      async () =>
        Response.json(body, { status });
    const read = (fetch: FetchFn) =>
      gitlabOver(fetch).readBlobs('acme/repo', HEAD, [{ path: 'a.md', blobSha: 'a' }]);
    await expect(read(answer({ data: { project: null } }))).rejects.toBeInstanceOf(GitNotFound);
    await expect(read(answer({ errors: [{ message: 'complexity' }] }))).rejects.toMatchObject({
      kind: 'unexpected',
    });
    await expect(read(answer({ message: 'Retry later' }, 429))).rejects.toBeInstanceOf(GitRateLimited);
  });

  it('reads one file at a ref, and null for a missing one', async () => {
    const { provider } = gitlab('read-file');
    await expect(provider.readFile('acme/app', 'main', 'backlog.config.yml')).resolves.toEqual({
      content: 'backlog_directory: planning\n',
      blobSha: '0000000000000000000000000000000000000014',
    });
    const again = gitlab('read-file');
    await expect(again.provider.readFile('acme/app', 'main', 'nope.yml')).resolves.toBeNull();
  });

  it('builds file links in the /-/blob form', () => {
    const { provider } = gitlab('whoami');
    expect(provider.fileUrl('group/sub/app', 'main', 'backlog/tasks/task-1 - A.md')).toBe(
      'https://gitlab.com/group/sub/app/-/blob/main/backlog/tasks/task-1%20-%20A.md',
    );
  });

  it('maps error statuses to typed errors', async () => {
    const { provider } = gitlab('errors');
    const caught = async (promise: Promise<unknown>) => promise.catch((error: unknown) => error);
    const unauthorized = await caught(provider.whoami());
    expect(unauthorized).toBeInstanceOf(GitUnauthorized);
    await expect(provider.getRepository('acme/missing')).rejects.toBeInstanceOf(GitNotFound);
    await expect(provider.getRepository('acme/forbidden')).rejects.toMatchObject({
      kind: 'unauthorized',
      code: 'forbidden',
    });
    const limited = await caught(provider.getRepository('acme/limited'));
    expect(limited).toBeInstanceOf(GitRateLimited);
    expect(limited).toMatchObject({ retryAfterSeconds: 45 });
    await expect(provider.getRepository('acme/down')).rejects.toBeInstanceOf(GitUnreachable);
    expect(String(unauthorized)).not.toContain(FIXTURE_TOKEN);
  });

  it('needs at least two path segments', async () => {
    const { provider } = gitlab('whoami');
    await expect(provider.getRepository('app')).rejects.toBeInstanceOf(GitNotFound);
  });
});

describe('GitLab open merge requests (M6)', () => {
  it('lists open merge requests with a diff under the folder, old paths included', async () => {
    const { provider, server } = gitlab('open-requests');
    await expect(provider.listOpenRequests?.('gitlab-org/cli', 'backlog')).resolves.toEqual({
      requests: [
        {
          number: 77,
          title: 'Close BACK-4',
          author: 'ana-dev',
          headBranch: 'task/back-4',
          webUrl: 'https://gitlab.com/gitlab-org/cli/-/merge_requests/77',
        },
        {
          number: 75,
          title: 'Rename a task file away',
          author: 'octocat',
          headBranch: 'chore/rename',
          webUrl: 'https://gitlab.com/gitlab-org/cli/-/merge_requests/75',
        },
      ],
      truncated: false,
      listUrl: 'https://gitlab.com/gitlab-org/cli/-/merge_requests',
    });
    expect(server.unused()).toEqual([]);
  });

  it('says the list may be cut on a second page of requests or of diffs', async () => {
    const { provider } = gitlab('open-requests-many');
    await expect(provider.listOpenRequests?.('gitlab-org/cli', 'backlog')).resolves.toMatchObject({
      requests: [],
      truncated: true,
    });
  });
});

describe('GitLab merge requests (M7)', () => {
  const project = 'northwind/platform/payments';

  it('reads one merge request in each state, and null for an iid that is not one', async () => {
    const { provider, server } = gitlab('requests');
    await expect(provider.getRequest?.(project, 74)).resolves.toEqual({
      number: 74,
      title: 'Add refunds endpoint',
      body: '',
      state: 'merged',
      headBranch: 'task/pay-74',
      baseBranch: 'main',
      author: 'claude-dev',
      mergedBy: 'ana-dev',
      webUrl: 'https://gitlab.com/northwind/platform/payments/-/merge_requests/74',
      openedAt: '2026-11-20T09:00:00.000Z',
      mergedAt: '2026-11-24T18:05:00.000Z',
      closedAt: '2026-11-24T18:05:00.000Z',
      updatedAt: '2026-11-24T18:05:01.000Z',
    });
    // Older releases name the merger in merged_by only, and drafts in work_in_progress.
    await expect(provider.getRequest?.(project, 72)).resolves.toMatchObject({
      state: 'merged',
      mergedBy: 'ana-dev',
    });
    await expect(provider.getRequest?.(project, 71)).resolves.toMatchObject({ state: 'draft' });
    await expect(provider.getRequest?.(project, 73)).resolves.toMatchObject({
      state: 'closed',
      mergedAt: null,
      closedAt: '2026-11-22T09:30:00.000Z',
    });
    await expect(provider.getRequest?.(project, 12)).resolves.toBeNull();
    expect(server.calls.map((call) => new URL(call.url).pathname)).toEqual([
      '/api/v4/projects/northwind%2Fplatform%2Fpayments/merge_requests/74',
      '/api/v4/projects/northwind%2Fplatform%2Fpayments/merge_requests/72',
      '/api/v4/projects/northwind%2Fplatform%2Fpayments/merge_requests/71',
      '/api/v4/projects/northwind%2Fplatform%2Fpayments/merge_requests/73',
      '/api/v4/projects/northwind%2Fplatform%2Fpayments/merge_requests/12',
    ]);
  });

  it('lists merge requests by update, passing the time to the API; locked counts as open', async () => {
    const all = gitlab('requests');
    const list = await all.provider.listRequestsUpdatedSince?.(project, null, 100);
    expect(list?.map((request) => [request.number, request.state])).toEqual([
      [77, 'open'],
      [76, 'draft'],
      [75, 'open'],
      [74, 'merged'],
      [73, 'closed'],
    ]);
    expect(list?.[0]?.body).toBe('Closes: PAY-12');

    const since = gitlab('requests');
    const recent = await since.provider.listRequestsUpdatedSince?.(
      project,
      new Date('2026-11-25T00:00:00.000Z'),
      50,
    );
    expect(recent?.map((request) => request.number)).toEqual([77, 76, 75]);
    expect(new URL(since.server.calls[0]?.url ?? '').searchParams.get('updated_after')).toBe(
      '2026-11-25T00:00:00.000Z',
    );
    expect([...all.server.calls, ...since.server.calls].map((call) => call.method)).toEqual(['GET', 'GET']);
  });

  it('a token GitLab rejects stays out of the error', async () => {
    const server = replay({
      description: 'A revoked token.',
      source: 'Hand-written from the GitLab REST docs.',
      exchanges: [
        {
          request: {
            url: 'https://gitlab.com/api/v4/projects/northwind%2Fplatform%2Fpayments/merge_requests/9',
          },
          response: { status: 401, json: { message: '401 Unauthorized' } },
        },
      ],
    });
    const provider = gitlabOver(server.fetch);
    const error = await provider.getRequest(project, 9).catch((caught: unknown) => caught);
    expect(error).toBeInstanceOf(GitUnauthorized);
    expect(JSON.stringify(error)).not.toContain(FIXTURE_TOKEN);
    expect(String(error)).not.toContain(FIXTURE_TOKEN);
  });
});
