import { screen, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import type {
  BacklogDetection,
  BacklogMappingsView,
  BacklogPreview,
  BacklogSourceStatus,
  GitConnection,
  Invitation,
} from '@zamu/contracts';
import { useState } from 'react';
import { describe, expect, it, vi } from 'vitest';
import { renderInWorkspace as render } from '~/lib/testing';
import type { AgentSuggestion } from './agent-suggestions';
import type { InviteDraft } from './assignee-hints';
import { InviteFromMappings } from './InviteFromMappings';
import { MappingsEditor } from './MappingsStep';
import { ModeStep, type ModeStepProps } from './ModeStep';
import { PreviewStep } from './PreviewStep';
import { readPhase } from './phase';
import { ReadStep } from './ReadStep';
import { SourceStep, type SourceStepProps } from './SourceStep';

const USER = { id: '01a169ed-a7a5-712d-a08b-1e796a1ac801', name: 'Ana Ruiz', kind: 'person' as const };
const AGENT = { id: '01a169ed-a7a5-712d-a08b-1e796a1ac809', name: 'claude-dev', kind: 'agent' as const };

const CONNECTION: GitConnection = {
  id: '01a169ed-a7a5-712d-a08b-1e796a1ac802',
  name: 'GitLab · reddevs',
  provider: 'gitlab',
  host: 'gitlab.com',
  status: 'working',
  apiBaseUrl: 'https://gitlab.com/api/v4',
  tokenHint: 'abc',
  checkedAt: null,
  checkedLogin: 'reddevs-bot',
  checkedDetail: null,
  usedBy: [],
  createdBy: USER,
  createdAt: '2026-10-20T10:00:00.000Z',
  updatedAt: '2026-10-20T10:00:00.000Z',
};

const MAPPINGS: BacklogMappingsView = {
  status: [
    { from: 'To Do', to: 'todo', how: 'name', count: 24 },
    { from: 'Blocked', to: 'todo', how: 'fallback', count: 2 },
  ],
  priority: [{ from: 'high', to: 'high', how: 'name', count: 41 }],
  assignee: [{ from: '@claude', userId: AGENT.id, how: 'name', count: 219, user: AGENT }],
};

function detection(overrides: Partial<BacklogDetection> = {}): BacklogDetection {
  return {
    repository: 'gitlab.com/reddevs/payments',
    access: 'ok',
    defaultBranch: 'main',
    headCommit: 'a1b2c3d4e5f6',
    headCommittedAt: null,
    folder: 'backlog',
    folderSource: 'default',
    config: {
      projectName: 'Payments API',
      taskPrefix: 'BACK',
      statuses: ['To Do', 'In Progress', 'Review', 'Done', 'Won’t do', 'Blocked'],
      defaultStatus: 'To Do',
      priorities: ['high'],
      labels: [],
      milestones: [],
      zeroPaddedIds: null,
    },
    configError: null,
    folders: [
      { path: 'docs/', count: 14, ignored: true },
      { path: 'archive/tasks/', count: 339, ignored: false },
      { path: 'tasks/', count: 371, ignored: false },
    ],
    keyMatchesPrefix: false,
    mappings: MAPPINGS,
    ...overrides,
  };
}

function renderSource(props: Partial<SourceStepProps> = {}) {
  const all: SourceStepProps = {
    projectKey: 'PAY',
    projectName: 'Payments',
    repository: 'git@gitlab.com:reddevs/payments.git',
    settingsHref: '/p/PAY/settings',
    connections: [CONNECTION],
    connectionsError: null,
    encryptionReady: true,
    connectionId: CONNECTION.id,
    onConnectionChange: vi.fn(),
    detection: detection(),
    detectionPending: false,
    detectionError: null,
    onRetryDetection: vi.fn(),
    folder: undefined,
    onFolderChange: vi.fn(),
    ...props,
  };
  render(<SourceStep {...all} />);
  return all;
}

describe('ModeStep', () => {
  const base: ModeStepProps = {
    projectKey: 'PAY',
    projectName: 'Payments',
    mode: 'mirror',
    onModeChange: vi.fn(),
    taskCount: 0,
    taskCountError: false,
    onRetry: vi.fn(),
    onNewFromBacklog: vi.fn(),
    onBackToProject: vi.fn(),
  };

  it('says an empty project can take the Backlog.md numbers', async () => {
    const onModeChange = vi.fn();
    render(<ModeStep {...base} onModeChange={onModeChange} />);
    expect(screen.getByText('How should Payments use the Backlog.md files?')).toBeInTheDocument();
    expect(screen.getByRole('radio', { name: /Mirror/ })).toBeChecked();
    expect(
      screen.getByText('Payments has no tasks yet, so Backlog.md numbers can become its task keys.'),
    ).toBeInTheDocument();
    await userEvent.setup().click(screen.getByRole('radio', { name: /Import once/ }));
    expect(onModeChange).toHaveBeenCalledWith('import');
  });

  it('refuses a project with tasks and offers a new project', async () => {
    const onNewFromBacklog = vi.fn();
    render(<ModeStep {...base} taskCount={12} onNewFromBacklog={onNewFromBacklog} />);
    const alert = screen.getByRole('alert');
    expect(alert).toHaveTextContent(
      'Payments already has 12 tasks. Mirror and import need a project with no tasks, because Backlog.md numbers become the task keys and would collide with PAY-1 to PAY-12.',
    );
    await userEvent.setup().click(within(alert).getByRole('button', { name: 'New project from Backlog.md' }));
    expect(onNewFromBacklog).toHaveBeenCalled();
  });
});

describe('SourceStep', () => {
  it('shows the branch, the folder with its counts in order, and the key note', () => {
    renderSource();
    expect(screen.getByText('main')).toBeInTheDocument();
    expect(screen.getByText(/at a1b2c3d/)).toBeInTheDocument();
    expect(screen.getByText(/Found a Backlog\.md folder at/)).toHaveTextContent('backlog/');
    expect(screen.getByText(/task prefix/)).toHaveTextContent(
      'Project “Payments API”, task prefix BACK, 6 statuses.',
    );
    const counts = screen.getByText('tasks/ 371').parentElement as HTMLElement;
    expect([...counts.children].map((child) => child.textContent)).toEqual([
      'tasks/ 371',
      'archive/tasks/ 339',
      'docs/ 14 · ignored',
    ]);
    expect(screen.getByText(/becomes/)).toHaveTextContent(
      'BACK-1 becomes PAY-1. Search and zamu accept both. To keep them identical, change the project key to BACK in General first.',
    );
    expect(screen.getByLabelText('Repository')).toHaveValue('gitlab.com/reddevs/payments');
  });

  it('warns when the prefix cannot be a project key', () => {
    renderSource({
      detection: detection({
        config: { ...(detection().config as NonNullable<BacklogDetection['config']>), taskPrefix: 'BACKLOG' },
      }),
    });
    expect(screen.getByText(/is longer than a project key can be/)).toHaveTextContent(
      'The task prefix BACKLOG is longer than a project key can be (2 to 6 letters). Tasks get the key PAY: BACKLOG-1 becomes PAY-1. Search and zamu still accept BACKLOG-1.',
    );
  });

  it('explains a token that cannot see the repository', () => {
    renderSource({
      detection: detection({ access: 'not_found', defaultBranch: null, folder: null, config: null }),
    });
    expect(screen.getByRole('alert')).toHaveTextContent(
      "GitLab · reddevs can't read this repository. gitlab.com answered 404 for reddevs/payments. Give the token's user, reddevs-bot, at least the Reporter role in the project, or pick another connection.",
    );
  });

  it('asks for the folder when none is found, and looks again with it', async () => {
    const onFolderChange = vi.fn();
    renderSource({
      detection: detection({ folder: null, folderSource: null, config: null }),
      onFolderChange,
    });
    expect(screen.getByRole('alert')).toHaveTextContent(
      'No Backlog.md folder on main. Looked for backlog_directory in backlog.config.yml, then backlog/, then .backlog/.',
    );
    const user = userEvent.setup();
    await user.type(screen.getByLabelText('Folder'), './docs/backlog/');
    await user.click(screen.getByRole('button', { name: 'Look again' }));
    expect(onFolderChange).toHaveBeenCalledWith('docs/backlog');
  });

  it('says when the project has no repository', () => {
    renderSource({ repository: null, detection: undefined });
    expect(screen.getByRole('alert')).toHaveTextContent(
      'Payments has no repository. The setup reads the Backlog.md files from it. Link one in General first.',
    );
  });
});

const UNMATCHED_ASSIGNEES: BacklogMappingsView = {
  ...MAPPINGS,
  assignee: [
    { from: '@claude', userId: null, how: 'fallback', count: 219, user: null },
    { from: '@ana', userId: USER.id, how: 'name', count: 64, user: USER },
    { from: '@francis', userId: null, how: 'fallback', count: 5, user: null },
  ],
};

function Harness({ onChange }: { onChange: (view: BacklogMappingsView) => void }) {
  const [view, setView] = useState(MAPPINGS);
  return (
    <MappingsEditor
      view={view}
      onChange={(next) => {
        setView(next);
        onChange(next);
      }}
      members={[USER, AGENT]}
    />
  );
}

describe('MappingsEditor', () => {
  it('prefills by name, flags fallbacks, and turns a pick into a manual row', async () => {
    const onChange = vi.fn();
    render(<Harness onChange={onChange} />);
    const status = screen.getByRole('group', { name: 'Status mapping' });
    expect(within(status).getAllByText('by name')).toHaveLength(1);
    expect(within(status).getByText('fallback')).toBeInTheDocument();

    const user = userEvent.setup();
    await user.click(screen.getByRole('button', { name: /Blocked maps to/ }));
    await user.click(screen.getByRole('option', { name: /In progress/ }));
    expect(onChange).toHaveBeenLastCalledWith(
      expect.objectContaining({
        status: [MAPPINGS.status[0], { from: 'Blocked', to: 'in_progress', how: 'manual', count: 2 }],
      }),
    );
    expect(within(status).queryByText('fallback')).not.toBeInTheDocument();
  });

  const UNMATCHED: BacklogMappingsView = {
    ...MAPPINGS,
    assignee: [
      { from: '@claude', userId: null, how: 'fallback', count: 219, user: null },
      { from: '@ana', userId: USER.id, how: 'name', count: 64, user: USER },
      { from: '@francis', userId: null, how: 'fallback', count: 5, user: null },
    ],
  };

  it('suggests creating an agent for an unmatched agent name', async () => {
    const onCreateAgent = vi.fn();
    render(
      <MappingsEditor
        view={UNMATCHED}
        onChange={vi.fn()}
        members={[USER, AGENT]}
        onCreateAgent={onCreateAgent}
      />,
    );
    const note = screen.getByRole('region', { name: 'Agent suggestions' });
    expect(note).toHaveTextContent('This looks like a coding agent. No member matches it yet.');
    expect(note).toHaveTextContent('@claude');
    expect(note).not.toHaveTextContent('@francis');

    await userEvent.setup().click(within(note).getByRole('button', { name: 'Create agent claude' }));
    expect(onCreateAgent).toHaveBeenCalledWith({ name: 'claude', from: ['@claude'], count: 219 });
  });

  it('offers Create agent in the menu of every unmatched row', async () => {
    const onChange = vi.fn();
    const onCreateAgent = vi.fn();
    render(
      <MappingsEditor view={UNMATCHED} onChange={onChange} members={[USER]} onCreateAgent={onCreateAgent} />,
    );
    const user = userEvent.setup();

    await user.click(screen.getByRole('button', { name: /@ana maps to/ }));
    expect(screen.queryByRole('option', { name: /Create agent/ })).not.toBeInTheDocument();
    await user.keyboard('{Escape}');

    await user.click(screen.getByRole('button', { name: /@francis maps to/ }));
    await user.click(screen.getByRole('option', { name: 'Create agent francis…' }));
    expect(onCreateAgent).toHaveBeenCalledWith({ name: 'francis', from: ['@francis'], count: 0 });
    expect(onChange).not.toHaveBeenCalled();
  });

  it('suggests nothing without a way to create agents, or when the agent exists', () => {
    const { unmount } = render(<MappingsEditor view={UNMATCHED} onChange={vi.fn()} members={[USER]} />);
    expect(screen.queryByRole('region', { name: 'Agent suggestions' })).not.toBeInTheDocument();
    unmount();

    const claude = { id: '01a169ed-a7a5-712d-a08b-1e796a1ac80a', name: 'claude', kind: 'agent' as const };
    render(
      <MappingsEditor view={UNMATCHED} onChange={vi.fn()} members={[USER, claude]} onCreateAgent={vi.fn()} />,
    );
    expect(screen.queryByRole('region', { name: 'Agent suggestions' })).not.toBeInTheDocument();
  });
});

// The Mappings step of the setup and Edit mappings render the same editor, with the screen state
// BacklogSetupScreen keeps: the open invite dialog and the invitations made on the screen.
const SCREENS = [
  { screen: 'Setup', aside: undefined, title: undefined },
  { screen: 'Edit mappings', aside: 'The next refresh applies them to every task.', title: undefined },
] as const;

const TOMAS = {
  id: '01a169ed-a7a5-712d-a08b-1e796a1ac803',
  name: 'Tomás Berg',
  kind: 'person' as const,
  email: 'tberg@example.com',
};
const agentMember = (name: string, joinedAt: string, n: number) => ({
  id: `01a169ed-a7a5-712d-a08b-1e796a1ac8${String(n).padStart(2, '0')}`,
  name,
  kind: 'agent' as const,
  email: null,
  joinedAt,
});

const INVITATION: Invitation = {
  id: 'inv-1',
  email: 'francis@example.com',
  role: 'member',
  status: 'pending',
  invitedBy: { id: USER.id, name: USER.name, kind: 'person' },
  link: 'http://localhost:3000/invite/inv-1',
  expiresAt: '2026-11-03T10:00:00.000Z',
  createdAt: '2026-10-27T10:00:00.000Z',
};

function ScreenHarness({
  initial,
  members,
  aside,
  onChange = () => {},
  onCreateAgent = () => {},
  onSubmitInvite = async () => INVITATION,
}: {
  initial: BacklogMappingsView;
  members: Parameters<typeof MappingsEditor>[0]['members'];
  aside?: string | undefined;
  onChange?: (view: BacklogMappingsView) => void;
  onCreateAgent?: (draft: AgentSuggestion) => void;
  onSubmitInvite?: Parameters<typeof InviteFromMappings>[0]['onSubmit'];
}) {
  const [view, setView] = useState(initial);
  const [inviteDraft, setInviteDraft] = useState<InviteDraft | null>(null);
  const [invited, setInvited] = useState<Record<string, string>>({});
  return (
    <>
      <MappingsEditor
        view={view}
        onChange={(next) => {
          setView(next);
          onChange(next);
        }}
        members={members}
        {...(aside ? { aside } : {})}
        onCreateAgent={onCreateAgent}
        onInvite={setInviteDraft}
        invited={invited}
      />
      <InviteFromMappings
        draft={inviteDraft}
        onClose={() => setInviteDraft(null)}
        onSubmit={onSubmitInvite}
        onCreated={(draft, invitation) => setInvited((all) => ({ ...all, [draft.from]: invitation.email }))}
      />
    </>
  );
}

const noteLine = (section: string, text: string | RegExp) => {
  const note = screen.getByRole('region', { name: section });
  const line = within(note)
    .getAllByRole('listitem')
    .find((item) =>
      typeof text === 'string' ? item.textContent?.includes(text) : text.test(item.textContent ?? ''),
    );
  if (!line) throw new Error(`No line with ${String(text)} in ${section}`);
  return line;
};

describe.each(SCREENS)('Assignee note on $screen', ({ aside }) => {
  const CLAUDE_DEV = agentMember('claude-dev', '2026-10-01T10:00:00.000Z', 10);

  it('offers a similar agent for an unmatched agent name, and still offers to create one', async () => {
    const onChange = vi.fn();
    const onCreateAgent = vi.fn();
    render(
      <ScreenHarness
        initial={UNMATCHED_ASSIGNEES}
        members={[USER, CLAUDE_DEV]}
        aside={aside}
        onChange={onChange}
        onCreateAgent={onCreateAgent}
      />,
    );
    const line = noteLine('Agent suggestions', '@claude');
    expect(line).toHaveTextContent('@claude may be claude-dev.');
    const user = userEvent.setup();

    await user.click(within(line).getByRole('button', { name: 'Create agent claude' }));
    expect(onCreateAgent).toHaveBeenCalledWith({ name: 'claude', from: ['@claude'], count: 219 });

    await user.click(within(line).getByRole('button', { name: 'Map to claude-dev' }));
    expect(onChange).toHaveBeenLastCalledWith(
      expect.objectContaining({
        assignee: [
          { from: '@claude', userId: CLAUDE_DEV.id, how: 'manual', count: 219, user: null },
          UNMATCHED_ASSIGNEES.assignee[1],
          UNMATCHED_ASSIGNEES.assignee[2],
        ],
      }),
    );
    // Mapped: the suggestion is gone.
    expect(screen.queryByRole('region', { name: 'Agent suggestions' })).not.toBeInTheDocument();
  });

  it('maps every spelling of the value to the similar agent', async () => {
    const onChange = vi.fn();
    const twoSpellings: BacklogMappingsView = {
      ...MAPPINGS,
      assignee: [
        { from: '@claude-code', userId: null, how: 'fallback', count: 3, user: null },
        { from: '@Claude_Code', userId: null, how: 'fallback', count: 2, user: null },
      ],
    };
    const claudeCi = agentMember('claude-ci', '2026-10-01T10:00:00.000Z', 11);
    render(<ScreenHarness initial={twoSpellings} members={[claudeCi]} aside={aside} onChange={onChange} />);
    const line = noteLine('Agent suggestions', '@claude-code');
    expect(line).toHaveTextContent('@claude-code, @Claude_Code may be claude-ci.');
    await userEvent.setup().click(within(line).getByRole('button', { name: 'Map to claude-ci' }));
    expect(
      onChange.mock.lastCall?.[0].assignee.map((r: { userId: string; how: string }) => [r.userId, r.how]),
    ).toEqual([
      [claudeCi.id, 'manual'],
      [claudeCi.id, 'manual'],
    ]);
  });

  it('offers no similar agent when none shares the agent word', () => {
    const codexCi = agentMember('codex-ci', '2026-10-01T10:00:00.000Z', 12);
    render(<ScreenHarness initial={UNMATCHED_ASSIGNEES} members={[USER, codexCi]} aside={aside} />);
    const line = noteLine('Agent suggestions', '@claude');
    expect(line).not.toHaveTextContent('may be');
    expect(within(line).queryByRole('button', { name: /Map to/ })).not.toBeInTheDocument();
    expect(within(line).getByRole('button', { name: 'Create agent claude' })).toBeInTheDocument();
  });

  it('caps similar agents at three, newest first, in the note and under Create agent in the select', async () => {
    const agents = [
      agentMember('claude-dev', '2026-10-01T10:00:00.000Z', 20),
      agentMember('claude-ci', '2026-10-20T10:00:00.000Z', 21),
      agentMember('claude-ops', '2026-10-10T10:00:00.000Z', 22),
      agentMember('claude-review', '2026-10-26T10:00:00.000Z', 23),
    ];
    render(<ScreenHarness initial={UNMATCHED_ASSIGNEES} members={[USER, ...agents]} aside={aside} />);
    const line = noteLine('Agent suggestions', '@claude');
    expect(line).toHaveTextContent('@claude may be claude-review, claude-ci or claude-ops.');
    expect(
      within(line)
        .getAllByRole('button')
        .map((b) => b.textContent),
    ).toEqual(['Map to claude-review', 'Map to claude-ci', 'Map to claude-ops', 'Create agent claude']);

    const user = userEvent.setup();
    await user.click(screen.getByRole('button', { name: /@claude maps to/ }));
    const order = [
      'Create agent claude…',
      'claude-review',
      'claude-ci',
      'claude-ops',
      'No one',
      'Ana Ruiz',
      'claude-dev',
    ];
    expect(screen.getAllByRole('option')).toEqual(order.map((name) => screen.getByRole('option', { name })));
    await user.click(screen.getByRole('option', { name: 'claude-ci' }));
    expect(screen.getByRole('button', { name: /@claude maps to/ })).toHaveTextContent('claude-ci');
  });

  it('invites a person for an unmatched value, then says how to map it', async () => {
    const onSubmitInvite = vi.fn(async () => INVITATION);
    render(
      <ScreenHarness
        initial={UNMATCHED_ASSIGNEES}
        members={[USER]}
        aside={aside}
        onSubmitInvite={onSubmitInvite}
      />,
    );
    const note = screen.getByRole('region', { name: 'People to invite' });
    expect(note).toHaveTextContent('No member matches this name yet.');
    const line = noteLine('People to invite', '@francis');
    expect(line).toHaveTextContent('@francis matches no member.');
    expect(note).not.toHaveTextContent('@claude');

    const user = userEvent.setup();
    await user.click(within(line).getByRole('button', { name: 'Invite…' }));
    const dialog = await screen.findByRole('dialog', { name: 'Invite person' });
    expect(dialog).toHaveTextContent('For @francis in the files (5 tasks).');
    expect(within(dialog).getByRole('button', { name: /Role/ })).toHaveTextContent('Member');

    await user.type(within(dialog).getByRole('textbox', { name: 'Email' }), 'francis@example.com');
    await user.click(within(dialog).getByRole('button', { name: 'Create invitation link' }));
    expect(onSubmitInvite).toHaveBeenCalledWith({ email: 'francis@example.com', role: 'member' });
    const link = await screen.findByRole('dialog', { name: 'Invitation link' });
    await user.click(within(link).getByRole('button', { name: 'Done' }));

    const invited = noteLine('People to invite', '@francis');
    expect(invited).toHaveTextContent(
      'Invited francis@example.com. Once they join, map @francis in Settings › Backlog.md › Edit mappings.',
    );
    expect(within(invited).queryByRole('button')).not.toBeInTheDocument();
    // The row stays No one.
    expect(screen.getByRole('button', { name: /@francis maps to/ })).toHaveTextContent('No one');
  });

  it('suggests the member a No one row names', async () => {
    const onChange = vi.fn();
    const stored: BacklogMappingsView = {
      ...MAPPINGS,
      assignee: [
        { from: '@tberg', userId: null, how: 'fallback', count: 7, user: null },
        { from: '@francis', userId: null, how: 'fallback', count: 5, user: null },
      ],
    };
    render(<ScreenHarness initial={stored} members={[USER, TOMAS]} aside={aside} onChange={onChange} />);
    const line = noteLine('Name matches', '@tberg');
    expect(line).toHaveTextContent('@tberg may be Tomás Berg.');
    // The name match replaces the invite line for that value.
    expect(screen.getByRole('region', { name: 'People to invite' })).not.toHaveTextContent('@tberg');

    await userEvent.setup().click(within(line).getByRole('button', { name: 'Map to Tomás Berg' }));
    expect(onChange).toHaveBeenLastCalledWith(
      expect.objectContaining({
        assignee: [
          { from: '@tberg', userId: TOMAS.id, how: 'manual', count: 7, user: null },
          stored.assignee[1],
        ],
      }),
    );
    expect(screen.queryByRole('region', { name: 'Name matches' })).not.toBeInTheDocument();
  });

  it('suggests no member when two match', () => {
    const stored: BacklogMappingsView = {
      ...MAPPINGS,
      assignee: [{ from: '@sam', userId: null, how: 'fallback', count: 2, user: null }],
    };
    const sams = [
      { id: 'u-sam1', name: 'Sam', kind: 'person' as const, email: 'sam.one@example.com' },
      { id: 'u-sam2', name: 'Sam', kind: 'person' as const, email: 'sam.two@example.com' },
    ];
    render(<ScreenHarness initial={stored} members={sams} aside={aside} />);
    expect(screen.queryByRole('region', { name: 'Name matches' })).not.toBeInTheDocument();
    expect(noteLine('People to invite', '@sam')).toHaveTextContent('@sam matches no member.');
  });
});

const PREVIEW: BacklogPreview = {
  commit: 'a1b2c3d4e5f6',
  defaultBranch: 'main',
  counts: {
    tasks: 38,
    open: 30,
    drafts: 23,
    archived: 351,
    completed: 12,
    subtasks: 41,
    milestones: 4,
    archivedMilestones: 2,
  },
  sample: [
    {
      backlogId: 'BACK-786',
      key: 'PAY-786',
      title: 'Retry failed webhook deliveries',
      status: 'in_progress',
      kind: 'task',
    },
    { backlogId: 'BACK-786.1', key: 'PAY-786.1', title: 'Honour Retry-After', status: 'todo', kind: 'task' },
    {
      backlogId: 'BACK-12',
      key: 'PAY-12',
      title: 'Split the ledger writer',
      status: 'done',
      kind: 'archived',
    },
  ],
  files: [
    {
      kind: 'file',
      path: 'backlog/tasks/back-233 - Retry-SEPA-mandates.md',
      backlogId: 'BACK-233',
      skipped: true,
      message: 'frontmatter is not valid YAML (line 4)',
    },
    {
      kind: 'file',
      path: 'backlog/tasks/back-5 - Dates.md',
      backlogId: 'BACK-5',
      skipped: false,
      message: 'created_date "yesterday" is not a date Backlog.md writes (line 5)',
    },
  ],
  fallbacks: [
    { kind: 'value', field: 'status', value: 'Blocked', count: 2, fallback: 'Todo', message: '' },
    { kind: 'value', field: 'assignee', value: '@francis', count: 5, fallback: 'No one', message: '' },
  ],
};

describe('PreviewStep', () => {
  it('counts every task the read creates and lists skips, warnings and fallbacks', () => {
    render(<PreviewStep mode="mirror" projectKey="PAY" projectName="Payments" preview={PREVIEW} />);
    expect(screen.getByText('Mirror 412 tasks into Payments?')).toBeInTheDocument();
    expect(screen.getByText('From commit a1b2c3d on main')).toBeInTheDocument();
    expect(screen.getByText('53 open')).toBeInTheDocument();
    expect(screen.getByText('incl. 12 in completed/')).toBeInTheDocument();
    expect(screen.getByText('keys like PAY-786.1')).toBeInTheDocument();
    expect(screen.getByText('2 archived → Completed')).toBeInTheDocument();
    expect(screen.getByText('First 3 of 412, in Backlog.md order')).toBeInTheDocument();
    expect(screen.getByText('Done · archived')).toBeInTheDocument();
    expect(
      within(screen.getByRole('list', { name: 'Will be skipped' })).getAllByRole('listitem'),
    ).toHaveLength(1);
    expect(
      within(screen.getByRole('list', { name: 'Read with a warning' })).getAllByRole('listitem'),
    ).toHaveLength(1);
    const fallbacks = screen.getByRole('list', { name: 'Fallbacks' });
    expect(fallbacks).toHaveTextContent('Status Blocked on 2 tasks shows as Todo.');
    expect(fallbacks).toHaveTextContent(
      '@francis on 5 tasks matches no member; they stay unassigned and keep the name in their Backlog.md section.',
    );
  });

  it('asks about an import in the heading', () => {
    render(<PreviewStep mode="import" projectKey="PAY" projectName="Payments" preview={PREVIEW} />);
    expect(screen.getByText('Import 412 tasks into Payments?')).toBeInTheDocument();
  });
});

function status(overrides: Partial<BacklogSourceStatus> = {}): BacklogSourceStatus {
  return {
    id: '01a169ed-a7a5-712d-a08b-1e796a1ac8aa',
    project: { id: '01a169ed-a7a5-712d-a08b-1e796a1ac8bb', key: 'PAY', name: 'Payments' },
    mode: 'mirror',
    state: 'healthy',
    repository: 'git@gitlab.com:reddevs/payments.git',
    defaultBranch: 'main',
    folder: 'backlog',
    folderOverride: null,
    prefix: 'BACK',
    connection: {
      id: CONNECTION.id,
      name: CONNECTION.name,
      provider: 'gitlab',
      host: 'gitlab.com',
      status: 'working',
    },
    headCommit: 'a1b2c3d4e5f6',
    lastRead: {
      at: '2026-10-23T10:00:38.000Z',
      trigger: 'setup',
      commit: 'a1b2c3d4e5f6',
      commitUrl: null,
      commitTitle: null,
    },
    lastAttemptAt: '2026-10-23T10:00:00.000Z',
    lastTrigger: 'setup',
    lastError: null,
    nextPollAt: null,
    webhookLastAt: null,
    counts: { tasks: 38, open: 30, drafts: 23, archived: 351, subtasks: 41, milestones: 6, hidden: 0 },
    problems: { items: [], nextCursor: null, counts: { files: 6, values: 2 } },
    mappings: MAPPINGS,
    config: null,
    createdBy: USER,
    createdAt: '2026-10-23T10:00:00.000Z',
    detachedAt: null,
    detachedBy: null,
    history: [],
    ...overrides,
  };
}

describe('ReadStep', () => {
  const props = {
    projectName: 'Payments',
    settingsHref: '/p/PAY/settings',
    webhookHref: '/p/PAY/settings/backlog?webhook=1',
    expected: { tasks: null, milestones: 6 },
  };

  it('knows when the first read is over', () => {
    expect(readPhase(status({ state: 'setup' }))).toBe('reading');
    expect(readPhase(status({ state: 'warnings' }))).toBe('done');
    expect(readPhase(status({ state: 'failed' }))).toBe('failed');
    expect(readPhase(status({ mode: 'import', state: 'detached' }))).toBe('done');
    expect(readPhase(status({ mode: 'mirror', state: 'detached' }))).toBe('detached');
  });

  it('shows progress while reading', () => {
    render(<ReadStep {...props} status={status({ state: 'setup', headCommit: null, lastRead: null })} />);
    expect(screen.getByText('Reading Backlog.md…')).toBeInTheDocument();
    expect(screen.getByText('Creating 6 milestones')).toBeInTheDocument();
    expect(screen.getByRole('progressbar', { name: 'First read' })).toBeInTheDocument();
  });

  it('ends a mirror on the done state with the webhook card', () => {
    render(<ReadStep {...props} status={status()} />);
    expect(screen.getByText('Payments now mirrors gitlab.com/reddevs/payments')).toBeInTheDocument();
    expect(
      screen.getByText(/412 tasks and 6 milestones, read from commit a1b2c3d in 38 seconds\./),
    ).toHaveTextContent(
      "6 files were skipped or read with a warning; they're listed in Settings → Backlog.md.",
    );
    expect(screen.getByText(/Add a webhook in GitLab/)).toBeInTheDocument();
    expect(screen.getByRole('link', { name: 'Set up the webhook' })).toHaveAttribute(
      'href',
      '/p/PAY/settings/backlog?webhook=1',
    );
  });

  it('ends an import detached, without the webhook card', () => {
    render(<ReadStep {...props} status={status({ mode: 'import', state: 'detached' })} />);
    expect(screen.getByText('Payments imported gitlab.com/reddevs/payments')).toBeInTheDocument();
    expect(screen.queryByText('Refresh on every push')).not.toBeInTheDocument();
  });

  it('says why the first read failed', () => {
    render(
      <ReadStep {...props} status={status({ state: 'failed', lastError: 'config.yml is not valid YAML' })} />,
    );
    expect(screen.getByRole('alert')).toHaveTextContent(
      'Nothing was written to Payments. config.yml is not valid YAML. Fix it, then use Refresh now in Settings → Backlog.md.',
    );
  });
});
