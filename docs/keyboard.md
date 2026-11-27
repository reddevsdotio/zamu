# Keyboard shortcuts

Most of the app works from the keyboard. This page lists every key for people who use the web app, grouped
by where the key works. [guide.md](guide.md) explains the screens the keys act on.

Press ? on any page to see the list in the app, or open it from your menu at the bottom of the sidebar. On
Windows and Linux, ⌘ is Ctrl.

## How keys behave

Single keys do nothing while you type in a field, the comment box or a picker's search. Esc leaves the field
first.

Keys follow the character you type, so they work on any keyboard layout. `[` is the exception. It is the key
to the right of P, whatever it prints.

Esc closes the topmost layer first, in this order:

1. A picker or menu. When its search has text, the first Esc clears the text.
2. The palette, the command palette that ⌘K opens.
3. A dialog.
4. The peek, the smaller view of a task that Space opens.
5. The selection.

After that, Esc goes back.

## Global

| Key      | Action                           |
| -------- | -------------------------------- |
| ⌘K       | Command palette                  |
| C        | New task in the current project  |
| /        | Search the current view          |
| G then H | Go to Home                       |
| G then P | Jump to a project (the palette)  |
| G then L | The current project's list       |
| G then B | The current project's board      |
| G then M | The current project's milestones |
| G then Y | The current project's cycles     |
| [        | Collapse or expand the sidebar   |
| ?        | Keyboard shortcuts               |

Outside a project, G then L, B, M and Y open the last project you visited.

## Lists, boards and Home

| Key               | Action                                                           |
| ----------------- | ---------------------------------------------------------------- |
| J / K or ↓ / ↑    | Next or previous row or card                                     |
| ← / →             | On the board: previous or next column                            |
| ← / →             | On a group row of the list: fold or unfold the group             |
| X                 | Select or unselect                                               |
| Shift+↓ / Shift+↑ | Extend the selection                                             |
| Shift+click       | Select a range                                                   |
| ⌘A                | Select everything in the view                                    |
| Space             | Peek. Space or Esc closes it, and J / K move it to the next task |
| Enter             | Open the task view                                               |
| Esc               | Clear the selection                                              |
| V                 | Switch between list and board                                    |
| Shift+← / Shift+→ | On the board: move the card to the previous or next column       |
| Shift+J / Shift+K | On the board: move the card down or up (Order by Manual only)    |
| ⌘Z                | Undo the last change, from its toast, archiving included         |
| Shift+R           | Refresh now, in a project that mirrors Backlog.md                |

A project that mirrors Backlog.md reads its tasks from Markdown files in a repository. See
[backlog-md.md](backlog-md.md).

## A selected or open task

With several tasks selected, these keys act on all of them. That works in native projects only, not in
mirrored ones.

| Key     | Action                                                        |
| ------- | ------------------------------------------------------------- |
| S       | Status                                                        |
| P       | Priority                                                      |
| A       | Assignee                                                      |
| I       | Assign to me                                                  |
| L       | Labels                                                        |
| Shift+D | Due date                                                      |
| Shift+M | Milestone                                                     |
| Shift+C | Cycle                                                         |
| Shift+B | Add a blocker                                                 |
| Shift+S | Add a subtask (one task only)                                 |
| Shift+P | Link a pull request (one task, in the task view and the peek) |
| Shift+E | Archive, or restore an archived task                          |
| Shift+W | Set the check-again day                                       |
| M       | Comment                                                       |
| ⌘C      | Copy the task key (or keys)                                   |
| ⌘⇧C     | Copy the link                                                 |

⌘C copies the key only when no text is highlighted. With text highlighted, it copies the text as usual.

The check-again day says when to look at a task again. See [guide.md](guide.md#check-again).

## Task view

| Key     | Action                                                                      |
| ------- | --------------------------------------------------------------------------- |
| J / K   | Next or previous task of the list you came from ("12 of 40 in List")        |
| Esc     | Back to the list or board, with the task still under the cursor             |
| E       | Edit the title                                                              |
| D       | Edit the description, or show it when a final summary folds it              |
| Shift+A | Add a criterion                                                             |
| Shift+X | Move to the first open criterion (or done item)                             |
| N       | Write a note. The comment box opens in note mode (M opens it for a comment) |

## Criteria and done items

These keys work on the focused line of the Acceptance criteria or Definition of done list in the task view.
Both lists belong to the task's work record, which [guide.md](guide.md#the-work-record) explains. Mirrored
tasks show the lists read-only.

| Key           | Action                                                             |
| ------------- | ------------------------------------------------------------------ |
| ↑ / ↓         | Previous or next line                                              |
| X             | Check or uncheck the line                                          |
| W             | Waive the line (type the reason, then Enter), or remove its waiver |
| E             | Reword the line                                                    |
| Alt+↑ / Alt+↓ | Move the line up or down                                           |
| Backspace     | Remove the line, with Undo in the toast                            |
| Enter         | In the add field: add the line and keep the field open             |
| Esc           | Leave the list                                                     |

## Finishing with open items

These keys work in the dialog that opens when you move a task to In review or Done while criteria or done
items are open.

| Key    | Action                             |
| ------ | ---------------------------------- |
| ↑ / ↓  | Move between the open items        |
| X      | Check the focused item             |
| W      | Waive the focused item             |
| ⌘Enter | Move the task anyway               |
| Esc    | Cancel. The status stays as it was |

## Pickers and menus

| Key                             | Action                                                            |
| ------------------------------- | ----------------------------------------------------------------- |
| Type                            | Filter the list                                                   |
| ↑ / ↓                           | Move                                                              |
| Enter                           | Pick. In pickers with several choices, such as labels, it toggles |
| 1 to 6 in the status picker     | Backlog, Todo, In progress, In review, Done, Canceled             |
| 0 to 4 in the priority picker   | None, Urgent, High, Medium, Low                                   |
| ⌘Enter in the subtask picker    | Create a subtask from the typed text                              |
| ← / → in the due-date calendar  | Previous or next day (↑ / ↓ move a week)                          |
| Enter in the check-again reason | Set the day and the reason                                        |
| Enter in the pull request field | Link the request                                                  |
| Tab in the label picker         | Move to the colour swatches when creating a label                 |
| Backspace in an empty palette   | Back out of a palette step, such as Set status                    |

## Dialogs and the comment box

| Key    | Action                                          |
| ------ | ----------------------------------------------- |
| ⌘Enter | Submit: create the task, post the comment, save |
| Esc    | Cancel                                          |
| @      | Mention someone in a comment                    |

In quick create (C), I assigns the task to you, Shift+M opens the milestone and Shift+C the cycle.

## Changes by release

### 0.11.0

Three new keys, each next to the key it resembles:

- Shift+P links a pull request in the task view and the peek. Paste its address, then press Enter. It sits
  next to P (priority).
- Shift+E archives the selected tasks or the open task, from lists, boards and the task view. On an archived
  task it restores it. ⌘Z undoes the archive while its toast shows. It sits next to E (edit the title).
- Shift+W sets the check-again day of the selected or open task: a day, then the reason. It sits next to W
  (waive, inside the criteria list only).

### 0.10.0

- No new keys. Every key acts in the workspace you are in, so G then H opens that workspace's Home.
- To change workspace from the keyboard, open the palette (⌘K) and pick "Switch to Globex". The palette has
  one such command for each of your other workspaces.
- In the palette, "New workspace" opens the New workspace dialog when you may create one, and "Go to
  workspace settings" opens General.
- In the New workspace dialog, ⌘Enter creates the workspace, as in New project.

### 0.9.0

- The task view has three new keys. Shift+A adds a criterion, Shift+X moves to the first open item, and N
  opens the comment box as a note.
- D shows the description when a final summary folds it, and edits it after that.
- The criteria and done-item lists and the finishing dialog have their own keys, listed above.

### 0.7.0

- P sets the priority of the selected or open task. It no longer opens New project. Use the "+" next to
  Projects in the sidebar, the workspace menu, or the palette.
- G then D (Dashboard) is gone. Home replaces the dashboard and My tasks, so use G then H.
- G then M opens the current project's milestones. It used to open My tasks.
- On the board, Shift+← and Shift+→ move a card between columns. Shift+H and Shift+L are gone, and Shift+J
  and Shift+K reorder only when Order by is Manual.
- The list has no detail pane. Enter opens the task view and Space the peek.
