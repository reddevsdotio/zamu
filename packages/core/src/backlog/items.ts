// M6: how a refresh records changes to a mirrored task's criteria and done items. The file holds
// the whole list; this compares the stored list with the new one and names what happened in the
// operations of the work record (added, edited, moved, removed, checked, unchecked, waived,
// unwaived), so history reads like any other change: "Backlog.md checked criterion 2". Pure.
import type { WorkRecordItem } from '@zamu/backlog-md';
import { WORK_ITEM_CHANGE_PREFIXES, type WorkItemKind } from '@zamu/contracts';
import type { StoredWorkRecordChange } from '../activity';

/** True when both lists hold the same items in the same order, states and reasons included. */
export function sameItems(a: readonly WorkRecordItem[], b: readonly WorkRecordItem[]): boolean {
  return (
    a.length === b.length &&
    a.every(
      (item, index) =>
        item.text === b[index]?.text &&
        item.state === b[index]?.state &&
        (item.waivedReason ?? null) === (b[index]?.waivedReason ?? null),
    )
  );
}

/** Index pairs of a longest common subsequence of the texts, in order. */
function commonTexts(
  before: readonly WorkRecordItem[],
  after: readonly WorkRecordItem[],
): [number, number][] {
  const rows = before.length;
  const cols = after.length;
  const table: number[][] = Array.from({ length: rows + 1 }, () => new Array<number>(cols + 1).fill(0));
  for (let i = rows - 1; i >= 0; i--) {
    for (let j = cols - 1; j >= 0; j--) {
      const row = table[i] as number[];
      row[j] =
        before[i]?.text === after[j]?.text
          ? (table[i + 1]?.[j + 1] ?? 0) + 1
          : Math.max(table[i + 1]?.[j] ?? 0, row[j + 1] ?? 0);
    }
  }
  const pairs: [number, number][] = [];
  let i = 0;
  let j = 0;
  while (i < rows && j < cols) {
    if (before[i]?.text === after[j]?.text) {
      pairs.push([i, j]);
      i++;
      j++;
    } else if ((table[i + 1]?.[j] ?? 0) >= (table[i]?.[j + 1] ?? 0)) i++;
    else j++;
  }
  return pairs;
}

/**
 * The changes from `before` to `after` for one list. Items are matched by text (a longest common
 * run); an unmatched item whose text appears elsewhere moved; unmatched items between the same
 * neighbours were edited; the rest were removed or added. Numbers: removed and moved-from use the
 * old list, everything else the new one. Order: edits and state changes, removes, moves, adds.
 */
export function diffItems(
  before: readonly WorkRecordItem[],
  after: readonly WorkRecordItem[],
  kind: WorkItemKind,
): StoredWorkRecordChange[] {
  if (sameItems(before, after)) return [];
  const prefix = WORK_ITEM_CHANGE_PREFIXES[kind];
  const common = commonTexts(before, after);
  const pairs = new Map<number, number>(common.map(([i, j]) => [j, i]));
  const usedBefore = new Set(common.map(([i]) => i));
  const moved = new Map<number, number>();
  for (let j = 0; j < after.length; j++) {
    if (pairs.has(j)) continue;
    const i = before.findIndex((item, index) => !usedBefore.has(index) && item.text === after[j]?.text);
    if (i === -1) continue;
    usedBefore.add(i);
    moved.set(j, i);
  }
  // Gap of an index: how many common pairs come before it, on its side.
  const gapBefore = (i: number) => common.filter(([pi]) => pi < i).length;
  const gapAfter = (j: number) => common.filter(([, pj]) => pj < j).length;
  const edited = new Map<number, number>();
  const restBefore = before.map((_, i) => i).filter((i) => !usedBefore.has(i));
  for (let j = 0; j < after.length; j++) {
    if (pairs.has(j) || moved.has(j)) continue;
    const at = restBefore.findIndex((i) => gapBefore(i) === gapAfter(j));
    if (at === -1) continue;
    edited.set(j, restBefore[at] as number);
    restBefore.splice(at, 1);
  }

  const edits: StoredWorkRecordChange[] = [];
  const removes: StoredWorkRecordChange[] = [];
  const moves: StoredWorkRecordChange[] = [];
  const adds: StoredWorkRecordChange[] = [];
  const stateChange = (
    from: WorkRecordItem | null,
    to: WorkRecordItem,
    number: number,
  ): StoredWorkRecordChange | null => {
    const was = from?.state ?? 'open';
    const text = to.text;
    if (to.state === 'checked' && was !== 'checked') {
      return { field: `${prefix}.checked`, number, text } as StoredWorkRecordChange;
    }
    if (to.state === 'waived' && (was !== 'waived' || from?.waivedReason !== to.waivedReason)) {
      return {
        field: `${prefix}.waived`,
        number,
        text,
        reason: to.waivedReason ?? '',
      } as StoredWorkRecordChange;
    }
    if (to.state === 'open' && was === 'checked') {
      return { field: `${prefix}.unchecked`, number, text } as StoredWorkRecordChange;
    }
    if (to.state === 'open' && was === 'waived') {
      return { field: `${prefix}.unwaived`, number, text } as StoredWorkRecordChange;
    }
    return null;
  };
  const added: StoredWorkRecordChange[] = [];
  for (let j = 0; j < after.length; j++) {
    const item = after[j] as WorkRecordItem;
    const number = j + 1;
    const fromIndex = pairs.get(j) ?? moved.get(j) ?? edited.get(j);
    if (fromIndex === undefined) {
      adds.push({ field: `${prefix}.added`, number, text: item.text } as StoredWorkRecordChange);
      const state = stateChange(null, item, number);
      if (state) added.push(state);
      continue;
    }
    const previous = before[fromIndex] as WorkRecordItem;
    if (edited.has(j)) {
      edits.push({
        field: `${prefix}.edited`,
        number,
        text: item.text,
        from: previous.text,
      } as StoredWorkRecordChange);
    }
    const state = stateChange(previous, item, number);
    if (state) edits.push(state);
    if (moved.has(j)) {
      moves.push({
        field: `${prefix}.moved`,
        text: item.text,
        from: fromIndex + 1,
        to: number,
      } as StoredWorkRecordChange);
    }
  }
  for (const i of restBefore) {
    removes.push({
      field: `${prefix}.removed`,
      number: i + 1,
      text: (before[i] as WorkRecordItem).text,
    } as StoredWorkRecordChange);
  }
  return [...edits, ...removes, ...moves, ...adds, ...added];
}
