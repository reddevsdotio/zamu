// Pure helpers of the Repository settings page (M7 frames 069 to 080): which webhook line to show,
// the sentences that carry times, the connections that fit a repository's host, and how API errors
// read on the page. Kept out of the components so the copy is tested on its own.
import { ORPCError } from '@orpc/client';
import { type GitConnection, parseRepositoryUrl, type RepositorySettings } from '@zamu/contracts';
import type { WebhookStatus } from '~/ui';

const MINUTE = 60_000;
const HOUR = 60 * MINUTE;
const DAY = 24 * HOUR;

/** The webhook line's state: no event yet, the last event went through, or it failed. */
export function webhookStatus(
  settings: Pick<RepositorySettings, 'webhook'>,
): Exclude<WebhookStatus, 'loading'> {
  const status = settings.webhook?.lastStatus;
  if (!status || !settings.webhook?.lastAt) return 'never';
  return status;
}

/** "just now", "1 minute ago", "4 minutes ago", "2 hours ago", "3 days ago", then "on Oct 21". */
export function agoLong(value: string, now: number): string {
  const elapsed = Math.max(0, now - new Date(value).getTime());
  if (elapsed < MINUTE) return 'just now';
  const plural = (count: number, unit: string) => `${count} ${unit}${count === 1 ? '' : 's'} ago`;
  if (elapsed < HOUR) return plural(Math.floor(elapsed / MINUTE), 'minute');
  if (elapsed < DAY) return plural(Math.floor(elapsed / HOUR), 'hour');
  if (elapsed < 7 * DAY) return plural(Math.floor(elapsed / DAY), 'day');
  const date = new Date(value);
  const sameYear = date.getFullYear() === new Date(now).getFullYear();
  return `on ${date.toLocaleDateString('en-US', {
    month: 'short',
    day: 'numeric',
    ...(sameYear ? {} : { year: 'numeric' }),
  })}`;
}

/** "14:45", 24-hour, in the browser's time zone. */
export function clockText(value: string): string {
  return new Date(value).toLocaleTimeString('en-GB', { hour: '2-digit', minute: '2-digit' });
}

/**
 * The hourly-check sentence: when Zamu last looked and when it looks next. Only with a clock (useNow),
 * since both depend on it.
 */
export function syncText(sync: RepositorySettings['sync'], now: number): string {
  const lead = 'Zamu checks the repository once an hour.';
  const next = sync.nextAt ? clockText(sync.nextAt) : null;
  if (!sync.lastAt) return next ? `${lead} First check at ${next}.` : lead;
  return `${lead} Last check ${agoLong(sync.lastAt, now)}${next ? `, next at ${next}` : ''}.`;
}

/** What the close-on-merge switch does, on and off (frames 071 and 073). */
export function closeOnMergeText(on: boolean, defaultBranch: string | null): string {
  const branch = defaultBranch ?? 'the default branch';
  return on
    ? `A task moves to Done when its last open request merges into ${branch}. Agents stop at In review and leave Done to the merge.`
    : 'Off: requests still link to their tasks and a new request still moves a task to In review, but the status stays where it is after a merge. Agents set Done themselves.';
}

/** Why the switch is off and locked while Backlog.md owns the status. */
export const MIRRORED_CLOSE_TEXT =
  'Off while the project mirrors Backlog.md: the files own each task’s status, so requests link to tasks but move none.';

/** Hostname without port or IPv6 brackets, lowercase: a connection's `host:port` against a repository's host. */
export function bareHost(host: string): string {
  const lower = host.trim().toLowerCase();
  const ipv6 = /^\[([^\]]+)\](?::\d+)?$/.exec(lower);
  if (ipv6) return ipv6[1] as string;
  return lower.replace(/:\d+$/, '');
}

/** The host a repository URL names, or null when the value is not a clone URL. */
export function repositoryHostOf(value: string): string | null {
  return parseRepositoryUrl(value)?.host ?? null;
}

/** Connections that can read a repository on `host`, working ones first. */
export function connectionsForHost<T extends Pick<GitConnection, 'host' | 'status' | 'name'>>(
  connections: readonly T[],
  host: string | null,
): T[] {
  if (!host) return [];
  const wanted = bareHost(host);
  const rank = (connection: T) => (connection.status === 'working' ? 0 : 1);
  return connections
    .filter((connection) => bareHost(connection.host) === wanted)
    .sort((a, b) => rank(a) - rank(b) || a.name.localeCompare(b.name));
}

/**
 * The connection the Change dialog starts on: the current one while it fits the host, else the
 * only working connection for that host (as the server picks), else none.
 */
export function initialConnection(
  current: string | null,
  matching: readonly Pick<GitConnection, 'id' | 'status'>[],
): string | null {
  if (current && matching.some((connection) => connection.id === current)) return current;
  const working = matching.filter((connection) => connection.status === 'working');
  return working.length === 1 ? (working[0]?.id ?? null) : null;
}

/** The short form of a repository URL ("github.com/northwind/payments"), or the URL as entered. */
export function repositoryShort(value: string): string {
  return parseRepositoryUrl(value)?.short ?? value;
}

/** A failed repository or project write, as a sentence for the page. */
export function repositoryFailure(error: unknown): string {
  if (error instanceof ORPCError) {
    if (error.code === 'FORBIDDEN') return 'Only owners and admins can change the repository settings.';
    if (error.code === 'UNAUTHORIZED') return 'Your session ended. Sign in again to save.';
    if (error.code === 'NOT_FOUND') return error.message || 'This project no longer exists.';
    const issues = (error.data as { issues?: { message: string }[] } | undefined)?.issues;
    if (issues?.[0]?.message) return issues[0].message.replace(/\.?$/, '.');
    if (error.message) return error.message.replace(/\.?$/, '.');
  }
  return 'Couldn’t save. Check your connection and try again.';
}
