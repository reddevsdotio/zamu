// Isolation between workspaces (PM-42). Two workspaces, Acme and Globex, each with a project PAY
// whose tasks are PAY-1 and PAY-2, a person who belongs to both, and an agent in each. Every service
// that takes a key, an id or a name is called as Acme's actors with Globex's keys, ids and names:
// reads must never return Globex rows, writes must never change them. Globex text carries a marker
// and Globex ids are collected, so any leak shows in the serialised results; the last test compares
// every Globex row with a snapshot taken before the calls.
import { randomBytes } from 'node:crypto';
import { schema } from '@zamu/db';
import { signWebhook } from '@zamu/git-providers';
import { eq, inArray, or } from 'drizzle-orm';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { listTaskActivity } from './activity';
import { createApiKey, issueApiKey, listApiKeys, revokeApiKey } from './api-keys';
import { archivePreview, archiveTasks, restoreTasks } from './archive';
import type { Actor } from './authz';
import { recordingJobQueue } from './backlog/testing';
import { createComment, deleteComment, listComments, updateComment } from './comments';
import { createCycle, endCycle, getCycle, listCycles, updateCycle } from './cycles';
import { getDashboard, getDashboardCounts } from './dashboard';
import { isCoreError } from './errors';
import {
  deleteConnection,
  type GitConnectionContext,
  getConnection,
  listConnections,
  testConnection,
  updateConnection,
} from './git-connections';
import { getHome, getHomeCounts } from './home';
import { cancelInvitation, createInvitation, listInvitations } from './invitations';
import { createLabel, deleteLabel, listLabels, updateLabel } from './labels';
import { getMe } from './me';
import { createAgent, getMember, listMembers, removeMember } from './members';
import { resolveMentions } from './mentions';
import {
  createMilestone,
  deleteMilestone,
  getMilestone,
  listMilestones,
  updateMilestone,
} from './milestones';
import { createProject, deleteProject, listProjects, updateProject } from './projects';
import {
  handleRepositoryEvent,
  linkPullRequest,
  RequestNotFound,
  RequestOtherRepository,
  receiveRepositoryWebhook,
  unlinkPullRequest,
} from './pull-requests';
import {
  getRepositorySettings,
  newRepositoryWebhookSecret,
  pollRepositories,
  syncRepositoryNow,
  updateRepositorySettings,
} from './repository';
import { loadEncryptionKey } from './secrets';
import { bulkUpdateTasks, createTask, getTask, listTasks, setStatusFromSource, updateTask } from './tasks';
import {
  addMember,
  createPullRequestRow,
  createRepositoryLinkRow,
  createUser,
  createWorld,
  isoDate,
  linkPullRequestRow,
  randomWorkspaceSlug,
  scopeOf,
  type TestContext,
  testContext,
  type World,
} from './testing/fixtures';
import { FakeRequestHost, fakeRequestFactory, requestInfo } from './testing/requests';
import { listTaskTimeline } from './timeline';
import {
  createWave,
  deleteWave,
  getMilestonePlan,
  putTasksInWave,
  recordGateResult,
  updateWave,
} from './waves';
import { getWorkspaceContents, updateWorkspace } from './workspaces';

/** In every Globex title, name and body; never in what Acme's actors get back. */
const MARK = 'globexsecret';

describe('workspace isolation', () => {
  let ctx: TestContext;
  let gitCtx: GitConnectionContext;
  let acme: World;
  let globex: World;
  /** The person in both workspaces, as a session actor in each. */
  let patA: Actor;
  let patG: Actor;
  let pat: { id: string; email: string };
  let acmePay: { id: string };
  let globexPay: { id: string };
  const globexIds = new Set<string>();
  const ids: Record<string, string> = {};
  let snapshot: unknown;

  /** Fails when `value` carries the Globex marker or any Globex id. */
  function expectNoLeak(value: unknown) {
    const text = JSON.stringify(value) ?? '';
    expect(text).not.toContain(MARK);
    for (const id of globexIds) expect(text, `leaks ${id}`).not.toContain(id);
  }

  /** The call fails with a core error (not found, invalid, forbidden) that names nothing of Globex. */
  async function expectRefused(promise: Promise<unknown>) {
    const error = await promise.then(
      (value) => ({ resolved: value }),
      (e: unknown) => e,
    );
    expect(isCoreError(error), `expected a refusal, got ${JSON.stringify(error)}`).toBe(true);
    expectNoLeak({ message: (error as Error).message, issues: (error as { issues?: unknown }).issues });
    return error as Error;
  }

  /** A list call that either finds nothing or refuses the Globex id. */
  async function expectEmptyOrRefused(promise: Promise<{ items: unknown[] }>) {
    const result = await promise.then(
      (value) => value,
      (e: unknown) => e,
    );
    if (isCoreError(result)) expectNoLeak({ message: result.message, issues: result.issues });
    else expect((result as { items: unknown[] }).items).toEqual([]);
  }

  /**
   * Rows in a fixed order, so the comparison does not depend on where Postgres put an updated
   * tuple: by id when the table has one, else by the whole row.
   */
  function sorted<T extends Record<string, unknown>>(rows: T[]): T[] {
    const keyOf = (row: T) => (typeof row.id === 'string' ? row.id : JSON.stringify(row));
    return [...rows].sort((a, b) => (keyOf(a) < keyOf(b) ? -1 : keyOf(a) > keyOf(b) ? 1 : 0));
  }

  /** Every Globex row the calls could touch, for the final comparison. */
  async function globexRows() {
    const ws = globex.workspaceId;
    const taskIds = (
      await ctx.db
        .select({ id: schema.task.id })
        .from(schema.task)
        .where(eq(schema.task.projectId, globexPay.id))
    ).map((row) => row.id);
    const rows = {
      organization: await ctx.db.select().from(schema.organization).where(eq(schema.organization.id, ws)),
      member: await ctx.db.select().from(schema.member).where(eq(schema.member.organizationId, ws)),
      project: await ctx.db.select().from(schema.project).where(eq(schema.project.workspaceId, ws)),
      task: await ctx.db.select().from(schema.task).where(inArray(schema.task.id, taskIds)),
      taskItem: await ctx.db.select().from(schema.taskItem).where(inArray(schema.taskItem.taskId, taskIds)),
      taskLabel: await ctx.db
        .select()
        .from(schema.taskLabel)
        .where(inArray(schema.taskLabel.taskId, taskIds)),
      taskDependency: await ctx.db
        .select()
        .from(schema.taskDependency)
        .where(
          or(
            inArray(schema.taskDependency.taskId, taskIds),
            inArray(schema.taskDependency.blockerId, taskIds),
          ),
        ),
      label: await ctx.db.select().from(schema.label).where(eq(schema.label.workspaceId, ws)),
      milestone: await ctx.db.select().from(schema.milestone).where(eq(schema.milestone.workspaceId, ws)),
      cycle: await ctx.db.select().from(schema.cycle).where(eq(schema.cycle.workspaceId, ws)),
      comment: await ctx.db.select().from(schema.comment).where(eq(schema.comment.workspaceId, ws)),
      activity: await ctx.db.select().from(schema.activity).where(eq(schema.activity.workspaceId, ws)),
      gitConnection: await ctx.db
        .select()
        .from(schema.gitConnection)
        .where(eq(schema.gitConnection.workspaceId, ws)),
      invitation: await ctx.db
        .select()
        .from(schema.invitation)
        .where(eq(schema.invitation.organizationId, ws)),
      apikey: await ctx.db
        .select({ id: schema.apikey.id, enabled: schema.apikey.enabled, metadata: schema.apikey.metadata })
        .from(schema.apikey)
        .where(eq(schema.apikey.id, ids.globexKey as string)),
      repositoryLink: await ctx.db
        .select()
        .from(schema.repositoryLink)
        .where(eq(schema.repositoryLink.workspaceId, ws)),
      pullRequest: await ctx.db
        .select()
        .from(schema.pullRequest)
        .where(eq(schema.pullRequest.workspaceId, ws)),
      taskPullRequest: await ctx.db
        .select()
        .from(schema.taskPullRequest)
        .where(inArray(schema.taskPullRequest.taskId, taskIds)),
      wave: await ctx.db.select().from(schema.wave).where(eq(schema.wave.workspaceId, ws)),
      gateResult: await ctx.db.select().from(schema.gateResult).where(eq(schema.gateResult.workspaceId, ws)),
    };
    return Object.fromEntries(
      Object.entries(rows).map(([table, list]) => [table, sorted(list as Record<string, unknown>[])]),
    );
  }

  beforeAll(async () => {
    ctx = testContext();
    gitCtx = { ...ctx, encryptionKey: loadEncryptionKey(randomBytes(32).toString('base64')) };
    acme = await createWorld(ctx.db, 'Acme', { slug: randomWorkspaceSlug('acme') });
    globex = await createWorld(ctx.db, `Globex ${MARK}`, { slug: randomWorkspaceSlug('globex') });
    const person = await createUser(ctx.db, { name: 'Pat Two-Hats' });
    pat = { id: person.id, email: person.email };
    patA = await addMember(ctx.db, acme.workspaceId, person);
    patG = await addMember(ctx.db, globex.workspaceId, person, 'admin');

    acmePay = await createProject(ctx, acme.ownerActor, { name: 'Payments', key: 'PAY' });
    globexPay = await createProject(ctx, globex.ownerActor, { name: `Payments ${MARK}`, key: 'PAY' });
    await createTask(ctx, acme.memberActor, { project: 'PAY', title: 'Acme one' });
    await createTask(ctx, acme.memberActor, { project: 'PAY', title: 'Acme two' });
    await createComment(ctx, acme.memberActor, { key: 'PAY-1', body: 'Acme comment' });

    // Globex: tasks with every relation, assigned to and mentioning Pat, so Pat's Globex queues fill.
    const label = await createLabel(ctx, globex.ownerActor, { project: 'PAY', name: `${MARK}-label` });
    const milestone = await createMilestone(ctx, globex.ownerActor, { project: 'PAY', name: `${MARK} ms` });
    const cycle = await createCycle(ctx, globex.ownerActor, { project: 'PAY', name: `${MARK} cycle` });
    const one = await createTask(ctx, globex.agentActor, {
      project: 'PAY',
      title: `${MARK} one`,
      assignee: pat.id,
      labels: [`${MARK}-label`],
      milestone: milestone.id,
      cycle: cycle.number,
      criteria: [`${MARK} criterion`],
      dueDate: isoDate(-2),
    });
    const two = await createTask(ctx, globex.agentActor, {
      project: 'PAY',
      title: `${MARK} two`,
      assignee: pat.id,
      parent: one.key,
      blockedBy: [one.key],
    });
    await updateTask(ctx, globex.ownerActor, { key: one.key, status: 'in_review' });
    const agentComment = await createComment(ctx, globex.agentActor, {
      key: one.key,
      body: `${MARK} [@Pat](mention:${pat.id}) please look`,
    });
    const patComment = await createComment(ctx, patG, { key: one.key, body: `${MARK} by Pat` });
    const [connection] = await ctx.db
      .insert(schema.gitConnection)
      .values({
        workspaceId: globex.workspaceId,
        name: `${MARK} connection`,
        provider: 'gitlab',
        host: 'gitlab.com',
        apiBaseUrl: 'https://gitlab.com/api/v4',
        tokenCiphertext: 'v1:not-a-real-token',
        tokenHint: 'xyz',
        createdById: globex.owner.id,
      })
      .returning();
    const invitation = await createInvitation(ctx, globex.ownerActor, {
      email: `${MARK}@example.com`,
      role: 'member',
    });
    // invitations.test.ts expires every pending invitation with a clock a week ahead, on the same
    // database and possibly at the same time; a later expiry keeps this one out of that job's reach.
    await ctx.db
      .update(schema.invitation)
      .set({ expiresAt: new Date(Date.now() + 365 * 86_400_000) })
      .where(eq(schema.invitation.id, invitation.id));
    const globexKey = await issueApiKey(ctx, globex.workspaceId, pat.id, `${MARK} key`, {
      projects: 'all',
      access: 'write',
    });

    // M7: a request linked to PAY-1, a ready check-again day on it, a task merged with an open
    // criterion (PAY-3) and an archived task (PAY-4), so Pat's Globex Home has both new groups.
    const globexScope = scopeOf({ id: globexPay.id, workspaceId: globex.workspaceId });
    await createRepositoryLinkRow(ctx.db, globexScope, { repositoryKey: `github.com/${MARK}/payments` });
    const request = await createPullRequestRow(ctx.db, globexScope, {
      number: 482,
      title: `${MARK} request`,
      webUrl: `https://github.com/${MARK}/payments/pull/482`,
    });
    await linkPullRequestRow(ctx.db, one.id, request.id);
    await updateTask(ctx, globex.ownerActor, {
      key: one.key,
      checkAgain: { on: isoDate(-1), reason: `${MARK} reason` },
    });
    const three = await createTask(ctx, globex.agentActor, {
      project: 'PAY',
      title: `${MARK} three`,
      status: 'done',
      criteria: [`${MARK} open criterion`],
    });
    await ctx.db.update(schema.task).set({ mergedDoneAt: new Date() }).where(eq(schema.task.id, three.id));
    await linkPullRequestRow(ctx.db, three.id, request.id, { viaDescription: true });
    const four = await createTask(ctx, globex.ownerActor, {
      project: 'PAY',
      title: `${MARK} four`,
      assignee: pat.id,
    });
    await archiveTasks(ctx, globex.ownerActor, { keys: [four.key] });

    // M8: a plan link, two waves with PAY-1 in the first and a recorded gate result.
    await updateMilestone(ctx, globex.ownerActor, { id: milestone.id, planUrl: `plans/${MARK}.html` });
    const wave = await createWave(ctx, globex.ownerActor, {
      milestone: milestone.id,
      name: `${MARK} wave`,
      gateDescription: `${MARK} gate`,
    });
    const lockedWave = await createWave(ctx, globex.ownerActor, {
      milestone: milestone.id,
      name: `${MARK} next`,
    });
    await putTasksInWave(ctx, globex.ownerActor, { milestone: milestone.id, wave: wave.id, keys: [one.key] });
    await recordGateResult(ctx, globex.agentActor, { id: wave.id, state: 'failed', note: `${MARK} note` });

    Object.assign(ids, {
      label: label.id,
      milestone: milestone.id,
      one: one.id,
      two: two.id,
      agentComment: agentComment.id,
      patComment: patComment.id,
      connection: connection?.id,
      invitation: invitation.id,
      globexKey: globexKey.id,
      request: request.id,
      three: three.id,
      four: four.id,
      wave: wave.id,
      lockedWave: lockedWave.id,
    });
    for (const id of [
      ...Object.values(ids),
      globex.workspaceId,
      globexPay.id,
      cycle.id,
      globex.owner.id,
      globex.member.id,
      globex.agent.id,
    ]) {
      globexIds.add(id);
    }
    snapshot = await globexRows();
  });
  afterAll(async () => {
    await ctx?.close();
  });

  it('proves the Globex data would show up for Pat in Globex', async () => {
    expect((await getHomeCounts(ctx, patG)).total).toBeGreaterThan(0);
    expect((await getDashboardCounts(ctx, patG)).total).toBeGreaterThan(0);
    expect((await getTask(ctx, patG, { key: 'PAY-1' })).title).toBe(`${MARK} one`);
  });

  it('projects: lists and changes only Acme PAY', async () => {
    const list = await listProjects(ctx, patA);
    expect(list.items.map((p) => p.id)).toEqual([acmePay.id]);
    expectNoLeak(list);
    expectNoLeak(await updateProject(ctx, acme.ownerActor, { project: 'PAY', description: 'Acme only' }));
    // A project key Globex alone has is not found.
    await createProject(ctx, globex.ownerActor, { name: `Only ${MARK}`, key: 'GLX' });
    await expectRefused(updateProject(ctx, acme.ownerActor, { project: 'GLX', name: 'Taken over' }));
    await expectRefused(deleteProject(ctx, acme.ownerActor, { project: 'GLX', confirmKey: 'GLX' }));
    await expectRefused(createTask(ctx, patA, { project: 'GLX', title: 'Into Globex' }));
    await deleteProject(ctx, globex.ownerActor, { project: 'GLX', confirmKey: 'GLX' });
  });

  it('tasks: keys, filters and fields resolve in Acme only', async () => {
    const task = await getTask(ctx, patA, { key: 'PAY-1' });
    expect(task.title).toBe('Acme one');
    expectNoLeak(task);
    expectNoLeak(await listTasks(ctx, patA, {}));
    expectNoLeak(await listTasks(ctx, patA, { q: MARK }));
    expect((await listTasks(ctx, patA, { label: ids.label })).items).toEqual([]);
    expect((await listTasks(ctx, patA, { assignee: globex.member.id })).items).toEqual([]);
    expect((await listTasks(ctx, patA, { assignee: 'me' })).items).toEqual([]);
    await expectEmptyOrRefused(listTasks(ctx, patA, { milestone: ids.milestone }));
    await expectRefused(getTask(ctx, patA, { key: 'PAY-3' }));

    await expectRefused(createTask(ctx, patA, { project: 'PAY', title: 'x', assignee: globex.member.id }));
    await expectRefused(createTask(ctx, patA, { project: 'PAY', title: 'x', milestone: ids.milestone }));
    await expectRefused(updateTask(ctx, patA, { key: 'PAY-1', assignee: globex.agent.id }));
    await expectRefused(updateTask(ctx, patA, { key: 'PAY-1', milestone: ids.milestone }));
    await expectRefused(updateTask(ctx, patA, { key: 'PAY-1', cycle: 1 }));

    // Blockers and parents by key are Acme's PAY-2, labels by name are Acme's own.
    const linked = await updateTask(ctx, patA, {
      key: 'PAY-1',
      addBlockers: ['PAY-2'],
      addLabels: [`${MARK}-label`.replace(MARK, 'acme')],
    });
    expect(linked.blockedBy?.map((b) => b?.title)).toEqual(['Acme two']);
    expectNoLeak(linked);
    expectNoLeak(await updateTask(ctx, patA, { key: 'PAY-2', parent: 'PAY-1' }));
    expectNoLeak(await bulkUpdateTasks(ctx, patA, { keys: ['PAY-1', 'PAY-2'], priority: 'high' }));
    expectNoLeak(await createTask(ctx, acme.agentActor, { project: 'PAY', title: 'Acme three' }));
  });

  it('comments and mentions: Globex comments and people are out of reach', async () => {
    expectNoLeak(await listComments(ctx, patA, { key: 'PAY-1' }));
    // Pat wrote patComment, but in Globex.
    await expectRefused(updateComment(ctx, patA, { id: ids.patComment as string, body: 'edited' }));
    await expectRefused(deleteComment(ctx, patA, { id: ids.patComment as string }));
    await expectRefused(deleteComment(ctx, acme.ownerActor, { id: ids.agentComment as string }));

    const body =
      `@${globex.agent.name} @${globex.member.email} [@Tomás](mention:${globex.member.id}) ` +
      `[@Pat](mention:${pat.id})`;
    const resolved = await resolveMentions(ctx.db, acme.workspaceId, body);
    expect(resolved.userIds).toEqual([pat.id]);
    expectNoLeak(resolved);
    const comment = await createComment(ctx, patA, { key: 'PAY-1', body });
    expect(comment.mentions.map((m) => m.id)).toEqual([pat.id]);
    expectNoLeak(comment);
  });

  it('labels, milestones and cycles: Globex ids are not found', async () => {
    expectNoLeak(await listLabels(ctx, patA, { project: 'PAY' }));
    await expectRefused(updateLabel(ctx, patA, { project: 'PAY', id: ids.label as string, name: 'mine' }));
    await expectRefused(deleteLabel(ctx, patA, { project: 'PAY', id: ids.label as string }));

    expectNoLeak(await listMilestones(ctx, patA, { project: 'PAY' }));
    await expectRefused(getMilestone(ctx, patA, { id: ids.milestone as string }));
    await expectRefused(updateMilestone(ctx, patA, { id: ids.milestone as string, name: 'mine' }));
    await expectRefused(deleteMilestone(ctx, patA, { id: ids.milestone as string }));

    expectNoLeak(await listCycles(ctx, patA, { project: 'PAY' }));
    await expectRefused(getCycle(ctx, patA, { project: 'PAY', number: 1 }));
    await expectRefused(updateCycle(ctx, patA, { project: 'PAY', number: 1, name: 'mine' }));
    await expectRefused(endCycle(ctx, patA, { project: 'PAY', number: 1 }));
    await expectRefused(getCycle(ctx, patA, { project: 'PAY', number: 'current' }));
  });

  it('waves, gates and the plan: Globex waves and milestones are out of reach', async () => {
    const wave = ids.wave as string;
    const milestone = ids.milestone as string;
    await expectRefused(getMilestonePlan(ctx, patA, { id: milestone }));
    await expectRefused(createWave(ctx, patA, { milestone, name: 'Into Globex' }));
    await expectRefused(updateWave(ctx, patA, { id: wave, name: 'mine' }));
    await expectRefused(updateWave(ctx, acme.ownerActor, { id: ids.lockedWave as string, position: 1 }));
    await expectRefused(deleteWave(ctx, acme.ownerActor, { id: wave }));
    await expectRefused(recordGateResult(ctx, acme.agentActor, { id: wave, state: 'passed', note: 'mine' }));
    await expectRefused(putTasksInWave(ctx, patA, { milestone, wave, keys: ['PAY-1'] }));
    await expectRefused(updateMilestone(ctx, patA, { id: milestone, planUrl: 'plans/mine.html' }));
    // Acme's PAY-1 cannot join a Globex wave, by update or on create.
    await expectRefused(updateTask(ctx, patA, { key: 'PAY-1', wave }));
    await expectRefused(createTask(ctx, patA, { project: 'PAY', title: 'x', wave }));
    // Acme's own plan, with Pat's Acme waves, shows nothing of Globex.
    const acmeMilestone = await createMilestone(ctx, acme.ownerActor, { project: 'PAY', name: 'Acme plan' });
    const acmeWave = await createWave(ctx, patA, { milestone: acmeMilestone.id, name: 'Acme wave' });
    expectNoLeak(
      await putTasksInWave(ctx, patA, { milestone: acmeMilestone.id, wave: acmeWave.id, keys: ['PAY-1'] }),
    );
    expectNoLeak(await recordGateResult(ctx, patA, { id: acmeWave.id, state: 'failed', note: 'Acme note' }));
    expectNoLeak(await getMilestonePlan(ctx, patA, { id: acmeMilestone.id }));
    expectNoLeak(await getTask(ctx, patA, { key: 'PAY-1' }));
    expectNoLeak(await listTasks(ctx, patA, {}));
    expectNoLeak(await listMilestones(ctx, patA, { project: 'PAY' }));
    // Pat sees the Globex plan in Globex.
    const globexPlan = await getMilestonePlan(ctx, patG, { id: milestone });
    expect(globexPlan.planUrl).toBe(`plans/${MARK}.html`);
    expect(globexPlan.waves.map((w) => w.id)).toEqual([wave, ids.lockedWave]);
  });

  it('members, invitations and API keys stay in Acme', async () => {
    const members = await listMembers(ctx, patA);
    expectNoLeak(members);
    expect(members.items.map((m) => m.id)).toContain(pat.id);
    await expectRefused(getMember(ctx, patA, globex.member.id));
    await expectRefused(removeMember(ctx, acme.ownerActor, { userId: globex.member.id }));
    await expectRefused(
      createAgent(ctx, acme.ownerActor, {
        name: 'acme-bot',
        responsibleUserId: globex.member.id,
        scope: { projects: 'all', access: 'write' },
      }),
    );

    expectNoLeak(await listInvitations(ctx, acme.ownerActor));
    await expectRefused(cancelInvitation(ctx, acme.ownerActor, { id: ids.invitation as string }));

    expectNoLeak(await listApiKeys(ctx, patA));
    expectNoLeak(await listApiKeys(ctx, acme.ownerActor, { owner: 'all' }));
    await expectRefused(listApiKeys(ctx, acme.ownerActor, { owner: globex.member.id }));
    await expectRefused(revokeApiKey(ctx, patA, { id: ids.globexKey as string }));
    await expectRefused(revokeApiKey(ctx, acme.ownerActor, { id: ids.globexKey as string }));
    await expectRefused(
      createApiKey(ctx, patA, { name: 'into Globex', scope: { projects: [globexPay.id], access: 'read' } }),
    );
    const own = await createApiKey(ctx, patA, {
      name: 'Acme laptop',
      scope: { projects: 'all', access: 'read' },
    });
    expectNoLeak(own);
  });

  it('me: the workspace and a key scope name Acme only', async () => {
    const me = await getMe(ctx, patA);
    expect(me.workspace.id).toBe(acme.workspaceId);
    expectNoLeak(me);
    // A key whose stored scope names a Globex project id never shows that project.
    const scoped: Actor = {
      ...patA,
      scope: { projects: [acmePay.id, globexPay.id], access: 'read' },
      apiKeyId: crypto.randomUUID(),
    };
    const fromKey = await getMe(ctx, scoped);
    expect(fromKey.auth.scope).toMatchObject({ projects: [{ id: acmePay.id }] });
    expectNoLeak(fromKey);
  });

  it('git connections: Globex connections are not found', async () => {
    const id = ids.connection as string;
    expectNoLeak(await listConnections(gitCtx, acme.ownerActor));
    await expectRefused(getConnection(gitCtx, acme.ownerActor, id));
    await expectRefused(updateConnection(gitCtx, acme.ownerActor, { id, name: 'mine' }));
    await expectRefused(deleteConnection(gitCtx, acme.ownerActor, { id }));
    await expectRefused(testConnection(gitCtx, acme.ownerActor, { id }));
  });

  it('dashboard, home, activity and timeline show nothing of Globex', async () => {
    for (const scope of ['mine', 'everyone'] as const) {
      expectNoLeak(await getDashboard(ctx, patA, { scope }));
    }
    for (const tab of ['mine', 'everyone', 'agents'] as const) {
      expectNoLeak(await getHome(ctx, patA, { tab }));
      expectNoLeak(await getHome(ctx, acme.agentActor, { tab }));
    }
    expect((await getHomeCounts(ctx, patA)).total).toBe(0);
    expect((await getDashboardCounts(ctx, patA)).total).toBe(0);
    expectNoLeak(await listTaskTimeline(ctx, patA, { key: 'PAY-1' }));
    expectNoLeak(await listTaskActivity(ctx, patA, { key: 'PAY-1' }));
  });

  it('archive, check again and requests read and write Acme only', async () => {
    expect((await listTasks(ctx, patA, { archived: 'only' })).items).toEqual([]);
    expect((await listTasks(ctx, patA, { checkAgain: 'set' })).items).toEqual([]);
    expectNoLeak(await listTasks(ctx, patA, { archived: 'include', q: MARK }));
    const acmeOne = await getTask(ctx, patA, { key: 'PAY-1' });
    expect(acmeOne).toMatchObject({ pullRequests: [], checkAgain: null, mergedOpen: null });
    expectNoLeak(acmeOne);
    // PAY-4 is Globex's archived task; Acme has no PAY-4.
    await expectRefused(archiveTasks(ctx, patA, { keys: ['PAY-4'] }));
    await expectRefused(restoreTasks(ctx, patA, { keys: ['PAY-4'] }));
    const preview = await archivePreview(ctx, patA, { project: 'PAY', days: 1 });
    expect(preview).toEqual({ project: 'PAY', days: 1, count: 0 });
    // The system move resolves the task in the workspace it is given.
    await expectRefused(
      ctx.db.transaction((tx) =>
        setStatusFromSource(tx, ctx, {
          workspaceId: acme.workspaceId,
          taskId: ids.one as string,
          status: 'done',
          cause: {
            kind: 'pull_request',
            provider: 'github',
            number: 482,
            title: 'Acme',
            url: 'https://github.com/acme/payments/pull/482',
            event: 'merged',
            by: null,
          },
        }),
      ),
    );
    const home = await getHome(ctx, patA, { tab: 'mine' });
    expect(home.groups.find((g) => g.key === 'mergedOpen')?.total).toBe(0);
    expect(home.groups.find((g) => g.key === 'checkAgain')?.total).toBe(0);
    // Pat sees both groups in Globex.
    const globexHome = await getHome(ctx, patG, { tab: 'everyone' });
    expect(globexHome.groups.find((g) => g.key === 'mergedOpen')?.total).toBe(1);
  });

  it('repository links, requests and webhooks stay in Acme', async () => {
    const host = new FakeRequestHost('github', 'github.com');
    const jobs = recordingJobQueue();
    const prCtx = {
      ...ctx,
      encryptionKey: gitCtx.encryptionKey,
      providerFactory: fakeRequestFactory(host),
      jobs,
    };
    await updateProject(prCtx, acme.ownerActor, {
      project: 'PAY',
      repository: 'https://github.com/acme/payments',
    });
    const settings = await getRepositorySettings(prCtx, acme.ownerActor, { project: 'PAY' });
    expectNoLeak(settings);
    expect(settings.connection).toBeNull();
    await expectRefused(
      updateRepositorySettings(prCtx, acme.ownerActor, {
        project: 'PAY',
        connectionId: ids.connection as string,
      }),
    );
    // Globex's request is in another repository; Acme has no #482 to unlink.
    const refused = await expectRefused(
      linkPullRequest(prCtx, patA, { key: 'PAY-1', url: `https://github.com/${MARK}/payments/pull/482` }),
    );
    expect(refused).toBeInstanceOf(RequestOtherRepository);
    expect(await expectRefused(unlinkPullRequest(prCtx, patA, { key: 'PAY-1', number: 482 }))).toBeInstanceOf(
      RequestNotFound,
    );

    // A delivery to Acme's webhook naming PAY-1 and PAY-3 links Acme's PAY-1 only.
    const { url, secret } = await newRepositoryWebhookSecret(prCtx, acme.ownerActor, { project: 'PAY' });
    const webhookId = url.split('/').at(-1) as string;
    const body = JSON.stringify({
      action: 'opened',
      number: 482,
      pull_request: {
        number: 482,
        title: 'Acme request',
        body: 'Closes: PAY-1, PAY-3',
        state: 'open',
        draft: false,
        merged: false,
        head: { ref: 'feat/acme' },
        base: { ref: 'main' },
        user: { login: 'acme-dev' },
        html_url: 'https://github.com/acme/payments/pull/482',
        created_at: '2040-01-01T10:00:00Z',
        updated_at: '2040-01-01T10:00:00Z',
      },
    });
    const headers = { ...signWebhook('github', body, secret), 'X-GitHub-Event': 'pull_request' };
    expect(await receiveRepositoryWebhook(prCtx, { webhookId, headers, rawBody: body })).toMatchObject({
      status: 202,
    });
    const [job] = jobs.sent;
    const payload = job?.data as { linkId: string };
    await handleRepositoryEvent(prCtx, {
      linkId: payload.linkId,
      request: requestInfo(
        { number: 482, title: 'Acme request', body: 'Closes: PAY-1, PAY-3', headBranch: 'feat/acme' },
        { path: 'acme/payments' },
      ),
      action: 'opened',
    });
    const one = await getTask(prCtx, patA, { key: 'PAY-1' });
    expect(one.pullRequests).toEqual([expect.objectContaining({ number: 482, how: 'description' })]);
    expectNoLeak(one);
    await syncRepositoryNow(prCtx, acme.ownerActor, { project: 'PAY' });
    await pollRepositories(prCtx, { workspaceIds: [acme.workspaceId] });
    for (const sent of jobs.sent) expectNoLeak(sent);
  });

  it('workspace settings: counts and renames are Acme only', async () => {
    const contents = await getWorkspaceContents(ctx, acme.ownerActor);
    expect(contents.projects).toBe(1);
    expectNoLeak(await updateWorkspace(ctx, acme.ownerActor, { name: 'Acme Inc' }));
  });

  it('left every Globex row as it was', async () => {
    expect(await globexRows()).toEqual(snapshot);
  });
});
