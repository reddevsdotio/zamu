// M7 contract additions: pull and merge requests on tasks, repository settings, archiving with its
// project setting and preview, check-again days, the activity cause and system actors, the Home
// groups and counts, the new problem codes, and the CLI shapes for them.

import { ORPCError } from '@orpc/contract';
import { describe, expect, it } from 'vitest';
import type { z } from 'zod';
import { CLI_QUEUE_PROCEDURES, CliQueueEntry, cliOutput, parseCliOutput } from './cli';
import { apiErrors, contract } from './contract';
import {
  ACTIVITY_TYPES,
  Activity,
  ActivityCause,
  ActivityChange,
  ActivitySystemActor,
  ArchivePreview,
  BACKLOG_EXPORT_PREFIXES,
  BacklogExportPath,
  CheckAgain,
  HOME_GROUP_KEYS,
  HomeCounts,
  HomeGroup,
  HomeItem,
  HomePill,
  MergedOpen,
  Project,
  PULL_REQUEST_LINK_HOWS,
  PULL_REQUEST_STATE_LABELS,
  PULL_REQUEST_STATES,
  PullRequestLink,
  RepositorySettings,
  RepositoryWebhookSecret,
  TASK_ACTIVITY_TYPES,
  Task,
  TaskListItem,
  TimelineItem,
} from './entities';
import {
  ARCHIVED_FILTERS,
  ArchivePreviewInput,
  ArchiveTasksInput,
  CHECK_AGAIN_FILTERS,
  CheckAgainInput,
  CheckAgainReason,
  CreateTaskInput,
  LinkPullRequestInput,
  ListTasksInput,
  MAX_BULK_TASKS,
  PullRequestUrl,
  UnlinkPullRequestInput,
  UpdateProjectInput,
  UpdateRepositoryInput,
  UpdateTaskInput,
} from './inputs';
import {
  ACTIVITY_ORIGINS,
  ARCHIVE_AFTER_DAYS_MAX,
  ARCHIVE_AFTER_DAYS_MIN,
  ArchiveAfterDays,
  checkAgainState,
  DEFAULT_ARCHIVE_AFTER_DAYS,
  GIT_ACTOR_NAMES,
  MAX_CHECK_AGAIN_REASON_LENGTH,
  ZAMU_ACTOR_NAME,
} from './primitives';
import { PROBLEM_STATUS, PROBLEM_TITLES, Problem, problem } from './problem';
import { decodeProblem, encodeProblem } from './problem-codec';
import {
  archiveActivityFixture,
  archivedTaskFixture,
  archivePreviewFixture,
  checkAgainHomeItemFixture,
  gitActivityFixture,
  handLinkedPullRequestFixture,
  m7ListItemFixture,
  m7TaskFixture,
  mergedOpenHomeItemFixture,
  noRepositorySettingsFixture,
  projectFixture,
  pullRequestLinkedActivityFixture,
  pullRequestLinkFixture,
  repositorySettingsFixture,
  taskFixture,
  taskListItemFixture,
} from './testing/fixtures';

const issuePaths = (result: { success: boolean; error?: { issues: { path: PropertyKey[] }[] } }) =>
  result.error?.issues.map((issue) => issue.path.join('.')) ?? [];

/** The input schema of a contract procedure. */
function input(procedure: { '~orpc': { inputSchema?: unknown } }): z.ZodType {
  return procedure['~orpc'].inputSchema as z.ZodType;
}

describe('M7 primitives', () => {
  it('archives after 1 to 365 whole days, 14 for new projects', () => {
    expect([ARCHIVE_AFTER_DAYS_MIN, ARCHIVE_AFTER_DAYS_MAX, DEFAULT_ARCHIVE_AFTER_DAYS]).toEqual([
      1, 365, 14,
    ]);
    for (const days of [1, 14, 365]) expect(ArchiveAfterDays.parse(days)).toBe(days);
    for (const days of [0, 366, -1, 1.5])
      expect(ArchiveAfterDays.safeParse(days).success, String(days)).toBe(false);
    expect(ArchiveAfterDays.safeParse(0).error?.issues[0]?.message).toBe('Use 1 to 365 days');
  });

  it('reads a check-again day as waiting before it and ready from it on', () => {
    expect(checkAgainState('2026-11-27', '2026-11-26')).toBe('waiting');
    expect(checkAgainState('2026-11-26', '2026-11-26')).toBe('ready');
    expect(checkAgainState('2026-10-01', '2026-11-26')).toBe('ready');
    expect(checkAgainState('2027-01-01', '2026-12-31')).toBe('waiting');
  });

  it('adds the git origin and names the system actors', () => {
    expect(ACTIVITY_ORIGINS).toEqual(['app', 'backlog', 'git']);
    expect(ZAMU_ACTOR_NAME).toBe('Zamu');
    expect(GIT_ACTOR_NAMES).toEqual({ github: 'GitHub', gitlab: 'GitLab', gitea: 'Forgejo' });
  });
});

describe('check-again day', () => {
  it('needs the day and the reason together', () => {
    expect(CheckAgainInput.parse({ on: '2026-12-01', reason: '  Wait for the bank  ' })).toEqual({
      on: '2026-12-01',
      reason: 'Wait for the bank',
    });
    expect(issuePaths(CheckAgainInput.safeParse({ on: '2026-12-01' }))).toEqual(['reason']);
    expect(issuePaths(CheckAgainInput.safeParse({ reason: 'Wait for the bank' }))).toEqual(['on']);
    expect(CheckAgainInput.safeParse('2026-12-01').success).toBe(false);
    expect(CheckAgainInput.safeParse({ on: '2026-02-30', reason: 'x' }).success).toBe(false);
    // Past days are allowed: the task is ready to check at once.
    expect(CheckAgainInput.safeParse({ on: '2020-01-01', reason: 'Look again' }).success).toBe(true);
  });

  it('takes a one-line reason of 1 to 200 characters', () => {
    expect(MAX_CHECK_AGAIN_REASON_LENGTH).toBe(200);
    expect(CheckAgainReason.safeParse('x'.repeat(200)).success).toBe(true);
    expect(CheckAgainReason.safeParse('x'.repeat(201)).success).toBe(false);
    expect(CheckAgainReason.safeParse('   ').error?.issues[0]?.message).toBe('Say why to check again');
    expect(CheckAgainReason.safeParse('two\nlines').success).toBe(false);
  });

  it('sets or clears it on PATCH /tasks/{key}, alone or with other changes', () => {
    expect(UpdateTaskInput.parse({ key: 'PAY-142', checkAgain: null })).toEqual({
      key: 'PAY-142',
      checkAgain: null,
    });
    expect(
      UpdateTaskInput.parse({ key: 'PAY-142', checkAgain: { on: '2026-12-01', reason: 'Bank reply' } }),
    ).toMatchObject({ checkAgain: { on: '2026-12-01', reason: 'Bank reply' } });
    // A day without a reason is a validation problem (400).
    expect(
      issuePaths(UpdateTaskInput.safeParse({ key: 'PAY-142', checkAgain: { on: '2026-12-01' } })),
    ).toEqual(['checkAgain.reason']);
    expect(
      UpdateTaskInput.safeParse({ key: 'PAY-142', status: 'in_progress', checkAgain: null }).success,
    ).toBe(true);
    expect(UpdateTaskInput.safeParse({ key: 'PAY-142' }).error?.issues[0]?.message).toContain(
      'or checkAgain',
    );
  });

  it('may start a new task', () => {
    const parsed = CreateTaskInput.parse({
      project: 'PAY',
      title: 'Ask the bank',
      checkAgain: { on: '2026-12-01', reason: 'Reply due' },
    });
    expect(parsed.checkAgain).toEqual({ on: '2026-12-01', reason: 'Reply due' });
    expect(CreateTaskInput.parse({ project: 'PAY', title: 'Ask' }).checkAgain).toBeUndefined();
    expect(
      CreateTaskInput.safeParse({ project: 'PAY', title: 'Ask', checkAgain: { on: '2026-12-01' } }).success,
    ).toBe(false);
  });

  it('reads back as a day and a reason', () => {
    expect(CheckAgain.safeParse({ on: '2026-12-01', reason: '' }).success).toBe(false);
    expect(CheckAgain.safeParse({ on: '2026-12-01', reason: 'x'.repeat(201) }).success).toBe(false);
  });
});

describe('archive setting', () => {
  it('sets, changes and turns off archiving on PATCH /projects/{project}', () => {
    expect(UpdateProjectInput.parse({ project: 'pay', archiveAfterDays: 14 })).toEqual({
      project: 'PAY',
      archiveAfterDays: 14,
    });
    expect(UpdateProjectInput.parse({ project: 'PAY', archiveAfterDays: null })).toEqual({
      project: 'PAY',
      archiveAfterDays: null,
    });
    for (const days of [0, 366, 2.5, '14']) {
      expect(
        UpdateProjectInput.safeParse({ project: 'PAY', archiveAfterDays: days }).success,
        String(days),
      ).toBe(false);
    }
  });

  it('carries the setting on projects, missing reading as off', () => {
    expect(Project.parse({ ...projectFixture, archiveAfterDays: 30 }).archiveAfterDays).toBe(30);
    expect(Project.parse(projectFixture).archiveAfterDays).toBeUndefined();
    expect(Project.safeParse({ ...projectFixture, archiveAfterDays: 0 }).success).toBe(false);
  });

  it('previews the count for a number of days given as query text', () => {
    const preview = input(contract.projects.archivePreview);
    expect(preview.parse({ project: 'pay', days: '14' })).toEqual({ project: 'PAY', days: 14 });
    expect(ArchivePreviewInput.parse({ project: 'PAY', days: 365 })).toEqual({ project: 'PAY', days: 365 });
    for (const days of ['0', '366', 'x', '', undefined]) {
      expect(preview.safeParse({ project: 'PAY', days }).success, String(days)).toBe(false);
    }
    expect(ArchivePreview.parse(archivePreviewFixture)).toEqual({ project: 'PAY', days: 14, count: 37 });
    expect(ArchivePreview.safeParse({ ...archivePreviewFixture, count: -1 }).success).toBe(false);
  });
});

describe('archiving and restoring tasks', () => {
  it('takes 1 to 100 keys, de-duplicated, on POST /tasks/archive and /tasks/restore', () => {
    for (const procedure of [contract.tasks.archive, contract.tasks.restore]) {
      const schema = input(procedure);
      expect(schema.parse({ keys: ['pay-142', 'PAY-142', 'pay-7'] })).toEqual({ keys: ['PAY-142', 'PAY-7'] });
      expect(issuePaths(schema.safeParse({ keys: [] }))).toEqual(['keys']);
      expect(schema.safeParse({}).success).toBe(false);
      expect(schema.safeParse({ keys: ['BACK-7.01'] }).success).toBe(false);
      const many = Array.from({ length: MAX_BULK_TASKS + 1 }, (_, index) => `PAY-${index + 1}`);
      expect(schema.safeParse({ keys: many }).error?.issues[0]?.message).toBe(
        'Change 100 tasks or fewer at once',
      );
    }
    expect(ArchiveTasksInput.parse({ keys: ['PAY-1'] })).toEqual({ keys: ['PAY-1'] });
  });

  it('filters lists by archived, excluding them unless asked', () => {
    expect(ARCHIVED_FILTERS).toEqual(['exclude', 'include', 'only']);
    for (const archived of ARCHIVED_FILTERS) {
      expect(ListTasksInput.parse({ archived }).archived).toBe(archived);
    }
    expect(ListTasksInput.parse({}).archived).toBeUndefined();
    expect(ListTasksInput.safeParse({ archived: 'all' }).success).toBe(false);
    expect(ListTasksInput.safeParse({ archived: true }).success).toBe(false);
  });

  it('filters lists by check-again day', () => {
    expect(CHECK_AGAIN_FILTERS).toEqual(['waiting', 'ready', 'set', 'none']);
    for (const checkAgain of CHECK_AGAIN_FILTERS) {
      expect(ListTasksInput.parse({ checkAgain }).checkAgain).toBe(checkAgain);
    }
    expect(ListTasksInput.safeParse({ checkAgain: 'today' }).success).toBe(false);
    // The list route reads both from the query string next to the other filters.
    expect(
      input(contract.tasks.list).parse({ project: 'pay', archived: 'only', checkAgain: 'ready' }),
    ).toMatchObject({
      project: ['PAY'],
      archived: 'only',
      checkAgain: 'ready',
    });
  });

  it('describes archived tasks and keeps the fields optional for older shapes', () => {
    const task = Task.parse(archivedTaskFixture);
    expect(task).toMatchObject({
      archivedAt: '2026-11-24T08:00:00.000Z',
      archivedBy: { name: 'Ana Ruiz' },
      closedAt: '2026-11-22T12:00:05.000Z',
      mergedOpen: { at: '2026-11-22T12:00:05.000Z', openCriteria: 1, openDoneItems: 0 },
      checkAgain: null,
    });
    const before = Task.parse(taskFixture);
    for (const field of [
      'workBranch',
      'pullRequests',
      'checkAgain',
      'closedAt',
      'archivedAt',
      'archivedBy',
      'mergedOpen',
    ]) {
      expect(before, field).not.toHaveProperty(field);
    }
  });

  it('flags a merged task only while an item is open', () => {
    expect(
      MergedOpen.safeParse({ at: '2026-11-22T12:00:00Z', openCriteria: 0, openDoneItems: 2 }).success,
    ).toBe(true);
    expect(
      issuePaths(MergedOpen.safeParse({ at: '2026-11-22T12:00:00Z', openCriteria: 0, openDoneItems: 0 })),
    ).toEqual(['openCriteria']);
  });
});

describe('pull requests on tasks', () => {
  it('lists the states and how a request is linked', () => {
    expect(PULL_REQUEST_STATES).toEqual(['open', 'draft', 'merged', 'closed']);
    expect(Object.values(PULL_REQUEST_STATE_LABELS)).toEqual(['Open', 'Draft', 'Merged', 'Closed']);
    expect(PULL_REQUEST_LINK_HOWS).toEqual(['hand', 'branch', 'description']);
  });

  it('accepts a web address as the request URL and leaves the rest to the server', () => {
    expect(PullRequestUrl.parse('  https://github.com/northwind/payments/pull/482  ')).toBe(
      'https://github.com/northwind/payments/pull/482',
    );
    expect(
      PullRequestUrl.safeParse('https://gitlab.example.com/g/s/r/-/merge_requests/12#note_3').success,
    ).toBe(true);
    expect(PullRequestUrl.safeParse('http://forgejo.local:3000/o/r/pulls/12').success).toBe(true);
    // Repository pages and other repositories pass here; core answers NOT_A_REQUEST or REQUEST_OTHER_REPOSITORY.
    expect(PullRequestUrl.safeParse('https://github.com/northwind/payments').success).toBe(true);
    for (const value of [
      '',
      '   ',
      'github.com/northwind/payments/pull/482',
      'git@github.com:northwind/payments.git',
      'ftp://example.com/pull/1',
      '#482',
    ]) {
      expect(PullRequestUrl.safeParse(value).success, value).toBe(false);
    }
    expect(PullRequestUrl.safeParse(`https://github.com/${'a'.repeat(500)}`).success).toBe(false);
    expect(PullRequestUrl.safeParse('#482').error?.issues[0]?.message).toBe(
      'Use the address of a pull or merge request, starting with https://',
    );
  });

  it('links on POST /tasks/{key}/pull-requests, with a dry run for the preview', () => {
    const link = input(contract.pullRequests.link);
    expect(link.parse({ key: 'pay-142', url: 'https://github.com/northwind/payments/pull/482' })).toEqual({
      key: 'PAY-142',
      url: 'https://github.com/northwind/payments/pull/482',
    });
    expect(
      LinkPullRequestInput.parse({
        key: 'BACK-7',
        project: 'pay',
        url: 'https://github.com/northwind/payments/pull/482',
        dryRun: true,
      }),
    ).toMatchObject({ key: 'BACK-7', project: 'PAY', dryRun: true });
    expect(issuePaths(link.safeParse({ key: 'PAY-142' }))).toEqual(['url']);
    expect(
      link.safeParse({ key: 'PAY-142', url: 'https://github.com/o/r/pull/1', dryRun: 'yes' }).success,
    ).toBe(false);
  });

  it('unlinks on DELETE /tasks/{key}/pull-requests/{number}, the number given as path text', () => {
    const unlink = input(contract.pullRequests.unlink);
    expect(unlink.parse({ key: 'pay-142', number: '482' })).toEqual({ key: 'PAY-142', number: 482 });
    expect(UnlinkPullRequestInput.parse({ key: 'PAY-142', number: 12 }).number).toBe(12);
    for (const number of ['0', '-3', '4.5', 'abc', '']) {
      expect(unlink.safeParse({ key: 'PAY-142', number }).success, number).toBe(false);
    }
  });

  it('describes linked requests on tasks and the newest on list rows', () => {
    const task = Task.parse(m7TaskFixture);
    expect(task.workBranch).toBe('feat/webhook-retries');
    expect(task.pullRequests?.map((request) => [request.number, request.state, request.how])).toEqual([
      [482, 'open', 'branch'],
      [479, 'draft', 'hand'],
    ]);
    expect(task.pullRequests?.[1]?.linkedBy?.name).toBe('Ana Ruiz');
    const row = TaskListItem.parse(m7ListItemFixture);
    expect(row).toMatchObject({
      pullRequest: { number: 482, state: 'open' },
      pullRequestCount: 2,
      checkAgain: { on: '2026-12-01' },
      archivedAt: null,
    });
    expect(TaskListItem.parse(taskListItemFixture)).not.toHaveProperty('pullRequest');
    expect(PullRequestLink.safeParse({ ...pullRequestLinkFixture, state: 'locked' }).success).toBe(false);
    expect(PullRequestLink.safeParse({ ...handLinkedPullRequestFixture, how: 'merge' }).success).toBe(false);
    expect(PullRequestLink.safeParse({ ...pullRequestLinkFixture, url: 'not a url' }).success).toBe(false);
  });
});

describe('repository settings', () => {
  it('reads the healthy and the no-repository states', () => {
    expect(RepositorySettings.parse(repositorySettingsFixture)).toMatchObject({
      provider: 'github',
      closeOnMerge: true,
      webhook: { secretSet: true, lastStatus: 'ok', coveredByBacklog: false },
      sync: { error: null },
    });
    expect(RepositorySettings.parse(noRepositorySettingsFixture)).toMatchObject({
      repository: null,
      webhook: null,
    });
    expect(
      RepositorySettings.safeParse({
        ...repositorySettingsFixture,
        webhook: { ...repositorySettingsFixture.webhook, lastStatus: 'late' },
      }).success,
    ).toBe(false);
    // The secret never travels in the settings.
    expect(RepositorySettings.parse({ ...repositorySettingsFixture, secret: 'whsec' })).not.toHaveProperty(
      'secret',
    );
    expect(
      RepositoryWebhookSecret.safeParse({ url: repositorySettingsFixture.webhook.url, secret: '' }).success,
    ).toBe(false);
  });

  it('takes the project key on every repository route', () => {
    for (const procedure of [
      contract.repository.get,
      contract.repository.newWebhookSecret,
      contract.repository.sync,
    ]) {
      expect(input(procedure).parse({ project: 'pay' })).toEqual({ project: 'PAY' });
      expect(input(procedure).safeParse({}).success).toBe(false);
    }
  });

  it('changes the connection and close on merge on PATCH, at least one of them', () => {
    const update = input(contract.repository.update);
    const connectionId = repositorySettingsFixture.connection.id;
    expect(update.parse({ project: 'pay', connectionId })).toEqual({ project: 'PAY', connectionId });
    expect(UpdateRepositoryInput.parse({ project: 'PAY', connectionId: null })).toEqual({
      project: 'PAY',
      connectionId: null,
    });
    expect(update.parse({ project: 'PAY', closeOnMerge: false })).toEqual({
      project: 'PAY',
      closeOnMerge: false,
    });
    expect(update.safeParse({ project: 'PAY' }).error?.issues[0]?.message).toBe(
      'Change at least one of connectionId or closeOnMerge',
    );
    expect(update.safeParse({ project: 'PAY', connectionId: 'github' }).success).toBe(false);
    expect(update.safeParse({ project: 'PAY', closeOnMerge: 'false' }).success).toBe(false);
  });
});

describe('activity cause and system actors', () => {
  it('records a request event or the archive job as the cause', () => {
    for (const event of ['opened', 'ready', 'reopened', 'merged', 'closed']) {
      expect(ActivityCause.safeParse({ ...gitActivityFixture.cause, event }).success, event).toBe(true);
    }
    expect(ActivityCause.safeParse({ ...gitActivityFixture.cause, event: 'edited' }).success).toBe(false);
    expect(ActivityCause.safeParse({ ...gitActivityFixture.cause, by: null }).success).toBe(true);
    expect(ActivityCause.safeParse({ ...gitActivityFixture.cause, provider: 'bitbucket' }).success).toBe(
      false,
    );
    expect(ActivityCause.parse({ kind: 'archive', afterDays: 14 })).toEqual({
      kind: 'archive',
      afterDays: 14,
    });
    expect(ActivityCause.safeParse({ kind: 'archive', afterDays: 0 }).success).toBe(false);
    expect(ActivityCause.safeParse({ kind: 'archive' }).success).toBe(false);
    expect(ActivityCause.safeParse({ kind: 'cycle' }).success).toBe(false);
  });

  it('names the host, Zamu or Backlog.md when no one acted', () => {
    expect(ActivitySystemActor.parse({ kind: 'git', provider: 'gitlab' })).toEqual({
      kind: 'git',
      provider: 'gitlab',
    });
    expect(ActivitySystemActor.safeParse({ kind: 'git' }).success).toBe(false);
    expect(ActivitySystemActor.parse({ kind: 'zamu' })).toEqual({ kind: 'zamu' });
    expect(ActivitySystemActor.parse({ kind: 'backlog' })).toEqual({ kind: 'backlog' });
    expect(ActivitySystemActor.safeParse({ kind: 'cron' }).success).toBe(false);
  });

  it('parses git, archive and link entries in the timeline', () => {
    expect(Activity.parse(gitActivityFixture)).toMatchObject({
      origin: 'git',
      cause: { kind: 'pull_request', event: 'opened', by: 'claude-dev' },
      system: { kind: 'git', provider: 'github' },
    });
    expect(Activity.parse(archiveActivityFixture)).toMatchObject({
      type: 'task.archived',
      cause: { kind: 'archive', afterDays: 14 },
      system: { kind: 'zamu' },
    });
    expect(Activity.parse(pullRequestLinkedActivityFixture).changes).toEqual([
      expect.objectContaining({
        field: 'pullRequest',
        from: null,
        to: expect.objectContaining({ number: 479, how: 'hand' }),
      }),
    ]);
    expect(TimelineItem.parse({ kind: 'activity', ...gitActivityFixture }).kind).toBe('activity');
  });

  it('adds the archive and link types and the work branch, check-again and request changes', () => {
    for (const type of [
      'task.archived',
      'task.unarchived',
      'task.pull_request_linked',
      'task.pull_request_unlinked',
    ]) {
      expect(ACTIVITY_TYPES).toContain(type);
      expect(TASK_ACTIVITY_TYPES).toContain(type);
    }
    const day = { on: '2026-12-01', reason: 'Bank reply' };
    for (const change of [
      { field: 'workBranch', from: null, to: 'feat/webhook-retries' },
      { field: 'checkAgain', from: null, to: day },
      { field: 'checkAgain', from: day, to: null },
      { field: 'pullRequest', from: { ...gitActivityFixture.cause, how: 'branch' }, to: null },
    ]) {
      expect(ActivityChange.safeParse(change).success, change.field).toBe(true);
    }
    expect(
      ActivityChange.safeParse({ field: 'checkAgain', from: null, to: { on: '2026-12-01' } }).success,
    ).toBe(false);
    expect(
      ActivityChange.safeParse({
        field: 'pullRequest',
        from: null,
        to: { ...gitActivityFixture.cause, how: 'merge' },
      }).success,
    ).toBe(false);
  });
});

describe('M7 Home', () => {
  it('adds the merged-with-open-items and check-again groups', () => {
    expect(HOME_GROUP_KEYS).toEqual(expect.arrayContaining(['mergedOpen', 'checkAgain']));
    const merged = HomeGroup.parse({ key: 'mergedOpen', total: 1, items: [mergedOpenHomeItemFixture] });
    expect(merged.items[0]?.reason).toMatchObject({
      kind: 'mergedOpen',
      openCriteria: 2,
      pullRequest: { number: 470 },
    });
    const ready = HomeGroup.parse({ key: 'checkAgain', total: 1, items: [checkAgainHomeItemFixture] });
    expect(ready.items[0]?.reason).toEqual({
      kind: 'checkAgain',
      on: '2026-11-26',
      reason: 'Bank answers by Thursday',
      daysAgo: 0,
    });
    expect(
      HomeItem.safeParse({
        ...checkAgainHomeItemFixture,
        reason: { ...checkAgainHomeItemFixture.reason, daysAgo: -1 },
      }).success,
    ).toBe(false);
    expect(
      HomeItem.safeParse({
        ...mergedOpenHomeItemFixture,
        reason: { ...mergedOpenHomeItemFixture.reason, pullRequest: null },
      }).success,
    ).toBe(true);
  });

  it('adds pills for the two states outside their own group', () => {
    expect(HomePill.parse({ kind: 'mergedOpen', openItems: 3 })).toEqual({
      kind: 'mergedOpen',
      openItems: 3,
    });
    expect(HomePill.safeParse({ kind: 'mergedOpen', openItems: 0 }).success).toBe(false);
    expect(HomePill.parse({ kind: 'checkAgain', on: '2026-11-20' })).toEqual({
      kind: 'checkAgain',
      on: '2026-11-20',
    });
  });

  it('counts both new groups in the sidebar total, missing ones as 0', () => {
    expect(
      HomeCounts.parse({
        review: 1,
        mergedOpen: 2,
        checkAgain: 3,
        mentions: 1,
        blocked: 0,
        overdue: 1,
        total: 8,
      }),
    ).toMatchObject({ total: 8 });
    expect(
      HomeCounts.safeParse({
        review: 1,
        mergedOpen: 2,
        checkAgain: 3,
        mentions: 1,
        blocked: 0,
        overdue: 1,
        total: 3,
      }).success,
    ).toBe(false);
    expect(HomeCounts.safeParse({ review: 1, mentions: 1, blocked: 0, overdue: 1, total: 3 }).success).toBe(
      true,
    );
  });
});

describe('M7 problems', () => {
  it('declares the archive and request codes with their statuses and titles', () => {
    expect({
      TASK_ARCHIVED: PROBLEM_STATUS.TASK_ARCHIVED,
      REQUEST_OTHER_REPOSITORY: PROBLEM_STATUS.REQUEST_OTHER_REPOSITORY,
      NOT_A_REQUEST: PROBLEM_STATUS.NOT_A_REQUEST,
      REQUEST_NOT_FOUND: PROBLEM_STATUS.REQUEST_NOT_FOUND,
    }).toEqual({
      TASK_ARCHIVED: 409,
      REQUEST_OTHER_REPOSITORY: 422,
      NOT_A_REQUEST: 422,
      REQUEST_NOT_FOUND: 404,
    });
    for (const code of [
      'TASK_ARCHIVED',
      'REQUEST_OTHER_REPOSITORY',
      'NOT_A_REQUEST',
      'REQUEST_NOT_FOUND',
    ] as const) {
      expect(apiErrors[code].status, code).toBe(PROBLEM_STATUS[code]);
      expect(PROBLEM_TITLES[code], code).toBeTruthy();
      expect(Problem.parse(problem(code, 'detail'))).toMatchObject({ code, status: PROBLEM_STATUS[code] });
    }
    expect(PROBLEM_TITLES.TASK_ARCHIVED).toBe('Task is archived');
  });

  it("carries the project's repository with REQUEST_OTHER_REPOSITORY through encode and decode", () => {
    const error = new ORPCError('REQUEST_OTHER_REPOSITORY', {
      status: 422,
      message: 'That request is in github.com/northwind/web. PAY links github.com/northwind/payments.',
      data: { repository: 'github.com/northwind/payments' },
    });
    const encoded = encodeProblem(error);
    expect(encoded).toMatchObject({
      code: 'REQUEST_OTHER_REPOSITORY',
      status: 422,
      repository: 'github.com/northwind/payments',
    });
    const decoded = decodeProblem(encoded);
    expect(decoded?.code).toBe('REQUEST_OTHER_REPOSITORY');
    expect(decoded?.data.repository).toBe('github.com/northwind/payments');
    expect(encodeProblem(new ORPCError('NOT_A_REQUEST', { status: 422 }))).not.toHaveProperty('repository');
  });
});

describe('M7 CLI output', () => {
  it('prints pr link and unlink as zamu.v1.pr.*', () => {
    const linked = cliOutput('pr.link', {
      task: 'PAY-142',
      pullRequest: handLinkedPullRequestFixture,
      dryRun: false,
    });
    expect(linked.schema).toBe('zamu.v1.pr.link');
    expect(linked.data.pullRequest).toMatchObject({
      number: 479,
      how: 'hand',
      linkedAt: '2026-11-20T09:05:00.000Z',
    });
    expect(parseCliOutput(JSON.parse(JSON.stringify(linked)), 'pr.link').data.dryRun).toBe(false);
    expect(cliOutput('pr.unlink', { task: 'PAY-142', number: 479 })).toEqual({
      schema: 'zamu.v1.pr.unlink',
      data: { task: 'PAY-142', number: 479 },
    });
    expect(() => cliOutput('pr.unlink', { task: 'PAY-142', number: 0 })).toThrow();
  });

  it('prints archive and restore as the tasks in order, and the task additions on show and update', () => {
    const archived = cliOutput('tasks.archive', {
      items: [{ ...m7ListItemFixture, archivedAt: archivedTaskFixture.archivedAt }],
    });
    expect(archived.schema).toBe('zamu.v1.tasks.archive');
    expect(archived.data.items[0]?.archivedAt).toBe('2026-11-24T08:00:00.000Z');
    expect(cliOutput('tasks.restore', { items: [m7ListItemFixture] }).data.items[0]?.archivedAt).toBeNull();
    const shown = cliOutput('tasks.show', { task: archivedTaskFixture, activity: [archiveActivityFixture] });
    expect(shown.data.task).toMatchObject({
      mergedOpen: { openCriteria: 1 },
      archivedBy: { name: 'Ana Ruiz' },
    });
    expect(shown.data.activity[0]?.cause).toEqual({ kind: 'archive', afterDays: 14 });
    expect(cliOutput('tasks.update', m7TaskFixture).data.checkAgain).toEqual(m7TaskFixture.checkAgain);
  });

  it('prints projects show with the archive days and the repository settings', () => {
    const shown = cliOutput('projects.show', {
      project: { ...projectFixture, archiveAfterDays: 14 },
      repository: repositorySettingsFixture,
    });
    expect(shown.data.project.archiveAfterDays).toBe(14);
    expect(shown.data.repository?.closeOnMerge).toBe(true);
    expect(
      cliOutput('projects.show', { project: projectFixture, repository: null }).data.repository,
    ).toBeNull();
  });

  it('queues archive, restore, check-again and request link writes', () => {
    expect(CLI_QUEUE_PROCEDURES).toEqual([
      'tasks.update',
      'comments.create',
      'tasks.archive',
      'tasks.restore',
      'pullRequests.link',
      'pullRequests.unlink',
    ]);
    const entry = CliQueueEntry.parse({
      id: 'q1',
      queuedAt: '2026-11-26T10:00:00Z',
      url: 'https://zamu.example.com',
      project: 'PAY',
      taskKey: 'PAY-142',
      procedure: 'tasks.archive',
      input: { keys: ['PAY-142', 'PAY-7'] },
      lastSeenStatus: null,
      summary: 'archive PAY-142, PAY-7',
    });
    expect(entry.procedure).toBe('tasks.archive');
  });
});

describe('Backlog.md export of archived tasks', () => {
  it('writes archived tasks under archive/tasks/', () => {
    expect(BACKLOG_EXPORT_PREFIXES).toEqual(['tasks/', 'archive/tasks/', 'completed/', 'milestones/']);
    expect(BacklogExportPath.safeParse('archive/tasks/pay-7 - Ledger table.md').success).toBe(true);
    expect(BacklogExportPath.safeParse('archive/milestones/m-1 - v1.md').success).toBe(false);
  });
});
