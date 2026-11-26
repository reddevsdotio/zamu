// Logins per workspace (0.10, PM-40), in-process against a fake server: two workspaces, Acme and
// Globex, on one server, each with a project PAY linked to its own repository, plus OPS in Globex.
// The fake answers like the real API does for keys: the key names its workspace, an
// x-zamu-workspace header naming another one is 403 WORKSPACE_MISMATCH. Covers the conversion of a
// 0.9 config, every step of the pick order, the clone cache and its invalidation, the ambiguous
// clone, login, logout and zamu workspaces in text and --json, and queue replay across two logins.
import { execFileSync } from 'node:child_process';
import { mkdir, mkdtemp, readFile, rm, stat, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import {
  CLI_EXIT_QUEUED,
  type CliData,
  CliQueueFile,
  type CliResultName,
  parseCliOutput,
  WORKSPACE_HEADER,
  type WorkspaceRef,
} from '@zamu/contracts';
import {
  acmeWorkspaceFixture,
  globexWorkspaceFixture,
  meFixture,
  noteFixture,
  projectWithCountsFixture,
  taskFixture,
} from '@zamu/contracts/testing/fixtures';
import { beforeEach, describe, expect, it } from 'vitest';
import { keyFingerprint } from '../src/context';
import type { CliIo, FetchLike } from '../src/io';
import { main } from '../src/main';

const URL = 'http://zamu.test';
const ACME: WorkspaceRef = { id: acmeWorkspaceFixture.id, name: 'Acme', slug: 'acme' };
const GLOBEX: WorkspaceRef = { id: globexWorkspaceFixture.id, name: 'Globex', slug: 'globex' };
const KEY = {
  acme: 'zamu_live_acmeacmeacmeacme0001',
  globex: 'zamu_live_globexglobexglobex01',
  revoked: 'zamu_live_revokedrevokedrevoked',
};
const ACME_REPO = 'https://github.com/acme/payments.git';
const GLOBEX_REPO = 'git@github.com:globex/payments.git';
const PLAIN_REPO = 'https://github.com/acme/scratch.git';

interface Seen {
  method: string;
  path: string;
  key: string;
  header: string | null;
}

interface FakeProject {
  key: string;
  repository: string | null;
}

let home: string;
let requests: Seen[];
let down: boolean;
let projects: Record<string, FakeProject[]>;
let tasks: Record<string, string[]>;

beforeEach(async () => {
  home = await mkdtemp(join(tmpdir(), 'zamu-cli-workspaces-'));
  requests = [];
  down = false;
  projects = {
    [ACME.id]: [{ key: 'PAY', repository: ACME_REPO }],
    [GLOBEX.id]: [
      { key: 'PAY', repository: GLOBEX_REPO },
      { key: 'OPS', repository: null },
    ],
  };
  tasks = { [ACME.id]: ['PAY-1'], [GLOBEX.id]: ['PAY-1', 'PAY-7', 'OPS-1'] };
  return () => rm(home, { recursive: true, force: true });
});

const accounts = [
  { key: KEY.acme, workspace: ACME },
  { key: KEY.globex, workspace: GLOBEX },
];

function problem(status: number, code: string, detail: string): Response {
  return Response.json({ type: 'about:blank', title: code, status, code, detail }, { status });
}

/** The fake server: GET /me, GET /projects, GET and PATCH /tasks/KEY, POST /tasks/KEY/comments. */
const server: FetchLike = async (request) => {
  if (down) {
    throw new TypeError('fetch failed', { cause: new Error('connect ECONNREFUSED 127.0.0.1:3000') });
  }
  const url = new globalThis.URL(request.url);
  const key = (request.headers.get('authorization') ?? '').replace(/^Bearer /, '');
  const header = request.headers.get(WORKSPACE_HEADER);
  const path = url.pathname.replace(/^\/api\/v1/, '');
  requests.push({ method: request.method, path, key, header });
  const account = url.origin === URL ? accounts.find((one) => one.key === key) : undefined;
  if (!account) return problem(401, 'UNAUTHORIZED', 'Invalid API key');
  const workspace = account.workspace;
  if (header && header !== workspace.slug && header !== workspace.id) {
    return problem(403, 'WORKSPACE_MISMATCH', `This key is for another workspace than ${header}`);
  }
  if (request.method === 'GET' && path === '/me') {
    return Response.json({ ...meFixture, workspace });
  }
  if (request.method === 'GET' && path === '/projects') {
    const items = (projects[workspace.id] ?? []).map((project) => ({
      ...projectWithCountsFixture,
      key: project.key,
      name: `${workspace.name} ${project.key}`,
      repository: project.repository,
    }));
    return Response.json({ items });
  }
  const task = /^\/tasks\/([A-Z]+-\d+)(\/comments)?$/.exec(path);
  if (task) {
    const taskKey = task[1] as string;
    if (!tasks[workspace.id]?.includes(taskKey)) return problem(404, 'NOT_FOUND', `No task ${taskKey}`);
    if (task[2] && request.method === 'POST') {
      const body = (await request.json()) as { body: string };
      return Response.json({ ...noteFixture, taskKey, body: body.body }, { status: 201 });
    }
    const status = request.method === 'PATCH' ? ((await request.json()) as { status?: string }).status : null;
    return Response.json({
      ...taskFixture,
      key: taskKey,
      title: `${workspace.name} ${taskKey}`,
      status: status ?? 'in_progress',
    });
  }
  return problem(404, 'NOT_FOUND', 'No such route');
};

interface RunOptions {
  env?: Record<string, string | undefined>;
  cwd?: string;
  stdin?: string;
}

interface RunResult {
  code: number;
  stdout: string;
  stderr: string;
}

async function zamu(args: string[], options: RunOptions = {}): Promise<RunResult> {
  const out: string[] = [];
  const err: string[] = [];
  const io: CliIo = {
    stdout: (text) => out.push(text),
    stderr: (text) => err.push(text),
    readStdin: async () => options.stdin ?? '',
    env: {
      XDG_CONFIG_HOME: join(home, 'config'),
      XDG_STATE_HOME: join(home, 'state'),
      ZAMU_MACHINE: 'laptop',
      ...options.env,
    },
    homeDir: home,
    cwd: options.cwd ?? home,
    isTTY: false,
    fetch: server,
  };
  const code = await main(args, io);
  return { code, stdout: out.join(''), stderr: err.join('') };
}

function data<N extends CliResultName>(result: RunResult, name: N): CliData<N> {
  expect(result.stdout.trim().split('\n'), 'one JSON line').toHaveLength(1);
  return (parseCliOutput(JSON.parse(result.stdout), name) as { data: CliData<N> }).data;
}

function ok<N extends CliResultName>(result: RunResult, name: N): CliData<N> {
  expect(result.code, result.stdout + result.stderr).toBe(0);
  return data(result, name);
}

function failed(result: RunResult, exitCode: number, code: string) {
  expect(result.code, result.stdout + result.stderr).toBe(exitCode);
  const error = data(result, 'error');
  expect(error.code).toBe(code);
  return error;
}

const configFile = () => join(home, 'config', 'zamu', 'config.json');
const readConfigFile = async () => JSON.parse(await readFile(configFile(), 'utf8'));
const clonesFile = () => join(home, 'state', 'zamu', 'clones.json');

async function queueEntries() {
  const text = await readFile(join(home, 'state', 'zamu', 'queue.json'), 'utf8').catch(() => null);
  return text === null ? [] : CliQueueFile.parse(JSON.parse(text)).entries;
}

/** A git clone with `origin` at `remote` (and optionally a .zamu.json at its root). */
async function clone(name: string, remote: string | null, project?: string): Promise<string> {
  const dir = join(home, name);
  await mkdir(dir, { recursive: true });
  execFileSync('git', ['init', '-q', dir]);
  if (remote) execFileSync('git', ['-C', dir, 'remote', 'add', 'origin', remote]);
  if (project) await writeFile(join(dir, '.zamu.json'), JSON.stringify({ project }));
  return dir;
}

async function loginBoth() {
  ok(await zamu(['login', '--key', KEY.acme, '--url', URL, '--json']), 'login');
  ok(await zamu(['login', '--key', KEY.globex, '--url', URL, '--json']), 'login');
  requests = [];
}

const listed = (seen: Seen[] = requests) =>
  seen.filter((one) => one.path === '/projects').map((one) => (one.key === KEY.acme ? 'acme' : 'globex'));

describe('the 0.9 config file', () => {
  it('is converted by the first command that reaches the server', async () => {
    await mkdir(join(home, 'config', 'zamu'), { recursive: true });
    await writeFile(configFile(), JSON.stringify({ url: URL, key: KEY.acme }));
    const whoami = ok(await zamu(['whoami', '--json']), 'whoami');
    expect(whoami.workspace).toEqual(ACME);
    expect(whoami.workspaceSource).toBe('default');
    expect(await readConfigFile()).toEqual({
      version: 2,
      logins: [{ url: URL, key: KEY.acme, workspace: ACME, default: true }],
    });
    expect((await stat(configFile())).mode & 0o777).toBe(0o600);
    // One GET /me without a header fills in the workspace; the command's own call names it.
    expect(requests.map((one) => [one.path, one.header])).toEqual([
      ['/me', null],
      ['/me', 'acme'],
    ]);

    requests = [];
    ok(await zamu(['whoami', '--json']), 'whoami');
    expect(requests.map((one) => one.path)).toEqual(['/me']);
  });

  it('keeps working offline, and its queued writes go out once it is converted', async () => {
    await mkdir(join(home, 'config', 'zamu'), { recursive: true });
    const old = JSON.stringify({ url: URL, key: KEY.acme });
    await writeFile(configFile(), old);
    down = true;
    const queued = await zamu(['notes', 'add', 'PAY-1', 'Written offline', '--json']);
    expect(queued.code, queued.stdout + queued.stderr).toBe(CLI_EXIT_QUEUED);
    const [entry] = await queueEntries();
    expect(entry).toMatchObject({ url: URL, keyId: keyFingerprint(KEY.acme), taskKey: 'PAY-1' });
    expect(entry?.workspaceId).toBeUndefined();
    // The conversion got no answer: the file is as it was, and the note did not wait twice.
    expect(await readFile(configFile(), 'utf8')).toBe(old);
    expect(ok(await zamu(['queue', '--json']), 'queue.list').items).toHaveLength(1);

    down = false;
    const back = await zamu(['whoami', '--json']);
    expect(ok(back, 'whoami').queued).toBe(0);
    expect(back.stderr).toContain('Sent: PAY-1 note "Written offline"');
    expect((await readConfigFile()).version).toBe(2);
    expect(await queueEntries()).toEqual([]);
  });

  it('is refused like any key when the server no longer accepts it', async () => {
    await mkdir(join(home, 'config', 'zamu'), { recursive: true });
    const old = JSON.stringify({ url: URL, key: KEY.revoked });
    await writeFile(configFile(), old);
    failed(await zamu(['projects', 'list', '--json']), 2, 'UNAUTHORIZED');
    expect(await readFile(configFile(), 'utf8')).toBe(old);
  });
});

describe('zamu login', () => {
  it('adds one login per workspace; the first is the default', async () => {
    const first = ok(await zamu(['login', '--key', KEY.acme, '--url', URL, '--json']), 'login');
    expect(first).toMatchObject({ url: URL, replaced: false, default: true });
    expect(first.me.workspace).toEqual(ACME);
    // The key tells the workspace: login sends no header.
    expect(requests.at(-1)?.header).toBeNull();

    const second = await zamu(['login', '--key', KEY.globex]);
    expect(second.code, second.stderr).toBe(0);
    expect(second.stdout).toContain('Key stored for globex');
    expect(second.stdout).toContain('The default login stays acme.');
    expect(second.stdout).toContain('--workspace globex, or run zamu workspaces --default globex');
    expect((await readConfigFile()).logins).toEqual([
      { url: URL, key: KEY.acme, workspace: ACME, default: true },
      { url: URL, key: KEY.globex, workspace: GLOBEX, default: false },
    ]);

    const again = ok(await zamu(['login', '--key', KEY.globex, '--default', '--json']), 'login');
    expect(again).toMatchObject({ replaced: true, default: true });
    expect(
      (await readConfigFile()).logins.map((login: { workspace: WorkspaceRef; default: boolean }) => [
        login.workspace.slug,
        login.default,
      ]),
    ).toEqual([
      ['acme', false],
      ['globex', true],
    ]);
  });

  it('keeps the login of a 0.9 file next to the new one', async () => {
    await mkdir(join(home, 'config', 'zamu'), { recursive: true });
    await writeFile(configFile(), JSON.stringify({ url: URL, key: KEY.acme }));
    ok(await zamu(['login', '--key', KEY.globex, '--json']), 'login');
    const { logins } = await readConfigFile();
    expect(logins.map((login: { workspace: WorkspaceRef }) => login.workspace.slug)).toEqual([
      'acme',
      'globex',
    ]);
  });

  it('stores nothing for a key the server refuses', async () => {
    failed(await zamu(['login', '--key', KEY.revoked, '--url', URL, '--json']), 2, 'UNAUTHORIZED');
    await expect(stat(configFile())).rejects.toThrow();
  });
});

describe('the pick order', () => {
  it('takes --workspace first, by slug or id, and sends it as the header', async () => {
    await loginBoth();
    const bySlug = ok(await zamu(['--workspace', 'globex', 'whoami', '--json']), 'whoami');
    expect(bySlug.workspace).toEqual(GLOBEX);
    expect(bySlug.workspaceSource).toBe('flag');
    expect(requests.at(-1)).toMatchObject({ key: KEY.globex, header: 'globex' });

    const byId = ok(await zamu(['whoami', '--workspace', GLOBEX.id, '--json']), 'whoami');
    expect(byId.workspace.slug).toBe('globex');
    // The flag wins over ZAMU_KEY.
    const overEnv = ok(
      await zamu(['whoami', '--workspace', 'acme', '--json'], {
        env: { ZAMU_KEY: KEY.globex, ZAMU_URL: URL },
      }),
      'whoami',
    );
    expect(overEnv.workspace.slug).toBe('acme');
    expect(overEnv.workspaceSource).toBe('flag');

    const unknown = failed(await zamu(['whoami', '--workspace', 'initech', '--json']), 1, 'BAD_REQUEST');
    expect(unknown.detail).toBe('No login for workspace initech.');
    const human = await zamu(['whoami', '--workspace', 'initech']);
    expect(human.stderr).toContain('Stored logins: acme, globex');
  });

  it('then ZAMU_KEY, which names the workspace when a stored login holds it', async () => {
    await loginBoth();
    const env = ok(
      await zamu(['whoami', '--json'], { env: { ZAMU_KEY: KEY.globex, ZAMU_URL: URL } }),
      'whoami',
    );
    expect(env.workspaceSource).toBe('env');
    expect(requests.at(-1)).toMatchObject({ key: KEY.globex, header: 'globex' });

    // A key zamu doesn't store goes out without a header, as before 0.10.
    await rm(configFile());
    requests = [];
    ok(await zamu(['whoami', '--json'], { env: { ZAMU_KEY: KEY.acme, ZAMU_URL: URL } }), 'whoami');
    expect(requests.at(-1)).toMatchObject({ key: KEY.acme, header: null });
  });

  it('refuses a ZAMU_KEY for another workspace than --workspace names (403, exit 4)', async () => {
    const env = { ZAMU_KEY: KEY.acme, ZAMU_URL: URL };
    const mismatch = await zamu(['projects', 'list', '--workspace', 'globex', '--json'], { env });
    const error = failed(mismatch, 4, 'WORKSPACE_MISMATCH');
    expect(error.status).toBe(403);
    expect(requests.at(-1)).toMatchObject({ key: KEY.acme, header: 'globex' });
    const human = await zamu(['projects', 'list', '--workspace', 'globex'], { env });
    expect(human.stderr).toContain('The key is for another workspace than the one named.');
  });

  it("then the login whose workspace links the clone's remote, cached for the next command", async () => {
    await loginBoth();
    const dir = await clone('globex-payments', GLOBEX_REPO);
    const first = ok(await zamu(['whoami', '--json'], { cwd: dir }), 'whoami');
    expect(first.workspace.slug).toBe('globex');
    expect(first.workspaceSource).toBe('clone');
    expect(first.project).toEqual({ key: 'PAY', source: 'remote', from: GLOBEX_REPO });
    // Both logins listed their projects once, in parallel; the project lookup reused the list.
    expect(listed().sort()).toEqual(['acme', 'globex']);
    const cache = JSON.parse(await readFile(clonesFile(), 'utf8'));
    expect(cache).toEqual({
      version: 1,
      clones: {
        'github.com/globex/payments': { url: URL, workspaceId: GLOBEX.id, matchedAt: expect.any(String) },
      },
    });

    requests = [];
    const human = await zamu(['whoami'], { cwd: dir });
    expect(human.stdout).toMatch(/Workspace\s+Globex \(globex\)/);
    expect(human.stdout).toMatch(/Login\s+from the login for this clone's git remote/);
    // From the cache: only Globex is asked, for the project.
    expect(listed()).toEqual(['globex']);
  });

  it('then the login that has the project .zamu.json names', async () => {
    await loginBoth();
    const dir = await clone('ops', null, 'OPS');
    const found = ok(await zamu(['whoami', '--json'], { cwd: dir }), 'whoami');
    expect(found.workspace.slug).toBe('globex');
    expect(found.workspaceSource).toBe('clone');
    expect(found.project).toMatchObject({ key: 'OPS', source: 'file' });
  });

  it('stops when the clone matches several logins, naming the --workspace to pass', async () => {
    await loginBoth();
    const dir = await clone('scratch', PLAIN_REPO, 'PAY');
    const result = await zamu(['projects', 'list', '--json'], { cwd: dir });
    const error = failed(result, 1, 'BAD_REQUEST');
    expect(error.detail).toContain('This clone matches 2 logins. Pass --workspace to pick one');
    expect(error.issues).toEqual([{ path: 'workspace', message: 'This clone matches 2 logins.' }]);

    const human = await zamu(['projects', 'list'], { cwd: dir });
    expect(human.code).toBe(1);
    expect(human.stderr).toBe(
      [
        'zamu: This clone matches 2 logins. Pass --workspace to pick one:',
        `  --workspace acme    Acme (acme) on ${URL}`,
        `  --workspace globex  Globex (globex) on ${URL}`,
        '',
      ].join('\n'),
    );
    const picked = ok(
      await zamu(['projects', 'list', '--workspace', 'acme', '--json'], { cwd: dir }),
      'projects.list',
    );
    expect(picked.items.map((project) => project.name)).toEqual(['Acme PAY']);
    // Nothing is cached for an ambiguous clone.
    await expect(stat(clonesFile())).rejects.toThrow();
  });

  it('then the default login', async () => {
    await loginBoth();
    const outside = ok(await zamu(['whoami', '--json']), 'whoami');
    expect(outside.workspace.slug).toBe('acme');
    expect(outside.workspaceSource).toBe('default');
    // Outside a clone there is nothing to match.
    expect(listed()).toEqual([]);

    const unlinked = await clone('unlinked', 'https://github.com/someone/else.git');
    const inside = ok(await zamu(['whoami', '--json'], { cwd: unlinked }), 'whoami');
    expect(inside.workspaceSource).toBe('default');
    expect(inside.workspace.slug).toBe('acme');
  });

  it('matches again after the cached login gets a 404, and retries with the new match', async () => {
    await loginBoth();
    const dir = await clone('moved', ACME_REPO);
    expect(ok(await zamu(['whoami', '--json'], { cwd: dir }), 'whoami').workspace.slug).toBe('acme');
    // The repository moves to Globex, with its task PAY-7.
    projects[ACME.id] = [{ key: 'PAY', repository: null }];
    projects[GLOBEX.id] = [{ key: 'PAY', repository: ACME_REPO }];
    requests = [];
    const note = ok(await zamu(['notes', 'add', 'PAY-7', 'Found it', '--json'], { cwd: dir }), 'notes.add');
    expect(note.taskKey).toBe('PAY-7');
    expect(requests.filter((one) => one.path === '/tasks/PAY-7/comments').map((one) => one.header)).toEqual([
      'acme',
      'globex',
    ]);
    const cache = JSON.parse(await readFile(clonesFile(), 'utf8'));
    expect(cache.clones['github.com/acme/payments'].workspaceId).toBe(GLOBEX.id);
    expect(ok(await zamu(['whoami', '--json'], { cwd: dir }), 'whoami').workspace.slug).toBe('globex');
  });

  it('keeps the 404 when matching again picks the same login', async () => {
    await loginBoth();
    const dir = await clone('acme-payments', ACME_REPO);
    ok(await zamu(['whoami', '--json'], { cwd: dir }), 'whoami');
    failed(await zamu(['notes', 'add', 'PAY-99', 'Nope', '--json'], { cwd: dir }), 3, 'NOT_FOUND');
    const cache = JSON.parse(await readFile(clonesFile(), 'utf8'));
    expect(cache.clones['github.com/acme/payments'].workspaceId).toBe(ACME.id);
  });

  it('narrows the logins to ZAMU_URL', async () => {
    await loginBoth();
    const result = await zamu(['whoami', '--json'], { env: { ZAMU_URL: 'http://other.test' } });
    failed(result, 2, 'UNAUTHORIZED');
    expect(data(result, 'error').detail).toBe('No login for http://other.test.');
  });

  it('is in --help', async () => {
    const help = await zamu(['--help']);
    expect(help.stdout).toContain('--workspace <slug>');
    expect(help.stdout).toContain('workspaces');
    expect(help.stdout).toContain('one login per server and workspace');
  });
});

describe('zamu workspaces', () => {
  it('lists the logins and the one used here, and changes the default', async () => {
    await loginBoth();
    const list = ok(await zamu(['workspaces', '--json']), 'workspaces');
    expect(list).toEqual({
      items: [
        { url: URL, workspace: ACME, default: true, current: true },
        { url: URL, workspace: GLOBEX, default: false, current: false },
      ],
      source: 'default',
    });
    const human = await zamu(['workspaces']);
    const lines = human.stdout.split('\n');
    expect(lines[0]).toMatch(/^\s+WORKSPACE\s+NAME\s+SERVER\s+DEFAULT$/);
    expect(lines[1]).toMatch(new RegExp(`^\\*\\s+acme\\s+Acme\\s+${URL}\\s+yes$`));
    expect(lines[2]).toMatch(new RegExp(`^\\s+globex\\s+Globex\\s+${URL}$`));
    expect(human.stdout).toContain('* used here: acme, from the default login.');

    const dir = await clone('globex-payments', GLOBEX_REPO);
    const here = ok(await zamu(['workspaces', '--json'], { cwd: dir }), 'workspaces');
    expect(here.source).toBe('clone');
    expect(here.items.map((item) => item.current)).toEqual([false, true]);

    const changed = ok(await zamu(['workspaces', '--default', 'globex', '--json']), 'workspaces');
    expect(changed.items.map((item) => [item.workspace.slug, item.default, item.current])).toEqual([
      ['acme', false, false],
      ['globex', true, true],
    ]);
    failed(await zamu(['workspaces', '--default', 'initech', '--json']), 1, 'BAD_REQUEST');
  });

  it('says when ZAMU_KEY is used instead, and when the clone matches several', async () => {
    await loginBoth();
    const env = ok(await zamu(['workspaces', '--json'], { env: { ZAMU_KEY: KEY.acme } }), 'workspaces');
    expect(env.source).toBe('env');
    expect(env.items.every((item) => !item.current)).toBe(true);
    expect((await zamu(['workspaces'], { env: { ZAMU_KEY: KEY.acme } })).stdout).toContain(
      'ZAMU_KEY is set in this shell, so commands use it instead of these logins.',
    );

    const dir = await clone('scratch', PLAIN_REPO, 'PAY');
    const ambiguous = ok(await zamu(['workspaces', '--json'], { cwd: dir }), 'workspaces');
    expect(ambiguous.source).toBeNull();
    expect((await zamu(['workspaces'], { cwd: dir })).stdout).toContain(
      'Several logins match this clone, so commands here need --workspace <slug>.',
    );
  });

  it('works without logins and without a server', async () => {
    down = true;
    expect(ok(await zamu(['workspaces', '--json']), 'workspaces')).toEqual({ items: [], source: null });
    expect((await zamu(['workspaces'])).stdout).toBe(
      'No stored logins. Run zamu login --key <key> once per workspace.\n',
    );
  });
});

describe('zamu logout', () => {
  it('removes the login used here, the one --workspace names, or all of them', async () => {
    await loginBoth();
    const dir = await clone('acme-payments', ACME_REPO);
    const here = ok(await zamu(['logout', '--json'], { cwd: dir }), 'logout');
    expect(here).toEqual({ url: URL, removed: [{ url: URL, workspace: ACME, default: true }] });
    const { logins } = await readConfigFile();
    expect(logins).toEqual([{ url: URL, key: KEY.globex, workspace: GLOBEX, default: true }]);
    // The clone's cached login went with it.
    expect(JSON.parse(await readFile(clonesFile(), 'utf8')).clones).toEqual({});

    ok(await zamu(['login', '--key', KEY.acme, '--json']), 'login');
    const named = await zamu(['logout', '--workspace', 'acme']);
    expect(named.stdout).toBe(`Logged out of Acme (acme) on ${URL}.\n`);
    ok(await zamu(['login', '--key', KEY.acme, '--json']), 'login');
    const all = ok(await zamu(['logout', '--all', '--json']), 'logout');
    expect(all.removed?.map((login) => login.workspace.slug)).toEqual(['globex', 'acme']);
    await expect(stat(configFile())).rejects.toThrow();
    expect((await zamu(['logout'])).stdout).toBe('Not logged in; nothing to remove.\n');
  });

  it('names the new default when the default goes', async () => {
    await loginBoth();
    const out = await zamu(['logout']);
    expect(out.stdout).toBe(`Logged out of Acme (acme) on ${URL}.\nglobex is the default login now.\n`);
  });

  it('asks for --workspace when the clone matches several, and works offline with it', async () => {
    await loginBoth();
    const dir = await clone('scratch', PLAIN_REPO, 'PAY');
    const result = await zamu(['logout'], { cwd: dir });
    expect(result.code).toBe(1);
    expect(result.stderr).toContain('This clone matches 2 logins');
    expect(result.stderr).toContain('zamu logout --all removes every login.');
    down = true;
    ok(await zamu(['logout', '--workspace', 'globex', '--json'], { cwd: dir }), 'logout');
    expect((await readConfigFile()).logins).toHaveLength(1);
  });
});

describe('the offline queue with two logins', () => {
  it('ties each write to its login and replays it with that login', async () => {
    await loginBoth();
    down = true;
    const acme = await zamu(['notes', 'add', 'PAY-1', 'For Acme', '--workspace', 'acme', '--json']);
    expect(acme.code, acme.stdout).toBe(CLI_EXIT_QUEUED);
    const globex = await zamu(['notes', 'add', 'PAY-1', 'For Globex', '--workspace', 'globex', '--json']);
    expect(globex.code, globex.stdout).toBe(CLI_EXIT_QUEUED);
    expect((await queueEntries()).map((entry) => [entry.workspaceId, entry.keyId])).toEqual([
      [ACME.id, keyFingerprint(KEY.acme)],
      [GLOBEX.id, keyFingerprint(KEY.globex)],
    ]);

    const list = await zamu(['queue']);
    expect(list.stdout).toMatch(/WORKSPACE\s+TASK/);
    expect(list.stdout).toMatch(/\sacme\s+PAY-1\s+note "For Acme"/);
    expect(list.stdout).toMatch(/\sglobex\s+PAY-1\s+note "For Globex"/);

    // One command with the Globex login sends both, each with the key and header it was queued under.
    down = false;
    requests = [];
    const back = await zamu(['whoami', '--workspace', 'globex', '--json']);
    expect(ok(back, 'whoami').queued).toBe(0);
    expect(back.stderr).toContain('Sent: PAY-1 note "For Acme"');
    expect(back.stderr).toContain('Sent: PAY-1 note "For Globex"');
    expect(
      requests.filter((one) => one.path === '/tasks/PAY-1/comments').map((one) => [one.key, one.header]),
    ).toEqual([
      [KEY.acme, 'acme'],
      [KEY.globex, 'globex'],
    ]);
    expect(await queueEntries()).toEqual([]);
  });

  it('remembers statuses per workspace, so PAY-1 of Acme never vouches for PAY-1 of Globex', async () => {
    await loginBoth();
    ok(
      await zamu(['tasks', 'update', 'PAY-1', '--priority', 'high', '--workspace', 'acme', '--json']),
      'tasks.update',
    );
    down = true;
    const globex = await zamu(['tasks', 'update', 'PAY-1', '--status', 'in_review', '--workspace', 'globex']);
    expect(globex.code).toBe(5);
    expect(globex.stderr).toContain("zamu hasn't seen PAY-1's status on this machine");
    const acme = await zamu([
      'tasks',
      'update',
      'PAY-1',
      '--status',
      'in_review',
      '--workspace',
      'acme',
      '--json',
    ]);
    expect(acme.code, acme.stdout).toBe(CLI_EXIT_QUEUED);
    expect((await queueEntries())[0]).toMatchObject({ workspaceId: ACME.id, lastSeenStatus: 'in_progress' });
  });

  it('replays a 0.9 entry with the login picked for its server today', async () => {
    await loginBoth();
    await mkdir(join(home, 'state', 'zamu'), { recursive: true });
    const entry = {
      id: 'old00001',
      queuedAt: '2026-11-01T09:00:00.000Z',
      url: URL,
      project: 'PAY',
      taskKey: 'PAY-1',
      procedure: 'comments.create',
      input: { key: 'PAY-1', body: 'From 0.9', kind: 'note' },
      lastSeenStatus: null,
      summary: 'note "From 0.9"',
    };
    await writeFile(
      join(home, 'state', 'zamu', 'queue.json'),
      JSON.stringify({ version: 1, entries: [entry] }),
    );
    const dir = await clone('globex-payments', GLOBEX_REPO);
    const result = await zamu(['whoami', '--json'], { cwd: dir });
    expect(result.stderr).toContain('Sent: PAY-1 note "From 0.9"');
    expect(requests.find((one) => one.path === '/tasks/PAY-1/comments')).toMatchObject({
      key: KEY.globex,
      header: 'globex',
    });
  });
});
