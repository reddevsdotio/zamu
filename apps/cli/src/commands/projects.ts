// zamu projects list | show | delete.
import { ORPCError } from '@orpc/client';
import {
  DeleteProjectInput,
  GIT_ACTOR_NAMES,
  GIT_CONNECTION_STATUS_LABELS,
  OPEN_TASK_STATUSES,
  type Project,
  ProjectKeyInput,
  type ProjectWithCounts,
  parseRepositoryUrl,
  type RepositorySettings,
} from '@zamu/contracts';
import type { ApiClient } from '../client';
import { type CommandContext, emit } from '../context';
import { notFoundError, usageError } from '../errors';
import { fields, formatDate, formatTime, statusLabel, table } from '../format';
import { requireProject } from '../project';
import { parseInput } from './shared';

export async function listProjects(context: CommandContext): Promise<void> {
  const client = await context.client();
  const projects = await client.projects.list();
  emit(context, 'projects.list', projects, (data) => {
    if (data.items.length === 0) return 'No projects yet.\n';
    const { style } = context;
    return table(
      data.items,
      [
        { header: 'KEY', value: (p) => p.key, style: (_p, cell) => style.bold(cell) },
        { header: 'OPEN', value: (p) => String(p.openCount) },
        { header: 'BACKLOG', value: (p) => String(p.openCounts.backlog) },
        { header: 'TODO', value: (p) => String(p.openCounts.todo) },
        { header: 'IN PROGRESS', value: (p) => String(p.openCounts.in_progress) },
        { header: 'IN REVIEW', value: (p) => String(p.openCounts.in_review) },
        { header: 'ACTIVE', value: (p) => formatDate(p.lastActivityAt) },
        { header: 'NAME', value: (p) => p.name },
        ...(data.items.some((p) => p.repository)
          ? [
              {
                header: 'REPOSITORY',
                value: (p: (typeof data.items)[number]) =>
                  p.repository ? (parseRepositoryUrl(p.repository)?.short ?? p.repository) : '',
              },
            ]
          : []),
      ],
      style,
      context.io.columns,
    );
  });
}

/**
 * zamu projects delete <KEY> --confirm <KEY>. Without --confirm, or with another key, nothing is
 * sent: deleting takes every task, comment and the Backlog.md mirror with it.
 */
export async function deleteProject(
  context: CommandContext,
  key: string,
  options: { confirm?: string },
): Promise<void> {
  const project = parseInput(ProjectKeyInput, key);
  const input = DeleteProjectInput.safeParse({ project, confirmKey: options.confirm ?? '' });
  if (!input.success) {
    throw usageError(`Pass --confirm ${project} to delete project ${project}.`, [
      { path: 'confirmKey', message: 'Type the project key to confirm' },
    ]);
  }
  const client = await context.client();
  await client.projects.delete(input.data);
  emit(context, 'projects.delete', { deleted: project }, (data) => {
    return `Deleted project ${context.style.bold(data.deleted)}\n`;
  });
}

// ---------------------------------------------------------------------------
// zamu projects show (M7)
// ---------------------------------------------------------------------------

/** The repository settings, or null when the caller may not read them (or the server has none). */
async function repositorySettings(client: ApiClient, project: string): Promise<RepositorySettings | null> {
  try {
    return await client.repository.get({ project });
  } catch (error) {
    if (error instanceof ORPCError && (error.status === 403 || error.status === 404)) return null;
    throw error;
  }
}

/** A project mirrors Backlog.md while its source is a mirror that has not been detached. */
function mirrors(project: Pick<Project, 'backlog'>): boolean {
  return project.backlog?.mode === 'mirror' && project.backlog.detachedAt === null;
}

/** "github.com/northwind/payments (GitHub)". */
function repositoryText(repository: string, settings: RepositorySettings | null): string {
  const short = parseRepositoryUrl(repository)?.short ?? repository;
  return settings?.provider ? `${short} (${GIT_ACTOR_NAMES[settings.provider]})` : short;
}

/** The lines about how Zamu reads the repository's requests and what a merge does. */
function repositoryEntries(settings: RepositorySettings): [string, string][] {
  const entries: [string, string][] = [];
  const connection = settings.connection;
  entries.push([
    'Reads with',
    connection
      ? `${connection.name} (${GIT_CONNECTION_STATUS_LABELS[connection.status]})`
      : 'no connection: read as a public repository',
  ]);
  if (settings.defaultBranch) entries.push(['Default branch', settings.defaultBranch]);
  const branch = settings.defaultBranch ?? 'the default branch';
  entries.push([
    'Close on merge',
    settings.mirrored
      ? 'off: the Backlog.md files own the status'
      : settings.closeOnMerge
        ? `on: a merge into ${branch} moves its tasks to Done`
        : 'off: a merge leaves its tasks In review',
  ]);
  const webhook = settings.webhook;
  if (webhook) {
    let text: string;
    if (webhook.coveredByBacklog) text = 'the Backlog.md webhook carries request events too';
    else if (!webhook.lastAt) text = webhook.secretSet ? 'set up, no event yet' : 'not set up';
    else if (webhook.lastStatus === 'bad_signature') {
      text = `last event ${formatTime(webhook.lastAt)} failed its signature check`;
    } else if (webhook.lastStatus === 'bad_payload') {
      text = `last event ${formatTime(webhook.lastAt)} could not be read`;
    } else text = `last event ${formatTime(webhook.lastAt)}`;
    entries.push(['Webhook', text], ['', webhook.url]);
  }
  const sync = settings.sync;
  const parts = [
    sync.lastAt ? `last ${formatTime(sync.lastAt)}` : 'not run yet',
    ...(sync.nextAt ? [`next ${formatTime(sync.nextAt)}`] : []),
  ];
  entries.push(['Hourly check', sync.error ? `failed: ${sync.error}` : parts.join(' · ')]);
  return entries;
}

/** "after 14 days", "off", or the Backlog.md folder for a mirror. */
function archiveText(project: Pick<Project, 'archiveAfterDays' | 'backlog'>): string {
  if (mirrors(project)) return "follows Backlog.md's archive/tasks/ folder";
  const days = project.archiveAfterDays ?? null;
  if (days === null) return 'off';
  return `Done and Canceled tasks, ${days} ${days === 1 ? 'day' : 'days'} after they close`;
}

/**
 * zamu projects show [KEY]: the project with its open tasks, its repository settings (how Zamu
 * reads requests, close on merge, the webhook and the hourly check) and its archive setting.
 */
export async function showProject(context: CommandContext, key: string | undefined): Promise<void> {
  const wanted = parseInput(ProjectKeyInput, await requireProject(context, key));
  context.target = { ...context.target, project: wanted };
  const client = await context.client();
  const { items } = await client.projects.list();
  const project = items.find((item) => item.key === wanted);
  if (!project) {
    throw notFoundError(`No project ${wanted} you can read.`, ['zamu projects list lists the projects.']);
  }
  const repository = await repositorySettings(client, wanted);
  const counts: ProjectWithCounts = project;
  emit(context, 'projects.show', { project, repository }, (data) => {
    const { style } = context;
    const p = data.project;
    const settings = data.repository;
    const open = OPEN_TASK_STATUSES.map((status) => `${statusLabel(status)} ${counts.openCounts[status]}`);
    const entries: [string, string][] = [
      ['Open tasks', `${counts.openCount} · ${open.join(' · ')}`],
      [
        'Repository',
        p.repository ? repositoryText(p.repository, settings) : 'none (zamu link sets one from a clone)',
      ],
      ...(p.repository && settings ? repositoryEntries(settings) : []),
      ['Archive', archiveText(p)],
    ];
    return `${style.bold(p.key)}  ${style.bold(p.name)}\n${fields(entries, style)}`;
  });
}
