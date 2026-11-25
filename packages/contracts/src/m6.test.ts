// M6 contract additions: the work record (criteria, done items, plan, final summary), notes, the
// machine and branch of CLI changes, the timeline filter, project default done items, the
// Backlog.md export, the OPEN_ITEMS problem, and the CLI shapes for them and the offline queue.

import { ORPCError } from '@orpc/contract';
import { describe, expect, it } from 'vitest';
import { CLI_EXIT_QUEUED, CliQueueEntry, CliQueueFile, cliOutput, parseCliOutput } from './cli';
import { apiErrors, contract } from './contract';
import {
  Activity,
  ActivityChange,
  BacklogBlock,
  BacklogExport,
  BacklogExportPath,
  Comment,
  EntrySource,
  MAX_SOURCE_LENGTH,
  MAX_WORK_ITEM_LENGTH,
  MAX_WORK_ITEMS,
  MAX_WORK_TEXT_LENGTH,
  Project,
  parseSourceHeader,
  SOURCE_HEADERS,
  Task,
  TaskListItem,
  Timeline,
  TimelineCounts,
  TimelineItem,
  WORK_RECORD_CHANGE_FIELDS,
  WorkItem,
  WorkItemProgress,
  WorkTextMeta,
} from './entities';
import {
  CRITERIA_OPERATION_FIELDS,
  CreateCommentInput,
  CreateTaskInput,
  DONE_ITEM_OPERATION_FIELDS,
  ExportBacklogInput,
  ListTaskTimelineInput,
  UpdateProjectInput,
  UpdateTaskInput,
  WaiveReason,
  WorkItemText,
  WorkText,
} from './inputs';
import { TASK_OWNED_FIELDS } from './primitives';
import { PROBLEM_STATUS, PROBLEM_TITLES, Problem, problem } from './problem';
import { decodeProblem, encodeProblem } from './problem-codec';
import {
  ana,
  backlogExportFixture,
  commentFixture,
  meFixture,
  noteFixture,
  projectFixture,
  taskFixture,
  taskListItemFixture,
  timelineFixture,
  workItemFixtures,
  workRecordActivityFixture,
  workRecordListItemFixture,
  workRecordTaskFixture,
  workRecordTimelineFixture,
} from './testing/fixtures';

const issuePaths = (result: { success: boolean; error?: { issues: { path: PropertyKey[] }[] } }) =>
  result.error?.issues.map((issue) => issue.path.join('.')) ?? [];

describe('M6 limits', () => {
  it('caps lists at 50 items, items at 500 characters and texts at 50,000', () => {
    expect(MAX_WORK_ITEMS).toBe(50);
    expect(MAX_WORK_ITEM_LENGTH).toBe(500);
    expect(MAX_WORK_TEXT_LENGTH).toBe(50_000);
  });

  it('takes one trimmed line of 1 to 500 characters per item and reason', () => {
    expect(WorkItemText.parse('  Refunds post a ledger entry  ')).toBe('Refunds post a ledger entry');
    expect(WorkItemText.safeParse('x'.repeat(500)).success).toBe(true);
    expect(WorkItemText.safeParse('x'.repeat(501)).success).toBe(false);
    expect(WorkItemText.safeParse('   ').error?.issues[0]?.message).toBe('Write the item first');
    expect(WorkItemText.safeParse('two\nlines').error?.issues[0]?.message).toBe('Keep it on one line');
    expect(WorkItemText.safeParse('carriage\rreturn').success).toBe(false);
    // Leading and trailing line breaks are trimmed away, not refused.
    expect(WorkItemText.parse('\nOne line\n')).toBe('One line');
    expect(WaiveReason.safeParse('').error?.issues[0]?.message).toBe('Give a reason');
    expect(WaiveReason.safeParse('Replaced\nby a replay').success).toBe(false);
  });

  it('keeps plans and summaries as written, up to 50,000 characters', () => {
    expect(WorkText.parse('  1. Indented\n')).toBe('  1. Indented\n');
    expect(WorkText.safeParse('x'.repeat(50_000)).success).toBe(true);
    expect(WorkText.safeParse('x'.repeat(50_001)).success).toBe(false);
  });
});

describe('M6 entities', () => {
  it('reads tasks with and without the work record', () => {
    const task = Task.parse(workRecordTaskFixture);
    expect(task.criteria?.map((item) => [item.number, item.state])).toEqual([
      [1, 'checked'],
      [2, 'open'],
      [3, 'waived'],
    ]);
    expect(task.criteria?.[2]?.waivedBy).toEqual(ana);
    expect(task.planMeta?.at).toBe('2026-10-21T09:00:00.000Z');
    expect(task.finalSummary).toBe('Retries back off and stop on 4xx answers.');
    // Shapes built before M6 stay valid.
    const older = Task.parse(taskFixture);
    expect(older.criteria).toBeUndefined();
    expect(older.plan).toBeUndefined();
  });

  it('needs a reason exactly while an item is waived', () => {
    expect(WorkItem.safeParse(workItemFixtures.waived).success).toBe(true);
    expect(WorkItem.safeParse({ ...workItemFixtures.waived, waivedReason: null }).success).toBe(false);
    expect(WorkItem.safeParse({ ...workItemFixtures.open, waivedReason: 'Why' }).success).toBe(false);
    expect(WorkItem.safeParse({ ...workItemFixtures.open, state: 'skipped' }).success).toBe(false);
    expect(WorkItem.safeParse({ ...workItemFixtures.open, number: 0 }).success).toBe(false);
    // File items can run past the input limits: they are stored as read.
    expect(WorkItem.safeParse({ ...workItemFixtures.open, number: 51, locked: true }).success).toBe(true);
  });

  it('defaults the origin of plan and summary authors to the app', () => {
    expect(WorkTextMeta.parse({ author: ana, onBehalfOf: null, at: '2026-10-21T09:00:00Z' }).origin).toBe(
      'app',
    );
    expect(
      WorkTextMeta.parse({ author: null, onBehalfOf: null, origin: 'backlog', at: '2026-10-21T09:00:00Z' })
        .origin,
    ).toBe('backlog');
  });

  it('counts settled, open and waived items on list rows', () => {
    const row = TaskListItem.parse(workRecordListItemFixture);
    expect(row.criteriaProgress).toEqual({ settled: 2, open: 1, waived: 1, total: 3 });
    expect(row.hasFinalSummary).toBe(true);
    expect(TaskListItem.parse(taskListItemFixture).criteriaProgress).toBeUndefined();
    expect(WorkItemProgress.safeParse({ settled: 0, open: 0, waived: 0, total: 0 }).success).toBe(true);
    expect(WorkItemProgress.safeParse({ settled: 1, open: 1, waived: 0, total: 3 }).success).toBe(false);
    expect(WorkItemProgress.safeParse({ settled: 1, open: 0, waived: 2, total: 1 }).success).toBe(false);
  });

  it('gives projects their default done items', () => {
    expect(Project.parse({ ...projectFixture, defaultDoneItems: ['Tests pass'] }).defaultDoneItems).toEqual([
      'Tests pass',
    ]);
    expect(Project.parse(projectFixture).defaultDoneItems).toBeUndefined();
  });

  it('keeps implementation notes in the Backlog.md block', () => {
    expect(BacklogBlock.parse({}).implementationNotes).toBeNull();
    expect(BacklogBlock.parse({ implementationNotes: 'Started with the ledger.' }).implementationNotes).toBe(
      'Started with the ledger.',
    );
  });

  it('marks comments and notes and carries the source of CLI writes', () => {
    const note = Comment.parse(noteFixture);
    expect(note.kind).toBe('note');
    expect(note.source).toEqual({ machine: 'ana-laptop', branch: 'feat/webhook-retries' });
    const older = Comment.parse(commentFixture);
    expect(older.kind).toBeUndefined();
    expect(older.source).toBeUndefined();
    expect(Comment.safeParse({ ...commentFixture, kind: 'memo' }).success).toBe(false);
    expect(EntrySource.parse({ machine: 'kaggia', branch: null })).toEqual({
      machine: 'kaggia',
      branch: null,
    });
    expect(Activity.parse(workRecordActivityFixture).source?.branch).toBe('feat/webhook-retries');
  });

  it('lists notes in the timeline with the four counts', () => {
    const timeline = Timeline.parse(workRecordTimelineFixture);
    expect(timeline.items.map((item) => item.kind)).toEqual(['activity', 'comment', 'note', 'activity']);
    expect(timeline.counts).toEqual({ all: 4, comments: 1, notes: 1, history: 2 });
    expect(Timeline.parse({ items: timelineFixture }).counts).toBeUndefined();
    expect(TimelineCounts.safeParse({ all: 3, comments: 1, notes: 1, history: 2 }).success).toBe(false);
    // A note in the timeline is a comment of kind note.
    expect(TimelineItem.safeParse({ ...commentFixture, kind: 'note' }).success).toBe(true);
  });

  it('locks the work record of mirrored tasks', () => {
    expect(TASK_OWNED_FIELDS).toEqual(
      expect.arrayContaining(['criteria', 'doneItems', 'plan', 'finalSummary']),
    );
  });
});

describe('M6 activity changes', () => {
  const text = 'Retries stop after a 4xx answer';

  it('has eight item changes per list, plus plan and finalSummary', () => {
    expect(WORK_RECORD_CHANGE_FIELDS).toEqual([
      'criterion.added',
      'criterion.edited',
      'criterion.moved',
      'criterion.removed',
      'criterion.checked',
      'criterion.unchecked',
      'criterion.waived',
      'criterion.unwaived',
      'doneItem.added',
      'doneItem.edited',
      'doneItem.moved',
      'doneItem.removed',
      'doneItem.checked',
      'doneItem.unchecked',
      'doneItem.waived',
      'doneItem.unwaived',
      'plan',
      'finalSummary',
    ]);
  });

  it('carries the number and the text of the item', () => {
    for (const prefix of ['criterion', 'doneItem']) {
      for (const operation of ['added', 'removed', 'checked', 'unchecked', 'unwaived']) {
        const change = { field: `${prefix}.${operation}`, number: 2, text };
        expect(ActivityChange.safeParse(change).success, change.field).toBe(true);
        expect(ActivityChange.safeParse({ field: change.field, number: 2 }).success, change.field).toBe(
          false,
        );
      }
      expect(
        ActivityChange.safeParse({ field: `${prefix}.edited`, number: 2, text, from: 'Stop on 4xx' }).success,
      ).toBe(true);
      expect(ActivityChange.safeParse({ field: `${prefix}.edited`, number: 2, text }).success).toBe(false);
      expect(ActivityChange.safeParse({ field: `${prefix}.moved`, text, from: 3, to: 1 }).success).toBe(true);
      expect(ActivityChange.safeParse({ field: `${prefix}.moved`, text, from: 0, to: 1 }).success).toBe(
        false,
      );
      expect(
        ActivityChange.safeParse({ field: `${prefix}.waived`, number: 5, text, reason: 'Replay instead' })
          .success,
      ).toBe(true);
      expect(ActivityChange.safeParse({ field: `${prefix}.waived`, number: 5, text }).success).toBe(false);
    }
    expect(ActivityChange.safeParse({ field: 'criterion.skipped', number: 1, text }).success).toBe(false);
  });

  it('records the plan and the summary before and after', () => {
    expect(ActivityChange.safeParse({ field: 'plan', from: null, to: '1. Store attempts' }).success).toBe(
      true,
    );
    expect(ActivityChange.safeParse({ field: 'finalSummary', from: 'Old', to: null }).success).toBe(true);
    expect(ActivityChange.safeParse({ field: 'plan', to: 'x' }).success).toBe(false);
  });
});

describe('M6 inputs', () => {
  it('creates a task with criteria, done items, a plan and the default switch', () => {
    const input = CreateTaskInput.parse({
      project: 'pay',
      title: 'Refunds',
      criteria: [' Refunds post a ledger entry ', 'Webhook retries back off'],
      doneItems: ['Docs updated'],
      skipDefaultDoneItems: true,
      plan: '1. Ledger table\n',
    });
    expect(input).toMatchObject({
      criteria: ['Refunds post a ledger entry', 'Webhook retries back off'],
      doneItems: ['Docs updated'],
      skipDefaultDoneItems: true,
      plan: '1. Ledger table\n',
    });
    const plain = CreateTaskInput.parse({ project: 'PAY', title: 'Plain' });
    expect(plain).not.toHaveProperty('criteria');
    expect(plain).not.toHaveProperty('skipDefaultDoneItems');
    const tooMany = Array.from({ length: 51 }, (_, index) => `Criterion ${index + 1}`);
    expect(issuePaths(CreateTaskInput.safeParse({ project: 'PAY', title: 'x', criteria: tooMany }))).toEqual([
      'criteria',
    ]);
    expect(
      issuePaths(CreateTaskInput.safeParse({ project: 'PAY', title: 'x', doneItems: ['two\nlines'] })),
    ).toEqual(['doneItems.0']);
    expect(CreateTaskInput.safeParse({ project: 'PAY', title: 'x', plan: 'x'.repeat(50_001) }).success).toBe(
      false,
    );
  });

  it('names the eight operations of each list', () => {
    expect(CRITERIA_OPERATION_FIELDS).toEqual([
      'addCriteria',
      'checkCriteria',
      'uncheckCriteria',
      'waiveCriteria',
      'unwaiveCriteria',
      'editCriteria',
      'moveCriteria',
      'removeCriteria',
    ]);
    expect(DONE_ITEM_OPERATION_FIELDS).toEqual([
      'addDoneItems',
      'checkDoneItems',
      'uncheckDoneItems',
      'waiveDoneItems',
      'unwaiveDoneItems',
      'editDoneItems',
      'moveDoneItems',
      'removeDoneItems',
    ]);
  });

  it('accepts each item operation, plan and finalSummary as the only change', () => {
    const changes: Record<string, unknown>[] = [];
    for (const list of ['Criteria', 'DoneItems']) {
      changes.push(
        { [`add${list}`]: ['Refunds post a ledger entry'] },
        { [`check${list}`]: [1, 2] },
        { [`uncheck${list}`]: [1] },
        { [`waive${list}`]: [{ number: 5, reason: 'Load test replaced by a replay' }] },
        { [`unwaive${list}`]: [5] },
        { [`edit${list}`]: [{ number: 1, text: 'Refunds post one ledger entry' }] },
        { [`move${list}`]: [{ from: 3, to: 1 }] },
        { [`remove${list}`]: [3] },
      );
    }
    changes.push({ plan: '1. Ledger' }, { plan: null }, { finalSummary: 'Done.' }, { finalSummary: null });
    for (const change of changes) {
      expect(UpdateTaskInput.safeParse({ key: 'PAY-142', ...change }).success, JSON.stringify(change)).toBe(
        true,
      );
    }
  });

  it('de-duplicates numbers and checks them, the texts and the reasons', () => {
    expect(UpdateTaskInput.parse({ key: 'PAY-142', checkCriteria: [2, 1, 2] }).checkCriteria).toEqual([2, 1]);
    for (const bad of [
      { checkCriteria: [0] },
      { checkCriteria: [51] },
      { checkCriteria: [1.5] },
      { checkCriteria: ['1'] },
      { addCriteria: [''] },
      { addCriteria: ['x'.repeat(501)] },
      { addDoneItems: ['two\nlines'] },
      { addCriteria: Array.from({ length: 51 }, () => 'x') },
      { waiveCriteria: [{ number: 5 }] },
      { waiveCriteria: [{ number: 5, reason: ' ' }] },
      { editDoneItems: [{ number: 1, text: '' }] },
      { moveCriteria: [{ from: 1 }] },
      { plan: 'x'.repeat(50_001) },
      { finalSummary: 'x'.repeat(50_001) },
    ]) {
      expect(UpdateTaskInput.safeParse({ key: 'PAY-142', ...bad }).success, JSON.stringify(bad)).toBe(false);
    }
  });

  it('refuses setting and clearing the same item in one request', () => {
    const paths = (change: Record<string, unknown>) =>
      issuePaths(UpdateTaskInput.safeParse({ key: 'PAY-142', ...change }));
    expect(paths({ checkCriteria: [1, 2], uncheckCriteria: [2] })).toEqual(['uncheckCriteria']);
    expect(paths({ checkDoneItems: [1], waiveDoneItems: [{ number: 1, reason: 'n/a' }] })).toEqual([
      'waiveDoneItems',
    ]);
    expect(paths({ waiveCriteria: [{ number: 4, reason: 'n/a' }], unwaiveCriteria: [4] })).toEqual([
      'unwaiveCriteria',
    ]);
    expect(
      paths({
        waiveCriteria: [
          { number: 4, reason: 'n/a' },
          { number: 4, reason: 'again' },
        ],
      }),
    ).toEqual(['waiveCriteria']);
    expect(
      paths({
        editCriteria: [
          { number: 1, text: 'a' },
          { number: 1, text: 'b' },
        ],
      }),
    ).toEqual(['editCriteria']);
    // The two lists are separate: criterion 1 and done item 1 are different items.
    expect(paths({ checkCriteria: [1], uncheckDoneItems: [1] })).toEqual([]);
  });

  it('takes ifStatus as a precondition, not a change', () => {
    expect(UpdateTaskInput.parse({ key: 'PAY-142', status: 'done', ifStatus: 'in_review' })).toMatchObject({
      status: 'done',
      ifStatus: 'in_review',
    });
    expect(UpdateTaskInput.safeParse({ key: 'PAY-142', ifStatus: 'in_review' }).success).toBe(false);
    expect(UpdateTaskInput.safeParse({ key: 'PAY-142', status: 'done', ifStatus: 'started' }).success).toBe(
      false,
    );
  });

  it('writes notes through the comment input', () => {
    expect(CreateCommentInput.parse({ key: 'PAY-142', body: 'Migration written', kind: 'note' }).kind).toBe(
      'note',
    );
    expect(CreateCommentInput.parse({ key: 'PAY-142', body: 'Hi' })).not.toHaveProperty('kind');
    expect(CreateCommentInput.safeParse({ key: 'PAY-142', body: 'Hi', kind: 'memo' }).success).toBe(false);
  });

  it('filters the timeline', () => {
    for (const show of ['all', 'comments', 'notes', 'history']) {
      expect(ListTaskTimelineInput.parse({ key: 'PAY-142', show }).show).toBe(show);
    }
    expect(ListTaskTimelineInput.parse({ key: 'PAY-142' })).toEqual({ key: 'PAY-142' });
    expect(ListTaskTimelineInput.safeParse({ key: 'PAY-142', show: 'activity' }).success).toBe(false);
  });

  it('sets, trims and limits project default done items', () => {
    expect(
      UpdateProjectInput.parse({ project: 'PAY', defaultDoneItems: [' Tests pass ', 'Docs updated'] }),
    ).toEqual({ project: 'PAY', defaultDoneItems: ['Tests pass', 'Docs updated'] });
    expect(UpdateProjectInput.parse({ project: 'PAY', defaultDoneItems: [] }).defaultDoneItems).toEqual([]);
    expect(
      UpdateProjectInput.safeParse({
        project: 'PAY',
        defaultDoneItems: Array.from({ length: 51 }, () => 'x'),
      }).success,
    ).toBe(false);
    expect(UpdateProjectInput.safeParse({ project: 'PAY', defaultDoneItems: ['a\nb'] }).success).toBe(false);
  });

  it('exports a project by key', () => {
    expect(ExportBacklogInput.parse({ project: 'pay' })).toEqual({ project: 'PAY' });
    expect(ExportBacklogInput.safeParse({}).success).toBe(false);
  });
});

describe('M6 sources', () => {
  it('names the two CLI headers', () => {
    expect(SOURCE_HEADERS).toEqual({ machine: 'x-zamu-machine', branch: 'x-zamu-branch' });
    expect(MAX_SOURCE_LENGTH).toBe(100);
  });

  it('reads header values trimmed and cut, and drops empty or control-character ones', () => {
    expect(parseSourceHeader('  ana-laptop ')).toBe('ana-laptop');
    expect(parseSourceHeader('feat/webhook-retries')).toBe('feat/webhook-retries');
    expect(parseSourceHeader('x'.repeat(150))).toBe('x'.repeat(100));
    expect(parseSourceHeader('é'.repeat(101))).toBe('é'.repeat(100));
    expect(parseSourceHeader('')).toBeNull();
    expect(parseSourceHeader('   ')).toBeNull();
    expect(parseSourceHeader(null)).toBeNull();
    expect(parseSourceHeader(undefined)).toBeNull();
    expect(parseSourceHeader('bad\u0007bell')).toBeNull();
    expect(parseSourceHeader('tab\tinside')).toBeNull();
  });
});

describe('M6 Backlog.md export', () => {
  it('returns files under the owned folders and the prefixes to prune', () => {
    const result = BacklogExport.parse(backlogExportFixture);
    expect(result.files).toHaveLength(3);
    expect(result.generatedAt).toBe('2026-10-23T08:00:00.000Z');
    expect(
      BacklogExport.safeParse({
        ...backlogExportFixture,
        files: [backlogExportFixture.files[0], backlogExportFixture.files[0]],
      }).success,
    ).toBe(false);
    expect(BacklogExport.safeParse({ ...backlogExportFixture, removedPrefixes: ['docs/'] }).success).toBe(
      false,
    );
  });

  it('refuses paths outside the owned folders', () => {
    for (const ok of ['tasks/pay-1 - A.md', 'completed/pay-2 - B.md', 'milestones/m-1 - v2.md']) {
      expect(BacklogExportPath.safeParse(ok).success, ok).toBe(true);
    }
    for (const bad of [
      '',
      '/tasks/pay-1.md',
      'tasks/../config.yml',
      'tasks/./pay-1.md',
      'tasks//pay-1.md',
      'docs/readme.md',
      'config.yml',
      'tasks\\pay-1.md',
      'tasks/pay\n1.md',
      'tasksx/pay-1.md',
    ]) {
      expect(BacklogExportPath.safeParse(bad).success, JSON.stringify(bad)).toBe(false);
    }
  });
});

describe('M6 problems', () => {
  const openItems = [
    { kind: 'criterion' as const, number: 2, text: 'Backoff doubles from 30 seconds' },
    { kind: 'done' as const, number: 1, text: 'Docs updated' },
  ];

  it('answers 409 OPEN_ITEMS with the open items', () => {
    expect(PROBLEM_STATUS.OPEN_ITEMS).toBe(409);
    expect(PROBLEM_TITLES.OPEN_ITEMS).toBe('Task has open items');
    expect(apiErrors.OPEN_ITEMS.status).toBe(409);
    const body = problem('OPEN_ITEMS', 'PAY-142 has 2 open items', { openItems });
    expect(Problem.parse(body)).toMatchObject({ status: 409, code: 'OPEN_ITEMS', openItems });
    expect(Problem.safeParse({ ...body, openItems: [{ kind: 'step', number: 1, text: 'x' }] }).success).toBe(
      false,
    );
  });

  it('carries the open items through encode and decode', () => {
    const error = new ORPCError('OPEN_ITEMS', {
      status: 409,
      message: 'PAY-142 has 2 open items',
      data: { openItems },
    });
    const encoded = encodeProblem(error);
    expect(encoded).toMatchObject({ code: 'OPEN_ITEMS', status: 409, openItems });
    const decoded = decodeProblem(encoded);
    expect(decoded?.code).toBe('OPEN_ITEMS');
    expect(decoded?.data.openItems).toEqual(openItems);
    expect(encodeProblem(new ORPCError('CONFLICT', { status: 409 }))).not.toHaveProperty('openItems');
  });
});

describe('M6 routes', () => {
  it('reads the export with GET /projects/{project}/backlog/export', () => {
    expect(contract.backlog.export['~orpc'].route).toMatchObject({
      method: 'GET',
      path: '/api/v1/projects/{project}/backlog/export',
    });
  });
});

describe('M6 CLI output', () => {
  const entry = {
    id: 'q-01',
    queuedAt: '2026-10-22T18:00:00.000Z',
    url: 'https://zamu.example.com',
    project: 'PAY',
    taskKey: 'PAY-142',
    procedure: 'tasks.update',
    input: { key: 'PAY-142', status: 'in_review' },
    lastSeenStatus: 'in_progress',
    summary: 'move to In review',
  } as const;

  it('shows the work record and the timeline counts', () => {
    const output = cliOutput('tasks.show', {
      task: workRecordTaskFixture,
      activity: [],
      timeline: workRecordTimelineFixture.items,
      timelineCounts: workRecordTimelineFixture.counts,
    });
    expect(output.schema).toBe('zamu.v1.tasks.show');
    expect(output.data.task.criteria).toHaveLength(3);
    expect(output.data.timelineCounts?.notes).toBe(1);
    expect(cliOutput('notes.add', noteFixture).data.kind).toBe('note');
  });

  it('describes the export, instructions, the queue and queued writes', () => {
    expect(
      cliOutput('backlog.export', {
        project: 'PAY',
        dir: '/work/payments/backlog',
        dryRun: true,
        format: 'backlog.md 1',
        files: [
          { path: 'tasks/pay-142 - Retry.md', action: 'updated' },
          { path: 'tasks/pay-9 - Gone.md', action: 'removed' },
        ],
      }).schema,
    ).toBe('zamu.v1.backlog.export');
    expect(() =>
      cliOutput('backlog.export', {
        project: 'PAY',
        dir: 'backlog',
        dryRun: false,
        format: 'x',
        files: [{ path: 'tasks/a.md', action: 'moved' as 'created' }],
      }),
    ).toThrow();
    for (const topic of ['overview', 'creating', 'working', 'finishing'] as const) {
      expect(cliOutput('instructions', { topic, text: 'Search before creating.' }).data.topic).toBe(topic);
    }
    expect(cliOutput('queue.list', { items: [entry] }).data.items[0]?.summary).toBe('move to In review');
    expect(cliOutput('queue.drop', { dropped: entry }).schema).toBe('zamu.v1.queue.drop');
    expect(parseCliOutput({ schema: 'zamu.v1.queued', data: { entry } }, 'queued').data.entry.id).toBe(
      'q-01',
    );
    expect(CLI_EXIT_QUEUED).toBe(7);
  });

  it('validates queue entries and the queue file', () => {
    expect(CliQueueEntry.safeParse(entry).success).toBe(true);
    expect(CliQueueEntry.safeParse({ ...entry, procedure: 'tasks.create' }).success).toBe(false);
    expect(
      CliQueueEntry.safeParse({ ...entry, lastSeenStatus: null, procedure: 'comments.create' }).success,
    ).toBe(true);
    expect(CliQueueFile.parse({ version: 1, entries: [entry] }).entries).toHaveLength(1);
    expect(CliQueueFile.safeParse({ version: 2, entries: [] }).success).toBe(false);
  });

  it('adds the queue count to whoami and the Backlog.md block flag to agents', () => {
    expect(cliOutput('whoami', { ...meFixture, project: null, queued: 2 }).data.queued).toBe(2);
    expect(cliOutput('whoami', meFixture).data.queued).toBeUndefined();
    expect(
      cliOutput('agents', {
        file: 'AGENTS.md',
        action: 'updated',
        project: 'PAY',
        block: 'Tasks are in Zamu.',
        replacedBacklogBlock: true,
      }).data.replacedBacklogBlock,
    ).toBe(true);
  });
});
