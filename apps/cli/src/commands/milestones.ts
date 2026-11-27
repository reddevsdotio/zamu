// zamu milestones list | show | create | update. From M8 a milestone has a plan link and waves:
// zamu milestones show prints the plan a dispatching agent works from, and update sets the link.
import {
  CreateMilestoneInput,
  formatWaveNumber,
  ListMilestonesInput,
  MilestoneId,
  type MilestoneWithProgress,
  UpdateMilestoneInput,
} from '@zamu/contracts';
import { type CommandContext, emit } from '../context';
import { fields, milestoneStatusLabel, progressLabel, table } from '../format';
import { requireProject, resolveProject } from '../project';
import {
  isNone,
  normalizeChoice,
  parseInput,
  projectFlag,
  readText,
  resolveMilestone,
  shellWord,
} from './shared';
import { loadPlan, nextStep, notInWaveBlock, rowWidths, waveBlock } from './waves';

function days(count: number): string {
  return count === 1 ? '1 day' : `${count} days`;
}

/** "2026-11-14 (22 days left)", "2026-10-20 (overdue by 3 days)" or "None". */
function targetLabel(milestone: MilestoneWithProgress, { long }: { long: boolean }): string {
  const date = milestone.targetDate;
  if (!date) return long ? 'None' : '';
  if (milestone.overdue) {
    return long && milestone.daysLeft !== null
      ? `${date} (overdue by ${days(-milestone.daysLeft)})`
      : `${date} overdue`;
  }
  if (!long || milestone.status === 'completed' || milestone.daysLeft === null) return date;
  return milestone.daysLeft === 0 ? `${date} (today)` : `${date} (${days(milestone.daysLeft)} left)`;
}

/**
 * M8: the wave status as the milestone list shows it: "W3 of 5 · gate open", "W8 of 12 · gate failed",
 * "all 4 passed". Empty without waves.
 */
function wavesLabel(milestone: MilestoneWithProgress): string {
  const waves = milestone.waves;
  if (!waves) return '';
  if (waves.allPassed || waves.current === null) {
    return waves.count === 1 ? 'gate passed' : `all ${waves.count} passed`;
  }
  return `${formatWaveNumber(waves.current)} of ${waves.count} · gate ${waves.currentState ?? 'open'}`;
}

function milestoneSummary(context: CommandContext, verb: string, milestone: MilestoneWithProgress): string {
  const { style } = context;
  const head = `${verb} milestone ${style.bold(milestone.name)} in ${milestone.project.key}`;
  const waves = wavesLabel(milestone);
  return `${head}\n${fields(
    [
      ['Status', milestoneStatusLabel(milestone.status)],
      ['Target', targetLabel(milestone, { long: true })],
      ['Progress', progressLabel(milestone.progress)],
      ...(milestone.planUrl ? [['Plan', milestone.planUrl] as [string, string]] : []),
      ...(waves ? [['Waves', waves] as [string, string]] : []),
      ['Id', milestone.id],
    ],
    style,
  )}`;
}

// ---------------------------------------------------------------------------
// zamu milestones list
// ---------------------------------------------------------------------------

export async function listMilestones(context: CommandContext, options: { project?: string }): Promise<void> {
  const input = parseInput(ListMilestonesInput, { project: await requireProject(context, options.project) });
  const client = await context.client();
  const milestones = await client.milestones.list(input);
  emit(context, 'milestones.list', milestones, (data) => {
    if (data.items.length === 0) return `No milestones in ${input.project}.\n`;
    const { style } = context;
    return table(
      data.items,
      [
        { header: 'STATUS', value: (m) => milestoneStatusLabel(m.status) },
        { header: 'TARGET', value: (m) => targetLabel(m, { long: false }) },
        { header: 'DONE', value: (m) => progressLabel(m.progress) },
        { header: 'IN PROGRESS', value: (m) => String(m.progress.inProgress) },
        { header: 'OPEN', value: (m) => String(m.progress.open) },
        // M8: the wave column shows only when a milestone has waves.
        ...(data.items.some((m) => m.waves) ? [{ header: 'WAVES', value: wavesLabel }] : []),
        { header: 'NAME', value: (m) => m.name, style: (_m, cell) => style.bold(cell) },
      ],
      style,
      context.io.columns,
    );
  });
}

// ---------------------------------------------------------------------------
// zamu milestones create
// ---------------------------------------------------------------------------

export interface CreateMilestoneOptions {
  project?: string;
  target?: string;
  description?: string;
}

export async function createMilestone(
  context: CommandContext,
  nameWords: string[],
  options: CreateMilestoneOptions,
): Promise<void> {
  const project = await requireProject(context, options.project);
  context.target = { ...context.target, project };
  const input = parseInput(CreateMilestoneInput, {
    project,
    name: nameWords.join(' '),
    ...(options.target !== undefined ? { targetDate: isNone(options.target) ? null : options.target } : {}),
    ...(options.description !== undefined
      ? { description: await readText(context, options.description) }
      : {}),
  });
  const client = await context.client();
  const milestone = await client.milestones.create(input);
  emit(context, 'milestones.create', milestone, (data) => milestoneSummary(context, 'Created', data));
}

// ---------------------------------------------------------------------------
// zamu milestones update
// ---------------------------------------------------------------------------

export interface UpdateMilestoneOptions {
  project?: string;
  name?: string;
  target?: string;
  status?: string;
  description?: string;
  /** M8: --plan <url-or-path> sets the plan link, --no-plan (false) clears it. */
  plan?: string | false;
}

export async function updateMilestone(
  context: CommandContext,
  idOrName: string,
  options: UpdateMilestoneOptions,
): Promise<void> {
  const description =
    options.description === undefined ? undefined : await readText(context, options.description);
  const changes = {
    ...(options.name !== undefined ? { name: options.name } : {}),
    ...(options.target !== undefined ? { targetDate: isNone(options.target) ? null : options.target } : {}),
    ...(options.status !== undefined ? { status: normalizeChoice(options.status) } : {}),
    // An empty description clears it.
    ...(description !== undefined ? { description: description.trim() ? description : null } : {}),
    ...(options.plan !== undefined ? { planUrl: options.plan === false ? null : options.plan } : {}),
  };
  // A placeholder id lets the field rules run before the name is looked up.
  const placeholder = '00000000-0000-7000-8000-000000000000';
  parseInput(UpdateMilestoneInput, { id: placeholder, ...changes });
  const client = await context.client();
  // A name needs a project to look it up in; an id does not.
  const project = MilestoneId.safeParse(idOrName.trim()).success
    ? options.project
    : (await resolveProject(context, options.project))?.key;
  if (project) context.target = { ...context.target, project };
  const id = await resolveMilestone(client, project, idOrName, 'Milestone');
  const input = parseInput(UpdateMilestoneInput, { id, ...changes });
  const milestone = await client.milestones.update(input);
  emit(context, 'milestones.update', milestone, (data) => milestoneSummary(context, 'Updated', data));
}

// ---------------------------------------------------------------------------
// zamu milestones show (M8)
// ---------------------------------------------------------------------------

/**
 * zamu milestones show <milestone>: the one command a dispatching agent reads. The milestone line,
 * the plan link, each wave with its gate (the latest result and who recorded it), lock and tasks,
 * the tasks in no wave, and a last line that says what comes next.
 */
export async function showMilestone(
  context: CommandContext,
  idOrName: string,
  options: { project?: string },
): Promise<void> {
  const client = await context.client();
  const plan = await loadPlan(context, client, idOrName, options.project);
  emit(context, 'milestone-plan', plan, (data) => {
    const { style } = context;
    const m = data.milestone;
    const flag = projectFlag(options.project);
    const counted = m.progress.total - m.progress.canceled;
    const head = [
      m.project.key,
      milestoneStatusLabel(m.status),
      ...(m.targetDate ? [`target ${targetLabel(m, { long: true })}`] : []),
      `${m.progress.done} of ${counted} done`,
    ].join(' · ');
    const plan = data.planUrl
      ? data.planUrl
      : style.dim(`none. Add it: zamu milestones update ${shellWord(idOrName)} --plan <url-or-path>${flag}`);
    const widths = rowWidths([...data.waves.flatMap((wave) => wave.tasks), ...data.notInWave]);
    const blocks = [
      `${style.bold(m.name)}  ${head}\n${style.dim('Plan')}  ${plan}\n`,
      ...data.waves.map((wave) => waveBlock(style, wave, widths)),
      ...(data.notInWave.length ? [notInWaveBlock(style, data.notInWave, widths)] : []),
      `${nextStep(data, idOrName, flag)}\n`,
    ];
    return blocks.join('\n');
  });
}
