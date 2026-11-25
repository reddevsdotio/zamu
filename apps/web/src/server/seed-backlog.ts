// Dev seed, M3: the mirrored demo project "Payments API" (key BACK). Its Backlog.md folder lives in
// this file and is served by an in-memory git provider, so the seed needs no git host and no test
// code. Everything else goes through @zamu/core like real use: createConnection (the token check runs
// against the in-memory provider), detectBacklog for the prefilled mappings, startBacklog, then two
// refreshes of the real engine: the first read, and a second commit that changes a status, removes
// a file (hidden task), adds a status with no mapping and a file that does not parse (warnings).
//
// The connection points at gitlab.example.com with a fake token, so when the worker later refreshes
// the source for real (the hourly poll, Refresh now) the mirror ends paused. That is expected.
import { createHash } from 'node:crypto';
import {
  type Actor,
  type CoreContext,
  createConnection,
  createProject,
  detectBacklog,
  type JobQueue,
  type ProviderFactory,
  refreshBacklogSource,
  startBacklog,
} from '@zamu/core';

type GitProvider = ReturnType<ProviderFactory>;
type TreeEntry = Awaited<ReturnType<GitProvider['listTree']>>[number];

export const BACKLOG_SEED = {
  projectKey: 'BACK',
  projectName: 'Payments API',
  host: 'gitlab.example.com',
  repositoryPath: 'reddevs/payments-api',
  connectionName: 'GitLab (demo)',
  /** Fake, never sent anywhere: the in-memory provider ignores it. */
  token: 'glpat-demo-seed-token-0000',
} as const;

const FOLDER = 'backlog';

// ---------------------------------------------------------------------------
// The demo folder
// ---------------------------------------------------------------------------

interface DemoTask {
  id: string;
  title: string;
  status: string;
  assignee?: string[];
  priority?: string;
  labels?: string[];
  milestone?: string;
  dependencies?: string[];
  parent?: string;
  ordinal?: number;
  created: string;
  updated?: string;
  due?: string;
  type?: string;
  references?: string[];
  description: string;
  acceptance?: { text: string; done: boolean }[];
  plan?: string;
  notes?: string;
}

function list(key: string, values: string[] | undefined): string[] {
  if (!values || values.length === 0) return [`${key}: []`];
  return [`${key}:`, ...values.map((value) => `  - '${value}'`)];
}

function taskFile(task: DemoTask): string {
  const lines = ['---', `id: ${task.id}`, `title: ${JSON.stringify(task.title)}`, `status: ${task.status}`];
  lines.push(...list('assignee', task.assignee));
  lines.push(`created_date: '${task.created}'`);
  if (task.updated) lines.push(`updated_date: '${task.updated}'`);
  if (task.due) lines.push(`due_date: '${task.due}'`);
  lines.push(...list('labels', task.labels));
  if (task.milestone) lines.push(`milestone: ${task.milestone}`);
  lines.push(...list('dependencies', task.dependencies));
  if (task.references) lines.push(...list('references', task.references));
  if (task.parent) lines.push(`parent_task_id: ${task.parent}`);
  if (task.priority) lines.push(`priority: ${task.priority}`);
  if (task.type) lines.push(`type: ${task.type}`);
  if (task.ordinal !== undefined) lines.push(`ordinal: ${task.ordinal}`);
  lines.push('---', '', '## Description', '', '<!-- SECTION:DESCRIPTION:BEGIN -->', task.description);
  lines.push('<!-- SECTION:DESCRIPTION:END -->', '');
  if (task.acceptance) {
    lines.push('## Acceptance Criteria', '<!-- AC:BEGIN -->');
    task.acceptance.forEach((item, index) => {
      lines.push(`- [${item.done ? 'x' : ' '}] #${index + 1} ${item.text}`);
    });
    lines.push('<!-- AC:END -->', '');
  }
  if (task.plan) {
    lines.push(
      '## Implementation Plan',
      '',
      '<!-- SECTION:PLAN:BEGIN -->',
      task.plan,
      '<!-- SECTION:PLAN:END -->',
      '',
    );
  }
  if (task.notes) {
    lines.push(
      '## Implementation Notes',
      '',
      '<!-- SECTION:NOTES:BEGIN -->',
      task.notes,
      '<!-- SECTION:NOTES:END -->',
      '',
    );
  }
  return lines.join('\n');
}

function taskPath(kind: 'tasks' | 'drafts' | 'archive/tasks', id: string, title: string): string {
  return `${FOLDER}/${kind}/${id.toLowerCase()} - ${title.replace(/[^A-Za-z0-9]+/g, '-').replace(/-+$/, '')}.md`;
}

const CONFIG = [
  'project_name: "Payments API"',
  'default_status: "To Do"',
  'statuses: ["To Do", "In Progress", "Review", "Done"]',
  'labels: ["webhooks", "refunds", "sync"]',
  'date_format: yyyy-mm-dd hh:mm',
  'task_prefix: "back"',
  '',
].join('\n');

const MILESTONES: Record<string, string> = {
  [`${FOLDER}/milestones/m-1 - webhooks-v2.md`]: [
    '---',
    'id: m-1',
    'title: "Webhooks v2"',
    'due_date: 2026-12-15',
    '---',
    '',
    '## Description',
    '',
    'Reliable delivery: retries, signed payloads, a delivery log merchants can read.',
    '',
  ].join('\n'),
  [`${FOLDER}/milestones/m-2 - backlog-mirror.md`]: [
    '---',
    'id: m-2',
    'title: "Backlog mirror"',
    '---',
    '',
    '## Description',
    '',
    'Read the backlog/ folder into the project management app.',
    '',
  ].join('\n'),
};

const TASKS: (DemoTask & { kind?: 'tasks' | 'drafts' | 'archive/tasks' })[] = [
  {
    id: 'BACK-786',
    title: 'Mirror Backlog.md into the app',
    status: 'In Progress',
    assignee: ['@claude-dev', '@ana'],
    priority: 'high',
    labels: ['sync'],
    milestone: 'm-2',
    dependencies: ['BACK-780', 'BACK-999'],
    created: '2026-10-21T14:26:00Z',
    updated: '2026-10-22T08:05:00Z',
    due: '2026-11-15',
    type: 'feature',
    references: ['https://github.com/MrLesk/Backlog.md'],
    ordinal: 1000,
    description: 'Read the backlog/ folder on the default branch and keep the project in step with it.',
    acceptance: [
      { text: 'Tasks appear with their Backlog.md numbers', done: true },
      { text: 'A push refreshes the project within seconds', done: false },
    ],
    plan: '1. Parse the folder\n2. Plan the difference\n3. Apply it in one transaction',
  },
  {
    id: 'BACK-786.1',
    title: 'Parse the folder',
    status: 'Done',
    assignee: ['@claude-dev'],
    priority: 'medium',
    parent: 'BACK-786',
    milestone: 'm-2',
    created: '2026-10-21T15:10:00Z',
    ordinal: 1100,
    description: 'Config, tasks, drafts, archive and milestones, in every format era.',
  },
  {
    id: 'BACK-786.1.2',
    title: 'Accept two-digit years in created_date',
    status: 'To Do',
    parent: 'BACK-786.1',
    created: '2026-10-22T09:00:00Z',
    ordinal: 1200,
    description: 'DD-MM-YY, DD/MM/YY and DD.MM.YY, read as UTC.',
  },
  {
    id: 'BACK-780',
    title: 'Retry failed webhook deliveries with backoff',
    status: 'Review',
    assignee: ['@ana'],
    priority: 'high',
    labels: ['webhooks'],
    milestone: 'm-1',
    created: '2026-10-12 09:30',
    ordinal: 2000,
    description: 'Six attempts over a day; 4xx stops retrying except 408 and 429.',
    notes: 'Retry-After is honoured for 429.',
  },
  {
    id: 'BACK-781',
    title: 'Sign webhook payloads with a timestamp',
    status: 'To Do',
    assignee: ['@claude-dev'],
    priority: 'medium',
    labels: ['webhooks'],
    milestone: 'm-1',
    created: '2026-10-13 11:00',
    ordinal: 3000,
    description: 'Add t= to the signature header and reject payloads older than five minutes.',
  },
  {
    id: 'BACK-782',
    title: 'Partial refunds round to the wrong cent across currencies',
    status: 'To Do',
    priority: 'low',
    labels: ['refunds'],
    created: '2026-10-14 16:45',
    ordinal: 4000,
    description: 'Happens when the invoice currency differs from the account currency.',
  },
  {
    id: 'BACK-783',
    title: 'Delivery log page for merchants',
    status: 'To Do',
    assignee: ['@sam'],
    labels: ['webhooks'],
    milestone: 'm-1',
    created: '2026-10-15 10:00',
    description: 'List the last 100 deliveries with status, attempts and response code.',
  },
  {
    id: 'BACK-12',
    title: 'Remove the v0 webhook endpoint',
    status: 'Done',
    created: '2025-03-02',
    description: 'The v0 endpoint has had no traffic since March.',
  },
  {
    id: 'BACK-700',
    title: 'Upgrade the payment provider SDK',
    status: 'Done',
    assignee: ['@claude-dev'],
    created: '2026-09-01 08:00',
    description: 'Moved to the v12 SDK.',
    kind: 'archive/tasks',
  },
  {
    id: 'DRAFT-3',
    title: 'Spike: two-way sync',
    status: 'To Do',
    created: '2026-10-22T10:00:00Z',
    description: 'Probably never; the app stays read-only for Backlog.md fields.',
    kind: 'drafts',
  },
];

function initialFiles(): Map<string, string> {
  const files = new Map<string, string>([[`${FOLDER}/config.yml`, CONFIG]]);
  for (const [path, text] of Object.entries(MILESTONES)) files.set(path, text);
  for (const task of TASKS) files.set(taskPath(task.kind ?? 'tasks', task.id, task.title), taskFile(task));
  return files;
}

/** The second commit: a status change, a removed file, an unmapped status and a broken file. */
function secondCommit(files: Map<string, string>): Map<string, string> {
  const next = new Map(files);
  const byId = (id: string) => TASKS.find((task) => task.id === id) as DemoTask;
  const moved = byId('BACK-781');
  next.set(
    taskPath('tasks', moved.id, moved.title),
    taskFile({ ...moved, status: 'In Progress', updated: '2026-10-23 09:15' }),
  );
  const blocked = byId('BACK-783');
  next.set(
    taskPath('tasks', blocked.id, blocked.title),
    taskFile({ ...blocked, status: 'Blocked', updated: '2026-10-23 09:20' }),
  );
  const removed = byId('BACK-12');
  next.delete(taskPath('tasks', removed.id, removed.title));
  next.set(
    `${FOLDER}/tasks/back-790 - Export-payouts-as-CSV.md`,
    [
      '---',
      'id: BACK-790',
      'title: Export payouts as CSV',
      'dependencies:',
      '  - - BACK-786',
      '---',
      '',
    ].join('\n'),
  );
  return next;
}

// ---------------------------------------------------------------------------
// In-memory provider
// ---------------------------------------------------------------------------

function blobSha(text: string): string {
  const bytes = Buffer.from(text, 'utf8');
  return createHash('sha1').update(`blob ${bytes.length}\0`).update(bytes).digest('hex');
}

/** One repository with commits, read by the mirror engine through the GitProvider interface. */
class DemoRepository implements GitProvider {
  readonly provider = 'gitlab' as const;
  readonly host = BACKLOG_SEED.host;
  readonly apiBaseUrl = `https://${BACKLOG_SEED.host}/api/v4`;
  readonly webBaseUrl = `https://${BACKLOG_SEED.host}`;
  readonly #blobs = new Map<string, string>();
  readonly #commits = new Map<string, Map<string, string>>();
  head = '';

  commit(files: Map<string, string>): string {
    const tree = new Map<string, string>();
    for (const [path, text] of files) {
      const sha = blobSha(text);
      this.#blobs.set(sha, text);
      tree.set(path, sha);
    }
    this.head = createHash('sha1')
      .update(`${BACKLOG_SEED.repositoryPath}:${this.#commits.size + 1}`)
      .digest('hex');
    this.#commits.set(this.head, tree);
    return this.head;
  }

  #tree(commit: string): Map<string, string> {
    const tree = this.#commits.get(commit === 'main' ? this.head : commit);
    if (!tree) throw new Error(`demo repository: no commit ${commit}`);
    return tree;
  }

  /** The demo repository has no pull requests, so a switch finds nothing that would be lost. */
  async listOpenRequests(path: string, _folder: string) {
    return { requests: [], truncated: false, listUrl: `${this.webBaseUrl}/${path}/-/merge_requests` };
  }

  async whoami() {
    return { login: 'demo-bot', repoCount: 1 };
  }

  async getRepository(_path: string) {
    return { defaultBranch: 'main', webUrl: `${this.webBaseUrl}/${BACKLOG_SEED.repositoryPath}` };
  }

  async getBranchHead(_path: string, _branch: string) {
    return this.head;
  }

  async listTree(_path: string, commit: string, folder: string): Promise<TreeEntry[]> {
    const prefix = folder === '' ? '' : `${folder.replace(/\/+$/, '')}/`;
    return [...this.#tree(commit)]
      .filter(([path]) => path.startsWith(prefix))
      .map(([path, sha]) => ({ path, blobSha: sha, size: null }));
  }

  async readBlob(_path: string, sha: string) {
    const text = this.#blobs.get(sha);
    if (text === undefined) throw new Error(`demo repository: no blob ${sha}`);
    return text;
  }

  async readFile(_path: string, ref: string, filePath: string) {
    const sha = this.#tree(ref).get(filePath);
    return sha ? { content: await this.readBlob(_path, sha), blobSha: sha } : null;
  }

  fileUrl(path: string, branch: string, filePath: string) {
    return `${this.webBaseUrl}/${path}/-/blob/${branch}/${filePath.split('/').map(encodeURIComponent).join('/')}`;
  }

  verifyWebhook(): ReturnType<GitProvider['verifyWebhook']> {
    return { ok: false, reason: 'bad_signature' };
  }
}

/** Records nothing: the seed runs the refreshes itself, so no job waits for the worker. */
const noJobs: JobQueue = {
  enqueue: async () => null,
};

// ---------------------------------------------------------------------------
// Seeding
// ---------------------------------------------------------------------------

export interface BacklogSeedResult {
  key: string;
  tasks: number;
}

/**
 * Creates BACK with its connection and source and runs two refreshes. Returns null when BACK
 * already exists (re-running the seed keeps it). Needs APP_ENCRYPTION_KEY in the context.
 */
export async function seedBacklogProject(ctx: CoreContext, admin: Actor): Promise<BacklogSeedResult | null> {
  if (!ctx.encryptionKey) {
    throw new Error(
      'SEED_BACKLOG=1 needs APP_ENCRYPTION_KEY (openssl rand -base64 32) to store the demo token',
    );
  }
  const existing = await ctx.db.query.project.findFirst({
    columns: { id: true },
    where: { workspaceId: admin.workspaceId, key: BACKLOG_SEED.projectKey },
  });
  if (existing) return null;

  const repo = new DemoRepository();
  let files = initialFiles();
  repo.commit(files);
  // The demo host has no DNS entry: the host check gets a fixed private address, allowed here only.
  const seedCtx: CoreContext = {
    ...ctx,
    providerFactory: () => repo,
    gitHosts: { allowPrivate: true, httpHosts: [], lookup: async () => ['10.20.30.40'] },
    jobs: noJobs,
  };

  const connection = await createConnection(seedCtx, admin, {
    provider: 'gitlab',
    host: BACKLOG_SEED.host,
    name: BACKLOG_SEED.connectionName,
    token: BACKLOG_SEED.token,
  });
  await createProject(seedCtx, admin, {
    key: BACKLOG_SEED.projectKey,
    name: BACKLOG_SEED.projectName,
    description: 'Mirrored from Backlog.md: webhooks, refunds and the mirror itself',
    repository: `https://${BACKLOG_SEED.host}/${BACKLOG_SEED.repositoryPath}`,
  });
  const detected = await detectBacklog(seedCtx, admin, {
    projectKey: BACKLOG_SEED.projectKey,
    connectionId: connection.id,
  });
  const source = await startBacklog(seedCtx, admin, {
    projectKey: BACKLOG_SEED.projectKey,
    connectionId: connection.id,
    mode: 'mirror',
    mappings: detected.mappings,
  });
  await expectRead(await refreshBacklogSource(seedCtx, source.id, 'setup'));

  files = secondCommit(files);
  repo.commit(files);
  await expectRead(await refreshBacklogSource(seedCtx, source.id, 'webhook'));

  const tasks = TASKS.length - 1; // BACK-12 is hidden after the second read.
  return { key: BACKLOG_SEED.projectKey, tasks };
}

async function expectRead(outcome: Awaited<ReturnType<typeof refreshBacklogSource>>): Promise<void> {
  if (outcome.outcome !== 'applied') {
    throw new Error(
      `The demo Backlog.md read did not apply (${outcome.outcome}: ${outcome.error ?? 'no detail'})`,
    );
  }
}
