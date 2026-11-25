// Test support for the mirror engine: an in-memory git repository behind a fake GitProvider (with
// call counters and failure injection), a recording job queue, and a helper that sets up a
// project with a connection and a source. Test-only (imports @zamu/db/test through the fixtures).
import { createHash } from 'node:crypto';
import { readFixtureTree } from '@zamu/backlog-md/testing/fixtures';
import type { BacklogMappings } from '@zamu/contracts';
import { type Db, schema } from '@zamu/db';
import {
  type BlobRef,
  GitNotFound,
  type GitProvider,
  isUnderFolder,
  type OpenRequest,
  type OpenRequestList,
  type ProviderKind,
  type TreeEntry,
  verifyWebhook,
} from '@zamu/git-providers';
import { eq } from 'drizzle-orm';
import type { Actor } from '../authz';
import type { ProviderFactory } from '../context';
import type { JobName, JobPayloadInput, JobQueue } from '../jobs';
import { encryptSecret } from '../secrets';
import { createGitConnectionRow } from '../testing/backlog';
import { randomProjectKey, type TestContext, type World } from '../testing/fixtures';
import { refreshBacklogSource } from './refresh';
import { startBacklog } from './setup';

/** A fixed 32-byte key for tests. */
export const TEST_ENCRYPTION_KEY = new Uint8Array(32).fill(7);
export const TEST_TOKEN = 'glpat-test-token-0123456789';

/** Git's blob hash of a text. */
export function blobSha(text: string): string {
  const bytes = Buffer.from(text, 'utf8');
  return createHash('sha1').update(`blob ${bytes.length}\0`).update(bytes).digest('hex');
}

/**
 * An in-memory repository with commits. Edit the working files with set/remove/rename, then
 * commit() to move the default branch head.
 */
export class FakeRepository {
  readonly path: string;
  defaultBranch = 'main';
  /** M6: open requests listOpenRequests serves, and whether that list was cut. */
  openRequests: FakeOpenRequest[] = [];
  openRequestsTruncated = false;
  readonly #blobs = new Map<string, string>();
  readonly #commits = new Map<string, Map<string, string>>();
  #working = new Map<string, string>();
  #head = '';
  #count = 0;

  constructor(path = 'reddevs/payments', files: Record<string, string> = {}) {
    this.path = path;
    for (const [file, text] of Object.entries(files)) this.set(file, text);
    this.commit();
  }

  /** Every file of a fixture folder (relative to packages/backlog-md/test/fixtures), under `prefix`. */
  static fromFixture(root: string, path?: string, prefix = ''): FakeRepository {
    const repo = new FakeRepository(path);
    for (const file of readFixtureTree(root)) repo.set(`${prefix}${file.path}`, file.text);
    repo.commit();
    return repo;
  }

  get head(): string {
    return this.#head;
  }

  set(file: string, text: string): this {
    this.#working.set(file, text);
    return this;
  }

  get(file: string): string | undefined {
    return this.#working.get(file);
  }

  remove(file: string): this {
    this.#working.delete(file);
    return this;
  }

  rename(from: string, to: string): this {
    const text = this.#working.get(from);
    if (text === undefined) throw new Error(`no file ${from}`);
    this.#working.delete(from);
    this.#working.set(to, text);
    return this;
  }

  files(): string[] {
    return [...this.#working.keys()].sort();
  }

  commit(): string {
    this.#count += 1;
    const tree = new Map<string, string>();
    for (const [file, text] of this.#working) {
      const sha = blobSha(text);
      this.#blobs.set(sha, text);
      tree.set(file, sha);
    }
    const sha = createHash('sha1').update(`${this.path}:${this.#count}`).digest('hex');
    this.#commits.set(sha, tree);
    this.#head = sha;
    return sha;
  }

  tree(commit: string): Map<string, string> {
    const tree = this.#commits.get(commit);
    if (!tree) throw new GitNotFound('commit not found');
    return tree;
  }

  blob(sha: string): string {
    const text = this.#blobs.get(sha);
    if (text === undefined) throw new GitNotFound('blob not found');
    return text;
  }
}

/** Calls a fake provider received, by method. */
export interface ProviderCalls {
  whoami: number;
  getRepository: number;
  getBranchHead: number;
  listTree: number;
  readBlob: number;
  readFile: number;
  listOpenRequests: number;
}

/** M6: an open request of a FakeRepository and the files it changes. */
export interface FakeOpenRequest extends OpenRequest {
  files: string[];
}

/** A GitProvider over FakeRepository instances keyed by repository path. */
export class FakeProvider implements GitProvider {
  readonly provider: ProviderKind;
  readonly host: string;
  readonly apiBaseUrl: string;
  readonly webBaseUrl: string;
  readonly calls: ProviderCalls = {
    whoami: 0,
    getRepository: 0,
    getBranchHead: 0,
    listTree: 0,
    readBlob: 0,
    readFile: 0,
    listOpenRequests: 0,
  };
  /** Thrown by the next call (any method) when set; cleared after throwing unless `failAlways`. */
  failWith: Error | null = null;
  failAlways = false;
  readonly #repos: Map<string, FakeRepository>;

  constructor(repos: FakeRepository[], provider: ProviderKind = 'gitlab', host = 'gitlab.com') {
    this.provider = provider;
    this.host = host;
    this.apiBaseUrl = `https://${host}/api/v4`;
    this.webBaseUrl = `https://${host}`;
    this.#repos = new Map(repos.map((repo) => [repo.path.toLowerCase(), repo]));
  }

  /** Serves another repository. */
  add(repo: FakeRepository): FakeRepository {
    this.#repos.set(repo.path.toLowerCase(), repo);
    return repo;
  }

  resetCalls(): void {
    for (const key of Object.keys(this.calls) as (keyof ProviderCalls)[]) this.calls[key] = 0;
  }

  #call(method: keyof ProviderCalls): void {
    this.calls[method] += 1;
    if (this.failWith) {
      const error = this.failWith;
      if (!this.failAlways) this.failWith = null;
      throw error;
    }
  }

  #repo(path: string): FakeRepository {
    const repo = this.#repos.get(path.toLowerCase());
    if (!repo) throw new GitNotFound('repository not found');
    return repo;
  }

  async whoami() {
    this.#call('whoami');
    return { login: 'tester', repoCount: this.#repos.size };
  }

  async getRepository(path: string) {
    this.#call('getRepository');
    const repo = this.#repo(path);
    return { defaultBranch: repo.defaultBranch, webUrl: `${this.webBaseUrl}/${repo.path}` };
  }

  async getBranchHead(path: string, branch: string) {
    this.#call('getBranchHead');
    const repo = this.#repo(path);
    if (branch !== repo.defaultBranch) throw new GitNotFound('branch not found');
    return repo.head;
  }

  async listTree(path: string, commit: string, folder: string): Promise<TreeEntry[]> {
    this.#call('listTree');
    const tree = this.#repo(path).tree(commit);
    const prefix = folder === '' ? '' : `${folder.replace(/\/+$/, '')}/`;
    return [...tree.entries()]
      .filter(([file]) => file.startsWith(prefix))
      .map(([file, blobSha]) => ({ path: file, blobSha, size: null }));
  }

  async readBlob(path: string, sha: string) {
    this.#call('readBlob');
    return this.#repo(path).blob(sha);
  }

  /** Blob text without counting a call, for subclasses. */
  protected blobText(path: string, sha: string): string {
    return this.#repo(path).blob(sha);
  }

  async readFile(path: string, ref: string, filePath: string) {
    this.#call('readFile');
    const repo = this.#repo(path);
    const tree = repo.tree(ref === repo.defaultBranch ? repo.head : ref);
    const sha = tree.get(filePath);
    return sha ? { content: repo.blob(sha), blobSha: sha } : null;
  }

  async listOpenRequests(path: string, folder: string): Promise<OpenRequestList> {
    this.#call('listOpenRequests');
    const repo = this.#repo(path);
    return {
      requests: repo.openRequests
        .filter((request) => request.files.some((file) => isUnderFolder(file, folder)))
        .map(({ files: _files, ...request }) => request),
      truncated: repo.openRequestsTruncated,
      listUrl: `${this.webBaseUrl}/${repo.path}/-/merge_requests`,
    };
  }

  fileUrl(path: string, branch: string, filePath: string) {
    return `${this.webBaseUrl}/${path}/-/blob/${branch}/${filePath}`;
  }

  verifyWebhook(
    headers: Parameters<GitProvider['verifyWebhook']>[0],
    rawBody: string | Uint8Array,
    secret: string,
  ) {
    return verifyWebhook(this.provider, headers, rawBody, secret);
  }
}

/** A FakeProvider with a batch read, like GitLab's. Records each batch it was asked for. */
export class BatchingFakeProvider extends FakeProvider {
  readonly batches: BlobRef[][] = [];
  /** Blob hashes the batch leaves out, as GitLab does for binary or oversized files. */
  readonly omit = new Set<string>();

  async readBlobs(path: string, _commit: string, files: readonly BlobRef[]): Promise<Map<string, string>> {
    this.batches.push([...files]);
    const contents = new Map<string, string>();
    for (const file of files) {
      if (!this.omit.has(file.blobSha)) contents.set(file.blobSha, this.blobText(path, file.blobSha));
    }
    return contents;
  }
}

/** A provider factory that always hands out `provider` (the token and host policy are ignored). */
export function fakeProviderFactory(provider: FakeProvider): ProviderFactory {
  return () => provider;
}

/** A JobQueue that records what was enqueued instead of sending it. Returns null for a source already queued. */
export interface RecordingJobQueue extends JobQueue {
  sent: { name: JobName; data: unknown; options: unknown }[];
  clear(): void;
}

export function recordingJobQueue(): RecordingJobQueue {
  const sent: RecordingJobQueue['sent'] = [];
  return {
    sent,
    clear: () => {
      sent.length = 0;
    },
    async enqueue<N extends JobName>(_tx: unknown, name: N, data: JobPayloadInput<N>, options?: unknown) {
      sent.push({ name, data, options });
      return crypto.randomUUID();
    },
  } as RecordingJobQueue;
}

/** The test context with the encryption key, the fake provider and a recording queue. */
export function mirrorContext(
  base: TestContext,
  provider: FakeProvider,
): TestContext & { jobs: RecordingJobQueue; encryptionKey: Uint8Array } {
  return {
    ...base,
    encryptionKey: TEST_ENCRYPTION_KEY,
    providerFactory: fakeProviderFactory(provider),
    jobs: recordingJobQueue(),
  };
}

/** A project linked to `repo` on gitlab.com, with a connection whose token is encrypted with the test key. */
export async function createLinkedProject(
  ctx: TestContext & { encryptionKey: Uint8Array },
  world: World,
  repo: FakeRepository,
  options: { key?: string; host?: string; provider?: ProviderKind } = {},
) {
  const key = options.key ?? randomProjectKey();
  const host = options.host ?? 'gitlab.com';
  const repository = `https://${host}/${repo.path}`;
  const [project] = await ctx.db
    .insert(schema.project)
    .values({
      workspaceId: world.workspaceId,
      key,
      name: `Mirror ${key}`,
      repository,
      repositoryKey: `${host}/${repo.path}`.toLowerCase(),
      usesMilestones: false,
    })
    .returning();
  if (!project) throw new Error('project insert failed');
  const connection = await createGitConnectionRow(ctx.db, world, {
    host,
    provider: options.provider ?? 'gitlab',
    tokenCiphertext: encryptSecret(ctx, TEST_TOKEN),
  });
  return { project, connection, key };
}

export const NO_MAPPINGS: BacklogMappings = { status: [], priority: [], assignee: [] };

/**
 * A project mirroring `repo`: linked project, connection, startBacklog with `mappings` and the first
 * refresh run directly (the recorded setup job is cleared).
 */
export async function createMirror(
  ctx: TestContext & { jobs: RecordingJobQueue; encryptionKey: Uint8Array },
  world: World,
  repo: FakeRepository,
  options: {
    key?: string;
    mode?: 'mirror' | 'import';
    mappings?: BacklogMappings;
    folderOverride?: string;
    actor?: Actor;
    refresh?: boolean;
  } = {},
) {
  const linked = await createLinkedProject(ctx, world, repo, { key: options.key });
  const status = await startBacklog(ctx, options.actor ?? world.ownerActor, {
    projectKey: linked.key,
    connectionId: linked.connection.id,
    mode: options.mode ?? 'mirror',
    mappings: options.mappings ?? NO_MAPPINGS,
    ...(options.folderOverride ? { folderOverride: options.folderOverride } : {}),
  });
  ctx.jobs.clear();
  const first = options.refresh === false ? null : await refreshBacklogSource(ctx, status.id, 'setup');
  return { ...linked, sourceId: status.id, first };
}

/** Task rows of a project, by key (KEY-12, KEY-12.1). */
export async function tasksByKey(db: Db, projectId: string, projectKey: string) {
  const rows = await db.select().from(schema.task).where(eq(schema.task.projectId, projectId));
  return new Map(
    rows.map((row) => [`${projectKey}-${row.number}${row.keySuffix ? `.${row.keySuffix}` : ''}`, row]),
  );
}

/** Activity rows of a project, oldest first. */
export async function projectActivity(db: Db, projectId: string) {
  const rows = await db.select().from(schema.activity).where(eq(schema.activity.projectId, projectId));
  return rows.sort((a, b) => a.createdAt.getTime() - b.createdAt.getTime() || (a.id < b.id ? -1 : 1));
}

/** A task file in the current Backlog.md format. */
export function taskFile(values: {
  id: string;
  title: string;
  status?: string;
  priority?: string;
  assignee?: string[];
  milestone?: string;
  labels?: string[];
  ordinal?: number;
  parent?: string;
  dependencies?: string[];
  due?: string;
  created?: string;
  updated?: string;
  description?: string;
}): string {
  const lines = ['---', `id: ${values.id}`, `title: ${JSON.stringify(values.title)}`];
  lines.push(`status: ${values.status ?? 'To Do'}`);
  lines.push(`assignee: [${(values.assignee ?? []).map((value) => `'${value}'`).join(', ')}]`);
  lines.push(`created_date: '${values.created ?? '2026-10-01 10:00'}'`);
  if (values.updated) lines.push(`updated_date: '${values.updated}'`);
  lines.push(`labels: [${(values.labels ?? []).join(', ')}]`);
  if (values.milestone) lines.push(`milestone: ${values.milestone}`);
  lines.push(`dependencies: [${(values.dependencies ?? []).join(', ')}]`);
  if (values.due) lines.push(`due_date: '${values.due}'`);
  if (values.parent) lines.push(`parent_task_id: ${values.parent}`);
  if (values.priority) lines.push(`priority: ${values.priority}`);
  if (values.ordinal !== undefined) lines.push(`ordinal: ${values.ordinal}`);
  lines.push('---', '', '## Description', '', '<!-- SECTION:DESCRIPTION:BEGIN -->');
  lines.push(values.description ?? `About ${values.title}.`, '<!-- SECTION:DESCRIPTION:END -->', '');
  return lines.join('\n');
}

/** The file name Backlog.md gives a task: "back-12 - Title-words.md". */
export function taskPath(
  folder: string,
  id: string,
  title: string,
  kind: 'tasks' | 'drafts' | 'archive/tasks' = 'tasks',
) {
  return `${folder}/${kind}/${id.toLowerCase()} - ${title.replace(/[^A-Za-z0-9]+/g, '-')}.md`;
}

/** A minimal config.yml. */
export function configFile(values: { prefix?: string; statuses?: string[]; name?: string } = {}): string {
  return [
    `project_name: "${values.name ?? 'Payments API'}"`,
    'default_status: "To Do"',
    `statuses: [${(values.statuses ?? ['To Do', 'In Progress', 'Done']).map((s) => `"${s}"`).join(', ')}]`,
    'labels: []',
    'date_format: yyyy-mm-dd hh:mm',
    `task_prefix: "${values.prefix ?? 'back'}"`,
    '',
  ].join('\n');
}
