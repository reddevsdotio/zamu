// API keys: list, create (for yourself or an agent you are responsible for), revoke, and (0.10)
// delete a person's keys for one workspace or every key of a workspace.
// Keys are Better Auth API-key plugin rows; core stores the scope in metadata as ApiKeyMetadata.
// A person can hold keys for several workspaces, so every list and change filters on the
// metadata's workspaceId, never on the owner alone.
import { parseApiKeyMetadata } from '@zamu/auth';
import {
  type ApiKeyCreated,
  ApiKeyCreated as ApiKeyCreatedSchema,
  type ApiKeyMetadata,
  type ApiKeyScope,
  type ApiKeyScopeView,
  ApiKeySummary,
  CreateApiKeyInput,
  ListApiKeysInput,
  RevokeApiKeyInput,
} from '@zamu/contracts';
import { type DbOrTx, schema } from '@zamu/db';
import { and, desc, eq, inArray, like, type SQL } from 'drizzle-orm';
import type { z } from 'zod';
import { type Actor, authorize, type KeyOwner } from './authz';
import type { AuthContext, DbContext } from './context';
import { Invalid, NotFound, parseInput } from './errors';
import { loadUsers, userRef, workspaceMember } from './internal';

const { apikey, member, project } = schema;

/** Better Auth's API-key plugin rejects longer names (maximumNameLength in @zamu/auth). */
export const MAX_API_KEY_NAME_LENGTH = 100;

/** Key metadata as stored by Better Auth (JSON text, possibly encoded twice), or null. */
export function readKeyMetadata(raw: unknown): ApiKeyMetadata | null {
  let value = raw;
  for (let i = 0; i < 2 && typeof value === 'string'; i++) {
    try {
      value = JSON.parse(value);
    } catch {
      return null;
    }
  }
  return parseApiKeyMetadata(value);
}

type KeyRow = Pick<
  typeof apikey.$inferSelect,
  'id' | 'name' | 'start' | 'referenceId' | 'metadata' | 'enabled' | 'createdAt' | 'lastRequest' | 'expiresAt'
>;

const keyColumns = {
  id: apikey.id,
  name: apikey.name,
  start: apikey.start,
  referenceId: apikey.referenceId,
  metadata: apikey.metadata,
  enabled: apikey.enabled,
  createdAt: apikey.createdAt,
  lastRequest: apikey.lastRequest,
  expiresAt: apikey.expiresAt,
};

/**
 * Resolves scope project ids to references; ids of deleted projects, and of projects outside
 * `workspaceId`, are dropped.
 */
async function scopeViews(
  db: DbOrTx,
  workspaceId: string,
  metadata: ApiKeyMetadata[],
): Promise<ApiKeyScopeView[]> {
  const ids = [...new Set(metadata.flatMap((m) => (m.projects === 'all' ? [] : m.projects)))];
  const rows = ids.length
    ? await db
        .select({ id: project.id, key: project.key, name: project.name })
        .from(project)
        .where(and(eq(project.workspaceId, workspaceId), inArray(project.id, ids)))
    : [];
  const byId = new Map(rows.map((row) => [row.id, row]));
  return metadata.map((m) => ({
    access: m.access,
    projects:
      m.projects === 'all'
        ? 'all'
        : m.projects.map((id) => byId.get(id)).filter((ref): ref is NonNullable<typeof ref> => !!ref),
  }));
}

/** Builds summaries for key rows that belong to `workspaceId`; other rows are dropped. */
async function summaries(db: DbOrTx, workspaceId: string, rows: KeyRow[]): Promise<ApiKeySummary[]> {
  const scoped = rows
    .map((row) => ({ row, metadata: readKeyMetadata(row.metadata) }))
    .filter(
      (entry): entry is { row: KeyRow; metadata: ApiKeyMetadata } =>
        entry.metadata?.workspaceId === workspaceId,
    );
  const [owners, views] = await Promise.all([
    loadUsers(
      db,
      scoped.map(({ row }) => row.referenceId),
    ),
    scopeViews(
      db,
      workspaceId,
      scoped.map(({ metadata }) => metadata),
    ),
  ]);
  return scoped.flatMap(({ row }, index) => {
    const owner = owners.get(row.referenceId);
    const scope = views[index];
    if (!owner || !scope) return [];
    return [
      ApiKeySummary.parse({
        id: row.id,
        name: row.name ?? '',
        start: row.start,
        owner: userRef(owner),
        scope,
        revoked: row.enabled === false,
        createdAt: row.createdAt,
        lastUsedAt: row.lastRequest,
        expiresAt: row.expiresAt,
      }),
    ];
  });
}

/** Number of active keys per owner in the workspace. */
export async function activeKeyCounts(db: DbOrTx, workspaceId: string, ownerIds: string[]) {
  const counts = new Map<string, number>();
  if (ownerIds.length === 0) return counts;
  const rows = await db
    .select({ referenceId: apikey.referenceId, metadata: apikey.metadata, expiresAt: apikey.expiresAt })
    .from(apikey)
    .where(and(inArray(apikey.referenceId, ownerIds), eq(apikey.enabled, true)));
  const now = Date.now();
  for (const row of rows) {
    if (row.expiresAt && row.expiresAt.getTime() <= now) continue;
    if (readKeyMetadata(row.metadata)?.workspaceId !== workspaceId) continue;
    counts.set(row.referenceId, (counts.get(row.referenceId) ?? 0) + 1);
  }
  return counts;
}

/** The workspace member who owns or would own a key. NotFound when not a member. */
async function keyOwner(db: DbOrTx, actor: Actor, userId: string): Promise<KeyOwner> {
  const owner = await workspaceMember(db, actor.workspaceId, userId);
  if (!owner) throw new NotFound('User not found in this workspace');
  return { id: owner.id, kind: owner.kind, responsibleUserId: owner.responsibleUserId };
}

/**
 * Lists keys without secrets, newest first. `owner: 'all'` needs an admin; `'me'` lists your own;
 * a user id lists that member's keys (yourself, an agent you are responsible for, or any as admin).
 */
export async function listApiKeys(
  { db }: DbContext,
  actor: Actor,
  input: z.input<typeof ListApiKeysInput> = {},
): Promise<ApiKeySummary[]> {
  const { owner } = parseInput(ListApiKeysInput, input);
  let ownerFilter: SQL;
  if (owner === 'all') {
    authorize(actor, 'apiKey.listWorkspace');
    ownerFilter = inArray(
      apikey.referenceId,
      db.select({ id: member.userId }).from(member).where(eq(member.organizationId, actor.workspaceId)),
    );
  } else {
    const ownerId = owner === 'me' ? actor.userId : owner;
    if (ownerId !== actor.userId) {
      authorize(actor, 'apiKey.list', { type: 'apiKeyOwner', owner: await keyOwner(db, actor, ownerId) });
    }
    ownerFilter = eq(apikey.referenceId, ownerId);
  }
  const rows = await db
    .select(keyColumns)
    .from(apikey)
    .where(ownerFilter)
    .orderBy(desc(apikey.createdAt), desc(apikey.id));
  return summaries(db, actor.workspaceId, rows);
}

/** Checks that every project in `scope` belongs to the workspace. */
export async function validateScope(
  db: DbOrTx,
  workspaceId: string,
  scope: ApiKeyScope,
  path = 'scope.projects',
) {
  if (scope.projects === 'all') return;
  const ids = [...new Set(scope.projects)];
  const rows = await db
    .select({ id: project.id })
    .from(project)
    .where(and(eq(project.workspaceId, workspaceId), inArray(project.id, ids)));
  if (rows.length !== ids.length) {
    throw new Invalid('The key scope names projects outside this workspace', {
      issues: [{ path, message: 'Unknown project' }],
    });
  }
}

function validateKeyName(name: string, path = 'name') {
  if (name.length > MAX_API_KEY_NAME_LENGTH) {
    throw new Invalid(`Key names are limited to ${MAX_API_KEY_NAME_LENGTH} characters`, {
      issues: [{ path, message: `Use ${MAX_API_KEY_NAME_LENGTH} characters or fewer` }],
    });
  }
}

/**
 * Creates a key through Better Auth for `ownerId` with the given scope, without permission checks.
 * Returns the summary plus the secret, which is never readable again.
 */
export async function issueApiKey(
  { db, auth }: AuthContext,
  workspaceId: string,
  ownerId: string,
  name: string,
  scope: ApiKeyScope,
): Promise<ApiKeyCreated> {
  const metadata: ApiKeyMetadata = { workspaceId, projects: scope.projects, access: scope.access };
  const created = await auth.api.createApiKey({ body: { userId: ownerId, name, metadata } });
  const [summary] = await summaries(db, workspaceId, [
    {
      id: created.id,
      name: created.name,
      start: created.start,
      referenceId: created.referenceId,
      metadata: JSON.stringify(metadata),
      enabled: created.enabled,
      createdAt: created.createdAt,
      lastRequest: created.lastRequest,
      expiresAt: created.expiresAt,
    },
  ]);
  if (!summary) throw new Error('created API key could not be read back');
  return ApiKeyCreatedSchema.parse({ ...summary, key: created.key });
}

/** Creates a key for yourself, or for an agent you are responsible for (admins: any agent). */
export async function createApiKey(
  ctx: AuthContext,
  actor: Actor,
  input: z.input<typeof CreateApiKeyInput>,
): Promise<ApiKeyCreated> {
  const parsed = parseInput(CreateApiKeyInput, input);
  const owner = await keyOwner(ctx.db, actor, parsed.ownerId ?? actor.userId);
  authorize(actor, 'apiKey.create', { type: 'apiKeyOwner', owner });
  validateKeyName(parsed.name);
  await validateScope(ctx.db, actor.workspaceId, parsed.scope);
  return issueApiKey(ctx, actor.workspaceId, owner.id, parsed.name, parsed.scope);
}

/** Revokes (disables) a key. Idempotent; the row stays so lists can show it as revoked. */
export async function revokeApiKey(
  { db }: DbContext,
  actor: Actor,
  input: z.input<typeof RevokeApiKeyInput>,
): Promise<ApiKeySummary> {
  const { id } = parseInput(RevokeApiKeyInput, input);
  const [row] = await db.select(keyColumns).from(apikey).where(eq(apikey.id, id)).limit(1);
  const notFound = new NotFound('API key not found');
  if (!row || readKeyMetadata(row.metadata)?.workspaceId !== actor.workspaceId) throw notFound;
  const owners = await loadUsers(db, [row.referenceId]);
  const ownerRow = owners.get(row.referenceId);
  if (!ownerRow) throw notFound;
  authorize(actor, 'apiKey.revoke', {
    type: 'apiKeyOwner',
    owner: { id: ownerRow.id, kind: ownerRow.kind, responsibleUserId: ownerRow.responsibleUserId },
  });
  const [updated] = row.enabled
    ? await db.update(apikey).set({ enabled: false }).where(eq(apikey.id, id)).returning(keyColumns)
    : [row];
  const [summary] = await summaries(db, actor.workspaceId, [updated ?? row]);
  if (!summary) throw notFound;
  return summary;
}

/**
 * Ids of the key rows whose metadata names `workspaceId`, optionally only those owned by `ownerId`.
 * Metadata is JSON text, so the query narrows on the id as text and readKeyMetadata confirms it.
 */
async function workspaceKeyRows(db: DbOrTx, workspaceId: string, ownerId?: string) {
  const rows = await db
    .select({
      id: apikey.id,
      metadata: apikey.metadata,
      enabled: apikey.enabled,
      expiresAt: apikey.expiresAt,
    })
    .from(apikey)
    .where(
      and(
        like(apikey.metadata, `%${workspaceId}%`),
        ownerId === undefined ? undefined : eq(apikey.referenceId, ownerId),
      ),
    );
  return rows.filter((row) => readKeyMetadata(row.metadata)?.workspaceId === workspaceId);
}

/** Number of keys for `workspaceId` that still work: enabled and not expired at `now`. */
export async function countActiveWorkspaceKeys(db: DbOrTx, workspaceId: string, now: Date): Promise<number> {
  const rows = await workspaceKeyRows(db, workspaceId);
  return rows.filter((row) => row.enabled !== false && (!row.expiresAt || row.expiresAt > now)).length;
}

/**
 * Deletes the keys `userId` holds for `workspaceId`, revoked ones included, when they leave it or
 * are removed. Their keys for other workspaces stay. Returns how many rows went.
 */
export async function deleteMemberApiKeys(db: DbOrTx, workspaceId: string, userId: string): Promise<number> {
  const ids = (await workspaceKeyRows(db, workspaceId, userId)).map((row) => row.id);
  if (ids.length > 0) await db.delete(apikey).where(inArray(apikey.id, ids));
  return ids.length;
}

/** Revokes (disables) the keys `userId` holds for `workspaceId`; the rows stay so lists show them. */
export async function revokeMemberApiKeys(db: DbOrTx, workspaceId: string, userId: string): Promise<number> {
  const ids = (await workspaceKeyRows(db, workspaceId, userId)).map((row) => row.id);
  if (ids.length > 0) await db.update(apikey).set({ enabled: false }).where(inArray(apikey.id, ids));
  return ids.length;
}

/** Deletes every key whose metadata names `workspaceId`, whoever owns it. Returns how many rows went. */
export async function deleteWorkspaceApiKeys(db: DbOrTx, workspaceId: string): Promise<number> {
  const ids = (await workspaceKeyRows(db, workspaceId)).map((row) => row.id);
  if (ids.length > 0) await db.delete(apikey).where(inArray(apikey.id, ids));
  return ids.length;
}
