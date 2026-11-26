// The M7 handlers through runJob: payloads are parsed, then the repository check and the event
// job run their core services.
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { recordingJobQueue, TEST_ENCRYPTION_KEY } from './backlog/testing';
import { type JobContext, jobHandlers, runJob } from './job-handlers';
import { REPOSITORY_EVENT, REPOSITORY_POLL, REPOSITORY_SYNC, TASKS_ARCHIVE_DUE } from './jobs';
import { type TestContext, testContext } from './testing/fixtures';
import { FakeRequestHost, fakeRequestFactory, requestInfo } from './testing/requests';

describe('M7 job handlers', () => {
  let base: TestContext;
  let ctx: JobContext & { jobs: ReturnType<typeof recordingJobQueue> };

  beforeAll(async () => {
    base = testContext();
    ctx = {
      db: base.db,
      timeZone: 'UTC',
      encryptionKey: TEST_ENCRYPTION_KEY,
      providerFactory: fakeRequestFactory(new FakeRequestHost()),
      jobs: recordingJobQueue(),
    };
  });
  afterAll(async () => {
    await base?.close();
  });

  // The test database is shared by every test file, so the jobs that read every workspace (the
  // archive job, the poll) are not run here: archive.test.ts and repository.test.ts cover them.
  it('refuses a malformed archive payload before running anything', async () => {
    await expect(runJob(ctx, TASKS_ARCHIVE_DUE, { now: 'tonight' })).rejects.toThrow();
  });

  it('skips a check and an event for a link that is gone', async () => {
    const linkId = crypto.randomUUID();
    expect(await runJob(ctx, REPOSITORY_SYNC, { linkId })).toMatchObject({ status: 'skipped' });
    expect(await runJob(ctx, REPOSITORY_EVENT, { linkId, request: requestInfo({ number: 1 }) })).toEqual({
      applied: false,
      reason: 'no_link',
    });
    await expect(runJob(ctx, REPOSITORY_SYNC, {})).rejects.toThrow();
  });

  it('has a handler for every M7 job', () => {
    for (const name of [REPOSITORY_EVENT, REPOSITORY_SYNC, REPOSITORY_POLL, TASKS_ARCHIVE_DUE] as const) {
      expect(typeof jobHandlers[name]).toBe('function');
    }
  });
});
