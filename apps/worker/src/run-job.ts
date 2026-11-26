// Runs one pg-boss job through core: core parses the payload with its schema and runs the handler.
// The worker only adds logging and hands the result back to pg-boss.
import {
  type GitContext,
  type JobContext,
  type JobName,
  type JobQueue,
  runJob as runCoreJob,
} from '@zamu/core';
import type { Db } from '@zamu/db';
import type { Logger } from './logger';

/** The fields of a pg-boss job the worker uses. */
export interface JobRecord {
  id: string;
  data: unknown;
  retryCount: number;
}

export interface RunJobContext {
  db: Db;
  logger: Logger;
  /** APP_TIME_ZONE, passed to core so cycles end at midnight and archive days count in that zone. */
  timeZone?: string;
  /**
   * APP_ENCRYPTION_KEY, GIT_ALLOW_PRIVATE_HOSTS and GIT_HTTP_HOSTS (and a provider factory in tests)
   * for the Backlog.md jobs. Without the key, refreshes end paused.
   */
  git?: Pick<GitContext, 'encryptionKey' | 'gitHosts' | 'providerFactory'>;
  /** Producer for jobs that enqueue others (backlog.poll enqueues refreshes). */
  jobs?: JobQueue;
}

/** The core job context: only the keys that are set (core's optional fields reject undefined). */
function coreContext({ db, timeZone, git, jobs }: RunJobContext): JobContext {
  return {
    db,
    ...(timeZone ? { timeZone } : {}),
    ...(git?.encryptionKey ? { encryptionKey: git.encryptionKey } : {}),
    ...(git?.gitHosts ? { gitHosts: git.gitHosts } : {}),
    ...(git?.providerFactory ? { providerFactory: git.providerFactory } : {}),
    ...(jobs ? { jobs } : {}),
  };
}

/**
 * Runs `job` and returns the handler's result, which pg-boss stores as the job's output.
 * Rethrows handler and payload errors so pg-boss fails the job and retries it up to the queue's limit.
 */
export async function runJob(name: JobName, job: JobRecord, context: RunJobContext): Promise<unknown> {
  const { logger } = context;
  const jobLogger = logger.child({ job: name, jobId: job.id });
  const started = performance.now();
  const durationMs = () => Math.round(performance.now() - started);
  jobLogger.info('job started', { retryCount: job.retryCount });

  try {
    const output = await runCoreJob(coreContext(context), name, job.data);
    jobLogger.info('job completed', { durationMs: durationMs(), output });
    return output;
  } catch (error) {
    jobLogger.error('job failed', { durationMs: durationMs(), retryCount: job.retryCount, error });
    throw error;
  }
}
