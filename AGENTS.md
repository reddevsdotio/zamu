# Zamu

Zamu is a self-hosted, MIT-licensed project management tool for teams where AI coding agents work next to
people. Agents are workspace members with their own scoped API keys, and every change records the agent and
the person it acts for. People use the web app; agents use the `zamu` CLI over a REST API. It ships as one
Docker image, and Postgres is the only stateful service.

This file is for contributors and their coding agents. [README.md](README.md) covers features and
self-hosting, and [docs/architecture.md](docs/architecture.md) explains how the pieces fit together.

## Stack

- TypeScript in strict mode, Node 24, pnpm workspaces. Dependencies are pinned to exact versions.
- Web: TanStack Start (React 19, Vite) on Nitro, TanStack Query, React Aria Components, Tailwind CSS v4.
- API: oRPC with Zod contracts, served as REST with an OpenAPI document at `/api/v1`.
- Auth: Better Auth (email and password, one OpenID Connect provider, workspaces, API keys).
- Data: Postgres 18, Drizzle ORM, pg-boss for background jobs.
- Tools: Biome (lint and format), Vitest, Playwright, Docker.

## Layout

| Path                     | What lives there                                                          |
| ------------------------ | ------------------------------------------------------------------------- |
| `apps/web`               | Web server: pages, `/api/v1`, `/api/auth`, webhooks, `/api/healthz`       |
| `apps/worker`            | pg-boss worker that runs the background jobs                              |
| `apps/cli`               | The `zamu` CLI, bundled with tsdown                                       |
| `packages/core`          | Business rules: every service the API, server functions and jobs call     |
| `packages/contracts`     | Zod schemas, the oRPC contract, error codes and the CLI's `--json` shapes |
| `packages/db`            | Drizzle schema, SQL migrations and the throwaway test database helper     |
| `packages/auth`          | Better Auth setup, SSO, API keys and the request actor                    |
| `packages/git-providers` | Read-only clients for the supported git hosts, webhook signature checks   |
| `packages/backlog-md`    | Pure parser for Backlog.md folders                                        |
| `e2e`                    | Playwright specs that run against the Docker Compose stack                |
| `docker`                 | Image entrypoint, health check, migration runner, Forgejo test container  |
| `docs`                   | User, API and self-hosting docs                                           |

## Commands

Use Node 24 (`.nvmrc`) and pnpm 12.14 (the `packageManager` field). `engineStrict` is on, so pnpm refuses to
install under another Node major.

Set up and run the app:

```sh
pnpm install
cp .env.example .env                                # then set BETTER_AUTH_SECRET: openssl rand -base64 32
docker compose -f docker-compose.dev.yml up -d db   # Postgres 18 on localhost:5432
pnpm --filter @zamu/db migrate
pnpm --filter web seed                              # optional: demo workspace, prints API keys
pnpm dev                                            # web app on http://localhost:3000, plus the worker
```

Checks, from the repository root:

```sh
pnpm lint                     # Biome; `pnpm format` applies its fixes
pnpm typecheck                # tsc for the root, e2e/ and every package
pnpm test                     # Vitest; needs the Postgres above
pnpm build                    # web server (.output) and CLI (dist)
pnpm exec playwright install chromium    # once
pnpm e2e                      # Playwright against a fresh Docker Compose stack
```

- `pnpm test` creates one throwaway database per run on the server in `TEST_DATABASE_URL` (default
  `postgres://postgres:postgres@localhost:5432/postgres`). Run one package with
  `pnpm --filter @zamu/core test`.
- The web startup tests spawn the built server. Run `pnpm --filter web build` first, as CI does, or they
  are skipped.
- `pnpm e2e` builds the image, starts its own stack on http://localhost:3100 and removes it afterwards. It
  needs Docker and takes a while: the upgrade spec builds older releases from their git tags.
  `E2E_SKIP_UPGRADE=1` and `E2E_SKIP_BACKLOG=1` skip the slow specs; the README lists the other variables.
- After a schema change in `packages/db/src/schema`, run `pnpm --filter @zamu/db generate` and commit the
  new folder under `packages/db/migrations`.

## Code conventions

- Biome sets the style: 2 spaces, single quotes, 110 columns, sorted imports. Run `pnpm format` before you
  commit.
- Business rules go in `packages/core`. oRPC handlers, server functions and worker jobs stay thin: parse the
  input with a contract schema, resolve the actor, call a core service.
- A new API route starts in `packages/contracts`. The web app, the API and the CLI share those types.
- Core services take a context object. They never read `process.env`; the apps read configuration once at
  startup.
- Tests sit next to the code as `*.test.ts`. Web `*.test.tsx` files run in jsdom with Testing Library.
  Database tests run against real Postgres, not mocks.
- Start each module with a short comment on what it does and why.
- User-visible changes get a line under the Unreleased heading in [CHANGELOG.md](CHANGELOG.md).

## UI conventions

- Screens live in `apps/web/src/features/<area>`. Routes are files in `apps/web/src/routes`;
  `routeTree.gen.ts` is generated, so never edit it by hand.
- Build screens from the kit in `apps/web/src/ui` and import it from `~/ui`. Run `pnpm dev` and open
  http://localhost:3000/__ui (add `?theme=dark`) to see every component.
- Style with Tailwind utilities that map to `apps/web/src/styles/tokens.css`. Tailwind's default colours,
  type scale, radii and shadows are switched off. Text sizes are `text-xs` to `text-3xl`; a test fails on
  hand-set sizes such as `text-[13px]`.
- Use the React Aria state variants (`hover:`, `focus-visible:`, `pressed:`, `selected:`, `disabled:`).
- Every screen works in light and dark. A `.light` or `.dark` class forces a theme for its subtree.
- The app is keyboard-first. A new shortcut goes in `features/shell/shortcut-list.ts` and
  [docs/keyboard.md](docs/keyboard.md).
- Render relative and local times only once `useNow()` from `features/tasks/clock.ts` returns a value.
  The server and the browser disagree on clock and time zone, and the mismatch breaks hydration.
- Design hand-offs for UI work live under `.agent/design/<milestone>/`.

## Commits and pull requests

- Commit messages follow Conventional Commits: `type(scope): summary`, lowercase, present tense, no final
  period. Types in use: `feat`, `fix`, `perf`, `refactor`, `test`, `docs`, `ci`, `chore`, `style`. The
  scope is the app or package (`web`, `cli`, `core`, `db`, `contracts`, `worker`, `backlog`, `e2e`). Mark
  breaking changes with `!`, as in `refactor!: rename project-management to Zamu`.
- Branch from `main` with a prefix that matches the type: `feat/...`, `fix/...`, `docs/...`, `chore/...`.
- Open a pull request against `main`. The CI workflow (`.github/workflows/ci.yml`) runs five jobs, and all
  must pass: `lint`, `typecheck`, `test` (with a Postgres service), `docker-build` (builds the image and
  waits for `/api/healthz`) and `e2e`.

## Security

Do not open a public issue for a vulnerability. Report it privately through GitHub's private vulnerability
reporting: the Security tab of https://github.com/reddevsdotio/zamu, then "Report a vulnerability".
