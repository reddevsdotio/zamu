// Test fixtures for @zamu/core: a workspace with people and an agent on the shared test database.
// Test-only (imports @zamu/db/test, which imports vitest).
import { type Auth, createAuth } from '@zamu/auth';
import { createDb, type Db, type DbHandle, schema } from '@zamu/db';
import { sharedTestDatabaseUrl } from '@zamu/db/test';
import { and, eq, sql } from 'drizzle-orm';
import type { Actor } from '../authz';
import type { CoreContext } from '../context';

export const TEST_SECRET = 'test-secret-test-secret-test-secret-0123';
export const TEST_PUBLIC_URL = 'http://localhost:3000';

export interface TestContext extends CoreContext {
  pool: DbHandle['pool'];
  url: string;
  close: () => Promise<void>;
}

export function testContext(): TestContext {
  const url = sharedTestDatabaseUrl();
  const { db, pool } = createDb(url);
  pool.on('error', () => {});
  const auth: Auth = createAuth({ db, secret: TEST_SECRET, baseUrl: TEST_PUBLIC_URL });
  return { db, auth, publicUrl: TEST_PUBLIC_URL, pool, url, close: () => pool.end() };
}

const unique = () => crypto.randomUUID().slice(0, 8);

export async function createUser(
  db: Db,
  values: Partial<typeof schema.user.$inferInsert> & { name: string },
): Promise<typeof schema.user.$inferSelect> {
  const [row] = await db
    .insert(schema.user)
    .values({ email: `${unique()}-${crypto.randomUUID()}@example.com`, ...values })
    .returning();
  if (!row) throw new Error('user insert failed');
  return row;
}

export interface World {
  workspaceId: string;
  owner: typeof schema.user.$inferSelect;
  member: typeof schema.user.$inferSelect;
  agent: typeof schema.user.$inferSelect;
  /** Session actors: full member rights. */
  ownerActor: Actor;
  memberActor: Actor;
  /** The agent acting through a workspace-wide write key. */
  agentActor: Actor;
}

/**
 * A fresh workspace: an owner, a member, and an agent the member is responsible for. The slug
 * defaults to the name with a UUID, which is longer than the 0.10 slug rule allows; pass `slug`
 * (randomWorkspaceSlug) when a test needs a valid one.
 */
export async function createWorld(db: Db, name = 'Reddevs', options: { slug?: string } = {}): Promise<World> {
  const [workspace] = await db
    .insert(schema.organization)
    .values({ name, slug: options.slug ?? `${name.toLowerCase()}-${crypto.randomUUID()}` })
    .returning();
  if (!workspace) throw new Error('organization insert failed');
  const owner = await createUser(db, { name: `Ana Ruiz ${unique()}` });
  const member = await createUser(db, { name: `Tomás Berg ${unique()}` });
  const agent = await createUser(db, {
    name: `claude-dev-${unique()}`,
    kind: 'agent',
    responsibleUserId: member.id,
  });
  await db.insert(schema.member).values([
    { organizationId: workspace.id, userId: owner.id, role: 'owner' },
    { organizationId: workspace.id, userId: member.id, role: 'member' },
    { organizationId: workspace.id, userId: agent.id, role: 'member' },
  ]);
  const workspaceId = workspace.id;
  return {
    workspaceId,
    owner,
    member,
    agent,
    ownerActor: { userId: owner.id, kind: 'person', workspaceId, role: 'owner', onBehalfOfId: null },
    memberActor: { userId: member.id, kind: 'person', workspaceId, role: 'member', onBehalfOfId: null },
    agentActor: {
      userId: agent.id,
      kind: 'agent',
      workspaceId,
      role: 'member',
      scope: { projects: 'all', access: 'write' },
      onBehalfOfId: member.id,
      apiKeyId: crypto.randomUUID(),
    },
  };
}

/** A workspace slug that follows the slug rule and is unique enough for a shared database. */
export function randomWorkspaceSlug(prefix = 'ws'): string {
  return `${prefix}-${crypto.randomUUID().slice(0, 8)}`;
}

/** Adds an existing user to a workspace with `role`; returns their session actor there. */
export async function addMember(
  db: Db,
  workspaceId: string,
  person: { id: string; kind: 'person' | 'agent' },
  role: 'owner' | 'admin' | 'member' = 'member',
): Promise<Actor> {
  await db.insert(schema.member).values({ organizationId: workspaceId, userId: person.id, role });
  return { userId: person.id, kind: person.kind, workspaceId, role, onBehalfOfId: null };
}

/** A project key that is unique enough for tests sharing a workspace: a letter plus 5 random chars. */
export function randomProjectKey(): string {
  const letters = 'ABCDEFGHIJKLMNOPQRSTUVWXYZ';
  const chars = `${letters}0123456789`;
  let key = letters[Math.floor(Math.random() * letters.length)] as string;
  for (let i = 0; i < 5; i++) key += chars[Math.floor(Math.random() * chars.length)];
  return key;
}

// ---------------------------------------------------------------------------
// M2 rows: milestones, cycles, comments. Raw inserts that skip the services' rules, so tests of one
// service can set up the others' data. Use the services themselves when the rules matter.
// ---------------------------------------------------------------------------

/** Where a fixture row lives: the workspace and project ids. */
export interface ProjectScope {
  workspaceId: string;
  projectId: string;
}

/** A calendar date (YYYY-MM-DD, UTC) `days` after `from` (default now). Negative goes back. */
export function isoDate(days = 0, from: Date = new Date()): string {
  const date = new Date(Date.UTC(from.getUTCFullYear(), from.getUTCMonth(), from.getUTCDate() + days));
  return date.toISOString().slice(0, 10);
}

/** Inserts a milestone. Name defaults to a unique one; status to planned. */
export async function createMilestoneRow(
  db: Db,
  scope: ProjectScope,
  values: Partial<Omit<typeof schema.milestone.$inferInsert, 'workspaceId' | 'projectId'>> & {
    createdById: string;
  },
): Promise<typeof schema.milestone.$inferSelect> {
  const [row] = await db
    .insert(schema.milestone)
    .values({ name: `Milestone ${unique()}`, ...values, ...scope })
    .returning();
  if (!row) throw new Error('milestone insert failed');
  return row;
}

/**
 * Inserts a cycle. The number defaults to the project's next_cycle_number, which is advanced past
 * the number used either way. Dates default to a current 14-day cycle (started 3 days ago).
 */
export async function createCycleRow(
  db: Db,
  scope: ProjectScope,
  values: Partial<Omit<typeof schema.cycle.$inferInsert, 'workspaceId' | 'projectId'>> = {},
): Promise<typeof schema.cycle.$inferSelect> {
  return db.transaction(async (tx) => {
    const [counter] = await tx
      .select({ next: schema.project.nextCycleNumber })
      .from(schema.project)
      .where(eq(schema.project.id, scope.projectId))
      .for('update');
    if (!counter) throw new Error(`project ${scope.projectId} not found`);
    const number = values.number ?? counter.next;
    await tx
      .update(schema.project)
      .set({
        nextCycleNumber: Math.max(counter.next, number + 1),
        updatedAt: sql`${schema.project.updatedAt}`,
      })
      .where(eq(schema.project.id, scope.projectId));
    const [row] = await tx
      .insert(schema.cycle)
      .values({ startsOn: isoDate(-3), endsOn: isoDate(10), ...values, number, ...scope })
      .returning();
    if (!row) throw new Error('cycle insert failed');
    return row;
  });
}

/** Inserts a comment. A deleted comment (deletedAt set) gets a null body, as the check requires. */
export async function createCommentRow(
  db: Db,
  scope: ProjectScope,
  values: Partial<Omit<typeof schema.comment.$inferInsert, 'workspaceId' | 'projectId'>> & {
    taskId: string;
    authorId: string;
  },
): Promise<typeof schema.comment.$inferSelect> {
  const body = values.deletedAt ? null : (values.body ?? `Comment ${unique()}`);
  const [row] = await db
    .insert(schema.comment)
    .values({ ...values, body, ...scope })
    .returning();
  if (!row) throw new Error('comment insert failed');
  return row;
}

/** The project row for `key` in a workspace, e.g. after createProject, for ProjectScope and ids. */
export async function projectRow(db: Db, workspaceId: string, key: string) {
  const [row] = await db
    .select()
    .from(schema.project)
    .where(and(eq(schema.project.workspaceId, workspaceId), eq(schema.project.key, key)))
    .limit(1);
  if (!row) throw new Error(`project ${key} not found`);
  return row;
}

/** ProjectScope of a project row. */
export function scopeOf(row: { id: string; workspaceId: string }): ProjectScope {
  return { workspaceId: row.workspaceId, projectId: row.id };
}

/** An agent actor of `world` acting through a key with this scope (projects are ids). */
export function keyActor(world: World, scope: NonNullable<Actor['scope']>): Actor {
  return { ...world.agentActor, scope, apiKeyId: crypto.randomUUID() };
}

/**
 * Inserts a task, taking its number from the project's counter like the task service does, so it
 * mixes with createTask. Defaults: todo, priority none, unassigned. Writes no activity.
 */
export async function createTaskRow(
  db: Db,
  projectId: string,
  values: Partial<Omit<typeof schema.task.$inferInsert, 'projectId' | 'number'>> & { createdById: string },
): Promise<typeof schema.task.$inferSelect> {
  const { project, task } = schema;
  return db.transaction(async (tx) => {
    const [counter] = await tx
      .update(project)
      .set({ nextTaskNumber: sql`${project.nextTaskNumber} + 1`, updatedAt: sql`${project.updatedAt}` })
      .where(eq(project.id, projectId))
      .returning({ number: sql<number>`${project.nextTaskNumber} - 1`.mapWith(Number) });
    if (!counter) throw new Error(`project ${projectId} not found`);
    const [row] = await tx
      .insert(task)
      .values({ title: `Task ${unique()}`, ...values, projectId, number: counter.number })
      .returning();
    if (!row) throw new Error('task insert failed');
    return row;
  });
}

// ---------------------------------------------------------------------------
// M5 rows: labels, task labels and blocker links. Raw inserts like the M2 rows above; the task
// services check the rules (same project, no loops), these don't.
// ---------------------------------------------------------------------------

/** Inserts a label. Name defaults to a unique one, colour to 1, source to app. */
export async function createLabelRow(
  db: Db,
  scope: ProjectScope,
  values: Partial<Omit<typeof schema.label.$inferInsert, 'workspaceId' | 'projectId'>> = {},
): Promise<typeof schema.label.$inferSelect> {
  const [row] = await db
    .insert(schema.label)
    .values({ name: `label-${unique()}`, color: 1, ...values, ...scope })
    .returning();
  if (!row) throw new Error('label insert failed');
  return row;
}

/** Puts labels on a task. */
export async function addTaskLabels(db: Db, taskId: string, labelIds: string[]): Promise<void> {
  if (labelIds.length === 0) return;
  await db
    .insert(schema.taskLabel)
    .values(labelIds.map((labelId) => ({ taskId, labelId })))
    .onConflictDoNothing();
}

/** Makes `taskId` wait on each of `blockerIds`. */
export async function addTaskBlockers(db: Db, taskId: string, blockerIds: string[]): Promise<void> {
  if (blockerIds.length === 0) return;
  await db
    .insert(schema.taskDependency)
    .values(blockerIds.map((blockerId) => ({ taskId, blockerId })))
    .onConflictDoNothing();
}

// ---------------------------------------------------------------------------
// M6 rows: criteria and done items. Raw inserts like the rows above; the task services check the
// limits and number the items, these don't.
// ---------------------------------------------------------------------------

/**
 * Inserts the items of one list of a task, numbered 1.. in order after any it has. A string is an
 * open item; an object sets the state (waived needs waivedReason) and the source.
 */
export async function createTaskItemRows(
  db: Db,
  taskId: string,
  kind: 'criterion' | 'done',
  items: (
    | string
    | (Partial<Omit<typeof schema.taskItem.$inferInsert, 'taskId' | 'kind' | 'position'>> & { text: string })
  )[],
): Promise<(typeof schema.taskItem.$inferSelect)[]> {
  if (items.length === 0) return [];
  const [last] = await db
    .select({ max: sql<number | null>`max(${schema.taskItem.position})` })
    .from(schema.taskItem)
    .where(and(eq(schema.taskItem.taskId, taskId), eq(schema.taskItem.kind, kind)));
  const start = Number(last?.max ?? 0);
  return db
    .insert(schema.taskItem)
    .values(
      items.map((item, index) => ({
        ...(typeof item === 'string' ? { text: item } : item),
        taskId,
        kind,
        position: start + index + 1,
      })),
    )
    .returning();
}
