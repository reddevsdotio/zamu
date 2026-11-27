// The offline queue's pieces that need no server: the request time limit and the user agent in
// client.ts, what can be queued and how it reads in zamu queue, the lock file, and many writers
// appending at once, in one process and in two.
import { execFile } from 'node:child_process';
import { mkdir, mkdtemp, readdir, readFile, rm, utimes, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { promisify } from 'node:util';
import { CLI_EXIT_QUEUED, CliQueueFile, parseCliOutput } from '@zamu/contracts';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import {
  createApiClient,
  isNetworkFailure,
  LONG_REQUEST_TIMEOUT_MS,
  NoAnswerError,
  networkFailure,
  REQUEST_TIMEOUT_MS,
  requestTimeout,
  USER_AGENT,
  withTimeout,
} from '../src/client';
import { slowExport } from '../src/commands/backlog-export';
import { CliError } from '../src/errors';
import type { CliIo, FetchLike } from '../src/io';
import { main } from '../src/main';
import { QueueLockedError, queueability, queuePath, stateDir, summarize, withLock } from '../src/queue';

const URL = 'http://zamu.test';
const run = promisify(execFile);

let home: string;

beforeEach(async () => {
  home = await mkdtemp(join(tmpdir(), 'zamu-queue-'));
});
afterEach(async () => {
  await rm(home, { recursive: true, force: true });
});

const refused: FetchLike = () =>
  Promise.reject(new TypeError('fetch failed', { cause: new Error('connect ECONNREFUSED') }));

async function zamu(args: string[], fetch: FetchLike = refused) {
  const out: string[] = [];
  const err: string[] = [];
  const io: CliIo = {
    stdout: (text) => out.push(text),
    stderr: (text) => err.push(text),
    readStdin: async () => '',
    env: {
      ZAMU_URL: URL,
      ZAMU_KEY: 'zamu_live_test',
      ZAMU_MACHINE: 'test',
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

async function queueFile() {
  const io = { env: { XDG_STATE_HOME: join(home, 'state') }, homeDir: home };
  return CliQueueFile.parse(JSON.parse(await readFile(queuePath(io), 'utf8')));
}

describe('client.ts', () => {
  it('names the CLI version in the user agent (0.0.0-dev from source)', () => {
    expect(USER_AGENT).toBe('zamu/0.0.0-dev');
  });

  it('gives each request 5 seconds', () => {
    expect(REQUEST_TIMEOUT_MS).toBe(5_000);
  });

  it('gives the Backlog.md export 2 minutes and every other request, queueable writes included, 5 seconds (PM-32)', () => {
    expect(LONG_REQUEST_TIMEOUT_MS).toBe(120_000);
    expect(requestTimeout(new Request(`${URL}/api/v1/projects/PAY/backlog/export`))).toBe(120_000);
    expect(requestTimeout(new Request(`${URL}/api/v1/projects/PAY/backlog/export?dryRun=true`))).toBe(
      120_000,
    );
    expect(requestTimeout(new Request(`${URL}/api/v1/tasks`))).toBe(5_000);
    expect(requestTimeout(new Request(`${URL}/api/v1/projects/PAY/backlog`))).toBe(5_000);
    expect(requestTimeout(new Request(`${URL}/api/v1/tasks/PAY-1`, { method: 'PATCH', body: '{}' }))).toBe(
      5_000,
    );
    expect(
      requestTimeout(new Request(`${URL}/api/v1/tasks/PAY-1/comments`, { method: 'POST', body: '{}' })),
    ).toBe(5_000);
  });

  it('says whether the server had started to answer when the limit ran out', async () => {
    const timed = withTimeout(async () => {
      const body = new ReadableStream({ start: () => {} });
      return new Response(body, { status: 200 });
    }, 50);
    const error = await timed(new Request(URL)).catch((caught: unknown) => caught);
    const cause = (error as Error).cause as NoAnswerError;
    expect(cause).toBeInstanceOf(NoAnswerError);
    expect(cause.started).toBe(true);
    expect(cause.message).toBe('answer not finished within 50 ms');
  });

  it('reports a slow export as a server still working, not an unreachable one (PM-32)', () => {
    const silent = networkFailure(new NoAnswerError(120_000));
    const thrown = (() => {
      try {
        slowExport(silent);
      } catch (caught) {
        return caught;
      }
    })() as CliError;
    expect(thrown).toBeInstanceOf(CliError);
    expect(thrown.exitCode).toBe(5);
    expect(thrown.message).toContain('did not send the export within 2 minutes');
    expect(thrown.message).toContain('may still be working');
    expect(thrown.message).not.toMatch(/didn't answer|Could not reach/);

    const partial = networkFailure(new NoAnswerError(120_000, true));
    expect(() => slowExport(partial)).toThrow(
      /started sending the export but did not finish within 2 minutes/,
    );

    // A refused connection is still a network failure for the usual message.
    const refusedError = new TypeError('fetch failed', { cause: new Error('connect ECONNREFUSED') });
    expect(() => slowExport(refusedError)).toThrow(refusedError);
  });

  it('fails a request without an answer in time as a network failure and aborts it', async () => {
    let signal: AbortSignal | undefined;
    const fetch: FetchLike = (request) => {
      signal = request.signal;
      return new Promise(() => {});
    };
    const client = createApiClient({ url: URL, key: 'zamu_live_test', fetch, timeoutMs: 50 });
    const error = await client.me.get().catch((caught: unknown) => caught);
    expect(isNetworkFailure(error)).toBe(true);
    expect((error as Error).cause).toBeInstanceOf(NoAnswerError);
    expect(((error as Error).cause as Error).message).toBe('no answer within 50 ms');
    expect(signal?.aborted).toBe(true);
  });

  it('counts reading the body in the limit', async () => {
    const timed = withTimeout(async () => {
      const body = new ReadableStream({ start: () => {} });
      return new Response(body, { status: 200 });
    }, 50);
    const error = await timed(new Request(URL)).catch((caught: unknown) => caught);
    expect(isNetworkFailure(error)).toBe(true);
  });

  it('passes answers through, bodies and empty ones alike, and keeps the headers fetch adds', async () => {
    const seen: string[] = [];
    const timed = withTimeout(async (request) => {
      seen.push(request.headers.get('x-test') ?? '');
      return request.method === 'DELETE'
        ? new Response(null, { status: 204 })
        : Response.json({ ok: true }, { status: 409 });
    }, 1_000);
    const request = new Request(URL, { method: 'PATCH', body: '{}', headers: { 'x-test': 'yes' } });
    const answer = await timed(request);
    expect(answer.status).toBe(409);
    expect(await answer.json()).toEqual({ ok: true });
    expect((await timed(new Request(URL, { method: 'DELETE' }))).status).toBe(204);
    expect(seen).toEqual(['yes', '']);
  });

  it('treats an answer of any status as an answer, not a network failure', () => {
    expect(isNetworkFailure(new TypeError('fetch failed'))).toBe(true);
    expect(isNetworkFailure(new Error('fetch failed'))).toBe(false);
    expect(isNetworkFailure(new TypeError('Cannot read properties of undefined'))).toBe(false);
  });
});

describe('what can be queued', () => {
  it('queues checks, unchecks, waives, unwaives and a status change on a task', () => {
    expect(
      queueability('tasks.update', {
        key: 'PAY-142',
        project: undefined,
        checkCriteria: [1, 2],
        uncheckDoneItems: [3],
        waiveCriteria: [{ number: 5, reason: 'Replaced' }],
        unwaiveDoneItems: [1],
        status: 'in_review',
      }),
    ).toEqual({
      queueable: true,
      status: 'in_review',
      summary:
        'check criteria 1, 2, waive criterion 5, uncheck done item 3, unwaive done item 1, move to In review',
    });
  });

  it('queues notes and comments', () => {
    expect(
      queueability('comments.create', { key: 'PAY-1', body: 'Migration written', kind: 'note' }),
    ).toEqual({
      queueable: true,
      status: null,
      summary: 'note "Migration written"',
    });
    expect(summarize('comments.create', { key: 'PAY-1', body: `${'long '.repeat(20)}end` })).toBe(
      `comment "${'long '.repeat(10).slice(0, 49)}…"`,
    );
  });

  it('names the flags that keep an update from being queued', () => {
    expect(
      queueability('tasks.update', {
        key: 'PAY-1',
        checkCriteria: [1],
        priority: 'high',
        addCriteria: ['New'],
        assignee: null,
        plan: 'x',
      }),
    ).toEqual({ queueable: false, flags: ['--priority', '--ac', '--assignee/--unassign', '--plan'] });
  });

  it('never queues other procedures', () => {
    expect(queueability('tasks.create', { project: 'PAY', title: 'x' })).toBeNull();
    expect(queueability('tasks.get', { key: 'PAY-1' })).toBeNull();
  });
});

describe('the queue file', () => {
  it('lives under XDG_STATE_HOME, else ~/.local/state', () => {
    expect(stateDir({ env: { XDG_STATE_HOME: '/state' }, homeDir: '/home/a' })).toBe('/state/zamu');
    expect(stateDir({ env: { XDG_STATE_HOME: 'relative' }, homeDir: '/home/a' })).toBe(
      '/home/a/.local/state/zamu',
    );
    expect(queuePath({ env: {}, homeDir: '/home/a' })).toBe('/home/a/.local/state/zamu/queue.json');
  });

  it('waits for a held lock and gives up after the wait', async () => {
    const path = join(home, 'state', 'zamu', 'queue.json');
    await mkdir(join(home, 'state', 'zamu'), { recursive: true });
    await writeFile(`${path}.lock`, 'someone else\n');
    const error = await withLock(path, async () => 'got it', { waitMs: 50 }).catch(
      (caught: unknown) => caught,
    );
    expect(error).toBeInstanceOf(QueueLockedError);
  });

  it('takes over a stale lock left by a process that died', async () => {
    const path = join(home, 'state', 'zamu', 'queue.json');
    await mkdir(join(home, 'state', 'zamu'), { recursive: true });
    await writeFile(`${path}.lock`, 'dead\n');
    const old = new Date(Date.now() - 60_000);
    await utimes(`${path}.lock`, old, old);
    expect(await withLock(path, async () => 'got it', { waitMs: 50 })).toBe('got it');
    // Released afterwards.
    expect(await readdir(join(home, 'state', 'zamu'))).toEqual([]);
  });

  it('keeps every entry when many commands queue at once in one process', async () => {
    const results = await Promise.all(
      Array.from({ length: 25 }, (_, i) => zamu(['notes', 'add', 'PAY-1', `note ${i}`, '--json'])),
    );
    for (const result of results) {
      expect(result.code, result.stderr).toBe(CLI_EXIT_QUEUED);
      expect(parseCliOutput(JSON.parse(result.stdout), 'queued').data.entry.procedure).toBe(
        'comments.create',
      );
    }
    const { entries } = await queueFile();
    expect(entries).toHaveLength(25);
    expect(new Set(entries.map((entry) => entry.id)).size).toBe(25);
    expect(new Set(entries.map((entry) => entry.input.body))).toEqual(
      new Set(Array.from({ length: 25 }, (_, i) => `note ${i}`)),
    );
    // No temporary files or lock left behind.
    expect(await readdir(join(home, 'state', 'zamu'))).toEqual(['queue.json']);
  });

  it('keeps every entry when two processes queue at once', async () => {
    const writer = resolve(import.meta.dirname, 'helpers', 'queue-writer.ts');
    const root = resolve(import.meta.dirname, '..', '..', '..');
    const env = { ...process.env, HOME: home, XDG_STATE_HOME: join(home, 'state') };
    await Promise.all(
      ['first', 'second'].map((label) =>
        run(process.execPath, ['--import', 'tsx', writer, '15', label], { cwd: root, env }),
      ),
    );
    const { entries } = await queueFile();
    expect(entries).toHaveLength(30);
    expect(new Set(entries.map((entry) => entry.id)).size).toBe(30);
    for (const label of ['first', 'second']) {
      // Each process's own entries keep their order.
      const bodies = entries
        .map((entry) => String(entry.input.body))
        .filter((body) => body.startsWith(label));
      expect(bodies).toEqual(Array.from({ length: 15 }, (_, i) => `${label} ${i}`));
    }
  }, 60_000);

  it('moves an unreadable queue file aside instead of failing every command', async () => {
    await mkdir(join(home, 'state', 'zamu'), { recursive: true });
    await writeFile(join(home, 'state', 'zamu', 'queue.json'), '{ not json');
    const result = await zamu(['notes', 'add', 'PAY-1', 'still queued']);
    expect(result.code).toBe(CLI_EXIT_QUEUED);
    expect(result.stderr).toContain('the offline queue was not readable; moved it to');
    expect((await queueFile()).entries).toHaveLength(1);
    const files = await readdir(join(home, 'state', 'zamu'));
    expect(files.some((file) => file.startsWith('queue.json.unreadable-'))).toBe(true);
  });

  it('leaves a queue file from a newer zamu alone', async () => {
    await mkdir(join(home, 'state', 'zamu'), { recursive: true });
    const newer = JSON.stringify({ version: 2, entries: [] });
    await writeFile(join(home, 'state', 'zamu', 'queue.json'), newer);
    const result = await zamu(['queue', '--json']);
    expect(result.code).toBe(1);
    expect(parseCliOutput(JSON.parse(result.stdout), 'error').data.detail).toContain('newer zamu');
    expect(await readFile(join(home, 'state', 'zamu', 'queue.json'), 'utf8')).toBe(newer);
  });
});
