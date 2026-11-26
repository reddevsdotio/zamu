// Projects: list with open counts, create, update, delete, and the milestone and cycle switches.
// M3: project shapes carry their Backlog.md source summary. While a source is active the key is
// fixed, milestones stay on and the repository cannot point elsewhere; clearing it pauses the mirror.
// M6: the done items every new task starts with (defaultDoneItems), set by owners and admins.
// M7: the archive setting (archiveAfterDays: 14 days for new projects, off for older ones, owners
// and admins change it, mirrored projects follow Backlog.md's archive folder), and counts that
// leave archived tasks out.
import {
  BacklogProblem,
  CreateProjectInput,
  type CurrentCycle,
  DEFAULT_ARCHIVE_AFTER_DAYS,
  DeleteProjectInput,
  OPEN_TASK_STATUSES,
  PROJECT_OWNED_FIELDS,
  Project,
  type ProjectBacklogSummary,
  ProjectList,
  type ProjectOwnedField,
  parseRepositoryUrl,
  UpdateProjectInput,
  type UserRef,
} from '@zamu/contracts';
import { type DbOrTx, schema } from '@zamu/db';
import { and, asc, desc, eq, inArray, isNotNull, isNull, like, ne, sql } from 'drizzle-orm';
import type { z } from 'zod';
import { type Actor, authorize, can } from './authz';
import type { DbContext } from './context';
import { type ClockContext, currentCycles } from './cycles';
import { Conflict, Forbidden, isUniqueViolation, ProjectMirrored, parseInput } from './errors';
import {
  type BacklogSourceRow,
  findProjectByKey,
  loadBacklogSource,
  type ProjectRow,
  sourceIsActive,
  sourceMirrors,
  toDate,
  userRef,
} from './internal';
import { syncRepositoryLinkKey } from './repository';

export { isMirrored } from './internal';

const { apikey, backlogFile, backlogSource, project, task, user } = schema;

/**
 * backlog_source.last_error of a mirror paused because its project's repository was cleared. The
 * mirror engine resumes such a source once the project has a repository again.
 */
export const REPOSITORY_CLEARED_ERROR =
  'The project has no repository, so the mirror is paused. Add the repository again to resume it.';

/** Project fields an active Backlog.md source constrains (see PROJECT_OWNED_FIELDS). */
function lockedProjectFields(backlog: ProjectBacklogSummary | null | undefined): ProjectOwnedField[] {
  return backlog && backlog.state !== 'detached' ? [...PROJECT_OWNED_FIELDS] : [];
}

/**
 * The Backlog.md source summary of each project in `projectIds` that has a source (detached ones
 * included); projects without a source are left out. problems.files counts distinct files skipped
 * or read with a warning; problems.values counts values that fell back; hidden counts tasks whose
 * file is gone.
 */
export async function backlogSummaryFor(
  db: DbOrTx,
  projectIds: string[],
): Promise<Map<string, ProjectBacklogSummary>> {
  const result = new Map<string, ProjectBacklogSummary>();
  const unique = [...new Set(projectIds)];
  if (unique.length === 0) return result;
  const sources = await db.select().from(backlogSource).where(inArray(backlogSource.projectId, unique));
  if (sources.length === 0) return result;
  // Sequential: `db` may be a transaction, whose queries share one connection.
  const hiddenRows = await db
    .select({ projectId: task.projectId, count: sql<number>`count(*)`.mapWith(Number) })
    .from(task)
    .where(and(inArray(task.projectId, unique), isNotNull(task.hiddenAt)))
    .groupBy(task.projectId);
  const failedFiles = await db
    .select({ sourceId: backlogFile.sourceId, path: backlogFile.path })
    .from(backlogFile)
    .where(
      and(
        inArray(
          backlogFile.sourceId,
          sources.map((row) => row.id),
        ),
        isNotNull(backlogFile.error),
      ),
    );
  const hidden = new Map(hiddenRows.map((row) => [row.projectId, row.count]));
  for (const source of sources) {
    const files = new Set(failedFiles.filter((row) => row.sourceId === source.id).map((row) => row.path));
    let values = 0;
    for (const warning of source.warnings ?? []) {
      const parsed = BacklogProblem.safeParse(warning);
      if (!parsed.success) continue;
      if (parsed.data.kind === 'file') files.add(parsed.data.path);
      else values += 1;
    }
    result.set(source.projectId, {
      mode: source.mode,
      state: source.state,
      defaultBranch: source.defaultBranch,
      lastReadAt: source.lastReadAt ? source.lastReadAt.toISOString() : null,
      lastReadCommit: source.lastReadCommit,
      lastTrigger: source.lastTrigger,
      problems: { files: files.size, values },
      hidden: hidden.get(source.projectId) ?? 0,
      detachedAt: source.detachedAt ? source.detachedAt.toISOString() : null,
    });
  }
  return result;
}

const PROJECT_KEY_UNIQUE = 'project_workspaceId_key_unique';
const PROJECT_REPOSITORY_UNIQUE = 'project_workspaceId_repositoryKey_unique';

type ProjectContext = DbContext & ClockContext;

/**
 * The contract shape. `currentCycle` is dropped when the project does not use cycles. `backlog`
 * is the project's Backlog.md source summary (backlogSummaryFor), null without a source. M7:
 * archiveAfterDays reads null while the project mirrors Backlog.md, whose archive folder decides.
 */
export function toProject(
  row: ProjectRow,
  currentCycle: CurrentCycle | null = null,
  backlog: ProjectBacklogSummary | null = null,
): Project {
  return Project.parse({
    id: row.id,
    key: row.key,
    name: row.name,
    description: row.description,
    usesMilestones: row.usesMilestones,
    usesCycles: row.usesCycles,
    currentCycle: row.usesCycles ? currentCycle : null,
    repository: row.repository,
    backlog,
    locked: lockedProjectFields(backlog),
    defaultDoneItems: row.defaultDoneItems ?? [],
    archiveAfterDays: backlog && sourceMirrors(backlog) ? null : row.archiveAfterDays,
    createdAt: row.createdAt,
    updatedAt: row.updatedAt,
  });
}

/** toProject with the current cycle and the Backlog.md summary looked up. */
async function toProjectWithCycle(ctx: ProjectContext, db: DbOrTx, row: ProjectRow): Promise<Project> {
  const backlog = (await backlogSummaryFor(db, [row.id])).get(row.id) ?? null;
  if (!row.usesCycles) return toProject(row, null, backlog);
  const cycles = await currentCycles(db, [row.id], ctx);
  return toProject(row, cycles.get(row.id) ?? null, backlog);
}

function keyTaken(key: string): Conflict {
  return new Conflict(`Project key ${key} is already used in this workspace`);
}

/** The stored pair for a validated repository input; nulls for '' or null (no repository). */
function repositoryColumns(value: string | null): {
  repository: string | null;
  repositoryKey: string | null;
} {
  const parsed = value ? parseRepositoryUrl(value) : null;
  return parsed
    ? { repository: value, repositoryKey: parsed.key }
    : { repository: null, repositoryKey: null };
}

function repositoryTaken(short: string, owner?: { key: string; name: string }): Conflict {
  const message = owner
    ? `${owner.name} (${owner.key}) already uses ${short}. A repository can belong to one project.`
    : `Another project in this workspace already uses ${short}. A repository can belong to one project.`;
  return new Conflict(message, { issues: [{ path: 'repository', message }] });
}

/**
 * Conflict when another project of the workspace links the same repository. Names that project
 * only when the actor can read it.
 */
async function assertRepositoryFree(
  db: DbOrTx,
  actor: Actor,
  repositoryKey: string,
  exceptProjectId?: string,
): Promise<void> {
  const [owner] = await db
    .select({ id: project.id, key: project.key, name: project.name, repository: project.repository })
    .from(project)
    .where(
      and(
        eq(project.workspaceId, actor.workspaceId),
        eq(project.repositoryKey, repositoryKey),
        exceptProjectId ? ne(project.id, exceptProjectId) : undefined,
      ),
    )
    .limit(1);
  if (!owner) return;
  const short = parseRepositoryUrl(owner.repository ?? '')?.short ?? repositoryKey;
  const visible = can(actor, 'project.read', { type: 'project', projectId: owner.id });
  throw repositoryTaken(short, visible ? owner : undefined);
}

/** Conflict for a unique violation on the repository index (a concurrent link won the race). */
function repositoryRace(short: string | null): Conflict {
  return repositoryTaken(short ?? 'this repository');
}

const openCount = (status: string) =>
  sql<number>`count(${task.id}) filter (where ${task.status} = ${status} and ${task.hiddenAt} is null and ${task.archivedAt} is null)`.mapWith(
    Number,
  );

/**
 * Projects the actor can read, with open task counts per status, the distinct assignees of open
 * tasks (people first), the last activity time, the current cycle and the Backlog.md source.
 * Hidden tasks count nowhere, nor (M7) do archived ones. Most recently active first.
 */
export async function listProjects(ctx: ProjectContext, actor: Actor): Promise<ProjectList> {
  const { db } = ctx;
  authorize(actor, 'workspace.read');
  const scope = actor.scope?.projects;
  if (Array.isArray(scope) && scope.length === 0) return { items: [] };

  const rows = await db
    .select({
      project,
      backlog: openCount('backlog'),
      todo: openCount('todo'),
      in_progress: openCount('in_progress'),
      in_review: openCount('in_review'),
      lastActivityAt: sql<string>`greatest(${project.updatedAt}, max(${task.updatedAt}))`,
    })
    .from(project)
    .leftJoin(task, eq(task.projectId, project.id))
    .where(
      and(
        eq(project.workspaceId, actor.workspaceId),
        Array.isArray(scope) ? inArray(project.id, scope) : undefined,
      ),
    )
    .groupBy(project.id)
    .orderBy(sql`greatest(${project.updatedAt}, max(${task.updatedAt})) desc`, asc(project.key));

  const visible = rows.filter((row) =>
    can(actor, 'project.read', { type: 'project', projectId: row.project.id }),
  );
  const [assignees, cycles, backlogs] = await Promise.all([
    openAssignees(
      { db },
      visible.map((row) => row.project.id),
    ),
    currentCycles(
      db,
      visible.filter((row) => row.project.usesCycles).map((row) => row.project.id),
      ctx,
    ),
    backlogSummaryFor(
      db,
      visible.map((row) => row.project.id),
    ),
  ]);

  return ProjectList.parse({
    items: visible.map((row) => {
      const openCounts = {
        backlog: row.backlog,
        todo: row.todo,
        in_progress: row.in_progress,
        in_review: row.in_review,
      };
      return {
        ...toProject(row.project, cycles.get(row.project.id) ?? null, backlogs.get(row.project.id) ?? null),
        openCounts,
        openCount: Object.values(openCounts).reduce((sum, n) => sum + n, 0),
        lastActivityAt: toDate(row.lastActivityAt),
        assignees: assignees.get(row.project.id) ?? [],
      };
    }),
  });
}

/** Distinct assignees of open tasks per project, people first, then by name. */
async function openAssignees({ db }: DbContext, projectIds: string[]): Promise<Map<string, UserRef[]>> {
  const result = new Map<string, UserRef[]>();
  if (projectIds.length === 0) return result;
  const rows = await db
    .selectDistinct({ projectId: task.projectId, id: user.id, name: user.name, kind: user.kind })
    .from(task)
    .innerJoin(user, eq(user.id, task.assigneeId))
    .where(
      and(
        inArray(task.projectId, projectIds),
        inArray(task.status, [...OPEN_TASK_STATUSES]),
        isNull(task.hiddenAt),
        isNull(task.archivedAt),
      ),
    )
    .orderBy(asc(task.projectId), desc(user.kind), asc(user.name), asc(user.id)); // 'person' > 'agent'
  for (const row of rows) {
    const list = result.get(row.projectId) ?? [];
    list.push(userRef(row));
    result.set(row.projectId, list);
  }
  return result;
}

/**
 * Creates a project. Conflict when the key is already used in the workspace, or when another
 * project already links the repository. M7: new projects archive closed tasks after
 * DEFAULT_ARCHIVE_AFTER_DAYS days.
 */
export async function createProject(
  { db }: DbContext,
  actor: Actor,
  input: z.input<typeof CreateProjectInput>,
): Promise<Project> {
  const { name, key, description, repository } = parseInput(CreateProjectInput, input);
  authorize(actor, 'project.create');
  const repo = repositoryColumns(repository ?? null);
  if (repo.repositoryKey) await assertRepositoryFree(db, actor, repo.repositoryKey);
  try {
    const [row] = await db
      .insert(project)
      .values({
        workspaceId: actor.workspaceId,
        key,
        name,
        description: description || null,
        archiveAfterDays: DEFAULT_ARCHIVE_AFTER_DAYS,
        ...repo,
      })
      .returning();
    if (!row) throw new Error('project insert returned no row');
    return toProject(row);
  } catch (error) {
    if (isUniqueViolation(error, PROJECT_KEY_UNIQUE)) throw keyTaken(key);
    if (isUniqueViolation(error, PROJECT_REPOSITORY_UNIQUE))
      throw repositoryRace(repository ? (parseRepositoryUrl(repository)?.short ?? null) : null);
    throw error;
  }
}

/**
 * Updates name, description, key, repository or the milestone and cycle switches. The key can change only
 * while the project has no tasks, because task keys embed it. Conflict otherwise, or when the new
 * key is taken. Turning a switch off keeps the milestones or cycles; turning it on shows them again.
 *
 * M3, while the project has a Backlog.md source that is not detached: the key cannot change and
 * milestones cannot be turned off (ProjectMirrored). The repository cannot point at another
 * repository; clearing it is allowed and pauses the source (REPOSITORY_CLEARED_ERROR), and adding
 * one back to a cleared project clears that error for the mirror engine to resume.
 *
 * M6: defaultDoneItems replaces the done items new tasks start with ([] clears them). Owners and
 * admins only (project.defaults); tasks that exist keep theirs.
 *
 * M7: archiveAfterDays (1 to 365, null is off) sets when the nightly job archives closed tasks.
 * Owners and admins only, like the task defaults; a mirrored project fails with ProjectMirrored,
 * as Backlog.md's archive folder decides there.
 */
export async function updateProject(
  ctx: ProjectContext,
  actor: Actor,
  input: z.input<typeof UpdateProjectInput>,
): Promise<Project> {
  const parsed = parseInput(UpdateProjectInput, input);
  try {
    return await ctx.db.transaction(async (tx) => {
      // Locking the row also serialises against task creation, which updates next_task_number.
      const current = await findProjectByKey(tx, actor, parsed.project, { forUpdate: true });
      authorize(actor, 'project.update', { type: 'project', projectId: current.id });
      const source = await loadBacklogSource(tx, current.id, { forUpdate: true });
      const active = sourceIsActive(source);

      const changes: Partial<typeof project.$inferInsert> = {};
      if (parsed.name !== undefined && parsed.name !== current.name) changes.name = parsed.name;
      if (parsed.description !== undefined) {
        const description = parsed.description || null;
        if (description !== current.description) changes.description = description;
      }
      if (parsed.key !== undefined && parsed.key !== current.key) {
        if (active) {
          throw new ProjectMirrored(
            `The key of ${current.key} can't change while it reads Backlog.md: task keys come from the files`,
            { field: 'key', hint: 'Detach the project from Backlog.md first' },
          );
        }
        const [existing] = await tx
          .select({ id: task.id })
          .from(task)
          .where(eq(task.projectId, current.id))
          .limit(1);
        if (existing) {
          throw new Conflict(`The key of ${current.key} cannot change: the project already has tasks`);
        }
        changes.key = parsed.key;
      }
      if (parsed.usesMilestones !== undefined && parsed.usesMilestones !== current.usesMilestones) {
        if (active && !parsed.usesMilestones) {
          throw new ProjectMirrored(
            `Milestones stay on while ${current.key} reads Backlog.md: its milestones live here`,
            { field: 'usesMilestones', hint: 'Detach the project from Backlog.md first' },
          );
        }
        changes.usesMilestones = parsed.usesMilestones;
      }
      if (parsed.usesCycles !== undefined && parsed.usesCycles !== current.usesCycles) {
        changes.usesCycles = parsed.usesCycles;
      }
      if (parsed.defaultDoneItems !== undefined) {
        authorize(actor, 'project.defaults', { type: 'project', projectId: current.id });
        const before = current.defaultDoneItems ?? [];
        const after = parsed.defaultDoneItems;
        const same = before.length === after.length && before.every((text, index) => text === after[index]);
        if (!same) changes.defaultDoneItems = after;
      }
      if (parsed.archiveAfterDays !== undefined) {
        if (!can(actor, 'project.defaults', { type: 'project', projectId: current.id })) {
          throw new Forbidden('Only owners and admins can change the archive setting of a project');
        }
        if (sourceMirrors(source)) {
          throw new ProjectMirrored(
            `${current.key} reads Backlog.md, so its archive follows the archive/tasks/ folder there`,
            { field: 'archiveAfterDays', hint: 'Move task files under archive/tasks/ and push' },
          );
        }
        if (parsed.archiveAfterDays !== current.archiveAfterDays) {
          changes.archiveAfterDays = parsed.archiveAfterDays;
        }
      }
      if (parsed.repository !== undefined) {
        const repo = repositoryColumns(parsed.repository);
        if (repo.repository !== current.repository) {
          if (
            active &&
            repo.repositoryKey &&
            current.repositoryKey &&
            repo.repositoryKey !== current.repositoryKey
          ) {
            throw new ProjectMirrored(
              `${current.key} reads Backlog.md from ${current.repository}, so its repository can't point elsewhere. Clearing it pauses the mirror.`,
              { field: 'repository', hint: 'Detach the project from Backlog.md first' },
            );
          }
          if (repo.repositoryKey) await assertRepositoryFree(tx, actor, repo.repositoryKey, current.id);
          Object.assign(changes, repo);
          if (active && source) await pauseOrResumeForRepository(tx, source, repo.repository);
        }
      }
      if (Object.keys(changes).length === 0) return toProjectWithCycle(ctx, tx, current);

      const [row] = await tx.update(project).set(changes).where(eq(project.id, current.id)).returning();
      if (!row) throw new Error('project update returned no row');
      // M7: a new repository starts its repository link over (old requests go, links reset).
      if (changes.repositoryKey !== undefined) await syncRepositoryLinkKey(tx, ctx, row);
      return toProjectWithCycle(ctx, tx, row);
    });
  } catch (error) {
    if (parsed.key && isUniqueViolation(error, PROJECT_KEY_UNIQUE)) throw keyTaken(parsed.key);
    if (isUniqueViolation(error, PROJECT_REPOSITORY_UNIQUE)) {
      throw repositoryRace(parsed.repository ? (parseRepositoryUrl(parsed.repository)?.short ?? null) : null);
    }
    throw error;
  }
}

/**
 * Clearing the repository of a project with an active source pauses the source; adding it back
 * clears REPOSITORY_CLEARED_ERROR (the state stays paused until the mirror engine reads again).
 */
async function pauseOrResumeForRepository(
  tx: DbOrTx,
  source: BacklogSourceRow,
  repository: string | null,
): Promise<void> {
  if (repository === null) {
    await tx
      .update(backlogSource)
      .set({ state: 'paused', lastError: REPOSITORY_CLEARED_ERROR })
      .where(eq(backlogSource.id, source.id));
  } else if (source.lastError === REPOSITORY_CLEARED_ERROR) {
    await tx.update(backlogSource).set({ lastError: null }).where(eq(backlogSource.id, source.id));
  }
}

/** Where deleteProject writes its audit line. Default: one JSON object per line on stdout. */
export interface ProjectLogger {
  info(msg: string, fields: Record<string, unknown>): void;
}

const stdoutLogger: ProjectLogger = {
  info(msg, fields) {
    console.info(JSON.stringify({ time: new Date().toISOString(), level: 'info', msg, ...fields }));
  },
};

/** CoreContext has no logger yet; adapters may pass one, tests capture the line with it. */
export type DeleteProjectContext = DbContext & { logger?: ProjectLogger };

/**
 * Key metadata as stored (JSON text, which Better Auth may have encoded twice) and how many times
 * it was encoded, so a rewrite keeps the same form. Null when it is not a JSON object.
 */
function decodeKeyMetadata(raw: string | null): { value: Record<string, unknown>; depth: number } | null {
  let value: unknown = raw;
  let depth = 0;
  while (typeof value === 'string' && depth < 2) {
    try {
      value = JSON.parse(value);
    } catch {
      return null;
    }
    depth += 1;
  }
  if (typeof value !== 'object' || value === null || Array.isArray(value)) return null;
  return { value: value as Record<string, unknown>, depth };
}

function encodeKeyMetadata(value: Record<string, unknown>, depth: number): string {
  let text: string = JSON.stringify(value);
  for (let i = 1; i < depth; i++) text = JSON.stringify(text);
  return text;
}

/**
 * Removes `projectId` from the project list of every API key scoped to it in the workspace. Keys
 * left with no project keep working for nothing and stay listed ("No projects"); none is revoked.
 * Returns how many keys changed.
 */
async function stripKeyScopes(tx: DbOrTx, workspaceId: string, projectId: string): Promise<number> {
  // Project ids are UUIDs, so a text match finds every candidate; the JSON check below decides.
  const rows = await tx
    .select({ id: apikey.id, metadata: apikey.metadata })
    .from(apikey)
    .where(like(apikey.metadata, `%${projectId}%`))
    .for('update');
  let changed = 0;
  for (const row of rows) {
    const decoded = decodeKeyMetadata(row.metadata);
    if (!decoded || decoded.value.workspaceId !== workspaceId) continue;
    const projects = decoded.value.projects;
    if (!Array.isArray(projects) || !projects.includes(projectId)) continue;
    const metadata = encodeKeyMetadata(
      { ...decoded.value, projects: projects.filter((id) => id !== projectId) },
      decoded.depth,
    );
    await tx.update(apikey).set({ metadata }).where(eq(apikey.id, row.id));
    changed += 1;
  }
  return changed;
}

/**
 * Deletes a project with its milestones, cycles, tasks, activity, comments, mentions, rollovers
 * and Backlog.md source and files (the foreign keys cascade). Owners and admins only, people only;
 * through a key only a workspace-wide write key. `confirmKey` must repeat the project key.
 *
 * One transaction: the project row is locked first (the order of updateProject and the refresh
 * apply step, so a running refresh finds the project gone and skips), then API key scopes naming
 * the project lose it. Activity goes with the project, so the deletion is logged instead.
 */
export async function deleteProject(
  ctx: DeleteProjectContext,
  actor: Actor,
  input: z.input<typeof DeleteProjectInput>,
): Promise<void> {
  const parsed = parseInput(DeleteProjectInput, input);
  const deleted = await ctx.db.transaction(async (tx) => {
    const current = await findProjectByKey(tx, actor, parsed.project, { forUpdate: true });
    authorize(actor, 'project.delete', { type: 'project', projectId: current.id });
    const [count] = await tx
      .select({ n: sql<number>`count(*)`.mapWith(Number) })
      .from(task)
      .where(eq(task.projectId, current.id));
    const source = await loadBacklogSource(tx, current.id);
    const keysUpdated = await stripKeyScopes(tx, actor.workspaceId, current.id);
    await tx.delete(project).where(eq(project.id, current.id));
    return { row: current, taskCount: count?.n ?? 0, backlogSource: source !== null, keysUpdated };
  });
  (ctx.logger ?? stdoutLogger).info('project deleted', {
    actorId: actor.userId,
    onBehalfOfId: actor.onBehalfOfId,
    apiKeyId: actor.apiKeyId ?? null,
    workspaceId: actor.workspaceId,
    projectKey: deleted.row.key,
    projectId: deleted.row.id,
    taskCount: deleted.taskCount,
    backlogSource: deleted.backlogSource,
    apiKeysUpdated: deleted.keysUpdated,
  });
}
