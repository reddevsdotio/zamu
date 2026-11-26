// Finds a workspace by its slug, current or old. Requests name their workspace with the x-zamu-workspace
// header, and a renamed workspace keeps answering to the slugs it had before (workspace_slug_alias), so
// links and CLI logins made with an old slug keep working. Core has its own copy of this lookup for its
// services; both read the same two tables.
import { WORKSPACE_HEADER } from '@zamu/contracts';
import { type DbOrTx, schema } from '@zamu/db';
import { eq } from 'drizzle-orm';

export interface WorkspaceBySlug {
  id: string;
  name: string;
  /** The current slug. Differs from the one asked for when that was an old slug. */
  slug: string;
  /** True when the slug asked for is an old slug of the workspace. */
  alias: boolean;
}

/**
 * The workspace whose current slug is `slug`, else the one that held it before. Null when neither
 * exists. The slug is compared as given: callers lower-case and trim it first (workspaceHeader does).
 */
export async function findWorkspaceBySlug(db: DbOrTx, slug: string): Promise<WorkspaceBySlug | null> {
  // Header values longer than any stored slug could be are answered without a query.
  if (!slug || slug.length > 255) return null;
  const columns = {
    id: schema.organization.id,
    name: schema.organization.name,
    slug: schema.organization.slug,
  };
  const [current] = await db
    .select(columns)
    .from(schema.organization)
    .where(eq(schema.organization.slug, slug))
    .limit(1);
  if (current) return { ...current, alias: false };
  const [old] = await db
    .select(columns)
    .from(schema.workspaceSlugAlias)
    .innerJoin(schema.organization, eq(schema.organization.id, schema.workspaceSlugAlias.workspaceId))
    .where(eq(schema.workspaceSlugAlias.slug, slug))
    .limit(1);
  return old ? { ...old, alias: true } : null;
}

/**
 * The slug in the x-zamu-workspace header, trimmed and lower-cased, or null when the header is missing
 * or blank. A value that is not a valid slug is still returned, so it names no workspace and is refused
 * instead of being ignored.
 */
export function workspaceHeader(headers: Headers): string | null {
  const value = headers.get(WORKSPACE_HEADER)?.trim().toLowerCase();
  return value ? value : null;
}
