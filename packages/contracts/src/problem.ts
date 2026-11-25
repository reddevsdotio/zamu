import { z } from 'zod';
import { Task, WorkItemKind } from './entities';

/**
 * Error codes shared by core, the API, the web app and the CLI. They match oRPC's common error
 * codes, so an ORPCError can be turned into a Problem (and back) by code alone.
 */
export const PROBLEM_CODES = [
  'BAD_REQUEST',
  'UNAUTHORIZED',
  'FORBIDDEN',
  'NOT_FOUND',
  'CONFLICT',
  /** A task write with an ifUpdatedAt older than the stored task. The body carries the current task. */
  'TASK_CHANGED',
  'UNPROCESSABLE_CONTENT',
  'INTERNAL_SERVER_ERROR',
  // M3: Backlog.md mirror. All 409; the body carries `field`, `file`, `backlogId` and `hint` where
  // they apply (MirroredProblemExtensions).
  /** A write to a field Backlog.md owns on a mirrored task (title, status, ...). */
  'TASK_MIRRORED',
  /** Creating, changing or deleting a milestone of a mirrored project. */
  'MILESTONE_MIRRORED',
  /** Creating a task in a mirrored project, or a project change the mirror forbids (key, milestones off). */
  'PROJECT_MIRRORED',
  /** Setting up Backlog.md on a project that already has tasks. */
  'PROJECT_NOT_EMPTY',
  /** Refreshing a mirror whose connection is missing, rejected or unreachable. */
  'BACKLOG_PAUSED',
  /** Refreshing or changing a source that was detached. */
  'BACKLOG_DETACHED',
  // M5: task fields.
  /** A label name the project has already, ignoring case (409). */
  'LABEL_EXISTS',
  /** Renaming or deleting a label that comes from Backlog.md files (409). Its colour can change. */
  'LABEL_MIRRORED',
  /**
   * A blocker that would close a loop (409): "Can't add: PAY-150 already waits on PAY-142." The
   * detail carries that sentence.
   */
  'DEPENDENCY_LOOP',
  /** A parent that is a subtask, or a subtask target that has subtasks: one level only (409). */
  'SUBTASK_DEPTH',
  /** A blocker, parent, label or bulk milestone and cycle across projects (422). */
  'NOT_SAME_PROJECT',
  // M6: the work record.
  /**
   * An agent moved a task to In review or Done while a criterion or done item is open (409). The
   * body lists them in `openItems`; people are never refused.
   */
  'OPEN_ITEMS',
] as const;
export const ProblemCode = z.enum(PROBLEM_CODES);
export type ProblemCode = z.infer<typeof ProblemCode>;

export const PROBLEM_STATUS: Record<ProblemCode, number> = {
  BAD_REQUEST: 400,
  UNAUTHORIZED: 401,
  FORBIDDEN: 403,
  NOT_FOUND: 404,
  CONFLICT: 409,
  TASK_CHANGED: 409,
  UNPROCESSABLE_CONTENT: 422,
  INTERNAL_SERVER_ERROR: 500,
  TASK_MIRRORED: 409,
  MILESTONE_MIRRORED: 409,
  PROJECT_MIRRORED: 409,
  PROJECT_NOT_EMPTY: 409,
  BACKLOG_PAUSED: 409,
  BACKLOG_DETACHED: 409,
  LABEL_EXISTS: 409,
  LABEL_MIRRORED: 409,
  DEPENDENCY_LOOP: 409,
  SUBTASK_DEPTH: 409,
  NOT_SAME_PROJECT: 422,
  OPEN_ITEMS: 409,
};

export const PROBLEM_TITLES: Record<ProblemCode, string> = {
  BAD_REQUEST: 'Bad request',
  UNAUTHORIZED: 'Not signed in',
  FORBIDDEN: 'Not allowed',
  NOT_FOUND: 'Not found',
  CONFLICT: 'Conflict',
  TASK_CHANGED: 'Task changed',
  UNPROCESSABLE_CONTENT: 'Invalid input',
  INTERNAL_SERVER_ERROR: 'Server error',
  TASK_MIRRORED: 'Field comes from Backlog.md',
  MILESTONE_MIRRORED: 'Milestone comes from Backlog.md',
  PROJECT_MIRRORED: 'Project mirrors Backlog.md',
  PROJECT_NOT_EMPTY: 'Project is not empty',
  BACKLOG_PAUSED: 'Backlog.md mirror is paused',
  BACKLOG_DETACHED: 'Backlog.md source is detached',
  LABEL_EXISTS: 'Label exists',
  LABEL_MIRRORED: 'Label comes from Backlog.md',
  DEPENDENCY_LOOP: 'Blockers would loop',
  SUBTASK_DEPTH: 'Subtasks go one level deep',
  NOT_SAME_PROJECT: 'Tasks are in different projects',
  OPEN_ITEMS: 'Task has open items',
};

/** The codes of the Backlog.md mirror rules, for clients that treat them alike. */
export const MIRRORED_PROBLEM_CODES = ['TASK_MIRRORED', 'MILESTONE_MIRRORED', 'PROJECT_MIRRORED'] as const;
export type MirroredProblemCode = (typeof MIRRORED_PROBLEM_CODES)[number];

export function isMirroredProblemCode(code: string): code is MirroredProblemCode {
  return (MIRRORED_PROBLEM_CODES as readonly string[]).includes(code);
}

/**
 * Extensions of TASK_MIRRORED, MILESTONE_MIRRORED and PROJECT_MIRRORED problems. The CLI prints
 * them as "edit <file> on the default branch" with the hint; the web shows them next to the field.
 */
export const MirroredProblemExtensions = z.object({
  /** The owned field the write touched: title, status, ... (contract names, e.g. createdAt). */
  field: z.string().optional(),
  /** Repository path of the file that owns the value, e.g. backlog/tasks/back-786 - Add webhooks.md. */
  file: z.string().optional(),
  /** The Backlog.md id of the task or milestone (BACK-786.1, m-3). */
  backlogId: z.string().optional(),
  /** What to do instead, e.g. "backlog task edit 786.1 -s \"In Progress\"". */
  hint: z.string().optional(),
});
export type MirroredProblemExtensions = z.output<typeof MirroredProblemExtensions>;

/** One failed validation rule. path is dotted (`assignee`, `scope.projects.0`); empty for the root. */
export const ProblemIssue = z.object({
  path: z.string(),
  message: z.string(),
});
export type ProblemIssue = z.infer<typeof ProblemIssue>;

/**
 * M5, DEPENDENCY_LOOP only: the two ends of the refused link, as task keys. `blocker` already waits
 * on `task` (directly or through other tasks), so `task` can't wait on `blocker`: "Can't add:
 * {blocker} already waits on {task}."
 */
export const ProblemLoop = z.object({
  task: z.string(),
  blocker: z.string(),
});
export type ProblemLoop = z.infer<typeof ProblemLoop>;

/**
 * M6, OPEN_ITEMS only: one criterion or done item still open, with its number (what --check-ac N,
 * --check-dod N and --waive-ac N take) and its text.
 */
export const OpenItem = z.object({
  kind: WorkItemKind,
  number: z.number().int().positive(),
  text: z.string(),
});
export type OpenItem = z.infer<typeof OpenItem>;

/** Extra data carried by contract errors (the `data` of an ORPCError). */
export const ProblemData = z.object({
  requestId: z.string().optional(),
  issues: z.array(ProblemIssue).optional(),
  /** TASK_CHANGED only: the task as it is now. */
  task: Task.optional(),
  /** DEPENDENCY_LOOP only: the ends of the loop. */
  loop: ProblemLoop.optional(),
  /** OPEN_ITEMS only: the open items, criteria first, each list by number. */
  openItems: z.array(OpenItem).optional(),
  ...MirroredProblemExtensions.shape,
});
export type ProblemData = z.infer<typeof ProblemData>;

/**
 * Error body of every /api/v1 response with a 4xx or 5xx status, after RFC 9457 (problem details)
 * with these extensions: `code`, `requestId`, `issues`, `task` for TASK_CHANGED, `field`, `file`,
 * `backlogId`, `hint` for the *_MIRRORED codes (M3), `loop` for DEPENDENCY_LOOP (M5), and
 * `openItems` for OPEN_ITEMS (M6). The CLI prints it under `zamu.v1.error`.
 */
export const Problem = z.object({
  type: z.string().default('about:blank'),
  title: z.string(),
  status: z.number().int().min(400).max(599),
  code: ProblemCode,
  detail: z.string().optional(),
  instance: z.string().optional(),
  requestId: z.string().optional(),
  issues: z.array(ProblemIssue).optional(),
  /** TASK_CHANGED only: the task as it is now, so the client can roll back to it. */
  task: Task.optional(),
  /** DEPENDENCY_LOOP only: the two task keys, so clients can phrase the refusal. */
  loop: ProblemLoop.optional(),
  /** OPEN_ITEMS only: what is still open, so clients can list it with the flags that settle it. */
  openItems: z.array(OpenItem).optional(),
  ...MirroredProblemExtensions.shape,
});
export type Problem = z.output<typeof Problem>;

/** Builds a Problem with the standard title and status for a code. */
export function problem(
  code: ProblemCode,
  detail?: string,
  extra: {
    requestId?: string;
    issues?: ProblemIssue[];
    instance?: string;
    task?: Problem['task'];
    openItems?: OpenItem[];
  } & MirroredProblemExtensions = {},
): Problem {
  return {
    type: 'about:blank',
    title: PROBLEM_TITLES[code],
    status: PROBLEM_STATUS[code],
    code,
    ...(detail === undefined ? {} : { detail }),
    ...extra,
  };
}

/** Converts Zod (or Standard Schema) issues into Problem issues. */
export function toProblemIssues(
  issues: readonly { path?: readonly (PropertyKey | { key: PropertyKey })[]; message: string }[],
): ProblemIssue[] {
  return issues.map((issue) => ({
    path: (issue.path ?? [])
      .map((segment) => (typeof segment === 'object' ? segment.key : segment))
      .map(String)
      .join('.'),
    message: issue.message,
  }));
}

/** JSON Schema of Problem, for OpenAPIGenerator's `customErrorResponseBodySchema` option. */
export const problemJsonSchema = (() => {
  const { $schema: _dialect, ...schema } = z.toJSONSchema(Problem, { io: 'output' });
  return schema;
})();
