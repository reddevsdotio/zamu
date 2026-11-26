import { useQuery } from '@tanstack/react-query';
import {
  type Cycle,
  type CycleRef,
  cycleLengthDays,
  type MilestoneRef,
  type MilestoneWithProgress,
} from '@zamu/contracts';
import { formatDateRange } from '~/features/tasks/format';
import { cyclesQuery, milestonesQuery, projectsQuery } from '~/features/tasks/queries';
import { useApi } from '~/lib/workspace';
import { CycleGlyph } from '~/ui';

// Milestone and cycle helpers for the pickers (moved here from features/tasks/PlanningFields.tsx, which
// can re-export them): the project's switches and lists, refs, and the cycle wording.

export interface ProjectPlanning {
  usesMilestones: boolean;
  usesCycles: boolean;
  /** Undefined while loading or when the project does not use milestones. */
  milestones: MilestoneWithProgress[] | undefined;
  cycles: Cycle[] | undefined;
  /** The project's switches are known. */
  isKnown: boolean;
}

/** The project's feature switches plus its milestones and cycles. Features count as off until known. */
export function useProjectPlanning(projectKey: string | undefined, enabled = true): ProjectPlanning {
  const api = useApi();
  const project = useQuery({
    ...projectsQuery(api),
    select: (data) => data.items.find((item) => item.key === projectKey),
    enabled: enabled && projectKey != null,
  }).data;
  const usesMilestones = project?.usesMilestones ?? false;
  const usesCycles = project?.usesCycles ?? false;
  const milestones = useQuery({
    ...milestonesQuery(api, projectKey ?? ''),
    enabled: enabled && projectKey != null && usesMilestones,
  }).data?.items;
  const cycles = useQuery({
    ...cyclesQuery(api, projectKey ?? ''),
    enabled: enabled && projectKey != null && usesCycles,
  }).data?.items;
  return { usesMilestones, usesCycles, milestones, cycles, isKnown: project != null };
}

export function toMilestoneRef(milestone: MilestoneWithProgress | MilestoneRef): MilestoneRef {
  return {
    id: milestone.id,
    name: milestone.name,
    status: milestone.status,
    targetDate: milestone.targetDate,
  };
}

export function toCycleRef(cycle: Cycle | CycleRef): CycleRef {
  return {
    id: cycle.id,
    number: cycle.number,
    name: cycle.name,
    startsOn: cycle.startsOn,
    endsOn: cycle.endsOn,
    state: cycle.state,
  };
}

/** "Cycle 12". */
export const cycleLabel = (cycle: { number: number }) => `Cycle ${cycle.number}`;

/** Elapsed share of a current cycle, from the days left the server counted in APP_TIME_ZONE. */
export function cycleElapsed(cycle: Pick<Cycle, 'startsOn' | 'endsOn' | 'daysLeft'>): number {
  const length = cycleLengthDays(cycle.startsOn, cycle.endsOn);
  if (cycle.daysLeft == null || length <= 0) return 0;
  return Math.min(1, Math.max(0, (length - cycle.daysLeft + 1) / length));
}

/** "3d left" for current cycles, "Oct 26 – Nov 8" for upcoming ones, "completed" for ended ones. */
export function cycleNote(cycle: CycleRef & { daysLeft?: number | null }, now?: Date): string {
  if (cycle.state === 'completed') return 'completed';
  if (cycle.state === 'current') return cycle.daysLeft != null ? `${cycle.daysLeft}d left` : 'current';
  return formatDateRange(cycle.startsOn, cycle.endsOn, now);
}

export function CycleStateGlyph({ cycle }: { cycle: CycleRef & { daysLeft?: number | null } }) {
  if (cycle.state === 'completed') return <CycleGlyph state="done" />;
  if (cycle.state === 'current') {
    return (
      <CycleGlyph state="progress" progress={cycleElapsed({ ...cycle, daysLeft: cycle.daysLeft ?? null })} />
    );
  }
  return <CycleGlyph />;
}
