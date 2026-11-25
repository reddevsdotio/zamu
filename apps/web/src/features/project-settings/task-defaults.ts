// Task defaults (M6 frames 025 to 027): the done items every new task in a project starts with. Pure list
// edits and the words around them, so each can be tested without rendering. The page saves the whole
// list after every edit; tasks that exist keep the items they have.
import { ORPCError } from '@orpc/client';
import { MAX_WORK_ITEM_LENGTH, MAX_WORK_ITEMS } from '@zamu/contracts';

/** The list with the item at `index` moved one place up (-1) or down (1); unchanged at either end. */
export function moveItem(items: readonly string[], index: number, direction: -1 | 1): string[] {
  const to = index + direction;
  if (index < 0 || index >= items.length || to < 0 || to >= items.length) return [...items];
  return moveItemTo(items, index, to);
}

/** The list with the item at `from` put at `to` (drag and drop). */
export function moveItemTo(items: readonly string[], from: number, to: number): string[] {
  const next = [...items];
  const [item] = next.splice(from, 1);
  if (item === undefined) return [...items];
  next.splice(Math.max(0, Math.min(to, next.length)), 0, item);
  return next;
}

/** One line, trimmed, with inner runs of white space kept as typed. */
export function cleanItem(text: string): string {
  return text.replace(/[\r\n]+/g, ' ').trim();
}

/**
 * Why `text` can't go into the list at `index` (null to add), or null when it can. Empty text is not an
 * error: the field just closes.
 */
export function itemError(items: readonly string[], text: string, index: number | null): string | null {
  const clean = cleanItem(text);
  if (!clean) return null;
  if (clean.length > MAX_WORK_ITEM_LENGTH) {
    return `Keep it under ${MAX_WORK_ITEM_LENGTH} characters.`;
  }
  const taken = items.findIndex((item, at) => at !== index && item.toLowerCase() === clean.toLowerCase());
  if (taken !== -1) return 'That item is already in the list.';
  if (index === null && items.length >= MAX_WORK_ITEMS) {
    return `A project can have ${MAX_WORK_ITEMS} default items at most.`;
  }
  return null;
}

/** "Applies to tasks created from now on. 40 open tasks keep the items they have." */
export function appliesText(openCount: number | undefined): string {
  const lead = 'Applies to tasks created from now on.';
  if (!openCount) return `${lead} Tasks that already exist keep the items they have.`;
  if (openCount === 1) return `${lead} 1 open task keeps the items it has.`;
  return `${lead} ${openCount} open tasks keep the items they have.`;
}

/** Screen reader line after a move: "Moved “Docs updated” to position 1 of 3." */
export function movedText(text: string, position: number, total: number): string {
  return `Moved “${text}” to position ${position} of ${total}.`;
}

/** Turns a failed save into the banner text. */
export function defaultsFailure(error: unknown): string {
  if (error instanceof ORPCError) {
    if (error.code === 'FORBIDDEN') return 'Only owners and admins can change the task defaults.';
    if (error.code === 'UNAUTHORIZED') return 'Your session ended. Sign in again to save.';
    if (error.code === 'NOT_FOUND') return 'This project no longer exists.';
    const issues = (error.data as { issues?: { message: string }[] } | undefined)?.issues;
    if (issues?.[0]?.message) return `${issues[0].message.replace(/\.?$/, '.')}`;
    if (error.message) return error.message;
  }
  return 'Check your connection and try again.';
}
