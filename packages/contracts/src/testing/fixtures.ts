import type { z } from 'zod';
import type {
  Activity,
  ApiKeyCreated,
  ApiKeySummary,
  BacklogExport,
  Comment,
  Cycle,
  CycleDetail,
  CycleRollover,
  Home,
  Invitation,
  LabelWithUsage,
  Me,
  Member,
  Milestone,
  MilestoneWithProgress,
  Project,
  ProjectWithCounts,
  Task,
  TaskListItem,
  TaskListPage,
  Timeline,
  TimelineItem,
  UserRef,
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
