import type { TaskListItem, TaskStatus } from '@zamu/contracts';
import { type ReactNode, useEffect, useRef } from 'react';
import { Button as AriaButton, isTextDropItem, useDrop } from 'react-aria-components';
import type { TaskGroupValue } from '~/features/views';
import { hiddenWaitingText } from '~/features/views/display-options';
import {
  Avatar,
  BoardCardSkeleton,
  BoardColumn,
  BoardColumnEmpty,
  BoardColumnHeader,
  BoardFoldedColumn,
  Button,
  ClockGlyph,
  CycleGlyph,
  cn,
  isMilestoneFilled,
  LabelDot,
  MilestoneGlyph,
  PriorityGlyph,
  StatusGlyph,
  SwimlaneHeader,
  UnassignedAvatar,
} from '~/ui';
import { CARD_DRAG_TYPE, type CardDrop, CardList, type CardListProps } from './CardList';
import type { Lane } from './lanes';

// Board bodies (frames 029–044): plain columns, or swimlanes (a header row, then one row of cells per
// lane, each cell capped at a few cards with "+ N more").

/** One column as the board draws it: a status, or a group of another field. */
export interface BoardColumnModel {
  /** A status, or the group key (a priority, a user id, a milestone id, "none"). */
  id: string;
  label: string;
  value: TaskGroupValue;
  /** Tasks in the column, including those not loaded yet. */
  count: number;
  /** Loaded cards, in the column's order. */
  cards: TaskListItem[];
  folded: boolean;
  isLoading: boolean;
  /** Status columns load 50 cards at a time. */
  hasMore?: boolean;
  isFetchingMore?: boolean;
  fetchMore?: () => Promise<unknown>;
  /** Cards loaded so far (before "Hide done tasks after"), for "N more". */
  loaded?: number;
  /** M7: waiting tasks left out under "Waiting tasks: Hidden" ("2 waiting, hidden"). */
  hiddenWaiting?: number;
}

/** What every cell's CardList gets from the board. */
export type CellProps = Pick<
  CardListProps,
  | 'cursor'
  | 'isSelected'
  | 'onAction'
  | 'renderCard'
  | 'isChild'
  | 'isDimmed'
  | 'reorderable'
  | 'onDragEnd'
  | 'dependencies'
> & { onDragStart: (key: string) => void };

export interface BoardBodyProps {
  /** Every column in order, folded ones included. */
  columns: readonly BoardColumnModel[];
  onFoldChange: (column: string, folded: boolean) => void;
  /** A card dropped into a cell (lane null without swimlanes). */
  onDrop: (drop: CardDrop, column: string, lane: string | null) => void;
  /** "+" in a column header. */
  onAdd?: (column: BoardColumnModel) => void;
  cell: CellProps;
  /** While a card is dragged: columns that refuse it (a mirrored card's status, a label column). */
  refused?: ReadonlySet<string> | null;
  /** A dragged card entered a column. */
  onDragOver?: (column: string) => void;
  /** The column a dragged card would land in (outlined), when it isn't the card's own. */
  dropTarget?: string | null;
  /** Text of an empty open column. */
  emptyText: (column: BoardColumnModel) => ReactNode;
  /** M7: "Show" in a column's "2 waiting, hidden" footer. */
  onShowWaiting?: (column: BoardColumnModel) => void;
}

/** M7 (frame 101): the end of a column that leaves waiting tasks out, with Show. */
export function HiddenWaitingFooter({
  count,
  column,
  onShow,
}: {
  count: number;
  /** The column's name, for Show's accessible name. */
  column: string;
  onShow?: () => void;
}) {
  return (
    <div
      data-hidden-waiting=""
      className="mx-0 flex h-7.5 shrink-0 items-center gap-1.75 px-1.5 text-xs text-fg-3"
    >
      <ClockGlyph />
      <span>{hiddenWaitingText(count)}</span>
      <span className="flex-1" />
      {onShow ? (
        <Button
          variant="ghost"
          size="sm"
          aria-label={`Show the waiting tasks in ${column}`}
          className="h-6 px-1 text-xs text-accent-text"
          onPress={onShow}
        >
          Show
        </Button>
      ) : null}
    </div>
  );
}

/** The header glyph of a group: status ring, priority bars, avatar, milestone diamond, cycle, label dot. */
export function groupGlyph(value: TaskGroupValue): ReactNode {
  switch (value.field) {
    case 'status':
      return <StatusGlyph status={value.status} decorative />;
    case 'priority':
      return <PriorityGlyph priority={value.priority} decorative />;
    case 'assignee':
      return value.assignee ? (
        <Avatar name={value.assignee.name} kind={value.assignee.kind} decorative />
      ) : (
        <UnassignedAvatar decorative />
      );
    case 'milestone':
      return (
        <MilestoneGlyph
          filled={value.milestone ? isMilestoneFilled(value.milestone.status) : false}
          className="text-fg-3"
        />
      );
    case 'cycle':
      return <CycleGlyph className="text-fg-3" />;
    case 'label':
      return value.label ? <LabelDot color={value.label.color} size={9} /> : null;
    default:
      return null;
  }
}

const statusOf = (column: BoardColumnModel): TaskStatus | undefined =>
  column.value.field === 'status' ? column.value.status : undefined;

/** Fetches the next page when the "N more" footer scrolls into view. */
function MoreFooter({ column }: { column: BoardColumnModel }) {
  const ref = useRef<HTMLSpanElement>(null);
  const fetchMore = useRef(column.fetchMore);
  fetchMore.current = column.fetchMore;
  const busy = column.isFetchingMore ?? false;
  useEffect(() => {
    const node = ref.current;
    if (!node || busy || typeof IntersectionObserver === 'undefined') return;
    const observer = new IntersectionObserver((entries) => {
      if (entries.some((entry) => entry.isIntersecting)) void fetchMore.current?.();
    });
    observer.observe(node);
    return () => observer.disconnect();
  }, [busy]);
  const left = Math.max(0, column.count - (column.loaded ?? column.cards.length));
  return <span ref={ref}>{busy ? 'Loading…' : `${left} more · scroll or press J`}</span>;
}

/** Collapsed column strip that also takes dropped cards (they go to the top of that column). */
function FoldedColumn({
  column,
  onExpand,
  onDropCard,
  onDragOver,
  isRefused = false,
}: {
  column: BoardColumnModel;
  onExpand: () => void;
  onDropCard: (key: string) => void;
  onDragOver?: () => void;
  isRefused?: boolean;
}) {
  const ref = useRef<HTMLDivElement>(null);
  const { dropProps, isDropTarget } = useDrop({
    ref,
    getDropOperation: (types) => (!isRefused && types.has(CARD_DRAG_TYPE) ? 'move' : 'cancel'),
    onDropEnter: () => onDragOver?.(),
    onDrop: async (event) => {
      const item = event.items.find(
        (candidate) => isTextDropItem(candidate) && candidate.types.has(CARD_DRAG_TYPE),
      );
      if (!item || !isTextDropItem(item)) return;
      const key = await item.getText(CARD_DRAG_TYPE);
      if (key) onDropCard(key);
    },
  });
  return (
    <div ref={ref} {...dropProps} className={cn('flex shrink-0', isRefused && 'opacity-50')}>
      <BoardFoldedColumn
        status={statusOf(column)}
        label={column.label}
        glyph={groupGlyph(column.value)}
        count={column.count}
        isDropTarget={isDropTarget}
        onExpand={onExpand}
      />
    </div>
  );
}

export function BoardColumns({
  columns,
  onFoldChange,
  onDrop,
  onAdd,
  cell,
  refused = null,
  onDragOver,
  dropTarget = null,
  emptyText,
  onShowWaiting,
}: BoardBodyProps) {
  return (
    <div className="flex min-h-0 flex-1 gap-3.5 overflow-x-auto pt-3 pr-3.5 pl-4.5">
      {columns.map((column) => {
        const isRefused = refused?.has(column.id) ?? false;
        if (column.folded) {
          return (
            <FoldedColumn
              key={column.id}
              column={column}
              onExpand={() => onFoldChange(column.id, false)}
              onDropCard={(key) => onDrop({ key, target: null }, column.id, null)}
              onDragOver={() => onDragOver?.(column.id)}
              isRefused={isRefused}
            />
          );
        }
        return (
          <BoardColumn
            key={column.id}
            status={statusOf(column)}
            label={column.label}
            glyph={groupGlyph(column.value)}
            count={column.count}
            isDropTarget={dropTarget === column.id && !isRefused}
            refusal={isRefused && column.value.field === 'status' ? true : undefined}
            onFoldChange={(folded) => onFoldChange(column.id, folded)}
            onAdd={onAdd ? () => onAdd(column) : undefined}
            more={column.hasMore ? <MoreFooter column={column} /> : undefined}
          >
            {column.isLoading ? (
              <ColumnSkeleton cards={Math.min(Math.max(column.count, 1), 3)} />
            ) : (
              <CardList
                {...cell}
                label={column.label}
                column={column.id}
                cards={column.cards}
                onDrop={(drop) => onDrop(drop, column.id, null)}
                refuseDrops={isRefused}
                onDropEnter={() => onDragOver?.(column.id)}
                empty={<BoardColumnEmpty className="mx-0">{emptyText(column)}</BoardColumnEmpty>}
              />
            )}
            {column.hiddenWaiting ? (
              <HiddenWaitingFooter
                count={column.hiddenWaiting}
                column={column.label}
                {...(onShowWaiting ? { onShow: () => onShowWaiting(column) } : {})}
              />
            ) : null}
          </BoardColumn>
        );
      })}
    </div>
  );
}

function ColumnSkeleton({ cards }: { cards: number }) {
  const widths = ['70%', '55%', '80%'];
  return (
    <>
      {Array.from({ length: cards }, (_, index) => (
        // biome-ignore lint/suspicious/noArrayIndexKey: static placeholders
        <BoardCardSkeleton key={index} titleWidth={widths[index % widths.length]} />
      ))}
    </>
  );
}

/** Loading board: column headers and a few placeholder cards per column. */
export function BoardSkeleton({ columns }: { columns: number }) {
  const shapes = [['70%', '50%'], ['80%', '60%', '40%'], ['55%'], ['75%', '65%']];
  return (
    <div aria-busy className="flex min-h-0 flex-1 gap-3.5 pt-3 pr-3.5 pl-4.5">
      <span className="sr-only">Loading the board</span>
      {Array.from({ length: Math.max(columns, 1) }, (_, index) => (
        <div
          // biome-ignore lint/suspicious/noArrayIndexKey: static placeholders
          key={index}
          className="flex min-w-60 max-w-100 flex-1 flex-col gap-2 rounded-t-lg bg-bg-lane px-2"
        >
          <div className="flex h-9.5 items-center px-1">
            <span className="h-2.5 w-22 rounded-sm bg-line-soft" />
          </div>
          {(shapes[index % shapes.length] ?? []).map((width, card) => (
            // biome-ignore lint/suspicious/noArrayIndexKey: static placeholders
            <BoardCardSkeleton key={card} titleWidth={width} />
          ))}
        </div>
      ))}
    </div>
  );
}

export interface BoardLanesProps extends BoardBodyProps {
  lanes: readonly Lane[];
  /** Collapsed lanes. */
  collapsed: ReadonlySet<string>;
  onCollapsedChange: (lane: string, collapsed: boolean) => void;
  /** Cells shown in full ("+ N more" pressed), as `${lane}:${column}`. */
  expandedCells: ReadonlySet<string>;
  onExpandCell: (lane: string, column: string) => void;
  /** Cards a cell shows before "+ N more". */
  cap: number;
}

export const cellId = (lane: string, column: string) => `${lane}:${column}`;

/** Lane header glyph: the assignee's avatar, or the group's glyph. */
function laneLead(lane: Lane): ReactNode {
  return groupGlyph(lane.value);
}

/** Swimlanes (frame 031): column headers, then per lane a header and one cell per open column. */
export function BoardLanes({
  columns,
  onFoldChange,
  onDrop,
  cell,
  refused = null,
  onDragOver,
  lanes,
  collapsed,
  onCollapsedChange,
  expandedCells,
  onExpandCell,
  cap,
}: BoardLanesProps) {
  const open = columns.filter((column) => !column.folded);
  const folded = columns.filter((column) => column.folded);
  return (
    <div className="flex min-h-0 flex-1 flex-col overflow-auto pr-3.5 pl-4.5">
      <div className="sticky top-0 z-2 flex min-w-fit gap-3.5 bg-bg pt-3">
        {open.map((column) => (
          <BoardColumnHeader
            key={column.id}
            status={statusOf(column)}
            label={column.label}
            glyph={groupGlyph(column.value)}
            count={column.count}
            onFold={() => onFoldChange(column.id, true)}
            className="min-w-60 max-w-100 flex-1 rounded-t-lg bg-bg-lane"
          />
        ))}
        {folded.map((column) => (
          <AriaButton
            key={column.id}
            onPress={() => onFoldChange(column.id, false)}
            aria-label={`Expand ${column.label}, ${column.count} tasks`}
            className="grid h-9.5 w-9.5 shrink-0 cursor-pointer place-items-center rounded-t-lg bg-bg-grp outline-none hover:text-fg focus-visible:focus-ring-inset"
          >
            {groupGlyph(column.value)}
          </AriaButton>
        ))}
      </div>
      {lanes.map((lane, laneIndex) => {
        const isOpen = !collapsed.has(lane.id);
        const last = laneIndex === lanes.length - 1;
        return (
          <section key={lane.id} aria-label={`${lane.title}, ${lane.count} tasks`} className="min-w-fit">
            <SwimlaneHeader
              title={lane.title}
              lead={laneLead(lane)}
              count={lane.count}
              isOpen={isOpen}
              onOpenChange={(next) => onCollapsedChange(lane.id, !next)}
            />
            {isOpen ? (
              <div className="flex gap-3.5">
                {open.map((column) => {
                  const isRefused = refused?.has(column.id) ?? false;
                  const cards = lane.cells[column.id] ?? [];
                  const id = cellId(lane.id, column.id);
                  const shown = expandedCells.has(id) ? cards : cards.slice(0, cap);
                  const hidden = cards.length - shown.length;
                  return (
                    <div
                      key={column.id}
                      data-refused={isRefused || undefined}
                      className={cn(
                        'flex min-w-60 max-w-100 flex-1 flex-col gap-2 bg-bg-lane p-2',
                        last && 'rounded-b-lg',
                        isRefused && 'opacity-50',
                      )}
                    >
                      <CardList
                        {...cell}
                        label={`${column.label}, ${lane.title}`}
                        column={column.id}
                        cards={shown}
                        onDrop={(drop) => onDrop(drop, column.id, lane.id)}
                        refuseDrops={isRefused}
                        onDropEnter={() => onDragOver?.(column.id)}
                        empty={<span className="px-1 py-0.5 text-xs text-fg-3">None</span>}
                        className="min-h-6 grow-0"
                      />
                      {hidden > 0 ? (
                        <AriaButton
                          onPress={() => onExpandCell(lane.id, column.id)}
                          aria-label={`Show ${hidden} more in ${column.label}, ${lane.title}`}
                          className="cursor-pointer self-start rounded-sm px-1 pb-0.5 text-xs text-fg-3 outline-none hover:text-fg focus-visible:focus-ring"
                        >
                          + {hidden} more
                        </AriaButton>
                      ) : null}
                    </div>
                  );
                })}
                {folded.map((column) => (
                  <div key={column.id} aria-hidden className="w-9.5 shrink-0" />
                ))}
              </div>
            ) : null}
          </section>
        );
      })}
    </div>
  );
}
