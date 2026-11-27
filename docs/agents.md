# Agents

This page is for the admin who adds an AI coding agent to a workspace, and for whoever sets up the machine
the agent runs on. It covers creating the agent and its keys, installing the `zamu` CLI, and how the agent
records its work on a task.

An agent is a member of the workspace, like a person. It has its own name and its own API keys, and it
always acts for one person, its **responsible human**. This page also calls that person the agent's person.
Everything the agent changes shows up as "claude-dev for Ana Ruiz", in the web app and in the CLI.

Agents work through the `zamu` CLI. [apps/cli/README.md](../apps/cli/README.md) has the full command
reference.

## Add an agent

Admins add agents in Settings > Members > Add agent:
1. Name the agent, for example `claude-dev`. Names are unique in the workspace.
2. Pick the responsible human. The agent acts for this person.
3. Choose the scope of its first key (see [Scope keys](#scope-keys)).
4. Select Create agent. A dialog shows the key once. Copy it with the copy button, or copy the
   `zamu login --key ... --url ...` line under it, then close with "I copied the key".

The server keeps only a hash of the key. If you lose it, revoke it and create a new one.

To give an agent another key later, open the agent's row menu in Settings > Members and pick Manage keys,
then New key. The responsible human can do this too.

An agent belongs to one workspace, and so do its keys. When the same coding agent works for two workspaces,
add it in each. That makes two agents, each with its own keys and its own history. They may have the same
name. Deleting a workspace deletes the agents that belong only to it.

## Scope keys

Each key has two settings. You choose them when you create the key, and they are fixed afterwards.

| Setting    | Options                               | Effect                                                     |
| ---------- | ------------------------------------- | ---------------------------------------------------------- |
| Access     | Whole workspace, or Selected projects | Which projects the key can see. Other projects return 403. |
| Permission | Read and write, or Read only          | Read only can list and show. It cannot create or update.   |

Give each agent the narrowest key that does the job. An agent that works on one repository gets a key for
that project only. Creating projects needs a key with whole-workspace access and write permission.

People can create keys for themselves in Settings > Your API keys, for their own scripts.

### Revoke a key

Revoke a key in Settings > API keys, where admins see every key in the workspace, or from the agent's
Manage keys page. The key stops working at once, and the CLI exits with code 2.

Removing an agent from the workspace disables all of its keys.

### Delete a project

Only owners and admins delete projects. Agents never can, and there is no undo.

Delete a project in its Settings > General, or with `zamu projects delete PAY --confirm PAY` and a person's
key with whole-workspace access and write permission. The command refuses in these cases:

| Case                                                       | Result                                   |
| ---------------------------------------------------------- | ---------------------------------------- |
| Without `--confirm`, or with a different project key in it | zamu exits with code 1 and sends nothing |
| With an agent's key                                        | Exit code 4                              |
| For an unknown project                                     | Exit code 3                              |

Keys scoped to a deleted project keep their other projects. A key that covered only deleted projects stays,
with no projects, until you revoke it.

## Use zamu in an agent's environment

Set up the agent's machine in three steps.
1. Install the CLI with npm (Node 24 or later) or Homebrew:

   ```sh
   npm install --global @reddevs/zamu
   brew install reddevsdotio/tap/zamu
   ```

2. Give the agent two environment variables instead of running `zamu login`:

   | Variable   | Value                                                        |
   | ---------- | ------------------------------------------------------------ |
   | `ZAMU_URL` | The server URL, the same as `BETTER_AUTH_URL` on the server. |
   | `ZAMU_KEY` | The agent's API key (`zamu_live_...`).                       |

   Store `ZAMU_KEY` as a secret in the agent's runner or CI settings, never in the repository.

3. Check the setup:

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

The two variables override the logins that `zamu login` stores. The agent's key never mixes with a person's
login on the same machine.

A key acts in its own workspace, so one `ZAMU_KEY` means one workspace. An agent that works in several uses
stored logins instead (see [Several workspaces](#several-workspaces)).

### Install, upgrade and other ways to run it

- Keep the full Homebrew name. A bare `brew install zamu` after `brew tap` stops with a trust error on
  current Homebrew.
- To upgrade, run `npm update --global @reddevs/zamu` or `brew upgrade reddevsdotio/tap/zamu`.
- `zamu --version` prints the version installed.
- The Docker image also ships the CLI as `zamu`.
- The [CLI reference](../apps/cli/README.md#install) shows how to run it from a clone of this repository.

## Several workspaces

A key belongs to one workspace. A person or an agent that works in several runs `zamu login` once per
workspace on each server. The first login is the default.

```sh
zamu login --key zamu_live_... --url https://zamu.example.com   # Acme: the default
zamu login --key zamu_live_...                                  # Globex, on the same server
zamu workspaces                                                 # the logins; * marks the one used here
zamu workspaces --default globex                                # make Globex the default
zamu --workspace globex tasks list --mine                       # one command in Globex
zamu logout --workspace globex                                  # remove one login, or all with --all
```

zamu stores one login for each workspace in `$XDG_CONFIG_HOME/zamu/config.json`
(`~/.config/zamu/config.json`).
- Logging in again with a new key for the same workspace replaces its key.
- `zamu login --default` makes the new login the default.
- `zamu logout` without a flag removes the login used in the current folder.

### Which login a command uses

Each command uses the first login that applies:
1. `--workspace <slug>`, a slug or a workspace id. Every command takes it.
2. `ZAMU_KEY` (with `ZAMU_URL`).
3. The login zamu matched to this clone's git remote before, cached in `$XDG_STATE_HOME/zamu/clones.json`
   (`~/.local/state/zamu/clones.json`).
4. The login whose workspace has a project linked to the clone's remote. When no workspace has one, the
   login whose workspace has the project the nearest `.zamu.json` names.
5. The default login.

For step 4, zamu asks every login at once, within the 5 seconds it waits for any answer, and caches a
single match. When the cached login gets a 403 or 404, zamu matches again.

`zamu whoami` shows which login applies in the current folder and why
("Login from the login for this clone's git remote").

With a single login there is nothing to match.

When a clone matches two or more logins, the command stops with exit code 1 and lists the `--workspace`
values to pass. That happens, for example, when two workspaces each have a project `PAY` and `.zamu.json`
names `PAY`.

### A key sent for another workspace

Every request names the login's workspace in the `x-zamu-workspace` header. The server refuses a key sent
for another workspace with 403 `WORKSPACE_MISMATCH` (exit code 4). So `zamu --workspace globex` with an Acme
`ZAMU_KEY` fails instead of reading Acme's data.

### Config files from zamu 0.9

The config file of zamu 0.9 (`{ "url", "key" }`) keeps working. The first command that reaches the server
reads the key's workspace and writes the file back in the new form. Offline, zamu uses the old file as it
is.

## Link the repository to its project

Link each project to the repository its code lives in, once. Then an agent working in any clone of it can
leave out `--project`, because zamu finds the project from the clone's git remote.

```sh
cd payments                 # a clone of gitlab.com/reddevs/payments
zamu link --project PAY       # or set Repository in the project's settings on the web
zamu agents                   # write the zamu instructions into AGENTS.md, naming PAY
git add AGENTS.md && git commit -m "Add zamu instructions for agents"
```

`zamu link` needs a key that can edit the project. HTTPS and SSH URLs of the same repository match.

A repository belongs to one project. Linking it to a second one fails with exit code 1 and names the first.

### Other ways to set the project

zamu checks these in order and uses the first one that names a project:
1. `--project`.
2. The `ZAMU_PROJECT` variable.
3. The nearest committed `.zamu.json` (`{ "project": "PAY" }`), which `zamu link --file` writes. It is
   useful when one repository holds several projects, with one file per subfolder.
4. The linked remote.

`zamu whoami` shows which one applies in the current folder.

### What zamu agents writes

`zamu agents` puts a short block between `<!-- zamu:start ... -->` and `<!-- zamu:end -->` in `AGENTS.md`, or
in `CLAUDE.md` when only that exists. The block names the project and points the agent to
`zamu instructions` (see [Instructions for agents](#instructions-for-agents)).
- Run it again after upgrading zamu. It replaces only its own block.
- `zamu agents --print` shows the block without writing it.

A project owned by Zamu keeps its tasks in Zamu and does not read them from Backlog.md files. In such a
project, `zamu agents` also replaces a Backlog.md guidelines block in the same file. That block sits between
`<!-- BACKLOG.MD GUIDELINES START -->` and `<!-- BACKLOG.MD GUIDELINES END -->`. One line takes its place:
tasks are in Zamu, and the `backlog` CLI is only for documents and decisions.

## Instructions for agents

`zamu instructions` prints how an agent works on a task with zamu. The text ships with the CLI, so it always
matches the version installed. That keeps the block `zamu agents` writes short.

```sh
zamu instructions                # overview: the work record, the rules, the exit codes
zamu instructions creating       # search before creating; criteria that can be tested
zamu instructions working        # start from the work branch, the plan, notes, Closes: lines, check-again days
zamu instructions finishing      # the final summary, stopping at In review, the final report
```

A typical loop for an agent:

```sh
zamu dashboard --json                     # reviews, mentions of the agent, stalled work, deadlines
zamu tasks list --mine --status todo --cycle current --json
zamu tasks show PAY-142 --json            # criteria, done items, plan, summary, requests and history
git switch -c claude/pay-142-retry-queue  # the branch the pull request will come from
zamu tasks update PAY-142 --status in_progress --plan - < plan.md
zamu notes add PAY-142 "Retry queue written and tested"
zamu tasks update PAY-142 --check-ac 1 --check-ac 2 --check-dod 1
zamu tasks update PAY-142 --final-summary - --status in_review < summary.md
```

`--mine` lists the tasks assigned to the key's owner across every project the key can read. Add `--project`
to narrow it to one or more projects.

## Exit codes

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

Code 6 is for conflicts with a mirror, a project that reads its tasks from the Backlog.md files in its
repository. Other conflicts stay on 1. The problem codes map to exit codes like this:

| Exit code | Problem codes                                                                                                                                                                                                                 |
| --------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| 6         | `TASK_MIRRORED`, `MILESTONE_MIRRORED`, `PROJECT_MIRRORED`, `LABEL_MIRRORED`, `PROJECT_NOT_EMPTY`, `BACKLOG_PAUSED` and `BACKLOG_DETACHED`                                                                                     |
| 1         | Other conflicts, such as two edits racing, a blocker loop (`DEPENDENCY_LOOP`), a label name the project has (`LABEL_EXISTS`), a task finished with open items (`OPEN_ITEMS`) or a write to an archived task (`TASK_ARCHIVED`) |
| 1         | A pull request address the server refuses (`REQUEST_OTHER_REPOSITORY`, `NOT_A_REQUEST`)                                                                                                                                       |
| 3         | A pull request the host doesn't know (`REQUEST_NOT_FOUND`)                                                                                                                                                                    |

See [Backlog.md mirrors](#backlogmd-mirrors) and [Offline queue](#offline-queue).

## The work record

A task's **work record** is what an agent writes while it works: the acceptance criteria, the definition of
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

The numbers are the ones `zamu tasks show` prints.

All the flags of one command go in one request. So `--check-ac 3 --final-summary - --status in_review`
checks the item, writes the summary and moves the task at once.

The lists and texts have limits:

| What                             | Limit                          |
| -------------------------------- | ------------------------------ |
| A criterion or a done item       | One line, up to 500 characters |
| Criteria or done items on a task | 50 per list                    |
| The plan, and the final summary  | Up to 50,000 characters each   |

The [CLI reference](../apps/cli/README.md#work-record) lists every flag.

### An agent can't finish a task with open items

An agent can't move a task to In review or Done while a criterion or done item is open. The server answers
`409 OPEN_ITEMS`. zamu prints the open items with the flags that settle each one and exits with code 1:

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

zamu sends two headers with every request:

| Header           | Value                                                               |
| ---------------- | ------------------------------------------------------------------- |
| `x-zamu-machine` | The machine name: `ZAMU_MACHINE`, else the host name.               |
| `x-zamu-branch`  | The git branch checked out in the current folder when there is one. |

The server stores them on history entries and notes. Values are cut to 100 characters.
- The web app shows them as "build-box · feat/payout-retries" under the History filter.
- `zamu tasks show` prints them at the end of each line.

The web app sends neither header.

The branch also becomes the task's work branch when the command starts the task (see
[Pull requests](#pull-requests)).

## Pull requests

When the project links its repository (see [repositories.md](repositories.md)), Zamu reads the repository's
pull requests, links them to tasks and moves the tasks. GitLab calls them merge requests, and this page
calls both requests. An agent gets all of this by working the usual way:
1. **Start the task from its branch.** Create or switch to the branch first. Then run
   `zamu tasks update PAY-142 --status in_progress` (or `zamu tasks create ... --status in_progress`) in the
   clone. zamu sends the branch as `x-zamu-branch`, and the server records it as the task's work branch. A
   request opened from that branch links to the task, also when it was opened earlier.
2. **Name the other tasks in the description.** When one request covers several tasks, add a line such as
   `Closes: PAY-142, PAY-150` to its description. Zamu ignores keys of other projects.
3. **Stop at In review.** Opening the request, or marking a draft ready, moves its tasks to In review on its
   own. When the project closes on merge, the merge into the default branch moves them to Done. Leave that
   step to the merge. `zamu projects show` says whether the project closes on merge.

Some cases work differently:
- The server never records the default branch as a work branch.
- A later start from another branch replaces the recorded work branch.
- Drafts link without moving anything.
- A merge moves a task to Done even with open items. The task is then flagged "Merged with 2 open criteria"
  and shows on its person's Home, the page of the web app that groups what needs that person. Settle the
  items before the merge.

`zamu tasks show` lists the work branch and each request with its number, title, state, how it was linked
and its address. History lines name the host for request events: "GitHub moved this to In review · #482
opened by claude-dev".

### Link or unlink a request by hand

```sh
zamu pr link PAY-142 https://github.com/northwind/payments/pull/482
zamu pr link PAY-142 https://gitlab.example.com/northwind/payments/-/merge_requests/12 --dry-run
zamu pr unlink PAY-142 482            # also #482, or !12 on GitLab
zamu projects show PAY                # repository, close on merge, webhook, hourly check, archive days
```

- `--dry-run` shows the request as it would link and writes nothing.
- A link made by hand acts on the request's state like an event. Linking an open request moves the task to
  In review.
- An unlinked request stays off the task. Neither the branch nor a `Closes:` line brings it back, only
  `zamu pr link`.

`zamu pr link` refuses three kinds of address:

| The address is                    | Problem code               | Exit code |
| --------------------------------- | -------------------------- | --------- |
| A request from another repository | `REQUEST_OTHER_REPOSITORY` | 1         |
| Not a request                     | `NOT_A_REQUEST`            | 1         |
| A request the host doesn't know   | `REQUEST_NOT_FOUND`        | 3         |

## Check-again days and the archive

### Check-again days

A **check-again day** is a day you set to look at a task again. Set one when a task waits on something
outside your control, instead of leaving it In progress with no word:

```sh
zamu tasks update PAY-142 --check-again 2026-12-03 --reason "Waiting for the bank's answer"
zamu tasks update PAY-142 --no-check-again
zamu tasks list --mine --waiting          # the day is still ahead
zamu tasks list --mine --ready-to-check   # the day has come
```

- The reason is required. A day without one exits 1 before anything is sent.
- `--reason` belongs to the `--check-again`, `--waive-ac` or `--waive-dod` typed before it.
- Moving the task to Done or Canceled clears the day.
- Once the day comes, the task shows on its person's Home under Check again.

### The archive

Projects can archive closed tasks on their own after a number of days. Agents can archive and restore by
hand too:

```sh
zamu tasks archive PAY-140 PAY-141        # up to 100 keys, all or nothing
zamu tasks restore PAY-140
zamu tasks list --project PAY --archived only
```

Every list leaves out archived tasks unless you pass `--archived include` or `--archived only`. Archived
tasks also refuse every write, comments and notes included (`TASK_ARCHIVED`, exit 1).

Tasks of a mirrored project follow Backlog.md's `archive/tasks/` folder. Archiving or restoring one exits
with 6 and says which folder to move the file to.

## Offline queue

When the server doesn't answer within 5 seconds, zamu stores some writes in a local queue instead of
failing. It prints "Queued: the server didn't answer. It will be sent on your next zamu command." and exits
with code 7. The next zamu command that reaches the server sends the queued writes first, oldest first.

zamu queues these writes, and only on an existing task:
- Checking, unchecking or waiving items.
- A status change.
- A check-again day.
- A note or comment.
- Archiving and restoring.
- `zamu pr link` (not `--dry-run`) and `zamu pr unlink`.

Every other write, such as creating a task, fails as before.

Three commands show and change the queue:
- `zamu queue` lists what waits.
- `zamu queue drop ID` removes one write.
- `zamu whoami` shows the count.

### Queued status changes

- zamu queues a status change only when it has seen that task's status before. Otherwise the command fails
  and asks you to run `zamu tasks show` once the server answers.
- When zamu sends the queue, it skips a queued status change if the task moved in the meantime.
- zamu keeps the statuses it remembers per server and workspace, so `PAY-1` of one workspace never stands in
  for `PAY-1` of another.

### Which login sends a queued write

A queued write keeps the login it was queued with. The next command that reaches the server sends it with
that login's key and workspace, whichever login the command itself uses.

A write queued with a `ZAMU_KEY` that no stored login holds waits for a command that uses that key. So it
keeps its author when a person and an agent share a machine.

## Comments and mentions

Agents comment on tasks the way people do. The comment shows in the task's history in the web app as
"claude-dev for Ana Ruiz". The body is Markdown, up to 20,000 characters.

```sh
zamu comments add PAY-142 "Picked this up. @ana@example.com, I will open the MR today."
pnpm test 2>&1 | tail -20 | zamu comments add PAY-142 -     # "-" reads the body from stdin
zamu comments list PAY-142
zamu comments edit 01a16848-b25a-7da5-aceb-752a314e6b85 "Fixed: the MR is !42."
zamu comments delete 01a16848-b25a-7da5-aceb-752a314e6b85
```

`zamu tasks show PAY-142` prints the history. Activity takes one line per entry. Comments and notes print as
indented blocks with their id. Notes are comments of kind `note` (see [The work record](#the-work-record)).

Comment ids are in `zamu comments list`, in `zamu tasks show` and in the `--json` output.

### Mentions

Mention someone with `@` and their email (`@ana@example.com`) or an agent's name (`@claude-dev`).

The server checks that they are members of the workspace and stores the mention as a link,
`[@Ana Ruiz](mention:<userId>)`. The web app shows it as the name in the accent colour. An `@word` that
matches nobody stays plain text.

Mentions send no notification yet.

### Edit and delete

Only the author can edit or delete a comment. That holds for agents too:
- The agent's responsible human cannot edit the agent's comments.
- An agent trying to delete a person's comment gets exit code 4.

Deleting leaves "Comment deleted by ..." in the history.

## Milestones and cycles

Projects can group tasks in two ways:
- A **milestone** is a goal with an optional target date.
- A **cycle** is a numbered, dated period of work, usually two weeks.

Both are on by default. Anyone who can edit a project can turn either off in its settings (General) in the
web app. The data stays and comes back when you turn it on again.

### Milestones

Milestones go by name or id. Names are unique in a project and the CLI ignores case:

```sh
zamu milestones list --project PAY
zamu milestones create --project PAY "Payout reports" --target 2026-12-04
zamu tasks update PAY-142 --milestone "payout reports"
zamu tasks list --project PAY --milestone "Payout reports"
zamu milestones update "payout reports" --project PAY --status completed
```

A milestone starts as Planned and turns Active by itself when one of its tasks moves to In progress or In
review. Only a person or agent marks it Completed.

An unknown name fails with exit code 1 and lists the project's milestones, so an agent can retry with the
right one.

### Cycles

Cycles go by number, or by `current` and `next`:

```sh
zamu cycles current --project PAY
zamu tasks list --mine --cycle current
zamu tasks update PAY-142 --cycle next
zamu cycles create --project PAY                   # the day after the last cycle, same length
zamu cycles end --project PAY                      # ends the current cycle early
```

A cycle ends when someone ends it early, or at midnight after its end date (in the server's
`APP_TIME_ZONE`). Its unfinished tasks then move to the next cycle. When none is planned, the server creates
one with the same length. `zamu cycles end --move-to none` takes them out of cycles instead.

`zamu cycles current --json` prints `"data": null` with exit code 0 when no cycle is running.

### Clear or filter with none

`--milestone none` and `--cycle none` clear the field on `zamu tasks update`. On `zamu tasks list` they
filter tasks without one.

## Labels, due dates, blockers and subtasks

Native tasks, the ones that are not mirrored from Backlog.md files, have four more fields since 0.7.0.
Agents set them with the same `zamu tasks` commands. The
[CLI reference](../apps/cli/README.md#labels-due-dates-subtasks-and-blockers) has the full option list.

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
  a marker only, and nothing stops a blocked task from moving. A blocker that would close a loop fails with
  exit code 1: `zamu: Can't add: PAY-150 already waits on PAY-142.` (`DEPENDENCY_LOOP`).
- **Subtasks** go one level deep and stay in the parent's project (`SUBTASK_DEPTH`, `NOT_SAME_PROJECT`). A
  new subtask takes the parent's assignee unless you pass `--assignee`. The parent shows its progress as done
  of total, canceled subtasks left out.

`zamu tasks show` prints them, and `zamu tasks list` adds DUE, LABELS, PARENT, SUBTASKS and BLOCKED columns
when a row has a value for them.

Mark your task blocked instead of leaving it In progress with no word. The person sees it on Home under
Blocked.

## Backlog.md mirrors

A project can **mirror** the Backlog.md folder of its repository (see [backlog-md.md](backlog-md.md)). The
files on the default branch stay the source of truth. Agents keep working in them with the `backlog` CLI,
and the project follows every push.

Mirrored tasks keep their Backlog.md numbers, so `BACK-786.1` is `PAY-786.1` in a project with the key
`PAY`.

### Work in a mirrored project

- Change a task by editing its file in `backlog/` (or the folder the project reads) and pushing to the
  default branch, for example `backlog task edit 786 -s "In Progress"`. Changes on other branches show up
  once they are merged.
- `zamu` reads the tasks, comments on them and sets their cycle.
- Every command that takes a task key also takes the Backlog.md ID: `zamu tasks show BACK-786.1`. IDs such
  as `TASK-12` can repeat across projects. Add `--project` when zamu asks for it.
- The work record comes from the file too. Criteria and done items come from its Acceptance Criteria and
  Definition of Done, the plan and the final summary from their sections. `zamu tasks show` marks them
  "from Backlog.md, read-only".

### What zamu refuses

In a mirrored project, `zamu` refuses to:
- Change the title, description, status, priority, assignee, milestone, labels, due date, blockers, parent
  or work record of a mirrored task.
- Write a note on a mirrored task.
- Create tasks.
- Change milestones.
- Rename or delete a label read from the files.

It exits with code 6 and says where the change belongs:

```text
$ zamu tasks update PAY-786 --status done
error: PAY-786 is mirrored from Backlog.md, so its status can't change here (task_mirrored).
  file:  backlog/tasks/back-786 - Retry-failed-webhook-deliveries-with-exponential-backoff.md (main)
  edit the file and push, or run: backlog task edit 786 -s Done
  still allowed here: comments (zamu comments add PAY-786) and cycles (zamu tasks update PAY-786 --cycle 4)
```

With `--json`, the error is the server's problem, with `field`, `file`, `backlogId` and `hint` (the
`backlog` command that makes the change).

### Refresh after a push

After a push, the project usually catches up within seconds through the git host's webhook. When an agent
needs the change right away, for example before it reads the task back, it asks for a refresh and waits:

```sh
zamu backlog refresh --wait --json   # reads the default branch now and waits for the result, up to 5 minutes
zamu backlog status                  # mode, state, branch, folder, last read and its commit, counts
zamu backlog status --problems       # every file skipped or read with a warning, and every unmapped value
```

`zamu backlog refresh` needs a key that can write the project.

With `--wait` it exits 0 whatever the read found, so check `data.status.state` in the JSON. The states are:
- `healthy`
- `warnings`. Some files were skipped or values fell back, and `zamu backlog status --problems` lists them.
- `failed`
- `paused`

`zamu backlog refresh` exits with code 6 when the mirror is paused or detached:
- `BACKLOG_PAUSED`: the git connection is missing, rejected or unreachable. An admin fixes it in the web
  app.
- `BACKLOG_DETACHED`: the mirror is detached. The project was switched to Zamu, or imported, and no longer
  reads the files.

### Deleted files

A task whose file is deleted from the default branch is hidden, not deleted. It leaves `zamu tasks list`,
and `zamu tasks show` marks it "Hidden". It comes back with the same key when a file with its ID returns.

### After the switch to Zamu

Once a project is switched to Zamu (see [backlog-md.md](backlog-md.md#switch-to-zamu)), or was imported
once, its tasks behave like any other. `zamu` creates and updates them, and edits to the files no longer
reach the project.

Agents should stop writing task files in `backlog/` then. `zamu agents` replaces the Backlog.md guidelines
in `AGENTS.md` to say so.

The repository can still keep a copy of the tasks as files:

```sh
zamu backlog export --dry-run      # what would change under backlog/, nothing written
zamu backlog export                # write the tasks and milestones, remove task files Zamu no longer has
git add backlog && git commit -m "Update the Backlog.md copy"
```

The export refuses in two cases:
- With exit code 1, while the exported folders have uncommitted changes, unless you pass `--force`.
- With exit code 6 (`PROJECT_MIRRORED`), for a project that still mirrors.

[backlog-md.md](backlog-md.md#export-to-backlogmd) says what the export writes and what it leaves alone.

## Dashboard

`zamu dashboard` shows what needs someone now, across every project the key can read.

```sh
zamu dashboard               # Mine: your tasks, your agents' tasks and mentions of you
zamu dashboard --everyone    # the whole workspace
zamu dashboard --json        # { schema: 'zamu.v1.dashboard', data: Dashboard }
```

In the web app, Home replaced the Dashboard page in 0.7.0. `zamu dashboard` keeps its four groups and its
`zamu.v1.dashboard` output, so scripts written for 0.6.0 keep working. Home's own data is
`GET /api/v1/home` (see the [API reference](api.md#home)).

### The action queue

The output starts with the action queue, in four groups:

| Group     | An item stays while                                                                                                                                              |
| --------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| In review | The task is In review.                                                                                                                                           |
| Mentions  | A comment mentions the member, the task is open, and the member has not commented on the task or changed it since. A reply by the member's agent does not count. |
| Stalled   | The task is In progress with no update or comment for 24 hours when an agent holds it, or 5 days otherwise.                                                      |
| Deadlines | A milestone is past its target date with open tasks, or the current cycle ends within 2 days with open tasks.                                                    |

Items leave the queue on their own when the condition clears. Nobody dismisses them.

Two more parts follow the queue:
- One row per project, with open, in progress and in review counts, current cycle, next milestone and last
  activity.
- The agents, with who they work for, their current task or Idle, and whether it is stalled.

### Mine and everyone

- For a person, Mine covers the tasks assigned to them or to the agents they are responsible for, and
  mentions of them.
- For an agent's key, Mine means the agent's own tasks and mentions of the agent.
- `--everyone` covers every task and every mention in the projects the key can read.

The key's project scope applies in both.

### Ask your person for input

When you need input from a person, mention your responsible human in a comment (@their-email). That puts it
on their Home, under Mentions. It stays there until they comment on the task or change it.

```sh
zamu comments add PAY-142 "Refunds over 500 EUR: one approval or two? @ana@example.com"
zamu tasks update PAY-142 --status in_review    # your task in review shows on their Home too
```

Your own dashboard works the same way. `zamu dashboard` lists the comments that mention you and your tasks
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

The other shapes:
- `task` is `{ key, title, status, priority, project: { key, name } }`.
- `excerpt` is plain text of at most 200 characters. Mentions read `@Name` and inline code keeps its
  backticks.
- A project row has `key`, `name`, `openCounts`, `openCount`, `usesMilestones`, `usesCycles`,
  `lastActivityAt`, `currentCycle` and `nextMilestone`.
- An agent row has `agent`, `currentTask` (null when idle), `inProgressCount`, `stalled` and
  `lastActivityAt`.

`GET /api/v1/dashboard/counts` returns only the Mine totals:
`{ review, mentions, stalled, deadlines, total }`.

## --json output

Every command takes `--json` and prints one line with a versioned envelope:

```json
{ "schema": "zamu.v1.<command>", "data": {} }
```

Check `schema` before reading `data`. Within `zamu.v1`, fields are only added, never removed or changed. A
breaking change ships as `zamu.v2`.

The Zod schemas live in `packages/contracts` (`cliDataSchemas` in `src/cli.ts`, entities in
`src/entities.ts`). The server publishes the same shapes as OpenAPI at `GET /api/v1/openapi.json`.

| Schema                      | `data`                                                                                 |
| --------------------------- | -------------------------------------------------------------------------------------- |
| `zamu.v1.login`             | `{ url, me, replaced, default }`                                                       |
| `zamu.v1.logout`            | `{ url, removed }` (`url` null when nothing was stored)                                |
| `zamu.v1.whoami`            | `{ user, workspace, role, auth: { method, scope }, project, queued, workspaceSource }` |
| `zamu.v1.workspaces`        | `{ items: [{ url, workspace, default, current }], source }`                            |
| `zamu.v1.dashboard`         | `{ scope, generatedAt, groups, projects, agents }` (see Dashboard above)               |
| `zamu.v1.projects.list`     | `{ items: Project[] }` with open counts per status                                     |
| `zamu.v1.projects.show`     | `{ project, repository }`: `repository` is null when the key can't read the settings   |
| `zamu.v1.projects.delete`   | `{ deleted }`: the key of the deleted project                                          |
| `zamu.v1.tasks.list`        | `{ items: TaskListItem[], nextCursor, counts }`                                        |
| `zamu.v1.tasks.show`        | `{ task: Task, activity: Activity[], timeline, timelineCounts }`                       |
| `zamu.v1.tasks.create`      | `Task`                                                                                 |
| `zamu.v1.tasks.update`      | `Task`                                                                                 |
| `zamu.v1.tasks.archive`     | `{ items: TaskListItem[] }`, in the order sent                                         |
| `zamu.v1.tasks.restore`     | `{ items: TaskListItem[] }`, in the order sent                                         |
| `zamu.v1.pr.link`           | `{ task, pullRequest, dryRun }`                                                        |
| `zamu.v1.pr.unlink`         | `{ task, number }`                                                                     |
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

### Task fields

These hold for every task:
- Statuses are `backlog`, `todo`, `in_progress`, `in_review`, `done`, `canceled`.
- Priorities are `none`, `low`, `medium`, `high`, `urgent`.
- Timestamps are ISO 8601 in UTC. Dates such as `targetDate`, `startsOn` and `dueDate` are `YYYY-MM-DD`.
- `assignee` is null or a user reference. Agents carry their `responsible` person.
- `milestone`, `cycle`, `dueDate` and `parent` are null when the task has none.
- `rank` orders the cards inside a board column.

Since 0.7.0, labels, due dates, subtasks and blockers:
- Tasks carry `labels` (`{ id, name, color, source }`), `dueDate`, `subtaskProgress` (`{ done, total }`)
  and `blocked`.
- `zamu tasks show` adds `parent`, `subtasks`, `blockedBy` and `blocks`, where a blocker you can't see is
  `null` ("Removed task").
- List rows carry `parentKey` instead of `parent`.

Since 0.9.0, the work record:
- Tasks carry `criteria` and `doneItems`, `plan`, `finalSummary`, and `planMeta` and `finalSummaryMeta` (who
  last wrote them and when).
- Each item of `criteria` and `doneItems` is `{ number, text, state, waivedReason, waivedBy, locked }`, with
  `state` `open`, `checked` or `waived`.
- List rows carry `criteriaProgress` and `doneProgress` (`{ settled, open, waived, total }`, where settled
  counts checked and waived items) and `hasFinalSummary`.

Pull requests, check-again days and the archive:
- Tasks carry `workBranch`, `pullRequests`, `checkAgain` (`{ on, reason }` or null), `closedAt`,
  `archivedAt`, `archivedBy` and `mergedOpen` (`{ at, openCriteria, openDoneItems }` or null).
- Each item of `pullRequests` is
  `{ provider, number, title, url, state, headBranch, baseBranch, author, mergedBy, how, linkedBy, ... }`,
  with `how` `branch`, `description` or `hand`.
- List rows carry `checkAgain`, `archivedAt`, `pullRequest` (the newest,
  `{ provider, number, title, url, state }`) and `pullRequestCount`.

Activity entries made without a person carry `system`: the git host, Zamu (the nightly archive) or
Backlog.md. `cause` says why (a request event, or the archive setting).

### A task list

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

### A task with its history

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

The same output has two more fields:
- `timeline` holds the same activity entries plus the comments and notes, oldest first. Each entry has a
  `kind` of `activity`, `comment` or `note`.
- `timelineCounts` gives the size of each filter of the web app's history:
  `{ all, comments, notes, history }`.

Entries written through zamu carry `source: { machine, branch }`. A comment entry:

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

### A failure

`zamu tasks show PAY-99 --json` exits with code 3 and prints:

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
