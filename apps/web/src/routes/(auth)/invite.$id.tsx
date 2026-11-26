import { createFileRoute, useRouter } from '@tanstack/react-router';
import type { ReactNode } from 'react';
import { signInWithSso, signOut } from '~/lib/auth-client';
import {
  acceptInvitation,
  getInvitation,
  getSignInOptions,
  guardAuthPage,
  joinInvitation,
} from '~/lib/session';
import { ApiKeyHint, AuthHeading, AuthLayout, PRODUCT_NAME } from './-auth/AuthLayout';
import {
  ErrorBanner,
  type FormError,
  InviteForm,
  JoinWorkspace,
  SignInToJoin,
  signInToJoinHref,
  WrongAccount,
} from './-auth/forms';
import type { InvitationState } from './-auth/queries';
import { ssoErrorCode, ssoErrorMessage, ssoLabel, ssoName } from './-auth/sso';

// The /invite/$id link. Who sees what:
// - Signed in with the invited email: "Join <workspace>", which adds them and opens the workspace.
// - Signed in with another email: who the invitation is for, and Sign out (then the signed-out view).
// - Signed out, the email has an account: Sign in to join, back here afterwards (or SSO, which joins).
// - Signed out, no account yet: the sign-up form (name and password), or SSO.
// Invitations that can't be used show why, whoever opens them.

export const Route = createFileRoute('/(auth)/invite/$id')({
  validateSearch: (search: Record<string, unknown>): { error?: string } => {
    const error = ssoErrorCode(search.error);
    return error ? { error } : {};
  },
  // Signed-in people stay: they may be joining another workspace.
  beforeLoad: ({ location }) => guardAuthPage('any', location),
  loader: async ({ params }) => {
    const [invitation, options] = await Promise.all([
      getInvitation({ data: { id: params.id } }),
      getSignInOptions(),
    ]);
    return { ...invitation, options };
  },
  head: ({ loaderData }) => ({
    meta: [{ title: `Join ${loaderData?.workspaceName ?? 'workspace'} · ${PRODUCT_NAME}` }],
  }),
  component: InvitePage,
});

/** Banner copy for invitations that can no longer be accepted. */
const UNUSABLE: Record<Exclude<InvitationState, 'pending'>, string> = {
  expired: 'This invitation has expired. Ask your admin for a new link.',
  used: 'This invitation has already been used.',
  canceled: 'This invitation was withdrawn. Ask your admin for a new link.',
  'not-found': "This invitation link doesn't work. Check the link or ask your admin for a new one.",
};

function pendingSubtitle(inviter: string, providerName: string | null, passwordLogin: boolean): string {
  if (!providerName) return `${inviter} invited you. Choose your name and a password.`;
  const sso = ssoName(providerName);
  if (!passwordLogin) return `${inviter} invited you. Continue with ${sso} to join.`;
  return `${inviter} invited you. Choose your name and a password, or continue with ${sso}.`;
}

function sameEmail(a: string, b: string): boolean {
  return a.trim().toLowerCase() === b.trim().toLowerCase();
}

function InvitePage() {
  const { options, ...invitation } = Route.useLoaderData();
  const { session } = Route.useRouteContext();
  const { id } = Route.useParams();
  const { error } = Route.useSearch();
  const router = useRouter();
  const workspace = invitation.workspaceName;
  const providerName = options.sso?.providerName ?? null;
  const inviter = invitation.inviterName ?? 'Your admin';
  const signedInAs = session?.user.email ?? null;
  // Where the workspace opens; `/` lands in the one used last when the link had none.
  const workspaceHref = invitation.workspaceSlug ? `/w/${invitation.workspaceSlug}` : '/';

  const openWorkspace = async (slug: string | null) => {
    if (slug) await router.navigate({ to: '/w/$workspace', params: { workspace: slug } });
    else await router.navigate({ to: '/' });
  };

  const accept = async (values: { name: string; password: string }): Promise<FormError | null> => {
    // The server creates the account for the invitation's email, sets the session cookie and joins
    // the workspace; the browser only proves it holds the invitation id.
    const result = await acceptInvitation({ data: { invitationId: id, ...values } });
    if (!result.ok) {
      switch (result.code) {
        case 'ACCOUNT_EXISTS':
          return {
            message: 'An account with this email already exists.',
            link: { href: signInToJoinHref(id), label: 'Sign in to join' },
          };
        case 'INVITATION_NOT_USABLE':
          return {
            message: "This invitation can't be used any more. Ask your admin for a new link.",
            signInLink: true,
          };
        case 'PASSWORD_LOGIN_DISABLED':
          return {
            message: `Password sign-in is turned off. ${providerName ? ssoLabel(providerName) : 'Use single sign-on'} instead.`,
          };
        default:
          return { message: result.message };
      }
    }
    await openWorkspace(invitation.workspaceSlug);
    return null;
  };

  const join = async (): Promise<FormError | null> => {
    const result = await joinInvitation({ data: { invitationId: id } });
    if (!result.ok) {
      if (result.code === 'INVITATION_NOT_USABLE') {
        return { message: "This invitation can't be used any more. Ask your admin for a new link." };
      }
      // NOT_SIGNED_IN (the session ended) or WRONG_ACCOUNT (signed in elsewhere meanwhile).
      await router.invalidate();
      return { message: result.message };
    }
    await openWorkspace(result.workspaceSlug);
    return null;
  };

  const leave = async () => {
    await signOut();
    // Run the guard and loader again: the page now shows the invitation to a signed-out visitor.
    await router.invalidate();
  };

  const sso = providerName
    ? {
        label: ssoLabel(providerName),
        onPress: () =>
          signInWithSso({
            intent: 'invite',
            invitationId: id,
            callbackURL: workspaceHref,
            errorCallbackURL: `/invite/${id}`,
          }),
      }
    : undefined;
  const ssoError =
    error && providerName
      ? ssoErrorMessage(error, providerName, { invitationEmail: invitation.email })
      : null;

  const title = workspace ? `Join ${workspace}` : 'Join a workspace';
  const pendingEmail = invitation.state === 'pending' ? invitation.email : null;

  let subtitle: string;
  let body: ReactNode;
  if (!pendingEmail) {
    subtitle = 'This invitation link cannot be used.';
    body = (
      <ErrorBanner
        error={{
          message: UNUSABLE[invitation.state === 'pending' ? 'not-found' : invitation.state],
          signInLink: !session,
        }}
      />
    );
  } else if (signedInAs && sameEmail(signedInAs, pendingEmail)) {
    subtitle = `${inviter} invited you to ${workspace ?? 'a workspace'}. You're signed in as ${signedInAs}.`;
    body = <JoinWorkspace workspaceName={workspace ?? 'workspace'} onJoin={join} />;
  } else if (signedInAs) {
    subtitle = `This invitation is for ${pendingEmail}. You're signed in as ${signedInAs}. Sign out, then sign in or join with ${pendingEmail}.`;
    body = <WrongAccount onSignOut={leave} />;
  } else if (invitation.hasAccount) {
    subtitle = `${inviter} invited you. There's already an account for ${pendingEmail}, so sign in to join.`;
    body = (
      <SignInToJoin
        invitationId={id}
        sso={sso}
        passwordLogin={options.passwordLogin}
        initialError={ssoError}
      />
    );
  } else {
    subtitle = pendingSubtitle(inviter, providerName, options.passwordLogin);
    body = (
      <InviteForm
        email={pendingEmail}
        onSubmit={accept}
        passwordLogin={options.passwordLogin}
        initialError={ssoError}
        sso={sso}
      />
    );
  }

  return (
    <AuthLayout brand={workspace ?? PRODUCT_NAME}>
      <AuthHeading title={title} subtitle={subtitle} />
      {body}
      <ApiKeyHint />
    </AuthLayout>
  );
}
