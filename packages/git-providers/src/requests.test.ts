import { describe, expect, it } from 'vitest';
import { hasDraftPrefix, isoTime, pageSize, parseRequestUrl, updatedSince } from './requests';
import type { RequestInfo } from './types';

describe('parseRequestUrl', () => {
  it.each([
    ['https://github.com/northwind/payments/pull/12', 'github', 'github.com', 'northwind/payments', 12],
    [
      'https://github.com/northwind/payments/pull/12/files#diff-1',
      'github',
      'github.com',
      'northwind/payments',
      12,
    ],
    ['https://GitHub.com/Northwind/Payments/pull/12?w=1', 'github', 'github.com', 'Northwind/Payments', 12],
    [
      'https://ghe.example.com/northwind/payments/pull/7/commits',
      'github',
      'ghe.example.com',
      'northwind/payments',
      7,
    ],
    [
      'https://gitlab.example.com/northwind/platform/payments/-/merge_requests/12',
      'gitlab',
      'gitlab.example.com',
      'northwind/platform/payments',
      12,
    ],
    [
      'https://gitlab.com/northwind/payments/-/merge_requests/12/diffs?commit_id=abc#note_1',
      'gitlab',
      'gitlab.com',
      'northwind/payments',
      12,
    ],
    [
      'https://forgejo.example.com/northwind/payments/pulls/12',
      'gitea',
      'forgejo.example.com',
      'northwind/payments',
      12,
    ],
    [
      'https://forgejo.example.com/northwind/payments/pulls/12/files',
      'gitea',
      'forgejo.example.com',
      'northwind/payments',
      12,
    ],
    [
      'http://localhost:3300/zamu-admin/payments/pulls/3/',
      'gitea',
      'localhost:3300',
      'zamu-admin/payments',
      3,
    ],
    [
      'https://forgejo.example.com:443/northwind/payments/pulls/12',
      'gitea',
      'forgejo.example.com',
      'northwind/payments',
      12,
    ],
    [
      '  https://codeberg.org/northwind/pay%20ments/pulls/9  ',
      'gitea',
      'codeberg.org',
      'northwind/pay ments',
      9,
    ],
  ])('reads %s', (url, provider, host, path, number) => {
    expect(parseRequestUrl(url)).toEqual({ provider, host, path, number });
  });

  it.each([
    [''],
    ['not a url'],
    ['github.com/northwind/payments/pull/12'],
    ['ftp://github.com/northwind/payments/pull/12'],
    ['https://user:secret@github.com/northwind/payments/pull/12'],
    ['https://github.com/northwind/payments'],
    ['https://github.com/northwind/payments/pulls'],
    ['https://github.com/northwind/payments/pull/'],
    ['https://github.com/northwind/payments/pull/0'],
    ['https://github.com/northwind/payments/pull/-3'],
    ['https://github.com/northwind/payments/pull/12abc'],
    ['https://github.com/northwind/payments/issues/12'],
    ['https://github.com/northwind/payments/pulls/12'],
    ['https://github.com/northwind/payments/-/merge_requests/12'],
    ['https://gitlab.com/northwind/payments/pull/12'],
    ['https://gitlab.com/northwind/-/merge_requests/12'],
    ['https://gitlab.com/northwind/payments/-/issues/12'],
    ['https://gitlab.com/northwind/payments/merge_requests/12'],
    ['https://forgejo.example.com/northwind/payments/pulls/1e3'],
    ['https://forgejo.example.com/northwind/payments/pulls/99999999999999999999'],
    ['https://forgejo.example.com/northwind/../payments/pulls/1'],
    ['https://forgejo.example.com/northwind/pay%2Fments/pulls/1'],
    ['https://forgejo.example.com/northwind/pay%E0%A4%A/pulls/1'],
    ['https://api.github.com/repos/northwind/payments/pulls/12'],
  ])('refuses %s', (url) => {
    expect(parseRequestUrl(url)).toBeNull();
  });
});

describe('isoTime', () => {
  it('turns every host format into ISO 8601 UTC', () => {
    expect(isoTime('2026-11-24T10:00:00Z')).toBe('2026-11-24T10:00:00.000Z');
    expect(isoTime('2026-11-24T10:00:00.123Z')).toBe('2026-11-24T10:00:00.123Z');
    expect(isoTime('2026-11-24T10:00:00+01:00')).toBe('2026-11-24T09:00:00.000Z');
    expect(isoTime('2026-11-24 10:00:00 UTC')).toBe('2026-11-24T10:00:00.000Z');
    expect(isoTime('2026-11-24 10:00:00 +0200')).toBe('2026-11-24T08:00:00.000Z');
  });

  it('is null for missing or broken values', () => {
    expect(isoTime(null)).toBeNull();
    expect(isoTime(undefined)).toBeNull();
    expect(isoTime('')).toBeNull();
    expect(isoTime('yesterday')).toBeNull();
    expect(isoTime(1_764_000_000)).toBeNull();
  });
});

describe('draft prefixes', () => {
  it('matches the Gitea and Forgejo work-in-progress prefixes in any case', () => {
    for (const title of ['WIP: x', 'wip: x', '[WIP] x', '[wip]x', 'Draft: x', '  DRAFT: x']) {
      expect(hasDraftPrefix(title)).toBe(true);
    }
    for (const title of ['x WIP:', 'Wipe the cache', 'Drafted notes', '']) {
      expect(hasDraftPrefix(title)).toBe(false);
    }
  });
});

describe('updatedSince', () => {
  const request = (number: number, updatedAt: string): RequestInfo => ({
    number,
    title: `#${number}`,
    body: '',
    state: 'open',
    headBranch: `b${number}`,
    baseBranch: 'main',
    author: null,
    mergedBy: null,
    webUrl: `https://github.com/northwind/payments/pull/${number}`,
    openedAt: updatedAt,
    mergedAt: null,
    closedAt: null,
    updatedAt,
  });

  it('keeps requests updated at or after the time, newest first, up to the limit', () => {
    const list = [
      request(1, '2026-11-20T10:00:00.000Z'),
      request(3, '2026-11-25T10:00:00.000Z'),
      request(2, '2026-11-22T10:00:00.000Z'),
      request(4, '2026-11-22T10:00:00.000Z'),
    ];
    const since = new Date('2026-11-22T10:00:00.000Z');
    expect(updatedSince(list, since, 100).map((entry) => entry.number)).toEqual([3, 4, 2]);
    expect(updatedSince(list, since, 2).map((entry) => entry.number)).toEqual([3, 4]);
    expect(updatedSince(list, null, 100).map((entry) => entry.number)).toEqual([3, 4, 2, 1]);
  });

  it('asks for one page between 1 and 100', () => {
    expect(pageSize(100)).toBe(100);
    expect(pageSize(500)).toBe(100);
    expect(pageSize(0)).toBe(1);
    expect(pageSize(7.9)).toBe(7);
    expect(pageSize(Number.NaN)).toBe(100);
  });
});
