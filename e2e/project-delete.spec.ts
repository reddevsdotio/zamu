// Deleting a project end to end: an admin deletes one from its General settings (type the key, toast on Home,
// its tasks gone), then another with `zamu projects delete`: no --confirm or the wrong key sends
// nothing, an agent's key is refused, a person's workspace key deletes it. The agent's key covered both
// projects; it stays, with no projects left. The tests build on each other, so they share one page and run
// in order. The spec signs in as the admin of the other specs, or sets the server up when it runs alone.
import { type BrowserContext, expect, type Page, test } from '@playwright/test';
import { createCli, parseJson } from './cli';
import { addAgent, api, collectPageErrors, homeURL, settle, signInAsAdmin, w } from './session';
import { baseURL } from './stack';

const inSettings = { name: 'Old website', key: 'OLD' };
const inCli = { name: 'Scratch', key: 'TMP' };
const agentName = 'cleanup-agent';
const keyName = 'e2e cleanup';
const deleteText =
  "Deletes its tasks, comments, history, milestones, cycles and Backlog.md mirror. This can't be undone.";

test.describe.configure({ mode: 'serial' });

let context: BrowserContext;
let page: Page;
const pageErrors: string[] = [];
/** zamu with the agent's key, scoped to both projects. */
const agentCli = createCli();
/** zamu with the admin's own key: whole workspace, read and write. */
const personCli = createCli();

async function projectKeys(): Promise<string[]> {
  const list = await api<{ items: { key: string }[] }>(page.request, 'GET', '/projects');
  return list.items.map((project) => project.key);
}

/** The agent's key in Settings > API keys. */
function agentKeyRow() {
  return page.getByRole('row').filter({ hasText: agentName });
}

test.beforeAll(async ({ browser }) => {
  context = await browser.newContext({ permissions: ['clipboard-read', 'clipboard-write'] });
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
  agentCli.dispose();
  personCli.dispose();
});

test('seed two projects with tasks, an agent key for both and a person key', async () => {
  await signInAsAdmin(page);
  for (const project of [inSettings, inCli]) {
    await api(page.request, 'POST', '/projects', project);
    await api(page.request, 'POST', '/tasks', { project: project.key, title: `Retire ${project.name}` });
  }
  await api(page.request, 'POST', `/tasks/${inSettings.key}-1/comments`, {
    body: 'Archive the DNS records.',
  });

  const agentKey = await addAgent(page, agentName, [inSettings.key, inCli.key]);
  const agentLogin = agentCli.run(['login', '--key', agentKey, '--url', baseURL, '--json']);
  expect(agentLogin.code, agentLogin.stdout + agentLogin.stderr).toBe(0);

  // Settings > My keys: the default scope is the whole workspace, read and write.
  await page.goto(w('/settings/my-keys'));
  await settle(page);
  await page.getByRole('button', { name: 'New key' }).first().click();
  const dialog = page.getByRole('dialog', { name: 'New key' });
  await dialog.getByLabel('Name').fill(keyName);
  await dialog.getByRole('button', { name: 'Create key' }).click();
  const reveal = page.getByRole('alertdialog');
  await expect(reveal).toContainText('Scope: whole workspace, read and write.');
  await reveal.getByRole('button', { name: 'Copy API key' }).click();
  const personKey = await page.evaluate(() => navigator.clipboard.readText());
  expect(personKey).toMatch(/^zamu_live_\S{20,}$/);
  await reveal.getByRole('button', { name: 'I copied the key' }).click();
  const personLogin = personCli.run(['login', '--key', personKey, '--url', baseURL, '--json']);
  expect(personLogin.code, personLogin.stdout + personLogin.stderr).toBe(0);
});

test('General settings: Delete this project, type the key, "Deleted OLD" on Home', async () => {
  await page.goto(w(`/p/${inSettings.key}/settings`));
  await settle(page);
  await expect(page.getByText('Delete this project', { exact: true })).toBeVisible();
  await expect(page.getByText(deleteText)).toBeVisible();
  await page.getByRole('button', { name: 'Delete project' }).click();

  const dialog = page.getByRole('alertdialog', { name: `Delete ${inSettings.key}?` });
  await expect(dialog).toContainText(deleteText);
  // Not mirrored: nothing to remove on a git host.
  await expect(dialog).not.toContainText('Remove the webhook');
  const confirm = dialog.getByRole('button', { name: 'Delete project' });
  const field = dialog.getByLabel(`Type ${inSettings.key} to confirm`);
  await expect(confirm).toBeDisabled();
  await field.fill('OL');
  await expect(confirm).toBeDisabled();
  // Any case matches.
  await field.fill(inSettings.key.toLowerCase());
  await expect(confirm).toBeEnabled();
  await confirm.click();

  // The project page is gone, so the delete lands on Home (0.6.0 went to the projects page).
  await expect(page).toHaveURL(homeURL, { timeout: 15_000 });
  await expect(page.getByRole('status').filter({ hasText: `Deleted ${inSettings.key}` })).toBeVisible();
  // The sidebar no longer lists it.
  await expect(
    page
      .getByRole('navigation', { name: 'Main' })
      .getByRole('link', { name: new RegExp(`^${inSettings.name},`) }),
  ).toHaveCount(0);

  expect(await projectKeys()).not.toContain(inSettings.key);
  const task = await page.request.get(`/api/v1/tasks/${inSettings.key}-1`);
  expect(task.status()).toBe(404);

  // The agent's key stays, for the project it still covers.
  await page.goto(w('/settings/api-keys'));
  await settle(page);
  await expect(agentKeyRow()).toContainText(inCli.key);
  await expect(agentKeyRow()).not.toContainText(inSettings.key);
  await expect(agentKeyRow().getByRole('button', { name: 'Revoke' })).toBeVisible();
});

test('zamu projects delete: --confirm required, agents refused, a person key deletes', async () => {
  const usage = `Pass --confirm ${inCli.key} to delete project ${inCli.key}.`;
  const missing = personCli.run(['projects', 'delete', inCli.key]);
  expect(missing.code, missing.stdout + missing.stderr).toBe(1);
  expect(missing.stderr).toContain(usage);
  const wrong = personCli.run(['projects', 'delete', inCli.key, '--confirm', inSettings.key]);
  expect(wrong.code, wrong.stdout + wrong.stderr).toBe(1);
  expect(wrong.stderr).toContain(usage);

  // Agents never delete projects, even with a write key that covers it.
  const refused = agentCli.run(['projects', 'delete', inCli.key, '--confirm', inCli.key]);
  expect(refused.code, refused.stdout + refused.stderr).toBe(4);
  expect(await projectKeys()).toContain(inCli.key);

  const deleted = personCli.run([
    'projects',
    'delete',
    inCli.key.toLowerCase(),
    '--confirm',
    inCli.key.toLowerCase(),
    '--json',
  ]);
  expect(deleted.code, deleted.stdout + deleted.stderr).toBe(0);
  expect(parseJson<{ deleted: string }>(deleted, 'zamu.v1.projects.delete')).toEqual({ deleted: inCli.key });
  expect(await projectKeys()).not.toContain(inCli.key);

  const again = personCli.run(['projects', 'delete', inCli.key, '--confirm', inCli.key]);
  expect(again.code, again.stdout + again.stderr).toBe(3);

  // The agent's key covered only the two deleted projects: it still works, for nothing.
  const list = agentCli.run(['projects', 'list', '--json']);
  expect(list.code, list.stdout + list.stderr).toBe(0);
  expect(parseJson<{ items: unknown[] }>(list, 'zamu.v1.projects.list').items).toEqual([]);
  await page.goto(w('/settings/api-keys'));
  await settle(page);
  await expect(agentKeyRow().getByRole('button', { name: 'Revoke' })).toBeVisible();
  await expect(agentKeyRow()).not.toContainText(inCli.key);
});

test('no page errors during the flow', () => {
  expect(pageErrors).toEqual([]);
});
