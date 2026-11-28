# Self-hosting

This page is for the person who installs and runs a Zamu server. The first four sections take you from a
clone to a running server on one machine, with an admin account and a workspace. [Backups](#backups) and
[Upgrades](#upgrades) come next, because every server needs them.

The other sections are optional:

| Section                                                          | Read it when                                                                 |
| ---------------------------------------------------------------- | ---------------------------------------------------------------------------- |
| [Workspaces](#workspaces)                                        | You want to limit who may create a workspace.                                |
| [Time zone and cycle ends](#time-zone-and-cycle-ends)            | The server should count days in a zone other than UTC.                       |
| [Ports](#ports)                                                  | You put the server behind HTTPS or a reverse proxy.                          |
| [Single sign-on (OIDC)](#single-sign-on-oidc)                    | People should sign in through an OpenID Connect provider.                    |
| [Git connections and Backlog.md](#git-connections-and-backlogmd) | Projects link pull requests or read Backlog.md task files from a repository. |
| [Kubernetes](#kubernetes)                                        | You run Zamu on a Kubernetes cluster with the Helm chart.                    |
| [Container user](#container-user)                                | You mount files into the containers, or run the image on Kubernetes.         |
| [The CLI in the image](#the-cli-in-the-image)                    | You want to check an API key from the server.                                |

## Requirements

- Docker Engine with the Compose plugin. `docker compose version` prints v2 or later.
- Git, to get the source. Compose builds the image from the checkout. Each release is also published as
  `ghcr.io/reddevsdotio/zamu`, which the [Kubernetes](#kubernetes) chart runs.
- About 1.5 GB of disk for the image and its build cache, plus room for your data.
- A free TCP port for the web app. That is 3000 unless you change `PORT`.

## Configure

1. Get the source and create `.env`:

   ```sh
   git clone https://github.com/reddevsdotio/zamu.git
   cd zamu
   cp .env.example .env
   ```

2. Generate a secret and set it as `BETTER_AUTH_SECRET` in `.env`:

   ```sh
   openssl rand -base64 32
   ```

That is enough for a server on `http://localhost:3000`. `BETTER_AUTH_SECRET` is the only variable you must
set. The others have defaults:

| Variable                  | Required | Default                 | Meaning                                                                                                                               |
| ------------------------- | -------- | ----------------------- | ------------------------------------------------------------------------------------------------------------------------------------- |
| `BETTER_AUTH_SECRET`      | yes      | none                    | Signs sessions. 32 characters or more, for example from `openssl rand -base64 32`. Without it, compose and the image refuse to start. |
| `BETTER_AUTH_URL`         | no       | `http://localhost:3000` | The URL people type in their browser. Sign-in fails when it does not match.                                                           |
| `PUBLIC_URL`              | no       | `http://localhost:3000` | Base URL for invitation links. Use the same value as `BETTER_AUTH_URL`.                                                               |
| `PORT`                    | no       | `3000`                  | Host port the web app is published on.                                                                                                |
| `POSTGRES_USER`           | no       | `postgres`              | Database user.                                                                                                                        |
| `POSTGRES_PASSWORD`       | no       | `postgres`              | Database password. Set it before the first start, because Postgres reads it only when it creates the volume.                          |
| `POSTGRES_DB`             | no       | `zamu`                  | Database name.                                                                                                                        |
| `ZAMU_IMAGE`              | no       | `zamu:local`            | Tag of the image compose builds and runs.                                                                                             |
| `APP_TIME_ZONE`           | no       | `UTC`                   | IANA time zone, such as `Europe/Brussels`. Decides when "today" starts for cycles.                                                    |
| `APP_ENCRYPTION_KEY`      | no       | none                    | Encrypts git tokens. Without it, git connections and Backlog.md mirrors are off.                                                      |
| `GIT_ALLOW_PRIVATE_HOSTS` | no       | `false`                 | `true` lets git connections reach hosts on private networks.                                                                          |
| `GIT_HTTP_HOSTS`          | no       | none                    | Comma-separated git hosts reached over plain HTTP. For test containers only.                                                          |
| `WORKSPACE_CREATION`      | no       | `everyone`              | Who may create a workspace, `everyone` or `owners`.                                                                                   |

Three of these have a section of their own: [Time zone and cycle ends](#time-zone-and-cycle-ends) for
`APP_TIME_ZONE`, [APP_ENCRYPTION_KEY](#app_encryption_key) and [Workspaces](#workspaces) for
`WORKSPACE_CREATION`.

A **git connection** is an access token for a git host that an admin saves in the app. A **mirror** is a
project that follows the task files a repository keeps in a Backlog.md folder. Both are optional. See
[Git connections and Backlog.md](#git-connections-and-backlogmd).

Three more things to know about `.env`:
- `DATABASE_URL` and `TEST_DATABASE_URL` are for local development. Compose ignores them, because the
  containers reach Postgres as `db` on their own network.
- If you change `PORT`, change the port in `BETTER_AUTH_URL` and `PUBLIC_URL` too.
- Single sign-on has its own variables, listed under [Single sign-on (OIDC)](#single-sign-on-oidc).
  `TRUSTED_IP_HEADERS` is described under [Client IP behind a proxy](#client-ip-behind-a-proxy).

## Start

Build the image, start the stack and check that it answers:

```sh
docker compose up -d --build
docker compose ps
curl http://localhost:3000/api/healthz
```

What to expect:
- The first build takes a few minutes.
- `docker compose ps` lists `migrate` as exited (code 0). That is expected.
- `/api/healthz` answers `{"status":"ok"}` once the web app can reach Postgres.

To follow the logs, run `docker compose logs -f web worker`.

### What compose starts

`docker-compose.yml` starts four services. `migrate`, `web` and `worker` are three roles of the one Zamu
image.

| Service   | What it does                                                                               |
| --------- | ------------------------------------------------------------------------------------------ |
| `db`      | Postgres 18. The only service that keeps state, in the `pgdata` volume.                    |
| `migrate` | Applies database migrations, then exits. Runs on every `docker compose up`.                |
| `web`     | The web app, the REST API (`/api/v1`) and sign-in. Listens on port 3000.                   |
| `worker`  | Background jobs (pg-boss): ends due cycles, expires invitations, reads Backlog.md mirrors. |

`web` and `worker` start only after `migrate` has finished without errors.

### If a container exits at start

Without `BETTER_AUTH_SECRET`, compose stops before it starts anything. A container started some other way,
with `docker run` or on Kubernetes, exits with code 1 before it listens and logs:

```text
BETTER_AUTH_SECRET is not set. Generate one with `openssl rand -base64 32` and set it in .env or the container environment.
```

A secret under 32 characters stops the container the same way. The message is "BETTER_AUTH_SECRET is N
characters; use 32 or more." followed by the same advice.

The server checks the rest of its configuration at start too. It exits with a message that lists every
problem, the secret included, and `docker compose logs web` shows it. Examples of what it refuses:
- `PASSWORD_LOGIN=disabled` without single sign-on
- only some of the three `OIDC_*` credentials
- a malformed `OIDC_ISSUER`
- an `OIDC_TRUST_EMAIL` other than `true` or `false`
- an `OIDC_WORKSPACE` that names no workspace
- a `WORKSPACE_CREATION` other than `everyone` or `owners`
- an invalid `TRUSTED_IP_HEADERS`

## First run

1. Open `BETTER_AUTH_URL` in a browser. A new server sends you to the setup page.
2. Create the admin account with your name, your email and a password of 12 characters or more. When
   [single sign-on](#single-sign-on-oidc) is configured, you can press "Continue with {name}" instead.
3. Name the workspace, usually after your team or company.

You land on Home, signed in.

### Add people and agents

Nobody can sign up on their own. To add a person:
1. Go to Settings > Members > Invite person.
2. Pick a role and copy the invitation link.
3. Share the link yourself. Zamu sends no email.

The link works once and expires after a week.

To add an AI agent, see [agents.md](agents.md).

### Setup runs once

After setup, `/setup` sends visitors to sign in. Setup stays done when people create more workspaces. It
also stays done when the first workspace is deleted while others remain.

People without a workspace get a screen. It lets them create a workspace when `WORKSPACE_CREATION` allows
it, and otherwise tells them to ask an owner for an invitation.

## Backups

All state lives in Postgres, so a backup is a database dump. Run `pg_dump` in the `db` container:

```sh
mkdir -p ~/zamu-backups
docker compose exec -T db sh -c 'pg_dump -U "$POSTGRES_USER" -d "$POSTGRES_DB" -Fc' > ~/zamu-backups/zamu-$(date +%F).dump
```

This works while the app runs.

Look after the dumps:
- Keep them outside the checkout. Anything in the checkout ends up in the image build context.
- Copy them to another machine.
- Back up `APP_ENCRYPTION_KEY` as well, and store it apart from the dumps. Without the key, a restored
  database cannot read its git tokens. See [APP_ENCRYPTION_KEY](#app_encryption_key).

Deleting a project has no undo. A backup is the only way back, and restoring one brings back the whole
database as it was.

### Restore

Stop the app, recreate the database, load the dump and start again:

```sh
docker compose stop web worker
docker compose exec -T db sh -c 'dropdb -U "$POSTGRES_USER" --force "$POSTGRES_DB" && createdb -U "$POSTGRES_USER" "$POSTGRES_DB"'
docker compose exec -T db sh -c 'pg_restore -U "$POSTGRES_USER" -d "$POSTGRES_DB" --no-owner' < ~/zamu-backups/zamu-2026-10-22.dump
docker compose up -d
```

The second command drops the current database. Everything written since the dump is gone.

Recreate the database instead of restoring with `pg_restore --clean`. The job queue uses partitioned tables,
and `--clean` fails on them.

### Restore on a new machine

1. Configure `.env` as in [Configure](#configure).
2. Start only the database with `docker compose up -d db`.
3. Run the two `docker compose exec` lines from the restore above.
4. Run `docker compose up -d --build`.

## Upgrades

Back up the database, pull the new source and rebuild:

```sh
docker compose exec -T db sh -c 'pg_dump -U "$POSTGRES_USER" -d "$POSTGRES_DB" -Fc' > ~/zamu-backups/zamu-before-upgrade.dump
git pull
docker compose up -d --build
```

Compose rebuilds the image, runs `migrate` against the existing database, then restarts `web` and `worker`.

If a migration fails, `web` and `worker` do not start. `docker compose logs migrate` shows why.

The notes below cover what each release changes and anything you have to do.

### From 0.1.x (M1)

The upgrade adds milestones, cycles, comments and the board. The migration does two things:
- It gives every existing task a board position that keeps its list order inside its status. The list order
  is priority, then most recently updated.
- It turns milestones and cycles on for every project.

Nothing else needs doing.

### From 0.3.x (M2.1) to 0.4 (M3)

The upgrade adds git connections and Backlog.md mirrors. The migration only adds tables and columns, so
every task keeps its key. Set `APP_ENCRYPTION_KEY` before or after the upgrade to turn the new features on.

### To 0.6

The upgrade adds three indexes that the dashboard's agent and Everyone queries rely on.

Run the migration before the new `web` serves traffic. Otherwise the dashboard is slow on large workspaces
until the migration runs. Compose does this already, because `migrate` finishes before `web` and `worker`
start. On Kubernetes, run the migrate job before you roll out `web` and `worker`. The Helm chart does this
for you, see [Kubernetes](#kubernetes).

### From 0.6 to 0.7 (M5)

The upgrade adds labels, due dates, blockers and subtasks. Two migrations run:
1. The schema migration only adds tables and columns.
2. A second migration covers every task mirrored or imported from Backlog.md. It copies the task's labels,
   due dates, dependencies and parents out of its stored Backlog.md data into the new fields.

The second migration reads nothing from git and writes no history lines. The next refresh of each mirror
changes nothing for files that did not change.

Display options and the sidebar state are kept in each browser, so people start on the defaults.

### From 0.9 to 0.10

The upgrade puts every page under the workspace's slug. `/p/PAY/PAY-142` becomes `/w/<slug>/p/PAY/PAY-142`.
- Old links, bookmarks included, redirect (307) to the same page in the workspace the person used last.
  Each person's workspace used last starts as their oldest one.
- The migration keeps every slug that is valid in a URL. A valid slug has 2 to 40 lower-case letters, digits
  and single hyphens, starts with a letter and is not a reserved word such as `api` or `settings`.
- The migration rewrites a slug that is not valid, and keeps the old one as an alias when it can.
- Logins stored by `zamu` 0.9 are converted on the first command that reaches the server. See
  [agents.md](agents.md#several-workspaces).

### From 0.10

The upgrade adds pull requests, the archive and check-again days. The migration adds tables and columns. It
also fills `closed_at` for every Done or Canceled task from its history, or else from its last update.
- Archiving stays off for every existing project. Projects created afterwards start with 14 days.
- Tasks of active Backlog.md mirrors whose file is under `archive/tasks/` come back archived. Imported
  projects keep those tasks as they were.
- Projects with a repository get their repository link the first time it is needed, with close on merge on.
- The first hourly check after the upgrade links the requests it finds and moves no task. Merges after that
  move tasks to Done.

Turn close on merge off in Settings > Repository for projects where people close tasks by hand.

### How the upgrade paths are tested

The end-to-end suite walks one database along these paths. It starts 0.1.1 and adds data, switches to 0.3.0
and adds more, then to 0.6.0, where it sets up a Backlog.md mirror. It passes through 0.8.0, 0.9.0 and
0.10.0 when those releases exist. Last, it switches to the new image and checks the mirror's backfill.
[e2e/README.md](../e2e/README.md#the-upgrade-spec) lists every step.

## Stop or remove

```sh
docker compose down        # stops the stack, keeps the data volume
docker compose down -v     # also deletes the data volume: everything is gone
```

The second command deletes the `pgdata` volume and all data with it. Take a [backup](#backups) first if you
want to keep the data.

## Workspaces

A **workspace** has its own projects, members, agents and API keys. One server holds as many workspaces as
people create, and each workspace's pages live under `/w/<slug>/`.

A person can belong to several workspaces and switch between them in the web app. An agent and an API key
belong to one.

`WORKSPACE_CREATION` decides who may create a workspace:

| Value                    | Who may create a workspace                                                        |
| ------------------------ | --------------------------------------------------------------------------------- |
| `everyone` (the default) | Any person signed in.                                                             |
| `owners`                 | Only people who already own a workspace. Everyone else joins through invitations. |

Agents never create workspaces, and the REST API and the CLI have no route for it.

Any other value stops the server at start with a message.

## Time zone and cycle ends

The server counts days in the time zone that `APP_TIME_ZONE` names. The default is `UTC`. Both `web` and
`worker` count "today" in that zone.

The zone decides four things:
- the midnight at which a cycle ends
- days left and overdue milestones in the web app
- the nightly archive, which runs at 02:30 in that zone and counts a project's archive days in it
- the day a check-again date becomes "today"

A cycle runs until the end of its end date and then ends by itself. The worker checks every hour, on the
hour, and ends each cycle whose end date is before today. With `APP_TIME_ZONE=Europe/Brussels`, a cycle
ending on Sunday closes within the hour after midnight Brussels time.

Unfinished tasks move to the next planned cycle, or to a new one of the same length when none is planned.

The zone is one setting for the whole server. A team spread over several zones sees cycles end at that
zone's midnight.

An invalid name stops both services at start. `docker compose logs web worker` names it.

## Ports

| Port | Service | Published                                                                |
| ---- | ------- | ------------------------------------------------------------------------ |
| 3000 | `web`   | Yes, on the host port in `PORT`. Git hosts send webhooks to it too.      |
| 5432 | `db`    | No. Only `migrate`, `web` and `worker` reach it, on the compose network. |

The worker listens on no port. Postgres is not published, so this stack can run next to another Postgres on
the same machine.

### HTTPS

For HTTPS:
1. Put a reverse proxy such as Caddy, nginx or Traefik in front of port 3000.
2. Set `BETTER_AUTH_URL` and `PUBLIC_URL` to the public `https://` URL.
3. Run `docker compose up -d` to apply the change.

### Client IP behind a proxy

Sign-in rate limits and the session list use the client's IP address. By default the server takes it from
`X-Forwarded-For`, and only when that header holds a single address.

Behind several proxies, such as a CDN and then an ingress, the header holds a chain. The server cannot tell
who the client is, and the log says rate limiting "could not determine a client IP". All clients then share
one rate-limit bucket per path.

`TRUSTED_IP_HEADERS` lists the headers to read instead. Separate them with commas. The server checks them in
order. Behind Cloudflare:

```sh
TRUSTED_IP_HEADERS=cf-connecting-ip,x-forwarded-for
```

Only list headers that your proxy sets or overwrites on every request. A client can send any header it
likes. A header that reaches the app straight from the client lets anyone pick their own IP and get around
the rate limit. For example, list `cf-connecting-ip` only when the app can be reached through Cloudflare
alone.

## Single sign-on (OIDC)

People can sign in with one OpenID Connect provider, such as Authentik, Keycloak, Zitadel or Entra ID. This
page calls that single sign-on, or SSO. Without the variables below, the server uses email and password
only.

### Set it up

1. In the provider, create a confidential OAuth2/OpenID client with the authorization code flow.
2. Register this redirect (callback) URL on the client:

   ```text
   {BETTER_AUTH_URL}/api/auth/oauth2/callback/oidc
   ```

   For example `https://projects.example.com/api/auth/oauth2/callback/oidc`.

3. Check that the provider sends `email` and `email_verified`. The `openid email profile` scopes do that for
   most providers.
4. Set `OIDC_ISSUER`, `OIDC_CLIENT_ID` and `OIDC_CLIENT_SECRET` in `.env`. SSO is on when all three are set.
5. Run `docker compose up -d`.

### Variables

| Variable             | Default                | Meaning                                                                               |
| -------------------- | ---------------------- | ------------------------------------------------------------------------------------- |
| `OIDC_ISSUER`        | none                   | Issuer URL. Discovery: `{issuer}/.well-known/openid-configuration`.                   |
| `OIDC_CLIENT_ID`     | none                   | Client ID from the provider.                                                          |
| `OIDC_CLIENT_SECRET` | none                   | Client secret from the provider.                                                      |
| `OIDC_PROVIDER_NAME` | `SSO`                  | Button label: "Continue with {name}".                                                 |
| `OIDC_SCOPES`        | `openid email profile` | Space-separated scopes. `openid` is always requested.                                 |
| `OIDC_SIGNUP`        | `invite`               | Who gets an account on first SSO sign-in.                                             |
| `OIDC_ADMIN_GROUPS`  | none                   | Comma-separated groups whose members are workspace admins. Everyone else is a member. |
| `OIDC_GROUPS_CLAIM`  | `groups`               | Claim with the user's groups. Authentik sends `groups`.                               |
| `OIDC_TRUST_EMAIL`   | `false`                | `true` treats the provider's email as verified.                                       |
| `OIDC_WORKSPACE`     | the oldest workspace   | Slug of the workspace that auto sign-up and admin groups apply to.                    |
| `PASSWORD_LOGIN`     | `enabled`              | `disabled` means SSO only. Needs the three `OIDC_*` credentials.                      |

[Who gets an account](#who-gets-an-account) explains `OIDC_SIGNUP`, and
[Emails the provider does not verify](#emails-the-provider-does-not-verify) explains `OIDC_TRUST_EMAIL`.

The server checks these variables when it starts and exits when they are wrong. See
[If a container exits at start](#if-a-container-exits-at-start).

### Who gets an account

`OIDC_SIGNUP` takes one of two values:

| Value                  | What SSO does                                                                                                    |
| ---------------------- | ---------------------------------------------------------------------------------------------------------------- |
| `invite` (the default) | SSO signs in existing accounts, matched by verified email, and accepts pending invitations. Nobody else gets in. |
| `auto`                 | Anyone the provider signs in gets a member account in the workspace on first sign-in.                            |

With `auto`, limit who can sign in at the provider, for example by binding the application to a group.

### Admin groups

With `OIDC_ADMIN_GROUPS` set, members of any listed group are admins and everyone else is a member.
- The server applies the role again at every SSO sign-in. Removing someone from the group demotes them at
  their next sign-in.
- Owners keep their role.
- If the provider stops sending the groups claim, everyone but the owner becomes a member.

### Emails the provider does not verify

With `OIDC_TRUST_EMAIL=true`, the provider's email counts as verified even when its `email_verified` claim
is `false` or missing. Use it for providers that never mark emails as verified, such as Authentik with its
default mappings.

Read the trade-off before you turn it on. SSO matches people by email to sign them in, to link an existing
account and to accept an invitation. If people can change their own email at the provider, someone you let
in could set another person's address and sign in as them.

Turn it on only when admins manage the emails at the provider, or when everyone the provider admits is
trusted.

### The workspace SSO applies to

SSO works for every workspace, but auto sign-up and admin groups apply to one of them. That is the workspace
whose slug is in `OIDC_WORKSPACE`. An old slug of that workspace works too. With the variable unset, it is
the oldest workspace.

Invitations still open the workspace that sent them, and admin groups don't change roles in other
workspaces.

If you set `OIDC_WORKSPACE` before setup, the first workspace takes this slug. Once setup is done, a slug
that names no workspace stops the server at start.

### SSO only

`PASSWORD_LOGIN=disabled` removes the password form from sign-in, setup and invitations, and the server
refuses password sign-in. API keys, which agents and the CLI use, keep working.

### What people see

- The sign-in page shows "Continue with {name}" above the password form, or alone with
  `PASSWORD_LOGIN=disabled`. Errors from the provider, such as consent denied or no account in `invite`
  mode, come back to the sign-in page as a banner.
- On first run, the setup page offers SSO for the admin account. The first person to finish it becomes the
  admin and then names the workspace. Once anyone exists, the server refuses setup through SSO.
- The invitation page offers SSO. The provider's verified email must be the invited address. Otherwise the
  page explains the mismatch and nothing is created.
- An existing account links to the SSO identity with the same verified email, so people invited before SSO
  keep their account. Unverified emails are refused, unless `OIDC_TRUST_EMAIL=true`.
- Agents are never linked to an SSO identity. They keep using API keys.
- Signing out ends the session here only, not at the provider.

### Authentik

1. Go to Applications > Providers > Create > OAuth2/OpenID Provider and set:
   - client type confidential
   - the redirect URI from [Set it up](#set-it-up), strict
   - a signing key, so ID tokens are signed with RS256
   - the scopes `openid`, `email`, `profile`

2. Go to Applications > Create and pick this provider. Bind the groups or users that may sign in.
3. Set these in `.env`:

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

Authentik's default `email` scope mapping always sends `email_verified: false`. The server refuses every
sign-in until you pick one of these:
- Set `OIDC_TRUST_EMAIL=true`. Read [the trade-off](#emails-the-provider-does-not-verify) first.
- Or send a verified claim yourself:
  1. Go to Customization > Property Mappings > Create > Scope Mapping. Give it a scope name such as
     `zamu-email` and the expression `return {"email": request.user.email, "email_verified": True}`.
  2. Add the mapping to the provider's scopes.
  3. Request it instead of `email` with `OIDC_SCOPES=openid profile zamu-email`.

  Only do this if users cannot change their own email in Authentik, for the same reason.

## Git connections and Backlog.md

A project can use its repository in two ways:
- It can mirror or import the tasks the repository keeps in a Backlog.md folder. A mirror keeps following
  the files, and an import reads them once. See [backlog-md.md](backlog-md.md).
- It can link the repository's pull requests to tasks. See [repositories.md](repositories.md).

The server reads both through the git host's API. It uses the access token of a git connection, which an
admin saves in Settings > Git connections. A public repository needs no token.

Four settings matter for that. [Webhooks](#webhooks) come after them.

### APP_ENCRYPTION_KEY

The server encrypts the access tokens and the webhook secrets in the database with this key, using
AES-256-GCM. It does so for Backlog.md mirrors and for repository webhooks alike. The key is 32 random
bytes, base64-encoded.

To set it:
1. Generate a key:

   ```sh
   openssl rand -base64 32
   ```

2. Put it in `.env` as `APP_ENCRYPTION_KEY`.
3. Run `docker compose up -d`.

The web app and the worker both need the key, and compose gives it to both.

Back the key up, and keep it apart from the database dumps. A dump plus its key gives access to every saved
token. A database restored without its key still runs, but the server cannot read the saved tokens.

There is no key rotation. Keep the same key for the life of the server.

#### Without the key

The server starts and works as before, with these limits:
- The Git connections page and the Backlog.md setup say that the key must be set.
- Nobody can add a connection.
- Nobody can issue a repository webhook secret.
- Mirrors that already exist pause at their next refresh.

Pull requests of public repositories still link through the hourly check.

A key that is set but is not base64, or does not decode to 32 bytes, stops the web app and the worker at
start. `docker compose logs web worker` says why.

#### If the key is lost or changed

| What happens                                                                                                                                        | What to do                                                                                                         |
| --------------------------------------------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------ |
| Mirrors pause with "A stored secret cannot be read with the current APP_ENCRYPTION_KEY".                                                            | An admin edits each connection in Settings > Git connections and pastes the token again. That resumes its mirrors. |
| Webhooks of existing mirrors stop working, because their secrets cannot be read. The webhook dialog in the project's Settings > Backlog.md says so. | An owner or admin presses New secret there and pastes the new secret into the git host. The URL stays the same.    |
| Repository webhooks fail their signature check the same way.                                                                                        | Issue a new secret on the project's Settings > Repository page.                                                    |

Until a mirror has its new webhook secret, it still refreshes every hour, on Refresh now, and with
`zamu backlog refresh`.

### Private networks: GIT_ALLOW_PRIVATE_HOSTS

A connection makes the server call whatever host an admin typed. By default, every request first checks that
the host resolves to a public address, so a connection cannot reach services inside your network.

For a self-hosted GitLab, Gitea or Forgejo on a private network, set:

```sh
GIT_ALLOW_PRIVATE_HOSTS=true
```

The server then allows loopback and private ranges. It always refuses link-local addresses
(`169.254.0.0/16`) and cloud metadata addresses (`fd00:ec2::254`). The check runs before every request and
every redirect.

### Plain HTTP: GIT_HTTP_HOSTS

Connections use HTTPS. `GIT_HTTP_HOSTS` lists hosts, with or without their port, that the server reaches
over plain HTTP instead. A Forgejo test container is one example:

```sh
GIT_HTTP_HOSTS=forgejo:3000,localhost
```

The token travels in clear text on those connections. Do not list a production git host.

### Custom certificate authorities: NODE_EXTRA_CA_CERTS

If your git host's certificate comes from an internal CA, give Node the CA certificate in PEM format.
1. Keep the certificate outside the checkout and readable by everyone. The containers run as UID 1000. See
   [Container user](#container-user).
2. Add a `docker-compose.override.yml` next to `docker-compose.yml`. Compose reads that file on its own.

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

3. Run `docker compose up -d`. Node reads the file once at start, so run it again after you change the
   certificate.

Without the certificate, testing the connection fails with "Host unreachable" and a certificate error code,
such as `UNABLE_TO_VERIFY_LEAF_SIGNATURE`.

### Webhooks

With a webhook, the git host tells the server about a change as it happens. A mirror refreshes within
seconds of a push, and a pull request shows on its task within seconds of an event. For that, the git host
has to deliver its webhooks to these URLs:

```text
{PUBLIC_URL}/api/webhooks/backlog/<id>
{PUBLIC_URL}/api/webhooks/repository/<id>
```

The server builds the URLs from `PUBLIC_URL`, so set that to the address the git host can reach.

Things to check:
- GitHub.com and GitLab.com need a public URL. Behind a firewall, allow `POST` to `/api/webhooks/backlog/`
  and `/api/webhooks/repository/` from the host's webhook addresses.
- A reverse proxy must pass the request body untouched. Push payloads are usually small, but a push with
  many commits can pass nginx's default 1 MB limit (`client_max_body_size`). The app accepts up to 25 MB.
- A self-hosted GitLab refuses webhooks to private addresses unless an admin allows them. The setting is
  Admin > Settings > Network > Outbound requests > Allow requests to the local network from webhooks and
  integrations.
- Gitea and Forgejo refuse them unless `[webhook] ALLOWED_HOST_LIST` in `app.ini` includes the app's
  address, for example `private` or the host name.

Without a working webhook, the server still reads the git host every hour:

| What          | Every hour (UTC)                                                  | On demand                          | Where to see the last delivery                                                        |
| ------------- | ----------------------------------------------------------------- | ---------------------------------- | ------------------------------------------------------------------------------------- |
| Mirrors       | At 15 minutes past the hour, the server reads the default branch. | Refresh now                        | The webhook dialog in Settings > Backlog.md shows when the last notification arrived. |
| Pull requests | At 45 minutes past the hour, the server checks them.              | Check now in Settings > Repository | Settings > Repository shows how the last delivery went.                               |

## Kubernetes

The `zamu` Helm chart runs the image on a cluster: a Deployment for `web`, one for `worker`, and a Job for
`migrate`. The [chart's README](https://github.com/reddevsdotio/helm-charts/tree/main/charts/zamu) lists
every value. Each chart version runs the Zamu release in its `appVersion` unless you set `image.tag`.

Add the chart repository:

```sh
helm repo add reddevs https://charts.reddevs.io
helm repo update
```

### Try it out

With `postgres.enabled`, the chart also runs a Postgres pod, so you need nothing else:

```sh
helm install zamu reddevs/zamu \
  --namespace zamu --create-namespace \
  --set publicUrl=https://zamu.example.com \
  --set postgres.enabled=true
```

`publicUrl` is required. It is the URL people open Zamu on, and sign-in fails on any other address. Point an
ingress or a route at it as shown below, or install with `--set publicUrl=http://localhost:3000` and run
`kubectl --namespace zamu port-forward svc/zamu 3000:3000`. Then create the admin account as in
[First run](#first-run).

The built-in Postgres is for trials: one pod, one volume and no backups. Use your own database for data you
want to keep.

### Production

Run Postgres 18 yourself, or use a managed one, and put the secrets in a Secret you manage. The chart reads
these keys from it:

| Key                  | Required | Meaning                                                                          |
| -------------------- | -------- | -------------------------------------------------------------------------------- |
| `DATABASE_URL`       | yes      | `postgres://user:password@host:5432/zamu?sslmode=require`                        |
| `BETTER_AUTH_SECRET` | yes      | Signs sessions. 32 characters or more.                                           |
| `APP_ENCRYPTION_KEY` | no       | Encrypts git tokens. Without it, git connections and Backlog.md mirrors are off. |
| `OIDC_CLIENT_SECRET` | with SSO | Client secret from the OpenID Connect provider.                                  |

```sh
kubectl create namespace zamu
kubectl --namespace zamu create secret generic zamu-secrets \
  --from-literal=DATABASE_URL='postgres://zamu:PASSWORD@db.example.com:5432/zamu?sslmode=require' \
  --from-literal=BETTER_AUTH_SECRET="$(openssl rand -base64 32)" \
  --from-literal=APP_ENCRYPTION_KEY="$(openssl rand -base64 32)"
```

Write a values file. This one uses an Ingress with a certificate from cert-manager:

```yaml
# values.yaml
publicUrl: https://zamu.example.com
existingSecret:
  name: zamu-secrets
ingress:
  enabled: true
  className: nginx
  annotations:
    cert-manager.io/cluster-issuer: letsencrypt
  hosts:
    - host: zamu.example.com
      paths:
        - path: /
          pathType: Prefix
  tls:
    - secretName: zamu-tls
      hosts:
        - zamu.example.com
```

With the Gateway API, replace `ingress` with an HTTPRoute on your gateway:

```yaml
gatewayApi:
  enabled: true
  httpRoute:
    hostnames:
      - zamu.example.com
    parentRefs:
      - name: my-gateway
        namespace: gateway-system
        sectionName: https
```

Install it:

```sh
helm install zamu reddevs/zamu --namespace zamu --values values.yaml
```

The variables in [Configure](#configure) and [Single sign-on (OIDC)](#single-sign-on-oidc) have values of
their own, such as `timeZone`, `workspaceCreation` and `oidc.issuer`. The chart's README maps each value to
its variable.

### Migrations and secrets

- Migrations run as a Helm hook Job before every install and upgrade. With the built-in Postgres, the first
  one runs after the install instead, once the database pod exists. If the Job fails, Helm stops and `web`
  and `worker` keep running the version they had. `kubectl --namespace zamu get jobs` lists the Job,
  and its logs say why.
- Without `existingSecret`, the chart keeps a Secret of its own. If you do not set `secrets.betterAuthSecret`
  and `secrets.encryptionKey`, it generates `BETTER_AUTH_SECRET` and `APP_ENCRYPTION_KEY` on the first
  install and keeps them across upgrades. `helm uninstall` leaves that Secret in place, so a new install in
  the same namespace finds the same keys.
- The chart generates them only when `helm install` or `helm upgrade` talks to the cluster. Under
  `helm template` or Argo CD, set them yourself or use `existingSecret`.
- Back up `APP_ENCRYPTION_KEY` with the database, whether you or the chart made it. Without it, a restored
  database cannot read its git tokens. See [APP_ENCRYPTION_KEY](#app_encryption_key).

### Upgrade with Helm

Read the notes under [Upgrades](#upgrades) for the release you move to, back up the database, then:

```sh
helm repo update
helm search repo reddevs/zamu --versions    # chart versions and the Zamu release each runs
helm upgrade zamu reddevs/zamu --namespace zamu --values values.yaml
```

## Container user

The image runs as UID 1000 and GID 1000, the `node` user of the Node base image. The image sets the user by
number. It writes only to `/tmp` and its home directory, `/home/node`.

Two things to keep in mind:
- If you override the user with `user:` in compose or `--user` with `docker run`, keep it a number other
  than 0. A name such as `node` makes Kubernetes' `runAsNonRoot` check fail.
- Anything you mount into `web`, `worker` or `migrate` must be readable by UID 1000, and writable by it if
  the app has to write there. The Postgres volume belongs to the `db` service, which runs as its own user.

On Kubernetes, the `securityContext` below meets the restricted Pod Security Standard. Give it to the web,
worker and migrate containers:

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

## The CLI in the image

The image ships the `zamu` CLI. You can use it to check a key from the server:

```sh
docker compose exec -e ZAMU_KEY=zamu_live_... web zamu whoami
```

Agents normally run `zamu` on their own machine. See [agents.md](agents.md).
