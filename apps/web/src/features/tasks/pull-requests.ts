import { ORPCError } from '@orpc/client';
import { useMutation, useQueryClient } from '@tanstack/react-query';
import type { GitProvider, PullRequestLink, PullRequestState, Task } from '@zamu/contracts';
import { useApi } from '~/lib/workspace';
import { requestRef } from '~/ui';
import { describeError } from './errors';
import { formatDay } from './format';
import {
  type CachedTask,
  cancelTaskQueries,
  editTaskCaches,
  invalidateTask,
  restoreTaskCaches,
} from './queries';

// Pull and merge requests on a task (M7): reading a pasted address, the words around the request list,
// and linking and unlinking by hand. The server decides what links; the browser only reads the address
// to say early that it is not a request, and to name the other repository when the server refuses one.

/** A pasted request address, as far as the browser can tell. */
export interface RequestAddress {
  /** The address to send: https:// added when it was left out. */
  url: string;
  provider: GitProvider;
  host: string;
  /** owner/repo, or group/subgroup/repo on GitLab. */
  repository: string;
  number: number;
}

/**
 * Reads https://github.com/o/r/pull/12, https://gitlab.example.com/g/s/r/-/merge_requests/12 and
 * https://forgejo.example.com/o/r/pulls/12 (trailing paths, query and fragment ignored; the scheme may
 * be left out). Null for anything else, an issue address included.
 */
export function parseRequestAddress(text: string): RequestAddress | null {
  const trimmed = text.trim();
  if (!trimmed || /\s/.test(trimmed)) return null;
  const withScheme = /^[a-z][a-z0-9+.-]*:\/\//i.test(trimmed) ? trimmed : `https://${trimmed}`;
  let url: URL;
  try {
    url = new URL(withScheme);
  } catch {
    return null;
  }
  // Any host name: self-hosted servers often have none with a dot (http://gitea:3000). The path below
  // decides whether it is a request; the server checks it belongs to the project's repository.
  if ((url.protocol !== 'https:' && url.protocol !== 'http:') || !url.hostname) return null;
  const path = url.pathname.replace(/\/+$/, '');
  const gitlab = /^\/(.+?)\/-\/merge_requests\/(\d+)(?:\/.*)?$/.exec(path);
  const github = /^\/([^/]+\/[^/]+)\/pull\/(\d+)(?:\/.*)?$/.exec(path);
  const gitea = /^\/([^/]+\/[^/]+)\/pulls\/(\d+)(?:\/.*)?$/.exec(path);
  const match = gitlab ?? github ?? gitea;
  if (!match) return null;
  const number = Number(match[2]);
  if (!Number.isSafeInteger(number) || number < 1) return null;
  return {
    url: `${url.protocol}//${url.host}${url.pathname}`,
    provider: gitlab ? 'gitlab' : github ? 'github' : 'gitea',
    host: url.host,
    repository: match[1] ?? '',
    number,
  };
}

const OPEN_STATES: readonly PullRequestState[] = ['open', 'draft'];
export const isOpenRequest = (request: Pick<PullRequestLink, 'state'>) => OPEN_STATES.includes(request.state);

/** "today", "yesterday", "on Nov 3". */
function whenWords(at: string, now: Date): string {
  const day = (value: Date) => Date.UTC(value.getFullYear(), value.getMonth(), value.getDate());
  const days = Math.round((day(now) - day(new Date(at))) / 86_400_000);
  if (days <= 0) return 'today';
  if (days === 1) return 'yesterday';
  return `on ${formatDay(at, now)}`;
}

/**
 * The words after "Pull requests" (frames 051, 052, 063): "1 open", "2 still open" when others are
 * merged or closed, "merged yesterday by Tomás Ferrer" when none is open, "closed" when every one was
 * closed without merging. Times need the clock: pass `now` once useNow() has a value.
 */
export function requestsSummary(requests: readonly PullRequestLink[], now: number | null): string {
  if (requests.length === 0) return '';
  const open = requests.filter(isOpenRequest).length;
  if (open > 0) return open < requests.length ? `${open} still open` : `${open} open`;
  const merged = requests
    .filter((request) => request.state === 'merged' && request.mergedAt)
    .sort((a, b) => (b.mergedAt ?? '').localeCompare(a.mergedAt ?? ''))[0];
  if (merged) {
    const when = now == null || !merged.mergedAt ? '' : ` ${whenWords(merged.mergedAt, new Date(now))}`;
    return `merged${when}${merged.mergedBy ? ` by ${merged.mergedBy}` : ''}`;
  }
  return requests.length === 1 ? 'closed without merging' : 'all closed without merging';
}

/** "#482 and #485", "#479, #482 and #485". */
export function requestRefs(requests: readonly Pick<PullRequestLink, 'provider' | 'number'>[]): string {
  const refs = requests.map((request) => requestRef(request.provider, request.number));
  if (refs.length <= 1) return refs[0] ?? '';
  return `${refs.slice(0, -1).join(', ')} and ${refs.at(-1)}`;
}

/**
 * The line under several open requests (frame 052): the task moves to Done only when the last of them
 * is merged or closed. Null when one or none is open, or when nothing moves the task.
 */
export function moveNote(task: Pick<Task, 'key' | 'status'>, requests: readonly PullRequestLink[]) {
  const open = requests.filter(isOpenRequest);
  if (open.length < 2 || task.status === 'done' || task.status === 'canceled') return null;
  return `${task.key} moves to Done when ${requestRefs(open)} are merged or closed. A request closed without merging changes nothing.`;
}

/** "github.com/northwind/payments" as "northwind/payments" when the pasted address is on the same host. */
function shortRepository(repository: string, host: string): string {
  const [first, ...rest] = repository.split('/');
  return first?.toLowerCase() === host.toLowerCase() && rest.length ? rest.join('/') : repository;
}

/** Why a pasted address can't link, in the words of frames 058 and 059. */
export type LinkRefusal =
  | { kind: 'not-a-request' }
  | { kind: 'other-repository'; text: string }
  | { kind: 'other'; text: string };

export const NOT_A_REQUEST_TEXT =
  "That isn't a pull or merge request address. Paste the link from GitHub, GitLab or Forgejo.";

/** The refusal for an error of POST /tasks/{key}/pull-requests. */
export function linkRefusal(
  error: unknown,
  address: RequestAddress | null,
  projectName: string,
): LinkRefusal {
  if (error instanceof ORPCError) {
    if (error.code === 'NOT_A_REQUEST' || error.code === 'BAD_REQUEST') return { kind: 'not-a-request' };
    if (error.code === 'REQUEST_OTHER_REPOSITORY') {
      const linked = (error.data as { repository?: unknown } | undefined)?.repository;
      if (address && typeof linked === 'string') {
        const ref = requestRef(address.provider, address.number);
        return {
          kind: 'other-repository',
          text: `${ref} is in ${address.repository}. ${projectName} is linked to ${shortRepository(linked, address.host)}, and only its requests can be linked here.`,
        };
      }
      return { kind: 'other-repository', text: error.message || 'That request is in another repository.' };
    }
  }
  return { kind: 'other', text: describeError(error).message };
}

/** Links a request by hand (dry run for the preview is a query; see PullRequestsSection). */
export function useLinkPullRequest(taskKey: string) {
  const api = useApi();
  const queryClient = useQueryClient();
  return useMutation({
    mutationKey: api.orpc.pullRequests.link.mutationKey(),
    mutationFn: (url: string) => api.client.pullRequests.link({ key: taskKey, url }),
    onSuccess: (link) => {
      const queryKey = api.orpc.tasks.get.queryKey({ input: { key: taskKey } });
      const task = queryClient.getQueryData(queryKey);
      if (task) {
        const others = (task.pullRequests ?? []).filter((item) => item.number !== link.number);
        queryClient.setQueryData(queryKey, { ...task, pullRequests: [link, ...others] });
      }
    },
    // A hand link acts like a live event and may move the task: read it again.
    onSettled: () => invalidateTask(api, queryClient, taskKey),
  });
}

/** Removes a link. It never comes back by branch or description; linking it by hand restores it. */
export function useUnlinkPullRequest(taskKey: string) {
  const api = useApi();
  const queryClient = useQueryClient();
  return useMutation({
    mutationKey: api.orpc.pullRequests.unlink.mutationKey(),
    mutationFn: (number: number) => api.client.pullRequests.unlink({ key: taskKey, number }),
    onMutate: async (number) => {
      await cancelTaskQueries(api, queryClient);
      return editTaskCaches(
        api,
        queryClient,
        new Map([
          [
            taskKey,
            <T extends CachedTask>(item: T): T =>
              'pullRequests' in item && item.pullRequests
                ? { ...item, pullRequests: item.pullRequests.filter((request) => request.number !== number) }
                : item,
          ],
        ]),
      );
    },
    onError: (_error, _number, snapshot) => restoreTaskCaches(queryClient, snapshot),
    onSettled: () => invalidateTask(api, queryClient, taskKey),
  });
}
