import { CYCLE_CURRENT, CYCLE_NEXT, type Cycle, type MilestoneWithProgress } from '@zamu/contracts';
import { pathInWorkspace } from '~/lib/workspace-paths';

// Quick create prefills milestone and cycle from the page it opened on:
//   /p/PAY/milestones/<id>          the milestone
//   /p/PAY/cycles/12                cycle 12 (also "current" and "next")
//   ?milestone=<id>&cycle=current   board, list and planning filters (one value, not "none")
// The defaults apply only while the dialog's project is the page's project.

export type CycleDefault = number | typeof CYCLE_CURRENT | typeof CYCLE_NEXT;

export interface PlanningDefaults {
  projectKey?: string;
  milestoneId?: string;
  cycle?: CycleDefault;
}

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

function single(value: unknown): string | undefined {
  if (typeof value === 'number') return String(value);
  if (typeof value === 'string') return value.includes(',') ? undefined : value.trim();
  if (Array.isArray(value) && value.length === 1) return single(value[0]);
  return undefined;
}

function parseCycle(value: string | undefined): CycleDefault | undefined {
  if (!value) return undefined;
  if (value === CYCLE_CURRENT || value === CYCLE_NEXT) return value;
  return /^\d{1,6}$/.test(value) && Number(value) > 0 ? Number(value) : undefined;
}

function parseMilestone(value: string | undefined): string | undefined {
  return value && UUID.test(value) ? value : undefined;
}

export function planningDefaultsFrom(pathname: string, search: Record<string, unknown>): PlanningDefaults {
  const match = /^\/p\/([^/]+)(?:\/(milestones|cycles)\/([^/]+))?/.exec(pathInWorkspace(pathname));
  if (!match) return {};
  const projectKey = decodeURIComponent(match[1] ?? '').toUpperCase();
  const section = match[2];
  const id = match[3] ? decodeURIComponent(match[3]) : undefined;
  const milestoneId =
    section === 'milestones' ? parseMilestone(id) : parseMilestone(single(search.milestone));
  const cycle = section === 'cycles' ? parseCycle(id) : parseCycle(single(search.cycle));
  return {
    projectKey,
    ...(milestoneId ? { milestoneId } : {}),
    ...(cycle !== undefined ? { cycle } : {}),
  };
}

/** The default milestone when it exists and still accepts tasks. */
export function resolveMilestoneDefault(
  milestones: readonly MilestoneWithProgress[] | undefined,
  id: string | undefined,
): MilestoneWithProgress | undefined {
  if (!id) return undefined;
  return milestones?.find((milestone) => milestone.id === id && milestone.status !== 'completed');
}

/** The default cycle: by number, the current one, or the first upcoming one. Never a completed cycle. */
export function resolveCycleDefault(
  cycles: readonly Cycle[] | undefined,
  selector: CycleDefault | undefined,
): Cycle | undefined {
  if (selector === undefined || !cycles) return undefined;
  const open = cycles.filter((cycle) => cycle.state !== 'completed');
  if (selector === CYCLE_CURRENT) return open.find((cycle) => cycle.state === 'current');
  if (selector === CYCLE_NEXT) return open.find((cycle) => cycle.state === 'upcoming');
  return open.find((cycle) => cycle.number === selector);
}
