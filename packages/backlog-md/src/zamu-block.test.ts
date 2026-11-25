// The Zamu block: found outside code fences, taken out of the body, read leniently, and written so
// it reads back the same.
import { describe, expect, test } from 'vitest';
import { parseTask } from './task';
import type { ParseWarning } from './types';
import { extractZamuBlock, parseZamuBlock, renderZamuBlock } from './zamu-block';

const BLOCK = [
  '<!-- zamu:start -->',
  '```yaml',
  'waived:',
  '  - kind: criterion',
  '    number: 2',
  '    text: Load test passes',
  '    reason: "Replaced by a replay"',
  '  - kind: done',
  '    number: 1',
  '    reason: Docs live elsewhere',
  'later: { key: 1 }',
  '```',
  '<!-- zamu:end -->',
].join('\n');

describe('extractZamuBlock', () => {
  test('takes the block out of the body and reads it', () => {
    const { body, block } = extractZamuBlock(`## Description\n\nText\n\n${BLOCK}\n`);
    expect(body).toBe('## Description\n\nText\n\n');
    expect(block).toEqual({
      waived: [
        { kind: 'criterion', number: 2, text: 'Load test passes', reason: 'Replaced by a replay' },
        { kind: 'done', number: 1, text: null, reason: 'Docs live elsewhere' },
      ],
      other: { later: { key: 1 } },
    });
  });

  test('markers inside a code fence are content', () => {
    const body = `Text\n\n~~~md\n${BLOCK}\n~~~\n`;
    expect(extractZamuBlock(body)).toEqual({ body, block: null });
  });

  test('a start marker without an end is content', () => {
    const body = 'Text\n<!-- zamu:start -->\nwaived: []\n';
    expect(extractZamuBlock(body)).toEqual({ body, block: null });
  });

  test('broken YAML is left out with a warning', () => {
    const warnings: ParseWarning[] = [];
    const { body, block } = extractZamuBlock(
      'Text\n<!-- zamu:start -->\nwaived: [\n<!-- zamu:end -->',
      warnings,
    );
    expect(body).toBe('Text');
    expect(block).toEqual({ waived: [], other: {} });
    expect(warnings).toMatchObject([{ code: 'invalid_zamu_block', field: 'zamu' }]);
  });

  test('entries that are not waivers are dropped', () => {
    const parsed = parseZamuBlock(
      'waived:\n  - kind: other\n    number: 1\n    reason: x\n  - kind: done\n    number: 0\n    reason: x\n  - kind: done\n    number: 1\n    reason: "  "\n',
    );
    expect(parsed).toEqual({ ok: true, block: { waived: [], other: {} } });
  });
});

test('renderZamuBlock reads back the same', () => {
  const block = {
    waived: [
      {
        kind: 'criterion' as const,
        number: 3,
        text: 'Retries: back off #2',
        reason: "It's covered: see PAY-9",
      },
    ],
    other: {},
  };
  const rendered = renderZamuBlock(block);
  expect(rendered.split('\n')[0]).toBe('<!-- zamu:start -->');
  expect(rendered.split('\n').at(-1)).toBe('<!-- zamu:end -->');
  expect(extractZamuBlock(rendered).block).toEqual(block);
});

test('parseTask keeps the block out of the sections and warns about none', () => {
  const text = `---\nid: PAY-1\ntitle: One\n---\n\n## Final Summary\n\n<!-- SECTION:FINAL_SUMMARY:BEGIN -->\nShipped.\n<!-- SECTION:FINAL_SUMMARY:END -->\n\n${BLOCK}\n`;
  const task = parseTask('backlog/tasks/pay-1 - One.md', text);
  if (!task.ok) throw new Error(task.error.message);
  expect(task.value.sections.finalSummary).toBe('Shipped.');
  expect(task.value.sections.extra).toBeNull();
  expect(task.value.zamu?.waived).toHaveLength(2);
  expect(task.warnings.filter((warning) => warning.code !== 'missing_status')).toEqual([]);
});
