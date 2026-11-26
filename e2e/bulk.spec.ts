// Bulk changes in a native project end to end (0.7.0): X selects rows in the list and the action bar changes
// the status of all of them, with Ctrl+Z as the toast's Undo; Shift+↓ extends the selection and the task keys
// (L, the bar's Priority) act on every selected task; Ctrl+A (⌘A) selects everything and Esc clears; on the
// board X selects cards and S sets their status. Each change is one tasks.bulkUpdate call with one activity
// row per task. The tests build on each other, so they share one page and run in order.
import { type BrowserContext, expect, type Page, test } from '@playwright/test';
import { api, collectPageErrors, settle, signInAsAdmin, w } from './session';

const project = { name: 'Triage', key: 'TRI' };
const titles = ['Crash on empty cart', 'Slow search page', 'Typo on the pricing page', 'Broken footer link'];
const keys = titles.map((_, index) => `${project.key}-${index + 1}`);

interface TaskShape {
  key: string;
  status: string;
  priority: string;
  labels: { name: string }[];
}

test.describe.configure({ mode: 'serial' });

let context: BrowserContext;
let page: Page;
const pageErrors: string[] = [];

async function tasksByKey(): Promise<Record<string, TaskShape>> {
  const list = await api<{ items: TaskShape[] }>(page.request, 'GET', `/tasks?project=${project.key}`);
  return Object.fromEntries(list.items.map((task) => [task.key, task]));
}

async function statuses(selected: string[]): Promise<string[]> {
  const tasks = await tasksByKey();
  return selected.map((key) => tasks[key]?.status ?? '');
}

async function activityCount(key: string): Promise<number> {
  const timeline = await api<{ items: { kind: string }[] }>(page.request, 'GET', `/tasks/${key}/timeline`);
  return timeline.items.filter((item) => item.kind === 'activity').length;
}

function row(key: string) {
  return page
    .getByRole('treegrid', { name: `Tasks in ${project.name}` })
    .locator(`[role="row"][data-task-key="${key}"]`);
}

/** The action bar: "2 selected". */
function bar(count: number) {
  return page.getByRole('toolbar', { name: `${count} selected` });
}

/** Keys of the selected list rows, sorted. */
async function selectedRows(): Promise<string[]> {
  const rows = page.locator('[role="row"][aria-selected="true"][data-task-key]');
  return (
    await rows.evaluateAll((elements) => elements.map((row) => row.getAttribute('data-task-key') ?? ''))
  ).sort();
}

test.beforeAll(async ({ browser }) => {
  context = await browser.newContext({ timezoneId: 'UTC' });
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
});

test('seed four tasks in a native project', async () => {
  await signInAsAdmin(page);
  await api(page.request, 'POST', '/projects', project);
  for (const title of titles) await api(page.request, 'POST', '/tasks', { project: project.key, title });
});

test('X selects two rows; the action bar moves both to In review; Ctrl+Z undoes it', async () => {
  await page.goto(w(`/p/${project.key}`));
  await settle(page);
  await row('TRI-1').focus();
  await page.keyboard.press('x');
  await row('TRI-2').focus();
  await page.keyboard.press('x');
  await expect.poll(selectedRows).toEqual(['TRI-1', 'TRI-2']);
  await expect(bar(2)).toBeVisible();
  const activityBefore = await activityCount('TRI-1');

  await bar(2).getByRole('button', { name: 'Status' }).click();
  await page.getByRole('menu', { name: 'Status' }).getByRole('menuitemradio', { name: 'In review' }).click();
  await expect(page.getByRole('status').filter({ hasText: 'Moved 2 tasks to In review' })).toBeVisible();
  await expect.poll(() => statuses(['TRI-1', 'TRI-2', 'TRI-3'])).toEqual(['in_review', 'in_review', 'todo']);
  // One activity row per task.
  expect(await activityCount('TRI-1')).toBe(activityBefore + 1);

  await page.keyboard.press('Control+z');
  await expect.poll(() => statuses(['TRI-1', 'TRI-2'])).toEqual(['todo', 'todo']);
});

test('Shift+↓ extends the selection; L and the bar’s Priority change every selected task', async () => {
  await page.keyboard.press('Escape');
  await expect(bar(2)).toBeHidden();
  await page.reload();
  await settle(page);
  await row('TRI-1').focus();
  await page.keyboard.press('x');
  await page.keyboard.press('Shift+ArrowDown');
  await page.keyboard.press('Shift+ArrowDown');
  await expect(bar(3)).toBeVisible();
  const selected = await selectedRows();
  expect(selected).toHaveLength(3);

  await page.keyboard.press('l');
  const labels = page.getByRole('dialog', { name: 'Labels' });
  await expect(labels).toBeVisible();
  await page.keyboard.type('triaged');
  await page.keyboard.press('Enter');
  await page.keyboard.press('Escape');
  await expect(labels).toBeHidden();
  await expect
    .poll(async () => {
      const tasks = await tasksByKey();
      return selected.map((key) => tasks[key]?.labels.map((label) => label.name) ?? []);
    })
    .toEqual(selected.map(() => ['triaged']));

  await bar(3).getByRole('button', { name: 'Priority' }).click();
  await page.getByRole('menu', { name: 'Priority' }).getByRole('menuitemradio', { name: 'Urgent' }).click();
  await expect
    .poll(async () => {
      const tasks = await tasksByKey();
      return selected.map((key) => tasks[key]?.priority);
    })
    .toEqual(selected.map(() => 'urgent'));
  const untouched = keys.find((key) => !selected.includes(key)) ?? '';
  expect((await tasksByKey())[untouched]).toMatchObject({ priority: 'none', labels: [] });
});

test('Ctrl+A selects every task in the view; Esc clears the selection', async () => {
  await page.keyboard.press('Escape');
  await row('TRI-1').focus();
  await page.keyboard.press('Control+a');
  await expect(bar(4)).toBeVisible();
  await page.keyboard.press('Escape');
  await expect(bar(4)).toBeHidden();
  expect(await selectedRows()).toEqual([]);
});

test('the board: X selects two cards, S sets the status of both', async () => {
  await page.goto(w(`/p/${project.key}?view=board`));
  await settle(page);
  for (const key of ['TRI-3', 'TRI-4']) {
    const card = page.locator(`[data-card-key="${key}"]`);
    await card.focus();
    await page.keyboard.press('x');
  }
  await page.keyboard.press('s');
  await page
    .getByRole('menu', { name: 'Status' })
    .getByRole('menuitemradio', { name: 'In progress' })
    .click();
  await expect.poll(() => statuses(['TRI-3', 'TRI-4'])).toEqual(['in_progress', 'in_progress']);
  await expect(
    page.getByRole('grid', { name: 'In progress', exact: true }).locator('[data-card-key]'),
  ).toHaveCount(2);
});

test('no page errors during the flow', () => {
  expect(pageErrors).toEqual([]);
});
