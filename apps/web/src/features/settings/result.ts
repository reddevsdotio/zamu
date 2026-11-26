// What settings server functions return, and how the browser turns failures back into errors.
// Server functions return failures as data instead of throwing, so the code, message and field
// issues of core's errors reach the browser intact. This module is safe for the client bundle.
import type { ProblemCode, ProblemIssue } from '@zamu/contracts';

export interface SettingsFailure {
  code: ProblemCode;
  message: string;
  issues: ProblemIssue[];
}

export type SettingsResult<T> = { ok: true; data: T } | { ok: false; error: SettingsFailure };

/**
 * The form field a problem code is about, for codes core raises without field issues: a taken or
 * reserved slug belongs under the slug field of the New workspace dialog and General settings.
 */
export const PROBLEM_FIELDS: Partial<Record<ProblemCode, string>> = {
  SLUG_TAKEN: 'slug',
  SLUG_RESERVED: 'slug',
};

/**
 * Codes that mean the request's workspace is not the person's (any more): the screen sends them to
 * `/`, which lands in a workspace they belong to.
 */
export const LEFT_WORKSPACE_CODES: readonly ProblemCode[] = ['NOT_A_MEMBER', 'WORKSPACE_MISMATCH'];

/** A failed SettingsResult. Without issues, codes in PROBLEM_FIELDS get one on their field. */
export function failure(
  code: ProblemCode,
  message: string,
  issues: ProblemIssue[] = [],
): {
  ok: false;
  error: SettingsFailure;
} {
  const field = PROBLEM_FIELDS[code];
  const withField = issues.length === 0 && field ? [{ path: field, message }] : issues;
  return { ok: false, error: { code, message, issues: withField } };
}

/** A failed settings call, thrown in the browser by `unwrap`. */
export class SettingsError extends Error {
  readonly code: ProblemCode;
  readonly issues: ProblemIssue[];

  constructor({ code, message, issues }: SettingsFailure) {
    super(message);
    this.name = 'SettingsError';
    this.code = code;
    this.issues = issues;
  }

  /** True when the person is not a member of the request's workspace: send them to `/`. */
  get leftWorkspace(): boolean {
    return LEFT_WORKSPACE_CODES.includes(this.code);
  }

  /** The message of the first issue on `path`, if any. */
  issueFor(path: string): string | undefined {
    return this.issues.find((issue) => issue.path === path || issue.path.startsWith(`${path}.`))?.message;
  }
}

/** Returns the data of a successful result, or throws SettingsError. */
export async function unwrap<T>(result: SettingsResult<T> | Promise<SettingsResult<T>>): Promise<T> {
  const settled = await result;
  if (settled.ok) return settled.data;
  throw new SettingsError(settled.error);
}

/** Human message for any error a settings screen can hit. */
export function errorMessage(error: unknown): string {
  if (error instanceof SettingsError) return error.message;
  return 'Something went wrong on the server. Try again.';
}
