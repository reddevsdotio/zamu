// M7 tables: a project's repository link (connection, webhook, hourly check and the close-on-merge
// switch), the pull and merge requests Zamu has seen in that repository, and which tasks each one
// links. Enumerations are text columns with check constraints, like the Backlog.md tables.
import { sql } from 'drizzle-orm';
import {
  boolean,
  check,
  index,
  integer,
  pgTable,
  primaryKey,
  text,
  timestamp,
  unique,
  uniqueIndex,
  uuid,
} from 'drizzle-orm/pg-core';
import { project, task } from './app';
import { organization, user } from './auth';
import { gitConnection } from './backlog';

/** Builds `column in ('a', 'b')` for a check constraint. Values are constants, never input. */
function oneOf(column: unknown, values: readonly string[]) {
  return sql`${column} in (${sql.raw(values.map((value) => `'${value}'`).join(', '))})`;
}

/** How the last webhook delivery went: accepted, refused for its signature, or unreadable. */
export const REPOSITORY_WEBHOOK_STATUSES = ['ok', 'bad_signature', 'bad_payload'] as const;
export type RepositoryWebhookStatus = (typeof REPOSITORY_WEBHOOK_STATUSES)[number];

/** A request's state on the host. Draft is an open request marked as not ready. */
export const PULL_REQUEST_STATES = ['open', 'draft', 'merged', 'closed'] as const;
export type PullRequestState = (typeof PULL_REQUEST_STATES)[number];

const createdAt = () => timestamp('created_at', { withTimezone: true }).defaultNow().notNull();
const updatedAt = () =>
  timestamp('updated_at', { withTimezone: true })
    .defaultNow()
    .$onUpdate(() => new Date())
    .notNull();

/**
 * One row per project with a repository, made the first time the project needs one (settings page,
 * hourly check, webhook setup). repository_key records which repository the row describes: when
 * the project's repository changes, core resets the row's state.
 */
export const repositoryLink = pgTable(
  'repository_link',
  {
    id: uuid('id').default(sql`uuidv7()`).primaryKey(),
    workspaceId: uuid('workspace_id')
      .notNull()
      .references(() => organization.id, { onDelete: 'cascade' }),
    projectId: uuid('project_id')
      .notNull()
      .references(() => project.id, { onDelete: 'cascade' }),
    /** project.repository_key when the row was made or last reset. */
    repositoryKey: text('repository_key').notNull(),
    /** The token Zamu reads with; null reads a public repository without one. */
    connectionId: uuid('connection_id').references(() => gitConnection.id, { onDelete: 'set null' }),
    /** The repository's default branch, refreshed by every sync; null until the first one. */
    defaultBranch: text('default_branch'),
    /** A merge into the default branch moves linked tasks to Done. Mirrored projects never move. */
    closeOnMerge: boolean('close_on_merge').default(true).notNull(),
    /** Random, URL-safe: POST /api/webhooks/repository/{webhookId}. */
    webhookId: text('webhook_id').notNull(),
    /** Encrypted like git_connection.token_ciphertext; null until a secret is issued. */
    webhookSecretCiphertext: text('webhook_secret_ciphertext'),
    /** When the last delivery arrived, whatever its status. */
    webhookLastAt: timestamp('webhook_last_at', { withTimezone: true }),
    webhookLastStatus: text('webhook_last_status', { enum: REPOSITORY_WEBHOOK_STATUSES }),
    /** When the last sync finished. */
    syncedAt: timestamp('synced_at', { withTimezone: true }),
    /** The newest request update the last sync read; the next one lists from 10 minutes before it. */
    syncCursor: timestamp('sync_cursor', { withTimezone: true }),
    /** Why the last sync failed, without the token; null after a good one. */
    syncError: text('sync_error'),
    /**
     * Events before this time link requests and record their state but move no task. Set when the
     * row is made and when its connection changes.
     */
    movesFrom: timestamp('moves_from', { withTimezone: true }).defaultNow().notNull(),
    createdAt: createdAt(),
    updatedAt: updatedAt(),
  },
  (table) => [
    uniqueIndex('repository_link_projectId_unique').on(table.projectId),
    uniqueIndex('repository_link_webhookId_unique').on(table.webhookId),
    index('repository_link_connectionId_idx').on(table.connectionId),
    check(
      'repository_link_webhook_last_status_check',
      oneOf(table.webhookLastStatus, REPOSITORY_WEBHOOK_STATUSES),
    ),
  ],
);

/**
 * A pull or merge request of the project's repository, as the host last described it. Rows are
 * written from webhook events, syncs and hand links; an event older than host_updated_at is dropped.
 */
export const pullRequest = pgTable(
  'pull_request',
  {
    id: uuid('id').default(sql`uuidv7()`).primaryKey(),
    workspaceId: uuid('workspace_id')
      .notNull()
      .references(() => organization.id, { onDelete: 'cascade' }),
    projectId: uuid('project_id')
      .notNull()
      .references(() => project.id, { onDelete: 'cascade' }),
    /** The host's number: #482 on GitHub and Forgejo, !482 (the iid) on GitLab. */
    number: integer('number').notNull(),
    title: text('title').notNull(),
    /** Task keys found on the description's `Closes:` lines, uppercase, in order of first mention. */
    bodyKeys: text('body_keys').array().default(sql`'{}'::text[]`).notNull(),
    state: text('state', { enum: PULL_REQUEST_STATES }).notNull(),
    headBranch: text('head_branch').notNull(),
    baseBranch: text('base_branch').notNull(),
    /** Host logins; null when the host did not say. */
    author: text('author'),
    mergedBy: text('merged_by'),
    webUrl: text('web_url').notNull(),
    openedAt: timestamp('opened_at', { withTimezone: true }).notNull(),
    mergedAt: timestamp('merged_at', { withTimezone: true }),
    closedAt: timestamp('closed_at', { withTimezone: true }),
    /** The host's updated time of the version stored. */
    hostUpdatedAt: timestamp('host_updated_at', { withTimezone: true }).notNull(),
    createdAt: createdAt(),
    updatedAt: updatedAt(),
  },
  (table) => [
    unique('pull_request_projectId_number_unique').on(table.projectId, table.number),
    index('pull_request_projectId_headBranch_idx').on(table.projectId, table.headBranch),
    check('pull_request_number_check', sql`${table.number} >= 1`),
    check('pull_request_state_check', oneOf(table.state, PULL_REQUEST_STATES)),
  ],
);

/**
 * Which requests a task links, and why: by its work branch, by a `Closes:` line, or by hand. A
 * link shows while removed_at is null and any via_* is true. A link removed by hand keeps its row
 * with removed_at set, so branch and description never bring it back; linking it by hand again
 * clears removed_at.
 */
export const taskPullRequest = pgTable(
  'task_pull_request',
  {
    taskId: uuid('task_id')
      .notNull()
      .references(() => task.id, { onDelete: 'cascade' }),
    pullRequestId: uuid('pull_request_id')
      .notNull()
      .references(() => pullRequest.id, { onDelete: 'cascade' }),
    viaBranch: boolean('via_branch').default(false).notNull(),
    viaDescription: boolean('via_description').default(false).notNull(),
    viaHand: boolean('via_hand').default(false).notNull(),
    /** Who linked it by hand; null for links by branch or description. */
    linkedById: uuid('linked_by_id').references(() => user.id, { onDelete: 'restrict' }),
    removedAt: timestamp('removed_at', { withTimezone: true }),
    removedById: uuid('removed_by_id').references(() => user.id, { onDelete: 'restrict' }),
    createdAt: createdAt(),
  },
  (table) => [
    primaryKey({ columns: [table.taskId, table.pullRequestId] }),
    index('task_pull_request_pullRequestId_idx').on(table.pullRequestId),
    check(
      'task_pull_request_removed_check',
      sql`${table.removedAt} is not null or ${table.removedById} is null`,
    ),
  ],
);
