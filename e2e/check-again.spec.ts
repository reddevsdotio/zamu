// Check again end to end. A person sets a day on a task from its view (⇧W): the picker asks why the
// task waits and sets nothing without a reason, which the API requires too. A waiting task shows its chip on
// the list and the board, where its card is dimmed by default; Display options' "Waiting tasks: Hidden" leaves
// it out and the column ends with "1 waiting, hidden" and Show. An agent sets a day that has come (yesterday)
// with zamu: the task shows the ready chip and lands in Home's "Check again" group. `zamu tasks list
// --waiting` and `--ready-to-check` find them, `--no-check-again` clears a day, and finishing a task clears
// its day.
//
// The tests build on each other, so they share one page and run in order. Days are the server's (compose
// sets no APP_TIME_ZONE, so UTC), and the browser runs in UTC too.
import { type BrowserContext, expect, type Page, test } from '@playwright/test';
import { createCli, parseJson } from './cli';
import { addAgent, api, collectPageErrors, settle, signInAsAdmin, w } from './session';
import { baseURL } from './stack';

const project = { name: 'Vendors', key: 'VND' };
const agentName = 'vendor-agent';
/** VND-1 to VND-4. */
const titles = [
  'Renew the bank certificate',
  'Move to the new card processor',
  'Rotate the SFTP key',
  'Close the old merchant account',
];
const reason = 'The bank issues the new certificate next week';
const readyReason = 'The processor said the sandbox is back';
const DAY = 86_400_000;
const MONTHS = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'];

interface TaskShape {
  key: string;
  status: string;
  checkAgain?: { on: string; reason: string } | null;
}
interface Problem {
  code: string;
  status: number;
}

test.describe.configure({ mode: 'serial' });

let context: BrowserContext;
let page: Page;
const pageErrors: string[] = [];
const cli = createCli();

/** A day `offset` days from today, YYYY-MM-DD in UTC. */
function day(offset: number): string {
  return new Date(Date.now() + offset * DAY).toISOString().slice(0, 10);
}

/** "Dec 3" (with the year when it is not this year's), as the chips write a day. */
function shortDate(value: string): string {
  const [year, month, date] = value.split('-').map(Number) as [number, number, number];
  const base = `${MONTHS[month - 1]} ${date}`;
  return year === Number(day(0).slice(0, 4)) ? base : `${base}, ${year}`;
}

async function taskOf(key: string): Promise<TaskShape> {
  return api<TaskShape>(page.request, 'GET', `/tasks/${key}`);
}

function properties() {
  return page.getByRole('complementary', { name: 'Properties' });
}

function listRow(key: string) {
  return page
    .getByRole('treegrid', { name: `Tasks in ${project.name}` })
    .locator(`[role="row"][data-task-key="${key}"]`);
}

function card(key: string) {
  return page.locator(`[data-card-key="${key}"]`);
}

function toast(text: string | RegExp) {
  return page.getByRole('status').filter({ hasText: text });
}

/** zamu as the agent; the JSON result of a command that worked. */
function zamu<T>(args: string[], schema: string): T {
  const result = cli.run([...args, '--json']);
  expect(result.code, result.stdout + result.stderr).toBe(0);
  return parseJson<T>(result, schema);
}

function listKeys(flag: string): string[] {
  return zamu<{ items: { key: string }[] }>(
    ['tasks', 'list', '--project', project.key, flag],
    'zamu.v1.tasks.list',
  )
    .items.map((item) => item.key)
    .sort();
}

test.beforeAll(async ({ browser }) => {
  context = await browser.newContext({
    permissions: ['clipboard-read', 'clipboard-write'],
    timezoneId: 'UTC',
  });
  page = await context.newPage();
  collectPageErrors(page, pageErrors);
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
});

test('a person sets a day from the task view; the reason is required', async () => {
  await signInAsAdmin(page);
  await api(page.request, 'POST', '/projects', project);
  for (const title of titles) await api(page.request, 'POST', '/tasks', { project: project.key, title });

  // The API refuses a day without a reason.
  const refused = await page.request.patch('/api/v1/tasks/VND-1', { data: { checkAgain: { on: day(7) } } });
  expect(refused.status()).toBe(400);
  expect((await taskOf('VND-1')).checkAgain ?? null).toBeNull();

  await page.goto(w(`/p/${project.key}/VND-1`));
  await settle(page);
  const row = properties().getByRole('button', { name: 'Check again' });
  await expect(row).toContainText('Set a day');
  await page.keyboard.press('Shift+W');
  const picker = page.getByRole('dialog', { name: 'Check again' });
  await expect(picker).toBeVisible();
  await expect(picker).toContainText('It is what you read when the task comes back.');
  await picker.getByText('In a week', { exact: true }).click();
  const why = picker.getByRole('textbox', { name: 'Why wait (required)' });
  await expect(why).toBeFocused();

  // Enter without a reason sets nothing; the field says why.
  await why.press('Enter');
  await expect(picker.getByRole('alert')).toHaveText(
    'Say why it waits. It is what you read when the task comes back.',
  );
  await expect(why).toHaveAttribute('aria-invalid', 'true');
  expect((await taskOf('VND-1')).checkAgain ?? null).toBeNull();

  await why.fill(reason);
  await why.press('Enter');
  await expect(toast(/^VND-1 waits until/)).toBeVisible();
  await expect(picker).toBeHidden();
  await expect(row).toContainText(`Waiting until ${shortDate(day(7))}`);
  await expect(row).toContainText(reason);
  await expect.poll(async () => (await taskOf('VND-1')).checkAgain).toEqual({ on: day(7), reason });
  await expect(
    page
      .getByRole('region', { name: 'Activity' })
      .getByRole('listitem')
      .filter({ hasText: `set check again to ${shortDate(day(7))}` }),
  ).toBeVisible();
});

test('a waiting task shows its chip on the list and a dimmed card on the board', async () => {
  await page.goto(w(`/p/${project.key}`));
  await settle(page);
  await expect(listRow('VND-1')).toHaveAttribute('data-waiting', 'dimmed');
  await expect(listRow('VND-1')).toContainText(`Waiting until ${shortDate(day(7))}`);
  await expect(listRow('VND-2')).not.toHaveAttribute('data-waiting', /.*/);

  await page.goto(w(`/p/${project.key}?view=board`));
  await settle(page);
  const todo = page.getByRole('grid', { name: 'Todo', exact: true });
  await expect(todo.locator('[data-card-key]')).toHaveCount(4);
  await expect(card('VND-1')).toHaveAttribute('data-waiting', 'true');
  await expect(card('VND-1')).toContainText(`Until ${shortDate(day(7))}`);
  await expect(card('VND-2')).not.toHaveAttribute('data-waiting', /.*/);
});

test('Display options: "Waiting tasks: Hidden" leaves the card out and says so under the column', async () => {
  await page.getByRole('button', { name: 'Display' }).click();
  const display = page.getByRole('dialog', { name: 'Display options' });
  const waiting = display.getByRole('button', { name: /Waiting tasks/ });
  await expect(waiting).toContainText('Shown, dimmed');
  await waiting.click();
  await page.getByRole('listbox', { name: 'Waiting tasks' }).getByRole('option', { name: 'Hidden' }).click();
  await expect(waiting).toContainText('Hidden');
  await page.keyboard.press('Escape');
  await expect(display).toBeHidden();

  const todo = page.getByRole('grid', { name: 'Todo', exact: true });
  await expect(card('VND-1')).toHaveCount(0);
  await expect(todo.locator('[data-card-key]')).toHaveCount(3);
  const footer = page.locator('[data-hidden-waiting]');
  await expect(footer).toHaveText(/1 waiting, hidden/);

  // Stored per person, project and view: it survives a reload. Show brings the column's waiting tasks back.
  await page.reload();
  await settle(page);
  await expect(card('VND-1')).toHaveCount(0);
  await page.getByRole('button', { name: 'Show the waiting tasks in Todo' }).click();
  await expect(card('VND-1')).toBeVisible();

  // Back to the default for the next steps.
  await page.getByRole('button', { name: 'Display' }).click();
  await display.getByRole('button', { name: /Waiting tasks/ }).click();
  await page
    .getByRole('listbox', { name: 'Waiting tasks' })
    .getByRole('option', { name: 'Shown, dimmed' })
    .click();
  await page.keyboard.press('Escape');
  await expect(card('VND-1')).toHaveAttribute('data-waiting', 'true');
});

test('an agent sets a day that has come with zamu: the ready chip and Home’s Check again group', async () => {
  const apiKey = await addAgent(page, agentName, [project.key]);
  const login = cli.run(['login', '--key', apiKey, '--url', baseURL, '--json']);
  expect(login.code, login.stdout + login.stderr).toBe(0);

  // A day without --reason is refused before anything is sent.
  const noReason = cli.run(['tasks', 'update', 'VND-2', '--check-again', day(-1)]);
  expect(noReason.code, noReason.stdout + noReason.stderr).not.toBe(0);
  expect((await taskOf('VND-2')).checkAgain ?? null).toBeNull();

  const updated = zamu<TaskShape>(
    ['tasks', 'update', 'VND-2', '--check-again', day(-1), '--reason', readyReason],
    'zamu.v1.tasks.update',
  );
  expect(updated.checkAgain).toEqual({ on: day(-1), reason: readyReason });

  await page.goto(w(`/p/${project.key}?view=board`));
  await settle(page);
  await expect(card('VND-2')).toContainText('Check again: yesterday');
  await expect(card('VND-2')).not.toHaveAttribute('data-waiting', /.*/);

  // Home: the person who created it (it has no assignee) sees it under Mine.
  await page.goto(w('/'));
  await settle(page);
  const group = page.getByRole('region', { name: /^Check again \d+/ });
  await expect(group).toContainText('The day you set has come.');
  await expect(group.locator('a[data-task-key="VND-2"]')).toBeVisible();
  await expect(group.locator('a[data-task-key="VND-1"]')).toHaveCount(0);
  const home = await api<{ groups: { key: string; items: { task: { key: string } }[] }[] }>(
    page.request,
    'GET',
    '/home?tab=mine',
  );
  expect(home.groups.find((item) => item.key === 'checkAgain')?.items.map((item) => item.task.key)).toEqual([
    'VND-2',
  ]);
});

test('zamu tasks list --waiting and --ready-to-check; --no-check-again and Done clear a day', async () => {
  expect(listKeys('--waiting')).toEqual(['VND-1']);
  expect(listKeys('--ready-to-check')).toEqual(['VND-2']);

  const cleared = zamu<TaskShape>(['tasks', 'update', 'VND-2', '--no-check-again'], 'zamu.v1.tasks.update');
  expect(cleared.checkAgain ?? null).toBeNull();
  expect(listKeys('--ready-to-check')).toEqual([]);

  // Moving a waiting task to Done takes its day off.
  zamu(
    ['tasks', 'update', 'VND-3', '--check-again', day(3), '--reason', 'The new key is on its way'],
    'zamu.v1.tasks.update',
  );
  expect(listKeys('--waiting')).toEqual(['VND-1', 'VND-3']);
  const done = await api<TaskShape>(page.request, 'PATCH', '/tasks/VND-3', { status: 'done' });
  expect(done.checkAgain ?? null).toBeNull();
  expect(listKeys('--waiting')).toEqual(['VND-1']);

  // The API takes null off a day, and a problem names the missing reason.
  const missing = await page.request.patch('/api/v1/tasks/VND-4', {
    data: { checkAgain: { on: day(2), reason: '' } },
  });
  expect(missing.status()).toBe(400);
  expect(((await missing.json()) as Problem).status).toBe(400);
  await api(page.request, 'PATCH', '/tasks/VND-1', { checkAgain: null });
  expect(listKeys('--waiting')).toEqual([]);
});

test('no page errors during the flow', () => {
  expect(pageErrors).toEqual([]);
});
