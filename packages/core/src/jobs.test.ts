import { sql } from 'drizzle-orm';
import { PgBoss } from 'pg-boss';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { enqueueBacklogRefresh, REFRESH_THROTTLE_SECONDS } from './backlog/refresh';
import {
  BACKLOG_POLL,
  BACKLOG_REFRESH,
  CYCLES_END_DUE,
  createJobQueue,
  enqueue,
  ensureQueues,
  INVITATIONS_EXPIRE,
  isJobName,
  JOB_NAMES,
  JOB_QUEUE_OPTIONS,
  JOB_SCHEDULES,
  type JobQueue,
  jobSchedules,
  parseJobPayload,
  REPOSITORY_EVENT,
  REPOSITORY_POLL,
  REPOSITORY_SYNC,
  TASKS_ARCHIVE_DUE,
} from './jobs';
import { type TestContext, testContext } from './testing/fixtures';

describe('jobs', () => {
  let ctx: TestContext;
  let boss: PgBoss;

  beforeAll(async () => {
    ctx = testContext();
    // Producer-only instance: no maintenance or cron loops in tests.
    boss = new PgBoss({ connectionString: ctx.url, supervise: false, schedule: false });
    boss.on('error', () => {});
    await boss.start();
    await ensureQueues(boss);
  }, 60_000);
  afterAll(async () => {
    await boss?.stop({ graceful: false });
    await ctx?.close();
  });

  async function jobCount(id: string): Promise<number> {
    const result = await ctx.db.execute<{ n: number }>(
      sql`select count(*)::int as n from pgboss.job where id = ${id}`,
    );
    return result.rows[0]?.n ?? 0;
  }

  it('exports names, payload schemas and the schedules', () => {
    expect(JOB_NAMES).toEqual([
      'invitations.expire',
      'cycles.end-due',
      'backlog.refresh',
      'backlog.poll',
      'repository.event',
      'repository.sync',
      'repository.poll',
      'tasks.archive-due',
    ]);
    expect(isJobName('invitations.expire')).toBe(true);
    expect(isJobName('cycles.end-due')).toBe(true);
    expect(isJobName('nope')).toBe(false);
    expect(JOB_SCHEDULES[INVITATIONS_EXPIRE]).toEqual({ cron: '0 3 * * *', tz: 'UTC', data: {} });
    expect(JOB_SCHEDULES[CYCLES_END_DUE]).toEqual({ cron: '0 * * * *', tz: 'UTC', data: {} });
    expect(JOB_SCHEDULES[BACKLOG_POLL]).toEqual({ cron: '15 * * * *', tz: 'UTC', data: {} });
    expect(JOB_SCHEDULES[BACKLOG_REFRESH]).toBeUndefined();
    expect(JOB_QUEUE_OPTIONS[BACKLOG_REFRESH]).toEqual({ policy: 'stately' });
    // M7
    expect(JOB_SCHEDULES[REPOSITORY_POLL]).toEqual({ cron: '45 * * * *', tz: 'UTC', data: {} });
    expect(JOB_SCHEDULES[TASKS_ARCHIVE_DUE]).toEqual({ cron: '30 2 * * *', tz: 'UTC', data: {} });
    expect(jobSchedules('Europe/Paris')[TASKS_ARCHIVE_DUE]).toEqual({
      cron: '30 2 * * *',
      tz: 'Europe/Paris',
      data: {},
    });
    expect(jobSchedules('Europe/Paris')[REPOSITORY_POLL]?.tz).toBe('UTC');
    expect(JOB_SCHEDULES[REPOSITORY_SYNC]).toBeUndefined();
    expect(JOB_SCHEDULES[REPOSITORY_EVENT]).toBeUndefined();
    expect(JOB_QUEUE_OPTIONS[REPOSITORY_SYNC]).toEqual({ policy: 'stately' });
    expect(JOB_QUEUE_OPTIONS[REPOSITORY_EVENT]).toBeUndefined();
    const linkId = crypto.randomUUID();
    expect(parseJobPayload(REPOSITORY_SYNC, { linkId })).toEqual({ linkId });
    expect(() => parseJobPayload(REPOSITORY_SYNC, { linkId: 'nope' })).toThrow();
    const request = {
      number: 12,
      title: 'Retry webhooks',
      body: 'Closes: PAY-1',
      state: 'open',
      headBranch: 'feat/retry',
      baseBranch: 'main',
      author: 'claude-dev',
      mergedBy: null,
      webUrl: 'https://github.com/northwind/payments/pull/12',
      openedAt: '2040-01-01T10:00:00.000Z',
      mergedAt: null,
      closedAt: null,
      updatedAt: '2040-01-01T10:00:00.000Z',
    };
    expect(parseJobPayload(REPOSITORY_EVENT, { linkId, request, action: 'opened' })).toEqual({
      linkId,
      request,
      action: 'opened',
    });
    expect(parseJobPayload(REPOSITORY_EVENT, { linkId, request })).toEqual({ linkId, request });
    expect(() =>
      parseJobPayload(REPOSITORY_EVENT, { linkId, request: { ...request, state: 'gone' } }),
    ).toThrow();
    expect(() => parseJobPayload(REPOSITORY_EVENT, { linkId, request, action: 'labeled' })).toThrow();
    expect(parseJobPayload(REPOSITORY_POLL, {})).toEqual({});
    expect(parseJobPayload(TASKS_ARCHIVE_DUE, { now: '2040-01-01T02:30:00Z' })).toEqual({
      now: '2040-01-01T02:30:00Z',
    });
    const sourceId = crypto.randomUUID();
    expect(parseJobPayload(BACKLOG_REFRESH, { sourceId, trigger: 'webhook' })).toEqual({
      sourceId,
      trigger: 'webhook',
    });
    expect(() => parseJobPayload(BACKLOG_REFRESH, { sourceId, trigger: 'push' })).toThrow();
    expect(() => parseJobPayload(BACKLOG_REFRESH, { sourceId: 'nope', trigger: 'poll' })).toThrow();
    expect(parseJobPayload(BACKLOG_POLL, {})).toEqual({});
    expect(parseJobPayload(CYCLES_END_DUE, { now: '2040-01-01T00:00:00Z' })).toEqual({
      now: '2040-01-01T00:00:00Z',
    });
    expect(() => parseJobPayload(CYCLES_END_DUE, { now: 'soon' })).toThrow();
    expect(parseJobPayload(INVITATIONS_EXPIRE, null)).toEqual({});
    expect(() => parseJobPayload(INVITATIONS_EXPIRE, { now: 'soon' })).toThrow();
  });

  it('keeps a job sent inside a committed transaction', async () => {
    const id = await ctx.db.transaction((tx) => enqueue(boss, tx, INVITATIONS_EXPIRE, {}));
    expect(id).toBeTruthy();
    expect(await jobCount(id as string)).toBe(1);
    const job = await boss.getJobById(INVITATIONS_EXPIRE, id as string);
    expect(job?.data).toEqual({});
  });

  it('leaves no job when the transaction rolls back', async () => {
    let jobId: string | null = null;
    await expect(
      ctx.db.transaction(async (tx) => {
        jobId = await createJobQueue(boss).enqueue(tx, INVITATIONS_EXPIRE, {});
        // Visible inside the transaction...
        const inside = await tx.execute<{ n: number }>(
          sql`select count(*)::int as n from pgboss.job where id = ${jobId}`,
        );
        expect(inside.rows[0]?.n).toBe(1);
        throw new Error('roll back');
      }),
    ).rejects.toThrow('roll back');
    expect(jobId).toBeTruthy();
    // ...and gone after the rollback.
    expect(await jobCount(jobId as unknown as string)).toBe(0);
  });

  it('validates payloads before sending', async () => {
    await expect(
      ctx.db.transaction((tx) => enqueue(boss, tx, INVITATIONS_EXPIRE, { now: 'not a date' })),
    ).rejects.toThrow();
  });

  it('creates repository.sync as a stately queue: one queued check per link', async () => {
    expect((await boss.getQueue(REPOSITORY_SYNC))?.policy).toBe('stately');
    const linkId = crypto.randomUUID();
    const first = await ctx.db.transaction((tx) =>
      enqueue(boss, tx, REPOSITORY_SYNC, { linkId }, { singletonKey: linkId }),
    );
    const second = await ctx.db.transaction((tx) =>
      enqueue(boss, tx, REPOSITORY_SYNC, { linkId }, { singletonKey: linkId }),
    );
    expect(first).toBeTruthy();
    expect(second).toBeNull();
  });

  it('creates backlog.refresh as a stately queue', async () => {
    const queue = await boss.getQueue(BACKLOG_REFRESH);
    expect(queue?.policy).toBe('stately');
  });

  it('queues asked-for refreshes without the debounce slot, webhooks and polls with it', async () => {
    const sent: { trigger: string; options: unknown }[] = [];
    const fake = {
      enqueue: async (_tx: unknown, _name: string, data: { trigger: string }, options?: unknown) => {
        sent.push({ trigger: data.trigger, options });
        return 'job';
      },
    } as unknown as JobQueue;
    const sourceId = crypto.randomUUID();
    for (const trigger of ['manual', 'cli', 'setup', 'webhook', 'poll'] as const) {
      await ctx.db.transaction((tx) => enqueueBacklogRefresh({ jobs: fake }, tx, sourceId, trigger));
    }
    const debounced = sent.filter(
      (entry) => (entry.options as { singletonSeconds?: number }).singletonSeconds,
    );
    expect(debounced.map((entry) => entry.trigger)).toEqual(['webhook', 'poll']);
    const replacing = sent.filter(
      (entry) => (entry.options as { replaceDebounced?: boolean }).replaceDebounced,
    );
    expect(replacing.map((entry) => entry.trigger)).toEqual(['manual', 'cli']);
    expect(
      sent.every((entry) => (entry.options as { singletonKey?: string }).singletonKey === sourceId),
    ).toBe(true);
  });

  it('collapses refresh triggers for one source into one queued run', async () => {
    const queue = createJobQueue(boss);
    const sourceId = crypto.randomUUID();
    const other = crypto.randomUUID();
    const first = await ctx.db.transaction((tx) =>
      enqueueBacklogRefresh({ jobs: queue }, tx, sourceId, 'webhook'),
    );
    const second = await ctx.db.transaction((tx) =>
      enqueueBacklogRefresh({ jobs: queue }, tx, sourceId, 'manual'),
    );
    const third = await ctx.db.transaction((tx) =>
      enqueueBacklogRefresh({ jobs: queue }, tx, sourceId, 'poll'),
    );
    const elsewhere = await ctx.db.transaction((tx) =>
      enqueueBacklogRefresh({ jobs: queue }, tx, other, 'webhook'),
    );
    expect(first).toBeTruthy();
    expect(second).toBeNull();
    expect(third).toBeNull();
    expect(elsewhere).toBeTruthy();
    const job = await boss.getJobById(BACKLOG_REFRESH, first as string);
    expect(job).toMatchObject({ data: { sourceId, trigger: 'webhook' }, singletonKey: sourceId });
    const result = await ctx.db.execute<{ n: number }>(
      sql`select count(*)::int as n from pgboss.job where name = ${BACKLOG_REFRESH} and singleton_key = ${sourceId}`,
    );
    expect(result.rows[0]?.n).toBe(1);
    expect(REFRESH_THROTTLE_SECONDS).toBe(60);
  });

  it('queues one more run while a refresh of the source is running', async () => {
    const queue = createJobQueue(boss);
    const sourceId = crypto.randomUUID();
    const first = await ctx.db.transaction((tx) =>
      enqueueBacklogRefresh({ jobs: queue }, tx, sourceId, 'webhook'),
    );
    // Start it: the job becomes active.
    const fetched = await boss.fetch(BACKLOG_REFRESH, { batchSize: 20 });
    expect(fetched.map((job) => job.id)).toContain(first);
    const during = await ctx.db.transaction((tx) =>
      enqueueBacklogRefresh({ jobs: queue }, tx, sourceId, 'webhook'),
    );
    expect(during).toBeTruthy();
    const again = await ctx.db.transaction((tx) =>
      enqueueBacklogRefresh({ jobs: queue }, tx, sourceId, 'webhook'),
    );
    expect(again).toBeNull();
    // A burst lands in the next 60-second slot: it starts after the current slot ends.
    const queued = await boss.getJobById(BACKLOG_REFRESH, during as string);
    expect(queued?.startAfter.getTime()).toBeGreaterThan(Date.now() - 1000);
    await boss.complete(BACKLOG_REFRESH, first as string);
  });

  /** Waits for the next minute when the current 60-second slot ends within `margin` ms. */
  async function awayFromSlotEnd(margin = 15_000): Promise<void> {
    const left = 60_000 - (Date.now() % 60_000);
    if (left < margin) await new Promise((resolve) => setTimeout(resolve, left + 200));
  }

  async function refreshJobs(sourceId: string) {
    return boss.findJobs<{ sourceId: string; trigger: string }>(BACKLOG_REFRESH, { key: sourceId });
  }

  it('starts an asked refresh now when a webhook run waits for the next slot (PM-10)', async () => {
    await awayFromSlotEnd();
    const queue = createJobQueue(boss);
    const sourceId = crypto.randomUUID();
    const running = await ctx.db.transaction((tx) =>
      enqueueBacklogRefresh({ jobs: queue }, tx, sourceId, 'webhook'),
    );
    expect((await boss.fetch(BACKLOG_REFRESH, { batchSize: 50 })).map((job) => job.id)).toContain(running);
    // A push during the run waits for the next 60-second slot.
    const webhook = await ctx.db.transaction((tx) =>
      enqueueBacklogRefresh({ jobs: queue }, tx, sourceId, 'webhook'),
    );
    expect(webhook).toBeTruthy();
    const deferred = await boss.getJobById(BACKLOG_REFRESH, webhook as string);
    expect(deferred?.startAfter.getTime()).toBeGreaterThan(Date.now() + 2_000);

    // Refresh now: the waiting webhook run gives way to one that starts now.
    const asked = await ctx.db.transaction((tx) =>
      enqueueBacklogRefresh({ jobs: queue }, tx, sourceId, 'manual'),
    );
    expect(asked).toBeTruthy();
    expect(asked).not.toBe(webhook);
    const jobs = await refreshJobs(sourceId);
    const queued = jobs.filter((job) => job.state === 'created');
    expect(queued.map((job) => job.id)).toEqual([asked]);
    expect(queued[0]?.data).toEqual({ sourceId, trigger: 'manual' });
    expect(queued[0]?.startAfter.getTime()).toBeLessThanOrEqual(Date.now() + 1_000);
    expect(jobs.find((job) => job.id === webhook)?.state).toBe('cancelled');

    // Asking again while that run waits to start reports the queued run.
    const again = await ctx.db.transaction((tx) =>
      enqueueBacklogRefresh({ jobs: queue }, tx, sourceId, 'cli'),
    );
    expect(again).toBeNull();

    // The asked run starts as soon as the running one ends, without waiting for the slot.
    await boss.complete(BACKLOG_REFRESH, running as string);
    const next = await boss.fetch(BACKLOG_REFRESH, { batchSize: 50 });
    expect(next.map((job) => job.id)).toContain(asked);

    // A push during the asked run still queues one more run (the cancelled job freed its slot).
    const during = await ctx.db.transaction((tx) =>
      enqueueBacklogRefresh({ jobs: queue }, tx, sourceId, 'webhook'),
    );
    expect(during).toBeTruthy();
    await boss.complete(BACKLOG_REFRESH, asked as string);
    await boss.deleteJob(BACKLOG_REFRESH, during as string);
  });

  it('keeps the webhook and poll debounce, and a rate-limit retry, when nobody asked', async () => {
    await awayFromSlotEnd();
    const queue = createJobQueue(boss);
    const sourceId = crypto.randomUUID();
    const running = await ctx.db.transaction((tx) =>
      enqueueBacklogRefresh({ jobs: queue }, tx, sourceId, 'webhook'),
    );
    expect((await boss.fetch(BACKLOG_REFRESH, { batchSize: 50 })).map((job) => job.id)).toContain(running);
    const webhook = await ctx.db.transaction((tx) =>
      enqueueBacklogRefresh({ jobs: queue }, tx, sourceId, 'webhook'),
    );
    expect(webhook).toBeTruthy();
    // A second push and the hourly poll collapse into the waiting run, which keeps its slot.
    for (const trigger of ['webhook', 'poll'] as const) {
      const id = await ctx.db.transaction((tx) =>
        enqueueBacklogRefresh({ jobs: queue }, tx, sourceId, trigger),
      );
      expect(id).toBeNull();
    }
    const waiting = await boss.getJobById(BACKLOG_REFRESH, webhook as string);
    expect(waiting?.state).toBe('created');
    expect(waiting?.startAfter.getTime()).toBeGreaterThan(Date.now() + 2_000);
    await boss.deleteJob(BACKLOG_REFRESH, webhook as string);

    // A retry after a rate limit waits as the git host asked, even for Refresh now.
    const retry = await ctx.db.transaction((tx) =>
      enqueueBacklogRefresh({ jobs: queue }, tx, sourceId, 'manual', { startAfterSeconds: 120 }),
    );
    expect(retry).toBeTruthy();
    const asked = await ctx.db.transaction((tx) =>
      enqueueBacklogRefresh({ jobs: queue }, tx, sourceId, 'manual'),
    );
    expect(asked).toBeNull();
    const kept = await boss.getJobById(BACKLOG_REFRESH, retry as string);
    expect(kept?.state).toBe('created');
    expect(kept?.startAfter.getTime()).toBeGreaterThan(Date.now() + 100_000);
    await boss.complete(BACKLOG_REFRESH, running as string);
    await boss.deleteJob(BACKLOG_REFRESH, retry as string);
  });

  it('leaves no replaced job behind when the asking transaction rolls back', async () => {
    await awayFromSlotEnd();
    const queue = createJobQueue(boss);
    const sourceId = crypto.randomUUID();
    const running = await ctx.db.transaction((tx) =>
      enqueueBacklogRefresh({ jobs: queue }, tx, sourceId, 'webhook'),
    );
    expect((await boss.fetch(BACKLOG_REFRESH, { batchSize: 50 })).map((job) => job.id)).toContain(running);
    const webhook = await ctx.db.transaction((tx) =>
      enqueueBacklogRefresh({ jobs: queue }, tx, sourceId, 'webhook'),
    );
    let asked: string | null = null;
    await expect(
      ctx.db.transaction(async (tx) => {
        asked = await enqueueBacklogRefresh({ jobs: queue }, tx, sourceId, 'manual');
        throw new Error('roll back');
      }),
    ).rejects.toThrow('roll back');
    expect(asked).toBeTruthy();
    const jobs = await refreshJobs(sourceId);
    expect(jobs.find((job) => job.id === webhook)?.state).toBe('created');
    expect(jobs.some((job) => job.id === asked)).toBe(false);
    await boss.complete(BACKLOG_REFRESH, running as string);
    await boss.deleteJob(BACKLOG_REFRESH, webhook as string);
  });
});
