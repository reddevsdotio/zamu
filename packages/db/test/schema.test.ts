import { eq, sql } from 'drizzle-orm';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { createDb, type Db, type Tx } from '../src/client';
import {
  activity,
  backlogFile,
  backlogSource,
  comment,
  commentMention,
  cycle,
  cycleRollover,
  gitConnection,
  label,
  milestone,
  organization,
  project,
  pullRequest,
  repositoryLink,
  task,
  taskDependency,
  taskItem,
  taskLabel,
  taskPullRequest,
  user,
  WORKSPACE_SLUG_MAX_LENGTH,
  workspaceSlugAlias,
} from '../src/schema';
import { createTestDatabase, sharedTestDatabaseUrl, type TestDatabase } from './index';

/** Postgres wraps constraint errors in DrizzleQueryError; the pg error sits in `cause`. */
async function pgErrorCode(promise: Promise<unknown>): Promise<string | undefined> {
  try {
    await promise;
  } catch (error) {
    const cause = (error as { cause?: { code?: string } }).cause;
    return cause?.code ?? (error as { code?: string }).code;
  }
  return undefined;
}

async function seed(db: Db | Tx) {
  const [owner] = await db
    .insert(user)
    .values({ name: 'Ada', email: `ada-${crypto.randomUUID()}@example.com` })
    .returning();
  const [workspace] = await db
    .insert(organization)
    .values({ name: 'Reddevs', slug: `reddevs-${crypto.randomUUID()}` })
    .returning();
  if (!owner || !workspace) throw new Error('seed failed');
  const [pay] = await db
    .insert(project)
    .values({ workspaceId: workspace.id, key: 'PAY', name: 'Payments' })
    .returning();
  if (!pay) throw new Error('seed failed');
  return { owner, workspace, pay };
}

describe('schema on a throwaway database', () => {
  let database: TestDatabase;
  let db: Db;

  beforeAll(async () => {
    database = await createTestDatabase();
    db = database.db;
  });

  afterAll(async () => {
    await database?.drop();
  });

  it('creates every table from the domain model', async () => {
    const result = await db.execute<{ table_name: string }>(
      sql`select table_name from information_schema.tables where table_schema = 'public' order by table_name`,
    );
    expect(result.rows.map((row) => row.table_name)).toEqual([
      'account',
      'activity',
      'apikey',
      'backlog_file',
      'backlog_source',
      'comment',
      'comment_mention',
      'cycle',
      'cycle_rollover',
      'git_connection',
      'invitation',
      'label',
      'member',
      'milestone',
      'organization',
      'project',
      'pull_request',
      'repository_link',
      'session',
      'task',
      'task_dependency',
      'task_item',
      'task_label',
      'task_pull_request',
      'user',
      'verification',
      'workspace_slug_alias',
    ]);
  });

  it('generates uuidv7 ids and defaults kind to person', async () => {
    const { owner, pay } = await seed(db);
    expect(owner.id).toMatch(/^[0-9a-f]{8}-[0-9a-f]{4}-7[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/);
    expect(pay.id.charAt(14)).toBe('7');
    expect(owner.kind).toBe('person');
    expect(pay.nextTaskNumber).toBe(1);
  });

  it('rejects an invalid user kind, project key and priority', async () => {
    const { owner, pay } = await seed(db);
    expect(await pgErrorCode(db.execute(sql`update "user" set kind = 'robot' where id = ${owner.id}`))).toBe(
      '23514',
    );
    expect(
      await pgErrorCode(
        db.insert(project).values({ workspaceId: pay.workspaceId, key: 'pay', name: 'Lower' }),
      ),
    ).toBe('23514');
    expect(
      await pgErrorCode(
        db.insert(project).values({ workspaceId: pay.workspaceId, key: '1AB', name: 'Digit' }),
      ),
    ).toBe('23514');
    expect(
      await pgErrorCode(
        db
          .insert(task)
          .values({ projectId: pay.id, number: 1, title: 'Too urgent', priority: 5, createdById: owner.id }),
      ),
    ).toBe('23514');
    expect(
      await pgErrorCode(
        db.execute(sql`insert into task (project_id, number, title, status, created_by_id)
        values (${pay.id}, 1, 'Bad status', 'started', ${owner.id})`),
      ),
    ).toBe('22P02');
  });

  it('keeps project keys unique per workspace and task numbers unique per project', async () => {
    const { owner, workspace, pay } = await seed(db);
    expect(
      await pgErrorCode(db.insert(project).values({ workspaceId: workspace.id, key: 'PAY', name: 'Again' })),
    ).toBe('23505');

    const other = await seed(db);
    expect(other.pay.key).toBe('PAY');

    await db.insert(task).values({ projectId: pay.id, number: 1, title: 'First', createdById: owner.id });
    expect(
      await pgErrorCode(
        db.insert(task).values({ projectId: pay.id, number: 1, title: 'Dup', createdById: owner.id }),
      ),
    ).toBe('23505');
  });

  it('allocates task numbers inside a transaction and loads relations', async () => {
    const { owner, pay } = await seed(db);
    const created = await db.transaction(async (tx: Tx) => {
      const [counter] = await tx
        .update(project)
        .set({ nextTaskNumber: sql`${project.nextTaskNumber} + 1` })
        .where(eq(project.id, pay.id))
        .returning({ number: sql<number>`${project.nextTaskNumber} - 1` });
      if (!counter) throw new Error('project not found');
      const [row] = await tx
        .insert(task)
        .values({ projectId: pay.id, number: counter.number, title: 'Ship it', createdById: owner.id })
        .returning();
      return row;
    });
    expect(created?.number).toBe(1);
    expect(created?.status).toBe('todo');
    expect(created?.priority).toBe(0);

    const loaded = await db.query.task.findFirst({
      where: { id: created?.id },
      with: { project: true, createdBy: true },
    });
    expect(loaded?.project.key).toBe('PAY');
    expect(loaded?.createdBy.id).toBe(owner.id);
  });
});

describe('M2 schema', () => {
  let database: TestDatabase;
  let db: Db;

  beforeAll(async () => {
    database = await createTestDatabase();
    db = database.db;
  });

  afterAll(async () => {
    await database?.drop();
  });

  async function newMilestone(world: Awaited<ReturnType<typeof seed>>, name: string) {
    const [row] = await db
      .insert(milestone)
      .values({ workspaceId: world.workspace.id, projectId: world.pay.id, name, createdById: world.owner.id })
      .returning();
    if (!row) throw new Error('milestone insert failed');
    return row;
  }

  async function newCycle(
    world: Awaited<ReturnType<typeof seed>>,
    number: number,
    startsOn: string,
    endsOn: string,
  ) {
    const [row] = await db
      .insert(cycle)
      .values({ workspaceId: world.workspace.id, projectId: world.pay.id, number, startsOn, endsOn })
      .returning();
    if (!row) throw new Error('cycle insert failed');
    return row;
  }

  it('defaults the new project, task and user columns', async () => {
    const world = await seed(db);
    expect(world.pay).toMatchObject({ usesMilestones: true, usesCycles: true, nextCycleNumber: 1 });
    expect(world.owner.theme).toBe('system');
    const [row] = await db
      .insert(task)
      .values({ projectId: world.pay.id, number: 1, title: 'Defaults', createdById: world.owner.id })
      .returning();
    expect(row).toMatchObject({ milestoneId: null, cycleId: null, cycleAddedAt: null, rank: 0 });
  });

  it('checks the theme', async () => {
    const { owner } = await seed(db);
    await db.update(user).set({ theme: 'dark' }).where(eq(user.id, owner.id));
    expect(await pgErrorCode(db.execute(sql`update "user" set theme = 'sepia' where id = ${owner.id}`))).toBe(
      '23514',
    );
  });

  it('keeps milestone names unique per project ignoring case, and starts them planned', async () => {
    const world = await seed(db);
    const webhooks = await newMilestone(world, 'Webhooks v2');
    expect(webhooks.status).toBe('planned');
    expect(webhooks.targetDate).toBeNull();
    expect(await pgErrorCode(newMilestone(world, 'WEBHOOKS V2'))).toBe('23505');
    expect(await pgErrorCode(newMilestone(world, ''))).toBe('23514');

    const other = await seed(db);
    await expect(newMilestone(other, 'Webhooks v2')).resolves.toBeTruthy();

    await db.update(milestone).set({ targetDate: '2026-11-14' }).where(eq(milestone.id, webhooks.id));
    const reloaded = await db.query.milestone.findFirst({ where: { id: webhooks.id } });
    expect(reloaded?.targetDate).toBe('2026-11-14');
  });

  it('checks cycle numbers and dates', async () => {
    const world = await seed(db);
    await newCycle(world, 1, '2026-10-26', '2026-11-08');
    expect(await pgErrorCode(newCycle(world, 1, '2026-11-09', '2026-11-22'))).toBe('23505');
    expect(await pgErrorCode(newCycle(world, 2, '2026-11-09', '2026-11-08'))).toBe('23514');
    // 56 days, both ends included, is the longest cycle.
    await expect(newCycle(world, 2, '2026-11-09', '2027-01-03')).resolves.toBeTruthy();
    expect(await pgErrorCode(newCycle(world, 3, '2027-01-04', '2027-03-01'))).toBe('23514');
    expect(await pgErrorCode(newCycle(world, 0, '2027-01-04', '2027-01-04'))).toBe('23514');
  });

  it('clears milestone and cycle from tasks when they are deleted', async () => {
    const world = await seed(db);
    const ms = await newMilestone(world, 'Launch');
    const c1 = await newCycle(world, 1, '2026-10-26', '2026-11-08');
    const [row] = await db
      .insert(task)
      .values({
        projectId: world.pay.id,
        number: 1,
        title: 'Planned',
        createdById: world.owner.id,
        milestoneId: ms.id,
        cycleId: c1.id,
        cycleAddedAt: new Date(),
        rank: -1.5,
      })
      .returning();
    if (!row) throw new Error('task insert failed');

    const loaded = await db.query.task.findFirst({
      where: { id: row.id },
      with: { milestone: true, cycle: true },
    });
    expect(loaded?.milestone?.name).toBe('Launch');
    expect(loaded?.cycle?.number).toBe(1);
    expect(loaded?.rank).toBe(-1.5);

    await db.delete(milestone).where(eq(milestone.id, ms.id));
    await db.delete(cycle).where(eq(cycle.id, c1.id));
    const cleared = await db.query.task.findFirst({ where: { id: row.id } });
    expect(cleared).toMatchObject({ milestoneId: null, cycleId: null });
  });

  it('records cycle rollovers once per task', async () => {
    const world = await seed(db);
    const c1 = await newCycle(world, 1, '2026-10-12', '2026-10-25');
    const c2 = await newCycle(world, 2, '2026-10-26', '2026-11-08');
    const [row] = await db
      .insert(task)
      .values({ projectId: world.pay.id, number: 1, title: 'Unfinished', createdById: world.owner.id })
      .returning();
    if (!row) throw new Error('task insert failed');
    await db
      .insert(cycleRollover)
      .values({ cycleId: c1.id, taskId: row.id, toCycleId: c2.id, statusAtEnd: 'todo' });
    expect(
      await pgErrorCode(
        db
          .insert(cycleRollover)
          .values({ cycleId: c1.id, taskId: row.id, toCycleId: null, statusAtEnd: 'todo' }),
      ),
    ).toBe('23505');
    const loaded = await db.query.cycle.findFirst({
      where: { id: c1.id },
      with: { rollovers: { with: { toCycle: true, task: true } } },
    });
    expect(loaded?.rollovers).toHaveLength(1);
    expect(loaded?.rollovers[0]?.toCycle?.number).toBe(2);
    expect(loaded?.rollovers[0]?.task.title).toBe('Unfinished');
  });

  it('keeps comment bodies until a soft delete, and mentions per user once', async () => {
    const world = await seed(db);
    const [row] = await db
      .insert(task)
      .values({ projectId: world.pay.id, number: 1, title: 'Discussed', createdById: world.owner.id })
      .returning();
    if (!row) throw new Error('task insert failed');
    const base = {
      workspaceId: world.workspace.id,
      projectId: world.pay.id,
      taskId: row.id,
      authorId: world.owner.id,
    };
    const [note] = await db
      .insert(comment)
      .values({ ...base, body: `Ping [@Ada](mention:${world.owner.id})` })
      .returning();
    if (!note) throw new Error('comment insert failed');
    expect(note).toMatchObject({ editedAt: null, deletedAt: null, onBehalfOfId: null });
    await db.insert(commentMention).values({ commentId: note.id, userId: world.owner.id });
    expect(
      await pgErrorCode(db.insert(commentMention).values({ commentId: note.id, userId: world.owner.id })),
    ).toBe('23505');

    // A body without deleted_at, or deleted_at with a body, is rejected.
    expect(await pgErrorCode(db.insert(comment).values({ ...base, body: null }))).toBe('23514');
    expect(await pgErrorCode(db.insert(comment).values({ ...base, body: 'x', deletedAt: new Date() }))).toBe(
      '23514',
    );
    await db.update(comment).set({ body: null, deletedAt: new Date() }).where(eq(comment.id, note.id));

    const loaded = await db.query.task.findFirst({
      where: { id: row.id },
      with: { comments: { with: { author: true, mentions: true } } },
    });
    expect(loaded?.comments[0]?.body).toBeNull();
    expect(loaded?.comments[0]?.author.id).toBe(world.owner.id);
    expect(loaded?.comments[0]?.mentions).toHaveLength(1);
  });

  it('allows system activity without an actor', async () => {
    const world = await seed(db);
    const [row] = await db
      .insert(task)
      .values({ projectId: world.pay.id, number: 1, title: 'Rolled over', createdById: world.owner.id })
      .returning();
    if (!row) throw new Error('task insert failed');
    const [entry] = await db
      .insert(activity)
      .values({
        workspaceId: world.workspace.id,
        projectId: world.pay.id,
        taskId: row.id,
        actorId: null,
        type: 'cycle.ended',
        changes: [{ field: 'cycle', from: null, to: null }],
      })
      .returning();
    const loaded = await db.query.activity.findFirst({ where: { id: entry?.id }, with: { actor: true } });
    expect(loaded?.actor).toBeNull();
    expect(loaded?.type).toBe('cycle.ended');
  });
});

describe('M3 schema', () => {
  let database: TestDatabase;
  let db: Db;

  beforeAll(async () => {
    database = await createTestDatabase();
    db = database.db;
  });

  afterAll(async () => {
    await database?.drop();
  });

  async function newConnection(world: Awaited<ReturnType<typeof seed>>, name: string, host = 'gitlab.com') {
    const [row] = await db
      .insert(gitConnection)
      .values({
        workspaceId: world.workspace.id,
        name,
        provider: 'gitlab',
        host,
        apiBaseUrl: `https://${host}/api/v4`,
        tokenCiphertext: 'v1:AAAA',
        tokenHint: 'xyz',
        createdById: world.owner.id,
      })
      .returning();
    if (!row) throw new Error('connection insert failed');
    return row;
  }

  async function newSource(world: Awaited<ReturnType<typeof seed>>, connectionId: string | null) {
    const [row] = await db
      .insert(backlogSource)
      .values({
        projectId: world.pay.id,
        connectionId,
        mode: 'mirror',
        webhookId: `wh_${crypto.randomUUID()}`,
        createdById: world.owner.id,
      })
      .returning();
    if (!row) throw new Error('source insert failed');
    return row;
  }

  it('stores connections with unique names per workspace and checked enumerations', async () => {
    const world = await seed(db);
    const connection = await newConnection(world, 'GitLab · reddevs');
    expect(connection).toMatchObject({ status: 'unchecked', checkedAt: null, checkedLogin: null });
    expect(await pgErrorCode(newConnection(world, 'gitlab · REDDEVS'))).toBe('23505');
    expect(await pgErrorCode(newConnection(world, 'Upper host', 'GitLab.com'))).toBe('23514');
    expect(
      await pgErrorCode(
        db.execute(sql`update git_connection set provider = 'bitbucket' where id = ${connection.id}`),
      ),
    ).toBe('23514');
    expect(
      await pgErrorCode(
        db.execute(sql`update git_connection set status = 'broken' where id = ${connection.id}`),
      ),
    ).toBe('23514');
    const other = await seed(db);
    await expect(newConnection(other, 'GitLab · reddevs')).resolves.toBeTruthy();
  });

  it('keeps one source per project, defaults its state and pauses it when the connection goes', async () => {
    const world = await seed(db);
    const connection = await newConnection(world, 'Forgejo');
    const source = await newSource(world, connection.id);
    expect(source).toMatchObject({
      state: 'setup',
      mappings: { status: [], priority: [], assignee: [] },
      warnings: [],
      lastTrigger: null,
      detachedAt: null,
    });
    expect(await pgErrorCode(newSource(world, connection.id))).toBe('23505');
    expect(
      await pgErrorCode(db.execute(sql`update backlog_source set mode = 'sync' where id = ${source.id}`)),
    ).toBe('23514');
    expect(
      await pgErrorCode(
        db.execute(sql`update backlog_source set last_trigger = 'cron' where id = ${source.id}`),
      ),
    ).toBe('23514');
    // detached and detached_at go together.
    expect(
      await pgErrorCode(
        db.execute(sql`update backlog_source set state = 'detached' where id = ${source.id}`),
      ),
    ).toBe('23514');
    await db.execute(
      sql`update backlog_source set state = 'detached', detached_at = now() where id = ${source.id}`,
    );

    await db.delete(gitConnection).where(eq(gitConnection.id, connection.id));
    const loaded = await db.query.project.findFirst({
      where: { id: world.pay.id },
      with: { backlogSource: { with: { connection: true } } },
    });
    expect(loaded?.backlogSource?.connectionId).toBeNull();
    expect(loaded?.backlogSource?.connection).toBeNull();
  });

  it('tracks files per source and lets tasks carry Backlog.md keys, data and hiding', async () => {
    const world = await seed(db);
    const source = await newSource(world, null);
    const [parent] = await db
      .insert(task)
      .values({
        projectId: world.pay.id,
        number: 786,
        title: 'Retry webhooks',
        createdById: world.owner.id,
        backlogId: 'BACK-786',
        backlogData: { labels: ['webhooks'] },
      })
      .returning();
    const [sub] = await db
      .insert(task)
      .values({
        projectId: world.pay.id,
        number: 786,
        keySuffix: '1',
        title: 'Honour Retry-After',
        createdById: world.owner.id,
        backlogId: 'BACK-786.1',
        hiddenAt: new Date(),
      })
      .returning();
    if (!parent || !sub) throw new Error('task insert failed');
    expect(parent.keySuffix).toBeNull();
    expect(parent.backlogData).toEqual({ labels: ['webhooks'] });
    expect(
      await pgErrorCode(
        db
          .insert(task)
          .values({ projectId: world.pay.id, number: 786, title: 'Dup', createdById: world.owner.id }),
      ),
    ).toBe('23505');

    await db.insert(backlogFile).values([
      { sourceId: source.id, path: 'backlog/config.yml', blobSha: 'a1', kind: 'config' },
      {
        sourceId: source.id,
        path: 'backlog/tasks/back-786.1 - Honour.md',
        blobSha: 'b2',
        kind: 'task',
        backlogId: 'BACK-786.1',
        taskId: sub.id,
      },
    ]);
    expect(
      await pgErrorCode(
        db
          .insert(backlogFile)
          .values({ sourceId: source.id, path: 'backlog/config.yml', blobSha: 'c3', kind: 'config' }),
      ),
    ).toBe('23505');
    expect(
      await pgErrorCode(
        db
          .insert(backlogFile)
          .values({ sourceId: source.id, path: 'backlog/docs/a.md', blobSha: 'd4', kind: 'doc' as 'task' }),
      ),
    ).toBe('23514');

    const files = await db.query.backlogSource.findFirst({
      where: { id: source.id },
      with: { files: { with: { task: true } } },
    });
    expect(files?.files.find((file) => file.kind === 'task')?.task?.backlogId).toBe('BACK-786.1');

    // Deleting the task keeps the file row (it may be re-linked by the next refresh).
    await db.delete(task).where(eq(task.id, sub.id));
    const after = await db.query.backlogFile.findMany({ where: { sourceId: source.id } });
    expect(after).toHaveLength(2);
    expect(after.every((file) => file.taskId === null)).toBe(true);

    // Removing the project removes its source and files.
    await db.delete(project).where(eq(project.id, world.pay.id));
    expect(await db.query.backlogFile.findMany({ where: { sourceId: source.id } })).toEqual([]);
  });

  it('records activity origin and project-level rows without a task', async () => {
    const world = await seed(db);
    const [row] = await db
      .insert(activity)
      .values({
        workspaceId: world.workspace.id,
        projectId: world.pay.id,
        taskId: null,
        actorId: null,
        type: 'project.backlog_imported',
        origin: 'backlog',
        originRef: 'a1b2c3d4',
        changes: [{ field: 'tasks', from: null, to: 412 }],
      })
      .returning();
    expect(row).toMatchObject({ origin: 'backlog', originRef: 'a1b2c3d4', taskId: null });
    const [plain] = await db
      .insert(activity)
      .values({
        workspaceId: world.workspace.id,
        projectId: world.pay.id,
        actorId: world.owner.id,
        type: 'task.updated',
      })
      .returning();
    expect(plain).toMatchObject({ origin: 'app', originRef: null });
    expect(
      await pgErrorCode(db.execute(sql`update activity set origin = 'github' where id = ${plain?.id}`)),
    ).toBe('23514');
  });

  it('lets milestones carry a Backlog.md id and hiding', async () => {
    const world = await seed(db);
    const [row] = await db
      .insert(milestone)
      .values({
        workspaceId: world.workspace.id,
        projectId: world.pay.id,
        name: 'Webhooks v2',
        createdById: world.owner.id,
        backlogId: 'm-3',
      })
      .returning();
    expect(row).toMatchObject({ backlogId: 'm-3', hiddenAt: null });
  });
});

describe('M5 schema', () => {
  let database: TestDatabase;
  let db: Db;

  beforeAll(async () => {
    database = await createTestDatabase();
    db = database.db;
  });

  afterAll(async () => {
    await database?.drop();
  });

  async function newTask(world: Awaited<ReturnType<typeof seed>>, number: number, values = {}) {
    const [row] = await db
      .insert(task)
      .values({
        projectId: world.pay.id,
        number,
        title: `Task ${number}`,
        createdById: world.owner.id,
        ...values,
      })
      .returning();
    if (!row) throw new Error('task insert failed');
    return row;
  }

  async function newLabel(world: Awaited<ReturnType<typeof seed>>, name: string, color = 1) {
    const [row] = await db
      .insert(label)
      .values({ workspaceId: world.workspace.id, projectId: world.pay.id, name, color })
      .returning();
    if (!row) throw new Error('label insert failed');
    return row;
  }

  it('defaults the new task columns to none', async () => {
    const world = await seed(db);
    const row = await newTask(world, 1);
    expect(row).toMatchObject({ dueDate: null, parentId: null });
    await db.update(task).set({ dueDate: '2026-11-14' }).where(eq(task.id, row.id));
    const reloaded = await db.query.task.findFirst({ where: { id: row.id } });
    expect(reloaded?.dueDate).toBe('2026-11-14');
  });

  it('keeps label names unique per project ignoring case, and checks colour, length and source', async () => {
    const world = await seed(db);
    const payouts = await newLabel(world, 'payouts', 3);
    expect(payouts).toMatchObject({ source: 'app', color: 3 });
    expect(await pgErrorCode(newLabel(world, 'Payouts'))).toBe('23505');
    expect(await pgErrorCode(newLabel(world, ''))).toBe('23514');
    expect(await pgErrorCode(newLabel(world, 'x'.repeat(41)))).toBe('23514');
    await expect(newLabel(world, 'x'.repeat(40))).resolves.toBeTruthy();
    expect(await pgErrorCode(newLabel(world, 'zero', 0))).toBe('23514');
    expect(await pgErrorCode(newLabel(world, 'ten', 10))).toBe('23514');
    await expect(newLabel(world, 'nine', 9)).resolves.toBeTruthy();
    expect(
      await pgErrorCode(db.execute(sql`update label set source = 'file' where id = ${payouts.id}`)),
    ).toBe('23514');
    await db.execute(sql`update label set source = 'backlog' where id = ${payouts.id}`);

    const other = await seed(db);
    await expect(newLabel(other, 'payouts')).resolves.toBeTruthy();
  });

  it('puts a label on a task once and drops the link when either side goes', async () => {
    const world = await seed(db);
    const one = await newTask(world, 1);
    const two = await newTask(world, 2);
    const payouts = await newLabel(world, 'payouts');
    const backend = await newLabel(world, 'backend');
    await db.insert(taskLabel).values([
      { taskId: one.id, labelId: payouts.id },
      { taskId: one.id, labelId: backend.id },
      { taskId: two.id, labelId: payouts.id },
    ]);
    expect(await pgErrorCode(db.insert(taskLabel).values({ taskId: one.id, labelId: payouts.id }))).toBe(
      '23505',
    );

    await db.delete(label).where(eq(label.id, payouts.id));
    const afterLabel = await db.select().from(taskLabel).where(eq(taskLabel.taskId, one.id));
    expect(afterLabel).toEqual([{ taskId: one.id, labelId: backend.id }]);

    await db.delete(task).where(eq(task.id, one.id));
    expect(await db.select().from(taskLabel).where(eq(taskLabel.labelId, backend.id))).toEqual([]);

    await db.delete(project).where(eq(project.id, world.pay.id));
    expect(await db.select().from(label).where(eq(label.projectId, world.pay.id))).toEqual([]);
  });

  it('links blockers once, never to the task itself, and drops links with either task', async () => {
    const world = await seed(db);
    const blocked = await newTask(world, 1);
    const blocker = await newTask(world, 2);
    const other = await newTask(world, 3);
    const [link] = await db
      .insert(taskDependency)
      .values({ taskId: blocked.id, blockerId: blocker.id })
      .returning();
    expect(link?.createdAt).toBeInstanceOf(Date);
    await db.insert(taskDependency).values({ taskId: blocked.id, blockerId: other.id });
    expect(
      await pgErrorCode(db.insert(taskDependency).values({ taskId: blocked.id, blockerId: blocker.id })),
    ).toBe('23505');
    expect(
      await pgErrorCode(db.insert(taskDependency).values({ taskId: blocked.id, blockerId: blocked.id })),
    ).toBe('23514');

    await db.delete(task).where(eq(task.id, blocker.id));
    const left = await db.select().from(taskDependency).where(eq(taskDependency.taskId, blocked.id));
    expect(left.map((row) => row.blockerId)).toEqual([other.id]);

    await db.delete(task).where(eq(task.id, blocked.id));
    expect(await db.select().from(taskDependency).where(eq(taskDependency.blockerId, other.id))).toEqual([]);
  });

  it('refuses a task as its own parent and turns subtasks top-level when the parent goes', async () => {
    const world = await seed(db);
    const parent = await newTask(world, 1);
    const child = await newTask(world, 2, { parentId: parent.id });
    expect(child.parentId).toBe(parent.id);
    expect(
      await pgErrorCode(db.update(task).set({ parentId: parent.id }).where(eq(task.id, parent.id))),
    ).toBe('23514');
    await db.delete(task).where(eq(task.id, parent.id));
    const reloaded = await db.query.task.findFirst({ where: { id: child.id } });
    expect(reloaded?.parentId).toBeNull();
  });

  it('indexes due dates, parents, blockers and label links', async () => {
    const result = await db.execute<{ indexname: string; indexdef: string }>(sql`
      select indexname, indexdef from pg_indexes
      where schemaname = 'public' and indexname in (
        'label_projectId_name_unique',
        'task_dependency_blockerId_idx',
        'task_label_labelId_idx',
        'task_parentId_idx',
        'task_projectId_dueDate_idx')
      order by indexname`);
    expect(result.rows).toEqual([
      {
        indexname: 'label_projectId_name_unique',
        indexdef:
          'CREATE UNIQUE INDEX "label_projectId_name_unique" ON public.label USING btree (project_id, lower(name))',
      },
      {
        indexname: 'task_dependency_blockerId_idx',
        indexdef:
          'CREATE INDEX "task_dependency_blockerId_idx" ON public.task_dependency USING btree (blocker_id)',
      },
      {
        indexname: 'task_label_labelId_idx',
        indexdef: 'CREATE INDEX "task_label_labelId_idx" ON public.task_label USING btree (label_id)',
      },
      {
        indexname: 'task_parentId_idx',
        indexdef: 'CREATE INDEX "task_parentId_idx" ON public.task USING btree (parent_id)',
      },
      {
        indexname: 'task_projectId_dueDate_idx',
        indexdef:
          'CREATE INDEX "task_projectId_dueDate_idx" ON public.task USING btree (project_id, due_date) WHERE (due_date IS NOT NULL)',
      },
    ]);
  });
});

describe('M6 schema', () => {
  let database: TestDatabase;
  let db: Db;

  beforeAll(async () => {
    database = await createTestDatabase();
    db = database.db;
  });

  afterAll(async () => {
    await database?.drop();
  });

  async function newTask(world: Awaited<ReturnType<typeof seed>>, number: number) {
    const [row] = await db
      .insert(task)
      .values({ projectId: world.pay.id, number, title: `Task ${number}`, createdById: world.owner.id })
      .returning();
    if (!row) throw new Error('task insert failed');
    return row;
  }

  async function newItem(
    taskId: string,
    position: number,
    values: Partial<typeof taskItem.$inferInsert> = {},
  ) {
    const [row] = await db
      .insert(taskItem)
      .values({ taskId, kind: 'criterion', position, text: `Criterion ${position}`, ...values })
      .returning();
    if (!row) throw new Error('item insert failed');
    return row;
  }

  it('defaults the new task, project, comment and activity columns', async () => {
    const world = await seed(db);
    const row = await newTask(world, 1);
    expect(row).toMatchObject({ plan: null, finalSummary: null });
    expect(world.pay.defaultDoneItems).toEqual([]);
    const [note] = await db
      .insert(comment)
      .values({
        workspaceId: world.workspace.id,
        projectId: world.pay.id,
        taskId: row.id,
        authorId: world.owner.id,
        body: 'Started',
      })
      .returning();
    expect(note).toMatchObject({ kind: 'comment', machine: null, branch: null });
    const [entry] = await db
      .insert(activity)
      .values({
        workspaceId: world.workspace.id,
        projectId: world.pay.id,
        taskId: row.id,
        actorId: world.owner.id,
        type: 'task.updated',
        changes: [{ field: 'criterion.checked', number: 1, text: 'Refunds post a ledger entry' }],
        machine: 'ana-laptop',
        branch: 'feat/refunds',
      })
      .returning();
    expect(entry).toMatchObject({ machine: 'ana-laptop', branch: 'feat/refunds' });
    expect(entry?.changes).toEqual([
      { field: 'criterion.checked', number: 1, text: 'Refunds post a ledger entry' },
    ]);
  });

  it('checks comment kinds and default done items', async () => {
    const world = await seed(db);
    const row = await newTask(world, 1);
    const values = {
      workspaceId: world.workspace.id,
      projectId: world.pay.id,
      taskId: row.id,
      authorId: world.owner.id,
      body: 'Migration written',
    };
    await expect(db.insert(comment).values({ ...values, kind: 'note' })).resolves.toBeTruthy();
    expect(
      await pgErrorCode(
        db.execute(sql`insert into comment (workspace_id, project_id, task_id, author_id, body, kind)
        values (${world.workspace.id}, ${world.pay.id}, ${row.id}, ${world.owner.id}, 'x', 'memo')`),
      ),
    ).toBe('23514');
    await db
      .update(project)
      .set({ defaultDoneItems: ['Tests pass', 'Docs updated'] })
      .where(eq(project.id, world.pay.id));
    const reloaded = await db.query.project.findFirst({ where: { id: world.pay.id } });
    expect(reloaded?.defaultDoneItems).toEqual(['Tests pass', 'Docs updated']);
    expect(
      await pgErrorCode(
        db.execute(sql`update project set default_done_items = '{"a": 1}'::jsonb where id = ${world.pay.id}`),
      ),
    ).toBe('23514');
  });

  it('checks item kind, state, source, position and text', async () => {
    const world = await seed(db);
    const row = await newTask(world, 1);
    const item = await newItem(row.id, 1);
    expect(item).toMatchObject({ state: 'open', source: 'app', waivedReason: null, waivedById: null });
    expect(await pgErrorCode(newItem(row.id, 2, { kind: 'step' as 'done' }))).toBe('23514');
    expect(await pgErrorCode(newItem(row.id, 2, { state: 'skipped' as 'open' }))).toBe('23514');
    expect(await pgErrorCode(newItem(row.id, 2, { source: 'file' as 'app' }))).toBe('23514');
    expect(await pgErrorCode(newItem(row.id, 0))).toBe('23514');
    expect(await pgErrorCode(newItem(row.id, 2, { text: '' }))).toBe('23514');
    expect(await pgErrorCode(newItem(row.id, 2, { text: 'two\nlines' }))).toBe('23514');
    expect(await pgErrorCode(newItem(row.id, 2, { text: 'carriage\rreturn' }))).toBe('23514');
    // Done items number on their own.
    await expect(newItem(row.id, 1, { kind: 'done', text: 'Tests pass' })).resolves.toBeTruthy();
  });

  it('needs a reason exactly while waived', async () => {
    const world = await seed(db);
    const row = await newTask(world, 1);
    expect(await pgErrorCode(newItem(row.id, 1, { state: 'waived' }))).toBe('23514');
    expect(await pgErrorCode(newItem(row.id, 1, { waivedReason: 'Not needed' }))).toBe('23514');
    expect(
      await pgErrorCode(
        newItem(row.id, 1, { state: 'checked', waivedReason: null, waivedById: world.owner.id }),
      ),
    ).toBe('23514');
    const waived = await newItem(row.id, 1, {
      state: 'waived',
      waivedReason: 'Load test replaced by a replay',
      waivedById: world.owner.id,
    });
    expect(waived).toMatchObject({ state: 'waived', waivedById: world.owner.id });
    // Checking a waived item clears the waiver in the same write.
    await db
      .update(taskItem)
      .set({ state: 'checked', waivedReason: null, waivedById: null })
      .where(eq(taskItem.id, waived.id));
  });

  it('keeps one item per number and kind, checked at commit so renumbering may pass through duplicates', async () => {
    const world = await seed(db);
    const row = await newTask(world, 1);
    const one = await newItem(row.id, 1);
    const two = await newItem(row.id, 2);

    // A move inside one transaction: swap the two numbers.
    await db.transaction(async (tx) => {
      await tx.update(taskItem).set({ position: 2 }).where(eq(taskItem.id, one.id));
      await tx.update(taskItem).set({ position: 1 }).where(eq(taskItem.id, two.id));
    });
    const order = await db
      .select({ id: taskItem.id })
      .from(taskItem)
      .where(eq(taskItem.taskId, row.id))
      .orderBy(taskItem.position);
    expect(order.map((item) => item.id)).toEqual([two.id, one.id]);

    // A duplicate left at commit fails.
    expect(await pgErrorCode(newItem(row.id, 1))).toBe('23505');
    const other = await newTask(world, 2);
    await expect(newItem(other.id, 1)).resolves.toBeTruthy();
  });

  it('drops items with their task and keeps the waiver author', async () => {
    const world = await seed(db);
    const row = await newTask(world, 1);
    const [tomas] = await db
      .insert(user)
      .values({ name: 'Tomás', email: `tomas-${crypto.randomUUID()}@example.com` })
      .returning();
    if (!tomas) throw new Error('user insert failed');
    await newItem(row.id, 1, { state: 'waived', waivedReason: 'Out of scope', waivedById: tomas.id });
    expect(await pgErrorCode(db.delete(user).where(eq(user.id, tomas.id)))).toBe('23001');
    await db.delete(task).where(eq(task.id, row.id));
    const left = await db.select().from(taskItem).where(eq(taskItem.taskId, row.id));
    expect(left).toEqual([]);
  });

  it('indexes items by task, kind and position', async () => {
    const result = await db.execute<{ indexdef: string; deferrable: boolean; deferred: boolean }>(sql`
      select i.indexdef, c.condeferrable as deferrable, c.condeferred as deferred
      from pg_indexes i join pg_constraint c on c.conname = i.indexname
      where i.tablename = 'task_item' and i.indexname <> 'task_item_pkey'`);
    expect(result.rows).toEqual([
      {
        indexdef:
          'CREATE UNIQUE INDEX "task_item_taskId_kind_position_unique" ON public.task_item USING btree (task_id, kind, "position")',
        deferrable: true,
        deferred: true,
      },
    ]);
  });
});

describe('workspaces schema (0.10)', () => {
  let database: TestDatabase;
  let db: Db;

  beforeAll(async () => {
    database = await createTestDatabase();
    db = database.db;
  });

  afterAll(async () => {
    await database?.drop();
  });

  it('keeps old slugs per workspace, unique, in the slug format, and drops them with the workspace', async () => {
    const { workspace } = await seed(db);
    const [alias] = await db
      .insert(workspaceSlugAlias)
      .values({ slug: 'acme', workspaceId: workspace.id })
      .returning();
    expect(alias).toMatchObject({ slug: 'acme', workspaceId: workspace.id });
    expect(alias?.createdAt).toBeInstanceOf(Date);
    expect(
      await pgErrorCode(db.insert(workspaceSlugAlias).values({ slug: 'acme', workspaceId: workspace.id })),
    ).toBe('23505');
    await db
      .insert(workspaceSlugAlias)
      .values({ slug: `a${'b'.repeat(WORKSPACE_SLUG_MAX_LENGTH - 1)}`, workspaceId: workspace.id });
    for (const slug of [
      'A1',
      'a',
      '9lives',
      '-ab',
      'ab-',
      'a--b',
      'a_b',
      'a b',
      `a${'b'.repeat(WORKSPACE_SLUG_MAX_LENGTH)}`,
    ]) {
      expect(
        await pgErrorCode(db.insert(workspaceSlugAlias).values({ slug, workspaceId: workspace.id })),
        slug,
      ).toBe('23514');
    }
    await db.delete(organization).where(eq(organization.id, workspace.id));
    expect(
      await db.select().from(workspaceSlugAlias).where(eq(workspaceSlugAlias.workspaceId, workspace.id)),
    ).toEqual([]);
  });

  it('remembers the workspace a user used last until it is deleted', async () => {
    const { owner, workspace } = await seed(db);
    expect(owner.lastWorkspaceId).toBeNull();
    await db.update(user).set({ lastWorkspaceId: workspace.id }).where(eq(user.id, owner.id));
    const [stored] = await db.select().from(user).where(eq(user.id, owner.id));
    expect(stored?.lastWorkspaceId).toBe(workspace.id);
    expect(
      await pgErrorCode(
        db.update(user).set({ lastWorkspaceId: crypto.randomUUID() }).where(eq(user.id, owner.id)),
      ),
    ).toBe('23503');
    await db.delete(organization).where(eq(organization.id, workspace.id));
    const [after] = await db.select().from(user).where(eq(user.id, owner.id));
    expect(after?.lastWorkspaceId).toBeNull();
  });
});

describe('M7 schema', () => {
  let database: TestDatabase;
  let db: Db;

  beforeAll(async () => {
    database = await createTestDatabase();
    db = database.db;
  });

  afterAll(async () => {
    await database?.drop();
  });

  async function newTask(
    world: Awaited<ReturnType<typeof seed>>,
    number: number,
    values: Partial<typeof task.$inferInsert> = {},
  ) {
    const [row] = await db
      .insert(task)
      .values({
        projectId: world.pay.id,
        number,
        title: `Task ${number}`,
        createdById: world.owner.id,
        ...values,
      })
      .returning();
    if (!row) throw new Error('task insert failed');
    return row;
  }

  async function newRequest(
    world: Awaited<ReturnType<typeof seed>>,
    number: number,
    values: Partial<typeof pullRequest.$inferInsert> = {},
  ) {
    const [row] = await db
      .insert(pullRequest)
      .values({
        workspaceId: world.workspace.id,
        projectId: world.pay.id,
        number,
        title: `Request ${number}`,
        state: 'open',
        headBranch: `feat/request-${number}`,
        baseBranch: 'main',
        webUrl: `https://github.com/northwind/payments/pull/${number}`,
        openedAt: new Date('2026-11-26T09:00:00Z'),
        hostUpdatedAt: new Date('2026-11-26T09:00:00Z'),
        ...values,
      })
      .returning();
    if (!row) throw new Error('request insert failed');
    return row;
  }

  it('defaults the new task, project and activity columns to none', async () => {
    const world = await seed(db);
    const row = await newTask(world, 1);
    expect(row).toMatchObject({
      workBranch: null,
      closedAt: null,
      archivedAt: null,
      archivedById: null,
      mergedDoneAt: null,
      checkAgainOn: null,
      checkAgainReason: null,
    });
    expect(world.pay.archiveAfterDays).toBeNull();
    const [entry] = await db
      .insert(activity)
      .values({
        workspaceId: world.workspace.id,
        projectId: world.pay.id,
        taskId: row.id,
        type: 'task.archived',
      })
      .returning();
    expect(entry).toMatchObject({ cause: null, origin: 'app', actorId: null });
  });

  it('sets the check-again day and reason together, with a reason of 1 to 200 characters', async () => {
    const world = await seed(db);
    const row = await newTask(world, 1, {
      checkAgainOn: '2026-12-01',
      checkAgainReason: 'Wait for the bank',
    });
    expect(row).toMatchObject({ checkAgainOn: '2026-12-01', checkAgainReason: 'Wait for the bank' });
    await expect(
      newTask(world, 2, { checkAgainOn: '2026-12-01', checkAgainReason: 'x'.repeat(200) }),
    ).resolves.toBeTruthy();
    expect(await pgErrorCode(newTask(world, 3, { checkAgainOn: '2026-12-01' }))).toBe('23514');
    expect(await pgErrorCode(newTask(world, 3, { checkAgainReason: 'No day' }))).toBe('23514');
    expect(await pgErrorCode(newTask(world, 3, { checkAgainOn: '2026-12-01', checkAgainReason: '' }))).toBe(
      '23514',
    );
    expect(
      await pgErrorCode(newTask(world, 3, { checkAgainOn: '2026-12-01', checkAgainReason: 'x'.repeat(201) })),
    ).toBe('23514');
    // Clearing both at once is fine.
    await db.update(task).set({ checkAgainOn: null, checkAgainReason: null }).where(eq(task.id, row.id));
  });

  it('checks work branches, archive authors and archive days', async () => {
    const world = await seed(db);
    await expect(newTask(world, 1, { workBranch: 'x'.repeat(255) })).resolves.toBeTruthy();
    expect(await pgErrorCode(newTask(world, 2, { workBranch: '' }))).toBe('23514');
    expect(await pgErrorCode(newTask(world, 2, { workBranch: 'x'.repeat(256) }))).toBe('23514');
    // An author needs an archive date; the nightly job archives without one.
    expect(await pgErrorCode(newTask(world, 2, { archivedById: world.owner.id }))).toBe('23514');
    await expect(newTask(world, 2, { archivedAt: new Date() })).resolves.toBeTruthy();
    const byHand = await newTask(world, 3, { archivedAt: new Date(), archivedById: world.owner.id });
    expect(await pgErrorCode(db.delete(user).where(eq(user.id, world.owner.id)))).toBe('23001');
    expect(byHand.archivedById).toBe(world.owner.id);

    for (const days of [1, 14, 365, null]) {
      await db.update(project).set({ archiveAfterDays: days }).where(eq(project.id, world.pay.id));
    }
    for (const days of [0, 366, -1]) {
      expect(
        await pgErrorCode(
          db.update(project).set({ archiveAfterDays: days }).where(eq(project.id, world.pay.id)),
        ),
        String(days),
      ).toBe('23514');
    }
  });

  it('records git activity with a cause', async () => {
    const world = await seed(db);
    const row = await newTask(world, 1);
    const cause = {
      kind: 'pull_request' as const,
      provider: 'github',
      number: 482,
      url: 'https://github.com/northwind/payments/pull/482',
      title: 'Retry webhooks',
      event: 'merged',
      by: 'ana',
    };
    const [entry] = await db
      .insert(activity)
      .values({
        workspaceId: world.workspace.id,
        projectId: world.pay.id,
        taskId: row.id,
        type: 'task.updated',
        changes: [{ field: 'status', from: 'in_review', to: 'done' }],
        origin: 'git',
        originRef: cause.url,
        cause,
      })
      .returning();
    expect(entry).toMatchObject({ origin: 'git', actorId: null, cause });
    expect(
      await pgErrorCode(
        db.execute(sql`insert into activity (workspace_id, project_id, task_id, type, origin)
          values (${world.workspace.id}, ${world.pay.id}, ${row.id}, 'task.updated', 'github')`),
      ),
    ).toBe('23514');
  });

  it('keeps one repository link per project, with a unique webhook id and checked status', async () => {
    const world = await seed(db);
    const [connection] = await db
      .insert(gitConnection)
      .values({
        workspaceId: world.workspace.id,
        name: 'GitHub',
        provider: 'github',
        host: 'github.com',
        apiBaseUrl: 'https://api.github.com',
        tokenCiphertext: 'v1:abc',
        tokenHint: 'xyz',
        createdById: world.owner.id,
      })
      .returning();
    if (!connection) throw new Error('connection insert failed');
    const webhookId = `hook-${crypto.randomUUID()}`;
    const [link] = await db
      .insert(repositoryLink)
      .values({
        workspaceId: world.workspace.id,
        projectId: world.pay.id,
        repositoryKey: 'github.com/northwind/payments',
        connectionId: connection.id,
        webhookId,
      })
      .returning();
    expect(link).toMatchObject({
      closeOnMerge: true,
      defaultBranch: null,
      webhookSecretCiphertext: null,
      webhookLastStatus: null,
      syncedAt: null,
      syncCursor: null,
      syncError: null,
    });
    expect(link?.movesFrom).toBeInstanceOf(Date);
    const other = await seed(db);
    // One link per project; webhook ids are unique across workspaces.
    expect(
      await pgErrorCode(
        db.insert(repositoryLink).values({
          workspaceId: world.workspace.id,
          projectId: world.pay.id,
          repositoryKey: 'github.com/northwind/payments',
          webhookId: `hook-${crypto.randomUUID()}`,
        }),
      ),
    ).toBe('23505');
    expect(
      await pgErrorCode(
        db.insert(repositoryLink).values({
          workspaceId: other.workspace.id,
          projectId: other.pay.id,
          repositoryKey: 'github.com/northwind/payments',
          webhookId,
        }),
      ),
    ).toBe('23505');
    for (const status of ['ok', 'bad_signature', 'bad_payload'] as const) {
      await db
        .update(repositoryLink)
        .set({ webhookLastStatus: status })
        .where(eq(repositoryLink.id, link?.id as string));
    }
    expect(
      await pgErrorCode(
        db.execute(
          sql`update repository_link set webhook_last_status = 'late' where id = ${link?.id as string}`,
        ),
      ),
    ).toBe('23514');

    // Deleting the connection leaves the link reading without a token; deleting the project drops it.
    await db.delete(gitConnection).where(eq(gitConnection.id, connection.id));
    const [kept] = await db
      .select()
      .from(repositoryLink)
      .where(eq(repositoryLink.id, link?.id as string));
    expect(kept?.connectionId).toBeNull();
    await db.delete(project).where(eq(project.id, world.pay.id));
    expect(
      await db
        .select()
        .from(repositoryLink)
        .where(eq(repositoryLink.id, link?.id as string)),
    ).toEqual([]);
  });

  it('stores requests once per project and number, with checked states', async () => {
    const world = await seed(db);
    const request = await newRequest(world, 482);
    expect(request).toMatchObject({
      bodyKeys: [],
      author: null,
      mergedBy: null,
      mergedAt: null,
      closedAt: null,
    });
    const keyed = await newRequest(world, 483, { bodyKeys: ['PAY-1', 'PAY-2'], state: 'draft' });
    expect(keyed.bodyKeys).toEqual(['PAY-1', 'PAY-2']);
    expect(await pgErrorCode(newRequest(world, 482))).toBe('23505');
    expect(await pgErrorCode(newRequest(world, 0))).toBe('23514');
    expect(await pgErrorCode(newRequest(world, 484, { state: 'locked' as 'open' }))).toBe('23514');
    for (const state of ['merged', 'closed'] as const)
      await newRequest(world, state === 'merged' ? 485 : 486, { state });
    // The same number in another project is another request.
    const other = await seed(db);
    await expect(newRequest(other, 482)).resolves.toBeTruthy();
  });

  it('links tasks to requests once, keeps removals with their author, and drops links with either side', async () => {
    const world = await seed(db);
    const one = await newTask(world, 1);
    const two = await newTask(world, 2);
    const request = await newRequest(world, 482);
    const [link] = await db
      .insert(taskPullRequest)
      .values({ taskId: one.id, pullRequestId: request.id, viaHand: true, linkedById: world.owner.id })
      .returning();
    expect(link).toMatchObject({ viaBranch: false, viaDescription: false, viaHand: true, removedAt: null });
    expect(
      await pgErrorCode(db.insert(taskPullRequest).values({ taskId: one.id, pullRequestId: request.id })),
    ).toBe('23505');
    expect(
      await pgErrorCode(
        db
          .insert(taskPullRequest)
          .values({ taskId: two.id, pullRequestId: request.id, removedById: world.owner.id }),
      ),
    ).toBe('23514');
    await db.insert(taskPullRequest).values({
      taskId: two.id,
      pullRequestId: request.id,
      viaBranch: true,
      removedAt: new Date(),
      removedById: world.owner.id,
    });

    await db.delete(task).where(eq(task.id, one.id));
    expect(await db.select().from(taskPullRequest).where(eq(taskPullRequest.taskId, one.id))).toEqual([]);
    await db.delete(pullRequest).where(eq(pullRequest.id, request.id));
    expect(
      await db.select().from(taskPullRequest).where(eq(taskPullRequest.pullRequestId, request.id)),
    ).toEqual([]);
  });

  it('indexes the archive job, check-again days, merged tasks, work branches, archived tasks and requests', async () => {
    const result = await db.execute<{ indexname: string; indexdef: string }>(sql`
      select indexname, indexdef from pg_indexes
      where schemaname = 'public' and indexname in (
        'task_projectId_status_closedAt_idx',
        'task_assigneeId_checkAgainOn_idx',
        'task_projectId_mergedDone_idx',
        'task_projectId_workBranch_idx',
        'task_projectId_archived_idx',
        'pull_request_projectId_headBranch_idx',
        'task_pull_request_pullRequestId_idx',
        'repository_link_connectionId_idx')
      order by indexname`);
    expect(result.rows).toEqual([
      {
        indexname: 'pull_request_projectId_headBranch_idx',
        indexdef:
          'CREATE INDEX "pull_request_projectId_headBranch_idx" ON public.pull_request USING btree (project_id, head_branch)',
      },
      {
        indexname: 'repository_link_connectionId_idx',
        indexdef:
          'CREATE INDEX "repository_link_connectionId_idx" ON public.repository_link USING btree (connection_id)',
      },
      {
        indexname: 'task_assigneeId_checkAgainOn_idx',
        indexdef:
          'CREATE INDEX "task_assigneeId_checkAgainOn_idx" ON public.task USING btree (assignee_id, check_again_on) WHERE (check_again_on IS NOT NULL)',
      },
      {
        indexname: 'task_projectId_archived_idx',
        indexdef:
          'CREATE INDEX "task_projectId_archived_idx" ON public.task USING btree (project_id) WHERE (archived_at IS NOT NULL)',
      },
      {
        indexname: 'task_projectId_mergedDone_idx',
        indexdef:
          'CREATE INDEX "task_projectId_mergedDone_idx" ON public.task USING btree (project_id) WHERE (merged_done_at IS NOT NULL)',
      },
      {
        indexname: 'task_projectId_status_closedAt_idx',
        indexdef:
          "CREATE INDEX \"task_projectId_status_closedAt_idx\" ON public.task USING btree (project_id, status, closed_at) WHERE ((archived_at IS NULL) AND (status = ANY (ARRAY['done'::task_status, 'canceled'::task_status])))",
      },
      {
        indexname: 'task_projectId_workBranch_idx',
        indexdef:
          'CREATE INDEX "task_projectId_workBranch_idx" ON public.task USING btree (project_id, work_branch) WHERE (work_branch IS NOT NULL)',
      },
      {
        indexname: 'task_pull_request_pullRequestId_idx',
        indexdef:
          'CREATE INDEX "task_pull_request_pullRequestId_idx" ON public.task_pull_request USING btree (pull_request_id)',
      },
    ]);
  });
});

describe('globalSetup database', () => {
  it('is migrated and reachable through sharedTestDatabaseUrl()', async () => {
    const { db, pool } = createDb(sharedTestDatabaseUrl());
    try {
      const result = await db.execute<{ count: number }>(sql`select count(*)::int as count from project`);
      expect(result.rows[0]?.count).toBe(0);
    } finally {
      await pool.end();
    }
  });
});

describe('0.6.0 dashboard indexes', () => {
  it('exist after migrate, as btree indexes on the expected columns', async () => {
    const { db, pool } = createDb(sharedTestDatabaseUrl());
    try {
      const result = await db.execute<{ tablename: string; indexname: string; indexdef: string }>(sql`
        select tablename, indexname, indexdef from pg_indexes
        where schemaname = 'public' and indexname in (
          'activity_actorId_createdAt_idx',
          'comment_authorId_createdAt_idx',
          'milestone_projectId_status_targetDate_idx')
        order by indexname`);
      expect(result.rows).toEqual([
        {
          tablename: 'activity',
          indexname: 'activity_actorId_createdAt_idx',
          indexdef:
            'CREATE INDEX "activity_actorId_createdAt_idx" ON public.activity USING btree (actor_id, created_at)',
        },
        {
          tablename: 'comment',
          indexname: 'comment_authorId_createdAt_idx',
          indexdef:
            'CREATE INDEX "comment_authorId_createdAt_idx" ON public.comment USING btree (author_id, created_at)',
        },
        {
          tablename: 'milestone',
          indexname: 'milestone_projectId_status_targetDate_idx',
          indexdef:
            'CREATE INDEX "milestone_projectId_status_targetDate_idx" ON public.milestone USING btree (project_id, status, target_date)',
        },
      ]);
    } finally {
      await pool.end();
    }
  });
});
