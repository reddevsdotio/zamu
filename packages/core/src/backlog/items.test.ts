// How a refresh names changes to a list of criteria or done items.
import type { WorkRecordItem } from '@zamu/backlog-md';
import { describe, expect, it } from 'vitest';
import { diffItems, sameItems } from './items';

const open = (text: string): WorkRecordItem => ({ text, state: 'open', waivedReason: null });
const checked = (text: string): WorkRecordItem => ({ text, state: 'checked', waivedReason: null });
const waived = (text: string, reason: string): WorkRecordItem => ({
  text,
  state: 'waived',
  waivedReason: reason,
});

describe('diffItems', () => {
  it('names nothing for the same list', () => {
    expect(diffItems([open('A'), checked('B')], [open('A'), checked('B')], 'criterion')).toEqual([]);
    expect(sameItems([waived('A', 'x')], [waived('A', 'y')])).toBe(false);
  });

  it('checks, unchecks, waives and unwaives by the number the item has now', () => {
    expect(
      diffItems(
        [open('A'), checked('B'), open('C'), waived('D', 'old')],
        [checked('A'), open('B'), waived('C', 'Replay covers it'), open('D')],
        'criterion',
      ),
    ).toEqual([
      { field: 'criterion.checked', number: 1, text: 'A' },
      { field: 'criterion.unchecked', number: 2, text: 'B' },
      { field: 'criterion.waived', number: 3, text: 'C', reason: 'Replay covers it' },
      { field: 'criterion.unwaived', number: 4, text: 'D' },
    ]);
  });

  it('a removal renumbers without moves; an addition goes in at its number', () => {
    expect(
      diffItems([open('A'), open('B'), open('C')], [open('A'), open('C'), checked('D')], 'done'),
    ).toEqual([
      { field: 'doneItem.removed', number: 2, text: 'B' },
      { field: 'doneItem.added', number: 3, text: 'D' },
      { field: 'doneItem.checked', number: 3, text: 'D' },
    ]);
  });

  it('a reworded item between the same neighbours is an edit', () => {
    expect(
      diffItems([open('A'), open('B'), open('C')], [open('A'), checked('B2'), open('C')], 'criterion'),
    ).toEqual([
      { field: 'criterion.edited', number: 2, text: 'B2', from: 'B' },
      { field: 'criterion.checked', number: 2, text: 'B2' },
    ]);
  });

  it('an item that changed places moved', () => {
    expect(
      diffItems([open('A'), open('B'), open('C')], [open('B'), open('C'), open('A')], 'criterion'),
    ).toEqual([{ field: 'criterion.moved', text: 'A', from: 1, to: 3 }]);
  });

  it('a list that empties removes every item', () => {
    expect(diffItems([open('A'), open('B')], [], 'criterion')).toEqual([
      { field: 'criterion.removed', number: 1, text: 'A' },
      { field: 'criterion.removed', number: 2, text: 'B' },
    ]);
  });
});
