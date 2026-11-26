import { describe, expect, it } from 'vitest';
import { MAX_COMMENT_LENGTH } from './entities';
import {
  AcceptInvitationInput,
  AccountFields,
  BacklogFolder,
  CancelInvitationInput,
  CreateAgentInput,
  CreateApiKeyInput,
  CreateCommentInput,
  CreateCycleInput,
  CreateGitConnectionInput,
  CreateInvitationInput,
  CreateMilestoneInput,
  CreateProjectFromBacklogInput,
  CreateProjectInput,
  CreateTaskInput,
  DEFAULT_BACKLOG_PROBLEM_LIMIT,
  DEFAULT_DASHBOARD_SCOPE,
  DEFAULT_TASK_LIST_LIMIT,
  DeleteCommentInput,
  DeleteGitConnectionInput,
  DeleteMilestoneInput,
  DeleteProjectInput,
  DetachBacklogInput,
  DetectBacklogInput,
  DetectBacklogRepositoryInput,
  EndCycleInput,
  GetBacklogStatusInput,
  GetCycleInput,
  GetDashboardInput,
  GetMilestoneInput,
  GetTaskInput,
  GitHost,
  InviteFields,
  ListApiKeysInput,
  ListCommentsInput,
  ListCyclesInput,
  ListMilestonesInput,
  ListTasksInput,
  ListTaskTimelineInput,
  MIN_PASSWORD_LENGTH,
  PreviewBacklogInput,
  RefreshBacklogInput,
  RefreshBacklogNowInput,
  ReissueBacklogWebhookSecretInput,
  RemoveMemberInput,
  RevokeApiKeyInput,
  SetBacklogConnectionInput,
  SetBacklogFolderInput,
  SetupInput,
  SignInFields,
  StartBacklogInput,
  TestGitConnectionInput,
  UpdateBacklogMappingsInput,
  UpdateCommentInput,
  UpdateCycleInput,
  UpdateGitConnectionInput,
  UpdateMeInput,
  UpdateMilestoneInput,
  UpdateProjectInput,
  UpdateTaskInput,
  WorkspaceFields,
} from './inputs';
import { projectId } from './testing/fixtures';

describe('CreateProjectInput', () => {
  it('normalises the key and trims the name', () => {
    expect(CreateProjectInput.parse({ name: '  Payments ', key: 'pay' })).toEqual({
      name: 'Payments',
      key: 'PAY',
    });
  });

  it('keeps an optional description', () => {
    expect(CreateProjectInput.parse({ name: 'Web', key: 'WEB', description: 'Dashboard' }).description).toBe(
      'Dashboard',
    );
  });

  it('keeps an optional repository and rejects what is not a clone URL', () => {
    expect(
      CreateProjectInput.parse({ name: 'Web', key: 'WEB', repository: 'https://github.com/team/web' })
        .repository,
    ).toBe('https://github.com/team/web');
    expect(CreateProjectInput.parse({ name: 'Web', key: 'WEB', repository: '' }).repository).toBe('');
    expect(
      CreateProjectInput.safeParse({ name: 'Web', key: 'WEB', repository: '/srv/git/web' }).success,
    ).toBe(false);
  });

  it.each([
    [{ name: '', key: 'PAY' }],
    [{ name: '   ', key: 'PAY' }],
    [{ name: 'Payments', key: 'P' }],
    [{ name: 'Payments' }],
    [{ name: 'x'.repeat(101), key: 'PAY' }],
  ])('rejects %j', (input) => {
    expect(CreateProjectInput.safeParse(input).success).toBe(false);
  });
});

describe('UpdateProjectInput', () => {
  it('takes the current key and the changes', () => {
    expect(UpdateProjectInput.parse({ project: 'pay', key: 'pays', description: null })).toEqual({
      project: 'PAY',
      key: 'PAYS',
      description: null,
    });
  });

  it('requires at least one change', () => {
    const result = UpdateProjectInput.safeParse({ project: 'PAY' });
    expect(result.success).toBe(false);
    expect(result.error?.issues[0]?.message).toBe(
      'Change at least one of key, name, description, usesMilestones, usesCycles, repository, defaultDoneItems or archiveAfterDays',
    );
  });

  it('sets, keeps or clears the repository', () => {
    expect(UpdateProjectInput.parse({ project: 'PAY', repository: ' git@gitlab.com:team/pay.git ' })).toEqual(
      {
        project: 'PAY',
        repository: 'git@gitlab.com:team/pay.git',
      },
    );
    expect(UpdateProjectInput.parse({ project: 'PAY', repository: null }).repository).toBeNull();
    expect(UpdateProjectInput.parse({ project: 'PAY', repository: '' }).repository).toBe('');
    const bad = UpdateProjectInput.safeParse({ project: 'PAY', repository: 'team/pay' });
    expect(bad.error?.issues[0]).toMatchObject({
      path: ['repository'],
      message: 'Not a clone URL. Use the form https://host/owner/repo or git@host:owner/repo.',
    });
  });

  it('turns milestones and cycles on or off', () => {
    expect(UpdateProjectInput.parse({ project: 'PAY', usesCycles: false })).toEqual({
      project: 'PAY',
      usesCycles: false,
    });
    expect(UpdateProjectInput.parse({ project: 'PAY', usesMilestones: true }).usesMilestones).toBe(true);
    expect(UpdateProjectInput.safeParse({ project: 'PAY', usesCycles: 'no' }).success).toBe(false);
  });
});

describe('GetDashboardInput', () => {
  it('defaults to mine, also when the query string is empty or missing', () => {
    expect(DEFAULT_DASHBOARD_SCOPE).toBe('mine');
    expect(GetDashboardInput.parse({})).toEqual({ scope: 'mine' });
    expect(GetDashboardInput.parse(undefined)).toEqual({ scope: 'mine' });
  });

  it.each(['mine', 'everyone'] as const)('accepts scope %s', (scope) => {
    expect(GetDashboardInput.parse({ scope })).toEqual({ scope });
  });

  it.each(['team', 'Mine', '', 'all', ['mine']])('rejects scope %j', (scope) => {
    expect(GetDashboardInput.safeParse({ scope }).success).toBe(false);
  });
});

describe('ListTasksInput', () => {
  it('defaults the limit', () => {
    expect(ListTasksInput.parse({ project: 'PAY' })).toEqual({
      project: ['PAY'],
      order: 'list',
      limit: DEFAULT_TASK_LIST_LIMIT,
    });
    expect(DEFAULT_TASK_LIST_LIMIT).toBe(50);
  });

  it('coerces a numeric limit from a query string', () => {
    expect(ListTasksInput.parse({ project: 'PAY', limit: '10' }).limit).toBe(10);
  });

  it.each([0, 201, 1.5, 'ten', ''])('rejects limit %j', (limit) => {
    expect(ListTasksInput.safeParse({ project: 'PAY', limit }).success).toBe(false);
  });

  it('accepts one status or several, and de-duplicates', () => {
    expect(ListTasksInput.parse({ project: 'PAY', status: 'todo' }).status).toEqual(['todo']);
    expect(ListTasksInput.parse({ project: 'PAY', status: ['todo', 'done', 'todo'] }).status).toEqual([
      'todo',
      'done',
    ]);
    expect(ListTasksInput.parse({ project: 'PAY', priority: 'urgent' }).priority).toEqual(['urgent']);
  });

  it('rejects an empty or unknown status list', () => {
    expect(ListTasksInput.safeParse({ project: 'PAY', status: [] }).success).toBe(false);
    expect(ListTasksInput.safeParse({ project: 'PAY', status: ['started'] }).success).toBe(false);
    expect(ListTasksInput.safeParse({ project: 'PAY', priority: [5] }).success).toBe(false);
  });

  it.each(['me', 'agents', 'none', '0190a1b2-0000-7000-8000-00000000a0a0'])(
    'accepts assignee filter %s, as a list of one',
    (assignee) => {
      expect(ListTasksInput.parse({ project: 'PAY', assignee }).assignee).toEqual([assignee]);
    },
  );

  it('takes several assignees, milestones and cycles, de-duplicated', () => {
    const userId = '0190a1b2-0000-7000-8000-00000000a0a0';
    expect(ListTasksInput.parse({ assignee: ['me', 'none', userId, 'me'] }).assignee).toEqual([
      'me',
      'none',
      userId,
    ]);
    expect(ListTasksInput.parse({ milestone: ['none', projectId] }).milestone).toEqual(['none', projectId]);
    expect(ListTasksInput.parse({ cycle: ['12', 12, 'current', 'none'] }).cycle).toEqual([
      12,
      'current',
      'none',
    ]);
    expect(ListTasksInput.safeParse({ assignee: [] }).success).toBe(false);
    expect(ListTasksInput.safeParse({ cycle: ['12', 'previous'] }).success).toBe(false);
    expect(ListTasksInput.safeParse({ milestone: ['none', 'Webhooks v2'] }).success).toBe(false);
  });

  it('rejects an assignee that is neither me, agents, none nor a user id, and an over-long query', () => {
    expect(ListTasksInput.safeParse({ project: 'PAY', assignee: '' }).success).toBe(false);
    expect(ListTasksInput.safeParse({ project: 'PAY', assignee: 'ana' }).success).toBe(false);
    expect(ListTasksInput.safeParse({ project: 'PAY', q: 'x'.repeat(201) }).success).toBe(false);
  });

  it('trims the query and keeps the cursor', () => {
    expect(ListTasksInput.parse({ project: 'PAY', q: ' webhook ', cursor: 'abc' })).toMatchObject({
      q: 'webhook',
      cursor: 'abc',
    });
  });

  it('takes no project, one key or several, normalised and de-duplicated', () => {
    expect(ListTasksInput.parse({})).toEqual({ order: 'list', limit: DEFAULT_TASK_LIST_LIMIT });
    expect(ListTasksInput.parse({ project: ['pay', 'WEB', 'PAY'] }).project).toEqual(['PAY', 'WEB']);
    expect(ListTasksInput.safeParse({ project: [] }).success).toBe(false);
    expect(ListTasksInput.safeParse({ project: 'P' }).success).toBe(false);
  });

  it('filters by milestone id or none', () => {
    expect(ListTasksInput.parse({ milestone: 'none' }).milestone).toEqual(['none']);
    expect(ListTasksInput.parse({ milestone: projectId }).milestone).toEqual([projectId]);
    expect(ListTasksInput.safeParse({ milestone: 'Webhooks v2' }).success).toBe(false);
  });

  it.each([
    ['current', 'current'],
    ['next', 'next'],
    ['none', 'none'],
    ['12', 12],
    [12, 12],
  ])('filters by cycle %j', (cycle, parsed) => {
    expect(ListTasksInput.parse({ cycle }).cycle).toEqual([parsed]);
  });

  it.each(['0', '-1', '1.5', 'C12', 'previous', '', 0, 2.5, 99_999_999_999])(
    'rejects cycle filter %j',
    (cycle) => {
      const result = ListTasksInput.safeParse({ cycle });
      expect(result.success).toBe(false);
    },
  );

  it('explains a bad cycle filter', () => {
    const result = ListTasksInput.safeParse({ cycle: 'previous' });
    expect(result.error?.issues[0]?.message).toBe('Use a cycle number, current, next or none');
  });

  it('orders by list or board', () => {
    expect(ListTasksInput.parse({ order: 'board' }).order).toBe('board');
    expect(ListTasksInput.safeParse({ order: 'rank' }).success).toBe(false);
  });
});

describe('GetTaskInput', () => {
  it('normalises the key', () => {
    expect(GetTaskInput.parse({ key: 'pay-142' })).toEqual({ key: 'PAY-142' });
    expect(GetTaskInput.safeParse({ key: 'PAY-0' }).success).toBe(false);
  });
});

describe('CreateTaskInput', () => {
  it('defaults status to todo and priority to none', () => {
    expect(CreateTaskInput.parse({ project: 'pay', title: ' Fix rounding ' })).toEqual({
      project: 'PAY',
      title: 'Fix rounding',
      status: 'todo',
      priority: 'none',
    });
  });

  it('keeps explicit values, the assignee and the Markdown description untrimmed', () => {
    expect(
      CreateTaskInput.parse({
        project: 'PAY',
        title: 'x',
        description: '  - [ ] item\n',
        status: 'backlog',
        priority: 'urgent',
        assignee: 'me',
      }),
    ).toEqual({
      project: 'PAY',
      title: 'x',
      description: '  - [ ] item\n',
      status: 'backlog',
      priority: 'urgent',
      assignee: 'me',
    });
  });

  it.each([
    [{ project: 'PAY', title: '' }],
    [{ project: 'PAY', title: '   ' }],
    [{ project: 'PAY', title: 'x'.repeat(301) }],
    [{ project: 'PAY', title: 'x', status: 'started' }],
    [{ project: 'PAY', title: 'x', priority: 2 }],
    [{ project: 'PAY', title: 'x', assignee: 'ana' }],
    [{ title: 'x' }],
    [{ project: 'PAY', title: 'x', milestone: 'Webhooks v2' }],
    [{ project: 'PAY', title: 'x', cycle: 'none' }],
    [{ project: 'PAY', title: 'x', cycle: 0 }],
    [{ project: 'PAY', title: 'x', cycle: 'last' }],
  ])('rejects %j', (input) => {
    expect(CreateTaskInput.safeParse(input).success).toBe(false);
  });

  it('takes a milestone id and a cycle selector', () => {
    expect(
      CreateTaskInput.parse({ project: 'PAY', title: 'x', milestone: projectId, cycle: 'next' }),
    ).toMatchObject({
      milestone: projectId,
      cycle: 'next',
    });
    expect(CreateTaskInput.parse({ project: 'PAY', title: 'x', cycle: '13' }).cycle).toBe(13);
    expect(CreateTaskInput.parse({ project: 'PAY', title: 'x', milestone: null, cycle: null })).toMatchObject(
      {
        milestone: null,
        cycle: null,
      },
    );
  });
});

describe('UpdateTaskInput', () => {
  it('passes only the fields given', () => {
    expect(UpdateTaskInput.parse({ key: 'pay-1', status: 'done' })).toEqual({ key: 'PAY-1', status: 'done' });
  });

  it('null clears the assignee and the description', () => {
    expect(UpdateTaskInput.parse({ key: 'PAY-1', assignee: null, description: null })).toEqual({
      key: 'PAY-1',
      assignee: null,
      description: null,
    });
  });

  it('requires at least one change', () => {
    expect(UpdateTaskInput.safeParse({ key: 'PAY-1' }).success).toBe(false);
    expect(UpdateTaskInput.safeParse({ key: 'PAY-1', title: undefined }).success).toBe(false);
  });

  it('rejects an empty title', () => {
    expect(UpdateTaskInput.safeParse({ key: 'PAY-1', title: ' ' }).success).toBe(false);
  });

  it('does not apply create defaults', () => {
    expect(UpdateTaskInput.parse({ key: 'PAY-1', title: 'New' })).not.toHaveProperty('status');
  });

  it('sets or clears the milestone and the cycle', () => {
    expect(UpdateTaskInput.parse({ key: 'PAY-1', milestone: null, cycle: 'current' })).toEqual({
      key: 'PAY-1',
      milestone: null,
      cycle: 'current',
    });
    expect(UpdateTaskInput.parse({ key: 'PAY-1', cycle: null }).cycle).toBeNull();
    expect(UpdateTaskInput.safeParse({ key: 'PAY-1', cycle: 'none' }).success).toBe(false);
  });

  it('moves a card with a position and the last seen updatedAt', () => {
    expect(
      UpdateTaskInput.parse({
        key: 'PAY-140',
        status: 'in_review',
        position: { before: 'pay-131' },
        ifUpdatedAt: '2026-10-22T20:00:00.123+02:00',
      }),
    ).toEqual({
      key: 'PAY-140',
      status: 'in_review',
      position: { before: 'PAY-131' },
      ifUpdatedAt: '2026-10-22T18:00:00.123Z',
    });
    expect(UpdateTaskInput.parse({ key: 'PAY-140', position: { after: 'PAY-9' } }).position).toEqual({
      after: 'PAY-9',
    });
  });

  it.each([
    [{ before: 'PAY-1', after: 'PAY-2' }],
    [{}],
    [{ before: 'nope' }],
    [{ above: 'PAY-1' }],
    ['PAY-1'],
  ])('rejects position %j', (position) => {
    const result = UpdateTaskInput.safeParse({ key: 'PAY-140', position });
    expect(result.success).toBe(false);
  });

  it('explains a position with both before and after', () => {
    const result = UpdateTaskInput.safeParse({
      key: 'PAY-140',
      position: { before: 'PAY-1', after: 'PAY-2' },
    });
    expect(result.error?.issues[0]?.message).toBe('Give exactly one of before or after');
  });

  it('needs a change besides ifUpdatedAt, and a valid timestamp', () => {
    expect(UpdateTaskInput.safeParse({ key: 'PAY-1', ifUpdatedAt: '2026-10-22T18:00:00Z' }).success).toBe(
      false,
    );
    expect(UpdateTaskInput.safeParse({ key: 'PAY-1', title: 'x', ifUpdatedAt: 'yesterday' }).success).toBe(
      false,
    );
  });
});

describe('UpdateMeInput', () => {
  it.each(['system', 'light', 'dark'])('accepts theme %s', (theme) => {
    expect(UpdateMeInput.parse({ theme })).toEqual({ theme });
  });

  it.each([{}, { theme: 'sepia' }, { theme: 'Dark' }])('rejects %j', (input) => {
    expect(UpdateMeInput.safeParse(input).success).toBe(false);
  });
});

describe('comment inputs', () => {
  it('trims the body and normalises the task key', () => {
    expect(CreateCommentInput.parse({ key: 'pay-1', body: '  Done. @claude-dev \n' })).toEqual({
      key: 'PAY-1',
      body: 'Done. @claude-dev',
    });
  });

  it('takes a body of exactly 20,000 characters after trimming', () => {
    expect(
      CreateCommentInput.parse({ key: 'PAY-1', body: ` ${'x'.repeat(MAX_COMMENT_LENGTH)} ` }).body,
    ).toHaveLength(MAX_COMMENT_LENGTH);
  });

  it.each([
    ['empty', ''],
    ['only spaces', ' \n\t '],
    ['too long', 'x'.repeat(MAX_COMMENT_LENGTH + 1)],
  ])('rejects a body that is %s', (_label, body) => {
    expect(CreateCommentInput.safeParse({ key: 'PAY-1', body }).success).toBe(false);
    expect(UpdateCommentInput.safeParse({ id: projectId, body }).success).toBe(false);
  });

  it('edits, lists and deletes by id or key', () => {
    expect(UpdateCommentInput.parse({ id: projectId, body: 'New' })).toEqual({ id: projectId, body: 'New' });
    expect(DeleteCommentInput.parse({ id: projectId })).toEqual({ id: projectId });
    expect(DeleteCommentInput.safeParse({ id: 'c-1' }).success).toBe(false);
    expect(ListCommentsInput.parse({ key: 'pay-7' })).toEqual({ key: 'PAY-7' });
    expect(ListTaskTimelineInput.parse({ key: 'pay-7' })).toEqual({ key: 'PAY-7' });
    expect(CreateCommentInput.safeParse({ key: 'PAY', body: 'x' }).success).toBe(false);
  });
});

describe('milestone inputs', () => {
  it('creates with a trimmed name and optional description and target date', () => {
    expect(
      CreateMilestoneInput.parse({ project: 'pay', name: ' Webhooks v2 ', targetDate: '2026-11-14' }),
    ).toEqual({
      project: 'PAY',
      name: 'Webhooks v2',
      targetDate: '2026-11-14',
    });
  });

  it.each([
    [{ project: 'PAY', name: '' }],
    [{ project: 'PAY', name: 'x'.repeat(101) }],
    [{ project: 'PAY', name: 'x', targetDate: '2026-11-31' }],
    [{ project: 'PAY', name: 'x', targetDate: '14/11/2026' }],
    [{ project: 'PAY', name: 'x', targetDate: '2026-11-14T00:00:00Z' }],
    [{ name: 'x' }],
  ])('rejects create %j', (input) => {
    expect(CreateMilestoneInput.safeParse(input).success).toBe(false);
  });

  it('updates fields, clears with null and requires a change', () => {
    expect(UpdateMilestoneInput.parse({ id: projectId, targetDate: null, status: 'completed' })).toEqual({
      id: projectId,
      targetDate: null,
      status: 'completed',
    });
    expect(UpdateMilestoneInput.safeParse({ id: projectId }).success).toBe(false);
    expect(UpdateMilestoneInput.safeParse({ id: projectId, status: 'done' }).success).toBe(false);
  });

  it('lists by project with an optional status filter', () => {
    expect(ListMilestonesInput.parse({ project: 'pay', status: 'active' })).toEqual({
      project: 'PAY',
      status: ['active'],
    });
    expect(GetMilestoneInput.safeParse({ id: 'Webhooks v2' }).success).toBe(false);
    expect(DeleteMilestoneInput.parse({ id: projectId })).toEqual({ id: projectId });
  });
});

describe('cycle inputs', () => {
  it('creates with defaults left to core', () => {
    expect(CreateCycleInput.parse({ project: 'pay' })).toEqual({ project: 'PAY' });
    expect(
      CreateCycleInput.parse({
        project: 'PAY',
        name: ' Checkout ',
        startsOn: '2026-10-26',
        endsOn: '2026-11-08',
      }),
    ).toEqual({ project: 'PAY', name: 'Checkout', startsOn: '2026-10-26', endsOn: '2026-11-08' });
  });

  it('accepts one-day and 56-day cycles', () => {
    expect(
      CreateCycleInput.safeParse({ project: 'PAY', startsOn: '2026-10-26', endsOn: '2026-10-26' }).success,
    ).toBe(true);
    expect(
      CreateCycleInput.safeParse({ project: 'PAY', startsOn: '2026-11-09', endsOn: '2027-01-03' }).success,
    ).toBe(true);
  });

  it.each([
    [
      'ends before it starts',
      { startsOn: '2026-10-26', endsOn: '2026-10-25' },
      'End on or after the start date',
    ],
    ['lasts 57 days', { startsOn: '2026-11-09', endsOn: '2027-01-04' }, 'Keep cycles to 56 days or fewer'],
  ])('rejects a cycle that %s', (_label, dates, message) => {
    const result = CreateCycleInput.safeParse({ project: 'PAY', ...dates });
    expect(result.success).toBe(false);
    expect(result.error?.issues[0]).toMatchObject({ path: ['endsOn'], message });
    expect(UpdateCycleInput.safeParse({ project: 'PAY', number: 3, ...dates }).success).toBe(false);
  });

  it('addresses a cycle by number, current or next', () => {
    expect(GetCycleInput.parse({ project: 'pay', number: '12' })).toEqual({ project: 'PAY', number: 12 });
    expect(GetCycleInput.parse({ project: 'PAY', number: 'current' }).number).toBe('current');
    expect(GetCycleInput.safeParse({ project: 'PAY', number: 'none' }).success).toBe(false);
  });

  it('updates the name or dates and requires a change', () => {
    expect(UpdateCycleInput.parse({ project: 'PAY', number: 12, name: null })).toEqual({
      project: 'PAY',
      number: 12,
      name: null,
    });
    expect(UpdateCycleInput.safeParse({ project: 'PAY', number: 12 }).success).toBe(false);
  });

  it('ends with an optional target: a number or none', () => {
    expect(EndCycleInput.parse({ project: 'PAY', number: 'current' })).toEqual({
      project: 'PAY',
      number: 'current',
    });
    expect(EndCycleInput.parse({ project: 'PAY', number: 12, moveTo: '13' }).moveTo).toBe(13);
    expect(EndCycleInput.parse({ project: 'PAY', number: 12, moveTo: 'none' }).moveTo).toBe('none');
    expect(EndCycleInput.safeParse({ project: 'PAY', number: 12, moveTo: 'next' }).success).toBe(false);
    expect(EndCycleInput.safeParse({ project: 'PAY', number: 12, moveTo: 0 }).success).toBe(false);
  });

  it('lists by project with an optional state filter', () => {
    expect(ListCyclesInput.parse({ project: 'PAY', state: ['current', 'upcoming'] })).toEqual({
      project: 'PAY',
      state: ['current', 'upcoming'],
    });
    expect(ListCyclesInput.safeParse({ project: 'PAY', state: 'active' }).success).toBe(false);
  });
});

describe('settings inputs', () => {
  it('accepts an agent with a workspace-wide read-write key', () => {
    expect(
      CreateAgentInput.parse({
        name: 'docs-bot',
        responsibleUserId: '0190a1b2-0000-7000-8000-00000000a0a0',
        scope: { projects: 'all', access: 'write' },
      }),
    ).toEqual({
      name: 'docs-bot',
      responsibleUserId: '0190a1b2-0000-7000-8000-00000000a0a0',
      scope: { projects: 'all', access: 'write' },
    });
  });

  it.each(['Docs-Bot', 'docs bot', '-docs', 'docs-', 'docs--bot', 'd', 'x'.repeat(65)])(
    'rejects agent name %s',
    (name) => {
      expect(
        CreateAgentInput.safeParse({
          name,
          responsibleUserId: '0190a1b2-0000-7000-8000-00000000a0a0',
          scope: { projects: 'all', access: 'read' },
        }).success,
      ).toBe(false);
    },
  );

  it('scopes a key to selected projects, never to none', () => {
    const base = { name: 'CI runner', scope: { access: 'read' } };
    expect(
      CreateApiKeyInput.parse({ ...base, scope: { ...base.scope, projects: [projectId] } }).scope,
    ).toEqual({
      projects: [projectId],
      access: 'read',
    });
    expect(CreateApiKeyInput.safeParse({ ...base, scope: { ...base.scope, projects: [] } }).success).toBe(
      false,
    );
    expect(
      CreateApiKeyInput.safeParse({ ...base, scope: { ...base.scope, projects: ['PAY'] } }).success,
    ).toBe(false);
    expect(
      CreateApiKeyInput.safeParse({ name: 'x', scope: { projects: 'all', access: 'admin' } }).success,
    ).toBe(false);
  });

  it('revokes by id', () => {
    expect(RevokeApiKeyInput.parse({ id: '0190a1b2-0000-7000-8000-00000000e0e0' })).toEqual({
      id: '0190a1b2-0000-7000-8000-00000000e0e0',
    });
    expect(RevokeApiKeyInput.safeParse({ id: '' }).success).toBe(false);
  });

  it('defaults invitations to the member role', () => {
    expect(CreateInvitationInput.parse({ email: 'jo@example.com' })).toEqual({
      email: 'jo@example.com',
      role: 'member',
    });
    expect(CreateInvitationInput.safeParse({ email: 'jo' }).success).toBe(false);
    expect(CreateInvitationInput.safeParse({ email: 'jo@example.com', role: 'owner' }).success).toBe(false);
  });

  it('cancels invitations and removes members by id', () => {
    const id = '0190a1b2-0000-7000-8000-00000000e0e0';
    expect(CancelInvitationInput.parse({ id })).toEqual({ id });
    expect(CancelInvitationInput.safeParse({ id: 'nope' }).success).toBe(false);
    expect(RemoveMemberInput.parse({ userId: id })).toEqual({ userId: id });
    expect(RemoveMemberInput.safeParse({}).success).toBe(false);
  });

  it('lists your own keys unless told otherwise', () => {
    const id = '0190a1b2-0000-7000-8000-00000000e0e0';
    expect(ListApiKeysInput.parse({})).toEqual({ owner: 'me' });
    expect(ListApiKeysInput.parse({ owner: 'all' })).toEqual({ owner: 'all' });
    expect(ListApiKeysInput.parse({ owner: id })).toEqual({ owner: id });
    expect(ListApiKeysInput.safeParse({ owner: 'everyone' }).success).toBe(false);
  });
});

describe('sign-in, setup and invitation inputs', () => {
  it('trims emails and names, and checks the password length on new passwords only', () => {
    expect(SignInFields.parse({ email: ' ana@reddevs.io ', password: 'x' })).toEqual({
      email: 'ana@reddevs.io',
      password: 'x',
    });
    const password = 'a'.repeat(MIN_PASSWORD_LENGTH);
    expect(AccountFields.parse({ name: ' Ana ', email: 'ana@reddevs.io', password })).toEqual({
      name: 'Ana',
      email: 'ana@reddevs.io',
      password,
    });
    expect(AccountFields.safeParse({ name: 'Ana', email: 'ana@reddevs.io', password: 'short' }).success).toBe(
      false,
    );
    expect(WorkspaceFields.parse({ workspaceName: ' Reddevs ' })).toEqual({ workspaceName: 'Reddevs' });
    expect(InviteFields.safeParse({ name: 'Ana', password: 'a'.repeat(129) }).success).toBe(false);
  });

  it('takes both setup steps in one input and the invitation id on accept', () => {
    const password = 'a'.repeat(MIN_PASSWORD_LENGTH);
    expect(
      SetupInput.parse({ name: 'Ana', email: 'ana@reddevs.io', password, workspaceName: 'Reddevs' }),
    ).toEqual({ name: 'Ana', email: 'ana@reddevs.io', password, workspaceName: 'Reddevs' });
    const invitationId = '0190a1b2-0000-7000-8000-00000000e0e0';
    expect(AcceptInvitationInput.parse({ name: 'Jo', password, invitationId })).toEqual({
      name: 'Jo',
      password,
      invitationId,
    });
    expect(AcceptInvitationInput.safeParse({ name: 'Jo', password }).success).toBe(false);
  });
});

describe('DeleteProjectInput', () => {
  it('deletes only when the typed key matches the project', () => {
    expect(DeleteProjectInput.parse({ project: 'pay', confirmKey: ' pay ' })).toEqual({
      project: 'PAY',
      confirmKey: 'PAY',
    });
    const wrong = DeleteProjectInput.safeParse({ project: 'PAY', confirmKey: 'BILL' });
    expect(wrong.success).toBe(false);
    expect(wrong.error?.issues).toEqual([
      expect.objectContaining({ path: ['confirmKey'], message: 'Type the project key to confirm' }),
    ]);
    expect(DeleteProjectInput.safeParse({ project: 'PAY' }).success).toBe(false);
    expect(DeleteProjectInput.safeParse({ project: 'P', confirmKey: 'P' }).success).toBe(false);
  });
});

// ---------------------------------------------------------------------------
// M3
// ---------------------------------------------------------------------------

const connectionId = '0190a1b2-c3d4-7e5f-8a9b-0c1d2e3f4ac2';
const userId = '0190a1b2-0000-7000-8000-00000000c0c0';
const mappings = {
  status: [
    { from: 'To Do', to: 'todo', how: 'name' },
    { from: 'Blocked', to: 'todo', how: 'fallback' },
  ],
  priority: [{ from: 'high', to: 'high', how: 'name' }],
  assignee: [
    { from: '@claude', userId, how: 'name' },
    { from: '@francis', userId: null, how: 'manual' },
  ],
};

describe('task lookups by suffixed key or Backlog.md id', () => {
  it.each([
    ['pay-786', 'PAY-786'],
    ['PAY-786.1', 'PAY-786.1'],
    ['pay-786.1.2', 'PAY-786.1.2'],
    ['back-786.1', 'BACK-786.1'],
    ['BACK-007', 'BACK-7'],
    ['backlog-12', 'BACKLOG-12'],
  ])('GetTaskInput takes %s as %s', (key, canonical) => {
    expect(GetTaskInput.parse({ key })).toEqual({ key: canonical });
    expect(ListTaskTimelineInput.parse({ key }).key).toBe(canonical);
    expect(ListCommentsInput.parse({ key }).key).toBe(canonical);
  });

  it.each(['PAY-786.', 'PAY-0', 'PAY-786.0', 'BACK-0.1', 'PAY', '786'])('refuses %j', (key) => {
    expect(GetTaskInput.safeParse({ key }).success).toBe(false);
    expect(UpdateTaskInput.safeParse({ key, title: 'x' }).success).toBe(false);
    expect(CreateCommentInput.safeParse({ key, body: 'x' }).success).toBe(false);
  });

  it('narrows a Backlog.md id to a project when given', () => {
    expect(GetTaskInput.parse({ key: 'task-12', project: 'pay' })).toEqual({
      key: 'TASK-12',
      project: 'PAY',
    });
    expect(GetTaskInput.safeParse({ key: 'TASK-12', project: 'p' }).success).toBe(false);
    expect(UpdateTaskInput.parse({ key: 'back-786', project: 'PAY', cycle: 'current' })).toEqual({
      key: 'BACK-786',
      project: 'PAY',
      cycle: 'current',
    });
    // project alone is not a change.
    expect(UpdateTaskInput.safeParse({ key: 'BACK-786', project: 'PAY' }).success).toBe(false);
    expect(CreateCommentInput.parse({ key: 'back-786.1', body: ' hi ' })).toEqual({
      key: 'BACK-786.1',
      body: 'hi',
    });
  });

  it('places tasks before or after suffixed keys', () => {
    expect(UpdateTaskInput.parse({ key: 'PAY-786.1', position: { before: 'pay-786.2' } }).position).toEqual({
      before: 'PAY-786.2',
    });
  });
});

describe('ListTasksInput hidden filter', () => {
  it('takes only or include, and leaves hidden tasks out by default', () => {
    expect(ListTasksInput.parse({}).hidden).toBeUndefined();
    expect(ListTasksInput.parse({ hidden: 'only' }).hidden).toBe('only');
    expect(ListTasksInput.parse({ hidden: 'include' }).hidden).toBe('include');
    expect(ListTasksInput.safeParse({ hidden: 'exclude' }).success).toBe(false);
    expect(ListTasksInput.safeParse({ hidden: true }).success).toBe(false);
  });
});

describe('git connection inputs', () => {
  it.each([
    ['gitlab.com', 'gitlab.com'],
    [' GitLab.Example.COM ', 'gitlab.example.com'],
    ['https://git.home.example.com/', 'git.home.example.com'],
    ['http://localhost:3000', 'localhost:3000'],
    ['forgejo:3000', 'forgejo:3000'],
    ['10.0.0.5', '10.0.0.5'],
  ])('normalises the host %j', (input, host) => {
    expect(GitHost.parse(input)).toBe(host);
  });

  it.each([
    ['a path', 'gitlab.com/reddevs'],
    ['a user', 'ana@gitlab.com'],
    ['spaces', 'git lab.com'],
    ['empty', ''],
    ['port zero', 'gitlab.com:0'],
    ['port too long', 'gitlab.com:123456'],
    ['leading dash', '-gitlab.com'],
    ['query', 'gitlab.com?x=1'],
  ])('refuses a host with %s', (_label, input) => {
    expect(GitHost.safeParse(input).success).toBe(false);
  });

  it('creates a connection with a trimmed token and name', () => {
    expect(
      CreateGitConnectionInput.parse({
        provider: 'gitea',
        host: 'https://git.home.example.com',
        name: ' Forgejo at home ',
        token: ' 0123abcd \n',
      }),
    ).toEqual({
      provider: 'gitea',
      host: 'git.home.example.com',
      name: 'Forgejo at home',
      token: '0123abcd',
    });
  });

  it('refuses bad providers, names and tokens', () => {
    const base = { provider: 'github', host: 'github.com', name: 'GitHub', token: 'ghp_x' };
    expect(CreateGitConnectionInput.safeParse({ ...base, provider: 'bitbucket' }).success).toBe(false);
    expect(CreateGitConnectionInput.safeParse({ ...base, name: '  ' }).success).toBe(false);
    expect(CreateGitConnectionInput.safeParse({ ...base, name: 'x'.repeat(101) }).success).toBe(false);
    expect(CreateGitConnectionInput.safeParse({ ...base, token: '' }).success).toBe(false);
    expect(CreateGitConnectionInput.safeParse({ ...base, token: 'two words' }).success).toBe(false);
    expect(CreateGitConnectionInput.safeParse({ ...base, token: 'x'.repeat(4097) }).success).toBe(false);
  });

  it('updates the name or the token, at least one', () => {
    expect(UpdateGitConnectionInput.parse({ id: connectionId, token: 'glpat-new' })).toEqual({
      id: connectionId,
      token: 'glpat-new',
    });
    expect(UpdateGitConnectionInput.safeParse({ id: connectionId }).success).toBe(false);
    expect(UpdateGitConnectionInput.safeParse({ id: 'nope', name: 'x' }).success).toBe(false);
    expect(DeleteGitConnectionInput.safeParse({ id: connectionId }).success).toBe(true);
    expect(DeleteGitConnectionInput.safeParse({}).success).toBe(false);
  });

  it('tests an unsaved token, a saved connection, or a saved one with a new token', () => {
    expect(TestGitConnectionInput.parse({ provider: 'gitlab', host: 'GitLab.com', token: 't' })).toEqual({
      provider: 'gitlab',
      host: 'gitlab.com',
      token: 't',
    });
    expect(TestGitConnectionInput.parse({ id: connectionId })).toEqual({ id: connectionId });
    expect(TestGitConnectionInput.parse({ id: connectionId, token: 't2' })).toEqual({
      id: connectionId,
      token: 't2',
    });
    expect(TestGitConnectionInput.safeParse({ provider: 'gitlab', host: 'gitlab.com' }).success).toBe(false);
    expect(TestGitConnectionInput.safeParse({ id: connectionId, provider: 'gitlab' }).success).toBe(false);
    expect(TestGitConnectionInput.safeParse({}).success).toBe(false);
  });
});

describe('Backlog.md API inputs', () => {
  it('pages the problems of the status', () => {
    expect(GetBacklogStatusInput.parse({ project: 'pay' })).toEqual({
      project: 'PAY',
      problemsLimit: DEFAULT_BACKLOG_PROBLEM_LIMIT,
    });
    expect(
      GetBacklogStatusInput.parse({ project: 'PAY', problemsLimit: '10', problemsCursor: 'c1' }),
    ).toEqual({
      project: 'PAY',
      problemsLimit: 10,
      problemsCursor: 'c1',
    });
    expect(GetBacklogStatusInput.safeParse({ project: 'PAY', problemsLimit: 0 }).success).toBe(false);
    expect(GetBacklogStatusInput.safeParse({ project: 'PAY', problemsLimit: 201 }).success).toBe(false);
    expect(GetBacklogStatusInput.safeParse({ project: 'PAY', problemsCursor: '' }).success).toBe(false);
    expect(GetBacklogStatusInput.safeParse({}).success).toBe(false);
  });

  it('refreshes a project by key', () => {
    expect(RefreshBacklogInput.parse({ project: ' pay ' })).toEqual({ project: 'PAY' });
    expect(RefreshBacklogInput.safeParse({ project: 'p' }).success).toBe(false);
  });
});

describe('Backlog.md setup and settings inputs', () => {
  it.each([
    ['backlog', 'backlog'],
    ['.backlog/', '.backlog'],
    ['./docs/backlog//', 'docs/backlog'],
    [' tasks ', 'tasks'],
  ])('normalises the folder %j', (input, folder) => {
    expect(BacklogFolder.parse(input)).toBe(folder);
  });

  it.each([
    ['empty', ''],
    ['root slash', '/backlog'],
    ['parent', '../backlog'],
    ['parent inside', 'docs/../backlog'],
    ['dot part', 'docs/./backlog'],
    ['double slash', 'docs//backlog'],
    ['backslash', 'docs\\backlog'],
    ['too long', 'b'.repeat(201)],
  ])('refuses a folder with %s', (_label, input) => {
    expect(BacklogFolder.safeParse(input).success).toBe(false);
  });

  it('detects, previews and starts with the same source fields', () => {
    const detect = DetectBacklogInput.parse({ projectKey: 'pay', connectionId });
    expect(detect).toEqual({ projectKey: 'PAY', connectionId });
    expect(
      DetectBacklogInput.parse({ projectKey: 'PAY', connectionId, folderOverride: '.backlog/' })
        .folderOverride,
    ).toBe('.backlog');
    expect(PreviewBacklogInput.parse({ ...detect, mappings }).mappings).toEqual(mappings);
    expect(StartBacklogInput.parse({ ...detect, mappings, mode: 'import' }).mode).toBe('import');
    expect(StartBacklogInput.safeParse({ ...detect, mappings, mode: 'sync' }).success).toBe(false);
    expect(StartBacklogInput.safeParse({ ...detect, mode: 'mirror' }).success).toBe(false);
    expect(PreviewBacklogInput.safeParse({ ...detect, mappings: { status: [] } }).success).toBe(false);
    expect(DetectBacklogInput.safeParse({ projectKey: 'PAY', connectionId: 'abc' }).success).toBe(false);
  });

  it('refuses mappings with a duplicate value or an unknown target', () => {
    const duplicate = {
      ...mappings,
      priority: [...mappings.priority, { from: 'HIGH', to: 'urgent', how: 'manual' }],
    };
    expect(UpdateBacklogMappingsInput.safeParse({ projectKey: 'PAY', mappings: duplicate }).success).toBe(
      false,
    );
    const badStatus = { ...mappings, status: [{ from: 'Doing', to: 'doing', how: 'manual' }] };
    expect(UpdateBacklogMappingsInput.safeParse({ projectKey: 'PAY', mappings: badStatus }).success).toBe(
      false,
    );
    expect(UpdateBacklogMappingsInput.parse({ projectKey: 'pay', mappings }).projectKey).toBe('PAY');
  });

  it('detects a repository before the project exists', () => {
    const input = { repository: ' git@gitlab.com:reddevs/payments.git ', connectionId };
    expect(DetectBacklogRepositoryInput.parse(input)).toEqual({
      repository: 'git@gitlab.com:reddevs/payments.git',
      connectionId,
    });
    expect(
      DetectBacklogRepositoryInput.parse({
        repository: 'http://localhost:3300/zamu-admin/notes-sync',
        connectionId,
        folderOverride: './docs/backlog/',
      }).folderOverride,
    ).toBe('docs/backlog');
    expect(DetectBacklogRepositoryInput.safeParse({ ...input, repository: '' }).success).toBe(false);
    expect(DetectBacklogRepositoryInput.safeParse({ ...input, repository: 'payments' }).success).toBe(false);
    expect(DetectBacklogRepositoryInput.safeParse({ ...input, connectionId: 'abc' }).success).toBe(false);
  });

  it('creates a project from Backlog.md with a repository', () => {
    const input = {
      repository: 'git@gitlab.com:reddevs/payments.git',
      connectionId,
      name: ' Payments API ',
      key: 'back',
      mode: 'mirror',
    };
    expect(CreateProjectFromBacklogInput.parse(input)).toEqual({
      ...input,
      name: 'Payments API',
      key: 'BACK',
    });
    expect(CreateProjectFromBacklogInput.safeParse({ ...input, repository: '' }).success).toBe(false);
    expect(CreateProjectFromBacklogInput.safeParse({ ...input, repository: 'not a url' }).success).toBe(
      false,
    );
    expect(CreateProjectFromBacklogInput.safeParse({ ...input, key: 'BACKLOGMD' }).success).toBe(false);
  });

  it('sets or clears the folder and switches the connection', () => {
    expect(SetBacklogFolderInput.parse({ projectKey: 'PAY', folderOverride: null })).toEqual({
      projectKey: 'PAY',
      folderOverride: null,
    });
    expect(SetBacklogFolderInput.safeParse({ projectKey: 'PAY' }).success).toBe(false);
    expect(SetBacklogConnectionInput.parse({ projectKey: 'pay', connectionId }).projectKey).toBe('PAY');
    expect(RefreshBacklogNowInput.parse({ projectKey: 'pay' })).toEqual({ projectKey: 'PAY' });
  });

  it('detaches only when the typed key matches', () => {
    expect(DetachBacklogInput.parse({ projectKey: 'PAY', confirmKey: ' pay ' })).toEqual({
      projectKey: 'PAY',
      confirmKey: 'PAY',
    });
    const wrong = DetachBacklogInput.safeParse({ projectKey: 'PAY', confirmKey: 'PA' });
    expect(wrong.success).toBe(false);
    expect(wrong.error?.issues[0]?.path).toEqual(['confirmKey']);
    expect(DetachBacklogInput.safeParse({ projectKey: 'PAY' }).success).toBe(false);
  });

  it('reissues a webhook secret by project key', () => {
    expect(ReissueBacklogWebhookSecretInput.parse({ projectKey: ' pay ' })).toEqual({ projectKey: 'PAY' });
    expect(ReissueBacklogWebhookSecretInput.safeParse({}).success).toBe(false);
  });
});
