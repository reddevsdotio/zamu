import { describe, expect, it } from 'vitest';
import { FIXTURE_TOKEN, loadFixture, replay } from '../test/replay';
import { createProvider } from './create';
import { GitNotFound, GitRateLimited, GitUnauthorized, GitUnexpected, GitUnreachable } from './errors';

const NOW = 1_792_779_940_000; // 60 seconds before the x-ratelimit-reset in errors.json

function github(fixture: string | string[], host = 'github.com') {
  const fixtures = (Array.isArray(fixture) ? fixture : [fixture]).map((name) => loadFixture('github', name));
  const server = replay(...fixtures);
  const provider = createProvider({
    provider: 'github',
    host,
    token: FIXTURE_TOKEN,
    fetch: server.fetch,
    now: () => NOW,
  });
  return { provider, server };
}

describe('GitHub adapter', () => {
  it('derives the API and web base URLs', () => {
    const { provider } = github('whoami');
    expect(provider.apiBaseUrl).toBe('https://api.github.com');
    expect(provider.webBaseUrl).toBe('https://github.com');
    const enterprise = createProvider({ provider: 'github', host: 'GHE.example.com', token: 'x' });
    expect(enterprise.host).toBe('ghe.example.com');
    expect(enterprise.apiBaseUrl).toBe('https://ghe.example.com/api/v3');
  });

  it('whoami returns the login and the public plus private repository count', async () => {
    const { provider, server } = github('whoami');
    await expect(provider.whoami()).resolves.toEqual({ login: 'octocat', repoCount: 11 });
    const [call] = server.calls;
    expect(call?.headers.authorization).toBe(`Bearer ${FIXTURE_TOKEN}`);
    expect(call?.headers['x-github-api-version']).toBe('2022-11-28');
    expect(call?.headers.accept).toBe('application/json');
    expect(call?.headers['user-agent']).toBeTruthy();
    expect(call?.redirect).toBe('manual');
  });

  it('whoami on GitHub Enterprise with the public user schema counts public repositories', async () => {
    const { provider } = github('enterprise', 'ghe.example.com');
    await expect(provider.whoami()).resolves.toEqual({ login: 'hubot', repoCount: 4 });
  });

  it('reads the repository and the branch head', async () => {
    const { provider, server } = github('repository');
    await expect(provider.getRepository('MrLesk/Backlog.md')).resolves.toEqual({
      defaultBranch: 'main',
      webUrl: 'https://github.com/MrLesk/Backlog.md',
    });
    await expect(provider.getBranchHead('MrLesk/Backlog.md', 'main')).resolves.toBe(
      '6f988de052b8d8ef2eac2828ade7d8690ac7213f',
    );
    expect(server.unused()).toEqual([]);
  });

  it('lists a folder: root lookup, then one recursive call; blobs only, with full paths', async () => {
    const { provider, server } = github('tree');
    const entries = await provider.listTree(
      'MrLesk/Backlog.md',
      '6f988de052b8d8ef2eac2828ade7d8690ac7213f',
      'backlog/',
    );
    expect(server.calls).toHaveLength(2);
    expect(entries.map((entry) => entry.path)).toEqual([
      'backlog/archive/drafts/readme.md',
      'backlog/config.yml',
      'backlog/drafts/draft-1 - Agents-add-board-export-step-to-agent-DoD.md',
      'backlog/tasks/back-200 - Add-Claude-Code-integration-with-workflow-commands-during-init.md',
      'backlog/tasks/back-208 - Add-paste-as-markdown-support-in-Web-UI.md',
      'backlog/tasks/back-222 - Improve-task-and-subtask-visualization-in-web-UI.md',
    ]);
    for (const entry of entries) {
      expect(entry.path.startsWith('backlog/')).toBe(true);
      expect(entry.blobSha).toMatch(/^[0-9a-f]{40}$/);
      expect(typeof entry.size).toBe('number');
    }
    expect(entries.find((entry) => entry.path === 'backlog/archive/drafts/readme.md')).toEqual({
      path: 'backlog/archive/drafts/readme.md',
      blobSha: '0ce5121b11a1529729c96bff8616ec5ba65857ea',
      size: 93,
    });
  });

  it('returns no entries when the folder does not exist', async () => {
    const { provider, server } = github('tree');
    await expect(
      provider.listTree('MrLesk/Backlog.md', '6f988de052b8d8ef2eac2828ade7d8690ac7213f', '.backlog'),
    ).resolves.toEqual([]);
    expect(server.calls).toHaveLength(1);
    // A file where a folder is expected is not a folder either.
    const again = github('tree');
    await expect(
      again.provider.listTree('MrLesk/Backlog.md', '6f988de052b8d8ef2eac2828ade7d8690ac7213f', 'README.md'),
    ).resolves.toEqual([]);
  });

  it('walks subtrees when the recursive listing is truncated, skipping symlinks and submodules', async () => {
    const { provider, server } = github('tree-truncated');
    const entries = await provider.listTree(
      'acme/big',
      '00000000000000000000000000000000000000c0',
      'backlog',
    );
    expect(entries.map((entry) => entry.path).sort()).toEqual([
      'backlog/config.yml',
      'backlog/tasks/nested/task-3 - Third.md',
      'backlog/tasks/task-1 - First.md',
      'backlog/tasks/task-2 - Second.md',
    ]);
    expect(server.calls).toHaveLength(5);
    expect(server.unused()).toEqual([]);
  });

  it('reads a blob as UTF-8', async () => {
    const { provider } = github('blob');
    await expect(
      provider.readBlob('MrLesk/Backlog.md', '0ce5121b11a1529729c96bff8616ec5ba65857ea'),
    ).resolves.toBe(
      '# Archived Drafts\n\nDrafts that were removed from the drafts list but are kept for reference.\n',
    );
  });

  it('reads one file at a ref, and null for a missing file', async () => {
    const { provider } = github('read-file');
    await expect(provider.readFile('acme/big', 'main', 'backlog.config.yml')).resolves.toEqual({
      content: 'backlog_directory: planning\n',
      blobSha: '00000000000000000000000000000000000000b5',
    });
    const missing = github('read-file');
    await expect(missing.provider.readFile('acme/big', 'main', 'missing.yml')).resolves.toBeNull();
    const folder = github('read-file');
    await expect(folder.provider.readFile('acme/big', 'main', 'planning')).resolves.toBeNull();
  });

  it('builds file links on the web host', () => {
    const { provider } = github('whoami');
    expect(provider.fileUrl('acme/app', 'feature/x', 'backlog/tasks/back-1 - A task.md')).toBe(
      'https://github.com/acme/app/blob/feature/x/backlog/tasks/back-1%20-%20A%20task.md',
    );
  });

  it('maps error statuses to typed errors without the token', async () => {
    const { provider } = github('errors');
    const errors = [
      await provider.whoami().catch((error: unknown) => error),
      await provider.getRepository('acme/missing').catch((error: unknown) => error),
      await provider.getRepository('acme/limited').catch((error: unknown) => error),
      await provider.getRepository('acme/secondary').catch((error: unknown) => error),
      await provider.getRepository('acme/forbidden').catch((error: unknown) => error),
      await provider.getRepository('acme/down').catch((error: unknown) => error),
      await provider.getRepository('acme/teapot').catch((error: unknown) => error),
    ];
    expect(errors[0]).toBeInstanceOf(GitUnauthorized);
    expect(errors[0]).toMatchObject({ kind: 'unauthorized', status: 401 });
    expect(errors[1]).toBeInstanceOf(GitNotFound);
    expect(errors[2]).toBeInstanceOf(GitRateLimited);
    expect(errors[2]).toMatchObject({ status: 403, retryAfterSeconds: 60 });
    expect(errors[3]).toBeInstanceOf(GitRateLimited);
    expect(errors[3]).toMatchObject({ status: 429, retryAfterSeconds: 30 });
    expect(errors[4]).toBeInstanceOf(GitUnauthorized);
    expect(errors[4]).toMatchObject({ status: 403, code: 'forbidden' });
    expect(errors[5]).toBeInstanceOf(GitUnreachable);
    expect(errors[5]).toMatchObject({ status: 502 });
    expect(errors[6]).toBeInstanceOf(GitUnexpected);
    for (const error of errors) {
      expect(String((error as Error).message)).not.toContain(FIXTURE_TOKEN);
      expect(JSON.stringify(error)).not.toContain(FIXTURE_TOKEN);
    }
  });

  it('follows a same-host redirect and refuses one to another host', async () => {
    const { provider, server } = github('redirects');
    await expect(provider.getRepository('acme/old-name')).resolves.toEqual({
      defaultBranch: 'trunk',
      webUrl: 'https://github.com/acme/new-name',
    });
    await expect(provider.getRepository('acme/elsewhere')).rejects.toBeInstanceOf(GitUnexpected);
    expect(server.calls.map((call) => new URL(call.url).host)).not.toContain('evil.example.com');
  });

  it('treats paths that are not owner/name as not found without calling the API', async () => {
    const { provider, server } = github('whoami');
    await expect(provider.getRepository('acme')).rejects.toBeInstanceOf(GitNotFound);
    await expect(provider.getRepository('group/sub/app')).rejects.toBeInstanceOf(GitNotFound);
    expect(server.calls).toHaveLength(0);
  });
});

describe('GitHub open pull requests (M6)', () => {
  it('lists open pull requests with a changed file under the folder, renames included', async () => {
    const { provider, server } = github('open-requests');
    await expect(provider.listOpenRequests?.('MrLesk/Backlog.md', 'backlog/')).resolves.toEqual({
      requests: [
        {
          number: 412,
          title: 'Mark BACK-12 done',
          author: 'octocat',
          headBranch: 'task/back-12',
          webUrl: 'https://github.com/MrLesk/Backlog.md/pull/412',
        },
        {
          number: 410,
          title: 'Move an old task out',
          author: 'ana-dev',
          headBranch: 'chore/archive',
          webUrl: 'https://github.com/MrLesk/Backlog.md/pull/410',
        },
        {
          number: 409,
          title: 'Ghost author',
          author: null,
          headBranch: 'ghost/branch',
          webUrl: 'https://github.com/MrLesk/Backlog.md/pull/409',
        },
      ],
      truncated: false,
      listUrl: 'https://github.com/MrLesk/Backlog.md/pulls',
    });
    // One list call and one file page per pull request; `backlog-notes.md` is not under backlog/.
    expect(server.calls).toHaveLength(5);
    expect(server.unused()).toEqual([]);
  });

  it('says the list may be cut when more pull requests are open or a file list runs past a page', async () => {
    const { provider } = github('open-requests-many');
    const result = await provider.listOpenRequests?.('MrLesk/Backlog.md', 'backlog');
    expect(result?.requests.map((request) => request.number)).toEqual([529]);
    expect(result?.truncated).toBe(true);
  });

  it('a token without pull request access is refused with a typed error', async () => {
    const server = replay({
      description: 'A fine-grained token without the Pull requests permission.',
      source: 'Hand-written from the GitHub REST docs.',
      exchanges: [
        {
          request: {
            url: 'https://api.github.com/repos/MrLesk/Backlog.md/pulls?state=open&sort=created&direction=desc&per_page=100',
          },
          response: { status: 403, json: { message: 'Resource not accessible by personal access token' } },
        },
      ],
    });
    const provider = createProvider({
      provider: 'github',
      host: 'github.com',
      token: FIXTURE_TOKEN,
      fetch: server.fetch,
    });
    await expect(provider.listOpenRequests?.('MrLesk/Backlog.md', 'backlog')).rejects.toMatchObject({
      name: 'GitUnauthorized',
      code: 'forbidden',
    });
  });
});
