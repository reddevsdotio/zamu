import { redirect } from '@tanstack/react-router';
import { createServerFn, createServerOnlyFn } from '@tanstack/react-start';
import { appendResponseHeader, getRequestHeaders } from '@tanstack/react-start/server';
import {
  AcceptInvitationError,
  type AcceptInvitationErrorCode,
  type Auth,
  acceptInvitationAsMember,
  acceptInvitationWithSignUp,
  authConfigOf,
  BootstrapError,
  bootstrapAdmin,
  bootstrapWorkspace,
  type SetupState,
  setupState,
} from '@zamu/auth';
import { AcceptInvitationInput, SetupInput, WorkspaceFields } from '@zamu/contracts';
import type { Db } from '@zamu/db';
import { z } from 'zod';
import { type AuthPage, type AuthState, authRedirect } from '../routes/(auth)/-auth/guards';
import { loadInstanceName, loadInvitation } from '../routes/(auth)/-auth/queries';
import type { SignInOptions } from '../routes/(auth)/-auth/sso';
import { getServerContext } from '../server/context';

// Session helpers for route `beforeLoad` and the signed-out screens.
// Server function handlers and createServerOnlyFn bodies are stripped from the client bundle, so the
// @zamu/auth and @zamu/db imports above never reach the browser.

interface AuthContext {
  auth: Auth;
  db: Db;
}

/**
 * The server's Better Auth instance and database: the process-wide ServerContext from
 * server/context.ts, shared with /api/v1, so the web server has one pool.
 */
export const getAuthContext = createServerOnlyFn((): AuthContext => getServerContext());

/** The signed-in user and session, safe to send to the browser. */
export interface SessionInfo {
  user: { id: string; name: string; email: string; image: string | null };
  session: { id: string; expiresAt: Date };
}

async function readSession(): Promise<SessionInfo | null> {
  const { auth } = getAuthContext();
  const result = await auth.api.getSession({ headers: getRequestHeaders() });
  if (!result) return null;
  return {
    user: {
      id: result.user.id,
      name: result.user.name,
      email: result.user.email,
      image: result.user.image ?? null,
    },
    session: { id: result.session.id, expiresAt: result.session.expiresAt },
  };
}

/** The current session, or null when signed out. */
export const getSession = createServerFn({ method: 'GET' }).handler(() => readSession());

/**
 * Setup state and session in one round trip, for the guards. `firstRun` stays true until the workspace
 * exists: after setup via SSO, the admin is signed in but still has to name the workspace.
 */
const getAuthState = createServerFn({ method: 'GET' }).handler(async () => {
  const { db } = getAuthContext();
  const setup = await setupState(db);
  return { firstRun: setup !== 'done', session: setup === 'account' ? null : await readSession() };
});

const checkFirstRun = createServerFn({ method: 'GET' }).handler(
  async () => (await setupState(getAuthContext().db)) !== 'done',
);

function signInOptions(auth: Auth): SignInOptions {
  const { sso, passwordLogin } = authConfigOf(auth);
  return { sso: sso ? { providerName: sso.providerName } : null, passwordLogin };
}

/** Whether "Continue with {provider}" and the password form are shown. Safe to send to the browser. */
export const getSignInOptions = createServerFn({ method: 'GET' }).handler(() =>
  signInOptions(getAuthContext().auth),
);

/** What /setup shows: step 1 (account) or, after setup via SSO, step 2 (workspace). */
export const getSetupScreen = createServerFn({ method: 'GET' }).handler(
  async (): Promise<{ state: SetupState; signedIn: boolean; options: SignInOptions }> => {
    const { auth, db } = getAuthContext();
    const state = await setupState(db);
    const signedIn = state === 'workspace' && (await readSession()) !== null;
    return { state, signedIn, options: signInOptions(auth) };
  },
);

// Once an instance has a workspace it never goes back to first run, so the browser stops asking.
let setUpSeen = false;

interface GuardLocation {
  href: string;
  pathname: string;
}

function throwRedirect(target: NonNullable<ReturnType<typeof authRedirect>>): never {
  if (target.to === '/signin' && target.redirect) {
    throw redirect({ to: '/signin', search: { redirect: target.redirect } });
  }
  throw redirect({ to: target.to });
}

/**
 * Applies the auth rules for a page: throws a redirect, or returns the session (null when signed out).
 * Use in `beforeLoad` of the signed-out screens.
 */
export async function guardAuthPage(
  page: AuthPage,
  location: GuardLocation,
): Promise<{ session: SessionInfo | null }> {
  const state = await getAuthState();
  if (!state.firstRun) setUpSeen = true;
  const auth: AuthState = { firstRun: state.firstRun, signedIn: state.session !== null };
  const target = authRedirect(page, auth, location.href);
  if (target) throwRedirect(target);
  return { session: state.session };
}

/**
 * For `beforeLoad` of signed-in routes: returns the session, or redirects to /signin
 * (with ?redirect= back to the requested page), or to /setup on first run.
 */
export async function requireSession({ location }: { location: GuardLocation }): Promise<{
  session: SessionInfo;
}> {
  const { session } = await guardAuthPage('app', location);
  if (!session) throw redirect({ to: '/signin' });
  return { session };
}

/**
 * For the root route's `beforeLoad`: sends every page to /setup until the instance has a workspace.
 * After the first check that finds a user, browser navigations skip the server call.
 */
export async function requireSetUp({ location }: { location: GuardLocation }): Promise<void> {
  if (setUpSeen || location.pathname === '/setup' || location.pathname.startsWith('/__ui')) return;
  const firstRun = await checkFirstRun();
  if (!firstRun) {
    setUpSeen = true;
    return;
  }
  throw redirect({ to: '/setup' });
}

/** Workspace name for the sign-in title and brand; null before setup. */
export const getInstanceName = createServerFn({ method: 'GET' }).handler(async () =>
  loadInstanceName(getAuthContext().db),
);

/** The invitation behind /invite/$id, with a state the screen turns into the form or an error. */
export const getInvitation = createServerFn({ method: 'GET' })
  .validator((input: { id: string }) => ({ id: String(input.id) }))
  .handler(async ({ data }) => loadInvitation(getAuthContext().db, data.id));

export type SetupResult =
  | { ok: true }
  | {
      ok: false;
      code: 'ALREADY_SET_UP' | 'INVALID_INPUT' | 'PASSWORD_LOGIN_DISABLED' | 'NOT_SETUP_ADMIN';
      message: string;
    };

/**
 * First-run setup: creates the admin, the workspace and the owner membership (bootstrapAdmin).
 * The browser signs in with the same credentials afterwards.
 */
export const setupInstance = createServerFn({ method: 'POST' })
  .validator(SetupInput)
  .handler(async ({ data }): Promise<SetupResult> => {
    try {
      await bootstrapAdmin(getAuthContext(), data);
      return { ok: true };
    } catch (error) {
      if (error instanceof BootstrapError) return { ok: false, code: error.code, message: error.message };
      throw error;
    }
  });

/**
 * Setup step 2 after SSO: the signed-in admin names the workspace and becomes its owner
 * (bootstrapWorkspace). Refused once a workspace exists, or for anyone but the first person.
 */
export const completeSetup = createServerFn({ method: 'POST' })
  .validator(WorkspaceFields)
  .handler(async ({ data }): Promise<SetupResult> => {
    const session = await readSession();
    if (!session) {
      return {
        ok: false,
        code: 'NOT_SETUP_ADMIN',
        message: 'Your session has ended. Continue with SSO again.',
      };
    }
    try {
      await bootstrapWorkspace(getAuthContext(), {
        userId: session.user.id,
        workspaceName: data.workspaceName,
      });
      return { ok: true };
    } catch (error) {
      if (error instanceof BootstrapError) return { ok: false, code: error.code, message: error.message };
      throw error;
    }
  });

export type AcceptInvitationResult =
  | { ok: true }
  | {
      ok: false;
      /** INVITATION_NOT_USABLE, ACCOUNT_EXISTS, INVALID_INPUT or PASSWORD_LOGIN_DISABLED in practice. */
      code: AcceptInvitationErrorCode;
      message: string;
    };

/**
 * Invitation accept: creates the account for the invitation's email (never one sent by the browser),
 * signs the person in through the session cookie on this response, and joins the workspace.
 * Public HTTP sign-up is closed; besides this, people join through first-run setup and SSO (see @zamu/auth sso.ts).
 */
export const acceptInvitation = createServerFn({ method: 'POST' })
  .validator(AcceptInvitationInput)
  .handler(async ({ data }): Promise<AcceptInvitationResult> => {
    try {
      const result = await acceptInvitationWithSignUp(getAuthContext(), data, {
        headers: getRequestHeaders(),
      });
      for (const cookie of result.setCookies) appendResponseHeader('set-cookie', cookie);
      return { ok: true };
    } catch (error) {
      if (error instanceof AcceptInvitationError) {
        return { ok: false, code: error.code, message: error.message };
      }
      throw error;
    }
  });

export type JoinInvitationResult =
  | { ok: true; workspaceSlug: string }
  | { ok: false; code: 'INVITATION_NOT_USABLE' | 'NOT_SIGNED_IN' | 'WRONG_ACCOUNT'; message: string };

/**
 * Invitation accept for someone who already has an account: the signed-in person, with the invited
 * email, joins the workspace (acceptInvitationAsMember), which becomes the one they used last. Never
 * accepts for another account.
 */
export const joinInvitation = createServerFn({ method: 'POST' })
  .validator(z.object({ invitationId: z.uuid() }))
  .handler(async ({ data }): Promise<JoinInvitationResult> => {
    try {
      const result = await acceptInvitationAsMember(getAuthContext(), data.invitationId, {
        headers: getRequestHeaders(),
      });
      return { ok: true, workspaceSlug: result.workspaceSlug };
    } catch (error) {
      if (error instanceof AcceptInvitationError) {
        const { code, message } = error;
        if (code === 'INVITATION_NOT_USABLE' || code === 'NOT_SIGNED_IN' || code === 'WRONG_ACCOUNT') {
          return { ok: false, code, message };
        }
      }
      throw error;
    }
  });
