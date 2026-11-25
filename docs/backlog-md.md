# Backlog.md

[Backlog.md](https://github.com/MrLesk/Backlog.md) keeps a project's tasks as Markdown files in the
repository, usually in a `backlog/` folder. A project here can work with those files in two directions.

Backlog.md as the source:
- **Mirror.** The project follows the repository's default branch. Agents keep editing the files with the
  `backlog` CLI, and every push shows up here. Fields that come from the files are read-only in this app;
  comments, cycles and the order of cards inside a board column stay editable.
- **Import once.** The project reads the files one time, and from then on Zamu owns the tasks. Every task is
  editable here afterwards, and later changes to the files no longer reach the project.

Zamu as the source:
- **Switch to Zamu.** A mirror stops reading the files and Zamu owns its tasks from then on, with their
  numbers, comments and history. See [Switch to Zamu](#switch-to-zamu).
- **Export.** A project owned by Zamu writes its tasks back out as Backlog.md files with
  `zamu backlog export`, run in a clone. The folder in the repository becomes a copy of Zamu that people and
  tools can read. See [Export to Backlog.md](#export-to-backlogmd).

There is no two-way sync: Backlog.md hands out task numbers without any reservation and each branch can hold
different tasks, so one side owns the tasks at a time. The server never writes to the repository. It reads the
files through the git host's API with an access token and never clones the repository; the export runs in
your clone, and you commit its result.

## Before you start

You need:
- `APP_ENCRYPTION_KEY` set on the server (web and worker). Without it, the Git connections page and the
  setup ask for it. See [self-hosting.md](self-hosting.md#git-connections-and-backlogmd).
- A git connection for the host: Settings > Git connections > Add connection. See below.
- The owner or admin role. Members can see a mirror's status but cannot set one up, change its mappings or
  switch it to Zamu.
- A project with no tasks, linked to the repository. "New project from Backlog.md" creates one for you.

## Git connections

A connection is a workspace-wide access token for one git host. Owners and admins manage them in Settings >
Git connections; everyone can see the list, and nobody sees the tokens.
1. Pick the provider yourself (GitHub, GitLab, or Gitea / Forgejo). A self-hosted address does not say which
   software runs there.
2. Enter the host: `github.com`, `gitlab.com`, or your server's address with its port if it has one
   (`git.example.com:3000`). For GitHub Enterprise, enter its host; the server calls its `/api/v3` API.
3. Name the connection and paste the token. Test checks the token before you save, and Save tests it again:
   a token the host rejects is never stored. The token is encrypted with `APP_ENCRYPTION_KEY` and never
   shown again; the list shows only its last three characters.

Read-only tokens are enough:

| Provider        | Token                                                                                               |
| --------------- | --------------------------------------------------------------------------------------------------- |
| GitHub          | Fine-grained token with read-only `Contents` and `Pull requests` access (`Metadata` comes with it). |
| GitLab          | Personal, group or project access token with the `read_api` scope and at least the Reporter role.   |
| Gitea / Forgejo | Access token with the `read:repository` and `read:user` scopes.                                     |

With GitLab, `read_user` plus `read_repository` also works for mirrors and imports. On GitHub, a classic
token needs the `repo` scope for private repositories, which also grants write access, so prefer a
fine-grained token. Mirrors need only `Contents`; the switch to Zamu also reads open pull requests, so a
GitHub token without `Pull requests` access makes its check fail.

A project picks its connection by host: the repository `https://gitlab.example.com/team/app` uses the
connection whose host is `gitlab.example.com`. When the host rejects a token or cannot be reached, every
mirror that uses the connection pauses until a later check works. Editing the connection with a new token,
or pressing Test, resumes them. Deleting a connection pauses its mirrors; pick another one in the project's
Settings > Backlog.md > Use another connection.

## Set up a mirror or an import

There are two ways in:
- **New from Backlog.md** in the "+" next to Projects in the sidebar, in the workspace menu, or in the command
  palette (⌘K). Paste the clone URL. The dialog finds the connection
  by host, reads the folder and fills the name from `project_name` in `config.yml` and the key from the task
  prefix (`task_prefix: "pay"` gives `PAY`). Pick Mirror or Import once. It creates the project and opens the
  setup at the mappings step.
- **Settings > Backlog.md** on an existing project with no tasks and a linked repository: Set up a mirror,
  or Import.

The setup has five steps, and nothing is written before the last one:
1. **Mode.** Mirror or Import once.
2. **Source.** The connection, the repository, its default branch and the folder. The server looks for the
   folder in this order: the folder you typed, `backlog_directory` in a root `backlog.config.yml`, then
   `backlog/`, then `.backlog/`.
3. **Mappings.** How Backlog.md statuses, priorities and assignees become values here (see below).
4. **Preview.** A dry run on the current head commit: how many tasks, drafts, archived tasks, subtasks and
   milestones the read creates, the first keys, the files it would skip and the values that fall back.
5. **Read.** Start mirroring (or Import N tasks). The first read runs in the worker. Tasks appear all at
   once when it finishes; nothing shows half-done.

Starting a mirror turns milestones on for the project. An import hands the tasks to Zamu right after its
first read, in the same job.

## Mappings

Each Backlog.md value maps to one value here. The setup fills them in by name, and you can change any row.
- **Statuses** match by name, ignoring case, spaces, dashes and underscores (`To Do` is Todo). Names that
  contain `review` map to In review, `progress` or `doing` to In progress, `done` or `complete` to Done,
  `cancel` or `won't` to Canceled, `backlog` or `icebox` to Backlog. Drafts always come in as Backlog.
- **Priorities**: `high`, `medium` and `low` map to High, Medium and Low. A task without a priority gets
  none.
- **Assignees** match `@name` or `name` against member names, agent names and the part of an email before
  the `@`. A task gets the first of its assignees that maps to a member; the others stay listed in its
  Backlog.md section.

A note under the Assignees table helps with the rows that map to no one. It works the same in the setup and
in Edit mappings:
- **Coding agents.** An assignee that names a coding agent (claude, codex, copilot, cursor, gemini and
  others, alone or in names like `claude-code`) gets a **Create agent** suggestion. It opens Add agent with
  the name filled in, you as the responsible human and a key for this project only. Once the agent exists,
  its key is shown once and the row maps to it.
- **Similar agents.** When an agent here shares a word with that name, the line offers it first:
  "@claude may be claude-dev." with **Map to claude-dev** next to **Create agent claude**. It lists up to
  three agents, newest first. They also appear in the row's select, under Create agent….
- **People to invite.** Any other assignee with no match gets "@francis matches no member." and
  **Invite…**, which opens Invite person with a line saying which value it is for. The invitation does not
  map anything: once the person joins, map the value in Settings > Backlog.md > Edit mappings. The line
  then reads "Invited {email}" until the page reloads.
- **Name matches.** In Edit mappings, a row that maps to no one but now matches exactly one member by name
  (someone who joined after the setup) gets "@tomas may be Tomás Berg." with **Map to Tomás Berg**. The
  match uses the same rule as the setup.

Any unmatched assignee also offers **Create agent…** at the top of its select.

A value with no mapping, including one that appears in a later push, gets the fallback (Todo, no priority,
no assignee) and a warning. To change the mappings later, open Settings > Backlog.md > Edit mappings. The
next refresh applies them to every task.

## What a mirror owns

| Object    | Comes from Backlog.md                                                                                                          | Editable here                                  |
| --------- | ------------------------------------------------------------------------------------------------------------------------------ | ---------------------------------------------- |
| Task      | Title, description, status, priority, assignee, milestone, creation date, labels, due date, blockers, parent task, work record | Cycle, order inside its board column, comments |
| Label     | Name, and creating or deleting labels                                                                                          | Colour                                         |
| Milestone | Name, description, target date, status, and creating or deleting milestones                                                    | Nothing                                        |
| Project   | Key (it has tasks), repository, and turning milestones off                                                                     | Name, description, cycles switch               |

In the web app, the task view shows one small Backlog.md badge, which links to the file. A field shows a lock
only when you point at it or try to change it, and the pickers open read-only. The board does not let a
mirrored card move to another column. New task is disabled and says that tasks are created in Backlog.md.
Changes to several tasks at once (the action bar, `POST /api/v1/tasks/bulk`) work in native projects only.
The API and `zamu` refuse the same changes with `409` and the codes `TASK_MIRRORED`, `MILESTONE_MIRRORED`,
`PROJECT_MIRRORED` or `LABEL_MIRRORED`, naming the field, the file and a `backlog` command that makes the
change.

The file's sections fill the task's work record, the same one agents write on native tasks (see
[agents.md](agents.md#the-work-record)):

| Section in the file  | Here                                                                |
| -------------------- | ------------------------------------------------------------------- |
| Description          | The description                                                     |
| Acceptance Criteria  | Acceptance criteria, numbered from 1 in file order, open or checked |
| Definition of Done   | Done items, in file order                                           |
| Implementation Plan  | The plan                                                            |
| Implementation Notes | One read-only block of notes from the file                          |
| Final Summary        | The final summary                                                   |
| Comments             | "Comments from Backlog.md" at the end of the description            |

The `#1` numbers written in the file are ignored: items are numbered by their order. Text between the
checklist items that is not an item stays in the description under its heading, so nothing in the file is
lost. Headings and checkboxes inside code blocks are part of the description. The whole work record is
read-only here, and work notes can't be added to a mirrored task: the API and `zamu` refuse with
`409 TASK_MIRRORED` and the `backlog task edit` command that makes the change, such as
`backlog task edit 12 --check-ac 2`. Agents write notes in the file with `--append-notes`.

Labels, the due date, dependencies and the parent task fill the task's own fields (see below). Everything
else in the file (extra assignees, type, references, documentation, modified files, reporter, the dates as
written in the file, unknown keys) is shown read-only in the collapsed "From the file" section at the bottom
of the task's properties.

## Labels, due dates, blockers and subtasks

Since 0.7.0 a mirror fills the same four fields as native tasks, so filters, the Blocked marker, overdue
dates and subtask progress work the same in both kinds of project. Every one of them is read-only here.

| Backlog.md key                                    | Field here | Rules                                                                                                                          |
| ------------------------------------------------- | ---------- | ------------------------------------------------------------------------------------------------------------------------------ |
| `labels`                                          | Labels     | Each name becomes a label of the project, matched ignoring case. Names over 40 characters are left out with a warning.         |
| `due_date`                                        | Due date   | `YYYY-MM-DD` only. Any other value leaves the task without a due date and is listed as a problem.                              |
| `dependencies`                                    | Blocked by | Backlog.md IDs of the same folder. An ID that matches no task, or the task itself, is left out and listed as a problem.        |
| `parent_task_id`, or the dotted ID (`BACK-786.1`) | Parent     | The parent's subtasks follow from it. Mirrored subtasks can nest as deep as the files do; native subtasks stay one level deep. |

Labels read from the files are marked "From Backlog.md" in Settings > Labels. Their names are locked: rename
or remove them in the files. Their colour belongs to the app, and changing it never writes to the files.

The task history shows changes to these fields as ordinary lines ("Backlog.md added the label webhooks"),
not under "Backlog.md-only fields changed".

### Upgrading from 0.8.0

Up to 0.8.0 a mirror wrote the Acceptance criteria, Definition of done, Implementation plan, Implementation
notes and Final summary sections into the task's description, under `##` headings. The 0.9.0 migration moves
them out of the description into the work record of every mirrored task, by the rules above. It writes no
history lines, and the next refresh reads the same values from the files, so it changes nothing for files
that did not change. Projects that were already imported or detached keep the moved items as their own, and
they become editable.

### Upgrading from 0.6.0

Before 0.7.0 these values sat only in the task's Backlog.md section. The 0.7.0 migrations copy them into the
native fields of every existing mirror, from the data the last refresh stored. The copy writes no history
lines, and the next refresh reads the same values from the files, so it changes nothing for files that did
not change. Imports that were already detached get their labels as app labels.

## Keys and subtasks

A mirrored task keeps its Backlog.md number. In a project with the key `PAY`:

| Backlog.md   | Key here                                                      |
| ------------ | ------------------------------------------------------------- |
| `BACK-786`   | `PAY-786`                                                     |
| `BACK-786.1` | `PAY-786.1`                                                   |
| `back-007`   | `PAY-7`                                                       |
| `DRAFT-14`   | the next number above the highest task, for example `PAY-787` |

Zero padding is dropped. Drafts have their own numbering in Backlog.md, so they get numbers above the
highest task number on the first read and keep them afterwards.

The Backlog.md ID works wherever a task key does, in URLs, the API and `zamu`, ignoring case:
`zamu tasks show BACK-786.1`. IDs such as `TASK-12` can repeat across projects; pass `--project` (or the API's
`project` parameter) when an ID alone is ambiguous.

## Refreshes

A refresh reads the default branch at its head commit, downloads only the files whose content changed, and
applies every change in one database transaction. A refresh starts when:
- the git host sends a push webhook for the default branch (see below);
- someone presses Refresh now in the project header's Backlog.md popover or in Settings > Backlog.md (⇧R);
- an agent runs `zamu backlog refresh`;
- the hourly check runs, at 15 minutes past each hour (UTC). It stops early when the head has not moved.

Webhook pushes within a minute of each other collapse into one refresh, so a burst of pushes costs one read.
Refresh now and `zamu backlog refresh` start right away, also when a webhook refresh is waiting for its slot:
they take its place. Open pages pick up a finished refresh the next time they load their data; reload the
page to see it at once.

The source has one of these states, shown in the project header:

| State                    | Meaning                                                                                         |
| ------------------------ | ----------------------------------------------------------------------------------------------- |
| Mirroring                | Every file was read and every value mapped.                                                     |
| Mirroring, with problems | Some files were skipped or read with a warning, or some values fell back.                       |
| Last refresh failed      | `config.yml` did not parse, or the read failed. Nothing was written; the last good state stays. |
| Paused                   | The connection is missing, rejected or unreachable, or `APP_ENCRYPTION_KEY` is missing.         |
| Detached                 | The project was switched to Zamu (or imported) and no longer reads the files.                   |

Settings > Backlog.md lists the problems of the last refresh, file by file. A task file that does not parse
is skipped and its task keeps its last good version (a new task appears once its file parses). When two files
carry the same ID, the one with the later `updated_date` wins and the other is listed as a problem.

A file matches its task by Backlog.md ID, not by path. Renaming a task, which renames its file, updates the
same task.

## Hidden tasks

When a task's file disappears from the default branch, the task is hidden, not deleted. It drops out of the
list, the board, Home and every count, and keeps its comments, cycle and board position. A task that it
blocked reads "Removed task" in its Blocked by list. Opening it by
URL shows "Removed from Backlog.md" with the commit where it was last seen.

To list hidden tasks, use the "Removed from Backlog.md" filter on the task list (`/p/PAY?hidden=only`), or
`GET /api/v1/tasks?project=PAY&hidden=only`. When a file with the same ID comes back, the task comes back with the same
key.

Archived tasks (`archive/tasks/`, and the old `completed/` folder) are not hidden: they come in with their
own status, usually Done.

## Webhooks

Without a webhook the mirror checks once an hour. With one, a push shows up within seconds. Owners and admins
open Settings > Backlog.md and press Setup next to Webhook (or Set up the webhook at the end of the setup).
The dialog shows the URL and the secret, with the steps for your provider. Its last line turns green when the
first notification arrives.

The git host must reach the URL, which is built from `PUBLIC_URL`:

```text
https://projects.example.com/api/webhooks/backlog/<id>
```

**GitLab.** Open the repository > Settings > Webhooks > Add new webhook. Paste the URL, and the secret into
Secret token. Under Trigger, tick Push events only, for the default branch. Save, then press Test > Push
events.

**GitHub.** Open the repository > Settings > Webhooks > Add webhook. Paste the URL into Payload URL, pick
`application/json` as the content type, and paste the secret into Secret. Keep "Just the push event". GitHub
sends a ping on save.

**Gitea / Forgejo.** Open the repository > Settings > Webhooks > Add webhook > Forgejo (or Gitea). Paste the
URL into Target URL, keep POST and `application/json`, and paste the secret into Secret. Under Trigger on,
pick Push events and set the branch filter to the default branch. Save, then open the webhook and press Test
delivery.

The server checks GitHub's `X-Hub-Signature-256`, GitLab's `X-Gitlab-Token`, and Gitea's or Forgejo's
signature header against the secret. A request with a wrong signature or an unknown ID gets `404`. Pushes to
other branches get `204` and change nothing. After the switch to Zamu the URL answers `410 Gone`; remove
the webhook at the host then. Once the project is deleted the URL answers `404`; remove the webhook at the
host too.

### New secret

Owners and admins can issue a new secret with **New secret** in the webhook dialog, for example when the old
one leaked or `APP_ENCRYPTION_KEY` changed and the dialog says the secret can't be read. The URL stays the
same. The old secret stops working at once: deliveries signed with it get `404` until you paste the new
secret into the webhook settings on the git host. The new secret is shown once, unmasked, right after you
confirm. Mirrors still refresh every hour in the meantime.

## Switch to Zamu

The switch makes Zamu the owner of a mirrored project's tasks. It replaces Detach, which earlier releases
had, and like Detach it cannot be undone. Owners and admins find it in Settings > Backlog.md > Switch to
Zamu.

The dialog first asks the git host for open pull or merge requests that change files in the Backlog.md
folder. Once the project switches, their task edits never arrive, so the dialog lists them: up to five, then
"35 more" with a link to the list on the host. It looks at the 100 newest open requests. "No open pull
request changes the task files. Nothing will be lost." means you can go ahead. Merge or close the listed
requests first, or redo their edits here afterwards. When the host can't be reached or refuses the token,
the dialog says so and offers Try again; the switch stays locked until the check works. Then type the project
key to confirm.

After the switch:
- every field of every task and milestone is editable here, by people and agents, and the work record too:
  criteria and done items keep their states;
- changes to the files no longer reach the project, and the webhook URL answers `410 Gone`;
- new tasks continue the numbering (after `PAY-812` comes `PAY-813`);
- labels from the files become app labels, which you can rename, recolour and delete;
- labels, due dates, blockers and parents keep their values and become editable;
- each task keeps its Backlog.md ID and its "From the file" section as a read-only record, and its ID still
  finds it;
- hidden tasks stay hidden.

Run `zamu agents` in the repository afterwards: it replaces the Backlog.md guidelines in `AGENTS.md` with a
line saying that tasks are in Zamu, so agents stop writing task files.

Afterwards Settings > Backlog.md shows "Owned by Zamu since" with the date, who switched the project, the
export command, and the repository the project is still linked to. The project header shows the state as
Detached.

An import is a mirror that switches to Zamu right after its first read, with no check.

## Export to Backlog.md

`zamu backlog export` writes a project owned by Zamu (native, imported or switched) as Backlog.md files, so
the repository can keep a readable copy, or so you can leave Zamu. Run it in a clone:

```sh
zamu backlog export --dry-run                     # list what would change, write nothing
zamu backlog export                               # backlog/ at the repository root
zamu backlog export --project PAY --dir docs/backlog
```

The files come from `GET /api/v1/projects/{project}/backlog/export`, which a read-only key can call. The
export targets the Backlog.md file format of release 1.57.

What it writes:
- every task that is not hidden, under `tasks/`, Done and Canceled ones included (Backlog.md keeps them there
  too), with the front matter Backlog.md reads: status, assignee, labels, milestone, dependencies, parent,
  priority, due date and the dates;
- the description, the acceptance criteria and the definition of done as checklists, the plan, the
  implementation notes and the final summary. The implementation notes hold the notes read from the file
  first, then the task's work notes, oldest first, each with its author and date;
- the reasons of waived items, in a block between `<!-- zamu:start -->` and `<!-- zamu:end -->` at the end of
  the file, since Backlog.md has no waived state. A mirror or import of the folder reads the block back;
- the milestones, under `milestones/`.

Task IDs use the switched mirror's own prefix (`PAY-142` stays `PAY-142`), or else the letters of the project
key, so a later import keeps every number.

What it removes: Markdown files under `tasks/`, `completed/` and `milestones/` that the export no longer has,
such as tasks deleted in Zamu or copies in the old `completed/` folder.

What it leaves alone: everything else in the folder, such as `config.yml`, documents, decisions, drafts and
files that aren't Markdown. The export refuses when `tasks/`, `completed/` or `milestones/` have uncommitted
changes, untracked files included; commit or discard them, or pass `--force`.

The export does not write `config.yml`. The `backlog` CLI lists no task without a `config.yml` whose
`task_prefix` matches the exported IDs (`task_prefix: "pay"` for `PAY-142`), so zamu warns when the file is
missing or its prefix differs. Create one with `backlog init`, or fix the prefix.

What is not exported: comments (only work notes), who waived an item, the state of completed milestones,
and cycles.

The copy is as fresh as the last export. Edits made to the exported files are not read back: run the export
again and commit the result whenever you want the copy to catch up. A project that still mirrors gets
`409 PROJECT_MIRRORED` (exit code 6 in zamu), since its files are the source.

## Delete a mirrored project

Owners and admins delete a project in its Settings > General > Delete this project, or with
`zamu projects delete PAY --confirm PAY`. It removes the tasks, comments, history, milestones, cycles and the
Backlog.md mirror; the files in the repository are untouched. There is no undo: a database backup is the
only way back. The webhook URL answers `404` afterwards, so remove the webhook on the git host.

## Agents in a mirrored project

Agents keep working in the files with the `backlog` CLI and push as usual, the work record included
(`backlog task edit 12 --check-ac 2 --append-notes "..."`). `zamu` reads the tasks, comments on them and sets
cycles. After the switch to Zamu they use `zamu` for everything, and `zamu instructions` tells them how. See
[agents.md](agents.md#backlogmd-mirrors).
