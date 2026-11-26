# Self-hosting

Zamu runs as one Docker image with three roles, started by `docker-compose.yml`:

| Service   | What it does                                                                               |
| --------- | ------------------------------------------------------------------------------------------ |
| `db`      | Postgres 18. The only service that keeps state, in the `pgdata` volume.                    |
| `migrate` | Applies database migrations, then exits. Runs on every `docker compose up`.                |
| `web`     | The web app, the REST API (`/api/v1`) and sign-in. Listens on port 3000.                   |
| `worker`  | Background jobs (pg-boss): ends due cycles, expires invitations, reads Backlog.md mirrors. |

`web` and `worker` start only after `migrate` has finished without errors.

## Requirements

- Docker Engine with the Compose plugin (`docker compose version` prints v2 or later).
- Git, to get the source. There is no published image yet: compose builds it from the checkout.
- About 1.5 GB of disk for the image and its build cache, plus room for your data.
- A free TCP port for the web app (3000 unless you change `PORT`).

## Configure

```sh
git clone https://github.com/reddevsdotio/zamu.git
cd zamu
cp .env.example .env
```

Edit `.env`:

| Variable                  | Required | Default                 | Meaning                                                                                                                       |
| ------------------------- | -------- | ----------------------- | ----------------------------------------------------------------------------------------------------------------------------- |
| `BETTER_AUTH_SECRET`      | yes      | none                    | Signs sessions. 32 characters or more: `openssl rand -base64 32`. Without it, compose and the image refuse to start.          |
| `BETTER_AUTH_URL`         | no       | `http://localhost:3000` | The URL people type in their browser. Sign-in fails when it does not match.                                                   |
| `PUBLIC_URL`              | no       | `http://localhost:3000` | Base URL for invitation links. Use the same value as `BETTER_AUTH_URL`.                                                       |
| `PORT`                    | no       | `3000`                  | Host port the web app is published on.                                                                                        |
| `POSTGRES_USER`           | no       | `postgres`              | Database user.                                                                                                                |
| `POSTGRES_PASSWORD`       | no       | `postgres`              | Database password. Set it before the first start: Postgres only reads it when it creates the volume.                          |
| `POSTGRES_DB`             | no       | `zamu`                  | Database name.                                                                                                                |
| `ZAMU_IMAGE`              | no       | `zamu:local`            | Tag of the image compose builds and runs.                                                                                     |
| `APP_TIME_ZONE`           | no       | `UTC`                   | IANA time zone, such as `Europe/Brussels`. Decides when "today" starts for cycles. See below.                                 |
| `APP_ENCRYPTION_KEY`      | no       | none                    | Encrypts git tokens. Without it, git connections and Backlog.md mirrors are off. See [below](#git-connections-and-backlogmd). |
| `GIT_ALLOW_PRIVATE_HOSTS` | no       | `false`                 | `true` lets git connections reach hosts on private networks.                                                                  |
| `GIT_HTTP_HOSTS`          | no       | none                    | Comma-separated git hosts reached over plain HTTP. For test containers only.                                                  |
| `WORKSPACE_CREATION`      | no       | `everyone`              | Who may create a workspace: `everyone` or `owners`. See [Workspaces](#workspaces).                                            |

`DATABASE_URL` and `TEST_DATABASE_URL` in `.env` are for local development. Compose ignores them: the
containers reach Postgres as `db` on their own network.

If you change `PORT`, change the port in `BETTER_AUTH_URL` and `PUBLIC_URL` too.

### Workspaces

One server holds as many workspaces as people create. Each has its own projects, members, agents and API
keys, and its pages live under `/w/<slug>/`. A person can belong to several and switch between them in the
web app; an agent and an API key belong to one.

`WORKSPACE_CREATION` decides who may create one:
- `everyone` (the default): any person signed in.
- `owners`: only people who already own a workspace. Everyone else joins through invitations.

Agents never create workspaces, and the REST API and the CLI have no route for it. Any other value stops
the server at start with a message.

### Time zone and cycle ends

A cycle runs until the end of its end date and then ends by itself: the worker checks every hour, on the
hour, and ends each cycle whose end date is before today. Unfinished tasks move to the next planned cycle,
or to a new one of the same length when none is planned. Both `web` and `worker` count "today" in
`APP_TIME_ZONE`, so with `APP_TIME_ZONE=Europe/Brussels` a cycle ending on Sunday closes within the hour
after midnight Brussels time. The web app uses the same zone for days left and overdue milestones.

The same zone sets the nightly archive, which runs at 02:30 there and counts a project's archive days in
it, and the day a check-again date becomes "today".

The zone is one setting for the whole server. A team spread over several zones sees cycles end at that
zone's midnight. An invalid name stops both services at start: `docker compose logs web worker` names it.

## Git connections and Backlog.md

Projects can mirror or import the tasks a repository keeps in a Backlog.md folder (see
[backlog-md.md](backlog-md.md)), and link the pull requests of their repository to tasks (see
[repositories.md](repositories.md)). The server reads both through the git host's API, with an access token
that an admin saves in Settings > Git connections, or without one for a public repository. Four settings
matter for that.

### APP_ENCRYPTION_KEY

The server encrypts the access tokens and the webhook secrets in the database with this key (AES-256-GCM),
for Backlog.md mirrors and for repository webhooks alike. It is 32 random bytes, base64-encoded:

```sh
openssl rand -base64 32
```

Put it in `.env` and run `docker compose up -d`. The web app and the worker both need it, and compose gives
it to both.

Without the key the server starts and works as before, but the Git connections page and the Backlog.md setup
say that the key must be set, nobody can add a connection, and no repository webhook secret can be issued.
Pull requests of public repositories still link through the hourly check. Mirrors that already exist pause at their next
refresh. A key that is set but is not base64, or does not decode to 32 bytes, stops the web app and the worker
at start; `docker compose logs web worker` says why.

Back the key up, and keep it apart from the database dumps: a dump plus its key gives access to every saved
token. A database restored without its key still runs, but the saved tokens cannot be read. If the key is
lost or changed:
- mirrors pause with "A stored secret cannot be read with the current APP_ENCRYPTION_KEY";
- an admin edits each connection in Settings > Git connections and pastes the token again, which resumes its
  mirrors;
- webhooks of existing mirrors stop working, because their secrets cannot be read. The webhook dialog in the
  project's Settings > Backlog.md says so; an owner or admin presses New secret there and pastes the new
  secret into the git host. The URL stays the same. Until then those mirrors still refresh every hour, on
  Refresh now, and with `zamu backlog refresh`. Repository webhooks fail their signature check the same way:
  issue a new secret on the project's Settings > Repository page.

There is no key rotation. Keep the same key for the life of the server.

### Private networks: GIT_ALLOW_PRIVATE_HOSTS

A connection makes the server call whatever host an admin typed. By default, every request first checks that
the host resolves to a public address, so a connection cannot reach services inside your network. For a
self-hosted GitLab, Gitea or Forgejo on a private network, set:

```sh
GIT_ALLOW_PRIVATE_HOSTS=true
```

Loopback and private ranges are then allowed. Link-local addresses (`169.254.0.0/16`) and cloud metadata
addresses (`fd00:ec2::254`) are always refused. The check runs before every request and every redirect.

### Plain HTTP: GIT_HTTP_HOSTS

Connections use HTTPS. `GIT_HTTP_HOSTS` lists hosts, with or without their port, that the server reaches
over plain HTTP instead, for example a Forgejo test container:

```sh
GIT_HTTP_HOSTS=forgejo:3000,localhost
```

The token travels in clear text on those connections. Do not list a production git host.

### Custom certificate authorities: NODE_EXTRA_CA_CERTS

If your git host's certificate comes from an internal CA, give Node the CA certificate in PEM format. Compose
reads a `docker-compose.override.yml` next to `docker-compose.yml` on its own, so add one:

```yaml
services:
  web:
    environment:
      NODE_EXTRA_CA_CERTS: /certs/internal-ca.pem
    volumes:
      - /etc/zamu/internal-ca.pem:/certs/internal-ca.pem:ro
  worker:
    environment:
      NODE_EXTRA_CA_CERTS: /certs/internal-ca.pem
    volumes:
      - /etc/zamu/internal-ca.pem:/certs/internal-ca.pem:ro
```

Keep the certificate outside the checkout and readable by everyone (the containers run as UID 1000, see
[Container user](#container-user)).
Node reads the file once at start, so run `docker compose up -d` after you change it. Without it, testing the
connection fails with "Host unreachable" and a certificate error code, such as
`UNABLE_TO_VERIFY_LEAF_SIGNATURE`.

### Webhooks

A mirror refreshes within seconds of a push, and a pull request shows on its task within seconds of an
event, when the git host can deliver a webhook to

```text
{PUBLIC_URL}/api/webhooks/backlog/<id>
{PUBLIC_URL}/api/webhooks/repository/<id>
```

The URLs are built from `PUBLIC_URL`, so set that to the address the git host can reach. Things to check:
- GitHub.com and GitLab.com need a public URL. Behind a firewall, allow `POST` to `/api/webhooks/backlog/`
  and `/api/webhooks/repository/` from the host's webhook addresses.
- A reverse proxy must pass the request body untouched. Push payloads are usually small, but a push with many
  commits can pass nginx's default 1 MB limit (`client_max_body_size`). The app accepts up to 25 MB.
- A self-hosted GitLab refuses webhooks to private addresses unless an admin allows them (Admin > Settings >
  Network > Outbound requests > Allow requests to the local network from webhooks and integrations).
- Gitea and Forgejo refuse them unless `[webhook] ALLOWED_HOST_LIST` in `app.ini` includes the app's
  address (for example `private` or the host name).

Without a working webhook, mirrors still read the default branch every hour, at 15 minutes past the hour
(UTC), and on Refresh now. The webhook dialog in Settings > Backlog.md shows when the last notification
arrived. Pull requests are checked every hour at 45 minutes past (UTC), and on Check now in Settings >
Repository, which also shows how the last delivery went.

## Start

```sh
docker compose up -d --build
docker compose ps
curl http://localhost:3000/api/healthz
```

The first build takes a few minutes. `/api/healthz` answers `{"status":"ok"}` once the web app can reach
Postgres. `docker compose ps` lists `migrate` as exited (code 0); that is expected.

Logs: `docker compose logs -f web worker`.

Without `BETTER_AUTH_SECRET`, compose stops before it starts anything. A container started some other way
(`docker run`, Kubernetes) exits with code 1 before it listens and logs:

```text
BETTER_AUTH_SECRET is not set. Generate one with `openssl rand -base64 32` and set it in .env or the container environment.
```

A secret under 32 characters stops it the same way, with "BETTER_AUTH_SECRET is N characters; use 32 or
more." followed by the same advice.

### Container user

The image runs as UID 1000 and GID 1000 (the `node` user of the Node base image), set by number. It writes
only to `/tmp` and its home directory, `/home/node`. Things to keep in mind:
- If you override the user (`user:` in compose, `--user` with `docker run`), keep it a number other than 0.
  A name such as `node` makes Kubernetes' `runAsNonRoot` check fail.
- Anything you mount into `web`, `worker` or `migrate` must be readable by UID 1000, and writable by it if
  the app has to write there. The Postgres volume belongs to the `db` service, which runs as its own user.

On Kubernetes, give the web, worker and migrate containers this `securityContext`, which meets the
restricted Pod Security Standard:

```yaml
securityContext:
  runAsNonRoot: true
  runAsUser: 1000
  runAsGroup: 1000
  allowPrivilegeEscalation: false
  capabilities:
    drop: [ALL]
  seccompProfile:
    type: RuntimeDefault
```

## First run

Open `BETTER_AUTH_URL` in a browser. A new server sends you to the setup page:
1. Create the admin account: your name, email and a password of 12 characters or more, or "Continue with
   {name}" when [single sign-on](#single-sign-on-oidc) is configured.
2. Name the workspace, usually your team or company.

You land on Home, signed in. Setup runs once; afterwards `/setup` sends visitors to sign in. It stays done
when more workspaces are created and when the first one is deleted while others remain: people without a
workspace get a screen that lets them create one (when `WORKSPACE_CREATION` allows it) or tells them to ask
an owner for an invitation.

Nobody can sign up on their own. To add people, go to Settings > Members > Invite person, pick a role and copy
the invitation link. No email is sent: share the link yourself. It works once and expires after a week.

To add an AI agent, see [agents.md](agents.md).

## Single sign-on (OIDC)

People can sign in with one OpenID Connect provider (Authentik, Keycloak, Zitadel, Entra ID, ...). Without
these variables the server uses email and password only.
1. In the provider, create a confidential OAuth2/OpenID client with the authorization code flow and register
   this redirect (callback) URL:

   ```text
   {BETTER_AUTH_URL}/api/auth/oauth2/callback/oidc
   ```

   For example `https://projects.example.com/api/auth/oauth2/callback/oidc`. The provider must send `email`
   and `email_verified`; the `openid email profile` scopes do that for most providers.
2. Set the variables in `.env` and run `docker compose up -d`:

| Variable             | Default                | Meaning                                                             |
| -------------------- | ---------------------- | ------------------------------------------------------------------- |
| `OIDC_ISSUER`        | none                   | Issuer URL. Discovery: `{issuer}/.well-known/openid-configuration`. |
| `OIDC_CLIENT_ID`     | none                   | Client ID from the provider.                                        |
| `OIDC_CLIENT_SECRET` | none                   | Client secret from the provider.                                    |
| `OIDC_PROVIDER_NAME` | `SSO`                  | Button label: "Continue with {name}".                               |
| `OIDC_SCOPES`        | `openid email profile` | Space-separated scopes. `openid` is always requested.               |
| `OIDC_SIGNUP`        | `invite`               | Who gets an account on first SSO sign-in: see below.                |
| `OIDC_ADMIN_GROUPS`  | none                   | Comma-separated groups whose members are workspace admins.          |
| `OIDC_GROUPS_CLAIM`  | `groups`               | Claim with the user's groups. Authentik sends `groups`.             |
| `OIDC_TRUST_EMAIL`   | `false`                | `true`: treat the provider's email as verified. See below.          |
| `OIDC_WORKSPACE`     | the oldest workspace   | Slug of the workspace that auto sign-up and admin groups apply to.  |
| `PASSWORD_LOGIN`     | `enabled`              | `disabled`: SSO only. Needs the three `OIDC_*` credentials.         |

SSO is on when `OIDC_ISSUER`, `OIDC_CLIENT_ID` and `OIDC_CLIENT_SECRET` are all set.
- `OIDC_SIGNUP=invite`: SSO signs in existing accounts (matched by verified email) and accepts pending
  invitations. Nobody else gets in.
- `OIDC_SIGNUP=auto`: anyone the provider signs in gets a member account in the workspace on first sign-in.
  Limit who that is in the provider (for example, bind the application to a group).
- `OIDC_ADMIN_GROUPS`: members of any listed group are admins, everyone else is a member. The role is
  re-applied at every SSO sign-in, so removing someone from the group demotes them at their next sign-in.
  Owners keep their role. If the provider stops sending the groups claim, everyone but the owner becomes a
  member.
- `OIDC_TRUST_EMAIL=true`: the provider's email counts as verified even when its `email_verified` claim is
  `false` or missing. Use it for providers that never mark emails as verified, such as Authentik with its
  default mappings. The trade-off: SSO matches people by email (to sign in, to link an existing account, to
  accept an invitation). If people can change their own email at the provider, someone you let in could set
  another person's address and sign in as them. Turn it on only when emails at the provider are managed by
  admins, or when everyone the provider admits is trusted.
- `OIDC_WORKSPACE`: SSO works for every workspace, but auto sign-up and admin groups apply to one of them:
  the workspace with this slug (an old slug of it works too), else the oldest workspace. Invitations still
  open the workspace that sent them, and admin groups don't change roles in other workspaces. Set before
  setup, the first workspace takes this slug. Once setup is done, a slug that names no workspace stops the
  server at start.
- `PASSWORD_LOGIN=disabled` removes the password form from sign-in, setup and invitations, and the server
  refuses password sign-in. API keys (agents, the CLI) keep working.

What SSO does:
- **Sign-in** shows "Continue with {name}" above the password form, or alone with `PASSWORD_LOGIN=disabled`.
  Errors from the provider (consent denied, no account in `invite` mode) come back to the sign-in page as a
  banner.
- **First run**: the setup page offers SSO for the admin account. The first person to finish it becomes the
  admin and then names the workspace. Once anyone exists, setup through SSO is refused.
- **Invitations**: the invitation page offers SSO. The provider's verified email must be the invited address;
  otherwise the page explains the mismatch and nothing is created.
- **Existing accounts** link to the SSO identity with the same verified email, so people invited before SSO
  keep their account. Unverified emails are refused, unless `OIDC_TRUST_EMAIL=true`. Agents are never linked to an SSO identity; they keep
  using API keys.
- **Signing out** ends the session here only, not at the provider.

The server checks the configuration when it starts and exits with a message listing every problem, for
example `PASSWORD_LOGIN=disabled` without SSO, only some of the three `OIDC_*` credentials, a malformed
`OIDC_ISSUER`, an `OIDC_TRUST_EMAIL` other than `true` or `false`, an `OIDC_WORKSPACE` that names no
workspace, a `WORKSPACE_CREATION` other than `everyone` or `owners`, an invalid `TRUSTED_IP_HEADERS`, or a
`BETTER_AUTH_SECRET` shorter than 32 characters: `docker compose logs web` shows it.

### Authentik

1. Applications > Providers > Create > OAuth2/OpenID Provider. Client type confidential, redirect URI as
   above (strict), signing key set (so ID tokens are signed with RS256), scopes `openid`, `email`, `profile`.
2. Applications > Create, with this provider. Bind the groups or users that may sign in.
3. `.env`:

   ```sh
   OIDC_ISSUER=https://auth.example.com/application/o/<application-slug>/
   OIDC_CLIENT_ID=<client id>
   OIDC_CLIENT_SECRET=<client secret>
   OIDC_PROVIDER_NAME=Authentik
   # Optional:
   OIDC_SIGNUP=auto
   OIDC_ADMIN_GROUPS=<admin group>
   PASSWORD_LOGIN=disabled
   ```

Authentik's default `email` scope mapping always sends `email_verified: false`, so every sign-in is refused
until you pick one of these:
- Set `OIDC_TRUST_EMAIL=true` (read the trade-off above first).
- Or send a verified claim yourself: Customization > Property Mappings > Create > Scope Mapping, with a scope
  name such as `zamu-email` and the expression
  `return {"email": request.user.email, "email_verified": True}`. Add it to the provider's scopes, and request
  it instead of `email`: `OIDC_SCOPES=openid profile zamu-email`. Only do this if users cannot change their
  own email in Authentik, for the same reason.

## Ports

| Port | Service | Published                                                                |
| ---- | ------- | ------------------------------------------------------------------------ |
| 3000 | `web`   | Yes, on the host port in `PORT`. Git hosts send webhooks to it too.      |
| 5432 | `db`    | No. Only `migrate`, `web` and `worker` reach it, on the compose network. |

The worker listens on no port. Because Postgres is not published, this stack can run next to another Postgres
on the same machine.

For HTTPS, put a reverse proxy (Caddy, nginx, Traefik) in front of port 3000 and set `BETTER_AUTH_URL` and
`PUBLIC_URL` to the public `https://` URL. Then `docker compose up -d` to apply the change.

### Client IP behind a proxy

Sign-in rate limits and the session list use the client's IP address. By default it comes from
`X-Forwarded-For`, and only when that header holds a single address. Behind several proxies (a CDN, then an
ingress) the header holds a chain, the server cannot tell who the client is, and the log says rate limiting
"could not determine a client IP". Then all clients share one rate-limit bucket per path.

`TRUSTED_IP_HEADERS` lists the headers to read instead, comma-separated, checked in order. Behind Cloudflare:

```sh
TRUSTED_IP_HEADERS=cf-connecting-ip,x-forwarded-for
```

Only list headers that your proxy sets or overwrites on every request. A client can send any header it likes,
so a header that reaches the app straight from the client lets anyone pick their own IP and get around the
rate limit. For example, list `cf-connecting-ip` only when the app can be reached through Cloudflare alone.

## Backups

All state lives in Postgres. Dump it with `pg_dump` from the `db` container:

```sh
mkdir -p ~/zamu-backups
docker compose exec -T db sh -c 'pg_dump -U "$POSTGRES_USER" -d "$POSTGRES_DB" -Fc' > ~/zamu-backups/zamu-$(date +%F).dump
```

This works while the app runs. Keep the dumps outside the checkout (anything in it ends up in the image build
context) and copy them to another machine. A backup is also the only way back from deleting a project,
which has no undo: restoring one brings back the whole database as it was. Back up `APP_ENCRYPTION_KEY` as well, stored apart from the dumps: without
it, a restored database cannot read its git tokens (see [APP_ENCRYPTION_KEY](#app_encryption_key)).

To restore, stop the app, recreate the database, load the dump and start again:

```sh
docker compose stop web worker
docker compose exec -T db sh -c 'dropdb -U "$POSTGRES_USER" --force "$POSTGRES_DB" && createdb -U "$POSTGRES_USER" "$POSTGRES_DB"'
docker compose exec -T db sh -c 'pg_restore -U "$POSTGRES_USER" -d "$POSTGRES_DB" --no-owner' < ~/zamu-backups/zamu-2026-10-22.dump
docker compose up -d
```

Recreate the database rather than restoring with `pg_restore --clean`: the job queue uses partitioned tables,
and `--clean` fails on them.

To restore on a new machine, configure `.env` as above, start only the database (`docker compose up -d db`),
run the two `docker compose exec` lines, then `docker compose up -d --build`.

## Upgrades

```sh
docker compose exec -T db sh -c 'pg_dump -U "$POSTGRES_USER" -d "$POSTGRES_DB" -Fc' > ~/zamu-backups/zamu-before-upgrade.dump
git pull
docker compose up -d --build
```

Compose rebuilds the image, runs `migrate` against the existing database, then restarts `web` and `worker`.
If a migration fails, `web` and `worker` do not start: `docker compose logs migrate` shows why.

Upgrading from 0.1.x (M1) adds milestones, cycles, comments and the board. The migration gives every
existing task a board position that keeps its list order (priority, then most recently updated) inside its
status, and turns milestones and cycles on for every project. Nothing else needs doing.

Upgrading from 0.3.x (M2.1) to 0.4 (M3) adds git connections and Backlog.md mirrors. The migration only adds
tables and columns: every task keeps its key. Set `APP_ENCRYPTION_KEY` before or after the upgrade to turn
the new features on.

Upgrading to 0.6 adds three indexes that the dashboard's agent and Everyone queries rely on. Run the
migration before the new `web` serves traffic, or the dashboard is slow on large workspaces until it runs.
Compose does this already (`migrate` finishes before `web` and `worker` start). On Kubernetes, run the
migrate job before you roll out `web` and `worker`.

Upgrading from 0.6 to 0.7 (M5) adds labels, due dates, blockers and subtasks. The schema migration only adds
tables and columns. A second migration copies the labels, due dates, dependencies and parents of every task
mirrored or imported from Backlog.md out of its stored Backlog.md data into the new fields. It reads nothing
from git and writes no history lines, and the next refresh of each mirror changes nothing for files that
did not change. Display options and the sidebar state are kept in each browser, so people start on the
defaults.

Upgrading from 0.9 to 0.10 puts every page under the workspace's slug: `/p/PAY/PAY-142` becomes
`/w/<slug>/p/PAY/PAY-142`. Old links, bookmarks included, redirect (307) to the same page in the workspace
the person used last. The migration keeps every slug that is valid in a URL (2 to 40 lower-case letters,
digits and single hyphens, starting with a letter, not a reserved word such as `api` or `settings`). A slug
that isn't is rewritten, and the old one is kept as an alias when it can be. Each person's workspace used
last starts as their oldest one. Logins stored by `zamu` 0.9 are converted on the first command that
reaches the server ([agents.md](agents.md#several-workspaces)).

Upgrading from 0.10 adds pull requests, the archive and check-again days. The migration adds tables and
columns, and fills `closed_at` for every Done or Canceled task from its history (else its last update).
Archiving stays off for every existing project; projects created afterwards start with 14 days. Tasks of
active Backlog.md mirrors whose file is under `archive/tasks/` come back archived; imported projects keep
those tasks as they were. Projects with a repository get their repository link the first time it is needed,
with close on merge on. The first hourly check after the upgrade links the requests it finds and moves no
task; merges after that move tasks to Done. Turn close on merge off in Settings > Repository for projects
where people close tasks by hand.

The end-to-end suite checks these paths: it starts 0.1.1 and adds data, switches to 0.3.0 and adds more, to
0.6.0 and sets up a Backlog.md mirror, then switches to the new image and checks the mirror's backfill.

## The CLI in the image

The image ships the `zamu` CLI. It is handy for checking a key from the server:

```sh
docker compose exec -e ZAMU_KEY=zamu_live_... web zamu whoami
```

Agents normally run `zamu` on their own machine. See [agents.md](agents.md).

## Stop or remove

```sh
docker compose down        # stops the stack, keeps the data volume
docker compose down -v     # also deletes the data volume: everything is gone
```
