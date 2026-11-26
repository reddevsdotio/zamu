// Workspaces (0.10, PM-39): list the ones a person belongs to, resolve a slug (current or old),
// create, rename or re-address, leave and delete. Workspaces are Better Auth organizations, but
// core writes the organization and member rows itself (as first-run setup does) so these rules
// hold whatever calls them:
// - Slugs follow WorkspaceSlug; reserved words get SlugReserved. A slug is taken while another
//   workspace uses it, or held it as an old slug in the last 90 days (SlugTaken). After that the
//   old slug is dropped when someone takes it; a workspace may always take back its own.
// - Any person may create a workspace, or only people who own one under WORKSPACE_CREATION=owners;
//   agents never do. Owners and admins rename; owners delete; the last owner cannot leave.
// - Deleting removes the organization (projects, tasks and the rest cascade), every API key that
//   names it, and the agents that belonged to it alone, in one transaction.
// Slug writes take one advisory lock, so the check across organization slugs and aliases holds.
import {
  CreateWorkspaceInput,
  DEFAULT_WORKSPACE_CREATION,
  DeleteWorkspaceInput,
  isReservedWorkspaceSlug,
  LeaveWorkspaceInput,
  MyWorkspaces,
  suggestWorkspaceSlug,
  UpdateWorkspaceInput,
  WORKSPACE_SLUG_MAX_LENGTH,
  WORKSPACE_SLUG_MIN_LENGTH,
  WORKSPACE_SLUG_PATTERN,
  type Workspace,
  WorkspaceContents,
  type WorkspaceCreationPolicy,
  type WorkspaceRef,
  workspaceSlugWithNumber,
} from '@zamu/contracts';
import { type DbOrTx, schema, type Tx } from '@zamu/db';
import { and, asc, count, eq, inArray, ne, notExists, sql } from 'drizzle-orm';
import { alias } from 'drizzle-orm/pg-core';
import type { z } from 'zod';
import { countActiveWorkspaceKeys, deleteMemberApiKeys, deleteWorkspaceApiKeys } from './api-keys';
import { type Actor, isAdmin, isSession } from './authz';
import type { DbContext, WorkspaceContext } from './context';
import { clockNow } from './cycles';
import {
  Forbidden,
  Invalid,
  isUniqueViolation,
  NotFound,
  parseInput,
  SlugReserved,
  SlugTaken,
  WorkspaceCreationOff,
} from './errors';
import {
  ensureNotLastOwner,
  ensureNotResponsibleForAgents,
  forgetLastWorkspace,
  toWorkspaceRole,
} from './members';

const { member, organization, project, task, user, workspaceSlugAlias } = schema;

/** How long an old slug stays out of reach of other workspaces after its workspace gave it up. */
export const WORKSPACE_SLUG_REUSE_DAYS = 90;

const DAY_MS = 24 * 60 * 60 * 1000;

/** Serialises every slug write (create, re-address) across workspaces. */
const SLUG_LOCK = 'workspace-slug';

/** Gives up suggesting after this many numbered candidates; a name this common needs a typed slug. */
const MAX_SUGGESTIONS = 500;

// ---------------------------------------------------------------------------
// Slugs
// ---------------------------------------------------------------------------

/** A slug and where it points: the workspace's current slug, or one of its old ones. */
export interface ResolvedWorkspaceSlug {
  workspace: WorkspaceRef;
  /** False for an old slug: the web app redirects to `workspace.slug`. */
  current: boolean;
}

/**
 * The workspace a slug names, current or old (case and surrounding spaces ignored), or null. Old
 * slugs keep resolving until another workspace takes them.
 */
export async function resolveWorkspaceSlug(
  { db }: DbContext,
  slug: string,
): Promise<ResolvedWorkspaceSlug | null> {
  const wanted = slug.trim().toLowerCase();
  if (wanted === '') return null;
  const columns = { id: organization.id, name: organization.name, slug: organization.slug };
  const [current] = await db.select(columns).from(organization).where(eq(organization.slug, wanted)).limit(1);
  if (current) return { workspace: current, current: true };
  const [old] = await db
    .select(columns)
    .from(workspaceSlugAlias)
    .innerJoin(organization, eq(organization.id, workspaceSlugAlias.workspaceId))
    .where(eq(workspaceSlugAlias.slug, wanted))
    .limit(1);
  return old ? { workspace: old, current: false } : null;
}

/** Whether `slug` can be stored as an alias: old slugs from before 0.10 may break today's rule. */
function fitsSlugRule(slug: string): boolean {
  return (
    slug.length >= WORKSPACE_SLUG_MIN_LENGTH &&
    slug.length <= WORKSPACE_SLUG_MAX_LENGTH &&
    WORKSPACE_SLUG_PATTERN.test(slug)
  );
}

type SlugState =
  /** Nobody holds it. */
  | { state: 'free' }
  /** It is `workspaceId`'s current slug already. */
  | { state: 'current' }
  /** An alias that `workspaceId` may take: its own, or another workspace's past the reuse window. */
  | { state: 'alias' }
  /** Another workspace's current slug, or its alias within the reuse window. */
  | { state: 'taken' };

/** Who holds `slug`, seen from `workspaceId` (null: a workspace not created yet). */
async function slugState(
  db: DbOrTx,
  slug: string,
  workspaceId: string | null,
  now: Date,
): Promise<SlugState> {
  const [current] = await db
    .select({ id: organization.id })
    .from(organization)
    .where(eq(organization.slug, slug))
    .limit(1);
  if (current) return { state: current.id === workspaceId ? 'current' : 'taken' };
  const [alias] = await db
    .select({ workspaceId: workspaceSlugAlias.workspaceId, createdAt: workspaceSlugAlias.createdAt })
    .from(workspaceSlugAlias)
    .where(eq(workspaceSlugAlias.slug, slug))
    .limit(1);
  if (!alias) return { state: 'free' };
  if (alias.workspaceId === workspaceId) return { state: 'alias' };
  const freedFor = now.getTime() - alias.createdAt.getTime();
  return { state: freedFor >= WORKSPACE_SLUG_REUSE_DAYS * DAY_MS ? 'alias' : 'taken' };
}

function slugTaken(slug: string): SlugTaken {
  const message = `The address ${slug} is taken. Pick another.`;
  return new SlugTaken(message, { issues: [{ path: 'slug', message }] });
}

function slugReserved(slug: string): SlugReserved {
  const message = `The address ${slug} is reserved. Pick another.`;
  return new SlugReserved(message, { issues: [{ path: 'slug', message }] });
}

/** Throws unless `workspaceId` (null: a new workspace) may take `slug`. Returns its state. */
async function claimableSlug(db: DbOrTx, slug: string, workspaceId: string | null, now: Date) {
  if (isReservedWorkspaceSlug(slug)) throw slugReserved(slug);
  const found = await slugState(db, slug, workspaceId, now);
  if (found.state === 'taken') throw slugTaken(slug);
  return found;
}

/** The first free slug for `name`: the suggestion, then `-2`, `-3`, ... while taken. */
async function firstFreeSlug(db: DbOrTx, name: string, now: Date): Promise<string> {
  const base = suggestWorkspaceSlug(name);
  for (let n = 1; n <= MAX_SUGGESTIONS; n++) {
    const candidate = workspaceSlugWithNumber(base, n);
    const found = await slugState(db, candidate, null, now);
    if (found.state === 'free' || found.state === 'alias') return candidate;
  }
  throw slugTaken(base);
}

/**
 * A slug for a new workspace called `name` that nobody holds, for the New workspace dialog. It may
 * be gone by the time the form is sent; createWorkspace checks again.
 */
export async function suggestAvailableWorkspaceSlug(ctx: DbContext, name: string): Promise<string> {
  return firstFreeSlug(ctx.db, name, clockNow(ctx));
}

async function lockSlugs(tx: Tx): Promise<void> {
  await tx.execute(sql`select pg_advisory_xact_lock(hashtext(${SLUG_LOCK}))`);
}

// ---------------------------------------------------------------------------
// Reading
// ---------------------------------------------------------------------------

async function loadPerson(db: DbOrTx, userId: string) {
  const [row] = await db
    .select({ id: user.id, kind: user.kind })
    .from(user)
    .where(eq(user.id, userId))
    .limit(1);
  if (!row) throw new NotFound('User not found');
  return row;
}

/** Whether a user of `kind` with these memberships may create a workspace under `policy`. */
function mayCreate(
  kind: 'person' | 'agent',
  roles: Workspace['role'][],
  policy: WorkspaceCreationPolicy,
): boolean {
  if (kind !== 'person') return false;
  return policy === 'everyone' || roles.includes('owner');
}

async function membershipsOf(db: DbOrTx, userId: string): Promise<Workspace[]> {
  const rows = await db
    .select({ id: organization.id, name: organization.name, slug: organization.slug, role: member.role })
    .from(member)
    .innerJoin(organization, eq(organization.id, member.organizationId))
    .where(eq(member.userId, userId))
    .orderBy(asc(sql`lower(${organization.name})`), asc(organization.name), asc(organization.id));
  return rows.map((row) => ({ ...row, role: toWorkspaceRole(row.role) }));
}

/**
 * Every workspace `userId` belongs to, by name, with their role there, and whether the creation
 * policy lets them create another.
 */
export async function listMyWorkspaces(ctx: WorkspaceContext, userId: string): Promise<MyWorkspaces> {
  const person = await loadPerson(ctx.db, userId);
  const items = await membershipsOf(ctx.db, userId);
  const policy = ctx.workspaceCreation ?? DEFAULT_WORKSPACE_CREATION;
  return MyWorkspaces.parse({
    items,
    canCreate: mayCreate(
      person.kind,
      items.map((item) => item.role),
      policy,
    ),
  });
}

/** Agents of `workspaceId` that belong to no other workspace: deleting it deletes them. */
function soleAgentsOf(db: DbOrTx, workspaceId: string) {
  const other = alias(member, 'other_member');
  return db
    .select({ id: user.id })
    .from(member)
    .innerJoin(user, eq(user.id, member.userId))
    .where(
      and(
        eq(member.organizationId, workspaceId),
        eq(user.kind, 'agent'),
        notExists(
          db
            .select({ one: sql`1` })
            .from(other)
            .where(and(eq(other.userId, member.userId), ne(other.organizationId, workspaceId))),
        ),
      ),
    );
}

async function contentsOf(db: DbOrTx, workspaceId: string, now: Date): Promise<WorkspaceContents> {
  // Sequential: inside a transaction the queries share one connection.
  const [projects] = await db
    .select({ n: count() })
    .from(project)
    .where(eq(project.workspaceId, workspaceId));
  const [tasks] = await db
    .select({ n: count() })
    .from(task)
    .innerJoin(project, eq(project.id, task.projectId))
    .where(eq(project.workspaceId, workspaceId));
  const agents = await soleAgentsOf(db, workspaceId);
  const keys = await countActiveWorkspaceKeys(db, workspaceId, now);
  return WorkspaceContents.parse({
    projects: projects?.n ?? 0,
    tasks: tasks?.n ?? 0,
    agents: agents.length,
    keys,
  });
}

/**
 * What deleting the actor's workspace would remove, for the confirm copy: projects, their tasks
 * (hidden ones too), the agents that belong to it alone, and the API keys for it that still work.
 */
export async function getWorkspaceContents(ctx: DbContext, actor: Actor): Promise<WorkspaceContents> {
  return contentsOf(ctx.db, actor.workspaceId, clockNow(ctx));
}

// ---------------------------------------------------------------------------
// Writes
// ---------------------------------------------------------------------------

/** People signed in to the web app; workspace changes never go through an API key. */
function requireSessionPerson(actor: Actor, message: string): void {
  if (actor.kind !== 'person' || !isSession(actor)) throw new Forbidden(message);
}

/**
 * Creates a workspace with `userId` as its owner and makes it the one they use last. Without a
 * slug, the first free one suggested from the name is used. Refused for agents (Forbidden), by the
 * creation policy (WorkspaceCreationOff), and for a reserved or taken slug.
 */
export async function createWorkspace(
  ctx: WorkspaceContext,
  userId: string,
  input: z.input<typeof CreateWorkspaceInput>,
): Promise<Workspace> {
  const parsed = parseInput(CreateWorkspaceInput, input);
  const now = clockNow(ctx);
  const policy = ctx.workspaceCreation ?? DEFAULT_WORKSPACE_CREATION;
  try {
    return await ctx.db.transaction(async (tx) => {
      const person = await loadPerson(tx, userId);
      if (person.kind !== 'person') throw new Forbidden('Agents cannot create workspaces');
      const roles = (await membershipsOf(tx, userId)).map((item) => item.role);
      if (!mayCreate(person.kind, roles, policy)) {
        throw new WorkspaceCreationOff('On this server, only people who own a workspace can create one.');
      }

      await lockSlugs(tx);
      const slug = parsed.slug ?? (await firstFreeSlug(tx, parsed.name, now));
      if (parsed.slug) await claimableSlug(tx, slug, null, now);
      await tx.delete(workspaceSlugAlias).where(eq(workspaceSlugAlias.slug, slug));

      const [created] = await tx
        .insert(organization)
        .values({ name: parsed.name, slug })
        .returning({ id: organization.id, name: organization.name, slug: organization.slug });
      if (!created) throw new Error('createWorkspace: organization insert returned no row');
      await tx.insert(member).values({ organizationId: created.id, userId, role: 'owner' });
      await tx.update(user).set({ lastWorkspaceId: created.id }).where(eq(user.id, userId));
      return { ...created, role: 'owner' as const };
    });
  } catch (error) {
    // Setup writes slugs without the lock; the unique index has the last word.
    if (isUniqueViolation(error, 'organization_slug_key'))
      throw slugTaken(parsed.slug ?? suggestWorkspaceSlug(parsed.name));
    throw error;
  }
}

/**
 * Renames the actor's workspace or changes its slug (owners and admins, in the web app). The old
 * slug becomes an alias, so links made with it keep working. Taking back one of the workspace's
 * own old slugs is allowed; another workspace's is refused within the reuse window.
 */
export async function updateWorkspace(
  ctx: DbContext,
  actor: Actor,
  input: z.input<typeof UpdateWorkspaceInput>,
): Promise<Workspace> {
  const parsed = parseInput(UpdateWorkspaceInput, input);
  const message = 'Only owners and admins can rename the workspace or change its address';
  requireSessionPerson(actor, message);
  if (!isAdmin(actor)) throw new Forbidden(message);
  const now = clockNow(ctx);
  const workspaceId = actor.workspaceId;

  try {
    return await ctx.db.transaction(async (tx) => {
      if (parsed.slug !== undefined) await lockSlugs(tx);
      const [row] = await tx
        .select({ id: organization.id, name: organization.name, slug: organization.slug })
        .from(organization)
        .where(eq(organization.id, workspaceId))
        .for('update');
      if (!row) throw new NotFound('Workspace not found');

      const changes: { name?: string; slug?: string } = {};
      if (parsed.name !== undefined && parsed.name !== row.name) changes.name = parsed.name;
      if (parsed.slug !== undefined && parsed.slug !== row.slug) {
        await claimableSlug(tx, parsed.slug, workspaceId, now);
        await tx.delete(workspaceSlugAlias).where(eq(workspaceSlugAlias.slug, parsed.slug));
        if (fitsSlugRule(row.slug)) {
          await tx
            .insert(workspaceSlugAlias)
            .values({ slug: row.slug, workspaceId, createdAt: now })
            .onConflictDoUpdate({ target: workspaceSlugAlias.slug, set: { workspaceId, createdAt: now } });
        }
        changes.slug = parsed.slug;
      }
      if (Object.keys(changes).length === 0) return { ...row, role: actor.role };

      const [updated] = await tx
        .update(organization)
        .set(changes)
        .where(eq(organization.id, workspaceId))
        .returning({ id: organization.id, name: organization.name, slug: organization.slug });
      if (!updated) throw new NotFound('Workspace not found');
      return { ...updated, role: actor.role };
    });
  } catch (error) {
    if (isUniqueViolation(error, 'organization_slug_key')) throw slugTaken(parsed.slug ?? '');
    throw error;
  }
}

/**
 * Takes the actor out of their workspace (people, in the web app). Their API keys for it are
 * deleted. The last owner is refused (LastOwner): they delete the workspace instead. So is the
 * responsible human of agents there (ResponsibleForAgents), until the agents are removed.
 */
export async function leaveWorkspace(
  ctx: DbContext,
  actor: Actor,
  input: z.input<typeof LeaveWorkspaceInput> = {},
): Promise<WorkspaceRef> {
  parseInput(LeaveWorkspaceInput, input);
  requireSessionPerson(actor, 'Only people signed in to the web app can leave a workspace');
  return ctx.db.transaction(async (tx) => {
    const [row] = await tx
      .select({ id: organization.id, name: organization.name, slug: organization.slug })
      .from(organization)
      .where(eq(organization.id, actor.workspaceId))
      .for('update');
    if (!row) throw new NotFound('Workspace not found');
    await ensureNotLastOwner(
      tx,
      row.id,
      actor.userId,
      `You are the only owner of ${row.name}, so you can't leave it. Delete the workspace instead.`,
    );
    await ensureNotResponsibleForAgents(tx, row.id, actor.userId);
    const removed = await tx
      .delete(member)
      .where(and(eq(member.organizationId, row.id), eq(member.userId, actor.userId)))
      .returning({ id: member.id });
    if (removed.length === 0) throw new NotFound('You are not a member of this workspace');
    await deleteMemberApiKeys(tx, row.id, actor.userId);
    await forgetLastWorkspace(tx, row.id, actor.userId);
    return row;
  });
}

/**
 * Deletes the actor's workspace (owners, in the web app) after they typed its slug again: its
 * projects with everything in them, its memberships, invitations and connections (cascades), every
 * API key for it, and its agents that belong to no other workspace. Returns what went.
 */
export async function deleteWorkspace(
  ctx: DbContext,
  actor: Actor,
  input: z.input<typeof DeleteWorkspaceInput>,
): Promise<WorkspaceContents> {
  const { confirmSlug } = parseInput(DeleteWorkspaceInput, input);
  const message = 'Only owners can delete the workspace';
  requireSessionPerson(actor, message);
  if (actor.role !== 'owner') throw new Forbidden(message);
  const now = clockNow(ctx);

  return ctx.db.transaction(async (tx) => {
    const [row] = await tx
      .select({ id: organization.id, slug: organization.slug })
      .from(organization)
      .where(eq(organization.id, actor.workspaceId))
      .for('update');
    if (!row) throw new NotFound('Workspace not found');
    if (confirmSlug !== row.slug) {
      const mismatch = `Type ${row.slug} to confirm.`;
      throw new Invalid('The slug you typed does not match this workspace', {
        issues: [{ path: 'confirmSlug', message: mismatch }],
      });
    }

    const contents = await contentsOf(tx, row.id, now);
    const agentIds = (await soleAgentsOf(tx, row.id)).map((agent) => agent.id);
    await deleteWorkspaceApiKeys(tx, row.id);
    // Rows the agents wrote (tasks, comments, activity) restrict deleting them; they all belong to
    // the workspace, so they go with the organization first.
    await tx.delete(organization).where(eq(organization.id, row.id));
    if (agentIds.length > 0) await tx.delete(user).where(inArray(user.id, agentIds));
    return contents;
  });
}

/** Remembers the actor's workspace as the one they used last, so `/` lands there. People only. */
export async function touchLastWorkspace(ctx: DbContext, actor: Actor): Promise<void> {
  if (actor.kind !== 'person') return;
  await ctx.db
    .update(user)
    .set({ lastWorkspaceId: actor.workspaceId })
    .where(
      and(eq(user.id, actor.userId), sql`${user.lastWorkspaceId} is distinct from ${actor.workspaceId}`),
    );
}
