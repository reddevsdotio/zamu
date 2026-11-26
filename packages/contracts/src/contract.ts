import { type InferContractRouterInputs, type InferContractRouterOutputs, oc } from '@orpc/contract';
import { z } from 'zod';
import {
  ActivityList,
  ArchivePreview,
  BacklogExport,
  BacklogRefreshResult,
  BacklogSourceStatus,
  Comment,
  CommentList,
  CycleDetail,
  CycleList,
  Dashboard,
  DashboardCounts,
  Home,
  HomeCounts,
  LabelList,
  LabelWithUsage,
  Me,
  MemberList,
  MilestoneList,
  MilestoneWithProgress,
  Project,
  ProjectList,
  PullRequestLink,
  RepositorySettings,
  RepositoryWebhookSecret,
  Task,
  TaskBulkResult,
  TaskListPage,
  Timeline,
} from './entities';
import {
  ArchivePreviewInput,
  ArchiveTasksInput,
  BulkUpdateTasksInput,
  CreateCommentInput,
  CreateCycleInput,
  CreateLabelInput,
  CreateMilestoneInput,
  CreateProjectInput,
  CreateTaskInput,
  DeleteCommentInput,
  DeleteLabelInput,
  DeleteMilestoneInput,
  DeleteProjectInput,
  EndCycleInput,
  ExportBacklogInput,
  GetBacklogStatusInput,
  GetCycleInput,
  GetDashboardInput,
  GetHomeInput,
  GetMilestoneInput,
  GetRepositorySettingsInput,
  GetTaskInput,
  LinkPullRequestInput,
  ListCommentsInput,
  ListCyclesInput,
  ListLabelsInput,
  ListMilestonesInput,
  ListTaskActivityInput,
  ListTasksInput,
  ListTaskTimelineInput,
  NewRepositoryWebhookSecretInput,
  RefreshBacklogInput,
  RestoreTasksInput,
  SyncRepositoryInput,
  UnlinkPullRequestInput,
  UpdateCommentInput,
  UpdateCycleInput,
  UpdateLabelInput,
  UpdateMeInput,
  UpdateMilestoneInput,
  UpdateProjectInput,
  UpdateRepositoryInput,
  UpdateTaskInput,
} from './inputs';
import { PROBLEM_STATUS, ProblemData } from './problem';

/** Every path in the contract starts with this prefix. Mount the OpenAPI handler without a prefix. */
export const API_PREFIX = '/api/v1';

/**
 * Request header naming the workspace by slug (current or old). The web app sets it on every call;
 * a session without it uses the workspace the person used last. An API key is refused with 403
 * WORKSPACE_MISMATCH when the header names another workspace than the key's. 0.10, PM-39.
 */
export const WORKSPACE_HEADER = 'x-zamu-workspace';

/** Data of the TASK_CHANGED error: the task as it is now, so the client can roll back to it. */
export const TaskChangedProblemData = ProblemData.extend({ task: Task });
export type TaskChangedProblemData = z.output<typeof TaskChangedProblemData>;

/**
 * Errors any procedure may return. Bodies follow the Problem schema when the server sets
 * `customErrorResponseBodyEncoder`; generate the document with a Problem schema as
 * `customErrorResponseBodySchema` (problemJsonSchema, or a $ref to a Problem component) so it matches.
 */
export const apiErrors = {
  BAD_REQUEST: { status: PROBLEM_STATUS.BAD_REQUEST, data: ProblemData },
  UNAUTHORIZED: { status: PROBLEM_STATUS.UNAUTHORIZED, data: ProblemData },
  FORBIDDEN: { status: PROBLEM_STATUS.FORBIDDEN, data: ProblemData },
  NOT_FOUND: { status: PROBLEM_STATUS.NOT_FOUND, data: ProblemData },
  CONFLICT: { status: PROBLEM_STATUS.CONFLICT, data: ProblemData },
  /** A task write with a stale ifUpdatedAt (409). */
  TASK_CHANGED: { status: PROBLEM_STATUS.TASK_CHANGED, data: TaskChangedProblemData },
  UNPROCESSABLE_CONTENT: { status: PROBLEM_STATUS.UNPROCESSABLE_CONTENT, data: ProblemData },
  // M3, all 409. The *_MIRRORED bodies carry field, file, backlogId and hint.
  /** A write to a field Backlog.md owns on a mirrored task. */
  TASK_MIRRORED: { status: PROBLEM_STATUS.TASK_MIRRORED, data: ProblemData },
  /** Creating, changing or deleting a milestone of a mirrored project. */
  MILESTONE_MIRRORED: { status: PROBLEM_STATUS.MILESTONE_MIRRORED, data: ProblemData },
  /** Creating a task in a mirrored project, or a project change the mirror forbids. */
  PROJECT_MIRRORED: { status: PROBLEM_STATUS.PROJECT_MIRRORED, data: ProblemData },
  /** Setting up Backlog.md on a project that has tasks. */
  PROJECT_NOT_EMPTY: { status: PROBLEM_STATUS.PROJECT_NOT_EMPTY, data: ProblemData },
  /** Refreshing a mirror whose connection is missing, rejected or unreachable. */
  BACKLOG_PAUSED: { status: PROBLEM_STATUS.BACKLOG_PAUSED, data: ProblemData },
  /** Refreshing a source that was detached. */
  BACKLOG_DETACHED: { status: PROBLEM_STATUS.BACKLOG_DETACHED, data: ProblemData },
  // M5
  /** A label name the project has already, ignoring case (409). */
  LABEL_EXISTS: { status: PROBLEM_STATUS.LABEL_EXISTS, data: ProblemData },
  /** Renaming or deleting a label from Backlog.md files (409). */
  LABEL_MIRRORED: { status: PROBLEM_STATUS.LABEL_MIRRORED, data: ProblemData },
  /** A blocker that would close a loop (409). */
  DEPENDENCY_LOOP: { status: PROBLEM_STATUS.DEPENDENCY_LOOP, data: ProblemData },
  /** A parent or subtask that would nest more than one level (409). */
  SUBTASK_DEPTH: { status: PROBLEM_STATUS.SUBTASK_DEPTH, data: ProblemData },
  /** Related tasks, labels, or a bulk milestone or cycle across projects (422). */
  NOT_SAME_PROJECT: { status: PROBLEM_STATUS.NOT_SAME_PROJECT, data: ProblemData },
  // M6
  /** An agent moving a task to In review or Done with open criteria or done items (409, openItems). */
  OPEN_ITEMS: { status: PROBLEM_STATUS.OPEN_ITEMS, data: ProblemData },
  // 0.10: multiple workspaces
  /** Signed in, but not a member of the workspace the request names (403). */
  NOT_A_MEMBER: { status: PROBLEM_STATUS.NOT_A_MEMBER, data: ProblemData },
  /** An API key with a workspace header naming another workspace (403). */
  WORKSPACE_MISMATCH: { status: PROBLEM_STATUS.WORKSPACE_MISMATCH, data: ProblemData },
  // M7
  /** Any write to an archived task but restore, comments and notes included (409). */
  TASK_ARCHIVED: { status: PROBLEM_STATUS.TASK_ARCHIVED, data: ProblemData },
  /** A request URL of another repository than the project's (422, repository). */
  REQUEST_OTHER_REPOSITORY: { status: PROBLEM_STATUS.REQUEST_OTHER_REPOSITORY, data: ProblemData },
  /** An address that is not a pull or merge request (422). */
  NOT_A_REQUEST: { status: PROBLEM_STATUS.NOT_A_REQUEST, data: ProblemData },
  /** A request the host does not know, or one the task does not link (404). */
  REQUEST_NOT_FOUND: { status: PROBLEM_STATUS.REQUEST_NOT_FOUND, data: ProblemData },
};

const base = oc.errors(apiErrors);

export const contract = base.prefix(API_PREFIX).router({
  me: {
    get: base
      .route({
        method: 'GET',
        path: '/me',
        tags: ['me'],
        summary: 'Get the caller',
        description: 'The signed-in user or API key owner, their workspace, role, theme and key scope.',
      })
      .output(Me),
    update: base
      .route({
        method: 'PATCH',
        path: '/me',
        tags: ['me'],
        summary: 'Update your preferences',
        description: 'Sets the theme. People signed in with a session only: API keys get 403.',
      })
      .input(UpdateMeInput)
      .output(Me),
  },
  projects: {
    list: base
      .route({
        method: 'GET',
        path: '/projects',
        tags: ['projects'],
        summary: 'List projects',
        description: 'Projects the caller can read, with open task counts per status and the current cycle.',
      })
      .output(ProjectList),
    create: base
      .route({
        method: 'POST',
        path: '/projects',
        successStatus: 201,
        tags: ['projects'],
        summary: 'Create a project',
      })
      .input(CreateProjectInput)
      .output(Project),
    update: base
      .route({
        method: 'PATCH',
        path: '/projects/{project}',
        tags: ['projects'],
        summary: 'Update a project',
        description:
          'The key can change only while the project has no tasks. usesMilestones and usesCycles turn ' +
          'the features on or off; turning one off keeps its data. defaultDoneItems replaces the done ' +
          'items new tasks start with (owners and admins); existing tasks keep theirs. ' +
          'archiveAfterDays (1 to 365, null is off) archives Done and Canceled tasks that many days ' +
          'after they closed; a mirrored project gets 409 PROJECT_MIRRORED.',
      })
      .input(UpdateProjectInput)
      .output(Project),
    archivePreview: base
      .route({
        method: 'GET',
        path: '/projects/{project}/archive-preview',
        tags: ['projects'],
        summary: 'Preview the archive setting',
        description:
          'How many tasks the next nightly run would archive with days=N: Done and Canceled tasks ' +
          'closed more than N days ago, except tasks merged with open items. Nothing is written.',
      })
      .input(ArchivePreviewInput)
      .output(ArchivePreview),
    delete: base
      .route({
        method: 'DELETE',
        path: '/projects/{project}',
        successStatus: 204,
        tags: ['projects'],
        summary: 'Delete a project',
        description:
          'Owners and admins only, with a session or a workspace-wide write key. Deletes the project ' +
          'with its tasks, comments, history, milestones, cycles and Backlog.md mirror; this cannot be ' +
          'undone. Confirm by sending the key again as confirmKey in the JSON body ' +
          '({"confirmKey": "PAY"}, any case). API keys scoped to the project keep working for their ' +
          'other projects.',
      })
      .input(DeleteProjectInput)
      .output(z.void()),
  },
  tasks: {
    list: base
      .route({
        method: 'GET',
        path: '/tasks',
        tags: ['tasks'],
        summary: 'List tasks',
        description:
          'Tasks of one or more projects, or of every readable project when project is omitted. ' +
          'order=list (default): status, then priority (highest first), then last update. order=board: ' +
          'status, then board rank. sort (priority, due, updated, created, manual) orders the whole ' +
          'result by one key instead. Filters: label ids (any of), due (overdue, soon, none, set), ' +
          'blocked, topLevel and parent; archived (exclude by default, include or only) and ' +
          'checkAgain (waiting, ready, set or none). Paginate with nextCursor.',
      })
      .input(ListTasksInput)
      .output(TaskListPage),
    get: base
      .route({ method: 'GET', path: '/tasks/{key}', tags: ['tasks'], summary: 'Get a task by key' })
      .input(GetTaskInput)
      .output(Task),
    create: base
      .route({
        method: 'POST',
        path: '/tasks',
        successStatus: 201,
        tags: ['tasks'],
        summary: 'Create a task',
        description:
          'New tasks go to the top of their board column. cycle takes a number, current or next. ' +
          'labels are names; missing ones are created. parent makes it a subtask (one level, same ' +
          'project) that takes the parent assignee unless one is given. blockedBy lists task keys of ' +
          'the same project. criteria and doneItems start the work record (up to 50 each, one line of ' +
          "500 characters each); the project's default done items come first unless " +
          'skipDefaultDoneItems is true. plan is Markdown, up to 50,000 characters.',
      })
      .input(CreateTaskInput)
      .output(Task),
    update: base
      .route({
        method: 'PATCH',
        path: '/tasks/{key}',
        tags: ['tasks'],
        summary: 'Update a task',
        description:
          'Send only the fields to change. null clears assignee, description, milestone, cycle, ' +
          'dueDate and parent. position places the task before or after another task of its target ' +
          'status column. labels replaces the labels; addLabels and removeLabels change some. ' +
          'addBlockers and removeBlockers change what the task waits on; a loop fails with 409 ' +
          'DEPENDENCY_LOOP. With ifUpdatedAt, a task changed since then fails with 409 TASK_CHANGED ' +
          'and the current task; with ifStatus, so does a task whose status differs. Criteria and ' +
          'done items change through operations (addCriteria, checkCriteria, uncheckCriteria, ' +
          'waiveCriteria, unwaiveCriteria, editCriteria, moveCriteria, removeCriteria, and the same ' +
          'eight for DoneItems); numbers refer to the list before the request. plan and finalSummary ' +
          'set the Markdown texts (null clears). An agent moving a task to In review or Done while a ' +
          'criterion or done item is open gets 409 OPEN_ITEMS with the open items; people are not ' +
          'refused. Every work-record field of a mirrored task fails with 409 TASK_MIRRORED. ' +
          'checkAgain sets a day to look at the task again with a reason (both required; null ' +
          'clears it). An archived task fails every change with 409 TASK_ARCHIVED.',
      })
      .input(UpdateTaskInput)
      .output(Task),
    bulkUpdate: base
      .route({
        method: 'POST',
        path: '/tasks/bulk',
        tags: ['tasks'],
        summary: 'Change several tasks at once',
        description:
          'Up to 100 task keys of native projects, one change for all of them, in one transaction ' +
          'with one activity row per changed task. Status, priority, assignee, milestone, cycle, ' +
          'dueDate, addLabels and removeLabels. A mirrored task fails the request with 409 ' +
          'TASK_MIRRORED; milestone and cycle need every task in one project (422 NOT_SAME_PROJECT). ' +
          'Returns the tasks in the order sent.',
      })
      .input(BulkUpdateTasksInput)
      .output(TaskBulkResult),
    archive: base
      .route({
        method: 'POST',
        path: '/tasks/archive',
        tags: ['tasks'],
        summary: 'Archive tasks',
        description:
          'Up to 100 task keys, in any status, all or nothing, with one activity row per task. ' +
          'Archived tasks leave lists, boards, Home and counts, and refuse every write but restore ' +
          '(409 TASK_ARCHIVED). Tasks of a mirrored project fail the request with 409 TASK_MIRRORED: ' +
          "Backlog.md's archive folder decides. Returns the tasks in the order sent.",
      })
      .input(ArchiveTasksInput)
      .output(TaskBulkResult),
    restore: base
      .route({
        method: 'POST',
        path: '/tasks/restore',
        tags: ['tasks'],
        summary: 'Restore archived tasks',
        description:
          'Up to 100 task keys, all or nothing. A restored Done or Canceled task counts its archive ' +
          'days again from now. Mirrored tasks fail with 409 TASK_MIRRORED. Returns the tasks in the ' +
          'order sent.',
      })
      .input(RestoreTasksInput)
      .output(TaskBulkResult),
    activity: base
      .route({
        method: 'GET',
        path: '/tasks/{key}/activity',
        tags: ['tasks'],
        summary: 'List the activity of a task',
        description: 'Oldest first. Kept for compatibility; the timeline also has comments.',
      })
      .input(ListTaskActivityInput)
      .output(ActivityList),
    timeline: base
      .route({
        method: 'GET',
        path: '/tasks/{key}/timeline',
        tags: ['tasks'],
        summary: 'Get the timeline of a task',
        description:
          'Activity, comments and notes in one list, oldest first, told apart by kind (activity, ' +
          'comment or note). show=all (default), comments, notes or history narrows the items; counts ' +
          'gives the size of all four.',
      })
      .input(ListTaskTimelineInput)
      .output(Timeline),
  },
  pullRequests: {
    link: base
      .route({
        method: 'POST',
        path: '/tasks/{key}/pull-requests',
        tags: ['pull-requests'],
        summary: 'Link a pull or merge request to a task',
        description:
          "url is the request's web address in the project's repository. Another repository fails " +
          'with 422 REQUEST_OTHER_REPOSITORY, an address that is not a request with 422 ' +
          'NOT_A_REQUEST, a request the host does not know with 404 REQUEST_NOT_FOUND. dryRun ' +
          'returns the request as it would link and writes nothing. Linking a request removed by ' +
          'hand brings it back. Zamu reads the host and never writes to it.',
      })
      .input(LinkPullRequestInput)
      .output(PullRequestLink),
    unlink: base
      .route({
        method: 'DELETE',
        path: '/tasks/{key}/pull-requests/{number}',
        successStatus: 204,
        tags: ['pull-requests'],
        summary: 'Unlink a pull or merge request from a task',
        description:
          'The link stays removed: neither the branch nor a Closes: line brings it back; linking it ' +
          'by hand does. 404 REQUEST_NOT_FOUND when the task does not link that number.',
      })
      .input(UnlinkPullRequestInput)
      .output(z.void()),
  },
  comments: {
    list: base
      .route({
        method: 'GET',
        path: '/tasks/{key}/comments',
        tags: ['comments'],
        summary: 'List the comments of a task',
        description: 'Oldest first. Deleted comments stay with a null body.',
      })
      .input(ListCommentsInput)
      .output(CommentList),
    create: base
      .route({
        method: 'POST',
        path: '/tasks/{key}/comments',
        successStatus: 201,
        tags: ['comments'],
        summary: 'Comment on a task',
        description:
          'Markdown body. Mention members as [@Name](mention:<userId>), @agent-name or @email; the ' +
          'last two are rewritten to the link form. kind=note writes a work note, which notifies only ' +
          'the people it mentions.',
      })
      .input(CreateCommentInput)
      .output(Comment),
    update: base
      .route({
        method: 'PATCH',
        path: '/comments/{id}',
        tags: ['comments'],
        summary: 'Edit a comment',
        description: 'Only the author can edit. A deleted comment returns 409.',
      })
      .input(UpdateCommentInput)
      .output(Comment),
    delete: base
      .route({
        method: 'DELETE',
        path: '/comments/{id}',
        tags: ['comments'],
        summary: 'Delete a comment',
        description:
          'Only the author can delete. The comment stays in the timeline with a null body; returns it ' +
          'as it is now. Deleting it again returns 409.',
      })
      .input(DeleteCommentInput)
      .output(Comment),
  },
  milestones: {
    list: base
      .route({
        method: 'GET',
        path: '/projects/{project}/milestones',
        tags: ['milestones'],
        summary: 'List the milestones of a project',
        description: 'With progress counts. Ordered by target date (none last), then name.',
      })
      .input(ListMilestonesInput)
      .output(MilestoneList),
    create: base
      .route({
        method: 'POST',
        path: '/projects/{project}/milestones',
        successStatus: 201,
        tags: ['milestones'],
        summary: 'Create a milestone',
        description: 'Starts Planned. Names are unique per project, ignoring case.',
      })
      .input(CreateMilestoneInput)
      .output(MilestoneWithProgress),
    get: base
      .route({ method: 'GET', path: '/milestones/{id}', tags: ['milestones'], summary: 'Get a milestone' })
      .input(GetMilestoneInput)
      .output(MilestoneWithProgress),
    update: base
      .route({
        method: 'PATCH',
        path: '/milestones/{id}',
        tags: ['milestones'],
        summary: 'Update a milestone',
        description:
          'Send only the fields to change. Completed is set by hand; any other status on a Completed ' +
          'milestone reopens it as Active.',
      })
      .input(UpdateMilestoneInput)
      .output(MilestoneWithProgress),
    delete: base
      .route({
        method: 'DELETE',
        path: '/milestones/{id}',
        successStatus: 204,
        tags: ['milestones'],
        summary: 'Delete a milestone',
        description: 'Its tasks lose the milestone.',
      })
      .input(DeleteMilestoneInput)
      .output(z.void()),
  },
  cycles: {
    list: base
      .route({
        method: 'GET',
        path: '/projects/{project}/cycles',
        tags: ['cycles'],
        summary: 'List the cycles of a project',
        description:
          'Oldest first, with state, days left and task counts. state=current returns the current ' +
          'cycle or an empty list.',
      })
      .input(ListCyclesInput)
      .output(CycleList),
    create: base
      .route({
        method: 'POST',
        path: '/projects/{project}/cycles',
        successStatus: 201,
        tags: ['cycles'],
        summary: 'Create a cycle',
        description:
          'Omitted dates follow the last cycle: the day after it ends, same length. The first cycle ' +
          'starts next Monday and lasts 14 days. Cycles never overlap.',
      })
      .input(CreateCycleInput)
      .output(CycleDetail),
    get: base
      .route({
        method: 'GET',
        path: '/cycles/{project}/{number}',
        tags: ['cycles'],
        summary: 'Get a cycle',
        description: 'number is a cycle number, current or next. Completed cycles list what rolled over.',
      })
      .input(GetCycleInput)
      .output(CycleDetail),
    update: base
      .route({
        method: 'PATCH',
        path: '/cycles/{project}/{number}',
        tags: ['cycles'],
        summary: 'Update a cycle',
        description: 'Dates change only while the cycle is Upcoming; the name until it ends.',
      })
      .input(UpdateCycleInput)
      .output(CycleDetail),
    end: base
      .route({
        method: 'POST',
        path: '/cycles/{project}/{number}/end',
        tags: ['cycles'],
        summary: 'End a cycle now',
        description:
          'Unfinished tasks move to moveTo (a cycle number, or none), else to the next upcoming ' +
          'cycle, else to a new cycle of the same length. Ending an ended cycle changes nothing.',
      })
      .input(EndCycleInput)
      .output(CycleDetail),
  },
  labels: {
    list: base
      .route({
        method: 'GET',
        path: '/projects/{project}/labels',
        tags: ['labels'],
        summary: 'List the labels of a project',
        description: 'By name, with the number of tasks using each label.',
      })
      .input(ListLabelsInput)
      .output(LabelList),
    create: base
      .route({
        method: 'POST',
        path: '/projects/{project}/labels',
        successStatus: 201,
        tags: ['labels'],
        summary: 'Create a label',
        description:
          'Names are unique per project ignoring case (409 LABEL_EXISTS), up to 40 characters. ' +
          'color is 1 to 9; omitted, the app picks the least used one. Task writes also create labels ' +
          'by name.',
      })
      .input(CreateLabelInput)
      .output(LabelWithUsage),
    update: base
      .route({
        method: 'PATCH',
        path: '/projects/{project}/labels/{id}',
        tags: ['labels'],
        summary: 'Rename or recolour a label',
        description:
          'Labels from Backlog.md keep their name (409 LABEL_MIRRORED) but take a new colour. Task ' +
          'history keeps the name it recorded.',
      })
      .input(UpdateLabelInput)
      .output(LabelWithUsage),
    delete: base
      .route({
        method: 'DELETE',
        path: '/projects/{project}/labels/{id}',
        successStatus: 204,
        tags: ['labels'],
        summary: 'Delete a label',
        description:
          'Takes the label off every task, without activity rows. Labels from Backlog.md cannot be ' +
          'deleted (409 LABEL_MIRRORED).',
      })
      .input(DeleteLabelInput)
      .output(z.void()),
  },
  backlog: {
    status: base
      .route({
        method: 'GET',
        path: '/projects/{project}/backlog',
        tags: ['backlog'],
        summary: 'Get the Backlog.md source of a project',
        description:
          'Mode, state, repository, branch, folder, connection, last read, next poll, last webhook ' +
          'notification, counts, mappings and problems (paged with problemsCursor). 404 when the ' +
          'project has no Backlog.md source.',
      })
      .input(GetBacklogStatusInput)
      .output(BacklogSourceStatus),
    refresh: base
      .route({
        method: 'POST',
        path: '/projects/{project}/backlog/refresh',
        successStatus: 202,
        tags: ['backlog'],
        summary: 'Refresh a Backlog.md mirror',
        description:
          'Queues a read of the default branch (trigger cli) and returns the source state. queued is ' +
          'false when a run was already waiting. 409 BACKLOG_PAUSED or BACKLOG_DETACHED with the reason.',
      })
      .input(RefreshBacklogInput)
      .output(BacklogRefreshResult),
    export: base
      .route({
        method: 'GET',
        path: '/projects/{project}/backlog/export',
        tags: ['backlog'],
        summary: 'Export a project as Backlog.md files',
        description:
          'Every task and milestone as a Backlog.md file: tasks under tasks/, milestones under ' +
          'milestones/, paths relative to the Backlog.md folder. ' +
          'Zamu-only data (waived criteria and their reasons) sits between <!-- zamu:start --> and ' +
          '<!-- zamu:end --> at the end of a task file. Files under removedPrefixes that are not in ' +
          'the list are stale. Native projects and projects switched to Zamu only; a project that ' +
          'still mirrors Backlog.md gets 409 PROJECT_MIRRORED.',
      })
      .input(ExportBacklogInput)
      .output(BacklogExport),
  },
  repository: {
    get: base
      .route({
        method: 'GET',
        path: '/projects/{project}/repository',
        tags: ['repository'],
        summary: 'Get the repository settings of a project',
        description:
          'How Zamu reads the pull or merge requests of the project repository: the connection (or ' +
          'none for a public repository), the default branch, close on merge, the webhook URL and ' +
          'its last delivery, and the hourly check. The secret is never returned here. repository ' +
          'is null when the project has none.',
      })
      .input(GetRepositorySettingsInput)
      .output(RepositorySettings),
    update: base
      .route({
        method: 'PATCH',
        path: '/projects/{project}/repository',
        tags: ['repository'],
        summary: 'Update the repository settings of a project',
        description:
          'Owners and admins. connectionId picks a connection for the repository host, or null to ' +
          'read a public repository without a token; requests seen after the change move tasks ' +
          'again only from then on. closeOnMerge turns the Done step of a merge on or off.',
      })
      .input(UpdateRepositoryInput)
      .output(RepositorySettings),
    newWebhookSecret: base
      .route({
        method: 'POST',
        path: '/projects/{project}/repository/webhook-secret',
        tags: ['repository'],
        summary: 'Issue a new repository webhook secret',
        description:
          'Owners and admins. Returns the secret once; the old one stops working at once. The URL ' +
          'stays the same.',
      })
      .input(NewRepositoryWebhookSecretInput)
      .output(RepositoryWebhookSecret),
    sync: base
      .route({
        method: 'POST',
        path: '/projects/{project}/repository/sync',
        successStatus: 202,
        tags: ['repository'],
        summary: 'Check the repository for requests now',
        description: 'Queues the hourly check of the repository requests to run now.',
      })
      .input(SyncRepositoryInput)
      .output(z.void()),
  },
  dashboard: {
    get: base
      .route({
        method: 'GET',
        path: '/dashboard',
        tags: ['dashboard'],
        summary: 'Get the dashboard',
        description:
          'What needs someone now, across every readable project: tasks in review, unanswered ' +
          'mentions, stalled work and close deadlines, each with its total and up to 50 items; then ' +
          "one row per project and the agents. scope=mine (default) covers your tasks, your agents' " +
          'tasks and mentions of you; scope=everyone covers the whole workspace.',
      })
      .input(GetDashboardInput)
      .output(Dashboard),
    counts: base
      .route({
        method: 'GET',
        path: '/dashboard/counts',
        tags: ['dashboard'],
        summary: 'Count the dashboard queue',
        description:
          'The totals of the four queue groups for scope=mine and their sum, without items, ' +
          'projects or agents.',
      })
      .output(DashboardCounts),
  },
  home: {
    get: base
      .route({
        method: 'GET',
        path: '/home',
        tags: ['home'],
        summary: 'Get Home',
        description:
          'What needs attention, grouped by why. tab=mine (default): needs your review, merged with ' +
          'open criteria, check again, mentions, blocked, overdue and assigned to you. tab=everyone: ' +
          'needs review, merged with open criteria, blocked, overdue and due this week across the ' +
          'workspace. tab=agents: one card per agent and what agents wait ' +
          'on people for. Each task shows once, in its first group; each group has its total and up ' +
          'to 50 items. Mine and Everyone add the deadlines strip. Filter by project, label name ' +
          'and priority.',
      })
      .input(GetHomeInput)
      .output(Home),
    counts: base
      .route({
        method: 'GET',
        path: '/home/counts',
        tags: ['home'],
        summary: 'Count what needs you',
        description:
          'The Mine counts of needs your review, merged with open criteria, check again, mentions, ' +
          'blocked and overdue, and their sum (the sidebar count), without items.',
      })
      .output(HomeCounts),
  },
  members: {
    list: base
      .route({
        method: 'GET',
        path: '/members',
        tags: ['members'],
        summary: 'List workspace members',
        description: 'People and agents, with the responsible human of each agent.',
      })
      .output(MemberList),
  },
});

export type Contract = typeof contract;
/** Inputs as callers send them (before defaults), e.g. `ContractInputs['tasks']['list']`. */
export type ContractInputs = InferContractRouterInputs<Contract>;
/** Outputs as clients receive them, e.g. `ContractOutputs['tasks']['get']`. */
export type ContractOutputs = InferContractRouterOutputs<Contract>;
