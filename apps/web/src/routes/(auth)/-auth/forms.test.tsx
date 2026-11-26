import { render, screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { describe, expect, it, vi } from 'vitest';
import {
  ErrorBanner,
  InviteForm,
  JoinWorkspace,
  SetupForm,
  SignInForm,
  SignInToJoin,
  signInError,
  signInToJoinHref,
  TOO_MANY_ATTEMPTS,
  WorkspaceForm,
  WRONG_CREDENTIALS,
  WrongAccount,
} from './forms';

function sso(result: string | null = null) {
  return { label: 'Continue with Authentik', onPress: vi.fn().mockResolvedValue(result) };
}

describe('SignInForm', () => {
  it('shows field errors and does not submit when empty', async () => {
    const onSubmit = vi.fn();
    render(<SignInForm onSubmit={onSubmit} />);
    await userEvent.click(screen.getByRole('button', { name: 'Sign in' }));

    expect(screen.getByText('Enter a valid email address.')).toBeInTheDocument();
    expect(screen.getByText('Enter your password.')).toBeInTheDocument();
    expect(screen.getByLabelText('Email')).toHaveAttribute('aria-invalid', 'true');
    expect(onSubmit).not.toHaveBeenCalled();
  });

  it('shows the banner and marks the password field on wrong credentials', async () => {
    const onSubmit = vi.fn().mockResolvedValue({ kind: 'credentials' });
    render(<SignInForm onSubmit={onSubmit} />);
    await userEvent.type(screen.getByLabelText('Email'), ' ana@reddevs.io ');
    await userEvent.type(screen.getByLabelText('Password'), 'wrong-password{Enter}');

    expect(onSubmit).toHaveBeenCalledWith({ email: 'ana@reddevs.io', password: 'wrong-password' });
    expect(await screen.findByRole('alert')).toHaveTextContent(WRONG_CREDENTIALS);
    expect(screen.getByLabelText('Password')).toHaveAttribute('aria-invalid', 'true');
    expect(screen.getByLabelText('Email')).not.toHaveAttribute('aria-invalid');

    // Editing clears the error state.
    await userEvent.type(screen.getByLabelText('Password'), 'x');
    expect(screen.queryByRole('alert')).not.toBeInTheDocument();
    expect(screen.getByLabelText('Password')).not.toHaveAttribute('aria-invalid');
  });

  it('hides the SSO button unless an OIDC sign-in is provided', () => {
    const { rerender } = render(<SignInForm onSubmit={vi.fn()} />);
    expect(screen.queryByRole('button', { name: /Continue with/ })).not.toBeInTheDocument();
    expect(screen.queryByText('or')).not.toBeInTheDocument();
    rerender(<SignInForm onSubmit={vi.fn()} sso={{ label: 'Continue with SSO', onPress: vi.fn() }} />);
    const ssoButton = screen.getByRole('button', { name: 'Continue with SSO' });
    expect(screen.getByText('or')).toBeInTheDocument();
    expect(screen.getByLabelText('Password')).toBeInTheDocument();
    // Frame 128: the SSO button sits under the form, after the divider.
    const signIn = screen.getByRole('button', { name: 'Sign in' });
    expect(signIn.compareDocumentPosition(ssoButton) & Node.DOCUMENT_POSITION_FOLLOWING).toBeTruthy();
  });

  it('starts SSO and shows a banner when the redirect cannot start', async () => {
    const action = sso('Single sign-on is not available right now. Try again in a moment.');
    render(<SignInForm onSubmit={vi.fn()} sso={action} />);
    await userEvent.click(screen.getByRole('button', { name: 'Continue with Authentik' }));
    expect(action.onPress).toHaveBeenCalledOnce();
    expect(await screen.findByRole('alert')).toHaveTextContent('Single sign-on is not available right now.');
  });

  it('shows only the SSO button when password sign-in is off', () => {
    render(<SignInForm onSubmit={vi.fn()} sso={sso()} passwordLogin={false} />);
    expect(screen.getByRole('button', { name: 'Continue with Authentik' })).toBeInTheDocument();
    expect(screen.queryByLabelText('Email')).not.toBeInTheDocument();
    expect(screen.queryByLabelText('Password')).not.toBeInTheDocument();
    expect(screen.queryByRole('button', { name: 'Sign in' })).not.toBeInTheDocument();
    expect(screen.queryByText('or')).not.toBeInTheDocument();
  });

  it('shows the error an SSO redirect came back with', () => {
    render(<SignInForm onSubmit={vi.fn()} sso={sso()} initialError="Sign-in was cancelled." />);
    expect(screen.getByRole('alert')).toHaveTextContent('Sign-in was cancelled.');
  });
});

describe('signInError', () => {
  it('maps what Better Auth answered to the error the form shows', () => {
    expect(signInError({ code: 'INVALID_EMAIL_OR_PASSWORD', status: 401 })).toEqual({ kind: 'credentials' });
    expect(signInError({ status: 401 })).toEqual({ kind: 'credentials' });
    // Rate limit: a short window, no "N tries left" copy.
    expect(signInError({ status: 429, message: 'Too many requests' })).toEqual({
      kind: 'other',
      message: TOO_MANY_ATTEMPTS,
    });
    expect(signInError({ code: 'PASSWORD_LOGIN_DISABLED', status: 403 })).toEqual({
      kind: 'other',
      message: 'Password sign-in is turned off. Use single sign-on.',
    });
    expect(signInError({ status: 500 })).toEqual({ kind: 'other', message: "Couldn't sign in. Try again." });
  });

  it('shows the rate limit message in the banner without marking a field', async () => {
    render(<SignInForm onSubmit={vi.fn().mockResolvedValue(signInError({ status: 429 }))} />);
    await userEvent.type(screen.getByLabelText('Email'), 'ana@reddevs.io');
    await userEvent.type(screen.getByLabelText('Password'), 'some-password{Enter}');
    expect(await screen.findByRole('alert')).toHaveTextContent(TOO_MANY_ATTEMPTS);
    expect(screen.getByLabelText('Password')).not.toHaveAttribute('aria-invalid');
  });
});

describe('SetupForm', () => {
  it('counts the password down, then moves to the workspace step and submits both', async () => {
    const onSubmit = vi.fn().mockResolvedValue(null);
    render(<SetupForm onSubmit={onSubmit} />);

    await userEvent.click(screen.getByRole('button', { name: 'Continue' }));
    expect(screen.getByText('Enter your name.')).toBeInTheDocument();
    expect(screen.getByText('Use 12 characters or more.')).toBeInTheDocument();

    await userEvent.type(screen.getByLabelText('Your name'), 'Ana Ruiz');
    await userEvent.type(screen.getByLabelText('Email'), 'ana@reddevs.io');
    await userEvent.type(screen.getByLabelText('Password'), 'abcdefgh');
    expect(screen.getByText('12 characters or more. 4 to go.')).toBeInTheDocument();
    await userEvent.type(screen.getByLabelText('Password'), 'ijkl');
    expect(screen.getByText('12 characters or more.')).toBeInTheDocument();

    await userEvent.click(screen.getByRole('button', { name: 'Continue' }));
    expect(screen.getByRole('heading', { name: 'Name your workspace' })).toBeInTheDocument();

    await userEvent.click(screen.getByRole('button', { name: 'Create workspace' }));
    expect(screen.getByText('Enter a workspace name.')).toBeInTheDocument();
    expect(onSubmit).not.toHaveBeenCalled();

    await userEvent.type(screen.getByLabelText('Workspace name'), ' Reddevs {Enter}');
    expect(onSubmit).toHaveBeenCalledWith({
      name: 'Ana Ruiz',
      email: 'ana@reddevs.io',
      password: 'abcdefghijkl',
      workspaceName: 'Reddevs',
    });
  });

  it('shows a server error with a sign-in link and keeps values on Back', async () => {
    const onSubmit = vi
      .fn()
      .mockResolvedValue({ message: 'This server is already set up.', signInLink: true });
    render(<SetupForm onSubmit={onSubmit} />);
    await userEvent.type(screen.getByLabelText('Your name'), 'Ana');
    await userEvent.type(screen.getByLabelText('Email'), 'ana@reddevs.io');
    await userEvent.type(screen.getByLabelText('Password'), 'correct-horse-battery{Enter}');
    await userEvent.type(screen.getByLabelText('Workspace name'), 'Reddevs{Enter}');

    const alert = await screen.findByRole('alert');
    expect(alert).toHaveTextContent('This server is already set up.');
    expect(screen.getByRole('link', { name: 'Go to sign in' })).toHaveAttribute('href', '/signin');

    await userEvent.click(screen.getByRole('button', { name: 'Back' }));
    await waitFor(() => expect(screen.getByLabelText('Your name')).toHaveValue('Ana'));
  });
});

describe('SetupForm with SSO', () => {
  it('offers SSO above the account form', async () => {
    const action = sso();
    render(<SetupForm onSubmit={vi.fn()} sso={action} />);
    expect(screen.getByLabelText('Your name')).toBeInTheDocument();
    await userEvent.click(screen.getByRole('button', { name: 'Continue with Authentik' }));
    expect(action.onPress).toHaveBeenCalledOnce();
  });

  it('shows only the SSO button when password sign-in is off', () => {
    render(<SetupForm onSubmit={vi.fn()} sso={sso()} passwordLogin={false} />);
    expect(screen.getByRole('heading', { name: 'Set up this server' })).toBeInTheDocument();
    expect(screen.getByRole('button', { name: 'Continue with Authentik' })).toBeInTheDocument();
    expect(screen.queryByLabelText('Your name')).not.toBeInTheDocument();
    expect(screen.queryByLabelText('Password')).not.toBeInTheDocument();
  });
});

describe('WorkspaceForm', () => {
  it('validates and submits the workspace name', async () => {
    const onSubmit = vi.fn().mockResolvedValue(null);
    render(<WorkspaceForm onSubmit={onSubmit} />);
    expect(screen.getByRole('heading', { name: 'Name your workspace' })).toBeInTheDocument();
    await userEvent.click(screen.getByRole('button', { name: 'Create workspace' }));
    expect(screen.getByText('Enter a workspace name.')).toBeInTheDocument();
    expect(onSubmit).not.toHaveBeenCalled();
    await userEvent.type(screen.getByLabelText('Workspace name'), ' Reddevs {Enter}');
    expect(onSubmit).toHaveBeenCalledWith('Reddevs');
  });
});

describe('InviteForm', () => {
  it('shows the invited email and only the SSO button when password sign-in is off', async () => {
    const action = sso();
    render(
      <InviteForm
        email="tomas@reddevs.io"
        onSubmit={vi.fn()}
        sso={action}
        passwordLogin={false}
        initialError={{ message: 'This invitation is for tomas@reddevs.io.' }}
      />,
    );
    expect(screen.getByLabelText('Email')).toHaveValue('tomas@reddevs.io');
    expect(screen.queryByLabelText('Password')).not.toBeInTheDocument();
    expect(screen.getByRole('alert')).toHaveTextContent('This invitation is for tomas@reddevs.io.');
    await userEvent.click(screen.getByRole('button', { name: 'Continue with Authentik' }));
    expect(action.onPress).toHaveBeenCalledOnce();
  });

  it('shows the email read-only and validates name and password', async () => {
    const onSubmit = vi.fn().mockResolvedValue(null);
    render(<InviteForm email="tomas@reddevs.io" onSubmit={onSubmit} />);

    expect(screen.getByLabelText('Email')).toHaveValue('tomas@reddevs.io');
    expect(screen.getByLabelText('Email')).toHaveAttribute('readonly');

    await userEvent.click(screen.getByRole('button', { name: 'Join workspace' }));
    expect(screen.getByText('Enter your name.')).toBeInTheDocument();
    expect(screen.getByText('Use 12 characters or more.')).toBeInTheDocument();

    await userEvent.type(screen.getByLabelText('Your name'), 'Tomás Berg');
    await userEvent.type(screen.getByLabelText('Password'), 'tomas-password-long{Enter}');
    expect(onSubmit).toHaveBeenCalledWith({ name: 'Tomás Berg', password: 'tomas-password-long' });
  });
});

describe('joining with an existing account', () => {
  const INVITATION = '0190b1d2-0000-7000-8000-000000000001';

  it('joins with one button and shows a refusal in the banner', async () => {
    const onJoin = vi.fn().mockResolvedValueOnce({ message: "This invitation can't be used any more." });
    render(<JoinWorkspace workspaceName="Globex" onJoin={onJoin} />);
    expect(screen.queryByLabelText('Password')).not.toBeInTheDocument();
    await userEvent.click(screen.getByRole('button', { name: 'Join Globex' }));
    expect(onJoin).toHaveBeenCalledOnce();
    expect(await screen.findByRole('alert')).toHaveTextContent("This invitation can't be used any more.");
  });

  it('offers only Sign out for another account', async () => {
    const onSignOut = vi.fn().mockResolvedValue(undefined);
    render(<WrongAccount onSignOut={onSignOut} />);
    expect(screen.queryByRole('button', { name: /Join/ })).not.toBeInTheDocument();
    await userEvent.click(screen.getByRole('button', { name: 'Sign out' }));
    expect(onSignOut).toHaveBeenCalledOnce();
  });

  it('links to sign-in and back to the invitation, with SSO when configured', async () => {
    const action = sso();
    render(<SignInToJoin invitationId={INVITATION} sso={action} />);
    expect(screen.getByRole('link', { name: 'Sign in to join' })).toHaveAttribute(
      'href',
      `/signin?redirect=%2Finvite%2F${INVITATION}`,
    );
    await userEvent.click(screen.getByRole('button', { name: 'Continue with Authentik' }));
    expect(action.onPress).toHaveBeenCalledOnce();
  });

  it('shows only the SSO button when password sign-in is off', () => {
    render(<SignInToJoin invitationId={INVITATION} sso={sso()} passwordLogin={false} />);
    expect(screen.queryByRole('link', { name: 'Sign in to join' })).not.toBeInTheDocument();
    expect(screen.getByRole('button', { name: 'Continue with Authentik' })).toBeInTheDocument();
  });

  it('turns ACCOUNT_EXISTS into a way to sign in and join', () => {
    render(
      <ErrorBanner
        error={{
          message: 'An account with this email already exists.',
          link: { href: signInToJoinHref(INVITATION), label: 'Sign in to join' },
        }}
      />,
    );
    expect(screen.getByRole('alert')).toHaveTextContent(
      'An account with this email already exists. Sign in to join',
    );
    expect(screen.getByRole('link', { name: 'Sign in to join' })).toHaveAttribute(
      'href',
      `/signin?redirect=%2Finvite%2F${INVITATION}`,
    );
  });
});
