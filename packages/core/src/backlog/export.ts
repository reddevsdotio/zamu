// M6: a project written out as Backlog.md files (GET /projects/{project}/backlog/export). Native
// projects and projects switched to Zamu only: every task goes to tasks/, where Backlog.md itself keeps
// Done tasks, and milestones to milestones/, paths relative to the Backlog.md folder. The legacy
// completed/ folder stays in removedPrefixes so old copies of the same tasks are pruned. Hidden tasks are
// left out (their files are gone). Rows are read here directly; the files come from the writer in
// @zamu/backlog-md, which this package's reader and the Backlog.md CLI both read.
import {
  BACKLOG_FILE_FORMAT,
  formatImplementationNotes,
  milestoneFileName,
  type NoteEntry,
  type TaskFileInput,
  taskFileName,
  type WorkRecordItem,
  writeMilestoneFile,
  writeTaskFile,
} from '@zamu/backlog-md';
import {
  BACKLOG_EXPORT_PREFIXES,
  BacklogExport,
  type BacklogMappings,
  ExportBacklogInput,
  PRIORITIES,
  type Priority,
  priorityFromValue,
  TASK_STATUSES,
  type TaskStatus,
} from '@zamu/contracts';
import { type DbOrTx, schema } from '@zamu/db';
import { and, asc, eq, inArray, isNull } from 'drizzle-orm';
import type { z } from 'zod';
import { compareLabelNames } from '../activity';
import type { Actor } from '../authz';
import type { DbContext } from '../context';
import { clockNow } from '../cycles';
import { ProjectMirrored, parseInput } from '../errors';
import { findProjectByKey, loadBacklogSource, loadUsers, sourceMirrors } from '../internal';
import { readStoredBlock } from './plan';
import { storedMappings } from './refresh';

const { comment, label, milestone, task, taskDependency, taskItem, taskLabel } = schema;

/** Status names Backlog.md shows when the project's own Backlog.md names are not known. */
const STATUS_NAMES: Record<TaskStatus, string> = {
  backlog: 'Backlog',
  todo: 'To Do',
  in_progress: 'In Progress',
  in_review: 'In Review',
  done: 'Done',
  canceled: 'Canceled',
};

/** Mentions are stored as [@Name](mention:<id>); the file gets @Name. */
function plainMentions(body: string): string {
  return body.replace(/\[(@[^\]\n]+)\]\(mention:[^)\s]+\)/g, '$1');
}

/**
 * The Backlog.md value for each app value: the first row of the switched mirror's mappings that
 * maps to it (rows the setup or a person chose, before fallbacks), else the default name.
 */
function reverseMappings(mappings: BacklogMappings | null) {
  const statuses = new Map<TaskStatus, string>();
  const priorities = new Map<Priority, string>();
  const rows = <T extends { how: string }>(list: T[]) => [
    ...list.filter((row) => row.how !== 'fallback'),
    ...list.filter((row) => row.how === 'fallback'),
  ];
  for (const row of rows(mappings?.status ?? [])) if (!statuses.has(row.to)) statuses.set(row.to, row.from);
  for (const row of rows(mappings?.priority ?? [])) {
    if (!priorities.has(row.to)) priorities.set(row.to, row.from);
  }
  for (const status of TASK_STATUSES) if (!statuses.has(status)) statuses.set(status, STATUS_NAMES[status]);
  for (const priority of PRIORITIES)
    if (!priorities.has(priority) && priority !== 'none') priorities.set(priority, priority);
  return {
    status: (status: TaskStatus) => statuses.get(status) as string,
    priority: (priority: Priority) => (priority === 'none' ? null : (priorities.get(priority) ?? priority)),
  };
}

interface ProjectRows {
  tasks: (typeof task.$inferSelect)[];
  items: {
    taskId: string;
    kind: 'criterion' | 'done';
    text: string;
    state: WorkRecordItem['state'];
    waivedReason: string | null;
  }[];
  notes: {
    taskId: string;
    authorId: string;
    onBehalfOfId: string | null;
    body: string | null;
    createdAt: Date;
  }[];
  labels: { taskId: string; name: string }[];
  blockers: { taskId: string; blockerId: string }[];
  milestones: (typeof milestone.$inferSelect)[];
}

async function loadRows(db: DbOrTx, projectId: string): Promise<ProjectRows> {
  const inProject = db.select({ id: task.id }).from(task).where(eq(task.projectId, projectId));
  const [tasks, items, notes, labels, blockers, milestones] = await Promise.all([
    db.select().from(task).where(eq(task.projectId, projectId)),
    db
      .select({
        taskId: taskItem.taskId,
        kind: taskItem.kind,
        text: taskItem.text,
        state: taskItem.state,
        waivedReason: taskItem.waivedReason,
      })
      .from(taskItem)
      .where(inArray(taskItem.taskId, inProject))
      .orderBy(asc(taskItem.taskId), asc(taskItem.kind), asc(taskItem.position)),
    db
      .select({
        taskId: comment.taskId,
        authorId: comment.authorId,
        onBehalfOfId: comment.onBehalfOfId,
        body: comment.body,
        createdAt: comment.createdAt,
      })
      .from(comment)
      .where(and(eq(comment.projectId, projectId), eq(comment.kind, 'note'), isNull(comment.deletedAt)))
      .orderBy(asc(comment.createdAt), asc(comment.id)),
    db
      .select({ taskId: taskLabel.taskId, name: label.name })
      .from(taskLabel)
      .innerJoin(label, eq(label.id, taskLabel.labelId))
      .where(eq(label.projectId, projectId)),
    db
      .select({ taskId: taskDependency.taskId, blockerId: taskDependency.blockerId })
      .from(taskDependency)
      .where(inArray(taskDependency.taskId, inProject)),
    db
      .select()
      .from(milestone)
      .where(and(eq(milestone.projectId, projectId), isNull(milestone.hiddenAt)))
      .orderBy(asc(milestone.createdAt), asc(milestone.id)),
  ]);
  return { tasks, items, notes, labels, blockers, milestones };
}

function groupBy<T, K>(rows: T[], key: (row: T) => K): Map<K, T[]> {
  const map = new Map<K, T[]>();
  for (const row of rows) {
    const list = map.get(key(row)) ?? [];
    list.push(row);
    map.set(key(row), list);
  }
  return map;
}

/**
 * The project as Backlog.md files. Readable by anyone who may read the project; ProjectMirrored
 * (409 PROJECT_MIRRORED) while it still mirrors, since the files are the truth then. Task ids use
 * the switched mirror's Backlog.md prefix (else the letters of the project key) and the task's
 * number, so a re-import keeps every number. removedPrefixes lists the three folders the export owns.
 */
export async function exportBacklog(
  ctx: DbContext,
  actor: Actor,
  input: z.input<typeof ExportBacklogInput>,
): Promise<BacklogExport> {
  const parsed = parseInput(ExportBacklogInput, input);
  const { db } = ctx;
  const projectRow = await findProjectByKey(db, actor, parsed.project);
  const source = await loadBacklogSource(db, projectRow.id);
  if (sourceMirrors(source)) {
    throw new ProjectMirrored(
      `${projectRow.key} still mirrors Backlog.md, so its files are the truth. Switch it to Zamu in Settings > Backlog.md first.`,
    );
  }
  const rows = await loadRows(db, projectRow.id);
  // Backlog.md prefixes are letters only (PAY2 writes PAY-12); a switched mirror keeps its own.
  const prefix = (source?.prefix ?? projectRow.key).toUpperCase().replace(/[^A-Z]/g, '') || 'TASK';
  const names = reverseMappings(source ? storedMappings(source) : null);

  const idOf = new Map<string, string>();
  for (const row of rows.tasks) {
    idOf.set(row.id, `${prefix}-${row.number}${row.keySuffix ? `.${row.keySuffix}` : ''}`);
  }
  const visible = rows.tasks.filter((row) => row.hiddenAt === null);
  const visibleIds = new Set(visible.map((row) => row.id));

  // Milestones keep their Backlog.md id (m-3); the others get the next free numbers in order.
  const milestoneIds = new Map<string, string>();
  let nextMilestone = 0;
  for (const row of rows.milestones) {
    const match = row.backlogId ? /^m-(\d+)$/.exec(row.backlogId) : null;
    if (match) nextMilestone = Math.max(nextMilestone, Number(match[1]) + 1);
  }
  for (const row of rows.milestones) {
    const keep = row.backlogId && /^m-\d+$/.test(row.backlogId);
    milestoneIds.set(row.id, keep ? (row.backlogId as string) : `m-${nextMilestone++}`);
  }

  const userIds = new Set<string>();
  for (const row of visible) if (row.assigneeId) userIds.add(row.assigneeId);
  for (const note of rows.notes) {
    userIds.add(note.authorId);
    if (note.onBehalfOfId) userIds.add(note.onBehalfOfId);
  }
  const users = await loadUsers(db, userIds);
  const userName = (id: string | null) => (id ? (users.get(id)?.name ?? null) : null);

  const itemsOf = groupBy(rows.items, (row) => `${row.taskId}:${row.kind}`);
  const notesOf = groupBy(rows.notes, (row) => row.taskId);
  const labelsOf = groupBy(rows.labels, (row) => row.taskId);
  const blockersOf = groupBy(rows.blockers, (row) => row.taskId);
  const list = (taskId: string, kind: 'criterion' | 'done'): WorkRecordItem[] =>
    (itemsOf.get(`${taskId}:${kind}`) ?? []).map((item) => ({
      text: item.text,
      state: item.state,
      waivedReason: item.state === 'waived' ? item.waivedReason : null,
    }));

  const files: { path: string; content: string }[] = [];
  for (const row of visible) {
    const block = readStoredBlock(row.backlogData);
    const id = idOf.get(row.id) as string;
    // The value the file had for the current assignee, else @name; values that matched no one stay.
    const assignees: string[] = [];
    if (row.assigneeId) {
      const kept = block?.assignees.find((entry) => entry.userId === row.assigneeId)?.value;
      const name = userName(row.assigneeId);
      if (kept) assignees.push(kept);
      else if (name) assignees.push(`@${name}`);
    }
    for (const entry of block?.assignees ?? []) {
      if (entry.userId === null && !assignees.includes(entry.value)) assignees.push(entry.value);
    }
    const notes: NoteEntry[] = (notesOf.get(row.id) ?? []).flatMap((note) =>
      note.body === null
        ? []
        : [
            {
              author: userName(note.authorId) ?? 'Someone',
              onBehalfOf: userName(note.onBehalfOfId),
              at: note.createdAt,
              body: plainMentions(note.body),
            },
          ],
    );
    const input: TaskFileInput = {
      id,
      title: row.title,
      status: names.status(row.status),
      assignees,
      reporter: block?.reporter ?? null,
      createdDate: row.createdAt,
      updatedDate: row.updatedAt,
      labels: (labelsOf.get(row.id) ?? []).sort(compareLabelNames).map((entry) => entry.name),
      milestone: row.milestoneId ? (milestoneIds.get(row.milestoneId) ?? null) : null,
      dependencies: (blockersOf.get(row.id) ?? [])
        .filter((entry) => visibleIds.has(entry.blockerId))
        .map((entry) => idOf.get(entry.blockerId) as string)
        .sort(),
      parentId: row.parentId ? (idOf.get(row.parentId) ?? null) : null,
      priority: names.priority(priorityFromValue(row.priority)),
      dueDate: row.dueDate,
      type: block?.type ?? null,
      references: block?.references ?? [],
      documentation: block?.documentation ?? [],
      modifiedFiles: block?.modifiedFiles ?? [],
      ordinal: row.rank,
      other: block?.other ?? {},
      description: row.description,
      criteria: list(row.id, 'criterion'),
      doneItems: list(row.id, 'done'),
      plan: row.plan,
      implementationNotes: formatImplementationNotes(notes, block?.implementationNotes ?? null),
      finalSummary: row.finalSummary,
    };
    files.push({ path: `tasks/${taskFileName(id, row.title)}`, content: writeTaskFile(input) });
  }
  for (const row of rows.milestones) {
    const id = milestoneIds.get(row.id) as string;
    files.push({
      path: `milestones/${milestoneFileName(id, row.name)}`,
      content: writeMilestoneFile({
        id,
        title: row.name,
        description: row.description,
        dueDate: row.targetDate,
      }),
    });
  }
  files.sort((a, b) => (a.path < b.path ? -1 : a.path > b.path ? 1 : 0));

  return BacklogExport.parse({
    project: projectRow.key,
    format: BACKLOG_FILE_FORMAT,
    generatedAt: clockNow(ctx).toISOString(),
    files,
    removedPrefixes: [...BACKLOG_EXPORT_PREFIXES],
  });
}
