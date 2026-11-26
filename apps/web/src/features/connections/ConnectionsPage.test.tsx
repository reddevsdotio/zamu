import { screen, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import type { GitConnection, GitConnectionList } from '@zamu/contracts';
import { describe, expect, it, vi } from 'vitest';
import { renderInWorkspace as render } from '~/lib/testing';
import { SettingsError } from '../settings/result';
import { ConnectionDialog } from './ConnectionDialog';
import { ConnectionsView, ENCRYPTION_KEY_MISSING } from './ConnectionsPage';
import { DeleteConnectionDialog } from './DeleteConnectionDialog';

const ANA = { id: '00000000-0000-7000-8000-0000000000a1', name: 'Ana Ruiz', kind: 'person' as const };

function connection(partial: Partial<GitConnection> = {}): GitConnection {
  return {
    id: '00000000-0000-7000-8000-000000000c01',
    name: 'GitLab · reddevs',
    provider: 'gitlab',
    host: 'gitlab.com',
    status: 'working',
    apiBaseUrl: 'https://gitlab.com/api/v4',
    tokenHint: '3kd',
    checkedAt: '2026-10-23T11:56:00Z',
    checkedLogin: 'reddevs-bot',
    checkedDetail: null,
    usedBy: [
      { id: '00000000-0000-7000-8000-000000000001', key: 'PAY', name: 'Payments', paused: false },
      { id: '00000000-0000-7000-8000-000000000002', key: 'WEB', name: 'Web app', paused: true },
    ],
    createdBy: ANA,
    createdAt: '2026-10-20T10:00:00Z',
    updatedAt: '2026-10-20T10:00:00Z',
    ...partial,
  };
}

const LIST: GitConnectionList = {
  items: [
    connection(),
    connection({
      id: '00000000-0000-7000-8000-000000000c02',
      name: 'Client GitLab (expired)',
      status: 'rejected',
      usedBy: [],
    }),
  ],
  encryptionReady: true,
};

function view(props: Partial<Parameters<typeof ConnectionsView>[0]> = {}) {
  const handlers = {
    onRetry: vi.fn(),
    onAdd: vi.fn(),
    onEdit: vi.fn(),
    onDelete: vi.fn(),
    onTestAgain: vi.fn(),
  };
  render(<ConnectionsView list={LIST} isLoading={false} error={null} canManage {...handlers} {...props} />);
  return handlers;
}

describe('ConnectionsView', () => {
  it('lists connections with status, users and actions for admins', async () => {
    const user = userEvent.setup();
    const handlers = view();
    expect(
      screen.getByText('2 connections. Projects use them to read Backlog.md from a repository.'),
    ).toBeVisible();
    const table = screen.getByRole('table', { name: 'Git connections' });
    expect(within(table).getByText('Token rejected')).toBeVisible();
    expect(within(table).getByText('No projects')).toBeVisible();
    expect(within(table).getByText('mirror paused')).toBeVisible();
    expect(within(table).getByRole('link', { name: 'Payments (PAY)' })).toHaveAttribute(
      'href',
      '/w/acme/p/PAY/settings/backlog',
    );
    await user.click(within(table).getAllByRole('button', { name: 'Edit' })[0] as HTMLElement);
    expect(handlers.onEdit).toHaveBeenCalledWith(LIST.items[0]);
    await user.click(screen.getByRole('button', { name: 'Add connection' }));
    expect(handlers.onAdd).toHaveBeenCalled();
  });

  it('shows members the list without actions', () => {
    view({ canManage: false });
    expect(screen.queryByRole('button', { name: 'Add connection' })).toBeNull();
    expect(screen.queryByRole('button', { name: 'Edit' })).toBeNull();
    expect(screen.getByText(/Only owners and admins can add, change or delete connections/)).toBeVisible();
  });

  it('shows the empty state, the error and the missing key', async () => {
    const user = userEvent.setup();
    const { unmount } = render(
      <ConnectionsView
        list={{ items: [], encryptionReady: true }}
        isLoading={false}
        error={null}
        canManage
        onRetry={vi.fn()}
        onAdd={vi.fn()}
        onEdit={vi.fn()}
        onDelete={vi.fn()}
        onTestAgain={vi.fn()}
      />,
    );
    expect(screen.getByRole('heading', { name: 'No git connections yet' })).toBeVisible();
    unmount();

    const handlers = view({ list: undefined, error: "The server didn't answer in time." });
    expect(screen.getByRole('alert')).toHaveTextContent(
      "Couldn't load connections. The server didn't answer in time.",
    );
    await user.click(screen.getByRole('button', { name: 'Try again' }));
    expect(handlers.onRetry).toHaveBeenCalled();
  });

  it('turns adding off without APP_ENCRYPTION_KEY', () => {
    view({ list: { ...LIST, encryptionReady: false } });
    expect(screen.getByRole('alert')).toHaveTextContent(ENCRYPTION_KEY_MISSING);
    expect(screen.getByRole('button', { name: 'Add connection' })).toBeDisabled();
  });
});

describe('ConnectionDialog', () => {
  it('checks the fields before testing', async () => {
    const user = userEvent.setup();
    const onTest = vi.fn();
    render(<ConnectionDialog target={{ kind: 'add' }} onClose={vi.fn()} onTest={onTest} onSave={vi.fn()} />);
    const dialog = screen.getByRole('dialog', { name: 'Add git connection' });
    await user.clear(within(dialog).getByLabelText('Host'));
    await user.type(within(dialog).getByLabelText('Host'), 'https://git.example.com/a/b');
    await user.click(within(dialog).getByRole('button', { name: 'Test' }));
    expect(onTest).not.toHaveBeenCalled();
    expect(within(dialog).getByText(/without a path/)).toBeVisible();
    expect(within(dialog).getByText('Paste the access token')).toBeVisible();
  });

  it('tests the token, suggests a name and saves', async () => {
    const user = userEvent.setup();
    const onTest = vi.fn().mockResolvedValue({
      status: 'working',
      login: 'reddevs-bot',
      repoCount: 14,
      detail: null,
      checkedAt: '2026-10-23T12:00:00Z',
    });
    const onSave = vi.fn().mockResolvedValue({});
    const onClose = vi.fn();
    render(<ConnectionDialog target={{ kind: 'add' }} onClose={onClose} onTest={onTest} onSave={onSave} />);
    const dialog = screen.getByRole('dialog');
    await user.type(within(dialog).getByLabelText(/Access token/), 'glpat-abcdefghijklmnop3kd');
    expect(within(dialog).getByText('glpat-…3kd')).toBeVisible();
    await user.click(within(dialog).getByRole('button', { name: 'Test' }));
    expect(onTest).toHaveBeenCalledWith({
      provider: 'gitlab',
      host: 'gitlab.com',
      token: 'glpat-abcdefghijklmnop3kd',
    });
    expect(await within(dialog).findByText(/can read 14 repositories/)).toBeVisible();
    expect(within(dialog).getByLabelText('Name')).toHaveValue('GitLab · reddevs-bot');
    await user.click(within(dialog).getByRole('button', { name: 'Save connection' }));
    expect(onSave).toHaveBeenCalledWith({
      kind: 'add',
      provider: 'gitlab',
      host: 'gitlab.com',
      name: 'GitLab · reddevs-bot',
      token: 'glpat-abcdefghijklmnop3kd',
    });
    expect(onClose).toHaveBeenCalled();
  });

  it('shows a rejected token and keeps Save off until something changes', async () => {
    const user = userEvent.setup();
    const onTest = vi.fn().mockResolvedValue({
      status: 'rejected',
      login: null,
      repoCount: null,
      detail:
        'gitlab.com answered 401. The token may have expired or been revoked, or it lacks the read_api scope.',
      checkedAt: '2026-10-23T12:00:00Z',
    });
    render(<ConnectionDialog target={{ kind: 'add' }} onClose={vi.fn()} onTest={onTest} onSave={vi.fn()} />);
    const dialog = screen.getByRole('dialog');
    await user.type(within(dialog).getByLabelText('Name'), 'GitLab');
    await user.type(within(dialog).getByLabelText(/Access token/), 'glpat-abcdefghijklmnop3kd');
    await user.click(within(dialog).getByRole('button', { name: 'Test' }));
    expect(await within(dialog).findByRole('alert')).toHaveTextContent(
      'Token rejected. gitlab.com answered 401. The token may have expired or been revoked, or it lacks the read_api scope. Nothing was saved.',
    );
    expect(within(dialog).getByRole('button', { name: 'Save connection' })).toBeDisabled();
    await user.type(within(dialog).getByLabelText(/Access token/), 'x');
    expect(within(dialog).getByRole('button', { name: 'Save connection' })).toBeEnabled();
  });

  it('shows a refused save on the token and a taken name on the name', async () => {
    const user = userEvent.setup();
    const onSave = vi
      .fn()
      .mockRejectedValueOnce(
        new SettingsError({
          code: 'UNPROCESSABLE_CONTENT',
          message: 'gitlab.com answered 401. Nothing was saved.',
          issues: [{ path: 'token', message: 'gitlab.com answered 401.' }],
        }),
      )
      .mockRejectedValueOnce(
        new SettingsError({ code: 'CONFLICT', message: 'A connection named GitLab exists', issues: [] }),
      );
    render(<ConnectionDialog target={{ kind: 'add' }} onClose={vi.fn()} onTest={vi.fn()} onSave={onSave} />);
    const dialog = screen.getByRole('dialog');
    await user.type(within(dialog).getByLabelText('Name'), 'GitLab');
    await user.type(within(dialog).getByLabelText(/Access token/), 'glpat-abcdefghijklmnop3kd');
    await user.click(within(dialog).getByRole('button', { name: 'Save connection' }));
    expect(await within(dialog).findByRole('alert')).toHaveTextContent(
      'Token rejected. gitlab.com answered 401.',
    );
    await user.type(within(dialog).getByLabelText(/Access token/), 'x');
    await user.click(within(dialog).getByRole('button', { name: 'Save connection' }));
    expect(await within(dialog).findByText('A connection named GitLab exists')).toBeVisible();
  });

  it('edits the name and replaces the token only when one is typed', async () => {
    const user = userEvent.setup();
    const onSave = vi.fn().mockResolvedValue({});
    const onTest = vi.fn().mockResolvedValue({
      status: 'working',
      login: 'bot',
      repoCount: null,
      detail: null,
      checkedAt: '2026-10-23T12:00:00Z',
    });
    const target = { kind: 'edit' as const, connection: connection() };
    render(<ConnectionDialog target={target} onClose={vi.fn()} onTest={onTest} onSave={onSave} />);
    const dialog = screen.getByRole('dialog', { name: 'Edit GitLab · reddevs' });
    expect(within(dialog).getByLabelText('Host')).toHaveAttribute('readonly');
    expect(within(dialog).getByLabelText(/Access token/)).toHaveAttribute(
      'placeholder',
      'Leave empty to keep the token ending in 3kd',
    );
    await user.click(within(dialog).getByRole('button', { name: 'Test' }));
    expect(onTest).toHaveBeenCalledWith({ id: target.connection.id });
    await user.clear(within(dialog).getByLabelText('Name'));
    await user.type(within(dialog).getByLabelText('Name'), 'GitLab · team');
    await user.click(within(dialog).getByRole('button', { name: 'Save connection' }));
    expect(onSave).toHaveBeenCalledWith({ kind: 'edit', id: target.connection.id, name: 'GitLab · team' });
  });
});

describe('DeleteConnectionDialog', () => {
  it('names the projects whose mirrors pause', async () => {
    const user = userEvent.setup();
    const onDelete = vi.fn().mockResolvedValue({});
    const onClose = vi.fn();
    render(<DeleteConnectionDialog connection={connection()} onClose={onClose} onDelete={onDelete} />);
    const dialog = screen.getByRole('alertdialog', { name: 'Delete GitLab · reddevs?' });
    expect(dialog).toHaveTextContent('Two projects read Backlog.md through this connection.');
    expect(within(dialog).getByRole('list', { name: 'Projects that pause' })).toHaveTextContent(
      'PAYPayments',
    );
    expect(dialog).toHaveTextContent('Revoke the token at gitlab.com too if nothing else uses it.');
    await user.click(within(dialog).getByRole('button', { name: 'Delete connection' }));
    expect(onDelete).toHaveBeenCalled();
    expect(onClose).toHaveBeenCalled();
  });
});
