// 0.10 contract additions for multiple workspaces (PM-39, PM-40): the slug rule and its reserved
// words, slug suggestions, the workspace entities and server-function inputs, the six workspace
// problem codes, the workspace header, and the CLI shapes for logins per workspace.

import { ORPCError } from '@orpc/contract';
import { describe, expect, it } from 'vitest';
import {
  CLI_CLONES_FILE_NAME,
  CLI_WORKSPACE_SOURCES,
  CliClonesFile,
  CliConfigFile,
  CliConfigFileV1,
  CliQueueEntry,
  CliQueueFile,
  cliOutput,
  parseCliOutput,
} from './cli';
import { apiErrors, WORKSPACE_HEADER } from './contract';
import { Me, MyWorkspaces, Workspace, WorkspaceContents, WorkspaceRef } from './entities';
import {
  CreateWorkspaceInput,
  DELETE_WORKSPACE_CONFIRM_MESSAGE,
  DeleteWorkspaceInput,
  LeaveWorkspaceInput,
  UpdateWorkspaceInput,
  WorkspaceName,
} from './inputs';
import {
  DEFAULT_WORKSPACE_CREATION,
  isReservedWorkspaceSlug,
  suggestWorkspaceSlug,
  WORKSPACE_SLUG_MAX_LENGTH,
  WORKSPACE_SLUG_MESSAGES,
  WORKSPACE_SLUG_MIN_LENGTH,
  WORKSPACE_SLUG_PATTERN,
  WORKSPACE_SLUG_RESERVED,
  WorkspaceCreationPolicy,
  WorkspaceSlug,
  WorkspaceSlugInput,
  workspaceSlugWithNumber,
} from './primitives';
import { PROBLEM_CODES, PROBLEM_STATUS, PROBLEM_TITLES, Problem, problem } from './problem';
import { decodeProblem, encodeProblem } from './problem-codec';
import { acmeWorkspaceFixture, globexWorkspaceFixture, meFixture } from './testing/fixtures';

/** The messages a schema reports for a value, or [] when it passes. */
function messages(schema: { safeParse: (value: unknown) => { error?: { issues: { message: string }[] } } }) {
  return (value: unknown) => schema.safeParse(value).error?.issues.map((issue) => issue.message) ?? [];
}

describe('WorkspaceSlug', () => {
  const slugMessages = messages(WorkspaceSlug);

  it('accepts lowercase letters, digits and single hyphens, starting with a letter', () => {
    for (const slug of [
      'acme',
      'globex',
      'ab',
      'a1',
      'acme-corp',
      'w-2026-team',
      'x-1-y-2',
      'a'.repeat(40),
    ]) {
      expect(WorkspaceSlug.safeParse(slug).success, slug).toBe(true);
      expect(WORKSPACE_SLUG_PATTERN.test(slug), slug).toBe(true);
    }
  });

  it('takes 2 to 40 characters', () => {
    expect(WORKSPACE_SLUG_MIN_LENGTH).toBe(2);
    expect(WORKSPACE_SLUG_MAX_LENGTH).toBe(40);
    expect(slugMessages('a')).toEqual([WORKSPACE_SLUG_MESSAGES.length]);
    expect(slugMessages('')).toContain(WORKSPACE_SLUG_MESSAGES.length);
    expect(slugMessages(`a${'b'.repeat(39)}`)).toEqual([]);
    expect(slugMessages(`a${'b'.repeat(40)}`)).toEqual([WORKSPACE_SLUG_MESSAGES.length]);
  });

  it('starts with a letter and uses only lowercase letters, digits and hyphens', () => {
    expect(slugMessages('1acme')).toContain(WORKSPACE_SLUG_MESSAGES.start);
    expect(slugMessages('-acme')).toContain(WORKSPACE_SLUG_MESSAGES.start);
    expect(slugMessages('Acme')).toContain(WORKSPACE_SLUG_MESSAGES.start);
    expect(slugMessages('acMe')).toContain(WORKSPACE_SLUG_MESSAGES.characters);
    expect(slugMessages('ac_me')).toContain(WORKSPACE_SLUG_MESSAGES.characters);
    expect(slugMessages('ac me')).toContain(WORKSPACE_SLUG_MESSAGES.characters);
    expect(slugMessages('acmé')).toContain(WORKSPACE_SLUG_MESSAGES.characters);
  });

  it('refuses double, leading and trailing hyphens', () => {
    expect(slugMessages('ac--me')).toEqual([WORKSPACE_SLUG_MESSAGES.hyphens]);
    expect(slugMessages('acme-')).toEqual([WORKSPACE_SLUG_MESSAGES.hyphens]);
    expect(slugMessages('a-')).toEqual([WORKSPACE_SLUG_MESSAGES.hyphens]);
    expect(slugMessages('-acme')).toContain(WORKSPACE_SLUG_MESSAGES.hyphens);
  });

  it('refuses every reserved word', () => {
    expect(WORKSPACE_SLUG_RESERVED).toEqual([
      'api',
      'w',
      'new',
      'settings',
      'admin',
      'setup',
      'signin',
      'invite',
      'welcome',
      'help',
      'docs',
      'static',
      'assets',
    ]);
    for (const slug of WORKSPACE_SLUG_RESERVED) {
      expect(isReservedWorkspaceSlug(slug), slug).toBe(true);
      expect(slugMessages(slug), slug).toContain(WORKSPACE_SLUG_MESSAGES.reserved);
    }
    expect(isReservedWorkspaceSlug('acme')).toBe(false);
    // Only the exact word: a slug that starts with one is fine.
    expect(slugMessages('admins')).toEqual([]);
    expect(slugMessages('api-team')).toEqual([]);
  });

  it('is strict, while WorkspaceSlugInput trims and lower-cases and leaves reserved words to core', () => {
    expect(WorkspaceSlug.safeParse(' acme ').success).toBe(false);
    expect(WorkspaceSlugInput.parse('  Acme-Corp ')).toBe('acme-corp');
    expect(WorkspaceSlugInput.parse('Admin')).toBe('admin');
    expect(messages(WorkspaceSlugInput)('ac--me')).toEqual([WORKSPACE_SLUG_MESSAGES.hyphens]);
    expect(messages(WorkspaceSlugInput)(' x ')).toEqual([WORKSPACE_SLUG_MESSAGES.length]);
  });
});

describe('suggestWorkspaceSlug', () => {
  it('builds a slug from the name as slugify does', () => {
    expect(suggestWorkspaceSlug('Acme')).toBe('acme');
    expect(suggestWorkspaceSlug('Acme Corp.')).toBe('acme-corp');
    expect(suggestWorkspaceSlug('  Globex -- Industries  ')).toBe('globex-industries');
    expect(suggestWorkspaceSlug('Café Ünion')).toBe('cafe-union');
    expect(suggestWorkspaceSlug('Initech_Payments')).toBe('initech-payments');
  });

  it('starts with a letter, fits 40 characters, and steps around short and reserved results', () => {
    expect(suggestWorkspaceSlug('2026 Team')).toBe('w-2026-team');
    expect(suggestWorkspaceSlug('Admin')).toBe('admin-workspace');
    expect(suggestWorkspaceSlug('W')).toBe('w-workspace');
    expect(suggestWorkspaceSlug('Ä')).toBe('a-workspace');
    expect(suggestWorkspaceSlug('')).toBe('workspace');
    expect(suggestWorkspaceSlug('!!!')).toBe('workspace');
    expect(suggestWorkspaceSlug(`Globex ${'industries '.repeat(5)}`)).toBe(
      'globex-industries-industries-industries',
    );
  });

  it('always returns a valid slug', () => {
    const names = [
      'Acme',
      '42',
      '-',
      'a',
      'Settings',
      'New',
      'ÆØÅ',
      '日本',
      `${'x'.repeat(39)}-y`,
      `${'ab-'.repeat(20)}`,
      'Help desk',
      ...WORKSPACE_SLUG_RESERVED,
    ];
    for (const name of names) {
      const slug = suggestWorkspaceSlug(name);
      expect(WorkspaceSlug.safeParse(slug).success, `${name} -> ${slug}`).toBe(true);
    }
  });

  it('numbers a taken slug within the length limit', () => {
    expect(workspaceSlugWithNumber('acme', 1)).toBe('acme');
    expect(workspaceSlugWithNumber('acme', 2)).toBe('acme-2');
    expect(workspaceSlugWithNumber('acme', 12)).toBe('acme-12');
    const long = 'a'.repeat(40);
    expect(workspaceSlugWithNumber(long, 2)).toBe(`${'a'.repeat(38)}-2`);
    // Cutting never leaves a double hyphen.
    const hyphen = `${'a'.repeat(37)}-bb`;
    expect(workspaceSlugWithNumber(hyphen, 3)).toBe(`${'a'.repeat(37)}-3`);
    for (const n of [2, 9, 10, 99, 100, 12345]) {
      expect(WorkspaceSlug.safeParse(workspaceSlugWithNumber(long, n)).success, String(n)).toBe(true);
      expect(WorkspaceSlug.safeParse(workspaceSlugWithNumber(hyphen, n)).success, String(n)).toBe(true);
    }
  });
});

describe('workspace creation policy', () => {
  it('is everyone or owners, everyone by default', () => {
    expect(WorkspaceCreationPolicy.options).toEqual(['everyone', 'owners']);
    expect(DEFAULT_WORKSPACE_CREATION).toBe('everyone');
    expect(WorkspaceCreationPolicy.safeParse('nobody').success).toBe(false);
  });
});

describe('workspace entities', () => {
  it('names a workspace by id, name, slug and the caller role', () => {
    expect(Workspace.parse(acmeWorkspaceFixture)).toEqual(acmeWorkspaceFixture);
    expect(Workspace.safeParse({ ...acmeWorkspaceFixture, role: 'guest' }).success).toBe(false);
    const { role: _role, ...ref } = acmeWorkspaceFixture;
    expect(WorkspaceRef.parse(ref)).toEqual(ref);
    expect(WorkspaceRef.safeParse({ ...ref, slug: '' }).success).toBe(false);
  });

  it('lists my workspaces with the creation flag', () => {
    const list = { items: [acmeWorkspaceFixture, globexWorkspaceFixture], canCreate: true };
    expect(MyWorkspaces.parse(list)).toEqual(list);
    expect(MyWorkspaces.parse({ items: [], canCreate: false }).items).toEqual([]);
    expect(MyWorkspaces.safeParse({ items: [] }).success).toBe(false);
  });

  it('counts what a delete removes', () => {
    const counts = { projects: 3, tasks: 120, agents: 2, keys: 5 };
    expect(WorkspaceContents.parse(counts)).toEqual(counts);
    expect(WorkspaceContents.safeParse({ ...counts, tasks: -1 }).success).toBe(false);
    expect(WorkspaceContents.safeParse({ projects: 3, tasks: 120, agents: 2 }).success).toBe(false);
  });

  it('requires the workspace slug in me', () => {
    expect(Me.parse(meFixture).workspace.slug).toBe('reddevs');
    const { slug: _slug, ...noSlug } = meFixture.workspace;
    expect(Me.safeParse({ ...meFixture, workspace: noSlug }).success).toBe(false);
    expect(Me.safeParse({ ...meFixture, workspace: { ...noSlug, slug: '' } }).success).toBe(false);
  });
});

describe('workspace inputs', () => {
  it('creates a workspace from a name and an optional slug', () => {
    expect(CreateWorkspaceInput.parse({ name: '  Globex ' })).toEqual({ name: 'Globex' });
    expect(CreateWorkspaceInput.parse({ name: 'Globex', slug: ' Globex-Corp ' })).toEqual({
      name: 'Globex',
      slug: 'globex-corp',
    });
    expect(CreateWorkspaceInput.safeParse({ name: '  ' }).success).toBe(false);
    expect(CreateWorkspaceInput.safeParse({ name: 'x'.repeat(65) }).success).toBe(false);
    expect(CreateWorkspaceInput.safeParse({ name: 'x'.repeat(64) }).success).toBe(true);
    expect(CreateWorkspaceInput.safeParse({ name: 'Globex', slug: 'glo--bex' }).success).toBe(false);
    expect(CreateWorkspaceInput.safeParse({ name: 'Globex', slug: '9globex' }).success).toBe(false);
    expect(CreateWorkspaceInput.safeParse({}).success).toBe(false);
    // Reserved words reach core, which answers SLUG_RESERVED.
    expect(CreateWorkspaceInput.parse({ name: 'Admin', slug: 'admin' }).slug).toBe('admin');
    expect(WorkspaceName.parse(' Acme ')).toBe('Acme');
  });

  it('updates the name, the slug or both, and needs one of them', () => {
    expect(UpdateWorkspaceInput.parse({ name: 'Acme Corp' })).toEqual({ name: 'Acme Corp' });
    expect(UpdateWorkspaceInput.parse({ slug: 'ACME-corp' })).toEqual({ slug: 'acme-corp' });
    expect(UpdateWorkspaceInput.parse({ name: 'Acme Corp', slug: 'acme-corp' })).toEqual({
      name: 'Acme Corp',
      slug: 'acme-corp',
    });
    const empty = UpdateWorkspaceInput.safeParse({});
    expect(empty.error?.issues.map((issue) => issue.message)).toEqual(['Change the name or the slug']);
    expect(UpdateWorkspaceInput.safeParse({ name: '' }).success).toBe(false);
    expect(UpdateWorkspaceInput.safeParse({ slug: 'a' }).success).toBe(false);
    expect(UpdateWorkspaceInput.safeParse({ slug: 'acme-' }).success).toBe(false);
  });

  it('leaves with no fields', () => {
    expect(LeaveWorkspaceInput.parse({})).toEqual({});
    expect(LeaveWorkspaceInput.parse({ extra: 1 })).toEqual({});
  });

  it('deletes with the slug typed again, any case', () => {
    expect(DeleteWorkspaceInput.parse({ confirmSlug: ' Acme ' })).toEqual({ confirmSlug: 'acme' });
    const empty = DeleteWorkspaceInput.safeParse({ confirmSlug: '  ' });
    expect(empty.error?.issues.map((issue) => issue.message)).toEqual([DELETE_WORKSPACE_CONFIRM_MESSAGE]);
    expect(DeleteWorkspaceInput.safeParse({}).success).toBe(false);
  });
});

describe('workspace problems', () => {
  const codes = [
    ['NOT_A_MEMBER', 403],
    ['WORKSPACE_MISMATCH', 403],
    ['WORKSPACE_CREATION_OFF', 403],
    ['SLUG_TAKEN', 409],
    ['SLUG_RESERVED', 400],
    ['LAST_OWNER', 409],
  ] as const;

  it('adds six codes with their status and a title', () => {
    for (const [code, status] of codes) {
      expect(PROBLEM_CODES, code).toContain(code);
      expect(PROBLEM_STATUS[code], code).toBe(status);
      expect(PROBLEM_TITLES[code], code).toMatch(/^[A-Z][^!]*[^.!]$/);
      expect(Problem.parse(problem(code))).toMatchObject({ code, status });
    }
  });

  it('declares only the two /api/v1 codes on the contract', () => {
    expect(apiErrors.NOT_A_MEMBER.status).toBe(403);
    expect(apiErrors.WORKSPACE_MISMATCH.status).toBe(403);
    for (const code of ['WORKSPACE_CREATION_OFF', 'SLUG_TAKEN', 'SLUG_RESERVED', 'LAST_OWNER']) {
      expect(Object.keys(apiErrors), code).not.toContain(code);
    }
  });

  it('round-trips through the problem codec', () => {
    for (const [code, status] of codes) {
      const body = encodeProblem(new ORPCError(code, { status, message: `${code} detail` }), 'req_w');
      expect(body).toMatchObject({ code, status, detail: `${code} detail`, requestId: 'req_w' });
      const error = decodeProblem(body);
      expect(error?.code).toBe(code);
      expect(error?.status).toBe(status);
    }
  });

  it('names the workspace with one request header', () => {
    expect(WORKSPACE_HEADER).toBe('x-zamu-workspace');
  });
});

describe('CLI logins per workspace', () => {
  const acme = { id: acmeWorkspaceFixture.id, name: 'Acme', slug: 'acme' };
  const globex = { id: globexWorkspaceFixture.id, name: 'Globex', slug: 'globex' };
  const url = 'https://zamu.example.com';

  it('stores logins in config version 2 with one default and one login per server and workspace', () => {
    const file = {
      version: 2,
      logins: [
        { url, key: 'zamu_acme', workspace: acme, default: true },
        { url, key: 'zamu_globex', workspace: globex, default: false },
        { url: 'https://other.example.com', key: 'zamu_other', workspace: acme, default: false },
      ],
    };
    expect(CliConfigFile.parse(file)).toEqual(file);
    expect(CliConfigFile.parse({ version: 2, logins: [] }).logins).toEqual([]);
    const twoDefaults = CliConfigFile.safeParse({
      ...file,
      logins: file.logins.map((login) => ({ ...login, default: true })),
    });
    expect(twoDefaults.error?.issues.map((issue) => issue.message)).toEqual([
      'Mark exactly one login as the default',
    ]);
    expect(
      CliConfigFile.safeParse({ ...file, logins: file.logins.map((login) => ({ ...login, default: false })) })
        .success,
    ).toBe(false);
    const twice = CliConfigFile.safeParse({
      version: 2,
      logins: [
        { url, key: 'zamu_a', workspace: acme, default: true },
        { url: `${url}/`, key: 'zamu_b', workspace: acme, default: false },
      ],
    });
    expect(twice.error?.issues).toEqual([
      expect.objectContaining({ path: ['logins', 1], message: 'Keep one login per server and workspace' }),
    ]);
    // A 0.9 file is not a version 2 file, and the other way round.
    expect(CliConfigFile.safeParse({ url, key: 'zamu_acme' }).success).toBe(false);
    expect(CliConfigFileV1.parse({ url, key: 'zamu_acme' })).toEqual({ url, key: 'zamu_acme' });
    expect(CliConfigFileV1.safeParse({ url, key: '' }).success).toBe(false);
  });

  it('caches the login matched for a clone by remote', () => {
    expect(CLI_CLONES_FILE_NAME).toBe('clones.json');
    const file = {
      version: 1,
      clones: {
        'github.com/acme/payments': { url, workspaceId: acme.id, matchedAt: '2026-11-20T10:00:00.000Z' },
      },
    };
    expect(CliClonesFile.parse(file)).toEqual(file);
    expect(
      CliClonesFile.safeParse({ version: 1, clones: { x: { url, workspaceId: 'acme', matchedAt: 'now' } } })
        .success,
    ).toBe(false);
  });

  it('ties queue entries to their workspace, and keeps 0.9 entries without one', () => {
    const entry = {
      id: 'q-01',
      queuedAt: '2026-11-20T10:00:00.000Z',
      url,
      project: 'PAY',
      taskKey: 'PAY-1',
      procedure: 'tasks.update',
      input: { key: 'PAY-1', status: 'in_review' },
      lastSeenStatus: 'in_progress',
      summary: 'move to In review',
    } as const;
    expect(CliQueueEntry.parse(entry).workspaceId).toBeUndefined();
    expect(CliQueueEntry.parse({ ...entry, workspaceId: globex.id }).workspaceId).toBe(globex.id);
    expect(CliQueueEntry.safeParse({ ...entry, workspaceId: 'globex' }).success).toBe(false);
    expect(
      CliQueueFile.parse({ version: 1, entries: [entry, { ...entry, id: 'q-02', workspaceId: acme.id }] })
        .entries,
    ).toHaveLength(2);
  });

  it('says where whoami took the login from', () => {
    expect(CLI_WORKSPACE_SOURCES).toEqual(['flag', 'env', 'clone', 'default']);
    for (const workspaceSource of CLI_WORKSPACE_SOURCES) {
      expect(cliOutput('whoami', { ...meFixture, workspaceSource }).data.workspaceSource).toBe(
        workspaceSource,
      );
    }
    expect(cliOutput('whoami', meFixture).data.workspaceSource).toBeUndefined();
    expect(() => cliOutput('whoami', { ...meFixture, workspaceSource: 'file' as never })).toThrow();
  });

  it('lists logins with zamu workspaces, never with the key', () => {
    const output = cliOutput('workspaces', {
      items: [
        { url, workspace: acme, default: true, current: false },
        { url, workspace: globex, default: false, current: true },
      ],
      source: 'clone',
    });
    expect(output.schema).toBe('zamu.v1.workspaces');
    expect(output.data.items.map((item) => item.workspace.slug)).toEqual(['acme', 'globex']);
    expect(JSON.stringify(output)).not.toContain('zamu_');
    // Zod objects strip unknown keys, so a key passed by mistake is never printed.
    const leaked = cliOutput('workspaces', {
      items: [{ url, workspace: acme, default: true, current: true, key: 'zamu_secret' } as never],
      source: 'default',
    });
    expect(JSON.stringify(leaked)).not.toContain('zamu_secret');
    expect(cliOutput('workspaces', { items: [], source: null }).data.source).toBeNull();
    expect(parseCliOutput(output, 'workspaces').data.items).toHaveLength(2);
  });

  it('reports login and logout per workspace', () => {
    expect(cliOutput('login', { url, me: meFixture, replaced: false, default: true }).data).toMatchObject({
      replaced: false,
      default: true,
    });
    expect(cliOutput('login', { url, me: meFixture }).data.replaced).toBeUndefined();
    const all = cliOutput('logout', {
      url,
      removed: [
        { url, workspace: acme, default: true },
        { url, workspace: globex, default: false },
      ],
    });
    expect(all.data.removed).toHaveLength(2);
    expect(cliOutput('logout', { url: null }).data.removed).toBeUndefined();
  });
});
