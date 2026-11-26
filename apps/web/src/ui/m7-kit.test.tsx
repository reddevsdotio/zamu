import { render, screen, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { describe, expect, it, vi } from 'vitest';
import { ArchivedBar, ArchivedTag } from './Archived';
import { CheckAgainChip, CheckAgainReason, checkAgainState, checkAgainText } from './CheckAgain';
import {
  BranchLine,
  FlagLine,
  mergedOpenText,
  PullRequestBox,
  PullRequestList,
  PullRequestRow,
  type PullRequestRowProps,
  REQUEST_STATES,
  RequestMarker,
  RequestStatePill,
  requestRef,
} from './PullRequests';
import { HostSteps, WebhookStatusLine } from './RepositoryWebhook';

// Kit pieces of M7: request rows and pills, the branch and flag lines, check-again chips, the archived bar
// and tag, the webhook status line and the per-host setup steps. Days are fixed strings: no test reads the
// real clock.

const TODAY = '2026-11-26';

function Row(props: Partial<PullRequestRowProps>) {
  return (
    <PullRequestBox>
      <PullRequestList>
        <PullRequestRow
          provider="github"
          number={482}
          title="Retry failed payouts with backoff"
          state="open"
          how="branch"
          branch="feat/payout-retries"
          url="https://github.com/northwind/payments/pull/482"
          {...props}
        />
      </PullRequestList>
    </PullRequestBox>
  );
}

describe('RequestStatePill', () => {
  it('says each state in words', () => {
    render(
      <div>
        {REQUEST_STATES.map((state) => (
          <RequestStatePill key={state} state={state} />
        ))}
      </div>,
    );
    for (const word of ['Open', 'Draft', 'Merged', 'Closed']) {
      expect(screen.getByText(word)).toBeInTheDocument();
    }
    expect(screen.getByText('Draft')).toHaveAttribute('data-state', 'draft');
    expect(screen.getByText('Draft').className).toContain('border-dashed');
    // Colour backs the word and is never the danger colour.
    expect(screen.getByText('Closed').className).not.toContain('danger');
  });
});

describe('PullRequestRow', () => {
  it('shows the host, number, title, how it was linked and the state in a list', () => {
    render(<Row />);
    const list = screen.getByRole('list', { name: 'Pull requests' });
    const item = within(list).getByRole('listitem');
    expect(within(item).getByRole('img', { name: 'GitHub' })).toBeInTheDocument();
    expect(item).toHaveTextContent('#482');
    expect(item).toHaveTextContent('Retry failed payouts with backoff');
    expect(item).toHaveTextContent('started on');
    expect(within(item).getByText('feat/payout-retries').tagName).toBe('CODE');
    expect(within(item).getByText('Open')).toBeInTheDocument();
  });

  it('names how a request was linked', () => {
    const { rerender } = render(<Row how="description" />);
    expect(screen.getByText('named in the description')).toBeInTheDocument();
    rerender(<Row how="hand" />);
    expect(screen.getByText('linked by hand')).toBeInTheDocument();
    expect(screen.queryByText('feat/payout-retries')).toBeNull();
  });

  it('links to the request on its host', () => {
    render(<Row />);
    const link = screen.getByRole('link', { name: 'Open #482 on GitHub' });
    expect(link).toHaveAttribute('href', 'https://github.com/northwind/payments/pull/482');
    expect(link).toHaveAttribute('target', '_blank');
    expect(link).toHaveAttribute('rel', 'noreferrer');
  });

  it('removes the link with the button, by pointer and by keyboard', async () => {
    const user = userEvent.setup();
    const onRemove = vi.fn();
    render(<Row onRemove={onRemove} />);
    const remove = screen.getByRole('button', { name: 'Unlink #482' });
    await user.click(remove);
    expect(onRemove).toHaveBeenCalledTimes(1);
    expect(remove).toHaveFocus();
    // Tab order: remove, then the link to the host.
    await user.tab();
    expect(screen.getByRole('link', { name: 'Open #482 on GitHub' })).toHaveFocus();
    await user.tab({ shift: true });
    expect(remove).toHaveFocus();
    await user.keyboard('{Enter}');
    expect(onRemove).toHaveBeenCalledTimes(2);
  });

  it('hides remove until the row is hovered or focused', () => {
    render(<Row onRemove={() => {}} />);
    const remove = screen.getByRole('button', { name: 'Unlink #482' });
    expect(remove.className).toContain('opacity-0');
    expect(remove.className).toContain('group-hover/prq:opacity-100');
    expect(remove.className).toContain('group-focus-within/prq:opacity-100');
  });

  it('has no remove button on a read-only task', () => {
    render(<Row />);
    expect(screen.queryByRole('button', { name: /Unlink/ })).toBeNull();
  });

  it('draws the dimmed preview with its hint and no actions', () => {
    render(
      <PullRequestBox>
        <PullRequestRow
          provider="github"
          number={485}
          title="Runbook entry for payout retries"
          state="draft"
          hint="Enter links it"
          url="https://github.com/northwind/payments/pull/485"
          onRemove={() => {}}
          preview
        />
      </PullRequestBox>,
    );
    expect(screen.getByText('Enter links it')).toBeInTheDocument();
    expect(screen.getByText('Draft')).toBeInTheDocument();
    expect(screen.queryByRole('button')).toBeNull();
    expect(screen.queryByRole('link')).toBeNull();
    expect(screen.queryByRole('listitem')).toBeNull();
  });

  it('numbers GitLab merge requests with !', () => {
    expect(requestRef('gitlab', 12)).toBe('!12');
    expect(requestRef('github', 12)).toBe('#12');
    expect(requestRef('gitea', 12)).toBe('#12');
    render(<Row provider="gitlab" number={12} onRemove={() => {}} />);
    expect(screen.getByRole('button', { name: 'Unlink !12' })).toBeInTheDocument();
    expect(screen.getByRole('link', { name: 'Open !12 on GitLab' })).toBeInTheDocument();
  });
});

describe('BranchLine and RequestMarker', () => {
  it('says work started on a branch and that no request exists yet', () => {
    render(<BranchLine branch="feat/payout-alert" by="by claude-dev on laptop, Nov 3" />);
    expect(screen.getByText('Work started on')).toBeInTheDocument();
    expect(screen.getByText('feat/payout-alert').tagName).toBe('CODE');
    expect(screen.getByText('by claude-dev on laptop, Nov 3')).toBeInTheDocument();
    expect(screen.getByText('No pull request yet')).toBeInTheDocument();
  });

  it('marks a request with its number and state, or a branch alone', () => {
    const { container, rerender } = render(
      <RequestMarker request={{ provider: 'github', number: 482, state: 'open' }} />,
    );
    expect(container).toHaveTextContent('Pull request #482 open');
    rerender(<RequestMarker />);
    expect(container).toHaveTextContent('Work branch, no pull request yet');
  });
});

describe('FlagLine', () => {
  it('counts criteria, or items when done items are open too', () => {
    expect(mergedOpenText({ openCriteria: 2, openDoneItems: 0 })).toBe('Merged with 2 open criteria');
    expect(mergedOpenText({ openCriteria: 1, openDoneItems: 0 })).toBe('Merged with 1 open criterion');
    expect(mergedOpenText({ openCriteria: 2, openDoneItems: 1 })).toBe('Merged with 3 open items');
    expect(mergedOpenText({ openCriteria: 0, openDoneItems: 1 })).toBe('Merged with 1 open item');
  });

  it('is a note with its text', () => {
    render(<FlagLine>Merged with 2 open criteria</FlagLine>);
    expect(screen.getByRole('note')).toHaveTextContent('Merged with 2 open criteria');
  });
});

describe('CheckAgainChip', () => {
  it('waits while the day is ahead, grey with the date', () => {
    render(<CheckAgainChip on="2026-12-03" today={TODAY} />);
    const chip = screen.getByText('Waiting until Dec 3').parentElement;
    expect(chip).toHaveAttribute('data-state', 'waiting');
    expect(chip?.className).toContain('text-fg-3');
  });

  it('shortens the waiting words on rows and cards', () => {
    render(<CheckAgainChip on="2026-12-03" today={TODAY} compact />);
    expect(screen.getByText('Until Dec 3').parentElement).toHaveAttribute('title', 'Check again on Dec 3');
  });

  it('turns to the accent on the day and after, never the overdue colour', () => {
    const { rerender } = render(<CheckAgainChip on={TODAY} today={TODAY} />);
    const today = screen.getByText('Check again: today').parentElement;
    expect(today).toHaveAttribute('data-state', 'ready');
    expect(today?.className).toContain('text-accent-text');
    rerender(<CheckAgainChip on="2026-11-25" today={TODAY} />);
    expect(screen.getByText('Check again: yesterday')).toBeInTheDocument();
    rerender(<CheckAgainChip on="2026-11-23" today={TODAY} compact />);
    const late = screen.getByText('Check again: 3 days ago').parentElement;
    expect(late?.className).not.toContain('danger');
    expect(late).toHaveAttribute('title', 'Check again on Nov 23');
  });

  it('shows the plain date until it knows the day', () => {
    render(<CheckAgainChip on="2026-12-03" today={null} />);
    expect(screen.getByText('Check again Dec 3').parentElement).toHaveAttribute('data-state', 'unknown');
  });

  it('adds the year when the day is in another year', () => {
    expect(checkAgainText('2027-01-08', TODAY)).toBe('Waiting until Jan 8, 2027');
    expect(checkAgainState('2027-01-08', TODAY)).toBe('waiting');
    expect(checkAgainState(TODAY, TODAY)).toBe('ready');
    expect(checkAgainState('2026-01-01', TODAY)).toBe('ready');
  });

  it('puts the reason under the chip', () => {
    render(<CheckAgainReason>The bank issues the new certificate on Dec 1</CheckAgainReason>);
    expect(screen.getByText('The bank issues the new certificate on Dec 1')).toBeInTheDocument();
  });
});

describe('ArchivedBar and ArchivedTag', () => {
  it('says when and why the task was archived and what that means', () => {
    render(<ArchivedBar on="Nov 12" cause="14 days after it was done" onRestore={() => {}} />);
    const bar = screen.getByRole('note');
    expect(bar).toHaveTextContent(
      'Archived on Nov 12, 14 days after it was done. It stays out of lists, boards and counts.',
    );
  });

  it('restores by pointer and keyboard, with the key hint', async () => {
    const user = userEvent.setup();
    const onRestore = vi.fn();
    render(<ArchivedBar on="Nov 12" onRestore={onRestore} />);
    const restore = screen.getByRole('button', { name: 'Restore' });
    expect(restore).toHaveTextContent('⇧E');
    await user.click(restore);
    expect(onRestore).toHaveBeenCalledTimes(1);
    await user.tab({ shift: true });
    await user.tab();
    expect(restore).toHaveFocus();
    await user.keyboard(' ');
    expect(onRestore).toHaveBeenCalledTimes(2);
  });

  it('has no Restore when the viewer cannot restore, and takes another note', () => {
    render(<ArchivedBar on="Nov 12" note="Move the file back in Backlog.md to restore it." />);
    expect(screen.queryByRole('button')).toBeNull();
    expect(screen.getByRole('note')).toHaveTextContent(
      'Archived on Nov 12. Move the file back in Backlog.md to restore it.',
    );
  });

  it('does not restore twice while restoring', async () => {
    const user = userEvent.setup();
    const onRestore = vi.fn();
    render(<ArchivedBar on="Nov 12" onRestore={onRestore} isRestoring />);
    await user.click(screen.getByRole('button', { name: 'Restore' }));
    expect(onRestore).not.toHaveBeenCalled();
  });

  it('tags archived results in words', () => {
    render(<ArchivedTag />);
    expect(screen.getByText('Archived')).toBeInTheDocument();
  });
});

describe('WebhookStatusLine', () => {
  it('says no event came yet and that Zamu checks hourly', () => {
    render(<WebhookStatusLine status="never" />);
    expect(screen.getByRole('status')).toHaveTextContent(
      'No event received yet. Until the webhook is set up, Zamu checks the repository once an hour.',
    );
  });

  it('says when the last event came', () => {
    render(<WebhookStatusLine status="ok" when="4 minutes ago" detail="#482 opened." />);
    expect(screen.getByRole('status')).toHaveTextContent('Last event 4 minutes ago. #482 opened.');
  });

  it('names the host when the signature check failed', () => {
    render(<WebhookStatusLine status="bad_signature" provider="github" />);
    const line = screen.getByRole('status');
    expect(line).toHaveTextContent('The last event failed its signature check.');
    expect(line).toHaveTextContent('The secret on GitHub doesn’t match this one.');
    expect(line).toHaveAttribute('data-status', 'bad_signature');
  });

  it('says when an event could not be read', () => {
    render(<WebhookStatusLine status="bad_payload" provider="gitlab" />);
    expect(screen.getByRole('status')).toHaveTextContent('Zamu couldn’t read the last event.');
  });

  it('is busy while loading', () => {
    const { container } = render(<WebhookStatusLine status="loading" />);
    expect(container.firstElementChild).toHaveAttribute('aria-busy', 'true');
    expect(screen.getByText('Loading the webhook status')).toBeInTheDocument();
  });
});

describe('HostSteps', () => {
  it('shows GitHub steps first and switches hosts with the tabs', async () => {
    const user = userEvent.setup();
    const onHostChange = vi.fn();
    render(<HostSteps onHostChange={onHostChange} />);
    const tabs = screen.getAllByRole('tab');
    expect(tabs.map((tab) => tab.textContent)).toEqual(['GitHub', 'GitLab', 'Forgejo']);
    expect(screen.getByRole('tab', { name: 'GitHub' })).toHaveAttribute('aria-selected', 'true');
    const panel = screen.getByRole('tabpanel');
    expect(within(panel).getAllByRole('listitem')).toHaveLength(3);
    expect(panel).toHaveTextContent('Pull requests');

    await user.click(screen.getByRole('tab', { name: 'GitLab' }));
    expect(onHostChange).toHaveBeenLastCalledWith('gitlab');
    expect(screen.getByRole('tabpanel')).toHaveTextContent('Merge request events');

    // Arrow keys move between hosts.
    await user.keyboard('{ArrowRight}');
    expect(screen.getByRole('tab', { name: 'Gitea / Forgejo' })).toHaveAttribute('aria-selected', 'true');
    expect(screen.getByRole('tabpanel')).toHaveTextContent('Custom events');
  });

  it('takes steps of its own for a host', () => {
    render(<HostSteps defaultHost="gitlab" steps={{ gitlab: ['Ask your GitLab admin.'] }} />);
    expect(screen.getByRole('tabpanel')).toHaveTextContent('Ask your GitLab admin.');
  });
});
