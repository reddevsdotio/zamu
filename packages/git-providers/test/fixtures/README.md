# Provider fixtures

Recorded HTTP exchanges that `test/replay.ts` serves as a fake `fetch`. Each file has a
`description`, a `source` and a list of `exchanges` (request method and URL, response status,
headers and body).

Where they come from:
- Recorded on 2026-10-23 without a token against public repositories, then trimmed to a few
  entries: GitHub `MrLesk/Backlog.md` (api.github.com), GitLab `gitlab-org/cli` (gitlab.com),
  Forgejo `forgejo/docs` (codeberg.org). Response shapes, Link headers and error bodies are as the
  providers sent them.
- Hand-written from the provider API docs where a public recording is not possible: `whoami`
  (needs a token), rate-limit answers, truncated GitHub trees, redirects, subgroup projects.
- `*/open-requests*.json` (M6) are hand-written from each provider's pull or merge request docs, on
  the same public repository paths: open requests, their changed files, and the pagination headers
  that make a list incomplete. The Forgejo integration test checks the same calls against a real
  server with a read-only token.
- `gitea/tree-paged.json` keeps a Forgejo quirk seen on Codeberg and in
  `services/repository/files/tree.go`: `truncated` stays `true` on every page of a paged tree
  listing, the last page included.
- `gitea/errors.json` keeps another one: Forgejo's 401 body repeats the token it received. The
  fixture uses `fixture-token-123` there, and the tests check it never reaches an error message.
- `*/requests.json` (M7) are hand-written from each provider's pull or merge request docs on
  made-up repositories (`northwind/payments`, `northwind/platform/payments` on GitLab): single
  requests in every state, lists ordered by update, a draft marked only by a `[WIP]` title on a
  Gitea release without the `draft` field, GitLab's older `merged_by` and `work_in_progress`, and
  a Forgejo 401 that repeats the token.
- `webhooks/requests.json` (M7) holds request deliveries (GitHub and Forgejo `pull_request`, GitLab
  `Merge Request Hook`) for every action Zamu maps and a few it ignores, shaped after each
  provider's webhook docs and Forgejo's `modules/structs/hook.go`, signed with the secret in the
  file, plus signed deliveries without the documented fields.
- `webhooks/forgejo-recorded.json` (M7) holds six real `pull_request` deliveries from the Forgejo
  17 container in `docker/forgejo`, copied from its `hook_task` table with their exact bodies and
  headers: opened with a `WIP:` title, the prefix edited away, a push, closed, reopened, merged.
  The Forgejo integration test checks the same deliveries live when the container can reach the
  test process.
- `webhooks/deliveries.json` holds push, ping and tag deliveries shaped after each provider's webhook
  docs, signed with the secret in the file, plus the test vector from GitHub's "Validating webhook
  deliveries" page.

No fixture contains a real token. The token the tests send is `fixture-token-123`.
