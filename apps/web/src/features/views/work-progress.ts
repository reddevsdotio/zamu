import type { WorkItem, WorkItemProgress } from '@zamu/contracts';

// Criteria and done-item counts as rows, cards, the peek and Home show them (design call 7). Lists
// carry the counts (TaskListItem.criteriaProgress, doneProgress), so no row asks for more; the peek
// reads the full task and counts its items here. The number shown is the checked items, as the kit's
// ProgressMark draws it: "4 of 6" with one waived and one open.

export const NO_PROGRESS: WorkItemProgress = { settled: 0, open: 0, waived: 0, total: 0 };

/** Counts of a full task's list, the same way the server counts a list item's. */
export function progressOfItems(items: readonly Pick<WorkItem, 'state'>[] | undefined): WorkItemProgress {
  const list = items ?? [];
  const open = list.filter((item) => item.state === 'open').length;
  const waived = list.filter((item) => item.state === 'waived').length;
  return { settled: list.length - open, open, waived, total: list.length };
}

/** Checked items: settled less waived. */
export function checkedOf(progress: WorkItemProgress): number {
  return Math.max(0, progress.settled - progress.waived);
}

export type WorkItemKind = 'criteria' | 'done';

/** "criterion" or "criteria", "done item" or "done items", by the list's size. */
export function workItemNoun(kind: WorkItemKind, total: number): string {
  if (kind === 'criteria') return total === 1 ? 'criterion' : 'criteria';
  return total === 1 ? 'done item' : 'done items';
}

/** "4 of 6 criteria"; empty for a list without items. */
export function progressText(kind: WorkItemKind, progress: WorkItemProgress | undefined): string {
  if (!progress || progress.total <= 0) return '';
  return `${checkedOf(progress)} of ${progress.total} ${workItemNoun(kind, progress.total)}`;
}
