import { render, screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import type { Cycle, CycleDetail, MilestoneWithProgress, TaskListItem } from '@zamu/contracts';
import { describe, expect, it, vi } from 'vitest';
import { CycleDialog, checkCycleDates, cycleDefaults } from './CycleDialog';
import { activeCycleStats, cycleSummaryText, parseCycleParam, rolledOverTo } from './CyclePage';
import { cadenceText, cycleDay, cycleNoteText, daysAfterToday, splitCycles } from './CyclesScreen';
import { formatShortRange } from './dates';
import { EndCycleDialog, moveToFor } from './EndCycleDialog';
import { MilestoneDialog } from './MilestoneDialog';
import { milestoneSplit, milestoneStats } from './MilestonePage';
import { milestonePill, sortMilestones, targetText, taskCountText } from './MilestonesScreen';
import { parsePlanningSearch } from './search';
import { planningFilterFields, planningListInput, withoutClosed } from './usePlanningTasks';

const TODAY = '2026-10-23';
const PROJECT = { id: '00000000-0000-7000-8000-000000000001', key: 'PAY', name: 'Payments' };
const ANA = { id: '00000000-0000-7000-8000-0000000000a1', name: 'Ana Ruiz', kind: 'person' as const };

function counts(partial: Partial<Cycle['counts']> = {}): Cycle['counts'] {
  return {
    backlog: 0,
    todo: 0,
    in_progress: 0,
    in_review: 0,
    done: 0,
    canceled: 0,
    total: 0,
    addedAfterStart: 0,
    unassigned: 0,
    agents: 0,
    ...partial,
  };
}

function cycle(number: number, partial: Partial<CycleDetail> = {}): CycleDetail {
  return {
    id: `00000000-0000-7000-8000-${String(number).padStart(12, '0')}`,
    project: PROJECT,
    number,
    name: null,
    startsOn: '2026-10-12',
    endsOn: '2026-10-25',
    state: 'current',
    daysLeft: 3,
    counts: counts(),
    completedAt: null,
    endedBy: null,
    summary: null,
    rollovers: [],
    ...partial,
  };
}

function milestone(name: string, partial: Partial<MilestoneWithProgress> = {}): MilestoneWithProgress {
  return {
    id: `00000000-0000-7000-8000-${name.length.toString().padStart(12, '0')}`,
    project: PROJECT,
    name,
    description: null,
    targetDate: null,
    status: 'planned',
    completedAt: null,
    createdBy: ANA,
    createdAt: '2026-10-01T10:00:00.000Z',
    updatedAt: '2026-10-01T10:00:00.000Z',
    progress: { total: 0, done: 0, inProgress: 0, open: 0, canceled: 0 },
    daysLeft: null,
    overdue: false,
    ...partial,
  };
}

function task(number: number, partial: Partial<TaskListItem> = {}): TaskListItem {
  return {
    id: `00000000-0000-7000-9000-${String(number).padStart(12, '0')}`,
    key: `PAY-${number}`,
    number,
    project: PROJECT,
    title: `Task ${number}`,
    status: 'todo',
    priority: 'medium',
    assignee: null,
    milestone: null,
    cycle: null,
    cycleAddedAt: null,
    rank: number,
    createdAt: '2026-10-01T10:00:00.000Z',
    updatedAt: '2026-10-01T10:00:00.000Z',
    ...partial,
  };
}

// ---------------------------------------------------------------------------
// Milestone dialog
// ---------------------------------------------------------------------------

describe('MilestoneDialog', () => {
  function setup(
    onSubmit = vi.fn().mockResolvedValue(null),
    extra: Partial<Parameters<typeof MilestoneDialog>[0]> = {},
  ) {
    const user = userEvent.setup();
    const onClose = vi.fn();
    render(
      <MilestoneDialog
        isOpen
        onClose={onClose}
        projectKey="PAY"
        today={TODAY}
        onSubmit={onSubmit}
        {...extra}
      />,
    );
    return { user, onSubmit, onClose };
  }

  it('opens on the name, says how it starts, and refuses an empty name', async () => {
    const { user, onSubmit } = setup();
    expect(screen.getByRole('dialog', { name: 'New milestone' })).toBeInTheDocument();
    expect(screen.getByLabelText('Name')).toHaveFocus();
    expect(
      screen.getByText('Starts as Planned. It turns Active when a task in it starts.'),
    ).toBeInTheDocument();
    await user.click(screen.getByRole('button', { name: /^Create/ }));
    expect(onSubmit).not.toHaveBeenCalled();
    expect(screen.getByText('Name is required')).toBeInTheDocument();
  });

  it('sends the name, description and a quick-pick target date', async () => {
    const { user, onSubmit } = setup();
    await user.type(screen.getByLabelText('Name'), 'PCI DSS 4.0 self-assessment');
    await user.type(screen.getByLabelText(/Description/), 'Evidence for the yearly questionnaire');
    await user.click(screen.getByRole('button', { name: /Target date/ }));
    await user.click(screen.getByRole('button', { name: 'End of quarter' }));
    expect(screen.getByRole('button', { name: /Target date/ })).toHaveTextContent('Dec 31, 2026');
    await user.click(screen.getByRole('button', { name: /^Create/ }));
    expect(onSubmit).toHaveBeenCalledWith({
      name: 'PCI DSS 4.0 self-assessment',
      description: 'Evidence for the yearly questionnaire',
      targetDate: '2026-12-31',
    });
  });

  it('picks a day from the calendar with the keyboard', async () => {
    const { user, onSubmit } = setup();
    await user.type(screen.getByLabelText('Name'), 'Webhooks v2');
    await user.click(screen.getByRole('button', { name: /Target date/ }));
    const calendar = await screen.findByRole('dialog', { name: 'Pick target date' });
    // The grid opens on today (the browser's), then the arrows move a week or a day.
    await waitFor(() => expect(calendar.contains(document.activeElement)).toBe(true));
    const start = document.activeElement?.getAttribute('aria-label') ?? '';
    expect(start).toMatch(/Today/);
    await user.keyboard('{ArrowDown}{ArrowDown}{ArrowDown}{ArrowLeft}{Enter}');
    const trigger = screen.getByRole('button', { name: /Target date/ });
    expect(trigger).not.toHaveTextContent('No date');
    // Picking closes the calendar.
    await waitFor(() => expect(screen.queryByRole('dialog', { name: 'Pick target date' })).toBeNull());
    await user.click(screen.getByLabelText('Name'));
    await user.keyboard('{Control>}{Enter}{/Control}');
    expect(onSubmit).toHaveBeenCalledWith({
      name: 'Webhooks v2',
      description: null,
      targetDate: expect.stringMatching(/^\d{4}-\d{2}-\d{2}$/),
    });
  });

  it('shows a taken name on the name field', async () => {
    const onSubmit = vi
      .fn()
      .mockResolvedValue({ field: 'name', message: 'PAY already has a milestone named “X”.' });
    const { user } = setup(onSubmit);
    await user.type(screen.getByLabelText('Name'), 'X');
    await user.click(screen.getByRole('button', { name: /^Create/ }));
    expect(await screen.findByText('PAY already has a milestone named “X”.')).toBeInTheDocument();
  });

  it('edits with the status and asks before deleting', async () => {
    const onSubmit = vi.fn().mockResolvedValue(null);
    const onDelete = vi.fn().mockResolvedValue(null);
    const { user } = setup(onSubmit, {
      milestone: milestone('Webhooks v2', {
        status: 'active',
        targetDate: '2026-11-14',
        progress: { total: 22, done: 14, inProgress: 5, open: 3, canceled: 0 },
      }),
      onDelete,
    });
    expect(screen.getByRole('dialog', { name: 'Edit milestone' })).toBeInTheDocument();
    expect(screen.getByLabelText('Name')).toHaveValue('Webhooks v2');
    await user.click(screen.getByRole('button', { name: 'Delete' }));
    expect(screen.getByText('Its 22 tasks lose the milestone.')).toBeInTheDocument();
    await user.click(screen.getByRole('button', { name: 'Delete milestone' }));
    expect(onDelete).toHaveBeenCalled();
    expect(onSubmit).not.toHaveBeenCalled();
  });
});

// ---------------------------------------------------------------------------
// Cycles
// ---------------------------------------------------------------------------

describe('cycle defaults', () => {
  it('starts the first cycle next Monday for two weeks', () => {
    expect(cycleDefaults([], TODAY)).toEqual({
      startsOn: '2026-10-26',
      endsOn: '2026-11-08',
      hint: 'Two weeks from Monday, Oct 26. You can change the length.',
    });
  });

  it('follows the last cycle with the same length (frame 28)', () => {
    const cycles = [
      cycle(13, { startsOn: '2026-10-26', endsOn: '2026-11-08', state: 'upcoming' }),
      cycle(14, { startsOn: '2026-11-09', endsOn: '2026-11-22', state: 'upcoming' }),
      cycle(12),
    ];
    expect(cycleDefaults(cycles, TODAY)).toEqual({
      startsOn: '2026-11-23',
      endsOn: '2026-12-06',
      hint: '2 weeks, the same length as Cycle 14. It starts the day after Cycle 14 ends.',
    });
  });

  it('starts today when the last cycle ended a while ago', () => {
    const old = cycle(3, { startsOn: '2026-09-01', endsOn: '2026-09-07', state: 'completed' });
    expect(cycleDefaults([old], TODAY)).toMatchObject({ startsOn: TODAY, endsOn: '2026-10-29' });
  });

  it('checks dates like core', () => {
    expect(checkCycleDates('2026-10-26', '2026-10-25', TODAY)).toBe('End on or after the start date.');
    expect(checkCycleDates('2026-10-26', '2026-12-31', TODAY)).toBe('Keep cycles to 56 days or fewer.');
    expect(checkCycleDates('2026-10-01', '2026-10-20', TODAY)).toBe('A cycle cannot end before today.');
    expect(checkCycleDates('2026-10-26', '2026-11-08', TODAY)).toBeNull();
  });
});

describe('CycleDialog', () => {
  it('prefills the dates, shifts the end with the start, and sends the name', async () => {
    const user = userEvent.setup();
    const onSubmit = vi.fn().mockResolvedValue(null);
    render(
      <CycleDialog
        isOpen
        onClose={() => {}}
        projectKey="PAY"
        number={15}
        defaults={cycleDefaults(
          [cycle(14, { startsOn: '2026-11-09', endsOn: '2026-11-22', state: 'upcoming' })],
          TODAY,
        )}
        today={TODAY}
        onSubmit={onSubmit}
      />,
    );
    expect(screen.getByText('Cycle 15 ·')).toBeInTheDocument();
    expect(screen.getByRole('button', { name: /Starts/ })).toHaveTextContent('Mon, Nov 23');
    expect(screen.getByRole('button', { name: /Ends/ })).toHaveTextContent('Sun, Dec 6');
    await user.click(screen.getByRole('button', { name: /Starts/ }));
    await user.click(await screen.findByRole('button', { name: /November 30, 2026/ }));
    expect(screen.getByRole('button', { name: /Ends/ })).toHaveTextContent('Sun, Dec 13');
    expect(screen.getByText('2 weeks, Nov 30 to Dec 13.')).toBeInTheDocument();
    await user.type(screen.getByRole('textbox'), 'Checkout rewrite');
    await user.click(screen.getByRole('button', { name: /^Create/ }));
    expect(onSubmit).toHaveBeenCalledWith({
      name: 'Checkout rewrite',
      startsOn: '2026-11-30',
      endsOn: '2026-12-13',
    });
  });
});

describe('EndCycleDialog', () => {
  const current = cycle(12, {
    counts: counts({ total: 18, done: 9, in_progress: 4, in_review: 1, todo: 4 }),
  });
  const unfinished = [
    task(144, { status: 'todo' }),
    task(142, { status: 'in_progress', assignee: { ...ANA, responsible: null } }),
    task(138, { status: 'in_review' }),
  ];

  it('moves unfinished tasks to the next cycle by default (frame 25)', async () => {
    const user = userEvent.setup();
    const onSubmit = vi.fn().mockResolvedValue(null);
    const next = cycle(13, {
      startsOn: '2026-10-26',
      endsOn: '2026-11-08',
      state: 'upcoming',
      counts: counts({ total: 2 }),
    });
    render(
      <EndCycleDialog
        isOpen
        onClose={() => {}}
        cycle={current}
        next={next}
        newNumber={15}
        unfinished={unfinished}
        onSubmit={onSubmit}
      />,
    );
    const dialog = screen.getByRole('dialog', { name: 'End Cycle 12 now?' });
    expect(dialog).toHaveTextContent('9 of 18 tasks are done. The other 3 move to the next cycle.');
    expect(dialog).toHaveTextContent('It would end on its own on Oct 25 at midnight.');
    expect(screen.getByText('Oct 26 – Nov 8 · 2 tasks')).toBeInTheDocument();
    const rows = within(screen.getByRole('list', { name: 'Unfinished · 3' })).getAllByRole('listitem');
    expect(rows.map((row) => row.textContent?.slice(0, 7))).toEqual(['PAY-142', 'PAY-138', 'PAY-144']);
    await user.click(screen.getByRole('button', { name: 'End and move 3' }));
    expect(onSubmit).toHaveBeenCalledWith(13);
  });

  it('offers a new cycle when none is planned, and No cycle', async () => {
    const user = userEvent.setup();
    const onSubmit = vi.fn().mockResolvedValue(null);
    render(
      <EndCycleDialog
        isOpen
        onClose={() => {}}
        cycle={current}
        newNumber={13}
        unfinished={unfinished}
        onSubmit={onSubmit}
      />,
    );
    expect(screen.getByText('New Cycle 13')).toBeInTheDocument();
    expect(screen.getByText('Oct 26 – Nov 8 · same length')).toBeInTheDocument();
    await user.click(screen.getByText('No cycle'));
    expect(screen.getByRole('dialog')).toHaveTextContent('The other 3 go back to the project list.');
    await user.click(screen.getByRole('button', { name: 'End and move 3' }));
    expect(onSubmit).toHaveBeenCalledWith('none');
  });

  it('maps the choice to moveTo', () => {
    expect(moveToFor('next', { number: 13 })).toBe(13);
    expect(moveToFor('next', undefined)).toBeUndefined();
    expect(moveToFor('none', { number: 13 })).toBe('none');
  });
});

describe('cycle lists and pages', () => {
  it('splits and describes the cycles', () => {
    const items = [
      cycle(11, { state: 'completed', daysLeft: null }),
      cycle(12),
      cycle(14, { state: 'upcoming', startsOn: '2026-11-09', endsOn: '2026-11-22', daysLeft: null }),
      cycle(13, { state: 'upcoming', startsOn: '2026-10-26', endsOn: '2026-11-08', daysLeft: null }),
    ];
    const split = splitCycles(items);
    expect(split.current?.number).toBe(12);
    expect(split.upcoming.map((item) => item.number)).toEqual([13, 14]);
    expect(split.completed.map((item) => item.number)).toEqual([11]);
    expect(cadenceText(items)).toBe('Two weeks, starting Mondays');
    expect(cadenceText([])).toBeNull();
  });

  it('counts the days of a current cycle (frame 109: day 8 of 14, 6 days left)', () => {
    const current = cycle(12, { startsOn: '2026-10-27', endsOn: '2026-11-09', daysLeft: 7 });
    expect(cycleDay(current)).toBe(8);
    expect(daysAfterToday(current)).toBe(6);
    expect(cycleDay({ ...current, daysLeft: 1 })).toBe(14);
    expect(daysAfterToday({ daysLeft: 1 })).toBe(0);
    expect(formatShortRange('2026-10-27', '2026-11-09')).toBe('Oct 27 – Nov 9');
    expect(formatShortRange('2026-11-10', '2026-11-23')).toBe('Nov 10 – 23');
    expect(formatShortRange('2026-12-28', '2027-01-10')).toBe('Dec 28, 2026 – Jan 10, 2027');
  });

  it('writes the note under each cycle row', () => {
    const upcoming = cycle(13, {
      state: 'upcoming',
      startsOn: '2026-10-26',
      endsOn: '2026-11-08',
      daysLeft: null,
      counts: counts({ total: 6, todo: 6 }),
    });
    expect(cycleNoteText(upcoming, TODAY)).toBe('Starts Monday · 6 tasks planned');
    const summary = { scope: 25, completed: 22, rolledOver: 3, canceled: 0, addedAfterStart: 0 };
    const ended = cycle(11, { state: 'completed', daysLeft: null, summary });
    expect(cycleNoteText(ended, TODAY, [12, 12, 12])).toBe('3 unfinished tasks moved to Cycle 12');
    expect(cycleNoteText(ended, TODAY)).toBe('3 unfinished tasks rolled over');
    expect(cycleNoteText({ ...ended, summary: { ...summary, rolledOver: 1 } }, TODAY, [null])).toBe(
      '1 unfinished task moved to no cycle',
    );
    expect(cycleNoteText({ ...ended, summary: { ...summary, rolledOver: 0 } }, TODAY)).toBe(
      'Everything done',
    );
  });

  it('gives the numbers of a cycle page', () => {
    const current = cycle(12, {
      startsOn: '2026-10-27',
      endsOn: '2026-11-09',
      daysLeft: 7,
      counts: counts({ total: 25, done: 9, in_review: 5, in_progress: 4, todo: 6, canceled: 1 }),
    });
    expect(activeCycleStats(current, TODAY)).toEqual([
      { value: 24, label: 'in scope' },
      { value: 9, label: 'done' },
      { value: 6, label: 'days left' },
    ]);
    const upcoming = cycle(13, {
      state: 'upcoming',
      startsOn: '2026-10-26',
      daysLeft: null,
      counts: counts({ total: 6 }),
    });
    expect(activeCycleStats(upcoming, TODAY)).toEqual([
      { value: 6, label: 'planned' },
      { value: 3, label: 'days to start' },
    ]);
  });

  it('reads cycle route params', () => {
    expect(parseCycleParam('12')).toBe(12);
    expect(parseCycleParam('current')).toBe('current');
    expect(parseCycleParam('0')).toBeNull();
    expect(parseCycleParam('12a')).toBeNull();
  });

  it('summarises a completed cycle', () => {
    const done = cycle(11, {
      name: 'Webhook retries',
      startsOn: '2026-09-28',
      endsOn: '2026-10-11',
      state: 'completed',
      daysLeft: null,
      summary: { scope: 20, completed: 16, rolledOver: 1, canceled: 1, addedAfterStart: 2 },
      rollovers: [
        {
          task: { id: task(131).id, key: 'PAY-131', title: 'Add idempotency keys', status: 'in_progress' },
          statusAtEnd: 'in_progress',
          movedTo: { id: cycle(12).id, number: 12, name: null },
          createdAt: '2026-10-12T00:00:00.000Z',
        },
      ],
    });
    expect(rolledOverTo(done.rollovers)).toBe('to Cycle 12');
    expect(rolledOverTo([])).toBe('nothing moved');
    expect(cycleSummaryText(done, [task(118, { title: 'Drop XML webhooks', status: 'canceled' })])).toBe(
      [
        'Cycle 11 · Webhook retries (Sep 28 – Oct 11)',
        'Scope 20 · Completed 16 (80%) · Rolled over 1 · Canceled 1',
        '',
        'Rolled over:',
        '- PAY-131 Add idempotency keys (In progress, to Cycle 12)',
        '',
        'Canceled:',
        '- PAY-118 Drop XML webhooks',
      ].join('\n'),
    );
  });
});

// ---------------------------------------------------------------------------
// Milestone list helpers, task groups, search params
// ---------------------------------------------------------------------------

describe('milestone list', () => {
  it('sorts by target date with undated last, then by name', () => {
    const items = [
      milestone('Refunds rework'),
      milestone('Webhooks v2', { targetDate: '2026-11-14' }),
      milestone('PCI audit', { targetDate: '2026-10-20' }),
      milestone('Apple Pay'),
    ];
    expect(sortMilestones(items).map((item) => item.name)).toEqual([
      'PCI audit',
      'Webhooks v2',
      'Apple Pay',
      'Refunds rework',
    ]);
  });

  it('describes targets (frame 107)', () => {
    expect(targetText(milestone('Mobile', { targetDate: '2026-11-14', daysLeft: 11 }), TODAY)).toEqual({
      text: 'Nov 14 · in 11 days',
      tone: 'default',
    });
    expect(
      targetText(
        milestone('PCI', { targetDate: '2026-10-20', daysLeft: -3, overdue: true, status: 'active' }),
        TODAY,
      ),
    ).toEqual({ text: 'Oct 20 · 3 days late', tone: 'late' });
    expect(targetText(milestone('SEPA', { targetDate: '2027-01-30', daysLeft: 99 }), TODAY).text).toBe(
      'Jan 30, 2027 · in 99 days',
    );
    expect(targetText(milestone('Refunds'), TODAY)).toEqual({ text: 'No date', tone: 'none' });
  });

  it('picks the status pill and the task count', () => {
    const dated = milestone('Mobile', { targetDate: '2026-11-14', daysLeft: 11 });
    expect(milestonePill(dated, 0)).toEqual({ text: 'On track', tone: 'ok' });
    expect(milestonePill(dated, 2)).toEqual({ text: '2 blocked', tone: 'warn' });
    expect(milestonePill({ ...dated, overdue: true }, 0)).toEqual({ text: 'Overdue', tone: 'warn' });
    expect(milestonePill(milestone('Trends', { status: 'active' }), 0)).toEqual({
      text: 'Active',
      tone: 'default',
    });
    expect(milestonePill({ ...dated, status: 'completed' }, 3)).toEqual({
      text: 'Completed',
      tone: 'default',
    });
    expect(taskCountText({ total: 31, done: 18, inProgress: 9, open: 3, canceled: 1 })).toBe('18 of 30');
  });

  it('gives the numbers and the bar of a milestone page (frame 108)', () => {
    const mobile = milestone('Mobile', {
      targetDate: '2026-11-14',
      daysLeft: 11,
      progress: { total: 30, done: 18, inProgress: 9, open: 3, canceled: 0 },
    });
    expect(milestoneStats(mobile)).toEqual([
      { value: 30, label: 'tasks' },
      { value: 18, label: 'done' },
      { value: 11, label: 'days left' },
    ]);
    expect(milestoneStats({ ...mobile, daysLeft: -1 })[2]).toEqual({ value: 1, label: 'day late' });
    expect(milestoneStats({ ...mobile, targetDate: null, daysLeft: null })).toHaveLength(2);
    expect(milestoneSplit(mobile, undefined)).toEqual({ done: 18, review: 0, progress: 9, todo: 3 });
    expect(
      milestoneSplit(mobile, { backlog: 1, todo: 2, in_progress: 4, in_review: 5, done: 18, canceled: 0 }),
    ).toEqual({ done: 18, review: 5, progress: 4, todo: 3 });
  });
});

describe('planning tasks', () => {
  it('parses the filter params and drops what it does not know', () => {
    expect(
      parsePlanningSearch({ status: 'todo,nope', assignee: 'me', cycle: 12, milestone: '', sort: 'name' }),
    ).toEqual({ status: 'todo', assignee: 'me', cycle: 12 });
  });

  it('scopes the task list to the page', () => {
    expect(planningListInput('PAY', { cycle: 12 }, { status: ['todo'], cycle: ['current'] })).toEqual({
      project: 'PAY',
      status: ['todo'],
      cycle: '12',
    });
    expect(planningListInput('PAY', { milestone: 'm1' }, { milestone: ['none'] })).toEqual({
      project: 'PAY',
      milestone: 'm1',
    });
    expect(planningFilterFields('milestone', { milestones: true, cycles: true })).toEqual([
      'status',
      'priority',
      'assignee',
      'label',
      'due',
      'blocked',
      'cycle',
    ]);
    expect(planningFilterFields('cycle', { milestones: false, cycles: true })).not.toContain('milestone');
  });

  it('hides done and canceled tasks until asked', () => {
    const tasks = [task(1), task(2, { status: 'done' }), task(3, { status: 'canceled' })];
    expect(withoutClosed(tasks, {}, false)).toEqual({ shown: [tasks[0]], hidden: 2 });
    expect(withoutClosed(tasks, {}, true).hidden).toBe(0);
    expect(withoutClosed(tasks, { status: ['done'] }, false).shown).toHaveLength(3);
  });
});
