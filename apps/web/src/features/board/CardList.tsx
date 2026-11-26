import type { TaskListItem } from '@zamu/contracts';
import { memo, type ReactNode, useMemo } from 'react';
import {
  DropIndicator,
  type DropItem,
  GridList,
  GridListItem,
  isTextDropItem,
  useDragAndDrop,
} from 'react-aria-components';
import { Button, boardCardStyles, cn, dropIndicatorClass } from '~/ui';

// The cards of one board cell (a column, or a column inside a swimlane) as a React Aria GridList with
// drag and drop: reorder inside the cell (manual order only), drop from another cell between cards, on a
// card or on an empty cell.

/** Drag type carrying the task key. */
export const CARD_DRAG_TYPE = 'application/x-zamu-task-key';

export interface CardDrop {
  key: string;
  /** Card the drop lands next to; null for a drop on the cell itself (or on a card, unordered boards). */
  target: { key: string; position: 'before' | 'after' } | null;
}

export interface CardListProps {
  /** "In progress" or "In progress, claude-dev": the GridList's accessible name. */
  label: string;
  /** Column id (a status or a group key), on data-column. */
  column: string;
  cards: readonly TaskListItem[];
  /** The keyboard cursor (accent ring). */
  cursor: string | null;
  isSelected: (key: string) => boolean;
  /** Click or Enter on a card. */
  onAction: (key: string) => void;
  onDrop: (drop: CardDrop) => void;
  /** The inside of a card. */
  renderCard: (card: TaskListItem) => ReactNode;
  /** A subtask shown as its own card: tighter. */
  isChild?: (card: TaskListItem) => boolean;
  /** M7: a task waiting for its check-again day under "Waiting tasks: Shown, dimmed" (frame 101). */
  isDimmed?: (card: TaskListItem) => boolean;
  /** Cards keep their place (manual order): drops between cards say where. Otherwise a drop is into the cell. */
  reorderable?: boolean;
  /** Turns drag and drop off (while loading). */
  isDisabled?: boolean;
  /** Refuses every drop (the dragged card can't move here). Drags out of the list still work. */
  refuseDrops?: boolean;
  /** A drag of one of these cards started (keyboard or pointer). */
  onDragStart?: (key: string) => void;
  /** The drag ended, dropped or not. */
  onDragEnd?: () => void;
  /** A dragged card entered this cell. */
  onDropEnter?: () => void;
  /** Re-render the cards when these change. */
  dependencies?: readonly unknown[];
  /** Drawn (and droppable) while the cell has no cards. */
  empty?: ReactNode;
  className?: string;
}

async function keyOf(items: readonly DropItem[]): Promise<string | null> {
  const item = items.find((candidate) => isTextDropItem(candidate) && candidate.types.has(CARD_DRAG_TYPE));
  if (!item || !isTextDropItem(item)) return null;
  return (await item.getText(CARD_DRAG_TYPE)) || null;
}

export const CardList = memo(function CardList({
  label,
  column,
  cards,
  cursor,
  isSelected,
  onAction,
  onDrop,
  renderCard,
  isChild,
  isDimmed,
  reorderable = true,
  isDisabled = false,
  refuseDrops = false,
  onDragStart,
  onDragEnd,
  onDropEnter,
  dependencies = [],
  empty,
  className,
}: CardListProps) {
  const byKey = useMemo(() => new Map(cards.map((card) => [card.key, card])), [cards]);

  const { dragAndDropHooks } = useDragAndDrop<TaskListItem>({
    isDisabled,
    getItems: (keys): Record<string, string>[] =>
      [...keys].map((key) => ({ [CARD_DRAG_TYPE]: String(key), 'text/plain': String(key) })),
    acceptedDragTypes: [CARD_DRAG_TYPE],
    getDropOperation: (target) => {
      if (refuseDrops) return 'cancel';
      // Manual order: between cards only. Otherwise anywhere in the cell, the column's order places it.
      if (reorderable && target.type === 'item' && target.dropPosition === 'on') return 'cancel';
      return 'move';
    },
    onDragStart: (event) => {
      const key = [...event.keys][0];
      if (key != null) onDragStart?.(String(key));
    },
    onDragEnd: () => onDragEnd?.(),
    onDropEnter: () => onDropEnter?.(),
    onReorder: (event) => {
      const key = [...event.keys][0];
      if (!reorderable || key == null || event.target.dropPosition === 'on') return;
      onDrop({
        key: String(key),
        target: { key: String(event.target.key), position: event.target.dropPosition },
      });
    },
    onInsert: async (event) => {
      const key = await keyOf(event.items);
      if (!key || event.target.dropPosition === 'on') return;
      onDrop({
        key,
        target: reorderable ? { key: String(event.target.key), position: event.target.dropPosition } : null,
      });
    },
    onItemDrop: async (event) => {
      if (reorderable || event.isInternal) return;
      const key = await keyOf(event.items);
      if (key) onDrop({ key, target: null });
    },
    onRootDrop: async (event) => {
      const key = await keyOf(event.items);
      if (key) onDrop({ key, target: null });
    },
    renderDropIndicator: (target) => (
      <DropIndicator target={target} className={reorderable ? dropIndicatorClass : 'hidden'} />
    ),
    renderDragPreview: (items) => {
      const key = items[0]?.[CARD_DRAG_TYPE];
      const card = key ? byKey.get(key) : undefined;
      return (
        <div className={cn(boardCardStyles({ state: 'dragging' }), 'w-75')}>
          {card ? renderCard(card) : <span className="text-xs text-fg-3">{key}</span>}
        </div>
      );
    },
  });

  return (
    <GridList
      aria-label={label}
      items={cards}
      layout="stack"
      // Selection is the board's (X, Shift+click): React Aria selection stays off, so a drop never selects.
      selectionMode="none"
      onAction={(key) => onAction(String(key))}
      disallowTypeAhead
      escapeKeyBehavior="none"
      dependencies={[cursor, isSelected, renderCard, isDimmed, ...dependencies]}
      dragAndDropHooks={dragAndDropHooks}
      data-column={column}
      renderEmptyState={() => empty ?? <div className="min-h-12 flex-1" />}
      className={cn('flex min-h-12 shrink-0 grow flex-col gap-2 outline-none', className)}
    >
      {(card) => (
        <GridListItem
          id={card.key}
          textValue={`${card.key} ${card.title}`}
          data-card-key={card.key}
          data-cursor={card.key === cursor || undefined}
          data-multi={isSelected(card.key) || undefined}
          data-waiting={isDimmed?.(card) || undefined}
          className={cn(
            boardCardStyles({ child: isChild?.(card) ?? false }),
            // m7.css .card.waiting: the card keeps its place, quieter.
            isDimmed?.(card) && 'opacity-62',
          )}
        >
          {/* React Aria's keyboard and screen reader drag starts from this button; sighted keyboard users
              have Shift+← / Shift+→. */}
          <span className="sr-only">
            <Button slot="drag" variant="ghost">
              Drag {card.key}
            </Button>
          </span>
          {renderCard(card)}
        </GridListItem>
      )}
    </GridList>
  );
});
