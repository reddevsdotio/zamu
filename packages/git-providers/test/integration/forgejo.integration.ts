// Runs the Gitea/Forgejo adapter against a real Forgejo container started by docker/forgejo/setup.sh:
// creates a repository with a small backlog/ folder, lists and reads it, verifies a real webhook
// delivery, and lists open pull requests that touch the folder with a read-only token. Skipped with
// a message when Docker is not available.

import { execFileSync } from 'node:child_process';
import { once } from 'node:events';
import { createServer, type IncomingHttpHeaders, type Server } from 'node:http';
import type { AddressInfo } from 'node:net';
import { join } from 'node:path';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import {
  createProvider,
  GitHostRefused,
  type GitProvider,
  GitUnauthorized,
  verifyWebhook,
} from '../../src/index';
import { dockerAvailable } from './docker';

const scripts = join(import.meta.dirname, '../../../../docker/forgejo');
const project = `zamu-forgejo-it-${process.pid}`;
const owner = 'zamu-admin';
const repo = 'backlog-fixture';
const path = `${owner}/${repo}`;
const secret = `whsec-${process.pid}-integration`;

const docker = dockerAvailable();

async function freePort(): Promise<number> {
  const server = createServer();
  server.listen(0, '127.0.0.1');
  await once(server, 'listening');
  const { port } = server.address() as AddressInfo;
  server.close();
  await once(server, 'close');
  return port;
}

// Twelve tasks, so the recursive listing of backlog/ spans several pages of ten.
const files: Record<string, string> = {
  'README.md': '# Fixture\n',
  'docs/readme.md': 'Not part of the backlog.\n',
  'backlog/config.yml':
    'project_name: "Fixture"\ntask_prefix: "back"\nstatuses: ["To Do", "In Progress", "Done"]\n',
  'backlog/milestones/m-1 - Launch.md':
    '---\nid: m-1\ntitle: "Launch"\n---\n\n## Description\n\nFirst release.\n',
  'backlog/archive/tasks/back-0 - Old.md': '---\nid: BACK-0\ntitle: Old\nstatus: Done\n---\n',
  'backlog/drafts/draft-1 - Idea.md': '---\nid: DRAFT-1\ntitle: Idea\nstatus: Draft\n---\n',
};
for (let n = 1; n <= 12; n++) {
  files[`backlog/tasks/back-${n} - Task ${n}.md`] =
    `---\nid: BACK-${n}\ntitle: "Task ${n} — café ✓"\nstatus: To Do\n---\n\n## Description\n\nTask number ${n}.\n`;
}
const backlogPaths = Object.keys(files)
  .filter((file) => file.startsWith('backlog/'))
  .sort();

interface Delivery {
  headers: IncomingHttpHeaders;
  body: Buffer;
}

describe.skipIf(!docker)('Gitea/Forgejo adapter against a Forgejo container', () => {
  let baseUrl = '';
  let host = '';
  let token = '';
  let password = '';
  let provider: GitProvider;
  let hookServer: Server | undefined;
  const deliveries: Delivery[] = [];

  async function api(method: string, apiPath: string, body?: unknown): Promise<unknown> {
    const response = await fetch(`${baseUrl}/api/v1${apiPath}`, {
      method,
      headers: { authorization: `token ${token}`, 'content-type': 'application/json' },
      ...(body === undefined ? {} : { body: JSON.stringify(body) }),
    });
    const text = await response.text();
    if (!response.ok) throw new Error(`${method} ${apiPath} answered ${response.status}: ${text}`);
    return text ? JSON.parse(text) : null;
  }

  const teardown = () => {
    execFileSync(join(scripts, 'teardown.sh'), {
      env: { ...process.env, FORGEJO_PROJECT: project },
      stdio: ['ignore', 'inherit', 'inherit'],
      timeout: 120_000,
    });
  };

  beforeAll(async () => {
    const port = await freePort();
    let output: string;
    try {
      output = execFileSync(join(scripts, 'setup.sh'), {
        env: {
          ...process.env,
          FORGEJO_PORT: String(port),
          FORGEJO_PROJECT: project,
          FORGEJO_TREES_PER_PAGE: '10',
        },
        encoding: 'utf8',
        stdio: ['ignore', 'pipe', 'inherit'],
        timeout: 280_000,
      });
    } catch (error) {
      teardown();
      throw error;
    }
    const env = Object.fromEntries(
      output
        .split('\n')
        .filter((line) => line.includes('='))
        .map((line) => [line.slice(0, line.indexOf('=')), line.slice(line.indexOf('=') + 1)]),
    );
    baseUrl = env.FORGEJO_URL as string;
    token = env.FORGEJO_TOKEN as string;
    password = env.FORGEJO_PASSWORD as string;
    host = new URL(baseUrl).host;
    provider = createProvider({
      provider: 'gitea',
      host,
      token,
      allowHttp: true,
      hostPolicy: { allowPrivate: true },
    });

    await api('POST', '/user/repos', {
      name: repo,
      auto_init: false,
      default_branch: 'main',
      private: false,
    });
    await api('POST', `/repos/${path}/contents`, {
      branch: 'main',
      message: 'Add backlog fixture',
      files: Object.entries(files).map(([file, content]) => ({
        operation: 'create',
        path: file,
        content: Buffer.from(content).toString('base64'),
      })),
    });
  });

  afterAll(async () => {
    if (hookServer) {
      hookServer.close();
      hookServer.closeAllConnections();
    }
    teardown();
  });

  it('whoami returns the admin and a repository count', async () => {
    await expect(provider.whoami()).resolves.toEqual({ login: owner, repoCount: 1 });
  });

  it('reads the repository, the default branch and its head', async () => {
    const info = await provider.getRepository(path);
    expect(info).toEqual({ defaultBranch: 'main', webUrl: `${baseUrl}/${path}` });
    await expect(provider.getBranchHead(path, 'main')).resolves.toMatch(/^[0-9a-f]{40}$/);
  });

  it('lists backlog/ recursively across tree pages, blobs only, with sizes', async () => {
    const head = await provider.getBranchHead(path, 'main');
    const entries = await provider.listTree(path, head, 'backlog');
    expect(entries.map((entry) => entry.path).sort()).toEqual(backlogPaths);
    for (const entry of entries) {
      expect(entry.size).toBe(Buffer.byteLength(files[entry.path] as string));
      expect(entry.blobSha).toMatch(/^[0-9a-f]{40}$/);
    }
    await expect(provider.listTree(path, head, '.backlog')).resolves.toEqual([]);
    await expect(provider.listTree(path, head, 'backlog/tasks/nope')).resolves.toEqual([]);
  });

  it('reads blobs and single files as UTF-8', async () => {
    const head = await provider.getBranchHead(path, 'main');
    const entries = await provider.listTree(path, head, 'backlog/tasks');
    const first = entries.find((entry) => entry.path === 'backlog/tasks/back-1 - Task 1.md');
    expect(first).toBeDefined();
    await expect(provider.readBlob(path, first?.blobSha as string)).resolves.toBe(
      files['backlog/tasks/back-1 - Task 1.md'],
    );
    await expect(provider.readFile(path, 'main', 'backlog/config.yml')).resolves.toEqual({
      content: files['backlog/config.yml'],
      blobSha: expect.stringMatching(/^[0-9a-f]{40}$/),
    });
    await expect(provider.readFile(path, head, 'backlog.config.yml')).resolves.toBeNull();
  });

  it('builds file links that open in Forgejo', async () => {
    const url = provider.fileUrl(path, 'main', 'backlog/tasks/back-2 - Task 2.md');
    const response = await fetch(url);
    expect(response.status).toBe(200);
  });

  it('refuses a rejected token and a private host without the flag', async () => {
    const wrongToken = `${token.slice(0, -4)}0000`;
    const rejected = createProvider({ provider: 'gitea', host, token: wrongToken, allowHttp: true });
    const error = await rejected.whoami().catch((caught: unknown) => caught);
    expect(error).toBeInstanceOf(GitUnauthorized);
    expect(String(error)).not.toContain(wrongToken);

    const guarded = createProvider({
      provider: 'gitea',
      host,
      token,
      allowHttp: true,
      hostPolicy: { allowPrivate: false },
    });
    await expect(guarded.whoami()).rejects.toBeInstanceOf(GitHostRefused);
  });

  it('verifies a real push webhook delivery, and only the changed blob gets a new hash', async () => {
    hookServer = createServer((request, response) => {
      const chunks: Buffer[] = [];
      request.on('data', (chunk: Buffer) => chunks.push(chunk));
      request.on('end', () => {
        deliveries.push({ headers: request.headers, body: Buffer.concat(chunks) });
        response.writeHead(202).end();
      });
    });
    hookServer.listen(0, '0.0.0.0');
    await once(hookServer, 'listening');
    const hookPort = (hookServer.address() as AddressInfo).port;

    await api('POST', `/repos/${path}/hooks`, {
      type: 'forgejo',
      active: true,
      events: ['push'],
      config: { url: `http://host.docker.internal:${hookPort}/hook`, content_type: 'json', secret },
    });

    const before = await provider.listTree(path, await provider.getBranchHead(path, 'main'), 'backlog');
    const target = 'backlog/tasks/back-3 - Task 3.md';
    const changed = `${files[target]}\nEdited.\n`;
    await api('POST', `/repos/${path}/contents`, {
      branch: 'main',
      message: 'Edit task 3',
      files: [
        {
          operation: 'update',
          path: target,
          sha: before.find((entry) => entry.path === target)?.blobSha,
          content: Buffer.from(changed).toString('base64'),
        },
      ],
    });

    // Forgejo may also deliver the push that created the branch, queued before the hook existed:
    // wait for the delivery of this edit, the one whose `after` is the new head.
    const head = await provider.getBranchHead(path, 'main');
    const isEdit = (entry: Delivery) =>
      (JSON.parse(entry.body.toString()) as { after?: string }).after === head;
    const deadline = Date.now() + 30_000;
    while (!deliveries.some(isEdit) && Date.now() < deadline) {
      await new Promise((resolve) => setTimeout(resolve, 250));
    }
    const delivery = deliveries.find(isEdit);
    expect(
      delivery,
      'no webhook delivery for the edit reached the test server within 30 seconds',
    ).toBeDefined();
    if (!delivery) return;
    expect(delivery.headers['x-forgejo-signature']).toMatch(/^[0-9a-f]{64}$/);
    expect(delivery.headers['x-gitea-signature']).toBe(delivery.headers['x-forgejo-signature']);

    expect(provider.verifyWebhook(delivery.headers, delivery.body, secret)).toEqual({
      ok: true,
      event: 'push',
      eventName: 'push',
      branch: 'main',
      headCommit: head,
      deleted: false,
    });
    expect(verifyWebhook('gitea', delivery.headers, delivery.body, `${secret}-wrong`)).toEqual({
      ok: false,
      reason: 'bad_signature',
    });

    const after = await provider.listTree(path, head, 'backlog');
    const changedPaths = after
      .filter((entry) => before.find((old) => old.path === entry.path)?.blobSha !== entry.blobSha)
      .map((entry) => entry.path);
    expect(changedPaths).toEqual([target]);
    await expect(provider.readFile(path, head, target)).resolves.toMatchObject({ content: changed });
  });

  it('lists open pull requests under backlog/ with a read-only token (M6)', async () => {
    const branchWith = async (branch: string, file: string, content: string) => {
      await api('POST', `/repos/${path}/contents`, {
        branch: 'main',
        new_branch: branch,
        message: `Change ${file}`,
        files: [{ operation: 'create', path: file, content: Buffer.from(content).toString('base64') }],
      });
      return (await api('POST', `/repos/${path}/pulls`, {
        base: 'main',
        head: branch,
        title: `Change ${file}`,
      })) as { number: number; html_url: string };
    };
    const touching = await branchWith(
      'task-13',
      'backlog/tasks/back-13 - Task 13.md',
      '---\nid: BACK-13\n---\n',
    );
    await branchWith('docs-only', 'docs/other.md', 'Docs.\n');

    // A token limited to read:repository and read:user, as the docs ask for.
    const created = await fetch(`${baseUrl}/api/v1/users/${owner}/tokens`, {
      method: 'POST',
      headers: {
        authorization: `Basic ${Buffer.from(`${owner}:${password}`).toString('base64')}`,
        'content-type': 'application/json',
      },
      body: JSON.stringify({ name: `read-only-${process.pid}`, scopes: ['read:repository', 'read:user'] }),
    });
    expect(created.status).toBe(201);
    const { sha1 } = (await created.json()) as { sha1: string };
    const readOnly = createProvider({
      provider: 'gitea',
      host,
      token: sha1,
      allowHttp: true,
      hostPolicy: { allowPrivate: true },
    });

    await expect(readOnly.listOpenRequests?.(path, 'backlog')).resolves.toEqual({
      requests: [
        {
          number: touching.number,
          title: 'Change backlog/tasks/back-13 - Task 13.md',
          author: owner,
          headBranch: 'task-13',
          webUrl: touching.html_url,
        },
      ],
      truncated: false,
      listUrl: `${baseUrl}/${path}/pulls`,
    });
    await expect(readOnly.listOpenRequests?.(path, 'docs')).resolves.toMatchObject({
      requests: [{ headBranch: 'docs-only' }],
    });
  });
});
