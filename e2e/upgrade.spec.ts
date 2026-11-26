// Upgrades on a second compose stack (project <E2E_COMPOSE_PROJECT>-upgrade, port 3101) next to the main one. The
// stack starts on M1 (release 0.1.1) and gets data through the M1 app, moves to M2.1 (0.3.0: the M2 and M2.1
// migrations run against the M1 data, which shows on the board in its M1 order, and gets M2 and M2.1 data),
// then to 0.6.0 (the M3 and M4 migrations: every task key survives, a Backlog.md mirror reads labels, a due
// date, a dependency and a parent into its Backlog.md block, and a task's acceptance criteria, definition of
// done, plan, notes and summary into its description, and an agent gets a pm_live_ API key), then to 0.8.0 when
// that release exists (the rename: the mirror keeps working and the sections stay in the description), then
// to 0.9.0 when that release exists (the M6 migration moves the sections out of the description into the work
// record, with no activity rows), then to 0.10.0 when that release exists (the workspaces migration; a task is
// finished there), then to the image globalSetup built: the M5 migrations run (on 0.8.0 when that step ran),
// the backfill turns the mirror's block into native labels, due date, blockers and parent with no activity
// rows, the M6 migration runs unless 0.9.0 ran it, the next refresh changes nothing, and every task key and
// route still works. The rename to Zamu dropped the pm_live_ prefix with no fallback, so the 0.6.0 API key
// gets 401 and a new key starts with zamu_live_. The workspaces migration (here, or on 0.10.0) keeps the
// workspace's slug, fills in the workspace each user used last, and the pre-0.10 URLs redirect to the same
// page under /w/<slug>/. The M7 migration leaves archiving off on every existing project (a new one archives
// after 14 days) and fills in when each finished task was finished, and the Repository page of a project that
// already had a repository works.
//
// Older images, each used when it is already local:
//   M1    E2E_M1_IMAGE (pulled if it is not local, for example from a private registry after
//         `docker login`), else
//         zamu:m1-0.1.1, built once from the git tag 0.1.1.
//   M2.1  E2E_M2_1_IMAGE (pulled likewise, for example <registry>/<image>:0.3.0), else
//         zamu:m2.1-<ref>, built once from the git tag 0.3.0 when it exists, else from the M2.1
//         merge commit (E2E_M2_1_REF overrides).
//   0.6.0 E2E_0_6_IMAGE (pulled likewise, for example <registry>/<image>:0.6.0), else
//         zamu:release-0.6.0, built once from the git tag 0.6.0.
//   0.8.0 E2E_0_8_IMAGE (pulled likewise), else zamu:release-<ref>, built once from E2E_0_8_REF or the git
//         tag 0.8.0. Without the image variable and with no such ref, the 0.8.0 step is skipped with a
//         message and the next step upgrades from 0.6.0.
//   0.9.0 E2E_0_9_IMAGE (pulled likewise), else zamu:release-<ref>, built once from E2E_0_9_REF or the git
//         tag 0.9.0. Skipped the same way when neither exists.
//   0.10.0 E2E_0_10_IMAGE (pulled likewise), else zamu:release-<ref>, built once from E2E_0_10_REF or the git
//         tag 0.10.0. Skipped the same way when neither exists.
// Builds use git archive, so the checkout is untouched. The mirror reads from a Forgejo container (e2e/forgejo.ts)
// attached to the upgrade stack's network. E2E_SKIP_UPGRADE=1 skips this spec.
import { execFileSync, spawnSync } from 'node:child_process';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { type BrowserContext, expect, type Page, request, test } from '@playwright/test';
import { addConnection, type Forgejo, startForgejo } from './forgejo';
import { addAgent, api, settle, setUpServer, signInAsAdmin, w } from './session';
import {
  composeProject,
  createStack,
  image as currentImage,
  downCommand,
  forgejoAliases,
  baseURL as mainURL,
  repoRoot,
} from './stack';

const M1_TAG = '0.1.1';
const m1Image = process.env.E2E_M1_IMAGE ?? `zamu:m1-${M1_TAG}`;
/** The M2.1 merge to main, released as 0.3.0. */
const M2_1_COMMIT = '87306ff';
const m2_1Ref = process.env.E2E_M2_1_REF ?? (gitRefExists('0.3.0') ? '0.3.0' : M2_1_COMMIT);
const m2_1Image = process.env.E2E_M2_1_IMAGE ?? `zamu:m2.1-${m2_1Ref}`;
/** The release before M5: the backlog sweep. */
const RELEASE_0_6_TAG = '0.6.0';
const release0_6Image = process.env.E2E_0_6_IMAGE ?? `zamu:release-${RELEASE_0_6_TAG}`;
/** The rename to Zamu, the release before M6. E2E_0_8_REF picks another ref, such as a release candidate. */
const RELEASE_0_8_TAG = '0.8.0';
const release0_8Ref = process.env.E2E_0_8_REF ?? RELEASE_0_8_TAG;
const release0_8Image = process.env.E2E_0_8_IMAGE ?? `zamu:release-${release0_8Ref}`;
/** Why the 0.8.0 step can't run here, or null when it can. */
const release0_8Missing =
  process.env.E2E_0_8_IMAGE || gitRefExists(release0_8Ref)
    ? null
    : `The git ref ${release0_8Ref} does not exist, so the 0.8.0 step is skipped and the next step upgrades ` +
      'straight from 0.6.0. Tag the release, or set E2E_0_8_IMAGE (an image) or E2E_0_8_REF (a git ref such ' +
      'as 0.8.0-rc.1) to run it.';
/** The work record (M6), the release before workspaces in the URL. E2E_0_9_REF picks another ref. */
const RELEASE_0_9_TAG = '0.9.0';
const release0_9Ref = process.env.E2E_0_9_REF ?? RELEASE_0_9_TAG;
const release0_9Image = process.env.E2E_0_9_IMAGE ?? `zamu:release-${release0_9Ref}`;
const release0_9Missing =
  process.env.E2E_0_9_IMAGE || gitRefExists(release0_9Ref)
    ? null
    : `The git ref ${release0_9Ref} does not exist, so the 0.9.0 step is skipped and the next step upgrades ` +
      'from the release before it. Tag the release, or set E2E_0_9_IMAGE (an image) or E2E_0_9_REF (a git ' +
      'ref such as 0.9.0-rc.1) to run it.';
/** Several workspaces, the release before M7. E2E_0_10_REF picks another ref. */
const RELEASE_0_10_TAG = '0.10.0';
const release0_10Ref = process.env.E2E_0_10_REF ?? RELEASE_0_10_TAG;
const release0_10Image = process.env.E2E_0_10_IMAGE ?? `zamu:release-${release0_10Ref}`;
const release0_10Missing =
  process.env.E2E_0_10_IMAGE || gitRefExists(release0_10Ref)
    ? null
    : `The git ref ${release0_10Ref} does not exist, so the 0.10.0 step is skipped and the next step upgrades ` +
      'from the release before it. Tag the release, or set E2E_0_10_IMAGE (an image) or E2E_0_10_REF (a git ' +
      'ref such as 0.10.0-rc.1) to run it.';
const upgradePort = process.env.E2E_UPGRADE_PORT ?? '3101';
/** API key prefix up to 0.7.0. The current build no longer accepts it. */
const OLD_API_KEY_PREFIX = 'pm_live_';
// Same host as the main stack (localhost, or the host in E2E_BASE_URL), another port.
const upgradeURL = (() => {
  const url = new URL(mainURL);
  url.port = upgradePort;
  return url.origin;
})();

const stack = createStack({
  project: `${composeProject}-upgrade`,
  port: upgradePort,
  baseURL: upgradeURL,
  image: m1Image,
});

interface TaskRef {
  key: string;
  title: string;
  status: string;
}
interface WorkItem {
  number: number;
  text: string;
  state: string;
  locked: boolean;
}
interface MirroredTask extends TaskRef {
  locked: string[];
  description?: string | null;
  backlog: {
    id: string;
    data: {
      labels: string[];
      dueDate?: string | null;
      dependencies: unknown[];
      implementationNotes?: string | null;
    };
  } | null;
  labels?: { name: string; source: string }[];
  dueDate?: string | null;
  parent?: TaskRef | null;
  blockedBy?: (TaskRef | null)[];
  blocked?: boolean;
  criteria?: WorkItem[];
  doneItems?: WorkItem[];
  plan?: string | null;
  finalSummary?: string | null;
}
interface SourceStatus {
  state: string;
  lastRead: { at: string; commit: string } | null;
}

/** The Backlog.md project of the 0.6.0 step: mirrored, so the M5 backfill has a block to read. */
const infra = { name: 'Infra', key: 'INF' };
const infraRepo = 'infra';
const backlogFiles: Record<string, string> = {
  'README.md': '# Infra\n',
  'backlog/config.yml': [
    'project_name: "Infra"',
    'default_status: "To Do"',
    'statuses: ["To Do", "In Progress", "Done"]',
    'labels: ["ops", "k8s"]',
    'date_format: yyyy-mm-dd hh:mm',
    'auto_commit: false',
    'task_prefix: "inf"',
    '',
  ].join('\n'),
  'backlog/tasks/inf-1 - Move-to-the-new-cluster.md': `---
id: INF-1
title: Move to the new cluster
status: In Progress
assignee: []
created_date: '2026-10-01 09:00'
labels:
  - ops
  - k8s
due_date: '2026-12-01'
dependencies: []
priority: high
---

## Description

<!-- SECTION:DESCRIPTION:BEGIN -->
Every service runs on the new cluster.
<!-- SECTION:DESCRIPTION:END -->
`,
  'backlog/tasks/inf-1.1 - Drain-the-old-nodes.md': `---
id: INF-1.1
title: Drain the old nodes
status: To Do
assignee: []
created_date: '2026-10-01 10:00'
labels:
  - ops
dependencies: []
parent_task_id: INF-1
---
`,
  'backlog/tasks/inf-2 - Update-the-runbook.md': `---
id: INF-2
title: Update the runbook
status: To Do
assignee: []
created_date: '2026-10-02 09:00'
labels: []
dependencies:
  - INF-1
---
`,
  // Up to 0.8.0 the mirror writes these sections into the description; the M6 migration moves them out.
  'backlog/tasks/inf-3 - Rotate-the-cluster-certificates.md': `---
id: INF-3
title: Rotate the cluster certificates
status: In Progress
assignee: []
created_date: '2026-10-03 09:00'
labels: []
dependencies: []
---

## Description

<!-- SECTION:DESCRIPTION:BEGIN -->
Certificates rotate before they expire.
<!-- SECTION:DESCRIPTION:END -->

## Acceptance Criteria
<!-- AC:BEGIN -->
- [x] #1 New certificates are issued
- [ ] #2 Old certificates are revoked
<!-- AC:END -->

## Definition of Done
<!-- DOD:BEGIN -->
- [ ] #1 Runbook updated
<!-- DOD:END -->

## Implementation Plan

<!-- SECTION:PLAN:BEGIN -->
1. Issue the new certificates.
2. Revoke the old ones.
<!-- SECTION:PLAN:END -->

## Implementation Notes

<!-- SECTION:NOTES:BEGIN -->
Issued through the internal CA.
<!-- SECTION:NOTES:END -->

## Final Summary

<!-- SECTION:FINAL_SUMMARY:BEGIN -->
Rotation is scripted.
<!-- SECTION:FINAL_SUMMARY:END -->
`,
};
const infraKeys = ['INF-1', 'INF-1.1', 'INF-2', 'INF-3'];

test.describe.configure({ mode: 'serial' });
test.skip(process.env.E2E_SKIP_UPGRADE === '1', 'E2E_SKIP_UPGRADE=1');

let context: BrowserContext;
let page: Page;
/** Task keys per status in the M1 list order (priority, then most recently updated). */
let m1Order: Record<string, string[]> = {};
/** The pm_live_ key created on 0.6.0. */
let oldApiKey = '';
/** Every task after the M2.1 step. */
let m2_1Tasks: TaskRef[] = [];
const repository = 'https://gitlab.com/reddevs/operations.git';
let forgejo: Forgejo | undefined;
/** Timeline length of each mirrored task before the M5 upgrade. */
const timelineBefore: Record<string, number> = {};
/** The one workspace, read from the database on the last release before this build. */
let workspaceBefore: { id: string; slug: string } | undefined;
/** When OPS-5 was finished on 0.10.0 (when that step ran), for the M7 backfill of closedAt. */
let finishedOn0_10: { from: number; to: number } | undefined;

const byKey = (a: { key: string }, b: { key: string }) => a.key.localeCompare(b.key);

function gitRefExists(ref: string): boolean {
  return (
    spawnSync('git', ['rev-parse', '--verify', '--quiet', `${ref}^{commit}`], { cwd: repoRoot }).status === 0
  );
}

function hasImage(name: string): boolean {
  return spawnSync('docker', ['image', 'inspect', name], { stdio: 'ignore' }).status === 0;
}

/**
 * Makes sure an older image is local: pulls it when its name came from the environment, else builds `ref`
 * from git (once; later runs reuse the image).
 */
function ensureImage(name: string, fromEnv: boolean, ref: string): void {
  if (hasImage(name)) return;
  if (fromEnv) {
    console.log(`[e2e] pulling ${name}`);
    execFileSync('docker', ['pull', name], { stdio: ['ignore', 'ignore', 'inherit'] });
    return;
  }
  console.log(`[e2e] building ${name} from git ${ref} (once; later runs reuse it)`);
  const dir = mkdtempSync(join(tmpdir(), 'zamu-e2e-image-'));
  try {
    const archive = join(dir, 'source.tar');
    const source = join(dir, 'source');
    execFileSync('git', ['archive', '--format=tar', '-o', archive, ref], { cwd: repoRoot });
    execFileSync('mkdir', [source]);
    execFileSync('tar', ['-xf', archive, '-C', source]);
    execFileSync('docker', ['build', '-t', name, source], { stdio: ['ignore', 'ignore', 'inherit'] });
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
}

/** State and exit code of the migrate container, e.g. "exited 0". */
function migrateState(): string {
  return stack
    .compose(['ps', '-a', 'migrate', '--format', '{{.State}} {{.ExitCode}}'], { quiet: true })
    .trim();
}

/** Runs one SQL query in the stack's Postgres and returns its rows, tab-separated, one per line. */
function sql(query: string): string[] {
  const output = stack.compose(
    ['exec', '-T', 'db', 'psql', '-U', 'postgres', '-d', 'zamu', '-tA', '-F', '\t', '-c', query],
    { quiet: true },
  );
  return output.split('\n').filter((line) => line.trim() !== '');
}

/** The id and slug of the stack's only workspace, straight from the database (every release has the table). */
function readWorkspace(): { id: string; slug: string } {
  const rows = sql('select id, slug from organization');
  expect(rows).toHaveLength(1);
  const [id = '', slug = ''] = (rows[0] ?? '').split('\t');
  return { id, slug };
}

/** Moves the stack to another image: compose recreates migrate, web and worker, and migrate runs first. */
async function switchTo(image: string): Promise<void> {
  stack.image = image;
  console.log(`[e2e] switching ${stack.project} to ${image}`);
  await startStack();
  expect(migrateState()).toBe('exited 0');
  const images = stack.compose(['ps', '--format', '{{.Service}} {{.Image}}'], { quiet: true });
  expect(images).toContain(`web ${image}`);
}

async function startStack(): Promise<void> {
  try {
    // Compose recreates migrate, web and worker when the image changes; migrate runs before web starts.
    stack.compose(['up', '-d', '--no-build'], { quiet: true });
    await stack.waitForHealthy();
  } catch (error) {
    console.error(stack.dumpState());
    throw error;
  }
}

test.beforeAll(async ({ browser }) => {
  // Building the older images from source takes a few minutes each the first time.
  test.setTimeout(30 * 60_000);
  ensureImage(m1Image, Boolean(process.env.E2E_M1_IMAGE), M1_TAG);
  ensureImage(m2_1Image, Boolean(process.env.E2E_M2_1_IMAGE), m2_1Ref);
  ensureImage(release0_6Image, Boolean(process.env.E2E_0_6_IMAGE), RELEASE_0_6_TAG);
  if (release0_8Missing) console.log(`[e2e] ${release0_8Missing}`);
  else ensureImage(release0_8Image, Boolean(process.env.E2E_0_8_IMAGE), release0_8Ref);
  if (release0_9Missing) console.log(`[e2e] ${release0_9Missing}`);
  else ensureImage(release0_9Image, Boolean(process.env.E2E_0_9_IMAGE), release0_9Ref);
  if (release0_10Missing) console.log(`[e2e] ${release0_10Missing}`);
  else ensureImage(release0_10Image, Boolean(process.env.E2E_0_10_IMAGE), release0_10Ref);
  stack.compose(['down', '-v', '--remove-orphans'], { quiet: true });
  console.log(`[e2e] starting ${stack.project} on ${m1Image} at ${upgradeURL}`);
  await startStack();
  // The network outlives the image switches, so Forgejo stays reachable from every step.
  forgejo = await startForgejo('upgrade', stack.network, forgejoAliases.upgrade);
  await forgejo.createRepository(infraRepo, backlogFiles);
  // Clipboard access: addAgent reads the new API key from it.
  context = await browser.newContext({
    baseURL: upgradeURL,
    permissions: ['clipboard-read', 'clipboard-write'],
  });
  page = await context.newPage();
});

// biome-ignore lint/correctness/noEmptyPattern: Playwright requires an object pattern as the first argument.
test.afterEach(async ({}, testInfo) => {
  if (testInfo.status !== testInfo.expectedStatus && page) {
    await testInfo.attach('page at failure', { body: await page.screenshot(), contentType: 'image/png' });
  }
});

test.afterAll(async () => {
  await context?.close();
  if (process.env.E2E_KEEP_STACK === '1') {
    console.log(`[e2e] leaving ${stack.project} running at ${upgradeURL}. Remove it with:`);
    console.log(`  ${downCommand(stack)}`);
    return;
  }
  forgejo?.stop();
  stack.compose(['down', '-v', '--remove-orphans'], { quiet: true });
});

/** Status of GET /api/v1/me with only the API key: a fresh request context, so no session cookie. */
async function meStatusWithKey(key: string): Promise<number> {
  const keyOnly = await request.newContext({ baseURL: upgradeURL });
  try {
    const response = await keyOnly.get('/api/v1/me', { headers: { authorization: `Bearer ${key}` } });
    return response.status();
  } finally {
    await keyOnly.dispose();
  }
}

async function timelineLength(key: string): Promise<number> {
  return (await api<{ items: unknown[] }>(page.request, 'GET', `/tasks/${key}/timeline`)).items.length;
}

async function sourceStatus(): Promise<SourceStatus> {
  return api<SourceStatus>(page.request, 'GET', `/projects/${infra.key}/backlog`);
}

/** Queues a read of the mirror (Refresh now) and waits until it finishes. */
async function refreshMirror(): Promise<void> {
  const before = (await sourceStatus()).lastRead?.at;
  await api(page.request, 'POST', `/projects/${infra.key}/backlog/refresh`);
  await expect
    .poll(async () => (await sourceStatus()).lastRead?.at, { timeout: 90_000, intervals: [1_000] })
    .not.toBe(before);
}

test('M1 0.1.1: set up the server and add a project with tasks', async () => {
  await page.goto('/');
  // M1 has no dashboard: "/" opens the projects page.
  await setUpServer(page, /\/projects$/);

  // The M1 API: GET /me has no theme yet.
  const me = await api<{ user: Record<string, unknown> }>(page.request, 'GET', '/me');
  expect(me.user).not.toHaveProperty('theme');

  await api(page.request, 'POST', '/projects', { name: 'Operations', key: 'OPS' });
  const tasks = [
    { title: 'Rotate the database password', priority: 'high' },
    { title: 'Renew the TLS certificate', status: 'in_progress' },
    { title: 'Archive old logs', priority: 'low' },
    { title: 'Move backups to object storage', status: 'done' },
    { title: 'Document the restore drill', priority: 'urgent' },
  ];
  for (const task of tasks) await api(page.request, 'POST', '/tasks', { project: 'OPS', ...task });

  const list = await api<{ items: TaskRef[] }>(page.request, 'GET', '/tasks?project=OPS');
  m1Order = Object.fromEntries(
    Object.entries(Object.groupBy(list.items, (task) => task.status)).map(([status, items = []]) => [
      status,
      items.map((task) => task.key),
    ]),
  );
  expect(m1Order).toEqual({ todo: ['OPS-5', 'OPS-1', 'OPS-3'], in_progress: ['OPS-2'], done: ['OPS-4'] });
});

test('M2.1 (0.3.0): the M2 migrations keep the M1 data and its board order', async () => {
  test.setTimeout(5 * 60_000);
  expect(migrateState()).toBe('exited 0');

  await switchTo(m2_1Image);

  // The session from M1 may or may not survive; sign in again either way.
  await signInAsAdmin(page);
  const me = await api<{ user: { theme: string } }>(page.request, 'GET', '/me');
  expect(me.user.theme).toBe('system');
  const projects = await api<{ items: { key: string; usesMilestones: boolean; usesCycles: boolean }[] }>(
    page.request,
    'GET',
    '/projects',
  );
  const project = projects.items.find((item) => item.key === 'OPS');
  expect(project).toMatchObject({ usesMilestones: true, usesCycles: true, currentCycle: null });

  // The migration gave every task a rank that keeps the M1 order inside each status.
  for (const [status, keys] of Object.entries(m1Order)) {
    const board = await api<{ items: TaskRef[] }>(
      page.request,
      'GET',
      `/tasks?project=OPS&status=${status}&order=board`,
    );
    expect(board.items.map((task) => task.key)).toEqual(keys);
  }

  await page.goto('/p/OPS?view=board');
  await settle(page);
  const keysIn = (status: string) =>
    page
      .getByRole('grid', { name: status, exact: true })
      .locator('[data-card-key]')
      .evaluateAll((cards) => cards.map((card) => card.getAttribute('data-card-key') ?? ''));
  await expect(page.getByRole('region', { name: 'Todo, 3 tasks' })).toBeVisible();
  expect(await keysIn('Todo')).toEqual(m1Order.todo);
  expect(await keysIn('In progress')).toEqual(m1Order.in_progress);
  await expect(page.getByRole('button', { name: 'Expand Done, 1 tasks' })).toBeVisible();

  // M2 features work on the upgraded data.
  const milestone = await api<{ id: string }>(page.request, 'POST', '/projects/OPS/milestones', {
    name: 'Hardening',
  });
  await api(page.request, 'PATCH', '/tasks/OPS-1', { milestone: milestone.id, status: 'in_progress' });
  const milestones = await api<{ items: { name: string; status: string }[] }>(
    page.request,
    'GET',
    '/projects/OPS/milestones',
  );
  expect(milestones.items).toEqual([expect.objectContaining({ name: 'Hardening', status: 'active' })]);

  // M2 and M2.1 data for the next upgrade: a cycle, a comment, a linked repository and one more task.
  await api(page.request, 'POST', '/projects/OPS/cycles', {
    startsOn: new Date().toISOString().slice(0, 10),
  });
  await api(page.request, 'PATCH', '/tasks/OPS-2', { cycle: 'current' });
  await api(page.request, 'POST', '/tasks/OPS-1/comments', {
    body: 'Rotated on the primary; replicas next.',
  });
  await api(page.request, 'PATCH', '/projects/OPS', { repository: repository });
  await api(page.request, 'POST', '/tasks', { project: 'OPS', title: 'Test the failover' });
  m2_1Tasks = (await api<{ items: TaskRef[] }>(page.request, 'GET', '/tasks?project=OPS&limit=100')).items;
  expect(m2_1Tasks.map((task) => task.key).sort()).toEqual([
    'OPS-1',
    'OPS-2',
    'OPS-3',
    'OPS-4',
    'OPS-5',
    'OPS-6',
  ]);
});

test('0.6.0: the M3 and M4 migrations keep every key; a Backlog.md mirror reads the files', async () => {
  test.setTimeout(6 * 60_000);
  await switchTo(release0_6Image);
  await signInAsAdmin(page);

  // Every task keeps its key, title and status, and has no Backlog.md data.
  const list = await api<{ items: (TaskRef & { hidden?: boolean; backlogId?: string | null })[] }>(
    page.request,
    'GET',
    '/tasks?project=OPS&limit=100',
  );
  expect(list.items.map(({ key, title, status }) => ({ key, title, status })).sort(byKey)).toEqual(
    m2_1Tasks.map(({ key, title, status }) => ({ key, title, status })).sort(byKey),
  );
  for (const item of list.items) {
    const task = await api<{ key: string; backlog?: unknown; hidden?: boolean; locked?: string[] }>(
      page.request,
      'GET',
      `/tasks/${item.key}`,
    );
    expect(task).toMatchObject({ key: item.key, backlog: null, hidden: false, locked: [] });
  }
  const projects = await api<{ items: { key: string; repository: string | null; backlog?: unknown }[] }>(
    page.request,
    'GET',
    '/projects',
  );
  expect(projects.items.find((item) => item.key === 'OPS')).toMatchObject({ repository, backlog: null });

  // M2 and M2.1 data survive: the cycle, the comment (with its timeline entry), the milestone.
  expect(
    (await api<{ cycle: { number: number } | null }>(page.request, 'GET', '/tasks/OPS-2')).cycle?.number,
  ).toBe(1);
  const comments = await api<{ items: { body: string }[] }>(page.request, 'GET', '/tasks/OPS-1/comments');
  expect(comments.items.map((comment) => comment.body)).toEqual(['Rotated on the primary; replicas next.']);
  const timeline = await api<{ items: { kind: string; origin?: string }[] }>(
    page.request,
    'GET',
    '/tasks/OPS-1/timeline',
  );
  expect(
    timeline.items.filter((item) => item.kind === 'activity').every((item) => item.origin === 'app'),
  ).toBe(true);

  // The numbering continues, and the project stays editable (no Backlog.md source).
  const created = await api<TaskRef>(page.request, 'POST', '/tasks', {
    project: 'OPS',
    title: 'Drill the restore',
  });
  expect(created.key).toBe('OPS-7');
  await api(page.request, 'PATCH', '/tasks/OPS-3', { status: 'done' });

  // A mirror through the 0.6.0 setup: a git connection, a project linked to the repository, the five steps.
  const host = forgejo as Forgejo;
  await addConnection(page, host, 'Forgejo · e2e upgrade', '/settings/connections');
  await api(page.request, 'POST', '/projects', { ...infra, repository: host.repositoryUrl(infraRepo) });
  await page.goto(`/p/${infra.key}/backlog-setup?mode=mirror`);
  await settle(page);
  await page.getByRole('button', { name: 'Continue' }).click();
  await expect(page.getByText('backlog/').first()).toBeVisible({ timeout: 20_000 });
  await page.getByRole('button', { name: 'Continue' }).click();
  await page.getByRole('button', { name: 'Preview' }).click();
  await expect(page.getByRole('heading', { name: `Mirror 4 tasks into ${infra.name}?` })).toBeVisible({
    timeout: 20_000,
  });
  await page.getByRole('button', { name: 'Start mirroring' }).click();
  await expect(page.getByText(`${infra.name} now mirrors`)).toBeVisible({ timeout: 60_000 });
  await expect.poll(async () => (await sourceStatus()).state, { timeout: 30_000 }).toBe('healthy');

  // 0.6.0 keeps labels, the due date and dependencies in the task's Backlog.md block only.
  const parent = await api<MirroredTask>(page.request, 'GET', '/tasks/INF-1');
  expect(parent.backlog?.data.labels).toEqual(['ops', 'k8s']);
  expect(parent).not.toHaveProperty('labels');
  const runbook = await api<MirroredTask>(page.request, 'GET', '/tasks/INF-2');
  expect(runbook.backlog?.data.dependencies).toHaveLength(1);
  // The sections of INF-3 sit in its description, under ## headings.
  const certs = await api<MirroredTask>(page.request, 'GET', '/tasks/INF-3');
  expect(certs.description).toContain('## Acceptance criteria');
  expect(certs.description).toContain('- [ ] #2 Old certificates are revoked');
  expect(certs.description).toContain('## Final summary');
  for (const key of infraKeys) timelineBefore[key] = await timelineLength(key);

  // An agent key with the 0.6.0 prefix, which works on 0.6.0. The current build refuses it.
  oldApiKey = await addAgent(page, 'upgrade-agent-0-6', ['OPS'], {
    prefix: OLD_API_KEY_PREFIX,
    membersPath: '/settings/members',
  });
  expect(await meStatusWithKey(oldApiKey)).toBe(200);
  workspaceBefore = readWorkspace();
});

test('0.8.0: the rename keeps the mirror, and the sections stay in the description', async () => {
  test.skip(release0_8Missing !== null, release0_8Missing ?? '');
  test.setTimeout(6 * 60_000);
  await switchTo(release0_8Image);
  await signInAsAdmin(page);

  // The rename dropped the pm_live_ prefix.
  expect(await meStatusWithKey(oldApiKey)).toBe(401);
  // The M5 migrations ran here: the mirror's labels are native, with no history lines.
  const parent = await api<MirroredTask>(page.request, 'GET', '/tasks/INF-1');
  expect(parent.labels?.map((label) => label.name).sort()).toEqual(['k8s', 'ops']);
  const certs = await api<MirroredTask>(page.request, 'GET', '/tasks/INF-3');
  expect(certs.description).toContain('## Acceptance criteria');
  expect(certs).not.toHaveProperty('criteria');
  for (const key of infraKeys) expect(await timelineLength(key), key).toBe(timelineBefore[key]);

  // The first refresh on 0.8.0 reads the same files and changes nothing.
  await refreshMirror();
  for (const key of infraKeys) expect(await timelineLength(key), key).toBe(timelineBefore[key]);
  workspaceBefore = readWorkspace();
});

test('0.9.0: the work record migration moves the sections out of the description', async () => {
  test.skip(release0_9Missing !== null, release0_9Missing ?? '');
  test.setTimeout(6 * 60_000);
  await switchTo(release0_9Image);
  await signInAsAdmin(page);

  expect(await meStatusWithKey(oldApiKey)).toBe(401);
  // The M6 migration ran here: INF-3's sections are its work record now, with no history lines.
  const certs = await api<MirroredTask>(page.request, 'GET', '/tasks/INF-3');
  expect(certs.description?.trim()).toBe('Certificates rotate before they expire.');
  expect(certs.criteria).toHaveLength(2);
  for (const key of infraKeys) expect(await timelineLength(key), key).toBe(timelineBefore[key]);

  // 0.9.0 has one workspace and no slug in its URLs: the same slug as before, pages at the old paths.
  const me = await api<{ workspace: { id: string; slug: string } }>(page.request, 'GET', '/me');
  expect(me.workspace).toMatchObject(workspaceBefore ?? {});
  await page.goto('/p/OPS/OPS-1');
  await settle(page);
  await expect(page).toHaveURL(`${upgradeURL}/p/OPS/OPS-1`);
  await expect(page.getByText('Rotated on the primary; replicas next.').first()).toBeVisible();
  workspaceBefore = readWorkspace();
});

test('0.10.0: pages move under the workspace; a task is finished before the M7 migration', async () => {
  test.skip(release0_10Missing !== null, release0_10Missing ?? '');
  test.setTimeout(6 * 60_000);
  await switchTo(release0_10Image);
  await signInAsAdmin(page);

  // The workspaces migration ran here: the same workspace and slug, pages under /w/<slug>/.
  const workspace = readWorkspace();
  expect(workspace).toEqual(workspaceBefore);
  const me = await api<{ workspace: { id: string; slug: string } }>(page.request, 'GET', '/me');
  expect(me.workspace).toMatchObject(workspace);
  await page.goto('/p/OPS/OPS-1');
  await expect(page).toHaveURL(`${upgradeURL}/w/${workspace.slug}/p/OPS/OPS-1`, { timeout: 15_000 });
  await settle(page);
  await expect(page.getByText('Rotated on the primary; replicas next.').first()).toBeVisible();

  // 0.10.0 has no archive setting and no closing time.
  const projects = await api<{ items: Record<string, unknown>[] }>(page.request, 'GET', '/projects');
  expect(projects.items.find((item) => item.key === 'OPS')).not.toHaveProperty('archiveAfterDays');
  const from = Date.now();
  await api(page.request, 'PATCH', '/tasks/OPS-5', { status: 'done' });
  finishedOn0_10 = { from: from - 1_000, to: Date.now() + 1_000 };
  expect(await api<Record<string, unknown>>(page.request, 'GET', '/tasks/OPS-5')).not.toHaveProperty(
    'closedAt',
  );
  workspaceBefore = workspace;
});

test('this build: the M5 migrations backfill the mirror, and every key and route still works', async () => {
  test.setTimeout(6 * 60_000);
  await switchTo(currentImage);

  // The workspaces migration (here, or on 0.10.0 when that step ran), read before anyone signs in on this
  // build: the workspace keeps its slug and needs no alias, and every user's last workspace is their
  // membership.
  const workspace = readWorkspace();
  expect(workspace).toEqual(workspaceBefore);
  const slug = workspace.slug;
  expect(sql('select slug from workspace_slug_alias')).toEqual([]);
  const users = sql(
    'select u.email, coalesce(u.last_workspace_id::text, \'none\') from "user" u order by u.email',
  ).map((row) => row.split('\t'));
  // The admin and the agent added on 0.6.0, both members of the workspace.
  expect(users.length).toBeGreaterThanOrEqual(2);
  for (const [email, last] of users) expect(last, email).toBe(workspace.id);

  await signInAsAdmin(page);
  const me = await api<{ workspace: { id: string; slug: string } }>(page.request, 'GET', '/me');
  expect(me.workspace).toMatchObject(workspace);

  // A pre-0.10 task link opens the same task under the workspace.
  await page.goto('/p/OPS/OPS-1');
  await expect(page).toHaveURL(`${upgradeURL}/w/${slug}/p/OPS/OPS-1`, { timeout: 15_000 });
  await settle(page);
  await expect(page.getByText('Rotated on the primary; replicas next.').first()).toBeVisible();

  // The rename to Zamu: the 0.6.0 pm_live_ key gets 401, and new keys start with zamu_live_ and work. The
  // key list shows 14 characters of the new key.
  expect(await meStatusWithKey(oldApiKey)).toBe(401);
  const newApiKey = await addAgent(page, 'upgrade-agent', ['OPS'], {
    membersPath: w('/settings/members', slug),
  });
  expect(await meStatusWithKey(newApiKey)).toBe(200);
  await page.goto(w('/settings/api-keys', slug));
  await settle(page);
  await expect(page.getByText(`${newApiKey.slice(0, 14)}…`)).toBeVisible();

  // Native tasks have the new fields, empty.
  const ops = await api<MirroredTask>(page.request, 'GET', '/tasks/OPS-1');
  expect(ops).toMatchObject({ labels: [], dueDate: null, parent: null, blockedBy: [], blocked: false });
  expect(ops).toMatchObject({ criteria: [], doneItems: [], plan: null, finalSummary: null });
  const opsList = await api<{ items: TaskRef[] }>(page.request, 'GET', '/tasks?project=OPS&limit=100');
  expect(opsList.items.map((task) => task.key).sort()).toEqual(
    [...m2_1Tasks.map((t) => t.key), 'OPS-7'].sort(),
  );

  // The backfill filled the native fields of the mirrored tasks from their Backlog.md block.
  const parent = await api<MirroredTask>(page.request, 'GET', '/tasks/INF-1');
  expect(
    parent.labels?.map(({ name, source }) => ({ name, source })).sort((a, b) => a.name.localeCompare(b.name)),
  ).toEqual([
    { name: 'k8s', source: 'backlog' },
    { name: 'ops', source: 'backlog' },
  ]);
  expect(parent.dueDate).toBe('2026-12-01');
  const child = await api<MirroredTask>(page.request, 'GET', '/tasks/INF-1.1');
  expect(child.parent?.key).toBe('INF-1');
  expect(child.labels?.map((label) => label.name)).toEqual(['ops']);
  const runbook = await api<MirroredTask>(page.request, 'GET', '/tasks/INF-2');
  expect(runbook.blockedBy?.map((task) => task?.key)).toEqual(['INF-1']);
  expect(runbook.blocked).toBe(true);
  for (const field of ['labels', 'dueDate', 'blockedBy', 'parent']) expect(runbook.locked).toContain(field);
  const labels = await api<{ items: { name: string; source: string; usageCount: number }[] }>(
    page.request,
    'GET',
    `/projects/${infra.key}/labels`,
  );
  expect(labels.items.map(({ name, source, usageCount }) => ({ name, source, usageCount }))).toEqual([
    { name: 'k8s', source: 'backlog', usageCount: 1 },
    { name: 'ops', source: 'backlog', usageCount: 2 },
  ]);
  // The M6 migration (here or on 0.9.0) moved INF-3's sections out of the description into the work record,
  // read-only.
  const certs = await api<MirroredTask>(page.request, 'GET', '/tasks/INF-3');
  expect(certs.description?.trim()).toBe('Certificates rotate before they expire.');
  expect(certs.criteria?.map(({ number, text, state, locked }) => ({ number, text, state, locked }))).toEqual(
    [
      { number: 1, text: 'New certificates are issued', state: 'checked', locked: true },
      { number: 2, text: 'Old certificates are revoked', state: 'open', locked: true },
    ],
  );
  expect(certs.doneItems?.map(({ text, state }) => ({ text, state }))).toEqual([
    { text: 'Runbook updated', state: 'open' },
  ]);
  expect(certs.plan?.trim()).toBe('1. Issue the new certificates.\n2. Revoke the old ones.');
  expect(certs.finalSummary?.trim()).toBe('Rotation is scripted.');
  expect(certs.backlog?.data.implementationNotes?.trim()).toBe('Issued through the internal CA.');

  // The backfills wrote no activity rows.
  for (const key of infraKeys) expect(await timelineLength(key), key).toBe(timelineBefore[key]);

  // The first refresh after the upgrade reads the same files and changes nothing.
  await refreshMirror();
  for (const key of infraKeys) expect(await timelineLength(key), key).toBe(timelineBefore[key]);
  expect((await api<MirroredTask>(page.request, 'GET', '/tasks/INF-1')).labels).toHaveLength(2);
  expect((await api<MirroredTask>(page.request, 'GET', '/tasks/INF-3')).criteria).toHaveLength(2);

  // Later pushes keep the native fields in step with the files.
  const file = 'backlog/tasks/inf-2 - Update-the-runbook.md';
  await (forgejo as Forgejo).commit(infraRepo, 'Label the runbook task', {
    [file]: (backlogFiles[file] as string).replace('labels: []', 'labels:\n  - docs'),
  });
  await refreshMirror();
  const relabelled = await api<MirroredTask>(page.request, 'GET', '/tasks/INF-2');
  expect(relabelled.labels?.map(({ name, source }) => ({ name, source }))).toEqual([
    { name: 'docs', source: 'backlog' },
  ]);
  expect(await timelineLength('INF-2')).toBe((timelineBefore['INF-2'] ?? 0) + 1);

  // The numbering continues on the native project.
  const created = await api<TaskRef>(page.request, 'POST', '/tasks', {
    project: 'OPS',
    title: 'Rotate keys',
  });
  expect(created.key).toBe('OPS-8');

  // The screens render on the upgraded data.
  const pages: [string, RegExp | string][] = [
    ['/', /^Good (morning|afternoon|evening)/],
    ['/p/OPS', 'Rotate the database password'],
    ['/p/OPS?view=board', 'Renew the TLS certificate'],
    ['/p/OPS/OPS-1', 'Rotated on the primary; replicas next.'],
    ['/p/OPS/milestones', 'Hardening'],
    ['/p/OPS/cycles', 'Cycle 1'],
    ['/p/INF', 'Move to the new cluster'],
    ['/p/INF/INF-2', 'Update the runbook'],
    ['/p/INF/INF-3', 'Old certificates are revoked'],
    ['/p/INF/settings/labels', 'k8s'],
    ['/settings/connections', 'Forgejo · e2e upgrade'],
  ];
  for (const [path, text] of pages) {
    await page.goto(w(path, slug));
    await settle(page);
    await expect(page.getByText(text).first(), path).toBeVisible();
  }
  await page.goto(w('/p/OPS/settings', slug));
  await settle(page);
  await expect(page.getByLabel('Repository')).toHaveValue(repository);
});

test('this build: archiving is off on existing projects, finished tasks have closedAt, Repository works', async () => {
  const slug = readWorkspace().slug;
  // The M7 migration sets no archive days on the projects it finds; a new project archives after 14 days.
  const projects = await api<{ items: { key: string; archiveAfterDays?: number | null }[] }>(
    page.request,
    'GET',
    '/projects',
  );
  for (const key of ['OPS', 'INF']) {
    expect(projects.items.find((item) => item.key === key)?.archiveAfterDays ?? null, key).toBeNull();
  }
  await api(page.request, 'POST', '/projects', { name: 'Billing', key: 'BIL' });
  const created = await api<{ items: { key: string; archiveAfterDays?: number | null }[] }>(
    page.request,
    'GET',
    '/projects',
  );
  expect(created.items.find((item) => item.key === 'BIL')?.archiveAfterDays).toBe(14);
  // The preview of the nightly job reads the closing times: every task here was finished today.
  expect(
    await api<{ count: number }>(page.request, 'GET', '/projects/OPS/archive-preview?days=1'),
  ).toMatchObject({ count: 0 });

  // Every Done or Canceled task has the time it was finished, from the history where there is one; open
  // tasks have none.
  const closed: Record<string, string | null> = {};
  const list = await api<{ items: TaskRef[] }>(page.request, 'GET', '/tasks?project=OPS&limit=100');
  for (const item of list.items) {
    closed[item.key] =
      (await api<{ closedAt?: string | null }>(page.request, 'GET', `/tasks/${item.key}`)).closedAt ?? null;
  }
  const finished = list.items.filter((item) => item.status === 'done' || item.status === 'canceled');
  expect(finished.map((item) => item.key).sort()).toEqual(
    ['OPS-3', 'OPS-4', ...(finishedOn0_10 ? ['OPS-5'] : [])].sort(),
  );
  for (const item of list.items) {
    if (finished.includes(item)) expect(closed[item.key], item.key).not.toBeNull();
    else expect(closed[item.key], item.key).toBeNull();
  }
  if (finishedOn0_10) {
    const at = Date.parse(closed['OPS-5'] ?? '');
    expect(at).toBeGreaterThanOrEqual(finishedOn0_10.from);
    expect(at).toBeLessThanOrEqual(finishedOn0_10.to);
  }

  // A project that had a repository before M7: its Repository page reads it, with no event yet and no
  // connection (gitlab.com is read as a public repository). The mirror's switch stays off.
  const settings = await api<{
    repository: string | null;
    provider: string | null;
    connection: unknown;
    closeOnMerge: boolean;
    webhook: { url: string; lastStatus: string | null } | null;
  }>(page.request, 'GET', '/projects/OPS/repository');
  expect(settings).toMatchObject({ repository, provider: 'gitlab', connection: null, closeOnMerge: true });
  expect(settings.webhook?.url).toMatch(new RegExp(`^${upgradeURL}/api/webhooks/repository/\\S+$`));
  expect(settings.webhook?.lastStatus ?? null).toBeNull();
  await page.goto(w('/p/OPS/settings/repository', slug));
  await settle(page);
  await expect(page.getByText('gitlab.com/reddevs/operations').first()).toBeVisible();
  await expect(page.getByText('None: Zamu reads it as a public repository, without a token.')).toBeVisible();
  await expect(page.locator('[data-status]').first()).toContainText('No event received yet.');
  await expect(
    page.getByRole('switch', { name: 'Close tasks when their pull request merges' }),
  ).toBeChecked();
  expect(
    await api<{ mirrored: boolean; closeOnMerge: boolean }>(page.request, 'GET', '/projects/INF/repository'),
  ).toMatchObject({ mirrored: true, closeOnMerge: false });
  await page.goto(w('/p/OPS/settings/archive', slug));
  await settle(page);
  await expect(page.getByRole('switch', { name: 'Archive finished tasks' })).not.toBeChecked();
});
