import { ORPCError } from '@orpc/client';
import type { Activity, TaskListItem } from '@zamu/contracts';
import { describe, expect, it } from 'vitest';
import { describeError } from './errors';
import {
  describeActivity,
  describeCheckboxChange,
  findCheckboxes,
  formatAge,
  formatPageTime,
  formatPaneTime,
  formatRelative,
  toggleCheckbox,
} from './format';
import { buildGroups } from './groups';
import { listSearchFor, rememberListSearch } from './list-memory';
import { patchList } from './queries';
import { eagerStatuses, listInput, parseTaskListSearch, visibleStatuses } from './search';

const NOW = new Date(2026, 9, 22, 18, 0);
const ago = (ms: number) => new Date(NOW.getTime() - ms);
const MIN = 60_000;

describe('times', () => {
  it('formats the task view history times', () => {
    expect(formatRelative(ago(20_000), NOW)).toBe('Just now');
    expect(formatRelative(ago(38 * MIN), NOW)).toBe('38 min ago');
    expect(formatRelative(ago(2 * 60 * MIN), NOW)).toBe('2 h ago');
    expect(formatRelative(new Date(2026, 9, 14, 9, 0), NOW)).toBe('Oct 14');
  });

  it('formats the list age column', () => {
    expect(formatAge(ago(20_000), NOW)).toBe('now');
    expect(formatAge(ago(3 * MIN), NOW)).toBe('3m');
    expect(formatAge(ago(90 * MIN), NOW)).toBe('1h');
    expect(formatAge(ago(2 * 24 * 60 * MIN), NOW)).toBe('2d');
    expect(formatAge(new Date(2026, 9, 2), NOW)).toBe('Oct 2');
    expect(formatAge(new Date(2025, 9, 2), NOW)).toBe('Oct 2, 2025');
  });

  it('uses dates after a day in the pane and date with time on the page', () => {
    expect(formatPaneTime(ago(40 * MIN), NOW)).toBe('40m');
    expect(formatPaneTime(new Date(2026, 9, 20, 9, 0), NOW)).toBe('Oct 20');
    expect(formatPageTime(ago(5 * 60 * MIN), NOW)).toBe('5h ago');
    expect(formatPageTime(new Date(2026, 9, 21, 16, 2), NOW)).toBe('Oct 21, 16:02');
  });
});

describe('Markdown checkboxes', () => {
  const source = '- [x] one\n- [ ] two\n\n```\n- [ ] not a box\n```\n\n1. [ ] three';

  it('finds task list items outside code fences', () => {
    expect(findCheckboxes(source)).toEqual([
      { line: 0, checked: true },
      { line: 1, checked: false },
      { line: 7, checked: false },
    ]);
  });

  it('toggles one box and leaves the rest alone', () => {
    expect(toggleCheckbox(source, 1)).toBe(source.replace('- [ ] two', '- [x] two'));
    expect(toggleCheckbox(source, 0)).toBe(source.replace('- [x] one', '- [ ] one'));
    expect(toggleCheckbox(source, 9)).toBe(source);
  });

  it('describes box-only edits', () => {
    const before = '- [ ] a\n- [ ] b\n- [x] c';
    expect(describeCheckboxChange(before, '- [x] a\n- [x] b\n- [x] c')).toBe('checked off 2 items');
    expect(describeCheckboxChange(before, '- [ ] a\n- [ ] b\n- [ ] c')).toBe('unchecked 1 item');
    expect(describeCheckboxChange(before, '- [x] a\n- [ ] b\n- [x] c changed')).toBeNull();
  });
});

describe('activity sentences', () => {
  const user = (name: string) => ({
    id: '00000000-0000-4000-8000-000000000001',
    name,
    kind: 'person' as const,
  });
  const updated = (changes: Activity['changes']) => describeActivity({ type: 'task.updated', changes });

  it('phrases each kind of change', () => {
    expect(describeActivity({ type: 'task.created', changes: [] })).toBe('created this task');
    expect(updated([{ field: 'status', from: 'todo', to: 'in_progress' }])).toBe('moved this to In progress');
    expect(updated([{ field: 'priority', from: 'none', to: 'high' }])).toBe('set priority to High');
    expect(updated([{ field: 'priority', from: 'high', to: 'none' }])).toBe('cleared the priority');
    expect(updated([{ field: 'assignee', from: null, to: user('claude-dev') }])).toBe(
      'assigned this to claude-dev',
    );
    expect(updated([{ field: 'assignee', from: user('Ana Ruiz'), to: null }])).toBe('unassigned this');
    expect(updated([{ field: 'description', from: null, to: 'x' }])).toBe('added a description');
    expect(updated([{ field: 'description', from: 'x', to: 'y' }])).toBe('edited the description');
    expect(
      updated([
        { field: 'status', from: 'todo', to: 'done' },
        { field: 'priority', from: 'none', to: 'low' },
        { field: 'title', from: 'a', to: 'b' },
      ]),
    ).toBe('moved this to Done, set priority to Low and renamed this to “b”');
  });

  it('phrases milestone and cycle changes', () => {
    const milestone = { id: '00000000-0000-4000-8000-0000000000b1', name: 'Webhooks v2' };
    const cycle = (number: number) => ({
      id: `00000000-0000-4000-8000-0000000000c${number}`,
      number,
      name: null,
    });
    expect(updated([{ field: 'milestone', from: null, to: milestone }])).toBe(
      'set the milestone to Webhooks v2',
    );
    expect(updated([{ field: 'milestone', from: milestone, to: null }])).toBe('cleared the milestone');
    expect(updated([{ field: 'cycle', from: cycle(2), to: cycle(3) }])).toBe('moved this to Cycle 3');
    expect(updated([{ field: 'cycle', from: cycle(2), to: null }])).toBe('removed this from Cycle 2');
  });

  it('phrases labels, due dates, blockers and the parent as the task view does', () => {
    const label = (name: string) => ({
      id: `00000000-0000-4000-8000-${name.length.toString().padStart(12, '0')}`,
      name,
      color: 1,
    });
    const task = (key: string) => ({ key, title: key, removed: false });
    expect(updated([{ field: 'labels', from: [], to: [label('payouts')] }])).toBe('added the label payouts');
    expect(
      updated([
        {
          field: 'labels',
          from: [label('payouts')],
          to: [label('payouts'), label('backend'), label('customer-facing')],
        },
      ]),
    ).toBe('added the labels backend and customer-facing');
    expect(updated([{ field: 'labels', from: [label('ui')], to: [label('bug')] }])).toBe(
      'added the label bug and removed the label ui',
    );
    const year = new Date().getFullYear();
    expect(updated([{ field: 'dueDate', from: null, to: `${year}-10-31` }])).toBe(
      'set the due date to Oct 31',
    );
    expect(updated([{ field: 'dueDate', from: `${year}-10-31`, to: `${year}-11-14` }])).toBe(
      'moved the due date to Nov 14',
    );
    expect(updated([{ field: 'dueDate', from: `${year}-10-31`, to: null }])).toBe('cleared the due date');
    expect(updated([{ field: 'blockedBy', from: [], to: [task('PAY-120')] }])).toBe('added blocker PAY-120');
    expect(updated([{ field: 'blockedBy', from: [], to: [task('PAY-120'), task('PAY-138')] }])).toBe(
      'added blockers PAY-120 and PAY-138',
    );
    expect(updated([{ field: 'blockedBy', from: [task('PAY-120')], to: [] }])).toBe(
      'removed blocker PAY-120',
    );
    expect(updated([{ field: 'parent', from: null, to: task('PAY-120') }])).toBe(
      'made this a subtask of PAY-120',
    );
    expect(updated([{ field: 'parent', from: task('PAY-120'), to: null }])).toBe('moved this out of PAY-120');
  });
});

describe('URL search', () => {
  it('keeps known values and drops the rest', () => {
    expect(
      parseTaskListSearch({
        task: 'pay-142',
        q: 'webhook',
        status: ['todo', 'nope'],
        priority: 'high',
        assignee: 'agents',
        extra: 1,
      }),
    ).toEqual({ task: 'PAY-142', q: 'webhook', status: ['todo'], priority: ['high'], assignee: 'agents' });
    expect(parseTaskListSearch({ task: 'not a key', assignee: 'bob', status: [] })).toEqual({});
  });

  it('loads active groups eagerly and the filtered ones exactly', () => {
    expect(eagerStatuses({})).toEqual(['in_progress', 'in_review', 'todo']);
    expect(eagerStatuses({ status: ['done', 'todo'] })).toEqual(['todo', 'done']);
    expect(visibleStatuses({})).toHaveLength(6);
    expect(listInput('PAY', { q: '  ', priority: ['high'] }, ['todo'])).toEqual({
      project: ['PAY'],
      order: 'list',
      status: ['todo'],
      priority: ['high'],
    });
  });

  it('remembers the list filters for Back to list', () => {
    rememberListSearch('acme-id', 'PAY', { task: 'PAY-1', q: 'refund', status: ['todo'] });
    expect(listSearchFor('acme-id', 'PAY', 'PAY-9')).toEqual({
      q: 'refund',
      status: ['todo'],
      focus: 'PAY-9',
    });
    expect(listSearchFor('acme-id', 'WEB', 'WEB-1')).toEqual({ focus: 'WEB-1' });
    // Another workspace's PAY is another project.
    expect(listSearchFor('globex-id', 'PAY', 'PAY-9')).toEqual({ focus: 'PAY-9' });
  });
});

const item = (
  key: string,
  status: TaskListItem['status'],
  priority: TaskListItem['priority'],
  minutes: number,
) => ({
  id: `00000000-0000-4000-8000-${key.replace(/\D/g, '').padStart(12, '0')}`,
  key,
  number: Number(key.split('-')[1]),
  project: { id: '00000000-0000-4000-8000-0000000000aa', key: 'PAY', name: 'Payments' },
  title: key,
  status,
  priority,
  assignee: null,
  milestone: null,
  cycle: null,
  cycleAddedAt: null,
  rank: Number(key.split('-')[1]),
  createdAt: ago(minutes * MIN).toISOString(),
  updatedAt: ago(minutes * MIN).toISOString(),
});

describe('groups', () => {
  const counts = { in_progress: 2, in_review: 0, todo: 1, backlog: 3, done: 64, canceled: 0 };
  const eager = [
    item('PAY-1', 'todo', 'low', 1),
    item('PAY-2', 'in_progress', 'low', 1),
    item('PAY-3', 'in_progress', 'high', 30),
  ];

  it('orders groups, sorts rows like the API and keeps counted collapsed groups', () => {
    const groups = buildGroups([eager], visibleStatuses({}), counts);
    expect(groups.map((group) => [group.id, group.count, group.items.map((row) => row.key)])).toEqual([
      ['in_progress', 2, ['PAY-3', 'PAY-2']],
      ['todo', 1, ['PAY-1']],
      ['backlog', 3, []],
      ['done', 64, []],
    ]);
  });

  it('merges expanded groups and de-duplicates rows', () => {
    const backlog = [item('PAY-4', 'backlog', 'none', 5), item('PAY-1', 'todo', 'low', 1)];
    const groups = buildGroups([eager, backlog], visibleStatuses({}), counts);
    expect(groups.find((group) => group.id === 'backlog')?.items.map((row) => row.key)).toEqual(['PAY-4']);
    expect(groups.find((group) => group.id === 'todo')?.items).toHaveLength(1);
  });

  it('patches a cached list optimistically, moving counts with the status', () => {
    const data = { items: eager, counts };
    const next = patchList(data, 'PAY-1', { status: 'done', title: 'New' }, 'todo', 'T');
    expect(next.items[0]).toMatchObject({ key: 'PAY-1', status: 'done', title: 'New', updatedAt: 'T' });
    expect(next.counts).toMatchObject({ todo: 0, done: 65 });
    expect(data.items[0]?.status).toBe('todo');
  });
});

describe('error banner text', () => {
  it('reads the request id from the Problem data', () => {
    const error = new ORPCError('GATEWAY_TIMEOUT', { status: 504, data: { requestId: 'req_8f2c41' } });
    expect(describeError(error)).toEqual({
      message: 'The server took too long to answer.',
      requestId: 'req_8f2c41',
    });
    const timeout = Object.assign(new Error('aborted'), { name: 'TimeoutError' });
    expect(describeError(timeout)).toEqual({
      message: 'The server took too long to answer.',
      requestId: undefined,
    });
    expect(describeError(new ORPCError('FORBIDDEN')).message).toBe("You don't have access to this project.");
  });
});
