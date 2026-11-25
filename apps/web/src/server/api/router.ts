// /api/v1 procedures. Each one hands the parsed input and the actor to a core service and returns
// its result; the rules live in @zamu/core.
import {
  bulkUpdateTasks,
  createComment,
  createCycle,
  createLabel,
  createMilestone,
  createProject,
  createTask,
  deleteComment,
  deleteLabel,
  deleteMilestone,
  deleteProject,
  endCycle,
  exportBacklog,
  getBacklogStatus,
  getCycle,
  getDashboard,
  getDashboardCounts,
  getHome,
  getHomeCounts,
  getMe,
  getMilestone,
  getTask,
  listComments,
  listCycles,
  listLabels,
  listMembers,
  listMilestones,
  listProjects,
  listTaskActivity,
  listTasks,
  listTaskTimeline,
  requestBacklogRefresh,
  updateComment,
  updateCycle,
  updateLabel,
  updateMe,
  updateMilestone,
  updateProject,
  updateTask,
} from '@zamu/core';
import { api } from './base';

export const router = api.router({
  me: {
    get: api.me.get.handler(({ context }) => getMe(context.core, context.actor)),
    update: api.me.update.handler(({ context, input }) => updateMe(context.core, context.actor, input)),
  },
  projects: {
    list: api.projects.list.handler(({ context }) => listProjects(context.core, context.actor)),
    create: api.projects.create.handler(({ context, input }) =>
      createProject(context.core, context.actor, input),
    ),
    update: api.projects.update.handler(({ context, input }) =>
      updateProject(context.core, context.actor, input),
    ),
    delete: api.projects.delete.handler(({ context, input }) =>
      deleteProject(context.core, context.actor, input),
    ),
  },
  tasks: {
    list: api.tasks.list.handler(({ context, input }) => listTasks(context.core, context.actor, input)),
    get: api.tasks.get.handler(({ context, input }) => getTask(context.core, context.actor, input)),
    create: api.tasks.create.handler(({ context, input }) => createTask(context.core, context.actor, input)),
    update: api.tasks.update.handler(({ context, input }) => updateTask(context.core, context.actor, input)),
    bulkUpdate: api.tasks.bulkUpdate.handler(({ context, input }) =>
      bulkUpdateTasks(context.core, context.actor, input),
    ),
    activity: api.tasks.activity.handler(({ context, input }) =>
      listTaskActivity(context.core, context.actor, input),
    ),
    timeline: api.tasks.timeline.handler(({ context, input }) =>
      listTaskTimeline(context.core, context.actor, input),
    ),
  },
  comments: {
    list: api.comments.list.handler(({ context, input }) => listComments(context.core, context.actor, input)),
    create: api.comments.create.handler(({ context, input }) =>
      createComment(context.core, context.actor, input),
    ),
    update: api.comments.update.handler(({ context, input }) =>
      updateComment(context.core, context.actor, input),
    ),
    delete: api.comments.delete.handler(({ context, input }) =>
      deleteComment(context.core, context.actor, input),
    ),
  },
  milestones: {
    list: api.milestones.list.handler(({ context, input }) =>
      listMilestones(context.core, context.actor, input),
    ),
    create: api.milestones.create.handler(({ context, input }) =>
      createMilestone(context.core, context.actor, input),
    ),
    get: api.milestones.get.handler(({ context, input }) => getMilestone(context.core, context.actor, input)),
    update: api.milestones.update.handler(({ context, input }) =>
      updateMilestone(context.core, context.actor, input),
    ),
    delete: api.milestones.delete.handler(({ context, input }) =>
      deleteMilestone(context.core, context.actor, input),
    ),
  },
  cycles: {
    list: api.cycles.list.handler(({ context, input }) => listCycles(context.core, context.actor, input)),
    create: api.cycles.create.handler(({ context, input }) =>
      createCycle(context.core, context.actor, input),
    ),
    get: api.cycles.get.handler(({ context, input }) => getCycle(context.core, context.actor, input)),
    update: api.cycles.update.handler(({ context, input }) =>
      updateCycle(context.core, context.actor, input),
    ),
    end: api.cycles.end.handler(({ context, input }) => endCycle(context.core, context.actor, input)),
  },
  labels: {
    list: api.labels.list.handler(({ context, input }) => listLabels(context.core, context.actor, input)),
    create: api.labels.create.handler(({ context, input }) =>
      createLabel(context.core, context.actor, input),
    ),
    update: api.labels.update.handler(({ context, input }) =>
      updateLabel(context.core, context.actor, input),
    ),
    delete: api.labels.delete.handler(async ({ context, input }) => {
      await deleteLabel(context.core, context.actor, input);
    }),
  },
  backlog: {
    status: api.backlog.status.handler(({ context, input }) =>
      getBacklogStatus(context.core, context.actor, input),
    ),
    refresh: api.backlog.refresh.handler(({ context, input }) =>
      requestBacklogRefresh(context.core, context.actor, input),
    ),
    export: api.backlog.export.handler(({ context, input }) =>
      exportBacklog(context.core, context.actor, input),
    ),
  },
  dashboard: {
    get: api.dashboard.get.handler(({ context, input }) => getDashboard(context.core, context.actor, input)),
    counts: api.dashboard.counts.handler(({ context }) => getDashboardCounts(context.core, context.actor)),
  },
  home: {
    get: api.home.get.handler(({ context, input }) => getHome(context.core, context.actor, input)),
    counts: api.home.counts.handler(({ context }) => getHomeCounts(context.core, context.actor)),
  },
  members: {
    list: api.members.list.handler(({ context }) => listMembers(context.core, context.actor)),
  },
});

export type ApiRouter = typeof router;
