// Due dates end to end (0.7.0): the list shows overdue, tomorrow, future and done dates as the brief says;
// the due-date picker sets one from a quick pick, from a typed date and clears it; the Due date filter keeps
// the overdue tasks; Home puts an overdue task of yours in Overdue and close dates in the deadlines strip.
// Days are the server's (compose sets no APP_TIME_ZONE, so UTC), and the browser runs in UTC too. The tests
// build on each other, so they share one page and run in order.
import { type BrowserContext, expect, type Page, test } from '@playwright/test';
import { api, collectPageErrors, homeURL, settle, signInAsAdmin, w } from './session';

const project = { name: 'Releases', key: 'REL' };

/** YYYY-MM-DD, `days` from today in UTC. */
function day(days: number): string {
  const date = new Date();
  date.setUTCDate(date.getUTCDate() + days);
  return date.toISOString().slice(0, 10);
}

/** "Dec 4" as the app writes a date, with the year when it is not this year's. */
function shortDate(iso: string): string {
  const date = new Date(`${iso}T00:00:00Z`);
  const text = date.toLocaleDateString('en-US', { month: 'short', day: 'numeric', timeZone: 'UTC' });
  return iso.slice(0, 4) === day(0).slice(0, 4) ? text : `${text}, ${iso.slice(0, 4)}`;
}

const tasks = {
  overdue: { key: 'REL-1', title: 'Tag the release candidate', dueDate: day(-3), assignee: 'me' },
  tomorrow: { key: 'REL-2', title: 'Write the release notes', dueDate: day(1), assignee: 'me' },
  later: { key: 'REL-3', title: 'Announce the release', dueDate: day(30) },
  done: { key: 'REL-4', title: 'Archive old builds', dueDate: day(-5), status: 'done' },
  none: { key: 'REL-5', title: 'Update the changelog' },
};

test.describe.configure({ mode: 'serial' });

let context: BrowserContext;
let page: Page;
const pageErrors: string[] = [];

async function dueOf(key: string): Promise<string | null> {
  return (await api<{ dueDate: string | null }>(page.request, 'GET', `/tasks/${key}`)).dueDate;
}

function row(key: string) {
  return page
    .getByRole('treegrid', { name: `Tasks in ${project.name}` })
    .locator(`[role="row"][data-task-key="${key}"]`);
}

function dueButton() {
  return page.getByRole('complementary', { name: 'Properties' }).getByRole('button', { name: 'Due' });
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

test('seed tasks due in the past, tomorrow and later, one done and one with no date', async () => {
  await signInAsAdmin(page);
  await api(page.request, 'POST', '/projects', project);
  for (const { key, ...task } of Object.values(tasks)) {
    const created = await api<{ key: string }>(page.request, 'POST', '/tasks', {
      project: project.key,
      ...task,
    });
    expect(created.key).toBe(key);
  }
  // Overdue counts open tasks only; tasks.list says so through its due filter.
  const overdue = await api<{ items: { key: string }[] }>(
    page.request,
    'GET',
    `/tasks?project=${project.key}&due=overdue`,
  );
  expect(overdue.items.map((task) => task.key)).toEqual([tasks.overdue.key]);
  const soon = await api<{ items: { key: string }[] }>(
    page.request,
    'GET',
    `/tasks?project=${project.key}&due=soon`,
  );
  expect(soon.items.map((task) => task.key)).toEqual([tasks.tomorrow.key]);
});

test('the list shows overdue, tomorrow and later dates; a done task keeps its date quietly', async () => {
  await page.goto(w(`/p/${project.key}`));
  await settle(page);
  await expect(row(tasks.overdue.key)).toContainText('3 days overdue');
  await expect(row(tasks.tomorrow.key)).toContainText('Tomorrow');
  await expect(row(tasks.later.key)).toContainText(shortDate(tasks.later.dueDate));
  await expect(row(tasks.none.key)).not.toContainText(/overdue|Today|Tomorrow/);

  // Done starts folded in the list; the task view shows the date without "overdue".
  await page.goto(w(`/p/${project.key}/${tasks.done.key}`));
  await settle(page);
  await expect(dueButton()).toContainText(shortDate(tasks.done.dueDate));
  await expect(dueButton()).not.toContainText('overdue');
});

test('the due-date picker: Today, a typed date, Clear due date', async () => {
  await page.goto(w(`/p/${project.key}/${tasks.none.key}`));
  await settle(page);
  await dueButton().click();
  const picker = page.getByRole('dialog', { name: 'Due date' });
  await picker.getByRole('menuitem', { name: /^Today/ }).click();
  await expect(dueButton()).toContainText('Today');
  await expect.poll(() => dueOf(tasks.none.key)).toBe(day(0));

  // Shift+D opens it from the keyboard; a typed date reads as one.
  await page.evaluate(() => (document.activeElement as HTMLElement | null)?.blur?.());
  await page.keyboard.press('Shift+D');
  await expect(picker).toBeVisible();
  await picker.getByRole('searchbox').fill(day(10));
  await page.keyboard.press('Enter');
  await expect.poll(() => dueOf(tasks.none.key)).toBe(day(10));
  await expect(dueButton()).toContainText(/In 10 days|[A-Z][a-z]{2} \d{1,2}/);

  if (!(await picker.isVisible())) await dueButton().click();
  await picker.getByRole('button', { name: 'Clear due date' }).click();
  await expect.poll(() => dueOf(tasks.none.key)).toBeNull();
  await expect(dueButton()).toContainText('Set due date');
});

test('the Due date filter keeps the overdue tasks', async () => {
  await page.goto(w(`/p/${project.key}`));
  await settle(page);
  await page.getByRole('button', { name: 'Filter', exact: true }).click();
  await page.getByRole('menu', { name: 'Filter' }).getByRole('menuitem', { name: 'Due date' }).click();
  await page
    .getByRole('dialog', { name: 'Due date' })
    .getByRole('menuitemradio', { name: 'Overdue' })
    .click();
  await page.keyboard.press('Escape');
  await page.keyboard.press('Escape');
  await expect.poll(() => new URL(page.url()).searchParams.get('due')).toBe('overdue');
  await expect(row(tasks.overdue.key)).toBeVisible();
  for (const task of [tasks.tomorrow, tasks.later, tasks.none]) await expect(row(task.key)).toHaveCount(0);
  await expect(page.getByRole('toolbar', { name: 'Filters' })).toContainText('1 of');
});

test('Home: Overdue lists your late task; the deadlines strip has the close dates', async () => {
  await page.goto(w());
  await expect(page).toHaveURL(homeURL);
  await settle(page);
  const overdue = page.getByRole('region', { name: /^Overdue \d+/ });
  const late = overdue.locator(`a[data-task-key="${tasks.overdue.key}"]`);
  await expect(late).toBeVisible();
  await expect(late).toContainText(/3 d(ays)? overdue/);

  // Tasks of yours due within 2 days or overdue show above the groups.
  const deadlines = page.getByRole('region', { name: 'Deadlines' });
  await expect(
    deadlines.getByRole('link', { name: `${tasks.overdue.key}, ${tasks.overdue.title}, 3 days overdue` }),
  ).toBeVisible();
  await expect(deadlines.getByRole('link', { name: new RegExp(`^${tasks.tomorrow.key}, `) })).toContainText(
    /tomorrow/i,
  );
  // A task due in a month is not a deadline yet.
  await expect(deadlines.getByRole('link', { name: new RegExp(`^${tasks.later.key}, `) })).toHaveCount(0);

  // The overdue task counts toward the sidebar's Home count.
  const counts = await api<{ overdue: number }>(page.request, 'GET', '/home/counts');
  expect(counts.overdue).toBeGreaterThanOrEqual(1);
});

test('no page errors during the flow', () => {
  expect(pageErrors).toEqual([]);
});
