// The work views end to end on the 0.7.0 screens: the board (display options, keyboard moves, undo, drag and
// drop), milestones, cycles with an early end and rollover, comments with mentions from the web and from the
// CLI in the task view, the list keys around group rows, Home across two projects, and the theme choice. Like
// the M1 flow, the tests build on each other, so they share one page and run in order. The spec signs in as
// the admin from the M1 flow, or sets the server up itself when it runs alone.
import { type BrowserContext, expect, type Page, test } from '@playwright/test';
import { createCli, parseJson } from './cli';
import { addAgent, admin, api, collectPageErrors, homeURL, settle, signInAsAdmin, w } from './session';
import { baseURL } from './stack';

const checkout = { name: 'Checkout', key: 'CHK' };
const website = { name: 'Website', key: 'WEB' };
const agentName = 'claude-dev';

/** Created in this order, so the board's Todo column in Manual order lists them newest first: CHK-5 on top. */
const checkoutTitles = [
  'Validate the card form',
  'Add the Apple Pay button',
  'Autocomplete addresses',
  'Show the order summary',
  'Accept coupon codes',
];

interface TaskRef {
  key: string;
  status: string;
  rank?: number;
  milestone: { id: string; name: string } | null;
  cycle: { number: number } | null;
}
interface Me {
  user: { id: string; theme: string };
}

test.describe.configure({ mode: 'serial' });

let context: BrowserContext;
let page: Page;
const pageErrors: string[] = [];
const cli = createCli();
let me: Me['user'];

/** Task keys of a board column, top to bottom. */
async function columnKeys(status: string): Promise<string[]> {
  const grid = page.getByRole('grid', { name: status, exact: true });
  return grid
    .locator('[data-card-key]')
    .evaluateAll((cards) => cards.map((card) => card.getAttribute('data-card-key') ?? ''));
}

async function boardOrder(status: string): Promise<string[]> {
  const list = await api<{ items: TaskRef[] }>(
    page.request,
    'GET',
    `/tasks?project=${checkout.key}&status=${status}&order=board`,
  );
  return list.items.map((task) => task.key);
}

async function taskOf(key: string): Promise<TaskRef> {
  return api<TaskRef>(page.request, 'GET', `/tasks/${key}`);
}

/** A row of the open milestones list. */
function milestoneRow(name: string) {
  return page
    .getByRole('list', { name: `Open milestones of ${checkout.name}` })
    .getByRole('listitem')
    .filter({ has: page.getByRole('link', { name, exact: true }) });
}

/** The task view's Properties sidebar. */
function properties() {
  return page.getByRole('complementary', { name: 'Properties' });
}

/**
 * Today in UTC as the calendar names it ("Wednesday, November 4, 2026"): compose sets no APP_TIME_ZONE, so
 * cycles use UTC, and the context runs in UTC too.
 */
const todayLong = () =>
  new Date().toLocaleDateString('en-US', {
    weekday: 'long',
    year: 'numeric',
    month: 'long',
    day: 'numeric',
    timeZone: 'UTC',
  });

/** The field toast after a change ("Moved CHK-3 to In progress · Undo ⌘Z"). */
function toast(text: string) {
  return page.getByRole('status').filter({ hasText: text });
}

/** Focuses a card the way a keyboard user lands on it, so the board's Shift+arrows and Shift+J/K act on it. */
async function focusCard(key: string): Promise<void> {
  const card = page.locator(`[data-card-key="${key}"]`);
  await card.focus();
  await expect(card).toBeFocused();
}

test.beforeAll(async ({ browser }) => {
  // UTC like the server, so "today" in the date pickers is the server's today.
  context = await browser.newContext({
    permissions: ['clipboard-read', 'clipboard-write'],
    timezoneId: 'UTC',
  });
  page = await context.newPage();
  collectPageErrors(page, pageErrors, [
    // A board move that loses a race is retried by design; the 409 shows as a resource error.
    /status of 409\b/,
  ]);
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

test('seed two projects through the API and add an agent', async () => {
  await signInAsAdmin(page);
  me = (await api<Me>(page.request, 'GET', '/me')).user;

  for (const project of [checkout, website]) {
    await api(page.request, 'POST', '/projects', project);
  }
  for (const title of checkoutTitles) {
    await api(page.request, 'POST', '/tasks', { project: checkout.key, title });
  }
  await api(page.request, 'PATCH', '/tasks/CHK-1', { assignee: 'me' });
  await api(page.request, 'POST', '/tasks', {
    project: website.key,
    title: 'Rewrite the pricing page',
    assignee: 'me',
  });
  await api(page.request, 'POST', '/tasks', { project: website.key, title: 'Add an RSS feed to the blog' });

  const key = await addAgent(page, agentName, [checkout.key, website.key]);
  const login = cli.run(['login', '--key', key, '--url', baseURL, '--json']);
  expect(login.code, login.stdout + login.stderr).toBe(0);
});

test('board: Manual order and empty columns from Display; Shift+→ moves a card, Ctrl+Z undoes, Shift+J reorders', async () => {
  await page.goto(w(`/p/${checkout.key}?view=board`));
  await settle(page);
  await expect(page.getByRole('region', { name: 'Todo, 5 tasks' })).toBeVisible();

  // The default order is by priority: Shift+J explains how to reorder by hand.
  await focusCard('CHK-3');
  await page.keyboard.press('Shift+J');
  await expect(toast('Choose Manual in Display to move them by hand.')).toBeVisible();

  // Display options: Manual order, and show the empty columns (In progress, In review …).
  await page.getByRole('button', { name: 'Display' }).click();
  const display = page.getByRole('dialog', { name: 'Display options' });
  await display.getByRole('button', { name: /Order by/ }).click();
  await page.getByRole('listbox', { name: 'Order by' }).getByRole('option', { name: 'Manual' }).click();
  await expect(display.getByRole('button', { name: /Order by/ })).toContainText('Manual');
  await display.getByRole('switch', { name: 'Show empty columns' }).click({ force: true });
  await expect(display.getByRole('switch', { name: 'Show empty columns' })).toBeChecked();
  await page.keyboard.press('Escape');
  await expect(display).toBeHidden();
  await expect(page.getByRole('grid', { name: 'In progress', exact: true })).toBeVisible();
  await expect.poll(() => columnKeys('Todo')).toEqual(['CHK-5', 'CHK-4', 'CHK-3', 'CHK-2', 'CHK-1']);

  await focusCard('CHK-3');
  await page.keyboard.press('Shift+ArrowRight');
  await expect(
    page.getByRole('grid', { name: 'In progress', exact: true }).locator('[data-card-key="CHK-3"]'),
  ).toBeVisible();
  await expect(toast('Moved CHK-3 to In progress')).toBeVisible();
  await expect.poll(async () => (await taskOf('CHK-3')).status).toBe('in_progress');

  // Ctrl+Z (⌘Z on a Mac) is the toast's Undo.
  await page.keyboard.press('Control+z');
  await expect(toast('Moved CHK-3 back to Todo')).toBeVisible();
  await expect.poll(async () => (await taskOf('CHK-3')).status).toBe('todo');
  await expect.poll(() => columnKeys('Todo')).toEqual(['CHK-5', 'CHK-4', 'CHK-3', 'CHK-2', 'CHK-1']);
  expect(await boardOrder('todo')).toEqual(['CHK-5', 'CHK-4', 'CHK-3', 'CHK-2', 'CHK-1']);

  await focusCard('CHK-3');
  await page.keyboard.press('Shift+J');
  await expect.poll(() => columnKeys('Todo')).toEqual(['CHK-5', 'CHK-4', 'CHK-2', 'CHK-3', 'CHK-1']);
  await expect.poll(() => boardOrder('todo')).toEqual(['CHK-5', 'CHK-4', 'CHK-2', 'CHK-3', 'CHK-1']);

  // The order is stored, and so are the display options (per person, project and view): both survive a
  // reload.
  await page.reload();
  await settle(page);
  expect(await columnKeys('Todo')).toEqual(['CHK-5', 'CHK-4', 'CHK-2', 'CHK-3', 'CHK-1']);
  await expect(page.getByRole('grid', { name: 'In review', exact: true })).toBeVisible();

  // V switches to the list and back; the project remembers the last view.
  await page.evaluate(() => (document.activeElement as HTMLElement | null)?.blur?.());
  await page.keyboard.press('v');
  await expect(page.getByRole('region', { name: /^Todo, / })).toBeHidden();
  await expect(page.getByRole('row', { name: /\bCHK-3\b/ })).toBeVisible();
  await settle(page);
  await page.keyboard.press('v');
  await expect(page.getByRole('region', { name: /^Todo, / })).toBeVisible();
  await page.goto(w(`/p/${checkout.key}`));
  await settle(page);
  await expect(page.getByRole('region', { name: /^Todo, / })).toBeVisible();
});

test('board: drag a card to In review', async () => {
  const card = page.locator('[data-card-key="CHK-5"]');
  const target = page.getByRole('grid', { name: 'In review', exact: true });
  await card.dragTo(target);
  await expect(target.locator('[data-card-key="CHK-5"]')).toBeVisible();
  await expect.poll(async () => (await taskOf('CHK-5')).status).toBe('in_review');

  await page.reload();
  await settle(page);
  expect(await columnKeys('In review')).toEqual(['CHK-5']);
});

test('milestone: create, assign in the task view, turns Active when its task starts', async () => {
  await page.goto(w(`/p/${checkout.key}/milestones`));
  await settle(page);
  await page.getByRole('button', { name: 'New milestone' }).first().click();
  const dialog = page.getByRole('dialog', { name: 'New milestone' });
  await expect(dialog).toBeVisible();
  await dialog.getByLabel('Name').fill('Launch');
  await dialog.getByRole('button', { name: /^Create/ }).click();
  await expect(dialog).toBeHidden();
  await expect(milestoneRow('Launch')).toContainText('Planned');

  await page.goto(w(`/p/${checkout.key}/CHK-2`));
  await settle(page);
  const milestone = properties().getByRole('button', { name: 'Milestone' });
  await milestone.click();
  await page
    .getByRole('menu', { name: 'Milestone' })
    .getByRole('menuitemradio', { name: /^Launch/ })
    .click();
  await expect(milestone).toContainText('Launch');

  const status = properties().getByRole('button', { name: 'Status' });
  await status.click();
  await page
    .getByRole('menu', { name: 'Status' })
    .getByRole('menuitemradio', { name: 'In progress' })
    .click();
  await expect(status).toContainText('In progress');

  await page.goto(w(`/p/${checkout.key}/milestones`));
  await settle(page);
  await expect(milestoneRow('Launch')).toContainText('Active');
  const task = await taskOf('CHK-2');
  expect(task.milestone?.name).toBe('Launch');
});

test('cycle: create one starting today, end it early, unfinished tasks roll over', async () => {
  await page.goto(w(`/p/${checkout.key}/cycles`));
  await settle(page);
  await page.getByRole('button', { name: 'New cycle' }).first().click();
  const dialog = page.getByRole('dialog', { name: 'New cycle' });
  await expect(dialog).toBeVisible();
  await dialog.getByRole('textbox').fill('Checkout polish');

  // The first cycle defaults to next Monday; start it today instead.
  await dialog.getByRole('button', { name: /^Starts/ }).click();
  const picker = page.getByRole('dialog', { name: 'Pick starts' });
  const day = picker.getByRole('button', { name: new RegExp(`${todayLong()}$`) });
  if (!(await day.isVisible())) await picker.getByRole('button', { name: 'Previous month' }).click();
  await day.click();
  await expect(dialog.getByRole('button', { name: /^Starts/ })).toBeVisible();
  await dialog.getByRole('button', { name: /^Create/ }).click();
  await expect(dialog).toBeHidden();
  await expect(page.getByRole('region', { name: 'Current cycle: Cycle 1' })).toBeVisible();

  // The agent puts three tasks in the current cycle from the CLI; one of them gets done.
  for (const key of ['CHK-1', 'CHK-3', 'CHK-4']) {
    const update = cli.run(['tasks', 'update', key, '--cycle', 'current', '--json']);
    expect(update.code, update.stdout + update.stderr).toBe(0);
    expect(parseJson<TaskRef>(update, 'zamu.v1.tasks.update').cycle?.number).toBe(1);
  }
  const done = cli.run(['tasks', 'update', 'CHK-4', '--status', 'done', '--json']);
  expect(done.code, done.stdout + done.stderr).toBe(0);

  await page.goto(w(`/p/${checkout.key}/cycles/1`));
  await settle(page);
  await page.getByRole('button', { name: 'End cycle' }).click();
  const end = page.getByRole('dialog', { name: 'End Cycle 1 now?' });
  await expect(end).toBeVisible();
  await expect(end).toContainText('New Cycle 2');
  await end.getByRole('button', { name: 'End and move 2' }).click();
  await expect(end).toBeHidden();

  // The completed cycle page keeps the record of what moved.
  await page.goto(w(`/p/${checkout.key}/cycles/1`));
  await settle(page);
  const cycle = page.getByRole('region', { name: 'Cycle 1' });
  await expect(cycle.getByText('Cycle · completed')).toBeVisible();
  const rolled = cycle.getByRole('region', { name: 'Rolled over, 2' }).getByRole('list');
  await expect(rolled.getByRole('listitem')).toHaveCount(2);
  await expect(rolled.getByRole('listitem').filter({ hasText: 'CHK-1' })).toContainText('Cycle 2');
  await expect(rolled.getByRole('listitem').filter({ hasText: 'CHK-3' })).toContainText('Cycle 2');

  for (const key of ['CHK-1', 'CHK-3']) expect((await taskOf(key)).cycle?.number).toBe(2);
  expect((await taskOf('CHK-4')).cycle?.number).toBe(1);

  const current = cli.run(['cycles', 'current', '--project', checkout.key, '--json']);
  expect(current.code, current.stdout + current.stderr).toBe(0);
});

test('comments: mention from the web, from the CLI as the agent, edit and delete', async () => {
  await page.goto(w(`/p/${checkout.key}/CHK-1`));
  await settle(page);
  const history = page.getByRole('region', { name: 'Activity' });
  await expect(history).toBeVisible();

  // M focuses the composer, @ opens the picker, Enter inserts the mention, Ctrl+Enter sends.
  await page.evaluate(() => (document.activeElement as HTMLElement | null)?.blur?.());
  await page.keyboard.press('m');
  const composer = page.getByRole('textbox', { name: 'Comment' });
  await expect(composer).toBeFocused();
  await page.keyboard.type('Can you take this @clau');
  const picker = page.getByRole('listbox', { name: 'Mention' });
  await expect(picker.getByRole('option', { name: new RegExp(agentName) })).toBeVisible();
  await page.keyboard.press('Enter');
  await expect(picker).toBeHidden();
  await page.keyboard.type('please');
  await page.keyboard.press('Control+Enter');
  // Sent: the box closes.
  await expect(composer).toBeHidden();

  const own = history.getByRole('article', { name: `Comment by ${admin.name}` });
  await expect(own).toHaveCount(1);
  await expect(own.locator('[data-mention]')).toHaveText(new RegExp(agentName));

  // The agent answers from the CLI with a plain @email; the server turns it into a mention.
  const add = cli.run(['comments', 'add', 'CHK-1', `On it. @${admin.email}`, '--json']);
  expect(add.code, add.stdout + add.stderr).toBe(0);
  const agentComment = parseJson<{ id: string; body: string }>(add, 'zamu.v1.comments.add');
  expect(agentComment.body).toBe(`On it. [@${admin.name}](mention:${me.id})`);

  // Only authors edit or delete: the agent cannot delete Ana's comment (exit code 4).
  const list = cli.run(['comments', 'list', 'CHK-1', '--json']);
  expect(list.code, list.stdout + list.stderr).toBe(0);
  const comments = parseJson<{ items: { id: string; author: { name: string } }[] }>(
    list,
    'zamu.v1.comments.list',
  );
  const anaComment = comments.items.find((comment) => comment.author.name === admin.name);
  expect(anaComment).toBeTruthy();
  const refused = cli.run(['comments', 'delete', anaComment?.id ?? '', '--json']);
  expect(refused.code, refused.stdout + refused.stderr).toBe(4);

  await page.reload();
  await settle(page);
  const fromAgent = history.getByRole('article', { name: `Comment by ${agentName}` });
  await expect(fromAgent).toContainText(`acting for ${admin.name.split(' ')[0]}`);
  await expect(fromAgent.locator('[data-mention]')).toHaveText(new RegExp(admin.name));
  // Ana may not edit the agent's comment.
  await expect(fromAgent.getByRole('button', { name: 'Edit' })).toHaveCount(0);

  await own.getByRole('button', { name: 'Edit' }).click();
  const editor = page.getByRole('textbox', { name: 'Edit comment' });
  await editor.fill('Can you take this today?');
  await page.keyboard.press('Control+Enter');
  await expect(own).toContainText('Can you take this today?');
  await expect(own).toContainText('· edited');

  await own.getByRole('button', { name: 'Delete' }).click();
  const confirm = page.getByRole('alertdialog', { name: 'Delete this comment?' });
  await confirm.getByRole('button', { name: 'Delete' }).click();
  await expect(history.getByText(`Comment deleted by ${admin.name}`)).toBeVisible();

  const show = cli.run(['tasks', 'show', 'CHK-1', '--json']);
  expect(show.code, show.stdout + show.stderr).toBe(0);
  const timeline = parseJson<{ timeline: { kind: string }[] }>(show, 'zamu.v1.tasks.show').timeline;
  expect(timeline.filter((entry) => entry.kind === 'comment')).toHaveLength(2);
});

test('task list keys: Down skips a group row, Left collapses the group, Right expands it', async () => {
  // The board test left the board as the remembered view: G then L opens the list (and pins it).
  await page.goto(w(`/p/${checkout.key}/milestones`));
  await settle(page);
  await page.keyboard.press('g');
  await page.keyboard.press('l');
  await expect(page).toHaveURL(new RegExp(`/p/${checkout.key}$`));
  await settle(page);
  const grid = page.getByRole('treegrid', { name: `Tasks in ${checkout.name}` });
  await expect(grid.locator('[data-group-row]').first()).toBeVisible();
  const rows = await grid.locator('[role="row"][data-row-id]').evaluateAll((elements) =>
    elements.map((row) => ({
      id: row.getAttribute('data-row-id') ?? '',
      group: row.hasAttribute('data-group-row'),
    })),
  );
  // The last task of one group, the next group's row, and that group's first task.
  const at = rows.findIndex(
    (row, index) => !row.group && rows[index + 1]?.group && rows[index + 2] && !rows[index + 2]?.group,
  );
  expect(at, JSON.stringify(rows)).toBeGreaterThanOrEqual(0);
  const before = rows[at]?.id ?? '';
  const groupId = rows[at + 1]?.id ?? '';
  const after = rows[at + 2]?.id ?? '';
  const row = (id: string) => grid.locator(`[role="row"][data-row-id="${id}"]`);
  // Group row ids start with a control character, so find the group row by position.
  const groupRow = grid.locator('[data-group-row]').nth(rows.slice(0, at + 1).filter((r) => r.group).length);
  const focusedRow = () =>
    page.evaluate(() => document.activeElement?.closest('[role="row"]')?.getAttribute('data-row-id') ?? null);

  // Focus the row as the keyboard does (a click would open the task view).
  await row(before).focus();
  await expect.poll(focusedRow).toBe(before);
  await expect(row(before)).toHaveAttribute('data-cursor', 'true');

  // Down lands on the next task, not on the group row between them.
  await page.keyboard.press('ArrowDown');
  await expect.poll(focusedRow).toBe(after);
  await expect(row(after)).toHaveAttribute('data-cursor', 'true');

  // Left folds the task's group and puts the cursor on the group row.
  await page.keyboard.press('ArrowLeft');
  await expect(row(after)).toHaveCount(0);
  await expect.poll(focusedRow).toBe(groupId);
  await expect(groupRow).toContainText('collapsed');

  // Right opens it again and focuses its first task.
  await page.keyboard.press('ArrowRight');
  await expect(row(after)).toBeVisible();
  await expect(groupRow).toContainText('expanded');
  await expect.poll(focusedRow).toBe(after);

  // Up skips the group row too.
  await page.keyboard.press('ArrowUp');
  await expect.poll(focusedRow).toBe(before);
});

test('Home lists your tasks from both projects and opens them in the task view', async () => {
  // The agent takes WEB-2: it shows in the agent's --mine, not in Ana's Home.
  const assign = cli.run(['tasks', 'update', 'WEB-2', '--assignee', 'me', '--json']);
  expect(assign.code, assign.stdout + assign.stderr).toBe(0);
  const mine = cli.run(['tasks', 'list', '--mine', '--json']);
  expect(mine.code, mine.stdout + mine.stderr).toBe(0);
  expect(parseJson<{ items: TaskRef[] }>(mine, 'zamu.v1.tasks.list').items.map((task) => task.key)).toEqual([
    'WEB-2',
  ]);

  // G then H goes Home from anywhere.
  await page.keyboard.press('Escape');
  await page.evaluate(() => (document.activeElement as HTMLElement | null)?.blur?.());
  await page.keyboard.press('g');
  await page.keyboard.press('h');
  await expect(page).toHaveURL(homeURL);
  await settle(page);
  // Each task shows once, in its first group: CHK-1 under Mentions (the agent's reply), WEB-1 under
  // Assigned to you.
  const minePanel = page.getByRole('tabpanel', { name: /^Mine/ });
  await expect(minePanel.locator('a[data-task-key="CHK-1"]')).toHaveCount(1);
  const assigned = page.getByRole('region', { name: /^Assigned to you \d+/ });
  await expect(assigned.locator('a[data-task-key="WEB-1"]')).toBeVisible();
  await expect(page.locator('a[data-task-key="WEB-2"]')).toHaveCount(0);

  await assigned.locator('a[data-task-key="WEB-1"]').click();
  await expect(page).toHaveURL(new RegExp(`/p/${website.key}/WEB-1$`));
  await settle(page);
  await expect(
    page.getByRole('navigation', { name: 'Breadcrumb' }).getByRole('link', { name: website.name }),
  ).toBeVisible();
  await expect(page.getByRole('heading', { level: 1, name: /Rewrite the pricing page/ })).toBeVisible();
});

test('theme: Dark from the account menu survives a reload with no flash', async () => {
  await page.goto(w());
  await settle(page);
  await page.getByRole('button', { name: `${admin.name}: account menu` }).click();
  const account = page.getByRole('dialog', { name: 'Account' });
  await account.getByRole('radio', { name: 'Dark' }).click({ force: true });
  await expect(page.locator('html')).toHaveClass(/\bdark\b/);
  await expect.poll(async () => (await api<Me>(page.request, 'GET', '/me')).user.theme).toBe('dark');
  await page.keyboard.press('Escape');

  // The server renders the class, so the first HTML already has it: no light frame before hydration.
  const html = await (await page.request.get('/')).text();
  expect(html).toMatch(/<html[^>]*class="[^"]*\bdark\b/);

  await page.reload();
  await settle(page);
  await expect(page.locator('html')).toHaveClass(/\bdark\b/);
  await page.goto(w('/settings/appearance'));
  await settle(page);
  await expect(page.getByRole('radio', { name: 'Dark' })).toBeChecked();

  // Back to System: no class, the page follows the browser.
  await page.getByRole('radio', { name: /System/ }).click({ force: true });
  await expect.poll(async () => (await api<Me>(page.request, 'GET', '/me')).user.theme).toBe('system');
  const after = await (await page.request.get('/')).text();
  expect(after).not.toMatch(/<html[^>]*class="[^"]*\bdark\b/);
});

test('no page errors during the flow', () => {
  expect(pageErrors).toEqual([]);
});
