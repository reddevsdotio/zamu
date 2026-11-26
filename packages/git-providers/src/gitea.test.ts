import { describe, expect, it } from 'vitest';
import { FIXTURE_TOKEN, loadFixture, replay } from '../test/replay';
import { createProvider } from './create';
import { GitNotFound, GitUnauthorized, GitUnexpected } from './errors';

const HEAD = '65faeb1c07bbc43cbc3ac32aef19a7671500dd78';
const FORGEJO_PATHS = [
  '.forgejo/renovate.json',
  '.forgejo/workflows/backport.yml',
  '.forgejo/workflows/cli.yml',
  '.forgejo/workflows/links.yml',
  '.forgejo/workflows/pr.yml',
  '.forgejo/workflows/push.yml',
];

function gitea(fixture: string) {
  const server = replay(loadFixture('gitea', fixture));
  const provider = createProvider({
    provider: 'gitea',
    host: 'codeberg.org',
    token: FIXTURE_TOKEN,
    fetch: server.fetch,
  });
  return { provider, server };
}

describe('Gitea and Forgejo adapter', () => {
  it('derives the API base URL and sends the token with the token scheme', async () => {
    const { provider, server } = gitea('whoami');
    expect(provider.apiBaseUrl).toBe('https://codeberg.org/api/v1');
    await expect(provider.whoami()).resolves.toEqual({ login: 'forgejo-admin', repoCount: 5 });
    expect(server.calls[0]?.headers.authorization).toBe(`token ${FIXTURE_TOKEN}`);
  });

  it('uses http:// when the host is allowed plain HTTP', () => {
    const provider = createProvider({
      provider: 'gitea',
      host: 'localhost:3300',
      token: 'x',
      allowHttp: true,
    });
    expect(provider.apiBaseUrl).toBe('http://localhost:3300/api/v1');
    expect(provider.webBaseUrl).toBe('http://localhost:3300');
  });

  it('reads the repository and the branch head', async () => {
    const { provider } = gitea('repository');
    await expect(provider.getRepository('forgejo/docs')).resolves.toEqual({
      defaultBranch: 'next',
      webUrl: 'https://codeberg.org/forgejo/docs',
    });
    await expect(provider.getBranchHead('forgejo/docs', 'next')).resolves.toBe(HEAD);
  });

  it('lists a folder: root lookup, then the recursive listing', async () => {
    const { provider, server } = gitea('tree');
    const entries = await provider.listTree('forgejo/docs', HEAD, '.forgejo');
    expect(entries.map((entry) => entry.path)).toEqual(FORGEJO_PATHS);
    expect(entries[0]).toEqual({
      path: '.forgejo/renovate.json',
      blobSha: '4f638b14b1a436658c78cfadc7e9bacd7c3c88d2',
      size: 471,
    });
    expect(server.unused()).toEqual([]);
  });

  it('pages by total_count, since Forgejo keeps truncated=true on the last page', async () => {
    const { provider, server } = gitea('tree-paged');
    const entries = await provider.listTree('forgejo/docs', HEAD, '.forgejo');
    expect(entries.map((entry) => entry.path)).toEqual(FORGEJO_PATHS);
    expect(server.calls).toHaveLength(4);
    expect(server.unused()).toEqual([]);
  });

  it('returns no entries for a missing folder', async () => {
    const { provider } = gitea('tree');
    await expect(provider.listTree('forgejo/docs', HEAD, 'backlog')).resolves.toEqual([]);
  });

  it('reads a blob as UTF-8', async () => {
    const { provider } = gitea('blob');
    const text = await provider.readBlob('forgejo/docs', '4f638b14b1a436658c78cfadc7e9bacd7c3c88d2');
    expect(JSON.parse(text)).toBeTypeOf('object');
    expect(Buffer.byteLength(text)).toBe(471);
  });

  it('builds file links in the /src/branch form', () => {
    const { provider } = gitea('whoami');
    expect(provider.fileUrl('forgejo/docs', 'next', 'backlog/tasks/task-1 - A.md')).toBe(
      'https://codeberg.org/forgejo/docs/src/branch/next/backlog/tasks/task-1%20-%20A.md',
    );
  });

  it('maps errors and never repeats the token Forgejo echoes in its 401 body', async () => {
    const { provider } = gitea('errors');
    const unauthorized = await provider.whoami().catch((error: unknown) => error);
    expect(unauthorized).toBeInstanceOf(GitUnauthorized);
    expect((unauthorized as Error).message).not.toContain(FIXTURE_TOKEN);
    expect(JSON.stringify(unauthorized)).not.toContain(FIXTURE_TOKEN);
    await expect(provider.getRepository('forgejo/nothing-xyz')).rejects.toBeInstanceOf(GitNotFound);
    await expect(
      provider.readBlob('forgejo/docs', '0000000000000000000000000000000000000001'),
    ).rejects.toBeInstanceOf(GitUnexpected);
  });
});

describe('Gitea and Forgejo open pull requests (M6)', () => {
  it('pages through open pull requests and keeps the ones with a file under the folder', async () => {
    const { provider, server } = gitea('open-requests');
    const result = await provider.listOpenRequests?.('forgejo/docs', 'docs/backlog');
    expect(result?.requests).toEqual([
      {
        number: 1200,
        title: 'Pull 1200',
        author: 'hubot',
        headBranch: 'branch-1200',
        webUrl: 'https://codeberg.org/forgejo/docs/pulls/1200',
      },
      {
        number: 1149,
        title: 'Pull 1149',
        author: 'octocat',
        headBranch: 'branch-1149',
        webUrl: 'https://codeberg.org/forgejo/docs/pulls/1149',
      },
    ]);
    // 52 requests fit under the cap, but #1199 changes 60 files and only 50 were looked at.
    expect(result?.truncated).toBe(true);
    expect(result?.listUrl).toBe('https://codeberg.org/forgejo/docs/pulls');
    expect(server.unused()).toEqual([]);
  });
});

describe('Gitea and Forgejo pull requests (M7)', () => {
  function forgejo() {
    const server = replay(loadFixture('gitea', 'requests'));
    const provider = createProvider({
      provider: 'gitea',
      host: 'forgejo.example.com',
      token: FIXTURE_TOKEN,
      fetch: server.fetch,
    });
    return { provider, server };
  }

  it('reads one pull request, with drafts from the flag or the title prefix', async () => {
    const { provider } = forgejo();
    await expect(provider.getRequest?.('northwind/payments', 1202)).resolves.toEqual({
      number: 1202,
      title: 'Add refunds endpoint',
      body: '',
      state: 'merged',
      headBranch: 'task/pay-1202',
      baseBranch: 'main',
      author: 'claude-dev',
      mergedBy: 'ana-dev',
      webUrl: 'https://forgejo.example.com/northwind/payments/pulls/1202',
      openedAt: '2026-11-20T09:00:00.000Z',
      mergedAt: '2026-11-24T18:05:00.000Z',
      closedAt: '2026-11-24T18:05:00.000Z',
      updatedAt: '2026-11-24T18:05:00.000Z',
    });
    await expect(provider.getRequest?.('northwind/payments', 1203)).resolves.toMatchObject({
      state: 'draft',
      title: 'WIP: split the ledger',
    });
    // A release without the draft field: the [WIP] prefix decides.
    await expect(provider.getRequest?.('northwind/payments', 1100)).resolves.toMatchObject({
      state: 'draft',
    });
    await expect(provider.getRequest?.('northwind/payments', 12)).resolves.toBeNull();
  });

  it('lists pull requests by recent update in one page', async () => {
    const { provider, server } = forgejo();
    const list = await provider.listRequestsUpdatedSince?.('northwind/payments', null, 100);
    expect(list?.map((request) => [request.number, request.state, request.updatedAt])).toEqual([
      [1204, 'open', '2026-11-25T16:40:00.000Z'],
      [1203, 'draft', '2026-11-25T12:00:00.000Z'],
      [1202, 'merged', '2026-11-24T18:05:00.000Z'],
      [1201, 'closed', '2026-11-22T09:30:00.000Z'],
    ]);
    expect(list?.[0]?.body).toBe('Closes: PAY-12');
    expect(server.calls).toHaveLength(1);
  });

  it('sends only GET requests and never repeats the token Forgejo echoes', async () => {
    const { provider, server } = forgejo();
    await provider.getRequest?.('northwind/payments', 1202);
    await provider.listRequestsUpdatedSince?.('northwind/payments', new Date('2026-11-25T00:00:00Z'), 100);
    const errors = [
      await provider.getRequest?.('northwind/payments', 1199).catch((caught: unknown) => caught),
      await provider
        .listRequestsUpdatedSince?.('northwind/payments', null, 100)
        .catch((caught: unknown) => caught),
    ];
    for (const error of errors) {
      expect(error).toBeInstanceOf(GitUnauthorized);
      expect(String(error)).not.toContain(FIXTURE_TOKEN);
      expect(JSON.stringify(error)).not.toContain(FIXTURE_TOKEN);
    }
    expect(server.calls.map((call) => call.method)).toEqual(['GET', 'GET', 'GET', 'GET']);
    expect(server.unused()).toEqual([
      'https://forgejo.example.com/api/v1/repos/northwind/payments/pulls/1203',
      'https://forgejo.example.com/api/v1/repos/northwind/payments/pulls/1100',
      'https://forgejo.example.com/api/v1/repos/northwind/payments/pulls/12',
    ]);
  });
});
