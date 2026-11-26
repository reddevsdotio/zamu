// M7: the nightly tasks.archive-due job as the worker runs it. The worker hands APP_TIME_ZONE to
// core, so "N days after the task closed" counts calendar days in that zone: the same task is due
// at the same instant in UTC and not yet in New York.
import { randomUUID } from 'node:crypto';
import { TASKS_ARCHIVE_DUE } from '@zamu/core';
import { createTaskRow, createWorld } from '@zamu/core/testing/fixtures';
import { schema } from '@zamu/db';
import { createTestDatabase, type TestDatabase } from '@zamu/db/test';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { createLogger } from './logger';
import { runJob } from './run-job';

let database: TestDatabase;
const logger = createLogger({ write: () => {} });
const job = (data: unknown) => ({ id: randomUUID(), data, retryCount: 0 });

beforeAll(async () => {
  database = await createTestDatabase({ prefix: 'pm_worker_archive' });
  database.pool.on('error', () => {});
});

afterAll(async () => {
  await database?.drop();
});

async function archivedAt(taskId: string): Promise<Date | null> {
  const { rows } = await database.pool.query<{ archived_at: Date | null }>(
    'SELECT archived_at FROM task WHERE id = $1',
    [taskId],
  );
  return rows[0]?.archived_at ?? null;
}

describe('runJob tasks.archive-due', () => {
  it('counts the archive days in APP_TIME_ZONE', async () => {
    const world = await createWorld(database.db, 'Northwind');
    const [project] = await database.db
      .insert(schema.project)
      .values({ workspaceId: world.workspaceId, key: 'ARC', name: 'Archive', archiveAfterDays: 1 })
      .returning();
    if (!project) throw new Error('project insert failed');
    // Closed at noon UTC on Jan 15. One day later means from the start of Jan 16 where the team is.
    const task = await createTaskRow(database.db, project.id, {
      createdById: world.owner.id,
      status: 'done',
      closedAt: new Date('2030-01-15T12:00:00Z'),
    });
    // 00:30 UTC on Jan 16 is still Jan 15 (19:30) in New York.
    const now = '2030-01-16T00:30:00.000Z';

    const inNewYork = await runJob(TASKS_ARCHIVE_DUE, job({ now }), {
      db: database.db,
      logger,
      timeZone: 'America/New_York',
    });
    expect(inNewYork).toEqual({ archived: 0, projects: 0 });
    expect(await archivedAt(task.id)).toBeNull();

    const inUtc = await runJob(TASKS_ARCHIVE_DUE, job({ now }), { db: database.db, logger, timeZone: 'UTC' });
    expect(inUtc).toEqual({ archived: 1, projects: 1 });
    expect(await archivedAt(task.id)).toEqual(new Date(now));

    // Idempotent: the next run finds nothing.
    expect(await runJob(TASKS_ARCHIVE_DUE, job({ now }), { db: database.db, logger })).toEqual({
      archived: 0,
      projects: 0,
    });
  });
});
