// First-run setup: the first person, the first workspace and its owner, and where setup stands. Setup
// happens once per server: once a workspace exists it never reopens, whatever is created or deleted later.
import { suggestWorkspaceSlug, workspaceSlugWithNumber } from '@zamu/contracts';
import { type Db, type DbOrTx, schema, type Tx } from '@zamu/db';
import { asc, eq, sql } from 'drizzle-orm';
import type { Auth } from './auth';
import { MIN_PASSWORD_LENGTH } from './options';
import { authConfigOf } from './settings';
import { findWorkspaceBySlug } from './workspace';

/** Better Auth's default maximum password length. */
const MAX_PASSWORD_LENGTH = 128;

/** Advisory lock key that serialises first-run setup (bootstrapAdmin, SSO setup, bootstrapWorkspace). */
export const BOOTSTRAP_LOCK_KEY = 7_331_001;

/** Databases known to have users. A deleted last user is not a supported state, so this never resets. */
const setUp = new WeakSet<object>();

/** Databases known to have a workspace. Like `setUp`, this never resets. */
const hasWorkspace = new WeakSet<object>();

/** True when no user exists yet, so the instance still needs its first admin. */
export async function isFirstRun(db: DbOrTx): Promise<boolean> {
  if (setUp.has(db)) return false;
  const rows = await db.select({ id: schema.user.id }).from(schema.user).limit(1);
  if (rows.length > 0) {
    setUp.add(db);
    return false;
  }
  return true;
}

export type BootstrapErrorCode =
  | 'ALREADY_SET_UP'
  | 'INVALID_INPUT'
  /** PASSWORD_LOGIN=disabled: the admin is created through SSO instead. */
  | 'PASSWORD_LOGIN_DISABLED'
  /** bootstrapWorkspace: the caller is not the person who started setup. */
  | 'NOT_SETUP_ADMIN';

export class BootstrapError extends Error {
  constructor(
    readonly code: BootstrapErrorCode,
    message: string,
  ) {
    super(message);
    this.name = 'BootstrapError';
  }
}

export interface BootstrapAdminInput {
  name: string;
  email: string;
  password: string;
  workspaceName: string;
}

export interface BootstrapAdminResult {
  userId: string;
  workspaceId: string;
}

/**
 * The slug suggested for a workspace name, following the workspace slug rule of @zamu/contracts
 * (suggestWorkspaceSlug): "Acme Corp." gives `acme-corp`.
 */
export function slugify(value: string): string {
  return suggestWorkspaceSlug(value);
}

/**
 * The slug of the first workspace: OIDC_WORKSPACE when it is set, so single sign-on finds the workspace
 * it names, else one suggested from the name. A number is appended while the slug is taken.
 */
async function firstWorkspaceSlug(tx: Tx, auth: Auth | undefined, workspaceName: string): Promise<string> {
  const base = (auth && authConfigOf(auth).sso?.workspace) || slugify(workspaceName);
  for (let n = 1; ; n++) {
    const candidate = workspaceSlugWithNumber(base, n);
    if (!(await findWorkspaceBySlug(tx, candidate))) return candidate;
  }
}

function validate(input: BootstrapAdminInput): BootstrapAdminInput {
  const name = input.name.trim();
  const email = input.email.trim().toLowerCase();
  const workspaceName = input.workspaceName.trim();
  if (!name) throw new BootstrapError('INVALID_INPUT', 'Name is required.');
  if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email))
    throw new BootstrapError('INVALID_INPUT', 'Email is invalid.');
  if (!workspaceName) throw new BootstrapError('INVALID_INPUT', 'Workspace name is required.');
  if (input.password.length < MIN_PASSWORD_LENGTH) {
    throw new BootstrapError('INVALID_INPUT', `Password needs ${MIN_PASSWORD_LENGTH} characters or more.`);
  }
  if (input.password.length > MAX_PASSWORD_LENGTH) {
    throw new BootstrapError('INVALID_INPUT', `Password is longer than ${MAX_PASSWORD_LENGTH} characters.`);
  }
  return { name, email, password: input.password, workspaceName };
}

/**
 * First-run setup: creates the admin user with a password, the workspace and the owner membership
 * in one transaction. Throws BootstrapError('ALREADY_SET_UP') once any user exists.
 * The caller signs the admin in afterwards (auth.api.signInEmail).
 */
export async function bootstrapAdmin(
  { auth, db }: { auth: Auth; db: Db },
  input: BootstrapAdminInput,
): Promise<BootstrapAdminResult> {
  if (!authConfigOf(auth).passwordLogin) {
    throw new BootstrapError('PASSWORD_LOGIN_DISABLED', 'Password sign-in is turned off on this server.');
  }
  const { name, email, password, workspaceName } = validate(input);
  const context = await auth.$context;
  const passwordHash = await context.password.hash(password);

  const result = await db.transaction(async (tx) => {
    await tx.execute(sql`select pg_advisory_xact_lock(${BOOTSTRAP_LOCK_KEY})`);
    if (!(await isFirstRun(tx))) {
      throw new BootstrapError('ALREADY_SET_UP', 'This instance already has an admin.');
    }
    const [user] = await tx.insert(schema.user).values({ name, email, kind: 'person' }).returning();
    if (!user) throw new Error('bootstrapAdmin: user insert returned no row');
    await tx.insert(schema.account).values({
      accountId: user.id,
      providerId: 'credential',
      userId: user.id,
      password: passwordHash,
    });
    const [workspace] = await tx
      .insert(schema.organization)
      .values({ name: workspaceName, slug: await firstWorkspaceSlug(tx, auth, workspaceName) })
      .returning();
    if (!workspace) throw new Error('bootstrapAdmin: organization insert returned no row');
    await tx.insert(schema.member).values({ organizationId: workspace.id, userId: user.id, role: 'owner' });
    await tx.update(schema.user).set({ lastWorkspaceId: workspace.id }).where(eq(schema.user.id, user.id));
    return { userId: user.id, workspaceId: workspace.id };
  });

  setUp.add(db);
  hasWorkspace.add(db);
  return result;
}

/**
 * Where first-run setup stands:
 * - `account`: nobody exists yet; the first person to finish step 1 (password or SSO) becomes the admin.
 * - `workspace`: the admin signed up through SSO but has not named the workspace yet.
 * - `done`: a workspace exists, or did: deleting workspaces never reopens setup.
 */
export type SetupState = 'account' | 'workspace' | 'done';

export async function setupState(db: DbOrTx): Promise<SetupState> {
  if (hasWorkspace.has(db)) return 'done';
  const [workspace] = await db.select({ id: schema.organization.id }).from(schema.organization).limit(1);
  if (workspace) {
    hasWorkspace.add(db);
    return 'done';
  }
  // No workspace now. Before setup only the first person can exist (new SSO identities are refused
  // until it finishes), and everyone else joins through a workspace, so a second user means a workspace
  // existed and has since been deleted. Setup stays done; people go on from the no-workspace screen.
  const users = await db.select({ id: schema.user.id }).from(schema.user).limit(2);
  if (users.length === 0) return 'account';
  if (users.length > 1) {
    hasWorkspace.add(db);
    return 'done';
  }
  return 'workspace';
}

export interface BootstrapWorkspaceInput {
  /** The signed-in person who completed setup step 1 through SSO. */
  userId: string;
  workspaceName: string;
}

/**
 * Setup step 2 after SSO: creates the workspace with `userId` as its owner. Only the first person may
 * do this, and only while setup is not done (same advisory lock as bootstrapAdmin). Pass `auth` so the
 * workspace takes the OIDC_WORKSPACE slug when it is set.
 */
export async function bootstrapWorkspace(
  { db, auth }: { db: Db; auth?: Auth },
  input: BootstrapWorkspaceInput,
): Promise<BootstrapAdminResult> {
  const workspaceName = input.workspaceName.trim();
  if (!workspaceName) throw new BootstrapError('INVALID_INPUT', 'Workspace name is required.');

  const result = await db.transaction(async (tx) => {
    await tx.execute(sql`select pg_advisory_xact_lock(${BOOTSTRAP_LOCK_KEY})`);
    if ((await setupState(tx)) === 'done') {
      throw new BootstrapError('ALREADY_SET_UP', 'This server already has a workspace.');
    }
    const [first] = await tx
      .select({ id: schema.user.id, kind: schema.user.kind })
      .from(schema.user)
      .orderBy(asc(schema.user.createdAt), asc(schema.user.id))
      .limit(1);
    if (first?.id !== input.userId || first.kind !== 'person') {
      throw new BootstrapError(
        'NOT_SETUP_ADMIN',
        'Only the person who started setup can name the workspace.',
      );
    }
    const [workspace] = await tx
      .insert(schema.organization)
      .values({ name: workspaceName, slug: await firstWorkspaceSlug(tx, auth, workspaceName) })
      .returning();
    if (!workspace) throw new Error('bootstrapWorkspace: organization insert returned no row');
    await tx.insert(schema.member).values({ organizationId: workspace.id, userId: first.id, role: 'owner' });
    await tx.update(schema.user).set({ lastWorkspaceId: workspace.id }).where(eq(schema.user.id, first.id));
    return { userId: first.id, workspaceId: workspace.id };
  });

  hasWorkspace.add(db);
  return result;
}
