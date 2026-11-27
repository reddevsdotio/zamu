import type { Activity, ActivityChange, ActivityWaveRef, Priority, TaskStatus } from '@zamu/contracts';
import { PRIORITY_LABELS, requestRef, STATUS_LABELS } from '~/ui';

// Display helpers for the task screens: short times, activity sentences and Markdown checkbox lists.

const MINUTE = 60_000;
const HOUR = 60 * MINUTE;
const DAY = 24 * HOUR;

const MONTHS = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'];

function toDate(value: string | Date): Date {
  return typeof value === 'string' ? new Date(value) : value;
}

/** "Oct 20", with the year when it is not the current one: "Oct 20, 2025". */
export function formatDay(value: string | Date, now: Date = new Date()): string {
  const date = toDate(value);
  const day = `${MONTHS[date.getMonth()]} ${date.getDate()}`;
  return date.getFullYear() === now.getFullYear() ? day : `${day}, ${date.getFullYear()}`;
}

/** "Oct 21, 16:02". */
export function formatDayTime(value: string | Date, now: Date = new Date()): string {
  const date = toDate(value);
  const time = `${String(date.getHours()).padStart(2, '0')}:${String(date.getMinutes()).padStart(2, '0')}`;
  return `${formatDay(date, now)}, ${time}`;
}

/** Compact age for the list's Upd column: "now", "3m", "1h", "2d", then "Oct 20". */
export function formatAge(value: string | Date, now: Date = new Date()): string {
  const elapsed = Math.max(0, now.getTime() - toDate(value).getTime());
  if (elapsed < MINUTE) return 'now';
  if (elapsed < HOUR) return `${Math.floor(elapsed / MINUTE)}m`;
  if (elapsed < DAY) return `${Math.floor(elapsed / HOUR)}h`;
  if (elapsed < 7 * DAY) return `${Math.floor(elapsed / DAY)}d`;
  return formatDay(value, now);
}

/** Detail pane timeline: "40m" or "3h" within a day, then "Oct 20". */
export function formatPaneTime(value: string | Date, now: Date = new Date()): string {
  const elapsed = Math.max(0, now.getTime() - toDate(value).getTime());
  if (elapsed < DAY) return formatAge(value, now);
  return formatDay(value, now);
}

/** Task page: "5h ago" within a day, then "Oct 21, 16:02". */
export function formatPageTime(value: string | Date, now: Date = new Date()): string {
  const elapsed = Math.max(0, now.getTime() - toDate(value).getTime());
  if (elapsed < MINUTE) return 'just now';
  if (elapsed < DAY) return `${formatAge(value, now)} ago`;
  return formatDayTime(value, now);
}

/**
 * The task view's history and properties (frames 051, 057): "Just now", "38 min ago", "2 h ago" within a
 * day, then "Oct 14".
 */
export function formatRelative(value: string | Date, now: Date = new Date()): string {
  const elapsed = Math.max(0, now.getTime() - toDate(value).getTime());
  if (elapsed < MINUTE) return 'Just now';
  if (elapsed < HOUR) return `${Math.floor(elapsed / MINUTE)} min ago`;
  if (elapsed < DAY) return `${Math.floor(elapsed / HOUR)} h ago`;
  return formatDay(value, now);
}

/** Splits a CalendarDate ("2026-11-14") into a local Date at midnight, so the day never shifts by zone. */
function calendarDate(value: string): Date {
  const [year = 1970, month = 1, day = 1] = value.split('-').map(Number);
  return new Date(year, month - 1, day);
}

/** A CalendarDate as "Nov 14", with the year when it is not the current one. */
export function formatCalendarDay(value: string, now: Date = new Date()): string {
  return formatDay(calendarDate(value), now);
}

/** "Oct 26 – Nov 8". */
export function formatDateRange(start: string, end: string, now: Date = new Date()): string {
  return `${formatCalendarDay(start, now)} – ${formatCalendarDay(end, now)}`;
}

/**
 * Binds a formatter to the clock from useNow(). Before the clock is set (SSR, hydration) it returns '',
 * so server and browser render the same markup.
 */
export function atTime(
  format: (value: string | Date, now: Date) => string,
  now: number | null,
): (value: string | Date) => string {
  if (now == null) return () => '';
  const date = new Date(now);
  return (value) => format(value, date);
}

// ---------------------------------------------------------------------------
// Markdown task lists
// ---------------------------------------------------------------------------

/** Matches a GFM task list item: indentation, bullet, space, [ ] or [x]. */
const CHECKBOX_LINE = /^(\s*(?:[-*+]|\d+[.)])\s+)\[([ xX])\]/;

export interface CheckboxItem {
  /** Line index in the source. */
  line: number;
  checked: boolean;
}

/** Every task list checkbox in a Markdown source, in order. Fenced code blocks are skipped. */
export function findCheckboxes(source: string | null | undefined): CheckboxItem[] {
  if (!source) return [];
  const items: CheckboxItem[] = [];
  let fence: string | null = null;
  source.split('\n').forEach((text, line) => {
    const marker = /^\s*(`{3,}|~{3,})/.exec(text)?.[1];
    if (marker) {
      if (fence === null) fence = marker[0] ?? null;
      else if (marker[0] === fence) fence = null;
      return;
    }
    if (fence !== null) return;
    const match = CHECKBOX_LINE.exec(text);
    if (match) items.push({ line, checked: match[2] !== ' ' });
  });
  return items;
}

/** Flips the nth checkbox (0-based, in document order). Returns the source unchanged when out of range. */
export function toggleCheckbox(source: string, index: number): string {
  const item = findCheckboxes(source)[index];
  if (!item) return source;
  const lines = source.split('\n');
  const text = lines[item.line] ?? '';
  lines[item.line] = text.replace(
    CHECKBOX_LINE,
    (_all, lead: string) => `${lead}[${item.checked ? ' ' : 'x'}]`,
  );
  return lines.join('\n');
}

/**
 * When a description change only ticks or unticks checkboxes, describes it: "checked off 2 items",
 * "unchecked 1 item". Returns null for any other edit.
 */
export function describeCheckboxChange(from: string | null, to: string | null): string | null {
  if (from == null || to == null) return null;
  const strip = (value: string) => value.replace(/^(\s*(?:[-*+]|\d+[.)])\s+)\[[ xX]\]/gm, '$1[]');
  if (strip(from) !== strip(to)) return null;
  const before = findCheckboxes(from);
  const after = findCheckboxes(to);
  let checked = 0;
  let unchecked = 0;
  after.forEach((item, index) => {
    const previous = before[index];
    if (!previous || previous.checked === item.checked) return;
    if (item.checked) checked++;
    else unchecked++;
  });
  const items = (count: number) => `${count} ${count === 1 ? 'item' : 'items'}`;
  const parts: string[] = [];
  if (checked) parts.push(`checked off ${items(checked)}`);
  if (unchecked) parts.push(`unchecked ${items(unchecked)}`);
  return parts.length ? parts.join(' and ') : null;
}

// ---------------------------------------------------------------------------
// Activity sentences
// ---------------------------------------------------------------------------

const statusLabel = (status: TaskStatus | null) => (status ? STATUS_LABELS[status] : 'none');
const priorityLabel = (priority: Priority | null) => (priority ? PRIORITY_LABELS[priority] : 'None');

function joinWords(words: readonly string[]): string {
  if (words.length <= 1) return words[0] ?? '';
  return `${words.slice(0, -1).join(', ')} and ${words.at(-1)}`;
}

/**
 * "added the label ui and removed the labels bug and docs" (labels), "added blocker PAY-120" (blockers):
 * what changed between two lists of names.
 */
function listChange(
  from: readonly string[],
  to: readonly string[],
  noun: (count: number) => string,
  fallback: string,
): string {
  const lower = (items: readonly string[]) => items.map((item) => item.toLowerCase());
  const before = lower(from);
  const after = lower(to);
  const added = to.filter((name) => !before.includes(name.toLowerCase()));
  const removed = from.filter((name) => !after.includes(name.toLowerCase()));
  const parts = [
    added.length ? `added ${noun(added.length)} ${joinWords(added)}` : null,
    removed.length ? `removed ${noun(removed.length)} ${joinWords(removed)}` : null,
  ];
  return parts.filter(Boolean).join(' and ') || fallback;
}

const labelNoun = (count: number) => (count === 1 ? 'the label' : 'the labels');
const blockerNoun = (count: number) => (count === 1 ? 'blocker' : 'blockers');

/** "W3 · Screens", or "a removed wave" once it is gone (M8). */
export function waveName(wave: ActivityWaveRef): string {
  return wave.removed ? 'a removed wave' : `W${wave.number} · ${wave.name}`;
}

/** One field change as the task view's history says it (frames 051, 057): "moved this to In progress". */
function describeChange(change: ActivityChange): string {
  switch (change.field) {
    case 'status':
      return change.to ? `moved this to ${statusLabel(change.to)}` : 'cleared the status';
    case 'priority':
      return change.to && change.to !== 'none'
        ? `set priority to ${priorityLabel(change.to)}`
        : 'cleared the priority';
    case 'assignee':
      return change.to ? `assigned this to ${change.to.name}` : 'unassigned this';
    case 'title':
      return `renamed this to “${change.to ?? ''}”`;
    case 'description': {
      const checks = describeCheckboxChange(change.from, change.to);
      if (checks) return checks;
      if (!change.to) return 'cleared the description';
      if (!change.from) return 'added a description';
      return 'edited the description';
    }
    case 'milestone':
      return change.to ? `set the milestone to ${change.to.name}` : 'cleared the milestone';
    case 'cycle':
      if (change.to) return `moved this to ${cycleName(change.to)}`;
      return change.from ? `removed this from ${cycleName(change.from)}` : 'removed this from the cycle';
    case 'labels':
      return listChange(
        change.from.map((label) => label.name),
        change.to.map((label) => label.name),
        labelNoun,
        'changed the labels',
      );
    case 'dueDate':
      if (!change.to) return 'cleared the due date';
      return change.from
        ? `moved the due date to ${formatCalendarDay(change.to)}`
        : `set the due date to ${formatCalendarDay(change.to)}`;
    case 'blockedBy':
      return listChange(
        change.from.map((task) => task.key),
        change.to.map((task) => task.key),
        blockerNoun,
        'changed the blockers',
      );
    case 'parent':
      if (change.to) return `made this a subtask of ${change.to.key}`;
      return change.from ? `moved this out of ${change.from.key}` : 'made this a top-level task';
    // M7
    case 'workBranch':
      return change.to ? `started work on ${change.to}` : 'cleared the work branch';
    case 'checkAgain':
      if (!change.to) return 'cleared the check-again day';
      return change.from && change.from.on !== change.to.on
        ? `moved check again to ${formatCalendarDay(change.to.on)}`
        : change.from
          ? 'changed why it waits'
          : `set check again to ${formatCalendarDay(change.to.on)}`;
    // M8
    case 'wave':
      if (change.to) {
        return change.from && !change.from.removed
          ? `moved this from ${waveName(change.from)} to ${waveName(change.to)}`
          : `put this in ${waveName(change.to)}`;
      }
      return change.from ? `took this out of ${waveName(change.from)}` : 'took this out of its wave';
    case 'pullRequest': {
      const request = change.to ?? change.from;
      const ref = request ? requestRef(request.provider, request.number) : 'a pull request';
      return change.to ? `linked ${ref}` : `unlinked ${ref}`;
    }
    default:
      return describeWorkChanges([change]);
  }
}

// ── M6: the work record ─────────────────────────────────────────────────────────────────────────────

type WorkChange = Exclude<
  ActivityChange,
  {
    field:
      | 'status'
      | 'priority'
      | 'assignee'
      | 'title'
      | 'description'
      | 'milestone'
      | 'cycle'
      | 'labels'
      | 'dueDate'
      | 'blockedBy'
      | 'parent'
      | 'workBranch'
      | 'checkAgain'
      | 'pullRequest'
      | 'wave';
  }
>;

const isWorkChange = (change: ActivityChange): change is WorkChange =>
  change.field.includes('.') || change.field === 'plan' || change.field === 'finalSummary';

const quoted = (text: string) => `“${text}”`;

/** "criterion 2", "criteria 3 and 4". */
function criteriaWords(numbers: readonly number[]): string {
  return numbers.length === 1 ? `criterion ${numbers[0]}` : `criteria ${joinWords(numbers.map(String))}`;
}

/** "wrote the plan", "edited the final summary", "removed the plan". */
function describeText(change: { from: string | null; to: string | null }, noun: string): string {
  if (!change.to) return `removed ${noun}`;
  return change.from ? `edited ${noun}` : `wrote ${noun}`;
}

/**
 * Changes of one kind on the work record, as one phrase (frames 013, 015): "checked criteria 3 and 4",
 * "waived criterion 5: load test replaced", "checked “Tests and lint pass”", "added 6 acceptance
 * criteria", "wrote the plan". Criteria are named by number, done items by their text.
 */
export function describeWorkChanges(changes: readonly WorkChange[]): string {
  const first = changes[0];
  if (!first) return '';
  if (first.field === 'plan' || first.field === 'finalSummary') {
    return describeText(first, first.field === 'plan' ? 'the plan' : 'the final summary');
  }
  const items = changes.filter((change): change is Extract<WorkChange, { text: string }> => 'text' in change);
  const [list, operation] = first.field.split('.') as ['criterion' | 'doneItem', string];
  const numbers = items.map((change) => ('number' in change ? change.number : 0));
  const texts = items.map((change) => quoted(change.text));
  const many = items.length > 1;
  if (list === 'criterion') {
    switch (operation) {
      case 'added':
        return many ? `added ${items.length} acceptance criteria` : `added ${criteriaWords(numbers)}`;
      case 'edited':
        return `reworded ${criteriaWords(numbers)}`;
      case 'moved':
        return first.field === 'criterion.moved' && !many
          ? `moved criterion ${first.from} to ${first.to}`
          : 'reordered the criteria';
      case 'removed':
        return many
          ? `removed ${criteriaWords(numbers)}`
          : `removed ${criteriaWords(numbers)}: ${items[0]?.text ?? ''}`;
      case 'checked':
      case 'unchecked':
        return `${operation} ${criteriaWords(numbers)}`;
      case 'waived':
        return joinWords(
          items.map((change) =>
            change.field === 'criterion.waived'
              ? `waived criterion ${change.number}: ${change.reason}`
              : `waived ${criteriaWords([numbers[0] ?? 0])}`,
          ),
        );
      case 'unwaived':
        return `removed the ${many ? 'waivers' : 'waiver'} on ${criteriaWords(numbers)}`;
    }
  } else {
    switch (operation) {
      case 'added':
        return many ? `added ${items.length} done items` : `added the done item ${texts[0]}`;
      case 'edited':
        return many ? `reworded ${items.length} done items` : `reworded the done item ${texts[0]}`;
      case 'moved':
        if (first.field === 'doneItem.moved' && !many) {
          return `moved ${quoted(first.text)} ${first.to < first.from ? 'up' : 'down'}`;
        }
        return 'reordered the done items';
      case 'removed':
        return `removed the done ${many ? 'items' : 'item'} ${joinWords(texts)}`;
      case 'checked':
      case 'unchecked':
        return `${operation} ${joinWords(texts)}`;
      case 'waived':
        return joinWords(
          items.map((change) =>
            change.field === 'doneItem.waived'
              ? `waived ${quoted(change.text)}: ${change.reason}`
              : `waived ${quoted(change.text)}`,
          ),
        );
      case 'unwaived':
        return `removed the ${many ? 'waivers' : 'waiver'} on ${joinWords(texts)}`;
    }
  }
  return 'changed the work record';
}

/** Every change as a phrase, work-record changes of one kind grouped: "checked criteria 3 and 4". */
function describeChanges(all: readonly ActivityChange[]): string[] {
  // M7: the work branch rides along with a status change, and the line's source tag already names it.
  const changes = all.length > 1 ? all.filter((change) => change.field !== 'workBranch') : all;
  const phrases: string[] = [];
  const groups = new Map<string, WorkChange[]>();
  const order: (ActivityChange | string)[] = [];
  for (const change of changes) {
    if (!isWorkChange(change)) {
      order.push(change);
      continue;
    }
    const group = groups.get(change.field);
    if (group) group.push(change);
    else {
      groups.set(change.field, [change]);
      order.push(change.field);
    }
  }
  for (const entry of order) {
    if (typeof entry === 'string') phrases.push(describeWorkChanges(groups.get(entry) ?? []));
    else phrases.push(describeChange(entry));
  }
  return phrases;
}

const cycleName = (cycle: { number: number }) => `Cycle ${cycle.number}`;

/** The verb phrase after the actor: "moved this to In progress", "created this task". */
export function describeActivity(activity: Pick<Activity, 'type' | 'changes'>): string {
  if (activity.type === 'task.created') return 'created this task';
  if (activity.type === 'task.archived') return 'archived this';
  if (activity.type === 'task.unarchived') return 'restored this';
  if (activity.type === 'cycle.ended') {
    const change = activity.changes.find((item) => item.field === 'cycle');
    if (change?.field === 'cycle' && change.from) {
      return change.to
        ? `ended ${cycleName(change.from)} and moved this to ${cycleName(change.to)}`
        : `ended ${cycleName(change.from)} and took this out of the cycle`;
    }
  }
  return joinWords(describeChanges(activity.changes)) || 'updated this task';
}

/**
 * The system line for a cycle.ended entry: "Cycle 12 ended. Moved to Cycle 13." The person who ended
 * a cycle early, if any, is named by the caller.
 */
export function describeCycleEnded(activity: Pick<Activity, 'changes'>): string {
  const change = activity.changes.find((item) => item.field === 'cycle');
  if (change?.field !== 'cycle' || !change.from) return 'The cycle ended.';
  const ended = `${cycleName(change.from)} ended.`;
  return change.to ? `${ended} Moved to ${cycleName(change.to)}.` : `${ended} Taken out of the cycle.`;
}
