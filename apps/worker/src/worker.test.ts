import { randomUUID } from 'node:crypto';
import {
  INVITATIONS_EXPIRE,
  JOB_NAMES,
  REPOSITORY_EVENT,
  REPOSITORY_POLL,
  REPOSITORY_SYNC,
  TASKS_ARCHIVE_DUE,
} from '@zamu/core';
import { invitation, organization, user } from '@zamu/db';
import { createTestDatabase, type TestDatabase } from '@zamu/db/test';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { createLogger } from './logger';
import { startWorker, type Worker } from './worker';

// A fresh database, so the test also covers pg-boss creating its schema on first start.
let database: TestDatabase;
let worker: Worker | undefined;
const lines: Record<string, unknown>[] = [];
const logger = createLogger({ level: 'debug', write: (line) => lines.push(JSON.parse(line)) });
const messages = () => lines.map((line) => line.msg);

beforeAll(async () => {
  database = await createTestDatabase({ prefix: 'pm_worker_test' });
});

afterAll(async () => {
  await worker?.stop();
  await database?.drop();
});

async function waitForJob(id: string, timeoutMs = 15_000) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    const [job] = (await worker?.boss.findJobs(INVITATIONS_EXPIRE, { id })) ?? [];
    if (job && (job.state === 'completed' || job.state === 'failed')) return job;
    await new Promise((resolve) => setTimeout(resolve, 200));
  }
  throw new Error(`job ${id} did not finish within ${timeoutMs} ms`);
}

describe('startWorker', () => {
  it('creates the pg-boss schema, the queues and the daily schedule, then logs "worker ready"', async () => {
    const before = await database.pool.query(
      "SELECT 1 FROM information_schema.schemata WHERE schema_name = 'pgboss'",
    );
    expect(before.rowCount).toBe(0);

    worker = await startWorker({
      databaseUrl: database.url,
      logger,
      pollingIntervalSeconds: 0.5,
      shutdownTimeoutMs: 2_000,
      timeZone: 'Europe/Paris',
    });

    expect(messages()).toContain('worker ready');
    expect(await worker.boss.isInstalled()).toBe(true);
    for (const name of JOB_NAMES) expect(await worker.boss.getQueue(name)).not.toBeNull();

    const schedule = await worker.boss.getSchedule(INVITATIONS_EXPIRE);
    expect(schedule).toMatchObject({ name: INVITATIONS_EXPIRE, cron: '0 3 * * *', timezone: 'UTC' });
    const [next] = worker.boss.previewSchedule('0 3 * * *', { tz: 'UTC', count: 1 });
    expect(next?.toISOString()).toMatch(/T03:00:00\.000Z$/);
  });

  it('M7: registers the repository and archive jobs; the archive runs at 02:30 in APP_TIME_ZONE', async () => {
    if (!worker) throw new Error('worker not started');
    for (const name of [REPOSITORY_EVENT, REPOSITORY_SYNC, REPOSITORY_POLL, TASKS_ARCHIVE_DUE]) {
      expect(JOB_NAMES).toContain(name);
      expect(await worker.boss.getQueue(name)).not.toBeNull();
    }
    // repository.sync runs one check per link at a time.
    expect(await worker.boss.getQueue(REPOSITORY_SYNC)).toMatchObject({ policy: 'stately' });
    // Event and sync jobs are queued by the webhook, the poll and Check now, never on a schedule.
    expect(await worker.boss.getSchedule(REPOSITORY_EVENT)).toBeNull();
    expect(await worker.boss.getSchedule(REPOSITORY_SYNC)).toBeNull();

    const poll = await worker.boss.getSchedule(REPOSITORY_POLL);
    expect(poll).toMatchObject({ name: REPOSITORY_POLL, cron: '45 * * * *', timezone: 'UTC' });
    const archive = await worker.boss.getSchedule(TASKS_ARCHIVE_DUE);
    expect(archive).toMatchObject({ name: TASKS_ARCHIVE_DUE, cron: '30 2 * * *', timezone: 'Europe/Paris' });
    // 02:30 in Paris on a winter day is 01:30 UTC; on a summer day 00:30 UTC.
    const [winter] = worker.boss.previewSchedule('30 2 * * *', {
      tz: 'Europe/Paris',
      count: 1,
      from: new Date('2026-01-15T00:00:00Z'),
    });
    expect(winter?.toISOString()).toBe('2026-01-15T01:30:00.000Z');
    const [summer] = worker.boss.previewSchedule('30 2 * * *', {
      tz: 'Europe/Paris',
      count: 1,
      from: new Date('2026-07-15T00:00:00Z'),
    });
    expect(summer?.toISOString()).toBe('2026-07-15T00:30:00.000Z');
  });

  it('runs invitations.expire end to end and stores the output', async () => {
    if (!worker) throw new Error('worker not started');
    const suffix = randomUUID();
    const [inviter] = await worker.db
      .insert(user)
      .values({ name: 'Ada Admin', email: `ada-${suffix}@example.test` })
      .returning({ id: user.id });
    const [workspace] = await worker.db
      .insert(organization)
      .values({ name: 'Reddevs', slug: `reddevs-${suffix}` })
      .returning({ id: organization.id });
    if (!inviter || !workspace) throw new Error('fixture insert failed');
    await worker.db.insert(invitation).values({
      organizationId: workspace.id,
      inviterId: inviter.id,
      email: `invitee-${suffix}@example.test`,
      status: 'pending',
      expiresAt: new Date(Date.now() - 1_000),
    });

    const id = await worker.boss.send(INVITATIONS_EXPIRE, {});
    if (!id) throw new Error('job not sent');
    const job = await waitForJob(id);

    expect(job.state).toBe('completed');
    const { rows } = await worker.pool.query<{ status: string }>(
      'SELECT status FROM invitation WHERE organization_id = $1',
      [workspace.id],
    );
    expect(rows).toEqual([{ status: 'expired' }]);
    expect(lines).toContainEqual(
      expect.objectContaining({
        msg: 'job completed',
        job: INVITATIONS_EXPIRE,
        jobId: id,
        output: { expired: 1 },
      }),
    );
  });

  it('fails a job whose payload does not match the core schema', async () => {
    if (!worker) throw new Error('worker not started');
    const id = await worker.boss.send(INVITATIONS_EXPIRE, { now: 'yesterday' }, { retryLimit: 0 });
    if (!id) throw new Error('job not sent');

    const job = await waitForJob(id);

    expect(job.state).toBe('failed');
    expect(lines).toContainEqual(expect.objectContaining({ msg: 'job failed', jobId: id, level: 'error' }));
  });

  it('stops pg-boss and closes the pool, and a second stop() is a no-op', async () => {
    if (!worker) throw new Error('worker not started');
    await worker.stop();
    await worker.stop();

    expect(worker.pool.ended).toBe(true);
    expect(messages().filter((msg) => msg === 'worker stopped')).toHaveLength(1);
    worker = undefined;
  });

  it('closes everything and rethrows when pg-boss cannot start', async () => {
    const url = new URL(database.url);
    url.port = '1'; // nothing listens there
    const failed: Record<string, unknown>[] = [];

    await expect(
      startWorker({
        databaseUrl: url.toString(),
        logger: createLogger({ write: (line) => failed.push(JSON.parse(line)) }),
      }),
    ).rejects.toThrow();
    expect(failed.map((line) => line.msg)).not.toContain('worker ready');
  });
});
