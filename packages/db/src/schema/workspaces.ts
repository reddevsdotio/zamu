// Workspace slugs (0.10, multiple workspaces): the format rule shared by organization slugs and
// their aliases, and workspace_slug_alias, which keeps a workspace's old slugs so links made with
// them still reach it. Reserved words and the reuse window are rules in @zamu/core, not here.
import { sql } from 'drizzle-orm';
import { check, index, pgTable, text, timestamp, uuid } from 'drizzle-orm/pg-core';
import { organization } from './auth';

/**
 * A workspace slug: 2 to 40 characters, lowercase letters, digits and single hyphens, starting with
 * a letter and not ending with a hyphen. Same rule as WorkspaceSlug in @zamu/contracts.
 */
export const WORKSPACE_SLUG_SQL_PATTERN = '^[a-z][a-z0-9]*(-[a-z0-9]+)*$';
export const WORKSPACE_SLUG_MIN_LENGTH = 2;
export const WORKSPACE_SLUG_MAX_LENGTH = 40;

/**
 * A slug a workspace used before. Requests on it resolve to the workspace's current slug. The slug
 * is unique across aliases; core also keeps it apart from every current organization slug.
 */
export const workspaceSlugAlias = pgTable(
  'workspace_slug_alias',
  {
    slug: text('slug').primaryKey(),
    workspaceId: uuid('workspace_id')
      .notNull()
      .references(() => organization.id, { onDelete: 'cascade' }),
    /** When the workspace gave the slug up: the start of the window in which no other workspace takes it. */
    createdAt: timestamp('created_at', { withTimezone: true }).defaultNow().notNull(),
  },
  (table) => [
    check(
      'workspace_slug_alias_slug_check',
      sql`char_length(${table.slug}) between ${sql.raw(String(WORKSPACE_SLUG_MIN_LENGTH))} and ${sql.raw(String(WORKSPACE_SLUG_MAX_LENGTH))} and ${table.slug} ~ ${sql.raw(`'${WORKSPACE_SLUG_SQL_PATTERN}'`)}`,
    ),
    index('workspace_slug_alias_workspaceId_idx').on(table.workspaceId),
  ],
);
