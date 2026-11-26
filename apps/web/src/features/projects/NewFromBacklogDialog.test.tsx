import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { screen, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import type { BacklogDetection, GitConnection } from '@zamu/contracts';
import { describe, expect, it, vi } from 'vitest';
import { SettingsError } from '~/features/settings/result';
import { renderInWorkspace as render } from '~/lib/testing';
import {
  type DetectRepository,
  keyForDetection,
  NewFromBacklogDialog,
  type NewFromBacklogDialogProps,
  newFromBacklogFailure,
} from './NewFromBacklogDialog';

const USER = { id: '01a169ed-a7a5-712d-a08b-1e796a1ac801', name: 'Ana Ruiz', kind: 'person' as const };

function connection(
  id: string,
  name: string,
  provider: GitConnection['provider'],
  host: string,
): GitConnection {
  return {
    id,
    name,
    provider,
    host,
    status: 'working',
    apiBaseUrl: `https://${host}/api/v4`,
    tokenHint: 'abc',
    checkedAt: null,
    checkedLogin: 'reddevs-bot',
    checkedDetail: null,
    usedBy: [],
    createdBy: USER,
    createdAt: '2026-10-20T10:00:00.000Z',
    updatedAt: '2026-10-20T10:00:00.000Z',
  };
}

const GITLAB = connection('01a169ed-a7a5-712d-a08b-1e796a1ac802', 'GitLab · reddevs', 'gitlab', 'gitlab.com');
const GITHUB = connection(
  '01a169ed-a7a5-712d-a08b-1e796a1ac803',
  'GitHub · ana-ruiz',
  'github',
  'github.com',
);
const FORGEJO = connection(
  '01a169ed-a7a5-712d-a08b-1e796a1ac804',
  'Forgejo local',
  'gitea',
  'localhost:3300',
);

function detection(prefix: string, projectName: string): BacklogDetection {
  return {
    repository: 'gitlab.com/reddevs/payments',
    access: 'ok',
    defaultBranch: 'main',
    headCommit: 'a1b2c3d4e5f6',
    headCommittedAt: null,
    folder: 'backlog',
    folderSource: 'default',
    config: {
      projectName,
      taskPrefix: prefix,
      statuses: ['To Do', 'Done'],
      defaultStatus: 'To Do',
      priorities: [],
      labels: [],
      milestones: [],
      zeroPaddedIds: null,
    },
    configError: null,
    folders: [
      { path: 'tasks/', count: 412, ignored: false },
      { path: 'drafts/', count: 23, ignored: false },
      { path: 'archive/tasks/', count: 339, ignored: false },
      { path: 'completed/', count: 12, ignored: false },
      { path: 'milestones/', count: 6, ignored: false },
    ],
    keyMatchesPrefix: false,
    mappings: { status: [], priority: [], assignee: [] },
  };
}

function setup(props: Partial<NewFromBacklogDialogProps> = {}) {
  const onSubmit = props.onSubmit ?? vi.fn().mockResolvedValue(null);
  const user = userEvent.setup();
  render(
    <QueryClientProvider client={new QueryClient({ defaultOptions: { queries: { retry: false } } })}>
      <NewFromBacklogDialog
        isOpen
        onClose={vi.fn()}
        connections={[GITLAB, GITHUB, FORGEJO]}
        encryptionReady
        {...props}
        onSubmit={onSubmit}
      />
    </QueryClientProvider>,
  );
  return {
    user,
    onSubmit,
    repository: () => screen.getByLabelText('Repository') as HTMLInputElement,
    name: () => screen.getByLabelText('Name') as HTMLInputElement,
    key: () => screen.getByLabelText('Key') as HTMLInputElement,
    connection: () => screen.getByRole('button', { name: /Connection/ }),
  };
}

describe('NewFromBacklogDialog', () => {
  it('picks the connection by host, ignoring ports, and names the project after the repository', async () => {
    const { user, repository, name, key, connection } = setup();
    expect(screen.getByRole('dialog', { name: 'New project from Backlog.md' })).toBeInTheDocument();
    expect(repository()).toHaveFocus();

    await user.type(repository(), 'git@gitlab.com:reddevs/payments.git');
    expect(screen.getByText('gitlab.com/reddevs/payments')).toBeInTheDocument();
    expect(within(connection()).getByText('GitLab · reddevs')).toBeInTheDocument();
    expect(name().value).toBe('payments');
    expect(key().value).toBe('PAY');

    await user.clear(repository());
    await user.type(repository(), 'http://localhost:3300/zamu-admin/notes-sync');
    expect(within(connection()).getByText('Forgejo local')).toBeInTheDocument();
    expect(name().value).toBe('notes-sync');
  });

  it('says when no connection reads the host', async () => {
    const { user, repository } = setup();
    await user.type(repository(), 'https://codeberg.org/ana/notes');
    expect(screen.getByText(/No connection reads codeberg\.org\./)).toBeInTheDocument();
  });

  it('fills name and key from detection: the prefix when it fits, else from the name', async () => {
    const detect = vi.fn<DetectRepository>().mockResolvedValue(detection('BACK', 'Payments API'));
    const { user, repository, name, key } = setup({ detect });
    await user.type(repository(), 'git@gitlab.com:reddevs/payments.git');
    expect(
      await screen.findByText((_, element) => element?.textContent === 'Found backlog/ on main'),
    ).toBeInTheDocument();
    expect(screen.getByText('412 tasks')).toBeInTheDocument();
    expect(screen.getByText('351 archived')).toBeInTheDocument();
    expect(name().value).toBe('Payments API');
    expect(key().value).toBe('BACK');
    expect(screen.getByText('From project_name in config.yml.')).toBeInTheDocument();
    expect(screen.getByText('From the prefix, so BACK-1 stays BACK-1.')).toBeInTheDocument();
    expect(detect).toHaveBeenCalledWith({
      repository: 'git@gitlab.com:reddevs/payments.git',
      connectionId: GITLAB.id,
    });
    // Typing waits for a pause: one read for the whole URL, and the focus stays put.
    expect(detect).toHaveBeenCalledTimes(1);
    expect(repository()).toHaveFocus();
  });

  it('counts the folders in the singular when there is one', async () => {
    const detect = vi.fn<DetectRepository>().mockResolvedValue({
      ...detection('PAY', 'Payments API'),
      folders: [
        { path: 'tasks/', count: 1, ignored: false },
        { path: 'drafts/', count: 1, ignored: false },
        { path: 'archive/tasks/', count: 1, ignored: false },
        { path: 'milestones/', count: 1, ignored: false },
      ],
    });
    const { user, repository } = setup({ detect });
    await user.type(repository(), 'git@gitlab.com:reddevs/payments.git');
    expect(await screen.findByText('1 task')).toBeInTheDocument();
    expect(screen.getByText('1 draft')).toBeInTheDocument();
    expect(screen.getByText('1 archived')).toBeInTheDocument();
    expect(screen.getByText('1 milestone')).toBeInTheDocument();
  });

  it('warns when the prefix is too long for a key', async () => {
    const detect = vi.fn<DetectRepository>().mockResolvedValue(detection('BACKLOG', 'Notes sync'));
    const { user, repository, key } = setup({ detect });
    await user.type(repository(), 'https://github.com/ana-ruiz/notes-sync.git');
    expect(
      await screen.findByText(
        'BACKLOG is 7 letters; keys have 2 to 6. Tasks read NOT-1, and BACKLOG-1 still finds them.',
      ),
    ).toBeInTheDocument();
    expect(key().value).toBe('NOT');
    // Frame 6c: the key field takes focus, and the warning stays while a key is typed.
    expect(key()).toHaveFocus();
    await user.clear(key());
    await user.type(key(), 'notes');
    expect(key().value).toBe('NOTES');
    expect(
      screen.getByText(
        'BACKLOG is 7 letters; keys have 2 to 6. Tasks read NOTES-1, and BACKLOG-1 still finds them.',
      ),
    ).toBeInTheDocument();
    expect(detect).toHaveBeenCalledTimes(1);
    expect(keyForDetection('BACKLOG', 'Notes sync')).toBe('NOT');
    expect(keyForDetection('PAY', 'Payments')).toBe('PAY');
  });

  it('submits the repository, connection, name, key and mode', async () => {
    const { user, repository, key, onSubmit } = setup();
    await user.type(repository(), 'git@gitlab.com:reddevs/payments.git');
    await user.clear(key());
    await user.type(key(), 'pay2');
    await user.click(screen.getByRole('radio', { name: /Import once/ }));
    await user.click(screen.getByRole('button', { name: /Create and continue/ }));
    expect(onSubmit).toHaveBeenCalledWith({
      repository: 'git@gitlab.com:reddevs/payments.git',
      connectionId: GITLAB.id,
      name: 'payments',
      key: 'PAY2',
      mode: 'import',
    });
  });

  it('shows field errors before sending', async () => {
    const { user, onSubmit, repository } = setup();
    await user.click(screen.getByRole('button', { name: /Create and continue/ }));
    expect(screen.getByText('Paste the repository URL.')).toBeInTheDocument();
    expect(screen.getByText('Pick a connection that reads this repository.')).toBeInTheDocument();
    expect(repository()).toHaveFocus();
    expect(onSubmit).not.toHaveBeenCalled();
  });

  it('puts server errors on their field', async () => {
    const onSubmit = vi
      .fn()
      .mockResolvedValue({ field: 'key', message: 'PAY is already used by another project.' });
    const { user, repository, key } = setup({ onSubmit });
    await user.type(repository(), 'git@gitlab.com:reddevs/payments.git');
    await user.click(screen.getByRole('button', { name: /Create and continue/ }));
    expect(await screen.findByText('PAY is already used by another project.')).toBeInTheDocument();
    expect(key()).toHaveFocus();
  });
});

describe('newFromBacklogFailure', () => {
  it('maps issues, conflicts and permissions', () => {
    const host = new SettingsError({
      code: 'UNPROCESSABLE_CONTENT',
      message: 'Forgejo local reads localhost:3300, but the repository is on gitlab.com',
      issues: [
        {
          path: 'connectionId',
          message: 'Forgejo local reads localhost:3300, but the repository is on gitlab.com',
        },
      ],
    });
    expect(newFromBacklogFailure(host, 'PAY')).toEqual({
      field: 'connectionId',
      message: 'Forgejo local reads localhost:3300, but the repository is on gitlab.com',
    });
    expect(
      newFromBacklogFailure(new SettingsError({ code: 'CONFLICT', message: 'x', issues: [] }), 'PAY'),
    ).toEqual({
      field: 'key',
      message: 'PAY is already used by another project. Pick another key.',
    });
    expect(
      newFromBacklogFailure(
        new SettingsError({
          code: 'FORBIDDEN',
          message: 'Only workspace admins can set up Backlog.md',
          issues: [],
        }),
        'PAY',
      ),
    ).toEqual({ message: 'Only workspace admins can set up Backlog.md' });
    expect(newFromBacklogFailure(new Error('offline'), 'PAY').message).toMatch(/Couldn't create the project/);
  });
});
