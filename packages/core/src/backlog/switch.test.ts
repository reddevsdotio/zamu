// M6: the switch of a mirrored project to Zamu on Postgres: the check (open requests, a host that
// cannot answer, who may ask), the confirm with the typed key, and the project afterwards.
import { schema } from '@zamu/db';
import { GitRateLimited, GitUnauthorized, GitUnreachable } from '@zamu/git-providers';
import { asc, eq } from 'drizzle-orm';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { createComment } from '../comments';
import { BacklogDetached, Forbidden, Invalid } from '../errors';
import { isMirrored } from '../internal';
import { createTask, getTask, updateTask } from '../tasks';
import { createWorld, type TestContext, testContext, type World } from '../testing/fixtures';
import { refreshBacklogSource } from './refresh';
import { checkBacklogSwitch, switchBacklogToZamu } from './switch';
import {
  configFile,
  createMirror,
  FakeProvider,
  FakeRepository,
  mirrorContext,
  NO_MAPPINGS,
  projectActivity,
  taskFile,
  taskPath,
  tasksByKey,
} from './testing';

const FOLDER = 'backlog';
const NOW = new Date('2031-03-04T05:06:07.000Z');

function repoWithCriteria() {
  const task = taskFile({ id: 'BACK-4', title: 'Ledger' }).concat(
    '\n## Acceptance Criteria\n<!-- AC:BEGIN -->\n- [ ] #1 Entries balance\n- [x] #2 Refunds post\n<!-- AC:END -->\n',
  );
  return new FakeRepository(`reddevs/switch-${crypto.randomUUID().slice(0, 8)}`, {
    [`${FOLDER}/config.yml`]: configFile(),
    [taskPath(FOLDER, 'back-4', 'Ledger')]: task,
    [taskPath(FOLDER, 'back-9', 'Payouts')]: taskFile({ id: 'BACK-9', title: 'Payouts' }),
  });
}

describe('switch to Zamu', () => {
  let base: TestContext;
  let world: World;
  let provider: FakeProvider;
  let ctx: ReturnType<typeof mirrorContext>;

  beforeAll(async () => {
    base = testContext();
    world = await createWorld(base.db);
    provider = new FakeProvider([]);
    ctx = { ...mirrorContext(base, provider), now: () => NOW };
  });
  afterAll(async () => {
    await base?.close();
  });
  beforeEach(() => {
    provider.failWith = null;
    provider.failAlways = false;
  });

  async function mirror() {
    const repo = provider.add(repoWithCriteria());
    const created = await createMirror(ctx, world, repo, { mappings: NO_MAPPINGS });
    return { ...created, repo };
  }

  it('the check lists open requests that touch the Backlog.md folder', async () => {
    const { key, repo } = await mirror();
    const request = (number: number, files: string[]) => ({
      number,
      title: `Request ${number}`,
      author: 'ana-dev',
      headBranch: `branch-${number}`,
      webUrl: `https://gitlab.com/${repo.path}/-/merge_requests/${number}`,
      files,
    });
    repo.openRequests = [request(12, ['backlog/tasks/back-4 - Ledger.md']), request(11, ['src/app.ts'])];
    provider.resetCalls();
    const check = await checkBacklogSwitch(ctx, world.ownerActor, { projectKey: key });
    expect(check).toEqual({
      ok: true,
      project: key,
      repository: `gitlab.com/${repo.path}`,
      folder: 'backlog',
      requests: [
        {
          number: 12,
          title: 'Request 12',
          author: 'ana-dev',
          headBranch: 'branch-12',
          webUrl: `https://gitlab.com/${repo.path}/-/merge_requests/12`,
        },
      ],
      truncated: false,
      listUrl: `https://gitlab.com/${repo.path}/-/merge_requests`,
      checkedAt: NOW.toISOString(),
    });
    expect(provider.calls.listOpenRequests).toBe(1);

    repo.openRequests = [];
    repo.openRequestsTruncated = true;
    await expect(checkBacklogSwitch(ctx, world.ownerActor, { projectKey: key })).resolves.toMatchObject({
      ok: true,
      requests: [],
      truncated: true,
    });
  });

  it('the check says why the host could not answer, and leaves the mirror running', async () => {
    const { key, sourceId } = await mirror();
    provider.failWith = new GitUnreachable('down', { code: 'timeout' });
    await expect(checkBacklogSwitch(ctx, world.ownerActor, { projectKey: key })).resolves.toEqual({
      ok: false,
      project: key,
      reason: 'unreachable',
      message: 'gitlab.com did not answer in time.',
      checkedAt: NOW.toISOString(),
    });
    provider.failWith = new GitUnauthorized('no', { status: 403, code: 'forbidden' });
    await expect(checkBacklogSwitch(ctx, world.ownerActor, { projectKey: key })).resolves.toMatchObject({
      ok: false,
      reason: 'rejected',
      message:
        "gitlab.com refused to list merge requests with this connection's token. It needs the read_api scope.",
    });
    provider.failWith = new GitRateLimited('slow', 60);
    await expect(checkBacklogSwitch(ctx, world.ownerActor, { projectKey: key })).resolves.toMatchObject({
      ok: false,
      reason: 'rate_limited',
    });
    const [source] = await base.db
      .select({ state: schema.backlogSource.state })
      .from(schema.backlogSource)
      .where(eq(schema.backlogSource.id, sourceId));
    expect(source?.state).not.toBe('paused');
  });

  it('only owners and admins may check or switch; a wrong key is refused', async () => {
    const { key, project } = await mirror();
    await expect(checkBacklogSwitch(ctx, world.memberActor, { projectKey: key })).rejects.toBeInstanceOf(
      Forbidden,
    );
    await expect(checkBacklogSwitch(ctx, world.agentActor, { projectKey: key })).rejects.toBeInstanceOf(
      Forbidden,
    );
    await expect(
      switchBacklogToZamu(ctx, world.memberActor, { projectKey: key, confirmKey: key }),
    ).rejects.toBeInstanceOf(Forbidden);
    const wrong = switchBacklogToZamu(ctx, world.ownerActor, { projectKey: key, confirmKey: 'NOPE' });
    await expect(wrong).rejects.toBeInstanceOf(Invalid);
    await expect(wrong).rejects.toMatchObject({ issues: [{ path: 'confirmKey' }] });
    expect(await isMirrored(base.db, project.id)).toBe(true);
  });

  it('the switch detaches, says when and by whom, and the project works natively afterwards', async () => {
    const { key, project, sourceId } = await mirror();
    const before = await tasksByKey(base.db, project.id, key);
    const ledger = before.get(`${key}-4`);
    await createComment(ctx, world.memberActor, { key: `${key}-4`, body: 'Kept after the switch' });
    const activityBefore = await projectActivity(base.db, project.id);

    const result = await switchBacklogToZamu(ctx, world.ownerActor, {
      projectKey: key,
      confirmKey: key.toLowerCase(),
    });
    expect(result).toMatchObject({
      project: key,
      switchedAt: NOW.toISOString(),
      switchedBy: { id: world.owner.id },
      status: { state: 'detached', detachedAt: NOW.toISOString() },
    });
    expect(await isMirrored(base.db, project.id)).toBe(false);
    const after = await tasksByKey(base.db, project.id, key);
    expect([...after.keys()].sort()).toEqual([...before.keys()].sort());
    expect(after.get(`${key}-4`)).toMatchObject({
      title: ledger?.title,
      description: ledger?.description,
      backlogId: 'BACK-4',
    });
    const items = await base.db
      .select({ text: schema.taskItem.text, state: schema.taskItem.state, source: schema.taskItem.source })
      .from(schema.taskItem)
      .where(eq(schema.taskItem.taskId, ledger?.id as string))
      .orderBy(asc(schema.taskItem.position));
    expect(items).toEqual([
      { text: 'Entries balance', state: 'open', source: 'app' },
      { text: 'Refunds post', state: 'checked', source: 'app' },
    ]);
    const activity = await projectActivity(base.db, project.id);
    expect(activity.slice(0, activityBefore.length)).toEqual(activityBefore);
    expect(activity.at(-1)).toMatchObject({ type: 'project.backlog_detached', actorId: world.owner.id });

    // Native writes: a new task continues the numbering; fields and criteria of a former mirror change.
    const created = await createTask(ctx, world.ownerActor, { project: key, title: 'After the switch' });
    expect(created.key).toBe(`${key}-10`);
    const updated = await updateTask(ctx, world.ownerActor, {
      key: `${key}-4`,
      title: 'Ledger, owned by Zamu',
      checkCriteria: [1],
    });
    expect(updated.title).toBe('Ledger, owned by Zamu');
    const task = await getTask(ctx, world.ownerActor, { key: `${key}-4` });
    expect(task.criteria?.map((item) => [item.state, item.locked])).toEqual([
      ['checked', false],
      ['checked', false],
    ]);

    await expect(checkBacklogSwitch(ctx, world.ownerActor, { projectKey: key })).rejects.toBeInstanceOf(
      BacklogDetached,
    );
    await expect(
      switchBacklogToZamu(ctx, world.ownerActor, { projectKey: key, confirmKey: key }),
    ).rejects.toBeInstanceOf(BacklogDetached);
    expect((await refreshBacklogSource(ctx, sourceId, 'manual')).outcome).toBe('skipped');
  });
});
