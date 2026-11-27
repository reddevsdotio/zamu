// Upgrade paths: a database migrated and filled under an older release keeps every row through the
// later migrations, and each backfill fills what it should (M2 ranks in the M1 list order, M5 task
// fields from Backlog.md blocks, the M6 work record from mirrored descriptions, in 0.10 the
// workspace each user used last and workspace slugs that fit the URL rules, in M7 when closed
// tasks closed and which mirrored tasks start archived, and in M8 that milestones keep their tasks
// and start without a plan link or waves).
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

/** Every migration released in 0.10.0, the last release before M7. */
const V0_10_0_MIGRATIONS = [...V0_9_0_MIGRATIONS, '20261126093425_mw_workspaces'];

describe('M7 migration on a 0.10.0 database with closed, mirrored and linked projects', () => {
  let url: string;
  let folder: string;
  let db: Db;
  let end: () => Promise<void>;

  const ANA = '0190a1b2-0000-7000-8000-0000000005a1';
  const AGENT = '0190a1b2-0000-7000-8000-0000000005a2';
  const NORTHWIND = '0190a1b2-0000-7000-8000-0000000005b1';
  const PAY = '0190a1b2-0000-7000-8000-0000000005c1';
  const BACK = '0190a1b2-0000-7000-8000-0000000005c2';
  const OLD = '0190a1b2-0000-7000-8000-0000000005c3';

  beforeAll(async () => {
    folder = mkdtempSync(join(tmpdir(), 'zamu-0-10-0-migrations-'));
    for (const name of V0_10_0_MIGRATIONS) {
      cpSync(join(migrationsFolder, name), join(folder, name), { recursive: true });
    }
    url = withDatabase(testServerUrl(), uniqueDatabaseName('pm_test_upgrade_m7'));
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

  /** Inserts a task as 0.10.0 wrote it; returns its id. */
  async function insertTask(
    projectId: string,
    number: number,
    status: string,
    updatedAt: string,
    block: Record<string, unknown> | null = null,
  ): Promise<string> {
    const result = await db.execute<{ id: string }>(sql`
      insert into task (project_id, number, backlog_id, backlog_data, title, status, created_by_id, updated_at)
      values (${projectId}, ${number}, ${block ? `BACK-${number}` : null}, ${block ? JSON.stringify(block) : null}::jsonb,
        ${`Task ${number}`}, ${status}::task_status, ${ANA}, ${updatedAt}::timestamptz)
      returning id`);
    return result.rows[0]?.id as string;
  }

  /** An activity row on a task as 0.10.0 wrote it. */
  async function insertActivity(
    projectId: string,
    taskId: string,
    type: string,
    changes: unknown[],
    createdAt: string,
    origin = 'app',
  ) {
    await db.execute(sql`
      insert into activity (workspace_id, project_id, task_id, actor_id, type, changes, origin, created_at)
      values (${NORTHWIND}, ${projectId}, ${taskId}, ${origin === 'app' ? AGENT : null}, ${type},
        ${JSON.stringify(changes)}::jsonb, ${origin}, ${createdAt}::timestamptz)`);
  }

  it('fills closed_at from history, archives mirrored archive files and adds the request tables', async () => {
    await db.execute(sql`insert into "user" (id, name, email) values
      (${ANA}, 'Ana', 'ana-m7@example.com'), (${AGENT}, 'claude-dev', 'claude-dev-m7@agents.invalid')`);
    await db.execute(sql`update "user" set kind = 'agent', responsible_user_id = ${ANA} where id = ${AGENT}`);
    await db.execute(
      sql`insert into organization (id, name, slug) values (${NORTHWIND}, 'Northwind', 'northwind')`,
    );
    await db.execute(sql`insert into member (organization_id, user_id, role) values
      (${NORTHWIND}, ${ANA}, 'owner'), (${NORTHWIND}, ${AGENT}, 'member')`);
    // PAY is native and linked to a repository; BACK mirrors Backlog.md; OLD was imported (detached).
    await db.execute(sql`insert into project (id, workspace_id, key, name, repository, repository_key) values
      (${PAY}, ${NORTHWIND}, 'PAY', 'Payments', 'https://github.com/northwind/payments', 'github.com/northwind/payments'),
      (${BACK}, ${NORTHWIND}, 'BACK', 'Backend', 'git@gitlab.com:northwind/backend.git', 'gitlab.com/northwind/backend'),
      (${OLD}, ${NORTHWIND}, 'OLD', 'Legacy', 'https://gitlab.com/northwind/legacy', 'gitlab.com/northwind/legacy')`);
    await db.execute(sql`insert into backlog_source (project_id, mode, state, webhook_id, created_by_id, detached_at) values
      (${BACK}, 'mirror', 'healthy', 'hook-back-m7', ${ANA}, null),
      (${OLD}, 'import', 'detached', 'hook-old-m7', ${ANA}, '2026-11-01T09:00:00Z')`);

    // Done after a reopen: the latest move to Done counts, not the first one or a later title edit.
    const reopened = await insertTask(PAY, 1, 'done', '2026-11-20T10:00:00.123456Z');
    await insertActivity(
      PAY,
      reopened,
      'task.created',
      [{ field: 'title', from: null, to: 'Task 1' }],
      '2026-11-01T09:00:00Z',
    );
    await insertActivity(
      PAY,
      reopened,
      'task.updated',
      [{ field: 'status', from: 'in_review', to: 'done' }],
      '2026-11-05T09:00:00Z',
    );
    await insertActivity(
      PAY,
      reopened,
      'task.updated',
      [{ field: 'status', from: 'done', to: 'in_progress' }],
      '2026-11-06T09:00:00Z',
    );
    await insertActivity(
      PAY,
      reopened,
      'task.updated',
      [
        { field: 'priority', from: 'low', to: 'high' },
        { field: 'status', from: 'in_review', to: 'done' },
      ],
      '2026-11-08T09:00:00Z',
    );
    await insertActivity(
      PAY,
      reopened,
      'task.updated',
      [{ field: 'title', from: 'Task', to: 'Task 1' }],
      '2026-11-20T10:00:00Z',
    );
    // Created as Done: the creation is the close.
    const createdDone = await insertTask(PAY, 2, 'done', '2026-11-12T10:00:00Z');
    await insertActivity(
      PAY,
      createdDone,
      'task.created',
      [{ field: 'status', from: null, to: 'done' }],
      '2026-11-10T09:00:00Z',
    );
    // Canceled without a status row: updated_at.
    const canceled = await insertTask(PAY, 3, 'canceled', '2026-11-15T08:30:00.654321Z');
    // Canceled, but the only status row moved it to Done: that row is not the current value.
    const canceledAfterDone = await insertTask(PAY, 4, 'canceled', '2026-11-16T08:00:00Z');
    await insertActivity(
      PAY,
      canceledAfterDone,
      'task.updated',
      [{ field: 'status', from: 'todo', to: 'done' }],
      '2026-11-14T09:00:00Z',
    );
    // Open tasks stay unclosed, whatever their history says.
    const open = await insertTask(PAY, 5, 'in_progress', '2026-11-18T08:00:00Z');
    await insertActivity(
      PAY,
      open,
      'task.updated',
      [{ field: 'status', from: 'done', to: 'in_progress' }],
      '2026-11-17T09:00:00Z',
    );

    // Mirrored tasks: one in archive/tasks/, one in tasks/, one Done in the archive (closed and archived).
    const mirroredArchived = await insertTask(BACK, 10, 'todo', '2026-11-19T07:00:00Z', { kind: 'archived' });
    const mirroredActive = await insertTask(BACK, 11, 'todo', '2026-11-19T07:00:00Z', { kind: 'task' });
    const mirroredDone = await insertTask(BACK, 12, 'done', '2026-11-19T07:30:00Z', { kind: 'archived' });
    await insertActivity(
      BACK,
      mirroredDone,
      'task.updated',
      [{ field: 'status', from: 'in_review', to: 'done' }],
      '2026-11-18T07:30:00Z',
      'backlog',
    );
    // Imported (detached) tasks from the archive folder are Zamu's now: not archived by the upgrade.
    const imported = await insertTask(OLD, 20, 'done', '2026-11-02T07:00:00Z', { kind: 'archived' });

    const before = await rowCounts(db);
    const updatedBefore = await rows(sql`select id, updated_at::text from task order by id`);

    await migrateFrom(url, migrationsFolder);

    expect(await rowCounts(db)).toEqual(before);
    // The backfills leave updated_at alone (microseconds included).
    expect(await rows(sql`select id, updated_at::text from task order by id`)).toEqual(updatedBefore);

    const tasks = new Map(
      (
        await rows(sql`select id, closed_at, archived_at, archived_by_id, work_branch, merged_done_at,
          check_again_on, check_again_reason from task`)
      ).map((row) => [row.id as string, row]),
    );
    /** A timestamp column as an ISO string, or null. Raw queries hand timestamps back as text. */
    const iso = (value: unknown) =>
      value === null || value === undefined ? null : new Date(value as string).toISOString();
    const closed = (id: string) => iso(tasks.get(id)?.closed_at);
    const archived = (id: string) => iso(tasks.get(id)?.archived_at);
    expect(closed(reopened)).toBe('2026-11-08T09:00:00.000Z');
    expect(closed(createdDone)).toBe('2026-11-10T09:00:00.000Z');
    expect(closed(canceled)).toBe('2026-11-15T08:30:00.654Z');
    expect(closed(canceledAfterDone)).toBe('2026-11-16T08:00:00.000Z');
    expect(closed(open)).toBeNull();
    expect(closed(mirroredDone)).toBe('2026-11-18T07:30:00.000Z');
    expect(closed(imported)).toBe('2026-11-02T07:00:00.000Z');
    // The stored value keeps the microseconds of updated_at.
    expect(await rows(sql`select closed_at::text as closed from task where id = ${canceled}`)).toEqual([
      { closed: '2026-11-15 08:30:00.654321+00' },
    ]);

    expect(archived(mirroredArchived)).toBe('2026-11-19T07:00:00.000Z');
    expect(archived(mirroredDone)).toBe('2026-11-19T07:30:00.000Z');
    expect(archived(mirroredActive)).toBeNull();
    expect(archived(imported)).toBeNull();
    for (const id of [reopened, createdDone, canceled, canceledAfterDone, open])
      expect(archived(id)).toBeNull();

    // The other new task columns start empty; no one archived anything by hand.
    for (const row of tasks.values()) {
      expect(row).toMatchObject({
        archived_by_id: null,
        work_branch: null,
        merged_done_at: null,
        check_again_on: null,
        check_again_reason: null,
      });
    }

    // Existing projects keep archiving off; a new project gets no database default either.
    expect(await rows(sql`select distinct archive_after_days from project`)).toEqual([
      { archive_after_days: null },
    ]);
    await db.execute(sql`insert into project (workspace_id, key, name) values (${NORTHWIND}, 'NEW', 'New')`);
    expect(await rows(sql`select archive_after_days from project where key = 'NEW'`)).toEqual([
      { archive_after_days: null },
    ]);
    await db.execute(sql`update project set archive_after_days = 14 where id = ${PAY}`);
    await expect(
      db.execute(sql`update project set archive_after_days = 0 where id = ${PAY}`),
    ).rejects.toThrow();
    await expect(
      db.execute(sql`update project set archive_after_days = 366 where id = ${PAY}`),
    ).rejects.toThrow();

    // Old activity rows have no cause; the git origin is allowed from now on.
    expect(await rows(sql`select count(*)::int as count from activity where cause is not null`)).toEqual([
      { count: 0 },
    ]);
    await db.execute(sql`
      insert into activity (workspace_id, project_id, task_id, type, changes, origin, origin_ref, cause)
      values (${NORTHWIND}, ${PAY}, ${open}, 'task.updated', '[{"field":"status","from":"in_progress","to":"in_review"}]'::jsonb,
        'git', 'https://github.com/northwind/payments/pull/482',
        ${JSON.stringify({
          kind: 'pull_request',
          provider: 'github',
          number: 482,
          url: 'https://github.com/northwind/payments/pull/482',
          title: 'Retry webhooks',
          event: 'opened',
          by: 'claude-dev',
        })}::jsonb)`);
    await expect(
      db.execute(sql`insert into activity (workspace_id, project_id, task_id, type, origin)
        values (${NORTHWIND}, ${PAY}, ${open}, 'task.updated', 'forge')`),
    ).rejects.toThrow();

    // The linked project gets a repository link, its requests and their task links.
    await db.execute(sql`insert into repository_link (workspace_id, project_id, repository_key, webhook_id)
      values (${NORTHWIND}, ${PAY}, 'github.com/northwind/payments', 'hook-pay-m7')`);
    expect(
      await rows(
        sql`select close_on_merge, connection_id, moves_from is not null as moves from repository_link`,
      ),
    ).toEqual([{ close_on_merge: true, connection_id: null, moves: true }]);
    const request = await db.execute<{ id: string }>(sql`
      insert into pull_request (workspace_id, project_id, number, title, state, head_branch, base_branch, web_url,
        opened_at, host_updated_at, body_keys)
      values (${NORTHWIND}, ${PAY}, 482, 'Retry webhooks', 'open', 'feat/retries', 'main',
        'https://github.com/northwind/payments/pull/482', '2026-11-26T09:00:00Z', '2026-11-26T09:00:00Z',
        array['PAY-5'])
      returning id`);
    const requestId = request.rows[0]?.id as string;
    await db.execute(sql`insert into task_pull_request (task_id, pull_request_id, via_branch, via_description)
      values (${open}, ${requestId}, true, true)`);
    expect(
      await rows(sql`select via_branch, via_description, via_hand, removed_at from task_pull_request`),
    ).toEqual([{ via_branch: true, via_description: true, via_hand: false, removed_at: null }]);

    // Deleting the project takes its link, requests and task links with it.
    await db.execute(sql`delete from project where id = ${PAY}`);
    for (const table of ['repository_link', 'pull_request', 'task_pull_request']) {
      expect(await rows(sql`select count(*)::int as count from ${sql.identifier(table)}`), table).toEqual([
        { count: 0 },
      ]);
    }
  });
});

/** Every migration released in 0.11.0, the last release before M8. */
const V0_11_0_MIGRATIONS = [...V0_10_0_MIGRATIONS, '20261126143045_m7_pull_requests_archive'];

describe('M8 migration on a 0.11.0 database with milestones and tasks', () => {
  let url: string;
  let folder: string;
  let db: Db;
  let end: () => Promise<void>;

  const ANA = '0190a1b2-0000-7000-8000-0000000006a1';
  const AGENT = '0190a1b2-0000-7000-8000-0000000006a2';
  const NORTHWIND = '0190a1b2-0000-7000-8000-0000000006b1';
  const PAY = '0190a1b2-0000-7000-8000-0000000006c1';
  const PAYOUTS = '0190a1b2-0000-7000-8000-0000000006d1';
  const LEDGER = '0190a1b2-0000-7000-8000-0000000006d2';

  beforeAll(async () => {
    folder = mkdtempSync(join(tmpdir(), 'zamu-0-11-0-migrations-'));
    for (const name of V0_11_0_MIGRATIONS) {
      cpSync(join(migrationsFolder, name), join(folder, name), { recursive: true });
    }
    url = withDatabase(testServerUrl(), uniqueDatabaseName('pm_test_upgrade_m8'));
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

  it('keeps every milestone with its tasks, and adds no plan link and no waves', async () => {
    await db.execute(sql`insert into "user" (id, name, email) values
      (${ANA}, 'Ana', 'ana-m8@example.com'), (${AGENT}, 'claude-dev', 'claude-dev-m8@agents.invalid')`);
    await db.execute(sql`update "user" set kind = 'agent', responsible_user_id = ${ANA} where id = ${AGENT}`);
    await db.execute(
      sql`insert into organization (id, name, slug) values (${NORTHWIND}, 'Northwind', 'northwind')`,
    );
    await db.execute(sql`insert into member (organization_id, user_id, role) values
      (${NORTHWIND}, ${ANA}, 'owner'), (${NORTHWIND}, ${AGENT}, 'member')`);
    await db.execute(sql`insert into project (id, workspace_id, key, name, next_task_number) values
      (${PAY}, ${NORTHWIND}, 'PAY', 'Payments', 7)`);
    await db.execute(sql`insert into milestone (id, workspace_id, project_id, name, status, target_date, created_by_id) values
      (${PAYOUTS}, ${NORTHWIND}, ${PAY}, 'Payouts v2', 'active', '2026-12-18', ${ANA}),
      (${LEDGER}, ${NORTHWIND}, ${PAY}, 'Ledger', 'completed', null, ${ANA})`);
    // Five Payouts tasks over several statuses (one archived), one Ledger task, one in no milestone.
    const statuses = ['done', 'done', 'in_progress', 'todo', 'canceled'];
    for (const [index, status] of statuses.entries()) {
      await db.execute(sql`
        insert into task (project_id, number, title, status, milestone_id, assignee_id, created_by_id,
          archived_at, updated_at)
        values (${PAY}, ${index + 1}, ${`Payout task ${index + 1}`}, ${status}::task_status, ${PAYOUTS},
          ${index === 2 ? AGENT : null}, ${ANA}, ${index === 0 ? '2026-11-20T08:00:00Z' : null}::timestamptz,
          ${`2026-11-2${index}T10:00:00.123456Z`}::timestamptz)`);
    }
    await db.execute(sql`insert into task (project_id, number, title, status, milestone_id, created_by_id) values
      (${PAY}, 6, 'Ledger table', 'done', ${LEDGER}, ${ANA}),
      (${PAY}, 7, 'Loose task', 'backlog', null, ${ANA})`);
    await db.execute(sql`
      insert into activity (workspace_id, project_id, task_id, actor_id, on_behalf_of_id, type, changes)
      select ${NORTHWIND}, project_id, id, ${AGENT}, ${ANA}, 'task.created',
        jsonb_build_array(jsonb_build_object('field', 'milestone', 'from', null, 'to', milestone_id))
      from task`);

    const before = await rowCounts(db);
    const tasksBefore = await rows(
      sql`select id, milestone_id, status::text, updated_at::text from task order by number`,
    );
    const milestonesBefore = await rows(
      sql`select id, name, status::text, target_date::text, updated_at::text from milestone order by name`,
    );

    await migrateFrom(url, migrationsFolder);

    expect(await rowCounts(db)).toEqual(before);
    expect(before.task).toBe(7);
    // Tasks keep their milestone, status and updated_at; none is in a wave.
    expect(
      await rows(sql`select id, milestone_id, status::text, updated_at::text from task order by number`),
    ).toEqual(tasksBefore);
    expect(await rows(sql`select count(*)::int as count from task where wave_id is not null`)).toEqual([
      { count: 0 },
    ]);
    // Milestones are as they were, without a plan link.
    expect(
      await rows(
        sql`select id, name, status::text, target_date::text, updated_at::text from milestone order by name`,
      ),
    ).toEqual(milestonesBefore);
    expect(await rows(sql`select distinct plan_url from milestone`)).toEqual([{ plan_url: null }]);
    // No waves and no gate results were made.
    for (const table of ['wave', 'gate_result']) {
      expect(await rows(sql`select count(*)::int as count from ${sql.identifier(table)}`), table).toEqual([
        { count: 0 },
      ]);
    }

    // The new columns and tables take M8 data after the upgrade.
    await db.execute(sql`update milestone set plan_url = 'plans/payouts-v2.html' where id = ${PAYOUTS}`);
    await expect(db.execute(sql`update milestone set plan_url = '' where id = ${PAYOUTS}`)).rejects.toThrow();
    const wave = await db.execute<{ id: string }>(sql`
      insert into wave (workspace_id, milestone_id, position, name, gate_description, created_by_id)
      values (${NORTHWIND}, ${PAYOUTS}, 1, 'Data and contracts', 'Migrations apply on 0.11.0', ${ANA})
      returning id`);
    const waveId = wave.rows[0]?.id as string;
    await db.execute(
      sql`update task set wave_id = ${waveId} where milestone_id = ${PAYOUTS} and number <= 2`,
    );
    await db.execute(sql`insert into gate_result (workspace_id, wave_id, state, note, actor_id, on_behalf_of_id)
      values (${NORTHWIND}, ${waveId}, 'passed', 'Both tasks are done.', ${AGENT}, ${ANA})`);
    expect(await rows(sql`select number from task where wave_id = ${waveId} order by number`)).toEqual([
      { number: 1 },
      { number: 2 },
    ]);

    // Deleting the milestone takes its waves and their results; its tasks stay, out of the wave.
    await db.execute(sql`delete from milestone where id = ${PAYOUTS}`);
    expect(await rows(sql`select count(*)::int as count from wave`)).toEqual([{ count: 0 }]);
    expect(await rows(sql`select count(*)::int as count from gate_result`)).toEqual([{ count: 0 }]);
    expect(
      await rows(sql`select count(*)::int as count from task where milestone_id is null and wave_id is null`),
    ).toEqual([{ count: 6 }]);
  });
});
