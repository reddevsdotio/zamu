import { useQuery } from '@tanstack/react-query';
import { useRouter, useRouterState } from '@tanstack/react-router';
import type { Task, TimelineItem, WorkItemProgress } from '@zamu/contracts';
import { type ReactNode, type RefObject, useEffect, useRef } from 'react';
import { Button as AriaButton } from 'react-aria-components';
import { CommentMarkdown } from '~/features/comments/CommentMarkdown';
import {
  AssigneePicker,
  CyclePicker,
  cycleLabel,
  DuePicker,
  type FieldPickerProps,
  LabelPicker,
  MilestonePicker,
  ParentPicker,
  PriorityPicker,
  StatusPicker,
} from '~/features/task-fields';
import { useNow } from '~/features/tasks/clock';
import { atTime, formatRelative } from '~/features/tasks/format';
import { Markdown } from '~/features/tasks/Markdown';
import { TaskFileBadge } from '~/features/tasks/MirroredTask';
import { membersQuery, taskQuery, timelineQuery } from '~/features/tasks/queries';
import { projectOfKey } from '~/features/tasks/TaskPageRelations';
import { progressOfItems, rememberTaskNavigation, type WorkItemKind, workItemNoun } from '~/features/views';
import {
  Avatar,
  Button,
  CloseGlyph,
  cn,
  DueChip,
  isEditableTarget,
  KeyHint,
  LabelDot,
  localToday,
  PriorityGlyph,
  ProgressMark,
  Skeleton,
  StatusGlyph,
  SummaryBlock,
  type WorkAuthor,
} from '~/ui';
import { closePeek, movePeek, type PeekRequest, usePeek } from './store';

// The peek (frames 067–070, notes.md call 4): a task's essentials at the right of the list, board or
// Home, without a scrim, so the view behind stays usable. Header with the key, the Backlog.md badge,
// Open (Enter) and close; the title; the properties as chips (each opens its picker in native
// projects, read-only in mirrored ones, which the footer says); the description and the latest
// comment. M6: both work-record counts as chips, and the final summary in place of the description
// when the task has one (frame 023). J / K move it along the view's keys, Space or Esc close it, Enter opens the task view.
// Mounted once in the shell; the views open it through features/peek/store.ts.

export function PeekHost() {
  const request = usePeek();
  const pathname = useRouterState({ select: (state) => state.location.pathname });
  // Leaving the page it opened on closes it.
  const openedOn = useRef<string | null>(null);
  if (!request) openedOn.current = null;
  else openedOn.current ??= pathname;
  useEffect(() => {
    if (request && openedOn.current !== pathname) closePeek();
  }, [pathname, request]);
  if (!request) return null;
  return <Peek request={request} />;
}

/** True for Space, Enter and the like on a control: let the control have the key. */
function isControl(target: EventTarget | null): boolean {
  return target instanceof Element && target.closest('button, a, [role="button"], [role="link"]') != null;
}

/** True inside a menu, picker, palette or dialog: their own keys apply first (Esc order). */
function isInOverlay(target: EventTarget | null): boolean {
  return (
    target instanceof Element &&
    target.closest('[role="dialog"], [role="alertdialog"], [role="menu"], [role="listbox"]') != null
  );
}

function usePeekKeys(request: PeekRequest, panel: RefObject<HTMLElement | null>, open: () => void) {
  const latest = useRef({ request, open });
  latest.current = { request, open };
  useEffect(() => {
    // Capture on window: the peek takes J, K, Esc and Enter before the view behind does, so the list
    // doesn't move its own focus twice (it follows through onMove).
    const onCapture = (event: KeyboardEvent) => {
      if (event.defaultPrevented || event.isComposing || event.metaKey || event.ctrlKey || event.altKey)
        return;
      const target = event.target;
      if (isEditableTarget(target) || isInOverlay(target)) return;
      const { request: current, open: openTask } = latest.current;
      const inPanel = target instanceof Node && panel.current?.contains(target) === true;
      const key = event.key;
      if ((key === 'j' || key === 'k' || key === 'J' || key === 'K') && !event.shiftKey) {
        const index = current.keys.indexOf(current.key);
        const next = current.keys[index + (key.toLowerCase() === 'j' ? 1 : -1)];
        event.preventDefault();
        event.stopPropagation();
        if (index >= 0 && next) movePeek(next);
        return;
      }
      if (key === 'Escape') {
        event.preventDefault();
        event.stopPropagation();
        closePeek();
        return;
      }
      if (key === 'Enter' && !event.shiftKey && !(inPanel && isControl(target))) {
        event.preventDefault();
        event.stopPropagation();
        openTask();
        return;
      }
      if (key === ' ' && inPanel && !isControl(target)) {
        event.preventDefault();
        event.stopPropagation();
        closePeek();
      }
    };
    // Space outside the peek: the view toggles it (same task closes, another switches) and marks the key
    // handled. If nothing handled it, it still closes.
    const onBubble = (event: KeyboardEvent) => {
      if (event.key !== ' ' || event.defaultPrevented || isEditableTarget(event.target)) return;
      if (isInOverlay(event.target) || isControl(event.target)) return;
      event.preventDefault();
      closePeek();
    };
    window.addEventListener('keydown', onCapture, true);
    window.addEventListener('keydown', onBubble);
    return () => {
      window.removeEventListener('keydown', onCapture, true);
      window.removeEventListener('keydown', onBubble);
    };
  }, [panel]);
}

function Peek({ request }: { request: PeekRequest }) {
  const router = useRouter();
  const location = useRouterState({ select: (state) => state.location });
  const panel = useRef<HTMLElement>(null);
  const result = useQuery(taskQuery(request.key));
  const task = result.data;
  const open = () => {
    rememberTaskNavigation(
      { keys: request.keys, from: request.from, returnTo: `${location.pathname}${location.searchStr ?? ''}` },
      request.key,
    );
    closePeek();
    void router.navigate({
      to: '/p/$projectKey/$taskKey',
      params: { projectKey: task?.project.key ?? projectOfKey(request.key), taskKey: request.key },
    });
  };
  usePeekKeys(request, panel, open);
  const isMirrored = (task?.locked?.length ?? 0) > 0;

  return (
    <section
      ref={panel}
      aria-label={`Peek: ${request.key}`}
      data-peek={request.key}
      className="fixed top-2.5 right-2.5 bottom-2.5 z-40 flex w-140 max-w-[calc(100vw-20px)] flex-col overflow-hidden rounded-lg bg-surface-pop text-fg shadow-lift"
    >
      <header className="flex h-11.5 shrink-0 items-center gap-2 border-b border-line-soft pr-3.5 pl-4.5">
        {task ? <StatusGlyph status={task.status} /> : null}
        <span className="text-sm font-semibold text-fg-2 tabular-nums">{request.key}</span>
        {task?.backlog ? <TaskFileBadge task={task} /> : null}
        <span className="flex-1" />
        <Button variant="secondary" size="sm" kbd="↵" onPress={open} aria-keyshortcuts="Enter">
          Open
        </Button>
        <Button
          variant="quiet"
          size="sm"
          iconOnly
          aria-label="Close"
          aria-keyshortcuts="Escape"
          onPress={closePeek}
        >
          <CloseGlyph />
        </Button>
      </header>
      <div className="flex min-h-0 flex-1 flex-col gap-3 overflow-y-auto px-5.5 py-4.5">
        {task ? (
          <PeekBody task={task} isMirrored={isMirrored} />
        ) : result.isError ? (
          <p className="m-0 text-md text-fg-2">Couldn't load {request.key}. Open it to try again.</p>
        ) : (
          <div className="flex flex-col gap-3" aria-busy="true">
            <Skeleton width="80%" height={22} />
            <Skeleton width="60%" />
            <Skeleton width="90%" />
          </div>
        )}
      </div>
      <footer className="flex shrink-0 items-center gap-3 border-t border-line-soft px-4.5 py-2.5 text-xs text-fg-3 [&>span]:shrink-0 [&>span:last-child]:shrink">
        <KeyHint keys="Space">close</KeyHint>
        <KeyHint keys="↵">open</KeyHint>
        <KeyHint keys={['J', 'K']}>next, previous</KeyHint>
        <span className="flex-1" />
        {isMirrored && task ? (
          <span title={`Read-only: ${task.project.name} mirrors Backlog.md`} className="min-w-0 truncate">
            Read-only: {task.project.name} mirrors Backlog.md
          </span>
        ) : null}
      </footer>
    </section>
  );
}

const chip =
  'inline-flex h-7 shrink-0 items-center gap-1.5 rounded-pill bg-bg-lane px-2.5 text-sm font-medium whitespace-nowrap text-fg';

/**
 * "4 of 6 criteria", "2 of 2 done items" (frame 023): always shown in the peek, whatever the display
 * options say, but only for a list that has items. Read-only: the task view changes them.
 */
function WorkItemChip({ kind, progress }: { kind: WorkItemKind; progress: WorkItemProgress }) {
  if (progress.total <= 0) return null;
  return (
    <span className={chip} data-work-items={kind}>
      <ProgressMark
        {...progress}
        format="long"
        showNoun
        noun={workItemNoun(kind, progress.total)}
        className="text-sm text-fg"
      />
    </span>
  );
}

/** "claude-dev for Ana", or "From the file" for a summary read from a Backlog.md file. */
function summaryByline(task: Task): { author?: WorkAuthor; onBehalfOf?: string; byline?: string } {
  const meta = task.finalSummaryMeta;
  if (meta?.author) {
    return {
      author: meta.author,
      ...(meta.onBehalfOf ? { onBehalfOf: meta.onBehalfOf.name.split(/\s+/)[0] } : {}),
    };
  }
  return meta?.origin === 'backlog' || task.backlog ? { byline: 'From the file' } : {};
}

/** formatRelative's "Just now" reads "just now" after the byline's comma. */
const sentenceTime = (text: string) => (text === 'Just now' ? 'just now' : text);

/** A property chip: a picker trigger in native projects, plain text in mirrored ones. */
function PropertyChip({
  task,
  Picker,
  label,
  readOnly,
  children,
}: {
  task: Task;
  Picker: (props: FieldPickerProps) => ReactNode;
  label: string;
  readOnly: boolean;
  children: ReactNode;
}) {
  if (readOnly) return <span className={chip}>{children}</span>;
  return (
    <Picker
      targets={task}
      placement="bottom start"
      trigger={
        <AriaButton
          aria-label={label}
          className={cn(
            chip,
            'cursor-pointer outline-none hover:bg-bg-grp focus-visible:shadow-[var(--focus-ring)]',
          )}
        >
          {children}
        </AriaButton>
      }
    />
  );
}

function PeekBody({ task, isMirrored }: { task: Task; isMirrored: boolean }) {
  const now = useNow();
  const time = atTime(formatRelative, now);
  const timeline = useQuery(timelineQuery(task.key)).data?.items;
  const members = useQuery(membersQuery()).data?.items ?? [];
  const comments = (timeline ?? []).filter(
    (item): item is TimelineItem & { kind: 'comment' } => item.kind === 'comment' && item.body != null,
  );
  const latest = comments.at(-1);
  const today = now == null ? undefined : localToday(new Date(now));
  const description = task.description?.trim();
  // A finished task opens on its final summary, in place of the description (M6 design call 8).
  const summary = task.finalSummary?.trim();
  const summaryAt = task.finalSummaryMeta?.at;
  const summaryTime = summaryAt ? sentenceTime(time(summaryAt)) : '';
  const criteria = progressOfItems(task.criteria);
  const doneItems = progressOfItems(task.doneItems);
  return (
    <>
      <h2 className="m-0 font-serif text-xl leading-tight font-medium text-balance">{task.title}</h2>
      <div className="flex flex-wrap gap-1.5">
        <PropertyChip task={task} Picker={StatusPicker} label="Status" readOnly={isMirrored}>
          <StatusGlyph status={task.status} withLabel />
        </PropertyChip>
        {task.priority !== 'none' ? (
          <PropertyChip task={task} Picker={PriorityPicker} label="Priority" readOnly={isMirrored}>
            <PriorityGlyph priority={task.priority} withLabel />
          </PropertyChip>
        ) : null}
        {task.assignee ? (
          <PropertyChip task={task} Picker={AssigneePicker} label="Assignee" readOnly={isMirrored}>
            <Avatar name={task.assignee.name} kind={task.assignee.kind} decorative />
            {task.assignee.name}
          </PropertyChip>
        ) : null}
        {(task.labels ?? []).map((label) => (
          <PropertyChip key={label.id} task={task} Picker={LabelPicker} label="Labels" readOnly={isMirrored}>
            <LabelDot color={label.color} />
            {label.name}
          </PropertyChip>
        ))}
        <WorkItemChip kind="criteria" progress={criteria} />
        <WorkItemChip kind="done" progress={doneItems} />
        {task.dueDate ? (
          <PropertyChip task={task} Picker={DuePicker} label="Due date" readOnly={isMirrored}>
            <DueChip
              dueDate={task.dueDate}
              status={task.status}
              {...(today ? { today } : {})}
              className="text-sm"
            />
          </PropertyChip>
        ) : null}
        {task.parent ? (
          <PropertyChip task={task} Picker={ParentPicker} label="Parent" readOnly={isMirrored}>
            <span className="text-fg-3">Subtask of</span>
            <span className="tabular-nums">{task.parent.key}</span>
          </PropertyChip>
        ) : null}
        {task.milestone ? (
          <PropertyChip task={task} Picker={MilestonePicker} label="Milestone" readOnly={isMirrored}>
            {task.milestone.name}
          </PropertyChip>
        ) : null}
        {task.cycle ? (
          // Cycles are app-side even in mirrored projects.
          <PropertyChip task={task} Picker={CyclePicker} label="Cycle" readOnly={false}>
            {cycleLabel(task.cycle)}
          </PropertyChip>
        ) : null}
      </div>
      {summary ? (
        <SummaryBlock variant="plain" time={summaryTime || null} {...summaryByline(task)}>
          <Markdown source={summary} size="page" variant={isMirrored ? 'backlog' : 'default'} />
        </SummaryBlock>
      ) : description ? (
        <Markdown source={description} size="page" variant={isMirrored ? 'backlog' : 'default'} />
      ) : null}
      <div className="mt-1.5 flex items-center gap-2 text-sm font-semibold text-fg-2">
        <h3 className="m-0 text-sm font-semibold">Latest</h3>
        <span className="flex-1" />
        {comments.length > 1 ? (
          <span className="font-normal text-fg-3">{comments.length - 1} more in the task</span>
        ) : null}
      </div>
      {latest ? (
        <article
          aria-label={`Comment by ${latest.author.name}`}
          className={cn(
            'flex flex-col gap-1.5 rounded-md bg-surface px-3.25 py-2.75',
            latest.author.kind === 'agent'
              ? 'shadow-[var(--shadow-card),inset_2px_0_0_var(--fg-3)]'
              : 'shadow-card',
          )}
        >
          <header className="flex min-w-0 items-center gap-2 text-sm text-fg-3">
            <Avatar name={latest.author.name} kind={latest.author.kind} decorative />
            <b className="truncate font-semibold text-fg">{latest.author.name}</b>
            {latest.onBehalfOf ? (
              <span className="truncate">acting for {latest.onBehalfOf.name.split(/\s+/)[0]}</span>
            ) : null}
            <span className="flex-1" />
            <time dateTime={latest.createdAt} className="shrink-0 tabular-nums">
              {time(latest.createdAt)}
            </time>
          </header>
          <CommentMarkdown source={latest.body ?? ''} mentions={latest.mentions} members={members} />
        </article>
      ) : timeline ? (
        <p className="m-0 text-sm text-fg-3">No comments yet.</p>
      ) : (
        <Skeleton width="70%" />
      )}
    </>
  );
}
