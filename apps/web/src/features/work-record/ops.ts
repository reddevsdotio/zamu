import type {
  Task,
  TaskListItem,
  TaskStatus,
  UpdateTaskInput,
  UserRef,
  WorkItem,
  WorkItemKind,
  WorkItemProgress,
} from '@zamu/contracts';
import type { z } from 'zod';

// The work record's pure rules on the client: the item operations of PATCH /tasks/{key} applied to a
// cached task (for optimistic edits, in the order the server applies them), progress counts, the open
// items a person is warned about, and the words the screens use for a plan and a list of done items.

/** One list's operations. Numbers refer to the list as it was before the request. */
export interface ItemOps {
  add?: string[];
  check?: number[];
  uncheck?: number[];
  waive?: { number: number; reason: string }[];
  unwaive?: number[];
  edit?: { number: number; text: string }[];
  move?: { from: number; to: number }[];
  remove?: number[];
}

/** A change to a task's work record: one request to PATCH /tasks/{key}. */
export interface WorkPatch {
  criteria?: ItemOps;
  doneItems?: ItemOps;
  /** Markdown; null clears it. */
  plan?: string | null;
  /** Markdown; null clears it. */
  finalSummary?: string | null;
}

/** The list of a task an item kind lives in. */
export const LIST_OF: Record<WorkItemKind, 'criteria' | 'doneItems'> = {
  criterion: 'criteria',
  done: 'doneItems',
};

const OPERATION_NAMES = ['add', 'check', 'uncheck', 'waive', 'unwaive', 'edit', 'move', 'remove'] as const;

type UpdateInput = z.input<typeof UpdateTaskInput>;

/** The tasks.update input for a work-record change. */
export function toWorkInput(key: string, patch: WorkPatch): UpdateInput {
  const input: Record<string, unknown> = { key };
  const lists = [
    ['Criteria', patch.criteria],
    ['DoneItems', patch.doneItems],
  ] as const;
  for (const [suffix, ops] of lists) {
    if (!ops) continue;
    for (const name of OPERATION_NAMES) {
      const value = ops[name];
      if (value?.length) input[`${name}${suffix}`] = value;
    }
  }
  if (patch.plan !== undefined) input.plan = patch.plan;
  if (patch.finalSummary !== undefined) input.finalSummary = patch.finalSummary;
  return input as UpdateInput;
}

/** One list after its operations, renumbered from 1. `by` is who waives (the signed-in person). */
export function applyItemOps(items: readonly WorkItem[], ops: ItemOps, by: UserRef | null): WorkItem[] {
  const byNumber = new Map(items.map((item) => [item.number, { ...item }]));
  const open = (item: WorkItem) => Object.assign(item, { state: 'open', waivedReason: null, waivedBy: null });
  for (const edit of ops.edit ?? []) {
    const item = byNumber.get(edit.number);
    if (item) item.text = edit.text;
  }
  for (const number of ops.check ?? []) {
    const item = byNumber.get(number);
    if (item) Object.assign(item, { state: 'checked', waivedReason: null, waivedBy: null });
  }
  for (const number of ops.uncheck ?? []) {
    const item = byNumber.get(number);
    if (item?.state === 'checked') open(item);
  }
  for (const waive of ops.waive ?? []) {
    const item = byNumber.get(waive.number);
    if (item) Object.assign(item, { state: 'waived', waivedReason: waive.reason, waivedBy: by });
  }
  for (const number of ops.unwaive ?? []) {
    const item = byNumber.get(number);
    if (item?.state === 'waived') open(item);
  }
  const removed = new Set(ops.remove ?? []);
  const list = items
    .filter((item) => !removed.has(item.number))
    .map((item) => byNumber.get(item.number) ?? item);
  for (const move of ops.move ?? []) {
    const from = move.from - 1;
    const to = Math.min(Math.max(move.to - 1, 0), list.length - 1);
    const [item] = list.splice(from, 1);
    if (item) list.splice(to, 0, item);
  }
  const locked = items[0]?.locked ?? false;
  for (const text of ops.add ?? []) {
    list.push({ number: 0, text, state: 'open', waivedReason: null, waivedBy: null, locked });
  }
  return list.map((item, index) => ({ ...item, number: index + 1 }));
}

/** Counts of one list, as list items carry them. */
export function progressOf(items: readonly Pick<WorkItem, 'state'>[] | undefined): WorkItemProgress {
  const list = items ?? [];
  const waived = list.filter((item) => item.state === 'waived').length;
  const checked = list.filter((item) => item.state === 'checked').length;
  return { settled: checked + waived, open: list.length - checked - waived, waived, total: list.length };
}

const isFullTask = (item: Task | TaskListItem): item is Task => 'createdBy' in item;

/**
 * A cached task with a work-record change applied: the lists and texts on a full task, the counts on a
 * row. `full` is the task detail after the change, when it is cached (rows have no lists of their own).
 */
export function applyWorkPatch<T extends Task | TaskListItem>(
  item: T,
  patch: WorkPatch,
  by: UserRef | null,
  full?: Task,
): T {
  if (isFullTask(item)) {
    const next: Task = { ...item };
    if (patch.criteria) next.criteria = applyItemOps(item.criteria ?? [], patch.criteria, by);
    if (patch.doneItems) next.doneItems = applyItemOps(item.doneItems ?? [], patch.doneItems, by);
    if (patch.plan !== undefined) next.plan = patch.plan || null;
    if (patch.finalSummary !== undefined) next.finalSummary = patch.finalSummary || null;
    return next as T;
  }
  if (!full) return item;
  const after = applyWorkPatch(full, patch, by);
  return {
    ...item,
    criteriaProgress: progressOf(after.criteria),
    doneProgress: progressOf(after.doneItems),
    hasFinalSummary: Boolean(after.finalSummary),
  };
}

// ---------------------------------------------------------------------------
// Finishing
// ---------------------------------------------------------------------------

/** The statuses a person is warned about when items are still open. */
export const FINISHING: readonly TaskStatus[] = ['in_review', 'done'];

export interface OpenItem {
  kind: WorkItemKind;
  item: WorkItem;
}

/** Open criteria first, then open done items, each in list order. */
export function openItemsOf(task: Pick<Task, 'criteria' | 'doneItems'>): OpenItem[] {
  return [
    ...(task.criteria ?? [])
      .filter((item) => item.state === 'open')
      .map((item) => ({ kind: 'criterion' as const, item })),
    ...(task.doneItems ?? [])
      .filter((item) => item.state === 'open')
      .map((item) => ({ kind: 'done' as const, item })),
  ];
}

/** True when moving `task` to `status` should show the finishing step first. */
export function needsFinishing(task: Task, status: TaskStatus): boolean {
  if (status === task.status || !FINISHING.includes(status)) return false;
  if ((task.locked?.length ?? 0) > 0) return false;
  return openItemsOf(task).length > 0;
}

// ---------------------------------------------------------------------------
// Words
// ---------------------------------------------------------------------------

/** Plans longer than this are clipped, with "Show all N lines". */
export const PLAN_CLIP_LINES = 12;

/** Lines and top-level steps of a Markdown plan. Lines in code fences count as lines, never as steps. */
export function planSize(plan: string): { lines: number; steps: number } {
  const lines = plan.replace(/\s+$/, '').split('\n');
  let steps = 0;
  let fence: string | null = null;
  for (const line of lines) {
    const marker = /^\s*(`{3,}|~{3,})/.exec(line)?.[1];
    if (marker) {
      if (fence === null) fence = marker[0] ?? null;
      else if (marker[0] === fence) fence = null;
      continue;
    }
    if (fence === null && /^(?:\d+[.)]|[-*+])\s+\S/.test(line)) steps++;
  }
  return { lines: plan.trim() ? lines.length : 0, steps };
}

const plural = (count: number, one: string, many: string) => `${count} ${count === 1 ? one : many}`;

/** "8 steps", "60 lines" (long plans), "3 lines" (prose). */
export function planLabel(plan: string): string {
  const { lines, steps } = planSize(plan);
  if (lines > PLAN_CLIP_LINES || steps === 0) return plural(lines, 'line', 'lines');
  return plural(steps, 'step', 'steps');
}

/** True when every done item is one of the project's defaults: "from the project defaults". */
export function isFromDefaults(
  items: readonly Pick<WorkItem, 'text'>[],
  defaults: readonly string[],
): boolean {
  if (items.length === 0 || defaults.length === 0) return false;
  const known = new Set(defaults);
  return items.every((item) => known.has(item.text));
}

/** "1 waived · 1 open" next to a count. Open shows once something is settled; nothing for a fresh list. */
export function progressNote(progress: WorkItemProgress): string {
  const parts: string[] = [];
  if (progress.waived > 0) parts.push(`${progress.waived} waived`);
  if (progress.open > 0 && progress.settled > 0) parts.push(`${progress.open} open`);
  return parts.join(' · ');
}

/** First name of a person, for "claude-dev for Ana". */
export const firstName = (name: string) => name.trim().split(/\s+/)[0] ?? name;
