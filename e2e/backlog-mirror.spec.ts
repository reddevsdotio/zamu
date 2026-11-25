// Backlog.md mirror end to end, against a real Forgejo (e2e/forgejo.ts): a git connection, a project created from
// Backlog.md with a custom status mapped by hand, the mirrored tasks in the list, board and task view, the native
// fields filled from the files (labels, due date, blockers, parent) and read-only in the app, the work record
// filled from the file (criteria, done items, plan, notes, summary) and read-only, a push that arrives through
// the webhook, a new webhook secret (Forgejo deliveries signed with the old one are refused), a broken, a
// deleted and a restored file, the board refusing a status change, cycles and comments on a mirrored task, the
// agent's zamu backlog commands and refused update, a name match in Edit mappings, the switch to Zamu with one
// open pull request in the check, `zamu backlog export` into a local git repository whose folder parses back
// into the same tasks, and deleting the project.
//
// The tests build on each other, so they share one page and run in order. Forgejo starts in beforeAll and is
// removed in afterAll. E2E_SKIP_BACKLOG=1 skips the spec; so does a missing Docker daemon.
import { createHmac } from 'node:crypto';
import { join } from 'node:path';
import { type BrowserContext, expect, type Page, test } from '@playwright/test';
import { parseBacklogFolder, taskWorkRecord } from '../packages/backlog-md/src/index';
import { createCli, parseJson } from './cli';
import { dockerAvailable, type Forgejo, fixtureFolder, readTree, startForgejo } from './forgejo';
import { createGitRepo } from './git-repo';
import { addAgent, admin, api, collectPageErrors, openNewProject, settle, signInAsAdmin } from './session';
import { baseURL, forgejoAliases, mainStack } from './stack';

const repo = 'payments-api';
// The fixture's task prefix is PAY; the key differs so the spec never collides with the M1 flow's PAY project.
const project = { name: 'Payments API', key: 'API' };
const connectionName = 'Forgejo · e2e mirror';
const agentName = 'backlog-agent';
/** Added after the setup, so the stored @codex row ("No one") gets a name match in Edit mappings. */
const codexAgent = 'codex';

/**
 * A task with a status the config adds ("QA"), which no app status matches by name. Its label, due date and
 * dependency become native fields of the mirrored task.
 */
const qaTask = `---
id: PAY-20
title: Rate limit alerts
status: QA
assignee: []
created_date: '2025-09-06 09:00'
labels:
  - alerts
due_date: '2025-09-10'
dependencies:
  - PAY-12
priority: low
---

## Description

<!-- SECTION:DESCRIPTION:BEGIN -->
Alert when a merchant hits the rate limit.
<!-- SECTION:DESCRIPTION:END -->
`;

const parentPath = 'backlog/tasks/pay-12 - Webhook-retries.md';
const subtaskPath = 'backlog/tasks/pay-12.1 - Retry-backoff.md';
const nestedPath = 'backlog/tasks/pay-12.1.2 - Backoff-jitter.md';
const qaPath = 'backlog/tasks/pay-20 - Rate-limit-alerts.md';

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
interface TaskShape {
  key: string;
  title: string;
  description: string | null;
  status: string;
  priority: string;
  assignee: { name: string } | null;
  hidden?: boolean;
  locked?: string[];
  cycle: { number: number } | null;
  backlog: { id: string; file: string | null } | null;
  labels: { id: string; name: string; color: number; source: string }[];
  dueDate: string | null;
  parent: TaskRef | null;
  subtasks: TaskRef[];
  blockedBy: (TaskRef | null)[];
  blocks: (TaskRef | null)[];
  blocked: boolean;
  criteria?: WorkItem[];
  doneItems?: WorkItem[];
  plan?: string | null;
  finalSummary?: string | null;
}
interface MirroredTask extends TaskShape {
  backlog: { id: string; file: string | null; data: { implementationNotes?: string | null } } | null;
}
interface LabelShape {
  id: string;
  name: string;
  color: number;
  source: string;
  usageCount: number;
}
interface SourceStatus {
  state: string;
  lastRead: { commit: string; trigger: string } | null;
  webhookLastAt: string | null;
  problems: { counts: { files: number; values: number } };
}

test.describe.configure({ mode: 'serial' });
test.skip(process.env.E2E_SKIP_BACKLOG === '1', 'E2E_SKIP_BACKLOG=1');
test.skip(!dockerAvailable(), 'Docker is not available: the Backlog.md specs need it to run Forgejo.');

let context: BrowserContext;
let page: Page;
let forgejo: Forgejo;
let files: Record<string, string>;
/** The webhook URL the settings dialog shows. */
let webhookUrl = '';
/** The same URL as Forgejo reaches it on the stack network. */
let hookUrl = '';
/** The Forgejo hook and the secret it signs with. */
let hook = { id: 0, secret: '' };
const pageErrors: string[] = [];
const cli = createCli();

async function taskOf(key: string): Promise<TaskShape> {
  return api<TaskShape>(page.request, 'GET', `/tasks/${key}`);
}

async function sourceStatus(): Promise<SourceStatus> {
  return api<SourceStatus>(page.request, 'GET', `/projects/${project.key}/backlog`);
}

/** The task list row of a task. */
function listRow(key: string) {
  return page
    .getByRole('treegrid', { name: `Tasks in ${project.name}` })
    .locator(`[role="row"][data-task-key="${key}"]`);
}

/** The task view's Properties sidebar. */
function properties() {
  return page.getByRole('complementary', { name: 'Properties' });
}

/** A PATCH that the server must refuse with 409 TASK_MIRRORED for `field`. */
async function expectMirroredRefusal(key: string, data: Record<string, unknown>, field: string) {
  const response = await page.request.patch(`/api/v1/tasks/${key}`, { data });
  expect(response.status(), await response.text()).toBe(409);
  expect(await response.json()).toMatchObject({ code: 'TASK_MIRRORED', field });
}

/** Reloads `path` until `check` passes: open pages only see a refresh on their next refetch. */
async function reloadUntil(path: string, check: () => Promise<void>, timeout: number): Promise<void> {
  await expect(async () => {
    await page.goto(path);
    await settle(page);
    await check();
  }).toPass({ timeout, intervals: [1_000, 2_000] });
}

/** Adds a push webhook to the repository, signed with `secret`. Returns its id. */
async function addHook(secret: string): Promise<number> {
  const created = await forgejo.api<{ id: number }>('POST', `/repos/${forgejo.user}/${repo}/hooks`, {
    type: 'forgejo',
    active: true,
    events: ['push'],
    branch_filter: 'main',
    config: { url: hookUrl, content_type: 'json', secret },
  });
  return created.id;
}

/** Posts a Forgejo "issues" event signed with `secret` to the webhook URL and returns the status code. */
async function signedDelivery(secret: string): Promise<number> {
  const body = JSON.stringify({ action: 'opened' });
  const response = await page.request.post(webhookUrl, {
    data: body,
    headers: {
      'content-type': 'application/json',
      'x-forgejo-event': 'issues',
      'x-forgejo-signature': createHmac('sha256', secret).update(body).digest('hex'),
    },
  });
  return response.status();
}

/** Presses Refresh now in the project header's Backlog.md popover and waits for the read to finish. */
async function refreshNow(): Promise<void> {
  const before = (await sourceStatus()).lastRead?.commit;
  await page.goto(`/p/${project.key}`);
  await settle(page);
  await page.getByRole('button', { name: /^Backlog\.md: / }).click();
  const popover = page.getByRole('dialog', { name: 'Backlog.md mirror' });
  await popover.getByRole('button', { name: 'Refresh now' }).click();
  await expect
    .poll(async () => (await sourceStatus()).lastRead?.commit, { timeout: 90_000, intervals: [1_000] })
    .not.toBe(before);
  await page.keyboard.press('Escape');
}

test.beforeAll(async ({ browser }) => {
  test.setTimeout(5 * 60_000);
  forgejo = await startForgejo('mirror', mainStack.network, forgejoAliases.mirror);
  files = {
    'README.md': '# Payments API\n',
    ...Object.fromEntries(Object.entries(readTree(fixtureFolder)).map(([path, text]) => [path, text])),
    [qaPath]: qaTask,
  };
  files['backlog/config.yml'] = (files['backlog/config.yml'] as string).replace(
    'statuses: ["To Do", "In Progress", "In Review", "Done"]',
    'statuses: ["To Do", "In Progress", "QA", "In Review", "Done"]',
  );
  await forgejo.createRepository(repo, files);

  context = await browser.newContext({
    permissions: ['clipboard-read', 'clipboard-write'],
    timezoneId: 'UTC',
  });
  page = await context.newPage();
  collectPageErrors(page, pageErrors, [
    // Refused writes (409) and the rejected token (422) show as resource errors on purpose.
    /status of 409\b/,
    /status of 422\b/,
  ]);
});

// biome-ignore lint/correctness/noEmptyPattern: Playwright requires an object pattern as the first argument.
test.afterEach(async ({}, testInfo) => {
  if (testInfo.status !== testInfo.expectedStatus && page) {
    await testInfo.attach('page at failure', { body: await page.screenshot(), contentType: 'image/png' });
  }
});

test.afterAll(async () => {
  await context?.close();
  cli.dispose();
  if (process.env.E2E_KEEP_STACK === '1') {
    console.log('[e2e] leaving the mirror spec Forgejo running; the next pnpm e2e run removes it');
    return;
  }
  forgejo?.stop();
});

test('git connection: a wrong token is rejected, the right one works', async () => {
  await signInAsAdmin(page);
  await page.goto('/settings/connections');
  await settle(page);
  await page.getByRole('button', { name: 'Add connection' }).first().click();
  const dialog = page.getByRole('dialog', { name: 'Add git connection' });
  await expect(dialog).toBeVisible();
  await dialog.getByRole('radio', { name: 'Gitea / Forgejo' }).check({ force: true });
  await dialog.getByLabel('Host').fill(forgejo.host);
  await dialog.getByLabel('Name').fill(connectionName);
  await dialog.getByLabel('Access token').fill(`${forgejo.token.slice(0, -6)}000000`);
  await dialog.getByRole('button', { name: 'Test' }).click();
  await expect(dialog.getByRole('alert')).toContainText('Token rejected.');

  await dialog.getByLabel('Access token').fill(forgejo.token);
  await dialog.getByRole('button', { name: 'Test' }).click();
  await expect(dialog.getByRole('status')).toContainText(`Working. Signed in as ${forgejo.user}`);
  await dialog.getByRole('button', { name: 'Save connection' }).click();
  await expect(dialog).toBeHidden();

  const table = page.getByRole('table', { name: 'Git connections' });
  const row = table.getByRole('row').filter({ hasText: connectionName });
  await expect(row).toContainText('Working');
  await expect(row).toContainText(forgejo.host);
});

test('new project from Backlog.md: map the custom status, preview, start mirroring', async () => {
  // New from Backlog.md sits in the sidebar's "+" (the projects page is gone in 0.7.0).
  await page.goto('/');
  await settle(page);
  await openNewProject(page, 'New from Backlog.md');
  const dialog = page.getByRole('dialog', { name: 'New project from Backlog.md' });
  await dialog.getByLabel('Repository').fill(forgejo.repositoryUrl(repo));
  // The connection is picked by host, and the detection reads project_name from config.yml.
  await expect(dialog.getByText('From project_name in config.yml.')).toBeVisible({ timeout: 20_000 });
  await expect(dialog.getByLabel('Name')).toHaveValue(project.name);
  await dialog.getByLabel('Key').fill(project.key);
  await dialog.getByRole('radio', { name: /Mirror/ }).check({ force: true });
  await dialog.getByRole('button', { name: 'Create and continue' }).click();

  // Setup opens at the mappings step.
  await expect(page).toHaveURL(new RegExp(`/p/${project.key}/backlog-setup`), { timeout: 20_000 });
  await settle(page);
  await expect(page.getByRole('heading', { name: `Mirror Backlog.md into ${project.name}` })).toBeVisible();
  // QA matches no app status by name, so it starts on the fallback (Todo).
  const statusMapping = page.getByRole('group', { name: 'Status mapping' });
  const qa = statusMapping.getByRole('button', { name: /QA maps to/ });
  await expect(qa).toHaveAccessibleName(/^Todo/);
  await qa.click();
  await page.getByRole('option', { name: /In review/ }).click();
  await expect(qa).toHaveAccessibleName(/^In review/);
  // @alex is nobody here until mapped by hand; @codex stays unassigned (a fallback with a warning).
  const alex = page
    .getByRole('group', { name: 'Assignee mapping' })
    .getByRole('button', { name: /@alex maps to/ });
  await alex.click();
  await page.getByRole('option', { name: new RegExp(admin.name) }).click();
  await expect(alex).toHaveAccessibleName(new RegExp(`^${admin.name}`));

  await page.getByRole('button', { name: 'Preview' }).click();
  // Six tasks: three in tasks/ (one with a nested subtask), the QA task, an archived one and a draft.
  await expect(page.getByRole('heading', { name: `Mirror 6 tasks into ${project.name}?` })).toBeVisible({
    timeout: 20_000,
  });
  const sample = page.getByRole('region', { name: 'Sample' });
  await expect(sample.getByRole('listitem').filter({ hasText: 'PAY-20' })).toContainText('In review');
  await expect(sample.getByRole('listitem').filter({ hasText: 'DRAFT-1' })).toContainText(
    `${project.key}-21`,
  );

  await page.getByRole('button', { name: 'Start mirroring' }).click();
  await expect(page.getByText(`${project.name} now mirrors`)).toBeVisible({ timeout: 60_000 });
  await page.getByRole('button', { name: `Open ${project.name}` }).click();
  await expect(page).toHaveURL(new RegExp(`/p/${project.key}(\\?|$)`));

  // @codex has no match, so the mirror runs with one value warning.
  const status = await sourceStatus();
  expect(status).toMatchObject({ state: 'warnings', problems: { counts: { files: 0, values: 1 } } });
  expect(status.lastRead?.commit).toBe(await forgejo.head(repo));
});

test('list, board and task view show the mirrored tasks', async () => {
  // Backlog.md numbers become app keys; the draft takes the next number above the highest task.
  expect(await taskOf(`${project.key}-12`)).toMatchObject({
    title: 'Webhook retries',
    status: 'in_review',
    priority: 'high',
    assignee: { name: admin.name },
  });
  expect(await taskOf(`${project.key}-12.1`)).toMatchObject({
    title: 'Retry backoff',
    status: 'in_progress',
  });
  expect(await taskOf(`${project.key}-12.1.2`)).toMatchObject({ title: 'Backoff jitter', status: 'todo' });
  expect(await taskOf(`${project.key}-20`)).toMatchObject({
    title: 'Rate limit alerts',
    status: 'in_review',
  });
  expect(await taskOf(`${project.key}-21`)).toMatchObject({ title: 'Signed webhooks', status: 'backlog' });
  expect(await taskOf(`${project.key}-3`)).toMatchObject({ title: 'Legacy callbacks', status: 'done' });
  // Backlog.md IDs work wherever a key does.
  expect((await taskOf('PAY-12.1')).key).toBe(`${project.key}-12.1`);

  await page.goto(`/p/${project.key}`);
  await settle(page);
  await expect(page.getByRole('button', { name: 'Backlog.md: Mirroring, with problems' })).toBeVisible();
  // New explains instead of creating: tasks come from the files.
  await expect(page.getByRole('button', { name: 'New task', exact: true })).toBeDisabled();
  // Backlog and Done start folded: the draft and the archived task sit there. Subtasks nest under their
  // parent, whatever their status.
  for (const key of ['12', '12.1', '12.1.2', '20']) {
    await expect(listRow(`${project.key}-${key}`)).toBeVisible();
  }
  await expect(listRow(`${project.key}-12`)).toHaveAttribute('aria-level', '2');
  await expect(listRow(`${project.key}-12.1`)).toHaveAttribute('aria-level', '3');

  // The board hides subtasks: the parent card counts them and expands in place.
  await page.goto(`/p/${project.key}?view=board`);
  await settle(page);
  const inReview = page.getByRole('grid', { name: 'In review', exact: true });
  await expect(inReview.locator(`[data-card-key="${project.key}-12"]`)).toBeVisible();
  await expect(page.locator(`[data-card-key="${project.key}-12.1"]`)).toHaveCount(0);
  await inReview.getByRole('button', { name: `Show the 1 subtask of ${project.key}-12, 0 done` }).click();
  await expect(
    inReview.getByRole('button', { name: `${project.key}-12.1 Retry backoff, In progress` }),
  ).toBeVisible();

  // The task view: one quiet Backlog.md badge that links to the file, and the file's other fields in
  // "From the file".
  await page.goto(`/p/${project.key}/${project.key}-12`);
  await settle(page);
  await expect(page.getByRole('heading', { level: 1, name: /Webhook retries/ })).toBeVisible();
  await expect(page.getByRole('link', { name: 'Backlog.md', exact: true })).toHaveAttribute(
    'href',
    /pay-12%20-%20Webhook-retries\.md$/,
  );
  await expect(
    page
      .getByRole('region', { name: 'Activity' })
      .getByText('imported this from backlog/tasks/pay-12 - Webhook-retries.md'),
  ).toBeVisible();
  await expect(properties().getByRole('region', { name: 'From the file' })).toBeVisible();
});

test('labels, due date, blockers and parent come from the files and are read-only', async () => {
  const parent = await taskOf(`${project.key}-12`);
  const qa = await taskOf(`${project.key}-20`);
  // The labels of the files are the project's labels, created with locked names.
  expect(parent.labels).toEqual([expect.objectContaining({ name: 'webhooks', source: 'backlog' })]);
  expect(qa.labels).toEqual([expect.objectContaining({ name: 'alerts', source: 'backlog' })]);
  expect(qa.dueDate).toBe('2025-09-10');
  // dependencies: PAY-12 is open, so PAY-20 is blocked; PAY-12 shows the reverse.
  expect(qa.blockedBy.map((task) => task?.key)).toEqual([`${project.key}-12`]);
  expect(qa.blocked).toBe(true);
  expect(parent.blocks.map((task) => task?.key)).toContain(`${project.key}-20`);
  // PAY-12 waits on the archived PAY-3, which is done: not blocked.
  expect(parent.blockedBy.map((task) => task?.key)).toEqual([`${project.key}-3`]);
  expect(parent.blocked).toBe(false);
  // parent_task_id and dotted ids give the parent; the nested subtask keeps its own parent.
  expect((await taskOf(`${project.key}-12.1`)).parent?.key).toBe(`${project.key}-12`);
  expect((await taskOf(`${project.key}-12.1.2`)).parent?.key).toBe(`${project.key}-12.1`);
  expect(parent.subtasks.map((task) => task.key)).toEqual([`${project.key}-12.1`]);
  for (const field of ['labels', 'dueDate', 'blockedBy', 'parent']) expect(qa.locked).toContain(field);

  // The API refuses every one of them, and bulk changes stay native-only.
  await expectMirroredRefusal(qa.key, { addLabels: ['urgent'] }, 'labels');
  await expectMirroredRefusal(qa.key, { dueDate: null }, 'dueDate');
  await expectMirroredRefusal(qa.key, { removeBlockers: [parent.key] }, 'blockedBy');
  await expectMirroredRefusal(`${project.key}-12.1`, { parent: null }, 'parent');
  const bulk = await page.request.post('/api/v1/tasks/bulk', {
    data: { keys: [parent.key, qa.key], priority: 'urgent' },
  });
  expect(bulk.status(), await bulk.text()).toBe(409);
  expect(await bulk.json()).toMatchObject({ code: 'TASK_MIRRORED' });

  // The list shows them like native fields: the label, the overdue date and the Blocked marker.
  await page.goto(`/p/${project.key}`);
  await settle(page);
  await expect(listRow(qa.key)).toContainText('alerts');
  await expect(listRow(qa.key)).toContainText(/\d+ days overdue/);
  await expect(listRow(qa.key)).toContainText('Blocked');

  // In the task view the fields say where they are set; the label picker opens read-only.
  await page.goto(`/p/${project.key}/${qa.key}`);
  await settle(page);
  const labels = properties().getByRole('button', { name: 'Labels, set in Backlog.md' });
  await expect(labels).toContainText('alerts');
  await expect(properties().getByRole('button', { name: 'Due, set in Backlog.md' })).toContainText(
    'Sep 10, 2025',
  );
  await expect(page.getByRole('region', { name: 'Blocked by' }).getByRole('link')).toContainText(
    `${project.key}-12`,
  );
  // Trying to edit one shows the lock.
  await labels.click();
  await expect(page.getByRole('tooltip')).toHaveText('Set in Backlog.md. Edit the file to change it.');

  // In the list, L on the task opens the label picker read-only.
  await page.goto(`/p/${project.key}`);
  await settle(page);
  await listRow(qa.key).focus();
  await page.keyboard.press('l');
  const picker = page.getByRole('dialog', { name: 'Labels' });
  await expect(picker.getByRole('note')).toContainText('Read-only: fields come from Backlog.md');
  await expect(picker.getByRole('menuitemcheckbox', { name: /^alerts/ })).toBeDisabled();
  await page.keyboard.press('Escape');
  await expect(picker).toBeHidden();

  // Settings > Labels: names from the files are locked; their colour is the app's own.
  await page.goto(`/p/${project.key}/settings/labels`);
  await settle(page);
  const table = page.getByRole('table', { name: 'Labels' });
  const row = table.getByRole('row').filter({ hasText: 'alerts' });
  await expect(row).toContainText('From Backlog.md');
  await expect(row.getByRole('button', { name: 'Rename “alerts”' })).toHaveCount(0);
  await expect(
    row.getByRole('button', { name: '“alerts” comes from Backlog.md. Rename or remove it in the files.' }),
  ).toBeVisible();
  const list = await api<{ items: LabelShape[] }>(page.request, 'GET', `/projects/${project.key}/labels`);
  const alerts = list.items.find((label) => label.name === 'alerts');
  expect(alerts).toMatchObject({ source: 'backlog', usageCount: 1 });
  const rename = await page.request.patch(`/api/v1/projects/${project.key}/labels/${alerts?.id}`, {
    data: { name: 'alarms' },
  });
  expect(rename.status(), await rename.text()).toBe(409);
  expect(await rename.json()).toMatchObject({ code: 'LABEL_MIRRORED' });
  const color = alerts?.color === 5 ? 6 : 5;
  const recoloured = await api<LabelShape>(
    page.request,
    'PATCH',
    `/projects/${project.key}/labels/${alerts?.id}`,
    { color },
  );
  expect(recoloured).toMatchObject({ name: 'alerts', color });
});

test('the work record comes from the file and is read-only', async () => {
  // PAY-12's Acceptance Criteria, Definition of Done, plan, notes and summary sections fill the work record;
  // the description keeps only the Description section (its fenced "## Acceptance Criteria" is content).
  const parent = await api<MirroredTask>(page.request, 'GET', `/tasks/${project.key}-12`);
  expect(
    parent.criteria?.map(({ number, text, state, locked }) => ({ number, text, state, locked })),
  ).toEqual([
    { number: 1, text: 'Failed deliveries are retried', state: 'checked', locked: true },
    { number: 2, text: 'Retries back off exponentially', state: 'open', locked: true },
  ]);
  expect(parent.doneItems?.map(({ text, state }) => ({ text, state }))).toEqual([
    { text: 'Tests pass', state: 'open' },
  ]);
  expect(parent.plan).toBe('1. Add a retry queue.\n2. Schedule with backoff.');
  // The fixture's "## Testing" section, which Backlog.md doesn't know, comes after the summary in the file.
  expect(parent.finalSummary).toMatch(/^Retries ship behind a flag\./);
  expect(parent.backlog?.data.implementationNotes).toBe('Queue lives in Redis.');
  expect(parent.description).toContain('Retry failed webhook deliveries with backoff.');
  expect(parent.description).not.toContain('## Acceptance criteria');
  expect(parent.description).not.toContain('Retries back off exponentially');
  expect(parent.description).not.toContain('## Implementation plan');

  // Every work-record write is refused, notes too; ordinary comments still work (see below).
  await expectMirroredRefusal(parent.key, { checkCriteria: [2] }, 'criteria');
  await expectMirroredRefusal(parent.key, { addDoneItems: ['Docs updated'] }, 'doneItems');
  await expectMirroredRefusal(parent.key, { plan: 'Another plan' }, 'plan');
  await expectMirroredRefusal(parent.key, { finalSummary: null }, 'finalSummary');
  const note = await page.request.post(`/api/v1/tasks/${parent.key}/comments`, {
    data: { body: 'Backoff verified', kind: 'note' },
  });
  expect(note.status(), await note.text()).toBe(409);
  expect(await note.json()).toMatchObject({ code: 'TASK_MIRRORED', field: 'notes', file: parentPath });

  // The task view shows the lists read-only, with the file as their source.
  await page.goto(`/p/${project.key}/${parent.key}`);
  await settle(page);
  const criteria = page.locator('[data-work-list="criterion"]');
  await expect(criteria).toContainText('Retries back off exponentially');
  await expect(criteria).toContainText('from the file');
  await expect(criteria.getByRole('checkbox', { name: 'Retries back off exponentially' })).toHaveAttribute(
    'aria-readonly',
    'true',
  );
  await expect(page.locator('[data-work-list="done"]')).toContainText('Tests pass');
  await expect(page.getByText('Retries ship behind a flag.')).toBeVisible();
});

test('webhook: a push shows up within seconds', async () => {
  await page.goto(`/p/${project.key}/settings/backlog?webhook=1`);
  await settle(page);
  const dialog = page.getByRole('dialog', { name: 'Refresh on every push' });
  await expect(dialog).toBeVisible();
  const url =
    (await dialog.getByRole('group', { name: 'URL' }).locator('span.select-all').textContent()) ?? '';
  webhookUrl = url;
  expect(url).toMatch(new RegExp(`^${baseURL}/api/webhooks/backlog/\\S+$`));
  const secretField = dialog.getByRole('group', { name: 'Secret token' });
  await secretField.getByRole('button', { name: 'Show' }).click();
  const secret = ((await secretField.locator('span.select-all').textContent()) ?? '').trim();
  expect(secret.length).toBeGreaterThan(16);

  // Forgejo reaches the web container by its service name on the stack network.
  hookUrl = `http://web:3000${new URL(url).pathname}`;
  hook = { id: await addHook(secret), secret };

  const commit = await forgejo.commit(repo, 'Rename the backoff subtask', {
    [subtaskPath]: (files[subtaskPath] as string).replace(
      'title: Retry backoff',
      'title: Retry with backoff',
    ),
  });
  // The dialog polls for the delivery and turns its last line green.
  await expect(dialog.getByText(/Last notification received/)).toBeVisible({ timeout: 10_000 });
  await page.keyboard.press('Escape');

  // The refresh runs in the worker; the list shows it on its next load.
  await reloadUntil(
    `/p/${project.key}`,
    async () => {
      await expect(listRow(`${project.key}-12.1`)).toContainText('Retry with backoff', { timeout: 1_000 });
    },
    15_000,
  );
  const status = await sourceStatus();
  expect(status.lastRead).toMatchObject({ commit, trigger: 'webhook' });
});

test('new webhook secret: deliveries signed with the old one are refused, the new one works', async () => {
  // A webhook push within a minute of the last one waits for the next slot.
  test.setTimeout(3 * 60_000);
  await page.goto(`/p/${project.key}/settings/backlog?webhook=1`);
  await settle(page);
  const dialog = page.getByRole('dialog', { name: 'Refresh on every push' });
  await dialog.getByRole('button', { name: 'New secret' }).click();
  const confirm = page.getByRole('alertdialog', { name: 'Issue a new webhook secret?' });
  await expect(confirm).toContainText(
    'The current secret stops working at once. Webhooks fail until you paste the new secret into the git ' +
      'host. Mirrors still refresh every hour.',
  );
  await confirm.getByRole('button', { name: 'Issue new secret' }).click();
  await expect(confirm).toBeHidden();
  await expect(dialog.getByText('Paste this into the webhook settings on Gitea / Forgejo.')).toBeVisible();
  // Shown unmasked right away; the URL stays.
  const secretField = dialog.getByRole('group', { name: 'Secret token' });
  const secret = ((await secretField.locator('span.select-all').textContent()) ?? '').trim();
  expect(secret.length).toBeGreaterThan(16);
  expect(secret).not.toBe(hook.secret);
  await expect(dialog.getByRole('group', { name: 'URL' }).locator('span.select-all')).toHaveText(webhookUrl);
  await page.keyboard.press('Escape');

  // Forgejo still signs with the old secret: the push is refused, so no delivery is recorded.
  const before = await sourceStatus();
  await forgejo.commit(repo, 'Cap the backoff', {
    [subtaskPath]: (files[subtaskPath] as string).replace(
      'title: Retry backoff',
      'title: Retry with capped backoff',
    ),
  });
  // Forgejo delivered the last push within a second or two; give it ample time to try this one.
  await page.waitForTimeout(10_000);
  const after = await sourceStatus();
  expect(after.webhookLastAt).toBe(before.webhookLastAt);
  // The same check by hand: a delivery signed with the old secret gets 404.
  expect(await signedDelivery(hook.secret)).toBe(404);

  // Forgejo's API cannot change a hook's secret (only its URL and content type), so replace the hook.
  const oldSecret = hook.secret;
  await forgejo.api('DELETE', `/repos/${forgejo.user}/${repo}/hooks/${hook.id}`);
  hook = { id: await addHook(secret), secret };
  const accepted = await forgejo.commit(repo, 'Jitter the backoff', {
    [subtaskPath]: (files[subtaskPath] as string).replace(
      'title: Retry backoff',
      'title: Retry with jittered backoff',
    ),
  });
  await expect
    .poll(async () => (await sourceStatus()).webhookLastAt, { timeout: 15_000 })
    .not.toBe(before.webhookLastAt);
  await expect
    .poll(async () => (await sourceStatus()).lastRead, { timeout: 90_000, intervals: [1_000] })
    .toMatchObject({ commit: accepted, trigger: 'webhook' });
  expect((await taskOf(`${project.key}-12.1`)).title).toBe('Retry with jittered backoff');
  expect(await signedDelivery(secret)).toBe(204);
  expect(await signedDelivery(oldSecret)).toBe(404);

  // Later steps refresh on request: webhook pushes within a minute of each other wait for the next slot.
  await forgejo.api('DELETE', `/repos/${forgejo.user}/${repo}/hooks/${hook.id}`);
});

test('a broken file is listed under problems; a deleted file hides its task; restoring brings it back', async () => {
  await forgejo.commit(repo, 'Break the QA task', { [qaPath]: 'not a task file\n' });
  await refreshNow();
  expect((await sourceStatus()).problems.counts.files).toBe(1);
  // The task keeps its last good version.
  expect(await taskOf(`${project.key}-20`)).toMatchObject({ title: 'Rate limit alerts', hidden: false });
  await page.goto(`/p/${project.key}/settings/backlog`);
  await settle(page);
  await expect(page.getByRole('region', { name: 'Problems in the last refresh' })).toContainText(qaPath);

  await forgejo.commit(repo, 'Drop the QA task', { [qaPath]: null });
  await refreshNow();
  expect((await sourceStatus()).problems.counts.files).toBe(0);
  expect(await taskOf(`${project.key}-20`)).toMatchObject({ hidden: true });
  await page.goto(`/p/${project.key}`);
  await settle(page);
  await expect(listRow(`${project.key}-20`)).toHaveCount(0);
  await page.goto(`/p/${project.key}?hidden=only`);
  await settle(page);
  await expect(listRow(`${project.key}-20`)).toBeVisible();
  await page.goto(`/p/${project.key}/${project.key}-20`);
  await settle(page);
  await expect(page.getByText(/Removed from Backlog\.md/).first()).toBeVisible();

  await forgejo.commit(repo, 'Bring the QA task back', { [qaPath]: qaTask });
  await refreshNow();
  expect(await taskOf(`${project.key}-20`)).toMatchObject({ title: 'Rate limit alerts', hidden: false });
  await page.goto(`/p/${project.key}`);
  await settle(page);
  await expect(listRow(`${project.key}-20`)).toBeVisible();
});

test('the board refuses a status change; cycles and comments work on a mirrored task', async () => {
  const key = `${project.key}-12.1`;
  const card = `${project.key}-20`;
  await page.goto(`/p/${project.key}?view=board`);
  await settle(page);
  // Show every column, so Shift+← has In progress to move to.
  await page.getByRole('button', { name: 'Display' }).click();
  const display = page.getByRole('dialog', { name: 'Display options' });
  await display.getByRole('switch', { name: 'Show empty columns' }).click({ force: true });
  await expect(display.getByRole('switch', { name: 'Show empty columns' })).toBeChecked();
  await page.keyboard.press('Escape');
  const target = page.locator(`[data-card-key="${card}"]`);
  await target.focus();
  await expect(target).toBeFocused();
  await page.keyboard.press('Shift+ArrowLeft');
  await expect(page.getByText(`${card} stays in In review: its status comes from Backlog.md.`)).toBeVisible();
  expect((await taskOf(card)).status).toBe('in_review');

  // The API refuses the same change with the explanation and the file.
  const refused = await page.request.patch(`/api/v1/tasks/${key}`, { data: { status: 'done' } });
  expect(refused.status()).toBe(409);
  expect(await refused.json()).toMatchObject({ code: 'TASK_MIRRORED', field: 'status', file: subtaskPath });

  // Cycles and comments are the app's own.
  const today = new Date().toISOString().slice(0, 10);
  await api(page.request, 'PATCH', `/projects/${project.key}`, { usesCycles: true });
  await api(page.request, 'POST', `/projects/${project.key}/cycles`, { startsOn: today });
  await api(page.request, 'PATCH', `/tasks/${key}`, { cycle: 'current' });
  expect((await taskOf(key)).cycle?.number).toBe(1);

  await page.goto(`/p/${project.key}/${key}`);
  await settle(page);
  await page.keyboard.press('m');
  const composer = page.getByRole('textbox', { name: 'Comment' });
  await expect(composer).toBeFocused();
  await expect(composer).toHaveAttribute('placeholder', /stays in the app/);
  await composer.fill('Backoff caps at 30 seconds.');
  await page.keyboard.press('Control+Enter');
  await expect(
    page.getByRole('region', { name: 'Activity' }).getByText('Backoff caps at 30 seconds.'),
  ).toBeVisible();
});

test('agent: zamu backlog status and refresh --wait; zamu refuses a mirrored field with exit code 6', async () => {
  const apiKey = await addAgent(page, agentName, [project.key]);
  const login = cli.run(['login', '--key', apiKey, '--url', baseURL, '--json']);
  expect(login.code, login.stdout + login.stderr).toBe(0);

  const status = cli.run(['backlog', 'status', '--project', project.key, '--json']);
  expect(status.code, status.stdout + status.stderr).toBe(0);
  expect(parseJson<{ state: string; mode: string }>(status, 'zamu.v1.backlog.status')).toMatchObject({
    mode: 'mirror',
    state: 'warnings',
  });

  const commit = await forgejo.commit(repo, 'Agent edits the jitter task', {
    [nestedPath]: (files[nestedPath] as string).replace('status: To Do', 'status: In Progress'),
  });
  const refresh = cli.run(['backlog', 'refresh', '--project', project.key, '--wait', '--json']);
  expect(refresh.code, refresh.stdout + refresh.stderr).toBe(0);
  const result = parseJson<{ outcome: string; status: { lastRead: { commit: string } } }>(
    refresh,
    'zamu.v1.backlog.refresh',
  );
  expect(result.outcome).toBe('finished');
  expect(result.status.lastRead.commit).toBe(commit);
  expect((await taskOf(`${project.key}-12.1.2`)).status).toBe('in_progress');

  const update = cli.run(['tasks', 'update', 'PAY-12.1.2', '--status', 'done']);
  expect(update.code, update.stdout + update.stderr).toBe(6);
  expect(update.stderr).toContain('error:');
  expect(update.stderr).toContain(nestedPath);

  const comment = cli.run(['comments', 'add', 'PAY-12.1.2', 'Jitter is in.', '--json']);
  expect(comment.code, comment.stdout + comment.stderr).toBe(0);

  // The work record of a mirrored task is written in the file: notes and criteria exit 6 too.
  const note = cli.run(['notes', 'add', 'PAY-12', 'Backoff verified']);
  expect(note.code, note.stdout + note.stderr).toBe(6);
  const check = cli.run(['tasks', 'update', 'PAY-12', '--check-ac', '2']);
  expect(check.code, check.stdout + check.stderr).toBe(6);
  expect(check.stderr).toContain('--check-ac 2');
  // A project that still mirrors has no export: its files are the source.
  const exported = cli.run(['backlog', 'export', '--project', project.key, '--dry-run', '--json']);
  expect(exported.code, exported.stdout + exported.stderr).toBe(6);
  expect(parseJson<{ code: string }>(exported, 'zamu.v1.error').code).toBe('PROJECT_MIRRORED');
});

test('Edit mappings: an agent added later matches the "No one" row of @codex by name', async () => {
  await addAgent(page, codexAgent, [project.key]);
  await page.goto(`/p/${project.key}/settings/backlog`);
  await settle(page);
  await page.getByRole('link', { name: 'Edit mappings' }).click();
  await expect(
    page.getByRole('heading', { name: `Edit Backlog.md mappings for ${project.name}` }),
  ).toBeVisible();
  await settle(page);
  const codex = page
    .getByRole('group', { name: 'Assignee mapping' })
    .getByRole('button', { name: /@codex maps to/ });
  await expect(codex).toHaveAccessibleName(/^No one/);
  const line = page
    .getByRole('region', { name: 'Name matches' })
    .getByRole('listitem')
    .filter({ hasText: '@codex may be' });
  await expect(line).toContainText(`@codex may be ${codexAgent}.`);
  await line.getByRole('button', { name: `Map to ${codexAgent}` }).click();
  await expect(codex).toHaveAccessibleName(new RegExp(`^${codexAgent}`));
  await expect(line).toHaveCount(0);
  await page.getByRole('button', { name: 'Save mappings' }).click();
  // Saving goes back to the project settings.
  await expect(page).toHaveURL(new RegExp(`/p/${project.key}/settings`), { timeout: 15_000 });

  // Saving queues a refresh, which applies it: no value falls back any more. @alex still comes first on
  // PAY-12, so its assignee stays.
  await expect
    .poll(async () => (await sourceStatus()).problems.counts.values, { timeout: 90_000, intervals: [1_000] })
    .toBe(0);
  expect((await taskOf(`${project.key}-12`)).assignee?.name).toBe(admin.name);
});

test('the delete dialog of a mirrored project asks to remove the webhook too', async () => {
  await page.goto(`/p/${project.key}/settings`);
  await settle(page);
  await page.getByRole('button', { name: 'Delete project' }).click();
  const dialog = page.getByRole('alertdialog', { name: `Delete ${project.key}?` });
  await expect(dialog).toContainText('Remove the webhook on the git host too.');
  await dialog.getByRole('button', { name: 'Cancel' }).click();
  await expect(dialog).toBeHidden();
});

test('switch to Zamu: the check lists the open pull request; afterwards every field is editable', async () => {
  // An open pull request that edits a task file: its edit would never arrive after the switch.
  const pull = {
    branch: 'agent/cap-jitter',
    title: 'Cap the backoff jitter',
    changes: {
      [nestedPath]: (files[nestedPath] as string).replace('title: Backoff jitter', 'title: Capped jitter'),
    },
  };
  const number = await forgejo.openPullRequest(repo, pull);

  await page.goto(`/p/${project.key}/settings/backlog`);
  await settle(page);
  await page.getByRole('button', { name: 'Switch to Zamu…' }).click();
  const dialog = page.getByRole('alertdialog');
  await expect(dialog.getByRole('heading', { name: `Switch ${project.name} to Zamu` })).toBeVisible();
  const confirm = dialog.getByLabel(`Type ${project.key} to confirm`);
  const submit = dialog.getByRole('button', { name: 'Switch to Zamu', exact: true });
  await expect(dialog.getByRole('status')).toContainText(
    '1 open pull request changes task files. Its task edits will be lost.',
    { timeout: 30_000 },
  );
  const requests = dialog.getByRole('list', { name: 'Open requests that change task files' });
  await expect(requests.getByRole('listitem')).toHaveCount(1);
  await expect(requests).toContainText(`#${number}`);
  await expect(requests).toContainText(pull.title);
  await expect(requests).toContainText(pull.branch);
  // The confirm button unlocks once the check has answered and the key is typed.
  await expect(submit).toBeDisabled();
  await confirm.fill(project.key);
  await expect(submit).toBeEnabled();
  await submit.click();
  await expect(dialog).toBeHidden({ timeout: 20_000 });
  await expect.poll(async () => (await sourceStatus()).state).toBe('detached');

  // The page now says who owns the tasks and offers the export command.
  await page.reload();
  await settle(page);
  await expect(page.getByRole('note').filter({ hasText: 'Owned by Zamu' })).toContainText(
    `Switched by ${admin.name}.`,
  );
  await expect(page.getByText(`zamu backlog export --project ${project.key}`)).toBeVisible();

  const updated = await api<TaskShape>(page.request, 'PATCH', `/tasks/${project.key}-12.1`, {
    status: 'done',
  });
  expect(updated.status).toBe('done');
  expect(updated.locked ?? []).toEqual([]);
  // The task keeps its Backlog.md record.
  expect(updated.backlog?.id).toBe('PAY-12.1');
  // Labels read from the files become app labels: they can be renamed now, and the fields are editable.
  const labels = await api<{ items: LabelShape[] }>(page.request, 'GET', `/projects/${project.key}/labels`);
  expect(labels.items.map((label) => label.source)).toEqual(labels.items.map(() => 'app'));
  const webhooks = labels.items.find((label) => label.name === 'webhooks');
  await api(page.request, 'PATCH', `/projects/${project.key}/labels/${webhooks?.id}`, { name: 'hooks' });
  const relabelled = await api<TaskShape>(page.request, 'PATCH', `/tasks/${project.key}-20`, {
    addLabels: ['urgent'],
    dueDate: null,
  });
  expect(relabelled.labels.map((label) => label.name).sort()).toEqual(['alerts', 'urgent']);
  expect(relabelled.dueDate).toBeNull();

  // The work record is editable too: the items keep their states, and notes work.
  const parent = await api<TaskShape>(page.request, 'PATCH', `/tasks/${project.key}-12`, {
    checkCriteria: [2],
    checkDoneItems: [1],
  });
  expect(parent.criteria?.map(({ state, locked }) => ({ state, locked }))).toEqual([
    { state: 'checked', locked: false },
    { state: 'checked', locked: false },
  ]);
  const note = cli.run(['notes', 'add', 'PAY-12', 'Backoff verified on staging', '--json']);
  expect(note.code, note.stdout + note.stderr).toBe(0);

  // New tasks continue the numbering.
  const created = await api<TaskShape>(page.request, 'POST', '/tasks', {
    project: project.key,
    title: 'Sign webhook payloads',
  });
  expect(created.key).toBe(`${project.key}-22`);

  // The webhook URL of a switched project answers 410 Gone.
  const delivery = await page.request.post(webhookUrl, { data: {} });
  expect(delivery.status()).toBe(410);
});

test('zamu backlog export writes the tasks into a git repository, and the folder parses back', async () => {
  // A clone that already has the Backlog.md config, a document and a task file Zamu doesn't have.
  const clone = createGitRepo('main');
  try {
    const docPath = 'backlog/docs/doc-1 - Webhook-guide.md';
    const stalePath = 'backlog/tasks/pay-99 - Old-copy.md';
    const config = files['backlog/config.yml'] as string;
    const doc = files[docPath] as string;
    clone.commit('Add the Backlog.md folder', {
      'backlog/config.yml': config,
      [docPath]: doc,
      [stalePath]: '---\nid: PAY-99\ntitle: Old copy\nstatus: To Do\n---\n',
    });

    const dryRun = cli.run(
      ['backlog', 'export', '--project', project.key, '--dry-run', '--json'],
      {},
      {
        cwd: clone.dir,
      },
    );
    expect(dryRun.code, dryRun.stdout + dryRun.stderr).toBe(0);
    expect(parseJson<{ dryRun: boolean }>(dryRun, 'zamu.v1.backlog.export').dryRun).toBe(true);
    expect(clone.git(['status', '--porcelain'])).toBe('');

    const run = cli.run(['backlog', 'export', '--project', project.key, '--json'], {}, { cwd: clone.dir });
    expect(run.code, run.stdout + run.stderr).toBe(0);
    // config.yml has task_prefix "pay", the exported ids' prefix: no warning.
    expect(run.stderr).toBe('');
    const result = parseJson<{ project: string; dir: string; files: { path: string; action: string }[] }>(
      run,
      'zamu.v1.backlog.export',
    );
    expect(result.project).toBe(project.key);
    expect(result.files.filter((file) => file.action === 'removed').map((file) => file.path)).toEqual([
      'tasks/pay-99 - Old-copy.md',
    ]);

    // The stale task file is gone; the config and the document are untouched.
    const tree = readTree(join(clone.dir, 'backlog'));
    expect(tree['config.yml']).toBe(config);
    expect(tree['docs/doc-1 - Webhook-guide.md']).toBe(doc);
    expect(tree['tasks/pay-99 - Old-copy.md']).toBeUndefined();
    expect(clone.git(['status', '--porcelain', '-z']).split('\0')).toContain(` D ${stalePath}`);

    // The folder parses with the same reader the mirror uses, and holds every visible task.
    const parsed = parseBacklogFolder(
      Object.entries(tree).map(([path, text]) => ({ path: `backlog/${path}`, text })),
      'backlog',
    );
    const tasks = parsed.files.flatMap((file) => {
      if (file.kind !== 'task') return [];
      expect(file.result.ok, `${file.path}: ${JSON.stringify(file.result)}`).toBe(true);
      return file.result.ok ? [file.result.value] : [];
    });
    expect(tasks.map((task) => task.id.id).sort()).toEqual(
      ['PAY-12', 'PAY-12.1', 'PAY-12.1.2', 'PAY-20', 'PAY-21', 'PAY-22', 'PAY-3'].sort(),
    );
    const parent = tasks.find((task) => task.id.id === 'PAY-12');
    expect(parent?.title).toBe('Webhook retries');
    expect(parent?.parentId ?? null).toBeNull();
    expect(tasks.find((task) => task.id.id === 'PAY-12.1')?.parentId).toBe('PAY-12');
    const record = taskWorkRecord(parent as NonNullable<typeof parent>);
    expect(record.criteria.map(({ text, state }) => ({ text, state }))).toEqual([
      { text: 'Failed deliveries are retried', state: 'checked' },
      { text: 'Retries back off exponentially', state: 'checked' },
    ]);
    expect(record.doneItems.map(({ text, state }) => ({ text, state }))).toEqual([
      { text: 'Tests pass', state: 'checked' },
    ]);
    expect(record.plan).toContain('Add a retry queue.');
    expect(record.finalSummary).toMatch(/^Retries ship behind a flag\./);
    // The notes from the file come first, then the work notes written in Zamu.
    expect(record.implementationNotes).toContain('Queue lives in Redis.');
    expect(record.implementationNotes).toContain('Backoff verified on staging');
    expect(parsed.files.filter((file) => file.kind === 'milestone').length).toBeGreaterThan(0);

    // Once the export is committed, a second run finds nothing to change.
    clone.git(['add', '--all', 'backlog']);
    clone.git(['commit', '--quiet', '-m', 'Export from Zamu']);
    const again = cli.run(['backlog', 'export', '--project', project.key, '--json'], {}, { cwd: clone.dir });
    expect(again.code, again.stdout + again.stderr).toBe(0);
    const unchanged = parseJson<{ files: { action: string }[] }>(again, 'zamu.v1.backlog.export');
    expect(unchanged.files.every((file) => file.action === 'unchanged')).toBe(true);
  } finally {
    clone.remove();
  }
});

test('delete the project through the API: its webhook URL answers 404', async () => {
  const response = await page.request.delete(`/api/v1/projects/${project.key}`, {
    data: { confirmKey: project.key.toLowerCase() },
  });
  expect(response.status(), await response.text()).toBe(204);
  expect((await page.request.get(`/api/v1/tasks/${project.key}-12`)).status()).toBe(404);
  const delivery = await page.request.post(webhookUrl, { data: {} });
  expect(delivery.status()).toBe(404);
  expect(pageErrors).toEqual([]);
});
