import { describe, expect, it } from 'vitest';
import { AuthConfigError, type AuthEnv, discoveryUrl, readAuthConfig } from './config';

const SSO: AuthEnv = {
  OIDC_ISSUER: 'https://auth.example.com/application/o/zamu/',
  OIDC_CLIENT_ID: 'client',
  OIDC_CLIENT_SECRET: 'secret',
};

function problems(env: AuthEnv): string[] {
  try {
    readAuthConfig(env);
  } catch (error) {
    if (error instanceof AuthConfigError) return error.problems;
    throw error;
  }
  return [];
}

describe('readAuthConfig', () => {
  it('keeps M1 behaviour without any variable', () => {
    expect(readAuthConfig({})).toEqual({ sso: null, passwordLogin: true, ipAddressHeaders: null });
  });

  it('treats blank values as unset', () => {
    expect(
      readAuthConfig({ OIDC_ISSUER: '', OIDC_CLIENT_ID: ' ', PASSWORD_LOGIN: '', TRUSTED_IP_HEADERS: '' }),
    ).toEqual({ sso: null, passwordLogin: true, ipAddressHeaders: null });
  });

  it('enables SSO with defaults when issuer, client ID and secret are set', () => {
    expect(readAuthConfig(SSO)).toEqual({
      sso: {
        issuer: 'https://auth.example.com/application/o/zamu',
        clientId: 'client',
        clientSecret: 'secret',
        providerName: 'SSO',
        scopes: ['openid', 'email', 'profile'],
        signup: 'invite',
        adminGroups: [],
        groupsClaim: 'groups',
        trustEmail: false,
        workspace: null,
      },
      passwordLogin: true,
      ipAddressHeaders: null,
    });
  });

  it('reads the optional variables', () => {
    const config = readAuthConfig({
      ...SSO,
      OIDC_PROVIDER_NAME: 'Authentik',
      OIDC_SCOPES: 'email profile  offline_access',
      OIDC_SIGNUP: 'auto',
      OIDC_ADMIN_GROUPS: 'reddevs-sso-admins, ops ,',
      OIDC_GROUPS_CLAIM: 'roles',
      OIDC_TRUST_EMAIL: 'TRUE',
      PASSWORD_LOGIN: 'disabled',
    });
    expect(config).toEqual({
      sso: expect.objectContaining({
        providerName: 'Authentik',
        scopes: ['openid', 'email', 'profile', 'offline_access'],
        signup: 'auto',
        adminGroups: ['reddevs-sso-admins', 'ops'],
        groupsClaim: 'roles',
        trustEmail: true,
      }),
      passwordLogin: false,
      ipAddressHeaders: null,
    });
  });

  it('refuses incomplete credentials, naming what is missing', () => {
    expect(problems({ OIDC_ISSUER: SSO.OIDC_ISSUER })).toEqual([
      expect.stringContaining('OIDC_CLIENT_ID and OIDC_CLIENT_SECRET are missing'),
    ]);
    expect(problems({ OIDC_CLIENT_ID: 'client', OIDC_CLIENT_SECRET: 'secret' })).toEqual([
      expect.stringContaining('OIDC_ISSUER is missing'),
    ]);
  });

  it('refuses a malformed issuer', () => {
    expect(problems({ ...SSO, OIDC_ISSUER: 'auth.example.com' })).toEqual([
      expect.stringContaining('OIDC_ISSUER is not a URL'),
    ]);
    expect(problems({ ...SSO, OIDC_ISSUER: 'ftp://auth.example.com' })).toEqual([
      expect.stringContaining('must start with https://'),
    ]);
    expect(problems({ ...SSO, OIDC_ISSUER: 'https://auth.example.com/?tenant=1' })).toEqual([
      expect.stringContaining('query string'),
    ]);
  });

  it('refuses an unknown OIDC_SIGNUP or PASSWORD_LOGIN value', () => {
    expect(problems({ ...SSO, OIDC_SIGNUP: 'open' })).toEqual([expect.stringContaining('OIDC_SIGNUP')]);
    expect(problems({ ...SSO, PASSWORD_LOGIN: 'off' })).toEqual([expect.stringContaining('PASSWORD_LOGIN')]);
  });

  it('reads OIDC_TRUST_EMAIL as true or false only', () => {
    expect(readAuthConfig({ ...SSO, OIDC_TRUST_EMAIL: 'true' }).sso?.trustEmail).toBe(true);
    expect(readAuthConfig({ ...SSO, OIDC_TRUST_EMAIL: 'false' }).sso?.trustEmail).toBe(false);
    for (const value of ['yes', '1', 'on']) {
      expect(problems({ ...SSO, OIDC_TRUST_EMAIL: value })).toEqual([
        `OIDC_TRUST_EMAIL must be "true" or "false" (got "${value}").`,
      ]);
    }
  });

  it('reads OIDC_WORKSPACE as a slug, lower-cased', () => {
    expect(readAuthConfig({ ...SSO, OIDC_WORKSPACE: ' Acme ' }).sso?.workspace).toBe('acme');
    expect(readAuthConfig({ ...SSO, OIDC_WORKSPACE: '' }).sso?.workspace).toBeNull();
    expect(readAuthConfig(SSO).sso?.workspace).toBeNull();
  });

  it.each([
    ['acme corp', 'Use lowercase letters, digits and hyphens.'],
    ['a', 'Use 2 to 40 characters.'],
    ['acme-', 'Use single hyphens between letters or digits, not at the end.'],
    ['admin', 'This address is reserved. Pick another.'],
  ])('refuses OIDC_WORKSPACE=%j', (value, reason) => {
    expect(problems({ ...SSO, OIDC_WORKSPACE: value })).toEqual([
      `OIDC_WORKSPACE must be a workspace slug such as "acme" (got "${value}"): ${reason}`,
    ]);
  });

  it('refuses OIDC_WORKSPACE without SSO', () => {
    expect(problems({ OIDC_WORKSPACE: 'acme' })).toEqual([
      expect.stringContaining('OIDC_WORKSPACE is set, but single sign-on is not configured'),
    ]);
  });

  it('refuses OIDC_TRUST_EMAIL without SSO', () => {
    expect(problems({ OIDC_TRUST_EMAIL: 'true' })).toEqual([
      expect.stringContaining('OIDC_TRUST_EMAIL is set, but single sign-on is not configured'),
    ]);
  });

  it('reads TRUSTED_IP_HEADERS in order, lowercased, with or without SSO', () => {
    expect(
      readAuthConfig({ TRUSTED_IP_HEADERS: 'CF-Connecting-IP, x-forwarded-for' }).ipAddressHeaders,
    ).toEqual(['cf-connecting-ip', 'x-forwarded-for']);
    expect(readAuthConfig({ ...SSO, TRUSTED_IP_HEADERS: 'x-real-ip' }).ipAddressHeaders).toEqual([
      'x-real-ip',
    ]);
  });

  it('refuses TRUSTED_IP_HEADERS that are not header names', () => {
    expect(problems({ TRUSTED_IP_HEADERS: 'cf-connecting-ip, x forwarded for' })).toEqual([
      expect.stringContaining('invalid: "x forwarded for"'),
    ]);
    expect(problems({ TRUSTED_IP_HEADERS: 'x-forwarded-for,,x-real-ip' })).toEqual([
      expect.stringContaining('invalid: ""'),
    ]);
    expect(problems({ TRUSTED_IP_HEADERS: 'x-real-ip:' })).toEqual([
      expect.stringContaining('TRUSTED_IP_HEADERS must be comma-separated header names'),
    ]);
  });

  it('refuses PASSWORD_LOGIN=disabled without SSO', () => {
    expect(problems({ PASSWORD_LOGIN: 'disabled' })).toEqual([
      expect.stringContaining('PASSWORD_LOGIN=disabled needs single sign-on'),
    ]);
  });

  it('refuses SSO options without SSO', () => {
    expect(problems({ OIDC_SIGNUP: 'auto', OIDC_ADMIN_GROUPS: 'admins' })).toEqual([
      expect.stringContaining('OIDC_SIGNUP, OIDC_ADMIN_GROUPS are set, but single sign-on is not configured'),
    ]);
  });

  it('refuses a provider name longer than 40 characters', () => {
    expect(problems({ ...SSO, OIDC_PROVIDER_NAME: 'x'.repeat(41) })).toEqual([
      expect.stringContaining('OIDC_PROVIDER_NAME'),
    ]);
  });

  it('lists every problem in one error', () => {
    const error = (() => {
      try {
        readAuthConfig({ OIDC_ISSUER: 'nope', OIDC_SIGNUP: 'open', PASSWORD_LOGIN: 'disabled' });
      } catch (e) {
        return e as AuthConfigError;
      }
    })();
    expect(error).toBeInstanceOf(AuthConfigError);
    expect(error?.problems.length).toBeGreaterThanOrEqual(3);
    expect(error?.message).toMatch(/^Invalid sign-in configuration:\n- /);
  });

  it('builds the discovery URL', () => {
    expect(discoveryUrl('https://auth.example.com/application/o/zamu/')).toBe(
      'https://auth.example.com/application/o/zamu/.well-known/openid-configuration',
    );
  });
});
