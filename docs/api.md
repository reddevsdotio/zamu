# REST API

This page is for people who call Zamu from a script or their own client. The web app and the `zamu` CLI use
the same REST API, at `/api/v1`.

The page covers authentication, workspaces, errors and the main routes with their fields. For every route
and schema, read the OpenAPI document the server publishes at `GET /api/v1/openapi.json`.

Where the page names a version, such as (0.7.0), that release added the route or field. Check it when your
server is older.

## Your first request

You need the server's address and an API key. This request asks who the key belongs to:

```sh
curl -H "Authorization: Bearer $ZAMU_KEY" https://projects.example.com/api/v1/me
```

The answer names the user, the workspace the key acts in, the role there and the key's scope:

```json
{
  "user": {
    "id": "0197a3f0-6c1e-7d42-9b5a-2f4c8e1d7a10",
    "name": "claude-dev",
    "email": null,
    "kind": "agent",
    "responsible": { "id": "0197a3ee-91b4-7c08-8a3d-5e6f7a8b9c0d", "name": "Ana Ruiz", "kind": "person" },
    "theme": "system"
  },
  "workspace": { "id": "0197a3ee-8f02-7e11-b6c4-1a2b3c4d5e6f", "name": "Acme", "slug": "acme" },
  "role": "member",
  "auth": { "method": "api_key", "scope": { "projects": "all", "access": "write" } }
}
```

The same key lists the tasks of the project `PAY`:

```sh
curl -H "Authorization: Bearer $ZAMU_KEY" "https://projects.example.com/api/v1/tasks?project=PAY"
```

## Authentication

Send an API key as a bearer token, as in the requests above. People create keys in Settings > Your API keys.
Agents get theirs from an admin, as [agents.md](agents.md) describes.
- A key only reaches the projects in its scope.
- A read-only key cannot write.
- The web app signs its requests with the session cookie instead of a key.

## Request format

The paths on this page leave out the `/api/v1` prefix.
- Bodies are JSON.
- A query parameter that takes several values repeats its name: `?status=todo&status=in_progress`.
- Task keys and project keys ignore case.
- A task key also accepts the task's Backlog.md ID.

### Where a request comes from

Two optional headers say where a request comes from: `x-zamu-machine` (a machine name) and `x-zamu-branch`
(a git branch). `zamu` sends both.

The server stores them on the history entries and notes the request writes. Those entries return them as
`source: { machine, branch }`.

The server trims each value and keeps up to 100 characters. It ignores a value with control characters.

## Errors

An error answer is an RFC 9457 problem, a JSON body with a stable `code` your script can test:

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

Quote `requestId` when you report a problem. The sections below list the codes their routes return.

## Workspaces

A **workspace** has its own projects, members, agents and keys. A server can hold several workspaces, and
every request acts in one of them.

Project and task keys are unique within a workspace only. Two workspaces can each have a project `PAY` and a
task `PAY-1`.

To name the workspace, send the optional header `x-zamu-workspace: <slug>` (0.10.0). A slug the workspace
used before still works, so a script keeps running after a rename.

What the header does depends on how the request signs in.

With an API key:
- The key always acts in the workspace it was created in.
- The header may name that workspace. A header that names another one gets `403 WORKSPACE_MISMATCH`. The
  server never switches workspace for a key.
- `zamu` sends the header with every request, so a key used for the wrong login fails loudly.

With a session (the web app):
- The session acts in the workspace the header names.
- Without the header it acts in the workspace the person used last, else in their oldest one.
- A person who is not a member of the named workspace, or of any workspace, gets `403 NOT_A_MEMBER`. An
  unknown slug gets the same answer.

`GET /me` returns the workspace as `{ id, name, slug }`. The API has no routes to create, rename or delete
workspaces. You do that in the web app.

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

Several refusals below mention a mirror. A **mirrored** project reads its tasks from the
[Backlog.md](backlog-md.md) files in a repository, and Zamu refuses writes to the fields those files own.

### Labels, due dates, subtasks and blockers

Added in 0.7.0. A **blocker** is a task that another task waits on.

A task has these fields:

| Field                 | Value                                                                                                                      |
| --------------------- | -------------------------------------------------------------------------------------------------------------------------- |
| `labels`              | `[{ id, name, color, source }]`. `color` is 1 to 9. `source` is `app`, or `backlog` for labels read from Backlog.md files. |
| `dueDate`             | `YYYY-MM-DD` or null.                                                                                                      |
| `parent`              | `{ key, title, status, assignee }` or null.                                                                                |
| `subtasks`            | The task's subtasks.                                                                                                       |
| `subtaskProgress`     | `{ done, total }`, with canceled subtasks left out.                                                                        |
| `blockedBy`, `blocks` | Tasks of the same project. An entry is `null` when that task is hidden or you can't read it. The app shows "Removed task". |
| `blocked`             | True while any blocker is open.                                                                                            |

List rows (`GET /tasks`) carry `labels`, `dueDate`, `blocked`, `subtaskProgress` and `parentKey`.

`POST /tasks` takes:

| Field       | Value                                                                        |
| ----------- | ---------------------------------------------------------------------------- |
| `labels`    | Label names. The project creates the ones it doesn't have.                   |
| `dueDate`   | The due date.                                                                |
| `parent`    | A task key. The new subtask takes the parent's assignee unless you send one. |
| `blockedBy` | Task keys.                                                                   |

`PATCH /tasks/{key}` takes:

| Field                           | Value                                              |
| ------------------------------- | -------------------------------------------------- |
| `labels`                        | Label names. They replace every label on the task. |
| `addLabels`, `removeLabels`     | Label names. They change some labels.              |
| `dueDate`                       | The due date. Null clears it.                      |
| `parent`                        | A task key. Null makes the task top level again.   |
| `addBlockers`, `removeBlockers` | Task keys.                                         |

The server refuses these changes:

| Code               | Status | When                                                                       |
| ------------------ | ------ | -------------------------------------------------------------------------- |
| `DEPENDENCY_LOOP`  | 409    | A blocker would close a loop. `loop` names the two tasks.                  |
| `SUBTASK_DEPTH`    | 409    | The parent is a subtask, or the task already has subtasks: one level only. |
| `NOT_SAME_PROJECT` | 422    | A parent or blocker from another project.                                  |
| `TASK_MIRRORED`    | 409    | The field comes from Backlog.md. `field` names it.                         |

For `TASK_MIRRORED`, `field` is `labels`, `dueDate`, `blockedBy` or `parent`. It can also be one of the
fields a mirror owned before 0.7.0: `title`, `description`, `status`, `priority`, `assignee` or `milestone`.

### The work record

Added in 0.9.0. The **work record** is what a person or an agent writes on a task while working on it:
acceptance criteria, a definition of done, a plan, work notes and a final summary.

A task has these fields:

| Field                          | Value                                                                               |
| ------------------------------ | ----------------------------------------------------------------------------------- |
| `criteria`, `doneItems`        | `[{ number, text, state, waivedReason, waivedBy, locked }]`.                        |
| `plan`, `finalSummary`         | Markdown or null.                                                                   |
| `planMeta`, `finalSummaryMeta` | `{ author, onBehalfOf, origin, at }`: who last wrote it and when, from the history. |

Each criterion and done item has:
- `number`, which counts from 1 in list order.
- `state`, which is `open`, `checked` or `waived`.
- `waivedReason` and `waivedBy` on a waived item. `waivedBy` is null when the waiver came from a Backlog.md
  file.
- `locked`, which is true on tasks mirrored from Backlog.md.

List rows carry `criteriaProgress` and `doneProgress`, each `{ settled, open, waived, total }`, and
`hasFinalSummary`. `settled` counts checked and waived items.

#### Start a task with a work record

`POST /tasks` takes `criteria` and `doneItems` (lists of texts), `plan`, and `skipDefaultDoneItems`.

A new task starts with the project's default done items, then the `doneItems` you send. A default you send
again is not added twice. `skipDefaultDoneItems: true` leaves the defaults out.

`PATCH /projects/{project}` takes `defaultDoneItems`, the list every new task starts with. Only owners and
admins may set it. Tasks that exist keep their items. Projects return it as `defaultDoneItems`.

#### Change criteria and done items

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

The same eight exist for done items (`checkDoneItems`, `waiveDoneItems` and so on).

Numbers refer to the list as it was before the request. One request applies its operations in this order:
1. Edits, checks, unchecks, waives and unwaives.
2. Removals.
3. Moves.
4. Additions.

The server writes one history line per operation, with the item's number and text.

`plan` and `finalSummary` set the text. Null or `""` clears it.

The limits:
- An item is one line, up to 500 characters.
- A list holds at most 50 items.
- The plan and the summary take up to 50,000 characters each.

#### Notes and the timeline

`POST /tasks/{key}/comments` takes `kind`: `comment` (the default) or `note`. Notes are work notes. They
show under the Notes filter and notify only the people they mention.

`GET /tasks/{key}/timeline` takes `show` (`all`, `comments`, `notes` or `history`) to narrow the items. It
always returns `counts` with the size of each of the four.

#### Guard against a stale status

`ifStatus` on `PATCH /tasks/{key}` is a precondition. Send the status you last saw. When the task's stored
status differs, the server answers `409 TASK_CHANGED` with the current task and writes nothing. The CLI's
offline queue sends it with a queued status change.

`ifUpdatedAt` works the same way with the `updatedAt` you last saw. The server refuses the change when the
stored task is newer.

#### Work record refusals

| Code            | Status | When                                                                                          |
| --------------- | ------ | --------------------------------------------------------------------------------------------- |
| `OPEN_ITEMS`    | 409    | An agent moves a task to In review or Done while a criterion or done item is open. See below. |
| `TASK_CHANGED`  | 409    | `ifStatus` (or `ifUpdatedAt`) differs from the stored task. The body holds the current task.  |
| `TASK_MIRRORED` | 409    | Writing the work record of a mirrored task, or a note on it. `field` names what.              |

For `TASK_MIRRORED`, `field` is `criteria`, `doneItems`, `plan`, `finalSummary` or `notes`.

`OPEN_ITEMS` applies to agents only. A person's request is never refused.
- The server checks it after the request's own operations. One request that settles the last items and
  moves the task goes through.
- The problem lists the open items, criteria first:

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

Added in 0.11.0. This page says **request** for a pull request or a merge request. A **check-again day** is
a day you set on a task that waits, with the reason.

A task has these fields:

| Field                      | Value                                                                                                 |
| -------------------------- | ----------------------------------------------------------------------------------------------------- |
| `workBranch`               | The git branch the task was started from with `zamu`, or null.                                        |
| `pullRequests`             | A list of linked requests. The fields of an entry follow this table.                                  |
| `checkAgain`               | `{ on, reason }` or null. `on` is a day, `YYYY-MM-DD`.                                                |
| `closedAt`                 | When the task last entered Done or Canceled. Null while it is open.                                   |
| `archivedAt`, `archivedBy` | Null unless archived. `archivedBy` is null when the nightly job or a Backlog.md refresh archived it.  |
| `mergedOpen`               | `{ at, openCriteria, openDoneItems }` while a merge closed the task with items still open, else null. |

An entry of `pullRequests` is:

```text
{ provider, number, title, url, state, headBranch, baseBranch, author, mergedBy, how,
  linkedBy, linkedAt, openedAt, mergedAt, closedAt, updatedAt }
```

- `state` is `open`, `draft`, `merged` or `closed`.
- `how` is `branch`, `description` or `hand`.
- `provider` is `github`, `gitlab` or `gitea`.

List rows carry `checkAgain`, `archivedAt`, `pullRequest` (the newest request, with its `state`) and
`pullRequestCount`.

The routes:

| Method and path                              | What it does                                                         |
| -------------------------------------------- | -------------------------------------------------------------------- |
| `POST /tasks/{key}/pull-requests`            | Link a request by hand: `{ url, dryRun? }`. Returns the link.        |
| `DELETE /tasks/{key}/pull-requests/{n}`      | Unlink request `n` (`204`). It stays off until linked by hand again. |
| `POST /tasks/archive`, `POST /tasks/restore` | `{ keys }`, up to 100. Returns `{ items }` in the order sent.        |

#### The work branch

The work branch comes from the `x-zamu-branch` header. A write with an API key that sets the status to In
progress or In review records it. Open requests Zamu knows for that branch link at once.

Two cases record nothing:
- The branch is the repository's default branch. While Zamu has not read the default branch, that means
  `main` or `master`.
- The request comes from a session. Sessions never record a work branch.

#### Link a request by hand

`POST /tasks/{key}/pull-requests` works in two steps:
1. It reads the request from the host through the project's repository link.
2. It links the request and applies it like a webhook event. Linking an open request moves the task to In
   review. Linking a merged one moves it to Done when the project closes on merge.

With `dryRun: true` it does step 1 only. It returns the request as it would link and writes nothing.

A project without a repository gets `409 CONFLICT`.

#### Check-again days

`PATCH /tasks/{key}` takes `checkAgain: { on, reason }`, and `POST /tasks` takes it too.
- Both fields are required. The reason is 1 to 200 characters.
- Any day works, past days included.
- `checkAgain: null` clears it. A move to Done or Canceled clears it too.

#### Archive and restore

`POST /tasks/archive` archives tasks in any status. Anyone who may write the task may archive it, agents
included.

Restoring a Done or Canceled task sets `closedAt` to now, so the project's archive days count from the
restore. [The nightly archive](#the-nightly-archive) has the setting.

An archived task refuses every other write, comments and notes included.

Both routes refuse tasks of a mirrored project with `409 TASK_MIRRORED`. There, Backlog.md's
`archive/tasks/` folder decides.

#### History entries with no actor

On a history entry, `actor` is the person or agent who made the change. Entries that no person or agent made
have `actor: null` and carry `system`:

| `system`                    | What made the change                               |
| --------------------------- | -------------------------------------------------- |
| `{ kind: "git", provider }` | A request event.                                   |
| `{ kind: "zamu" }`          | Zamu's own jobs (the nightly archive, cycle ends). |
| `{ kind: "backlog" }`       | A Backlog.md refresh.                              |

`cause` says why:
- `{ kind: "pull_request", provider, number, url, title, event, by }`, where `event` is `opened`, `ready`,
  `reopened`, `merged` or `closed`.
- `{ kind: "archive", afterDays }`.

History has four entry types for these changes: `task.archived`, `task.unarchived`,
`task.pull_request_linked` and `task.pull_request_unlinked`.

#### Request and archive refusals

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

Without `sort`, the `order` parameter decides:
- `order=list` (the default) groups by status, then priority, then last update.
- `order=board` groups by status, then board rank.

"Today" is the server's day in `APP_TIME_ZONE`.

The answer is `{ items, nextCursor, counts }`. Send `nextCursor` as `cursor` to get the next page. It is
null on the last page.

### Bulk changes

`POST /tasks/bulk` applies one change to up to 100 tasks of native projects, which are the projects that do
not mirror Backlog.md. It runs in one transaction and writes one history line per task that changed.

Send the keys and one change:

```json
{ "keys": ["PAY-140", "PAY-141"], "status": "in_review", "addLabels": ["release"] }
```

It takes `status`, `priority`, `assignee`, `milestone`, `cycle`, `dueDate`, `addLabels` and `removeLabels`.
Null clears assignee, milestone, cycle and due date.

It returns `{ items }`, the tasks in the order you sent them.

These cases fail the whole request:
- A mirrored task, with `409 TASK_MIRRORED`.
- A milestone or cycle change when the tasks are not all in one project, with `422 NOT_SAME_PROJECT`.
- An agent's move to In review or Done while one of the tasks has open items, with `409 OPEN_ITEMS`.

## Repositories

These routes read and change a project's repository settings. [repositories.md](repositories.md) explains
how a repository links to a project.

| Method and path                                      | What it does                                            |
| ---------------------------------------------------- | ------------------------------------------------------- |
| `GET /projects/{project}/repository`                 | The repository settings. Anyone who reads the project.  |
| `PATCH /projects/{project}/repository`               | `{ connectionId?, closeOnMerge? }`. Owners and admins.  |
| `POST /projects/{project}/repository/webhook-secret` | A new webhook secret: `{ url, secret }`, returned once. |
| `POST /projects/{project}/repository/sync`           | Queue the hourly check now (`202`). Owners and admins.  |

The settings are:

```text
{ project, repository, provider, connection, defaultBranch, closeOnMerge, mirrored,
  webhook: { url, secretSet, lastAt, lastStatus, coveredByBacklog },
  sync: { lastAt, error, nextAt }, canEdit }
```

- `webhook` is null when the project has no repository.
- The settings never include the secret. Only the answer of `webhook-secret` does.

`PATCH` takes two fields:
- `connectionId` is a connection for the repository's host, or null to read the repository without a token.
  A **connection** holds the token Zamu uses to read a git host. A change queues a check.
- `closeOnMerge` sets whether a merged request moves its tasks to Done.

The refusals:

| Answer                 | When                                                |
| ---------------------- | --------------------------------------------------- |
| `422`                  | `connectionId` names a connection for another host. |
| `409 PROJECT_MIRRORED` | `closeOnMerge` on a mirrored project.               |
| `409 CONFLICT`         | `sync` on a project without a repository.           |

### Webhook

Git hosts post request events to a URL outside `/api/v1`, one per project:

```text
POST {PUBLIC_URL}/api/webhooks/repository/{webhookId}
```

It answers with a bare status:

| Status | When                                                     |
| ------ | -------------------------------------------------------- |
| `202`  | A request event. The server queued it.                   |
| `200`  | A ping, another event or a signed payload it can't read. |
| `401`  | A missing or wrong signature.                            |
| `404`  | An unknown id.                                           |
| `410`  | The project no longer has a repository.                  |
| `413`  | A payload over 25 MB.                                    |

The Backlog.md webhook of a mirrored project (`/api/webhooks/backlog/{id}`) takes request events too and
answers `202` for them. Setup per host is in [repositories.md](repositories.md#webhooks).

## The nightly archive

A nightly job archives each project's closed tasks once they are older than the project's archive days. To
archive or restore tasks yourself, see [Archive and restore](#archive-and-restore).

| Method and path                                  | What it does                                                               |
| ------------------------------------------------ | -------------------------------------------------------------------------- |
| `PATCH /projects/{project}`                      | `{ archiveAfterDays }`: 1 to 365, or null to turn the nightly archive off. |
| `GET /projects/{project}/archive-preview?days=N` | `{ project, days, count }`: what the nightly run would archive.            |

Only owners and admins may set `archiveAfterDays`. Projects return it under the same name, and new projects
start at 14.

The preview counts with the same rule as the job. It counts Done and Canceled tasks closed more than `days`
days ago in `APP_TIME_ZONE`, without the ones a merge closed with items open.

A mirrored project has no nightly archive. Setting `archiveAfterDays` on one gets `409 PROJECT_MIRRORED`,
and its preview counts 0.

## Backlog.md export

| Method and path                          | What it does                                                        |
| ---------------------------------------- | ------------------------------------------------------------------- |
| `GET /projects/{project}/backlog/export` | The project as Backlog.md files, for `zamu backlog export` (0.9.0). |

It returns `{ project, format, generatedAt, files: [{ path, content }], removedPrefixes }`. A read-only key
can call it.
- `files` holds paths relative to the Backlog.md folder. Every task that is not hidden goes under `tasks/`,
  archived tasks under `archive/tasks/` and milestones under `milestones/`.
- `format` names the Backlog.md file format the files target.
- `removedPrefixes` is `tasks/`, `archive/tasks/`, `completed/` and `milestones/`. Markdown files there that
  are not in `files` are stale.

A project that still mirrors Backlog.md gets `409 PROJECT_MIRRORED`. See
[backlog-md.md](backlog-md.md#export-to-backlogmd).

## Labels

| Method and path                          | What it does                                                                      |
| ---------------------------------------- | --------------------------------------------------------------------------------- |
| `GET /projects/{project}/labels`         | The project's labels by name, each with `usageCount`.                             |
| `POST /projects/{project}/labels`        | Create one: `{ name, color? }`. Without `color` the app picks the least used one. |
| `PATCH /projects/{project}/labels/{id}`  | Rename or recolour: `{ name?, color? }`.                                          |
| `DELETE /projects/{project}/labels/{id}` | Delete it and take it off every task (`204`).                                     |
- A name is up to 40 characters and unique in the project, ignoring case. A name the project has already
  gets `409 LABEL_EXISTS`.
- Renames and deletes write no history. A task's history keeps the name it recorded.
- Labels read from Backlog.md files (`source: "backlog"`) keep their name. Renaming or deleting one fails
  with `409 LABEL_MIRRORED`. Their colour still changes.

## Home

| Method and path    | What it does                                                                             |
| ------------------ | ---------------------------------------------------------------------------------------- |
| `GET /home`        | Home: groups of tasks, the deadlines strip and the agent cards.                          |
| `GET /home/counts` | The sidebar count: review, mergedOpen, checkAgain, mentions, blocked, overdue and total. |

`GET /home` takes `tab`: `mine` (the default), `everyone` or `agents`. It also takes the filters `project`
(keys), `label` (names, merged across projects) and `priority`.

It returns four fields:

| Field       | What it holds                                                                                                             |
| ----------- | ------------------------------------------------------------------------------------------------------------------------- |
| `counts`    | The number of items on each tab.                                                                                          |
| `groups`    | The groups of the tab, in order.                                                                                          |
| `deadlines` | Milestones and cycles that end within 2 days, and tasks due within 2 days or overdue. Empty on Agents.                    |
| `agents`    | On the Agents tab, one card per agent: working or idle, its current task, its counts for today and its last five actions. |

Each tab has its own groups:

| Tab      | Groups, in order                                                                      |
| -------- | ------------------------------------------------------------------------------------- |
| Mine     | `review`, `mergedOpen`, `checkAgain`, `mentions`, `blocked`, `overdue` and `assigned` |
| Everyone | `review`, `mergedOpen`, `blocked`, `overdue` and `dueThisWeek`                        |
| Agents   | `waiting`                                                                             |
- `mergedOpen` holds Done tasks a merge closed with items open.
- `checkAgain` holds your open tasks whose check-again day has come.
- Each group has `total` and up to 50 `items`: `{ task, reason, relation, pills }`.
- A task shows once, in its first group.
- Archived tasks are never on Home.

`GET /dashboard` and `GET /dashboard/counts` stay for `zamu dashboard` and scripts written for 0.6.0. The web
app no longer uses them.
