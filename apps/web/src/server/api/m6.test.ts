// M6 through /api/v1: the work record on POST and PATCH /tasks, the 409s (OPEN_ITEMS for agents,
// TASK_CHANGED for ifStatus, TASK_MIRRORED on mirrored tasks), notes and the timeline filter, the
// project's default done items, and the CLI's machine and branch headers. Data comes from the dev
// seed with the mirrored demo project BACK.
import { createAuth } from '@zamu/auth';
import { SOURCE_HEADERS } from '@zamu/contracts';
import { type CoreContext, createApiKey } from '@zamu/core';
import { recordingJobQueue, TEST_ENCRYPTION_KEY } from '@zamu/core/backlog/testing';
import { createTestDatabase, type TestDatabase } from '@zamu/db/test';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { requestSource } from '../context';
import { seedDevData } from '../seed';
import { createApiFetchHandler } from './index';

const ORIGIN = 'http://localhost:3000';
const SECRET = 'test-secret-test-secret-test-secret-0123';

let database: TestDatabase;
let handle: (request: Request) => Promise<Response>;
let cookie: string;
const keys = {} as { agent: string; adminRead: string };

type Auth = { cookie: string } | { key: string };

async function call(
  method: string,
  path: string,
  options: { auth: Auth; body?: unknown; headers?: Record<string, string> },
) {
  const headers: Record<string, string> = { ...options.headers };
  if ('cookie' in options.auth) headers.cookie = options.auth.cookie;
  else headers.authorization = `Bearer ${options.auth.key}`;
  const init: RequestInit = { method, headers };
  if (options.body !== undefined) {
    headers['content-type'] = 'application/json';
    init.body = JSON.stringify(options.body);
  }
  const response = await handle(new Request(`${ORIGIN}${path}`, init));
  const text = await response.text();
  // biome-ignore lint/suspicious/noExplicitAny: response bodies are checked field by field
  const body: any = text ? JSON.parse(text) : null;
  return { status: response.status, body };
}

const session = (): Auth => ({ cookie });
const agent = (): Auth => ({ key: keys.agent });
/** What the CLI sends with every request. */
const CLI_HEADERS = { [SOURCE_HEADERS.machine]: 'kaggia', [SOURCE_HEADERS.branch]: 'feat/refund-ledger' };

beforeAll(async () => {
  database = await createTestDatabase({ prefix: 'pm_web_m6' });
  database.pool.on('error', () => {});
  const auth = createAuth({ db: database.db, secret: SECRET, baseUrl: ORIGIN });
  const core: CoreContext = {
    db: database.db,
    auth,
    publicUrl: ORIGIN,
    encryptionKey: TEST_ENCRYPTION_KEY,
    jobs: recordingJobQueue(),
  };
  handle = createApiFetchHandler(core);
  const seeded = await seedDevData(core, { backlog: true });
  keys.agent = seeded.agentKey;
  const signIn = await auth.api.signInEmail({
    body: { email: seeded.admin.email, password: seeded.admin.password as string },
    returnHeaders: true,
  });
  cookie = signIn.headers
    .getSetCookie()
    .map((c) => c.split(';')[0])
    .join('; ');
  keys.adminRead = (
    await createApiKey(
      core,
      {
        userId: seeded.admin.id,
        kind: 'person',
        workspaceId: seeded.workspaceId,
        role: 'owner',
        onBehalfOfId: null,
      },
      { name: 'read only', scope: { projects: 'all', access: 'read' } },
    )
  ).key;
}, 60_000);

afterAll(async () => {
  await database?.drop();
});

describe('M6: the work record', () => {
  it('an agent creates a task with criteria and a plan, works it, and is refused at In review', async () => {
    const created = await call('POST', '/api/v1/tasks', {
      auth: agent(),
      headers: CLI_HEADERS,
      body: {
        project: 'PAY',
        title: 'Refund ledger',
        status: 'in_progress',
        criteria: ['Refunds post a ledger entry', 'Partial refunds keep the remainder'],
        doneItems: ['Tests pass'],
        plan: '1. Add the table',
      },
    });
    expect(created.status, JSON.stringify(created.body)).toBe(201);
    expect(created.body).toMatchObject({
      criteria: [
        { number: 1, text: 'Refunds post a ledger entry', state: 'open', locked: false },
        { number: 2, text: 'Partial refunds keep the remainder', state: 'open' },
      ],
      doneItems: [{ number: 1, text: 'Tests pass' }],
      plan: '1. Add the table',
      planMeta: { author: { kind: 'agent' }, origin: 'app' },
    });
    const key: string = created.body.key;

    const worked = await call('PATCH', `/api/v1/tasks/${key}`, {
      auth: agent(),
      headers: CLI_HEADERS,
      body: { checkCriteria: [1], finalSummary: 'Ledger entries post on every refund.' },
    });
    expect(worked.status).toBe(200);
    expect(worked.body.criteria[0].state).toBe('checked');

    const refused = await call('PATCH', `/api/v1/tasks/${key}`, {
      auth: agent(),
      headers: CLI_HEADERS,
      body: { status: 'in_review' },
    });
    expect(refused.status).toBe(409);
    expect(refused.body).toMatchObject({
      code: 'OPEN_ITEMS',
      title: 'Task has open items',
      openItems: [
        { kind: 'criterion', number: 2, text: 'Partial refunds keep the remainder' },
        { kind: 'done', number: 1, text: 'Tests pass' },
      ],
    });
    expect(refused.body.detail).toContain('criterion 2 and done item 1');

    const waived = await call('PATCH', `/api/v1/tasks/${key}`, {
      auth: agent(),
      body: {
        status: 'in_review',
        waiveCriteria: [{ number: 2, reason: 'Covered by the replay test' }],
        checkDoneItems: [1],
      },
    });
    expect(waived.status).toBe(200);
    expect(waived.body).toMatchObject({
      status: 'in_review',
      criteria: [{ state: 'checked' }, { state: 'waived', waivedReason: 'Covered by the replay test' }],
    });

    const listed = await call('GET', '/api/v1/tasks?project=PAY&q=Refund%20ledger', { auth: agent() });
    expect(listed.body.items[0]).toMatchObject({
      key,
      criteriaProgress: { settled: 2, open: 0, waived: 1, total: 2 },
      doneProgress: { settled: 1, open: 0, waived: 0, total: 1 },
      hasFinalSummary: true,
    });

    const history = await call('GET', `/api/v1/tasks/${key}/timeline?show=history`, { auth: agent() });
    expect(history.body.items.map((item: { source: unknown }) => item.source)).toEqual([
      { machine: 'kaggia', branch: 'feat/refund-ledger' },
      { machine: 'kaggia', branch: 'feat/refund-ledger' },
      null,
    ]);
  });

  it('a person moves a task with open items; the contract and core reject bad operations', async () => {
    const created = await call('POST', '/api/v1/tasks', {
      auth: session(),
      body: { project: 'PAY', title: 'Person finishes', criteria: ['Open one'] },
    });
    const key: string = created.body.key;
    const done = await call('PATCH', `/api/v1/tasks/${key}`, { auth: session(), body: { status: 'done' } });
    expect(done.status).toBe(200);
    expect(done.body.status).toBe('done');

    const missing = await call('PATCH', `/api/v1/tasks/${key}`, {
      auth: session(),
      body: { checkCriteria: [4] },
    });
    expect(missing.status).toBe(422);
    expect(missing.body).toMatchObject({
      code: 'UNPROCESSABLE_CONTENT',
      issues: [{ path: 'checkCriteria' }],
    });
    const noReason = await call('PATCH', `/api/v1/tasks/${key}`, {
      auth: session(),
      body: { waiveCriteria: [{ number: 1, reason: ' ' }] },
    });
    expect(noReason.status).toBe(400);
    const both = await call('PATCH', `/api/v1/tasks/${key}`, {
      auth: session(),
      body: { checkCriteria: [1], uncheckCriteria: [1] },
    });
    expect(both.status).toBe(400);
  });

  it('ifStatus: 409 TASK_CHANGED with the current task when the status moved', async () => {
    const created = await call('POST', '/api/v1/tasks', {
      auth: agent(),
      body: { project: 'PAY', title: 'Queued move' },
    });
    const key: string = created.body.key;
    await call('PATCH', `/api/v1/tasks/${key}`, { auth: session(), body: { status: 'done' } });
    const stale = await call('PATCH', `/api/v1/tasks/${key}`, {
      auth: agent(),
      body: { ifStatus: 'todo', status: 'in_progress' },
    });
    expect(stale.status).toBe(409);
    expect(stale.body).toMatchObject({ code: 'TASK_CHANGED', task: { key, status: 'done' } });
  });

  it('notes: POST kind note, the timeline filter and its counts', async () => {
    const created = await call('POST', '/api/v1/tasks', {
      auth: agent(),
      body: { project: 'PAY', title: 'Noted' },
    });
    const key: string = created.body.key;
    const note = await call('POST', `/api/v1/tasks/${key}/comments`, {
      auth: agent(),
      headers: CLI_HEADERS,
      body: { kind: 'note', body: 'Migration written and tested' },
    });
    expect(note.status).toBe(201);
    expect(note.body).toMatchObject({
      kind: 'note',
      source: { machine: 'kaggia', branch: 'feat/refund-ledger' },
    });
    await call('POST', `/api/v1/tasks/${key}/comments`, { auth: session(), body: { body: 'Looks good' } });

    const notes = await call('GET', `/api/v1/tasks/${key}/timeline?show=notes`, { auth: session() });
    expect(notes.status).toBe(200);
    expect(notes.body.items).toEqual([
      expect.objectContaining({ kind: 'note', body: 'Migration written and tested' }),
    ]);
    expect(notes.body.counts).toEqual({ all: 3, comments: 1, notes: 1, history: 1 });
    const all = await call('GET', `/api/v1/tasks/${key}/timeline`, { auth: session() });
    expect(all.body.items.map((item: { kind: string }) => item.kind)).toEqual([
      'activity',
      'note',
      'comment',
    ]);
    expect(
      (await call('GET', `/api/v1/tasks/${key}/timeline?show=everything`, { auth: session() })).status,
    ).toBe(400);
  });

  it('mirrored tasks: items read locked, work-record writes and notes get 409 TASK_MIRRORED', async () => {
    const task = await call('GET', '/api/v1/tasks/BACK-786', { auth: agent() });
    expect(task.status).toBe(200);
    expect(task.body.locked).toEqual(
      expect.arrayContaining(['criteria', 'doneItems', 'plan', 'finalSummary']),
    );
    for (const item of [...task.body.criteria, ...task.body.doneItems]) expect(item.locked).toBe(true);

    for (const body of [
      { addCriteria: ['New'] },
      { checkDoneItems: [1] },
      { plan: 'A new plan' },
      { finalSummary: 'Summary' },
    ]) {
      const result = await call('PATCH', '/api/v1/tasks/BACK-786', { auth: agent(), body });
      expect(result.status, JSON.stringify(body)).toBe(409);
      expect(result.body).toMatchObject({ code: 'TASK_MIRRORED', backlogId: 'BACK-786' });
    }
    const note = await call('POST', '/api/v1/tasks/BACK-786/comments', {
      auth: agent(),
      body: { kind: 'note', body: 'Retries added' },
    });
    expect(note.status).toBe(409);
    expect(note.body).toMatchObject({
      code: 'TASK_MIRRORED',
      field: 'notes',
      hint: 'backlog task edit 786 --append-notes "Retries added"',
    });
  });
});

describe('M6: default done items', () => {
  it('owners set them on PATCH /projects; agents and read-only keys get 403; new tasks start with them', async () => {
    const updated = await call('PATCH', '/api/v1/projects/WEB', {
      auth: session(),
      body: { defaultDoneItems: ['Tests pass', 'Docs updated'] },
    });
    expect(updated.status).toBe(200);
    expect(updated.body.defaultDoneItems).toEqual(['Tests pass', 'Docs updated']);
    for (const auth of [agent(), { key: keys.adminRead }]) {
      const refused = await call('PATCH', '/api/v1/projects/WEB', { auth, body: { defaultDoneItems: [] } });
      expect(refused.status).toBe(403);
    }
    const created = await call('POST', '/api/v1/tasks', {
      auth: agent(),
      body: { project: 'WEB', title: 'With defaults', doneItems: ['Changelog line'] },
    });
    expect(created.body.doneItems.map((item: { text: string }) => item.text)).toEqual([
      'Tests pass',
      'Docs updated',
      'Changelog line',
    ]);
    const skipped = await call('POST', '/api/v1/tasks', {
      auth: agent(),
      body: { project: 'WEB', title: 'Without defaults', skipDefaultDoneItems: true },
    });
    expect(skipped.body.doneItems).toEqual([]);
    const listed = await call('GET', '/api/v1/projects', { auth: agent() });
    expect(listed.body.items.find((p: { key: string }) => p.key === 'WEB').defaultDoneItems).toHaveLength(2);
  });
});

describe('M6: the source headers', () => {
  it('reads machine and branch, trimmed and cut, and drops empty or control-character values', () => {
    const headers = (values: Record<string, string>) => new Headers(values);
    expect(requestSource(headers({}))).toBeUndefined();
    expect(requestSource(headers({ [SOURCE_HEADERS.machine]: '  ' }))).toBeUndefined();
    expect(requestSource(headers({ [SOURCE_HEADERS.machine]: ' kaggia ' }))).toEqual({
      machine: 'kaggia',
      branch: null,
    });
    expect(
      requestSource(headers({ [SOURCE_HEADERS.machine]: 'a\tb', [SOURCE_HEADERS.branch]: 'main' })),
    ).toEqual({ machine: null, branch: 'main' });
    expect(requestSource(headers({ [SOURCE_HEADERS.branch]: 'b'.repeat(150) }))?.branch).toHaveLength(100);
  });

  it('a request without the headers records no source', async () => {
    const created = await call('POST', '/api/v1/tasks', {
      auth: session(),
      body: { project: 'PAY', title: 'Web' },
    });
    const activity = await call('GET', `/api/v1/tasks/${created.body.key}/activity`, { auth: session() });
    expect(activity.body.items[0].source).toBeNull();
  });
});
