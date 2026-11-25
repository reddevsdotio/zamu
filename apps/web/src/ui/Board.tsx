import type { ReactNode } from 'react';
import { Button as AriaButton } from 'react-aria-components';
import { Avatar, type MemberKind } from './Avatar';
import { Chip } from './Chip';
import { cn, tv } from './cn';
import { DueChip } from './DueChip';
import { Kbd } from './Kbd';
import { LabelList, type LabelListItem } from './LabelChip';
import { BlockedMarker, ProgressMark, type ProgressMarkProps, SubtaskProgress, SubtaskRing } from './Markers';
import { type Priority, STATUS_LABELS, type TaskStatus } from './meta';
import { CycleGlyph, type CycleGlyphState, MilestoneGlyph } from './PlanningGlyph';
import { PriorityGlyph, showsPriorityOnCards } from './PriorityGlyph';
import { Skeleton } from './Skeleton';
import { StatusGlyph } from './StatusGlyph';

/* Visual pieces of the Margin board (frames 029–044; margin.css .board, .col, .card, .colc, .lanes). Drag and
   drop wiring (React Aria useDragAndDrop) lives in features/board; these components only draw the states.
   Arbitrary values kept on purpose: the design's 1.5px dashed borders (ghost, empty column) have no border
   token, and the vertical column name needs writing-mode. */

// ── Card ────────────────────────────────────────────────────────────────────────────────────────────

/**
 * Card frame (margin.css .card): boxless, a light surface with the card shadow, radius md. `state` forces a
 * look (gallery, drag preview). Without it the card follows attributes when used as a GridListItem className:
 * data-hovered (React Aria), data-cursor (the board's keyboard cursor: accent ring), data-multi (selected
 * with X: ring on --accent-soft), focus-visible, and data-dragging (the source slot turns into the ghost).
 */
export const boardCardStyles = tv({
  base: [
    'relative box-border flex shrink-0 cursor-pointer flex-col gap-1.5 rounded-md bg-surface px-3.25 py-2.75 text-fg shadow-card outline-none',
    'hovered:bg-surface-hover',
    'focus-visible:outline-2 focus-visible:outline-accent focus-visible:outline-solid',
    'data-cursor:outline-2 data-cursor:outline-accent data-cursor:outline-solid',
    'data-multi:bg-accent-soft data-multi:outline-2 data-multi:outline-accent data-multi:outline-solid',
    'dragging:border-[1.5px] dragging:border-dashed dragging:border-line dragging:bg-transparent dragging:shadow-none dragging:outline-0 dragging:*:invisible',
  ],
  variants: {
    state: {
      default: '',
      hover: 'bg-surface-hover',
      focus: 'outline-2 outline-accent outline-solid',
      selected: 'outline-2 outline-accent outline-solid',
      multi: 'bg-accent-soft outline-2 outline-accent outline-solid',
      /** The floating card under the pointer. */
      dragging: 'z-5 rotate-2 shadow-lift',
      /** The empty slot the dragged card left behind. */
      ghost: 'min-h-16 border-[1.5px] border-dashed border-line bg-transparent shadow-none *:invisible',
    },
    /** A subtask shown as its own card: tighter. */
    child: { true: 'gap-1 px-3 py-2', false: '' },
  },
  defaultVariants: { child: false },
});

export interface BoardCardMember {
  name: string;
  kind: MemberKind;
  hue?: number;
  initials?: string;
}

export interface BoardCardContentProps {
  /** "PAY-142". */
  taskKey: string;
  title: string;
  /** Show the key (the "Key" property). Default true. */
  showKey?: boolean;
  /** Drawn only for Urgent and High (cards never show Medium, Low or None). */
  priority?: Priority | number | null;
  /** Labels: the first two as chips, then "+N". */
  labels?: readonly LabelListItem[] | null;
  /** Subtask progress "2/6" with its ring. Nothing when total is 0. */
  subtasks?: { done: number; total: number } | null;
  /**
   * Criteria progress "4/6" (M6, frame 023), after subtasks and before the due date. Spread a
   * WorkItemProgress in. Nothing when total is 0: a task without criteria shows no marker.
   */
  criteria?: Pick<ProgressMarkProps, 'settled' | 'waived' | 'open' | 'total'> | null;
  /** Due date chip. `today` is YYYY-MM-DD; defaults to the browser's day. */
  due?: { dueDate: string; status: TaskStatus; today?: string } | null;
  /** The Blocked marker. */
  blocked?: boolean;
  /** Milestone chip (off by default on M5 boards). `filled` for active and completed milestones. */
  milestone?: { name: string; filled?: boolean } | null;
  /** Cycle chip: "C12" (off by default on M5 boards). */
  cycle?: { label: string; state?: CycleGlyphState; progress?: number } | null;
  /** Avatar at the top right. Pass it only for someone other than the viewer. */
  assignee?: BoardCardMember | null;
  /** A subtask shown as its own card: "↳ PAY-164 Savings goals" above the title. */
  parentRef?: string | null;
  /** Clamp the title at 4 lines instead of 2. */
  fullTitle?: boolean;
  /** More muted facts at the end of the meta line: "Updated 2h". */
  extra?: ReactNode;
}

/**
 * Inside of a card (margin.css .card-t, .card-m, .card-av, .pref): the title first, then one meta line with
 * priority (Urgent and High only), the key small and muted, labels, then on the right Blocked, subtask
 * progress, criteria progress and the due date. The assignee avatar sits at the top right.
 */
export function BoardCardContent({
  taskKey,
  title,
  showKey = true,
  priority,
  labels,
  subtasks,
  criteria,
  due,
  blocked = false,
  milestone,
  cycle,
  assignee,
  parentRef,
  fullTitle = false,
  extra,
}: BoardCardContentProps) {
  const hasPriority = priority != null && showsPriorityOnCards(priority);
  const hasSubtasks = subtasks != null && subtasks.total > 0;
  const hasCriteria = criteria != null && criteria.total > 0;
  const hasLeft = hasPriority || showKey || Boolean(labels?.length) || Boolean(milestone) || Boolean(cycle);
  const hasRight = blocked || hasSubtasks || hasCriteria || Boolean(due) || extra != null;
  return (
    <>
      {assignee ? (
        <span title={assignee.name} className="absolute top-2.75 right-3 flex">
          <Avatar {...assignee} />
        </span>
      ) : null}
      {parentRef ? (
        <span className="flex min-w-0 items-center gap-1.25 text-xs font-medium text-fg-3">
          <span aria-hidden>↳</span>
          <span className="sr-only">Subtask of </span>
          <span className="truncate">{parentRef}</span>
        </span>
      ) : null}
      <div
        className={cn(
          'text-md leading-snug font-medium text-pretty text-fg',
          fullTitle ? 'line-clamp-4' : 'line-clamp-2',
          assignee && 'pr-6',
        )}
      >
        {title}
      </div>
      {hasLeft || hasRight ? (
        <div className="flex min-h-5 flex-wrap items-center gap-x-1.5 gap-y-1.25">
          {hasPriority ? <PriorityGlyph priority={priority} context="compact" keepSpace={false} /> : null}
          {showKey ? (
            <span className="text-xs font-medium whitespace-nowrap text-fg-3 tabular-nums">{taskKey}</span>
          ) : null}
          {labels?.length ? <LabelList labels={labels} max={2} surface="lane" /> : null}
          {milestone ? (
            <Chip glyph={<MilestoneGlyph filled={milestone.filled} />} className="bg-bg-lane">
              {milestone.name}
            </Chip>
          ) : null}
          {cycle ? (
            <Chip
              glyph={<CycleGlyph state={cycle.state} progress={cycle.progress} />}
              className="shrink-0 bg-bg-lane"
            >
              {cycle.label}
            </Chip>
          ) : null}
          {hasRight ? (
            <span className="ml-auto flex items-center gap-1.5">
              {blocked ? <BlockedMarker /> : null}
              {hasSubtasks ? <SubtaskProgress done={subtasks.done} total={subtasks.total} /> : null}
              {hasCriteria ? (
                <ProgressMark {...criteria} noun={criteria.total === 1 ? 'criterion' : 'criteria'} />
              ) : null}
              {due ? <DueChip dueDate={due.dueDate} status={due.status} today={due.today} /> : null}
              {extra}
            </span>
          ) : null}
        </div>
      ) : null}
    </>
  );
}

/** Loading placeholder for one card. */
export function BoardCardSkeleton({ titleWidth = '70%' }: { titleWidth?: string | number }) {
  return (
    <div
      aria-hidden
      className="flex shrink-0 flex-col gap-2 rounded-md bg-surface px-3.25 py-2.75 shadow-card"
    >
      <Skeleton width={titleWidth} />
      <div className="flex items-center gap-1.5">
        <Skeleton width={46} />
        <Skeleton width={58} height={18} className="rounded-pill" />
      </div>
    </div>
  );
}

export interface BoardSubtaskToggleProps {
  /** Subtasks of the card, canceled ones left out. */
  done: number;
  total: number;
  isExpanded: boolean;
  onExpandedChange: (expanded: boolean) => void;
  /** The parent's key, for the accessible name. */
  taskKey: string;
}

/**
 * A parent card's footer (margin.css .card-sub): "▸ 7 subtasks · 2 done" and the ring, under a dashed rule.
 * Pressing it expands the subtask rows in place.
 */
export function BoardSubtaskToggle({
  done,
  total,
  isExpanded,
  onExpandedChange,
  taskKey,
}: BoardSubtaskToggleProps) {
  return (
    <AriaButton
      slot={null}
      onPress={() => onExpandedChange(!isExpanded)}
      aria-expanded={isExpanded}
      aria-label={`${isExpanded ? 'Hide' : 'Show'} the ${total} ${total === 1 ? 'subtask' : 'subtasks'} of ${taskKey}, ${done} done`}
      className="mt-px flex cursor-pointer items-center gap-1.5 border-t border-dashed border-line pt-2 text-left text-xs font-medium text-fg-2 outline-none hover:text-fg focus-visible:focus-ring"
    >
      <Triangle open={isExpanded} />
      <span>
        {total} {total === 1 ? 'subtask' : 'subtasks'} · {done} done
      </span>
      <span className="flex-1" />
      <SubtaskRing done={done} total={total} />
    </AriaButton>
  );
}

/** The ▸ / ▾ disclosure triangle (margin.css .tri). */
function Triangle({ open, className }: { open: boolean; className?: string }) {
  return (
    <svg
      aria-hidden
      viewBox="0 0 8 8"
      width="8"
      height="8"
      className={cn('shrink-0 fill-current transition-transform', open && 'rotate-90', className)}
    >
      <path d="M2.5 1 6 4 2.5 7z" />
    </svg>
  );
}

export interface BoardSubtaskRowProps {
  taskKey: string;
  title: string;
  status: TaskStatus;
  /** Avatar at the end; pass it only for someone other than the viewer. */
  assignee?: BoardCardMember | null;
  onPress?: () => void;
}

/** One subtask under an expanded parent card (margin.css .kid): status, key, title, avatar. */
export function BoardSubtaskRow({ taskKey, title, status, assignee, onPress }: BoardSubtaskRowProps) {
  return (
    <AriaButton
      slot={null}
      onPress={onPress}
      aria-label={`${taskKey} ${title}, ${STATUS_LABELS[status]}`}
      className="flex h-7 w-full cursor-pointer items-center gap-2 rounded-sm px-1 text-left text-sm whitespace-nowrap outline-none hover:bg-bg-lane focus-visible:focus-ring-inset"
    >
      <StatusGlyph status={status} decorative />
      <span className="w-15.5 shrink-0 text-xs font-medium text-fg-3 tabular-nums">{taskKey}</span>
      <span className="min-w-0 flex-1 truncate text-fg">{title}</span>
      {assignee ? <Avatar {...assignee} decorative /> : null}
    </AriaButton>
  );
}

/** Classes for the insertion line. Use on a React Aria DropIndicator: visible only while it is the target. */
export const dropIndicatorClass =
  'relative mx-1 -my-0.75 h-0.5 shrink-0 bg-transparent drop-target:bg-accent';

export interface BoardDragHintProps {
  /** The column the card would land in: "In review". */
  target: string;
  className?: string;
}

/** Floating pill at the bottom of the board while a card is dragged (frame 035): "Moving to In review · Esc cancels". */
export function BoardDragHint({ target, className }: BoardDragHintProps) {
  return (
    <div
      aria-hidden
      className={cn(
        'pointer-events-none absolute bottom-5 left-1/2 z-5 flex h-8.5 -translate-x-1/2 items-center gap-1.5 rounded-pill bg-surface-pop pr-2 pl-3.5 text-sm whitespace-nowrap text-fg-2 shadow-pop',
        className,
      )}
    >
      <span>Moving to</span>
      <b className="font-semibold text-fg">{target}</b>
      <Kbd className="ml-1">Esc</Kbd>
      <span>cancels</span>
    </div>
  );
}

// ── Columns ─────────────────────────────────────────────────────────────────────────────────────────

export interface BoardColumnHeaderProps {
  /** The status column's glyph and default name. Other groupings pass `label` and `glyph`. */
  status?: TaskStatus;
  /** Defaults to the status name. */
  label?: string;
  /** Replaces the status glyph: a priority glyph, an avatar, a label dot. */
  glyph?: ReactNode;
  count: number;
  /** Shows the "+" button: new task in this column. */
  onAdd?: () => void;
  /** Makes the name a button that collapses the column. */
  onFold?: () => void;
  className?: string;
}

function nameOf(status: TaskStatus | undefined, label: string | undefined): string {
  return label ?? (status ? STATUS_LABELS[status] : '');
}

/** 38px column header (margin.css .col-hd): glyph, name, count, "+". Also used alone above swimlanes. */
export function BoardColumnHeader({
  status,
  label,
  glyph,
  count,
  onAdd,
  onFold,
  className,
}: BoardColumnHeaderProps) {
  const name = nameOf(status, label);
  const lead = glyph ?? (status ? <StatusGlyph status={status} decorative /> : null);
  const title = (
    <>
      {lead}
      <span className="truncate">{name}</span>
      <span className="font-normal text-fg-3 tabular-nums">{count}</span>
    </>
  );
  return (
    <div
      className={cn(
        'flex h-9.5 shrink-0 items-center gap-2 pr-2.5 pl-3 font-medium whitespace-nowrap text-fg',
        className,
      )}
    >
      {onFold ? (
        <AriaButton
          onPress={onFold}
          aria-expanded
          aria-label={`Fold ${name}, ${count} tasks`}
          className="flex min-w-0 cursor-pointer items-center gap-2 rounded-sm outline-none focus-visible:focus-ring"
        >
          {title}
        </AriaButton>
      ) : (
        <span className="flex min-w-0 items-center gap-2">{title}</span>
      )}
      <span className="flex-1" />
      {onAdd ? (
        <AriaButton
          onPress={onAdd}
          aria-label={`New task in ${name}`}
          className="grid size-6 cursor-pointer place-items-center rounded-sm text-lg leading-none font-normal text-fg-3 outline-none hover:bg-bg-grp hover:text-fg focus-visible:focus-ring"
        >
          +
        </AriaButton>
      ) : null}
    </div>
  );
}

export interface BoardColumnProps {
  /** The status column's glyph and default name. Other groupings pass `label` and `glyph`. */
  status?: TaskStatus;
  /** Defaults to the status name. */
  label?: string;
  glyph?: ReactNode;
  /** Tasks in the column, including those not loaded yet. */
  count: number;
  /** Folded columns are a 38px strip with the name and count written vertically. */
  isFolded?: boolean;
  /** Called with the next folded state: from the folded strip (expand) or the header name (fold). */
  onFoldChange?: (folded: boolean) => void;
  /** A dragged card is over this column: accent outline. */
  isDropTarget?: boolean;
  /**
   * The column refuses the dragged card (a mirrored task cannot change status): cards at half strength and a
   * note under the header. `true` draws the default ColumnRefusal text; a string replaces the text; any other
   * node is drawn as the note.
   */
  refusal?: ReactNode;
  /** "+" in the header. */
  onAdd?: () => void;
  /** Footer under the cards: "49 more · scroll or press J". */
  more?: ReactNode;
  /** Cards (or the GridList holding them). Ignored while folded. */
  children?: ReactNode;
  className?: string;
}

const dropOutline = 'outline-[1.5px] -outline-offset-2 outline-accent outline-dashed';

/** One column (margin.css .col, .colc). Open: header plus a scrolling body on --bg-lane. Folded: a 38px strip. */
export function BoardColumn({
  status,
  label,
  glyph,
  count,
  isFolded = false,
  onFoldChange,
  isDropTarget = false,
  refusal,
  onAdd,
  more,
  children,
  className,
}: BoardColumnProps) {
  const name = nameOf(status, label);
  if (isFolded) {
    return (
      <BoardFoldedColumn
        status={status}
        label={label}
        glyph={glyph}
        count={count}
        isDropTarget={isDropTarget}
        onExpand={onFoldChange ? () => onFoldChange(false) : undefined}
        className={className}
      />
    );
  }
  return (
    <section
      aria-label={`${name}, ${count} tasks`}
      data-status={status}
      data-drop-target={isDropTarget || undefined}
      data-refused={refusal ? true : undefined}
      className={cn(
        'flex min-h-0 min-w-60 max-w-100 flex-1 flex-col rounded-t-lg bg-bg-lane',
        isDropTarget && dropOutline,
        className,
      )}
    >
      <BoardColumnHeader
        status={status}
        label={label}
        glyph={glyph}
        count={count}
        onAdd={onAdd}
        onFold={onFoldChange ? () => onFoldChange(true) : undefined}
      />
      {refusal === true ? (
        <ColumnRefusal />
      ) : typeof refusal === 'string' ? (
        <ColumnRefusal>{refusal}</ColumnRefusal>
      ) : (
        refusal
      )}
      <div
        data-column-body
        className={cn(
          'flex min-h-0 flex-1 flex-col gap-2 overflow-y-auto px-2 pt-0.5 pb-3',
          refusal ? 'opacity-50' : null,
        )}
      >
        {children}
        {more ? (
          <div className="flex h-7 shrink-0 items-center justify-center text-xs text-fg-3">{more}</div>
        ) : null}
      </div>
    </section>
  );
}

export interface BoardFoldedColumnProps {
  status?: TaskStatus;
  label?: string;
  glyph?: ReactNode;
  count: number;
  isDropTarget?: boolean;
  /** Makes the strip a button that opens the column. */
  onExpand?: () => void;
  className?: string;
}

/** Collapsed column (margin.css .colc): glyph, then the name and count written top to bottom. */
export function BoardFoldedColumn({
  status,
  label,
  glyph,
  count,
  isDropTarget = false,
  onExpand,
  className,
}: BoardFoldedColumnProps) {
  const name = nameOf(status, label);
  const strip = (
    <>
      {glyph ?? (status ? <StatusGlyph status={status} decorative /> : null)}
      <span className="flex gap-2 whitespace-nowrap [writing-mode:vertical-rl]">
        <span>{name}</span>
        <span className="font-normal text-fg-3 tabular-nums">{count}</span>
      </span>
    </>
  );
  const stripClass = cn(
    'flex w-9.5 shrink-0 flex-col items-center gap-2.5 self-stretch rounded-t-lg bg-bg-grp pt-3 font-medium text-fg-2',
    isDropTarget && dropOutline,
    className,
  );
  return onExpand ? (
    <AriaButton
      onPress={onExpand}
      aria-expanded={false}
      aria-label={`Expand ${name}, ${count} tasks`}
      data-status={status}
      data-folded
      className={cn(stripClass, 'cursor-pointer outline-none hover:text-fg focus-visible:focus-ring-inset')}
    >
      {strip}
    </AriaButton>
  ) : (
    <section
      aria-label={`${name}, ${count} tasks, folded`}
      data-status={status}
      data-folded
      className={stripClass}
    >
      {strip}
    </section>
  );
}

/** An empty column's dashed box (margin.css .col-empty): "No tasks in Backlog. Drag a card here, or press C." */
export function BoardColumnEmpty({ children, className }: { children: ReactNode; className?: string }) {
  return (
    <div
      className={cn(
        'mx-2 my-1 rounded-md border-[1.5px] border-dashed border-line px-3 py-4.5 text-center text-sm text-fg-3',
        className,
      )}
    >
      {children}
    </div>
  );
}

export interface ColumnRefusalProps {
  /** Defaults to "Status comes from Backlog.md. Change it in the task file." */
  children?: ReactNode;
  className?: string;
}

/**
 * Note under a column header while a mirrored card is dragged: the drop is refused and this says why.
 * BoardColumn draws it through its `refusal` prop.
 */
export function ColumnRefusal({
  children = (
    <>
      Status comes from Backlog.md.
      <br />
      Change it in the task file.
    </>
  ),
  className,
}: ColumnRefusalProps) {
  return (
    <div
      role="note"
      className={cn(
        'mx-2 mb-2 shrink-0 rounded-md border-[1.5px] border-dashed border-line px-2.5 py-2 text-center text-xs text-fg-3',
        className,
      )}
    >
      {children}
    </div>
  );
}

// ── Swimlanes ───────────────────────────────────────────────────────────────────────────────────────

export interface SwimlaneHeaderProps {
  /** "claude-dev", "Webhooks v2", "No assignee". */
  title: ReactNode;
  /** Avatar or glyph before the title. */
  lead?: ReactNode;
  /** Normal-weight note after the title: "for Ana Ruiz". */
  sub?: ReactNode;
  count: number;
  isOpen: boolean;
  onOpenChange?: (open: boolean) => void;
  className?: string;
}

/** 40px lane header (margin.css .lane-t): triangle, avatar, name, count. A button when `onOpenChange` is set. */
export function SwimlaneHeader({
  title,
  lead,
  sub,
  count,
  isOpen,
  onOpenChange,
  className,
}: SwimlaneHeaderProps) {
  const content = (
    <>
      <Triangle open={isOpen} className="text-fg-3" />
      {lead}
      <span className="truncate">{title}</span>
      {sub ? <span className="truncate text-sm font-normal text-fg-3">{sub}</span> : null}
      <span className="font-normal text-fg-3 tabular-nums">{count}</span>
    </>
  );
  const base = cn(
    'flex h-10 w-full shrink-0 items-center gap-2 px-1 text-left font-semibold whitespace-nowrap text-fg',
    className,
  );
  if (!onOpenChange) return <div className={base}>{content}</div>;
  return (
    <AriaButton
      onPress={() => onOpenChange(!isOpen)}
      aria-expanded={isOpen}
      className={cn(base, 'cursor-pointer rounded-sm outline-none focus-visible:focus-ring-inset')}
    >
      {content}
    </AriaButton>
  );
}
