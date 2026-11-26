// The M1 flow end to end, on the 0.7.0 screens: a person sets up the server (or signs in, when an earlier spec
// set it up), creates a project from the sidebar and tasks with quick create, moves through the list with the
// keyboard and changes a status in the task view, adds an agent with a scoped key, the agent works on a task
// through the CLI, and the person sees it and revokes the key. Each test builds on the previous one, so they
// share one page and run in order.
import { type BrowserContext, expect, type Page, test } from '@playwright/test';
import { createCli, parseJson } from './cli';
import { admin, homeURL, openNewProject, setUpServer, signInAsAdmin, w } from './session';
import { baseURL } from './stack';

const project = { name: 'Payments', key: 'PAY' };
const taskTitles = [
  'Match Stripe payouts to invoices',
  'Flag payouts with no invoice',
  'Export reconciliation report',
];
const agentName = 'e2e-agent';

interface TaskSummary {
  key: string;
  status: string;
}

test.describe.configure({ mode: 'serial' });

let context: BrowserContext;
let page: Page;
const pageErrors: string[] = [];
const cli = createCli();
let apiKey = '';
let viewedTask = '';
let agentTask = '';

/** Waits until the page has loaded and hydrated, so keyboard shortcuts and inputs are live. */
async function settle(target: Page = page): Promise<void> {
  await target.waitForLoadState('networkidle');
  await target.waitForTimeout(500);
}

/** The key of the list row under the keyboard cursor, or null. */
async function cursorTask(): Promise<string | null> {
  const row = page.locator('[role="row"][data-cursor][data-task-key]');
  return (await row.count()) ? row.first().getAttribute('data-task-key') : null;
}

/**
 * Presses J or K and waits until the list has moved its cursor and focus to the new row, so the next key
 * press starts from it.
 */
async function moveCursor(key: 'j' | 'k'): Promise<string> {
  const before = await cursorTask();
  await page.keyboard.press(key);
  await expect.poll(cursorTask).not.toBe(before);
  const now = (await cursorTask()) ?? '';
  expect(now).toMatch(/^PAY-\d+$/);
  await expect(page.locator(`[role="row"][data-task-key="${now}"]`)).toBeFocused();
  return now;
}

/** Takes focus off any control, so single-key shortcuts reach the page. */
async function blur(): Promise<void> {
  await page.evaluate(() => (document.activeElement as HTMLElement | null)?.blur?.());
}

/** The task view's Properties sidebar. */
function properties() {
  return page.getByRole('complementary', { name: 'Properties' });
}

/** A line of the task view's Activity list. */
function activityLine(text: string) {
  return page.getByRole('region', { name: 'Activity' }).getByRole('listitem').filter({ hasText: text });
}

test.beforeAll(async ({ browser }) => {
  context = await browser.newContext({ permissions: ['clipboard-read', 'clipboard-write'] });
  page = await context.newPage();
  page.on('pageerror', (error) => pageErrors.push(`pageerror: ${error.message}`));
  page.on('console', (message) => {
    // The wrong password attempt logs a "status of 401" resource error on purpose.
    if (message.type() === 'error' && !/status of 401\b/.test(message.text())) {
      pageErrors.push(`console: ${message.text()}`);
    }
  });
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

test('first run: set up the admin account and the workspace', async () => {
  await page.goto('/');
  if (new URL(page.url()).pathname === '/setup') {
    await setUpServer(page);
  } else {
    // An earlier spec in file order has already set the server up through the same page (setUpServer):
    // sign in as that admin instead.
    await signInAsAdmin(page);
    // Better Auth allows 3 sign-in attempts per address in a rolling 10-second window (counted from the last
    // attempt). Setup and this sign-in may both fall inside it, and the next test makes two more attempts:
    // let the window pass so the wrong-password banner, not "Too many requests", answers them.
    await page.waitForTimeout(10_000);
    await page.goto('/');
  }

  // "/" is Home.
  await expect(page).toHaveURL(homeURL, { timeout: 15_000 });
  await expect(page.getByRole('tablist', { name: 'Home' })).toBeVisible();
  await settle();
  await expect(page.getByRole('button', { name: `${admin.name}: account menu` })).toBeVisible();

  // Setup is one-time: the page now sends visitors elsewhere.
  await page.goto('/setup');
  await expect(page).not.toHaveURL(/\/setup$/);
});

test('sign out, wrong password banner, sign in', async () => {
  await page.goto(w());
  await settle();
  await page.getByRole('button', { name: `${admin.name}: account menu` }).click();
  await page.getByRole('dialog', { name: 'Account' }).getByRole('menuitem', { name: 'Sign out' }).click();
  await expect(page).toHaveURL(/\/signin/, { timeout: 15_000 });
  await settle();

  await page.getByLabel('Email').fill(admin.email);
  await page.getByLabel('Password').fill('not-the-password-123');
  await page.getByRole('button', { name: 'Sign in' }).click();
  await expect(page.getByRole('alert')).toContainText('Wrong email or password. Check both and try again.');
  await expect(page).toHaveURL(/\/signin/);

  await page.getByLabel('Password').fill(admin.password);
  await expect(page.getByRole('alert')).toHaveCount(0);
  await page.getByRole('button', { name: 'Sign in' }).click();
  await expect(page).toHaveURL(homeURL, { timeout: 15_000 });
  await settle();
});

test('P no longer opens New project; the sidebar + creates PAY', async () => {
  // Since 0.7.0 P sets the priority of a selected task; on Home with nothing selected it does nothing.
  await blur();
  await page.keyboard.press('p');
  await expect(page.getByRole('dialog')).toHaveCount(0);

  await openNewProject(page, 'New project');
  const dialog = page.getByRole('dialog');
  await expect(dialog.getByRole('heading', { name: 'New project' })).toBeVisible();
  await dialog.getByLabel('Name', { exact: true }).fill(project.name);
  await expect(dialog.getByLabel('Key', { exact: true })).toHaveValue(project.key);
  await dialog.getByRole('button', { name: /Create project/ }).click();

  await expect(page).toHaveURL(new RegExp(`/p/${project.key}$`), { timeout: 15_000 });
  await settle();
  await expect(page.getByText(`No tasks in ${project.name} yet`)).toBeVisible();
  // The sidebar lists the project and opens its pages.
  const sidebar = page.getByRole('navigation', { name: 'Main' });
  await expect(sidebar.getByRole('link', { name: new RegExp(`^${project.name}, 0 open`) })).toBeVisible();
  const pages = sidebar.getByRole('list', { name: `${project.name} pages` });
  for (const name of ['List', 'Board', 'Milestones', 'Cycles', 'Settings']) {
    await expect(pages.getByRole('link', { name, exact: true })).toBeVisible();
  }
});

test('quick create three tasks with C and Create more', async () => {
  await page.keyboard.press('c');
  const dialog = page.getByRole('dialog', { name: 'New task' });
  await expect(dialog).toBeVisible();
  const createMore = dialog.getByRole('switch', { name: 'Create more' });
  if (!(await createMore.isChecked())) await createMore.click({ force: true });
  await expect(createMore).toBeChecked();

  const title = dialog.getByRole('textbox', { name: 'Title' });
  for (const text of taskTitles) {
    await title.fill(text);
    await page.keyboard.press('Control+Enter');
    // Create more keeps the dialog open and clears the title for the next task.
    await expect(title).toHaveValue('');
  }
  await page.keyboard.press('Escape');
  await expect(dialog).toBeHidden();
  await settle();

  for (const key of ['PAY-1', 'PAY-2', 'PAY-3']) {
    await expect(page.getByText(key, { exact: true }).first()).toBeVisible();
  }
  for (const text of taskTitles) await expect(page.getByText(text).first()).toBeVisible();
});

test('J and K move the cursor; Enter opens the task view, where the status changes', async () => {
  await blur();
  const first = await moveCursor('j');
  const second = await moveCursor('j');
  expect(second).not.toBe(first);
  expect(await moveCursor('k')).toBe(first);
  viewedTask = first;

  // The list has no detail pane: Enter opens the task view, which knows where it came from.
  await page.keyboard.press('Enter');
  await expect(page).toHaveURL(new RegExp(`/p/${project.key}/${viewedTask}$`), { timeout: 10_000 });
  await settle();
  await expect(page.getByText(/^\d+ of 3 in List$/)).toBeVisible();
  const status = properties().getByRole('button', { name: 'Status' });
  await expect(status).toContainText('Todo');
  await status.click();
  await page.getByRole('menu', { name: 'Status' }).getByRole('menuitemradio', { name: 'In review' }).click();
  await expect(status).toContainText('In review');

  // The change is saved: it survives a reload and shows in the activity.
  await page.reload();
  await settle();
  await expect(status).toContainText('In review');
  await expect(activityLine(`${admin.name} moved this to In review`)).toBeVisible();
});

test('Esc goes back to the list with the task focused; old ?task= links open the task view', async () => {
  await blur();
  await page.keyboard.press('Escape');
  await expect.poll(() => new URL(page.url()).pathname).toBe(w(`/p/${project.key}`));
  await settle();
  await expect(page.locator(`[role="row"][data-task-key="${viewedTask}"]`)).toBeFocused();

  // M1 to M4 linked the list's pane with ?task=; those links now open the task view.
  await page.goto(w(`/p/${project.key}?task=${viewedTask}`));
  await expect(page).toHaveURL(new RegExp(`/p/${project.key}/${viewedTask}$`), { timeout: 10_000 });
  await settle();
});

test('add agent e2e-agent with a read-write key scoped to PAY and copy the key', async () => {
  await page.goto(w('/settings/members'));
  await settle();
  await page.getByRole('button', { name: 'Add agent' }).click();
  const dialog = page.getByRole('dialog', { name: 'Add agent' });
  await expect(dialog).toBeVisible();
  await dialog.getByLabel('Name', { exact: true }).fill(agentName);
  await dialog.getByRole('radio', { name: /Selected projects/ }).check({ force: true });
  await dialog.getByRole('checkbox', { name: new RegExp(project.key) }).check({ force: true });
  await dialog.getByRole('radio', { name: /Read and write/ }).check({ force: true });
  await dialog.getByRole('button', { name: /Create agent/ }).click();

  const reveal = page.getByRole('alertdialog');
  await expect(reveal).toContainText(`Key created for ${agentName}`);
  await reveal.getByRole('button', { name: 'Copy API key' }).click();
  apiKey = await page.evaluate(() => navigator.clipboard.readText());
  expect(apiKey).toMatch(/^zamu_live_\S{20,}$/);
  // The copied key is the one shown in the dialog.
  await expect(reveal).toContainText(apiKey);

  await reveal.getByRole('button', { name: 'I copied the key' }).click();
  await expect(reveal).toBeHidden();
  await expect(page.getByText(agentName).first()).toBeVisible();
});

test('the CLI lists and updates tasks with the agent key', async () => {
  const login = cli.run(['login', '--key', apiKey, '--url', baseURL, '--json']);
  expect(login.code, login.stdout + login.stderr).toBe(0);

  const projects = cli.run(['projects', 'list', '--json']);
  expect(projects.code, projects.stdout + projects.stderr).toBe(0);
  const projectKeys = parseJson<{ items: { key: string }[] }>(projects, 'zamu.v1.projects.list').items.map(
    (item) => item.key,
  );
  expect(projectKeys).toEqual([project.key]);

  const list = cli.run(['tasks', 'list', '--project', project.key, '--json']);
  expect(list.code, list.stdout + list.stderr).toBe(0);
  const tasks = parseJson<{ items: TaskSummary[] }>(list, 'zamu.v1.tasks.list').items;
  expect(tasks.map((task) => task.key).sort()).toEqual(['PAY-1', 'PAY-2', 'PAY-3']);

  const todo = tasks.find((task) => task.status === 'todo' && task.key !== viewedTask);
  expect(todo, 'a task still in Todo').toBeTruthy();
  agentTask = todo?.key ?? '';

  const update = cli.run(['tasks', 'update', agentTask, '--status', 'in_progress', '--json']);
  expect(update.code, update.stdout + update.stderr).toBe(0);
  expect(parseJson<TaskSummary>(update, 'zamu.v1.tasks.update')).toMatchObject({
    key: agentTask,
    status: 'in_progress',
  });
});

test('the task view shows the agent change as "<agent> for <person>"', async () => {
  await page.goto(w(`/p/${project.key}/${agentTask}`));
  await settle();
  await expect(properties().getByRole('button', { name: 'Status' })).toContainText('In progress');
  // The history names the agent and the first name of its person.
  const person = admin.name.split(' ')[0];
  await expect(activityLine(`${agentName} for ${person} moved this to In progress`)).toBeVisible();
});

test('a revoked key makes the CLI exit with code 2', async () => {
  await page.goto(w('/settings/api-keys'));
  await settle();
  const row = page.getByRole('row').filter({ hasText: agentName }).first();
  await row.getByRole('button', { name: 'Revoke' }).click();
  const confirm = page.getByRole('alertdialog').or(page.getByRole('dialog')).first();
  await confirm.getByRole('button', { name: /Revoke/ }).click();
  await expect(confirm).toBeHidden();
  await settle();

  const list = cli.run(['tasks', 'list', '--project', project.key]);
  expect(list.code, list.stdout + list.stderr).toBe(2);
});

test('task list screenshots in light and dark', async ({ browser }, testInfo) => {
  const storageState = await context.storageState();
  for (const colorScheme of ['light', 'dark'] as const) {
    const themed = await browser.newContext({ colorScheme, storageState });
    const themedPage = await themed.newPage();
    themedPage.on('pageerror', (error) => pageErrors.push(`pageerror (${colorScheme}): ${error.message}`));
    await themedPage.goto(w(`/p/${project.key}`));
    await settle(themedPage);
    await expect(themedPage.getByText(taskTitles[0] ?? '').first()).toBeVisible();
    await testInfo.attach(`task-list-${colorScheme}`, {
      body: await themedPage.screenshot(),
      contentType: 'image/png',
    });
    await themedPage.screenshot({ path: testInfo.outputPath(`task-list-${colorScheme}.png`) });
    await themed.close();
  }
});

test('no page errors during the flow', () => {
  expect(pageErrors).toEqual([]);
});
