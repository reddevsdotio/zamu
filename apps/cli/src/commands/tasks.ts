// zamu tasks list | show | create | update.
import { ORPCError } from '@orpc/client';
import {
  ActivityList,
  ASSIGNEE_ME,
  CreateCommentInput,
  CreateTaskInput,
  FILTER_NONE,
  GetTaskInput,
  LabelId,
  ListTasksInput,
  MilestoneId,
  type RelatedTask,
  TASK_STATUSES,
  type Task,
  Timeline,
  type TimelineCounts,
  type TimelineItem,
  UpdateTaskInput,
  type WorkItem,
} from '@zamu/contracts';
import type { ApiClient } from '../client';
import { type CommandContext, emit } from '../context';
import { usageError } from '../errors';
import {
  assigneeLabel,
  cycleLabel,
  cycleStateLabel,
  fields,
  formatTime,
  indentBody,
  itemLines,
  itemProgress,
  milestoneStatusLabel,
  priorityLabel,
  statusLabel,
  table,
  timelineText,
  workTextByline,
} from '../format';
import { requireProject, resolveProject } from '../project';
import { queueBehind } from '../queue';
import { resolveLabelIds } from './labels';
import { noteSummary, postNote } from './notes';
import {
  isNone,
  normalizeChoice,
  normalizeCycle,
  parseInput,
  resolveAssignee,
  resolveMilestone,
  type TaskRef,
  taskRef,
  withTaskRef,
} from './shared';
import {
  type CreateWorkOptions,
  checkStdinFlags,
  createWorkFields,
  resolveWaives,
  stdinReader,
  touchesItems,
  type UpdateWorkOptions,
  updateWorkFields,
  type WaiveToken,
} from './work';

// Kept here for callers that imported them from this module in M1.
export { collectList, normalizeChoice, resolveAssignee } from './shared';

/** "Webhooks v2 (Active, target 2026-11-14)". */
function milestoneField(milestone: NonNullable<Task['milestone']>): string {
  const target = milestone.targetDate ? `, target ${milestone.targetDate}` : '';
  return `${milestone.name} (${milestoneStatusLabel(milestone.status)}${target})`;
}

/** "Cycle 12 · Checkout rewrite (Current, 2026-10-12 to 2026-10-25)". */
function cycleField(cycle: NonNullable<Task['cycle']>): string {
  return `${cycleLabel(cycle)} (${cycleStateLabel(cycle.state)}, ${cycle.startsOn} to ${cycle.endsOn})`;
}

/** Milestone and cycle lines, only for what the task has. */
function planningFields(task: Pick<Task, 'milestone' | 'cycle'>): [string, string][] {
  const entries: [string, string][] = [];
  if (task.milestone) entries.push(['Milestone', milestoneField(task.milestone)]);
  if (task.cycle) entries.push(['Cycle', cycleField(task.cycle)]);
  return entries;
}

/** "PAY-9  Settle refunds (In progress)", or "Removed task" for a task the caller can't see. */
function relatedLine(task: RelatedTask | null): string {
  return task ? `${task.key}  ${task.title} (${statusLabel(task.status)})` : 'Removed task';
}

/** "PAY-9, Removed task": relation keys on one line, for the create and update summaries. */
function relatedKeys(tasks: readonly (RelatedTask | null)[]): string {
  return tasks.map((task) => task?.key ?? 'Removed task').join(', ');
}

/** One entry per related task: the label on the first line, blank labels after it. */
function relatedEntries(label: string, tasks: readonly (RelatedTask | null)[]): [string, string][] {
  return tasks.map((task, i) => [i === 0 ? label : '', relatedLine(task)]);
}

/** "Todo", or "Todo · blocked" while a blocker is open. */
function statusField(context: CommandContext, task: Pick<Task, 'status' | 'blocked'>): string {
  const status = context.style.status(task.status, statusLabel(task.status));
  return task.blocked ? `${status} · ${context.style.warn('blocked')}` : status;
}

/** M5 lines, only for what the task has: labels, due date and parent. */
function fieldEntries(task: Pick<Task, 'labels' | 'dueDate' | 'parent'>): [string, string][] {
  const entries: [string, string][] = [];
  if (task.labels?.length) entries.push(['Labels', task.labels.map((label) => label.name).join(', ')]);
  if (task.dueDate) entries.push(['Due', task.dueDate]);
  if (task.parent) entries.push(['Parent', relatedLine(task.parent)]);
  return entries;
}

function taskSummary(context: CommandContext, verb: string, task: Task): string {
  const { style } = context;
  const head = `${verb} ${style.bold(task.key)}  ${task.title}`;
  const progress = task.subtaskProgress;
  return `${head}\n${fields(
    [
      ['Status', statusField(context, task)],
      ['Priority', style.priority(task.priority, priorityLabel(task.priority))],
      ['Assignee', assigneeLabel(task.assignee)],
      ...planningFields(task),
      ...fieldEntries(task),
      ...(task.blockedBy?.length ? [['Blocked by', relatedKeys(task.blockedBy)] as [string, string]] : []),
      ...(progress && progress.total > 0
        ? [['Subtasks', `${progress.done} of ${progress.total} done`] as [string, string]]
        : []),
      ...workProgressEntries(task),
    ],
    style,
  )}`;
}

/** "Criteria  4 of 6 settled (1 waived)" and the same for done items, for lists that have items. */
function workProgressEntries(task: Pick<Task, 'criteria' | 'doneItems'>): [string, string][] {
  const entries: [string, string][] = [];
  if (task.criteria?.length) entries.push(['Criteria', itemProgress(task.criteria)]);
  if (task.doneItems?.length) entries.push(['Done items', itemProgress(task.doneItems)]);
  return entries;
}

/** A titled list of items: "Acceptance criteria  4 of 6 settled" then a line per item. */
function itemSection(context: CommandContext, title: string, items: readonly WorkItem[]): string {
  const { style } = context;
  const locked = items.some((item) => item.locked) ? style.dim(' · from Backlog.md, read-only') : '';
  return `\n${style.bold(title)}  ${style.dim(itemProgress(items))}${locked}\n${itemLines(items, style)}\n`;
}

/** The two item lists, for the lists that have items. */
function itemSections(context: CommandContext, task: Pick<Task, 'criteria' | 'doneItems'>): string {
  return [
    task.criteria?.length ? itemSection(context, 'Acceptance criteria', task.criteria) : '',
    task.doneItems?.length ? itemSection(context, 'Definition of done', task.doneItems) : '',
  ].join('');
}

/** A titled Markdown text (plan, final summary) with who wrote it, indented under the title. */
function textSection(
  context: CommandContext,
  title: string,
  text: string | null | undefined,
  meta: Task['planMeta'],
): string {
  if (!text?.trim()) return '';
  const { style } = context;
  const byline = workTextByline(meta);
  return `\n${style.bold(title)}${byline ? `  ${style.dim(byline)}` : ''}\n${indentBody(text)}\n`;
}

/**
 * M3: where a mirrored or imported task comes from, the fields Backlog.md owns, and whether its
 * file is gone. Nothing for native tasks.
 */
function backlogFields(task: Task): [string, string][] {
  const entries: [string, string][] = [];
  if (task.backlog) {
    entries.push([
      'Backlog.md',
      task.backlog.file ? `${task.backlog.id}  ${task.backlog.file}` : task.backlog.id,
    ]);
  }
  if (task.locked?.length) {
    entries.push(['Locked', `${task.locked.join(', ')} (change them in Backlog.md)`]);
  }
  if (task.hidden) entries.push(['Hidden', 'its file is gone from the default branch']);
  return entries;
}

/** The value of --cycle as the API takes it: a number, current, next, or null for none. */
function cycleValue(value: string): string | null {
  const cycle = normalizeCycle(value);
  return cycle === FILTER_NONE ? null : cycle;
}

/** --due and --parent: the value as typed (trimmed), or null for none. */
function valueOrNull(value: string): string | null {
  return isNone(value) ? null : value.trim();
}

/** Today on this machine as YYYY-MM-DD, to mark overdue dates in the list (colour only). */
function localToday(): string {
  const now = new Date();
  const pad = (n: number) => String(n).padStart(2, '0');
  return `${now.getFullYear()}-${pad(now.getMonth() + 1)}-${pad(now.getDate())}`;
}

// ---------------------------------------------------------------------------
// zamu tasks list
// ---------------------------------------------------------------------------

export interface ListOptions {
  project?: string[];
  mine?: boolean;
  status?: string[];
  assignee?: string;
  milestone?: string;
  cycle?: string;
  label?: string[];
  due?: string;
  blocked?: boolean;
  topLevel?: boolean;
  parent?: string;
  sort?: string;
  limit?: string;
  cursor?: string;
}

export async function listTasks(context: CommandContext, options: ListOptions): Promise<void> {
  if (options.mine && options.assignee !== undefined) {
    throw usageError('Use either --mine or --assignee, not both.');
  }
  const milestoneNone = options.milestone !== undefined && isNone(options.milestone);
  // Only a milestone name needs a project; then this clone's project fills in for --project.
  const milestoneName =
    options.milestone !== undefined &&
    !milestoneNone &&
    !MilestoneId.safeParse(options.milestone.trim()).success;
  // Label names are looked up the same way (label ids need no project).
  const labelName = options.label?.some((value) => !LabelId.safeParse(value).success) ?? false;
  const fallback =
    !options.project?.length && (milestoneName || labelName) ? await resolveProject(context) : null;
  const projects = options.project?.length ? options.project : fallback ? [fallback.key] : undefined;
  const draft = {
    ...(projects ? { project: projects } : {}),
    ...(options.status?.length ? { status: options.status } : {}),
    ...(options.mine ? { assignee: ASSIGNEE_ME } : {}),
    ...(milestoneNone ? { milestone: FILTER_NONE } : {}),
    ...(options.cycle !== undefined ? { cycle: normalizeCycle(options.cycle) } : {}),
    ...(options.due !== undefined ? { due: normalizeChoice(options.due) } : {}),
    ...(options.blocked !== undefined ? { blocked: options.blocked } : {}),
    ...(options.topLevel ? { topLevel: true } : {}),
    ...(options.parent !== undefined ? { parent: options.parent } : {}),
    ...(options.sort !== undefined ? { sort: normalizeChoice(options.sort) } : {}),
    ...(options.limit !== undefined ? { limit: options.limit } : {}),
    ...(options.cursor !== undefined ? { cursor: options.cursor } : {}),
  };
  // Validate what we can before touching the network (and before resolving names).
  const checked = parseInput(ListTasksInput, draft);
  const client = await context.client();
  const assignee =
    options.assignee === undefined
      ? undefined
      : await resolveAssignee(client, options.assignee, { allowAgents: true });
  const milestone =
    options.milestone === undefined || milestoneNone
      ? undefined
      : await resolveMilestone(
          client,
          checked.project?.length === 1 ? checked.project[0] : undefined,
          options.milestone,
        );
  const label = options.label?.length
    ? await resolveLabelIds(client, checked.project, options.label)
    : undefined;
  const input = parseInput(ListTasksInput, {
    ...draft,
    ...(assignee ? { assignee } : {}),
    ...(milestone ? { milestone } : {}),
    ...(label ? { label } : {}),
  });
  const page = await client.tasks.list(input);

  emit(context, 'tasks.list', page, (data) => {
    const { style } = context;
    if (data.items.length === 0) {
      return input.project ? `No tasks in ${input.project.join(', ')} match.\n` : 'No tasks match.\n';
    }
    // Milestone, cycle and the M5 columns appear only when some task has a value for them.
    type Row = (typeof data.items)[number];
    const withMilestone = data.items.some((t) => t.milestone);
    const withCycle = data.items.some((t) => t.cycle);
    const optional = (header: string, value: (t: Row) => string, style?: (t: Row, cell: string) => string) =>
      data.items.some((t) => value(t) !== '') ? [{ header, value, ...(style ? { style } : {}) }] : [];
    const today = localToday();
    const rows = table(
      data.items,
      [
        { header: 'KEY', value: (t) => t.key, style: (_t, cell) => style.bold(cell) },
        {
          header: 'STATUS',
          value: (t) => statusLabel(t.status),
          style: (t, cell) => style.status(t.status, cell),
        },
        {
          header: 'PRIORITY',
          value: (t) => priorityLabel(t.priority),
          style: (t, cell) => style.priority(t.priority, cell),
        },
        { header: 'ASSIGNEE', value: (t) => assigneeLabel(t.assignee) },
        ...(withMilestone
          ? [{ header: 'MILESTONE', value: (t: (typeof data.items)[number]) => t.milestone?.name ?? '' }]
          : []),
        ...(withCycle
          ? [
              {
                header: 'CYCLE',
                value: (t: (typeof data.items)[number]) => (t.cycle ? `C${t.cycle.number}` : ''),
              },
            ]
          : []),
        ...optional(
          'DUE',
          (t) => t.dueDate ?? '',
          (t, cell) =>
            t.dueDate && t.dueDate < today && t.status !== 'done' && t.status !== 'canceled'
              ? style.warn(cell)
              : cell,
        ),
        ...optional('LABELS', (t) => (t.labels ?? []).map((l) => l.name).join(', ')),
        ...optional('PARENT', (t) => t.parentKey ?? ''),
        ...optional('SUBTASKS', (t) =>
          t.subtaskProgress && t.subtaskProgress.total > 0
            ? `${t.subtaskProgress.done}/${t.subtaskProgress.total}`
            : '',
        ),
        ...optional(
          'BLOCKED',
          (t) => (t.blocked ? 'blocked' : ''),
          (_t, cell) => style.warn(cell),
        ),
        { header: 'TITLE', value: (t) => t.title },
      ],
      style,
      context.io.columns,
    );
    const counts = TASK_STATUSES.filter((status) => data.counts[status] > 0)
      .map((status) => `${statusLabel(status)} ${data.counts[status]}`)
      .join(' · ');
    const footer = [`${data.items.length} shown${counts ? ` · ${counts}` : ''}`];
    if (data.nextCursor) footer.push(`More: add --cursor ${data.nextCursor}`);
    return `${rows}${style.dim(footer.join('\n'))}\n`;
  });
}

// ---------------------------------------------------------------------------
// zamu tasks show
// ---------------------------------------------------------------------------

/**
 * The task's timeline. A server older than M2 has no /timeline route: fall back to the activity
 * list so zamu tasks show still works there.
 */
async function loadTimeline(
  client: ApiClient,
  input: GetTaskInput,
): Promise<{ items: TimelineItem[]; counts?: TimelineCounts }> {
  try {
    const timeline = Timeline.parse(await client.tasks.timeline(input));
    return { items: timeline.items, ...(timeline.counts ? { counts: timeline.counts } : {}) };
  } catch (error) {
    if (!(error instanceof ORPCError) || error.status !== 404) throw error;
    const activity = ActivityList.parse(await client.tasks.activity(input)).items;
    return { items: activity.map((entry) => ({ ...entry, kind: 'activity' as const })) };
  }
}

/** "History · 4 notes · 2 comments · 9 changes": the timeline heading with its counts. */
function historyHeading(counts: TimelineCounts | undefined): string {
  if (!counts) return 'History';
  const part = (count: number, one: string, many: string) => `${count} ${count === 1 ? one : many}`;
  return [
    'History',
    part(counts.notes, 'note', 'notes'),
    part(counts.comments, 'comment', 'comments'),
    part(counts.history, 'change', 'changes'),
  ].join(' · ');
}

/** "Subtasks  1 of 2 done" then one line per subtask, canceled ones included. */
function subtaskEntries(task: Pick<Task, 'subtasks' | 'subtaskProgress'>): [string, string][] {
  const subtasks = task.subtasks ?? [];
  if (subtasks.length === 0) return [];
  const progress = task.subtaskProgress ?? { done: 0, total: 0 };
  return [
    ['Subtasks', `${progress.done} of ${progress.total} done`],
    ...subtasks.map((subtask): [string, string] => ['', relatedLine(subtask)]),
  ];
}

export async function showTask(
  context: CommandContext,
  key: string,
  options: { project?: string } = {},
): Promise<void> {
  const ref = await taskRef(context, key, options.project);
  parseInput(GetTaskInput, ref);
  const client = await context.client();
  const [task, loaded] = await withTaskRef(context, ref, (r) => {
    const input = parseInput(GetTaskInput, r);
    return Promise.all([client.tasks.get(input), loadTimeline(client, input)]);
  });
  const timeline = loaded.items;
  const activity = timeline.filter((item) => item.kind === 'activity');
  const counts = loaded.counts ? { timelineCounts: loaded.counts } : {};

  emit(context, 'tasks.show', { task, activity, timeline, ...counts }, (data) => {
    const { style } = context;
    const t = data.task;
    const createdBy = t.createdOnBehalfOf
      ? `${t.createdBy.name} for ${t.createdOnBehalfOf.name}`
      : t.createdBy.name;
    const parts = [
      `${style.bold(t.key)}  ${style.bold(t.title)}\n`,
      fields(
        [
          ['Status', statusField(context, t)],
          ['Priority', style.priority(t.priority, priorityLabel(t.priority))],
          ['Assignee', assigneeLabel(t.assignee)],
          ...planningFields(t),
          ...fieldEntries(t),
          ...subtaskEntries(t),
          ...relatedEntries('Blocked by', t.blockedBy ?? []),
          ...relatedEntries('Blocks', t.blocks ?? []),
          ...workProgressEntries(t),
          ['Project', `${t.project.key}  ${t.project.name}`],
          ...backlogFields(t),
          ['Created', `${formatTime(t.createdAt)} by ${createdBy}`],
          ['Updated', formatTime(t.updatedAt)],
        ],
        style,
      ),
    ];
    // As on the task page: the summary first, then the description, the lists and the plan.
    parts.push(textSection(context, 'Final summary', t.finalSummary, t.finalSummaryMeta));
    if (t.description?.trim()) parts.push(`\n${t.description.replace(/\s+$/, '')}\n`);
    parts.push(itemSections(context, t));
    parts.push(textSection(context, 'Plan', t.plan, t.planMeta));
    const history = timelineText(data.timeline ?? [], style);
    if (history) parts.push(`\n${style.dim(historyHeading(data.timelineCounts))}\n`, history);
    return parts.join('');
  });
}

// ---------------------------------------------------------------------------
// zamu tasks create
// ---------------------------------------------------------------------------

export interface CreateOptions extends CreateWorkOptions {
  project?: string;
  description?: string;
  priority?: string;
  assignee?: string;
  status?: string;
  milestone?: string;
  cycle?: string;
  label?: string[];
  due?: string;
  parent?: string;
  blockedBy?: string[];
}

export async function createTask(
  context: CommandContext,
  titleWords: string[],
  options: CreateOptions,
): Promise<void> {
  const milestoneNone = options.milestone !== undefined && isNone(options.milestone);
  checkStdinFlags(options);
  const read = stdinReader(context);
  const project = await requireProject(context, options.project);
  context.target = { ...context.target, project };
  const draft = {
    project,
    title: titleWords.join(' '),
    ...(options.description !== undefined ? { description: await read(options.description) } : {}),
    ...(options.priority !== undefined ? { priority: normalizeChoice(options.priority) } : {}),
    ...(options.status !== undefined ? { status: normalizeChoice(options.status) } : {}),
    ...(options.cycle !== undefined ? { cycle: cycleValue(options.cycle) } : {}),
    ...(options.label?.length ? { labels: options.label } : {}),
    ...(options.due !== undefined ? { dueDate: valueOrNull(options.due) } : {}),
    ...(options.parent !== undefined ? { parent: valueOrNull(options.parent) } : {}),
    ...(options.blockedBy?.length ? { blockedBy: options.blockedBy } : {}),
    ...(await createWorkFields(options, read)),
  };
  const checked = parseInput(CreateTaskInput, draft);
  const client = await context.client();
  const assignee =
    options.assignee === undefined
      ? undefined
      : await resolveAssignee(client, options.assignee, { allowAgents: false });
  const milestone =
    options.milestone === undefined || milestoneNone
      ? undefined
      : await resolveMilestone(client, checked.project, options.milestone);
  const input = parseInput(CreateTaskInput, {
    ...draft,
    ...(assignee ? { assignee } : {}),
    ...(milestone ? { milestone } : {}),
  });
  const task = await client.tasks.create(input);
  emit(
    context,
    'tasks.create',
    task,
    (data) => `${taskSummary(context, 'Created', data)}${itemSections(context, data)}`,
  );
}

// ---------------------------------------------------------------------------
// zamu tasks update
// ---------------------------------------------------------------------------

export interface UpdateOptions extends UpdateWorkOptions {
  project?: string;
  status?: string;
  priority?: string;
  assignee?: string;
  unassign?: boolean;
  title?: string;
  description?: string;
  milestone?: string;
  cycle?: string;
  label?: string[];
  removeLabel?: string[];
  due?: string;
  parent?: string;
  blockedBy?: string[];
  unblock?: string[];
  /** --waive-ac, --waive-dod and --reason in typed order (all three hold the same list). */
  waiveAc?: WaiveToken[];
  waiveDod?: WaiveToken[];
  reason?: WaiveToken[];
  /** --append-notes: a work note written after the update; repeated ones join into one note. */
  appendNotes?: string[];
}

export async function updateTask(
  context: CommandContext,
  key: string,
  options: UpdateOptions,
): Promise<void> {
  if (options.assignee !== undefined && options.unassign) {
    throw usageError('Use either --assignee or --unassign, not both.');
  }
  checkStdinFlags(options);
  const read = stdinReader(context);
  const waives = resolveWaives(options.waiveAc ?? options.waiveDod ?? options.reason ?? []);
  const milestoneNone = options.milestone !== undefined && isNone(options.milestone);
  const ref = await taskRef(context, key, options.project);
  const work = await updateWorkFields(options, waives, read);
  const notes = options.appendNotes?.length
    ? (await Promise.all(options.appendNotes.map(read))).join('\n\n')
    : undefined;
  const draft = {
    ...ref,
    ...(options.title !== undefined ? { title: options.title } : {}),
    ...(options.description !== undefined ? { description: await read(options.description) } : {}),
    ...(options.status !== undefined ? { status: normalizeChoice(options.status) } : {}),
    ...(options.priority !== undefined ? { priority: normalizeChoice(options.priority) } : {}),
    ...(options.unassign ? { assignee: null } : {}),
    ...(milestoneNone ? { milestone: null } : {}),
    ...(options.cycle !== undefined ? { cycle: cycleValue(options.cycle) } : {}),
    ...(options.label?.length ? { addLabels: options.label } : {}),
    ...(options.removeLabel?.length ? { removeLabels: options.removeLabel } : {}),
    ...(options.due !== undefined ? { dueDate: valueOrNull(options.due) } : {}),
    ...(options.parent !== undefined ? { parent: valueOrNull(options.parent) } : {}),
    ...(options.blockedBy?.length ? { addBlockers: options.blockedBy } : {}),
    ...(options.unblock?.length ? { removeBlockers: options.unblock } : {}),
    ...work,
  };
  if (typeof draft.status === 'string') context.target = { ...context.target, status: draft.status };
  const changes = Object.keys(draft).some((name) => name !== 'key' && name !== 'project');
  const stub = {
    ...(options.assignee !== undefined ? { assignee: ASSIGNEE_ME } : {}),
    ...(options.milestone !== undefined ? { milestone: null } : {}),
  };

  // Only --append-notes: the note is the whole command.
  if (notes !== undefined && !changes && Object.keys(stub).length === 0) {
    parseInput(CreateCommentInput, { ...ref, body: notes, kind: 'note' });
    const client = await context.client();
    const note = await postNote(context, client, ref, notes);
    emit(context, 'notes.add', note, (data) => noteSummary(context, data));
    return;
  }
  if (notes !== undefined) parseInput(CreateCommentInput, { ...ref, body: notes, kind: 'note' });

  // `me` and null stand in for names still to be resolved, so "change at least one field" passes.
  parseInput(UpdateTaskInput, { ...draft, ...stub });
  const client = await context.client();
  const assignee =
    options.assignee === undefined
      ? undefined
      : await resolveAssignee(client, options.assignee, { allowAgents: false });
  // Milestone names are looked up in the task's own project, so a name needs the task first (a
  // Backlog.md id does not name its project). Its app key then addresses the update.
  let target: TaskRef = ref;
  let milestone: string | undefined;
  if (options.milestone !== undefined && !milestoneNone) {
    const value = options.milestone;
    if (MilestoneId.safeParse(value.trim()).success) milestone = value.trim();
    else {
      const current = await withTaskRef(context, ref, (r) => client.tasks.get(parseInput(GetTaskInput, r)));
      target = { key: current.key };
      context.target = { ...context.target, task: target };
      milestone = await resolveMilestone(client, current.project.key, value);
    }
  }
  const task = await withTaskRef(context, target, (r) =>
    client.tasks.update(
      parseInput(UpdateTaskInput, {
        ...draft,
        key: r.key,
        project: r.project,
        ...(assignee ? { assignee } : {}),
        ...(milestone ? { milestone } : {}),
      }),
    ),
  ).catch((error: unknown) =>
    // Offline queue (M6): an update queued because the server didn't answer queues its note behind it.
    notes === undefined
      ? Promise.reject(error)
      : queueBehind(error, 'comments.create', { ...target, body: notes, kind: 'note' }),
  );
  // The note goes after the update, so a refused update writes no note.
  const note = notes === undefined ? null : await postNote(context, client, { key: task.key }, notes);
  emit(context, 'tasks.update', task, (data) =>
    [
      taskSummary(context, 'Updated', data),
      touchesItems(work) ? itemSections(context, data) : '',
      note ? `\nAdded note ${context.style.bold(note.id)}\n` : '',
    ].join(''),
  );
}
