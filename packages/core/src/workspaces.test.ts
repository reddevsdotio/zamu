import { getActorFromRequest } from '@zamu/auth';
import { schema } from '@zamu/db';
import { eq, inArray } from 'drizzle-orm';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { issueApiKey, listApiKeys } from './api-keys';
import type { Actor } from './authz';
import { createComment } from './comments';
import {
  Forbidden,
  Invalid,
  LastOwner,
  NotFound,
  ResponsibleForAgents,
  SlugReserved,
  SlugTaken,
  WorkspaceCreationOff,
} from './errors';
import { removeMember } from './members';
import { createProject } from './projects';
import { createTask, listTasks, updateTask } from './tasks';
import {
  addMember,
  createUser,
  createWorld,
  randomWorkspaceSlug,
  type TestContext,
  testContext,
} from './testing/fixtures';
import {
  createWorkspace,
  deleteWorkspace,
  getWorkspaceContents,
  leaveWorkspace,
  listMyWorkspaces,
  resolveWorkspaceSlug,
  suggestAvailableWorkspaceSlug,
  touchLastWorkspace,
  updateWorkspace,
  WORKSPACE_SLUG_REUSE_DAYS,
} from './workspaces';

const DAY_MS = 24 * 60 * 60 * 1000;
const bearer = (key: string) => ({ headers: new Headers({ authorization: `Bearer ${key}` }) });
const allWrite = { projects: 'all' as const, access: 'write' as const };

/** A context whose clock reads `at`, for the alias reuse window. */
function at(ctx: TestContext, date: Date) {
  return { ...ctx, now: () => date };
}

async function lastWorkspaceOf(ctx: TestContext, userId: string) {
  const [row] = await ctx.db
    .select({ id: schema.user.lastWorkspaceId })
    .from(schema.user)
    .where(eq(schema.user.id, userId));
  return row?.id ?? null;
}

describe('workspaces', () => {
  let ctx: TestContext;

  beforeAll(() => {
    ctx = testContext();
  });
  afterAll(async () => {
    await ctx?.close();
  });

  /** A person and their session actor in a new workspace created through the service. */
  async function ownerWithWorkspace(name = 'Acme') {
    const person = await createUser(ctx.db, { name: `Ana ${name}` });
    const workspace = await createWorkspace(ctx, person.id, { name, slug: randomWorkspaceSlug('acme') });
    const actor: Actor = {
      userId: person.id,
      kind: 'person',
      workspaceId: workspace.id,
      role: 'owner',
      onBehalfOfId: null,
    };
    return { person, workspace, actor };
  }

  describe('createWorkspace', () => {
    it('makes the creator its owner and the workspace they use last', async () => {
      const person = await createUser(ctx.db, { name: 'Ana Ruiz' });
      const slug = randomWorkspaceSlug('acme');
      const created = await createWorkspace(ctx, person.id, { name: '  Acme  ', slug: slug.toUpperCase() });
      expect(created).toMatchObject({ name: 'Acme', slug, role: 'owner' });
      expect(await lastWorkspaceOf(ctx, person.id)).toBe(created.id);
      const { items } = await listMyWorkspaces(ctx, person.id);
      expect(items).toEqual([{ id: created.id, name: 'Acme', slug, role: 'owner' }]);
    });

    it('suggests the slug from the name and appends a number while it is taken', async () => {
      const person = await createUser(ctx.db, { name: 'Ana Ruiz' });
      const name = `Globex ${crypto.randomUUID().slice(0, 6)}`;
      const first = await createWorkspace(ctx, person.id, { name });
      const second = await createWorkspace(ctx, person.id, { name });
      expect(second.slug).toBe(`${first.slug}-2`);
      expect(await suggestAvailableWorkspaceSlug(ctx, name)).toBe(`${first.slug}-3`);
    });

    it('refuses reserved and taken slugs', async () => {
      const person = await createUser(ctx.db, { name: 'Ana Ruiz' });
      await expect(createWorkspace(ctx, person.id, { name: 'Admin', slug: 'admin' })).rejects.toThrow(
        SlugReserved,
      );
      const { workspace } = await ownerWithWorkspace();
      const error = await createWorkspace(ctx, person.id, { name: 'Copy', slug: workspace.slug }).catch(
        (e: unknown) => e,
      );
      expect(error).toBeInstanceOf(SlugTaken);
      expect((error as SlugTaken).issues?.[0]?.path).toBe('slug');
      await expect(createWorkspace(ctx, person.id, { name: 'Bad', slug: '9lives' })).rejects.toThrow(Invalid);
    });

    it('lets owners only create one under the owners policy, and never agents', async () => {
      const owners = { ...ctx, workspaceCreation: 'owners' as const };
      const newcomer = await createUser(ctx.db, { name: 'New person' });
      const { person: owner } = await ownerWithWorkspace();
      await expect(createWorkspace(owners, newcomer.id, { name: 'Mine' })).rejects.toThrow(
        WorkspaceCreationOff,
      );
      expect((await listMyWorkspaces(owners, newcomer.id)).canCreate).toBe(false);
      expect((await listMyWorkspaces(ctx, newcomer.id)).canCreate).toBe(true);
      expect((await listMyWorkspaces(owners, owner.id)).canCreate).toBe(true);
      await expect(createWorkspace(owners, owner.id, { name: 'Second' })).resolves.toMatchObject({
        role: 'owner',
      });

      const world = await createWorld(ctx.db);
      await expect(createWorkspace(ctx, world.agent.id, { name: 'Bots' })).rejects.toThrow(Forbidden);
      expect((await listMyWorkspaces(ctx, world.agent.id)).canCreate).toBe(false);
      await expect(createWorkspace(ctx, crypto.randomUUID(), { name: 'Ghost' })).rejects.toThrow(NotFound);
    });
  });

  describe('listMyWorkspaces and resolveWorkspaceSlug', () => {
    it('lists every membership by name with its role', async () => {
      const { person, workspace: zeta } = await ownerWithWorkspace('Zeta');
      const other = await createWorld(ctx.db, 'Alpha', { slug: randomWorkspaceSlug('alpha') });
      await addMember(ctx.db, other.workspaceId, person, 'admin');
      const { items } = await listMyWorkspaces(ctx, person.id);
      expect(items.map((item) => [item.name, item.role])).toEqual([
        ['Alpha', 'admin'],
        ['Zeta', 'owner'],
      ]);
      expect(items[1]?.id).toBe(zeta.id);
    });

    it('resolves current and old slugs, ignoring case', async () => {
      const { workspace, actor } = await ownerWithWorkspace();
      const next = randomWorkspaceSlug('next');
      await updateWorkspace(ctx, actor, { slug: next });

      expect(await resolveWorkspaceSlug(ctx, ` ${next.toUpperCase()} `)).toEqual({
        workspace: { id: workspace.id, name: workspace.name, slug: next },
        current: true,
      });
      expect(await resolveWorkspaceSlug(ctx, workspace.slug)).toEqual({
        workspace: { id: workspace.id, name: workspace.name, slug: next },
        current: false,
      });
      expect(await resolveWorkspaceSlug(ctx, randomWorkspaceSlug('none'))).toBeNull();
      expect(await resolveWorkspaceSlug(ctx, '')).toBeNull();
    });
  });

  describe('updateWorkspace', () => {
    it('renames for owners and admins, people with a session only', async () => {
      const { actor, workspace, person } = await ownerWithWorkspace();
      await expect(updateWorkspace(ctx, actor, { name: 'Acme Corp' })).resolves.toMatchObject({
        name: 'Acme Corp',
        slug: workspace.slug,
      });

      const admin = await createUser(ctx.db, { name: 'Admin' });
      const adminActor = await addMember(ctx.db, workspace.id, admin, 'admin');
      await expect(updateWorkspace(ctx, adminActor, { name: 'Acme Inc' })).resolves.toMatchObject({
        name: 'Acme Inc',
        role: 'admin',
      });

      const plain = await createUser(ctx.db, { name: 'Member' });
      const memberActor = await addMember(ctx.db, workspace.id, plain);
      await expect(updateWorkspace(ctx, memberActor, { name: 'Mine' })).rejects.toThrow(Forbidden);
      const keyActor: Actor = { ...actor, scope: allWrite, apiKeyId: crypto.randomUUID() };
      await expect(updateWorkspace(ctx, keyActor, { name: 'Key' })).rejects.toThrow(Forbidden);
      await expect(updateWorkspace(ctx, actor, {})).rejects.toThrow(Invalid);
      expect(person.id).toBe(actor.userId);
    });

    it('keeps the old slug as an alias and lets the workspace take it back', async () => {
      const { actor, workspace } = await ownerWithWorkspace();
      const first = workspace.slug;
      const second = randomWorkspaceSlug('second');
      await updateWorkspace(ctx, actor, { slug: second });
      const back = await updateWorkspace(ctx, actor, { slug: first });
      expect(back.slug).toBe(first);

      const aliases = await ctx.db
        .select({ slug: schema.workspaceSlugAlias.slug })
        .from(schema.workspaceSlugAlias)
        .where(eq(schema.workspaceSlugAlias.workspaceId, workspace.id));
      expect(aliases.map((row) => row.slug)).toEqual([second]);
      // Unchanged slug: nothing to do.
      await expect(updateWorkspace(ctx, actor, { slug: first })).resolves.toMatchObject({ slug: first });
    });

    it('refuses reserved slugs and slugs another workspace uses', async () => {
      const { actor } = await ownerWithWorkspace();
      const { workspace: other } = await ownerWithWorkspace('Globex');
      await expect(updateWorkspace(ctx, actor, { slug: 'settings' })).rejects.toThrow(SlugReserved);
      await expect(updateWorkspace(ctx, actor, { slug: other.slug })).rejects.toThrow(SlugTaken);
    });

    it("keeps another workspace's old slug out of reach for the reuse window, then hands it over", async () => {
      const t0 = new Date(Date.UTC(2031, 0, 15, 12));
      const { actor: acme, workspace } = await ownerWithWorkspace();
      const { actor: globex, person: globexOwner } = await ownerWithWorkspace('Globex');
      const old = workspace.slug;
      await updateWorkspace(at(ctx, t0), acme, { slug: randomWorkspaceSlug('renamed') });

      const almost = at(ctx, new Date(t0.getTime() + (WORKSPACE_SLUG_REUSE_DAYS * DAY_MS - 1)));
      await expect(updateWorkspace(almost, globex, { slug: old })).rejects.toThrow(SlugTaken);
      await expect(createWorkspace(almost, globexOwner.id, { name: 'Copy', slug: old })).rejects.toThrow(
        SlugTaken,
      );
      expect(await suggestAvailableWorkspaceSlug(almost, old)).toBe(`${old}-2`);

      const after = at(ctx, new Date(t0.getTime() + WORKSPACE_SLUG_REUSE_DAYS * DAY_MS));
      expect(await suggestAvailableWorkspaceSlug(after, old)).toBe(old);
      await expect(updateWorkspace(after, globex, { slug: old })).resolves.toMatchObject({ slug: old });
      expect((await resolveWorkspaceSlug(ctx, old))?.workspace.id).toBe(globex.workspaceId);
    });

    it('does not keep an old slug that breaks the slug rule as an alias', async () => {
      // createWorld's default slug carries a UUID, longer than 40 characters.
      const world = await createWorld(ctx.db, 'Legacy');
      const next = randomWorkspaceSlug('legacy');
      await updateWorkspace(ctx, world.ownerActor, { slug: next });
      const aliases = await ctx.db
        .select()
        .from(schema.workspaceSlugAlias)
        .where(eq(schema.workspaceSlugAlias.workspaceId, world.workspaceId));
      expect(aliases).toEqual([]);
    });
  });

  describe('leaveWorkspace and removeMember', () => {
    it("deletes the leaver's keys for that workspace only and forgets it as their last", async () => {
      const { workspace } = await ownerWithWorkspace();
      const { workspace: other } = await ownerWithWorkspace('Globex');
      const person = await createUser(ctx.db, { name: 'Two hats' });
      const here = await addMember(ctx.db, workspace.id, person);
      const there = await addMember(ctx.db, other.id, person);
      const leaving = await issueApiKey(ctx, workspace.id, person.id, 'Acme laptop', allWrite);
      const staying = await issueApiKey(ctx, other.id, person.id, 'Globex laptop', allWrite);
      await touchLastWorkspace(ctx, here);

      await expect(leaveWorkspace(ctx, here)).resolves.toMatchObject({ id: workspace.id });
      expect(await lastWorkspaceOf(ctx, person.id)).toBeNull();
      expect((await listMyWorkspaces(ctx, person.id)).items.map((item) => item.id)).toEqual([other.id]);
      const keys = await ctx.db
        .select({ id: schema.apikey.id })
        .from(schema.apikey)
        .where(inArray(schema.apikey.id, [leaving.id, staying.id]));
      expect(keys.map((row) => row.id)).toEqual([staying.id]);
      expect(await getActorFromRequest(ctx, bearer(staying.key))).toMatchObject({ workspaceId: other.id });
      expect((await listApiKeys(ctx, there)).map((key) => key.id)).toEqual([staying.id]);
      await expect(leaveWorkspace(ctx, here)).rejects.toThrow(NotFound);
    });

    it('refuses the last owner, but not one of two', async () => {
      const { actor, workspace } = await ownerWithWorkspace();
      const error = await leaveWorkspace(ctx, actor).catch((e: unknown) => e);
      expect(error).toBeInstanceOf(LastOwner);
      expect((error as Error).message).toContain(workspace.name);

      const second = await createUser(ctx.db, { name: 'Second owner' });
      const secondActor = await addMember(ctx.db, workspace.id, second, 'owner');
      await expect(leaveWorkspace(ctx, actor)).resolves.toMatchObject({ id: workspace.id });
      await expect(leaveWorkspace(ctx, secondActor)).rejects.toThrow(LastOwner);
    });

    it('refuses the responsible human of agents here, naming them, until they are gone', async () => {
      const world = await createWorld(ctx.db);
      const elsewhere = await createWorld(ctx.db, 'Elsewhere');
      // An agent the member answers for in another workspace does not count here.
      await addMember(ctx.db, elsewhere.workspaceId, world.member);
      await ctx.db
        .update(schema.user)
        .set({ responsibleUserId: world.member.id })
        .where(eq(schema.user.id, elsewhere.agent.id));

      const error = await leaveWorkspace(ctx, world.memberActor).catch((e: unknown) => e);
      expect(error).toBeInstanceOf(ResponsibleForAgents);
      const refused = error as ResponsibleForAgents;
      expect(refused.code).toBe('CONFLICT');
      expect(refused.message).toBe(
        `You are responsible for ${world.agent.name} here. Hand them to someone else or remove them first.`,
      );
      expect(refused.agents).toEqual([{ id: world.agent.id, name: world.agent.name, kind: 'agent' }]);
      expect(refused.issues).toEqual([{ path: 'agents', message: world.agent.name }]);

      await removeMember(ctx, world.ownerActor, { userId: world.agent.id });
      await expect(leaveWorkspace(ctx, world.memberActor)).resolves.toMatchObject({ id: world.workspaceId });
    });

    it('refuses agents and API keys', async () => {
      const world = await createWorld(ctx.db);
      await expect(leaveWorkspace(ctx, world.agentActor)).rejects.toThrow(Forbidden);
      const keyActor: Actor = { ...world.memberActor, scope: allWrite, apiKeyId: crypto.randomUUID() };
      await expect(leaveWorkspace(ctx, keyActor)).rejects.toThrow(Forbidden);
    });

    it("deletes a removed person's keys for the workspace", async () => {
      const world = await createWorld(ctx.db);
      const { workspace: other } = await ownerWithWorkspace('Globex');
      await addMember(ctx.db, other.id, world.member);
      const here = await issueApiKey(ctx, world.workspaceId, world.member.id, 'here', allWrite);
      const there = await issueApiKey(ctx, other.id, world.member.id, 'there', allWrite);
      await removeMember(ctx, world.ownerActor, { userId: world.agent.id });
      await removeMember(ctx, world.ownerActor, { userId: world.member.id });
      const keys = await ctx.db
        .select({ id: schema.apikey.id })
        .from(schema.apikey)
        .where(inArray(schema.apikey.id, [here.id, there.id]));
      expect(keys.map((row) => row.id)).toEqual([there.id]);
    });
  });

  describe('deleteWorkspace', () => {
    it('is for owners with a session, after typing the slug', async () => {
      const { actor, workspace } = await ownerWithWorkspace();
      const admin = await createUser(ctx.db, { name: 'Admin' });
      const adminActor = await addMember(ctx.db, workspace.id, admin, 'admin');
      await expect(deleteWorkspace(ctx, adminActor, { confirmSlug: workspace.slug })).rejects.toThrow(
        Forbidden,
      );
      const keyActor: Actor = { ...actor, scope: allWrite, apiKeyId: crypto.randomUUID() };
      await expect(deleteWorkspace(ctx, keyActor, { confirmSlug: workspace.slug })).rejects.toThrow(
        Forbidden,
      );
      const error = await deleteWorkspace(ctx, actor, { confirmSlug: `${workspace.slug}x` }).catch(
        (e: unknown) => e,
      );
      expect(error).toBeInstanceOf(Invalid);
      expect((error as Invalid).issues).toEqual([
        { path: 'confirmSlug', message: `Type ${workspace.slug} to confirm.` },
      ]);
      await expect(
        deleteWorkspace(ctx, actor, { confirmSlug: ` ${workspace.slug.toUpperCase()} ` }),
      ).resolves.toEqual({
        projects: 0,
        tasks: 0,
        agents: 0,
        keys: 0,
      });
      expect(await resolveWorkspaceSlug(ctx, workspace.slug)).toBeNull();
    });

    it('removes its agents, even ones that wrote tasks, comments and activity, and its keys', async () => {
      const acme = await createWorld(ctx.db, 'Acme', { slug: randomWorkspaceSlug('acme') });
      const globex = await createWorld(ctx.db, 'Globex', { slug: randomWorkspaceSlug('globex') });
      // The member belongs to both; one agent of Acme also belongs to Globex and must survive.
      const memberInGlobex = await addMember(ctx.db, globex.workspaceId, acme.member);
      const shared = await createUser(ctx.db, {
        name: `shared-bot-${crypto.randomUUID().slice(0, 6)}`,
        kind: 'agent',
        responsibleUserId: acme.member.id,
      });
      await addMember(ctx.db, acme.workspaceId, shared);
      await addMember(ctx.db, globex.workspaceId, shared);

      await createProject(ctx, acme.ownerActor, { name: 'Payments', key: 'PAY' });
      await createProject(ctx, acme.ownerActor, { name: 'Web', key: 'WEB' });
      await createProject(ctx, globex.ownerActor, { name: 'Payments', key: 'PAY' });
      const task = await createTask(ctx, acme.agentActor, { project: 'PAY', title: 'From the agent' });
      await updateTask(ctx, acme.agentActor, { key: task.key, status: 'in_progress' });
      await createComment(ctx, acme.agentActor, { key: task.key, body: 'Started' });
      await createTask(ctx, acme.memberActor, { project: 'WEB', title: 'Assigned', assignee: acme.agent.id });
      await createTask(ctx, globex.ownerActor, { project: 'PAY', title: 'Globex stays' });

      const agentKey = await issueApiKey(ctx, acme.workspaceId, acme.agent.id, 'agent', allWrite);
      const memberKey = await issueApiKey(ctx, acme.workspaceId, acme.member.id, 'acme', allWrite);
      const memberGlobexKey = await issueApiKey(ctx, globex.workspaceId, acme.member.id, 'globex', allWrite);
      const sharedGlobexKey = await issueApiKey(ctx, globex.workspaceId, shared.id, 'shared', allWrite);
      const revoked = await issueApiKey(ctx, acme.workspaceId, acme.owner.id, 'old', allWrite);
      await ctx.db.update(schema.apikey).set({ enabled: false }).where(eq(schema.apikey.id, revoked.id));
      await touchLastWorkspace(ctx, acme.memberActor);

      const expected = { projects: 2, tasks: 2, agents: 1, keys: 2 };
      expect(await getWorkspaceContents(ctx, acme.ownerActor)).toEqual(expected);
      const [row] = await ctx.db
        .select({ slug: schema.organization.slug })
        .from(schema.organization)
        .where(eq(schema.organization.id, acme.workspaceId));
      await expect(deleteWorkspace(ctx, acme.ownerActor, { confirmSlug: row?.slug ?? '' })).resolves.toEqual(
        expected,
      );

      const users = await ctx.db
        .select({ id: schema.user.id })
        .from(schema.user)
        .where(inArray(schema.user.id, [acme.agent.id, shared.id, acme.member.id, acme.owner.id]));
      expect(users.map((u) => u.id).sort()).toEqual([shared.id, acme.member.id, acme.owner.id].sort());
      const keys = await ctx.db
        .select({ id: schema.apikey.id })
        .from(schema.apikey)
        .where(
          inArray(schema.apikey.id, [
            agentKey.id,
            memberKey.id,
            memberGlobexKey.id,
            sharedGlobexKey.id,
            revoked.id,
          ]),
        );
      expect(keys.map((k) => k.id).sort()).toEqual([memberGlobexKey.id, sharedGlobexKey.id].sort());
      expect(await lastWorkspaceOf(ctx, acme.member.id)).toBeNull();

      // Globex is untouched.
      const { items } = await listTasks(ctx, memberInGlobex, { project: 'PAY' });
      expect(items.map((item) => item.title)).toEqual(['Globex stays']);
      expect((await listMyWorkspaces(ctx, acme.member.id)).items.map((item) => item.id)).toEqual([
        globex.workspaceId,
      ]);
      expect(await getActorFromRequest(ctx, bearer(sharedGlobexKey.key))).toMatchObject({
        userId: shared.id,
        workspaceId: globex.workspaceId,
      });
    });
  });

  describe('touchLastWorkspace', () => {
    it('remembers the workspace for people and ignores agents', async () => {
      const world = await createWorld(ctx.db);
      await touchLastWorkspace(ctx, world.memberActor);
      expect(await lastWorkspaceOf(ctx, world.member.id)).toBe(world.workspaceId);
      await touchLastWorkspace(ctx, world.agentActor);
      expect(await lastWorkspaceOf(ctx, world.agent.id)).toBeNull();
    });
  });
});
