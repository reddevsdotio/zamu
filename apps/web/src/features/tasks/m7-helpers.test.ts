import { ORPCError } from '@orpc/client';
import type { PullRequestLink, TaskListItem } from '@zamu/contracts';
import { describe, expect, it } from 'vitest';
import { describeCause, systemName, systemOf } from '~/features/comments/causes';
import { checkAgainPicks } from '~/features/task-fields/dates';
import { describeChange } from '~/features/task-fields/describe';
import { ARCHIVED_TEXT, fieldRefusal } from '~/features/task-fields/targets';
import { describeActivity } from './format';
import {
  linkRefusal,
  moveNote,
  NOT_A_REQUEST_TEXT,
  parseRequestAddress,
  requestsSummary,
} from './pull-requests';
import { applyTaskPatch, inversePatch, isNoopPatch, toUpdateInput } from './queries';

// The M7 helpers behind the task view: reading a pasted request address, the words around the request
// list, the refusals, the history's system actors and causes, the check-again patch and the archived
// refusal of the field keys.

const NOW = Date.UTC(2026, 10, 26, 12, 0);

function link(number: number, extra: Partial<PullRequestLink> = {}): PullRequestLink {
  return {
    provider: 'github',
    number,
    title: `Request ${number}`,
    url: `https://github.com/northwind/payments/pull/${number}`,
    state: 'open',
    headBranch: 'feat/x',
    baseBranch: 'main',
    author: null,
    mergedBy: null,
    how: 'branch',
    linkedBy: null,
    linkedAt: '2026-11-20T10:00:00.000Z',
    openedAt: '2026-11-20T10:00:00.000Z',
    mergedAt: null,
    closedAt: null,
    updatedAt: '2026-11-20T10:00:00.000Z',
    ...extra,
  };
}

describe('parseRequestAddress', () => {
  it('reads GitHub, GitLab and Forgejo request addresses', () => {
    expect(parseRequestAddress('https://github.com/northwind/payments/pull/482/files?w=1#top')).toEqual({
      url: 'https://github.com/northwind/payments/pull/482/files',
      provider: 'github',
      host: 'github.com',
      repository: 'northwind/payments',
      number: 482,
    });
    expect(parseRequestAddress('https://gitlab.example.com/g/sub/repo/-/merge_requests/12')).toMatchObject({
      provider: 'gitlab',
      repository: 'g/sub/repo',
      number: 12,
    });
    expect(parseRequestAddress('http://localhost:3300/zamu-admin/payments/pulls/2')).toMatchObject({
      provider: 'gitea',
      host: 'localhost:3300',
      repository: 'zamu-admin/payments',
      number: 2,
    });
  });

  it('adds the scheme when it was left out', () => {
    expect(parseRequestAddress('github.com/northwind/payments/pull/485')?.url).toBe(
      'https://github.com/northwind/payments/pull/485',
    );
  });

  it('refuses issues, repositories and text', () => {
    expect(parseRequestAddress('github.com/northwind/payments/issues/485')).toBeNull();
    expect(parseRequestAddress('https://github.com/northwind/payments')).toBeNull();
    expect(parseRequestAddress('fix the retries')).toBeNull();
    expect(parseRequestAddress('')).toBeNull();
    expect(parseRequestAddress('ftp://github.com/o/r/pull/1')).toBeNull();
    // Self-hosted servers on a network often have a host name without a dot.
    expect(parseRequestAddress('http://gitea:3000/northwind/payments/pulls/7')).toMatchObject({
      provider: 'gitea',
      host: 'gitea:3000',
      repository: 'northwind/payments',
      number: 7,
    });
  });
});

describe('the words around the requests', () => {
  it('counts open ones, with "still" when others are done', () => {
    expect(requestsSummary([link(1)], NOW)).toBe('1 open');
    expect(requestsSummary([link(1), link(2, { state: 'draft' }), link(3, { state: 'merged' })], NOW)).toBe(
      '2 still open',
    );
  });

  it('says when the last one merged and by whom, once the clock is known', () => {
    const merged = link(4, {
      state: 'merged',
      mergedAt: '2026-11-25T12:00:00.000Z',
      mergedBy: 'Tomás Ferrer',
    });
    expect(requestsSummary([merged], NOW)).toBe('merged yesterday by Tomás Ferrer');
    expect(requestsSummary([merged], null)).toBe('merged by Tomás Ferrer');
    expect(requestsSummary([link(5, { state: 'closed' })], NOW)).toBe('closed without merging');
  });

  it('explains the move to Done only with several open requests on an open task', () => {
    const task = { key: 'PAY-142', status: 'in_review' as const };
    expect(moveNote(task, [link(482), link(485, { state: 'draft' })])).toBe(
      'PAY-142 moves to Done when #482 and #485 are merged or closed. A request closed without merging changes nothing.',
    );
    expect(moveNote(task, [link(482)])).toBeNull();
    expect(moveNote({ ...task, status: 'done' }, [link(482), link(485)])).toBeNull();
  });
});

describe('linkRefusal', () => {
  const address = parseRequestAddress('https://github.com/northwind/storefront/pull/77');

  it('names the other repository and the linked one (frame 059)', () => {
    const error = new ORPCError('REQUEST_OTHER_REPOSITORY', {
      status: 422,
      message: 'That request is in another repository.',
      data: { repository: 'github.com/northwind/payments' },
    });
    expect(linkRefusal(error, address, 'Payments')).toEqual({
      kind: 'other-repository',
      text: '#77 is in northwind/storefront. Payments is linked to northwind/payments, and only its requests can be linked here.',
    });
  });

  it('reads NOT_A_REQUEST as the address text, other errors as their message', () => {
    expect(linkRefusal(new ORPCError('NOT_A_REQUEST', { status: 422 }), address, 'Payments')).toEqual({
      kind: 'not-a-request',
    });
    expect(NOT_A_REQUEST_TEXT).toMatch(/^That isn't a pull or merge request address\./);
    expect(
      linkRefusal(
        new ORPCError('REQUEST_NOT_FOUND', { status: 404, message: 'No request #9.' }),
        address,
        'Payments',
      ),
    ).toEqual({ kind: 'other', text: 'No request #9.' });
  });
});

describe('system actors and causes', () => {
  const cause = {
    kind: 'pull_request' as const,
    provider: 'github' as const,
    number: 482,
    title: 't',
    url: 'https://github.com/o/r/pull/482',
    event: 'opened' as const,
    by: 'claude-dev',
  };

  it('names the host, Zamu or Backlog.md', () => {
    expect(systemName({ kind: 'git', provider: 'gitea' })).toBe('Forgejo');
    expect(systemName({ kind: 'zamu' })).toBe('Zamu');
    expect(systemOf({ actor: null, origin: 'git', cause })).toEqual({ kind: 'git', provider: 'github' });
    expect(systemOf({ actor: null, origin: 'app' })).toEqual({ kind: 'zamu' });
    expect(systemOf({ actor: null, origin: 'backlog' })).toEqual({ kind: 'backlog' });
  });

  it('says why after the dot', () => {
    const base = { id: 'a', type: 'task.updated' as const, actor: null, changes: [] };
    expect(describeCause({ ...base, cause })).toBe('#482 opened by claude-dev');
    expect(describeCause({ ...base, cause: { ...cause, event: 'ready', by: null } })).toBe(
      '#482 marked ready',
    );
    expect(
      describeCause({ ...base, cause: { kind: 'archive', afterDays: 14 } }, { status: 'canceled' }),
    ).toBe('14 days after it was canceled');
    const linked = {
      ...base,
      type: 'task.pull_request_linked' as const,
      cause,
      changes: [
        {
          field: 'pullRequest' as const,
          from: null,
          to: {
            provider: 'github' as const,
            number: 482,
            title: 't',
            url: cause.url,
            how: 'branch' as const,
          },
        },
      ],
    };
    expect(describeCause(linked, { pullRequests: [link(482, { headBranch: 'feat/payout-retries' })] })).toBe(
      'work started on feat/payout-retries',
    );
    expect(describeCause(linked)).toBe('work started on its branch');
  });

  it('says the M7 changes in the history', () => {
    expect(describeActivity({ type: 'task.archived', changes: [] })).toBe('archived this');
    expect(describeActivity({ type: 'task.unarchived', changes: [] })).toBe('restored this');
    expect(
      describeActivity({
        type: 'task.updated',
        changes: [
          { field: 'status', from: 'todo', to: 'in_progress' },
          { field: 'workBranch', from: null, to: 'feat/x' },
        ],
      }),
    ).toBe('moved this to In progress');
    expect(
      describeActivity({
        type: 'task.updated',
        changes: [{ field: 'workBranch', from: null, to: 'feat/x' }],
      }),
    ).toBe('started work on feat/x');
    expect(
      describeActivity({
        type: 'task.updated',
        changes: [{ field: 'checkAgain', from: { on: '2026-12-03', reason: 'a' }, to: null }],
      }),
    ).toBe('cleared the check-again day');
    expect(
      describeActivity({
        type: 'task.pull_request_unlinked',
        changes: [
          {
            field: 'pullRequest',
            from: { provider: 'gitlab', number: 12, title: 't', url: 'https://x.test', how: 'hand' },
            to: null,
          },
        ],
      }),
    ).toBe('unlinked !12');
  });
});

describe('the check-again patch', () => {
  const row = {
    key: 'PAY-3',
    status: 'todo',
    checkAgain: null,
    labels: [],
    project: { id: 'p', key: 'PAY', name: 'Payments' },
  } as unknown as TaskListItem;
  const day = { on: '2026-12-03', reason: 'The bank issues the certificate' };

  it('applies, inverts and sends it', () => {
    expect(applyTaskPatch(row, { checkAgain: day }).checkAgain).toEqual(day);
    expect(inversePatch({ ...row, checkAgain: day }, { checkAgain: null })).toEqual({ checkAgain: day });
    expect(isNoopPatch({ ...row, checkAgain: day }, { checkAgain: { ...day } })).toBe(true);
    expect(isNoopPatch(row, { checkAgain: day })).toBe(false);
    expect(toUpdateInput({ key: 'PAY-3', patch: { checkAgain: day } })).toEqual({
      key: 'PAY-3',
      checkAgain: day,
    });
    expect(toUpdateInput({ key: 'PAY-3', patch: { checkAgain: null } })).toEqual({
      key: 'PAY-3',
      checkAgain: null,
    });
    expect(describeChange('PAY-3', { checkAgain: day }, '2026-11-26')).toBe('PAY-3 waits until Dec 3');
  });

  it('offers a week, two weeks and a month', () => {
    expect(checkAgainPicks('2026-11-04').map((pick) => [pick.label, pick.date])).toEqual([
      ['In a week', '2026-11-11'],
      ['In two weeks', '2026-11-18'],
      ['In a month', '2026-12-04'],
    ]);
  });

  it('is set on one task at a time, and never on an archived one', () => {
    expect(fieldRefusal([row], 'checkAgain')).toBeNull();
    expect(fieldRefusal([row, { ...row, key: 'PAY-4' }], 'checkAgain')).toMatch(/one task at a time/);
    expect(fieldRefusal([{ ...row, archivedAt: '2026-11-20T00:00:00.000Z' }], 'status')).toBe(ARCHIVED_TEXT);
    expect(
      fieldRefusal([row, { ...row, key: 'PAY-4', archivedAt: '2026-11-20T00:00:00.000Z' }], 'priority'),
    ).toBe('1 of 2 selected tasks are archived. Restore them to change them.');
  });
});
