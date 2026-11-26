# zamu

Command-line client for Zamu. People and AI coding agents use it with their own API keys.
It talks to the server's REST API at `/api/v1`.

## Install

With npm (needs Node 24 or later):

```sh
npm install --global @reddevs/zamu
zamu --version
```

With Homebrew:

```sh
brew install reddevsdotio/tap/zamu
```

Keep the full name: a bare `brew install zamu` after `brew tap` stops with a trust error on current
Homebrew. To upgrade, run `npm update --global @reddevs/zamu` or `brew upgrade reddevsdotio/tap/zamu`.

The Docker image also ships the CLI as `zamu`. To run it from a clone of this repository instead:

```sh
pnpm install
pnpm --filter @zamu/cli build
node apps/cli/dist/index.js --help
```

## Log in

Create an API key in Settings > API keys (agents get theirs when an admin adds them), then:

```sh
zamu login --key zamu_live_... --url https://zamu.example.com
```

`zamu login` checks the key with `GET /api/v1/me`, reads the key's workspace from the answer and stores
the URL, the key and the workspace in `$XDG_CONFIG_HOME/zamu/config.json` (or
`~/.config/zamu/config.json`), readable only by you (mode 0600). Without `--url` it uses `ZAMU_URL`, then
the default login's server, then `http://localhost:3000`.

To keep the key out of your shell history, pipe it in:

```sh
zamu login --key - --url https://zamu.example.com < key.txt
```

`zamu whoami` shows the user, workspace, role, key scope, how zamu picked the login, the project zamu uses
in the current folder and the writes waiting in the offline queue.

### Several workspaces

A key belongs to one workspace. Run `zamu login` once per workspace (and per server): zamu keeps one
login for each, and logging in again with a new key for the same workspace replaces its key. The first
login is the default; `zamu login --default` or `zamu workspaces --default <slug>` changes it.

```sh
zamu login --key zamu_live_... --url https://zamu.example.com   # Acme: the default
zamu login --key zamu_live_...                                  # Globex, on the same server
zamu workspaces                                                 # the logins, * marks the one used here
zamu --workspace globex tasks list --mine                       # one command in Globex
zamu logout                                                     # remove the login used here
zamu logout --workspace globex                                  # or that one, or --all
```

Each command uses the first login that applies:
1. `--workspace <slug>` (a slug or a workspace id; every command takes it).
2. `ZAMU_KEY` (with `ZAMU_URL`), as before.
3. The login zamu matched to this clone's git remote earlier, cached in
   `$XDG_STATE_HOME/zamu/clones.json` (`~/.local/state/zamu/clones.json`).
4. The login whose workspace has a project linked to the remote, or, when none is, the project the
   nearest `.zamu.json` names. zamu asks every login at once, within the usual 5 seconds, and caches a
   single match. When the cached login gets a 403 or 404, zamu matches again and, if another login fits,
   sends the request again with it.
5. The default login.

With one login there is nothing to match. When a clone matches two or more logins (two workspaces each
have a project `PAY`, and `.zamu.json` names `PAY`), the command stops with exit code 1 and lists the
`--workspace` values to pass. `ZAMU_URL` without `ZAMU_KEY` narrows the logins to that server.

Every request of a login names its workspace in the `x-zamu-workspace` header. The server refuses a key
used for another workspace with 403 `WORKSPACE_MISMATCH` (exit code 4), so `ZAMU_KEY=... zamu --workspace
globex ...` with an Acme key fails instead of reading Acme's data.

The config file of zamu 0.9 (`{ "url", "key" }`) keeps working. The first command that reaches the
server reads the key's workspace and writes the file back in the new form (`{ "version": 2, "logins" }`);
offline, zamu uses the old file as it is.

### Environment variables

Agents in CI usually skip `zamu login` and set:

| Variable       | Meaning                                                                                   |
| -------------- | ----------------------------------------------------------------------------------------- |
| `ZAMU_URL`     | Server URL. With `ZAMU_KEY`, the server for that key; alone, only its logins are used.    |
| `ZAMU_KEY`     | API key. Overrides the stored logins. `ZAMU_API_KEY` (printed by the dev seed) works too. |
| `ZAMU_PROJECT` | Project key for commands that need one, when `--project` is not given.                    |
| `ZAMU_MACHINE` | Machine name sent with every request (default: the host name). See below.                 |
| `NO_COLOR`     | Turns colour off. `FORCE_COLOR=1` turns it on when output is piped.                       |

## Project of the current folder

Commands that work on one project (`tasks create`, `milestones`, `cycles`) take `--project`. Without
it, zamu uses the first of:
1. `ZAMU_PROJECT`.
2. The nearest `.zamu.json` from the current folder up to the repository root: `{ "project": "PAY" }`.
   Commit it, or put one in each subfolder of a monorepo that holds several projects.
3. The project linked to this clone's git remote (`origin`, or the only remote). A project links to
   one repository; HTTPS and SSH URLs of the same repository match.

Link once from a clone, or set Repository in the project's settings (General) on the web:

```sh
zamu link --project PAY          # link PAY to this clone's remote
zamu link --project PAY --force  # replace another repository linked to PAY
zamu link --clear                # unlink this clone's project
zamu link --file --project PAY   # write .zamu.json at the repository root instead
zamu link --file --here --project WEB   # .zamu.json in this folder (monorepo subproject)
zamu whoami                      # Project  PAY (from git remote gitlab.com/reddevs/payments)
```

`zamu tasks list` still spans every project unless you pass `--project`; only `--milestone <name>` uses
the folder's project to look the name up. When nothing names a project, a command that needs one
exits with code 1 and says how to fix it.

### Instructions for coding agents

`zamu instructions` prints how agents work on a task with zamu. The text ships with the CLI, so it
matches the version installed:

```sh
zamu instructions                # overview: the work record, the rules, the exit codes
zamu instructions creating       # search first, then a task with testable criteria
zamu instructions working        # the plan, a note after each step, checking what is proven
zamu instructions finishing      # the final summary, In review, the final report
```

`zamu agents` writes a short block into the repository's `AGENTS.md` (or `CLAUDE.md` when only that
exists), between `<!-- zamu:start ... -->` and `<!-- zamu:end -->`. It names the folder's project when zamu
can find it and points agents to `zamu instructions`. Run it again after upgrading zamu: it replaces only
that block.

```sh
zamu agents                      # AGENTS.md, else CLAUDE.md, at the repository root
zamu agents --file docs/AI.md    # another file
zamu agents --print              # print the block instead
```

What the block says depends on the project:
- A project that mirrors Backlog.md: the block adds that the task files own the task fields and the work
  record, and that `zamu backlog refresh --wait` reads them after a push.
- A project owned by Zamu (never mirrored, or switched from a mirror): when the file holds a Backlog.md
  guidelines block (between `<!-- BACKLOG.MD GUIDELINES START -->` and `<!-- BACKLOG.MD GUIDELINES END -->`),
  zamu replaces it, markers included, with one line: tasks are in Zamu, and the `backlog` CLI is only for
  documents and decisions. `--json` reports it as `replacedBacklogBlock: true`. For a switched project the
  block also says the Backlog.md task files are a copy written by `zamu backlog export`.
- When zamu can't ask the server (no key, or no project here), it leaves a Backlog.md block alone.

## Commands

```sh
zamu dashboard                                    # Mine: your tasks, your agents' tasks and mentions of you
zamu dashboard --everyone                         # the whole workspace
zamu dashboard --json                             # { schema: 'zamu.v1.dashboard', data: Dashboard }

zamu projects list                                # with each project's linked repository
zamu projects delete PAY --confirm PAY            # owners and admins; cannot be undone

zamu tasks list                                   # every project you can read
zamu tasks list --mine                            # your tasks in every project
zamu tasks list --project PAY --status todo,in_progress --assignee me --limit 20
zamu tasks list --project PAY,WEB --assignee agents
zamu tasks list --project PAY --milestone "Webhooks v2" --cycle current
zamu tasks list --project PAY --milestone none --cycle none
zamu tasks show PAY-142
zamu tasks create --project PAY "Retry failed webhooks" --priority high --assignee claude-dev
zamu tasks create "Retry failed webhooks"          # in a clone linked to PAY
zamu tasks create --project PAY "Retry failed webhooks" --milestone "Webhooks v2" --cycle next
git log -1 --format=%B | zamu tasks create --project PAY "Follow up on the release" --description -
zamu tasks update PAY-142 --status in_review
zamu tasks update PAY-142 --assignee "Ana Ruiz" --priority urgent
zamu tasks update PAY-142 --unassign
zamu tasks update PAY-142 --milestone "Webhooks v2" --cycle 12
zamu tasks update PAY-142 --milestone none --cycle none

zamu tasks list --project PAY --label bug,ui --due overdue --sort due
zamu tasks list --project PAY --blocked                  # or --no-blocked
zamu tasks list --project PAY --top-level                # leave subtasks out
zamu tasks list --parent PAY-142                         # the subtasks of PAY-142
zamu tasks create --project PAY "Refund email" --parent PAY-142 --label email --due 2026-11-20
zamu tasks create --project PAY "Send receipts" --blocked-by PAY-140,PAY-141
zamu tasks update PAY-142 --label ui --remove-label bug --due none
zamu tasks update PAY-150 --blocked-by PAY-142 --unblock PAY-139
zamu tasks update PAY-151 --parent none                  # back to the top level

zamu tasks create "Retry failed payouts" --ac "A failed payout is retried up to 8 times" --ac "On-call is alerted once"
zamu tasks create "Retry failed payouts" --dod "Runbook updated" --no-dod-defaults --plan - < plan.md
zamu tasks update PAY-142 --status in_progress --plan - < plan.md
zamu tasks update PAY-142 --check-ac 1 --check-ac 2,3 --check-dod 1
zamu tasks update PAY-142 --waive-ac 5 --reason "Load test replaced by a replay"
zamu tasks update PAY-142 --ac "Retries stop when the payout is canceled" --remove-ac 3
zamu tasks update PAY-142 --append-notes "Migration written and tested"
zamu tasks update PAY-142 --check-ac 6 --final-summary - --status in_review < summary.md
zamu notes add PAY-142 "Backoff schedule covered by tests"

zamu labels list --project PAY                           # with the number of tasks using each
zamu labels create --project PAY "Needs design" --color 4
zamu labels update "needs design" --project PAY --name design --color 7
zamu labels delete design --project PAY --confirm design

zamu comments list PAY-142
zamu comments add PAY-142 "Ready for review, @ana@example.com"
pnpm test 2>&1 | tail -20 | zamu comments add PAY-142 -
zamu comments edit <comment-id> "New body"
zamu comments delete <comment-id>

zamu milestones list --project PAY
zamu milestones create --project PAY "Webhooks v2" --target 2026-11-14 --description -
zamu milestones update "webhooks v2" --project PAY --target none --status completed
zamu milestones update <milestone-id> --name "Webhooks v3"

zamu cycles list --project PAY
zamu cycles create --project PAY --starts 2026-10-26 --ends 2026-11-08 --name "Checkout rewrite"
zamu cycles create --project PAY                  # the day after the last cycle, same length
zamu cycles current --project PAY
zamu cycles end --project PAY                     # the current cycle
zamu cycles end 12 --project PAY --move-to none

zamu backlog status --project PAY                 # where the mirror reads from, last read, counts
zamu backlog status --problems                    # every file skipped or read with a warning, unmapped values
zamu backlog refresh                              # queue a read of the default branch now
zamu backlog refresh --wait                       # wait for it (up to 5 minutes) and report how it went
zamu backlog export --project PAY --dry-run       # what the export would write and remove
zamu backlog export                               # write backlog/tasks and backlog/milestones at the repository root

zamu instructions finishing                       # the guide for finishing a task

zamu queue                                        # writes waiting for the server (offline queue)
zamu queue drop 3b77132b                          # remove one so it is never sent
```

- Project and task keys are case-insensitive (`pay-142` works). Subtasks mirrored from Backlog.md have
  suffixed keys (`PAY-786.1`, `PAY-786.1.2`).
- Statuses: `backlog`, `todo`, `in_progress`, `in_review`, `done`, `canceled`. `in-progress` and
  `"In progress"` are accepted too.
- Priorities: `none`, `low`, `medium`, `high`, `urgent`.
- `--assignee` takes `me`, a member's name or email, or a user id. `zamu tasks list` also takes `agents`;
  `--mine` is short for `--assignee me`.
- `zamu tasks list` without `--project` spans every project the key can read. `--project` repeats or
  takes a comma-separated list.
- `--description -` and a comment body of `-` read the text from stdin.
- `zamu tasks list` returns 50 tasks by default (up to 200 with `--limit`). When there are more, it prints
  a cursor; pass it with `--cursor` to get the next page.
- `zamu projects delete` deletes the project with its tasks, comments, history, milestones, cycles and
  Backlog.md mirror. There is no undo. `--confirm` must repeat the key (any case); without it, or with
  another key, zamu exits with code 1 ("Pass --confirm PAY to delete project PAY.") and sends nothing. It
  needs an owner or admin, with a person's key that has whole-workspace access and write permission.
  Agents get exit code 4, an unknown project 3.

### Milestones and cycles

- `--milestone` takes a milestone id or its name, ignoring case. Names are looked up in the project:
  `--project` (or the folder's project) for `zamu tasks list` (exactly one), `zamu tasks create` and
  `zamu milestones update`, the task key's project for `zamu tasks update`. An unknown name fails with
  exit code 1 and lists the project's milestones.
- `--cycle` takes a cycle number, `current` or `next`. `none` clears it on `zamu tasks update` and
  filters tasks without a cycle on `zamu tasks list`.
- `--target none` clears a milestone's target date. Setting any status but `completed` on a completed
  milestone reopens it as `active`.
- `zamu cycles current` prints `null` data with `--json` (exit code 0) when the project has no current
  cycle.
- `zamu cycles end` ends the current cycle unless you pass a number. Unfinished tasks move to
  `--move-to` (a cycle number, or `none`), else the next upcoming cycle, else a new cycle of the same
  length.

### Labels, due dates, subtasks and blockers

- Labels belong to a project. Names are up to 40 characters and unique in the project, ignoring case.
  `--label` on `zamu tasks create` and `zamu tasks update` adds labels by name and creates the ones the
  project doesn't have; `--remove-label` takes them off. Both repeat or take a comma-separated list.
- `zamu tasks list --label` looks names up in `--project` (or the folder's project) and matches tasks with
  any of them. With several projects a name matches in each project that has it. A name none of them
  has fails with exit code 1 and lists the project's labels.
- `zamu labels` lists, creates, renames, recolours (`--color 1` to `9`) and deletes labels. Commands take a
  label name (any case) or id. An unknown label exits 3, a name the project has already 1
  (`LABEL_EXISTS`). Labels read from Backlog.md files keep their name: renaming or deleting one exits 6
  (`LABEL_MIRRORED`); the colour still changes. Renames and deletes write no task history.
- `zamu labels delete` takes the label off every task. `--confirm` repeats the name (any case); without
  it, or with another name, zamu exits 1 ("Pass --confirm design to delete label design from PAY.") and
  sends nothing.
- `--due YYYY-MM-DD` sets the due date; `none` clears it on `zamu tasks update`. `zamu tasks list --due`
  takes `overdue` (open tasks due before today), `soon` (open tasks due today or in the next 2 days),
  `none` or `set`. Today is the server's day.
- `--parent KEY` makes a task a subtask of another task in the same project; `none` makes it top level
  again. Subtasks go one level deep (`SUBTASK_DEPTH`, exit 1). A new subtask takes the parent's
  assignee unless `--assignee` is given.
- `--blocked-by KEY` adds a blocker from the same project (`NOT_SAME_PROJECT` otherwise), `--unblock KEY`
  removes one. A task is blocked while any blocker is open; status changes are never refused. A
  blocker that closes a loop fails with exit code 1: `zamu: Can't add: PAY-150 already waits on PAY-142.`
  (`DEPENDENCY_LOOP`, with `loop: { task, blocker }` in the `--json` error).
- `zamu tasks list --sort` orders the whole list by `priority`, `due` (soonest first, none last),
  `updated`, `created` (newest first) or `manual` (board order). Without it the list is grouped by
  status, then priority.
- `zamu tasks show` adds Labels, Due, Parent, Subtasks (done of total, canceled left out, then one line
  each), Blocked by and Blocks, and "· blocked" after the status. A blocker you can't see reads
  "Removed task". `zamu tasks list` adds DUE, LABELS, PARENT, SUBTASKS and BLOCKED columns when a row has
  a value for them.

### Dashboard

- `zamu dashboard` prints what needs someone now. Four groups (In review, Mentions, Stalled, Deadlines),
  each with its total and up to 10 lines, then `… N more`. Then one row per project (open, doing, review,
  current cycle, next milestone, last activity) and the agents (who they work for, current task or Idle,
  stalled marker).
- Mine covers your tasks, the tasks of the agents you are responsible for, and mentions of you. For an
  agent's key, Mine means the agent's own tasks and mentions of it. `--everyone` covers every project
  the key can read.
- Use `--json` for every item (up to 50 per group); each group's `total` counts them all.

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

The projects table and the agents follow. An empty group prints one line, `Mentions · none`.

### Work record

A task has acceptance criteria, a definition of done (done items), a plan, work notes and a final
summary. The flags use the names of the Backlog.md CLI.

| Flag                               | On                 | What it does                                                         |
| ---------------------------------- | ------------------ | -------------------------------------------------------------------- |
| `--ac "text"`                      | `create`, `update` | Adds an acceptance criterion at the end. Repeatable.                 |
| `--check-ac N`, `--uncheck-ac N`   | `update`           | Checks or unchecks criterion N.                                      |
| `--remove-ac N`                    | `update`           | Removes criterion N; the ones after it move up.                      |
| `--waive-ac N --reason "text"`     | `update`           | Waives criterion N: it no longer applies, for that reason.           |
| `--unwaive-ac N`                   | `update`           | Takes the waiver back; the item is open again.                       |
| `--dod "text"`                     | `create`, `update` | Adds a done item. On `create`, after the project's default ones.     |
| `--check-dod N`, `--uncheck-dod N` | `update`           | Checks or unchecks done item N.                                      |
| `--remove-dod N`                   | `update`           | Removes done item N.                                                 |
| `--waive-dod N --reason "text"`    | `update`           | Waives done item N.                                                  |
| `--unwaive-dod N`                  | `update`           | Takes the waiver off done item N.                                    |
| `--no-dod-defaults`                | `create`           | Leaves the project's default done items out.                         |
| `--plan "text"`                    | `create`, `update` | Sets the plan (Markdown). An empty value clears it on `update`.      |
| `--final-summary "text"`           | `update`           | Sets the final summary (Markdown). An empty value clears it.         |
| `--append-notes "text"`            | `update`           | Adds a work note after the update. Repeated ones join into one note. |
- Numbers are the ones `zamu tasks show` prints. The number flags repeat or take a comma-separated list
  (`--check-ac 1,2,3`). They refer to the list as it was before the command, and a removal moves the
  numbers after it up.
- All the flags of one command go in one request: `--check-ac 3 --final-summary - --status in_review`
  checks the item, writes the summary and moves the task at once.
- `--reason` belongs to the waives typed before it: `--waive-ac 4 --waive-ac 5 --reason "..."` waives both
  with one reason, `--waive-ac 4 --reason "a" --waive-ac 5 --reason "b"` gives each its own. A waive
  without any `--reason` exits 1 and sends nothing.
- `-` reads `--plan`, `--final-summary`, `--append-notes` or `--description` from stdin. Only one of them
  can read stdin per command.
- Criteria and done items are one line each, up to 500 characters, 50 per list. The plan and the summary
  take up to 50,000 characters.
- `zamu notes add PAY-142 "text"` writes a work note, like `--append-notes`. A note is a comment of kind
  `note`: it shows quietly in the history and notifies only the people it mentions. `--append-notes`
  alone writes only the note; with other flags the note goes after the update, and a refused update
  writes no note.
- `zamu tasks show` prints the final summary, then the description, the criteria and done items with
  their numbers and states (`[x]` checked, `[ ]` open, `[~]` waived with the reason and who waived it),
  the plan with who last wrote it, and the history with notes, comments and changes. The history heading
  counts them: `History · 7 notes · 2 comments · 18 changes`.
- An agent can't move a task to In review or Done while a criterion or done item is open. zamu prints the
  open items with the flags that settle each one and exits 1 (`OPEN_ITEMS`, with `openItems` in the
  `--json` error):

  ```text
  $ zamu tasks update PAY-142 --status in_review
  zamu: PAY-142 has open items: criterion 6. Check or waive them before moving it to In review (open_items).
    criterion 6  The on-call runbook has an entry for exhausted retries
                 check: --check-ac 6   waive: --waive-ac 6 --reason "..."
    Check only what is proven and waive the rest with a reason. One command can settle them and move it:
      zamu tasks update PAY-142 <flags above> --status in_review
  ```

  A person's key is never refused; the web app asks first.
- On a task mirrored from Backlog.md the work record is read-only (`[x]` lines marked "from Backlog.md,
  read-only"). Writing it, or a note, exits 6 with the `backlog task edit` command, as for other fields.

### Offline queue

Every request has 5 seconds to connect and answer. When the server doesn't answer (it is down,
restarting or unreachable), some writes on a task that already exists wait in a queue instead of failing:
- `--check-ac`, `--uncheck-ac`, `--waive-ac`, `--unwaive-ac` and the same four with `-dod`;
- `--status`;
- `zamu notes add`, `--append-notes` and `zamu comments add`.

zamu prints `Queued: the server didn't answer. It will be sent on your next zamu command.` and exits with
code 7 (`zamu.v1.queued` with `--json`). Everything else fails with exit code 5 and queues nothing:
creating a task, every read, and an update that mixes a queueable flag with another one, such as
`--check-ac 1 --priority high`. The error names the flags that can't wait. A 5xx answer is an error too:
the server answered.
- The queue is `$XDG_STATE_HOME/zamu/queue.json` (`~/.local/state/zamu/queue.json`). zamu changes it
  under a lock file and writes it atomically, so agents running zamu at the same time on one machine never
  lose an entry.
- The next command that reaches the same server sends the queue first, oldest first, and reports each
  write on stderr (`--json` output stays one result): `Sent: PAY-142 check criterion 2 (queued ...)`. A
  write the server refuses with a 4xx is dropped and reported (`Dropped: ...`). When the server still
  doesn't answer, or answers 401, 408, 429 or 5xx, the rest wait for the next command.
- A queued status change is sent only if the task still has the status zamu last saw. When someone moved
  it meanwhile, the move is dropped (`Skipped: PAY-142 was already moved to Done`); checks and waivers
  queued with it are still sent. zamu remembers the status of every task the server returned on this
  machine, in `statuses.json` next to the queue. Without one (zamu never read the task here), a status
  change is not queued: run `zamu tasks show PAY-142` once the server answers.
- `zamu queue` lists what waits (`zamu.v1.queue.list`) and `zamu queue drop ID` removes an entry
  (`zamu.v1.queue.drop`); neither contacts the server. `zamu whoami` shows how many writes still wait for
  its server (`queued`).
- A queued write keeps the login it was queued with: the next command that reaches the server sends it
  with that stored login's key and workspace, whichever login the command itself uses. Entries from zamu
  0.9 go out with the stored login that holds their key, else with the command's login. A write queued
  with a key zamu doesn't store (a `ZAMU_KEY`) waits for a command that uses that key, so it keeps its
  author when a person and an agent share a machine; zamu says how many wait. The queue stores a
  fingerprint of the key, never the key. The machine and branch are those of the command that sends the
  write.
- Remembered statuses are kept per server and workspace, so `PAY-1` of one workspace never stands in for
  `PAY-1` of another. `zamu queue` adds a WORKSPACE column when the writes belong to several.

### Machine and branch

Every request carries the machine name (`ZAMU_MACHINE`, else the host name) in `x-zamu-machine` and, when
the folder is in a git repository with a branch checked out, the branch in `x-zamu-branch`. The server
stores them on history entries and notes, and `zamu tasks show` prints them at the end of each line:
`build-box · feat/payout-retries`. Names are cut to 100 characters; characters outside ASCII are sent
percent-encoded.

### Comments

- Comment bodies are Markdown, up to 20,000 characters. `@agent-name` and `@email` mention workspace
  members; the server rewrites them to `[@Name](mention:<userId>)` links. Unknown names stay plain text.
- Only the author edits or deletes a comment, agents included. A deleted comment stays in the history
  as "Comment deleted by ...".
- `zamu tasks show` prints the task's history: activity as one line each, comments as indented blocks
  with their author, "for" the agent's human, the time and the comment id.

### Backlog.md mirrors

A project can mirror a Backlog.md folder from its repository (set up in the project's settings on the
web). Its tasks keep their Backlog.md numbers: `BACK-786.1` becomes `PAY-786.1`.
- Every command that takes a task key also takes the Backlog.md id: `zamu tasks show BACK-786.1`. An app
  key wins over an id with the same text. Ids like `TASK-12` can repeat across projects: zamu looks the
  id up in `--project`, `ZAMU_PROJECT` or `.zamu.json` when one is set, and in the project linked to the
  clone's remote when the id alone is not enough.
- Backlog.md owns title, description, status, priority, assignee and milestone of a mirrored task, and
  every milestone of the project. Changing one fails with exit code 6 and says where to change it:

  ```
  $ zamu tasks update PAY-786 --status done
  error: PAY-786 is mirrored from Backlog.md, so its status can't change here (task_mirrored).
    file:  backlog/tasks/back-786 - Retry-failed-webhook-deliveries-with-exponential-backoff.md (main)
    edit the file and push, or run: backlog task edit 786 -s Done
    still allowed here: comments (zamu comments add PAY-786) and cycles (zamu tasks update PAY-786 --cycle 4)
  ```

  New tasks and milestones of a mirrored project are added in Backlog.md too (`project_mirrored`,
  `milestone_mirrored`). With `--json` the error is the problem as the server sent it, with `field`,
  `file`, `backlogId` and `hint`.
- `zamu tasks show` adds the Backlog.md id and file, the locked fields, and "Hidden" for a task whose file
  is gone from the default branch. Changes a refresh made show as "Backlog.md" with the commit.
- `zamu backlog refresh` needs an owner, an admin, or an agent whose key can write the project. It fails
  with exit code 6 when the mirror is paused (`BACKLOG_PAUSED`: the connection is missing, rejected or
  unreachable) or detached (`BACKLOG_DETACHED`). `--wait` checks the status every 2 seconds until the
  read ends, up to 5 minutes; it exits 0 whatever the read found, so check `state` in the JSON
  (`healthy`, `warnings`, `failed`, `paused`). `outcome` is `queued` without `--wait`, `finished`, or
  `timeout` when no read ended in time (is the worker running?).

### Backlog.md export

`zamu backlog export` writes a project owned by Zamu (never mirrored, or switched from a mirror in the
project's settings) as Backlog.md files, so the repository keeps a readable copy:

```sh
zamu backlog export --dry-run                     # list what would change, write nothing
zamu backlog export                               # backlog/ at the repository root
zamu backlog export --project PAY --dir docs/backlog
zamu backlog export --force                       # write over uncommitted changes in the exported folders
```

- The files come from `GET /api/v1/projects/{key}/backlog/export`. Tasks go to `tasks/`, milestones to
  `milestones/`. Markdown files under `tasks/`, `completed/` and `milestones/` that the export doesn't have
  are removed. Nothing else in the folder is written or removed: documents, decisions, drafts,
  `config.yml` and files that aren't Markdown stay as they are.
- `--dir` is relative to the current folder; without it zamu uses `backlog` at the repository root (or
  in the current folder outside a repository).
- zamu refuses (exit 1) when `tasks/`, `completed/` or `milestones/` have uncommitted changes, untracked
  files included, and lists them. Commit or discard them, or pass `--force`. `--dry-run` never refuses.
- The Backlog.md CLI lists nothing without a `config.yml` whose `task_prefix` matches the exported ids.
  zamu warns on stderr when the file is missing or the prefix differs.
- A project that still mirrors Backlog.md exits 6 (`PROJECT_MIRRORED`): its files are the source.
- `--json` prints `zamu.v1.backlog.export`: the project, the folder, `dryRun`, the format the files target
  and every file with its action (`created`, `updated`, `unchanged`, `removed`).

Human output is a compact table with task keys first. Agents show as "claude-dev for Ana Ruiz": the agent
and the person responsible for it. Colour is used only when stdout is a terminal.

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
| `zamu projects delete`   | `zamu.v1.projects.delete`   |
| `zamu tasks list`        | `zamu.v1.tasks.list`        |
| `zamu tasks show`        | `zamu.v1.tasks.show`        |
| `zamu tasks create`      | `zamu.v1.tasks.create`      |
| `zamu tasks update`      | `zamu.v1.tasks.update`      |
| `zamu comments list`     | `zamu.v1.comments.list`     |
| `zamu comments add`      | `zamu.v1.comments.add`      |
| `zamu comments edit`     | `zamu.v1.comments.edit`     |
| `zamu comments delete`   | `zamu.v1.comments.delete`   |
| `zamu milestones list`   | `zamu.v1.milestones.list`   |
| `zamu milestones create` | `zamu.v1.milestones.create` |
| `zamu milestones update` | `zamu.v1.milestones.update` |
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

The data schemas live in `@zamu/contracts` (`cliDataSchemas`, `parseCliOutput`). Within `v1`, fields are
only ever added; removing or changing a field needs `zamu.v2`. JSON is printed on one line when piped and
indented at a terminal.

With `--json`, failures print `zamu.v1.error` on stdout: an RFC 9457 problem with `code`, `status`,
`detail`, and `requestId` and `issues` when the server sent them (`field`, `file`, `backlogId` and `hint`
for the Backlog.md mirror errors, `loop` for `DEPENDENCY_LOOP`, `openItems` for `OPEN_ITEMS`). The exit
code is still non-zero.

`zamu.v1.projects.delete` is `{ "deleted": "PAY" }`. `zamu.v1.labels.delete` is the label as it was and
the number of tasks it was on:
`{ "deleted": { "id": "...", "name": "design", "color": 7, "source": "app" }, "usageCount": 3 }`.

`zamu.v1.backlog.status` holds the first 50 problems unless you pass `--problems`, which reads them all.
`zamu.v1.backlog.refresh` is the refresh request plus `outcome` and, with `--wait`, the final `status`.

`zamu.v1.tasks.show` keeps `activity` for v1 readers and adds `timeline`: activity, comments and notes in
one list, oldest first, told apart by `kind` (`activity`, `comment` or `note`), and `timelineCounts` with
the size of each filter (`all`, `comments`, `notes`, `history`). The task carries its work record:
`criteria`, `doneItems`, `plan`, `planMeta`, `finalSummary` and `finalSummaryMeta`.

`zamu.v1.login` adds `replaced` (a login for that server and workspace existed) and `default`.
`zamu.v1.logout` adds `removed`: every login removed, without keys. `zamu.v1.whoami` adds
`workspaceSource`: `flag`, `env`, `clone` or `default`. `zamu.v1.workspaces` is
`{ "items": [{ "url", "workspace": { "id", "name", "slug" }, "default", "current" }], "source" }`, where
`current` marks the login commands use here and `source` says how it was picked (`env` when `ZAMU_KEY` is
set, null when the clone matches several logins).

`zamu tasks update` with `--append-notes` alone prints `zamu.v1.notes.add` (the note); with other flags it
prints `zamu.v1.tasks.update`. `zamu.v1.agents` adds `replacedBacklogBlock`.

## Exit codes

| Code | Meaning                                                                                                                                                 |
| ---- | ------------------------------------------------------------------------------------------------------------------------------------------------------- |
| 0    | OK                                                                                                                                                      |
| 1    | Usage: bad arguments, unknown milestone names, input the server rejected (400, 409, 422), `OPEN_ITEMS` included, or a clone that matches several logins |
| 2    | Auth: not logged in, or the key was refused (401)                                                                                                       |
| 3    | Not found (404)                                                                                                                                         |
| 4    | Forbidden: the key's scope or access does not allow it, owners and admins only, or the key is for another workspace (403)                               |
| 5    | Server: unreachable (and nothing queued), 5xx, or a response this version does not understand                                                           |
| 6    | Backlog.md: the change belongs in Backlog.md, or the mirror is paused or detached (409)                                                                 |
| 7    | Queued: the server didn't answer, so the write waits in the offline queue for the next command                                                          |

## Development

```sh
pnpm --filter @zamu/cli dev tasks list --project PAY      # run from source with tsx
pnpm --filter @zamu/cli test                             # needs Postgres: docker compose -f docker-compose.dev.yml up -d db
pnpm --filter @zamu/cli build
```

The tests run every command in-process against the real `/api/v1` handler from `apps/web` on a throwaway
database seeded with the dev data, and validate each `--json` result against the contract schemas.

To try the CLI against a local server:

```sh
eval "$(pnpm -s --filter web seed)"      # prints ZAMU_API_KEY for the claude-dev agent
pnpm --filter web dev
node apps/cli/dist/index.js login --key "$ZAMU_API_KEY"
node apps/cli/dist/index.js tasks list --project PAY
```
