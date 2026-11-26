import { useMemo } from 'react';
import { type Command, useRegisterCommands } from '~/features/palette/registry';
import { useHotkeys } from '~/ui';
import type { ViewLayout } from './display-options';
import type { FilterFieldConfig } from './filter-fields';
import { clearedFilter, type FilterField, hasTaskFilter, type TaskFilter } from './filters';
import { requestDisplayOptions, requestFilterMenu } from './requests';

// The view's palette commands (section "view"): Switch to board / list (V), Display options,
// Filter…, Filter by <field>…, Clear filters, and (M7) Hide archived tasks while they are shown ("Show
// archived tasks in <project>" is the shell's). Mounted by the list, the board and Home.

export interface UseViewCommandsOptions {
  /** The current layout; omit on Home (no switch). */
  layout?: ViewLayout;
  onLayoutChange?: (layout: ViewLayout) => void;
  /** Filter fields offered here (for "Filter by …"). */
  fields?: readonly FilterFieldConfig[];
  filter?: TaskFilter;
  onFilterChange?: (filter: TaskFilter) => void;
  /** Also bind V to the layout switch (default true). */
  hotkeys?: boolean;
}

const FILTER_COMMAND_TITLES: Record<FilterField, string> = {
  status: 'Filter by status…',
  priority: 'Filter by priority…',
  assignee: 'Filter by assignee…',
  label: 'Filter by label…',
  due: 'Filter by due date…',
  blocked: 'Filter blocked tasks…',
  milestone: 'Filter by milestone…',
  cycle: 'Filter by cycle…',
  checkAgain: 'Filter by check-again day…',
  archived: 'Filter archived tasks…',
};

/** The palette closes first; open the popover once focus has gone back to the page. */
const later = (open: () => void) => () => {
  setTimeout(open, 0);
  return undefined;
};

export function useViewCommands({
  layout,
  onLayoutChange,
  fields = [],
  filter,
  onFilterChange,
  hotkeys = true,
}: UseViewCommandsOptions) {
  const filtered = filter ? hasTaskFilter(filter) : false;
  const commands = useMemo<Command[]>(() => {
    const list: Command[] = [];
    if (layout && onLayoutChange) {
      const other: ViewLayout = layout === 'list' ? 'board' : 'list';
      list.push({
        id: 'view.toggle-layout',
        title: other === 'board' ? 'Switch to board' : 'Switch to list',
        section: 'view',
        keywords: ['layout', 'view', 'list', 'board'],
        shortcut: 'v',
        run: () => {
          onLayoutChange(other);
          return undefined;
        },
      });
    }
    list.push({
      id: 'view.display',
      title: 'Display options',
      section: 'view',
      keywords: ['group', 'order', 'sort', 'properties', 'columns', 'swimlanes'],
      run: later(() => requestDisplayOptions()),
    });
    if (fields.length) {
      list.push({
        id: 'view.filter',
        title: 'Filter…',
        section: 'view',
        keywords: ['filter'],
        run: later(() => requestFilterMenu()),
      });
      for (const config of fields) {
        list.push({
          id: `view.filter.${config.field}`,
          title: FILTER_COMMAND_TITLES[config.field],
          section: 'view',
          keywords: ['filter', config.label.toLowerCase()],
          run: later(() => requestFilterMenu(config.field)),
        });
      }
    }
    if (filter?.archived && onFilterChange) {
      const { archived: _archived, ...rest } = filter;
      list.push({
        id: 'view.hide-archived',
        title: 'Hide archived tasks',
        section: 'view',
        keywords: ['archive', 'archived', 'filter'],
        run: () => {
          onFilterChange(rest);
          return undefined;
        },
      });
    }
    if (filtered && filter && onFilterChange) {
      list.push({
        id: 'view.clear-filters',
        title: 'Clear filters',
        section: 'view',
        keywords: ['filter', 'reset'],
        run: () => {
          onFilterChange(clearedFilter(filter));
          return undefined;
        },
      });
    }
    return list;
  }, [layout, onLayoutChange, fields, filtered, filter, onFilterChange]);

  useRegisterCommands(commands);
  useHotkeys(
    { v: layout && onLayoutChange ? () => onLayoutChange(layout === 'list' ? 'board' : 'list') : null },
    { enabled: hotkeys },
  );
}
