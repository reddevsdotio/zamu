import { act, screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { DisplayButton } from './DisplayOptions';
import { requestDisplayOptions } from './requests';
import { renderWithQuery, VIEWER, viewsWorkspace } from './testing';
import { displayStorageKey, resetDisplayOptionsForTests, useDisplayOptions } from './useDisplayOptions';

/** Shows the options a view reads, next to the Display button that changes them. */
function View({ projectKey, view }: { projectKey: string | null; view: 'list' | 'board' | 'home' }) {
  const [options, , , isDefault] = useDisplayOptions(projectKey, view);
  return (
    <output data-testid={`options-${view}`} data-default={isDefault}>
      {JSON.stringify({
        groupBy: options.groupBy,
        orderBy: options.orderBy,
        hideDone: options.hideDoneAfterDays,
        cards: options.boardSubtasks,
        milestone: options.properties.milestone,
        criteria: options.properties.criteria,
      })}
    </output>
  );
}

const read = (view: string) => JSON.parse(screen.getByTestId(`options-${view}`).textContent ?? '{}');

beforeEach(() => {
  localStorage.clear();
  resetDisplayOptionsForTests();
});

describe('display options', () => {
  it('starts from the view defaults and saves changes per user, project and view', async () => {
    const user = userEvent.setup();
    await renderWithQuery(
      <>
        <DisplayButton projectKey="HBR" view="board" />
        <View projectKey="HBR" view="board" />
        <View projectKey="HBR" view="list" />
      </>,
    );
    expect(read('board')).toEqual({
      groupBy: 'status',
      orderBy: 'priority',
      hideDone: 14,
      cards: 'expandable',
      milestone: false,
      criteria: false,
    });
    expect(screen.getByTestId('options-board')).toHaveAttribute('data-default', 'true');

    await user.click(screen.getByRole('button', { name: 'Display' }));
    const dialog = await screen.findByRole('dialog', { name: 'Display options' });
    expect(within(dialog).getByText('Saved for you on this board')).toBeInTheDocument();

    await user.click(within(dialog).getByRole('switch', { name: 'Show subtasks as cards' }));
    await user.click(within(dialog).getByRole('button', { name: 'Milestone', pressed: false }));
    await user.click(within(dialog).getByRole('button', { name: /Order by$/ }));
    await user.click(await screen.findByRole('option', { name: 'Due date' }));

    // The view behind follows at once; the list keeps its own options.
    expect(read('board')).toEqual({
      groupBy: 'status',
      orderBy: 'due',
      hideDone: 14,
      cards: 'cards',
      milestone: true,
      criteria: false,
    });
    expect(screen.getByTestId('options-board')).toHaveAttribute('data-default', 'false');
    expect(read('list')).toMatchObject({ orderBy: 'priority' });

    const stored = JSON.parse(
      localStorage.getItem(displayStorageKey(viewsWorkspace.id, VIEWER.id, 'HBR', 'board')) ?? 'null',
    );
    expect(stored).toMatchObject({ orderBy: 'due', boardSubtasks: 'cards', properties: { milestone: true } });
    expect(
      localStorage.getItem(`zamu:display:v2:${viewsWorkspace.id}:${VIEWER.id}:HBR:board`),
    ).not.toBeNull();
    expect(localStorage.getItem(displayStorageKey(viewsWorkspace.id, VIEWER.id, 'HBR', 'list'))).toBeNull();

    await user.click(within(dialog).getByRole('button', { name: 'Reset to default' }));
    expect(read('board')).toMatchObject({ orderBy: 'priority', cards: 'expandable', milestone: false });
    expect(localStorage.getItem(displayStorageKey(viewsWorkspace.id, VIEWER.id, 'HBR', 'board'))).toBeNull();
  });

  it('keys the options by workspace, person, project and view', () => {
    expect(displayStorageKey('acme-id', 'u-1', 'PAY', 'board')).toBe('zamu:display:v2:acme-id:u-1:PAY:board');
    expect(displayStorageKey('acme-id', 'u-1', null, 'home')).toBe('zamu:display:v2:acme-id:u-1:~home:home');
    expect(displayStorageKey('globex-id', 'u-1', 'PAY', 'board')).not.toBe(
      displayStorageKey('acme-id', 'u-1', 'PAY', 'board'),
    );
  });

  it('reads saved options back and keeps projects apart', async () => {
    localStorage.setItem(
      displayStorageKey(viewsWorkspace.id, VIEWER.id, 'PAY', 'list'),
      JSON.stringify({ groupBy: 'label', hideDoneAfterDays: 0, properties: { milestone: true } }),
    );
    await renderWithQuery(
      <>
        <View projectKey="PAY" view="list" />
        <View projectKey="HBR" view="board" />
      </>,
    );
    await waitFor(() =>
      expect(read('list')).toMatchObject({ groupBy: 'label', hideDone: 0, milestone: true }),
    );
    expect(read('board')).toMatchObject({ groupBy: 'status' });
  });

  it('ignores the same project in another workspace and options saved before 0.10', async () => {
    const saved = JSON.stringify({ groupBy: 'label', hideDoneAfterDays: 0, properties: {} });
    localStorage.setItem(displayStorageKey('globex-id', VIEWER.id, 'PAY', 'list'), saved);
    localStorage.setItem(`zamu:display:v1:${VIEWER.id}:PAY:list`, saved);
    await renderWithQuery(<View projectKey="PAY" view="list" />);
    await waitFor(() => expect(read('list')).toMatchObject({ groupBy: 'status' }));
  });

  it('shows the list wording and the subtasks choice on the list', async () => {
    const user = userEvent.setup();
    const onLayoutChange = vi.fn();
    await renderWithQuery(<DisplayButton projectKey="HBR" view="list" onLayoutChange={onLayoutChange} />);
    await user.click(screen.getByRole('button', { name: 'Display' }));
    const dialog = await screen.findByRole('dialog', { name: 'Display options' });
    expect(within(dialog).getByText('Saved for you on this list')).toBeInTheDocument();
    expect(within(dialog).getByText('Shown on rows')).toBeInTheDocument();
    expect(within(dialog).getByRole('button', { name: /Grouping$/ })).toHaveTextContent('Status');
    expect(within(dialog).getByRole('button', { name: 'Nested Subtasks' })).toBeInTheDocument();
    expect(within(dialog).queryByRole('button', { name: /Swimlanes$/ })).toBeNull();
    await user.click(within(dialog).getByRole('radio', { name: 'Board' }));
    expect(onLayoutChange).toHaveBeenCalledWith('board');
  });

  it('offers a Criteria chip after Subtasks, off by default, and saves it for the view', async () => {
    const user = userEvent.setup();
    await renderWithQuery(
      <>
        <DisplayButton projectKey="HBR" view="list" />
        <View projectKey="HBR" view="list" />
        <View projectKey="HBR" view="board" />
      </>,
    );
    await user.click(screen.getByRole('button', { name: 'Display' }));
    const dialog = await screen.findByRole('dialog', { name: 'Display options' });
    const chips = within(within(dialog).getByLabelText('Shown on rows')).getAllByRole('button');
    const names = chips.map((chip) => chip.textContent);
    expect(names.indexOf('Criteria')).toBe(names.indexOf('Subtasks') + 1);
    expect(names.indexOf('Due date')).toBe(names.indexOf('Criteria') + 1);

    const criteria = within(dialog).getByRole('button', { name: 'Criteria', pressed: false });
    await user.click(criteria);
    expect(within(dialog).getByRole('button', { name: 'Criteria', pressed: true })).toBeInTheDocument();
    expect(read('list')).toMatchObject({ criteria: true });
    expect(read('board')).toMatchObject({ criteria: false });
    const stored = JSON.parse(
      localStorage.getItem(displayStorageKey(viewsWorkspace.id, VIEWER.id, 'HBR', 'list')) ?? 'null',
    );
    expect(stored).toMatchObject({ properties: { criteria: true } });
  });

  it('opens from the palette', async () => {
    await renderWithQuery(<DisplayButton projectKey="HBR" view="board" />);
    act(() => requestDisplayOptions());
    expect(await screen.findByRole('dialog', { name: 'Display options' })).toBeInTheDocument();
  });
});
