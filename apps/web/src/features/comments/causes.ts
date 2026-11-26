import {
  type Activity,
  type ActivityCause,
  type ActivitySystemActor,
  BACKLOG_ACTOR_NAME,
  type GitProvider,
  type MergedOpen,
  type PullRequestLink,
  type TaskStatus,
} from '@zamu/contracts';
import { requestRef } from '~/ui';

// Who a history line without an actor names and why (M7, design call 3): a git host for request events
// ("GitHub moved this to In review · #482 opened by claude-dev"), Zamu for its own jobs ("Zamu archived
// this · 14 days after it was done"), Backlog.md for a refresh. The reason after the dot comes from the
// entry's cause, or for links from how the request was linked.

/** History names hosts by product: Gitea and Forgejo read "Forgejo". */
export const HOST_NAMES: Record<GitProvider, string> = {
  github: 'GitHub',
  gitlab: 'GitLab',
  gitea: 'Forgejo',
};

/** The two letters on a host's avatar in the history. */
export const HOST_MARKS: Record<GitProvider, string> = { github: 'GH', gitlab: 'GL', gitea: 'FJ' };

/** The system actor of an entry with no actor: `system`, or what a server before M7 meant. */
export function systemOf(
  activity: Pick<Activity, 'actor' | 'origin' | 'system' | 'cause'>,
): ActivitySystemActor | null {
  if (activity.actor) return null;
  if (activity.system) return activity.system;
  if (activity.origin === 'backlog') return { kind: 'backlog' };
  if (activity.origin === 'git') {
    return {
      kind: 'git',
      provider: activity.cause?.kind === 'pull_request' ? activity.cause.provider : 'github',
    };
  }
  return { kind: 'zamu' };
}

export function systemName(system: ActivitySystemActor): string {
  if (system.kind === 'git') return HOST_NAMES[system.provider];
  return system.kind === 'zamu' ? 'Zamu' : BACKLOG_ACTOR_NAME;
}

const EVENT_WORDS: Record<Extract<ActivityCause, { kind: 'pull_request' }>['event'], string> = {
  opened: 'opened',
  ready: 'marked ready',
  reopened: 'reopened',
  merged: 'merged',
  closed: 'closed',
};

/** What the history line needs to know about the task now. */
export interface CauseContext {
  /** The task's status: an archived task's status is the one it was archived in. */
  status?: TaskStatus;
  /** The task's requests, for the branch a link came from. */
  pullRequests?: readonly PullRequestLink[];
  /** The flag of a merge with open items, for "2 criteria still open". */
  mergedOpen?: MergedOpen | null;
  /** The id of the entry the merge flag belongs to (the latest merge that moved the task to Done). */
  mergedEntryId?: string | null;
}

/** "2 criteria still open", "3 items still open". */
function stillOpen(flag: MergedOpen): string {
  if (flag.openDoneItems === 0) {
    return `${flag.openCriteria} ${flag.openCriteria === 1 ? 'criterion' : 'criteria'} still open`;
  }
  const total = flag.openCriteria + flag.openDoneItems;
  return `${total} ${total === 1 ? 'item' : 'items'} still open`;
}

/**
 * The reason after the dot, or null: "#482 opened by claude-dev", "work started on feat/payout-retries",
 * "named in the description", "14 days after it was done".
 */
export function describeCause(
  activity: Pick<Activity, 'id' | 'type' | 'changes' | 'cause' | 'actor'>,
  context: CauseContext = {},
): string | null {
  const change = activity.changes.find((item) => item.field === 'pullRequest');
  // Links by the system: say how, which is why the request belongs to the task.
  if (!activity.actor && change?.field === 'pullRequest') {
    if (change.to) {
      if (change.to.how === 'branch') {
        const branch = context.pullRequests?.find(
          (request) => request.number === change.to?.number,
        )?.headBranch;
        return branch ? `work started on ${branch}` : 'work started on its branch';
      }
      if (change.to.how === 'description') return 'named in the description';
      return null;
    }
    if (change.from?.how === 'description') return 'no longer named in the description';
    if (change.from?.how === 'branch') return 'work moved to another branch';
    return null;
  }
  const cause = activity.cause;
  if (!cause) return null;
  if (cause.kind === 'archive') {
    const closed = context.status === 'canceled' ? 'canceled' : 'done';
    return `${cause.afterDays} ${cause.afterDays === 1 ? 'day' : 'days'} after it was ${closed}`;
  }
  const words = `${requestRef(cause.provider, cause.number)} ${EVENT_WORDS[cause.event]}${cause.by ? ` by ${cause.by}` : ''}`;
  if (
    cause.event === 'merged' &&
    context.mergedOpen &&
    context.mergedEntryId != null &&
    context.mergedEntryId === activity.id
  ) {
    return `${words}, ${stillOpen(context.mergedOpen)}`;
  }
  return words;
}

/** The latest entry where a merge moved the task to Done: the one the "still open" words go on. */
export function mergedEntryOf(items: readonly { kind: string }[]): string | null {
  for (let index = items.length - 1; index >= 0; index--) {
    const item = items[index] as { kind: string } & Partial<Activity>;
    if (item.kind !== 'activity') continue;
    if (
      item.cause?.kind === 'pull_request' &&
      item.cause.event === 'merged' &&
      item.changes?.some((change) => change.field === 'status' && change.to === 'done')
    ) {
      return item.id ?? null;
    }
  }
  return null;
}
