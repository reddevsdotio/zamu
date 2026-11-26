import { render, screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { describe, expect, it, vi } from 'vitest';
import { UIProvider } from '~/ui';
import { WelcomeScreen } from './Welcome';

// /welcome: the form when the person may create a workspace, the invitation hint when not, and Sign
// out in both.

vi.setConfig({ testTimeout: 15_000 });

const ana = { name: 'Ana Ruiz', email: 'ana@example.com' };

describe('WelcomeScreen', () => {
  it('lets the person create a workspace and sign out', async () => {
    const user = userEvent.setup();
    const onCreate = vi.fn(async () => null);
    const onSignOut = vi.fn();
    render(
      <UIProvider>
        <WelcomeScreen canCreate user={ana} onSignOut={onSignOut} onCreate={onCreate} />
      </UIProvider>,
    );
    expect(screen.getByRole('heading', { name: 'Create a workspace' })).toBeInTheDocument();
    await user.type(screen.getByRole('textbox', { name: 'Name' }), 'Acme');
    await user.keyboard('{Enter}');
    await waitFor(() => expect(onCreate).toHaveBeenCalledWith({ name: 'Acme', slug: 'acme' }));
    expect(screen.getByText('ana@example.com')).toBeInTheDocument();
    await user.click(screen.getByRole('button', { name: 'Sign out' }));
    expect(onSignOut).toHaveBeenCalled();
  });

  it('asks for an invitation when only owners may create workspaces', () => {
    render(
      <UIProvider>
        <WelcomeScreen canCreate={false} user={ana} onSignOut={() => {}} onCreate={async () => null} />
      </UIProvider>,
    );
    expect(screen.getByRole('heading', { name: 'Ask an owner for an invitation' })).toBeInTheDocument();
    expect(screen.queryByRole('form', { name: 'New workspace' })).not.toBeInTheDocument();
    expect(screen.getByRole('button', { name: 'Sign out' })).toBeInTheDocument();
  });
});
