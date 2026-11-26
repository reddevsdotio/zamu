// Which stored login a command uses (0.10, PM-40). One person or agent may hold keys for several
// workspaces, on one server or several, so every command picks one, in this order:
//   1. --workspace <slug>, matched on slug or id among the stored logins;
//   2. ZAMU_KEY (with ZAMU_URL), as before;
//   3. the login cached for this clone's git remote in $XDG_STATE_HOME/zamu/clones.json;
//   4. the login whose workspace links the remote, or has the project the nearest .zamu.json names
//      (each login lists its projects, in parallel, within the usual 5 seconds);
//   5. the default login.
// A single match in step 4 is cached until a command gets 403 or 404 with it; two or more stop the
// command with the --workspace values to pass. With one login (after ZAMU_URL narrows them) there is
// nothing to match. A 0.9 config file is converted here: one GET /me fills in the workspace.
import { readFile } from 'node:fs/promises';
import { join } from 'node:path';
import { ORPCError } from '@orpc/client';
import {
  CLI_CLONES_FILE_NAME,
  CliClonesFile,
  type CliWorkspaceSource,
  Me,
  ProjectList,
  parseRepositoryUrl,
  type WorkspaceRef,
} from '@zamu/contracts';
import type { ApiClient } from './client';
import { isNetworkFailure } from './client';
import {
  DEFAULT_URL,
  envKey,
  envUrl,
  isKnown,
  type KnownLogin,
  type Login,
  loginLabel,
  readLogins,
  updateLogins,
} from './config';
import { authError, type CliError, usageError } from './errors';
import { type FileIo, stateDir, withLock, writeAtomically } from './files';
import type { CliIo } from './io';
import { findProjectFile, gitRemote } from './project';

/** Builds a client for a login (with the source and workspace headers), without the offline queue. */
export type ClientFactory = (
  login: Pick<Login, 'url' | 'key' | 'workspace'> & { header?: string | null },
) => Promise<ApiClient>;

export interface PickedLogin {
  url: string;
  key: string;
  /** Null for a ZAMU_KEY that no stored login holds, and for a 0.9 login not converted yet. */
  workspace: WorkspaceRef | null;
  /** What the requests send as x-zamu-workspace: the workspace's slug, or the --workspace value. */
  header: string | null;
  source: CliWorkspaceSource;
  /** The stored login in use; null for a ZAMU_KEY that no stored login holds. */
  stored: Login | null;
  /** The clone's remote key when the login came from the clone cache: a 403 or 404 matches again. */
  cachedFor: string | null;
  /** The projects of this login, when the match listed them (project.ts reuses them). */
  projects: ProjectList | null;
  /** The failure of a request that got no answer while picking, if one did. */
  offline: unknown;
}

export interface PickOptions {
  /** --workspace. */
  flag?: string | undefined;
  /** Honour ZAMU_KEY. Default true; zamu logout and zamu workspaces look at stored logins only. */
  env?: boolean;
  /** Read the clone cache. Default true; false after the cached login got 403 or 404. */
  cache?: boolean;
  /** Several matches: throw (default), or return them (zamu workspaces shows them). */
  ambiguous?: 'throw' | 'return';
  makeClient: ClientFactory;
}

export type PickResult = PickedLogin | { ambiguous: KnownLogin[] };

// ---------------------------------------------------------------------------
// The clone cache
// ---------------------------------------------------------------------------

export function clonesPath(io: FileIo): string {
  return join(stateDir(io), CLI_CLONES_FILE_NAME);
}

async function readClones(io: FileIo): Promise<CliClonesFile> {
  const text = await readFile(clonesPath(io), 'utf8').catch(() => null);
  if (text !== null) {
    try {
      const parsed = CliClonesFile.safeParse(JSON.parse(text));
      if (parsed.success) return parsed.data;
    } catch {
      // Unreadable: start again. It only costs one match.
    }
  }
  return { version: 1, clones: {} };
}

/** Changes the clone cache. Best effort: the cache only saves requests, so a failure is ignored. */
async function changeClones(io: CliIo, change: (clones: CliClonesFile['clones']) => boolean): Promise<void> {
  try {
    const path = clonesPath(io);
    await withLock(
      path,
      async () => {
        const file = await readClones(io);
        const clones = { ...file.clones };
        if (change(clones)) await writeAtomically(path, { version: 1, clones });
      },
      { waitMs: 2_000 },
    );
  } catch {
    // See above.
  }
}

function rememberClone(io: CliIo, remoteKey: string, login: KnownLogin): Promise<void> {
  const matchedAt = new Date(io.now?.() ?? Date.now()).toISOString();
  return changeClones(io, (clones) => {
    clones[remoteKey] = { url: login.url, workspaceId: login.workspace.id, matchedAt };
    return true;
  });
}

/** Drops the cached login of a clone, so the next pick matches again. */
export function forgetClone(io: CliIo, remoteKey: string): Promise<void> {
  return changeClones(io, (clones) => {
    if (!(remoteKey in clones)) return false;
    delete clones[remoteKey];
    return true;
  });
}

/** Drops every cached clone that points at one of these logins (zamu logout). */
export function forgetClonesOf(io: CliIo, logins: readonly KnownLogin[]): Promise<void> {
  return changeClones(io, (clones) => {
    let changed = false;
    for (const [remote, entry] of Object.entries(clones)) {
      if (logins.some((login) => login.url === entry.url && login.workspace.id === entry.workspaceId)) {
        delete clones[remote];
        changed = true;
      }
    }
    return changed;
  });
}

// ---------------------------------------------------------------------------
// Matching
// ---------------------------------------------------------------------------

interface CloneFacts {
  /** host/path of the git remote, lowercase; null outside a clone or without a remote. */
  remoteKey: string | null;
  /** The project the nearest .zamu.json names. */
  fileProject: string | null;
}

async function cloneFacts(io: CliIo): Promise<CloneFacts> {
  const remote = await gitRemote(io);
  const remoteKey = remote ? (parseRepositoryUrl(remote.url)?.key ?? null) : null;
  // A broken .zamu.json is reported by the project lookup, which reads it again.
  const file = await findProjectFile(io).catch(() => null);
  return { remoteKey, fileProject: file?.project ?? null };
}

interface Match {
  matches: KnownLogin[];
  projects: Map<KnownLogin, ProjectList>;
  /** The network failure per server that didn't answer. */
  offline: Map<string, unknown>;
}

/**
 * Lists the projects of every login at once. A login matches when one of its projects links the
 * remote; when none does, when one has the project of the .zamu.json. A login that refuses (revoked
 * key) or doesn't answer simply doesn't match.
 */
async function matchClone(
  logins: KnownLogin[],
  facts: CloneFacts,
  makeClient: ClientFactory,
): Promise<Match> {
  const offline = new Map<string, unknown>();
  const projects = new Map<KnownLogin, ProjectList>();
  await Promise.all(
    logins.map(async (login) => {
      try {
        const client = await makeClient(login);
        projects.set(login, ProjectList.parse(await client.projects.list()));
      } catch (error) {
        if (isNetworkFailure(error)) offline.set(login.url, error);
      }
    }),
  );
  const linked = logins.filter((login) =>
    projects
      .get(login)
      ?.items.some(
        (project) =>
          project.repository && parseRepositoryUrl(project.repository)?.key === (facts.remoteKey ?? ''),
      ),
  );
  if (linked.length > 0 || !facts.fileProject) return { matches: linked, projects, offline };
  const named = logins.filter((login) =>
    projects.get(login)?.items.some((project) => project.key === facts.fileProject),
  );
  return { matches: named, projects, offline };
}

// ---------------------------------------------------------------------------
// Conversion of a 0.9 config
// ---------------------------------------------------------------------------

/**
 * Fills in the workspace of a 0.9 login with GET /me and writes the file back as version 2.
 * Offline, the login stays as it is (and still works); a refusal (revoked key) is the command's
 * error, as it would have been before.
 */
async function convert(
  io: CliIo,
  login: Login,
  makeClient: ClientFactory,
): Promise<{ login: Login; offline: unknown }> {
  let workspace: WorkspaceRef;
  try {
    const client = await makeClient(login);
    workspace = Me.parse(await client.me.get()).workspace;
  } catch (error) {
    if (isNetworkFailure(error)) return { login, offline: error };
    throw error;
  }
  const converted: KnownLogin = { ...login, workspace, default: true };
  await updateLogins(io, (stored) => {
    // Another process may have converted it, or logged in, meanwhile: keep what it wrote.
    if (stored.every(isKnown)) return stored;
    const known = stored.filter(isKnown);
    return [converted, ...known.filter((other) => !sameLogin(other, converted))];
  });
  return { login: converted, offline: null };
}

// ---------------------------------------------------------------------------
// The pick
// ---------------------------------------------------------------------------

export function sameLogin(a: Pick<Login, 'url' | 'workspace'>, b: Pick<Login, 'url' | 'workspace'>): boolean {
  return a.url === b.url && a.workspace !== null && a.workspace.id === b.workspace?.id;
}

/** Logins whose workspace slug (any case) or id is `value`. */
export function loginsNamed(logins: readonly Login[], value: string): KnownLogin[] {
  const wanted = value.trim().toLowerCase();
  return logins
    .filter(isKnown)
    .filter((login) => login.workspace.slug.toLowerCase() === wanted || login.workspace.id === value.trim());
}

/** "  --workspace acme     Acme on http://zamu.test", one per login, for the ambiguous error. */
function choices(logins: readonly KnownLogin[]): string[] {
  const slugs = new Map<string, number>();
  for (const login of logins) slugs.set(login.workspace.slug, (slugs.get(login.workspace.slug) ?? 0) + 1);
  const values = logins.map((login) =>
    // Two servers with the same slug: only the id tells them apart.
    (slugs.get(login.workspace.slug) ?? 0) > 1 ? login.workspace.id : login.workspace.slug,
  );
  const width = Math.max(...values.map((value) => value.length));
  return logins.map(
    (login, index) => `--workspace ${(values[index] as string).padEnd(width)}  ${loginLabel(login)}`,
  );
}

/** The usage error for a clone (or a --workspace value) that matches several logins. */
export function ambiguousError(logins: readonly KnownLogin[], why: string): CliError {
  const lines = choices(logins);
  const detail = `${why} Pass --workspace to pick one: ${lines.map((line) => line.replace(/\s+/g, ' ')).join('; ')}.`;
  const failure = usageError(detail, [{ path: 'workspace', message: why }], []);
  failure.lines = [`zamu: ${why} Pass --workspace to pick one:`, ...lines.map((line) => `  ${line}`)];
  return failure;
}

function picked(
  login: Login,
  source: CliWorkspaceSource,
  extra: Partial<Pick<PickedLogin, 'cachedFor' | 'projects' | 'offline'>> = {},
): PickedLogin {
  return {
    url: login.url,
    key: login.key,
    workspace: login.workspace,
    header: login.workspace?.slug ?? null,
    source,
    stored: login,
    cachedFor: extra.cachedFor ?? null,
    projects: extra.projects ?? null,
    offline: extra.offline ?? null,
  };
}

/** The ZAMU_KEY login: the stored login with that key when there is one, so its workspace is known. */
function fromEnv(io: CliIo, key: string, logins: readonly Login[], flag?: string): PickedLogin {
  const url = envUrl(io);
  const stored = logins.find((login) => login.key === key && (url === null || login.url === url));
  const fallbackUrl = logins.find((login) => login.default)?.url ?? logins[0]?.url ?? DEFAULT_URL;
  return {
    url: url ?? stored?.url ?? fallbackUrl,
    key,
    workspace: stored?.workspace ?? null,
    // A --workspace that names no stored login still reaches the server, which refuses a key used
    // for another workspace (WORKSPACE_MISMATCH).
    header: flag?.trim() || stored?.workspace?.slug || null,
    source: 'env',
    stored: stored ?? null,
    cachedFor: null,
    projects: null,
    offline: null,
  };
}

function notLoggedIn(): CliError {
  return authError('Not logged in.', [
    'Run zamu login --key <key> (once per workspace), or set ZAMU_KEY (and ZAMU_URL).',
  ]);
}

/**
 * The login for this command, by the order at the top of this file. Throws when there is none, when
 * --workspace names no stored login, or (unless `ambiguous: 'return'`) when the clone matches several.
 */
export async function pickLogin(io: CliIo, options: PickOptions): Promise<PickResult> {
  const { flag, makeClient } = options;
  const useEnv = options.env ?? true;
  const key = useEnv ? envKey(io) : undefined;
  let logins = await readLogins(io);
  const url = envUrl(io);

  // A 0.9 file holds one login: convert it when it is the one in use (not when ZAMU_KEY is).
  const legacy = logins.find((login) => !isKnown(login));
  if (legacy) {
    const login = url ? { ...legacy, url } : legacy;
    if (key && flag === undefined) return fromEnv(io, key, [login]);
    const { login: current, offline } = await convert(io, login, makeClient);
    if (!isKnown(current)) {
      // Offline: the 0.9 login stays usable as it is.
      const old = picked(current, flag !== undefined ? 'flag' : 'default', { offline });
      return flag !== undefined ? { ...old, header: flag.trim() } : old;
    }
    logins = [current];
  }

  const candidates = url ? logins.filter((login) => login.url === url) : logins;

  if (flag !== undefined) {
    const named = loginsNamed(candidates, flag);
    if (named.length === 1) return picked(named[0] as KnownLogin, 'flag');
    if (named.length > 1) throw ambiguousError(named, `--workspace ${flag} matches ${named.length} logins.`);
    if (key) return fromEnv(io, key, logins, flag);
    const known = logins.filter(isKnown);
    throw usageError(
      `No login for workspace ${flag}${url ? ` on ${url}` : ''}.`,
      [{ path: 'workspace', message: `No login for workspace ${flag}` }],
      [
        known.length
          ? `Stored logins: ${known.map((login) => login.workspace.slug).join(', ')} (zamu workspaces lists them).`
          : 'There are no stored logins.',
        `Run zamu login --key <key>${url ? '' : ' --url <server>'} with a key of that workspace.`,
      ],
    );
  }

  if (key) return fromEnv(io, key, logins);
  if (logins.length === 0) throw notLoggedIn();
  if (candidates.length === 0) {
    throw authError(`No login for ${url}.`, [
      `Run zamu login --key <key> --url ${url}, or unset ZAMU_URL to use your stored logins.`,
    ]);
  }
  const fallback =
    candidates.find((login) => login.default) ?? (candidates.length === 1 ? candidates[0] : null);
  if (candidates.length === 1) return picked(candidates[0] as Login, 'default');

  const known = candidates.filter(isKnown);
  const facts = await cloneFacts(io);
  if (facts.remoteKey && options.cache !== false) {
    const entry = (await readClones(io)).clones[facts.remoteKey];
    const cached =
      entry && known.find((login) => login.url === entry.url && login.workspace.id === entry.workspaceId);
    if (cached) return picked(cached, 'clone', { cachedFor: facts.remoteKey });
  }
  let offline = new Map<string, unknown>();
  if (facts.remoteKey || facts.fileProject) {
    const match = await matchClone(known, facts, makeClient);
    offline = match.offline;
    if (match.matches.length === 1) {
      const found = match.matches[0] as KnownLogin;
      if (facts.remoteKey) await rememberClone(io, facts.remoteKey, found);
      return picked(found, 'clone', { projects: match.projects.get(found) ?? null });
    }
    if (match.matches.length > 1) {
      if (options.ambiguous === 'return') return { ambiguous: match.matches };
      throw ambiguousError(match.matches, `This clone matches ${match.matches.length} logins.`);
    }
  }
  // The default's server didn't answer the match: the command needn't wait for it again.
  if (fallback) return picked(fallback, 'default', { offline: offline.get(fallback.url) ?? null });
  // ZAMU_URL left several logins and the default is not among them.
  if (options.ambiguous === 'return') return { ambiguous: known };
  throw ambiguousError(known, `There are ${known.length} logins for ${url}.`);
}

/** True when a failure means the login may be the wrong one for this clone: 403 or 404. */
export function refusedForClone(error: unknown): boolean {
  return error instanceof ORPCError && (error.status === 403 || error.status === 404);
}
