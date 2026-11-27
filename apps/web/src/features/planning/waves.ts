import type { GateResult, MilestonePlan, TaskListItem, TaskWave, Wave } from '@zamu/contracts';

// The milestone page's wave model (M8, frames 103 to 126), kept apart from the screen so the rules
// are tested on their own: which rows go in which wave, which waves start open, when passed waves
// fold into one line, how many rows a long wave shows, and where Alt+↑ / Alt+↓ move a task.

/** A wave with the rows of the task list (filters applied) that are in it. */
export interface WaveSection {
  wave: Wave;
  tasks: TaskListItem[];
}

export interface WaveSections {
  waves: WaveSection[];
  /** Rows in no wave, or in a wave the plan doesn't know (yet). */
  none: TaskListItem[];
}

/** Puts the rows in the plan's waves, keeping the list's order inside each. */
export function waveSections(
  plan: Pick<MilestonePlan, 'waves'>,
  rows: readonly TaskListItem[],
): WaveSections {
  const byId = new Map<string, TaskListItem[]>(plan.waves.map((wave) => [wave.id, []]));
  const none: TaskListItem[] = [];
  for (const row of rows) {
    const list = row.wave ? byId.get(row.wave.id) : undefined;
    if (list) list.push(row);
    else none.push(row);
  }
  return { waves: plan.waves.map((wave) => ({ wave, tasks: byId.get(wave.id) ?? [] })), none };
}

/** "W3". */
export const waveRefOf = (wave: { number: number }) => `W${wave.number}`;
/** "W3 · Screens". */
export const waveTitle = (wave: { number: number; name: string }) => `W${wave.number} · ${wave.name}`;

/** Every gate passed (and there is at least one wave). */
export function allGatesPassed(waves: readonly Pick<Wave, 'gate'>[]): boolean {
  return waves.length > 0 && waves.every((wave) => wave.gate.state === 'passed');
}

/**
 * Whether a wave starts open: the current wave does, the others don't (passed and locked waves start
 * collapsed). Once every gate passed, the last wave stays open (frame 109).
 */
export function startsExpanded(
  wave: Pick<Wave, 'current' | 'number'>,
  waves: readonly Pick<Wave, 'gate'>[],
): boolean {
  if (wave.current) return true;
  return allGatesPassed(waves) && wave.number === waves.length;
}

/** Waves above this count fold their leading run of passed gates into one line (frame 121). */
export const FOLD_AFTER_WAVES = 6;

/**
 * The run of passed waves from W1 that folds into one line, or null. Only with more than six waves,
 * and only a run of two or more; the last wave never folds, so something stays to read.
 */
export function foldedRun(waves: readonly Pick<Wave, 'gate'>[]): { from: number; to: number } | null {
  if (waves.length <= FOLD_AFTER_WAVES) return null;
  let run = 0;
  while (run < waves.length - 1 && waves[run]?.gate.state === 'passed') run++;
  return run >= 2 ? { from: 1, to: run } : null;
}

/** A wave with more rows than this shows the first TASKS_SHOWN and "N more tasks in this wave". */
export const TASKS_LIMIT = 8;
export const TASKS_SHOWN = 6;

/** The rows a wave shows, and how many more stay behind "Show all". */
export function shownTasks<T>(tasks: readonly T[], showAll: boolean): { shown: T[]; more: number } {
  if (showAll || tasks.length <= TASKS_LIMIT) return { shown: [...tasks], more: 0 };
  return { shown: tasks.slice(0, TASKS_SHOWN), more: tasks.length - TASKS_SHOWN };
}

/** "24 more tasks in this wave". */
export function moreTasksText(more: number): string {
  return more === 1 ? '1 more task in this wave' : `${more} more tasks in this wave`;
}

/**
 * Where Alt+↓ (1) or Alt+↑ (-1) moves a task: the next or previous wave, "Not in a wave" (null) past
 * the last, the last wave going up from no wave. Undefined when there is nowhere to go.
 */
export function moveStep(
  waves: readonly Pick<Wave, 'id'>[],
  from: string | null,
  direction: 1 | -1,
): string | null | undefined {
  if (waves.length === 0) return undefined;
  const index = from == null ? waves.length : waves.findIndex((wave) => wave.id === from);
  const at = index < 0 ? waves.length : index;
  const next = at + direction;
  if (next < 0 || next > waves.length) return undefined;
  return next === waves.length ? null : (waves[next]?.id ?? null);
}

/** A wave as task rows carry it, for the optimistic move. */
export function taskWaveOf(wave: Wave): TaskWave {
  return {
    id: wave.id,
    number: wave.number,
    name: wave.name,
    locked: wave.locked,
    lockedUntil: wave.lockedUntil,
  };
}

/** The first wave whose gate failed and holds the plan up (the current wave, failed), or null. */
export function stoppedAt(waves: readonly Wave[]): Wave | null {
  const current = waves.find((wave) => wave.current);
  return current && current.gate.state === 'failed' ? current : null;
}

/** The person an agent acted for, by first name: "claude-dev for Ana". */
export function resultBy(result: Pick<GateResult, 'recordedBy' | 'onBehalfOf'>): {
  by: string;
  onBehalfOf: string | null;
} {
  return {
    by: result.recordedBy.name,
    onBehalfOf: result.onBehalfOf ? (result.onBehalfOf.name.trim().split(/\s+/)[0] ?? null) : null,
  };
}
