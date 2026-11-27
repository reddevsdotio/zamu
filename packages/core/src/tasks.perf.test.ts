// M5 plan risk "List performance": listTasks on a project with 5,000 tasks that carry labels,
// blockers, subtasks and due dates (M6: and criteria and done items, counted per row). Prints the median time of each listing and fails when one
// takes longer than a generous bound (the list fields are read for the page, not per row). M8: the
// same listings again once every task sits in a wave of one of ten milestones, with gate results,
// so the timings show what the one wave query per page costs.
import { schema } from '@zamu/db';
import { sql } from 'drizzle-orm';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { createProject } from './projects';
import { listTasks } from './tasks';
import {
  createWorld,
  projectRow,
  randomProjectKey,
  type TestContext,
  testContext,
  type World,
} from './testing/fixtures';

const TASKS = 5_000;
const LABELS = 12;
/** Median per listing, well above what a laptop and CI need (tens of milliseconds). */
const BOUND_MS = 750;

describe('listTasks on 5,000 tasks', () => {
  let ctx: TestContext;
  let world: World;
  let key: string;
  let labelIds: string[];

  beforeAll(async () => {
    ctx = testContext();
    ctx = { ...ctx, now: () => new Date('2026-11-04T12:00:00Z') };
    world = await createWorld(ctx.db);
    key = randomProjectKey();
    await createProject(ctx, world.ownerActor, { name: 'Big', key });
    const project = await projectRow(ctx.db, world.workspaceId, key);
    const { task, label, taskLabel, taskDependency, taskItem } = schema;
    await ctx.db.execute(sql`
      insert into ${task} (project_id, number, title, status, priority, created_by_id, assignee_id, due_date, rank)
      select ${project.id}, n, 'Task ' || n,
        (array['backlog','todo','in_progress','in_review','done','canceled'])[1 + n % 6]::task_status,
        n % 5, ${world.owner.id}, case when n % 2 = 0 then ${world.member.id}::uuid end,
        case when n % 3 = 0 then null else date '2026-11-04' + (n % 40 - 10) end, n
      from generate_series(1, ${TASKS}) as n`);
    await ctx.db.execute(
      sql`update ${schema.project} set next_task_number = ${TASKS + 1} where id = ${project.id}`,
    );
    await ctx.db.execute(sql`
      insert into ${label} (workspace_id, project_id, name, color)
      select ${world.workspaceId}, ${project.id}, 'label-' || n, 1 + n % 9 from generate_series(1, ${LABELS}) as n`);
    // 0 to 3 labels per task.
    await ctx.db.execute(sql`
      insert into ${taskLabel} (task_id, label_id)
      select t.id, l.id from ${task} t
      cross join lateral (
        select id from ${label} where project_id = ${project.id} order by name offset (t.number % ${LABELS}) limit (t.number % 4)
      ) l
      where t.project_id = ${project.id}`);
    // Every fourth task waits on the one before, every tenth on the one seven before: no loops.
    await ctx.db.execute(sql`
      insert into ${taskDependency} (task_id, blocker_id)
      select t.id, b.id from ${task} t join ${task} b on b.project_id = t.project_id
        and (b.number = t.number - 1 and t.number % 4 = 0 or b.number = t.number - 7 and t.number % 10 = 0)
      where t.project_id = ${project.id}
      on conflict do nothing`);
    // Tasks n % 5 = 1 are subtasks of the task before (n % 5 = 0, top level).
    await ctx.db.execute(sql`
      update ${task} t set parent_id = p.id from ${task} p
      where t.project_id = ${project.id} and p.project_id = t.project_id
        and t.number % 5 = 1 and p.number = t.number - 1`);
    // M6: 0 to 5 criteria and 0 to 2 done items per task, in every state.
    await ctx.db.execute(sql`
      insert into ${taskItem} (task_id, kind, position, text, state, waived_reason)
      select t.id, k.kind, p, k.kind || ' ' || p,
        (array['open','checked','waived'])[1 + (t.number + p) % 3],
        case when (t.number + p) % 3 = 2 then 'Covered elsewhere' end
      from ${task} t
      cross join (values ('criterion', 6), ('done', 3)) as k(kind, n)
      cross join lateral generate_series(1, t.number % k.n) as p
      where t.project_id = ${project.id}`);
    await ctx.db.execute(sql`analyze ${task}, ${taskLabel}, ${taskDependency}, ${label}, ${taskItem}`);
    const rows = await ctx.db.execute<{ id: string }>(
      sql`select id from ${label} where project_id = ${project.id} order by name limit 2`,
    );
    labelIds = rows.rows.map((row) => row.id);
  }, 120_000);
  afterAll(async () => {
    await ctx?.close();
  });

  async function median(run: () => Promise<unknown>): Promise<number> {
    await run();
    const times: number[] = [];
    for (let i = 0; i < 5; i++) {
      const start = performance.now();
      await run();
      times.push(performance.now() - start);
    }
    return times.sort((a, b) => a - b)[2] as number;
  }

  function listCases(): [string, Parameters<typeof listTasks>[2]][] {
    return [
      ['list order, 50', { project: key }],
      ['list order, 200', { project: key, limit: 200 }],
      ['board order, 200', { project: key, order: 'board', limit: 200 }],
      ['sort=due, 200', { project: key, sort: 'due', limit: 200 }],
      ['sort=priority', { project: key, sort: 'priority' }],
      ['sort=updated', { project: key, sort: 'updated' }],
      ['sort=created', { project: key, sort: 'created' }],
      ['sort=manual', { project: key, sort: 'manual' }],
      ['label any of 2', { project: key, label: labelIds }],
      ['due=overdue', { project: key, due: 'overdue' }],
      ['due=soon', { project: key, due: 'soon' }],
      ['blocked=true', { project: key, blocked: true }],
      ['blocked=false, topLevel', { project: key, blocked: false, topLevel: true }],
      ['workspace-wide, sort=due', { sort: 'due' }],
    ];
  }

  async function timeCases(cases: [string, Parameters<typeof listTasks>[2]][]) {
    const timings: Record<string, string> = {};
    for (const [name, input] of cases) {
      const ms = await median(() => listTasks(ctx, world.memberActor, input));
      timings[name] = `${ms.toFixed(1)} ms`;
      expect(ms, name).toBeLessThan(BOUND_MS);
    }
    return timings;
  }

  it('lists pages with labels, blockers and progress quickly for every ordering and filter', async () => {
    const cases = listCases();
    const first = await listTasks(ctx, world.memberActor, { project: key, sort: 'due', limit: 200 });
    expect(first.items).toHaveLength(200);
    expect(first.items.some((item) => (item.labels?.length ?? 0) > 0)).toBe(true);
    expect(first.items.some((item) => item.blocked)).toBe(true);
    expect(first.items.some((item) => (item.subtaskProgress?.total ?? 0) > 0)).toBe(true);
    expect(first.items.some((item) => item.parentKey)).toBe(true);
    expect(first.items.some((item) => (item.criteriaProgress?.waived ?? 0) > 0)).toBe(true);
    expect(first.items.some((item) => (item.doneProgress?.total ?? 0) > 0)).toBe(true);
    cases.push([
      'sort=due, page 2',
      { project: key, sort: 'due', limit: 200, cursor: first.nextCursor ?? undefined },
    ]);

    console.info(`listTasks on ${TASKS} tasks (median of 5):`, await timeCases(cases));
  }, 120_000);

  it('M8: lists as quickly with every task in a wave', async () => {
    const project = await projectRow(ctx.db, world.workspaceId, key);
    const { gateResult, milestone, task, wave } = schema;
    // Ten milestones of six waves; W1 to W3 passed, W4 failed, W5 and W6 open (locked).
    await ctx.db.execute(sql`
      insert into ${milestone} (workspace_id, project_id, name, created_by_id)
      select ${world.workspaceId}, ${project.id}, 'Milestone ' || n, ${world.owner.id}
      from generate_series(1, 10) as n`);
    await ctx.db.execute(sql`
      insert into ${wave} (workspace_id, milestone_id, position, name, created_by_id)
      select ${world.workspaceId}, m.id, p, 'Wave ' || p, ${world.owner.id}
      from ${milestone} m cross join generate_series(1, 6) as p
      where m.project_id = ${project.id}`);
    await ctx.db.execute(sql`
      insert into ${gateResult} (workspace_id, wave_id, state, note, actor_id)
      select ${world.workspaceId}, w.id, case when w.position = 4 then 'failed' else 'passed' end, 'Checked',
        ${world.owner.id}
      from ${wave} w join ${milestone} m on m.id = w.milestone_id
      where m.project_id = ${project.id} and w.position <= 4`);
    await ctx.db.execute(sql`
      update ${task} t set milestone_id = w.milestone_id, wave_id = w.id
      from (
        select w.id, w.milestone_id, row_number() over (order by m.name, w.position) - 1 as k
        from ${wave} w join ${milestone} m on m.id = w.milestone_id
        where m.project_id = ${project.id}
      ) w
      -- Statuses repeat every 6 numbers (see the seed), so spread waves across each status.
      where t.project_id = ${project.id} and (t.number / 6) % 60 = w.k`);
    await ctx.db.execute(sql`analyze ${task}, ${wave}, ${gateResult}, ${milestone}`);
    const page = await listTasks(ctx, world.memberActor, { project: key, limit: 200 });
    expect(page.items.every((item) => item.wave)).toBe(true);
    expect(page.items.some((item) => item.wave?.locked)).toBe(true);
    console.info(`M8 listTasks on ${TASKS} tasks in waves (median of 5):`, await timeCases(listCases()));
  }, 120_000);
});
