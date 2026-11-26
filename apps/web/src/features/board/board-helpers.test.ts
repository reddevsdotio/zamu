import type { TaskListItem, TaskListPage, TaskStatus } from '@zamu/contracts';
import { describe, expect, it } from 'vitest';
import { cycleElapsed, cycleNote, projectViewHref } from '~/features/project-header/tabs';
import { asWorkspaceSlug } from '~/lib/workspace-paths';
import {
  cardsOf,
  compareBySort,
  insertCard,
  rankFor,
  removeCard,
  shiftCounts,
  sortPlacement,
} from './board-cache';
import { buildLanes, groupKeysOf, groupPatch, NO_LANE } from './lanes';
import {
  columnStep,
  focusTarget,
  hasNeighbour,
  type NavColumn,
  placementBetween,
  reorderPlacement,
} from './layout';
import type { BoardColumnData } from './queries';

const card = (key: string, rank: number, extra: Partial<TaskListItem> = {}): TaskListItem => ({
  id: `00000000-0000-4000-8000-${key.replace(/\D/g, '').padStart(12, '0')}`,
  key,
  number: Number(key.replace(/\D/g, '')),
  project: { id: '10000000-0000-4000-8000-000000000001', key: 'PAY', name: 'Payments' },
  title: key,
  status: 'todo',
  priority: 'none',
  assignee: null,
  milestone: null,
  cycle: null,
  cycleAddedAt: null,
  rank,
  createdAt: '2026-10-20T10:00:00.000Z',
  updatedAt: '2026-10-20T10:00:00.000Z',
  ...extra,
});

const counts = { backlog: 0, todo: 3, in_progress: 1, in_review: 0, done: 0, canceled: 0 };
const page = (items: TaskListItem[], nextCursor: string | null = null): TaskListPage => ({
  items,
  nextCursor,
  counts,
});
const column = (...pages: TaskListPage[]): BoardColumnData => ({ pages, pageParams: pages.map(() => null) });
const keys = (data: BoardColumnData) => cardsOf(data).map((item) => item.key);

describe('board cache', () => {
  const data = column(page([card('PAY-1', 1), card('PAY-2', 2)]), page([card('PAY-3', 3)]));

  it('inserts at the top, next to an anchor, or by rank', () => {
    const moving = card('PAY-9', 0);
    expect(keys(insertCard(data, moving, 'top'))).toEqual(['PAY-9', 'PAY-1', 'PAY-2', 'PAY-3']);
    expect(keys(insertCard(data, moving, { before: 'PAY-3' }))).toEqual(['PAY-1', 'PAY-2', 'PAY-9', 'PAY-3']);
    expect(keys(insertCard(data, moving, { after: 'PAY-1' }))).toEqual(['PAY-1', 'PAY-9', 'PAY-2', 'PAY-3']);
    expect(keys(insertCard(data, card('PAY-9', 2.5), 'rank'))).toEqual(['PAY-1', 'PAY-2', 'PAY-9', 'PAY-3']);
    // An unknown anchor falls back to the rank.
    expect(keys(insertCard(data, card('PAY-9', 1.5), { after: 'PAY-404' }))).toEqual([
      'PAY-1',
      'PAY-9',
      'PAY-2',
      'PAY-3',
    ]);
  });

  it('leaves a card that sorts past the loaded pages for the next page', () => {
    const partial = column(page([card('PAY-1', 1)], 'next'));
    expect(keys(insertCard(partial, card('PAY-9', 5), 'rank'))).toEqual(['PAY-1']);
  });

  it('moves a card within its column without duplicating it', () => {
    expect(keys(insertCard(data, card('PAY-3', 3), 'top'))).toEqual(['PAY-3', 'PAY-1', 'PAY-2']);
    expect(keys(removeCard(data, 'PAY-2'))).toEqual(['PAY-1', 'PAY-3']);
  });

  it('shifts the counts of every page', () => {
    const shifted = shiftCounts(data, 'todo', 'in_progress');
    expect(shifted.pages.map((item) => [item.counts.todo, item.counts.in_progress])).toEqual([
      [2, 2],
      [2, 2],
    ]);
    expect(shiftCounts(data, 'todo', 'todo')).toBe(data);
  });

  it('ranks between neighbours', () => {
    const cards = [card('PAY-1', 1), card('PAY-2', 2)];
    expect(rankFor(cards, 'top', 9)).toBe(0);
    expect(rankFor(cards, { before: 'PAY-2' }, 9)).toBe(1.5);
    expect(rankFor(cards, { after: 'PAY-2' }, 9)).toBe(3);
    expect(rankFor(cards, { before: 'PAY-1' }, 9)).toBe(0);
    expect(rankFor(cards, 'rank', 9)).toBe(9);
  });
});

describe('board keyboard geometry', () => {
  const nav: NavColumn[] = [
    { id: 'backlog', cells: [{ lane: null, keys: ['A1'] }] },
    { id: 'todo', cells: [{ lane: null, keys: [] }] },
    { id: 'in_progress', cells: [{ lane: null, keys: ['C1', 'C2', 'C3'] }] },
  ];

  it('starts on the first card and stops at the ends', () => {
    expect(focusTarget(nav, null, 'down')).toEqual({ key: 'A1' });
    expect(focusTarget(nav, 'C1', 'up')).toEqual({ key: 'C1' });
    expect(focusTarget(nav, 'C3', 'down')).toEqual({ end: 'in_progress' });
    expect(focusTarget(nav, 'C2', 'down')).toEqual({ key: 'C3' });
    expect(hasNeighbour(nav, 'C2', 'down')).toBe(true);
    expect(hasNeighbour(nav, 'C3', 'down')).toBe(false);
    expect(hasNeighbour(nav, 'C1', 'up')).toBe(false);
  });

  it('skips empty columns and keeps the row between columns', () => {
    expect(focusTarget(nav, 'A1', 'right')).toEqual({ key: 'C1' });
    expect(focusTarget(nav, 'C3', 'left')).toEqual({ key: 'A1' });
    expect(focusTarget(nav, 'A1', 'left')).toEqual({ key: 'A1' });
  });

  it('keeps the lane between columns on a swimlane board', () => {
    const lanes: NavColumn[] = [
      {
        id: 'todo',
        cells: [
          { lane: 'ana', keys: ['T1'] },
          { lane: 'tomas', keys: ['T2', 'T3'] },
        ],
      },
      {
        id: 'in_progress',
        cells: [
          { lane: 'ana', keys: ['P1', 'P2'] },
          { lane: 'tomas', keys: ['P3'] },
        ],
      },
    ];
    expect(focusTarget(lanes, 'T3', 'right')).toEqual({ key: 'P3' });
    expect(focusTarget(lanes, 'P2', 'left')).toEqual({ key: 'T1' });
    expect(focusTarget(lanes, 'T1', 'down')).toEqual({ key: 'T2' });
    // Reordering stays inside the lane.
    expect(reorderPlacement(lanes, 'T1', 'down')).toBeNull();
    expect(reorderPlacement(lanes, 'T2', 'down')).toEqual({ after: 'T3' });
    expect(reorderPlacement(lanes, 'T3', 'up')).toEqual({ before: 'T2' });
  });

  it('steps columns and puts cards back between their neighbours', () => {
    const statuses: TaskStatus[] = ['backlog', 'todo', 'in_progress'];
    expect(columnStep(statuses, 'todo', 'right')).toBe('in_progress');
    expect(columnStep(statuses, 'backlog', 'left')).toBeNull();
    expect(columnStep(['urgent', 'high'], 'urgent', 'right')).toBe('high');
    expect(placementBetween('A', 'B')).toEqual({ after: 'A' });
    expect(placementBetween(null, 'B')).toEqual({ before: 'B' });
    expect(placementBetween(null, null)).toBe('top');
  });
});

describe('column order', () => {
  const at = (minute: number) => `2026-10-20T10:${String(minute).padStart(2, '0')}:00.000Z`;

  it('sorts as tasks.list does: priority, then the newest update', () => {
    const cards = [
      card('PAY-1', 3, { priority: 'urgent', updatedAt: at(1) }),
      card('PAY-2', 2, { priority: 'high', updatedAt: at(5) }),
      card('PAY-3', 1, { priority: 'high', updatedAt: at(2) }),
    ];
    const sorted = [...cards].sort((a, b) => compareBySort('priority', a, b)).map((item) => item.key);
    expect(sorted).toEqual(['PAY-1', 'PAY-2', 'PAY-3']);
    expect([...cards].sort((a, b) => compareBySort('manual', a, b)).map((item) => item.key)).toEqual([
      'PAY-3',
      'PAY-2',
      'PAY-1',
    ]);
  });

  it('sorts due dates soonest first with no date last', () => {
    const cards = [
      card('PAY-1', 1),
      card('PAY-2', 2, { dueDate: '2026-11-02' }),
      card('PAY-3', 3, { dueDate: '2026-10-30' }),
    ];
    expect([...cards].sort((a, b) => compareBySort('due', a, b)).map((item) => item.key)).toEqual([
      'PAY-3',
      'PAY-2',
      'PAY-1',
    ]);
  });

  it('places a moved card where the order puts it', () => {
    const cards = [
      card('PAY-1', 1, { priority: 'urgent', updatedAt: at(1) }),
      card('PAY-2', 2, { priority: 'low', updatedAt: at(1) }),
    ];
    expect(
      sortPlacement(cards, card('PAY-9', 0, { priority: 'high', updatedAt: at(9) }), 'priority'),
    ).toEqual({
      before: 'PAY-2',
    });
    expect(sortPlacement(cards, card('PAY-9', 0, { priority: 'none' }), 'priority')).toEqual({
      after: 'PAY-2',
    });
    expect(sortPlacement([], card('PAY-9', 0), 'priority')).toBe('top');
  });
});

describe('groups and swimlanes', () => {
  const ana = { id: '00000000-0000-4000-8000-0000000000a1', name: 'Ana Ruiz', kind: 'person' as const };
  const bot = { id: '00000000-0000-4000-8000-0000000000b1', name: 'claude-dev', kind: 'agent' as const };

  it('puts the viewer first, then people, then agents, then the unassigned', () => {
    const lanes = buildLanes(
      'assignee',
      [
        {
          id: 'todo',
          cards: [
            card('PAY-1', 1, { assignee: { ...ana, responsible: null } }),
            card('PAY-2', 2),
            card('PAY-3', 3, { assignee: { ...bot, responsible: ana } }),
          ],
        },
        {
          id: 'in_progress',
          cards: [card('PAY-4', 1, { status: 'in_progress', assignee: { ...ana, responsible: null } })],
        },
      ],
      { viewerId: ana.id },
    );
    expect(lanes.map((lane) => [lane.title, lane.count])).toEqual([
      ['Ana Ruiz', 2],
      ['claude-dev', 1],
      ['No assignee', 1],
    ]);
    expect(lanes[0]?.cells.in_progress?.map((item) => item.key)).toEqual(['PAY-4']);
    expect(lanes[0]?.cells.todo?.map((item) => item.key)).toEqual(['PAY-1']);
    expect(lanes[2]?.id).toBe(NO_LANE);
  });

  it('orders milestone lanes by target date', () => {
    const m1 = {
      id: '00000000-0000-4000-8000-0000000000c1',
      name: 'Zeta',
      status: 'planned' as const,
      targetDate: '2026-11-01',
    };
    const m2 = {
      id: '00000000-0000-4000-8000-0000000000c2',
      name: 'Alpha',
      status: 'active' as const,
      targetDate: '2026-12-01',
    };
    const lanes = buildLanes('milestone', [
      {
        id: 'todo',
        cards: [card('PAY-1', 1, { milestone: m2 }), card('PAY-2', 2, { milestone: m1 }), card('PAY-3', 3)],
      },
    ]);
    expect(lanes.map((lane) => lane.title)).toEqual(['Zeta', 'Alpha', 'No milestone']);
  });

  it('knows which group a card is in and what a drop into a group sets', () => {
    const labelled = card('PAY-1', 1, {
      priority: 'high',
      labels: [
        { id: 'l1', name: 'api', color: 1, source: 'app' },
        { id: 'l2', name: 'web', color: 2, source: 'app' },
      ],
    });
    expect(groupKeysOf('priority', labelled)).toEqual(['high']);
    expect(groupKeysOf('label', labelled)).toEqual(['l1', 'l2']);
    expect(groupKeysOf('assignee', labelled)).toEqual([NO_LANE]);
    expect(groupPatch({ field: 'priority', priority: 'urgent' })).toEqual({ priority: 'urgent' });
    expect(groupPatch({ field: 'assignee', assignee: null })).toEqual({ assignee: null });
    expect(groupPatch({ field: 'label', label: null })).toBeNull();
    expect(groupPatch({ field: 'none' })).toBeNull();
  });
});

describe('project page links', () => {
  const project = {
    key: 'PAY',
    openCount: 12,
    usesMilestones: true,
    usesCycles: true,
    currentCycle: {
      id: 'c',
      number: 12,
      name: null,
      startsOn: '2026-10-12',
      endsOn: '2026-10-25',
      daysLeft: 3,
    },
  };

  it('links the project pages and notes the current cycle', () => {
    expect(cycleNote(project.currentCycle)).toBe('C12 · 3d left');
    expect(cycleNote(null)).toBeUndefined();
    expect(cycleElapsed(project.currentCycle)).toBeCloseTo(11 / 14);
    expect(projectViewHref(asWorkspaceSlug('acme'), 'PAY', 'tasks')).toBe('/w/acme/p/PAY');
    expect(projectViewHref(asWorkspaceSlug('acme'), 'PAY', 'cycles')).toBe('/w/acme/p/PAY/cycles');
    expect(projectViewHref(asWorkspaceSlug('acme'), 'PAY', 'settings')).toBe('/w/acme/p/PAY/settings');
  });
});
