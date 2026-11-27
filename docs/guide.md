# Using the app

This page covers the web app: workspaces, the sidebar, Home, the list and the board, the task view and the
peek, the work record, pull requests on tasks, the archive, check-again days, the command palette, the four
task fields (labels, due dates, blockers and subtasks), milestones in waves with gates, and Task defaults. The
keys are in [keyboard.md](keyboard.md).

## Workspaces

A workspace holds projects, their tasks, members, agents and API keys. One server can hold several, and you
can belong to more than one, with a role in each. Nothing crosses between them: Home, search, the palette
and every list show the workspace you are in.

Every page lives under the workspace's slug, such as `/w/acme/` for Home and `/w/acme/p/PAY/PAY-142` for a
task. Two workspaces can each have a project `PAY`, and a link always opens the task of its own workspace.
`/` opens the workspace you used last. Links from before 0.10 (`/p/PAY/PAY-142`, `/settings/members`) open
the same page in the workspace you used last.

Each browser tab stays in its own workspace, so two tabs can show two workspaces side by side. An invitation
opens the workspace that sent it once you accept. If you already have an account, sign in with the invited
email and choose "Join <workspace>" on the invitation page; signed out, the page offers "Sign in to join".

### Switching and creating

The workspace menu at the top of the sidebar lists every workspace you belong to under "Workspaces", with a
check on the current one. Choose another to open its Home. In the command palette, "Switch to Globex" does
the same, one command for each of your other workspaces.

"New workspace" in the workspace menu or the palette opens the New workspace dialog: "You become its owner.
Projects, members and API keys stay inside it." Type a Name, and the Address (the slug after `/w/`) is
suggested from it; you can change it. Addresses are 2 to 40 lower-case letters, digits and hyphens, start
with a letter and can't be a word the app uses, such as `settings` or `api`. The dialog says so under the
field: "This address is reserved. Pick another." or "The address globex is taken. Pick another." An address
another workspace used before is taken too. Create workspace (⌘Enter) opens the new workspace's Home, which
starts with "Nothing to show yet" and two steps: create a project, then add an agent. On servers set to
`WORKSPACE_CREATION=owners`, only people who already own a workspace see "New workspace"
([self-hosting.md](self-hosting.md#workspaces)).

Someone who belongs to no workspace, for example after leaving the last one, gets a page of their own. When
the server allows it, it shows "Create a workspace" with the same Name and Address fields; otherwise it says
"Ask an owner for an invitation", since the link in an invitation opens its workspace. Both show who is
signed in and Sign out.

### General settings

General is the first page of the workspace settings: Workspace settings in the sidebar and the workspace
menu, "Go to workspace settings" in the palette, and `/w/<slug>/settings` all open it.
- **Name and Address**: owners and admins change them and press Save changes; members see them read-only.
  Old links keep working after an address change: they open the same page at the new address, and the page
  you are on moves there with the toast "Acme now lives at /w/acme-corp. Old links keep working." The old
  address stays with the workspace for 90 days; after that another workspace may take it.
- **Leave workspace**: "You lose access to its projects and tasks. Your API keys for it are deleted." It
  asks "Leave Acme?" first. The only owner can't leave ("You are the only owner of Acme, so you can't leave
  it. Delete the workspace instead."), and neither can the responsible person of agents in the workspace
  until they hand the agents to someone else or remove them; the message names the agents.
- **Delete workspace**, in the danger zone, for owners: it deletes the projects, tasks, agents and API keys
  for every member, and can't be undone. The confirm, "Delete Acme?", lists what goes ("Deletes Acme with 3
  projects, 120 tasks, 2 agents and 4 API keys.") and asks you to type the address. Afterwards the app
  opens `/`, which lands in another of your workspaces or on the page above, and shows "Deleted Acme."

In Settings > Members, removing a person who is the responsible person of agents in the workspace is
refused the same way: "Tomás Berg is responsible for claude-dev here. Hand them to someone else or remove
them first."

Appearance is yours in every workspace. My keys lists your keys for the workspace you are in.

## Sidebar

The sidebar on the left holds, from top to bottom:
- the workspace menu: your workspaces, New workspace, Workspace settings, Invite people, New project and
  New from Backlog.md;
- Search or jump to, which opens the command palette (⌘K, Ctrl+K on Windows and Linux);
- Home, with the number of things that need you;
- your projects, by name, each with its number of open tasks. The current project expands to List, Board,
  Milestones, Cycles and Settings (Milestones and Cycles only when the project uses them). The "+" next to
  Projects creates a project or a project from Backlog.md;
- Workspace settings, which opens General;
- your menu: the theme (System, Light or Dark), My API keys, Keyboard shortcuts and Sign out.

`[` collapses the sidebar to icons and back. The app remembers your choice. Below 1100 pixels wide, the
sidebar stays collapsed.

The Dashboard, My tasks and Projects pages are gone. Their old links open Home.

## Home

Home (`/w/<slug>/`) shows what needs attention, across every project you can see in the workspace. It has
three tabs:
- **Mine**: tasks in review that wait on you, tasks a merge closed while items were open, your tasks whose
  check-again day has come, unanswered comments that mention you, and your own open tasks that are
  blocked, overdue or simply assigned to you. Your tasks are the ones assigned to you, and the ones you
  created that nobody holds yet.
- **Everyone**: tasks in review, merged with open criteria, blocked, overdue and due this week, across the
  workspace.
- **Agents**: one card per agent (working or idle, its current task, what it did today and its last
  actions), and "Waiting on a person": questions and review requests from agents that nobody answered yet.

Each task shows once, in the first group it fits, in this order: Needs your review, Merged with open
criteria, Check again, Mentions, Blocked, Overdue, Assigned to you. Mine and Everyone start with a deadlines
strip: milestones and cycles that end within 2 days, and tasks due within 2 days or overdue. "All clear"
means nothing waits.

The count after Home in the sidebar is Mine's review, merged with open criteria, check again, mentions,
blocked and overdue items. Items leave on their own when the reason clears: answer the comment, finish the
review, close the blocker, settle the open items, clear or move the check-again day.
- **Merged with open criteria** holds Done tasks that a merged pull request closed while a criterion or done
  item was still open (see [Pull requests on tasks](#pull-requests-on-tasks)). On Mine a task shows to the
  same person as Needs your review: the responsible person of the agent that holds it, else whoever created
  it. It leaves the group once every item is checked or waived, or when the task is reopened.
- **Check again** holds your open tasks whose check-again day is today or past (see
  [Check again](#check-again)). A task here shows in no later group.

Archived tasks never show on Home.

A task in "Needs your review" that has acceptance criteria shows how many are settled, such as "4 of 6
criteria".

Filter Home by project, label and priority. Labels with the same name in several projects are one entry in
the filter. C on Home asks which project the new task goes to.

## List and board

Every project has a list and a board. The List / Board switch in the header, V, or G then L and G then B
change between them, and the project remembers the last one you used.

The header row holds the project name, the switch, Filter, Display, search (/), and New task. In a project
that mirrors Backlog.md, it also shows the mirror's state and Refresh now.

**Filter** adds conditions: status, priority, assignee, labels, due date (overdue, due soon, has a due date,
no due date), blocked, milestone, cycle, Waiting and Ready to check (the check-again day is ahead, or has
come), and Archived. Active filters show as chips under the header, with the number
of matching tasks and Clear. Filters live in the page address, so a link keeps them.

**Display** sets how the view looks. You can change:
- the layout, list or board;
- the grouping (columns on the board): status, priority, assignee, milestone, cycle, label or none;
- swimlanes, on the board;
- the order: priority, due date, last updated, created, or manual (the board order you set by hand);
- subtasks: nested under their parent in the list, or as their own cards on the board;
- empty groups or columns, shown or hidden;
- "Hide done tasks after" a number of days (14 by default);
- "Waiting tasks", the tasks whose check-again day is ahead: Shown, "Shown, dimmed" (the default) or
  Hidden. A board column that hides some ends with a line such as "2 waiting, hidden";
- "Archived tasks": Hidden (the default) or Shown, the same as the Archived filter;
- which properties rows and cards show.

Display options are saved for you, per project and per view. Reset to default puts them back. By default
cards and rows show the key, the title, labels, subtask progress, the due date when set, the Blocked marker,
priority only when it is Urgent or High, and the assignee only when it is someone else.

The Criteria chip under "Shown on rows" and "Shown on cards" adds the criteria marker, off by default. It
shows after the subtask progress as "4/6", the acceptance criteria checked of the total, and fills in once
none is open. A task without criteria shows nothing.

Two more chips there: Check again (on by default) shows the check-again day, and Pull request (off by
default) shows the newest linked request with its number and state.

In the list, Enter or a click opens the task view. Space opens the peek. ← and → on a group row fold and
unfold it. On the board, drag a card to another column, or press Shift+← and Shift+→. Shift+J and Shift+K
move a card up and down when the order is Manual. ⌘Z (Ctrl+Z) undoes the last move from the toast.

### Selecting several tasks

X selects the task under the cursor, Shift+click or Shift+↓ and Shift+↑ extend the selection, and ⌘A selects
everything in the view. With two or more tasks selected, a bar at the bottom changes their status, assignee,
labels, priority, due date, milestone or cycle in one go, or archives them (Shift+E). The task keys (S, P, A,
L, Shift+D …) act on the whole selection too. Esc clears it.

Changes to several tasks work in native projects only. In a mirrored project the bar offers Copy keys, Copy
links and Open in Backlog.md.

## Task view and peek

![The task view of CHK-1, with its subtasks, the task it blocks and the properties sidebar](images/task-view-light.png)

A task opens as a full page at `/w/acme/p/PAY/PAY-142`. On the left, from the top: the title, the final
summary when there is one, the Markdown description, the pull requests, the acceptance criteria, the
definition of done, the plan, the Subtasks and Blocked by boxes, then the activity and the comment box (M).
The properties are on the right: status, priority, assignee, Criteria and Done items, Pull request, Check
again, labels, due date, parent, milestone, wave and cycle, each with its picker. Criteria and Done items show
their counts, and a click moves to the list. The work record has its own section below. The wave shows only
when the milestone has waves (see [Milestones in waves](#milestones-in-waves)).

E edits the title and D the description. J and K go to the next and previous task of the list or board you
opened it from ("12 of 40 in List"). Esc goes back there, with the task still under the cursor. Copy link
copies the task's address.

The peek opens over the list, the board or Home with Space. It shows the task's properties as chips, with
the criteria and done items counts, and the latest comment. A task with a final summary opens on the summary
instead of the description. J and K move it to the next task, Open goes to the task view, and Space or Esc
closes it.

Old links to the list with `?task=PAY-142` open the task view.

## The work record

The work record is what a task needs and what happened while someone worked on it. Agents write most of it
through `zamu` (see [agents.md](agents.md#the-work-record)); people read and edit it in the task view.
- **Acceptance criteria** say what must be true when the task is done. They are numbered.
- **Definition of done** lists the checks every task passes, such as "Tests and lint pass". Each one is a
  done item. A new task starts with the project's defaults (see [Task defaults](#task-defaults)).
- **The plan** is Markdown, usually written by the agent when work starts. It is open while the task is in
  progress and collapsed in review and done. Long plans are clipped after 12 lines, with "Show all".
- **The final summary** is Markdown, written before review. It sits right under the title, and the description
  folds to two lines under it; D shows the description again.
- **Notes** are short entries in the activity, one per step of the work (see below).

Each criterion and done item is open, checked or waived. Waived means it no longer applies, and it always
has a reason, shown under the line: "Waived by Ana Ruiz: Alerting moves to its own task". A waived line has
a dashed box and struck-through text.

To work on the lists, click a box or move into the list with Shift+X, then use the keys: X checks or unchecks,
W waives (type the reason and press Enter) or removes the waiver, E rewords, Alt+↑ and Alt+↓ reorder, and
Backspace removes the line, with Undo in the toast. Shift+A or "Add a criterion" adds a criterion; Enter
adds it and keeps the field open for the next one.

### Finishing with open items

When you move a task to In review or Done while a criterion or done item is open, a dialog lists the open
items first: "2 items are still open". Check what is done (X), waive what no longer applies (W, with a
reason), or move the task as it is (⌘Enter). Esc cancels and leaves the status as it was. The dialog shows
wherever you set a status: the task view, the peek, a list or board row, a drag on the board, and the
command palette. When you move several selected tasks at once, one confirm says how many of them have open
items.

Agents get no dialog: the server refuses an agent's move to In review or Done while an item is open, and
`zamu` tells it which items to check or waive.

### Notes in the activity

A note is a short entry an agent writes after each step of its work, such as "Retry queue written and
tested". Notes look quieter than comments: no card, a line on the left and a Note tag. They reach nobody
unless they mention them. Notes are read-only once written.

The activity has four filters: All, Comments, Notes and History. History lists the changes only. Once a task
has more than 20 entries, each filter shows its count. Changes and notes made through `zamu` say where they
came from: the machine and the git branch, such as "build-box · feat/payout-retries". They show on hover
under All and always under Notes and History.

People write notes too: N opens the comment box in note mode, M in comment mode, and the Note switch in the
box changes between them.

## Pull requests on tasks

When a project links its repository (Settings > Repository, see [repositories.md](repositories.md)), the
task view lists the task's pull requests (merge requests on GitLab) between the description and the
criteria: the host, the number, the title, how the request was linked and its state, Open, Draft, Merged or
Closed. A click opens the request on the host.

A request links to a task in three ways:
- **By branch**: an agent started the task with `zamu` from a git branch, and the request was opened from
  that branch. Until a request exists, the task view shows the branch line under the description.
- **By description**: the request's description has a line such as `Closes: PAY-142, PAY-150`.
- **By hand**: Shift+P, or "Link a pull request" in the task view or the peek, opens a field. Paste the
  request's address: the field shows the request before you link it, and Enter links it. An address from
  another repository is refused with "That request is in another repository.", and one that is not a request
  with the reason.

Point at a request and press its remove button to unlink it, with Undo in the toast. A request removed by
hand stays off the task: neither the branch nor a `Closes:` line brings it back, linking it by hand does.

Requests move their tasks:
- opened, reopened or marked ready: tasks in Backlog, Todo or In progress go to In review. Drafts link and
  move nothing;
- merged into the default branch: tasks go to Done, when the project closes on merge and no other request
  of the task is still open;
- merged into another branch, or closed without merging: nothing moves.

The history names the host and the request: "GitHub moved this to In review · #482 opened by claude-dev".
In a project that mirrors Backlog.md, requests link and show but never move a task.

A merge moves a task to Done even when criteria or done items are still open. The task then carries the line
"Merged with 2 open criteria" ("Merged with 3 open items" when done items are open too) and shows on Home
under "Merged with open criteria". Check or waive the items, or reopen the task, and the line goes away.

The Pull request row in the properties shows the newest request and how many more there are ("+3"). Rows
and cards show it when the Pull request chip is on in Display.

## Archive

Archiving takes a task out of the list, the board, Home, the dashboard and every count, and keeps all of it.
Milestone and cycle progress keep counting archived tasks, so archiving never lowers a progress bar, and a
parent's subtask progress counts them too.

**Archive after.** Each project's Settings > Archive has "Archive finished tasks": Done and Canceled tasks
are archived a set number of days after they reached that status, by a job that runs every night at 02:30
in the server's `APP_TIME_ZONE`. Owners and admins turn it on or off and set the days, 1 to 365. Before you
save, the page says how many tasks the next run would archive. New projects start with 14 days. Projects
from before the upgrade start with it off. The job leaves alone tasks a merge closed with items still open
(see [Pull requests on tasks](#pull-requests-on-tasks)). The history names Zamu as the one who archived
them.

**By hand.** Shift+E archives the open task or the selected ones, from the list, the board or the task view;
the action bar has Archive too. Anyone who can edit the task can archive it, in any status, agents included
(`zamu tasks archive`). The toast says "3 tasks archived" with Undo, and ⌘Z undoes while it shows.

**Finding archived tasks.** The Archived filter, or Display > "Archived tasks" set to Shown, adds them to the
list. Their rows have a quiet title and "Archived Nov 12", and Restore on hover. Search and the command
palette list archived tasks last, tagged Archived; "Show archived tasks in Payments" in the palette opens the
list with the filter on. A link to an archived task opens it.

**An archived task is read-only.** The task view starts with a bar, "Archived on Nov 12, 14 days after it
was done. It stays out of lists, boards and counts.", and Restore (Shift+E). Its fields are locked, and the
comment box says to restore the task first: comments and notes are refused too. Restore brings the task back
to lists and boards with its status. A restored Done or Canceled task counts its days again from the
restore.

In a project that mirrors Backlog.md, the files decide: a task file under `archive/tasks/` (or the older
`completed/`) is archived here, and moving it back restores it. There is no archive setting and no Archive
button there. See [backlog-md.md](backlog-md.md#archived-tasks).

## Check again

A check-again day says when to look at a task again and why it waits, for example "Waiting for the bank to
send the new host and key". Use it instead of leaving a task In progress while it waits on someone outside
the team.

Shift+W, or Check again in the properties, opens the picker. Type a day ("dec 3", "in 2 weeks"), pick In a
week, In two weeks or In a month, or a day in the calendar, then say why. The reason is required, up to 200
characters, and Enter sets both. Clear takes the day off. Any day works, past days included.

While the day is ahead the task is waiting: rows and cards show a grey chip, "Until Dec 3", and Display >
"Waiting tasks" shows them dimmed by default. From the day on the chip reads "Check again: today", then
"Check again: yesterday" and "Check again: 3 days ago", and the task shows on your Home under Check again
when it is yours. The chip never uses the overdue colour.

The day stays until someone changes or clears it, or the task moves to Done or Canceled, which clears it with
a line in the history. The Waiting and Ready to check filters list the tasks on either side of the day. Days
follow the server's `APP_TIME_ZONE`. Mirrored tasks can have a day too: it is not a Backlog.md field.

## Task defaults

Settings > Task defaults, in a project's settings, holds the project's definition of done: the done items
every new task starts with, such as "Tests and lint pass" or "Changelog has a line". Owners and admins add,
reword, reorder and remove them. Changes apply to tasks created afterwards; existing tasks keep their
items. An agent can leave the defaults out with `zamu tasks create --no-dod-defaults`, for a task that
changes no code. In a project that mirrors Backlog.md the defaults apply once it is switched to Zamu.

## Command palette

⌘K (Ctrl+K) opens the palette from any page. Type to find:
- pages: Home, and the list, board, milestones, cycles and settings of each project;
- projects: G then P opens the palette on projects only;
- tasks, by key (`PAY-142`) or by words of the title. Archived tasks come last, tagged Archived;
- actions: create a task or a project, switch the theme, collapse the sidebar, open the shortcut list.
  Create task "…" starts quick create with the words you typed as the title;
- workspaces: "Switch to Globex" for each of your other workspaces, "New workspace" and "Go to workspace
  settings".

On a task, or with tasks selected, the palette starts with their actions: Change status, Set priority,
Assign, Add labels, Set due date, Move to milestone, Add to cycle, Add blocker, Add subtask, Assign to me,
Copy key and Copy link. Some actions have a second step, such as Set status with the six statuses.
Backspace in an empty step goes back to the actions. The palette shows each action's key, so you learn them
as you go.

## Labels

Labels belong to one project. Type a name that doesn't exist in the label picker (L) and it creates the
label. Names are unique in the project, ignoring case, and up to 40 characters. The app picks one of nine
colours for a new label; Tab in the picker moves to the swatches if you want another.

Manage them in the project's Settings > Labels: the list shows how many tasks use each label. Rename a
label in place, change its colour, or delete it. Deleting asks first and says how many tasks lose the label;
the tasks keep everything else. Renames and deletes leave no history lines, and the task history keeps the
name it recorded.

## Due dates

A due date is a day, with no time. Set it with Shift+D: type a date ("nov 4", "tomorrow", "+3d",
"2026-11-20"), pick Today, Tomorrow or Next week, or a day in the calendar. Clear due date removes it.

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

A task can wait on other tasks of the same project. Add them in the Blocked by box of the task view, or
with Shift+B. The blocker shows the other side: "Blocks PAY-150".

A task with at least one open blocker shows a Blocked marker. It is a marker only: nothing stops a blocked
task from changing status. Once every blocker is Done or Canceled, the marker goes away.

A link that would close a loop is refused with the reason, for example "Can't add: PAY-150 already waits on
PAY-142." A blocker that is hidden or that you can't see reads "Removed task".

## Subtasks

A task can have subtasks in the same project, one level deep: a subtask can't have subtasks of its own.
Add them in the Subtasks box of the task view or with Shift+S. Type a title and press ⌘Enter to create a new
subtask, or pick an existing task. A new subtask takes the parent's assignee.

The parent shows its progress as done of total, with canceled subtasks left out. In the list, subtasks can
nest under their parent. On the board they are hidden by default: the parent card reads "5 subtasks · 2
done" and expands in place to list them. Turn on "Show subtasks as cards" in Display to see them as cards.

## Milestones in waves

A milestone can run in waves: ordered groups of its tasks, each ending at a gate. The gate says what must be
checked before the next wave starts, such as "Every payout screen works in light and dark". Agents usually
set the waves up from the CLI after writing the plan (see [agents.md](agents.md#plans-waves-and-gates)); the
milestone page shows where the plan stands and lets people change it.

**The header** shows the tasks, done and waves counts, and the link to the plan: a web address opens in a
new tab, anything else is a file path. Copy copies it. "+ Add a link to the plan" sets one.

**Waves** are numbered from 1 in their order: W1, W2, W3. Each header shows the number, the name, a progress
bar with "4 of 6", and the gate's state: Gate open, Gate passed, Gate failed, or a lock with what it waits
for ("Locked until W3 passes"). The current wave, the first one whose gate has not passed, has its number in
the accent colour and starts open; passed and locked waves start collapsed. ← and → collapse and expand the
focused wave. When a milestone has more than six waves, the passed waves from W1 fold into one line, such as
"7 waves, all passed". A wave with many tasks shows the first few and "24 more tasks in this wave · Show
all". With waves, the page groups by wave; Display still offers the status grouping, and filters apply
inside the waves.

Tasks in no wave sit under "Not in a wave" at the end: "No gate. These never hold a wave up." A milestone
without waves looks as before, with "+ Add waves" to start.

**The gate** sits at the end of its wave with its description, Fail and Pass, and the latest result: the
note, who recorded it (with the person an agent acts for) and when. Pass stays disabled while a task of the
wave is open, with the reason ("Pass unlocks when the 2 open tasks are done"); hidden tasks don't count, and
archived ones count by their status. Fail works at any time and reopens no task: log the fix as a task in
the same wave. A long note is clipped, with "Show the whole note".

To record a result, press Pass or Fail, or G while the wave or its gate has focus. Pick Passed or Failed,
write the note (it is required: say what was checked) and press ⌘Enter; Esc cancels. "Record again" records
a new result later, either way. Every result is kept, and the latest is the gate's state; a gate never goes
back to Open. A pass that comes before new work stays a pass: a task added to a passed wave, or reopened in
it, shows as "1 task open" next to the passed pill.

When a gate fails, a line across the top of the page names the wave and offers "Go to the gate". When every
gate has passed, a line says so and counts any task still open.

**The lock.** A wave is locked until every gate before it has passed. Locked tasks carry a lock glyph. An
agent that starts a task in a locked wave is refused (`WAVE_LOCKED`). A person is warned instead: moving
such a task to In progress or In review, from the task view, the list, the board, the peek, the palette or
a status key, opens "W4 is still locked" with what it waits for. Start anyway (⌘Enter) makes the change;
Cancel leaves the task as it was. Moves made by a merged pull request or a Backlog.md refresh are never
refused.

**Changing waves.** "+ Add a wave", or Shift+N, adds a wave at the end with the next number. The menu on a
wave header renames it, moves it up or down, and removes it; dragging the header's grip reorders. Removing
a wave asks first and moves its tasks to "Not in a wave"; the waves after it renumber. Edit the gate
description in the gate box. Drag a task to another wave, or press Alt+↑ and Alt+↓ to move the focused task
to the previous or next wave ("Moving PAY-173 to W4"); past the last wave it goes to "Not in a wave". The
task view's Wave field picks among the milestone's waves, and the task's history records each wave change
("W3 · Screens", or "a removed wave").

A task is in at most one wave, of its own milestone. Putting it in a wave of another milestone moves it to
that milestone; moving it to another milestone, or out of its milestone, takes it out of its wave. Anyone
who can change the project's tasks can change waves and record gates, agents included, also on a Completed
milestone.

**The milestone list** shows one line under each name: "Wave 3 of 5 · gate open", "Gate failed in wave 8 of
12", "All 4 gates passed" (with "· 1 task open" when a task of the milestone is still open), or "No waves".

In a project that mirrors Backlog.md, waves, gates and the plan link live in Zamu only and are never written
to the files. A refresh that changes a task's milestone takes it out of its wave.

## Projects that mirror Backlog.md

Mirrored projects show the same fields, filled from the task files: labels, due dates, blockers, the parent
and the work record (criteria, done items, plan and final summary, with the file's implementation notes as
one "Notes from the file" block). Every field that comes from the files is read-only. A small Backlog.md
badge in the task view links to the file, and a lock shows when you point at a field or try to change it.
Fields with no place here sit in "From the file" at the bottom of the properties. Comments and cycles stay
editable, and so is the check-again day. A task whose file sits under `archive/tasks/` is archived here.
Owners and admins can switch such a project to Zamu, which makes every field editable. See
[backlog-md.md](backlog-md.md).
