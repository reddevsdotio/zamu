import type {
  HomeAgent,
  HomeAgentAction,
  HomeDeadline,
  HomeGroup,
  HomeGroupKey,
  HomeItem,
  HomePill,
  HomeTab,
  UserRef,
} from '@zamu/contracts';
import { describeActivity } from '~/features/tasks/format';
import { progressText } from '~/features/views/work-progress';
import { formatShortDate, type PillTone, STATUS_LABELS } from '~/ui';

// The words of Home (frames 099–106; M6 frame 064 for the criteria pill): group titles and hints, the
// "why" line of a row, pills, the
// deadlines strip, agent cards and the page title. Pure, so the screen and its tests share them.

const MINUTE = 60_000;
const HOUR = 60 * MINUTE;
const DAY = 24 * HOUR;

function elapsed(iso: string, now: number): number {
  return Math.max(0, now - new Date(iso).getTime());
}

/** "just now", "40 min ago", "2 h ago", "1 d ago". */
export function agoText(iso: string, now: number): string {
  const ms = elapsed(iso, now);
  if (ms < MINUTE) return 'just now';
  if (ms < HOUR) return `${Math.floor(ms / MINUTE)} min ago`;
  if (ms < DAY) return `${Math.floor(ms / HOUR)} h ago`;
  return `${Math.floor(ms / DAY)} d ago`;
}

/** "for 22 min", "for 3 h", "for 2 d": how long an agent has held its task. */
export function forText(iso: string, now: number): string {
  const ms = elapsed(iso, now);
  if (ms < HOUR) return `for ${Math.max(1, Math.floor(ms / MINUTE))} min`;
  if (ms < DAY) return `for ${Math.floor(ms / HOUR)} h`;
  return `for ${Math.floor(ms / DAY)} d`;
}

/** People by first name ("Tomás"), agents by their whole name ("claude-dev"). */
export function shortName(user: Pick<UserRef, 'name' | 'kind'>): string {
  if (user.kind === 'agent') return user.name;
  return user.name.trim().split(/\s+/)[0] ?? user.name;
}

/** On Mine, the person reading is "you"; the other tabs name everyone (frames 100, 101). */
function nameFor(user: UserRef, viewerId: string | undefined): string {
  return user.id === viewerId ? 'you' : shortName(user);
}

// ---------------------------------------------------------------------------
// Page title
// ---------------------------------------------------------------------------

/** "Good morning, Ana" by the browser's clock. */
export function greeting(firstName: string, now: number): string {
  const hour = new Date(now).getHours();
  const part = hour < 12 ? 'morning' : hour < 18 ? 'afternoon' : 'evening';
  return firstName ? `Good ${part}, ${firstName}` : `Good ${part}`;
}

/** "Tuesday, November 3". */
export function longDate(now: number): string {
  return new Date(now).toLocaleDateString('en-US', { weekday: 'long', month: 'long', day: 'numeric' });
}

/** "8 things need you", "1 thing needs you". */
export function needYouText(count: number): string {
  return count === 1 ? '1 thing needs you' : `${count} things need you`;
}

/** "What claude-dev and review-bot are doing", "What 4 agents are doing". */
export function agentsLine(agents: readonly Pick<HomeAgent, 'agent'>[]): string {
  const names = agents.map((card) => card.agent.name);
  if (names.length === 0) return 'No agents in this workspace yet';
  if (names.length === 1) return `What ${names[0]} is doing`;
  if (names.length === 2) return `What ${names[0]} and ${names[1]} are doing`;
  return `What ${names.length} agents are doing`;
}

// ---------------------------------------------------------------------------
// Groups
// ---------------------------------------------------------------------------

const GROUP_TITLES: Record<HomeGroupKey, string> = {
  review: 'Needs your review',
  mentions: 'Mentions',
  blocked: 'Blocked',
  overdue: 'Overdue',
  assigned: 'Assigned to you',
  dueThisWeek: 'Due this week',
  waiting: 'Waiting on a person',
};

/** Group header: "Needs your review" on Mine, "Needs review" on Everyone. */
export function groupTitle(key: HomeGroupKey, tab: HomeTab): string {
  if (key === 'review' && tab === 'everyone') return 'Needs review';
  return GROUP_TITLES[key];
}

/** The quiet hint after the count; empty when the design has none. */
export function groupHint(group: Pick<HomeGroup, 'key' | 'items'>, tab: HomeTab): string {
  switch (group.key) {
    case 'review': {
      if (tab !== 'everyone') return 'Agents and teammates asked you to look';
      const projects = new Set(group.items.map((item) => item.task.project.key)).size;
      return projects === 1 ? 'In 1 project' : `Across ${projects} projects`;
    }
    case 'mentions':
      return 'Unanswered';
    case 'blocked':
      return tab === 'mine' ? 'Your tasks waiting on another task' : '';
    case 'assigned':
      return 'By due date, then priority';
    case 'waiting':
      return 'Agents asked a question or need a review';
    default:
      return '';
  }
}

// ---------------------------------------------------------------------------
// Rows
// ---------------------------------------------------------------------------

export interface PillView {
  text: string;
  tone: PillTone;
}

/** A row's pill: "blocked", "3 d overdue", "blocks 2", "in Cycle 12", "asks a question", "needs owner". */
export function pillView(pill: HomePill): PillView {
  switch (pill.kind) {
    case 'review':
      return { text: 'in review', tone: 'default' };
    case 'blocked':
      return { text: 'blocked', tone: 'warn' };
    case 'overdue':
      return { text: `${pill.daysOverdue} d overdue`, tone: 'warn' };
    case 'due':
      return {
        text:
          pill.daysLeft === 0
            ? 'due today'
            : pill.daysLeft === 1
              ? 'due tomorrow'
              : `due in ${pill.daysLeft} d`,
        tone: 'default',
      };
    case 'blocks':
      return { text: `blocks ${pill.count}`, tone: 'default' };
    case 'cycle':
      return { text: `in Cycle ${pill.cycle.number}`, tone: 'default' };
    case 'question':
      return { text: 'asks a question', tone: 'accent' };
    case 'unassigned':
      return { text: 'needs owner', tone: 'default' };
  }
}

/**
 * The pills a row draws. "due today" and "due in 2 d" read from the due chip instead (frames 099, 100
 * show the date, not a pill); an overdue task keeps its "3 d overdue" pill and loses the chip.
 */
export function shownPills(item: HomeItem): HomePill[] {
  return item.task.dueDate ? item.pills.filter((pill) => pill.kind !== 'due') : item.pills;
}

/**
 * "4 of 6 criteria" on a Needs review row (M6, frame 064) when the task has criteria; empty
 * otherwise. The counts come with the row, so nothing more is fetched.
 */
export function criteriaPillText(item: HomeItem, group: HomeGroupKey | undefined): string {
  if (group !== 'review') return '';
  return progressText('criteria', item.task.criteriaProgress);
}

/** The due chip shows unless an overdue pill already says how late the task is. */
export function showsDueChip(item: HomeItem): boolean {
  return item.task.dueDate != null && !item.pills.some((pill) => pill.kind === 'overdue');
}

const MAX_BLOCKERS = 2;

/**
 * The "why" line at the right of a row: who asked and when ("claude-dev · 40 min ago"), who it waits
 * on ("waits on Ana"), its blockers ("by PAY-120, PAY-138"), or nothing. `now` is null until the
 * browser's clock is known; times are left out until then.
 */
export function whyText(
  item: HomeItem,
  tab: HomeTab,
  viewerId: string | undefined,
  now: number | null,
): string {
  const reason = item.reason;
  const at = (iso: string) => (now == null ? '' : agoText(iso, now));
  const join = (...parts: string[]) => parts.filter(Boolean).join(' · ');
  switch (reason.kind) {
    case 'review': {
      if (tab === 'everyone') {
        return reason.waitingOn ? `waits on ${shortName(reason.waitingOn)}` : '';
      }
      if (tab === 'agents') {
        return join(
          reason.waitingOn ? `review by ${shortName(reason.waitingOn)}` : 'in review',
          at(reason.at),
        );
      }
      return join(reason.requestedBy ? nameFor(reason.requestedBy, viewerId) : '', at(reason.at));
    }
    case 'mention':
      if (tab === 'agents') return join(`asks ${shortName(reason.mentioned)}`, at(reason.at));
      return join(nameFor(reason.author, viewerId), at(reason.at));
    case 'blocked': {
      const keys = reason.blockers.map((blocker) => blocker?.key ?? 'a removed task');
      const shown = keys.slice(0, MAX_BLOCKERS).join(', ');
      return `by ${shown}${keys.length > MAX_BLOCKERS ? ` +${keys.length - MAX_BLOCKERS}` : ''}`;
    }
    default: {
      if (item.relation === 'creator') return 'you created it';
      const progress = item.task.subtaskProgress;
      if (progress && progress.total > 0) {
        return `${progress.total} ${progress.total === 1 ? 'subtask' : 'subtasks'} · ${progress.done} done`;
      }
      return '';
    }
  }
}

/** Mine leaves out the avatar of the viewer's own tasks (they are all theirs). */
export function rowAvatar(item: HomeItem, tab: HomeTab, viewerId: string | undefined) {
  const assignee = item.task.assignee;
  if (!assignee) return null;
  if (tab === 'mine' && assignee.id === viewerId) return null;
  return assignee;
}

// ---------------------------------------------------------------------------
// Deadlines strip
// ---------------------------------------------------------------------------

export interface DeadlineView {
  id: string;
  kind: HomeDeadline['kind'];
  name: string;
  meta: string;
  when: string;
  overdue: boolean;
  /** Where it leads. */
  to:
    | { kind: 'milestone'; projectKey: string; milestoneId: string }
    | { kind: 'cycle'; projectKey: string; cycleNumber: number }
    | { kind: 'task'; projectKey: string; taskKey: string };
}

function inDays(days: number): string {
  if (days < 0) return days === -1 ? '1 day overdue' : `${-days} days overdue`;
  if (days === 0) return 'today';
  if (days === 1) return 'tomorrow';
  return `in ${days} days`;
}

function percent(progress: { done: number; total: number }): string {
  return `${progress.total === 0 ? 0 : Math.round((progress.done / progress.total) * 100)}%`;
}

export function deadlineView(deadline: HomeDeadline, today?: string): DeadlineView {
  switch (deadline.kind) {
    case 'milestone':
      return {
        id: `milestone:${deadline.milestone.id}`,
        kind: 'milestone',
        name: deadline.milestone.name,
        meta: `${formatShortDate(deadline.milestone.targetDate, today)} · ${percent(deadline.progress)}`,
        when: inDays(deadline.daysLeft),
        overdue: deadline.daysLeft < 0,
        to: { kind: 'milestone', projectKey: deadline.project.key, milestoneId: deadline.milestone.id },
      };
    case 'cycle':
      return {
        id: `cycle:${deadline.project.key}:${deadline.cycle.number}`,
        kind: 'cycle',
        name: `Cycle ${deadline.cycle.number}`,
        meta: `ends ${formatShortDate(deadline.cycle.endsOn, today)}`,
        // daysLeft counts today: 1 on the last day.
        when: inDays(deadline.daysLeft - 1),
        overdue: false,
        to: { kind: 'cycle', projectKey: deadline.project.key, cycleNumber: deadline.cycle.number },
      };
    case 'task':
      return {
        id: `task:${deadline.task.key}`,
        kind: 'task',
        name: deadline.task.key,
        meta: deadline.task.title,
        when: inDays(deadline.daysLeft),
        overdue: deadline.daysLeft < 0,
        to: { kind: 'task', projectKey: deadline.task.project.key, taskKey: deadline.task.key },
      };
  }
}

// ---------------------------------------------------------------------------
// Agent cards
// ---------------------------------------------------------------------------

function listNames(users: readonly UserRef[]): string {
  const names = users.map(shortName);
  if (names.length <= 1) return names[0] ?? '';
  return `${names.slice(0, -1).join(', ')} and ${names.at(-1)}`;
}

/** One line of an agent's log: "moved to In review", "asked Ana a question", "commented". */
export function actionText(action: HomeAgentAction): string {
  if (action.kind === 'comment') {
    if (action.mentions.length === 0) return 'commented';
    const names = listNames(action.mentions);
    return action.excerpt.includes('?') ? `asked ${names} a question` : `mentioned ${names}`;
  }
  const [only, ...rest] = action.changes;
  if (action.type !== 'task.created' && only?.field === 'status' && rest.length === 0 && only.to) {
    return `moved to ${STATUS_LABELS[only.to]}`;
  }
  return describeActivity(action);
}

/** "acts for Ana"; empty when the agent has no responsible human. */
export function actsForText(agent: HomeAgent['agent']): string {
  return agent.responsible ? `acts for ${shortName(agent.responsible)}` : '';
}
