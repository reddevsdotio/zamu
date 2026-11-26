// Sign-in configuration read from environment variables: single sign-on with one OpenID Connect provider,
// and whether password sign-in is allowed. Without any OIDC_* variable the server behaves as in M1.
import { WorkspaceSlug } from '@zamu/contracts';

/** New identities from the provider: `invite` only lets in existing accounts and invited people. */
export const OIDC_SIGNUP_MODES = ['invite', 'auto'] as const;
export type OidcSignupMode = (typeof OIDC_SIGNUP_MODES)[number];

/** Provider id in Better Auth, and the last segment of the callback URL. */
export const OIDC_PROVIDER_ID = 'oidc';

/** Path of the callback URL to register with the provider, relative to BETTER_AUTH_URL. */
export const OIDC_CALLBACK_PATH = `/api/auth/oauth2/callback/${OIDC_PROVIDER_ID}`;

export const DEFAULT_OIDC_PROVIDER_NAME = 'SSO';
export const DEFAULT_OIDC_SCOPES = ['openid', 'email', 'profile'];
export const DEFAULT_OIDC_GROUPS_CLAIM = 'groups';

export interface SsoConfig {
  /** OIDC_ISSUER without a trailing slash. Discovery: {issuer}/.well-known/openid-configuration. */
  issuer: string;
  clientId: string;
  clientSecret: string;
  /** Button label: "Continue with {providerName}". */
  providerName: string;
  /** Always includes openid. */
  scopes: string[];
  signup: OidcSignupMode;
  /** Groups whose members are workspace admins. Empty: roles are not synced from the provider. */
  adminGroups: string[];
  /** Claim that holds the user's groups. */
  groupsClaim: string;
  /**
   * OIDC_TRUST_EMAIL=true: the provider's email counts as verified even when email_verified is false or
   * missing (providers such as Authentik that never verify). See docs/self-hosting.md for the trade-off.
   */
  trustEmail: boolean;
  /**
   * OIDC_WORKSPACE: the slug of the workspace that auto sign-up joins and admin groups apply to. Null:
   * the oldest workspace. Invitations still open the workspace that sent them.
   */
  workspace: string | null;
}

export interface AuthConfig {
  /** Null when single sign-on is not configured. */
  sso: SsoConfig | null;
  /** False when PASSWORD_LOGIN=disabled: sign-in, setup and invitations go through SSO only. */
  passwordLogin: boolean;
  /**
   * TRUSTED_IP_HEADERS: request headers that carry the client IP, checked in order (Better Auth's
   * advanced.ipAddress.ipAddressHeaders). Null: Better Auth's default (x-forwarded-for).
   */
  ipAddressHeaders: string[] | null;
}

/** The variables readAuthConfig looks at. */
export interface AuthEnv {
  OIDC_ISSUER?: string | undefined;
  OIDC_CLIENT_ID?: string | undefined;
  OIDC_CLIENT_SECRET?: string | undefined;
  OIDC_PROVIDER_NAME?: string | undefined;
  OIDC_SCOPES?: string | undefined;
  OIDC_SIGNUP?: string | undefined;
  OIDC_ADMIN_GROUPS?: string | undefined;
  OIDC_GROUPS_CLAIM?: string | undefined;
  OIDC_TRUST_EMAIL?: string | undefined;
  OIDC_WORKSPACE?: string | undefined;
  PASSWORD_LOGIN?: string | undefined;
  TRUSTED_IP_HEADERS?: string | undefined;
}

/** An HTTP header name (RFC 9110 token characters). */
const HEADER_NAME = /^[!#$%&'*+.^_`|~0-9A-Za-z-]+$/;

/** Thrown for an invalid combination of variables. `problems` has one sentence per variable. */
export class AuthConfigError extends Error {
  constructor(readonly problems: string[]) {
    super(`Invalid sign-in configuration:\n${problems.map((problem) => `- ${problem}`).join('\n')}`);
    this.name = 'AuthConfigError';
  }
}

/** Trimmed value, or undefined when unset or blank (an empty `OIDC_ISSUER=` line in .env counts as unset). */
function read(env: AuthEnv, name: keyof AuthEnv): string | undefined {
  const value = env[name]?.trim();
  return value ? value : undefined;
}

function issuerProblem(issuer: string): string | null {
  let url: URL;
  try {
    url = new URL(issuer);
  } catch {
    return `OIDC_ISSUER is not a URL: "${issuer}". Use the issuer URL of your provider, for example https://auth.example.com/application/o/zamu/.`;
  }
  if (url.protocol !== 'https:' && url.protocol !== 'http:') {
    return `OIDC_ISSUER must start with https:// (got "${issuer}").`;
  }
  if (url.search || url.hash) {
    return `OIDC_ISSUER must not have a query string or fragment (got "${issuer}").`;
  }
  return null;
}

/**
 * Reads and checks the OIDC_* and PASSWORD_LOGIN variables. Throws AuthConfigError listing every problem,
 * so the server can refuse to start with one clear message.
 */
export function readAuthConfig(env: AuthEnv): AuthConfig {
  const problems: string[] = [];

  const issuer = read(env, 'OIDC_ISSUER');
  const clientId = read(env, 'OIDC_CLIENT_ID');
  const clientSecret = read(env, 'OIDC_CLIENT_SECRET');
  const credentials = { OIDC_ISSUER: issuer, OIDC_CLIENT_ID: clientId, OIDC_CLIENT_SECRET: clientSecret };
  const credentialsSet = Object.values(credentials).filter(Boolean).length;
  const ssoEnabled = credentialsSet === 3;

  if (credentialsSet > 0 && !ssoEnabled) {
    const missing = Object.entries(credentials)
      .filter(([, value]) => !value)
      .map(([name]) => name);
    problems.push(
      `Single sign-on needs OIDC_ISSUER, OIDC_CLIENT_ID and OIDC_CLIENT_SECRET together; ${missing.join(' and ')} ${missing.length > 1 ? 'are' : 'is'} missing.`,
    );
  }
  if (issuer) {
    const problem = issuerProblem(issuer);
    if (problem) problems.push(problem);
  }

  const providerName = read(env, 'OIDC_PROVIDER_NAME') ?? DEFAULT_OIDC_PROVIDER_NAME;
  if (providerName.length > 40) problems.push('OIDC_PROVIDER_NAME must be 40 characters or fewer.');

  const scopeValue = read(env, 'OIDC_SCOPES');
  const scopes = scopeValue ? scopeValue.split(/\s+/) : [...DEFAULT_OIDC_SCOPES];
  if (!scopes.includes('openid')) scopes.unshift('openid');

  const signupValue = read(env, 'OIDC_SIGNUP') ?? 'invite';
  const signup = OIDC_SIGNUP_MODES.find((mode) => mode === signupValue.toLowerCase());
  if (!signup) problems.push(`OIDC_SIGNUP must be "invite" or "auto" (got "${signupValue}").`);

  const adminGroups = (read(env, 'OIDC_ADMIN_GROUPS') ?? '')
    .split(',')
    .map((group) => group.trim())
    .filter(Boolean);
  const groupsClaim = read(env, 'OIDC_GROUPS_CLAIM') ?? DEFAULT_OIDC_GROUPS_CLAIM;

  const trustValue = (read(env, 'OIDC_TRUST_EMAIL') ?? 'false').toLowerCase();
  if (trustValue !== 'true' && trustValue !== 'false') {
    problems.push(`OIDC_TRUST_EMAIL must be "true" or "false" (got "${env.OIDC_TRUST_EMAIL}").`);
  }
  const trustEmail = trustValue === 'true';

  // Slugs are lower case; accept "Acme" for acme. The workspace itself is checked against the database
  // at startup (oidcWorkspaceProblem), since it may not exist before setup.
  const workspaceValue = read(env, 'OIDC_WORKSPACE')?.toLowerCase();
  let workspace: string | null = null;
  if (workspaceValue) {
    const parsed = WorkspaceSlug.safeParse(workspaceValue);
    if (parsed.success) workspace = parsed.data;
    else {
      problems.push(
        `OIDC_WORKSPACE must be a workspace slug such as "acme" (got "${env.OIDC_WORKSPACE}"): ${parsed.error.issues[0]?.message ?? 'invalid slug.'}`,
      );
    }
  }

  if (!ssoEnabled && credentialsSet === 0) {
    const extras = (
      [
        'OIDC_PROVIDER_NAME',
        'OIDC_SCOPES',
        'OIDC_SIGNUP',
        'OIDC_ADMIN_GROUPS',
        'OIDC_GROUPS_CLAIM',
        'OIDC_TRUST_EMAIL',
        'OIDC_WORKSPACE',
      ] as const
    ).filter((name) => read(env, name));
    if (extras.length > 0) {
      problems.push(
        `${extras.join(', ')} ${extras.length > 1 ? 'are' : 'is'} set, but single sign-on is not configured: set OIDC_ISSUER, OIDC_CLIENT_ID and OIDC_CLIENT_SECRET.`,
      );
    }
  }

  const passwordValue = (read(env, 'PASSWORD_LOGIN') ?? 'enabled').toLowerCase();
  if (passwordValue !== 'enabled' && passwordValue !== 'disabled') {
    problems.push(`PASSWORD_LOGIN must be "enabled" or "disabled" (got "${env.PASSWORD_LOGIN}").`);
  }
  const passwordLogin = passwordValue !== 'disabled';
  if (!passwordLogin && credentialsSet === 0) {
    problems.push(
      'PASSWORD_LOGIN=disabled needs single sign-on, or nobody could sign in: set OIDC_ISSUER, OIDC_CLIENT_ID and OIDC_CLIENT_SECRET.',
    );
  }

  const ipHeaderValue = read(env, 'TRUSTED_IP_HEADERS');
  let ipAddressHeaders: string[] | null = null;
  if (ipHeaderValue) {
    const names = ipHeaderValue.split(',').map((name) => name.trim());
    const invalid = names.filter((name) => !HEADER_NAME.test(name));
    if (invalid.length > 0) {
      problems.push(
        `TRUSTED_IP_HEADERS must be comma-separated header names, such as "cf-connecting-ip,x-forwarded-for" (invalid: ${invalid.map((name) => `"${name}"`).join(', ')}).`,
      );
    }
    ipAddressHeaders = [...new Set(names.map((name) => name.toLowerCase()))];
  }

  if (problems.length > 0) throw new AuthConfigError(problems);

  return {
    sso:
      ssoEnabled && issuer && clientId && clientSecret && signup
        ? {
            issuer: issuer.replace(/\/+$/, ''),
            clientId,
            clientSecret,
            providerName,
            scopes,
            signup,
            adminGroups,
            groupsClaim,
            trustEmail,
            workspace,
          }
        : null,
    passwordLogin,
    ipAddressHeaders,
  };
}

/** Discovery document URL of an issuer. */
export function discoveryUrl(issuer: string): string {
  return `${issuer.replace(/\/+$/, '')}/.well-known/openid-configuration`;
}
