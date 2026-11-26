import { createDb, schema } from '@zamu/db';
import { createTestDatabase, type TestDatabase } from '@zamu/db/test';
import { eq } from 'drizzle-orm';
import { afterEach, describe, expect, it } from 'vitest';
import { getActorFromRequest } from './actor';
import { createAuth } from './auth';
import { BootstrapError, bootstrapAdmin, isFirstRun, setupState, slugify } from './bootstrap';
import { readAuthConfig } from './config';
import { cookieHeaders, TEST_BASE_URL, TEST_SECRET, testAuth } from './testing/helpers';

const admin = {
  name: 'Ada Lovelace',
  email: 'Ada@Example.com',
  password: 'correct horse battery',
  workspaceName: 'Reddevs',
};

describe('first-run bootstrap', () => {
  let database: TestDatabase | undefined;

  afterEach(async () => {
    await database?.drop();
    database = undefined;
  });

  it('creates the admin, the workspace and the owner membership, then signs in', async () => {
    database = await createTestDatabase();
    const { db } = database;
    const auth = testAuth(db);

    expect(await isFirstRun(db)).toBe(true);
    const { userId, workspaceId } = await bootstrapAdmin({ auth, db }, admin);
    expect(await isFirstRun(db)).toBe(false);

    const [user] = await db.select().from(schema.user).where(eq(schema.user.id, userId));
    expect(user).toMatchObject({ name: 'Ada Lovelace', email: 'ada@example.com', kind: 'person' });
    const [workspace] = await db
      .select()
      .from(schema.organization)
      .where(eq(schema.organization.id, workspaceId));
    expect(workspace).toMatchObject({ name: 'Reddevs', slug: 'reddevs' });
    expect(user?.lastWorkspaceId).toBe(workspaceId);
    const members = await db.select().from(schema.member).where(eq(schema.member.userId, userId));
    expect(members).toEqual([expect.objectContaining({ organizationId: workspaceId, role: 'owner' })]);

    const signIn = await auth.api.signInEmail({
      body: { email: 'ada@example.com', password: admin.password },
      returnHeaders: true,
    });
    const actor = await getActorFromRequest({ auth, db }, { headers: cookieHeaders(signIn.headers) });
    expect(actor).toEqual({ userId, kind: 'person', workspaceId, role: 'owner', onBehalfOfId: null });
  });

  it('refuses a second bootstrap', async () => {
    database = await createTestDatabase();
    const { db } = database;
    const auth = testAuth(db);
    await bootstrapAdmin({ auth, db }, admin);

    const error = await bootstrapAdmin({ auth, db }, { ...admin, email: 'eve@example.com' }).catch((e) => e);
    expect(error).toBeInstanceOf(BootstrapError);
    expect(error.code).toBe('ALREADY_SET_UP');
    expect(await db.select().from(schema.user)).toHaveLength(1);
  });

  it('lets only one of two concurrent bootstraps win', async () => {
    database = await createTestDatabase();
    const { db } = database;
    const auth = testAuth(db);
    const results = await Promise.allSettled([
      bootstrapAdmin({ auth, db }, admin),
      bootstrapAdmin({ auth, db }, { ...admin, email: 'eve@example.com' }),
    ]);
    expect(results.filter((r) => r.status === 'fulfilled')).toHaveLength(1);
    expect(await db.select().from(schema.organization)).toHaveLength(1);
  });

  it('validates input before touching the database', async () => {
    database = await createTestDatabase();
    const { db } = database;
    const auth = testAuth(db);
    const error = await bootstrapAdmin({ auth, db }, { ...admin, password: 'short' }).catch((e) => e);
    expect(error).toBeInstanceOf(BootstrapError);
    expect(error.code).toBe('INVALID_INPUT');
    expect(await isFirstRun(db)).toBe(true);
  });

  it('slugifies workspace names with the workspace slug rule', () => {
    expect(slugify('Reddevs  Ops!')).toBe('reddevs-ops');
    expect(slugify('Équipe Café')).toBe('equipe-cafe');
    expect(slugify('***')).toBe('workspace');
    expect(slugify('42 Labs')).toBe('w-42-labs');
    expect(slugify('Admin')).toBe('admin-workspace');
    expect(slugify('x'.repeat(60))).toHaveLength(40);
  });

  it('gives the first workspace the OIDC_WORKSPACE slug when it is set', async () => {
    database = await createTestDatabase();
    const { db } = database;
    const auth = createAuth({
      db,
      secret: TEST_SECRET,
      baseUrl: TEST_BASE_URL,
      config: readAuthConfig({
        OIDC_ISSUER: 'https://auth.example.com',
        OIDC_CLIENT_ID: 'zamu',
        OIDC_CLIENT_SECRET: 'secret',
        OIDC_WORKSPACE: 'acme',
      }),
    });
    const { workspaceId } = await bootstrapAdmin({ auth, db }, { ...admin, workspaceName: 'Acme Corp' });
    const [workspace] = await db
      .select({ slug: schema.organization.slug })
      .from(schema.organization)
      .where(eq(schema.organization.id, workspaceId));
    expect(workspace?.slug).toBe('acme');
  });

  it('never reopens setup once a workspace existed', async () => {
    database = await createTestDatabase();
    const { db } = database;
    const auth = testAuth(db);
    expect(await setupState(db)).toBe('account');
    const { userId, workspaceId } = await bootstrapAdmin({ auth, db }, admin);
    expect(await setupState(db)).toBe('done');

    // A second workspace, then the first one goes: still done.
    const [second] = await db
      .insert(schema.organization)
      .values({ name: 'Globex', slug: 'globex' })
      .returning();
    if (!second) throw new Error('no second workspace');
    await db.insert(schema.user).values({ name: 'Bo', email: 'bo@example.com', kind: 'person' });
    await db.delete(schema.organization).where(eq(schema.organization.id, workspaceId));
    expect(await setupState(db)).toBe('done');

    // Every workspace deleted, on a fresh connection that has not seen one: still done, since more
    // than one person exists.
    await db.delete(schema.organization).where(eq(schema.organization.id, second.id));
    const fresh = createDb(database.url);
    try {
      expect(await setupState(fresh.db)).toBe('done');
    } finally {
      await fresh.pool.end();
    }
    expect(userId).toBeTruthy();
  });

  it('keeps setup open for the first person alone, as after setup through SSO', async () => {
    database = await createTestDatabase();
    const { db } = database;
    await db.insert(schema.user).values({ name: 'Ada', email: 'ada@example.com', kind: 'person' });
    expect(await setupState(db)).toBe('workspace');
  });
});
