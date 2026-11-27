# Changelog

## 0.12.0

Waves and gates on milestones. A milestone links to its plan and runs its tasks in ordered waves, each ending
at a gate that someone passes or fails with a note; a wave stays locked until the gates before it pass, and
`zamu milestones show` gives the agent that dispatches the work the whole plan.

### Added

- A milestone links to its plan: a web address, which opens in a new tab, or a file path such as
  `plans/payouts-v2.html`, with Copy. "+ Add a link to the plan" on the milestone page, or
  `zamu milestones update --plan`.
- Waves and gates on the milestone page. A milestone's tasks run in ordered waves (W1, W2 ...), each with a
  progress bar and a gate at its end that says what must be checked. Pass and Fail (or G on the wave)
  record a result with a required note; Pass stays disabled while a task of the wave is open, and Fail
  reopens no task. The latest result shows with who recorded it, for whom and when; "Record again" adds
  another. A failed gate puts a line at the top of the page with "Go to the gate"; when every gate has
  passed, a line says so. Tasks outside the waves sit under "Not in a wave". With more than six waves, the
  passed ones from W1 fold into one line, and long waves and long notes are clipped with "Show all" and
  "Show the whole note". See [docs/guide.md](docs/guide.md#milestones-in-waves).
- Editing waves: "+ Add a wave" (Shift+N), rename, move up or down or drag, and remove, whose tasks go to
  "Not in a wave". Tasks move between waves by drag or Alt+↑ and Alt+↓. The task view has a Wave field
  under Milestone, and the history records wave changes.
- The lock: a wave is locked until every gate before it has passed. The server refuses an agent that starts
  a task in a locked wave (`409 WAVE_LOCKED`, naming the gate it waits for). A person gets a warning first,
  "W4 is still locked", wherever they start the task, and Start anyway (⌘Enter) goes ahead. Moves by pull
  requests and Backlog.md refreshes are never refused.
- The milestone list shows where each plan stands under its name: "Wave 3 of 5 · gate open", "Gate failed
  in wave 8 of 12", "All 4 gates passed · 1 task open" or "No waves".
- CLI: `zamu milestones show <milestone>` prints the plan in one go (the plan link, each wave with its
  gate, latest result, lock and tasks, the tasks in no wave, and a `Next:` line), `--plan` and `--no-plan`
  on `zamu milestones update`, `zamu waves add|update|remove|put|pass|fail`, and `--wave`/`--no-wave` on
  `zamu tasks update`. `zamu tasks show` prints the wave and its lock, and `zamu tasks list` and
  `zamu milestones list` gain a wave column. A person who starts a task in a locked wave gets a warning on
  stderr. See [docs/agents.md](docs/agents.md#plans-waves-and-gates).
- `zamu instructions planning`: how a planning agent links the plan, adds the waves with their gates, puts
  the tasks in them and checks the result with `zamu milestones show`.
- API: `GET /milestones/{id}/plan`, `POST /milestones/{milestone}/waves`, `PATCH` and `DELETE
  /waves/{id}`, `POST /milestones/{milestone}/wave-tasks` and `POST /waves/{id}/gate`; `planUrl` on
  `PATCH /milestones/{id}`; `wave` on task create and update. Milestones carry `planUrl` and a `waves`
  summary, tasks and list rows carry `wave`, and history has a `wave` change. New problem codes:
  `409 WAVE_LOCKED` and `409 GATE_TASKS_OPEN`. See
  [docs/api.md](docs/api.md#milestones-waves-and-gates-0120).
- The dev seed plans four of Reddevs' `PAY` milestones in waves: "Payouts v2" (five waves, W3 current),
  one with a failed gate, one with every gate passed, and "Refunds rework" with 12 waves.

### Changed

- `zamu instructions working` tells agents to check a task's wave before starting it, and to run a wave's
  gate checks and record the result once its tasks are done, logging fixes for a failed gate as tasks in the
  same wave.

### Fixed

- `zamu backlog export` waits up to 2 minutes for the server instead of 5 seconds, so a large project or a
  slow connection no longer fails as "the server didn't answer". When it does run out of time, it says the
  server may still be working. Every other request, the writes the offline queue takes included, keeps the
  5-second limit.
- A project switched from a Backlog.md mirror says "Owned by Zamu" wherever its Backlog.md state shows: the
  settings, the settings menu, the setup page and the history ("switched Payments to Zamu"). It said
  "Detached" in places. A finished import still says "Imported".
- In the dialog for moving several tasks with open items, ⌘Enter moves them, as the dialog says. It pressed
  Cancel when focus was on that button.

### Upgrading

Back up the database, then upgrade as usual. The migration adds the `wave` and `gate_result` tables, a plan
link column on milestones and a wave column on tasks. It changes no existing row: every milestone starts
with no waves and no plan link, and no history lines are written. No new settings.

## 0.11.0

Pull requests on tasks, the archive and check-again days. A project links its repository, requests link to
tasks and move them to In review and Done; closed tasks leave the lists after a set number of days; a task
that waits gets a day to look at it again.

### Added

- Settings > Repository, per project: the repository and the connection Zamu reads it with (Change, with
  "None: public repository" for a public read without a token), the default branch, the switch "Close tasks
  when their pull request merges" (on by default), the webhook, and the hourly check with Check now. Owners
  and admins edit; everyone who reads the project sees the page. See
  [docs/repositories.md](docs/repositories.md).
- Pull and merge requests link to tasks in three ways: by the task's work branch (the branch an agent was on
  when it started the task with `zamu`), by a `Closes: PAY-142, PAY-150` line in the description, and by
  hand. Description edits link and unlink; a link removed by hand stays removed until linked by hand again.
- Requests move their tasks: opened, reopened or marked ready moves tasks in Backlog, Todo or In progress to
  In review; a merge into the default branch moves them to Done when the project closes on merge and no
  other linked request is open. Drafts link without moving. Merges into other branches and requests closed
  without merging move nothing. The history names the host: "GitHub moved this to In review · #482 opened
  by claude-dev".
- "Merged with 2 open criteria" ("Merged with 3 open items" when done items are open too) on a task a merge
  closed with items still open, and a Home group, "Merged with open criteria", on Mine and Everyone.
- The task view lists the task's requests between the description and the criteria, with host, number,
  title, how each was linked and its state (Open, Draft, Merged, Closed), and remove with Undo. The branch
  line shows while a work branch has no request yet. "Link a pull request" (Shift+P, also in the peek) takes
  a request address, previews it, and refuses addresses of other repositories and addresses that are not
  requests. The properties gain Pull request (the newest, "+3") and Check again rows.
- One webhook per project at `/api/webhooks/repository/<id>`, with its own secret, shown once, and New
  secret. The page has the setup steps for GitHub, GitLab and Forgejo and says how the last event went,
  including "The last event failed its signature check". In a project that mirrors Backlog.md, the mirror's
  webhook also carries request events, so one webhook covers both.
- An hourly check, at 45 minutes past each hour (UTC), reads the requests updated since the last one, so
  requests link and tasks move without a webhook too. The first check after a repository is linked, or its
  connection changes, records what exists and moves no task. Out-of-order events can't move a task back.
- Settings > Archive, per project: "Archive finished tasks" a number of days (1 to 365) after they reached
  Done or Canceled, with the count the next run would archive shown before you save. A nightly job at 02:30
  in `APP_TIME_ZONE` archives them; the history names Zamu. It skips tasks merged with open items.
- Archiving by hand, for anyone who can edit the task, agents included: Shift+E on the open task or the
  selection, or Archive in the action bar, with "3 tasks archived" and Undo in the toast (⌘Z while it
  shows). Shift+E on an archived task restores it.
- Archived tasks: out of lists, boards, Home, the dashboard and counts; read-only, with a bar "Archived on
  Nov 12" and Restore, and a comment box that asks to restore first. The Archived filter and Display >
  "Archived tasks" show them, with "Archived Nov 12" and Restore on hover. Search and the palette list them
  last with an Archived tag, and the palette offers "Show archived tasks in <project>". Milestone, cycle and
  subtask progress keep counting them.
- Check-again days: a day and a required reason (up to 200 characters) on a task, set with Shift+W or the
  Check again row, from a picker like the due-date one. Rows and cards show "Until Dec 3" while it waits and
  "Check again: today" (then "yesterday", "3 days ago") once the day comes, never in the overdue colour.
  Your tasks whose day has come show on Home under Check again. Moving a task to Done or Canceled clears the
  day.
- Display options: "Waiting tasks" (Shown, "Shown, dimmed" by default, or Hidden; a board column then
  ends with "2 waiting, hidden"), "Archived tasks" (Hidden by default, Shown), and the chips Check again
  (on) and Pull request (off). Filters: Waiting, Ready to check and Archived.
- Backlog.md: a mirrored task whose file is under `archive/tasks/` (or `completed/`) is archived, and moving
  the file back restores it. Imports bring those tasks in archived. Mirrored tasks can't be archived or
  restored in Zamu (`TASK_MIRRORED`), and mirrored projects have no archive setting.
- API: `GET` and `PATCH /projects/{project}/repository`, `POST .../repository/webhook-secret`,
  `POST .../repository/sync`, `GET /projects/{project}/archive-preview?days=N`, `archiveAfterDays` on
  `PATCH /projects/{project}`, `POST /tasks/archive` and `POST /tasks/restore` (up to 100 keys, all or
  nothing), `POST /tasks/{key}/pull-requests` (with `dryRun`) and `DELETE /tasks/{key}/pull-requests/{n}`,
  `checkAgain` on task create and update, and the `archived` and `checkAgain` list filters. Tasks carry
  `workBranch`, `pullRequests`, `checkAgain`, `closedAt`, `archivedAt`, `archivedBy` and `mergedOpen`;
  history entries carry `cause` and `system`. New problem codes: `409 TASK_ARCHIVED`,
  `422 REQUEST_OTHER_REPOSITORY`, `422 NOT_A_REQUEST` and `404 REQUEST_NOT_FOUND`. See
  [docs/api.md](docs/api.md#pull-requests-archive-and-check-again-days).
- CLI: `zamu pr link <task> <url> [--dry-run]` and `zamu pr unlink <task> <number>`, `zamu tasks archive` and
  `zamu tasks restore` (one or several keys), `--check-again <day> --reason <text>` and `--no-check-again` on
  `zamu tasks update`, `--waiting`, `--ready-to-check` and `--archived include|only` on `zamu tasks list`,
  and `zamu projects show` (repository, close on merge, webhook, hourly check, archive days). `zamu tasks
  show` lists the work branch, the requests, the check-again day, the archive date and the merged-with-open
  line. Archive, restore, check-again days and `zamu pr` writes queue offline. See
  [docs/agents.md](docs/agents.md#pull-requests).
- The dev seed links Reddevs' `PAY` to the made-up `github.com/northwind/payments` with requests in every
  state, tasks linked each way, a task merged with open criteria, archived tasks and check-again days. WEB
  has archiving off.

### Changed

- Home: Mine's groups are Needs your review, Merged with open criteria, Check again, Mentions, Blocked,
  Overdue and Assigned to you; Everyone's gain Merged with open criteria after Needs review. The sidebar
  count adds both new groups. `GET /home/counts` gains `mergedOpen` and `checkAgain`.
- `GET /tasks`, lists, boards, Home and counts leave archived tasks out unless asked (`archived=include` or
  `only`).
- `zamu instructions` tells agents to start a task from its work branch, to name other tasks on a `Closes:`
  line, to set a check-again day instead of leaving a waiting task In progress, and, when the project closes
  on merge, to stop at In review and let the merge move the task to Done.
- `zamu backlog export` writes archived tasks to `archive/tasks/` and prunes stale files there too; the
  export's `removedPrefixes` include `archive/tasks/`.
- A Backlog.md webhook answers `202` for a pull or merge request event and passes it on to the project's
  repository.
- New projects archive closed tasks after 14 days.

### Upgrading

Back up the database, then upgrade as usual. The migration adds the new tables and columns and fills
`closed_at` for every Done and Canceled task from its history. Archiving stays off for every existing
project; projects created afterwards start at 14 days. Tasks of active Backlog.md mirrors whose files are
under `archive/tasks/` come back archived; imported projects keep those tasks as they were.

Projects that already link a repository get their repository link on first use, with close on merge on and
no connection unless the workspace has exactly one working connection for the host (or the project mirrors
Backlog.md). The first hourly check links the requests it finds and moves nothing; merges after that move
tasks to Done. Turn close on merge off in Settings > Repository where people close tasks by hand. GitHub
connections need "Pull requests: Read-only" to read requests. Webhooks are optional; issuing their secret
needs `APP_ENCRYPTION_KEY`.

## 0.10.0

Several workspaces on one server. Every page lives under the workspace's slug, people switch between the
workspaces they belong to, and the CLI keeps one login per workspace.

### Added

- Workspaces: one server holds several, each with its own projects, members, agents and API keys. Pages live
  under `/w/<slug>/`, so a link always opens its own workspace and two tabs can show two workspaces. Project
  and task keys are unique per workspace: two workspaces can each have a `PAY-1`.
- The workspace menu lists every workspace you belong to under "Workspaces", with the current one checked.
  Choosing another opens its Home. Below the list: "New workspace" (when you may create one), then
  Workspace settings, Invite people, New project and New from Backlog.md as before.
- Command palette: "Switch to <workspace>" for each of your other workspaces, "New workspace" and "Go to
  workspace settings". No new keys.
- The New workspace dialog: a Name, and an Address suggested from it that you can change, with "This
  address is reserved. Pick another." or "The address … is taken. Pick another." under the field. Create
  workspace (⌘Enter) opens the new workspace's Home, which starts with "Nothing to show yet": create a
  project, then add an agent.
- Settings > General, the first page of the workspace settings (Workspace settings and `/w/<slug>/settings`
  open it). Owners and admins change the Name and the Address; old links keep working and open the new
  address. Members see both read-only.
- Leave workspace, in General: anyone can leave after a confirm, and loses their API keys for the
  workspace.
- Delete workspace, in General's danger zone, for owners: the confirm lists what goes ("Deletes Acme with 3
  projects, 120 tasks, 2 agents and 4 API keys.") and asks you to type the address. There is no undo.
- `/welcome`, for people signed in without a workspace: "Create a workspace" when the server allows it,
  otherwise "Ask an owner for an invitation", and Sign out.
- `WORKSPACE_CREATION`: `everyone` (the default) lets any person create a workspace, `owners` only people
  who own one. Agents never can.
- `OIDC_WORKSPACE`: the slug of the workspace that SSO auto sign-up joins and `OIDC_ADMIN_GROUPS` applies
  to. Without it, the oldest workspace. Set before setup, the first workspace takes that slug.
- API: the `x-zamu-workspace` header names the workspace of a request. A session acts in that workspace; a
  key acts in its own and is refused with `403 WORKSPACE_MISMATCH` when the header names another. A person
  outside the named workspace gets `403 NOT_A_MEMBER`. See [docs/api.md](docs/api.md#workspaces).
- CLI: `zamu login` adds a login per server and workspace instead of replacing the stored one;
  `zamu login --default`, `zamu workspaces [--default <slug>]`, `zamu logout --workspace <slug>` and
  `zamu logout --all`; a global `--workspace <slug>` option on every command. Each command picks its login
  from `--workspace`, `ZAMU_KEY`, the clone's git remote (cached in `$XDG_STATE_HOME/zamu/clones.json`) or
  the default login. `zamu whoami` shows how it picked (`workspaceSource` in `--json`). See
  [docs/agents.md](docs/agents.md#several-workspaces).
- The dev seed adds a second workspace, Globex, with its own `PAY` project and its own `claude-dev`, and
  prints `ZAMU_SECOND_API_KEY` and `ZAMU_SECOND_ADMIN_API_KEY` for it.

### Changed

- Links from 0.9 (`/p/…`, `/settings/…`, `/dashboard`, `/my-tasks`, `/projects`) and `/` redirect to the
  same page in the workspace you used last. That workspace is stored on your account, so it is the same in
  every browser and after signing out.
- Accepting an invitation opens the workspace that sent it. Someone who already has an account joins with
  "Join <workspace>" when signed in with the invited email, or "Sign in to join" when signed out; signed in
  with another email, the page offers Sign out instead of accepting.
- Workspace settings, in the sidebar and the workspace menu, opens General instead of Members.
- Leave workspace is refused for the only owner ("You are the only owner of Acme, so you can't leave it.
  Delete the workspace instead.") and for the responsible person of agents in the workspace ("You are
  responsible for claude-dev here. Hand them to someone else or remove them first.").
- Removing a person in Settings > Members is refused the same way while they are responsible for agents in
  the workspace, with the agents named. A person who leaves or is removed loses their API keys for that
  workspace only.
- Better Auth's endpoints that create, change or delete workspaces and memberships answer 403 under
  `/api/auth`. Invitations work as before.
- Setup stays done once a workspace exists: creating more workspaces, or deleting the first while others
  remain, never opens it again.
- CLI: the config file holds a list of logins (`{ "version": 2, "logins" }`). A clone that matches several
  logins stops with exit code 1 and lists the `--workspace` values; a key used for another workspace exits
  with 4. Queued writes are sent with the login they were queued with, and remembered statuses are kept per
  server and workspace.

### Upgrading

Back up the database, then upgrade as usual. Existing slugs stay the same unless they don't fit the new
rules (2 to 40 lower-case letters, digits and single hyphens, starting with a letter, not a reserved word);
those are rewritten and the old slug is kept as an alias. Each person's workspace used last starts as their
oldest one. The CLI converts a 0.9 config file on the first command that reaches the server, and keeps
using it as it is while offline.

## 0.9.0

Agents record their work in Zamu. A task gains a work record, the CLI installs from npm and Homebrew, and a
project that mirrors Backlog.md can switch to Zamu and be exported back as files.

### Added

- The work record on every task: acceptance criteria, a definition of done (done items), a plan, work notes
  and a final summary. Criteria and done items are open, checked or waived; a waived item always has a
  reason. The task view shows the summary first, then the description, the criteria, the done items and the
  plan, with their counts in the properties.
- Editing criteria and done items in the task view from the keyboard: X checks, W waives, E rewords, Alt+↑
  and Alt+↓ reorder, Backspace removes with Undo, Shift+A adds a criterion and Shift+X moves to the first
  open item. See [docs/keyboard.md](docs/keyboard.md).
- The finishing dialog: moving a task to In review or Done while items are open lists them first, to check,
  waive, or move the task anyway. It shows wherever a status is set: the task view, the peek, list and board
  status keys, board drag, and the command palette. A selection of several tasks gets one confirm with the
  count.
- Work notes in the history, with All, Comments, Notes and History filters and their counts. N opens the
  comment box as a note. A note reaches nobody unless it mentions them.
- Settings > Task defaults: the done items every new task in a project starts with.
- The criteria marker ("4/6") on list rows and board cards, switched on with the Criteria chip in Display.
  The peek shows the criteria and done items counts and opens on the final summary; Home shows "4 of 6
  criteria" on tasks that need your review.
- Changes and notes made through the CLI show the machine and the git branch they came from.
- CLI: install with `npm install --global @reddevs/zamu` or `brew install reddevsdotio/tap/zamu`.
  `zamu --version` prints the release.
- CLI: `zamu tasks create --ac --dod --no-dod-defaults --plan`, `zamu tasks update --ac --check-ac
  --uncheck-ac --remove-ac --waive-ac --unwaive-ac --reason` (and the same for `-dod`), `--plan`,
  `--final-summary` and `--append-notes`, and `zamu notes add`. `zamu tasks show` prints the work record and
  the notes.
- CLI: `zamu instructions [overview|creating|working|finishing]` prints how agents work on a task. The
  block that `zamu agents` writes is now a few lines that point to it.
- CLI: an offline queue. When the server doesn't answer within 5 seconds, checking, unchecking and waiving
  items, a status change, and a note or comment are queued and sent with the next command; zamu exits with
  the new code 7. `zamu queue` lists them, `zamu queue drop ID` removes one, and `zamu whoami` counts them.
- Switch to Zamu in Settings > Backlog.md: a mirrored project stops reading its files and Zamu owns its
  tasks, after a check that lists the open pull or merge requests that change the task files. It can't be
  undone.
- `zamu backlog export` writes a project owned by Zamu into the repository's `backlog/` folder as Backlog.md
  files, and removes the task files it no longer has. `zamu agents` replaces a Backlog.md guidelines block
  in `AGENTS.md` on such a project.
- API: `criteria`, `doneItems`, `plan`, `planMeta`, `finalSummary` and `finalSummaryMeta` on tasks;
  `criteriaProgress`, `doneProgress` and `hasFinalSummary` on list rows; the item operations
  (`addCriteria`, `checkCriteria`, `waiveCriteria` and the rest), `plan`, `finalSummary` and `ifStatus` on
  `PATCH /api/v1/tasks/{key}`; `criteria`, `doneItems`, `plan` and `skipDefaultDoneItems` on
  `POST /api/v1/tasks`; `kind` on comments; `show` and `counts` on the timeline; `defaultDoneItems` on
  projects; `source` on history entries and comments from the `x-zamu-machine` and `x-zamu-branch`
  headers; `GET /api/v1/projects/{project}/backlog/export`. See [docs/api.md](docs/api.md).

### Changed

- Agents are refused when they move a task to In review or Done while a criterion or done item is open:
  `409 OPEN_ITEMS` with the open items, exit code 1 in the CLI with the flags that settle them. People are
  never refused.
- Detach became Switch to Zamu. The Detach dialog is gone; the switch does the same and adds the check for
  open pull or merge requests.
- A Backlog.md mirror fills the work record from the task files: criteria, done items, the plan and the
  final summary, read-only, with the implementation notes as one block. The description no longer holds
  those sections.
- On a mirrored task, writing the work record or a note is refused with `409 TASK_MIRRORED` (exit code 6 in
  the CLI) and the `backlog task edit` command that makes the change.
- The switch check reads open pull requests, so GitHub fine-grained tokens need read-only `Pull requests`
  access besides `Contents` to switch a project.

### Upgrading

Back up the database, then upgrade as usual (see [docs/self-hosting.md](docs/self-hosting.md#upgrades)). A
data migration moves the acceptance criteria, definition of done, plan and final summary of tasks mirrored
or imported from Backlog.md out of their description into the work record, and keeps the implementation
notes in the task's Backlog.md data. It writes no history lines, and the next refresh changes nothing for
files that did not change. Agents that move tasks to In review or Done with open items start getting
`OPEN_ITEMS`: run `zamu agents` in each repository to give them the new instructions.

## 0.8.0

Renamed to Zamu. The rename is breaking: none of the old names keep working.

### Changed

- The product is Zamu in the web app, page titles, the OpenAPI document and sign-in. The repository moves to
  https://github.com/reddevsdotio/zamu.
- The CLI binary is `zamu` instead of `pm`. It reads `ZAMU_URL`, `ZAMU_KEY`, `ZAMU_API_KEY` and
  `ZAMU_PROJECT` instead of the `PM_*` variables, stores its config in `$XDG_CONFIG_HOME/zamu/config.json`,
  and looks for `.zamu.json` instead of `.pm.json`. `--json` output uses the schema ids `zamu.v1.*` instead
  of `pm.v1.*`, and `zamu agents` writes its block between `<!-- zamu:start -->` and `<!-- zamu:end -->`
  (blocks with the old `pm:` markers are not recognised; remove them by hand).
- Display options, the sidebar state and other settings kept in the browser use new storage keys, so
  everyone starts on the defaults once.
- API keys start with `zamu_live_` instead of `pm_live_`, and key lists show their first 14 characters. Keys
  created before 0.8.0 get 401; create new ones in Settings.
- Workspace packages are `@zamu/*` instead of `@pm/*`, and the root package is `zamu`.
- The image entrypoint is `zamu-entrypoint`, and `zamu` runs the bundled CLI. Compose projects are `zamu` and
  `zamu-dev`, the default image is `zamu:local` (`ZAMU_IMAGE`), and the default database is `zamu`.
- The git provider client sends the User-Agent `zamu-git-providers`.
- The favicon and the README show the Zamu logo instead of the amber "PM" placeholder. Both follow the
  light or dark theme. The sign-in, setup and invite pages show the mark in their footer, and the app has
  a web manifest with PNG icons, so phones get a Zamu icon when it is added to the home screen.

## 0.7.0

A new look for the web app, and four new task fields: labels, due dates, blockers and subtasks.

### Added

- Labels per project. Typing a new name in the label picker creates it. Rename, recolour and delete them in
  the project's Settings > Labels, which shows how many tasks use each one.
- Due dates. Rows and cards show "Tomorrow", "Today" or "3 days overdue"; done tasks keep the date quietly.
- Blocked by. A task waits on other tasks of its project and shows a Blocked marker while any of them is
  open. Links that would close a loop are refused with the reason.
- Subtasks, one level deep. A new subtask takes the parent's assignee, and the parent shows done of total.
  The board hides subtasks by default and expands the parent card in place.
- Home replaces the dashboard and My tasks: Mine, Everyone and Agents tabs, tasks grouped by why they need
  you, a deadlines strip, and agent cards with what agents wait on people for.
- The command palette (⌘K, Ctrl+K): pages, projects, tasks by key or title, and actions on the open or
  selected tasks, such as Change status.
- Display options for the list and the board: grouping, swimlanes, order (including manual), subtasks,
  empty groups, hiding old done tasks, and which properties show. Saved per person, project and view.
- New filters: labels, due date, blocked, and several assignees, milestones or cycles at once. Filters show
  as chips with the number of matching tasks.
- Select several tasks (X, Shift+↓, ⌘A) and change them together from the action bar or with the task keys.
  Native projects only.
- The peek: Space shows a task over the list, board or Home without leaving it.
- Single-letter keys for the task fields (S, P, A, I, L, Shift+D, Shift+M, Shift+C, Shift+B, Shift+S), and
  a shortcut list on ?. See [docs/keyboard.md](docs/keyboard.md).
- API: `GET`, `POST`, `PATCH` and `DELETE /api/v1/projects/{project}/labels`, `POST /api/v1/tasks/bulk`,
  `GET /api/v1/home` and `GET /api/v1/home/counts`. Tasks carry `labels`, `dueDate`, `parent`, `subtasks`,
  `subtaskProgress`, `blockedBy`, `blocks` and `blocked`. `GET /api/v1/tasks` filters by `label`, `due`,
  `blocked`, `topLevel` and `parent`, and orders with `sort`. See [docs/api.md](docs/api.md).
- CLI: `pm tasks list --label --due --blocked --top-level --parent --sort`, `pm tasks create` and
  `pm tasks update --label --remove-label --due --parent --blocked-by --unblock`, and `pm labels list`,
  `create`, `update` and `delete`.
- Backlog.md mirrors fill the same fields from the files: labels, `due_date`, `dependencies` and the parent
  task. They are read-only here. Labels from the files keep their names; their colour is editable.

### Changed

- The web app moves to a new design: a collapsible sidebar that lists the projects, a slim header with
  Filter and Display, boxless cards, a serif task title, and new fonts and colours in both themes.
- Tasks open as a full page. The list no longer has a detail pane: Enter opens the task view and Space the
  peek. Links with `?task=` open the task view.
- New project and New from Backlog.md moved to the "+" next to Projects in the sidebar, the workspace menu
  and the palette.
- Deleting a project goes to Home.
- Keys:
  - P sets the priority. It no longer opens New project.
  - G then H opens Home. G then D is gone.
  - G then M opens the current project's milestones; it used to open My tasks. G then L, B and Y open the
    list, the board and the cycles, and G then P jumps to a project.
  - On the board, Shift+← and Shift+→ move a card between columns. Shift+H and Shift+L are gone. Shift+J
    and Shift+K reorder only when Order by is Manual. ⌘Z undoes through the toast.
  - `[` collapses the sidebar.
- Swimlanes come from Display, not from `?lanes=` in the address.
- The task history writes "moved this to In review" instead of "moved it from Todo to In review".
- Sign-in is one column. A rate-limited sign-in says "Too many attempts. Wait a few seconds and try again."

### Removed

- The Dashboard page (`/dashboard`), the My tasks page (`/my-tasks`) and the Projects page (`/projects`).
  Their links open Home. `pm dashboard` and `GET /api/v1/dashboard` stay.
- The icon rail and the project tabs.

### Upgrading

Back up the database, then upgrade as usual (see [docs/self-hosting.md](docs/self-hosting.md#upgrades)). A
data migration copies labels, due dates, dependencies and parents of tasks mirrored or imported from
Backlog.md into the new fields. It writes no history lines, and the next refresh changes nothing for files
that did not change. People start on the default display options.
