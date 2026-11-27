import { useRouter } from '@tanstack/react-router';
import { type ReactNode, useState } from 'react';
import {
  Button as AriaButton,
  Dialog as AriaDialog,
  Select as AriaSelect,
  DialogTrigger,
  SelectValue,
  ToggleButton,
  ToggleButtonGroup,
} from 'react-aria-components';
import {
  Button,
  CaretGlyph,
  cn,
  ListBox,
  type OptionItem,
  OptionRow,
  Popover,
  SegmentedControl,
  Switch,
} from '~/ui';
import {
  type BoardSubtasks,
  type DisplayOptions,
  GROUP_BY_LABELS,
  type GroupBy,
  HIDE_DONE_CHOICES,
  hideDoneLabel,
  LIST_SUBTASK_LABELS,
  LIST_SUBTASKS,
  type ListSubtasks,
  ORDER_BY_LABELS,
  ORDER_BYS,
  type OrderBy,
  PROPERTY_LABELS,
  TASK_PROPERTIES,
  type TaskProperty,
  type TaskViewName,
  type ViewLayout,
  WAITING_TASK_LABELS,
  WAITING_TASKS,
  type WaitingTasks,
} from './display-options';
import { useViewRequests } from './requests';
import { useDisplayOptions } from './useDisplayOptions';
import { useUrlTaskFilter } from './useUrlTaskFilter';

// Display options popover (frame 045; components.md "Display options"; margin.css .pop-sec,
// .pop-row, .selb, .tgl, .tg, .pop-foot). Changes apply at once and are saved for the person on
// this view ("Saved for you on this board"). M7 (frame 101): the "Pull request" and "Check again"
// chips, and "Waiting tasks" and "Archived tasks" under them. "Archived tasks" is the Archived filter
// (archived=only in the URL), not a stored option: Shown here and the filter chip are one switch.
//
//   <DisplayButton projectKey view …>   the header's Display slot: button + popover, wired to storage
//   <DisplayOptionsPanel …>             the panel alone, controlled (tests, other hosts)

const PANEL_WIDTH = 356;

export interface DisplayOptionsPanelProps {
  view: TaskViewName;
  options: DisplayOptions;
  onChange: (options: Partial<DisplayOptions>) => void;
  /** "Reset to default". Always offered, as in frame 045; a no-op on the defaults. */
  onReset: () => void;
  /** The Layout switch: the screen navigates to the other view. Omit to hide the switch. */
  onLayoutChange?: (layout: ViewLayout) => void;
  /** Grouping choices; leave out milestone and cycle when the project doesn't use them. */
  groupChoices?: readonly GroupBy[];
  /** M7 "Archived tasks": Hidden or Shown (the Archived filter). Omit to leave the row out (Home). */
  archived?: { shown: boolean; onChange: (shown: boolean) => void };
  /**
   * M8: a grouping only this page has, listed first ("Wave" on a milestone page). The page holds its
   * state: picking it calls onChange(true); picking a stored grouping calls onChange(false) first.
   */
  pageGrouping?: PageGrouping;
}

/** A grouping a page adds to the stored ones (M8: "Wave" on a milestone page). */
export interface PageGrouping {
  id: string;
  label: string;
  active: boolean;
  onChange: (active: boolean) => void;
}

export type ArchivedChoice = 'hidden' | 'shown';
const ARCHIVED_ITEMS: OptionItem[] = [
  { id: 'hidden', label: 'Hidden' },
  { id: 'shown', label: 'Shown' },
];

/** Compact select (.selb): 28px, at least 132px wide, value then ▾. */
function DisplaySelect<K extends string>({
  label,
  value,
  items,
  onChange,
}: {
  label: string;
  value: K;
  items: readonly OptionItem[];
  onChange: (value: K) => void;
}) {
  return (
    <AriaSelect
      aria-label={label}
      selectedKey={value}
      onSelectionChange={(key) => {
        if (key != null && key !== value) onChange(String(key) as K);
      }}
      className="inline-flex"
    >
      <AriaButton className="inline-flex h-7 min-w-33 cursor-pointer items-center gap-2 rounded-sm border border-line bg-bg pr-2.25 pl-2.75 text-sm font-medium text-fg outline-none hover:border-fg-3 focus-visible:shadow-[var(--focus-ring)] aria-expanded:border-accent">
        <SelectValue className="min-w-0 flex-1 truncate text-left">
          {({ selectedText }) => selectedText}
        </SelectValue>
        <CaretGlyph />
      </AriaButton>
      <Popover placement="bottom end">
        <ListBox items={items}>{(item) => <OptionRow item={item} />}</ListBox>
      </Popover>
    </AriaSelect>
  );
}

function Row({ label, children }: { label: ReactNode; children: ReactNode }) {
  return (
    <div className="flex min-h-8 items-center gap-2.5">
      <span className="flex-1 text-fg-2">{label}</span>
      {children}
    </div>
  );
}

function Section({ children, title }: { children: ReactNode; title?: string }) {
  return (
    <div className="flex flex-col gap-1 border-b border-line-soft px-3 py-2.5 last:border-b-0">
      {title ? <div className="pt-0.5 pb-1 text-xs font-medium text-fg-3">{title}</div> : null}
      {children}
    </div>
  );
}

const options = <K extends string>(ids: readonly K[], labels: Record<K, string>): OptionItem[] =>
  ids.map((id) => ({ id, label: labels[id] }));

/** The panel: layout, grouping, order, subtasks, empty groups, hide done, properties, Reset. */
export function DisplayOptionsPanel({
  view,
  options: value,
  onChange,
  onReset,
  onLayoutChange,
  groupChoices = ['status', 'priority', 'assignee', 'milestone', 'cycle', 'label', 'none'],
  archived,
  pageGrouping,
}: DisplayOptionsPanelProps) {
  const board = view === 'board';
  const groupItems = [
    ...(pageGrouping && !board ? [{ id: pageGrouping.id, label: pageGrouping.label }] : []),
    ...options(groupChoices, GROUP_BY_LABELS),
  ];
  const groupValue = pageGrouping?.active && !board ? pageGrouping.id : value.groupBy;
  const laneItems = options(
    groupChoices.filter((choice) => choice === 'none' || choice !== value.groupBy),
    GROUP_BY_LABELS,
  );
  const noun = board ? 'cards' : 'rows';
  const place = view === 'home' ? 'on Home' : board ? 'on this board' : 'on this list';
  return (
    <div className="flex flex-col text-sm text-fg" style={{ width: PANEL_WIDTH }}>
      <Section>
        {view !== 'home' && onLayoutChange ? (
          <Row label="Layout">
            <SegmentedControl<ViewLayout>
              aria-label="Layout"
              items={[
                { id: 'list', label: 'List' },
                { id: 'board', label: 'Board' },
              ]}
              value={value.layout}
              onChange={onLayoutChange}
            />
          </Row>
        ) : null}
        {view !== 'home' ? (
          <Row label={board ? 'Columns' : 'Grouping'}>
            <DisplaySelect<string>
              label={board ? 'Columns' : 'Grouping'}
              value={groupValue}
              items={groupItems}
              onChange={(choice) => {
                if (pageGrouping && choice === pageGrouping.id) {
                  pageGrouping.onChange(true);
                  return;
                }
                pageGrouping?.onChange(false);
                const groupBy = choice as GroupBy;
                if (groupBy === value.groupBy) return;
                onChange({ groupBy, ...(groupBy === value.swimlanes ? { swimlanes: 'none' } : {}) });
              }}
            />
          </Row>
        ) : null}
        {board ? (
          <Row label="Swimlanes">
            <DisplaySelect<GroupBy>
              label="Swimlanes"
              value={value.swimlanes}
              items={laneItems}
              onChange={(swimlanes) => onChange({ swimlanes })}
            />
          </Row>
        ) : null}
        <Row label="Order by">
          <DisplaySelect<OrderBy>
            label="Order by"
            value={value.orderBy}
            items={options(ORDER_BYS, ORDER_BY_LABELS)}
            onChange={(orderBy) => onChange({ orderBy })}
          />
        </Row>
      </Section>
      <Section>
        {board ? (
          <Row label="Show subtasks as cards">
            <Switch
              aria-label="Show subtasks as cards"
              isSelected={value.boardSubtasks === 'cards'}
              onChange={(on) =>
                onChange({ boardSubtasks: (on ? 'cards' : 'expandable') satisfies BoardSubtasks })
              }
            />
          </Row>
        ) : (
          <Row label="Subtasks">
            <DisplaySelect<ListSubtasks>
              label="Subtasks"
              value={value.listSubtasks}
              items={options(LIST_SUBTASKS, LIST_SUBTASK_LABELS)}
              onChange={(listSubtasks) => onChange({ listSubtasks })}
            />
          </Row>
        )}
        {view !== 'home' ? (
          <Row label={board ? 'Show empty columns' : 'Show empty groups'}>
            <Switch
              aria-label={board ? 'Show empty columns' : 'Show empty groups'}
              isSelected={value.showEmptyGroups}
              onChange={(showEmptyGroups) => onChange({ showEmptyGroups })}
            />
          </Row>
        ) : null}
        <Row label="Hide done tasks after">
          <DisplaySelect<string>
            label="Hide done tasks after"
            value={String(value.hideDoneAfterDays)}
            items={HIDE_DONE_CHOICES.map((days) => ({ id: String(days), label: hideDoneLabel(days) }))}
            onChange={(days) => onChange({ hideDoneAfterDays: Number(days) })}
          />
        </Row>
      </Section>
      <Section title={`Shown on ${noun}`}>
        <ToggleButtonGroup
          aria-label={`Shown on ${noun}`}
          selectionMode="multiple"
          selectedKeys={TASK_PROPERTIES.filter((property) => value.properties[property])}
          onSelectionChange={(keys) =>
            onChange({
              properties: Object.fromEntries(
                TASK_PROPERTIES.map((property) => [property, keys.has(property)]),
              ) as Record<TaskProperty, boolean>,
            })
          }
          className="flex flex-wrap gap-1.5"
        >
          {TASK_PROPERTIES.map((property) => (
            <ToggleButton
              key={property}
              id={property}
              className={({ isSelected }) =>
                cn(
                  'inline-flex h-6.5 cursor-pointer items-center rounded-pill border px-2.5 text-sm font-medium outline-none select-none',
                  'focus-visible:shadow-[var(--focus-ring)]',
                  isSelected
                    ? 'border-transparent bg-accent-soft text-fg'
                    : 'border-line text-fg-3 hover:border-fg-3 hover:text-fg-2',
                )
              }
            >
              {PROPERTY_LABELS[property]}
            </ToggleButton>
          ))}
        </ToggleButtonGroup>
      </Section>
      {view !== 'home' || archived ? (
        <Section>
          {view !== 'home' ? (
            <Row label="Waiting tasks">
              <DisplaySelect<WaitingTasks>
                label="Waiting tasks"
                value={value.waiting}
                items={options(WAITING_TASKS, WAITING_TASK_LABELS)}
                onChange={(waiting) => onChange({ waiting })}
              />
            </Row>
          ) : null}
          {archived ? (
            <Row label="Archived tasks">
              <DisplaySelect<ArchivedChoice>
                label="Archived tasks"
                value={archived.shown ? 'shown' : 'hidden'}
                items={ARCHIVED_ITEMS}
                onChange={(choice) => archived.onChange(choice === 'shown')}
              />
            </Row>
          ) : null}
        </Section>
      ) : null}
      <div className="flex items-center justify-between gap-2.5 px-3 py-2 text-xs text-fg-3">
        <span>Saved for you {place}</span>
        <Button variant="ghost" size="sm" onPress={onReset} className="h-6 px-0 text-xs text-accent-text">
          Reset to default
        </Button>
      </div>
    </div>
  );
}

export interface DisplayButtonProps {
  /** null on Home. */
  projectKey: string | null;
  view: TaskViewName;
  onLayoutChange?: (layout: ViewLayout) => void;
  groupChoices?: readonly GroupBy[];
  /** M8: a grouping only this page has ("Wave" on a milestone page). */
  pageGrouping?: PageGrouping;
  className?: string;
}

/**
 * The view header's Display button and its popover, reading and saving the person's options for
 * this project and view. Opens from the palette too (requestDisplayOptions()).
 */
export function DisplayButton({
  projectKey,
  view,
  onLayoutChange,
  groupChoices,
  pageGrouping,
  className,
}: DisplayButtonProps) {
  const [displayOptions, set, reset] = useDisplayOptions(projectKey, view);
  // "Archived tasks" is the URL's Archived filter: offered on a project's views inside the router.
  const hasRouter = useRouter({ warn: false }) != null;
  const [open, setOpen] = useState(false);
  useViewRequests((request) => {
    if (request.kind === 'display') setOpen(true);
  });
  return (
    <DialogTrigger isOpen={open} onOpenChange={setOpen}>
      <Button variant="quiet" className={cn(open && 'bg-bg-lane text-fg', className)}>
        Display
      </Button>
      <Popover placement="bottom start" offset={8} className="min-w-0 overflow-visible">
        <AriaDialog aria-label="Display options" className="outline-none">
          {(() => {
            const panel: DisplayOptionsPanelProps = {
              view,
              options: displayOptions,
              onChange: (change) => set(change),
              onReset: reset,
              ...(onLayoutChange
                ? {
                    onLayoutChange: (layout: ViewLayout) => {
                      setOpen(false);
                      onLayoutChange(layout);
                    },
                  }
                : {}),
              ...(groupChoices ? { groupChoices } : {}),
              ...(pageGrouping ? { pageGrouping } : {}),
            };
            return projectKey && hasRouter ? (
              <PanelWithArchived {...panel} />
            ) : (
              <DisplayOptionsPanel {...panel} />
            );
          })()}
        </AriaDialog>
      </Popover>
    </DialogTrigger>
  );
}

/** The panel with "Archived tasks" read from and written to the URL's Archived filter. */
function PanelWithArchived(props: DisplayOptionsPanelProps) {
  const [filter, setFilter] = useUrlTaskFilter();
  return (
    <DisplayOptionsPanel
      {...props}
      archived={{
        shown: filter.archived != null,
        onChange: (shown) => {
          const { archived: _archived, ...rest } = filter;
          setFilter(shown ? { ...rest, archived: 'only' } : rest);
        },
      }}
    />
  );
}
