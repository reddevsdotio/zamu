// Home end to end (it replaces the M4 dashboard and My tasks in 0.7.0): signing in lands on "/", and the old
// pages redirect there; an agent moves a task to In review and mentions its person from the CLI; both show in
// the person's Mine tab and the sidebar count matches GET /home/counts; the person opens the mention from Home
// with the keyboard, answers it in the task view and it leaves Mentions; the Everyone tab; `zamu dashboard
// --json` with the agent's key still agrees with the API. The tests build on each other, so they share one
// page and run in order. The spec sets the server up when it runs first, else it signs in as the admin from
// the other specs.
import { type BrowserContext, expect, type Page, request, test } from '@playwright/test';
import { createCli, parseJson } from './cli';
import { addAgent, admin, api, collectPageErrors, homeURL, settle, signInAsAdmin, w } from './session';
import { baseURL } from './stack';

const project = { name: 'Billing', key: 'BIL' };
const reviewTask = { key: 'BIL-1', title: 'Retry failed refund webhooks' };
const mentionTask = { key: 'BIL-2', title: 'Write the invoice email copy' };
const agentName = 'dash-agent';

type DashboardGroupName = 'review' | 'mentions' | 'stalled' | 'deadlines';
type DashboardTotals = Record<DashboardGroupName, number>;

/** The parts of zamu.v1.dashboard (GET /api/v1/dashboard) the spec reads. The CLI keeps it in 0.7.0. */
interface Dashboard {
  scope: 'mine' | 'everyone';
  groups: Record<DashboardGroupName, { total: number; items: { task?: { key: string } }[] }>;
  projects: { key: string }[];
}

/** The parts of GET /api/v1/home the spec reads. */
interface Home {
  tab: 'mine' | 'everyone' | 'agents';
  counts: { mine: number; everyone: number; agents: number };
  groups: { key: string; total: number; items: { task: { key: string } }[] }[];
}
interface HomeCounts {
  review: number;
  mentions: number;
  blocked: number;
  overdue: number;
  total: number;
}

test.describe.configure({ mode: 'serial' });

let context: BrowserContext;
let page: Page;
const pageErrors: string[] = [];
const cli = createCli();
let agentKey = '';
let countBefore = 0;

function totalsOf(dashboard: Dashboard): DashboardTotals {
  const { review, mentions, stalled, deadlines } = dashboard.groups;
  return {
    review: review.total,
    mentions: mentions.total,
    stalled: stalled.total,
    deadlines: deadlines.total,
  };
}

function sum(totals: DashboardTotals): number {
  return totals.review + totals.mentions + totals.stalled + totals.deadlines;
}

async function homeCounts(): Promise<HomeCounts> {
  return api<HomeCounts>(page.request, 'GET', '/home/counts');
}

async function home(tab: Home['tab'] = 'mine'): Promise<Home> {
  return api<Home>(page.request, 'GET', `/home?tab=${tab}`);
}

/** The sidebar's Home link; its accessible name carries the count when there is one. */
function homeLink() {
  return page.getByRole('navigation', { name: 'Main' }).getByRole('link', { name: /^Home(,|$)/ });
}

/** The count after Home in the sidebar: data-count on the badge, absent at 0. */
async function sidebarCount(): Promise<number> {
  const badge = homeLink().locator('[data-count]');
  if ((await badge.count()) === 0) return 0;
  return Number(await badge.getAttribute('data-count'));
}

/** A Home group by its title ("Needs your review", "Mentions", …); its name carries the count. */
function group(title: string) {
  return page.getByRole('region', { name: new RegExp(`^${title} \\d+`) });
}

/** The count in a group's name, or 0 when the group is not shown. */
async function groupCount(title: string): Promise<number> {
  const region = group(title);
  if ((await region.count()) === 0) return 0;
  // The first line of the snapshot is the region with its accessible name: `- region "Mentions 1 …"`.
  const snapshot = await region.ariaSnapshot();
  return Number(new RegExp(`region "${title} (\\d+)`).exec(snapshot)?.[1] ?? 0);
}

/** A Home row: a link to the task view. */
function row(key: string) {
  return page.locator(`a[data-task-key="${key}"]`);
}

test.beforeAll(async ({ browser }) => {
  context = await browser.newContext({ permissions: ['clipboard-read', 'clipboard-write'] });
  page = await context.newPage();
  collectPageErrors(page, pageErrors);
});

// biome-ignore lint/correctness/noEmptyPattern: Playwright requires an object pattern as the first argument.
test.afterEach(async ({}, testInfo) => {
  if (testInfo.status !== testInfo.expectedStatus) {
    await testInfo.attach('page at failure', { body: await page.screenshot(), contentType: 'image/png' });
  }
});

test.afterAll(async () => {
  await context?.close();
  cli.dispose();
});

test('signing in lands on Home; Dashboard, My tasks and Projects redirect there', async () => {
  await signInAsAdmin(page);
  await page.goto('/');
  await expect(page).toHaveURL(homeURL, { timeout: 15_000 });
  await settle(page);
  const firstName = admin.name.split(' ')[0];
  await expect(
    page.getByRole('heading', {
      level: 1,
      name: new RegExp(`^Good (morning|afternoon|evening), ${firstName}$`),
    }),
  ).toBeVisible();
  await expect(page.getByRole('tab', { name: /^Mine/ })).toHaveAttribute('aria-selected', 'true');
  await expect(homeLink()).toHaveAttribute('aria-current', 'page');

  // The 0.6.0 pages are gone; their links land on Home.
  for (const path of ['/dashboard', '/my-tasks', '/projects']) {
    await page.goto(path);
    await expect(page, path).toHaveURL(homeURL, { timeout: 15_000 });
  }
  await page.goto('/dashboard?scope=everyone');
  await expect.poll(() => new URL(page.url()).searchParams.get('tab')).toBe('everyone');
  await expect(page.getByRole('tab', { name: /^Everyone/ })).toHaveAttribute('aria-selected', 'true');
});

test('seed a project and add an agent with a key for it', async () => {
  await api(page.request, 'POST', '/projects', project);
  for (const task of [reviewTask, mentionTask]) {
    await api(page.request, 'POST', '/tasks', { project: project.key, title: task.title });
  }
  agentKey = await addAgent(page, agentName, [project.key]);
  const login = cli.run(['login', '--key', agentKey, '--url', baseURL, '--json']);
  expect(login.code, login.stdout + login.stderr).toBe(0);
  countBefore = (await homeCounts()).total;
});

test('the agent moves a task to In review and mentions its person from the CLI', async () => {
  const update = cli.run([
    'tasks',
    'update',
    reviewTask.key,
    '--assignee',
    'me',
    '--status',
    'in_review',
    '--json',
  ]);
  expect(update.code, update.stdout + update.stderr).toBe(0);
  expect(parseJson<{ key: string; status: string }>(update, 'zamu.v1.tasks.update')).toMatchObject({
    key: reviewTask.key,
    status: 'in_review',
  });

  const add = cli.run([
    'comments',
    'add',
    mentionTask.key,
    `Which tone should the email use, formal or friendly? @${admin.email}`,
    '--json',
  ]);
  expect(add.code, add.stdout + add.stderr).toBe(0);
  const comment = parseJson<{ body: string }>(add, 'zamu.v1.comments.add');
  expect(comment.body).toMatch(new RegExp(`\\[@${admin.name}\\]\\(mention:[^)]+\\)$`));
});

test('after a reload both show in Mine, and the sidebar count matches /home/counts', async () => {
  await page.goto(w());
  await settle(page);
  await expect(group('Needs your review').locator(`a[data-task-key="${reviewTask.key}"]`)).toBeVisible();
  await expect(row(reviewTask.key)).toContainText(reviewTask.title);
  await expect(group('Mentions').locator(`a[data-task-key="${mentionTask.key}"]`)).toBeVisible();
  await expect(row(mentionTask.key)).toContainText(agentName);

  const counts = await homeCounts();
  expect(counts.review).toBeGreaterThanOrEqual(1);
  expect(counts.mentions).toBeGreaterThanOrEqual(1);
  expect(counts.total).toBe(countBefore + 2);
  expect(await groupCount('Needs your review')).toBe(counts.review);
  expect(await groupCount('Mentions')).toBe(counts.mentions);
  await expect.poll(sidebarCount).toBe(counts.total);
  await expect(homeLink()).toHaveAccessibleName(
    `Home, ${counts.total} ${counts.total === 1 ? 'item needs' : 'items need'} you`,
  );
  // The Mine tab counts the same items as the API.
  const mine = await home('mine');
  await expect(page.getByRole('tab', { name: /^Mine/ })).toHaveAccessibleName(
    mine.counts.mine ? `Mine ${mine.counts.mine}` : 'Mine',
  );
});

test('the person opens the mention from Home, answers it, and it leaves Mentions', async () => {
  const before = await sidebarCount();
  const mentionsBefore = await groupCount('Mentions');

  // J moves the focus down Home's rows; Enter opens the task view.
  await page.evaluate(() => (document.activeElement as HTMLElement | null)?.blur?.());
  for (let step = 0; step < 20; step += 1) {
    await page.keyboard.press('j');
    if (await row(mentionTask.key).evaluate((link) => link === document.activeElement)) break;
  }
  await expect(row(mentionTask.key)).toBeFocused();
  await page.keyboard.press('Enter');
  await expect(page).toHaveURL(new RegExp(`/p/${project.key}/${mentionTask.key}$`), { timeout: 10_000 });
  await settle(page);
  const history = page.getByRole('region', { name: 'Activity' });
  await expect(history.getByRole('article', { name: `Comment by ${agentName}` })).toBeVisible();

  // M opens the comment box, Ctrl+Enter sends and closes it.
  await page.keyboard.press('m');
  const composer = page.getByRole('textbox', { name: 'Comment' });
  await expect(composer).toBeFocused();
  await page.keyboard.type('Friendly, but keep the legal footer.');
  await page.keyboard.press('Control+Enter');
  await expect(composer).toBeHidden();
  await expect(history.getByRole('article', { name: `Comment by ${admin.name}` })).toContainText(
    'Friendly, but keep the legal footer.',
  );

  // The reply answers the mention: the sidebar count drops by one at once.
  await expect.poll(sidebarCount).toBe(before - 1);

  // Esc goes back to Home, where the task came from.
  await page.keyboard.press('Escape');
  await expect(page).toHaveURL(homeURL, { timeout: 10_000 });
  await settle(page);
  await expect(group('Mentions').locator(`a[data-task-key="${mentionTask.key}"]`)).toHaveCount(0);
  expect(await groupCount('Mentions')).toBe(mentionsBefore - 1);
  expect((await homeCounts()).total).toBe(before - 1);
  await expect(row(reviewTask.key)).toBeVisible();
});

test('the Everyone tab counts the whole workspace; the sidebar keeps the Mine count', async () => {
  await page.getByRole('tab', { name: /^Everyone/ }).click();
  await expect.poll(() => new URL(page.url()).searchParams.get('tab')).toBe('everyone');
  const everyone = await home('everyone');
  // M7 put "Merged with open criteria" after review.
  expect(everyone.groups.map((item) => item.key)).toEqual([
    'review',
    'mergedOpen',
    'blocked',
    'overdue',
    'dueThisWeek',
  ]);
  const review = everyone.groups.find((item) => item.key === 'review');
  await expect.poll(() => groupCount('Needs review')).toBe(review?.total ?? 0);
  await expect(page.locator(`a[data-task-key="${reviewTask.key}"]`)).toBeVisible();
  // Everyone has no Mentions group.
  await expect(group('Mentions')).toHaveCount(0);
  expect(await sidebarCount()).toBe((await homeCounts()).total);

  await page.getByRole('tab', { name: /^Mine/ }).click();
  await expect.poll(() => new URL(page.url()).searchParams.get('tab')).toBeNull();
  await expect(group('Needs your review')).toBeVisible();
});

test('zamu dashboard --json with the agent key matches the API for that key', async () => {
  const agentApi = await request.newContext({
    baseURL,
    extraHTTPHeaders: { authorization: `Bearer ${agentKey}` },
  });
  try {
    for (const scope of ['mine', 'everyone'] as const) {
      const args = scope === 'everyone' ? ['dashboard', '--everyone', '--json'] : ['dashboard', '--json'];
      const result = cli.run(args);
      expect(result.code, result.stdout + result.stderr).toBe(0);
      const fromCli = parseJson<Dashboard>(result, 'zamu.v1.dashboard');
      expect(fromCli.scope).toBe(scope);

      const fromApi = await api<Dashboard>(agentApi, 'GET', `/dashboard?scope=${scope}`);
      expect(totalsOf(fromCli)).toEqual(totalsOf(fromApi));
      // The key is scoped to one project.
      expect(fromCli.projects.map((item) => item.key)).toEqual([project.key]);
    }

    // For an agent's key, Mine is the agent's own tasks: its task in review is there.
    const mine = parseJson<Dashboard>(cli.run(['dashboard', '--json']), 'zamu.v1.dashboard');
    expect(mine.groups.review.items.map((item) => item.task?.key)).toContain(reviewTask.key);

    const text = cli.run(['dashboard']);
    expect(text.code, text.stdout + text.stderr).toBe(0);
    expect(text.stdout).toMatch(new RegExp(`^Needs you · ${sum(totalsOf(mine))}$`, 'm'));
    expect(text.stdout).toContain(`In review · ${mine.groups.review.total}`);
    expect(text.stdout).toContain(reviewTask.key);
  } finally {
    await agentApi.dispose();
  }
});

test('no page errors during the flow', () => {
  expect(pageErrors).toEqual([]);
});
