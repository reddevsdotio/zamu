import { cycleLengthDays, type ProjectWithCounts } from '@zamu/contracts';
import { type WorkspaceUrlSlug, workspacePath } from '~/lib/workspace-paths';

// Links to a project's pages and the current cycle's note. (M5 dropped the M4 header tabs: the sidebar
// lists a project's pages.)

export type ProjectView = 'tasks' | 'milestones' | 'cycles' | 'settings';

export type ProjectTabsInput = Pick<
  ProjectWithCounts,
  'key' | 'usesMilestones' | 'usesCycles' | 'currentCycle'
> & { openCount?: number };

/** Page of a project view: /p/PAY, /p/PAY/milestones, /p/PAY/cycles, /p/PAY/settings, in the workspace. */
export function projectViewHref(workspace: WorkspaceUrlSlug, projectKey: string, view: ProjectView): string {
  const base = workspacePath(workspace, `/p/${encodeURIComponent(projectKey)}`);
  return view === 'tasks' ? base : `${base}/${view}`;
}

/** "C12 · 3d left" for the Cycles tab, or undefined without a current cycle. */
export function cycleNote(currentCycle: ProjectTabsInput['currentCycle']): string | undefined {
  if (!currentCycle) return undefined;
  return `C${currentCycle.number} · ${currentCycle.daysLeft}d left`;
}

/** Share of the current cycle's days already gone, 0 to 1 (the pie of the cycle glyph). */
export function cycleElapsed(currentCycle: NonNullable<ProjectTabsInput['currentCycle']>): number {
  const length = cycleLengthDays(currentCycle.startsOn, currentCycle.endsOn);
  if (length <= 0) return 0;
  return Math.max(0, Math.min(1, (length - currentCycle.daysLeft) / length));
}
