// M7 from the CLI, in-process against a fake server: zamu pr link and unlink, zamu tasks archive and
// restore, the check-again flags of zamu tasks update, the list flags --waiting, --ready-to-check and
// --archived, zamu tasks show and zamu projects show with requests, archive and check-again days, the
// history lines of git hosts and the archive job, the refusals with their messages and exit codes, and
// the offline queue for the new writes. The fake keeps PAY-142 (two requests, a check-again day),
// PAY-7 (archived), MIRR-786 (mirrored and archived) and answers like the contract says the API does.
import { mkdtemp, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import {
  type Activity,
  type ActivityChange,
  CLI_EXIT_QUEUED,
  type CliData,
  CliQueueFile,
  type CliResultName,
  type PullRequestLink,
  parseCliOutput,
  type Task,
} from '@zamu/contracts';
import {
  ana,
  archiveActivityFixture,
  archivedTaskFixture,
  gitActivityFixture,
  handLinkedPullRequestFixture,
  m7ListItemFixture,
  m7TaskFixture,
  noteFixture,
  projectWithCountsFixture,
  pullRequestLinkedActivityFixture,
  pullRequestLinkFixture,
  repositorySettingsFixture,
  taskListItemFixture,
  taskListPageFixture,
} from '@zamu/contracts/testing/fixtures';
import { beforeEach, describe, expect, it } from 'vitest';
import { resolveWaives } from '../src/commands/work';
import { activitySentence, changeSentence } from '../src/format';
import { INSTRUCTIONS } from '../src/instructions';
import type { CliIo, FetchLike } from '../src/io';
import { main } from '../src/main';
import { queueability } from '../src/queue';

const URL = 'http://zamu.test';
const KEY = 'zamu_live_m7m7m7m7m7m7m7m7m7m7';
const REPOSITORY = 'github.com/northwind/payments';

interface Seen {
  method: string;
  path: string;
  query: URLSearchParams;
  body: Record<string, unknown> | null;
}

/** JSON round trip: the fixtures hold Dates, the wire holds strings. */
const wire = <T = Record<string, unknown>>(value: unknown): T => JSON.parse(JSON.stringify(value)) as T;

const gitlabRequest = {
  ...wire<PullRequestLink>(handLinkedPullRequestFixture),
  provider: 'gitlab',
  number: 12,
  title: 'Ledger export',
  url: 'https://gitlab.example.com/northwind/payments/-/merge_requests/12',
  state: 'open',
} satisfies PullRequestLink;

const archivedTask = wire<Task>(archivedTaskFixture);
const mirroredTask: Task = {
  ...archivedTask,
  key: 'MIRR-786',
  project: { ...archivedTask.project, key: 'MIRR', name: 'Mirrored' },
  archivedBy: null,
  locked: ['status', 'title'],
};

let home: string;
let requests: Seen[];
let down: boolean;
let tasks: Map<string, Task>;

beforeEach(async () => {
  home = await mkdtemp(join(tmpdir(), 'zamu-cli-m7-'));
  requests = [];
  down = false;
  tasks = new Map<string, Task>([
    ['PAY-142', wire<Task>(m7TaskFixture)],
    ['PAY-7', { ...wire<Task>(archivedTaskFixture), key: 'PAY-7', number: 7 }],
    ['MIRR-786', mirroredTask],
  ]);
  return () => rm(home, { recursive: true, force: true });
});

function problem(
  status: number,
  code: string,
  detail: string,
  extra: Record<string, unknown> = {},
): Response {
  return Response.json({ type: 'about:blank', title: code, status, code, detail, ...extra }, { status });
}

function listItem(task: Task) {
  return {
    ...wire(taskListItemFixture),
    key: task.key,
    number: task.number,
    project: task.project,
    title: task.title,
    status: task.status,
    checkAgain: task.checkAgain ?? null,
    archivedAt: task.archivedAt ?? null,
  };
}

const timeline = [
  { ...wire(gitActivityFixture), kind: 'activity' },
  { ...wire(pullRequestLinkedActivityFixture), kind: 'activity' },
  { ...wire(archiveActivityFixture), kind: 'activity' },
];

function archivedRefusal(key: string): Response {
  return problem(409, 'TASK_ARCHIVED', `Task ${key} is archived; restore it first`);
}

/** The routes M7 adds, plus the reads zamu needs around them. */
const server: FetchLike = async (request) => {
  if (down) throw new TypeError('fetch failed', { cause: new Error('connect ECONNREFUSED 127.0.0.1:3000') });
  const url = new globalThis.URL(request.url);
  const path = url.pathname.replace(/^\/api\/v1/, '');
  const text = request.method === 'GET' || request.method === 'DELETE' ? '' : await request.text();
  const body = text ? (JSON.parse(text) as Record<string, unknown>) : null;
  requests.push({ method: request.method, path, query: url.searchParams, body });

  if (request.method === 'GET' && path === '/projects') {
    return Response.json({
      items: [
        { ...wire(projectWithCountsFixture), repository: `https://${REPOSITORY}`, archiveAfterDays: 14 },
        {
          ...wire(projectWithCountsFixture),
          key: 'WEB',
          name: 'Website',
          repository: null,
          archiveAfterDays: null,
        },
        {
          ...wire(projectWithCountsFixture),
          key: 'MIRR',
          name: 'Mirrored',
          repository: 'https://github.com/northwind/mirrored',
          archiveAfterDays: null,
          backlog: {
            mode: 'mirror',
            state: 'healthy',
            defaultBranch: 'main',
            lastReadAt: null,
            lastReadCommit: null,
            lastTrigger: null,
            problems: { files: 0, values: 0 },
            hidden: 0,
            detachedAt: null,
          },
        },
      ],
    });
  }
  const repository = /^\/projects\/([A-Z]+)\/repository$/.exec(path);
  if (repository && request.method === 'GET') {
    if (repository[1] === 'WEB') return problem(403, 'FORBIDDEN', 'Only owners and admins');
    if (repository[1] === 'MIRR') {
      return Response.json({ ...wire(repositorySettingsFixture), closeOnMerge: false, mirrored: true });
    }
    return Response.json(wire(repositorySettingsFixture));
  }
  if (request.method === 'GET' && path === '/tasks') {
    const items = [...tasks.values()].map(listItem);
    items[0] = { ...wire(m7ListItemFixture) };
    return Response.json({ ...wire(taskListPageFixture), items, nextCursor: null });
  }
  if (request.method === 'POST' && (path === '/tasks/archive' || path === '/tasks/restore')) {
    const keys = (body?.keys ?? []) as string[];
    const found = keys.map((key) => tasks.get(key));
    const missing = keys.find((_, i) => !found[i]);
    if (missing) return problem(404, 'NOT_FOUND', `No task ${missing}`);
    if (found.some((task) => task?.locked?.length)) {
      return problem(
        409,
        'TASK_MIRRORED',
        "MIRR-786 is mirrored from Backlog.md: its file's folder decides",
        {
          file: 'backlog/archive/tasks/back-786 - Retry.md',
        },
      );
    }
    const archiving = path === '/tasks/archive';
    const items = found.map((task) => {
      const next = { ...(task as Task), archivedAt: archiving ? '2026-11-26T10:00:00.000Z' : null };
      tasks.set(next.key, next);
      return listItem(next);
    });
    return Response.json({ items });
  }
  const route = /^\/tasks\/([A-Z]+-\d+)(?:\/(timeline|comments|pull-requests)(?:\/(\d+))?)?$/.exec(path);
  if (!route) return problem(404, 'NOT_FOUND', 'No such route');
  const [, key, part, number] = route as unknown as [string, string, string | undefined, string | undefined];
  const task = tasks.get(key);
  if (!task) return problem(404, 'NOT_FOUND', `No task ${key}`);
  if (!part && request.method === 'GET') return Response.json(task);
  if (part === 'timeline') {
    return Response.json({ items: timeline, counts: { all: 3, notes: 0, comments: 0, history: 3 } });
  }
  if (task.archivedAt) return archivedRefusal(key);
  if (!part && request.method === 'PATCH') {
    const next = { ...task } as Task;
    if (typeof body?.status === 'string') next.status = body.status as Task['status'];
    if (body && 'checkAgain' in body) next.checkAgain = body.checkAgain as Task['checkAgain'];
    tasks.set(key, next);
    return Response.json(next);
  }
  if (part === 'comments' && request.method === 'POST') {
    return Response.json({ ...wire(noteFixture), taskKey: key, body: body?.body }, { status: 201 });
  }
  if (part === 'pull-requests' && request.method === 'POST') {
    const address = String(body?.url ?? '');
    if (address.includes('/northwind/web/')) {
      return problem(
        422,
        'REQUEST_OTHER_REPOSITORY',
        `That request is in github.com/northwind/web, not ${REPOSITORY}`,
        {
          repository: REPOSITORY,
        },
      );
    }
    if (!/\/(pull|pulls|merge_requests)\/\d+/.test(address)) {
      return problem(422, 'NOT_A_REQUEST', 'That address is not a pull or merge request');
    }
    if (address.endsWith('/999')) return problem(404, 'REQUEST_NOT_FOUND', 'The host has no request 999');
    if (address.includes('gitlab')) return Response.json(gitlabRequest);
    return Response.json(wire(handLinkedPullRequestFixture));
  }
  if (part === 'pull-requests' && request.method === 'DELETE' && number) {
    if (!task.pullRequests?.some((linked) => linked.number === Number(number))) {
      return problem(404, 'REQUEST_NOT_FOUND', `${key} links no request ${number}`);
    }
    return new Response(null, { status: 204 });
  }
  return problem(404, 'NOT_FOUND', 'No such route');
};

interface RunResult {
  code: number;
  stdout: string;
  stderr: string;
}

async function zamu(args: string[], env: Record<string, string> = {}): Promise<RunResult> {
  const out: string[] = [];
  const err: string[] = [];
  const io: CliIo = {
    stdout: (text) => out.push(text),
    stderr: (text) => err.push(text),
    readStdin: async () => '',
    env: {
      XDG_CONFIG_HOME: join(home, 'config'),
      XDG_STATE_HOME: join(home, 'state'),
      ZAMU_URL: URL,
      ZAMU_KEY: KEY,
      ZAMU_MACHINE: 'laptop',
      ...env,
    },
    homeDir: home,
    cwd: home,
    isTTY: false,
    fetch: server,
  };
  const code = await main(args, io);
  return { code, stdout: out.join(''), stderr: err.join('') };
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

describe('zamu pr link', () => {
  it('links a request by hand and prints it, #482 on GitHub and !12 on GitLab', async () => {
    const linked = ok(
      await zamu(['pr', 'link', 'pay-142', 'https://github.com/northwind/payments/pull/479', '--json']),
      'pr.link',
    );
    expect(linked).toMatchObject({
      task: 'PAY-142',
      dryRun: false,
      pullRequest: { number: 479, how: 'hand' },
    });
    const post = writes().at(-1);
    expect(post).toMatchObject({ method: 'POST', path: '/tasks/PAY-142/pull-requests' });
    expect(post?.body).toEqual({ url: 'https://github.com/northwind/payments/pull/479' });

    const text = await zamu(['pr', 'link', 'PAY-142', 'https://github.com/northwind/payments/pull/479']);
    expect(text.code, text.stderr).toBe(0);
    expect(text.stdout).toBe(
      'Linked #479 to PAY-142\n' +
        '  #479  Draft: backoff table (Draft, linked by hand by Ana Ruiz)\n' +
        '  https://github.com/northwind/payments/pull/479\n',
    );
    const gitlab = await zamu(['pr', 'link', 'PAY-142', gitlabRequest.url]);
    expect(gitlab.stdout).toMatch(/^Linked !12 to PAY-142\n {2}!12 {2}Ledger export \(Open, /);
  });

  it('previews with --dry-run: dryRun goes to the server and the output says nothing was written', async () => {
    const url = 'https://github.com/northwind/payments/pull/479';
    const preview = ok(await zamu(['pr', 'link', 'PAY-142', url, '--dry-run', '--json']), 'pr.link');
    expect(preview.dryRun).toBe(true);
    expect(writes().at(-1)?.body).toEqual({ url, dryRun: true });
    const text = await zamu(['pr', 'link', 'PAY-142', url, '--dry-run']);
    expect(text.stdout).toMatch(
      /^Would link #479 to PAY-142; nothing was written\. Run it again without --dry-run/,
    );
  });

  it('refuses another repository, an address that is not a request and an unknown request', async () => {
    const other = failed(
      await zamu(['pr', 'link', 'PAY-142', 'https://github.com/northwind/web/pull/3', '--json']),
      1,
      'REQUEST_OTHER_REPOSITORY',
    );
    expect(other.repository).toBe(REPOSITORY);
    const otherText = await zamu(['pr', 'link', 'PAY-142', 'https://github.com/northwind/web/pull/3']);
    expect(otherText.code).toBe(1);
    expect(otherText.stderr).toContain(`The project links ${REPOSITORY}: link a request of that repository.`);

    failed(
      await zamu(['pr', 'link', 'PAY-142', 'https://github.com/northwind/payments/issues/5', '--json']),
      1,
      'NOT_A_REQUEST',
    );
    const notRequest = await zamu([
      'pr',
      'link',
      'PAY-142',
      'https://github.com/northwind/payments/issues/5',
    ]);
    expect(notRequest.stderr).toContain('That address is not a pull or merge request');
    expect(notRequest.stderr).toContain(
      'GitLab   https://gitlab.example.com/northwind/payments/-/merge_requests/12',
    );

    failed(
      await zamu(['pr', 'link', 'PAY-142', 'https://github.com/northwind/payments/pull/999', '--json']),
      3,
      'REQUEST_NOT_FOUND',
    );
    const unknown = await zamu(['pr', 'link', 'PAY-142', 'https://github.com/northwind/payments/pull/999']);
    expect(unknown.code).toBe(3);
    expect(unknown.stderr).toContain("The host doesn't know that request");
  });

  it('checks the address form before any request', async () => {
    const bad = failed(await zamu(['pr', 'link', 'PAY-142', 'not an address', '--json']), 1, 'BAD_REQUEST');
    expect(bad.issues?.[0]?.message).toContain('https://');
    expect(requests).toHaveLength(0);
  });

  it('refuses an archived task with the command that restores it', async () => {
    const url = 'https://github.com/northwind/payments/pull/479';
    failed(await zamu(['pr', 'link', 'PAY-7', url, '--json']), 1, 'TASK_ARCHIVED');
    const text = await zamu(['pr', 'link', 'PAY-7', url]);
    expect(text.code).toBe(1);
    expect(text.stderr).toBe('zamu: PAY-7 is archived. Restore it first: zamu tasks restore PAY-7\n');
  });
});

describe('zamu pr unlink', () => {
  it('removes a link by number, #482 and !12 as typed too', async () => {
    const removed = ok(await zamu(['pr', 'unlink', 'PAY-142', '482', '--json']), 'pr.unlink');
    expect(removed).toEqual({ task: 'PAY-142', number: 482 });
    expect(writes().at(-1)).toMatchObject({ method: 'DELETE', path: '/tasks/PAY-142/pull-requests/482' });
    const text = await zamu(['pr', 'unlink', 'PAY-142', '#482']);
    expect(text.code, text.stderr).toBe(0);
    expect(text.stdout).toBe(
      `Unlinked #482 "${pullRequestLinkFixture.title}" from PAY-142. Its branch or a Closes: line won't link it again; zamu pr link does.\n`,
    );
  });

  it('refuses a number the task does not link, and a number that is not one', async () => {
    failed(await zamu(['pr', 'unlink', 'PAY-142', '12', '--json']), 3, 'REQUEST_NOT_FOUND');
    const text = await zamu(['pr', 'unlink', 'PAY-142', '12']);
    expect(text.stderr).toContain('zamu tasks show PAY-142 lists the requests it links.');
    requests = [];
    failed(await zamu(['pr', 'unlink', 'PAY-142', 'abc', '--json']), 1, 'BAD_REQUEST');
    expect(requests).toHaveLength(0);
  });
});

describe('zamu tasks archive and restore', () => {
  it('archives and restores several tasks, all in one request', async () => {
    const archived = ok(
      await zamu(['tasks', 'archive', 'PAY-142', 'pay-7,PAY-142', '--json']),
      'tasks.archive',
    );
    expect(archived.items.map((item) => [item.key, item.archivedAt])).toEqual([
      ['PAY-142', '2026-11-26T10:00:00.000Z'],
      ['PAY-7', '2026-11-26T10:00:00.000Z'],
    ]);
    expect(writes()).toEqual([
      expect.objectContaining({
        method: 'POST',
        path: '/tasks/archive',
        body: { keys: ['PAY-142', 'PAY-7'] },
      }),
    ]);
    const restored = await zamu(['tasks', 'restore', 'PAY-142', 'PAY-7']);
    expect(restored.code, restored.stderr).toBe(0);
    expect(restored.stdout).toMatch(
      /^Restored 2 tasks\.\n {2}PAY-142 {2}.+ \(In review\)\n {2}PAY-7 {2}.+ \(Done\)\n$/,
    );
    const again = await zamu(['tasks', 'archive', 'PAY-7']);
    expect(again.stdout).toMatch(
      /^Archived 1 task\. Archived tasks are read-only .*zamu tasks restore PAY-7 brings/,
    );
  });

  it('refuses mirrored tasks with the Backlog.md exit code, and bad keys before any request', async () => {
    failed(await zamu(['tasks', 'archive', 'MIRR-786', '--json']), 6, 'TASK_MIRRORED');
    requests = [];
    failed(await zamu(['tasks', 'restore', 'not-a-key', '--json']), 1, 'BAD_REQUEST');
    expect(requests).toHaveLength(0);
  });

  it('names the archive in every refused write, and the Backlog.md folder for a mirrored task', async () => {
    failed(await zamu(['tasks', 'update', 'PAY-7', '--status', 'todo', '--json']), 1, 'TASK_ARCHIVED');
    const update = await zamu(['tasks', 'update', 'PAY-7', '--status', 'todo']);
    expect(update.code).toBe(1);
    expect(update.stderr).toBe('zamu: PAY-7 is archived. Restore it first: zamu tasks restore PAY-7\n');
    const note = await zamu(['notes', 'add', 'PAY-7', 'Looked again']);
    expect(note.code).toBe(1);
    expect(note.stderr).toBe('zamu: PAY-7 is archived. Restore it first: zamu tasks restore PAY-7\n');
    const mirrored = await zamu(['comments', 'add', 'MIRR-786', 'Still needed?']);
    expect(mirrored.stderr).toBe(
      'zamu: MIRR-786 is archived: its Backlog.md file is under archive/tasks/.\n' +
        '  Move the file back to tasks/ and push to restore it.\n',
    );
  });
});

describe('zamu tasks update --check-again', () => {
  it('sends the day with its reason, and clears it with --no-check-again', async () => {
    const set = ok(
      await zamu([
        'tasks',
        'update',
        'PAY-142',
        '--check-again',
        '2026-12-03',
        '--reason',
        'Bank answers',
        '--json',
      ]),
      'tasks.update',
    );
    expect(set.checkAgain).toEqual({ on: '2026-12-03', reason: 'Bank answers' });
    expect(writes().at(-1)?.body).toEqual({ checkAgain: { on: '2026-12-03', reason: 'Bank answers' } });

    // The reason may come first, and pairs with a waive and the day alike.
    await zamu(['tasks', 'update', 'PAY-142', '--reason', 'Vendor', '--check-again', '2026-12-04']);
    expect(writes().at(-1)?.body).toEqual({ checkAgain: { on: '2026-12-04', reason: 'Vendor' } });

    const text = await zamu([
      'tasks',
      'update',
      'PAY-142',
      '--check-again',
      '2026-12-05',
      '--reason',
      'Vendor',
    ]);
    expect(text.stdout).toMatch(/\nCheck again {2}2026-12-05: Vendor\n/);

    const cleared = ok(
      await zamu(['tasks', 'update', 'PAY-142', '--no-check-again', '--json']),
      'tasks.update',
    );
    expect(cleared.checkAgain).toBeNull();
    expect(writes().at(-1)?.body).toEqual({ checkAgain: null });
  });

  it('refuses a day without a reason, both flags, a reason alone and a bad day, sending nothing', async () => {
    const noReason = failed(
      await zamu(['tasks', 'update', 'PAY-142', '--check-again', '2026-12-03', '--json']),
      1,
      'BAD_REQUEST',
    );
    expect(noReason.detail).toBe(
      '--check-again 2026-12-03 needs a reason: add --reason "what you are waiting for".',
    );
    const both = failed(
      await zamu([
        'tasks',
        'update',
        'PAY-142',
        '--check-again',
        '2026-12-03',
        '--reason',
        'x',
        '--no-check-again',
        '--json',
      ]),
      1,
      'BAD_REQUEST',
    );
    expect(both.detail).toBe('Use either --check-again or --no-check-again, not both.');
    const alone = failed(
      await zamu(['tasks', 'update', 'PAY-142', '--reason', 'x', '--json']),
      1,
      'BAD_REQUEST',
    );
    expect(alone.detail).toBe('--reason goes with --check-again DAY, --waive-ac N or --waive-dod N.');
    const day = failed(
      await zamu(['tasks', 'update', 'PAY-142', '--check-again', '12/03', '--reason', 'x', '--json']),
      1,
      'BAD_REQUEST',
    );
    expect(day.issues?.[0]?.path).toBe('checkAgain.on');
    failed(
      await zamu([
        'tasks',
        'update',
        'PAY-142',
        '--check-again',
        '2026-12-03',
        '--reason',
        'x'.repeat(201),
        '--json',
      ]),
      1,
      'BAD_REQUEST',
    );
    const human = await zamu(['tasks', 'update', 'PAY-142', '--check-again', '2026-12-03']);
    expect(human.code).toBe(1);
    expect(human.stderr).toContain('zamu: --check-again 2026-12-03 needs a reason');
    expect(requests).toHaveLength(0);
  });
});

describe('zamu tasks list with the M7 filters', () => {
  it('sends checkAgain and archived, and refuses --waiting with --ready-to-check', async () => {
    await zamu(['tasks', 'list', '--waiting', '--json']);
    expect(requests.at(-1)?.query.get('checkAgain')).toBe('waiting');
    await zamu(['tasks', 'list', '--ready-to-check', '--archived', 'include', '--json']);
    expect(requests.at(-1)?.query.get('checkAgain')).toBe('ready');
    expect(requests.at(-1)?.query.get('archived')).toBe('include');
    await zamu(['tasks', 'list', '--archived', 'Only', '--json']);
    expect(requests.at(-1)?.query.get('archived')).toBe('only');
    await zamu(['tasks', 'list', '--json']);
    expect(requests.at(-1)?.query.has('archived')).toBe(false);
    requests = [];
    const both = failed(
      await zamu(['tasks', 'list', '--waiting', '--ready-to-check', '--json']),
      1,
      'BAD_REQUEST',
    );
    expect(both.detail).toBe('Use either --waiting or --ready-to-check, not both.');
    failed(await zamu(['tasks', 'list', '--archived', 'sometimes', '--json']), 1, 'BAD_REQUEST');
    expect(requests).toHaveLength(0);
  });

  it('shows the check-again day, the newest request and the archive date as columns', async () => {
    const page = ok(await zamu(['tasks', 'list', '--archived', 'include', '--json']), 'tasks.list');
    expect(page.items[0]).toMatchObject({ pullRequest: { number: 482, state: 'open' }, pullRequestCount: 2 });
    const text = await zamu(['tasks', 'list', '--archived', 'include']);
    const [header, first, archived] = text.stdout.split('\n');
    expect(header).toMatch(/CHECK AGAIN +REQUEST +ARCHIVED +TITLE/);
    expect(first).toMatch(/2026-12-01 +#482 Open \+1 /);
    expect(archived).toMatch(/ 2026-11-24 /);
  });
});

describe('zamu tasks show with M7 fields', () => {
  it('lists the branch, the requests, the check-again day and the history of hosts and jobs', async () => {
    const shown = ok(await zamu(['tasks', 'show', 'PAY-142', '--json']), 'tasks.show');
    expect(shown.task).toMatchObject({
      workBranch: 'feat/webhook-retries',
      checkAgain: m7TaskFixture.checkAgain,
    });
    expect(shown.task.pullRequests?.map((request) => request.number)).toEqual([482, 479]);
    expect(shown.activity.map((entry) => entry.system?.kind ?? null)).toEqual(['git', null, 'zamu']);

    const text = (await zamu(['tasks', 'show', 'PAY-142'])).stdout;
    expect(text).toContain("\nCheck again  2026-12-01: Wait for the bank's answer on retries\n");
    expect(text).toContain(
      [
        'Branch       feat/webhook-retries',
        'Requests     #482  Retry failed webhook deliveries (Open, started on feat/webhook-retries)',
        '             https://github.com/northwind/payments/pull/482',
        '             #479  Draft: backoff table (Draft, linked by hand by Ana Ruiz)',
        '             https://github.com/northwind/payments/pull/479',
      ].join('\n'),
    );
    expect(text).toContain('GitHub moved this to In review · #482 opened by claude-dev\n');
    expect(text).toContain('Ana Ruiz linked #479 "Draft: backoff table"\n');
    expect(text).toContain('Zamu archived this 14 days after it closed\n');
  });

  it('marks an archived task merged with open criteria', async () => {
    const text = (await zamu(['tasks', 'show', 'PAY-7'])).stdout;
    expect(text).toMatch(/\nFlag +Merged with 1 open criterion \(2026-11-22 12:00\)\n/);
    expect(text).toContain(
      '\nArchived   2026-11-24 08:00 by Ana Ruiz · read-only until restored: zamu tasks restore PAY-7\n',
    );
    expect(text).toContain('(Merged, started on feat/webhook-retries)');
  });
});

describe('zamu projects show', () => {
  it('prints the repository settings and the archive days, in text and --json', async () => {
    const shown = ok(await zamu(['projects', 'show', 'PAY', '--json']), 'projects.show');
    expect(shown.project).toMatchObject({ key: 'PAY', archiveAfterDays: 14 });
    expect(shown.repository).toMatchObject({ closeOnMerge: true, defaultBranch: 'main' });
    const text = (await zamu(['projects', 'show'], { ZAMU_PROJECT: 'PAY' })).stdout;
    expect(text).toBe(
      [
        'PAY  Payments',
        'Open tasks      12 · Backlog 3 · Todo 4 · In progress 3 · In review 2',
        `Repository      ${REPOSITORY} (GitHub)`,
        'Reads with      Northwind GitHub (Working)',
        'Default branch  main',
        'Close on merge  on: a merge into main moves its tasks to Done',
        'Webhook         last event 2026-11-26 08:40',
        '                https://zamu.example.com/api/webhooks/repository/wh_4kQz9vX2',
        'Hourly check    last 2026-11-26 08:45 · next 2026-11-26 09:45',
        'Archive         Done and Canceled tasks, 14 days after they close',
        '',
      ].join('\n'),
    );
  });

  it('shows what it can without the repository settings, and the mirror rules', async () => {
    const web = ok(await zamu(['projects', 'show', 'WEB', '--json']), 'projects.show');
    expect(web.repository).toBeNull();
    const webText = (await zamu(['projects', 'show', 'WEB'])).stdout;
    expect(webText).toContain('Repository  none (zamu link sets one from a clone)\n');
    expect(webText).toContain('Archive     off\n');
    const mirrored = (await zamu(['projects', 'show', 'MIRR'])).stdout;
    expect(mirrored).toContain('Close on merge  off: the Backlog.md files own the status\n');
    expect(mirrored).toContain("Archive         follows Backlog.md's archive/tasks/ folder\n");
    failed(await zamu(['projects', 'show', 'NOPE', '--json']), 3, 'NOT_FOUND');
  });
});

describe('the offline queue and the M7 writes', () => {
  it('queues an archive and a check-again day, and replays both in order', async () => {
    // Seen once, so a later status change could be queued too.
    await zamu(['tasks', 'show', 'PAY-142', '--json']);
    down = true;
    const archived = await zamu(['tasks', 'archive', 'PAY-142', 'PAY-7']);
    expect(archived.code).toBe(CLI_EXIT_QUEUED);
    const waiting = await zamu([
      'tasks',
      'update',
      'PAY-7',
      '--check-again',
      '2026-12-03',
      '--reason',
      'Bank',
    ]);
    expect(waiting.code).toBe(CLI_EXIT_QUEUED);
    const entries = await queueEntries();
    expect(entries.map((entry) => [entry.procedure, entry.taskKey, entry.project, entry.summary])).toEqual([
      ['tasks.archive', 'PAY-142', 'PAY', 'archive PAY-142, PAY-7'],
      ['tasks.update', 'PAY-7', 'PAY', 'check again 2026-12-03'],
    ]);
    const listed = await zamu(['queue']);
    expect(listed.stdout).toContain('archive PAY-142, PAY-7');

    down = false;
    tasks.set('PAY-7', { ...(tasks.get('PAY-7') as Task), archivedAt: null });
    requests = [];
    const next = await zamu(['tasks', 'list', '--json']);
    expect(next.code, next.stderr).toBe(0);
    expect(writes().map((seen) => [seen.method, seen.path, seen.body])).toEqual([
      ['POST', '/tasks/archive', { keys: ['PAY-142', 'PAY-7'] }],
      ['PATCH', '/tasks/PAY-7', { checkAgain: { on: '2026-12-03', reason: 'Bank' } }],
    ]);
    // The archive went first, so the check-again write met an archived task and was dropped.
    expect(next.stderr).toContain('Sent: PAY-142 archive PAY-142, PAY-7');
    expect(next.stderr).toContain('Dropped: PAY-7 check again 2026-12-03');
    expect(await queueEntries()).toEqual([]);
  });

  it('queues links and unlinks, but not a dry run', async () => {
    down = true;
    const url = 'https://github.com/northwind/payments/pull/479';
    expect((await zamu(['pr', 'link', 'PAY-142', url])).code).toBe(CLI_EXIT_QUEUED);
    expect((await zamu(['pr', 'unlink', 'PAY-142', '482'])).code).toBe(CLI_EXIT_QUEUED);
    const preview = await zamu(['pr', 'link', 'PAY-142', url, '--dry-run']);
    expect(preview.code).toBe(5);
    expect(preview.stderr).toContain("Nothing was queued: --dry-run can't wait for the server.");
    expect((await queueEntries()).map((entry) => entry.summary)).toEqual([
      `link request ${url}`,
      'unlink request 482',
    ]);
    down = false;
    requests = [];
    const next = await zamu(['tasks', 'show', 'PAY-142', '--json']);
    expect(next.code, next.stderr).toBe(0);
    expect(writes().map((seen) => [seen.method, seen.path])).toEqual([
      ['POST', '/tasks/PAY-142/pull-requests'],
      ['DELETE', '/tasks/PAY-142/pull-requests/482'],
    ]);
    expect(await queueEntries()).toEqual([]);
  });
});

describe('what the M7 writes queue as', () => {
  it('queues check-again days, archive, restore, links and unlinks, and names them', () => {
    expect(
      queueability('tasks.update', { key: 'PAY-1', checkAgain: { on: '2026-12-03', reason: 'x' } }),
    ).toEqual({
      queueable: true,
      summary: 'check again 2026-12-03',
      status: null,
    });
    expect(queueability('tasks.update', { key: 'PAY-1', checkAgain: null, status: 'todo' })).toEqual({
      queueable: true,
      summary: 'move to Todo, clear the check-again day',
      status: 'todo',
    });
    expect(queueability('tasks.restore', { keys: ['PAY-1', 'PAY-2'] })).toMatchObject({
      queueable: true,
      summary: 'restore PAY-1, PAY-2',
    });
    expect(queueability('pullRequests.unlink', { key: 'PAY-1', number: 12 })).toMatchObject({
      summary: 'unlink request 12',
    });
    expect(
      queueability('pullRequests.link', { key: 'PAY-1', url: 'https://x.test/a/b/pull/1', dryRun: true }),
    ).toEqual({
      queueable: false,
      flags: ['--dry-run'],
    });
    expect(queueability('repository.sync', { project: 'PAY' })).toBeNull();
  });
});

describe('M7 history sentences', () => {
  const base: Activity = { ...wire<Activity>(gitActivityFixture), cause: null, system: null, origin: 'app' };
  const sentence = (change: ActivityChange) => changeSentence(change);

  it('phrases the work branch, the check-again day and request links', () => {
    expect(sentence({ field: 'workBranch', from: null, to: 'feat/a' })).toBe('started it on branch feat/a');
    expect(sentence({ field: 'workBranch', from: 'feat/a', to: 'feat/b' })).toBe('moved it to branch feat/b');
    expect(sentence({ field: 'workBranch', from: 'feat/a', to: null })).toBe('cleared the work branch');
    const day = { on: '2026-12-03', reason: 'Bank answers' };
    expect(sentence({ field: 'checkAgain', from: null, to: day })).toBe(
      'set check again to 2026-12-03: Bank answers',
    );
    expect(sentence({ field: 'checkAgain', from: day, to: { ...day, on: '2026-12-04' } })).toBe(
      'changed check again to 2026-12-04: Bank answers',
    );
    expect(sentence({ field: 'checkAgain', from: day, to: null })).toBe('cleared the check-again day');
    const request = {
      provider: 'gitlab',
      number: 12,
      title: 'Ledger export',
      url: gitlabRequest.url,
    } as const;
    expect(sentence({ field: 'pullRequest', from: null, to: { ...request, how: 'description' } })).toBe(
      'linked !12 "Ledger export" (named on a Closes: line)',
    );
    expect(sentence({ field: 'pullRequest', from: { ...request, how: 'hand' }, to: null })).toBe(
      'unlinked !12 "Ledger export"',
    );
  });

  it('names the host, Zamu and Backlog.md when no one acted', () => {
    const merged = {
      ...base,
      actor: null,
      origin: 'git',
      system: { kind: 'git', provider: 'gitea' },
      changes: [{ field: 'status', from: 'in_review', to: 'done' }],
      cause: {
        kind: 'pull_request',
        provider: 'gitea',
        number: 31,
        title: 'Ledger',
        url: 'https://forgejo.example.com/northwind/payments/pulls/31',
        event: 'merged',
        by: null,
      },
    } as Activity;
    expect(activitySentence(merged)).toBe('Forgejo moved this to Done · #31 merged');
    const ready = {
      ...merged,
      system: null,
      changes: [{ field: 'status', from: 'in_progress', to: 'in_review' }],
      cause: { ...merged.cause, provider: 'gitlab', number: 12, event: 'ready', by: 'ana' },
    } as Activity;
    expect(activitySentence(ready)).toBe('GitLab moved this to In review · !12 marked ready by ana');
    const job = {
      ...base,
      actor: null,
      type: 'task.archived',
      changes: [],
      cause: { kind: 'archive', afterDays: 1 },
    };
    expect(activitySentence(job as Activity)).toBe('Zamu archived this 1 day after it closed');
    const byHand = { ...base, actor: ana, type: 'task.archived', changes: [] } as Activity;
    expect(activitySentence(byHand)).toBe('Ana Ruiz archived the task');
    const file = {
      ...base,
      actor: null,
      origin: 'backlog',
      originRef: 'a1b2c3d4e5',
      type: 'task.unarchived',
      changes: [],
    } as Activity;
    expect(activitySentence(file)).toBe(
      'Backlog.md restored the task from the archive: its file left archive/tasks/ (a1b2c3d)',
    );
    // A null actor without a cause is one of Zamu's jobs (it read "System" before M7).
    const closed = {
      ...base,
      actor: null,
      changes: [{ field: 'checkAgain', from: { on: '2026-12-03', reason: 'x' }, to: null }],
    } as Activity;
    expect(activitySentence(closed)).toBe('Zamu cleared the check-again day');
  });

  it('pairs --reason with the check-again day and the waives around it', () => {
    expect(
      resolveWaives([
        { type: 'waive', kind: 'criterion', number: 2 },
        { type: 'checkAgain', day: '2026-12-03' },
        { type: 'reason', text: 'Vendor' },
      ]),
    ).toEqual({
      criteria: [{ number: 2, reason: 'Vendor' }],
      done: [],
      checkAgain: { on: '2026-12-03', reason: 'Vendor' },
    });
    expect(resolveWaives([{ type: 'noCheckAgain' }])).toEqual({ criteria: [], done: [], checkAgain: null });
    expect(() =>
      resolveWaives([
        { type: 'checkAgain', day: '2026-12-03' },
        { type: 'checkAgain', day: '2026-12-04' },
        { type: 'reason', text: 'x' },
      ]),
    ).toThrow('Give --check-again once');
  });
});

describe('zamu instructions for M7', () => {
  it('tells agents about the work branch, Closes:, the merge and check-again days', () => {
    expect(INSTRUCTIONS.working).toContain('from the git branch you will work on');
    expect(INSTRUCTIONS.working).toContain('"Closes: KEY-1, KEY-2"');
    expect(INSTRUCTIONS.working).toContain('--check-again 2026-12-03 --reason');
    expect(INSTRUCTIONS.finishing).toContain('stop at In review: merging the pull');
  });

  it('documents the new commands and flags in --help', async () => {
    const pr = await zamu(['pr', 'link', '--help']);
    expect(pr.stdout).toContain('--dry-run');
    const update = await zamu(['tasks', 'update', '--help']);
    expect(update.stdout).toContain('--check-again <day>');
    expect(update.stdout).toContain('--no-check-again');
    const list = await zamu(['tasks', 'list', '--help']);
    expect(list.stdout).toMatch(/--waiting[\s\S]+--ready-to-check[\s\S]+--archived <which>/);
    expect((await zamu(['tasks', 'archive', '--help'])).stdout).toContain('all or nothing');
    expect((await zamu(['projects', 'show', '--help'])).stdout).toContain('archive setting');
  });
});
