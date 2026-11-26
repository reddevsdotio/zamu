// Pull requests end to end, against a real Forgejo (e2e/forgejo.ts) that delivers its webhooks to the
// web container. The project links the repository and a connection on its Repository page, and the webhook is
// added through Forgejo's API with the payload URL and the secret the page shows. An agent starts a task from
// a clone on a feature branch, so the task records its work branch. A draft request from that branch links the
// task, and a second task named on a `Closes:` line, without moving them; marking the request ready moves both
// to In review, and the merge moves both to Done. The task merged with an open criterion carries the flag and
// shows in Home's "Merged with open criteria". A person links a request by hand from the task view (the
// preview first, a request of another repository refused). With "Close tasks when their pull request merges"
// off, a merge leaves its task in In review; a request closed without merging moves nothing. A delivery signed
// with the wrong secret shows on the page's status line, and with the webhook switched off in Forgejo, Check
// now catches up on what it missed.
//
// The tests build on each other, so they share one page and run in order. Forgejo starts in beforeAll and is
// removed in afterAll. A missing Docker daemon skips the spec.
import { createHmac } from 'node:crypto';
import { type BrowserContext, expect, type Page, test } from '@playwright/test';
import { createCli, parseJson } from './cli';
import { addConnection, dockerAvailable, type Forgejo, startForgejo } from './forgejo';
import { createGitRepo, type GitRepo } from './git-repo';
import { addAgent, api, collectPageErrors, settle, signInAsAdmin, w } from './session';
import { baseURL, forgejoAliases, mainStack } from './stack';

const repo = 'gateway';
const project = { name: 'Payments Gateway', key: 'GTW' };
const connectionName = 'Forgejo · e2e pulls';
const agentName = 'gateway-agent';
const branch = 'feat/webhook-retries';
const criteria = ['A failed webhook is retried with backoff', 'On-call is alerted once per webhook'];

interface PullRequestShape {
  number: number;
  title: string;
  state: 'open' | 'draft' | 'merged' | 'closed';
  how: 'branch' | 'description' | 'hand';
  headBranch: string;
  mergedBy: string | null;
  url: string;
}
interface TaskShape {
  key: string;
  status: string;
  workBranch?: string | null;
  pullRequests?: PullRequestShape[];
  mergedOpen?: { openCriteria: number; openDoneItems: number } | null;
  closedAt?: string | null;
}
interface RepositoryShape {
  repository: string | null;
  connection: { name: string } | null;
  defaultBranch: string | null;
  closeOnMerge: boolean;
  webhook: { url: string; secretSet: boolean; lastAt: string | null; lastStatus: string | null } | null;
  sync: { lastAt: string | null; error: string | null };
}
interface HomeShape {
  groups: { key: string; items: { task: { key: string } }[] }[];
}

test.describe.configure({ mode: 'serial' });
test.skip(!dockerAvailable(), 'Docker is not available: the pull-request spec needs it to run Forgejo.');

let context: BrowserContext;
let page: Page;
let forgejo: Forgejo;
let clone: GitRepo;
let hookId = 0;
/** The payload URL the Repository page shows, on the stack's public address. */
let webhookUrl = '';
const pageErrors: string[] = [];
const cli = createCli();
/** Task keys by role in the flow. */
const keys = { branch: '', closes: '', hand: '', switchOff: '', missed: '' };
/** Request numbers on Forgejo. */
const pulls = { retries: 0, runbook: 0, signing: 0, alerts: 0 };

async function taskOf(key: string): Promise<TaskShape> {
  return api<TaskShape>(page.request, 'GET', `/tasks/${key}`);
}

async function repositoryOf(): Promise<RepositoryShape> {
  return api<RepositoryShape>(page.request, 'GET', `/projects/${project.key}/repository`);
}

/** zamu as the agent, from the clone on whatever branch it has checked out. */
function agent(args: string[]) {
  return cli.run(args, {}, { cwd: clone.dir });
}

/** The request address a person copies from Forgejo, on the host the project's repository names. */
function requestAddress(number: number, repository = repo): string {
  return `http://${forgejo.host}/${forgejo.user}/${repository}/pulls/${number}`;
}

function repositoryPage(): string {
  return w(`/p/${project.key}/settings/repository`);
}

function properties() {
  return page.getByRole('complementary', { name: 'Properties' });
}

function requestsBox() {
  return page.getByRole('region', { name: 'Pull requests' });
}

function activity() {
  return page.getByRole('region', { name: 'Activity' });
}

/** The webhook part of the Repository page: whether events arrive. */
function statusLine() {
  return page.locator('[data-status]').first();
}

/** A Home group by its title; its name carries the count. */
function homeGroup(title: string) {
  return page.getByRole('region', { name: new RegExp(`^${title} \\d+`) });
}

/** Creates a task as the agent from the clone and moves it to In progress there: the CLI sends the branch. */
function startTask(title: string, workBranch: string, extra: string[] = []): string {
  if (clone.git(['branch', '--show-current']).trim() !== workBranch) {
    clone.git(['checkout', '--quiet', '-b', workBranch]);
  }
  const created = agent(['tasks', 'create', '--project', project.key, title, ...extra, '--json']);
  expect(created.code, created.stdout + created.stderr).toBe(0);
  const key = parseJson<TaskShape>(created, 'zamu.v1.tasks.create').key;
  const started = agent(['tasks', 'update', key, '--status', 'in_progress', '--json']);
  expect(started.code, started.stdout + started.stderr).toBe(0);
  expect(parseJson<TaskShape>(started, 'zamu.v1.tasks.update')).toMatchObject({
    status: 'in_progress',
    workBranch,
  });
  return key;
}

/** Presses Check now on the Repository page and waits for the check to report back. */
async function checkNow(): Promise<void> {
  const before = (await repositoryOf()).sync.lastAt;
  await page.goto(repositoryPage());
  await settle(page);
  await page.getByRole('button', { name: 'Check now' }).click();
  await expect
    .poll(async () => (await repositoryOf()).sync.lastAt, { timeout: 60_000, intervals: [1_000] })
    .not.toBe(before);
  await expect(page.getByRole('button', { name: 'Check now' })).toBeVisible({ timeout: 15_000 });
  await expect(page.getByText(/Last check just now/)).toBeVisible();
}

test.beforeAll(async ({ browser }) => {
  test.setTimeout(5 * 60_000);
  forgejo = await startForgejo('pulls', mainStack.network, forgejoAliases.pulls);
  await forgejo.createRepository(repo, { 'README.md': '# Gateway\n' });
  context = await browser.newContext({
    permissions: ['clipboard-read', 'clipboard-write'],
    timezoneId: 'UTC',
  });
  page = await context.newPage();
  collectPageErrors(page, pageErrors, [
    // The refused hand link answers 422 on purpose.
    /status of 422\b/,
  ]);
  clone = createGitRepo('main');
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
  clone?.remove();
  if (process.env.E2E_KEEP_STACK === '1') {
    console.log('[e2e] leaving the pull-request spec Forgejo running; the next pnpm e2e run removes it');
    return;
  }
  forgejo?.stop();
});

test('the Repository page links the repository and its connection; the webhook goes in through Forgejo', async () => {
  await signInAsAdmin(page);
  await addConnection(page, forgejo, connectionName);
  await api(page.request, 'POST', '/projects', { ...project, repository: forgejo.repositoryUrl(repo) });

  await page.goto(repositoryPage());
  await settle(page);
  await expect(page.getByRole('heading', { name: 'Repository', exact: true })).toBeVisible();
  // The only working connection for the host is picked; the default branch comes with the first check.
  await expect(page.getByText(`${forgejo.user}/${repo}`).first()).toBeVisible();
  await expect(page.getByText(connectionName)).toBeVisible();
  await expect(page.getByText('Known after the first check.')).toBeVisible();
  await expect(
    page.getByRole('switch', { name: 'Close tasks when their pull request merges' }),
  ).toBeChecked();
  await expect(statusLine()).toContainText('No event received yet.');

  // The payload URL, and a secret issued here and shown once.
  webhookUrl =
    (await page.getByRole('group', { name: 'Payload URL' }).locator('span.select-all').textContent()) ?? '';
  expect(webhookUrl).toMatch(new RegExp(`^${baseURL}/api/webhooks/repository/\\S+$`));
  await page.getByRole('button', { name: 'New secret' }).click();
  const secretField = page.getByRole('group', { name: 'Secret' });
  await expect(page.getByText('Shown once.', { exact: false })).toBeVisible();
  const secret = ((await secretField.locator('span.select-all').textContent()) ?? '').trim();
  expect(secret.length).toBeGreaterThan(16);
  expect((await repositoryOf()).webhook?.secretSet).toBe(true);

  // Forgejo reaches the web container by its service name on the stack network.
  const hook = await forgejo.api<{ id: number }>('POST', `/repos/${forgejo.user}/${repo}/hooks`, {
    type: 'forgejo',
    active: true,
    events: ['pull_request'],
    config: { url: `http://web:3000${new URL(webhookUrl).pathname}`, content_type: 'json', secret },
  });
  hookId = hook.id;

  // The first check reads the default branch and the requests, and moves nothing.
  await checkNow();
  await expect(page.getByText('Only merges into this branch close tasks.')).toBeVisible();
  expect(await repositoryOf()).toMatchObject({
    connection: { name: connectionName },
    defaultBranch: 'main',
    sync: { error: null },
  });
});

test('an agent starts a task from its branch with zamu; the task records the work branch', async () => {
  const apiKey = await addAgent(page, agentName, [project.key]);
  const login = cli.run(['login', '--key', apiKey, '--url', baseURL, '--json']);
  expect(login.code, login.stdout + login.stderr).toBe(0);

  keys.branch = startTask('Retry failed webhooks', branch, [
    '--ac',
    criteria[0] as string,
    '--ac',
    criteria[1] as string,
  ]);
  // One criterion proved; the other stays open through the merge.
  const checked = agent(['tasks', 'update', keys.branch, '--check-ac', '1', '--json']);
  expect(checked.code, checked.stdout + checked.stderr).toBe(0);
  keys.closes = (
    await api<TaskShape>(page.request, 'POST', '/tasks', {
      project: project.key,
      title: 'Document the webhook retries',
    })
  ).key;

  expect(await taskOf(keys.branch)).toMatchObject({ workBranch: branch, pullRequests: [] });
  await page.goto(w(`/p/${project.key}/${keys.branch}`));
  await settle(page);
  const line = requestsBox().locator('[data-part="branch-line"]');
  await expect(line).toContainText(`Work started on${branch}`);
  await expect(line).toContainText('No pull request yet');
});

test('a draft request links by branch and by Closes: without moving; marking it ready moves both', async () => {
  pulls.retries = await forgejo.openPullRequest(repo, {
    branch,
    title: 'WIP: Retry failed webhooks',
    body: `Retries with backoff.\n\nCloses: ${keys.closes}`,
    changes: { 'retries.md': 'Retry failed webhooks with backoff.\n' },
  });
  await expect
    .poll(async () => (await taskOf(keys.branch)).pullRequests?.map((pr) => [pr.number, pr.state, pr.how]), {
      timeout: 30_000,
    })
    .toEqual([[pulls.retries, 'draft', 'branch']]);
  await expect
    .poll(async () => (await taskOf(keys.closes)).pullRequests?.map((pr) => [pr.number, pr.how]))
    .toEqual([[pulls.retries, 'description']]);
  // Drafts link without moving.
  expect((await taskOf(keys.branch)).status).toBe('in_progress');
  expect((await taskOf(keys.closes)).status).toBe('todo');
  expect((await repositoryOf()).webhook).toMatchObject({ lastStatus: 'ok' });

  // Forgejo marks drafts with a title prefix: dropping it marks the request ready.
  await forgejo.api('PATCH', `/repos/${forgejo.user}/${repo}/pulls/${pulls.retries}`, {
    title: 'Retry failed webhooks',
  });
  await expect.poll(async () => (await taskOf(keys.branch)).status, { timeout: 30_000 }).toBe('in_review');
  await expect.poll(async () => (await taskOf(keys.closes)).status).toBe('in_review');

  await page.goto(w(`/p/${project.key}/${keys.branch}`));
  await settle(page);
  const row = requestsBox()
    .getByRole('listitem')
    .filter({ hasText: `#${pulls.retries}` });
  await expect(row).toContainText('Retry failed webhooks');
  await expect(row).toContainText(`started on${branch}`);
  await expect(row).toContainText('Open');
  await expect(properties().getByRole('button', { name: 'Status' })).toContainText('In review');
  await expect(
    activity()
      .getByRole('listitem')
      .filter({ hasText: `Forgejo moved this to In review · #${pulls.retries} marked ready` }),
  ).toBeVisible();

  await page.goto(w(`/p/${project.key}/${keys.closes}`));
  await settle(page);
  await expect(
    requestsBox()
      .getByRole('listitem')
      .filter({ hasText: `#${pulls.retries}` }),
  ).toContainText('named in the description');
});

test('a person links a request by hand: the preview, then the link; another repository is refused', async () => {
  pulls.runbook = await forgejo.openPullRequest(repo, {
    branch: 'docs/runbook',
    title: 'Runbook for webhook retries',
    changes: { 'runbook.md': 'What to do when retries run out.\n' },
  });
  keys.hand = (
    await api<TaskShape>(page.request, 'POST', '/tasks', {
      project: project.key,
      title: 'Write the retries runbook',
    })
  ).key;

  await page.goto(w(`/p/${project.key}/${keys.hand}`));
  await settle(page);
  await page.keyboard.press('Shift+P');
  const field = page.getByRole('textbox', { name: 'Pull request address' });
  await expect(field).toBeFocused();

  // A request of another repository on the same host is refused, and both repositories are named.
  await field.fill(requestAddress(1, 'storefront'));
  await expect(page.getByRole('alert')).toContainText(
    `#1 is in ${forgejo.user}/storefront. ${project.name} is linked to`,
  );
  await expect(page.getByRole('alert')).toContainText(`${forgejo.user}/${repo}`);
  await expect(field).toHaveAttribute('aria-invalid', 'true');

  // The project's own request: read from Forgejo and shown as it would link, until Enter links it.
  await field.fill(requestAddress(pulls.runbook));
  const preview = page.locator('[data-preview]');
  await expect(preview).toContainText(`#${pulls.runbook}`, { timeout: 20_000 });
  await expect(preview).toContainText('Runbook for webhook retries');
  await expect(preview).toContainText('Enter links it');
  expect((await taskOf(keys.hand)).pullRequests).toEqual([]);
  await field.press('Enter');
  await expect(
    page.getByRole('status').filter({ hasText: `Linked #${pulls.runbook} to ${keys.hand}` }),
  ).toBeVisible();
  await expect(field).toBeHidden();
  await expect(
    requestsBox()
      .getByRole('listitem')
      .filter({ hasText: `#${pulls.runbook}` }),
  ).toContainText('linked by hand');
  // A link to an open request acts like the request opening: the task moves to In review.
  await expect.poll(async () => (await taskOf(keys.hand)).status).toBe('in_review');
  expect((await taskOf(keys.hand)).pullRequests?.[0]).toMatchObject({ number: pulls.runbook, how: 'hand' });
});

test('the merge moves both tasks to Done; the open criterion flags the task and it shows on Home', async () => {
  await forgejo.mergePullRequest(repo, pulls.retries);
  await expect.poll(async () => (await taskOf(keys.branch)).status, { timeout: 30_000 }).toBe('done');
  await expect.poll(async () => (await taskOf(keys.closes)).status).toBe('done');
  const merged = await taskOf(keys.branch);
  expect(merged.mergedOpen).toMatchObject({ openCriteria: 1, openDoneItems: 0 });
  expect(merged.pullRequests?.[0]).toMatchObject({ state: 'merged', mergedBy: forgejo.user });
  expect(merged.closedAt).not.toBeNull();
  expect((await taskOf(keys.closes)).mergedOpen ?? null).toBeNull();

  await page.goto(w(`/p/${project.key}/${keys.branch}`));
  await settle(page);
  await expect(properties().getByRole('note')).toContainText('Merged with 1 open criterion');
  await expect(
    activity()
      .getByRole('listitem')
      .filter({
        hasText: `Forgejo moved this to Done · #${pulls.retries} merged by ${forgejo.user}, 1 criterion still open`,
      }),
  ).toBeVisible();

  // Home: the agent's person sees it under Mine, and everyone under Everyone.
  const mine = await api<HomeShape>(page.request, 'GET', '/home?tab=mine');
  expect(mine.groups.find((group) => group.key === 'mergedOpen')?.items.map((item) => item.task.key)).toEqual(
    [keys.branch],
  );
  await page.goto(w('/'));
  await settle(page);
  const group = homeGroup('Merged with open criteria');
  await expect(group).toBeVisible();
  await expect(group.locator(`a[data-task-key="${keys.branch}"]`)).toContainText(
    'Merged with 1 open criterion',
  );
  await expect(group.locator(`a[data-task-key="${keys.closes}"]`)).toHaveCount(0);
  await page.getByRole('tab', { name: /^Everyone/ }).click();
  await expect(
    homeGroup('Merged with open criteria').locator(`a[data-task-key="${keys.branch}"]`),
  ).toBeVisible();
});

test('with closing on merge off, a merged request leaves its task in In review', async () => {
  await page.goto(repositoryPage());
  await settle(page);
  const toggle = page.getByRole('switch', { name: 'Close tasks when their pull request merges' });
  await toggle.click({ force: true });
  await expect(toggle).not.toBeChecked();
  await expect(page.getByText(/^Off: requests still link to their tasks/)).toBeVisible();
  await expect.poll(async () => (await repositoryOf()).closeOnMerge).toBe(false);

  keys.switchOff = startTask('Sign webhook payloads', 'feat/signing');
  pulls.signing = await forgejo.openPullRequest(repo, {
    branch: 'feat/signing',
    title: 'Sign webhook payloads',
    changes: { 'signing.md': 'Payloads carry an HMAC signature.\n' },
  });
  await expect.poll(async () => (await taskOf(keys.switchOff)).status, { timeout: 30_000 }).toBe('in_review');
  await forgejo.mergePullRequest(repo, pulls.signing);
  await expect
    .poll(async () => (await taskOf(keys.switchOff)).pullRequests?.[0]?.state, { timeout: 30_000 })
    .toBe('merged');
  expect((await taskOf(keys.switchOff)).status).toBe('in_review');

  // On again for the rest of the flow.
  await toggle.click({ force: true });
  await expect(toggle).toBeChecked();
  await expect.poll(async () => (await repositoryOf()).closeOnMerge).toBe(true);
});

test('a request closed without merging moves nothing', async () => {
  await forgejo.api('PATCH', `/repos/${forgejo.user}/${repo}/pulls/${pulls.runbook}`, { state: 'closed' });
  await expect
    .poll(async () => (await taskOf(keys.hand)).pullRequests?.[0]?.state, { timeout: 30_000 })
    .toBe('closed');
  expect((await taskOf(keys.hand)).status).toBe('in_review');
  await page.goto(w(`/p/${project.key}/${keys.hand}`));
  await settle(page);
  await expect(requestsBox()).toContainText('closed without merging');
  await expect(
    requestsBox()
      .getByRole('listitem')
      .filter({ hasText: `#${pulls.runbook}` }),
  ).toContainText('Closed');
});

test('a delivery signed with the wrong secret shows on the status line', async () => {
  const body = JSON.stringify({ action: 'opened', number: 99 });
  const response = await page.request.post(webhookUrl, {
    data: body,
    headers: {
      'content-type': 'application/json',
      'x-forgejo-event': 'pull_request',
      'x-forgejo-signature': createHmac('sha256', 'not-the-secret').update(body).digest('hex'),
    },
  });
  expect(response.status()).toBe(401);
  expect((await repositoryOf()).webhook?.lastStatus).toBe('bad_signature');

  await page.goto(repositoryPage());
  await settle(page);
  await expect(statusLine()).toHaveAttribute('data-status', 'bad_signature');
  await expect(statusLine()).toContainText('The last event failed its signature check.');
  await expect(statusLine()).toContainText('The secret on Forgejo doesn’t match this one.');
});

test('Check now catches up on the events of a webhook that was switched off', async () => {
  test.setTimeout(3 * 60_000);
  await forgejo.api('PATCH', `/repos/${forgejo.user}/${repo}/hooks/${hookId}`, { active: false });

  keys.missed = startTask('Alert on exhausted retries', 'feat/alerts');
  pulls.alerts = await forgejo.openPullRequest(repo, {
    branch: 'feat/alerts',
    title: 'Alert on exhausted retries',
    changes: { 'alerts.md': 'Page on-call when retries run out.\n' },
  });
  // No delivery: give Forgejo time to (not) send one, and the task stays where it is.
  await page.waitForTimeout(5_000);
  expect(await taskOf(keys.missed)).toMatchObject({ status: 'in_progress', pullRequests: [] });

  await checkNow();
  const opened = await taskOf(keys.missed);
  expect(opened.status).toBe('in_review');
  expect(opened.pullRequests?.map((pr) => [pr.number, pr.state, pr.how])).toEqual([
    [pulls.alerts, 'open', 'branch'],
  ]);

  await forgejo.mergePullRequest(repo, pulls.alerts);
  await page.waitForTimeout(3_000);
  expect((await taskOf(keys.missed)).status).toBe('in_review');
  await checkNow();
  expect((await taskOf(keys.missed)).status).toBe('done');
  // The check reads every request again; those it had already seen move nothing.
  expect((await taskOf(keys.switchOff)).status).toBe('in_review');
  expect((await taskOf(keys.hand)).status).toBe('in_review');

  // Forgejo's request list leaves out who merged; the check reads the merged request on its own for it.
  await page.goto(w(`/p/${project.key}/${keys.missed}`));
  await settle(page);
  await expect(
    activity()
      .getByRole('listitem')
      .filter({ hasText: `Forgejo moved this to Done · #${pulls.alerts} merged by ${forgejo.user}` }),
  ).toBeVisible();
});

test('no page errors during the flow', () => {
  expect(pageErrors).toEqual([]);
});
