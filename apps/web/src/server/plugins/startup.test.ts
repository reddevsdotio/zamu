// Starts the built server (.output/server/index.mjs, as `pnpm --filter web start` and the Docker image do)
// and checks that config-check.ts refuses to start it without a usable BETTER_AUTH_SECRET, or with an
// OIDC_WORKSPACE that names no workspace once setup is done. Needs `pnpm --filter web build` first;
// skipped otherwise.
import { type ChildProcess, spawn } from 'node:child_process';
import { existsSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { schema } from '@zamu/db';
import { createTestDatabase } from '@zamu/db/test';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';

const serverEntry = fileURLToPath(new URL('../../../.output/server/index.mjs', import.meta.url));
const built = existsSync(serverEntry);
const SKIPPED = 'skipped: apps/web/.output is missing, run `pnpm --filter web build` first';

const SET_SECRET =
  'Generate one with `openssl rand -base64 32` and set it in .env or the container environment.';

/** Everything but the secret. Port 0 picks a free port; the server only reads the config before listening. */
const ENV = {
  PORT: '0',
  HOST: '127.0.0.1',
  DATABASE_URL: 'postgres://postgres:postgres@127.0.0.1:5432/pm_startup_test',
  BETTER_AUTH_URL: 'http://127.0.0.1:3000',
};

interface Run {
  exit: Promise<{ code: number | null; signal: NodeJS.Signals | null }>;
  output: () => string;
  /** Resolves with the output once it contains `text`. */
  waitFor: (text: string) => Promise<string>;
}

const children: ChildProcess[] = [];

beforeEach((context) => {
  if (!built) context.skip(SKIPPED);
});

afterEach(() => {
  for (const child of children.splice(0)) if (child.exitCode === null) child.kill('SIGKILL');
});

function startServer(env: Record<string, string>): Run {
  // Only PATH from the outside: no .env, no BETTER_AUTH_SECRET from the shell running the tests.
  const child = spawn(process.execPath, [serverEntry], {
    env: { PATH: process.env.PATH ?? '', ...env },
    stdio: ['ignore', 'pipe', 'pipe'],
  });
  children.push(child);
  let output = '';
  const waiters: { text: string; resolve: (output: string) => void }[] = [];
  const onData = (chunk: Buffer) => {
    output += chunk.toString();
    for (const waiter of waiters) if (output.includes(waiter.text)) waiter.resolve(output);
  };
  child.stdout?.on('data', onData);
  child.stderr?.on('data', onData);
  const exit = new Promise<{ code: number | null; signal: NodeJS.Signals | null }>((resolve) => {
    child.on('exit', (code, signal) => resolve({ code, signal }));
  });
  return {
    exit,
    output: () => output,
    waitFor: (text) =>
      new Promise((resolve) => {
        if (output.includes(text)) resolve(output);
        else waiters.push({ text, resolve });
      }),
  };
}

describe('built web server startup', () => {
  it('exits 1 before listening when BETTER_AUTH_SECRET is not set', async () => {
    const run = startServer(ENV);

    await expect(run.exit).resolves.toEqual({ code: 1, signal: null });
    expect(run.output()).toContain(`BETTER_AUTH_SECRET is not set. ${SET_SECRET}`);
    expect(run.output()).not.toContain('Listening on');
  });

  it('exits 1 before listening when BETTER_AUTH_SECRET is shorter than 32 characters', async () => {
    const run = startServer({ ...ENV, BETTER_AUTH_SECRET: 'too-short' });

    await expect(run.exit).resolves.toEqual({ code: 1, signal: null });
    expect(run.output()).toContain(`BETTER_AUTH_SECRET is 9 characters; use 32 or more. ${SET_SECRET}`);
    expect(run.output()).not.toContain('Listening on');
  });

  it('exits 1 even when the environment says NODE_ENV=development', async () => {
    const run = startServer({ ...ENV, NODE_ENV: 'development' });

    await expect(run.exit).resolves.toEqual({ code: 1, signal: null });
    expect(run.output()).toContain('BETTER_AUTH_SECRET is not set.');
  });

  it('listens with a valid secret', async () => {
    const run = startServer({ ...ENV, BETTER_AUTH_SECRET: 'a'.repeat(32) });

    const exitedEarly = run.exit.then(({ code }) => {
      throw new Error(`The server exited (code ${code}) before listening:\n${run.output()}`);
    });
    const output = await Promise.race([run.waitFor('Listening on'), exitedEarly]);
    expect(output).not.toContain('configuration is invalid');
  });

  it('exits 1 before listening when OIDC_WORKSPACE names no workspace after setup', async () => {
    const database = await createTestDatabase({ prefix: 'pm_startup_oidc' });
    try {
      await database.db.insert(schema.organization).values({ name: 'Globex', slug: 'globex' });
      const sso = {
        ...ENV,
        DATABASE_URL: database.url,
        BETTER_AUTH_SECRET: 'a'.repeat(32),
        OIDC_ISSUER: 'https://auth.example.com',
        OIDC_CLIENT_ID: 'zamu',
        OIDC_CLIENT_SECRET: 'secret',
      };
      const run = startServer({ ...sso, OIDC_WORKSPACE: 'acme' });
      await expect(run.exit).resolves.toEqual({ code: 1, signal: null });
      expect(run.output()).toContain('OIDC_WORKSPACE is "acme", but no workspace has that slug.');
      expect(run.output()).not.toContain('Listening on');

      const named = startServer({ ...sso, OIDC_WORKSPACE: 'globex' });
      const exitedEarly = named.exit.then(({ code }) => {
        throw new Error(`The server exited (code ${code}) before listening:\n${named.output()}`);
      });
      await Promise.race([named.waitFor('Listening on'), exitedEarly]);
    } finally {
      for (const child of children.splice(0)) if (child.exitCode === null) child.kill('SIGKILL');
      await database.drop();
    }
  });
});
