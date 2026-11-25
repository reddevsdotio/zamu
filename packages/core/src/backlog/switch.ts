// M6: switching a mirrored project to Zamu. The check lists the open pull or merge requests that
// change files in the project's Backlog.md folder (they would land after the switch and never
// arrive), or says why the host could not answer. The switch takes the typed project key and runs
// the detach: from then on the project is native, and every task keeps its number, fields,
// comments and history. Both are web-only (project settings), for owners and admins.
import {
  BacklogProjectInput,
  type BacklogSourceStatus,
  DetachBacklogInput,
  type UserRef,
} from '@zamu/contracts';
import {
  type GitProvider,
  type GitProviderError,
  isGitProviderError,
  type OpenRequest,
  type ProviderKind,
} from '@zamu/git-providers';
import type { z } from 'zod';
import type { Actor } from '../authz';
import { clockNow } from '../cycles';
import { NotFound, parseInput } from '../errors';
import { providerForConnection } from '../git-connections';
import { EncryptionKeyMissing, SecretUnreadable } from '../secrets';
import { repositoryRef } from './reader';
import { assertNotDetached, type BacklogSettingsContext, detachSource } from './settings';
import { backlogStatus, sourceForProject } from './status';

/**
 * Why the check could not list the requests. rejected: the token may not read pull requests;
 * unreachable: no answer (network, timeout, 5xx, refused host, or an answer the API does not
 * give); rate_limited: the host asked to slow down; not_found: the repository is gone or hidden;
 * unavailable: nothing to ask with (no repository, no connection, no readable token).
 */
export type BacklogSwitchFailure = 'rejected' | 'unreachable' | 'rate_limited' | 'not_found' | 'unavailable';

export type BacklogSwitchCheck =
  | {
      ok: true;
      project: string;
      /** host/owner/name. */
      repository: string;
      /** The Backlog.md folder the requests touch. */
      folder: string;
      /** Open requests with a changed file under the folder, newest first (at most 100 looked at). */
      requests: OpenRequest[];
      /** The list may be incomplete: more requests were open than were looked at. */
      truncated: boolean;
      /** The host's list of open requests. */
      listUrl: string;
      checkedAt: string;
    }
  | {
      ok: false;
      project: string;
      reason: BacklogSwitchFailure;
      /** One sentence for the dialog, token-free. */
      message: string;
      checkedAt: string;
    };

export interface BacklogSwitchResult {
  project: string;
  /** backlog_source.detached_at. */
  switchedAt: string;
  /** backlog_source.detached_by_id. */
  switchedBy: UserRef;
  status: BacklogSourceStatus;
}

/** What a token needs to list open requests, per provider. */
const REQUEST_SCOPES: Record<ProviderKind, string> = {
  github: 'read access to pull requests (fine-grained: Pull requests, Read-only)',
  gitlab: 'the read_api scope',
  gitea: 'the read:repository scope',
};

const REQUESTS: Record<ProviderKind, string> = {
  github: 'pull requests',
  gitlab: 'merge requests',
  gitea: 'pull requests',
};

function failureOf(
  error: GitProviderError,
  provider: ProviderKind,
  host: string,
): { reason: BacklogSwitchFailure; message: string } {
  const what = REQUESTS[provider];
  switch (error.kind) {
    case 'unauthorized':
      return {
        reason: 'rejected',
        message: `${host} refused to list ${what} with this connection's token. It needs ${REQUEST_SCOPES[provider]}.`,
      };
    case 'rate_limited':
      return { reason: 'rate_limited', message: `${host} asked to slow down. Try again in a minute.` };
    case 'not_found':
      return {
        reason: 'not_found',
        message: `${host} has no such repository, or the token cannot see its ${what}.`,
      };
    case 'host_refused':
      return { reason: 'unreachable', message: error.message };
    case 'unreachable':
      return {
        reason: 'unreachable',
        message: error.code === 'timeout' ? `${host} did not answer in time.` : `Could not reach ${host}.`,
      };
    case 'unexpected':
      return { reason: 'unreachable', message: `${host} answered in a way its API does not.` };
  }
}

/**
 * Lists the open pull or merge requests that change files under the project's Backlog.md folder.
 * Never throws for the host's answer: a failure comes back as `ok: false` with a reason, and the
 * connection's status is left alone (the hourly check judges it). backlog.manage; NotFound without a
 * source, BacklogDetached once detached.
 */
export async function checkBacklogSwitch(
  ctx: BacklogSettingsContext,
  actor: Actor,
  input: z.input<typeof BacklogProjectInput>,
): Promise<BacklogSwitchCheck> {
  const parsed = parseInput(BacklogProjectInput, input);
  const { project, source } = await sourceForProject(ctx.db, actor, parsed.projectKey, 'backlog.manage');
  assertNotDetached(project, source);
  const checkedAt = clockNow(ctx).toISOString();
  const fail = (reason: BacklogSwitchFailure, message: string): BacklogSwitchCheck => ({
    ok: false,
    project: project.key,
    reason,
    message,
    checkedAt,
  });

  const repository = repositoryRef(project.repository);
  if (!repository)
    return fail('unavailable', 'The project has no repository linked, so there is nothing to check.');
  if (!source.connectionId) {
    return fail('unavailable', 'The git connection was deleted. Choose another connection first.');
  }
  let provider: GitProvider;
  try {
    ({ provider } = await providerForConnection(ctx, source.connectionId, {
      workspaceId: project.workspaceId,
    }));
  } catch (error) {
    if (error instanceof EncryptionKeyMissing || error instanceof SecretUnreadable) {
      return fail('unavailable', error.message);
    }
    if (error instanceof NotFound) {
      return fail('unavailable', 'The git connection was deleted. Choose another connection first.');
    }
    throw error;
  }
  if (!provider.listOpenRequests) {
    return fail(
      'unavailable',
      `Open ${REQUESTS[provider.provider]} cannot be listed for ${repository.host}.`,
    );
  }
  const folder = source.folder ?? source.folderOverride ?? 'backlog';
  try {
    const list = await provider.listOpenRequests(repository.path, folder);
    return {
      ok: true,
      project: project.key,
      repository: repository.short,
      folder,
      requests: list.requests,
      truncated: list.truncated,
      listUrl: list.listUrl,
      checkedAt,
    };
  } catch (error) {
    if (!isGitProviderError(error)) throw error;
    const failure = failureOf(error, provider.provider, repository.host);
    return fail(failure.reason, failure.message);
  }
}

/**
 * Switches a mirrored project to Zamu after the person typed its key (DetachBacklogInput: a wrong
 * key is Invalid on confirmKey). Runs the detach: the mirror stops, labels and items become the
 * app's, and native writes work from then on. Returns when and by whom, as backlog_source
 * records it. backlog.manage; BacklogDetached when the project no longer mirrors.
 */
export async function switchBacklogToZamu(
  ctx: BacklogSettingsContext,
  actor: Actor,
  input: z.input<typeof DetachBacklogInput>,
): Promise<BacklogSwitchResult> {
  const parsed = parseInput(DetachBacklogInput, input);
  const now = clockNow(ctx);
  const { project, source } = await ctx.db.transaction(async (tx) => {
    const found = await sourceForProject(tx, actor, parsed.projectKey, 'backlog.manage', { forUpdate: true });
    assertNotDetached(found.project, found.source);
    return { project: found.project, source: await detachSource(tx, actor, found, now) };
  });
  const status = await backlogStatus(ctx, project, source, { limit: 50 });
  if (!status.detachedAt || !status.detachedBy) throw new Error('the switch left the source attached');
  return { project: project.key, switchedAt: status.detachedAt, switchedBy: status.detachedBy, status };
}
