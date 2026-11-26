import { getActorFromRequest } from '@zamu/auth';
import { schema } from '@zamu/db';
import { eq } from 'drizzle-orm';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { listApiKeys } from './api-keys';
import { Conflict, Forbidden, Invalid, NotFound, ResponsibleForAgents } from './errors';
import { getMe } from './me';
import { createAgent, listMembers, removeMember } from './members';
import { createProject } from './projects';
import { createTask, getTask, listTasks } from './tasks';
import { createUser, createWorld, type TestContext, testContext, type World } from './testing/fixtures';

const bearer = (key: string) => ({ headers: new Headers({ authorization: `Bearer ${key}` }) });

describe('members', () => {
  let ctx: TestContext;
  let world: World;

  beforeAll(async () => {
    ctx = testContext();
    world = await createWorld(ctx.db);
  });
  afterAll(async () => {
    await ctx?.close();
  });

  it('lists people first, with responsible humans, last activity and key counts', async () => {
    await createProject(ctx, world.ownerActor, { name: 'Payments', key: 'PAY' });
    await createTask(ctx, world.agentActor, { project: 'PAY', title: 'From the agent' });

    const { items } = await listMembers(ctx, world.memberActor);
    expect(items.map((m) => [m.id, m.kind])).toEqual([
      [world.owner.id, 'person'],
      [world.member.id, 'person'],
      [world.agent.id, 'agent'],
    ]);
    const [owner, , agent] = items;
    expect(owner).toMatchObject({
      role: 'owner',
      email: world.owner.email,
      responsible: null,
      lastActiveAt: null,
    });
    expect(agent).toMatchObject({
      email: null,
      role: 'member',
      responsible: { id: world.member.id, kind: 'person' },
      apiKeyCount: 0,
    });
    expect(agent?.lastActiveAt).not.toBeNull();
  });

  describe('createAgent', () => {
    it('creates an agent with a membership and a scoped first key that works once', async () => {
      const w = await createWorld(ctx.db);
      const pay = await createProject(ctx, w.ownerActor, { name: 'Payments', key: 'PAY' });
      await createProject(ctx, w.ownerActor, { name: 'Web', key: 'WEB' });
      const webTask = await createTask(ctx, w.ownerActor, { project: 'WEB', title: 'Web task' });

      const { agent, key } = await createAgent(ctx, w.ownerActor, {
        name: 'docs-bot',
        responsibleUserId: w.member.id,
        scope: { projects: [pay.id], access: 'write' },
      });
      expect(agent).toMatchObject({
        name: 'docs-bot',
        kind: 'agent',
        email: null,
        role: 'member',
        responsible: { id: w.member.id },
        apiKeyCount: 1,
      });
      expect(key.key).toMatch(/^zamu_live_/);
      expect(key).toMatchObject({
        name: 'docs-bot key',
        owner: { id: agent.id, kind: 'agent' },
        scope: { projects: [{ id: pay.id, key: 'PAY', name: 'Payments' }], access: 'write' },
        revoked: false,
      });

      // No password account: agents cannot sign in.
      const accounts = await ctx.db.select().from(schema.account).where(eq(schema.account.userId, agent.id));
      expect(accounts).toHaveLength(0);

      // The secret is never readable again.
      const listed = await listApiKeys(ctx, w.memberActor, { owner: agent.id });
      expect(listed).toHaveLength(1);
      expect(listed[0]).not.toHaveProperty('key');

      // The real key resolves to an actor that is limited to PAY.
      const actor = await getActorFromRequest(ctx, bearer(key.key));
      expect(actor).toMatchObject({
        userId: agent.id,
        kind: 'agent',
        onBehalfOfId: w.member.id,
        scope: { projects: [pay.id], access: 'write' },
      });
      if (!actor) throw new Error('no actor');
      const created = await createTask(ctx, actor, { project: 'PAY', title: 'Docs for payouts' });
      expect(created.createdOnBehalfOf?.id).toBe(w.member.id);
      await expect(getTask(ctx, actor, { key: webTask.key })).rejects.toThrow(Forbidden);
      await expect(listTasks(ctx, actor, { project: 'WEB' })).rejects.toThrow(Forbidden);

      const me = await getMe(ctx, actor);
      expect(me).toMatchObject({
        user: { id: agent.id, kind: 'agent', email: null, responsible: { id: w.member.id } },
        role: 'member',
        auth: { method: 'api_key', scope: { projects: [{ key: 'PAY' }], access: 'write' } },
      });
    });

    it('issues read-only keys that cannot write', async () => {
      const w = await createWorld(ctx.db);
      await createProject(ctx, w.ownerActor, { name: 'Payments', key: 'PAY' });
      const { key } = await createAgent(ctx, w.ownerActor, {
        name: 'reader',
        responsibleUserId: w.owner.id,
        scope: { projects: 'all', access: 'read' },
        keyName: 'Reader key',
      });
      const actor = await getActorFromRequest(ctx, bearer(key.key));
      if (!actor) throw new Error('no actor');
      await expect(listTasks(ctx, actor, { project: 'PAY' })).resolves.toMatchObject({ items: [] });
      await expect(createTask(ctx, actor, { project: 'PAY', title: 'nope' })).rejects.toThrow(/read-only/);
    });

    it('enforces admins, a person as responsible human, unique names and a valid scope', async () => {
      const w = await createWorld(ctx.db);
      const input = {
        name: 'ci-bot',
        responsibleUserId: w.member.id,
        scope: { projects: 'all' as const, access: 'read' as const },
      };
      await expect(createAgent(ctx, w.memberActor, input)).rejects.toThrow(Forbidden);
      await expect(createAgent(ctx, w.agentActor, input)).rejects.toThrow(Forbidden);
      await expect(
        createAgent(ctx, w.ownerActor, { ...input, responsibleUserId: w.agent.id }),
      ).rejects.toThrow(Invalid);
      const outsider = await createUser(ctx.db, { name: 'Outsider' });
      await expect(
        createAgent(ctx, w.ownerActor, { ...input, responsibleUserId: outsider.id }),
      ).rejects.toThrow(Invalid);
      await expect(
        createAgent(ctx, w.ownerActor, {
          ...input,
          scope: { projects: [crypto.randomUUID()], access: 'read' },
        }),
      ).rejects.toThrow(Invalid);
      await expect(createAgent(ctx, w.ownerActor, { ...input, name: 'Not A Slug' })).rejects.toThrow(Invalid);

      await createAgent(ctx, w.ownerActor, input);
      await expect(createAgent(ctx, w.ownerActor, input)).rejects.toThrow(Conflict);
      // Same name in another workspace is fine.
      const other = await createWorld(ctx.db);
      await expect(
        createAgent(ctx, other.ownerActor, { ...input, responsibleUserId: other.owner.id }),
      ).resolves.toBeTruthy();
    });
  });

  describe('removeMember', () => {
    it('removes people and agents, revoking agent keys, but never owners or yourself', async () => {
      const w = await createWorld(ctx.db);
      const admin = await createUser(ctx.db, { name: 'Admin' });
      await ctx.db
        .insert(schema.member)
        .values({ organizationId: w.workspaceId, userId: admin.id, role: 'admin' });
      const adminActor = { ...w.memberActor, userId: admin.id, role: 'admin' as const };

      const { agent, key } = await createAgent(ctx, adminActor, {
        name: 'temp-bot',
        responsibleUserId: w.member.id,
        scope: { projects: 'all', access: 'write' },
      });
      await expect(removeMember(ctx, w.memberActor, { userId: agent.id })).rejects.toThrow(Forbidden);
      await expect(removeMember(ctx, adminActor, { userId: w.owner.id })).rejects.toThrow(Forbidden);
      await expect(removeMember(ctx, adminActor, { userId: admin.id })).rejects.toThrow(Invalid);
      await expect(removeMember(ctx, adminActor, { userId: crypto.randomUUID() })).rejects.toThrow(NotFound);

      await expect(removeMember(ctx, adminActor, { userId: agent.id })).resolves.toMatchObject({
        id: agent.id,
      });
      expect(await getActorFromRequest(ctx, bearer(key.key))).toBeNull();
      const [stored] = await ctx.db.select().from(schema.apikey).where(eq(schema.apikey.id, key.id));
      expect(stored?.enabled).toBe(false);

      // w.member is still the responsible human of w.agent.
      await expect(removeMember(ctx, adminActor, { userId: w.member.id })).rejects.toThrow(
        ResponsibleForAgents,
      );
      await removeMember(ctx, adminActor, { userId: w.agent.id });
      await removeMember(ctx, adminActor, { userId: w.member.id });
      const { items } = await listMembers(ctx, adminActor);
      expect(items.map((m) => m.id).sort()).toEqual([w.owner.id, admin.id].sort());
    });

    it('refuses to remove the responsible human of agents here, naming them', async () => {
      const w = await createWorld(ctx.db);
      const elsewhere = await createWorld(ctx.db, 'Elsewhere');
      const second = await createAgent(ctx, w.ownerActor, {
        name: `aaa-bot-${crypto.randomUUID().slice(0, 6)}`,
        responsibleUserId: w.member.id,
        scope: { projects: 'all', access: 'read' },
      });
      // An agent the member answers for in another workspace does not count here.
      await ctx.db
        .update(schema.user)
        .set({ responsibleUserId: w.member.id })
        .where(eq(schema.user.id, elsewhere.agent.id));

      const error = await removeMember(ctx, w.ownerActor, { userId: w.member.id }).catch((e: unknown) => e);
      expect(error).toBeInstanceOf(ResponsibleForAgents);
      const refused = error as ResponsibleForAgents;
      expect(refused.code).toBe('CONFLICT');
      expect(refused.message).toBe(
        `${w.member.name} is responsible for ${second.agent.name} and ${w.agent.name} here. ` +
          'Hand them to someone else or remove them first.',
      );
      expect(refused.agents.map((a) => a.id)).toEqual([second.agent.id, w.agent.id]);
      expect(refused.issues).toEqual([
        { path: 'agents', message: second.agent.name },
        { path: 'agents', message: w.agent.name },
      ]);
      expect((await listMembers(ctx, w.ownerActor)).items.map((m) => m.id)).toContain(w.member.id);
    });
  });
});
