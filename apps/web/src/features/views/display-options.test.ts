import type { TaskListItem } from '@zamu/contracts';
import { describe, expect, it } from 'vitest';
import {
  BOARD_STATUS_ORDER,
  DEFAULT_DISPLAY_OPTIONS,
  defaultDisplayOptions,
  displayListInput,
  groupTasks,
  hideOldDone,
  isWaiting,
  normalizeDisplayOptions,
  sameDisplayOptions,
  showsProperty,
  waitingLook,
  withoutHiddenWaiting,
} from './display-options';

type Row = Pick<TaskListItem, 'key' | 'status' | 'priority' | 'updatedAt'> &
  Partial<Pick<TaskListItem, 'assignee' | 'milestone' | 'cycle' | 'labels'>>;

const ana = { id: 'u-ana', name: 'Ana Ruiz', kind: 'person' as const, responsible: null };
const bo = { id: 'u-bo', name: 'Bo Lind', kind: 'person' as const, responsible: null };
const bot = { id: 'u-bot', name: 'claude-dev', kind: 'agent' as const, responsible: ana };
const backend = { id: 'l-back', name: 'backend', color: 3, source: 'app' as const };
const mobile = { id: 'l-mob', name: 'mobile', color: 6, source: 'app' as const };

const row = (key: string, extra: Partial<Row> = {}): Row => ({
  key,
  status: 'todo',
  priority: 'none',
  updatedAt: '2026-11-01T10:00:00.000Z',
  ...extra,
});

describe('display option defaults', () => {
  it('follows the brief per view', () => {
    const list = defaultDisplayOptions('list');
    expect(list).toMatchObject({
      layout: 'list',
      groupBy: 'status',
      orderBy: 'priority',
      listSubtasks: 'nested',
      showEmptyGroups: false,
      hideDoneAfterDays: 14,
    });
    expect(list.properties).toMatchObject({
      key: true,
      priority: true,
      labels: true,
      subtasks: true,
      criteria: false,
      due: true,
      blocked: true,
      assignee: true,
      milestone: false,
      cycle: false,
      created: false,
      updated: true,
    });
    const board = defaultDisplayOptions('board');
    expect(board).toMatchObject({
      layout: 'board',
      groupBy: 'status',
      swimlanes: 'none',
      boardSubtasks: 'expandable',
    });
    expect(board.properties.updated).toBe(false);
    // M6: the criteria marker is off by default on cards too.
    expect(board.properties.criteria).toBe(false);
    expect(defaultDisplayOptions('home')).toMatchObject({ layout: 'list', groupBy: 'none' });
  });

  it('normalizes stored options, keeping what it understands', () => {
    const value = normalizeDisplayOptions('board', {
      layout: 'list',
      groupBy: 'assignee',
      swimlanes: 'assignee',
      orderBy: 'nonsense',
      hideDoneAfterDays: 7,
      properties: { milestone: true, key: 'yes' },
      extra: 1,
    });
    // The layout follows the view; lanes equal to the columns fall back to none.
    expect(value.layout).toBe('board');
    expect(value.groupBy).toBe('assignee');
    expect(value.swimlanes).toBe('none');
    expect(value.orderBy).toBe('priority');
    expect(value.hideDoneAfterDays).toBe(7);
    expect(value.properties.milestone).toBe(true);
    expect(value.properties.key).toBe(true);
    expect(normalizeDisplayOptions('list', 'garbage')).toEqual(DEFAULT_DISPLAY_OPTIONS.list);
    expect(normalizeDisplayOptions('home', { groupBy: 'label' }).groupBy).toBe('none');
    expect(sameDisplayOptions(normalizeDisplayOptions('list', {}), defaultDisplayOptions('list'))).toBe(true);
  });

  it('keeps the criteria marker off for options saved before M6, and reads it back once on', () => {
    const before = normalizeDisplayOptions('list', { properties: { milestone: true, subtasks: true } });
    expect(before.properties.criteria).toBe(false);
    const on = normalizeDisplayOptions('board', { properties: { criteria: true } });
    expect(on.properties.criteria).toBe(true);
    expect(sameDisplayOptions(on, defaultDisplayOptions('board'))).toBe(false);
  });
});

describe('displayListInput', () => {
  it('maps order and subtasks to tasks.list', () => {
    expect(displayListInput(defaultDisplayOptions('list'))).toEqual({ sort: 'priority' });
    expect(
      displayListInput({ ...defaultDisplayOptions('list'), listSubtasks: 'hidden', orderBy: 'due' }),
    ).toEqual({
      sort: 'due',
      topLevel: true,
    });
    expect(displayListInput(defaultDisplayOptions('board'))).toEqual({ sort: 'priority', topLevel: true });
    expect(
      displayListInput({ ...defaultDisplayOptions('board'), boardSubtasks: 'cards', orderBy: 'manual' }),
    ).toEqual({
      sort: 'manual',
    });
  });
});

describe('showsProperty', () => {
  const options = defaultDisplayOptions('list');
  it('shows priority only for urgent and high, and only other people’s avatars', () => {
    expect(showsProperty(options, 'priority', { priority: 'urgent', assignee: null })).toBe(true);
    expect(showsProperty(options, 'priority', { priority: 'medium', assignee: null })).toBe(false);
    expect(showsProperty(options, 'assignee', { priority: 'none', assignee: ana }, 'u-ana')).toBe(false);
    expect(showsProperty(options, 'assignee', { priority: 'none', assignee: bo }, 'u-ana')).toBe(true);
    expect(showsProperty(options, 'milestone', { priority: 'none', assignee: null })).toBe(false);
  });
});

describe('hideOldDone', () => {
  it('drops done and canceled tasks older than N days, never open ones', () => {
    const now = new Date('2026-11-04T12:00:00.000Z');
    const tasks = [
      row('A-1', { status: 'done', updatedAt: '2026-10-01T00:00:00.000Z' }),
      row('A-2', { status: 'done', updatedAt: '2026-11-01T00:00:00.000Z' }),
      row('A-3', { status: 'canceled', updatedAt: '2026-09-01T00:00:00.000Z' }),
      row('A-4', { status: 'todo', updatedAt: '2025-01-01T00:00:00.000Z' }),
    ];
    expect(hideOldDone(tasks, 14, now).map((task) => task.key)).toEqual(['A-2', 'A-4']);
    expect(hideOldDone(tasks, 0, now)).toHaveLength(4);
  });
});

describe('groupTasks', () => {
  const tasks = [
    row('A-1', { status: 'in_progress', priority: 'high', assignee: bo, labels: [backend, mobile] }),
    row('A-2', { status: 'todo', priority: 'urgent', assignee: bot, labels: [] }),
    row('A-3', { status: 'done', priority: 'none', assignee: ana, labels: [mobile] }),
    row('A-4', { status: 'todo', priority: 'high', assignee: null }),
  ];

  it('groups by status in list order, or board order', () => {
    expect(groupTasks(tasks, 'status').map((group) => [group.label, group.tasks.length])).toEqual([
      ['In progress', 1],
      ['Todo', 2],
      ['Done', 1],
    ]);
    const board = groupTasks(tasks, 'status', { statuses: BOARD_STATUS_ORDER, showEmptyGroups: true });
    expect(board.map((group) => group.key)).toEqual([
      'backlog',
      'todo',
      'in_progress',
      'in_review',
      'done',
      'canceled',
    ]);
  });

  it('groups by priority, most urgent first, none last', () => {
    expect(groupTasks(tasks, 'priority').map((group) => group.label)).toEqual([
      'Urgent',
      'High',
      'No priority',
    ]);
  });

  it('groups by assignee: viewer first, people, agents, then nobody', () => {
    const groups = groupTasks(tasks, 'assignee', { viewerId: 'u-ana' });
    expect(groups.map((group) => group.label)).toEqual(['Ana Ruiz', 'Bo Lind', 'claude-dev', 'No assignee']);
    expect(groups[3]?.value).toEqual({ field: 'assignee', assignee: null });
  });

  it('puts a task in each of its label groups', () => {
    const groups = groupTasks(tasks, 'label');
    expect(groups.map((group) => [group.label, group.tasks.map((task) => task.key)])).toEqual([
      ['backend', ['A-1']],
      ['mobile', ['A-1', 'A-3']],
      ['No labels', ['A-2', 'A-4']],
    ]);
  });

  it('shows known empty groups only when asked', () => {
    const milestones = [
      { id: 'm-2', name: 'Beta', status: 'planned' as const, targetDate: '2026-12-01' },
      { id: 'm-1', name: 'Alpha', status: 'active' as const, targetDate: '2026-11-15' },
    ];
    expect(groupTasks(tasks, 'milestone').map((group) => group.label)).toEqual(['No milestone']);
    expect(
      groupTasks(tasks, 'milestone', { milestones, showEmptyGroups: true }).map((group) => group.label),
    ).toEqual(['Alpha', 'Beta', 'No milestone']);
  });

  it('gives one group for none', () => {
    expect(groupTasks(tasks, 'none')).toEqual([
      { key: 'all', label: 'All tasks', value: { field: 'none' }, tasks },
    ]);
  });
});

describe('waiting tasks (M7)', () => {
  const TODAY = '2026-11-26';
  const waiting = { checkAgain: { on: '2026-12-03', reason: 'The bank answers' } };
  const due = { checkAgain: { on: '2026-11-26', reason: 'Today' } };
  const none = { checkAgain: null };

  it('defaults to dimmed, and reads stored values', () => {
    expect(defaultDisplayOptions('board').waiting).toBe('dimmed');
    expect(defaultDisplayOptions('list').properties).toMatchObject({ pullRequest: false, checkAgain: true });
    expect(normalizeDisplayOptions('board', { waiting: 'hidden' }).waiting).toBe('hidden');
    expect(normalizeDisplayOptions('board', { waiting: 'sometimes' }).waiting).toBe('dimmed');
    expect(
      sameDisplayOptions(defaultDisplayOptions('board'), {
        ...defaultDisplayOptions('board'),
        waiting: 'shown',
      }),
    ).toBe(false);
  });

  it('waits only while the day is ahead, and never on a guess', () => {
    expect(isWaiting(waiting, TODAY)).toBe(true);
    expect(isWaiting(due, TODAY)).toBe(false);
    expect(isWaiting(none, TODAY)).toBe(false);
    expect(isWaiting(waiting, null)).toBe(false);
  });

  it('dims or hides waiting tasks, never one whose day has come', () => {
    expect(waitingLook({ waiting: 'dimmed' }, waiting, TODAY)).toBe('dimmed');
    expect(waitingLook({ waiting: 'hidden' }, waiting, TODAY)).toBe('hidden');
    expect(waitingLook({ waiting: 'shown' }, waiting, TODAY)).toBeNull();
    expect(waitingLook({ waiting: 'dimmed' }, due, TODAY)).toBeNull();
    const tasks = [waiting, due, none];
    expect(withoutHiddenWaiting(tasks, { waiting: 'hidden' }, TODAY)).toEqual({
      tasks: [due, none],
      hidden: 1,
    });
    expect(withoutHiddenWaiting(tasks, { waiting: 'dimmed' }, TODAY)).toEqual({ tasks, hidden: 0 });
    expect(withoutHiddenWaiting(tasks, { waiting: 'hidden' }, null)).toEqual({ tasks, hidden: 0 });
  });
});
