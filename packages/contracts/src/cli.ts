import { z } from 'zod';
import {
  Activity,
  BacklogRefreshResult,
  BacklogSourceStatus,
  Comment,
  CommentList,
  Cycle,
  CycleDetail,
  CycleList,
  Dashboard,
  Label,
  LabelList,
  LabelWithUsage,
  Me,
  MilestoneList,
  MilestoneWithProgress,
  Project,
  ProjectList,
  PullRequestLink,
  RepositorySettings,
  Task,
  TaskBulkResult,
  TaskListPage,
  TimelineCounts,
  TimelineItem,
  WorkspaceRef,
} from './entities';
import { ProjectKey, ProjectKeyInput, TaskKey, TaskStatus, Timestamp, WorkspaceId } from './primitives';
import { Problem } from './problem';

// Versioned `zamu ... --json` output. Every result is { "schema": "zamu.v1.<name>", "data": ... }.
// Adding optional fields keeps v1. Removing or renaming fields, or changing a type, needs zamu.v2.

export const CLI_SCHEMA_VERSION = 'v1';

export const CLI_PROJECT_SOURCES = ['flag', 'env', 'file', 'remote'] as const;
/**
 * Where zamu took the project from when a command needs one: --project, ZAMU_PROJECT, the nearest
 * .zamu.json, or the project whose repository matches the clone's git remote.
 */
export const CliProjectSource = z.enum(CLI_PROJECT_SOURCES);
export type CliProjectSource = z.infer<typeof CliProjectSource>;

export const CliResolvedProject = z.object({
  key: ProjectKey,
  source: CliProjectSource,
  /** The .zamu.json path (file) or the remote URL (remote); null otherwise. */
  from: z.string().nullable(),
});
export type CliResolvedProject = z.output<typeof CliResolvedProject>;

export const PROJECT_FILE_NAME = '.zamu.json';

/** Contents of .zamu.json, committed at the repository root or in a monorepo subfolder. */
export const ProjectFile = z.strictObject({ project: ProjectKeyInput });
export type ProjectFile = z.output<typeof ProjectFile>;

// ---------------------------------------------------------------------------
// 0.10: logins per workspace (PM-40)
// ---------------------------------------------------------------------------

export const CLI_WORKSPACE_SOURCES = ['flag', 'env', 'clone', 'default'] as const;
/**
 * Where zamu took the login from: --workspace, ZAMU_KEY and ZAMU_URL, the login cached or matched
 * for this clone's git remote, or the default login.
 */
export const CliWorkspaceSource = z.enum(CLI_WORKSPACE_SOURCES);
export type CliWorkspaceSource = z.infer<typeof CliWorkspaceSource>;

/** One stored login: a key for one workspace on one server. */
export const CliLogin = z.object({
  url: z.url(),
  key: z.string().min(1),
  workspace: WorkspaceRef,
  /** The login used when nothing else picks one. Exactly one stored login is the default. */
  default: z.boolean(),
});
export type CliLogin = z.output<typeof CliLogin>;

/**
 * $XDG_CONFIG_HOME/zamu/config.json from 0.10. A 0.9 file ({ url, key }, CliConfigFileV1) is
 * converted on the first command that reaches the server, and read as is while offline.
 */
export const CliConfigFile = z
  .object({
    version: z.literal(2),
    logins: z.array(CliLogin),
  })
  .superRefine((file, ctx) => {
    const seen = new Set<string>();
    for (const [index, login] of file.logins.entries()) {
      const id = `${login.url.replace(/\/+$/, '')} ${login.workspace.id}`;
      if (seen.has(id)) {
        ctx.addIssue({
          code: 'custom',
          path: ['logins', index],
          message: 'Keep one login per server and workspace',
        });
      }
      seen.add(id);
    }
    const defaults = file.logins.filter((login) => login.default).length;
    if (file.logins.length > 0 && defaults !== 1) {
      ctx.addIssue({ code: 'custom', path: ['logins'], message: 'Mark exactly one login as the default' });
    }
  });
export type CliConfigFile = z.output<typeof CliConfigFile>;

/** The config file of zamu 0.9 and earlier: one server and one key, no workspace. */
export const CliConfigFileV1 = z.object({
  url: z.url(),
  key: z.string().min(1),
});
export type CliConfigFileV1 = z.output<typeof CliConfigFileV1>;

/** A stored login as the CLI prints it: never the key. */
export const CliLoginView = z.object({
  url: z.url(),
  workspace: WorkspaceRef,
  default: z.boolean(),
});
export type CliLoginView = z.output<typeof CliLoginView>;

/** Where the clone cache lives, under $XDG_STATE_HOME (default ~/.local/state), next to the queue. */
export const CLI_CLONES_FILE_NAME = 'clones.json';

/**
 * The login matched for one clone, by its remote key (host/path of the git remote). Used until a
 * command gets 403 or 404 for the project, then matched again.
 */
export const CliCloneEntry = z.object({
  url: z.url(),
  workspaceId: WorkspaceId,
  matchedAt: Timestamp,
});
export type CliCloneEntry = z.output<typeof CliCloneEntry>;

/** $XDG_STATE_HOME/zamu/clones.json, written atomically under a lock file like the queue. */
export const CliClonesFile = z.object({
  version: z.literal(1),
  clones: z.record(z.string(), CliCloneEntry),
});
export type CliClonesFile = z.output<typeof CliClonesFile>;

export const CLI_LINK_ACTIONS = ['linked', 'replaced', 'unchanged', 'cleared', 'created', 'updated'] as const;

/**
 * How zamu backlog refresh ended: queued (no --wait), finished (the run ended within the wait), or
 * timeout (--wait gave up after 5 minutes; the run may still finish).
 */
export const CLI_BACKLOG_REFRESH_OUTCOMES = ['queued', 'finished', 'timeout'] as const;
export const CliBacklogRefreshOutcome = z.enum(CLI_BACKLOG_REFRESH_OUTCOMES);
export type CliBacklogRefreshOutcome = z.infer<typeof CliBacklogRefreshOutcome>;

/** Longest --wait of zamu backlog refresh, in milliseconds. */
export const CLI_BACKLOG_REFRESH_WAIT_MS = 5 * 60 * 1000;

// ---------------------------------------------------------------------------
// M6: zamu instructions, zamu backlog export and the offline queue
// ---------------------------------------------------------------------------

/** zamu instructions [topic]: an overview and three guides bundled with the CLI. */
export const CLI_INSTRUCTION_TOPICS = ['overview', 'creating', 'working', 'finishing'] as const;
export const CliInstructionTopic = z.enum(CLI_INSTRUCTION_TOPICS);
export type CliInstructionTopic = z.infer<typeof CliInstructionTopic>;

/**
 * What zamu backlog export did (or, with --dry-run, would do) to one file under --dir: created,
 * updated, unchanged, or removed (a stale task file under an owned folder).
 */
export const CLI_BACKLOG_EXPORT_ACTIONS = ['created', 'updated', 'unchanged', 'removed'] as const;
export const CliBacklogExportAction = z.enum(CLI_BACKLOG_EXPORT_ACTIONS);
export type CliBacklogExportAction = z.infer<typeof CliBacklogExportAction>;

export const CliBacklogExportFile = z.object({
  /** Relative to `dir`: tasks/pay-142 - Add webhooks.md. */
  path: z.string(),
  action: CliBacklogExportAction,
});
export type CliBacklogExportFile = z.output<typeof CliBacklogExportFile>;

/** Exit code of a write the CLI queued because the server didn't answer. */
export const CLI_EXIT_QUEUED = 7;

/** Where the offline queue lives, under $XDG_STATE_HOME (default ~/.local/state). */
export const CLI_QUEUE_DIR = 'zamu';
export const CLI_QUEUE_FILE_NAME = 'queue.json';

/**
 * The calls a queued write replays: tasks.update for checking, unchecking or waiving items, for a
 * status change and (M7) for a check-again day on an existing task; comments.create for a note;
 * and (M7) tasks.archive, tasks.restore, pullRequests.link and pullRequests.unlink. Creating tasks,
 * other writes and reads are never queued.
 */
export const CLI_QUEUE_PROCEDURES = [
  'tasks.update',
  'comments.create',
  'tasks.archive',
  'tasks.restore',
  'pullRequests.link',
  'pullRequests.unlink',
] as const;
export const CliQueueProcedure = z.enum(CLI_QUEUE_PROCEDURES);
export type CliQueueProcedure = z.infer<typeof CliQueueProcedure>;

/** One write waiting in the offline queue. Replayed oldest first. */
export const CliQueueEntry = z.object({
  /** Stable id for zamu queue drop ID. */
  id: z.string().min(1).max(100),
  queuedAt: Timestamp,
  /** The server the write was meant for; entries for another server stay put. */
  url: z.url(),
  /**
   * A fingerprint of the key that queued the write (never the key). Only a command with the same key
   * sends it, so a write keeps its author. Missing on entries from before the field existed.
   */
  keyId: z.string().min(8).max(64).optional(),
  /**
   * The workspace of the login that queued the write (0.10); replay uses that login. Missing on
   * entries from 0.9, which replay with the login picked for their server today.
   */
  workspaceId: WorkspaceId.optional(),
  /** The project the command resolved, when it did. */
  project: ProjectKey.nullable(),
  /** The task as the command named it (PAY-142, or a Backlog.md id). */
  taskKey: z.string().min(1),
  procedure: CliQueueProcedure,
  /** The contract input as sent (UpdateTaskInput or CreateCommentInput), before defaults. */
  input: z.record(z.string(), z.unknown()),
  /** For a status change: the status the CLI last saw, sent as ifStatus on replay. Null otherwise. */
  lastSeenStatus: TaskStatus.nullable(),
  /** One line for zamu queue: "check criterion 2", "move to In review", "note". */
  summary: z.string(),
});
export type CliQueueEntry = z.output<typeof CliQueueEntry>;

/** $XDG_STATE_HOME/zamu/queue.json, written atomically under a lock file. */
export const CliQueueFile = z.object({
  version: z.literal(1),
  entries: z.array(CliQueueEntry),
});
export type CliQueueFile = z.output<typeof CliQueueFile>;

/** Data schema for each CLI result name. */
export const cliDataSchemas = {
  /**
   * zamu login. 0.10: `replaced` is true when a login for that server and workspace existed, and
   * `default` tells whether the new login is the default.
   */
  login: z.object({
    url: z.url(),
    me: Me,
    replaced: z.boolean().optional(),
    default: z.boolean().optional(),
  }),
  /**
   * zamu logout [--workspace <slug>] [--all]. `url` is the server of the login removed (the first
   * one with --all), or null when there was none. `removed` (0.10) lists every login removed.
   */
  logout: z.object({
    url: z.url().nullable(),
    removed: z.array(CliLoginView).optional(),
  }),
  /**
   * zamu whoami. `project` (M2.1) is the project commands use here, or null. `queued` (M6): writes
   * waiting in the offline queue for this server. `workspaceSource` (0.10): how the login was picked.
   */
  whoami: Me.extend({
    project: CliResolvedProject.nullable().optional(),
    queued: z.number().int().nonnegative().optional(),
    workspaceSource: CliWorkspaceSource.optional(),
  }),
  /**
   * zamu workspaces [--default <slug>] (0.10): the stored logins. `current` marks the login commands use here; `source` says how it
   * was picked, null when none applies (no login, or several match this clone). With ZAMU_KEY set,
   * no stored login is current and `source` is env.
   */
  workspaces: z.object({
    items: z.array(CliLoginView.extend({ current: z.boolean() })),
    source: CliWorkspaceSource.nullable(),
  }),
  /** zamu projects list */
  'projects.list': ProjectList,
  /** zamu projects delete <KEY> --confirm <KEY> (0.6.0) */
  'projects.delete': z.object({ deleted: ProjectKey }),
  /**
   * zamu projects show [KEY] (M7): the project (archiveAfterDays included) and its repository
   * settings (connection, close on merge, webhook and hourly check); repository is null when the
   * caller can't read them.
   */
  'projects.show': z.object({
    project: Project,
    repository: RepositorySettings.nullable(),
  }),
  /** zamu tasks list [--mine] [--project ...] [--milestone ...] [--cycle ...] */
  'tasks.list': TaskListPage,
  /**
   * zamu tasks show. `activity` is the M1 field and stays for v1 readers; `timeline` (M2) holds
   * activity and comments in one list, oldest first, and from M6 notes too (kind note), with the
   * four filter counts in `timelineCounts`. The task carries its work record (M6).
   */
  'tasks.show': z.object({
    task: Task,
    activity: z.array(Activity),
    timeline: z.array(TimelineItem).optional(),
    timelineCounts: TimelineCounts.optional(),
  }),
  /** zamu tasks create */
  'tasks.create': Task,
  /**
   * zamu tasks update. From M7 the task carries workBranch, pullRequests, checkAgain, closedAt,
   * archivedAt, archivedBy and mergedOpen, and tasks.list rows the compact pullRequest,
   * pullRequestCount, checkAgain and archivedAt.
   */
  'tasks.update': Task,
  /** zamu tasks archive <keys...> (M7): the archived tasks, in the order given. */
  'tasks.archive': TaskBulkResult,
  /** zamu tasks restore <keys...> (M7): the restored tasks, in the order given. */
  'tasks.restore': TaskBulkResult,
  /**
   * zamu pr link <task> <url> [--dry-run] (M7): the request as linked, or with --dry-run as it
   * would link (nothing written).
   */
  'pr.link': z.object({
    task: TaskKey,
    pullRequest: PullRequestLink,
    dryRun: z.boolean(),
  }),
  /** zamu pr unlink <task> <number> (M7): the link removed. */
  'pr.unlink': z.object({
    task: TaskKey,
    number: z.number().int().positive(),
  }),
  /** zamu comments list */
  'comments.list': CommentList,
  /** zamu comments add */
  'comments.add': Comment,
  /** zamu comments edit */
  'comments.edit': Comment,
  /** zamu comments delete: the comment as it is after the soft delete (body null). */
  'comments.delete': Comment,
  /** zamu notes add, and zamu tasks update --append-notes (M6): the note (a comment of kind note). */
  'notes.add': Comment,
  /** zamu milestones list */
  'milestones.list': MilestoneList,
  /** zamu milestones create */
  'milestones.create': MilestoneWithProgress,
  /** zamu milestones update */
  'milestones.update': MilestoneWithProgress,
  /** zamu cycles list */
  'cycles.list': CycleList,
  /** zamu cycles create */
  'cycles.create': Cycle,
  /** zamu cycles current: null when the project has no current cycle. */
  'cycles.current': Cycle.nullable(),
  /** zamu cycles end: the completed cycle with its summary and rollovers. */
  'cycles.end': CycleDetail,
  /**
   * zamu link: `target` server sets or clears the project's repository; file writes .zamu.json.
   * `repository` is the short form (host/path) of the linked repository, null once cleared.
   */
  link: z.object({
    project: ProjectKey,
    target: z.enum(['server', 'file']),
    action: z.enum(CLI_LINK_ACTIONS),
    repository: z.string().nullable(),
    /** The .zamu.json path for target file, else null. */
    file: z.string().nullable(),
  }),
  /**
   * zamu agents: `file` is null with --print. `block` is the text between the two markers.
   * `replacedBacklogBlock` (M6): a Backlog.md guidelines block was replaced (Zamu-owned projects).
   */
  agents: z.object({
    file: z.string().nullable(),
    action: z.enum(['created', 'updated', 'unchanged', 'printed']),
    project: ProjectKey.nullable(),
    block: z.string(),
    replacedBacklogBlock: z.boolean().optional(),
  }),
  /**
   * zamu backlog status [--problems]: the source status. Without --problems, problems.items holds
   * the first page only.
   */
  'backlog.status': BacklogSourceStatus,
  /**
   * zamu backlog refresh [--wait]: the refresh request, and with --wait the status after the run
   * (null without --wait).
   */
  'backlog.refresh': BacklogRefreshResult.extend({
    outcome: CliBacklogRefreshOutcome,
    status: BacklogSourceStatus.nullable(),
  }),
  /**
   * zamu backlog export [--dir] [--dry-run] (M6): every file the export touched or would touch,
   * by path. `dir` is the Backlog.md folder written to (absolute).
   */
  'backlog.export': z.object({
    project: ProjectKey,
    dir: z.string(),
    dryRun: z.boolean(),
    /** The Backlog.md file format the files target, as the server reported it. */
    format: z.string(),
    files: z.array(CliBacklogExportFile),
  }),
  /** zamu instructions [topic] (M6): the guide's text. */
  instructions: z.object({
    topic: CliInstructionTopic,
    text: z.string(),
  }),
  /** zamu queue (M6): the writes waiting, oldest first. */
  'queue.list': z.object({ items: z.array(CliQueueEntry) }),
  /** zamu queue drop ID (M6): the entry removed. */
  'queue.drop': z.object({ dropped: CliQueueEntry }),
  /** Any write the CLI queued because the server didn't answer (M6, exit code 7). */
  queued: z.object({ entry: CliQueueEntry }),
  /** zamu dashboard [--everyone] */
  dashboard: Dashboard,
  /** zamu labels list (M5) */
  'labels.list': LabelList,
  /** zamu labels create (M5) */
  'labels.create': LabelWithUsage,
  /** zamu labels update (M5) */
  'labels.update': LabelWithUsage,
  /** zamu labels delete <name> --confirm (M5): the label as it was, and how many tasks lost it. */
  'labels.delete': z.object({
    deleted: Label,
    usageCount: z.number().int().nonnegative(),
  }),
  /** Any command that fails while --json is set (printed to stdout, exit code still non-zero). */
  error: Problem,
} as const;

export type CliResultName = keyof typeof cliDataSchemas;
export const CLI_RESULT_NAMES = Object.keys(cliDataSchemas) as CliResultName[];

export type CliSchemaId<N extends CliResultName = CliResultName> = `zamu.${typeof CLI_SCHEMA_VERSION}.${N}`;

export function cliSchemaId<N extends CliResultName>(name: N): CliSchemaId<N> {
  return `zamu.${CLI_SCHEMA_VERSION}.${name}`;
}

function envelope<N extends CliResultName>(name: N) {
  return z.object({
    schema: z.literal(cliSchemaId(name)),
    data: cliDataSchemas[name] as (typeof cliDataSchemas)[N],
  });
}

type CliOutputSchemas = { [N in CliResultName]: ReturnType<typeof envelope<N>> };

/** Full envelope schema per result name, e.g. `cliOutputSchemas['tasks.list']`. */
export const cliOutputSchemas = Object.fromEntries(
  CLI_RESULT_NAMES.map((name) => [name, envelope(name)]),
) as CliOutputSchemas;

/** Any CLI JSON output, discriminated by `schema`. */
export const CliOutput = z.discriminatedUnion(
  'schema',
  Object.values(cliOutputSchemas) as unknown as [
    CliOutputSchemas[CliResultName],
    ...CliOutputSchemas[CliResultName][],
  ],
);

export type CliOutput<N extends CliResultName = CliResultName> = z.output<CliOutputSchemas[N]>;
export type CliData<N extends CliResultName> = z.output<(typeof cliDataSchemas)[N]>;

/**
 * Wraps data in the versioned envelope after validating it, so the CLI can never print a shape
 * the contract does not describe. Dates become ISO strings on the way through.
 */
export function cliOutput<N extends CliResultName>(
  name: N,
  data: z.input<(typeof cliDataSchemas)[N]>,
): CliOutput<N> {
  return cliOutputSchemas[name].parse({ schema: cliSchemaId(name), data }) as CliOutput<N>;
}

/** Parses CLI JSON output (for scripts and tests). Pass a name to require that result. */
export function parseCliOutput<N extends CliResultName>(value: unknown, name: N): CliOutput<N>;
export function parseCliOutput(value: unknown): CliOutput;
export function parseCliOutput(value: unknown, name?: CliResultName): CliOutput {
  return (name ? cliOutputSchemas[name] : CliOutput).parse(value) as CliOutput;
}
