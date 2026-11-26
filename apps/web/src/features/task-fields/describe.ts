import { PRIORITY_LABELS, TASK_STATUS_LABELS } from '@zamu/contracts';
import type { BulkTaskPatch, TaskPatch } from '~/features/tasks/queries';
import { formatShortDate } from '~/ui';
import { cycleLabel } from './planning';

// The toast sentence for a change: "Moved PAY-142 to In review", "Added payouts to 3 tasks". The
// Undo toast describes the inverse patch with the same words.

/** "payouts", "payouts and api", "payouts, api and refunds". */
export function listWords(words: readonly string[]): string {
  if (words.length <= 1) return words[0] ?? '';
  return `${words.slice(0, -1).join(', ')} and ${words.at(-1)}`;
}

/** The sentence for `patch` applied to `subject` ("PAY-142" or "3 tasks"). */
export function describeChange(subject: string, patch: TaskPatch | BulkTaskPatch, today?: string): string {
  const full = patch as TaskPatch;
  const parts: string[] = [];
  if (patch.status !== undefined) parts.push(`Moved ${subject} to ${TASK_STATUS_LABELS[patch.status]}`);
  if (patch.priority !== undefined) {
    parts.push(
      patch.priority === 'none'
        ? `Cleared the priority of ${subject}`
        : `Set ${subject} to ${PRIORITY_LABELS[patch.priority]} priority`,
    );
  }
  if (patch.assignee !== undefined) {
    parts.push(patch.assignee ? `Assigned ${subject} to ${patch.assignee.name}` : `Unassigned ${subject}`);
  }
  if (patch.milestone !== undefined) {
    parts.push(
      patch.milestone
        ? `Moved ${subject} to ${patch.milestone.name}`
        : `Removed the milestone from ${subject}`,
    );
  }
  if (patch.cycle !== undefined) {
    parts.push(
      patch.cycle ? `Added ${subject} to ${cycleLabel(patch.cycle)}` : `Removed ${subject} from its cycle`,
    );
  }
  if (patch.dueDate !== undefined) {
    parts.push(
      patch.dueDate
        ? `Set ${subject} due ${formatShortDate(patch.dueDate, today)}`
        : `Cleared the due date of ${subject}`,
    );
  }
  if (full.checkAgain !== undefined) {
    parts.push(
      full.checkAgain
        ? `${subject} waits until ${formatShortDate(full.checkAgain.on, today)}`
        : `Cleared the check-again day of ${subject}`,
    );
  }
  if (full.labels !== undefined) parts.push(`Changed the labels of ${subject}`);
  if (patch.addLabels?.length) {
    parts.push(`Added ${listWords(patch.addLabels.map((label) => label.name))} to ${subject}`);
  }
  if (patch.removeLabels?.length) parts.push(`Removed ${listWords(patch.removeLabels)} from ${subject}`);
  if (full.addBlockers?.length) {
    parts.push(`${subject} now waits on ${listWords(full.addBlockers.map((task) => task.key))}`);
  }
  if (full.removeBlockers?.length) {
    parts.push(`${subject} no longer waits on ${listWords(full.removeBlockers)}`);
  }
  if (full.parent !== undefined) {
    parts.push(
      full.parent ? `Made ${subject} a subtask of ${full.parent.key}` : `Made ${subject} a top-level task`,
    );
  }
  if (full.title !== undefined) parts.push(`Renamed ${subject}`);
  if (full.description !== undefined) parts.push(`Changed the description of ${subject}`);
  if (parts.length === 0) return `Changed ${subject}`;
  // Patches from the pickers change one field; several (an Undo of an edit elsewhere) read as sentences.
  return parts.join('. ');
}
