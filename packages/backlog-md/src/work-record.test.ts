// The work record a mirror fills: the split of a rendered description must match the M6 migration's
// backfill (packages/core checks the two against Postgres on every fixture file), and waivers from
// the Zamu block land on the right items.
import { describe, expect, test } from 'vitest';
import { parseConfig } from './config';
import { parseTask } from './task';
import { readFixture } from './testing/fixtures';
import { applyWaivers, splitRenderedDescription, taskWorkRecord, type WorkRecordItem } from './work-record';

const open = (text: string): WorkRecordItem => ({ text, state: 'open', waivedReason: null });
const checked = (text: string): WorkRecordItem => ({ text, state: 'checked', waivedReason: null });

describe('splitRenderedDescription', () => {
  // The same description the migration test backfills, with the same expected result.
  const RENDERED = [
    'Payouts settle nightly through the ledger.',
    '',
    '```sh',
    '## Final summary',
    '- [ ] not an item',
    '```',
    '',
    '## Acceptance criteria',
    '',
    '- [x] #1 Refunds post a ledger entry',
    '- [ ] #2 Webhook retries back off',
    'Items checked by the reviewer only.',
    '~~~',
    '- [ ] #9 sample inside a fence',
    '~~~',
    '- [ ] #4   Payout report lists fees  ',
    '- [ ]   ',
    '',
    '## Definition of done',
    '',
    '- [ ] #1 Tests pass',
    '- [X] #2 Docs updated',
    '',
    '## Implementation plan',
    '',
    '1. Add the ledger table',
    '2. Wire the webhook',
    '',
    '## Implementation notes',
    '',
    'Started with the ledger.',
    '',
    '## Comments from Backlog.md',
    '',
    '**@ana** · 2026-10-20 10:00',
    '',
    'Looks right.',
    '',
    '## Final summary',
    '',
    'Refunds write a ledger entry; retries back off.',
  ].join('\n');

  test('moves items, plan, notes and summary out; keeps prose, fences and comments', () => {
    expect(splitRenderedDescription(RENDERED)).toEqual({
      description: [
        'Payouts settle nightly through the ledger.',
        '',
        '```sh',
        '## Final summary',
        '- [ ] not an item',
        '```',
        '',
        '## Acceptance criteria',
        '',
        'Items checked by the reviewer only.',
        '~~~',
        '- [ ] #9 sample inside a fence',
        '~~~',
        '',
        '## Comments from Backlog.md',
        '',
        '**@ana** · 2026-10-20 10:00',
        '',
        'Looks right.',
      ].join('\n'),
      criteria: [
        checked('Refunds post a ledger entry'),
        open('Webhook retries back off'),
        open('Payout report lists fees'),
      ],
      doneItems: [open('Tests pass'), checked('Docs updated')],
      plan: '1. Add the ledger table\n2. Wire the webhook',
      finalSummary: 'Refunds write a ledger entry; retries back off.',
      implementationNotes: 'Started with the ledger.',
    });
  });

  test('a description that is only a checklist empties', () => {
    expect(splitRenderedDescription('## Acceptance criteria\n\n- [ ] #1 Hidden item')).toMatchObject({
      description: null,
      criteria: [open('Hidden item')],
    });
  });

  test('items without numbers, and a summary', () => {
    expect(
      splitRenderedDescription(
        'Intro\n\n## Acceptance criteria\n\n- [x] Old item\n\n## Final summary\n\nShipped.',
      ),
    ).toMatchObject({ description: 'Intro', criteria: [checked('Old item')], finalSummary: 'Shipped.' });
  });

  test('descriptions without the five headings stay as they are', () => {
    const empty = { criteria: [], doneItems: [], plan: null, finalSummary: null, implementationNotes: null };
    expect(splitRenderedDescription('Plain text, no sections.')).toEqual({
      description: 'Plain text, no sections.',
      ...empty,
    });
    expect(splitRenderedDescription('  Kept as is\n\n## Comments from Backlog.md\n\nHi  ')).toEqual({
      description: '  Kept as is\n\n## Comments from Backlog.md\n\nHi  ',
      ...empty,
    });
    expect(splitRenderedDescription(null)).toEqual({ description: null, ...empty });
    expect(splitRenderedDescription('')).toEqual({ description: null, ...empty });
  });

  test('a heading inside a fence still lets the split run, and stays content', () => {
    const text = 'Intro\n\n```\n## Final summary\n```';
    expect(splitRenderedDescription(text)).toMatchObject({ description: text, finalSummary: null });
  });
});

describe('applyWaivers', () => {
  const items = [open('One'), checked('Two'), open('Three'), open('Three')];

  test('waives the open item at the number when the text matches', () => {
    const result = applyWaivers(items, 'criterion', {
      waived: [{ kind: 'criterion', number: 3, text: 'Three', reason: 'Replay covers it' }],
      other: {},
    });
    expect(result[2]).toEqual({ text: 'Three', state: 'waived', waivedReason: 'Replay covers it' });
    expect(result[3]?.state).toBe('open');
    expect(items[2]?.state).toBe('open');
  });

  test('follows the text when the items moved, and leaves checked items alone', () => {
    const block = {
      waived: [
        { kind: 'criterion' as const, number: 1, text: 'Three', reason: 'Moved' },
        { kind: 'criterion' as const, number: 2, text: 'Two', reason: 'Checked since' },
        { kind: 'done' as const, number: 1, text: 'One', reason: 'Other list' },
      ],
      other: {},
    };
    const result = applyWaivers(items, 'criterion', block);
    expect(result.map((item) => item.state)).toEqual(['open', 'checked', 'waived', 'open']);
  });

  test('a waiver without text takes the number', () => {
    const result = applyWaivers(items, 'done', {
      waived: [{ kind: 'done', number: 1, text: null, reason: 'No text' }],
      other: {},
    });
    expect(result[0]).toMatchObject({ state: 'waived', waivedReason: 'No text' });
  });
});

describe('taskWorkRecord', () => {
  test('a marker-style fixture task', () => {
    const config = parseConfig(readFixture('eras/2025-09-markers/backlog/config.yml'));
    if (!config.ok) throw new Error('config');
    const path = 'eras/2025-09-markers/backlog/tasks/pay-12 - Webhook-retries.md';
    const task = parseTask(path, readFixture(path), config.value);
    if (!task.ok) throw new Error(task.error.message);
    const record = taskWorkRecord(task.value);
    expect(record.criteria).toEqual([
      checked('Failed deliveries are retried'),
      open('Retries back off exponentially'),
    ]);
    expect(record.description).not.toContain('## Implementation plan');
    expect(record.description).toContain('Retry failed webhook deliveries with backoff.');
  });

  test('applies the Zamu block of the file', () => {
    const text = [
      '---',
      'id: PAY-5',
      'title: Waived one',
      '---',
      '',
      '## Acceptance Criteria',
      '<!-- AC:BEGIN -->',
      '- [x] #1 Done one',
      '- [ ] #2 Load test passes',
      '<!-- AC:END -->',
      '',
      '<!-- zamu:start -->',
      '```yaml',
      'waived:',
      '  - kind: criterion',
      '    number: 2',
      '    text: Load test passes',
      '    reason: Replaced by a replay',
      '```',
      '<!-- zamu:end -->',
      '',
    ].join('\n');
    const task = parseTask('backlog/tasks/pay-5 - Waived-one.md', text);
    if (!task.ok) throw new Error(task.error.message);
    expect(taskWorkRecord(task.value)).toEqual({
      description: null,
      criteria: [
        checked('Done one'),
        { text: 'Load test passes', state: 'waived', waivedReason: 'Replaced by a replay' },
      ],
      doneItems: [],
      plan: null,
      finalSummary: null,
      implementationNotes: null,
    });
  });
});
