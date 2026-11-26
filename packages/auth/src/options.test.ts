import { schema } from '@zamu/db';
import { createTestDatabase, type TestDatabase } from '@zamu/db/test';
import { eq } from 'drizzle-orm';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { bootstrapAdmin } from './bootstrap';
import { acceptInvitationWithSignUp } from './invitation';
import { WORKSPACE_ENDPOINT_BLOCKED, WORKSPACE_ENDPOINTS_BLOCKED } from './options';
import { cookieHeaders, TEST_BASE_URL, testAuth } from './testing/helpers';

const PASSWORD = 'correct horse battery';

// A plausible body for each endpoint, so a refusal comes from the guard and not from validation.
function bodyFor(path: string, ids: { workspaceId: string; memberId: string; userId: string }) {
  const { workspaceId, memberId } = ids;
  switch (path) {
    case '/organization/create':
      return { name: 'Globex', slug: 'globex' };
    case '/organization/update':
      return { organizationId: workspaceId, data: { name: 'Renamed', slug: 'renamed' } };
    case '/organization/delete':
    case '/organization/leave':
    case '/organization/set-active':
      return { organizationId: workspaceId };
    case '/organization/remove-member':
      return { organizationId: workspaceId, memberIdOrEmail: memberId };
    case '/organization/update-member-role':
      return { organizationId: workspaceId, memberId, role: 'admin' };
    default:
      return { organizationId: workspaceId };
  }
}

describe('Better Auth workspace endpoints', () => {
  let database: TestDatabase;
  let auth: ReturnType<typeof testAuth>;
  let ownerHeaders: Headers;
  let ids: { workspaceId: string; memberId: string; userId: string };

  beforeAll(async () => {
    database = await createTestDatabase();
    auth = testAuth(database.db);
    const { userId, workspaceId } = await bootstrapAdmin(
      { auth, db: database.db },
      { name: 'Ada', email: 'ada@example.com', password: PASSWORD, workspaceName: 'Acme' },
    );
    const signIn = await auth.api.signInEmail({
      body: { email: 'ada@example.com', password: PASSWORD },
      returnHeaders: true,
    });
    ownerHeaders = cookieHeaders(signIn.headers);
    const [member] = await database.db
      .select({ id: schema.member.id })
      .from(schema.member)
      .where(eq(schema.member.userId, userId));
    ids = { workspaceId, memberId: member?.id ?? '', userId };
  });

  afterAll(async () => {
    await database?.drop();
  });

  function post(path: string, body: unknown, headers: Headers = ownerHeaders) {
    return auth.handler(
      new Request(`${TEST_BASE_URL}/api/auth${path}`, {
        method: 'POST',
        headers: {
          cookie: headers.get('cookie') ?? '',
          'content-type': 'application/json',
          origin: TEST_BASE_URL,
        },
        body: JSON.stringify(body),
      }),
    );
  }

  it.each([
    '/organization/create',
    '/organization/update',
    '/organization/delete',
    '/organization/leave',
    '/organization/set-active',
    '/organization/remove-member',
    '/organization/update-member-role',
  ])('refuses POST %s for a signed-in owner', async (path) => {
    expect(WORKSPACE_ENDPOINTS_BLOCKED.has(path)).toBe(true);
    const response = await post(path, bodyFor(path, ids));
    expect(response.status).toBe(403);
    expect(await response.json()).toMatchObject({ code: WORKSPACE_ENDPOINT_BLOCKED });
  });

  it('leaves the workspace and its membership untouched', async () => {
    const [workspace] = await database.db
      .select()
      .from(schema.organization)
      .where(eq(schema.organization.id, ids.workspaceId));
    expect(workspace).toMatchObject({ name: 'Acme', slug: 'acme' });
    expect(await database.db.select().from(schema.organization)).toHaveLength(1);
    const members = await database.db.select().from(schema.member);
    expect(members).toEqual([expect.objectContaining({ userId: ids.userId, role: 'owner' })]);
  });

  it('refuses server-side calls too', async () => {
    const error = await auth.api
      .createOrganization({ headers: ownerHeaders, body: { name: 'Globex', slug: 'globex' } })
      .catch((e) => e);
    expect(error?.body?.code).toBe(WORKSPACE_ENDPOINT_BLOCKED);
    const setActive = await auth.api
      .setActiveOrganization({ headers: ownerHeaders, body: { organizationId: ids.workspaceId } })
      .catch((e) => e);
    expect(setActive?.body?.code).toBe(WORKSPACE_ENDPOINT_BLOCKED);
  });

  it('keeps the invitation flow: invite, read and accept with sign-up', async () => {
    const invitation = await auth.api.createInvitation({
      headers: ownerHeaders,
      body: { email: 'bob@example.com', role: 'member', organizationId: ids.workspaceId },
    });
    const read = await auth.handler(
      new Request(`${TEST_BASE_URL}/api/auth/organization/get-invitation?id=${invitation.id}`, {
        headers: { cookie: ownerHeaders.get('cookie') ?? '' },
      }),
    );
    // Better Auth answers for itself (only the invitee may read it); the guard stays out of the way.
    expect(((await read.json()) as { code?: string }).code).not.toBe(WORKSPACE_ENDPOINT_BLOCKED);

    const accepted = await acceptInvitationWithSignUp(
      { auth, db: database.db },
      { invitationId: invitation.id, name: 'Bob', password: PASSWORD },
    );
    expect(accepted.workspaceId).toBe(ids.workspaceId);
    const members = await database.db
      .select({ role: schema.member.role })
      .from(schema.member)
      .where(eq(schema.member.userId, accepted.userId));
    expect(members).toEqual([{ role: 'member' }]);
  });

  it('keeps accept-invitation over HTTP for a signed-in invitee', async () => {
    const [carol] = await database.db
      .insert(schema.user)
      .values({ name: 'Carol', email: 'carol@example.com', kind: 'person' })
      .returning();
    if (!carol) throw new Error('no carol');
    const context = await auth.$context;
    await database.db.insert(schema.account).values({
      accountId: carol.id,
      providerId: 'credential',
      userId: carol.id,
      password: await context.password.hash(PASSWORD),
    });
    const invitation = await auth.api.createInvitation({
      headers: ownerHeaders,
      body: { email: 'carol@example.com', role: 'member', organizationId: ids.workspaceId },
    });
    const signIn = await auth.api.signInEmail({
      body: { email: 'carol@example.com', password: PASSWORD },
      returnHeaders: true,
    });
    const response = await post(
      '/organization/accept-invitation',
      { invitationId: invitation.id },
      cookieHeaders(signIn.headers),
    );
    expect(response.status).toBe(200);
    const members = await database.db
      .select({ organizationId: schema.member.organizationId })
      .from(schema.member)
      .where(eq(schema.member.userId, carol.id));
    expect(members).toEqual([{ organizationId: ids.workspaceId }]);
  });
});
