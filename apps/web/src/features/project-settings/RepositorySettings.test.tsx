// Repository settings (M7 frames 069 to 080): no repository, the webhook not set up, healthy, a failed
// signature check, closing off, loading, the mirrored lock, the sync error, the read-only member view,
// the secret shown once after New secret, Check now and the Change dialog.
import { render, screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import type { GitConnection, RepositorySettings } from '@zamu/contracts';
import { describe, expect, it, vi } from 'vitest';
import { testWorkspace } from '~/lib/testing';
import { WorkspaceProvider } from '~/lib/workspace';
import { RepositoryView, type RepositoryViewProps } from './RepositorySettings';
import {
  agoLong,
  bareHost,
  closeOnMergeText,
  connectionsForHost,
  initialConnection,
  repositoryFailure,
  syncText,
  webhookStatus,
} from './repository';

const REPOSITORY = 'https://github.com/northwind/payments.git';
const HOOK_URL = 'https://zamu.northwind.dev/api/webhooks/repository/8f2c41';
const SECRET = 'whsec_3kT9-new-secret-0123456789abcdef';

const GITHUB: GitConnection = {
  id: '00000000-0000-7000-8000-000000000c01',
  name: 'GitHub · northwind',
  provider: 'github',
  host: 'github.com',
  status: 'working',
  apiBaseUrl: 'https://api.github.com',
  tokenHint: 'x9z',
  checkedAt: null,
  checkedLogin: null,
  checkedDetail: null,
  usedBy: [],
  createdBy: { id: '00000000-0000-7000-8000-0000000000a1', name: 'Ana Ruiz', kind: 'person' },
  createdAt: '2026-11-01T09:00:00.000Z',
  updatedAt: '2026-11-01T09:00:00.000Z',
};
const GITLAB: GitConnection = {
  ...GITHUB,
  id: '00000000-0000-7000-8000-000000000c02',
  name: 'GitLab · northwind',
  provider: 'gitlab',
  host: 'gitlab.com',
};

function settings(partial: Partial<RepositorySettings> = {}): RepositorySettings {
  return {
    project: { id: '00000000-0000-7000-8000-000000000001', key: 'PAY', name: 'Payments' },
    repository: REPOSITORY,
    provider: 'github',
    connection: {
      id: GITHUB.id,
      name: GITHUB.name,
      provider: 'github',
      host: 'github.com',
      status: 'working',
    },
    defaultBranch: 'main',
    closeOnMerge: true,
    mirrored: false,
    webhook: { url: HOOK_URL, secretSet: false, lastAt: null, lastStatus: null, coveredByBacklog: false },
    sync: { lastAt: null, error: null, nextAt: null },
    canEdit: true,
    ...partial,
  };
}

const minutesAgo = (minutes: number) => new Date(Date.now() - minutes * 60_000).toISOString();

function renderView(props: Partial<RepositoryViewProps> = {}) {
  const handlers = {
    onCloseOnMergeChange: vi.fn().mockResolvedValue(undefined),
    onNewSecret: vi.fn().mockResolvedValue({ url: HOOK_URL, secret: SECRET }),
    onCheckNow: vi.fn().mockResolvedValue(undefined),
    onSave: vi.fn().mockResolvedValue(undefined),
  };
  const workspace = testWorkspace({});
  // A wrapper, not renderInWorkspace, so rerender keeps the workspace around the view.
  const view = render(
    <RepositoryView
      projectKey="PAY"
      settings={settings()}
      connections={[GITHUB, GITLAB]}
      {...handlers}
      {...props}
    />,
    { wrapper: ({ children }) => <WorkspaceProvider workspace={workspace}>{children}</WorkspaceProvider> },
  );
  return { ...handlers, ...view };
}

const statusLine = () => document.querySelector('[data-status]') as HTMLElement;

describe('Repository settings', () => {
  it('says what Zamu never does when no repository is linked, and offers to link one', async () => {
    const user = userEvent.setup();
    renderView({ settings: settings({ repository: null, webhook: null, provider: null, connection: null }) });
    expect(screen.getByRole('heading', { name: 'Repository' })).toBeVisible();
    expect(screen.getByRole('heading', { name: 'No repository linked' })).toBeVisible();
    expect(
      screen.getByText(
        'Link the repository this project’s code lives in. Zamu only reads from it: it never comments, commits or changes a request.',
      ),
    ).toBeVisible();
    expect(screen.getByText(/An agent links it for you when it runs/)).toHaveTextContent(
      'An agent links it for you when it runs zamu link in a clone.',
    );
    await user.click(screen.getByRole('button', { name: 'Link a repository' }));
    const dialog = screen.getByRole('dialog', { name: 'Link a repository' });
    expect(within(dialog).getByRole('textbox', { name: 'Repository URL' })).toHaveValue('');
  });

  it('shows the repository facts, the switch on and the setup while no event came (frame 070)', () => {
    renderView();
    expect(screen.getByText('github.com/northwind/payments')).toBeVisible();
    expect(screen.getByText('main')).toBeVisible();
    expect(screen.getByText('Only merges into this branch close tasks.')).toBeVisible();
    expect(screen.getByText('GitHub · northwind')).toBeVisible();
    const toggle = screen.getByRole('switch', { name: 'Close tasks when their pull request merges' });
    expect(toggle).toBeChecked();
    expect(toggle).toHaveAccessibleDescription(
      'A task moves to Done when its last open request merges into main. Agents stop at In review and leave Done to the merge.',
    );
    expect(statusLine()).toHaveTextContent(
      'No event received yet. Until the webhook is set up, Zamu checks the repository once an hour.',
    );
    expect(screen.getByText(HOOK_URL)).toBeVisible();
    expect(screen.getByText('None yet')).toBeVisible();
    expect(screen.getByRole('tab', { name: 'GitHub' })).toHaveAttribute('aria-selected', 'true');
    expect(screen.getByText(/Settings › Webhooks › Add webhook/)).toBeVisible();
    expect(
      screen.getByText('Without a webhook Zamu still finds requests, by checking once an hour.'),
    ).toBeVisible();
    expect(screen.getByRole('button', { name: 'Check now' })).toBeVisible();
  });

  it('folds the setup away while events arrive, behind Setup steps (frame 071)', async () => {
    const user = userEvent.setup();
    renderView({
      settings: settings({
        webhook: {
          url: HOOK_URL,
          secretSet: true,
          lastAt: minutesAgo(4.5),
          lastStatus: 'ok',
          coveredByBacklog: false,
        },
      }),
    });
    expect(statusLine()).toHaveTextContent('Last event 4 minutes ago.');
    expect(screen.queryByText(HOOK_URL)).toBeNull();
    await user.click(screen.getByRole('button', { name: 'Setup steps' }));
    expect(screen.getByText(HOOK_URL)).toBeVisible();
    expect(screen.getByRole('button', { name: 'Hide steps' })).toHaveAttribute('aria-expanded', 'true');
  });

  it('says the last event failed its signature check, with the secret masked (frame 072)', () => {
    renderView({
      settings: settings({
        webhook: {
          url: HOOK_URL,
          secretSet: true,
          lastAt: minutesAgo(2),
          lastStatus: 'bad_signature',
          coveredByBacklog: false,
        },
      }),
    });
    expect(statusLine()).toHaveTextContent(
      'The last event failed its signature check. The secret on GitHub doesn’t match this one. Paste it again, or issue a new one.',
    );
    expect(screen.getByText('••••••••••••••••••••••••')).toBeVisible();
    // Masked: nothing to copy.
    expect(screen.queryByRole('button', { name: 'Copy' })).not.toBeNull();
    expect(screen.getAllByRole('button', { name: 'Copy' })).toHaveLength(1);
  });

  it('turns closing on merge off and says what still happens (frame 073)', async () => {
    const user = userEvent.setup();
    const { onCloseOnMergeChange, rerender } = renderView();
    await user.click(screen.getByRole('switch', { name: 'Close tasks when their pull request merges' }));
    expect(onCloseOnMergeChange).toHaveBeenCalledWith(false);
    rerender(
      <RepositoryView
        projectKey="PAY"
        settings={settings({ closeOnMerge: false })}
        onCloseOnMergeChange={onCloseOnMergeChange}
        onNewSecret={vi.fn()}
        onCheckNow={vi.fn()}
        onSave={vi.fn()}
      />,
    );
    const toggle = screen.getByRole('switch', { name: 'Close tasks when their pull request merges' });
    await waitFor(() => expect(toggle).not.toBeChecked());
    expect(toggle).toHaveAccessibleDescription(
      'Off: requests still link to their tasks and a new request still moves a task to In review, but the status stays where it is after a merge. Agents set Done themselves.',
    );
  });

  it('shows the repository from the project while the settings load (frame 074)', () => {
    renderView({ settings: undefined, repository: REPOSITORY });
    expect(screen.getByText('github.com/northwind/payments')).toBeVisible();
    expect(statusLine()).toHaveAttribute('aria-busy', 'true');
    expect(screen.getByRole('switch')).toBeDisabled();
    expect(screen.queryByRole('button', { name: 'Change' })).toBeNull();
  });

  it('locks closing on merge off for a mirrored project and points at the Backlog.md webhook', () => {
    renderView({
      settings: settings({
        mirrored: true,
        closeOnMerge: false,
        webhook: { url: HOOK_URL, secretSet: false, lastAt: null, lastStatus: null, coveredByBacklog: true },
      }),
    });
    const toggle = screen.getByRole('switch', { name: 'Close tasks when their pull request merges' });
    expect(toggle).not.toBeChecked();
    expect(toggle).toBeDisabled();
    expect(toggle).toHaveAccessibleDescription(
      'Off while the project mirrors Backlog.md: the files own each task’s status, so requests link to tasks but move none.',
    );
    expect(screen.getByText(/The Backlog.md webhook already covers this project/)).toBeVisible();
    expect(screen.getByRole('link', { name: 'Backlog.md settings' })).toHaveAttribute(
      'href',
      '/w/acme/p/PAY/settings/backlog',
    );
    // No second webhook to set up.
    expect(screen.queryByText(HOOK_URL)).toBeNull();
    expect(statusLine()).toHaveTextContent(
      'No event received yet. Until requests arrive through the Backlog.md webhook, Zamu checks the repository once an hour.',
    );
  });

  it('shows the sync error with Change', async () => {
    const user = userEvent.setup();
    renderView({
      settings: settings({
        connection: null,
        sync: {
          lastAt: minutesAgo(12.5),
          error: 'Zamu can’t read this repository: link a connection',
          nextAt: null,
        },
      }),
    });
    const alert = screen.getByRole('alert');
    expect(alert).toHaveTextContent(
      'The last check failed. Zamu can’t read this repository: link a connection.',
    );
    expect(screen.getByText('None: Zamu reads it as a public repository, without a token.')).toBeVisible();
    await user.click(within(alert).getByRole('button', { name: 'Change' }));
    expect(screen.getByRole('dialog', { name: 'Change the repository' })).toBeVisible();
  });

  it('is read-only for members', () => {
    renderView({
      settings: settings({
        canEdit: false,
        webhook: { url: HOOK_URL, secretSet: true, lastAt: null, lastStatus: null, coveredByBacklog: false },
      }),
    });
    expect(
      screen.getByText(
        'You can read this page. Owners and admins change the repository, closing on merge and the webhook.',
      ),
    ).toBeVisible();
    expect(screen.queryByRole('button', { name: 'Change' })).toBeNull();
    expect(screen.queryByRole('button', { name: 'New secret' })).toBeNull();
    expect(screen.queryByRole('button', { name: 'Check now' })).toBeNull();
    expect(screen.getByRole('switch')).toBeDisabled();
    expect(screen.getByText('Only owners and admins can issue a new secret.')).toBeVisible();
  });

  it('has no Link a repository for members', () => {
    renderView({ settings: settings({ repository: null, webhook: null, canEdit: false }) });
    expect(screen.queryByRole('button', { name: 'Link a repository' })).toBeNull();
    expect(screen.getByText(/Owners and admins can link it here./)).toBeVisible();
  });

  it('shows a new secret once, then masks it after the page is left', async () => {
    const user = userEvent.setup();
    const { onNewSecret, unmount } = renderView();
    await user.click(screen.getByRole('button', { name: 'New secret' }));
    // No secret yet: nothing stops working, so no confirmation.
    expect(onNewSecret).toHaveBeenCalledTimes(1);
    expect(await screen.findByText(SECRET)).toBeVisible();
    expect(
      screen.getByText(
        'Shown once. Copy it now and paste it into the webhook; it’s masked when you leave this page.',
      ),
    ).toBeVisible();
    expect(screen.getAllByRole('button', { name: 'Copy' })).toHaveLength(2);
    unmount();

    renderView({
      settings: settings({
        webhook: { url: HOOK_URL, secretSet: true, lastAt: null, lastStatus: null, coveredByBacklog: false },
      }),
    });
    expect(screen.queryByText(SECRET)).toBeNull();
    expect(screen.getByText('••••••••••••••••••••••••')).toBeVisible();
  });

  it('confirms before replacing a secret that is set', async () => {
    const user = userEvent.setup();
    const { onNewSecret } = renderView({
      settings: settings({
        webhook: { url: HOOK_URL, secretSet: true, lastAt: null, lastStatus: null, coveredByBacklog: false },
      }),
    });
    await user.click(screen.getByRole('button', { name: 'New secret' }));
    const confirm = screen.getByRole('alertdialog', { name: 'Issue a new webhook secret?' });
    expect(confirm).toHaveTextContent('The current secret stops working at once.');
    expect(onNewSecret).not.toHaveBeenCalled();
    await user.click(within(confirm).getByRole('button', { name: 'Issue new secret' }));
    expect(onNewSecret).toHaveBeenCalledTimes(1);
    expect(await screen.findByText(SECRET)).toBeVisible();
  });

  it('queues a check with Check now and says so while it runs', async () => {
    const user = userEvent.setup();
    const { onCheckNow, rerender } = renderView({
      settings: settings({ sync: { lastAt: minutesAgo(12.5), error: null, nextAt: null } }),
    });
    expect(
      screen.getByText('Zamu checks the repository once an hour. Last check 12 minutes ago.'),
    ).toBeVisible();
    await user.click(screen.getByRole('button', { name: 'Check now' }));
    expect(onCheckNow).toHaveBeenCalledTimes(1);
    rerender(
      <RepositoryView
        projectKey="PAY"
        settings={settings()}
        checkPending
        onCloseOnMergeChange={vi.fn()}
        onNewSecret={vi.fn()}
        onCheckNow={onCheckNow}
        onSave={vi.fn()}
      />,
    );
    expect(screen.getByText('Checking now…')).toBeVisible();
    expect(screen.queryByRole('button', { name: 'Check now' })).toBeNull();
  });

  it('changes the connection in the Change dialog, among those for the host plus none', async () => {
    const user = userEvent.setup();
    const { onSave } = renderView();
    await user.click(screen.getByRole('button', { name: 'Change' }));
    const dialog = screen.getByRole('dialog', { name: 'Change the repository' });
    expect(within(dialog).getByRole('textbox', { name: 'Repository URL' })).toHaveValue(REPOSITORY);
    const radios = within(dialog).getAllByRole('radio');
    expect(radios.map((radio) => radio.closest('label')?.textContent)).toEqual([
      'GHGitHub · northwindgithub.com · Working',
      'None: public repositoryZamu reads it without a token, so a private repository can’t be read.',
    ]);
    expect(within(dialog).getByRole('radio', { name: /GitHub · northwind/ })).toBeChecked();
    await user.click(within(dialog).getByRole('radio', { name: /None: public repository/ }));
    await user.click(within(dialog).getByRole('button', { name: 'Save' }));
    expect(onSave).toHaveBeenCalledWith({ connectionId: null });
    await waitFor(() => expect(screen.queryByRole('dialog')).toBeNull());
  });

  it('saves a new repository URL with the connection for its host', async () => {
    const user = userEvent.setup();
    const { onSave } = renderView();
    await user.click(screen.getByRole('button', { name: 'Change' }));
    const dialog = screen.getByRole('dialog', { name: 'Change the repository' });
    const field = within(dialog).getByRole('textbox', { name: 'Repository URL' });
    await user.clear(field);
    await user.type(field, 'https://gitlab.com/northwind/payments');
    expect(within(dialog).getByRole('radio', { name: /GitLab · northwind/ })).toBeChecked();
    expect(within(dialog).queryByRole('radio', { name: /GitHub · northwind/ })).toBeNull();
    await user.click(within(dialog).getByRole('button', { name: 'Save' }));
    expect(onSave).toHaveBeenCalledWith({
      repository: 'https://gitlab.com/northwind/payments',
      connectionId: GITLAB.id,
    });
  });

  it('refuses an address that is not a clone URL and offers none for an unknown host', async () => {
    const user = userEvent.setup();
    const { onSave } = renderView();
    await user.click(screen.getByRole('button', { name: 'Change' }));
    const dialog = screen.getByRole('dialog', { name: 'Change the repository' });
    const field = within(dialog).getByRole('textbox', { name: 'Repository URL' });
    await user.clear(field);
    await user.type(field, 'https://git.northwind.dev/team/payments');
    expect(within(dialog).getByText(/No connection of this workspace reads git.northwind.dev/)).toBeVisible();
    expect(within(dialog).getAllByRole('radio')).toHaveLength(1);
    await user.clear(field);
    await user.type(field, 'payments');
    await user.click(within(dialog).getByRole('button', { name: 'Save' }));
    expect(onSave).not.toHaveBeenCalled();
    expect(field).toHaveAttribute('aria-invalid', 'true');
  });

  it('shows why a save failed in the dialog', async () => {
    const user = userEvent.setup();
    const { onSave } = renderView();
    onSave.mockRejectedValueOnce(new Error('network'));
    await user.click(screen.getByRole('button', { name: 'Change' }));
    const dialog = screen.getByRole('dialog', { name: 'Change the repository' });
    await user.click(within(dialog).getByRole('radio', { name: /None: public repository/ }));
    await user.click(within(dialog).getByRole('button', { name: 'Save' }));
    expect(await within(dialog).findByRole('alert')).toHaveTextContent(
      'Couldn’t save. Check your connection and try again.',
    );
  });
});

describe('repository helpers', () => {
  const now = Date.parse('2026-11-26T14:20:00Z');

  it('maps the last delivery to the status line', () => {
    expect(webhookStatus({ webhook: null })).toBe('never');
    const hook = { url: HOOK_URL, secretSet: true, coveredByBacklog: false };
    expect(webhookStatus({ webhook: { ...hook, lastAt: null, lastStatus: null } })).toBe('never');
    expect(webhookStatus({ webhook: { ...hook, lastAt: '2026-11-26T14:00:00Z', lastStatus: 'ok' } })).toBe(
      'ok',
    );
    expect(
      webhookStatus({ webhook: { ...hook, lastAt: '2026-11-26T14:00:00Z', lastStatus: 'bad_payload' } }),
    ).toBe('bad_payload');
  });

  it('says how long ago in words', () => {
    expect(agoLong('2026-11-26T14:19:40Z', now)).toBe('just now');
    expect(agoLong('2026-11-26T14:19:00Z', now)).toBe('1 minute ago');
    expect(agoLong('2026-11-26T14:16:00Z', now)).toBe('4 minutes ago');
    expect(agoLong('2026-11-26T11:20:00Z', now)).toBe('3 hours ago');
    expect(agoLong('2026-11-24T14:20:00Z', now)).toBe('2 days ago');
    expect(agoLong('2026-10-21T14:20:00Z', now)).toBe('on Oct 21');
  });

  it('writes the hourly-check sentence', () => {
    expect(syncText({ lastAt: null, error: null, nextAt: null }, now)).toBe(
      'Zamu checks the repository once an hour.',
    );
    expect(syncText({ lastAt: '2026-11-26T14:08:00Z', error: null, nextAt: null }, now)).toBe(
      'Zamu checks the repository once an hour. Last check 12 minutes ago.',
    );
  });

  it('names the branch in the close-on-merge text', () => {
    expect(closeOnMergeText(true, 'trunk')).toContain('merges into trunk.');
    expect(closeOnMergeText(true, null)).toContain('merges into the default branch.');
    expect(closeOnMergeText(false, 'main')).toMatch(/^Off: /);
  });

  it('keeps the connections for the host, ignoring ports and case', () => {
    const forgejo = {
      ...GITHUB,
      id: 'f',
      name: 'Forgejo',
      provider: 'gitea' as const,
      host: 'localhost:3300',
    };
    const broken = { ...GITHUB, id: 'b', name: 'A broken one', status: 'rejected' as const };
    expect(bareHost('LOCALHOST:3300')).toBe('localhost');
    expect(bareHost('[::1]:3000')).toBe('::1');
    expect(connectionsForHost([GITHUB, GITLAB, forgejo, broken], 'github.com').map((c) => c.name)).toEqual([
      'GitHub · northwind',
      'A broken one',
    ]);
    expect(connectionsForHost([forgejo], 'localhost').map((c) => c.id)).toEqual(['f']);
    expect(connectionsForHost([GITHUB], null)).toEqual([]);
  });

  it('starts the dialog on the current connection, else the only working one, else none', () => {
    expect(initialConnection('a', [{ id: 'a', status: 'rejected' }])).toBe('a');
    expect(initialConnection('x', [{ id: 'a', status: 'working' }])).toBe('a');
    expect(
      initialConnection(null, [
        { id: 'a', status: 'working' },
        { id: 'b', status: 'working' },
      ]),
    ).toBeNull();
    expect(initialConnection(null, [])).toBeNull();
  });

  it('reads unknown errors as a connection problem', () => {
    expect(repositoryFailure(new Error('boom'))).toBe('Couldn’t save. Check your connection and try again.');
  });
});
