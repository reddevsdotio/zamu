# Keyboard shortcuts proposed for M6 to M8

Additions to `.agent/design/m5/shortcuts.md`. The rules there still hold: single keys do nothing while a text field has focus, and Esc closes the topmost layer first.

## Task view and peek

| Key | Action |
|---|---|
| Shift+A | Add a criterion |
| Shift+X | Move focus to the first open criterion |
| N | Write a note |
| M | Write a comment (unchanged) |

## Inside the criteria or done-items list

| Key | Action |
|---|---|
| ↑ / ↓ | Previous or next line |
| X | Check or uncheck the focused line |
| W | Waive the focused line: opens the reason field. On a waived line, W removes the waiver |
| E | Reword the focused line |
| Alt+↑ / Alt+↓ | Move the line up or down |
| Backspace | Remove the line, with the Undo toast |
| Enter in the add field | Add the line and keep the field open for the next one |
| Esc | Leave the list |

## Finishing with open items

| Key | Action |
|---|---|
| ↑ / ↓ | Move between the open items |
| X | Check the focused item |
| W | Waive the focused item |
| ⌘Enter | Move the task anyway |
| Esc | Cancel: the status stays as it was |

## Conflicts and how they are resolved

1. **X** selects a row in lists and boards. In the task view nothing is selectable, so X is free there, and inside the criteria list it keeps its meaning of "tick this".
2. **E** edits the task title in the task view. While focus is inside the criteria list it rewords the focused line instead; Esc returns E to the title.
3. **Shift+A** sits next to A (assignee). Every other "add to this task" key is already Shift plus a letter (Shift+B blocker, Shift+S subtask), so it follows the pattern.
4. **J / K** stay with "next or previous task" in the task view. The lists use the arrow keys so the two never compete.
5. **N** was unused. It does nothing in lists and boards, where C creates a task.

## M7: pull requests, archive, check again

| Key | Where | Action |
|---|---|---|
| Shift+P | task view, peek | Link a pull request (opens the paste field) |
| Shift+E | lists, boards, task view | Archive the selected or open task; on an archived task, restore it |
| ⌘Z | after archiving | Undo, while the toast shows |
| Shift+W | task view, peek, lists | Set the check-again day |

6. **Shift+E** is next to E (edit the title). Archiving is rare and undoable, so it gets a Shift key and never a bare letter.
7. **Shift+W** is next to W (waive, inside the criteria list only). Outside that list W does nothing, so the two never meet.
8. **Shift+P** is next to P (priority), following the "Shift adds something to the task" pattern.

## M8: waves and gates

| Key | Where | Action |
|---|---|---|
| G | focus on a wave or its gate | Record the gate result |
| Alt+↓ / Alt+↑ | focus on a task in a wave | Move the task to the next or previous wave |
| ← / → | focus on a wave header | Collapse or expand the wave |
| Shift+N | milestone page | Add a wave |
| ⌘Enter | locked-wave warning | Start anyway |

9. **G** starts the "go to" chords everywhere else (G then H, G then M). On the milestone page it records a gate only while a wave or gate has focus; with nothing focused G still starts a chord.
10. **Alt+↑ / Alt+↓** already reorder a criterion inside the criteria list. Here they move a task between waves. Both mean "move this line", and the two lists are never on screen together.
