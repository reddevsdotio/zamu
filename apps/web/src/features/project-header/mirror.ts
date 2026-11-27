import {
  type BacklogProblem,
  type BacklogTrigger,
  type ProjectBacklogSummary,
  parseRepositoryUrl,
} from '@zamu/contracts';
import type { SourceDotState } from '~/ui';

// Mirror rules and copy shared by the project views (header, list, board, milestones, projects table,
// rail). A project mirrors Backlog.md while it has a source that is not detached: imports that have
// not finished their first read count too, because core refuses new tasks until they detach.

type WithBacklog = { backlog?: ProjectBacklogSummary | null } | null | undefined;

/** Tasks (and milestones) come from Backlog.md right now. */
export function isMirrored(project: WithBacklog): boolean {
  const backlog = project?.backlog;
  return backlog != null && backlog.state !== 'detached' && backlog.detachedAt == null;
}

/** The project was mirrored or imported and is now fully editable. */
export function isDetached(project: WithBacklog): boolean {
  const backlog = project?.backlog;
  return backlog != null && (backlog.state === 'detached' || backlog.detachedAt != null);
}

/** The header button's dot for a source state (setup reads like a refresh). */
export function sourceDotState(state: ProjectBacklogSummary['state']): SourceDotState {
  return state === 'setup' ? 'reading' : state;
}

/** Title of the source popover. */
export const SOURCE_TITLES: Record<ProjectBacklogSummary['state'], string> = {
  setup: 'Reading Backlog.md for the first time',
  reading: 'Refreshing',
  healthy: 'Mirroring',
  warnings: 'Mirroring, with problems',
  failed: 'Last refresh failed',
  paused: 'Paused',
  detached: 'Owned by Zamu',
};

/** The source popover's title, with "Imported" for an import that finished (PM-33). */
export function sourceTitle(summary: Pick<ProjectBacklogSummary, 'state' | 'mode'>): string {
  return summary.state === 'detached' && summary.mode === 'import'
    ? 'Imported'
    : SOURCE_TITLES[summary.state];
}

/** "by webhook" in "3m ago by webhook, commit a1b2c3d". */
export function triggerText(trigger: BacklogTrigger | null | undefined): string {
  switch (trigger) {
    case 'webhook':
      return 'by webhook';
    case 'poll':
      return 'by the hourly check';
    case 'manual':
      return 'by Refresh now';
    case 'cli':
      return 'from zamu backlog refresh';
    case 'setup':
      return 'at setup';
    default:
      return '';
  }
}

/** "gitlab.com/reddevs/payments" for a clone URL; the URL itself when it does not parse. */
export function repositoryShort(repository: string | null | undefined): string | null {
  if (!repository) return null;
  return parseRepositoryUrl(repository)?.short ?? repository;
}

/** Problem count for the header button: "31 problems", "1 problem". */
export function problemCount(problems: ProjectBacklogSummary['problems']): number {
  return problems.files + problems.values;
}

export function plural(count: number, one: string, many = `${one}s`): string {
  return `${count} ${count === 1 ? one : many}`;
}

const VALUE_WORDS: Record<string, [string, string]> = {
  status: ['status', 'statuses'],
  priority: ['priority', 'priorities'],
  assignee: ['assignee', 'assignees'],
  milestone: ['milestone', 'milestones'],
};

/**
 * "30 files skipped, 1 status unmapped". Uses the loaded problem items for the detail (skipped or with
 * a warning, values per field); falls back to the summary counts while they load or when the page of
 * problems does not hold them all.
 */
export function describeProblems(
  counts: ProjectBacklogSummary['problems'],
  items?: readonly BacklogProblem[],
): string {
  const parts: string[] = [];
  const fileItems = items?.filter((item) => item.kind === 'file') ?? [];
  if (counts.files) {
    if (fileItems.length === counts.files) {
      const skipped = fileItems.filter((item) => item.skipped).length;
      if (skipped) parts.push(`${plural(skipped, 'file')} skipped`);
      if (counts.files - skipped) parts.push(`${plural(counts.files - skipped, 'file')} with warnings`);
    } else {
      parts.push(`${plural(counts.files, 'file')} with problems`);
    }
  }
  const valueItems = items?.filter((item) => item.kind === 'value') ?? [];
  if (counts.values) {
    if (valueItems.length === counts.values) {
      const byField = new Map<string, number>();
      for (const item of valueItems) {
        if (item.kind === 'value') byField.set(item.field, (byField.get(item.field) ?? 0) + 1);
      }
      for (const [field, count] of byField) {
        const [one, many] = VALUE_WORDS[field] ?? [field, `${field}s`];
        parts.push(`${plural(count, one, many)} unmapped`);
      }
    } else {
      parts.push(`${plural(counts.values, 'value')} unmapped`);
    }
  }
  return parts.join(', ') || 'None';
}

/** Folder of task files for the refusal copy: "backlog/tasks/". */
export function tasksFolder(folder?: string | null): string {
  return `${(folder || 'backlog').replace(/\/+$/, '')}/tasks/`;
}

/** Folder of milestone files: "backlog/milestones/". */
export function milestonesFolder(folder?: string | null): string {
  return `${(folder || 'backlog').replace(/\/+$/, '')}/milestones/`;
}

/**
 * Why New, C and quick create do nothing in a mirrored project, as plain text (toasts, aria). The
 * tooltip renders the same sentence with inline code.
 */
export function createRefusalText(projectName: string, folder?: string | null): string {
  return `Tasks in ${projectName} come from Backlog.md. Add a file under ${tasksFolder(folder)}, or run backlog task create, and push. It shows up here after the next refresh.`;
}

/** Why New milestone is off in a mirrored project. */
export function milestoneRefusalText(projectName: string, folder?: string | null): string {
  return `Milestones in ${projectName} come from Backlog.md. Add a file under ${milestonesFolder(folder)} and push.`;
}

/** Toast while dragging a mirrored card. */
export const DRAG_REFUSAL_TEXT = 'Status comes from Backlog.md, so cards move only within their column.';

/** Toast for Shift+H/L on a mirrored card: "PAY-786 stays in In progress: its status comes from Backlog.md." */
export function statusRefusalText(taskKey: string, statusLabel: string): string {
  return `${taskKey} stays in ${statusLabel}: its status comes from Backlog.md.`;
}

/** Toast once a project is owned by Zamu (switched, or an import that finished). */
export function detachedText(projectName: string): string {
  return `${projectName} is owned by Zamu now. Everything is editable here.`;
}

/** "PAY-786" for "PAY-786.1", "PAY-786.1" for "PAY-786.1.2"; null for keys without a suffix. */
export function parentKeyOf(taskKey: string): string | null {
  const match = /^([A-Z][A-Z0-9]*-\d+(?:\.\d+)*)\.\d+$/i.exec(taskKey);
  return match?.[1] ?? null;
}
