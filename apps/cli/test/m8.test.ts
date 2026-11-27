// M8 from the CLI, in-process against a fake server: zamu milestones show (the plan a dispatching
// agent reads) and --plan / --no-plan, zamu waves add, update, remove, put, pass and fail with wave
// references by number, W3 and name, zamu tasks update --wave / --no-wave, the wave in zamu tasks
// show and list, the WAVE_LOCKED and GATE_TASKS_OPEN refusals with their messages and exit codes,
// the warning a person gets after starting a task in a locked wave, the --json shapes, and the
// offline queue for a --wave change. The fake holds the plan of Payouts v2 (W2 passed, W3 current,
// W4 locked until W3 passes) and answers as the contract says the API does.
import { mkdtemp, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import {
  CLI_EXIT_QUEUED,
  type CliData,
  CliQueueFile,
  type CliResultName,
  type MilestonePlan,
  type MilestoneWithProgress,
  parseCliOutput,
  type Task,
  type Wave,
  type WaveTask,
} from '@zamu/contracts';
import {
  ana,
  failedWaveFixture,
  milestonePlanFixture,
  milestoneWithProgressFixture,
  payoutsMilestoneFixture,
  payoutsMilestoneId,
  taskFixture,
  taskListItemFixture,
  taskListPageFixture,
  waveActivityFixture,
  waveIds,
  waveTaskFixture,
} from '@zamu/contracts/testing/fixtures';
import { beforeEach, describe, expect, it } from 'vitest';
import { changeSentence } from '../src/format';
import { INSTRUCTIONS } from '../src/instructions';
import type { CliIo, FetchLike } from '../src/io';
import { main } from '../src/main';
import { queueability, summarize } from '../src/queue';

const URL = 'http://zamu.test';
const KEY = 'zamu_live_m8m8m8m8m8m8m8m8m8m8';
const NEW_WAVE_ID = '0190a1b2-c3d4-7e5f-8a9b-0c1d2e3f4c19';

interface Seen {
  method: string;
  path: string;
  body: Record<string, unknown> | null;
}

/** JSON round trip: the fixtures hold Dates, the wire holds strings. */
const wire = <T = Record<string, unknown>>(value: unknown): T => JSON.parse(JSON.stringify(value)) as T;

let home: string;
let requests: Seen[];
let down: boolean;
/** Who the key belongs to: the server refuses an agent that starts a task in a locked wave. */
let actor: 'agent' | 'person';
/** Whether the GATE_TASKS_OPEN message lists the open keys itself. */
let keysInMessage: boolean;
let plan: MilestonePlan;
let milestone: MilestoneWithProgress;
let tasks: Map<string, Task>;

function task(key: string, overrides: Partial<Task> = {}): Task {
  return {
    ...wire<Task>(taskFixture),
    key,
    number: Number(key.split('-')[1]),
    status: 'todo',
    milestone: { id: payoutsMilestoneId, name: 'Payouts v2', status: 'active', targetDate: '2026-12-18' },
    wave: null,
    ...overrides,
  };
}

beforeEach(async () => {
  home = await mkdtemp(join(tmpdir(), 'zamu-cli-m8-'));
  requests = [];
  down = false;
  actor = 'agent';
  keysInMessage = false;
  plan = wire<MilestonePlan>(milestonePlanFixture);
  milestone = plan.milestone;
  tasks = new Map<string, Task>([
    ['PAY-174', { ...wire<Task>(waveTaskFixture), title: 'Failed payout banner' }],
    ['PAY-180', task('PAY-180', { title: 'Feature flag' })],
    ['PAY-190', task('PAY-190', { title: 'Payout fees in the docs' })],
    ['PAY-200', task('PAY-200', { title: 'Loose task', milestone: null })],
  ]);
  return () => rm(home, { recursive: true, force: true });
});

function problem(status: number, code: string, detail: string, extra: Record<string, unknown> = {}) {
  return Response.json({ type: 'about:blank', title: code, status, code, detail, ...extra }, { status });
}

/** The wave as a task carries it, with the lock of the plan. */
function taskWave(wave: Wave) {
  return {
    id: wave.id,
    number: wave.number,
    name: wave.name,
    locked: wave.locked,
    lockedUntil: wave.lockedUntil,
  };
}

function waveTaskOf(value: Task): WaveTask {
  return {
    key: value.key,
    title: value.title,
    status: value.status as WaveTask['status'],
    assignee: null,
    archived: false,
  };
}

/** Takes tasks out of every wave and the no-wave list of the plan. */
function detach(keys: readonly string[]): WaveTask[] {
  const found: WaveTask[] = [];
  const keep = (list: WaveTask[]) =>
    list.filter((item) => {
      if (!keys.includes(item.key)) return true;
      found.push(item);
      return false;
    });
  for (const wave of plan.waves) wave.tasks = keep(wave.tasks);
  plan.notInWave = keep(plan.notInWave);
  return found;
}

function recount(wave: Wave): Wave {
  const done = wave.tasks.filter((item) => item.status === 'done').length;
  const canceled = wave.tasks.filter((item) => item.status === 'canceled').length;
  const total = wave.tasks.length;
  const openKeys = wave.tasks
    .filter((item) => item.status !== 'done' && item.status !== 'canceled')
    .map((item) => item.key);
  wave.progress = { total, done, canceled, open: total - done - canceled };
  wave.openKeys = openKeys;
  wave.canPass = openKeys.length === 0;
  return wave;
}

const server: FetchLike = async (request) => {
  if (down) throw new TypeError('fetch failed', { cause: new Error('connect ECONNREFUSED 127.0.0.1:3000') });
  const url = new globalThis.URL(request.url);
  const path = url.pathname.replace(/^\/api\/v1/, '');
  const text = request.method === 'GET' || request.method === 'DELETE' ? '' : await request.text();
  const body = text ? (JSON.parse(text) as Record<string, unknown>) : null;
  requests.push({ method: request.method, path, body });

  if (request.method === 'GET' && path === '/projects/PAY/milestones') {
    const plain = {
      ...wire<MilestoneWithProgress>(milestoneWithProgressFixture),
      waves: null,
      planUrl: null,
    };
    return Response.json({ items: [milestone, plain] });
  }
  const milestoneRoute = /^\/milestones\/([^/]+)(?:\/(plan|waves|wave-tasks))?$/.exec(path);
  if (milestoneRoute) {
    const [, id, part] = milestoneRoute as unknown as [string, string, string | undefined];
    if (id !== payoutsMilestoneId) return problem(404, 'NOT_FOUND', 'No such milestone');
    if (part === 'plan' && request.method === 'GET') return Response.json(plan);
    if (!part && request.method === 'PATCH') {
      milestone = {
        ...milestone,
        ...(body && 'planUrl' in body ? { planUrl: body.planUrl as string | null } : {}),
      };
      plan = { ...plan, milestone, planUrl: milestone.planUrl ?? null };
      return Response.json(milestone);
    }
    if (part === 'waves' && request.method === 'POST') {
      const last = plan.waves.at(-1);
      const wave: Wave = recount({
        ...wire<Wave>(plan.waves[2]),
        id: NEW_WAVE_ID,
        number: (body?.position as number | undefined) ?? (last ? last.number + 1 : 1),
        name: String(body?.name),
        gate: {
          description: (body?.gateDescription as string | null | undefined) ?? null,
          state: 'open',
          result: null,
        },
        lockedUntil: { number: 3, name: 'Payout screens' },
        tasks: [],
      });
      plan.waves.push(wave);
      return Response.json(wave, { status: 201 });
    }
    if (part === 'wave-tasks' && request.method === 'POST') {
      const keys = ((body?.keys ?? []) as string[]).map((key) => key.toUpperCase());
      const missing = keys.find((key) => !tasks.has(key));
      if (missing) return problem(404, 'NOT_FOUND', `No task ${missing}`);
      const moved = detach(keys);
      const items = keys.map(
        (key) => moved.find((item) => item.key === key) ?? waveTaskOf(tasks.get(key) as Task),
      );
      const wave = plan.waves.find((candidate) => candidate.id === body?.wave);
      if (wave) wave.tasks.push(...items);
      else plan.notInWave.push(...items);
      for (const candidate of plan.waves) recount(candidate);
      for (const key of keys) {
        const current = tasks.get(key) as Task;
        tasks.set(key, { ...current, wave: wave ? taskWave(wave) : null });
      }
      return Response.json(plan);
    }
  }
  const waveRoute = /^\/waves\/([^/]+)(?:\/(gate))?$/.exec(path);
  if (waveRoute) {
    const [, id, part] = waveRoute as unknown as [string, string, string | undefined];
    const wave = plan.waves.find((candidate) => candidate.id === id);
    if (!wave) return problem(404, 'NOT_FOUND', 'No such wave');
    if (part === 'gate' && request.method === 'POST') {
      if (body?.state === 'passed' && wave.openKeys.length) {
        // keysInMessage: the message lists the keys itself; otherwise only openKeys does.
        const detail = keysInMessage
          ? `W${wave.number} · ${wave.name} has ${wave.openKeys.length} open tasks: ${wave.openKeys.join(', ')}. Finish or cancel them before passing its gate.`
          : `W${wave.number} · ${wave.name} has open tasks`;
        return problem(409, 'GATE_TASKS_OPEN', detail, { openKeys: wave.openKeys });
      }
      const state = body?.state as 'passed' | 'failed';
      const result = {
        state,
        note: String(body?.note),
        recordedBy: {
          id: '0190a1b2-0000-7000-8000-00000000c0c0',
          name: 'claude-dev',
          kind: 'agent' as const,
        },
        onBehalfOf: ana,
        at: '2026-11-27T09:00:00.000Z',
        source: { machine: 'laptop', branch: null },
      };
      wave.gate = { ...wave.gate, state, result };
      wave.current = state !== 'passed';
      return Response.json(wave);
    }
    if (request.method === 'PATCH') {
      if (body && 'name' in body) wave.name = String(body.name);
      if (body && 'gateDescription' in body)
        wave.gate = { ...wave.gate, description: body.gateDescription as string | null };
      if (body && typeof body.position === 'number') wave.number = body.position;
      return Response.json(wave);
    }
    if (request.method === 'DELETE') {
      plan.notInWave.push(...wave.tasks);
      plan.waves = plan.waves.filter((candidate) => candidate !== wave);
      return new Response(null, { status: 204 });
    }
  }
  if (request.method === 'GET' && path === '/tasks') {
    const items = [...tasks.values()].map((value) => ({
      ...wire(taskListItemFixture),
      key: value.key,
      number: value.number,
      title: value.title,
      status: value.status,
      wave: value.wave ?? null,
    }));
    return Response.json({ ...wire(taskListPageFixture), items, nextCursor: null });
  }
  const taskRoute = /^\/tasks\/([A-Z]+-\d+)(?:\/(timeline))?$/.exec(path);
  if (taskRoute) {
    const [, key, part] = taskRoute as unknown as [string, string, string | undefined];
    const current = tasks.get(key);
    if (!current) return problem(404, 'NOT_FOUND', `No task ${key}`);
    if (part === 'timeline') {
      const items = [{ ...wire(waveActivityFixture), kind: 'activity' }];
      return Response.json({ items, counts: { all: 1, notes: 0, comments: 0, history: 1 } });
    }
    if (request.method === 'GET') return Response.json(current);
    if (request.method === 'PATCH') {
      const next: Task = { ...current };
      if (body && 'wave' in body) {
        const wave = plan.waves.find((candidate) => candidate.id === body.wave);
        if (body.wave !== null && !wave)
          return problem(422, 'BAD_REQUEST', 'That wave is not in this workspace');
        next.wave = wave ? taskWave(wave) : null;
        if (wave)
          next.milestone = {
            id: payoutsMilestoneId,
            name: 'Payouts v2',
            status: 'active',
            targetDate: '2026-12-18',
          };
      }
      const starting =
        (current.status === 'backlog' || current.status === 'todo') &&
        (body?.status === 'in_progress' || body?.status === 'in_review');
      if (starting && next.wave?.locked && actor === 'agent' && next.wave.lockedUntil) {
        const waits = next.wave.lockedUntil;
        return problem(
          409,
          'WAVE_LOCKED',
          `${key} is in W${next.wave.number} · ${next.wave.name}, which is locked until W${waits.number} · ${waits.name} passes. Wait for the gate of W${waits.number} to pass, or ask a person to start it.`,
          {
            waveLock: {
              task: key,
              wave: { number: next.wave.number, name: next.wave.name },
              waitsFor: waits,
            },
            hint: 'zamu milestones show "Payouts v2" --project PAY',
          },
        );
      }
      if (typeof body?.status === 'string') next.status = body.status as Task['status'];
      tasks.set(key, next);
      return Response.json(next);
    }
  }
  return problem(404, 'NOT_FOUND', 'No such route');
};

interface RunResult {
  code: number;
  stdout: string;
  stderr: string;
}

async function zamu(
  args: string[],
  { stdin = '', env = {} }: { stdin?: string; env?: Record<string, string> } = {},
) {
  const out: string[] = [];
  const err: string[] = [];
  const io: CliIo = {
    stdout: (text) => out.push(text),
    stderr: (text) => err.push(text),
    readStdin: async () => stdin,
    env: {
      XDG_CONFIG_HOME: join(home, 'config'),
      XDG_STATE_HOME: join(home, 'state'),
      ZAMU_URL: URL,
      ZAMU_KEY: KEY,
      ZAMU_MACHINE: 'laptop',
      ZAMU_PROJECT: 'PAY',
      ...env,
    },
    homeDir: home,
    cwd: home,
    isTTY: false,
    fetch: server,
  };
  const code = await main(args, io);
  return { code, stdout: out.join(''), stderr: err.join('') } satisfies RunResult;
}

function ok<N extends CliResultName>(result: RunResult, name: N): CliData<N> {
  expect(result.code, result.stdout + result.stderr).toBe(0);
  expect(result.stdout.trim().split('\n'), 'one JSON line').toHaveLength(1);
  return (parseCliOutput(JSON.parse(result.stdout), name) as { data: CliData<N> }).data;
}

function failed(result: RunResult, exitCode: number, code: string) {
  expect(result.code, result.stdout + result.stderr).toBe(exitCode);
  const error = parseCliOutput(JSON.parse(result.stdout), 'error').data;
  expect(error.code).toBe(code);
  return error;
}

async function queueEntries() {
  const text = await readFile(join(home, 'state', 'zamu', 'queue.json'), 'utf8').catch(() => null);
  return text === null ? [] : CliQueueFile.parse(JSON.parse(text)).entries;
}

const writes = () => requests.filter((seen) => seen.method !== 'GET');

describe('zamu milestones show', () => {
  it('prints the plan: milestone line, plan link, waves with gates, locks and tasks, and what comes next', async () => {
    const result = await zamu(['milestones', 'show', 'payouts V2']);
    expect(result.code, result.stderr).toBe(0);
    expect(result.stdout).toBe(
      [
        'Payouts v2  PAY · Active · target 2026-12-18 (21 days left) · 14 of 21 done',
        'Plan  plans/payouts-v2.html',
        '',
        'W2 · Ledger  4 of 4 done · gate passed',
        '  Gate: Ledger entries balance for every payout in the staging run.',
        '  Passed by claude-dev for Ana Ruiz, 2026-11-24 16:00: Ran the staging payout batch: 412 entries, all balanced.',
        '  PAY-160  Done       claude-dev  Ledger table',
        '  PAY-161  Done       claude-dev  Post entries on payout',
        '  PAY-162  Done       claude-dev  Reverse entries on refund',
        '  PAY-163  Done       Ana Ruiz    Ledger export (archived)',
        '',
        'W3 · Payout screens  4 of 6 done · gate open · current',
        '  Gate: Screens match the design in light and dark, at 1440, 1280 and 1024.',
        '  PAY-170  Done       claude-dev  Payout list',
        '  PAY-171  Done       claude-dev  Payout detail',
        '  PAY-172  Done       Ana Ruiz    Empty state',
        '  PAY-175  Done       claude-dev  Dark theme pass',
        '  PAY-173  In review  claude-dev  Retry button',
        '  PAY-174  Todo       Unassigned  Failed payout banner',
        '',
        'W4 · Rollout  0 of 2 done · gate open · locked until W3 passes',
        '  Gate: not described',
        '  PAY-180  Todo       Unassigned  Feature flag',
        '  PAY-181  Todo       Unassigned  Merchant email',
        '',
        'Not in a wave  1 task · no gate',
        '  PAY-190  Todo       Tomás Berg  Payout fees in the docs',
        '',
        `Next: W3 has 2 open tasks: PAY-173, PAY-174. When they are done, run the gate's checks and record the result: zamu waves pass "payouts V2" W3 --note "what was checked"`,
        '',
      ].join('\n'),
    );
    // The name was looked up in the folder's project.
    expect(requests.map((seen) => `${seen.method} ${seen.path}`)).toEqual([
      'GET /projects/PAY/milestones',
      `GET /milestones/${payoutsMilestoneId}/plan`,
    ]);
  });

  it('prints zamu.v1.milestone-plan with --json, by id too', async () => {
    const data = ok(await zamu(['milestones', 'show', payoutsMilestoneId, '--json']), 'milestone-plan');
    expect(data.planUrl).toBe('plans/payouts-v2.html');
    expect(data.waves.map((wave) => [wave.number, wave.name, wave.gate.state, wave.locked])).toEqual([
      [2, 'Ledger', 'passed', false],
      [3, 'Payout screens', 'open', false],
      [4, 'Rollout', 'open', true],
    ]);
    expect(data.notInWave.map((item) => item.key)).toEqual(['PAY-190']);
    // An id needs no project lookup.
    expect(requests.map((seen) => seen.path)).toEqual([`/milestones/${payoutsMilestoneId}/plan`]);
  });

  it('says what comes next for a failed gate, a wave ready to pass, all gates passed and no waves', async () => {
    plan.waves[1] = wire<Wave>(failedWaveFixture);
    let text = (await zamu(['milestones', 'show', 'Payouts v2', '--project', 'pay'])).stdout;
    expect(text).toContain('W3 · Payout screens  4 of 6 done · gate failed · current\n');
    expect(text).toContain(
      '  Failed by Tomás Berg, 2026-11-26 11:00: The banner overlaps the list at 1024.\n',
    );
    expect(text).toContain(
      `Next: W3's gate failed. Log each fix as a task in W3 (zamu waves put "Payouts v2" W3 KEY --project PAY), then run the gate's checks again`,
    );

    plan.waves[1] = {
      ...wire<Wave>(failedWaveFixture),
      progress: { total: 6, done: 6, canceled: 0, open: 0 },
      openKeys: [],
      canPass: true,
      gate: { description: null, state: 'open', result: null },
    };
    text = (await zamu(['milestones', 'show', 'Payouts v2'])).stdout;
    expect(text).toContain(
      `Next: every task in W3 is done or canceled. Run the gate's checks and record the result: zamu waves pass "Payouts v2" W3 --note "what was checked", or zamu waves fail with what failed.\n`,
    );

    const passedResult = (plan.waves[0] as Wave).gate.result;
    const passed = (wave: Wave): Wave => ({
      ...wave,
      current: false,
      locked: false,
      lockedUntil: null,
      gate: {
        ...wave.gate,
        state: 'passed',
        result: { ...(passedResult as NonNullable<Wave['gate']['result']>), state: 'passed' },
      },
    });
    plan.waves = plan.waves.map(passed);
    text = (await zamu(['milestones', 'show', 'Payouts v2'])).stdout;
    expect(text).toContain('W4 · Rollout  0 of 2 done · gate passed · 2 tasks open\n');
    expect(text).toMatch(
      /Next: All 3 gates passed\. 5 tasks still open: PAY-173, PAY-174, PAY-180, PAY-181, PAY-190\.\n$/,
    );

    plan.waves = [];
    plan.notInWave = [];
    plan.planUrl = null;
    text = (await zamu(['milestones', 'show', 'Payouts v2'])).stdout;
    expect(text).toContain('Plan  none. Add it: zamu milestones update "Payouts v2" --plan <url-or-path>\n');
    expect(text).toMatch(
      /Next: add the waves of the plan, in order: zamu waves add "Payouts v2" "Ledger" --gate/,
    );
  });

  it('lists the milestones of the project when the name is unknown', async () => {
    const result = await zamu(['milestones', 'show', 'Payouts v3']);
    expect(result.code).toBe(1);
    expect(result.stderr).toContain('No milestone named "Payouts v3" in PAY.');
    expect(result.stderr).toContain('"Payouts v2"');
  });
});

describe('zamu milestones update --plan and list', () => {
  it('sets the plan link, clears it with --no-plan, and shows it', async () => {
    const set = ok(
      await zamu([
        'milestones',
        'update',
        'Payouts v2',
        '--plan',
        'https://wiki.northwind.dev/payouts',
        '--json',
      ]),
      'milestones.update',
    );
    expect(set.planUrl).toBe('https://wiki.northwind.dev/payouts');
    expect(writes().at(-1)).toEqual({
      method: 'PATCH',
      path: `/milestones/${payoutsMilestoneId}`,
      body: { planUrl: 'https://wiki.northwind.dev/payouts' },
    });
    const text = await zamu(['milestones', 'update', payoutsMilestoneId, '--plan', 'plans/payouts-v2.html']);
    expect(text.stdout).toMatch(/Plan\s+plans\/payouts-v2\.html\n/);
    expect(text.stdout).toMatch(/Waves\s+W3 of 5 · gate open\n/);

    const cleared = ok(
      await zamu(['milestones', 'update', 'Payouts v2', '--no-plan', '--json']),
      'milestones.update',
    );
    expect(cleared.planUrl).toBeNull();
    expect(writes().at(-1)?.body).toEqual({ planUrl: null });

    requests = [];
    const multiline = await zamu(['milestones', 'update', 'Payouts v2', '--plan', 'one\ntwo', '--json']);
    expect(failed(multiline, 1, 'BAD_REQUEST').issues?.[0]?.message).toBe('Keep it on one line');
    expect(requests).toHaveLength(0);
  });

  it('shows the wave column on the list when a milestone has waves', async () => {
    const text = await zamu(['milestones', 'list']);
    expect(text.stdout.split('\n')[0]).toMatch(/OPEN\s+WAVES\s+NAME$/);
    expect(text.stdout).toMatch(/W3 of 5 · gate open\s+Payouts v2/);
  });
});

describe('zamu waves add, update and remove', () => {
  it('adds a wave with its gate (from stdin too) at the end or at --position', async () => {
    const added = ok(
      await zamu(['waves', 'add', 'Payouts v2', 'Launch', 'review', '--gate', '-', '--json'], {
        stdin: 'Support has the runbook.',
      }),
      'wave',
    );
    expect(added).toMatchObject({
      number: 5,
      name: 'Launch review',
      gate: { description: 'Support has the runbook.' },
    });
    expect(writes().at(-1)).toEqual({
      method: 'POST',
      path: `/milestones/${payoutsMilestoneId}/waves`,
      body: { name: 'Launch review', gateDescription: 'Support has the runbook.' },
    });

    const text = await zamu(['waves', 'add', 'Payouts v2', 'Pilot', '--position', 'W2']);
    expect(text.code, text.stderr).toBe(0);
    expect(writes().at(-1)?.body).toEqual({ name: 'Pilot', position: 2 });
    expect(text.stdout).toBe(
      'Added W2 · Pilot  0 of 0 done · gate open · locked (W3 has not passed)\n' +
        '  Gate: not described\n' +
        'Put tasks in it: zamu waves put "Payouts v2" W2 KEY...\n',
    );
  });

  it('checks the input before any request', async () => {
    const position = await zamu(['waves', 'add', 'Payouts v2', 'Pilot', '--position', 'first', '--json']);
    expect(failed(position, 1, 'BAD_REQUEST').detail).toBe(
      '--position takes a wave number, such as 2 or W2, not "first".',
    );
    const long = await zamu(['waves', 'add', 'Payouts v2', 'x'.repeat(101), '--json']);
    expect(failed(long, 1, 'BAD_REQUEST').issues?.[0]?.message).toBe('Keep it to 100 characters or fewer');
    const nothing = await zamu(['waves', 'update', 'Payouts v2', 'W3', '--json']);
    expect(failed(nothing, 1, 'BAD_REQUEST').issues?.[0]?.message).toContain('Change at least one of');
    expect(requests).toHaveLength(0);
  });

  it('updates a wave named by number, W3 or name', async () => {
    const renamed = ok(
      await zamu(['waves', 'update', 'Payouts v2', '3', '--name', 'Screens', '--json']),
      'wave',
    );
    expect(renamed).toMatchObject({ id: waveIds.w3, name: 'Screens' });
    expect(writes().at(-1)).toEqual({
      method: 'PATCH',
      path: `/waves/${waveIds.w3}`,
      body: { name: 'Screens' },
    });

    await zamu(['waves', 'update', 'Payouts v2', 'w4', '--gate', 'Flag on for 10% of merchants']);
    expect(writes().at(-1)).toEqual({
      method: 'PATCH',
      path: `/waves/${waveIds.w4}`,
      body: { gateDescription: 'Flag on for 10% of merchants' },
    });

    const byName = await zamu(['waves', 'update', 'Payouts v2', 'LEDGER', '--gate', '', '--position', '1']);
    expect(byName.code, byName.stderr).toBe(0);
    expect(writes().at(-1)).toEqual({
      method: 'PATCH',
      path: `/waves/${waveIds.w2}`,
      body: { gateDescription: null, position: 1 },
    });
    expect(byName.stdout).toBe(
      'Updated W1 · Ledger  4 of 4 done · gate passed\n  Gate: not described\n  Passed by claude-dev for Ana Ruiz, 2026-11-24 16:00: Ran the staging payout batch: 412 entries, all balanced.\n',
    );
  });

  it('refuses a wave the milestone does not have, listing its waves', async () => {
    const result = await zamu(['waves', 'update', 'Payouts v2', 'W9', '--name', 'Later']);
    expect(result.code).toBe(1);
    expect(result.stderr).toBe(
      'zamu: Payouts v2 has no wave W9.\n  Waves in Payouts v2: W2 · Ledger, W3 · Payout screens, W4 · Rollout\n',
    );
    const json = failed(await zamu(['waves', 'remove', 'Payouts v2', 'Launch', '--json']), 1, 'BAD_REQUEST');
    expect(json.detail).toBe('Payouts v2 has no wave named "Launch".');
    expect(writes()).toHaveLength(0);
  });

  it('removes a wave: its tasks go to no wave', async () => {
    const removed = ok(await zamu(['waves', 'remove', 'Payouts v2', 'W4', '--json']), 'wave-removed');
    expect(removed).toEqual({
      milestoneId: payoutsMilestoneId,
      removed: { id: waveIds.w4, number: 4, name: 'Rollout' },
      tasks: ['PAY-180', 'PAY-181'],
    });
    expect(writes().at(-1)).toEqual({ method: 'DELETE', path: `/waves/${waveIds.w4}`, body: null });
    const text = await zamu(['waves', 'remove', 'Payouts v2', 'ledger']);
    expect(text.stdout).toBe(
      'Removed W2 · Ledger and its gate results from Payouts v2. Its 4 tasks are in no wave now: ' +
        'PAY-160, PAY-161, PAY-162, PAY-163. The waves after it moved up one number.\n',
    );
  });
});

describe('zamu waves put', () => {
  it('puts tasks in a wave and takes them out with none', async () => {
    const data = ok(
      await zamu(['waves', 'put', 'Payouts v2', 'W4', 'pay-190,PAY-200', '--json']),
      'milestone-plan',
    );
    expect(writes().at(-1)).toEqual({
      method: 'POST',
      path: `/milestones/${payoutsMilestoneId}/wave-tasks`,
      body: { wave: waveIds.w4, keys: ['PAY-190', 'PAY-200'] },
    });
    expect(data.waves.find((wave) => wave.number === 4)?.tasks.map((item) => item.key)).toEqual([
      'PAY-180',
      'PAY-181',
      'PAY-190',
      'PAY-200',
    ]);

    const text = await zamu(['waves', 'put', 'Payouts v2', 'Rollout', 'PAY-174']);
    expect(text.stdout).toBe(
      'Put PAY-174 in W4 · Rollout.\nW4 · Rollout  0 of 5 done · gate open · locked until W3 passes\n',
    );

    requests = [];
    const out = await zamu(['waves', 'put', 'Payouts v2', 'none', 'PAY-190', 'PAY-200']);
    expect(out.stdout).toBe('Took PAY-190, PAY-200 out of their waves. Payouts v2 has 2 tasks in no wave.\n');
    // none needs no plan to look a wave up in.
    expect(requests.map((seen) => `${seen.method} ${seen.path}`)).toEqual([
      'GET /projects/PAY/milestones',
      `POST /milestones/${payoutsMilestoneId}/wave-tasks`,
    ]);
    expect(writes().at(-1)?.body).toEqual({ wave: null, keys: ['PAY-190', 'PAY-200'] });
  });
});

describe('zamu waves pass and fail', () => {
  it('records a pass with its note and says which wave unlocks', async () => {
    const data = ok(
      await zamu(['waves', 'pass', 'Payouts v2', '2', '--note', 'Ran the staging batch again', '--json']),
      'gate-result',
    );
    expect(data.result).toMatchObject({ state: 'passed', note: 'Ran the staging batch again' });
    expect(data.wave.id).toBe(waveIds.w2);
    expect(writes().at(-1)).toEqual({
      method: 'POST',
      path: `/waves/${waveIds.w2}/gate`,
      body: { state: 'passed', note: 'Ran the staging batch again' },
    });

    plan.waves[1] = recount({
      ...(plan.waves[1] as Wave),
      tasks: (plan.waves[1] as Wave).tasks.map((item) => ({ ...item, status: 'done' })),
    });
    const text = await zamu(['waves', 'pass', 'Payouts v2', 'W3', '--note', '-'], {
      stdin: 'Checked light and dark at 1440, 1280 and 1024.\n\nScreenshots in the PR.',
    });
    expect(text.code, text.stderr).toBe(0);
    expect(text.stdout).toBe(
      'Passed the gate of W3 · Payout screens.\n' +
        '  Note: Checked light and dark at 1440, 1280 and 1024.\n' +
        'W4 · Rollout is unlocked: its tasks can start.\n',
    );
  });

  it('records a fail and says to log the fix as a task in the same wave', async () => {
    const text = await zamu([
      'waves',
      'fail',
      'Payouts v2',
      'payout screens',
      '--note',
      'Banner overlaps at 1024',
    ]);
    expect(text.code, text.stderr).toBe(0);
    expect(text.stdout).toBe(
      'Failed the gate of W3 · Payout screens.\n' +
        '  Note: Banner overlaps at 1024\n' +
        'The waves after it stay locked. Log each fix as a task in W3 (zamu waves put "Payouts v2" W3 KEY), then record the gate again.\n',
    );
    expect(writes().at(-1)?.body).toEqual({ state: 'failed', note: 'Banner overlaps at 1024' });
  });

  it('refuses a pass while tasks are open: GATE_TASKS_OPEN, exit 1, with the open keys', async () => {
    const json = failed(
      await zamu(['waves', 'pass', 'Payouts v2', 'W3', '--note', 'x', '--json']),
      1,
      'GATE_TASKS_OPEN',
    );
    expect(json.openKeys).toEqual(['PAY-173', 'PAY-174']);
    const text = await zamu(['waves', 'pass', 'Payouts v2', 'W3', '--note', 'x']);
    expect(text.code).toBe(1);
    expect(text.stderr).toBe(
      'zamu: W3 · Payout screens has open tasks\n  Open: PAY-173, PAY-174\n  A fail can be recorded at any time.\n',
    );
    // A message that lists the keys already gets no second list.
    keysInMessage = true;
    expect((await zamu(['waves', 'pass', 'Payouts v2', 'W3', '--note', 'x'])).stderr).toBe(
      'zamu: W3 · Payout screens has 2 open tasks: PAY-173, PAY-174. Finish or cancel them before passing its gate.\n' +
        '  A fail can be recorded at any time.\n',
    );
  });

  it('needs a note, and checks it before any request', async () => {
    const missing = await zamu(['waves', 'pass', 'Payouts v2', 'W3']);
    expect(missing.code).toBe(1);
    expect(missing.stderr).toContain("required option '--note <text>' not specified");
    const blank = await zamu(['waves', 'fail', 'Payouts v2', 'W3', '--note', '  ', '--json']);
    expect(failed(blank, 1, 'BAD_REQUEST').issues?.[0]?.message).toBe('Say what was checked');
    expect(requests).toHaveLength(0);
  });
});

describe('zamu tasks update --wave and the lock', () => {
  it('puts a task in a wave of its milestone by number, W3 or name, and takes it out', async () => {
    const moved = ok(await zamu(['tasks', 'update', 'PAY-190', '--wave', '3', '--json']), 'tasks.update');
    expect(moved.wave).toMatchObject({ id: waveIds.w3, number: 3, locked: false });
    expect(writes().at(-1)).toEqual({ method: 'PATCH', path: '/tasks/PAY-190', body: { wave: waveIds.w3 } });

    await zamu(['tasks', 'update', 'PAY-190', '--wave', 'W4']);
    expect(writes().at(-1)?.body).toEqual({ wave: waveIds.w4 });
    const text = await zamu(['tasks', 'update', 'PAY-190', '--wave', 'ledger']);
    expect(writes().at(-1)?.body).toEqual({ wave: waveIds.w2 });
    expect(text.stdout).toMatch(/\nWave\s+W2 · Ledger\n/);

    await zamu(['tasks', 'update', 'PAY-190', '--no-wave']);
    expect(writes().at(-1)?.body).toEqual({ wave: null });
    await zamu(['tasks', 'update', 'PAY-190', '--wave', 'none']);
    expect(writes().at(-1)?.body).toEqual({ wave: null });
    // A wave id needs no lookup.
    requests = [];
    await zamu(['tasks', 'update', 'PAY-190', '--wave', waveIds.w4]);
    expect(requests.map((seen) => seen.method)).toEqual(['PATCH']);
  });

  it('looks the wave up in --milestone for a task without one, and refuses a task without a milestone', async () => {
    await zamu(['tasks', 'update', 'PAY-200', '--wave', 'W3', '--milestone', 'payouts v2']);
    // The wave decides the milestone: only the wave is sent.
    expect(writes().at(-1)).toEqual({ method: 'PATCH', path: '/tasks/PAY-200', body: { wave: waveIds.w3 } });

    const none = await zamu(['tasks', 'update', 'PAY-200', '--wave', 'W3', '--milestone', 'none']);
    expect(none.code).toBe(1);
    expect(none.stderr).toContain('Use either --milestone none or --wave, not both.');

    tasks.set('PAY-200', task('PAY-200', { milestone: null }));
    const loose = await zamu(['tasks', 'update', 'PAY-200', '--wave', 'W3']);
    expect(loose.code).toBe(1);
    expect(loose.stderr).toContain(
      'PAY-200 has no milestone, so --wave W3 names no wave. Add --milestone <name>',
    );
  });

  it('refuses an agent starting a task in a locked wave: WAVE_LOCKED, exit 1, the message and the hint', async () => {
    const text = await zamu(['tasks', 'update', 'PAY-174', '--status', 'in_progress']);
    expect(text.code).toBe(1);
    expect(text.stderr).toBe(
      'zamu: PAY-174 is in W4 · Rollout, which is locked until W3 · Payout screens passes. Wait for the gate of W3 to pass, or ask a person to start it.\n' +
        '  The waves and their gates: zamu milestones show "Payouts v2" --project PAY\n' +
        "  Don't take PAY-174 out of its wave to get around the lock.\n",
    );
    const json = failed(
      await zamu(['tasks', 'update', 'PAY-174', '--status', 'in_progress', '--json']),
      1,
      'WAVE_LOCKED',
    );
    expect(json.waveLock).toEqual({
      task: 'PAY-174',
      wave: { number: 4, name: 'Rollout' },
      waitsFor: { number: 3, name: 'Payout screens' },
    });
    expect(json.hint).toContain('zamu milestones show');
    expect(tasks.get('PAY-174')?.status).toBe('todo');
  });

  it('warns a person who starts a task in a locked wave, and makes the change', async () => {
    actor = 'person';
    const text = await zamu(['tasks', 'update', 'PAY-174', '--status', 'in_progress']);
    expect(text.code, text.stderr).toBe(0);
    expect(text.stderr).toBe('Warning: PAY-174 is in W4, which is locked until W3 passes.\n');
    expect(tasks.get('PAY-174')?.status).toBe('in_progress');
    // With --json the warning still goes to stderr, so stdout stays one result.
    tasks.set('PAY-174', { ...(tasks.get('PAY-174') as Task), status: 'todo' });
    const json = await zamu(['tasks', 'update', 'PAY-174', '--status', 'in_review', '--json']);
    expect(ok(json, 'tasks.update').status).toBe('in_review');
    expect(json.stderr).toBe('Warning: PAY-174 is in W4, which is locked until W3 passes.\n');
    // No warning for changes that don't start the task.
    expect((await zamu(['tasks', 'update', 'PAY-174', '--status', 'todo'])).stderr).toBe('');
  });
});

describe('the wave in zamu tasks show and list', () => {
  it('shows the wave with its lock, and the history line of a wave change', async () => {
    const text = await zamu(['tasks', 'show', 'PAY-174']);
    expect(text.code, text.stderr).toBe(0);
    expect(text.stdout).toMatch(
      /\nMilestone\s+Payouts v2 \(Active, target 2026-12-18\)\nWave\s+W4 · Rollout · locked until W3 passes\n/,
    );
    expect(text.stdout).toContain('Ana Ruiz moved it from W3 · Payout screens to W4 · Rollout');
    const json = ok(await zamu(['tasks', 'show', 'PAY-174', '--json']), 'tasks.show');
    expect(json.task.wave).toEqual(wire(waveTaskFixture).wave);
  });

  it('lists the wave column when a task has a wave', async () => {
    const text = await zamu(['tasks', 'list']);
    const [header, ...rows] = text.stdout.split('\n');
    expect(header).toMatch(/\bWAVE\b/);
    expect(rows.find((row) => row.startsWith('PAY-174'))).toMatch(/W4 locked/);
  });

  it('phrases wave changes', () => {
    const w3 = { id: waveIds.w3, number: 3, name: 'Payout screens', removed: false };
    const gone = { id: waveIds.w2, number: 2, name: 'Ledger', removed: true };
    expect(changeSentence({ field: 'wave', from: null, to: w3 })).toBe('put it in W3 · Payout screens');
    expect(changeSentence({ field: 'wave', from: w3, to: null })).toBe('took it out of W3 · Payout screens');
    expect(changeSentence({ field: 'wave', from: gone, to: w3 })).toBe(
      'moved it from a removed wave to W3 · Payout screens',
    );
    expect(changeSentence({ field: 'wave', from: null, to: null })).toBe('took it out of its wave');
  });
});

describe('the offline queue and --wave', () => {
  it('queues a --wave change from the remembered plan and replays it', async () => {
    // Seen once: the plan names the waves and the milestone of PAY-180.
    await zamu(['milestones', 'show', 'Payouts v2']);
    down = true;
    const queued = await zamu(['tasks', 'update', 'PAY-180', '--wave', 'W3']);
    expect(queued.code, queued.stderr).toBe(CLI_EXIT_QUEUED);
    const out = await zamu(['tasks', 'update', 'PAY-190', '--no-wave', '--json']);
    expect(out.code).toBe(CLI_EXIT_QUEUED);
    expect(parseCliOutput(JSON.parse(out.stdout), 'queued').data.entry.summary).toBe('take out of its wave');
    const entries = await queueEntries();
    expect(entries.map((entry) => [entry.procedure, entry.taskKey, entry.input, entry.summary])).toEqual([
      ['tasks.update', 'PAY-180', { key: 'PAY-180', wave: waveIds.w3 }, 'put in W3 · Payout screens'],
      ['tasks.update', 'PAY-190', { key: 'PAY-190', wave: null }, 'take out of its wave'],
    ]);
    expect((await zamu(['queue'])).stdout).toContain('put in W3 · Payout screens');

    down = false;
    requests = [];
    const next = await zamu(['tasks', 'list', '--json']);
    expect(next.code, next.stderr).toBe(0);
    expect(writes().map((seen) => [seen.method, seen.path, seen.body])).toEqual([
      ['PATCH', '/tasks/PAY-180', { wave: waveIds.w3 }],
      ['PATCH', '/tasks/PAY-190', { wave: null }],
    ]);
    expect(next.stderr).toContain('Sent: PAY-180 put in W3 · Payout screens');
    expect(tasks.get('PAY-180')?.wave?.number).toBe(3);
    expect(await queueEntries()).toEqual([]);
  });

  it('applies the lock rule when the queue replays', async () => {
    await zamu(['tasks', 'show', 'PAY-180']);
    await zamu(['milestones', 'show', 'Payouts v2']);
    down = true;
    const queued = await zamu(['tasks', 'update', 'PAY-180', '--wave', 'rollout', '--status', 'in_progress']);
    expect(queued.code, queued.stderr).toBe(CLI_EXIT_QUEUED);
    down = false;
    const next = await zamu(['tasks', 'list', '--json']);
    expect(next.stderr).toMatch(
      /Dropped: PAY-180 move to In progress, put in W4 · Rollout \(queued .*\): .*wave_locked/,
    );
    expect(tasks.get('PAY-180')?.status).toBe('todo');
  });

  it("doesn't queue a --wave zamu can't look up, nor a wave command", async () => {
    down = true;
    const unknown = await zamu(['tasks', 'update', 'PAY-180', '--wave', 'W3']);
    expect(unknown.code).toBe(5);
    expect(unknown.stderr).toContain(
      "Nothing was queued: zamu hasn't seen the waves of PAY-180's milestone on this machine",
    );
    const pass = await zamu(['waves', 'pass', payoutsMilestoneId, 'W3', '--note', 'x']);
    expect(pass.code).toBe(5);
    expect(await queueEntries()).toEqual([]);
  });

  it('marks the wave field queueable and names it', () => {
    expect(queueability('tasks.update', { key: 'PAY-1', wave: waveIds.w3 })).toEqual({
      queueable: true,
      summary: 'put in a wave',
      status: null,
    });
    expect(queueability('tasks.update', { key: 'PAY-1', wave: null, status: 'todo' })).toMatchObject({
      queueable: true,
      summary: 'move to Todo, take out of its wave',
    });
    expect(
      queueability('tasks.update', { key: 'PAY-1', wave: waveIds.w3, milestone: payoutsMilestoneId }),
    ).toEqual({
      queueable: false,
      flags: ['--milestone'],
    });
    expect(summarize('tasks.update', { wave: waveIds.w3 }, 'W3 · Payout screens')).toBe(
      'put in W3 · Payout screens',
    );
    expect(queueability('waves.recordGate', { id: waveIds.w3 })).toBeNull();
  });
});

describe('zamu instructions planning and the help', () => {
  it('has the planning guide, the working lines and the overview entry', async () => {
    const planning = await zamu(['instructions', 'planning']);
    expect(planning.stdout).toBe(INSTRUCTIONS.planning);
    expect(INSTRUCTIONS.planning).toContain('zamu milestones update <milestone> --plan');
    expect(INSTRUCTIONS.planning).toContain('zamu waves add <milestone> "Ledger" --gate');
    expect(INSTRUCTIONS.planning).toContain('zamu waves put <milestone> W1');
    expect(INSTRUCTIONS.planning).toContain('zamu milestones show <milestone>');
    expect(INSTRUCTIONS.planning).toContain('Never take a task out of its wave');
    expect(INSTRUCTIONS.working).toContain("Check the task's wave before you start");
    expect(INSTRUCTIONS.working).toContain('record the');
    expect(INSTRUCTIONS.working).toContain('log each fix as a task in the same wave');
    expect(INSTRUCTIONS.overview).toContain('zamu instructions planning');
    expect(INSTRUCTIONS.overview).toContain('WAVE_LOCKED');
  });

  it('documents the commands and flags', async () => {
    const waves = (await zamu(['waves', '--help'])).stdout;
    for (const name of ['add', 'update', 'remove', 'put', 'pass', 'fail'])
      expect(waves).toMatch(new RegExp(`\\n  ${name} `));
    expect((await zamu(['tasks', 'update', '--help'])).stdout).toContain('--no-wave');
    const update = (await zamu(['milestones', 'update', '--help'])).stdout;
    expect(update).toContain('--plan <url-or-path>');
    expect(update).toContain('--no-plan');
    expect((await zamu(['milestones', 'show', '--help'])).stdout).toContain('what comes next');
    expect((await zamu(['--help'])).stdout).toContain(
      'WAVE_LOCKED: an agent started a task in a locked wave',
    );
  });
});

// Keeps the payouts fixture import honest: the plan's milestone is the fixture.
it('uses the Payouts v2 fixtures', () => {
  expect(wire(milestonePlanFixture.milestone)).toEqual(wire(payoutsMilestoneFixture));
});
