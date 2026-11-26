import { bootstrapAdmin, isFirstRun } from '@zamu/auth';
import { cookieHeaders, testAuth } from '@zamu/auth/testing/helpers';
import { schema } from '@zamu/db';
import { createTestDatabase, type TestDatabase } from '@zamu/db/test';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { loadInstanceName, loadInvitation } from './queries';

// Real Postgres (throwaway database), as everywhere else: never mock the database.
describe('signed-out screen queries', () => {
  let database: TestDatabase;
  let auth: ReturnType<typeof testAuth>;
  let adminHeaders: Headers;
  let workspaceId: string;

  async function invite(email: string) {
    return auth.api.createInvitation({
      headers: adminHeaders,
      body: { email, role: 'member', organizationId: workspaceId },
    });
  }

  beforeAll(async () => {
    database = await createTestDatabase();
    auth = testAuth(database.db);
  }, 30_000);

  afterAll(async () => {
    await database?.drop();
  });

  it('before setup: first run, no instance name', async () => {
    expect(await isFirstRun(database.db)).toBe(true);
    expect(await loadInstanceName(database.db)).toBeNull();
  });

  it('after setup: the first workspace names the instance', async () => {
    const result = await bootstrapAdmin(
      { auth, db: database.db },
      {
        name: 'Ana Ruiz',
        email: 'ana@reddevs.io',
        password: 'correct-horse-battery',
        workspaceName: 'Reddevs',
      },
    );
    workspaceId = result.workspaceId;
    const signIn = await auth.api.signInEmail({
      body: { email: 'ana@reddevs.io', password: 'correct-horse-battery' },
      returnHeaders: true,
    });
    adminHeaders = cookieHeaders(signIn.headers);

    expect(await isFirstRun(database.db)).toBe(false);
    expect(await loadInstanceName(database.db)).toBe('Reddevs');
  });

  it('a pending invitation shows its email, workspace and inviter', async () => {
    const invitation = await invite('tomas@reddevs.io');
    expect(await loadInvitation(database.db, invitation.id)).toEqual({
      state: 'pending',
      email: 'tomas@reddevs.io',
      workspaceName: 'Reddevs',
      workspaceSlug: 'reddevs',
      inviterName: 'Ana Ruiz',
      hasAccount: false,
    });
  });

  it('a pending invitation for an email with an account says so', async () => {
    await database.db.insert(schema.user).values({ name: 'Dana', email: 'dana@reddevs.io', kind: 'person' });
    const invitation = await invite('Dana@Reddevs.io');
    expect(await loadInvitation(database.db, invitation.id)).toMatchObject({
      state: 'pending',
      hasAccount: true,
    });
  });

  it('an invitation past its expiry date is expired', async () => {
    const invitation = await invite('late@reddevs.io');
    const later = new Date(invitation.expiresAt.getTime() + 1000);
    expect((await loadInvitation(database.db, invitation.id, later)).state).toBe('expired');
  });

  it('an accepted invitation is used', async () => {
    const invitation = await invite('bea@reddevs.io');
    const signUp = await auth.api.signUpEmail({
      body: { name: 'Bea', email: 'bea@reddevs.io', password: 'long enough password' },
      returnHeaders: true,
    });
    await auth.api.acceptInvitation({
      headers: cookieHeaders(signUp.headers),
      body: { invitationId: invitation.id },
    });
    expect((await loadInvitation(database.db, invitation.id)).state).toBe('used');
  });

  it('a canceled invitation is canceled', async () => {
    const invitation = await invite('carl@reddevs.io');
    await auth.api.cancelInvitation({ headers: adminHeaders, body: { invitationId: invitation.id } });
    expect((await loadInvitation(database.db, invitation.id)).state).toBe('canceled');
  });

  it('unknown and malformed ids are not found', async () => {
    const notFound = {
      state: 'not-found',
      email: null,
      workspaceName: null,
      workspaceSlug: null,
      inviterName: null,
      hasAccount: false,
    };
    expect(await loadInvitation(database.db, '00000000-0000-4000-8000-000000000000')).toEqual(notFound);
    expect(await loadInvitation(database.db, 'not-a-uuid')).toEqual(notFound);
  });
});
