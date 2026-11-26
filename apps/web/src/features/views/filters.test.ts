import { ListTasksInput } from '@zamu/contracts';
import { describe, expect, it } from 'vitest';
import {
  activeFilterFields,
  clearedFilter,
  clientFilter,
  clientFilterFields,
  isServerFilterComplete,
  matchesTaskFilter,
  parseTaskFilter,
  sameTaskFilter,
  type TaskFilter,
  taskFilterSearch,
  toHomeInput,
  toListTasksInput,
  withoutField,
  withTaskFilter,
} from './filters';

const L1 = '0b0d8c52-6a4e-4e6b-9b0f-5d0e0e0e0001';
const L2 = '0b0d8c52-6a4e-4e6b-9b0f-5d0e0e0e0002';
const U1 = '1a1d8c52-6a4e-4e6b-9b0f-5d0e0e0e0001';
const M1 = '2b2d8c52-6a4e-4e6b-9b0f-5d0e0e0e0001';

describe('parseTaskFilter', () => {
  it('reads comma lists, arrays (TanStack JSON) and single values', () => {
    expect(
      parseTaskFilter({
        status: 'todo,in_progress',
        priority: ['high', 'urgent'],
        assignee: 'me',
        label: `${L2},${L1}`,
        due: 'overdue',
        blocked: true,
        milestone: M1,
        cycle: 12,
        q: 'webhook',
      }),
    ).toEqual({
      // Enum lists come back in canonical order.
      status: ['todo', 'in_progress'],
      priority: ['high', 'urgent'],
      assignee: ['me'],
      label: [L2, L1],
      due: 'overdue',
      blocked: true,
      milestone: [M1],
      cycle: [12],
      q: 'webhook',
    });
  });

  it('keeps reading the M1–M4 params (single assignee, milestone, cycle)', () => {
    expect(parseTaskFilter({ assignee: 'agents', milestone: 'none', cycle: 'current' })).toEqual({
      assignee: ['agents'],
      milestone: ['none'],
      cycle: ['current'],
    });
  });

  it('drops what it does not understand', () => {
    expect(
      parseTaskFilter({
        status: 'todo,nope',
        priority: 'loud',
        assignee: 'someone',
        label: 'backend',
        due: 'later',
        blocked: 'maybe',
        milestone: 'm-1',
        cycle: '0,x',
        q: '   ',
      }),
    ).toEqual({ status: ['todo'] });
  });

  it('reads label names on Home', () => {
    expect(parseTaskFilter({ label: 'backend,mobile' }, { labels: 'name' })).toEqual({
      label: ['backend', 'mobile'],
    });
  });
});

describe('URL round trip', () => {
  const filter: TaskFilter = {
    status: ['todo', 'in_review'],
    priority: ['urgent'],
    assignee: ['me', 'none', U1],
    label: [L1, L2],
    due: 'soon',
    blocked: false,
    milestone: [M1, 'none'],
    cycle: ['current', 12],
    q: 'export',
  };

  it('serialises every field and reads the same filter back', () => {
    const search = taskFilterSearch(filter);
    expect(search).toEqual({
      status: 'todo,in_review',
      priority: 'urgent',
      assignee: `me,none,${U1}`,
      label: `${L1},${L2}`,
      due: 'soon',
      blocked: false,
      milestone: `${M1},none`,
      cycle: 'current,12',
      q: 'export',
    });
    expect(parseTaskFilter(search)).toEqual(filter);
    // As the URL carries it: every value a string.
    const asText = Object.fromEntries(
      Object.entries(search).flatMap(([key, value]) => (value === undefined ? [] : [[key, String(value)]])),
    );
    expect(parseTaskFilter(asText)).toEqual(filter);
  });

  it('keeps a single cycle number a number, as before M5', () => {
    expect(taskFilterSearch({ cycle: [12] }).cycle).toBe(12);
  });

  it('replaces the filter params and keeps the others', () => {
    const previous = { task: 'PAY-1', view: 'board', status: 'todo', label: L1, lanes: 'assignee' };
    expect(withTaskFilter(previous, { priority: ['high'] })).toEqual({
      task: 'PAY-1',
      view: 'board',
      lanes: 'assignee',
      priority: 'high',
    });
  });

  it('compares filters ignoring value order', () => {
    expect(sameTaskFilter({ label: [L1, L2] }, { label: [L2, L1] })).toBe(true);
    expect(sameTaskFilter({ label: [L1] }, { label: [L2] })).toBe(false);
  });
});

describe('filter helpers', () => {
  it('lists active fields, removes one, clears all but the search', () => {
    const filter: TaskFilter = { label: [L1], assignee: ['me'], q: 'x' };
    expect(activeFilterFields(filter)).toEqual(['assignee', 'label']);
    expect(withoutField(filter, 'label')).toEqual({ assignee: ['me'], q: 'x' });
    expect(clearedFilter(filter)).toEqual({ q: 'x' });
  });
});

describe('toListTasksInput', () => {
  it('sends what tasks.list understands, and parses with the contract', () => {
    const input = toListTasksInput({
      status: ['todo'],
      priority: ['high', 'urgent'],
      assignee: ['me'],
      label: [L1, L2],
      due: 'overdue',
      blocked: true,
      milestone: [M1],
      cycle: ['current'],
      q: ' webhook ',
    });
    expect(input).toEqual({
      status: ['todo'],
      priority: ['high', 'urgent'],
      assignee: ['me'],
      label: [L1, L2],
      due: 'overdue',
      blocked: true,
      milestone: [M1],
      cycle: ['current'],
      q: 'webhook',
    });
    expect(ListTasksInput.safeParse({ project: ['PAY'], ...input }).success).toBe(true);
  });

  it('sends several assignees, milestones and cycles, and none, to the server', () => {
    const filter: TaskFilter = { assignee: ['me', U1], milestone: [M1, 'none'], cycle: [11, 12] };
    const input = toListTasksInput(filter);
    expect(input).toEqual({ assignee: ['me', U1], milestone: [M1, 'none'], cycle: [11, 12] });
    expect(ListTasksInput.safeParse({ project: ['PAY'], ...input }).success).toBe(true);
    expect(toListTasksInput({ assignee: ['none'] })).toEqual({ assignee: ['none'] });
    expect(clientFilterFields(filter)).toEqual([]);
    expect(isServerFilterComplete(filter)).toBe(true);
  });

  it('leaves rows alone on the client now that the server filters everything', () => {
    const rows = [{ key: 'A-1', status: 'todo' as const, priority: 'none' as const, assignee: null }];
    expect(clientFilter(rows, { assignee: ['none', 'agents'] })).toBe(rows);
  });

  it('maps Home filters to home.get', () => {
    expect(toHomeInput({ label: ['backend'], priority: ['urgent'], status: ['todo'] })).toEqual({
      label: ['backend'],
      priority: ['urgent'],
    });
  });
});

describe('M7 filters', () => {
  it('reads, writes and sends check again and archived', () => {
    const filter = parseTaskFilter({ checkAgain: 'ready', archived: 'only' });
    expect(filter).toEqual({ checkAgain: 'ready', archived: 'only' });
    expect(parseTaskFilter({ checkAgain: 'set', archived: 'exclude' })).toEqual({});
    expect(taskFilterSearch(filter)).toMatchObject({ checkAgain: 'ready', archived: 'only' });
    expect(activeFilterFields(filter)).toEqual(['checkAgain', 'archived']);
    const input = toListTasksInput(filter);
    expect(input).toEqual({ checkAgain: 'ready', archived: 'only' });
    expect(ListTasksInput.parse({ ...input }).archived).toBe('only');
    expect(withoutField(filter, 'archived')).toEqual({ checkAgain: 'ready' });
  });

  it('matches tasks by their day and archived state', () => {
    const base = { status: 'todo' as const, priority: 'none' as const, assignee: null };
    const waiting = { ...base, checkAgain: { on: '2026-12-03', reason: 'x' } };
    const ready = { ...base, checkAgain: { on: '2026-11-20', reason: 'x' } };
    const archived = { ...base, archivedAt: '2026-11-12T10:00:00.000Z' };
    const context = { today: '2026-11-26' };
    expect(matchesTaskFilter(waiting, { checkAgain: 'waiting' }, context)).toBe(true);
    expect(matchesTaskFilter(ready, { checkAgain: 'waiting' }, context)).toBe(false);
    expect(matchesTaskFilter(ready, { checkAgain: 'ready' }, context)).toBe(true);
    expect(matchesTaskFilter(base, { checkAgain: 'ready' }, context)).toBe(false);
    expect(matchesTaskFilter(archived, {}, context)).toBe(false);
    expect(matchesTaskFilter(archived, { archived: 'only' }, context)).toBe(true);
    expect(matchesTaskFilter(base, { archived: 'only' }, context)).toBe(false);
    expect(matchesTaskFilter(base, { archived: 'include' }, context)).toBe(true);
  });
});
