# Backlog.md

[Backlog.md](https://github.com/MrLesk/Backlog.md) keeps a project's tasks as Markdown files in the
repository, usually in a `backlog/` folder. This page is for the owners and admins who connect a Zamu project
to those files. You can follow the files, read them in once, and write a project back out as files.

## Mirror or import

A **mirror** follows the repository's default branch. Agents keep editing the files with the `backlog` CLI,
and every push shows up in Zamu. Fields that come from the files are read-only in Zamu. Comments, cycles and
the order of cards inside a board column stay editable.

An **import** reads the files one time, and from then on Zamu owns the tasks. You can edit every task in Zamu
afterwards, and later changes to the files no longer reach the project.

Choose a mirror when the files stay the place where tasks change. Choose an import when you want to manage the
tasks in Zamu from now on.

Zamu can also be the source:
- **Switch to Zamu.** A mirror stops reading the files, and Zamu owns its tasks from then on, with their
  numbers, comments and history. See [Switch to Zamu](#switch-to-zamu).
- **Export.** A project owned by Zamu writes its tasks back out as Backlog.md files with
  `zamu backlog export`, run in a clone. The folder in the repository becomes a copy of Zamu that people and
  tools can read. See [Export to Backlog.md](#export-to-backlogmd).

One side owns the tasks at a time. There is no two-way sync, because Backlog.md hands out task numbers without
any reservation and each branch can hold different tasks.

The server never writes to the repository. It reads the files through the git host's API with an access token
and never clones the repository. The export runs in your clone, and you commit its result.

This page calls a project that was created in Zamu and never read Backlog.md files a **native** project.

## Before you start

You need:
- `APP_ENCRYPTION_KEY` set on the server, for the web app and the worker. Without it, the Git connections page
  and the setup ask for it. See [self-hosting.md](self-hosting.md#git-connections-and-backlogmd).
- A git connection for the host. Add one in Settings > Git connections > Add connection, as described in the
  next section.
- The owner or admin role. Members can see a mirror's status but cannot set one up, change its mappings or
  switch it to Zamu.
- A project with no tasks, linked to the repository. "New project from Backlog.md" creates one for you.

## Git connections

A **git connection** is a workspace-wide access token for one git host. Owners and admins manage connections
in Settings > Git connections. Everyone can see the list, and nobody sees the tokens.

To add a connection:
1. Pick the provider yourself: GitHub, GitLab, or Gitea / Forgejo. A self-hosted address does not say which
   software runs there.
2. Enter the host: `github.com`, `gitlab.com`, or your server's address with its port if it has one
   (`git.example.com:3000`). For GitHub Enterprise, enter its host. The server calls its `/api/v3` API.
3. Name the connection and paste the token. Test checks the token before you save.
4. Save. Save tests the token again, and Zamu never stores a token the host rejects.

Zamu encrypts the token with `APP_ENCRYPTION_KEY` and never shows it again. The list shows only its last three
characters.

Read-only tokens are enough:

| Provider        | Token                                                                                               |
| --------------- | --------------------------------------------------------------------------------------------------- |
| GitHub          | Fine-grained token with read-only `Contents` and `Pull requests` access (`Metadata` comes with it). |
| GitLab          | Personal, group or project access token with the `read_api` scope and at least the Reporter role.   |
| Gitea / Forgejo | Access token with the `read:repository` and `read:user` scopes.                                     |

Some other tokens work too, with limits:
- With GitLab, `read_user` plus `read_repository` also works for mirrors and imports.
- On GitHub, a classic token needs the `repo` scope for private repositories. That scope also grants write
  access, so prefer a fine-grained token.
- Mirrors need only `Contents`. The switch to Zamu also reads open pull requests, so a GitHub token without
  `Pull requests` access makes its check fail.

A project picks its connection by host. The repository `https://gitlab.example.com/team/app` uses the
connection whose host is `gitlab.example.com`.

When the host rejects a token or cannot be reached, every mirror that uses the connection pauses until a later
check works. Editing the connection with a new token, or pressing Test, resumes them.

Deleting a connection pauses its mirrors. Pick another one in the project's Settings > Backlog.md > Use
another connection.

## Set up a mirror or an import

You can start in two places:
- **New from Backlog.md**, in the "+" next to Projects in the sidebar, in the workspace menu, or in the
  command palette (⌘K). Paste the clone URL and pick Mirror or Import once. The dialog creates the project and
  opens the setup at the mappings step.
- **Settings > Backlog.md**, on an existing project with no tasks and a linked repository. Choose Set up a
  mirror, or Import.

After you paste the URL, the dialog finds the connection by host and reads the folder. It fills the name from
`project_name` in `config.yml` and the key from the task prefix (`task_prefix: "pay"` gives `PAY`).

The setup has five steps, and nothing is written before the last one:
1. **Mode.** Mirror or Import once.
2. **Source.** The connection, the repository, its default branch and the folder.
3. **Mappings.** How Backlog.md statuses, priorities and assignees become values in Zamu. See
   [Mappings](#mappings).
4. **Preview.** A dry run on the current head commit. It shows how many tasks, drafts, archived tasks,
   subtasks and milestones the read creates, the first keys, the files it would skip and the values that fall
   back.
5. **Read.** Press Start mirroring, or Import N tasks. The first read runs in the worker. Tasks appear all at
   once when it finishes, and nothing shows half-done.

In the Source step, the server looks for the folder in this order:
1. the folder you typed
2. `backlog_directory` in a root `backlog.config.yml`
3. `backlog/`
4. `.backlog/`

Starting a mirror turns milestones on for the project. An import hands the tasks to Zamu right after its first
read, in the same job.

## Mappings

Each Backlog.md value maps to one value in Zamu. The setup fills the mappings in by name, and you can change
any row.

**Statuses** match by name, ignoring case, spaces, dashes and underscores, so `To Do` is Todo. Other names map
by a word they contain:

| The name contains     | Status      |
| --------------------- | ----------- |
| `review`              | In review   |
| `progress` or `doing` | In progress |
| `done` or `complete`  | Done        |
| `cancel` or `won't`   | Canceled    |
| `backlog` or `icebox` | Backlog     |

Drafts always come in as Backlog.

**Priorities** named `high`, `medium` and `low` map to High, Medium and Low. A task without a priority gets
none.

**Assignees** match `@name` or `name` against member names, agent names and the part of an email before the
`@`. A task gets the first of its assignees that maps to a member. The others stay listed in the task's "From
the file" section.

A value with no mapping gets the fallback and a warning. The fallback is Todo, no priority and no assignee. A
value that first appears in a later push gets it too.

To change the mappings later, open Settings > Backlog.md > Edit mappings. The next refresh applies them to
every task.

### Assignees that map to no one

A note under the Assignees table helps with the rows that map to no one. It works the same in the setup and in
Edit mappings. What it offers depends on the assignee:
- An assignee that names a coding agent gets a Create agent suggestion. Zamu knows claude, codex, copilot,
  cursor, gemini and others, alone or in names like `claude-code`. The suggestion opens Add agent with the
  name filled in, you as the responsible human and a key for this project only. Once the agent exists, Zamu
  shows its key once and the row maps to it.
- When an agent in the workspace shares a word with that name, the line offers it first: "@claude may be
  claude-dev." with Map to claude-dev next to Create agent claude. It lists up to three agents, newest first.
  They also appear in the row's select, under Create agent….
- Any other assignee with no match gets "@francis matches no member." and Invite…, which opens Invite person
  with a line saying which value it is for. The invitation does not map anything. After you send it, the line
  reads "Invited {email}" until the page reloads. Once the person joins, map the value in
  Settings > Backlog.md > Edit mappings.
- In Edit mappings, a row that maps to no one may now match exactly one member by name, because someone joined
  after the setup. That row gets "@tomas may be Tomás Berg." with Map to Tomás Berg. The match uses the same
  rule as the setup.

Any unmatched assignee also offers Create agent… at the top of its select.

## What a mirror owns

In a mirrored project the files own most fields, and Zamu shows those fields read-only.

| Object    | Comes from Backlog.md                                                                                                                    | Editable in Zamu                                                |
| --------- | ---------------------------------------------------------------------------------------------------------------------------------------- | --------------------------------------------------------------- |
| Task      | Title, description, status, priority, assignee, milestone, creation date, labels, due date, blockers, parent task, work record, archived | Cycle, order inside its board column, comments, check-again day |
| Label     | Name, and creating or deleting labels                                                                                                    | Colour                                                          |
| Milestone | Name, description, target date, status, and creating or deleting milestones                                                              | Nothing                                                         |
| Project   | Key (it has tasks), repository, and turning milestones off                                                                               | Name, description, cycles switch                                |

The check-again day is the day you set to look at a waiting task again. [guide.md](guide.md) describes it.

In the web app:
- The task view shows one small Backlog.md badge, which links to the file.
- A field shows a lock only when you point at it or try to change it, and the pickers open read-only.
- The board does not let you move a mirrored card to another column.
- New task is disabled and says that tasks are created in Backlog.md.
- Changes to several tasks at once don't work in a mirrored project. That covers the action bar and
  `POST /api/v1/tasks/bulk`.

The API and `zamu` refuse the same changes with `409` and one of the codes `TASK_MIRRORED`,
`MILESTONE_MIRRORED`, `PROJECT_MIRRORED` or `LABEL_MIRRORED`. The error names the field, the file and a
`backlog` command that makes the change.

### The work record

The work record is what an agent writes on a task as it works: acceptance criteria, a definition of done, a
plan, notes and a final summary. On a mirrored task the file's sections fill it. It is the same record agents
write on native tasks (see [agents.md](agents.md#the-work-record)).

| Section in the file  | In Zamu                                                             |
| -------------------- | ------------------------------------------------------------------- |
| Description          | The description                                                     |
| Acceptance Criteria  | Acceptance criteria, numbered from 1 in file order, open or checked |
| Definition of Done   | Done items, in file order                                           |
| Implementation Plan  | The plan                                                            |
| Implementation Notes | One read-only block of notes from the file                          |
| Final Summary        | The final summary                                                   |
| Comments             | "Comments from Backlog.md" at the end of the description            |

How Zamu reads the sections:
- It ignores the `#1` numbers written in the file and numbers items by their order.
- Text between the checklist items that is not an item stays in the description under its heading, so nothing
  in the file is lost.
- Headings and checkboxes inside code blocks are part of the description.

The whole work record is read-only in Zamu, and you can't add work notes to a mirrored task. The API and
`zamu` refuse with `409 TASK_MIRRORED` and the `backlog task edit` command that makes the change, such as
`backlog task edit 12 --check-ac 2`. Agents write notes in the file with `--append-notes`.

### Everything else in the file

Labels, the due date, dependencies and the parent task fill the task's own fields, as the next section
describes.

Zamu shows everything else in the file read-only, in the collapsed "From the file" section at the bottom of
the task's properties. That covers extra assignees, type, references, documentation, modified files, reporter,
the dates as written in the file, and unknown keys.

## Labels, due dates, blockers and subtasks

Since 0.7.0 a mirror fills the same four fields as native tasks. Filters, the Blocked marker, overdue dates
and subtask progress therefore work the same in both kinds of project. All four fields are read-only in Zamu.

| Backlog.md key                                    | Field in Zamu | Rules                                                                                                                          |
| ------------------------------------------------- | ------------- | ------------------------------------------------------------------------------------------------------------------------------ |
| `labels`                                          | Labels        | Each name becomes a label of the project, matched ignoring case. Names over 40 characters are left out with a warning.         |
| `due_date`                                        | Due date      | `YYYY-MM-DD` only. Any other value leaves the task without a due date and is listed as a problem.                              |
| `dependencies`                                    | Blocked by    | Backlog.md IDs of the same folder. An ID that matches no task, or the task itself, is left out and listed as a problem.        |
| `parent_task_id`, or the dotted ID (`BACK-786.1`) | Parent        | The parent's subtasks follow from it. Mirrored subtasks can nest as deep as the files do. Native subtasks stay one level deep. |

Settings > Labels marks the labels read from the files "From Backlog.md". Their names are locked, so rename or
remove them in the files. Their colour belongs to Zamu, and changing it never writes to the files.

The task history shows changes to these fields as ordinary lines, such as "Backlog.md added the label
webhooks". It does not put them under "Backlog.md-only fields changed".

## Keys and subtasks

A mirrored task keeps its Backlog.md number. In a project with the key `PAY`:

| Backlog.md   | Key in Zamu                                                   |
| ------------ | ------------------------------------------------------------- |
| `BACK-786`   | `PAY-786`                                                     |
| `BACK-786.1` | `PAY-786.1`                                                   |
| `back-007`   | `PAY-7`                                                       |
| `DRAFT-14`   | the next number above the highest task, for example `PAY-787` |

Zero padding is dropped. Drafts have their own numbering in Backlog.md, so they get numbers above the highest
task number on the first read and keep them afterwards.

The Backlog.md ID works wherever a task key does, ignoring case: in URLs, the API and `zamu`. For example,
`zamu tasks show BACK-786.1`.

IDs such as `TASK-12` can repeat across projects. Pass `--project`, or the API's `project` parameter, when an
ID alone is ambiguous.

## Refreshes

A **refresh** reads the default branch at its head commit, downloads only the files whose content changed, and
applies every change in one database transaction.

A refresh starts when:
- the git host sends a push webhook for the default branch (see [Webhooks](#webhooks))
- someone presses Refresh now in the project header's Backlog.md popover or in Settings > Backlog.md (⇧R)
- an agent runs `zamu backlog refresh`
- the hourly check runs, at 15 minutes past each hour (UTC)

The hourly check stops early when the head has not moved.

Webhook pushes within a minute of each other collapse into one refresh, so a burst of pushes costs one read.
Refresh now and `zamu backlog refresh` start right away. When a webhook refresh is waiting for its slot, they
take its place.

Open pages pick up a finished refresh the next time they load their data. Reload the page to see it at once.

The project header shows the state of the source:

| State                    | Meaning                                                                                         |
| ------------------------ | ----------------------------------------------------------------------------------------------- |
| Mirroring                | Every file was read and every value mapped.                                                     |
| Mirroring, with problems | Some files were skipped or read with a warning, or some values fell back.                       |
| Last refresh failed      | `config.yml` did not parse, or the read failed. Nothing was written. The last good state stays. |
| Paused                   | The connection is missing, rejected or unreachable, or `APP_ENCRYPTION_KEY` is missing.         |
| Detached                 | The project was switched to Zamu (or imported) and no longer reads the files.                   |

Settings > Backlog.md lists the problems of the last refresh, file by file:
- A task file that does not parse is skipped, and its task keeps its last good version. A new task appears
  once its file parses.
- When two files carry the same ID, the one with the later `updated_date` wins and the other is listed as a
  problem.

A file matches its task by Backlog.md ID, not by path. Renaming a task, which renames its file, updates the
same task.

## Hidden tasks

When a task's file disappears from the default branch, Zamu hides the task and does not delete it. The task
drops out of the list, the board, Home and every count. It keeps its comments, cycle and board position.

A task that the hidden task blocked shows "Removed task" in its Blocked by list. Opening the hidden task by
URL shows "Removed from Backlog.md" with the commit where it was last seen.

To list hidden tasks, use the "Removed from Backlog.md" filter on the task list
(`/w/<slug>/p/PAY?hidden=only`), or `GET /api/v1/tasks?project=PAY&hidden=only`. When a file with the same ID
comes back, the task comes back with the same key.

A task whose file sits under `archive/tasks/` or the old `completed/` folder is not hidden. It is archived, as
the next section describes.

## Archived tasks

A task file under `archive/tasks/`, or the older `completed/` folder, is an archived task in Zamu. It keeps
its status, usually Done, and leaves the list, the board, Home and the counts like any archived task (see
[guide.md](guide.md#archive)).

To restore the task, move the file back under `tasks/` and push. The next refresh restores it. Both moves are
history lines by Backlog.md, with the commit.

In a mirrored project the folder decides:
- Zamu does not offer Archive and Restore.
- The API and `zamu` refuse them with `409 TASK_MIRRORED` (exit code 6) and the folder to move the file to.
- The project has no archive setting. Settings > Archive says that archiving follows the `archive/tasks/`
  folder.

An import brings the archived files in archived. The export writes archived tasks back to `archive/tasks/`
(see [Export to Backlog.md](#export-to-backlogmd)).

## Webhooks

Without a webhook the mirror checks once an hour. With one, a push shows up within seconds.

Owners and admins set it up:
1. Open Settings > Backlog.md and press Setup next to Webhook, or press Set up the webhook at the end of the
   setup. The dialog shows the URL and the secret, with the steps for your provider.
2. Add the webhook on the git host, as described for each provider below.
3. Watch the dialog's last line. It turns green when the first notification arrives.

The git host must reach the URL, which is built from `PUBLIC_URL`:

```text
https://projects.example.com/api/webhooks/backlog/<id>
```

### GitLab

1. Open the repository > Settings > Webhooks > Add new webhook.
2. Paste the URL, and paste the secret into Secret token.
3. Under Trigger, tick Push events, for the default branch.
4. Save, then press Test > Push events.

### GitHub

1. Open the repository > Settings > Webhooks > Add webhook.
2. Paste the URL into Payload URL, pick `application/json` as the content type, and paste the secret into
   Secret.
3. Keep "Just the push event".
4. Save. GitHub sends a ping on save.

### Gitea and Forgejo

1. Open the repository > Settings > Webhooks > Add webhook > Forgejo (or Gitea).
2. Paste the URL into Target URL, keep POST and `application/json`, and paste the secret into Secret.
3. Under Trigger on, pick Push events and set the branch filter to the default branch.
4. Save, then open the webhook and press Test delivery.

### Pull request events on the same webhook

The same webhook carries pull request events for the project's repository, so the project needs no second
webhook (see [repositories.md](repositories.md)). Tick one more event next to the push events:

| Host              | Event to add                                                                          |
| ----------------- | ------------------------------------------------------------------------------------- |
| GitHub            | Pull requests. Pick Pushes and Pull requests under "Let me select individual events". |
| GitLab            | Merge request events                                                                  |
| Gitea and Forgejo | Pull request, under Custom events                                                     |

Requests link to the mirrored tasks but never move them, because the files own the status.

### What the URL answers

The server checks GitHub's `X-Hub-Signature-256`, GitLab's `X-Gitlab-Token`, and Gitea's or Forgejo's
signature header against the secret.
- A request with a wrong signature or an unknown ID gets `404`.
- Pushes to other branches get `204` and change nothing.
- Request events get `202`.
- After the switch to Zamu the URL answers `410 Gone`, and once the project is deleted it answers `404`.
  Remove the webhook at the host in both cases.

### New secret

Owners and admins can issue a new secret with New secret in the webhook dialog. You need one when the old
secret leaked, for example, or when `APP_ENCRYPTION_KEY` changed and the dialog says the secret can't be read.
- The URL stays the same.
- Zamu shows the new secret once, unmasked, right after you confirm.
- The old secret stops working at once. Deliveries signed with it get `404` until you paste the new secret
  into the webhook settings on the git host.
- Mirrors still refresh every hour in the meantime.

## Switch to Zamu

The switch makes Zamu the owner of a mirrored project's tasks. It replaces Detach, which earlier releases had,
and like Detach it cannot be undone. Owners and admins find it in Settings > Backlog.md > Switch to Zamu.

### The check for open requests

The dialog first asks the git host for open pull or merge requests that change files in the Backlog.md folder.
Once the project switches, their task edits never arrive, so the dialog lists them.
1. Read the list. The dialog looks at the 100 newest open requests. It lists up to five, then "35 more" with a
   link to the list on the host. "No open pull request changes the task files. Nothing will be lost." means
   you can go ahead.
2. Merge or close the listed requests first, or redo their edits in Zamu afterwards.
3. Type the project key to confirm.

When the host can't be reached or refuses the token, the dialog says so and offers Try again. The switch stays
locked until the check works.

### After the switch

- People and agents can edit every field of every task and milestone in Zamu. That includes the work record,
  where criteria and done items keep their states.
- Changes to the files no longer reach the project, and the webhook URL answers `410 Gone`.
- New tasks continue the numbering. After `PAY-812` comes `PAY-813`.
- Labels from the files become app labels, which you can rename, recolour and delete.
- Labels, due dates, blockers and parents keep their values and become editable.
- Each task keeps its Backlog.md ID and its "From the file" section as a read-only record, and its ID still
  finds it.
- Hidden tasks stay hidden.

Run `zamu agents` in the repository afterwards. It replaces the Backlog.md guidelines in `AGENTS.md` with a
line saying that tasks are in Zamu, so agents stop writing task files.

Settings > Backlog.md then shows "Owned by Zamu since" with the date, who switched the project, the export
command, and the repository the project is still linked to. The project header shows the state as Detached.

An import is a mirror that switches to Zamu right after its first read, with no check.

## Export to Backlog.md

`zamu backlog export` writes a project owned by Zamu as Backlog.md files. The project can be native, imported
or switched. Use the export to keep a readable copy in the repository, or to leave Zamu. Run it in a clone:

```sh
zamu backlog export --dry-run                     # list what would change, write nothing
zamu backlog export                               # backlog/ at the repository root
zamu backlog export --project PAY --dir docs/backlog
```

The files come from `GET /api/v1/projects/{project}/backlog/export`, which a read-only key can call. The
export targets the Backlog.md file format of release 1.57.

### What it writes

- Every task that is not hidden or archived, under `tasks/`. Done and Canceled tasks are included, as
  Backlog.md keeps them there too.
- Archived tasks, under `archive/tasks/` with the same file name.
- The front matter Backlog.md reads, in each task file: status, assignee, labels, milestone, dependencies,
  parent, priority, due date and the dates.
- The description, the acceptance criteria and the definition of done as checklists, the plan, the
  implementation notes and the final summary. The implementation notes hold the notes read from the file
  first, then the task's work notes, oldest first, each with its author and date.
- The reasons of waived items, in a block between `<!-- zamu:start -->` and `<!-- zamu:end -->` at the end of
  the file. Backlog.md has no waived state. A mirror or import of the folder reads the block back.
- The milestones, under `milestones/`.

Task IDs use the switched mirror's own prefix (`PAY-142` stays `PAY-142`), or else the letters of the project
key. A later import therefore keeps every number.

### What it removes

The export removes Markdown files under `tasks/`, `archive/tasks/`, `completed/` and `milestones/` that it no
longer has, such as:
- tasks deleted in Zamu
- the copy in the other folder of a task archived or restored since the last export
- copies in the old `completed/` folder

### What it leaves alone

The export leaves everything else in the folder alone, such as `config.yml`, documents, decisions, drafts and
files that aren't Markdown.

It does not write `config.yml`. The `backlog` CLI lists no task without a `config.yml` whose `task_prefix`
matches the exported IDs (`task_prefix: "pay"` for `PAY-142`). `zamu` therefore warns when the file is missing
or its prefix differs. Create one with `backlog init`, or fix the prefix.

### What is not exported

- comments (only work notes are exported)
- who waived an item
- the state of completed milestones
- cycles

### Keep the copy current

The copy is as fresh as the last export. Zamu does not read back edits made to the exported files. Run the
export again and commit the result whenever you want the copy to catch up.

### When the export refuses

- The export refuses when `tasks/`, `archive/tasks/`, `completed/` or `milestones/` have uncommitted changes,
  untracked files included. Commit or discard them, or pass `--force`.
- A project that still mirrors gets `409 PROJECT_MIRRORED` (exit code 6 in `zamu`), since its files are the
  source.

## Delete a mirrored project

Owners and admins delete a project in its Settings > General > Delete this project, or with
`zamu projects delete PAY --confirm PAY`.

Deleting removes the tasks, comments, history, milestones, cycles and the Backlog.md mirror. The files in the
repository are untouched. There is no undo, and a database backup is the only way back.

The webhook URL answers `404` afterwards, so remove the webhook on the git host.

## Agents in a mirrored project

Agents keep working in the files with the `backlog` CLI and push as usual. That includes the work record
(`backlog task edit 12 --check-ac 2 --append-notes "..."`). `zamu` reads the tasks, comments on them and sets
cycles.

After the switch to Zamu, agents use `zamu` for everything, and `zamu instructions` tells them how. See
[agents.md](agents.md#backlogmd-mirrors).

## Upgrade notes

These notes say what earlier upgrades did to the projects that existed then.

### The archive

At the upgrade that brought the archive, active mirrors archived the tasks whose files were in
`archive/tasks/` or the older `completed/` folder. Projects imported earlier kept those tasks as they were.

### Upgrading from 0.8.0

Up to 0.8.0 a mirror wrote the Acceptance criteria, Definition of done, Implementation plan, Implementation
notes and Final summary sections into the task's description, under `##` headings. The 0.9.0 migration moves
them out of the description into the work record of every mirrored task, by the rules in
[The work record](#the-work-record).

The migration writes no history lines. The next refresh reads the same values from the files, so it changes
nothing for files that did not change.

Projects that were already imported or detached keep the moved items as their own, and the items become
editable.

### Upgrading from 0.6.0

Before 0.7.0, labels, due dates, blockers and parent tasks sat only in the task's Backlog.md section. The
0.7.0 migrations copy them into the native fields of every existing mirror, from the data the last refresh
stored.

The copy writes no history lines. The next refresh reads the same values from the files, so it changes nothing
for files that did not change.

Imports that were already detached get their labels as app labels.
