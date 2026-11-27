// Typed errors thrown by core services. Adapters map them to Problem responses by `code`
// (NotFound 404, Forbidden 403, Conflict 409, TaskChanged 409, Invalid 422, the workspace codes
// of 0.10, and M8's WaveLocked and GateTasksOpen); see PROBLEM_STATUS in @zamu/contracts.
import type {
  MirroredProblemExtensions,
  ProblemCode,
  ProblemIssue,
  ProblemWaveLock,
  Task,
  UserRef,
} from '@zamu/contracts';
import { toProblemIssues } from '@zamu/contracts';
import { ZodError } from 'zod';

export type CoreErrorCode = Extract<
  ProblemCode,
  | 'NOT_FOUND'
  | 'FORBIDDEN'
  | 'CONFLICT'
  | 'TASK_CHANGED'
  | 'UNPROCESSABLE_CONTENT'
  | 'TASK_MIRRORED'
  | 'MILESTONE_MIRRORED'
  | 'PROJECT_MIRRORED'
  | 'PROJECT_NOT_EMPTY'
  | 'BACKLOG_PAUSED'
  | 'BACKLOG_DETACHED'
  | 'WORKSPACE_CREATION_OFF'
  | 'SLUG_TAKEN'
  | 'SLUG_RESERVED'
  | 'LAST_OWNER'
>;

export abstract class CoreError extends Error {
  abstract readonly code: CoreErrorCode;
  /** Field-level problems, for Invalid. */
  readonly issues?: ProblemIssue[];

  constructor(message: string, options?: { issues?: ProblemIssue[]; cause?: unknown }) {
    super(message, options?.cause === undefined ? undefined : { cause: options.cause });
    this.name = new.target.name;
    if (options?.issues) this.issues = options.issues;
  }
}

/** The resource does not exist in the caller's workspace. */
export class NotFound extends CoreError {
  readonly code = 'NOT_FOUND' as const;
}

/** The caller is a member but may not do this (role, key scope or key access). */
export class Forbidden extends CoreError {
  readonly code = 'FORBIDDEN' as const;
}

/** The change conflicts with the current state (duplicate key, renaming a project with tasks). */
export class Conflict extends CoreError {
  readonly code = 'CONFLICT' as const;
}

/**
 * A task write sent an ifUpdatedAt older than the stored task: someone else changed it meanwhile.
 * Adapters put `task` (the current version) into the problem data.
 */
export class TaskChanged extends CoreError {
  readonly code = 'TASK_CHANGED' as const;
  readonly task: Task;

  constructor(task: Task, message = `${task.key} changed since you loaded it`) {
    super(message);
    this.task = task;
  }
}

/** The input is well-formed but not acceptable (unknown assignee, project outside the workspace). */
export class Invalid extends CoreError {
  readonly code = 'UNPROCESSABLE_CONTENT' as const;

  static fromZod(error: ZodError, message = 'Invalid input'): Invalid {
    return new Invalid(message, { issues: toProblemIssues(error.issues), cause: error });
  }
}

/**
 * A write to something Backlog.md owns in a mirrored project. Adapters copy `extensions` (field,
 * file, backlogId, hint) into the problem body so the web and the CLI can say where to edit instead.
 */
abstract class MirroredError extends CoreError {
  readonly extensions: MirroredProblemExtensions;

  constructor(message: string, extensions: MirroredProblemExtensions = {}) {
    super(message);
    this.extensions = extensions;
  }
}

/** A field Backlog.md owns on a mirrored task (title, status, priority, assignee, milestone, ...). */
export class TaskMirrored extends MirroredError {
  readonly code = 'TASK_MIRRORED' as const;
}

/** A milestone of a mirrored project: created, changed or deleted in the app. */
export class MilestoneMirrored extends MirroredError {
  readonly code = 'MILESTONE_MIRRORED' as const;
}

/** A project-level change a mirror forbids, such as creating a task. */
export class ProjectMirrored extends MirroredError {
  readonly code = 'PROJECT_MIRRORED' as const;
}

/** Mirror or import setup on a project that already has tasks. */
export class ProjectNotEmpty extends CoreError {
  readonly code = 'PROJECT_NOT_EMPTY' as const;
}

/** A refresh asked for while the mirror is paused (connection missing, rejected or unreachable). */
export class BacklogPaused extends CoreError {
  readonly code = 'BACKLOG_PAUSED' as const;
}

/** A mirror action on a source that was detached. */
export class BacklogDetached extends CoreError {
  readonly code = 'BACKLOG_DETACHED' as const;
}

// 0.10: workspaces. These reach the web app's workspace server functions, not /api/v1.

/** The creation policy (WORKSPACE_CREATION=owners) does not let this person create a workspace (403). */
export class WorkspaceCreationOff extends CoreError {
  readonly code = 'WORKSPACE_CREATION_OFF' as const;
}

/** A slug another workspace uses, or holds as an old slug within the reuse window (409). */
export class SlugTaken extends CoreError {
  readonly code = 'SLUG_TAKEN' as const;
}

/** A slug from WORKSPACE_SLUG_RESERVED (400). */
export class SlugReserved extends CoreError {
  readonly code = 'SLUG_RESERVED' as const;
}

/** Leaving, removing or demoting the last owner of a workspace (409). */
export class LastOwner extends CoreError {
  readonly code = 'LAST_OWNER' as const;
}

/**
 * A person who is the responsible human of agents in the workspace leaving it or being removed
 * (409 CONFLICT). `agents` lists them, and each one is also an issue on path `agents` with the
 * agent's name as its message, so clients that only read issues can list them too.
 */
export class ResponsibleForAgents extends Conflict {
  readonly agents: UserRef[];

  constructor(message: string, agents: UserRef[]) {
    super(message, { issues: agents.map((agent) => ({ path: 'agents', message: agent.name })) });
    this.agents = agents;
  }
}

// M8: waves and gates. Adapters read the contract code with problemCodeOf() (relations.ts).

/**
 * An agent starting a task (Backlog or Todo to In progress or In review, or creating it there) in
 * a locked wave (409 WAVE_LOCKED). `waveLock` names the task, its wave and the earlier wave whose
 * gate it waits for; `hint` is the command that shows the plan. In a bulk change the issues name
 * each refused task and `waveLock` the first one. People are never refused, and system moves never
 * are.
 */
export class WaveLocked extends Conflict {
  readonly problemCode = 'WAVE_LOCKED' as const;
  readonly waveLock: ProblemWaveLock;
  readonly hint: string;

  constructor(
    message: string,
    waveLock: ProblemWaveLock,
    hint: string,
    options?: { issues?: ProblemIssue[] },
  ) {
    super(message, options);
    this.waveLock = waveLock;
    this.hint = hint;
  }
}

/**
 * Passing a gate while tasks of its wave are neither Done nor Canceled (409 GATE_TASKS_OPEN).
 * `openKeys` lists them, at most MAX_WAVE_OPEN_KEYS.
 */
export class GateTasksOpen extends Conflict {
  readonly problemCode = 'GATE_TASKS_OPEN' as const;
  readonly openKeys: string[];

  constructor(message: string, openKeys: string[]) {
    super(message);
    this.openKeys = openKeys;
  }
}

/** The mirrored-problem extensions of an error, or undefined for other errors. */
export function mirroredExtensions(error: unknown): MirroredProblemExtensions | undefined {
  return error instanceof MirroredError ? error.extensions : undefined;
}

export function isCoreError(error: unknown): error is CoreError {
  return error instanceof CoreError;
}

/** Parses `value` with `schema`, turning a ZodError into Invalid. */
export function parseInput<T>(schema: { parse: (value: unknown) => T }, value: unknown): T {
  try {
    return schema.parse(value);
  } catch (error) {
    if (error instanceof ZodError) throw Invalid.fromZod(error);
    throw error;
  }
}

/** The Postgres error behind a Drizzle error, if any. */
function pgError(error: unknown): { code?: string; constraint?: string } | null {
  let current: unknown = error;
  for (let depth = 0; current && depth < 5; depth++) {
    if (typeof current === 'object' && current !== null && 'code' in current) {
      const { code, constraint } = current as { code?: unknown; constraint?: unknown };
      if (typeof code === 'string' && /^[0-9A-Z]{5}$/.test(code)) {
        return { code, constraint: typeof constraint === 'string' ? constraint : undefined };
      }
    }
    current = (current as { cause?: unknown }).cause;
  }
  return null;
}

/** True for a unique violation, optionally on a named constraint or index. */
export function isUniqueViolation(error: unknown, constraint?: string): boolean {
  const pg = pgError(error);
  return pg?.code === '23505' && (constraint === undefined || pg.constraint === constraint);
}
