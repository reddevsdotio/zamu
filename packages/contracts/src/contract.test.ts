import { type AnyContractProcedure, isContractProcedure } from '@orpc/contract';
import { describe, expect, it } from 'vitest';
import type { z } from 'zod';
import { API_PREFIX, apiErrors, contract } from './contract';
import { taskFixture } from './testing/fixtures';

function procedures(router: unknown, path: string[] = []): [string, AnyContractProcedure][] {
  if (isContractProcedure(router)) return [[path.join('.'), router]];
  return Object.entries(router as Record<string, unknown>).flatMap(([key, value]) =>
    procedures(value, [...path, key]),
  );
}

const all = procedures(contract);

describe('contract', () => {
  it('exposes exactly the M1 to M8 routes under /api/v1', () => {
    const routes = Object.fromEntries(
      all.map(([name, procedure]) => {
        const { method, path } = procedure['~orpc'].route;
        return [name, `${method} ${path}`];
      }),
    );
    expect(routes).toEqual({
      'me.get': 'GET /api/v1/me',
      'me.update': 'PATCH /api/v1/me',
      'projects.list': 'GET /api/v1/projects',
      'projects.create': 'POST /api/v1/projects',
      'projects.update': 'PATCH /api/v1/projects/{project}',
      'projects.delete': 'DELETE /api/v1/projects/{project}',
      'projects.archivePreview': 'GET /api/v1/projects/{project}/archive-preview',
      'tasks.list': 'GET /api/v1/tasks',
      'tasks.get': 'GET /api/v1/tasks/{key}',
      'tasks.create': 'POST /api/v1/tasks',
      'tasks.update': 'PATCH /api/v1/tasks/{key}',
      'tasks.bulkUpdate': 'POST /api/v1/tasks/bulk',
      'tasks.archive': 'POST /api/v1/tasks/archive',
      'tasks.restore': 'POST /api/v1/tasks/restore',
      'tasks.activity': 'GET /api/v1/tasks/{key}/activity',
      'tasks.timeline': 'GET /api/v1/tasks/{key}/timeline',
      'pullRequests.link': 'POST /api/v1/tasks/{key}/pull-requests',
      'pullRequests.unlink': 'DELETE /api/v1/tasks/{key}/pull-requests/{number}',
      'comments.list': 'GET /api/v1/tasks/{key}/comments',
      'comments.create': 'POST /api/v1/tasks/{key}/comments',
      'comments.update': 'PATCH /api/v1/comments/{id}',
      'comments.delete': 'DELETE /api/v1/comments/{id}',
      'milestones.list': 'GET /api/v1/projects/{project}/milestones',
      'milestones.create': 'POST /api/v1/projects/{project}/milestones',
      'milestones.get': 'GET /api/v1/milestones/{id}',
      'milestones.plan': 'GET /api/v1/milestones/{id}/plan',
      'milestones.update': 'PATCH /api/v1/milestones/{id}',
      'milestones.delete': 'DELETE /api/v1/milestones/{id}',
      'waves.create': 'POST /api/v1/milestones/{milestone}/waves',
      'waves.update': 'PATCH /api/v1/waves/{id}',
      'waves.delete': 'DELETE /api/v1/waves/{id}',
      'waves.putTasks': 'POST /api/v1/milestones/{milestone}/wave-tasks',
      'waves.recordGate': 'POST /api/v1/waves/{id}/gate',
      'cycles.list': 'GET /api/v1/projects/{project}/cycles',
      'cycles.create': 'POST /api/v1/projects/{project}/cycles',
      'cycles.get': 'GET /api/v1/cycles/{project}/{number}',
      'cycles.update': 'PATCH /api/v1/cycles/{project}/{number}',
      'cycles.end': 'POST /api/v1/cycles/{project}/{number}/end',
      'labels.list': 'GET /api/v1/projects/{project}/labels',
      'labels.create': 'POST /api/v1/projects/{project}/labels',
      'labels.update': 'PATCH /api/v1/projects/{project}/labels/{id}',
      'labels.delete': 'DELETE /api/v1/projects/{project}/labels/{id}',
      'backlog.status': 'GET /api/v1/projects/{project}/backlog',
      'backlog.refresh': 'POST /api/v1/projects/{project}/backlog/refresh',
      'backlog.export': 'GET /api/v1/projects/{project}/backlog/export',
      'repository.get': 'GET /api/v1/projects/{project}/repository',
      'repository.update': 'PATCH /api/v1/projects/{project}/repository',
      'repository.newWebhookSecret': 'POST /api/v1/projects/{project}/repository/webhook-secret',
      'repository.sync': 'POST /api/v1/projects/{project}/repository/sync',
      'dashboard.get': 'GET /api/v1/dashboard',
      'dashboard.counts': 'GET /api/v1/dashboard/counts',
      'home.get': 'GET /api/v1/home',
      'home.counts': 'GET /api/v1/home/counts',
      'members.list': 'GET /api/v1/members',
    });
    expect(API_PREFIX).toBe('/api/v1');
  });

  it.each(all)('%s has an output schema, a summary, a tag and the shared errors', (_name, procedure) => {
    const def = procedure['~orpc'];
    expect(def.outputSchema).toBeDefined();
    expect(def.route.summary).toBeTruthy();
    expect(def.route.tags?.length).toBe(1);
    expect(Object.keys(def.errorMap)).toEqual(
      expect.arrayContaining([
        'UNAUTHORIZED',
        'FORBIDDEN',
        'NOT_FOUND',
        'CONFLICT',
        'TASK_CHANGED',
        'UNPROCESSABLE_CONTENT',
        'TASK_MIRRORED',
        'MILESTONE_MIRRORED',
        'PROJECT_MIRRORED',
        'PROJECT_NOT_EMPTY',
        'BACKLOG_PAUSED',
        'BACKLOG_DETACHED',
        'LABEL_EXISTS',
        'LABEL_MIRRORED',
        'DEPENDENCY_LOOP',
        'SUBTASK_DEPTH',
        'NOT_SAME_PROJECT',
        'TASK_ARCHIVED',
        'REQUEST_OTHER_REPOSITORY',
        'NOT_A_REQUEST',
        'REQUEST_NOT_FOUND',
        'WAVE_LOCKED',
        'GATE_TASKS_OPEN',
      ]),
    );
  });

  it('declares every path parameter as a required input field', () => {
    for (const [name, procedure] of all) {
      const def = procedure['~orpc'];
      const params = [...(def.route.path ?? '').matchAll(/\{(\w+)\}/g)].map((match) => match[1] as string);
      if (params.length === 0) continue;
      expect(def.inputSchema, name).toBeDefined();
      const result = (def.inputSchema as z.ZodType).safeParse({});
      const missing = (result.error?.issues ?? []).map((issue) => String(issue.path[0]));
      for (const param of params) expect(missing, `${name} ${param}`).toContain(param);
    }
  });

  it('returns 201 from creates, 202 from refreshes and syncs, 204 from deletes and unlinks, else 200', () => {
    const created = all
      .filter(([, procedure]) => procedure['~orpc'].route.successStatus === 201)
      .map(([name]) => name);
    expect(created.sort()).toEqual([
      'comments.create',
      'cycles.create',
      'labels.create',
      'milestones.create',
      'projects.create',
      'tasks.create',
      'waves.create',
    ]);
    const noContent = all
      .filter(([, procedure]) => procedure['~orpc'].route.successStatus === 204)
      .map(([name]) => name);
    expect(noContent.sort()).toEqual([
      'labels.delete',
      'milestones.delete',
      'projects.delete',
      'pullRequests.unlink',
      'waves.delete',
    ]);
    const accepted = all
      .filter(([, procedure]) => procedure['~orpc'].route.successStatus === 202)
      .map(([name]) => name);
    expect(accepted.sort()).toEqual(['backlog.refresh', 'repository.sync']);
    // Comment deletes are soft and return the comment, so the CLI can print it.
    expect(contract.comments.delete['~orpc'].route.successStatus).toBeUndefined();
  });

  it('declares TASK_CHANGED as a 409 that carries the current task', () => {
    const { TASK_CHANGED } = apiErrors;
    expect(TASK_CHANGED.status).toBe(409);
    expect(TASK_CHANGED.data.safeParse({ requestId: 'r1' }).success).toBe(false);
    const task = taskFixture;
    const parsed = TASK_CHANGED.data.parse({ requestId: 'r1', task });
    expect(parsed.task.key).toBe(task.key);
  });

  it('declares the M3 problem codes as 409s that carry the mirrored extensions', () => {
    for (const code of [
      'TASK_MIRRORED',
      'MILESTONE_MIRRORED',
      'PROJECT_MIRRORED',
      'PROJECT_NOT_EMPTY',
      'BACKLOG_PAUSED',
      'BACKLOG_DETACHED',
    ] as const) {
      expect(apiErrors[code].status, code).toBe(409);
    }
    const data = apiErrors.TASK_MIRRORED.data.parse({
      requestId: 'r1',
      field: 'status',
      file: 'backlog/tasks/back-786 - Mirror.md',
      backlogId: 'BACK-786',
      hint: 'backlog task edit 786 -s "Done"',
    });
    expect(data).toMatchObject({ field: 'status', backlogId: 'BACK-786' });
  });

  it('accepts suffixed keys and Backlog.md ids on task routes and pages backlog problems', () => {
    const get = contract.tasks.get['~orpc'].inputSchema as z.ZodType;
    expect(get.parse({ key: 'pay-786.1' })).toMatchObject({ key: 'PAY-786.1' });
    expect(get.parse({ key: 'back-007.01' })).toMatchObject({ key: 'BACK-7.1' });
    expect(get.safeParse({ key: 'PAY-786.' }).success).toBe(false);
    const status = contract.backlog.status['~orpc'].inputSchema as z.ZodType;
    expect(status.parse({ project: 'back', problemsLimit: '10' })).toEqual({
      project: 'BACK',
      problemsLimit: 10,
    });
    expect(status.parse({ project: 'BACK' })).toMatchObject({ problemsLimit: 50 });
  });

  it('deletes a project only when confirmKey repeats the path key (JSON body)', () => {
    const del = contract.projects.delete['~orpc'];
    expect(del.route.description).toContain('confirmKey in the JSON body');
    const input = del.inputSchema as z.ZodType;
    expect(input.parse({ project: 'pay', confirmKey: ' pay ' })).toEqual({
      project: 'PAY',
      confirmKey: 'PAY',
    });
    const wrong = input.safeParse({ project: 'PAY', confirmKey: 'PA' });
    expect(wrong.error?.issues).toEqual([
      expect.objectContaining({ path: ['confirmKey'], message: 'Type the project key to confirm' }),
    ]);
    expect(input.safeParse({ project: 'PAY' }).success).toBe(false);
  });

  it('accepts cycle selectors and task keys as path parameters (text in URLs)', () => {
    const get = contract.cycles.get['~orpc'].inputSchema as z.ZodType;
    expect(get.parse({ project: 'pay', number: '12' })).toEqual({ project: 'PAY', number: 12 });
    expect(get.parse({ project: 'PAY', number: 'current' })).toEqual({ project: 'PAY', number: 'current' });
    expect(get.safeParse({ project: 'PAY', number: 'last' }).success).toBe(false);
    const end = contract.cycles.end['~orpc'].inputSchema as z.ZodType;
    expect(end.parse({ project: 'PAY', number: '3', moveTo: 'none' })).toMatchObject({ moveTo: 'none' });
  });

  it('reads the dashboard scope from the query, mine when omitted', () => {
    const get = contract.dashboard.get['~orpc'];
    expect(get.route.method).toBe('GET');
    const input = get.inputSchema as z.ZodType;
    expect(input.parse(undefined)).toEqual({ scope: 'mine' });
    expect(input.parse({})).toEqual({ scope: 'mine' });
    expect(input.parse({ scope: 'everyone' })).toEqual({ scope: 'everyone' });
    expect(input.safeParse({ scope: 'all' }).success).toBe(false);
    expect(contract.dashboard.counts['~orpc'].inputSchema).toBeUndefined();
  });
});
