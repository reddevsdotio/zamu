// The work-record flags of zamu tasks create and update (M6), named as in the Backlog.md CLI so
// agents keep the flags they know: --ac, --check-ac, --dod, --plan, --final-summary and the rest.
// They turn into the item operations of one request; numbers are the items' numbers before it.

import type { WorkItemKind } from '@zamu/contracts';
import { InvalidArgumentError } from 'commander';
import type { CommandContext } from '../context';
import { usageError } from '../errors';

/** Commander collector for repeatable text values kept as typed (commas included): --ac, --dod. */
export function collectTexts(value: string, previous: string[] = []): string[] {
  return [...previous, value];
}

/** Item numbers in one flag value: "3" or "1,2,5". */
export function parseItemNumbers(value: string): number[] {
  const parts = value
    .split(',')
    .map((part) => part.trim())
    .filter(Boolean);
  if (parts.length === 0 || parts.some((part) => !/^\d+$/.test(part) || Number(part) < 1)) {
    throw new InvalidArgumentError('Use item numbers from 1, e.g. 2 or 1,3.');
  }
  return parts.map(Number);
}

/** Commander collector for repeatable, comma-separated item numbers: --check-ac 1 --check-ac 2,3. */
export function collectNumbers(value: string, previous: number[] = []): number[] {
  return [...previous, ...parseItemNumbers(value)];
}

/** --waive-ac, --waive-dod and --reason in the order they were typed. */
export type WaiveToken =
  | { type: 'waive'; kind: WorkItemKind; number: number }
  | { type: 'reason'; text: string };

/**
 * Collectors for --waive-ac N, --waive-dod N and --reason, sharing one list so the order survives
 * parsing. Create one per command invocation.
 */
export function waiveCollector() {
  const tokens: WaiveToken[] = [];
  return {
    tokens,
    waive:
      (kind: WorkItemKind) =>
      (value: string): WaiveToken[] => {
        for (const number of parseItemNumbers(value)) tokens.push({ type: 'waive', kind, number });
        return tokens;
      },
    reason: (value: string): WaiveToken[] => {
      tokens.push({ type: 'reason', text: value });
      return tokens;
    },
  };
}

export interface ResolvedWaives {
  criteria: { number: number; reason: string }[];
  done: { number: number; reason: string }[];
}

/**
 * Pairs waives with reasons. A --reason applies to the waives typed before it that have none yet;
 * waives after the last --reason take that last reason. So `--waive-ac 5 --reason "..."`,
 * `--reason "..." --waive-ac 5` and `--waive-ac 4 --waive-ac 5 --reason "..."` all work.
 */
export function resolveWaives(tokens: readonly WaiveToken[]): ResolvedWaives {
  const result: ResolvedWaives = { criteria: [], done: [] };
  const waives = tokens.filter((token) => token.type === 'waive');
  if (waives.length === 0) {
    if (tokens.length) throw usageError('--reason goes with --waive-ac N or --waive-dod N.');
    return result;
  }
  let pending: Extract<WaiveToken, { type: 'waive' }>[] = [];
  let last: string | undefined;
  const settle = (reason: string) => {
    for (const waive of pending) {
      (waive.kind === 'criterion' ? result.criteria : result.done).push({ number: waive.number, reason });
    }
    pending = [];
  };
  for (const token of tokens) {
    if (token.type === 'waive') pending.push(token);
    else {
      settle(token.text);
      last = token.text;
    }
  }
  if (pending.length) {
    if (last === undefined) {
      const first = pending[0] as (typeof pending)[number];
      const flag = first.kind === 'criterion' ? '--waive-ac' : '--waive-dod';
      throw usageError(`${flag} ${first.number} needs a reason: add --reason "why it no longer applies".`);
    }
    settle(last);
  }
  return result;
}

/** The text flags that take "-" for stdin. */
export interface TextFlags {
  description?: string;
  plan?: string;
  finalSummary?: string;
  appendNotes?: string[];
}

/** Refuses more than one flag reading stdin: there is only one stdin to read. */
export function checkStdinFlags(flags: TextFlags): void {
  const readers = [
    flags.description === '-' ? '--description' : null,
    flags.plan === '-' ? '--plan' : null,
    flags.finalSummary === '-' ? '--final-summary' : null,
    ...(flags.appendNotes ?? []).map((note) => (note === '-' ? '--append-notes' : null)),
  ].filter(Boolean);
  if (readers.length > 1) {
    throw usageError(
      `Only one flag can read stdin ("-"); got ${readers.join(', ')}. Pass the others as text.`,
    );
  }
}

/** Reads a "-" value from stdin, once. Other values pass through. */
export function stdinReader(context: CommandContext): (value: string) => Promise<string> {
  let read: Promise<string> | undefined;
  return (value) => {
    if (value !== '-') return Promise.resolve(value);
    read ??= context.io.readStdin();
    return read;
  };
}

export interface CreateWorkOptions {
  ac?: string[];
  dod?: string[];
  /** false with --no-dod-defaults. */
  dodDefaults?: boolean;
  plan?: string;
}

/** The work-record fields of POST /tasks. */
export async function createWorkFields(
  options: CreateWorkOptions,
  read: (value: string) => Promise<string>,
): Promise<Record<string, unknown>> {
  return {
    ...(options.ac?.length ? { criteria: options.ac } : {}),
    ...(options.dod?.length ? { doneItems: options.dod } : {}),
    ...(options.dodDefaults === false ? { skipDefaultDoneItems: true } : {}),
    ...(options.plan !== undefined ? { plan: await read(options.plan) } : {}),
  };
}

export interface UpdateWorkOptions {
  ac?: string[];
  checkAc?: number[];
  uncheckAc?: number[];
  removeAc?: number[];
  unwaiveAc?: number[];
  dod?: string[];
  checkDod?: number[];
  uncheckDod?: number[];
  removeDod?: number[];
  unwaiveDod?: number[];
  plan?: string;
  finalSummary?: string;
}

const listed = <T>(name: string, values: T[] | undefined) => (values?.length ? { [name]: values } : {});

/** The work-record fields of PATCH /tasks/{key}: item operations, plan and final summary. */
export async function updateWorkFields(
  options: UpdateWorkOptions,
  waives: ResolvedWaives,
  read: (value: string) => Promise<string>,
): Promise<Record<string, unknown>> {
  return {
    ...listed('addCriteria', options.ac),
    ...listed('checkCriteria', options.checkAc),
    ...listed('uncheckCriteria', options.uncheckAc),
    ...listed('waiveCriteria', waives.criteria),
    ...listed('unwaiveCriteria', options.unwaiveAc),
    ...listed('removeCriteria', options.removeAc),
    ...listed('addDoneItems', options.dod),
    ...listed('checkDoneItems', options.checkDod),
    ...listed('uncheckDoneItems', options.uncheckDod),
    ...listed('waiveDoneItems', waives.done),
    ...listed('unwaiveDoneItems', options.unwaiveDod),
    ...listed('removeDoneItems', options.removeDod),
    ...(options.plan !== undefined ? { plan: await read(options.plan) } : {}),
    ...(options.finalSummary !== undefined ? { finalSummary: await read(options.finalSummary) } : {}),
  };
}

/** Whether the update touches the item lists (then the summary prints them). */
export function touchesItems(fields: Record<string, unknown>): boolean {
  return Object.keys(fields).some((name) => /Criteria$|DoneItems$/.test(name));
}
