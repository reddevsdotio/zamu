// Accepting an invitation: by creating the invited person's account (acceptInvitationWithSignUp), or, for
// someone who already has an account and is signed in with the invited email, by joining the workspace
// (acceptInvitationAsMember). Either way the invitation opens its workspace: user.last_workspace_id.
import { type Db, schema } from '@zamu/db';
import { and, eq, sql } from 'drizzle-orm';
import type { Auth } from './auth';
import { MIN_PASSWORD_LENGTH } from './options';
import { authConfigOf } from './settings';

/** Better Auth's default maximum password length. */
const MAX_PASSWORD_LENGTH = 128;
const MAX_NAME_LENGTH = 100;
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

export type AcceptInvitationErrorCode =
  /** Unknown id, or the invitation is accepted, canceled, rejected or expired. */
  | 'INVITATION_NOT_USABLE'
  /** A user with the invited email already exists. */
  | 'ACCOUNT_EXISTS'
  | 'INVALID_INPUT'
  /** PASSWORD_LOGIN=disabled: invited people join through SSO instead. */
  | 'PASSWORD_LOGIN_DISABLED'
  /** acceptInvitationAsMember: no session, or the session is not a person's. */
  | 'NOT_SIGNED_IN'
  /** acceptInvitationAsMember: signed in with another email than the invitation's. */
  | 'WRONG_ACCOUNT';

export class AcceptInvitationError extends Error {
  constructor(
    readonly code: AcceptInvitationErrorCode,
    message: string,
  ) {
    super(message);
    this.name = 'AcceptInvitationError';
  }
}

export interface AcceptInvitationInput {
  /** The id from the /invite/$id link: the secret that proves the caller was invited. */
  invitationId: string;
  name: string;
  password: string;
}

export interface AcceptInvitationResult {
  userId: string;
  workspaceId: string;
  /** Set-Cookie values that sign the new person in; the caller forwards them on its response. */
  setCookies: string[];
}

/** Better Auth's APIError carries its code in `body.code`. */
function apiErrorCode(error: unknown): string | undefined {
  const body = (error as { body?: { code?: unknown } } | null)?.body;
  return typeof body?.code === 'string' ? body.code : undefined;
}

function cookieHeader(setCookies: string[]): string {
  return setCookies
    .map((cookie) => cookie.split(';')[0])
    .filter(Boolean)
    .join('; ');
}

async function loadPendingInvitation(db: Db, invitationId: string, now: Date) {
  if (!UUID.test(invitationId)) return null;
  const [row] = await db
    .select({
      email: schema.invitation.email,
      status: schema.invitation.status,
      expiresAt: schema.invitation.expiresAt,
      organizationId: schema.invitation.organizationId,
    })
    .from(schema.invitation)
    .where(eq(schema.invitation.id, invitationId))
    .limit(1);
  if (row?.status !== 'pending' || row.expiresAt.getTime() <= now.getTime()) return null;
  return row;
}

/**
 * Creates the invited person's account and accepts the invitation. The email comes from the
 * invitation, never from the caller, and only someone holding the invitation id gets here.
 *
 * The user is created through Better Auth's server API (public HTTP sign-up is closed), signed in,
 * and added to the workspace. When accepting fails, the new user is deleted again (sessions and
 * accounts cascade), so no orphan account is left behind.
 *
 * `headers` are the incoming request's headers, recorded on the session (user agent, IP).
 */
export async function acceptInvitationWithSignUp(
  { auth, db }: { auth: Auth; db: Db },
  input: AcceptInvitationInput,
  options: { headers?: Headers; now?: Date } = {},
): Promise<AcceptInvitationResult> {
  if (!authConfigOf(auth).passwordLogin) {
    throw new AcceptInvitationError(
      'PASSWORD_LOGIN_DISABLED',
      'Password sign-in is turned off on this server. Join with single sign-on.',
    );
  }
  const name = input.name.trim();
  if (!name || name.length > MAX_NAME_LENGTH) {
    throw new AcceptInvitationError('INVALID_INPUT', `Name needs 1 to ${MAX_NAME_LENGTH} characters.`);
  }
  if (input.password.length < MIN_PASSWORD_LENGTH || input.password.length > MAX_PASSWORD_LENGTH) {
    throw new AcceptInvitationError(
      'INVALID_INPUT',
      `Password needs ${MIN_PASSWORD_LENGTH} to ${MAX_PASSWORD_LENGTH} characters.`,
    );
  }

  const invitation = await loadPendingInvitation(db, input.invitationId, options.now ?? new Date());
  if (!invitation) {
    throw new AcceptInvitationError('INVITATION_NOT_USABLE', 'This invitation cannot be used.');
  }
  const email = invitation.email.trim().toLowerCase();

  const [existing] = await db
    .select({ id: schema.user.id })
    .from(schema.user)
    .where(eq(sql`lower(${schema.user.email})`, email))
    .limit(1);
  if (existing)
    throw new AcceptInvitationError('ACCOUNT_EXISTS', 'An account with this email already exists.');

  // Sign out any cookie the caller sent: the new session must belong to the new user.
  const headers = new Headers(options.headers);
  headers.delete('cookie');

  let signUp: Awaited<ReturnType<typeof signUpEmail>>;
  try {
    signUp = await signUpEmail(auth, { name, email, password: input.password }, headers);
  } catch (error) {
    const code = apiErrorCode(error);
    if (code?.startsWith('USER_ALREADY_EXISTS')) {
      throw new AcceptInvitationError('ACCOUNT_EXISTS', 'An account with this email already exists.');
    }
    if (code === 'SIGN_UP_REQUIRES_INVITATION') {
      throw new AcceptInvitationError('INVITATION_NOT_USABLE', 'This invitation cannot be used.');
    }
    if (code?.startsWith('PASSWORD_') || code === 'INVALID_EMAIL') {
      throw new AcceptInvitationError('INVALID_INPUT', (error as Error).message);
    }
    throw error;
  }

  const userId = signUp.response.user.id;
  const signUpCookies = signUp.headers.getSetCookie();
  try {
    const accepted = await auth.api.acceptInvitation({
      headers: new Headers({ ...Object.fromEntries(headers), cookie: cookieHeader(signUpCookies) }),
      body: { invitationId: input.invitationId },
      returnHeaders: true,
    });
    if (!accepted.response) throw new Error('acceptInvitation returned no invitation');
    // The invitation opens its workspace: `/` lands there.
    await db
      .update(schema.user)
      .set({ lastWorkspaceId: invitation.organizationId })
      .where(eq(schema.user.id, userId));
    return {
      userId,
      workspaceId: invitation.organizationId,
      setCookies: [...signUpCookies, ...accepted.headers.getSetCookie()],
    };
  } catch (error) {
    // Undo the sign-up. Better Auth already rolled the membership back and reset the invitation.
    await db.delete(schema.user).where(eq(schema.user.id, userId));
    const code = apiErrorCode(error);
    if (code === 'INVITATION_NOT_FOUND' || code === 'YOU_ARE_NOT_THE_RECIPIENT_OF_THE_INVITATION') {
      throw new AcceptInvitationError('INVITATION_NOT_USABLE', 'This invitation cannot be used.');
    }
    throw error;
  }
}

function signUpEmail(auth: Auth, body: { name: string; email: string; password: string }, headers: Headers) {
  return auth.api.signUpEmail({ body, headers, returnHeaders: true });
}

export interface AcceptInvitationAsMemberResult {
  userId: string;
  workspaceId: string;
  /** The workspace's current slug: the caller opens /w/<slug>. */
  workspaceSlug: string;
}

/**
 * Joins the invitation's workspace as the signed-in person, who must have the invited email (compared
 * without case). Adds the membership with the invited role, marks the invitation accepted and makes the
 * workspace the one used last, in one transaction that locks the invitation so it is used once. Someone
 * already in the workspace just has the invitation marked accepted.
 *
 * `headers` are the request's headers, for the session cookie.
 */
export async function acceptInvitationAsMember(
  { auth, db }: { auth: Auth; db: Db },
  invitationId: string,
  options: { headers: Headers; now?: Date },
): Promise<AcceptInvitationAsMemberResult> {
  const session = await auth.api.getSession({ headers: options.headers });
  if (!session) throw new AcceptInvitationError('NOT_SIGNED_IN', 'Sign in to join this workspace.');
  const [user] = await db
    .select({ id: schema.user.id, kind: schema.user.kind, email: schema.user.email })
    .from(schema.user)
    .where(eq(schema.user.id, session.user.id))
    .limit(1);
  if (user?.kind !== 'person') {
    throw new AcceptInvitationError('NOT_SIGNED_IN', 'Sign in to join this workspace.');
  }
  if (!UUID.test(invitationId)) {
    throw new AcceptInvitationError('INVITATION_NOT_USABLE', 'This invitation cannot be used.');
  }
  const now = options.now ?? new Date();

  return db.transaction(async (tx) => {
    const [invitation] = await tx
      .select({
        email: schema.invitation.email,
        status: schema.invitation.status,
        expiresAt: schema.invitation.expiresAt,
        role: schema.invitation.role,
        organizationId: schema.invitation.organizationId,
      })
      .from(schema.invitation)
      .where(eq(schema.invitation.id, invitationId))
      .for('update')
      .limit(1);
    if (invitation?.status !== 'pending' || invitation.expiresAt.getTime() <= now.getTime()) {
      throw new AcceptInvitationError('INVITATION_NOT_USABLE', 'This invitation cannot be used.');
    }
    const invited = invitation.email.trim().toLowerCase();
    if (user.email.trim().toLowerCase() !== invited) {
      throw new AcceptInvitationError(
        'WRONG_ACCOUNT',
        `This invitation is for ${invited}. You are signed in as ${user.email}.`,
      );
    }

    await tx
      .insert(schema.member)
      .values({
        organizationId: invitation.organizationId,
        userId: user.id,
        role: invitation.role ?? 'member',
      })
      .onConflictDoNothing();
    await tx
      .update(schema.invitation)
      .set({ status: 'accepted' })
      .where(and(eq(schema.invitation.id, invitationId), eq(schema.invitation.status, 'pending')));
    await tx
      .update(schema.user)
      .set({ lastWorkspaceId: invitation.organizationId })
      .where(eq(schema.user.id, user.id));
    const [workspace] = await tx
      .select({ slug: schema.organization.slug })
      .from(schema.organization)
      .where(eq(schema.organization.id, invitation.organizationId))
      .limit(1);
    if (!workspace) throw new Error('acceptInvitationAsMember: the invitation has no workspace');
    return { userId: user.id, workspaceId: invitation.organizationId, workspaceSlug: workspace.slug };
  });
}

/** True when a person with this email exists (compared without case). For the invitation screen. */
export async function hasPersonWithEmail(db: Db, email: string): Promise<boolean> {
  const rows = await db
    .select({ id: schema.user.id })
    .from(schema.user)
    .where(
      and(eq(sql`lower(${schema.user.email})`, email.trim().toLowerCase()), eq(schema.user.kind, 'person')),
    )
    .limit(1);
  return rows.length > 0;
}
