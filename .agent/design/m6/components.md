# Component inventory (M6 to M8 additions to Margin)

Everything below is new. It reuses the M5 tokens; classes live in `source/m6/m6.css`, `m7.css` and `m8.css`.

# M6

## Task view

| Component | States | Frames |
|---|---|---|
| Summary block (`.sum`) | with author and time; absent until the work is finished | 001, 002 |
| Clipped description (`.clip.h2` + `.more-l`) | two lines with a fade and "Show the description" when a summary leads the page | 001 |
| Criteria list (`.mbox` + `.crit`) | open, checked, waived with its reason; hover with grip, Waive and remove; keyboard focus; rewording (input); adding a line; read-only with lock and tooltip (mirrored) | 001, 003, 009, 010, 021 |
| Waive step (`.wv-pop`) | reason input, Enter waives, Esc cancels | 010 |
| Definition-of-done list | same line states, no numbers; "from the project defaults"; "None in the file" (mirrored) | 001, 004, 021 |
| Progress marker (`.critp` + `.cbx`) | partial (empty box + count), complete (filled box with a tick) | 001, 023 |
| Sidebar rows "Criteria" and "Done items" | count with "1 waived · 1 open"; "None yet"; "project defaults" | 001, 004 |
| Plan (`.plan`) | collapsed header; open; long, clipped with "Show all 60 lines"; "from the file" (mirrored) | 001, 003, 013, 048 |
| Work note (`.note`) | in the timeline with the "Note" tag; with machine and branch | 013, 014 |
| Timeline filter (`.act-tg`) | All, Comments, Notes, History, with counts | 013–015 |
| History line with source (`.src`) | machine and branch shown on hover under All, always under History; absent for web changes | 013, 015 |
| Composer, note mode (`.composer.note-on`) | Note switch on, "Add note" button | 014 |
| Closed composer | hints for note (N) and comment (M) | 013 |
| Read-only notes block (`.ro-block`) | mirrored task | 021 |

## Dialogs

| Component | States | Frames |
|---|---|---|
| Finishing with open items (`.dlg.fin`) | open items listed with focus, Waive per item, Cancel, Move anyway | 019 |
| Switch to Zamu (`.dlg.swi`) | checking (skeleton); none open (confirm typed, button enabled); three open; three open and confirmed; forty open ("35 more"); check failed (locked) | 032–037 |

## Rows, cards, peek

| Component | States | Frames |
|---|---|---|
| Criteria marker on a row and a card | partial, complete, none (nothing shown); next to subtasks, due and blocked markers | 023 |
| "Criteria" chip in Display options | on, keyboard focus | 023 |
| Peek with the work record | both counts as chips; opens on the summary | 023 |

## Settings

| Component | States | Frames |
|---|---|---|
| Default items table (`.dod-tbl`) | empty with action; rows with grip; row hover with Edit and remove; editing; add line | 025–027 |
| Backlog.md page, before | repository facts, "Switch to Zamu" card | 031 |
| Backlog.md page, after | "Owned by Zamu since" line, export command with Copy (`.cmd`) | 038 |

# M7

## Pull requests

| Component | States | Frames |
|---|---|---|
| Pull-request row (`.prq`) | host, number, title, how it was linked, state pill; hover with remove; dimmed preview while linking | 051, 052, 057 |
| State pill (`.prs`) | Open, Merged, Draft (dashed), Closed: always a word | 052 |
| Branch line (`.brline`) | work started on a branch, no request yet | 053 |
| Link field | pasted address with preview; not a request (error text); another repository (refusal note) | 057–059 |
| "Pull request" sidebar row | number and state; "+3" when there are more | 051, 052 |
| Flag line (`.flagline`) | "Merged with 2 open criteria" at the top of the task sidebar | 063 |
| History line with a cause | system actor (GitHub, Zamu) and the reason after a dot | 063, 087 |
| Home group "Merged with open criteria" | row with the pill and who merged | 064, 065 |
| Marker on a row and a card (`.prm`) | open request with its number; branch only | 101 |

## Repository settings

| Component | States | Frames |
|---|---|---|
| Repository facts | linked repository with Change; default branch | 070 |
| Empty state | no repository linked | 069 |
| Switch row (`.set-tg`) | close on merge on, off (with what still happens) | 071, 073 |
| Event status (`.hook-st`) | never received, healthy, failed signature check, loading | 070–072, 074 |
| Copy field (`.copyf`) | payload URL; secret shown once; masked with New secret | 070, 072 |
| Setup steps | per host, as a segmented control | 070 |

## Archive

| Component | States | Frames |
|---|---|---|
| Archive setting | off; on with the number of days and a preview count | 081, 082 |
| Archived row (`.row.arch`) | quiet title, "Archived Nov 12"; hover with Restore | 083 |
| Filter chip "Archived is shown" | with the count | 083 |
| Action bar with Archive | three selected | 084 |
| Toast | "3 tasks archived", Undo | 085 |
| Search result with the tag (`.tagq`) | archived results last | 086 |
| Archived bar on a task (`.arch-bar`) | date, what it means, Restore; the composer says to restore first | 087 |

## Check again

| Component | States | Frames |
|---|---|---|
| Picker | shortcuts, calendar, reason field, Clear | 095 |
| Chip (`.chk`) | waiting (grey, clock); the day has come (accent, "Check again: today", "3 days ago") | 096, 097, 101 |
| Sidebar row | unset with key hint; set with the reason under the chip | 095–097 |
| Home group "Check again" | row with the chip and the reason | 064 |
| Waiting card | dimmed; hidden with a column footer "2 waiting, hidden" | 101 |
| Display options | chips "Pull request" and "Check again"; "Waiting tasks" and "Archived tasks" selects | 101 |

# M8

| Component | States | Frames |
|---|---|---|
| Plan link (`.pl`) | file path with Copy; web address as a link; none ("Add a link to the plan") | 103, 121, 117 |
| Wave header (`.wave-hd`) | collapsed, open, current (accent number), locked, hover with grip and menu, renaming | 103, 113 |
| Gate pill (`.gate`) | open, passed (tick), failed (mark), locked (lock and "Locked until W3 passes") | 103, 108 |
| Gate box (`.gatebox`) | open with Fail and Pass; failed with note, author and Record again; passed with note; long note clipped | 103, 108, 109, 121 |
| Record a result (`.gate-pop`) | Passed or Failed, note, what happens next | 107 |
| Stop line / all-passed line | a failed gate stops the plan; every gate passed | 108, 109 |
| Task row in a wave | default, locked (lock glyph), dragged, drop line | 103, 113 |
| "Not in a wave" group | collapsed, open | 103, 109 |
| Add a wave | link; input with the next number | 103, 113 |
| Move hint (toast) | "Moving PAY-173 to W4", keys, Esc | 113 |
| Locked-wave warning (`.dlg.lk`) | Cancel, Start anyway | 114 |
| Folded passed waves | "7 waves, all passed" in one line | 121 |
| Milestone row with wave status | "Wave 3 of 5 · gate open", failed (mark and words), all passed, no waves | 118 |
| Loading and error | skeleton rows; error with Try again | 122, 123 |
