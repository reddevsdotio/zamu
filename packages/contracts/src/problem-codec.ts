import { ORPCError, ValidationError } from '@orpc/contract';
import {
  type MirroredProblemExtensions,
  PROBLEM_CODES,
  PROBLEM_TITLES,
  Problem,
  type ProblemCode,
  ProblemData,
  type ProblemIssue,
  toProblemIssues,
} from './problem';

// Glue between oRPC errors and Problem bodies, so the server and every client agree on one shape.
//   Server: new OpenAPIHandler(router, { customErrorResponseBodyEncoder: (e) => encodeProblem(e) })
//   Client: new OpenAPILink(contract, { customErrorResponseBodyDecoder: (body) => decodeProblem(body) })

function isProblemCode(code: string): code is ProblemCode {
  return (PROBLEM_CODES as readonly string[]).includes(code);
}

/**
 * Turns an ORPCError into a Problem body. Unknown codes fall back by status class. Validation
 * failures (an ORPCError caused by a ValidationError) list their issues. A `task` in the error
 * data (TASK_CHANGED), a `loop` (DEPENDENCY_LOOP), `openItems` (OPEN_ITEMS) and the mirrored-problem
 * extensions (`field`, `file`, `backlogId`, `hint`) are copied into the body.
 */
export function encodeProblem(error: ORPCError<string, unknown>, requestId?: string): Problem {
  const code: ProblemCode = isProblemCode(error.code)
    ? error.code
    : error.status >= 500
      ? 'INTERNAL_SERVER_ERROR'
      : 'BAD_REQUEST';
  const data = ProblemData.safeParse(error.data);
  const issues: ProblemIssue[] | undefined =
    data.success && data.data.issues
      ? data.data.issues
      : error.cause instanceof ValidationError
        ? toProblemIssues(error.cause.issues)
        : undefined;
  const id = requestId ?? (data.success ? data.data.requestId : undefined);
  const task = data.success ? data.data.task : undefined;
  const loop = data.success ? data.data.loop : undefined;
  const openItems = data.success ? data.data.openItems : undefined;
  const mirrored = data.success ? pickMirrored(data.data) : {};
  return {
    type: 'about:blank',
    title: PROBLEM_TITLES[code],
    status: error.status,
    code,
    ...(error.message ? { detail: error.message } : {}),
    ...(id ? { requestId: id } : {}),
    ...(issues?.length ? { issues } : {}),
    ...(task ? { task } : {}),
    ...(loop ? { loop } : {}),
    ...(openItems ? { openItems } : {}),
    ...mirrored,
  };
}

/** The mirrored-problem extensions that are set, so absent ones stay absent in the body. */
function pickMirrored(source: MirroredProblemExtensions): MirroredProblemExtensions {
  const out: MirroredProblemExtensions = {};
  if (source.field !== undefined) out.field = source.field;
  if (source.file !== undefined) out.file = source.file;
  if (source.backlogId !== undefined) out.backlogId = source.backlogId;
  if (source.hint !== undefined) out.hint = source.hint;
  return out;
}

/**
 * Turns a Problem body back into a defined ORPCError carrying ProblemData. Returns null for
 * bodies that are not Problems, so OpenAPILink falls back to its default decoding.
 */
export function decodeProblem(body: unknown): ORPCError<ProblemCode, ProblemData> | null {
  const parsed = Problem.safeParse(body);
  if (!parsed.success) return null;
  const { code, status, title, detail, requestId, issues, task, loop, openItems } = parsed.data;
  const mirrored = pickMirrored(parsed.data);
  return new ORPCError(code, {
    defined: true,
    status,
    message: detail ?? title,
    data: {
      ...(requestId ? { requestId } : {}),
      ...(issues ? { issues } : {}),
      ...(task ? { task } : {}),
      ...(loop ? { loop } : {}),
      ...(openItems ? { openItems } : {}),
      ...mirrored,
    },
  });
}
