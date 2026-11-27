# zamu

`zamu` is the command-line client for [Zamu](https://github.com/reddevsdotio/zamu), a self-hosted project
management tool where AI coding agents work next to people. People and agents run it with their own API
keys, and it talks to the server's REST API at `/api/v1`.

```sh
npm install --global @reddevs/zamu
zamu login --key zamu_live_... --url https://zamu.example.com
zamu tasks list --mine
```

`zamu --help` lists the commands. Every command takes `--help` and `--json`.

## Install

With npm, on Node 24 or later:

```sh
npm install --global @reddevs/zamu
zamu --version
```

With Homebrew:

```sh
brew install reddevsdotio/tap/zamu
```

Keep the full Homebrew name. A bare `brew install zamu` after `brew tap` stops with a trust error on current
Homebrew.

To upgrade, run `npm update --global @reddevs/zamu` or `brew upgrade reddevsdotio/tap/zamu`.

The Docker image also ships the CLI as `zamu`. To run it from a clone of the Zamu repository instead:

```sh
pnpm install
pnpm --filter @zamu/cli build
node apps/cli/dist/index.js --help
```

## Log in

1. Create an API key in Settings > API keys. An agent gets its key when an admin adds the agent.
2. Log in with the key and the server's URL:

   ```sh
   zamu login --key zamu_live_... --url https://zamu.example.com
   ```

To keep the key out of your shell history, pipe it in:

```sh
zamu login --key - --url https://zamu.example.com < key.txt
```

`zamu login` checks the key with `GET /api/v1/me` and reads the key's workspace from the answer. A
**workspace** has its own projects, members, agents and keys, and one server can hold several.

zamu stores the URL, the key and the workspace in `$XDG_CONFIG_HOME/zamu/config.json`, or in
`~/.config/zamu/config.json`. Only you can read the file (mode 0600).

Without `--url`, zamu uses `ZAMU_URL`, then the default login's server, then `http://localhost:3000`.

`zamu whoami` shows:
- the user, the workspace, the role and the key scope
- how zamu picked the login
- the project zamu uses in the current folder
- the writes waiting in the [offline queue](#offline-queue)

### Several workspaces

A key belongs to one workspace, so you run `zamu login` once per workspace and per server. zamu keeps one
login for each. Logging in again with a new key for the same workspace replaces its key.

The first login is the default. `zamu login --default` or `zamu workspaces --default <slug>` changes it.

```sh
zamu login --key zamu_live_... --url https://zamu.example.com   # Acme: the default
zamu login --key zamu_live_...                                  # Globex, on the same server
zamu workspaces                                                 # the logins, * marks the one used here
zamu --workspace globex tasks list --mine                       # one command in Globex
zamu logout                                                     # remove the login used here
zamu logout --workspace globex                                  # or that one, or --all
```

### Which login a command uses

Each command uses the first login that applies:
1. `--workspace <slug>`. It takes a slug or a workspace id, and every command takes it.
2. `ZAMU_KEY` (with `ZAMU_URL`), as in earlier versions.
3. The login zamu matched to this clone's git remote earlier. zamu caches it in
   `$XDG_STATE_HOME/zamu/clones.json` (`~/.local/state/zamu/clones.json`).
4. The login whose workspace has a project linked to the remote. When no workspace has one, the login whose
   workspace has the project that the nearest `.zamu.json` names.
5. The default login.

For step 4, zamu asks every login at once, within the usual 5 seconds, and caches a single match. When the
cached login gets a 403 or 404, zamu matches again. If another login fits, zamu sends the request again with
it.

With one login there is nothing to match. `ZAMU_URL` without `ZAMU_KEY` narrows the logins to that server.

Two cases stop a command:
- The clone matches two or more logins. For example, two workspaces each have a project `PAY`, and
  `.zamu.json` names `PAY`. The command stops with exit code 1 and lists the `--workspace` values to pass.
- The key is for another workspace. Every request of a login names its workspace in the `x-zamu-workspace`
  header, and the server refuses a key used for another workspace with 403 `WORKSPACE_MISMATCH` (exit code
  4). So `ZAMU_KEY=... zamu --workspace globex ...` with an Acme key fails instead of reading Acme's data.

### Config file from zamu 0.9

The config file of zamu 0.9 (`{ "url", "key" }`) keeps working. The first command that reaches the server
reads the key's workspace and writes the file back in the new form (`{ "version": 2, "logins" }`). Offline,
zamu uses the old file as it is.

### Environment variables

Agents in CI usually skip `zamu login` and set:

| Variable       | Meaning                                                                                                       |
| -------------- | ------------------------------------------------------------------------------------------------------------- |
| `ZAMU_URL`     | Server URL. With `ZAMU_KEY`, the server for that key. Alone, zamu uses only the logins for that server.       |
| `ZAMU_KEY`     | API key. Overrides the stored logins. `ZAMU_API_KEY` (printed by the dev seed) works too.                     |
| `ZAMU_PROJECT` | Project key for commands that need one, when `--project` is not given.                                        |
| `ZAMU_MACHINE` | Machine name sent with every request (default: the host name). See [Machine and branch](#machine-and-branch). |
| `NO_COLOR`     | Turns colour off. `FORCE_COLOR=1` turns it on when output is piped.                                           |

## Project of the current folder

Commands that work on one project (`tasks create`, `milestones`, `cycles`) take `--project`. Without it,
zamu uses the first of:
1. `ZAMU_PROJECT`.
2. The nearest `.zamu.json` from the current folder up to the repository root. It holds
   `{ "project": "PAY" }`. Commit it, or put one in each subfolder of a monorepo that holds several
   projects.
3. The project linked to this clone's git remote (`origin`, or the only remote). A project links to one
   repository. HTTPS and SSH URLs of the same repository match.

Link once from a clone, or set Repository in the project's settings (General) on the web:

```sh
zamu link --project PAY          # link PAY to this clone's remote
zamu link --project PAY --force  # replace another repository linked to PAY
zamu link --clear                # unlink this clone's project
zamu link --file --project PAY   # write .zamu.json at the repository root instead
zamu link --file --here --project WEB   # .zamu.json in this folder (monorepo subproject)
zamu whoami                      # Project  PAY (from git remote gitlab.com/reddevs/payments)
```

`zamu tasks list` still spans every project unless you pass `--project`. It uses the folder's project only to
look up a name in `--milestone <name>` or `--label <name>`.

When nothing names a project, a command that needs one exits with code 1 and says how to fix it.

## Instructions for coding agents

`zamu instructions` prints how agents work on a task with zamu. The text ships with the CLI, so it matches
the version installed.

```sh
zamu instructions                # overview: the work record, the rules, the exit codes
zamu instructions creating       # search first, then a task with testable criteria
zamu instructions working        # the plan, a note after each step, checking what is proven
zamu instructions finishing      # the final summary, In review, the final report
zamu instructions planning       # the plan link, waves with gates, zamu milestones show
```

The work record is what an agent writes on the task as it works. See [Work record](#work-record).

`zamu agents` writes a short block into the repository's `AGENTS.md`, or into `CLAUDE.md` when only that
exists. The block sits between `<!-- zamu:start ... -->` and `<!-- zamu:end -->`. It names the folder's
project when zamu can find it and points agents to `zamu instructions`.

```sh
zamu agents                      # AGENTS.md, else CLAUDE.md, at the repository root
zamu agents --file docs/AI.md    # another file
zamu agents --print              # print the block instead
```

Run it again after you upgrade zamu. It replaces only that block.

What the block says depends on who owns the project's tasks. Zamu owns them, or the project **mirrors**
[Backlog.md](https://github.com/MrLesk/Backlog.md) task files from its repository and the files own them.
[Backlog.md mirrors](#backlogmd-mirrors) has the details.
- The project mirrors Backlog.md. The block adds that the task files own the task fields and the work
  record, and that `zamu backlog refresh --wait` reads them after a push.
- Zamu owns the project, which was never mirrored or was switched from a mirror. zamu replaces a Backlog.md
  guidelines block in the file with one line, and `--json` reports that as `replacedBacklogBlock: true`. For
  a switched project the zamu block also says the Backlog.md task files are a copy written by
  `zamu backlog export`.
- zamu can't ask the server, because there is no key or no project here. It leaves a Backlog.md block alone.

The Backlog.md guidelines block sits between `<!-- BACKLOG.MD GUIDELINES START -->` and
`<!-- BACKLOG.MD GUIDELINES END -->`. zamu replaces it, markers included. The line that takes its place says
that tasks are in Zamu and that the `backlog` CLI is only for documents and decisions.

## Commands

Each group of commands has a section:

| Section                                                                                    | Commands                                            |
| ------------------------------------------------------------------------------------------ | --------------------------------------------------- |
| [Tasks](#tasks)                                                                            | `zamu tasks list`, `show`, `create`, `update`       |
| [Work record](#work-record)                                                                | The work record flags of `zamu tasks`, `zamu notes` |
| [Labels, due dates, subtasks and blockers](#labels-due-dates-subtasks-and-blockers)        | Their flags on `zamu tasks`, `zamu labels`          |
| [Milestones and cycles](#milestones-and-cycles)                                            | `zamu milestones`, `zamu cycles`                    |
| [Waves and gates](#waves-and-gates)                                                        | `zamu milestones show`, `zamu waves`                |
| [Pull requests, archive and check-again days](#pull-requests-archive-and-check-again-days) | `zamu pr`, `zamu tasks archive`, `restore`          |
| [Comments](#comments)                                                                      | `zamu comments`                                     |
| [Dashboard](#dashboard)                                                                    | `zamu dashboard`                                    |
| [Projects](#projects)                                                                      | `zamu projects`                                     |
| [Backlog.md mirrors](#backlogmd-mirrors)                                                   | `zamu backlog status`, `refresh`                    |
| [Backlog.md export](#backlogmd-export)                                                     | `zamu backlog export`                               |
| [Offline queue](#offline-queue)                                                            | `zamu queue`                                        |

These rules hold for every command:
- Human output is a compact table with task keys first. zamu uses colour only when stdout is a terminal.
- Agents show as "claude-dev for Ana Ruiz", which names the agent and the person responsible for it.
- Project and task keys are case-insensitive, so `pay-142` works.
- Subtasks mirrored from Backlog.md have suffixed keys (`PAY-786.1`, `PAY-786.1.2`).
- `--description -` and a comment body of `-` read the text from stdin.

### Tasks

`zamu tasks` lists, shows, creates and updates tasks.

```sh
zamu tasks list                                   # every project you can read
zamu tasks list --mine                            # your tasks in every project
zamu tasks list --project PAY --status todo,in_progress --assignee me --limit 20
zamu tasks list --project PAY,WEB --assignee agents
zamu tasks show PAY-142
zamu tasks create --project PAY "Retry failed webhooks" --priority high --assignee claude-dev
zamu tasks create "Retry failed webhooks"          # in a clone linked to PAY
git log -1 --format=%B | zamu tasks create --project PAY "Follow up on the release" --description -
zamu tasks update PAY-142 --status in_review
zamu tasks update PAY-142 --assignee "Ana Ruiz" --priority urgent
zamu tasks update PAY-142 --unassign
```

| Option       | Values                                                                                                                |
| ------------ | --------------------------------------------------------------------------------------------------------------------- |
| `--status`   | `backlog`, `todo`, `in_progress`, `in_review`, `done`, `canceled`.`in-progress` and `"In progress"` are accepted too. |
| `--priority` | `none`, `low`, `medium`, `high`, `urgent`.                                                                            |
| `--assignee` | `me`, a member's name or email, or a user id. `zamu tasks list` also takes `agents`.                                  |
| `--mine`     | Short for `--assignee me`.                                                                                            |
- Without `--project`, `zamu tasks list` spans every project the key can read. `--project` repeats or takes
  a comma-separated list.
- `zamu tasks list` returns 50 tasks by default, and up to 200 with `--limit`. When there are more, it
  prints a cursor. Pass the cursor with `--cursor` to get the next page.

### Work record

A task's **work record** is its acceptance criteria, its definition of done (a list of done items), a plan,
work notes and a final summary. The flags use the names of the Backlog.md CLI.

```sh
zamu tasks create "Retry failed payouts" --ac "A failed payout is retried up to 8 times" --ac "On-call is alerted once"
zamu tasks create "Retry failed payouts" --dod "Runbook updated" --no-dod-defaults --plan - < plan.md
zamu tasks update PAY-142 --status in_progress --plan - < plan.md
zamu tasks update PAY-142 --check-ac 1 --check-ac 2,3 --check-dod 1
zamu tasks update PAY-142 --waive-ac 5 --reason "Load test replaced by a replay"
zamu tasks update PAY-142 --ac "Retries stop when the payout is canceled" --remove-ac 3
zamu tasks update PAY-142 --append-notes "Migration written and tested"
zamu tasks update PAY-142 --check-ac 6 --final-summary - --status in_review < summary.md
zamu notes add PAY-142 "Backoff schedule covered by tests"
```

| Flag                               | On                 | What it does                                                         |
| ---------------------------------- | ------------------ | -------------------------------------------------------------------- |
| `--ac "text"`                      | `create`, `update` | Adds an acceptance criterion at the end. Repeatable.                 |
| `--check-ac N`, `--uncheck-ac N`   | `update`           | Checks or unchecks criterion N.                                      |
| `--remove-ac N`                    | `update`           | Removes criterion N. The ones after it move up.                      |
| `--waive-ac N --reason "text"`     | `update`           | Waives criterion N. It no longer applies, for that reason.           |
| `--unwaive-ac N`                   | `update`           | Takes the waiver back. The item is open again.                       |
| `--dod "text"`                     | `create`, `update` | Adds a done item. On `create`, after the project's default ones.     |
| `--check-dod N`, `--uncheck-dod N` | `update`           | Checks or unchecks done item N.                                      |
| `--remove-dod N`                   | `update`           | Removes done item N.                                                 |
| `--waive-dod N --reason "text"`    | `update`           | Waives done item N.                                                  |
| `--unwaive-dod N`                  | `update`           | Takes the waiver off done item N.                                    |
| `--no-dod-defaults`                | `create`           | Leaves the project's default done items out.                         |
| `--plan "text"`                    | `create`, `update` | Sets the plan (Markdown). An empty value clears it on `update`.      |
| `--final-summary "text"`           | `update`           | Sets the final summary (Markdown). An empty value clears it.         |
| `--append-notes "text"`            | `update`           | Adds a work note after the update. Repeated ones join into one note. |

#### How the flags work

- Numbers are the ones `zamu tasks show` prints. The number flags repeat or take a comma-separated list
  (`--check-ac 1,2,3`).
- Numbers refer to the list as it was before the command. A removal moves the numbers after it up.
- All the flags of one command go in one request. `--check-ac 3 --final-summary - --status in_review`
  checks the item, writes the summary and moves the task at once.
- `--reason` belongs to the waives typed before it. `--waive-ac 4 --waive-ac 5 --reason "..."` waives both
  with one reason. `--waive-ac 4 --reason "a" --waive-ac 5 --reason "b"` gives each its own.
- `-` reads `--plan`, `--final-summary`, `--append-notes` or `--description` from stdin. Only one of them
  can read stdin per command.
- Criteria and done items are one line each, up to 500 characters, 50 per list. The plan and the summary
  take up to 50,000 characters.

#### Work notes

- `zamu notes add PAY-142 "text"` writes a work note, like `--append-notes`.
- A note is a comment of kind `note`. It shows quietly in the history and notifies only the people it
  mentions.
- `--append-notes` alone writes only the note. With other flags the note goes after the update, and a
  refused update writes no note.

#### What `zamu tasks show` prints

1. The final summary.
2. The description.
3. The criteria and done items with their numbers and states: `[x]` checked, `[ ]` open, `[~]` waived with
   the reason and who waived it.
4. The plan with who last wrote it.
5. The history with notes, comments and changes. The heading counts them:
   `History · 7 notes · 2 comments · 18 changes`.

#### What zamu refuses

A waive without any `--reason` exits 1 and sends nothing.

An agent can't move a task to In review or Done while a criterion or done item is open. zamu prints the
open items with the flags that settle each one and exits 1 (`OPEN_ITEMS`, with `openItems` in the `--json`
error):

```text
$ zamu tasks update PAY-142 --status in_review
zamu: PAY-142 has open items: criterion 6. Check or waive them before moving it to In review (open_items).
  criterion 6  The on-call runbook has an entry for exhausted retries
               check: --check-ac 6   waive: --waive-ac 6 --reason "..."
  Check only what is proven and waive the rest with a reason. One command can settle them and move it:
    zamu tasks update PAY-142 <flags above> --status in_review
```

The server never refuses a person's key this way. The web app asks the person first.

On a task mirrored from Backlog.md the work record is read-only, and `zamu tasks show` marks its lists
"from Backlog.md, read-only". Writing the work record, or a note, exits 6 with the `backlog task edit`
command to run, as for other fields.

### Labels, due dates, subtasks and blockers

Set these fields with flags on `zamu tasks create` and `zamu tasks update`, and filter on them with
`zamu tasks list`. `zamu labels` manages a project's labels.

```sh
zamu tasks list --project PAY --label bug,ui --due overdue --sort due
zamu tasks list --project PAY --blocked                  # or --no-blocked
zamu tasks list --project PAY --top-level                # leave subtasks out
zamu tasks list --parent PAY-142                         # the subtasks of PAY-142
zamu tasks create --project PAY "Refund email" --parent PAY-142 --label email --due 2026-11-20
zamu tasks create --project PAY "Send receipts" --blocked-by PAY-140,PAY-141
zamu tasks update PAY-142 --label ui --remove-label bug --due none
zamu tasks update PAY-150 --blocked-by PAY-142 --unblock PAY-139
zamu tasks update PAY-151 --parent none                  # back to the top level

zamu labels list --project PAY                           # with the number of tasks using each
zamu labels create --project PAY "Needs design" --color 4
zamu labels update "needs design" --project PAY --name design --color 7
zamu labels delete design --project PAY --confirm design
```

#### Labels

Labels belong to a project. Names are up to 40 characters and unique in the project, ignoring case.
- `--label` on `zamu tasks create` and `zamu tasks update` adds labels by name and creates the ones the
  project doesn't have. `--remove-label` takes them off. Both repeat or take a comma-separated list.
- `zamu tasks list --label` looks names up in `--project`, or in the folder's project, and matches tasks
  with any of them. With several projects, a name matches in each project that has it.
- `zamu labels` lists, creates, renames, recolours and deletes labels. Colours are `--color 1` to `9`. The
  commands take a label name (any case) or id.
- `zamu labels delete` takes the label off every task. `--confirm` repeats the name, in any case.
- Renames and deletes write no task history.
- Labels read from Backlog.md files keep their name. Their colour still changes.

zamu refuses these:

| Case                                                                | Exit code | Error code       |
| ------------------------------------------------------------------- | --------- | ---------------- |
| `zamu tasks list --label` with a name that none of the projects has | 1         |                  |
| `zamu labels` with an unknown label                                 | 3         |                  |
| A name the project has already                                      | 1         | `LABEL_EXISTS`   |
| Renaming or deleting a label read from Backlog.md files             | 6         | `LABEL_MIRRORED` |
| `zamu labels delete` without `--confirm`, or with another name      | 1         |                  |

The first case also lists the project's labels. In the last case zamu sends nothing and prints
"Pass --confirm design to delete label design from PAY."

#### Due dates

- `--due YYYY-MM-DD` sets the due date. `none` clears it on `zamu tasks update`.
- `zamu tasks list --due` takes one of these values. Today is the server's day.

| Value     | Tasks it lists                             |
| --------- | ------------------------------------------ |
| `overdue` | Open tasks due before today                |
| `soon`    | Open tasks due today or in the next 2 days |
| `none`    | Tasks with no due date                     |
| `set`     | Tasks with any due date                    |

#### Subtasks

- `--parent KEY` makes a task a subtask of another task in the same project. `none` makes it top level
  again.
- A new subtask takes the parent's assignee unless you pass `--assignee`.
- Subtasks go one level deep. A deeper one fails with `SUBTASK_DEPTH`, exit 1.

#### Blockers

- `--blocked-by KEY` adds a blocker from the same project, and `--unblock KEY` removes one. A key from
  another project fails with `NOT_SAME_PROJECT`.
- A task is blocked while any blocker is open. A blocker never stops a status change.
- A blocker that closes a loop fails with exit code 1:
  `zamu: Can't add: PAY-150 already waits on PAY-142.` The code is `DEPENDENCY_LOOP`, and the `--json` error
  carries `loop: { task, blocker }`.

#### Sorting and output

- `zamu tasks list --sort` orders the whole list by `priority`, `due` (soonest first, none last), `updated`
  or `created` (newest first), or `manual` (board order). Without it the list is grouped by status, then
  priority.
- `zamu tasks list` adds DUE, LABELS, PARENT, SUBTASKS and BLOCKED columns when a row has a value for them.
- `zamu tasks show` adds Labels, Due, Parent, Subtasks, Blocked by and Blocks, and "· blocked" after the
  status. Subtasks reads done of total, with canceled subtasks left out of the count, then one line each. A
  blocker you can't see reads "Removed task".

### Milestones and cycles

A milestone has a name, a status and an optional target date. A cycle is a numbered period with a first and
a last day. Both belong to a project.

```sh
zamu milestones list --project PAY
zamu milestones create --project PAY "Webhooks v2" --target 2026-11-14 --description -
zamu milestones update "webhooks v2" --project PAY --target none --status completed
zamu milestones update <milestone-id> --name "Webhooks v3"

zamu milestones show "Payouts v2"                 # the plan: waves, gates, locks, tasks and what comes next
zamu milestones update "Payouts v2" --plan plans/payouts-v2.html   # or a web address; --no-plan removes it
zamu waves add "Payouts v2" Ledger --gate "Entries balance for every payout in the staging run"
zamu waves add "Payouts v2" "Payout screens" --gate - < gate.md
zamu waves update "Payouts v2" W3 --name "Screens" --position 2
zamu waves remove "Payouts v2" W4                 # its tasks stay in the milestone, in no wave
zamu waves put "Payouts v2" W3 PAY-170 PAY-171    # none as the wave takes them out
zamu waves pass "Payouts v2" W3 --note "Checked both themes at 1440, 1280 and 1024"
zamu waves fail "Payouts v2" W3 --note - < what-failed.md
zamu tasks update PAY-174 --wave W4               # or 4, the name, or --no-wave

zamu cycles list --project PAY
zamu cycles create --project PAY --starts 2026-10-26 --ends 2026-11-08 --name "Checkout rewrite"
zamu cycles create --project PAY                  # the day after the last cycle, same length
zamu cycles current --project PAY
zamu cycles end --project PAY                     # the current cycle
zamu cycles end 12 --project PAY --move-to none

zamu tasks list --project PAY --milestone "Webhooks v2" --cycle current
zamu tasks list --project PAY --milestone none --cycle none
zamu tasks create --project PAY "Retry failed webhooks" --milestone "Webhooks v2" --cycle next
zamu tasks update PAY-142 --milestone "Webhooks v2" --cycle 12
zamu tasks update PAY-142 --milestone none --cycle none
```

`--milestone none` and `--cycle none` clear the field on `zamu tasks update` and filter tasks without one on
`zamu tasks list`.

#### Milestones

- `--milestone` takes a milestone id or its name, ignoring case.
- `--target none` clears a milestone's target date.
- Setting any status but `completed` on a completed milestone reopens it as `active`.

zamu looks a milestone name up in one project:

| Command                                       | Project                                            |
| --------------------------------------------- | -------------------------------------------------- |
| `zamu tasks list`                             | `--project` (exactly one), or the folder's project |
| `zamu tasks create`, `zamu milestones update` | `--project`, or the folder's project               |
| `zamu tasks update`                           | The task key's project                             |

An unknown name fails with exit code 1 and lists the project's milestones.

#### Cycles

- `--cycle` takes a cycle number, `current` or `next`.
- `zamu cycles current` prints `null` data with `--json` (exit code 0) when the project has no current
  cycle.
- `zamu cycles end` ends the current cycle unless you pass a number.

When a cycle ends, its unfinished tasks move to the first of:
1. `--move-to`, which takes a cycle number or `none`.
2. The next upcoming cycle.
3. A new cycle of the same length.

### Waves and gates

A milestone's tasks can run in waves, one after the other. Each wave ends at a gate: checks that must pass
before the next wave starts. A wave is locked until every gate before it has passed. The commands are in
the example under [Milestones and cycles](#milestones-and-cycles).

#### Names

- The milestone is an id, or its name with `--project` (or the folder's project).
- A wave is its number (`3` or `W3`) or its name, ignoring case. An unknown wave exits 1 and lists the
  milestone's waves.

#### `zamu milestones show`

`zamu milestones show <milestone>` is the one command a dispatching agent reads. It prints:
1. The milestone with its status, target and progress.
2. The plan link.
3. Each wave with its number, name and progress, its gate state, its lock and its tasks (key, status,
   assignee, title). The gate state includes the latest result's first note line and who recorded it.
4. The tasks in no wave.
5. A last line that says what comes next.

```text
Next: W3 has 2 open tasks: PAY-173, PAY-174. When they are done, run the gate's checks and record the result: zamu waves pass ...
```

#### Set up the plan and the waves

- `zamu milestones update --plan <url-or-path>` links the plan. A web address opens in the app, and a file
  path shows as a path. `--no-plan` removes it.
- `zamu waves add` adds a wave at the end, or at `--position N`. The waves from there move down.
- `zamu waves update` changes `--name`, `--gate` (`""` clears it) or `--position`.
- `zamu waves remove` removes a wave with its gate results. Its tasks stay in the milestone, in no wave.
- `--gate -` reads the gate description from stdin.

#### Put tasks in a wave

- `zamu waves put <milestone> <wave> KEY...` puts up to 100 tasks in a wave, all or nothing. Tasks of
  another milestone move to this one. In a project that mirrors Backlog.md that exits 6. `none` as the wave
  takes the tasks out of their wave.
- `zamu tasks update KEY --wave <wave>` puts one task in a wave of its milestone, or of `--milestone` when
  given. The task's milestone becomes the wave's. `--no-wave` (or `--wave none`) takes it out.
- `zamu tasks show` prints the wave and its lock (`W4 · Rollout · locked until W3 passes`), and
  `zamu tasks list` a WAVE column.

#### Gates and the lock

- `zamu waves pass` and `zamu waves fail` record a gate result. `--note` is required and says what was
  checked. `--note -` reads it from stdin.
- A pass while a task of the wave is neither Done nor Canceled fails with `GATE_TASKS_OPEN` (exit 1) and
  lists the open tasks. A fail is accepted at any time.
- An agent that starts a task (Backlog or Todo to In progress or In review) in a locked wave gets
  `WAVE_LOCKED` (exit 1). The message names the wave it waits for and the command that shows the plan.
- A person may start the task. zamu prints `Warning: PAY-174 is in W4, which is locked until W3 passes.` on
  stderr after the change.

#### Offline

- None of the `zamu waves` writes waits in the [offline queue](#offline-queue).
- `zamu tasks update --wave` does. zamu looks the wave up in the plans it has seen on this machine, in
  `waves.json` next to the queue, from `zamu milestones show` and `zamu waves put`. The server applies the
  lock rule when the write is sent.

### Pull requests, archive and check-again days

Zamu links pull and merge requests to tasks and moves the tasks when a request opens or merges. An
**archived** task is read-only and left out of lists. A **check-again day** is a day you set to look at a
waiting task again.

```sh
zamu pr link PAY-142 https://github.com/northwind/payments/pull/482
zamu pr link PAY-142 https://gitlab.example.com/northwind/payments/-/merge_requests/12 --dry-run
zamu pr unlink PAY-142 482
zamu tasks archive PAY-140 PAY-141                # or PAY-140,PAY-141
zamu tasks restore PAY-140
zamu tasks update PAY-142 --check-again 2026-12-03 --reason "Waiting for the bank's answer"
zamu tasks update PAY-142 --no-check-again
zamu tasks list --mine --ready-to-check           # or --waiting
zamu tasks list --project PAY --archived only     # or include; archived tasks are left out without it
```

#### How a request links to a task

A pull or merge request links to a task in three ways:
1. You started the task (`--status in_progress` or `in_review`) from the request's head branch. zamu sends
   the branch as `x-zamu-branch`.
2. The request's description has a line such as `Closes: PAY-142, PAY-150`.
3. You ran `zamu pr link`.

Opening a request moves its tasks to In review. A merge into the default branch moves them to Done when the
project closes on merge, and `zamu projects show` says whether it does. Zamu reads the host and never
writes to it.

#### Linking by hand

- `zamu pr link TASK URL` takes the request's web address in the project's repository.
- `--dry-run` shows the request as it would link and writes nothing (`zamu.v1.pr.link`, `dryRun: true`).
- `zamu pr unlink TASK NUMBER` removes a link. It takes `482`, `#482` or `!12`. GitHub and Forgejo requests
  read `#482`, GitLab merge requests `!12`.
- After an unlink, neither the branch nor a `Closes:` line brings the link back. `zamu pr link` does.

`zamu pr link` refuses these:

| Case                             | Error code                 | Exit code |
| -------------------------------- | -------------------------- | --------- |
| A request of another repository  | `REQUEST_OTHER_REPOSITORY` | 1         |
| An address that is not a request | `NOT_A_REQUEST`            | 1         |
| A request the host doesn't know  | `REQUEST_NOT_FOUND`        | 3         |

#### Archive

- `zamu tasks archive KEY...` and `zamu tasks restore KEY...` take up to 100 keys, all or nothing
  (`zamu.v1.tasks.archive`, `zamu.v1.tasks.restore`).
- `zamu tasks list` leaves archived tasks out. `--archived include` adds them and `--archived only` lists
  only them.
- An archived task refuses every write, comments and notes included (`TASK_ARCHIVED`, exit 1):
  `zamu: PAY-12 is archived. Restore it first: zamu tasks restore PAY-12`
- Tasks of a mirrored project follow Backlog.md's `archive/tasks/` folder instead (exit 6).

#### Check-again days

- `--check-again YYYY-MM-DD --reason "..."` on `zamu tasks update` sets the day. The reason is required. A
  day without one exits 1 before anything is sent.
- `--no-check-again` clears the day, and so does moving the task to Done or Canceled.
- `--reason` pairs with the `--check-again`, `--waive-ac` and `--waive-dod` before it, as for waives.
- `zamu tasks list --waiting` lists tasks whose day is still ahead. `--ready-to-check` lists those whose day
  has come.

#### What `zamu tasks show` adds

- The work branch.
- The requests, each with its number, title, state, how it was linked and its address.
- The check-again day.
- The archive date.
- "Merged with 2 open criteria" when a merge closed the task with items open.

History names the host for request events ("GitHub moved this to In review · #482 opened by claude-dev") and
Zamu for the nightly archive job, which archives closed tasks after the number of days the project sets.

### Comments

```sh
zamu comments list PAY-142
zamu comments add PAY-142 "Ready for review, @ana@example.com"
pnpm test 2>&1 | tail -20 | zamu comments add PAY-142 -
zamu comments edit <comment-id> "New body"
zamu comments delete <comment-id>
```

- Comment bodies are Markdown, up to 20,000 characters.
- `@agent-name` and `@email` mention workspace members. The server rewrites them to
  `[@Name](mention:<userId>)` links. Unknown names stay plain text.
- Only the author edits or deletes a comment, agents included.
- A deleted comment stays in the history as "Comment deleted by ...".
- `zamu tasks show` prints the task's history. Activity takes one line per entry. Comments are indented
  blocks with their author, "for" the agent's human, the time and the comment id.

### Dashboard

`zamu dashboard` prints what needs someone now.

```sh
zamu dashboard                                    # Mine: your tasks, your agents' tasks and mentions of you
zamu dashboard --everyone                         # the whole workspace
zamu dashboard --json                             # { schema: 'zamu.v1.dashboard', data: Dashboard }
```

The output has three parts:
1. Four groups: In review, Mentions, Stalled and Deadlines. Each prints its total and up to 10 lines, then
   `… N more`. An empty group prints one line, `Mentions · none`.
2. One row per project, with open, doing, review, current cycle, next milestone and last activity.
3. The agents, with who they work for, their current task or Idle, and a stalled marker.

The scope decides what the groups cover:
- Mine is the default. It covers your tasks, the tasks of the agents you are responsible for, and mentions
  of you.
- For an agent's key, Mine means the agent's own tasks and mentions of it.
- `--everyone` covers every project the key can read.

Use `--json` for every item, up to 50 per group. Each group's `total` counts them all.

With an agent's key:

```text
$ zamu dashboard
Needs you · 5

In review · 1
  PAY-5  Webhook signature check accepts expired timestamps  claude-dev for Ana Ruiz  in review 3h

Mentions · 1
  PAY-1  Ana Ruiz  Thanks @claude-dev, looks good.  25m ago

Stalled · 1
  WEB-1  Dark mode flickers on first load  claude-dev for Ana Ruiz  no update 26h

Deadlines · 2
  WEB  Cycle 1 · Settings polish   0/3 done  3 open  ends tomorrow
  PAY  Cycle 1 · Checkout rewrite  0/6 done  6 open  ends in 2 days
```

The projects table and the agents follow.

### Projects

```sh
zamu projects list                                # with each project's linked repository
zamu projects show PAY                            # repository, close on merge, webhook, hourly check, archive days
zamu projects delete PAY --confirm PAY            # owners and admins; cannot be undone
```

`zamu projects delete` deletes the project with its tasks, comments, history, milestones, cycles and
Backlog.md mirror. There is no undo.
- `--confirm` must repeat the key, in any case. Without it, or with another key, zamu exits with code 1
  ("Pass --confirm PAY to delete project PAY.") and sends nothing.
- The command needs an owner or admin, with a person's key that has whole-workspace access and write
  permission.
- An agent's key gets exit code 4, and an unknown project gets 3.

### Backlog.md mirrors

A project can mirror a Backlog.md folder from its repository. You set that up in the project's settings on
the web. Zamu then reads the task files and refuses writes to what the files own.

```sh
zamu backlog status --project PAY                 # where the mirror reads from, last read, counts
zamu backlog status --problems                    # every file skipped or read with a warning, unmapped values
zamu backlog refresh                              # queue a read of the default branch now
zamu backlog refresh --wait                       # wait for it (up to 5 minutes) and report how it went
```

#### Task keys and ids

- Mirrored tasks keep their Backlog.md numbers. `BACK-786.1` becomes `PAY-786.1`.
- Every command that takes a task key also takes the Backlog.md id, as in `zamu tasks show BACK-786.1`.
- An app key wins over an id with the same text.
- Ids like `TASK-12` can repeat across projects. zamu looks the id up in `--project`, `ZAMU_PROJECT` or
  `.zamu.json` when one is set. When the id alone is not enough, it also looks in the project linked to the
  clone's remote.

#### What Backlog.md owns

Backlog.md owns the title, description, status, priority, assignee and milestone of a mirrored task, and
every milestone of the project. Changing one fails with exit code 6 and says where to change it:

```text
$ zamu tasks update PAY-786 --status done
error: PAY-786 is mirrored from Backlog.md, so its status can't change here (task_mirrored).
  file:  backlog/tasks/back-786 - Retry-failed-webhook-deliveries-with-exponential-backoff.md (main)
  edit the file and push, or run: backlog task edit 786 -s Done
  still allowed here: comments (zamu comments add PAY-786) and cycles (zamu tasks update PAY-786 --cycle 4)
```

- You add new tasks and milestones of a mirrored project in Backlog.md too (`project_mirrored`,
  `milestone_mirrored`).
- With `--json` the error is the problem as the server sent it, with `field`, `file`, `backlogId` and
  `hint`.
- `zamu tasks show` adds the Backlog.md id and file, the locked fields, and "Hidden" for a task whose file
  is gone from the default branch.
- Changes a refresh made show as "Backlog.md" with the commit.

#### Refresh

A refresh reads the default branch again. `zamu backlog refresh` needs an owner, an admin, or an agent whose
key can write the project.
- `--wait` checks the status every 2 seconds until the read ends, up to 5 minutes.
- `--wait` exits 0 whatever the read found, so check `state` in the JSON. It is `healthy`, `warnings`,
  `failed` or `paused`.
- `outcome` is `queued` without `--wait`. With `--wait` it is `finished`, or `timeout` when no read ended
  in time. On a `timeout`, check that the worker is running.

The command fails with exit code 6 in two cases:
- The mirror is paused (`BACKLOG_PAUSED`). The connection is missing, rejected or unreachable.
- The mirror is detached (`BACKLOG_DETACHED`). The project was switched to Zamu, or imported, and no longer
  reads the files.

### Backlog.md export

`zamu backlog export` writes a project owned by Zamu as Backlog.md files, so the repository keeps a
readable copy. A project is owned by Zamu when it was never mirrored, or when you switched it from a mirror
in the project's settings.

```sh
zamu backlog export --dry-run                     # list what would change, write nothing
zamu backlog export                               # write backlog/tasks, backlog/archive/tasks and backlog/milestones
zamu backlog export --project PAY --dir docs/backlog
zamu backlog export --force                       # write over uncommitted changes in the exported folders
```

- The files come from `GET /api/v1/projects/{key}/backlog/export`.
- `--dir` is relative to the current folder. Without it zamu uses `backlog` at the repository root, or in
  the current folder outside a repository.
- Tasks go to `tasks/`, archived tasks to `archive/tasks/` and milestones to `milestones/`.
- zamu removes the Markdown files under `tasks/`, `archive/tasks/`, `completed/` and `milestones/` that the
  export doesn't have.
- zamu writes and removes nothing else in the folder. Documents, decisions, drafts, `config.yml` and files
  that aren't Markdown stay as they are.
- `--json` prints `zamu.v1.backlog.export`. It holds the project, the folder, `dryRun`, the format the
  files target and every file with its action (`created`, `updated`, `unchanged`, `removed`).

Refusals and warnings:
- zamu refuses (exit 1) when `tasks/`, `archive/tasks/`, `completed/` or `milestones/` have uncommitted
  changes, untracked files included, and it lists them. Commit or discard them, or pass `--force`.
  `--dry-run` never refuses.
- A project that still mirrors Backlog.md exits 6 (`PROJECT_MIRRORED`), because its files are the source.
- The Backlog.md CLI lists nothing without a `config.yml` whose `task_prefix` matches the exported ids. zamu
  warns on stderr when the file is missing or the prefix differs.

### Offline queue

Every request has 5 seconds to connect and answer. When the server doesn't answer (it is down, restarting
or unreachable), some writes on a task that already exists wait in a queue instead of failing.

```sh
zamu queue                                        # writes waiting for the server (offline queue)
zamu queue drop 3b77132b                          # remove one so it is never sent
```

#### What waits

- `--check-ac`, `--uncheck-ac`, `--waive-ac`, `--unwaive-ac` and the same four with `-dod`
- `--status`, `--check-again` and `--no-check-again`
- `--wave` and `--no-wave`, when zamu has seen the milestone's waves on this machine (`zamu milestones show`)
- `zamu notes add`, `--append-notes` and `zamu comments add`
- `zamu tasks archive`, `zamu tasks restore`, `zamu pr link` (not with `--dry-run`) and `zamu pr unlink`

zamu prints `Queued: the server didn't answer. It will be sent on your next zamu command.` and exits with
code 7 (`zamu.v1.queued` with `--json`).

Everything else fails with exit code 5 and queues nothing:
- Creating a task.
- Every read.
- An update that mixes a queueable flag with another one, such as `--check-ac 1 --priority high`. The error
  names the flags that can't wait.

A 5xx answer is an error too, because the server answered.

#### How zamu sends the queue

- The next command that reaches the same server sends the queue first, oldest first.
- zamu reports each write on stderr, so `--json` output stays one result:
  `Sent: PAY-142 check criterion 2 (queued ...)`.
- When the server still doesn't answer, or answers 401, 408, 429 or 5xx, the rest wait for the next
  command.
- zamu drops a write that the server refuses with another 4xx, and reports it (`Dropped: ...`).

#### Queued status changes

- zamu sends a queued status change only if the task still has the status zamu last saw.
- When someone moved the task meanwhile, zamu drops the move (`Skipped: PAY-142 was already moved to Done`).
  It still sends the checks and waivers queued with it.
- zamu remembers the status of every task the server returned on this machine, in `statuses.json` next to
  the queue.
- zamu keeps remembered statuses per server and workspace, so `PAY-1` of one workspace never stands in for
  `PAY-1` of another.
- Without a remembered status, because zamu never read the task here, a status change is not queued. Run
  `zamu tasks show PAY-142` once the server answers.

#### Which login sends a queued write

- A queued write keeps the login it was queued with. The next command that reaches the server sends it with
  that stored login's key and workspace, whichever login the command itself uses.
- Entries from zamu 0.9 go out with the stored login that holds their key, else with the command's login.
- A write queued with a key zamu doesn't store (a `ZAMU_KEY`) waits for a command that uses that key. That
  way it keeps its author when a person and an agent share a machine. zamu says how many wait.
- The queue stores a fingerprint of the key, never the key.
- The machine and branch are those of the command that sends the write.

#### The queue file

- The queue is `$XDG_STATE_HOME/zamu/queue.json` (`~/.local/state/zamu/queue.json`).
- zamu changes it under a lock file and writes it atomically, so agents running zamu at the same time on
  one machine never lose an entry.
- `zamu queue` lists what waits (`zamu.v1.queue.list`) and `zamu queue drop ID` removes an entry
  (`zamu.v1.queue.drop`). Neither contacts the server.
- `zamu queue` adds a WORKSPACE column when the writes belong to several workspaces.
- `zamu whoami` shows how many writes still wait for its server (`queued`).

### Machine and branch

Every request carries two headers:
- `x-zamu-machine` holds the machine name. That is `ZAMU_MACHINE`, else the host name.
- `x-zamu-branch` holds the branch, when the folder is in a git repository with a branch checked out.

The server stores them on history entries, notes and gate results. `zamu tasks show` prints them at the
end of each line, as in `build-box · feat/payout-retries`.

Names are cut to 100 characters. Characters outside ASCII are sent percent-encoded.

## JSON output

Every command takes `--json` and prints one versioned result:

```json
{
  "schema": "zamu.v1.tasks.show",
  "data": { "task": { "key": "PAY-142", "...": "..." }, "activity": [], "timeline": [] }
}
```

| Command                  | Schema                      |
| ------------------------ | --------------------------- |
| `zamu login`             | `zamu.v1.login`             |
| `zamu logout`            | `zamu.v1.logout`            |
| `zamu whoami`            | `zamu.v1.whoami`            |
| `zamu workspaces`        | `zamu.v1.workspaces`        |
| `zamu dashboard`         | `zamu.v1.dashboard`         |
| `zamu projects list`     | `zamu.v1.projects.list`     |
| `zamu projects show`     | `zamu.v1.projects.show`     |
| `zamu projects delete`   | `zamu.v1.projects.delete`   |
| `zamu tasks list`        | `zamu.v1.tasks.list`        |
| `zamu tasks show`        | `zamu.v1.tasks.show`        |
| `zamu tasks create`      | `zamu.v1.tasks.create`      |
| `zamu tasks update`      | `zamu.v1.tasks.update`      |
| `zamu tasks archive`     | `zamu.v1.tasks.archive`     |
| `zamu tasks restore`     | `zamu.v1.tasks.restore`     |
| `zamu pr link`           | `zamu.v1.pr.link`           |
| `zamu pr unlink`         | `zamu.v1.pr.unlink`         |
| `zamu comments list`     | `zamu.v1.comments.list`     |
| `zamu comments add`      | `zamu.v1.comments.add`      |
| `zamu comments edit`     | `zamu.v1.comments.edit`     |
| `zamu comments delete`   | `zamu.v1.comments.delete`   |
| `zamu milestones list`   | `zamu.v1.milestones.list`   |
| `zamu milestones create` | `zamu.v1.milestones.create` |
| `zamu milestones update` | `zamu.v1.milestones.update` |
| `zamu milestones show`   | `zamu.v1.milestone-plan`    |
| `zamu waves add`         | `zamu.v1.wave`              |
| `zamu waves update`      | `zamu.v1.wave`              |
| `zamu waves remove`      | `zamu.v1.wave-removed`      |
| `zamu waves put`         | `zamu.v1.milestone-plan`    |
| `zamu waves pass`        | `zamu.v1.gate-result`       |
| `zamu waves fail`        | `zamu.v1.gate-result`       |
| `zamu cycles list`       | `zamu.v1.cycles.list`       |
| `zamu cycles create`     | `zamu.v1.cycles.create`     |
| `zamu cycles current`    | `zamu.v1.cycles.current`    |
| `zamu cycles end`        | `zamu.v1.cycles.end`        |
| `zamu link`              | `zamu.v1.link`              |
| `zamu agents`            | `zamu.v1.agents`            |
| `zamu backlog status`    | `zamu.v1.backlog.status`    |
| `zamu backlog refresh`   | `zamu.v1.backlog.refresh`   |
| `zamu backlog export`    | `zamu.v1.backlog.export`    |
| `zamu notes add`         | `zamu.v1.notes.add`         |
| `zamu instructions`      | `zamu.v1.instructions`      |
| `zamu labels list`       | `zamu.v1.labels.list`       |
| `zamu labels create`     | `zamu.v1.labels.create`     |
| `zamu labels update`     | `zamu.v1.labels.update`     |
| `zamu labels delete`     | `zamu.v1.labels.delete`     |
| `zamu queue`             | `zamu.v1.queue.list`        |
| `zamu queue drop`        | `zamu.v1.queue.drop`        |
| a write that was queued  | `zamu.v1.queued`            |
| any failure              | `zamu.v1.error`             |

### Stability and format

- The data schemas live in `@zamu/contracts` (`cliDataSchemas`, `parseCliOutput`).
- Within `v1`, fields are only ever added. Removing or changing a field needs `zamu.v2`.
- JSON is printed on one line when piped and indented at a terminal.

### Errors

With `--json`, failures print `zamu.v1.error` on stdout. It is an RFC 9457 problem with `code`, `status`
and `detail`, plus `requestId` and `issues` when the server sent them. The exit code is still non-zero.

Some errors carry more fields:

| Error                        | Extra fields                            |
| ---------------------------- | --------------------------------------- |
| The Backlog.md mirror errors | `field`, `file`, `backlogId` and `hint` |
| `DEPENDENCY_LOOP`            | `loop`                                  |
| `OPEN_ITEMS`                 | `openItems`                             |
| `REQUEST_OTHER_REPOSITORY`   | `repository`                            |
| `WAVE_LOCKED`                | `waveLock` and `hint`                   |
| `GATE_TASKS_OPEN`            | `openKeys`                              |

### Notes on some schemas

`zamu.v1.tasks.show` holds these:

| Field                              | What it holds                                                                                                   |
| ---------------------------------- | --------------------------------------------------------------------------------------------------------------- |
| `activity`                         | Kept for v1 readers.                                                                                            |
| `timeline`                         | Activity, comments and notes in one list, oldest first, told apart by `kind` (`activity`, `comment` or `note`). |
| `timelineCounts`                   | The size of each filter (`all`, `comments`, `notes`, `history`).                                                |
| `task`, the work record            | `criteria`, `doneItems`, `plan`, `planMeta`, `finalSummary` and `finalSummaryMeta`.                             |
| `task`, from zamu 0.11.0           | `workBranch`, `pullRequests`, `checkAgain`, `closedAt`, `archivedAt`, `archivedBy` and `mergedOpen`.            |
| Activity entries, from zamu 0.11.0 | `cause` and `system`.`system` says who acted when no person did: the git host, Zamu or Backlog.md.              |
| `task`, from zamu 0.12.0           | `wave`: `id`, `number`, `name`, `locked` and `lockedUntil`.                                                     |

The other schemas:
- `zamu.v1.projects.delete` is `{ "deleted": "PAY" }`.
- `zamu.v1.labels.delete` is the label as it was and the number of tasks it was on:
  `{ "deleted": { "id": "...", "name": "design", "color": 7, "source": "app" }, "usageCount": 3 }`.
- `zamu.v1.backlog.status` holds the first 50 problems unless you pass `--problems`, which reads them all.
- `zamu.v1.backlog.refresh` is the refresh request plus `outcome` and, with `--wait`, the final `status`.
- `zamu.v1.projects.show` is `{ "project": ..., "repository": ... }`. It holds the project with
  `archiveAfterDays` (null is off) and its repository settings, which are null when the key may not read
  them.
- `zamu.v1.pr.link` is `{ "task": "PAY-142", "pullRequest": ..., "dryRun": false }`.
- `zamu.v1.pr.unlink` is `{ "task": "PAY-142", "number": 482 }`.
- `zamu.v1.login` adds `replaced` (a login for that server and workspace existed) and `default`.
- `zamu.v1.logout` adds `removed`, which lists every login removed, without keys.
- `zamu.v1.whoami` adds `workspaceSource`, one of `flag`, `env`, `clone` or `default`.
- `zamu.v1.workspaces` is
  `{ "items": [{ "url", "workspace": { "id", "name", "slug" }, "default", "current" }], "source" }`.
  `current` marks the login commands use here. `source` says how zamu picked it. It is `env` when `ZAMU_KEY`
  is set and null when the clone matches several logins.
- `zamu.v1.agents` adds `replacedBacklogBlock`.
- `zamu.v1.milestone-plan` is `{ "milestone", "planUrl", "waves", "notInWave" }`. Each wave has its
  `number`, `name`, `gate` (`description`, `state`, the latest `result`), `current`, `locked`,
  `lockedUntil`, `progress`, `canPass`, `openKeys` and `tasks`.
- `zamu.v1.wave-removed` is `{ "milestoneId", "removed": { "id", "number", "name" }, "tasks": ["PAY-180"] }`.
- `zamu.v1.gate-result` is `{ "result", "wave" }`.
- From zamu 0.12.0, milestones carry `planUrl` and `waves`, the summary: `count`, `current`, `currentState`
  and `allPassed`.
- `zamu tasks update` with `--append-notes` alone prints `zamu.v1.notes.add`, the note. With other flags it
  prints `zamu.v1.tasks.update`.

## Exit codes

| Code | Meaning                                                                                                                                                                                      |
| ---- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| 0    | OK                                                                                                                                                                                           |
| 1    | Usage: bad arguments, unknown milestone names, input the server rejected (400, 409, 422), `OPEN_ITEMS`, `WAVE_LOCKED` and `GATE_TASKS_OPEN` included, or a clone that matches several logins |
| 2    | Auth: not logged in, or the key was refused (401)                                                                                                                                            |
| 3    | Not found (404)                                                                                                                                                                              |
| 4    | Forbidden: the key's scope or access does not allow it, owners and admins only, or the key is for another workspace (403)                                                                    |
| 5    | Server: unreachable (and nothing queued), 5xx, or a response this version does not understand                                                                                                |
| 6    | Backlog.md: the change belongs in Backlog.md, or the mirror is paused or detached (409)                                                                                                      |
| 7    | Queued: the server didn't answer, so the write waits in the offline queue for the next command                                                                                               |

## Development

Run these from a clone of the Zamu repository:

```sh
pnpm --filter @zamu/cli dev tasks list --project PAY      # run from source with tsx
pnpm --filter @zamu/cli test                             # needs Postgres: docker compose -f docker-compose.dev.yml up -d db
pnpm --filter @zamu/cli build
```

The tests run every command in-process against the real `/api/v1` handler from `apps/web`. They use a
throwaway database seeded with the dev data, and they validate each `--json` result against the contract
schemas.

To try the CLI against a local server:

```sh
eval "$(pnpm -s --filter web seed)"      # prints ZAMU_API_KEY for the claude-dev agent
pnpm --filter web dev
node apps/cli/dist/index.js login --key "$ZAMU_API_KEY"
node apps/cli/dist/index.js tasks list --project PAY
```
