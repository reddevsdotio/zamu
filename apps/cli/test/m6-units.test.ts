// The M6 pieces that need no server: history sentences for the work-record changes, the pairing of
// --waive-ac and --reason, the source headers, the export's config check and the agents block edit.
import { type ActivityChange, WORK_RECORD_CHANGE_FIELDS } from '@zamu/contracts';
import { describe, expect, it } from 'vitest';
import {
  AGENTS_BLOCK_END,
  AGENTS_BLOCK_START,
  agentsBlock,
  applyBlock,
  BACKLOG_REPLACEMENT_LINE,
  backlogRelation,
} from '../src/commands/agents';
import { configPrefix, exportedPrefixes } from '../src/commands/backlog-export';
import { parseItemNumbers, resolveWaives, type WaiveToken } from '../src/commands/work';
import { changeSentence } from '../src/format';
import { headerValue, sourceHeaders, withSourceHeaders } from '../src/source';

describe('changeSentence for the work record', () => {
  const sentences: [ActivityChange, string][] = [
    [
      { field: 'criterion.added', number: 3, text: 'Retries back off' },
      'added criterion 3 "Retries back off"',
    ],
    [
      { field: 'criterion.edited', number: 2, text: 'New', from: 'Old' },
      'reworded criterion 2 "New" (was "Old")',
    ],
    [
      { field: 'criterion.moved', text: 'Load test', from: 5, to: 1 },
      'moved criterion "Load test" from 5 to 1',
    ],
    [{ field: 'criterion.removed', number: 4, text: 'Gone' }, 'removed criterion 4 "Gone"'],
    [{ field: 'criterion.checked', number: 2, text: 'Ledger' }, 'checked criterion 2 "Ledger"'],
    [{ field: 'criterion.unchecked', number: 2, text: 'Ledger' }, 'unchecked criterion 2 "Ledger"'],
    [
      { field: 'criterion.waived', number: 5, text: 'Load test', reason: 'Replaced by a replay' },
      'waived criterion 5 "Load test": Replaced by a replay',
    ],
    [
      { field: 'criterion.unwaived', number: 5, text: 'Load test' },
      'took back the waiver on criterion 5 "Load test"',
    ],
    [{ field: 'doneItem.added', number: 1, text: 'Tests pass' }, 'added done item 1 "Tests pass"'],
    [
      { field: 'doneItem.edited', number: 1, text: 'Tests and lint pass', from: 'Tests pass' },
      'reworded done item 1 "Tests and lint pass" (was "Tests pass")',
    ],
    [{ field: 'doneItem.moved', text: 'Docs', from: 2, to: 1 }, 'moved done item "Docs" from 2 to 1'],
    [{ field: 'doneItem.removed', number: 2, text: 'Docs' }, 'removed done item 2 "Docs"'],
    [{ field: 'doneItem.checked', number: 1, text: 'Tests pass' }, 'checked done item 1 "Tests pass"'],
    [{ field: 'doneItem.unchecked', number: 1, text: 'Tests pass' }, 'unchecked done item 1 "Tests pass"'],
    [
      { field: 'doneItem.waived', number: 1, text: 'Docs', reason: 'No user-facing change' },
      'waived done item 1 "Docs": No user-facing change',
    ],
    [{ field: 'doneItem.unwaived', number: 1, text: 'Docs' }, 'took back the waiver on done item 1 "Docs"'],
    [{ field: 'plan', from: null, to: '1. Table' }, 'wrote the plan'],
    [{ field: 'plan', from: '1. Table', to: '1. Table\n2. Job' }, 'edited the plan'],
    [{ field: 'plan', from: '1. Table', to: null }, 'cleared the plan'],
    [{ field: 'finalSummary', from: null, to: 'Done.' }, 'wrote the final summary'],
    [{ field: 'finalSummary', from: 'Done.', to: 'Done, checked.' }, 'edited the final summary'],
    [{ field: 'finalSummary', from: 'Done.', to: null }, 'cleared the final summary'],
  ];

  it.each(sentences)('%o reads "%s"', (change, sentence) => {
    expect(changeSentence(change)).toBe(sentence);
  });

  it('covers all 18 change kinds', () => {
    const covered = new Set(sentences.map(([change]) => change.field));
    expect([...WORK_RECORD_CHANGE_FIELDS].filter((field) => !covered.has(field))).toEqual([]);
  });
});

describe('--waive-ac, --waive-dod and --reason', () => {
  const waive = (number: number, kind: 'criterion' | 'done' = 'criterion'): WaiveToken => ({
    type: 'waive',
    kind,
    number,
  });
  const reason = (text: string): WaiveToken => ({ type: 'reason', text });

  it('pairs each reason with the waives before it, and trailing waives with the last reason', () => {
    expect(resolveWaives([waive(1), reason('a'), waive(2), waive(1, 'done'), reason('b')])).toEqual({
      criteria: [
        { number: 1, reason: 'a' },
        { number: 2, reason: 'b' },
      ],
      done: [{ number: 1, reason: 'b' }],
    });
    expect(resolveWaives([reason('a'), waive(3)])).toEqual({
      criteria: [{ number: 3, reason: 'a' }],
      done: [],
    });
    expect(resolveWaives([])).toEqual({ criteria: [], done: [] });
  });

  it('refuses a waive without any reason and a reason without a waive', () => {
    expect(() => resolveWaives([waive(2, 'done')])).toThrow('--waive-dod 2 needs a reason');
    expect(() => resolveWaives([reason('a')])).toThrow('--reason goes with --waive-ac N or --waive-dod N.');
  });

  it('reads item numbers, one or comma-separated, from 1', () => {
    expect(parseItemNumbers('3')).toEqual([3]);
    expect(parseItemNumbers('1, 2,5')).toEqual([1, 2, 5]);
    for (const bad of ['0', '-1', 'two', '1.5', ',']) expect(() => parseItemNumbers(bad)).toThrow();
  });
});

describe('source headers', () => {
  it('cleans values: control characters out, trimmed, at most 100 characters, non-ASCII encoded', () => {
    expect(headerValue('  laptop \n')).toBe('laptop');
    expect(headerValue('feat/\u0007payout')).toBe('feat/payout');
    expect(headerValue('')).toBeNull();
    expect(headerValue(null)).toBeNull();
    expect(headerValue('x'.repeat(150))).toHaveLength(100);
    expect(headerValue('feat/café')).toBe(encodeURIComponent('feat/café'));
  });

  it('adds the headers it has to every request', async () => {
    expect(sourceHeaders({ machine: 'laptop', branch: null })).toEqual({ 'x-zamu-machine': 'laptop' });
    const seen: Headers[] = [];
    const fetch = withSourceHeaders({ machine: 'laptop', branch: 'main' }, async (request) => {
      seen.push(request.headers);
      return new Response('{}');
    });
    await fetch(new Request('http://zamu.test/api/v1/me', { method: 'POST', body: '{}' }));
    expect(seen[0]?.get('x-zamu-machine')).toBe('laptop');
    expect(seen[0]?.get('x-zamu-branch')).toBe('main');
  });
});

describe('zamu backlog export config check', () => {
  it('reads task_prefix as Backlog.md does: the last one, TASK by default', () => {
    expect(configPrefix('task_prefix: "pay"\n')).toBe('PAY');
    expect(configPrefix("project_name: x\ntask_prefix: back # note\ntask_prefix: 'hbr'\n")).toBe('HBR');
    expect(configPrefix('project_name: x\n')).toBe('TASK');
  });

  it('finds the id prefixes of the exported task files', () => {
    expect(
      exportedPrefixes([
        'tasks/pay-142 - Retry.md',
        'tasks/pay-142.1 - Sub.md',
        'milestones/m-1 - v2.md',
        'completed/old-1 - x.md',
      ]),
    ).toEqual(['PAY']);
  });
});

describe('zamu agents block', () => {
  const guidelines = '<!-- BACKLOG.MD GUIDELINES START -->\nold\n<!-- BACKLOG.MD GUIDELINES END -->';

  it('is a few lines that point to zamu instructions, with the mirrored wording only when it mirrors', () => {
    const native = agentsBlock('PAY', 'native');
    expect(native.split('\n').length).toBeLessThanOrEqual(8);
    expect(native.startsWith(AGENTS_BLOCK_START)).toBe(true);
    expect(native.endsWith(AGENTS_BLOCK_END)).toBe(true);
    expect(native).toContain('`zamu instructions`');
    expect(agentsBlock('PAY', 'mirrors')).toContain('PAY mirrors Backlog.md');
    expect(agentsBlock('PAY', 'switched')).toContain('a copy written by `zamu backlog export`');
    expect(agentsBlock(null)).toContain('Pass --project KEY');
  });

  it('tells mirroring, switched and native projects apart', () => {
    const summary = { mode: 'mirror' as const, detachedAt: null };
    expect(backlogRelation(null)).toBe('unknown');
    expect(backlogRelation({ backlog: null })).toBe('native');
    expect(backlogRelation({ backlog: summary as never })).toBe('mirrors');
    expect(
      backlogRelation({ backlog: { ...summary, detachedAt: '2026-11-01T00:00:00.000Z' } as never }),
    ).toBe('switched');
    expect(backlogRelation({ backlog: { ...summary, mode: 'import' } as never })).toBe('switched');
  });

  it('replaces the guidelines only when asked', () => {
    const block = agentsBlock('PAY', 'native');
    expect(applyBlock(`${guidelines}\n`, block, false)).toEqual({
      next: `${guidelines}\n\n${block}\n`,
      replacedBacklogBlock: false,
    });
    expect(applyBlock(`# A\n\n${guidelines}\n`, block, true)).toEqual({
      next: `# A\n\n${BACKLOG_REPLACEMENT_LINE}\n\n${block}\n`,
      replacedBacklogBlock: true,
    });
    expect(applyBlock(null, block, true)).toEqual({ next: `${block}\n`, replacedBacklogBlock: false });
  });
});
