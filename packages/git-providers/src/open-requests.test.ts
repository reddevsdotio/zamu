// The shared part of listOpenRequests: the folder rule, the cap and the cut flag.
import { describe, expect, it } from 'vitest';
import { requestsUnderFolder } from './open-requests';
import { isUnderFolder } from './paths';
import { MAX_OPEN_REQUESTS, type OpenRequest } from './types';

const request = (number: number): OpenRequest => ({
  number,
  title: `Request ${number}`,
  author: 'octocat',
  headBranch: `branch-${number}`,
  webUrl: `https://example.com/pulls/${number}`,
});

describe('isUnderFolder', () => {
  it('matches the folder and paths below it, not names that only start the same', () => {
    expect(isUnderFolder('backlog/tasks/a.md', 'backlog')).toBe(true);
    expect(isUnderFolder('backlog/tasks/a.md', './backlog/')).toBe(true);
    expect(isUnderFolder('backlog', 'backlog')).toBe(true);
    expect(isUnderFolder('backlog-notes.md', 'backlog')).toBe(false);
    expect(isUnderFolder('docs/backlog/a.md', 'backlog')).toBe(false);
    expect(isUnderFolder('anything.md', '')).toBe(true);
  });
});

describe('requestsUnderFolder', () => {
  it('looks at the newest requests up to the cap and says the list was cut', async () => {
    const asked: number[] = [];
    const result = await requestsUnderFolder(
      {
        requests: Array.from({ length: MAX_OPEN_REQUESTS + 5 }, (_, index) => request(index + 1)),
        more: false,
        listUrl: 'https://example.com/pulls',
      },
      'backlog',
      async (candidate) => {
        asked.push(candidate.number);
        return { paths: candidate.number % 10 === 0 ? ['backlog/a.md'] : ['src/a.ts'], more: false };
      },
    );
    expect(asked).toHaveLength(MAX_OPEN_REQUESTS);
    expect(Math.min(...asked)).toBe(6);
    expect(result.requests.map((entry) => entry.number)).toEqual([100, 90, 80, 70, 60, 50, 40, 30, 20, 10]);
    expect(result.truncated).toBe(true);
  });

  it('an empty list asks for no files', async () => {
    await expect(
      requestsUnderFolder({ requests: [], more: false, listUrl: 'u' }, 'backlog', async () => {
        throw new Error('not called');
      }),
    ).resolves.toEqual({ requests: [], truncated: false, listUrl: 'u' });
  });
});
