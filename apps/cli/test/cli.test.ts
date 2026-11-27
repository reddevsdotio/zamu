// zamu commands end to end, in-process: the real /api/v1 handler from apps/web on a throwaway Postgres
// database with the dev seed (PAY with 11 tasks, WEB with 4) and its M2 planning data in PAY: the
// milestones "Webhooks v2" (PAY-1..5) and "PCI audit" (PAY-6..7), the current Cycle 1 (PAY-1..6) and the
// upcoming Cycle 2 (PAY-7..8), and three comments on PAY-1. Every --json result is checked against
// the contract's CLI output schemas, and every failure against its exit code.
//
// The server code is imported by relative path (apps/web/src/server uses relative imports for this).
import { execFileSync } from 'node:child_process';
import { mkdir, mkdtemp, readFile, rm, stat, symlink, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { type CliResultName, parseCliOutput } from '@zamu/contracts';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { type Actor, createApiKey, revokeApiKey } from '../../../packages/core/src/index';
import { createTestDatabase, type TestDatabase } from '../../../packages/db/test/index';
import { createApiFetchHandler } from '../../web/src/server/api/handler';
import { createServerContext, type ServerContext } from '../../web/src/server/context';
import { seedDevData } from '../../web/src/server/seed';
import type { CliIo, FetchLike } from '../src/io';
import { main } from '../src/main';

const URL = 'http://zamu.test';
const SECRET = 'test-secret-test-secret-test-secret-0123';

let database: TestDatabase;
let server: ServerContext;
let handle: FetchLike;
let home: string;
let configHome: string;
const keys = {} as { agent: string; admin: string; adminRead: string; revoked: string };
let agentName: string;
let adminName: string;

interface RunOptions {
  env?: Record<string, string | undefined>;
  stdin?: string;
  fetch?: FetchLike;
  tty?: boolean;
  columns?: number;
  /** Working directory (default: the temporary home, which is not a git repository). */
  cwd?: string;
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
    env: { XDG_CONFIG_HOME: configHome, ...options.env },
    homeDir: home,
    cwd: options.cwd ?? home,
    isTTY: options.tty ?? false,
    ...(options.columns ? { columns: options.columns } : {}),
    fetch: options.fetch ?? handle,
  };
  const code = await main(args, io);
  return { code, stdout: out.join(''), stderr: err.join('') };
}

/** Runs with ZAMU_URL and ZAMU_KEY set (the way agents in CI call zamu). */
function as(key: string, args: string[], options: RunOptions = {}): Promise<RunResult> {
  return zamu(args, {
    ...options,
    env: { ZAMU_URL: URL, ZAMU_KEY: key, ZAMU_MACHINE: 'test-machine', ...options.env },
  });
}

function parsed<N extends CliResultName>(result: RunResult, name: N) {
  expect(result.stdout.trim().split('\n'), 'one JSON line when piped').toHaveLength(1);
  return parseCliOutput(JSON.parse(result.stdout), name);
}

function expectFailure(result: RunResult, exitCode: number, code: string) {
  expect(result.code, result.stdout + result.stderr).toBe(exitCode);
  const error = parsed(result, 'error');
  expect(error.data.code).toBe(code);
  return error.data;
}

beforeAll(async () => {
  database = await createTestDatabase({ prefix: 'pm_cli' });
  database.pool.on('error', () => {});
  server = createServerContext({
    DATABASE_URL: database.url,
    BETTER_AUTH_SECRET: SECRET,
    BETTER_AUTH_URL: URL,
    PUBLIC_URL: URL,
  });
  handle = createApiFetchHandler(server);
  const seeded = await seedDevData(server, { planning: true });
  keys.agent = seeded.agentKey;
  keys.admin = seeded.adminKey;
  agentName = seeded.agent.name;
  adminName = seeded.admin.name;

  const admin: Actor = {
    userId: seeded.admin.id,
    kind: 'person',
    workspaceId: seeded.workspaceId,
    role: 'owner',
    onBehalfOfId: null,
  };
  keys.adminRead = (
    await createApiKey(server, admin, { name: 'read only', scope: { projects: 'all', access: 'read' } })
  ).key;
  const revoked = await createApiKey(server, admin, {
    name: 'revoked',
    scope: { projects: 'all', access: 'write' },
  });
  await revokeApiKey(server, admin, { id: revoked.id });
  keys.revoked = revoked.key;
}, 60_000);

afterAll(async () => {
  await server?.pool.end();
  await database?.drop();
});

beforeEach(async () => {
  home = await mkdtemp(join(tmpdir(), 'zamu-cli-home-'));
  configHome = join(home, 'xdg');
  return () => rm(home, { recursive: true, force: true });
});

describe('zamu login, whoami, logout', () => {
  it('validates the key with GET /me and stores url and key with mode 0600', async () => {
    const login = await zamu(['login', '--key', keys.agent, '--url', `${URL}/`, '--json']);
    expect(login.code, login.stderr).toBe(0);
    const out = parsed(login, 'login');
    expect(out.data.url).toBe(URL);
    expect(out.data.me.user).toMatchObject({ name: agentName, kind: 'agent', email: null });
    expect(out.data.me.user.responsible?.name).toBe(adminName);

    const path = join(configHome, 'zamu', 'config.json');
    const workspace = out.data.me.workspace;
    expect(JSON.parse(await readFile(path, 'utf8'))).toEqual({
      version: 2,
      logins: [{ url: URL, key: keys.agent, workspace, default: true }],
    });
    expect(out.data).toMatchObject({ replaced: false, default: true });
    expect((await stat(path)).mode & 0o777).toBe(0o600);
    expect((await stat(join(configHome, 'zamu'))).mode & 0o777).toBe(0o700);

    const whoami = await zamu(['whoami', '--json']);
    expect(whoami.code, whoami.stderr).toBe(0);
    const me = parsed(whoami, 'whoami');
    expect(me.data.auth).toEqual({ method: 'api_key', scope: { projects: 'all', access: 'write' } });

    const human = await zamu(['whoami']);
    expect(human.stdout).toContain(`${agentName} for ${adminName} (agent)`);
    expect(human.stdout).toMatch(/Access\s+API key: all projects, write/);
    expect(human.stdout).toMatch(new RegExp(`Server\\s+${URL}`));

    const logout = await zamu(['logout', '--json']);
    expect(logout.code).toBe(0);
    expect(parsed(logout, 'logout').data).toEqual({
      url: URL,
      removed: [{ url: URL, workspace, default: true }],
    });
    await expect(stat(path)).rejects.toThrow();

    const again = await zamu(['logout', '--json']);
    expect(parsed(again, 'logout').data).toEqual({ url: null, removed: [] });
  });

  it('falls back to ~/.config when XDG_CONFIG_HOME is unset, and reads the key from stdin', async () => {
    const login = await zamu(['login', '--key', '-', '--url', URL], {
      env: { XDG_CONFIG_HOME: undefined },
      stdin: `${keys.admin}\n`,
    });
    expect(login.code, login.stderr).toBe(0);
    expect(login.stdout).toContain(`Logged in as ${adminName}`);
    const path = join(home, '.config', 'zamu', 'config.json');
    expect(JSON.parse(await readFile(path, 'utf8')).logins[0].key).toBe(keys.admin);
  });

  it('refuses a revoked key with exit code 2 and stores nothing', async () => {
    const result = await zamu(['login', '--key', keys.revoked, '--url', URL, '--json']);
    const error = expectFailure(result, 2, 'UNAUTHORIZED');
    expect(error.status).toBe(401);
    expect(error.requestId).toEqual(expect.any(String));
    await expect(stat(join(configHome, 'zamu', 'config.json'))).rejects.toThrow();
  });

  it('rejects a malformed key before calling the server (exit 1)', async () => {
    const result = await zamu(['login', '--key', 'not-a-key', '--json'], {
      fetch: () => {
        throw new Error('must not be called');
      },
    });
    expectFailure(result, 1, 'BAD_REQUEST');
  });

  it('exits 2 when no credentials exist', async () => {
    const result = await zamu(['whoami']);
    expect(result.code).toBe(2);
    expect(result.stderr).toContain('Not logged in');
    expect(result.stdout).toBe('');
  });

  it('lets ZAMU_URL and ZAMU_KEY override the stored config', async () => {
    expect((await zamu(['login', '--key', keys.agent, '--url', URL])).code).toBe(0);
    const result = await as(keys.admin, ['whoami', '--json']);
    expect(parsed(result, 'whoami').data.user.name).toBe(adminName);
    // ZAMU_API_KEY (what the dev seed prints) works too.
    const seedStyle = await zamu(['whoami', '--json'], { env: { ZAMU_URL: URL, ZAMU_API_KEY: keys.admin } });
    expect(parsed(seedStyle, 'whoami').data.user.name).toBe(adminName);
  });
});

describe('zamu projects list', () => {
  it('lists projects with open counts', async () => {
    const result = await as(keys.agent, ['projects', 'list', '--json']);
    expect(result.code, result.stderr).toBe(0);
    const keysListed = parsed(result, 'projects.list').data.items.map((p) => p.key);
    expect(keysListed.sort()).toEqual(['PAY', 'WEB']);

    const human = await as(keys.agent, ['projects', 'list']);
    const lines = human.stdout.trimEnd().split('\n');
    expect(lines[0]).toMatch(/^KEY\s+OPEN\s+BACKLOG\s+TODO\s+IN PROGRESS\s+IN REVIEW\s+ACTIVE\s+NAME$/);
    expect(lines.some((line) => /^PAY\s+\d+/.test(line) && line.endsWith('Payments'))).toBe(true);
    // Not a terminal: no ANSI colour.
    expect(human.stdout).not.toContain('\u001b[');
  });
});

describe('zamu projects delete', () => {
  /** A fetch that records every request and answers none. */
  function recording() {
    const requests: string[] = [];
    const fetch: FetchLike = async (request) => {
      requests.push(request.url);
      return new Response(null, { status: 500 });
    };
    return { requests, fetch };
  }

  it('without --confirm or with another key exits 1 and sends nothing', async () => {
    for (const args of [
      ['projects', 'delete', 'PAY'],
      ['projects', 'delete', 'PAY', '--confirm', 'WEB'],
      ['projects', 'delete', 'pay', '--confirm', ''],
    ]) {
      const { requests, fetch } = recording();
      const human = await as(keys.admin, args, { fetch });
      expect(human.code, args.join(' ')).toBe(1);
      expect(human.stderr).toBe('zamu: Pass --confirm PAY to delete project PAY.\n');
      expect(human.stdout).toBe('');
      const json = await as(keys.admin, [...args, '--json'], { fetch });
      const error = expectFailure(json, 1, 'BAD_REQUEST');
      expect(error.detail).toBe('Pass --confirm PAY to delete project PAY.');
      expect(requests).toEqual([]);
    }
  });

  it('deletes with the key confirmed, in any case, and prints the result', async () => {
    const admin = (args: string[]) => as(keys.admin, args);
    const create = (key: string) =>
      handle(
        new Request(`${URL}/api/v1/projects`, {
          method: 'POST',
          headers: { authorization: `Bearer ${keys.admin}`, 'content-type': 'application/json' },
          body: JSON.stringify({ name: `Doomed ${key}`, key }),
        }),
      );
    expect((await create('DOOM')).status).toBe(201);
    expect((await create('GONE')).status).toBe(201);

    const human = await admin(['projects', 'delete', 'doom', '--confirm', 'Doom']);
    expect(human.code, human.stderr).toBe(0);
    expect(human.stdout).toBe('Deleted project DOOM\n');

    const json = await admin(['projects', 'delete', 'GONE', '--confirm', 'GONE', '--json']);
    expect(json.code, json.stderr).toBe(0);
    expect(JSON.parse(json.stdout)).toEqual({ schema: 'zamu.v1.projects.delete', data: { deleted: 'GONE' } });
    expect(parsed(json, 'projects.delete').data).toEqual({ deleted: 'GONE' });

    const listed = parsed(await admin(['projects', 'list', '--json']), 'projects.list');
    expect(listed.data.items.map((p) => p.key).sort()).toEqual(['PAY', 'WEB']);
    // Gone now: 404 is exit 3.
    expectFailure(await admin(['projects', 'delete', 'GONE', '--confirm', 'GONE', '--json']), 3, 'NOT_FOUND');
  });

  it('agents and read-only keys get 403, exit 4', async () => {
    expectFailure(
      await as(keys.agent, ['projects', 'delete', 'PAY', '--confirm', 'PAY', '--json']),
      4,
      'FORBIDDEN',
    );
    expectFailure(
      await as(keys.adminRead, ['projects', 'delete', 'PAY', '--confirm', 'PAY', '--json']),
      4,
      'FORBIDDEN',
    );
    const human = await as(keys.agent, ['projects', 'delete', 'PAY', '--confirm', 'PAY']);
    expect(human.stderr).toContain('zamu: Only owners and admins can delete a project.');
  });

  it('is in the help', async () => {
    const help = await zamu(['projects', '--help']);
    expect(help.stdout).toMatch(/delete \[options\] <KEY>/);
    const leafHelp = await zamu(['projects', 'delete', '--help']);
    expect(leafHelp.stdout).toContain('--confirm <KEY>');
  });
});

describe('zamu tasks list', () => {
  it('lists a project with counts, task keys first', async () => {
    const result = await as(keys.agent, ['tasks', 'list', '--project', 'pay', '--json']);
    expect(result.code, result.stderr).toBe(0);
    const page = parsed(result, 'tasks.list').data;
    expect(page.items).toHaveLength(11);
    expect(Object.values(page.counts).reduce((a, b) => a + b, 0)).toBe(11);

    const human = await as(keys.agent, ['tasks', 'list', '--project', 'PAY']);
    const lines = human.stdout.trimEnd().split('\n');
    // PAY has milestones and cycles, so their columns show.
    expect(lines[0]).toMatch(/^KEY\s+STATUS\s+PRIORITY\s+ASSIGNEE\s+MILESTONE\s+CYCLE\s+TITLE$/);
    expect(lines.slice(1, 12).every((line) => /^PAY-\d+\s/.test(line))).toBe(true);
    expect(human.stdout).toMatch(/Webhooks v2\s+C1\s/);
    expect(human.stdout).toContain(`${agentName} for ${adminName}`);
    expect(human.stdout).toMatch(/11 shown · /);
  });

  it('filters by status (repeatable and comma-separated) and assignee', async () => {
    const byStatus = await as(keys.agent, [
      'tasks',
      'list',
      '--project',
      'PAY',
      '--status',
      'todo,in-progress',
      '--status',
      'In review',
      '--json',
    ]);
    const statuses = new Set(parsed(byStatus, 'tasks.list').data.items.map((t) => t.status));
    expect([...statuses].sort()).toEqual(['in_progress', 'in_review', 'todo']);

    const mine = parsed(
      await as(keys.agent, ['tasks', 'list', '--project', 'PAY', '--assignee', 'me', '--json']),
      'tasks.list',
    ).data.items;
    expect(mine.length).toBeGreaterThan(0);
    expect(mine.every((t) => t.assignee?.name === agentName)).toBe(true);

    const agents = parsed(
      await as(keys.admin, ['tasks', 'list', '--project', 'PAY', '--assignee', 'agents', '--json']),
      'tasks.list',
    ).data.items;
    expect(agents.map((t) => t.key).sort()).toEqual(mine.map((t) => t.key).sort());

    const byName = parsed(
      await as(keys.agent, [
        'tasks',
        'list',
        '--project',
        'PAY',
        '--assignee',
        adminName.toLowerCase(),
        '--json',
      ]),
      'tasks.list',
    ).data.items;
    expect(byName.length).toBeGreaterThan(0);
    expect(byName.every((t) => t.assignee?.name === adminName)).toBe(true);
  });

  it('pages with --limit and --cursor', async () => {
    const first = parsed(
      await as(keys.agent, ['tasks', 'list', '--project', 'PAY', '--limit', '4', '--json']),
      'tasks.list',
    ).data;
    expect(first.items).toHaveLength(4);
    expect(first.nextCursor).toEqual(expect.any(String));
    const human = await as(keys.agent, ['tasks', 'list', '--project', 'PAY', '--limit', '4']);
    expect(human.stdout).toContain(`More: add --cursor ${first.nextCursor}`);
    const second = parsed(
      await as(keys.agent, [
        'tasks',
        'list',
        '--project',
        'PAY',
        '--limit',
        '4',
        '--cursor',
        first.nextCursor as string,
        '--json',
      ]),
      'tasks.list',
    ).data;
    expect(second.items.map((t) => t.key)).not.toContain(first.items[0]?.key);
  });

  it('maps errors to exit codes', async () => {
    expectFailure(await as(keys.agent, ['tasks', 'list', '--project', 'NOPE', '--json']), 3, 'NOT_FOUND');
    expectFailure(
      await as(keys.agent, ['tasks', 'list', '--project', 'PAY', '--status', 'started', '--json']),
      1,
      'BAD_REQUEST',
    );
    expectFailure(
      await as(keys.agent, ['tasks', 'list', '--project', 'PAY', '--limit', '500', '--json']),
      1,
      'BAD_REQUEST',
    );
    expectFailure(
      await as(keys.agent, ['tasks', 'list', '--project', 'PAY', '--assignee', 'nobody-here', '--json']),
      3,
      'NOT_FOUND',
    );
    expectFailure(await as(keys.revoked, ['tasks', 'list', '--project', 'PAY', '--json']), 2, 'UNAUTHORIZED');
  });
});

describe('zamu tasks show', () => {
  it('shows a task with its activity, agents "for" their human', async () => {
    const list = parsed(
      await as(keys.agent, ['tasks', 'list', '--project', 'PAY', '--status', 'in_review', '--json']),
      'tasks.list',
    ).data.items;
    const webhook = list.find((t) => t.title.startsWith('Webhook signature'));
    if (!webhook) throw new Error('seed task missing');

    const result = await as(keys.agent, ['tasks', 'show', webhook.key.toLowerCase(), '--json']);
    expect(result.code, result.stderr).toBe(0);
    const shown = parsed(result, 'tasks.show').data;
    expect(shown.task.key).toBe(webhook.key);
    expect(shown.task.description).toContain('Reject timestamps');
    expect(shown.activity.length).toBeGreaterThanOrEqual(2);

    const human = await as(keys.agent, ['tasks', 'show', webhook.key]);
    expect(human.stdout.split('\n')[0]).toBe(`${webhook.key}  ${webhook.title}`);
    expect(human.stdout).toMatch(new RegExp(`Assignee\\s+${agentName} for ${adminName}`));
    expect(human.stdout).toContain('Reject timestamps older than 5 minutes');
    expect(human.stdout).toContain(`${agentName} for ${adminName} moved it from In progress to In review`);
  });

  it('exits 3 for a missing task and 1 for a malformed key', async () => {
    expectFailure(await as(keys.agent, ['tasks', 'show', 'PAY-9999', '--json']), 3, 'NOT_FOUND');
    const human = await as(keys.agent, ['tasks', 'show', 'PAY-9999']);
    expect(human.code).toBe(3);
    expect(human.stderr).toMatch(/^zamu: /);
    expectFailure(await as(keys.agent, ['tasks', 'show', 'PAY142', '--json']), 1, 'BAD_REQUEST');
  });
});

describe('zamu tasks create and update', () => {
  it('creates a task with a description from stdin, assigned by name', async () => {
    const result = await as(
      keys.agent,
      [
        'tasks',
        'create',
        '--project',
        'web',
        'Fix',
        'the',
        'footer',
        '--description',
        '-',
        '--priority',
        'High',
        '--assignee',
        agentName,
        '--status',
        'in-progress',
        '--json',
      ],
      { stdin: '## Notes\n\nFrom stdin.\n' },
    );
    expect(result.code, result.stdout + result.stderr).toBe(0);
    const task = parsed(result, 'tasks.create').data;
    expect(task).toMatchObject({
      title: 'Fix the footer',
      description: '## Notes\n\nFrom stdin.\n',
      priority: 'high',
      status: 'in_progress',
      project: { key: 'WEB' },
    });
    expect(task.assignee?.name).toBe(agentName);
    expect(task.createdOnBehalfOf?.name).toBe(adminName);

    const human = await as(keys.agent, ['tasks', 'create', '--project', 'WEB', 'Plain task']);
    expect(human.code, human.stderr).toBe(0);
    expect(human.stdout).toMatch(/^Created WEB-\d+ {2}Plain task\n/);
    expect(human.stdout).toMatch(/Status\s+Todo/);
    expect(human.stdout).toMatch(/Assignee\s+Unassigned/);
  });

  it('updates status, priority, title and assignee, then unassigns', async () => {
    const created = parsed(
      await as(keys.agent, ['tasks', 'create', '--project', 'PAY', 'Update me', '--json']),
      'tasks.create',
    ).data;

    const moved = await as(keys.agent, [
      'tasks',
      'update',
      created.key,
      '--status',
      'in_progress',
      '--priority',
      'urgent',
      '--title',
      'Updated title',
      '--assignee',
      'me',
      '--json',
    ]);
    expect(moved.code, moved.stdout + moved.stderr).toBe(0);
    expect(parsed(moved, 'tasks.update').data).toMatchObject({
      status: 'in_progress',
      priority: 'urgent',
      title: 'Updated title',
      assignee: { name: agentName, responsible: { name: adminName } },
    });

    const human = await as(keys.agent, ['tasks', 'update', created.key, '--unassign']);
    expect(human.code, human.stderr).toBe(0);
    expect(human.stdout).toMatch(new RegExp(`^Updated ${created.key} {2}Updated title\\n`));
    expect(human.stdout).toMatch(/Assignee\s+Unassigned/);

    const show = await as(keys.agent, ['tasks', 'show', created.key]);
    expect(show.stdout).toMatch(/ {2}claude-dev for Ana Ruiz created the task( {2}test-machine)?\n/);
    expect(show.stdout).toMatch(
      / {2}claude-dev for Ana Ruiz renamed it to "Updated title", moved it from Todo to In progress, changed the priority from No priority to Urgent, assigned it to claude-dev {2}test-machine\n/,
    );
    expect(show.stdout).toMatch(/ {2}claude-dev for Ana Ruiz unassigned claude-dev {2}test-machine\n/);
  });

  it('maps write errors to exit codes', async () => {
    // Read-only key: forbidden.
    expectFailure(
      await as(keys.adminRead, ['tasks', 'update', 'PAY-1', '--status', 'done', '--json']),
      4,
      'FORBIDDEN',
    );
    expectFailure(
      await as(keys.adminRead, ['tasks', 'create', '--project', 'PAY', 'Nope', '--json']),
      4,
      'FORBIDDEN',
    );
    // Nothing to change, both assignee flags, bad values: usage, before the request.
    expectFailure(await as(keys.agent, ['tasks', 'update', 'PAY-1', '--json']), 1, 'BAD_REQUEST');
    expectFailure(
      await as(keys.agent, ['tasks', 'update', 'PAY-1', '--assignee', 'me', '--unassign', '--json']),
      1,
      'BAD_REQUEST',
    );
    expectFailure(
      await as(keys.agent, ['tasks', 'create', '--project', 'PAY', 'X', '--priority', 'p1', '--json']),
      1,
      'BAD_REQUEST',
    );
    expectFailure(
      await as(keys.agent, ['tasks', 'create', '--project', 'PAY', 'X', '--assignee', 'agents', '--json']),
      1,
      'BAD_REQUEST',
    );
    expectFailure(
      await as(keys.agent, ['tasks', 'update', 'PAY-9999', '--status', 'done', '--json']),
      3,
      'NOT_FOUND',
    );
  });
});

// ---------------------------------------------------------------------------
// M2: work across projects, milestones, cycles, comments
// ---------------------------------------------------------------------------

/** Today as the server sees it (APP_TIME_ZONE defaults to UTC), shifted by `days`. */
function day(days = 0): string {
  return new Date(Date.now() + days * 86_400_000).toISOString().slice(0, 10);
}

describe('zamu tasks list across projects, milestones and cycles', () => {
  it('lists every readable project without --project, or several with it', async () => {
    const all = parsed(
      await as(keys.agent, ['tasks', 'list', '--limit', '200', '--json']),
      'tasks.list',
    ).data;
    expect(new Set(all.items.map((t) => t.project.key))).toEqual(new Set(['PAY', 'WEB']));

    const both = parsed(
      await as(keys.agent, ['tasks', 'list', '--project', 'pay,web', '--limit', '200', '--json']),
      'tasks.list',
    ).data;
    expect(both.items.map((t) => t.key).sort()).toEqual(all.items.map((t) => t.key).sort());
    const repeated = parsed(
      await as(keys.agent, ['tasks', 'list', '--project', 'PAY', '--project', 'WEB', '--json']),
      'tasks.list',
    ).data;
    expect(new Set(repeated.items.map((t) => t.project.key))).toEqual(new Set(['PAY', 'WEB']));

    const human = await as(keys.agent, ['tasks', 'list', '--project', 'WEB']);
    // WEB has no milestones or cycles: the M1 columns only.
    expect(human.stdout.split('\n')[0]).toMatch(/^KEY\s+STATUS\s+PRIORITY\s+ASSIGNEE\s+TITLE$/);
  });

  it('--mine lists my tasks in every project', async () => {
    const mine = parsed(await as(keys.agent, ['tasks', 'list', '--mine', '--json']), 'tasks.list').data.items;
    expect(mine.length).toBeGreaterThan(0);
    expect(mine.every((t) => t.assignee?.name === agentName)).toBe(true);
    expect(new Set(mine.map((t) => t.project.key))).toEqual(new Set(['PAY', 'WEB']));

    const conflict = await as(keys.agent, ['tasks', 'list', '--mine', '--assignee', 'me', '--json']);
    expectFailure(conflict, 1, 'BAD_REQUEST');
  });

  it('filters by milestone name (any case), id or none', async () => {
    const byName = parsed(
      await as(keys.agent, ['tasks', 'list', '--project', 'PAY', '--milestone', 'webhooks V2', '--json']),
      'tasks.list',
    ).data.items;
    expect(byName.map((t) => t.key).sort()).toEqual(['PAY-1', 'PAY-2', 'PAY-3', 'PAY-4', 'PAY-5']);

    const id = byName[0]?.milestone?.id as string;
    const byId = parsed(
      await as(keys.agent, ['tasks', 'list', '--milestone', id, '--json']),
      'tasks.list',
    ).data;
    expect(byId.items).toHaveLength(5);

    const none = parsed(
      await as(keys.agent, ['tasks', 'list', '--project', 'PAY', '--milestone', 'none', '--json']),
      'tasks.list',
    ).data.items;
    expect(none.length).toBeGreaterThan(0);
    expect(none.every((t) => t.milestone === null)).toBe(true);
  });

  it('rejects unknown milestone names with the candidates, and names without one project', async () => {
    const unknown = await as(keys.agent, [
      'tasks',
      'list',
      '--project',
      'PAY',
      '--milestone',
      'Nope',
      '--json',
    ]);
    const error = expectFailure(unknown, 1, 'BAD_REQUEST');
    expect(error.detail).toBe('No milestone named "Nope" in PAY.');
    expect(error.issues?.[0]?.message).toContain('"Webhooks v2"');
    expect(error.issues?.[0]?.message).toContain('"PCI audit"');

    const human = await as(keys.agent, ['tasks', 'list', '--project', 'PAY', '--milestone', 'Nope']);
    expect(human.code).toBe(1);
    expect(human.stderr).toMatch(
      /\n {2}Milestones in PAY: "(Webhooks v2|PCI audit)", "(Webhooks v2|PCI audit)"\n/,
    );

    const noProject = await as(keys.agent, ['tasks', 'list', '--milestone', 'Webhooks v2', '--json']);
    expect(expectFailure(noProject, 1, 'BAD_REQUEST').detail).toContain('needs one --project');
    const empty = await as(keys.agent, ['tasks', 'list', '--project', 'WEB', '--milestone', 'x', '--json']);
    expect(expectFailure(empty, 1, 'BAD_REQUEST').issues?.[0]?.message).toBe('WEB has no milestones.');
  });

  it('filters by cycle: current, next, a number or none', async () => {
    const list = async (cycle: string) =>
      parsed(
        await as(keys.agent, ['tasks', 'list', '--project', 'PAY', '--cycle', cycle, '--json']),
        'tasks.list',
      ).data.items;
    const current = await list('Current');
    expect(current.map((t) => t.key).sort()).toEqual(['PAY-1', 'PAY-2', 'PAY-3', 'PAY-4', 'PAY-5', 'PAY-6']);
    expect((await list('1')).map((t) => t.key).sort()).toEqual(current.map((t) => t.key).sort());
    expect((await list('next')).map((t) => t.key).sort()).toEqual(['PAY-7', 'PAY-8']);
    expect((await list('none')).every((t) => t.cycle === null)).toBe(true);
    expectFailure(
      await as(keys.agent, ['tasks', 'list', '--project', 'PAY', '--cycle', 'later', '--json']),
      1,
      'BAD_REQUEST',
    );
  });
});

describe('zamu tasks create and update with milestones and cycles', () => {
  it('creates a task in a milestone (by name) and the next cycle', async () => {
    const result = await as(keys.agent, [
      'tasks',
      'create',
      '--project',
      'PAY',
      'Planned task',
      '--milestone',
      'pci AUDIT',
      '--cycle',
      'next',
      '--json',
    ]);
    expect(result.code, result.stdout + result.stderr).toBe(0);
    const task = parsed(result, 'tasks.create').data;
    expect(task.milestone?.name).toBe('PCI audit');
    expect(task.cycle).toMatchObject({ number: 2, state: 'upcoming' });

    const human = await as(keys.agent, [
      'tasks',
      'create',
      '--project',
      'PAY',
      'Current task',
      '--milestone',
      'Webhooks v2',
      '--cycle',
      'current',
    ]);
    expect(human.code, human.stderr).toBe(0);
    expect(human.stdout).toMatch(/Milestone\s+Webhooks v2 \(Active, target \d{4}-\d{2}-\d{2}\)/);
    expect(human.stdout).toMatch(/Cycle\s+Cycle 1 · Checkout rewrite \(Current, /);

    expectFailure(
      await as(keys.agent, ['tasks', 'create', '--project', 'PAY', 'X', '--milestone', 'Nope', '--json']),
      1,
      'BAD_REQUEST',
    );
    expectFailure(
      await as(keys.agent, ['tasks', 'create', '--project', 'PAY', 'X', '--cycle', '99', '--json']),
      1,
      'UNPROCESSABLE_CONTENT',
    );
  });

  it('sets and clears the milestone and cycle; the history says so', async () => {
    const created = parsed(
      await as(keys.agent, ['tasks', 'create', '--project', 'PAY', 'Move me around', '--json']),
      'tasks.create',
    ).data;
    const set = await as(keys.agent, [
      'tasks',
      'update',
      created.key.toLowerCase(),
      '--milestone',
      'webhooks v2',
      '--cycle',
      '2',
      '--json',
    ]);
    expect(set.code, set.stdout + set.stderr).toBe(0);
    expect(parsed(set, 'tasks.update').data).toMatchObject({
      milestone: { name: 'Webhooks v2' },
      cycle: { number: 2 },
    });

    const cleared = await as(keys.agent, [
      'tasks',
      'update',
      created.key,
      '--milestone',
      'none',
      '--cycle',
      'NONE',
      '--json',
    ]);
    expect(cleared.code, cleared.stdout + cleared.stderr).toBe(0);
    expect(parsed(cleared, 'tasks.update').data).toMatchObject({ milestone: null, cycle: null });

    const show = await as(keys.agent, ['tasks', 'show', created.key]);
    expect(show.stdout).toContain('claude-dev for Ana Ruiz set milestone Webhooks v2, moved it to Cycle 2');
    expect(show.stdout).toContain('claude-dev for Ana Ruiz cleared the milestone, removed it from Cycle 2');

    // Milestone names resolve in the task's own project.
    const wrongProject = await as(keys.agent, [
      'tasks',
      'update',
      'WEB-1',
      '--milestone',
      'Webhooks v2',
      '--json',
    ]);
    expect(expectFailure(wrongProject, 1, 'BAD_REQUEST').detail).toBe(
      'No milestone named "Webhooks v2" in WEB.',
    );
  });
});

describe('zamu tasks show timeline', () => {
  it('prints comments inline with activity, oldest first', async () => {
    const result = await as(keys.agent, ['tasks', 'show', 'PAY-1', '--json']);
    expect(result.code, result.stderr).toBe(0);
    const shown = parsed(result, 'tasks.show').data;
    const timeline = shown.timeline ?? [];
    const comments = timeline.filter((item) => item.kind === 'comment');
    expect(comments).toHaveLength(3);
    // v1 readers still get the activity list.
    expect(shown.activity).toHaveLength(timeline.length - 3);
    const times = timeline.map((item) => item.createdAt);
    expect([...times].sort()).toEqual(times);

    const human = await as(keys.agent, ['tasks', 'show', 'PAY-1']);
    const out = human.stdout;
    expect(out).toMatch(/\nHistory · 0 notes · 3 comments · \d+ changes\n/);
    expect(out).toMatch(
      /\d{4}-\d{2}-\d{2} \d{2}:\d{2} {2}Ana Ruiz commented {2}[0-9a-f-]{36}\n {4}Should 429 count/,
    );
    expect(out).toMatch(/claude-dev for Ana Ruiz commented {2}[0-9a-f-]{36}\n {4}Done\. 429 now waits/);
    // Blank lines inside a comment stay blank; list items keep their place under the indent.
    expect(out).toContain('\n\n    - 4xx stops retrying, except 408 and 429\n    - Tests: 14 new cases\n');
    // Mentions read as plain @names.
    expect(out).toContain('    Thanks @claude-dev, looks good.');
    expect(out).not.toContain('mention:');
    // Activity entries keep their one-line form.
    expect(out).toMatch(/\n\d{4}-\d{2}-\d{2} \d{2}:\d{2} {2}Ana Ruiz set milestone Webhooks v2/);
  });

  it('falls back to the activity list on a server without the timeline route', async () => {
    const result = await as(keys.agent, ['tasks', 'show', 'PAY-1', '--json'], {
      fetch: async (request) =>
        request.url.endsWith('/timeline')
          ? Response.json(
              { type: 'about:blank', title: 'Not found', status: 404, code: 'NOT_FOUND' },
              { status: 404 },
            )
          : handle(request),
    });
    expect(result.code, result.stdout).toBe(0);
    const shown = parsed(result, 'tasks.show').data;
    expect(shown.activity.length).toBeGreaterThan(0);
    expect(shown.timeline?.every((item) => item.kind === 'activity')).toBe(true);
  });
});

describe('zamu comments', () => {
  it('adds a comment from stdin with a mention, lists, edits and deletes it', async () => {
    const added = await as(keys.agent, ['comments', 'add', 'pay-2', '-', '--json'], {
      stdin: 'Picked this up. @ana@example.com can you review?\n',
    });
    expect(added.code, added.stdout + added.stderr).toBe(0);
    const comment = parsed(added, 'comments.add').data;
    expect(comment).toMatchObject({
      taskKey: 'PAY-2',
      author: { name: agentName },
      onBehalfOf: { name: adminName },
      editedAt: null,
      deletedAt: null,
    });
    expect(comment.body).toMatch(/\[@Ana Ruiz\]\(mention:[0-9a-f-]+\)/);
    expect(comment.mentions.map((m) => m.name)).toEqual([adminName]);

    const humanAdd = await as(keys.agent, ['comments', 'add', 'PAY-2', 'Second note']);
    expect(humanAdd.code, humanAdd.stderr).toBe(0);
    expect(humanAdd.stdout).toMatch(/^Added comment [0-9a-f-]{36} on PAY-2\n\n/);
    expect(humanAdd.stdout).toContain('claude-dev for Ana Ruiz commented');
    expect(humanAdd.stdout).toContain('    Second note');

    const list = parsed(await as(keys.agent, ['comments', 'list', 'PAY-2', '--json']), 'comments.list').data;
    expect(list.items.map((c) => c.id)).toContain(comment.id);
    const humanList = await as(keys.agent, ['comments', 'list', 'PAY-2']);
    expect(humanList.stdout).toContain('    Picked this up. @Ana Ruiz can you review?');

    const edited = await as(keys.agent, [
      'comments',
      'edit',
      comment.id,
      'Picked this up, reviewing now.',
      '--json',
    ]);
    expect(edited.code, edited.stdout).toBe(0);
    const editedData = parsed(edited, 'comments.edit').data;
    expect(editedData.body).toBe('Picked this up, reviewing now.');
    expect(editedData.editedAt).toEqual(expect.any(String));
    expect(editedData.mentions).toEqual([]);

    // Only the author edits or deletes, even the agent's responsible human.
    expectFailure(
      await as(keys.admin, ['comments', 'edit', comment.id, 'Mine now', '--json']),
      4,
      'FORBIDDEN',
    );
    expectFailure(await as(keys.admin, ['comments', 'delete', comment.id, '--json']), 4, 'FORBIDDEN');

    const deleted = await as(keys.agent, ['comments', 'delete', comment.id, '--json']);
    expect(deleted.code, deleted.stdout).toBe(0);
    expect(parsed(deleted, 'comments.delete').data).toMatchObject({ id: comment.id, body: null });
    expectFailure(await as(keys.agent, ['comments', 'edit', comment.id, 'Again', '--json']), 1, 'CONFLICT');
    expectFailure(await as(keys.agent, ['comments', 'delete', comment.id, '--json']), 1, 'CONFLICT');

    const show = await as(keys.agent, ['tasks', 'show', 'PAY-2']);
    expect(show.stdout).toMatch(/ {2}Comment deleted by claude-dev for Ana Ruiz\n/);
    expect(show.stdout).toMatch(
      /claude-dev for Ana Ruiz commented {2}[0-9a-f-]{36} {2}test-machine\n {4}Second note/,
    );

    const humanDelete = await as(keys.agent, [
      'comments',
      'delete',
      parsed(await as(keys.agent, ['comments', 'list', 'PAY-2', '--json']), 'comments.list').data.items.at(-1)
        ?.id as string,
    ]);
    expect(humanDelete.stdout).toMatch(
      /^Deleted comment [0-9a-f-]{36} by claude-dev for Ana Ruiz on PAY-2\n$/,
    );
  });

  it('maps comment errors to exit codes', async () => {
    expectFailure(await as(keys.agent, ['comments', 'add', 'PAY-1', '   ', '--json']), 1, 'BAD_REQUEST');
    expectFailure(await as(keys.agent, ['comments', 'add', 'PAY-9999', 'Hi', '--json']), 3, 'NOT_FOUND');
    expectFailure(await as(keys.adminRead, ['comments', 'add', 'PAY-1', 'Hi', '--json']), 4, 'FORBIDDEN');
    expectFailure(await as(keys.agent, ['comments', 'edit', 'not-an-id', 'Hi', '--json']), 1, 'BAD_REQUEST');
    expectFailure(
      await as(keys.agent, ['comments', 'delete', '01a16817-0000-7000-8000-000000000000', '--json']),
      3,
      'NOT_FOUND',
    );
    const empty = await as(keys.agent, ['comments', 'list', 'WEB-4']);
    expect(empty.stdout).toBe('No comments on WEB-4.\n');
  });
});

describe('zamu milestones', () => {
  it('lists milestones with progress, overdue first by target date', async () => {
    const result = await as(keys.agent, ['milestones', 'list', '--project', 'pay', '--json']);
    expect(result.code, result.stderr).toBe(0);
    const items = parsed(result, 'milestones.list').data.items;
    const audit = items.find((m) => m.name === 'PCI audit');
    expect(audit).toMatchObject({ overdue: true });

    const human = await as(keys.agent, ['milestones', 'list', '--project', 'PAY']);
    const lines = human.stdout.trimEnd().split('\n');
    expect(lines[0]).toMatch(/^STATUS\s+TARGET\s+DONE\s+IN PROGRESS\s+OPEN\s+NAME$/);
    expect(human.stdout).toMatch(/\d{4}-\d{2}-\d{2} overdue\s+\d+\/\d+ · \d+%\s+\d+\s+\d+\s+PCI audit/);

    expect((await as(keys.agent, ['milestones', 'list', '--project', 'WEB'])).stdout).toBe(
      'No milestones in WEB.\n',
    );
  });

  it('creates and updates a milestone by name or id', async () => {
    const target = day(30);
    const created = await as(
      keys.agent,
      [
        'milestones',
        'create',
        '--project',
        'WEB',
        'Public',
        'beta',
        '--target',
        target,
        '--description',
        '-',
        '--json',
      ],
      { stdin: 'Open the beta to everyone.' },
    );
    expect(created.code, created.stdout + created.stderr).toBe(0);
    const milestone = parsed(created, 'milestones.create').data;
    expect(milestone).toMatchObject({
      name: 'Public beta',
      targetDate: target,
      status: 'planned',
      description: 'Open the beta to everyone.',
      daysLeft: 30,
      overdue: false,
    });

    // Names are unique per project, ignoring case.
    expectFailure(
      await as(keys.agent, ['milestones', 'create', '--project', 'WEB', 'public BETA', '--json']),
      1,
      'CONFLICT',
    );

    const byName = await as(keys.agent, [
      'milestones',
      'update',
      'PUBLIC beta',
      '--project',
      'web',
      '--target',
      'none',
      '--status',
      'Completed',
      '--json',
    ]);
    expect(byName.code, byName.stdout + byName.stderr).toBe(0);
    expect(parsed(byName, 'milestones.update').data).toMatchObject({
      id: milestone.id,
      targetDate: null,
      status: 'completed',
    });

    const byId = await as(keys.agent, [
      'milestones',
      'update',
      milestone.id,
      '--name',
      'Open beta',
      '--status',
      'planned',
    ]);
    expect(byId.code, byId.stderr).toBe(0);
    expect(byId.stdout).toMatch(/^Updated milestone Open beta in WEB\n/);
    // Leaving Completed reopens as Active.
    expect(byId.stdout).toMatch(/Status\s+Active/);
    expect(byId.stdout).toMatch(/Target\s+None/);
    expect(byId.stdout).toMatch(new RegExp(`Id\\s+${milestone.id}`));

    const human = await as(keys.agent, [
      'milestones',
      'create',
      '--project',
      'WEB',
      'GA',
      '--target',
      day(10),
    ]);
    expect(human.stdout).toMatch(/^Created milestone GA in WEB\n/);
    expect(human.stdout).toMatch(/Target\s+\d{4}-\d{2}-\d{2} \(10 days left\)/);
    expect(human.stdout).toMatch(/Progress\s+0\/0 · 0%/);
  });

  it('maps milestone errors to exit codes', async () => {
    const noProject = await as(keys.agent, ['milestones', 'update', 'Webhooks v2', '--name', 'X', '--json']);
    expect(expectFailure(noProject, 1, 'BAD_REQUEST').detail).toContain('needs one --project');
    const unknown = await as(keys.agent, [
      'milestones',
      'update',
      'Nope',
      '--project',
      'PAY',
      '--name',
      'X',
      '--json',
    ]);
    expect(expectFailure(unknown, 1, 'BAD_REQUEST').issues?.[0]?.message).toContain('"Webhooks v2"');
    // Nothing to change: usage, before any request.
    expectFailure(
      await as(keys.agent, ['milestones', 'update', 'Webhooks v2', '--project', 'PAY', '--json'], {
        fetch: () => {
          throw new Error('must not be called');
        },
      }),
      1,
      'BAD_REQUEST',
    );
    expectFailure(
      await as(keys.agent, [
        'milestones',
        'update',
        'Webhooks v2',
        '--project',
        'PAY',
        '--status',
        'done',
        '--json',
      ]),
      1,
      'BAD_REQUEST',
    );
    expectFailure(
      await as(keys.agent, [
        'milestones',
        'create',
        '--project',
        'PAY',
        'X',
        '--target',
        'tomorrow',
        '--json',
      ]),
      1,
      'BAD_REQUEST',
    );
    expectFailure(
      await as(keys.agent, ['milestones', 'list', '--project', 'NOPE', '--json']),
      3,
      'NOT_FOUND',
    );
    expectFailure(
      await as(keys.adminRead, ['milestones', 'create', '--project', 'PAY', 'Nope', '--json']),
      4,
      'FORBIDDEN',
    );
  });
});

describe('zamu cycles', () => {
  it('lists cycles and shows the current one', async () => {
    const result = await as(keys.agent, ['cycles', 'list', '--project', 'PAY', '--json']);
    expect(result.code, result.stderr).toBe(0);
    const items = parsed(result, 'cycles.list').data.items;
    expect(items.map((c) => [c.number, c.state])).toEqual([
      [1, 'current'],
      [2, 'upcoming'],
    ]);

    const human = await as(keys.agent, ['cycles', 'list', '--project', 'PAY']);
    const lines = human.stdout.trimEnd().split('\n');
    expect(lines[0]).toMatch(/^CYCLE\s+STATE\s+STARTS\s+ENDS\s+LEFT\s+TASKS\s+NAME$/);
    expect(lines[1]).toMatch(
      /^1\s+Current\s+\d{4}-\d{2}-\d{2}\s+\d{4}-\d{2}-\d{2}\s+\d+d\s+\d+\/\d+ done\s+Checkout rewrite$/,
    );

    const current = parsed(
      await as(keys.agent, ['cycles', 'current', '--project', 'PAY', '--json']),
      'cycles.current',
    ).data;
    expect(current).toMatchObject({ number: 1, name: 'Checkout rewrite', state: 'current' });
    const currentHuman = await as(keys.agent, ['cycles', 'current', '--project', 'PAY']);
    expect(currentHuman.stdout).toMatch(/^Cycle 1 · Checkout rewrite\n/);
    expect(currentHuman.stdout).toMatch(/State\s+Current, \d+ days? left/);
    expect(currentHuman.stdout).toMatch(/Tasks\s+\d+ · \d+ done · \d+ in progress · \d+ open/);
  });

  it('prints null when there is no current cycle', async () => {
    const none = await as(keys.agent, ['cycles', 'current', '--project', 'WEB', '--json']);
    expect(none.code, none.stderr).toBe(0);
    expect(parsed(none, 'cycles.current').data).toBeNull();
    const human = await as(keys.agent, ['cycles', 'current', '--project', 'WEB']);
    expect(human.code).toBe(0);
    expect(human.stdout).toBe('WEB has no current cycle.\n');
  });

  it('creates cycles with given or default dates, and rejects overlaps', async () => {
    const created = await as(keys.agent, [
      'cycles',
      'create',
      '--project',
      'WEB',
      '--starts',
      day(-3),
      '--ends',
      day(3),
      '--name',
      'Polish',
      '--json',
    ]);
    expect(created.code, created.stdout + created.stderr).toBe(0);
    expect(parsed(created, 'cycles.create').data).toMatchObject({
      number: 1,
      name: 'Polish',
      startsOn: day(-3),
      endsOn: day(3),
      state: 'current',
      daysLeft: 4,
    });

    const next = await as(keys.agent, ['cycles', 'create', '--project', 'WEB']);
    expect(next.code, next.stderr).toBe(0);
    expect(next.stdout).toMatch(/^Created Cycle 2 in WEB\n/);
    expect(next.stdout).toContain(`Dates  ${day(4)} to ${day(10)}`);

    expectFailure(
      await as(keys.agent, [
        'cycles',
        'create',
        '--project',
        'WEB',
        '--starts',
        day(5),
        '--ends',
        day(6),
        '--json',
      ]),
      1,
      'CONFLICT',
    );
    expectFailure(
      await as(keys.agent, [
        'cycles',
        'create',
        '--project',
        'WEB',
        '--starts',
        day(20),
        '--ends',
        day(19),
        '--json',
      ]),
      1,
      'BAD_REQUEST',
    );
    expectFailure(
      await as(keys.adminRead, ['cycles', 'create', '--project', 'WEB', '--json']),
      4,
      'FORBIDDEN',
    );
  });

  it('ends a cycle by number, moving unfinished tasks to no cycle', async () => {
    for (const key of ['WEB-1', 'WEB-2']) {
      expect((await as(keys.agent, ['tasks', 'update', key, '--cycle', 'current'])).code).toBe(0);
    }
    const ended = await as(keys.agent, [
      'cycles',
      'end',
      '1',
      '--project',
      'WEB',
      '--move-to',
      'none',
      '--json',
    ]);
    expect(ended.code, ended.stdout + ended.stderr).toBe(0);
    const cycle = parsed(ended, 'cycles.end').data;
    expect(cycle).toMatchObject({ number: 1, state: 'completed', endedBy: { name: agentName } });
    expect(cycle.summary).toMatchObject({ scope: 2, rolledOver: 2 });
    expect(cycle.rollovers.map((r) => [r.task.key, r.movedTo])).toEqual(
      expect.arrayContaining([
        ['WEB-1', null],
        ['WEB-2', null],
      ]),
    );

    const show = await as(keys.agent, ['tasks', 'show', 'WEB-1']);
    expect(show.stdout).toContain('claude-dev for Ana Ruiz ended Cycle 1. Removed from the cycle.');

    expectFailure(
      await as(keys.agent, ['cycles', 'end', '--project', 'WEB', '--move-to', 'later', '--json']),
      1,
      'BAD_REQUEST',
    );
    expectFailure(await as(keys.agent, ['cycles', 'end', '7', '--project', 'WEB', '--json']), 3, 'NOT_FOUND');
  });
});

describe('TASK_CHANGED', () => {
  it('decodes the 409 with the current task', async () => {
    const task = parsed(await as(keys.agent, ['tasks', 'show', 'PAY-1', '--json']), 'tasks.show').data.task;
    const result = await as(keys.agent, ['tasks', 'update', 'PAY-1', '--status', 'done', '--json'], {
      fetch: async () =>
        Response.json(
          {
            type: 'about:blank',
            title: 'Task changed',
            status: 409,
            code: 'TASK_CHANGED',
            detail: 'PAY-1 changed since you loaded it',
            task,
          },
          { status: 409 },
        ),
    });
    const error = expectFailure(result, 1, 'TASK_CHANGED');
    expect(error.status).toBe(409);
    expect(error.task?.key).toBe('PAY-1');
  });
});

describe('server failures', () => {
  it('exits 5 when the server is unreachable', async () => {
    const result = await as(keys.agent, ['projects', 'list', '--json'], {
      fetch: () =>
        Promise.reject(new TypeError('fetch failed', { cause: new Error('connect ECONNREFUSED') })),
    });
    const error = expectFailure(result, 5, 'INTERNAL_SERVER_ERROR');
    expect(error.detail).toContain(`Could not reach ${URL}`);
  });

  it('exits 5 on a 500 and on a response outside the contract', async () => {
    const failing = await as(keys.agent, ['whoami', '--json'], {
      fetch: async () => new Response('upstream broke', { status: 502 }),
    });
    expect(failing.code).toBe(5);
    expect(parsed(failing, 'error').data.status).toBe(502);

    const wrongShape = await as(keys.agent, ['whoami', '--json'], {
      fetch: async () => Response.json({ hello: 'world' }),
    });
    expectFailure(wrongShape, 5, 'INTERNAL_SERVER_ERROR');
  });
});

describe('output conventions', () => {
  it('colours and indents only on a terminal; NO_COLOR wins', async () => {
    const tty = await as(keys.agent, ['tasks', 'list', '--project', 'PAY'], { tty: true, columns: 60 });
    expect(tty.stdout).toContain('\u001b[');
    // The title column is cut to the terminal width.
    expect(tty.stdout).toContain('…');

    const noColor = await as(keys.agent, ['tasks', 'list', '--project', 'PAY'], {
      tty: true,
      env: { NO_COLOR: '1' },
    });
    expect(noColor.stdout).not.toContain('\u001b[');

    const json = await as(keys.agent, ['whoami', '--json'], { tty: true });
    expect(json.stdout.split('\n').length).toBeGreaterThan(3);
    expect(parseCliOutput(JSON.parse(json.stdout), 'whoami').schema).toBe('zamu.v1.whoami');
  });

  it('prints help and version with exit 0, unknown commands with exit 1', async () => {
    const help = await zamu(['--help']);
    expect(help.code).toBe(0);
    expect(help.stdout).toContain(
      'Exit codes: 0 ok, 1 usage or rejected input (OPEN_ITEMS: an agent moved a task with open items;\n' +
        'TASK_ARCHIVED: restore the task first; WAVE_LOCKED: an agent started a task in a locked wave;\n' +
        "GATE_TASKS_OPEN: a gate can't pass while its wave has open tasks), 2 auth, 3 not found, 4 forbidden,\n" +
        '5 server (unreachable, and nothing queued), 6 Backlog.md conflict, 7 queued',
    );
    const version = await zamu(['--version']);
    expect(version.code).toBe(0);
    expect(version.stdout.trim()).toMatch(/^\d+\.\d+\.\d+/);
    const unknown = await zamu(['frobnicate']);
    expect(unknown.code).toBe(1);
    expect(unknown.stderr).toContain("unknown command 'frobnicate'");
  });
});

describe('zamu dashboard', () => {
  it('reads GET /dashboard for Mine and Everyone', async () => {
    const mine = parsed(await as(keys.agent, ['dashboard', '--json']), 'dashboard').data;
    expect(mine.scope).toBe('mine');
    expect(mine.projects.map((p) => p.key).sort()).toEqual(['PAY', 'WEB']);

    const everyone = parsed(
      await as(keys.adminRead, ['dashboard', '--everyone', '--json']),
      'dashboard',
    ).data;
    expect(everyone.scope).toBe('everyone');
    // The base seed leaves tasks in review; Everyone sees them all.
    expect(everyone.groups.review.total).toBeGreaterThan(0);
    expect(everyone.groups.review.total).toBeGreaterThanOrEqual(mine.groups.review.total);
    expect(everyone.agents.map((a) => a.agent.name)).toContain(agentName);

    const human = await as(keys.admin, ['dashboard', '--everyone']);
    expect(human.code, human.stderr).toBe(0);
    expect(human.stdout).toMatch(/^Needs someone · \d+\n\nIn review · \d+\n/);
    expect(human.stdout).toMatch(
      /\nProjects · 2\n {2}KEY\s+NAME\s+OPEN\s+DOING\s+REVIEW\s+CYCLE\s+NEXT MILESTONE\s+ACTIVE\n/,
    );
    expect(human.stdout).toMatch(new RegExp(`\\nAgents · \\d+\\n[^]*\\n {2}${agentName} {2}`));
  });
});

/** A git repository in the temporary home with an origin remote (or none). */
async function clone(name: string, remote?: string): Promise<string> {
  const dir = join(home, name);
  await mkdir(join(dir, 'src', 'deep'), { recursive: true });
  execFileSync('git', ['init', '-q', dir]);
  if (remote) execFileSync('git', ['-C', dir, 'remote', 'add', 'origin', remote]);
  return dir;
}

describe('repository link (M2.1)', () => {
  const SSH = 'git@gitlab.example.com:team/payments.git';

  afterAll(async () => {
    await as(keys.admin, ['link', '--clear', '--project', 'PAY']);
  });

  it('zamu link links PAY to the remote, and commands in any clone of it use PAY', async () => {
    const repo = await clone('payments', SSH);
    const before = await as(keys.agent, ['milestones', 'list', '--json'], { cwd: repo });
    expect(expectFailure(before, 1, 'BAD_REQUEST').detail).toBe(
      'No project given, and no project you can read is linked to gitlab.example.com/team/payments.',
    );
    const beforeHuman = await as(keys.agent, ['milestones', 'list'], { cwd: repo });
    expect(beforeHuman.stderr).toContain('zamu link --project KEY');

    const linked = await as(keys.agent, ['link', '--project', 'pay', '--json'], { cwd: repo });
    expect(linked.code, linked.stdout).toBe(0);
    expect(parsed(linked, 'link').data).toEqual({
      project: 'PAY',
      target: 'server',
      action: 'linked',
      repository: 'gitlab.example.com/team/payments',
      file: null,
    });
    const human = await as(keys.agent, ['link', '--project', 'PAY'], { cwd: repo });
    expect(human.stdout).toBe('PAY is already linked to gitlab.example.com/team/payments.\n');

    const projects = parsed(await as(keys.agent, ['projects', 'list', '--json']), 'projects.list');
    expect(projects.data.items.find((p) => p.key === 'PAY')?.repository).toBe(SSH);
    const table = await as(keys.agent, ['projects', 'list']);
    expect(table.stdout).toMatch(/REPOSITORY\n/);
    expect(table.stdout).toContain('gitlab.example.com/team/payments');

    // A subfolder, and another clone over HTTPS with other casing, find PAY too.
    const sub = join(repo, 'src', 'deep');
    const milestones = parsed(
      await as(keys.agent, ['milestones', 'list', '--json'], { cwd: sub }),
      'milestones.list',
    );
    expect(milestones.data.items.map((m) => m.name)).toContain('Webhooks v2');
    const https = await clone('payments-https', 'https://gitlab.example.com/Team/Payments');
    const cycle = parsed(
      await as(keys.agent, ['cycles', 'current', '--json'], { cwd: https }),
      'cycles.current',
    );
    expect(cycle.data?.project.key).toBe('PAY');

    const created = parsed(
      await as(keys.agent, ['tasks', 'create', 'Filed from a clone', '--json'], { cwd: sub }),
      'tasks.create',
    );
    expect(created.data.key).toMatch(/^PAY-\d+$/);

    // A milestone name is looked up in the clone's project, and the list narrows to it.
    const byName = parsed(
      await as(keys.agent, ['tasks', 'list', '--milestone', 'webhooks v2', '--json'], { cwd: repo }),
      'tasks.list',
    );
    expect(byName.data.items.length).toBeGreaterThan(0);
    expect(new Set(byName.data.items.map((t) => t.project.key))).toEqual(new Set(['PAY']));
    // Without a milestone name, tasks list still covers every project.
    const all = parsed(
      await as(keys.agent, ['tasks', 'list', '--limit', '200', '--json'], { cwd: repo }),
      'tasks.list',
    );
    expect(new Set(all.data.items.map((t) => t.project.key))).toEqual(new Set(['PAY', 'WEB']));

    const me = parsed(await as(keys.agent, ['whoami', '--json'], { cwd: sub }), 'whoami');
    expect(me.data.project).toEqual({ key: 'PAY', source: 'remote', from: SSH });
    const meHuman = await as(keys.agent, ['whoami'], { cwd: sub });
    expect(meHuman.stdout).toMatch(/Project\s+PAY \(from git remote gitlab\.example\.com\/team\/payments\)/);
  });

  it('refuses a repository another project has, and replaces a link only with --force', async () => {
    const repo = await clone('payments-2', SSH);
    const taken = await as(keys.agent, ['link', '--project', 'WEB', '--json'], { cwd: repo });
    expect(expectFailure(taken, 1, 'CONFLICT').detail).toBe(
      'Payments (PAY) already uses gitlab.example.com/team/payments. A repository can belong to one project.',
    );
    const takenHuman = await as(keys.agent, ['link', '--project', 'WEB'], { cwd: repo });
    expect(takenHuman.stderr).toMatch(
      /^zamu: Payments \(PAY\) already uses gitlab\.example\.com\/team\/payments\. A repository can belong to one project\.\n {2}Request id: /,
    );

    const fork = await clone('payments-fork', 'https://github.com/someone/payments-fork.git');
    const refused = await as(keys.agent, ['link', '--project', 'PAY', '--json'], { cwd: fork });
    expect(expectFailure(refused, 1, 'BAD_REQUEST').detail).toBe(
      'PAY is already linked to gitlab.example.com/team/payments.',
    );
    const forced = await as(keys.agent, ['link', '--project', 'PAY', '--force'], { cwd: fork });
    expect(forced.stdout).toBe(
      'Linked PAY to github.com/someone/payments-fork (was gitlab.example.com/team/payments).\n',
    );

    // --clear finds the project through the remote it is linked to.
    const cleared = await as(keys.agent, ['link', '--clear', '--json'], { cwd: fork });
    expect(parsed(cleared, 'link').data).toMatchObject({
      project: 'PAY',
      action: 'cleared',
      repository: null,
    });
    const again = await as(keys.agent, ['link', '--clear', '--project', 'PAY']);
    expect(again.stdout).toBe('PAY has no repository linked.\n');

    await as(keys.agent, ['link', '--project', 'PAY'], { cwd: repo });
  });

  it('takes --project, then ZAMU_PROJECT, then .zamu.json, then the remote', async () => {
    const repo = await clone('payments-3', SSH);
    const sub = join(repo, 'src');
    const remote = parsed(await as(keys.agent, ['whoami', '--json'], { cwd: sub }), 'whoami');
    expect(remote.data.project?.source).toBe('remote');

    await writeFile(join(sub, '.zamu.json'), '{ "project": "web" }\n');
    const file = parsed(await as(keys.agent, ['whoami', '--json'], { cwd: join(sub, 'deep') }), 'whoami');
    expect(file.data.project).toEqual({ key: 'WEB', source: 'file', from: join(sub, '.zamu.json') });
    const milestones = parsed(
      await as(keys.agent, ['milestones', 'list', '--json'], { cwd: sub }),
      'milestones.list',
    );
    expect(milestones.data.items.every((m) => m.project.key === 'WEB')).toBe(true);
    // Through a symlinked path the file is found at its real location.
    await symlink(repo, join(home, 'payments-link'));
    const viaLink = parsed(
      await as(keys.agent, ['whoami', '--json'], { cwd: join(home, 'payments-link', 'src', 'deep') }),
      'whoami',
    );
    expect(viaLink.data.project).toMatchObject({ key: 'WEB', source: 'file' });

    const env = parsed(
      await as(keys.agent, ['whoami', '--json'], { cwd: sub, env: { ZAMU_PROJECT: 'pay' } }),
      'whoami',
    );
    expect(env.data.project).toEqual({ key: 'PAY', source: 'env', from: null });
    const flag = parsed(
      await as(keys.agent, ['cycles', 'list', '--project', 'WEB', '--json'], {
        cwd: sub,
        env: { ZAMU_PROJECT: 'PAY' },
      }),
      'cycles.list',
    );
    expect(flag.data.items.length).toBeGreaterThan(0);
    expect(flag.data.items.every((c) => c.project.key === 'WEB')).toBe(true);

    await writeFile(join(sub, '.zamu.json'), '{ "project": "WEB", "url": "https://zamu.example.com" }');
    const extra = await as(keys.agent, ['whoami', '--json'], { cwd: sub });
    expect(expectFailure(extra, 1, 'BAD_REQUEST').detail).toBe(
      `${join(sub, '.zamu.json')} is not a valid zamu project file.`,
    );
    await writeFile(join(sub, '.zamu.json'), '{ project: WEB }');
    expect(
      expectFailure(await as(keys.agent, ['whoami', '--json'], { cwd: sub }), 1, 'BAD_REQUEST').detail,
    ).toBe(`${join(sub, '.zamu.json')} is not valid JSON.`);
    const badEnv = await as(keys.agent, ['whoami', '--json'], {
      cwd: repo,
      env: { ZAMU_PROJECT: 'not a key' },
    });
    expect(expectFailure(badEnv, 1, 'BAD_REQUEST').detail).toBe(
      'ZAMU_PROJECT is not a project key: not a key',
    );

    // Outside any repository nothing names a project.
    const outside = await as(keys.agent, ['cycles', 'list']);
    expect(outside.code).toBe(1);
    expect(outside.stderr).toContain('zamu: No project given. Pass --project KEY.');
    expect(parsed(await as(keys.agent, ['whoami', '--json']), 'whoami').data.project).toBeNull();
    expect((await as(keys.agent, ['whoami'])).stdout).toMatch(/Project\s+none here/);
  });

  it('zamu link --file writes .zamu.json at the repository root, or here with --here', async () => {
    const repo = await clone('monorepo');
    const sub = join(repo, 'src');
    const created = await as(keys.agent, ['link', '--file', '--project', 'web', '--json'], { cwd: sub });
    expect(parsed(created, 'link').data).toEqual({
      project: 'WEB',
      target: 'file',
      action: 'created',
      repository: null,
      file: join(repo, '.zamu.json'),
    });
    expect(JSON.parse(await readFile(join(repo, '.zamu.json'), 'utf8'))).toEqual({ project: 'WEB' });
    const same = await as(keys.agent, ['link', '--file'], { cwd: sub });
    expect(same.stdout).toBe('../.zamu.json already names WEB.\n');

    const here = await as(keys.agent, ['link', '--file', '--here', '--project', 'PAY'], { cwd: sub });
    expect(here.stdout).toBe(
      'Wrote .zamu.json: zamu uses PAY in this folder and below. Commit it so every clone gets it.\n',
    );
    expect(
      parsed(await as(keys.agent, ['whoami', '--json'], { cwd: join(sub, 'deep') }), 'whoami').data.project
        ?.key,
    ).toBe('PAY');

    expect(
      expectFailure(
        await as(keys.agent, ['link', '--file', '--project', 'ZZZ', '--json'], { cwd: repo }),
        3,
        'NOT_FOUND',
      ).detail,
    ).toBe('No project ZZZ that this key can read.');
    expect((await as(keys.agent, ['link', '--file', '--clear'])).code).toBe(1);
    expect((await as(keys.agent, ['link', '--here'])).code).toBe(1);
    expect((await as(keys.agent, ['link', '--clear', '--force'])).code).toBe(1);

    const noRemote = await as(keys.agent, ['link', '--project', 'PAY', '--json'], { cwd: repo });
    expect(expectFailure(noRemote, 1, 'BAD_REQUEST').detail).toBe('This clone has no git remote to link.');
    const notRepo = await as(keys.agent, ['link', '--project', 'PAY', '--json']);
    expect(expectFailure(notRepo, 1, 'BAD_REQUEST').detail).toBe(
      'This folder is not inside a git repository.',
    );
    const local = await clone('local-remote', '/srv/git/payments.git');
    const unlinkable = await as(keys.agent, ['link', '--project', 'PAY', '--json'], { cwd: local });
    expect(expectFailure(unlinkable, 1, 'BAD_REQUEST').detail).toBe(
      'The remote origin (/srv/git/payments.git) is not a URL zamu can link.',
    );
  });

  it('zamu agents writes a marked block into AGENTS.md and replaces only that block', async () => {
    const repo = await clone('agents', SSH);
    const created = await as(keys.agent, ['agents', '--json'], { cwd: join(repo, 'src') });
    const out = parsed(created, 'agents').data;
    expect(out).toMatchObject({ file: join(repo, 'AGENTS.md'), action: 'created', project: 'PAY' });
    const first = await readFile(join(repo, 'AGENTS.md'), 'utf8');
    expect(first).toBe(`${out.block}\n`);
    expect(first).toMatch(
      /^<!-- zamu:start \(written by zamu agents; run it again to update\) -->\n## Tasks: the zamu CLI\n/,
    );
    expect(first).toContain('Tasks for this repository are in Zamu, project PAY.');
    expect(first).toContain('Read `zamu instructions` before you start');
    expect(out.replacedBacklogBlock).toBe(false);
    expect(first.trimEnd().endsWith('<!-- zamu:end -->')).toBe(true);

    const unchanged = await as(keys.agent, ['agents'], { cwd: repo });
    expect(unchanged.stdout).toBe('AGENTS.md already has the current zamu instructions.\n');

    // Hand-written text around the block survives; the block is rewritten in place.
    await writeFile(
      join(repo, 'AGENTS.md'),
      `# Repo rules\n\nUse pnpm.\n\n${first}\n## More\n\nKeep this.\n`,
    );
    const updated = await as(keys.agent, ['agents', '--project', 'web'], { cwd: repo });
    expect(updated.stdout).toBe('Wrote zamu instructions for WEB into AGENTS.md.\n');
    const second = await readFile(join(repo, 'AGENTS.md'), 'utf8');
    expect(second.startsWith('# Repo rules\n\nUse pnpm.\n\n<!-- zamu:start')).toBe(true);
    expect(second.endsWith('<!-- zamu:end -->\n\n## More\n\nKeep this.\n')).toBe(true);
    expect(second.match(/<!-- zamu:start/g)).toHaveLength(1);
    expect(second).toContain('project WEB');

    // Only CLAUDE.md: the block goes there. --file picks any file.
    const claude = await clone('claude-only');
    await writeFile(join(claude, 'CLAUDE.md'), '# Notes\n');
    const intoClaude = parsed(await as(keys.agent, ['agents', '--json'], { cwd: claude }), 'agents').data;
    expect(intoClaude).toMatchObject({ file: join(claude, 'CLAUDE.md'), action: 'updated', project: null });
    expect(await readFile(join(claude, 'CLAUDE.md'), 'utf8')).toMatch(/^# Notes\n\n<!-- zamu:start/);
    const custom = parsed(
      await as(keys.agent, ['agents', '--file', 'docs/AI.md', '--json'], { cwd: repo }),
      'agents',
    );
    expect(custom.data).toMatchObject({ file: join(repo, 'docs', 'AI.md'), action: 'created' });
  });

  it('zamu agents --print works without credentials and without a project', async () => {
    const repo = await clone('offline', SSH);
    const printed = await zamu(['agents', '--print'], { cwd: repo });
    expect(printed.code, printed.stderr).toBe(0);
    expect(printed.stdout).toContain('Pass --project KEY to commands that work on one project');
    expect(printed.stdout).toContain('`zamu instructions`');
    // Without a server, zamu can't tell how the project relates to Backlog.md: no line about it.
    expect(printed.stdout).not.toContain('Backlog.md');
    expect(printed.stderr).toBe('');
    const json = parsed(await zamu(['agents', '--print', '--json'], { cwd: repo }), 'agents');
    expect(json.data).toMatchObject({ file: null, action: 'printed', project: null });
    await expect(stat(join(repo, 'AGENTS.md'))).rejects.toThrow();

    // With a key the server refuses, the lookup is skipped with a note and the block still prints.
    const refused = await as(keys.revoked, ['agents', '--print'], { cwd: repo });
    expect(refused.code).toBe(0);
    expect(refused.stderr).toContain('zamu: could not look up the project of this clone');
  });
});

// Runs last: it ends PAY's current cycle, which the tests above read.
describe('zamu cycles end (default target)', () => {
  it('ends the current cycle and moves unfinished tasks to the next one', async () => {
    const human = await as(keys.agent, ['cycles', 'end', '--project', 'PAY']);
    expect(human.code, human.stderr).toBe(0);
    expect(human.stdout).toMatch(/^Ended Cycle 1 · Checkout rewrite in PAY\n/);
    expect(human.stdout).toMatch(/Ended\s+\d{4}-\d{2}-\d{2} \d{2}:\d{2} by claude-dev/);
    expect(human.stdout).toMatch(/Summary\s+\d+\/\d+ completed · \d+ rolled over/);
    expect(human.stdout).toContain('\nRolled over\n');
    expect(human.stdout).toMatch(/\nKEY\s+STATUS\s+MOVED TO\s+TITLE\n/);
    expect(human.stdout).toMatch(/PAY-1\s+\S.*\s+Cycle 2\s+/);

    const show = await as(keys.agent, ['tasks', 'show', 'PAY-1']);
    expect(show.stdout).toContain('claude-dev for Ana Ruiz ended Cycle 1. Moved to Cycle 2.');

    // Ending it again changes nothing.
    const again = await as(keys.agent, ['cycles', 'end', '1', '--project', 'PAY', '--json']);
    expect(again.code, again.stdout).toBe(0);
    expect(parsed(again, 'cycles.end').data.state).toBe('completed');
  });
});
