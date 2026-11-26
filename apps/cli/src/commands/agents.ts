// zamu agents: writes a short pointer to zamu into AGENTS.md (or CLAUDE.md) between two markers, so
// coding agents in this repository find the commands. The guidance itself is `zamu instructions`,
// bundled with the CLI (M6). Running it again replaces only that block. On a project owned by Zamu it
// also replaces a Backlog.md guidelines block with one line, so agents stop writing task files.
import { access, mkdir, readFile, writeFile } from 'node:fs/promises';
import { dirname, join, relative, resolve } from 'node:path';
import { type Project, ProjectKeyInput, ProjectList } from '@zamu/contracts';
import { envKey, readLogins } from '../config';
import { type CommandContext, emit } from '../context';
import { EXIT, toCliError, usageError } from '../errors';
import { gitRoot, resolveProject } from '../project';

export interface AgentsOptions {
  file?: string;
  print?: boolean;
  project?: string;
}

export const AGENTS_BLOCK_START = '<!-- zamu:start (written by zamu agents; run it again to update) -->';
export const AGENTS_BLOCK_END = '<!-- zamu:end -->';
const BLOCK = /<!-- zamu:start[^>]*-->[\s\S]*?<!-- zamu:end -->/;

/** The block `backlog init` and `backlog agents` write into AGENTS.md and CLAUDE.md. */
export const BACKLOG_GUIDELINES_START = '<!-- BACKLOG.MD GUIDELINES START -->';
export const BACKLOG_GUIDELINES_END = '<!-- BACKLOG.MD GUIDELINES END -->';
const BACKLOG_BLOCK = /<!-- BACKLOG\.MD GUIDELINES START -->[\s\S]*?<!-- BACKLOG\.MD GUIDELINES END -->/;

/** The line that takes the Backlog.md guidelines' place on a project owned by Zamu. */
export const BACKLOG_REPLACEMENT_LINE =
  'Tasks for this project are in Zamu: use `zamu` for them (see the zamu block). The `backlog` CLI is only for documents and decisions, never for tasks.';

/**
 * How the project relates to Backlog.md: it mirrors a folder (the files own the tasks), it is owned
 * by Zamu (native, or switched from a mirror: `switched`), or unknown (no project, or no server).
 */
export type BacklogRelation = 'mirrors' | 'switched' | 'native' | 'unknown';

/** The relation from the project as the server lists it. */
export function backlogRelation(project: Pick<Project, 'backlog'> | null | undefined): BacklogRelation {
  if (!project) return 'unknown';
  const backlog = project.backlog;
  if (!backlog) return 'native';
  return backlog.mode === 'mirror' && backlog.detachedAt === null ? 'mirrors' : 'switched';
}

/** The block: a few lines that point to `zamu instructions`, for the project of this repository. */
export function agentsBlock(project: string | null, relation: BacklogRelation = 'unknown'): string {
  const intro = project
    ? `Tasks for this repository are in Zamu, project ${project}. zamu picks ${project} here, so --project is optional.`
    : 'Tasks for this repository are in Zamu. Pass --project KEY to commands that work on one project, or run zamu link --project KEY once in a clone.';
  const refresh = project ? '`zamu backlog refresh --wait`' : '`zamu backlog refresh --project KEY --wait`';
  const backlog =
    relation === 'mirrors'
      ? [
          '',
          `${project} mirrors Backlog.md, so the task files own title, description, status, priority, assignee,`,
          `milestone and the work record. Change those in the files (or with \`backlog task edit\`), push, then run`,
          `${refresh}. Comments and cycles still change through zamu.`,
        ]
      : relation === 'switched'
        ? [
            '',
            'The Backlog.md task files in this repository are a copy written by `zamu backlog export`. Never edit them by hand.',
          ]
        : [];
  return [
    AGENTS_BLOCK_START,
    '## Tasks: the zamu CLI',
    '',
    intro,
    'Read `zamu instructions` before you start, then `zamu instructions creating`, `working` and `finishing` for each step.',
    'Credentials come from ZAMU_URL and ZAMU_KEY, or from `zamu login` (one login per workspace; `--workspace <slug>` picks one). Never write a key into the repository.',
    ...backlog,
    AGENTS_BLOCK_END,
  ].join('\n');
}

const exists = (path: string) =>
  access(path).then(
    () => true,
    () => false,
  );

/** --file, else AGENTS.md or CLAUDE.md at the git root (working directory outside a repository). */
async function targetFile(context: CommandContext, file: string | undefined): Promise<string> {
  const { io } = context;
  if (file !== undefined) return resolve(io.cwd, file);
  const dir = (await gitRoot(io)) ?? io.cwd;
  for (const name of ['AGENTS.md', 'CLAUDE.md']) {
    const path = join(dir, name);
    if (await exists(path)) return path;
  }
  return join(dir, 'AGENTS.md');
}

/**
 * The project to name in the block. The remote lookup needs credentials and the server; without
 * them, or when it fails, the block names no project.
 */
async function blockProject(context: CommandContext, flag: string | undefined): Promise<string | null> {
  const { io } = context;
  if (flag !== undefined) {
    const parsed = ProjectKeyInput.safeParse(flag);
    if (!parsed.success) throw usageError(`--project ${flag}: not a project key.`);
    return parsed.data;
  }
  const credentials = Boolean(envKey(io)) || (await readLogins(io).catch(() => [])).length > 0;
  try {
    return (await resolveProject(context, undefined, { remote: credentials }))?.key ?? null;
  } catch (error) {
    const failure = toCliError(error, context.url);
    // A broken .zamu.json or ZAMU_PROJECT is the caller's to fix; a failed lookup only loses the key.
    if (failure.exitCode === EXIT.usage) throw failure;
    if (!context.json) {
      io.stderr(
        `zamu: could not look up the project of this clone (${failure.message}). The block names none.\n`,
      );
    }
    return null;
  }
}

/** Whether the server lists the project as mirroring, owned by Zamu, or unknown (no lookup possible). */
async function projectRelation(context: CommandContext, project: string | null): Promise<BacklogRelation> {
  if (!project) return 'unknown';
  const { io } = context;
  const credentials = Boolean(envKey(io)) || (await readLogins(io).catch(() => [])).length > 0;
  if (!credentials) return 'unknown';
  try {
    const client = await context.client();
    const { items } = ProjectList.parse(await client.projects.list());
    return backlogRelation(items.find((item) => item.key === project));
  } catch {
    return 'unknown';
  }
}

/** The file with the zamu block written in and, when asked, the Backlog.md guidelines replaced. */
export function applyBlock(
  current: string | null,
  block: string,
  replaceBacklog: boolean,
): { next: string; replacedBacklogBlock: boolean } {
  if (current === null) return { next: `${block}\n`, replacedBacklogBlock: false };
  const hasBlock = BLOCK.test(current);
  const replacedBacklogBlock = replaceBacklog && BACKLOG_BLOCK.test(current);
  let next = current;
  if (replacedBacklogBlock) {
    // The zamu block takes the guidelines' place when the file has none yet.
    const replacement = hasBlock ? BACKLOG_REPLACEMENT_LINE : `${BACKLOG_REPLACEMENT_LINE}\n\n${block}`;
    next = next.replace(BACKLOG_BLOCK, () => replacement);
    if (!hasBlock) return { next, replacedBacklogBlock };
  }
  if (hasBlock) next = next.replace(BLOCK, () => block);
  else next = next.trim() ? `${next.trimEnd()}\n\n${block}\n` : `${block}\n`;
  return { next, replacedBacklogBlock };
}

export async function agents(context: CommandContext, options: AgentsOptions): Promise<void> {
  const { io } = context;
  const project = await blockProject(context, options.project);
  const relation = await projectRelation(context, project);
  const block = agentsBlock(project, relation);

  if (options.print) {
    emit(
      context,
      'agents',
      { file: null, action: 'printed', project, block, replacedBacklogBlock: false },
      (data) => `${data.block}\n`,
    );
    return;
  }

  const path = await targetFile(context, options.file);
  const current = await readFile(path, 'utf8').catch((error: NodeJS.ErrnoException) => {
    if (error.code === 'ENOENT') return null;
    throw usageError(`Cannot read ${path}: ${error.message}`);
  });
  const owned = relation === 'native' || relation === 'switched';
  const { next, replacedBacklogBlock } = applyBlock(current, block, owned);
  const action: 'created' | 'updated' | 'unchanged' =
    current === null ? 'created' : next === current ? 'unchanged' : 'updated';
  if (action !== 'unchanged') {
    await mkdir(dirname(path), { recursive: true });
    await writeFile(path, next);
  }

  const shown = relative(io.cwd, path) || path;
  emit(context, 'agents', { file: path, action, project, block, replacedBacklogBlock }, (data) => {
    const named = data.project ? ` for ${data.project}` : '';
    const replaced = data.replacedBacklogBlock
      ? 'Replaced the Backlog.md guidelines with a line that says tasks are in Zamu.\n'
      : '';
    if (data.action === 'created') return `Created ${shown} with zamu instructions${named}.\n`;
    if (data.action === 'updated') return `Wrote zamu instructions${named} into ${shown}.\n${replaced}`;
    return `${shown} already has the current zamu instructions.\n`;
  });
}
