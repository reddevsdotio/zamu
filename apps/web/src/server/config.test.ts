import { schema } from '@zamu/db';
import { createTestDatabase, type TestDatabase } from '@zamu/db/test';
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';
import {
  checkServerConfig,
  checkServerConfigWithDatabase,
  readServerConfig,
  ServerConfigError,
  type ServerEnv,
} from './config';

const BASE: ServerEnv = {
  DATABASE_URL: 'postgres://postgres:postgres@localhost:5432/zamu',
  BETTER_AUTH_SECRET: 'a'.repeat(32),
  BETTER_AUTH_URL: 'https://projects.example.com/',
};

const SSO: ServerEnv = {
  OIDC_ISSUER: 'https://auth.example.com/application/o/zamu/',
  OIDC_CLIENT_ID: 'zamu',
  OIDC_CLIENT_SECRET: 'secret',
};

function problems(env: ServerEnv): string[] {
  try {
    readServerConfig(env);
    return [];
  } catch (error) {
    if (error instanceof ServerConfigError) return error.problems;
    throw error;
  }
}

describe('readServerConfig', () => {
  it('reads a minimal password-only configuration', () => {
    expect(readServerConfig(BASE)).toEqual({
      databaseUrl: BASE.DATABASE_URL,
      secret: BASE.BETTER_AUTH_SECRET,
      baseUrl: 'https://projects.example.com',
      publicUrl: 'https://projects.example.com',
      auth: { sso: null, passwordLogin: true, ipAddressHeaders: null },
      timeZone: 'UTC',
      encryptionKey: undefined,
      gitHosts: { allowPrivate: false, httpHosts: [] },
      workspaceCreation: 'everyone',
    });
  });

  it('reads WORKSPACE_CREATION and refuses other values', () => {
    expect(readServerConfig({ ...BASE, WORKSPACE_CREATION: 'owners' }).workspaceCreation).toBe('owners');
    expect(readServerConfig({ ...BASE, WORKSPACE_CREATION: ' Everyone ' }).workspaceCreation).toBe(
      'everyone',
    );
    expect(readServerConfig({ ...BASE, WORKSPACE_CREATION: '' }).workspaceCreation).toBe('everyone');
    expect(problems({ ...BASE, WORKSPACE_CREATION: 'admins' })).toEqual([
      'WORKSPACE_CREATION must be "everyone" or "owners" (got "admins").',
    ]);
  });

  it('reads OIDC_WORKSPACE with single sign-on', () => {
    expect(readServerConfig({ ...BASE, ...SSO, OIDC_WORKSPACE: 'acme' }).auth.sso?.workspace).toBe('acme');
    expect(problems({ ...BASE, OIDC_WORKSPACE: 'acme' })).toEqual([
      expect.stringContaining('OIDC_WORKSPACE is set, but single sign-on is not configured'),
    ]);
  });

  it('reads APP_ENCRYPTION_KEY when set and refuses a key that is not 32 bytes, without echoing it', () => {
    const key = Buffer.alloc(32, 9).toString('base64');
    expect(readServerConfig({ ...BASE, APP_ENCRYPTION_KEY: key }).encryptionKey).toEqual(
      new Uint8Array(32).fill(9),
    );
    expect(readServerConfig({ ...BASE, APP_ENCRYPTION_KEY: '  ' }).encryptionKey).toBeUndefined();
    const short = Buffer.alloc(16, 9).toString('base64');
    const found = problems({ ...BASE, APP_ENCRYPTION_KEY: short });
    expect(found).toEqual([expect.stringMatching(/^APP_ENCRYPTION_KEY must decode to 32 bytes, not 16/)]);
    expect(found.join('\n')).not.toContain(short);
    expect(problems({ ...BASE, APP_ENCRYPTION_KEY: 'not base64!' })).toEqual([
      expect.stringMatching(/^APP_ENCRYPTION_KEY is not base64/),
    ]);
  });

  it('reads GIT_ALLOW_PRIVATE_HOSTS and GIT_HTTP_HOSTS', () => {
    const config = readServerConfig({
      ...BASE,
      GIT_ALLOW_PRIVATE_HOSTS: 'true',
      GIT_HTTP_HOSTS: 'localhost:3300, Forgejo.test',
    });
    expect(config.gitHosts).toEqual({ allowPrivate: true, httpHosts: ['localhost:3300', 'forgejo.test'] });
    expect(problems({ ...BASE, GIT_ALLOW_PRIVATE_HOSTS: 'maybe' })).toEqual([
      'GIT_ALLOW_PRIVATE_HOSTS must be true or false.',
    ]);
    expect(problems({ ...BASE, GIT_HTTP_HOSTS: 'gitlab example.com' })).toEqual([
      expect.stringMatching(/^GIT_HTTP_HOSTS: /),
    ]);
  });

  it('reads APP_TIME_ZONE and rejects an unknown zone', () => {
    expect(readServerConfig({ ...BASE, APP_TIME_ZONE: 'Europe/Paris' }).timeZone).toBe('Europe/Paris');
    expect(() => readServerConfig({ ...BASE, APP_TIME_ZONE: 'Mars/Olympus' })).toThrow(/APP_TIME_ZONE/);
  });

  it('reads the production SSO configuration', () => {
    const config = readServerConfig({
      ...BASE,
      ...SSO,
      PUBLIC_URL: 'https://projects.example.com',
      OIDC_PROVIDER_NAME: 'Authentik',
      OIDC_SIGNUP: 'auto',
      OIDC_ADMIN_GROUPS: 'reddevs-sso-admins',
      PASSWORD_LOGIN: 'disabled',
    });
    expect(config.auth).toEqual({
      sso: expect.objectContaining({
        providerName: 'Authentik',
        signup: 'auto',
        adminGroups: ['reddevs-sso-admins'],
      }),
      passwordLogin: false,
      ipAddressHeaders: null,
    });
  });

  it('reads OIDC_TRUST_EMAIL and TRUSTED_IP_HEADERS', () => {
    const config = readServerConfig({
      ...BASE,
      ...SSO,
      OIDC_TRUST_EMAIL: 'true',
      TRUSTED_IP_HEADERS: 'cf-connecting-ip,x-forwarded-for',
    });
    expect(config.auth.sso?.trustEmail).toBe(true);
    expect(config.auth.ipAddressHeaders).toEqual(['cf-connecting-ip', 'x-forwarded-for']);
  });

  it('refuses invalid OIDC_TRUST_EMAIL and TRUSTED_IP_HEADERS values', () => {
    expect(problems({ ...BASE, ...SSO, OIDC_TRUST_EMAIL: 'maybe' })).toEqual([
      expect.stringContaining('OIDC_TRUST_EMAIL must be "true" or "false"'),
    ]);
    expect(problems({ ...BASE, OIDC_TRUST_EMAIL: 'true' })).toEqual([
      expect.stringContaining('single sign-on is not configured'),
    ]);
    expect(problems({ ...BASE, TRUSTED_IP_HEADERS: 'x-forwarded-for; rm' })).toEqual([
      expect.stringContaining('TRUSTED_IP_HEADERS'),
    ]);
  });

  it('refuses a missing or short BETTER_AUTH_SECRET', () => {
    expect(problems({ ...BASE, BETTER_AUTH_SECRET: undefined })).toEqual([
      'BETTER_AUTH_SECRET is not set. Generate one with `openssl rand -base64 32` and set it in .env or the container environment.',
    ]);
    expect(problems({ ...BASE, BETTER_AUTH_SECRET: '   ' })).toEqual([
      expect.stringMatching(/^BETTER_AUTH_SECRET is not set\./),
    ]);
    expect(problems({ ...BASE, BETTER_AUTH_SECRET: 'short-secret' })).toEqual([
      'BETTER_AUTH_SECRET is 12 characters; use 32 or more. Generate one with `openssl rand -base64 32` and set it in .env or the container environment.',
    ]);
  });

  it('refuses missing or malformed URLs', () => {
    expect(problems({ ...BASE, DATABASE_URL: '' })).toEqual(['DATABASE_URL is not set.']);
    expect(problems({ ...BASE, BETTER_AUTH_URL: undefined })).toEqual([
      expect.stringContaining('BETTER_AUTH_URL is not set'),
    ]);
    expect(problems({ ...BASE, BETTER_AUTH_URL: 'projects.example.com' })).toEqual([
      expect.stringContaining('BETTER_AUTH_URL must be an http:// or https:// URL'),
    ]);
    expect(problems({ ...BASE, PUBLIC_URL: 'ftp://x' })).toEqual([expect.stringContaining('PUBLIC_URL')]);
  });

  it('refuses PASSWORD_LOGIN=disabled without SSO', () => {
    expect(problems({ ...BASE, PASSWORD_LOGIN: 'disabled' })).toEqual([
      expect.stringContaining('PASSWORD_LOGIN=disabled needs single sign-on'),
    ]);
  });

  it('refuses incomplete SSO credentials and a malformed issuer', () => {
    expect(problems({ ...BASE, OIDC_ISSUER: SSO.OIDC_ISSUER })).toEqual([
      expect.stringContaining('OIDC_CLIENT_ID and OIDC_CLIENT_SECRET are missing'),
    ]);
    expect(problems({ ...BASE, ...SSO, OIDC_ISSUER: 'not a url' })).toEqual([
      expect.stringContaining('OIDC_ISSUER is not a URL'),
    ]);
    expect(problems({ ...BASE, ...SSO, OIDC_SIGNUP: 'everyone' })).toEqual([
      expect.stringContaining('OIDC_SIGNUP'),
    ]);
  });

  it('lists every problem at once', () => {
    const error = (() => {
      try {
        readServerConfig({ PASSWORD_LOGIN: 'disabled' });
      } catch (e) {
        return e;
      }
    })();
    expect(error).toBeInstanceOf(ServerConfigError);
    expect((error as ServerConfigError).problems).toHaveLength(4);
    expect((error as Error).message).toMatch(
      /^The server configuration is invalid:\n- DATABASE_URL is not set\./,
    );
  });
});

describe('checkServerConfig', () => {
  function check(env: ServerEnv, nodeEnv: string | undefined) {
    const logger = { error: vi.fn<(message: string) => void>() };
    const exit = vi.fn<(code: 1) => void>();
    const ok = checkServerConfig({ env, logger, exit, nodeEnv });
    return { ok, errors: logger.error.mock.calls.map(([message]) => message), exit };
  }

  it('passes a valid configuration without logging or exiting', () => {
    const { ok, errors, exit } = check(BASE, 'production');
    expect(ok).toBe(true);
    expect(errors).toEqual([]);
    expect(exit).not.toHaveBeenCalled();
  });

  it.each([
    ['production', 'production'],
    ['an unset NODE_ENV', undefined],
    ['test', 'test'],
  ])('logs once and exits 1 without BETTER_AUTH_SECRET in %s', (_label, nodeEnv) => {
    const { ok, errors, exit } = check({ ...BASE, BETTER_AUTH_SECRET: undefined }, nodeEnv);
    expect(ok).toBe(false);
    expect(errors).toEqual([
      'The server configuration is invalid:\n- BETTER_AUTH_SECRET is not set. Generate one with `openssl rand -base64 32` and set it in .env or the container environment.',
    ]);
    expect(exit).toHaveBeenCalledExactlyOnceWith(1);
  });

  it('exits 1 on a short secret and lists every problem in one message', () => {
    const { errors, exit } = check({ ...BASE, BETTER_AUTH_SECRET: 'short', DATABASE_URL: '' }, 'production');
    expect(errors).toHaveLength(1);
    expect(errors[0]).toContain('- DATABASE_URL is not set.');
    expect(errors[0]).toContain('- BETTER_AUTH_SECRET is 5 characters; use 32 or more.');
    expect(exit).toHaveBeenCalledExactlyOnceWith(1);
  });

  it('logs the same message but keeps running in development', () => {
    const { ok, errors, exit } = check({ ...BASE, BETTER_AUTH_SECRET: undefined }, 'development');
    expect(ok).toBe(false);
    expect(errors).toEqual([expect.stringContaining('BETTER_AUTH_SECRET is not set.')]);
    expect(exit).not.toHaveBeenCalled();
  });

  it('rethrows errors that are not configuration problems', () => {
    const env = new Proxy(BASE, {
      get() {
        throw new TypeError('env exploded');
      },
    });
    expect(() => check(env, 'production')).toThrow('env exploded');
  });
});

describe('checkServerConfigWithDatabase', () => {
  let database: TestDatabase;

  beforeAll(async () => {
    database = await createTestDatabase({ prefix: 'pm_web_config' });
  });

  afterAll(async () => {
    await database?.drop();
  });

  async function check(env: ServerEnv) {
    const logger = { error: vi.fn<(message: string) => void>(), warn: vi.fn<(message: string) => void>() };
    const exit = vi.fn<(code: 1) => void>();
    const ok = await checkServerConfigWithDatabase({ env, logger, exit, nodeEnv: 'production' });
    return {
      ok,
      errors: logger.error.mock.calls.map(([message]) => message),
      warnings: logger.warn.mock.calls.map(([message]) => message),
      exit,
    };
  }

  const env = (extra: ServerEnv = {}): ServerEnv => ({
    ...BASE,
    ...SSO,
    DATABASE_URL: database.url,
    ...extra,
  });

  it('passes OIDC_WORKSPACE before setup, when no workspace can exist yet', async () => {
    const { ok, errors, exit } = await check(env({ OIDC_WORKSPACE: 'acme' }));
    expect(ok).toBe(true);
    expect(errors).toEqual([]);
    expect(exit).not.toHaveBeenCalled();
  });

  it('exits 1 once setup is done when OIDC_WORKSPACE names no workspace', async () => {
    await database.db.insert(schema.organization).values({ name: 'Globex', slug: 'globex' });
    const { ok, errors, exit } = await check(env({ OIDC_WORKSPACE: 'acme' }));
    expect(ok).toBe(false);
    expect(errors).toEqual([
      'The server configuration is invalid:\n- OIDC_WORKSPACE is "acme", but no workspace has that slug. Set it to the slug of an existing workspace (its URL is /w/<slug>/), or unset it to use the oldest workspace.',
    ]);
    expect(exit).toHaveBeenCalledExactlyOnceWith(1);

    const named = await check(env({ OIDC_WORKSPACE: 'globex' }));
    expect(named.ok).toBe(true);
    expect(named.exit).not.toHaveBeenCalled();
  });

  it('does not touch the database without OIDC_WORKSPACE', async () => {
    const { ok, warnings } = await check({ ...BASE, DATABASE_URL: 'postgres://nobody@127.0.0.1:1/none' });
    expect(ok).toBe(true);
    expect(warnings).toEqual([]);
  });

  it('warns and starts when the database cannot be reached', async () => {
    const { ok, warnings, exit } = await check(
      env({ OIDC_WORKSPACE: 'acme', DATABASE_URL: 'postgres://nobody@127.0.0.1:1/none' }),
    );
    expect(ok).toBe(true);
    expect(warnings).toEqual([expect.stringContaining('could not check OIDC_WORKSPACE')]);
    expect(exit).not.toHaveBeenCalled();
  });

  it('stops at the environment problems without reading the database', async () => {
    const { ok, errors, warnings } = await check(env({ OIDC_WORKSPACE: 'acme', BETTER_AUTH_SECRET: '' }));
    expect(ok).toBe(false);
    expect(errors).toEqual([expect.stringContaining('BETTER_AUTH_SECRET is not set.')]);
    expect(warnings).toEqual([]);
  });
});
