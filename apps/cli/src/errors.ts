// Every failure the CLI reports becomes a CliError: a Problem (printed as zamu.v1.error with --json)
// plus the process exit code. Scripts and agents branch on the exit code, so it is part of the
// stable interface:
//   0 ok, 1 usage (OPEN_ITEMS included), 2 auth, 3 not found, 4 forbidden, 5 server,
//   6 Backlog.md conflict, 7 queued while the server was unreachable (queue.ts).
import { ORPCError } from '@orpc/client';
import {
  isMirroredProblemCode,
  type MirroredProblemExtensions,
  PROBLEM_CODES,
  type Problem,
  type ProblemCode,
  type ProblemIssue,
  problem,
  toProblemIssues,
} from '@zamu/contracts';
import { ZodError } from 'zod';

export const EXIT = {
  ok: 0,
  usage: 1,
  auth: 2,
  notFound: 3,
  forbidden: 4,
  server: 5,
  /**
   * M3: the write conflicts with a Backlog.md mirror (TASK_MIRRORED, MILESTONE_MIRRORED,
   * PROJECT_MIRRORED, PROJECT_NOT_EMPTY, and from M5 LABEL_MIRRORED) or the mirror cannot refresh
   * (BACKLOG_PAUSED, BACKLOG_DETACHED). Other 409s (CONFLICT, TASK_CHANGED, LABEL_EXISTS,
   * DEPENDENCY_LOOP, SUBTASK_DEPTH) keep exit code 1, as in v1.
   */
  conflict: 6,
} as const;

export type ExitCode = (typeof EXIT)[keyof typeof EXIT];

export class CliError extends Error {
  readonly problem: Problem;
  readonly exitCode: ExitCode;
  /** Extra lines printed under the message in human output (hints, issue lists). */
  readonly hints: string[];
  /**
   * The whole human rendering, when the error has its own layout (the Backlog.md mirror errors).
   * Replaces `zamu: <message>` and the hints.
   */
  lines?: string[];

  constructor(problemBody: Problem, exitCode: ExitCode, hints: string[] = [], message?: string) {
    super(message ?? problemBody.detail ?? problemBody.title);
    this.name = 'CliError';
    this.problem = problemBody;
    this.exitCode = exitCode;
    this.hints = hints;
  }
}

/** Exit code for an HTTP status (Problem status or raw response status). */
export function exitCodeForStatus(status: number): ExitCode {
  if (status === 401) return EXIT.auth;
  if (status === 403) return EXIT.forbidden;
  if (status === 404) return EXIT.notFound;
  if (status >= 500) return EXIT.server;
  return EXIT.usage;
}

/** A mistake in how the command was called (bad flag value, missing argument). */
export function usageError(detail: string, issues?: ProblemIssue[], hints: string[] = []): CliError {
  return new CliError(problem('BAD_REQUEST', detail, issues?.length ? { issues } : {}), EXIT.usage, hints);
}

/** No credentials, or credentials the server refused. */
export function authError(detail: string, hints: string[] = []): CliError {
  return new CliError(problem('UNAUTHORIZED', detail), EXIT.auth, hints);
}

export function notFoundError(detail: string, hints: string[] = []): CliError {
  return new CliError(problem('NOT_FOUND', detail), EXIT.notFound, hints);
}

/** The server could not be reached or answered with something the contract does not describe. */
export function serverError(detail: string, status = 500): CliError {
  return new CliError({ ...problem('INTERNAL_SERVER_ERROR', detail), status }, EXIT.server);
}

/** Validation failure of command input against a contract schema (before anything is sent). */
export function inputError(error: ZodError, detail = 'Invalid arguments'): CliError {
  const issues = toProblemIssues(error.issues);
  return usageError(
    detail,
    issues,
    issues.map((issue) => (issue.path ? `${issue.path}: ${issue.message}` : issue.message)),
  );
}

const PROBLEM_CODE_SET = new Set<string>(PROBLEM_CODES);

/** Problem codes that exit with EXIT.conflict. */
const BACKLOG_CONFLICT_CODES = new Set<string>([
  'TASK_MIRRORED',
  'MILESTONE_MIRRORED',
  'PROJECT_MIRRORED',
  'PROJECT_NOT_EMPTY',
  'LABEL_MIRRORED',
  'BACKLOG_PAUSED',
  'BACKLOG_DETACHED',
] satisfies ProblemCode[]);

/** The mirrored-problem extensions in error data that are strings. */
function mirroredExtensions(data: Record<string, unknown> | undefined): MirroredProblemExtensions {
  const out: MirroredProblemExtensions = {};
  for (const name of ['field', 'file', 'backlogId', 'hint'] as const) {
    const value = data?.[name];
    if (typeof value === 'string') out[name] = value;
  }
  return out;
}

export interface MirroredContext {
  /** The task's app key (PAY-786), for the "still allowed here" commands. */
  taskKey?: string;
  /** The default branch the file lives on. */
  branch?: string | null;
  /** Whether the project uses cycles (default true) and the cycle to suggest. */
  usesCycles?: boolean;
  cycle?: number | null;
}

/**
 * Human text of a *_MIRRORED problem, built from its fields:
 *
 *   error: PAY-786 is mirrored from Backlog.md, so its status can't change here (task_mirrored).
 *     file:  backlog/tasks/back-786 - Retry-failed-webhook-deliveries.md (main)
 *     edit the file and push, or run: backlog task edit 786 -s Done
 *     still allowed here: comments (zamu comments add PAY-786) and cycles (zamu tasks update PAY-786 --cycle 4)
 *
 * The file line needs `file`; the hint line reads "edit the file and push, or run:" when the hint
 * is a Backlog.md command and there is a file, "run:" without a file, and the hint as written when
 * it is a sentence. The last line is for TASK_MIRRORED with a known task key.
 */
export function mirroredLines(body: Problem, context: MirroredContext = {}): string[] {
  const detail = (body.detail ?? body.title).trim().replace(/\.$/, '');
  const lines = [`error: ${detail} (${body.code.toLowerCase()}).`];
  if (body.file) lines.push(`  file:  ${body.file}${context.branch ? ` (${context.branch})` : ''}`);
  if (body.hint) {
    const command = /^backlog\s/.test(body.hint);
    if (!command) lines.push(`  ${body.hint}`);
    else if (body.file) lines.push(`  edit the file and push, or run: ${body.hint}`);
    else lines.push(`  run: ${body.hint}`);
  }
  if (body.code === 'TASK_MIRRORED' && context.taskKey) {
    const key = context.taskKey;
    const allowed = [`comments (zamu comments add ${key})`];
    if (context.usesCycles !== false) {
      allowed.push(`cycles (zamu tasks update ${key} --cycle ${context.cycle ?? '<number>'})`);
    }
    lines.push(`  still allowed here: ${allowed.join(' and ')}`);
  }
  return lines;
}

/** What OPEN_ITEMS needs from the command to print the flags that settle each item. */
export interface OpenItemsContext {
  /** The task as the command named it (PAY-142). */
  taskKey?: string;
  /** The status the command asked for (in_review), to repeat the move. */
  status?: string;
}

/**
 * Human text of an OPEN_ITEMS refusal: each open item with the flags that check or waive it, then
 * the move to run again once they are settled.
 *
 *   zamu: PAY-142 has open items, so it can't move to In review yet (open_items).
 *     criterion 3  Refunds post a ledger entry
 *       check: --check-ac 3   waive: --waive-ac 3 --reason "..."
 *     Check only what is proven and waive the rest with a reason. One command can settle them and move it:
 *       zamu tasks update PAY-142 <flags above> --status in_review
 */
export function openItemsLines(body: Problem, context: OpenItemsContext = {}): string[] {
  const detail = (body.detail ?? body.title).trim().replace(/\.$/, '');
  const lines = [`zamu: ${detail} (${body.code.toLowerCase()}).`];
  const items = body.openItems ?? [];
  const width = Math.max(
    0,
    ...items.map((item) => `${item.kind === 'criterion' ? 'criterion' : 'done item'} ${item.number}`.length),
  );
  for (const item of items) {
    const flag = item.kind === 'criterion' ? 'ac' : 'dod';
    const label = `${item.kind === 'criterion' ? 'criterion' : 'done item'} ${item.number}`;
    lines.push(`  ${label.padEnd(width)}  ${item.text}`);
    lines.push(
      `  ${' '.repeat(width)}  check: --check-${flag} ${item.number}   waive: --waive-${flag} ${item.number} --reason "..."`,
    );
  }
  const key = context.taskKey ?? 'KEY';
  const status = context.status ? ` --status ${context.status}` : '';
  lines.push(
    '  Check only what is proven and waive the rest with a reason. One command can settle them and move it:',
  );
  lines.push(`    zamu tasks update ${key} <flags above>${status}`);
  return lines;
}

function errorChain(error: unknown): string {
  const parts: string[] = [];
  let current: unknown = error;
  for (let depth = 0; current instanceof Error && depth < 4; depth++) {
    // Node reports a refused connection as an AggregateError (one error per address) with no message.
    const inner: Error =
      current instanceof AggregateError && !current.message && current.errors[0] instanceof Error
        ? current.errors[0]
        : current;
    const code = (inner as { code?: unknown }).code;
    const message = inner.message || (typeof code === 'string' ? code : inner.name);
    parts.push(typeof code === 'string' && !message.includes(code) ? `${message} (${code})` : message);
    current = inner.cause;
  }
  return parts.join(': ');
}

/** Turns whatever a command threw into a CliError. `url` names the server in network errors. */
export function toCliError(error: unknown, url?: string): CliError {
  if (error instanceof CliError) return error;

  if (error instanceof ORPCError) {
    const status = typeof error.status === 'number' ? error.status : 500;
    const code: ProblemCode = PROBLEM_CODE_SET.has(error.code)
      ? (error.code as ProblemCode)
      : status >= 500
        ? 'INTERNAL_SERVER_ERROR'
        : 'BAD_REQUEST';
    const data = error.data as
      | ({ requestId?: unknown; issues?: unknown; task?: unknown } & Record<string, unknown>)
      | undefined;
    const requestId = typeof data?.requestId === 'string' ? data.requestId : undefined;
    const issues = Array.isArray(data?.issues) ? (data.issues as ProblemIssue[]) : undefined;
    // TASK_CHANGED carries the task as it is now. decodeProblem already validated it.
    const task = code === 'TASK_CHANGED' && data?.task ? (data.task as Problem['task']) : undefined;
    // DEPENDENCY_LOOP names both ends of the refused link (M5).
    const loop = code === 'DEPENDENCY_LOOP' && data?.loop ? (data.loop as Problem['loop']) : undefined;
    // OPEN_ITEMS lists what is still open (M6).
    const openItems =
      code === 'OPEN_ITEMS' && Array.isArray(data?.openItems)
        ? (data.openItems as NonNullable<Problem['openItems']>)
        : undefined;
    const body: Problem = {
      ...problem(code, error.message || undefined, {
        ...(requestId ? { requestId } : {}),
        ...(issues?.length ? { issues } : {}),
        ...(task ? { task } : {}),
        ...mirroredExtensions(data),
      }),
      ...(loop ? { loop } : {}),
      ...(openItems ? { openItems } : {}),
      status: status >= 400 && status <= 599 ? status : 500,
    };
    if (BACKLOG_CONFLICT_CODES.has(code)) {
      const failure = new CliError(body, EXIT.conflict, requestId ? [`Request id: ${requestId}`] : []);
      if (isMirroredProblemCode(code)) failure.lines = mirroredLines(body);
      return failure;
    }
    // An issue that only repeats the message (a conflict on one field) adds nothing to it.
    const hints = (issues ?? [])
      .filter((issue) => issue.message !== error.message)
      .map((issue) => (issue.path ? `${issue.path}: ${issue.message}` : issue.message));
    if (requestId) hints.push(`Request id: ${requestId}`);
    // The server's 401 text speaks to HTTP clients; people at a terminal get the CLI's version.
    const message =
      status === 401
        ? 'The server did not accept the API key. It may be revoked, expired or mistyped.'
        : undefined;
    if (status === 401) hints.unshift('Run zamu login --key <key> with a valid key, or fix ZAMU_KEY.');
    // 0.10: the request named a workspace (x-zamu-workspace) the key or its user can't use.
    if (code === 'WORKSPACE_MISMATCH') {
      hints.unshift(
        'The key is for another workspace than the one named. zamu workspaces lists your logins; ' +
          'zamu login --key <key> stores a key for that workspace.',
      );
    }
    if (code === 'NOT_A_MEMBER') {
      hints.unshift('zamu workspaces lists your logins; ask an owner of that workspace for an invitation.');
    }
    return new CliError(body, exitCodeForStatus(status), hints, message);
  }

  if (error instanceof ZodError) {
    // A response that does not match the contract: the server and the CLI disagree on the API.
    return serverError(
      `The server sent a response this version of zamu does not understand: ${error.issues[0]?.message ?? 'invalid data'}`,
    );
  }

  if (error instanceof TypeError && /fetch failed|Failed to fetch|NetworkError/i.test(error.message)) {
    return serverError(`Could not reach ${url ?? 'the server'}: ${errorChain(error.cause ?? error)}`, 503);
  }

  return serverError(errorChain(error) || 'Unexpected error');
}
