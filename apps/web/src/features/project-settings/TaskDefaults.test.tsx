// Task defaults: the empty state, the list with keyboard reorder, rewording in place, remove with Undo,
// adding, the member view, and the pure list edits behind them.
import { ORPCError } from '@orpc/client';
import { screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { useState } from 'react';
import { describe, expect, it, vi } from 'vitest';
import { renderInWorkspace as render } from '~/lib/testing';
import { asWorkspaceSlug } from '~/lib/workspace-paths';
import { projectSettingsHref, settingsSection } from './ProjectSettingsLayout';
import { TaskDefaultsView } from './TaskDefaultsSettings';
import { appliesText, cleanItem, defaultsFailure, itemError, moveItem, moveItemTo } from './task-defaults';

const ITEMS = ['Tests and lint pass', 'Changelog has a line', 'Docs updated when behaviour changes'];

/** The view with a list that follows its saves, as the page does once the server answers. */
function Harness({
  initial = ITEMS,
  canEdit = true,
  onSave = vi.fn().mockResolvedValue(undefined),
}: {
  initial?: string[];
  canEdit?: boolean;
  onSave?: (items: string[]) => Promise<void>;
}) {
  const [items, setItems] = useState(initial);
  return (
    <TaskDefaultsView
      projectName="Payments"
      items={items}
      openCount={40}
      canEdit={canEdit}
      onChange={async (next) => {
        await onSave(next);
        setItems(next);
      }}
    />
  );
}

const lines = () =>
  within(screen.getByRole('list', { name: 'Default done items' }))
    .getAllByRole('listitem')
    .map((item) => item.textContent?.replace(/Edit$/, '').trim());

describe('Task defaults', () => {
  it('starts empty with an action that opens the add field', async () => {
    const user = userEvent.setup();
    const onSave = vi.fn().mockResolvedValue(undefined);
    render(<Harness initial={[]} onSave={onSave} />);
    expect(screen.getByRole('heading', { name: 'Task defaults' })).toBeVisible();
    expect(screen.getByText('What every new task in Payments starts with.')).toBeVisible();
    expect(screen.getByRole('heading', { name: 'No default items' })).toBeVisible();
    expect(screen.queryByText(/Applies to tasks created from now on/)).toBeNull();
    await user.click(screen.getByRole('button', { name: 'Add an item' }));
    await user.type(screen.getByLabelText('New default item'), 'Tests and lint pass{Enter}');
    expect(onSave).toHaveBeenCalledWith(['Tests and lint pass']);
    // The field stays open for the next line.
    expect(screen.getByLabelText('New default item')).toHaveValue('');
    await user.type(screen.getByLabelText('New default item'), 'Changelog has a line{Enter}');
    expect(onSave).toHaveBeenLastCalledWith(['Tests and lint pass', 'Changelog has a line']);
    await user.keyboard('{Escape}');
    expect(screen.queryByLabelText('New default item')).toBeNull();
    expect(lines()).toEqual(['Tests and lint pass', 'Changelog has a line']);
  });

  it('lists the items and says that only new tasks are affected', () => {
    render(<Harness />);
    expect(lines()).toEqual(ITEMS);
    expect(
      screen.getByText('Applies to tasks created from now on. 40 open tasks keep the items they have.'),
    ).toBeVisible();
    expect(screen.getByText(/tasks that already exist keep theirs/)).toBeVisible();
  });

  it('reorders with Alt+arrows on a focused line and announces the move', async () => {
    const user = userEvent.setup();
    const onSave = vi.fn().mockResolvedValue(undefined);
    render(<Harness onSave={onSave} />);
    await user.tab();
    expect(screen.getByText('Tests and lint pass')).toHaveFocus();
    await user.keyboard('{ArrowDown}');
    expect(screen.getByText('Changelog has a line')).toHaveFocus();
    await user.keyboard('{Alt>}{ArrowUp}{/Alt}');
    expect(onSave).toHaveBeenCalledWith([ITEMS[1], ITEMS[0], ITEMS[2]]);
    await waitFor(() => expect(lines()).toEqual([ITEMS[1], ITEMS[0], ITEMS[2]]));
    expect(screen.getByText('Changelog has a line')).toHaveFocus();
    expect(screen.getByText('Moved “Changelog has a line” to position 1 of 3.')).toBeInTheDocument();
    // At the top nothing moves.
    await user.keyboard('{Alt>}{ArrowUp}{/Alt}');
    expect(onSave).toHaveBeenCalledTimes(1);
  });

  it('rewords in place: Enter saves, Esc cancels, a duplicate is refused', async () => {
    const user = userEvent.setup();
    const onSave = vi.fn().mockResolvedValue(undefined);
    render(<Harness onSave={onSave} />);
    await user.click(screen.getByRole('button', { name: 'Edit “Changelog has a line”' }));
    const field = screen.getByLabelText('Reword “Changelog has a line”');
    expect(field).toHaveFocus();
    await user.clear(field);
    await user.type(field, 'tests and lint pass{Enter}');
    expect(screen.getByText('That item is already in the list.')).toBeVisible();
    expect(onSave).not.toHaveBeenCalled();
    await user.keyboard('{Escape}');
    expect(lines()).toEqual(ITEMS);

    screen.getByText('Changelog has a line').focus();
    await user.keyboard('e');
    const again = screen.getByLabelText('Reword “Changelog has a line”');
    await user.type(again, ' under Unreleased{Enter}');
    expect(onSave).toHaveBeenCalledWith([ITEMS[0], 'Changelog has a line under Unreleased', ITEMS[2]]);
    await waitFor(() => expect(screen.getByText('Changelog has a line under Unreleased')).toHaveFocus());
  });

  it('removes a line with its button or Delete, and Undo puts it back', async () => {
    const user = userEvent.setup();
    const onSave = vi.fn().mockResolvedValue(undefined);
    render(<Harness onSave={onSave} />);
    await user.click(screen.getByRole('button', { name: 'Remove “Changelog has a line”' }));
    expect(onSave).toHaveBeenCalledWith([ITEMS[0], ITEMS[2]]);
    const toast = await screen.findByText('Removed “Changelog has a line”');
    await user.click(
      within(toast.closest('[role="status"]') as HTMLElement).getByRole('button', { name: 'Undo' }),
    );
    expect(onSave).toHaveBeenLastCalledWith(ITEMS);
    await waitFor(() => expect(lines()).toEqual(ITEMS));

    screen.getByText('Docs updated when behaviour changes').focus();
    await user.keyboard('{Delete}');
    expect(onSave).toHaveBeenLastCalledWith([ITEMS[0], ITEMS[1]]);
  });

  it('shows a failed save and keeps the list as it was', async () => {
    const user = userEvent.setup();
    const onSave = vi
      .fn()
      .mockRejectedValue(new ORPCError('FORBIDDEN', { message: 'Only owners and admins can do that.' }));
    render(<Harness onSave={onSave} />);
    await user.click(screen.getByRole('button', { name: 'Remove “Tests and lint pass”' }));
    expect(await screen.findByRole('alert')).toHaveTextContent(
      "Couldn't remove “Tests and lint pass”. Only owners and admins can change the task defaults.",
    );
    expect(lines()).toEqual(ITEMS);
  });

  it('gives members the list without edits', () => {
    render(<Harness canEdit={false} />);
    expect(lines()).toEqual(ITEMS);
    expect(screen.queryByRole('button', { name: /^Edit/ })).toBeNull();
    expect(screen.queryByRole('button', { name: 'Add an item' })).toBeNull();
    expect(screen.getByText('Only owners and admins can change the defaults.')).toBeVisible();
  });

  it('says a mirrored project uses the defaults after the switch', () => {
    render(<TaskDefaultsView projectName="Harbor" items={[]} canEdit mirrored onChange={vi.fn()} />);
    expect(screen.getByRole('note')).toHaveTextContent(
      'Harbor copies its tasks from Backlog.md, so no task starts here yet. These items apply once it is switched to Zamu.',
    );
  });
});

describe('Task defaults list edits', () => {
  it('moves items one place or to a drop position', () => {
    expect(moveItem(['a', 'b', 'c'], 0, 1)).toEqual(['b', 'a', 'c']);
    expect(moveItem(['a', 'b', 'c'], 0, -1)).toEqual(['a', 'b', 'c']);
    expect(moveItem(['a', 'b', 'c'], 2, 1)).toEqual(['a', 'b', 'c']);
    expect(moveItemTo(['a', 'b', 'c'], 0, 2)).toEqual(['b', 'c', 'a']);
    expect(moveItemTo(['a', 'b', 'c'], 2, 0)).toEqual(['c', 'a', 'b']);
  });

  it('checks a line before it goes in', () => {
    expect(cleanItem('  Tests\npass ')).toBe('Tests pass');
    expect(itemError(['Tests pass'], '  ', null)).toBeNull();
    expect(itemError(['Tests pass'], 'tests PASS', null)).toBe('That item is already in the list.');
    expect(itemError(['Tests pass'], 'Tests pass', 0)).toBeNull();
    expect(itemError([], 'x'.repeat(501), null)).toBe('Keep it under 500 characters.');
    expect(
      itemError(
        Array.from({ length: 50 }, (_, i) => `item ${i}`),
        'one more',
        null,
      ),
    ).toBe('A project can have 50 default items at most.');
  });

  it('words the note on existing tasks and the failures', () => {
    expect(appliesText(0)).toBe(
      'Applies to tasks created from now on. Tasks that already exist keep the items they have.',
    );
    expect(appliesText(1)).toBe('Applies to tasks created from now on. 1 open task keeps the items it has.');
    expect(defaultsFailure(new Error('offline'))).toBe('Check your connection and try again.');
    expect(
      defaultsFailure(
        new ORPCError('BAD_REQUEST', {
          message: 'Invalid',
          data: { issues: [{ message: 'Use 50 items or fewer' }] },
        }),
      ),
    ).toBe('Use 50 items or fewer.');
  });
});

describe('Task defaults route', () => {
  it('has its own settings path', () => {
    expect(projectSettingsHref(asWorkspaceSlug('acme'), 'PAY', 'defaults')).toBe(
      '/w/acme/p/PAY/settings/defaults',
    );
    expect(settingsSection('/w/acme/p/PAY/settings/defaults/')).toBe('defaults');
    expect(settingsSection('/w/acme/p/PAY/settings/backlog')).toBe('backlog');
  });
});
