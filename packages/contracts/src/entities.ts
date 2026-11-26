import { z } from 'zod';
import {
  ActivityOrigin,
  ApiKeyAccess,
  AuthId,
  BacklogMode,
  BacklogSourceId,
  BacklogState,
  BacklogTrigger,
  CalendarDate,
  CommentId,
  CycleId,
  CycleState,
  GitConnectionId,
  GitConnectionStatus,
  GitProvider,
  LabelColor,
  LabelId,
  LabelSource,
  MilestoneId,
  MilestoneOwnedField,
  MilestoneStatus,
  Priority,
  ProjectId,
  ProjectKey,
  ProjectOwnedField,
  RowId,
  TaskKey,
  TaskOwnedField,
  TaskStatus,
  Theme,
  Timestamp,
  UserId,
  UserKind,
  WorkspaceId,
  WorkspaceRole,
} from './primitives';

// Output schemas. Servers may pass Dates where a Timestamp is expected; clients always receive
// ISO strings. Use z.input<> for what a server hands in and z.output<> (the exported types) for
// what a client reads.

// ---------------------------------------------------------------------------
// References
// ---------------------------------------------------------------------------

/** Minimal user reference used inside other entities. */
export const UserRef = z.object({
  id: UserId,
  name: z.string(),
  kind: UserKind,
});
export type UserRef = z.output<typeof UserRef>;

/** An assignee: agents carry their responsible human, so the UI can show "claude-dev for Ana Ruiz". */
export const AssigneeRef = UserRef.extend({
  responsible: UserRef.nullable(),
});
export type AssigneeRef = z.output<typeof AssigneeRef>;

export const ProjectRef = z.object({
  id: ProjectId,
  key: ProjectKey,
  name: z.string(),
});
export type ProjectRef = z.output<typeof ProjectRef>;

/** A task's milestone, as shown on cards, rows and in the task panel. */
export const MilestoneRef = z.object({
  id: MilestoneId,
  name: z.string(),
  status: MilestoneStatus,
  targetDate: CalendarDate.nullable(),
});
export type MilestoneRef = z.output<typeof MilestoneRef>;

/** A task's cycle. `state` is derived from the dates and completedAt at read time. */
export const CycleRef = z.object({
  id: CycleId,
  number: z.number().int().positive(),
  name: z.string().nullable(),
  startsOn: CalendarDate,
  endsOn: CalendarDate,
  state: CycleState,
});
export type CycleRef = z.output<typeof CycleRef>;

/** The project's current cycle, for the header tab note ("C12 · 3d left"). */
export const CurrentCycle = CycleRef.omit({ state: true }).extend({
  /** Days left including today, in APP_TIME_ZONE: 1 on the last day. */
  daysLeft: z.number().int().positive(),
});
export type CurrentCycle = z.output<typeof CurrentCycle>;

// ---------------------------------------------------------------------------
// Projects
// ---------------------------------------------------------------------------

/** Problem counts of a Backlog.md source: files skipped or read with a warning, values that fell back. */
export const BacklogProblemCounts = z.object({
  files: z.number().int().nonnegative(),
  values: z.number().int().nonnegative(),
});
export type BacklogProblemCounts = z.output<typeof BacklogProblemCounts>;

/**
 * The Backlog.md source of a project as project shapes carry it (header indicator, projects table,
 * sidebar marker). GET /projects/{key}/backlog has the full status.
 */
export const ProjectBacklogSummary = z.object({
  mode: BacklogMode,
  state: BacklogState,
  defaultBranch: z.string().nullable(),
  /** The last successful read; null before the first one finishes. */
  lastReadAt: Timestamp.nullable(),
  lastReadCommit: z.string().nullable(),
  lastTrigger: BacklogTrigger.nullable(),
  problems: BacklogProblemCounts,
  /** Tasks hidden because their file is gone from the default branch. */
  hidden: z.number().int().nonnegative(),
  /** Set once detached (imports detach right after the first read). */
  detachedAt: Timestamp.nullable(),
});
export type ProjectBacklogSummary = z.output<typeof ProjectBacklogSummary>;

// The defaults on fields added in M2 keep servers that do not send them yet valid; clients always
// receive the fields.
export const Project = z.object({
  id: ProjectId,
  key: ProjectKey,
  name: z.string(),
  description: z.string().nullable(),
  /** Off hides the milestones tab, filter and fields. The data stays. */
  usesMilestones: z.boolean().default(true),
  /** Off hides the cycles tab, filter and fields. The data stays. */
  usesCycles: z.boolean().default(true),
  /** Null when the project has no current cycle or does not use cycles. */
  currentCycle: CurrentCycle.nullable().default(null),
  /**
   * Clone URL of the linked git repository, as entered (M2.1). parseRepositoryUrl gives its short
   * form and web page. The CLI picks this project inside a clone whose remote matches.
   */
  repository: z.string().nullable().default(null),
  // M3 fields are optional in the type, so shapes built before M3 (fixtures, fakes) stay valid.
  // Servers from M3 on always send them; read a missing one as null, [] or false.
  /** M3: the project's Backlog.md source, detached ones included; null when there is none. */
  backlog: ProjectBacklogSummary.nullable().optional(),
  /**
   * M3: project fields the mirror constrains right now (key, repository, usesMilestones). Empty
   * unless the project mirrors Backlog.md.
   */
  locked: z.array(ProjectOwnedField).optional(),
  /**
   * M6: done items every new task starts with, in order (unless created with skipDefaultDoneItems).
   * Changing them leaves existing tasks alone. Optional in the type like the M3 fields; missing reads as [].
   */
  defaultDoneItems: z.array(z.string()).optional(),
  createdAt: Timestamp,
  updatedAt: Timestamp,
});
export type Project = z.output<typeof Project>;

/** Open task counts of a project, one entry per open status. */
export const OpenStatusCounts = z.object({
  backlog: z.number().int().nonnegative(),
  todo: z.number().int().nonnegative(),
  in_progress: z.number().int().nonnegative(),
  in_review: z.number().int().nonnegative(),
});
export type OpenStatusCounts = z.output<typeof OpenStatusCounts>;

/** Task counts for every status. */
export const StatusCounts = OpenStatusCounts.extend({
  done: z.number().int().nonnegative(),
  canceled: z.number().int().nonnegative(),
});
export type StatusCounts = z.output<typeof StatusCounts>;

/** A project as listed on the projects screen and in the rail. */
export const ProjectWithCounts = Project.extend({
  /** Open tasks per status (backlog, todo, in progress, in review). */
  openCounts: OpenStatusCounts,
  /** Sum of openCounts. */
  openCount: z.number().int().nonnegative(),
  /** Latest of the project's and its tasks' updatedAt. Sorts the projects screen. */
  lastActivityAt: Timestamp,
  /** Distinct assignees of open tasks, people first, for the avatar stack. */
  assignees: z.array(UserRef),
});
export type ProjectWithCounts = z.output<typeof ProjectWithCounts>;

// ---------------------------------------------------------------------------
// Backlog.md block on tasks (M3)
// ---------------------------------------------------------------------------

/** Where a Backlog.md task file lives: tasks/, drafts/, or archive/tasks (legacy completed/ too). */
export const BACKLOG_TASK_KINDS = ['task', 'draft', 'archived'] as const;
export const BacklogTaskKind = z.enum(BACKLOG_TASK_KINDS);
export type BacklogTaskKind = z.infer<typeof BacklogTaskKind>;

/** One assignee value from the file and the member it matched (null: matches no member). */
export const BacklogAssigneeValue = z.object({
  value: z.string(),
  userId: UserId.nullable(),
});
export type BacklogAssigneeValue = z.output<typeof BacklogAssigneeValue>;

/**
 * task.backlog_data: the Backlog.md fields the app has no column for, plus the raw values of the
 * mapped ones. Written by the refresh, never by people. Ids are canonical Backlog.md ids (BACK-12).
 * Every field has a default so older rows stay readable when fields are added.
 */
export const BacklogBlock = z.object({
  kind: BacklogTaskKind.default('task'),
  /** Raw values as written in the file, before mapping. */
  status: z.string().nullable().default(null),
  priority: z.string().nullable().default(null),
  milestone: z.string().nullable().default(null),
  /** Every assignee value in file order; the first one with a userId is the task's assignee. */
  assignees: z.array(BacklogAssigneeValue).default([]),
  reporter: z.string().nullable().default(null),
  labels: z.array(z.string()).default([]),
  dependencies: z.array(z.string()).default([]),
  parentId: z.string().nullable().default(null),
  subtasks: z.array(z.string()).default([]),
  /** As written: a date or a date and time. */
  dueDate: z.string().nullable().default(null),
  type: z.string().nullable().default(null),
  references: z.array(z.string()).default([]),
  documentation: z.array(z.string()).default([]),
  modifiedFiles: z.array(z.string()).default([]),
  /** created_date as written (the task's createdAt holds the parsed value). */
  createdDate: z.string().nullable().default(null),
  /** updated_date, parsed. The task's own updatedAt stays the app's write time. */
  updatedDate: Timestamp.nullable().default(null),
  ordinal: z.number().nullable().default(null),
  /** Frontmatter keys the parser does not know, kept as read. */
  other: z.record(z.string(), z.unknown()).default({}),
  /**
   * M6: the Implementation notes section as written, markers stripped and trimmed; null when the
   * file has none. Shown as one read-only block. Criteria, done items, plan and final summary have
   * their own columns.
   */
  implementationNotes: z.string().nullable().default(null),
});
export type BacklogBlock = z.output<typeof BacklogBlock>;

/** A Backlog.md id resolved to a task of the same project at read time; task null: no task with this id. */
export const BacklogTaskLink = z.object({
  id: z.string(),
  task: z
    .object({
      key: TaskKey,
      title: z.string(),
      status: TaskStatus,
      hidden: z.boolean(),
    })
    .nullable(),
});
export type BacklogTaskLink = z.output<typeof BacklogTaskLink>;

/** The Backlog.md block as task shapes carry it: ids resolved to tasks, assignee values to members. */
export const BacklogBlockView = BacklogBlock.omit({
  assignees: true,
  dependencies: true,
  parentId: true,
  subtasks: true,
}).extend({
  assignees: z.array(z.object({ value: z.string(), user: UserRef.nullable() })),
  dependencies: z.array(BacklogTaskLink),
  parent: BacklogTaskLink.nullable(),
  subtasks: z.array(BacklogTaskLink),
});
export type BacklogBlockView = z.output<typeof BacklogBlockView>;

/** Where a task came from in Backlog.md. Kept after detach as a read-only record. */
export const TaskBacklog = z.object({
  /** Canonical Backlog.md id: BACK-786.1. */
  id: z.string(),
  /** Repository path of the file on the default branch; null once the file is gone or after detach. */
  file: z.string().nullable(),
  /** Web page of the file on the provider ("Open file"); null when unknown. */
  fileUrl: z.string().nullable().default(null),
  data: BacklogBlockView,
});
export type TaskBacklog = z.output<typeof TaskBacklog>;

// ---------------------------------------------------------------------------
// Labels and task relations (M5)
// ---------------------------------------------------------------------------

/**
 * A project label. Names are unique per project ignoring case, 1 to 40 characters. `color` is the
 * palette hue 1 to 9, drawn with --label-1 to --label-9. Labels with source backlog come from
 * Backlog.md files: their name is locked (LABEL_MIRRORED), their colour stays editable and is
 * never written back.
 */
export const Label = z.object({
  id: LabelId,
  name: z.string(),
  color: LabelColor,
  source: LabelSource,
});
export type Label = z.output<typeof Label>;

/** A label in project settings and in GET /projects/{project}/labels: with its task count. */
export const LabelWithUsage = Label.extend({
  /** Visible tasks carrying the label; hidden ones are left out ("Used on 12 tasks"). */
  usageCount: z.number().int().nonnegative(),
});
export type LabelWithUsage = z.output<typeof LabelWithUsage>;

/** GET /projects/{project}/labels: every label of the project, by name (case-insensitive). */
export const LabelList = z.object({ items: z.array(LabelWithUsage) });
export type LabelList = z.output<typeof LabelList>;

/**
 * Another task of the same project as a relation shows it: a subtask, the parent, a blocker or a
 * task this one blocks. Lists that may point at a task the caller can't see (hidden by a
 * Backlog.md refresh) carry null for it, which the UI reads as "Removed task".
 */
export const RelatedTask = z.object({
  key: TaskKey,
  title: z.string(),
  status: TaskStatus,
  assignee: UserRef.nullable(),
});
export type RelatedTask = z.output<typeof RelatedTask>;

/**
 * Subtask progress: done of total, canceled subtasks left out of both. A task without subtasks
 * (or with only canceled ones) has total 0; the UI shows nothing then.
 */
export const SubtaskProgress = z
  .object({
    done: z.number().int().nonnegative(),
    total: z.number().int().nonnegative(),
  })
  .refine((progress) => progress.done <= progress.total, {
    message: 'done cannot be above total',
    path: ['done'],
  });
export type SubtaskProgress = z.output<typeof SubtaskProgress>;

// ---------------------------------------------------------------------------
// Work record (M6): criteria, done items, plan, final summary, and where a change came from
// ---------------------------------------------------------------------------

/** Most acceptance criteria on one task, and most done items (each list on its own). */
export const MAX_WORK_ITEMS = 50;
/** Longest criterion, done item or waiver reason, in characters after trimming. One line each. */
export const MAX_WORK_ITEM_LENGTH = 500;
/** Longest plan or final summary, in characters. */
export const MAX_WORK_TEXT_LENGTH = 50_000;

/** criterion: an acceptance criterion. done: a definition-of-done item. */
export const WORK_ITEM_KINDS = ['criterion', 'done'] as const;
export const WorkItemKind = z.enum(WORK_ITEM_KINDS);
export type WorkItemKind = z.infer<typeof WorkItemKind>;

/** An item stays open until someone checks it, or waives it with a reason. */
export const WORK_ITEM_STATES = ['open', 'checked', 'waived'] as const;
export const WorkItemState = z.enum(WORK_ITEM_STATES);
export type WorkItemState = z.infer<typeof WorkItemState>;

/** An item's number: its position in its list, counted from 1, as in Backlog.md. */
export const WorkItemNumber = z.number().int().min(1).max(MAX_WORK_ITEMS);

/**
 * One acceptance criterion or done item. Numbers follow the order of the list and change when
 * items are removed or moved; history entries keep the text, so they still read right.
 */
export const WorkItem = z
  .object({
    number: z.number().int().positive(),
    text: z.string(),
    state: WorkItemState,
    /** Set while waived, null otherwise. */
    waivedReason: z.string().nullable(),
    /** Who waived it; null when not waived, or when the waiver came from a Backlog.md file. */
    waivedBy: UserRef.nullable(),
    /** The item comes from a mirrored Backlog.md file: writes fail with TASK_MIRRORED. */
    locked: z.boolean(),
  })
  .refine((item) => (item.state === 'waived') === (item.waivedReason !== null), {
    message: 'waivedReason is set exactly while the item is waived',
    path: ['waivedReason'],
  });
export type WorkItem = z.output<typeof WorkItem>;

/**
 * Counts of one list on rows, cards and the peek: settled is checked plus waived, waived counts
 * the waived ones among them, open is the rest. A task without items has total 0; the UI shows
 * nothing then.
 */
export const WorkItemProgress = z
  .object({
    settled: z.number().int().nonnegative(),
    open: z.number().int().nonnegative(),
    waived: z.number().int().nonnegative(),
    total: z.number().int().nonnegative(),
  })
  .refine((progress) => progress.settled + progress.open === progress.total, {
    message: 'settled and open add up to total',
    path: ['total'],
  })
  .refine((progress) => progress.waived <= progress.settled, {
    message: 'waived items are settled, so waived cannot be above settled',
    path: ['waived'],
  });
export type WorkItemProgress = z.output<typeof WorkItemProgress>;

/**
 * Who last wrote the plan or the final summary, and when: the latest activity change of the field.
 * author null with origin backlog: the Backlog.md file.
 */
export const WorkTextMeta = z.object({
  author: UserRef.nullable(),
  /** The agent's responsible human when an agent wrote it; null for people. */
  onBehalfOf: UserRef.nullable(),
  origin: ActivityOrigin.default('app'),
  at: Timestamp,
});
export type WorkTextMeta = z.output<typeof WorkTextMeta>;

/** Request headers the CLI sets on every call; the web app sends neither. */
export const SOURCE_HEADERS = { machine: 'x-zamu-machine', branch: 'x-zamu-branch' } as const;
/** Longest machine or branch name kept, in characters. */
export const MAX_SOURCE_LENGTH = 100;

/**
 * Reads one source header: trimmed, cut to MAX_SOURCE_LENGTH characters; null when missing, empty,
 * or holding control characters. A bad header never fails the request.
 */
export function parseSourceHeader(value: string | null | undefined): string | null {
  const trimmed = value?.trim();
  if (!trimmed || /\p{Cc}/u.test(trimmed)) return null;
  return [...trimmed].slice(0, MAX_SOURCE_LENGTH).join('').trimEnd();
}

/**
 * Where a history entry or a note came from: the machine and git branch the CLI ran on. Entries
 * written without the headers (the web app, jobs, Backlog.md refreshes) carry null instead.
 */
export const EntrySource = z.object({
  machine: z.string().nullable(),
  branch: z.string().nullable(),
});
export type EntrySource = z.output<typeof EntrySource>;

// ---------------------------------------------------------------------------
// Tasks
// ---------------------------------------------------------------------------

export const Task = z.object({
  id: RowId,
  key: TaskKey,
  number: z.number().int().positive(),
  project: ProjectRef,
  title: z.string(),
  /** Markdown. */
  description: z.string().nullable(),
  status: TaskStatus,
  priority: Priority,
  assignee: AssigneeRef.nullable(),
  createdBy: UserRef,
  /** The responsible human when an agent created the task; null for people. */
  createdOnBehalfOf: UserRef.nullable(),
  milestone: MilestoneRef.nullable().default(null),
  cycle: CycleRef.nullable().default(null),
  /** When the task last entered its cycle; after the cycle's start means "added after start". */
  cycleAddedAt: Timestamp.nullable().default(null),
  /** Position inside its status column on the board, ascending. Only the order matters. */
  rank: z.number(),
  // M3 fields are optional in the type, so shapes built before M3 (fixtures, fakes) stay valid.
  // Servers from M3 on always send them; read a missing one as null, [] or false.
  /** M3: the Backlog.md origin of a mirrored or imported task; null for native tasks. */
  backlog: TaskBacklog.nullable().optional(),
  /**
   * M3: fields Backlog.md owns right now. Writes to them fail with TASK_MIRRORED. Empty for native
   * tasks and after detach.
   */
  locked: z.array(TaskOwnedField).optional(),
  /** M3: the task's file is gone from the default branch. Hidden tasks stay out of lists by default. */
  hidden: z.boolean().optional(),
  /** M3: when the task was hidden; null while visible. */
  hiddenAt: Timestamp.nullable().optional(),
  // M5 fields are optional in the type, so shapes built before M5 (fixtures, fakes) stay valid.
  // Servers from M5 on always send them; read a missing list as [], a missing value as null, a
  // missing flag as false and missing progress as { done: 0, total: 0 }.
  /** M5: labels of the task, by name (case-insensitive). */
  labels: z.array(Label).optional(),
  /** M5: due day, no time; null when none. See dueState() for how it reads. */
  dueDate: CalendarDate.nullable().optional(),
  /** M5: the parent when this is a subtask (one level, same project); null for top-level tasks. */
  parent: RelatedTask.nullable().optional(),
  /** M5: subtasks, by key. Canceled ones included ("1 canceled"). */
  subtasks: z.array(RelatedTask).optional(),
  /** M5: done of total over `subtasks`, canceled excluded. */
  subtaskProgress: SubtaskProgress.optional(),
  /** M5: tasks this one waits on, by key. null entries: a blocker hidden from the caller ("Removed task"). */
  blockedBy: z.array(RelatedTask.nullable()).optional(),
  /** M5: the reverse, tasks waiting on this one ("Blocks PAY-150"). Same null rule. */
  blocks: z.array(RelatedTask.nullable()).optional(),
  /** M5: at least one blocker is open (not Done or Canceled). Display only: status changes are never refused. */
  blocked: z.boolean().optional(),
  // M6 fields are optional in the type, so shapes built before M6 (fixtures, fakes) stay valid.
  // Servers from M6 on always send them; read a missing list as [] and a missing text or meta as null.
  /** M6: acceptance criteria, by number. */
  criteria: z.array(WorkItem).optional(),
  /** M6: definition-of-done items, by number. New tasks start with the project's defaultDoneItems. */
  doneItems: z.array(WorkItem).optional(),
  /** M6: the implementation plan, Markdown; null when none. */
  plan: z.string().nullable().optional(),
  /** M6: who last wrote the plan and when; null without a plan. */
  planMeta: WorkTextMeta.nullable().optional(),
  /** M6: the final summary, Markdown; null when none. */
  finalSummary: z.string().nullable().optional(),
  /** M6: who last wrote the final summary and when; null without one. */
  finalSummaryMeta: WorkTextMeta.nullable().optional(),
  createdAt: Timestamp,
  updatedAt: Timestamp,
});
export type Task = z.output<typeof Task>;

/** A row in the task list, on the board and on My tasks: everything but the description and creator. */
export const TaskListItem = Task.pick({
  id: true,
  key: true,
  number: true,
  project: true,
  title: true,
  status: true,
  priority: true,
  assignee: true,
  milestone: true,
  cycle: true,
  cycleAddedAt: true,
  rank: true,
  locked: true,
  hidden: true,
  hiddenAt: true,
  labels: true,
  dueDate: true,
  subtaskProgress: true,
  blocked: true,
  createdAt: true,
  updatedAt: true,
}).extend({
  /** M3: canonical Backlog.md id (BACK-786.1); null for native tasks. */
  backlogId: z.string().nullable().optional(),
  /** M3: live comments, for the "removed · 3 comments" note on hidden rows. Optional. */
  commentCount: z.number().int().nonnegative().optional(),
  /** M5: the parent's key for subtasks (nesting in the list, hiding on the board); null for top-level tasks. */
  parentKey: TaskKey.nullable().optional(),
  /** M6: acceptance criteria counts; missing reads as no criteria (total 0). */
  criteriaProgress: WorkItemProgress.optional(),
  /** M6: done item counts; missing reads as none (total 0). */
  doneProgress: WorkItemProgress.optional(),
  /** M6: the task has a final summary (the peek opens on it). Missing reads as false. */
  hasFinalSummary: z.boolean().optional(),
});
export type TaskListItem = z.output<typeof TaskListItem>;

/** One page of tasks. counts covers every task matching the filters, ignoring the status filter. */
export const TaskListPage = z.object({
  items: z.array(TaskListItem),
  /** Pass as `cursor` to fetch the next page; null on the last page. */
  nextCursor: z.string().nullable(),
  counts: StatusCounts,
});
export type TaskListPage = z.output<typeof TaskListPage>;

/**
 * Problem code of a task write rejected because `ifUpdatedAt` is older than the stored task
 * (409). The problem data carries the current task, so the client can roll back and show it.
 */
export const TASK_CHANGED = 'TASK_CHANGED';

/** Data of the TASK_CHANGED problem. */
export const TaskChangedData = z.object({
  task: Task,
});
export type TaskChangedData = z.output<typeof TaskChangedData>;

/** POST /tasks/bulk: every changed task as it is now, in the order of the keys sent. */
export const TaskBulkResult = z.object({
  items: z.array(TaskListItem),
});
export type TaskBulkResult = z.output<typeof TaskBulkResult>;

// ---------------------------------------------------------------------------
// Milestones
// ---------------------------------------------------------------------------

export const Milestone = z.object({
  id: MilestoneId,
  project: ProjectRef,
  name: z.string(),
  /** Markdown. */
  description: z.string().nullable(),
  targetDate: CalendarDate.nullable(),
  status: MilestoneStatus,
  /** When it was last marked Completed; null otherwise. */
  completedAt: Timestamp.nullable(),
  createdBy: UserRef,
  // M3 fields are optional in the type, so shapes built before M3 stay valid; servers send them.
  /** M3: the Backlog.md milestone id (m-3, or the name for legacy config milestones); null for native ones. */
  backlogId: z.string().nullable().optional(),
  /** M3: fields Backlog.md owns right now; MILESTONE_MIRRORED on writes. Empty unless mirrored. */
  locked: z.array(MilestoneOwnedField).optional(),
  /** M3: the milestone's file is gone from the default branch. */
  hidden: z.boolean().optional(),
  createdAt: Timestamp,
  updatedAt: Timestamp,
});
export type Milestone = z.output<typeof Milestone>;

/** Task counts of a milestone. Progress is done / (total - canceled). */
export const MilestoneProgress = z.object({
  total: z.number().int().nonnegative(),
  done: z.number().int().nonnegative(),
  /** In progress and In review. */
  inProgress: z.number().int().nonnegative(),
  /** Backlog and Todo. */
  open: z.number().int().nonnegative(),
  canceled: z.number().int().nonnegative(),
});
export type MilestoneProgress = z.output<typeof MilestoneProgress>;

/** Done share of the non-canceled tasks, 0 to 1; 0 for an empty milestone. */
export function milestoneProgressRatio(progress: MilestoneProgress): number {
  const counted = progress.total - progress.canceled;
  return counted > 0 ? progress.done / counted : 0;
}

export const MilestoneWithProgress = Milestone.extend({
  progress: MilestoneProgress,
  /** Days from today to the target date in APP_TIME_ZONE (0 on the day, negative after); null without a target. */
  daysLeft: z.number().int().nullable(),
  /** Target date before today and not Completed. */
  overdue: z.boolean(),
});
export type MilestoneWithProgress = z.output<typeof MilestoneWithProgress>;

// ---------------------------------------------------------------------------
// Cycles
// ---------------------------------------------------------------------------

/** Live counts of the tasks currently in a cycle. */
export const CycleCounts = StatusCounts.extend({
  total: z.number().int().nonnegative(),
  /** Tasks whose cycleAddedAt is after the start of startsOn. */
  addedAfterStart: z.number().int().nonnegative(),
  unassigned: z.number().int().nonnegative(),
  /** Tasks assigned to agents. */
  agents: z.number().int().nonnegative(),
});
export type CycleCounts = z.output<typeof CycleCounts>;

/** Written once when the cycle ends; the completed cycle page reads it. */
export const CycleSummary = z.object({
  /** Tasks in the cycle when it ended. */
  scope: z.number().int().nonnegative(),
  completed: z.number().int().nonnegative(),
  rolledOver: z.number().int().nonnegative(),
  canceled: z.number().int().nonnegative(),
  addedAfterStart: z.number().int().nonnegative(),
});
export type CycleSummary = z.output<typeof CycleSummary>;

export const Cycle = z.object({
  id: CycleId,
  project: ProjectRef,
  number: z.number().int().positive(),
  name: z.string().nullable(),
  /** First day, included. */
  startsOn: CalendarDate,
  /** Last day, included; the cycle ends at the following midnight in APP_TIME_ZONE. */
  endsOn: CalendarDate,
  state: CycleState,
  /** Current cycles only: days left including today (1 on the last day). Null otherwise. */
  daysLeft: z.number().int().positive().nullable(),
  counts: CycleCounts,
  /** Set once the cycle ended. */
  completedAt: Timestamp.nullable(),
  /** Who ended it; null while not ended or when the hourly job ended it. */
  endedBy: UserRef.nullable(),
  /** Null until the cycle ends. */
  summary: CycleSummary.nullable(),
});
export type Cycle = z.output<typeof Cycle>;

/** An unfinished task moved when a cycle ended. */
export const CycleRollover = z.object({
  task: z.object({
    id: RowId,
    key: TaskKey,
    title: z.string(),
    /** Status now. */
    status: TaskStatus,
  }),
  statusAtEnd: TaskStatus,
  /** Null when the person ending the cycle chose "No cycle". */
  movedTo: CycleRef.pick({ id: true, number: true, name: true }).nullable(),
  createdAt: Timestamp,
});
export type CycleRollover = z.output<typeof CycleRollover>;

/** One cycle with the record of what rolled over (empty unless completed). */
export const CycleDetail = Cycle.extend({
  rollovers: z.array(CycleRollover),
});
export type CycleDetail = z.output<typeof CycleDetail>;

// ---------------------------------------------------------------------------
// Activity
// ---------------------------------------------------------------------------

export const ACTIVITY_TYPES = [
  'task.created',
  'task.updated',
  'cycle.ended',
  // M3
  /** A refresh hid the task: its file is gone from the default branch. */
  'task.hidden',
  /** A refresh brought a hidden task back: a file with its id returned. */
  'task.restored',
  /** Project-level: the first read of a Backlog.md source (mirror or import), with counts. */
  'project.backlog_imported',
  /** Project-level: someone detached the source. */
  'project.backlog_detached',
  /** Project-level: an owner or admin issued a new webhook secret (0.6.0). */
  'project.backlog_webhook_secret_reissued',
] as const;
export const ActivityType = z.enum(ACTIVITY_TYPES);
export type ActivityType = z.infer<typeof ActivityType>;

/** Types written on a task (activity.task_id set). */
export const TASK_ACTIVITY_TYPES = [
  'task.created',
  'task.updated',
  'cycle.ended',
  'task.hidden',
  'task.restored',
] as const;
export const TaskActivityType = z.enum(TASK_ACTIVITY_TYPES);
export type TaskActivityType = z.infer<typeof TaskActivityType>;

/** Types written on the project (activity.task_id null). */
export const PROJECT_ACTIVITY_TYPES = [
  'project.backlog_imported',
  'project.backlog_detached',
  'project.backlog_webhook_secret_reissued',
] as const;
export const ProjectActivityType = z.enum(PROJECT_ACTIVITY_TYPES);
export type ProjectActivityType = z.infer<typeof ProjectActivityType>;

/** A milestone inside an activity change. A deleted milestone reads as "Deleted milestone". */
export const ActivityMilestoneRef = MilestoneRef.pick({ id: true, name: true });
export type ActivityMilestoneRef = z.output<typeof ActivityMilestoneRef>;

/** A cycle inside an activity change. */
export const ActivityCycleRef = CycleRef.pick({ id: true, number: true, name: true });
export type ActivityCycleRef = z.output<typeof ActivityCycleRef>;

/**
 * M5: a label inside an activity change. The name is the one recorded with the change (renames
 * and deletes don't rewrite history); color is the label's colour now, null once it was deleted.
 */
export const ActivityLabelRef = z.object({
  id: LabelId,
  name: z.string(),
  color: LabelColor.nullable(),
});
export type ActivityLabelRef = z.output<typeof ActivityLabelRef>;

/**
 * M5: a task inside an activity change (blockers, parent). The row stores the id with the key and
 * title at the time; core returns the current key and title while the task exists. removed: the
 * task was deleted or is hidden now ("Removed task").
 */
export const ActivityTaskRef = z.object({
  key: TaskKey,
  title: z.string(),
  removed: z.boolean(),
});
export type ActivityTaskRef = z.output<typeof ActivityTaskRef>;

/** The prefix of a work-item change: criterion.checked, doneItem.waived, ... */
export const WORK_ITEM_CHANGE_PREFIXES = {
  criterion: 'criterion',
  done: 'doneItem',
} as const satisfies Record<WorkItemKind, string>;

/** What can happen to a criterion or done item. Each one is a change kind of its own. */
export const WORK_ITEM_OPERATIONS = [
  'added',
  'edited',
  'moved',
  'removed',
  'checked',
  'unchecked',
  'waived',
  'unwaived',
] as const;
export type WorkItemOperation = (typeof WORK_ITEM_OPERATIONS)[number];

/**
 * M6: the eight changes of one item list. Every change carries the item's text at the time, so the
 * entry reads right after a reorder ("checked criterion 2: Refunds post a ledger entry").
 *   added      number: where it went in (the end, unless moved in the same write).
 *   edited     number, text: the new text; from: the old text.
 *   moved      text; from and to: the numbers before and after.
 *   removed    number: the number it had.
 *   checked, unchecked, unwaived: number.
 *   waived     number, reason.
 */
function workItemChanges<P extends string>(prefix: P) {
  const at = { number: z.number().int().positive(), text: z.string() };
  return [
    z.object({ field: z.literal(`${prefix}.added` as `${P}.added`), ...at }),
    z.object({ field: z.literal(`${prefix}.edited` as `${P}.edited`), ...at, from: z.string() }),
    z.object({
      field: z.literal(`${prefix}.moved` as `${P}.moved`),
      text: z.string(),
      from: z.number().int().positive(),
      to: z.number().int().positive(),
    }),
    z.object({ field: z.literal(`${prefix}.removed` as `${P}.removed`), ...at }),
    z.object({ field: z.literal(`${prefix}.checked` as `${P}.checked`), ...at }),
    z.object({ field: z.literal(`${prefix}.unchecked` as `${P}.unchecked`), ...at }),
    z.object({ field: z.literal(`${prefix}.waived` as `${P}.waived`), ...at, reason: z.string() }),
    z.object({ field: z.literal(`${prefix}.unwaived` as `${P}.unwaived`), ...at }),
  ] as const;
}

/**
 * One field change. The API resolves the assignee, milestone and cycle to references; the
 * database row stores ids, and core resolves them when reading. M5 adds labels, dueDate, blockedBy
 * and parent; labels and blockedBy record the whole list before and after (sorted by name and by
 * key), so the UI diffs them for "added payouts, removed backend". M6 adds the eight item changes
 * of criteria (criterion.*) and done items (doneItem.*), and plan and finalSummary with the text
 * before and after.
 */
export const ActivityChange = z.discriminatedUnion('field', [
  z.object({ field: z.literal('title'), from: z.string().nullable(), to: z.string().nullable() }),
  z.object({ field: z.literal('description'), from: z.string().nullable(), to: z.string().nullable() }),
  z.object({ field: z.literal('status'), from: TaskStatus.nullable(), to: TaskStatus.nullable() }),
  z.object({ field: z.literal('priority'), from: Priority.nullable(), to: Priority.nullable() }),
  z.object({ field: z.literal('assignee'), from: UserRef.nullable(), to: UserRef.nullable() }),
  z.object({
    field: z.literal('milestone'),
    from: ActivityMilestoneRef.nullable(),
    to: ActivityMilestoneRef.nullable(),
  }),
  z.object({ field: z.literal('cycle'), from: ActivityCycleRef.nullable(), to: ActivityCycleRef.nullable() }),
  // M5
  z.object({ field: z.literal('labels'), from: z.array(ActivityLabelRef), to: z.array(ActivityLabelRef) }),
  z.object({ field: z.literal('dueDate'), from: CalendarDate.nullable(), to: CalendarDate.nullable() }),
  z.object({ field: z.literal('blockedBy'), from: z.array(ActivityTaskRef), to: z.array(ActivityTaskRef) }),
  z.object({ field: z.literal('parent'), from: ActivityTaskRef.nullable(), to: ActivityTaskRef.nullable() }),
  // M6
  ...workItemChanges(WORK_ITEM_CHANGE_PREFIXES.criterion),
  ...workItemChanges(WORK_ITEM_CHANGE_PREFIXES.done),
  z.object({ field: z.literal('plan'), from: z.string().nullable(), to: z.string().nullable() }),
  z.object({ field: z.literal('finalSummary'), from: z.string().nullable(), to: z.string().nullable() }),
]);
export type ActivityChange = z.output<typeof ActivityChange>;

/** M6: every change field of the work record, for clients that group them. */
export const WORK_RECORD_CHANGE_FIELDS = [
  ...WORK_ITEM_OPERATIONS.map((operation) => `${WORK_ITEM_CHANGE_PREFIXES.criterion}.${operation}` as const),
  ...WORK_ITEM_OPERATIONS.map((operation) => `${WORK_ITEM_CHANGE_PREFIXES.done}.${operation}` as const),
  'plan',
  'finalSummary',
] as const;

export const Activity = z.object({
  id: RowId,
  type: ActivityType,
  taskKey: TaskKey,
  /**
   * Who made the change. Null means the system: the hourly job that ends cycles. A cycle.ended
   * entry carries one cycle change from the ended cycle to the one the task moved to.
   */
  actor: UserRef.nullable(),
  /** The agent's responsible human at the time of the change; null for people. */
  onBehalfOf: UserRef.nullable(),
  /** For task.created: the initial values that differ from the defaults. */
  changes: z.array(ActivityChange),
  // M3 fields are optional in the type, so shapes built before M3 stay valid; servers send them.
  /**
   * M3: app, or backlog for changes a Backlog.md refresh wrote. A null actor with origin backlog
   * is the Backlog.md actor; with origin app it is the system (the hourly cycle job). Missing: app.
   */
  origin: ActivityOrigin.optional(),
  /** M3: the commit a Backlog.md refresh read; null for app changes. */
  originRef: z.string().nullable().optional(),
  /**
   * M3: Backlog.md-only fields a refresh changed (references, type, createdAt, ...), named
   * after BacklogBlock keys or task fields; `changes` holds the mapped ones (from M5 on labels,
   * dueDate, blockedBy and parent too). Empty otherwise.
   */
  backlogFields: z.array(z.string()).optional(),
  /** M6: the machine and branch the CLI sent; null when neither was set. Missing reads as null. */
  source: EntrySource.nullable().optional(),
  createdAt: Timestamp,
});
export type Activity = z.output<typeof Activity>;

/** What a project-level entry records. project.backlog_imported fills the counts. */
export const ProjectActivityDetails = z.object({
  mode: BacklogMode.nullable().default(null),
  /** Short form of the repository read (gitlab.com/reddevs/payments). */
  repository: z.string().nullable().default(null),
  tasks: z.number().int().nonnegative().nullable().default(null),
  milestones: z.number().int().nonnegative().nullable().default(null),
});
export type ProjectActivityDetails = z.output<typeof ProjectActivityDetails>;

/**
 * A project-level history entry (no task): "Backlog.md imported 412 tasks and 6 milestones from
 * gitlab.com/reddevs/payments a1b2c3d", "Ana Ruiz detached Payments from Backlog.md".
 */
export const ProjectActivity = z.object({
  id: RowId,
  type: ProjectActivityType,
  /** Null with origin backlog: the Backlog.md actor. */
  actor: UserRef.nullable(),
  onBehalfOf: UserRef.nullable(),
  origin: ActivityOrigin,
  originRef: z.string().nullable(),
  details: ProjectActivityDetails,
  createdAt: Timestamp,
});
export type ProjectActivity = z.output<typeof ProjectActivity>;

// ---------------------------------------------------------------------------
// Comments and the timeline
// ---------------------------------------------------------------------------

/** Longest comment body in characters, after trimming. */
export const MAX_COMMENT_LENGTH = 20_000;

/**
 * M6: comment, or note: a work note written while working ("Migration written and tested"). Notes
 * show quietly in the timeline and notify only the people they mention.
 */
export const COMMENT_KINDS = ['comment', 'note'] as const;
export const CommentKind = z.enum(COMMENT_KINDS);
export type CommentKind = z.infer<typeof CommentKind>;

export const Comment = z.object({
  id: CommentId,
  taskKey: TaskKey,
  /** Only the author edits or deletes, agents included. */
  author: UserRef,
  /** The agent's responsible human when an agent wrote it; null for people. */
  onBehalfOf: UserRef.nullable(),
  /**
   * Markdown with mentions as [@Name](mention:<userId>). Null once deleted: the timeline shows
   * "Comment deleted by <author>".
   */
  body: z.string().nullable(),
  /** Members the body mentions, in order of first mention. Empty once deleted. */
  mentions: z.array(UserRef),
  // M6 fields are optional in the type, so shapes built before M6 stay valid; servers send them.
  /** M6: comment or note. Missing reads as comment. */
  kind: CommentKind.optional(),
  /** M6: the machine and branch the CLI sent; null when neither was set. Missing reads as null. */
  source: EntrySource.nullable().optional(),
  createdAt: Timestamp,
  editedAt: Timestamp.nullable(),
  deletedAt: Timestamp.nullable(),
});
export type Comment = z.output<typeof Comment>;

/**
 * One entry of a task's history: activity, comments and (M6) notes in one list, oldest first. A
 * note is a Comment with kind note.
 */
export const TimelineItem = z.discriminatedUnion('kind', [
  Activity.extend({ kind: z.literal('activity') }),
  Comment.extend({ kind: z.literal('comment') }),
  Comment.extend({ kind: z.literal('note') }),
]);
export type TimelineItem = z.output<typeof TimelineItem>;

/**
 * M6: what GET /tasks/{key}/timeline lists. all: everything. comments: comments only. notes: work
 * notes only. history: activity entries only.
 */
export const TIMELINE_FILTERS = ['all', 'comments', 'notes', 'history'] as const;
export const TimelineFilter = z.enum(TIMELINE_FILTERS);
export type TimelineFilter = z.infer<typeof TimelineFilter>;

/** M6: the size of each timeline filter, whatever `show` is. Deleted comments and notes count. */
export const TimelineCounts = z
  .object({
    all: z.number().int().nonnegative(),
    comments: z.number().int().nonnegative(),
    notes: z.number().int().nonnegative(),
    history: z.number().int().nonnegative(),
  })
  .refine((counts) => counts.all === counts.comments + counts.notes + counts.history, {
    message: 'all is the sum of comments, notes and history',
    path: ['all'],
  });
export type TimelineCounts = z.output<typeof TimelineCounts>;

// ---------------------------------------------------------------------------
// Members
// ---------------------------------------------------------------------------

export const Member = z.object({
  id: UserId,
  name: z.string(),
  /** Null for agents: their Better Auth email is synthetic and never shown. */
  email: z.string().nullable(),
  kind: UserKind,
  role: WorkspaceRole,
  /** Agents only: the person they act for. Null for people. */
  responsible: UserRef.nullable(),
  /** Last activity row written by this member, or null when none exists. */
  lastActiveAt: Timestamp.nullable(),
  /** Active (not revoked) API keys owned by this member. */
  apiKeyCount: z.number().int().nonnegative(),
  joinedAt: Timestamp,
});
export type Member = z.output<typeof Member>;

export const INVITATION_STATUSES = ['pending', 'accepted', 'rejected', 'canceled', 'expired'] as const;
export const InvitationStatus = z.enum(INVITATION_STATUSES);
export type InvitationStatus = z.infer<typeof InvitationStatus>;

/** A workspace invitation. No email is sent in M1: admins copy the link. */
export const Invitation = z.object({
  id: AuthId,
  email: z.string(),
  role: WorkspaceRole,
  status: InvitationStatus,
  invitedBy: UserRef,
  /** Accept link. Present only when the caller may share it (admins). */
  link: z.url().nullable(),
  expiresAt: Timestamp,
  createdAt: Timestamp,
});
export type Invitation = z.output<typeof Invitation>;

// ---------------------------------------------------------------------------
// API keys
// ---------------------------------------------------------------------------

export const API_KEY_PREFIX = 'zamu_live_';

/** Full API key secret. Only ever present in ApiKeyCreated and in client config. */
export const ApiKeySecret = z
  .string()
  .regex(
    /^zamu_live_[A-Za-z0-9_-]{16,}$/,
    'API keys start with zamu_live_ followed by at least 16 characters',
  );

/** Projects an API key may touch: the whole workspace, or a non-empty list of project ids. */
export const ApiKeyProjects = z.union([z.literal('all'), z.array(ProjectId).min(1)]);
export type ApiKeyProjects = z.output<typeof ApiKeyProjects>;

/** Scope chosen when creating a key. */
export const ApiKeyScope = z.object({
  projects: ApiKeyProjects,
  access: ApiKeyAccess,
});
export type ApiKeyScope = z.output<typeof ApiKeyScope>;

/** What core stores in Better Auth's apikey.metadata. */
export const ApiKeyMetadata = ApiKeyScope.extend({
  workspaceId: WorkspaceId,
});
export type ApiKeyMetadata = z.output<typeof ApiKeyMetadata>;

/** Scope as shown to people: project ids resolved to references. */
export const ApiKeyScopeView = z.object({
  projects: z.union([z.literal('all'), z.array(ProjectRef)]),
  access: ApiKeyAccess,
});
export type ApiKeyScopeView = z.output<typeof ApiKeyScopeView>;

/** An API key without its secret. */
export const ApiKeySummary = z.object({
  id: AuthId,
  name: z.string(),
  /** First characters of the key for recognition, e.g. `zamu_live_4kQz`. */
  start: z.string().nullable(),
  owner: UserRef,
  scope: ApiKeyScopeView,
  revoked: z.boolean(),
  createdAt: Timestamp,
  lastUsedAt: Timestamp.nullable(),
  expiresAt: Timestamp.nullable(),
});
export type ApiKeySummary = z.output<typeof ApiKeySummary>;

/** Returned once, right after creation: the only time the secret leaves the server. */
export const ApiKeyCreated = ApiKeySummary.extend({
  key: ApiKeySecret,
});
export type ApiKeyCreated = z.output<typeof ApiKeyCreated>;

/** What creating an agent returns: the member and its first API key, with the secret (shown once). */
export const AgentCreated = z.object({
  agent: Member,
  /** The agent's first API key, with its secret. Shown once. */
  key: ApiKeyCreated,
});
export type AgentCreated = z.output<typeof AgentCreated>;

// ---------------------------------------------------------------------------
// Workspaces (0.10, PM-39)
// ---------------------------------------------------------------------------

/**
 * A workspace as clients name it. `slug` is its current slug (WorkspaceSlug for every slug written
 * from 0.10 on; outputs only require it to be non-empty).
 */
export const WorkspaceRef = z.object({
  id: WorkspaceId,
  name: z.string(),
  slug: z.string().min(1),
});
export type WorkspaceRef = z.output<typeof WorkspaceRef>;

/** A workspace the caller belongs to, with the caller's role there. */
export const Workspace = WorkspaceRef.extend({
  role: WorkspaceRole,
});
export type Workspace = z.output<typeof Workspace>;

/**
 * Every workspace the person belongs to, by name, for the switcher and the palette. `canCreate`:
 * the creation policy lets them create one, so the switcher shows "New workspace".
 */
export const MyWorkspaces = z.object({
  items: z.array(Workspace),
  canCreate: z.boolean(),
});
export type MyWorkspaces = z.output<typeof MyWorkspaces>;

/**
 * What deleting a workspace removes, for the confirm copy ("Deletes Acme with 3 projects, 120
 * tasks and 2 agents."): its projects and their tasks, the agents that belong to no other workspace,
 * and every API key for it.
 */
export const WorkspaceContents = z.object({
  projects: z.number().int().nonnegative(),
  tasks: z.number().int().nonnegative(),
  agents: z.number().int().nonnegative(),
  keys: z.number().int().nonnegative(),
});
export type WorkspaceContents = z.output<typeof WorkspaceContents>;

// ---------------------------------------------------------------------------
// Me
// ---------------------------------------------------------------------------

export const AuthMethod = z.enum(['session', 'api_key']);
export type AuthMethod = z.infer<typeof AuthMethod>;

/** The caller: who they are, in which workspace, and how far their credentials reach. */
export const Me = z.object({
  user: z.object({
    id: UserId,
    name: z.string(),
    /** Null for agents (synthetic address). */
    email: z.string().nullable(),
    kind: UserKind,
    responsible: UserRef.nullable(),
    /** People choose it; agents keep "system". */
    theme: Theme.default('system'),
  }),
  /** The workspace the request resolved to: the key's own, or for a session the one it named. */
  workspace: WorkspaceRef,
  role: WorkspaceRole,
  auth: z.object({
    method: AuthMethod,
    /** Null for sessions (full member rights); the key's scope for API keys. */
    scope: ApiKeyScopeView.nullable(),
  }),
});
export type Me = z.output<typeof Me>;

// ---------------------------------------------------------------------------
// Dashboard
// ---------------------------------------------------------------------------

export const DASHBOARD_SCOPES = ['mine', 'everyone'] as const;
/**
 * mine: tasks assigned to the caller or to the agents they are responsible for, and mentions of
 * the caller. everyone: every task and mention in the projects the caller can read.
 */
export const DashboardScope = z.enum(DASHBOARD_SCOPES);
export type DashboardScope = z.infer<typeof DashboardScope>;

/** Most items a queue group returns. `total` still counts every item. */
export const DASHBOARD_GROUP_ITEM_LIMIT = 50;

const count = z.number().int().nonnegative();

/** A project as named inside dashboard rows. */
export const DashboardProjectRef = ProjectRef.pick({ key: true, name: true });
export type DashboardProjectRef = z.output<typeof DashboardProjectRef>;

/** A task as shown in a dashboard row. */
export const DashboardTask = Task.pick({ key: true, title: true, status: true, priority: true }).extend({
  project: DashboardProjectRef,
});
export type DashboardTask = z.output<typeof DashboardTask>;

/** Done over total, as the source screen shows it. */
export const DashboardProgress = z.object({
  done: count,
  total: count,
});
export type DashboardProgress = z.output<typeof DashboardProgress>;

/** A task in review, waiting for someone to look at it. */
export const ReviewItem = z.object({
  task: DashboardTask,
  assignee: AssigneeRef.nullable(),
  /** When the task last entered In review; its updatedAt when no activity records it. */
  since: Timestamp,
});
export type ReviewItem = z.output<typeof ReviewItem>;

/** The newest unanswered comment that mentions a member on an open task. */
export const MentionItem = z.object({
  task: DashboardTask,
  comment: z.object({
    id: CommentId,
    /** Plain text, at most 200 characters plus an ellipsis. Inline code keeps its backticks. */
    excerpt: z.string(),
    createdAt: Timestamp,
  }),
  author: UserRef,
  /** The agent's responsible human when an agent wrote the comment; null for people. */
  onBehalfOf: UserRef.nullable(),
  /** Who has to answer. */
  mentioned: AssigneeRef,
});
export type MentionItem = z.output<typeof MentionItem>;

/** An in-progress task without an update or comment for longer than its threshold. */
export const StalledItem = z.object({
  task: DashboardTask,
  assignee: AssigneeRef.nullable(),
  /** Later of the task's updatedAt and its newest comment. */
  lastTouchedAt: Timestamp,
  /** 24 when an agent holds the task, 120 otherwise. */
  thresholdHours: z.number().int().positive(),
});
export type StalledItem = z.output<typeof StalledItem>;

/**
 * A milestone past its target date, or a current cycle ending within 2 days, that still has open
 * tasks. Milestone progress leaves canceled tasks out of total, like the milestones screen; cycle
 * progress counts every task in the cycle, like the cycles screen.
 */
export const DeadlineItem = z.discriminatedUnion('kind', [
  z.object({
    kind: z.literal('milestone'),
    project: DashboardProjectRef,
    milestone: MilestoneRef.pick({ id: true, name: true }).extend({ targetDate: CalendarDate }),
    /** Days since the target date in APP_TIME_ZONE: 1 the day after it. */
    daysOverdue: z.number().int().positive(),
    openTasks: count,
    progress: DashboardProgress,
  }),
  z.object({
    kind: z.literal('cycle'),
    project: DashboardProjectRef,
    cycle: CycleRef.pick({ number: true, name: true, startsOn: true, endsOn: true }),
    /** Days left including today: 1 on the last day. */
    daysLeft: z.number().int().positive(),
    openTasks: count,
    progress: DashboardProgress,
  }),
]);
export type DeadlineItem = z.output<typeof DeadlineItem>;

/** One queue group: the uncapped count and the first DASHBOARD_GROUP_ITEM_LIMIT items. */
export function dashboardGroup<T extends z.ZodType>(item: T) {
  return z
    .object({
      total: count,
      items: z.array(item).max(DASHBOARD_GROUP_ITEM_LIMIT),
    })
    .refine((group) => group.total >= group.items.length, {
      message: 'total counts every item, so it cannot be below the number of items',
      path: ['total'],
    });
}
export type DashboardGroup<T> = { total: number; items: T[] };

export const ReviewGroup = dashboardGroup(ReviewItem);
export const MentionGroup = dashboardGroup(MentionItem);
export const StalledGroup = dashboardGroup(StalledItem);
export const DeadlineGroup = dashboardGroup(DeadlineItem);

/** One row of the dashboard's project list. It ignores the scope switch. */
export const DashboardProject = z.object({
  key: ProjectKey,
  name: z.string(),
  openCounts: OpenStatusCounts,
  /** Sum of openCounts. */
  openCount: count,
  usesMilestones: z.boolean(),
  usesCycles: z.boolean(),
  /** Same rule as on the projects screen. Sorts the rows, newest first. */
  lastActivityAt: Timestamp,
  /** Null when the project has no current cycle or does not use cycles. total counts every task in the cycle. */
  currentCycle: CurrentCycle.pick({ number: true, name: true, endsOn: true, daysLeft: true })
    .extend({ done: count, total: count })
    .nullable(),
  /**
   * The milestone that is not Completed with the earliest target date (undated ones last). Null
   * when there is none or the project does not use milestones. total leaves canceled tasks out.
   */
  nextMilestone: MilestoneRef.pick({ id: true, name: true, targetDate: true })
    .extend({
      /** Target date before today. */
      overdue: z.boolean(),
      done: count,
      total: count,
      /** Other milestones that are not Completed. */
      others: count,
    })
    .nullable(),
});
export type DashboardProject = z.output<typeof DashboardProject>;

/** One agent in the agents strip. */
export const DashboardAgent = z.object({
  agent: AssigneeRef,
  /** Its in-progress task with the oldest last touch; null when idle. */
  currentTask: DashboardTask.nullable(),
  /** In-progress tasks, currentTask included. */
  inProgressCount: count,
  /** currentTask has had no update or comment for 24 hours. */
  stalled: z.boolean(),
  /** Newest activity row or comment by the agent in projects in scope; null when none. */
  lastActivityAt: Timestamp.nullable(),
});
export type DashboardAgent = z.output<typeof DashboardAgent>;

/** GET /dashboard: the action queue, the project rows and the agents for one scope. */
export const Dashboard = z.object({
  scope: DashboardScope,
  generatedAt: Timestamp,
  groups: z.object({
    review: ReviewGroup,
    mentions: MentionGroup,
    stalled: StalledGroup,
    deadlines: DeadlineGroup,
  }),
  /** Every project in scope, most recently active first. */
  projects: z.array(DashboardProject),
  /** Stalled first, then by name. */
  agents: z.array(DashboardAgent),
});
export type Dashboard = z.output<typeof Dashboard>;

/** GET /dashboard/counts: the Mine queue totals, for the rail. */
export const DashboardCounts = z
  .object({
    review: count,
    mentions: count,
    stalled: count,
    deadlines: count,
    /** Sum of the four groups. */
    total: count,
  })
  .refine((c) => c.total === c.review + c.mentions + c.stalled + c.deadlines, {
    message: 'total is the sum of the four groups',
    path: ['total'],
  });
export type DashboardCounts = z.output<typeof DashboardCounts>;

// ---------------------------------------------------------------------------
// Home (M5): replaces the dashboard and My tasks
// ---------------------------------------------------------------------------

/**
 * mine: what needs the caller: tasks In review that wait on them (including their agents'
 * work), mentions of them, and their own tasks (assigned to them, or created by them with
 * nobody holding it) that are blocked, overdue or assigned. Their agents' other work is on the
 * agents tab. everyone: the whole workspace the caller can read. agents: one card per agent and
 * what agents wait on people for.
 */
export const HOME_TABS = ['mine', 'everyone', 'agents'] as const;
export const HomeTab = z.enum(HOME_TABS);
export type HomeTab = z.infer<typeof HomeTab>;

/**
 * Home groups. review: tasks In review. mentions: unanswered comments mentioning the caller (Mine
 * only). blocked: open tasks with an open blocker. overdue: open tasks due before today.
 * assigned: the rest of the caller's open tasks, by due date (overdue first, none last) then
 * priority. dueThisWeek: open tasks due from today to the end of the week (Everyone).
 * waiting: agent questions and review requests that wait on a person (Agents).
 */
export const HOME_GROUP_KEYS = [
  'review',
  'mentions',
  'blocked',
  'overdue',
  'assigned',
  'dueThisWeek',
  'waiting',
] as const;
export const HomeGroupKey = z.enum(HOME_GROUP_KEYS);
export type HomeGroupKey = z.infer<typeof HomeGroupKey>;

/** The groups of each tab, in order. A task shows once, in the first group it qualifies for. */
export const HOME_GROUPS_BY_TAB = {
  mine: ['review', 'mentions', 'blocked', 'overdue', 'assigned'],
  everyone: ['review', 'blocked', 'overdue', 'dueThisWeek'],
  agents: ['waiting'],
} as const satisfies Record<HomeTab, readonly HomeGroupKey[]>;

/** Most items a Home group returns. `total` still counts every item. */
export const HOME_GROUP_ITEM_LIMIT = 50;

/** Most recent actions on an agent card. */
export const HOME_AGENT_ACTION_LIMIT = 5;

/** A task as Home names it outside the rows: deadlines and agent cards. */
export const HomeTaskRef = z.object({
  key: TaskKey,
  title: z.string(),
  status: TaskStatus,
  project: ProjectRef,
});
export type HomeTaskRef = z.output<typeof HomeTaskRef>;

/**
 * Mine only: why the task is the caller's. assignee: assigned to them. agent: assigned to an agent
 * they are responsible for. creator: they created it and nobody holds it ("you created it").
 */
export const HOME_RELATIONS = ['assignee', 'agent', 'creator'] as const;
export const HomeRelation = z.enum(HOME_RELATIONS);
export type HomeRelation = z.infer<typeof HomeRelation>;

/** The comment behind a mention or an agent question. */
const HomeComment = z.object({
  id: CommentId,
  /** Plain text, at most 200 characters plus an ellipsis. Inline code keeps its backticks. */
  excerpt: z.string(),
});

/**
 * Why a row is in its group: the reason line at the right of a Home row. The reason actor and
 * time sit on the variant that has them.
 */
export const HomeReason = z.discriminatedUnion('kind', [
  z.object({
    kind: z.literal('review'),
    /** Who moved it to In review ("claude-dev · 40 min ago"); null when no activity records it. */
    requestedBy: UserRef.nullable(),
    /** The agent's responsible human when an agent asked; null for people. */
    onBehalfOf: UserRef.nullable(),
    /**
     * Who the review waits on ("waits on Ana"): the responsible human of an agent assignee, else
     * the task's creator. Null when nobody can be named.
     */
    waitingOn: UserRef.nullable(),
    /** When it entered In review; its updatedAt when no activity records it. */
    at: Timestamp,
  }),
  z.object({
    kind: z.literal('mention'),
    /** The comment's author ("Tomás · 1 d ago"); on Agents, the agent that asks. */
    author: UserRef,
    onBehalfOf: UserRef.nullable(),
    /** Who has to answer ("asks Ana"). */
    mentioned: UserRef,
    comment: HomeComment,
    at: Timestamp,
  }),
  z.object({
    kind: z.literal('blocked'),
    /** The open blockers ("by PAY-120, PAY-138"), by key. null: hidden from the caller. */
    blockers: z.array(RelatedTask.nullable()).min(1),
  }),
  z.object({
    kind: z.literal('overdue'),
    dueDate: CalendarDate,
    /** Days since the due date in APP_TIME_ZONE: 1 the day after it. */
    daysOverdue: z.number().int().positive(),
  }),
  z.object({
    kind: z.literal('due'),
    dueDate: CalendarDate,
    /** Days until the due date: 0 today. */
    daysLeft: z.number().int().nonnegative(),
  }),
  /** Assigned to you: no reason line. */
  z.object({ kind: z.literal('assigned') }),
]);
export type HomeReason = z.output<typeof HomeReason>;

/**
 * The task's other states, as small pills after the title ("blocked", "3 d overdue", "blocks 2",
 * "in Cycle 12", "asks a question", "needs owner"). The state of the row's own group is not
 * repeated. Order: as listed here.
 */
export const HomePill = z.discriminatedUnion('kind', [
  z.object({ kind: z.literal('review') }),
  z.object({ kind: z.literal('blocked') }),
  z.object({ kind: z.literal('overdue'), daysOverdue: z.number().int().positive() }),
  z.object({ kind: z.literal('due'), daysLeft: z.number().int().nonnegative() }),
  /** Open tasks waiting on this one. */
  z.object({ kind: z.literal('blocks'), count: z.number().int().positive() }),
  z.object({ kind: z.literal('cycle'), cycle: CycleRef.pick({ number: true, name: true }) }),
  /** The newest unanswered mention is a question from an agent. */
  z.object({ kind: z.literal('question') }),
  /** Nobody holds the task. */
  z.object({ kind: z.literal('unassigned') }),
]);
export type HomePill = z.output<typeof HomePill>;

/** One Home row: the task as the list shows it, why it is here, and its other states. */
export const HomeItem = z.object({
  task: TaskListItem,
  reason: HomeReason,
  /** Mine only; null on the other tabs. */
  relation: HomeRelation.nullable(),
  pills: z.array(HomePill),
});
export type HomeItem = z.output<typeof HomeItem>;

/** One Home group: the uncapped count and the first HOME_GROUP_ITEM_LIMIT items. */
export const HomeGroup = z
  .object({
    key: HomeGroupKey,
    total: z.number().int().nonnegative(),
    items: z.array(HomeItem).max(HOME_GROUP_ITEM_LIMIT),
  })
  .refine((group) => group.total >= group.items.length, {
    message: 'total counts every item, so it cannot be below the number of items',
    path: ['total'],
  });
export type HomeGroup = z.output<typeof HomeGroup>;

/**
 * One entry of the deadlines strip, soonest first: milestones not Completed and current cycles
 * ending within 2 days (or milestones past their target) with open tasks, and open tasks of the
 * tab due within 2 days or overdue. Milestone progress leaves canceled tasks out; cycle progress
 * counts every task in the cycle.
 */
export const HomeDeadline = z.discriminatedUnion('kind', [
  z.object({
    kind: z.literal('milestone'),
    project: ProjectRef,
    milestone: MilestoneRef.pick({ id: true, name: true }).extend({ targetDate: CalendarDate }),
    /** Days from today to the target date: 0 on the day, negative once overdue. */
    daysLeft: z.number().int(),
    progress: DashboardProgress,
  }),
  z.object({
    kind: z.literal('cycle'),
    project: ProjectRef,
    cycle: CycleRef.pick({ number: true, name: true, startsOn: true, endsOn: true }),
    /** Days left including today: 1 on the last day. */
    daysLeft: z.number().int().positive(),
    progress: DashboardProgress,
  }),
  z.object({
    kind: z.literal('task'),
    task: HomeTaskRef,
    dueDate: CalendarDate,
    /** Days from today to the due date: 0 today, negative once overdue. */
    daysLeft: z.number().int(),
  }),
]);
export type HomeDeadline = z.output<typeof HomeDeadline>;

/** working: the agent holds an In progress task updated in the last hour. idle otherwise. */
export const HOME_AGENT_STATES = ['working', 'idle'] as const;
export const HomeAgentState = z.enum(HOME_AGENT_STATES);
export type HomeAgentState = z.infer<typeof HomeAgentState>;

/**
 * One line of an agent card's recent actions, newest first. The UI words it from the activity
 * changes ("moved to In review") or the comment ("asked Ana a question").
 */
export const HomeAgentAction = z.discriminatedUnion('kind', [
  z.object({
    kind: z.literal('activity'),
    id: RowId,
    task: HomeTaskRef,
    type: TaskActivityType,
    changes: z.array(ActivityChange),
    at: Timestamp,
  }),
  z.object({
    kind: z.literal('comment'),
    id: CommentId,
    task: HomeTaskRef,
    excerpt: z.string(),
    /** Members the comment mentions, in order of first mention. */
    mentions: z.array(UserRef),
    at: Timestamp,
  }),
]);
export type HomeAgentAction = z.output<typeof HomeAgentAction>;

/** One agent card on the Agents tab. */
export const HomeAgent = z.object({
  /** With its responsible human ("acts for Ana"). */
  agent: AssigneeRef,
  state: HomeAgentState,
  /** working only: the task and when it entered In progress ("for 22 min"). Null when idle. */
  currentTask: HomeTaskRef.extend({ since: Timestamp }).nullable(),
  counts: z.object({
    /** Open tasks assigned to the agent. */
    assigned: z.number().int().nonnegative(),
    /** Its tasks In review ("waiting for review"). */
    inReview: z.number().int().nonnegative(),
    /** Its open tasks with an open blocker. */
    blocked: z.number().int().nonnegative(),
    /** Activity rows and comments by the agent since the start of today in APP_TIME_ZONE. */
    changesToday: z.number().int().nonnegative(),
  }),
  /** Newest first, at most HOME_AGENT_ACTION_LIMIT. An idle card shows the first as "Last: …". */
  recent: z.array(HomeAgentAction).max(HOME_AGENT_ACTION_LIMIT),
  /** Newest activity row or comment by the agent; null when none. */
  lastActivityAt: Timestamp.nullable(),
});
export type HomeAgent = z.output<typeof HomeAgent>;

/**
 * Tab counts in the Home header. mine: review + mentions + blocked + overdue (assigned is not
 * counted; the sidebar shows the same number). everyone: the sum of its four groups. agents: the
 * number of agent cards.
 */
export const HomeTabCounts = z.object({
  mine: z.number().int().nonnegative(),
  everyone: z.number().int().nonnegative(),
  agents: z.number().int().nonnegative(),
});
export type HomeTabCounts = z.output<typeof HomeTabCounts>;

/** GET /home?tab=mine|everyone|agents. */
export const Home = z.object({
  tab: HomeTab,
  generatedAt: Timestamp,
  counts: HomeTabCounts,
  /** Empty on the Agents tab. */
  deadlines: z.array(HomeDeadline),
  /** HOME_GROUPS_BY_TAB[tab], in that order, empty groups included. */
  groups: z.array(HomeGroup),
  /** Agents tab only (empty otherwise): working first, then by name. */
  agents: z.array(HomeAgent),
});
export type Home = z.output<typeof Home>;

/** GET /home/counts: the sidebar count of what needs the caller (the Mine tab count). */
export const HomeCounts = z
  .object({
    review: z.number().int().nonnegative(),
    mentions: z.number().int().nonnegative(),
    blocked: z.number().int().nonnegative(),
    overdue: z.number().int().nonnegative(),
    /** review + mentions + blocked + overdue. */
    total: z.number().int().nonnegative(),
  })
  .refine((c) => c.total === c.review + c.mentions + c.blocked + c.overdue, {
    message: 'total is the sum of the four groups',
    path: ['total'],
  });
export type HomeCounts = z.output<typeof HomeCounts>;

// ---------------------------------------------------------------------------
// List wrappers
// ---------------------------------------------------------------------------

export const ProjectList = z.object({ items: z.array(ProjectWithCounts) });
export type ProjectList = z.output<typeof ProjectList>;

export const ActivityList = z.object({ items: z.array(Activity) });
export type ActivityList = z.output<typeof ActivityList>;

export const MemberList = z.object({ items: z.array(Member) });
export type MemberList = z.output<typeof MemberList>;

export const MilestoneList = z.object({ items: z.array(MilestoneWithProgress) });
export type MilestoneList = z.output<typeof MilestoneList>;

export const CycleList = z.object({ items: z.array(Cycle) });
export type CycleList = z.output<typeof CycleList>;

export const CommentList = z.object({ items: z.array(Comment) });
export type CommentList = z.output<typeof CommentList>;

export const Timeline = z.object({
  items: z.array(TimelineItem),
  /** M6: the four filter counts. Optional in the type so older shapes stay valid; servers send them. */
  counts: TimelineCounts.optional(),
});
export type Timeline = z.output<typeof Timeline>;

// ---------------------------------------------------------------------------
// Git connections (M3)
// ---------------------------------------------------------------------------

/** A connection as other shapes reference it. */
export const GitConnectionRef = z.object({
  id: GitConnectionId,
  name: z.string(),
  provider: GitProvider,
  host: z.string(),
  status: GitConnectionStatus,
});
export type GitConnectionRef = z.output<typeof GitConnectionRef>;

/** A project that reads through a connection; paused when its mirror is paused. */
export const GitConnectionUse = ProjectRef.extend({
  paused: z.boolean(),
});
export type GitConnectionUse = z.output<typeof GitConnectionUse>;

/** A workspace git connection. The token never leaves the server; tokenHint is its last 3 characters. */
export const GitConnection = GitConnectionRef.extend({
  /** https://api.github.com, https://host/api/v3, https://host/api/v4 or https://host/api/v1. */
  apiBaseUrl: z.string(),
  tokenHint: z.string(),
  checkedAt: Timestamp.nullable(),
  /** The login the token belongs to, from the last working check. */
  checkedLogin: z.string().nullable(),
  /** Why the last check failed, without the token. */
  checkedDetail: z.string().nullable(),
  /** Projects whose Backlog.md source uses this connection (detached ones excluded). */
  usedBy: z.array(GitConnectionUse),
  createdBy: UserRef,
  createdAt: Timestamp,
  updatedAt: Timestamp,
});
export type GitConnection = z.output<typeof GitConnection>;

export const GitConnectionList = z.object({
  items: z.array(GitConnection),
  /** False when APP_ENCRYPTION_KEY is not set: connections cannot be added or used. */
  encryptionReady: z.boolean(),
});
export type GitConnectionList = z.output<typeof GitConnectionList>;

/** Result of testing a token: whoami plus a repository count where the provider offers one. */
export const GitConnectionTestResult = z.object({
  status: GitConnectionStatus.exclude(['unchecked']),
  login: z.string().nullable(),
  /** Repositories the token can read; null when the provider does not say. */
  repoCount: z.number().int().nonnegative().nullable(),
  /** Short reason for rejected or unreachable, without the token. */
  detail: z.string().nullable(),
  checkedAt: Timestamp,
});
export type GitConnectionTestResult = z.output<typeof GitConnectionTestResult>;

/** Result of deleting a connection: the projects whose mirrors paused. */
export const GitConnectionDeleted = z.object({
  id: GitConnectionId,
  pausedProjects: z.array(ProjectRef),
});
export type GitConnectionDeleted = z.output<typeof GitConnectionDeleted>;

// ---------------------------------------------------------------------------
// Backlog.md sources (M3)
// ---------------------------------------------------------------------------

/** How a mapping row was decided: prefilled by name, fallen back, or chosen by a person. */
export const MAPPING_HOWS = ['name', 'fallback', 'manual'] as const;
export const MappingHow = z.enum(MAPPING_HOWS);
export type MappingHow = z.infer<typeof MappingHow>;

/** A Backlog.md value as written in the files ("In Progress", "high", "@claude"). */
export const BacklogValue = z.string().trim().min(1, 'Value is required').max(200);

export const StatusMapping = z.object({ from: BacklogValue, to: TaskStatus, how: MappingHow });
export type StatusMapping = z.output<typeof StatusMapping>;

export const PriorityMapping = z.object({ from: BacklogValue, to: Priority, how: MappingHow });
export type PriorityMapping = z.output<typeof PriorityMapping>;

/** userId null: no one (the task stays unassigned and keeps the value in its Backlog.md block). */
export const AssigneeMapping = z.object({ from: BacklogValue, userId: UserId.nullable(), how: MappingHow });
export type AssigneeMapping = z.output<typeof AssigneeMapping>;

/** Longest mapping list per kind. */
export const MAX_MAPPING_ROWS = 500;

/** No two rows of one kind may map the same value (compared ignoring case). */
function uniqueFrom(rows: { from: string }[], ctx: z.RefinementCtx) {
  const seen = new Set<string>();
  rows.forEach((row, index) => {
    const key = row.from.toLowerCase();
    if (seen.has(key)) {
      ctx.addIssue({ code: 'custom', path: [index, 'from'], message: `"${row.from}" is mapped twice` });
    }
    seen.add(key);
  });
}

/**
 * backlog_source.mappings and the mappings every setup and settings input carries. Values seen
 * later without a row get the fallback (status Todo, priority none, no assignee) and a warning.
 */
export const BacklogMappings = z.object({
  status: z.array(StatusMapping).max(MAX_MAPPING_ROWS).superRefine(uniqueFrom),
  priority: z.array(PriorityMapping).max(MAX_MAPPING_ROWS).superRefine(uniqueFrom),
  assignee: z.array(AssigneeMapping).max(MAX_MAPPING_ROWS).superRefine(uniqueFrom),
});
export type BacklogMappings = z.output<typeof BacklogMappings>;

/** Mapping rows as shown: with the number of tasks using the value, and assignees resolved. */
export const BacklogMappingsView = z.object({
  status: z.array(StatusMapping.extend({ count: z.number().int().nonnegative() })),
  priority: z.array(PriorityMapping.extend({ count: z.number().int().nonnegative() })),
  assignee: z.array(
    AssigneeMapping.extend({ count: z.number().int().nonnegative(), user: UserRef.nullable() }),
  ),
});
export type BacklogMappingsView = z.output<typeof BacklogMappingsView>;

/** The parts of config.yml the app uses, as stored in backlog_source.config. */
export const BacklogConfigSummary = z.object({
  projectName: z.string().nullable(),
  /** Uppercase task_prefix: BACK (Backlog.md's default is TASK). */
  taskPrefix: z.string(),
  statuses: z.array(z.string()),
  defaultStatus: z.string().nullable(),
  priorities: z.array(z.string()),
  labels: z.array(z.string()),
  /** Legacy `milestones:` list in config.yml. */
  milestones: z.array(z.string()),
  zeroPaddedIds: z.number().int().nonnegative().nullable(),
});
export type BacklogConfigSummary = z.output<typeof BacklogConfigSummary>;

/** Fields whose values go through a mapping or a lookup, and can fall back. */
export const BACKLOG_VALUE_FIELDS = ['status', 'priority', 'assignee', 'milestone'] as const;
export const BacklogValueField = z.enum(BACKLOG_VALUE_FIELDS);
export type BacklogValueField = z.infer<typeof BacklogValueField>;

/**
 * One problem of the last read (or of a preview).
 * file: a file skipped (`skipped`, its task keeps the last good version) or read with a warning
 * (an unreadable date, a missing parent, a duplicate id), e.g. "dependencies must be a flat list (line 9)".
 * value: a value without a mapping or match, and what it fell back to.
 */
export const BacklogProblem = z.discriminatedUnion('kind', [
  z.object({
    kind: z.literal('file'),
    path: z.string(),
    backlogId: z.string().nullable(),
    skipped: z.boolean(),
    message: z.string(),
  }),
  z.object({
    kind: z.literal('value'),
    field: BacklogValueField,
    value: z.string(),
    /** Tasks that carry the value. */
    count: z.number().int().nonnegative(),
    /** Label of what the tasks got instead ("Todo", "No one"); null when the value is just dropped. */
    fallback: z.string().nullable(),
    message: z.string(),
  }),
]);
export type BacklogProblem = z.output<typeof BacklogProblem>;

/** One page of problems, files first (by path), then values. */
export const BacklogProblemPage = z.object({
  items: z.array(BacklogProblem),
  nextCursor: z.string().nullable(),
  counts: BacklogProblemCounts,
});
export type BacklogProblemPage = z.output<typeof BacklogProblemPage>;

/** Content counts of a source (visible tasks unless named otherwise). */
export const BacklogCounts = z.object({
  tasks: z.number().int().nonnegative(),
  /** Tasks in an open status. */
  open: z.number().int().nonnegative(),
  drafts: z.number().int().nonnegative(),
  archived: z.number().int().nonnegative(),
  subtasks: z.number().int().nonnegative(),
  milestones: z.number().int().nonnegative(),
  hidden: z.number().int().nonnegative(),
});
export type BacklogCounts = z.output<typeof BacklogCounts>;

/** The last successful read. */
export const BacklogRead = z.object({
  at: Timestamp,
  trigger: BacklogTrigger.nullable(),
  commit: z.string(),
  /** Web page of the commit on the provider; null when unknown. */
  commitUrl: z.string().nullable().default(null),
  /** First line of the commit message, when the provider gave it. */
  commitTitle: z.string().nullable().default(null),
});
export type BacklogRead = z.output<typeof BacklogRead>;

/** GET /projects/{key}/backlog, the settings page and zamu backlog status. */
export const BacklogSourceStatus = z.object({
  id: BacklogSourceId,
  project: ProjectRef,
  mode: BacklogMode,
  state: BacklogState,
  /** The project's repository as entered; null when it was cleared (the mirror pauses). */
  repository: z.string().nullable(),
  defaultBranch: z.string().nullable(),
  /** The folder the last read used (backlog, .backlog, ...). */
  folder: z.string().nullable(),
  /** The folder chosen by hand; null: detected. */
  folderOverride: z.string().nullable(),
  /** Uppercase task_prefix: BACK. */
  prefix: z.string().nullable(),
  /** Null once the connection was deleted. */
  connection: GitConnectionRef.nullable(),
  /** Head of the default branch at the last attempt. */
  headCommit: z.string().nullable(),
  lastRead: BacklogRead.nullable(),
  lastAttemptAt: Timestamp.nullable(),
  lastTrigger: BacklogTrigger.nullable(),
  /** Why the last refresh failed or the source paused. */
  lastError: z.string().nullable(),
  /** The next hourly check; null when paused or detached. */
  nextPollAt: Timestamp.nullable(),
  /** When the last accepted webhook delivery arrived; null: never. */
  webhookLastAt: Timestamp.nullable(),
  counts: BacklogCounts,
  problems: BacklogProblemPage,
  mappings: BacklogMappingsView,
  config: BacklogConfigSummary.nullable(),
  createdBy: UserRef,
  createdAt: Timestamp,
  detachedAt: Timestamp.nullable(),
  detachedBy: UserRef.nullable(),
  /** Project-level entries, oldest first. */
  history: z.array(ProjectActivity),
  /** The key the next task created in the app gets (after detach): PAY-813. */
  nextTaskKey: z.string().optional(),
});
export type BacklogSourceStatus = z.output<typeof BacklogSourceStatus>;

/** POST /projects/{key}/backlog/refresh (202). queued is false when a run was already waiting. */
export const BacklogRefreshResult = z.object({
  project: ProjectKey,
  state: BacklogState,
  queued: z.boolean(),
  lastAttemptAt: Timestamp.nullable(),
});
export type BacklogRefreshResult = z.output<typeof BacklogRefreshResult>;

/** How the folder was found: by hand, backlog_directory in backlog.config.yml, or the defaults. */
export const BACKLOG_FOLDER_SOURCES = ['override', 'config', 'default'] as const;
export const BacklogFolderSource = z.enum(BACKLOG_FOLDER_SOURCES);
export type BacklogFolderSource = z.infer<typeof BacklogFolderSource>;

/** Whether the connection can read the repository. */
export const BACKLOG_ACCESS = ['ok', 'no_access', 'not_found', 'unreachable'] as const;
export const BacklogAccess = z.enum(BACKLOG_ACCESS);
export type BacklogAccess = z.infer<typeof BacklogAccess>;

/** One subfolder of the Backlog.md folder and its file count; docs/ and decisions/ are ignored. */
export const BacklogFolderCount = z.object({
  /** Relative to the Backlog.md folder, with a trailing slash: tasks/, archive/tasks/. */
  path: z.string(),
  count: z.number().int().nonnegative(),
  ignored: z.boolean(),
});
export type BacklogFolderCount = z.output<typeof BacklogFolderCount>;

/** Setup step 2 (source): what the connection sees in the project's repository. Nothing is written. */
export const BacklogDetection = z.object({
  repository: z.string(),
  access: BacklogAccess,
  defaultBranch: z.string().nullable(),
  headCommit: z.string().nullable(),
  headCommittedAt: Timestamp.nullable().default(null),
  /** Null when no Backlog.md folder was found. */
  folder: z.string().nullable(),
  folderSource: BacklogFolderSource.nullable(),
  config: BacklogConfigSummary.nullable(),
  /** Why config.yml could not be read; the setup cannot continue then. */
  configError: z.string().nullable(),
  folders: z.array(BacklogFolderCount),
  /** True when the project key equals the task prefix (BACK-786 stays BACK-786). */
  keyMatchesPrefix: z.boolean(),
  /** Mappings prefilled by name from every value in the files (setup step 3). */
  mappings: BacklogMappingsView,
});
export type BacklogDetection = z.output<typeof BacklogDetection>;

/** A sample row of the preview: BACK-786 → PAY-786. */
export const BacklogPreviewRow = z.object({
  backlogId: z.string(),
  key: TaskKey,
  title: z.string(),
  status: TaskStatus,
  kind: BacklogTaskKind,
});
export type BacklogPreviewRow = z.output<typeof BacklogPreviewRow>;

/** Setup step 4: a dry run of the refresh on the current head. Nothing is written. */
export const BacklogPreview = z.object({
  commit: z.string(),
  defaultBranch: z.string(),
  counts: z.object({
    tasks: z.number().int().nonnegative(),
    open: z.number().int().nonnegative(),
    drafts: z.number().int().nonnegative(),
    archived: z.number().int().nonnegative(),
    /** Archived tasks found in the legacy completed/ folder (included in archived). */
    completed: z.number().int().nonnegative(),
    subtasks: z.number().int().nonnegative(),
    milestones: z.number().int().nonnegative(),
    archivedMilestones: z.number().int().nonnegative(),
  }),
  /** The first rows in Backlog.md order. */
  sample: z.array(BacklogPreviewRow),
  /** Files that would be skipped or read with a warning. */
  files: z.array(BacklogProblem),
  /** Values that would fall back. */
  fallbacks: z.array(BacklogProblem),
});
export type BacklogPreview = z.output<typeof BacklogPreview>;

export const BACKLOG_WEBHOOK_SECRET_STATES = ['ok', 'unreadable', 'hidden'] as const;
/**
 * Whether the webhook secret could be shown: ok (it is in `secret`), unreadable (the stored secret
 * can't be decrypted with the current APP_ENCRYPTION_KEY; issue a new one), hidden (the actor can't
 * manage the source, or it has no secret after detach).
 */
export const BacklogWebhookSecretState = z.enum(BACKLOG_WEBHOOK_SECRET_STATES);
export type BacklogWebhookSecretState = z.infer<typeof BacklogWebhookSecretState>;

const BacklogWebhookInfoShape = z.object({
  url: z.url(),
  secret: z.string().nullable(),
  /** 0.6.0. */
  secretState: BacklogWebhookSecretState,
  provider: GitProvider.nullable(),
  lastAt: Timestamp.nullable(),
});

/**
 * Webhook settings of a source. The secret is present only for backlog.manage (owners and admins).
 * Servers send secretState; when one leaves it out it follows `secret` (a string is ok, null is
 * hidden), so shapes built before the field existed stay valid. Unreadable is never inferred.
 */
export const BacklogWebhookInfo = BacklogWebhookInfoShape.extend({
  secretState: BacklogWebhookSecretState.optional(),
})
  .transform(
    (info): z.input<typeof BacklogWebhookInfoShape> => ({
      ...info,
      secretState: info.secretState ?? (info.secret === null ? 'hidden' : 'ok'),
    }),
  )
  .pipe(BacklogWebhookInfoShape);
export type BacklogWebhookInfo = z.output<typeof BacklogWebhookInfo>;

/** A newly issued webhook secret, shown once. The URL is unchanged. */
export const BacklogWebhookSecret = z.object({
  url: z.url(),
  secret: z.string().min(1),
});
export type BacklogWebhookSecret = z.output<typeof BacklogWebhookSecret>;

// ---------------------------------------------------------------------------
// Backlog.md export (M6): GET /projects/{project}/backlog/export
// ---------------------------------------------------------------------------

/**
 * The folders under the Backlog.md folder that an export owns: tasks in tasks/, milestones in
 * milestones/, and the legacy completed/ folder, which an export only prunes. The CLI writes and
 * prunes only these.
 */
export const BACKLOG_EXPORT_FOLDERS = ['tasks', 'completed', 'milestones'] as const;
export const BACKLOG_EXPORT_PREFIXES = ['tasks/', 'completed/', 'milestones/'] as const;
export const BacklogExportPrefix = z.enum(BACKLOG_EXPORT_PREFIXES);
export type BacklogExportPrefix = z.infer<typeof BacklogExportPrefix>;

/**
 * A file path of an export, relative to the Backlog.md folder: inside one of the owned folders,
 * forward slashes, no `.` or `..` parts, no leading slash. Clients write files only at such paths.
 */
export const BacklogExportPath = z
  .string()
  .min(1)
  .max(500)
  .refine((path) => !path.startsWith('/') && !path.includes('\\') && !/\p{Cc}/u.test(path), {
    message: 'Use a relative path with forward slashes',
  })
  .refine((path) => path.split('/').every((part) => part !== '' && part !== '.' && part !== '..'), {
    message: 'Use a plain path without empty, . or .. parts',
  })
  .refine((path) => BACKLOG_EXPORT_PREFIXES.some((prefix) => path.startsWith(prefix)), {
    message: `Write under ${BACKLOG_EXPORT_PREFIXES.join(', ')}`,
  });

export const BacklogExportFile = z.object({
  path: BacklogExportPath,
  /** The whole file, UTF-8 text with \n line ends. */
  content: z.string(),
});
export type BacklogExportFile = z.output<typeof BacklogExportFile>;

/**
 * A project written out as Backlog.md files, for native projects and projects switched to Zamu
 * (a project that still mirrors answers 409 PROJECT_MIRRORED). Task files that Zamu no longer has
 * are the client's to remove: every file under removedPrefixes that is not in `files`.
 */
export const BacklogExport = z
  .object({
    project: ProjectKey,
    /** The Backlog.md file format the files target, e.g. "backlog.md 1". */
    format: z.string(),
    generatedAt: Timestamp,
    files: z.array(BacklogExportFile),
    removedPrefixes: z.array(BacklogExportPrefix),
  })
  .refine((value) => new Set(value.files.map((file) => file.path)).size === value.files.length, {
    message: 'Each path appears once',
    path: ['files'],
  });
export type BacklogExport = z.output<typeof BacklogExport>;
