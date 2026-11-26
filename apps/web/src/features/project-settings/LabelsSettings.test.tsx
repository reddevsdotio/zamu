import { ORPCError } from '@orpc/client';
import { render, screen, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import type { LabelWithUsage } from '@zamu/contracts';
import { describe, expect, it, vi } from 'vitest';
import { LabelsView, type LabelsViewProps } from './LabelsSettings';
import { labelFailure, labelNameError, sortLabels, usageText } from './labels';

let next = 0;
function label(
  name: string,
  color: number,
  usageCount: number,
  source: 'app' | 'backlog' = 'app',
): LabelWithUsage {
  next += 1;
  return { id: `80000000-0000-4000-8000-${String(next).padStart(12, '0')}`, name, color, usageCount, source };
}

const PAY = [
  label('api', 1, 14),
  label('backend', 2, 22),
  label('ledger', 5, 11),
  label('payouts', 6, 34),
  label('reliability', 9, 12),
];

function view(props: Partial<LabelsViewProps> = {}) {
  const handlers = {
    onCreate: vi.fn().mockResolvedValue(undefined),
    onRename: vi.fn().mockResolvedValue(undefined),
    onRecolour: vi.fn().mockResolvedValue(undefined),
    onDelete: vi.fn().mockResolvedValue(undefined),
  };
  render(<LabelsView projectName="Payments" mirrored={false} labels={PAY} {...handlers} {...props} />);
  return handlers;
}

const rows = () =>
  within(screen.getByRole('table', { name: 'Labels' }))
    .getAllByRole('row')
    .slice(1);
const row = (name: string) => {
  const found = rows().find((item) => within(item).queryByText(name, { exact: true }));
  if (!found) throw new Error(`no row ${name}`);
  return found;
};

describe('Labels settings', () => {
  it('lists labels by use with their counts', () => {
    view();
    expect(screen.getByRole('heading', { name: 'Labels' })).toBeVisible();
    expect(
      screen.getByText(
        'Labels group tasks inside Payments. Labels with the same name in other projects show as one label in workspace filters.',
      ),
    ).toBeVisible();
    expect(rows().map((item) => item.textContent)).toEqual([
      expect.stringContaining('payouts34 tasks'),
      expect.stringContaining('backend22 tasks'),
      expect.stringContaining('api14 tasks'),
      expect.stringContaining('reliability12 tasks'),
      expect.stringContaining('ledger11 tasks'),
    ]);
    expect(screen.getByRole('status')).toHaveTextContent('5 labels');
    expect(screen.getByRole('button', { name: 'New label' })).toBeEnabled();
  });

  it('filters by name', async () => {
    const user = userEvent.setup();
    view();
    await user.type(screen.getByRole('searchbox', { name: 'Filter labels' }), 'B');
    expect(rows()).toHaveLength(2);
    expect(screen.getByRole('status')).toHaveTextContent('2 of 5 labels');
    await user.type(screen.getByRole('searchbox', { name: 'Filter labels' }), 'zz');
    expect(screen.getByText('No labels match “Bzz”.')).toBeVisible();
  });

  it('renames in place: Enter saves, Esc cancels', async () => {
    const user = userEvent.setup();
    const { onRename } = view();
    await user.click(within(row('reliability')).getByRole('button', { name: 'Rename “reliability”' }));
    const field = screen.getByRole('textbox', { name: 'New name for “reliability”' });
    expect(field).toHaveFocus();
    await user.keyboard('{Escape}');
    expect(screen.queryByRole('textbox', { name: 'New name for “reliability”' })).toBeNull();
    expect(onRename).not.toHaveBeenCalled();

    await user.click(within(row('reliability')).getByRole('button', { name: 'Rename “reliability”' }));
    await user.type(
      screen.getByRole('textbox', { name: 'New name for “reliability”' }),
      'reliability and retries',
      {
        initialSelectionStart: 0,
        initialSelectionEnd: 11,
      },
    );
    await user.keyboard('{Enter}');
    expect(onRename).toHaveBeenCalledWith(PAY[4], 'reliability and retries');
    expect(screen.queryByRole('textbox', { name: 'New name for “reliability”' })).toBeNull();
  });

  it('shows a taken name under the field, from the list and from the server', async () => {
    const user = userEvent.setup();
    const { onRename } = view();
    await user.click(within(row('api')).getByRole('button', { name: 'Rename “api”' }));
    const field = screen.getByRole('textbox', { name: 'New name for “api”' });
    await user.clear(field);
    await user.type(field, 'Backend{Enter}');
    expect(screen.getByText('Payments has a label named “backend” already.')).toBeVisible();
    expect(field).toHaveAttribute('aria-invalid', 'true');
    expect(onRename).not.toHaveBeenCalled();

    onRename.mockRejectedValueOnce(
      new ORPCError('LABEL_EXISTS', { status: 409, message: 'PAY has a label' }),
    );
    await user.clear(field);
    await user.type(field, 'gateway{Enter}');
    expect(await screen.findByText('Payments has a label named “gateway” already.')).toBeVisible();
    expect(field).toBeVisible();
  });

  it('recolours from the dot and saves the pick at once', async () => {
    const user = userEvent.setup();
    const { onRecolour } = view();
    await user.click(screen.getByRole('button', { name: 'Colour of “ledger”' }));
    const popover = screen.getByRole('dialog', { name: 'Colour for “ledger”' });
    expect(within(popover).getByRole('radio', { name: 'Cyan' })).toBeChecked();
    expect(popover).toHaveTextContent('Each colour passes AA contrast in both themes.');
    await user.click(within(popover).getByRole('radio', { name: 'Teal' }));
    expect(onRecolour).toHaveBeenCalledWith(PAY[2], 8);
  });

  it('deletes after a confirmation that says how many tasks lose the label', async () => {
    const user = userEvent.setup();
    const { onDelete } = view();
    await user.click(
      within(row('reliability')).getByRole('button', { name: 'More actions for “reliability”' }),
    );
    await user.click(screen.getByRole('menuitem', { name: 'Delete…' }));
    const dialog = screen.getByRole('alertdialog', { name: 'Delete the label “reliability”?' });
    expect(dialog).toHaveTextContent(
      'It’s used on 12 tasks in Payments. They lose this label and keep everything else. You can’t undo this.',
    );
    expect(within(dialog).queryByRole('textbox')).toBeNull();
    await user.click(within(dialog).getByRole('button', { name: 'Delete label' }));
    expect(onDelete).toHaveBeenCalledWith(PAY[4]);
  });

  it('creates a label from the empty state with the least used colour', async () => {
    const user = userEvent.setup();
    const { onCreate } = view({ labels: [] });
    expect(screen.getByRole('heading', { name: 'No labels yet' })).toBeVisible();
    expect(
      screen.getByText(
        'Labels group work inside a project. Create one here, or press L on any task and type a new name.',
      ),
    ).toBeVisible();
    await user.click(screen.getByRole('button', { name: 'New label' }));
    const field = screen.getByRole('textbox', { name: 'Name of the new label' });
    await user.type(field, '{Enter}');
    expect(screen.getByText('Enter a name.')).toBeVisible();
    await user.type(field, 'billing{Enter}');
    expect(onCreate).toHaveBeenCalledWith('billing', 1);
  });

  it('locks the names of labels from Backlog.md and keeps their colour editable', async () => {
    const user = userEvent.setup();
    const { onRecolour } = view({
      mirrored: true,
      labels: [label('frontend', 1, 31, 'backlog'), label('backend', 2, 38, 'backlog')],
    });
    expect(screen.getByText('Labels used by Payments’s tasks.')).toBeVisible();
    expect(screen.getByRole('note')).toHaveTextContent(
      'Payments’s labels come from its Backlog.md files. Rename or remove them in the files. Colours are set here and never written to the files.',
    );
    expect(screen.queryByRole('button', { name: 'New label' })).toBeNull();
    const frontend = row('frontend');
    expect(within(frontend).getByText('From Backlog.md')).toBeVisible();
    expect(within(frontend).queryByRole('button', { name: 'Rename “frontend”' })).toBeNull();
    await user.click(within(frontend).getByRole('button', { name: 'More actions for “frontend”' }));
    expect(screen.getByRole('menuitem', { name: 'Rename' })).toHaveAttribute('aria-disabled', 'true');
    expect(screen.getByRole('menuitem', { name: 'Delete…' })).toHaveAttribute('aria-disabled', 'true');
    await user.click(screen.getByRole('menuitem', { name: 'Change colour' }));
    const popover = await screen.findByRole('dialog', { name: 'Colour for “frontend”' });
    await user.click(within(popover).getByRole('radio', { name: 'Pink' }));
    expect(onRecolour).toHaveBeenCalledWith(expect.objectContaining({ name: 'frontend' }), 7);
  });

  it('shows a failed colour change and keeps the page', async () => {
    const user = userEvent.setup();
    view({ onRecolour: vi.fn().mockRejectedValue(new Error('offline')) });
    await user.click(screen.getByRole('button', { name: 'Colour of “api”' }));
    await user.click(screen.getByRole('radio', { name: 'Red' }));
    await user.keyboard('{Escape}');
    expect(await screen.findByRole('alert')).toHaveTextContent(
      "Couldn't change the colour of “api”. Couldn't save the label. Check your connection and try again.",
    );
  });
});

describe('Label helpers', () => {
  it('orders, counts and checks names', () => {
    expect(sortLabels(PAY).map((item) => item.name)).toEqual([
      'payouts',
      'backend',
      'api',
      'reliability',
      'ledger',
    ]);
    expect([usageText(0), usageText(1), usageText(12)]).toEqual(['No tasks', '1 task', '12 tasks']);
    expect(labelNameError('  ', PAY, 'Payments')).toBe('Enter a name.');
    expect(labelNameError('x'.repeat(41), PAY, 'Payments')).toBe('Use 40 characters or fewer.');
    expect(labelNameError('API', PAY, 'Payments')).toBe('Payments has a label named “api” already.');
    // A change of case only renames the label itself.
    expect(labelNameError('API', PAY, 'Payments', PAY[0]?.id)).toBeNull();
    expect(
      labelFailure(
        new ORPCError('LABEL_MIRRORED', { status: 409, message: 'frontend comes from Backlog.md' }),
        'Harbor',
        'x',
      ),
    ).toBe('frontend comes from Backlog.md');
  });
});
