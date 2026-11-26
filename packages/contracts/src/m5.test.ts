// M5 contract additions: labels, due dates, blockers, subtasks, bulk changes and Home.
import { describe, expect, it } from 'vitest';
import type { z } from 'zod';
import { cliOutput } from './cli';
import { apiErrors, contract } from './contract';
import {
  Activity,
  ActivityChange,
  HOME_GROUP_ITEM_LIMIT,
  HOME_GROUPS_BY_TAB,
  Home,
  HomeCounts,
  HomeGroup,
  HomeItem,
  Label,
  LabelList,
  SubtaskProgress,
  Task,
  TaskBulkResult,
  TaskListItem,
} from './entities';
import {
  BulkUpdateTasksInput,
  CreateLabelInput,
  CreateTaskInput,
  DeleteLabelInput,
  GetHomeInput,
  LabelName,
  ListLabelsInput,
  ListTasksInput,
  MAX_BULK_TASKS,
  MAX_TASK_LABELS,
  QueryBoolean,
  UpdateLabelInput,
  UpdateTaskInput,
} from './inputs';
import { DUE_SOON_DAYS, dueState, LabelColor, LabelSource, TASK_OWNED_FIELDS } from './primitives';
import { PROBLEM_CODES, PROBLEM_STATUS, PROBLEM_TITLES, problem } from './problem';
import {
  backlogLabelFixture,
  fieldsActivityFixture,
  homeAgentsFixture,
  homeMineFixture,
  labelFixture,
  labelWithUsageFixture,
  taskFixture,
  taskListItemFixture,
  taskListItemWithFieldsFixture,
  taskWithFieldsFixture,
} from './testing/fixtures';

const LABEL_ID = labelFixture.id;

describe('M5 primitives', () => {
  it('takes label colours 1 to 9 and the two label sources', () => {
    expect(LabelColor.safeParse(1).success).toBe(true);
    expect(LabelColor.safeParse(9).success).toBe(true);
    expect(LabelColor.safeParse(0).success).toBe(false);
    expect(LabelColor.safeParse(10).success).toBe(false);
    expect(LabelColor.safeParse(2.5).success).toBe(false);
    expect(LabelSource.options).toEqual(['app', 'backlog']);
  });

  it('reads due states for open and closed tasks', () => {
    const today = '2026-11-03';
    expect(DUE_SOON_DAYS).toBe(2);
    expect(dueState(null, 'todo', today)).toBe('none');
    expect(dueState('2026-11-02', 'todo', today)).toBe('overdue');
    expect(dueState('2026-11-02', 'done', today)).toBe('done');
    expect(dueState('2026-11-02', 'canceled', today)).toBe('done');
    expect(dueState('2026-11-03', 'in_progress', today)).toBe('today');
    expect(dueState('2026-11-04', 'todo', today)).toBe('soon');
    expect(dueState('2026-11-05', 'todo', today)).toBe('soon');
    expect(dueState('2026-11-06', 'todo', today)).toBe('future');
    // Across a month end.
    expect(dueState('2026-12-01', 'todo', '2026-11-30')).toBe('soon');
  });

  it('locks the M5 fields of mirrored tasks', () => {
    expect(TASK_OWNED_FIELDS).toEqual(expect.arrayContaining(['labels', 'dueDate', 'blockedBy', 'parent']));
  });
});

describe('M5 entities', () => {
  it('parses labels and label lists', () => {
    expect(Label.parse(backlogLabelFixture)).toEqual(backlogLabelFixture);
    expect(Label.safeParse({ ...labelFixture, color: 10 }).success).toBe(false);
    expect(Label.safeParse({ ...labelFixture, source: 'file' }).success).toBe(false);
    expect(LabelList.parse({ items: [labelWithUsageFixture] }).items[0]?.usageCount).toBe(12);
  });

  it('keeps tasks without the M5 fields valid and parses them when present', () => {
    expect(Task.safeParse(taskFixture).success).toBe(true);
    const task = Task.parse(taskWithFieldsFixture);
    expect(task.labels?.map((label) => label.name)).toEqual(['payouts', 'reliability']);
    expect(task.dueDate).toBe('2026-10-31');
    expect(task.parent?.key).toBe('PAY-120');
    expect(task.subtasks).toHaveLength(3);
    expect(task.subtaskProgress).toEqual({ done: 1, total: 2 });
    expect(task.blockedBy?.[1]).toBeNull();
    expect(task.blocks?.[0]?.assignee).toBeNull();
    expect(task.blocked).toBe(true);
    expect(Task.safeParse({ ...taskWithFieldsFixture, dueDate: '2026-10-31T00:00:00Z' }).success).toBe(false);
  });

  it('refuses subtask progress with done above total', () => {
    expect(SubtaskProgress.safeParse({ done: 2, total: 2 }).success).toBe(true);
    expect(SubtaskProgress.safeParse({ done: 3, total: 2 }).success).toBe(false);
  });

  it('carries labels, due date, blocked, progress and the parent key on list rows', () => {
    expect(TaskListItem.safeParse(taskListItemFixture).success).toBe(true);
    const row = TaskListItem.parse({ ...taskListItemWithFieldsFixture, parentKey: 'PAY-120' });
    expect(row).toMatchObject({ dueDate: '2026-10-31', blocked: true, parentKey: 'PAY-120' });
    expect(row.labels).toEqual([labelFixture]);
    // The list row stays light: no relation lists.
    expect('subtasks' in TaskListItem.shape).toBe(false);
    expect('blockedBy' in TaskListItem.shape).toBe(false);
    expect(TaskBulkResult.parse({ items: [taskListItemWithFieldsFixture] }).items).toHaveLength(1);
  });

  it('records label, due date, blocker and parent changes in activity', () => {
    const activity = Activity.parse(fieldsActivityFixture);
    expect(activity.changes.map((change) => change.field)).toEqual([
      'labels',
      'dueDate',
      'blockedBy',
      'parent',
    ]);
    expect(
      ActivityChange.safeParse({
        field: 'labels',
        from: [{ id: LABEL_ID, name: 'old name', color: null }],
        to: [],
      }).success,
    ).toBe(true);
    expect(
      ActivityChange.safeParse({
        field: 'parent',
        from: { key: 'PAY-120', title: 'Gone', removed: true },
        to: null,
      }).success,
    ).toBe(true);
    expect(ActivityChange.safeParse({ field: 'dueDate', from: null, to: 'tomorrow' }).success).toBe(false);
    expect(ActivityChange.safeParse({ field: 'blockedBy', from: null, to: [] }).success).toBe(false);
  });
});

describe('Home', () => {
  it('parses the Mine and Agents fixtures', () => {
    const mine = Home.parse(homeMineFixture);
    expect(mine.groups.map((group) => group.key)).toEqual([...HOME_GROUPS_BY_TAB.mine]);
    expect(mine.deadlines.map((deadline) => deadline.kind)).toEqual(['task', 'cycle', 'milestone']);
    const agents = Home.parse(homeAgentsFixture);
    expect(agents.groups.map((group) => group.key)).toEqual([...HOME_GROUPS_BY_TAB.agents]);
    expect(agents.agents[0]?.recent.map((action) => action.kind)).toEqual(['activity', 'comment']);
  });

  it('lists the groups of each tab in order', () => {
    expect(HOME_GROUPS_BY_TAB).toEqual({
      mine: ['review', 'mergedOpen', 'checkAgain', 'mentions', 'blocked', 'overdue', 'assigned'],
      everyone: ['review', 'mergedOpen', 'blocked', 'overdue', 'dueThisWeek'],
      agents: ['waiting'],
    });
  });

  it('caps group items and keeps totals at or above the item count', () => {
    const item = homeMineFixture.groups[0]?.items[0];
    if (!item) throw new Error('fixture has no review item');
    expect(HomeGroup.safeParse({ key: 'review', total: 0, items: [item] }).success).toBe(false);
    const full = Array.from({ length: HOME_GROUP_ITEM_LIMIT + 1 }, () => item);
    expect(HomeGroup.safeParse({ key: 'review', total: 99, items: full }).success).toBe(false);
    expect(HomeGroup.safeParse({ key: 'review', total: 99, items: full.slice(1) }).success).toBe(true);
  });

  it('needs at least one blocker on a blocked reason, and known pills', () => {
    const base = homeMineFixture.groups.find((group) => group.key === 'blocked')?.items[0];
    if (!base) throw new Error('fixture has no blocked item');
    expect(HomeItem.safeParse({ ...base, reason: { kind: 'blocked', blockers: [] } }).success).toBe(false);
    expect(HomeItem.safeParse({ ...base, reason: { kind: 'blocked', blockers: [null] } }).success).toBe(true);
    expect(HomeItem.safeParse({ ...base, pills: [{ kind: 'blocks', count: 0 }] }).success).toBe(false);
    expect(HomeItem.safeParse({ ...base, pills: [{ kind: 'starred' }] }).success).toBe(false);
  });

  it('counts what needs you for the sidebar', () => {
    expect(HomeCounts.parse({ review: 3, mentions: 2, blocked: 1, overdue: 2, total: 8 }).total).toBe(8);
    expect(HomeCounts.safeParse({ review: 3, mentions: 2, blocked: 1, overdue: 2, total: 10 }).success).toBe(
      false,
    );
  });
});

describe('M5 inputs', () => {
  it('reads the new list filters from query strings', () => {
    const parsed = ListTasksInput.parse({
      project: 'pay',
      label: LABEL_ID,
      due: 'overdue',
      blocked: 'true',
      topLevel: 'false',
      parent: 'pay-120',
      sort: 'due',
    });
    expect(parsed).toMatchObject({
      label: [LABEL_ID],
      due: 'overdue',
      blocked: true,
      topLevel: false,
      parent: 'PAY-120',
      sort: 'due',
      order: 'list',
    });
    expect(ListTasksInput.parse({}).sort).toBeUndefined();
    expect(ListTasksInput.safeParse({ due: 'later' }).success).toBe(false);
    expect(ListTasksInput.safeParse({ sort: 'title' }).success).toBe(false);
    expect(ListTasksInput.safeParse({ label: 'payouts' }).success, 'label ids, not names').toBe(false);
  });

  it('accepts only true and false as query booleans', () => {
    expect(QueryBoolean.parse(true)).toBe(true);
    expect(QueryBoolean.parse('false')).toBe(false);
    expect(QueryBoolean.safeParse('yes').success).toBe(false);
    expect(QueryBoolean.safeParse('').success).toBe(false);
  });

  it('trims label names, caps them at 40 characters and folds repeats ignoring case', () => {
    expect(LabelName.parse('  payouts ')).toBe('payouts');
    expect(LabelName.safeParse(' ').success).toBe(false);
    expect(LabelName.safeParse('x'.repeat(41)).success).toBe(false);
    const created = CreateTaskInput.parse({
      project: 'PAY',
      title: 'Retry payouts',
      labels: ['payouts', 'Payouts', ' backend '],
      dueDate: '2026-11-14',
      parent: 'pay-120',
      blockedBy: ['pay-138', 'PAY-138'],
    });
    expect(created).toMatchObject({
      labels: ['payouts', 'backend'],
      dueDate: '2026-11-14',
      parent: 'PAY-120',
      blockedBy: ['PAY-138'],
    });
    const tooMany = Array.from({ length: MAX_TASK_LABELS + 1 }, (_, index) => `label ${index}`);
    expect(CreateTaskInput.safeParse({ project: 'PAY', title: 'x', labels: tooMany }).success).toBe(false);
  });

  it('updates the M5 fields alone and keeps labels apart from addLabels and removeLabels', () => {
    for (const change of [
      { labels: [] },
      { addLabels: ['payouts'] },
      { removeLabels: ['backend'] },
      { dueDate: null },
      { parent: null },
      { addBlockers: ['PAY-138'] },
      { removeBlockers: ['PAY-138'] },
    ]) {
      expect(UpdateTaskInput.safeParse({ key: 'PAY-142', ...change }).success, JSON.stringify(change)).toBe(
        true,
      );
    }
    const none = UpdateTaskInput.safeParse({ key: 'PAY-142' });
    expect(none.error?.issues[0]?.message).toBe(
      'Change at least one of title, description, status, priority, assignee, milestone, cycle, position, labels, dueDate, parent, blockers, criteria, done items, plan, finalSummary or checkAgain',
    );
    const both = UpdateTaskInput.safeParse({ key: 'PAY-142', labels: ['a'], addLabels: ['b'] });
    expect(both.error?.issues).toEqual([
      expect.objectContaining({
        path: ['labels'],
        message: 'Send labels alone, or addLabels and removeLabels',
      }),
    ]);
    expect(UpdateTaskInput.safeParse({ key: 'PAY-142', addLabels: ['a'], removeLabels: ['b'] }).success).toBe(
      true,
    );
  });

  it('changes up to 100 tasks at once', () => {
    const parsed = BulkUpdateTasksInput.parse({ keys: ['pay-1', 'PAY-2', 'PAY-1'], status: 'done' });
    expect(parsed).toEqual({ keys: ['PAY-1', 'PAY-2'], status: 'done' });
    expect(BulkUpdateTasksInput.safeParse({ keys: [], status: 'done' }).success).toBe(false);
    const keys = Array.from({ length: MAX_BULK_TASKS + 1 }, (_, index) => `PAY-${index + 1}`);
    expect(BulkUpdateTasksInput.safeParse({ keys, status: 'done' }).success).toBe(false);
    expect(BulkUpdateTasksInput.safeParse({ keys: ['PAY-1'] }).error?.issues[0]?.message).toBe(
      'Change at least one of status, priority, assignee, milestone, cycle, dueDate or labels',
    );
    expect(BulkUpdateTasksInput.safeParse({ keys: ['PAY-1'], addLabels: ['payouts'] }).success).toBe(true);
    expect(BulkUpdateTasksInput.safeParse({ keys: ['PAY-1'], dueDate: null }).success).toBe(true);
  });

  it('validates the label routes', () => {
    expect(ListLabelsInput.parse({ project: 'pay' })).toEqual({ project: 'PAY' });
    expect(CreateLabelInput.parse({ project: 'PAY', name: ' payouts ' })).toEqual({
      project: 'PAY',
      name: 'payouts',
    });
    expect(CreateLabelInput.safeParse({ project: 'PAY', name: 'payouts', color: 0 }).success).toBe(false);
    expect(UpdateLabelInput.safeParse({ project: 'PAY', id: LABEL_ID }).success).toBe(false);
    expect(UpdateLabelInput.parse({ project: 'PAY', id: LABEL_ID, color: 4 })).toMatchObject({ color: 4 });
    expect(DeleteLabelInput.safeParse({ project: 'PAY', id: 'payouts' }).success).toBe(false);
  });

  it('reads Home with defaults and filters', () => {
    expect(GetHomeInput.parse(undefined)).toEqual({ tab: 'mine' });
    expect(GetHomeInput.parse({ tab: 'agents', label: 'Payouts', project: ['pay', 'web'] })).toEqual({
      tab: 'agents',
      label: ['Payouts'],
      project: ['PAY', 'WEB'],
    });
    expect(GetHomeInput.safeParse({ tab: 'dashboard' }).success).toBe(false);
  });
});

describe('M5 routes and problems', () => {
  it('routes the label, bulk and Home procedures', () => {
    const route = (procedure: { '~orpc': { route: { method?: string; path?: string } } }) =>
      `${procedure['~orpc'].route.method} ${procedure['~orpc'].route.path}`;
    expect(route(contract.labels.list)).toBe('GET /api/v1/projects/{project}/labels');
    expect(route(contract.labels.create)).toBe('POST /api/v1/projects/{project}/labels');
    expect(route(contract.labels.update)).toBe('PATCH /api/v1/projects/{project}/labels/{id}');
    expect(route(contract.labels.delete)).toBe('DELETE /api/v1/projects/{project}/labels/{id}');
    expect(route(contract.tasks.bulkUpdate)).toBe('POST /api/v1/tasks/bulk');
    expect(route(contract.home.get)).toBe('GET /api/v1/home');
    expect(route(contract.home.counts)).toBe('GET /api/v1/home/counts');
    const home = contract.home.get['~orpc'].inputSchema as z.ZodType;
    expect(home.parse({ tab: 'everyone' })).toEqual({ tab: 'everyone' });
  });

  it('declares the M5 problem codes with their statuses and titles', () => {
    const codes = [
      'LABEL_EXISTS',
      'LABEL_MIRRORED',
      'DEPENDENCY_LOOP',
      'SUBTASK_DEPTH',
      'NOT_SAME_PROJECT',
    ] as const;
    expect(PROBLEM_CODES).toEqual(expect.arrayContaining([...codes]));
    expect(codes.map((code) => PROBLEM_STATUS[code])).toEqual([409, 409, 409, 409, 422]);
    for (const code of codes) {
      expect(apiErrors[code].status, code).toBe(PROBLEM_STATUS[code]);
      expect(PROBLEM_TITLES[code], code).toBeTruthy();
    }
    expect(problem('DEPENDENCY_LOOP', "Can't add: PAY-150 already waits on PAY-142.")).toMatchObject({
      status: 409,
      title: 'Blockers would loop',
      detail: "Can't add: PAY-150 already waits on PAY-142.",
    });
  });

  it('wraps the zamu labels results', () => {
    expect(cliOutput('labels.list', { items: [labelWithUsageFixture] }).schema).toBe('zamu.v1.labels.list');
    expect(cliOutput('labels.delete', { deleted: labelFixture, usageCount: 12 }).data.usageCount).toBe(12);
  });
});
