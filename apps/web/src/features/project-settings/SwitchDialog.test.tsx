// The switch to Zamu: every state of the check, the lock on the confirm field and button, the typed key,
// and the words the dialog and the page after it use.
import { render, screen, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { describe, expect, it, vi } from 'vitest';
import { OwnedView } from './BacklogSettings';
import { CONNECTION, sourceStatus } from './fixtures';
import { SwitchDialog } from './SwitchDialog';
import {
  checkingText,
  exportCommand,
  failureHeadline,
  keyMatches,
  loseText,
  noneOpenText,
  requestNumber,
  type SwitchCheck,
  type SwitchRequest,
  shownRequests,
} from './switch';

const CHECKED_AT = '2030-01-01T10:00:00Z';
const LIST_URL = 'https://gitlab.com/reddevs/payments/-/merge_requests';

function request(number: number, title: string, author: string | null, headBranch: string): SwitchRequest {
  return { number, title, author, headBranch, webUrl: `${LIST_URL}/${number}` };
}

const THREE = [
  request(214, 'Close the i18n tasks that shipped in 2.8', 'claude-dev', 'chore/close-i18n-tasks'),
  request(209, 'Split the offline cache task into three', 'tomas', 'feat/offline-cache'),
  request(201, 'Backlog cleanup: archive done tasks from October', null, 'chore/backlog-cleanup'),
];

function ok(requests: SwitchRequest[], truncated = false): SwitchCheck {
  return {
    ok: true,
    project: 'PAY',
    repository: 'gitlab.com/reddevs/payments',
    folder: 'backlog',
    requests,
    truncated,
    listUrl: LIST_URL,
    checkedAt: CHECKED_AT,
  };
}

function renderDialog(onCheck: () => Promise<SwitchCheck>, onSwitch = vi.fn().mockResolvedValue({})) {
  const onOpenChange = vi.fn();
  render(
    <SwitchDialog
      isOpen
      onOpenChange={onOpenChange}
      status={sourceStatus()}
      projectName="Payments"
      onCheck={onCheck}
      onSwitch={onSwitch}
    />,
  );
  const dialog = screen.getByRole('alertdialog', { name: 'Switch Payments to Zamu' });
  return {
    dialog,
    onOpenChange,
    onSwitch,
    field: () => within(dialog).getByLabelText('Type PAY to confirm'),
    button: () => within(dialog).getByRole('button', { name: 'Switch to Zamu' }),
  };
}

describe('Switch dialog', () => {
  it('locks the confirm field and the button while the check runs', () => {
    const { dialog, field, button } = renderDialog(() => new Promise(() => {}));
    expect(dialog).toHaveTextContent(
      'Zamu stops reading the task files in backlog/. All 412 tasks keep their numbers, comments and history and become editable here.',
    );
    expect(within(dialog).getByRole('status')).toHaveTextContent('Checking open merge requests on GitLab…');
    expect(field()).toBeDisabled();
    expect(button()).toBeDisabled();
    expect(dialog).toHaveTextContent('This can’t be undone.');
  });

  it('with nothing open, switches once the key is typed', async () => {
    const user = userEvent.setup();
    const { dialog, field, button, onSwitch, onOpenChange } = renderDialog(async () => ok([]));
    expect(
      await within(dialog).findByText('No open merge request changes the task files. Nothing will be lost.'),
    ).toBeVisible();
    expect(field()).toBeEnabled();
    expect(button()).toBeDisabled();
    await user.type(field(), 'PAX');
    expect(button()).toBeDisabled();
    await user.clear(field());
    await user.type(field(), ' pay ');
    expect(button()).toBeEnabled();
    await user.click(button());
    expect(onSwitch).toHaveBeenCalledWith('pay');
    expect(onOpenChange).toHaveBeenCalledWith(false);
  });

  it('lists the open requests with number, title, author and branch, and still lets the person confirm', async () => {
    const user = userEvent.setup();
    const { dialog, field, button, onSwitch } = renderDialog(async () => ok(THREE));
    expect(
      await within(dialog).findByText(
        '3 open merge requests change task files. Their task edits will be lost. Merge or close them first, or redo the edits in Zamu afterwards.',
      ),
    ).toBeVisible();
    const list = within(dialog).getByRole('list', { name: 'Open requests that change task files' });
    const rows = within(list).getAllByRole('listitem');
    expect(rows).toHaveLength(3);
    expect(rows[0]).toHaveTextContent('!214');
    expect(within(rows[0] as HTMLElement).getByRole('link', { name: THREE[0]?.title })).toHaveAttribute(
      'href',
      `${LIST_URL}/214`,
    );
    expect(within(rows[0] as HTMLElement).getByRole('img', { name: 'claude-dev' })).toBeVisible();
    expect(rows[0]).toHaveTextContent('chore/close-i18n-tasks');
    expect(within(rows[2] as HTMLElement).queryByRole('img')).toBeNull();
    expect(within(dialog).queryByText(/more$/)).toBeNull();
    await user.type(field(), 'PAY');
    expect(button()).toBeEnabled();
    await user.keyboard('{Enter}');
    expect(onSwitch).toHaveBeenCalledWith('PAY');
  });

  it('shows the first five of many and links to the host’s list', async () => {
    const forty = Array.from({ length: 40 }, (_, index) =>
      request(300 - index, `Task edits ${index + 1}`, 'claude-dev', `feat/edits-${index + 1}`),
    );
    const { dialog } = renderDialog(async () => ok(forty));
    expect(await within(dialog).findByText(/^40 open merge requests change task files\./)).toBeVisible();
    expect(within(dialog).getAllByRole('listitem')).toHaveLength(5);
    expect(within(dialog).getByText('35 more')).toBeVisible();
    expect(within(dialog).getByRole('link', { name: 'Open the list on GitLab ↗' })).toHaveAttribute(
      'href',
      LIST_URL,
    );
  });

  it('stays locked when the check fails, says why, and checks again on Try again', async () => {
    const user = userEvent.setup();
    const onCheck = vi
      .fn<() => Promise<SwitchCheck>>()
      .mockResolvedValueOnce({
        ok: false,
        project: 'PAY',
        reason: 'unreachable',
        message: 'gitlab.com did not answer in time.',
        checkedAt: CHECKED_AT,
      })
      .mockResolvedValueOnce(ok([]));
    const { dialog, field, button } = renderDialog(onCheck);
    const alert = await within(dialog).findByRole('alert');
    expect(alert).toHaveTextContent(
      'Couldn’t reach GitLab to check for open merge requests. gitlab.com did not answer in time.',
    );
    expect(dialog).toHaveTextContent(
      'The switch stays locked until the check works, so no edit is lost without you seeing it first.',
    );
    expect(field()).toBeDisabled();
    expect(button()).toBeDisabled();
    expect(within(dialog).queryByRole('button', { name: /without checking/i })).toBeNull();
    await user.click(within(alert).getByRole('button', { name: 'Try again' }));
    expect(onCheck).toHaveBeenCalledTimes(2);
    expect(await within(dialog).findByText(/^No open merge request/)).toBeVisible();
    expect(field()).toBeEnabled();
  });

  it('treats a check that throws as failed', async () => {
    const { dialog, field } = renderDialog(() => Promise.reject(new Error('offline')));
    expect(await within(dialog).findByRole('alert')).toHaveTextContent(/^The check didn’t finish\./);
    expect(field()).toBeDisabled();
  });

  it('keeps the dialog open with the error when the switch is refused', async () => {
    const user = userEvent.setup();
    const onSwitch = vi.fn().mockRejectedValue(new Error('Type PAY to confirm'));
    const { dialog, field, button, onOpenChange } = renderDialog(async () => ok([]), onSwitch);
    await within(dialog).findByText(/^No open merge request/);
    await user.type(field(), 'PAY');
    await user.click(button());
    expect(await within(dialog).findByRole('alert')).toBeVisible();
    expect(onOpenChange).not.toHaveBeenCalled();
    expect(button()).toBeEnabled();
  });
});

describe('After the switch', () => {
  it('says since when and by whom, offers the export command and names the linked repository', () => {
    const status = sourceStatus({
      state: 'detached',
      detachedAt: '2026-10-23T14:02:00Z',
      detachedBy: { id: '00000000-0000-7000-8000-0000000000a2', name: 'Tomás Berg', kind: 'person' },
    });
    render(<OwnedView status={status} projectName="Payments" />);
    const owned = screen.getByRole('note');
    expect(owned).toHaveTextContent(/Owned by Zamu since Oct 23/);
    expect(owned).toHaveTextContent('Switched by Tomás Berg. The task files are no longer read.');
    const copy = screen.getByRole('region', { name: 'Keep a copy as files' });
    expect(copy).toHaveTextContent(
      'This command writes Payments back out as Backlog.md task files, into the backlog/ folder of the repository you run it in.',
    );
    expect(within(copy).getByText('zamu backlog export --project PAY')).toBeVisible();
    expect(within(copy).getByRole('button', { name: 'Copy the export command' })).toBeVisible();
    const repository = screen.getByRole('region', { name: 'Repository' });
    expect(within(repository).getByRole('link', { name: 'gitlab.com/reddevs/payments' })).toHaveAttribute(
      'href',
      'https://gitlab.com/reddevs/payments',
    );
    expect(repository).toHaveTextContent('Still linked');
  });
});

describe('Switch words', () => {
  it('names requests the way each host does', () => {
    expect(requestNumber('gitlab', 12)).toBe('!12');
    expect(requestNumber('github', 12)).toBe('#12');
    expect(checkingText(CONNECTION)).toBe('Checking open merge requests on GitLab…');
    expect(checkingText({ provider: 'gitea', host: 'git.example.org' })).toBe(
      'Checking open pull requests on git.example.org…',
    );
    expect(noneOpenText('github')).toBe('No open pull request changes the task files. Nothing will be lost.');
    expect(failureHeadline({ provider: 'github', host: 'github.com' }, 'rejected')).toBe(
      'Couldn’t check GitHub for open pull requests.',
    );
  });

  it('says how many will be lost, one, many or at least', () => {
    expect(loseText('gitlab', 1, false)).toMatch(/^1 open merge request changes task files\. Its task edits/);
    expect(loseText('github', 3, false)).toMatch(/^3 open pull requests change task files\. Their/);
    expect(loseText('github', 3, true)).toMatch(/^At least 3 open pull requests change/);
  });

  it('shows six in full and cuts longer lists at five', () => {
    const six = THREE.concat(THREE.map((item) => ({ ...item, number: item.number + 1 })));
    expect(shownRequests(six)).toEqual({ shown: six, more: 0 });
    const seven = six.concat([request(1, 'x', null, 'x')]);
    expect(shownRequests(seven).shown).toHaveLength(5);
    expect(shownRequests(seven).more).toBe(2);
  });

  it('matches the key in any case and builds the export command', () => {
    expect(keyMatches(' hbr ', 'HBR')).toBe(true);
    expect(keyMatches('HB', 'HBR')).toBe(false);
    expect(exportCommand('HBR')).toBe('zamu backlog export --project HBR');
  });
});
