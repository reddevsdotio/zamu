// Command tree and the run loop. main() never exits the process: it returns the exit code, so tests
// can run any command in-process with a fake CliIo and the API handler as fetch.
import { CLI_EXIT_QUEUED } from '@zamu/contracts';
import { Command, CommanderError } from 'commander';
import { agents } from './commands/agents';
import { login, logout, whoami, workspaces } from './commands/auth';
import { backlogRefresh, backlogStatus } from './commands/backlog';
import { backlogExport } from './commands/backlog-export';
import { addComment, deleteComment, editComment, listComments } from './commands/comments';
import { createCycle, currentCycle, endCycle, listCycles } from './commands/cycles';
import { showDashboard } from './commands/dashboard';
import { instructions } from './commands/instructions';
import { createLabel, deleteLabel, listLabels, updateLabel } from './commands/labels';
import { link } from './commands/link';
import { createMilestone, listMilestones, updateMilestone } from './commands/milestones';
import { addNote } from './commands/notes';
import { deleteProject, listProjects } from './commands/projects';
import { dropQueueEntry, showQueue } from './commands/queue';
import { collectKeys, collectList } from './commands/shared';
import { createTask, listTasks, showTask, updateTask } from './commands/tasks';
import { collectNumbers, collectTexts, waiveCollector } from './commands/work';
import { type CommandContext, createContext, reportError } from './context';
import { EXIT, toCliError, usageError } from './errors';
import type { CliIo } from './io';
import { describeFailure } from './mirrored';
import { QueuedWrite, reportQueued, withOfflineQueue } from './queue';

// The build replaces __ZAMU_CLI_VERSION__ with the release version (tsdown.config.ts); from source it is unset.
declare const __ZAMU_CLI_VERSION__: string | undefined;
const VERSION = typeof __ZAMU_CLI_VERSION__ === 'string' ? __ZAMU_CLI_VERSION__ : '0.0.0-dev';

const STATUS_HELP = 'backlog, todo, in_progress, in_review, done, canceled';
const PRIORITY_HELP = 'none, low, medium, high, urgent';
const MILESTONE_STATUS_HELP = 'planned, active, completed';
const DUE_FILTER_HELP = 'overdue, soon (open, due today to 2 days out), none, set';
const SORT_HELP = 'priority, due (soonest first), updated, created (newest first) or manual (board order)';
const LABEL_HELP = 'label name; repeatable or comma-separated, missing labels are created';
const BLOCKER_HELP = 'task key of the same project it waits on; repeatable or comma-separated';
const COLOR_HELP = 'palette colour, 1 to 9';
const PROJECT_HELP =
  "project key, e.g. PAY (default: ZAMU_PROJECT, .zamu.json or this clone's linked project)";
const TASK_KEY_HELP = 'e.g. PAY-142, a subtask key like PAY-786.1, or a Backlog.md id like BACK-786.1';
const ITEM_NUMBER_HELP = 'number from zamu tasks show; repeatable or comma-separated';
const TASK_PROJECT_HELP =
  "project to look a Backlog.md id up in (default: ZAMU_PROJECT, .zamu.json or this clone's linked project)";

/** True when --json appears before a `--` separator. */
function wantsJson(argv: readonly string[]): boolean {
  const end = argv.indexOf('--');
  return (end === -1 ? argv : argv.slice(0, end)).includes('--json');
}

export function buildProgram(context: CommandContext): Command {
  const { io } = context;
  const program = new Command('zamu');

  // Settings set here are copied to every subcommand created afterwards.
  program
    .description('Command-line client for Zamu. Every command takes --json.')
    .version(VERSION, '-v, --version')
    .option(
      '--workspace <slug>',
      "workspace of the stored login to use (slug or id; default: this clone's, else the default login)",
    )
    .exitOverride()
    // Every subcommand's help lists --workspace under "Global Options".
    .configureHelp({ showGlobalOptions: true })
    .showHelpAfterError(context.json ? false : '(add --help for usage)')
    .configureOutput({
      writeOut: (text) => io.stdout(text),
      writeErr: (text) => io.stderr(text),
      // With --json the error goes to stdout as zamu.v1.error instead.
      outputError: (text, write) => {
        if (!context.json) write(text);
      },
      getOutHelpWidth: () => io.columns ?? 100,
      getErrHelpWidth: () => io.columns ?? 100,
      getOutHasColors: () => false,
      getErrHasColors: () => false,
    })
    .hook('preAction', () => {
      const flag = program.opts<{ workspace?: string }>().workspace;
      if (flag !== undefined) context.workspaceFlag = flag;
    })
    .addHelpText(
      'after',
      `
Credentials: zamu login stores one login per server and workspace in
$XDG_CONFIG_HOME/zamu/config.json (~/.config/zamu/config.json); zamu workspaces lists them. A command
uses --workspace, then ZAMU_KEY (with ZAMU_URL), then the login for this clone's git remote (the one
whose workspace links it, or has the project of .zamu.json), then the default login.

Project: commands that need one take --project, then ZAMU_PROJECT, then the nearest .zamu.json, then
the project linked to this clone's git remote (zamu link). zamu whoami shows which one applies here.

Tasks: a task key is PAY-142, or PAY-786.1 for a subtask. In a project mirrored from Backlog.md, its
Backlog.md id (BACK-786.1) works too, and the fields Backlog.md owns change in the files, not here.
Subtasks, blockers and parents are tasks of the same project; subtasks go one level deep.

Labels: per project, by name (case-insensitive). zamu tasks create and update create missing ones.

Work record: acceptance criteria (--ac), done items (--dod), the plan and the final summary change
through zamu tasks create and update, with the flag names of the Backlog.md CLI. zamu notes add writes
a work note. zamu instructions explains how agents work on a task.

Offline queue: when the server doesn't answer within 5 seconds, checking, unchecking, waiving and
unwaiving items, a status change, a note and a comment on an existing task are queued in
$XDG_STATE_HOME/zamu/queue.json (~/.local/state/zamu) and sent by the next command that reaches the
server. zamu queue lists them; zamu queue drop ID removes one.

Exit codes: 0 ok, 1 usage or rejected input (OPEN_ITEMS: an agent moved a task with open items),
2 auth, 3 not found, 4 forbidden, 5 server (unreachable, and nothing queued), 6 Backlog.md conflict,
7 queued (the server didn't answer; the write waits in the offline queue).`,
    );

  const leaf = (command: Command) => command.option('--json', 'print the versioned JSON result (zamu.v1.*)');

  leaf(
    program
      .command('login')
      .description('check an API key against the server and store it')
      .requiredOption('--key <key>', 'API key (zamu_live_...); "-" reads it from stdin')
      .option(
        '--url <server>',
        "server URL (default: ZAMU_URL, the default login's server, or http://localhost:3000)",
      )
      .option('--default', 'make it the default login (the first login always is)'),
  ).action((options: { key: string; url?: string; default?: boolean }) => login(context, options));

  leaf(
    program
      .command('logout')
      .description('remove the login used here, the one --workspace names, or every login with --all')
      .option('--all', 'remove every stored login'),
  ).action((options: { all?: boolean }) => logout(context, options));

  leaf(
    program
      .command('workspaces')
      .description('list the stored logins and which one applies here, or change the default')
      .option('--default <slug>', 'make the login for this workspace (slug or id) the default'),
  ).action((options: { default?: string }) => workspaces(context, options));

  leaf(
    program
      .command('whoami')
      .description('show the user, workspace, key scope, the login and the project used here'),
  ).action(() => whoami(context));

  leaf(
    program
      .command('link')
      .description("link a project to this clone's git remote, so zamu picks it in every clone")
      .option('--project <KEY>', 'project to link (default: ZAMU_PROJECT or .zamu.json)')
      .option('--force', 'replace a different repository already linked to the project')
      .option('--clear', "unlink the project's repository (default project: this clone's)")
      .option('--file', 'write .zamu.json at the repository root instead of linking on the server')
      .option('--here', 'with --file: write .zamu.json in this folder (monorepo subprojects)'),
  ).action((options) => link(context, options));

  leaf(
    program
      .command('agents')
      .description(
        'write a short zamu block into AGENTS.md (or CLAUDE.md) between two markers; on a project owned by ' +
          'Zamu it also replaces the Backlog.md guidelines block with one line',
      )
      .option('--file <path>', 'file to write (default: AGENTS.md, else CLAUDE.md, at the repository root)')
      .option('--project <KEY>', "project to name in the instructions (default: this clone's)")
      .option('--print', 'print the instructions instead of writing a file'),
  ).action((options) => agents(context, options));

  leaf(
    program
      .command('instructions')
      .description('print how to work on tasks with zamu: the overview, or a guide for one step')
      .argument('[topic]', 'overview (default), creating, working or finishing'),
  ).action((topic: string | undefined) => instructions(context, topic));

  leaf(
    program
      .command('dashboard')
      .description(
        'what needs you now across every project: in review, mentions, stalled work and deadlines; ' +
          'then projects and agents',
      )
      .option('--everyone', 'the whole workspace instead of your tasks, your agents and mentions of you'),
  ).action((options: { everyone?: boolean }) => showDashboard(context, options));

  const projects = program.command('projects').description('list and delete projects');
  leaf(projects.command('list').description('list projects with open task counts')).action(() =>
    listProjects(context),
  );

  leaf(
    projects
      .command('delete')
      .description(
        'delete a project with its tasks, comments, history, milestones, cycles and Backlog.md mirror; ' +
          'cannot be undone (owners and admins)',
      )
      .argument('<KEY>', 'project key, e.g. PAY')
      .option('--confirm <KEY>', 'the project key again; nothing is deleted without it'),
  ).action((key: string, options: { confirm?: string }) => deleteProject(context, key, options));

  const tasks = program.command('tasks').description('list, show, create and update tasks');
  // --waive-ac, --waive-dod and --reason share one list, so a reason pairs with the waives before it.
  const waives = waiveCollector();
  leaf(
    tasks
      .command('list')
      .description('list tasks of one or more projects, or of every project you can read')
      .option(
        '--project <KEY>',
        'project key, e.g. PAY; repeatable or comma-separated (default: every project)',
        collectKeys,
      )
      .option('--mine', 'only tasks assigned to you (same as --assignee me)')
      .option(
        '--status <status>',
        `filter by status, repeatable or comma-separated: ${STATUS_HELP}`,
        collectList,
      )
      .option('--assignee <who>', 'me, agents, or a member name, email or id')
      .option(
        '--milestone <name>',
        "milestone name (in one --project, else this clone's project) or id; none for tasks without one",
      )
      .option('--cycle <cycle>', 'cycle number, current, next, or none for tasks without one')
      .option(
        '--label <name>',
        "tasks with any of these labels, by name (in --project, else this clone's project); " +
          'repeatable or comma-separated',
        collectKeys,
      )
      .option('--due <state>', `due date: ${DUE_FILTER_HELP}`)
      .option('--blocked', 'only tasks with an open blocker')
      .option('--no-blocked', 'only tasks without an open blocker')
      .option('--top-level', 'leave subtasks out')
      .option('--parent <TASK-KEY>', 'only the subtasks of this task')
      .option('--sort <order>', `one order for the whole list: ${SORT_HELP} (default: status, then priority)`)
      .option('--limit <n>', 'tasks per page, 1 to 200 (default 50)')
      .option('--cursor <cursor>', 'next page, from the previous result'),
  ).action((options) => listTasks(context, options));

  leaf(
    tasks
      .command('show')
      .description(
        'show a task with its work record (criteria, done items, plan, final summary) and its history: ' +
          'activity, comments and notes, oldest first',
      )
      .argument('<TASK-KEY>', TASK_KEY_HELP)
      .option('--project <KEY>', TASK_PROJECT_HELP),
  ).action((key: string, options) => showTask(context, key, options));

  leaf(
    tasks
      .command('create')
      .description('create a task')
      .argument('<title...>', 'task title (quote it, or pass the words)')
      .option('--project <KEY>', PROJECT_HELP)
      .option('--description <text>', 'Markdown description; "-" reads it from stdin')
      .option('--priority <priority>', PRIORITY_HELP)
      .option('--assignee <who>', 'me, or a member name, email or id')
      .option('--status <status>', `${STATUS_HELP} (default todo)`)
      .option('--milestone <name>', 'milestone of the project, by name or id')
      .option('--cycle <cycle>', 'cycle number, current or next')
      .option('--label <name>', LABEL_HELP, collectKeys)
      .option('--due <date>', 'due date, YYYY-MM-DD')
      .option(
        '--parent <TASK-KEY>',
        "make it a subtask of this task (same project, one level); it takes the parent's assignee unless --assignee is given",
      )
      .option('--blocked-by <TASK-KEY>', BLOCKER_HELP, collectKeys)
      .option('--ac <text>', 'add an acceptance criterion (one line); repeatable', collectTexts)
      .option('--dod <text>', "add a done item after the project's default ones; repeatable", collectTexts)
      .option('--no-dod-defaults', "leave the project's default done items out")
      .option('--plan <text>', 'implementation plan, Markdown; "-" reads it from stdin'),
  ).action((title: string[], options) => createTask(context, title, options));

  leaf(
    tasks
      .command('update')
      .description(
        'change a task; send only what changes (mirrored tasks: only --cycle, the rest changes in Backlog.md)',
      )
      .argument('<TASK-KEY>', TASK_KEY_HELP)
      .option('--project <KEY>', TASK_PROJECT_HELP)
      .option('--status <status>', STATUS_HELP)
      .option('--priority <priority>', PRIORITY_HELP)
      .option('--assignee <who>', 'me, or a member name, email or id')
      .option('--unassign', 'remove the assignee')
      .option('--title <title>', 'new title')
      .option('--description <text>', 'new Markdown description; "-" reads it from stdin')
      .option('--milestone <name>', "milestone of the task's project, by name or id; none clears it")
      .option('--cycle <cycle>', 'cycle number, current or next; none clears it')
      .option('--label <name>', `add a label: ${LABEL_HELP}`, collectKeys)
      .option('--remove-label <name>', 'take a label off; repeatable or comma-separated', collectKeys)
      .option('--due <date>', 'due date, YYYY-MM-DD; none clears it')
      .option(
        '--parent <TASK-KEY>',
        'make it a subtask of this task (same project, one level); none makes it top level',
      )
      .option('--blocked-by <TASK-KEY>', `add a blocker: ${BLOCKER_HELP}`, collectKeys)
      .option('--unblock <TASK-KEY>', 'remove a blocker; repeatable or comma-separated', collectKeys)
      .option('--ac <text>', 'add an acceptance criterion at the end (one line); repeatable', collectTexts)
      .option('--check-ac <n>', `check criterion n: ${ITEM_NUMBER_HELP}`, collectNumbers)
      .option('--uncheck-ac <n>', `uncheck criterion n: ${ITEM_NUMBER_HELP}`, collectNumbers)
      .option('--remove-ac <n>', `remove criterion n: ${ITEM_NUMBER_HELP}`, collectNumbers)
      .option('--waive-ac <n>', 'waive criterion n; needs --reason; repeatable', waives.waive('criterion'))
      .option('--unwaive-ac <n>', `take the waiver off criterion n: ${ITEM_NUMBER_HELP}`, collectNumbers)
      .option('--dod <text>', 'add a done item at the end (one line); repeatable', collectTexts)
      .option('--check-dod <n>', `check done item n: ${ITEM_NUMBER_HELP}`, collectNumbers)
      .option('--uncheck-dod <n>', `uncheck done item n: ${ITEM_NUMBER_HELP}`, collectNumbers)
      .option('--remove-dod <n>', `remove done item n: ${ITEM_NUMBER_HELP}`, collectNumbers)
      .option('--waive-dod <n>', 'waive done item n; needs --reason; repeatable', waives.waive('done'))
      .option('--unwaive-dod <n>', `take the waiver off done item n: ${ITEM_NUMBER_HELP}`, collectNumbers)
      .option(
        '--reason <text>',
        'why the waived items no longer apply (one line); applies to the --waive-ac and --waive-dod before it',
        waives.reason,
      )
      .option('--plan <text>', 'implementation plan, Markdown; "-" reads it from stdin, "" clears it')
      .option('--final-summary <text>', 'final summary, Markdown; "-" reads it from stdin, "" clears it')
      .option(
        '--append-notes <text>',
        'add a work note after the update; "-" reads it from stdin; repeated ones join into one note',
        collectTexts,
      ),
  ).action((key: string, options) => updateTask(context, key, options));

  const notes = program.command('notes').description('work notes on a task (M6)');
  leaf(
    notes
      .command('add')
      .description('add a work note: what you did, found or tried; it notifies only the people it mentions')
      .argument('<TASK-KEY>', TASK_KEY_HELP)
      .argument('<text>', 'Markdown (quote it); "-" reads it from stdin')
      .option('--project <KEY>', TASK_PROJECT_HELP),
  ).action((key: string, text: string, options) => addNote(context, key, text, options));

  const queue = program
    .command('queue')
    .description('list the writes waiting for the server in the offline queue (no server needed)');
  leaf(queue).action(() => showQueue(context));
  leaf(
    queue
      .command('drop')
      .description('remove a queued write so it is never sent')
      .argument('<ID>', 'id from zamu queue'),
  ).action((id: string) => dropQueueEntry(context, id));

  const labels = program
    .command('labels')
    .description('list, create, rename, recolour and delete project labels');
  leaf(
    labels
      .command('list')
      .description('list the labels of a project with the number of tasks using each')
      .option('--project <KEY>', PROJECT_HELP),
  ).action((options) => listLabels(context, options));

  leaf(
    labels
      .command('create')
      .description('create a label (tasks create missing labels too: zamu tasks update KEY --label name)')
      .argument('<name...>', 'label name, up to 40 characters, unique in the project ignoring case')
      .option('--project <KEY>', PROJECT_HELP)
      .option('--color <n>', `${COLOR_HELP} (default: the least used one)`),
  ).action((name: string[], options) => createLabel(context, name, options));

  leaf(
    labels
      .command('update')
      .description('rename or recolour a label; labels from Backlog.md keep their name')
      .argument('<name>', 'label name (ignoring case) or id')
      .option('--project <KEY>', PROJECT_HELP)
      .option('--name <name>', 'new name')
      .option('--color <n>', COLOR_HELP),
  ).action((name: string, options) => updateLabel(context, name, options));

  leaf(
    labels
      .command('delete')
      .description('delete a label and take it off every task (task history keeps the name)')
      .argument('<name>', 'label name (ignoring case) or id')
      .option('--project <KEY>', PROJECT_HELP)
      .option('--confirm <name>', 'the label name again; nothing is deleted without it'),
  ).action((name: string, options) => deleteLabel(context, name, options));

  const comments = program.command('comments').description('list, add, edit and delete task comments');
  leaf(
    comments
      .command('list')
      .description('list the comments of a task, oldest first')
      .argument('<TASK-KEY>', TASK_KEY_HELP)
      .option('--project <KEY>', TASK_PROJECT_HELP),
  ).action((key: string, options) => listComments(context, key, options));

  leaf(
    comments
      .command('add')
      .description('comment on a task; @agent-name and @email mention members')
      .argument('<TASK-KEY>', TASK_KEY_HELP)
      .argument('<body>', 'Markdown body (quote it); "-" reads it from stdin')
      .option('--project <KEY>', TASK_PROJECT_HELP),
  ).action((key: string, body: string, options) => addComment(context, key, body, options));

  leaf(
    comments
      .command('edit')
      .description('replace the body of your own comment')
      .argument('<comment-id>', 'id from zamu comments list or zamu tasks show')
      .argument('<body>', 'new Markdown body (quote it); "-" reads it from stdin'),
  ).action((id: string, body: string) => editComment(context, id, body));

  leaf(
    comments
      .command('delete')
      .description('delete your own comment (the timeline keeps a placeholder)')
      .argument('<comment-id>', 'id from zamu comments list or zamu tasks show'),
  ).action((id: string) => deleteComment(context, id));

  const milestones = program.command('milestones').description('list, create and update milestones');
  leaf(
    milestones
      .command('list')
      .description('list the milestones of a project with progress')
      .option('--project <KEY>', PROJECT_HELP),
  ).action((options) => listMilestones(context, options));

  leaf(
    milestones
      .command('create')
      .description('create a milestone (starts Planned)')
      .argument('<name...>', 'milestone name (quote it, or pass the words)')
      .option('--project <KEY>', PROJECT_HELP)
      .option('--target <date>', 'target date, YYYY-MM-DD')
      .option('--description <text>', 'Markdown description; "-" reads it from stdin'),
  ).action((name: string[], options) => createMilestone(context, name, options));

  leaf(
    milestones
      .command('update')
      .description('change a milestone; send only what changes')
      .argument('<id-or-name>', 'milestone id, or its name (case-insensitive) with --project')
      .option('--project <KEY>', "project to find the milestone name in (default: this clone's)")
      .option('--name <name>', 'new name')
      .option('--target <date>', 'target date, YYYY-MM-DD; none clears it')
      .option('--status <status>', `${MILESTONE_STATUS_HELP}; leaving completed reopens it as active`)
      .option('--description <text>', 'Markdown description; "-" reads it from stdin, "" clears it'),
  ).action((idOrName: string, options) => updateMilestone(context, idOrName, options));

  const cycles = program.command('cycles').description('list, create, show and end cycles');
  leaf(
    cycles
      .command('list')
      .description('list the cycles of a project, oldest first')
      .option('--project <KEY>', PROJECT_HELP),
  ).action((options) => listCycles(context, options));

  leaf(
    cycles
      .command('create')
      .description('create a cycle; dates default to the day after the last cycle, same length')
      .option('--project <KEY>', PROJECT_HELP)
      .option('--starts <date>', 'first day, YYYY-MM-DD')
      .option('--ends <date>', 'last day, YYYY-MM-DD (1 to 56 days in all)')
      .option('--name <name>', 'optional name'),
  ).action((options) => createCycle(context, options));

  leaf(
    cycles
      .command('current')
      .description("show the project's current cycle (null with --json when there is none)")
      .option('--project <KEY>', PROJECT_HELP),
  ).action((options) => currentCycle(context, options));

  leaf(
    cycles
      .command('end')
      .description('end a cycle now; unfinished tasks move to the next cycle')
      .argument('[number]', 'cycle number (default: the current cycle)')
      .option('--project <KEY>', PROJECT_HELP)
      .option(
        '--move-to <cycle>',
        'cycle number for unfinished tasks, or none (default: next upcoming cycle, else a new one)',
      ),
  ).action((number: string | undefined, options) => endCycle(context, number, options));

  const backlog = program
    .command('backlog')
    .description('status and refresh of a Backlog.md mirror; export of a project owned by Zamu');
  leaf(
    backlog
      .command('status')
      .description('show where the mirror reads from, the last read, counts and problems')
      .option('--project <KEY>', PROJECT_HELP)
      .option('--problems', 'list every problem (files skipped or read with a warning, unmapped values)'),
  ).action((options) => backlogStatus(context, options));

  leaf(
    backlog
      .command('refresh')
      .description('queue a read of the default branch now (owners, admins and agents with write access)')
      .option('--project <KEY>', PROJECT_HELP)
      .option('--wait', 'wait until the read ends (up to 5 minutes) and report how it went'),
  ).action((options) => backlogRefresh(context, options));

  leaf(
    backlog
      .command('export')
      .description(
        'write the project as Backlog.md files under tasks/ and milestones/, and remove task and milestone ' +
          'files it no longer has; documents, decisions, drafts and config.yml stay as they are',
      )
      .option('--project <KEY>', PROJECT_HELP)
      .option('--dir <path>', 'the Backlog.md folder (default: backlog at the repository root)')
      .option('--dry-run', 'list what would change and write nothing')
      .option('--force', 'write even when the exported folders have uncommitted changes'),
  ).action((options) => backlogExport(context, options));

  return program;
}

/** Runs one zamu invocation and returns its exit code. `argv` excludes node and the script path. */
export async function main(argv: readonly string[], io: CliIo): Promise<number> {
  // Every server call of the command replays the offline queue first and may queue (M6).
  const context = withOfflineQueue(createContext(io, wantsJson(argv)));
  const program = buildProgram(context);
  try {
    await program.parseAsync([...argv], { from: 'user' });
    return EXIT.ok;
  } catch (error) {
    if (error instanceof CommanderError) {
      // --help and --version end here with exit code 0.
      if (error.exitCode === 0) return EXIT.ok;
      // Commander already printed the message (unless --json); with --json print the envelope.
      if (context.json) reportError(context, usageError(error.message.replace(/^error: /, '')));
      return EXIT.usage;
    }
    if (error instanceof QueuedWrite) {
      reportQueued(context, error);
      return CLI_EXIT_QUEUED;
    }
    const failure = toCliError(error, context.url);
    await describeFailure(context, failure);
    reportError(context, failure);
    return failure.exitCode;
  }
}
