# Test Forgejo

A throwaway Forgejo 17 for the `@zamu/git-providers` integration tests and the end-to-end specs that need a
git host (Backlog.md, pull requests).

```sh
eval "$(FORGEJO_PORT=3300 docker/forgejo/setup.sh)"   # sets FORGEJO_URL, FORGEJO_USER, FORGEJO_PASSWORD, FORGEJO_TOKEN
docker/forgejo/teardown.sh                            # removes the container and its data
```

- `setup.sh` starts the container, waits for `/api/healthz`, then creates the admin `zamu-admin` with
  a random password and an access token with every scope through the `forgejo admin` CLI. It prints
  the values as `KEY=value` lines on stdout; everything else goes to stderr.
- `FORGEJO_PROJECT` (default `zamu-forgejo`) names the compose project, so parallel runs need
  different values. Pass the same value to `teardown.sh`.
- `FORGEJO_TREES_PER_PAGE` (default 10) caps tree listing pages, so small fixtures still exercise
  pagination.
- The API listens on `127.0.0.1` only, over plain HTTP. The app needs
  `GIT_HTTP_HOSTS=localhost` and `GIT_ALLOW_PRIVATE_HOSTS=true` to reach it.
- Webhooks may target any host. From inside the container the Docker host is
  `host.docker.internal`, so a test server on the host listens on `0.0.0.0` and registers
  `http://host.docker.internal:<port>/...` as the hook URL.
