<picture>
  <source media="(prefers-color-scheme: dark)" srcset="assets/logo-dark.svg">
  <img src="assets/logo-light.svg" width="64" height="64" alt="">
</picture>

# Zamu

A self-hosted project management tool for teams where AI coding agents work next to people. Agents are members
of the workspace with their own scoped API keys, and every change they make reads "claude-dev for Ana Ruiz":
the agent, and the person it acts for. People use the web app; agents use the `zamu` CLI.

![The Checkout project's task list, with labels, due dates, a blocked task and nested subtasks](docs/images/task-list-light.png)

What works today:
- First-run setup, email and password sign-in, single sign-on with OpenID Connect, invitations by link.
- Home, the page you land on: tasks in review, unanswered mentions, blocked and overdue work and your other
  tasks, grouped by why they need you, across every project. Tabs for you, the whole workspace and the
  agents, and a strip of close deadlines.
- A collapsible sidebar with your projects, and a command palette (⌘K) for pages, projects, tasks and
  actions.
- Projects and tasks: a keyboard-first list and a board per project, with status, priority, assignee,
  labels, due dates, blockers, one level of subtasks and a Markdown description. Tasks open as a full page;
  Space shows a peek without leaving the list. Owners and admins can delete a project from its settings or
  with `zamu projects delete`.
- Display options for the list and the board (grouping, swimlanes, order, subtasks, shown properties),
  filters as chips, and changes to many tasks at once.
- Milestones with a target date and progress, and numbered cycles. A cycle ends at midnight after its end
  date, or early by hand, and moves its unfinished tasks to the next one.
- Comments in the task history, in Markdown, with @mentions of people and agents. The history shows
  comments, work notes and changes in one list, with filters for each.
- A work record on every task: acceptance criteria, a definition of done, a plan, work notes and a final
  summary. Agents fill it in through the CLI and can't finish a task while an item is open; people check or
  waive items in the task view. Each project sets the done items new tasks start with.
- Backlog.md: a project can mirror the task files a repository keeps in `backlog/`, following the default
  branch on every push, or import them once and move off Backlog.md. Labels, due dates, dependencies and
  parents come in as native fields. It reads through a workspace git connection to GitHub, GitLab or
  Gitea/Forgejo with a read-only token. A mirrored project can later switch to Zamu, after a check for open
  pull requests that touch the task files, and `zamu backlog export` writes its tasks back to the repository
  as a Backlog.md copy.
- Light, dark or system theme, saved to your account.
- Agents with API keys scoped to some or all projects, read only or read and write, revocable at any time.
- The `zamu` CLI, on npm and Homebrew, with `--json` output and stable exit codes, over a REST API at
  `/api/v1` with an OpenAPI document. Agents comment, plan with milestones and cycles, set labels, due dates,
  blockers and subtasks, list their own tasks with `--mine`, and see what needs them with `zamu dashboard`.
  `zamu instructions` prints how to work a task, and every change records the machine and git branch it
  came from.
- One Docker image (web, worker, migrations) and a docker compose file. Postgres is the only stateful service.

What changed in each release is in [CHANGELOG.md](CHANGELOG.md).

## Quickstart

You need Docker with the Compose plugin.

```sh
git clone https://github.com/reddevsdotio/zamu.git
cd zamu
cp .env.example .env
# set BETTER_AUTH_SECRET in .env, for example to the output of: openssl rand -base64 32
docker compose up -d --build
```

Open http://localhost:3000, create the admin account and name your workspace. Create a project, then add an
agent in Settings > Members and copy its key. The image ships the CLI, so you can try the key right away:

```sh
docker compose exec -e ZAMU_KEY=zamu_live_... web zamu tasks list --project PAY
```

On the agent's machine, install the CLI with npm (Node 24 or later) or Homebrew, then set `ZAMU_URL` and
`ZAMU_KEY` as described in [docs/agents.md](docs/agents.md):

```sh
npm install --global @reddevs/zamu
brew install reddevsdotio/tap/zamu
```

## Docs

- [Using the app](docs/guide.md): the sidebar, Home, the list and the board, the task view and its work
  record, the palette, labels, due dates, blockers and subtasks, and Task defaults.
- [Keyboard shortcuts](docs/keyboard.md): every key, and what changed in 0.7.0 and 0.9.0.
- [Self-hosting](docs/self-hosting.md): configuration, first run, ports, backups and upgrades.
- [Agents](docs/agents.md): adding agents, scoping keys, installing and running `zamu`, the work record, the
  offline queue, `--json` output.
- [Backlog.md](docs/backlog-md.md): git connections, mirrors and imports, mappings, webhooks, the switch to
  Zamu and the export.
- [CLI reference](apps/cli/README.md): every `zamu` command and option.
- [REST API](docs/api.md): authentication, errors, and the task, label and Home routes.

## Development

Node 24 and pnpm (the version in `package.json`):

```sh
pnpm install
cp .env.example .env                                   # then set BETTER_AUTH_SECRET
docker compose -f docker-compose.dev.yml up -d db      # Postgres on localhost:5432
pnpm --filter @zamu/db migrate
pnpm dev                                               # web app on http://localhost:3000, plus the worker
```

Checks:

```sh
pnpm lint
pnpm typecheck
pnpm test                                     # Vitest against a throwaway Postgres database
pnpm exec playwright install chromium         # once
pnpm e2e                                      # Playwright against the docker compose stack
```

`pnpm e2e` builds the CLI and the image, starts the compose stack as project `zamu-e2e` on a fresh volume at
http://localhost:3100 and runs the specs in `e2e/`, then removes the stack. It leaves the development
database alone. The specs share one server and admin account: whichever runs first sets the server up, the
others sign in, so each spec also runs alone (`pnpm e2e e2e/<spec>`). The stack sets `APP_ENCRYPTION_KEY`
and the git settings the Backlog.md specs need (`e2e/stack.ts`).
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
- `upgrade.spec.ts`: starts a second stack (`zamu-e2e-upgrade`, port 3101) on release 0.1.1 and adds data,
  switches it to M2.1 (0.3.0) and adds more, then to 0.6.0, where it mirrors a Backlog.md repository from its
  own Forgejo container and creates an agent key, then to the new image. It checks that every task key and
  route still works, that the 0.7.0 migrations backfill the mirror's labels, due date, blockers and parent
  with no history lines, and that the key from 0.6.0 gets 401 (the old prefix is gone) while a new key starts
  with `zamu_live_`. Between 0.6.0 and the new image it moves to 0.8.0 when that release exists, and the new
  image's migration moves a mirrored task's criteria, done items, plan, notes and summary out of its
  description into the work record, again with no history lines. The older images come from
  `E2E_M1_IMAGE`, `E2E_M2_1_IMAGE`, `E2E_0_6_IMAGE` and `E2E_0_8_IMAGE` (pulled when missing), or are built
  once from git as `zamu:m1-0.1.1`, `zamu:m2.1-<ref>`, `zamu:release-0.6.0` and `zamu:release-<ref>`, which
  takes a few minutes each the first time. The 0.8.0 step builds from the tag `0.8.0`, or from the ref in
  `E2E_0_8_REF` (for example `0.8.0-rc.1`); with neither the tag nor one of the two variables, it is skipped
  with a message.
- `work-views.spec.ts`: the board with its display options, milestones, cycles, comments with mentions from
  the web and the CLI, the list keys around group rows, Home across two projects and the theme.
- `backlog-mirror.spec.ts` and `backlog-import.spec.ts` (Playwright project `backlog-md`, after the others):
  each starts its own Forgejo container from `docker/forgejo/`, attaches it to the stack's network and
  removes it at the end. They cover connections, setup and the Mappings step's suggestions, the mirrored
  views, the fields and the work record read from the files and their locks, webhooks and a new webhook
  secret, refreshes, `zamu backlog`, refused changes, Edit mappings, the switch to Zamu with an open pull
  request in its check, `zamu backlog export` into a scratch git clone (read back with the Backlog.md
  parser), deleting a mirrored project and import.

`E2E_KEEP_STACK=1` keeps the stacks (and the Forgejo containers) running after the run, `E2E_SKIP_BUILD=1`
reuses the last image, `E2E_COMPOSE_PROJECT`, `E2E_PORT`, `E2E_UPGRADE_PORT` and `ZAMU_IMAGE` change the
project name, ports and image tag (use them when another checkout runs the suite on the same machine),
`E2E_SKIP_UPGRADE=1` skips the upgrade test and `E2E_SKIP_BACKLOG=1` skips the Backlog.md specs.

`pnpm dev` without `BETTER_AUTH_SECRET` prints the startup error once and keeps running; pages fail until
you set it. A built server, such as the one in the image, exits instead.

Locally the suite runs Chromium's headless shell; against a stack that is not on localhost (`E2E_BASE_URL`
on another Docker host) it runs full Chromium, which needs more system libraries.

To see the dashboard's query plans on a large workspace (100 projects, 100k tasks), run
`pnpm exec tsx packages/core/scripts/dashboard-stress.ts --help`. It creates and drops its own database on
the Postgres in `STRESS_DATABASE_URL` or `TEST_DATABASE_URL`.

## License

[MIT](LICENSE)
