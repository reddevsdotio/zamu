// Subtasks end to end (0.7.0): Add subtask in the task view creates one that takes the parent's assignee and
// adds an existing task; subtasks go one level deep; the list nests them under their parent; the board hides
// them by default, the parent card counts them ("2 subtasks · 1 done", canceled left out) and expands in
// place; Display shows them as their own cards. The tests build on each other, so they share one page and run
// in order.
import { type BrowserContext, expect, type Page, test } from '@playwright/test';
import { admin, api, collectPageErrors, settle, signInAsAdmin, w } from './session';

const project = { name: 'Onboarding', key: 'ONB' };
const parent = { key: 'ONB-1', title: 'Build the welcome flow' };
const existing = { key: 'ONB-2', title: 'Write the welcome email' };
const created = { key: 'ONB-3', title: 'Pick the avatar set' };

interface TaskShape {
  key: string;
  assignee: { name: string } | null;
  parent: { key: string } | null;
  subtasks: { key: string }[];
  subtaskProgress: { done: number; total: number };
}

test.describe.configure({ mode: 'serial' });

let context: BrowserContext;
let page: Page;
const pageErrors: string[] = [];

async function taskOf(key: string): Promise<TaskShape> {
  return api<TaskShape>(page.request, 'GET', `/tasks/${key}`);
}

function subtasks() {
  return page.getByRole('region', { name: 'Subtasks' });
}

function picker() {
  return page.getByRole('dialog', { name: 'Add subtask' });
}

async function cardKeys(): Promise<string[]> {
  return page
    .locator('[data-card-key]')
    .evaluateAll((cards) => cards.map((card) => card.getAttribute('data-card-key') ?? ''));
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

test('seed a parent assigned to the admin and another task', async () => {
  await signInAsAdmin(page);
  await api(page.request, 'POST', '/projects', project);
  await api(page.request, 'POST', '/tasks', { project: project.key, title: parent.title, assignee: 'me' });
  await api(page.request, 'POST', '/tasks', { project: project.key, title: existing.title });
});

test('Add subtask: a new one takes the parent assignee; an existing task joins', async () => {
  await page.goto(w(`/p/${project.key}/${parent.key}`));
  await settle(page);
  await subtasks().getByRole('button', { name: 'Add subtask' }).click();
  await expect(picker()).toBeVisible();
  await picker().getByRole('searchbox').fill(created.title);
  await expect(picker().getByRole('menuitem', { name: `Create subtask “${created.title}”` })).toBeVisible();
  // The note says who the new subtask goes to.
  await expect(picker().getByRole('note')).toContainText(admin.name.split(' ')[0] ?? admin.name);
  // ⌘Enter (Ctrl+Enter here) creates the subtask from the typed text.
  await page.keyboard.press('Control+Enter');
  await expect(
    subtasks().getByRole('link', { name: new RegExp(`${created.key} ${created.title}`) }),
  ).toBeVisible();

  if (!(await picker().isVisible())) await subtasks().getByRole('button', { name: 'Add subtask' }).click();
  await picker().getByRole('searchbox').fill('welcome email');
  await picker()
    .getByRole('menuitem', { name: new RegExp(`^${existing.key} `) })
    .click();
  await expect(subtasks().getByRole('link', { name: new RegExp(existing.key) })).toBeVisible();
  if (await picker().isVisible()) await page.keyboard.press('Escape');
  await expect(subtasks().getByRole('img', { name: '0 of 2 subtasks done' })).toBeVisible();

  const newOne = await taskOf(created.key);
  expect(newOne.parent?.key).toBe(parent.key);
  expect(newOne.assignee?.name).toBe(admin.name);
  // An existing task keeps its own assignee.
  const joined = await taskOf(existing.key);
  expect(joined.parent?.key).toBe(parent.key);
  expect(joined.assignee).toBeNull();
  expect((await taskOf(parent.key)).subtaskProgress).toEqual({ done: 0, total: 2 });
});

test('subtasks go one level deep', async () => {
  const response = await page.request.post('/api/v1/tasks', {
    data: { project: project.key, title: 'Too deep', parent: created.key },
  });
  expect(response.status()).toBeGreaterThanOrEqual(400);
  expect(await response.json()).toMatchObject({ code: 'SUBTASK_DEPTH' });
});

test('the list nests subtasks under their parent', async () => {
  await page.goto(w(`/p/${project.key}`));
  await settle(page);
  const grid = page.getByRole('treegrid', { name: `Tasks in ${project.name}` });
  const row = (key: string) => grid.locator(`[role="row"][data-task-key="${key}"]`);
  await expect(row(parent.key)).toHaveAttribute('aria-level', '2');
  await expect(row(created.key)).toHaveAttribute('aria-level', '3');
  await expect(row(existing.key)).toHaveAttribute('aria-level', '3');
  await expect(row(parent.key).getByRole('img', { name: '0 of 2 subtasks done' })).toBeVisible();
});

test('the board hides subtasks; the parent card counts them and expands in place', async () => {
  await api(page.request, 'PATCH', `/tasks/${existing.key}`, { status: 'done' });
  await page.goto(w(`/p/${project.key}?view=board`));
  await settle(page);
  await expect.poll(cardKeys).toEqual([parent.key]);
  const card = page.locator(`[data-card-key="${parent.key}"]`);
  await expect(card).toContainText('2 subtasks · 1 done');

  await card.getByRole('button', { name: `Show the 2 subtasks of ${parent.key}, 1 done` }).click();
  await expect(card.getByRole('button', { name: `${created.key} ${created.title}, Todo` })).toBeVisible();
  await expect(card.getByRole('button', { name: `${existing.key} ${existing.title}, Done` })).toBeVisible();
  // Still one card: they expand inside the parent.
  expect(await cardKeys()).toEqual([parent.key]);
  await card.getByRole('button', { name: `Hide the 2 subtasks of ${parent.key}, 1 done` }).click();
  await expect(card.getByRole('button', { name: new RegExp(`^${created.key} `) })).toHaveCount(0);

  // Canceled subtasks leave the progress.
  await api(page.request, 'PATCH', `/tasks/${created.key}`, { status: 'canceled' });
  expect((await taskOf(parent.key)).subtaskProgress).toEqual({ done: 1, total: 1 });
  await api(page.request, 'PATCH', `/tasks/${created.key}`, { status: 'todo' });
});

test('Display: subtasks as their own cards, then back to the default', async () => {
  await page.goto(w(`/p/${project.key}?view=board`));
  await settle(page);
  await page.getByRole('button', { name: 'Display' }).click();
  const display = page.getByRole('dialog', { name: 'Display options' });
  await display.getByRole('switch', { name: 'Show subtasks as cards' }).click({ force: true });
  await expect(display.getByRole('switch', { name: 'Show subtasks as cards' })).toBeChecked();
  await expect(page.locator(`[data-card-key="${created.key}"]`)).toBeVisible();
  await expect(
    page.getByRole('grid', { name: 'Todo', exact: true }).locator(`[data-card-key="${created.key}"]`),
  ).toBeVisible();

  await display.getByRole('button', { name: 'Reset to default' }).click();
  await expect(display.getByRole('switch', { name: 'Show subtasks as cards' })).not.toBeChecked();
  await page.keyboard.press('Escape');
  await expect(page.locator(`[data-card-key="${created.key}"]`)).toHaveCount(0);
});

test('no page errors during the flow', () => {
  expect(pageErrors).toEqual([]);
});
