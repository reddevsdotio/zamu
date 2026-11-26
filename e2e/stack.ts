// The docker compose stack the end-to-end suite runs against: the production docker-compose.yml under its own
// project name, so it never touches the development database (docker-compose.dev.yml) or a self-hosted stack
// started from the same checkout. Every run starts on a fresh Postgres volume.
//
// The upgrade test (upgrade.spec.ts) starts a second stack from the same compose file under another project
// name and port, first on older images and then on this checkout's image.
//
// The Backlog.md specs start a Forgejo container (e2e/forgejo.ts) and attach it to the stack's network, so the
// app reaches it by a network alias over plain HTTP and Forgejo delivers webhooks to the web container. The
// stack therefore runs with APP_ENCRYPTION_KEY, GIT_ALLOW_PRIVATE_HOSTS=true and those aliases in GIT_HTTP_HOSTS.
import { execFileSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';

export const repoRoot = fileURLToPath(new URL('..', import.meta.url));

/** Compose project name: containers are zamu-e2e-web-1 and so on, the volume is zamu-e2e_pgdata. */
export const composeProject = process.env.E2E_COMPOSE_PROJECT ?? 'zamu-e2e';

/** Host port the web container is published on. */
export const port = process.env.E2E_PORT ?? '3100';

/**
 * URL the browser and the CLI use. On a GitHub Actions runner the stack runs on the runner host, so the default
 * works. When the Docker daemon is on another host, E2E_BASE_URL points there (for example
 * http://docker:3100). Better Auth's base URL must match it, so the stack gets the same value.
 */
export const baseURL = (process.env.E2E_BASE_URL ?? `http://localhost:${port}`).replace(/\/$/, '');

/** Image built and run by the stack. Shares the tag with nothing else, so a run never replaces another image. */
export const image = process.env.ZAMU_IMAGE ?? 'zamu:e2e';

/**
 * Network alias of each Forgejo on a stack network (see forgejo.ts): one per Backlog.md spec, and the upgrade
 * test's, which feeds the mirror it backfills.
 */
export const forgejoAliases = {
  mirror: 'forgejo-mirror',
  import: 'forgejo-import',
  upgrade: 'forgejo-upgrade',
} as const;

/**
 * Compose files: the production docker-compose.yml, which passes the M3 variables (APP_ENCRYPTION_KEY,
 * GIT_ALLOW_PRIVATE_HOSTS, GIT_HTTP_HOSTS) from the environment the stack sets.
 */
export const composeFiles = ['docker-compose.yml'];

/** 32 bytes, base64. Fixed so a kept stack (E2E_KEEP_STACK=1) can still read its own tokens. */
export const encryptionKey =
  process.env.E2E_APP_ENCRYPTION_KEY ?? Buffer.from('e2e-only-key-never-in-production').toString('base64');

/** BETTER_AUTH_SECRET of every stack; a second web container on the same database needs the same one. */
export const betterAuthSecret =
  process.env.E2E_BETTER_AUTH_SECRET ?? 'e2e-only-secret-never-used-in-production-0123456789';

/** Path of the CLI that globalSetup builds; the suite runs it like an agent would. */
export const cliPath = fileURLToPath(new URL('../apps/cli/dist/index.js', import.meta.url));

export interface StackOptions {
  /** Compose project name; also names the data volume (<project>_pgdata). */
  project: string;
  /** Host port of the web container. */
  port: string;
  /** URL the browser uses; BETTER_AUTH_URL and PUBLIC_URL get the same value. */
  baseURL: string;
  /** Image for migrate, web and worker. */
  image: string;
}

export interface Stack extends StackOptions {
  /** The stack's default network, which the Backlog.md specs attach Forgejo to. */
  network: string;
  /** Runs `docker compose -p <project> -f docker-compose.yml <args>` from the repository root. */
  compose(args: string[], options?: { quiet?: boolean }): string;
  /** Polls GET /api/healthz until it answers 200. */
  waitForHealthy(timeoutMs?: number): Promise<void>;
  /** Prints `compose ps` and the last log lines, for a failure report. */
  dumpState(): string;
}

/** A compose stack; `image` may change between calls (the upgrade test swaps it). */
export function createStack(options: StackOptions): Stack {
  const stack: Stack = {
    ...options,
    network: `${options.project}_default`,
    compose(args, { quiet = false } = {}) {
      const output = execFileSync(
        'docker',
        ['compose', '-p', stack.project, ...composeFiles.flatMap((file) => ['-f', file]), ...args],
        {
          cwd: repoRoot,
          // Shell values win over the repository's .env, which compose also reads.
          env: {
            ...process.env,
            ZAMU_IMAGE: stack.image,
            PORT: stack.port,
            BETTER_AUTH_URL: stack.baseURL,
            PUBLIC_URL: stack.baseURL,
            BETTER_AUTH_SECRET: betterAuthSecret,
            POSTGRES_USER: 'postgres',
            POSTGRES_PASSWORD: 'postgres',
            POSTGRES_DB: 'zamu',
            APP_ENCRYPTION_KEY: encryptionKey,
            GIT_ALLOW_PRIVATE_HOSTS: 'true',
            GIT_HTTP_HOSTS: Object.values(forgejoAliases).join(','),
          },
          encoding: 'utf8',
          stdio: quiet ? ['ignore', 'pipe', 'pipe'] : ['ignore', 'inherit', 'inherit'],
        },
      );
      return output ?? '';
    },
    async waitForHealthy(timeoutMs = 180_000) {
      const deadline = Date.now() + timeoutMs;
      let last = '';
      while (Date.now() < deadline) {
        try {
          const response = await fetch(`${stack.baseURL}/api/healthz`, {
            signal: AbortSignal.timeout(5_000),
          });
          if (response.ok) return;
          last = `HTTP ${response.status}`;
        } catch (error) {
          last = error instanceof Error ? error.message : String(error);
        }
        await new Promise((resolve) => setTimeout(resolve, 1_000));
      }
      throw new Error(
        `${stack.baseURL}/api/healthz did not answer 200 within ${timeoutMs / 1000} s (last: ${last})`,
      );
    },
    dumpState() {
      try {
        return [
          stack.compose(['ps', '-a'], { quiet: true }),
          stack.compose(['logs', '--no-color', '--tail', '100'], { quiet: true }),
        ].join('\n');
      } catch (error) {
        return `could not read the stack state: ${error instanceof Error ? error.message : String(error)}`;
      }
    },
  };
  return stack;
}

/** The command that removes a kept stack, for log messages. */
export function downCommand(stack: Pick<Stack, 'project'>): string {
  return `docker compose -p ${stack.project} ${composeFiles.map((file) => `-f ${file}`).join(' ')} down -v`;
}

/** The stack every spec but the upgrade test uses. */
export const mainStack = createStack({ project: composeProject, port, baseURL, image });

export const compose = mainStack.compose;
export const waitForHealthy = mainStack.waitForHealthy;
