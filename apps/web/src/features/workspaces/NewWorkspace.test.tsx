import { act, render, screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import type { CreateWorkspaceInput } from '@zamu/contracts';
import { describe, expect, it, vi } from 'vitest';
import { UIProvider } from '~/ui';
import { SettingsError } from '../settings/result';
import { NewWorkspaceDialog, type NewWorkspaceFailure, newWorkspaceFailure } from './NewWorkspace';

// The New workspace dialog: the address follows the name, the server's free suggestion replaces it,
// a typed address sticks, and errors land under the field they are about.

vi.setConfig({ testTimeout: 15_000 });

function renderDialog({
  onSubmit = async () => null,
  suggestSlug,
}: {
  onSubmit?: (input: CreateWorkspaceInput) => Promise<NewWorkspaceFailure | null>;
  suggestSlug?: (name: string) => Promise<string | null>;
} = {}) {
  const submit = vi.fn(onSubmit);
  render(
    <UIProvider>
      <NewWorkspaceDialog isOpen onClose={() => {}} onSubmit={submit} suggestSlug={suggestSlug} />
    </UIProvider>,
  );
  const dialog = screen.getByRole('dialog', { name: 'New workspace' });
  return {
    submit,
    dialog,
    name: () => screen.getByRole('textbox', { name: 'Name' }),
    slug: () => screen.getByRole('textbox', { name: 'Address' }),
    create: () => screen.getByRole('button', { name: /Create workspace/ }),
  };
}

describe('NewWorkspaceDialog', () => {
  it('suggests the address from the name, then takes the server’s free one', async () => {
    const user = userEvent.setup();
    const suggestSlug = vi.fn(async (name: string) => (name === 'Acme Corp' ? 'acme-corp-2' : null));
    const { name, slug } = renderDialog({ suggestSlug });
    await user.type(name(), 'Acme Corp');
    // At once from the name, in the browser.
    expect(slug()).toHaveValue('acme-corp');
    expect(screen.getByText(/Suggested from the name/)).toBeInTheDocument();
    // Then the server's, once typing pauses.
    await waitFor(() => expect(slug()).toHaveValue('acme-corp-2'));
    expect(suggestSlug).toHaveBeenLastCalledWith('Acme Corp');
  });

  it('keeps an address the person typed and sends it', async () => {
    const user = userEvent.setup();
    const suggestSlug = vi.fn(async () => 'server-pick');
    const { name, slug, create, submit } = renderDialog({ suggestSlug });
    await user.type(name(), 'Acme');
    await user.clear(slug());
    await user.type(slug(), 'Acme HQ');
    expect(slug()).toHaveValue('acme-hq');
    await user.type(name(), ' Corp');
    expect(slug()).toHaveValue('acme-hq');
    await user.click(create());
    await waitFor(() => expect(submit).toHaveBeenCalledWith({ name: 'Acme Corp', slug: 'acme-hq' }));
  });

  it('asks for a name and refuses a malformed address before sending', async () => {
    const user = userEvent.setup();
    const { name, slug, create, submit } = renderDialog();
    await user.click(create());
    expect(await screen.findByText('Enter a workspace name.')).toBeInTheDocument();
    expect(name()).toHaveFocus();
    await user.type(name(), 'Acme');
    await user.clear(slug());
    await user.type(slug(), 'acme-');
    await user.click(create());
    expect(
      await screen.findByText('Use single hyphens between letters or digits, not at the end.'),
    ).toBeInTheDocument();
    expect(slug()).toHaveAttribute('aria-invalid', 'true');
    expect(submit).not.toHaveBeenCalled();
  });

  it('says a reserved address is reserved while typing', async () => {
    const user = userEvent.setup();
    const { name, slug, create, submit } = renderDialog();
    await user.type(name(), 'Settings');
    expect(slug()).toHaveValue('settings-workspace');
    await user.clear(slug());
    await user.type(slug(), 'settings');
    expect(screen.getByText('This address is reserved. Pick another.')).toBeInTheDocument();
    await user.click(create());
    expect(submit).not.toHaveBeenCalled();
  });

  it('shows a taken address under the field and other failures in the banner', async () => {
    const user = userEvent.setup();
    const answers: NewWorkspaceFailure[] = [
      newWorkspaceFailure(
        new SettingsError({
          code: 'SLUG_TAKEN',
          message: 'The address acme is taken. Pick another.',
          issues: [{ path: 'slug', message: 'The address acme is taken. Pick another.' }],
        }),
      ),
      newWorkspaceFailure(
        new SettingsError({
          code: 'WORKSPACE_CREATION_OFF',
          message: 'On this server, only people who own a workspace can create one.',
          issues: [],
        }),
      ),
    ];
    const { name, slug, create } = renderDialog({ onSubmit: async () => answers.shift() ?? null });
    await user.type(name(), 'Acme');
    await user.click(create());
    expect(await screen.findByText('The address acme is taken. Pick another.')).toBeInTheDocument();
    expect(slug()).toHaveFocus();
    await user.type(slug(), '-eu');
    await user.click(create());
    expect(await screen.findByRole('alert')).toHaveTextContent(
      'On this server, only people who own a workspace can create one.',
    );
  });

  it('submits with ⌘↵ / Ctrl↵', async () => {
    const user = userEvent.setup();
    const { name, submit } = renderDialog();
    await user.type(name(), 'Globex');
    await act(async () => {
      await user.keyboard('{Control>}{Enter}{/Control}');
    });
    await waitFor(() => expect(submit).toHaveBeenCalledWith({ name: 'Globex', slug: 'globex' }));
  });
});
