// The offline queue end to end (M6, PM-26), in-process against the real /api/v1 handler on a
// throwaway database with the dev seed. "Offline" is a fetch that fails the way Node's fetch does
// when nothing listens; "back online" is the handler again. Covers what is and isn't queued, the
// 5-second limit, replay order, the skipped status change, a dropped 4xx, a partial replay, zamu
// queue, zamu queue drop and the count in zamu whoami.
import { mkdtemp, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import {
  CLI_EXIT_QUEUED,
  type CliData,
  CliQueueFile,
  type CliResultName,
  parseCliOutput,
  SOURCE_HEADERS,
} from '@zamu/contracts';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { createTestDatabase, type TestDatabase } from '../../../packages/db/test/index';
import { createApiFetchHandler } from '../../web/src/server/api/handler';
import { createServerContext, type ServerContext } from '../../web/src/server/context';
import { seedDevData } from '../../web/src/server/seed';
import type { CliIo, FetchLike } from '../src/io';
import { main } from '../src/main';
import { QUEUED_MESSAGE, queuePath } from '../src/queue';

const URL = 'http://zamu.test';
const SECRET = 'test-secret-test-secret-test-secret-0123';

let database: TestDatabase;
let server: ServerContext;
let handle: FetchLike;
let home: string;
const keys = {} as { agent: string; admin: string };

interface RunResult {
  code: number;
  stdout: string;
  stderr: string;
}

async function zamu(args: string[], fetch: FetchLike = handle, key = keys.agent): Promise<RunResult> {
  const out: string[] = [];
  const err: string[] = [];
  const io: CliIo = {
    stdout: (text) => out.push(text),
    stderr: (text) => err.push(text),
    readStdin: async () => '',
    env: {
      ZAMU_URL: URL,
      ZAMU_KEY: key,
      ZAMU_MACHINE: 'build-box',
      XDG_CONFIG_HOME: join(home, 'config'),
      XDG_STATE_HOME: join(home, 'state'),
    },
    homeDir: home,
    cwd: home,
    isTTY: false,
    fetch,
  };
  const code = await main(args, io);
  return { code, stdout: out.join(''), stderr: err.join('') };
}

/** Nothing listens: Node's fetch fails like this on a refused connection. */
const offline: FetchLike = () =>
  Promise.reject(new TypeError('fetch failed', { cause: new Error('connect ECONNREFUSED 127.0.0.1:3000') }));

function data<N extends CliResultName>(result: RunResult, name: N): CliData<N> {
  expect(result.stdout.trim().split('\n'), 'one JSON line').toHaveLength(1);
  return (parseCliOutput(JSON.parse(result.stdout), name) as { data: CliData<N> }).data;
}

function ok<N extends CliResultName>(result: RunResult, name: N): CliData<N> {
  expect(result.code, result.stdout + result.stderr).toBe(0);
  return data(result, name);
}

function queued(result: RunResult) {
  expect(result.code, result.stdout + result.stderr).toBe(CLI_EXIT_QUEUED);
  return data(result, 'queued').entry;
}

function notQueued(result: RunResult, hint?: string) {
  expect(result.code, result.stdout + result.stderr).toBe(5);
  const error = data(result, 'error');
  expect(error.detail).toContain(`Could not reach ${URL}`);
  if (hint) expect(result.stdout).toContain(hint);
  return error;
}

async function entries() {
  const path = queuePath({ env: { XDG_STATE_HOME: join(home, 'state') }, homeDir: home });
  const text = await readFile(path, 'utf8').catch(() => null);
  return text === null ? [] : CliQueueFile.parse(JSON.parse(text)).entries;
}

/** A new PAY task with criteria, created by the agent while the server is up. */
async function newTask(criteria: string[] = ['First', 'Second', 'Third']): Promise<string> {
  const flags = criteria.flatMap((text) => ['--ac', text]);
  return ok(
    await zamu(['tasks', 'create', '--project', 'PAY', 'Queue test', ...flags, '--json']),
    'tasks.create',
  ).key;
}

async function show(key: string) {
  return ok(await zamu(['tasks', 'show', key, '--json']), 'tasks.show');
}

/** A person moves the task, straight through the API (a zamu command would send the queue). */
async function moveAsAdmin(key: string, status: string) {
  const response = await handle(
    new Request(`${URL}/api/v1/tasks/${key}`, {
      method: 'PATCH',
      headers: { authorization: `Bearer ${keys.admin}`, 'content-type': 'application/json' },
      body: JSON.stringify({ status }),
    }),
  );
  expect(response.status).toBe(200);
}

/** Records each request (method, path, machine header) before handing it to `fetch`. */
function recording(fetch: FetchLike = handle) {
  const requests: { method: string; path: string; machine: string | null }[] = [];
  const recorded: FetchLike = (request) => {
    requests.push({
      method: request.method,
      path: decodeURIComponent(new globalThis.URL(request.url).pathname),
      machine: request.headers.get(SOURCE_HEADERS.machine),
    });
    return fetch(request);
  };
  return { requests, fetch: recorded };
}

beforeAll(async () => {
  database = await createTestDatabase({ prefix: 'pm_cli_queue' });
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
}, 60_000);

afterAll(async () => {
  await server?.pool.end();
  await database?.drop();
});

beforeEach(async () => {
  home = await mkdtemp(join(tmpdir(), 'zamu-offline-'));
  return () => rm(home, { recursive: true, force: true });
});

describe('what is queued', () => {
  it('queues checks, waivers, notes and comments on a task, and says so with exit code 7', async () => {
    const key = await newTask();
    const check = queued(
      await zamu(['tasks', 'update', key, '--check-ac', '1,2', '--check-dod', '1', '--json'], offline),
    );
    expect(check).toMatchObject({
      url: URL,
      project: 'PAY',
      taskKey: key,
      procedure: 'tasks.update',
      input: { key, checkCriteria: [1, 2], checkDoneItems: [1] },
      lastSeenStatus: null,
      summary: 'check criteria 1, 2, check done item 1',
    });
    queued(
      await zamu(['tasks', 'update', key, '--uncheck-ac', '2', '--unwaive-dod', '1', '--json'], offline),
    );
    const waive = queued(
      await zamu(
        ['tasks', 'update', key, '--waive-ac', '3', '--reason', 'Covered elsewhere', '--json'],
        offline,
      ),
    );
    expect(waive.input).toEqual({ key, waiveCriteria: [{ number: 3, reason: 'Covered elsewhere' }] });
    expect(queued(await zamu(['notes', 'add', key, 'Migration written', '--json'], offline)).summary).toBe(
      'note "Migration written"',
    );
    expect(
      queued(await zamu(['tasks', 'update', key, '--append-notes', 'Tests pass', '--json'], offline)).input,
    ).toEqual({ key, body: 'Tests pass', kind: 'note' });
    expect(queued(await zamu(['comments', 'add', key, 'Over to you', '--json'], offline)).input).toEqual({
      key,
      body: 'Over to you',
    });

    const human = await zamu(['tasks', 'update', key, '--check-ac', '3'], offline);
    expect(human.code).toBe(CLI_EXIT_QUEUED);
    expect(human.stdout).toMatch(
      new RegExp(`^${QUEUED_MESSAGE}\n  [0-9a-f]{8}  ${key}  check criterion 3\n$`),
    );
    expect((await entries()).map((entry) => entry.summary)).toEqual([
      'check criteria 1, 2, check done item 1',
      'uncheck criterion 2, unwaive done item 1',
      'waive criterion 3',
      'note "Migration written"',
      'note "Tests pass"',
      'comment "Over to you"',
      'check criterion 3',
    ]);
  });

  it('queues the note of tasks update --append-notes behind its update', async () => {
    const key = await newTask();
    const entry = queued(
      await zamu(
        ['tasks', 'update', key, '--check-ac', '1', '--append-notes', 'Checked the ledger', '--json'],
        offline,
      ),
    );
    expect(entry.procedure).toBe('tasks.update');
    expect((await entries()).map((e) => [e.procedure, e.summary])).toEqual([
      ['tasks.update', 'check criterion 1'],
      ['comments.create', 'note "Checked the ledger"'],
    ]);
  });

  it('does not queue creating a task, reads, or writes that depend on the task as it is', async () => {
    const key = await newTask();
    notQueued(await zamu(['tasks', 'create', '--project', 'PAY', 'Offline task', '--json'], offline));
    notQueued(await zamu(['tasks', 'show', key, '--json'], offline));
    notQueued(await zamu(['tasks', 'list', '--json'], offline));
    notQueued(await zamu(['whoami', '--json'], offline));
    notQueued(
      await zamu(['tasks', 'update', key, '--check-ac', '1', '--priority', 'high', '--json'], offline),
      "Nothing was queued: --priority can't wait for the server",
    );
    notQueued(
      await zamu(['tasks', 'update', key, '--ac', 'New one', '--remove-ac', '2', '--json'], offline),
      '--ac, --remove-ac',
    );
    notQueued(await zamu(['tasks', 'update', key, '--plan', 'Plan', '--json'], offline), '--plan');
    // The note of a refused update isn't queued either.
    notQueued(
      await zamu(['tasks', 'update', key, '--title', 'New', '--append-notes', 'x', '--json'], offline),
    );
    expect(await entries()).toEqual([]);
  });

  it('is an error, not a reason to queue, when the server answers 5xx', async () => {
    const key = await newTask();
    const result = await zamu(['tasks', 'update', key, '--check-ac', '1', '--json'], async () =>
      Response.json({ code: 'INTERNAL_SERVER_ERROR', title: 'Bad gateway', status: 502 }, { status: 502 }),
    );
    expect(result.code).toBe(5);
    expect(data(result, 'error').status).toBe(502);
    expect(await entries()).toEqual([]);
  });

  it('queues a write the server gives no answer to within 5 seconds', async () => {
    const key = await newTask();
    // Like Node's fetch: hangs until the request is aborted.
    const silent: FetchLike = (request) =>
      new Promise((_, reject) =>
        request.signal.addEventListener('abort', () => reject(new DOMException('aborted', 'AbortError'))),
      );
    const started = Date.now();
    const entry = queued(await zamu(['notes', 'add', key, 'Slow server', '--json'], silent));
    const took = Date.now() - started;
    expect(took).toBeGreaterThanOrEqual(4_900);
    expect(took).toBeLessThan(9_000);
    expect(entry.summary).toBe('note "Slow server"');

    const read = await zamu(['tasks', 'show', key, '--json'], silent);
    expect(data(read, 'error').detail).toBe(`Could not reach ${URL}: no answer within 5 seconds`);
  }, 30_000);
});

describe('status changes', () => {
  it('refuses to queue a move when zamu has not seen the task', async () => {
    // A seeded task this machine (a new state folder per test) never read.
    const key = 'PAY-3';
    notQueued(
      await zamu(['tasks', 'update', key, '--status', 'in_progress', '--json'], offline),
      `zamu hasn't seen ${key}'s status on this machine`,
    );
    expect(await entries()).toEqual([]);
  });

  it('carries the status last seen, and of an earlier queued move of the same task', async () => {
    const key = await newTask([]);
    await show(key);
    const first = queued(await zamu(['tasks', 'update', key, '--status', 'in_progress', '--json'], offline));
    expect(first).toMatchObject({ lastSeenStatus: 'todo', summary: 'move to In progress' });
    const second = queued(await zamu(['tasks', 'update', key, '--status', 'in_review', '--json'], offline));
    expect(second.lastSeenStatus).toBe('in_progress');

    const { requests, fetch } = recording();
    const result = await zamu(['tasks', 'show', key, '--json'], fetch);
    expect(ok(result, 'tasks.show').task.status).toBe('in_review');
    expect(result.stderr).toContain(`Sent: ${key} move to In progress`);
    expect(result.stderr).toContain(`Sent: ${key} move to In review`);
    expect(requests.slice(0, 2).map((r) => r.method)).toEqual(['PATCH', 'PATCH']);
    expect(await entries()).toEqual([]);
  });

  it('skips a move when the task moved meanwhile, and still sends the checks queued with it', async () => {
    const key = await newTask(['First', 'Second']);
    await show(key);
    queued(
      await zamu(['tasks', 'update', key, '--check-ac', '1', '--status', 'in_progress', '--json'], offline),
    );
    await moveAsAdmin(key, 'done');

    const result = await zamu(['tasks', 'show', key, '--json']);
    const shown = ok(result, 'tasks.show').task;
    expect(result.stderr).toContain(`Skipped: ${key} was already moved to Done`);
    expect(result.stderr).toContain(`Sent: ${key} check criterion 1`);
    expect(shown.status).toBe('done');
    expect(shown.criteria?.map((item) => item.state)).toEqual(['checked', 'open']);
    expect(await entries()).toEqual([]);
  });
});

describe('replay', () => {
  it('sends queued writes oldest first, before the command, with the source headers', async () => {
    const key = await newTask();
    queued(await zamu(['tasks', 'update', key, '--check-ac', '1', '--json'], offline));
    queued(await zamu(['notes', 'add', key, 'First note', '--json'], offline));
    queued(await zamu(['tasks', 'update', key, '--check-ac', '2', '--json'], offline));
    queued(await zamu(['comments', 'add', key, 'A comment', '--json'], offline));

    const { requests, fetch } = recording();
    const result = await zamu(['tasks', 'show', key, '--json'], fetch);
    const shown = ok(result, 'tasks.show');
    expect(requests.slice(0, 4).map((r) => `${r.method} ${r.path}`)).toEqual([
      `PATCH /api/v1/tasks/${key}`,
      `POST /api/v1/tasks/${key}/comments`,
      `PATCH /api/v1/tasks/${key}`,
      `POST /api/v1/tasks/${key}/comments`,
    ]);
    expect(requests[4]?.method).toBe('GET');
    expect(new Set(requests.map((r) => r.machine))).toEqual(new Set(['build-box']));
    expect(result.stderr.split('\n').filter((line) => line.startsWith('Sent: '))).toEqual([
      expect.stringContaining(`Sent: ${key} check criterion 1 (queued `),
      expect.stringContaining(`Sent: ${key} note "First note"`),
      expect.stringContaining(`Sent: ${key} check criterion 2`),
      expect.stringContaining(`Sent: ${key} comment "A comment"`),
    ]);
    expect(shown.task.criteria?.map((item) => item.state)).toEqual(['checked', 'checked', 'open']);
    const kinds = (shown.timeline ?? []).filter((item) => item.kind !== 'activity').map((item) => item.kind);
    expect(kinds).toEqual(['note', 'comment']);
    expect(await entries()).toEqual([]);
  });

  it('drops a write the server refuses with a 4xx, reports it, and sends the rest', async () => {
    const key = await newTask(['Only one']);
    queued(await zamu(['tasks', 'update', key, '--check-ac', '9', '--json'], offline));
    queued(await zamu(['tasks', 'update', key, '--check-ac', '1', '--json'], offline));

    const result = await zamu(['tasks', 'show', key, '--json']);
    const shown = ok(result, 'tasks.show');
    expect(result.stderr).toMatch(new RegExp(`Dropped: ${key} check criterion 9 \\(queued [^)]+\\): .+ \\(`));
    expect(result.stderr).toContain(`Sent: ${key} check criterion 1`);
    expect(shown.task.criteria?.[0]?.state).toBe('checked');
    expect(await entries()).toEqual([]);
  });

  it('stops at a network failure, keeps the rest, and queues the command behind them', async () => {
    const key = await newTask();
    queued(await zamu(['tasks', 'update', key, '--check-ac', '1', '--json'], offline));
    queued(await zamu(['tasks', 'update', key, '--check-ac', '2', '--json'], offline));
    queued(await zamu(['notes', 'add', key, 'Kept', '--json'], offline));

    // The server answers one request, then goes away again.
    let answered = 0;
    const flaky: FetchLike = (request) => (answered++ === 0 ? handle(request) : offline(request));
    const result = await zamu(['tasks', 'update', key, '--check-ac', '3', '--json'], flaky);
    expect(queued(result).summary).toBe('check criterion 3');
    expect(result.stderr).toContain(`Sent: ${key} check criterion 1`);
    expect(result.stderr).toContain("the server didn't answer; 2 queued writes wait");
    expect((await entries()).map((entry) => entry.summary)).toEqual([
      'check criterion 2',
      'note "Kept"',
      'check criterion 3',
    ]);
    // Only the first replayed request went out: the rest of the command didn't wait again.
    expect(answered).toBe(2);

    const back = await zamu(['tasks', 'show', key, '--json']);
    expect(ok(back, 'tasks.show').task.criteria?.map((item) => item.state)).toEqual([
      'checked',
      'checked',
      'checked',
    ]);
    expect(await entries()).toEqual([]);
  });

  it('keeps the queue when the server answers 5xx, and whoami counts what waits', async () => {
    const key = await newTask();
    queued(await zamu(['tasks', 'update', key, '--check-ac', '1', '--json'], offline));
    // Writes fail with 503 (a deploy in progress); reads work.
    const deploying: FetchLike = (request) =>
      request.method === 'GET'
        ? handle(request)
        : Promise.resolve(Response.json({ code: 'INTERNAL_SERVER_ERROR', status: 503 }, { status: 503 }));
    const result = await zamu(['whoami', '--json'], deploying);
    expect(ok(result, 'whoami').queued).toBe(1);
    expect(result.stderr).toContain('stopped sending queued writes');
    const human = await zamu(['whoami'], deploying);
    expect(human.stdout).toMatch(/Queued\s+1 write waits for the server \(zamu queue\)/);

    const empty = await zamu(['whoami', '--json']);
    expect(ok(empty, 'whoami').queued).toBe(0);
  });

  it('sends a queued write only with the key that queued it, so it keeps its author', async () => {
    const key = await newTask();
    queued(await zamu(['tasks', 'update', key, '--check-ac', '1', '--json'], offline));
    // A person's command on the same machine reaches the server first: the agent's write stays queued.
    const person = await zamu(['whoami', '--json'], handle, keys.admin);
    expect(person.code, person.stderr).toBe(0);
    expect(person.stderr).toContain('1 queued write was made with another key and waits for it');
    expect(await entries()).toHaveLength(1);
    // The agent's next command sends it, under the agent's name.
    const agent = await zamu(['tasks', 'show', key, '--json']);
    expect(agent.code, agent.stderr).toBe(0);
    expect(agent.stderr).toContain('Sent: ');
    expect(await entries()).toHaveLength(0);
  });

  it('leaves writes queued for another server alone', async () => {
    const key = await newTask();
    queued(await zamu(['tasks', 'update', key, '--check-ac', '1', '--json'], offline));
    const out: string[] = [];
    const io: CliIo = {
      stdout: (text) => out.push(text),
      stderr: () => {},
      readStdin: async () => '',
      env: {
        ZAMU_URL: 'http://other.test',
        ZAMU_KEY: keys.agent,
        XDG_STATE_HOME: join(home, 'state'),
      },
      homeDir: home,
      cwd: home,
      isTTY: false,
      fetch: handle,
    };
    expect(await main(['whoami', '--json'], io)).toBe(0);
    expect(data({ code: 0, stdout: out.join(''), stderr: '' }, 'whoami').queued).toBe(0);
    expect(await entries()).toHaveLength(1);
  });
});

describe('zamu queue', () => {
  it('lists the queued writes and drops one by id, without the server', async () => {
    const key = await newTask();
    const first = queued(await zamu(['tasks', 'update', key, '--check-ac', '1', '--json'], offline));
    const second = queued(await zamu(['notes', 'add', key, 'Second', '--json'], offline));

    // Every request would fail: zamu queue must not make any.
    const { requests, fetch } = recording(offline);
    const list = await zamu(['queue', '--json'], fetch);
    expect(ok(list, 'queue.list').items.map((entry) => entry.id)).toEqual([first.id, second.id]);
    const human = await zamu(['queue'], fetch);
    expect(human.stdout).toContain('2 writes wait for the server');
    expect(human.stdout).toMatch(new RegExp(`${first.id}\\s+\\S+ \\S+\\s+${key}\\s+check criterion 1`));

    expect(ok(await zamu(['queue', 'drop', first.id, '--json'], fetch), 'queue.drop').dropped.id).toBe(
      first.id,
    );
    const missing = await zamu(['queue', 'drop', 'nope', '--json'], fetch);
    expect(missing.code).toBe(3);
    expect(data(missing, 'error').code).toBe('NOT_FOUND');
    expect((await entries()).map((entry) => entry.id)).toEqual([second.id]);
    expect(requests).toEqual([]);

    expect((await zamu(['queue', 'drop', second.id])).stdout).toBe(
      `Dropped ${second.id}: ${key} note "Second". It won't be sent.\n`,
    );
    expect((await zamu(['queue'])).stdout).toBe('Nothing queued.\n');
  });

  it('is in --help with exit code 7', async () => {
    const help = await zamu(['--help']);
    expect(help.stdout).toContain('queue');
    expect(help.stdout).toContain('7 queued');
  });
});
