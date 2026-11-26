import { useQuery } from '@tanstack/react-query';
import { useRouter } from '@tanstack/react-router';
import type { Task, TimelineItem } from '@zamu/contracts';
import { type ReactNode, type RefObject, useEffect, useMemo, useRef, useState } from 'react';
import {
  Button as AriaButton,
  TextArea as AriaTextArea,
  TextField as AriaTextField,
  MenuTrigger,
} from 'react-aria-components';
import { CommentComposer } from '~/features/comments/CommentComposer';
import { TaskTimeline } from '~/features/comments/TaskTimeline';
import {
  ARCHIVED_TEXT,
  showFieldToast,
  type TaskFieldKey,
  useFieldChange,
  useProjectPlanning,
  useTaskFieldKeys,
} from '~/features/task-fields';
import { useTaskNavigation } from '~/features/views';
import { FileNotes, PlanSection, TaskSummary, WorkItemSection } from '~/features/work-record';
import { useApi, useWorkspaceId, useWorkspaceSlug } from '~/lib/workspace';
import { type WorkspaceUrlSlug, workspacePath } from '~/lib/workspace-paths';
import {
  ArchivedBar,
  Banner,
  Button,
  type ChecklistHandle,
  ClippedText,
  cn,
  Menu,
  MenuItem,
  MenuSeparator,
  Skeleton,
  Tooltip,
  TooltipTrigger,
  useCopy,
  useHotkeys,
  ViewHeader,
} from '~/ui';
import { MIRRORED_ARCHIVE_TEXT, useArchiveActions } from './archive';
import { useNow } from './clock';
import { describeError } from './errors';
import { atTime, formatDay, formatRelative, toggleCheckbox } from './format';
import { listSearchFor } from './list-memory';
import { Markdown } from './Markdown';
import { backlogHistoryQuery, RemovedBanner, TaskFileBadge, useBacklogSummary } from './MirroredTask';
import { commentPlaceholder, mirrorOf } from './mirror';
import { PullRequestsSection } from './PullRequestsSection';
import { membersQuery, projectsQuery, taskQuery, timelineQuery } from './queries';
import { LockTooltip, type PropertyAnchors, TaskProperties } from './TaskPageProperties';
import { BlockedBySection, projectOfKey, SubtasksSection } from './TaskPageRelations';

// /p/$projectKey/$taskKey: the task view (frames 051–066; M6 001 to 022, 047 to 050). The header holds the
// crumb (the title joins it once the big title scrolls away), ‹ › with "12 of 40 in List", Copy link and
// more. The content column is the work record in this order: the serif title (E edits), the final
// summary when there is one, the description (D edits; clipped to two lines under a summary, where D
// shows it first), acceptance criteria (⇧A adds, ⇧X focuses the first open one), definition of done,
// the plan, Subtasks, Blocked by and the history with the comment box (M comments, N writes a note).
// The properties sit on the right. J / K walk the list the task was opened from; Esc goes back to it
// with the task selected. The task keys (S, P, A, I, L, ⇧D, ⇧M, ⇧C, ⇧B, ⇧S, ⌘C, ⌘⇧C) open their
// pickers over the property rows; a person moving the task to In review or Done with open items sees
// the finishing step first. M7: the pull requests sit between the description and the criteria (⇧P
// links one); ⇧W sets the check-again day; ⇧E archives the task, or restores an archived one. An
// archived task (frame 087) opens with the archived bar, changes nothing, and its comment box says to
// restore it first; a mirrored one shows the bar without Restore (Backlog.md's folder decides).

export interface TaskPageProps {
  projectKey: string;
  taskKey: string;
}

/**
 * The view the task came from (its URL with the filters), with the task focused: ?focus=, which the list
 * and the board read once (?task= would open the task view again).
 */
export function backHref(
  workspace: WorkspaceUrlSlug,
  projectKey: string,
  taskKey: string,
  returnTo: string | null,
): string {
  const url = new URL(
    returnTo ?? workspacePath(workspace, `/p/${encodeURIComponent(projectKey)}`),
    'http://local',
  );
  url.searchParams.delete('task');
  url.searchParams.set('focus', taskKey);
  return `${url.pathname}${url.search}`;
}

/** The done items new tasks of the project start with, from the cached project list. */
function useProjectDefaults(projectKey: string): readonly string[] {
  const api = useApi();
  return (
    useQuery({
      ...projectsQuery(api),
      select: (data) => data.items.find((item) => item.key === projectKey)?.defaultDoneItems,
    }).data ?? NO_DEFAULTS
  );
}

const NO_DEFAULTS: readonly string[] = [];

export function TaskPage({ projectKey, taskKey }: TaskPageProps) {
  const workspace = useWorkspaceSlug();
  const workspaceId = useWorkspaceId();
  const api = useApi();
  const router = useRouter();
  const taskResult = useQuery(taskQuery(api, taskKey));
  const task = taskResult.data;
  const { projectName } = useBacklogSummary(projectKey);
  const nav = useTaskNavigation(workspaceId, taskKey);
  const [titleAway, setTitleAway] = useState(false);
  const { copied, copy } = useCopy();
  // Esc: back to the view the task came from; without one, the list with its last filters.
  const back = () => {
    if (nav.returnTo)
      return void router.navigate({ href: backHref(workspace, projectKey, taskKey, nav.returnTo) });
    void router.navigate({
      to: '/w/$workspace/p/$projectKey',
      params: { workspace, projectKey },
      search: listSearchFor(workspaceId, projectKey, taskKey) as never,
    });
  };

  const go = (key: string | null) => {
    if (!key) return;
    void router.navigate({
      to: '/w/$workspace/p/$projectKey/$taskKey',
      params: { workspace, projectKey: projectOfKey(key), taskKey: key },
    });
  };
  const mirror = mirrorOf(task);
  const toggleArchive = useArchiveToggle();

  return (
    <div className="flex h-dvh min-h-0 min-w-0 flex-1 flex-col bg-bg text-fg">
      <ViewHeader
        project={{
          key: projectKey,
          name: task?.project.name ?? projectName ?? projectKey,
          href: backHref(workspace, projectKey, taskKey, nav.returnTo),
        }}
        taskKey={taskKey}
        actions={
          <>
            {nav.label ? (
              <span className="flex items-center gap-1 text-sm text-fg-3 tabular-nums">
                <NavButton label="Previous task" kbd="K" isDisabled={!nav.prev} onPress={() => go(nav.prev)}>
                  ‹
                </NavButton>
                <NavButton label="Next task" kbd="J" isDisabled={!nav.next} onPress={() => go(nav.next)}>
                  ›
                </NavButton>
                <span className="ml-0.5 whitespace-nowrap">{nav.label}</span>
              </span>
            ) : null}
            <Button variant="secondary" onPress={() => void copy(window.location.href)}>
              {copied ? 'Copied' : 'Copy link'}
            </Button>
            <MoreMenu
              onCopyKey={() => void copy(taskKey)}
              fileUrl={task?.backlog?.fileUrl ?? null}
              archive={task && !mirror.isMirrored ? (task.archivedAt ? 'restore' : 'archive') : null}
              onArchive={() => (task ? toggleArchive(task) : undefined)}
            />
          </>
        }
      >
        {titleAway && task ? (
          <span className="max-w-130 min-w-0 truncate text-md font-medium text-fg-2">{task.title}</span>
        ) : null}
      </ViewHeader>
      {task ? (
        <TaskView
          key={task.key}
          task={task}
          projectKey={projectKey}
          isMirrored={mirror.isMirrored}
          isHidden={mirror.isHidden}
          onTitleAway={setTitleAway}
          onBack={back}
          onPrev={nav.prev ? () => go(nav.prev) : null}
          onNext={nav.next ? () => go(nav.next) : null}
        />
      ) : taskResult.isError ? (
        <TaskPageError error={taskResult.error} onRetry={() => taskResult.refetch()} taskKey={taskKey} />
      ) : (
        <TaskPageSkeleton />
      )}
    </div>
  );
}

function NavButton({
  label,
  kbd,
  isDisabled,
  onPress,
  children,
}: {
  label: string;
  kbd: string;
  isDisabled: boolean;
  onPress: () => void;
  children: ReactNode;
}) {
  return (
    <TooltipTrigger>
      <Button
        variant="secondary"
        iconOnly
        aria-label={label}
        aria-keyshortcuts={kbd.toLowerCase()}
        isDisabled={isDisabled}
        onPress={onPress}
        className="h-7 text-md"
      >
        {children}
      </Button>
      <Tooltip kbd={kbd}>{label}</Tooltip>
    </TooltipTrigger>
  );
}

/**
 * ⇧E on the open task: archive it, or restore it when archived, with the toast and Undo. A mirrored
 * task says where to do it instead.
 */
function useArchiveToggle() {
  const { archive, restore } = useArchiveActions();
  return (task: Task) => {
    if ((task.locked?.length ?? 0) > 0) {
      showFieldToast({ text: MIRRORED_ARCHIVE_TEXT, tone: 'error' });
      return;
    }
    void (task.archivedAt ? restore([task.key]) : archive([task.key]));
  };
}

function MoreMenu({
  onCopyKey,
  fileUrl,
  archive,
  onArchive,
}: {
  onCopyKey: () => void;
  fileUrl: string | null;
  /** M7: Archive or Restore in the menu; null for mirrored tasks. */
  archive?: 'archive' | 'restore' | null;
  onArchive?: () => void;
}) {
  return (
    <MenuTrigger>
      <Button variant="secondary" iconOnly aria-label="More" className="h-7 text-md">
        ···
      </Button>
      <Menu
        aria-label="More"
        onAction={(id) => {
          if (id === 'copy-key') onCopyKey();
          else if (id === 'archive') onArchive?.();
          else if (id === 'file' && fileUrl) window.open(fileUrl, '_blank', 'noreferrer');
        }}
      >
        <MenuItem id="copy-key" kbd="⌘C">
          Copy key
        </MenuItem>
        {archive ? (
          <MenuItem id="archive" kbd="⇧E">
            {archive === 'archive' ? 'Archive' : 'Restore'}
          </MenuItem>
        ) : null}
        {fileUrl ? (
          <>
            <MenuSeparator />
            <MenuItem id="file">Open the file in Backlog.md</MenuItem>
          </>
        ) : null}
      </Menu>
    </MenuTrigger>
  );
}

// ---------------------------------------------------------------------------
// The view
// ---------------------------------------------------------------------------

interface TaskViewProps {
  task: Task;
  projectKey: string;
  isMirrored: boolean;
  isHidden: boolean;
  onTitleAway: (away: boolean) => void;
  onBack: () => void;
  onPrev: (() => void) | null;
  onNext: (() => void) | null;
}

function TaskView({
  task,
  projectKey,
  isMirrored,
  isHidden,
  onTitleAway,
  onBack,
  onPrev,
  onNext,
}: TaskViewProps) {
  const api = useApi();
  const members = useQuery(membersQuery(api)).data?.items ?? [];
  const planning = useProjectPlanning(projectKey);
  const { summary, projectName } = useBacklogSummary(projectKey);
  const history = useQuery({ ...backlogHistoryQuery(api, projectKey), enabled: task.backlog != null }).data;
  const timeline = useQuery(timelineQuery(api, task.key)).data;
  const now = useNow();
  const time = atTime(formatRelative, now);
  const day = atTime(formatDay, now);
  const defaults = useProjectDefaults(projectKey);
  const { apply } = useFieldChange();
  const [editing, setEditing] = useState<'title' | 'description' | null>(null);
  // Under a summary the description starts clipped to two lines; D shows it first (frame 001).
  const hasSummary = Boolean(task.finalSummary?.trim());
  const [descriptionOpen, setDescriptionOpen] = useState(false);
  const criteriaList = useRef<ChecklistHandle>(null);
  const doneList = useRef<ChecklistHandle>(null);
  const [lockTip, setLockTip] = useState<string | null>(null);
  const [revealId, setRevealId] = useState<string | null>(null);
  const [linking, setLinking] = useState(false);
  const locked = new Set(task.locked ?? []);
  // M7: an archived task changes nothing until it is restored.
  const archived = task.archivedAt != null;
  const projectRepository = useProjectRepository(projectKey);
  const toggleArchive = useArchiveToggle();
  const { restore, isPending: isArchiving } = useArchiveActions();

  const statusRow = useRef<HTMLButtonElement>(null);
  const priorityRow = useRef<HTMLButtonElement>(null);
  const assigneeRow = useRef<HTMLButtonElement>(null);
  const labelsRow = useRef<HTMLButtonElement>(null);
  const dueRow = useRef<HTMLButtonElement>(null);
  const milestoneRow = useRef<HTMLButtonElement>(null);
  const cycleRow = useRef<HTMLButtonElement>(null);
  const parentRow = useRef<HTMLButtonElement>(null);
  const checkAgainRow = useRef<HTMLButtonElement>(null);
  const addSubtask = useRef<HTMLButtonElement>(null);
  const addBlocker = useRef<HTMLButtonElement>(null);
  const titleRef = useRef<HTMLHeadingElement>(null);
  const descriptionRef = useRef<HTMLDivElement>(null);
  const scrollRef = useRef<HTMLDivElement>(null);
  const anchors = useMemo<PropertyAnchors>(
    () => ({
      status: statusRow,
      priority: priorityRow,
      assignee: assigneeRow,
      labels: labelsRow,
      dueDate: dueRow,
      parent: parentRow,
      milestone: milestoneRow,
      cycle: cycleRow,
      checkAgain: checkAgainRow,
    }),
    [],
  );
  const fieldAnchors = useMemo(
    () => ({ ...anchors, subtasks: addSubtask, blockedBy: addBlocker }),
    [anchors],
  );

  const ownedBy = (field: TaskFieldKey): boolean => {
    if (field === 'cycle') return false;
    if (field === 'subtasks') return locked.has('parent');
    return locked.has(field as never);
  };

  const keys = useTaskFieldKeys({
    targets: task,
    anchors: fieldAnchors,
    enabled: editing === null,
    // Fields Backlog.md owns answer with the lock tooltip instead of a read-only picker. A move to In
    // review or Done with open items goes through the finishing warning, as everywhere else.
    onOpenField: (field) => {
      if (archived || !ownedBy(field)) return false;
      setLockTip(field);
      return true;
    },
  });

  const startEditing = (part: 'title' | 'description') => {
    if (archived) showFieldToast({ text: ARCHIVED_TEXT, tone: 'error' });
    else if (locked.has(part)) setLockTip(part);
    else setEditing(part);
  };

  // ⇧P: the link field, when the project has a repository to link from.
  const startLinking = () => {
    if (archived) showFieldToast({ text: ARCHIVED_TEXT, tone: 'error' });
    else if (projectRepository === null) {
      showFieldToast({
        text: `${task.project.name} has no repository. Link one in the project settings first.`,
        tone: 'error',
      });
    } else setLinking(true);
  };

  const isNative = locked.size === 0 && !archived;
  useHotkeys(
    {
      Escape: onBack,
      j: onNext,
      k: onPrev,
      e: () => startEditing('title'),
      d: () => {
        if (hasSummary && !descriptionOpen && task.description?.trim()) setDescriptionOpen(true);
        else startEditing('description');
      },
      'Shift+a': isNative ? () => criteriaList.current?.startAdding() : null,
      'Shift+x': () => {
        if (!criteriaList.current?.focusFirstOpen()) doneList.current?.focusFirstOpen();
      },
      'Shift+p': startLinking,
      'Shift+e': () => toggleArchive(task),
    },
    { enabled: editing === null && keys.open === null },
  );

  // The header shows the title once the big one has scrolled away (frame 057).
  useEffect(() => {
    const title = titleRef.current;
    const root = scrollRef.current;
    if (!title || !root || typeof IntersectionObserver === 'undefined') return;
    const observer = new IntersectionObserver(
      ([entry]) => onTitleAway(entry != null && !entry.isIntersecting),
      { root, threshold: 0 },
    );
    observer.observe(title);
    return () => {
      observer.disconnect();
      onTitleAway(false);
    };
  }, [onTitleAway]);

  const lastActor = (() => {
    const items = timeline?.items ?? [];
    for (let index = items.length - 1; index >= 0; index--) {
      const item = items[index];
      if (item?.kind === 'activity' && item.actor) return item.actor.name;
    }
    return null;
  })();

  const mirrorInfo = mirrorOf(task);
  const branchBy = branchStartedBy(timeline?.items, task.workBranch ?? null, day);
  const archivedCause = archivedWhy(task, timeline?.items);

  return (
    <div className="grid min-h-0 flex-1 grid-cols-[minmax(0,1fr)_320px]">
      <div ref={scrollRef} className="min-h-0 min-w-0 overflow-y-auto px-14 pt-8.5 max-[1199px]:px-9">
        <article className="mx-0 flex max-w-180 flex-col pb-10">
          {archived && task.archivedAt ? (
            <ArchivedBar
              className="mb-4"
              on={now == null ? '' : day(task.archivedAt)}
              cause={archivedCause}
              {...(isMirrored
                ? {
                    note: 'It stays out of lists, boards and counts. Move its file out of archive/tasks/ to restore it.',
                  }
                : { onRestore: () => void restore([task.key]), isRestoring: isArchiving })}
            />
          ) : null}
          {isHidden ? <RemovedBanner task={task} branch={summary?.defaultBranch} className="mb-3" /> : null}
          {task.backlog && !isHidden ? (
            <div className="mb-2.5 flex items-center gap-2">
              <TaskFileBadge task={task} />
            </div>
          ) : null}
          <TaskTitle
            task={task}
            quiet={archived}
            headingRef={titleRef}
            isEditing={editing === 'title'}
            onEdit={() => startEditing('title')}
            onDone={() => setEditing(null)}
            onSave={(title) => void apply([task], { title })}
          />
          {lockTip === 'title' ? (
            <LockTooltip
              triggerRef={titleRef}
              isOpen
              onClose={() => setLockTip(null)}
              placement="bottom start"
            />
          ) : null}
          <TaskSummary task={task} time={time} />
          <TaskDescription
            task={task}
            boxRef={descriptionRef}
            isLocked={locked.has('description')}
            archived={archived}
            isEditing={editing === 'description'}
            clipped={hasSummary && !descriptionOpen}
            onExpand={setDescriptionOpen}
            onEdit={() => startEditing('description')}
            onDone={() => setEditing(null)}
            onSave={(description) => apply([task], { description })}
          />
          {lockTip === 'description' ? (
            <LockTooltip
              triggerRef={descriptionRef}
              isOpen
              onClose={() => setLockTip(null)}
              placement="bottom start"
            />
          ) : null}
          <PullRequestsSection
            task={task}
            projectName={task.project.name}
            isLinking={linking}
            onLinkingChange={setLinking}
            readOnly={archived}
            branchBy={branchBy}
          />
          <WorkItemSection task={task} kind="criterion" listRef={criteriaList} />
          <WorkItemSection task={task} kind="done" defaults={defaults} listRef={doneList} />
          <PlanSection key={`${task.key}:${task.status}`} task={task} day={day} />
          <FileNotes task={task} />
          <SubtasksSection
            task={task}
            readOnly={locked.has('parent') || archived}
            hideEmpty={archived}
            onAdd={() => keys.openField('subtasks')}
            addRef={addSubtask}
          />
          <BlockedBySection
            task={task}
            readOnly={locked.has('blockedBy') || archived}
            hideEmpty={archived}
            onAdd={() => keys.openField('blockedBy')}
            addRef={addBlocker}
          />
          <TaskTimeline
            taskKey={task.key}
            members={members}
            revealId={revealId}
            projectHistory={task.backlog ? history : undefined}
            projectName={projectName ?? projectKey}
            branch={summary?.defaultBranch}
            file={task.backlog?.file ?? null}
            context={{
              status: task.status,
              pullRequests: task.pullRequests ?? [],
              mergedOpen: task.mergedOpen ?? null,
            }}
            composer={
              archived ? (
                <p className="m-0 rounded-md border border-dashed border-line px-3.5 py-2.75 text-md text-fg-3">
                  {isMirrored
                    ? 'Move the file out of archive/tasks/ to comment on the task.'
                    : 'Restore the task to comment on it or change it.'}
                </p>
              ) : (
                <CommentComposer
                  taskKey={task.key}
                  members={members}
                  onSent={setRevealId}
                  placeholder={commentPlaceholder(mirrorInfo)}
                  hotkey={editing === null}
                  notes={!isMirrored}
                />
              )
            }
          />
        </article>
      </div>
      <TaskProperties
        task={task}
        planning={planning}
        anchors={anchors}
        openField={keys.open}
        onOpenField={keys.openField}
        defaults={defaults}
        onFocusCriteria={() => criteriaList.current?.focusFirstOpen()}
        onFocusDone={() => doneList.current?.focusFirstOpen()}
        lockTip={lockTip && lockTip in anchors ? (lockTip as TaskFieldKey) : null}
        onLockTipClose={() => setLockTip(null)}
        updatedBy={isMirrored ? null : lastActor}
        time={time}
        day={day}
        now={now}
      />
      {keys.pickers}
    </div>
  );
}

/** The project's repository from the cached project list: undefined while unknown, null for none. */
function useProjectRepository(projectKey: string): string | null | undefined {
  const api = useApi();
  return useQuery({
    ...projectsQuery(api),
    select: (data) => {
      const project = data.items.find((item) => item.key === projectKey);
      return project ? (project.repository ?? null) : undefined;
    },
  }).data;
}

/** "by claude-dev on laptop, Nov 3": the entry that recorded the work branch (frame 053). */
export function branchStartedBy(
  items: readonly TimelineItem[] | undefined,
  branch: string | null,
  day: (value: string) => string,
): string | null {
  if (!branch || !items) return null;
  for (let index = items.length - 1; index >= 0; index--) {
    const item = items[index];
    if (item?.kind !== 'activity') continue;
    if (!item.changes.some((change) => change.field === 'workBranch' && change.to === branch)) continue;
    const when = day(item.createdAt);
    const parts = [
      item.actor ? `by ${item.actor.name}` : null,
      item.source?.machine ? `on ${item.source.machine}` : null,
    ].filter(Boolean);
    return `${parts.join(' ')}${when ? `${parts.length ? ', ' : ''}${when}` : ''}` || null;
  }
  return null;
}

/** Why the task is archived, after the date: "14 days after it was done", "by Ana Ruiz" (frame 087). */
export function archivedWhy(task: Task, items: readonly TimelineItem[] | undefined): string | null {
  for (let index = (items?.length ?? 0) - 1; index >= 0; index--) {
    const item = items?.[index];
    if (item?.kind !== 'activity' || item.type !== 'task.archived') continue;
    if (item.cause?.kind === 'archive') {
      const days = item.cause.afterDays;
      return `${days} ${days === 1 ? 'day' : 'days'} after it was ${task.status === 'canceled' ? 'canceled' : 'done'}`;
    }
    if (item.origin === 'backlog') return 'when its file moved to archive/tasks/';
    if (item.actor) return `by ${item.actor.name}`;
    break;
  }
  return task.archivedBy ? `by ${task.archivedBy.name}` : null;
}

// ---------------------------------------------------------------------------
// Title and description
// ---------------------------------------------------------------------------

const titleClass = 'm-0 font-serif text-2xl leading-tight font-medium text-balance text-fg';

function TaskTitle({
  task,
  quiet = false,
  headingRef,
  isEditing,
  onEdit,
  onDone,
  onSave,
}: {
  task: Task;
  /** M7: archived, the title reads quieter (m7.css .task.ro). */
  quiet?: boolean;
  headingRef: RefObject<HTMLHeadingElement | null>;
  isEditing: boolean;
  onEdit: () => void;
  onDone: () => void;
  onSave: (title: string) => void;
}) {
  const [draft, setDraft] = useState(task.title);
  useEffect(() => {
    if (isEditing) setDraft(task.title);
  }, [isEditing, task.title]);
  const finish = (save: boolean) => {
    const next = draft.trim();
    if (save && next && next !== task.title) onSave(next);
    onDone();
  };
  return (
    <h1 ref={headingRef} className={cn(titleClass, 'mb-3.5', quiet && 'text-fg-2')}>
      {isEditing ? (
        <AriaTextField aria-label="Title" value={draft} onChange={setDraft} className="flex">
          <AriaTextArea
            autoFocus
            rows={1}
            onFocus={(event) => event.currentTarget.select()}
            onBlur={() => finish(true)}
            onKeyDown={(event) => {
              if (event.key === 'Enter') {
                event.preventDefault();
                finish(true);
              } else if (event.key === 'Escape') {
                event.preventDefault();
                event.stopPropagation();
                finish(false);
              }
            }}
            className={cn(
              titleClass,
              '-mx-1.5 w-[calc(100%+12px)] resize-none rounded-sm bg-transparent px-1.5 outline-none [field-sizing:content] focus:shadow-[var(--focus-ring)]',
            )}
          />
        </AriaTextField>
      ) : (
        <AriaButton
          onPress={onEdit}
          aria-keyshortcuts="e"
          aria-label={`${task.title}. Edit the title`}
          className="w-full cursor-text rounded-sm text-left outline-none focus-visible:focus-ring"
        >
          {task.title}
        </AriaButton>
      )}
    </h1>
  );
}

function TaskDescription({
  task,
  boxRef,
  isLocked,
  archived = false,
  isEditing,
  clipped,
  onExpand,
  onEdit,
  onDone,
  onSave,
}: {
  task: Task;
  boxRef: RefObject<HTMLDivElement | null>;
  isLocked: boolean;
  /** M7: archived, the text is shown and nothing edits it. */
  archived?: boolean;
  isEditing: boolean;
  /** Under a summary: two lines and "Show the description". */
  clipped: boolean;
  onExpand: (open: boolean) => void;
  onEdit: () => void;
  onDone: () => void;
  onSave: (description: string | null) => Promise<boolean>;
}) {
  const source = task.description ?? '';
  const [draft, setDraft] = useState(source);
  useEffect(() => {
    if (isEditing) setDraft(task.description ?? '');
  }, [isEditing, task.description]);
  const save = () => {
    const next = draft.trim() ? draft : null;
    if (next !== (task.description || null)) void onSave(next);
    onDone();
  };

  if (isEditing) {
    return (
      <div ref={boxRef} className="halo flex flex-col gap-2 rounded-md border bg-surface px-3.25 py-2.75">
        <AriaTextField aria-label="Description" value={draft} onChange={setDraft} className="flex">
          <AriaTextArea
            autoFocus
            rows={4}
            placeholder="Add a description…"
            onKeyDown={(event) => {
              if (event.key === 'Enter' && (event.metaKey || event.ctrlKey)) {
                event.preventDefault();
                save();
              } else if (event.key === 'Escape') {
                event.preventDefault();
                event.stopPropagation();
                onDone();
              }
            }}
            className="max-h-[60dvh] min-h-24 w-full resize-none border-0 bg-transparent p-0 text-lg leading-prose text-fg outline-none [field-sizing:content] placeholder:text-fg-3"
          />
        </AriaTextField>
        <div className="flex items-center gap-2">
          <span className="text-xs text-fg-3">Markdown</span>
          <span className="flex-1" />
          <Button variant="secondary" onPress={onDone}>
            Cancel
          </Button>
          <Button kbd="⌘↵" onPress={save}>
            Save
          </Button>
        </div>
      </div>
    );
  }

  if (!source.trim()) {
    if (archived) return <div ref={boxRef} />;
    return (
      <div ref={boxRef}>
        {isLocked ? (
          <p className="m-0 pt-0.5 pb-1.5 text-lg leading-prose text-fg-3">No description in the file.</p>
        ) : (
          <AriaButton
            onPress={onEdit}
            aria-keyshortcuts="d"
            className="w-full cursor-text rounded-sm pt-0.5 pb-1.5 text-left text-lg leading-prose text-fg-3 outline-none hover:text-fg-2 focus-visible:focus-ring"
          >
            Add a description…
          </AriaButton>
        )}
      </div>
    );
  }

  const markdown = (
    <Markdown
      source={source}
      size="page"
      variant={isLocked ? 'backlog' : 'default'}
      {...(isLocked || archived
        ? {}
        : {
            onToggleCheckbox: (index: number) => void onSave(toggleCheckbox(source, index)),
          })}
    />
  );

  return (
    // A click on the text (not on a link or a checkbox) edits it, like D.
    // biome-ignore lint/a11y/noStaticElementInteractions: D is the keyboard way to edit
    // biome-ignore lint/a11y/useKeyWithClickEvents: D is the keyboard way to edit
    <div
      ref={boxRef}
      onClick={(event) => {
        const target = event.target as HTMLElement;
        if (archived || target.closest('a, input, button') || window.getSelection()?.toString()) return;
        onEdit();
      }}
      className={cn('rounded-sm', !isLocked && !archived && 'cursor-text', archived && 'text-fg-2')}
    >
      {clipped ? (
        <ClippedText
          lines={2}
          showLabel="Show the description"
          kbd="D"
          expanded={false}
          onExpandedChange={onExpand}
          contentClassName="text-lg leading-prose"
        >
          {markdown}
        </ClippedText>
      ) : (
        markdown
      )}
    </div>
  );
}

// ---------------------------------------------------------------------------
// Loading and errors
// ---------------------------------------------------------------------------

/** "Request 8f2c…" under an error, for support. */
export function RequestHint({ requestId }: { requestId: string }) {
  return (
    <p className="m-0 mt-2 text-xs text-fg-3">
      Request <code className="font-mono">{requestId}</code>
    </p>
  );
}

function TaskPageError({
  error,
  onRetry,
  taskKey,
}: {
  error: unknown;
  onRetry: () => void;
  taskKey: string;
}) {
  const described = describeError(error);
  return (
    <div className="max-w-180 px-14 py-8">
      <Banner
        action={
          <Button variant="secondary" size="sm" onPress={onRetry}>
            Retry
          </Button>
        }
      >
        Couldn't load {taskKey}. {described.message}
      </Banner>
      {described.requestId ? <RequestHint requestId={described.requestId} /> : null}
    </div>
  );
}

function TaskPageSkeleton() {
  return (
    <div className="grid min-h-0 flex-1 grid-cols-[minmax(0,1fr)_320px]" aria-busy="true">
      <div className="flex max-w-180 flex-col gap-3.5 px-14 pt-9">
        <Skeleton width="70%" height={26} />
        <Skeleton width="90%" className="mt-3" />
        <Skeleton width="96%" />
        <Skeleton width="60%" />
      </div>
      <div className="flex flex-col gap-4 border-l border-line px-4.5 pt-5">
        <Skeleton width="60%" />
        <Skeleton width="50%" />
        <Skeleton width="70%" />
      </div>
    </div>
  );
}
