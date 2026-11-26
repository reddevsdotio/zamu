import { QueryClientProvider } from '@tanstack/react-query';
import {
  createMemoryHistory,
  createRootRoute,
  createRoute,
  createRouter,
  RouterProvider,
} from '@tanstack/react-router';
import { act, render, screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { useState } from 'react';
import { describe, expect, it } from 'vitest';
import { FilterButton, FilterChips } from './FilterMenu';
import { buildFilterFields, useProjectFilterFields } from './filter-fields';
import type { TaskFilter } from './filters';
import { requestFilterMenu } from './requests';
import { inWorkspace, LABELS, newQueryClient, renderWithQuery } from './testing';
import { useUrlTaskFilter } from './useUrlTaskFilter';

const [FRONTEND, BACKEND, MOBILE] = LABELS.map((label) => label.id) as [string, string, string];

const fields = buildFilterFields({
  scopeName: 'Harbor',
  labels: LABELS,
  members: [
    {
      id: '9f0c0a52-0000-4000-8000-000000000003',
      name: 'claude-dev',
      kind: 'agent',
      responsible: { name: 'Ana Ruiz' },
    },
  ],
  milestones: [],
  cycles: [],
});

function Harness({ initial = {}, chips = true }: { initial?: TaskFilter; chips?: boolean }) {
  const [filter, setFilter] = useState<TaskFilter>(initial);
  return (
    <div>
      <FilterButton fields={fields} filter={filter} onChange={setFilter} />
      {chips ? (
        <FilterChips fields={fields} filter={filter} onChange={setFilter} matchCount={21} total={123} />
      ) : null}
      <output data-testid="filter">{JSON.stringify(filter)}</output>
    </div>
  );
}

/** The project fields as plain data. */
function Fields() {
  const configs = useProjectFilterFields('HBR', { projectName: 'Harbor' });
  const labels = configs.find((config) => config.field === 'label');
  const assignee = configs.find((config) => config.field === 'assignee');
  return (
    <output data-testid="fields">
      {JSON.stringify({
        fields: configs.map((config) => config.field),
        title: labels?.title,
        labels: labels?.options.map((option) => option.label),
        assignees: assignee?.options.map((option) => option.label),
      })}
    </output>
  );
}

/** A view reading its filter from the URL. */
function Screen() {
  const [filter, setFilter] = useUrlTaskFilter();
  return (
    <div>
      <FilterButton fields={fields} filter={filter} onChange={setFilter} />
      <FilterChips fields={fields} filter={filter} onChange={setFilter} />
      <output data-testid="filter">{JSON.stringify(filter)}</output>
    </div>
  );
}

const current = () => JSON.parse(screen.getByTestId('filter').textContent ?? '{}') as TaskFilter;

describe('filter menu', () => {
  it('lists the fields and narrows them as you type', async () => {
    const user = userEvent.setup();
    render(<Harness />);
    await user.click(screen.getByRole('button', { name: 'Filter' }));
    const menu = screen.getByRole('menu', { name: 'Filter' });
    expect(
      within(menu)
        .getAllByRole('menuitem')
        .map((item) => item.textContent?.replace('›', '')),
    ).toEqual(['Status', 'Priority', 'Assignee', 'Labels', 'Due date', 'Blocked', 'Milestone', 'Cycle']);
    expect(screen.getByRole('searchbox', { name: 'Filter by' })).toHaveFocus();
    await user.keyboard('lab');
    expect(
      within(menu)
        .getAllByRole('menuitem')
        .map((item) => item.textContent?.replace('›', '')),
    ).toEqual(['Labels']);
  });

  it('opens a field with the keyboard, toggles values, goes back with Esc', async () => {
    const user = userEvent.setup();
    render(<Harness chips={false} />);
    await user.click(screen.getByRole('button', { name: 'Filter' }));
    await user.keyboard('lab{ArrowDown}{Enter}');
    const labels = await screen.findByRole('menu', { name: 'Labels' });
    expect(within(labels).getByText('Labels in Harbor')).toBeInTheDocument();
    await waitFor(() => expect(screen.getByRole('searchbox', { name: 'Labels' })).toHaveFocus());

    // Enter toggles the highlighted label and keeps the menu open.
    await user.keyboard('front{Enter}');
    expect(current()).toEqual({ label: [FRONTEND] });
    await user.keyboard('{Backspace>5/}mob{Enter}');
    expect(current()).toEqual({ label: [FRONTEND, MOBILE] });
    expect(screen.getByText('2 selected')).toBeInTheDocument();

    // Esc clears the search, then goes back to the fields, then closes.
    await user.keyboard('{Escape}');
    expect(screen.getByRole('searchbox', { name: 'Labels' })).toHaveValue('');
    await user.keyboard('{Escape}');
    await waitFor(() => expect(screen.queryByRole('menu', { name: 'Labels' })).toBeNull());
    expect(screen.getByRole('menu', { name: 'Filter' })).toBeInTheDocument();
    await waitFor(() => expect(screen.getByRole('searchbox', { name: 'Filter by' })).toHaveFocus());
    await user.keyboard('{Escape}{Escape}');
    await waitFor(() => expect(screen.queryByRole('menu', { name: 'Filter' })).toBeNull());
    expect(current()).toEqual({ label: [FRONTEND, MOBILE] });
  });

  it('picks one value for due date and closes', async () => {
    const user = userEvent.setup();
    render(<Harness />);
    await user.click(screen.getByRole('button', { name: 'Filter' }));
    await user.keyboard('due{ArrowDown}{ArrowRight}');
    await screen.findByRole('menu', { name: 'Due date' });
    await user.click(screen.getByRole('menuitemradio', { name: /Overdue/ }));
    expect(current()).toEqual({ due: 'overdue' });
    await waitFor(() => expect(screen.queryByRole('menu', { name: 'Filter' })).toBeNull());
  });

  it('opens straight into a field from the palette', async () => {
    render(<Harness />);
    act(() => requestFilterMenu('label'));
    expect(await screen.findByRole('menu', { name: 'Labels' })).toBeInTheDocument();
  });
});

describe('filter chips', () => {
  it('draws a chip per field with the count and Clear', async () => {
    render(
      <Harness
        initial={{ label: [FRONTEND, BACKEND, MOBILE], assignee: ['9f0c0a52-0000-4000-8000-000000000003'] }}
      />,
    );
    const row = screen.getByRole('toolbar', { name: 'Filters' });
    expect(
      within(row).getByRole('button', { name: 'Labels is any of 3 labels. Change' }),
    ).toBeInTheDocument();
    expect(within(row).getByRole('button', { name: 'Assignee is claude-dev. Change' })).toBeInTheDocument();
    expect(within(row).getByText('21 of 123 tasks')).toBeInTheDocument();
  });

  it('removes one field with its ×, and every field with Clear (the search stays)', async () => {
    const user = userEvent.setup();
    render(<Harness initial={{ label: [BACKEND], due: 'overdue', q: 'export' }} />);
    expect(screen.getByRole('button', { name: 'Labels is backend. Change' })).toBeInTheDocument();
    await user.click(screen.getByRole('button', { name: 'Remove the labels filter' }));
    expect(current()).toEqual({ due: 'overdue', q: 'export' });
    await user.click(screen.getByRole('button', { name: 'Clear' }));
    expect(current()).toEqual({ q: 'export' });
    expect(screen.queryByRole('toolbar', { name: 'Filters' })).toBeNull();
  });

  it('changes a field from its chip', async () => {
    const user = userEvent.setup();
    render(<Harness initial={{ label: [BACKEND] }} />);
    await user.click(screen.getByRole('button', { name: 'Labels is backend. Change' }));
    const menu = await screen.findByRole('menu', { name: /Labels/ });
    await user.click(within(menu).getByRole('menuitemcheckbox', { name: /mobile/ }));
    expect(current()).toEqual({ label: [BACKEND, MOBILE] });
    // The chip behind the open picker follows.
    expect(
      screen.getByRole('button', { name: 'Labels is any of 2 labels. Change', hidden: true }),
    ).toBeInTheDocument();
  });
});

describe('project filter fields', () => {
  it('builds the fields from the project data', async () => {
    await renderWithQuery(<Fields />);
    await waitFor(() =>
      expect(JSON.parse(screen.getByTestId('fields').textContent ?? '{}')).toEqual({
        fields: ['status', 'priority', 'assignee', 'label', 'due', 'blocked', 'milestone', 'cycle'],
        title: 'Labels in Harbor',
        labels: ['backend', 'frontend', 'i18n', 'mobile', 'security'],
        // The viewer is "Me"; other people, then agents.
        assignees: ['Me', 'No assignee', 'Any agent', 'Tomás Ferreira', 'claude-dev'],
      }),
    );
  });
});

describe('filters in the URL', () => {
  it('reads the filter from the URL and writes changes back, keeping other params', async () => {
    const user = userEvent.setup();
    const root = createRootRoute();
    const project = createRoute({
      getParentRoute: () => root,
      path: '/w/$workspace/p/$projectKey',
      component: Screen,
    });
    const history = createMemoryHistory({
      initialEntries: [`/w/acme/p/HBR?view=board&task=HBR-4&label=${BACKEND}&due=overdue`],
    });
    const router = createRouter({ routeTree: root.addChildren([project]), history });
    render(
      <QueryClientProvider client={newQueryClient()}>
        {inWorkspace(<RouterProvider router={router} />)}
      </QueryClientProvider>,
    );
    await waitFor(() => expect(current()).toEqual({ label: [BACKEND], due: 'overdue' }));

    await user.click(screen.getByRole('button', { name: 'Remove the due date filter' }));
    await waitFor(() => expect(current()).toEqual({ label: [BACKEND] }));
    await user.click(screen.getByRole('button', { name: 'Filter' }));
    await user.keyboard('lab{ArrowDown}{Enter}');
    await screen.findByRole('menu', { name: 'Labels' });
    await user.keyboard('mob{Enter}');
    await waitFor(() => expect(current()).toEqual({ label: [BACKEND, MOBILE] }));

    const url = new URL(router.state.location.href, 'http://localhost');
    expect(url.searchParams.get('view')).toBe('board');
    expect(url.searchParams.get('task')).toBe('HBR-4');
    expect(url.searchParams.get('label')).toBe(`${BACKEND},${MOBILE}`);
    expect(url.searchParams.has('due')).toBe(false);
  });
});
