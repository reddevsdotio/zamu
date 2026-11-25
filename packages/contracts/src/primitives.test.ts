import { describe, expect, it } from 'vitest';
import {
  ActivityOrigin,
  BACKLOG_MODE_LABELS,
  BACKLOG_MODES,
  BACKLOG_STATE_LABELS,
  BACKLOG_STATES,
  BACKLOG_TRIGGER_LABELS,
  BACKLOG_TRIGGERS,
  BacklogId,
  CalendarDate,
  CYCLE_STATE_LABELS,
  CYCLE_STATES,
  CycleNumber,
  CycleSelector,
  cycleLengthDays,
  formatBacklogId,
  formatTaskKey,
  GIT_CONNECTION_STATUS_LABELS,
  GIT_CONNECTION_STATUSES,
  GIT_PROVIDER_BADGES,
  GIT_PROVIDER_LABELS,
  GIT_PROVIDERS,
  isOpenStatus,
  KeySuffix,
  MILESTONE_OWNED_FIELDS,
  MILESTONE_STATUS_LABELS,
  MILESTONE_STATUSES,
  OPEN_TASK_STATUSES,
  PRIORITIES,
  PRIORITY_LABELS,
  PROJECT_OWNED_FIELDS,
  Priority,
  ProjectKey,
  ProjectKeyInput,
  parseBacklogId,
  parseTaskKey,
  priorityFromValue,
  priorityToValue,
  safeParseTaskKey,
  splitTaskKey,
  suggestProjectKey,
  TASK_OWNED_FIELDS,
  TASK_STATUS_LABELS,
  TASK_STATUSES,
  TaskKey,
  TaskKeyInput,
  TaskRefInput,
  TaskStatus,
  THEME_LABELS,
  THEMES,
  Theme,
  Timestamp,
} from './primitives';

describe('ProjectKey', () => {
  it.each(['AB', 'PAY', 'WEB', 'A1', 'ABCDEF', 'X2Y3Z4'])('accepts %s', (key) => {
    expect(ProjectKey.parse(key)).toBe(key);
  });

  it.each([
    ['too short', 'A'],
    ['too long', 'ABCDEFG'],
    ['starts with a digit', '1AB'],
    ['lowercase', 'pay'],
    ['dash', 'PA-Y'],
    ['underscore', 'PA_Y'],
    ['space', 'PA Y'],
    ['empty', ''],
    ['non-ASCII letter', 'PÄY'],
  ])('rejects %s', (_label, key) => {
    expect(ProjectKey.safeParse(key).success).toBe(false);
  });

  it('input form trims and upper-cases before validating', () => {
    expect(ProjectKeyInput.parse(' pay ')).toBe('PAY');
    expect(ProjectKeyInput.parse('web2')).toBe('WEB2');
    expect(ProjectKeyInput.safeParse('1ab').success).toBe(false);
    expect(ProjectKeyInput.safeParse('abcdefg').success).toBe(false);
  });

  it('reports a readable message', () => {
    const result = ProjectKey.safeParse('1AB');
    expect(result.error?.issues[0]?.message).toBe('Use 2 to 6 letters or digits, starting with a letter');
  });
});

describe('suggestProjectKey', () => {
  it.each([
    ['Payments', 'PAY'],
    ['Billing reconciliation', 'BIL'],
    ['Web app', 'WEB'],
    ['Infra', 'INF'],
    ['pm CLI', 'PMC'],
    ['2026 roadmap', 'ROA'],
    ['Ö-Bahn', 'OBA'],
    ['X', null],
    ['', null],
    ['!!!', null],
  ])('%s gives %s', (name, key) => {
    expect(suggestProjectKey(name)).toBe(key);
  });
});

describe('TaskKey', () => {
  it('parses into project key and number', () => {
    expect(parseTaskKey('PAY-142')).toEqual({ projectKey: 'PAY', number: 142, suffix: null });
    expect(parseTaskKey('A1B2C3-7')).toEqual({ projectKey: 'A1B2C3', number: 7, suffix: null });
  });

  it('accepts any case and surrounding spaces when parsing input', () => {
    expect(parseTaskKey(' pay-142 ')).toEqual({ projectKey: 'PAY', number: 142, suffix: null });
    expect(TaskKeyInput.parse('web-1')).toBe('WEB-1');
  });

  it('accepts the largest Postgres integer', () => {
    expect(parseTaskKey('PAY-2147483647').number).toBe(2147483647);
  });

  it.each([
    ['number zero', 'PAY-0'],
    ['leading zero', 'PAY-01'],
    ['negative', 'PAY--1'],
    ['no dash', 'PAY142'],
    ['no number', 'PAY-'],
    ['bad project key', 'P-1'],
    ['project key too long', 'ABCDEFG-1'],
    ['project starts with digit', '1PAY-1'],
    ['over int4', 'PAY-2147483648'],
    ['eleven digits', 'PAY-12345678901'],
    ['trailing text', 'PAY-1x'],
    ['empty', ''],
    ['trailing dot', 'PAY-786.'],
    ['zero suffix', 'PAY-786.0'],
    ['zero-padded suffix', 'PAY-786.01'],
    ['empty suffix part', 'PAY-786..1'],
    ['suffix too long', 'PAY-786.123456'],
    ['suffix after zero', 'PAY-0.1'],
    ['letters in suffix', 'PAY-786.a'],
  ])('rejects %s', (_label, key) => {
    expect(safeParseTaskKey(key)).toBeNull();
    expect(() => parseTaskKey(key)).toThrow();
    expect(TaskKey.safeParse(key).success).toBe(false);
  });

  it('canonical schema is strict about case', () => {
    expect(TaskKey.safeParse('pay-1').success).toBe(false);
    expect(TaskKey.parse('PAY-1')).toBe('PAY-1');
  });

  it('formats and parses back', () => {
    const key = formatTaskKey('PAY', 142);
    expect(key).toBe('PAY-142');
    expect(parseTaskKey(key)).toEqual({ projectKey: 'PAY', number: 142, suffix: null });
  });
});

describe('TaskKey with a Backlog.md subtask suffix', () => {
  it.each([
    ['PAY-786', { projectKey: 'PAY', number: 786, suffix: null }],
    ['PAY-786.1', { projectKey: 'PAY', number: 786, suffix: '1' }],
    ['PAY-786.1.2', { projectKey: 'PAY', number: 786, suffix: '1.2' }],
    ['PAY-1.5', { projectKey: 'PAY', number: 1, suffix: '5' }],
    ['PAY-786.99999', { projectKey: 'PAY', number: 786, suffix: '99999' }],
  ])('parses %s', (key, parts) => {
    expect(parseTaskKey(key)).toEqual(parts);
    expect(splitTaskKey(key)).toEqual(parts);
    expect(TaskKey.parse(key)).toBe(key);
    expect(formatTaskKey(parts.projectKey, parts.number, parts.suffix)).toBe(key);
  });

  it('upper-cases input with a suffix', () => {
    expect(TaskKeyInput.parse(' pay-786.1 ')).toBe('PAY-786.1');
    expect(safeParseTaskKey('pay-786.1.2')).toEqual({ projectKey: 'PAY', number: 786, suffix: '1.2' });
  });

  it('splits only canonical keys and formats without an empty suffix', () => {
    expect(splitTaskKey('pay-786.1')).toBeNull();
    expect(splitTaskKey('PAY-786.')).toBeNull();
    expect(formatTaskKey('PAY', 786, null)).toBe('PAY-786');
    expect(formatTaskKey('PAY', 786, '')).toBe('PAY-786');
  });

  it('checks key suffixes on their own', () => {
    expect(KeySuffix.safeParse('1').success).toBe(true);
    expect(KeySuffix.safeParse('1.2').success).toBe(true);
    for (const bad of ['', '0', '01', '1.', '.1', '1..2', '123456', 'a']) {
      expect(KeySuffix.safeParse(bad).success, bad).toBe(false);
    }
  });
});

describe('Backlog.md ids', () => {
  it.each([
    ['BACK-786', 'BACK-786', { prefix: 'BACK', number: 786, suffix: null }],
    ['back-786.1', 'BACK-786.1', { prefix: 'BACK', number: 786, suffix: '1' }],
    ['task-12.1.3', 'TASK-12.1.3', { prefix: 'TASK', number: 12, suffix: '1.3' }],
    ['BACK-007', 'BACK-7', { prefix: 'BACK', number: 7, suffix: null }],
    ['back-0786.01', 'BACK-786.1', { prefix: 'BACK', number: 786, suffix: '1' }],
    ['DRAFT-14', 'DRAFT-14', { prefix: 'DRAFT', number: 14, suffix: null }],
    ['  Backlog-3  ', 'BACKLOG-3', { prefix: 'BACKLOG', number: 3, suffix: null }],
  ])('normalises %s to %s', (input, canonical, parts) => {
    expect(parseBacklogId(input)).toEqual(parts);
    expect(BacklogId.parse(input)).toBe(canonical);
    expect(formatBacklogId(parts)).toBe(canonical);
  });

  it.each([
    ['zero', 'BACK-0'],
    ['zero padding only', 'BACK-000'],
    ['zero suffix', 'BACK-786.0'],
    ['trailing dot', 'BACK-786.'],
    ['no prefix', '-786'],
    ['digits in prefix', 'B4CK-786'],
    ['no number', 'BACK-'],
    ['over int4', 'BACK-2147483648'],
    ['suffix part over five digits', 'BACK-1.123456'],
    ['spaces inside', 'BACK 786'],
    ['milestone id', 'm-'],
  ])('rejects %s', (_label, input) => {
    expect(parseBacklogId(input)).toBeNull();
    expect(BacklogId.safeParse(input).success).toBe(false);
  });
});

describe('TaskRefInput', () => {
  it('keeps app keys, upper-cased', () => {
    expect(TaskRefInput.parse('pay-786')).toBe('PAY-786');
    expect(TaskRefInput.parse(' PAY-786.1.2 ')).toBe('PAY-786.1.2');
  });

  it('normalises Backlog.md ids that are not app keys', () => {
    expect(TaskRefInput.parse('back-007')).toBe('BACK-7');
    expect(TaskRefInput.parse('backlog-786.01')).toBe('BACKLOG-786.1');
    expect(TaskRefInput.parse('TASK-12')).toBe('TASK-12');
  });

  it.each(['PAY-0', 'PAY-786.', 'PAY-786.0', 'PAY', '', 'PAY-1x', 'B4CK-01'])('rejects %j', (input) => {
    expect(TaskRefInput.safeParse(input).success).toBe(false);
  });
});

describe('M3 enumerations', () => {
  it('has a label for every provider, connection status, mode, state and trigger', () => {
    expect(Object.keys(GIT_PROVIDER_LABELS)).toEqual([...GIT_PROVIDERS]);
    expect(Object.keys(GIT_PROVIDER_BADGES)).toEqual([...GIT_PROVIDERS]);
    expect(Object.keys(GIT_CONNECTION_STATUS_LABELS)).toEqual([...GIT_CONNECTION_STATUSES]);
    expect(Object.keys(BACKLOG_MODE_LABELS)).toEqual([...BACKLOG_MODES]);
    expect(Object.keys(BACKLOG_STATE_LABELS)).toEqual([...BACKLOG_STATES]);
    expect(Object.keys(BACKLOG_TRIGGER_LABELS)).toEqual([...BACKLOG_TRIGGERS]);
    expect(GIT_PROVIDER_LABELS.gitea).toBe('Gitea / Forgejo');
    expect(GIT_CONNECTION_STATUS_LABELS.rejected).toBe('Token rejected');
  });

  it('lists the owned fields per object', () => {
    expect(TASK_OWNED_FIELDS).toEqual([
      'title',
      'description',
      'status',
      'priority',
      'assignee',
      'milestone',
      'createdAt',
      'labels',
      'dueDate',
      'blockedBy',
      'parent',
      'criteria',
      'doneItems',
      'plan',
      'finalSummary',
    ]);
    expect(MILESTONE_OWNED_FIELDS).toEqual(['name', 'description', 'targetDate', 'status']);
    expect(PROJECT_OWNED_FIELDS).toEqual(['key', 'repository', 'usesMilestones']);
    expect(ActivityOrigin.options).toEqual(['app', 'backlog']);
  });
});

describe('TaskStatus', () => {
  it('has a label for every status, in order', () => {
    expect(Object.keys(TASK_STATUS_LABELS)).toEqual([...TASK_STATUSES]);
    expect(TASK_STATUS_LABELS.in_progress).toBe('In progress');
    expect(TASK_STATUS_LABELS.in_review).toBe('In review');
  });

  it('knows which statuses are open', () => {
    expect(TASK_STATUSES.filter(isOpenStatus)).toEqual([...OPEN_TASK_STATUSES]);
    expect(isOpenStatus('done')).toBe(false);
    expect(isOpenStatus('canceled')).toBe(false);
  });

  it('rejects unknown values', () => {
    expect(TaskStatus.safeParse('in-progress').success).toBe(false);
    expect(TaskStatus.safeParse('Done').success).toBe(false);
  });
});

describe('Priority', () => {
  it('maps to and from database values 0 to 4', () => {
    expect(PRIORITIES.map(priorityToValue)).toEqual([0, 1, 2, 3, 4]);
    expect([0, 1, 2, 3, 4].map(priorityFromValue)).toEqual([...PRIORITIES]);
  });

  it('rejects database values out of range', () => {
    expect(() => priorityFromValue(5)).toThrow(RangeError);
    expect(() => priorityFromValue(-1)).toThrow(RangeError);
    expect(() => priorityFromValue(1.5)).toThrow(RangeError);
  });

  it('has display labels', () => {
    expect(Object.keys(PRIORITY_LABELS)).toEqual([...PRIORITIES]);
    expect(PRIORITY_LABELS.high).toBe('High');
  });

  it('rejects numeric input on the API', () => {
    expect(Priority.safeParse(3).success).toBe(false);
  });
});

describe('Timestamp', () => {
  it('turns a Date into an ISO string', () => {
    expect(Timestamp.parse(new Date('2026-10-22T18:19:06.997Z'))).toBe('2026-10-22T18:19:06.997Z');
  });

  it('normalises offsets to UTC', () => {
    expect(Timestamp.parse('2026-10-22T20:19:06+02:00')).toBe('2026-10-22T18:19:06.000Z');
  });

  it('is idempotent', () => {
    const once = Timestamp.parse(new Date('2026-10-22T18:19:06.997Z'));
    expect(Timestamp.parse(once)).toBe(once);
  });

  it.each([['not a date'], ['2026-10-22'], [new Date('invalid')], [1729621146997]])('rejects %s', (value) => {
    expect(Timestamp.safeParse(value).success).toBe(false);
  });
});

describe('CalendarDate', () => {
  it.each(['2026-11-14', '2028-02-29'])('accepts %s', (value) => {
    expect(CalendarDate.parse(value)).toBe(value);
  });

  it.each(['2026-02-29', '2026-13-01', '2026-11-14T00:00:00Z', '14.11.2026', ''])('rejects %j', (value) => {
    expect(CalendarDate.safeParse(value).success).toBe(false);
  });
});

describe('CycleNumber and CycleSelector', () => {
  it.each([
    [12, 12],
    ['12', 12],
    [' 7 ', 7],
    [2_147_483_647, 2_147_483_647],
  ])('reads cycle number %j', (value, parsed) => {
    expect(CycleNumber.parse(value)).toBe(parsed);
  });

  it.each([0, -1, 1.5, '0', '012', '1e3', 'twelve', '2147483648', 2_147_483_648])(
    'rejects cycle number %j',
    (value) => {
      expect(CycleNumber.safeParse(value).success).toBe(false);
    },
  );

  it.each([
    ['current', 'current'],
    ['next', 'next'],
    ['3', 3],
  ])('selects %j', (value, parsed) => {
    expect(CycleSelector.parse(value)).toBe(parsed);
  });

  it.each(['Current', 'none', 'previous', null])('rejects selector %j with one message', (value) => {
    const result = CycleSelector.safeParse(value);
    expect(result.success).toBe(false);
    expect(result.error?.issues.map((issue) => issue.message)).toEqual([
      'Use a cycle number, current or next',
    ]);
  });

  it('counts cycle days with both ends included, across a DST change', () => {
    expect(cycleLengthDays('2026-10-26', '2026-10-26')).toBe(1);
    expect(cycleLengthDays('2026-10-12', '2026-10-25')).toBe(14);
    expect(cycleLengthDays('2026-03-23', '2026-04-05')).toBe(14);
    expect(cycleLengthDays('2026-10-26', '2026-10-25')).toBe(0);
  });
});

describe('labels', () => {
  it('has a label for every milestone status, cycle state and theme', () => {
    expect(Object.keys(MILESTONE_STATUS_LABELS)).toEqual([...MILESTONE_STATUSES]);
    expect(Object.keys(CYCLE_STATE_LABELS)).toEqual([...CYCLE_STATES]);
    expect(Object.keys(THEME_LABELS)).toEqual([...THEMES]);
    expect(Theme.safeParse('auto').success).toBe(false);
  });
});
