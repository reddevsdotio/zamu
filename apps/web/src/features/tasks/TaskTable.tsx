import type { TaskListItem } from '@zamu/contracts';
import {
  type CSSProperties,
  type KeyboardEvent,
  type MouseEvent,
  memo,
  type ReactNode,
  type Ref,
  useCallback,
  useEffect,
  useImperativeHandle,
  useLayoutEffect,
  useMemo,
  useRef,
  useState,
} from 'react';
import { type DisplayOptions, showsProperty } from '~/features/views/display-options';
import { workItemNoun } from '~/features/views/work-progress';
import {
  Avatar,
  BlockedMarker,
  CaretGlyph,
  CheckboxBox,
  CycleGlyph,
  cn,
  DueChip,
  isMilestoneFilled,
  LabelDot,
  LabelList,
  MilestoneGlyph,
  NoneGlyph,
  PlusGlyph,
  PriorityGlyph,
  ProgressMark,
  Skeleton,
  SkeletonRow,
  STATUS_LABELS,
  StatusGlyph,
  SubtaskProgress,
  UnassignedAvatar,
} from '~/ui';
import { atTime, formatAge, formatDay } from './format';
import type { ListGroupRow, ListRow, ListTaskRow } from './groups';

// The task list of a project (frames 011–019): one-line rows under group headers, virtualized.
//
//   ▾ ◐ In progress  13                                                                        +
//   ▮▮ HBR-164  ◐ Savings goals                    • frontend  • mobile  ◔ 2/7  ☐ 4/6       2m
//        HBR-164.2 │─ ● English copy and analytics contract                       [cd]    1h
//
// Rows are 38px, group rows 46px (6px of air above the 40px header). Which properties a row shows
// comes from the display options (showsProperty: priority only for Urgent and High, the avatar only
// when the task is someone else's). The criteria marker (M6, off by default) sits after subtasks and
// before the due date, from the counts the list already carries. The screen owns focus and selection; this draws them:
//   cursor     the row keys act on (accent-soft; a quieter tint while several tasks are selected)
//   selected   multi-selected rows (accent-soft, with their checkbox ticked)
//   checkboxes every row shows its checkbox while anything is selected (frame 014)
//
// It is a treegrid: group rows are level 1 with aria-expanded, tasks level 2, nested subtasks level 3.
// Long lists render only the rows in view (fixed row heights, no DOM measuring), so 1000+ rows stay fast;
// the cursor row is always rendered so it keeps DOM focus while scrolled away.

export const TASK_ROW_HEIGHT = 38;
export const GROUP_ROW_HEIGHT = 46;
/** Lists with at least this many rows render only what is in view. */
export const LIST_VIRTUALIZE_FROM = 150;
/** Extra rows drawn above and below the viewport, in px. */
const OVERSCAN_PX = 600;
/** Viewport assumed before the list is measured (server render, tests without layout). */
const FALLBACK_VIEWPORT = 1200;

/** Modifier keys of a row click: Shift selects a range, ⌘/Ctrl toggles. */
export interface RowPressModifiers {
  shiftKey: boolean;
  metaKey: boolean;
  ctrlKey: boolean;
}

export interface TaskListHandle {
  /** Scrolls a row into view; with `focus`, moves DOM focus to it (once it is rendered). */
  reveal: (rowId: string, options?: { focus?: boolean }) => void;
  /** The element of a rendered row. */
  rowElement: (rowId: string) => HTMLElement | null;
  /** True while DOM focus is in the list. */
  hasFocus: () => boolean;
}

export interface TaskListProps {
  'aria-label': string;
  rows: readonly ListRow[];
  /** Row id of the cursor (a task or a group row). */
  cursorId: string | null;
  selectedKeys: ReadonlySet<string>;
  /** Every row shows its checkbox (something is selected). */
  checkboxes: boolean;
  display: DisplayOptions;
  viewerId: string | null;
  /** useNow(): ages and due states render once it is set. */
  now: number | null;
  /** Today in the browser's day, for due dates. */
  today: string;
  /** Group rows are drawn (grouping is not "None"). */
  headers: boolean;
  /** Wider key column (mirrored projects: PAY-786.1.2). */
  wideKeys?: boolean;
  /** The hidden-tasks list: rows end with "removed Oct 22 · 3 comments" and the removal day. */
  hiddenView?: boolean;
  onRowPress: (row: ListTaskRow, modifiers: RowPressModifiers) => void;
  onCheckbox: (row: ListTaskRow, modifiers: RowPressModifiers) => void;
  onGroupToggle: (row: ListGroupRow) => void;
  /** "+" on a group row; no "+" when omitted. */
  onGroupAdd?: (row: ListGroupRow) => void;
  /** DOM focus landed on a row (Tab, a click): the screen moves its cursor there. */
  onRowFocus?: (rowId: string) => void;
  /** Under the last row (the hidden-tasks note of a mirrored project). */
  footer?: ReactNode;
  className?: string;
  ref?: Ref<TaskListHandle>;
}

const heightOf = (row: ListRow) => (row.type === 'group' ? GROUP_ROW_HEIGHT : TASK_ROW_HEIGHT);

/** Index of the last row starting at or before `y`. */
function rowAt(offsets: readonly number[], y: number): number {
  let low = 0;
  let high = offsets.length - 1;
  while (low < high) {
    const mid = Math.ceil((low + high) / 2);
    if ((offsets[mid] ?? 0) <= y) low = mid;
    else high = mid - 1;
  }
  return low;
}

const modifiersOf = (event: MouseEvent | KeyboardEvent): RowPressModifiers => ({
  shiftKey: event.shiftKey,
  metaKey: event.metaKey,
  ctrlKey: event.ctrlKey,
});

const isControl = (target: EventTarget | null) =>
  target instanceof Element && target.closest('button, a, input, [role="checkbox"]') != null;

export function TaskList(props: TaskListProps) {
  const { rows, cursorId, headers, className, footer } = props;
  const scrollRef = useRef<HTMLDivElement>(null);
  const latest = useRef(props);
  latest.current = props;

  const offsets = useMemo(() => {
    const list: number[] = [];
    let y = 0;
    for (const row of rows) {
      list.push(y);
      y += heightOf(row);
    }
    list.push(y);
    return list;
  }, [rows]);
  const total = offsets.at(-1) ?? 0;
  const indexById = useMemo(() => new Map(rows.map((row, index) => [row.id, index])), [rows]);
  const virtual = rows.length >= LIST_VIRTUALIZE_FROM;

  const [viewport, setViewport] = useState({ top: 0, height: FALLBACK_VIEWPORT });
  useEffect(() => {
    const element = scrollRef.current;
    if (!element || !virtual) return;
    let frame = 0;
    const measure = () => {
      frame = 0;
      setViewport((previous) => {
        const next = { top: element.scrollTop, height: element.clientHeight || FALLBACK_VIEWPORT };
        return previous.top === next.top && previous.height === next.height ? previous : next;
      });
    };
    const schedule = () => {
      if (!frame) frame = requestAnimationFrame(measure);
    };
    measure();
    element.addEventListener('scroll', schedule, { passive: true });
    const observer = typeof ResizeObserver === 'undefined' ? null : new ResizeObserver(schedule);
    observer?.observe(element);
    return () => {
      element.removeEventListener('scroll', schedule);
      observer?.disconnect();
      if (frame) cancelAnimationFrame(frame);
    };
  }, [virtual]);

  // Rows to draw: all of them, or the ones in view plus the cursor row.
  const drawn = useMemo(() => {
    if (!virtual) return rows.map((_, index) => index);
    const first = rowAt(offsets, Math.max(0, viewport.top - OVERSCAN_PX));
    const last = rowAt(offsets, viewport.top + viewport.height + OVERSCAN_PX);
    const indexes: number[] = [];
    for (let index = first; index <= Math.min(last, rows.length - 1); index += 1) indexes.push(index);
    const cursorIndex = cursorId == null ? undefined : indexById.get(cursorId);
    if (cursorIndex !== undefined && (cursorIndex < first || cursorIndex > last)) {
      indexes.push(cursorIndex);
      indexes.sort((a, b) => a - b);
    }
    return indexes;
  }, [virtual, rows, offsets, viewport, cursorId, indexById]);

  /** A row that should take DOM focus once rendered. */
  const pendingFocus = useRef<string | null>(null);
  const rowElement = useCallback(
    (rowId: string) =>
      [...(scrollRef.current?.querySelectorAll<HTMLElement>('[data-row-id]') ?? [])].find(
        (element) => element.dataset.rowId === rowId,
      ) ?? null,
    [],
  );
  const focusPending = useCallback(() => {
    const id = pendingFocus.current;
    if (!id) return;
    const element = rowElement(id);
    if (!element) return;
    pendingFocus.current = null;
    if (document.activeElement !== element) element.focus({ preventScroll: true });
  }, [rowElement]);
  useLayoutEffect(() => {
    focusPending();
  });

  const reveal = useCallback(
    (rowId: string, { focus = false }: { focus?: boolean } = {}) => {
      const element = scrollRef.current;
      const index = indexById.get(rowId);
      if (element && index !== undefined) {
        const top = offsets[index] ?? 0;
        const bottom = top + heightOf(rows[index] as ListRow);
        const height = element.clientHeight;
        if (height > 0) {
          if (top < element.scrollTop) element.scrollTop = top;
          else if (bottom > element.scrollTop + height) element.scrollTop = bottom - height;
        }
      }
      if (focus) {
        pendingFocus.current = rowId;
        focusPending();
      }
    },
    [indexById, offsets, rows, focusPending],
  );

  useImperativeHandle(
    props.ref,
    () => ({
      reveal,
      rowElement,
      hasFocus: () => scrollRef.current?.contains(document.activeElement) ?? false,
    }),
    [reveal, rowElement],
  );

  // Handlers read the latest props, so rows can stay memoized.
  const handlers = useMemo<RowHandlers>(
    () => ({
      press: (row, modifiers) => latest.current.onRowPress(row, modifiers),
      check: (row, modifiers) => latest.current.onCheckbox(row, modifiers),
      toggle: (row) => latest.current.onGroupToggle(row),
      add: (row) => latest.current.onGroupAdd?.(row),
      focus: (rowId) => latest.current.onRowFocus?.(rowId),
    }),
    [],
  );

  // One tab stop: the cursor row, else the first task row.
  const tabStop = cursorId ?? rows.find((row) => row.type === 'task')?.id ?? rows[0]?.id ?? null;
  const multi = props.selectedKeys.size > 0;
  const canAdd = props.onGroupAdd != null;

  return (
    <div
      ref={scrollRef}
      className={cn('relative min-h-0 flex-1 overflow-auto', className)}
      data-virtualized={virtual || undefined}
    >
      <div
        role="treegrid"
        aria-label={props['aria-label']}
        aria-rowcount={rows.length}
        aria-multiselectable="true"
        className={cn('relative outline-none', virtual && 'w-full')}
        style={virtual ? { height: total } : undefined}
      >
        {drawn.map((index) => {
          const row = rows[index] as ListRow;
          const style: CSSProperties | undefined = virtual
            ? { position: 'absolute', top: offsets[index], left: 0, right: 0 }
            : undefined;
          if (row.type === 'group') {
            return (
              <GroupRowView
                key={row.id}
                row={row}
                index={index}
                style={style}
                isCursor={row.id === cursorId}
                isTabStop={row.id === tabStop}
                canAdd={canAdd}
                handlers={handlers}
              />
            );
          }
          return (
            <TaskRowView
              key={row.id}
              row={row}
              index={index}
              style={style}
              level={headers ? 2 + row.depth : 1 + row.depth}
              isCursor={row.id === cursorId}
              isTabStop={row.id === tabStop}
              isSelected={props.selectedKeys.has(row.task.key)}
              multi={multi}
              checkboxes={props.checkboxes}
              display={props.display}
              viewerId={props.viewerId}
              now={props.now}
              today={props.today}
              wideKeys={props.wideKeys ?? false}
              hiddenView={props.hiddenView ?? false}
              handlers={handlers}
            />
          );
        })}
      </div>
      {footer}
    </div>
  );
}

interface RowHandlers {
  press: (row: ListTaskRow, modifiers: RowPressModifiers) => void;
  check: (row: ListTaskRow, modifiers: RowPressModifiers) => void;
  toggle: (row: ListGroupRow) => void;
  add: (row: ListGroupRow) => void;
  focus: (rowId: string) => void;
}

// ---------------------------------------------------------------------------
// Group rows
// ---------------------------------------------------------------------------

interface GroupRowViewProps {
  row: ListGroupRow;
  index: number;
  style: CSSProperties | undefined;
  isCursor: boolean;
  isTabStop: boolean;
  canAdd: boolean;
  handlers: RowHandlers;
}

/** The glyph before a group's name: status, priority, avatar, label dot, milestone or cycle. */
export function GroupGlyph({ value }: { value: ListGroupRow['group']['value'] }) {
  switch (value.field) {
    case 'status':
      return <StatusGlyph status={value.status} decorative />;
    case 'priority':
      return <PriorityGlyph priority={value.priority} decorative />;
    case 'assignee':
      return value.assignee ? (
        <Avatar name={value.assignee.name} kind={value.assignee.kind} size={18} decorative />
      ) : (
        <UnassignedAvatar size={18} decorative />
      );
    case 'label':
      return value.label ? <LabelDot color={value.label.color} size={9} /> : <NoneGlyph />;
    case 'milestone':
      return value.milestone ? (
        <MilestoneGlyph filled={isMilestoneFilled(value.milestone.status)} className="text-fg-2" />
      ) : (
        <NoneGlyph />
      );
    case 'cycle':
      return value.cycle ? (
        <CycleGlyph
          state={
            value.cycle.state === 'current'
              ? 'progress'
              : value.cycle.state === 'completed'
                ? 'done'
                : 'empty'
          }
          className="text-fg-2"
        />
      ) : (
        <NoneGlyph />
      );
    default:
      return null;
  }
}

const GroupRowView = memo(function GroupRowView({
  row,
  index,
  style,
  isCursor,
  isTabStop,
  canAdd,
  handlers,
}: GroupRowViewProps) {
  const { group, collapsed } = row;
  return (
    // biome-ignore lint/a11y: a virtualized treegrid of divs; rows take focus (roving tabIndex) and the screen binds the keys
    <div
      role="row"
      aria-level={1}
      aria-rowindex={index + 1}
      aria-expanded={!collapsed}
      data-row-id={row.id}
      data-group-row=""
      data-cursor={isCursor || undefined}
      tabIndex={isTabStop ? 0 : -1}
      onFocus={(event) => {
        if (event.target === event.currentTarget) handlers.focus(row.id);
      }}
      onClick={(event) => {
        if (isControl(event.target)) return;
        handlers.toggle(row);
      }}
      style={style}
      className="group/grp box-border flex h-11.5 cursor-pointer items-end pt-1.5 outline-none select-none focus-visible:focus-ring-inset"
    >
      {/* biome-ignore lint/a11y: the row holds the focus, its one cell does not */}
      <div
        role="gridcell"
        className={cn(
          'flex h-10 min-w-0 flex-1 items-center gap-2.25 border-b border-line pr-4.5 pl-4 font-medium',
          isCursor && 'bg-bg-grp',
        )}
      >
        <CaretGlyph className={cn('mr-0.5 transition-transform', collapsed && '-rotate-90')} />
        <GroupGlyph value={group.value} />
        <span className="truncate">{group.label}</span>
        <span className="font-normal text-fg-3 tabular-nums">{group.count}</span>
        <span className="sr-only">{collapsed ? ', collapsed' : ', expanded'}</span>
        <span className="flex-1" />
        {canAdd ? (
          <button
            type="button"
            tabIndex={-1}
            aria-label={`New task in ${group.label}`}
            onClick={() => handlers.add(row)}
            className="grid size-6 cursor-pointer place-items-center rounded-sm text-fg-3 opacity-70 outline-none group-hover/grp:opacity-100 hover:bg-bg-lane hover:text-fg focus-visible:focus-ring"
          >
            <PlusGlyph />
          </button>
        ) : null}
      </div>
    </div>
  );
});

// ---------------------------------------------------------------------------
// Task rows
// ---------------------------------------------------------------------------

interface TaskRowViewProps {
  row: ListTaskRow;
  index: number;
  style: CSSProperties | undefined;
  level: number;
  isCursor: boolean;
  isTabStop: boolean;
  isSelected: boolean;
  /** Anything is selected: the cursor row takes the quieter tint. */
  multi: boolean;
  checkboxes: boolean;
  display: DisplayOptions;
  viewerId: string | null;
  now: number | null;
  today: string;
  wideKeys: boolean;
  hiddenView: boolean;
  handlers: RowHandlers;
}

const TaskRowView = memo(function TaskRowView({
  row,
  index,
  style,
  level,
  isCursor,
  isTabStop,
  isSelected,
  multi,
  checkboxes,
  display,
  viewerId,
  now,
  today,
  wideKeys,
  hiddenView,
  handlers,
}: TaskRowViewProps) {
  const { task } = row;
  return (
    // biome-ignore lint/a11y: a virtualized treegrid of divs; rows take focus (roving tabIndex) and the screen binds the keys
    <div
      role="row"
      aria-level={level}
      aria-rowindex={index + 1}
      aria-selected={isSelected}
      aria-label={rowLabel(task)}
      data-row-id={row.id}
      data-task-key={task.key}
      data-cursor={isCursor || undefined}
      tabIndex={isTabStop ? 0 : -1}
      onFocus={(event) => {
        if (event.target === event.currentTarget) handlers.focus(row.id);
      }}
      onMouseDown={(event) => {
        // Shift+click selects a range, not text.
        if (event.shiftKey) event.preventDefault();
      }}
      onClick={(event) => {
        if (isControl(event.target)) return;
        handlers.press(row, modifiersOf(event));
      }}
      style={style}
      className={cn(
        // The cursor tint is the focus indicator (frame 011), so rows draw no ring.
        'relative flex h-(--row-h) cursor-default items-center outline-none select-none',
        isSelected || (isCursor && !multi)
          ? 'bg-accent-soft'
          : isCursor
            ? 'bg-bg-grp'
            : 'hover:bg-surface-hover',
      )}
    >
      {/* biome-ignore lint/a11y: the row holds the focus, its one cell does not */}
      <div role="gridcell" className="flex h-full min-w-0 flex-1 items-center gap-2.5 pr-4.5 pl-4">
        <TaskRowContent
          task={task}
          depth={row.depth}
          lastChild={row.lastChild}
          isSelected={isSelected}
          checkboxes={checkboxes}
          onCheck={(modifiers) => handlers.check(row, modifiers)}
          display={display}
          viewerId={viewerId}
          now={now}
          today={today}
          wideKeys={wideKeys}
          hiddenView={hiddenView}
        />
      </div>
    </div>
  );
});

/** "PAY-142, In progress, Retry failed webhooks, blocked": what a screen reader says for a row. */
export function rowLabel(task: TaskListItem): string {
  return [task.key, STATUS_LABELS[task.status], task.title, task.blocked ? 'blocked' : null]
    .filter(Boolean)
    .join(', ');
}

export interface TaskRowContentProps {
  task: TaskListItem;
  /** 1: a nested subtask (indented status glyph with a tree line). */
  depth?: 0 | 1;
  lastChild?: boolean;
  isSelected?: boolean;
  /** Draw the checkbox before the row. */
  checkboxes?: boolean;
  onCheck?: (modifiers: RowPressModifiers) => void;
  display: DisplayOptions;
  viewerId: string | null;
  now: number | null;
  today: string;
  wideKeys?: boolean;
  hiddenView?: boolean;
}

/**
 * The inside of a list row: checkbox, priority, key, status, title, then the markers on the right.
 * Exported for other task tables (milestones and cycles) that draw the same rows.
 */
export function TaskRowContent({
  task,
  depth = 0,
  lastChild = false,
  isSelected = false,
  checkboxes = false,
  onCheck,
  display,
  viewerId,
  now,
  today,
  wideKeys = false,
  hiddenView = false,
}: TaskRowContentProps) {
  const shows = (property: Parameters<typeof showsProperty>[1]) =>
    showsProperty(display, property, task, viewerId);
  const clock = now == null ? null : new Date(now);
  return (
    <>
      {checkboxes ? (
        // biome-ignore lint/a11y/useSemanticElements: a button with the Margin box, outside any form
        <button
          type="button"
          role="checkbox"
          aria-checked={isSelected}
          aria-label={`Select ${task.key}`}
          tabIndex={-1}
          onMouseDown={(event) => {
            if (event.shiftKey) event.preventDefault();
          }}
          onClick={(event) => onCheck?.(modifiersOf(event))}
          className="-mr-0.5 grid size-4 shrink-0 cursor-pointer place-items-center rounded-sm outline-none focus-visible:focus-ring"
        >
          <CheckboxBox checked={isSelected} />
        </button>
      ) : null}
      {display.properties.priority ? <PriorityGlyph priority={task.priority} context="compact" /> : null}
      {display.properties.key ? (
        <span
          className={cn(
            'shrink-0 truncate text-xs font-medium whitespace-nowrap text-fg-3 tabular-nums',
            wideKeys ? 'w-18' : 'w-15.5',
          )}
        >
          {task.key}
        </span>
      ) : null}
      <span className={cn('relative flex h-full shrink-0 items-center', depth === 1 && 'pl-5.5')}>
        {depth === 1 ? (
          <>
            <span
              aria-hidden
              className={cn('absolute top-0 left-1.5 border-l border-line', lastChild ? 'h-1/2' : 'bottom-0')}
            />
            <span aria-hidden className="absolute top-1/2 left-1.5 w-2.5 border-t border-line" />
          </>
        ) : null}
        <StatusGlyph status={task.status} />
      </span>
      <span className="flex min-w-0 flex-1 items-baseline gap-1.5">
        <span className="truncate font-medium text-fg">{task.title}</span>
        {depth === 0 && task.parentKey ? (
          <span className="shrink-0 text-xs whitespace-nowrap text-fg-3">sub of {task.parentKey}</span>
        ) : null}
      </span>
      {hiddenView ? (
        <span className="flex shrink-0 items-center gap-2">
          <span className="truncate text-xs text-fg-2">{clock ? removedText(task, clock) : ''}</span>
          <span className="w-10 text-right text-xs text-fg-3 tabular-nums">
            {task.hiddenAt && clock ? formatDay(task.hiddenAt, clock) : ''}
          </span>
        </span>
      ) : (
        <span className="flex shrink-0 items-center gap-2">
          {task.blocked && shows('blocked') ? <BlockedMarker /> : null}
          {task.labels?.length && shows('labels') ? <LabelList labels={task.labels} max={3} /> : null}
          {task.subtaskProgress && task.subtaskProgress.total > 0 && shows('subtasks') ? (
            <SubtaskProgress done={task.subtaskProgress.done} total={task.subtaskProgress.total} />
          ) : null}
          {task.criteriaProgress && task.criteriaProgress.total > 0 && shows('criteria') ? (
            <ProgressMark
              {...task.criteriaProgress}
              noun={workItemNoun('criteria', task.criteriaProgress.total)}
            />
          ) : null}
          {task.dueDate && shows('due') && now != null ? (
            <DueChip dueDate={task.dueDate} status={task.status} today={today} />
          ) : null}
          {task.milestone && shows('milestone') ? (
            <span className="inline-flex max-w-40 items-center gap-1.5 text-xs text-fg-2">
              <MilestoneGlyph filled={isMilestoneFilled(task.milestone.status)} />
              <span className="truncate">{task.milestone.name}</span>
            </span>
          ) : null}
          {task.cycle && shows('cycle') ? (
            <span className="inline-flex items-center gap-1.5 text-xs whitespace-nowrap text-fg-2">
              <CycleGlyph state={task.cycle.state === 'current' ? 'progress' : 'empty'} />
              {task.cycle.name ?? `Cycle ${task.cycle.number}`}
            </span>
          ) : null}
          {shows('created') ? (
            <time dateTime={task.createdAt} className="text-xs whitespace-nowrap text-fg-3 tabular-nums">
              {atTime(formatDay, now)(task.createdAt)}
            </time>
          ) : null}
          {display.properties.assignee ? (
            task.assignee && shows('assignee') ? (
              <Avatar name={task.assignee.name} kind={task.assignee.kind} size={18} />
            ) : (
              <span aria-hidden className="size-4.5 shrink-0" />
            )
          ) : null}
          {display.properties.updated ? (
            <time
              dateTime={task.updatedAt}
              className="w-10 shrink-0 text-right text-xs whitespace-nowrap text-fg-3 tabular-nums"
            >
              {atTime(formatAge, now)(task.updatedAt)}
            </time>
          ) : null}
        </span>
      )}
    </>
  );
}

/** "removed Oct 22 · 3 comments". */
export function removedText(task: TaskListItem, now: Date): string {
  const parts = [task.hiddenAt ? `removed ${formatDay(task.hiddenAt, now)}` : 'removed'];
  const comments = task.commentCount ?? 0;
  if (comments) parts.push(`${comments} ${comments === 1 ? 'comment' : 'comments'}`);
  return parts.join(' · ');
}

// ---------------------------------------------------------------------------
// Loading
// ---------------------------------------------------------------------------

const SKELETON_GROUPS: readonly (readonly string[])[] = [
  ['80%', '60%', '45%', '80%', '30%', '60%', '45%', '60%', '80%'],
  ['80%', '60%', '45%', '80%', '30%', '60%'],
];

/** Frame 018: two group headers with skeleton rows under them. */
export function TaskListSkeleton({ label = 'Loading tasks' }: { label?: string }) {
  return (
    <div
      role="status"
      aria-busy="true"
      aria-label={label}
      className="flex min-h-0 flex-1 flex-col overflow-hidden"
    >
      {SKELETON_GROUPS.map((widths, group) => (
        // biome-ignore lint/suspicious/noArrayIndexKey: static placeholders
        <div key={group} aria-hidden>
          <div className="mt-1.5 flex h-10 items-center gap-2.25 border-b border-line pr-4.5 pl-4">
            <Skeleton width={48} />
            <Skeleton width={90} />
          </div>
          {widths.map((width, index) => (
            // biome-ignore lint/suspicious/noArrayIndexKey: static placeholders
            <SkeletonRow key={index} titleWidth={width} />
          ))}
        </div>
      ))}
    </div>
  );
}
