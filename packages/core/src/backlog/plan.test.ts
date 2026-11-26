// Pure planner tests on the parser's fixture folders (read from disk, never copied).
import { type FolderFile, parseBacklogFolder } from '@zamu/backlog-md';
import { readFixtureTree } from '@zamu/backlog-md/testing/fixtures';
import type { BacklogMappings, BacklogProblem } from '@zamu/contracts';
import { describe, expect, it } from 'vitest';
import { prefillMappings } from './mappings';
import {
  type BacklogPlan,
  type ExistingState,
  type ExistingTask,
  idFromFileName,
  type LabelTarget,
  type PlanFile,
  type PlanInput,
  planChangesContent,
  planRefresh,
  stableJson,
  type TaskTarget,
  type TaskValues,
} from './plan';
import { blobSha, configFile, taskFile, taskPath } from './testing';

const NOW = new Date('2026-10-23T12:00:00Z');
const EMPTY: BacklogMappings = { status: [], priority: [], assignee: [] };

function emptyExisting(): ExistingState {
  return {
    tasks: [],
    milestones: [],
    files: [],
    nextTaskNumber: 1,
    firstRead: true,
    problems: [],
    labels: [],
  };
}

/** Parses a folder held in memory into planner input. */
function input(files: FolderFile[], folder: string, overrides: Partial<PlanInput> = {}): PlanInput {
  const parsed = parseBacklogFolder(files, folder);
  const sha = new Map(files.map((file) => [file.path, blobSha(file.text)]));
  // ParsedFile and PlanFile pair kind and result the same way.
  const planFiles = parsed.files.map((file) => ({
    path: file.path,
    blobSha: sha.get(file.path) as string,
    kind: file.kind,
    read: file.result,
  })) as PlanFile[];
  return {
    projectKey: 'PAY',
    folder,
    commit: 'c1',
    now: NOW,
    config: parsed.effectiveConfig,
    configFile: parsed.config
      ? { path: parsed.config.path, blobSha: sha.get(parsed.config.path) as string }
      : null,
    files: planFiles,
    mappings: EMPTY,
    memberIds: null,
    existing: emptyExisting(),
    ...overrides,
  };
}

/** Plans once with empty mappings to collect values, then again with mappings prefilled by name. */
function planWithPrefill(files: FolderFile[], folder: string, overrides: Partial<PlanInput> = {}) {
  const first = planRefresh(input(files, folder, overrides));
  const mappings = prefillMappings(first.seen, []);
  return { plan: planRefresh(input(files, folder, { ...overrides, mappings })), mappings };
}

/** What the apply would leave behind, in memory: rows with ids for the next plan. */
function applyInMemory(plan: BacklogPlan, before: ExistingState): ExistingState {
  const tasks = new Map(before.tasks.map((task) => [task.id, { ...task }]));
  const milestones = new Map(before.milestones.map((row) => [row.id, { ...row }]));
  const milestoneIds = new Map<string, string>();
  for (const row of before.milestones) if (row.backlogId) milestoneIds.set(row.backlogId, row.id);
  for (const create of plan.milestones.creates) {
    const id = `m:${create.backlogId}`;
    milestoneIds.set(create.backlogId, id);
    milestones.set(id, { id, ...create, hiddenAt: null });
  }
  const resolve = (target: { id: string } | { backlogId: string } | null) =>
    target === null ? null : 'id' in target ? target.id : (milestoneIds.get(target.backlogId) as string);
  for (const update of plan.milestones.updates) {
    Object.assign(milestones.get(update.id) as object, update.set, update.restore ? { hiddenAt: null } : {});
  }
  for (const hide of plan.milestones.hides)
    (milestones.get(hide.id) as { hiddenAt: Date | null }).hiddenAt = NOW;
  const labels = new Map(before.labels.map((row) => [row.id, { ...row }]));
  for (const create of plan.labels.creates) {
    const id = `l:${create.name.toLowerCase()}`;
    labels.set(id, { id, ...create, source: 'backlog' });
  }
  for (const { id } of plan.labels.adopt) (labels.get(id) as { source: string }).source = 'backlog';
  const labelId = (target: LabelTarget) => ('id' in target ? target.id : `l:${target.name.toLowerCase()}`);
  const taskId = (target: TaskTarget) => ('id' in target ? target.id : `t:${target.backlogId}`);
  const nativeColumns = (values: Partial<TaskValues>) => ({
    ...(values.labels !== undefined ? { labelIds: values.labels.map(labelId) } : {}),
    ...(values.blockers !== undefined ? { blockerIds: values.blockers.map(taskId) } : {}),
    ...(values.parent !== undefined ? { parentId: values.parent ? taskId(values.parent) : null } : {}),
  });
  const taskIds = new Map<string, string>();
  for (const update of plan.tasks.updates) {
    const row = tasks.get(update.id) as ExistingTask;
    const { milestone, labels: _l, blockers: _b, parent: _p, ...rest } = update.set;
    Object.assign(
      row,
      rest,
      nativeColumns(update.set),
      milestone !== undefined ? { milestoneId: resolve(milestone) } : {},
    );
    if (update.restore) row.hiddenAt = null;
    if (update.archived !== undefined) row.archivedAt = update.archived ? (row.archivedAt ?? NOW) : null;
  }
  for (const hide of plan.tasks.hides) (tasks.get(hide.id) as ExistingTask).hiddenAt = NOW;
  for (const create of plan.tasks.creates) {
    const id = `t:${create.backlogId}`;
    taskIds.set(create.backlogId, id);
    tasks.set(id, {
      dueDate: create.dueDate,
      labelIds: [],
      blockerIds: [],
      parentId: null,
      ...nativeColumns(create),
      id,
      number: create.number,
      keySuffix: create.keySuffix,
      backlogId: create.backlogId,
      title: create.title,
      description: create.description,
      status: create.status,
      priority: create.priority,
      assigneeId: create.assigneeId,
      milestoneId: resolve(create.milestone),
      createdAt: create.createdAt,
      backlogData: JSON.parse(JSON.stringify(create.backlogData)),
      hiddenAt: null,
      archivedAt: create.archived ? NOW : null,
    });
  }
  const files = plan.files.map((file) => ({
    path: file.path,
    blobSha: file.blobSha,
    kind: file.kind,
    backlogId: file.backlogId,
    taskId:
      file.task === null
        ? null
        : 'id' in file.task
          ? file.task.id
          : (taskIds.get(file.task.backlogId) ?? null),
    milestoneId: file.milestone ? resolve(file.milestone) : null,
    error: file.error,
  }));
  return {
    tasks: [...tasks.values()],
    milestones: [...milestones.values()],
    files,
    nextTaskNumber: Math.max(before.nextTaskNumber, plan.nextTaskNumber),
    firstRead: false,
    problems: plan.problems,
    labels: [...labels.values()],
  };
}

/** Planner input where files whose blob did not change come from their rows, as the reader does. */
function incremental(
  files: FolderFile[],
  folder: string,
  existing: ExistingState,
  mappings: BacklogMappings,
) {
  const base = input(files, folder, { existing, mappings, commit: 'c2' });
  const previous = new Map(existing.files.map((file) => [file.path, file]));
  base.files = base.files.map((file) => {
    const row = previous.get(file.path);
    if (row && row.blobSha === file.blobSha && row.error === null && (row.taskId || row.milestoneId)) {
      return { path: file.path, blobSha: file.blobSha, kind: file.kind, unchanged: row };
    }
    return file;
  });
  return planRefresh(base);
}

function keys(plan: BacklogPlan): string[] {
  return plan.tasks.creates.map(
    (task) => `${task.backlogId}=${task.number}${task.keySuffix ? `.${task.keySuffix}` : ''}`,
  );
}

function fileProblems(plan: BacklogPlan) {
  return plan.problems.filter(
    (problem): problem is Extract<BacklogProblem, { kind: 'file' }> => problem.kind === 'file',
  );
}

describe('planRefresh on the 2025-09 markers era', () => {
  const files = readFixtureTree('eras/2025-09-markers');
  const { plan } = planWithPrefill(files, 'backlog');

  it('keeps Backlog.md numbers, subtasks as suffixes, drafts above the highest number', () => {
    expect(keys(plan).sort()).toEqual(
      ['DRAFT-1=13', 'PAY-12.1.2=12.1.2', 'PAY-12.1=12.1', 'PAY-12=12', 'PAY-3=3'].sort(),
    );
    expect(plan.nextTaskNumber).toBe(14);
    expect(plan.firstRead).toBe(true);
  });

  it('maps fields and fills the Backlog.md block', () => {
    const parent = plan.tasks.creates.find((task) => task.backlogId === 'PAY-12');
    expect(parent).toMatchObject({ title: 'Webhook retries', status: 'in_review', priority: 3, rank: 2000 });
    expect(parent?.createdAt.toISOString()).toBe('2025-09-01T09:30:00.000Z');
    expect(parent?.description).toContain('Retry failed webhook deliveries with backoff.');
    expect(parent?.description).toContain('## Comments from Backlog.md');
    // M6: the work record leaves the description, as the m6_work_record migration does.
    expect(parent?.description).not.toContain('## Acceptance criteria');
    expect(parent).toMatchObject({
      criteria: [
        { text: 'Failed deliveries are retried', state: 'checked', waivedReason: null },
        { text: 'Retries back off exponentially', state: 'open', waivedReason: null },
      ],
      doneItems: [{ text: 'Tests pass', state: 'open', waivedReason: null }],
      plan: '1. Add a retry queue.\n2. Schedule with backoff.',
      // Sections Backlog.md does not know come last in the rendering, so they join the summary.
      finalSummary: 'Retries ship behind a flag.\n\n## Testing\n\nRan the load test twice.',
    });
    expect(parent?.backlogData).toMatchObject({ implementationNotes: 'Queue lives in Redis.' });
    expect(parent?.backlogData).toMatchObject({
      kind: 'task',
      status: 'In Review',
      priority: 'high',
      milestone: 'm-1',
      labels: ['webhooks'],
      dependencies: ['PAY-3'],
      subtasks: ['PAY-12.1'],
      reporter: '@sam',
      type: 'feature',
      updatedDate: '2025-09-03T17:05:00.000Z',
      other: { custom_field: 'kept as is' },
      assignees: [
        { value: '@alex', userId: null },
        { value: '@codex', userId: null },
      ],
    });
    const subtask = plan.tasks.creates.find((task) => task.backlogId === 'PAY-12.1');
    expect(subtask?.backlogData).toMatchObject({ parentId: 'PAY-12', subtasks: ['PAY-12.1.2'] });
    const draft = plan.tasks.creates.find((task) => task.backlogId === 'DRAFT-1');
    expect(draft).toMatchObject({ status: 'backlog', kind: 'draft' });
    const archived = plan.tasks.creates.find((task) => task.backlogId === 'PAY-3');
    expect(archived).toMatchObject({ status: 'done', kind: 'archived' });
  });

  it('creates milestones: archived ones Completed, a milestone with a started task Active', () => {
    const byId = new Map(plan.milestones.creates.map((row) => [row.backlogId, row]));
    expect(byId.get('m-1')).toMatchObject({ name: 'Webhooks v2', status: 'active', completedAt: null });
    expect(byId.get('m-0')).toMatchObject({ name: 'Launch', status: 'completed', completedAt: NOW });
    const parent = plan.tasks.creates.find((task) => task.backlogId === 'PAY-12');
    expect(parent?.milestone).toEqual({ backlogId: 'm-1' });
  });

  it('counts like the preview shows them and samples in Backlog.md order', () => {
    expect(plan.counts).toEqual({
      tasks: 3,
      open: 3,
      drafts: 1,
      archived: 1,
      completed: 0,
      subtasks: 2,
      milestones: 1,
      archivedMilestones: 1,
    });
    expect(plan.sample.map((row) => row.key)).toEqual([
      'PAY-12',
      'PAY-12.1',
      'PAY-12.1.2',
      'PAY-3',
      'PAY-13',
    ]);
  });

  it('reports assignees that match no member, and nothing for mapped values', () => {
    expect(plan.problems.filter((problem) => problem.kind === 'value')).toEqual([
      expect.objectContaining({ field: 'assignee', value: '@alex', count: 1, fallback: 'No one' }),
      expect.objectContaining({ field: 'assignee', value: '@codex', count: 1, fallback: 'No one' }),
    ]);
  });

  it('falls back with warnings when nothing is mapped', () => {
    const unmapped = planRefresh(input(files, 'backlog'));
    const statusProblems = unmapped.problems.filter(
      (problem) => problem.kind === 'value' && problem.field === 'status',
    );
    expect(statusProblems.map((problem) => (problem as { value: string }).value).sort()).toEqual([
      'Done',
      'In Progress',
      'In Review',
      'To Do',
    ]);
    expect(unmapped.tasks.creates.find((task) => task.backlogId === 'PAY-12')?.status).toBe('todo');
    expect(unmapped.tasks.creates.find((task) => task.backlogId === 'PAY-12')?.priority).toBe(0);
  });
});

describe('planRefresh on the other eras', () => {
  it('reads the 2025-06 plain era: zero padding, completed/, legacy config milestones, two-digit years', () => {
    const files = readFixtureTree('eras/2025-06-plain');
    const { plan } = planWithPrefill(files, 'backlog');
    expect(keys(plan).sort()).toEqual(['TASK-1.1=1.1', 'TASK-1=1', 'TASK-2=2', 'TASK-3=3'].sort());
    expect(plan.counts).toMatchObject({ tasks: 3, archived: 1, completed: 1, subtasks: 1, drafts: 0 });
    expect(plan.milestones.creates.map((row) => [row.backlogId, row.name])).toEqual([
      ['Beta launch', 'Beta launch'],
      ['v1.0', 'v1.0'],
    ]);
    const first = plan.tasks.creates.find((task) => task.backlogId === 'TASK-1');
    expect(first?.milestone).toEqual({ backlogId: 'Beta launch' });
    const archived = plan.tasks.creates.find((task) => task.backlogId === 'TASK-2');
    expect(archived?.createdAt.toISOString()).toBe('2025-06-05T00:00:00.000Z');
    // The old-style draft (task-004 in drafts/) is ignored, like Backlog.md does.
    expect(plan.tasks.creates.some((task) => task.title === 'Old style draft')).toBe(false);
  });

  it('reads the 2026-10 ISO era through the root config and matches milestones by title', () => {
    const files = readFixtureTree('eras/2026-10-iso');
    const { plan } = planWithPrefill(files, 'planning');
    expect(keys(plan).sort()).toEqual(['BACK-786.1=786.1', 'BACK-786=786', 'DRAFT-14=787'].sort());
    const parent = plan.tasks.creates.find((task) => task.backlogId === 'BACK-786');
    expect(parent?.milestone).toEqual({ backlogId: 'm-7' });
    expect(parent?.createdAt.toISOString()).toBe('2026-10-21T14:26:00.000Z');
    expect(plan.milestones.creates.map((row) => [row.backlogId, row.status]).sort()).toEqual([
      ['m-3', 'completed'],
      ['m-7', 'active'],
    ]);
    expect(plan.config.taskPrefix).toBe('BACK');
    expect(plan.files.find((file) => file.kind === 'config')?.path).toBe('backlog.config.yml');
  });

  it('skips files that do not parse with their error and keeps warnings on read files', () => {
    const files = readFixtureTree('errors');
    const plan = planRefresh(input(files, 'backlog'));
    const problems = fileProblems(plan);
    const skipped = problems.filter((problem) => problem.skipped);
    expect(skipped.map((problem) => problem.message)).toEqual(
      expect.arrayContaining([expect.stringContaining('dependencies must be a flat list')]),
    );
    for (const problem of skipped) {
      const row = plan.files.find((file) => file.path === problem.path);
      expect(row?.error).toBe(problem.message);
      expect(row?.task).toBeNull();
    }
    const unreadable = problems.find(
      (problem) => !problem.skipped && problem.message.includes('created_date'),
    );
    expect(unreadable).toBeDefined();
    const task = plan.tasks.creates.find((create) => create.path === unreadable?.path);
    expect(task?.createdAt).toEqual(NOW);
  });
});

describe('planRefresh against existing rows', () => {
  const folder = 'backlog';
  const base = (): FolderFile[] => [
    { path: `${folder}/config.yml`, text: configFile() },
    {
      path: taskPath(folder, 'back-1', 'First'),
      text: taskFile({ id: 'BACK-1', title: 'First', status: 'In Progress', milestone: 'm-1' }),
    },
    { path: taskPath(folder, 'back-2', 'Second'), text: taskFile({ id: 'BACK-2', title: 'Second' }) },
    {
      path: taskPath(folder, 'back-2.1', 'Sub'),
      text: taskFile({ id: 'BACK-2.1', title: 'Sub', parent: 'BACK-2' }),
    },
    {
      path: `${folder}/drafts/draft-1 - Idea.md`,
      text: taskFile({ id: 'DRAFT-1', title: 'Idea' }),
    },
    {
      path: `${folder}/milestones/m-1 - Launch.md`,
      text: '---\nid: m-1\ntitle: "Launch"\n---\n\n## Description\n\nShip it.\n',
    },
  ];
  const mappingsFor = (files: FolderFile[]) => prefillMappings(planRefresh(input(files, folder)).seen, []);

  function firstRead(files: FolderFile[]) {
    const mappings = mappingsFor(files);
    const plan = planRefresh(input(files, folder, { mappings }));
    return { plan, state: applyInMemory(plan, emptyExisting()), mappings };
  }

  it('is idempotent: the same files plan no change', () => {
    const files = base();
    const { state, mappings } = firstRead(files);
    const again = incremental(files, folder, state, mappings);
    expect(again.tasks).toEqual({ creates: [], updates: [], hides: [] });
    expect(again.milestones).toEqual({ creates: [], updates: [], hides: [] });
    expect(planChangesContent(again)).toBe(false);
    // Every content file came from its row.
    const full = planRefresh(input(files, folder, { existing: state, mappings, commit: 'c2' }));
    expect(full.tasks).toEqual({ creates: [], updates: [], hides: [] });
  });

  it('matches by Backlog.md id: a rename updates the task', () => {
    const files = base();
    const { state, mappings } = firstRead(files);
    const renamed = files.filter((file) => !file.path.includes('back-2 - Second'));
    renamed.push({
      path: taskPath(folder, 'back-2', 'Second renamed'),
      text: taskFile({ id: 'BACK-2', title: 'Second renamed', status: 'Done' }),
    });
    const plan = incremental(renamed, folder, state, mappings);
    expect(plan.tasks.creates).toEqual([]);
    expect(plan.tasks.hides).toEqual([]);
    expect(plan.tasks.updates).toEqual([
      expect.objectContaining({
        id: 't:BACK-2',
        restore: false,
        changes: [
          { field: 'title', from: 'Second', to: 'Second renamed' },
          { field: 'description', from: 'About Second.', to: 'About Second renamed.' },
          { field: 'status', from: 'todo', to: 'done' },
        ],
      }),
    ]);
  });

  it('hides tasks whose file is gone and restores them with the same key', () => {
    const files = base();
    const { state, mappings } = firstRead(files);
    const without = files.filter((file) => !file.path.includes('back-2.1'));
    const hidden = incremental(without, folder, state, mappings);
    expect(hidden.tasks.hides).toEqual([{ id: 't:BACK-2.1' }]);
    // The parent's derived subtask list changes in its block, with no change to list (M5: subtasks
    // are the other side of the native parent).
    expect(hidden.tasks.updates).toEqual([
      expect.objectContaining({
        id: 't:BACK-2',
        set: { backlogData: expect.objectContaining({ subtasks: [] }) },
        changes: [],
      }),
    ]);
    const after = applyInMemory(hidden, state);
    const back = incremental(files, folder, after, mappings);
    expect(back.tasks.creates).toEqual([]);
    expect(back.tasks.updates.find((update) => update.id === 't:BACK-2.1')).toMatchObject({ restore: true });
  });

  it('keeps the newest of two files with the same id and reports the other', () => {
    const files = base();
    files.push({
      path: taskPath(folder, 'back-2', 'Second copy'),
      text: taskFile({ id: 'BACK-2', title: 'Second copy', updated: '2026-10-05 10:00' }),
    });
    const plan = planRefresh(input(files, folder, { mappings: mappingsFor(files) }));
    expect(
      plan.tasks.creates.filter((task) => task.backlogId === 'BACK-2').map((task) => task.title),
    ).toEqual(['Second copy']);
    const loser = fileProblems(plan).find((problem) => problem.skipped);
    expect(loser).toMatchObject({ path: taskPath(folder, 'back-2', 'Second'), backlogId: 'BACK-2' });
    expect(loser?.message).toContain('Duplicate id BACK-2');
  });

  it('keeps draft numbers across reads and moves a draft when a task file takes its number', () => {
    const files = base();
    const { plan, state, mappings } = firstRead(files);
    expect(plan.tasks.creates.find((task) => task.backlogId === 'DRAFT-1')?.number).toBe(3);
    files.push({
      path: taskPath(folder, 'back-5', 'Fifth'),
      text: taskFile({ id: 'BACK-5', title: 'Fifth' }),
    });
    const second = incremental(files, folder, state, mappings);
    expect(second.tasks.updates).toEqual([]);
    expect(second.tasks.creates.map((task) => task.number)).toEqual([5]);
    const state2 = applyInMemory(second, state);
    files.push({
      path: taskPath(folder, 'back-3', 'Third'),
      text: taskFile({ id: 'BACK-3', title: 'Third' }),
    });
    const third = incremental(files, folder, state2, mappings);
    expect(third.tasks.creates.map((task) => task.number)).toEqual([3]);
    expect(third.tasks.updates).toEqual([
      expect.objectContaining({
        id: 't:DRAFT-1',
        set: expect.objectContaining({ number: 6 }),
        changes: [{ field: 'backlog', from: null, to: ['key'] }],
      }),
    ]);
    expect(
      fileProblems(third).some((problem) => problem.message.includes('DRAFT-1 moved from PAY-3 to PAY-6')),
    ).toBe(true);
    expect(third.nextTaskNumber).toBe(7);
  });

  it('reapplies edited mappings to unchanged files', () => {
    const files = base();
    const { state, mappings } = firstRead(files);
    const edited: BacklogMappings = {
      ...mappings,
      status: mappings.status.map((row) =>
        row.from === 'To Do' ? { ...row, to: 'backlog', how: 'manual' } : row,
      ),
    };
    const plan = incremental(files, folder, state, edited);
    expect(plan.tasks.updates.map((update) => update.id).sort()).toEqual(['t:BACK-2', 't:BACK-2.1']);
    for (const update of plan.tasks.updates) {
      expect(update.changes).toEqual([{ field: 'status', from: 'todo', to: 'backlog' }]);
    }
  });

  it('keeps the last good version of a task whose file stops parsing', () => {
    const files = base();
    const { state, mappings } = firstRead(files);
    const broken = files.map((file) =>
      file.path.includes('back-2 - Second')
        ? { ...file, text: '---\nid: BACK-2\ntitle: [unclosed\n---\n' }
        : file,
    );
    const plan = incremental(broken, folder, state, mappings);
    expect(plan.tasks.hides).toEqual([]);
    expect(plan.tasks.updates).toEqual([]);
    const row = plan.files.find((file) => file.path.includes('back-2 - Second'));
    expect(row).toMatchObject({ task: { id: 't:BACK-2' } });
    expect(row?.error).toBeTruthy();
  });

  // M7: the archive folder decides archived_at; status changes decide closed_at.
  const archivePath = (id: string, title: string) => taskPath(folder, id, title, 'archive/tasks');
  const moveToArchive = (files: FolderFile[], id: string, title: string): FolderFile[] =>
    files.map((file) =>
      file.path === taskPath(folder, id, title) ? { ...file, path: archivePath(id, title) } : file,
    );

  it('archives a task whose file moves to archive/tasks/ and restores it when it moves back', () => {
    const files = base();
    const { state, mappings } = firstRead(files);
    const moved = moveToArchive(files, 'back-2', 'Second');
    const archived = incremental(moved, folder, state, mappings);
    // The block's kind changes, but task.archived names the move: no Backlog.md-only change is listed.
    expect(archived.tasks.updates).toEqual([
      {
        id: 't:BACK-2',
        set: { backlogData: expect.objectContaining({ kind: 'archived' }) },
        changes: [],
        restore: false,
        archived: true,
      },
    ]);
    const after = applyInMemory(archived, state);
    expect(after.tasks.find((row) => row.id === 't:BACK-2')?.archivedAt).toEqual(NOW);
    // Re-reading the archived folder changes nothing.
    expect(incremental(moved, folder, after, mappings).tasks.updates).toEqual([]);
    const back = incremental(files, folder, after, mappings);
    expect(back.tasks.updates).toEqual([
      expect.objectContaining({ id: 't:BACK-2', changes: [], archived: false }),
    ]);
    // An open task coming out of the archive keeps closed_at as it is (null).
    expect(back.tasks.updates[0]?.closedAt).toBeUndefined();
  });

  it('creates tasks of the archive folder and the legacy completed/ folder archived', () => {
    const files = base();
    files.push(
      {
        path: archivePath('back-3', 'Third'),
        text: taskFile({ id: 'BACK-3', title: 'Third', status: 'Done' }),
      },
      {
        path: `${folder}/completed/back-4 - Fourth.md`,
        text: taskFile({ id: 'BACK-4', title: 'Fourth', status: 'Done' }),
      },
    );
    const plan = planRefresh(input(files, folder, { mappings: mappingsFor(files) }));
    const archived = (id: string) => plan.tasks.creates.find((task) => task.backlogId === id)?.archived;
    expect([archived('BACK-1'), archived('BACK-3'), archived('BACK-4'), archived('DRAFT-1')]).toEqual([
      false,
      true,
      true,
      false,
    ]);
    expect(plan.counts).toMatchObject({ tasks: 3, archived: 2, completed: 1, drafts: 1 });
  });

  it('reads the archived state from the row when it is known, else from the stored block', () => {
    const files = base();
    const { state, mappings } = firstRead(files);
    const setArchived = (archivedAt: Date | null | undefined) => ({
      ...state,
      tasks: state.tasks.map((row) => (row.id === 't:BACK-2' ? { ...row, archivedAt } : row)),
    });
    // Archived in Zamu but the file is in tasks/: the files win.
    expect(incremental(files, folder, setArchived(NOW), mappings).tasks.updates).toEqual([
      { id: 't:BACK-2', set: {}, changes: [], restore: false, archived: false },
    ]);
    // Not loaded: the block says task, as the file does, so nothing changes.
    expect(incremental(files, folder, setArchived(undefined), mappings).tasks.updates).toEqual([]);
    const moved = moveToArchive(files, 'back-2', 'Second');
    const after = applyInMemory(incremental(moved, folder, state, mappings), state);
    const unknown = {
      ...after,
      tasks: after.tasks.map((row) => (row.id === 't:BACK-2' ? { ...row, archivedAt: undefined } : row)),
    };
    expect(incremental(moved, folder, unknown, mappings).tasks.updates).toEqual([]);
    expect(incremental(files, folder, unknown, mappings).tasks.updates).toEqual([
      expect.objectContaining({ id: 't:BACK-2', archived: false }),
    ]);
  });

  it('plans closed_at from status changes and from leaving the archive while closed', () => {
    const files = base();
    const { state, mappings } = firstRead(files);
    const withStatus = (status: string, archive = false) => {
      const text = taskFile({ id: 'BACK-2', title: 'Second', status });
      return files.map((file) =>
        file.path === taskPath(folder, 'back-2', 'Second')
          ? { path: archive ? archivePath('back-2', 'Second') : file.path, text }
          : file,
      );
    };
    const update = (plan: BacklogPlan) => plan.tasks.updates.find((entry) => entry.id === 't:BACK-2');
    const done = incremental(withStatus('Done'), folder, state, mappings);
    expect(update(done)).toMatchObject({ set: { status: 'done' }, closedAt: 'close' });
    const closed = applyInMemory(done, state);
    expect(update(incremental(withStatus('In Progress'), folder, closed, mappings))).toMatchObject({
      set: { status: 'in_progress' },
      closedAt: 'clear',
    });
    // Archived while Done, then out of the archive while still Done: closed_at starts again.
    const archived = applyInMemory(incremental(withStatus('Done', true), folder, closed, mappings), closed);
    expect(update(incremental(withStatus('Done'), folder, archived, mappings))).toMatchObject({
      archived: false,
      closedAt: 'reset',
    });
    // Into the archive changes no date; a file edit without a status change neither.
    expect(update(incremental(withStatus('Done', true), folder, closed, mappings))?.closedAt).toBeUndefined();
  });

  it('skips ids that cannot become task keys', () => {
    const files = base();
    files.push({ path: taskPath(folder, 'back-0', 'Zero'), text: taskFile({ id: 'BACK-0', title: 'Zero' }) });
    const plan = planRefresh(input(files, folder));
    expect(plan.tasks.creates.some((task) => task.backlogId === 'BACK-0')).toBe(false);
    expect(fileProblems(plan).find((problem) => problem.backlogId === 'BACK-0')?.skipped).toBe(true);
  });
});

describe('planRefresh native fields (M5)', () => {
  const folder = 'backlog';
  const LONG = 'x'.repeat(41);
  const files = (): FolderFile[] => [
    { path: `${folder}/config.yml`, text: configFile() },
    {
      path: taskPath(folder, 'back-1', 'First'),
      text: taskFile({
        id: 'BACK-1',
        title: 'First',
        labels: ['API', 'backend', 'Api'],
        due: '2026-11-20',
        dependencies: ['BACK-2', 'BACK-99'],
      }),
    },
    {
      path: taskPath(folder, 'back-2', 'Second'),
      text: taskFile({ id: 'BACK-2', title: 'Second', labels: ['api'], dependencies: ['BACK-2'] }),
    },
    { path: taskPath(folder, 'back-2.1', 'Sub'), text: taskFile({ id: 'BACK-2.1', title: 'Sub' }) },
    {
      path: taskPath(folder, 'back-3', 'Third'),
      text: taskFile({ id: 'BACK-3', title: 'Third', due: '2026-02-30', labels: [LONG] }),
    },
  ];
  const existingLabels = (): ExistingState['labels'] => [
    { id: 'label-backend', name: 'Backend', color: 1, source: 'app' },
  ];
  const create = (plan: BacklogPlan, id: string) =>
    plan.tasks.creates.find((task) => task.backlogId === id) as BacklogPlan['tasks']['creates'][number];

  it('maps labels, due dates, blockers and parents onto native values', () => {
    const plan = planRefresh(
      input(files(), folder, { existing: { ...emptyExisting(), labels: existingLabels() } }),
    );
    // One new label for API/api/Api, named after the first spelling in code point order, with the
    // least used hue; the app label Backend is reused and its name locks.
    expect(plan.labels).toEqual({ creates: [{ name: 'API', color: 2 }], adopt: [{ id: 'label-backend' }] });
    expect(create(plan, 'BACK-1')).toMatchObject({
      labels: [{ name: 'API' }, { id: 'label-backend' }],
      dueDate: '2026-11-20',
      blockers: [{ backlogId: 'BACK-2' }],
      parent: null,
    });
    expect(create(plan, 'BACK-2')).toMatchObject({ labels: [{ name: 'API' }], blockers: [], parent: null });
    expect(create(plan, 'BACK-2.1')).toMatchObject({ parent: { backlogId: 'BACK-2' }, labels: [] });
    expect(create(plan, 'BACK-3')).toMatchObject({ dueDate: null, labels: [] });
    // The block keeps the values as written.
    expect(create(plan, 'BACK-3').backlogData).toMatchObject({ labels: [LONG], dueDate: null });

    const messages = fileProblems(plan).map((problem) => `${problem.backlogId}: ${problem.message}`);
    expect(messages).toEqual(
      expect.arrayContaining([
        'BACK-1: dependencies: BACK-99 matches no task in this project; the link is left out',
        'BACK-2: dependencies: BACK-2 is this task; the link is left out',
        `BACK-3: labels: "${LONG}" is longer than 40 characters and was left out`,
        'BACK-3: due_date "2026-02-30" is not a YYYY-MM-DD date (line 9)',
      ]),
    );
  });

  it('plans nothing for the same files, without repeating the field warnings', () => {
    const before = { ...emptyExisting(), labels: existingLabels() };
    const mappings = prefillMappings(planRefresh(input(files(), folder)).seen, []);
    const first = planRefresh(input(files(), folder, { existing: before, mappings }));
    const state = applyInMemory(first, before);
    const again = incremental(files(), folder, state, mappings);
    expect(again.tasks).toEqual({ creates: [], updates: [], hides: [] });
    expect(again.labels).toEqual({ creates: [], adopt: [] });
    expect(planChangesContent(again)).toBe(false);
    expect(fileProblems(again).filter((problem) => problem.message.includes('BACK-99'))).toHaveLength(1);
    expect(fileProblems(again)).toHaveLength(fileProblems(first).length);
  });

  it('changed files plan native changes, not Backlog.md-only fields', () => {
    const before = { ...emptyExisting(), labels: existingLabels() };
    const mappings = prefillMappings(planRefresh(input(files(), folder)).seen, []);
    const state = applyInMemory(planRefresh(input(files(), folder, { existing: before, mappings })), before);
    const edited = files().map((file) => {
      if (file.path.includes('back-1 - First')) {
        return { ...file, text: taskFile({ id: 'BACK-1', title: 'First', labels: ['Backend', 'payouts'] }) };
      }
      if (file.path.includes('back-2.1 - Sub')) {
        return {
          ...file,
          text: taskFile({ id: 'BACK-2.1', title: 'Sub', parent: 'BACK-1', due: '2026-12-01' }),
        };
      }
      if (file.path.includes('back-3 - Third')) {
        return {
          ...file,
          text: taskFile({ id: 'BACK-3', title: 'Third', dependencies: ['BACK-1', 'BACK-2.1'] }),
        };
      }
      return file;
    });
    const plan = incremental(edited, folder, state, mappings);
    expect(plan.labels).toEqual({ creates: [{ name: 'payouts', color: 3 }], adopt: [] });
    const changes = new Map(plan.tasks.updates.map((update) => [update.id, update.changes]));
    expect(changes.get('t:BACK-1')).toEqual([
      {
        field: 'labels',
        from: [
          { label: { id: 'l:api' }, name: 'API' },
          { label: { id: 'label-backend' }, name: 'Backend' },
        ],
        to: [
          { label: { id: 'label-backend' }, name: 'Backend' },
          { label: { name: 'payouts' }, name: 'payouts' },
        ],
      },
      { field: 'dueDate', from: '2026-11-20', to: null },
      {
        field: 'blockedBy',
        from: [{ task: { id: 't:BACK-2' }, key: 'PAY-2', title: 'Second' }],
        to: [],
      },
    ]);
    expect(changes.get('t:BACK-2.1')).toEqual([
      { field: 'dueDate', from: null, to: '2026-12-01' },
      {
        field: 'parent',
        from: { task: { id: 't:BACK-2' }, key: 'PAY-2', title: 'Second' },
        to: { task: { id: 't:BACK-1' }, key: 'PAY-1', title: 'First' },
      },
    ]);
    expect(changes.get('t:BACK-3')).toEqual([
      {
        field: 'blockedBy',
        from: [],
        to: [
          { task: { id: 't:BACK-1' }, key: 'PAY-1', title: 'First' },
          { task: { id: 't:BACK-2.1' }, key: 'PAY-2.1', title: 'Sub' },
        ],
      },
    ]);
    // BACK-2 lost its subtask: its block changes, with nothing to list.
    expect(changes.get('t:BACK-2')).toEqual([]);
    for (const list of changes.values())
      expect(list.some((change) => change.field === 'backlog')).toBe(false);

    const after = applyInMemory(plan, state);
    expect(planChangesContent(incremental(edited, folder, after, mappings))).toBe(false);
  });

  it('points at hidden tasks of the project, and at no task the files lost', () => {
    const before = emptyExisting();
    const mappings = prefillMappings(planRefresh(input(files(), folder)).seen, []);
    const state = applyInMemory(planRefresh(input(files(), folder, { existing: before, mappings })), before);
    // BACK-2's file goes: the task is hidden, BACK-1 still waits on it and BACK-2.1 keeps its parent.
    const without = files().filter((file) => !file.path.includes('back-2 - Second'));
    const plan = incremental(without, folder, state, mappings);
    expect(plan.tasks.hides).toEqual([{ id: 't:BACK-2' }]);
    expect(plan.tasks.updates.find((update) => update.id === 't:BACK-1')).toBeUndefined();
    expect(plan.tasks.updates.find((update) => update.id === 't:BACK-2.1')).toBeUndefined();
    expect(fileProblems(plan).some((problem) => problem.message.includes('BACK-2 matches no task'))).toBe(
      false,
    );
  });
});

describe('helpers', () => {
  it('reads the id from a file name', () => {
    expect(idFromFileName('backlog/tasks/back-007.01 - Title.md')).toBe('BACK-7.1');
    expect(idFromFileName('backlog/tasks/notes - x.md')).toBeNull();
  });

  it('compares JSON ignoring key order', () => {
    expect(stableJson({ b: 1, a: [{ d: 1, c: 2 }] })).toBe(stableJson({ a: [{ c: 2, d: 1 }], b: 1 }));
  });
});
