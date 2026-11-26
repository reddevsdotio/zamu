import type { HomeAgentAction, HomeDeadline, HomeItem, TaskListItem, UserRef } from '@zamu/contracts';
import { describe, expect, it } from 'vitest';
import {
  actionText,
  agentsLine,
  agoText,
  criteriaPillText,
  deadlineView,
  forText,
  greeting,
  groupHint,
  groupTitle,
  mergedPillText,
  mergedWhen,
  needYouText,
  pillView,
  rowAvatar,
  shownPills,
  showsDueChip,
  whyText,
} from './format';

const ANA: UserRef = { id: '00000000-0000-4000-8000-000000000001', name: 'Ana Ruiz', kind: 'person' };
const TOMAS: UserRef = { id: '00000000-0000-4000-8000-000000000002', name: 'Tomás Berg', kind: 'person' };
const CLAUDE = { id: '00000000-0000-4000-8000-000000000003', name: 'claude-dev', kind: 'agent' as const };
const PROJECT = { id: '10000000-0000-4000-8000-000000000001', key: 'PAY', name: 'Payments' };

const NOW = Date.parse('2026-11-03T10:00:00Z');
const minutesAgo = (minutes: number) => new Date(NOW - minutes * 60_000).toISOString();

function task(overrides: Partial<TaskListItem> = {}): TaskListItem {
  return {
    id: '20000000-0000-4000-8000-000000000001',
    key: 'PAY-142',
    number: 142,
    project: PROJECT,
    title: 'Retry failed payouts',
    status: 'in_progress',
    priority: 'high',
    assignee: null,
    milestone: null,
    cycle: null,
    cycleAddedAt: null,
    rank: 'a',
    createdAt: minutesAgo(600),
    updatedAt: minutesAgo(60),
    labels: [],
    dueDate: null,
    blocked: false,
    ...overrides,
  } as TaskListItem;
}

function item(reason: HomeItem['reason'], overrides: Partial<HomeItem> = {}): HomeItem {
  return { task: task(), reason, relation: null, pills: [], ...overrides };
}

describe('criteria pill', () => {
  const review = (criteriaProgress?: TaskListItem['criteriaProgress']) =>
    item(
      { kind: 'review', requestedBy: CLAUDE, onBehalfOf: ANA, waitingOn: ANA, at: minutesAgo(5) },
      { task: task({ status: 'in_review', ...(criteriaProgress ? { criteriaProgress } : {}) }) },
    );

  it('counts checked criteria on Needs review rows', () => {
    expect(criteriaPillText(review({ settled: 5, open: 1, waived: 1, total: 6 }), 'review')).toBe(
      '4 of 6 criteria',
    );
    expect(criteriaPillText(review({ settled: 0, open: 1, waived: 0, total: 1 }), 'review')).toBe(
      '0 of 1 criterion',
    );
  });

  it('says nothing without criteria or outside Needs review', () => {
    expect(criteriaPillText(review({ settled: 0, open: 0, waived: 0, total: 0 }), 'review')).toBe('');
    expect(criteriaPillText(review(), 'review')).toBe('');
    expect(criteriaPillText(review({ settled: 1, open: 1, waived: 0, total: 2 }), 'waiting')).toBe('');
    expect(criteriaPillText(review({ settled: 1, open: 1, waived: 0, total: 2 }), undefined)).toBe('');
  });
});

describe('times', () => {
  it('words how long ago and for how long', () => {
    expect(agoText(minutesAgo(0), NOW)).toBe('just now');
    expect(agoText(minutesAgo(40), NOW)).toBe('40 min ago');
    expect(agoText(minutesAgo(130), NOW)).toBe('2 h ago');
    expect(agoText(minutesAgo(26 * 60), NOW)).toBe('1 d ago');
    expect(forText(minutesAgo(22), NOW)).toBe('for 22 min');
    expect(forText(minutesAgo(190), NOW)).toBe('for 3 h');
  });

  it('greets by the time of day', () => {
    const at = (hour: number) => new Date(2026, 10, 3, hour).getTime();
    expect(greeting('Ana', at(8))).toBe('Good morning, Ana');
    expect(greeting('Ana', at(14))).toBe('Good afternoon, Ana');
    expect(greeting('Ana', at(20))).toBe('Good evening, Ana');
    expect(needYouText(1)).toBe('1 thing needs you');
    expect(needYouText(8)).toBe('8 things need you');
  });
});

describe('groups', () => {
  it('names groups per tab and counts the projects of Everyone review', () => {
    expect(groupTitle('review', 'mine')).toBe('Needs your review');
    expect(groupTitle('review', 'everyone')).toBe('Needs review');
    const other = task({ project: { ...PROJECT, id: '10000000-0000-4000-8000-000000000002', key: 'WEB' } });
    const review = {
      kind: 'review',
      requestedBy: null,
      onBehalfOf: null,
      waitingOn: null,
      at: minutesAgo(1),
    } as const;
    expect(
      groupHint({ key: 'review', items: [item(review), item(review, { task: other })] }, 'everyone'),
    ).toBe('Across 2 projects');
    expect(groupHint({ key: 'blocked', items: [] }, 'mine')).toBe('Your tasks waiting on another task');
    expect(groupHint({ key: 'blocked', items: [] }, 'everyone')).toBe('');
  });

  it('lists agents by name', () => {
    const card = (name: string) => ({ agent: { ...CLAUDE, name, responsible: ANA } });
    expect(agentsLine([card('claude-dev'), card('review-bot')])).toBe(
      'What claude-dev and review-bot are doing',
    );
    expect(agentsLine([])).toBe('No agents in this workspace yet');
  });
});

describe('rows', () => {
  it('says why a row is there', () => {
    const review = item({
      kind: 'review',
      requestedBy: CLAUDE,
      onBehalfOf: ANA,
      waitingOn: ANA,
      at: minutesAgo(40),
    });
    expect(whyText(review, 'mine', ANA.id, NOW)).toBe('claude-dev · 40 min ago');
    expect(whyText(review, 'everyone', TOMAS.id, NOW)).toBe('waits on Ana');
    expect(whyText(review, 'agents', TOMAS.id, NOW)).toBe('review by Ana · 40 min ago');
    expect(whyText(review, 'mine', ANA.id, null)).toBe('claude-dev');

    const mention = item({
      kind: 'mention',
      author: TOMAS,
      onBehalfOf: null,
      mentioned: ANA,
      comment: { id: '30000000-0000-4000-8000-000000000001', excerpt: 'Can you look?' },
      at: minutesAgo(26 * 60),
    });
    expect(whyText(mention, 'mine', ANA.id, NOW)).toBe('Tomás · 1 d ago');
    expect(whyText(mention, 'agents', TOMAS.id, NOW)).toBe('asks Ana · 1 d ago');

    const blocker = (key: string) => ({ key, title: key, status: 'todo' as const, assignee: null });
    const blocked = item({ kind: 'blocked', blockers: [blocker('PAY-120'), blocker('PAY-138'), null] });
    expect(whyText(blocked, 'everyone', ANA.id, NOW)).toBe('by PAY-120, PAY-138 +1');
    expect(whyText(item({ kind: 'blocked', blockers: [null] }), 'mine', ANA.id, NOW)).toBe(
      'by a removed task',
    );

    const created = item({ kind: 'overdue', dueDate: '2026-11-01', daysOverdue: 2 }, { relation: 'creator' });
    expect(whyText(created, 'mine', ANA.id, NOW)).toBe('you created it');
    const parent = item({ kind: 'assigned' }, { task: task({ subtaskProgress: { done: 2, total: 7 } }) });
    expect(whyText(parent, 'mine', ANA.id, NOW)).toBe('7 subtasks · 2 done');
  });

  it('words pills and keeps the due chip out when a pill says it', () => {
    expect(pillView({ kind: 'blocked' })).toEqual({ text: 'blocked', tone: 'warn' });
    expect(pillView({ kind: 'overdue', daysOverdue: 3 })).toEqual({ text: '3 d overdue', tone: 'warn' });
    expect(pillView({ kind: 'due', daysLeft: 2 }).text).toBe('due in 2 d');
    expect(pillView({ kind: 'due', daysLeft: 0 }).text).toBe('due today');
    expect(pillView({ kind: 'blocks', count: 2 }).text).toBe('blocks 2');
    expect(pillView({ kind: 'cycle', cycle: { number: 12, name: null } }).text).toBe('in Cycle 12');
    expect(pillView({ kind: 'question' })).toEqual({ text: 'asks a question', tone: 'accent' });
    expect(pillView({ kind: 'unassigned' }).text).toBe('needs owner');

    const dated = task({ dueDate: '2026-11-14' });
    expect(showsDueChip(item({ kind: 'assigned' }, { task: dated }))).toBe(true);
    expect(
      showsDueChip(item({ kind: 'assigned' }, { task: dated, pills: [{ kind: 'overdue', daysOverdue: 1 }] })),
    ).toBe(false);
    expect(showsDueChip(item({ kind: 'assigned' }))).toBe(false);
    const soon = item(
      { kind: 'assigned' },
      {
        task: dated,
        pills: [
          { kind: 'due', daysLeft: 0 },
          { kind: 'blocks', count: 1 },
        ],
      },
    );
    expect(showsDueChip(soon)).toBe(true);
    expect(shownPills(soon)).toEqual([{ kind: 'blocks', count: 1 }]);
  });

  it("leaves out the viewer's own avatar on Mine", () => {
    const mine = item({ kind: 'assigned' }, { task: task({ assignee: { ...ANA, responsible: null } }) });
    expect(rowAvatar(mine, 'mine', ANA.id)).toBeNull();
    expect(rowAvatar(mine, 'everyone', ANA.id)?.name).toBe('Ana Ruiz');
  });
});

describe('M7 groups', () => {
  const merged = (provider: 'github' | 'gitlab', openDoneItems: number) =>
    item({
      kind: 'mergedOpen',
      pullRequest: { provider, number: 482, title: 'Retry', url: 'https://example.com/pull/482' },
      openCriteria: 2,
      openDoneItems,
      at: minutesAgo(26 * 60),
    });

  it('names the groups and explains them', () => {
    expect(groupTitle('mergedOpen', 'mine')).toBe('Merged with open criteria');
    expect(groupTitle('mergedOpen', 'everyone')).toBe('Merged with open criteria');
    expect(groupTitle('checkAgain', 'mine')).toBe('Check again');
    expect(groupHint({ key: 'mergedOpen', items: [] }, 'mine')).toBe(
      'Done through a merge. Check the criteria, waive them or reopen the task.',
    );
    expect(groupHint({ key: 'mergedOpen', items: [] }, 'everyone')).toBe(
      'Done through a merge, with criteria still open.',
    );
    expect(groupHint({ key: 'checkAgain', items: [] }, 'mine')).toBe('The day you set has come.');
  });

  it('words merged rows: the pill, the request and when', () => {
    expect(mergedPillText(merged('github', 0))).toBe('Merged with 2 open criteria');
    expect(mergedPillText(merged('github', 1))).toBe('Merged with 3 open items');
    expect(whyText(merged('github', 0), 'mine', ANA.id, NOW)).toBe('#482 merged yesterday');
    expect(whyText(merged('gitlab', 0), 'everyone', ANA.id, NOW)).toBe('!482 merged yesterday');
    // Before the clock is known the time is left out.
    expect(whyText(merged('github', 0), 'mine', ANA.id, null)).toBe('#482 merged');
    const by = item({
      kind: 'mergedOpen',
      pullRequest: { provider: 'github', number: 482, title: 'Retry', url: 'https://example.com/pull/482' },
      mergedBy: 'tomas',
      openCriteria: 2,
      openDoneItems: 0,
      at: minutesAgo(26 * 60),
    });
    expect(whyText(by, 'mine', ANA.id, NOW)).toBe('#482 merged yesterday by tomas');
    expect(mergedPillText(item({ kind: 'assigned' }))).toBe('');
  });

  it('counts merge days by the calendar', () => {
    const at = (hours: number) => new Date(NOW - hours * 3_600_000).toISOString();
    expect(mergedWhen(at(0), NOW)).toBe('today');
    expect(mergedWhen(at(72), NOW)).toBe('3 days ago');
  });

  it('gives a check-again row its reason, and words the pills elsewhere', () => {
    const row = item({ kind: 'checkAgain', on: '2026-11-03', reason: 'Wait for the bank', daysAgo: 0 });
    expect(whyText(row, 'mine', ANA.id, NOW)).toBe('Wait for the bank');
    expect(pillView({ kind: 'mergedOpen', openItems: 1 })).toEqual({
      text: 'merged, 1 open item',
      tone: 'accent',
    });
    expect(pillView({ kind: 'checkAgain', on: '2026-11-03' })).toEqual({
      text: 'check again',
      tone: 'accent',
    });
  });
});

describe('deadlines', () => {
  it('words milestones, cycles and tasks', () => {
    const milestone: HomeDeadline = {
      kind: 'milestone',
      project: PROJECT,
      milestone: {
        id: '40000000-0000-4000-8000-000000000001',
        name: 'Mobile app release',
        targetDate: '2026-11-14',
      },
      daysLeft: 11,
      progress: { done: 6, total: 10 },
    };
    expect(deadlineView(milestone)).toMatchObject({
      name: 'Mobile app release',
      meta: 'Nov 14 · 60%',
      when: 'in 11 days',
    });
    const cycle: HomeDeadline = {
      kind: 'cycle',
      project: PROJECT,
      cycle: { number: 12, name: null, startsOn: '2026-10-27', endsOn: '2026-11-09' },
      daysLeft: 7,
      progress: { done: 1, total: 4 },
    };
    expect(deadlineView(cycle)).toMatchObject({ name: 'Cycle 12', meta: 'ends Nov 9', when: 'in 6 days' });
    const late: HomeDeadline = {
      kind: 'task',
      task: { key: 'PAY-142', title: 'Retry failed payouts', status: 'todo', project: PROJECT },
      dueDate: '2026-10-31',
      daysLeft: -3,
    };
    expect(deadlineView(late)).toMatchObject({ name: 'PAY-142', when: '3 days overdue', overdue: true });
  });
});

describe('agent actions', () => {
  const ref = { key: 'PAY-120', title: 'Idempotency keys', status: 'in_review' as const, project: PROJECT };
  it('words status moves, other changes and comments', () => {
    const moved: HomeAgentAction = {
      kind: 'activity',
      id: '1',
      task: ref,
      type: 'task.updated',
      changes: [{ field: 'status', from: 'in_progress', to: 'in_review' }],
      at: minutesAgo(120),
    };
    expect(actionText(moved)).toBe('moved to In review');
    const asked: HomeAgentAction = {
      kind: 'comment',
      id: '30000000-0000-4000-8000-000000000002',
      task: ref,
      excerpt: 'Should the retry cap be 5?',
      mentions: [ANA],
      at: minutesAgo(60),
    };
    expect(actionText(asked)).toBe('asked Ana a question');
    expect(actionText({ ...asked, mentions: [] })).toBe('commented');
  });
});
