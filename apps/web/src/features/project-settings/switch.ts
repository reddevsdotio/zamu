// The switch of a mirrored project to Zamu (M6, frames 031 to 038): the shapes the dialog works with and
// the words it shows. The check lists the open pull or merge requests that change the Backlog.md folder,
// or says why the host could not answer; the switch itself runs once the project key is typed. Pure
// functions, so every state can be tested without rendering.
import type { GitConnectionRef } from '@zamu/contracts';

/** One open request from the check: GitLab numbers merge requests !12, the others #12. */
export interface SwitchRequest {
  number: number;
  title: string;
  /** Login of who opened it; null when the host does not say. */
  author: string | null;
  headBranch: string;
  webUrl: string;
}

/** Why the check could not list the requests (core's BacklogSwitchFailure). */
export type SwitchFailure = 'rejected' | 'unreachable' | 'rate_limited' | 'not_found' | 'unavailable';

/** What the check returns (core's BacklogSwitchCheck). */
export type SwitchCheck =
  | {
      ok: true;
      project: string;
      repository: string;
      folder: string;
      requests: SwitchRequest[];
      /** More requests were open than the check looked at. */
      truncated: boolean;
      listUrl: string;
      checkedAt: string;
    }
  | { ok: false; project: string; reason: SwitchFailure; message: string; checkedAt: string };

/** What the switch returns: when and by whom (core's BacklogSwitchResult, without the status). */
export interface SwitchResult {
  project: string;
  switchedAt: string;
  switchedBy: { id: string; name: string };
}

/** Requests listed before "35 more". */
export const SHOWN_REQUESTS = 5;

type Provider = GitConnectionRef['provider'];

/** "merge request" on GitLab, "pull request" on GitHub and Gitea / Forgejo. */
export function requestNoun(provider: Provider | null | undefined, count = 1): string {
  const noun = provider === 'gitlab' ? 'merge request' : 'pull request';
  return count === 1 ? noun : `${noun}s`;
}

/** "GitLab", "GitHub", or the host of a Gitea / Forgejo server ("codeberg.org"). */
export function hostLabel(connection: Pick<GitConnectionRef, 'provider' | 'host'> | null): string {
  if (!connection) return 'the git host';
  if (connection.provider === 'github') return 'GitHub';
  if (connection.provider === 'gitlab') return 'GitLab';
  return connection.host;
}

/** "!214" on GitLab, "#214" elsewhere. */
export function requestNumber(provider: Provider | null | undefined, number: number): string {
  return `${provider === 'gitlab' ? '!' : '#'}${number}`;
}

/** "Checking open merge requests on GitLab…" */
export function checkingText(connection: Pick<GitConnectionRef, 'provider' | 'host'> | null): string {
  return `Checking open ${requestNoun(connection?.provider, 2)} on ${hostLabel(connection)}…`;
}

/** "No open merge request changes the task files. Nothing will be lost." */
export function noneOpenText(provider: Provider | null | undefined): string {
  return `No open ${requestNoun(provider)} changes the task files. Nothing will be lost.`;
}

/**
 * "3 open merge requests change task files. Their task edits will be lost. Merge or close them first, or
 * redo the edits in Zamu afterwards." A cut list says "At least".
 */
export function loseText(provider: Provider | null | undefined, count: number, truncated: boolean): string {
  const noun = requestNoun(provider, count);
  const one = count === 1 && !truncated;
  const howMany = truncated ? `At least ${count}` : `${count}`;
  return one
    ? `1 open ${noun} changes task files. Its task edits will be lost. Merge or close it first, or redo the edits in Zamu afterwards.`
    : `${howMany} open ${noun} change task files. Their task edits will be lost. Merge or close them first, or redo the edits in Zamu afterwards.`;
}

/** The first requests to list and how many more there are. */
export function shownRequests(requests: readonly SwitchRequest[]): {
  shown: SwitchRequest[];
  more: number;
} {
  if (requests.length <= SHOWN_REQUESTS + 1) return { shown: [...requests], more: 0 };
  return { shown: requests.slice(0, SHOWN_REQUESTS), more: requests.length - SHOWN_REQUESTS };
}

/**
 * The first sentence of a failed check. The second is the reason core gives ("gitlab.com did not answer
 * in time.").
 */
export function failureHeadline(
  connection: Pick<GitConnectionRef, 'provider' | 'host'> | null,
  reason: SwitchFailure,
): string {
  const what = `open ${requestNoun(connection?.provider, 2)}`;
  const host = hostLabel(connection);
  if (reason === 'unreachable') return `Couldn’t reach ${host} to check for ${what}.`;
  return `Couldn’t check ${host} for ${what}.`;
}

/** Whether the confirm field holds the key (any case, spaces around ignored). */
export function keyMatches(typed: string, key: string): boolean {
  return typed.trim().toUpperCase() === key.toUpperCase();
}

/** The export command the page offers after the switch. */
export function exportCommand(projectKey: string): string {
  return `zamu backlog export --project ${projectKey}`;
}
