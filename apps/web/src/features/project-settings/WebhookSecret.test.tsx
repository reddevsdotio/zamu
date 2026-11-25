// PM-9: "New secret" in the webhook dialog, the confirmation, the new secret shown once, and the
// banner when the stored secret can't be read. The server functions are stubbed; core has its own tests.

import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { render, screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import type { BacklogWebhookInfo } from '@zamu/contracts';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { SettingsResult } from '../settings/result';
import { BacklogStatusView } from './BacklogSettings';
import { sourceStatus } from './fixtures';
import { WebhookContent, WebhookDialog } from './WebhookDialog';

const server = vi.hoisted(() => ({
  backlogWebhookInfoFn: vi.fn(),
  reissueBacklogWebhookSecretFn: vi.fn(),
}));

vi.mock('../backlog/server', () => server);

vi.mock('~/lib/orpc', async () => {
  const { createTanstackQueryUtils } = await import('@orpc/tanstack-query');
  const fail = (): unknown =>
    new Proxy(() => {}, {
      get: (_target, key) => (typeof key === 'string' ? fail() : undefined),
      apply: () => Promise.reject(new Error('no API in these tests')),
    });
  const client = fail();
  return { client, orpc: createTanstackQueryUtils(client as never) };
});

const URL = 'https://zamu.example.com/api/webhooks/backlog/hook-id-0123456789abcdef';
const OLD = 'old-secret-0123456789abcdefghijklmnopqrstu';
const NEW = 'new-secret-0123456789abcdefghijklmnopqrstu';

function info(partial: Partial<BacklogWebhookInfo> = {}): BacklogWebhookInfo {
  return { url: URL, secret: OLD, secretState: 'ok', provider: 'gitlab', lastAt: null, ...partial };
}

const ok = <T,>(data: T): SettingsResult<T> => ({ ok: true, data });

function renderDialog() {
  const queryClient = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  render(
    <QueryClientProvider client={queryClient}>
      <WebhookDialog
        projectKey="PAY"
        isOpen
        onOpenChange={vi.fn()}
        repository="gitlab.com/reddevs/payments"
        defaultBranch="main"
      />
    </QueryClientProvider>,
  );
}

const webhookDialog = () => screen.getByRole('dialog', { name: 'Refresh on every push' });

beforeEach(() => {
  server.backlogWebhookInfoFn.mockReset();
  server.reissueBacklogWebhookSecretFn.mockReset();
});

describe('New webhook secret', () => {
  it('confirms, issues the secret and shows it unmasked with where to paste it', async () => {
    const user = userEvent.setup();
    server.backlogWebhookInfoFn
      .mockResolvedValueOnce(ok(info()))
      .mockResolvedValue(ok(info({ secret: NEW })));
    server.reissueBacklogWebhookSecretFn.mockResolvedValue(ok({ url: URL, secret: NEW }));
    renderDialog();

    await user.click(await within(webhookDialog()).findByRole('button', { name: 'New secret' }));
    const confirm = screen.getByRole('alertdialog', { name: 'Issue a new webhook secret?' });
    expect(confirm).toHaveTextContent(
      'The current secret stops working at once. Webhooks fail until you paste the new secret into the git host. Mirrors still refresh every hour.',
    );
    await user.click(within(confirm).getByRole('button', { name: 'Issue new secret' }));

    expect(server.reissueBacklogWebhookSecretFn).toHaveBeenCalledWith({ data: { projectKey: 'PAY' } });
    expect(await within(webhookDialog()).findByText(NEW)).toBeVisible();
    expect(screen.queryByRole('alertdialog')).toBeNull();
    expect(
      within(webhookDialog()).getByText('Paste this into the webhook settings on GitLab.'),
    ).toBeVisible();
    expect(within(webhookDialog()).queryByRole('button', { name: 'Show' })).toBeNull();
    // The webhook info is fetched again, so the poll agrees with the new secret.
    await waitFor(() => expect(server.backlogWebhookInfoFn).toHaveBeenCalledTimes(2));
  });

  it('Cancel keeps the current secret', async () => {
    const user = userEvent.setup();
    server.backlogWebhookInfoFn.mockResolvedValue(ok(info()));
    renderDialog();
    await user.click(await within(webhookDialog()).findByRole('button', { name: 'New secret' }));
    await user.click(within(screen.getByRole('alertdialog')).getByRole('button', { name: 'Cancel' }));
    expect(server.reissueBacklogWebhookSecretFn).not.toHaveBeenCalled();
    expect(screen.queryByRole('alertdialog')).toBeNull();
    expect(within(webhookDialog()).queryByText(OLD)).toBeNull();
  });

  it('shows the error in the confirmation when the server refuses', async () => {
    const user = userEvent.setup();
    server.backlogWebhookInfoFn.mockResolvedValue(ok(info()));
    server.reissueBacklogWebhookSecretFn.mockResolvedValue({
      ok: false,
      error: { code: 'CONFLICT', message: 'This project no longer mirrors Backlog.md.', issues: [] },
    });
    renderDialog();
    await user.click(await within(webhookDialog()).findByRole('button', { name: 'New secret' }));
    const confirm = screen.getByRole('alertdialog');
    await user.click(within(confirm).getByRole('button', { name: 'Issue new secret' }));
    expect(await within(confirm).findByRole('alert')).toHaveTextContent(
      'This project no longer mirrors Backlog.md.',
    );
  });

  it('offers a new secret from the banner when the stored one is unreadable', async () => {
    const user = userEvent.setup();
    server.backlogWebhookInfoFn
      .mockResolvedValueOnce(ok(info({ secret: null, secretState: 'unreadable', provider: 'gitea' })))
      .mockResolvedValue(ok(info({ secret: NEW, provider: 'gitea' })));
    server.reissueBacklogWebhookSecretFn.mockResolvedValue(ok({ url: URL, secret: NEW }));
    renderDialog();

    const banner = await within(webhookDialog()).findByRole('alert');
    expect(banner).toHaveTextContent(
      "The webhook secret can't be read with the current APP_ENCRYPTION_KEY. Issue a new one and paste it into the git host.",
    );
    expect(within(webhookDialog()).getByText(URL)).toBeVisible();
    expect(within(webhookDialog()).queryByText('Secret token')).toBeNull();

    await user.click(within(banner).getByRole('button', { name: 'New secret' }));
    await user.click(
      within(screen.getByRole('alertdialog')).getByRole('button', { name: 'Issue new secret' }),
    );
    expect(await within(webhookDialog()).findByText(NEW)).toBeVisible();
    expect(within(webhookDialog()).queryByRole('alert')).toBeNull();
    expect(
      within(webhookDialog()).getByText('Paste this into the webhook settings on Gitea / Forgejo.'),
    ).toBeVisible();
  });

  it('has no New secret button for a hidden secret', () => {
    render(
      <WebhookContent
        info={info({ secret: null, secretState: 'hidden' })}
        error={null}
        repository={null}
        defaultBranch={null}
        onNewSecret={vi.fn()}
        close={vi.fn()}
      />,
    );
    expect(screen.queryByRole('button', { name: 'New secret' })).toBeNull();
    expect(
      screen.getByText('Only owners and admins can see the secret. Ask one of them to add the webhook.'),
    ).toBeVisible();
  });

  it('names the new secret in the history', () => {
    // History shows once the source is detached.
    const status = sourceStatus({
      state: 'detached',
      detachedAt: '2026-10-24T09:00:00Z',
      detachedBy: sourceStatus().createdBy,
      history: [
        {
          id: '00000000-0000-7000-8000-000000000e02',
          type: 'project.backlog_webhook_secret_reissued',
          actor: sourceStatus().createdBy,
          onBehalfOf: null,
          origin: 'app',
          originRef: null,
          details: {
            mode: 'mirror',
            repository: 'gitlab.com/reddevs/payments',
            tasks: null,
            milestones: null,
          },
          createdAt: '2026-10-23T14:02:00Z',
        },
      ],
    });
    render(
      <QueryClientProvider client={new QueryClient()}>
        <BacklogStatusView
          status={status}
          projectName="Payments"
          canManage
          canRefresh
          onRefresh={vi.fn()}
          onOpenWebhook={vi.fn()}
          onSwitch={vi.fn()}
          onUseAnotherConnection={vi.fn()}
        />
      </QueryClientProvider>,
    );
    const history = screen.getByRole('region', { name: 'History' });
    expect(history).toHaveTextContent('Ana Ruiz issued a new webhook secret');
    expect(within(history).getAllByRole('listitem')).toHaveLength(1);
    expect(history).not.toHaveTextContent('switched Payments');
  });
});
