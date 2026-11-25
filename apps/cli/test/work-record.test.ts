// zamu and the M6 work record, in-process against the real /api/v1 handler on a throwaway database
// with the dev seed (PAY with 11 tasks, all native): the work-record flags of zamu tasks create and
// update, zamu notes add, zamu tasks show, the OPEN_ITEMS refusal, the machine and branch headers,
// zamu backlog export into a temporary git repository, zamu instructions and zamu agents.
import { execFileSync } from 'node:child_process';
import { mkdir, mkdtemp, readdir, readFile, rm, stat, writeFile } from 'node:fs/promises';
import { hostname, tmpdir } from 'node:os';
import { join } from 'node:path';
import { type CliData, type CliResultName, parseCliOutput, SOURCE_HEADERS } from '@zamu/contracts';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { type Actor, updateProject } from '../../../packages/core/src/index';
import { createTestDatabase, type TestDatabase } from '../../../packages/db/test/index';
import { createApiFetchHandler } from '../../web/src/server/api/handler';
import { createServerContext, type ServerContext } from '../../web/src/server/context';
import { seedDevData } from '../../web/src/server/seed';
import {
  AGENTS_BLOCK_END,
  AGENTS_BLOCK_START,
  BACKLOG_GUIDELINES_END,
  BACKLOG_GUIDELINES_START,
  BACKLOG_REPLACEMENT_LINE,
} from '../src/commands/agents';
import { INSTRUCTIONS } from '../src/instructions';
import type { CliIo, FetchLike } from '../src/io';
import { main } from '../src/main';

const URL = 'http://zamu.test';
const SECRET = 'test-secret-test-secret-test-secret-0123';
const MACHINE = 'build-box';

let database: TestDatabase;
let server: ServerContext;
let handle: FetchLike;
let home: string;
let admin: Actor;
const keys = {} as { agent: string; admin: string };

interface RunOptions {
  env?: Record<string, string | undefined>;
  stdin?: string;
  fetch?: FetchLike;
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
    env: { XDG_CONFIG_HOME: join(home, 'xdg'), ...options.env },
    homeDir: home,
    cwd: options.cwd ?? home,
    isTTY: false,
    fetch: options.fetch ?? handle,
  };
  const code = await main(args, io);
  return { code, stdout: out.join(''), stderr: err.join('') };
}

function as(key: string, args: string[], options: RunOptions = {}): Promise<RunResult> {
  return zamu(args, {
    ...options,
    env: { ZAMU_URL: URL, ZAMU_KEY: key, ZAMU_MACHINE: MACHINE, ...options.env },
  });
}

const agent = (args: string[], options?: RunOptions) => as(keys.agent, args, options);

function parsed<N extends CliResultName>(result: RunResult, name: N): CliData<N> {
  expect(result.code, result.stdout + result.stderr).toBe(0);
  expect(result.stdout.trim().split('\n'), 'one JSON line when piped').toHaveLength(1);
  return (parseCliOutput(JSON.parse(result.stdout), name) as { data: CliData<N> }).data;
}

function expectFailure(result: RunResult, exitCode: number, code: string) {
  expect(result.code, result.stdout + result.stderr).toBe(exitCode);
  const error = parseCliOutput(JSON.parse(result.stdout), 'error');
  expect(error.data.code).toBe(code);
  return error.data;
}

/** A fetch that records each request's method, path and headers before passing it on. */
function recording() {
  const requests: { method: string; path: string; headers: Headers }[] = [];
  const fetch: FetchLike = (request) => {
    requests.push({
      method: request.method,
      path: new globalThis.URL(request.url).pathname,
      headers: new Headers(request.headers),
    });
    return handle(request);
  };
  return { requests, fetch };
}

const gitEnv = { GIT_AUTHOR_NAME: 't', GIT_AUTHOR_EMAIL: 't@example.com' };
function gitIn(dir: string, args: string[]): string {
  return execFileSync('git', ['-C', dir, '-c', 'user.name=t', '-c', 'user.email=t@example.com', ...args], {
    env: { ...process.env, ...gitEnv },
  }).toString();
}

/** A git repository in the temporary home, on `branch`. */
async function repository(name: string, branch = 'main'): Promise<string> {
  const dir = join(home, name);
  await mkdir(dir, { recursive: true });
  execFileSync('git', ['init', '-q', '-b', branch, dir]);
  return dir;
}

/** A new PAY task created by the agent, with the given work-record flags. */
async function newTask(flags: string[] = [], stdin?: string) {
  return parsed(
    await agent(
      ['tasks', 'create', '--project', 'PAY', 'Retry failed payouts', ...flags, '--json'],
      stdin === undefined ? {} : { stdin },
    ),
    'tasks.create',
  );
}

beforeAll(async () => {
  database = await createTestDatabase({ prefix: 'pm_cli_work' });
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
  admin = {
    userId: seeded.admin.id,
    kind: 'person',
    workspaceId: seeded.workspaceId,
    role: 'owner',
    onBehalfOfId: null,
  };
}, 60_000);

afterAll(async () => {
  await server?.pool.end();
  await database?.drop();
});

beforeEach(async () => {
  home = await mkdtemp(join(tmpdir(), 'zamu-cli-work-'));
  return () => rm(home, { recursive: true, force: true });
});

describe('zamu tasks create with a work record', () => {
  it('sends criteria, done items and a plan from stdin in one request', async () => {
    await updateProject(server, admin, { project: 'PAY', defaultDoneItems: ['Tests and lint pass'] });
    const { requests, fetch } = recording();
    const result = await agent(
      [
        'tasks',
        'create',
        '--project',
        'PAY',
        'Retry failed payouts',
        '--ac',
        'A failed payout is retried, up to 8 times',
        '--ac',
        'On-call is alerted once, after the last attempt',
        '--dod',
        'Runbook updated',
        '--plan',
        '-',
        '--json',
      ],
      { stdin: '1. Add the retry table\n2. Schedule the job\n', fetch },
    );
    const task = parsed(result, 'tasks.create');
    expect(requests.filter((r) => r.method === 'POST')).toHaveLength(1);
    // Commas stay inside one criterion: --ac is not a comma-separated list.
    expect(task.criteria?.map((item) => [item.number, item.text, item.state])).toEqual([
      [1, 'A failed payout is retried, up to 8 times', 'open'],
      [2, 'On-call is alerted once, after the last attempt', 'open'],
    ]);
    expect(task.doneItems?.map((item) => item.text)).toEqual(['Tests and lint pass', 'Runbook updated']);
    expect(task.plan).toBe('1. Add the retry table\n2. Schedule the job\n');

    const skipped = await newTask(['--dod', 'Only this', '--no-dod-defaults']);
    expect(skipped.doneItems?.map((item) => item.text)).toEqual(['Only this']);

    const human = await agent(['tasks', 'create', '--project', 'PAY', 'Human', '--ac', 'Works']);
    expect(human.code, human.stderr).toBe(0);
    expect(human.stdout).toMatch(/Criteria\s+0 of 1 settled\n/);
    expect(human.stdout).toMatch(/Done items\s+0 of 1 settled\n/);
    expect(human.stdout).toContain('\nAcceptance criteria  0 of 1 settled\n  [ ] 1  Works\n');
    await updateProject(server, admin, { project: 'PAY', defaultDoneItems: [] });
  });

  it('rejects an empty or multi-line criterion before sending', async () => {
    const { requests, fetch } = recording();
    const empty = await agent(['tasks', 'create', '--project', 'PAY', 'X', '--ac', ' ', '--json'], { fetch });
    expectFailure(empty, 1, 'BAD_REQUEST');
    const lines = await agent(['tasks', 'create', '--project', 'PAY', 'X', '--ac', 'a\nb', '--json'], {
      fetch,
    });
    expectFailure(lines, 1, 'BAD_REQUEST');
    expect(requests).toHaveLength(0);
  });
});

describe('zamu tasks update with the work-record flags', () => {
  it('checks, unchecks, adds and removes criteria and done items, repeatable flags in one request', async () => {
    const task = await newTask(['--ac', 'One', '--ac', 'Two', '--ac', 'Three', '--dod', 'Tests pass']);
    const { requests, fetch } = recording();
    const checked = parsed(
      await agent(
        ['tasks', 'update', task.key, '--check-ac', '1', '--check-ac', '2,3', '--check-dod', '1', '--json'],
        { fetch },
      ),
      'tasks.update',
    );
    expect(requests.filter((r) => r.method === 'PATCH')).toHaveLength(1);
    expect(checked.criteria?.map((item) => item.state)).toEqual(['checked', 'checked', 'checked']);
    expect(checked.doneItems?.[0]?.state).toBe('checked');

    const changed = parsed(
      await agent([
        'tasks',
        'update',
        task.key,
        '--uncheck-ac',
        '3',
        '--remove-ac',
        '1',
        '--ac',
        'Four',
        '--uncheck-dod',
        '1',
        '--dod',
        'Docs updated',
        '--json',
      ]),
      'tasks.update',
    );
    expect(changed.criteria?.map((item) => [item.number, item.text, item.state])).toEqual([
      [1, 'Two', 'checked'],
      [2, 'Three', 'open'],
      [3, 'Four', 'open'],
    ]);
    expect(changed.doneItems?.map((item) => [item.text, item.state])).toEqual([
      ['Tests pass', 'open'],
      ['Docs updated', 'open'],
    ]);
    const removed = parsed(
      await agent(['tasks', 'update', task.key, '--remove-dod', '2', '--json']),
      'tasks.update',
    );
    expect(removed.doneItems?.map((item) => item.text)).toEqual(['Tests pass']);

    // Human output prints the lists after an item change.
    const human = await agent(['tasks', 'update', task.key, '--check-ac', '2']);
    expect(human.code, human.stderr).toBe(0);
    expect(human.stdout).toContain(
      'Acceptance criteria  2 of 3 settled\n  [x] 1  Two\n  [x] 2  Three\n  [ ] 3  Four\n',
    );
  });

  it('waives and unwaives with reasons paired in typed order', async () => {
    const task = await newTask(['--ac', 'One', '--ac', 'Two', '--ac', 'Three', '--dod', 'Load test']);
    const waived = parsed(
      await agent([
        'tasks',
        'update',
        task.key,
        '--waive-ac',
        '1',
        '--reason',
        'Covered by PAY-3',
        '--waive-ac',
        '2',
        '--waive-dod',
        '1',
        '--reason',
        'Replaced by a replay',
        '--json',
      ]),
      'tasks.update',
    );
    expect(waived.criteria?.map((item) => [item.state, item.waivedReason])).toEqual([
      ['waived', 'Covered by PAY-3'],
      ['waived', 'Replaced by a replay'],
      ['open', null],
    ]);
    expect(waived.doneItems?.[0]).toMatchObject({ state: 'waived', waivedReason: 'Replaced by a replay' });
    expect(waived.criteria?.[0]?.waivedBy?.name).toBe('claude-dev');

    // A reason typed first applies to the waives after it.
    const first = parsed(
      await agent(['tasks', 'update', task.key, '--reason', 'Out of scope', '--waive-ac', '3', '--json']),
      'tasks.update',
    );
    expect(first.criteria?.[2]).toMatchObject({ state: 'waived', waivedReason: 'Out of scope' });

    const unwaived = parsed(
      await agent(['tasks', 'update', task.key, '--unwaive-ac', '1,2', '--unwaive-dod', '1', '--json']),
      'tasks.update',
    );
    expect(unwaived.criteria?.map((item) => item.state)).toEqual(['open', 'open', 'waived']);
    expect(unwaived.doneItems?.[0]?.state).toBe('open');
  });

  it('refuses a waive without a reason, a reason without a waive, and bad numbers, sending nothing', async () => {
    const task = await newTask(['--ac', 'One']);
    const { requests, fetch } = recording();
    const noReason = expectFailure(
      await agent(['tasks', 'update', task.key, '--waive-ac', '1', '--json'], { fetch }),
      1,
      'BAD_REQUEST',
    );
    expect(noReason.detail).toBe('--waive-ac 1 needs a reason: add --reason "why it no longer applies".');
    const noWaive = expectFailure(
      await agent(['tasks', 'update', task.key, '--reason', 'why', '--json'], { fetch }),
      1,
      'BAD_REQUEST',
    );
    expect(noWaive.detail).toBe('--reason goes with --waive-ac N or --waive-dod N.');
    const bad = await agent(['tasks', 'update', task.key, '--check-ac', 'two', '--json'], { fetch });
    expect(bad.code).toBe(1);
    expect(parseCliOutput(JSON.parse(bad.stdout), 'error').data.detail).toContain('Use item numbers from 1');
    const zero = await agent(['tasks', 'update', task.key, '--check-ac', '0'], { fetch });
    expect(zero.code).toBe(1);
    expect(zero.stderr).toContain('Use item numbers from 1');
    expect(requests).toHaveLength(0);

    // A number the list doesn't have is the server's validation problem.
    expectFailure(
      await agent(['tasks', 'update', task.key, '--check-ac', '9', '--json']),
      1,
      'UNPROCESSABLE_CONTENT',
    );
  });

  it('writes the plan and the final summary from stdin or text, and clears them with ""', async () => {
    const task = await newTask();
    const planned = parsed(
      await agent(['tasks', 'update', task.key, '--status', 'in_progress', '--plan', '-', '--json'], {
        stdin: '## Steps\n\n1. Table\n',
      }),
      'tasks.update',
    );
    expect(planned).toMatchObject({ status: 'in_progress', plan: '## Steps\n\n1. Table\n' });
    expect(planned.planMeta?.author?.name).toBe('claude-dev');

    const summed = parsed(
      await agent(['tasks', 'update', task.key, '--final-summary', '-', '--plan', 'Plan v2', '--json'], {
        stdin: 'Retries work.\n',
      }),
      'tasks.update',
    );
    expect(summed).toMatchObject({ plan: 'Plan v2', finalSummary: 'Retries work.\n' });

    const cleared = parsed(
      await agent(['tasks', 'update', task.key, '--plan', '', '--final-summary', '', '--json']),
      'tasks.update',
    );
    expect(cleared.plan ?? null).toBeNull();
    expect(cleared.finalSummary ?? null).toBeNull();

    const { requests, fetch } = recording();
    const two = expectFailure(
      await agent(['tasks', 'update', task.key, '--plan', '-', '--final-summary', '-', '--json'], { fetch }),
      1,
      'BAD_REQUEST',
    );
    expect(two.detail).toBe(
      'Only one flag can read stdin ("-"); got --plan, --final-summary. Pass the others as text.',
    );
    expect(requests).toHaveLength(0);
  });

  it('--append-notes writes a note after the update, or alone; zamu notes add does the same', async () => {
    const task = await newTask(['--ac', 'One']);
    const { requests, fetch } = recording();
    const both = await agent(
      ['tasks', 'update', task.key, '--check-ac', '1', '--append-notes', 'Checked by the test', '--json'],
      { fetch },
    );
    expect(parsed(both, 'tasks.update').criteria?.[0]?.state).toBe('checked');
    expect(requests.map((r) => r.method)).toEqual(['PATCH', 'POST']);

    const alone = parsed(
      await agent(
        ['tasks', 'update', task.key, '--append-notes', '-', '--append-notes', 'Second part', '--json'],
        {
          stdin: 'First part',
        },
      ),
      'notes.add',
    );
    expect(alone).toMatchObject({ kind: 'note', body: 'First part\n\nSecond part', taskKey: task.key });
    expect(alone.source).toEqual({ machine: MACHINE, branch: null });

    const added = parsed(await agent(['notes', 'add', task.key, 'Migration written', '--json']), 'notes.add');
    expect(added).toMatchObject({ kind: 'note', body: 'Migration written' });
    const fromStdin = parsed(
      await agent(['notes', 'add', task.key.toLowerCase(), '-', '--json'], { stdin: 'From stdin\n' }),
      'notes.add',
    );
    expect(fromStdin.body).toBe('From stdin');

    const human = await agent(['notes', 'add', task.key, 'Human note']);
    expect(human.code, human.stderr).toBe(0);
    expect(human.stdout).toMatch(
      new RegExp(
        `^Added note [0-9a-f-]{36} on ${task.key}\\n\\n.*claude-dev for Ana Ruiz added a note {2}[0-9a-f-]{36} {2}${MACHINE}\\n {4}Human note\\n$`,
      ),
    );
    const humanUpdate = await agent([
      'tasks',
      'update',
      task.key,
      '--priority',
      'high',
      '--append-notes',
      'x',
    ]);
    expect(humanUpdate.stdout).toMatch(/\nAdded note [0-9a-f-]{36}\n$/);

    const show = parsed(await agent(['tasks', 'show', task.key, '--json']), 'tasks.show');
    expect(show.timelineCounts?.notes).toBe(6);
    expect(show.timeline?.filter((item) => item.kind === 'note')).toHaveLength(6);

    // A refused update writes no note.
    const refused = await agent([
      'tasks',
      'update',
      task.key,
      '--check-ac',
      '7',
      '--append-notes',
      'no',
      '--json',
    ]);
    expect(refused.code).toBe(1);
    const after = parsed(await agent(['tasks', 'show', task.key, '--json']), 'tasks.show');
    expect(after.timelineCounts?.notes).toBe(6);
  });
});

describe('zamu tasks show with a work record', () => {
  it('prints the summary, criteria with numbers and states, done items, the plan and notes', async () => {
    const task = await newTask(['--ac', 'Retries back off', '--ac', 'Load test', '--dod', 'Tests pass']);
    const repo = await repository('show', 'feat/payout-retries');
    await agent(['tasks', 'update', task.key, '--status', 'in_progress', '--plan', '1. Table\n2. Job'], {
      cwd: repo,
    });
    await agent(['tasks', 'update', task.key, '--check-ac', '1', '--append-notes', 'Backoff tested'], {
      cwd: repo,
    });
    await agent(['tasks', 'update', task.key, '--waive-ac', '2', '--reason', 'Replaced by a replay'], {
      cwd: repo,
    });
    await agent(['tasks', 'update', task.key, '--check-dod', '1', '--final-summary', 'Payouts retry.'], {
      cwd: repo,
    });

    const result = await agent(['tasks', 'show', task.key]);
    expect(result.code, result.stderr).toBe(0);
    const out = result.stdout;
    expect(out).toMatch(/Criteria\s+2 of 2 settled \(1 waived\)\n/);
    expect(out).toMatch(
      /\nFinal summary {2}by claude-dev for Ana Ruiz, \d{4}-\d\d-\d\d \d\d:\d\d\n {4}Payouts retry\.\n/,
    );
    expect(out).toContain(
      [
        'Acceptance criteria  2 of 2 settled (1 waived)',
        '  [x] 1  Retries back off',
        '  [~] 2  Load test',
        '         waived: Replaced by a replay (claude-dev)',
        '',
        'Definition of done  1 of 1 settled',
        '  [x] 1  Tests pass',
        '',
      ].join('\n'),
    );
    expect(out).toMatch(/\nPlan {2}by claude-dev for Ana Ruiz, [^\n]+\n {4}1\. Table\n {4}2\. Job\n/);
    // The summary comes before the lists, the plan after them, as on the task page.
    expect(out.indexOf('Final summary')).toBeLessThan(out.indexOf('Acceptance criteria'));
    expect(out.indexOf('Definition of done')).toBeLessThan(out.indexOf('\nPlan'));

    expect(out).toMatch(/\nHistory · 1 note · 0 comments · \d+ changes\n/);
    expect(out).toMatch(
      /claude-dev for Ana Ruiz added a note {2}[0-9a-f-]{36} {2}build-box · feat\/payout-retries\n {4}Backoff tested\n/,
    );
    expect(out).toContain(
      'claude-dev for Ana Ruiz moved it from Todo to In progress, wrote the plan  build-box · feat/payout-retries',
    );
    expect(out).toContain('checked criterion 1 "Retries back off"');
    expect(out).toContain('waived criterion 2 "Load test": Replaced by a replay');
    expect(out).toContain('wrote the final summary, checked done item 1 "Tests pass"');
    expect(out).not.toContain('changed the work record');
  });
});

describe('OPEN_ITEMS', () => {
  it('prints the open items with the flags that settle them and exits 1', async () => {
    const task = await newTask(['--ac', 'One', '--ac', 'Two', '--dod', 'Tests pass']);
    await agent(['tasks', 'update', task.key, '--check-ac', '1']);
    const json = expectFailure(
      await agent(['tasks', 'update', task.key, '--status', 'in_review', '--json']),
      1,
      'OPEN_ITEMS',
    );
    expect(json.openItems).toEqual([
      { kind: 'criterion', number: 2, text: 'Two' },
      { kind: 'done', number: 1, text: 'Tests pass' },
    ]);

    const human = await agent(['tasks', 'update', task.key.toLowerCase(), '--status', 'In review']);
    expect(human.code).toBe(1);
    expect(human.stdout).toBe('');
    expect(human.stderr).toBe(
      [
        `zamu: ${task.key} has open items: criterion 2 and done item 1. Check or waive them before moving it to In review (open_items).`,
        '  criterion 2  Two',
        '               check: --check-ac 2   waive: --waive-ac 2 --reason "..."',
        '  done item 1  Tests pass',
        '               check: --check-dod 1   waive: --waive-dod 1 --reason "..."',
        '  Check only what is proven and waive the rest with a reason. One command can settle them and move it:',
        `    zamu tasks update ${task.key} <flags above> --status in_review`,
        '',
      ].join('\n'),
    );

    // One request that settles the last items and moves the task goes through.
    const moved = parsed(
      await agent([
        'tasks',
        'update',
        task.key,
        '--check-ac',
        '2',
        '--waive-dod',
        '1',
        '--reason',
        'No tests for docs',
        '--status',
        'in_review',
        '--json',
      ]),
      'tasks.update',
    );
    expect(moved.status).toBe('in_review');
  });
});

describe('machine and branch headers', () => {
  it('sends ZAMU_MACHINE (else the host name) and the branch on every request, login included', async () => {
    const repo = await repository('headers', 'feat/payout-retries');
    const { requests, fetch } = recording();
    await agent(['tasks', 'list', '--project', 'PAY', '--json'], { fetch, cwd: repo });
    await agent(['tasks', 'show', 'PAY-1', '--json'], { fetch, cwd: repo });
    await zamu(['login', '--key', keys.agent, '--url', URL, '--json'], { fetch, cwd: repo });
    expect(requests.length).toBeGreaterThanOrEqual(4);
    for (const request of requests.slice(0, -1)) {
      expect(request.headers.get(SOURCE_HEADERS.machine)).toBe(MACHINE);
      expect(request.headers.get(SOURCE_HEADERS.branch)).toBe('feat/payout-retries');
    }
    // zamu login: no ZAMU_MACHINE in its environment, so the host name.
    expect(requests.at(-1)?.headers.get(SOURCE_HEADERS.machine)).toBe(hostname());

    // Outside a repository there is no branch header; an empty ZAMU_MACHINE means the host name.
    requests.length = 0;
    await agent(['projects', 'list', '--json'], { fetch, env: { ZAMU_MACHINE: '' } });
    expect(requests[0]?.headers.get(SOURCE_HEADERS.machine)).toBe(hostname());
    expect(requests[0]?.headers.has(SOURCE_HEADERS.branch)).toBe(false);

    // A detached HEAD has no branch.
    gitIn(repo, ['commit', '-q', '--allow-empty', '-m', 'one']);
    gitIn(repo, ['checkout', '-q', '--detach']);
    requests.length = 0;
    await agent(['projects', 'list', '--json'], { fetch, cwd: repo });
    expect(requests[0]?.headers.has(SOURCE_HEADERS.branch)).toBe(false);
  });

  it('stores the source on history entries and notes', async () => {
    const repo = await repository('source', 'fix/ledger');
    const task = await newTask(['--ac', 'One']);
    await agent(['tasks', 'update', task.key, '--check-ac', '1', '--append-notes', 'Done'], { cwd: repo });
    const show = parsed(await agent(['tasks', 'show', task.key, '--json']), 'tasks.show');
    const entry = show.timeline?.find(
      (item) => item.kind === 'activity' && item.changes.some((c) => c.field === 'criterion.checked'),
    );
    expect(entry && 'source' in entry ? entry.source : null).toEqual({
      machine: MACHINE,
      branch: 'fix/ledger',
    });
    const note = show.timeline?.find((item) => item.kind === 'note');
    expect(note && 'source' in note ? note.source : null).toEqual({ machine: MACHINE, branch: 'fix/ledger' });
  });
});

describe('zamu backlog export', () => {
  /** A repository with a committed Backlog.md folder: config, a document, a decision and a draft. */
  async function backlogRepo(prefix = 'pay'): Promise<string> {
    const repo = await repository('export');
    const dir = join(repo, 'backlog');
    for (const folder of ['docs', 'decisions', 'drafts', 'tasks'])
      await mkdir(join(dir, folder), { recursive: true });
    await writeFile(join(dir, 'config.yml'), `project_name: "Payments"\ntask_prefix: "${prefix}"\n`);
    await writeFile(join(dir, 'docs', 'doc-1 - Setup.md'), 'doc\n');
    await writeFile(join(dir, 'decisions', 'decision-1 - Postgres.md'), 'decision\n');
    await writeFile(join(dir, 'drafts', 'draft-1 - Idea.md'), 'draft\n');
    await writeFile(join(dir, 'tasks', 'pay-999 - Gone.md'), '---\nid: PAY-999\n---\n');
    await writeFile(join(dir, 'tasks', '.gitkeep'), '');
    gitIn(repo, ['add', '-A']);
    gitIn(repo, ['commit', '-q', '-m', 'backlog']);
    return repo;
  }

  async function files(dir: string): Promise<string[]> {
    const entries = await readdir(dir, { recursive: true, withFileTypes: true });
    return entries
      .filter((entry) => entry.isFile())
      .map((entry) => join(entry.parentPath, entry.name).slice(dir.length + 1))
      .sort();
  }

  it('--dry-run lists the changes and writes nothing', async () => {
    const repo = await backlogRepo();
    const before = await files(join(repo, 'backlog'));
    const result = parsed(
      await agent(['backlog', 'export', '--project', 'PAY', '--dry-run', '--json'], {
        cwd: join(repo, 'backlog'),
      }),
      'backlog.export',
    );
    expect(result).toMatchObject({ project: 'PAY', dir: join(repo, 'backlog'), dryRun: true });
    expect(result.format).toMatch(/^backlog\.md/);
    expect(result.files.filter((file) => file.action === 'created').length).toBeGreaterThan(10);
    expect(result.files.filter((file) => file.action === 'removed')).toEqual([
      { path: 'tasks/pay-999 - Gone.md', action: 'removed' },
    ]);
    expect(await files(join(repo, 'backlog'))).toEqual(before);

    const human = await agent(['backlog', 'export', '--project', 'PAY', '--dry-run'], { cwd: repo });
    expect(human.stdout).toMatch(
      /^Dry run: exporting PAY to backlog would change \d+ files \(\d+ created, 0 updated, 1 removed, 0 unchanged\)\.\n/,
    );
    expect(human.stdout).toContain('  Would remove  tasks/pay-999 - Gone.md\n');
    expect(human.stdout).toMatch(/ {2}Would create {2}tasks\/pay-1 - /);
  });

  it('writes the files, removes stale task files and leaves everything else alone', async () => {
    const repo = await backlogRepo();
    const result = await agent(['backlog', 'export', '--project', 'PAY'], {
      cwd: join(repo, 'backlog', 'docs'),
    });
    expect(result.code, result.stderr).toBe(0);
    expect(result.stderr).toBe('');
    expect(result.stdout).toMatch(
      /^Exported PAY to \.\.: \d+ created, 0 updated, 1 removed, 0 unchanged\.\n/,
    );

    const after = await files(join(repo, 'backlog'));
    expect(after).not.toContain('tasks/pay-999 - Gone.md');
    for (const kept of [
      'config.yml',
      'docs/doc-1 - Setup.md',
      'decisions/decision-1 - Postgres.md',
      'drafts/draft-1 - Idea.md',
      'tasks/.gitkeep',
    ]) {
      expect(after).toContain(kept);
    }
    expect(await readFile(join(repo, 'backlog', 'config.yml'), 'utf8')).toContain('task_prefix: "pay"');
    const task = after.find((path) => path.startsWith('tasks/pay-1 - '));
    expect(task).toBeDefined();
    expect(await readFile(join(repo, 'backlog', task as string), 'utf8')).toMatch(/^---\nid: PAY-1\n/);
    expect(after.some((path) => path.startsWith('milestones/'))).toBe(true);

    // Run again: nothing changes. The folders now hold uncommitted files, so it needs --force.
    const dirty = expectFailure(
      await agent(['backlog', 'export', '--project', 'PAY', '--json'], { cwd: repo }),
      1,
      'BAD_REQUEST',
    );
    expect(dirty.detail).toBe(
      'backlog has uncommitted changes in tasks/, completed/, milestones/. Commit or discard them first, or pass --force to overwrite them.',
    );
    gitIn(repo, ['add', '-A']);
    gitIn(repo, ['commit', '-q', '-m', 'export']);
    const again = parsed(
      await agent(['backlog', 'export', '--project', 'PAY', '--json'], { cwd: repo }),
      'backlog.export',
    );
    expect(again.files.every((file) => file.action === 'unchanged')).toBe(true);
    const human = await agent(['backlog', 'export', '--project', 'PAY'], { cwd: repo });
    expect(human.stdout).toMatch(
      /^backlog already matches PAY: 0 created, 0 updated, 0 removed, \d+ unchanged\.\n/,
    );
  });

  it('refuses uncommitted changes in the owned folders unless --force, and ignores changes elsewhere', async () => {
    const repo = await backlogRepo();
    // A change outside the owned folders doesn't count.
    await writeFile(join(repo, 'backlog', 'docs', 'doc-1 - Setup.md'), 'edited\n');
    const fine = await agent(['backlog', 'export', '--project', 'PAY', '--json'], { cwd: repo });
    expect(fine.code, fine.stdout + fine.stderr).toBe(0);
    gitIn(repo, ['add', '-A']);
    gitIn(repo, ['commit', '-q', '-m', 'export']);

    const exported = (await files(join(repo, 'backlog'))).find((path) => path.startsWith('tasks/pay-2 - '));
    await writeFile(join(repo, 'backlog', exported as string), 'hand edit\n');
    const { requests, fetch } = recording();
    const refused = await agent(['backlog', 'export', '--project', 'PAY'], { cwd: repo, fetch });
    expect(refused.code).toBe(1);
    expect(refused.stderr).toContain('backlog has uncommitted changes in tasks/, completed/, milestones/.');
    expect(refused.stderr).toContain(`\n   M "backlog/${exported}"\n`);
    expect(requests).toHaveLength(0);
    expect(await readFile(join(repo, 'backlog', exported as string), 'utf8')).toBe('hand edit\n');

    // --dry-run still lists, and says the export needs --force.
    const dry = parsed(
      await agent(['backlog', 'export', '--project', 'PAY', '--dry-run', '--json'], { cwd: repo }),
      'backlog.export',
    );
    expect(dry.files.find((file) => file.path === exported)?.action).toBe('updated');

    const forced = parsed(
      await agent(['backlog', 'export', '--project', 'PAY', '--force', '--json'], { cwd: repo }),
      'backlog.export',
    );
    expect(forced.files.filter((file) => file.action === 'updated')).toEqual([
      { path: exported, action: 'updated' },
    ]);
    expect(await readFile(join(repo, 'backlog', exported as string), 'utf8')).toMatch(/^---\nid: PAY-2\n/);
  });

  it('warns when config.yml is missing or its task_prefix differs from the ids', async () => {
    const other = await backlogRepo('task');
    const mismatch = await agent(['backlog', 'export', '--project', 'PAY', '--json'], { cwd: other });
    expect(mismatch.code).toBe(0);
    expect(mismatch.stderr).toBe(
      'zamu: backlog/config.yml has task_prefix TASK, but the exported ids start with PAY. The backlog CLI lists none of them until task_prefix matches with task_prefix: "pay".\n',
    );

    const bare = await repository('bare');
    const missing = await agent(['backlog', 'export', '--project', 'PAY', '--dir', 'out', '--json'], {
      cwd: bare,
    });
    expect(parsed(missing, 'backlog.export').dir).toBe(join(bare, 'out'));
    expect(missing.stderr).toBe(
      'zamu: out has no config.yml, so the backlog CLI lists none of these tasks. Create one with backlog init with task_prefix: "pay".\n',
    );
    await expect(stat(join(bare, 'out', 'config.yml'))).rejects.toThrow();

    // Outside a git repository: it writes, and says nothing can undo it.
    const loose = await agent(['backlog', 'export', '--project', 'PAY', '--json'], { cwd: home });
    expect(loose.code).toBe(0);
    expect(loose.stderr).toContain(
      'zamu: backlog is not in a git repository, so nothing here can undo the export.',
    );
  });
});

describe('zamu instructions', () => {
  it('prints the overview by default and each guide by name, without a server', async () => {
    const overview = await zamu(['instructions']);
    expect(overview.code, overview.stderr).toBe(0);
    expect(overview.stdout).toBe(INSTRUCTIONS.overview);
    for (const topic of ['overview', 'creating', 'working', 'finishing'] as const) {
      const json = parsed(await zamu(['instructions', topic, '--json']), 'instructions');
      expect(json).toEqual({ topic, text: INSTRUCTIONS[topic] });
    }
    expect((await zamu(['instructions', 'Finishing'])).stdout).toBe(INSTRUCTIONS.finishing);
    const unknown = await zamu(['instructions', 'reviewing']);
    expect(unknown.code).toBe(1);
    expect(unknown.stderr).toBe(
      'zamu: No guide named "reviewing".\n  Guides: overview, creating, working, finishing\n',
    );
  });

  it('covers what the guides promise, in plain sentences', () => {
    const all = Object.values(INSTRUCTIONS).join('\n');
    expect(INSTRUCTIONS.creating).toContain('Search first');
    expect(INSTRUCTIONS.creating).toContain('acceptance criteria that can be tested');
    expect(INSTRUCTIONS.working).toContain('write the plan');
    expect(INSTRUCTIONS.working).toContain('Add a note after each step');
    expect(INSTRUCTIONS.working).toContain('Check criteria when you have proven them');
    expect(INSTRUCTIONS.finishing).toContain('Write the final summary');
    expect(INSTRUCTIONS.finishing).toContain('Move the task to In review, not Done');
    expect(INSTRUCTIONS.finishing).toContain('list each queued write');
    expect(INSTRUCTIONS.finishing).toContain('Never edit them by hand');
    expect(all).not.toContain('!');
    for (const text of Object.values(INSTRUCTIONS)) {
      for (const line of text.split('\n')) expect(line.length, line).toBeLessThanOrEqual(110);
    }
  });
});

describe('zamu agents (M6)', () => {
  const backlogBlock = [
    BACKLOG_GUIDELINES_START,
    '# Backlog.md guidelines',
    'Use backlog task edit to change tasks.',
    BACKLOG_GUIDELINES_END,
  ].join('\n');

  it('no block: writes the short block that points to zamu instructions', async () => {
    const repo = await repository('agents-new');
    const out = parsed(await agent(['agents', '--project', 'PAY', '--json'], { cwd: repo }), 'agents');
    expect(out).toMatchObject({ action: 'created', project: 'PAY', replacedBacklogBlock: false });
    const text = await readFile(join(repo, 'AGENTS.md'), 'utf8');
    expect(text.startsWith(AGENTS_BLOCK_START)).toBe(true);
    expect(text).toContain('Read `zamu instructions` before you start');
    expect(text).not.toContain('Backlog.md');
    expect(text.split('\n').length).toBeLessThanOrEqual(10);
  });

  it('own block: replaces it in place and keeps the rest', async () => {
    const repo = await repository('agents-own');
    const old = `${AGENTS_BLOCK_START}\nold text\n${AGENTS_BLOCK_END}`;
    await writeFile(join(repo, 'AGENTS.md'), `# Rules\n\n${old}\n\n## More\n`);
    const out = parsed(await agent(['agents', '--project', 'PAY', '--json'], { cwd: repo }), 'agents');
    expect(out).toMatchObject({ action: 'updated', replacedBacklogBlock: false });
    const text = await readFile(join(repo, 'AGENTS.md'), 'utf8');
    expect(text).toBe(`# Rules\n\n${out.block}\n\n## More\n`);
  });

  it('Backlog.md block on a project owned by Zamu: one line takes its place, --file included', async () => {
    const repo = await repository('agents-backlog');
    await writeFile(join(repo, 'CLAUDE.md'), `# Rules\n\n${backlogBlock}\n\n## More\n`);
    const out = parsed(
      await agent(['agents', '--project', 'PAY', '--file', 'CLAUDE.md', '--json'], { cwd: repo }),
      'agents',
    );
    expect(out).toMatchObject({ action: 'updated', replacedBacklogBlock: true });
    const text = await readFile(join(repo, 'CLAUDE.md'), 'utf8');
    expect(text).toBe(`# Rules\n\n${BACKLOG_REPLACEMENT_LINE}\n\n${out.block}\n\n## More\n`);
    expect(text).not.toContain('BACKLOG.MD GUIDELINES');

    // Both blocks: the zamu block stays where it is and the guidelines become the line.
    await writeFile(join(repo, 'CLAUDE.md'), `${out.block}\n\n${backlogBlock}\n`);
    const both = parsed(
      await agent(['agents', '--project', 'PAY', '--file', 'CLAUDE.md', '--json'], { cwd: repo }),
      'agents',
    );
    expect(both.replacedBacklogBlock).toBe(true);
    expect(await readFile(join(repo, 'CLAUDE.md'), 'utf8')).toBe(
      `${out.block}\n\n${BACKLOG_REPLACEMENT_LINE}\n`,
    );

    await rm(join(repo, 'CLAUDE.md'));
    const human = await agent(['agents', '--project', 'PAY'], { cwd: repo });
    expect(human.stdout).toBe('Created AGENTS.md with zamu instructions for PAY.\n');
    await writeFile(join(repo, 'AGENTS.md'), backlogBlock);
    const replaced = await agent(['agents', '--project', 'PAY'], { cwd: repo });
    expect(replaced.stdout).toBe(
      'Wrote zamu instructions for PAY into AGENTS.md.\nReplaced the Backlog.md guidelines with a line that says tasks are in Zamu.\n',
    );

    // Without a server zamu can't tell who owns the tasks, so it leaves the guidelines alone.
    await writeFile(join(repo, 'AGENTS.md'), backlogBlock);
    const offline = parsed(await zamu(['agents', '--project', 'PAY', '--json'], { cwd: repo }), 'agents');
    expect(offline.replacedBacklogBlock).toBe(false);
    expect(await readFile(join(repo, 'AGENTS.md'), 'utf8')).toContain(BACKLOG_GUIDELINES_START);
  });
});
