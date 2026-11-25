import { describe, expect, it } from 'vitest';
import type { z } from 'zod';
import {
  CLI_BACKLOG_REFRESH_WAIT_MS,
  CLI_RESULT_NAMES,
  cliOutput,
  cliOutputSchemas,
  cliSchemaId,
  ProjectFile,
  parseCliOutput,
} from './cli';
import type { BacklogSourceStatus } from './entities';
import { problem } from './problem';
import {
  activityFixture,
  commentFixture,
  completedCycleFixture,
  cycleFixture,
  deletedCommentFixture,
  meFixture,
  milestoneWithProgressFixture,
  projectWithCountsFixture,
  taskFixture,
  taskListPageFixture,
  timelineFixture,
} from './testing/fixtures';

describe('CLI output', () => {
  it('names schemas zamu.v1.<name>', () => {
    expect(cliSchemaId('tasks.list')).toBe('zamu.v1.tasks.list');
    expect(CLI_RESULT_NAMES).toEqual([
      'login',
      'logout',
      'whoami',
      'projects.list',
      'projects.delete',
      'tasks.list',
      'tasks.show',
      'tasks.create',
      'tasks.update',
      'comments.list',
      'comments.add',
      'comments.edit',
      'comments.delete',
      'notes.add',
      'milestones.list',
      'milestones.create',
      'milestones.update',
      'cycles.list',
      'cycles.create',
      'cycles.current',
      'cycles.end',
      'link',
      'agents',
      'backlog.status',
      'backlog.refresh',
      'backlog.export',
      'instructions',
      'queue.list',
      'queue.drop',
      'queued',
      'dashboard',
      'labels.list',
      'labels.create',
      'labels.update',
      'labels.delete',
      'error',
    ]);
  });

  it('describes the M2.1 results: whoami project, link and agents', () => {
    const me = cliOutputSchemas.whoami.shape.data;
    expect(
      me.safeParse({ ...meFixture, project: { key: 'PAY', source: 'remote', from: 'git@x.io:t/p.git' } })
        .success,
    ).toBe(true);
    expect(me.safeParse({ ...meFixture, project: null }).success).toBe(true);
    expect(me.safeParse(meFixture).success, 'older zamu without the field').toBe(true);
    expect(me.safeParse({ ...meFixture, project: { key: 'PAY', source: 'guess', from: null } }).success).toBe(
      false,
    );

    const link = cliOutput('link', {
      project: 'PAY',
      target: 'server',
      action: 'linked',
      repository: 'gitlab.com/t/p',
      file: null,
    });
    expect(link.schema).toBe('zamu.v1.link');
    const agents = cliOutput('agents', {
      file: '/repo/AGENTS.md',
      action: 'created',
      project: null,
      block: '...',
    });
    expect(agents.data.action).toBe('created');
    expect(ProjectFile.safeParse({ project: 'pay' }).data).toEqual({ project: 'PAY' });
    expect(ProjectFile.safeParse({ project: 'PAY', url: 'https://zamu.example.com' }).success).toBe(false);
  });

  it('wraps data in the versioned envelope and serialises dates', () => {
    const out = cliOutput('tasks.create', taskFixture);
    expect(out.schema).toBe('zamu.v1.tasks.create');
    expect(out.data.key).toBe('PAY-142');
    expect(out.data.createdAt).toBe('2026-10-20T09:00:00.000Z');
  });

  it('refuses to print data the contract does not describe', () => {
    expect(() => cliOutput('tasks.update', { ...taskFixture, status: 'started' } as never)).toThrow();
  });

  it.each([
    ['login', { url: 'https://zamu.example.com', me: meFixture }],
    ['logout', { url: null }],
    ['whoami', meFixture],
    ['projects.list', { items: [projectWithCountsFixture] }],
    ['tasks.list', taskListPageFixture],
    ['tasks.show', { task: taskFixture, activity: [activityFixture] }],
    ['tasks.show', { task: taskFixture, activity: [activityFixture], timeline: timelineFixture }],
    ['tasks.create', taskFixture],
    ['tasks.update', taskFixture],
    ['comments.list', { items: [commentFixture, deletedCommentFixture] }],
    ['comments.add', commentFixture],
    ['comments.edit', commentFixture],
    ['comments.delete', deletedCommentFixture],
    ['milestones.list', { items: [milestoneWithProgressFixture] }],
    ['milestones.create', milestoneWithProgressFixture],
    ['milestones.update', milestoneWithProgressFixture],
    ['cycles.list', { items: [cycleFixture, completedCycleFixture] }],
    ['cycles.create', cycleFixture],
    ['cycles.current', cycleFixture],
    ['cycles.current', null],
    ['cycles.end', completedCycleFixture],
    [
      'dashboard',
      {
        scope: 'mine',
        generatedAt: new Date('2026-10-23T09:00:00.000Z'),
        groups: {
          review: { total: 0, items: [] },
          mentions: { total: 0, items: [] },
          stalled: { total: 0, items: [] },
          deadlines: { total: 0, items: [] },
        },
        projects: [],
        agents: [],
      },
    ],
    ['error', problem('FORBIDDEN', 'This key is read-only')],
  ] as const)('%s round-trips through JSON', (name, data) => {
    const printed = JSON.stringify(cliOutput(name, data as never));
    const parsed = parseCliOutput(JSON.parse(printed), name);
    expect(parsed).toEqual(JSON.parse(printed));
    expect(parseCliOutput(JSON.parse(printed)).schema).toBe(`zamu.v1.${name}`);
  });

  it('describes zamu backlog status and refresh', () => {
    const status = {
      id: '0190a1b2-c3d4-7e5f-8a9b-0c1d2e3f4ad3',
      project: { id: projectWithCountsFixture.id, key: 'PAY', name: 'Payments' },
      mode: 'mirror',
      state: 'healthy',
      repository: 'git@gitlab.com:reddevs/payments.git',
      defaultBranch: 'main',
      folder: 'backlog',
      folderOverride: null,
      prefix: 'BACK',
      connection: null,
      headCommit: 'a1b2c3d',
      lastRead: { at: new Date('2026-10-23T14:02:00Z'), trigger: 'cli', commit: 'a1b2c3d' },
      lastAttemptAt: new Date('2026-10-23T14:02:00Z'),
      lastTrigger: 'cli',
      lastError: null,
      nextPollAt: null,
      webhookLastAt: null,
      counts: { tasks: 3, open: 2, drafts: 0, archived: 1, subtasks: 1, milestones: 0, hidden: 0 },
      problems: { items: [], nextCursor: null, counts: { files: 0, values: 0 } },
      mappings: { status: [], priority: [], assignee: [] },
      config: null,
      createdBy: { id: meFixture.user.id, name: meFixture.user.name, kind: 'person' },
      createdAt: new Date('2026-10-23T14:00:00Z'),
      detachedAt: null,
      detachedBy: null,
      history: [],
    } satisfies z.input<typeof BacklogSourceStatus>;
    const shown = cliOutput('backlog.status', status);
    expect(shown.schema).toBe('zamu.v1.backlog.status');
    expect(shown.data.lastRead?.at).toBe('2026-10-23T14:02:00.000Z');
    expect(shown.data.lastRead?.commitUrl).toBeNull();

    const queued = cliOutput('backlog.refresh', {
      project: 'PAY',
      state: 'healthy',
      queued: true,
      lastAttemptAt: null,
      outcome: 'queued',
      status: null,
    });
    expect(parseCliOutput(JSON.parse(JSON.stringify(queued)), 'backlog.refresh').data.outcome).toBe('queued');
    const finished = cliOutput('backlog.refresh', {
      project: 'PAY',
      state: 'healthy',
      queued: false,
      lastAttemptAt: new Date('2026-10-23T14:02:00Z'),
      outcome: 'finished',
      status,
    });
    expect(finished.data.status?.counts.tasks).toBe(3);
    expect(() => cliOutput('backlog.refresh', { ...finished.data, outcome: 'running' } as never)).toThrow();
    expect(CLI_BACKLOG_REFRESH_WAIT_MS).toBe(300_000);
  });

  it('describes zamu projects delete with the deleted key', () => {
    expect(cliOutput('projects.delete', { deleted: 'PAY' })).toEqual({
      schema: 'zamu.v1.projects.delete',
      data: { deleted: 'PAY' },
    });
    expect(() => cliOutput('projects.delete', { deleted: 'pay' })).toThrow();
  });

  it('prints a TASK_MIRRORED error with its extensions', () => {
    const error = cliOutput(
      'error',
      problem('TASK_MIRRORED', 'status comes from Backlog.md', {
        field: 'status',
        file: 'backlog/tasks/back-786 - Retry.md',
        backlogId: 'BACK-786',
        hint: 'backlog task edit 786 -s "In Progress"',
      }),
    );
    expect(error.data).toMatchObject({
      status: 409,
      code: 'TASK_MIRRORED',
      field: 'status',
      backlogId: 'BACK-786',
    });
  });

  it('rejects unknown versions and mismatched names', () => {
    const v2 = { schema: 'zamu.v2.whoami', data: cliOutput('whoami', meFixture).data };
    expect(() => parseCliOutput(v2)).toThrow();
    expect(() => parseCliOutput(cliOutput('whoami', meFixture), 'tasks.show')).toThrow();
  });
});
