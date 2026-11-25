// Helpers shared by services. Not part of the public API, except isMirrored (re-exported by
// projects.ts).
import {
  BacklogBlock,
  formatBacklogId,
  formatTaskKey,
  ProjectKeyInput,
  parseBacklogId,
  splitTaskKey,
  type TaskKeyParts,
  TaskRefInput,
  type UserRef,
} from '@zamu/contracts';
import { type DbOrTx, schema } from '@zamu/db';
import { and, asc, eq, inArray, isNull, sql } from 'drizzle-orm';
import { type Actor, authorize, can } from './authz';
import { Forbidden, Invalid, NotFound, parseInput } from './errors';

export type UserRow = Pick<typeof schema.user.$inferSelect, 'id' | 'name' | 'kind' | 'responsibleUserId'>;

export function userRef(row: Pick<UserRow, 'id' | 'name' | 'kind'>): UserRef {
  return { id: row.id, name: row.name, kind: row.kind };
}

/** Loads users by id; missing ids are left out of the map. */
export async function loadUsers(db: DbOrTx, ids: Iterable<string>): Promise<Map<string, UserRow>> {
  const unique = [...new Set(ids)];
  if (unique.length === 0) return new Map();
  const rows = await db
    .select({
      id: schema.user.id,
      name: schema.user.name,
      kind: schema.user.kind,
      responsibleUserId: schema.user.responsibleUserId,
    })
    .from(schema.user)
    .where(inArray(schema.user.id, unique));
  return new Map(rows.map((row) => [row.id, row]));
}

/** Timestamps from raw SQL may arrive as strings; normalise to Date. */
export function toDate(value: Date | string): Date {
  return value instanceof Date ? value : new Date(value);
}

export type ProjectRow = typeof schema.project.$inferSelect;
export type TaskRow = typeof schema.task.$inferSelect;

/**
 * The project with `key` in the actor's workspace. NotFound when it does not exist; Forbidden
 * when the actor's key does not cover it.
 */
export async function findProjectByKey(
  db: DbOrTx,
  actor: Actor,
  key: string,
  options: { forUpdate?: boolean } = {},
): Promise<ProjectRow> {
  const query = db
    .select()
    .from(schema.project)
    .where(and(eq(schema.project.workspaceId, actor.workspaceId), eq(schema.project.key, key)))
    .limit(1);
  const [row] = options.forUpdate ? await query.for('update') : await query;
  if (!row) throw new NotFound(`Project ${key} not found`);
  authorize(actor, 'project.read', { type: 'project', projectId: row.id });
  return row;
}

/** A member of the workspace with their role, or null when `userId` is not a member. */
export async function workspaceMember(db: DbOrTx, workspaceId: string, userId: string) {
  const [row] = await db
    .select({
      id: schema.user.id,
      name: schema.user.name,
      kind: schema.user.kind,
      responsibleUserId: schema.user.responsibleUserId,
      role: schema.member.role,
    })
    .from(schema.member)
    .innerJoin(schema.user, eq(schema.user.id, schema.member.userId))
    .where(and(eq(schema.member.organizationId, workspaceId), eq(schema.member.userId, userId)))
    .limit(1);
  return row ?? null;
}

export interface FindTaskOptions {
  /** Locks the task row. */
  forUpdate?: boolean;
  /** Also locks the project row, taken before the task row. */
  lockProject?: boolean;
  /**
   * Narrows a Backlog.md id lookup to this project key. Ids like TASK-12 repeat across
   * repositories; app keys name their project already.
   */
  project?: string;
}

/** Where a task reference points, before any lock is taken. */
interface TaskHit {
  project: ProjectRow;
  taskId: string;
}

/** Condition on task.key_suffix: equal, or null for plain keys. */
function suffixIs(suffix: string | null) {
  return suffix === null ? isNull(schema.task.keySuffix) : eq(schema.task.keySuffix, suffix);
}

/** The task with app key `parts`. Forbidden when its project is outside the key's scope. */
async function findByAppKey(db: DbOrTx, actor: Actor, parts: TaskKeyParts): Promise<TaskHit | null> {
  const [projectRow] = await db
    .select()
    .from(schema.project)
    .where(and(eq(schema.project.workspaceId, actor.workspaceId), eq(schema.project.key, parts.projectKey)))
    .limit(1);
  if (!projectRow) return null;
  authorize(actor, 'project.read', { type: 'project', projectId: projectRow.id });
  const [row] = await db
    .select({ id: schema.task.id })
    .from(schema.task)
    .where(
      and(
        eq(schema.task.projectId, projectRow.id),
        eq(schema.task.number, parts.number),
        suffixIs(parts.suffix),
      ),
    )
    .limit(1);
  return row ? { project: projectRow, taskId: row.id } : null;
}

/**
 * The task whose Backlog.md id is `backlogId` (canonical form), in `projectKey` when given, else
 * anywhere in the workspace the actor can read. Invalid when it matches tasks in several projects;
 * Forbidden when it matches only outside the key's scope.
 */
async function findByBacklogId(
  db: DbOrTx,
  actor: Actor,
  backlogId: string,
  projectKey: string | undefined,
): Promise<TaskHit | null> {
  const rows = await db
    .select({ taskId: schema.task.id, project: schema.project })
    .from(schema.task)
    .innerJoin(schema.project, eq(schema.project.id, schema.task.projectId))
    .where(
      and(
        eq(schema.project.workspaceId, actor.workspaceId),
        eq(schema.task.backlogId, backlogId),
        projectKey ? eq(schema.project.key, projectKey) : undefined,
      ),
    )
    .orderBy(asc(schema.project.key), asc(schema.task.id));
  if (rows.length === 0) return null;
  const readable = rows.filter((row) =>
    can(actor, 'project.read', { type: 'project', projectId: row.project.id }),
  );
  if (readable.length === 0) {
    authorize(actor, 'project.read', {
      type: 'project',
      projectId: (rows[0] as (typeof rows)[number]).project.id,
    });
  }
  const projectKeys = [...new Set(readable.map((row) => row.project.key))];
  if (projectKeys.length > 1) {
    const message = `${backlogId} is a Backlog.md id in several projects (${projectKeys.join(', ')}). Name the project.`;
    throw new Invalid(message, { issues: [{ path: 'project', message }] });
  }
  const [hit] = readable;
  return hit ? { project: hit.project, taskId: hit.taskId } : null;
}

/**
 * The project and task rows for a task reference: an app key (PAY-142, PAY-786.1) or, in a project
 * mirrored from Backlog.md, a Backlog.md id (BACK-786.1, any case, zero padding ignored). The app
 * key is tried first, then the Backlog.md id; with `project` naming another project than the key's
 * prefix, the Backlog.md id in that project goes first. NotFound for unknown references.
 *
 * `forUpdate` locks the task row; `lockProject` also locks the project row, taken first. Lock
 * order is always project, then tasks: services that rewrite other tasks of the project (board
 * ranks, ending a cycle) hold the project lock, so taking it after a task lock could deadlock.
 */
export async function findTask(
  db: DbOrTx,
  actor: Actor,
  key: string,
  options: FindTaskOptions = {},
): Promise<{ project: ProjectRow; task: TaskRow }> {
  const ref = parseInput(TaskRefInput, key);
  const narrow = options.project ? parseInput(ProjectKeyInput, options.project) : undefined;
  const parts = splitTaskKey(ref);
  const backlogParts = parseBacklogId(ref);
  const backlogId = backlogParts ? formatBacklogId(backlogParts) : null;

  const byAppKey = () => (parts ? findByAppKey(db, actor, parts) : Promise.resolve(null));
  const byBacklogId = () =>
    backlogId ? findByBacklogId(db, actor, backlogId, narrow) : Promise.resolve(null);
  const attempts =
    narrow && parts && parts.projectKey !== narrow ? [byBacklogId, byAppKey] : [byAppKey, byBacklogId];

  let forbidden: Forbidden | null = null;
  let hit: TaskHit | null = null;
  for (const attempt of attempts) {
    try {
      hit = await attempt();
    } catch (error) {
      if (!(error instanceof Forbidden)) throw error;
      forbidden ??= error;
    }
    if (hit) break;
  }
  if (!hit) {
    if (forbidden) throw forbidden;
    throw new NotFound(`Task ${ref} not found`);
  }

  let projectRow = hit.project;
  if (options.lockProject) {
    const [locked] = await db
      .select()
      .from(schema.project)
      .where(eq(schema.project.id, projectRow.id))
      .for('update');
    if (!locked) throw new NotFound(`Task ${ref} not found`);
    projectRow = locked;
  }
  const query = db.select().from(schema.task).where(eq(schema.task.id, hit.taskId)).limit(1);
  const [row] = options.forUpdate ? await query.for('update') : await query;
  if (!row) throw new NotFound(`Task ${ref} not found`);
  return { project: projectRow, task: row };
}

/**
 * The projects of the workspace the actor can read, ordered by key. With `keys`, exactly those
 * projects (NotFound for an unknown key, Forbidden outside the key's scope), in the order given,
 * duplicates removed.
 */
export async function readableProjects(db: DbOrTx, actor: Actor, keys?: string[]): Promise<ProjectRow[]> {
  if (keys) {
    // Sequential: `db` may be a transaction, whose queries share one connection.
    const rows: ProjectRow[] = [];
    for (const key of new Set(keys)) rows.push(await findProjectByKey(db, actor, key));
    return rows;
  }
  const scope = actor.scope?.projects;
  if (Array.isArray(scope) && scope.length === 0) return [];
  const rows = await db
    .select()
    .from(schema.project)
    .where(
      and(
        eq(schema.project.workspaceId, actor.workspaceId),
        Array.isArray(scope) ? inArray(schema.project.id, scope) : undefined,
      ),
    )
    .orderBy(asc(schema.project.key));
  return rows.filter((row) => can(actor, 'project.read', { type: 'project', projectId: row.id }));
}

export type MilestoneRow = typeof schema.milestone.$inferSelect;

// ---------------------------------------------------------------------------
// Backlog.md sources (M3)
// ---------------------------------------------------------------------------

export type BacklogSourceRow = typeof schema.backlogSource.$inferSelect;
export type GitConnectionRow = typeof schema.gitConnection.$inferSelect;

/** The project's Backlog.md source, detached ones included, or null. */
export async function loadBacklogSource(
  db: DbOrTx,
  projectId: string,
  options: { forUpdate?: boolean } = {},
): Promise<BacklogSourceRow | null> {
  const query = db
    .select()
    .from(schema.backlogSource)
    .where(eq(schema.backlogSource.projectId, projectId))
    .limit(1);
  const [row] = options.forUpdate ? await query.for('update') : await query;
  return row ?? null;
}

/** A source that is not detached: it constrains the project (key, repository, milestones switch). */
export function sourceIsActive(source: Pick<BacklogSourceRow, 'state'> | null): boolean {
  return source !== null && source.state !== 'detached';
}

/** A source that mirrors right now: mode mirror and not detached. Owned fields are locked then. */
export function sourceMirrors(source: Pick<BacklogSourceRow, 'mode' | 'state'> | null): boolean {
  return sourceIsActive(source) && source?.mode === 'mirror';
}

/**
 * Whether the project mirrors Backlog.md right now: it has a source in mirror mode that is not
 * detached (paused and failed mirrors still mirror). Task and milestone fields Backlog.md owns are
 * locked then, and new tasks and milestones are refused.
 */
export async function isMirrored(db: DbOrTx, projectId: string): Promise<boolean> {
  return sourceMirrors(await loadBacklogSource(db, projectId));
}

/** The ids among `projectIds` whose project mirrors Backlog.md right now (see isMirrored). */
export async function mirroredProjectIds(db: DbOrTx, projectIds: string[]): Promise<Set<string>> {
  const unique = [...new Set(projectIds)];
  if (unique.length === 0) return new Set();
  const rows = await db
    .select({
      projectId: schema.backlogSource.projectId,
      mode: schema.backlogSource.mode,
      state: schema.backlogSource.state,
    })
    .from(schema.backlogSource)
    .where(inArray(schema.backlogSource.projectId, unique));
  return new Set(rows.filter(sourceMirrors).map((row) => row.projectId));
}

/**
 * A value as one shell word for a hint command: bare when it is plain, else double-quoted with
 * `"`, `\\`, `$` and `` ` `` escaped. Empty becomes "".
 */
export function shellWord(value: string): string {
  if (/^[A-Za-z0-9@%+=:,./_-]+$/.test(value)) return value;
  return `"${value.replace(/["\\$`]/g, (char) => `\\${char}`)}"`;
}

/** The repository path of the Backlog.md file a task or milestone was last read from, or null. */
export async function backlogFilePath(
  db: DbOrTx,
  source: Pick<BacklogSourceRow, 'id'> | null,
  target: { taskId: string } | { milestoneId: string },
): Promise<string | null> {
  if (!source) return null;
  const [row] = await db
    .select({ path: schema.backlogFile.path })
    .from(schema.backlogFile)
    .where(
      and(
        eq(schema.backlogFile.sourceId, source.id),
        'taskId' in target
          ? eq(schema.backlogFile.taskId, target.taskId)
          : eq(schema.backlogFile.milestoneId, target.milestoneId),
      ),
    )
    // A file read without error wins over a skipped duplicate.
    .orderBy(sql`${schema.backlogFile.error} is not null`, asc(schema.backlogFile.path))
    .limit(1);
  return row?.path ?? null;
}

/**
 * The `backlog task edit <id>` command (`backlog draft edit` for drafts) that changes a mirrored
 * task in Backlog.md, without flags; null for tasks without a Backlog.md id.
 */
export function backlogEditCommand(row: Pick<TaskRow, 'backlogId' | 'backlogData'>): string | null {
  if (!row.backlogId) return null;
  const parts = parseBacklogId(row.backlogId);
  const id = parts ? formatTaskKey('', parts.number, parts.suffix).slice(1) : row.backlogId;
  const block = BacklogBlock.safeParse(row.backlogData ?? {});
  const command = block.success && block.data.kind === 'draft' ? 'draft' : 'task';
  return `backlog ${command} edit ${id}`;
}
