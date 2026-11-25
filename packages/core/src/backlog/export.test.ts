// M6: the Backlog.md export on Postgres. A seeded native project with waived items is exported,
// read back with @zamu/backlog-md's reader, and imported into a new project: the same tasks come
// back, waivers included. A mirror refuses; a switched mirror keeps its Backlog.md ids.
import { parseBacklogFolder, taskWorkRecord } from '@zamu/backlog-md';
import { BACKLOG_EXPORT_PREFIXES, BacklogExport, type BacklogMappings } from '@zamu/contracts';
import { schema } from '@zamu/db';
import { asc, eq, inArray } from 'drizzle-orm';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { Forbidden, ProjectMirrored } from '../errors';
import {
  addTaskBlockers,
  addTaskLabels,
  createCommentRow,
  createLabelRow,
  createMilestoneRow,
  createTaskItemRows,
  createTaskRow,
  createWorld,
  keyActor,
  randomProjectKey,
  scopeOf,
  type TestContext,
  testContext,
  type World,
} from '../testing/fixtures';
import { exportBacklog } from './export';
import { switchBacklogToZamu } from './switch';
import {
  configFile,
  createMirror,
  FakeProvider,
  FakeRepository,
  mirrorContext,
  NO_MAPPINGS,
  taskFile,
  taskPath,
  tasksByKey,
} from './testing';

const NOW = new Date('2031-03-04T05:06:07.000Z');
const STATUSES = ['Backlog', 'To Do', 'In Progress', 'In Review', 'Done', 'Canceled'];

describe('exportBacklog', () => {
  let base: TestContext;
  let world: World;
  let provider: FakeProvider;
  let ctx: ReturnType<typeof mirrorContext>;

  beforeAll(async () => {
    base = testContext();
    world = await createWorld(base.db);
    provider = new FakeProvider([]);
    ctx = { ...mirrorContext(base, provider), now: () => NOW };
  });
  afterAll(async () => {
    await base?.close();
  });

  /** A native project with the parts a Backlog.md file can hold, waivers and work notes included. */
  async function seed() {
    const key = randomProjectKey();
    const [project] = await base.db
      .insert(schema.project)
      .values({ workspaceId: world.workspaceId, key, name: `Payments ${key}`, usesMilestones: true })
      .returning();
    if (!project) throw new Error('project insert failed');
    const scope = scopeOf(project);
    const milestone = await createMilestoneRow(base.db, scope, {
      createdById: world.owner.id,
      name: 'Webhooks v2',
      description: 'Retries and signatures.',
      targetDate: '2031-04-01',
    });
    const webhooks = await createLabelRow(base.db, scope, { name: 'webhooks' });
    const backend = await createLabelRow(base.db, scope, { name: 'backend' });
    const by = { createdById: world.owner.id };

    const retry = await createTaskRow(base.db, project.id, {
      ...by,
      title: 'Retry failed webhook deliveries',
      description: 'Webhooks that fail are retried.\n\n```sh\n## Final summary\n```',
      status: 'in_progress',
      priority: 3,
      assigneeId: world.agent.id,
      milestoneId: milestone.id,
      dueDate: '2031-03-20',
      plan: '1. Queue\n2. Backoff',
      rank: 1000,
      createdAt: new Date('2031-01-02T03:04:05.000Z'),
    });
    await createTaskItemRows(base.db, retry.id, 'criterion', [
      { text: 'Retries use backoff', state: 'checked' },
      {
        text: 'Load test passes',
        state: 'waived',
        waivedReason: 'Replaced by a replay',
        waivedById: world.owner.id,
      },
      'Gives up after 5 tries',
    ]);
    await createTaskItemRows(base.db, retry.id, 'done', ['Tests pass']);
    await addTaskLabels(base.db, retry.id, [webhooks.id, backend.id]);
    await createCommentRow(base.db, scope, {
      taskId: retry.id,
      authorId: world.agent.id,
      onBehalfOfId: world.member.id,
      kind: 'note',
      body: 'Queue written and tested.',
      createdAt: new Date('2031-01-03T10:00:00.000Z'),
    });
    await createCommentRow(base.db, scope, {
      taskId: retry.id,
      authorId: world.owner.id,
      kind: 'note',
      body: `Checked with [@${world.member.name}](mention:${world.member.id}).`,
      createdAt: new Date('2031-01-04T10:00:00.000Z'),
    });
    await createCommentRow(base.db, scope, {
      taskId: retry.id,
      authorId: world.owner.id,
      body: 'A plain comment',
    });

    const ledger = await createTaskRow(base.db, project.id, {
      ...by,
      title: 'Ledger table',
      status: 'done',
      priority: 2,
      finalSummary: 'Ledger rows post on every refund.',
    });
    await createTaskItemRows(base.db, ledger.id, 'done', [
      { text: 'Docs updated', state: 'waived', waivedReason: 'No docs for an internal table' },
    ]);
    const sub = await createTaskRow(base.db, project.id, {
      ...by,
      title: 'Signature check',
      status: 'todo',
      parentId: retry.id,
    });
    await addTaskBlockers(base.db, sub.id, [ledger.id]);
    const canceled = await createTaskRow(base.db, project.id, {
      ...by,
      title: 'Old idea',
      status: 'canceled',
    });
    const hidden = await createTaskRow(base.db, project.id, { ...by, title: 'Gone', hiddenAt: NOW });
    const urgent = await createTaskRow(base.db, project.id, {
      ...by,
      title: 'Hotfix: duplicate "refunds" / payouts?',
      status: 'backlog',
      priority: 4,
    });
    // Backlog.md ids take the letters of the key: a key like P4Y writes PY-12.
    const prefix = key.replace(/[^A-Z]/g, '');
    return { project, key, prefix, retry, ledger, sub, canceled, hidden, urgent, milestone };
  }

  it('writes tasks, completed tasks and milestones as Backlog.md files the reader reads back', async () => {
    const seeded = await seed();
    const exported = await exportBacklog(ctx, world.memberActor, { project: seeded.key });
    expect(BacklogExport.parse(exported)).toEqual(exported);
    expect(exported).toMatchObject({
      project: seeded.key,
      format: 'backlog.md 1.57',
      generatedAt: NOW.toISOString(),
      removedPrefixes: [...BACKLOG_EXPORT_PREFIXES],
    });
    const key = seeded.prefix.toLowerCase();
    const n = (row: { number: number }) => row.number;
    expect(exported.files.map((file) => file.path)).toEqual([
      'milestones/m-0 - webhooks-v2.md',
      `tasks/${key}-${n(seeded.retry)} - Retry-failed-webhook-deliveries.md`,
      `tasks/${key}-${n(seeded.ledger)} - Ledger-table.md`,
      `tasks/${key}-${n(seeded.sub)} - Signature-check.md`,
      `tasks/${key}-${n(seeded.canceled)} - Old-idea.md`,
      `tasks/${key}-${n(seeded.urgent)} - Hotfix-duplicate-refunds-payouts.md`,
    ]);

    // The export leaves config.yml alone; the folder it lands in names the same task prefix.
    const folder = parseBacklogFolder(
      [
        { path: 'backlog/config.yml', text: configFile({ prefix: key, statuses: STATUSES }) },
        ...exported.files.map((file) => ({ path: `backlog/${file.path}`, text: file.content })),
      ],
      'backlog',
    );
    expect(folder.files.every((file) => file.result.ok && file.result.warnings.length === 0)).toBe(true);
    const byId = new Map(
      folder.files.flatMap((file) =>
        file.result.ok && 'sections' in file.result.value
          ? [[file.result.value.id.id, file.result.value]]
          : [],
      ),
    );
    const id = (row: { number: number }) => `${seeded.prefix}-${row.number}`;
    const retry = byId.get(id(seeded.retry));
    expect(retry).toMatchObject({
      title: 'Retry failed webhook deliveries',
      status: 'In Progress',
      priority: 'high',
      assignees: [`@${world.agent.name}`],
      labels: ['backend', 'webhooks'],
      milestone: 'm-0',
      dueDate: '2031-03-20',
      createdDate: new Date('2031-01-02T03:04:05.000Z'),
      ordinal: 1000,
    });
    expect(retry && taskWorkRecord(retry)).toEqual({
      description: 'Webhooks that fail are retried.\n\n```sh\n## Final summary\n```',
      criteria: [
        { text: 'Retries use backoff', state: 'checked', waivedReason: null },
        { text: 'Load test passes', state: 'waived', waivedReason: 'Replaced by a replay' },
        { text: 'Gives up after 5 tries', state: 'open', waivedReason: null },
      ],
      doneItems: [{ text: 'Tests pass', state: 'open', waivedReason: null }],
      plan: '1. Queue\n2. Backoff',
      finalSummary: null,
      implementationNotes: [
        `**${world.agent.name} (for ${world.member.name})** · 2031-01-03 10:00 UTC`,
        '',
        'Queue written and tested.',
        '',
        `**${world.owner.name}** · 2031-01-04 10:00 UTC`,
        '',
        `Checked with @${world.member.name}.`,
      ].join('\n'),
    });
    expect(byId.get(id(seeded.sub))).toMatchObject({
      parentId: id(seeded.retry),
      dependencies: [id(seeded.ledger)],
      status: 'To Do',
    });
    expect(byId.get(id(seeded.urgent))).toMatchObject({ status: 'Backlog', priority: 'urgent' });
    expect(byId.get(id(seeded.canceled))).toMatchObject({ status: 'Canceled' });
    expect(byId.has(id(seeded.hidden))).toBe(false);
    const milestones = folder.files.flatMap((file) =>
      file.result.ok && !('sections' in file.result.value) ? [file.result.value] : [],
    );
    expect(milestones).toMatchObject([
      { id: 'm-0', title: 'Webhooks v2', description: 'Retries and signatures.', dueDate: '2031-04-01' },
    ]);
  });

  it('an import of the export gets the same tasks back, waivers included', async () => {
    const seeded = await seed();
    const exported = await exportBacklog(ctx, world.ownerActor, { project: seeded.key });
    const repo = new FakeRepository(`reddevs/export-${crypto.randomUUID().slice(0, 8)}`, {
      'backlog/config.yml': configFile({ prefix: seeded.prefix.toLowerCase(), statuses: STATUSES }),
      ...Object.fromEntries(exported.files.map((file) => [`backlog/${file.path}`, file.content])),
    });
    provider.add(repo);
    const status = (from: string, to: BacklogMappings['status'][number]['to']) => ({
      from,
      to,
      how: 'name' as const,
    });
    const mappings: BacklogMappings = {
      status: [
        status('Backlog', 'backlog'),
        status('To Do', 'todo'),
        status('In Progress', 'in_progress'),
        status('In Review', 'in_review'),
        status('Done', 'done'),
        status('Canceled', 'canceled'),
      ],
      priority: [
        { from: 'medium', to: 'medium', how: 'name' },
        { from: 'high', to: 'high', how: 'name' },
        { from: 'urgent', to: 'urgent', how: 'name' },
      ],
      assignee: [{ from: `@${world.agent.name}`, userId: world.agent.id, how: 'manual' }],
    };
    const imported = await createMirror(ctx, world, repo, { mode: 'import', mappings });
    expect(imported.first?.result).toMatchObject({ created: 5, detached: true });

    const shape = async (projectId: string) => {
      const tasks = await base.db.select().from(schema.task).where(eq(schema.task.projectId, projectId));
      const visible = tasks.filter((row) => row.hiddenAt === null);
      const numberOf = new Map(tasks.map((row) => [row.id, row.number]));
      const ids = visible.map((row) => row.id);
      const items = await base.db
        .select()
        .from(schema.taskItem)
        .where(inArray(schema.taskItem.taskId, ids))
        .orderBy(asc(schema.taskItem.kind), asc(schema.taskItem.position));
      const labels = await base.db
        .select({ taskId: schema.taskLabel.taskId, name: schema.label.name })
        .from(schema.taskLabel)
        .innerJoin(schema.label, eq(schema.label.id, schema.taskLabel.labelId))
        .where(inArray(schema.taskLabel.taskId, ids));
      const blockers = await base.db
        .select()
        .from(schema.taskDependency)
        .where(inArray(schema.taskDependency.taskId, ids));
      const milestones = await base.db
        .select()
        .from(schema.milestone)
        .where(eq(schema.milestone.projectId, projectId));
      return visible
        .map((row) => ({
          number: row.number,
          title: row.title,
          description: row.description,
          status: row.status,
          priority: row.priority,
          assigneeId: row.assigneeId,
          dueDate: row.dueDate,
          createdAt: Math.floor(row.createdAt.getTime() / 1000),
          plan: row.plan,
          finalSummary: row.finalSummary,
          milestone: milestones.find((entry) => entry.id === row.milestoneId)?.name ?? null,
          parent: row.parentId ? numberOf.get(row.parentId) : null,
          labels: labels
            .filter((entry) => entry.taskId === row.id)
            .map((entry) => entry.name)
            .sort(),
          blockers: blockers
            .filter((entry) => entry.taskId === row.id)
            .map((entry) => numberOf.get(entry.blockerId)),
          items: items
            .filter((item) => item.taskId === row.id)
            .map((item) => [item.kind, item.position, item.text, item.state, item.waivedReason]),
        }))
        .sort((a, b) => a.number - b.number);
    };
    expect(await shape(imported.project.id)).toEqual(await shape(seeded.project.id));
  });

  it('refuses while the project mirrors; a switched mirror keeps its Backlog.md ids and file notes', async () => {
    const repo = provider.add(
      new FakeRepository(`reddevs/export-mirror-${crypto.randomUUID().slice(0, 8)}`, {
        'backlog/config.yml': configFile(),
        [taskPath('backlog', 'back-7', 'Seven')]: taskFile({
          id: 'BACK-7',
          title: 'Seven',
          assignee: ['@ana', '@someone'],
        }).concat(
          '\n## Implementation Notes\n\n<!-- SECTION:NOTES:BEGIN -->\nFrom the file.\n<!-- SECTION:NOTES:END -->\n',
        ),
      }),
    );
    const mappings = {
      ...NO_MAPPINGS,
      assignee: [{ from: '@ana', userId: world.owner.id, how: 'manual' as const }],
    };
    const { key, project } = await createMirror(ctx, world, repo, { mappings });
    const refused = exportBacklog(ctx, world.ownerActor, { project: key });
    await expect(refused).rejects.toBeInstanceOf(ProjectMirrored);
    await expect(refused).rejects.toMatchObject({ code: 'PROJECT_MIRRORED' });

    await switchBacklogToZamu(ctx, world.ownerActor, { projectKey: key, confirmKey: key });
    const seven = (await tasksByKey(base.db, project.id, key)).get(`${key}-7`);
    await createCommentRow(base.db, scopeOf(project), {
      taskId: seven?.id as string,
      authorId: world.owner.id,
      kind: 'note',
      body: 'Switched.',
      createdAt: new Date('2031-02-01T00:00:00.000Z'),
    });
    const exported = await exportBacklog(ctx, world.ownerActor, { project: key });
    expect(exported.files.map((file) => file.path)).toEqual(['tasks/back-7 - Seven.md']);
    const content = exported.files[0]?.content ?? '';
    expect(content).toContain('id: BACK-7');
    expect(content).toContain("assignee:\n  - '@ana'\n  - '@someone'\n");
    expect(content).toContain('status: To Do');
    expect(content).toContain(
      `From the file.\n\n**${world.owner.name}** · 2031-02-01 00:00 UTC\n\nSwitched.`,
    );
  });

  it('needs read access to the project; a read-only key is enough', async () => {
    const seeded = await seed();
    const elsewhere = keyActor(world, { projects: [crypto.randomUUID()], access: 'read' });
    await expect(exportBacklog(ctx, elsewhere, { project: seeded.key })).rejects.toBeInstanceOf(Forbidden);
    const reader = keyActor(world, { projects: [seeded.project.id], access: 'read' });
    await expect(exportBacklog(ctx, reader, { project: seeded.key })).resolves.toMatchObject({
      project: seeded.key,
    });
  });
});
