// Handlers for the jobs in ./jobs. The worker looks a handler up by job name, parses the payload
// with parseJobPayload and calls it; the business logic stays here in core.
import { archiveDueTasks } from './archive';
import { pollBacklogSources, refreshBacklogSource } from './backlog/refresh';
import type { DbContext, GitContext } from './context';
import { type ClockContext, endDueCycles } from './cycles';
import { expireInvitations } from './invitations';
import {
  BACKLOG_POLL,
  BACKLOG_REFRESH,
  CYCLES_END_DUE,
  INVITATIONS_EXPIRE,
  type JobName,
  type JobPayload,
  type JobQueue,
  parseJobPayload,
  REPOSITORY_EVENT,
  REPOSITORY_POLL,
  REPOSITORY_SYNC,
  TASKS_ARCHIVE_DUE,
} from './jobs';
import { handleRepositoryEvent } from './pull-requests';
import { pollRepositories, syncRepository } from './repository';

/**
 * What handlers get from the worker: the database and the clock (APP_TIME_ZONE as `timeZone`).
 * The Backlog.md and repository jobs also use the git settings (APP_ENCRYPTION_KEY,
 * GIT_ALLOW_PRIVATE_HOSTS, GIT_HTTP_HOSTS, the provider factory) and the job queue (the polls
 * enqueue refreshes and checks). The archive job counts days in `timeZone`.
 */
export type JobContext = DbContext & ClockContext & GitContext & { jobs?: JobQueue };

export type JobHandler<N extends JobName> = (ctx: JobContext, payload: JobPayload<N>) => Promise<unknown>;

function withClock(ctx: JobContext, now: string | undefined): JobContext {
  if (!now) return ctx;
  const date = new Date(now);
  return { ...ctx, now: () => date };
}

export const jobHandlers: { [N in JobName]: JobHandler<N> } = {
  [INVITATIONS_EXPIRE]: (ctx, payload) =>
    expireInvitations(ctx, payload.now ? { now: new Date(payload.now) } : {}),
  [CYCLES_END_DUE]: (ctx, payload) => endDueCycles(withClock(ctx, payload.now)),
  [BACKLOG_REFRESH]: (ctx, payload) => refreshBacklogSource(ctx, payload.sourceId, payload.trigger),
  [BACKLOG_POLL]: (ctx, payload) => pollBacklogSources(withClock(ctx, payload.now)),
  [REPOSITORY_EVENT]: (ctx, payload) => handleRepositoryEvent(ctx, payload),
  [REPOSITORY_SYNC]: (ctx, payload) => syncRepository(ctx, payload.linkId),
  [REPOSITORY_POLL]: (ctx, payload) => pollRepositories(withClock(ctx, payload.now)),
  [TASKS_ARCHIVE_DUE]: (ctx, payload) =>
    archiveDueTasks(ctx, payload.now ? { now: new Date(payload.now) } : {}),
};

/** Parses `data` for `name` and runs its handler. Throws on an invalid payload, which fails the job. */
export async function runJob<N extends JobName>(ctx: JobContext, name: N, data: unknown): Promise<unknown> {
  const handler = jobHandlers[name] as JobHandler<N>;
  return handler(ctx, parseJobPayload(name, data));
}
