# Changelog

## Unreleased (0.8.0)

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
