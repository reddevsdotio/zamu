# Claude Design brief: M6 to M8 screens (work record, pull requests, archiving, check-again dates, waves and gates)

Run this in the existing canvas that holds the M5 "Margin" design, so it reuses `margin.css`, `screens.css`, the sample data and every component. To run it somewhere else, upload these first and paste everything below the line:

- `.agent/design/m5/tokens.css`
- `.agent/design/m5/round2/source/margin.css` and `.agent/design/m5/round2/source/screens.css`
- `.agent/design/m5/components.md` and `.agent/design/m5/shortcuts.md`
- From `.agent/design/m5/round2/screens/`, in light and dark: the kit (001, 002), the project list (011), the board (029), the task view (051, 053, 054, 057), the peek (067), the due-date picker (074), Home (099 to 101), milestones (107, 108) and the Labels settings page (116)

The pass is one round. It covers three releases, and each section says which release it belongs to, so the screens can be built in three steps.

---

Add screens and states to a web app whose other screens already exist. You don't need access to any code repository. Everything you need is in this brief and the uploaded files.

## Product

Zamu is an open-source, self-hosted project management tool for solo developers and small teams who run several software projects. AI coding agents are members of the workspace, next to people. They get tasks assigned, update status, comment, and leave a trail. Every change shows who made it, and for agents, which person they act for ("claude-dev for Ana"). Most writing happens through a CLI used by agents. People use the web app to plan, review and follow the work.

Audience: developers. They work fast, use the keyboard, and want dense views they can read at a glance. The tool should feel calm, quick and quiet.

## What changes, and why

Until now agents kept the record of their work in task files inside the git repository, and the app only showed a read-only copy. From these releases on, agents write that record straight to the app:

- **M6** gives a task a work record: acceptance criteria, a definition of done, a plan, work notes and a final summary. It also lets a project that copies task files switch to being owned by the app.
- **M7** connects pull requests to tasks, archives finished tasks, and adds a "check again" date.
- **M8** gives a milestone waves and gates, so a plan can be followed step by step.

The person's job in the web app shifts from editing tasks to reading what agents did and deciding. Every new screen should make an agent's work quick to review.

## Starting point

The app follows the "Margin" direction from M5: a collapsible sidebar, one main pane, a slim view header, a full-page task view with a peek, pickers, and a command palette.

- Keep the direction, its tokens and its components. Add tokens only where a new piece needs one, and list every addition.
- Reuse the existing row, card, chips (label, due), status and priority glyphs, avatars (round for people, square for agents), pickers, menus, the toast with Undo, the confirm dialog, and the existing empty, loading and error patterns.
- Quiet by default still holds. A new marker on a row or card has to earn its place. Say for each one whether it shows always, only when set, or only through Display options.

## Constraints

- Built in React with React Aria Components and Tailwind v4. Tokens are CSS custom properties, colours in OKLCH.
- One accent colour. Status and label colours are separate, muted sets.
- Light and dark themes are equals.
- Desktop only: 1440, 1280 and 1024px. At 1024 the sidebar collapses to icons. No phone layouts.
- WCAG AA contrast in both themes. Colour is never the only signal: every new state (waived, archived, waiting, gate failed, merged with open criteria) also has a word or a glyph.
- Keyboard first. Every action is reachable from the command palette. Existing single keys are listed under Keyboard; propose keys for the new actions and resolve conflicts.
- No charts. Counts, progress bars, rings and short text only.

## Domain

What exists today:

- **Workspace**: projects and members. A member is a person or an agent. Each agent acts for one person.
- **Project**: a name plus a short uppercase key, e.g. "Payments" with key PAY. It has a task list, a board, milestones, cycles and settings.
- **Task**: key (PAY-42), title, description (Markdown), status, priority, assignee, milestone, cycle, labels, due date, blockers, subtasks, comments and an activity history.
- **Statuses**: Backlog, Todo, In progress, In review, Done, Canceled. Open means not Done and not Canceled.
- **Mirrored projects** copy a git repository's task files. Their fields are read-only in the app. Native projects are edited in the app and through the CLI.

### M6: the work record on a task

A task gains five things. Mirrored tasks show the same five, read-only, filled from their file.

1. **Acceptance criteria**: an ordered list of short lines that say what must be true when the task is done. Each line is open, checked or waived. A waived line keeps a short reason ("Waived: reviewed on staging instead"). A person can check, uncheck, waive, add, reword, reorder and remove lines. Typical tasks have 2 to 6 lines; some have 15.
2. **Definition of done**: a second list with the same three states. It holds the checks every task in the project must pass ("Tests pass", "Changelog updated"). A project can define default items in its settings, and new tasks start with them.
3. **Plan**: Markdown, written by whoever picks the task up, usually an agent. Often a numbered list. It can be long.
4. **Work notes**: comments that are marked as notes. An agent writes one after each step ("Migration written and tested against a copy of production; 3 rows needed a manual fix"). Notes live in the same timeline as comments and history, look quieter than a comment from a person, and can be filtered: All, Comments, Notes, History. A note notifies nobody unless it mentions someone. A person can write a note too, through a switch on the comment box.
5. **Final summary**: Markdown, written once when the work is finished: what changed, how it was checked, what is left. It is the first thing a reviewer wants to read, so on a task that is In review or Done it should sit near the top, above the plan.

Rules the screens must show:

- **Progress.** The task view shows "4 of 6 criteria" and "2 of 2 done items". Rows, cards and the peek may show a compact marker; propose whether that is on by default.
- **Finishing with open items.** When a person moves a task to In review or Done while criteria or done items are still open, the app warns ("2 criteria are still open") and lets them continue, check them, or waive them with a reason. Agents are refused by the server; the web app only ever shows the warning.
- **Where a change came from.** History entries for agent changes now also show the machine and the git branch: "claude-dev for Ana · laptop · feat/payout-retries". Keep this quiet; it matters when tracing a change, not on every read.

### M6: switching a mirrored project to the app

A mirrored project can switch, once, to being owned by the app. Afterwards its tasks are edited in the app and the files are no longer read. This replaces today's "Detach" action in Project settings > Backlog.md.

The flow:

1. The settings page explains the switch in two sentences and offers "Switch to Zamu".
2. The app checks the repository for open pull requests that change the task files and lists them (number, title, author, branch). Their task edits will be lost. There can be none, a few, or more than fit.
3. The person confirms by typing the project key. There is no undo, and the dialog says so.
4. Afterwards the page reads "Owned by Zamu since Nov 30" and shows a CLI command that writes the project back out as task files (`zamu backlog export`), with a copy button and one line on what the export is for (a copy to keep, or a way to leave).

### M7: pull requests on a task

Agents open pull (or merge) requests for their work. One request often covers several tasks, and a task can have more than one request.

- A task shows its linked requests: host (GitHub, GitLab or Forgejo), number, title, state (Open, Draft, Merged, Closed), branch, and how it was linked: "started on this branch", "named in the description", or "linked by hand". A person can link a request by pasting its address and can remove a link.
- A task also shows the branch its work started on, when there is one and no request yet.
- Status follows the request: when a request opens, the task moves to In review; when it merges, the task moves to Done. History says why: "Moved to Done: #482 merged by Tomás". A request that is closed without merging changes nothing.
- A task can reach Done through a merge while criteria are still open. Home must flag these so a person looks at them: propose a group or a marker ("Merged with 2 open criteria").
- Rows and cards may carry a quiet marker for an open request. Propose whether it is on by default.
- Project settings get a **Repository** page:
  - the linked repository;
  - a switch "Close tasks when their pull request merges", on by default, with one line on what happens when it is off (requests still link, the status stays);
  - webhook setup for pull-request events: an address and a secret to copy, short steps per host, and a status line ("Last event 4 minutes ago", "No event received yet", "Last event failed its signature check");
  - a note that the app also checks once an hour without a webhook.

### M7: archived tasks

Finished tasks pile up. A project can archive Done and Canceled tasks a set number of days after they reached that status.

- Project settings: a switch "Archive finished tasks" and a number of days (default 14).
- Archived tasks leave lists, boards and counts. They stay in search results with a marker, and a filter "Archived" shows them in the list.
- An archived task opens in the normal task view with a clear but calm marker ("Archived on Nov 12") and a Restore action. Its fields are read-only until it is restored.
- A person can archive by hand, one task or several selected, with the Undo toast, and can restore the same way.

### M7: check-again date

Some tasks wait on the outside world: a vendor reply, a certificate that renews next month, a metric that needs two weeks of data. A task can hold a **check-again day** and a short reason ("Vendor promised a fix in their December release").

- This is different from a due date. A due date that passes is late. A check-again day that arrives only means "look again", so it must never read as overdue or use the overdue colour.
- Until the day comes, the task shows a quiet "Waiting until Dec 3" chip, and people may want to hide waiting tasks from a board.
- From that day, Home lists the task for its assignee in a group of its own ("Check again"), and the chip changes to "Check again: today" or "Check again: 3 days ago".
- The picker reuses the due-date picker and adds the reason field.
- Filters: "Waiting" and "Ready to check".

### M8: waves and gates on a milestone

People plan a milestone as a document, then hand it to an agent that works through it. The document stays outside the app; the app holds the structure and the progress.

- **Plan link**: a milestone can hold one link or file path to its plan. The app may not be able to open it, so show it as text with a copy button, and as a link when it is a web address.
- **Wave**: an ordered group of tasks that can be worked on at the same time. Waves have a short name ("W1 · Data and contracts") and their tasks.
- **Gate**: the check at the end of a wave. It has a description ("All checks pass and the walkthrough is done"), a state (Open, Passed, Failed) and a note, with who recorded the result and when ("claude-dev for Ana, 2 hours ago").
- A wave is **locked** until the gate before it has passed. A person who starts a task in a locked wave gets a warning and can continue. Agents are refused by the server.
- A failed gate stops the plan and must be the most visible thing on the page.
- The milestone page shows the waves in order with progress, the current wave open and earlier ones collapsed. A person can add, rename, reorder and remove waves, move tasks between waves (drag, and by keyboard), set a gate's description, and record a gate result with a note.
- Tasks that belong to the milestone and to no wave appear in a group of their own ("Not in a wave").
- A milestone without waves looks as it does today, with one quiet way to add the first wave.
- The milestone list shows where each milestone stands: "Wave 2 of 5 · gate open", "Gate failed in wave 3", "All gates passed".

## Screens

Show every screen in light and dark.

**M6**

1. **Task view with a full work record**, In review: final summary, criteria (4 checked, 1 waived, 1 open), definition of done, plan, timeline with notes, comments and history mixed. At 1440 and 1280.
2. **Task view, work just started**: criteria all open, a plan, two notes, no summary.
3. **Task view, empty work record**: a task with none of the five set, with quiet ways to add each. It must not look like a form to fill in.
4. **Criteria editing**: adding a line, rewording, reordering, the waive step with its reason, keyboard focus on a line.
5. **Timeline filters**: All, Comments, Notes, History; the comment box with the note switch on.
6. **Finishing with open items**: the warning with its three ways out.
7. **Mirrored task** with the work record read-only.
8. **History entries** with machine and branch, for an agent and for a person.
9. **Compact progress** on a list row, a board card and the peek, next to the existing markers on the task that has everything set.
10. **Project settings: default definition of done**: empty, with three items, editing.
11. **Switch to Zamu**: the settings page before; the dialog with no open requests, with three, and with forty; the typed confirmation; the page after, with the export command.
12. **Long content**: 15 criteria with long lines, a plan of 60 lines with code, 40 notes in the timeline.

**M7**

13. **Task view with pull requests**: one open request; two requests (one merged, one open); a draft; a closed one; a task with only a branch.
14. **Linking by hand**: the paste field, an address the app does not recognise, a request from another repository refused.
15. **History** showing the status changes caused by requests.
16. **Home with "merged with open criteria"** tasks, in Mine and Everyone.
17. **Project settings: Repository**: no repository linked; linked with the webhook not set up; set up and healthy; last event failed; the close-on-merge switch off.
18. **Project settings: archiving**: off, on with the number of days.
19. **Archived tasks**: the list filtered to Archived; an archived task view with Restore; search results mixing live and archived tasks; archiving three selected tasks with the Undo toast.
20. **Check-again picker**: empty, set with a reason, keyboard focus.
21. **Check-again chips** on a row, a card, the peek and the task view: waiting, today, 3 days ago, next to a due chip.
22. **Home with a "Check again" group**; a board with waiting tasks shown, and with them hidden through Display options.

**M8**

23. **Milestone page with waves**: five waves, the first two passed, the third in progress with its gate open, the last two locked. At 1440 and 1280.
24. **Gate states**: open, passed with a note, failed with a note; recording a result.
25. **A failed gate** on the milestone page.
26. **Editing waves**: adding, renaming, reordering, moving a task to another wave by drag and by keyboard, the "Not in a wave" group.
27. **Starting a task in a locked wave**: the warning.
28. **Milestone without waves** and **milestone with all gates passed**.
29. **Milestone list** with the wave status on each row, including a failed gate.
30. **Plan link**: a web address, a file path, none.
31. **Long content**: 12 waves, a wave with 30 tasks, a gate note of several paragraphs.

For every group also show loading and error where the screen fetches something new (the open pull requests in screen 11, the webhook status in 17, the waves in 23).

## Keyboard

Existing keys that must keep working:

- Global: ⌘K palette, C new task, / search, G then H, P, L, B, M, Y to go places, [ sidebar, ? shortcuts.
- Lists and boards: J / K, arrows, X select, Space peek, Enter open, Esc, V switch view.
- On a task: S status, P priority, A assignee, I assign to me, L labels, Shift+D due, Shift+M milestone, Shift+C cycle, Shift+B blocker, Shift+S subtask, M comment, ⌘C copy key.
- Task view: J / K next and previous task, E title, D description.
- Dialogs and the comment box: ⌘Enter submit, Esc cancel, @ mention.

Propose keys for: moving through and checking criteria, waiving one, adding a criterion, writing a note, archiving and restoring, setting the check-again date, linking a pull request, recording a gate result, and moving a task between waves. List every new key and how each conflict is resolved.

## Sample data

Use the M5 sample data and add to it. Don't invent real company or product names.

**Workspace "Northwind Labs"**: Ana Ruiz (the viewer), Tomás Ferrer; agents claude-dev (acts for Ana) and review-bot (acts for Tomás).

**Project "Payments" (PAY)**, native, repository on GitHub:

- **PAY-142 "Retry failed payouts"**, In review, assigned to claude-dev. Six criteria: four checked, one waived ("Waived: load test replaced by a replay of last week's traffic"), one open. Two done items, both checked. A plan of eight steps. Seven notes by claude-dev from the machine "laptop" on branch `feat/payout-retries`. Pull request #482 "Retry failed payouts with backoff", open, linked because the work started on that branch. A final summary of three short paragraphs.
- **PAY-150 "Payout report export"**, Done through the merge of #479 with two criteria still open.
- **PAY-131 "Rotate the bank API certificate"**, Todo, check again on Dec 3: "The bank issues the new certificate on Dec 1".
- 60 Done tasks older than two weeks, for the archive screens.
- Milestone **"Payouts v2"**, target Dec 12, with five waves: "W1 · Data and contracts" (3 tasks, gate passed), "W2 · Core and API" (5 tasks, gate passed), "W3 · Screens" (6 tasks, 4 done, gate open), "W4 · End-to-end tests" (3 tasks, locked), "W5 · Release" (2 tasks, locked). Plan link: `plans/payouts-v2.html`.

**Project "Harbor" (HBR)**, mirrored, repository on GitLab, 123 open tasks. Use it for the mirrored work record and for the switch flow, with three open merge requests that change its task files.

## Hand-off

Return:

1. **Screens** as PNGs named `<n>-<section>-<component>-<theme>-<state>[-1280].png`, numbered in canvas order, grouped by release (M6, M7, M8).
2. **Token additions** as CSS custom properties in OKLCH with light and dark values, in a separate `tokens-m6.css`, with a note on each. Leave the M5 `tokens.css` unchanged, and say so if nothing was added.
3. **A component inventory** for the new pieces and their states (default, hover, keyboard focus, selected, read-only, loading): criteria list and line, waive step, work note, timeline filter, final summary block, plan block, progress marker, pull-request row, branch line, archived marker, check-again chip and picker, wave, gate, plan link, locked marker, and the switch dialog.
4. **The shortcut list** for the new actions, with conflicts resolved.
5. **Notes** on anything you changed or questioned in this brief, and open questions for the product owner. Mark which release each one belongs to.

Export as HTML (`.dc.html` sources, one per section, plus a canvas file) so a developer can open it locally.
