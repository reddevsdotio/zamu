// /welcome (PM-39): a signed-in person who belongs to no workspace, after leaving or deleting their last
// one, or after an owner removed them. When the creation policy allows it they name a workspace here
// (the New workspace form); otherwise the page says to ask an owner for an invitation. Sign out sits
// under both. Laid out like the signed-out screens; the route wires the form to the server.
import { AuthHeading, AuthLayout, PRODUCT_NAME } from '~/routes/(auth)/-auth/AuthLayout';
import { Button } from '~/ui';
import { NewWorkspaceForm, type NewWorkspaceFormProps } from './NewWorkspace';
import { WorkspaceNoticeToast } from './notice';

export interface WelcomeProps {
  /** The creation policy lets the person create a workspace. */
  canCreate: boolean;
  /** Who is signed in, for the line beside Sign out. */
  user: { name: string; email: string };
  onSignOut: () => void;
  onCreate: NewWorkspaceFormProps['onSubmit'];
  suggestSlug?: NewWorkspaceFormProps['suggestSlug'];
}

/** The column of /welcome: heading, the form when allowed, then who is signed in and Sign out. */
export function WelcomeContent({ canCreate, user, onSignOut, onCreate, suggestSlug }: WelcomeProps) {
  return (
    <>
      {canCreate ? (
        <>
          <AuthHeading
            title="Create a workspace"
            subtitle="You are not in a workspace on this server yet. Name one to start, or ask an owner of an existing workspace to invite you."
          />
          <NewWorkspaceForm layout="page" onSubmit={onCreate} suggestSlug={suggestSlug} />
        </>
      ) : (
        <AuthHeading
          title="Ask an owner for an invitation"
          subtitle="You are not in a workspace on this server yet, and only people who own a workspace can create one here. The link in an invitation opens its workspace."
        />
      )}
      <div className="flex items-center gap-3 border-t border-line-soft pt-4 text-sm text-fg-3">
        <span className="min-w-0 flex-1 truncate">
          Signed in as <span className="text-fg-2">{user.email || user.name}</span>
        </span>
        <Button variant="secondary" size="sm" onPress={onSignOut}>
          Sign out
        </Button>
      </div>
    </>
  );
}

export function WelcomeScreen(props: WelcomeProps) {
  return (
    <AuthLayout brand={PRODUCT_NAME}>
      <WelcomeContent {...props} />
      <WorkspaceNoticeToast />
    </AuthLayout>
  );
}
