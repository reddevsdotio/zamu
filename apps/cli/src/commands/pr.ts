// zamu pr link | unlink (M7): links a pull or merge request of the project's repository to a task by
// hand, or removes a link. The server reads the request from the host (Zamu never writes to it) and
// refuses addresses of other repositories and addresses that are not requests. Requests also link by
// themselves, from the task's work branch and from a `Closes:` line, so these are for the rest.
import { ORPCError } from '@orpc/client';
import {
  GetTaskInput,
  LinkPullRequestInput,
  type PullRequestLink,
  type Task,
  UnlinkPullRequestInput,
} from '@zamu/contracts';
import type { ApiClient } from '../client';
import { type CommandContext, emit } from '../context';
import { CliError, EXIT, toCliError } from '../errors';
import { pullRequestHowLabel, pullRequestStateLabel, requestRef } from '../format';
import { parseInput, type TaskRef, taskRef, withTaskRef } from './shared';

/**
 * The task as the server has it, for its app key (the command may name a Backlog.md id) and its
 * requests. Null when the server didn't answer: the write itself then queues or fails.
 */
async function currentTask(context: CommandContext, client: ApiClient, ref: TaskRef): Promise<Task | null> {
  try {
    return await withTaskRef(context, ref, (r) => client.tasks.get(parseInput(GetTaskInput, r)));
  } catch (error) {
    if (error instanceof CliError && error.exitCode === EXIT.server) return null;
    throw error;
  }
}

/** Adds a hint to a REQUEST_NOT_FOUND refusal; everything else passes through as thrown. */
function withNotFoundHint(error: unknown, context: CommandContext, hint: string): never {
  if (error instanceof ORPCError && error.code === 'REQUEST_NOT_FOUND') {
    const failure = toCliError(error, context.url);
    failure.hints.unshift(hint);
    throw failure;
  }
  throw error;
}

/** "#482  Retry failed webhook deliveries (Open, linked by hand)" and the address under it. */
function requestLines(request: PullRequestLink): string {
  const ref = requestRef(request.provider, request.number);
  return `  ${ref}  ${request.title} (${pullRequestStateLabel(request.state)}, ${pullRequestHowLabel(request)})\n  ${request.url}\n`;
}

export interface LinkOptions {
  project?: string;
  dryRun?: boolean;
}

/** zamu pr link TASK URL [--dry-run]. */
export async function linkPullRequest(
  context: CommandContext,
  key: string,
  url: string,
  options: LinkOptions,
): Promise<void> {
  const ref = await taskRef(context, key, options.project);
  const dryRun = options.dryRun === true;
  // Validate before any request: the key and the address's form (the server checks the rest).
  const checked = parseInput(LinkPullRequestInput, { ...ref, url, ...(dryRun ? { dryRun } : {}) });
  const client = await context.client();
  const task = await currentTask(context, client, ref);
  const target: TaskRef = task ? { key: task.key } : ref;
  const request = await client.pullRequests
    .link({ ...checked, key: target.key, project: target.project })
    .catch((error: unknown) =>
      withNotFoundHint(
        error,
        context,
        "The host doesn't know that request, or Zamu can't read the repository: check the number, " +
          "and that the project's repository settings name a connection that can read it.",
      ),
    );
  emit(context, 'pr.link', { task: task?.key ?? checked.key, pullRequest: request, dryRun }, (data) => {
    const { style } = context;
    const ref = requestRef(data.pullRequest.provider, data.pullRequest.number);
    if (data.dryRun) {
      return (
        `Would link ${ref} to ${style.bold(data.task)}; nothing was written. Run it again without --dry-run to link it.\n` +
        requestLines(data.pullRequest)
      );
    }
    return `Linked ${ref} to ${style.bold(data.task)}\n${requestLines(data.pullRequest)}`;
  });
}

/** zamu pr unlink TASK NUMBER. The link stays removed until it is linked by hand again. */
export async function unlinkPullRequest(
  context: CommandContext,
  key: string,
  number: string,
  options: { project?: string },
): Promise<void> {
  const ref = await taskRef(context, key, options.project);
  // "#482" and "!12" as the hosts write them work too.
  const checked = parseInput(UnlinkPullRequestInput, { ...ref, number: number.trim().replace(/^[#!]/, '') });
  const client = await context.client();
  const task = await currentTask(context, client, ref);
  const target: TaskRef = task ? { key: task.key } : ref;
  const linked = task?.pullRequests?.find((request) => request.number === checked.number);
  const shownKey = task?.key ?? checked.key;
  await client.pullRequests
    .unlink({ ...checked, key: target.key, project: target.project })
    .catch((error: unknown) =>
      withNotFoundHint(error, context, `zamu tasks show ${shownKey} lists the requests it links.`),
    );
  emit(context, 'pr.unlink', { task: shownKey, number: checked.number }, (data) => {
    const ref = linked ? requestRef(linked.provider, linked.number) : `request ${data.number}`;
    const title = linked ? ` "${linked.title}"` : '';
    return (
      `Unlinked ${ref}${title} from ${context.style.bold(data.task)}. Its branch or a Closes: line won't ` +
      `link it again; zamu pr link does.\n`
    );
  });
}
