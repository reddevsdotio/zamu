import { createDb, type Db, type DbHandle, schema } from '@zamu/db';
import { sharedTestDatabaseUrl } from '@zamu/db/test';
import { eq } from 'drizzle-orm';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { bearerApiKey, getActorFromRequest, resolveActor } from './actor';
import { type ApiKeyMetadata, parseApiKeyMetadata } from './api-key';
import { cookieHeaders, testAuth } from './testing/helpers';

// Runs on the shared database from @zamu/db's globalSetup; every row here uses fresh ids and emails.
describe('getActorFromRequest', () => {
  let db: Db;
  let pool: DbHandle['pool'];
  let auth: ReturnType<typeof testAuth>;
  let workspaceId: string;
  let otherWorkspaceId: string;
  let human: { id: string };
  let agent: { id: string };
  const projectId = crypto.randomUUID();

  const bearer = (key: string) => ({ headers: new Headers({ authorization: `Bearer ${key}` }) });

  async function createUser(values: Partial<typeof schema.user.$inferInsert> & { name: string }) {
    const [row] = await db
      .insert(schema.user)
      .values({ email: `${crypto.randomUUID()}@example.com`, ...values })
      .returning();
    if (!row) throw new Error('user insert failed');
    return row;
  }

  async function createKey(userId: string, metadata: unknown) {
    return auth.api.createApiKey({ body: { userId, name: 'test key', metadata } });
  }

  beforeAll(async () => {
    ({ db, pool } = createDb(sharedTestDatabaseUrl()));
    auth = testAuth(db);
    const [workspace, other] = await db
      .insert(schema.organization)
      .values([
        { name: 'Reddevs', slug: `reddevs-${crypto.randomUUID()}` },
        { name: 'Elsewhere', slug: `elsewhere-${crypto.randomUUID()}` },
      ])
      .returning();
    if (!workspace || !other) throw new Error('organization insert failed');
    workspaceId = workspace.id;
    otherWorkspaceId = other.id;

    human = await createUser({ name: 'Ada' });
    agent = await createUser({ name: 'claude-dev', kind: 'agent', responsibleUserId: human.id });
    await db.insert(schema.member).values([
      { organizationId: workspaceId, userId: human.id, role: 'admin' },
      { organizationId: workspaceId, userId: agent.id, role: 'member' },
    ]);
  });

  afterAll(async () => {
    await pool?.end();
  });

  it('resolves an agent key with project scope and the responsible human', async () => {
    const metadata: ApiKeyMetadata = { workspaceId, projects: [projectId], access: 'read' };
    const created = await createKey(agent.id, metadata);
    expect(created.key.startsWith('zamu_live_')).toBe(true);

    const [stored] = await db.select().from(schema.apikey).where(eq(schema.apikey.id, created.id));
    expect(stored?.key).not.toBe(created.key);
    expect(stored?.referenceId).toBe(agent.id);
    expect(stored?.rateLimitEnabled).toBe(false);

    const actor = await getActorFromRequest({ auth, db }, bearer(created.key));
    expect(actor).toEqual({
      userId: agent.id,
      kind: 'agent',
      workspaceId,
      role: 'member',
      scope: { projects: [projectId], access: 'read' },
      onBehalfOfId: human.id,
      apiKeyId: created.id,
    });
  });

  it('resolves a person key with workspace scope and no onBehalfOf', async () => {
    const created = await createKey(human.id, { workspaceId, projects: 'all', access: 'write' });
    const actor = await getActorFromRequest({ auth, db }, bearer(created.key));
    expect(actor).toMatchObject({
      userId: human.id,
      kind: 'person',
      role: 'admin',
      scope: { projects: 'all', access: 'write' },
      onBehalfOfId: null,
    });
  });

  it('keeps working past the plugin default of 10 requests per day', async () => {
    const created = await createKey(agent.id, { workspaceId, projects: 'all', access: 'read' });
    for (let i = 0; i < 12; i++) {
      expect(await getActorFromRequest({ auth, db }, bearer(created.key))).not.toBeNull();
    }
  });

  it('returns null for unknown, disabled, unscoped or foreign-workspace keys', async () => {
    expect(await getActorFromRequest({ auth, db }, bearer('zamu_live_not-a-real-key'))).toBeNull();

    const disabled = await createKey(agent.id, { workspaceId, projects: 'all', access: 'read' });
    await db.update(schema.apikey).set({ enabled: false }).where(eq(schema.apikey.id, disabled.id));
    expect(await getActorFromRequest({ auth, db }, bearer(disabled.key))).toBeNull();

    const unscoped = await createKey(agent.id, { workspaceId, access: 'admin' });
    expect(await getActorFromRequest({ auth, db }, bearer(unscoped.key))).toBeNull();

    const foreign = await createKey(agent.id, {
      workspaceId: otherWorkspaceId,
      projects: 'all',
      access: 'read',
    });
    expect(await getActorFromRequest({ auth, db }, bearer(foreign.key))).toBeNull();
  });

  it('refuses an agent without a responsible human', async () => {
    const orphan = await createUser({ name: 'orphan-agent', kind: 'agent' });
    await db.insert(schema.member).values({ organizationId: workspaceId, userId: orphan.id });
    const created = await createKey(orphan.id, { workspaceId, projects: 'all', access: 'read' });
    expect(await getActorFromRequest({ auth, db }, bearer(created.key))).toBeNull();
  });

  it('returns null without credentials and ignores non-zamu bearer tokens', async () => {
    expect(await getActorFromRequest({ auth, db }, { headers: new Headers() })).toBeNull();
    expect(await getActorFromRequest({ auth, db }, bearer('some-jwt-token'))).toBeNull();
    expect(bearerApiKey(new Headers({ authorization: 'bearer zamu_live_abc' }))).toBe('zamu_live_abc');
    expect(bearerApiKey(new Headers({ authorization: 'Basic zamu_live_abc' }))).toBeNull();
  });

  it('resolves a session, falling back to the oldest membership', async () => {
    const email = `${crypto.randomUUID()}@example.com`;
    await db.insert(schema.invitation).values({
      organizationId: workspaceId,
      email,
      role: 'member',
      inviterId: human.id,
      expiresAt: new Date(Date.now() + 60_000),
    });
    const signUp = await auth.api.signUpEmail({
      body: { name: 'Carol', email, password: 'long enough password' },
      returnHeaders: true,
    });
    const headers = cookieHeaders(signUp.headers);
    const userId = signUp.response.user.id;

    // Signed in but not a member of any workspace yet.
    expect(await getActorFromRequest({ auth, db }, { headers })).toBeNull();

    await db.insert(schema.member).values({ organizationId: workspaceId, userId, role: 'member' });
    expect(
      await getActorFromRequest({ auth, db }, new Request('http://localhost:3000/', { headers })),
    ).toEqual({
      userId,
      kind: 'person',
      workspaceId,
      role: 'member',
      onBehalfOfId: null,
    });
  });
});

describe('resolveActor: workspaces', () => {
  let db: Db;
  let pool: DbHandle['pool'];
  let auth: ReturnType<typeof testAuth>;
  const run = crypto.randomUUID().slice(0, 8);
  // Acme and Globex, each with its own slug; Acme was renamed and keeps its old slug as an alias.
  const slugs = {
    acme: `acme-${run}`,
    oldAcme: `old-acme-${run}`,
    globex: `globex-${run}`,
    initech: `initech-${run}`,
  };
  let acme: string;
  let globex: string;
  let initech: string;
  const password = 'long enough password';

  async function workspace(name: string, slug: string) {
    const [row] = await db.insert(schema.organization).values({ name, slug }).returning();
    if (!row) throw new Error('organization insert failed');
    return row.id;
  }

  /** A person with a password, signed in; returns the id and the session cookie. */
  async function signedIn(name: string) {
    const email = `${name.toLowerCase()}-${crypto.randomUUID()}@example.com`;
    const [user] = await db.insert(schema.user).values({ name, email, kind: 'person' }).returning();
    if (!user) throw new Error('user insert failed');
    const context = await auth.$context;
    await db.insert(schema.account).values({
      accountId: user.id,
      providerId: 'credential',
      userId: user.id,
      password: await context.password.hash(password),
    });
    const signIn = await auth.api.signInEmail({ body: { email, password }, returnHeaders: true });
    return { id: user.id, cookie: cookieHeaders(signIn.headers).get('cookie') ?? '' };
  }

  async function join(userId: string, organizationId: string, role = 'member', createdAt?: Date) {
    await db
      .insert(schema.member)
      .values({ organizationId, userId, role, ...(createdAt ? { createdAt } : {}) });
  }

  function request(credentials: { cookie?: string; key?: string }, workspaceSlug?: string) {
    const headers = new Headers();
    if (credentials.cookie) headers.set('cookie', credentials.cookie);
    if (credentials.key) headers.set('authorization', `Bearer ${credentials.key}`);
    if (workspaceSlug !== undefined) headers.set('x-zamu-workspace', workspaceSlug);
    return { headers };
  }

  async function workspaceOf(credentials: { cookie?: string; key?: string }, workspaceSlug?: string) {
    const result = await resolveActor({ auth, db }, request(credentials, workspaceSlug));
    return result.ok ? result.actor.workspaceId : result.code;
  }

  beforeAll(async () => {
    ({ db, pool } = createDb(sharedTestDatabaseUrl()));
    auth = testAuth(db);
    acme = await workspace('Acme', slugs.acme);
    globex = await workspace('Globex', slugs.globex);
    initech = await workspace('Initech', slugs.initech);
    await db.insert(schema.workspaceSlugAlias).values({ slug: slugs.oldAcme, workspaceId: acme });
  });

  afterAll(async () => {
    await pool?.end();
  });

  it('resolves a session in the workspace the header names, by slug or old slug', async () => {
    const ada = await signedIn('Ada');
    await join(ada.id, acme, 'owner', new Date('2026-01-01T00:00:00Z'));
    await join(ada.id, globex, 'member', new Date('2026-02-01T00:00:00Z'));

    const inGlobex = await resolveActor({ auth, db }, request(ada, slugs.globex));
    expect(inGlobex).toEqual({
      ok: true,
      actor: { userId: ada.id, kind: 'person', workspaceId: globex, role: 'member', onBehalfOfId: null },
    });
    expect(await workspaceOf(ada, slugs.acme)).toBe(acme);
    expect(await workspaceOf(ada, slugs.oldAcme)).toBe(acme);
    // Header values are trimmed and compared in lower case.
    expect(await workspaceOf(ada, `  ${slugs.globex.toUpperCase()} `)).toBe(globex);
  });

  it('falls back to the workspace used last, then the oldest membership', async () => {
    const bea = await signedIn('Bea');
    await join(bea.id, acme, 'member', new Date('2026-01-01T00:00:00Z'));
    await join(bea.id, globex, 'member', new Date('2026-02-01T00:00:00Z'));

    // No workspace used yet: the oldest membership.
    expect(await workspaceOf(bea)).toBe(acme);
    // A blank header counts as no header.
    expect(await workspaceOf(bea, '  ')).toBe(acme);

    await db.update(schema.user).set({ lastWorkspaceId: globex }).where(eq(schema.user.id, bea.id));
    expect(await workspaceOf(bea)).toBe(globex);

    // The workspace used last is one they left: back to the oldest membership.
    await db.update(schema.user).set({ lastWorkspaceId: initech }).where(eq(schema.user.id, bea.id));
    expect(await workspaceOf(bea)).toBe(acme);
  });

  it('never reads the session active organization', async () => {
    const cy = await signedIn('Cy');
    await join(cy.id, acme, 'member', new Date('2026-01-01T00:00:00Z'));
    await join(cy.id, globex, 'member', new Date('2026-02-01T00:00:00Z'));
    await db
      .update(schema.session)
      .set({ activeOrganizationId: globex })
      .where(eq(schema.session.userId, cy.id));
    expect(await workspaceOf(cy)).toBe(acme);
  });

  it('answers NOT_A_MEMBER to a signed-in person outside the named workspace', async () => {
    const dee = await signedIn('Dee');
    await join(dee.id, acme);

    for (const slug of [slugs.globex, 'no-such-workspace', 'Not a slug!']) {
      const result = await resolveActor({ auth, db }, request(dee, slug));
      expect(result).toEqual({
        ok: false,
        code: 'NOT_A_MEMBER',
        message: `You are not a member of the workspace "${slug.toLowerCase()}".`,
      });
    }
  });

  it('answers NOT_A_MEMBER to a signed-in person without any workspace, and UNAUTHORIZED without a session', async () => {
    const eli = await signedIn('Eli');
    expect(await resolveActor({ auth, db }, request(eli))).toMatchObject({ ok: false, code: 'NOT_A_MEMBER' });
    expect(await getActorFromRequest({ auth, db }, request(eli))).toBeNull();

    expect(await resolveActor({ auth, db }, request({}, slugs.acme))).toMatchObject({
      ok: false,
      code: 'UNAUTHORIZED',
    });
    expect(
      await resolveActor({ auth, db }, request({ cookie: 'better-auth.session_token=nope' })),
    ).toMatchObject({
      ok: false,
      code: 'UNAUTHORIZED',
    });
  });

  it('refuses an agent session as UNAUTHORIZED', async () => {
    const owner = await signedIn('Fay');
    const bot = await signedIn('Bot');
    await db
      .update(schema.user)
      .set({ kind: 'agent', responsibleUserId: owner.id })
      .where(eq(schema.user.id, bot.id));
    await join(bot.id, acme);
    expect(await workspaceOf(bot)).toBe('UNAUTHORIZED');
    expect(await workspaceOf(bot, slugs.acme)).toBe('UNAUTHORIZED');
  });

  it('lets a key name its own workspace and refuses another with WORKSPACE_MISMATCH', async () => {
    const gus = await signedIn('Gus');
    await join(gus.id, acme);
    await join(gus.id, globex);
    const created = await auth.api.createApiKey({
      body: {
        userId: gus.id,
        name: 'acme key',
        metadata: { workspaceId: acme, projects: 'all', access: 'read' },
      },
    });
    const key = { key: created.key };

    expect(await workspaceOf(key)).toBe(acme);
    expect(await workspaceOf(key, slugs.acme)).toBe(acme);
    expect(await workspaceOf(key, slugs.oldAcme)).toBe(acme);

    // Gus is a member of Globex too, but the key is not for it.
    const other = await resolveActor({ auth, db }, request(key, slugs.globex));
    expect(other).toEqual({
      ok: false,
      code: 'WORKSPACE_MISMATCH',
      message: `This API key belongs to the workspace "${slugs.acme}", not "${slugs.globex}". Use a key from "${slugs.globex}", or drop the x-zamu-workspace header.`,
    });
    expect(await workspaceOf(key, 'no-such-workspace')).toBe('WORKSPACE_MISMATCH');

    // The key wins over a session cookie sent alongside it, header included.
    expect(await workspaceOf({ ...key, cookie: gus.cookie }, slugs.globex)).toBe('WORKSPACE_MISMATCH');
  });

  it('keeps invalid keys UNAUTHORIZED whatever the header says', async () => {
    expect(await workspaceOf({ key: 'zamu_live_not-a-real-key' }, slugs.acme)).toBe('UNAUTHORIZED');
  });
});

describe('parseApiKeyMetadata', () => {
  const workspaceId = '0190b1d2-0000-7000-8000-000000000000';

  it('accepts objects and JSON strings', () => {
    expect(parseApiKeyMetadata({ workspaceId, projects: 'all', access: 'write' })).toEqual({
      workspaceId,
      projects: 'all',
      access: 'write',
    });
    expect(parseApiKeyMetadata(JSON.stringify({ workspaceId, projects: ['p1'], access: 'read' }))).toEqual({
      workspaceId,
      projects: ['p1'],
      access: 'read',
    });
  });

  it.each([
    null,
    'not json',
    [],
    { projects: 'all', access: 'read' },
    { workspaceId, projects: 'some', access: 'read' },
    { workspaceId, projects: [1], access: 'read' },
    { workspaceId, projects: 'all', access: 'admin' },
  ])('rejects %j', (value) => {
    expect(parseApiKeyMetadata(value)).toBeNull();
  });
});
