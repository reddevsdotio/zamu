import { Link } from '@tanstack/react-router';
import { isOpenStatus, milestoneProgressRatio, type Task } from '@zamu/contracts';
import { type ComponentProps, type ReactNode, type RefObject, useEffect, useRef, useState } from 'react';
import {
  Button as AriaButton,
  Tooltip as AriaTooltip,
  TooltipTriggerStateContext,
} from 'react-aria-components';
import { cycleLabel, type ProjectPlanning, type TaskFieldKey } from '~/features/task-fields';
import { isFromDefaults, progressNote, progressOf } from '~/features/work-record/ops';
import { useWorkspaceSlug } from '~/lib/workspace';
import {
  Avatar,
  BlockedNotice,
  cn,
  DueChip,
  Kbd,
  LabelChip,
  LockGlyph,
  localToday,
  PriorityGlyph,
  ProgressBar,
  ProgressBox,
  StatusGlyph,
  UnassignedAvatar,
} from '~/ui';
import { formatDateRange, formatDay } from './format';
import { FromTheFile } from './MirroredTask';
import { projectOfKey } from './TaskPageRelations';

// The task view's properties (screens.css .props, frames 051, 053, 054): a row per field with its value
// or a placeholder ("Set priority"). A row opens its picker (the same as the field's key, shown on
// hover). Fields Backlog.md owns show a lock on hover, and a press says where to change them. Mirrored
// tasks end with "From the file". M6 adds "Criteria" and "Done items" under the assignee (frames 001,
// 004, 021): the count with "1 waived · 1 open", "None yet", or "project defaults"; a press moves focus
// to the list, like ⇧X.

/** The lock tooltip of a field Backlog.md owns (frame 054). */
export const LOCKED_FIELD_TEXT = 'Set in Backlog.md. Edit the file to change it.';

/** How long the lock tooltip stays after an edit attempt. */
const LOCK_TIP_MS = 2500;

/** The lock tooltip over `triggerRef` while `isOpen`; it closes itself after a moment. */
export function LockTooltip({
  triggerRef,
  isOpen,
  onClose,
  placement = 'bottom end',
}: {
  triggerRef: RefObject<Element | null>;
  isOpen: boolean;
  onClose: () => void;
  placement?: 'bottom end' | 'bottom start';
}) {
  useEffect(() => {
    if (!isOpen) return;
    const timer = setTimeout(onClose, LOCK_TIP_MS);
    return () => clearTimeout(timer);
  }, [isOpen, onClose]);
  // A tooltip without its trigger: React Aria reads the open state from this context.
  const state = { isOpen, open: () => {}, close: onClose } as unknown as ComponentProps<
    typeof TooltipTriggerStateContext.Provider
  >['value'];
  return (
    <TooltipTriggerStateContext.Provider value={state}>
      <AriaTooltip
        triggerRef={triggerRef}
        isOpen={isOpen}
        onOpenChange={(open) => {
          if (!open) onClose();
        }}
        placement={placement}
        offset={4}
        className="flex min-h-7 max-w-80 items-center gap-2 rounded-sm bg-fg py-1 pr-2 pl-2.5 text-xs leading-snug font-medium text-bg"
      >
        {LOCKED_FIELD_TEXT}
      </AriaTooltip>
    </TooltipTriggerStateContext.Provider>
  );
}

const SHORTCUTS: Partial<Record<TaskFieldKey, string>> = {
  status: 'S',
  priority: 'P',
  assignee: 'A',
  labels: 'L',
  dueDate: '⇧D',
  milestone: '⇧M',
  cycle: '⇧C',
};

const ARIA_SHORTCUTS: Partial<Record<TaskFieldKey, string>> = {
  status: 's',
  priority: 'p',
  assignee: 'a',
  labels: 'l',
  dueDate: 'Shift+D',
  milestone: 'Shift+M',
  cycle: 'Shift+C',
};

const rowClass =
  'group relative -mx-1.5 grid min-h-8 w-[calc(100%+12px)] grid-cols-[92px_minmax(0,1fr)] items-start gap-2 rounded-sm px-1.5 py-1.5 text-left';

function Placeholder({ children }: { children: ReactNode }) {
  return <span className="font-normal text-fg-3">{children}</span>;
}

/** A property that opens its picker: the row is the button, the picker opens under it. */
function FieldRow({
  label,
  field,
  rowRef,
  isOpen,
  locked,
  onOpen,
  children,
}: {
  label: string;
  field: TaskFieldKey;
  rowRef: RefObject<HTMLButtonElement | null>;
  /** The row's picker is open. */
  isOpen: boolean;
  /** Backlog.md owns the value. */
  locked: boolean;
  onOpen: (field: TaskFieldKey) => void;
  children: ReactNode;
}) {
  const kbd = SHORTCUTS[field];
  return (
    <AriaButton
      ref={rowRef}
      onPress={() => onOpen(field)}
      aria-label={`${label}${locked ? ', set in Backlog.md' : ''}`}
      aria-keyshortcuts={locked ? undefined : ARIA_SHORTCUTS[field]}
      aria-haspopup={locked ? undefined : 'dialog'}
      data-field={field}
      data-locked={locked || undefined}
      className={cn(
        rowClass,
        'cursor-pointer outline-none hover:bg-bg-grp focus-visible:shadow-[var(--focus-ring)]',
        isOpen && 'bg-bg-grp',
      )}
    >
      <span className="text-sm leading-5 text-fg-3">{label}</span>
      <span className="flex min-h-5 min-w-0 flex-wrap items-center gap-1.75 pr-5 text-md font-medium text-fg">
        {children}
      </span>
      {locked ? (
        <LockGlyph className="absolute top-3 right-2 text-fg-3 opacity-0 group-hover:opacity-100 group-focus-visible:opacity-100" />
      ) : kbd ? (
        <Kbd aria-hidden className="absolute top-1.75 right-1.5 opacity-0 group-hover:opacity-100">
          {kbd}
        </Kbd>
      ) : null}
    </AriaButton>
  );
}

/** A work-record row (Criteria, Done items): the count, or a placeholder. A press focuses the list. */
function WorkRow({
  label,
  shortcut,
  onPress,
  children,
}: {
  label: string;
  /** aria-keyshortcuts of the key that does the same (Shift+X). */
  shortcut?: string;
  onPress?: () => void;
  children: ReactNode;
}) {
  return (
    <AriaButton
      onPress={onPress}
      aria-label={label}
      aria-keyshortcuts={shortcut}
      data-field={label === 'Criteria' ? 'criteria' : 'doneItems'}
      className={cn(
        rowClass,
        'cursor-pointer outline-none hover:bg-bg-grp focus-visible:shadow-[var(--focus-ring)]',
      )}
    >
      <span className="text-sm leading-5 text-fg-3">{label}</span>
      <span className="flex min-h-5 min-w-0 items-center gap-1.75 text-md font-medium whitespace-nowrap text-fg tabular-nums">
        {children}
      </span>
    </AriaButton>
  );
}

/** "☐ 4 of 6  1 waived · 1 open" for a list, or null when it is empty. */
function WorkCount({ items, note }: { items: Task['criteria']; note?: string | null }) {
  const progress = progressOf(items);
  if (progress.total === 0) return null;
  const checked = progress.settled - progress.waived;
  const extra = note === undefined ? progressNote(progress) : note;
  return (
    <>
      <ProgressBox complete={progress.open === 0} />
      <span>
        {checked} of {progress.total}
      </span>
      {extra ? <span className="min-w-0 truncate text-xs font-normal text-fg-3">{extra}</span> : null}
    </>
  );
}

/** A property that is only shown (parent, dates). */
function StaticRow({ label, children }: { label: string; children: ReactNode }) {
  return (
    <div className={rowClass}>
      <span className="text-sm leading-5 text-fg-3">{label}</span>
      <span className="flex min-h-5 min-w-0 flex-wrap items-center gap-1.75 text-md font-medium text-fg">
        {children}
      </span>
    </div>
  );
}

/**
 * The Parent row: opens the parent picker like the other rows, and the parent's key and title stay a
 * link to it (drawn above the row's button, so both work).
 */
function ParentRow({
  parent,
  rowRef,
  isOpen,
  locked,
  onOpen,
}: {
  parent: Task['parent'];
  rowRef: RefObject<HTMLButtonElement | null>;
  isOpen: boolean;
  locked: boolean;
  onOpen: (field: TaskFieldKey) => void;
}) {
  const workspace = useWorkspaceSlug();
  return (
    <div className={cn(rowClass, 'hover:bg-bg-grp', isOpen && 'bg-bg-grp')}>
      <AriaButton
        ref={rowRef}
        onPress={() => onOpen('parent')}
        aria-label={`Parent${locked ? ', set in Backlog.md' : ''}`}
        aria-haspopup={locked ? undefined : 'dialog'}
        data-field="parent"
        data-locked={locked || undefined}
        className="peer absolute inset-0 cursor-pointer rounded-sm outline-none focus-visible:shadow-[var(--focus-ring)]"
      />
      <span className="pointer-events-none text-sm leading-5 text-fg-3">Parent</span>
      <span className="flex min-h-5 min-w-0 flex-wrap items-center gap-1.75 pr-5 text-md font-medium text-fg">
        {parent ? (
          <Link
            to="/w/$workspace/p/$projectKey/$taskKey"
            params={{ workspace, projectKey: projectOfKey(parent.key), taskKey: parent.key }}
            className="relative z-1 flex min-w-0 items-center gap-1.75 rounded-sm outline-none hover:underline focus-visible:focus-ring"
          >
            <span className="shrink-0 text-sm text-fg-3 tabular-nums">{parent.key}</span>
            <span className="truncate font-normal">{parent.title}</span>
          </Link>
        ) : (
          <span className="pointer-events-none">
            <Placeholder>None</Placeholder>
          </span>
        )}
      </span>
      {locked ? (
        <LockGlyph className="pointer-events-none absolute top-3 right-2 text-fg-3 opacity-0 peer-hover:opacity-100 peer-focus-visible:opacity-100" />
      ) : null}
    </div>
  );
}

const Separator = () => <div aria-hidden className="my-2 h-px bg-line-soft" />;

/** First name of a person, for "claude-dev for Ana". */
const firstName = (name: string) => name.trim().split(/\s+/)[0] ?? name;

export type PropertyAnchors = Record<
  'status' | 'priority' | 'assignee' | 'labels' | 'dueDate' | 'parent' | 'milestone' | 'cycle',
  RefObject<HTMLButtonElement | null>
>;

export interface TaskPropertiesProps {
  task: Task;
  planning: ProjectPlanning;
  anchors: PropertyAnchors;
  /** The field whose picker is open. */
  openField: TaskFieldKey | null;
  /** Opens the field's picker (as its key does). */
  onOpenField: (field: TaskFieldKey) => void;
  /** The locked field whose tooltip shows after an edit attempt. */
  lockTip: TaskFieldKey | null;
  onLockTipClose: () => void;
  /** Who changed the task last, from its history: "claude-dev". */
  updatedBy?: string | null;
  /** Times bound to the clock (empty during hydration). */
  time: (value: string) => string;
  now: number | null;
  /** M6: the project's default done items, for "project defaults". */
  defaults?: readonly string[];
  /** M6: the Criteria row moves focus to the first open criterion. */
  onFocusCriteria?: () => void;
  /** M6: the Done items row moves focus to the first open done item. */
  onFocusDone?: () => void;
}

export function TaskProperties({
  task,
  planning,
  anchors,
  openField,
  onOpenField,
  lockTip,
  onLockTipClose,
  updatedBy,
  time,
  now,
  defaults = [],
  onFocusCriteria,
  onFocusDone,
}: TaskPropertiesProps) {
  const locked = new Set(task.locked ?? []);
  const isMirrored = locked.size > 0;
  const openBlockers = (task.blockedBy ?? []).filter(
    (item) => item != null && isOpenStatus(item.status),
  ).length;
  const today = now == null ? undefined : localToday(new Date(now));
  const milestone = task.milestone
    ? planning.milestones?.find((item) => item.id === task.milestone?.id)
    : undefined;
  const ratio = milestone ? milestoneProgressRatio(milestone.progress) : null;
  const labels = task.labels ?? [];
  const row = (field: keyof PropertyAnchors, label: string, owned: boolean, children: ReactNode) => (
    <FieldRow
      label={label}
      field={field}
      rowRef={anchors[field]}
      isOpen={openField === field}
      locked={owned}
      onOpen={onOpenField}
    >
      {children}
    </FieldRow>
  );
  const lockAnchor = lockTip && lockTip in anchors ? anchors[lockTip as keyof PropertyAnchors] : null;

  return (
    <aside
      aria-label="Properties"
      className="flex min-h-0 flex-col overflow-y-auto border-l border-line px-4.5 py-4.5"
    >
      {openBlockers > 0 ? <BlockedNotice count={openBlockers} className="mb-2" /> : null}
      {row('status', 'Status', locked.has('status'), <StatusGlyph status={task.status} withLabel />)}
      {row(
        'priority',
        'Priority',
        locked.has('priority'),
        task.priority === 'none' ? (
          <>
            <PriorityGlyph priority="none" decorative />
            <Placeholder>Set priority</Placeholder>
          </>
        ) : (
          <PriorityGlyph priority={task.priority} withLabel />
        ),
      )}
      {row(
        'assignee',
        'Assignee',
        locked.has('assignee'),
        task.assignee ? (
          <>
            <Avatar name={task.assignee.name} kind={task.assignee.kind} decorative />
            <span className="truncate">{task.assignee.name}</span>
            {task.assignee.responsible ? (
              <span className="text-xs font-normal text-fg-3">
                for {firstName(task.assignee.responsible.name)}
              </span>
            ) : null}
          </>
        ) : (
          <>
            <UnassignedAvatar decorative />
            <Placeholder>Assign</Placeholder>
          </>
        ),
      )}
      {isMirrored && !task.criteria?.length ? null : (
        <WorkRow
          label="Criteria"
          shortcut="Shift+X"
          {...(onFocusCriteria ? { onPress: onFocusCriteria } : {})}
        >
          {task.criteria?.length ? (
            <WorkCount items={task.criteria} {...(isMirrored ? { note: null } : {})} />
          ) : (
            <Placeholder>None yet</Placeholder>
          )}
        </WorkRow>
      )}
      {isMirrored && !task.doneItems?.length ? null : (
        <WorkRow label="Done items" {...(onFocusDone ? { onPress: onFocusDone } : {})}>
          {task.doneItems?.length ? (
            <WorkCount
              items={task.doneItems}
              note={
                // A task not started yet, still holding what the project gave it (frame 004).
                !isMirrored &&
                (task.status === 'backlog' || task.status === 'todo') &&
                progressOf(task.doneItems).settled === 0 &&
                isFromDefaults(task.doneItems, defaults)
                  ? 'project defaults'
                  : isMirrored
                    ? null
                    : undefined
              }
            />
          ) : (
            <Placeholder>None yet</Placeholder>
          )}
        </WorkRow>
      )}
      <Separator />
      {row(
        'labels',
        'Labels',
        locked.has('labels'),
        labels.length ? (
          labels.map((label) => <LabelChip key={label.id} name={label.name} color={label.color} />)
        ) : (
          <Placeholder>Add labels</Placeholder>
        ),
      )}
      {row(
        'dueDate',
        'Due',
        locked.has('dueDate'),
        task.dueDate ? (
          <DueChip
            dueDate={task.dueDate}
            status={task.status}
            withDate
            {...(today ? { today } : {})}
            className="text-sm"
          />
        ) : (
          <Placeholder>{isMirrored ? 'None' : 'Set due date'}</Placeholder>
        ),
      )}
      <ParentRow
        parent={task.parent}
        rowRef={anchors.parent}
        isOpen={openField === 'parent'}
        locked={locked.has('parent')}
        onOpen={onOpenField}
      />
      {planning.usesMilestones || planning.usesCycles ? <Separator /> : null}
      {planning.usesMilestones
        ? row(
            'milestone',
            'Milestone',
            locked.has('milestone'),
            task.milestone ? (
              <>
                <span className="truncate">{task.milestone.name}</span>
                {milestone && ratio != null ? (
                  <>
                    <ProgressBar
                      done={milestone.progress.done}
                      total={Math.max(1, milestone.progress.total - milestone.progress.canceled)}
                      label={`${task.milestone.name} progress`}
                      className="max-w-16 min-w-9"
                    />
                    <span className="text-xs font-normal text-fg-3 tabular-nums">
                      {Math.round(ratio * 100)}%
                    </span>
                  </>
                ) : null}
              </>
            ) : (
              <Placeholder>Add to milestone</Placeholder>
            ),
          )
        : null}
      {planning.usesCycles
        ? row(
            'cycle',
            'Cycle',
            false,
            task.cycle ? (
              <>
                <span>{cycleLabel(task.cycle)}</span>
                <span className="text-xs font-normal text-fg-3">
                  {now == null ? '' : formatDateRange(task.cycle.startsOn, task.cycle.endsOn, new Date(now))}
                </span>
              </>
            ) : (
              <Placeholder>Add to cycle</Placeholder>
            ),
          )
        : null}
      <Separator />
      {isMirrored ? null : (
        <StaticRow label="Created">
          <span className="text-xs font-normal text-fg-3">
            {now == null ? '' : `${formatDay(task.createdAt, new Date(now))} by ${task.createdBy.name}`}
          </span>
        </StaticRow>
      )}
      {task.updatedAt !== task.createdAt || isMirrored ? (
        <StaticRow label="Updated">
          <span className="text-xs font-normal text-fg-3">
            {isMirrored
              ? `From the file, ${time(task.updatedAt).replace(/^Just now$/, 'just now')}`
              : `${time(task.updatedAt)}${updatedBy ? ` by ${updatedBy}` : ''}`}
          </span>
        </StaticRow>
      ) : null}
      {isMirrored || task.backlog ? <FromTheFile task={task} /> : null}
      {lockAnchor ? <LockTooltip triggerRef={lockAnchor} isOpen onClose={onLockTipClose} /> : null}
    </aside>
  );
}

/** The lock tooltip state of a screen: which locked field was last pressed. */
export function useLockTip() {
  const [field, setField] = useState<TaskFieldKey | 'title' | 'description' | null>(null);
  const close = useRef(() => setField(null)).current;
  return { field, show: setField, close };
}
