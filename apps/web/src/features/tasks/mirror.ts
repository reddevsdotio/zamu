import type { Activity, ProjectActivity, Task, TaskListItem, TaskOwnedField } from '@zamu/contracts';

// Mirrored tasks: which fields Backlog.md owns, the history sentences for Backlog.md and project-level
// entries, the comment box note, and the fields of "From the file".

/** What the screens need to know about a task's Backlog.md origin. */
export interface MirrorInfo {
  /** Owned fields locked right now (empty for native tasks and after detach). */
  locked: ReadonlySet<TaskOwnedField>;
  /** Canonical Backlog.md id (BACK-786.1); null for native tasks. */
  backlogId: string | null;
  /** The project still mirrors: owned fields are locked. */
  isMirrored: boolean;
  /** Came from Backlog.md but nothing is locked any more: detached, or imported. */
  isDetached: boolean;
  /** The task's file is gone from the default branch. */
  isHidden: boolean;
}

export function mirrorOf(task: Task | TaskListItem | undefined): MirrorInfo {
  const locked = new Set<TaskOwnedField>(task?.locked ?? []);
  const backlogId =
    (task && 'backlog' in task ? task.backlog?.id : undefined) ??
    (task && 'backlogId' in task ? task.backlogId : undefined) ??
    null;
  return {
    locked,
    backlogId,
    isMirrored: locked.size > 0,
    isDetached: backlogId != null && locked.size === 0,
    isHidden: task?.hidden === true,
  };
}

// ---------------------------------------------------------------------------
// History
// ---------------------------------------------------------------------------

/** Names of the Backlog.md-only fields a refresh changed, as Activity.backlogFields lists them. */
const BACKLOG_FIELD_NAMES: Record<string, string> = {
  labels: 'the labels',
  dependencies: 'the dependencies',
  parentId: 'the parent task',
  subtasks: 'the subtasks',
  dueDate: 'the due date',
  type: 'the type',
  references: 'the references',
  documentation: 'the documentation links',
  modifiedFiles: 'the modified files',
  reporter: 'the reporter',
  assignees: 'the assignees',
  createdAt: 'the created date',
  createdDate: 'the created date',
  updatedDate: 'the updated date',
  ordinal: 'the ordinal',
  other: 'other fields',
  kind: 'the folder',
  status: 'the status',
  priority: 'the priority',
  milestone: 'the milestone',
  key: 'the key',
  id: 'the Backlog.md ID',
  implementationNotes: 'the notes',
};

/** "changed the labels and the due date" for the fields only the Backlog.md block holds. */
export function describeBacklogFields(fields: readonly string[] | undefined): string | null {
  // updatedDate changes on nearly every edit; it says nothing on its own.
  const names = [
    ...new Set(
      (fields ?? []).filter((field) => field !== 'updatedDate').map((f) => BACKLOG_FIELD_NAMES[f] ?? f),
    ),
  ];
  if (!names.length) return null;
  const list = names.length === 1 ? names[0] : `${names.slice(0, -1).join(', ')} and ${names.at(-1)}`;
  return `changed ${list}`;
}

/** "hid the task: its file is gone from main", "brought the task back: its file is on main again". */
export function describeVisibilityChange(type: Activity['type'], branch: string | null | undefined) {
  const where = branch ?? 'the default branch';
  if (type === 'task.hidden') return `hid the task: its file is gone from ${where}`;
  if (type === 'task.restored') return `brought the task back: its file is on ${where} again`;
  return null;
}

/** Project-level history entries a task's timeline shows. */
export interface ProjectTimelineEntry {
  id: string;
  kind: 'project';
  entry: ProjectActivity;
  createdAt: string;
}

/**
 * The project-level rows that belong in a task's history: the first read, unless the task arrived in a
 * later one (it has its own "created" entry), and the detach.
 */
export function projectRowsForTask(
  history: readonly ProjectActivity[] | undefined,
  taskItems: readonly { kind: string; type?: string }[],
): ProjectTimelineEntry[] {
  if (!history?.length) return [];
  const arrivedLater = taskItems.some((item) => item.kind === 'activity' && item.type === 'task.created');
  return history
    .filter(
      (entry) =>
        entry.type === 'project.backlog_detached' ||
        (entry.type === 'project.backlog_imported' && !arrivedLater),
    )
    .map((entry) => ({ id: entry.id, kind: 'project', entry, createdAt: entry.createdAt }));
}

/**
 * "imported this from backlog/tasks/hbr-71.md" (with the task's file), "imported this with 411 others",
 * "detached Payments from Backlog.md. Every field is editable now."
 */
export function describeProjectEntry(
  entry: ProjectActivity,
  projectName: string,
  file?: string | null,
): string {
  if (entry.type === 'project.backlog_detached') {
    return `detached ${projectName} from Backlog.md. Every field is editable now.`;
  }
  if (file) return `imported this from ${file}`;
  const others = (entry.details.tasks ?? 1) - 1;
  return others > 0 ? `imported this with ${others} ${others === 1 ? 'other' : 'others'}` : 'imported this';
}

/** Short commit hash: a1b2c3d. */
export const shortCommit = (commit: string) => commit.slice(0, 7);

/** The comment box placeholder for a task from Backlog.md (frame 054); undefined keeps the default. */
export function commentPlaceholder(mirror: MirrorInfo): string | undefined {
  if (mirror.isHidden) return 'Comments still work on hidden tasks.';
  if (mirror.isMirrored) return 'Leave a comment. It stays in the app and isn’t written to the file.';
  return undefined;
}

// ---------------------------------------------------------------------------
// "From the file" (frames 054, 055)
// ---------------------------------------------------------------------------

/** One raw key and value of the task file that has no native field. */
export interface FileField {
  /** The frontmatter key as written: "modified_files". */
  key: string;
  value: string;
}

function rawValue(value: unknown): string {
  if (value == null) return '';
  if (typeof value === 'string') return value;
  if (typeof value === 'number' || typeof value === 'boolean') return String(value);
  if (Array.isArray(value)) return value.map(rawValue).join(', ');
  return JSON.stringify(value);
}

/** "2026-10-12 09:14" for a timestamp the file wrote without a zone (UTC). */
function fileTimestamp(value: string): string {
  const date = new Date(value);
  if (Number.isNaN(date.getTime())) return value;
  const pad = (n: number) => String(n).padStart(2, '0');
  return `${date.getUTCFullYear()}-${pad(date.getUTCMonth() + 1)}-${pad(date.getUTCDate())} ${pad(date.getUTCHours())}:${pad(date.getUTCMinutes())}`;
}

/**
 * The task file's fields that have no native home, in file order: type, reporter, extra assignees,
 * references, documentation, modified files, the dates as written, the ordinal and unknown keys.
 * Labels, the due date, dependencies, the parent and subtasks are native fields and never show here.
 */
export function fileFields(task: Pick<Task, 'assignee' | 'backlog'>): FileField[] {
  const data = task.backlog?.data;
  if (!data) return [];
  const rows: FileField[] = [];
  const add = (key: string, value: string) => {
    if (value.trim()) rows.push({ key, value });
  };
  add('type', data.type ?? '');
  add('reporter', data.reporter ?? '');
  // The assignee field shows one member; the other values of the file have no home.
  const shownAssignee = task.assignee?.id;
  const firstMatch = data.assignees.findIndex(
    (value) => value.user != null && value.user.id === shownAssignee,
  );
  const others = data.assignees.filter((_value, index) => index !== firstMatch);
  if (others.length) add('assignee', data.assignees.map((value) => value.value).join(', '));
  add('references', data.references.join(', '));
  add('documentation', data.documentation.join(', '));
  add('modified_files', data.modifiedFiles.join(', '));
  add('created_date', data.createdDate ?? '');
  add('updated_date', data.updatedDate ? fileTimestamp(data.updatedDate) : '');
  add('ordinal', data.ordinal == null ? '' : String(data.ordinal));
  for (const [key, value] of Object.entries(data.other)) add(key, rawValue(value));
  return rows;
}
