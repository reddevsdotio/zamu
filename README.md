<picture>
  <source media="(prefers-color-scheme: dark)" srcset="assets/logo-dark.svg">
  <img src="assets/logo-light.svg" width="64" height="64" alt="">
</picture>

# Zamu

Project management for teams where AI coding agents work next to people. Zamu is self-hosted and
MIT-licensed.

An agent is a member of the workspace with its own scoped API key, and every change it makes reads
"claude-dev for Ana Ruiz": the agent, and the person it acts for. People use the web app. Agents use the
`zamu` CLI.

![The Checkout project's task list, with labels, due dates, a blocked task and nested subtasks](docs/images/task-list-light.png)

## What you get

### For people

- A keyboard-first task list and a board per project, with labels, due dates, blockers, subtasks,
  milestones and cycles.
- Home, one page that groups what needs you across every project: tasks in review, unanswered mentions,
  blocked and overdue work.
- Comments with @mentions of people and agents, a command palette (⌘K), changes to many tasks at once, and
  light and dark themes.
- An archive that takes finished tasks out of the lists after a number of days you set, and a check-again
  day for a task that waits.

### For agents

- The `zamu` CLI, on npm and Homebrew, with `--json` output and stable exit codes. It talks to a REST API at
  `/api/v1` that has an OpenAPI document.
- API keys scoped to some or all projects, read only or read and write. You can revoke one at any time.
- A work record on every task: acceptance criteria, a definition of done, a plan, work notes and a final
  summary. An agent can't finish a task while an item is open.

### With your repository

- Pull requests on GitHub, GitLab and Gitea/Forgejo link to tasks by branch or a `Closes: PAY-142` line.
  Opening a request moves its tasks to In review, and merging it moves them to Done. Zamu only reads the
  repository: it never comments, commits or sets statuses.
- A project can mirror the [Backlog.md](https://github.com/MrLesk/Backlog.md) task files a repository keeps
  in `backlog/`, or import them once.

### For whoever runs it

- One Docker image and a compose file. Postgres is the only stateful service.
- Several workspaces on one server, each with its own projects, members, agents and keys.
- Sign-in with email and password or OpenID Connect, and invitations by link.

[docs/guide.md](docs/guide.md) covers every feature, and [CHANGELOG.md](CHANGELOG.md) lists what changed in
each release.

## How an agent works a task

The agent reads the task, writes its plan, takes notes as it goes, checks the criteria it has proven and
hands the task over for review:

```sh
zamu tasks list --mine --status todo --json
zamu tasks show PAY-142 --json
zamu tasks update PAY-142 --status in_progress --plan - < plan.md
zamu notes add PAY-142 "Retry queue written and tested"
zamu tasks update PAY-142 --check-ac 1 --check-ac 2 --check-dod 1
zamu tasks update PAY-142 --final-summary - --status in_review < summary.md
```

The task view shows all of it, with the machine and git branch each change came from. `zamu instructions`
prints how to work a task, and `zamu agents` writes a pointer to it into the repository's `AGENTS.md`.

## Quickstart

You need Docker with the Compose plugin.
1. Start the server:

   ```sh
   git clone https://github.com/reddevsdotio/zamu.git
   cd zamu
   cp .env.example .env
   # set BETTER_AUTH_SECRET in .env, for example to the output of: openssl rand -base64 32
   docker compose up -d --build
   ```

2. Open http://localhost:3000, create the admin account and name your workspace.

3. Create a project, then add an agent in Settings > Members and copy its key. The image ships the CLI, so
   you can try the key right away. Replace `PAY` with your project's key:

   ```sh
   docker compose exec -e ZAMU_KEY=zamu_live_... web zamu tasks list --project PAY
   ```

4. On the agent's machine, install the CLI with npm (Node 24 or later) or Homebrew:

   ```sh
   npm install --global @reddevs/zamu
   # or
   brew install reddevsdotio/tap/zamu
   ```

   Then set `ZAMU_URL` and `ZAMU_KEY` as described in [docs/agents.md](docs/agents.md).

For a real deployment, read [docs/self-hosting.md](docs/self-hosting.md) first. It covers configuration,
backups and upgrades.

## Docs

| Page                                   | What it covers                                                       |
| -------------------------------------- | -------------------------------------------------------------------- |
| [Using the app](docs/guide.md)         | Workspaces, Home, the list and the board, the task view, the archive |
| [Keyboard shortcuts](docs/keyboard.md) | Every key                                                            |
| [Agents](docs/agents.md)               | Adding agents, scoping keys, running `zamu`, the work record         |
| [CLI reference](apps/cli/README.md)    | Every `zamu` command and option                                      |
| [REST API](docs/api.md)                | Authentication, workspaces, errors and the routes                    |
| [Repositories](docs/repositories.md)   | Linking a repository, webhooks, how pull requests move tasks         |
| [Backlog.md](docs/backlog-md.md)       | Mirrors and imports, mappings, the switch to Zamu, the export        |
| [Self-hosting](docs/self-hosting.md)   | Configuration, first run, ports, backups and upgrades                |
| [Architecture](docs/architecture.md)   | How the pieces fit together                                          |

## Contributing

Bug reports and pull requests are welcome. [CONTRIBUTING.md](CONTRIBUTING.md) has the local setup and the
checks to run before you open a pull request.

Found a vulnerability? Please don't open a public issue. Report it through the repository's Security tab,
with "Report a vulnerability".

## License

[MIT](LICENSE)
