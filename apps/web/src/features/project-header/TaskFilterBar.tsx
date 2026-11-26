import { useQuery } from '@tanstack/react-query';
import { FILTER_NONE, type Priority, type TaskStatus } from '@zamu/contracts';
import { useMemo } from 'react';
import { membersQuery } from '~/features/tasks/queries';
import type { BoardLanes, CycleFilterValue, TaskListSearch, TaskView } from '~/features/tasks/search';
import { PRIORITY_OPTIONS, STATUS_OPTIONS } from '~/features/tasks/TaskFields';
import { useApi } from '~/lib/workspace';
import {
  Button,
  CycleGlyph,
  isMilestoneFilled,
  MilestoneGlyph,
  NoneGlyph,
  type OptionItem,
  SegmentedControl,
  Select,
} from '~/ui';

// The M1–M4 filter row of a project's tasks: Status, Priority, Assignee, Milestone and Cycle (when the
// project uses them), Lanes (board only), Removed from Backlog.md. Plus the List / Board switch.
// Retired from the list in M5 (it uses FilterButton and FilterChips from features/views); the board
// keeps it until its M5 screen lands, then M5-18 removes the row and keeps ViewSwitch.

const ANY = 'any';
const HIDDEN_OFF = 'hidden';

export interface TaskFilterBarProps {
  projectKey: string;
  search: TaskListSearch;
  /** Applies a change to the URL search. */
  onChange: (update: (previous: TaskListSearch) => TaskListSearch) => void;
  /** Project feature switches. */
  usesMilestones: boolean;
  usesCycles: boolean;
  /** Shows the Lanes filter. */
  showLanes?: boolean;
  /**
   * Mirrored projects, list only: the number of tasks removed from Backlog.md. Shows the "Removed from
   * Backlog.md" filter (Hidden · 9 / 9 shown).
   */
  hiddenCount?: number;
}

/** The filter Selects, for ProjectHeader's `filters` slot. */
export function TaskFilterBar({
  projectKey,
  search,
  onChange,
  usesMilestones,
  usesCycles,
  showLanes = false,
  hiddenCount,
}: TaskFilterBarProps) {
  const api = useApi();
  const members = useQuery(membersQuery(api)).data?.items;
  const milestones = useQuery({
    ...api.orpc.milestones.list.queryOptions({ input: { project: projectKey } }),
    enabled: usesMilestones,
  }).data?.items;
  const cycles = useQuery({
    ...api.orpc.cycles.list.queryOptions({ input: { project: projectKey } }),
    enabled: usesCycles,
  }).data?.items;

  const assigneeItems = useMemo<OptionItem[]>(
    () => [
      { id: ANY, label: 'Any' },
      { id: 'me', label: 'Me' },
      { id: 'agents', label: 'Agents' },
      ...(members ?? []).map((member) => ({
        id: member.id,
        label: member.name,
        avatar: { name: member.name, kind: member.kind },
      })),
    ],
    [members],
  );

  const milestoneItems = useMemo<OptionItem[]>(() => {
    const items: OptionItem[] = [
      { id: ANY, label: 'Any' },
      { id: FILTER_NONE, label: 'No milestone', prefix: <NoneGlyph /> },
      ...(milestones ?? []).map((milestone) => ({
        id: milestone.id,
        label: milestone.name,
        prefix: <MilestoneGlyph filled={isMilestoneFilled(milestone.status)} />,
      })),
    ];
    // A milestone id from a link that is not in the list (deleted, other project) still shows.
    if (search.milestone && !items.some((item) => item.id === search.milestone)) {
      items.push({ id: search.milestone, label: 'Unknown milestone' });
    }
    return items;
  }, [milestones, search.milestone]);

  const cycleItems = useMemo<OptionItem[]>(() => {
    const items: OptionItem[] = [
      { id: ANY, label: 'Any' },
      { id: 'current', label: 'Current', prefix: <CycleGlyph state="progress" /> },
      { id: 'next', label: 'Next', prefix: <CycleGlyph /> },
      { id: FILTER_NONE, label: 'No cycle', prefix: <NoneGlyph shape="circle" /> },
      ...[...(cycles ?? [])]
        .sort((a, b) => b.number - a.number)
        .map((cycle) => ({
          id: String(cycle.number),
          label: `Cycle ${cycle.number}`,
          ...(cycle.name ? { description: cycle.name } : {}),
          prefix: (
            <CycleGlyph
              state={cycle.state === 'completed' ? 'done' : cycle.state === 'current' ? 'progress' : 'empty'}
            />
          ),
        })),
    ];
    if (typeof search.cycle === 'number' && !items.some((item) => item.id === String(search.cycle))) {
      items.push({ id: String(search.cycle), label: `Cycle ${search.cycle}` });
    }
    return items;
  }, [cycles, search.cycle]);

  const laneItems = useMemo<OptionItem[]>(
    () => [
      { id: 'none', label: 'None' },
      { id: 'assignee', label: 'Assignee' },
      ...(usesMilestones ? [{ id: 'milestone', label: 'Milestone' }] : []),
    ],
    [usesMilestones],
  );

  const hiddenItems = useMemo<OptionItem[]>(
    () => [
      { id: HIDDEN_OFF, label: `Hidden · ${hiddenCount ?? 0}` },
      { id: 'only', label: `${hiddenCount ?? 0} shown` },
    ],
    [hiddenCount],
  );

  return (
    <>
      <Select
        label="Status"
        variant="filter"
        selectionMode="multiple"
        items={STATUS_OPTIONS}
        value={search.status ?? []}
        onChange={(keys) =>
          onChange((previous) => ({
            ...previous,
            status: keys.length ? (keys.map(String) as TaskStatus[]) : undefined,
          }))
        }
      />
      <Select
        label="Priority"
        variant="filter"
        selectionMode="multiple"
        items={PRIORITY_OPTIONS}
        value={search.priority ?? []}
        onChange={(keys) =>
          onChange((previous) => ({
            ...previous,
            priority: keys.length ? (keys.map(String) as Priority[]) : undefined,
          }))
        }
      />
      <Select
        label="Assignee"
        variant="filter"
        items={assigneeItems}
        value={search.assignee ?? ANY}
        onChange={(key) =>
          onChange((previous) => ({
            ...previous,
            assignee: key == null || key === ANY ? undefined : String(key),
          }))
        }
      />
      {usesMilestones ? (
        <Select
          label="Milestone"
          variant="filter"
          items={milestoneItems}
          value={search.milestone ?? ANY}
          onChange={(key) =>
            onChange((previous) => ({
              ...previous,
              milestone: key == null || key === ANY ? undefined : String(key),
            }))
          }
        />
      ) : null}
      {usesCycles ? (
        <Select
          label="Cycle"
          variant="filter"
          items={cycleItems}
          value={search.cycle === undefined ? ANY : String(search.cycle)}
          onChange={(key) =>
            onChange((previous) => ({ ...previous, cycle: toCycleFilter(key == null ? ANY : String(key)) }))
          }
        />
      ) : null}
      {hiddenCount != null ? (
        <Select
          label="Removed from Backlog.md"
          variant="filter"
          items={hiddenItems}
          value={search.hidden ?? HIDDEN_OFF}
          onChange={(key) =>
            onChange((previous) =>
              key === 'only'
                ? { ...previous, hidden: 'only', status: undefined }
                : { ...previous, hidden: undefined },
            )
          }
        />
      ) : null}
      {showLanes ? (
        <Select
          label="Lanes"
          variant="filter"
          items={laneItems}
          value={search.lanes && (search.lanes !== 'milestone' || usesMilestones) ? search.lanes : 'none'}
          onChange={(key) =>
            onChange((previous) => ({
              ...previous,
              lanes: key === 'assignee' || key === 'milestone' ? (key as BoardLanes) : undefined,
            }))
          }
        />
      ) : null}
    </>
  );
}

function toCycleFilter(id: string): CycleFilterValue | undefined {
  if (id === ANY) return undefined;
  if (id === 'current' || id === 'next' || id === FILTER_NONE) return id;
  const number = Number(id);
  return Number.isInteger(number) && number > 0 ? number : undefined;
}

export interface ViewSwitchProps {
  view: TaskView;
  onChange: (view: TaskView) => void;
  /** Shows "Clear" before the switch when filters are set. */
  onClear?: () => void;
}

const VIEW_ITEMS = [
  { id: 'list', label: 'List' },
  { id: 'board', label: 'Board' },
] as const;

/**
 * The List / Board switch (the view header's switch slot), with Clear before it when filters are set. The
 * page binds V itself; the hint is in the shortcut list, not on the switch (shortcuts.md).
 */
export function ViewSwitch({ view, onChange, onClear }: ViewSwitchProps) {
  return (
    <span className="flex items-center gap-2">
      {onClear ? (
        <Button variant="ghost" size="sm" className="px-0 font-normal" onPress={onClear}>
          Clear
        </Button>
      ) : null}
      <SegmentedControl<TaskView> aria-label="View" items={VIEW_ITEMS} value={view} onChange={onChange} />
    </span>
  );
}
