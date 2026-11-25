import type { ActivityChange, Task, WorkItem } from '@zamu/contracts';
import { describe, expect, it } from 'vitest';
import { describeActivity } from '~/features/tasks/format';
import { describeBacklogFields } from '~/features/tasks/mirror';
import { toListItem } from '~/features/tasks/queries';
import {
  applyItemOps,
  isFromDefaults,
  needsFinishing,
  openItemsOf,
  planLabel,
  progressNote,
  progressOf,
  toWorkInput,
} from './ops';

// The work record's pure rules: item operations in the server's order, counts, the finishing check,
// the plan's size, and the history sentences of the 18 work-record change kinds.

const ANA = { id: '00000000-0000-4000-8000-000000000001', name: 'Ana Ruiz', kind: 'person' as const };

function items(...specs: [string, WorkItem['state']?][]): WorkItem[] {
  return specs.map(([text, state = 'open'], index) => ({
    number: index + 1,
    text,
    state,
    waivedReason: state === 'waived' ? 'not needed' : null,
    waivedBy: state === 'waived' ? ANA : null,
    locked: false,
  }));
}

const texts = (list: WorkItem[]) => list.map((item) => `${item.number}:${item.text}:${item.state}`);

describe('applyItemOps', () => {
  const list = items(['A'], ['B', 'checked'], ['C', 'waived'], ['D']);

  it('checks, unchecks, waives and unwaives by number, clearing waivers on a check', () => {
    expect(texts(applyItemOps(list, { check: [1, 3], uncheck: [2] }, ANA))).toEqual([
      '1:A:checked',
      '2:B:open',
      '3:C:checked',
      '4:D:open',
    ]);
    const waived = applyItemOps(list, { waive: [{ number: 4, reason: 'later' }], unwaive: [3] }, ANA);
    expect(waived[3]).toMatchObject({ state: 'waived', waivedReason: 'later', waivedBy: ANA });
    expect(waived[2]).toMatchObject({ state: 'open', waivedReason: null, waivedBy: null });
  });

  it('removes by the numbers before the request, then moves, then adds at the end, renumbered', () => {
    const after = applyItemOps(
      list,
      { remove: [1, 3], move: [{ from: 2, to: 1 }], add: ['E'], edit: [{ number: 2, text: 'B2' }] },
      ANA,
    );
    expect(texts(after)).toEqual(['1:D:open', '2:B2:checked', '3:E:open']);
  });

  it('counts settled, waived and open items', () => {
    expect(progressOf(list)).toEqual({ settled: 2, open: 2, waived: 1, total: 4 });
    expect(progressNote(progressOf(list))).toBe('1 waived · 2 open');
    expect(progressNote(progressOf(items(['A'], ['B'])))).toBe('');
  });
});

describe('requests and rows', () => {
  it('sends one PATCH with the operations named after the list', () => {
    expect(
      toWorkInput('PAY-142', {
        criteria: { check: [1], waive: [{ number: 5, reason: 'replay' }] },
        doneItems: { add: ['Docs'] },
        plan: null,
      }),
    ).toEqual({
      key: 'PAY-142',
      checkCriteria: [1],
      waiveCriteria: [{ number: 5, reason: 'replay' }],
      addDoneItems: ['Docs'],
      plan: null,
    });
  });

  it('turns a full task into a row with counts instead of lists', () => {
    const task = {
      key: 'PAY-1',
      createdBy: ANA,
      criteria: items(['A', 'checked'], ['B']),
      doneItems: items(['T', 'waived']),
      plan: 'x',
      finalSummary: 'Done.',
    } as unknown as Task;
    const row = toListItem(task) as Record<string, unknown>;
    expect(row).not.toHaveProperty('criteria');
    expect(row).not.toHaveProperty('plan');
    expect(row).toMatchObject({
      criteriaProgress: { settled: 1, open: 1, waived: 0, total: 2 },
      doneProgress: { settled: 1, open: 0, waived: 1, total: 1 },
      hasFinalSummary: true,
    });
  });
});

describe('finishing', () => {
  const task = (status: Task['status'], locked: string[] = []) =>
    ({
      status,
      locked,
      criteria: items(['A', 'checked'], ['B']),
      doneItems: items(['T']),
    }) as unknown as Task;

  it('lists open criteria first, then done items', () => {
    expect(openItemsOf(task('in_progress')).map((open) => `${open.kind}:${open.item.text}`)).toEqual([
      'criterion:B',
      'done:T',
    ]);
  });

  it('warns on In review and Done with open items only, never on mirrored tasks', () => {
    expect(needsFinishing(task('in_progress'), 'in_review')).toBe(true);
    expect(needsFinishing(task('in_progress'), 'done')).toBe(true);
    expect(needsFinishing(task('in_progress'), 'todo')).toBe(false);
    expect(needsFinishing(task('in_review'), 'in_review')).toBe(false);
    expect(needsFinishing(task('in_progress', ['status']), 'done')).toBe(false);
  });
});

describe('words', () => {
  it('says steps for short plans and lines for long ones', () => {
    expect(planLabel('1. One\n2. Two\n\n```\n1. not a step\n```')).toBe('2 steps');
    expect(planLabel('Just prose.')).toBe('1 line');
    expect(planLabel(Array.from({ length: 60 }, (_, index) => `${index + 1}. Step`).join('\n'))).toBe(
      '60 lines',
    );
  });

  it('knows done items that came from the project defaults', () => {
    expect(isFromDefaults(items(['Tests pass'], ['Changelog']), ['Tests pass', 'Changelog'])).toBe(true);
    expect(isFromDefaults(items(['Tests pass'], ['Other']), ['Tests pass', 'Changelog'])).toBe(false);
    expect(isFromDefaults([], ['Tests pass'])).toBe(false);
  });
});

describe('history sentences', () => {
  const say = (...changes: ActivityChange[]) => describeActivity({ type: 'task.updated', changes });
  const at = (field: string, number: number, text: string, extra: object = {}) =>
    ({ field, number, text, ...extra }) as ActivityChange;

  it('names criteria by number', () => {
    expect(say(at('criterion.checked', 2, 'B'))).toBe('checked criterion 2');
    expect(say(at('criterion.checked', 3, 'C'), at('criterion.checked', 4, 'D'))).toBe(
      'checked criteria 3 and 4',
    );
    expect(say(at('criterion.unchecked', 1, 'A'))).toBe('unchecked criterion 1');
    expect(say(at('criterion.waived', 5, 'E', { reason: 'load test replaced by a replay' }))).toBe(
      'waived criterion 5: load test replaced by a replay',
    );
    expect(say(at('criterion.unwaived', 5, 'E'))).toBe('removed the waiver on criterion 5');
    expect(
      say(...Array.from({ length: 6 }, (_, index) => at('criterion.added', index + 1, `C${index}`))),
    ).toBe('added 6 acceptance criteria');
    expect(say(at('criterion.added', 7, 'G'))).toBe('added criterion 7');
    expect(say(at('criterion.edited', 2, 'B2', { from: 'B' }))).toBe('reworded criterion 2');
    expect(say({ field: 'criterion.moved', text: 'C', from: 3, to: 1 } as ActivityChange)).toBe(
      'moved criterion 3 to 1',
    );
    expect(say(at('criterion.removed', 5, 'The schedule holds'))).toBe(
      'removed criterion 5: The schedule holds',
    );
  });

  it('names done items by their text', () => {
    expect(say(at('doneItem.checked', 1, 'Tests and lint pass'))).toBe('checked “Tests and lint pass”');
    expect(say(at('doneItem.unchecked', 1, 'Tests'))).toBe('unchecked “Tests”');
    expect(say(at('doneItem.waived', 2, 'Changelog', { reason: 'internal change' }))).toBe(
      'waived “Changelog”: internal change',
    );
    expect(say(at('doneItem.unwaived', 2, 'Changelog'))).toBe('removed the waiver on “Changelog”');
    expect(say(at('doneItem.added', 3, 'Docs'))).toBe('added the done item “Docs”');
    expect(say(at('doneItem.added', 3, 'Docs'), at('doneItem.added', 4, 'Demo'))).toBe('added 2 done items');
    expect(say(at('doneItem.edited', 1, 'Tests pass', { from: 'Tests' }))).toBe(
      'reworded the done item “Tests pass”',
    );
    expect(say({ field: 'doneItem.moved', text: 'Docs', from: 3, to: 1 } as ActivityChange)).toBe(
      'moved “Docs” up',
    );
    expect(say(at('doneItem.removed', 2, 'Changelog'))).toBe('removed the done item “Changelog”');
  });

  it('says who wrote the plan and the summary', () => {
    expect(say({ field: 'plan', from: null, to: '1. A' })).toBe('wrote the plan');
    expect(say({ field: 'plan', from: '1. A', to: '1. B' })).toBe('edited the plan');
    expect(say({ field: 'plan', from: '1. A', to: null })).toBe('removed the plan');
    expect(say({ field: 'finalSummary', from: null, to: 'Done.' })).toBe('wrote the final summary');
    expect(
      say({ field: 'status', from: 'in_progress', to: 'in_review' }, at('criterion.checked', 6, 'F')),
    ).toBe('moved this to In review and checked criterion 6');
  });

  it('names the notes in Backlog.md changes', () => {
    expect(describeBacklogFields(['implementationNotes'])).toBe('changed the notes');
  });
});
