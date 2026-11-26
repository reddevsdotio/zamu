// Who is making a request, and in which workspace. An API key acts in the workspace its metadata
// names; a session acts in the workspace the x-zamu-workspace header names (by current or old slug),
// else in the one the person used last, else in their oldest membership. Failures say why, so the
// API can answer 401 for "not signed in" and 403 for "signed in, but not in this workspace".
import type { ProblemCode } from '@zamu/contracts';
import { type Db, schema } from '@zamu/db';
import { and, asc, eq } from 'drizzle-orm';
import { type ApiKeyAccess, parseApiKeyMetadata } from './api-key';
import type { Auth } from './auth';
import { API_KEY_PREFIX, type UserKind } from './options';
import { findWorkspaceBySlug, workspaceHeader } from './workspace';

export type WorkspaceRole = 'owner' | 'admin' | 'member';

/** Who is making a request, resolved from a session cookie or an API key. */
export interface Actor {
  userId: string;
  kind: UserKind;
  workspaceId: string;
  /** Membership role in workspaceId. Owner and admin both count as admin. */
  role: WorkspaceRole;
  /** Present for API-key requests only; sessions act with the user's full rights. */
  scope?: { projects: 'all' | string[]; access: ApiKeyAccess };
  /** The responsible human for agents, null for people. Recorded on activity. */
  onBehalfOfId: string | null;
  /** The API key used, for audit; absent for session requests. */
  apiKeyId?: string;
}

/**
 * Why a request has no actor, as the Problem code the API answers with:
 * - `UNAUTHORIZED` (401): no session or key, an invalid, disabled or expired key, a key whose owner
 *   left its workspace, an agent without a responsible person, or an agent's session.
 * - `NOT_A_MEMBER` (403): a signed-in person and the workspace the header names (unknown slugs
 *   included) is not one of theirs, or they belong to no workspace at all.
 * - `WORKSPACE_MISMATCH` (403): an API key sent with a header that names another workspace.
 */
export type ActorFailureCode = Extract<ProblemCode, 'UNAUTHORIZED' | 'NOT_A_MEMBER' | 'WORKSPACE_MISMATCH'>;

export type ActorResult =
  | { ok: true; actor: Actor }
  | {
      ok: false;
      code: ActorFailureCode;
      /** A sentence for the person or agent; callers may replace the UNAUTHORIZED one with their own. */
      message: string;
    };

const UNAUTHORIZED: ActorResult = {
  ok: false,
  code: 'UNAUTHORIZED',
  message: 'Sign in, or send an API key as Authorization: Bearer zamu_live_...',
};

function notAMember(slug: string | null): ActorResult {
  return {
    ok: false,
    code: 'NOT_A_MEMBER',
    message: slug
      ? `You are not a member of the workspace "${slug}".`
      : 'You are not a member of any workspace. Ask an owner for an invitation.',
  };
}

function mismatch(keySlug: string, headerSlug: string): ActorResult {
  return {
    ok: false,
    code: 'WORKSPACE_MISMATCH',
    message: `This API key belongs to the workspace "${keySlug}", not "${headerSlug}". Use a key from "${headerSlug}", or drop the x-zamu-workspace header.`,
  };
}

/** The zamu_live_ key from `Authorization: Bearer ...`, or null. */
export function bearerApiKey(headers: Headers): string | null {
  const header = headers.get('authorization');
  if (!header) return null;
  const match = /^Bearer\s+(\S+)\s*$/i.exec(header);
  const token = match?.[1];
  return token?.startsWith(API_KEY_PREFIX) ? token : null;
}

function asRole(role: string): WorkspaceRole {
  // Better Auth stores multiple roles comma-separated; take the strongest.
  const roles = role.split(',').map((r) => r.trim());
  if (roles.includes('owner')) return 'owner';
  if (roles.includes('admin')) return 'admin';
  return 'member';
}

async function loadUser(db: Db, userId: string) {
  const [row] = await db
    .select({
      id: schema.user.id,
      kind: schema.user.kind,
      responsibleUserId: schema.user.responsibleUserId,
      lastWorkspaceId: schema.user.lastWorkspaceId,
    })
    .from(schema.user)
    .where(eq(schema.user.id, userId))
    .limit(1);
  return row ?? null;
}

/** Membership of `userId`, in `workspaceId` when given, otherwise the oldest one. */
async function loadMembership(db: Db, userId: string, workspaceId: string | null) {
  const [row] = await db
    .select({ organizationId: schema.member.organizationId, role: schema.member.role })
    .from(schema.member)
    .where(
      workspaceId
        ? and(eq(schema.member.userId, userId), eq(schema.member.organizationId, workspaceId))
        : eq(schema.member.userId, userId),
    )
    .orderBy(asc(schema.member.createdAt), asc(schema.member.id))
    .limit(1);
  return row ?? null;
}

async function workspaceSlug(db: Db, workspaceId: string): Promise<string> {
  const [row] = await db
    .select({ slug: schema.organization.slug })
    .from(schema.organization)
    .where(eq(schema.organization.id, workspaceId))
    .limit(1);
  return row?.slug ?? workspaceId;
}

function onBehalfOf(user: { kind: UserKind; responsibleUserId: string | null }): string | null | undefined {
  if (user.kind === 'person') return null;
  // An agent without a responsible human has nobody to act for; refuse it.
  return user.responsibleUserId ?? undefined;
}

async function resolveKey(
  { auth, db }: { auth: Auth; db: Db },
  key: string,
  headerSlug: string | null,
): Promise<ActorResult> {
  let verified: Awaited<ReturnType<Auth['api']['verifyApiKey']>>;
  try {
    verified = await auth.api.verifyApiKey({ body: { key } });
  } catch {
    return UNAUTHORIZED;
  }
  if (!verified.valid || !verified.key) return UNAUTHORIZED;
  const metadata = parseApiKeyMetadata(verified.key.metadata);
  if (!metadata) return UNAUTHORIZED;

  const user = await loadUser(db, verified.key.referenceId);
  if (!user) return UNAUTHORIZED;
  const behalf = onBehalfOf(user);
  if (behalf === undefined) return UNAUTHORIZED;
  const membership = await loadMembership(db, user.id, metadata.workspaceId);
  if (!membership) return UNAUTHORIZED;

  // A key acts in its own workspace only. The header may name it (by any of its slugs); naming
  // another one is a mistake worth a loud refusal, not a silent switch.
  if (headerSlug) {
    const named = await findWorkspaceBySlug(db, headerSlug);
    if (named?.id !== membership.organizationId) {
      return mismatch(await workspaceSlug(db, membership.organizationId), headerSlug);
    }
  }

  const actor: Actor = {
    userId: user.id,
    kind: user.kind,
    workspaceId: membership.organizationId,
    role: asRole(membership.role),
    scope: { projects: metadata.projects, access: metadata.access },
    onBehalfOfId: behalf,
    apiKeyId: verified.key.id,
  };
  return { ok: true, actor };
}

async function resolveSession(
  { auth, db }: { auth: Auth; db: Db },
  headers: Headers,
  headerSlug: string | null,
): Promise<ActorResult> {
  const session = await auth.api.getSession({ headers });
  if (!session) return UNAUTHORIZED;
  const user = await loadUser(db, session.user.id);
  // Agents never act through a session.
  if (user?.kind !== 'person') return UNAUTHORIZED;

  let membership: Awaited<ReturnType<typeof loadMembership>>;
  if (headerSlug) {
    const named = await findWorkspaceBySlug(db, headerSlug);
    membership = named ? await loadMembership(db, user.id, named.id) : null;
    if (!membership) return notAMember(headerSlug);
  } else {
    // Better Auth's activeOrganizationId is not read: the workspace used last lives on the user, so
    // it survives signing out and is the same in every browser.
    membership =
      (user.lastWorkspaceId && (await loadMembership(db, user.id, user.lastWorkspaceId))) ||
      (await loadMembership(db, user.id, null));
    if (!membership) return notAMember(null);
  }

  return {
    ok: true,
    actor: {
      userId: user.id,
      kind: user.kind,
      workspaceId: membership.organizationId,
      role: asRole(membership.role),
      onBehalfOfId: null,
    },
  };
}

/**
 * Resolves the actor of a request: `Authorization: Bearer zamu_live_...` first, then the session
 * cookie, each with the x-zamu-workspace header as described at the top of this module. Returns why
 * when there is no actor (ActorFailureCode).
 */
export async function resolveActor(
  context: { auth: Auth; db: Db },
  request: Request | { headers: Headers },
): Promise<ActorResult> {
  const headers = request.headers;
  const headerSlug = workspaceHeader(headers);
  const key = bearerApiKey(headers);
  if (key) return resolveKey(context, key, headerSlug);
  return resolveSession(context, headers, headerSlug);
}

/**
 * resolveActor without the reason: the actor, or null for every failure. For scripts and tests that
 * only need to know whether a request gets in; the API and the web app use resolveActor.
 */
export async function getActorFromRequest(
  context: { auth: Auth; db: Db },
  request: Request | { headers: Headers },
): Promise<Actor | null> {
  const result = await resolveActor(context, request);
  return result.ok ? result.actor : null;
}
