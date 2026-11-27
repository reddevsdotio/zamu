# Using the app

This page is for people who use Zamu in the browser. It goes through the screens in the order you meet
them, from your workspace and Home down to a single task, and says what you can do on each.

Every key is in [keyboard.md](keyboard.md). On Windows and Linux, press Ctrl where this page shows ⌘. AI
coding agents work through the `zamu` CLI instead, and [agents.md](agents.md) is their page.

## Workspaces

A **workspace** holds projects, their tasks, members, agents and API keys. An **agent** is an AI coding
agent that is a member of the workspace. It acts for one person, its **responsible person**.

One server can hold several workspaces, and you can belong to more than one, with a role in each. Nothing
crosses between them. Home, search, the command palette and every list show the workspace you are in.

Each browser tab stays in its own workspace, so two tabs can show two workspaces side by side.

### Addresses

Every page lives under the workspace's slug, the part of the address after `/w/`.

| Address                 | Opens                              |
| ----------------------- | ---------------------------------- |
| `/w/acme/`              | Home of the workspace `acme`       |
| `/w/acme/p/PAY/PAY-142` | The task PAY-142 in that workspace |
| `/`                     | The workspace you used last        |

Two workspaces can each have a project `PAY`. A link always opens the task of its own workspace.

Links from before 0.10, such as `/p/PAY/PAY-142` and `/settings/members`, open the same page in the
workspace you used last.

### Switch workspaces

Open the workspace menu at the top of the sidebar. It lists every workspace you belong to under
"Workspaces", with a check on the current one. Choose another to open its Home.

From the keyboard, open the command palette (⌘K) and pick "Switch to Globex". The palette has one such
command for each of your other workspaces.

### Create a workspace

1. Choose "New workspace" in the workspace menu or the palette. The New workspace dialog opens and says "You
   become its owner. Projects, members and API keys stay inside it."
2. Type a Name. The dialog suggests the Address, the slug after `/w/`, from the name. You can change it.
3. Press Create workspace (⌘Enter).

The new workspace's Home opens. It starts with "Nothing to show yet" and two steps: create a project, then
add an agent.

An address follows these rules:
- It is 2 to 40 lower-case letters, digits and hyphens.
- It starts with a letter.
- It can't be a word the app uses, such as `settings` or `api`. The dialog says so under the field: "This
  address is reserved. Pick another."
- It can't belong to another workspace: "The address globex is taken. Pick another." An address another
  workspace used before is taken too.

On servers set to `WORKSPACE_CREATION=owners`, only people who already own a workspace see "New workspace".
See [self-hosting.md](self-hosting.md#workspaces).

### Join from an invitation

An invitation opens the workspace that sent it once you accept.

If you already have an account, sign in with the invited email. Then choose "Join Acme" on the invitation
page. The button carries the workspace's name. When you are signed out, the page offers "Sign in to join".

### Without a workspace

Someone who belongs to no workspace, for example after leaving the last one, gets a page of their own. What
it shows depends on the server:
- When the server lets you create a workspace, the page shows "Create a workspace" with the same Name and
  Address fields.
- Otherwise it says "Ask an owner for an invitation", since the link in an invitation opens its workspace.

Both show who is signed in and Sign out.

## Sidebar

The sidebar on the left is how you move around the workspace. From top to bottom it holds:
1. The workspace menu, with your workspaces, New workspace, Workspace settings, Invite people, New project
   and New from Backlog.md.
2. Search or jump to, which opens the [command palette](#command-palette) (⌘K).
3. Home, with the number of things that need you.
4. Your projects, by name, each with its number of open tasks.
5. Workspace settings, which opens [General](#workspace-settings).
6. Your menu, with the theme (System, Light or Dark), My API keys, Keyboard shortcuts and Sign out.

The current project expands to List, Board, Milestones, Cycles and Settings. Milestones and Cycles show only
when the project uses them. A **milestone** is a goal with an optional target date. A **cycle** is a
numbered, dated period of work, usually two weeks.

The "+" next to Projects creates a project or a project from Backlog.md (see
[Projects that mirror Backlog.md](#projects-that-mirror-backlogmd)).

`[` collapses the sidebar to icons and back. The app remembers your choice. Below 1100 pixels wide, the
sidebar stays collapsed.

The Dashboard, My tasks and Projects pages are gone. Their old links open Home.

## Home

Home (`/w/<slug>/`) shows what needs attention, across every project you can see in the workspace. Each task
sits under the reason it needs someone. "All clear" means nothing waits.

Home has three tabs:
- **Mine** shows what waits on you. Its groups are listed below.
- **Everyone** shows tasks in review, merged with open criteria, blocked, overdue and due this week, across
  the workspace.
- **Agents** shows one card per agent: working or idle, its current task, what it did today and its last
  actions. It also has "Waiting on a person", the questions and review requests from agents that nobody
  answered yet.

Mine and Everyone start with a deadlines strip. It holds milestones and cycles that end within 2 days, and
tasks due within 2 days or overdue.

Filter Home by project, label and priority. Labels with the same name in several projects are one entry in
the filter. C on Home asks which project the new task goes to.

### Groups on Mine

On each tab a task shows once, in the first group it fits. Mine's groups come in this order:

| Group                     | Holds                                                                                      |
| ------------------------- | ------------------------------------------------------------------------------------------ |
| Needs your review         | Tasks in review that wait on you                                                           |
| Merged with open criteria | Done tasks that a merged pull request closed while a criterion or done item was still open |
| Check again               | Your open tasks whose check-again day is today or past                                     |
| Mentions                  | Unanswered comments that mention you                                                       |
| Blocked                   | Your open tasks that are blocked                                                           |
| Overdue                   | Your open tasks that are overdue                                                           |
| Assigned to you           | The rest of your open tasks                                                                |

Criteria and done items are the checklists of a task's [work record](#the-work-record), and
[Pull requests on tasks](#pull-requests-on-tasks) says how a merge closes a task while one is open. A
check-again day is the day you set to look at a waiting task again (see [Check again](#check-again)).

Your tasks are the ones assigned to you, and the ones you created that nobody holds yet.

A task in review waits on the responsible person of the agent that holds it. When no agent holds it, it waits
on whoever created it. Merged with open criteria shows a task to that same person.

A task in "Needs your review" that has acceptance criteria shows how many are settled, such as "4 of 6
criteria".

The count after Home in the sidebar adds up Mine's review, merged with open criteria, check again, mentions,
blocked and overdue items.

### When items leave

Items leave on their own when the reason clears: answer the comment, finish the review, close the blocker,
settle the open items, clear or move the check-again day.

A task leaves Merged with open criteria once every item is checked or waived, or when the task is reopened.

Archived tasks never show on Home.

## List and board

Every project has a list and a board. To change between them, use the List / Board switch in the header,
press V, or press G then L and G then B. The project remembers the last one you used.

The header row holds the project name, the switch, Filter, Display, search (/), and New task. In a project
that mirrors Backlog.md, it also shows the mirror's state and Refresh now.

A **mirrored** project reads its tasks from Markdown files in a repository (see
[Projects that mirror Backlog.md](#projects-that-mirror-backlogmd)). The other projects are **native**.

### Open and move tasks

In the list:
- Enter or a click opens the task view.
- Space opens the **peek**, a smaller view of the task that opens over the list.
- ← and → on a group row fold and unfold it.

On the board:
- Drag a card to another column, or press Shift+← and Shift+→.
- Shift+J moves a card down and Shift+K moves it up, when the order is Manual.
- ⌘Z undoes the last move from the toast.

### Filter

Filter adds conditions:
- status, priority, assignee and labels
- due date: overdue, due soon, has a due date, or no due date
- blocked
- milestone and cycle
- Waiting, when the check-again day is ahead, and Ready to check, when it has come
- Archived

Active filters show as chips under the header, with the number of matching tasks and Clear. Filters live in
the page address, so a link keeps them.

### Display

Display sets how the view looks.

| Option                  | Choices                                                                                               |
| ----------------------- | ----------------------------------------------------------------------------------------------------- |
| Layout                  | List or board                                                                                         |
| Grouping                | Status, priority, assignee, milestone, cycle, label or none. On the board, the groups are the columns |
| Swimlanes               | On the board                                                                                          |
| Order                   | Priority, due date, last updated, created, or manual (the board order you set by hand)                |
| Subtasks                | Nested under their parent in the list, or as their own cards on the board                             |
| Empty groups or columns | Shown or hidden                                                                                       |
| "Hide done tasks after" | A number of days, 14 by default                                                                       |
| "Waiting tasks"         | Shown, "Shown, dimmed" (the default) or Hidden                                                        |
| "Archived tasks"        | Hidden (the default) or Shown, the same as the Archived filter                                        |
| Properties              | Which properties rows and cards show                                                                  |

Waiting tasks are the tasks whose check-again day is ahead. A board column that hides some ends with a line
such as "2 waiting, hidden".

Display options are saved for you, per project and per view. Reset to default puts them back.

By default, cards and rows show the key, the title, labels, subtask progress, the due date when set and the
Blocked marker. They show the priority only when it is Urgent or High, and the assignee only when it is
someone else.

Three chips under "Shown on rows" and "Shown on cards" add more:

| Chip         | Default | Shows                                                |
| ------------ | ------- | ---------------------------------------------------- |
| Criteria     | Off     | The criteria marker, after the subtask progress      |
| Check again  | On      | The check-again day                                  |
| Pull request | Off     | The newest linked request, with its number and state |

The criteria marker reads "4/6", the acceptance criteria checked of the total. It fills in once none is
open. A task without criteria shows nothing.

### Selecting several tasks

1. Press X to select the task under the cursor.
2. Extend the selection with Shift+click, or with Shift+↓ and Shift+↑. ⌘A selects everything in the view.
3. With two or more tasks selected, use the bar at the bottom. It changes their status, assignee, labels,
   priority, due date, milestone or cycle in one go, or archives them (Shift+E).

The task keys, such as S, P, A, L and Shift+D, act on the whole selection too. Esc clears it.

Changes to several tasks work in native projects only. In a mirrored project the bar offers Copy keys, Copy
links and Open in Backlog.md.

## Task view and peek

![The task view of CHK-1, with its subtasks, the task it blocks and the properties sidebar](images/task-view-light.png)

A task opens as a full page at `/w/acme/p/PAY/PAY-142`. This is the task view, where you read a task and
change it.

On the left, from the top:
1. The title.
2. The final summary, when there is one.
3. The Markdown description.
4. The pull requests.
5. The acceptance criteria.
6. The definition of done.
7. The plan.
8. The Subtasks and Blocked by boxes.
9. The activity and the comment box (M).

The summary, the criteria, the definition of done and the plan belong to the task's work record. See
[The work record](#the-work-record).

The properties are on the right: status, priority, assignee, Criteria and Done items, Pull request, Check
again, labels, due date, parent, milestone and cycle. Each has its picker. Criteria and Done items show
their counts, and a click moves to the list.

| Key   | Action                                                                              |
| ----- | ----------------------------------------------------------------------------------- |
| E     | Edit the title                                                                      |
| D     | Edit the description                                                                |
| J / K | Next and previous task of the list or board you opened it from ("12 of 40 in List") |
| Esc   | Back to that list or board, with the task still under the cursor                    |

Copy link copies the task's address.

Old links to the list with `?task=PAY-142` open the task view.

### The peek

The peek opens over the list, the board or Home with Space. Use it to look at a task without leaving the
page you are on.

It shows the task's properties as chips, with the criteria and done items counts, and the latest comment. A
task with a final summary opens on the summary instead of the description.

J and K move the peek to the next task. Open goes to the task view. Space or Esc closes the peek.

## Command palette

The command palette is one search box for pages, tasks and actions. ⌘K opens it from any page.

Type to find:

| Kind       | What you find                                                                                        |
| ---------- | ---------------------------------------------------------------------------------------------------- |
| Pages      | Home, and the list, board, milestones, cycles and settings of each project                           |
| Projects   | G then P opens the palette on projects only                                                          |
| Tasks      | By key (`PAY-142`) or by words of the title. Archived tasks come last, tagged Archived               |
| Actions    | Create a task or a project, switch the theme, collapse the sidebar, open the shortcut list           |
| Workspaces | "Switch to Globex" for each of your other workspaces, "New workspace" and "Go to workspace settings" |

Create task "…" starts quick create, the dialog C opens, with the words you typed as the title.

On a task, or with tasks selected, the palette starts with their actions: Change status, Set priority,
Assign, Add labels, Set due date, Move to milestone, Add to cycle, Add blocker, Add subtask, Assign to me,
Copy key and Copy link.

Some actions have a second step, such as Set status with the six statuses. Backspace in an empty step goes
back to the actions.

The palette shows each action's key, so you learn them as you go.

## Labels

Labels belong to one project. Press L on a task to open the label picker. Type a name that doesn't exist
and the picker creates the label.

Names are unique in the project, ignoring case, and up to 40 characters. The app picks one of nine colours
for a new label. Tab in the picker moves to the swatches if you want another.

Manage labels in the project's Settings > Labels. The list shows how many tasks use each label. You can
rename a label in place, change its colour, or delete it.

Deleting asks first and says how many tasks lose the label. The tasks keep everything else. Renames and
deletes leave no history lines, and the task history keeps the name it recorded.

## Due dates

A due date is a day, with no time. To set one, press Shift+D, then do one of these:
- Type a date, such as "nov 4", "tomorrow", "+3d" or "2026-11-20".
- Pick Today, Tomorrow or Next week.
- Pick a day in the calendar.

Clear due date removes it.

Rows and cards show the date like this:

| When                         | Shows               |
| ---------------------------- | ------------------- |
| No due date                  | Nothing             |
| Later                        | Nov 14              |
| Within 2 days                | Tomorrow, In 2 days |
| Today                        | Today               |
| Past, and the task is open   | 3 days overdue      |
| Past, and the task is closed | Oct 31 · done       |

Days follow the server's `APP_TIME_ZONE` (UTC when it is not set).

## Blocked by

A task can wait on other tasks of the same project, its blockers. Add them in the Blocked by box of the task
view, or with Shift+B. The blocker shows the other side: "Blocks PAY-150".

A task with at least one open blocker shows a Blocked marker. It is a marker only. Nothing stops a blocked
task from changing status. Once every blocker is Done or Canceled, the marker goes away.

The app refuses a link that would close a loop and gives the reason, for example "Can't add: PAY-150
already waits on PAY-142."

A blocker that is hidden or that you can't see reads "Removed task".

## Subtasks

A task can have subtasks in the same project. Add them in the Subtasks box of the task view or with Shift+S.
Type a title and press ⌘Enter to create a new subtask, or pick an existing task. A new subtask takes the
parent's assignee.

The parent shows its progress as done of total, with canceled subtasks left out.

In the list, subtasks can nest under their parent. On the board they are hidden by default. The parent card
reads "5 subtasks · 2 done" and expands in place to list them. Turn on "Show subtasks as cards" in Display to
see them as cards.

Subtasks go one level deep. A subtask can't have subtasks of its own.

## Check again

A **check-again day** says when to look at a task again and why it waits, for example "Waiting for the bank
to send the new host and key". Use it instead of leaving a task In progress while it waits on someone outside
the team.

To set one:
1. Press Shift+W, or choose Check again in the properties. The picker opens.
2. Choose the day. Type it ("dec 3", "in 2 weeks"), pick In a week, In two weeks or In a month, or pick a
   day in the calendar. Any day works, past days included.
3. Say why. The reason is required, up to 200 characters.
4. Press Enter to set both.

Clear takes the day off.

What rows and cards show depends on the day:

| When             | The chip reads                                                                    |
| ---------------- | --------------------------------------------------------------------------------- |
| The day is ahead | "Until Dec 3", in grey. The task is waiting                                       |
| From the day on  | "Check again: today", then "Check again: yesterday" and "Check again: 3 days ago" |

Display > "Waiting tasks" shows waiting tasks dimmed by default. From the day on, the task shows on your
Home under Check again when it is yours. The chip never uses the overdue colour.

The Waiting and Ready to check filters list the tasks on either side of the day.

The day stays until someone changes or clears it, or the task moves to Done or Canceled. That move clears
the day and adds a line to the history.

Days follow the server's `APP_TIME_ZONE`. Mirrored tasks can have a day too, as it is not a Backlog.md
field.

## The work record

The **work record** is what a task needs and what happened while someone worked on it. Agents write most of
it through `zamu` (see [agents.md](agents.md#the-work-record)). People read and edit it in the task view.

It has five parts:
- **Acceptance criteria** say what must be true when the task is done. They are numbered.
- **Definition of done** lists the checks every task passes, such as "Tests and lint pass". Each one is a
  done item. A new task starts with the project's defaults (see [Task defaults](#task-defaults)).
- **The plan** is Markdown, usually written by the agent when work starts.
- **The final summary** is Markdown, written before review.
- **Notes** are short entries in the activity, one per step of the work. See
  [Notes in the activity](#notes-in-the-activity).

The plan is open while the task is in progress and collapsed in review and done. Long plans are clipped
after 12 lines, with "Show all".

The final summary sits right under the title, and the description folds to two lines under it. D shows the
description again.

### Criteria and done items

Each criterion and done item is open, checked or waived. Waived means it no longer applies. A waived item
always has a reason, shown under the line: "Waived by Ana Ruiz: Alerting moves to its own task". A waived
line has a dashed box and struck-through text.

To work on the lists, click a box or move into the list with Shift+X. Then use the keys:

| Key           | Action                                                        |
| ------------- | ------------------------------------------------------------- |
| X             | Check or uncheck                                              |
| W             | Waive (type the reason and press Enter), or remove the waiver |
| E             | Reword                                                        |
| Alt+↑ / Alt+↓ | Reorder                                                       |
| Backspace     | Remove the line, with Undo in the toast                       |

Shift+A or "Add a criterion" adds a criterion. Enter adds it and keeps the field open for the next one.

### Finishing with open items

When you move a task to In review or Done while a criterion or done item is open, a dialog lists the open
items first: "2 items are still open". You can then:
- check what is done (X)
- waive what no longer applies (W, with a reason)
- move the task as it is (⌘Enter)

Esc cancels and leaves the status as it was.

The dialog shows wherever you set a status: the task view, the peek, a list or board row, a drag on the
board, and the command palette. When you move several selected tasks at once, one confirm says how many of
them have open items.

Agents get no dialog. The server refuses an agent's move to In review or Done while an item is open, and
`zamu` tells it which items to check or waive.

### Notes in the activity

A **note** is a short entry an agent writes after each step of its work, such as "Retry queue written and
tested". Notes look quieter than comments: no card, a line on the left and a Note tag.

People write notes too. N opens the comment box in note mode and M in comment mode. The Note switch in the
box changes between them.

A note reaches only the people it mentions. Notes are read-only once written.

The activity has four filters: All, Comments, Notes and History. History lists the changes only. Once a task
has more than 20 entries, each filter shows its count.

Changes and notes made through `zamu` say where they came from: the machine and the git branch, such as
"build-box · feat/payout-retries". They show on hover under All and always under Notes and History.

## Task defaults

Settings > Task defaults, in a project's settings, holds the project's definition of done. These are the
done items every new task starts with, such as "Tests and lint pass" or "Changelog has a line".

Owners and admins add, reword, reorder and remove them. Changes apply to tasks created afterwards. Existing
tasks keep their items.

An agent can leave the defaults out with `zamu tasks create --no-dod-defaults`, for a task that changes no
code.

In a project that mirrors Backlog.md the defaults apply once it is switched to Zamu.

## Pull requests on tasks

When a project links its repository, the task view lists the task's pull requests between the description
and the criteria. GitLab calls them merge requests. A project links its repository in Settings > Repository,
and [repositories.md](repositories.md) covers the setup.

Each request shows the host, the number, the title, how the request was linked and its state: Open, Draft,
Merged or Closed. A click opens the request on the host.

The Pull request row in the properties shows the newest request and how many more there are ("+3"). Rows
and cards show it when the Pull request chip is on in Display.

### How a request links to a task

A request links to a task in three ways:
- **By branch.** An agent started the task with `zamu` from a git branch, and the request was opened from
  that branch. Until a request exists, the task view shows the branch line under the description.
- **By description.** The request's description has a line such as `Closes: PAY-142, PAY-150`.
- **By hand.** You paste the request's address into the task.

To link a request by hand:
1. Press Shift+P, or choose "Link a pull request" in the task view or the peek. A field opens.
2. Paste the request's address. The field shows the request before you link it.
3. Press Enter to link it.

The field refuses an address from another repository with "That request is in another repository." It
refuses an address that is not a request and gives the reason.

To unlink a request, point at it and press its remove button. The toast has Undo. A request removed by hand
stays off the task. Neither the branch nor a `Closes:` line brings it back. Linking it by hand does.

### How requests move tasks

| The request                                           | Its tasks                                                                                         |
| ----------------------------------------------------- | ------------------------------------------------------------------------------------------------- |
| Opened, reopened or marked ready                      | Tasks in Backlog, Todo or In progress go to In review                                             |
| A draft                                               | Linked, not moved                                                                                 |
| Merged into the default branch                        | Tasks go to Done, when the project closes on merge and no other request of the task is still open |
| Merged into another branch, or closed without merging | Nothing moves                                                                                     |

The history names the host and the request: "GitHub moved this to In review · #482 opened by claude-dev".

In a project that mirrors Backlog.md, requests link and show but never move a task.

### Merged with open items

A merge moves a task to Done even when criteria or done items are still open. The task then carries the line
"Merged with 2 open criteria", or "Merged with 3 open items" when done items are open too. It also shows on
Home under "Merged with open criteria".

Check or waive the items, or reopen the task, and the line goes away.

## Archive

Archiving takes a task out of the list, the board, Home, `zamu dashboard` and every count, and keeps all of
it. You can archive a task by hand, or let the project archive finished tasks after a number of days.

Milestone and cycle progress keep counting archived tasks, so archiving never lowers a progress bar. A
parent's subtask progress counts them too.

### Archive finished tasks after some days

Each project's Settings > Archive has "Archive finished tasks". When it is on, a job archives Done and
Canceled tasks a set number of days after they reached that status. The job runs every night at 02:30 in the
server's `APP_TIME_ZONE`.
- Owners and admins turn it on or off and set the days, 1 to 365.
- Before you save, the page says how many tasks the next run would archive.
- New projects start with 14 days. Projects from before the upgrade start with it off.
- The job leaves alone tasks a merge closed with items still open (see
  [Merged with open items](#merged-with-open-items)).
- The history names Zamu as the one who archived them.

### Archive by hand

Shift+E archives the open task or the selected ones, from the list, the board or the task view. The action
bar has Archive too.

Anyone who can edit the task can archive it, in any status. Agents can too, with `zamu tasks archive`.

The toast says "3 tasks archived" with Undo, and ⌘Z undoes while it shows.

### Find archived tasks

- The Archived filter, or Display > "Archived tasks" set to Shown, adds them to the list. Their rows have a
  quiet title and "Archived Nov 12", and Restore on hover.
- Search and the command palette list archived tasks last, tagged Archived.
- "Show archived tasks in Payments" in the palette opens the list with the filter on.
- A link to an archived task opens it.

### Restore an archived task

An archived task is read-only. The task view starts with a bar, "Archived on Nov 12, 14 days after it was
done. It stays out of lists, boards and counts.", and Restore (Shift+E).

Its fields are locked. Comments and notes are refused too, and the comment box says to restore the task
first.

Restore brings the task back to lists and boards with its status. A restored Done or Canceled task counts
its days again from the restore.

### In a mirrored project

In a project that mirrors Backlog.md, the files decide. A task file under `archive/tasks/` (or the older
`completed/`) is archived here, and moving it back restores it. There is no archive setting and no Archive
button there. See [backlog-md.md](backlog-md.md#archived-tasks).

## Projects that mirror Backlog.md

Backlog.md keeps a project's tasks as Markdown files in a repository. A project that mirrors Backlog.md
reads its tasks from those files. [backlog-md.md](backlog-md.md) covers the setup.

Mirrored projects show the same fields as native ones, filled from the task files:
- labels, due dates, blockers and the parent
- the work record: criteria, done items, plan and final summary. The file's implementation notes show as one
  "Notes from the file" block.

Every field that comes from the files is read-only. A small Backlog.md badge in the task view links to the
file, and a lock shows when you point at a field or try to change it. Fields with no place here sit in "From
the file" at the bottom of the properties.

Comments and cycles stay editable, and so is the check-again day.

A task whose file sits under `archive/tasks/` is archived here.

Owners and admins can switch such a project to Zamu, which makes every field editable.

## Workspace settings

General is the first page of the workspace settings. Three things open it:
- Workspace settings in the sidebar and the workspace menu
- "Go to workspace settings" in the palette
- the address `/w/<slug>/settings`

### Name and address

Owners and admins change the Name and the Address and press Save changes. Members see them read-only.

Old links keep working after an address change. They open the same page at the new address. The page you are
on moves there with the toast "Acme now lives at /w/acme-corp. Old links keep working."

The old address stays with the workspace for 90 days. After that another workspace may take it.

### Leave a workspace

Leave workspace says "You lose access to its projects and tasks. Your API keys for it are deleted." It asks
"Leave Acme?" first.

Two kinds of member can't leave:
- The only owner: "You are the only owner of Acme, so you can't leave it. Delete the workspace instead."
- The responsible person of agents in the workspace, until they hand the agents to someone else or remove
  them. The message names the agents.

In Settings > Members, removing a person who is the responsible person of agents in the workspace is refused
the same way: "Tomás Berg is responsible for claude-dev here. Hand them to someone else or remove them
first."

### Delete a workspace

Delete workspace is in the danger zone, for owners. It deletes the projects, tasks, agents and API keys for
every member, and can't be undone.

The confirm, "Delete Acme?", lists what goes ("Deletes Acme with 3 projects, 120 tasks, 2 agents and 4 API
keys.") and asks you to type the address.

Afterwards the app opens `/` and shows "Deleted Acme." You land in another of your workspaces, or on the
page for [people without a workspace](#without-a-workspace).

### Your own settings

Appearance holds your theme, and it is yours in every workspace. Your API keys lists your keys for the
workspace you are in.
