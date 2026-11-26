// /api/v1 with two workspaces: the x-zamu-workspace header picks a session's workspace, a key stays in
// its own, and the 401 and the two 403s (NOT_A_MEMBER, WORKSPACE_MISMATCH) come back as Problems.
import { bootstrapAdmin, createAuth } from '@zamu/auth';
import { type CoreContext, createApiKey, createProject } from '@zamu/core';
import { schema } from '@zamu/db';
import { createTestDatabase, type TestDatabase } from '@zamu/db/test';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { createApiFetchHandler } from './index';

const ORIGIN = 'http://localhost:3000';
const SECRET = 'test-secret-test-secret-test-secret-0123';
const PASSWORD = 'correct horse battery';

let database: TestDatabase;
let core: CoreContext;
let handle: (request: Request) => Promise<Response>;
let acme: string;
let globex: string;
/** Ada: owner of Acme, member of Globex. */
let adaCookie: string;
/** Bo: member of Globex only. */
let boCookie: string;
let acmeKey: string;

async function signIn(email: string): Promise<string> {
  const result = await core.auth.api.signInEmail({
    body: { email, password: PASSWORD },
    returnHeaders: true,
  });
  return result.headers
    .getSetCookie()
    .map((c) => c.split(';')[0])
    .join('; ');
}

async function person(name: string, email: string) {
  const [user] = await database.db.insert(schema.user).values({ name, email, kind: 'person' }).returning();
  if (!user) throw new Error('user insert failed');
  const context = await core.auth.$context;
  await database.db.insert(schema.account).values({
    accountId: user.id,
    providerId: 'credential',
    userId: user.id,
    password: await context.password.hash(PASSWORD),
  });
  return user;
}

async function get(path: string, headers: Record<string, string>) {
  const response = await handle(new Request(`${ORIGIN}${path}`, { headers }));
  // biome-ignore lint/suspicious/noExplicitAny: response bodies are checked field by field
  const body: any = await response.json();
  return { status: response.status, body };
}

beforeAll(async () => {
  database = await createTestDatabase({ prefix: 'pm_web_workspaces' });
  database.pool.on('error', () => {});
  const auth = createAuth({ db: database.db, secret: SECRET, baseUrl: ORIGIN });
  core = { db: database.db, auth, publicUrl: ORIGIN };
  handle = createApiFetchHandler(core);

  const setup = await bootstrapAdmin(core, {
    name: 'Ada',
    email: 'ada@example.com',
    password: PASSWORD,
    workspaceName: 'Acme',
  });
  acme = setup.workspaceId;
  const [second] = await database.db
    .insert(schema.organization)
    .values({ name: 'Globex', slug: 'globex' })
    .returning();
  if (!second) throw new Error('no globex');
  globex = second.id;
  await database.db.insert(schema.workspaceSlugAlias).values({ slug: 'globex-old', workspaceId: globex });
  const bo = await person('Bo', 'bo@example.com');
  await database.db.insert(schema.member).values([
    { organizationId: globex, userId: setup.userId, role: 'member' },
    { organizationId: globex, userId: bo.id, role: 'member' },
  ]);

  const adaInAcme = {
    userId: setup.userId,
    kind: 'person' as const,
    workspaceId: acme,
    role: 'owner' as const,
    onBehalfOfId: null,
  };
  const adaInGlobex = { ...adaInAcme, workspaceId: globex, role: 'member' as const };
  // The same project key in both workspaces.
  await createProject(core, adaInAcme, { key: 'PAY', name: 'Acme payments' });
  await createProject(core, { ...adaInGlobex, role: 'owner' }, { key: 'PAY', name: 'Globex payments' });
  acmeKey = (
    await createApiKey(core, adaInAcme, { name: 'acme', scope: { projects: 'all', access: 'read' } })
  ).key;

  adaCookie = await signIn('ada@example.com');
  boCookie = await signIn('bo@example.com');
}, 60_000);

afterAll(async () => {
  await database?.drop();
});

describe('/api/v1 and the workspace header', () => {
  it('reads the workspace the header names for a session, by slug or old slug', async () => {
    const inAcme = await get('/api/v1/projects', { cookie: adaCookie, 'x-zamu-workspace': 'acme' });
    expect(inAcme.status).toBe(200);
    expect(inAcme.body.items.map((p: { name: string }) => p.name)).toEqual(['Acme payments']);

    const inGlobex = await get('/api/v1/projects', { cookie: adaCookie, 'x-zamu-workspace': 'globex' });
    expect(inGlobex.body.items.map((p: { name: string }) => p.name)).toEqual(['Globex payments']);

    const byAlias = await get('/api/v1/projects', { cookie: adaCookie, 'x-zamu-workspace': 'globex-old' });
    expect(byAlias.body.items.map((p: { name: string }) => p.name)).toEqual(['Globex payments']);
  });

  it('uses the workspace used last without a header', async () => {
    const before = await get('/api/v1/projects', { cookie: adaCookie });
    expect(before.body.items.map((p: { name: string }) => p.name)).toEqual(['Acme payments']);
  });

  it('answers 403 NOT_A_MEMBER to a signed-in person outside the named workspace', async () => {
    const result = await get('/api/v1/projects', { cookie: boCookie, 'x-zamu-workspace': 'acme' });
    expect(result.status).toBe(403);
    expect(result.body).toMatchObject({
      status: 403,
      code: 'NOT_A_MEMBER',
      title: 'Not a member of this workspace',
      detail: 'You are not a member of the workspace "acme".',
    });
  });

  it('answers 401 without credentials, header or not', async () => {
    const result = await get('/api/v1/projects', { 'x-zamu-workspace': 'acme' });
    expect(result.status).toBe(401);
    expect(result.body).toMatchObject({ code: 'UNAUTHORIZED' });
  });

  it('keeps a key in its workspace and refuses another with 403 WORKSPACE_MISMATCH', async () => {
    const own = await get('/api/v1/projects', {
      authorization: `Bearer ${acmeKey}`,
      'x-zamu-workspace': 'acme',
    });
    expect(own.status).toBe(200);
    expect(own.body.items.map((p: { name: string }) => p.name)).toEqual(['Acme payments']);

    const other = await get('/api/v1/projects', {
      authorization: `Bearer ${acmeKey}`,
      'x-zamu-workspace': 'globex',
    });
    expect(other.status).toBe(403);
    expect(other.body).toMatchObject({ status: 403, code: 'WORKSPACE_MISMATCH' });
    expect(other.body.detail).toContain('"acme"');
  });
});
