// Human output: compact tables and short sentences. JSON output never goes through here.
import {
  type Activity,
  type ActivityChange,
  type AssigneeRef,
  BACKLOG_ACTOR_NAME,
  type CheckAgain,
  type Comment,
  CYCLE_STATE_LABELS,
  type CycleState,
  type EntrySource,
  GIT_ACTOR_NAMES,
  type GitProvider,
  type Me,
  type MergedOpen,
  MILESTONE_STATUS_LABELS,
  type MilestoneStatus,
  PRIORITY_LABELS,
  type Priority,
  PULL_REQUEST_STATE_LABELS,
  type PullRequestCauseEvent,
  type PullRequestLink,
  type PullRequestLinkHow,
  type PullRequestState,
  TASK_STATUS_LABELS,
  type TaskStatus,
  type TimelineItem,
  type UserRef,
  type WorkItem,
  type WorkTextMeta,
  ZAMU_ACTOR_NAME,
} from '@zamu/contracts';

export interface Style {
  bold: (text: string) => string;
  dim: (text: string) => string;
  status: (status: TaskStatus, text: string) => string;
  priority: (priority: Priority, text: string) => string;
  /** Needs attention: overdue, stalled, ending soon. */
  warn: (text: string) => string;
}

const sgr = (open: number, close: number) => (text: string) => `\u001b[${open}m${text}\u001b[${close}m`;
const plain = (text: string) => text;

const STATUS_COLOR: Record<TaskStatus, ((text: string) => string) | null> = {
  backlog: sgr(2, 22),
  todo: null,
  in_progress: sgr(33, 39),
  in_review: sgr(35, 39),
  done: sgr(32, 39),
  canceled: sgr(2, 22),
};

const PRIORITY_COLOR: Record<Priority, ((text: string) => string) | null> = {
  none: sgr(2, 22),
  low: null,
  medium: null,
  high: sgr(33, 39),
  urgent: sgr(31, 39),
};

export function createStyle(color: boolean): Style {
  if (!color) return { bold: plain, dim: plain, status: (_s, t) => t, priority: (_p, t) => t, warn: plain };
  return {
    bold: sgr(1, 22),
    dim: sgr(2, 22),
    warn: sgr(33, 39),
    status: (status, text) => STATUS_COLOR[status]?.(text) ?? text,
    priority: (priority, text) => PRIORITY_COLOR[priority]?.(text) ?? text,
  };
}

// biome-ignore lint/suspicious/noControlCharactersInRegex: matches ANSI escape sequences
const ANSI = /\u001b\[[0-9;]*m/g;

/** Visible width of a cell (ANSI codes do not count). */
function width(text: string): number {
  return [...text.replace(ANSI, '')].length;
}

function truncate(text: string, max: number): string {
  const chars = [...text];
  if (chars.length <= max) return text;
  return max <= 1 ? chars.slice(0, max).join('') : `${chars.slice(0, max - 1).join('')}…`;
}

export interface Column<Row> {
  header: string;
  value: (row: Row) => string;
  /** Styles the padded cell; the value itself stays plain so widths line up. */
  style?: (row: Row, cell: string) => string;
}

/**
 * Left-aligned columns separated by two spaces. The last column is not padded and, on a terminal,
 * is cut to fit the width.
 */
export function table<Row>(rows: Row[], columns: Column<Row>[], style: Style, maxWidth?: number): string {
  const cells = rows.map((row) => columns.map((column) => column.value(row)));
  const widths = columns.map((column, i) =>
    Math.max(width(column.header), ...cells.map((row) => width(row[i] ?? ''))),
  );
  const lead = widths.slice(0, -1).reduce((sum, w) => sum + w + 2, 0);
  const lastMax = maxWidth ? Math.max(maxWidth - lead, 10) : undefined;
  const fit = (text: string, i: number) => {
    const isLast = i === columns.length - 1;
    if (isLast) return lastMax ? truncate(text, lastMax) : text;
    return text + ' '.repeat((widths[i] ?? 0) - width(text));
  };
  const header = columns.map((column, i) => fit(column.header, i)).join('  ');
  const lines = [style.dim(header.trimEnd())];
  rows.forEach((row, r) => {
    const line = columns
      .map((column, i) => {
        const cell = fit(cells[r]?.[i] ?? '', i);
        return column.style ? column.style(row, cell) : cell;
      })
      .join('  ');
    lines.push(line.trimEnd());
  });
  return `${lines.join('\n')}\n`;
}

export interface GridColumn<Row> extends Column<Row> {
  /** Gives up width so the line fits the terminal (one column per grid). */
  flex?: boolean;
}

export interface GridOptions {
  /** Prints the dim header line (default true). */
  header?: boolean;
  /** Prefix of every line, e.g. two spaces under a section heading. */
  indent?: string;
  maxWidth?: number;
}

/**
 * Like table(), but the column marked flex (a title or an excerpt, anywhere in the row) is the one
 * cut to fit the terminal width, so the columns after it stay visible.
 */
export function grid<Row>(
  rows: Row[],
  columns: GridColumn<Row>[],
  style: Style,
  { header = true, indent = '', maxWidth }: GridOptions = {},
): string {
  const cells = rows.map((row) => columns.map((column) => column.value(row)));
  const widths = columns.map((column, i) =>
    Math.max(header ? width(column.header) : 0, ...cells.map((row) => width(row[i] ?? ''))),
  );
  const flex = columns.findIndex((column) => column.flex);
  if (maxWidth && flex !== -1) {
    const total = width(indent) + widths.reduce((sum, w) => sum + w, 0) + 2 * (columns.length - 1);
    if (total > maxWidth) widths[flex] = Math.max((widths[flex] ?? 0) - (total - maxWidth), 10);
  }
  const fit = (text: string, i: number) => {
    const cut = i === flex ? truncate(text, widths[i] ?? 0) : text;
    return i === columns.length - 1 ? cut : cut + ' '.repeat(Math.max((widths[i] ?? 0) - width(cut), 0));
  };
  const lines: string[] = [];
  if (header)
    lines.push(
      indent +
        style.dim(
          columns
            .map((column, i) => fit(column.header, i))
            .join('  ')
            .trimEnd(),
        ),
    );
  rows.forEach((row, r) => {
    const line = columns
      .map((column, i) => {
        const cell = fit(cells[r]?.[i] ?? '', i);
        return column.style ? column.style(row, cell) : cell;
      })
      .join('  ');
    lines.push(indent + line.trimEnd());
  });
  return lines.length ? `${lines.join('\n')}\n` : '';
}

/**
 * Compact time between two instants, for "in review 3h" or "no update 26h": minutes under an
 * hour, hours under two days, days after that.
 */
export function elapsed(from: string, to: string): string {
  const minutes = Math.max(Math.floor((Date.parse(to) - Date.parse(from)) / 60_000), 0);
  if (minutes < 1) return '<1m';
  if (minutes < 60) return `${minutes}m`;
  const hours = Math.floor(minutes / 60);
  if (hours < 48) return `${hours}h`;
  return `${Math.floor(hours / 24)}d`;
}

/** Label/value lines with aligned values. */
export function fields(entries: [string, string][], style: Style): string {
  const labelWidth = Math.max(...entries.map(([label]) => width(label)));
  return `${entries.map(([label, value]) => `${style.dim(label.padEnd(labelWidth))}  ${value}`).join('\n')}\n`;
}

export const statusLabel = (status: TaskStatus) => TASK_STATUS_LABELS[status];
export const priorityLabel = (priority: Priority) => PRIORITY_LABELS[priority];

/** "claude-dev for Ana Ruiz" for agents with a responsible human, the name otherwise. */
export function personLabel(user: Pick<AssigneeRef, 'name'> & { responsible?: UserRef | null }): string {
  return user.responsible ? `${user.name} for ${user.responsible.name}` : user.name;
}

export function assigneeLabel(assignee: AssigneeRef | null): string {
  return assignee ? personLabel(assignee) : 'Unassigned';
}

/** `2026-10-22 18:19` in UTC: stable across machines, which matters for agents and logs. */
export function formatTime(iso: string): string {
  return `${iso.slice(0, 10)} ${iso.slice(11, 16)}`;
}

export function formatDate(iso: string): string {
  return iso.slice(0, 10);
}

function quote(text: string | null): string {
  return text === null ? 'nothing' : `"${text}"`;
}

/** "added label ui and removed label bug": what changed between two lists of names. */
function listChange(noun: string, from: readonly string[], to: readonly string[]): string {
  const added = to.filter((name) => !from.includes(name));
  const removed = from.filter((name) => !to.includes(name));
  const phrase = (verb: string, names: string[]) =>
    `${verb} ${noun}${names.length === 1 ? '' : 's'} ${names.join(', ')}`;
  const parts = [
    added.length ? phrase('added', added) : null,
    removed.length ? phrase('removed', removed) : null,
  ];
  return parts.filter(Boolean).join(' and ') || `changed the ${noun}s`;
}
/** One change as the activity feed phrases it: "moved it from Todo to In progress". */
export function changeSentence(change: ActivityChange): string {
  switch (change.field) {
    case 'status':
      if (change.from === null) return `set the status to ${change.to ? statusLabel(change.to) : 'none'}`;
      return `moved it from ${statusLabel(change.from)} to ${change.to ? statusLabel(change.to) : 'none'}`;
    case 'priority':
      if (change.from === null) return `set the priority to ${change.to ? priorityLabel(change.to) : 'none'}`;
      return `changed the priority from ${priorityLabel(change.from)} to ${change.to ? priorityLabel(change.to) : 'none'}`;
    case 'assignee':
      if (change.to === null) return change.from ? `unassigned ${change.from.name}` : 'unassigned it';
      if (change.from === null) return `assigned it to ${change.to.name}`;
      return `reassigned it from ${change.from.name} to ${change.to.name}`;
    case 'title':
      return change.from === null
        ? `set the title to ${quote(change.to)}`
        : `renamed it to ${quote(change.to)}`;
    case 'description':
      if (change.to === null) return 'cleared the description';
      return change.from === null ? 'added a description' : 'edited the description';
    case 'milestone':
      return change.to ? `set milestone ${change.to.name}` : 'cleared the milestone';
    case 'cycle':
      if (change.to) return `moved it to Cycle ${change.to.number}`;
      return change.from ? `removed it from Cycle ${change.from.number}` : 'removed it from the cycle';
    case 'labels':
      return listChange(
        'label',
        change.from.map((l) => l.name),
        change.to.map((l) => l.name),
      );
    case 'dueDate':
      if (change.to === null) return 'cleared the due date';
      return change.from === null
        ? `set the due date to ${change.to}`
        : `moved the due date from ${change.from} to ${change.to}`;
    case 'blockedBy':
      return listChange(
        'blocker',
        change.from.map((t) => t.key),
        change.to.map((t) => t.key),
      );
    case 'parent':
      if (change.to) {
        return change.from
          ? `moved it from ${change.from.key} to ${change.to.key}`
          : `made it a subtask of ${change.to.key}`;
      }
      return change.from ? `took it out of ${change.from.key}` : 'made it a top-level task';
    case 'criterion.added':
    case 'criterion.edited':
    case 'criterion.moved':
    case 'criterion.removed':
    case 'criterion.checked':
    case 'criterion.unchecked':
    case 'criterion.waived':
    case 'criterion.unwaived':
    case 'doneItem.added':
    case 'doneItem.edited':
    case 'doneItem.moved':
    case 'doneItem.removed':
    case 'doneItem.checked':
    case 'doneItem.unchecked':
    case 'doneItem.waived':
    case 'doneItem.unwaived':
      return itemSentence(change);
    case 'plan':
      return textChange('the plan', change);
    case 'finalSummary':
      return textChange('the final summary', change);
    case 'workBranch':
      if (change.to === null) return 'cleared the work branch';
      return change.from === null ? `started it on branch ${change.to}` : `moved it to branch ${change.to}`;
    case 'checkAgain':
      if (change.to === null) return 'cleared the check-again day';
      return `${change.from === null ? 'set' : 'changed'} check again to ${checkAgainLabel(change.to)}`;
    case 'pullRequest':
      if (change.to) {
        return `linked ${requestRef(change.to.provider, change.to.number)} "${change.to.title}"${HOW_SUFFIX[change.to.how]}`;
      }
      return change.from
        ? `unlinked ${requestRef(change.from.provider, change.from.number)} "${change.from.title}"`
        : 'unlinked a request';
  }
}

// ---------------------------------------------------------------------------
// Pull requests, archive and check again (M7)
// ---------------------------------------------------------------------------

/** "#482" for GitHub and Forgejo pull requests, "!482" for GitLab merge requests. */
export function requestRef(provider: GitProvider, number: number): string {
  return `${provider === 'gitlab' ? '!' : '#'}${number}`;
}

export const pullRequestStateLabel = (state: PullRequestState) => PULL_REQUEST_STATE_LABELS[state];

/** How a history line says a request was linked: by hand needs nothing more. */
const HOW_SUFFIX: Record<PullRequestLinkHow, string> = {
  hand: '',
  branch: ' (started on its branch)',
  description: ' (named on a Closes: line)',
};

/** "started on feat/webhook-retries", "named in its description", "linked by hand by Ana Ruiz". */
export function pullRequestHowLabel(
  request: Pick<PullRequestLink, 'how' | 'headBranch' | 'linkedBy'>,
): string {
  if (request.how === 'branch') return `started on ${request.headBranch}`;
  if (request.how === 'description') return 'named in its description';
  return request.linkedBy ? `linked by hand by ${request.linkedBy.name}` : 'linked by hand';
}

/** "Merged with 2 open criteria" when only criteria are open, "Merged with 3 open items" otherwise. */
export function mergedOpenText({
  openCriteria,
  openDoneItems,
}: Pick<MergedOpen, 'openCriteria' | 'openDoneItems'>): string {
  if (openDoneItems === 0) {
    return `Merged with ${openCriteria} open ${openCriteria === 1 ? 'criterion' : 'criteria'}`;
  }
  const total = openCriteria + openDoneItems;
  return `Merged with ${total} open ${total === 1 ? 'item' : 'items'}`;
}

/** "2026-12-01: Wait for the bank's answer". */
export function checkAgainLabel(checkAgain: CheckAgain): string {
  return `${checkAgain.on}: ${checkAgain.reason}`;
}

/** What a request event did, after its number: "#482 opened by claude-dev". */
const EVENT_WORDS: Record<PullRequestCauseEvent, string> = {
  opened: 'opened',
  ready: 'marked ready',
  reopened: 'reopened',
  merged: 'merged',
  closed: 'closed',
};

/**
 * Who an entry without an actor names: the git host of a request event (GitHub, GitLab, Forgejo),
 * Backlog.md for a refresh, and Zamu for its own jobs (the archive job, the hourly cycle job).
 */
function systemName(activity: Activity): string {
  switch (activity.system?.kind) {
    case 'git':
      return GIT_ACTOR_NAMES[activity.system.provider];
    case 'zamu':
      return ZAMU_ACTOR_NAME;
    case 'backlog':
      return BACKLOG_ACTOR_NAME;
  }
  if (activity.origin === 'backlog') return BACKLOG_ACTOR_NAME;
  if (activity.cause?.kind === 'pull_request') return GIT_ACTOR_NAMES[activity.cause.provider];
  return ZAMU_ACTOR_NAME;
}

type ItemChange = Extract<ActivityChange, { field: `criterion.${string}` | `doneItem.${string}` }>;

/**
 * A criterion or done item change: "checked criterion 2 "Refunds post a ledger entry"". The text
 * keeps the line readable after the list was reordered.
 */
function itemSentence(change: ItemChange): string {
  const [list, operation] = change.field.split('.') as [string, string];
  const noun = list === 'criterion' ? 'criterion' : 'done item';
  const text = `"${change.text}"`;
  if (change.field === 'criterion.moved' || change.field === 'doneItem.moved') {
    return `moved ${noun} ${text} from ${change.from} to ${change.to}`;
  }
  const item = `${noun} ${'number' in change ? change.number : ''} ${text}`;
  switch (operation) {
    case 'added':
      return `added ${item}`;
    case 'edited':
      return `reworded ${item}${'from' in change && typeof change.from === 'string' ? ` (was "${change.from}")` : ''}`;
    case 'removed':
      return `removed ${item}`;
    case 'checked':
      return `checked ${item}`;
    case 'unchecked':
      return `unchecked ${item}`;
    case 'waived':
      return `waived ${item}${'reason' in change ? `: ${change.reason}` : ''}`;
    default:
      return `took back the waiver on ${item}`;
  }
}

/** "wrote the plan", "edited the final summary", "cleared the plan". */
function textChange(noun: string, change: { from: string | null; to: string | null }): string {
  if (!change.to) return `cleared ${noun}`;
  return change.from ? `edited ${noun}` : `wrote ${noun}`;
}

/** "claude-dev for Ana Ruiz moved it from Todo to In progress". */
export function activitySentence(activity: Activity): string {
  // A null actor is a Backlog.md refresh, a git host's request event (M7) or one of Zamu's jobs.
  const actor = activity.actor?.name ?? systemName(activity);
  const who = activity.onBehalfOf ? `${actor} for ${activity.onBehalfOf.name}` : actor;
  // "(a1b2c3d)": the commit a Backlog.md refresh read.
  const commit =
    activity.origin === 'backlog' && activity.originRef ? ` (${activity.originRef.slice(0, 7)})` : '';
  if (activity.type === 'task.hidden') return `${who} hid the task: its file is gone${commit}`;
  if (activity.type === 'task.archived') {
    // "Zamu archived this 14 days after it closed": the nightly job.
    if (activity.cause?.kind === 'archive') {
      const days = activity.cause.afterDays;
      return `${who} archived this ${days} ${days === 1 ? 'day' : 'days'} after it closed`;
    }
    if (activity.origin === 'backlog')
      return `${who} archived the task: its file moved to archive/tasks/${commit}`;
    return `${who} archived the task`;
  }
  if (activity.type === 'task.unarchived') {
    if (activity.origin === 'backlog') {
      return `${who} restored the task from the archive: its file left archive/tasks/${commit}`;
    }
    return `${who} restored the task from the archive`;
  }
  if (activity.type === 'task.restored') return `${who} restored the task: its file is back${commit}`;
  if (activity.type === 'cycle.ended') {
    // "Cycle 12 ended. Moved to Cycle 13." The hourly job has no actor; a person who ended it early does.
    const change = activity.changes.find((c) => c.field === 'cycle');
    const ended = change?.from ? `Cycle ${change.from.number}` : 'the cycle';
    const moved = change?.to ? `Moved to Cycle ${change.to.number}.` : 'Removed from the cycle.';
    return activity.actor
      ? `${who} ended ${ended}. ${moved}`
      : `${ended.charAt(0).toUpperCase()}${ended.slice(1)} ended. ${moved}`;
  }
  if (activity.type === 'task.created') {
    // The title and description are on screen already; the rest are values that differ from defaults.
    const extras = activity.changes
      .filter((change) => change.field !== 'title' && change.field !== 'description')
      .map(changeSentence);
    return `${[`${who} created the task`, ...extras].join(', ')}${commit}`;
  }
  const cause = activity.cause?.kind === 'pull_request' ? activity.cause : null;
  // "GitHub moved this to In review · #482 opened by claude-dev": a request event moved the task.
  const changes = activity.changes.map((change) =>
    cause && change.field === 'status' && change.to
      ? `moved this to ${statusLabel(change.to)}`
      : changeSentence(change),
  );
  if (activity.backlogFields?.length) changes.push(`changed ${activity.backlogFields.join(', ')}`);
  const event = cause
    ? ` · ${requestRef(cause.provider, cause.number)} ${EVENT_WORDS[cause.event]}${cause.by ? ` by ${cause.by}` : ''}`
    : '';
  return `${who} ${changes.length ? changes.join(', ') : 'updated the task'}${event}${commit}`;
}

/** "all projects, write" or "PAY, WEB, read". */
export function scopeLabel(scope: NonNullable<Me['auth']['scope']>): string {
  const projects = scope.projects === 'all' ? 'all projects' : scope.projects.map((p) => p.key).join(', ');
  return `${projects}, ${scope.access}`;
}

export const milestoneStatusLabel = (status: MilestoneStatus) => MILESTONE_STATUS_LABELS[status];
export const cycleStateLabel = (state: CycleState) => CYCLE_STATE_LABELS[state];

/** "Cycle 12" or "Cycle 12 · Checkout rewrite". */
export function cycleLabel(cycle: { number: number; name: string | null }): string {
  return cycle.name ? `Cycle ${cycle.number} · ${cycle.name}` : `Cycle ${cycle.number}`;
}

/** "2026-10-12 to 2026-10-25" (both days included). */
export function cycleDates(cycle: { startsOn: string; endsOn: string }): string {
  return `${cycle.startsOn} to ${cycle.endsOn}`;
}

/** Done share of the non-canceled tasks: "3/5 · 60%". */
export function progressLabel(progress: { total: number; done: number; canceled: number }): string {
  const counted = progress.total - progress.canceled;
  const percent = counted > 0 ? Math.round((progress.done / counted) * 100) : 0;
  return `${progress.done}/${counted} · ${percent}%`;
}

/** Mention links ([@Ana Ruiz](mention:<id>)) read as plain @Ana Ruiz in a terminal. */
export function plainMentions(body: string): string {
  return body.replace(/\[@([^\]]+)\]\(mention:[^)\s]+\)/g, '@$1');
}

/** "claude-dev for Ana Ruiz" for an agent's comment, the author's name otherwise. */
export function commentAuthor(comment: Pick<Comment, 'author' | 'onBehalfOf'>): string {
  return comment.onBehalfOf ? `${comment.author.name} for ${comment.onBehalfOf.name}` : comment.author.name;
}

const COMMENT_INDENT = '    ';

/** "laptop · feat/payout-retries": where the CLI sent a change from (M6). Empty when unknown. */
export function sourceLabel(source: EntrySource | null | undefined): string {
  return [source?.machine, source?.branch].filter(Boolean).join(' · ');
}

/** Markdown indented under a heading line; blank lines stay blank. */
export function indentBody(text: string, indent = COMMENT_INDENT): string {
  return text
    .replace(/\s+$/, '')
    .split('\n')
    .map((line) => (line.trim() ? `${indent}${line}` : ''))
    .join('\n');
}

/**
 * A comment as a block: a heading line with time, author and id, then the body indented. Deleted
 * comments keep their place as one line. A work note (M6) reads "added a note" and names the
 * machine and branch it came from.
 */
export function commentBlock(comment: Comment, style: Style): string {
  const time = style.dim(formatTime(comment.createdAt));
  const note = comment.kind === 'note';
  if (comment.body === null) {
    return `${time}  ${style.dim(`${note ? 'Note' : 'Comment'} deleted by ${commentAuthor(comment)}`)}`;
  }
  const edited = comment.editedAt ? ' (edited)' : '';
  const verb = note ? 'added a note' : 'commented';
  const tail = style.dim([comment.id, sourceLabel(comment.source)].filter(Boolean).join('  '));
  const head = `${time}  ${style.bold(commentAuthor(comment))} ${verb}${edited}  ${tail}`;
  return `${head}\n${indentBody(plainMentions(comment.body))}`;
}

/** An activity entry on one line, with its machine and branch when the CLI sent them. */
function activityLine(activity: Activity, style: Style): string {
  const source = sourceLabel(activity.source);
  return `${style.dim(formatTime(activity.createdAt))}  ${activitySentence(activity)}${source ? `  ${style.dim(source)}` : ''}`;
}

/**
 * Activity as one line each, comments and notes as indented blocks set off by blank lines, oldest
 * first.
 */
export function timelineText(items: TimelineItem[], style: Style): string {
  const lines: string[] = [];
  let afterBlock = false;
  for (const item of items) {
    const isBlock = item.kind !== 'activity' && item.body !== null;
    if (lines.length && (isBlock || afterBlock)) lines.push('');
    lines.push(item.kind === 'activity' ? activityLine(item, style) : commentBlock(item, style));
    afterBlock = isBlock;
  }
  return lines.length ? `${lines.join('\n')}\n` : '';
}

// ---------------------------------------------------------------------------
// Work record (M6)
// ---------------------------------------------------------------------------

/** "[x]" checked, "[ ]" open, "[~]" waived: the word "waived" follows, so it never rests on the mark alone. */
const ITEM_MARKS: Record<WorkItem['state'], string> = { open: '[ ]', checked: '[x]', waived: '[~]' };

/** "4 of 6 settled (1 waived)", from the items themselves. */
export function itemProgress(items: readonly WorkItem[]): string {
  const settled = items.filter((item) => item.state !== 'open').length;
  const waived = items.filter((item) => item.state === 'waived').length;
  return `${settled} of ${items.length} settled${waived ? ` (${waived} waived)` : ''}`;
}

/**
 * One list as numbered lines: "  [x] 1  Refunds post a ledger entry", then for a waived item
 * "waived: <reason>" and who waived it.
 */
export function itemLines(items: readonly WorkItem[], style: Style): string {
  const width = String(items.length).length;
  return items
    .map((item) => {
      const number = String(item.number).padStart(width);
      const line = `  ${ITEM_MARKS[item.state]} ${number}  ${item.text}`;
      if (item.state !== 'waived') return item.state === 'checked' ? style.dim(line) : line;
      const by = item.waivedBy ? ` (${item.waivedBy.name})` : '';
      return `${style.dim(line)}\n  ${' '.repeat(width + 6)}${style.warn('waived')}: ${item.waivedReason ?? ''}${by}`;
    })
    .join('\n');
}

/** "by claude-dev for Ana Ruiz, 2026-11-03 14:02": who last wrote the plan or the summary. */
export function workTextByline(meta: WorkTextMeta | null | undefined): string {
  if (!meta) return '';
  const author = meta.author?.name ?? (meta.origin === 'backlog' ? 'Backlog.md' : 'someone');
  const who = meta.onBehalfOf ? `${author} for ${meta.onBehalfOf.name}` : author;
  return `by ${who}, ${formatTime(meta.at)}`;
}
