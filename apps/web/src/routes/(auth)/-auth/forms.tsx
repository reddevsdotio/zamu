import { AccountFields, InviteFields, SignInFields, WorkspaceFields } from '@zamu/contracts';
import { useState } from 'react';
import { Link } from 'react-aria-components';
import { AUTH_ERRORS } from '~/lib/auth-client';
import { Banner, Button, buttonStyles, TextField } from '~/ui';
import { AuthForm, AuthHeading, SetupSteps } from './AuthLayout';
import { type FieldErrors, fieldErrors, hasErrors, passwordHint } from './validation';

// Forms of the signed-out screens. They validate locally and hand valid values to `onSubmit`, which
// talks to the server and resolves to an error to show, or null. Routes wire them to Better Auth.

/** An error shown in the banner above a form. */
export interface FormError {
  message: string;
  /** Adds a "Go to sign in" link (already set up, unusable invitation). */
  signInLink?: boolean;
  /** Adds this link instead, such as "Sign in to join" back to an invitation. */
  link?: { href: string; label: string };
}

export const WRONG_CREDENTIALS = 'Wrong email or password. Check both and try again.';

/** Better Auth's rate limit answered 429 (plan call 1: a short window, not a lockout). */
export const TOO_MANY_ATTEMPTS = 'Too many attempts. Wait a few seconds and try again.';

const linkClass =
  'font-semibold text-danger underline underline-offset-2 outline-none focus-visible:focus-ring';

export function ErrorBanner({ error }: { error: FormError }) {
  return (
    <Banner>
      {error.message}
      {error.link ? (
        <>
          {' '}
          <Link href={error.link.href} className={linkClass}>
            {error.link.label}
          </Link>
        </>
      ) : error.signInLink ? (
        <>
          {' '}
          <Link href="/signin" className={linkClass}>
            Go to sign in
          </Link>
        </>
      ) : null}
    </Banner>
  );
}

function useSubmit<E>() {
  const [pending, setPending] = useState(false);
  const run = async (action: () => Promise<E | null>): Promise<E | null> => {
    setPending(true);
    try {
      return await action();
    } finally {
      setPending(false);
    }
  };
  return { pending, run };
}

/** Single sign-on for a form: the button label and the action that sends the browser to the provider. */
export interface SsoAction {
  /** "Continue with Authentik", or "Continue with single sign-on". */
  label: string;
  /** Starts the redirect; resolves with an error message when it could not start. */
  onPress: () => Promise<string | null>;
}

/** "Continue with {provider}" (frame 128), pending while the browser leaves for the provider. */
export function SsoButton({ sso, onError }: { sso: SsoAction; onError: (message: string) => void }) {
  const [pending, setPending] = useState(false);
  const press = async () => {
    setPending(true);
    const error = await sso.onPress();
    // On success the page unloads; keep the button pending until then.
    if (error) {
      setPending(false);
      onError(error);
    }
  };
  return (
    <Button variant="secondary" size="lg" fullWidth isPending={pending} onPress={press}>
      {sso.label}
    </Button>
  );
}

/** The "or" divider between the form and the SSO button (screens.css .auth .or). */
export function OrDivider() {
  return (
    <div className="flex items-center gap-2.5 text-xs text-fg-3">
      <span aria-hidden className="h-px flex-1 bg-line" />
      or
      <span aria-hidden className="h-px flex-1 bg-line" />
    </div>
  );
}

/** Divider and SSO button under a password form; just the button when password sign-in is off. */
function SsoBelow({
  sso,
  onError,
  alone,
}: {
  sso: SsoAction;
  onError: (message: string) => void;
  alone?: boolean;
}) {
  return (
    <>
      {alone ? null : <OrDivider />}
      <SsoButton sso={sso} onError={onError} />
    </>
  );
}

/** Sign-in error: wrong credentials (inline under the password) or anything else (banner). */
export type SignInError = { kind: 'credentials' } | { kind: 'other'; message: string };

/** Turns what Better Auth's email sign-in answered into the error the form shows. */
export function signInError(error: {
  code?: string | undefined;
  status?: number;
  message?: string | undefined;
}): SignInError {
  if (error.code === AUTH_ERRORS.invalidCredentials || error.status === 401) return { kind: 'credentials' };
  if (error.status === 429) return { kind: 'other', message: TOO_MANY_ATTEMPTS };
  if (error.code === AUTH_ERRORS.passwordLoginDisabled) {
    return { kind: 'other', message: 'Password sign-in is turned off. Use single sign-on.' };
  }
  return { kind: 'other', message: error.message || "Couldn't sign in. Try again." };
}

export interface SignInFormProps {
  onSubmit: (values: { email: string; password: string }) => Promise<SignInError | null>;
  /** Rendered only when an OIDC provider is configured. */
  sso?: SsoAction;
  /** False when PASSWORD_LOGIN=disabled: the SSO button is the only control. */
  passwordLogin?: boolean;
  /** Shown in the banner on first render, such as an error the SSO redirect came back with. */
  initialError?: string;
}

export function SignInForm({ onSubmit, sso, passwordLogin = true, initialError }: SignInFormProps) {
  const [values, setValues] = useState({ email: '', password: '' });
  const [errors, setErrors] = useState<FieldErrors<SignInFields>>({});
  const [failure, setFailure] = useState<SignInError | null>(
    initialError ? { kind: 'other', message: initialError } : null,
  );
  const ssoFailed = (message: string) => setFailure({ kind: 'other', message });
  const { pending, run } = useSubmit<SignInError>();

  const update = (field: keyof typeof values) => (value: string) => {
    setValues((current) => ({ ...current, [field]: value }));
    setErrors((current) => ({ ...current, [field]: undefined }));
    if (failure?.kind === 'credentials') setFailure(null);
  };

  const submit = async () => {
    const found = fieldErrors(SignInFields, values);
    setErrors(found);
    if (hasErrors(found)) return;
    const result = await run(() => onSubmit({ email: values.email.trim(), password: values.password }));
    // Wrong credentials show under the password field as an alert, so screen readers announce it; focus
    // stays put so the field shows its error border rather than the focus halo.
    setFailure(result);
  };

  const wrongCredentials = failure?.kind === 'credentials';
  const banner = failure?.kind === 'other' ? <ErrorBanner error={{ message: failure.message }} /> : null;

  if (sso && !passwordLogin) {
    return (
      <>
        {banner}
        <SsoBelow sso={sso} onError={ssoFailed} alone />
      </>
    );
  }

  return (
    <>
      {banner}
      <AuthForm label="Sign in" onSubmit={submit}>
        <TextField
          label="Email"
          name="email"
          type="email"
          autoComplete="username"
          autoFocus
          value={values.email}
          onChange={update('email')}
          isInvalid={Boolean(errors.email)}
          errorMessage={errors.email}
          validationBehavior="aria"
        />
        <TextField
          label="Password"
          name="password"
          type="password"
          autoComplete="current-password"
          value={values.password}
          onChange={update('password')}
          isInvalid={Boolean(errors.password) || wrongCredentials}
          errorMessage={
            errors.password ?? (wrongCredentials ? <span role="alert">{WRONG_CREDENTIALS}</span> : undefined)
          }
          validationBehavior="aria"
        />
        <Button type="submit" variant="primary" size="lg" fullWidth isPending={pending} kbd="↵">
          Sign in
        </Button>
      </AuthForm>
      {sso ? <SsoBelow sso={sso} onError={ssoFailed} /> : null}
    </>
  );
}

export interface SetupValues {
  name: string;
  email: string;
  password: string;
  workspaceName: string;
}

export interface SetupFormProps {
  onSubmit: (values: SetupValues) => Promise<FormError | null>;
  /** Step 1 offers "Continue with {provider}" when SSO is configured. */
  sso?: SsoAction;
  /** False when PASSWORD_LOGIN=disabled: step 1 is the SSO button only. */
  passwordLogin?: boolean;
  /** Shown in the banner on first render, such as an error the SSO redirect came back with. */
  initialError?: FormError | null;
}

/** First-run form: the admin account (password or SSO), then the workspace name. */
export function SetupForm({ onSubmit, sso, passwordLogin = true, initialError = null }: SetupFormProps) {
  const [step, setStep] = useState<1 | 2>(1);
  const [values, setValues] = useState<SetupValues>({ name: '', email: '', password: '', workspaceName: '' });
  const [errors, setErrors] = useState<FieldErrors<SetupValues>>({});
  const [failure, setFailure] = useState<FormError | null>(initialError);
  const ssoFailed = (message: string) => setFailure({ message });
  const { pending, run } = useSubmit<FormError>();

  const update = (field: keyof SetupValues) => (value: string) => {
    setValues((current) => ({ ...current, [field]: value }));
    setErrors((current) => ({ ...current, [field]: undefined }));
  };

  const next = () => {
    const found = fieldErrors(AccountFields, values);
    setErrors(found);
    if (!hasErrors(found)) setStep(2);
  };

  const submit = async () => {
    const found = fieldErrors(WorkspaceFields, values);
    setErrors(found);
    if (hasErrors(found)) return;
    setFailure(
      await run(() =>
        onSubmit({
          name: values.name.trim(),
          email: values.email.trim(),
          password: values.password,
          workspaceName: values.workspaceName.trim(),
        }),
      ),
    );
  };

  return (
    <>
      <SetupSteps step={step} />
      {step === 1 ? (
        <AuthHeading
          title="Set up this server"
          subtitle="You're the first person here, so this account becomes the admin."
        />
      ) : (
        <AuthHeading
          title="Name your workspace"
          subtitle="A workspace holds your projects, people and agents. You can add more later."
        />
      )}
      {failure ? <ErrorBanner error={failure} /> : null}
      {step === 1 && sso && !passwordLogin ? (
        <SsoBelow sso={sso} onError={ssoFailed} alone />
      ) : step === 1 ? (
        <>
          <AuthForm label="Admin account" onSubmit={next}>
            <TextField
              label="Your name"
              name="name"
              autoComplete="name"
              autoFocus
              value={values.name}
              onChange={update('name')}
              isInvalid={Boolean(errors.name)}
              errorMessage={errors.name}
              validationBehavior="aria"
            />
            <TextField
              label="Email"
              name="email"
              type="email"
              autoComplete="email"
              value={values.email}
              onChange={update('email')}
              isInvalid={Boolean(errors.email)}
              errorMessage={errors.email}
              validationBehavior="aria"
            />
            <TextField
              label="Password"
              name="password"
              type="password"
              autoComplete="new-password"
              value={values.password}
              onChange={update('password')}
              description={passwordHint(values.password.length)}
              isInvalid={Boolean(errors.password)}
              errorMessage={errors.password}
              validationBehavior="aria"
            />
            <Button type="submit" variant="primary" size="lg" fullWidth kbd="↵">
              Continue
            </Button>
          </AuthForm>
          {sso ? <SsoBelow sso={sso} onError={ssoFailed} /> : null}
        </>
      ) : (
        <AuthForm label="Workspace" onSubmit={submit}>
          <TextField
            label="Workspace name"
            name="workspaceName"
            autoComplete="organization"
            autoFocus
            value={values.workspaceName}
            onChange={update('workspaceName')}
            description="Usually your team or company name."
            isInvalid={Boolean(errors.workspaceName)}
            errorMessage={errors.workspaceName}
            validationBehavior="aria"
          />
          <div className="flex gap-2.5">
            <Button
              variant="secondary"
              size="lg"
              isDisabled={pending}
              onPress={() => {
                setFailure(null);
                setStep(1);
              }}
            >
              Back
            </Button>
            <Button type="submit" variant="primary" size="lg" className="flex-1" isPending={pending} kbd="↵">
              Create workspace
            </Button>
          </div>
        </AuthForm>
      )}
    </>
  );
}

export interface WorkspaceFormProps {
  onSubmit: (workspaceName: string) => Promise<FormError | null>;
}

/** Setup step 2 after the admin signed in through SSO: only the workspace name. */
export function WorkspaceForm({ onSubmit }: WorkspaceFormProps) {
  const [workspaceName, setWorkspaceName] = useState('');
  const [error, setError] = useState<string | undefined>();
  const [failure, setFailure] = useState<FormError | null>(null);
  const { pending, run } = useSubmit<FormError>();

  const submit = async () => {
    const found = fieldErrors(WorkspaceFields, { workspaceName });
    setError(found.workspaceName);
    if (hasErrors(found)) return;
    setFailure(await run(() => onSubmit(workspaceName.trim())));
  };

  return (
    <>
      <SetupSteps step={2} />
      <AuthHeading
        title="Name your workspace"
        subtitle="A workspace holds your projects, people and agents. You can add more later."
      />
      {failure ? <ErrorBanner error={failure} /> : null}
      <AuthForm label="Workspace" onSubmit={submit}>
        <TextField
          label="Workspace name"
          name="workspaceName"
          autoComplete="organization"
          autoFocus
          value={workspaceName}
          onChange={(value) => {
            setWorkspaceName(value);
            setError(undefined);
          }}
          description="Usually your team or company name."
          isInvalid={Boolean(error)}
          errorMessage={error}
          validationBehavior="aria"
        />
        <Button type="submit" variant="primary" size="lg" fullWidth isPending={pending} kbd="↵">
          Create workspace
        </Button>
      </AuthForm>
    </>
  );
}

export interface InviteFormProps {
  email: string;
  onSubmit: (values: { name: string; password: string }) => Promise<FormError | null>;
  /** "Continue with {provider}" when SSO is configured; the provider's email must match `email`. */
  sso?: SsoAction;
  /** False when PASSWORD_LOGIN=disabled: the SSO button is the only way to join. */
  passwordLogin?: boolean;
  /** Shown in the banner on first render, such as an error the SSO redirect came back with. */
  initialError?: FormError | null;
}

/** Invitation accept: the invited email (read-only), then SSO or a name and a password. */
export function InviteForm({
  email,
  onSubmit,
  sso,
  passwordLogin = true,
  initialError = null,
}: InviteFormProps) {
  const [values, setValues] = useState({ name: '', password: '' });
  const [errors, setErrors] = useState<FieldErrors<InviteFields>>({});
  const [failure, setFailure] = useState<FormError | null>(initialError);
  const ssoFailed = (message: string) => setFailure({ message });
  const { pending, run } = useSubmit<FormError>();

  const update = (field: keyof typeof values) => (value: string) => {
    setValues((current) => ({ ...current, [field]: value }));
    setErrors((current) => ({ ...current, [field]: undefined }));
  };

  const submit = async () => {
    const found = fieldErrors(InviteFields, values);
    setErrors(found);
    if (hasErrors(found)) return;
    setFailure(await run(() => onSubmit({ name: values.name.trim(), password: values.password })));
  };

  const emailField = (
    <TextField label="Email" name="email" type="email" autoComplete="username" value={email} isReadOnly />
  );

  if (sso && !passwordLogin) {
    return (
      <>
        {failure ? <ErrorBanner error={failure} /> : null}
        {emailField}
        <SsoBelow sso={sso} onError={ssoFailed} alone />
      </>
    );
  }

  return (
    <>
      {failure ? <ErrorBanner error={failure} /> : null}
      <AuthForm label="Join workspace" onSubmit={submit}>
        {emailField}
        <TextField
          label="Your name"
          name="name"
          autoComplete="name"
          autoFocus
          value={values.name}
          onChange={update('name')}
          isInvalid={Boolean(errors.name)}
          errorMessage={errors.name}
          validationBehavior="aria"
        />
        <TextField
          label="Password"
          name="password"
          type="password"
          autoComplete="new-password"
          value={values.password}
          onChange={update('password')}
          description={passwordHint(values.password.length)}
          isInvalid={Boolean(errors.password)}
          errorMessage={errors.password}
          validationBehavior="aria"
        />
        <Button type="submit" variant="primary" size="lg" fullWidth isPending={pending} kbd="↵">
          Join workspace
        </Button>
      </AuthForm>
      {sso ? <SsoBelow sso={sso} onError={ssoFailed} /> : null}
    </>
  );
}

/** The sign-in page, coming back to the invitation afterwards. */
export function signInToJoinHref(invitationId: string): string {
  return `/signin?redirect=${encodeURIComponent(`/invite/${invitationId}`)}`;
}

export interface JoinWorkspaceProps {
  workspaceName: string;
  /** Accepts the invitation; resolves to an error to show, or null once the workspace opens. */
  onJoin: () => Promise<FormError | null>;
}

/** Signed in with the invited email: one button joins the workspace. */
export function JoinWorkspace({ workspaceName, onJoin }: JoinWorkspaceProps) {
  const [failure, setFailure] = useState<FormError | null>(null);
  const { pending, run } = useSubmit<FormError>();
  return (
    <>
      {failure ? <ErrorBanner error={failure} /> : null}
      <Button
        variant="primary"
        size="lg"
        fullWidth
        autoFocus
        isPending={pending}
        onPress={async () => setFailure(await run(onJoin))}
      >
        {`Join ${workspaceName}`}
      </Button>
    </>
  );
}

export interface WrongAccountProps {
  /** Signs out; the page then shows the invitation to a signed-out visitor. */
  onSignOut: () => Promise<void>;
}

/** Signed in with another email than the invitation's: the only way on is to sign out. */
export function WrongAccount({ onSignOut }: WrongAccountProps) {
  const [pending, setPending] = useState(false);
  const [failure, setFailure] = useState<FormError | null>(null);
  const press = async () => {
    setPending(true);
    try {
      await onSignOut();
    } catch {
      setFailure({ message: "Couldn't sign out. Try again." });
    } finally {
      setPending(false);
    }
  };
  return (
    <>
      {failure ? <ErrorBanner error={failure} /> : null}
      <Button variant="primary" size="lg" fullWidth isPending={pending} onPress={press}>
        Sign out
      </Button>
    </>
  );
}

export interface SignInToJoinProps {
  invitationId: string;
  /** "Continue with {provider}", which signs in and joins in one go; the email must match. */
  sso?: SsoAction;
  /** False when PASSWORD_LOGIN=disabled: the SSO button is the only way in. */
  passwordLogin?: boolean;
  /** Shown in the banner on first render, such as an error the SSO redirect came back with. */
  initialError?: FormError | null;
}

/** Signed out, and the invited email has an account: sign in, then come back and join. */
export function SignInToJoin({
  invitationId,
  sso,
  passwordLogin = true,
  initialError = null,
}: SignInToJoinProps) {
  const [failure, setFailure] = useState<FormError | null>(initialError);
  const ssoFailed = (message: string) => setFailure({ message });
  return (
    <>
      {failure ? <ErrorBanner error={failure} /> : null}
      {passwordLogin || !sso ? (
        <Link
          href={signInToJoinHref(invitationId)}
          className={buttonStyles({ variant: 'primary', size: 'lg', fullWidth: true })}
        >
          Sign in to join
        </Link>
      ) : null}
      {sso ? <SsoBelow sso={sso} onError={ssoFailed} alone={!passwordLogin} /> : null}
    </>
  );
}
