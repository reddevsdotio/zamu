// The command palette end to end (0.7.0): Ctrl+K (⌘K on a Mac) opens it, a task key or words of a title find
// the task and Enter opens it; on a task, Change status opens the Set status step, Backspace backs out of it and
// a status sets it with the field toast; the actions apply to the selection in a list; G then P jumps to a
// project; Create task opens quick create. The tests build on each other, so they share one page and run in
// order.
import { type BrowserContext, expect, type Page, test } from '@playwright/test';
import { api, collectPageErrors, homeURL, settle, signInAsAdmin, w } from './session';

const project = { name: 'Commands', key: 'CMD' };
const tasks = [
  { key: 'CMD-1', title: 'Ship the palette' },
  { key: 'CMD-2', title: 'Polish the shortcut list' },
];

test.describe.configure({ mode: 'serial' });

let context: BrowserContext;
let page: Page;
const pageErrors: string[] = [];

function palette() {
  return page.getByRole('dialog', { name: 'Command palette' });
}

function input() {
  return palette().getByRole('combobox');
}

async function taskOf(key: string): Promise<{ status: string; priority: string }> {
  return api(page.request, 'GET', `/tasks/${key}`);
}

/** Takes focus off any control, so single keys and Ctrl+K reach the page. */
async function blur(): Promise<void> {
  await page.evaluate(() => (document.activeElement as HTMLElement | null)?.blur?.());
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

test('seed a project with two tasks', async () => {
  await signInAsAdmin(page);
  await api(page.request, 'POST', '/projects', project);
  for (const task of tasks)
    await api(page.request, 'POST', '/tasks', { project: project.key, title: task.title });
});

test('Ctrl+K opens the palette; a task key finds the task and Enter opens it', async () => {
  await page.goto(w());
  await settle(page);
  await page.keyboard.press('Control+k');
  await expect(palette()).toBeVisible();
  await expect(input()).toBeFocused();
  await page.keyboard.type('CMD-2');
  const option = palette().getByRole('option', { name: /^CMD-2 Polish the shortcut list/ });
  await expect(option).toBeVisible();
  await expect(option).toHaveAttribute('aria-selected', 'true');
  await page.keyboard.press('Enter');
  await expect(page).toHaveURL(new RegExp(`/p/${project.key}/CMD-2$`));
  await expect(palette()).toBeHidden();
  await settle(page);

  // The sidebar's search entry opens it too; words of a title find the task; Esc closes it.
  await page
    .getByRole('navigation', { name: 'Main' })
    .getByRole('button', { name: 'Search or jump to' })
    .click();
  await expect(palette()).toBeVisible();
  await page.keyboard.type('Ship the pal');
  await expect(palette().getByRole('option', { name: /^CMD-1 Ship the palette/ })).toBeVisible();
  await page.keyboard.press('Escape');
  await expect(palette()).toBeHidden();
});

test('Change status: the Set status step, Backspace backs out, a status sets it', async () => {
  await blur();
  await page.keyboard.press('Control+k');
  // On a task, its actions come first, for that task.
  await expect(palette()).toContainText('Actions apply to CMD-2');
  await page.keyboard.type('status');
  await expect(palette().getByRole('option', { name: 'Change status' })).toBeVisible();
  await page.keyboard.press('Enter');
  const step = palette().getByRole('combobox', { name: 'Set status: Pick a status' });
  await expect(step).toBeFocused();
  // The statuses in order, with their number keys (1 to 6).
  await expect(palette().getByRole('listbox', { name: 'Set status' }).getByRole('option')).toHaveText([
    /^Backlog/,
    /^Todo/,
    /^In progress/,
    /^In review/,
    /^Done/,
    /^Canceled/,
  ]);

  // Backspace on the empty input leaves the step.
  await page.keyboard.press('Backspace');
  await expect(palette().getByRole('combobox', { name: 'Command' })).toBeFocused();
  await expect(palette().getByRole('option', { name: 'Change status' })).toBeVisible();

  await palette().getByRole('option', { name: 'Change status' }).click();
  await palette()
    .getByRole('listbox', { name: 'Set status' })
    .getByRole('option', { name: 'In review' })
    .click();
  await expect(palette()).toBeHidden();
  await expect(page.getByRole('status').filter({ hasText: 'Moved CMD-2 to In review' })).toBeVisible();
  await expect.poll(async () => (await taskOf('CMD-2')).status).toBe('in_review');
  await expect(
    page.getByRole('complementary', { name: 'Properties' }).getByRole('button', { name: 'Status' }),
  ).toContainText('In review');
});

test('in a list the actions apply to the selection', async () => {
  await page.goto(w(`/p/${project.key}`));
  await settle(page);
  await page.locator('[role="row"][data-task-key="CMD-1"]').focus();
  await page.keyboard.press('x');
  await expect(page.locator('[role="row"][data-task-key="CMD-1"]')).toHaveAttribute('aria-selected', 'true');
  await page.keyboard.press('Control+k');
  await expect(palette()).toContainText('Actions apply to CMD-1');
  await page.keyboard.type('priority');
  await page.keyboard.press('Enter');
  await palette()
    .getByRole('listbox', { name: 'Set priority' })
    .getByRole('option', { name: 'High' })
    .click();
  await expect(palette()).toBeHidden();
  await expect.poll(async () => (await taskOf('CMD-1')).priority).toBe('high');
  // Esc clears the selection.
  await page.keyboard.press('Escape');
  await expect(page.locator('[role="row"][data-task-key="CMD-1"]')).toHaveAttribute('aria-selected', 'false');
});

test('G then P jumps to a project; Create task opens quick create', async () => {
  await page.goto(w());
  await expect(page).toHaveURL(homeURL);
  await settle(page);
  await blur();
  await page.keyboard.press('g');
  await page.keyboard.press('p');
  await expect(palette().getByRole('combobox', { name: 'Projects: Jump to a project' })).toBeFocused();
  await page.keyboard.type(project.name);
  await palette()
    .getByRole('option', { name: new RegExp(`^Go to ${project.name}`) })
    .click();
  await expect(page).toHaveURL(new RegExp(`/p/${project.key}(\\?|$)`));
  await settle(page);

  await blur();
  await page.keyboard.press('Control+k');
  await page.keyboard.type('Create task');
  await palette().getByRole('option', { name: 'Create task', exact: true }).click();
  const dialog = page.getByRole('dialog', { name: 'New task' });
  await expect(dialog).toBeVisible();
  // In the current project.
  await expect(dialog).toContainText(project.name);
  await page.keyboard.press('Escape');
  await expect(dialog).toBeHidden();
});

test('no page errors during the flow', () => {
  expect(pageErrors).toEqual([]);
});
