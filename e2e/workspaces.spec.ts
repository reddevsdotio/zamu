// Several workspaces on one server (0.10): the admin creates Globex next to Reddevs from the switcher, both
// with a project PAY, and switches between them with the switcher and the palette. Two tabs on the two
// workspaces keep their own data through a reload, and a link to PAY-1 in a comment opens the task of the
// comment's workspace. The only owner can't leave; an invited person lands in the workspace that invited
// them, and after leaving it sees the screen for people with no workspace. A member of Reddevs invited to
// Globex opens the link while someone else is signed in, signs out, signs in to join and joins; the used link
// then says so. Changing the address keeps old links working, and deleting asks for the address. The CLI holds a login per workspace: the clone's remote
// picks one, a remote both workspaces link stops with the choices, and --workspace decides. A second web
// container on the same database runs with WORKSPACE_CREATION=owners (see owners-web.ts), where a member
// gets no "New workspace" and a person with no workspace is told to ask for an invitation.
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { type Browser, type BrowserContext, expect, type Page, test } from '@playwright/test';
import { createCli, parseJson } from './cli';
import { createGitRepo, type GitRepo } from './git-repo';
import { ownersURL, removeOwnersWeb, startOwnersWeb } from './owners-web';
import {
  addAgent,
  admin,
  api,
  collectPageErrors,
  settle,
  signInAs,
  signInAsAdmin,
  w,
  workspaceHomeURL,
  workspaceName,
  workspaceSlug,
} from './session';
import { baseURL } from './stack';

const globex = { name: 'Globex', slug: 'globex', renamed: 'globex-corp' };
/** A person invited to Globex, who later leaves it. */
const gail = { name: 'Gail Gomez', email: 'gail@example.com', password: 'gail-password-1234' };
/** A member of Reddevs (not an owner), for the WORKSPACE_CREATION=owners server. */
const mo = { name: 'Mo Okafor', email: 'mo@example.com', password: 'mo-password-12345' };
/** A member of Reddevs who is then invited to Globex with the same account. */
const rae = { name: 'Rae Rossi', email: 'rae@example.com', password: 'rae-password-12345' };
/** What both PAY projects link, then only Globex's. */
const sharedRemote = 'https://github.com/acme-e2e/payments.git';
/** What Reddevs's PAY links after the ambiguous case. */
const reddevsRemote = 'https://github.com/acme-e2e/payments-reddevs.git';

interface TaskRef {
  key: string;
  title: string;
}
interface Project {
  key: string;
  repository: string | null;
}
interface Whoami {
  workspace: { id: string; slug: string; name: string };
  workspaceSource?: string;
  project?: { key: string } | null;
}

test.describe.configure({ mode: 'serial' });

let context: BrowserContext;
let page: Page;
const pageErrors: string[] = [];
const cli = createCli();
const repos: GitRepo[] = [];
const extraContexts: BrowserContext[] = [];
/** PAY-1 and PAY-2 of each workspace, by slug. */
const payTasks: Record<string, [TaskRef, TaskRef]> = {};

/** PAY-1 and PAY-2 of a seeded workspace. */
function tasksOf(slug: string): [TaskRef, TaskRef] {
  const tasks = payTasks[slug];
  if (!tasks) throw new Error(`PAY of ${slug} is not seeded`);
  return tasks;
}

/** Opens the sidebar's workspace switcher and returns its menu. */
async function openSwitcher(target: Page = page) {
  await target.getByRole('button', { name: /: workspace menu$/ }).click();
  const menu = target.getByRole('menu', { name: /: workspace menu$/ });
  await expect(menu).toBeVisible();
  return menu;
}

/** Opens the command palette and types `query`; returns the dialog. */
async function openPalette(query: string, target: Page = page) {
  await target.evaluate(() => (document.activeElement as HTMLElement | null)?.blur?.());
  await target.keyboard.press('Control+k');
  const palette = target.getByRole('dialog', { name: 'Command palette' });
  await expect(palette).toBeVisible();
  await palette.getByRole('combobox').fill(query);
  return palette;
}

/**
 * `listed` is a task list of PAY in `slug`: it has that workspace's PAY-1 and PAY-2 and none of the other's.
 * (Reddevs's PAY may hold more tasks, from the specs that ran before.)
 */
function expectTasksOf(slug: string, listed: TaskRef[]): void {
  const titles = listed.map((task) => task.title);
  for (const task of tasksOf(slug)) expect(titles).toContain(task.title);
  const other = slug === globex.slug ? workspaceSlug : globex.slug;
  for (const task of tasksOf(other)) expect(titles).not.toContain(task.title);
}

/** Makes sure `slug` has a project PAY with two tasks, and returns PAY-1 and PAY-2. */
async function seedPay(slug: string, titles: [string, string]): Promise<[TaskRef, TaskRef]> {
  const options = { workspace: slug };
  const projects = await api<{ items: Project[] }>(page.request, 'GET', '/projects', undefined, options);
  if (!projects.items.some((project) => project.key === 'PAY')) {
    await api(page.request, 'POST', '/projects', { name: 'Payments', key: 'PAY' }, options);
  }
  const list = await api<{ items: TaskRef[] }>(
    page.request,
    'GET',
    '/tasks?project=PAY&limit=100',
    undefined,
    options,
  );
  for (const title of titles.slice(list.items.length)) {
    await api(page.request, 'POST', '/tasks', { project: 'PAY', title }, options);
  }
  const get = (key: string) => api<TaskRef>(page.request, 'GET', `/tasks/${key}`, undefined, options);
  return [await get('PAY-1'), await get('PAY-2')];
}

/** Creates an invitation in Settings > Members of `slug` and returns its link. */
async function invite(slug: string, email: string): Promise<string> {
  await page.goto(w('/settings/members', slug));
  await settle(page);
  await page.getByRole('button', { name: 'Invite person' }).click();
  const dialog = page.getByRole('dialog', { name: 'Invite person' });
  await dialog.getByLabel('Email').fill(email);
  await dialog.getByRole('button', { name: 'Create invitation link' }).click();
  // The form gives way to the link.
  const shown = page.getByRole('dialog', { name: 'Invitation link' });
  const link = shown.locator('code, pre').filter({ hasText: '/invite/' }).first();
  await expect(link).toBeVisible();
  const href = (await link.textContent())?.trim() ?? '';
  expect(href).toMatch(/\/invite\/[0-9a-f-]+$/);
  await shown.getByRole('button', { name: 'Done' }).click();
  await expect(shown).toBeHidden();
  return href;
}

/** A new browser context (no cookies) on `url`, with its errors collected. */
async function freshPage(browser: Browser, url = baseURL): Promise<Page> {
  const fresh = await browser.newContext({ baseURL: url });
  extraContexts.push(fresh);
  const opened = await fresh.newPage();
  collectPageErrors(opened, pageErrors);
  return opened;
}

/** Accepts an invitation link as a new person; returns their page, signed in. */
async function acceptInvitation(
  browser: Browser,
  link: string,
  person: { name: string; password: string },
): Promise<Page> {
  const guest = await freshPage(browser);
  await guest.goto(link);
  await settle(guest);
  await guest.getByLabel('Your name').fill(person.name);
  await guest.getByLabel('Password').fill(person.password);
  await guest.getByRole('button', { name: 'Join workspace' }).click();
  return guest;
}

/** Sets the repository of a workspace's PAY project. */
async function linkPay(slug: string, repository: string): Promise<void> {
  await api(page.request, 'PATCH', '/projects/PAY', { repository }, { workspace: slug });
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
  removeOwnersWeb();
  for (const extra of extraContexts) await extra.close();
  // The admin ends in the first workspace, so "/" lands there for the specs that run after this one.
  if (page && !page.isClosed()) await page.goto(w()).catch(() => {});
  await context?.close();
  cli.dispose();
  for (const repo of repos) repo.remove();
});

test('seed PAY in the first workspace', async () => {
  await signInAsAdmin(page);
  payTasks[workspaceSlug] = await seedPay(workspaceSlug, [
    'Match Stripe payouts to invoices',
    'Flag payouts with no invoice',
  ]);
});

test('New workspace from the switcher: the address follows the name, then the empty Home opens', async () => {
  await page.goto(w());
  await settle(page);
  const menu = await openSwitcher();
  await expect(menu.getByRole('menuitem', { name: new RegExp(`^${workspaceName}`) })).toContainText(
    workspaceName,
  );
  await menu.getByRole('menuitem', { name: 'New workspace' }).click();

  const dialog = page.getByRole('dialog', { name: 'New workspace' });
  await expect(dialog).toBeVisible();
  await dialog.getByLabel('Name').fill(globex.name);
  const address = dialog.getByRole('textbox', { name: 'Address' });
  await expect(address).toHaveValue(globex.slug);
  // A reserved word is refused while typing; a taken address when creating.
  await address.fill('settings');
  await expect(dialog.getByText('This address is reserved. Pick another.')).toBeVisible();
  await address.fill(workspaceSlug);
  await dialog.getByRole('button', { name: /Create workspace/ }).click();
  await expect(dialog.getByText(`The address ${workspaceSlug} is taken. Pick another.`)).toBeVisible();
  await address.fill(globex.slug);
  await dialog.getByRole('button', { name: /Create workspace/ }).click();

  await expect(page).toHaveURL(workspaceHomeURL(globex.slug), { timeout: 15_000 });
  await expect(page.getByRole('heading', { name: 'Nothing to show yet' })).toBeVisible();
  await expect(page.getByRole('button', { name: `${globex.name}: workspace menu` })).toBeVisible();

  // Globex gets its own PAY, with the same keys as Reddevs's.
  payTasks[globex.slug] = await seedPay(globex.slug, [
    'Send the Globex quarterly invoice',
    'Chase the Globex late payers',
  ]);
  expect(tasksOf(globex.slug).map((task) => task.key)).toEqual(['PAY-1', 'PAY-2']);
});

test('the switcher and the palette move between the workspaces', async () => {
  await page.goto(w('/', globex.slug));
  await settle(page);
  const menu = await openSwitcher();
  const items = menu.getByRole('group', { name: 'Workspaces' }).getByRole('menuitem');
  await expect(items.filter({ hasText: globex.name })).toContainText('current');
  await expect(items.filter({ hasText: workspaceName })).not.toContainText('current');
  await items.filter({ hasText: workspaceName }).click();
  await expect(page).toHaveURL(workspaceHomeURL(workspaceSlug), { timeout: 15_000 });
  await settle(page);
  await expect(page.getByRole('button', { name: `${workspaceName}: workspace menu` })).toBeVisible();

  const palette = await openPalette(`switch to ${globex.name}`);
  await expect(palette.getByRole('option', { name: `Switch to ${globex.name}`, exact: true })).toBeVisible();
  // The current workspace has no Switch to command.
  await expect(palette.getByRole('option', { name: `Switch to ${workspaceName}`, exact: true })).toHaveCount(
    0,
  );
  await page.keyboard.press('Enter');
  await expect(page).toHaveURL(workspaceHomeURL(globex.slug), { timeout: 15_000 });
  await settle(page);
  await expect(page.getByRole('button', { name: `${globex.name}: workspace menu` })).toBeVisible();
});

test('two tabs on two workspaces keep their own PAY-1 through a reload; links open the right task', async () => {
  const [reddevs1, reddevs2] = tasksOf(workspaceSlug);
  const [globex1, globex2] = tasksOf(globex.slug);
  const other = await context.newPage();
  collectPageErrors(other, pageErrors);
  try {
    await page.goto(w('/p/PAY/PAY-1'));
    await other.goto(w('/p/PAY/PAY-1', globex.slug));
    for (const [tab, mine, theirs] of [
      [page, reddevs1, globex1],
      [other, globex1, reddevs1],
    ] as const) {
      await settle(tab);
      await expect(tab.getByText(mine.title).first()).toBeVisible();
      await expect(tab.getByText(theirs.title)).toHaveCount(0);
    }
    await page.reload();
    await other.reload();
    for (const [tab, mine, theirs] of [
      [page, reddevs1, globex1],
      [other, globex1, reddevs1],
    ] as const) {
      await settle(tab);
      await expect(tab.getByText(mine.title).first()).toBeVisible();
      await expect(tab.getByText(theirs.title)).toHaveCount(0);
    }
    // The list of each tab shows its own workspace's tasks.
    await page.goto(w('/p/PAY'));
    await settle(page);
    await expect(page.getByText(reddevs2.title).first()).toBeVisible();
    await expect(page.getByText(globex2.title)).toHaveCount(0);
  } finally {
    await other.close();
  }

  // A comment in each workspace links to PAY-1 with a pre-0.10 URL: it opens the comment's workspace.
  for (const [slug, onTask, target] of [
    [workspaceSlug, reddevs2, reddevs1],
    [globex.slug, globex2, globex1],
  ] as const) {
    await api(
      page.request,
      'POST',
      `/tasks/${onTask.key}/comments`,
      { body: `Same customer as [the first payment](${baseURL}/p/PAY/PAY-1).` },
      { workspace: slug },
    );
    await page.goto(w(`/p/PAY/${onTask.key}`, slug));
    await settle(page);
    const link = page
      .getByRole('region', { name: 'Activity' })
      .getByRole('link', { name: 'the first payment' });
    await expect(link).toHaveAttribute('href', `${baseURL}${w('/p/PAY/PAY-1', slug)}`);
    const [opened] = await Promise.all([context.waitForEvent('page'), link.click()]);
    collectPageErrors(opened, pageErrors);
    await expect(opened).toHaveURL(`${baseURL}${w('/p/PAY/PAY-1', slug)}`);
    await settle(opened);
    await expect(opened.getByText(target.title).first()).toBeVisible();
    await opened.close();
  }
});

test('the only owner cannot leave the workspace', async () => {
  await page.goto(w('/settings', globex.slug));
  await expect(page).toHaveURL(`${baseURL}${w('/settings/general', globex.slug)}`, { timeout: 15_000 });
  await settle(page);
  await page.getByRole('button', { name: 'Leave workspace' }).click();
  const leave = page.getByRole('alertdialog', { name: `Leave ${globex.name}?` });
  await expect(leave).toBeVisible();
  await leave.getByRole('button', { name: 'Leave workspace' }).click();
  await expect(
    leave.getByText(`You are the only owner of ${globex.name}, so you can't leave it.`, { exact: false }),
  ).toBeVisible();
  await page.keyboard.press('Escape');
  await expect(leave).toBeHidden();
  await expect(page).toHaveURL(`${baseURL}${w('/settings/general', globex.slug)}`);
});

test('CLI: a login per workspace; the remote picks one, a shared remote asks for --workspace', async () => {
  const reddevsKey = await addAgent(page, 'reddevs-cli-agent', ['PAY']);
  const globexKey = await addAgent(page, 'globex-cli-agent', ['PAY'], {
    membersPath: w('/settings/members', globex.slug),
  });
  for (const key of [reddevsKey, globexKey]) {
    const login = cli.run(['login', '--key', key, '--url', baseURL, '--json']);
    expect(login.code, login.stdout + login.stderr).toBe(0);
  }
  const listed = cli.run(['workspaces', '--json']);
  expect(listed.code, listed.stdout + listed.stderr).toBe(0);
  const logins = parseJson<{ items: { workspace: { slug: string }; default: boolean }[] }>(
    listed,
    'zamu.v1.workspaces',
  ).items;
  expect(logins.map((login) => [login.workspace.slug, login.default])).toEqual([
    [workspaceSlug, true],
    [globex.slug, false],
  ]);

  // Both PAY projects link the same repository: a clone of it matches both logins.
  await linkPay(workspaceSlug, sharedRemote);
  await linkPay(globex.slug, sharedRemote);
  const shared = createGitRepo('main');
  repos.push(shared);
  shared.git(['remote', 'add', 'origin', sharedRemote]);
  const ambiguous = cli.run(['tasks', 'list'], {}, { cwd: shared.dir });
  expect(ambiguous.code, ambiguous.stdout + ambiguous.stderr).toBe(1);
  expect(ambiguous.stderr).toContain('This clone matches 2 logins. Pass --workspace to pick one:');
  for (const [slug, name] of [
    [workspaceSlug, workspaceName],
    [globex.slug, globex.name],
  ]) {
    expect(ambiguous.stderr).toMatch(
      new RegExp(`--workspace ${slug}\\s+${name} \\(${slug}\\) on ${baseURL}`),
    );
  }

  // --workspace decides.
  const picked = cli.run(['--workspace', globex.slug, 'tasks', 'list', '--json'], {}, { cwd: shared.dir });
  expect(picked.code, picked.stdout + picked.stderr).toBe(0);
  expectTasksOf(globex.slug, parseJson<{ items: TaskRef[] }>(picked, 'zamu.v1.tasks.list').items);

  // Once Reddevs's PAY links its own repository, each clone picks its workspace by the remote.
  await linkPay(workspaceSlug, reddevsRemote);
  const reddevsClone = createGitRepo('main');
  repos.push(reddevsClone);
  reddevsClone.git(['remote', 'add', 'origin', reddevsRemote]);
  for (const [dir, slug] of [
    [reddevsClone.dir, workspaceSlug],
    [shared.dir, globex.slug],
  ] as const) {
    const who = cli.run(['whoami', '--json'], {}, { cwd: dir });
    expect(who.code, who.stdout + who.stderr).toBe(0);
    const me = parseJson<Whoami>(who, 'zamu.v1.whoami');
    expect(me.workspace.slug).toBe(slug);
    expect(me.workspaceSource).toBe('clone');
    expect(me.project?.key).toBe('PAY');
    const tasks = cli.run(['tasks', 'list', '--json'], {}, { cwd: dir });
    expect(tasks.code, tasks.stdout + tasks.stderr).toBe(0);
    expectTasksOf(slug, parseJson<{ items: TaskRef[] }>(tasks, 'zamu.v1.tasks.list').items);
  }

  // Outside a clone, the default login (the first) applies.
  const outside = mkdtempSync(join(tmpdir(), 'zamu-e2e-outside-'));
  try {
    const who = cli.run(['whoami', '--json'], {}, { cwd: outside });
    expect(who.code, who.stdout + who.stderr).toBe(0);
    const me = parseJson<Whoami>(who, 'zamu.v1.whoami');
    expect(me.workspace.slug).toBe(workspaceSlug);
    expect(me.workspaceSource).toBe('default');
  } finally {
    rmSync(outside, { recursive: true, force: true });
  }
});

test('an invitation opens its workspace; leaving the last one shows the no-workspace screen', async ({
  browser,
}) => {
  const link = await invite(globex.slug, gail.email);
  const guest = await acceptInvitation(browser, link, gail);
  await expect(guest).toHaveURL(workspaceHomeURL(globex.slug), { timeout: 15_000 });
  await settle(guest);
  // Gail is only in Globex.
  const menu = await openSwitcher(guest);
  const items = menu.getByRole('group', { name: 'Workspaces' }).getByRole('menuitem');
  await expect(items.filter({ hasText: globex.name })).toHaveCount(1);
  await expect(items.filter({ hasText: workspaceName })).toHaveCount(0);
  await guest.keyboard.press('Escape');

  // A member sees General read-only, and leaves.
  await guest.goto(w('/settings/general', globex.slug));
  await settle(guest);
  await expect(
    guest.getByText('Only owners and admins can rename the workspace or change its address.'),
  ).toBeVisible();
  await expect(guest.getByRole('button', { name: 'Delete workspace' })).toHaveCount(0);
  await guest.getByRole('button', { name: 'Leave workspace' }).click();
  const leave = guest.getByRole('alertdialog', { name: `Leave ${globex.name}?` });
  await leave.getByRole('button', { name: 'Leave workspace' }).click();
  await expect(guest).toHaveURL(`${baseURL}/welcome`, { timeout: 15_000 });
  await expect(guest.getByText(`You left ${globex.name}.`)).toBeVisible();
  await expect(guest.getByRole('heading', { name: 'Create a workspace' })).toBeVisible();
  await expect(guest.getByText(`Signed in as ${gail.email}`)).toBeVisible();
  // Globex's pages are closed to her now: "/" comes back here.
  await guest.goto(w('/', globex.slug));
  await expect(guest).toHaveURL(`${baseURL}/welcome`, { timeout: 15_000 });

  // She creates one from here, deletes it, and is back on the same screen.
  await settle(guest);
  await guest.getByLabel('Name').fill('Gail Labs');
  await expect(guest.getByRole('textbox', { name: 'Address' })).toHaveValue('gail-labs');
  await guest.getByRole('button', { name: 'Create workspace' }).click();
  await expect(guest).toHaveURL(workspaceHomeURL('gail-labs'), { timeout: 15_000 });
  await guest.goto(w('/settings/general', 'gail-labs'));
  await settle(guest);
  await guest.getByRole('button', { name: 'Delete workspace' }).click();
  const remove = guest.getByRole('alertdialog', { name: 'Delete Gail Labs?' });
  await remove.getByRole('textbox', { name: 'Type gail-labs to confirm' }).fill('gail-labs');
  await remove.getByRole('button', { name: 'Delete workspace' }).click();
  await expect(guest).toHaveURL(`${baseURL}/welcome`, { timeout: 15_000 });
  await expect(guest.getByText('Deleted Gail Labs.')).toBeVisible();
});

test('an existing member joins a second workspace: wrong account, sign in to join, Join', async ({
  browser,
}) => {
  // Rae joins Reddevs with a new account.
  const first = await acceptInvitation(browser, await invite(workspaceSlug, rae.email), rae);
  await expect(first).toHaveURL(workspaceHomeURL(workspaceSlug), { timeout: 15_000 });

  const link = await invite(globex.slug, rae.email);
  const heading = (target: Page) => target.getByRole('heading', { name: `Join ${globex.name}` });

  // Opened while Gail is signed in: the invitation is for someone else, and Sign out is the only way on.
  const tab = await freshPage(browser);
  await tab.goto('/signin');
  await signInAs(tab, gail);
  await tab.goto(link);
  await settle(tab);
  await expect(heading(tab)).toBeVisible();
  await expect(
    tab.getByText(
      `This invitation is for ${rae.email}. You're signed in as ${gail.email}. Sign out, then sign in or join with ${rae.email}.`,
    ),
  ).toBeVisible();
  await expect(tab.getByRole('button', { name: `Join ${globex.name}` })).toHaveCount(0);
  await tab.getByRole('button', { name: 'Sign out' }).click();

  // Signed out, and the email has an account: sign in to join, which comes back here.
  await expect(
    tab.getByText(
      `${admin.name} invited you. There's already an account for ${rae.email}, so sign in to join.`,
    ),
  ).toBeVisible({ timeout: 15_000 });
  await expect(tab).toHaveURL(link);
  await expect(tab.getByLabel('Your name')).toHaveCount(0);
  await tab.getByRole('link', { name: 'Sign in to join' }).click();
  await expect(tab).toHaveURL(`${baseURL}/signin?redirect=${encodeURIComponent(new URL(link).pathname)}`);
  await settle(tab);
  await tab.getByLabel('Email').fill(rae.email);
  await tab.getByLabel('Password').fill(rae.password);
  await tab.getByRole('button', { name: 'Sign in' }).click();
  await expect(tab).toHaveURL(link, { timeout: 15_000 });

  // Signed in with the invited email: one button joins and opens the workspace.
  await settle(tab);
  await expect(heading(tab)).toBeVisible();
  await expect(
    tab.getByText(`${admin.name} invited you to ${globex.name}. You're signed in as ${rae.email}.`),
  ).toBeVisible();
  await tab.getByRole('button', { name: `Join ${globex.name}` }).click();
  await expect(tab).toHaveURL(workspaceHomeURL(globex.slug), { timeout: 15_000 });
  await settle(tab);
  const menu = await openSwitcher(tab);
  const items = menu.getByRole('group', { name: 'Workspaces' }).getByRole('menuitem');
  // Both workspaces (each after its initial tile), then New workspace (everyone may create one here).
  await expect(items).toHaveText(
    [`${globex.name}, current`, workspaceName, 'New workspace'].map((text) => new RegExp(`${text}$`)),
  );
  await expect(items.filter({ hasText: globex.name })).toContainText('current');
  await tab.keyboard.press('Escape');

  // The link works once.
  await tab.goto(link);
  await settle(tab);
  await expect(tab.getByText('This invitation has already been used.')).toBeVisible();
  await expect(tab.getByRole('button', { name: `Join ${globex.name}` })).toHaveCount(0);
});

test('a new address: the page moves, old links open the new address, the CLI follows', async () => {
  await page.goto(w('/settings/general', globex.slug));
  await settle(page);
  await page.getByRole('textbox', { name: 'Address' }).fill(globex.renamed);
  await page.getByRole('button', { name: 'Save changes' }).click();
  await expect(page).toHaveURL(`${baseURL}${w('/settings/general', globex.renamed)}`, { timeout: 15_000 });
  await expect(
    page.getByText(`${globex.name} now lives at /w/${globex.renamed}. Old links keep working.`),
  ).toBeVisible();

  const [globex1] = tasksOf(globex.slug);
  await page.goto(`${w('/p/PAY/PAY-1', globex.slug)}?from=old-link`);
  await expect(page).toHaveURL(`${baseURL}${w('/p/PAY/PAY-1', globex.renamed)}?from=old-link`, {
    timeout: 15_000,
  });
  await settle(page);
  await expect(page.getByText(globex1.title).first()).toBeVisible();

  // The stored login still names the old address, which the server still takes; whoami stores the new one.
  const who = cli.run(['--workspace', globex.slug, 'whoami', '--json']);
  expect(who.code, who.stdout + who.stderr).toBe(0);
  expect(parseJson<Whoami>(who, 'zamu.v1.whoami').workspace.slug).toBe(globex.renamed);
  const listed = cli.run(['workspaces', '--json']);
  expect(
    parseJson<{ items: { workspace: { slug: string } }[] }>(listed, 'zamu.v1.workspaces').items.map(
      (login) => login.workspace.slug,
    ),
  ).toEqual([workspaceSlug, globex.renamed]);
});

test('WORKSPACE_CREATION=owners: a member gets no New workspace, an owner does', async ({ browser }) => {
  test.setTimeout(3 * 60_000);
  // Mo joins Reddevs as a member through an invitation on the main server.
  const link = await invite(workspaceSlug, mo.email);
  const joined = await acceptInvitation(browser, link, mo);
  await expect(joined).toHaveURL(workspaceHomeURL(workspaceSlug), { timeout: 15_000 });

  await startOwnersWeb();
  const moPage = await freshPage(browser, ownersURL);
  await moPage.goto('/signin');
  await signInAs(moPage, mo);
  await moPage.goto(w());
  await settle(moPage);
  const menu = await openSwitcher(moPage);
  await expect(menu.getByRole('menuitem', { name: 'Workspace settings' })).toBeVisible();
  await expect(menu.getByRole('menuitem', { name: 'New workspace' })).toHaveCount(0);
  await moPage.keyboard.press('Escape');
  const palette = await openPalette('new workspace', moPage);
  await expect(palette.getByRole('option', { name: 'New workspace', exact: true })).toHaveCount(0);
  await moPage.keyboard.press('Escape');

  // Gail, in no workspace, is told to ask for an invitation.
  const gailPage = await freshPage(browser, ownersURL);
  await gailPage.goto('/signin');
  await signInAs(gailPage, gail);
  await gailPage.goto('/');
  await expect(gailPage).toHaveURL(`${ownersURL}/welcome`, { timeout: 15_000 });
  await expect(gailPage.getByRole('heading', { name: 'Ask an owner for an invitation' })).toBeVisible();
  await expect(gailPage.getByRole('button', { name: 'Create workspace' })).toHaveCount(0);

  // The admin owns workspaces, so the switcher still offers New workspace.
  const adminPage = await freshPage(browser, ownersURL);
  await adminPage.goto('/signin');
  await signInAs(adminPage, admin);
  await adminPage.goto(w());
  await settle(adminPage);
  const adminMenu = await openSwitcher(adminPage);
  await expect(adminMenu.getByRole('menuitem', { name: 'New workspace' })).toBeVisible();
  await adminPage.keyboard.press('Escape');

  removeOwnersWeb();
});

test('delete with the typed address: the app lands in the other workspace', async () => {
  await page.goto(w('/settings/general', globex.renamed));
  await settle(page);
  await page.getByRole('button', { name: 'Delete workspace' }).click();
  const remove = page.getByRole('alertdialog', { name: `Delete ${globex.name}?` });
  await expect(remove).toBeVisible();
  // The counts: PAY, its two tasks and the CLI agent.
  await expect(
    remove.getByText(new RegExp(`^Deletes ${globex.name} with 1 project, 2 tasks, 1 agent`)),
  ).toBeVisible();
  const confirm = remove.getByRole('button', { name: 'Delete workspace' });
  await expect(confirm).toBeDisabled();
  const typed = remove.getByRole('textbox', { name: `Type ${globex.renamed} to confirm` });
  await typed.fill(globex.slug);
  await expect(confirm).toBeDisabled();
  await typed.fill(globex.renamed);
  await confirm.click();

  await expect(page).toHaveURL(workspaceHomeURL(workspaceSlug), { timeout: 15_000 });
  await expect(page.getByText(`Deleted ${globex.name}.`)).toBeVisible();
  const menu = await openSwitcher();
  await expect(
    menu.getByRole('group', { name: 'Workspaces' }).getByRole('menuitem').filter({ hasText: globex.name }),
  ).toHaveCount(0);
  await page.keyboard.press('Escape');

  // Its address is gone, and so is the agent's key.
  await page.goto(w('/', globex.renamed));
  await expect(page).toHaveURL(workspaceHomeURL(workspaceSlug), { timeout: 15_000 });
  // (whoami after the address change stored the new one in the login).
  const gone = cli.run(['--workspace', globex.renamed, 'whoami']);
  expect(gone.code, gone.stdout + gone.stderr).toBe(2);
});

test('no page errors during the flow', () => {
  expect(pageErrors).toEqual([]);
});
