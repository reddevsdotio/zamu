import { schema } from '@zamu/db';
import { createTestDatabase, type TestDatabase } from '@zamu/db/test';
import { and, eq } from 'drizzle-orm';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { getActorFromRequest } from './actor';
import { createAuth } from './auth';
import { BootstrapError, bootstrapAdmin, bootstrapWorkspace, setupState } from './bootstrap';
import { type AuthConfig, readAuthConfig } from './config';
import { acceptInvitationWithSignUp } from './invitation';
import { oidcWorkspaceProblem } from './sso';
import { cookieHeaders, TEST_BASE_URL, TEST_SECRET } from './testing/helpers';
import { type MockIdentity, type MockOidc, startMockOidc } from './testing/mock-oidc';
import { ssoSignIn } from './testing/sso-flow';

const PASSWORD = 'correct horse battery';

function ssoConfig(mock: MockOidc, extra: Record<string, string> = {}): AuthConfig {
  return readAuthConfig({
    OIDC_ISSUER: mock.issuer,
    OIDC_CLIENT_ID: 'zamu',
    OIDC_CLIENT_SECRET: 'mock-secret',
    OIDC_PROVIDER_NAME: 'Authentik',
    ...extra,
  });
}

function person(email: string, extra: Partial<MockIdentity> = {}): MockIdentity {
  return { sub: `sub-${email}`, email, email_verified: true, name: email.split('@')[0], ...extra };
}

async function usersByEmail(database: TestDatabase, email: string) {
  return database.db.select().from(schema.user).where(eq(schema.user.email, email));
}

async function membership(database: TestDatabase, userId: string) {
  const rows = await database.db.select().from(schema.member).where(eq(schema.member.userId, userId));
  return rows.map((row) => ({ organizationId: row.organizationId, role: row.role }));
}

async function oidcAccounts(database: TestDatabase, userId: string) {
  return database.db
    .select()
    .from(schema.account)
    .where(and(eq(schema.account.userId, userId), eq(schema.account.providerId, 'oidc')));
}

let mock: MockOidc;

beforeAll(async () => {
  mock = await startMockOidc();
});

afterAll(async () => {
  await mock?.stop();
});

describe('SSO: discovery and setup', () => {
  let database: TestDatabase;
  let auth: ReturnType<typeof createAuth>;

  beforeAll(async () => {
    database = await createTestDatabase();
    auth = createAuth({
      db: database.db,
      secret: TEST_SECRET,
      baseUrl: TEST_BASE_URL,
      config: ssoConfig(mock),
    });
  });

  afterAll(async () => {
    await database?.drop();
  });

  it('builds the authorization request from discovery, with PKCE, nonce and the documented callback', async () => {
    const result = await ssoSignIn(auth, mock, person('nobody@example.com'), { intent: 'signin' });
    const params = result.authorizationUrl.searchParams;
    expect(`${result.authorizationUrl.origin}${result.authorizationUrl.pathname}`).toBe(
      `${mock.issuer}/authorize`,
    );
    expect(params.get('client_id')).toBe('zamu');
    expect(params.get('redirect_uri')).toBe(`${TEST_BASE_URL}/api/auth/oauth2/callback/oidc`);
    expect(params.get('code_challenge_method')).toBe('S256');
    expect(params.get('code_challenge')).toBeTruthy();
    expect(params.get('nonce')).toBeTruthy();
    expect(params.get('scope')?.split(' ')).toEqual(expect.arrayContaining(['openid', 'email', 'profile']));
    expect(result.callbackUrl.pathname).toBe('/api/auth/oauth2/callback/oidc');
    // First run: only the setup screen may create the first account.
    expect(result.error).toBe('sso_not_set_up');
    expect(result.location.pathname).toBe('/signin');
    expect(await database.db.select().from(schema.user)).toEqual([]);
  });

  it('refuses an unverified email on setup', async () => {
    const result = await ssoSignIn(auth, mock, person('eve@example.com', { email_verified: false }), {
      intent: 'setup',
      errorCallbackURL: '/setup',
    });
    expect(result.error).toBe('sso_email_not_verified');
    expect(result.location.pathname).toBe('/setup');
    expect(await database.db.select().from(schema.user)).toEqual([]);
  });

  it('creates the first person through setup, then the workspace in step 2', async () => {
    expect(await setupState(database.db)).toBe('account');
    const result = await ssoSignIn(auth, mock, person('ada@example.com', { name: 'Ada Lovelace' }), {
      intent: 'setup',
      callbackURL: '/setup',
      errorCallbackURL: '/setup',
    });
    expect(result.error).toBeNull();
    expect(result.location.pathname).toBe('/setup');

    const [ada] = await usersByEmail(database, 'ada@example.com');
    expect(ada).toMatchObject({ name: 'Ada Lovelace', kind: 'person', emailVerified: true });
    if (!ada) throw new Error('no user');
    expect(await oidcAccounts(database, ada.id)).toHaveLength(1);
    expect(await membership(database, ada.id)).toEqual([]);
    expect(await setupState(database.db)).toBe('workspace');

    const session = await auth.api.getSession({ headers: new Headers({ cookie: result.cookie }) });
    expect(session?.user.id).toBe(ada.id);

    const { workspaceId } = await bootstrapWorkspace(
      { db: database.db },
      { userId: ada.id, workspaceName: 'Reddevs' },
    );
    expect(await membership(database, ada.id)).toEqual([{ organizationId: workspaceId, role: 'owner' }]);
    expect(await setupState(database.db)).toBe('done');
    const actor = await getActorFromRequest(
      { auth, db: database.db },
      { headers: new Headers({ cookie: result.cookie }) },
    );
    expect(actor).toMatchObject({ userId: ada.id, role: 'owner', workspaceId });

    const again = await bootstrapWorkspace(
      { db: database.db },
      { userId: ada.id, workspaceName: 'Other' },
    ).catch((error) => error);
    expect(again).toBeInstanceOf(BootstrapError);
    expect(again.code).toBe('ALREADY_SET_UP');
  });

  it('refuses setup via SSO once a person exists', async () => {
    const result = await ssoSignIn(auth, mock, person('mallory@example.com'), {
      intent: 'setup',
      errorCallbackURL: '/setup',
    });
    expect(result.error).toBe('sso_already_set_up');
    expect(await usersByEmail(database, 'mallory@example.com')).toEqual([]);
  });

  it('signs the admin in again through SSO', async () => {
    const result = await ssoSignIn(auth, mock, person('ada@example.com'));
    expect(result.error).toBeNull();
    expect(result.location.pathname).toBe('/');
  });
});

describe('SSO: setup is race-free', () => {
  let database: TestDatabase;

  afterAll(async () => {
    await database?.drop();
  });

  it('lets exactly one of three simultaneous setups create the admin', async () => {
    database = await createTestDatabase();
    const auth = createAuth({
      db: database.db,
      secret: TEST_SECRET,
      baseUrl: TEST_BASE_URL,
      config: ssoConfig(mock),
    });
    const results = await Promise.all(
      ['one@example.com', 'two@example.com', 'three@example.com'].map((email) =>
        ssoSignIn(auth, mock, person(email), { intent: 'setup', errorCallbackURL: '/setup' }),
      ),
    );
    expect(results.filter((result) => result.error === null)).toHaveLength(1);
    expect(results.filter((result) => result.error === 'sso_already_set_up')).toHaveLength(2);
    expect(await database.db.select().from(schema.user)).toHaveLength(1);
  });

  it('bootstrapWorkspace only accepts the first person', async () => {
    const [first] = await database.db.select().from(schema.user);
    if (!first) throw new Error('no user');
    const error = await bootstrapWorkspace(
      { db: database.db },
      { userId: '0190b1d2-0000-7000-8000-000000000000', workspaceName: 'Mine' },
    ).catch((e) => e);
    expect(error).toBeInstanceOf(BootstrapError);
    expect(error.code).toBe('NOT_SETUP_ADMIN');
    expect(await database.db.select().from(schema.organization)).toEqual([]);
  });
});

describe('SSO: invite mode', () => {
  let database: TestDatabase;
  let auth: ReturnType<typeof createAuth>;
  let adminHeaders: Headers;
  let workspaceId: string;
  let adminId: string;

  async function invite(email: string, role: 'member' | 'admin' = 'member') {
    return auth.api.createInvitation({
      headers: adminHeaders,
      body: { email, role, organizationId: workspaceId },
    });
  }

  beforeAll(async () => {
    database = await createTestDatabase();
    auth = createAuth({
      db: database.db,
      secret: TEST_SECRET,
      baseUrl: TEST_BASE_URL,
      config: ssoConfig(mock),
    });
    const result = await bootstrapAdmin(
      { auth, db: database.db },
      { name: 'Ada', email: 'ada@example.com', password: PASSWORD, workspaceName: 'Reddevs' },
    );
    workspaceId = result.workspaceId;
    adminId = result.userId;
    const signIn = await auth.api.signInEmail({
      body: { email: 'ada@example.com', password: PASSWORD },
      returnHeaders: true,
    });
    adminHeaders = cookieHeaders(signIn.headers);
  });

  afterAll(async () => {
    await database?.drop();
  });

  it('links an existing person by verified email and signs them in', async () => {
    const result = await ssoSignIn(auth, mock, person('Ada@Example.com'));
    expect(result.error).toBeNull();
    expect(await oidcAccounts(database, adminId)).toHaveLength(1);
    const actor = await getActorFromRequest(
      { auth, db: database.db },
      { headers: new Headers({ cookie: result.cookie }) },
    );
    expect(actor).toMatchObject({ userId: adminId, kind: 'person', role: 'owner', workspaceId });
    // Password sign-in keeps working.
    await expect(
      auth.api.signInEmail({ body: { email: 'ada@example.com', password: PASSWORD } }),
    ).resolves.toBeTruthy();
  });

  it('refuses to link an unverified email', async () => {
    await invite('bob@example.com');
    await acceptInvitationWithSignUp(
      { auth, db: database.db },
      {
        invitationId: (
          await database.db
            .select({ id: schema.invitation.id })
            .from(schema.invitation)
            .where(eq(schema.invitation.email, 'bob@example.com'))
        )[0]?.id as string,
        name: 'Bob',
        password: PASSWORD,
      },
    );
    const [bob] = await usersByEmail(database, 'bob@example.com');
    if (!bob) throw new Error('no bob');
    const result = await ssoSignIn(auth, mock, person('bob@example.com', { email_verified: false }));
    expect(result.error).toBe('account_not_linked');
    expect(result.cookie).toBe('');
    expect(await oidcAccounts(database, bob.id)).toEqual([]);
  });

  it('refuses an unknown identity without an invitation', async () => {
    const result = await ssoSignIn(auth, mock, person('stranger@example.com'));
    expect(result.error).toBe('sso_no_account');
    expect(await usersByEmail(database, 'stranger@example.com')).toEqual([]);
  });

  it('accepts a pending invitation from the sign-in screen', async () => {
    const invitation = await invite('carol@example.com', 'admin');
    const result = await ssoSignIn(auth, mock, person('carol@example.com', { name: 'Carol' }));
    expect(result.error).toBeNull();
    const [carol] = await usersByEmail(database, 'carol@example.com');
    if (!carol) throw new Error('no carol');
    expect(carol).toMatchObject({ name: 'Carol', kind: 'person' });
    expect(await membership(database, carol.id)).toEqual([{ organizationId: workspaceId, role: 'admin' }]);
    const [row] = await database.db
      .select({ status: schema.invitation.status })
      .from(schema.invitation)
      .where(eq(schema.invitation.id, invitation.id));
    expect(row?.status).toBe('accepted');
  });

  it('accepts an invitation from its link when the verified email matches', async () => {
    const invitation = await invite('dan@example.com');
    const result = await ssoSignIn(auth, mock, person('dan@example.com'), {
      intent: 'invite',
      invitationId: invitation.id,
      errorCallbackURL: `/invite/${invitation.id}`,
    });
    expect(result.error).toBeNull();
    const [dan] = await usersByEmail(database, 'dan@example.com');
    if (!dan) throw new Error('no dan');
    expect(await membership(database, dan.id)).toEqual([{ organizationId: workspaceId, role: 'member' }]);

    const reused = await ssoSignIn(auth, mock, person('dan@example.com'), {
      intent: 'invite',
      invitationId: invitation.id,
      errorCallbackURL: `/invite/${invitation.id}`,
    });
    expect(reused.error).toBe('sso_invitation_not_usable');
  });

  it('refuses an invitation when the verified email differs, and creates nothing', async () => {
    const invitation = await invite('erin@example.com');
    const result = await ssoSignIn(auth, mock, person('erin.private@example.com'), {
      intent: 'invite',
      invitationId: invitation.id,
      errorCallbackURL: `/invite/${invitation.id}`,
    });
    expect(result.error).toBe('sso_invitation_email_mismatch');
    expect(result.location.pathname).toBe(`/invite/${invitation.id}`);
    expect(await usersByEmail(database, 'erin.private@example.com')).toEqual([]);
    const [row] = await database.db
      .select({ status: schema.invitation.status })
      .from(schema.invitation)
      .where(eq(schema.invitation.id, invitation.id));
    expect(row?.status).toBe('pending');
  });

  it('never matches or links an agent', async () => {
    const [agent] = await database.db
      .insert(schema.user)
      .values({ name: 'claude-dev', email: 'claude@example.com', kind: 'agent', responsibleUserId: adminId })
      .returning();
    if (!agent) throw new Error('no agent');
    await database.db
      .insert(schema.member)
      .values({ organizationId: workspaceId, userId: agent.id, role: 'member' });

    const result = await ssoSignIn(auth, mock, person('claude@example.com'));
    expect(result.error).toBe('sso_account_not_allowed');
    expect(result.cookie).toBe('');
    expect(await oidcAccounts(database, agent.id)).toEqual([]);

    const placeholder = await ssoSignIn(auth, mock, person('claude-dev.0190b1d2@agents.invalid'));
    expect(placeholder.error).toBe('sso_account_not_allowed');
  });

  it('ignores a kind claim: SSO accounts are always people', async () => {
    await invite('frank@example.com');
    const result = await ssoSignIn(auth, mock, person('frank@example.com', { kind: 'agent' }));
    expect(result.error).toBeNull();
    const [frank] = await usersByEmail(database, 'frank@example.com');
    expect(frank?.kind).toBe('person');
  });

  it('brings provider errors back to the screen', async () => {
    mock.denyNext();
    const result = await ssoSignIn(auth, mock, person('ada@example.com'));
    expect(result.error).toBe('access_denied');
    expect(result.location.pathname).toBe('/signin');
  });

  it('refuses a person who is no longer a member', async () => {
    const result = await ssoSignIn(auth, mock, person('gina@example.com'));
    expect(result.error).toBe('sso_no_account');
    await invite('gina@example.com');
    expect((await ssoSignIn(auth, mock, person('gina@example.com'))).error).toBeNull();
    const [gina] = await usersByEmail(database, 'gina@example.com');
    if (!gina) throw new Error('no gina');
    await database.db.delete(schema.member).where(eq(schema.member.userId, gina.id));
    const again = await ssoSignIn(auth, mock, person('gina@example.com'));
    expect(again.error).toBe('sso_no_account');
    expect(again.cookie).toBe('');
  });
});

describe('SSO: auto mode and admin groups', () => {
  let database: TestDatabase;
  let auth: ReturnType<typeof createAuth>;
  let workspaceId: string;
  let ownerId: string;

  beforeAll(async () => {
    database = await createTestDatabase();
    auth = createAuth({
      db: database.db,
      secret: TEST_SECRET,
      baseUrl: TEST_BASE_URL,
      config: ssoConfig(mock, { OIDC_SIGNUP: 'auto', OIDC_ADMIN_GROUPS: 'reddevs-sso-admins, ops' }),
    });
    const result = await bootstrapAdmin(
      { auth, db: database.db },
      { name: 'Ada', email: 'ada@example.com', password: PASSWORD, workspaceName: 'Reddevs' },
    );
    workspaceId = result.workspaceId;
    ownerId = result.userId;
  });

  afterAll(async () => {
    await database?.drop();
  });

  it('gives anyone the provider authenticates a member account', async () => {
    const result = await ssoSignIn(auth, mock, person('hank@example.com'));
    expect(result.error).toBeNull();
    const [hank] = await usersByEmail(database, 'hank@example.com');
    if (!hank) throw new Error('no hank');
    expect(await membership(database, hank.id)).toEqual([{ organizationId: workspaceId, role: 'member' }]);
  });

  it('still refuses unverified emails', async () => {
    const result = await ssoSignIn(auth, mock, person('ivy@example.com', { email_verified: false }));
    expect(result.error).toBe('sso_email_not_verified');
    expect(await usersByEmail(database, 'ivy@example.com')).toEqual([]);
  });

  it('makes members of an admin group admins, and demotes them when they leave it', async () => {
    const promoted = await ssoSignIn(auth, mock, person('jo@example.com', { groups: ['staff', 'ops'] }));
    expect(promoted.error).toBeNull();
    const [jo] = await usersByEmail(database, 'jo@example.com');
    if (!jo) throw new Error('no jo');
    expect(await membership(database, jo.id)).toEqual([{ organizationId: workspaceId, role: 'admin' }]);
    const actor = await getActorFromRequest(
      { auth, db: database.db },
      { headers: new Headers({ cookie: promoted.cookie }) },
    );
    expect(actor?.role).toBe('admin');

    await ssoSignIn(auth, mock, person('jo@example.com', { groups: ['staff'] }));
    expect(await membership(database, jo.id)).toEqual([{ organizationId: workspaceId, role: 'member' }]);

    await ssoSignIn(auth, mock, person('jo@example.com', { groups: ['reddevs-sso-admins'] }));
    expect(await membership(database, jo.id)).toEqual([{ organizationId: workspaceId, role: 'admin' }]);
  });

  it('never demotes the owner', async () => {
    const result = await ssoSignIn(auth, mock, person('ada@example.com', { groups: [] }));
    expect(result.error).toBeNull();
    expect(await membership(database, ownerId)).toEqual([{ organizationId: workspaceId, role: 'owner' }]);
  });

  it('refuses an invitation with a different email even in auto mode', async () => {
    const signIn = await auth.api.signInEmail({
      body: { email: 'ada@example.com', password: PASSWORD },
      returnHeaders: true,
    });
    const invitation = await auth.api.createInvitation({
      headers: cookieHeaders(signIn.headers),
      body: { email: 'kim@example.com', role: 'member', organizationId: workspaceId },
    });
    const result = await ssoSignIn(auth, mock, person('kim.other@example.com'), {
      intent: 'invite',
      invitationId: invitation.id,
      errorCallbackURL: `/invite/${invitation.id}`,
    });
    expect(result.error).toBe('sso_invitation_email_mismatch');
    expect(await usersByEmail(database, 'kim.other@example.com')).toEqual([]);
  });
});

describe('SSO: the SSO workspace with several workspaces', () => {
  let database: TestDatabase;
  let acme: string;
  let globex: string;
  let ownerHeaders: Headers;

  function authWith(extra: Record<string, string>) {
    return createAuth({
      db: database.db,
      secret: TEST_SECRET,
      baseUrl: TEST_BASE_URL,
      config: ssoConfig(mock, { OIDC_SIGNUP: 'auto', OIDC_ADMIN_GROUPS: 'admins', ...extra }),
    });
  }

  beforeAll(async () => {
    database = await createTestDatabase();
    const auth = authWith({});
    const result = await bootstrapAdmin(
      { auth, db: database.db },
      { name: 'Ada', email: 'ada@example.com', password: PASSWORD, workspaceName: 'Acme' },
    );
    acme = result.workspaceId;
    const [second] = await database.db
      .insert(schema.organization)
      .values({ name: 'Globex', slug: 'globex' })
      .returning();
    if (!second) throw new Error('no globex');
    globex = second.id;
    await database.db
      .insert(schema.member)
      .values({ organizationId: globex, userId: result.userId, role: 'owner' });
    await database.db.insert(schema.workspaceSlugAlias).values({ slug: 'globex-old', workspaceId: globex });
    const signIn = await auth.api.signInEmail({
      body: { email: 'ada@example.com', password: PASSWORD },
      returnHeaders: true,
    });
    ownerHeaders = cookieHeaders(signIn.headers);
  });

  afterAll(async () => {
    await database?.drop();
  });

  it('joins the oldest workspace without OIDC_WORKSPACE', async () => {
    const result = await ssoSignIn(authWith({}), mock, person('ola@example.com'));
    expect(result.error).toBeNull();
    const [ola] = await usersByEmail(database, 'ola@example.com');
    if (!ola) throw new Error('no ola');
    expect(await membership(database, ola.id)).toEqual([{ organizationId: acme, role: 'member' }]);
    expect(ola.lastWorkspaceId).toBe(acme);
  });

  it('joins the workspace OIDC_WORKSPACE names, by slug or old slug', async () => {
    const bySlug = await ssoSignIn(authWith({ OIDC_WORKSPACE: 'globex' }), mock, person('pia@example.com'));
    expect(bySlug.error).toBeNull();
    const [pia] = await usersByEmail(database, 'pia@example.com');
    if (!pia) throw new Error('no pia');
    expect(await membership(database, pia.id)).toEqual([{ organizationId: globex, role: 'member' }]);

    const byAlias = await ssoSignIn(
      authWith({ OIDC_WORKSPACE: 'globex-old' }),
      mock,
      person('quin@example.com'),
    );
    expect(byAlias.error).toBeNull();
    const [quin] = await usersByEmail(database, 'quin@example.com');
    if (!quin) throw new Error('no quin');
    expect(await membership(database, quin.id)).toEqual([{ organizationId: globex, role: 'member' }]);
  });

  it('applies admin groups in the SSO workspace only', async () => {
    const [rae] = await database.db
      .insert(schema.user)
      .values({ name: 'Rae', email: 'rae@example.com', kind: 'person' })
      .returning();
    if (!rae) throw new Error('no rae');
    await database.db.insert(schema.member).values([
      { organizationId: acme, userId: rae.id, role: 'member' },
      { organizationId: globex, userId: rae.id, role: 'member' },
    ]);
    const auth = authWith({ OIDC_WORKSPACE: 'globex' });
    const promoted = await ssoSignIn(auth, mock, person('rae@example.com', { groups: ['admins'] }));
    expect(promoted.error).toBeNull();
    const roles = Object.fromEntries(
      (await membership(database, rae.id)).map((row) => [row.organizationId, row.role]),
    );
    expect(roles).toEqual({ [acme]: 'member', [globex]: 'admin' });

    await ssoSignIn(auth, mock, person('rae@example.com', { groups: [] }));
    const after = Object.fromEntries(
      (await membership(database, rae.id)).map((row) => [row.organizationId, row.role]),
    );
    expect(after).toEqual({ [acme]: 'member', [globex]: 'member' });
  });

  it('does not add back someone who left the SSO workspace but belongs to another', async () => {
    const [sol] = await database.db
      .insert(schema.user)
      .values({ name: 'Sol', email: 'sol@example.com', kind: 'person' })
      .returning();
    if (!sol) throw new Error('no sol');
    await database.db
      .insert(schema.member)
      .values({ organizationId: globex, userId: sol.id, role: 'member' });
    const result = await ssoSignIn(authWith({}), mock, person('sol@example.com'));
    expect(result.error).toBeNull();
    expect(await membership(database, sol.id)).toEqual([{ organizationId: globex, role: 'member' }]);
  });

  it('accepts an invitation link for someone already in another workspace', async () => {
    const auth = authWith({});
    const [tia] = await database.db
      .insert(schema.user)
      .values({ name: 'Tia', email: 'tia@example.com', kind: 'person' })
      .returning();
    if (!tia) throw new Error('no tia');
    await database.db.insert(schema.member).values({ organizationId: acme, userId: tia.id, role: 'member' });
    const invitation = await auth.api.createInvitation({
      headers: ownerHeaders,
      body: { email: 'tia@example.com', role: 'admin', organizationId: globex },
    });
    const result = await ssoSignIn(auth, mock, person('tia@example.com'), {
      intent: 'invite',
      invitationId: invitation.id,
      errorCallbackURL: `/invite/${invitation.id}`,
    });
    expect(result.error).toBeNull();
    const roles = Object.fromEntries(
      (await membership(database, tia.id)).map((row) => [row.organizationId, row.role]),
    );
    expect(roles).toEqual({ [acme]: 'member', [globex]: 'admin' });
    const [after] = await usersByEmail(database, 'tia@example.com');
    expect(after?.lastWorkspaceId).toBe(globex);
  });

  it('refuses new identities when OIDC_WORKSPACE names no workspace, and says so at startup', async () => {
    const auth = authWith({ OIDC_WORKSPACE: 'initech' });
    const result = await ssoSignIn(auth, mock, person('uma@example.com'));
    expect(result.error).toBe('sso_no_account');
    expect(await usersByEmail(database, 'uma@example.com')).toEqual([]);

    expect(await oidcWorkspaceProblem(database.db, { workspace: 'initech' })).toBe(
      'OIDC_WORKSPACE is "initech", but no workspace has that slug. Set it to the slug of an existing workspace (its URL is /w/<slug>/), or unset it to use the oldest workspace.',
    );
    expect(await oidcWorkspaceProblem(database.db, { workspace: 'globex' })).toBeNull();
    expect(await oidcWorkspaceProblem(database.db, { workspace: 'globex-old' })).toBeNull();
    expect(await oidcWorkspaceProblem(database.db, { workspace: null })).toBeNull();
    expect(await oidcWorkspaceProblem(database.db, null)).toBeNull();
  });

  it('does not check OIDC_WORKSPACE before setup', async () => {
    const empty = await createTestDatabase();
    try {
      expect(await oidcWorkspaceProblem(empty.db, { workspace: 'initech' })).toBeNull();
    } finally {
      await empty.drop();
    }
  });
});

describe('SSO: password sign-in disabled', () => {
  let database: TestDatabase;
  let auth: ReturnType<typeof createAuth>;

  beforeAll(async () => {
    database = await createTestDatabase();
    auth = createAuth({
      db: database.db,
      secret: TEST_SECRET,
      baseUrl: TEST_BASE_URL,
      config: ssoConfig(mock, { PASSWORD_LOGIN: 'disabled', OIDC_WORKSPACE: 'acme' }),
    });
  });

  afterAll(async () => {
    await database?.drop();
  });

  it('refuses password setup, so the admin comes from SSO', async () => {
    const error = await bootstrapAdmin(
      { auth, db: database.db },
      { name: 'Ada', email: 'ada@example.com', password: PASSWORD, workspaceName: 'Reddevs' },
    ).catch((e) => e);
    expect(error).toBeInstanceOf(BootstrapError);
    expect(error.code).toBe('PASSWORD_LOGIN_DISABLED');

    const result = await ssoSignIn(auth, mock, person('ada@example.com'), { intent: 'setup' });
    expect(result.error).toBeNull();
    const [ada] = await usersByEmail(database, 'ada@example.com');
    if (!ada) throw new Error('no ada');
    // Setup step 2 gives the workspace the OIDC_WORKSPACE slug, so the startup check finds it.
    const { workspaceId } = await bootstrapWorkspace(
      { db: database.db, auth },
      { userId: ada.id, workspaceName: 'Reddevs' },
    );
    const [workspace] = await database.db
      .select({ slug: schema.organization.slug })
      .from(schema.organization)
      .where(eq(schema.organization.id, workspaceId));
    expect(workspace?.slug).toBe('acme');
    expect(await oidcWorkspaceProblem(database.db, { workspace: 'acme' })).toBeNull();
  });

  it('refuses password sign-in over HTTP', async () => {
    // Give the admin a password anyway, as if it had been set before passwords were turned off.
    const [ada] = await usersByEmail(database, 'ada@example.com');
    if (!ada) throw new Error('no ada');
    const context = await auth.$context;
    await database.db.insert(schema.account).values({
      accountId: ada.id,
      providerId: 'credential',
      userId: ada.id,
      password: await context.password.hash(PASSWORD),
    });
    const response = await auth.handler(
      new Request(`${TEST_BASE_URL}/api/auth/sign-in/email`, {
        method: 'POST',
        headers: { 'content-type': 'application/json', origin: TEST_BASE_URL },
        body: JSON.stringify({ email: 'ada@example.com', password: PASSWORD }),
      }),
    );
    expect(response.status).toBe(403);
    expect(await response.json()).toMatchObject({ code: 'PASSWORD_LOGIN_DISABLED' });
    const error = await auth.api
      .signInEmail({ body: { email: 'ada@example.com', password: PASSWORD } })
      .catch((e) => e);
    expect(error?.body?.code).toBe('PASSWORD_LOGIN_DISABLED');
  });

  it('refuses password invitation accept', async () => {
    const signedIn = await ssoSignIn(auth, mock, person('ada@example.com'));
    const [workspace] = await database.db.select().from(schema.organization);
    const invitation = await auth.api.createInvitation({
      headers: new Headers({ cookie: signedIn.cookie }),
      body: { email: 'lee@example.com', role: 'member', organizationId: workspace?.id as string },
    });
    const error = await acceptInvitationWithSignUp(
      { auth, db: database.db },
      { invitationId: invitation.id, name: 'Lee', password: PASSWORD },
    ).catch((e) => e);
    expect(error.code).toBe('PASSWORD_LOGIN_DISABLED');
    expect(await usersByEmail(database, 'lee@example.com')).toEqual([]);
  });
});

describe('SSO: OIDC_TRUST_EMAIL', () => {
  let database: TestDatabase;
  let strict: ReturnType<typeof createAuth>;
  let trusting: ReturnType<typeof createAuth>;
  let adminHeaders: Headers;
  let workspaceId: string;
  let adminId: string;

  // Authentik's managed email mapping always sends email_verified: false.
  const unverified = (email: string, extra: Partial<MockIdentity> = {}) =>
    person(email, { email_verified: false, ...extra });

  async function invite(email: string) {
    return strict.api.createInvitation({
      headers: adminHeaders,
      body: { email, role: 'member', organizationId: workspaceId },
    });
  }

  beforeAll(async () => {
    database = await createTestDatabase();
    const options = { db: database.db, secret: TEST_SECRET, baseUrl: TEST_BASE_URL };
    strict = createAuth({ ...options, config: ssoConfig(mock) });
    trusting = createAuth({ ...options, config: ssoConfig(mock, { OIDC_TRUST_EMAIL: 'true' }) });
    const result = await bootstrapAdmin(
      { auth: strict, db: database.db },
      { name: 'Ada', email: 'ada@example.com', password: PASSWORD, workspaceName: 'Reddevs' },
    );
    workspaceId = result.workspaceId;
    adminId = result.userId;
    const signIn = await strict.api.signInEmail({
      body: { email: 'ada@example.com', password: PASSWORD },
      returnHeaders: true,
    });
    adminHeaders = cookieHeaders(signIn.headers);
  });

  afterAll(async () => {
    await database?.drop();
  });

  it('links an existing person only when the email is trusted', async () => {
    const refused = await ssoSignIn(strict, mock, unverified('ada@example.com'));
    expect(refused.error).toBe('account_not_linked');
    expect(await oidcAccounts(database, adminId)).toEqual([]);

    const linked = await ssoSignIn(trusting, mock, unverified('ada@example.com'));
    expect(linked.error).toBeNull();
    expect(await oidcAccounts(database, adminId)).toHaveLength(1);
    const actor = await getActorFromRequest(
      { auth: trusting, db: database.db },
      { headers: new Headers({ cookie: linked.cookie }) },
    );
    expect(actor).toMatchObject({ userId: adminId, role: 'owner', workspaceId });
  });

  it('accepts an invitation by its link only when the email is trusted, and still checks the address', async () => {
    const invitation = await invite('tomas@example.com');
    const flow = {
      intent: 'invite' as const,
      invitationId: invitation.id,
      errorCallbackURL: `/invite/${invitation.id}`,
    };

    const refused = await ssoSignIn(strict, mock, unverified('tomas@example.com'), flow);
    expect(refused.error).toBe('sso_email_not_verified');
    expect(await usersByEmail(database, 'tomas@example.com')).toEqual([]);

    const mismatch = await ssoSignIn(trusting, mock, unverified('tomas.other@example.com'), flow);
    expect(mismatch.error).toBe('sso_invitation_email_mismatch');
    expect(await usersByEmail(database, 'tomas.other@example.com')).toEqual([]);

    const accepted = await ssoSignIn(trusting, mock, unverified('tomas@example.com'), flow);
    expect(accepted.error).toBeNull();
    const [tomas] = await usersByEmail(database, 'tomas@example.com');
    if (!tomas) throw new Error('no tomas');
    expect(await membership(database, tomas.id)).toEqual([{ organizationId: workspaceId, role: 'member' }]);
  });

  it('creates an invited account from the sign-in screen when email_verified is missing', async () => {
    await invite('lee@example.com');
    const refused = await ssoSignIn(
      strict,
      mock,
      unverified('lee@example.com', { email_verified: undefined }),
    );
    expect(refused.error).toBe('sso_email_not_verified');

    const accepted = await ssoSignIn(
      trusting,
      mock,
      unverified('lee@example.com', { email_verified: undefined }),
    );
    expect(accepted.error).toBeNull();
    const [lee] = await usersByEmail(database, 'lee@example.com');
    expect(lee).toMatchObject({ kind: 'person', emailVerified: true });
  });

  it('still refuses identities without an invitation in invite mode', async () => {
    const result = await ssoSignIn(trusting, mock, unverified('stranger@example.com'));
    expect(result.error).toBe('sso_no_account');
    expect(await usersByEmail(database, 'stranger@example.com')).toEqual([]);
  });
});
