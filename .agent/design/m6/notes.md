# M6 to M8 design notes

# M6

## Changes to the brief

1. **One editing frame became two.** Rewording, focus and adding a line share a frame; the waive step has its own, because its popover covers the lines under it.
2. **Long content is two frames**: 15 criteria fill a screen on their own, so the long plan and the long timeline are a second, scrolled frame.
3. **No token was added.** Waived, read-only and note states use the M5 text and line tokens, so there is no `tokens-m6.css`.

## Calls made in the design (change them if they're wrong)

1. **The summary leads a finished task.** Order: title, summary, description, criteria, done items, plan, subtasks and blockers, activity. With a summary present the description is clipped to two lines ("Show the description"); without one it shows in full.
2. **Criteria are numbered, done items are not.** Agents and history refer to criteria by number ("checked criterion 2", "waived criterion 5"). Done items are named by their text.
3. **Waived is three signals**: a dashed box with a bar, struck text, and a line "Waived by Ana: reason". Never colour alone.
4. **The plan is collapsed on a task in review** and open while work is in progress. It is plain Markdown, not a checklist: steps are not ticked.
5. **Notes are quieter than comments**: no card, a left rule, smaller grey text and a "Note" tag. An agent's comment keeps its card, because a comment asks for a reader.
6. **Machine and branch** show on hover under the All filter and always under History. A change made in the web app shows no source; a person using the CLI shows one.
7. **The criteria marker is off by default on rows and cards**, as one more chip in Display options. The peek and the task sidebar always show the counts.
8. **The peek opens on the summary** when a task has one, in place of the description.
9. **Mirrored tasks show notes as one read-only block**, because the task file holds notes as one section, not as dated entries.
10. **Default done items live on a new settings page, "Task defaults"**, which leaves room for other defaults later. Changing them affects new tasks only, and the page says so.
11. **A new task starts with the project's done items already listed**, marked "from the project defaults", so the empty task view is not empty there.
12. **"Detach" is renamed "Switch to Zamu"** and the settings page is "Backlog.md" after the switch (it was "Backlog.md sync").
13. **The switch dialog checks before it lets you confirm.** While the check runs, or when it fails, the confirm field and button are locked. With open requests the person can still confirm; the dialog lists what will be lost.
14. **Dialogs dim the whole window**, sidebar included.
15. **The finishing warning lists only the open items**, each with Waive, and X checks the focused one in place.

## Answered by the product owner (2026-11-25)

The M6 frames were approved as designed, with these calls confirmed:

1. **The summary sits above the description**, and the description is clipped to two lines when there is a summary.
2. **The criteria marker is off by default** on rows and cards.
3. **The switch stays locked when the merge-request check fails.** There is no "Switch without checking".
4. **Shift+X moves focus to the criteria list.**
5. **"Done items"** is the sidebar label for the definition of done.

## For the M6 plan

- `m6.css` is reference styling. `.dlg.swi` is named that way because `.sw` is already the colour swatch in `margin.css`.
- The timeline needs one more item kind (note) and a filter with four values and counts.
- History entries carry an optional machine and branch.
- The criteria list, the done-items list and the finishing dialog share one line component with three states and a read-only variant.
- The `.dc.html` files are reference markup, not code to copy. They use a design runtime (`support.js`), not React.

# M7

## Changes to the brief

1. **Draft, merged, open and closed requests share one frame** (052) next to the single open request (051), in place of four frames.
2. **The check-again chips, the pull-request marker, Display options and the board with waiting tasks are one sheet** (101), like the M6 progress sheet.
3. **"Integrations" in the project settings became "Repository"**, and "Archive" is a page of its own.

## Calls made in the design (change them if they're wrong)

1. **Pull requests sit between the description and the criteria** on a task, and the sidebar repeats the newest one with its state.
2. **How a request was linked is always shown**: "started on <branch>", "named in the description" or "linked by hand".
3. **Status changes caused by a request are written by a system actor** named after the host ("GitHub moved this to In review · #482 opened by claude-dev"). Automatic archiving is written by "Zamu".
4. **A task done through a merge with open criteria carries a flag line** in its sidebar and appears in a Home group of its own, under Mine and Everyone. It leaves the group when the criteria are checked or waived, or the task is reopened.
5. **The Repository page explains what Zamu never does** (comment, commit, change a request) in its empty state, since people will ask before pasting a token.
6. **The webhook secret is shown once** and masked afterwards, with New secret next to it, as on the Backlog.md webhook today.
7. **With closing on merge off, a new request still moves the task to In review.** Only the Done step is switched off, and the page says so.
8. **Archived tasks keep their rows**, with a quiet title and the archive date in place of "updated". Restore appears on hover and through Shift+E.
9. **Archived tasks come last in search** and carry a tag. The palette offers "Show archived tasks in Payments".
10. **An archived task is read-only**: the composer says to restore it first.
11. **The archive setting previews its effect** ("60 tasks will be archived tonight") before it is saved.
12. **A check-again chip is grey with a clock while waiting and turns to the accent colour when the day comes.** It never uses the overdue red, also days later.
13. **The check-again chip shows whenever a day is set.** The pull-request marker is off by default.
14. **Waiting tasks are dimmed on a board by default**, and "Waiting tasks" in Display options has three values: Shown, Shown dimmed, Hidden. Hidden columns say how many they hide. A task whose day has come is never dimmed or hidden.
15. **"Check again" on Home is under Mine only**: it is a note to yourself.

## Answered by the product owner (2026-11-25)

1. **Merged with open criteria is a Home group of its own**, as designed.
2. **Waiting tasks are dimmed by default**, as designed.
3. **The check-again reason is required.** The picker marks the field and says why (frames 095 and 098 were updated).

# M8

## Changes to the brief

1. **The plan link has no frame of its own.** Its three forms show in the page headers: a file path (103), a web address (121), none (117).
2. **Gate states are spread over three frames** (open in 103, failed in 108, passed in 109) so each shows in context.

## Calls made in the design (change them if they're wrong)

1. **Passed waves are collapsed, the current wave is open**, and its number takes the accent colour.
2. **A locked wave says what it waits for** ("Locked until W3 passes"), and its tasks carry a lock.
3. **The gate is a box at the end of its wave**, after the tasks, with Pass and Fail. A recorded result shows who recorded it, when, and the note.
4. **A failed gate puts a line across the top of the page** and a red rule on the gate box. A failed gate can be recorded again.
5. **Tasks of the milestone that are in no wave sit in their own group at the end**, which has no gate and never holds a wave up.
6. **A milestone without waves is unchanged**, with "Add waves" on its first group header and "Add a link to the plan" in the header.
7. **With many waves, the passed ones fold into one line** ("7 waves, all passed"), and a wave with many tasks shows the first six and "24 more".
8. **The milestone list shows the wave status under the milestone's name**: "Wave 3 of 5 · gate open", "Gate failed in wave 8 of 12" (with a mark), "All 4 gates passed".
9. **Moving a task between waves works by drag and by Alt+↑ / Alt+↓**, with a hint at the bottom while it moves.

## Answered by the product owner (2026-11-25)

1. **A gate can be passed only when every task in its wave is done or canceled.** Until then Pass is disabled and says what it waits for; Fail can be recorded at any time (frames 103 to 107 and 110 were updated).
2. **A failed gate reopens no task.** It keeps the next wave locked, and the note says what to fix; the fix is logged as a new task.
3. **Passed waves fold into one line when a milestone has more than six waves.**

# For the plans

- `m6.css`, `m7.css` and `m8.css` are reference styling, one per release, so each plan can take its part.
- M7's Home groups and filters need two new task facts from the server: "done through a merge with open criteria" and "check-again day reached".
- M8's milestone list needs the wave status per milestone in one request.
