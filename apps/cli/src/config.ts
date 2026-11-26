// Stored logins: $XDG_CONFIG_HOME/zamu/config.json (fallback ~/.config/zamu/config.json), mode 0600.
// From 0.10 the file holds one login per server and workspace ({ version: 2, logins }), one of them
// the default. A file from 0.9 ({ url, key }) is read as one login whose workspace is not known yet;
// the first command that reaches the server converts it (workspace.ts). ZAMU_URL and ZAMU_KEY still
// override the file, so agents in CI never need to write it.
import { readFile, rm } from 'node:fs/promises';
import { dirname, isAbsolute, join } from 'node:path';
import { CliConfigFile, CliConfigFileV1, type CliLogin, type WorkspaceRef } from '@zamu/contracts';
import { z } from 'zod';
import { usageError } from './errors';
import { type FileIo, withLock, writeAtomically } from './files';
import type { CliIo } from './io';

/** Server used by `zamu login` when neither --url, ZAMU_URL nor a stored login says otherwise. */
export const DEFAULT_URL = 'http://localhost:3000';

/**
 * One stored login. `workspace` is null only for the login of a 0.9 file that no command has
 * converted yet (the server was not reached since the upgrade).
 */
export interface Login {
  url: string;
  key: string;
  workspace: WorkspaceRef | null;
  default: boolean;
}

/** A converted login: what the version 2 file holds. */
export type KnownLogin = Login & { workspace: WorkspaceRef };

export function isKnown(login: Login): login is KnownLogin {
  return login.workspace !== null;
}

export function configPath(io: FileIo): string {
  const xdg = io.env.XDG_CONFIG_HOME;
  // The XDG spec says relative values are invalid and must be ignored.
  const base = xdg && isAbsolute(xdg) ? xdg : join(io.homeDir, '.config');
  return join(base, 'zamu', 'config.json');
}

/** The stored logins, oldest first. No file is no logins; a 0.9 file is one login without a workspace. */
export async function readLogins(io: FileIo): Promise<Login[]> {
  const path = configPath(io);
  let text: string;
  try {
    text = await readFile(path, 'utf8');
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') return [];
    throw usageError(`Cannot read ${path}: ${(error as Error).message}`);
  }
  let json: unknown;
  try {
    json = JSON.parse(text);
  } catch {
    throw usageError(`${path} is not valid JSON. Run zamu logout --all, then zamu login again.`);
  }
  const current = CliConfigFile.safeParse(json);
  if (current.success) return current.data.logins.map((login) => ({ ...login, url: trimUrl(login.url) }));
  const old = CliConfigFileV1.safeParse(json);
  if (old.success && (json as { version?: unknown }).version === undefined) {
    return [{ url: trimUrl(old.data.url), key: old.data.key, workspace: null, default: true }];
  }
  const version = (json as { version?: unknown } | null)?.version;
  if (typeof version === 'number' && version > 2) {
    throw usageError(`${path} was written by a newer zamu. Update zamu to use it.`);
  }
  throw usageError(`${path} is not a valid zamu config. Run zamu logout --all, then zamu login again.`);
}

/** The logins as the version 2 file stores them. Exactly one is the default when there are any. */
function toFile(logins: KnownLogin[]): CliConfigFile {
  const first = logins.findIndex((login) => login.default);
  const marked = logins.map((login, index) => ({
    url: login.url,
    key: login.key,
    workspace: { id: login.workspace.id, name: login.workspace.name, slug: login.workspace.slug },
    default: first === -1 ? index === 0 : index === first,
  }));
  return CliConfigFile.parse({ version: 2, logins: marked });
}

/**
 * Changes the stored logins under the config's lock: `change` gets what is stored now and returns
 * the logins to keep. No logins left removes the file. Returns the logins written.
 */
export async function updateLogins(
  io: FileIo,
  change: (logins: Login[]) => KnownLogin[] | Promise<KnownLogin[]>,
): Promise<CliLogin[]> {
  const path = configPath(io);
  return withLock(
    path,
    async () => {
      const next = await change(await readLogins(io));
      if (next.length === 0) {
        await rm(path, { force: true });
        return [];
      }
      const file = toFile(next);
      await writeAtomically(path, file);
      return file.logins;
    },
    { what: path },
  );
}

/** Removes the config file and every login in it. Returns what it held. */
export async function deleteConfig(io: FileIo): Promise<Login[]> {
  const path = configPath(io);
  return withLock(
    path,
    async () => {
      let logins: Login[] = [];
      try {
        logins = await readLogins(io);
      } catch {
        // An unreadable config is removed all the same.
      }
      await rm(path, { force: true });
      return logins;
    },
    { what: path },
  );
}

/** The directory the config lives in, for messages. */
export function configDir(io: FileIo): string {
  return dirname(configPath(io));
}

function trimUrl(url: string): string {
  return url.replace(/\/+$/, '');
}

/** Strips trailing slashes so `${url}/api/v1` never doubles them. */
export function normalizeUrl(value: string): string {
  const parsed = z.url({ protocol: /^https?$/ }).safeParse(value.trim());
  if (!parsed.success) throw usageError(`Not an http(s) URL: ${value}`);
  return trimUrl(parsed.data);
}

/** API key from the environment: ZAMU_KEY, or ZAMU_API_KEY (what the dev seed prints). */
export function envKey(io: Pick<CliIo, 'env'>): string | undefined {
  return io.env.ZAMU_KEY || io.env.ZAMU_API_KEY || undefined;
}

/** The environment variable that holds the key in use, for messages. */
export function envKeyName(io: Pick<CliIo, 'env'>): string {
  return io.env.ZAMU_KEY ? 'ZAMU_KEY' : 'ZAMU_API_KEY';
}

/** ZAMU_URL, normalized, or null when it is not set. */
export function envUrl(io: Pick<CliIo, 'env'>): string | null {
  const value = io.env.ZAMU_URL?.trim();
  return value ? normalizeUrl(value) : null;
}

/** "acme on http://zamu.test", for messages. */
export function loginLabel(login: Pick<Login, 'url' | 'workspace'>): string {
  return login.workspace ? `${login.workspace.name} (${login.workspace.slug}) on ${login.url}` : login.url;
}
