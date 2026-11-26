// Archive end to end. A new project archives finished tasks after 14 days: Settings > Archive shows
// the switch, the days and how many tasks the next nightly run would archive, and turns it off and on. The
// nightly job (tasks.archive-due) runs right away with the clock it is given (e2e/jobs.ts), on tasks whose
// finishing time the spec moves back in the database. Three tasks are archived from the list's action bar and
// come back with Undo; the Archived filter lists archived tasks with their day; the palette lists archived
// results after the others, with their tag. An archived task is read-only (the composer asks to restore it
// first, and the API refuses edits and comments with TASK_ARCHIVED) until Restore brings it back.
//
// The tests build on each other, so they share one page and run in order. Days are the server's (compose
// sets no APP_TIME_ZONE, so UTC), and the browser runs in UTC too.
import { type BrowserContext, expect, type Page, test } from '@playwright/test';
import { runJob, sql } from './jobs';
import { api, collectPageErrors, settle, signInAsAdmin, w } from './session';

const project = { name: 'Ledger', key: 'LDG' };
/** LDG-1 to LDG-8. Search finds the ones with "ledger" in the title. */
const titles = [
  'Close the March ledger',
  'Close the April ledger',
  'Reconcile card fees',
  'Drop the old export',
  'Tag the refunds',
  'Split the payout fees',
  'Review the ledger export',
  'Audit the chargebacks',
];
const DAY = 86_400_000;

interface TaskShape {
  id: string;
  key: string;
  title: string;
  status: string;
  archivedAt?: string | null;
  archivedBy?: { name: string } | null;
  closedAt?: string | null;
}
interface ProjectShape {
  id: string;
  key: string;
  archiveAfterDays?: number | null;
}
interface Problem {
  code: string;
  status: number;
}

test.describe.configure({ mode: 'serial' });

let context: BrowserContext;
let page: Page;
let projectId = '';
const pageErrors: string[] = [];

async function taskOf(key: string): Promise<TaskShape> {
  return api<TaskShape>(page.request, 'GET', `/tasks/${key}`);
}

async function projectOf(): Promise<ProjectShape> {
  const list = await api<{ items: ProjectShape[] }>(page.request, 'GET', '/projects');
  const found = list.items.find((item) => item.key === project.key);
  if (!found) throw new Error(`${project.key} is not in the project list`);
  return found;
}

async function archivedKeys(): Promise<string[]> {
  const list = await api<{ items: TaskShape[] }>(
    page.request,
    'GET',
    `/tasks?project=${project.key}&archived=only&limit=100`,
  );
  return list.items.map((item) => item.key).sort();
}

/** Moves the finishing time of tasks back by `days`, as if they had been finished then. */
function finishedDaysAgo(numbers: number[], days: number): void {
  sql(
    `update task set closed_at = now() - interval '${days} days' ` +
      `where project_id = '${projectId}' and number in (${numbers.join(', ')})`,
  );
}

function listRow(key: string) {
  return page
    .getByRole('treegrid', { name: `Tasks in ${project.name}` })
    .locator(`[role="row"][data-task-key="${key}"]`);
}

async function selectedRows(): Promise<string[]> {
  const rows = page.locator('[role="row"][aria-selected="true"][data-task-key]');
  return (
    await rows.evaluateAll((elements) => elements.map((row) => row.getAttribute('data-task-key') ?? ''))
  ).sort();
}

function toast(text: string) {
  return page.getByRole('status').filter({ hasText: text });
}

function previewLine() {
  return page.getByText(/(were|was) finished more than|No finished task is older than/);
}

test.beforeAll(async ({ browser }) => {
  context = await browser.newContext({ timezoneId: 'UTC' });
  page = await context.newPage();
  collectPageErrors(page, pageErrors, [
    // The refused edit of an archived task answers 409 on purpose.
    /status of 409\b/,
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
});

test('Settings > Archive: a new project archives after 14 days, with the count of tonight’s run', async () => {
  await signInAsAdmin(page);
  await api(page.request, 'POST', '/projects', project);
  const created = await projectOf();
  projectId = created.id;
  expect(created.archiveAfterDays).toBe(14);
  for (const title of titles) await api(page.request, 'POST', '/tasks', { project: project.key, title });
  for (const key of ['LDG-1', 'LDG-2', 'LDG-3']) {
    await api(page.request, 'PATCH', `/tasks/${key}`, { status: 'done' });
  }
  await api(page.request, 'PATCH', '/tasks/LDG-4', { status: 'canceled' });
  expect((await taskOf('LDG-1')).closedAt).not.toBeNull();
  expect((await taskOf('LDG-5')).closedAt ?? null).toBeNull();
  finishedDaysAgo([1, 2], 20);
  finishedDaysAgo([3], 10);
  expect(
    await api<{ count: number }>(page.request, 'GET', `/projects/${project.key}/archive-preview?days=14`),
  ).toMatchObject({ days: 14, count: 2 });

  await page.goto(w(`/p/${project.key}/settings/archive`));
  await settle(page);
  await expect(page.getByRole('heading', { name: 'Archive', exact: true })).toBeVisible();
  const toggle = page.getByRole('switch', { name: 'Archive finished tasks' });
  await expect(toggle).toBeChecked();
  const days = page.getByRole('textbox', { name: 'Archive after' });
  await expect(days).toHaveValue('14');
  await expect(previewLine()).toHaveText(
    '2 tasks were finished more than 14 days ago and will be archived tonight.',
  );

  // The preview follows the days as they are typed, before anything is saved.
  await days.fill('7');
  await expect(previewLine()).toHaveText(
    '3 tasks were finished more than 7 days ago and will be archived tonight.',
  );
  await days.fill('30');
  await expect(previewLine()).toHaveText(
    'No finished task is older than 30 days, so nothing is archived tonight.',
  );
  await days.fill('400');
  await days.blur();
  await expect(page.getByText('Use 1 to 365 days.')).toBeVisible();
  await page.getByRole('button', { name: 'Cancel' }).click();
  await expect(days).toHaveValue('14');

  // Off: the page says how many finished tasks stay where they are.
  await toggle.click({ force: true });
  await expect(page.getByText(/^Off: finished tasks stay where they are/)).toHaveText(
    'Off: finished tasks stay where they are until someone archives them by hand. Ledger has 3 Done and 1 Canceled tasks.',
  );
  await page.getByRole('button', { name: 'Save' }).click();
  await expect(page.getByRole('status').filter({ hasText: 'Saved.' })).toBeVisible();
  expect((await projectOf()).archiveAfterDays ?? null).toBeNull();

  // On again: it starts from 14 days.
  await toggle.click({ force: true });
  await expect(days).toHaveValue('14');
  await page.getByRole('button', { name: 'Save' }).click();
  await expect(page.getByRole('status').filter({ hasText: 'Saved.' })).toBeVisible();
  expect((await projectOf()).archiveAfterDays).toBe(14);
});

test('the nightly job archives the tasks finished more than 14 days before the clock it is given', async () => {
  const tonight = runJob<{ archived: number }>('tasks.archive-due', { now: new Date().toISOString() });
  expect(tonight).toMatchObject({ state: 'completed', output: { archived: 2 } });
  expect(await archivedKeys()).toEqual(['LDG-1', 'LDG-2']);
  const archived = await taskOf('LDG-1');
  expect(archived.archivedAt).not.toBeNull();
  // No one archived it: the job did.
  expect(archived.archivedBy ?? null).toBeNull();

  // Five days on, LDG-3 (finished 10 days ago) is due too; LDG-4, canceled today, is not.
  const later = runJob<{ archived: number }>('tasks.archive-due', {
    now: new Date(Date.now() + 5 * DAY).toISOString(),
  });
  expect(later).toMatchObject({ state: 'completed', output: { archived: 1 } });
  expect(await archivedKeys()).toEqual(['LDG-1', 'LDG-2', 'LDG-3']);
  expect((await taskOf('LDG-4')).archivedAt ?? null).toBeNull();

  await page.goto(w(`/p/${project.key}/LDG-1`));
  await settle(page);
  await expect(
    page
      .getByRole('region', { name: 'Activity' })
      .getByRole('listitem')
      .filter({ hasText: 'Zamu archived this · 14 days after it was done' }),
  ).toBeVisible();
});

test('three tasks archived from the action bar leave the list, and Undo brings them back', async () => {
  await page.goto(w(`/p/${project.key}`));
  await settle(page);
  await expect(listRow('LDG-1')).toHaveCount(0);
  await expect(listRow('LDG-5')).toBeVisible();
  await listRow('LDG-8').focus();
  await page.keyboard.press('x');
  await page.keyboard.press('Shift+ArrowDown');
  await page.keyboard.press('Shift+ArrowDown');
  const bar = page.getByRole('toolbar', { name: '3 selected' });
  await expect(bar).toBeVisible();
  const selected = await selectedRows();
  expect(selected).toHaveLength(3);

  await bar.getByRole('button', { name: /^Archive/ }).click();
  await expect(toast('3 tasks archived')).toBeVisible();
  for (const key of selected) await expect(listRow(key)).toHaveCount(0);
  await expect.poll(archivedKeys).toEqual(['LDG-1', 'LDG-2', 'LDG-3', ...selected].sort());

  await toast('3 tasks archived').getByRole('button', { name: 'Undo' }).click();
  await expect.poll(archivedKeys).toEqual(['LDG-1', 'LDG-2', 'LDG-3']);
  for (const key of selected) await expect(listRow(key)).toBeVisible();

  // Archive two of them again, with the key, for the next steps.
  await page.keyboard.press('Escape');
  await listRow('LDG-6').focus();
  await page.keyboard.press('x');
  await listRow('LDG-8').focus();
  await page.keyboard.press('x');
  await expect(page.getByRole('toolbar', { name: '2 selected' })).toBeVisible();
  await page.keyboard.press('Shift+E');
  await expect(toast('2 tasks archived')).toBeVisible();
  await expect.poll(archivedKeys).toEqual(['LDG-1', 'LDG-2', 'LDG-3', 'LDG-6', 'LDG-8']);
});

test('the Archived filter lists archived tasks with their day; search lists them last', async () => {
  await page.goto(w(`/p/${project.key}?archived=only`));
  await settle(page);
  for (const key of ['LDG-1', 'LDG-2', 'LDG-3', 'LDG-6', 'LDG-8']) {
    await expect(listRow(key)).toBeVisible();
    await expect(listRow(key)).toHaveAttribute('data-archived', /.*/);
  }
  await expect(listRow('LDG-5')).toHaveCount(0);
  const today = new Date().toLocaleDateString('en-US', { month: 'short', day: 'numeric', timeZone: 'UTC' });
  await expect(listRow('LDG-6')).toContainText(`Archived ${today}`);

  // The palette: the live task first, then the archived ones with their tag.
  await page.goto(w(`/p/${project.key}`));
  await settle(page);
  await page.keyboard.press('Control+k');
  const palette = page.getByRole('dialog', { name: 'Command palette' });
  await expect(palette).toBeVisible();
  await palette.getByRole('combobox').fill('ledger');
  const tasks = palette.getByRole('group', { name: 'Tasks' });
  await expect(tasks.getByRole('option')).toHaveCount(3, { timeout: 15_000 });
  const names = await tasks
    .getByRole('option')
    .evaluateAll((options) => options.map((option) => option.getAttribute('aria-label') ?? ''));
  expect(names[0]).toBe('LDG-7 Review the ledger export');
  expect(names.slice(1).sort()).toEqual([
    'LDG-1 Close the March ledger, archived',
    'LDG-2 Close the April ledger, archived',
  ]);
  await expect(tasks.getByRole('option').nth(1).locator('[data-part="archived-tag"]')).toHaveText('Archived');
  // Archived results bring the project's archived tasks along, once: here under Go to, since "ledger"
  // matches its title too.
  await expect(palette.getByRole('option', { name: `Show archived tasks in ${project.name}` })).toHaveCount(
    1,
  );
  await page.keyboard.press('Escape');
  await expect(palette).toBeHidden();
});

test('an archived task is read-only until Restore brings it back', async () => {
  await page.goto(w(`/p/${project.key}/LDG-6`));
  await settle(page);
  const bar = page.locator('[data-part="archived-bar"]');
  await expect(bar).toContainText('Archived on');
  await expect(bar).toContainText('It stays out of lists, boards and counts.');
  await expect(page.getByText('Restore the task to comment on it or change it.')).toBeVisible();
  await expect(page.getByRole('button', { name: /Leave a comment/ })).toHaveCount(0);
  await page.keyboard.press('s');
  await expect(toast('Archived: restore the task to change it.')).toBeVisible();

  // The API refuses every write but restore.
  for (const [method, path, data] of [
    ['PATCH', '/tasks/LDG-6', { title: 'Split the payout fees by country' }],
    ['POST', '/tasks/LDG-6/comments', { body: 'Still needed?' }],
  ] as const) {
    const response = await page.request.fetch(`/api/v1${path}`, { method, data });
    expect(response.status(), `${method} ${path}`).toBe(409);
    expect(((await response.json()) as Problem).code).toBe('TASK_ARCHIVED');
  }
  expect((await taskOf('LDG-6')).title).toBe('Split the payout fees');

  await bar.getByRole('button', { name: /Restore/ }).click();
  await expect(toast('1 task restored')).toBeVisible();
  await expect(bar).toBeHidden();
  await expect(page.getByRole('button', { name: /Leave a comment/ })).toBeVisible();
  expect((await taskOf('LDG-6')).archivedAt ?? null).toBeNull();
  await api(page.request, 'PATCH', '/tasks/LDG-6', { title: 'Split the payout fees by country' });

  // A restored finished task gets the full number of days again.
  const restored = await api<{ items: TaskShape[] }>(page.request, 'POST', '/tasks/restore', {
    keys: ['LDG-1'],
  });
  expect(restored.items.map((item) => item.key)).toEqual(['LDG-1']);
  const closedAt = Date.parse((await taskOf('LDG-1')).closedAt ?? '');
  expect(Math.abs(Date.now() - closedAt)).toBeLessThan(5 * 60_000);
  expect(await archivedKeys()).toEqual(['LDG-2', 'LDG-3', 'LDG-8']);
});

test('no page errors during the flow', () => {
  expect(pageErrors).toEqual([]);
});
