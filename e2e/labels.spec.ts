// Labels end to end (0.7.0): L on a list row opens the label picker, where typing a new name creates the label;
// the task view adds an existing label and creates another; the list filters by label; Settings > Labels
// renames a label in place (refusing a name the project has) and deletes one after saying how many tasks
// lose it. The tests build on each other, so they share one page and run in order. The spec signs in as the
// admin of the other specs, or sets the server up when it runs alone.
import { type BrowserContext, expect, type Page, test } from '@playwright/test';
import { api, collectPageErrors, settle, signInAsAdmin, w } from './session';

const project = { name: 'Storefront', key: 'SHOP' };
const titles = [
  'Fix the cart badge',
  'Redesign the checkout',
  'Cache product images',
  'Write the size guide',
];

interface LabelRef {
  id: string;
  name: string;
  color: number;
  source: string;
}
interface TaskShape {
  key: string;
  labels: LabelRef[];
}

test.describe.configure({ mode: 'serial' });

let context: BrowserContext;
let page: Page;
const pageErrors: string[] = [];

async function labelsOf(key: string): Promise<string[]> {
  const task = await api<TaskShape>(page.request, 'GET', `/tasks/${key}`);
  return task.labels.map((label) => label.name).sort();
}

async function projectLabels(): Promise<(LabelRef & { usageCount: number })[]> {
  return (
    await api<{ items: (LabelRef & { usageCount: number })[] }>(
      page.request,
      'GET',
      `/projects/${project.key}/labels`,
    )
  ).items;
}

/** A task row of the project list. */
function row(key: string) {
  return page
    .getByRole('treegrid', { name: `Tasks in ${project.name}` })
    .locator(`[role="row"][data-task-key="${key}"]`);
}

/** A row of the table in Settings > Labels. */
function labelRow(name: string) {
  return page
    .getByRole('table', { name: 'Labels' })
    .getByRole('row')
    .filter({ has: page.getByRole('cell', { name, exact: true }) });
}

test.beforeAll(async ({ browser }) => {
  context = await browser.newContext({ timezoneId: 'UTC' });
  page = await context.newPage();
  collectPageErrors(page, pageErrors, [
    // The refused rename (a name the project has) answers 409 on purpose.
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

test('seed a project with four tasks', async () => {
  await signInAsAdmin(page);
  await api(page.request, 'POST', '/projects', project);
  for (const title of titles) await api(page.request, 'POST', '/tasks', { project: project.key, title });
  expect(await projectLabels()).toEqual([]);
});

test('L on a list row opens the label picker; a new name creates the label', async () => {
  await page.goto(w(`/p/${project.key}`));
  await settle(page);
  await row('SHOP-1').focus();
  await expect(row('SHOP-1')).toHaveAttribute('data-cursor', 'true');
  await page.keyboard.press('l');

  const picker = page.getByRole('dialog', { name: 'Labels' });
  const search = picker.getByRole('searchbox', { name: 'Add labels' });
  await expect(search).toBeFocused();
  await page.keyboard.type('frontend');
  const create = picker.getByRole('menuitemcheckbox', { name: 'Create label “frontend”' });
  await expect(create).toBeVisible();
  // The app picks a colour for a new label; the swatches can change it before Enter.
  await expect(picker.getByRole('radiogroup', { name: 'Colour' })).toBeVisible();
  await page.keyboard.press('Enter');
  await expect(picker.getByRole('menuitemcheckbox', { name: /^frontend/ })).toHaveAttribute(
    'aria-checked',
    'true',
  );
  await page.keyboard.press('Escape');
  await expect(picker).toBeHidden();

  await expect(row('SHOP-1')).toContainText('frontend');
  expect(await labelsOf('SHOP-1')).toEqual(['frontend']);
  const [label] = await projectLabels();
  expect(label).toMatchObject({ name: 'frontend', source: 'app', usageCount: 1 });
  expect(label?.color).toBeGreaterThanOrEqual(1);
  expect(label?.color).toBeLessThanOrEqual(9);
});

test('the task view adds an existing label and creates another', async () => {
  await page.goto(w(`/p/${project.key}/SHOP-2`));
  await settle(page);
  const button = page
    .getByRole('complementary', { name: 'Properties' })
    .getByRole('button', { name: 'Labels' });
  await button.click();
  const picker = page.getByRole('dialog', { name: 'Labels' });
  await picker.getByRole('menuitemcheckbox', { name: /^frontend/ }).click();
  await expect(picker.getByRole('menuitemcheckbox', { name: /^frontend/ })).toHaveAttribute(
    'aria-checked',
    'true',
  );
  // Names are unique per project, ignoring case: "Frontend" finds the existing label.
  await picker.getByRole('searchbox', { name: 'Add labels' }).fill('Frontend');
  await expect(picker.getByRole('menuitemcheckbox', { name: /^Create label/ })).toHaveCount(0);
  await picker.getByRole('searchbox', { name: 'Add labels' }).fill('backend');
  await picker.getByRole('menuitemcheckbox', { name: 'Create label “backend”' }).click();
  await expect(picker.getByRole('menuitemcheckbox', { name: /^backend/ })).toHaveAttribute(
    'aria-checked',
    'true',
  );
  await page.keyboard.press('Escape');
  await expect(picker).toBeHidden();
  await expect(button).toContainText('frontend');
  await expect(button).toContainText('backend');
  expect(await labelsOf('SHOP-2')).toEqual(['backend', 'frontend']);

  // The API creates labels by name too.
  await api(page.request, 'PATCH', '/tasks/SHOP-3', { labels: ['backend'] });
});

test('the list filters by label', async () => {
  await page.goto(w(`/p/${project.key}`));
  await settle(page);
  await page.getByRole('button', { name: 'Filter', exact: true }).click();
  await page.getByRole('menu', { name: 'Filter' }).getByRole('menuitem', { name: 'Labels' }).click();
  await page
    .getByRole('dialog', { name: 'Labels' })
    .getByRole('menuitemcheckbox', { name: /^frontend/ })
    .click();
  await page.keyboard.press('Escape');
  await page.keyboard.press('Escape');

  const frontend = (await projectLabels()).find((label) => label.name === 'frontend');
  await expect.poll(() => new URL(page.url()).searchParams.get('label')).toBe(frontend?.id);
  const chips = page.getByRole('toolbar', { name: 'Filters' });
  await expect(chips.getByRole('button', { name: 'Labels is frontend. Change' })).toBeVisible();
  await expect(chips).toContainText('2 of 4 tasks');
  await expect(row('SHOP-1')).toBeVisible();
  await expect(row('SHOP-2')).toBeVisible();
  await expect(row('SHOP-3')).toHaveCount(0);
  await expect(row('SHOP-4')).toHaveCount(0);

  // The filter is a link: a reload keeps it.
  await page.reload();
  await settle(page);
  await expect(row('SHOP-3')).toHaveCount(0);
  await chips.getByRole('button', { name: 'Remove the labels filter' }).click();
  await expect.poll(() => new URL(page.url()).searchParams.get('label')).toBeNull();
  for (const key of ['SHOP-1', 'SHOP-2', 'SHOP-3', 'SHOP-4']) await expect(row(key)).toBeVisible();
});

test('Settings > Labels: rename in place, refuse a name the project has', async () => {
  await page.goto(w(`/p/${project.key}/settings/labels`));
  await settle(page);
  await expect(page.getByRole('heading', { name: 'Labels', level: 2 })).toBeVisible();
  await expect(labelRow('frontend')).toContainText('2 tasks');
  await expect(labelRow('backend')).toContainText('2 tasks');

  await labelRow('frontend').getByRole('button', { name: 'Rename “frontend”' }).click();
  const field = page.getByRole('textbox', { name: 'New name for “frontend”' });
  await expect(field).toBeFocused();
  await field.fill('Backend');
  await page.keyboard.press('Enter');
  await expect(page.getByText(`${project.name} has a label named “Backend” already.`)).toBeVisible();
  await field.fill('web');
  await page.keyboard.press('Enter');
  await expect(field).toBeHidden();
  await expect(labelRow('web')).toContainText('2 tasks');
  await expect(labelRow('frontend')).toHaveCount(0);

  // The tasks keep the label under its new name.
  expect(await labelsOf('SHOP-1')).toEqual(['web']);
  expect(await labelsOf('SHOP-2')).toEqual(['backend', 'web']);
});

test('Settings > Labels: delete says how many tasks lose the label', async () => {
  await labelRow('backend').getByRole('button', { name: 'More actions for “backend”' }).click();
  await page.getByRole('menuitem', { name: 'Delete…' }).click();
  const confirm = page.getByRole('alertdialog', { name: 'Delete the label “backend”?' });
  await expect(confirm).toContainText(`It’s used on 2 tasks in ${project.name}.`);
  await confirm.getByRole('button', { name: 'Delete label' }).click();
  await expect(confirm).toBeHidden();
  await expect(labelRow('backend')).toHaveCount(0);

  expect((await projectLabels()).map((label) => label.name)).toEqual(['web']);
  expect(await labelsOf('SHOP-2')).toEqual(['web']);
  expect(await labelsOf('SHOP-3')).toEqual([]);

  // The list shows the change.
  await page.goto(w(`/p/${project.key}`));
  await settle(page);
  await expect(row('SHOP-2')).toContainText('web');
  await expect(row('SHOP-3')).not.toContainText('backend');
});

test('no page errors during the flow', () => {
  expect(pageErrors).toEqual([]);
});
