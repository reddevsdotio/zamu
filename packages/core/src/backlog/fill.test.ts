// M6 work record fill on Postgres: the refresh writes the same values the m6_work_record migration
// backfills from 0.8.0 descriptions (checked by running the migration's SQL on every fixture file),
// the first refresh after an upgrade changes nothing, changes to the file read as history, and an
// import applies the Zamu block's waivers.
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { parseTask, renderDescription } from '@zamu/backlog-md';
import { BacklogBlock } from '@zamu/contracts';
import { migrationsFolder, schema } from '@zamu/db';
import { and, asc, eq, inArray, sql } from 'drizzle-orm';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { createWorld, type TestContext, testContext, type World } from '../testing/fixtures';
import { refreshBacklogSource } from './refresh';
import {
  configFile,
  createMirror,
  FakeProvider,
  FakeRepository,
  mirrorContext,
  NO_MAPPINGS,
  projectActivity,
  tasksByKey,
} from './testing';

const { backlogFile, task, taskItem } = schema;

/** The data migration of m6_work_record, limited to one project so other tests' rows stay as they are. */
function backfillFor(projectId: string): string {
  const text = readFileSync(join(migrationsFolder, '20261125110203_m6_work_record', 'migration.sql'), 'utf8');
  const block = text.slice(text.indexOf('DO $$'), text.lastIndexOf('$$;') + 3);
  const anchor = "WHERE jsonb_typeof(t.backlog_data) = 'object'";
  expect(block.split(anchor)).toHaveLength(2);
  if (!/^[0-9a-f-]{36}$/.test(projectId)) throw new Error('not a uuid');
  return block.replace(
    anchor,
    `WHERE t.project_id = '${projectId}' AND jsonb_typeof(t.backlog_data) = 'object'`,
  );
}

/** Everything the fill writes, per task, in a form that compares. */
async function workRecords(ctx: TestContext, projectId: string) {
  const rows = await ctx.db
    .select({
      id: task.id,
      backlogId: task.backlogId,
      description: task.description,
      plan: task.plan,
      finalSummary: task.finalSummary,
      backlogData: task.backlogData,
      updatedAt: task.updatedAt,
    })
    .from(task)
    .where(eq(task.projectId, projectId));
  const items = await ctx.db
    .select()
    .from(taskItem)
    .where(
      inArray(
        taskItem.taskId,
        rows.map((row) => row.id),
      ),
    )
    .orderBy(asc(taskItem.taskId), asc(taskItem.kind), asc(taskItem.position));
  return new Map(
    rows.map((row) => [
      row.backlogId as string,
      {
        description: row.description,
        plan: row.plan,
        finalSummary: row.finalSummary,
        implementationNotes: BacklogBlock.parse(row.backlogData ?? {}).implementationNotes,
        items: items
          .filter((item) => item.taskId === row.id)
          .map((item) => [item.kind, item.position, item.text, item.state, item.waivedReason, item.source]),
      },
    ]),
  );
}

/** Puts the project's tasks back the way 0.8.0 stored them: sections rendered into the description. */
async function downgrade(ctx: TestContext, repo: FakeRepository, sourceId: string) {
  const files = await ctx.db
    .select({ path: backlogFile.path, taskId: backlogFile.taskId })
    .from(backlogFile)
    .where(
      and(
        eq(backlogFile.sourceId, sourceId),
        sql`${backlogFile.taskId} is not null`,
        sql`${backlogFile.error} is null`,
      ),
    );
  const ids = files.map((file) => file.taskId as string);
  await ctx.db.delete(taskItem).where(inArray(taskItem.taskId, ids));
  for (const file of files) {
    const parsed = parseTask(file.path, repo.get(file.path) as string);
    if (!parsed.ok) throw new Error(`${file.path}: ${parsed.error.message}`);
    const rendered = renderDescription(parsed.value);
    await ctx.db
      .update(task)
      .set({
        description: rendered === '' ? null : rendered,
        plan: null,
        finalSummary: null,
        backlogData: sql`${task.backlogData} - 'implementationNotes'`,
        updatedAt: sql`${task.updatedAt}`,
      })
      .where(eq(task.id, file.taskId as string));
  }
}

describe('work record fill', () => {
  let base: TestContext;
  let world: World;
  let provider: FakeProvider;
  let ctx: ReturnType<typeof mirrorContext>;

  beforeAll(async () => {
    base = testContext();
    world = await createWorld(base.db);
    provider = new FakeProvider([]);
    ctx = mirrorContext(base, provider);
  });
  afterAll(async () => {
    await base?.close();
  });

  describe.each(['eras/2025-06-plain', 'eras/2025-09-markers', 'eras/2026-10-iso', 'snapshot'])(
    '%s',
    (root) => {
      it('matches the migration backfill, and the first refresh after an upgrade changes nothing', async () => {
        const repo = provider.add(
          FakeRepository.fromFixture(root, `reddevs/fill-${crypto.randomUUID().slice(0, 8)}`),
        );
        const { project, sourceId, first } = await createMirror(ctx, world, repo, { mappings: NO_MAPPINGS });
        expect(first?.outcome).toBe('applied');
        const filled = await workRecords(ctx, project.id);
        expect(filled.size).toBeGreaterThan(0);

        // The upgrade: 0.8.0 rows, then the migration's backfill.
        await downgrade(ctx, repo, sourceId);
        const [rendered] = await ctx.db
          .select({ n: sql<number>`count(*)`.mapWith(Number) })
          .from(task)
          .where(
            and(eq(task.projectId, project.id), sql`${task.description} like '%## Acceptance criteria%'`),
          );
        expect(rendered?.n).toBeGreaterThan(0);
        await ctx.db.execute(sql.raw(backfillFor(project.id)));
        const backfilled = await workRecords(ctx, project.id);
        for (const [id, record] of filled) expect(backfilled.get(id), id).toEqual(record);
        const activityBefore = (await projectActivity(ctx.db, project.id)).length;

        // Unchanged files: nothing to read, nothing to write.
        const unchanged = await refreshBacklogSource(ctx, sourceId, 'manual');
        expect(unchanged.result).toMatchObject({ created: 0, updated: 0, hidden: 0, restored: 0 });

        // A config change reads every file again: still nothing changes.
        const [config] = await ctx.db
          .select({ path: backlogFile.path })
          .from(backlogFile)
          .where(and(eq(backlogFile.sourceId, sourceId), eq(backlogFile.kind, 'config')));
        if (config) repo.set(config.path, `${repo.get(config.path)}\n# touched\n`).commit();
        const full = await refreshBacklogSource(ctx, sourceId, 'manual');
        expect(full.outcome).toBe('applied');
        if (config) expect(full.downloads).toBeGreaterThan(filled.size / 2);
        expect(full.result).toMatchObject({ created: 0, updated: 0, hidden: 0, restored: 0 });
        expect(await projectActivity(ctx.db, project.id)).toHaveLength(activityBefore);
        expect(await workRecords(ctx, project.id)).toEqual(backfilled);
      }, 120_000);
    },
  );

  const FOLDER = 'backlog';
  const PATH = `${FOLDER}/tasks/back-1 - Ledger.md`;
  function ledger(sections: {
    ac: string[];
    dod?: string[];
    plan?: string;
    notes?: string;
    summary?: string;
    zamu?: string;
  }) {
    const parts = [
      '---',
      'id: BACK-1',
      'title: Ledger',
      'status: To Do',
      "created_date: '2026-10-01 10:00'",
      '---',
      '',
      '## Description',
      '',
      '<!-- SECTION:DESCRIPTION:BEGIN -->',
      'Keep a ledger.',
      '<!-- SECTION:DESCRIPTION:END -->',
      '',
      '## Acceptance Criteria',
      '<!-- AC:BEGIN -->',
      ...sections.ac,
      '<!-- AC:END -->',
      '',
    ];
    if (sections.dod)
      parts.push('## Definition of Done', '<!-- DOD:BEGIN -->', ...sections.dod, '<!-- DOD:END -->', '');
    if (sections.plan) parts.push('## Implementation Plan', '', sections.plan, '');
    if (sections.notes) parts.push('## Implementation Notes', '', sections.notes, '');
    if (sections.summary) parts.push('## Final Summary', '', sections.summary, '');
    if (sections.zamu) parts.push(sections.zamu, '');
    return parts.join('\n');
  }

  it('writes items, plan and summary, and history entries for each change', async () => {
    const repo = provider.add(
      new FakeRepository(`reddevs/fill-history-${crypto.randomUUID().slice(0, 8)}`, {
        [`${FOLDER}/config.yml`]: configFile(),
        [PATH]: ledger({
          ac: ['- [ ] #1 Entries balance', '- [ ] #2 Refunds post an entry'],
          dod: ['- [ ] #1 Tests pass'],
          plan: '1. Table',
          notes: 'Started.',
        }),
      }),
    );
    const { project, key, sourceId } = await createMirror(ctx, world, repo, { mappings: NO_MAPPINGS });
    const row = (await tasksByKey(ctx.db, project.id, key)).get(`${key}-1`);
    expect(row).toMatchObject({ description: 'Keep a ledger.', plan: '1. Table', finalSummary: null });
    expect(row?.backlogData).toMatchObject({ implementationNotes: 'Started.' });
    const items = await ctx.db
      .select()
      .from(taskItem)
      .where(eq(taskItem.taskId, row?.id as string))
      .orderBy(asc(taskItem.kind), asc(taskItem.position));
    expect(items.map((item) => [item.kind, item.position, item.text, item.state, item.source])).toEqual([
      ['criterion', 1, 'Entries balance', 'open', 'backlog'],
      ['criterion', 2, 'Refunds post an entry', 'open', 'backlog'],
      ['done', 1, 'Tests pass', 'open', 'backlog'],
    ]);

    repo
      .set(
        PATH,
        ledger({
          ac: ['- [x] #1 Entries balance', '- [ ] #2 Refunds post a ledger entry', '- [ ] #3 Payouts too'],
          dod: [],
          plan: '1. Table\n2. Jobs',
          notes: 'Started. Then jobs.',
          summary: 'Shipped.',
        }),
      )
      .commit();
    const outcome = await refreshBacklogSource(ctx, sourceId, 'manual');
    expect(outcome.result).toMatchObject({ updated: 1 });
    const entries = (await projectActivity(ctx.db, project.id)).filter(
      (entry) => entry.type === 'task.updated',
    );
    expect(entries).toHaveLength(1);
    expect(entries[0]).toMatchObject({ actorId: null, origin: 'backlog', originRef: repo.head });
    expect(entries[0]?.changes).toEqual([
      { field: 'criterion.checked', number: 1, text: 'Entries balance' },
      {
        field: 'criterion.edited',
        number: 2,
        text: 'Refunds post a ledger entry',
        from: 'Refunds post an entry',
      },
      { field: 'criterion.added', number: 3, text: 'Payouts too' },
      { field: 'doneItem.removed', number: 1, text: 'Tests pass' },
      { field: 'plan', from: '1. Table', to: '1. Table\n2. Jobs' },
      { field: 'finalSummary', from: null, to: 'Shipped.' },
      { field: 'backlog', from: null, to: ['implementationNotes'] },
    ]);
    const after = await ctx.db
      .select({ kind: taskItem.kind, text: taskItem.text, state: taskItem.state })
      .from(taskItem)
      .where(eq(taskItem.taskId, row?.id as string))
      .orderBy(asc(taskItem.kind), asc(taskItem.position));
    expect(after).toEqual([
      { kind: 'criterion', text: 'Entries balance', state: 'checked' },
      { kind: 'criterion', text: 'Refunds post a ledger entry', state: 'open' },
      { kind: 'criterion', text: 'Payouts too', state: 'open' },
    ]);
  });

  it('an import applies the waivers of the Zamu block; its items are the app’s', async () => {
    const zamu = [
      '<!-- zamu:start -->',
      '```yaml',
      'waived:',
      '  - kind: criterion',
      '    number: 2',
      '    text: Load test passes',
      '    reason: Replaced by a replay',
      '```',
      '<!-- zamu:end -->',
    ].join('\n');
    const repo = provider.add(
      new FakeRepository(`reddevs/fill-import-${crypto.randomUUID().slice(0, 8)}`, {
        [`${FOLDER}/config.yml`]: configFile(),
        [PATH]: ledger({ ac: ['- [x] #1 Entries balance', '- [ ] #2 Load test passes'], zamu }),
      }),
    );
    const { project, key } = await createMirror(ctx, world, repo, { mappings: NO_MAPPINGS, mode: 'import' });
    const row = (await tasksByKey(ctx.db, project.id, key)).get(`${key}-1`);
    expect(row?.description).toBe('Keep a ledger.');
    const items = await ctx.db
      .select()
      .from(taskItem)
      .where(eq(taskItem.taskId, row?.id as string))
      .orderBy(asc(taskItem.position));
    expect(
      items.map((item) => [item.text, item.state, item.waivedReason, item.waivedById, item.source]),
    ).toEqual([
      ['Entries balance', 'checked', null, null, 'app'],
      ['Load test passes', 'waived', 'Replaced by a replay', null, 'app'],
    ]);
  });
});
