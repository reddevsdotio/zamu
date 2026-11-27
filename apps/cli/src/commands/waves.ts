// zamu waves add | update | remove | put | pass | fail (M8), and the wave text zamu milestones show
// prints. A milestone's waves run in order. Each wave has a gate, and a wave stays locked until every
// gate before it has passed: agents can't start its tasks, people get a warning. A wave is named by
// its number (3 or W3) or its name, within a milestone named by id or name. None of these writes is
// queued when the server doesn't answer: they depend on the waves as the server has them.
import {
  CreateWaveInput,
  DeleteWaveInput,
  formatWaveNumber,
  type GateResultState,
  GetMilestonePlanInput,
  type MilestonePlan,
  PutTasksInWaveInput,
  parseWaveReference,
  RecordGateInput,
  UpdateWaveInput,
  type Wave,
  WaveId,
  type WaveTask,
} from '@zamu/contracts';
import type { ApiClient } from '../client';
import { type CommandContext, emit } from '../context';
import { serverError, usageError } from '../errors';
import {
  firstLine,
  formatTime,
  gateStateLabel,
  type Style,
  statusLabel,
  waveLabel,
  waveLockText,
} from '../format';
import {
  collectKeys,
  isNone,
  parseInput,
  projectFlag,
  readText,
  resolveMilestoneArg,
  shellWord,
} from './shared';

/** Stands in for ids still to be looked up, so the field rules run before any request. */
const PLACEHOLDER_ID = '00000000-0000-7000-8000-000000000000';

// ---------------------------------------------------------------------------
// Looking waves up
// ---------------------------------------------------------------------------

/**
 * The wave a reference names among a milestone's waves: a wave id, a number (3 or W3) or a name
 * (ignoring case). An unknown reference is a usage error that lists the waves.
 */
export function findWave<W extends { id: string; number: number; name: string }>(
  waves: readonly W[],
  value: string,
  milestoneName: string,
): W {
  const trimmed = value.trim();
  if (WaveId.safeParse(trimmed).success) {
    const byId = waves.find((wave) => wave.id === trimmed);
    if (byId) return byId;
  }
  const ref = parseWaveReference(trimmed);
  const lower = trimmed.toLowerCase();
  const byName = waves.find((wave) => wave.name.trim().toLowerCase() === lower);
  const found = ref.kind === 'number' ? (waves.find((wave) => wave.number === ref.number) ?? byName) : byName;
  if (found) return found;
  const what = ref.kind === 'number' ? formatWaveNumber(ref.number) : `named "${trimmed}"`;
  const candidates = waves.length
    ? `Waves in ${milestoneName}: ${waves.map((wave) => waveLabel(wave)).join(', ')}`
    : `${milestoneName} has no waves yet. zamu waves add adds one.`;
  throw usageError(
    `${milestoneName} has no wave ${what}.`,
    [{ path: 'wave', message: candidates }],
    [candidates],
  );
}

/** The milestone's plan: its waves with their gates, locks and tasks. */
export async function loadPlan(
  context: CommandContext,
  client: ApiClient,
  milestone: string,
  project: string | undefined,
): Promise<MilestonePlan> {
  const id = await resolveMilestoneArg(context, client, milestone, project);
  return client.milestones.plan(parseInput(GetMilestonePlanInput, { id }));
}

/** --position: a wave number, 2 or W2. */
function positionValue(value: string): number {
  const ref = parseWaveReference(value);
  if (ref.kind !== 'number')
    throw usageError(`--position takes a wave number, such as 2 or W2, not "${value}".`);
  return ref.number;
}

// ---------------------------------------------------------------------------
// Text
// ---------------------------------------------------------------------------

/** "4 of 6 done", with the canceled ones when there are any. */
function waveProgressText(wave: Pick<Wave, 'progress'>): string {
  const { done, total, canceled } = wave.progress;
  return `${done} of ${total} done${canceled ? `, ${canceled} canceled` : ''}`;
}

/** "W3 · Payout screens  4 of 6 done · gate open · current", the lock when it has one. */
export function waveHeader(style: Style, wave: Wave): string {
  const gate = `gate ${gateStateLabel(wave.gate.state).toLowerCase()}`;
  const parts = [waveProgressText(wave), wave.gate.state === 'failed' ? style.warn(gate) : gate];
  // A task added or reopened after the pass leaves the gate passed: say so.
  if (wave.gate.state === 'passed' && wave.progress.open > 0) {
    parts.push(style.warn(wave.progress.open === 1 ? '1 task open' : `${wave.progress.open} tasks open`));
  }
  if (wave.current) parts.push('current');
  const lock = waveLockText(wave);
  if (lock) parts.push(style.warn(lock));
  return `${style.bold(waveLabel(wave))}  ${parts.join(' · ')}`;
}

/** "Passed by claude-dev for Ana Ruiz, 2026-11-24 16:00: <first line of the note>". */
export function gateResultLine(result: NonNullable<Wave['gate']['result']>): string {
  const who = result.onBehalfOf
    ? `${result.recordedBy.name} for ${result.onBehalfOf.name}`
    : result.recordedBy.name;
  const note = firstLine(result.note).replace(/^#+\s*/, '');
  return `${gateStateLabel(result.state)} by ${who}, ${formatTime(result.at)}: ${note}`;
}

/** The gate's description (all of it: it says what to check) and its latest result. */
function gateLines(wave: Wave): string[] {
  const description = wave.gate.description?.replace(/\s+$/, '');
  const lines = description
    ? description
        .split('\n')
        .map((line, i) => (i === 0 ? `  Gate: ${line}` : line.trim() ? `        ${line}` : ''))
    : ['  Gate: not described'];
  if (wave.gate.result) lines.push(`  ${gateResultLine(wave.gate.result)}`);
  return lines;
}

interface RowWidths {
  key: number;
  status: number;
  assignee: number;
}

const length = (text: string) => [...text].length;
const pad = (text: string, size: number) => text + ' '.repeat(Math.max(size - length(text), 0));
const assigneeName = (task: WaveTask) => task.assignee?.name ?? 'Unassigned';

/** Column widths shared by every task row of the plan, so the waves line up. */
export function rowWidths(tasks: readonly WaveTask[]): RowWidths {
  return {
    key: Math.max(0, ...tasks.map((task) => length(task.key))),
    status: Math.max(0, ...tasks.map((task) => length(statusLabel(task.status)))),
    assignee: Math.max(0, ...tasks.map((task) => length(assigneeName(task)))),
  };
}

/** "  PAY-173  In review  claude-dev  Retry button". */
function taskRow(style: Style, task: WaveTask, widths: RowWidths): string {
  const archived = task.archived ? style.dim(' (archived)') : '';
  return `  ${style.bold(pad(task.key, widths.key))}  ${style.status(task.status, pad(statusLabel(task.status), widths.status))}  ${pad(assigneeName(task), widths.assignee)}  ${task.title}${archived}`;
}

/** A wave as zamu milestones show prints it: header, gate, result, then its tasks. */
export function waveBlock(style: Style, wave: Wave, widths: RowWidths): string {
  const rows = wave.tasks.length
    ? wave.tasks.map((task) => taskRow(style, task, widths))
    : ['  No tasks yet.'];
  return `${[waveHeader(style, wave), ...gateLines(wave), ...rows].join('\n')}\n`;
}

/** The tasks of the milestone in no wave: no gate, they never hold a wave up. */
export function notInWaveBlock(style: Style, tasks: readonly WaveTask[], widths: RowWidths): string {
  const count = tasks.length === 1 ? '1 task' : `${tasks.length} tasks`;
  return `${[`${style.bold('Not in a wave')}  ${count} · no gate`, ...tasks.map((task) => taskRow(style, task, widths))].join('\n')}\n`;
}

const isOpen = (task: WaveTask) => task.status !== 'done' && task.status !== 'canceled';

function taskCount(count: number): string {
  return count === 1 ? '1 task' : `${count} tasks`;
}

/**
 * The last line of zamu milestones show: what a dispatching agent does next. `milestone` is the
 * milestone as the command named it, ready to paste; `flag` is its --project, if any.
 */
export function nextStep(plan: MilestonePlan, milestone: string, flag: string): string {
  const m = shellWord(milestone);
  if (plan.waves.length === 0) {
    return `Next: add the waves of the plan, in order: zamu waves add ${m} "Ledger" --gate "what the gate checks"${flag}`;
  }
  const current =
    plan.waves.find((wave) => wave.current) ?? plan.waves.find((wave) => wave.gate.state !== 'passed');
  if (!current) {
    const open = [...plan.waves.flatMap((wave) => wave.tasks), ...plan.notInWave].filter(isOpen);
    const gates = plan.waves.length === 1 ? 'The gate has passed.' : `All ${plan.waves.length} gates passed.`;
    if (open.length)
      return `Next: ${gates} ${taskCount(open.length)} still open: ${open.map((task) => task.key).join(', ')}.`;
    return plan.milestone.status === 'completed'
      ? `Next: ${gates} The milestone is completed.`
      : `Next: ${gates} Complete the milestone: zamu milestones update ${m} --status completed${flag}`;
  }
  const n = formatWaveNumber(current.number);
  if (current.progress.total === 0) {
    return `Next: ${n} has no tasks. Put tasks in it: zamu waves put ${m} ${n} KEY...${flag}`;
  }
  if (current.gate.state === 'failed') {
    return (
      `Next: ${n}'s gate failed. Log each fix as a task in ${n} (zamu waves put ${m} ${n} KEY${flag}), ` +
      `then run the gate's checks again and record the result: zamu waves pass ${m} ${n} --note "what was checked"${flag}`
    );
  }
  if (current.progress.open > 0) {
    const keys = current.openKeys.slice(0, 10).join(', ');
    const more = current.progress.open > 10 ? ` and ${current.progress.open - 10} more` : '';
    return (
      `Next: ${n} has ${current.progress.open === 1 ? '1 open task' : `${current.progress.open} open tasks`}: ` +
      `${keys}${more}. When they are done, run the gate's checks and record the result: ` +
      `zamu waves pass ${m} ${n} --note "what was checked"${flag}`
    );
  }
  return (
    `Next: every task in ${n} is done or canceled. Run the gate's checks and record the result: ` +
    `zamu waves pass ${m} ${n} --note "what was checked"${flag}, or zamu waves fail with what failed.`
  );
}

// ---------------------------------------------------------------------------
// zamu waves add
// ---------------------------------------------------------------------------

export interface AddWaveOptions {
  project?: string;
  gate?: string;
  position?: string;
}

export async function addWave(
  context: CommandContext,
  milestone: string,
  nameWords: string[],
  options: AddWaveOptions,
): Promise<void> {
  const draft = {
    name: nameWords.join(' '),
    ...(options.gate !== undefined ? { gateDescription: await readText(context, options.gate) } : {}),
    ...(options.position !== undefined ? { position: positionValue(options.position) } : {}),
  };
  parseInput(CreateWaveInput, { milestone: PLACEHOLDER_ID, ...draft });
  const client = await context.client();
  const id = await resolveMilestoneArg(context, client, milestone, options.project);
  const wave = await client.waves.create(parseInput(CreateWaveInput, { milestone: id, ...draft }));
  emit(context, 'wave', wave, (data) => {
    const n = formatWaveNumber(data.number);
    return (
      `Added ${[waveHeader(context.style, data), ...gateLines(data)].join('\n')}\n` +
      `Put tasks in it: zamu waves put ${shellWord(milestone)} ${n} KEY...${projectFlag(options.project)}\n`
    );
  });
}

// ---------------------------------------------------------------------------
// zamu waves update
// ---------------------------------------------------------------------------

export interface UpdateWaveOptions {
  project?: string;
  name?: string;
  gate?: string;
  position?: string;
}

export async function updateWave(
  context: CommandContext,
  milestone: string,
  reference: string,
  options: UpdateWaveOptions,
): Promise<void> {
  const changes = {
    ...(options.name !== undefined ? { name: options.name } : {}),
    // An empty --gate clears the description.
    ...(options.gate !== undefined ? { gateDescription: await readText(context, options.gate) } : {}),
    ...(options.position !== undefined ? { position: positionValue(options.position) } : {}),
  };
  parseInput(UpdateWaveInput, { id: PLACEHOLDER_ID, ...changes });
  const client = await context.client();
  const plan = await loadPlan(context, client, milestone, options.project);
  const found = findWave(plan.waves, reference, plan.milestone.name);
  const wave = await client.waves.update(parseInput(UpdateWaveInput, { id: found.id, ...changes }));
  emit(
    context,
    'wave',
    wave,
    (data) => `Updated ${[waveHeader(context.style, data), ...gateLines(data)].join('\n')}\n`,
  );
}

// ---------------------------------------------------------------------------
// zamu waves remove
// ---------------------------------------------------------------------------

export async function removeWave(
  context: CommandContext,
  milestone: string,
  reference: string,
  options: { project?: string },
): Promise<void> {
  const client = await context.client();
  const plan = await loadPlan(context, client, milestone, options.project);
  const wave = findWave(plan.waves, reference, plan.milestone.name);
  await client.waves.delete(parseInput(DeleteWaveInput, { id: wave.id }));
  const removed = {
    milestoneId: plan.milestone.id,
    removed: { id: wave.id, number: wave.number, name: wave.name },
    tasks: wave.tasks.map((task) => task.key),
  };
  emit(context, 'wave-removed', removed, (data) => {
    const tasks = data.tasks.length
      ? ` Its ${taskCount(data.tasks.length)} ${data.tasks.length === 1 ? 'is' : 'are'} in no wave now: ${data.tasks.join(', ')}.`
      : '';
    const later = plan.waves.some((other) => other.number > wave.number)
      ? ' The waves after it moved up one number.'
      : '';
    return `Removed ${context.style.bold(waveLabel(data.removed))} and its gate results from ${plan.milestone.name}.${tasks}${later}\n`;
  });
}

// ---------------------------------------------------------------------------
// zamu waves put
// ---------------------------------------------------------------------------

export async function putTasksInWave(
  context: CommandContext,
  milestone: string,
  reference: string,
  values: string[],
  options: { project?: string },
): Promise<void> {
  const keys = values.reduce<string[]>((all, value) => collectKeys(value, all), []);
  const none = isNone(reference);
  parseInput(PutTasksInWaveInput, { milestone: PLACEHOLDER_ID, wave: null, keys });
  const client = await context.client();
  let id: string;
  let wave: Wave | null = null;
  if (none) id = await resolveMilestoneArg(context, client, milestone, options.project);
  else {
    const plan = await loadPlan(context, client, milestone, options.project);
    id = plan.milestone.id;
    wave = findWave(plan.waves, reference, plan.milestone.name);
  }
  const input = parseInput(PutTasksInWaveInput, { milestone: id, wave: wave?.id ?? null, keys });
  const plan = await client.waves.putTasks(input);
  emit(context, 'milestone-plan', plan, (data) => {
    const { style } = context;
    const list = input.keys.map((key) => key.toUpperCase()).join(', ');
    if (!wave) {
      const where = input.keys.length === 1 ? 'its wave' : 'their waves';
      return `Took ${list} out of ${where}. ${data.milestone.name} has ${taskCount(data.notInWave.length)} in no wave.\n`;
    }
    const now = data.waves.find((candidate) => candidate.id === wave.id);
    return `Put ${list} in ${style.bold(waveLabel(now ?? wave))}.\n${now ? `${waveHeader(style, now)}\n` : ''}`;
  });
}

// ---------------------------------------------------------------------------
// zamu waves pass | fail
// ---------------------------------------------------------------------------

export async function recordGate(
  context: CommandContext,
  state: GateResultState,
  milestone: string,
  reference: string,
  options: { project?: string; note: string },
): Promise<void> {
  const note = await readText(context, options.note);
  parseInput(RecordGateInput, { id: PLACEHOLDER_ID, state, note });
  const client = await context.client();
  const plan = await loadPlan(context, client, milestone, options.project);
  const before = findWave(plan.waves, reference, plan.milestone.name);
  const wave = await client.waves.recordGate(parseInput(RecordGateInput, { id: before.id, state, note }));
  if (!wave.gate.result) throw serverError('The server recorded the result but sent the wave without it.');
  emit(context, 'gate-result', { result: wave.gate.result, wave }, (data) => {
    const { style } = context;
    const label = style.bold(waveLabel(data.wave));
    const n = formatWaveNumber(data.wave.number);
    const lines = [
      `${data.result.state === 'passed' ? 'Passed' : 'Failed'} the gate of ${label}.`,
      `  Note: ${firstLine(data.result.note)}`,
    ];
    const next = plan.waves.find((other) => other.number === data.wave.number + 1);
    if (data.result.state === 'failed') {
      lines.push(
        `The waves after it stay locked. Log each fix as a task in ${n} (zamu waves put ${shellWord(milestone)} ${n} KEY${projectFlag(options.project)}), then record the gate again.`,
      );
    } else if (data.wave.locked && data.wave.lockedUntil) {
      lines.push(
        `The waves after it stay locked until ${formatWaveNumber(data.wave.lockedUntil.number)} passes.`,
      );
    } else if (next) {
      lines.push(`${waveLabel(next)} is unlocked: its tasks can start.`);
    } else {
      lines.push(`Every gate of ${plan.milestone.name} has passed.`);
    }
    return `${lines.join('\n')}\n`;
  });
}
