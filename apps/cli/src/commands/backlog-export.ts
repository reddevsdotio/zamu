// zamu backlog export (M6): writes a project owned by Zamu out as Backlog.md files, so the folder in
// the repository stays a readable copy. The server builds the files (GET .../backlog/export); this
// command writes them under the Backlog.md folder and removes the task and milestone files the
// export no longer has. It touches only the folders the export owns (tasks/, archive/tasks/ for
// archived tasks, completed/, milestones/): documents, decisions, drafts and config.yml are never written or removed.
import { execFile } from 'node:child_process';
import { mkdir, readdir, readFile, rm, stat, writeFile } from 'node:fs/promises';
import { dirname, join, relative, resolve, sep } from 'node:path';
import {
  BACKLOG_EXPORT_FOLDERS,
  BacklogExport,
  type CliBacklogExportFile,
  ExportBacklogInput,
} from '@zamu/contracts';
import { formatLimit, isNetworkFailure, NoAnswerError } from '../client';
import { type CommandContext, emit } from '../context';
import { serverError, usageError } from '../errors';
import { git, gitRoot, requireProject } from '../project';
import { parseInput } from './shared';

export interface ExportOptions {
  project?: string;
  dir?: string;
  dryRun?: boolean;
  force?: boolean;
}

/** --dir from the working directory, else backlog/ at the repository root (or here outside one). */
async function exportDir(context: CommandContext, dir: string | undefined): Promise<string> {
  const { io } = context;
  if (dir !== undefined) return resolve(io.cwd, dir);
  return join((await gitRoot(io)) ?? io.cwd, 'backlog');
}

/**
 * PM-32: an export that runs out of time is not an unreachable server. Says how long zamu waited and
 * whether the server had started to answer; a refused connection still fails as before.
 */
export function slowExport(error: unknown): never {
  const cause = error instanceof Error ? error.cause : undefined;
  if (isNetworkFailure(error) && cause instanceof NoAnswerError) {
    const waited = formatLimit(cause.ms);
    throw serverError(
      cause.started
        ? `The server started sending the export but did not finish within ${waited}. Try again; on a slow connection, try from a machine closer to the server.`
        : `The server did not send the export within ${waited}. It may still be working on it: try again in a few minutes, and check the server's logs if it keeps happening.`,
      504,
    );
  }
  throw error;
}

/** The nearest folder that exists, from `path` up: git runs there when the folder is still to come. */
async function existingAncestor(path: string): Promise<string> {
  let current = path;
  for (;;) {
    const found = await stat(current).catch(() => null);
    if (found?.isDirectory()) return current;
    const parent = dirname(current);
    if (parent === current) return current;
    current = parent;
  }
}

/** git status lines (porcelain, untrimmed: the first column matters). Null when git fails. */
function gitStatus(cwd: string, paths: string[]): Promise<string[] | null> {
  return new Promise((done) => {
    execFile(
      'git',
      ['-C', cwd, 'status', '--porcelain', '--untracked-files=all', '--', ...paths],
      { timeout: 10_000, env: { ...process.env, GIT_TERMINAL_PROMPT: '0' } },
      (error, stdout) => done(error ? null : stdout.split('\n').filter(Boolean)),
    );
  });
}

/**
 * Uncommitted changes (staged, unstaged or untracked) in the owned folders, as `git status` lines.
 * Null when the folder is not inside a git repository.
 */
async function ownedChanges(dir: string): Promise<string[] | null> {
  const cwd = await existingAncestor(dir);
  if ((await git({ cwd }, ['rev-parse', '--show-toplevel'])) === null) return null;
  return gitStatus(
    cwd,
    BACKLOG_EXPORT_FOLDERS.map((folder) => join(dir, folder)),
  );
}

/** Every Markdown file under `folder`, as paths relative to `root` with forward slashes. */
async function markdownFiles(root: string, folder: string): Promise<string[]> {
  const base = join(root, folder);
  const entries = await readdir(base, { recursive: true, withFileTypes: true }).catch(
    (error: NodeJS.ErrnoException) => {
      if (error.code === 'ENOENT' || error.code === 'ENOTDIR') return [];
      throw error;
    },
  );
  return entries
    .filter((entry) => entry.isFile() && entry.name.endsWith('.md'))
    .map((entry) => relative(root, join(entry.parentPath, entry.name)).split(sep).join('/'));
}

/** task_prefix in config.yml (the last one wins, as in Backlog.md); TASK when the key is missing. */
export function configPrefix(text: string): string {
  const matches = [...text.matchAll(/^\s*task_prefix\s*:\s*["']?([^"'#\s]*)["']?/gm)];
  const value = matches.at(-1)?.[1];
  return (value || 'task').toUpperCase();
}

/** The id prefixes of the exported task files: PAY for tasks/pay-142 - Title.md. */
export function exportedPrefixes(paths: readonly string[]): string[] {
  const prefixes = new Set<string>();
  for (const path of paths) {
    const match = /^tasks\/([a-z]+)-\d/i.exec(path);
    if (match?.[1]) prefixes.add(match[1].toUpperCase());
  }
  return [...prefixes].sort();
}

/**
 * Why the Backlog.md CLI would list none of the exported tasks: no config.yml, or a task_prefix
 * other than the exported ids'. Empty when it will read them.
 */
async function configWarnings(dir: string, shown: string, paths: readonly string[]): Promise<string[]> {
  const prefixes = exportedPrefixes(paths);
  const text = await readFile(join(dir, 'config.yml'), 'utf8').catch(() => null);
  const wanted = prefixes.length === 1 ? ` with task_prefix: "${prefixes[0]?.toLowerCase()}"` : '';
  if (text === null) {
    return [
      `${shown} has no config.yml, so the backlog CLI lists none of these tasks. Create one with backlog init${wanted}.`,
    ];
  }
  const prefix = configPrefix(text);
  const other = prefixes.filter((value) => value !== prefix);
  if (other.length === 0) return [];
  return [
    `${shown}/config.yml has task_prefix ${prefix}, but the exported ids start with ${other.join(', ')}. ` +
      `The backlog CLI lists none of them until task_prefix matches${wanted}.`,
  ];
}

const ACTION_LABELS: Record<CliBacklogExportFile['action'], [string, string]> = {
  created: ['Created', 'Would create'],
  updated: ['Updated', 'Would update'],
  removed: ['Removed', 'Would remove'],
  unchanged: ['Unchanged', 'Unchanged'],
};

export async function backlogExport(context: CommandContext, options: ExportOptions): Promise<void> {
  const { io } = context;
  const project = await requireProject(context, options.project);
  context.target = { ...context.target, project };
  const input = parseInput(ExportBacklogInput, { project });
  const dir = await exportDir(context, options.dir);
  const shown = relative(io.cwd, dir) || '.';
  const dryRun = options.dryRun === true;

  // Refuse before reading anything from the server: the check is local and cheap.
  const changes = await ownedChanges(dir);
  if (changes?.length && !options.force && !dryRun) {
    const listed = changes.slice(0, 10);
    if (changes.length > 10) listed.push(`... ${changes.length - 10} more`);
    throw usageError(
      `${shown} has uncommitted changes in ${BACKLOG_EXPORT_FOLDERS.join('/, ')}/. Commit or discard them first, or pass --force to overwrite them.`,
      undefined,
      listed,
    );
  }

  const client = await context.client();
  const exported = BacklogExport.parse(await client.backlog.export(input).catch(slowExport));

  const files: CliBacklogExportFile[] = [];
  const writes: { path: string; content: string }[] = [];
  for (const file of exported.files) {
    const current = await readFile(join(dir, file.path), 'utf8').catch(() => null);
    const action = current === null ? 'created' : current === file.content ? 'unchanged' : 'updated';
    files.push({ path: file.path, action });
    if (action !== 'unchanged') writes.push(file);
  }
  const kept = new Set(exported.files.map((file) => file.path));
  const stale: string[] = [];
  for (const prefix of exported.removedPrefixes) {
    for (const path of await markdownFiles(dir, prefix.replace(/\/$/, ''))) {
      if (!kept.has(path)) stale.push(path);
    }
  }
  stale.sort();
  for (const path of stale) files.push({ path, action: 'removed' });

  if (!dryRun) {
    for (const file of writes) {
      const path = join(dir, file.path);
      await mkdir(dirname(path), { recursive: true });
      await writeFile(path, file.content);
    }
    for (const path of stale) await rm(join(dir, path), { force: true });
  }

  const warnings = await configWarnings(dir, shown, [...kept]);
  if (changes === null)
    warnings.push(`${shown} is not in a git repository, so nothing here can undo the export.`);
  if (dryRun && changes?.length && !options.force) {
    warnings.push(
      `${shown} has uncommitted changes in the exported folders: the export itself needs --force.`,
    );
  }
  for (const warning of warnings) io.stderr(`zamu: ${warning}\n`);

  emit(
    context,
    'backlog.export',
    { project: exported.project, dir, dryRun, format: exported.format, files },
    (data) => {
      const { style } = context;
      const changed = data.files.filter((file) => file.action !== 'unchanged');
      const count = (action: CliBacklogExportFile['action']) =>
        data.files.filter((file) => file.action === action).length;
      const totals = (['created', 'updated', 'removed', 'unchanged'] as const)
        .map((action) => `${count(action)} ${action}`)
        .join(', ');
      const head = dryRun
        ? `Dry run: exporting ${style.bold(data.project)} to ${shown} would change ${changed.length} ${changed.length === 1 ? 'file' : 'files'} (${totals}).`
        : changed.length
          ? `Exported ${style.bold(data.project)} to ${shown}: ${totals}.`
          : `${shown} already matches ${style.bold(data.project)}: ${totals}.`;
      const lines = changed.map((file) => {
        const [done, would] = ACTION_LABELS[file.action];
        return `  ${(dryRun ? would : done).padEnd(dryRun ? 12 : 7)}  ${file.path}`;
      });
      return `${[head, ...lines, style.dim(`Format: ${data.format}`)].join('\n')}\n`;
    },
  );
}
