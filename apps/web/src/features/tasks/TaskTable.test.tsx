import { render, screen } from '@testing-library/react';
import { TaskListItem, type WorkItemProgress } from '@zamu/contracts';
import { taskListItemFixture } from '@zamu/contracts/testing/fixtures';
import { describe, expect, it } from 'vitest';
import { type DisplayOptions, defaultDisplayOptions } from '~/features/views/display-options';
import { TaskRowContent } from './TaskTable';

// The criteria marker on a list row (M6, frame 023): off by default; with "Criteria" on, partial,
// complete or nothing, after subtasks and before the due date.

const progress = (settled: number, waived: number, total: number): WorkItemProgress => ({
  settled,
  open: total - settled,
  waived,
  total,
});

const item = (extra: Partial<TaskListItem> = {}) =>
  TaskListItem.parse({
    ...taskListItemFixture,
    labels: [],
    subtaskProgress: { done: 3, total: 4 },
    ...extra,
  });

function renderRow(task: TaskListItem, display: DisplayOptions) {
  return render(
    <div data-testid="row">
      <TaskRowContent task={task} display={display} viewerId={null} now={null} today="2026-11-01" />
    </div>,
  );
}

const withCriteria = (view: 'list' | 'board' = 'list'): DisplayOptions => {
  const base = defaultDisplayOptions(view);
  return { ...base, properties: { ...base.properties, criteria: true } };
};

describe('criteria marker on rows', () => {
  it('is off by default', () => {
    renderRow(item({ criteriaProgress: progress(5, 1, 6) }), defaultDisplayOptions('list'));
    expect(screen.queryByRole('img', { name: /criteria/ })).toBeNull();
  });

  it('shows checked of total with an empty box while items are open', () => {
    renderRow(item({ criteriaProgress: progress(5, 1, 6) }), withCriteria());
    const mark = screen.getByRole('img', { name: '4 of 6 criteria checked, 1 waived' });
    expect(mark).toHaveTextContent('4/6');
    expect(mark).not.toHaveAttribute('data-complete');
  });

  it('fills the box with a tick when every criterion is checked or waived', () => {
    renderRow(item({ criteriaProgress: progress(5, 0, 5) }), withCriteria());
    const mark = screen.getByRole('img', { name: 'All 5 criteria checked' });
    expect(mark).toHaveTextContent('5/5');
    expect(mark).toHaveAttribute('data-complete', 'true');
  });

  it('shows nothing for a task without criteria', () => {
    renderRow(item({ criteriaProgress: progress(0, 0, 0) }), withCriteria());
    expect(screen.queryByRole('img', { name: /criteri/ })).toBeNull();
    // A list item from before M6 has no counts at all.
    renderRow(item(), withCriteria());
    expect(screen.queryByRole('img', { name: /criteri/ })).toBeNull();
  });

  it('sits after the subtask progress and before the due date', () => {
    // The due chip renders once the clock is known.
    render(
      <div data-testid="timed">
        <TaskRowContent
          task={item({ criteriaProgress: progress(1, 0, 3), dueDate: '2026-11-07' })}
          display={withCriteria()}
          viewerId={null}
          now={Date.parse('2026-11-01T10:00:00Z')}
          today="2026-11-01"
        />
      </div>,
    );
    const row = screen.getByTestId('timed');
    const text = row.textContent ?? '';
    const subtasks = text.indexOf('3/4');
    const criteria = text.indexOf('1/3');
    const due = text.indexOf('Nov 7');
    expect(subtasks).toBeGreaterThan(-1);
    expect(criteria).toBeGreaterThan(subtasks);
    expect(due).toBeGreaterThan(criteria);
  });
});
