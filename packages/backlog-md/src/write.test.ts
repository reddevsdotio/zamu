// The writer: files in the layout Backlog.md writes, read back by this package's reader with the same
// fields and work record, for hand-made tasks and for every task of the Backlog.md snapshot folder.
import { describe, expect, test } from 'vitest';
import { parseBacklogFolder } from './folder';
import { parseMilestone } from './milestone';
import { parseTask } from './task';
import { readFixtureTree } from './testing/fixtures';
import type { BacklogTask } from './types';
import { taskWorkRecord } from './work-record';
import {
  backlogTimestamp,
  formatImplementationNotes,
  milestoneFileName,
  type TaskFileInput,
  taskFileName,
  titleSlug,
  writeMilestoneFile,
  writeTaskFile,
} from './write';

const CREATED = new Date('2026-11-25T11:22:59.000Z');

function sample(overrides: Partial<TaskFileInput> = {}): TaskFileInput {
  return {
    id: 'PAY-1',
    title: 'Retry failed webhook deliveries',
    status: 'In Progress',
    assignees: ['@claude'],
    createdDate: CREATED,
    updatedDate: new Date('2026-11-25T11:24:19.500Z'),
    labels: ['webhooks', 'backend'],
    dependencies: [],
    priority: 'high',
    ordinal: 1000,
    description: 'Webhooks that fail are retried.',
    criteria: [
      { text: 'Retries use backoff', state: 'checked', waivedReason: null },
      { text: 'Gives up after 5', state: 'open', waivedReason: null },
    ],
    doneItems: [{ text: 'Tests pass', state: 'open', waivedReason: null }],
    plan: '1. Do it',
    implementationNotes: 'First note\n\nSecond note',
    finalSummary: 'Done it',
    ...overrides,
  };
}

describe('writeTaskFile', () => {
  test('writes the layout Backlog.md 1.57 writes', () => {
    expect(writeTaskFile(sample())).toBe(
      [
        '---',
        'id: PAY-1',
        'title: Retry failed webhook deliveries',
        'status: In Progress',
        'assignee:',
        "  - '@claude'",
        "created_date: '2026-11-25T11:22:59Z'",
        "updated_date: '2026-11-25T11:24:19Z'",
        'labels:',
        '  - webhooks',
        '  - backend',
        'dependencies: []',
        'priority: high',
        'ordinal: 1000',
        '---',
        '',
        '## Description',
        '',
        '<!-- SECTION:DESCRIPTION:BEGIN -->',
        'Webhooks that fail are retried.',
        '<!-- SECTION:DESCRIPTION:END -->',
        '',
        '## Acceptance Criteria',
        '<!-- AC:BEGIN -->',
        '- [x] #1 Retries use backoff',
        '- [ ] #2 Gives up after 5',
        '<!-- AC:END -->',
        '',
        '## Definition of Done',
        '<!-- DOD:BEGIN -->',
        '- [ ] #1 Tests pass',
        '<!-- DOD:END -->',
        '',
        '## Implementation Plan',
        '',
        '<!-- SECTION:PLAN:BEGIN -->',
        '1. Do it',
        '<!-- SECTION:PLAN:END -->',
        '',
        '## Implementation Notes',
        '',
        '<!-- SECTION:NOTES:BEGIN -->',
        'First note',
        '',
        'Second note',
        '<!-- SECTION:NOTES:END -->',
        '',
        '## Final Summary',
        '',
        '<!-- SECTION:FINAL_SUMMARY:BEGIN -->',
        'Done it',
        '<!-- SECTION:FINAL_SUMMARY:END -->',
        '',
      ].join('\n'),
    );
  });

  test('a task with nothing but front matter', () => {
    const text = writeTaskFile(
      sample({
        description: null,
        criteria: [],
        doneItems: [],
        plan: null,
        implementationNotes: null,
        finalSummary: '  ',
        updatedDate: null,
        priority: null,
        ordinal: null,
      }),
    );
    expect(text.endsWith('dependencies: []\n---\n')).toBe(true);
  });

  test('reads back with the same fields, waivers in the Zamu block', () => {
    const input = sample({
      id: 'PAY-12.1',
      title: 'Ledger: entries #1',
      assignees: ['@claude', 'Tomás Berg'],
      reporter: '@ana',
      milestone: 'm-2',
      dependencies: ['PAY-3', 'PAY-4'],
      parentId: 'PAY-12',
      dueDate: '2026-12-01',
      type: 'feature',
      references: ['https://example.com/spec'],
      documentation: ['docs/ledger.md'],
      modifiedFiles: ['src/ledger.ts'],
      other: { estimate: 3, title: 'ignored, the writer sets it' },
      criteria: [
        { text: 'Retries use backoff', state: 'checked', waivedReason: null },
        { text: 'Load test passes', state: 'waived', waivedReason: 'Replaced by a replay' },
        { text: '#3 starts with a hash', state: 'open', waivedReason: null },
      ],
      doneItems: [{ text: 'Docs updated', state: 'waived', waivedReason: 'No docs for this one' }],
    });
    const text = writeTaskFile(input);
    expect(text).toContain('- [ ] #2 Load test passes');
    expect(text.trimEnd().endsWith('<!-- zamu:end -->')).toBe(true);
    const read = parseTask(`backlog/tasks/${taskFileName(input.id, input.title)}`, text);
    if (!read.ok) throw new Error(read.error.message);
    expect(read.warnings.filter((warning) => warning.code !== 'missing_status')).toEqual([]);
    expect(read.value).toMatchObject({
      id: { id: 'PAY-12.1', number: 12, suffix: '1' },
      title: 'Ledger: entries #1',
      status: 'In Progress',
      assignees: ['@claude', 'Tomás Berg'],
      reporter: '@ana',
      createdDate: CREATED,
      labels: ['webhooks', 'backend'],
      milestone: 'm-2',
      dependencies: ['PAY-3', 'PAY-4'],
      parentId: 'PAY-12',
      dueDate: '2026-12-01',
      priority: 'high',
      type: 'feature',
      references: ['https://example.com/spec'],
      documentation: ['docs/ledger.md'],
      modifiedFiles: ['src/ledger.ts'],
      ordinal: 1000,
      unknown: { estimate: 3 },
    });
    expect(taskWorkRecord(read.value)).toEqual({
      description: input.description,
      criteria: input.criteria,
      doneItems: input.doneItems,
      plan: input.plan,
      finalSummary: input.finalSummary,
      implementationNotes: input.implementationNotes,
    });
  });
});

describe('file names', () => {
  test('as Backlog.md names them', () => {
    expect(taskFileName('PAY-1', 'Retry failed webhook deliveries')).toBe(
      'pay-1 - Retry-failed-webhook-deliveries.md',
    );
    expect(taskFileName('PAY-1.2', 'Fix: "quotes" / slashes? <ok>')).toBe(
      'pay-1.2 - Fix-quotes-slashes-ok.md',
    );
    expect(milestoneFileName('m-0', 'Webhooks v2')).toBe('m-0 - webhooks-v2.md');
    expect(titleSlug('   ')).toBe('untitled');
    expect(titleSlug('Café ✓ — done.')).toBe('Café-✓-—-done');
    expect([...titleSlug('word '.repeat(40))].length).toBeLessThanOrEqual(80);
  });
});

test('milestone files read back', () => {
  const text = writeMilestoneFile({
    id: 'm-3',
    title: 'Webhooks v2',
    description: 'Retries.',
    dueDate: '2026-12-01',
  });
  const read = parseMilestone(`backlog/milestones/${milestoneFileName('m-3', 'Webhooks v2')}`, text);
  expect(read).toMatchObject({
    ok: true,
    value: { id: 'm-3', title: 'Webhooks v2', description: 'Retries.', dueDate: '2026-12-01' },
  });
  expect(writeMilestoneFile({ id: 'm-4', title: 'Later', description: null })).toContain('Milestone: Later');
});

test('formatImplementationNotes keeps the file text and adds each note with its author and time', () => {
  expect(
    formatImplementationNotes(
      [
        {
          author: 'claude',
          onBehalfOf: 'Ana Berg',
          at: new Date('2026-11-20T14:05:09Z'),
          body: 'Wrote the migration.\n',
        },
        { author: 'Ana Berg', at: new Date('2026-11-21T08:00:00Z'), body: '   ' },
        { author: 'Ana Berg', at: new Date('2026-11-21T09:30:00Z'), body: 'Reviewed.' },
      ],
      'From the file.',
    ),
  ).toBe(
    [
      'From the file.',
      '',
      '**claude (for Ana Berg)** · 2026-11-20 14:05 UTC',
      '',
      'Wrote the migration.',
      '',
      '**Ana Berg** · 2026-11-21 09:30 UTC',
      '',
      'Reviewed.',
    ].join('\n'),
  );
  expect(formatImplementationNotes([], null)).toBeNull();
  expect(backlogTimestamp(new Date('2026-01-02T03:04:05.678Z'))).toBe('2026-01-02T03:04:05Z');
});

/** The input that writes `task` back out: its fields and the work record a mirror fills from it. */
function inputOf(task: BacklogTask): TaskFileInput {
  const record = taskWorkRecord(task);
  return {
    id: task.id.id,
    title: task.title,
    status: task.status ?? 'To Do',
    assignees: task.assignees,
    reporter: task.reporter,
    createdDate: task.createdDate ?? CREATED,
    updatedDate: task.updatedDate,
    labels: task.labels,
    milestone: task.milestone,
    dependencies: task.dependencies,
    parentId: task.parentId,
    priority: task.priority,
    dueDate: task.dueDate,
    type: task.type,
    references: task.references,
    documentation: task.documentation,
    modifiedFiles: task.modifiedFiles,
    ordinal: task.ordinal,
    description: record.description,
    criteria: record.criteria,
    doneItems: record.doneItems,
    plan: record.plan,
    implementationNotes: record.implementationNotes,
    finalSummary: record.finalSummary,
  };
}

test('every task of the Backlog.md snapshot folder writes out and reads back the same', () => {
  const folder = parseBacklogFolder(readFixtureTree('snapshot'), 'backlog');
  // Timestamps go out in whole seconds.
  const seconds = (date: Date | null | undefined) => (date ? Math.floor(date.getTime() / 1000) : null);
  const comparable = (input: TaskFileInput) => ({
    ...input,
    createdDate: seconds(input.createdDate),
    updatedDate: seconds(input.updatedDate),
  });
  const roundTrip = (path: string, input: TaskFileInput) => {
    const read = parseTask(path, writeTaskFile(input), folder.effectiveConfig);
    if (!read.ok) throw new Error(`${path}: ${read.error.message}`);
    return inputOf(read.value);
  };
  let count = 0;
  const settled: string[] = [];
  for (const file of folder.files) {
    if (!file.result.ok || !('sections' in file.result.value)) continue;
    const input = inputOf(file.result.value);
    const again = roundTrip(file.path, input);
    count += 1;
    if (JSON.stringify(comparable(again)) === JSON.stringify(comparable(input))) continue;
    // A checklist line indented by one space is prose in the file but turns into an item once the
    // description is trimmed (as the migration's backfill does too); such files settle after one pass.
    settled.push(file.path);
    expect(comparable(roundTrip(file.path, again)), file.path).toEqual(comparable(again));
  }
  expect(count).toBeGreaterThan(700);
  expect(settled).toEqual(['backlog/completed/back-4.12 - cli-handle-task-id-conflicts-across-branches.md']);
});
