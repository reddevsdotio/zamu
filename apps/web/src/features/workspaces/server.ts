// TanStack Start server functions for workspaces: which workspace a /w/<slug>/ URL names, the one `/`
// lands in, remembering the one used last, and the screens that change workspaces (the switcher, the
// New workspace dialog, General settings, /welcome). The rules live in @zamu/core (workspaces.ts) and
// the actor lookup in @zamu/auth.
// Listing and creating act on the signed-in person, not on a workspace: someone with no workspace has
// no actor yet. Everything else acts in the page's workspace ({ workspace, input }, lib/server-fn.ts).
// Handler bodies (and the server-only imports they use) are stripped from the client bundle.
import { createServerFn, createServerOnlyFn } from '@tanstack/react-start';
import { getRequestHeaders } from '@tanstack/react-start/server';
import { resolveActor } from '@zamu/auth';
import {
  CreateWorkspaceInput,
  DeleteWorkspaceInput,
  LeaveWorkspaceInput,
  type MyWorkspaces,
  UpdateWorkspaceInput,
  type Workspace,
  WorkspaceName,
  type WorkspaceRef,
} from '@zamu/contracts';
import {
  type Actor,
  type CoreContext,
  createWorkspace,
  deleteWorkspace,
  getWorkspaceContents,
  isCoreError,
  leaveWorkspace,
  listMyWorkspaces,
  problemCodeOf,
  resolveWorkspaceSlug,
  suggestAvailableWorkspaceSlug,
  touchLastWorkspace,
  updateWorkspace,
} from '@zamu/core';
import { z } from 'zod';
import { inWorkspace, runInWorkspace } from '../../lib/server-fn';
import { getServerContext } from '../../server/context';
import { failure, type SettingsResult } from '../settings/result';

export interface OpenedWorkspace {
  workspace: WorkspaceRef;
  /** False when the URL used an old slug: the layout redirects to `workspace.slug`. */
  current: boolean;
  role: Actor['role'];
}

/**
 * The workspace a /w/<slug>/ URL names, for a signed-in member of it. An old slug resolves to the
 * workspace with `current: false`. Fails with NOT_A_MEMBER for unknown slugs and for workspaces the
 * person is not in (in that order of checks, so an old slug tells a non-member nothing), and with
 * UNAUTHORIZED when signed out.
 */
export const resolveWorkspaceFn = createServerFn({ method: 'GET' })
  .validator(inWorkspace())
  .handler(async ({ data }): Promise<SettingsResult<OpenedWorkspace>> => {
    const result = await runInWorkspace(data.workspace, async (core, actor) => {
      const found = await resolveWorkspaceSlug(core, data.workspace);
      // The actor lookup found the same slug a moment ago; only a rename in between misses here.
      if (!found || found.workspace.id !== actor.workspaceId) return null;
      return { workspace: found.workspace, current: found.current, role: actor.role };
    });
    if (!result.ok) return result;
    if (!result.data) {
      return failure('NOT_A_MEMBER', `You are not a member of the workspace "${data.workspace}".`);
    }
    return { ok: true, data: result.data };
  });

/** Remembers the workspace as the one used last, so `/` lands there next time. Idempotent. */
export const touchLastWorkspaceFn = createServerFn({ method: 'POST' })
  .validator(inWorkspace())
  .handler(({ data }) => runInWorkspace(data.workspace, (core, actor) => touchLastWorkspace(core, actor)));

export type LandingWorkspace =
  | { status: 'workspace'; slug: string }
  | { status: 'none' }
  | { status: 'signed-out' };

/**
 * Where `/` and the old paths go: the workspace used last while the person is still in it, else
 * their oldest membership; `none` when they belong to no workspace (the /welcome screen).
 */
export const landingWorkspaceFn = createServerFn({ method: 'GET' }).handler(
  async (): Promise<LandingWorkspace> => {
    const core = getServerContext();
    const result = await resolveActor(core, { headers: new Headers(getRequestHeaders()) });
    if (!result.ok) return result.code === 'UNAUTHORIZED' ? { status: 'signed-out' } : { status: 'none' };
    const mine = await listMyWorkspaces(core, result.actor.userId);
    const workspace = mine.items.find((item) => item.id === result.actor.workspaceId);
    return workspace ? { status: 'workspace', slug: workspace.slug } : { status: 'none' };
  },
);

// ---------------------------------------------------------------------------
// The signed-in person, outside any workspace
// ---------------------------------------------------------------------------

/**
 * Runs `service` for the person signed in to the browser (session cookie only), wrapped as a
 * SettingsResult like the workspace functions. Server only.
 */
const runAsPerson = createServerOnlyFn(
  async <T>(service: (core: CoreContext, userId: string) => Promise<T>): Promise<SettingsResult<T>> => {
    const core = getServerContext();
    const session = await core.auth.api.getSession({ headers: getRequestHeaders() });
    if (!session) return failure('UNAUTHORIZED', 'Sign in again to continue.');
    try {
      return { ok: true, data: await service(core, session.user.id) };
    } catch (error) {
      if (isCoreError(error)) return failure(problemCodeOf(error), error.message, error.issues);
      console.error('workspaces: unhandled error:', error);
      throw error;
    }
  },
);

/** Every workspace the person belongs to, by name, and whether they may create another. */
export const listMyWorkspacesFn = createServerFn({ method: 'GET' }).handler(
  (): Promise<SettingsResult<MyWorkspaces>> => runAsPerson((core, userId) => listMyWorkspaces(core, userId)),
);

/**
 * A free slug for a workspace called `name`, for the New workspace dialog while the person has not
 * typed their own. Creating checks again.
 */
export const suggestWorkspaceSlugFn = createServerFn({ method: 'GET' })
  .validator(z.object({ name: WorkspaceName }))
  .handler(
    ({ data }): Promise<SettingsResult<string>> =>
      runAsPerson((core) => suggestAvailableWorkspaceSlug(core, data.name)),
  );

/** Creates a workspace with the person as its owner. It becomes the one they used last. */
export const createWorkspaceFn = createServerFn({ method: 'POST' })
  .validator(CreateWorkspaceInput)
  .handler(
    ({ data }): Promise<SettingsResult<Workspace>> =>
      runAsPerson((core, userId) => createWorkspace(core, userId, data)),
  );

// ---------------------------------------------------------------------------
// The page's workspace: General settings
// ---------------------------------------------------------------------------

/** Renames the workspace or changes its slug (owners and admins). */
export const updateWorkspaceFn = createServerFn({ method: 'POST' })
  .validator(inWorkspace(UpdateWorkspaceInput))
  .handler(({ data }) =>
    runInWorkspace(data.workspace, (core, actor) => updateWorkspace(core, actor, data.input)),
  );

/** What deleting the workspace would remove, for the confirm copy. */
export const workspaceContentsFn = createServerFn({ method: 'GET' })
  .validator(inWorkspace())
  .handler(({ data }) => runInWorkspace(data.workspace, (core, actor) => getWorkspaceContents(core, actor)));

/** Takes the person out of the workspace. Refused for the last owner and for agents' responsible person. */
export const leaveWorkspaceFn = createServerFn({ method: 'POST' })
  .validator(inWorkspace(LeaveWorkspaceInput))
  .handler(({ data }) =>
    runInWorkspace(data.workspace, (core, actor) => leaveWorkspace(core, actor, data.input)),
  );

/** Deletes the workspace (owners) once its slug was typed again. */
export const deleteWorkspaceFn = createServerFn({ method: 'POST' })
  .validator(inWorkspace(DeleteWorkspaceInput))
  .handler(({ data }) =>
    runInWorkspace(data.workspace, (core, actor) => deleteWorkspace(core, actor, data.input)),
  );
