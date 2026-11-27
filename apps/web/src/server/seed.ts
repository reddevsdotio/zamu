// Development data: a workspace with projects PAY and WEB, a few tasks, the agent claude-dev acting
// for the admin, fresh API keys, and with `backlog` the mirrored Backlog.md project BACK. With
// `secondWorkspace`, the admin also owns a second workspace (Globex) whose project has the same key,
// PAY, and its own claude-dev agent, so links, keys and lists can be checked for isolation. With
// `pullRequests`, PAY links a repository and gets requests in every state, archived tasks and
// check-again days. With `waves`, PAY gets milestones planned in waves with gates in every state.
// Everything goes through @zamu/auth and @zamu/core, like real use, except a few direct writes noted
// where they happen (a backdated task, the repository link's check state, one archive by the nightly
// job, the times of gate results). Re-running is safe: existing workspaces, projects and agents are kept,
// and new keys are issued each time.
import {
  AcceptInvitationError,
  acceptInvitationWithSignUp,
  bootstrapAdmin,
  getActorFromRequest,
  isFirstRun,
} from '@zamu/auth';
import {
  type CreateTaskInput,
  DEFAULT_ARCHIVE_AFTER_DAYS,
  type Priority,
  type TaskStatus,
} from '@zamu/contracts';
import {
  type Actor,
  addCalendarDays,
  applyRequest,
  archiveTasks,
  Conflict,
  type CoreContext,
  createAgent,
  createApiKey,
  createComment,
  createCycle,
  createInvitation,
  createMilestone,
  createProject,
  createTask,
  createWave,
  createWorkspace,
  ensureRepositoryLink,
  formatMention,
  isEncryptionReady,
  listMembers,
  listMyWorkspaces,
  newRepositoryWebhookSecret,
  putTasksInWave,
  recordActivities,
  recordGateResult,
  SlugTaken,
  todayIn,
  touchLastWorkspace,
  toWorkspaceRole,
  updateMilestone,
  updateProject,
  updateTask,
} from '@zamu/core';
import type { z } from 'zod';
import { seedBacklogProject } from './seed-backlog';

export interface SeedOptions {
  /** Also add M2 demo data to a newly created PAY: milestones, a current and a next cycle, comments. */
  planning?: boolean;
  /**
   * M3: also add the mirrored Backlog.md demo project BACK ("Payments API") with its git connection.
   * Needs APP_ENCRYPTION_KEY in the context. Default false.
   */
  backlog?: boolean;
  /**
   * With planning, when PAY and WEB are both new: fill every dashboard queue group for the admin.
   * Adds the member Tomás Berg, a WEB cycle that ends tomorrow, two unanswered mentions of the
   * admin (by the agent and by Tomás) and an agent task in progress without an update for 26 hours.
   */
  dashboard?: boolean;
  /**
   * 0.10: also give the admin a second workspace (secondWorkspaceName, slug from the name) with its own
   * PAY project and its own agent named agentName, and keys for both. Default false.
   */
  secondWorkspace?: boolean;
  secondWorkspaceName?: string;
  /**
   * M7, when PAY is new: link PAY to github.com/northwind/payments with requests in every state
   * (open, draft, merged, closed) and tasks linked by branch, by a `Closes:` line and by hand; one
   * task Done through a merge with open criteria; tasks archived by hand and by the nightly job;
   * tasks waiting and ready to check again. PAY keeps the 14 days new projects get; WEB, when new,
   * has archiving off, like a project from before archiving existed. Default false.
   */
  pullRequests?: boolean;
  /**
   * M8, when PAY is new: four PAY milestones planned in waves with gates. "Payouts v2" (plan link
   * plans/payouts-v2.html) has five waves: W1 and W2 passed, W3 current with its gate open and 4 of
   * 6 tasks done, W4 and W5 locked, and tasks in no wave. "Statements export" has a failed gate,
   * "Card vault migration" every gate passed, and "Refunds rework" (a wiki plan link) 12 waves:
   * W1 to W7 passed, W8 current with 30 tasks and a failed result with a long note. Gate results
   * are recorded by the agent for the admin and by the admin. Default false.
   */
  waves?: boolean;
  adminName?: string;
  adminEmail?: string;
  adminPassword?: string;
  workspaceName?: string;
  agentName?: string;
  memberName?: string;
  memberEmail?: string;
  memberPassword?: string;
}

export interface SeedWorkspace {
  id: string;
  name: string;
  slug: string;
}

/** The second workspace: what the seed made there and the keys it issued for it. */
export interface SecondWorkspaceSeed {
  workspace: SeedWorkspace;
  /** True when this run created the workspace. */
  created: boolean;
  agent: { id: string; name: string };
  createdProjects: { key: string; tasks: number }[];
  /** The second workspace's agent's new key: all its projects, read and write. */
  agentKey: string;
  /** The admin's new key for the second workspace: all its projects, read and write. */
  adminKey: string;
}

export interface SeedResult {
  workspaceId: string;
  /** The first workspace, where the admin lands. */
  workspace: SeedWorkspace;
  /** True when this run created the admin and workspace (first run). */
  bootstrapped: boolean;
  admin: { id: string; name: string; email: string; password: string | null };
  agent: { id: string; name: string };
  /** The second person, when the dashboard data was added. Their password is memberPassword. */
  member: { id: string; name: string; email: string } | null;
  /** Projects this run created, with how many tasks each got. Existing projects are left alone. */
  createdProjects: { key: string; tasks: number }[];
  /** claude-dev's new key: all projects, read and write. */
  agentKey: string;
  /** The admin's new key: all projects, read and write. */
  adminKey: string;
  /** Present with the secondWorkspace option. */
  second: SecondWorkspaceSeed | null;
}

export const SEED_DEFAULTS = {
  adminName: 'Ana Ruiz',
  adminEmail: 'ana@example.com',
  adminPassword: 'dev-password-1234',
  workspaceName: 'Reddevs',
  secondWorkspaceName: 'Globex',
  agentName: 'claude-dev',
  memberName: 'Tomás Berg',
  memberEmail: 'tomas@example.com',
  memberPassword: 'dev-password-1234',
  planning: false,
  backlog: false,
  dashboard: false,
  secondWorkspace: false,
  pullRequests: false,
  waves: false,
} satisfies Required<SeedOptions>;

/** How long ago the seed's stalled agent task was last updated: past the 24-hour agent threshold. */
const STALLED_SEED_HOURS = 26;

type Who = 'admin' | 'agent' | null;
interface SeedProject {
  key: string;
  name: string;
  description: string;
  tasks: SeedTask[];
}
interface SeedTask {
  title: string;
  status: TaskStatus;
  priority: Priority;
  assignee: Who;
  description?: string;
  /** Changed afterwards by the agent through its API key, so the task has agent activity. */
  agentMovesTo?: TaskStatus;
}

const PROJECTS: SeedProject[] = [
  {
    key: 'PAY',
    name: 'Payments',
    description: 'Checkout, refunds, webhooks and payouts',
    tasks: [
      { title: 'Remove legacy v0 checkout routes', status: 'todo', priority: 'medium', assignee: null },
      {
        title: 'Add idempotency keys to the refund endpoint',
        status: 'in_progress',
        priority: 'urgent',
        assignee: 'admin',
      },
      {
        title: 'Paginate the transactions CSV export',
        status: 'in_review',
        priority: 'medium',
        assignee: 'admin',
      },
      {
        title: 'Document the nightly payout reconciliation job',
        status: 'todo',
        priority: 'none',
        assignee: 'agent',
      },
      {
        title: 'Webhook signature check accepts expired timestamps',
        status: 'in_progress',
        priority: 'urgent',
        assignee: 'agent',
        agentMovesTo: 'in_review',
        description:
          'The verifier compares the signature but never checks the `t=` timestamp, so a captured ' +
          'payload can be replayed.\n\n- Reject timestamps older than 5 minutes\n- Add a test with a ' +
          'replayed payload',
      },
      {
        title: 'Stream invoice PDFs instead of buffering them in memory',
        status: 'in_progress',
        priority: 'medium',
        assignee: 'admin',
      },
      {
        title:
          'Partial refunds across more than three line items round to the wrong cent when the invoice ' +
          'currency differs from the account currency',
        status: 'todo',
        priority: 'high',
        assignee: null,
      },
      {
        title: 'Retry failed webhook deliveries with exponential backoff',
        status: 'todo',
        priority: 'high',
        assignee: 'agent',
        agentMovesTo: 'in_progress',
      },
      {
        title: 'Show a test-mode banner on the billing settings page',
        status: 'todo',
        priority: 'low',
        assignee: null,
      },
      { title: 'Support Apple Pay in checkout', status: 'backlog', priority: 'low', assignee: null },
      { title: 'Upgrade the payment provider SDK', status: 'done', priority: 'medium', assignee: 'agent' },
    ],
  },
  {
    key: 'WEB',
    name: 'Web app',
    description: 'The customer-facing dashboard',
    tasks: [
      {
        title: 'Dark mode flickers on first load',
        status: 'in_progress',
        priority: 'high',
        assignee: 'agent',
      },
      {
        title: 'Add keyboard shortcuts to the invoice list',
        status: 'todo',
        priority: 'medium',
        assignee: null,
      },
      {
        title: 'Move settings into a sidebar layout',
        status: 'in_review',
        priority: 'medium',
        assignee: 'admin',
      },
      { title: 'Empty state for the reports page', status: 'backlog', priority: 'none', assignee: null },
    ],
  },
];

/** The second workspace's project: the same key as the first workspace's PAY, other tasks. */
const SECOND_PROJECTS: SeedProject[] = [
  {
    key: 'PAY',
    name: 'Payroll',
    description: 'Payslips, timesheets and year-end tax forms',
    tasks: [
      {
        title: 'Holiday pay rounds down for part-time staff',
        status: 'todo',
        priority: 'high',
        assignee: null,
      },
      {
        title: 'Import timesheets from the CSV export',
        status: 'in_progress',
        priority: 'medium',
        assignee: 'agent',
        agentMovesTo: 'in_review',
      },
      {
        title: 'Year-end tax forms for contractors',
        status: 'in_progress',
        priority: 'urgent',
        assignee: 'admin',
      },
      { title: 'Email payslips as PDF attachments', status: 'backlog', priority: 'low', assignee: null },
      { title: 'Move the payroll run to the 25th', status: 'done', priority: 'medium', assignee: 'admin' },
    ],
  },
];

const WORKSPACE_SCOPE = { projects: 'all' as const, access: 'write' as const };

async function findAdmin(ctx: CoreContext, email: string) {
  const byEmail = await ctx.db.query.user.findFirst({
    columns: { id: true, name: true, email: true },
    where: { email },
  });
  const membership = await ctx.db.query.member.findFirst({
    columns: { userId: true, organizationId: true, role: true },
    where: byEmail ? { userId: byEmail.id } : { role: 'owner' },
    orderBy: { createdAt: 'asc' },
  });
  if (!membership) throw new Error('The instance is set up but has no workspace owner to seed as');
  const user =
    byEmail ??
    (await ctx.db.query.user.findFirst({
      columns: { id: true, name: true, email: true },
      where: { id: membership.userId },
    }));
  if (!user) throw new Error('Workspace owner not found');
  return { user, membership };
}

async function agentActor(ctx: CoreContext, key: string): Promise<Actor> {
  const actor = await getActorFromRequest(ctx, { headers: new Headers({ authorization: `Bearer ${key}` }) });
  if (!actor) throw new Error('The new agent key does not authenticate');
  return actor;
}

export async function seedDevData(ctx: CoreContext, options: SeedOptions = {}): Promise<SeedResult> {
  const opts = { ...SEED_DEFAULTS, ...options };
  const bootstrapped = await isFirstRun(ctx.db);
  if (bootstrapped) {
    await bootstrapAdmin(ctx, {
      name: opts.adminName,
      email: opts.adminEmail,
      password: opts.adminPassword,
      workspaceName: opts.workspaceName,
    });
  }
  const { user, membership } = await findAdmin(ctx, opts.adminEmail.toLowerCase());
  const admin: Actor = {
    userId: user.id,
    kind: 'person',
    workspaceId: membership.organizationId,
    role: toWorkspaceRole(membership.role),
    onBehalfOfId: null,
  };

  const { agentId, agentKey, agent } = await ensureAgent(ctx, admin, opts.agentName);

  // Projects and tasks. A project that already exists keeps its tasks.
  const createdProjects = await seedProjects(ctx, PROJECTS, { admin, agent, agentId }, async (key) => {
    if (opts.planning && key === 'PAY') await seedPlanning(ctx, admin, agent);
  });
  const created = new Set(createdProjects.map((p) => p.key));
  const member =
    opts.planning && opts.dashboard && created.has('PAY') && created.has('WEB')
      ? await seedDashboard(ctx, admin, agent, { name: user.name, opts })
      : null;

  if (opts.pullRequests && created.has('PAY')) {
    const added = await seedRequests(ctx, admin, agent, { webIsNew: created.has('WEB') });
    const pay = createdProjects.find((p) => p.key === 'PAY');
    if (pay) pay.tasks += added;
  }

  if (opts.waves && created.has('PAY')) {
    const added = await seedWaves(ctx, admin, agent);
    const pay = createdProjects.find((p) => p.key === 'PAY');
    if (pay) pay.tasks += added;
  }

  if (opts.backlog) {
    const backlog = await seedBacklogProject(ctx, admin);
    if (backlog) createdProjects.push(backlog);
  }

  const adminKey = await createApiKey(ctx, admin, { name: `${user.name} dev seed`, scope: WORKSPACE_SCOPE });
  const second = opts.secondWorkspace ? await seedSecondWorkspace(ctx, admin, user.name, opts) : null;

  const workspace = (await listMyWorkspaces(ctx, admin.userId)).items.find(
    (item) => item.id === admin.workspaceId,
  );
  if (!workspace) throw new Error('The seed workspace is missing from the admin workspaces');

  return {
    workspaceId: admin.workspaceId,
    workspace: { id: workspace.id, name: workspace.name, slug: workspace.slug },
    bootstrapped,
    admin: {
      id: user.id,
      name: user.name,
      email: user.email,
      password: bootstrapped ? opts.adminPassword : null,
    },
    agent: { id: agentId, name: opts.agentName },
    member,
    createdProjects,
    agentKey,
    adminKey: adminKey.key,
    second,
  };
}

/** The agent named `name` in the actor's workspace, created when missing, with a new key. */
async function ensureAgent(
  ctx: CoreContext,
  admin: Actor,
  name: string,
): Promise<{ agentId: string; agentKey: string; agent: Actor }> {
  let agentId: string;
  let agentKey: string;
  try {
    const created = await createAgent(ctx, admin, {
      name,
      responsibleUserId: admin.userId,
      scope: WORKSPACE_SCOPE,
      keyName: `${name} dev seed`,
    });
    agentId = created.agent.id;
    agentKey = created.key.key;
  } catch (error) {
    if (!(error instanceof Conflict)) throw error;
    const existing = (await listMembers(ctx, admin)).items.find((m) => m.kind === 'agent' && m.name === name);
    if (!existing) throw error;
    agentId = existing.id;
    const key = await createApiKey(ctx, admin, {
      name: `${name} dev seed`,
      ownerId: agentId,
      scope: WORKSPACE_SCOPE,
    });
    agentKey = key.key;
  }
  return { agentId, agentKey, agent: await agentActor(ctx, agentKey) };
}

/**
 * Creates each project that does not exist yet in the admin's workspace, with its tasks, and calls
 * `afterCreate` for it. A project that already exists keeps its tasks. Returns the projects created.
 */
async function seedProjects(
  ctx: CoreContext,
  specs: SeedProject[],
  { admin, agent, agentId }: { admin: Actor; agent: Actor; agentId: string },
  afterCreate: (key: string) => Promise<void> = async () => {},
): Promise<SeedResult['createdProjects']> {
  const createdProjects: SeedResult['createdProjects'] = [];
  for (const spec of specs) {
    try {
      await createProject(ctx, admin, { key: spec.key, name: spec.name, description: spec.description });
    } catch (error) {
      if (error instanceof Conflict) continue;
      throw error;
    }
    for (const task of spec.tasks) {
      const input: z.input<typeof CreateTaskInput> = {
        project: spec.key,
        title: task.title,
        status: task.status,
        priority: task.priority,
        assignee: task.assignee === 'admin' ? admin.userId : task.assignee === 'agent' ? agentId : null,
        ...(task.description ? { description: task.description } : {}),
      };
      const created = await createTask(ctx, task.assignee === 'agent' ? agent : admin, input);
      if (task.agentMovesTo) {
        await updateTask(ctx, agent, { key: created.key, status: task.agentMovesTo });
      }
    }
    createdProjects.push({ key: spec.key, tasks: spec.tasks.length });
    await afterCreate(spec.key);
  }
  return createdProjects;
}

/**
 * The second workspace: found among the admin's workspaces by name, or created with the admin as
 * owner. Creating a workspace makes it the one the admin used last, so the first workspace is set
 * back as the landing one afterwards.
 */
async function seedSecondWorkspace(
  ctx: CoreContext,
  first: Actor,
  adminName: string,
  opts: Required<SeedOptions>,
): Promise<SecondWorkspaceSeed> {
  const mine = await listMyWorkspaces(ctx, first.userId);
  let workspace = mine.items.find(
    (item) => item.name === opts.secondWorkspaceName && item.id !== first.workspaceId,
  );
  const created = !workspace;
  if (!workspace) {
    try {
      workspace = await createWorkspace(ctx, first.userId, { name: opts.secondWorkspaceName });
    } catch (error) {
      if (error instanceof SlugTaken) {
        throw new Error(`Another workspace already uses the slug for ${opts.secondWorkspaceName}`);
      }
      throw error;
    }
  }
  const admin: Actor = {
    userId: first.userId,
    kind: 'person',
    workspaceId: workspace.id,
    role: workspace.role,
    onBehalfOfId: null,
  };
  const { agentId, agentKey, agent } = await ensureAgent(ctx, admin, opts.agentName);
  const createdProjects = await seedProjects(ctx, SECOND_PROJECTS, { admin, agent, agentId });
  const adminKey = await createApiKey(ctx, admin, { name: `${adminName} dev seed`, scope: WORKSPACE_SCOPE });
  await touchLastWorkspace(ctx, first);
  return {
    workspace: { id: workspace.id, name: workspace.name, slug: workspace.slug },
    created,
    agent: { id: agentId, name: opts.agentName },
    createdProjects,
    agentKey,
    adminKey: adminKey.key,
  };
}

/**
 * M2 demo data for PAY: two milestones (one overdue), a current cycle that ends in three days and the
 * next one, tasks spread over them, and a short comment thread with a mention.
 */
async function seedPlanning(ctx: CoreContext, admin: Actor, agent: Actor): Promise<void> {
  const today = todayIn(ctx);
  const webhooks = await createMilestone(ctx, admin, {
    project: 'PAY',
    name: 'Webhooks v2',
    description: 'Reliable delivery: retries, signed payloads, a delivery log merchants can read.',
    targetDate: addCalendarDays(today, 22),
  });
  const audit = await createMilestone(ctx, admin, {
    project: 'PAY',
    name: 'PCI audit',
    targetDate: addCalendarDays(today, -3),
  });
  await createCycle(ctx, admin, {
    project: 'PAY',
    name: 'Checkout rewrite',
    startsOn: addCalendarDays(today, -11),
    endsOn: addCalendarDays(today, 2),
  });
  await createCycle(ctx, admin, { project: 'PAY' });
  for (let n = 1; n <= 8; n++) {
    const milestone = n <= 5 ? webhooks.id : n <= 7 ? audit.id : null;
    await updateTask(ctx, admin, {
      key: `PAY-${n}`,
      cycle: n <= 6 ? 'current' : 'next',
      ...(milestone ? { milestone } : {}),
    });
  }
  await createComment(ctx, admin, {
    key: 'PAY-1',
    body: 'Should 429 count toward the 6 attempts? Some providers send it for minutes during deploys.',
  });
  await createComment(ctx, agent, {
    key: 'PAY-1',
    body: 'Done. 429 now waits for Retry-After and does not use an attempt.\n\n- 4xx stops retrying, except 408 and 429\n- Tests: 14 new cases',
  });
  await createComment(ctx, admin, { key: 'PAY-1', body: 'Thanks @claude-dev, looks good.' });
}

/** The seed's second person: invited and signed up like a real member. Null when password login is off. */
async function seedMember(ctx: CoreContext, admin: Actor, opts: Required<SeedOptions>) {
  const email = opts.memberEmail.toLowerCase();
  try {
    const invitation = await createInvitation(ctx, admin, { email, role: 'member' });
    await acceptInvitationWithSignUp(ctx, {
      invitationId: invitation.id,
      name: opts.memberName,
      password: opts.memberPassword,
    });
  } catch (error) {
    if (error instanceof AcceptInvitationError && error.code === 'PASSWORD_LOGIN_DISABLED') return null;
    if (!(error instanceof Conflict)) throw error;
  }
  const row = await ctx.db.query.user.findFirst({
    columns: { id: true, name: true, email: true },
    where: { email },
  });
  if (!row) throw new Error(`The seed member ${email} was not created`);
  return row;
}

/**
 * M4 dashboard data, on top of seedPlanning: every queue group has an item for the admin in Mine.
 * - In review: PAY-3 and WEB-3 (admin) and PAY-5 (moved there by the agent), from the base seed.
 * - Mentions: the agent asks the admin on PAY-8, Tomás asks the admin on WEB-3.
 * - Stalled: WEB-1, the agent's task in progress, last updated 26 hours ago.
 * - Deadlines: PCI audit is overdue (PAY-6 is the admin's), the PAY cycle ends in two days and the
 *   new WEB cycle ends tomorrow.
 * Runs after every other write to these tasks, so nothing answers the mentions or touches WEB-1.
 */
async function seedDashboard(
  ctx: CoreContext,
  admin: Actor,
  agent: Actor,
  { name, opts }: { name: string; opts: Required<SeedOptions> },
): Promise<SeedResult['member']> {
  const today = todayIn(ctx);
  await createCycle(ctx, admin, {
    project: 'WEB',
    name: 'Settings polish',
    startsOn: addCalendarDays(today, -6),
    endsOn: addCalendarDays(today, 1),
  });
  for (const key of ['WEB-1', 'WEB-2', 'WEB-3']) await updateTask(ctx, admin, { key, cycle: 'current' });

  const you = formatMention(name, admin.userId);
  await createComment(ctx, agent, {
    key: 'PAY-8',
    body: `${you} should deliveries keep retrying past 24 hours, or stop and alert the merchant? The backoff caps at 6 attempts either way.`,
  });
  const member = await seedMember(ctx, admin, opts);
  if (member) {
    const memberActor: Actor = {
      userId: member.id,
      kind: 'person',
      workspaceId: admin.workspaceId,
      role: 'member',
      onBehalfOfId: null,
    };
    await createComment(ctx, memberActor, {
      key: 'WEB-3',
      body: `${you} the sidebar collapses below \`900px\`. Fine to ship, or do you want a drawer on mobile?`,
    });
  }

  // No service sets updated_at: backdate WEB-1 directly so it reads as stalled.
  const web = await ctx.db.query.project.findFirst({
    columns: { id: true },
    where: { workspaceId: admin.workspaceId, key: 'WEB' },
  });
  const stalled = web
    ? await ctx.db.query.task.findFirst({ columns: { id: true }, where: { projectId: web.id, number: 1 } })
    : undefined;
  if (!stalled) throw new Error('WEB-1 not found');
  const since = new Date(Date.now() - STALLED_SEED_HOURS * 3_600_000).toISOString();
  await ctx.db.execute(`update task set updated_at = '${since}' where id = '${stalled.id}'`);
  return member;
}

/** The made-up repository PAY links with `pullRequests`. */
export const REQUESTS_SEED = {
  repository: 'https://github.com/northwind/payments',
  defaultBranch: 'main',
};

type SeedRequest = Parameters<typeof applyRequest>[3];

/** Seed task specs for seedRequests, created in this order after the base PAY tasks. */
interface RequestSeedTask {
  title: string;
  status: TaskStatus;
  priority: Priority;
  assignee: Who;
  /** Created by the agent through the CLI on this branch: the task's work branch. */
  branch?: string;
  criteria?: string[];
  checkAgain?: { inDays: number; reason: string };
}

const REQUEST_TASKS = {
  refundCap: {
    title: 'Reject refunds above the captured amount',
    status: 'in_progress',
    priority: 'high',
    assignee: 'agent',
    branch: 'claude/pay-refund-cap',
    criteria: [
      'A refund above the captured amount fails with 422',
      'Partial refunds never add up to more than the captured amount',
      'The refund form shows the amount left to refund',
    ],
  },
  payoutTimeout: {
    title: 'Add a request timeout to the payout client',
    status: 'in_progress',
    priority: 'medium',
    assignee: 'agent',
    branch: 'claude/pay-payout-timeout',
  },
  payoutsHang: {
    title: 'Payouts hang when the bank API stops answering',
    status: 'todo',
    priority: 'high',
    assignee: 'admin',
  },
  webhookWorker: {
    title: 'Split the webhook dispatcher into its own worker',
    status: 'in_progress',
    priority: 'medium',
    assignee: 'agent',
    branch: 'claude/pay-webhook-worker',
  },
  statementFees: {
    title: 'Show payout fees on the monthly statement',
    status: 'in_progress',
    priority: 'low',
    assignee: 'admin',
  },
  fxCache: {
    title: 'Cache exchange rates for an hour',
    status: 'todo',
    priority: 'medium',
    assignee: 'admin',
  },
  currencyColumn: {
    title: 'Drop the unused currency column from invoices',
    status: 'done',
    priority: 'low',
    assignee: 'admin',
  },
  secondProcessor: {
    title: 'Try a second card processor for EU payments',
    status: 'canceled',
    priority: 'none',
    assignee: null,
  },
  rotateSecret: {
    title: 'Rotate the webhook signing secret',
    status: 'done',
    priority: 'medium',
    assignee: 'agent',
  },
  sftpHost: {
    title: "Switch payouts to the bank's new SFTP host",
    status: 'todo',
    priority: 'medium',
    assignee: 'admin',
    checkAgain: { inDays: 6, reason: 'Waiting for the bank to send the new host and key' },
  },
  payoutTotals: {
    title: "Confirm last month's payout totals with finance",
    status: 'in_progress',
    priority: 'medium',
    assignee: 'admin',
    checkAgain: { inDays: -1, reason: 'Finance said they would answer by yesterday' },
  },
} satisfies Record<string, RequestSeedTask>;

/** How long ago the nightly job's archived task closed: past PAY's 14 days. */
const ARCHIVED_BY_JOB_DAYS = 20;

/**
 * M7 demo data for a new PAY (see SeedOptions.pullRequests). Returns how many tasks it added.
 *
 * - The repository link has checked the repository 20 minutes ago and moves tasks for events
 *   since a month ago, so the requests below act like webhook deliveries. A direct write: only a
 *   real check sets that state. With APP_ENCRYPTION_KEY the link also gets a webhook secret and
 *   a good delivery.
 * - #45 (by branch) opened, then merged into main: its task goes to In review, then Done with two
 *   open criteria (Home's "Merged with open criteria").
 * - #46 (a `Closes:` line) merged: its task goes to Done.
 * - #47 (by branch, and a `Closes:` line for a second task) open: both go to In review.
 * - #48 (by branch) a draft: linked, nothing moves.
 * - #44 closed without merging, linked by hand by the admin.
 * - Archived: a Done task by the admin, a Canceled one by the agent, and a Done task closed 20
 *   days ago by the nightly job (written directly, like the job does, so other projects are left
 *   alone).
 * - Check again: one task waiting (in six days), one ready (yesterday) in the admin's Home.
 */
async function seedRequests(
  ctx: CoreContext,
  admin: Actor,
  agent: Actor,
  { webIsNew }: { webIsNew: boolean },
): Promise<number> {
  const now = Date.now();
  const at = (hoursAgo: number) => new Date(now - hoursAgo * 3_600_000).toISOString();
  const today = todayIn(ctx);

  await updateProject(ctx, admin, { project: 'PAY', repository: REQUESTS_SEED.repository });
  if (webIsNew) await updateProject(ctx, admin, { project: 'WEB', archiveAfterDays: null });

  // Tasks. The agent's tasks with a branch are created the way `zamu tasks create` does from a
  // clone on that branch, which records the work branch.
  const ids = {} as Record<keyof typeof REQUEST_TASKS, { id: string; key: string }>;
  for (const [name, spec] of Object.entries(REQUEST_TASKS) as [
    keyof typeof REQUEST_TASKS,
    RequestSeedTask,
  ][]) {
    const by =
      spec.assignee === 'agent'
        ? spec.branch
          ? { ...agent, source: { machine: 'claude-dev-laptop', branch: spec.branch } }
          : agent
        : admin;
    const created = await createTask(ctx, by, {
      project: 'PAY',
      title: spec.title,
      status: spec.status,
      priority: spec.priority,
      assignee: spec.assignee === 'admin' ? admin.userId : spec.assignee === 'agent' ? agent.userId : null,
      ...(spec.criteria ? { criteria: spec.criteria } : {}),
      ...(spec.checkAgain
        ? {
            checkAgain: {
              on: addCalendarDays(today, spec.checkAgain.inDays),
              reason: spec.checkAgain.reason,
            },
          }
        : {}),
    });
    ids[name] = { id: created.id, key: created.key };
  }
  await updateTask(ctx, agent, { key: ids.refundCap.key, checkCriteria: [1] });

  // The repository link, as after a good check.
  const link = await ctx.db.transaction(async (tx) => {
    const pay = await tx.query.project.findFirst({ where: { workspaceId: admin.workspaceId, key: 'PAY' } });
    if (!pay) throw new Error('PAY not found');
    return ensureRepositoryLink(tx, ctx, pay);
  });
  if (!link) throw new Error('PAY has no repository link');
  if (isEncryptionReady(ctx)) await newRepositoryWebhookSecret(ctx, admin, { project: 'PAY' });
  const movesFrom = at(30 * 24);
  await ctx.db.execute(
    `update repository_link set default_branch = '${REQUESTS_SEED.defaultBranch}', moves_from = '${movesFrom}', ` +
      `synced_at = '${at(1 / 3)}', sync_cursor = '${at(2)}'` +
      (isEncryptionReady(ctx) ? `, webhook_last_at = '${at(2)}', webhook_last_status = 'ok'` : '') +
      ` where id = '${link.id}'`,
  );
  const live = { ...link, defaultBranch: REQUESTS_SEED.defaultBranch, movesFrom: new Date(movesFrom) };

  const request = (
    number: number,
    fields: Omit<SeedRequest, 'number' | 'webUrl' | 'baseBranch' | 'mergedBy' | 'mergedAt' | 'closedAt'> &
      Partial<Pick<SeedRequest, 'mergedBy' | 'mergedAt' | 'closedAt'>>,
  ): SeedRequest => ({
    number,
    baseBranch: REQUESTS_SEED.defaultBranch,
    mergedBy: null,
    mergedAt: null,
    closedAt: null,
    webUrl: `${REQUESTS_SEED.repository}/pull/${number}`,
    ...fields,
  });
  const refundCap = request(45, {
    title: 'Cap refunds at the captured amount',
    body: 'Refunds above what was captured now fail with 422 before they reach the processor.',
    state: 'open',
    headBranch: 'claude/pay-refund-cap',
    author: 'claude-dev',
    openedAt: at(72),
    updatedAt: at(72),
  });
  const events: { request: SeedRequest; hand?: string }[] = [
    { request: refundCap },
    {
      request: {
        ...refundCap,
        state: 'merged',
        mergedBy: 'ana-ruiz',
        mergedAt: at(5),
        closedAt: at(5),
        updatedAt: at(5),
      },
    },
    {
      request: request(46, {
        title: 'Show payout fees on statements',
        body: `Adds a fees line under each payout.\n\nCloses: ${ids.statementFees.key}`,
        state: 'merged',
        headBranch: 'ana/statement-fees',
        author: 'ana-ruiz',
        mergedBy: 'ana-ruiz',
        openedAt: at(50),
        mergedAt: at(26),
        closedAt: at(26),
        updatedAt: at(26),
      }),
    },
    {
      request: request(47, {
        title: 'Time out payout client calls after 10 seconds',
        body:
          'Every call the payout client makes now gives up after 10 seconds and retries once.\n\n' +
          `Closes: ${ids.payoutsHang.key}`,
        state: 'open',
        headBranch: 'claude/pay-payout-timeout',
        author: 'claude-dev',
        openedAt: at(3),
        updatedAt: at(3),
      }),
    },
    {
      request: request(48, {
        title: 'Move webhook dispatch into its own worker',
        body: 'Work in progress: the dispatcher runs, retries are not wired yet.',
        state: 'draft',
        headBranch: 'claude/pay-webhook-worker',
        author: 'claude-dev',
        openedAt: at(2),
        updatedAt: at(2),
      }),
    },
    {
      request: request(44, {
        title: 'Cache exchange rates in memory',
        body: 'Closed: the rates must be shared between instances.',
        state: 'closed',
        headBranch: 'ana/fx-cache',
        author: 'ana-ruiz',
        openedAt: at(96),
        closedAt: at(48),
        updatedAt: at(48),
      }),
      hand: ids.fxCache.id,
    },
  ];
  for (const event of events) {
    await ctx.db.transaction((tx) =>
      applyRequest(tx, ctx, live, event.request, {
        live: true,
        ...(event.hand ? { hand: { taskId: event.hand, actor: admin } } : {}),
      }),
    );
  }

  // Archived by hand: by the admin, and by the agent (agents may archive too).
  await archiveTasks(ctx, admin, { keys: [ids.currencyColumn.key] });
  await archiveTasks(ctx, agent, { keys: [ids.secondProcessor.key] });

  // Archived by the nightly job: closed 20 days ago, archived with no actor and the archive cause.
  const job = ids.rotateSecret.id;
  await ctx.db.execute(
    `update task set closed_at = '${at(ARCHIVED_BY_JOB_DAYS * 24)}', archived_at = '${at(3)}', ` +
      `archived_by_id = null where id = '${job}'`,
  );
  await ctx.db.transaction((tx) =>
    recordActivities(tx, null, [
      {
        workspaceId: admin.workspaceId,
        projectId: link.projectId,
        taskId: job,
        type: 'task.archived',
        changes: [],
        origin: 'app',
        cause: { kind: 'archive', afterDays: DEFAULT_ARCHIVE_AFTER_DAYS },
      },
    ]),
  );
  return Object.keys(REQUEST_TASKS).length;
}

/** A task of a seed wave: title, status and who works on it. Priority medium unless set. */
interface WaveSeedTask {
  title: string;
  status: TaskStatus;
  assignee: Who;
  priority?: Priority;
}

/** A gate result the seed records, `hoursAgo` back from now. */
interface GateSeedResult {
  state: 'passed' | 'failed';
  by: 'admin' | 'agent';
  note: string;
  hoursAgo: number;
}

interface WaveSeed {
  name: string;
  gate: string;
  tasks: WaveSeedTask[];
  /** In the order they were recorded; the last one is the gate's state. */
  results?: GateSeedResult[];
}

interface MilestoneSeed {
  name: string;
  /** The git branch the agent's gate results come from, as the CLI sends it. */
  branch: string;
  description: string;
  targetInDays: number | null;
  planUrl: string | null;
  waves: WaveSeed[];
  notInWave: WaveSeedTask[];
}

const done = (title: string, assignee: Who = 'agent'): WaveSeedTask => ({ title, status: 'done', assignee });

/**
 * "Refunds rework" W8 has a task per currency (22 done, 2 in progress, 3 to do) and the three fixes
 * its failed gate logged: 30 tasks.
 */
const REFUND_CURRENCIES = [
  'EUR',
  'USD',
  'GBP',
  'JPY',
  'CHF',
  'SEK',
  'NOK',
  'DKK',
  'PLN',
  'CZK',
  'HUF',
  'RON',
  'BGN',
  'AUD',
  'NZD',
  'CAD',
  'MXN',
  'BRL',
  'SGD',
  'HKD',
  'KRW',
  'INR',
  'ZAR',
  'AED',
  'TRY',
  'THB',
  'IDR',
];

const LONG_GATE_NOTE = `Failed on the currency suite. 27 of 30 currencies pass; three do not.

**What was checked**

- The partial refund suite against the staging processor, every currency in this wave.
- Rounding at the minor unit for refunds split across up to 12 line items.
- The refund webhook payloads against the v2 schema.

**What failed**

1. JPY and KRW have no minor unit. The refund total is divided by 100 a second time, so a
   ¥1,200 refund goes out as ¥12. The processor accepts it, which is why nothing alerted.
2. HUF rounds to whole forint for cash but not for cards. Our rounding treats both as cash and
   loses up to 0.49 Ft per line item.
3. Two IDR refunds timed out at the processor after 30 seconds. They went through on retry, but
   the webhook arrived before our row was written and was dropped.

**Next**

The three fixes are tasks in this wave. Record the gate again once they are done and the suite
passes in full. W9 stays locked until then.`;

const WAVE_MILESTONES: MilestoneSeed[] = [
  {
    name: 'Payouts v2',
    branch: 'claude/payouts-v2',
    description:
      'Payouts on the new ledger: scheduled runs, per-merchant limits and a payout history merchants can read.',
    targetInDays: 30,
    planUrl: 'plans/payouts-v2.html',
    waves: [
      {
        name: 'Data and contracts',
        gate: "Migrations apply on a fresh database and on a copy of last week's data. Contract tests pass.",
        tasks: [
          done('Add the payout_run and payout_item tables'),
          done('Payout contracts and error codes', 'admin'),
          done('Backfill payout history from the old ledger'),
        ],
        results: [
          {
            state: 'passed',
            by: 'agent',
            note:
              "Ran the migrations on a fresh database and on the copy of last week's data (1.2 million payouts, " +
              '41 seconds). Contract tests: 212 passed.',
            hoursAgo: 96,
          },
        ],
      },
      {
        name: 'Core and API',
        gate: 'Core and API tests pass against Postgres. GET /payouts answers in under 200 ms for 1,000 payouts.',
        tasks: [
          done('Schedule payout runs per merchant'),
          done('Enforce per-merchant payout limits'),
          done('Payout routes in the API', 'admin'),
          done('Load payout items in one query'),
        ],
        results: [
          {
            state: 'failed',
            by: 'agent',
            note: 'GET /payouts takes 640 ms for 1,000 payouts: one query per payout for its items. Logged the fix in this wave.',
            hoursAgo: 60,
          },
          {
            state: 'passed',
            by: 'admin',
            note: 'Items load in one query now. GET /payouts answers in 120 ms for 1,000 payouts. Core and API tests pass.',
            hoursAgo: 30,
          },
        ],
      },
      {
        name: 'Screens',
        gate: 'Every payout screen works in light and dark at 1440, 1280 and 1024, with no hydration warnings.',
        tasks: [
          done('Payout list screen'),
          done('Payout detail with its items'),
          done('Limits in the merchant settings', 'admin'),
          done('Empty and error states for payouts'),
          { title: 'Payout history export as CSV', status: 'in_progress', assignee: 'agent' },
          { title: 'Keyboard shortcuts on the payout list', status: 'todo', assignee: null },
        ],
      },
      {
        name: 'End-to-end tests',
        gate: 'The payout specs pass against the Docker Compose stack, upgrade spec included.',
        tasks: [
          { title: 'End-to-end spec for a scheduled payout run', status: 'todo', assignee: 'agent' },
          { title: 'End-to-end spec for payout limits', status: 'todo', assignee: 'agent' },
          { title: 'Upgrade spec with payouts from the old ledger', status: 'backlog', assignee: null },
        ],
      },
      {
        name: 'Release',
        gate: 'Release notes are written, the migration ran on a backup of production, and the release is tagged.',
        tasks: [
          { title: 'Release notes for payouts v2', status: 'backlog', assignee: null },
          { title: 'Check the migration on a production backup', status: 'backlog', assignee: 'admin' },
        ],
      },
    ],
    notInWave: [
      { title: 'Decide how payout fees show for EU accounts', status: 'todo', assignee: null },
      { title: 'Announce payouts v2 to merchants', status: 'backlog', assignee: null },
    ],
  },
  {
    name: 'Statements export',
    branch: 'claude/statements-export',
    description: 'Monthly statements in the formats banks import.',
    targetInDays: 9,
    planUrl: 'plans/statements-export.md',
    waves: [
      {
        name: 'Exporter',
        gate: 'The exporter writes a statement for every merchant in the staging data.',
        tasks: [done('Statement exporter job'), done('Store statements for 13 months', 'admin')],
        results: [
          {
            state: 'passed',
            by: 'admin',
            note: 'Exported statements for all 1,840 staging merchants in 6 minutes.',
            hoursAgo: 50,
          },
        ],
      },
      {
        name: 'Bank formats',
        gate: 'CAMT.053 and MT940 files pass the validators of both partner banks.',
        tasks: [
          done('CAMT.053 statements'),
          done('MT940 statements'),
          { title: 'Fix the CAMT.053 booking date for weekend payouts', status: 'todo', assignee: 'agent' },
        ],
        results: [
          {
            state: 'failed',
            by: 'agent',
            note:
              'MT940 passes both validators. CAMT.053 fails at the second bank: payouts made on a Saturday carry ' +
              'the Saturday as booking date, and the bank expects the next business day. Logged the fix in this wave.',
            hoursAgo: 4,
          },
        ],
      },
      {
        name: 'Rollout',
        gate: 'Ten merchants imported a statement into their bank without help.',
        tasks: [
          { title: 'Turn statements on for the first ten merchants', status: 'todo', assignee: 'admin' },
        ],
      },
    ],
    notInWave: [],
  },
  {
    name: 'Card vault migration',
    branch: 'claude/card-vault',
    description: 'Move stored cards to the new vault without a failed charge.',
    targetInDays: null,
    planUrl: 'https://wiki.northwind.dev/plans/card-vault',
    waves: [
      {
        name: 'Dual writes',
        gate: 'Every new card lands in both vaults for a week.',
        tasks: [done('Write new cards to both vaults'), done('Compare the vaults every night')],
        results: [{ state: 'passed', by: 'agent', note: 'Seven nights, 0 differences.', hoursAgo: 400 }],
      },
      {
        name: 'Backfill',
        gate: 'Every stored card is in the new vault and the nightly comparison is clean.',
        tasks: [done('Backfill stored cards', 'admin'), done('Retry cards the backfill skipped')],
        results: [
          {
            state: 'passed',
            by: 'admin',
            note: '2.3 million cards copied; 112 retried and copied. The nightly comparison is clean.',
            hoursAgo: 300,
          },
        ],
      },
      {
        name: 'Read switch',
        gate: 'Charges read from the new vault for a week with no rise in declines.',
        tasks: [done('Read cards from the new vault'), done('Alert on declines by vault')],
        results: [
          { state: 'passed', by: 'agent', note: 'Declines stayed at 1.8% for seven days.', hoursAgo: 150 },
        ],
      },
      {
        name: 'Cleanup',
        gate: 'The old vault is read-only and nothing has read from it for a week.',
        tasks: [done('Make the old vault read-only', 'admin'), done('Remove the dual writes')],
        results: [
          {
            state: 'passed',
            by: 'admin',
            note: 'No reads on the old vault since the switch. Its keys are revoked.',
            hoursAgo: 20,
          },
        ],
      },
    ],
    notInWave: [{ title: 'Delete the old vault after the audit', status: 'todo', assignee: 'admin' }],
  },
  {
    name: 'Refunds rework',
    branch: 'claude/refunds-rework',
    description: 'Refunds on the new ledger, one wave per refund type.',
    targetInDays: 60,
    planUrl: 'https://wiki.northwind.dev/plans/refunds',
    waves: [
      ...[
        'Ledger entries',
        'Full refunds',
        'Refund reasons',
        'Refund limits',
        'Disputes',
        'Refund emails',
        'Refund webhooks',
      ].map(
        (name, index): WaveSeed => ({
          name,
          gate: `The ${name.toLowerCase()} suite passes against the staging processor.`,
          tasks: [done(`${name}: core`), done(`${name}: API`, index % 2 === 0 ? 'agent' : 'admin')],
          results: [
            {
              state: 'passed',
              by: index % 2 === 0 ? 'agent' : 'admin',
              note: `Ran the ${name.toLowerCase()} suite against the staging processor: all green.`,
              hoursAgo: 24 * (14 - index),
            },
          ],
        }),
      ),
      {
        name: 'Partial refunds',
        gate: 'Partial refunds in every supported currency round correctly at the minor unit.',
        tasks: [
          ...REFUND_CURRENCIES.map(
            (currency, index): WaveSeedTask => ({
              title: `Partial refunds in ${currency}`,
              status: index < 22 ? 'done' : index < 24 ? 'in_progress' : 'todo',
              assignee: index < 24 ? 'agent' : null,
            }),
          ),
          {
            title: 'Stop dividing JPY and KRW refunds by 100',
            status: 'todo',
            assignee: 'agent',
            priority: 'urgent',
          },
          {
            title: 'Round HUF card refunds to the fillér',
            status: 'todo',
            assignee: 'agent',
            priority: 'high',
          },
          {
            title: 'Write the refund row before calling the processor',
            status: 'todo',
            assignee: 'agent',
            priority: 'high',
          },
        ],
        results: [{ state: 'failed', by: 'agent', note: LONG_GATE_NOTE, hoursAgo: 6 }],
      },
      ...[
        ['Refund reports', 'Refunds in the monthly report'],
        ['Merchant settings', 'Refund settings for merchants'],
        ['Migration', 'Move open refunds to the new ledger'],
        ['Release', 'Release notes for the refunds rework'],
      ].map(
        ([name, title]): WaveSeed => ({
          name: name as string,
          gate: 'The checks for this wave in the plan pass.',
          tasks: [{ title: title as string, status: 'todo', assignee: null }],
        }),
      ),
    ],
    notInWave: [],
  },
];

/**
 * M8 demo data for a new PAY (see SeedOptions.waves): the milestones of WAVE_MILESTONES with their
 * waves, tasks and gate results. Tasks are created first, then put in their waves, then the gates
 * are recorded, as a planning agent would. Each result's time is moved back afterwards (a direct
 * write: only the clock sets it), so the page reads like a plan that ran for days. Returns how many
 * tasks it added.
 */
async function seedWaves(ctx: CoreContext, admin: Actor, agent: Actor): Promise<number> {
  const today = todayIn(ctx);
  const now = Date.now();
  let added = 0;
  for (const spec of WAVE_MILESTONES) {
    const created = await createMilestone(ctx, admin, {
      project: 'PAY',
      name: spec.name,
      description: spec.description,
      targetDate: spec.targetInDays === null ? null : addCalendarDays(today, spec.targetInDays),
    });
    // Work has started on every one of them; a milestone whose tasks were only created as Done would
    // otherwise stay Planned (only a task start activates it).
    await updateMilestone(ctx, admin, {
      id: created.id,
      status: 'active',
      ...(spec.planUrl ? { planUrl: spec.planUrl } : {}),
    });

    const newTask = async (task: WaveSeedTask) => {
      const row = await createTask(ctx, task.assignee === 'agent' ? agent : admin, {
        project: 'PAY',
        title: task.title,
        status: task.status,
        priority: task.priority ?? 'medium',
        milestone: created.id,
        assignee: task.assignee === 'admin' ? admin.userId : task.assignee === 'agent' ? agent.userId : null,
      });
      added++;
      return row.key;
    };

    const waves: { id: string; spec: WaveSeed }[] = [];
    for (const wave of spec.waves) {
      const row = await createWave(ctx, admin, {
        milestone: created.id,
        name: wave.name,
        gateDescription: wave.gate,
      });
      waves.push({ id: row.id, spec: wave });
    }
    for (const { id, spec: wave } of waves) {
      const keys: string[] = [];
      for (const task of wave.tasks) keys.push(await newTask(task));
      await putTasksInWave(ctx, admin, { milestone: created.id, wave: id, keys });
    }
    for (const task of spec.notInWave) await newTask(task);

    const fromCli: Actor = { ...agent, source: { machine: 'claude-dev-laptop', branch: spec.branch } };
    for (const { id, spec: wave } of waves) {
      for (const result of wave.results ?? []) {
        await recordGateResult(ctx, result.by === 'agent' ? fromCli : admin, {
          id,
          state: result.state,
          note: result.note,
        });
        const at = new Date(now - result.hoursAgo * 3_600_000).toISOString();
        await ctx.db.execute(
          `update gate_result set created_at = '${at}' where id = (select id from gate_result ` +
            `where wave_id = '${id}' order by created_at desc limit 1)`,
        );
      }
    }
  }
  return added;
}
