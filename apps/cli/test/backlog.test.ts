// zamu with Backlog.md mirrors (M3), in-process against the real /api/v1 handler on a throwaway
// database: the dev seed with `backlog` (BACK "Payments API", mirrored through the real refresh
// engine, so Backlog.md ids equal its app keys) and a second mirrored project MIRR from core's
// fixtures, whose tasks keep Backlog.md ids BACK-786, BACK-786.1, BACK-786.1.2 and DRAFT-3 under the
// keys MIRR-786, MIRR-786.1, MIRR-786.1.2 and MIRR-787. DRAFT-3 is in both projects.
//
// Jobs go to a recording queue; the worker is simulated by writing the source row (refresh --wait).
import { execFileSync } from 'node:child_process';
import { mkdir, mkdtemp, readFile, rm, stat, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { type CliData, type CliResultName, parseCliOutput } from '@zamu/contracts';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { type Actor, createCycle, detachBacklog, type JobQueue } from '../../../packages/core/src/index';
import { createMirroredProject } from '../../../packages/core/src/testing/backlog';
import type { World } from '../../../packages/core/src/testing/fixtures';
import { createTestDatabase, type TestDatabase } from '../../../packages/db/test/index';
import { createApiFetchHandler } from '../../web/src/server/api/handler';
import { createServerContext, type ServerContext } from '../../web/src/server/context';
import { seedDevData } from '../../web/src/server/seed';
import type { CliIo, FetchLike } from '../src/io';
import { main } from '../src/main';

const URL = 'http://zamu.test';
const SECRET = 'test-secret-test-secret-test-secret-0123';
const ENCRYPTION_KEY = Buffer.alloc(32, 9).toString('base64');
const MIRR_REPOSITORY = 'https://gitlab.com/reddevs/mirr-payments';

let database: TestDatabase;
let server: ServerContext;
let handle: FetchLike;
let home: string;
let admin: Actor;
const sent: { name: string; data: unknown }[] = [];
const keys = {} as { agent: string; adminRead: string };

interface RunOptions {
  env?: Record<string, string | undefined>;
  fetch?: FetchLike;
  cwd?: string;
  tty?: boolean;
  sleep?: (ms: number) => Promise<void>;
  now?: () => number;
}

interface RunResult {
  code: number;
  stdout: string;
  stderr: string;
}

async function zamu(key: string, args: string[], options: RunOptions = {}): Promise<RunResult> {
  const out: string[] = [];
  const err: string[] = [];
  const io: CliIo = {
    stdout: (text) => out.push(text),
    stderr: (text) => err.push(text),
    readStdin: async () => '',
    env: { XDG_CONFIG_HOME: join(home, 'xdg'), ZAMU_URL: URL, ZAMU_KEY: key, ...options.env },
    homeDir: home,
    cwd: options.cwd ?? home,
    isTTY: options.tty ?? false,
    fetch: options.fetch ?? handle,
    ...(options.sleep ? { sleep: options.sleep } : {}),
    ...(options.now ? { now: options.now } : {}),
  };
  const code = await main(args, io);
  return { code, stdout: out.join(''), stderr: err.join('') };
}

const agent = (args: string[], options?: RunOptions) => zamu(keys.agent, args, options);

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

/** A git repository in the temporary home with an origin remote. */
async function clone(name: string, remote: string): Promise<string> {
  const dir = join(home, name);
  await mkdir(dir, { recursive: true });
  execFileSync('git', ['init', '-q', dir]);
  execFileSync('git', ['-C', dir, 'remote', 'add', 'origin', remote]);
  return dir;
}

/** Writes the Backlog.md source of a project, the way a worker run would. */
async function setSource(project: string, values: Record<string, unknown>) {
  const columns = Object.keys(values);
  const assignments = columns.map((column, i) => `${column} = $${i + 2}`).join(', ');
  await server.pool.query(
    `update backlog_source set ${assignments} where project_id = (select id from project where key = $1)`,
    [project, ...Object.values(values)],
  );
}

async function sourceRow(project: string) {
  const { rows } = await server.pool.query(
    `select state, last_error, last_attempt_at, last_read_at from backlog_source
     where project_id = (select id from project where key = $1)`,
    [project],
  );
  return rows[0] as { state: string; last_error: string | null; last_attempt_at: Date; last_read_at: Date };
}

beforeAll(async () => {
  database = await createTestDatabase({ prefix: 'pm_cli_backlog' });
  database.pool.on('error', () => {});
  const base = createServerContext({
    DATABASE_URL: database.url,
    BETTER_AUTH_SECRET: SECRET,
    BETTER_AUTH_URL: URL,
    PUBLIC_URL: URL,
    APP_ENCRYPTION_KEY: ENCRYPTION_KEY,
  });
  const jobs: JobQueue = {
    async enqueue(_tx, name, data) {
      sent.push({ name, data });
      return crypto.randomUUID();
    },
  };
  server = { ...base, jobs: { ...jobs, stop: async () => {} } };
  handle = createApiFetchHandler(server);
  const seeded = await seedDevData(server, { backlog: true });
  expect(seeded.createdProjects.map((p) => p.key)).toContain('BACK');
  keys.agent = seeded.agentKey;
  admin = {
    userId: seeded.admin.id,
    kind: 'person',
    workspaceId: seeded.workspaceId,
    role: 'owner',
    onBehalfOfId: null,
  };
  const { createApiKey } = await import('../../../packages/core/src/index');
  keys.adminRead = (
    await createApiKey(server, admin, { name: 'read only', scope: { projects: 'all', access: 'read' } })
  ).key;

  // Only the ids are read from the world's users.
  const world = {
    workspaceId: seeded.workspaceId,
    owner: { id: seeded.admin.id },
    member: { id: seeded.admin.id },
    agent: { id: seeded.agent.id },
  } as unknown as World;
  await createMirroredProject(server.db, world, { key: 'MIRR', repository: MIRR_REPOSITORY });
  const today = new Date().toISOString().slice(0, 10);
  const ends = new Date(Date.now() + 13 * 86_400_000).toISOString().slice(0, 10);
  await createCycle(server, admin, { project: 'MIRR', startsOn: today, endsOn: ends });
}, 60_000);

afterAll(async () => {
  await server?.pool.end();
  await database?.drop();
});

beforeEach(async () => {
  home = await mkdtemp(join(tmpdir(), 'zamu-cli-backlog-'));
  sent.length = 0;
  return () => rm(home, { recursive: true, force: true });
});

describe('zamu backlog status', () => {
  it('prints the source of a mirrored project', async () => {
    const status = parsed(
      await agent(['backlog', 'status', '--project', 'back', '--json']),
      'backlog.status',
    );
    expect(status).toMatchObject({
      project: { key: 'BACK', name: 'Payments API' },
      mode: 'mirror',
      state: 'warnings',
      defaultBranch: 'main',
      folder: 'backlog',
    });
    expect(status.problems.counts.files + status.problems.counts.values).toBeGreaterThan(0);

    const human = await agent(['backlog', 'status', '--project', 'BACK']);
    expect(human.code, human.stderr).toBe(0);
    expect(human.stdout).toContain('BACK  Payments API · Backlog.md mirror\n');
    expect(human.stdout).toMatch(/State\s+Mirroring, with problems\n/);
    expect(human.stdout).toMatch(/Branch\s+main · folder backlog\n/);
    expect(human.stdout).toMatch(/Connection\s+GitLab \(demo\) · gitlab\.example\.com · Working\n/);
    expect(human.stdout).toMatch(/Last read\s+\d{4}-\d\d-\d\d \d\d:\d\d · [0-9a-f]{7}/);
    expect(human.stdout).toContain('zamu backlog status --problems lists them');
    expect(human.stdout).not.toContain('\nProblems\n');
  });

  it('--problems lists every problem, reading every page', async () => {
    const all = parsed(
      await agent(['backlog', 'status', '--project', 'BACK', '--problems', '--json']),
      'backlog.status',
    );
    const total = all.problems.counts.files + all.problems.counts.values;
    expect(all.problems.items).toHaveLength(total);
    expect(all.problems.nextCursor).toBeNull();

    // One problem per page: zamu follows the cursors.
    let pages = 0;
    const onePerPage: FetchLike = (request) => {
      const url = new globalThis.URL(request.url);
      if (url.pathname.endsWith('/backlog')) {
        pages++;
        url.searchParams.set('problemsLimit', '1');
        return handle(new Request(url, request));
      }
      return handle(request);
    };
    const paged = parsed(
      await agent(['backlog', 'status', '--project', 'BACK', '--problems', '--json'], { fetch: onePerPage }),
      'backlog.status',
    );
    expect(pages).toBe(total);
    expect(paged.problems.items).toEqual(all.problems.items);

    const human = await agent(['backlog', 'status', '--project', 'BACK', '--problems']);
    expect(human.stdout).toContain('\nProblems\n');
    const file = all.problems.items.find((item) => item.kind === 'file');
    if (file?.kind === 'file') expect(human.stdout).toContain(`  file   ${file.path}`);
    const value = all.problems.items.find((item) => item.kind === 'value');
    if (value?.kind === 'value') {
      const tasks = value.count === 1 ? '1 task' : `${value.count} tasks`;
      expect(human.stdout).toContain(`  value  ${tasks}: ${value.message}\n`);
    }
  });

  it('finds the project from ZAMU_PROJECT and from the clone remote', async () => {
    const env = parsed(
      await agent(['backlog', 'status', '--json'], { env: { ZAMU_PROJECT: 'MIRR' } }),
      'backlog.status',
    );
    expect(env.project.key).toBe('MIRR');
    const repo = await clone('back', 'git@gitlab.example.com:reddevs/payments-api.git');
    const remote = parsed(await agent(['backlog', 'status', '--json'], { cwd: repo }), 'backlog.status');
    expect(remote.project.key).toBe('BACK');
  });

  it('fails with exit 3 for a project without Backlog.md and exit 1 without a project', async () => {
    expectFailure(await agent(['backlog', 'status', '--project', 'PAY', '--json']), 3, 'NOT_FOUND');
    const none = expectFailure(await agent(['backlog', 'status', '--json']), 1, 'BAD_REQUEST');
    expect(none.detail).toBe('No project given. Pass --project KEY.');
  });
});

describe('zamu backlog refresh', () => {
  afterAll(async () => {
    await setSource('BACK', { state: 'warnings', last_error: null });
  });

  it('queues a refresh with trigger cli', async () => {
    const result = parsed(
      await agent(['backlog', 'refresh', '--project', 'BACK', '--json']),
      'backlog.refresh',
    );
    expect(result).toMatchObject({ project: 'BACK', state: 'warnings', queued: true, outcome: 'queued' });
    expect(result.status).toBeNull();
    expect(sent).toEqual([{ name: 'backlog.refresh', data: expect.objectContaining({ trigger: 'cli' }) }]);

    const human = await agent(['backlog', 'refresh', '--project', 'BACK']);
    expect(human.code, human.stderr).toBe(0);
    expect(human.stdout).toBe(
      'Queued a refresh of BACK from Backlog.md.\nzamu backlog status shows the result; --wait waits for it.\n',
    );
  });

  it('--wait polls the status until the run ends', async () => {
    const before = await sourceRow('BACK');
    let polls = 0;
    // The "worker": reading on the first poll, done on the third.
    const sleep = async () => {
      polls++;
      const at = new Date(before.last_attempt_at.getTime() + polls * 1000);
      if (polls === 1) await setSource('BACK', { state: 'reading', last_attempt_at: at });
      if (polls === 3) await setSource('BACK', { state: 'healthy', last_attempt_at: at, last_read_at: at });
    };
    const result = parsed(
      await agent(['backlog', 'refresh', '--project', 'BACK', '--wait', '--json'], { sleep }),
      'backlog.refresh',
    );
    expect(polls).toBe(3);
    expect(result.outcome).toBe('finished');
    expect(result.status?.state).toBe('healthy');

    // Already ended once: the next run ends on the first poll after the worker writes.
    let humanPolls = 0;
    const human = await agent(['backlog', 'refresh', '--project', 'BACK', '--wait'], {
      sleep: async () => {
        humanPolls++;
        const at = new Date(before.last_attempt_at.getTime() + 10_000);
        await setSource('BACK', { state: 'failed', last_error: 'No Backlog.md folder', last_attempt_at: at });
      },
    });
    expect(human.code, human.stderr).toBe(0);
    expect(humanPolls).toBe(1);
    expect(human.stdout).toBe(
      'The refresh of BACK failed: No Backlog.md folder\nThe last good read is kept.\n',
    );

    // A finished read counts every task from the files: tasks/, drafts and archived ones.
    const healthy = await agent(['backlog', 'refresh', '--project', 'BACK', '--wait'], {
      sleep: async () => {
        const at = new Date(before.last_attempt_at.getTime() + 20_000);
        await setSource('BACK', {
          state: 'healthy',
          last_error: null,
          last_attempt_at: at,
          last_read_at: at,
        });
      },
    });
    const { counts } = parsed(
      await agent(['backlog', 'status', '--project', 'BACK', '--json']),
      'backlog.status',
    );
    expect(counts.drafts + counts.archived).toBeGreaterThan(0);
    expect(healthy.code, healthy.stderr).toBe(0);
    expect(healthy.stdout).toContain(
      `, ${counts.tasks + counts.drafts + counts.archived} tasks, ${counts.milestones} milestones, no problems.\n`,
    );
  });

  it('--wait gives up after 5 minutes', async () => {
    await setSource('BACK', { state: 'warnings', last_error: null });
    let clock = 0;
    let polls = 0;
    const options: RunOptions = {
      now: () => clock,
      sleep: async (ms) => {
        polls++;
        expect(ms).toBe(2000);
        clock += 60_000;
      },
    };
    const result = parsed(
      await agent(['backlog', 'refresh', '--project', 'BACK', '--wait', '--json'], options),
      'backlog.refresh',
    );
    expect(result.outcome).toBe('timeout');
    expect(result.status?.state).toBe('warnings');
    expect(polls).toBe(5);
    clock = 0;
    const human = await agent(['backlog', 'refresh', '--project', 'BACK', '--wait'], options);
    expect(human.stdout).toContain('No refresh of BACK finished within 5 minutes.');
  });

  it('exits 6 when the mirror is paused, and 4 for a read-only key', async () => {
    await setSource('BACK', { state: 'paused', last_error: 'The token was rejected' });
    const paused = expectFailure(
      await agent(['backlog', 'refresh', '--project', 'BACK', '--json']),
      6,
      'BACKLOG_PAUSED',
    );
    expect(paused.status).toBe(409);
    const human = await agent(['backlog', 'refresh', '--project', 'BACK']);
    expect(human.code).toBe(6);
    expect(human.stderr).toContain('zamu: The Backlog.md mirror of BACK is paused: The token was rejected\n');
    await setSource('BACK', { state: 'warnings', last_error: null });

    expectFailure(
      await zamu(keys.adminRead, ['backlog', 'refresh', '--project', 'BACK', '--json']),
      4,
      'FORBIDDEN',
    );
  });
});

describe('task keys: suffixes and Backlog.md ids', () => {
  it('shows a subtask by its suffixed key, with its Backlog.md origin', async () => {
    const show = parsed(await agent(['tasks', 'show', 'back-786.1', '--json']), 'tasks.show');
    expect(show.task.key).toBe('BACK-786.1');
    expect(show.task.backlog?.id).toBe('BACK-786.1');
    const human = await agent(['tasks', 'show', 'BACK-786.1.2']);
    expect(human.code, human.stderr).toBe(0);
    expect(human.stdout).toMatch(/^BACK-786\.1\.2 {2}Accept two-digit years/);
    expect(human.stdout).toMatch(/Backlog\.md\s+BACK-786\.1\.2 {2}backlog\/tasks\/back-786\.1\.2 - /);
    expect(human.stdout).toMatch(/Locked\s+title, .*status.* \(change them in Backlog\.md\)/);
  });

  it('shows a hidden task and Backlog.md history', async () => {
    const human = await agent(['tasks', 'show', 'BACK-12']);
    expect(human.code, human.stderr).toBe(0);
    expect(human.stdout).toMatch(/Hidden\s+its file is gone from the default branch/);
    expect(human.stdout).toMatch(/Backlog\.md hid the task: its file is gone \([0-9a-f]{7}\)/);
  });

  it('looks a Backlog.md id up in --project, ZAMU_PROJECT and .zamu.json', async () => {
    const flag = parsed(
      await agent(['tasks', 'show', 'BACK-786', '--project', 'MIRR', '--json']),
      'tasks.show',
    );
    expect(flag.task.key).toBe('MIRR-786');
    // Without a project, BACK-786 is BACK's app key.
    const plain = parsed(await agent(['tasks', 'show', 'BACK-786', '--json']), 'tasks.show');
    expect(plain.task.key).toBe('BACK-786');
    const env = parsed(
      await agent(['tasks', 'show', 'back-786.1.2', '--json'], { env: { ZAMU_PROJECT: 'mirr' } }),
      'tasks.show',
    );
    expect(env.task.key).toBe('MIRR-786.1.2');
    // An app key of another project is still found with ZAMU_PROJECT set.
    const other = parsed(
      await agent(['tasks', 'show', 'PAY-1', '--json'], { env: { ZAMU_PROJECT: 'MIRR' } }),
      'tasks.show',
    );
    expect(other.task.key).toBe('PAY-1');
  });

  it('asks for a project when an id is in several, and uses the clone remote', async () => {
    const ambiguous = await agent(['tasks', 'show', 'DRAFT-3', '--json']);
    expect(ambiguous.code).toBe(1);
    expect(parseCliOutput(JSON.parse(ambiguous.stdout), 'error').data.status).toBe(422);

    const repo = await clone('mirr', `${MIRR_REPOSITORY}.git`);
    const show = parsed(await agent(['tasks', 'show', 'draft-3', '--json'], { cwd: repo }), 'tasks.show');
    expect(show.task.key).toBe('MIRR-787');
    const comments = parsed(
      await agent(['comments', 'list', 'DRAFT-3', '--json'], { cwd: repo }),
      'comments.list',
    );
    expect(comments.items).toEqual([]);
  });

  it('comments and cycles stay editable on mirrored tasks, by key or Backlog.md id', async () => {
    const comment = parsed(
      await agent(['comments', 'add', 'BACK-786.1', '--project', 'MIRR', 'Backoff looks right', '--json']),
      'comments.add',
    );
    expect(comment.taskKey).toBe('MIRR-786.1');
    const cycle = parsed(
      await agent(['tasks', 'update', 'BACK-786.1', '--project', 'MIRR', '--cycle', 'current', '--json']),
      'tasks.update',
    );
    expect(cycle.key).toBe('MIRR-786.1');
    expect(cycle.cycle?.number).toBe(1);
  });
});

describe('Backlog.md mirror errors', () => {
  it('task_mirrored: the problem with --json, the canvas text otherwise, exit 6', async () => {
    const problem = expectFailure(
      await agent(['tasks', 'update', 'BACK-786', '--status', 'done', '--json']),
      6,
      'TASK_MIRRORED',
    );
    expect(problem).toMatchObject({
      status: 409,
      detail: "BACK-786 is mirrored from Backlog.md, so its status can't change here",
      field: 'status',
      backlogId: 'BACK-786',
      hint: 'backlog task edit 786 -s Done',
    });
    expect(problem.file).toMatch(/^backlog\/tasks\/back-786 - .+\.md$/);

    const human = await agent(['tasks', 'update', 'BACK-786', '--status', 'done']);
    expect(human.code).toBe(6);
    expect(human.stdout).toBe('');
    // BACK uses cycles but has no current one.
    expect(human.stderr).toBe(
      [
        "error: BACK-786 is mirrored from Backlog.md, so its status can't change here (task_mirrored).",
        `  file:  ${problem.file} (main)`,
        '  edit the file and push, or run: backlog task edit 786 -s Done',
        '  still allowed here: comments (zamu comments add BACK-786) and cycles (zamu tasks update BACK-786 --cycle <number>)',
        '',
      ].join('\n'),
    );
  });

  it('task_mirrored by Backlog.md id names the app key and the current cycle', async () => {
    const problem = expectFailure(
      await agent(['tasks', 'update', 'BACK-786', '--project', 'MIRR', '--title', 'New title', '--json']),
      6,
      'TASK_MIRRORED',
    );
    expect(problem.file).toBe('backlog/tasks/back-786 - Retry-failed-webhook-deliveries.md');
    const human = await agent(['tasks', 'update', 'BACK-786', '--project', 'MIRR', '--title', 'New title']);
    expect(human.code).toBe(6);
    expect(human.stderr).toBe(
      [
        "error: MIRR-786 is mirrored from Backlog.md, so its title can't change here (task_mirrored).",
        '  file:  backlog/tasks/back-786 - Retry-failed-webhook-deliveries.md (main)',
        `  edit the file and push, or run: ${problem.hint}`,
        '  still allowed here: comments (zamu comments add MIRR-786) and cycles (zamu tasks update MIRR-786 --cycle 1)',
        '',
      ].join('\n'),
    );
  });

  it('project_mirrored: tasks are created in Backlog.md', async () => {
    const problem = expectFailure(
      await agent(['tasks', 'create', '--project', 'BACK', 'Retry refunds', '--json']),
      6,
      'PROJECT_MIRRORED',
    );
    expect(problem.hint).toBe('backlog task create "Retry refunds"');
    const human = await agent(['tasks', 'create', '--project', 'BACK', 'Retry refunds']);
    expect(human.code).toBe(6);
    expect(human.stderr).toBe(
      [`error: ${problem.detail?.replace(/\.$/, '')} (project_mirrored).`, `  run: ${problem.hint}`, ''].join(
        '\n',
      ),
    );
  });

  it('milestone_mirrored: new milestones and changes go through Backlog.md', async () => {
    const create = await agent(['milestones', 'create', '--project', 'BACK', 'Refunds']);
    expect(create.code).toBe(6);
    expect(create.stderr).toMatch(
      /^error: Milestones in Payments API come from Backlog\.md\. .* \(milestone_mirrored\)\.\n {2}run: backlog milestone add /,
    );

    const problem = expectFailure(
      await agent([
        'milestones',
        'update',
        'webhooks v2',
        '--project',
        'MIRR',
        '--name',
        'Webhooks v3',
        '--json',
      ]),
      6,
      'MILESTONE_MIRRORED',
    );
    expect(problem.file).toBe('backlog/milestones/m-1 - webhooks-v2.md');
    const human = await agent([
      'milestones',
      'update',
      'webhooks v2',
      '--project',
      'MIRR',
      '--name',
      'Webhooks v3',
    ]);
    expect(human.stderr).toBe(
      [
        "error: Webhooks v2 is mirrored from Backlog.md, so its name can't change here (milestone_mirrored).",
        '  file:  backlog/milestones/m-1 - webhooks-v2.md (main)',
        `  edit the file and push, or run: ${problem.hint}`,
        '',
      ].join('\n'),
    );
  });

  it('backlog_detached: a detached source cannot refresh', async () => {
    await detachBacklog(server, admin, { projectKey: 'MIRR', confirmKey: 'MIRR' });
    expectFailure(await agent(['backlog', 'refresh', '--project', 'MIRR', '--json']), 6, 'BACKLOG_DETACHED');
    const status = parsed(
      await agent(['backlog', 'status', '--project', 'MIRR', '--json']),
      'backlog.status',
    );
    expect(status.state).toBe('detached');
    const human = await agent(['backlog', 'status', '--project', 'MIRR']);
    expect(human.stdout).toMatch(/Detached\s+\d{4}-\d\d-\d\d \d\d:\d\d by /);
    // After detach the task is editable, still found by its Backlog.md id.
    const updated = parsed(
      await agent([
        'tasks',
        'update',
        'BACK-786',
        '--project',
        'MIRR',
        '--title',
        'Retry deliveries',
        '--json',
      ]),
      'tasks.update',
    );
    expect(updated).toMatchObject({ key: 'MIRR-786', title: 'Retry deliveries' });
  });
});

describe('help', () => {
  it('lists the backlog commands and the Backlog.md exit code', async () => {
    const help = await agent(['backlog', '--help']);
    expect(help.code).toBe(0);
    expect(help.stdout).toContain('status [options]');
    expect(help.stdout).toContain('refresh [options]');
    const refresh = await agent(['backlog', 'refresh', '--help']);
    expect(refresh.stdout).toContain('--wait');
    const show = await agent(['tasks', 'show', '--help']);
    expect(show.stdout).toContain('Backlog.md id like BACK-786.1');
  });
});

// Runs after 'Backlog.md mirror errors', which detaches MIRR: BACK still mirrors, MIRR is owned by Zamu.
describe('the work record and Backlog.md (M6)', () => {
  const guidelines =
    '<!-- BACKLOG.MD GUIDELINES START -->\nUse backlog task edit.\n<!-- BACKLOG.MD GUIDELINES END -->';

  it('work-record writes and notes on a mirrored task exit 6 with the file to change', async () => {
    const check = expectFailure(
      await agent(['tasks', 'update', 'BACK-12', '--project', 'BACK', '--check-ac', '1', '--json']),
      6,
      'TASK_MIRRORED',
    );
    expect(check.hint).toMatch(/^backlog task edit /);
    expectFailure(
      await agent(['notes', 'add', 'BACK-12', '--project', 'BACK', 'A note', '--json']),
      6,
      'TASK_MIRRORED',
    );
    const human = await agent(['tasks', 'update', 'BACK-12', '--project', 'BACK', '--plan', 'x']);
    expect(human.code).toBe(6);
    expect(human.stderr).toMatch(/^error: .*\(task_mirrored\)\.\n/);
    expect(human.stderr).toContain('still allowed here: comments (zamu comments add BACK-12)');
  });

  it('zamu tasks show prints the record of a mirrored task as read-only', async () => {
    const human = await agent(['tasks', 'show', 'BACK-786']);
    expect(human.code, human.stderr).toBe(0);
    expect(human.stdout).toContain(
      [
        'Acceptance criteria  1 of 2 settled · from Backlog.md, read-only',
        '  [x] 1  Tasks appear with their Backlog.md numbers',
        '  [ ] 2  A push refreshes the project within seconds',
      ].join('\n'),
    );
    expect(human.stdout).toMatch(/\nPlan {2}by Backlog\.md, [^\n]+\n {4}1\. Parse the folder\n/);
  });

  it('zamu backlog export refuses a project that still mirrors (exit 6)', async () => {
    const requests: string[] = [];
    const fetch = (request: Request) => {
      requests.push(request.url);
      return handle(request);
    };
    const refused = expectFailure(
      await agent(['backlog', 'export', '--project', 'BACK', '--dir', join(home, 'out'), '--json'], {
        fetch,
      }),
      6,
      'PROJECT_MIRRORED',
    );
    expect(refused.detail).toContain('still mirrors Backlog.md');
    expect(requests).toHaveLength(1);
    await expect(stat(join(home, 'out'))).rejects.toThrow();
  });

  it('zamu backlog export writes a switched project with its Backlog.md ids', async () => {
    const repo = await clone('mirr-export', MIRR_REPOSITORY);
    await mkdir(join(repo, 'backlog'), { recursive: true });
    await writeFile(join(repo, 'backlog', 'config.yml'), 'task_prefix: "back"\n');
    const result = await agent(['backlog', 'export', '--project', 'MIRR', '--json'], { cwd: repo });
    const data = parsed(result, 'backlog.export');
    expect(result.stderr).toBe('');
    expect(
      data.files.map((file) => file.path).filter((path) => path.startsWith('tasks/back-786 - ')),
    ).toHaveLength(1);
    expect(data.files.every((file) => file.action === 'created')).toBe(true);
  });

  it('zamu agents keeps the Backlog.md guidelines and the mirrored wording on a mirrored project', async () => {
    const repo = await clone('agents-mirror', 'https://gitlab.com/reddevs/elsewhere');
    await writeFile(join(repo, 'AGENTS.md'), `${guidelines}\n`);
    const out = parsed(await agent(['agents', '--project', 'BACK', '--json'], { cwd: repo }), 'agents');
    expect(out).toMatchObject({ action: 'updated', project: 'BACK', replacedBacklogBlock: false });
    expect(out.block).toContain('BACK mirrors Backlog.md, so the task files own title');
    expect(out.block).toContain('`zamu backlog refresh --wait`');
    const text = await readFile(join(repo, 'AGENTS.md'), 'utf8');
    expect(text).toBe(`${guidelines}\n\n${out.block}\n`);
  });

  it('zamu agents replaces the Backlog.md guidelines on a switched project and says the files are a copy', async () => {
    const repo = await clone('agents-switched', 'https://gitlab.com/reddevs/elsewhere');
    await writeFile(join(repo, 'AGENTS.md'), `# Rules\n\n${guidelines}\n`);
    const out = parsed(await agent(['agents', '--project', 'MIRR', '--json'], { cwd: repo }), 'agents');
    expect(out).toMatchObject({ action: 'updated', project: 'MIRR', replacedBacklogBlock: true });
    expect(out.block).toContain('are a copy written by `zamu backlog export`');
    expect(out.block).not.toContain('mirrors Backlog.md');
    const text = await readFile(join(repo, 'AGENTS.md'), 'utf8');
    expect(text).not.toContain('BACKLOG.MD GUIDELINES');
    expect(text).toContain('The `backlog` CLI is only for documents and decisions, never for tasks.');
  });
});
