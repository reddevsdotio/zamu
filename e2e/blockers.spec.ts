// Blockers end to end (0.7.0): the task view adds a blocker from the same project and the list marks the task
// Blocked; Shift+B adds another; a link that would close a loop is refused with the explanation, in the picker
// and by the API; the blocker shows the reverse ("Blocks"); a done blocker no longer blocks; a blocker is
// removed from the task view. The tests build on each other, so they share one page and run in order.
import { type BrowserContext, expect, type Page, test } from '@playwright/test';
import { api, collectPageErrors, settle, signInAsAdmin, w } from './session';

const project = { name: 'Migrations', key: 'MIG' };
const tasks = {
  add: { key: 'MIG-1', title: 'Add the new column' },
  backfill: { key: 'MIG-2', title: 'Backfill the column' },
  drop: { key: 'MIG-3', title: 'Drop the old column' },
};

interface TaskShape {
  key: string;
  blocked: boolean;
  blockedBy: ({ key: string } | null)[];
  blocks: ({ key: string } | null)[];
}

test.describe.configure({ mode: 'serial' });

let context: BrowserContext;
let page: Page;
const pageErrors: string[] = [];

async function taskOf(key: string): Promise<TaskShape> {
  return api<TaskShape>(page.request, 'GET', `/tasks/${key}`);
}

const keysOf = (refs: ({ key: string } | null)[]) => refs.map((ref) => ref?.key ?? null);

function row(key: string) {
  return page
    .getByRole('treegrid', { name: `Tasks in ${project.name}` })
    .locator(`[role="row"][data-task-key="${key}"]`);
}

function blockedBy() {
  return page.getByRole('region', { name: 'Blocked by' });
}

function picker() {
  return page.getByRole('dialog', { name: 'Blocked by' });
}

/** A search result (or current blocker) of the blocker picker, by task key. */
function result(key: string) {
  return picker().getByRole('menuitem', { name: new RegExp(`\\b${key}\\b`) });
}

test.beforeAll(async ({ browser }) => {
  context = await browser.newContext({ timezoneId: 'UTC' });
  page = await context.newPage();
  collectPageErrors(page, pageErrors, [
    // The refused loop answers 409 on purpose.
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
});

test('seed three tasks', async () => {
  await signInAsAdmin(page);
  await api(page.request, 'POST', '/projects', project);
  for (const task of Object.values(tasks)) {
    const created = await api<{ key: string }>(page.request, 'POST', '/tasks', {
      project: project.key,
      title: task.title,
    });
    expect(created.key).toBe(task.key);
  }
});

test('add a blocker in the task view; the list marks the task Blocked', async () => {
  await page.goto(w(`/p/${project.key}/${tasks.backfill.key}`));
  await settle(page);
  await blockedBy().getByRole('button', { name: 'Add blocker' }).click();
  await expect(picker()).toBeVisible();
  // The picker searches the open tasks of the same project.
  await picker().getByRole('searchbox').fill('new column');
  await result(tasks.add.key).click();
  await expect(picker().getByRole('group', { name: 'Blocked by' })).toContainText(tasks.add.key);
  // The first Esc clears the search, the second closes the picker.
  await page.keyboard.press('Escape');
  await expect(picker().getByRole('searchbox')).toHaveValue('');
  await page.keyboard.press('Escape');
  await expect(picker()).toBeHidden();

  await expect(blockedBy().getByRole('link', { name: new RegExp(tasks.add.key) })).toBeVisible();
  await expect(page.getByRole('complementary', { name: 'Properties' }).getByRole('note')).toHaveText(
    /Blocked\s*by 1 open task/,
  );
  const backfill = await taskOf(tasks.backfill.key);
  expect(keysOf(backfill.blockedBy)).toEqual([tasks.add.key]);
  expect(backfill.blocked).toBe(true);

  // The blocker shows the reverse.
  await page.goto(w(`/p/${project.key}/${tasks.add.key}`));
  await settle(page);
  await expect(blockedBy()).toContainText('Blocks');
  await expect(blockedBy().getByRole('link', { name: tasks.backfill.key, exact: true })).toBeVisible();

  await page.goto(w(`/p/${project.key}`));
  await settle(page);
  await expect(row(tasks.backfill.key)).toContainText('Blocked');
  await expect(row(tasks.add.key)).not.toContainText('Blocked');
});

test('Shift+B adds a blocker; a loop is refused with the explanation', async () => {
  await page.goto(w(`/p/${project.key}/${tasks.drop.key}`));
  await settle(page);
  await page.evaluate(() => (document.activeElement as HTMLElement | null)?.blur?.());
  await page.keyboard.press('Shift+B');
  await expect(picker()).toBeVisible();
  await picker().getByRole('searchbox').fill('Backfill');
  await result(tasks.backfill.key).click();
  await expect
    .poll(async () => keysOf((await taskOf(tasks.drop.key)).blockedBy))
    .toEqual([tasks.backfill.key]);
  await page.keyboard.press('Escape');

  // MIG-2 already waits on MIG-1: the picker on MIG-1 says so before anything is sent.
  await page.goto(w(`/p/${project.key}/${tasks.add.key}`));
  await settle(page);
  await blockedBy().getByRole('button', { name: 'Add blocker' }).click();
  await picker().getByRole('searchbox').fill('Backfill');
  await expect(picker()).toContainText(
    new RegExp(`Can.t add: ${tasks.backfill.key} already waits on ${tasks.add.key}\\.`),
  );

  // MIG-3 waits on MIG-1 through MIG-2: the server refuses that loop, and the picker shows why.
  await picker().getByRole('searchbox').fill('Drop the old');
  await result(tasks.drop.key).click();
  await expect(picker()).toContainText(
    new RegExp(`Can.t add: ${tasks.drop.key} already waits on ${tasks.add.key}\\.`),
  );
  await page.keyboard.press('Escape');
  expect(keysOf((await taskOf(tasks.add.key)).blockedBy)).toEqual([]);

  const refused = await page.request.patch(`/api/v1/tasks/${tasks.add.key}`, {
    data: { addBlockers: [tasks.drop.key] },
  });
  expect(refused.status()).toBe(409);
  expect(await refused.json()).toMatchObject({
    code: 'DEPENDENCY_LOOP',
    detail: `Can't add: ${tasks.drop.key} already waits on ${tasks.add.key}.`,
    loop: { task: tasks.add.key, blocker: tasks.drop.key },
  });

  // Blockers stay in one project.
  await api(page.request, 'POST', '/projects', { name: 'Elsewhere', key: 'ELS' });
  const other = await api<{ key: string }>(page.request, 'POST', '/tasks', {
    project: 'ELS',
    title: 'Other',
  });
  const cross = await page.request.patch(`/api/v1/tasks/${tasks.add.key}`, {
    data: { addBlockers: [other.key] },
  });
  expect(cross.status()).toBeGreaterThanOrEqual(400);
  expect(await cross.json()).toMatchObject({ code: 'NOT_SAME_PROJECT' });
});

test('a done blocker no longer blocks; Remove blocker takes one off', async () => {
  // Status changes are never refused: MIG-1 can be done while nothing waits on it.
  await api(page.request, 'PATCH', `/tasks/${tasks.add.key}`, { status: 'done' });
  expect((await taskOf(tasks.backfill.key)).blocked).toBe(false);
  expect((await taskOf(tasks.drop.key)).blocked).toBe(true);

  await page.goto(w(`/p/${project.key}`));
  await settle(page);
  await expect(row(tasks.backfill.key)).not.toContainText('Blocked');
  await expect(row(tasks.drop.key)).toContainText('Blocked');

  await page.goto(w(`/p/${project.key}/${tasks.drop.key}`));
  await settle(page);
  await blockedBy()
    .getByRole('button', { name: `Remove blocker ${tasks.backfill.key}` })
    .click();
  await expect(blockedBy().getByRole('link', { name: new RegExp(tasks.backfill.key) })).toHaveCount(0);
  await expect.poll(async () => (await taskOf(tasks.drop.key)).blocked).toBe(false);
  expect(keysOf((await taskOf(tasks.backfill.key)).blocks)).toEqual([]);
});

test('no page errors during the flow', () => {
  expect(pageErrors).toEqual([]);
});
