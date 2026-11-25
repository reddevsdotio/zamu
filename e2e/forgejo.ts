// A throwaway Forgejo for the Backlog.md specs, started with docker/forgejo/setup.sh under its own compose
// project and attached to the end-to-end stack's network under an alias (stack.forgejoAliases). The app reaches
// it as http://<alias>:3000 and Forgejo delivers webhooks to http://web:3000.
//
// The spec process talks to Forgejo through `docker exec … curl` instead of the published port: Forgejo binds it
// to 127.0.0.1 of the Docker host, which is out of reach when the daemon runs on another host (E2E_BASE_URL).
import { execFileSync, spawnSync } from 'node:child_process';
import { once } from 'node:events';
import { readdirSync, readFileSync, statSync } from 'node:fs';
import { createServer } from 'node:net';
import { join, relative } from 'node:path';
import { expect, type Page } from '@playwright/test';
import { settle } from './session';
import { composeProject, repoRoot } from './stack';

const scripts = join(repoRoot, 'docker/forgejo');

/** The fixture the specs push: Backlog.md files from the September 2025 format (markers, subtasks, drafts). */
export const fixtureFolder = join(repoRoot, 'packages/backlog-md/test/fixtures/eras/2025-09-markers');

/** True when the Docker CLI reaches a daemon and has compose. */
export function dockerAvailable(): boolean {
  const info = spawnSync('docker', ['info'], { stdio: 'ignore', timeout: 20_000 });
  const compose = spawnSync('docker', ['compose', 'version'], { stdio: 'ignore', timeout: 20_000 });
  return info.status === 0 && compose.status === 0;
}

/** Every file under `dir`, keyed by its path relative to `dir` (forward slashes). */
export function readTree(dir: string): Record<string, string> {
  const files: Record<string, string> = {};
  const walk = (current: string) => {
    for (const name of readdirSync(current)) {
      const path = join(current, name);
      if (statSync(path).isDirectory()) walk(path);
      else files[relative(dir, path).split('\\').join('/')] = readFileSync(path, 'utf8');
    }
  };
  walk(dir);
  return files;
}

async function freePort(): Promise<number> {
  const server = createServer();
  server.listen(0, '127.0.0.1');
  await once(server, 'listening');
  const address = server.address();
  server.close();
  await once(server, 'close');
  if (!address || typeof address === 'string') throw new Error('no free port');
  return address.port;
}

export interface Forgejo {
  /** Admin user that owns the repositories. */
  user: string;
  /** Access token with every scope. */
  token: string;
  /** Host the app uses for the connection, e.g. forgejo-mirror:3000. */
  host: string;
  /** Clone URL of a repository as the app sees it. */
  repositoryUrl(repo: string): string;
  /** JSON call to the Forgejo API (/api/v1<path>). Throws on a non-2xx answer. */
  api<T = unknown>(method: string, path: string, body?: unknown): Promise<T>;
  /** Creates a public repository on main with the given files in one commit. */
  createRepository(repo: string, files: Record<string, string>): Promise<void>;
  /**
   * Writes, replaces or deletes files in one commit on `branch` (main by default; null deletes). Returns the
   * commit hash.
   */
  commit(
    repo: string,
    message: string,
    changes: Record<string, string | null>,
    branch?: string,
  ): Promise<string>;
  /** Head commit of a branch, main by default. */
  head(repo: string, branch?: string): Promise<string>;
  /**
   * Opens a pull request into main from a new branch that holds `changes` in one commit. Returns its number.
   */
  openPullRequest(
    repo: string,
    request: { branch: string; title: string; changes: Record<string, string | null> },
  ): Promise<number>;
  /** Detaches Forgejo from the stack network, then removes the container and its data. */
  stop(): void;
}

/** Names of the Forgejo containers the Backlog.md specs and the upgrade test start (see stack.forgejoAliases). */
export const forgejoNames = ['mirror', 'import', 'upgrade'] as const;

function forgejoProject(name: string): string {
  return `${composeProject}-forgejo-${name}`;
}

function forgejoContainer(name: string): string {
  const result = spawnSync(
    'docker',
    ['compose', '-p', forgejoProject(name), '-f', join(scripts, 'compose.yml'), 'ps', '-q', '-a', 'forgejo'],
    { encoding: 'utf8' },
  );
  return result.status === 0 ? result.stdout.trim() : '';
}

/**
 * Detaches a spec's Forgejo from `network` and removes it with its data. Does nothing when it is not running,
 * so globalSetup and globalTeardown call it to clean up after a crashed or kept run.
 */
export function removeForgejo(name: string, network: string): void {
  const container = forgejoContainer(name);
  if (!container) return;
  spawnSync('docker', ['network', 'disconnect', '--force', network, container], { stdio: 'ignore' });
  execFileSync(join(scripts, 'teardown.sh'), {
    env: { ...process.env, FORGEJO_PROJECT: forgejoProject(name) },
    stdio: ['ignore', 'ignore', 'inherit'],
    timeout: 120_000,
  });
}

/**
 * Starts a Forgejo container named after the spec (compose project <stack project>-forgejo-<name>) and attaches
 * it to `network` as `alias`.
 */
export async function startForgejo(name: string, network: string, alias: string): Promise<Forgejo> {
  const project = forgejoProject(name);
  const env = { ...process.env, FORGEJO_PROJECT: project, FORGEJO_PORT: String(await freePort()) };
  removeForgejo(name, network);
  const stop = () => removeForgejo(name, network);

  let output: string;
  let container: string;
  try {
    output = execFileSync(join(scripts, 'setup.sh'), {
      env,
      encoding: 'utf8',
      stdio: ['ignore', 'pipe', 'pipe'],
      timeout: 280_000,
    });
    container = forgejoContainer(name);
    execFileSync('docker', ['network', 'connect', '--alias', alias, network, container], { stdio: 'ignore' });
  } catch (error) {
    // setup.sh may have created the container even when it failed.
    spawnSync(join(scripts, 'teardown.sh'), { env, stdio: 'ignore', timeout: 120_000 });
    throw error;
  }
  const values = Object.fromEntries(
    output
      .split('\n')
      .filter((line) => line.includes('='))
      .map((line) => [line.slice(0, line.indexOf('=')), line.slice(line.indexOf('=') + 1)]),
  );
  const user = values.FORGEJO_USER as string;
  const token = values.FORGEJO_TOKEN as string;
  const host = `${alias}:3000`;

  const api = async <T>(method: string, path: string, body?: unknown): Promise<T> => {
    const args = [
      'exec',
      '-i',
      container,
      'curl',
      '-sS',
      '-X',
      method,
      '-H',
      `Authorization: token ${token}`,
      '-H',
      'Content-Type: application/json',
      '-w',
      '\n%{http_code}',
    ];
    if (body !== undefined) args.push('--data-binary', '@-');
    args.push(`http://localhost:3000/api/v1${path}`);
    const result = spawnSync('docker', args, {
      input: body === undefined ? undefined : JSON.stringify(body),
      encoding: 'utf8',
      timeout: 60_000,
    });
    if (result.status !== 0) throw new Error(`${method} ${path}: curl failed: ${result.stderr}`);
    const text = result.stdout;
    const split = text.lastIndexOf('\n');
    const status = Number(text.slice(split + 1));
    const responseBody = text.slice(0, split);
    if (status < 200 || status > 299)
      throw new Error(`${method} ${path} answered ${status}: ${responseBody}`);
    return (responseBody ? JSON.parse(responseBody) : null) as T;
  };

  const encodePath = (path: string) => path.split('/').map(encodeURIComponent).join('/');
  const head = async (repo: string, branch = 'main') =>
    (await api<{ commit: { id: string } }>('GET', `/repos/${user}/${repo}/branches/${encodePath(branch)}`))
      .commit.id;

  const commit = async (
    repo: string,
    message: string,
    changes: Record<string, string | null>,
    branch = 'main',
  ): Promise<string> => {
    const files = [];
    for (const [path, content] of Object.entries(changes)) {
      let sha: string | null = null;
      try {
        sha = (
          await api<{ sha: string }>(
            'GET',
            `/repos/${user}/${repo}/contents/${encodePath(path)}?ref=${encodeURIComponent(branch)}`,
          )
        ).sha;
      } catch {
        sha = null;
      }
      if (content === null) {
        if (!sha) throw new Error(`${path} does not exist in ${repo}`);
        files.push({ operation: 'delete', path, sha });
      } else {
        files.push({
          operation: sha ? 'update' : 'create',
          path,
          content: Buffer.from(content).toString('base64'),
          ...(sha ? { sha } : {}),
        });
      }
    }
    await api('POST', `/repos/${user}/${repo}/contents`, { branch, message, files });
    return head(repo, branch);
  };

  return {
    user,
    token,
    host,
    repositoryUrl: (repo) => `http://${host}/${user}/${repo}.git`,
    api,
    head,
    async createRepository(repo, files) {
      await api('POST', '/user/repos', {
        name: repo,
        auto_init: false,
        default_branch: 'main',
        private: false,
      });
      await api('POST', `/repos/${user}/${repo}/contents`, {
        branch: 'main',
        message: 'Add the Backlog.md fixture',
        files: Object.entries(files).map(([path, content]) => ({
          operation: 'create',
          path,
          content: Buffer.from(content).toString('base64'),
        })),
      });
    },
    commit,
    async openPullRequest(repo, { branch, title, changes }) {
      await api('POST', `/repos/${user}/${repo}/branches`, {
        new_branch_name: branch,
        old_branch_name: 'main',
      });
      await commit(repo, title, changes, branch);
      const pull = await api<{ number: number }>('POST', `/repos/${user}/${repo}/pulls`, {
        title,
        head: branch,
        base: 'main',
      });
      return pull.number;
    },
    stop,
  };
}

/** Adds a Gitea/Forgejo connection to `forgejo` in Settings > Git connections, with the token that works. */
export async function addConnection(page: Page, forgejo: Forgejo, name: string): Promise<void> {
  await page.goto('/settings/connections');
  await settle(page);
  await page.getByRole('button', { name: 'Add connection' }).first().click();
  const dialog = page.getByRole('dialog', { name: 'Add git connection' });
  await dialog.getByRole('radio', { name: 'Gitea / Forgejo' }).check({ force: true });
  await dialog.getByLabel('Host').fill(forgejo.host);
  await dialog.getByLabel('Name').fill(name);
  await dialog.getByLabel('Access token').fill(forgejo.token);
  await dialog.getByRole('button', { name: 'Save connection' }).click();
  await expect(dialog).toBeHidden({ timeout: 20_000 });
  await expect(
    page.getByRole('table', { name: 'Git connections' }).getByRole('row').filter({ hasText: name }),
  ).toContainText('Working');
}
