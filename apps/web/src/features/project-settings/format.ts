// Display text for the Backlog.md section of project settings (frames 2b to 2o). Pure functions of
// the source status and the current time, so every state can be tested without rendering.
import type { BacklogProblem, BacklogSourceStatus, BacklogState, BacklogTrigger } from '@zamu/contracts';
import type { SourceDotState } from '~/ui';

const MINUTE = 60_000;
const HOUR = 60 * MINUTE;
const DAY = 24 * HOUR;

/** The dot for a source state ("setup" is the first read waiting or running). */
export function sourceDot(state: BacklogState): SourceDotState {
  switch (state) {
    case 'setup':
    case 'reading':
      return 'reading';
    case 'healthy':
      return 'healthy';
    case 'warnings':
      return 'warnings';
    case 'failed':
      return 'failed';
    case 'paused':
      return 'paused';
    case 'detached':
      return 'detached';
  }
}

/** First 7 characters of a commit hash. */
export function shortCommit(commit: string): string {
  return commit.slice(0, 7);
}

/** "just now", "4s ago", "3m ago", "2h ago", "3d ago", then "Oct 21". */
export function agoText(value: string, now: number): string {
  const elapsed = now - new Date(value).getTime();
  if (elapsed < 5_000) return 'just now';
  if (elapsed < MINUTE) return `${Math.floor(elapsed / 1000)}s ago`;
  if (elapsed < HOUR) return `${Math.floor(elapsed / MINUTE)}m ago`;
  if (elapsed < DAY) return `${Math.floor(elapsed / HOUR)}h ago`;
  if (elapsed < 7 * DAY) return `${Math.floor(elapsed / DAY)}d ago`;
  return dateText(value, now);
}

/** "Oct 23", with the year outside the current one. */
export function dateText(value: string, now: number, withYear = false): string {
  const date = new Date(value);
  const sameYear = date.getFullYear() === new Date(now).getFullYear();
  return date.toLocaleDateString('en-US', {
    month: 'short',
    day: 'numeric',
    ...(sameYear && !withYear ? {} : { year: 'numeric' }),
  });
}

/** "11:40" today, "Oct 21" before. */
export function sinceText(value: string, now: number): string {
  const date = new Date(value);
  const today = new Date(now);
  if (date.toDateString() === today.toDateString()) return timeText(value);
  return dateText(value, now);
}

/** "14:02", 24-hour. */
export function timeText(value: string): string {
  return new Date(value).toLocaleTimeString('en-GB', { hour: '2-digit', minute: '2-digit' });
}

/** "Oct 23, 14:02". */
export function stampText(value: string, now: number): string {
  return `${dateText(value, now)}, ${timeText(value)}`;
}

/** "next in 57m", "next in 1h 5m". */
function inText(value: string, now: number): string {
  const left = Math.max(0, new Date(value).getTime() - now);
  if (left < MINUTE) return 'in under a minute';
  const minutes = Math.round(left / MINUTE);
  if (minutes < 60) return `in ${minutes}m`;
  const hours = Math.floor(minutes / 60);
  const rest = minutes % 60;
  return rest ? `in ${hours}h ${rest}m` : `in ${hours}h`;
}

const TRIGGER_TEXT: Record<BacklogTrigger, string> = {
  setup: 'at setup',
  webhook: 'by webhook',
  manual: 'by Refresh now',
  cli: 'by zamu backlog refresh',
  poll: 'by the hourly check',
};

export function triggerText(trigger: BacklogTrigger | null): string {
  return trigger ? TRIGGER_TEXT[trigger] : '';
}

/** Whether the source no longer follows the repository (detached, or an import that finished). */
export function isDetached(status: Pick<BacklogSourceStatus, 'state'>): boolean {
  return status.state === 'detached';
}

/** The bold title and the faint note of the status section. */
export function statusHeading(
  status: BacklogSourceStatus,
  now: number | null,
  options: { queued?: boolean } = {},
): { title: string; note: string } {
  const at = (value: string | null, render: (value: string, now: number) => string) =>
    value && now !== null ? render(value, now) : '';
  switch (status.state) {
    case 'setup':
    case 'reading':
      return {
        title: status.lastRead ? 'Refreshing' : 'Reading for the first time',
        note:
          status.state === 'reading'
            ? at(status.lastAttemptAt, (v, n) => `started ${agoText(v, n)}`)
            : 'queued',
      };
    case 'healthy':
      if (options.queued) return { title: 'Refreshing', note: 'queued' };
      return { title: 'Mirroring', note: 'everything up to date' };
    case 'warnings':
      if (options.queued) return { title: 'Refreshing', note: 'queued' };
      return { title: 'Mirroring, with problems', note: problemsNote(status) };
    case 'failed':
      if (options.queued) return { title: 'Refreshing', note: 'queued' };
      return { title: 'Last refresh failed', note: at(status.lastAttemptAt, agoText) };
    case 'paused':
      return { title: 'Paused', note: at(status.lastAttemptAt, (v, n) => `since ${sinceText(v, n)}`) };
    case 'detached':
      return {
        title: status.mode === 'import' ? 'Imported' : 'Owned by Zamu',
        note: at(status.detachedAt, (v, n) =>
          status.mode === 'import' ? `imported ${dateText(v, n)}` : `since ${dateText(v, n)}`,
        ),
      };
  }
}

function plural(count: number, one: string, many = `${one}s`): string {
  return `${count} ${count === 1 ? one : many}`;
}

/** "30 files skipped, 1 value unmapped" from the problem page (exact when it is the only page). */
export function problemsNote(status: Pick<BacklogSourceStatus, 'problems'>): string {
  const { counts, items, nextCursor } = status.problems;
  const parts: string[] = [];
  if (nextCursor === null) {
    const files = items.filter((item) => item.kind === 'file');
    const skipped = files.filter((item) => item.skipped).length;
    const warned = files.length - skipped;
    if (skipped) parts.push(`${plural(skipped, 'file')} skipped`);
    if (warned) parts.push(`${plural(warned, 'file')} with warnings`);
  } else if (counts.files) {
    parts.push(`${plural(counts.files, 'file')} with problems`);
  }
  if (counts.values) parts.push(`${plural(counts.values, 'value')} unmapped`);
  return parts.join(', ');
}

/** Number shown after "Problems in the last refresh". */
export function problemCount(status: Pick<BacklogSourceStatus, 'problems'>): number {
  return status.problems.counts.files + status.problems.counts.values;
}

/** Mode line of the facts. */
export function modeText(status: Pick<BacklogSourceStatus, 'mode' | 'state'>): string {
  if (status.state === 'detached') {
    return status.mode === 'import' ? 'Imported once' : 'Mirrored, then switched to Zamu';
  }
  return status.mode === 'import'
    ? 'Import · reads once, then detaches'
    : 'Mirror · follows the default branch';
}

/** "3m ago, by webhook, commit" before the commit link; detached imports read "Oct 23, 14:02, commit". */
export function readText(status: BacklogSourceStatus, now: number): string {
  const read = status.lastRead;
  if (!read) return 'Not read yet';
  if (status.state === 'detached') return `${stampText(read.at, now)}, commit`;
  const by = triggerText(read.trigger);
  return `${agoText(read.at, now)}${by ? `, ${by}` : ''}, commit`;
}

/** "Hourly, next in 57m"; paused sources retry hourly. */
export function nextCheckText(
  status: Pick<BacklogSourceStatus, 'state' | 'nextPollAt'>,
  now: number,
): string {
  if (!status.nextPollAt) return status.state === 'paused' ? 'Retrying hourly' : 'None';
  if (status.state === 'paused') return `Retrying hourly, next at ${timeText(status.nextPollAt)}`;
  return `Hourly, next ${inText(status.nextPollAt, now)}`;
}

/** Webhook fact: "Last notification 3m ago" or "No notification yet". */
export function webhookText(lastAt: string | null, now: number): string {
  return lastAt ? `Last notification ${agoText(lastAt, now)}` : 'No notification yet';
}

/**
 * Every visible task of the source, as the project counts them: tasks/, drafts and archived ones.
 * Drafts come in as Backlog, so they count as open. Hidden tasks are left out.
 */
export function sourceTaskTotals(counts: BacklogSourceStatus['counts']): { total: number; open: number } {
  return { total: counts.tasks + counts.drafts + counts.archived, open: counts.open + counts.drafts };
}

/** "412 tasks, 38 open · 6 milestones". The hidden count is a separate link. */
export function contentsText(status: Pick<BacklogSourceStatus, 'counts'>): string {
  const { total, open } = sourceTaskTotals(status.counts);
  return `${plural(total, 'task')}, ${open} open · ${plural(status.counts.milestones, 'milestone')}`;
}

/** Why a paused mirror is paused, for the banner (frame 2i). */
export function pausedReason(status: BacklogSourceStatus, now: number | null): string {
  const connection = status.connection;
  const since = status.lastAttemptAt && now !== null ? ` since ${sinceText(status.lastAttemptAt, now)}` : '';
  if (!status.repository) return 'the project has no repository. Add it again under General to resume.';
  if (!connection) return 'its git connection was deleted. Pick another connection to resume.';
  if (connection.status === 'rejected')
    return `${connection.host} rejects the token of the connection ${connection.name}${since}.`;
  if (connection.status === 'unreachable')
    return `the connection ${connection.name} can't reach ${connection.host}${since}.`;
  return status.lastError
    ? `${lowerFirst(stripPeriod(status.lastError))}.`
    : `the connection ${connection.name} needs a check${since}.`;
}

/** Full text of the paused banner. */
export function pausedBanner(status: BacklogSourceStatus, now: number | null): string {
  return `The mirror is paused: ${pausedReason(status, now)} It retries every hour. Tasks stay as they were.`;
}

/** Text of the failed banner (frame 2h). */
export function failedBanner(status: BacklogSourceStatus, now: number | null): string {
  const reason = status.lastError ? ensurePeriod(status.lastError) : 'The last refresh failed.';
  const read = status.lastRead;
  const kept =
    read && now !== null
      ? ` Nothing changed: tasks show commit ${shortCommit(read.commit)} from ${agoText(read.at, now)}.`
      : ' Nothing changed.';
  return `${reason}${kept} Fix the file and push, or refresh once it's fixed.`;
}

/** Subject and text of one problem row. */
export function problemRow(problem: BacklogProblem): {
  severity: 'error' | 'warning';
  file: string;
  text: string;
} {
  if (problem.kind === 'file') {
    return { severity: problem.skipped ? 'error' : 'warning', file: problem.path, text: problem.message };
  }
  const tasks = plural(problem.count, 'task');
  const mappable = problem.field !== 'milestone';
  const text =
    problem.fallback && mappable
      ? `not mapped, shown as ${problem.fallback}. Map it in Edit mappings.`
      : problem.message;
  return { severity: 'warning', file: `${problem.field} “${problem.value}” · ${tasks}`, text };
}

/** "whsec_9Lq2……Tz4": enough to tell secrets apart, never the whole value. */
export function maskSecret(secret: string | null): string {
  if (!secret) return '••••••••••••••••';
  if (secret.length < 12) return '•'.repeat(secret.length);
  return `${secret.slice(0, 10)}……………………${secret.slice(-3)}`;
}

function stripPeriod(text: string): string {
  return text.replace(/[.\s]+$/, '');
}

function ensurePeriod(text: string): string {
  return /[.!?…]$/.test(text.trim()) ? text.trim() : `${text.trim()}.`;
}

function lowerFirst(text: string): string {
  return text.charAt(0).toLowerCase() + text.slice(1);
}
