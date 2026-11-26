# REST API

The web app, the `zamu` CLI and your scripts use the same REST API at `/api/v1`. The server publishes the full
OpenAPI document at `GET /api/v1/openapi.json`; this page is an overview, with what each release since 0.7.0
added.

## Requests

Send an API key as a bearer token. People create keys in Settings > My keys, and agents get theirs from an
admin (see [agents.md](agents.md)):

```sh
curl -H "Authorization: Bearer $ZAMU_KEY" https://projects.example.com/api/v1/tasks?project=PAY
```

A key only reaches the projects in its scope, and a read-only key cannot write. The web app signs its
requests with the session cookie instead.

Two optional headers say where a request comes from: `x-zamu-machine` (a machine name) and `x-zamu-branch`
(a git branch). `zamu` sends both. The server trims them, keeps up to 100 characters, ignores values with
control characters, and stores them on the history entries and notes the request writes, which return them
as `source: { machine, branch }`.

Bodies are JSON. Query parameters that take several values repeat the name:
`?status=todo&status=in_progress`. Task keys and project keys ignore case, and a task key also accepts the
task's Backlog.md ID.

Errors are RFC 9457 problems with a stable `code`:

```json
{
  "type": "about:blank",
  "title": "Blockers would loop",
  "status": 409,
  "code": "DEPENDENCY_LOOP",
  "detail": "Can't add: PAY-150 already waits on PAY-142.",
  "requestId": "5b47feb0-08c1-4c5a-b79a-82c21b18286d",
  "loop": { "task": "PAY-142", "blocker": "PAY-150" }
}
```

Quote `requestId` when you report a problem.

## Workspaces

A server can hold several workspaces, and every request acts in one of them. Project and task keys are
unique within a workspace only: two workspaces can each have a project `PAY` and a task `PAY-1`.

The optional header `x-zamu-workspace: <slug>` names the workspace (0.10.0). A slug the workspace used
before still works, so a script keeps running after a rename.
- An API key always acts in the workspace it was created in. The header may name that workspace; naming
  another one is refused with `403 WORKSPACE_MISMATCH`, never a switch. `zamu` sends the header with every
  request, so a key used for the wrong login fails loudly.
- A session (the web app) acts in the workspace the header names. Without the header it acts in the
  workspace the person used last, else in their oldest one. A person who is not a member of the named
  workspace, or of any workspace, gets `403 NOT_A_MEMBER`. An unknown slug gets the same answer.

`GET /me` returns the workspace as `{ id, name, slug }`. There are no routes to create, rename or delete
workspaces; that happens in the web app.

| Code                 | Status | When                                                                      |
| -------------------- | ------ | ------------------------------------------------------------------------- |
| `UNAUTHORIZED`       | 401    | No session or key, or the key is invalid, disabled or expired.            |
| `NOT_A_MEMBER`       | 403    | A session whose person is not a member of the workspace the header names. |
| `WORKSPACE_MISMATCH` | 403    | An API key sent with a header that names a workspace other than its own.  |

## Tasks

| Method and path             | What it does                                                      |
| --------------------------- | ----------------------------------------------------------------- |
| `GET /tasks`                | List tasks of one or more projects, or of every readable project. |
| `GET /tasks/{key}`          | Get one task with its labels, parent, subtasks and blockers.      |
| `POST /tasks`               | Create a task.                                                    |
| `PATCH /tasks/{key}`        | Change a task. Send only the fields to change.                    |
| `POST /tasks/bulk`          | Change up to 100 tasks at once (0.7.0).                           |
| `GET /tasks/{key}/timeline` | Activity, comments and notes, oldest first.                       |
| `GET /tasks/{key}/comments` | Comments and notes. `POST` adds one.                              |
| `POST /tasks/archive`       | Archive up to 100 tasks, all or nothing.                          |
| `POST /tasks/restore`       | Restore up to 100 archived tasks, all or nothing.                 |

### Fields added in 0.7.0

A task now has:
- `labels`: `[{ id, name, color, source }]`. `color` is 1 to 9; `source` is `app`, or `backlog` for labels
  read from Backlog.md files.
- `dueDate`: `YYYY-MM-DD` or null.
- `parent`: `{ key, title, status, assignee }` or null; `subtasks`, and `subtaskProgress: { done, total }`
  with canceled subtasks left out.
- `blockedBy` and `blocks`: tasks of the same project. An entry is `null` when that task is hidden or you
  can't read it (the app shows "Removed task").
- `blocked`: true while any blocker is open.

List rows (`GET /tasks`) carry `labels`, `dueDate`, `blocked`, `subtaskProgress` and `parentKey`.

`POST /tasks` takes `labels` (names; the project creates the ones it doesn't have), `dueDate`, `parent` (a
task key; the new subtask takes the parent's assignee unless you send one) and `blockedBy` (task keys).

`PATCH /tasks/{key}` takes:
- `labels` to replace every label, or `addLabels` and `removeLabels` to change some, by name;
- `dueDate`, null to clear it;
- `parent`, null to make the task top level again;
- `addBlockers` and `removeBlockers`, task keys.

The rules:

| Code               | Status | When                                                                                                              |
| ------------------ | ------ | ----------------------------------------------------------------------------------------------------------------- |
| `DEPENDENCY_LOOP`  | 409    | A blocker would close a loop. `loop` names the two tasks.                                                         |
| `SUBTASK_DEPTH`    | 409    | The parent is a subtask, or the task already has subtasks: one level only.                                        |
| `NOT_SAME_PROJECT` | 422    | A parent or blocker from another project.                                                                         |
| `TASK_MIRRORED`    | 409    | The field comes from Backlog.md. `field` names it: `labels`, `dueDate`, `blockedBy`, `parent`, and the M3 fields. |

### The work record (0.9.0)

A task now has:
- `criteria` and `doneItems`: `[{ number, text, state, waivedReason, waivedBy, locked }]`. `number` counts
  from 1 in list order. `state` is `open`, `checked` or `waived`; a waived item has its `waivedReason` and
  `waivedBy` (null when the waiver came from a Backlog.md file). `locked` is true on tasks mirrored from
  Backlog.md.
- `plan` and `finalSummary`: Markdown or null. `planMeta` and `finalSummaryMeta` are
  `{ author, onBehalfOf, origin, at }`: who last wrote it and when, from the history.

List rows carry `criteriaProgress` and `doneProgress`, each `{ settled, open, waived, total }` (settled counts
checked and waived items), and `hasFinalSummary`.

`POST /tasks` takes `criteria` and `doneItems` (lists of texts), `plan`, and `skipDefaultDoneItems`. A new task
starts with the project's default done items, then the `doneItems` you send; a default you send again is not
added twice. `skipDefaultDoneItems: true` leaves the defaults out.

`PATCH /tasks/{key}` takes eight operations per list, named after it (`Criteria` or `DoneItems`):

| Field                              | Value                                                   |
| ---------------------------------- | ------------------------------------------------------- |
| `addCriteria`, `addDoneItems`      | Texts, added at the end in order.                       |
| `checkCriteria`, `uncheckCriteria` | Item numbers. Checking a waived item clears its waiver. |
| `waiveCriteria`                    | `[{ number, reason }]`. The reason is required.         |
| `unwaiveCriteria`                  | Item numbers. The item is open again.                   |
| `editCriteria`                     | `[{ number, text }]`.                                   |
| `moveCriteria`                     | `[{ from, to }]`.                                       |
| `removeCriteria`                   | Item numbers. The items after them move up.             |

The same eight exist for done items (`checkDoneItems`, `waiveDoneItems` and so on). Numbers refer to the
list as it was before the request. One request applies the edits, checks, unchecks, waives and unwaives
first, then the removals, then the moves, then the additions, and writes one history line per operation with
the item's number and text. `plan` and `finalSummary` set the text; null or `""` clears it. Items are one
line, up to 500 characters, at most 50 per list; the plan and the summary take up to 50,000 characters.

`ifStatus` is a precondition: when the task's stored status differs, the server answers `409 TASK_CHANGED`
with the current task and writes nothing. The CLI's offline queue sends it with a queued status change.

`POST /tasks/{key}/comments` takes `kind`: `comment` (the default) or `note`. Notes are work notes: they show
under the Notes filter and notify only the people they mention. `GET /tasks/{key}/timeline` takes `show`
(`all`, `comments`, `notes` or `history`) to narrow the items, and always returns `counts` with the size of
each of the four.

`PATCH /projects/{project}` takes `defaultDoneItems`, the list every new task starts with (owners and admins
only). Tasks that exist keep their items. Projects return it as `defaultDoneItems`.

The rules:

| Code            | Status | When                                                                                          |
| --------------- | ------ | --------------------------------------------------------------------------------------------- |
| `OPEN_ITEMS`    | 409    | An agent moves a task to In review or Done while a criterion or done item is open. See below. |
| `TASK_CHANGED`  | 409    | `ifStatus` (or `ifUpdatedAt`) differs from the stored task. The body holds the current task.  |
| `TASK_MIRRORED` | 409    | Writing the work record of a mirrored task, or a note on it. `field` names what.              |

For `TASK_MIRRORED`, `field` is `criteria`, `doneItems`, `plan`, `finalSummary` or `notes`.

`OPEN_ITEMS` is checked after the request's own operations, so one request that settles the last items and
moves the task goes through. A person's request is never refused. In a bulk change (`POST /tasks/bulk`), one
refused task fails the whole request. The problem lists the open items, criteria first:

```json
{
  "type": "about:blank",
  "title": "Task has open items",
  "status": 409,
  "code": "OPEN_ITEMS",
  "detail": "PAY-142 has open items: criterion 6. Check or waive them before moving it to In review.",
  "requestId": "0b5e1f9e-7a43-4c1e-9d2b-6f0d1c0a2b77",
  "openItems": [
    { "kind": "criterion", "number": 6, "text": "The on-call runbook has an entry for exhausted retries" }
  ]
}
```

### Pull requests, archive and check-again days

A task now has:
- `workBranch`: the git branch the task was started from with `zamu`, or null (see below);
- `pullRequests`: `[{ provider, number, title, url, state, headBranch, baseBranch, author, mergedBy, how,
  linkedBy, linkedAt, openedAt, mergedAt, closedAt, updatedAt }]`. `state` is `open`, `draft`, `merged` or
  `closed`; `how` is `branch`, `description` or `hand`; `provider` is `github`, `gitlab` or `gitea`;
- `checkAgain`: `{ on, reason }` or null. `on` is a day, `YYYY-MM-DD`;
- `closedAt`: when the task last entered Done or Canceled, null while it is open;
- `archivedAt` and `archivedBy`: null unless archived. `archivedBy` is null when the nightly job or a
  Backlog.md refresh archived it;
- `mergedOpen`: `{ at, openCriteria, openDoneItems }` while a merge closed the task with items still open,
  else null.

List rows carry `checkAgain`, `archivedAt`, `pullRequest` (the newest request, with its `state`) and
`pullRequestCount`.

History entries that no person or agent made have `actor: null` and carry `system`: `{ kind: "git",
provider }` for a request event, `{ kind: "zamu" }` for Zamu's own jobs (the nightly archive, cycle ends) or
`{ kind: "backlog" }`. `cause` says why: `{ kind: "pull_request", provider, number, url, title, event, by }`
with `event` `opened`, `ready`, `reopened`, `merged` or `closed`, or `{ kind: "archive", afterDays }`. New
entry types: `task.archived`, `task.unarchived`, `task.pull_request_linked` and
`task.pull_request_unlinked`.

The work branch comes from the `x-zamu-branch` header: a write with an API key that sets the status to In
progress or In review records it, unless it is the repository's default branch (`main` or `master` while
Zamu has not read it). Sessions never record one. Open requests Zamu knows for that branch link at once.

`PATCH /tasks/{key}` takes `checkAgain: { on, reason }` (both required; the reason is 1 to 200 characters,
and any day works, past days included) or `checkAgain: null` to clear it. `POST /tasks` takes it too. A move
to Done or Canceled clears it.

| Method and path                              | What it does                                                         |
| -------------------------------------------- | -------------------------------------------------------------------- |
| `POST /tasks/{key}/pull-requests`            | Link a request by hand: `{ url, dryRun? }`. Returns the link.        |
| `DELETE /tasks/{key}/pull-requests/{n}`      | Unlink request `n` (`204`). It stays off until linked by hand again. |
| `POST /tasks/archive`, `POST /tasks/restore` | `{ keys }`, up to 100. Returns `{ items }` in the order sent.        |

`POST /tasks/{key}/pull-requests` reads the request from the host through the project's repository link.
With `dryRun: true` it returns the request as it would link and writes nothing. Otherwise it links it and
applies it like a webhook event, so linking an open request moves the task to In review and a merged one to
Done when the project closes on merge. A project without a repository gets `409 CONFLICT`.

`POST /tasks/archive` archives tasks in any status; anyone who may write the task may, agents included.
Restoring a Done or Canceled task sets `closedAt` to now, so the project's archive days count from the
restore. Both refuse tasks of a mirrored project with `409 TASK_MIRRORED`: there, Backlog.md's
`archive/tasks/` folder decides. An archived task refuses every other write, comments and notes included.

The rules:

| Code                       | Status | When                                                                            |
| -------------------------- | ------ | ------------------------------------------------------------------------------- |
| `TASK_ARCHIVED`            | 409    | A write to an archived task other than restore. Restore it first.               |
| `REQUEST_OTHER_REPOSITORY` | 422    | A request address of another repository. `repository` names the project's one.  |
| `NOT_A_REQUEST`            | 422    | An address that is not a pull or merge request.                                 |
| `REQUEST_NOT_FOUND`        | 404    | The host has no such request, or (`DELETE`) the task does not link that number. |
| `TASK_MIRRORED`            | 409    | Archiving or restoring a task of a mirrored project.                            |

### List filters and sort

`GET /tasks` takes these parameters besides `project`, `status`, `priority`, `q`, `limit` and `cursor`:

| Parameter    | Values                                                                                      |
| ------------ | ------------------------------------------------------------------------------------------- |
| `assignee`   | `me`, `agents`, `none` or user ids; repeat for any of several (0.7.0).                      |
| `milestone`  | Milestone ids or `none`; repeat for any of several (0.7.0).                                 |
| `cycle`      | A number, `current`, `next` or `none`; repeat for any of several (0.7.0).                   |
| `label`      | Label ids; a task matches when it has any of them.                                          |
| `due`        | `overdue` (open, due before today), `soon` (open, due today or in 2 days), `set`, `none`.   |
| `blocked`    | `true` for tasks with an open blocker, `false` for the others.                              |
| `topLevel`   | `true` leaves subtasks out.                                                                 |
| `parent`     | A task key: only its subtasks.                                                              |
| `sort`       | `priority`, `due` (soonest first, none last), `updated`, `created`, `manual` (board order). |
| `hidden`     | `only` for tasks removed from Backlog.md, `include` for every task.                         |
| `archived`   | `exclude` (the default) leaves archived tasks out, `include` adds them, `only` lists them.  |
| `checkAgain` | `waiting` (the day is after today), `ready` (today or earlier), `set`, `none`.              |

Without `sort`, `order=list` (the default) groups by status, then priority, then last update, and
`order=board` by status, then board rank. "Today" is the server's day in `APP_TIME_ZONE`.

### Bulk changes

`POST /tasks/bulk` changes up to 100 tasks of native projects in one transaction, with one history line per
task that changed. Send the keys and one change:

```json
{ "keys": ["PAY-140", "PAY-141"], "status": "in_review", "addLabels": ["release"] }
```

It takes `status`, `priority`, `assignee`, `milestone`, `cycle`, `dueDate`, `addLabels` and `removeLabels`
(null clears assignee, milestone, cycle and due date). It returns `{ items }`, the tasks in the order you
sent them. A mirrored task fails the whole request with `409 TASK_MIRRORED`. Milestone and cycle need every
task in one project (`422 NOT_SAME_PROJECT`).

## Repositories

| Method and path                                      | What it does                                                    |
| ---------------------------------------------------- | --------------------------------------------------------------- |
| `GET /projects/{project}/repository`                 | The repository settings. Anyone who reads the project.          |
| `PATCH /projects/{project}/repository`               | `{ connectionId?, closeOnMerge? }`. Owners and admins.          |
| `POST /projects/{project}/repository/webhook-secret` | A new webhook secret: `{ url, secret }`, returned once.         |
| `POST /projects/{project}/repository/sync`           | Queue the hourly check now (`202`). Owners and admins.          |
| `GET /projects/{project}/archive-preview?days=N`     | `{ project, days, count }`: what the nightly run would archive. |

The settings are `{ project, repository, provider, connection, defaultBranch, closeOnMerge, mirrored, webhook:
{ url, secretSet, lastAt, lastStatus, coveredByBacklog }, sync: { lastAt, error, nextAt }, canEdit }`.
`webhook` is null when the project has no repository. The secret itself is never returned after
`webhook-secret`. `connectionId` takes a connection for the repository's host (`422` for another host) or null
to read the repository without a token; a change queues a check. `closeOnMerge` on a mirrored project gets
`409 PROJECT_MIRRORED`. A project without a repository gets `409 CONFLICT` from `sync`.

`PATCH /projects/{project}` takes `archiveAfterDays`, 1 to 365, or null to turn the nightly archive off
(owners and admins; `409 PROJECT_MIRRORED` for a mirrored project). Projects return it as
`archiveAfterDays`; new projects start at 14. The preview counts with the same rule as the job: Done and
Canceled tasks closed more than `days` days ago in `APP_TIME_ZONE`, without the ones a merge closed with
items open. A mirrored project counts 0.

### Webhook

Git hosts post request events to a URL outside `/api/v1`, one per project:

```text
POST {PUBLIC_URL}/api/webhooks/repository/{webhookId}
```

It answers with a bare status: `202` for a request event (queued), `200` for a ping, another event or a
signed payload it can't read, `401` for a missing or wrong signature, `404` for an unknown id, `410` when
the project no longer has a repository, `413` over 25 MB. The Backlog.md webhook of a mirrored project
(`/api/webhooks/backlog/{id}`) takes request events too and answers `202` for them. Setup per host is in
[repositories.md](repositories.md#webhooks).

## Backlog.md export

| Method and path                          | What it does                                                        |
| ---------------------------------------- | ------------------------------------------------------------------- |
| `GET /projects/{project}/backlog/export` | The project as Backlog.md files, for `zamu backlog export` (0.9.0). |

It returns `{ project, format, generatedAt, files: [{ path, content }], removedPrefixes }`. Paths are relative
to the Backlog.md folder: every task that is not hidden under `tasks/`, archived tasks under
`archive/tasks/`, milestones under `milestones/`. `format` names the Backlog.md file format the files
target. `removedPrefixes` is `tasks/`, `archive/tasks/`, `completed/` and `milestones/`: Markdown files
there that are not in `files` are stale. A read-only key can call it. A project
that still mirrors Backlog.md gets `409 PROJECT_MIRRORED`. See
[backlog-md.md](backlog-md.md#export-to-backlogmd).

## Labels

| Method and path                          | What it does                                                                      |
| ---------------------------------------- | --------------------------------------------------------------------------------- |
| `GET /projects/{project}/labels`         | The project's labels by name, each with `usageCount`.                             |
| `POST /projects/{project}/labels`        | Create one: `{ name, color? }`. Without `color` the app picks the least used one. |
| `PATCH /projects/{project}/labels/{id}`  | Rename or recolour: `{ name?, color? }`.                                          |
| `DELETE /projects/{project}/labels/{id}` | Delete it and take it off every task (`204`).                                     |

Names are unique in the project, ignoring case (`409 LABEL_EXISTS`), and up to 40 characters. Renames and
deletes write no history: a task's history keeps the name it recorded. Labels read from Backlog.md files
(`source: "backlog"`) keep their name: renaming or deleting one fails with `409 LABEL_MIRRORED`, and their
colour still changes.

## Home

| Method and path    | What it does                                                                             |
| ------------------ | ---------------------------------------------------------------------------------------- |
| `GET /home`        | Home: groups of tasks, the deadlines strip and the agent cards.                          |
| `GET /home/counts` | The sidebar count: review, mergedOpen, checkAgain, mentions, blocked, overdue and total. |

`GET /home` takes `tab` (`mine`, the default, `everyone` or `agents`) and the filters `project` (keys),
`label` (names, merged across projects) and `priority`. It returns:
- `counts`: the number of items on each tab;
- `groups`, in order. Mine has `review`, `mergedOpen`, `checkAgain`, `mentions`, `blocked`, `overdue` and
  `assigned`; Everyone has `review`, `mergedOpen`, `blocked`, `overdue` and `dueThisWeek`; Agents has
  `waiting`. `mergedOpen` holds Done tasks a merge closed with items open; `checkAgain` your open tasks whose
  check-again day has come. Archived tasks are never on Home. Each group has `total` and up to 50
  `items`: `{ task, reason, relation, pills }`. A task shows once, in its first group;
- `deadlines`: milestones and cycles that end within 2 days, and tasks due within 2 days or overdue (empty on
  Agents);
- `agents`: on the Agents tab, one card per agent: working or idle, its current task, its counts for today
  and its last five actions.

`GET /dashboard` and `GET /dashboard/counts` stay for `zamu dashboard` and scripts written for 0.6.0. The web
app no longer uses them.
