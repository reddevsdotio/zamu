# Keyboard shortcuts

Most of the app works from the keyboard. Press ? on any page for this list, or open it from your menu at the
bottom of the sidebar. On Windows and Linux, ⌘ is Ctrl.

Single keys do nothing while you type in a field, the comment box or a picker's search. Esc leaves the field
first. Esc closes the topmost layer first: a picker or menu, then the palette, a dialog, the peek, and the
selection. After that it goes back. In a picker with text in its search, the first Esc clears the text.

Keys follow the character you type, so they work on any keyboard layout. `[` is the exception: it is the key
to the right of P, whatever it prints.

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

| Key               | Action                                                        |
| ----------------- | ------------------------------------------------------------- |
| J / K or ↓ / ↑    | Next or previous row or card                                  |
| ← / →             | On the board: previous or next column                         |
| ← / →             | On a group row of the list: fold or unfold the group          |
| X                 | Select or unselect                                            |
| Shift+↓ / Shift+↑ | Extend the selection                                          |
| Shift+click       | Select a range                                                |
| ⌘A                | Select everything in the view                                 |
| Space             | Peek. Space or Esc closes it; J / K move it to the next task  |
| Enter             | Open the task view                                            |
| Esc               | Clear the selection                                           |
| V                 | Switch between list and board                                 |
| Shift+← / Shift+→ | On the board: move the card to the previous or next column    |
| Shift+J / Shift+K | On the board: move the card down or up (Order by Manual only) |
| ⌘Z                | Undo the last change, from its toast                          |
| Shift+R           | Refresh now, in a project that mirrors Backlog.md             |

## A selected or open task

With several tasks selected, these keys act on all of them, in native projects only.

| Key     | Action                        |
| ------- | ----------------------------- |
| S       | Status                        |
| P       | Priority                      |
| A       | Assignee                      |
| I       | Assign to me                  |
| L       | Labels                        |
| Shift+D | Due date                      |
| Shift+M | Milestone                     |
| Shift+C | Cycle                         |
| Shift+B | Add a blocker                 |
| Shift+S | Add a subtask (one task only) |
| M       | Comment                       |
| ⌘C      | Copy the task key (or keys)   |
| ⌘⇧C     | Copy the link                 |

⌘C copies the key only when no text is highlighted. With text highlighted, it copies the text as usual.

## Task view

| Key     | Action                                                                |
| ------- | --------------------------------------------------------------------- |
| J / K   | Next or previous task of the list you came from ("12 of 40 in List")  |
| Esc     | Back to the list or board, with the task still under the cursor       |
| E       | Edit the title                                                        |
| D       | Edit the description, or show it when a final summary folds it        |
| Shift+A | Add a criterion                                                       |
| Shift+X | Move to the first open criterion (or done item)                       |
| N       | Write a note: the comment box in note mode (M opens it for a comment) |

## Criteria and done items

These keys work on the focused line of the Acceptance criteria or Definition of done list in the task view.
Mirrored tasks show the lists read-only.

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

The dialog that opens when you move a task to In review or Done while criteria or done items are open.

| Key    | Action                             |
| ------ | ---------------------------------- |
| ↑ / ↓  | Move between the open items        |
| X      | Check the focused item             |
| W      | Waive the focused item             |
| ⌘Enter | Move the task anyway               |
| Esc    | Cancel: the status stays as it was |

## Pickers and menus

| Key                            | Action                                                            |
| ------------------------------ | ----------------------------------------------------------------- |
| Type                           | Filter the list                                                   |
| ↑ / ↓                          | Move                                                              |
| Enter                          | Pick. In pickers with several choices, such as labels, it toggles |
| 1 to 6 in the status picker    | Backlog, Todo, In progress, In review, Done, Canceled             |
| 0 to 4 in the priority picker  | None, Urgent, High, Medium, Low                                   |
| ⌘Enter in the subtask picker   | Create a subtask from the typed text                              |
| ← / → in the due-date calendar | Previous or next day (↑ / ↓ move a week)                          |
| Tab in the label picker        | Move to the colour swatches when creating a label                 |
| Backspace in an empty palette  | Back out of a palette step, such as Set status                    |

## Dialogs and the comment box

| Key    | Action                                          |
| ------ | ----------------------------------------------- |
| ⌘Enter | Submit: create the task, post the comment, save |
| Esc    | Cancel                                          |
| @      | Mention someone in a comment                    |

In quick create (C), I assigns the task to you, Shift+M opens the milestone and Shift+C the cycle.

## Changed in 0.9.0

- New in the task view: Shift+A adds a criterion, Shift+X moves to the first open item, and N opens the
  comment box as a note.
- D shows the description when a final summary folds it, and edits it after that.
- The criteria and done-item lists and the finishing dialog have their own keys, listed above.

## Changed in 0.7.0

- P sets the priority of the selected or open task. It no longer opens New project: use the "+" next to
  Projects in the sidebar, the workspace menu, or the palette.
- G then D (Dashboard) is gone: Home replaces the dashboard and My tasks. Use G then H.
- G then M opens the current project's milestones. It used to open My tasks.
- On the board, Shift+← and Shift+→ move a card between columns. Shift+H and Shift+L are gone, and
  Shift+J and Shift+K reorder only when Order by is Manual.
- The list has no detail pane: Enter opens the task view and Space the peek.
