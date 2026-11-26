// Which project a command works on when it needs one: --project, then ZAMU_PROJECT, then the nearest
// .zamu.json, then the project whose repository matches this clone's git remote, all within the
// login the command uses (workspace.ts picks it). Also the git facts behind it (repository root,
// remote URL), read with the git binary.
import { execFile } from 'node:child_process';
import { readFile, realpath } from 'node:fs/promises';
import { dirname, join } from 'node:path';
import {
  type CliResolvedProject,
  PROJECT_FILE_NAME,
  ProjectFile,
  ProjectKeyInput,
  ProjectList,
  parseRepositoryUrl,
  toProblemIssues,
} from '@zamu/contracts';
import type { CommandContext } from './context';
import { usageError } from './errors';
import type { CliIo } from './io';

/** Runs git in the working directory. Null when git is missing, fails, or this is not a repository. */
export function git(io: Pick<CliIo, 'cwd'>, args: string[]): Promise<string | null> {
  return new Promise((resolve) => {
    execFile(
      'git',
      ['-C', io.cwd, ...args],
      { timeout: 5_000, env: { ...process.env, GIT_TERMINAL_PROMPT: '0' } },
      (error, stdout) => resolve(error ? null : stdout.trim()),
    );
  });
}

/** Top folder of the git working tree around the working directory, or null outside one. */
export async function gitRoot(io: Pick<CliIo, 'cwd'>): Promise<string | null> {
  return (await git(io, ['rev-parse', '--show-toplevel'])) || null;
}

export interface GitRemote {
  name: string;
  url: string;
}

/** `origin`, or the only remote when there is no origin. Null when there is none to pick. */
export async function gitRemote(io: Pick<CliIo, 'cwd'>): Promise<GitRemote | null> {
  const names = (await git(io, ['remote']))?.split('\n').filter(Boolean) ?? [];
  const name = names.includes('origin') ? 'origin' : names.length === 1 ? names[0] : undefined;
  if (!name) return null;
  const url = await git(io, ['remote', 'get-url', name]);
  return url ? { name, url } : null;
}

export interface FoundProjectFile {
  path: string;
  project: string;
}

/**
 * The nearest .zamu.json from the working directory up to the git root (the filesystem root outside a
 * repository). A file that is not valid JSON or has other fields is a usage error.
 */
export async function findProjectFile(io: Pick<CliIo, 'cwd'>): Promise<FoundProjectFile | null> {
  const stop = await gitRoot(io);
  // git reports the root as a real path, so walk from the real path too (cwd may be a symlink).
  let dir = await realpath(io.cwd).catch(() => io.cwd);
  for (;;) {
    const path = join(dir, PROJECT_FILE_NAME);
    const text = await readFile(path, 'utf8').catch((error: NodeJS.ErrnoException) => {
      if (error.code === 'ENOENT' || error.code === 'EISDIR') return null;
      throw usageError(`Cannot read ${path}: ${error.message}`);
    });
    if (text !== null) return { path, project: parseProjectFile(path, text).project };
    const parent = dirname(dir);
    if (dir === stop || parent === dir) return null;
    dir = parent;
  }
}

export function parseProjectFile(path: string, text: string): ProjectFile {
  let json: unknown;
  try {
    json = JSON.parse(text);
  } catch {
    throw usageError(`${path} is not valid JSON.`, undefined, ['It holds one field: { "project": "PAY" }']);
  }
  const parsed = ProjectFile.safeParse(json);
  if (!parsed.success) {
    throw usageError(`${path} is not a valid zamu project file.`, toProblemIssues(parsed.error.issues), [
      'It holds one field: { "project": "PAY" }',
    ]);
  }
  return parsed.data;
}

/** The project key in ZAMU_PROJECT, upper-cased. A value that is not a key is a usage error. */
function envProject(io: Pick<CliIo, 'env'>): string | null {
  const value = io.env.ZAMU_PROJECT?.trim();
  if (!value) return null;
  const parsed = ProjectKeyInput.safeParse(value);
  if (!parsed.success) throw usageError(`ZAMU_PROJECT is not a project key: ${value}`);
  return parsed.data;
}

/** The readable project whose repository is the same as the remote, if any. */
async function remoteProject(context: CommandContext, remote: GitRemote): Promise<string | null> {
  const repository = parseRepositoryUrl(remote.url);
  if (!repository) return null;
  const client = await context.client();
  // The login's match already listed its projects (workspace.ts): no second request.
  const { items } = context.login?.projects ?? ProjectList.parse(await client.projects.list());
  const match = items.find(
    (project) => project.repository && parseRepositoryUrl(project.repository)?.key === repository.key,
  );
  return match?.key ?? null;
}

export interface ResolveOptions {
  /** Look the git remote up on the server (needs credentials). Default true. */
  remote?: boolean;
}

/**
 * The project for this command, or null when nothing names one. A --project value is passed on
 * as typed, so the command's input schema reports a bad key the way it always has.
 */
export async function resolveProject(
  context: CommandContext,
  flag?: string,
  { remote = true }: ResolveOptions = {},
): Promise<CliResolvedProject | null> {
  if (flag !== undefined) return { key: flag, source: 'flag', from: null };
  const fromEnv = envProject(context.io);
  if (fromEnv) return { key: fromEnv, source: 'env', from: null };
  const file = await findProjectFile(context.io);
  if (file) return { key: file.project, source: 'file', from: file.path };
  if (!remote) return null;
  const found = await gitRemote(context.io);
  const key = found ? await remoteProject(context, found) : null;
  return key && found ? { key, source: 'remote', from: found.url } : null;
}

/** resolveProject for commands that cannot run without a project: a usage error with the fixes. */
export async function requireProject(context: CommandContext, flag?: string): Promise<string> {
  const resolved = await resolveProject(context, flag);
  if (resolved) return resolved.key;
  const remote = await gitRemote(context.io);
  const repository = remote ? parseRepositoryUrl(remote.url) : null;
  const detail = repository
    ? `No project given, and no project you can read is linked to ${repository.short}.`
    : 'No project given. Pass --project KEY.';
  throw usageError(
    detail,
    [{ path: 'project', message: detail }],
    [
      repository
        ? 'Pass --project KEY, or link this clone once: zamu link --project KEY'
        : 'Inside a clone, zamu link --project KEY links the repository so zamu finds the project itself.',
      'ZAMU_PROJECT or a committed .zamu.json ({ "project": "KEY" }) also set it.',
    ],
  );
}
