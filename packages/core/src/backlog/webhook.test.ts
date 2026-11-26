// Webhook acceptance for each provider, with signatures from @zamu/git-providers' signWebhook.
import { schema } from '@zamu/db';
import { type ProviderKind, signWebhook } from '@zamu/git-providers';
import { eq } from 'drizzle-orm';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { BACKLOG_REFRESH, REPOSITORY_EVENT } from '../jobs';
import { decryptSecret } from '../secrets';
import { createWorld, TEST_PUBLIC_URL, type TestContext, testContext, type World } from '../testing/fixtures';
import { loadSource } from './refresh';
import { detachBacklog, reissueBacklogWebhookSecret } from './settings';
import { startBacklog } from './setup';
import {
  configFile,
  createLinkedProject,
  FakeProvider,
  FakeRepository,
  mirrorContext,
  NO_MAPPINGS,
  taskFile,
  taskPath,
} from './testing';
import { acceptBacklogWebhook } from './webhook';

const HOSTS: Record<ProviderKind, string> = {
  github: 'github.com',
  gitlab: 'gitlab.com',
  gitea: 'codeberg.org',
};
const EVENT_HEADERS: Record<ProviderKind, (event: 'push' | 'ping' | 'other') => Record<string, string>> = {
  github: (event) => ({ 'X-GitHub-Event': event === 'other' ? 'issues' : event }),
  gitlab: (event) => ({ 'X-Gitlab-Event': event === 'push' ? 'Push Hook' : 'Issue Hook' }),
  gitea: (event) => ({
    'X-Forgejo-Event': event === 'push' ? 'push' : 'issues',
    'X-Gitea-Event': event === 'push' ? 'push' : 'issues',
  }),
};

describe('acceptBacklogWebhook', () => {
  let base: TestContext;
  let world: World;
  let ctx: ReturnType<typeof mirrorContext> & { publicUrl: string };

  beforeAll(async () => {
    base = testContext();
    world = await createWorld(base.db);
    ctx = { ...mirrorContext(base, new FakeProvider([])), publicUrl: TEST_PUBLIC_URL };
  });
  afterAll(async () => {
    await base?.close();
  });

  async function source(provider: ProviderKind) {
    const repo = new FakeRepository(`reddevs/hook-${crypto.randomUUID().slice(0, 8)}`, {
      'backlog/config.yml': configFile(),
      [taskPath('backlog', 'back-1', 'One')]: taskFile({ id: 'BACK-1', title: 'One' }),
    });
    const linked = await createLinkedProject(ctx, world, repo, { host: HOSTS[provider], provider });
    const status = await startBacklog(ctx, world.ownerActor, {
      projectKey: linked.key,
      connectionId: linked.connection.id,
      mode: 'mirror',
      mappings: NO_MAPPINGS,
    });
    await base.db
      .update(schema.backlogSource)
      .set({ defaultBranch: 'main' })
      .where(eq(schema.backlogSource.id, status.id));
    const row = await loadSource(base.db, status.id);
    if (!row?.webhookSecretCiphertext) throw new Error('no secret');
    return { ...linked, row, secret: decryptSecret(ctx, row.webhookSecretCiphertext) };
  }

  const push = (branch: string, after = 'a'.repeat(40)) =>
    JSON.stringify({ ref: `refs/heads/${branch}`, after });

  for (const provider of ['github', 'gitlab', 'gitea'] as const) {
    it(`accepts a signed ${provider} push to the default branch and queues a refresh`, async () => {
      const { row, secret } = await source(provider);
      ctx.jobs.clear();
      const body = push('main');
      const headers = { ...signWebhook(provider, body, secret), ...EVENT_HEADERS[provider]('push') };
      const decision = await acceptBacklogWebhook(ctx, row.webhookId, headers, body);
      expect(decision).toEqual({ status: 202, reason: 'refresh_queued' });
      expect(ctx.jobs.sent).toEqual([
        expect.objectContaining({ name: BACKLOG_REFRESH, data: { sourceId: row.id, trigger: 'webhook' } }),
      ]);
      expect((await loadSource(base.db, row.id))?.webhookLastAt).not.toBeNull();

      const other = push('feature/x');
      expect(
        await acceptBacklogWebhook(
          ctx,
          row.webhookId,
          { ...signWebhook(provider, other, secret), ...EVENT_HEADERS[provider]('push') },
          other,
        ),
      ).toEqual({ status: 204, reason: 'other_branch' });

      const bad = { ...signWebhook(provider, body, `${secret}x`), ...EVENT_HEADERS[provider]('push') };
      expect(await acceptBacklogWebhook(ctx, row.webhookId, bad, body)).toEqual({
        status: 404,
        reason: 'bad_signature',
      });
      expect(await acceptBacklogWebhook(ctx, row.webhookId, EVENT_HEADERS[provider]('push'), body)).toEqual({
        status: 404,
        reason: 'bad_signature',
      });
      // A signature for the body, sent with another body.
      expect(
        await acceptBacklogWebhook(ctx, row.webhookId, headers, push('main', 'b'.repeat(40))),
      ).toMatchObject({ status: provider === 'gitlab' ? 202 : 404 });

      const event = JSON.stringify({ action: 'opened' });
      expect(
        await acceptBacklogWebhook(
          ctx,
          row.webhookId,
          { ...signWebhook(provider, event, secret), ...EVENT_HEADERS[provider]('other') },
          event,
        ),
      ).toEqual({ status: 204, reason: 'not_a_push' });
      expect(ctx.jobs.sent).toHaveLength(provider === 'gitlab' ? 2 : 1);
    });
  }

  for (const provider of ['github', 'gitlab', 'gitea'] as const) {
    it(`accepts ${provider} pushes signed with a new secret and rejects the old one`, async () => {
      const { row, secret: old, key } = await source(provider);
      const body = push('main');
      const signed = (secret: string) => ({
        ...signWebhook(provider, body, secret),
        ...EVENT_HEADERS[provider]('push'),
      });
      expect(await acceptBacklogWebhook(ctx, row.webhookId, signed(old), body)).toMatchObject({
        status: 202,
      });

      const issued = await reissueBacklogWebhookSecret(ctx, world.ownerActor, { projectKey: key });
      expect(issued.url).toBe(`${TEST_PUBLIC_URL}/api/webhooks/backlog/${row.webhookId}`);
      expect(await acceptBacklogWebhook(ctx, row.webhookId, signed(old), body)).toEqual({
        status: 404,
        reason: 'bad_signature',
      });
      expect(await acceptBacklogWebhook(ctx, row.webhookId, signed(issued.secret), body)).toMatchObject({
        status: 202,
      });
    });
  }

  it('accepts the new secret after the old one became unreadable (another key)', async () => {
    const { row, secret: old, key } = await source('gitea');
    const body = push('main');
    const signed = (secret: string) => ({
      ...signWebhook('gitea', body, secret),
      ...EVENT_HEADERS.gitea('push'),
    });
    const otherKey = { ...ctx, encryptionKey: new Uint8Array(32).fill(9) };
    // The key changed: the stored secret no longer decrypts, so every delivery answers 404.
    expect(await acceptBacklogWebhook(otherKey, row.webhookId, signed(old), body)).toEqual({
      status: 404,
      reason: 'bad_signature',
    });
    const issued = await reissueBacklogWebhookSecret(otherKey, world.ownerActor, { projectKey: key });
    expect(await acceptBacklogWebhook(otherKey, row.webhookId, signed(issued.secret), body)).toMatchObject({
      status: 202,
    });
    expect(await acceptBacklogWebhook(otherKey, row.webhookId, signed(old), body)).toEqual({
      status: 404,
      reason: 'bad_signature',
    });
  });

  it('answers 204 to a GitHub ping and a deleted branch', async () => {
    const { row, secret } = await source('github');
    const ping = JSON.stringify({ zen: 'Keep it logically awesome.' });
    expect(
      await acceptBacklogWebhook(
        ctx,
        row.webhookId,
        { ...signWebhook('github', ping, secret), 'X-GitHub-Event': 'ping' },
        ping,
      ),
    ).toEqual({ status: 204, reason: 'not_a_push' });
    const deleted = JSON.stringify({ ref: 'refs/heads/main', after: '0'.repeat(40), deleted: true });
    expect(
      await acceptBacklogWebhook(
        ctx,
        row.webhookId,
        { ...signWebhook('github', deleted, secret), 'X-GitHub-Event': 'push' },
        deleted,
      ),
    ).toEqual({ status: 204, reason: 'branch_deleted' });
  });

  it('sends request events to the project repository link (M7)', async () => {
    const { row, secret, project } = await source('gitlab');
    ctx.jobs.clear();
    const body = JSON.stringify({
      object_kind: 'merge_request',
      user: { username: 'claude-dev' },
      object_attributes: {
        iid: 4,
        title: 'Retry',
        description: 'Closes: BACK-1',
        state: 'opened',
        action: 'open',
        draft: false,
        source_branch: 'feat/retry',
        target_branch: 'main',
        url: `${project.repository}/-/merge_requests/4`,
        created_at: '2040-01-01T10:00:00Z',
        updated_at: '2040-01-01T10:00:00Z',
      },
    });
    const headers = { ...signWebhook('gitlab', body, secret), 'X-Gitlab-Event': 'Merge Request Hook' };
    expect(await acceptBacklogWebhook(ctx, row.webhookId, headers, body)).toEqual({
      status: 202,
      reason: 'request_queued',
    });
    const [link] = await base.db
      .select()
      .from(schema.repositoryLink)
      .where(eq(schema.repositoryLink.projectId, project.id));
    expect(link).toMatchObject({ webhookLastStatus: 'ok', connectionId: row.connectionId });
    expect(ctx.jobs.sent).toEqual([
      expect.objectContaining({
        name: REPOSITORY_EVENT,
        data: expect.objectContaining({ linkId: link?.id, action: 'opened' }),
      }),
    ]);
  });

  it('answers 404 to unknown ids and 410 once detached', async () => {
    expect(await acceptBacklogWebhook(ctx, 'nope', {}, '')).toEqual({
      status: 404,
      reason: 'unknown_webhook',
    });
    expect(await acceptBacklogWebhook(ctx, 'a'.repeat(24), {}, '')).toEqual({
      status: 404,
      reason: 'unknown_webhook',
    });
    const { row, secret, key } = await source('gitlab');
    await detachBacklog(ctx, world.ownerActor, { projectKey: key, confirmKey: key });
    const body = push('main');
    expect(
      await acceptBacklogWebhook(
        ctx,
        row.webhookId,
        { ...signWebhook('gitlab', body, secret), 'X-Gitlab-Event': 'Push Hook' },
        body,
      ),
    ).toEqual({ status: 410, reason: 'detached' });
  });
});
