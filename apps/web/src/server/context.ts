// The web server's single set of long-lived services: one Postgres pool, one Better Auth instance,
// the pg-boss producer and the core context built on them. Better Auth (/api/auth), the session
// helpers, the /api/v1 handler, server functions, the webhook route and server-side oRPC calls all
// share it.
// Framework-free on purpose: tests and scripts import it without TanStack Start.
// M6: requestSource reads the machine and branch the CLI sends with every request into the actor.
// 0.10: WORKSPACE_CREATION reaches core as `workspaceCreation`.
import { type Auth, createAuth } from '@zamu/auth';
import { type EntrySource, parseSourceHeader, SOURCE_HEADERS } from '@zamu/contracts';
import type { CoreContext } from '@zamu/core';
import { createDb, type Db, type DbHandle } from '@zamu/db';
import { readServerConfig, type ServerEnv } from './config';
import { createJobProducer, type JobProducer } from './jobs';

export type { ServerEnv } from './config';

export interface ServerContext extends CoreContext {
  db: Db;
  auth: Auth;
  pool: DbHandle['pool'];
  /** Sends background jobs (Backlog.md refreshes); started on first use. */
  jobs: JobProducer;
}

/**
 * Builds the services from environment variables. Call once per process; see getServerContext.
 * Throws ServerConfigError when the configuration is invalid (see config.ts).
 */
export function createServerContext(env: ServerEnv = process.env): ServerContext {
  const config = readServerConfig(env);
  const { db, pool } = createDb(config.databaseUrl);
  // Without a listener, an idle connection that breaks (Postgres restart) crashes the server.
  pool.on('error', (error) => console.error('server: idle database connection failed:', error.message));
  const auth = createAuth({ db, secret: config.secret, baseUrl: config.baseUrl, config: config.auth });
  const jobs = createJobProducer(config.databaseUrl);
  // PUBLIC_URL builds invitation and webhook links; it matches BETTER_AUTH_URL unless a proxy says
  // otherwise. Git: core's default provider factory (@zamu/git-providers createProvider) is used.
  return {
    db,
    auth,
    pool,
    jobs,
    publicUrl: config.publicUrl,
    timeZone: config.timeZone,
    ...(config.encryptionKey ? { encryptionKey: config.encryptionKey } : {}),
    gitHosts: config.gitHosts,
    workspaceCreation: config.workspaceCreation,
  };
}

/**
 * M6: the machine and branch of a request, from the CLI's x-zamu-machine and x-zamu-branch headers
 * (trimmed, cut to 100 characters, dropped when empty or holding control characters). Undefined
 * when neither is usable: the web app sends neither.
 */
export function requestSource(headers: Headers): EntrySource | undefined {
  const machine = parseSourceHeader(headers.get(SOURCE_HEADERS.machine));
  const branch = parseSourceHeader(headers.get(SOURCE_HEADERS.branch));
  return machine === null && branch === null ? undefined : { machine, branch };
}

const globalKey = Symbol.for('zamu.web.serverContext');
type GlobalWithContext = typeof globalThis & { [globalKey]?: ServerContext };

/**
 * The process-wide ServerContext, created on first use from process.env. Kept on globalThis so
 * dev-server module reloads reuse the pool instead of leaking one per reload.
 */
export function getServerContext(): ServerContext {
  const store = globalThis as GlobalWithContext;
  store[globalKey] ??= createServerContext();
  return store[globalKey];
}
