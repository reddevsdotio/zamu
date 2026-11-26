# Agents

An AI coding agent is a member of the workspace, like a person. It has its own name and its own API keys,
and it always acts for one person, its responsible human. Everything the agent changes shows up as
"claude-dev for Ana Ruiz", in the web app and in the CLI.

Agents work through the `zamu` CLI. The full command reference is in [apps/cli/README.md](../apps/cli/README.md);
this page covers the setup and what an agent's environment needs.

## Add an agent

Admins add agents in Settings > Members > Add agent:
1. Name the agent, for example `claude-dev`. Names are unique in the workspace.
2. Pick the responsible human. The agent acts for this person.
3. Choose the scope of its first key (see below).
4. Create agent. A dialog shows the key once. Copy it with the copy button, or copy the
   `zamu login --key ... --url ...` line under it, then close with "I copied the key".

The server keeps only a hash of the key. If you lose it, revoke it and create a new one.

To give an agent another key later, open the agent's row menu in Settings > Members and pick
Manage keys, then New key. The responsible human can do this too.

An agent belongs to one workspace, and so do its keys. When the same coding agent works for two
workspaces, add it in each: two agents, which may have the same name, each with its own keys and its own
history. Deleting a workspace deletes the agents that belong only to it.

## Scope keys

Each key has two settings, chosen when you create it and fixed afterwards:

| Setting    | Options                               | Effect                                                     |
| ---------- | ------------------------------------- | ---------------------------------------------------------- |
| Access     | Whole workspace, or Selected projects | Which projects the key can see. Other projects return 403. |
| Permission | Read and write, or Read only          | Read only can list and show; it cannot create or update.   |

Give each agent the narrowest key that does the job: an agent that works on one repository gets a key for
that project only. Creating projects needs a key with whole-workspace access and write permission.

Deleting a project is for owners and admins only, never agents: in the project's Settings > General, or
with `zamu projects delete PAY --confirm PAY` and a person's key with whole-workspace access and write
permission. Without `--confirm`, or with another key in it, zamu exits with code 1 and sends nothing. An
agent's key gets exit code 4, and an unknown project exits with 3. There is no undo. Keys scoped to a
deleted project keep their other projects; a key that covered only deleted projects stays, with no
projects, until you revoke it.

Revoke a key in Settings > API keys (admins see every key in the
workspace) or from the agent's Manage keys page. It stops working at once: the CLI exits with code 2.
Removing an agent from the workspace disables all of its keys.

People can create keys for themselves in Settings > My keys, for their own scripts.

## Use zamu in an agent's environment

Install the CLI on the agent's machine with npm (Node 24 or later) or Homebrew:

```sh
npm install --global @reddevs/zamu
brew install reddevsdotio/tap/zamu
```

Keep the full Homebrew name: a bare `brew install zamu` after `brew tap` stops with a trust error on current
Homebrew. To upgrade, run `npm update --global @reddevs/zamu` or `brew upgrade reddevsdotio/tap/zamu`.
`zamu --version` prints the version installed. The Docker image also ships the CLI as `zamu`, and the
[CLI reference](../apps/cli/README.md#install) shows how to run it from a clone of this repository.

Then give the agent two environment variables instead of running `zamu login`:

| Variable   | Value                                                        |
| ---------- | ------------------------------------------------------------ |
| `ZAMU_URL` | The server URL, the same as `BETTER_AUTH_URL` on the server. |
| `ZAMU_KEY` | The agent's API key (`zamu_live_...`).                       |

They override the logins that `zamu login` stores, so the agent's key never mixes with a person's login on
the same machine. Store `ZAMU_KEY` as a secret in the agent's runner or CI settings, never in the repository.
A key acts in its own workspace, so one `ZAMU_KEY` means one workspace; an agent that works in several
uses stored logins instead (see [Several workspaces](#several-workspaces)).

Check the setup:

```sh
$ zamu whoami
claude-dev for Ana Ruiz (agent)
Workspace  Reddevs (reddevs)
Login      from ZAMU_KEY
Role       member
Access     API key: all projects, write
Server     https://zamu.example.com
Project    PAY (from git remote gitlab.com/reddevs/payments)
```

## Several workspaces

A key belongs to one workspace. A person or an agent that works in several runs `zamu login` once per
workspace (and per server). zamu stores one login for each in `$XDG_CONFIG_HOME/zamu/config.json`
(`~/.config/zamu/config.json`); logging in again with a new key for the same workspace replaces its key.
The first login is the default.

```sh
zamu login --key zamu_live_... --url https://zamu.example.com   # Acme: the default
zamu login --key zamu_live_...                                  # Globex, on the same server
zamu workspaces                                                 # the logins; * marks the one used here
zamu workspaces --default globex                                # make Globex the default
zamu --workspace globex tasks list --mine                       # one command in Globex
zamu logout --workspace globex                                  # remove one login, or all with --all
```

`zamu login --default` makes the new login the default. `zamu logout` without a flag removes the login
used in the current folder.

Each command uses the first login that applies:
1. `--workspace <slug>`, a slug or a workspace id. Every command takes it.
2. `ZAMU_KEY` (with `ZAMU_URL`).
3. The login zamu matched to this clone's git remote before, cached in `$XDG_STATE_HOME/zamu/clones.json`
   (`~/.local/state/zamu/clones.json`).
4. The login whose workspace has a project linked to the clone's remote, or, when none has, the project
   the nearest `.zamu.json` names. zamu asks every login at once, within the usual 5 seconds, and caches a
   single match. When the cached login gets a 403 or 404, zamu matches again.
5. The default login.

With a single login there is nothing to match. When a clone matches two or more logins, for example two
workspaces that each have a project `PAY` while `.zamu.json` names `PAY`, the command stops with exit code
1 and lists the `--workspace` values to pass. `zamu whoami` shows which login applies in the current folder
and why ("Login from the login for this clone's git remote").

Every request names the login's workspace in the `x-zamu-workspace` header. A key sent for another
workspace is refused with 403 `WORKSPACE_MISMATCH` (exit code 4), so `zamu --workspace globex` with an Acme
`ZAMU_KEY` fails instead of reading Acme's data.

The config file of zamu 0.9 (`{ "url", "key" }`) keeps working. The first command that reaches the server
reads the key's workspace and writes the file back in the new form; offline, zamu uses the old file as it
is.

## Link the repository to its project

Link each project to the repository its code lives in, once. Then an agent working in any clone of it
can leave out `--project`: zamu finds the project from the clone's git remote.

```sh
cd payments                 # a clone of gitlab.com/reddevs/payments
zamu link --project PAY       # or set Repository in the project's settings on the web
zamu agents                   # write the zamu instructions into AGENTS.md, naming PAY
git add AGENTS.md && git commit -m "Add zamu instructions for agents"
```

`zamu link` needs a key that can edit the project. A repository belongs to one project; linking it to a
second one fails with exit code 1 and names the first. HTTPS and SSH URLs of the same repository match.

Other ways to set the project, in the order zamu checks them: `--project`, the `ZAMU_PROJECT` variable, the
nearest committed `.zamu.json` (`{ "project": "PAY" }`, written by `zamu link --file`; useful when one
repository holds several projects, one file per subfolder), then the linked remote. `zamu whoami` shows
which one applies in the current folder.

`zamu agents` puts a short block between `<!-- zamu:start ... -->` and `<!-- zamu:end -->` in `AGENTS.md`, or in
`CLAUDE.md` when only that exists. It names the project and points the agent to `zamu instructions` (below).
Run it again after upgrading zamu; it replaces only its own block. `zamu agents --print` shows the block
without writing it. In a project owned by Zamu, it also replaces a Backlog.md guidelines block in the same file
(between `<!-- BACKLOG.MD GUIDELINES START -->` and `<!-- BACKLOG.MD GUIDELINES END -->`) with one line: tasks
are in Zamu, and the `backlog` CLI is only for documents and decisions.

## Instructions for agents

`zamu instructions` prints how an agent works on a task with zamu. The text ships with the CLI, so it always
matches the version installed, and the block that `zamu agents` writes stays short:

```sh
zamu instructions                # overview: the work record, the rules, the exit codes
zamu instructions creating       # search before creating; criteria that can be tested
zamu instructions working        # the plan when work starts, a note after each step, check only what is proven
zamu instructions finishing      # the final summary, stopping at In review, the final report
```

A typical loop for an agent:

```sh
zamu dashboard --json                     # reviews, mentions of the agent, stalled work, deadlines
zamu tasks list --mine --status todo --cycle current --json
zamu tasks show PAY-142 --json            # criteria, done items, plan, summary and history
zamu tasks update PAY-142 --status in_progress --plan - < plan.md
zamu notes add PAY-142 "Retry queue written and tested"
zamu tasks update PAY-142 --check-ac 1 --check-ac 2 --check-dod 1
zamu tasks update PAY-142 --final-summary - --status in_review < summary.md
```

`--mine` lists the tasks assigned to the key's owner across every project the key can read. Add `--project`
to narrow it to one or more projects.

Tell the agent about the exit codes so it can react without parsing text:

| Code | Meaning                                                                                                                   |
| ---- | ------------------------------------------------------------------------------------------------------------------------- |
| 0    | OK                                                                                                                        |
| 1    | Usage error, the server rejected the input (400, 409, 422), open items included, or a clone that matches several logins   |
| 2    | Not logged in, or the key was refused (401): revoked or wrong                                                             |
| 3    | Not found (404)                                                                                                           |
| 4    | Forbidden: outside the key's scope, a read-only key writing, owners and admins only, or a key for another workspace (403) |
| 5    | Server unreachable, 5xx, or a response this CLI does not understand                                                       |
| 6    | Backlog.md: the change belongs in the files, or the mirror is paused or switched (409)                                    |
| 7    | Queued: the server didn't answer, and zamu stored the write to send later                                                 |

Exit code 6 covers the problem codes `TASK_MIRRORED`, `MILESTONE_MIRRORED`, `PROJECT_MIRRORED`,
`LABEL_MIRRORED`, `PROJECT_NOT_EMPTY`, `BACKLOG_PAUSED` and `BACKLOG_DETACHED`. Other conflicts, such as two
edits racing, a blocker loop (`DEPENDENCY_LOOP`), a label name the project has (`LABEL_EXISTS`) or a task
finished with open items (`OPEN_ITEMS`), stay on 1. See [Backlog.md mirrors](#backlogmd-mirrors) and
[Offline queue](#offline-queue).

## The work record

A task's work record is what an agent writes while it works: the acceptance criteria, the definition of
done, the plan, work notes and the final summary. People see it in the task view (see
[guide.md](guide.md#the-work-record)).
- **Acceptance criteria** say what must be true when the task is done. They are numbered from 1.
- **Done items**, the definition of done, are the checks every task passes, such as "Tests and lint pass".
  A new task starts with the project's default done items (Settings > Task defaults in the web app).
- Each criterion and done item is open, checked or waived. **Waived** means it no longer applies, and it
  always carries a reason.
- **The plan** is Markdown, written when work starts.
- **Work notes** are short entries in the task's history, one after each step. A note is quieter than a
  comment and reaches nobody unless it mentions them.
- **The final summary** is Markdown, written before the task goes to review. The task view and the peek
  show it first.

The flags keep the names of the Backlog.md CLI:

```sh
zamu tasks create --project PAY "Retry failed payouts" \
  --ac "A failed payout is retried up to 8 times" --ac "On-call is alerted once"
zamu tasks create --project PAY "Fix a typo in the receipt" --no-dod-defaults
zamu tasks update PAY-142 --check-ac 1,2 --check-dod 1
zamu tasks update PAY-142 --waive-ac 3 --reason "Load test replaced by a replay"
zamu tasks update PAY-142 --ac "Retries stop when the payout is canceled" --remove-ac 4
zamu tasks update PAY-142 --append-notes "Migration written and tested"
zamu notes add PAY-142 "Backoff schedule covered by tests"
```

The numbers are the ones `zamu tasks show` prints. All the flags of one command go in one request, so
`--check-ac 3 --final-summary - --status in_review` checks the item, writes the summary and moves the task at
once. Criteria and done items are one line each, up to 500 characters and 50 per list. The plan and the
summary take up to 50,000 characters. The [CLI reference](../apps/cli/README.md#work-record) lists every
flag.

An agent can't move a task to In review or Done while a criterion or done item is open. The server answers
`409 OPEN_ITEMS`, and zamu prints the open items with the flags that settle each one and exits with code 1:

```text
$ zamu tasks update PAY-142 --status in_review
zamu: PAY-142 has open items: criterion 6. Check or waive them before moving it to In review (open_items).
  criterion 6  The on-call runbook has an entry for exhausted retries
               check: --check-ac 6   waive: --waive-ac 6 --reason "..."
  Check only what is proven and waive the rest with a reason. One command can settle them and move it:
    zamu tasks update PAY-142 <flags above> --status in_review
```

The rule applies to agents only. A person moving the task in the web app sees the open items first and can
move it anyway.

## Where a change comes from

zamu sends two headers with every request: `x-zamu-machine`, the machine name (`ZAMU_MACHINE`, else the host
name), and `x-zamu-branch`, the git branch checked out in the current folder when there is one. The server
stores them on history entries and notes. The web app shows them as "build-box · feat/payout-retries" under
the History filter, and `zamu tasks show` prints them at the end of each line. Values are cut to 100
characters. The web app sends neither header.

## Offline queue

When the server doesn't answer within 5 seconds, zamu stores some writes on an existing task in a local
queue instead of failing: checking, unchecking or waiving items, a status change, and a note or comment. It
prints "Queued: the server didn't answer. It will be sent on your next zamu command." and exits with code 7;
every other write, such as creating a task, fails as before. The next zamu command that reaches the server
sends the queued writes first, oldest first, and skips a queued status change when the task moved in the
meantime. A status change is queued only when zamu has seen that task's status before; otherwise it fails
and asks you to run `zamu tasks show` once the server answers. A queued write keeps the login it was
queued with: the next command that reaches the server sends it with that login's key and workspace,
whichever login the command itself uses. A write queued with a `ZAMU_KEY` that no stored login holds waits
for a command that uses that key, so it keeps its author when a person and an agent share a machine.
Remembered statuses are kept per server and workspace, so `PAY-1` of one workspace never stands in for
`PAY-1` of another. `zamu queue` lists what waits, `zamu queue drop ID` removes one write, and `zamu whoami`
shows the count.

## Comments and mentions

Agents comment on tasks the way people do, and the comment shows in the task's history in the web app as
"claude-dev for Ana Ruiz". The body is Markdown, up to 20,000 characters.

```sh
zamu comments add PAY-142 "Picked this up. @ana@example.com, I will open the MR today."
pnpm test 2>&1 | tail -20 | zamu comments add PAY-142 -     # "-" reads the body from stdin
zamu comments list PAY-142
zamu comments edit 01a16848-b25a-7da5-aceb-752a314e6b85 "Fixed: the MR is !42."
zamu comments delete 01a16848-b25a-7da5-aceb-752a314e6b85
```

Mention someone with `@` and their email (`@ana@example.com`) or an agent's name (`@claude-dev`). The
server checks that they are members of the workspace and stores the mention as a link,
`[@Ana Ruiz](mention:<userId>)`, which the web app shows as the name in the accent colour. An `@word` that matches nobody
stays plain text. Mentions send no notification yet.

Only the author can edit or delete a comment. That holds for agents too: the agent's responsible human
cannot edit the agent's comments, and an agent trying to delete a person's comment gets exit code 4.
Deleting leaves "Comment deleted by ..." in the history. Comment ids are in `zamu comments list`, in
`zamu tasks show` and in the `--json` output.

`zamu tasks show PAY-142` prints the history: activity on one line each, comments and notes as indented
blocks with their id. Notes are comments of kind `note` (see [The work record](#the-work-record)).

## Milestones and cycles

Projects can group tasks into milestones (a goal with an optional target date) and cycles (numbered,
dated periods of work, usually two weeks). Both are on by default. Anyone who can edit a project can turn either off in
its settings (General) in the web app; the data stays and comes back when you turn it on again.

Milestones go by name or id. Names are unique in a project and the CLI ignores case:

```sh
zamu milestones list --project PAY
zamu milestones create --project PAY "Payout reports" --target 2026-12-04
zamu tasks update PAY-142 --milestone "payout reports"
zamu tasks list --project PAY --milestone "Payout reports"
zamu milestones update "payout reports" --project PAY --status completed
```

A milestone starts as Planned and turns Active by itself when one of its tasks moves to In progress or In
review. Only a person or agent marks it Completed. An unknown name fails with exit code 1 and lists the
project's milestones, so an agent can retry with the right one.

Cycles go by number, or by `current` and `next`:

```sh
zamu cycles current --project PAY
zamu tasks list --mine --cycle current
zamu tasks update PAY-142 --cycle next
zamu cycles create --project PAY                   # the day after the last cycle, same length
zamu cycles end --project PAY                      # ends the current cycle early
```

`zamu cycles current --json` prints `"data": null` with exit code 0 when no cycle is running. When a cycle
ends, early by hand or at midnight after its end date (in the server's `APP_TIME_ZONE`), its unfinished
tasks move to the next cycle; the server creates one with the same length when none is planned.
`zamu cycles end --move-to none` takes them out of cycles instead. `--milestone none` and `--cycle none`
clear the field on `zamu tasks update` and filter tasks without one on `zamu tasks list`.

## Labels, due dates, blockers and subtasks

Native tasks have four more fields since 0.7.0. Agents set them with the same `zamu tasks` commands; the
full option list is in the [CLI reference](../apps/cli/README.md#labels-due-dates-subtasks-and-blockers).

```sh
zamu tasks create --project PAY "Refund email" --parent PAY-142 --label email --due 2026-11-20
zamu tasks update PAY-150 --blocked-by PAY-142 --label backend --remove-label triage
zamu tasks list --project PAY --due overdue --sort due
zamu tasks list --project PAY --blocked
zamu tasks list --parent PAY-142                 # the subtasks of PAY-142
zamu labels list --project PAY                   # with how many tasks use each label
```

- **Labels** belong to a project. Names are unique in the project, ignoring case, and up to 40 characters.
  `--label` creates the labels the project doesn't have yet, with a colour the app picks.
- **Due date** is a day, `YYYY-MM-DD`, with no time. A task is overdue when it is still open after its due
  date, in the server's `APP_TIME_ZONE`. `--due none` clears it.
- **Blocked by** lists tasks of the same project. A task is blocked while any of its blockers is open. It is
  a marker only: nothing stops a blocked task from moving. A blocker that would close a loop fails with exit
  code 1: `zamu: Can't add: PAY-150 already waits on PAY-142.` (`DEPENDENCY_LOOP`).
- **Subtasks** go one level deep and stay in the parent's project (`SUBTASK_DEPTH`, `NOT_SAME_PROJECT`). A
  new subtask takes the parent's assignee unless you pass `--assignee`. The parent shows its progress as done
  of total, canceled subtasks left out.

`zamu tasks show` prints them, and `zamu tasks list` adds DUE, LABELS, PARENT, SUBTASKS and BLOCKED columns when
a row has a value for them. Mark your task blocked instead of leaving it In progress with no word: the
person sees it on Home under Blocked.

## Backlog.md mirrors

A project can mirror the Backlog.md folder of its repository (see [backlog-md.md](backlog-md.md)). The files
on the default branch stay the source of truth: agents keep working in them with the `backlog` CLI, and the
project follows every push. Mirrored tasks keep their Backlog.md numbers, so `BACK-786.1` is `PAY-786.1` in
a project with the key `PAY`.

In a mirrored project:
- Change a task by editing its file in `backlog/` (or the folder the project reads) and pushing to the default
  branch, for example `backlog task edit 786 -s "In Progress"`. Changes on other branches show up once they
  are merged.
- `zamu` reads the tasks, comments on them and sets their cycle. Every command that takes a task key also takes
  the Backlog.md ID: `zamu tasks show BACK-786.1`. IDs such as `TASK-12` can repeat across projects; add
  `--project` when zamu asks for it.
- The work record comes from the file too: criteria and done items from its Acceptance Criteria and
  Definition of Done, the plan and the final summary from their sections. `zamu tasks show` marks them
  "from Backlog.md, read-only".
- `zamu` refuses to change the title, description, status, priority, assignee, milestone, labels, due date,
  blockers, parent or work record of a mirrored task, to write a note on it, to create tasks, to change
  milestones, and to rename or delete a label read from the files. It exits with code 6 and says where the
  change belongs:

  ```text
  $ zamu tasks update PAY-786 --status done
  error: PAY-786 is mirrored from Backlog.md, so its status can't change here (task_mirrored).
    file:  backlog/tasks/back-786 - Retry-failed-webhook-deliveries-with-exponential-backoff.md (main)
    edit the file and push, or run: backlog task edit 786 -s Done
    still allowed here: comments (zamu comments add PAY-786) and cycles (zamu tasks update PAY-786 --cycle 4)
  ```

  With `--json`, the error is the server's problem, with `field`, `file`, `backlogId` and `hint` (the
  `backlog` command that makes the change).

After a push, the project usually catches up within seconds through the git host's webhook. When an agent
needs the change right away, for example before it reads the task back, it asks for a refresh and waits:

```sh
zamu backlog refresh --wait --json   # reads the default branch now and waits for the result, up to 5 minutes
zamu backlog status                  # mode, state, branch, folder, last read and its commit, counts
zamu backlog status --problems       # every file skipped or read with a warning, and every unmapped value
```

`zamu backlog refresh` needs a key that can write the project. With `--wait` it exits 0 whatever the read
found, so check `data.status.state` in the JSON: `healthy`, `warnings` (some files were skipped or values fell
back; `zamu backlog status --problems` lists them), `failed` or `paused`. It exits with code 6 when the mirror
is paused (`BACKLOG_PAUSED`: the git connection is missing, rejected or unreachable; an admin fixes it in the
web app) or detached (`BACKLOG_DETACHED`).

A task whose file is deleted from the default branch is hidden, not deleted: it leaves `zamu tasks list`, and
`zamu tasks show` marks it "Hidden". It comes back with the same key when a file with its ID returns.

Once a project is switched to Zamu (see [backlog-md.md](backlog-md.md#switch-to-zamu)), or was imported once,
its tasks behave like any other: `zamu` creates and updates them, and edits to the files no longer reach the
project. Agents should stop writing task files in `backlog/` then; `zamu agents` replaces the Backlog.md
guidelines in `AGENTS.md` to say so. The repository can still keep a copy of the tasks as files:

```sh
zamu backlog export --dry-run      # what would change under backlog/, nothing written
zamu backlog export                # write the tasks and milestones, remove task files Zamu no longer has
git add backlog && git commit -m "Update the Backlog.md copy"
```

The export refuses (exit code 1) while the exported folders have uncommitted changes, unless you pass
`--force`, and a project that still mirrors gets exit code 6 (`PROJECT_MIRRORED`). What it writes and what
it leaves alone is in [backlog-md.md](backlog-md.md#export-to-backlogmd).

## Dashboard

`zamu dashboard` shows what needs someone now, across every project the key can read. In the web app, Home
replaced the Dashboard page in 0.7.0; `zamu dashboard` keeps its four groups and its `zamu.v1.dashboard` output,
so scripts written for 0.6.0 keep working. Home's own data is `GET /api/v1/home` (see the
[API reference](api.md#home)).

```sh
zamu dashboard               # Mine: your tasks, your agents' tasks and mentions of you
zamu dashboard --everyone    # the whole workspace
zamu dashboard --json        # { schema: 'zamu.v1.dashboard', data: Dashboard }
```

The output starts with the action queue, in four groups:

| Group     | An item stays while                                                                                                                                              |
| --------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| In review | The task is In review.                                                                                                                                           |
| Mentions  | A comment mentions the member, the task is open, and the member has not commented on the task or changed it since. A reply by the member's agent does not count. |
| Stalled   | The task is In progress with no update or comment for 24 hours when an agent holds it, or 5 days otherwise.                                                      |
| Deadlines | A milestone is past its target date with open tasks, or the current cycle ends within 2 days with open tasks.                                                    |

Items leave the queue on their own when the condition clears; nobody dismisses them. After the queue come one
row per project (open, in progress and in review counts, current cycle, next milestone, last activity) and
the agents (who they work for, their current task or Idle, and whether it is stalled).

For a person, Mine covers the tasks assigned to them or to the agents they are responsible for, and mentions
of them. For an agent's key, Mine means the agent's own tasks and mentions of the agent. `--everyone` covers
every task and every mention in the projects the key can read. The key's project scope applies in both.

### Ask your person for input

When you need input from a person, mention your responsible person in a comment (@their-email); that puts
it on their Home, under Mentions. It stays there until they comment on the task or change it.

```sh
zamu comments add PAY-142 "Refunds over 500 EUR: one approval or two? @ana@example.com"
zamu tasks update PAY-142 --status in_review    # your task in review shows on their Home too
```

Your own dashboard works the same way: `zamu dashboard` lists the comments that mention you and your tasks
in review or stalled, so check it when you start a session.

### zamu.v1.dashboard

`zamu dashboard --json` prints the body of `GET /api/v1/dashboard?scope=mine|everyone`:

```json
{
  "schema": "zamu.v1.dashboard",
  "data": {
    "scope": "mine",
    "generatedAt": "2026-10-23T17:12:30.413Z",
    "groups": {
      "review": { "total": 1, "items": [] },
      "mentions": { "total": 1, "items": [] },
      "stalled": { "total": 0, "items": [] },
      "deadlines": { "total": 2, "items": [] }
    },
    "projects": [],
    "agents": []
  }
}
```

Each group has `total`, which counts every item, and `items`, up to 50 of them. The items:

| Group       | Item                                                                                                                                                |
| ----------- | --------------------------------------------------------------------------------------------------------------------------------------------------- |
| `review`    | `{ task, assignee, since }`: `since` is when the task last entered In review.                                                                       |
| `mentions`  | `{ task, comment: { id, excerpt, createdAt }, author, onBehalfOf, mentioned }`: the newest unanswered mention per task and member.                  |
| `stalled`   | `{ task, assignee, lastTouchedAt, thresholdHours }`                                                                                                 |
| `deadlines` | `{ kind: "milestone", project, milestone, daysOverdue, openTasks, progress }` or `{ kind: "cycle", project, cycle, daysLeft, openTasks, progress }` |

`task` is `{ key, title, status, priority, project: { key, name } }`. `excerpt` is plain text of at most
200 characters: mentions read `@Name` and inline code keeps its backticks. A project row has `key`, `name`,
`openCounts`, `openCount`, `usesMilestones`, `usesCycles`, `lastActivityAt`, `currentCycle` and
`nextMilestone`. An agent row has `agent`, `currentTask` (null when idle), `inProgressCount`, `stalled` and
`lastActivityAt`. `GET /api/v1/dashboard/counts` returns only the Mine totals:
`{ review, mentions, stalled, deadlines, total }`.

## --json output

Every command takes `--json` and prints one line with a versioned envelope:

```json
{ "schema": "zamu.v1.<command>", "data": {} }
```

Check `schema` before reading `data`. Within `zamu.v1`, fields are only added, never removed or changed; a
breaking change ships as `zamu.v2`. The Zod schemas live in `packages/contracts` (`cliDataSchemas` in
`src/cli.ts`, entities in `src/entities.ts`), and the server publishes the same shapes as OpenAPI at
`GET /api/v1/openapi.json`.

| Schema                      | `data`                                                                                 |
| --------------------------- | -------------------------------------------------------------------------------------- |
| `zamu.v1.login`             | `{ url, me, replaced, default }`                                                       |
| `zamu.v1.logout`            | `{ url, removed }` (`url` null when nothing was stored)                                |
| `zamu.v1.whoami`            | `{ user, workspace, role, auth: { method, scope }, project, queued, workspaceSource }` |
| `zamu.v1.workspaces`        | `{ items: [{ url, workspace, default, current }], source }`                            |
| `zamu.v1.dashboard`         | `{ scope, generatedAt, groups, projects, agents }` (see Dashboard above)               |
| `zamu.v1.projects.list`     | `{ items: Project[] }` with open counts per status                                     |
| `zamu.v1.projects.delete`   | `{ deleted }`: the key of the deleted project                                          |
| `zamu.v1.tasks.list`        | `{ items: TaskListItem[], nextCursor, counts }`                                        |
| `zamu.v1.tasks.show`        | `{ task: Task, activity: Activity[], timeline, timelineCounts }`                       |
| `zamu.v1.tasks.create`      | `Task`                                                                                 |
| `zamu.v1.tasks.update`      | `Task`                                                                                 |
| `zamu.v1.comments.list`     | `{ items: Comment[] }`                                                                 |
| `zamu.v1.comments.add`      | `Comment`                                                                              |
| `zamu.v1.comments.edit`     | `Comment`                                                                              |
| `zamu.v1.comments.delete`   | `Comment`, with `body` null and `deletedAt` set                                        |
| `zamu.v1.notes.add`         | `Comment` with `kind: "note"`                                                          |
| `zamu.v1.milestones.list`   | `{ items: Milestone[] }` with progress counts                                          |
| `zamu.v1.milestones.create` | `Milestone`                                                                            |
| `zamu.v1.milestones.update` | `Milestone`                                                                            |
| `zamu.v1.cycles.list`       | `{ items: Cycle[] }` with state, days left and counts                                  |
| `zamu.v1.cycles.create`     | `Cycle`                                                                                |
| `zamu.v1.cycles.current`    | `Cycle`, or `null` when no cycle is running                                            |
| `zamu.v1.cycles.end`        | `Cycle` with its summary, plus `rollovers`: the tasks that moved and where             |
| `zamu.v1.labels.list`       | `{ items: Label[] }` with `usageCount` per label                                       |
| `zamu.v1.labels.create`     | `Label` with `usageCount`                                                              |
| `zamu.v1.labels.update`     | `Label` with `usageCount`                                                              |
| `zamu.v1.labels.delete`     | `{ deleted: Label, usageCount }`: the label as it was, and how many lost it            |
| `zamu.v1.backlog.status`    | `BacklogSourceStatus`: mode, state, source, last read, counts, problems                |
| `zamu.v1.backlog.refresh`   | The refresh request plus `outcome` and, with `--wait`, the final `status`              |
| `zamu.v1.backlog.export`    | `{ project, dir, dryRun, format, files: [{ path, action }] }`                          |
| `zamu.v1.instructions`      | `{ topic, text }`                                                                      |
| `zamu.v1.queue.list`        | `{ items }`: the queued writes, oldest first                                           |
| `zamu.v1.queue.drop`        | `{ dropped }`: the write removed from the queue                                        |
| `zamu.v1.queued`            | `{ entry }`: the write zamu queued (exit code 7)                                       |
| `zamu.v1.link`              | `{ project, target, action, repository, file }`                                        |
| `zamu.v1.agents`            | `{ file, action, project, block, replacedBacklogBlock }`                               |
| `zamu.v1.error`             | RFC 9457 problem: `{ type, title, status, code, detail, requestId, issues }`           |

Statuses are `backlog`, `todo`, `in_progress`, `in_review`, `done`, `canceled`. Priorities are `none`, `low`,
`medium`, `high`, `urgent`. Timestamps are ISO 8601 in UTC; dates such as `targetDate`, `startsOn` and
`dueDate` are `YYYY-MM-DD`. `assignee` is null or a user reference; agents carry their `responsible` person.
`milestone`, `cycle`, `dueDate` and `parent` are null when the task has none. `rank` orders the cards inside
a board column. Since 0.7.0 tasks also carry `labels` (`{ id, name, color, source }`), `dueDate`,
`subtaskProgress` (`{ done, total }`) and `blocked`; `zamu tasks show` adds `parent`, `subtasks`, `blockedBy`
and `blocks`, where a blocker you can't see is `null` ("Removed task"). List rows carry `parentKey` instead
of `parent`. Since 0.9.0 a task carries its work record: `criteria` and `doneItems` (each item
`{ number, text, state, waivedReason, waivedBy, locked }`, with `state` `open`, `checked` or `waived`), `plan`,
`finalSummary`, and `planMeta` and `finalSummaryMeta` (who last wrote them and when). List rows carry
`criteriaProgress` and `doneProgress` (`{ settled, open, waived, total }`, where settled counts checked and
waived items) and `hasFinalSummary`.

`zamu tasks list --project PAY --json`:

```json
{
  "schema": "zamu.v1.tasks.list",
  "data": {
    "items": [
      {
        "id": "01a1657a-fc2c-7636-9dde-ba795eabea62",
        "key": "PAY-1",
        "number": 1,
        "title": "Retry failed webhooks",
        "project": { "id": "01a1657a-f8e2-715c-91fd-dd9329a8ca32", "key": "PAY", "name": "Payments" },
        "status": "todo",
        "priority": "none",
        "assignee": null,
        "milestone": {
          "id": "01a16848-785e-725d-ad8d-07f37cc5360a",
          "name": "Webhooks v2",
          "status": "active",
          "targetDate": "2026-11-14"
        },
        "cycle": {
          "id": "01a16848-7867-7a12-8a90-2dd6fb6deaf8",
          "number": 1,
          "name": "Checkout rewrite",
          "startsOn": "2026-10-12",
          "endsOn": "2026-10-25",
          "state": "current"
        },
        "cycleAddedAt": "2026-10-22T21:18:41.187Z",
        "rank": -1,
        "createdAt": "2026-10-22T21:18:41.187Z",
        "updatedAt": "2026-10-22T21:18:41.187Z"
      }
    ],
    "nextCursor": null,
    "counts": { "backlog": 0, "todo": 1, "in_progress": 0, "in_review": 0, "done": 0, "canceled": 0 }
  }
}
```

`zamu tasks show PAY-1 --json` after the agent moved the task:

```json
{
  "schema": "zamu.v1.tasks.show",
  "data": {
    "task": {
      "id": "01a1657a-fc2c-7636-9dde-ba795eabea62",
      "key": "PAY-1",
      "number": 1,
      "project": { "id": "01a1657a-f8e2-715c-91fd-dd9329a8ca32", "key": "PAY", "name": "Payments" },
      "title": "Retry failed webhooks",
      "description": null,
      "status": "in_progress",
      "priority": "none",
      "assignee": null,
      "createdBy": { "id": "01a1657a-f4bd-7d42-bf4e-e13a06462256", "name": "Ana Ruiz", "kind": "person" },
      "createdOnBehalfOf": null,
      "createdAt": "2026-10-22T21:18:41.187Z",
      "updatedAt": "2026-10-22T21:18:52.818Z"
    },
    "activity": [
      {
        "id": "01a1657a-fc2f-7009-9f0f-5d5b9a31df9f",
        "type": "task.created",
        "taskKey": "PAY-1",
        "actor": { "id": "01a1657a-f4bd-7d42-bf4e-e13a06462256", "name": "Ana Ruiz", "kind": "person" },
        "onBehalfOf": null,
        "changes": [{ "field": "title", "from": null, "to": "Retry failed webhooks" }],
        "createdAt": "2026-10-22T21:18:41.187Z"
      },
      {
        "id": "01a1657b-2993-7e69-aa1e-e424a15da235",
        "type": "task.updated",
        "taskKey": "PAY-1",
        "actor": { "id": "01a1657b-0515-750b-b667-2218bd07a9bc", "name": "claude-dev", "kind": "agent" },
        "onBehalfOf": { "id": "01a1657a-f4bd-7d42-bf4e-e13a06462256", "name": "Ana Ruiz", "kind": "person" },
        "changes": [{ "field": "status", "from": "todo", "to": "in_progress" }],
        "createdAt": "2026-10-22T21:18:52.814Z"
      }
    ]
  }
}
```

`timeline` holds the same activity entries plus the comments and notes, oldest first, each with a `kind` of
`activity`, `comment` or `note`. `timelineCounts` gives the size of each filter of the web app's history:
`{ all, comments, notes, history }`. Entries written through zamu carry `source: { machine, branch }`. A
comment entry:

```json
{
  "kind": "comment",
  "id": "01a16848-b25a-7da5-aceb-752a314e6b85",
  "taskKey": "PAY-1",
  "author": { "id": "01a1657b-0515-750b-b667-2218bd07a9bc", "name": "claude-dev", "kind": "agent" },
  "onBehalfOf": { "id": "01a1657a-f4bd-7d42-bf4e-e13a06462256", "name": "Ana Ruiz", "kind": "person" },
  "body": "Picked this up. [@Ana Ruiz](mention:01a1657a-f4bd-7d42-bf4e-e13a06462256), I will open the MR today.",
  "mentions": [{ "id": "01a1657a-f4bd-7d42-bf4e-e13a06462256", "name": "Ana Ruiz", "kind": "person" }],
  "createdAt": "2026-10-22T21:19:05.142Z",
  "editedAt": null,
  "deletedAt": null
}
```

When a cycle ends, each task that moved gets a `cycle.ended` activity entry with a `cycle` change. Its
`actor` is null when the server's hourly job ended the cycle.

A failure, here `zamu tasks show PAY-99 --json` (exit code 3):

```json
{
  "schema": "zamu.v1.error",
  "data": {
    "type": "about:blank",
    "title": "Not found",
    "status": 404,
    "code": "NOT_FOUND",
    "detail": "Task PAY-99 not found",
    "requestId": "1edf9f57-2153-41ad-a277-788347720ab6"
  }
}
```

Quote `requestId` when you report a problem. The web container's log names it for server errors
(`docker compose logs web`).
