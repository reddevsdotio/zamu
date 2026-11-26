// The settings server functions' adapter against a throwaway database: actors from a session cookie
// or an API key, core's rules, and failures returned as data.
import { createAuth, getActorFromRequest } from '@zamu/auth';
import {
  type Actor,
  type CoreContext,
  cancelInvitation,
  createAgent,
  createApiKey,
  createInvitation,
  LabelExists,
  listApiKeys,
  listInvitations,
  listMembers,
  removeMember,
  revokeApiKey,
  SlugTaken,
} from '@zamu/core';
import { createWorld } from '@zamu/core/testing/fixtures';
import { createTestDatabase, type TestDatabase } from '@zamu/db/test';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { seedDevData } from '../../server/seed';
import { runAs, runForRequest } from './adapter';
import { SettingsError, type SettingsResult, unwrap } from './result';

const ORIGIN = 'http://localhost:3000';
const SECRET = 'test-secret-test-secret-test-secret-0123';

let database: TestDatabase;
let core: CoreContext;
let adminCookie: Headers;
let adminId: string;
let memberKey: Headers;
let elsewhereSlug: string;

const bearer = (key: string) => new Headers({ authorization: `Bearer ${key}` });

function ok<T>(result: SettingsResult<T>): T {
  if (!result.ok) throw new Error(`expected success, got ${result.error.code}: ${result.error.message}`);
  return result.data;
}

beforeAll(async () => {
  database = await createTestDatabase({ prefix: 'pm_web_settings' });
  database.pool.on('error', () => {});
  const auth = createAuth({ db: database.db, secret: SECRET, baseUrl: ORIGIN });
  core = { db: database.db, auth, publicUrl: ORIGIN };
  const seeded = await seedDevData(core);
  adminId = seeded.admin.id;

  const signIn = await auth.api.signInEmail({
    body: { email: seeded.admin.email, password: seeded.admin.password as string },
    returnHeaders: true,
  });
  adminCookie = new Headers({
    cookie: signIn.headers
      .getSetCookie()
      .map((c) => c.split(';')[0])
      .join('; '),
  });

  // A non-admin person in another workspace, acting through their own workspace-wide write key.
  elsewhereSlug = `elsewhere-${crypto.randomUUID().slice(0, 8)}`;
  const world = await createWorld(database.db, 'Elsewhere', { slug: elsewhereSlug });
  const key = await createApiKey(core, world.memberActor, {
    name: 'member key',
    scope: { projects: 'all', access: 'write' },
  });
  memberKey = bearer(key.key);
}, 60_000);

afterAll(async () => {
  await database?.drop();
});

describe('settings adapter', () => {
  it('returns UNAUTHORIZED without a session or key, before calling core', async () => {
    let called = false;
    const result = await runForRequest(core, new Headers(), async () => {
      called = true;
    });
    expect(result).toEqual({
      ok: false,
      error: { code: 'UNAUTHORIZED', message: 'Sign in again to continue.', issues: [] },
    });
    expect(called).toBe(false);
  });

  it('creates an agent for an admin session; the returned key works and acts for the admin', async () => {
    const created = ok(
      await runForRequest(core, adminCookie, (c, actor) =>
        createAgent(c, actor, {
          name: 'docs-bot',
          responsibleUserId: adminId,
          scope: { projects: 'all', access: 'write' },
        }),
      ),
    );
    expect(created.agent).toMatchObject({ name: 'docs-bot', kind: 'agent', apiKeyCount: 1 });
    expect(created.agent.responsible?.id).toBe(adminId);
    expect(created.key.key).toMatch(/^zamu_live_/);

    const agentActor = await getActorFromRequest(core, { headers: bearer(created.key.key) });
    expect(agentActor).toMatchObject({ userId: created.agent.id, kind: 'agent', onBehalfOfId: adminId });

    const members = ok(await runForRequest(core, adminCookie, (c, actor) => listMembers(c, actor)));
    expect(members.items.map((m) => m.name)).toContain('docs-bot');

    // Listing keys never returns secrets.
    const keys = ok(
      await runForRequest(core, adminCookie, (c, actor) =>
        listApiKeys(c, actor, { owner: created.agent.id }),
      ),
    );
    expect(keys).toHaveLength(1);
    expect(keys[0]).not.toHaveProperty('key');
  });

  it('maps core errors to failures: duplicate agents conflict, bad names are invalid', async () => {
    const again = await runForRequest(core, adminCookie, (c, actor) =>
      createAgent(c, actor, {
        name: 'docs-bot',
        responsibleUserId: adminId,
        scope: { projects: 'all', access: 'read' },
      }),
    );
    expect(again).toMatchObject({ ok: false, error: { code: 'CONFLICT' } });

    const invalid = await runForRequest(core, adminCookie, (c, actor) =>
      createAgent(c, actor, {
        name: 'Docs Bot',
        responsibleUserId: adminId,
        scope: { projects: 'all', access: 'read' },
      }),
    );
    expect(invalid).toMatchObject({ ok: false, error: { code: 'UNPROCESSABLE_CONTENT' } });
    if (!invalid.ok) expect(invalid.error.issues.map((issue) => issue.path)).toContain('name');
  });

  it('refuses admin-only actions for members, but lets them manage their own keys', async () => {
    const agent = await runForRequest(core, memberKey, (c, actor) =>
      createAgent(c, actor, {
        name: 'sneaky-bot',
        responsibleUserId: actor.userId,
        scope: { projects: 'all', access: 'write' },
      }),
    );
    expect(agent).toMatchObject({ ok: false, error: { code: 'FORBIDDEN' } });

    const invite = await runForRequest(core, memberKey, (c, actor) =>
      createInvitation(c, actor, { email: 'someone@example.com', role: 'member' }),
    );
    expect(invite).toMatchObject({ ok: false, error: { code: 'FORBIDDEN' } });

    const allKeys = await runForRequest(core, memberKey, (c, actor) =>
      listApiKeys(c, actor, { owner: 'all' }),
    );
    expect(allKeys).toMatchObject({ ok: false, error: { code: 'FORBIDDEN' } });

    const remove = await runForRequest(core, memberKey, (c, actor) =>
      removeMember(c, actor, { userId: adminId }),
    );
    expect(remove.ok).toBe(false);

    const own = ok(
      await runForRequest(core, memberKey, (c, actor) => listApiKeys(c, actor, { owner: 'me' })),
    );
    expect(own.map((k) => k.name)).toEqual(['member key']);
  });

  it('revokes a key: it shows as revoked and stops authenticating', async () => {
    const created = ok(
      await runForRequest(core, adminCookie, (c, actor) =>
        createApiKey(c, actor, { name: 'Old laptop', scope: { projects: 'all', access: 'write' } }),
      ),
    );
    expect(await getActorFromRequest(core, { headers: bearer(created.key) })).not.toBeNull();

    const revoked = ok(
      await runForRequest(core, adminCookie, (c, actor) => revokeApiKey(c, actor, { id: created.id })),
    );
    expect(revoked).toMatchObject({ id: created.id, revoked: true });
    expect(await getActorFromRequest(core, { headers: bearer(created.key) })).toBeNull();

    const mine = ok(
      await runForRequest(core, adminCookie, (c, actor) => listApiKeys(c, actor, { owner: 'me' })),
    );
    expect(mine.find((k) => k.id === created.id)?.revoked).toBe(true);
  });

  it('creates, lists and cancels invitations with links on the public URL', async () => {
    const invitation = ok(
      await runForRequest(core, adminCookie, (c, actor) =>
        createInvitation(c, actor, { email: 'jo.park@reddevs.io', role: 'member' }),
      ),
    );
    expect(invitation.link).toBe(`${ORIGIN}/invite/${invitation.id}`);
    const pending = ok(await runForRequest(core, adminCookie, (c, actor) => listInvitations(c, actor)));
    expect(pending.map((i) => i.email)).toContain('jo.park@reddevs.io');

    ok(
      await runForRequest(core, adminCookie, (c, actor) => cancelInvitation(c, actor, { id: invitation.id })),
    );
    const after = ok(await runForRequest(core, adminCookie, (c, actor) => listInvitations(c, actor)));
    expect(after.map((i) => i.email)).not.toContain('jo.park@reddevs.io');
  });

  it('returns NOT_A_MEMBER for a session that names a workspace of someone else, before calling core', async () => {
    let called = false;
    const headers = new Headers(adminCookie);
    headers.set('x-zamu-workspace', elsewhereSlug);
    const result = await runForRequest(core, headers, async () => {
      called = true;
    });
    expect(result).toEqual({
      ok: false,
      error: {
        code: 'NOT_A_MEMBER',
        message: `You are not a member of the workspace "${elsewhereSlug}".`,
        issues: [],
      },
    });
    expect(called).toBe(false);
    const error = await unwrap(result).catch((e) => e);
    expect(error).toBeInstanceOf(SettingsError);
    expect(error.leftWorkspace).toBe(true);
  });

  it('returns WORKSPACE_MISMATCH for a key sent with another workspace slug', async () => {
    const headers = new Headers(memberKey);
    headers.set('x-zamu-workspace', 'no-such-workspace');
    const result = await runForRequest(core, headers, async () => 'unreachable');
    expect(result).toMatchObject({ ok: false, error: { code: 'WORKSPACE_MISMATCH' } });

    headers.set('x-zamu-workspace', elsewhereSlug);
    expect(await runForRequest(core, headers, async () => 'reached')).toEqual({ ok: true, data: 'reached' });
  });

  it('keeps the specific problem code and puts slug problems on the slug field', async () => {
    const actor = { userId: adminId } as Actor;
    const label = await runAs(core, actor, async () => {
      throw new LabelExists('A label named Bug exists already.');
    });
    expect(label).toMatchObject({ ok: false, error: { code: 'LABEL_EXISTS' } });

    const taken = await runAs(core, actor, async () => {
      throw new SlugTaken('acme is taken. Pick another.');
    });
    expect(taken).toEqual({
      ok: false,
      error: {
        code: 'SLUG_TAKEN',
        message: 'acme is taken. Pick another.',
        issues: [{ path: 'slug', message: 'acme is taken. Pick another.' }],
      },
    });
    const error = await unwrap(taken).catch((e) => e);
    expect(error.issueFor('slug')).toBe('acme is taken. Pick another.');
    expect(error.leftWorkspace).toBe(false);
  });

  it('lets errors that are not core errors propagate', async () => {
    const actor = { userId: adminId } as Actor;
    await expect(
      runAs(core, actor, async () => {
        throw new Error('boom');
      }),
    ).rejects.toThrow('boom');
  });
});
