import type { TaskOwnedField } from '@zamu/contracts';
import { bulkRefusal, type CachedTask } from '~/features/tasks/queries';

// What a picker or a task key acts on: one task (the open or focused one) or a selection. Mirrored
// tasks are read-only for the fields Backlog.md owns; a selection changes in one go only when every
// task is native (design call 1).

/** A task as a screen holds it: the detail, a list row, a board card, a Home row. */
export type FieldTarget = CachedTask;

/** The fields the pickers set. */
export type TaskFieldKey =
  | 'status'
  | 'priority'
  | 'assignee'
  | 'labels'
  | 'dueDate'
  | 'milestone'
  | 'cycle'
  | 'blockedBy'
  | 'subtasks'
  | 'parent'
  | 'checkAgain';

/** The owned field behind each picker: subtasks are the children's parent field. Cycles are app-side. */
const OWNED: Record<TaskFieldKey, TaskOwnedField | null> = {
  status: 'status',
  priority: 'priority',
  assignee: 'assignee',
  labels: 'labels',
  dueDate: 'dueDate',
  milestone: 'milestone',
  cycle: null,
  blockedBy: 'blockedBy',
  subtasks: 'parent',
  parent: 'parent',
  // M7: not a Backlog.md field, so mirrored tasks may hold one.
  checkAgain: null,
};

/** The lock tooltip of a read-only field. */
export const READ_ONLY_TEXT = 'Read-only: fields come from Backlog.md';

/** M7: an archived task refuses every change but restore. */
export const ARCHIVED_TEXT = 'Archived: restore the task to change it.';

/** M7: archived tasks are read-only (the server answers TASK_ARCHIVED). */
export const isArchivedTarget = (target: FieldTarget) => target.archivedAt != null;

export function toTargets(targets: FieldTarget | readonly FieldTarget[] | null | undefined): FieldTarget[] {
  if (!targets) return [];
  return Array.isArray(targets) ? [...targets] : [targets as FieldTarget];
}

/** "PAY-142", or "3 selected": who an action applies to (the palette's context pill). */
export function contextOf(targets: readonly FieldTarget[]): string {
  if (targets.length === 1) return targets[0]?.key ?? '';
  return `${targets.length} selected`;
}

/** "PAY-142" or "3 tasks", inside sentences. */
export function subjectOf(targets: readonly { key: string }[]): string {
  return targets.length === 1 ? (targets[0]?.key ?? '') : `${targets.length} tasks`;
}

export const isMirroredTarget = (target: FieldTarget) => (target.locked?.length ?? 0) > 0;

/** True when Backlog.md owns the field on any target. */
export function isFieldLocked(targets: readonly FieldTarget[], field: TaskFieldKey): boolean {
  const owned = OWNED[field];
  return owned != null && targets.some((target) => target.locked?.includes(owned));
}

/** Projects of the targets, in order of first appearance. */
export function projectKeysOf(targets: readonly FieldTarget[]): string[] {
  return [...new Set(targets.map((target) => target.project.key))];
}

/**
 * Why a field can't change for these targets, or null when it can. Archived tasks (M7): nothing changes.
 * One task: its locked fields (the picker still opens, read-only). Several: bulk rules; milestones and
 * cycles need one project; subtasks need one parent; a parent and a check-again day are set on one task.
 */
export function fieldRefusal(targets: readonly FieldTarget[], field: TaskFieldKey): string | null {
  if (targets.length === 0) return 'Select a task first';
  const archived = targets.filter(isArchivedTarget).length;
  if (archived > 0) {
    return targets.length === 1
      ? ARCHIVED_TEXT
      : `${archived} of ${targets.length} selected tasks are archived. Restore them to change them.`;
  }
  if (targets.length === 1) return isFieldLocked(targets, field) ? READ_ONLY_TEXT : null;
  if (field === 'checkAgain') return 'A check-again day is set on one task at a time. Select one task.';
  if (field === 'subtasks') return 'Subtasks need one parent. Select one task.';
  if (field === 'parent') return 'A parent is set on one task at a time. Select one task.';
  if (field === 'blockedBy') return 'Blockers are added to one task at a time. Select one task.';
  const bulk = bulkRefusal(targets);
  if (bulk) return bulk;
  if ((field === 'milestone' || field === 'cycle') && projectKeysOf(targets).length > 1) {
    return `Select tasks of one project to set a ${field}.`;
  }
  return null;
}
