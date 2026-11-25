import { describe, expect, it } from 'vitest';
import { checkedOf, NO_PROGRESS, progressOfItems, progressText, workItemNoun } from './work-progress';

describe('work-record counts', () => {
  it('counts a full task list as the server counts a list item', () => {
    expect(progressOfItems([{ state: 'checked' }, { state: 'waived' }, { state: 'open' }])).toEqual({
      settled: 2,
      open: 1,
      waived: 1,
      total: 3,
    });
    expect(progressOfItems(undefined)).toEqual(NO_PROGRESS);
  });

  it('words checked of total with the noun for the size of the list', () => {
    const progress = { settled: 5, open: 1, waived: 1, total: 6 };
    expect(checkedOf(progress)).toBe(4);
    expect(progressText('criteria', progress)).toBe('4 of 6 criteria');
    expect(progressText('done', { settled: 2, open: 0, waived: 0, total: 2 })).toBe('2 of 2 done items');
    expect(progressText('done', { settled: 1, open: 0, waived: 0, total: 1 })).toBe('1 of 1 done item');
    expect(progressText('criteria', NO_PROGRESS)).toBe('');
    expect(progressText('criteria', undefined)).toBe('');
    expect(workItemNoun('criteria', 1)).toBe('criterion');
  });
});
