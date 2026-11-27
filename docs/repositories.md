# Repositories and pull requests

A project can link the repository its code lives in. Zamu then reads the repository's pull requests (merge
requests on GitLab), shows them on the tasks they belong to, and moves those tasks when a request opens or
merges. It works with GitHub, GitLab and Gitea/Forgejo.

This page is for the owners and admins who link a repository and set up its webhook. It calls pull requests
and merge requests "requests".

Zamu only reads from the repository. Every call it makes to the host is a `GET`. It never:

- comments on a request
- commits or pushes
- sets a status check or a label
- approves a request or asks for changes
- creates the webhook for you

Two other pages cover the rest. [guide.md](guide.md#pull-requests-on-tasks) shows how requests look on a task,
in the list and on Home. [agents.md](agents.md#pull-requests) says what an agent does so its requests link by
themselves.

## Link a repository

A project links one repository. You can set it in three places:

- the project's Settings > General, under Repository
- `zamu link --project PAY`, run in a clone
- Link a repository, on the project's Settings > Repository page

Zamu refuses requests from any other repository.

Settings > Repository (`/w/<slug>/p/PAY/settings/repository`) shows:

- The repository and the connection Zamu reads it with, with Change to edit both.
- The default branch, known after the first check. Only merges into it close tasks.
- The switch "Close tasks when their pull request merges".
- The webhook: its payload URL, its secret, the setup steps for each host, and how the last event went.
- The hourly check: when it last ran, its error if it failed, and Check now.

A check is one read of the repository's default branch and its recent requests.
[The hourly check](#the-hourly-check) describes it.

Everyone who can read the project sees the page. Owners and admins change the repository, the connection, the
switch and the webhook secret, and press Check now.

### The connection

Zamu reads the repository through a git connection of the workspace. A **git connection** is an access token
for one host, saved by an owner or admin in Settings > Git connections (see
[backlog-md.md](backlog-md.md#git-connections)).

Zamu picks the connection on its own, in this order:

1. The connection of the project's Backlog.md mirror, when the project has one. A mirror is a project that
   follows the Backlog.md task files in its repository.
2. Else the workspace's working connection for the repository's host, when there is exactly one.
3. Else none. Zamu then reads the repository as a public one, without a token. A private repository can't be
   read that way, and the page says "Zamu can't read this repository: link a connection."

To choose yourself, press Change on the Repository page. You can pick another connection for the same host, or
"None: public repository".

A new connection starts a check right away. That check moves no task for the requests it reads (see
[The first check moves nothing](#the-first-check-moves-nothing)). Deleting a connection leaves its projects
with none.

Read-only tokens are enough:

| Host            | Token                                                                                              |
| --------------- | -------------------------------------------------------------------------------------------------- |
| GitHub          | Fine-grained token with "Pull requests: Read-only" and "Contents: Read-only" (Metadata comes too). |
| GitLab          | Personal, group or project access token with the `read_api` scope, Reporter role or higher.        |
| Gitea / Forgejo | Access token with the `read:repository` scope, plus `read:user` for the connection's token test.   |

A token that already reads a Backlog.md mirror on GitHub needs "Pull requests: Read-only" added. Mirrors alone
need only Contents.

## How a request links to a task

A request links to a task in three ways: by branch, by description or by hand. The task shows each request
once, with how it was linked.

### By branch

When an agent starts a task with `zamu` from a git branch, the server records that branch as the task's
**work branch**. Starting a task means setting `--status in_progress` or `in_review`. A request whose head
branch is the work branch links to the task, also when the request was opened before the agent started the
task.

- The server never records the repository's default branch.
- The web app records no branch.
- A new branch replaces the old one.

### By description

A line in the request's description that starts with `Closes:` links the tasks it names. Write
`Closes: PAY-142, PAY-150` or `closes: PAY-142 PAY-150`. Any letter case works, and the line can be a list
item.

- Backlog.md IDs work too.
- Zamu ignores keys of other projects and unknown keys.
- When the description changes, keys added link and keys removed unlink. A removed key keeps its link when the
  task is also linked by branch or by hand.

### By hand

Anyone who can edit the task can link a request by its address:

- In the task view, press Shift+P ("Link a pull request") and paste the address.
- Run `zamu pr link PAY-142 <url>`.

The address must be a request of the project's repository. Zamu refuses another repository with "That request
is in another repository". It refuses an address that is not a request with "That address is not a pull or
merge request."

### Removed links and archived tasks

A link removed by hand stays removed. You remove one in the task view or with `zamu pr unlink`. Neither the
branch nor a `Closes:` line brings it back. Linking it by hand again does.

Zamu leaves archived tasks alone. New requests don't link to them, and their links stay as they were.

## What moves a task

Opening a request moves its linked tasks to In review. Merging it into the default branch moves them to Done.

| The request                                     | Linked tasks                                                 |
| ----------------------------------------------- | ------------------------------------------------------------ |
| Opened, reopened, or marked ready (not a draft) | Tasks in Backlog, Todo or In progress move to In review.     |
| Opened as a draft                               | Linked, not moved.                                           |
| Merged into the default branch                  | Tasks that are not Done or Canceled move to Done, see below. |
| Merged into another branch                      | Nothing moves. The request shows as merged.                  |
| Closed without merging                          | Nothing moves. The request shows as closed.                  |

A merge moves a task to Done only when both of these hold:

- The project closes on merge (see [Close on merge](#close-on-merge)).
- No other request linked to the task is still open or a draft.

Each move is a line in the task's history, with the host as the actor and the request as the reason: "GitHub
moved this to In review · #482 opened by claude-dev". Requests read `#482` on GitHub and Gitea/Forgejo and
`!482` on GitLab.

Events that arrive out of order can't move a task back. Zamu drops an event older than the version it has.

### Links made later

A link made by hand, or a `Closes:` line added later, acts on the request's state at that moment. Linking an
open request moves the task to In review, and linking a merged one moves it to Done.

This holds for requests that changed after the repository was linked. Older ones link without moving.

### Merged with open criteria

Requests move a task also when its criteria or done items are still open. Those are the two checklists of the
task's work record, the acceptance criteria and the definition of done.

When a merge moves such a task to Done, Zamu flags it "Merged with 2 open criteria", or "Merged with 3 open
items" when done items are open too. The task shows on Home under "Merged with open criteria" until someone
checks or waives the items, or reopens the task. The nightly archive leaves such a task alone.

### Close on merge

"Close tasks when their pull request merges" is on for every project. Turn it off when a person should move
tasks to Done after the merge, for example when a release follows the merge.

Off stops only the Done step. Opened requests still move tasks to In review.

`zamu projects show` tells agents whether the project closes on merge. `zamu instructions` tells them to stop
at In review either way.

### The first check moves nothing

The first check links the requests it finds and records their state, but moves no task. This applies to the
first check after a project's repository is linked, and to the first one after its connection changes.

Moves come only from events received or first seen after that. Linking an old repository therefore never
closes a pile of tasks at once.

## Webhooks

With a webhook, the host tells Zamu about a request within seconds. Without one, Zamu finds requests by
checking once an hour (see [The hourly check](#the-hourly-check)).

Each project has its own payload URL, built from the server's `PUBLIC_URL`:

```text
https://projects.example.com/api/webhooks/repository/<id>
```

You issue the secret on the Repository page with "Issue a secret", later New secret. Zamu shows it once, right
after you confirm. Copy it into the host's webhook settings. Issuing a secret needs `APP_ENCRYPTION_KEY` on
the server.

A new secret replaces the old one at once. Deliveries signed with the old one fail until you paste the new
one. The URL stays the same.

### GitHub

1. Open the repository on GitHub, then Settings > Webhooks > Add webhook.
2. Paste the payload URL into Payload URL, choose `application/json` as the content type, and paste the secret
   into Secret.
3. Under "Which events would you like to trigger this webhook?", choose "Let me select individual events",
   tick Pull requests and untick Pushes.
4. Save. GitHub sends a ping, which Zamu answers with `200`.

### GitLab

1. Open the project on GitLab, then Settings > Webhooks > Add new webhook.
2. Paste the payload URL into URL and the secret into Secret token.
3. Under Trigger, tick Merge request events only.
4. Save, then press Test > Merge request events.

### Gitea and Forgejo

1. Open the repository, then Settings > Webhooks > Add webhook, and pick Forgejo (or Gitea).
2. Paste the payload URL into Target URL, keep POST and `application/json`, and paste the secret into Secret.
3. Under Trigger on, choose Custom events and tick Pull request only (the pull request events).
4. Save, then open the webhook and press Test delivery.

### What the URL answers

| Status | When                                                                         |
| ------ | ---------------------------------------------------------------------------- |
| `202`  | A request event, queued.                                                     |
| `200`  | A ping or another event, or a signed payload Zamu can't read. Nothing to do. |
| `401`  | No secret issued yet, or a missing or wrong signature.                       |
| `404`  | No project has this webhook id.                                              |
| `410`  | The project no longer links a repository. Remove the webhook at the host.    |
| `413`  | The body is over 25 MB.                                                      |

Zamu checks GitHub's `X-Hub-Signature-256`, GitLab's `X-Gitlab-Token` and the Gitea or Forgejo signature
against the secret.

The Repository page shows how the last delivery went, in one of these lines:

- "No event received yet"
- "Last event 3 minutes ago"
- "The last event failed its signature check". Paste the secret again, or issue a new one.
- "Zamu couldn't read the last event". Check that the webhook sends pull-request events as `application/json`.

The host has to reach the server. GitHub.com and GitLab.com need a public URL. Self-hosted hosts may need to
be allowed to call private addresses. See [self-hosting.md](self-hosting.md#webhooks).

## The hourly check

Every hour at 45 minutes past (UTC), Zamu checks each project that links a repository. Requests therefore link
and tasks move even without a webhook, at most an hour late. With a webhook, the check catches what a failed
delivery missed.

A check reads the default branch and the requests updated since the last check, with ten minutes of overlap.
It reads them newest first, at most 100, and applies each one like a webhook event. The first check reads the
open requests and those updated in the last seven days.

Owners and admins can press Check now on the Repository page to run a check right away.

When a check fails, for example because the token was revoked or the repository was renamed, the page shows
why and the next check tries again. Nothing else pauses. Tokens never appear in these messages.

## Mirrored projects

In a project that mirrors Backlog.md, the task files own the status. Requests link and show as everywhere
else, but they never move a task. The close-on-merge switch shows off and locked, with one line saying why.

A mirrored project needs one webhook, because its Backlog.md webhook also takes request events. Add pull
request events (Merge request events on GitLab) to the webhook you set up for the mirror, next to the push
events. The Repository page says so. The repository's own payload URL works too.

## Self-hosted git

For a GitLab, Gitea or Forgejo on a private network, the server needs `GIT_ALLOW_PRIVATE_HOSTS=true`. A host
reached over plain HTTP also needs `GIT_HTTP_HOSTS`.
[self-hosting.md](self-hosting.md#git-connections-and-backlogmd) describes both.

The same rules apply to the hourly check, to links made by hand and to public reads without a connection.
