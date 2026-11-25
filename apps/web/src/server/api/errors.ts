// Turns anything a procedure throws into an ORPCError whose code, status and data match the
// contract's error map, so every transport (OpenAPI, RPC, server-side calls) reports the same thing.
import { ORPCError } from '@orpc/server';
import { PROBLEM_STATUS, type ProblemCode, ProblemData } from '@zamu/contracts';
import {
  DependencyLoop,
  isCoreError,
  mirroredExtensions,
  OpenItems,
  problemCodeOf,
  TaskChanged,
} from '@zamu/core';

function withRequestId(data: unknown, requestId: string | undefined): ProblemData {
  const parsed = ProblemData.safeParse(data);
  const base = parsed.success ? parsed.data : {};
  return requestId ? { ...base, requestId } : base;
}

/**
 * Core errors become their Problem code (NotFound 404, Forbidden 403, Conflict 409, TaskChanged 409
 * with the current task, Invalid 422, the M3 Backlog.md codes 409 with field, file, backlogId and
 * hint; the M5 codes LABEL_EXISTS, LABEL_MIRRORED, DEPENDENCY_LOOP and SUBTASK_DEPTH 409, and
 * NOT_SAME_PROJECT 422, with the field problems in issues and `loop` for DEPENDENCY_LOOP; M6
 * OPEN_ITEMS 409 with `openItems`).
 * oRPC errors (input validation 400, our own 401) keep their code and gain the request id.
 * Anything else is logged and becomes a 500 without internal details.
 */
export function toApiError(error: unknown, requestId?: string): ORPCError<string, ProblemData> {
  if (isCoreError(error)) {
    const code: ProblemCode = problemCodeOf(error);
    return new ORPCError(code, {
      status: PROBLEM_STATUS[code],
      message: error.message,
      data: {
        ...(requestId ? { requestId } : {}),
        ...(error.issues ? { issues: error.issues } : {}),
        // TASK_CHANGED carries the current task so the client can roll back to it.
        ...(error instanceof TaskChanged ? { task: error.task } : {}),
        // DEPENDENCY_LOOP names both ends so the client can phrase the refusal.
        ...(error instanceof DependencyLoop ? { loop: error.loop } : {}),
        // OPEN_ITEMS lists what is still open so the CLI can print the flags that settle it.
        ...(error instanceof OpenItems ? { openItems: error.openItems } : {}),
        // TASK_MIRRORED, MILESTONE_MIRRORED, PROJECT_MIRRORED: the file and what to do instead.
        ...mirroredExtensions(error),
      },
      cause: error,
    });
  }
  if (error instanceof ORPCError) {
    return new ORPCError(error.code, {
      status: error.status,
      message: error.message,
      data: withRequestId(error.data, requestId),
      // Keeps a ValidationError cause, which encodeProblem turns into issues.
      cause: error.cause,
    });
  }
  console.error(`api: unhandled error${requestId ? ` (request ${requestId})` : ''}:`, error);
  return new ORPCError('INTERNAL_SERVER_ERROR', {
    status: 500,
    message: 'Something went wrong on the server',
    data: withRequestId(undefined, requestId),
    cause: error,
  });
}
