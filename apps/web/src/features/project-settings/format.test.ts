import { describe, expect, it } from 'vitest';
import { CONNECTION, NOW, sourceStatus } from './fixtures';
import {
  agoText,
  contentsText,
  failedBanner,
  maskSecret,
  modeText,
  nextCheckText,
  pausedBanner,
  problemCount,
  problemRow,
  problemsNote,
  readText,
  sourceDot,
  statusHeading,
  webhookText,
} from './format';

describe('project settings format', () => {
  it('maps source states to dots', () => {
    expect(sourceDot('setup')).toBe('reading');
    expect(sourceDot('reading')).toBe('reading');
    expect(sourceDot('warnings')).toBe('warnings');
    expect(sourceDot('detached')).toBe('detached');
  });

  it('titles the status section per state', () => {
    expect(statusHeading(sourceStatus(), NOW)).toEqual({ title: 'Mirroring', note: 'everything up to date' });
    expect(statusHeading(sourceStatus(), NOW, { queued: true })).toEqual({
      title: 'Refreshing',
      note: 'queued',
    });
    expect(
      statusHeading(sourceStatus({ state: 'reading', lastAttemptAt: '2026-10-23T11:59:50Z' }), NOW),
    ).toEqual({ title: 'Refreshing', note: 'started 10s ago' });
    expect(
      statusHeading(sourceStatus({ state: 'failed', lastAttemptAt: '2026-10-23T11:46:00Z' }), NOW),
    ).toEqual({
      title: 'Last refresh failed',
      note: '14m ago',
    });
    expect(
      statusHeading(
        sourceStatus({ state: 'detached', mode: 'import', detachedAt: '2026-10-23T10:00:00Z' }),
        NOW,
      ),
    ).toEqual({ title: 'Imported', note: 'imported Oct 23' });
    // PM-33: a mirror switched to Zamu is owned by Zamu, never "Detached".
    expect(
      statusHeading(
        sourceStatus({ state: 'detached', mode: 'mirror', detachedAt: '2026-10-23T10:00:00Z' }),
        NOW,
      ),
    ).toEqual({ title: 'Owned by Zamu', note: 'since Oct 23' });
    // Server render: no times.
    expect(statusHeading(sourceStatus({ state: 'failed' }), null).note).toBe('');
  });

  it('counts problems', () => {
    const status = sourceStatus({
      state: 'warnings',
      problems: {
        nextCursor: null,
        counts: { files: 3, values: 1 },
        items: [
          { kind: 'file', path: 'backlog/tasks/a.md', backlogId: 'BACK-1', skipped: true, message: 'bad' },
          { kind: 'file', path: 'backlog/tasks/b.md', backlogId: 'BACK-2', skipped: true, message: 'bad' },
          { kind: 'file', path: 'backlog/tasks/c.md', backlogId: 'BACK-3', skipped: false, message: 'date' },
          {
            kind: 'value',
            field: 'status',
            value: 'Blocked',
            count: 2,
            fallback: 'Todo',
            message: 'Status "Blocked" is not mapped; shown as Todo. Map it in Edit mappings.',
          },
        ],
      },
    });
    expect(problemsNote(status)).toBe('2 files skipped, 1 file with warnings, 1 value unmapped');
    expect(problemCount(status)).toBe(4);
    expect(problemsNote({ problems: { ...status.problems, nextCursor: 'x' } })).toBe(
      '3 files with problems, 1 value unmapped',
    );
  });

  it('words problem rows like the canvas', () => {
    expect(
      problemRow({
        kind: 'value',
        field: 'status',
        value: 'Blocked',
        count: 2,
        fallback: 'Todo',
        message: 'm',
      }),
    ).toEqual({
      severity: 'warning',
      file: 'status “Blocked” · 2 tasks',
      text: 'not mapped, shown as Todo. Map it in Edit mappings.',
    });
    expect(
      problemRow({
        kind: 'file',
        path: 'backlog/tasks/x.md',
        backlogId: null,
        skipped: true,
        message: 'no id',
      }),
    ).toEqual({ severity: 'error', file: 'backlog/tasks/x.md', text: 'no id' });
    expect(
      problemRow({
        kind: 'value',
        field: 'milestone',
        value: 'm-9',
        count: 1,
        fallback: null,
        message: 'No milestone m-9',
      }).text,
    ).toBe('No milestone m-9');
  });

  it('writes the facts', () => {
    const status = sourceStatus();
    expect(modeText(status)).toBe('Mirror · follows the default branch');
    expect(modeText({ mode: 'import', state: 'detached' })).toBe('Imported once');
    expect(modeText({ mode: 'mirror', state: 'detached' })).toBe('Mirrored, then switched to Zamu');
    expect(readText(status, NOW)).toBe('3m ago, by webhook, commit');
    expect(nextCheckText(status, NOW)).toBe('Hourly, next in 57m');
    expect(webhookText(status.webhookLastAt, NOW)).toBe('Last notification 3m ago');
    expect(webhookText(null, NOW)).toBe('No notification yet');
    expect(contentsText(status)).toBe('412 tasks, 38 open · 6 milestones');
    // Drafts and archived tasks are tasks of the project too; drafts come in as Backlog, so open.
    expect(
      contentsText({
        counts: { tasks: 6, open: 6, drafts: 1, archived: 1, subtasks: 2, milestones: 1, hidden: 1 },
      }),
    ).toBe('8 tasks, 7 open · 1 milestone');
    expect(agoText('2026-10-23T11:59:58Z', NOW)).toBe('just now');
  });

  it('explains failed and paused sources', () => {
    expect(
      failedBanner(
        sourceStatus({ state: 'failed', lastError: 'backlog/config.yml couldn’t be read: line 12' }),
        NOW,
      ),
    ).toBe(
      "backlog/config.yml couldn’t be read: line 12. Nothing changed: tasks show commit a1b2c3d from 3m ago. Fix the file and push, or refresh once it's fixed.",
    );
    const unreachable = sourceStatus({
      state: 'paused',
      lastAttemptAt: null,
      connection: {
        ...CONNECTION,
        name: 'Forgejo at home',
        host: 'git.home.example.com',
        status: 'unreachable',
      },
    });
    expect(pausedBanner(unreachable, NOW)).toBe(
      "The mirror is paused: the connection Forgejo at home can't reach git.home.example.com. It retries every hour. Tasks stay as they were.",
    );
    expect(pausedBanner(sourceStatus({ state: 'paused', connection: null }), NOW)).toMatch(
      /connection was deleted/,
    );
    expect(pausedBanner(sourceStatus({ state: 'paused', repository: null }), NOW)).toMatch(
      /has no repository/,
    );
  });

  it('masks the webhook secret', () => {
    expect(maskSecret('whsec_9Lq2abcdefghijTz4')).toBe('whsec_9Lq2……………………Tz4');
    expect(maskSecret(null)).toMatch(/^•+$/);
  });
});
