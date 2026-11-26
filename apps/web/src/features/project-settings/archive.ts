// Pure helpers of the Archive settings page (M7 frames 081, 082): reading the number of days, the
// preview sentence ("60 tasks were finished more than 14 days ago and will be archived tonight"), the
// off-state sentence with the project's finished tasks, and how a failed save reads.
import { ORPCError } from '@orpc/client';
import { ARCHIVE_AFTER_DAYS_MAX, ARCHIVE_AFTER_DAYS_MIN, DEFAULT_ARCHIVE_AFTER_DAYS } from '@zamu/contracts';

export { DEFAULT_ARCHIVE_AFTER_DAYS };

export const DAYS_ERROR = `Use ${ARCHIVE_AFTER_DAYS_MIN} to ${ARCHIVE_AFTER_DAYS_MAX} days.`;

/** The number of days typed, or null when it is not a whole number from 1 to 365. */
export function parseDays(text: string): number | null {
  const trimmed = text.trim();
  if (!/^\d{1,3}$/.test(trimmed)) return null;
  const days = Number(trimmed);
  return days >= ARCHIVE_AFTER_DAYS_MIN && days <= ARCHIVE_AFTER_DAYS_MAX ? days : null;
}

const plural = (count: number, one: string, many: string) => (count === 1 ? one : many);

/** The preview, split so the count can be bold: { count: "60 tasks", rest: "were finished …" }. */
export function previewText(count: number, days: number): { count: string; rest: string } | { text: string } {
  const span = `${days} ${plural(days, 'day', 'days')}`;
  if (count === 0) return { text: `No finished task is older than ${span}, so nothing is archived tonight.` };
  return {
    count: `${count} ${plural(count, 'task', 'tasks')}`,
    rest: `${plural(count, 'was', 'were')} finished more than ${span} ago and will be archived tonight.`,
  };
}

/** The off state (frame 081): what happens without the setting, and how many tasks are finished. */
export function offText(projectName: string, finished?: { done: number; canceled: number }): string {
  const lead = 'Off: finished tasks stay where they are until someone archives them by hand.';
  if (!finished) return lead;
  const total = finished.done + finished.canceled;
  if (total === 0) return `${lead} ${projectName} has no Done or Canceled tasks.`;
  const parts = [
    ...(finished.done ? [`${finished.done} Done`] : []),
    ...(finished.canceled ? [`${finished.canceled} Canceled`] : []),
  ];
  return `${lead} ${projectName} has ${parts.join(' and ')} ${plural(total, 'task', 'tasks')}.`;
}

/** A failed save, as a sentence for the page. */
export function archiveFailure(error: unknown): string {
  if (error instanceof ORPCError) {
    if (error.code === 'FORBIDDEN') return 'Only owners and admins can change the archive setting.';
    if (error.code === 'UNAUTHORIZED') return 'Your session ended. Sign in again to save.';
    if (error.code === 'NOT_FOUND') return 'This project no longer exists.';
    const issues = (error.data as { issues?: { message: string }[] } | undefined)?.issues;
    if (issues?.[0]?.message) return issues[0].message.replace(/\.?$/, '.');
    if (error.message) return error.message.replace(/\.?$/, '.');
  }
  return 'Couldn’t save the archive setting. Check your connection and try again.';
}
