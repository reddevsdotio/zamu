# Contributing

This page gets a checkout running and lists the checks a pull request has to pass.
[AGENTS.md](AGENTS.md) holds the code and UI conventions, for people and for coding agents, and
[docs/architecture.md](docs/architecture.md) explains how the pieces fit together.

## Set up

You need Node 24 (`.nvmrc`), pnpm (the version in `package.json`) and Docker.

```sh
pnpm install
cp .env.example .env                                   # then set BETTER_AUTH_SECRET: openssl rand -base64 32
docker compose -f docker-compose.dev.yml up -d db      # Postgres on localhost:5432
pnpm --filter @zamu/db migrate
pnpm --filter web seed                                 # optional: demo data, prints API keys
pnpm dev                                               # web app on http://localhost:3000, plus the worker
```

`pnpm dev` without `BETTER_AUTH_SECRET` prints the startup error once and keeps running; pages fail until
you set it. A built server, such as the one in the image, exits instead.

## Demo data

On a new database, `pnpm --filter web seed` creates the admin `ana@example.com` with the password
`dev-password-1234`. Ana owns two workspaces, Reddevs and Globex. Each has a project `PAY` and its own agent
`claude-dev`.

The seed prints `export` lines with API keys:

| Workspace | Agent key             | Admin key                   |
| --------- | --------------------- | --------------------------- |
| Reddevs   | `ZAMU_API_KEY`        | `ZAMU_ADMIN_API_KEY`        |
| Globex    | `ZAMU_SECOND_API_KEY` | `ZAMU_SECOND_ADMIN_API_KEY` |

Run it again at any time for new keys. It keeps what exists.

Reddevs' `PAY` links the made-up repository `github.com/northwind/payments`. It has pull requests in every
state, tasks linked by branch, by a `Closes:` line and by hand, a task merged with open criteria, archived
tasks and check-again days. Its hourly check then fails, as that repository doesn't exist.

Two variables trim the seed:
- `SEED_SECOND_WORKSPACE=0` leaves Globex out.
- `SEED_PLANNING=0` leaves out the pull request, archive and check-again data, and the planning and Home
  data before it.

## Checks

Run these from the repository root before you open a pull request.

```sh
pnpm format                                   # Biome applies its fixes, to Markdown too
pnpm lint
pnpm typecheck
pnpm test                                     # Vitest against a throwaway Postgres database
pnpm exec playwright install chromium         # once
pnpm e2e                                      # Playwright against the docker compose stack
```

`pnpm test` needs the Postgres from the setup above and creates one throwaway database per run. Run one
package with `pnpm --filter @zamu/core test`. The web startup tests spawn the built server, so run
`pnpm --filter web build` first or they are skipped.

`pnpm e2e` builds the image, starts its own stack on http://localhost:3100 and removes it afterwards. It
takes a while. [e2e/README.md](e2e/README.md) says what each spec covers and lists the variables that skip
the slow ones.

## Pull requests

- Branch from `main` with a prefix that matches the change: `feat/...`, `fix/...`, `docs/...`, `chore/...`.
- Write commit messages as Conventional Commits, such as
  `feat(worker): schedule the repository checks and the nightly archive`. AGENTS.md lists the types and
  scopes in use.
- Add a line under the Unreleased heading in [CHANGELOG.md](CHANGELOG.md) for a change users can see.
- Open the pull request against `main`. Five CI jobs must pass: `lint`, `typecheck`, `test`, `docker-build`
  and `e2e`.

## Query plans on a large workspace

To see the dashboard's query plans on 100 projects and 100k tasks, run
`pnpm exec tsx packages/core/scripts/dashboard-stress.ts --help`. The script creates and drops its own
database on the Postgres in `STRESS_DATABASE_URL` or `TEST_DATABASE_URL`.

## Security

Do not open a public issue for a vulnerability. Report it privately through GitHub's private vulnerability
reporting: the Security tab of https://github.com/reddevsdotio/zamu, then "Report a vulnerability".
