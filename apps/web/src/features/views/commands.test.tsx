import { act, render, screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { useState } from 'react';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { resetPaletteForTests, useRegisteredCommands } from '~/features/palette/registry';
import { useViewCommands } from './commands';
import type { ViewLayout } from './display-options';
import { FilterButton } from './FilterMenu';
import { buildFilterFields } from './filter-fields';
import type { TaskFilter } from './filters';
import { LABELS } from './testing';

const fields = buildFilterFields({ scopeName: 'Harbor', labels: LABELS });

function View() {
  const [layout, setLayout] = useState<ViewLayout>('list');
  const [filter, setFilter] = useState<TaskFilter>({ label: [LABELS[0]?.id ?? ''] });
  useViewCommands({ layout, onLayoutChange: setLayout, fields, filter, onFilterChange: setFilter });
  return (
    <>
      <FilterButton fields={fields} filter={filter} onChange={setFilter} />
      <output data-testid="state">
        {layout}:{JSON.stringify(filter)}
      </output>
    </>
  );
}

function Palette() {
  const commands = useRegisteredCommands();
  return (
    <ul>
      {commands.map((command) => (
        <li key={command.id}>
          <button type="button" onClick={() => void command.run()}>
            {command.title}
          </button>
        </li>
      ))}
    </ul>
  );
}

afterEach(() => resetPaletteForTests());

describe('view commands', () => {
  it('registers the layout switch, display options and filters', async () => {
    const user = userEvent.setup();
    render(
      <>
        <View />
        <Palette />
      </>,
    );
    expect(screen.getAllByRole('button').map((button) => button.textContent)).toEqual([
      'Filter',
      'Switch to board',
      'Display options',
      'Filter…',
      'Filter by status…',
      'Filter by priority…',
      'Filter by assignee…',
      'Filter by label…',
      'Filter by due date…',
      'Filter blocked tasks…',
      'Filter by check-again day…',
      'Filter archived tasks…',
      'Clear filters',
    ]);
    await user.click(screen.getByRole('button', { name: 'Switch to board' }));
    expect(screen.getByTestId('state')).toHaveTextContent('board:');
    // V switches back.
    await user.keyboard('v');
    expect(screen.getByTestId('state')).toHaveTextContent('list:');

    vi.useFakeTimers({ shouldAdvanceTime: true });
    await user.click(screen.getByRole('button', { name: 'Filter by label…' }));
    act(() => vi.runAllTimers());
    vi.useRealTimers();
    expect(await screen.findByRole('menu', { name: 'Labels' })).toBeInTheDocument();
  });

  it('clears filters from the palette', async () => {
    const user = userEvent.setup();
    render(
      <>
        <View />
        <Palette />
      </>,
    );
    await user.click(screen.getByRole('button', { name: 'Clear filters' }));
    expect(screen.getByTestId('state')).toHaveTextContent('list:{}');
    expect(screen.queryByRole('button', { name: 'Clear filters' })).toBeNull();
  });
});
