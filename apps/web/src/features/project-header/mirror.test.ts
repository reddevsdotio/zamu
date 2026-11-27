import type { ProjectBacklogSummary, TaskListItem } from '@zamu/contracts';
import { describe, expect, it } from 'vitest';
import { buildHiddenGroup, HIDDEN_GROUP_LABEL } from '~/features/tasks/groups';
import { hasFilters, hiddenStatuses, listInput, parseTaskListSearch } from '~/features/tasks/search';
import { removedText } from '~/features/tasks/TaskTable';
import {
  createRefusalText,
  describeProblems,
  detachedText,
  isDetached,
  isMirrored,
  milestoneRefusalText,
  parentKeyOf,
  repositoryShort,
  SOURCE_TITLES,
  sourceDotState,
  sourceTitle,
  statusRefusalText,
  triggerText,
} from './mirror';

const summary = (overrides: Partial<ProjectBacklogSummary> = {}): ProjectBacklogSummary => ({
  mode: 'mirror',
  state: 'healthy',
  defaultBranch: 'main',
  lastReadAt: '2026-10-23T10:00:00.000Z',
  lastReadCommit: 'a1b2c3d4',
  lastTrigger: 'webhook',
  problems: { files: 0, values: 0 },
  hidden: 0,
  detachedAt: null,
  ...overrides,
});

describe('mirror rules', () => {
  it('counts every source that is not detached, imports before their first read too', () => {
    expect(isMirrored({ backlog: summary() })).toBe(true);
    expect(isMirrored({ backlog: summary({ state: 'paused' }) })).toBe(true);
    expect(isMirrored({ backlog: summary({ mode: 'import', state: 'setup' }) })).toBe(true);
    expect(isMirrored({ backlog: summary({ state: 'detached', detachedAt: '2026-10-23T11:00:00Z' }) })).toBe(
      false,
    );
    expect(isMirrored({ backlog: null })).toBe(false);
    expect(isMirrored({})).toBe(false);
    expect(isMirrored(undefined)).toBe(false);
    expect(isDetached({ backlog: summary({ state: 'detached', detachedAt: '2026-10-23T11:00:00Z' }) })).toBe(
      true,
    );
    expect(isDetached({ backlog: summary() })).toBe(false);
  });

  it('names a switched project "Owned by Zamu" and a finished import "Imported" (PM-33)', () => {
    expect(sourceTitle(summary({ state: 'detached', mode: 'mirror' }))).toBe('Owned by Zamu');
    expect(sourceTitle(summary({ state: 'detached', mode: 'import' }))).toBe('Imported');
    expect(sourceTitle(summary({ state: 'healthy', mode: 'mirror' }))).toBe('Mirroring');
    expect(Object.values(SOURCE_TITLES)).not.toContain('Detached');
    expect(detachedText('Payments')).toBe('Payments is owned by Zamu now. Everything is editable here.');
  });

  it('maps states to the dot and triggers to words', () => {
    expect(sourceDotState('setup')).toBe('reading');
    expect(sourceDotState('warnings')).toBe('warnings');
    expect(triggerText('webhook')).toBe('by webhook');
    expect(triggerText('poll')).toBe('by the hourly check');
    expect(triggerText(null)).toBe('');
    expect(repositoryShort('git@gitlab.com:reddevs/payments.git')).toBe('gitlab.com/reddevs/payments');
    expect(repositoryShort(null)).toBeNull();
  });

  it('describes problems from the items when they are all loaded, from the counts otherwise', () => {
    const counts = { files: 2, values: 1 };
    const items = [
      { kind: 'file' as const, path: 'a.md', backlogId: null, skipped: true, message: 'x' },
      { kind: 'file' as const, path: 'b.md', backlogId: null, skipped: true, message: 'x' },
      {
        kind: 'value' as const,
        field: 'status' as const,
        value: 'Blocked',
        count: 3,
        fallback: 'Todo',
        message: 'x',
      },
    ];
    expect(describeProblems(counts, items)).toBe('2 files skipped, 1 status unmapped');
    expect(describeProblems(counts)).toBe('2 files with problems, 1 value unmapped');
    expect(describeProblems({ files: 0, values: 0 })).toBe('None');
  });

  it('writes the refusals with the design copy', () => {
    expect(createRefusalText('Payments')).toBe(
      'Tasks in Payments come from Backlog.md. Add a file under backlog/tasks/, or run backlog task create, and push. It shows up here after the next refresh.',
    );
    expect(milestoneRefusalText('Payments')).toBe(
      'Milestones in Payments come from Backlog.md. Add a file under backlog/milestones/ and push.',
    );
    expect(statusRefusalText('PAY-786', 'In progress')).toBe(
      'PAY-786 stays in In progress: its status comes from Backlog.md.',
    );
  });

  it('finds the parent of a suffixed key', () => {
    expect(parentKeyOf('PAY-786.1')).toBe('PAY-786');
    expect(parentKeyOf('PAY-786.1.2')).toBe('PAY-786.1');
    expect(parentKeyOf('PAY-786')).toBeNull();
  });
});

describe('hidden tasks list', () => {
  const item = (key: string, hiddenAt: string, commentCount = 0): TaskListItem => ({
    id: `20000000-0000-4000-8000-${key.replace(/\D/g, '').padStart(12, '0')}`,
    key,
    number: Number(key.replace(/\D/g, '')),
    project: { id: '10000000-0000-4000-8000-000000000001', key: 'PAY', name: 'Payments' },
    title: key,
    status: 'todo',
    priority: 'medium',
    assignee: null,
    milestone: null,
    cycle: null,
    cycleAddedAt: null,
    rank: 1,
    hidden: true,
    hiddenAt,
    commentCount,
    createdAt: '2026-10-01T10:00:00.000Z',
    updatedAt: '2026-10-01T10:00:00.000Z',
  });

  it('reads ?hidden=only and asks the API for hidden tasks of every status', () => {
    const search = parseTaskListSearch({ hidden: 'only', status: 'todo' });
    expect(search.hidden).toBe('only');
    expect(parseTaskListSearch({ hidden: 'yes' }).hidden).toBeUndefined();
    expect(hasFilters({ hidden: 'only' })).toBe(true);
    expect(listInput('PAY', { hidden: 'only' }, hiddenStatuses({}))).toMatchObject({
      hidden: 'only',
      status: ['in_progress', 'in_review', 'todo', 'backlog', 'done', 'canceled'],
    });
    expect(listInput('PAY', {}, ['todo'])).not.toHaveProperty('hidden');
  });

  it('shows one group, most recently removed first, with the removal note', () => {
    const groups = buildHiddenGroup([
      item('PAY-640', '2026-10-12T10:00:00.000Z'),
      item('PAY-233', '2026-10-22T10:00:00.000Z', 3),
    ]);
    expect(groups).toHaveLength(1);
    expect(groups[0]?.label).toBe(HIDDEN_GROUP_LABEL);
    expect(groups[0]?.items.map((task) => task.key)).toEqual(['PAY-233', 'PAY-640']);
    const now = new Date('2026-10-23T12:00:00.000Z');
    expect(removedText(item('PAY-233', '2026-10-22T10:00:00.000Z', 3), now)).toBe(
      'removed Oct 22 · 3 comments',
    );
    expect(removedText(item('PAY-611', '2026-10-20T10:00:00.000Z', 1), now)).toBe(
      'removed Oct 20 · 1 comment',
    );
    expect(buildHiddenGroup([])).toEqual([]);
  });
});
