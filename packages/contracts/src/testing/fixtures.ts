import type { z } from 'zod';
import type {
  Activity,
  ApiKeyCreated,
  ApiKeySummary,
  ArchivePreview,
  BacklogExport,
  Comment,
  Cycle,
  CycleDetail,
  CycleRollover,
  Home,
  HomeItem,
  Invitation,
  LabelWithUsage,
  Me,
  Member,
  Milestone,
  MilestonePlan,
  MilestoneWithProgress,
  Project,
  ProjectWithCounts,
  PullRequestLink,
  RepositorySettings,
  Task,
  TaskListItem,
  TaskListPage,
  Timeline,
  TimelineItem,
  UserRef,
  Wave,
  WorkItem,
  Workspace,
} from '../entities';

// Valid sample values for every entity schema, typed as server-side inputs (Dates allowed).
// Import from '@zamu/contracts/testing/fixtures' in tests of other packages.

const at = (iso: string) => new Date(iso);

export const ana = {
  id: '0190a1b2-0000-7000-8000-00000000a0a0',
  name: 'Ana Ruiz',
  kind: 'person',
} satisfies z.input<typeof UserRef>;
export const tomas = {
  id: '0190a1b2-0000-7000-8000-00000000b0b0',
  name: 'Tomás Berg',
  kind: 'person',
} satisfies z.input<typeof UserRef>;
export const claudeDev = {
  id: '0190a1b2-0000-7000-8000-00000000c0c0',
  name: 'claude-dev',
  kind: 'agent',
} satisfies z.input<typeof UserRef>;

export const projectId = '0190a1b2-c3d4-7e5f-8a9b-0c1d2e3f4a5b';
export const taskId = '0190a1b2-c3d4-7e5f-8a9b-0c1d2e3f4a6c';
export const activityId = '0190a1b2-c3d4-7e5f-8a9b-0c1d2e3f4a7d';
export const milestoneId = '0190a1b2-c3d4-7e5f-8a9b-0c1d2e3f4a8e';
export const cycleId = '0190a1b2-c3d4-7e5f-8a9b-0c1d2e3f4a9f';
export const nextCycleId = '0190a1b2-c3d4-7e5f-8a9b-0c1d2e3f4aa0';
export const commentId = '0190a1b2-c3d4-7e5f-8a9b-0c1d2e3f4ab1';
export const labelId = '0190a1b2-c3d4-7e5f-8a9b-0c1d2e3f4ac3';
export const backlogLabelId = '0190a1b2-c3d4-7e5f-8a9b-0c1d2e3f4ad4';

const payRef = { id: projectId, key: 'PAY', name: 'Payments' };

export const projectFixture = {
  id: projectId,
  key: 'PAY',
  name: 'Payments',
  description: 'Checkout, refunds, webhooks and payouts',
  usesMilestones: true,
  usesCycles: true,
  currentCycle: {
    id: cycleId,
    number: 12,
    name: 'Checkout rewrite',
    startsOn: '2026-10-12',
    endsOn: '2026-10-25',
    daysLeft: 3,
  },
  createdAt: at('2026-10-01T09:00:00.000Z'),
  updatedAt: '2026-10-20T10:30:00.000Z',
} satisfies z.input<typeof Project>;

export const projectWithCountsFixture = {
  ...projectFixture,
  openCounts: { backlog: 3, todo: 4, in_progress: 3, in_review: 2 },
  openCount: 12,
  lastActivityAt: at('2026-10-22T18:00:00.000Z'),
  assignees: [ana, claudeDev],
} satisfies z.input<typeof ProjectWithCounts>;

export const taskFixture = {
  id: taskId,
  key: 'PAY-142',
  number: 142,
  project: payRef,
  title: 'Retry failed webhook deliveries with exponential backoff',
  description: '- [x] Store attempt count\n- [ ] Stop on 4xx',
  status: 'in_progress',
  priority: 'high',
  assignee: { ...claudeDev, responsible: ana },
  createdBy: ana,
  createdOnBehalfOf: null,
  milestone: { id: milestoneId, name: 'Webhooks v2', status: 'active', targetDate: '2026-11-14' },
  cycle: {
    id: cycleId,
    number: 12,
    name: 'Checkout rewrite',
    startsOn: '2026-10-12',
    endsOn: '2026-10-25',
    state: 'current',
  },
  cycleAddedAt: at('2026-10-17T08:00:00.000Z'),
  rank: -1.5,
  createdAt: at('2026-10-20T09:00:00.000Z'),
  updatedAt: at('2026-10-22T18:00:00.000Z'),
} satisfies z.input<typeof Task>;

export const taskListItemFixture = {
  id: taskId,
  key: 'PAY-142',
  number: 142,
  project: payRef,
  title: taskFixture.title,
  status: 'in_progress',
  priority: 'high',
  assignee: null,
  milestone: null,
  cycle: null,
  cycleAddedAt: null,
  rank: 3,
  createdAt: taskFixture.createdAt,
  updatedAt: taskFixture.updatedAt,
} satisfies z.input<typeof TaskListItem>;

export const taskListPageFixture = {
  items: [taskListItemFixture],
  nextCursor: 'eyJzIjoxfQ',
  counts: { backlog: 3, todo: 4, in_progress: 3, in_review: 2, done: 64, canceled: 3 },
} satisfies z.input<typeof TaskListPage>;

export const activityFixture = {
  id: activityId,
  type: 'task.updated',
  taskKey: 'PAY-142',
  actor: claudeDev,
  onBehalfOf: ana,
  changes: [
    { field: 'status', from: 'todo', to: 'in_progress' },
    { field: 'assignee', from: null, to: claudeDev },
    { field: 'priority', from: 'medium', to: 'high' },
    { field: 'title', from: 'Retry webhooks', to: taskFixture.title },
    { field: 'description', from: null, to: 'Backoff is 30s × 2^n' },
    { field: 'milestone', from: null, to: { id: milestoneId, name: 'Webhooks v2' } },
    { field: 'cycle', from: null, to: { id: cycleId, number: 12, name: 'Checkout rewrite' } },
  ],
  createdAt: at('2026-10-22T17:20:00.000Z'),
} satisfies z.input<typeof Activity>;

/** The hourly job ending Cycle 12 and moving the task to Cycle 13. */
export const systemActivityFixture = {
  id: '0190a1b2-c3d4-7e5f-8a9b-0c1d2e3f4ac2',
  type: 'cycle.ended',
  taskKey: 'PAY-142',
  actor: null,
  onBehalfOf: null,
  changes: [
    {
      field: 'cycle',
      from: { id: cycleId, number: 12, name: 'Checkout rewrite' },
      to: { id: nextCycleId, number: 13, name: null },
    },
  ],
  createdAt: at('2026-10-26T00:00:05.000Z'),
} satisfies z.input<typeof Activity>;

export const milestoneFixture = {
  id: milestoneId,
  project: payRef,
  name: 'Webhooks v2',
  description: 'Reliable delivery for merchant webhooks.',
  targetDate: '2026-11-14',
  status: 'active',
  completedAt: null,
  createdBy: ana,
  createdAt: at('2026-10-01T09:00:00.000Z'),
  updatedAt: at('2026-10-20T09:00:00.000Z'),
} satisfies z.input<typeof Milestone>;

export const milestoneWithProgressFixture = {
  ...milestoneFixture,
  progress: { total: 23, done: 14, inProgress: 5, open: 3, canceled: 1 },
  daysLeft: 22,
  overdue: false,
} satisfies z.input<typeof MilestoneWithProgress>;

export const cycleFixture = {
  id: cycleId,
  project: payRef,
  number: 12,
  name: 'Checkout rewrite',
  startsOn: '2026-10-12',
  endsOn: '2026-10-25',
  state: 'current',
  daysLeft: 3,
  counts: {
    backlog: 0,
    todo: 4,
    in_progress: 4,
    in_review: 1,
    done: 9,
    canceled: 0,
    total: 18,
    addedAfterStart: 3,
    unassigned: 2,
    agents: 6,
  },
  completedAt: null,
  endedBy: null,
  summary: null,
} satisfies z.input<typeof Cycle>;

export const cycleRolloverFixture = {
  task: { id: taskId, key: 'PAY-142', title: taskFixture.title, status: 'in_review' },
  statusAtEnd: 'in_progress',
  movedTo: { id: nextCycleId, number: 13, name: null },
  createdAt: at('2026-10-26T00:00:05.000Z'),
} satisfies z.input<typeof CycleRollover>;

export const completedCycleFixture = {
  ...cycleFixture,
  state: 'completed',
  daysLeft: null,
  completedAt: at('2026-10-26T00:00:05.000Z'),
  endedBy: null,
  summary: { scope: 20, completed: 16, rolledOver: 3, canceled: 1, addedAfterStart: 2 },
  rollovers: [cycleRolloverFixture],
} satisfies z.input<typeof CycleDetail>;

export const commentFixture = {
  id: commentId,
  taskKey: 'PAY-142',
  author: claudeDev,
  onBehalfOf: ana,
  body: `Retries are scheduled as pg-boss jobs. [@Ana Ruiz](mention:${ana.id}) can you review?`,
  mentions: [ana],
  createdAt: at('2026-10-22T18:10:00.000Z'),
  editedAt: at('2026-10-22T18:12:00.000Z'),
  deletedAt: null,
} satisfies z.input<typeof Comment>;

export const deletedCommentFixture = {
  ...commentFixture,
  body: null,
  mentions: [],
  deletedAt: at('2026-10-22T18:30:00.000Z'),
} satisfies z.input<typeof Comment>;

export const timelineFixture = [
  { kind: 'activity', ...activityFixture },
  { kind: 'comment', ...commentFixture },
  { kind: 'comment', ...deletedCommentFixture },
  { kind: 'activity', ...systemActivityFixture },
] satisfies z.input<typeof TimelineItem>[];

export const memberFixture = {
  id: claudeDev.id,
  name: claudeDev.name,
  email: null,
  kind: 'agent',
  role: 'member',
  responsible: ana,
  lastActiveAt: at('2026-10-22T18:00:00.000Z'),
  apiKeyCount: 1,
  joinedAt: at('2026-10-20T08:00:00.000Z'),
} satisfies z.input<typeof Member>;

export const invitationFixture = {
  id: '0190a1b2-0000-4000-8000-00000000f0f0',
  email: 'jo@example.com',
  role: 'member',
  status: 'pending',
  invitedBy: ana,
  link: 'https://zamu.example.com/invite/0190a1b2-0000-4000-8000-00000000f0f0',
  expiresAt: at('2026-10-28T09:00:00.000Z'),
  createdAt: at('2026-10-21T09:00:00.000Z'),
} satisfies z.input<typeof Invitation>;

export const apiKeySummaryFixture = {
  id: '0190a1b2-0000-7000-8000-00000000e0e0',
  name: 'claude-dev on Ana’s laptop',
  start: 'zamu_live_4kQz',
  owner: claudeDev,
  scope: { projects: [{ id: projectId, key: 'PAY', name: 'Payments' }], access: 'write' },
  revoked: false,
  createdAt: at('2026-10-20T08:00:00.000Z'),
  lastUsedAt: null,
  expiresAt: null,
} satisfies z.input<typeof ApiKeySummary>;

export const apiKeyCreatedFixture = {
  ...apiKeySummaryFixture,
  key: 'zamu_live_7Hq2mV9xKc4TzR8bN3wLp6Ye1Ua5Fj0D',
} satisfies z.input<typeof ApiKeyCreated>;

export const meFixture = {
  user: {
    id: claudeDev.id,
    name: claudeDev.name,
    email: null,
    kind: 'agent',
    responsible: ana,
    theme: 'system',
  },
  workspace: { id: '0190a1b2-0000-7000-8000-00000000d0d0', name: 'Reddevs', slug: 'reddevs' },
  role: 'member',
  auth: { method: 'api_key', scope: { projects: 'all', access: 'read' } },
} satisfies z.input<typeof Me>;

// ---------------------------------------------------------------------------
// 0.10: two workspaces, each with a project PAY
// ---------------------------------------------------------------------------

export const acmeWorkspaceFixture = {
  id: '0190a1b2-0000-7000-8000-00000000e0a1',
  name: 'Acme',
  slug: 'acme',
  role: 'owner',
} satisfies z.input<typeof Workspace>;

export const globexWorkspaceFixture = {
  id: '0190a1b2-0000-7000-8000-00000000e0b2',
  name: 'Globex',
  slug: 'globex',
  role: 'member',
} satisfies z.input<typeof Workspace>;

// ---------------------------------------------------------------------------
// M5: labels, due dates, blockers, subtasks and Home
// ---------------------------------------------------------------------------

export const labelFixture = {
  id: labelId,
  name: 'payouts',
  color: 3,
  source: 'app',
} as const;

/** A label read from Backlog.md files: name locked, colour editable. */
export const backlogLabelFixture = {
  id: backlogLabelId,
  name: 'reliability',
  color: 5,
  source: 'backlog',
} as const;

export const labelWithUsageFixture = {
  ...labelFixture,
  usageCount: 12,
} satisfies z.input<typeof LabelWithUsage>;

/** taskFixture with every M5 field: labels, due date, parent, subtasks and blockers. */
export const taskWithFieldsFixture = {
  ...taskFixture,
  labels: [labelFixture, backlogLabelFixture],
  dueDate: '2026-10-31',
  parent: { key: 'PAY-120', title: 'Idempotency keys for payouts', status: 'in_review', assignee: claudeDev },
  subtasks: [
    { key: 'PAY-143', title: 'Store attempt count', status: 'done', assignee: claudeDev },
    {
      key: 'PAY-146',
      title: 'Alert on-call after the 8th attempt',
      status: 'in_progress',
      assignee: claudeDev,
    },
    { key: 'PAY-147', title: 'Merchant-facing retry button', status: 'canceled', assignee: ana },
  ],
  subtaskProgress: { done: 1, total: 2 },
  blockedBy: [
    { key: 'PAY-138', title: 'Provider sandbox returns real error codes', status: 'todo', assignee: tomas },
    null,
  ],
  blocks: [{ key: 'PAY-150', title: 'Payout retries dashboard', status: 'backlog', assignee: null }],
  blocked: true,
} satisfies z.input<typeof Task>;

export const taskListItemWithFieldsFixture = {
  ...taskListItemFixture,
  labels: [labelFixture],
  dueDate: '2026-10-31',
  subtaskProgress: { done: 1, total: 2 },
  blocked: true,
  parentKey: null,
} satisfies z.input<typeof TaskListItem>;

/** An update that touched every M5 field. */
export const fieldsActivityFixture = {
  id: '0190a1b2-c3d4-7e5f-8a9b-0c1d2e3f4ae5',
  type: 'task.updated',
  taskKey: 'PAY-142',
  actor: ana,
  onBehalfOf: null,
  changes: [
    {
      field: 'labels',
      from: [{ id: backlogLabelId, name: 'reliability', color: 5 }],
      to: [
        { id: labelId, name: 'payouts', color: 3 },
        { id: backlogLabelId, name: 'reliability', color: 5 },
      ],
    },
    { field: 'dueDate', from: null, to: '2026-10-31' },
    {
      field: 'blockedBy',
      from: [],
      to: [{ key: 'PAY-138', title: 'Provider sandbox returns real error codes', removed: false }],
    },
    {
      field: 'parent',
      from: null,
      to: { key: 'PAY-120', title: 'Idempotency keys for payouts', removed: false },
    },
  ],
  createdAt: at('2026-10-23T09:00:00.000Z'),
} satisfies z.input<typeof Activity>;

const payTask = (key: string, title: string, status: 'in_progress' | 'in_review' | 'todo') => ({
  key,
  title,
  status,
  project: payRef,
});

/** Home, Mine tab: one row in each group but assigned, and the deadlines strip. */
export const homeMineFixture = {
  tab: 'mine',
  generatedAt: at('2026-11-03T09:00:00.000Z'),
  counts: { mine: 4, everyone: 26, agents: 1 },
  deadlines: [
    {
      kind: 'task',
      task: payTask('PAY-142', taskFixture.title, 'in_progress'),
      dueDate: '2026-10-31',
      daysLeft: -3,
    },
    {
      kind: 'cycle',
      project: payRef,
      cycle: { number: 12, name: 'Checkout rewrite', startsOn: '2026-10-27', endsOn: '2026-11-04' },
      daysLeft: 2,
      progress: { done: 9, total: 18 },
    },
    {
      kind: 'milestone',
      project: payRef,
      milestone: { id: milestoneId, name: 'Webhooks v2', targetDate: '2026-11-04' },
      daysLeft: 1,
      progress: { done: 14, total: 22 },
    },
  ],
  groups: [
    {
      key: 'review',
      total: 1,
      items: [
        {
          task: { ...taskListItemFixture, key: 'PAY-120', status: 'in_review' },
          reason: {
            kind: 'review',
            requestedBy: claudeDev,
            onBehalfOf: ana,
            waitingOn: ana,
            at: at('2026-11-03T08:20:00.000Z'),
          },
          relation: 'agent',
          pills: [{ kind: 'blocks', count: 2 }],
        },
      ],
    },
    { key: 'mergedOpen', total: 0, items: [] },
    { key: 'checkAgain', total: 0, items: [] },
    {
      key: 'mentions',
      total: 1,
      items: [
        {
          task: taskListItemWithFieldsFixture,
          reason: {
            kind: 'mention',
            author: tomas,
            onBehalfOf: null,
            mentioned: ana,
            comment: { id: commentId, excerpt: 'Can we ship this before the cycle ends?' },
            at: at('2026-11-02T09:00:00.000Z'),
          },
          relation: 'agent',
          pills: [
            { kind: 'blocked' },
            { kind: 'overdue', daysOverdue: 3 },
            { kind: 'cycle', cycle: { number: 12, name: 'Checkout rewrite' } },
          ],
        },
      ],
    },
    {
      key: 'blocked',
      total: 1,
      items: [
        {
          task: { ...taskListItemFixture, key: 'PAY-150', blocked: true },
          reason: {
            kind: 'blocked',
            blockers: [
              { key: 'PAY-142', title: taskFixture.title, status: 'in_progress', assignee: claudeDev },
            ],
          },
          relation: 'assignee',
          pills: [],
        },
      ],
    },
    {
      key: 'overdue',
      total: 1,
      items: [
        {
          task: { ...taskListItemFixture, key: 'PAY-65', status: 'todo', dueDate: '2026-11-01' },
          reason: { kind: 'overdue', dueDate: '2026-11-01', daysOverdue: 2 },
          relation: 'creator',
          pills: [{ kind: 'unassigned' }],
        },
      ],
    },
    { key: 'assigned', total: 0, items: [] },
  ],
  agents: [],
} satisfies z.input<typeof Home>;

/** Home, Agents tab: one working agent and one agent question waiting on a person. */
export const homeAgentsFixture = {
  tab: 'agents',
  generatedAt: at('2026-11-03T09:00:00.000Z'),
  counts: { mine: 4, everyone: 26, agents: 1 },
  deadlines: [],
  groups: [
    {
      key: 'waiting',
      total: 1,
      items: [
        {
          task: { ...taskListItemFixture, key: 'PAY-146' },
          reason: {
            kind: 'mention',
            author: claudeDev,
            onBehalfOf: ana,
            mentioned: ana,
            comment: { id: commentId, excerpt: 'Should the alert page or only post to the channel?' },
            at: at('2026-11-03T08:00:00.000Z'),
          },
          relation: null,
          pills: [{ kind: 'question' }],
        },
      ],
    },
  ],
  agents: [
    {
      agent: { ...claudeDev, responsible: ana },
      state: 'working',
      currentTask: {
        ...payTask('PAY-146', 'Alert on-call after the 8th attempt', 'in_progress'),
        since: at('2026-11-03T08:38:00.000Z'),
      },
      counts: { assigned: 58, inReview: 6, blocked: 2, changesToday: 41 },
      recent: [
        {
          kind: 'activity',
          id: activityId,
          task: payTask('PAY-120', 'Idempotency keys for payouts', 'in_review'),
          type: 'task.updated',
          changes: [{ field: 'status', from: 'in_progress', to: 'in_review' }],
          at: at('2026-11-03T07:00:00.000Z'),
        },
        {
          kind: 'comment',
          id: commentId,
          task: payTask('PAY-146', 'Alert on-call after the 8th attempt', 'in_progress'),
          excerpt: 'Should the alert page or only post to the channel?',
          mentions: [ana],
          at: at('2026-11-03T08:00:00.000Z'),
        },
      ],
      lastActivityAt: at('2026-11-03T08:00:00.000Z'),
    },
  ],
} satisfies z.input<typeof Home>;

// ---------------------------------------------------------------------------
// M6: the work record
// ---------------------------------------------------------------------------

export const workItemFixtures = {
  checked: {
    number: 1,
    text: 'Retries stop after a 4xx answer',
    state: 'checked',
    waivedReason: null,
    waivedBy: null,
    locked: false,
  },
  open: {
    number: 2,
    text: 'Backoff doubles from 30 seconds',
    state: 'open',
    waivedReason: null,
    waivedBy: null,
    locked: false,
  },
  waived: {
    number: 3,
    text: 'Load test at 1,000 deliveries a minute',
    state: 'waived',
    waivedReason: 'Load test replaced by a replay',
    waivedBy: ana,
    locked: false,
  },
} satisfies Record<string, z.input<typeof WorkItem>>;

/** PAY-142 with criteria, done items, a plan and a summary. */
export const workRecordTaskFixture = {
  ...taskFixture,
  status: 'in_review',
  criteria: [workItemFixtures.checked, workItemFixtures.open, workItemFixtures.waived],
  doneItems: [
    { number: 1, text: 'Tests pass', state: 'checked', waivedReason: null, waivedBy: null, locked: false },
  ],
  plan: '1. Store the attempt count\n2. Schedule retries as jobs',
  planMeta: { author: claudeDev, onBehalfOf: ana, origin: 'app', at: at('2026-10-21T09:00:00.000Z') },
  finalSummary: 'Retries back off and stop on 4xx answers.',
  finalSummaryMeta: { author: claudeDev, onBehalfOf: ana, origin: 'app', at: at('2026-10-22T18:00:00.000Z') },
} satisfies z.input<typeof Task>;

export const workRecordListItemFixture = {
  ...taskListItemFixture,
  criteriaProgress: { settled: 2, open: 1, waived: 1, total: 3 },
  doneProgress: { settled: 1, open: 0, waived: 0, total: 1 },
  hasFinalSummary: true,
} satisfies z.input<typeof TaskListItem>;

/** A work note claude-dev wrote from the CLI. */
export const noteFixture = {
  ...commentFixture,
  id: '0190a1b2-c3d4-7e5f-8a9b-0c1d2e3f4ae5',
  body: 'Migration written and tested',
  mentions: [],
  editedAt: null,
  kind: 'note',
  source: { machine: 'ana-laptop', branch: 'feat/webhook-retries' },
} satisfies z.input<typeof Comment>;

/** claude-dev checking criterion 1 and waiving criterion 3 from the CLI. */
export const workRecordActivityFixture = {
  ...activityFixture,
  id: '0190a1b2-c3d4-7e5f-8a9b-0c1d2e3f4af6',
  changes: [
    { field: 'criterion.checked', number: 1, text: workItemFixtures.checked.text },
    {
      field: 'criterion.waived',
      number: 3,
      text: workItemFixtures.waived.text,
      reason: workItemFixtures.waived.waivedReason,
    },
    { field: 'plan', from: null, to: workRecordTaskFixture.plan },
  ],
  source: { machine: 'ana-laptop', branch: 'feat/webhook-retries' },
} satisfies z.input<typeof Activity>;

export const workRecordTimelineFixture = {
  items: [
    { kind: 'activity', ...activityFixture },
    { kind: 'comment', ...commentFixture },
    noteFixture,
    { kind: 'activity', ...workRecordActivityFixture },
  ],
  counts: { all: 4, comments: 1, notes: 1, history: 2 },
} satisfies z.input<typeof Timeline>;

export const backlogExportFixture = {
  project: 'PAY',
  format: 'backlog.md 1',
  generatedAt: at('2026-10-23T08:00:00.000Z'),
  files: [
    { path: 'tasks/pay-142 - Retry failed webhook deliveries.md', content: '---\nid: PAY-142\n---\n' },
    { path: 'completed/pay-7 - Ledger table.md', content: '---\nid: PAY-7\n---\n' },
    { path: 'milestones/m-1 - webhooks-v2.md', content: '---\nid: m-1\n---\n' },
  ],
  removedPrefixes: ['tasks/', 'completed/', 'milestones/'],
} satisfies z.input<typeof BacklogExport>;

// ---------------------------------------------------------------------------
// M7: pull requests, archive and check-again days
// ---------------------------------------------------------------------------

/** PR #482 of the Northwind payments repository, linked to PAY-142 by its work branch. */
export const pullRequestLinkFixture = {
  provider: 'github',
  number: 482,
  title: 'Retry failed webhook deliveries',
  url: 'https://github.com/northwind/payments/pull/482',
  state: 'open',
  headBranch: 'feat/webhook-retries',
  baseBranch: 'main',
  author: 'claude-dev',
  mergedBy: null,
  how: 'branch',
  linkedBy: null,
  linkedAt: at('2026-11-20T09:05:00.000Z'),
  openedAt: at('2026-11-20T09:00:00.000Z'),
  mergedAt: null,
  closedAt: null,
  updatedAt: at('2026-11-21T10:00:00.000Z'),
} satisfies z.input<typeof PullRequestLink>;

/** A draft linked by hand by Ana. */
export const handLinkedPullRequestFixture = {
  ...pullRequestLinkFixture,
  number: 479,
  title: 'Draft: backoff table',
  url: 'https://github.com/northwind/payments/pull/479',
  state: 'draft',
  headBranch: 'spike/backoff',
  how: 'hand',
  linkedBy: ana,
} satisfies z.input<typeof PullRequestLink>;

/** PAY-142 started on a branch, with two requests and a check-again day. */
export const m7TaskFixture = {
  ...taskFixture,
  status: 'in_review',
  workBranch: 'feat/webhook-retries',
  pullRequests: [pullRequestLinkFixture, handLinkedPullRequestFixture],
  checkAgain: { on: '2026-12-01', reason: "Wait for the bank's answer on retries" },
  closedAt: null,
  archivedAt: null,
  archivedBy: null,
  mergedOpen: null,
} satisfies z.input<typeof Task>;

/** PAY-142 after the merge closed it with one criterion open, then archived by Ana. */
export const archivedTaskFixture = {
  ...m7TaskFixture,
  status: 'done',
  pullRequests: [
    { ...pullRequestLinkFixture, state: 'merged', mergedBy: 'ana', mergedAt: at('2026-11-22T12:00:00.000Z') },
  ],
  checkAgain: null,
  closedAt: at('2026-11-22T12:00:05.000Z'),
  archivedAt: at('2026-11-24T08:00:00.000Z'),
  archivedBy: ana,
  mergedOpen: { at: at('2026-11-22T12:00:05.000Z'), openCriteria: 1, openDoneItems: 0 },
} satisfies z.input<typeof Task>;

export const m7ListItemFixture = {
  ...taskListItemFixture,
  status: 'in_review',
  checkAgain: m7TaskFixture.checkAgain,
  archivedAt: null,
  pullRequest: {
    provider: 'github',
    number: 482,
    title: pullRequestLinkFixture.title,
    url: pullRequestLinkFixture.url,
    state: 'open',
  },
  pullRequestCount: 2,
} satisfies z.input<typeof TaskListItem>;

/** GitHub moving PAY-142 to In review when #482 was opened. */
export const gitActivityFixture = {
  id: '0190a1b2-c3d4-7e5f-8a9b-0c1d2e3f4b07',
  type: 'task.updated',
  taskKey: 'PAY-142',
  actor: null,
  onBehalfOf: null,
  changes: [{ field: 'status', from: 'in_progress', to: 'in_review' }],
  origin: 'git',
  originRef: pullRequestLinkFixture.url,
  cause: {
    kind: 'pull_request',
    provider: 'github',
    number: 482,
    title: pullRequestLinkFixture.title,
    url: pullRequestLinkFixture.url,
    event: 'opened',
    by: 'claude-dev',
  },
  system: { kind: 'git', provider: 'github' },
  createdAt: at('2026-11-20T09:00:10.000Z'),
} satisfies z.input<typeof Activity>;

/** The nightly job archiving PAY-142 14 days after it closed. */
export const archiveActivityFixture = {
  id: '0190a1b2-c3d4-7e5f-8a9b-0c1d2e3f4b18',
  type: 'task.archived',
  taskKey: 'PAY-142',
  actor: null,
  onBehalfOf: null,
  changes: [],
  origin: 'app',
  originRef: null,
  cause: { kind: 'archive', afterDays: 14 },
  system: { kind: 'zamu' },
  createdAt: at('2026-12-06T01:30:00.000Z'),
} satisfies z.input<typeof Activity>;

/** Ana linking #479 by hand. */
export const pullRequestLinkedActivityFixture = {
  ...activityFixture,
  id: '0190a1b2-c3d4-7e5f-8a9b-0c1d2e3f4b29',
  type: 'task.pull_request_linked',
  actor: ana,
  onBehalfOf: null,
  changes: [
    {
      field: 'pullRequest',
      from: null,
      to: {
        provider: 'github',
        number: 479,
        title: 'Draft: backoff table',
        url: handLinkedPullRequestFixture.url,
        how: 'hand',
      },
    },
  ],
  cause: null,
  system: null,
} satisfies z.input<typeof Activity>;

/** Home rows of the two M7 groups. */
export const mergedOpenHomeItemFixture = {
  task: { ...m7ListItemFixture, key: 'PAY-131', status: 'done', checkAgain: null },
  reason: {
    kind: 'mergedOpen',
    pullRequest: {
      provider: 'github',
      number: 470,
      title: 'Ledger export',
      url: 'https://github.com/northwind/payments/pull/470',
    },
    openCriteria: 2,
    openDoneItems: 0,
    at: at('2026-11-25T16:00:00.000Z'),
  },
  relation: 'assignee',
  pills: [],
} satisfies z.input<typeof HomeItem>;

export const checkAgainHomeItemFixture = {
  task: {
    ...m7ListItemFixture,
    key: 'PAY-118',
    status: 'in_progress',
    checkAgain: { on: '2026-11-26', reason: 'Bank answers by Thursday' },
  },
  reason: { kind: 'checkAgain', on: '2026-11-26', reason: 'Bank answers by Thursday', daysAgo: 0 },
  relation: 'assignee',
  pills: [{ kind: 'blocked' }],
} satisfies z.input<typeof HomeItem>;

/** PAY's repository settings: healthy, through a GitHub connection, closing on merge. */
export const repositorySettingsFixture = {
  project: payRef,
  repository: 'https://github.com/northwind/payments',
  provider: 'github',
  connection: {
    id: '0190a1b2-c3d4-7e5f-8a9b-0c1d2e3f4b3a',
    name: 'Northwind GitHub',
    provider: 'github',
    host: 'github.com',
    status: 'working',
  },
  defaultBranch: 'main',
  closeOnMerge: true,
  mirrored: false,
  webhook: {
    url: 'https://zamu.example.com/api/webhooks/repository/wh_4kQz9vX2',
    secretSet: true,
    lastAt: at('2026-11-26T08:40:00.000Z'),
    lastStatus: 'ok',
    coveredByBacklog: false,
  },
  sync: {
    lastAt: at('2026-11-26T08:45:03.000Z'),
    error: null,
    nextAt: at('2026-11-26T09:45:00.000Z'),
  },
  canEdit: true,
} satisfies z.input<typeof RepositorySettings>;

/** A project without a repository: the "No repository" state. */
export const noRepositorySettingsFixture = {
  ...repositorySettingsFixture,
  repository: null,
  provider: null,
  connection: null,
  defaultBranch: null,
  webhook: null,
  sync: { lastAt: null, error: null, nextAt: null },
} satisfies z.input<typeof RepositorySettings>;

export const archivePreviewFixture = {
  project: 'PAY',
  days: 14,
  count: 37,
} satisfies z.input<typeof ArchivePreview>;

// ---------------------------------------------------------------------------
// M8: plan link, waves and gates
// ---------------------------------------------------------------------------

export const payoutsMilestoneId = '0190a1b2-c3d4-7e5f-8a9b-0c1d2e3f4c01';
export const waveIds = {
  w1: '0190a1b2-c3d4-7e5f-8a9b-0c1d2e3f4c11',
  w2: '0190a1b2-c3d4-7e5f-8a9b-0c1d2e3f4c12',
  w3: '0190a1b2-c3d4-7e5f-8a9b-0c1d2e3f4c13',
  w4: '0190a1b2-c3d4-7e5f-8a9b-0c1d2e3f4c14',
  w5: '0190a1b2-c3d4-7e5f-8a9b-0c1d2e3f4c15',
} as const;

/** Payouts v2: five waves, W1 and W2 passed, W3 current with its gate open, W4 and W5 locked. */
export const payoutsMilestoneFixture = {
  ...milestoneWithProgressFixture,
  id: payoutsMilestoneId,
  name: 'Payouts v2',
  description: 'Faster payouts with a ledger behind them.',
  targetDate: '2026-12-18',
  planUrl: 'plans/payouts-v2.html',
  progress: { total: 22, done: 14, inProgress: 3, open: 4, canceled: 1 },
  daysLeft: 21,
  waves: { count: 5, current: 3, currentState: 'open', allPassed: false },
} satisfies z.input<typeof MilestoneWithProgress>;

const waveTask = (
  key: string,
  title: string,
  status: 'todo' | 'in_progress' | 'in_review' | 'done' | 'canceled',
  assignee: z.input<typeof UserRef> | null = null,
) => ({ key, title, status, assignee, archived: false });

/** W2 · Ledger: passed by claude-dev for Ana, from the CLI. */
export const passedWaveFixture = {
  id: waveIds.w2,
  milestoneId: payoutsMilestoneId,
  number: 2,
  name: 'Ledger',
  gate: {
    description: 'Ledger entries balance for every payout in the staging run.',
    state: 'passed',
    result: {
      state: 'passed',
      note: 'Ran the staging payout batch: 412 entries, all balanced.',
      recordedBy: claudeDev,
      onBehalfOf: ana,
      at: at('2026-11-24T16:00:00.000Z'),
      source: { machine: 'ana-mbp', branch: 'feat/ledger' },
    },
  },
  current: false,
  locked: false,
  lockedUntil: null,
  progress: { total: 4, done: 4, canceled: 0, open: 0 },
  canPass: true,
  openKeys: [],
  tasks: [
    waveTask('PAY-160', 'Ledger table', 'done', claudeDev),
    waveTask('PAY-161', 'Post entries on payout', 'done', claudeDev),
    waveTask('PAY-162', 'Reverse entries on refund', 'done', claudeDev),
    { ...waveTask('PAY-163', 'Ledger export', 'done', ana), archived: true },
  ],
} satisfies z.input<typeof Wave>;

/** W3 · Payout screens: current, gate open, 4 of 6 done. */
export const currentWaveFixture = {
  id: waveIds.w3,
  milestoneId: payoutsMilestoneId,
  number: 3,
  name: 'Payout screens',
  gate: {
    description: 'Screens match the design in light and dark, at 1440, 1280 and 1024.',
    state: 'open',
    result: null,
  },
  current: true,
  locked: false,
  lockedUntil: null,
  progress: { total: 6, done: 4, canceled: 0, open: 2 },
  canPass: false,
  openKeys: ['PAY-173', 'PAY-174'],
  tasks: [
    waveTask('PAY-170', 'Payout list', 'done', claudeDev),
    waveTask('PAY-171', 'Payout detail', 'done', claudeDev),
    waveTask('PAY-172', 'Empty state', 'done', ana),
    waveTask('PAY-175', 'Dark theme pass', 'done', claudeDev),
    waveTask('PAY-173', 'Retry button', 'in_review', claudeDev),
    waveTask('PAY-174', 'Failed payout banner', 'todo'),
  ],
} satisfies z.input<typeof Wave>;

/** W4 · Rollout: locked until W3 passes. */
export const lockedWaveFixture = {
  id: waveIds.w4,
  milestoneId: payoutsMilestoneId,
  number: 4,
  name: 'Rollout',
  gate: { description: null, state: 'open', result: null },
  current: false,
  locked: true,
  lockedUntil: { number: 3, name: 'Payout screens' },
  progress: { total: 2, done: 0, canceled: 0, open: 2 },
  canPass: false,
  openKeys: ['PAY-180', 'PAY-181'],
  tasks: [waveTask('PAY-180', 'Feature flag', 'todo'), waveTask('PAY-181', 'Merchant email', 'todo')],
} satisfies z.input<typeof Wave>;

/** A gate that failed: Tomás recorded it, so onBehalfOf is null and there is no CLI source. */
export const failedWaveFixture = {
  ...currentWaveFixture,
  gate: {
    description: currentWaveFixture.gate.description,
    state: 'failed',
    result: {
      state: 'failed',
      note: 'The banner overlaps the list at 1024.\n\nLogged the fix as PAY-176.',
      recordedBy: tomas,
      onBehalfOf: null,
      at: at('2026-11-26T11:00:00.000Z'),
      source: null,
    },
  },
} satisfies z.input<typeof Wave>;

/** The plan of Payouts v2 as GET /milestones/{id}/plan returns it (W1 and W5 left out for size). */
export const milestonePlanFixture = {
  milestone: payoutsMilestoneFixture,
  planUrl: 'plans/payouts-v2.html',
  waves: [passedWaveFixture, currentWaveFixture, lockedWaveFixture],
  notInWave: [waveTask('PAY-190', 'Payout fees in the docs', 'todo', tomas)],
} satisfies z.input<typeof MilestonePlan>;

/** PAY-174 in the locked W4. */
export const waveTaskFixture = {
  ...taskFixture,
  key: 'PAY-174',
  status: 'todo',
  milestone: { id: payoutsMilestoneId, name: 'Payouts v2', status: 'active', targetDate: '2026-12-18' },
  wave: {
    id: waveIds.w4,
    number: 4,
    name: 'Rollout',
    locked: true,
    lockedUntil: { number: 3, name: 'Payout screens' },
  },
} satisfies z.input<typeof Task>;

/** Ana moving PAY-174 from W3 to W4. */
export const waveActivityFixture = {
  ...activityFixture,
  id: '0190a1b2-c3d4-7e5f-8a9b-0c1d2e3f4c21',
  taskKey: 'PAY-174',
  actor: ana,
  onBehalfOf: null,
  changes: [
    {
      field: 'wave',
      from: { id: waveIds.w3, number: 3, name: 'Payout screens', removed: false },
      to: { id: waveIds.w4, number: 4, name: 'Rollout', removed: false },
    },
  ],
} satisfies z.input<typeof Activity>;
