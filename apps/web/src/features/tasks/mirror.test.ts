import type { ProjectActivity, Task } from '@zamu/contracts';
import { describe, expect, it } from 'vitest';
import {
  describeBacklogFields,
  describeProjectEntry,
  describeVisibilityChange,
  fileFields,
  mirrorOf,
  projectRowsForTask,
} from './mirror';

const backlog = (id: string, kind: 'task' | 'draft' = 'task') =>
  ({ id, file: null, fileUrl: null, data: { kind } }) as unknown as Task['backlog'];

describe('mirrorOf', () => {
  it('tells mirrored, detached and native tasks apart', () => {
    expect(mirrorOf({ locked: ['status'], backlog: backlog('BACK-1') } as Task)).toMatchObject({
      isMirrored: true,
      isDetached: false,
      backlogId: 'BACK-1',
    });
    expect(mirrorOf({ locked: [], backlog: backlog('BACK-1') } as unknown as Task)).toMatchObject({
      isMirrored: false,
      isDetached: true,
    });
    expect(mirrorOf({ backlogId: 'BACK-2', hidden: true } as unknown as Task)).toMatchObject({
      backlogId: 'BACK-2',
      isHidden: true,
    });
    expect(mirrorOf(undefined)).toMatchObject({ isMirrored: false, isDetached: false, backlogId: null });
  });
});

describe('history sentences', () => {
  it('names block-only fields and skips updated_date alone', () => {
    expect(describeBacklogFields(['labels', 'dueDate'])).toBe('changed the labels and the due date');
    expect(describeBacklogFields(['updatedDate'])).toBeNull();
    expect(describeVisibilityChange('task.hidden', 'main')).toBe('hid the task: its file is gone from main');
    expect(describeVisibilityChange('task.restored', null)).toBe(
      'brought the task back: its file is on the default branch again',
    );
  });

  const entry = (type: ProjectActivity['type'], tasks: number | null = null): ProjectActivity => ({
    id: type,
    type,
    actor: null,
    onBehalfOf: null,
    origin: 'backlog',
    originRef: 'abc',
    details: { mode: 'mirror', repository: null, tasks, milestones: null },
    createdAt: '2026-10-23T10:00:00Z',
  });

  it('shows the first read only for tasks it brought in, and always the detach', () => {
    const history = [entry('project.backlog_imported', 412), entry('project.backlog_detached')];
    expect(projectRowsForTask(history, [])).toHaveLength(2);
    expect(projectRowsForTask(history, [{ kind: 'activity', type: 'task.created' }])).toHaveLength(1);
    expect(describeProjectEntry(entry('project.backlog_imported', 412), 'Payments')).toBe(
      'imported this with 411 others',
    );
    expect(describeProjectEntry(entry('project.backlog_imported', 1), 'Payments')).toBe('imported this');
    expect(
      describeProjectEntry(entry('project.backlog_imported', 412), 'Payments', 'backlog/tasks/hbr-71.md'),
    ).toBe('imported this from backlog/tasks/hbr-71.md');
    expect(describeProjectEntry(entry('project.backlog_detached'), 'Payments')).toBe(
      'switched Payments to Zamu. Every field is editable now.',
    );
  });
});

describe('fileFields', () => {
  const data = {
    kind: 'task',
    status: 'In Progress',
    priority: 'high',
    milestone: 'm-1',
    assignees: [{ value: '@claude-dev', user: { id: 'u1', name: 'claude-dev', kind: 'agent' } }],
    reporter: '@ana',
    labels: ['i18n', 'frontend'],
    dependencies: [{ id: 'BACK-46', task: null }],
    parent: null,
    subtasks: [],
    dueDate: '2026-11-14',
    type: 'bug',
    references: ['docs/i18n.md'],
    documentation: [],
    modifiedFiles: ['apps/mobile/src/inbox/sort.ts', 'packages/i18n/inbox.json'],
    createdDate: '2026-10-12 09:14',
    updatedDate: null,
    ordinal: 3400,
    other: { effort: 'M' },
  };
  const task = (overrides: Record<string, unknown> = {}) =>
    ({
      assignee: { id: 'u1', name: 'claude-dev', kind: 'agent', responsible: null },
      backlog: {
        id: 'BACK-71',
        file: 'backlog/tasks/hbr-71.md',
        fileUrl: null,
        data: { ...data, ...overrides },
      },
    }) as unknown as Task;

  it('lists the fields with no native home, as written, and leaves the native ones out', () => {
    expect(fileFields(task())).toEqual([
      { key: 'type', value: 'bug' },
      { key: 'reporter', value: '@ana' },
      { key: 'references', value: 'docs/i18n.md' },
      { key: 'modified_files', value: 'apps/mobile/src/inbox/sort.ts, packages/i18n/inbox.json' },
      { key: 'created_date', value: '2026-10-12 09:14' },
      { key: 'ordinal', value: '3400' },
      { key: 'effort', value: 'M' },
    ]);
    const keys = fileFields(task()).map((row) => row.key);
    for (const native of ['labels', 'due_date', 'dependencies', 'parent_task_id', 'subtasks']) {
      expect(keys).not.toContain(native);
    }
  });

  it('adds the assignee values the field does not show', () => {
    const rows = fileFields(
      task({
        assignees: [
          { value: '@claude-dev', user: { id: 'u1', name: 'claude-dev', kind: 'agent' } },
          { value: '@tomas', user: null },
        ],
      }),
    );
    expect(rows).toContainEqual({ key: 'assignee', value: '@claude-dev, @tomas' });
  });

  it('is empty for native tasks', () => {
    expect(fileFields({ assignee: null, backlog: null } as unknown as Task)).toEqual([]);
  });
});
