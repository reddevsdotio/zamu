import { useQuery } from '@tanstack/react-query';
import { useNavigate, useRouterState } from '@tanstack/react-router';
import type { TaskListItem, TaskStatus } from '@zamu/contracts';
import { type MouseEvent, type ReactNode, useCallback, useMemo, useRef, useState } from 'react';
import { Link } from 'react-aria-components';
import { togglePeek } from '~/features/peek/store';
import { useTaskFieldKeys } from '~/features/task-fields';
import { useNow } from '~/features/tasks/clock';
import { atTime, formatAge } from '~/features/tasks/format';
import { meQuery } from '~/features/tasks/queries';
import {
  type DisplayOptions,
  type GroupBy,
  type GroupContext,
  groupTasks,
  LIST_STATUS_ORDER,
  rememberTaskNavigation,
  showsProperty,
  type TaskGroup,
  useTaskSelection,
  workItemNoun,
} from '~/features/views';
import { useApi, useWorkspaceId, useWorkspaceSlug } from '~/lib/workspace';
import { workspacePath } from '~/lib/workspace-paths';
import {
  Avatar,
  BlockedMarker,
  CycleGlyph,
  cn,
  DueChip,
  LabelList,
  localToday,
  MilestoneGlyph,
  PriorityGlyph,
  ProgressMark,
  Skeleton,
  StatusGlyph,
  SubtaskProgress,
  useHotkeys,
} from '~/ui';
import { FoldGroup } from './parts';

// Tasks of a milestone or a cycle (frames 108 and 110) in the Margin list rows (margin.css .grp, .row):
//
//   ▾ ◐ In progress 4
//   ▮▮▮ HBR-166  ◐ Offline cache: browse every tab…     • mobile • perf  ◔ 2/6  Nov 14  (cd)   2m
//
// Grouped as the person's list Display options say (status by default), with the same properties,
// the criteria marker (M6, off by default) included.
// J / K or ↓ / ↑ move, X and Shift select, Space peeks, Enter or a click opens the task view (which
// then walks this list: "3 of 12 in Cycle 12"), and the task keys (S, P, A, L …) act on the focused
// or selected tasks. ← / → on a group row fold it.

/** Statuses whose groups start folded. */
const FOLDED: readonly TaskStatus[] = ['done', 'canceled'];

export interface PlanningTaskTableProps {
  'aria-label': string;
  projectKey: string;
  tasks: readonly TaskListItem[];
  display: DisplayOptions;
  /** The page as the task view names it: "Milestone", "Cycle 12". */
  from: string;
  /** The property the page itself stands for: never a row chip or a grouping. */
  hide?: 'milestone' | 'cycle';
  context?: Omit<GroupContext, 'statuses' | 'viewerId' | 'showEmptyGroups'>;
  isLoading?: boolean;
  renderEmptyState?: () => ReactNode;
}

/** The grouping a planning page uses: the page's own field falls back to status. */
export function planningGroupBy(groupBy: GroupBy, hide: 'milestone' | 'cycle' | undefined): GroupBy {
  return hide && groupBy === hide ? 'status' : groupBy;
}

/** Task keys in the order the rows show them (folded groups left out), each once. */
export function visibleKeys(
  groups: readonly TaskGroup<Pick<TaskListItem, 'key'>>[],
  collapsed: ReadonlySet<string>,
): string[] {
  const seen = new Set<string>();
  for (const group of groups) {
    if (collapsed.has(group.key)) continue;
    for (const task of group.tasks) seen.add(task.key);
  }
  return [...seen];
}

/** Not a key press for the list: focus is on a control that handles Enter and Space itself. */
function isControl(target: EventTarget | null): boolean {
  return (
    target instanceof Element && target.closest('a, button, input, textarea, select, [role="button"]') != null
  );
}

export function PlanningTaskTable({
  projectKey,
  tasks,
  display,
  from,
  hide,
  context,
  isLoading,
  renderEmptyState,
  ...props
}: PlanningTaskTableProps) {
  const workspaceId = useWorkspaceId();
  const workspace = useWorkspaceSlug();
  const api = useApi();
  const navigate = useNavigate();
  const location = useRouterState({ select: (state) => state.location.href });
  const viewerId = useQuery(meQuery(api)).data?.user.id ?? null;
  const now = useNow();
  const groupBy = planningGroupBy(display.groupBy, hide);
  const groups = useMemo(
    () =>
      groupTasks(tasks, groupBy, {
        ...context,
        statuses: LIST_STATUS_ORDER,
        viewerId,
        showEmptyGroups: false,
      }),
    [tasks, groupBy, context, viewerId],
  );
  const [collapsed, setCollapsed] = useState<ReadonlySet<string>>(
    () => new Set(groupBy === 'status' ? FOLDED : []),
  );
  const keys = useMemo(() => visibleKeys(groups, collapsed), [groups, collapsed]);
  const byKey = useMemo(() => new Map(tasks.map((task) => [task.key, task])), [tasks]);

  const rows = useRef(new Map<string, HTMLElement>());
  const focusedRow = useRef<HTMLElement | null>(null);
  const selection = useTaskSelection(keys, {
    view: from,
    onFocusChange: (key) => {
      if (key) rows.current.get(key)?.scrollIntoView?.({ block: 'nearest' });
    },
  });
  focusedRow.current = selection.focusedKey ? (rows.current.get(selection.focusedKey) ?? null) : null;

  const targets = useMemo(
    () =>
      selection.targetKeys.map((key) => byKey.get(key)).filter((task): task is TaskListItem => task != null),
    [selection.targetKeys, byKey],
  );
  const fieldKeys = useTaskFieldKeys({ targets, anchors: focusedRow });

  const remember = useCallback(
    (key: string) => rememberTaskNavigation(workspaceId, { keys, from, returnTo: location }, key),
    [workspaceId, keys, from, location],
  );
  const open = useCallback(
    (key: string) => {
      remember(key);
      void navigate({
        to: '/w/$workspace/p/$projectKey/$taskKey',
        params: { workspace, projectKey, taskKey: key },
      });
    },
    [remember, navigate, projectKey, workspace],
  );

  const focusedKey = selection.focusedKey;
  useHotkeys({
    Enter: {
      preventDefault: false,
      handler: (event) => {
        if (!focusedKey || isControl(event.target)) return;
        event.preventDefault();
        open(focusedKey);
      },
    },
    Space: {
      preventDefault: false,
      handler: (event) => {
        if (!focusedKey || isControl(event.target)) return;
        event.preventDefault();
        togglePeek({ key: focusedKey, keys, from, onMove: (key) => selection.focus(key) });
      },
    },
  });

  const toggleGroup = (key: string) =>
    setCollapsed((current) => {
      const next = new Set(current);
      if (next.has(key)) next.delete(key);
      else next.add(key);
      return next;
    });

  if (isLoading && !tasks.length) {
    return (
      <div role="status" aria-busy="true" aria-label="Loading tasks" className="flex flex-col pt-1.5">
        {[46, 38, 52, 30, 44, 36].map((width) => (
          <div key={width} className="flex h-9.5 items-center gap-2.5 pr-4.5 pl-8">
            <Skeleton width={48} height={8} />
            <Skeleton width={13} height={13} round />
            <Skeleton width={`${width}%`} height={8} />
          </div>
        ))}
      </div>
    );
  }
  if (!groups.length) return renderEmptyState?.() ?? null;

  const age = atTime(formatAge, now);
  const today = now == null ? undefined : localToday(new Date(now));

  return (
    <section aria-label={props['aria-label']} className="pb-6">
      {fieldKeys.pickers}
      {groups.map((group) => {
        const isOpen = !collapsed.has(group.key);
        return (
          <section key={group.key} aria-label={`${group.label}, ${group.tasks.length}`}>
            {groupBy === 'none' ? null : (
              <FoldGroup
                label={group.label}
                count={group.tasks.length}
                expanded={isOpen}
                onToggle={() => toggleGroup(group.key)}
                glyph={
                  group.value.field === 'status' ? (
                    <StatusGlyph status={group.value.status} decorative />
                  ) : undefined
                }
              />
            )}
            {isOpen ? (
              <ul className="m-0 list-none p-0">
                {group.tasks.map((task) => (
                  <TaskRow
                    key={task.key}
                    task={task}
                    projectKey={projectKey}
                    display={display}
                    hide={hide}
                    viewerId={viewerId}
                    today={today}
                    updated={age(task.updatedAt)}
                    created={age(task.createdAt)}
                    isFocused={selection.focusedKey === task.key}
                    isSelected={selection.isSelected(task.key)}
                    rowRef={(element) => {
                      if (element) rows.current.set(task.key, element);
                      else rows.current.delete(task.key);
                    }}
                    onClick={(event) => {
                      if ((event.target as Element).closest('a')) return;
                      if (window.getSelection()?.toString()) return;
                      if (selection.handleClick(task.key, event)) return;
                      open(task.key);
                    }}
                    onLinkPress={() => {
                      selection.focus(task.key);
                      remember(task.key);
                    }}
                  />
                ))}
              </ul>
            ) : null}
          </section>
        );
      })}
    </section>
  );
}

interface TaskRowProps {
  task: TaskListItem;
  projectKey: string;
  display: DisplayOptions;
  hide: 'milestone' | 'cycle' | undefined;
  viewerId: string | null;
  today: string | undefined;
  updated: string;
  created: string;
  isFocused: boolean;
  isSelected: boolean;
  rowRef: (element: HTMLLIElement | null) => void;
  onClick: (event: MouseEvent<HTMLLIElement>) => void;
  onLinkPress: () => void;
}

function TaskRow({
  task,
  projectKey,
  display,
  hide,
  viewerId,
  today,
  updated,
  created,
  isFocused,
  isSelected,
  rowRef,
  onClick,
  onLinkPress,
}: TaskRowProps) {
  const workspace = useWorkspaceSlug();
  const shows = (property: Parameters<typeof showsProperty>[1]) =>
    showsProperty(display, property, task, viewerId);
  const subtasks = task.subtaskProgress;
  const avatarSlot = display.properties.assignee;
  return (
    // biome-ignore lint/a11y/useKeyWithClickEvents: the title link and the list keys are the keyboard path
    <li
      ref={rowRef}
      data-key={task.key}
      data-focused={isFocused || undefined}
      data-selected={isSelected || undefined}
      onClick={onClick}
      className={cn(
        'relative flex h-9.5 cursor-pointer items-center gap-2.5 pr-4.5 pl-4 whitespace-nowrap',
        isFocused || isSelected ? 'bg-accent-soft' : 'hover:bg-surface-hover',
        isFocused && 'shadow-[inset_2px_0_0_var(--accent)]',
      )}
    >
      {display.properties.priority ? <PriorityGlyph priority={task.priority} context="compact" /> : null}
      {shows('key') ? (
        <span className="w-15.5 shrink-0 text-xs font-medium text-fg-3 tabular-nums">{task.key}</span>
      ) : null}
      <StatusGlyph status={task.status} />
      <Link
        href={workspacePath(
          workspace,
          `/p/${encodeURIComponent(projectKey)}/${encodeURIComponent(task.key)}`,
        )}
        onPress={onLinkPress}
        className="min-w-0 flex-1 cursor-pointer truncate font-[450] text-fg outline-none focus-visible:underline"
      >
        {task.title}
        {isSelected ? <span className="sr-only"> (selected)</span> : null}
      </Link>
      <span className="flex shrink-0 items-center gap-2">
        {shows('blocked') && task.blocked ? <BlockedMarker /> : null}
        {shows('labels') && task.labels?.length ? <LabelList labels={task.labels} max={2} /> : null}
        {shows('subtasks') && subtasks && subtasks.total > 0 ? (
          <SubtaskProgress done={subtasks.done} total={subtasks.total} />
        ) : null}
        {shows('criteria') && task.criteriaProgress && task.criteriaProgress.total > 0 ? (
          <ProgressMark
            {...task.criteriaProgress}
            noun={workItemNoun('criteria', task.criteriaProgress.total)}
          />
        ) : null}
        {shows('due') && task.dueDate ? (
          <DueChip dueDate={task.dueDate} status={task.status} {...(today ? { today } : {})} />
        ) : null}
        {hide !== 'milestone' && shows('milestone') && task.milestone ? (
          <span className="inline-flex max-w-40 items-center gap-1.5 text-xs text-fg-2">
            <MilestoneGlyph className="text-fg-3" />
            <span className="truncate">{task.milestone.name}</span>
          </span>
        ) : null}
        {hide !== 'cycle' && shows('cycle') && task.cycle ? (
          <span className="inline-flex items-center gap-1.5 text-xs text-fg-2">
            <CycleGlyph className="text-fg-3" />
            Cycle {task.cycle.number}
          </span>
        ) : null}
        {shows('created') ? <span className="text-xs text-fg-3 tabular-nums">{created}</span> : null}
        {avatarSlot ? (
          shows('assignee') && task.assignee ? (
            <Avatar name={task.assignee.name} kind={task.assignee.kind} size={18} />
          ) : (
            <span aria-hidden className="size-4.5 shrink-0" />
          )
        ) : null}
        {shows('updated') ? (
          <time dateTime={task.updatedAt} className="w-10 text-right text-xs text-fg-3 tabular-nums">
            {updated}
          </time>
        ) : null}
      </span>
    </li>
  );
}
