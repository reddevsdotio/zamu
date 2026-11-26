// The pg-boss worker: starts pg-boss (creating or migrating its schema), creates the queues core
// declares, registers a handler per job name, schedules core's recurring jobs and stops cleanly.
// M7: the repository jobs (repository.event, repository.sync, the hourly repository.poll) and the
// nightly tasks.archive-due, scheduled at 02:30 in APP_TIME_ZONE.
import { createJobQueue, ensureQueues, JOB_NAMES, jobSchedules } from '@zamu/core';
import { createDb, type Db, type DbHandle } from '@zamu/db';
import { PgBoss } from 'pg-boss';
import { createLogger, type Logger } from './logger';
import { type RunJobContext, runJob } from './run-job';

export interface WorkerOptions {
  databaseUrl: string;
  logger?: Logger;
  /** Connection tries before giving up, with pg-boss's backoff (1 s doubling to 30 s). Default 1. */
  startAttempts?: number;
  /** How long stop() lets running jobs finish. Default 8 s, under Docker's 10 s stop grace period. */
  shutdownTimeoutMs?: number;
  /** How often each queue is polled for new jobs. Default 2 s (pg-boss's default). */
  pollingIntervalSeconds?: number;
  /** APP_TIME_ZONE for core jobs (cycle ends, the nightly archive and its schedule). Default UTC. */
  timeZone?: string;
  /** APP_ENCRYPTION_KEY and the git host settings for the Backlog.md jobs (see readWorkerConfig). */
  git?: RunJobContext['git'];
}

export interface Worker {
  boss: PgBoss;
  db: Db;
  pool: DbHandle['pool'];
  /** Stops pg-boss (waiting for running jobs up to the shutdown timeout) and closes the pool. Idempotent. */
  stop(): Promise<void>;
}

const APPLICATION_NAME = 'zamu-worker';

export async function startWorker(options: WorkerOptions): Promise<Worker> {
  const {
    databaseUrl,
    logger = createLogger({ base: { service: 'worker' } }),
    startAttempts = 1,
    shutdownTimeoutMs = 8_000,
    pollingIntervalSeconds,
    timeZone,
    git,
  } = options;

  logger.info('worker starting', { jobs: JOB_NAMES });

  // Pool for core's queries in the handlers. pg-boss opens and closes its own pool.
  const { db, pool } = createDb(databaseUrl, { application_name: APPLICATION_NAME, max: 5 });
  // Without a listener, an error on an idle client (Postgres restarting, for example) crashes the process.
  pool.on('error', (error) => logger.error('database pool error', { error }));

  const boss = new PgBoss({
    connectionString: databaseUrl,
    application_name: `${APPLICATION_NAME}/pg-boss`,
    instanceName: 'worker',
  });
  boss.on('error', (error) => logger.error('pg-boss error', { error }));
  boss.on('warning', (warning) =>
    logger.warn('pg-boss warning', { warning: warning.message, data: warning.data }),
  );

  let stopping: Promise<void> | undefined;
  const stop = () => {
    stopping ??= (async () => {
      try {
        await boss.stop({ graceful: true, timeout: shutdownTimeoutMs });
      } finally {
        if (!pool.ended) await pool.end();
      }
      logger.info('worker stopped');
    })();
    return stopping;
  };

  try {
    // Creates the pg-boss schema on first start and migrates it after an upgrade.
    await boss.start({ attempts: startAttempts });
    await ensureQueues(boss);

    // pg-boss rejects an explicit `pollingIntervalSeconds: undefined`, so the key is only set when given.
    const workOptions = pollingIntervalSeconds === undefined ? {} : { pollingIntervalSeconds };
    // Handlers enqueue follow-up jobs (the Backlog.md poll queues refreshes) through the same boss.
    const context: RunJobContext = {
      db,
      logger,
      jobs: createJobQueue(boss),
      ...(timeZone ? { timeZone } : {}),
      ...(git ? { git } : {}),
    };
    for (const name of JOB_NAMES) {
      // pg-boss fetches one job at a time (batchSize 1); the returned value becomes the job's output.
      await boss.work<unknown>(name, workOptions, async ([job]) =>
        job ? runJob(name, job, context) : undefined,
      );
    }

    await syncSchedules(boss, logger, timeZone);
  } catch (error) {
    await stop().catch((stopError: unknown) => logger.error('worker stop failed', { error: stopError }));
    throw error;
  }

  logger.info('worker ready', { jobs: JOB_NAMES, encryption: git?.encryptionKey ? 'ready' : 'off' });
  return { boss, db, pool, stop };
}

/**
 * Schedules every entry of core's jobSchedules(timeZone) and removes schedules core no longer
 * declares. Restarting with another APP_TIME_ZONE moves the zone-bound schedules (the archive).
 */
async function syncSchedules(boss: PgBoss, logger: Logger, timeZone: string | undefined): Promise<void> {
  const wanted = new Map(
    Object.entries(jobSchedules(timeZone)).flatMap(([name, schedule]) =>
      schedule ? [[name, schedule] as const] : [],
    ),
  );

  for (const existing of await boss.getSchedules()) {
    if (!wanted.has(existing.name)) {
      await boss.unschedule(existing.name, existing.key);
      logger.info('job unscheduled', { job: existing.name });
    }
  }

  for (const [name, { cron, tz, data }] of wanted) {
    // schedule() upserts, so restarts and several workers keep a single schedule per job.
    // missed: 'once' sends one catch-up job when the worker was down at the scheduled time.
    await boss.schedule(name, cron, data, { tz, missed: 'once' });
    logger.info('job scheduled', { job: name, cron, tz });
  }
}
