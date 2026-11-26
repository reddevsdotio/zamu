// Archive settings (M7 frames 081, 082): off with the finished-task counts, turning it on at 14 days
// with the preview count before saving, other days, the range check, saving and Cancel, the member view,
// and the mirrored note. The page runs against a fake /api/v1 client.
import { ORPCError } from '@orpc/client';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { projectWithCountsFixture } from '@zamu/contracts/testing/fixtures';
import { describe, expect, it, vi } from 'vitest';
import { renderInWorkspace, testWorkspace } from '~/lib/testing';
import { ArchiveSettings } from './ArchiveSettings';
import { archiveFailure, offText, parseDays, previewText } from './archive';

interface FakeOptions {
  archiveAfterDays?: number | null;
  role?: 'owner' | 'admin' | 'member';
  mirrored?: boolean;
  /** Tasks the nightly run would archive, per number of days. */
  count?: (days: number) => number;
}

function fakeClient({ archiveAfterDays = null, role = 'owner', mirrored = false, count }: FakeOptions = {}) {
  let saved = archiveAfterDays;
  const project = () => ({
    ...projectWithCountsFixture,
    archiveAfterDays: saved,
    backlog: mirrored
      ? {
          mode: 'mirror' as const,
          state: 'healthy' as const,
          repository: 'https://github.com/northwind/payments',
          detachedAt: null,
        }
      : null,
  });
  const update = vi.fn(async (input: { project: string; archiveAfterDays?: number | null }) => {
    if (input.archiveAfterDays !== undefined) saved = input.archiveAfterDays;
    return project();
  });
  const archivePreview = vi.fn(async ({ project: key, days }: { project: string; days: number }) => ({
    project: key,
    days,
    count: count ? count(days) : 60,
  }));
  const client = {
    projects: { list: async () => ({ items: [project()] }), update, archivePreview },
    me: { get: async () => ({ role }) },
    tasks: {
      list: async () => ({
        items: [],
        nextCursor: null,
        counts: { backlog: 3, todo: 4, in_progress: 3, in_review: 2, done: 61, canceled: 6 },
      }),
    },
  };
  return { client, update, archivePreview };
}

function renderPage(options: FakeOptions = {}) {
  const fake = fakeClient(options);
  const queryClient = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  renderInWorkspace(
    <QueryClientProvider client={queryClient}>
      <ArchiveSettings projectKey="PAY" />
    </QueryClientProvider>,
    { workspace: testWorkspace(fake.client) },
  );
  return fake;
}

const toggle = () => screen.getByRole('switch', { name: 'Archive finished tasks' });
const daysField = () => screen.getByRole('textbox', { name: 'Archive after' });

describe('Archive settings', () => {
  it('is off with what that means and the finished tasks the project has (frame 081)', async () => {
    renderPage();
    expect(screen.getByRole('heading', { name: 'Archive' })).toBeVisible();
    expect(
      screen.getByText(
        'Finished tasks leave lists, boards and counts after a while. They stay searchable and can be restored.',
      ),
    ).toBeVisible();
    expect(await screen.findByRole('switch', { name: 'Archive finished tasks' })).not.toBeChecked();
    expect(toggle()).toHaveAccessibleDescription(
      'Done and Canceled tasks are archived a set number of days after they reached that status.',
    );
    expect(
      await screen.findByText(
        'Off: finished tasks stay where they are until someone archives them by hand. Payments has 61 Done and 6 Canceled tasks.',
      ),
    ).toBeVisible();
    expect(screen.queryByRole('button', { name: 'Save' })).toBeNull();
  });

  it('turns on at 14 days and previews the count before saving (frame 082)', async () => {
    const user = userEvent.setup();
    const { update, archivePreview } = renderPage();
    await user.click(await screen.findByRole('switch', { name: 'Archive finished tasks' }));
    expect(daysField()).toHaveValue('14');
    const preview = await screen.findByRole('status');
    await waitFor(() =>
      expect(preview).toHaveTextContent(
        '60 tasks were finished more than 14 days ago and will be archived tonight.',
      ),
    );
    expect(archivePreview).toHaveBeenCalledWith(
      expect.objectContaining({ project: 'PAY', days: 14 }),
      expect.anything(),
    );
    expect(update).not.toHaveBeenCalled();
    await user.click(screen.getByRole('button', { name: 'Save' }));
    expect(update).toHaveBeenCalledWith({ project: 'PAY', archiveAfterDays: 14 });
    expect(await screen.findByText('Saved.')).toBeVisible();
    expect(screen.queryByRole('button', { name: 'Save' })).toBeNull();
  });

  it('previews other days and refuses days outside 1 to 365', async () => {
    const user = userEvent.setup();
    const { update } = renderPage({ archiveAfterDays: 30, count: (days) => (days >= 30 ? 0 : 1) });
    expect(await screen.findByRole('switch', { name: 'Archive finished tasks' })).toBeChecked();
    expect(daysField()).toHaveValue('30');
    await waitFor(() =>
      expect(screen.getByRole('status')).toHaveTextContent(
        'No finished task is older than 30 days, so nothing is archived tonight.',
      ),
    );
    await user.clear(daysField());
    await user.type(daysField(), '7');
    await waitFor(() =>
      expect(screen.getByRole('status')).toHaveTextContent(
        '1 task was finished more than 7 days ago and will be archived tonight.',
      ),
    );
    await user.clear(daysField());
    await user.type(daysField(), '400');
    await user.click(screen.getByRole('button', { name: 'Save' }));
    expect(update).not.toHaveBeenCalled();
    expect(screen.getByText('Use 1 to 365 days.')).toBeVisible();
    expect(daysField()).toHaveAttribute('aria-invalid', 'true');
  });

  it('turns off with Save, and Cancel puts the saved setting back', async () => {
    const user = userEvent.setup();
    const { update } = renderPage({ archiveAfterDays: 30 });
    await user.click(await screen.findByRole('switch', { name: 'Archive finished tasks' }));
    expect(screen.queryByRole('textbox', { name: 'Archive after' })).toBeNull();
    await user.click(screen.getByRole('button', { name: 'Cancel' }));
    expect(toggle()).toBeChecked();
    expect(daysField()).toHaveValue('30');
    await user.click(toggle());
    await user.click(screen.getByRole('button', { name: 'Save' }));
    expect(update).toHaveBeenCalledWith({ project: 'PAY', archiveAfterDays: null });
  });

  it('shows why a save failed', async () => {
    const user = userEvent.setup();
    const { update } = renderPage();
    update.mockRejectedValueOnce(
      new ORPCError('FORBIDDEN', {
        message: 'Only owners and admins can change the archive setting of a project',
      }),
    );
    await user.click(await screen.findByRole('switch', { name: 'Archive finished tasks' }));
    await user.click(screen.getByRole('button', { name: 'Save' }));
    expect(await screen.findByRole('alert')).toHaveTextContent(
      'Only owners and admins can change the archive setting.',
    );
  });

  it('is read-only for members', async () => {
    renderPage({ role: 'member', archiveAfterDays: 14 });
    await waitFor(() =>
      expect(screen.getByText('Only owners and admins change the archive setting.')).toBeVisible(),
    );
    expect(toggle()).toBeDisabled();
    expect(toggle()).toBeChecked();
    expect(daysField()).toHaveAttribute('readonly');
    expect(screen.queryByRole('button', { name: 'Save' })).toBeNull();
    await waitFor(() =>
      expect(screen.getByRole('status')).toHaveTextContent(
        '60 tasks were finished more than 14 days ago and will be archived tonight.',
      ),
    );
  });

  it('says a mirrored project follows the Backlog.md archive folder', async () => {
    renderPage({ mirrored: true });
    expect(await screen.findByRole('note')).toHaveTextContent(
      'Payments mirrors Backlog.md, so archiving follows its archive/tasks/ folder: a task whose file moves there is archived here, and moving the file back restores it.',
    );
    expect(screen.queryByRole('switch')).toBeNull();
  });
});

describe('archive helpers', () => {
  it('reads whole days from 1 to 365', () => {
    expect(parseDays('14')).toBe(14);
    expect(parseDays(' 365 ')).toBe(365);
    expect(parseDays('0')).toBeNull();
    expect(parseDays('366')).toBeNull();
    expect(parseDays('1.5')).toBeNull();
    expect(parseDays('')).toBeNull();
  });

  it('writes the preview and the off sentence', () => {
    expect(previewText(1, 1)).toEqual({
      count: '1 task',
      rest: 'was finished more than 1 day ago and will be archived tonight.',
    });
    expect(offText('Payments', { done: 0, canceled: 0 })).toBe(
      'Off: finished tasks stay where they are until someone archives them by hand. Payments has no Done or Canceled tasks.',
    );
    expect(offText('Payments', { done: 1, canceled: 0 })).toBe(
      'Off: finished tasks stay where they are until someone archives them by hand. Payments has 1 Done task.',
    );
    expect(offText('Payments', { done: 0, canceled: 6 })).toMatch(/Payments has 6 Canceled tasks\.$/);
    expect(offText('Payments')).toBe(
      'Off: finished tasks stay where they are until someone archives them by hand.',
    );
  });

  it('reads unknown errors as a connection problem', () => {
    expect(archiveFailure(new Error('boom'))).toBe(
      'Couldn’t save the archive setting. Check your connection and try again.',
    );
  });
});
