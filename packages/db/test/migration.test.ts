// Upgrade paths: a database migrated and filled under an older release keeps every row through the
// later migrations, and each backfill fills what it should (M2 ranks in the M1 list order, M5 task
// fields from Backlog.md blocks, the M6 work record from mirrored descriptions, and in 0.10 the
// workspace each user used last and workspace slugs that fit the URL rules).
import { cpSync, mkdtempSync, readdirSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { sql } from 'drizzle-orm';
import { migrate as drizzleMigrate } from 'drizzle-orm/node-postgres/migrator';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { createDatabase, dropDatabase, withDatabase } from '../src/admin';
import { createDb, type Db } from '../src/client';
import { migrationsFolder } from '../src/migrate';
import { testServerUrl, uniqueDatabaseName } from './index';

const M1_MIGRATION = '20261022182359_init';

/** Applies the migrations in `folder` to the database at `url`. */
async function migrateFrom(url: string, folder: string) {
  const { db, pool } = createDb(url, { max: 1 });
  try {
    await drizzleMigrate(db, { migrationsFolder: folder });
  } finally {
    await pool.end();
  }
}

const TABLES = ['user', 'organization', 'member', 'project', 'task', 'activity'] as const;

async function rowCounts(db: Db) {
  const counts: Record<string, number> = {};
  for (const table of TABLES) {
    const result = await db.execute<{ count: number }>(
      sql`select count(*)::int as count from ${sql.identifier(table)}`,
    );
    counts[table] = result.rows[0]?.count ?? -1;
  }
  return counts;
}

/** Task ids per (project, status) in the M1 list order: priority desc, updated_at desc, id desc. */
async function m1Order(db: Db) {
  const result = await db.execute<{ id: string; project_id: string; status: string }>(sql`
    select id, project_id, status::text as status from task
    order by project_id, status, priority desc, updated_at desc, id desc`);
  const groups = new Map<string, string[]>();
  for (const row of result.rows) {
    const group = `${row.project_id}/${row.status}`;
    groups.set(group, [...(groups.get(group) ?? []), row.id]);
  }
  return groups;
}

describe('M2 migration on an M1 database with data', () => {
  let url: string;
  let m1Folder: string;
  let db: Db;
  let end: () => Promise<void>;

  beforeAll(async () => {
    m1Folder = mkdtempSync(join(tmpdir(), 'zamu-m1-migrations-'));
    cpSync(join(migrationsFolder, M1_MIGRATION), join(m1Folder, M1_MIGRATION), { recursive: true });
    url = withDatabase(testServerUrl(), uniqueDatabaseName('pm_test_upgrade'));
    await createDatabase(url);
    await migrateFrom(url, m1Folder);
    const handle = createDb(url);
    db = handle.db;
    end = () => handle.pool.end();
  });

  afterAll(async () => {
    await end?.();
    if (url) await dropDatabase(url);
    if (m1Folder) rmSync(m1Folder, { recursive: true, force: true });
  });

  it('keeps every row and backfills rank in the M1 list order', async () => {
    expect(readdirSync(migrationsFolder).length).toBeGreaterThan(1);

    // M1 data, written with raw SQL against the M1 schema (the Drizzle schema already has M2 columns).
    await db.execute(sql`
      insert into "user" (id, name, email) values
        ('0190a1b2-0000-7000-8000-0000000000a1', 'Ana', 'ana@example.com'),
        ('0190a1b2-0000-7000-8000-0000000000a2', 'claude-dev', 'claude-dev@agents.invalid')`);
    await db.execute(sql`update "user" set kind = 'agent', responsible_user_id = '0190a1b2-0000-7000-8000-0000000000a1'
      where id = '0190a1b2-0000-7000-8000-0000000000a2'`);
    await db.execute(sql`
      insert into organization (id, name, slug) values ('0190a1b2-0000-7000-8000-0000000000b1', 'Reddevs', 'reddevs')`);
    await db.execute(sql`
      insert into member (organization_id, user_id, role) values
        ('0190a1b2-0000-7000-8000-0000000000b1', '0190a1b2-0000-7000-8000-0000000000a1', 'owner'),
        ('0190a1b2-0000-7000-8000-0000000000b1', '0190a1b2-0000-7000-8000-0000000000a2', 'member')`);
    await db.execute(sql`
      insert into project (id, workspace_id, key, name, next_task_number) values
        ('0190a1b2-0000-7000-8000-0000000000c1', '0190a1b2-0000-7000-8000-0000000000b1', 'PAY', 'Payments', 41),
        ('0190a1b2-0000-7000-8000-0000000000c2', '0190a1b2-0000-7000-8000-0000000000b1', 'WEB', 'Website', 1)`);

    // 40 PAY tasks spread over every status, with repeated priorities and timestamps so the
    // updated_at and id tie-breakers matter. WEB stays empty.
    const statuses = ['backlog', 'todo', 'in_progress', 'in_review', 'done', 'canceled'];
    for (let number = 1; number <= 40; number++) {
      const status = statuses[number % statuses.length];
      const priority = number % 5;
      const day = 1 + (number % 4);
      await db.execute(sql`
        insert into task (project_id, number, title, status, priority, assignee_id, created_by_id, updated_at)
        values ('0190a1b2-0000-7000-8000-0000000000c1', ${number}, ${`Task ${number}`}, ${status}::task_status,
          ${priority}, ${number % 3 === 0 ? '0190a1b2-0000-7000-8000-0000000000a2' : null},
          '0190a1b2-0000-7000-8000-0000000000a1', ${`2026-10-0${day}T12:00:00.123456Z`}::timestamptz)`);
    }
    await db.execute(sql`
      insert into activity (workspace_id, project_id, task_id, actor_id, on_behalf_of_id, type, changes)
      select '0190a1b2-0000-7000-8000-0000000000b1', project_id, id, '0190a1b2-0000-7000-8000-0000000000a2',
        '0190a1b2-0000-7000-8000-0000000000a1', 'task.created', '[{"field":"title","from":null,"to":"x"}]'::jsonb
      from task`);

    const countsBefore = await rowCounts(db);
    const orderBefore = await m1Order(db);
    const updatedBefore = await db.execute<{ id: string; updated_at: string }>(
      sql`select id, updated_at::text as updated_at from task order by id`,
    );

    await migrateFrom(url, migrationsFolder);

    expect(await rowCounts(db)).toEqual(countsBefore);
    expect(countsBefore.task).toBe(40);

    // Each status column numbers 1..n in the M1 order.
    const ranks = await db.execute<{ id: string; project_id: string; status: string; rank: number }>(sql`
      select id, project_id, status::text as status, rank from task order by project_id, status, rank`);
    const orderAfter = new Map<string, string[]>();
    for (const row of ranks.rows) {
      const group = `${row.project_id}/${row.status}`;
      const ids = [...(orderAfter.get(group) ?? []), row.id];
      orderAfter.set(group, ids);
      expect(row.rank).toBe(ids.length);
    }
    expect(orderAfter).toEqual(orderBefore);

    // The backfill leaves updated_at alone (it carries microseconds; compare as text).
    const updatedAfter = await db.execute<{ id: string; updated_at: string }>(
      sql`select id, updated_at::text as updated_at from task order by id`,
    );
    expect(updatedAfter.rows).toEqual(updatedBefore.rows);

    const projects = await db.execute<{
      uses_milestones: boolean;
      uses_cycles: boolean;
      next_cycle_number: number;
    }>(sql`select uses_milestones, uses_cycles, next_cycle_number from project`);
    expect(projects.rows).toEqual([
      { uses_milestones: true, uses_cycles: true, next_cycle_number: 1 },
      { uses_milestones: true, uses_cycles: true, next_cycle_number: 1 },
    ]);

    const tasks = await db.execute<{ empty: number }>(sql`
      select count(*)::int as empty from task
      where milestone_id is null and cycle_id is null and cycle_added_at is null`);
    expect(tasks.rows[0]?.empty).toBe(40);

    const themes = await db.execute<{ theme: string }>(sql`select distinct theme from "user"`);
    expect(themes.rows).toEqual([{ theme: 'system' }]);

    const actors = await db.execute<{ missing: number }>(
      sql`select count(*)::int as missing from activity where actor_id is null`,
    );
    expect(actors.rows[0]?.missing).toBe(0);
  });
});

const M2_1_MIGRATIONS = [
  '20261022182359_init',
  '20261023083529_m2_work_views',
  '20261023144736_m2_1_project_repository',
];

describe('M3 migration on an M2.1 database with data', () => {
  let url: string;
  let folder: string;
  let db: Db;
  let end: () => Promise<void>;

  const OWNER = '0190a1b2-0000-7000-8000-0000000000a1';
  const WORKSPACE = '0190a1b2-0000-7000-8000-0000000000b1';
  const PAY = '0190a1b2-0000-7000-8000-0000000000c1';
  const WEB = '0190a1b2-0000-7000-8000-0000000000c2';

  beforeAll(async () => {
    folder = mkdtempSync(join(tmpdir(), 'zamu-m2-1-migrations-'));
    for (const name of M2_1_MIGRATIONS) {
      cpSync(join(migrationsFolder, name), join(folder, name), { recursive: true });
    }
    url = withDatabase(testServerUrl(), uniqueDatabaseName('pm_test_upgrade_m3'));
    await createDatabase(url);
    await migrateFrom(url, folder);
    const handle = createDb(url);
    db = handle.db;
    end = () => handle.pool.end();
  });

  afterAll(async () => {
    await end?.();
    if (url) await dropDatabase(url);
    if (folder) rmSync(folder, { recursive: true, force: true });
  });

  /** Task keys as M2.1 builds them: project key, dash, number. */
  async function keys() {
    const result = await db.execute<{ key: string }>(sql`
      select p.key || '-' || t.number as key from task t join project p on p.id = t.project_id
      order by p.key, t.number`);
    return result.rows.map((row) => row.key);
  }

  async function insertTask(projectId: string, number: number, keySuffix?: string) {
    if (keySuffix === undefined) {
      return db.execute(sql`insert into task (project_id, number, title, created_by_id)
        values (${projectId}, ${number}, ${`Task ${number}`}, ${OWNER})`);
    }
    return db.execute(sql`insert into task (project_id, number, key_suffix, title, created_by_id)
      values (${projectId}, ${number}, ${keySuffix}, ${`Task ${number}.${keySuffix}`}, ${OWNER})`);
  }

  async function pgCode(promise: Promise<unknown>): Promise<string | undefined> {
    try {
      await promise;
    } catch (error) {
      const cause = (error as { cause?: { code?: string } }).cause;
      return cause?.code ?? (error as { code?: string }).code;
    }
    return undefined;
  }

  it('keeps every task key, row and activity, and the one-task-per-number rule', async () => {
    // M2.1 data, written with raw SQL against the M2.1 schema.
    await db.execute(sql`insert into "user" (id, name, email) values (${OWNER}, 'Ana', 'ana@example.com')`);
    await db.execute(
      sql`insert into organization (id, name, slug) values (${WORKSPACE}, 'Reddevs', 'reddevs')`,
    );
    await db.execute(
      sql`insert into member (organization_id, user_id, role) values (${WORKSPACE}, ${OWNER}, 'owner')`,
    );
    await db.execute(sql`
      insert into project (id, workspace_id, key, name, next_task_number, repository, repository_key) values
        (${PAY}, ${WORKSPACE}, 'PAY', 'Payments', 26, 'git@gitlab.com:reddevs/payments.git', 'gitlab.com/reddevs/payments'),
        (${WEB}, ${WORKSPACE}, 'WEB', 'Website', 4, null, null)`);
    for (let number = 1; number <= 25; number++) await insertTask(PAY, number);
    for (let number = 1; number <= 3; number++) await insertTask(WEB, number);
    await db.execute(sql`
      insert into activity (workspace_id, project_id, task_id, actor_id, type, changes)
      select ${WORKSPACE}, project_id, id, ${OWNER}, 'task.created', '[]'::jsonb from task`);
    await db.execute(sql`
      insert into activity (workspace_id, project_id, task_id, actor_id, type, changes)
      select ${WORKSPACE}, project_id, id, null, 'cycle.ended', '[{"field":"cycle","from":null,"to":null}]'::jsonb
      from task where number = 1`);

    const keysBefore = await keys();
    const counts = await rowCounts(db);

    await migrateFrom(url, migrationsFolder);

    expect(await keys()).toEqual(keysBefore);
    expect(keysBefore).toHaveLength(28);
    expect(await rowCounts(db)).toEqual(counts);

    const tasks = await db.execute<{ untouched: number }>(sql`
      select count(*)::int as untouched from task
      where key_suffix is null and backlog_id is null and backlog_data is null and hidden_at is null`);
    expect(tasks.rows[0]?.untouched).toBe(28);

    const origins = await db.execute<{ origin: string; origin_ref: string | null; count: number }>(sql`
      select origin, origin_ref, count(*)::int as count from activity group by origin, origin_ref`);
    expect(origins.rows).toEqual([{ origin: 'app', origin_ref: null, count: 30 }]);

    const milestones = await db.execute<{ count: number }>(
      sql`select count(*)::int as count from milestone where backlog_id is not null or hidden_at is not null`,
    );
    expect(milestones.rows[0]?.count).toBe(0);

    // Old rule: one task per number in a project, numbers repeat across projects.
    expect(await pgCode(insertTask(PAY, 1))).toBe('23505');
    await insertTask(WEB, 25);

    // New rule: subtasks share the number with distinct suffixes; the same suffix twice is refused.
    await insertTask(PAY, 7, '1');
    await insertTask(PAY, 7, '2');
    await insertTask(PAY, 7, '1.2');
    expect(await pgCode(insertTask(PAY, 7, '1'))).toBe('23505');
    expect(await pgCode(insertTask(PAY, 7, '0'))).toBe('23514');
    expect(await pgCode(insertTask(PAY, 7, '1.'))).toBe('23514');
    expect(await pgCode(insertTask(PAY, 7, '01'))).toBe('23514');

    const index = await db.execute<{ indexname: string }>(
      sql`select indexname from pg_indexes where tablename = 'task' and indexname = 'task_projectId_number_unique'`,
    );
    expect(index.rows).toEqual([]);
  });
});

/** Every migration released in 0.6.0, the last release before M5. */
const V0_6_0_MIGRATIONS = [
  '20261022182359_init',
  '20261023083529_m2_work_views',
  '20261023144736_m2_1_project_repository',
  '20261023164304_m3_backlog_md',
  '20261027182340_dashboard_indexes',
];

describe('M5 migration on a 0.6.0 database with data', () => {
  let url: string;
  let folder: string;
  let db: Db;
  let end: () => Promise<void>;

  const OWNER = '0190a1b2-0000-7000-8000-0000000000a1';
  const AGENT = '0190a1b2-0000-7000-8000-0000000000a2';
  const WORKSPACE = '0190a1b2-0000-7000-8000-0000000000b1';
  const PAY = '0190a1b2-0000-7000-8000-0000000000c1';
  const WEB = '0190a1b2-0000-7000-8000-0000000000c2';
  const MILESTONE = '0190a1b2-0000-7000-8000-0000000000d1';

  beforeAll(async () => {
    folder = mkdtempSync(join(tmpdir(), 'zamu-0-6-0-migrations-'));
    for (const name of V0_6_0_MIGRATIONS) {
      cpSync(join(migrationsFolder, name), join(folder, name), { recursive: true });
    }
    url = withDatabase(testServerUrl(), uniqueDatabaseName('pm_test_upgrade_m5'));
    await createDatabase(url);
    await migrateFrom(url, folder);
    const handle = createDb(url);
    db = handle.db;
    end = () => handle.pool.end();
  });

  afterAll(async () => {
    await end?.();
    if (url) await dropDatabase(url);
    if (folder) rmSync(folder, { recursive: true, force: true });
  });

  /** Every task column 0.6.0 had, as text, so the comparison is exact. */
  async function taskRows() {
    const result = await db.execute<Record<string, string | null>>(sql`
      select id, project_id, number::text, key_suffix, backlog_id, backlog_data::text, hidden_at::text,
        title, description, status::text, priority::text, assignee_id, created_by_id, milestone_id,
        cycle_id, cycle_added_at::text, rank::text, created_at::text, updated_at::text
      from task order by id`);
    return result.rows;
  }

  async function count(table: string) {
    const result = await db.execute<{ count: number }>(
      sql`select count(*)::int as count from ${sql.identifier(table)}`,
    );
    return result.rows[0]?.count ?? -1;
  }

  async function pgCode(promise: Promise<unknown>): Promise<string | undefined> {
    try {
      await promise;
    } catch (error) {
      const cause = (error as { cause?: { code?: string } }).cause;
      return cause?.code ?? (error as { code?: string }).code;
    }
    return undefined;
  }

  it('keeps every task as it was, adds empty fields, and enforces the new rules', async () => {
    // 0.6.0 data, written with raw SQL against the 0.6.0 schema. Native tasks only: the mirror
    // backfill that follows this migration has nothing to fill for them.
    await db.execute(sql`insert into "user" (id, name, email) values
      (${OWNER}, 'Ana', 'ana@example.com'), (${AGENT}, 'claude-dev', 'claude-dev@agents.invalid')`);
    await db.execute(
      sql`update "user" set kind = 'agent', responsible_user_id = ${OWNER} where id = ${AGENT}`,
    );
    await db.execute(
      sql`insert into organization (id, name, slug) values (${WORKSPACE}, 'Reddevs', 'reddevs')`,
    );
    await db.execute(sql`insert into member (organization_id, user_id, role) values
      (${WORKSPACE}, ${OWNER}, 'owner'), (${WORKSPACE}, ${AGENT}, 'member')`);
    await db.execute(sql`insert into project (id, workspace_id, key, name, next_task_number) values
      (${PAY}, ${WORKSPACE}, 'PAY', 'Payments', 31), (${WEB}, ${WORKSPACE}, 'WEB', 'Website', 6)`);
    await db.execute(sql`insert into milestone (id, workspace_id, project_id, name, target_date, created_by_id)
      values (${MILESTONE}, ${WORKSPACE}, ${PAY}, 'Payouts v2', '2026-11-20', ${OWNER})`);
    const statuses = ['backlog', 'todo', 'in_progress', 'in_review', 'done', 'canceled'];
    for (let number = 1; number <= 30; number++) {
      await db.execute(sql`
        insert into task (project_id, number, title, status, priority, assignee_id, created_by_id,
          milestone_id, rank, updated_at)
        values (${PAY}, ${number}, ${`Task ${number}`}, ${statuses[number % 6]}::task_status, ${number % 5},
          ${number % 2 === 0 ? AGENT : null}, ${OWNER}, ${number % 3 === 0 ? MILESTONE : null}, ${number},
          ${`2026-10-${10 + (number % 9)}T08:00:00.654321Z`}::timestamptz)`);
    }
    for (let number = 1; number <= 5; number++) {
      await db.execute(sql`insert into task (project_id, number, title, created_by_id)
        values (${WEB}, ${number}, ${`Page ${number}`}, ${OWNER})`);
    }
    await db.execute(sql`
      insert into activity (workspace_id, project_id, task_id, actor_id, on_behalf_of_id, type, changes)
      select ${WORKSPACE}, project_id, id, ${AGENT}, ${OWNER}, 'task.updated',
        '[{"field":"status","from":"todo","to":"in_progress"}]'::jsonb
      from task`);
    await db.execute(sql`
      insert into comment (workspace_id, project_id, task_id, author_id, body)
      select ${WORKSPACE}, project_id, id, ${OWNER}, 'Looks good' from task where number <= 3`);

    const tasksBefore = await taskRows();
    const counts = await rowCounts(db);
    const commentsBefore = await count('comment');

    await migrateFrom(url, migrationsFolder);

    expect(await taskRows()).toEqual(tasksBefore);
    expect(tasksBefore).toHaveLength(35);
    expect(await rowCounts(db)).toEqual(counts);
    expect(await count('comment')).toBe(commentsBefore);

    const empty = await db.execute<{ count: number }>(
      sql`select count(*)::int as count from task where due_date is null and parent_id is null`,
    );
    expect(empty.rows[0]?.count).toBe(35);
    expect(await count('label')).toBe(0);
    expect(await count('task_label')).toBe(0);
    expect(await count('task_dependency')).toBe(0);

    // The new fields work on upgraded rows.
    const ids = await db.execute<{ id: string; number: number; project_id: string }>(
      sql`select id, number, project_id from task where number <= 3 order by project_id, number`,
    );
    const [pay1, pay2, pay3, web1] = ids.rows;
    if (!pay1 || !pay2 || !pay3 || !web1) throw new Error('missing upgraded tasks');

    await db.execute(
      sql`update task set due_date = '2026-11-14', parent_id = ${pay1.id} where id = ${pay2.id}`,
    );
    expect(await pgCode(db.execute(sql`update task set parent_id = id where id = ${pay3.id}`))).toBe('23514');

    await db.execute(sql`insert into label (workspace_id, project_id, name, color) values
      (${WORKSPACE}, ${PAY}, 'payouts', 1), (${WORKSPACE}, ${WEB}, 'payouts', 2)`);
    expect(
      await pgCode(
        db.execute(sql`insert into label (workspace_id, project_id, name, color)
          values (${WORKSPACE}, ${PAY}, 'PAYOUTS', 3)`),
      ),
    ).toBe('23505');
    await db.execute(sql`insert into task_label (task_id, label_id)
      select ${pay1.id}, id from label where project_id = ${PAY}`);

    await db.execute(sql`insert into task_dependency (task_id, blocker_id) values (${pay3.id}, ${pay1.id})`);
    expect(
      await pgCode(
        db.execute(sql`insert into task_dependency (task_id, blocker_id) values (${pay3.id}, ${pay3.id})`),
      ),
    ).toBe('23514');

    // Deleting the parent and blocker clears both links; the label link goes with the task.
    await db.execute(sql`delete from task where id = ${pay1.id}`);
    const child = await db.execute<{ parent_id: string | null; due_date: string | null }>(
      sql`select parent_id, due_date::text from task where id = ${pay2.id}`,
    );
    expect(child.rows).toEqual([{ parent_id: null, due_date: '2026-11-14' }]);
    expect(await count('task_dependency')).toBe(0);
    expect(await count('task_label')).toBe(0);
    expect(await count('label')).toBe(2);
  });
});

describe('M5 mirror backfill on a 0.6.0 database with Backlog.md tasks', () => {
  let url: string;
  let folder: string;
  let db: Db;
  let end: () => Promise<void>;

  const OWNER = '0190a1b2-0000-7000-8000-0000000001a1';
  const WORKSPACE = '0190a1b2-0000-7000-8000-0000000001b1';
  const PAY = '0190a1b2-0000-7000-8000-0000000001c1';
  const OLD = '0190a1b2-0000-7000-8000-0000000001c2';
  const NAT = '0190a1b2-0000-7000-8000-0000000001c3';
  const M5_TASK_FIELDS = '20261104104246_m5_task_fields';

  beforeAll(async () => {
    folder = mkdtempSync(join(tmpdir(), 'zamu-0-6-0-backfill-'));
    for (const name of V0_6_0_MIGRATIONS) {
      cpSync(join(migrationsFolder, name), join(folder, name), { recursive: true });
    }
    url = withDatabase(testServerUrl(), uniqueDatabaseName('pm_test_upgrade_m5_backfill'));
    await createDatabase(url);
    await migrateFrom(url, folder);
    const handle = createDb(url);
    db = handle.db;
    end = () => handle.pool.end();
  });

  afterAll(async () => {
    await end?.();
    if (url) await dropDatabase(url);
    if (folder) rmSync(folder, { recursive: true, force: true });
  });

  /** Inserts a task with a Backlog.md block; returns its id. */
  async function mirrored(
    projectId: string,
    number: number,
    suffix: string | null,
    backlogId: string,
    block: Record<string, unknown>,
    hidden = false,
  ): Promise<string> {
    const result = await db.execute<{ id: string }>(sql`
      insert into task (project_id, number, key_suffix, backlog_id, backlog_data, hidden_at, title,
        created_by_id, updated_at)
      values (${projectId}, ${number}, ${suffix}, ${backlogId}, ${JSON.stringify(block)}::jsonb,
        ${hidden ? '2026-10-30T09:00:00Z' : null}::timestamptz, ${backlogId}, ${OWNER},
        '2026-10-20T08:00:00.123456Z'::timestamptz)
      returning id`);
    return result.rows[0]?.id as string;
  }

  async function rows(query: ReturnType<typeof sql>) {
    const result = await db.execute<Record<string, unknown>>(query);
    return result.rows;
  }

  it('fills labels, due dates, parents and blockers from task.backlog_data, with no activity', async () => {
    await db.execute(
      sql`insert into "user" (id, name, email) values (${OWNER}, 'Ana', 'ana-m5@example.com')`,
    );
    await db.execute(
      sql`insert into organization (id, name, slug) values (${WORKSPACE}, 'Reddevs', 'reddevs-m5')`,
    );
    await db.execute(
      sql`insert into member (organization_id, user_id, role) values (${WORKSPACE}, ${OWNER}, 'owner')`,
    );
    await db.execute(sql`insert into project (id, workspace_id, key, name, next_task_number) values
      (${PAY}, ${WORKSPACE}, 'PAY', 'Payments', 6), (${OLD}, ${WORKSPACE}, 'OLD', 'Imported', 2),
      (${NAT}, ${WORKSPACE}, 'NAT', 'Native', 2)`);
    // PAY mirrors; OLD was imported (an import detaches after its first read).
    await db.execute(sql`insert into backlog_source (project_id, mode, state, webhook_id, created_by_id, detached_at)
      values (${PAY}, 'mirror', 'healthy', 'wh-pay', ${OWNER}, null),
        (${OLD}, 'import', 'detached', 'wh-old', ${OWNER}, '2026-10-25T10:00:00Z')`);

    const back1 = await mirrored(PAY, 1, null, 'BACK-1', {
      labels: ['API', 'backend', 'Api', 'x'.repeat(41)],
      dueDate: '2026-11-20',
      dependencies: ['BACK-2', 'BACK-99', 'BACK-1', 'BACK-2'],
      parentId: null,
    });
    const back2 = await mirrored(PAY, 2, null, 'BACK-2', { labels: ['api'], dueDate: '2026-02-30' });
    const back21 = await mirrored(PAY, 2, '1', 'BACK-2.1', {
      parentId: 'BACK-2',
      dueDate: '2026-12-01 10:00',
    });
    // Hidden (its file is gone): backfilled too.
    const back3 = await mirrored(
      PAY,
      3,
      null,
      'BACK-3',
      { labels: ['ops'], dependencies: ['BACK-1'], parentId: 'BACK-1', dueDate: '2026-11-01' },
      true,
    );
    const back4 = await mirrored(PAY, 4, null, 'BACK-4', { parentId: 'BACK-4', dueDate: '0000-01-01' });
    const back5 = await mirrored(PAY, 5, null, 'BACK-5', {});
    const old1 = await mirrored(OLD, 1, null, 'BACK-1', { labels: ['legacy'], dueDate: '2026-10-01' });
    await db.execute(
      sql`insert into task (project_id, number, title, created_by_id) values (${NAT}, 1, 'Native', ${OWNER})`,
    );
    await db.execute(sql`
      insert into activity (workspace_id, project_id, task_id, actor_id, type, changes, origin)
      select ${WORKSPACE}, project_id, id, null, 'task.created', '[]'::jsonb, 'backlog' from task`);

    // Upgrade in two steps, so PAY can have an app label named like a file's label (ignoring case).
    cpSync(join(migrationsFolder, M5_TASK_FIELDS), join(folder, M5_TASK_FIELDS), { recursive: true });
    await migrateFrom(url, folder);
    await db.execute(sql`insert into label (workspace_id, project_id, name, color, source)
      values (${WORKSPACE}, ${PAY}, 'Backend', 1, 'app')`);
    const updatedBefore = await rows(sql`select id, updated_at::text from task order by id`);
    const activityBefore = await rows(sql`select count(*)::int as count from activity`);

    await migrateFrom(url, migrationsFolder);

    expect(await rows(sql`select id, updated_at::text from task order by id`)).toEqual(updatedBefore);
    expect(await rows(sql`select count(*)::int as count from activity`)).toEqual(activityBefore);

    // Labels: Backend reused (name kept, locked now); API created once with the least used hue,
    // named after the first spelling in code point order; the 41-character name is left out.
    // OLD is detached, so its labels are app labels.
    expect(
      await rows(sql`select p.key, l.name, l.color, l.source from label l join project p on p.id = l.project_id
        order by p.key, l.name`),
    ).toEqual([
      { key: 'OLD', name: 'legacy', color: 1, source: 'app' },
      { key: 'PAY', name: 'API', color: 2, source: 'backlog' },
      { key: 'PAY', name: 'Backend', color: 1, source: 'backlog' },
      { key: 'PAY', name: 'ops', color: 3, source: 'backlog' },
    ]);
    expect(
      await rows(sql`select t.id as task, l.name from task_label tl join task t on t.id = tl.task_id
        join label l on l.id = tl.label_id order by t.id, l.name`),
    ).toEqual(
      [
        { task: back1, name: 'API' },
        { task: back1, name: 'Backend' },
        { task: back2, name: 'API' },
        { task: back3, name: 'ops' },
        { task: old1, name: 'legacy' },
      ].sort((a, b) => (a.task === b.task ? (a.name < b.name ? -1 : 1) : a.task < b.task ? -1 : 1)),
    );

    // Due dates: real days only. Parents and blockers: same-project lookups by backlog_id; unknown
    // ids and the task itself are left out; the hidden task keeps its links.
    expect(
      await rows(sql`select id, due_date::text as due, parent_id as parent from task
        where backlog_id is not null order by id`),
    ).toEqual(
      [
        { id: back1, due: '2026-11-20', parent: null },
        { id: back2, due: null, parent: null },
        { id: back21, due: null, parent: back2 },
        { id: back3, due: '2026-11-01', parent: back1 },
        { id: back4, due: null, parent: null },
        { id: back5, due: null, parent: null },
        { id: old1, due: '2026-10-01', parent: null },
      ].sort((a, b) => (a.id < b.id ? -1 : 1)),
    );
    expect(
      await rows(
        sql`select task_id as task, blocker_id as blocker from task_dependency order by task_id, blocker_id`,
      ),
    ).toEqual(
      [
        { task: back1, blocker: back2 },
        { task: back3, blocker: back1 },
      ].sort((a, b) => (a.task < b.task ? -1 : 1)),
    );
    expect(
      await rows(sql`select count(*)::int as count from task where project_id = ${NAT}
        and (due_date is not null or parent_id is not null)`),
    ).toEqual([{ count: 0 }]);
  });
});

/** Every migration released in 0.8.0, the last release before M6. */
const V0_8_0_MIGRATIONS = [
  ...V0_6_0_MIGRATIONS,
  '20261104104246_m5_task_fields',
  '20261104110039_m5_backfill_mirrors',
];

describe('M6 work record migration on a 0.8.0 database with a mirrored project', () => {
  let url: string;
  let folder: string;
  let db: Db;
  let end: () => Promise<void>;

  const OWNER = '0190a1b2-0000-7000-8000-0000000002a1';
  const WORKSPACE = '0190a1b2-0000-7000-8000-0000000002b1';
  const PAY = '0190a1b2-0000-7000-8000-0000000002c1';
  const OLD = '0190a1b2-0000-7000-8000-0000000002c2';
  const NAT = '0190a1b2-0000-7000-8000-0000000002c3';

  beforeAll(async () => {
    folder = mkdtempSync(join(tmpdir(), 'zamu-0-8-0-migrations-'));
    for (const name of V0_8_0_MIGRATIONS) {
      cpSync(join(migrationsFolder, name), join(folder, name), { recursive: true });
    }
    url = withDatabase(testServerUrl(), uniqueDatabaseName('pm_test_upgrade_m6'));
    await createDatabase(url);
    await migrateFrom(url, folder);
    const handle = createDb(url);
    db = handle.db;
    end = () => handle.pool.end();
  });

  afterAll(async () => {
    await end?.();
    if (url) await dropDatabase(url);
    if (folder) rmSync(folder, { recursive: true, force: true });
  });

  async function rows(query: ReturnType<typeof sql>) {
    const result = await db.execute<Record<string, unknown>>(query);
    return result.rows;
  }

  /** Inserts a task as 0.8.0 wrote it; returns its id. */
  async function insertTask(
    projectId: string,
    number: number,
    description: string | null,
    block: Record<string, unknown> | null,
    hidden = false,
  ): Promise<string> {
    const result = await db.execute<{ id: string }>(sql`
      insert into task (project_id, number, backlog_id, backlog_data, hidden_at, title, description,
        created_by_id, updated_at)
      values (${projectId}, ${number}, ${block ? `BACK-${number}` : null},
        ${block ? JSON.stringify(block) : null}::jsonb, ${hidden ? '2026-10-30T09:00:00Z' : null}::timestamptz,
        ${`Task ${number}`}, ${description}, ${OWNER}, '2026-10-20T08:00:00.123456Z'::timestamptz)
      returning id`);
    return result.rows[0]?.id as string;
  }

  // A description as the 0.8.0 refresh rendered it from a Backlog.md file: the Description section,
  // then the other sections under fixed headings. Headings and checkboxes inside fences are content.
  const RENDERED = [
    'Payouts settle nightly through the ledger.',
    '',
    '```sh',
    '## Final summary',
    '- [ ] not an item',
    '```',
    '',
    '## Acceptance criteria',
    '',
    '- [x] #1 Refunds post a ledger entry',
    '- [ ] #2 Webhook retries back off',
    'Items checked by the reviewer only.',
    '~~~',
    '- [ ] #9 sample inside a fence',
    '~~~',
    '- [ ] #4   Payout report lists fees  ',
    '- [ ]   ',
    '',
    '## Definition of done',
    '',
    '- [ ] #1 Tests pass',
    '- [X] #2 Docs updated',
    '',
    '## Implementation plan',
    '',
    '1. Add the ledger table',
    '2. Wire the webhook',
    '',
    '## Implementation notes',
    '',
    'Started with the ledger.',
    '',
    '## Comments from Backlog.md',
    '',
    '**@ana** · 2026-10-20 10:00',
    '',
    'Looks right.',
    '',
    '## Final summary',
    '',
    'Refunds write a ledger entry; retries back off.',
  ].join('\n');

  it('moves criteria, done items, plan, notes and summary out of the description, with no activity', async () => {
    await db.execute(
      sql`insert into "user" (id, name, email) values (${OWNER}, 'Ana', 'ana-m6@example.com')`,
    );
    await db.execute(
      sql`insert into organization (id, name, slug) values (${WORKSPACE}, 'Reddevs', 'reddevs-m6')`,
    );
    await db.execute(
      sql`insert into member (organization_id, user_id, role) values (${WORKSPACE}, ${OWNER}, 'owner')`,
    );
    await db.execute(sql`insert into project (id, workspace_id, key, name, next_task_number) values
      (${PAY}, ${WORKSPACE}, 'PAY', 'Payments', 5), (${OLD}, ${WORKSPACE}, 'OLD', 'Imported', 2),
      (${NAT}, ${WORKSPACE}, 'NAT', 'Native', 2)`);
    // PAY mirrors; OLD was imported (an import detaches after its first read).
    await db.execute(sql`insert into backlog_source (project_id, mode, state, webhook_id, created_by_id, detached_at)
      values (${PAY}, 'mirror', 'healthy', 'wh-pay-m6', ${OWNER}, null),
        (${OLD}, 'import', 'detached', 'wh-old-m6', ${OWNER}, '2026-10-25T10:00:00Z')`);

    const back1 = await insertTask(PAY, 1, RENDERED, { labels: ['payouts'], type: 'feature' });
    // Hidden (its file is gone): backfilled too. Only a checklist: the description empties.
    const back2 = await insertTask(PAY, 2, '## Acceptance criteria\n\n- [ ] #1 Hidden item', {}, true);
    const back3 = await insertTask(PAY, 3, 'Plain text, no sections.', {});
    const back4 = await insertTask(PAY, 4, null, {});
    const old1 = await insertTask(
      OLD,
      1,
      'Intro\n\n## Acceptance criteria\n\n- [x] Old item\n\n## Final summary\n\nShipped.',
      {},
    );
    // A native task: never touched, even with the same headings.
    const nat1 = await insertTask(NAT, 1, '## Acceptance criteria\n\n- [ ] #1 Native text', null);
    await db.execute(sql`
      insert into activity (workspace_id, project_id, task_id, actor_id, type, changes, origin)
      select ${WORKSPACE}, project_id, id, null, 'task.created', '[]'::jsonb, 'backlog' from task`);
    await db.execute(sql`
      insert into comment (workspace_id, project_id, task_id, author_id, body)
      select ${WORKSPACE}, project_id, id, ${OWNER}, 'Looks good' from task where number = 1`);

    const updatedBefore = await rows(sql`select id, updated_at::text from task order by id`);
    const activityBefore = await rows(sql`select id, changes::text from activity order by id`);

    await migrateFrom(url, migrationsFolder);

    expect(await rows(sql`select id, updated_at::text from task order by id`)).toEqual(updatedBefore);
    expect(await rows(sql`select id, changes::text from activity order by id`)).toEqual(activityBefore);

    // Items: numbered in file order from 1 per kind, text trimmed, empty and fenced lines left out.
    expect(
      await rows(sql`select task_id as task, kind, position, text, state, source, waived_reason
        from task_item order by task_id, kind, position`),
    ).toEqual(
      [
        {
          task: back1,
          kind: 'criterion',
          position: 1,
          text: 'Refunds post a ledger entry',
          state: 'checked',
        },
        { task: back1, kind: 'criterion', position: 2, text: 'Webhook retries back off', state: 'open' },
        { task: back1, kind: 'criterion', position: 3, text: 'Payout report lists fees', state: 'open' },
        { task: back1, kind: 'done', position: 1, text: 'Tests pass', state: 'open' },
        { task: back1, kind: 'done', position: 2, text: 'Docs updated', state: 'checked' },
        { task: back2, kind: 'criterion', position: 1, text: 'Hidden item', state: 'open' },
        { task: old1, kind: 'criterion', position: 1, text: 'Old item', state: 'checked', source: 'app' },
      ]
        .map((item) => ({ source: 'backlog', waived_reason: null, ...item }))
        .sort((a, b) => (a.task === b.task ? 0 : a.task < b.task ? -1 : 1)),
    );

    const tasks = await rows(sql`select id, description, plan, final_summary, backlog_data
      from task order by id`);
    const byId = new Map(tasks.map((row) => [row.id, row]));
    expect(byId.get(back1)).toEqual({
      id: back1,
      description: [
        'Payouts settle nightly through the ledger.',
        '',
        '```sh',
        '## Final summary',
        '- [ ] not an item',
        '```',
        '',
        '## Acceptance criteria',
        '',
        'Items checked by the reviewer only.',
        '~~~',
        '- [ ] #9 sample inside a fence',
        '~~~',
        '',
        '## Comments from Backlog.md',
        '',
        '**@ana** · 2026-10-20 10:00',
        '',
        'Looks right.',
      ].join('\n'),
      plan: '1. Add the ledger table\n2. Wire the webhook',
      final_summary: 'Refunds write a ledger entry; retries back off.',
      backlog_data: { labels: ['payouts'], type: 'feature', implementationNotes: 'Started with the ledger.' },
    });
    expect(byId.get(back2)).toMatchObject({
      description: null,
      plan: null,
      final_summary: null,
      backlog_data: {},
    });
    expect(byId.get(back3)).toMatchObject({
      description: 'Plain text, no sections.',
      plan: null,
      backlog_data: {},
    });
    expect(byId.get(back4)).toMatchObject({ description: null, plan: null, final_summary: null });
    expect(byId.get(old1)).toMatchObject({ description: 'Intro', plan: null, final_summary: 'Shipped.' });
    expect(byId.get(nat1)).toMatchObject({
      description: '## Acceptance criteria\n\n- [ ] #1 Native text',
      plan: null,
      backlog_data: null,
    });

    // The new columns start empty on upgraded rows.
    expect(await rows(sql`select distinct kind, machine, branch from comment`)).toEqual([
      { kind: 'comment', machine: null, branch: null },
    ]);
    expect(
      await rows(
        sql`select count(*)::int as count from activity where machine is not null or branch is not null`,
      ),
    ).toEqual([{ count: 0 }]);
    expect(await rows(sql`select distinct default_done_items from project`)).toEqual([
      { default_done_items: [] },
    ]);

    // Numbers stay unique per task and kind on upgraded data.
    await expect(
      db.execute(
        sql`insert into task_item (task_id, kind, position, text) values (${back1}, 'criterion', 1, 'Twice')`,
      ),
    ).rejects.toThrow();
  });
});

/** Every migration released in 0.9.0, the last release with one workspace per instance. */
const V0_9_0_MIGRATIONS = [...V0_8_0_MIGRATIONS, '20261125110203_m6_work_record'];

/** Creates a database with the 0.9.0 migrations applied; returns it with a teardown. */
async function database090(prefix: string) {
  const folder = mkdtempSync(join(tmpdir(), 'zamu-0-9-0-migrations-'));
  for (const name of V0_9_0_MIGRATIONS) {
    cpSync(join(migrationsFolder, name), join(folder, name), { recursive: true });
  }
  const url = withDatabase(testServerUrl(), uniqueDatabaseName(prefix));
  await createDatabase(url);
  await migrateFrom(url, folder);
  const handle = createDb(url);
  return {
    url,
    db: handle.db,
    close: async () => {
      await handle.pool.end();
      await dropDatabase(url);
      rmSync(folder, { recursive: true, force: true });
    },
  };
}

describe('workspaces migration on a 0.9.0 database with two users and one workspace', () => {
  let url: string;
  let db: Db;
  let close: () => Promise<void>;

  const ANA = '0190a1b2-0000-7000-8000-0000000003a1';
  const BEN = '0190a1b2-0000-7000-8000-0000000003a2';
  const ACME = '0190a1b2-0000-7000-8000-0000000003b1';
  const PAY = '0190a1b2-0000-7000-8000-0000000003c1';

  beforeAll(async () => {
    ({ url, db, close } = await database090('pm_test_upgrade_mw'));
  });

  afterAll(async () => {
    await close?.();
  });

  async function rows(query: ReturnType<typeof sql>) {
    const result = await db.execute<Record<string, unknown>>(query);
    return result.rows;
  }

  it('keeps the slug, fills the workspace used last and adds the alias table', async () => {
    await db.execute(sql`insert into "user" (id, name, email) values
      (${ANA}, 'Ana', 'ana-mw@example.com'), (${BEN}, 'Ben', 'ben-mw@example.com')`);
    // The slug 0.9 setup made from "Acme" with slugify.
    await db.execute(sql`insert into organization (id, name, slug) values (${ACME}, 'Acme', 'acme')`);
    await db.execute(sql`insert into member (organization_id, user_id, role, created_at) values
      (${ACME}, ${ANA}, 'owner', '2026-11-01T09:00:00Z'), (${ACME}, ${BEN}, 'member', '2026-11-02T09:00:00Z')`);
    await db.execute(
      sql`insert into project (id, workspace_id, key, name) values (${PAY}, ${ACME}, 'PAY', 'Payments')`,
    );
    const before = await rowCounts(db);
    const usersBefore = await rows(sql`select id, name, email, updated_at::text from "user" order by id`);

    await migrateFrom(url, migrationsFolder);

    expect(await rowCounts(db)).toEqual(before);
    expect(await rows(sql`select id, name, slug from organization`)).toEqual([
      { id: ACME, name: 'Acme', slug: 'acme' },
    ]);
    expect(await rows(sql`select count(*)::int as count from workspace_slug_alias`)).toEqual([{ count: 0 }]);
    expect(await rows(sql`select id, last_workspace_id from "user" order by id`)).toEqual([
      { id: ANA, last_workspace_id: ACME },
      { id: BEN, last_workspace_id: ACME },
    ]);
    // The backfill does not touch updated_at.
    expect(await rows(sql`select id, name, email, updated_at::text from "user" order by id`)).toEqual(
      usersBefore,
    );

    // New rows: an alias per old slug, in the slug format, unique across workspaces.
    await db.execute(sql`insert into workspace_slug_alias (slug, workspace_id) values ('acme-old', ${ACME})`);
    expect(
      await rows(sql`select slug, workspace_id, created_at is not null as dated from workspace_slug_alias`),
    ).toEqual([{ slug: 'acme-old', workspace_id: ACME, dated: true }]);
    await expect(
      db.execute(sql`insert into workspace_slug_alias (slug, workspace_id) values ('acme-old', ${ACME})`),
    ).rejects.toThrow();
    for (const bad of ['Acme', 'a', '1acme', 'acme-', 'ac--me', 'ac_me', 'x'.repeat(41)]) {
      await expect(
        db.execute(sql`insert into workspace_slug_alias (slug, workspace_id) values (${bad}, ${ACME})`),
        bad,
      ).rejects.toThrow();
    }

    // Deleting the workspace drops its aliases and clears it as the workspace used last.
    await db.execute(sql`delete from organization where id = ${ACME}`);
    expect(await rows(sql`select count(*)::int as count from workspace_slug_alias`)).toEqual([{ count: 0 }]);
    expect(await rows(sql`select distinct last_workspace_id from "user"`)).toEqual([
      { last_workspace_id: null },
    ]);
  });
});

describe('workspaces migration on a 0.9.0 database with slugs outside the URL rules', () => {
  let url: string;
  let db: Db;
  let close: () => Promise<void>;

  beforeAll(async () => {
    ({ url, db, close } = await database090('pm_test_upgrade_mw_slugs'));
  });

  afterAll(async () => {
    await close?.();
  });

  async function rows(query: ReturnType<typeof sql>) {
    const result = await db.execute<Record<string, unknown>>(query);
    return result.rows;
  }

  const id = (n: number) => `0190a1b2-0000-7000-8000-0000000004${n.toString(16).padStart(2, '0')}`;
  const LONG = `globex-${'industries-'.repeat(4)}a`;

  it('rewrites each slug that breaks the rules, keeps the rest, and backfills from the oldest membership', async () => {
    // Created in this order; a rewrite never takes a slug another workspace has.
    const slugs = [
      'Acme_Corp',
      'acme-corp',
      '2026-team',
      'admin',
      LONG,
      'a',
      'x--y',
      'trailing-',
      '---',
      'initech',
    ];
    for (const [index, slug] of slugs.entries()) {
      await db.execute(sql`insert into organization (id, name, slug, created_at)
        values (${id(index + 1)}, ${`Workspace ${index + 1}`}, ${slug},
          ${`2026-10-${String(index + 1).padStart(2, '0')}T09:00:00Z`}::timestamptz)`);
    }
    const CY = id(0xa1);
    const DEE = id(0xa2);
    const EVE = id(0xa3);
    await db.execute(sql`insert into "user" (id, name, email) values
      (${CY}, 'Cy', 'cy-mw@example.com'), (${DEE}, 'Dee', 'dee-mw@example.com'),
      (${EVE}, 'Eve', 'eve-mw@example.com')`);
    // Cy joined Initech first, then Acme Corp; Dee belongs nowhere; Eve's two memberships share a time.
    await db.execute(sql`insert into member (id, organization_id, user_id, role, created_at) values
      (${id(0xc1)}, ${id(1)}, ${CY}, 'member', '2026-11-03T09:00:00Z'),
      (${id(0xc2)}, ${id(10)}, ${CY}, 'owner', '2026-11-01T09:00:00Z'),
      (${id(0xc4)}, ${id(3)}, ${EVE}, 'member', '2026-11-05T09:00:00Z'),
      (${id(0xc3)}, ${id(4)}, ${EVE}, 'member', '2026-11-05T09:00:00Z')`);

    await migrateFrom(url, migrationsFolder);

    expect(await rows(sql`select slug from organization order by created_at`)).toEqual(
      [
        'acme-corp-2',
        'acme-corp',
        'w-2026-team',
        'admin-workspace',
        'globex-industries-industries-industries',
        'a-workspace',
        'x-y',
        'trailing',
        'workspace',
        'initech',
      ].map((slug) => ({ slug })),
    );
    expect(LONG.length).toBeGreaterThan(40);
    // Old slugs in the slug format stay as aliases; the others could never appear in a URL.
    expect(await rows(sql`select slug, workspace_id from workspace_slug_alias order by slug`)).toEqual([
      { slug: 'admin', workspace_id: id(4) },
    ]);
    expect(await rows(sql`select id, last_workspace_id from "user" order by id`)).toEqual([
      { id: CY, last_workspace_id: id(10) },
      { id: DEE, last_workspace_id: null },
      { id: EVE, last_workspace_id: id(4) },
    ]);
  });
});
