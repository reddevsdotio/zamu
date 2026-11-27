# End-to-end tests

Playwright specs that run against the Docker Compose stack. From the repository root:

```sh
pnpm exec playwright install chromium         # once
pnpm e2e                                      # every spec
pnpm e2e e2e/palette.spec.ts                  # one spec
```

`pnpm e2e` builds the CLI and the image, starts the compose stack as project `zamu-e2e` on a fresh volume at
http://localhost:3100 and runs the specs in this folder, then removes the stack. It leaves the development
database alone.

The specs share one server and admin account. Whichever runs first sets the server up and the others sign
in, so each spec also runs alone. The stack sets `APP_ENCRYPTION_KEY` and the git settings the Backlog.md
specs need (`stack.ts`).

Locally the suite runs Chromium's headless shell. Against a stack that is not on localhost (`E2E_BASE_URL`
on another Docker host) it runs full Chromium, which needs more system libraries.

## Variables

| Variable              | Default    | Effect                                                             |
| --------------------- | ---------- | ------------------------------------------------------------------ |
| `E2E_SKIP_UPGRADE=1`  | off        | Skips the upgrade spec, the slowest one.                           |
| `E2E_SKIP_BACKLOG=1`  | off        | Skips the Backlog.md specs.                                        |
| `E2E_SKIP_BUILD=1`    | off        | Reuses the last image.                                             |
| `E2E_KEEP_STACK=1`    | off        | Keeps the stacks and the Forgejo containers running after the run. |
| `E2E_COMPOSE_PROJECT` | `zamu-e2e` | Compose project name.                                              |
| `E2E_PORT`            | `3100`     | Port of the main stack.                                            |
| `E2E_UPGRADE_PORT`    | `3101`     | Port of the upgrade spec's stack.                                  |
| `E2E_OWNERS_PORT`     | `3102`     | Port of the `WORKSPACE_CREATION=owners` web container.             |
| `ZAMU_IMAGE`          | `zamu:e2e` | Tag of the image the suite builds and runs.                        |
| `E2E_BASE_URL`        | localhost  | Address of a stack on another Docker host.                         |

Set the project name, the ports and the image tag when another checkout runs the suite on the same machine.

## Specs

- `work-record.spec.ts`: an agent works a task from a scratch git clone on a feature branch (criteria and a
  plan at creation, notes, a checked criterion, the summary) and is refused at In review with an open
  criterion; the person waives it in the finishing dialog and moves the task; the Notes filter and the
  machine and branch under History; Settings > Task defaults and the done items new tasks start with.
- `person-and-agent.spec.ts`: the M1 flow on the 0.7.0 screens, from setup (or sign-in) to an agent working
  through the CLI: New project from the sidebar, quick create, the list keys and the task view.
- `home.spec.ts`: Home. The old Dashboard, My tasks and Projects links redirect there; an agent puts a task
  in review and mentions its person from the CLI, the person answers the mention from Home with the
  keyboard, the sidebar count follows `/home/counts`, and `zamu dashboard --json` still matches the API.
- `labels.spec.ts`, `due-dates.spec.ts`, `blockers.spec.ts` and `subtasks.spec.ts`: the four task fields.
  Labels created from the picker, the label filter, and rename and delete in Settings > Labels; due dates in
  the list and the picker, the Due date filter, and overdue tasks on Home; blockers with the loop refusal;
  subtasks that take the parent's assignee and expand in place on the board.
- `palette.spec.ts`: the command palette, from finding a task by key to the Set status step.
- `bulk.spec.ts`: selecting tasks with X, Shift+↓ and ⌘A, and changing them from the action bar and the keys.
- `project-delete.spec.ts`: deleting a project from its settings and with `zamu projects delete`, including the
  refused cases and the keys that covered it.
- `archive.spec.ts`: Settings > Archive with its preview, the nightly `tasks.archive-due` job run right away
  with the clock it is given (`jobs.ts`), archiving three tasks from the action bar and Undo, the Archived
  filter, archived results last in the palette, a read-only archived task and Restore.
- `check-again.spec.ts`: a check-again day and its required reason from the task view, the waiting chip and
  dimmed card, Display options' "Waiting tasks: Hidden" with the column footer, a day that has come on the
  board and in Home's Check again group, and `zamu tasks update --check-again`, `--no-check-again`,
  `tasks list --waiting` and `--ready-to-check`.
- `pull-requests.spec.ts`: starts its own Forgejo container from `docker/forgejo/`, attaches it to the stack's
  network and adds the webhook through Forgejo's API. It covers the Repository page, the work branch from
  `zamu`, a draft request linking by branch and by a `Closes:` line, In review when it is ready and Done on
  the merge, the merged-with-open-criteria flag and Home group, a link by hand with its preview and the
  other-repository refusal, closing on merge off, a request closed without merging, a bad signature on the
  status line and Check now catching up with the webhook off.
- `waves.spec.ts`: an agent's `zamu` sets up a milestone with a plan link, three waves and their gates, and
  `zamu milestones show` prints it. The agent is refused a task in a locked wave, while a person gets the
  warning and starts it anyway. Pass waits for the wave's tasks and the agent passes W1; a gate failed from
  the web app shows the stop line; Alt+↓ and Alt+↑ move a task between waves. It also covers the milestone
  list's status line and the page in the dark theme.
- `workspaces.spec.ts`: a second workspace with the same project key, created from the switcher; switching
  with the switcher and the palette, two tabs on two workspaces, an invitation that opens its workspace,
  leaving, the no-workspace page, changing the address with old links still working, deleting, the CLI
  picking a login by the clone's remote, and `WORKSPACE_CREATION=owners` on a second web container.
- `work-views.spec.ts`: the board with its display options, milestones, cycles, comments with mentions from
  the web and the CLI, the list keys around group rows, Home across two projects and the theme.
- `backlog-mirror.spec.ts` and `backlog-import.spec.ts` (Playwright project `backlog-md`, after the others):
  each starts its own Forgejo container from `docker/forgejo/`, attaches it to the stack's network and
  removes it at the end. They cover connections, setup and the Mappings step's suggestions, the mirrored
  views, the fields and the work record read from the files and their locks, webhooks and a new webhook
  secret, refreshes, `zamu backlog`, refused changes, Edit mappings, the switch to Zamu with an open pull
  request in its check, `zamu backlog export` into a scratch git clone (read back with the Backlog.md
  parser), deleting a mirrored project and import.
- `upgrade.spec.ts`: walks one database through the old releases to the new image. See below.

## The upgrade spec

`upgrade.spec.ts` starts a second stack (`zamu-e2e-upgrade`, port 3101) and moves it through these steps,
adding data at each one:
1. Release 0.1.1.
2. M2.1 (0.3.0).
3. 0.6.0, where it mirrors a Backlog.md repository from its own Forgejo container and creates an agent key.
4. 0.8.0, when that release exists.
5. 0.9.0, when that release exists.
6. 0.10.0, when that release exists. It finishes a task there.
7. 0.11.0, when that release exists. It adds a milestone with tasks there.
8. The new image.

On the new image it checks these:
- Every task key and route still works.
- The 0.7.0 migrations backfilled the mirror's labels, due date, blockers and parent with no history lines.
- The key from 0.6.0 gets 401, as the old prefix is gone, while a new key starts with `zamu_live_`.
- A mirrored task's criteria, done items, plan, notes and summary have moved out of its description into the
  work record, again with no history lines.
- The workspace keeps its slug, each person has a last-used workspace, and an old task link redirects to
  `/w/<slug>/p/...`.
- Archiving is off on every existing project (a new one gets 14 days), each finished task has the time it was
  finished, and the Repository page opens for a project that had a repository.
- Every milestone keeps its tasks and progress, with no waves, no plan link and no new history lines.

The older images come from `E2E_M1_IMAGE`, `E2E_M2_1_IMAGE`, `E2E_0_6_IMAGE`, `E2E_0_8_IMAGE`,
`E2E_0_9_IMAGE`, `E2E_0_10_IMAGE` and `E2E_0_11_IMAGE`, pulled when missing. Without them the spec builds each image once from
git as `zamu:m1-0.1.1`, `zamu:m2.1-<ref>`, `zamu:release-0.6.0` and `zamu:release-<ref>`, which takes a few
minutes each the first time.

The 0.8.0 to 0.11.0 steps build from the tags `0.8.0`, `0.9.0`, `0.10.0` and `0.11.0`, or from the refs in
`E2E_0_8_REF`, `E2E_0_9_REF`, `E2E_0_10_REF` and `E2E_0_11_REF` (for example `0.8.0-rc.1`). With neither the tag nor one of
the variables, the spec skips that step with a message.
