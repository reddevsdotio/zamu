// Shared people, sign-in and API helpers for the specs. Every spec runs on the same server, so they share the
// admin account: the first spec to run creates it through the setup page, the others sign in. Since 0.10 every
// page lives under /w/<workspace slug>/; `w()` builds those paths for the workspace setup creates.
import { type APIRequestContext, expect, type Page } from '@playwright/test';

export const admin = { name: 'Ana Ruiz', email: 'ana@example.com', password: 'e2e-password-1234' };
export const workspaceName = 'Reddevs';
/** Slug of the workspace setup creates from `workspaceName`. */
export const workspaceSlug = 'reddevs';

/** `path` inside a workspace: w('/p/PAY') is /w/reddevs/p/PAY, w('/') is the workspace's Home. */
export function w(path = '/', slug: string = workspaceSlug): string {
  const base = `/w/${slug}`;
  return path === '/' || path === '' ? base : `${base}${path.startsWith('/') ? path : `/${path}`}`;
}

/** Home of a workspace: /w/<slug> with nothing after it but an optional query (such as ?tab=everyone). */
export function workspaceHomeURL(slug: string = workspaceSlug): RegExp {
  return new RegExp(`^https?://[^/]+/w/${slug}/?(?:\\?.*)?$`);
}

/** Waits until the page has loaded and hydrated, so keyboard shortcuts and inputs are live. */
export async function settle(page: Page): Promise<void> {
  await page.waitForLoadState('networkidle');
  await page.waitForTimeout(500);
}

/** Home of the first workspace, where "/" lands. */
export const homeURL = workspaceHomeURL();

/**
 * First run through the setup page: the admin account, then the workspace. Leaves the page signed in on
 * `landing`: setup sends the new admin to "/", which is the workspace's Home since 0.10 (Home at "/" in 0.7.0
 * to 0.9.0, the dashboard in 0.5.0 and 0.6.0, the projects page before 0.5.0).
 */
export async function setUpServer(page: Page, landing: RegExp = homeURL): Promise<void> {
  await expect(page).toHaveURL(/\/setup$/);
  await settle(page);
  await expect(page.getByRole('heading', { name: 'Set up this server' })).toBeVisible();
  await page.getByLabel('Your name').fill(admin.name);
  await page.getByLabel('Email').fill(admin.email);
  await page.getByLabel('Password').fill(admin.password);
  await page.getByRole('button', { name: 'Continue' }).click();

  await expect(page.getByRole('heading', { name: 'Name your workspace' })).toBeVisible();
  await page.getByLabel('Workspace name').fill(workspaceName);
  await page.getByRole('button', { name: 'Create workspace' }).click();
  await expect(page).toHaveURL(landing, { timeout: 15_000 });
}

/**
 * Signs the page's context in as the admin, running the first-run setup when the server is new. Signs in
 * through the auth endpoint rather than the form: on a cold server, hydration can reset a half-filled form.
 */
export async function signInAsAdmin(page: Page): Promise<void> {
  await page.goto('/');
  if (new URL(page.url()).pathname === '/setup') {
    await setUpServer(page);
    return;
  }
  await signInAs(page, admin);
}

/**
 * Signs the page's context in through the auth endpoint. The page must be on the server already (its URL
 * gives the Origin header).
 */
export async function signInAs(page: Page, person: { email: string; password: string }): Promise<void> {
  // Better Auth checks the Origin header once the request carries a cookie. It also allows only 3 sign-ins
  // per address in a rolling 10-second window, and short specs can run back to back inside one: on 429, wait
  // for the window (Retry-After when sent) and try again.
  const { origin } = new URL(page.url());
  for (let attempt = 1; ; attempt += 1) {
    const response = await page.context().request.post(`${origin}/api/auth/sign-in/email`, {
      data: { email: person.email, password: person.password },
      headers: { origin },
    });
    if (response.status() === 429 && attempt < 4) {
      const retryAfter = Number(response.headers()['retry-after']);
      await page.waitForTimeout(
        (Number.isFinite(retryAfter) && retryAfter > 0 ? retryAfter : 10) * 1_000 + 500,
      );
      continue;
    }
    expect(response.ok(), await response.text()).toBe(true);
    return;
  }
}

/**
 * JSON call to /api/v1 with the context's session cookie. Fails the test on a non-2xx answer. A session acts
 * in the workspace used last unless `workspace` names one (sent as x-zamu-workspace).
 */
export async function api<T>(
  request: APIRequestContext,
  method: 'GET' | 'POST' | 'PATCH' | 'DELETE',
  path: string,
  data?: unknown,
  { workspace }: { workspace?: string } = {},
): Promise<T> {
  const response = await request.fetch(`/api/v1${path}`, {
    method,
    data,
    ...(workspace ? { headers: { 'x-zamu-workspace': workspace } } : {}),
  });
  const text = await response.text();
  expect(response.ok(), `${method} ${path}: ${response.status()} ${text}`).toBe(true);
  return (text ? JSON.parse(text) : null) as T;
}

/** Opens New project from the "+" next to the sidebar's Projects heading (P is Priority since 0.7.0). */
export async function openNewProject(page: Page, item: 'New project' | 'New from Backlog.md'): Promise<void> {
  await page.getByRole('navigation', { name: 'Main' }).getByRole('button', { name: 'New project' }).click();
  await page.getByRole('menu', { name: 'New project' }).getByRole('menuitem', { name: item }).click();
}

/** Collects page errors and console errors, so a spec can assert there were none. */
export function collectPageErrors(page: Page, errors: string[], ignore: RegExp[] = []): void {
  page.on('pageerror', (error) => errors.push(`pageerror: ${error.message}`));
  page.on('console', (message) => {
    if (message.type() !== 'error') return;
    const text = message.text();
    if (!ignore.some((pattern) => pattern.test(text))) errors.push(`console: ${text}`);
  });
}

/**
 * Adds an agent in Settings > Members with a read-write key for the given projects and returns the key, read
 * from the clipboard after "Copy API key". The context needs clipboard permissions. `prefix` is the key prefix
 * the server hands out and `membersPath` the Members page: the upgrade spec passes what an older release used.
 */
export async function addAgent(
  page: Page,
  name: string,
  projectKeys: string[],
  {
    prefix = 'zamu_live_',
    membersPath = w('/settings/members'),
  }: { prefix?: string; membersPath?: string } = {},
): Promise<string> {
  await page.goto(membersPath);
  await settle(page);
  await page.getByRole('button', { name: 'Add agent' }).click();
  const dialog = page.getByRole('dialog', { name: 'Add agent' });
  await expect(dialog).toBeVisible();
  await dialog.getByLabel('Name', { exact: true }).fill(name);
  await dialog.getByRole('radio', { name: /Selected projects/ }).check({ force: true });
  for (const key of projectKeys) {
    await dialog.getByRole('checkbox', { name: new RegExp(`\\b${key}\\b`) }).check({ force: true });
  }
  await dialog.getByRole('radio', { name: /Read and write/ }).check({ force: true });
  await dialog.getByRole('button', { name: /Create agent/ }).click();

  const reveal = page.getByRole('alertdialog');
  await expect(reveal).toContainText(`Key created for ${name}`);
  await reveal.getByRole('button', { name: 'Copy API key' }).click();
  const key = await page.evaluate(() => navigator.clipboard.readText());
  expect(key.startsWith(prefix), key).toBe(true);
  expect(key.slice(prefix.length)).toMatch(/^\S{20,}$/);
  await reveal.getByRole('button', { name: 'I copied the key' }).click();
  await expect(reveal).toBeHidden();
  return key;
}
