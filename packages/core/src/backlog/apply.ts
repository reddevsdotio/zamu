// Applies a refresh plan (./plan) in the caller's transaction: milestone, label and task rows, the
// tasks' labels, parents and blockers (M5), the project's next task number, backlog_file rows,
// activity from the Backlog.md actor (origin backlog, origin_ref = commit) and the source state.
// M6: the work record too (plan and final summary columns, task_item rows).
// M7: archived_at follows the archive folder (task.archived and task.unarchived rows), closed_at follows
// status changes, and a move to Done or Canceled clears the check-again day with a history line.
// Rows are written directly with Drizzle; services' owned-field locks do not apply to the refresh
// itself.
import type { WorkRecordItem } from '@zamu/backlog-md';
import { type BacklogMode, type BacklogTrigger, isOpenStatus, type WorkItemKind } from '@zamu/contracts';
import { schema, type Tx } from '@zamu/db';
import { and, eq, inArray, isNotNull, notInArray, type SQL, sql } from 'drizzle-orm';
import {
  recordActivities,
  recordActivity,
  type StoredChange,
  type StoredLabelRef,
  type StoredTaskRef,
  type SystemActivityEntry,
} from '../activity';
import { labelKey } from './fields';
import type {
  BacklogPlan,
  ClosedAtChange,
  ExistingFile,
  FileRow,
  LabelTarget,
  MilestoneTarget,
  PlannedChange,
  PlannedLabelRef,
  PlannedTaskRef,
  TaskTarget,
  TaskValues,
} from './plan';

const { backlogFile, backlogSource, label, milestone, project, task, taskDependency, taskItem, taskLabel } =
  schema;

export type BacklogSourceRow = typeof backlogSource.$inferSelect;
export type ProjectRow = typeof project.$inferSelect;

/** Rows per insert statement. */
const CHUNK = 500;
/** Temporary numbers for tasks whose number changes (draft moves), clear of real numbers. */
const TEMP_NUMBER_BASE = 2_000_000_000;

function chunks<T>(items: T[], size = CHUNK): T[][] {
  const out: T[][] = [];
  for (let index = 0; index < items.length; index += size) out.push(items.slice(index, index + size));
  return out;
}

/** M7: the history line of a check-again day cleared because the task closed. */
function checkAgainChange(cleared: { on: string; reason: string }): StoredChange {
  return { field: 'checkAgain', from: cleared, to: null };
}

/**
 * M5: the project's Backlog.md labels become app labels (names editable). Detach and imports call
 * it; the labels stay on their tasks.
 */
export async function releaseBacklogLabels(tx: Tx, projectId: string): Promise<void> {
  await tx
    .update(label)
    .set({ source: 'app' })
    .where(and(eq(label.projectId, projectId), eq(label.source, 'backlog')));
}

export interface ApplyInput {
  source: BacklogSourceRow;
  project: ProjectRow;
  plan: BacklogPlan;
  /** backlog_file rows of the previous read. */
  previousFiles: ExistingFile[];
  trigger: BacklogTrigger;
  defaultBranch: string;
  headCommit: string;
  /** Short form of the repository, for the imported activity row. */
  repository: string | null;
  now: Date;
}

export interface ApplyResult {
  created: number;
  updated: number;
  hidden: number;
  restored: number;
  milestonesCreated: number;
  /** M7: tasks archived (created in the archive folder or moved into it) and taken out of it. */
  archived: number;
  unarchived: number;
  /** True when the source was an import and is detached now. */
  detached: boolean;
}

function sameFileRow(a: ExistingFile, b: Omit<ExistingFile, 'path'>): boolean {
  return (
    a.blobSha === b.blobSha &&
    a.kind === b.kind &&
    a.backlogId === b.backlogId &&
    a.taskId === b.taskId &&
    a.milestoneId === b.milestoneId &&
    a.error === b.error
  );
}

/** Applies `plan`. Call inside one transaction; a failure anywhere rolls everything back. */
export async function applyPlan(tx: Tx, input: ApplyInput): Promise<ApplyResult> {
  const { source, plan, now } = input;
  // Lock order: project, then tasks (as the task services do).
  await tx.select({ id: project.id }).from(project).where(eq(project.id, input.project.id)).for('update');

  // Milestones ------------------------------------------------------------------------------------
  const milestoneIds = new Map<string, string>();
  for (const batch of chunks(plan.milestones.creates)) {
    const rows = await tx
      .insert(milestone)
      .values(
        batch.map((values) => ({
          workspaceId: input.project.workspaceId,
          projectId: input.project.id,
          createdById: source.createdById,
          backlogId: values.backlogId,
          name: values.name,
          description: values.description,
          targetDate: values.targetDate,
          status: values.status,
          completedAt: values.completedAt,
        })),
      )
      .returning({ id: milestone.id, backlogId: milestone.backlogId });
    for (const row of rows) if (row.backlogId) milestoneIds.set(row.backlogId, row.id);
  }
  for (const update of plan.milestones.updates) {
    await tx
      .update(milestone)
      .set({ ...update.set, ...(update.restore ? { hiddenAt: null } : {}) })
      .where(eq(milestone.id, update.id));
  }
  if (plan.milestones.hides.length > 0) {
    await tx
      .update(milestone)
      .set({ hiddenAt: now })
      .where(
        inArray(
          milestone.id,
          plan.milestones.hides.map((row) => row.id),
        ),
      );
  }
  const milestoneId = (target: MilestoneTarget | null): string | null => {
    if (!target) return null;
    if ('id' in target) return target.id;
    const id = milestoneIds.get(target.backlogId);
    if (!id) throw new Error(`milestone ${target.backlogId} was not created`);
    return id;
  };

  // Labels (M5) -------------------------------------------------------------------------------------
  // Created on use with source backlog; a label someone created meanwhile with the same name wins
  // (and keeps its colour). App labels the files use turn into backlog labels.
  if (plan.labels.creates.length > 0) {
    await tx
      .insert(label)
      .values(
        plan.labels.creates.map((values) => ({
          workspaceId: input.project.workspaceId,
          projectId: input.project.id,
          name: values.name,
          color: values.color,
          source: 'backlog' as const,
        })),
      )
      .onConflictDoNothing();
  }
  const labelIds = new Map<string, string>();
  const adopt = new Set(plan.labels.adopt.map((row) => row.id));
  const createdNames = new Set(plan.labels.creates.map((values) => labelKey(values.name)));
  if (createdNames.size > 0) {
    const rows = await tx
      .select({ id: label.id, name: label.name, source: label.source })
      .from(label)
      .where(eq(label.projectId, input.project.id));
    for (const row of rows) {
      const key = labelKey(row.name);
      if (!createdNames.has(key)) continue;
      labelIds.set(key, row.id);
      if (row.source !== 'backlog') adopt.add(row.id);
    }
  }
  if (adopt.size > 0) {
    await tx
      .update(label)
      .set({ source: 'backlog' })
      .where(inArray(label.id, [...adopt]));
  }
  const labelIdOf = async (target: LabelTarget): Promise<string> => {
    if ('id' in target) return target.id;
    const key = labelKey(target.name);
    const known = labelIds.get(key);
    if (known) return known;
    // JavaScript and Postgres may fold case differently for a few letters: ask Postgres.
    const [row] = await tx
      .select({ id: label.id })
      .from(label)
      .where(and(eq(label.projectId, input.project.id), sql`lower(${label.name}) = lower(${target.name})`))
      .limit(1);
    if (!row) throw new Error(`label ${target.name} was not created`);
    labelIds.set(key, row.id);
    return row.id;
  };

  // Tasks -------------------------------------------------------------------------------------------
  // Rows first; parents, labels and blockers once every row exists.
  const taskColumns = (values: Partial<TaskValues>) => {
    const {
      milestone: target,
      labels: _labels,
      blockers: _blockers,
      parent: _parent,
      criteria: _criteria,
      doneItems: _doneItems,
      ...rest
    } = values;
    return { ...rest, ...(target !== undefined ? { milestoneId: milestoneId(target) } : {}) };
  };
  // Number changes go through temporary numbers so two moves never collide on the unique key.
  const renumbered = plan.tasks.updates.filter((update) => update.set.number !== undefined);
  for (const [index, update] of renumbered.entries()) {
    await tx
      .update(task)
      .set({ number: TEMP_NUMBER_BASE + index, updatedAt: sql`${task.updatedAt}` })
      .where(eq(task.id, update.id));
  }
  // M7: closing tasks lose their check-again day; the history line names the one they had.
  const closing = plan.tasks.updates
    .filter((update) => update.set.status !== undefined && !isOpenStatus(update.set.status))
    .map((update) => update.id);
  const checkAgainCleared = new Map<string, { on: string; reason: string }>();
  for (const batch of chunks(closing)) {
    const rows = await tx
      .select({ id: task.id, on: task.checkAgainOn, reason: task.checkAgainReason })
      .from(task)
      .where(and(inArray(task.id, batch), isNotNull(task.checkAgainOn)));
    for (const row of rows) {
      if (row.on !== null) checkAgainCleared.set(row.id, { on: row.on, reason: row.reason ?? '' });
    }
  }
  const at = sql`${now.toISOString()}::timestamptz`;
  const closedColumns = (change: ClosedAtChange | undefined) => {
    switch (change) {
      case 'close':
        return { closedAt: sql`coalesce(${task.closedAt}, ${at})` };
      case 'clear':
        return { closedAt: null };
      case 'reset':
        return { closedAt: now };
      default:
        return {};
    }
  };
  let restored = 0;
  for (const update of plan.tasks.updates) {
    if (update.restore) restored += 1;
    const columns = {
      ...taskColumns(update.set),
      ...(update.restore ? { hiddenAt: null } : {}),
      // An archived task keeps its first archived_at; Backlog.md archives by no one.
      ...(update.archived === true ? { archivedAt: sql`coalesce(${task.archivedAt}, ${at})` } : {}),
      ...(update.archived === false ? { archivedAt: null, archivedById: null } : {}),
      ...closedColumns(update.closedAt),
      ...(checkAgainCleared.has(update.id) ? { checkAgainOn: null, checkAgainReason: null } : {}),
    };
    await tx
      .update(task)
      // A change of labels, blockers or parent alone still counts as an update of the task.
      .set(Object.keys(columns).length > 0 ? columns : { updatedAt: new Date() })
      .where(eq(task.id, update.id));
  }
  if (plan.tasks.hides.length > 0) {
    await tx
      .update(task)
      .set({ hiddenAt: now })
      .where(
        inArray(
          task.id,
          plan.tasks.hides.map((row) => row.id),
        ),
      );
  }
  const taskIds = new Map<string, string>();
  for (const batch of chunks(plan.tasks.creates)) {
    const rows = await tx
      .insert(task)
      .values(
        batch.map((values) => ({
          projectId: input.project.id,
          createdById: source.createdById,
          number: values.number,
          keySuffix: values.keySuffix,
          backlogId: values.backlogId,
          title: values.title,
          description: values.description,
          status: values.status,
          priority: values.priority,
          assigneeId: values.assigneeId,
          milestoneId: milestoneId(values.milestone),
          createdAt: values.createdAt,
          backlogData: values.backlogData as Record<string, unknown>,
          rank: values.rank,
          dueDate: values.dueDate,
          plan: values.plan,
          finalSummary: values.finalSummary,
          closedAt: isOpenStatus(values.status) ? null : now,
          archivedAt: values.archived ? now : null,
        })),
      )
      .returning({ id: task.id, backlogId: task.backlogId });
    for (const row of rows) if (row.backlogId) taskIds.set(row.backlogId, row.id);
  }

  // Parents, labels and blockers (M5) ----------------------------------------------------------------
  const taskIdOf = (target: TaskTarget): string => {
    if ('id' in target) return target.id;
    const id = taskIds.get(target.backlogId);
    if (!id) throw new Error(`task ${target.backlogId} was not created`);
    return id;
  };
  const relations: { taskId: string; values: Partial<TaskValues>; created: boolean }[] = [
    ...plan.tasks.updates.map((update) => ({ taskId: update.id, values: update.set, created: false })),
    ...plan.tasks.creates.map((values) => ({
      taskId: taskIdOf({ backlogId: values.backlogId }),
      values,
      created: true,
    })),
  ];
  const parents: SQL[] = [];
  const labelRows: { taskId: string; labelId: string }[] = [];
  const blockerRows: { taskId: string; blockerId: string }[] = [];
  const relabelled: string[] = [];
  const reblocked: string[] = [];
  for (const { taskId, values, created } of relations) {
    if (values.parent !== undefined && (values.parent !== null || !created)) {
      const parentId = values.parent ? taskIdOf(values.parent) : null;
      parents.push(sql`(${taskId}::uuid, ${parentId}::uuid)`);
    }
    if (values.labels !== undefined) {
      if (!created) relabelled.push(taskId);
      for (const target of values.labels) labelRows.push({ taskId, labelId: await labelIdOf(target) });
    }
    if (values.blockers !== undefined) {
      if (!created) reblocked.push(taskId);
      for (const target of values.blockers) blockerRows.push({ taskId, blockerId: taskIdOf(target) });
    }
  }
  for (const batch of chunks(parents)) {
    await tx.execute(sql`
      update ${task} set parent_id = v.parent_id
      from (values ${sql.join(batch, sql`, `)}) as v(id, parent_id)
      where ${task.id} = v.id`);
  }
  for (const batch of chunks(relabelled)) await tx.delete(taskLabel).where(inArray(taskLabel.taskId, batch));
  for (const batch of chunks(labelRows)) await tx.insert(taskLabel).values(batch).onConflictDoNothing();
  for (const batch of chunks(reblocked)) {
    await tx.delete(taskDependency).where(inArray(taskDependency.taskId, batch));
  }
  for (const batch of chunks(blockerRows)) {
    await tx.insert(taskDependency).values(batch).onConflictDoNothing();
  }

  // Criteria and done items (M6) -------------------------------------------------------------------
  // A changed list replaces the task's rows of that kind. Items keep source backlog while the
  // project mirrors; an import detaches below, so its items are the app's from the start.
  const itemSource = source.mode === 'mirror' ? ('backlog' as const) : ('app' as const);
  const itemRows: (typeof taskItem.$inferInsert)[] = [];
  const replaced: { taskId: string; kind: WorkItemKind }[] = [];
  const addItems = (taskId: string, kind: WorkItemKind, items: WorkRecordItem[]) => {
    for (const [index, item] of items.entries()) {
      itemRows.push({
        taskId,
        kind,
        position: index + 1,
        text: item.text,
        state: item.state,
        waivedReason: item.state === 'waived' ? (item.waivedReason ?? '') : null,
        source: itemSource,
      });
    }
  };
  for (const { taskId, values, created } of relations) {
    for (const [kind, items] of [
      ['criterion', values.criteria],
      ['done', values.doneItems],
    ] as const) {
      if (items === undefined) continue;
      if (!created) replaced.push({ taskId, kind });
      addItems(taskId, kind, items);
    }
  }
  for (const kind of ['criterion', 'done'] as const) {
    const ids = replaced.filter((entry) => entry.kind === kind).map((entry) => entry.taskId);
    for (const batch of chunks(ids)) {
      await tx.delete(taskItem).where(and(inArray(taskItem.taskId, batch), eq(taskItem.kind, kind)));
    }
  }
  for (const batch of chunks(itemRows)) await tx.insert(taskItem).values(batch);

  // Activity --------------------------------------------------------------------------------------------
  const origin = {
    origin: 'backlog' as const,
    originRef: plan.commit,
    workspaceId: input.project.workspaceId,
  };
  if (plan.firstRead) {
    if (plan.tasks.creates.length + plan.milestones.creates.length > 0 || source.mode === 'import') {
      await recordActivity(tx, null, {
        ...origin,
        projectId: input.project.id,
        type: 'project.backlog_imported',
        details: {
          mode: source.mode as BacklogMode,
          repository: input.repository,
          tasks: plan.tasks.creates.length,
          milestones: plan.milestones.creates.length,
        },
      });
    }
  } else {
    const entries: SystemActivityEntry[] = [];
    const storedLabel = async (ref: PlannedLabelRef): Promise<StoredLabelRef> => ({
      id: await labelIdOf(ref.label),
      name: ref.name,
    });
    const storedTask = (ref: PlannedTaskRef): StoredTaskRef => ({
      id: taskIdOf(ref.task),
      key: ref.key,
      title: ref.title,
    });
    const stored = async (change: PlannedChange): Promise<StoredChange> => {
      switch (change.field) {
        case 'milestone':
          return { field: 'milestone', from: change.from, to: milestoneId(change.to) };
        case 'labels':
          return {
            field: 'labels',
            from: await Promise.all(change.from.map(storedLabel)),
            to: await Promise.all(change.to.map(storedLabel)),
          };
        case 'blockedBy':
          return { field: 'blockedBy', from: change.from.map(storedTask), to: change.to.map(storedTask) };
        case 'parent':
          return {
            field: 'parent',
            from: change.from ? storedTask(change.from) : null,
            to: change.to ? storedTask(change.to) : null,
          };
        default:
          return change;
      }
    };
    const entry = (
      taskId: string,
      type: SystemActivityEntry['type'],
      changes: StoredChange[] = [],
    ): SystemActivityEntry => ({ ...origin, projectId: input.project.id, taskId, type, changes });
    // Per task: out of the archive first, then the changes, then into the archive.
    for (const update of plan.tasks.updates) {
      const changes: StoredChange[] = [];
      for (const change of update.changes) changes.push(await stored(change));
      const cleared = checkAgainCleared.get(update.id);
      if (cleared) changes.push(checkAgainChange(cleared));
      if (update.archived === false) entries.push(entry(update.id, 'task.unarchived'));
      if (update.restore) entries.push(entry(update.id, 'task.restored', changes));
      else if (changes.length > 0) entries.push(entry(update.id, 'task.updated', changes));
      if (update.archived === true) entries.push(entry(update.id, 'task.archived'));
    }
    for (const hide of plan.tasks.hides) entries.push(entry(hide.id, 'task.hidden'));
    for (const created of plan.tasks.creates) {
      const taskId = taskIds.get(created.backlogId) as string;
      entries.push(entry(taskId, 'task.created'));
      if (created.archived) entries.push(entry(taskId, 'task.archived'));
    }
    for (const batch of chunks(entries)) await recordActivities(tx, null, batch);
  }

  // backlog_file rows -------------------------------------------------------------------------------------
  const resolveTask = (ref: FileRow['task']) =>
    ref === null ? null : 'id' in ref ? ref.id : (taskIds.get(ref.backlogId) ?? null);
  const previousByPath = new Map(input.previousFiles.map((file) => [file.path, file]));
  const changedRows = plan.files
    .map((file) => ({
      sourceId: source.id,
      path: file.path,
      blobSha: file.blobSha,
      kind: file.kind,
      backlogId: file.backlogId,
      taskId: resolveTask(file.task),
      milestoneId: file.milestone ? milestoneId(file.milestone) : null,
      error: file.error,
      seenAt: now,
    }))
    .filter((row) => {
      const previous = previousByPath.get(row.path);
      return !previous || !sameFileRow(previous, row);
    });
  const paths = plan.files.map((file) => file.path);
  await tx
    .delete(backlogFile)
    .where(
      paths.length > 0
        ? and(eq(backlogFile.sourceId, source.id), notInArray(backlogFile.path, paths))
        : eq(backlogFile.sourceId, source.id),
    );
  for (const batch of chunks(changedRows)) {
    await tx
      .insert(backlogFile)
      .values(batch)
      .onConflictDoUpdate({
        target: [backlogFile.sourceId, backlogFile.path],
        set: {
          blobSha: sql`excluded.blob_sha`,
          kind: sql`excluded.kind`,
          backlogId: sql`excluded.backlog_id`,
          taskId: sql`excluded.task_id`,
          milestoneId: sql`excluded.milestone_id`,
          error: sql`excluded.error`,
          seenAt: sql`excluded.seen_at`,
        },
      });
  }
  if (changedRows.length < plan.files.length) {
    await tx.update(backlogFile).set({ seenAt: now }).where(eq(backlogFile.sourceId, source.id));
  }

  // Project and source ----------------------------------------------------------------------------------------
  await tx
    .update(project)
    .set({
      nextTaskNumber: sql`greatest(${project.nextTaskNumber}, ${plan.nextTaskNumber})`,
      updatedAt: sql`${project.updatedAt}`,
    })
    .where(eq(project.id, input.project.id));

  const detach = source.mode === 'import';
  await tx
    .update(backlogSource)
    .set({
      state: detach ? 'detached' : plan.problems.length > 0 ? 'warnings' : 'healthy',
      folder: plan.folder,
      prefix: plan.config.taskPrefix,
      config: plan.config,
      defaultBranch: input.defaultBranch,
      headCommit: input.headCommit,
      lastReadCommit: plan.commit,
      lastReadAt: now,
      lastTrigger: input.trigger,
      lastError: null,
      warnings: plan.problems,
      ...(detach ? { detachedAt: now, detachedById: source.createdById, webhookSecretCiphertext: null } : {}),
    })
    .where(eq(backlogSource.id, source.id));
  if (detach) await releaseBacklogLabels(tx, input.project.id);

  return {
    created: plan.tasks.creates.length,
    updated: plan.tasks.updates.length - restored,
    hidden: plan.tasks.hides.length,
    restored,
    milestonesCreated: plan.milestones.creates.length,
    archived:
      plan.tasks.updates.filter((update) => update.archived === true).length +
      plan.tasks.creates.filter((values) => values.archived).length,
    unarchived: plan.tasks.updates.filter((update) => update.archived === false).length,
    detached: detach,
  };
}
