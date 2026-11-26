import type { HomeGroupKey, HomeItem, HomeTab } from '@zamu/contracts';
import type { MouseEvent, ReactNode, Ref } from 'react';
import { useWorkspaceSlug } from '~/lib/workspace';
import { workspacePath } from '~/lib/workspace-paths';
import { Avatar, cn, DueChip, Pill, PriorityGlyph, ProjectTile, StatusGlyph } from '~/ui';
import { criteriaPillText, pillView, rowAvatar, shownPills, showsDueChip, whyText } from './format';

// A Home row (components.md "Home row", frame 099; screens.css .row .proj, .why):
//
//   [!] [H] Harbor  HBR-110  ◔  Point the mobile client at …      blocks 2  Nov 14  claude-dev · 40 min ago  [cd]
//
// Priority (urgent and high only), the project tile and name, key, status, title, then pills (on Needs
// review rows first the criteria pill, "4 of 6 criteria"), the due
// chip, the "why" line and the assignee. The row is a link to the task: a click opens it, Shift and
// ⌘/Ctrl clicks select. Home rows are their own component: their columns differ from a project's list.

export interface HomeRowProps {
  item: HomeItem;
  tab: HomeTab;
  /** The row's group: Needs review rows add the criteria pill. */
  group?: HomeGroupKey;
  viewerId: string | undefined;
  now: number | null;
  /** The keyboard focus (J / K): the accent background. */
  focused: boolean;
  /** In the selection (X, Shift, ⌘A). */
  selected: boolean;
  /** Agents' "Waiting on a person" rows leave the priority out (frame 101). */
  showPriority?: boolean;
  rowRef?: Ref<HTMLAnchorElement>;
  onFocus: () => void;
  /** A click: opens the task, or selects with Shift or ⌘/Ctrl (the screen decides). */
  onClick: (event: MouseEvent<HTMLAnchorElement>) => void;
  className?: string;
}

const ROW =
  'relative flex h-(--row-h) items-center gap-2.5 pr-4.5 pl-4 whitespace-nowrap text-fg no-underline outline-none';

export function HomeRow({
  item,
  tab,
  group,
  viewerId,
  now,
  focused,
  selected,
  showPriority = true,
  rowRef,
  onFocus,
  onClick,
  className,
}: HomeRowProps) {
  const workspace = useWorkspaceSlug();
  const { task } = item;
  const why = whyText(item, tab, viewerId, now);
  const avatar = rowAvatar(item, tab, viewerId);
  const criteria = criteriaPillText(item, group);
  return (
    <a
      ref={rowRef}
      href={workspacePath(workspace, `/p/${task.project.key}/${task.key}`)}
      data-task-key={task.key}
      data-focused={focused || undefined}
      aria-current={focused ? 'true' : undefined}
      data-selected={selected || undefined}
      onFocus={onFocus}
      onClick={onClick}
      className={cn(
        ROW,
        focused || selected ? 'bg-accent-soft' : 'hover:bg-surface-hover',
        // A selected row also gets an accent edge, so the selection reads apart from the J / K focus.
        selected && 'shadow-[inset_2px_0_0_var(--accent)]',
        className,
      )}
    >
      {showPriority ? <PriorityGlyph priority={task.priority} context="compact" /> : null}
      <span className="inline-flex w-23 shrink-0 items-center gap-1.5 overflow-hidden text-xs font-medium text-fg-3">
        <ProjectTile projectKey={task.project.key} name={task.project.name} size={14} />
        <span className="truncate">{task.project.name}</span>
      </span>
      <span className="w-15.5 shrink-0 text-xs font-medium text-fg-3 tabular-nums">{task.key}</span>
      <StatusGlyph status={task.status} />
      {/* 450: the design's row title weight, between font-normal and font-medium (margin.css .row-t). */}
      <span className="min-w-0 flex-1 truncate font-[450]">{task.title}</span>
      <span className="flex shrink-0 items-center gap-2">
        {criteria ? (
          <Pill tone="default" className="h-4.75" data-criteria-pill="">
            {criteria}
          </Pill>
        ) : null}
        {shownPills(item).map((pill) => {
          const view = pillView(pill);
          return (
            <Pill key={pill.kind} tone={view.tone} className="h-4.75">
              {view.text}
            </Pill>
          );
        })}
        {showsDueChip(item) ? <DueChip dueDate={task.dueDate ?? null} status={task.status} /> : null}
        <Why>{why}</Why>
        {avatar ? (
          <Avatar name={avatar.name} kind={avatar.kind === 'agent' ? 'agent' : 'person'} />
        ) : (
          <span aria-hidden className="size-4.5 shrink-0" />
        )}
      </span>
    </a>
  );
}

function Why({ children }: { children: ReactNode }) {
  return (
    <span className="w-37.5 shrink-0 truncate text-right text-xs text-fg-3" data-why>
      {children}
    </span>
  );
}

export interface GroupHeaderProps {
  title: string;
  count: number;
  hint?: string;
  expanded: boolean;
  onToggle: () => void;
  id: string;
}

/** A group's header (margin.css .grp): ▾, title, count, hint. Collapses the group. */
export function GroupHeader({ title, count, hint, expanded, onToggle, id }: GroupHeaderProps) {
  return (
    <h2 className="m-0 mt-1.5 text-md font-medium">
      <button
        type="button"
        id={id}
        aria-expanded={expanded}
        onClick={onToggle}
        className="flex h-10 w-full cursor-pointer items-center gap-2.25 border-0 border-b border-solid border-line bg-transparent pr-4.5 pl-4 text-left text-md font-medium text-fg outline-none focus-visible:shadow-[var(--focus-ring)]"
      >
        <Triangle open={expanded} />
        <span>{title}</span>
        <span className="font-normal text-fg-3 tabular-nums">{count}</span>
        {hint ? <span className="truncate text-sm font-normal text-fg-3">{hint}</span> : null}
      </button>
    </h2>
  );
}

function Triangle({ open }: { open: boolean }) {
  return (
    <svg
      aria-hidden
      viewBox="0 0 7 7"
      width="7"
      height="7"
      className={cn('mr-0.5 shrink-0 text-fg-3 transition-transform', open ? 'rotate-0' : '-rotate-90')}
    >
      <path d="M0 1.5h7L3.5 6z" fill="currentColor" />
    </svg>
  );
}
