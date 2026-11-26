// zamu login, zamu logout, zamu whoami and zamu workspaces. From 0.10 zamu keeps one login per server
// and workspace; workspace.ts picks the one a command uses.
import { relative } from 'node:path';
import {
  ApiKeySecret,
  type CliLoginView,
  type CliResolvedProject,
  type CliWorkspaceSource,
  type Me,
  Me as MeSchema,
  parseRepositoryUrl,
  toProblemIssues,
} from '@zamu/contracts';
import {
  configPath,
  DEFAULT_URL,
  deleteConfig,
  envKey,
  envKeyName,
  envUrl,
  isKnown,
  type KnownLogin,
  type Login,
  loginLabel,
  normalizeUrl,
  readLogins,
  updateLogins,
} from '../config';
import { type CommandContext, emit } from '../context';
import { usageError } from '../errors';
import { fields, personLabel, scopeLabel, table } from '../format';
import { resolveProject } from '../project';
import { countQueued } from '../queue';
import {
  ambiguousError,
  forgetClonesOf,
  loginsNamed,
  type PickedLogin,
  pickLogin,
  sameLogin,
} from '../workspace';

export interface LoginOptions {
  key: string;
  url?: string;
  default?: boolean;
}

export interface LogoutOptions {
  all?: boolean;
}

export interface WorkspacesOptions {
  default?: string;
}

function whoLine(me: Me): string {
  return `${personLabel(me.user)} (${me.user.kind === 'agent' ? 'agent' : (me.user.email ?? 'person')})`;
}

/** "PAY (from .zamu.json)", for whoami. */
function projectLabel(context: CommandContext, project: CliResolvedProject | null | undefined): string {
  if (!project) return 'none here: pass --project, or run zamu link in a clone';
  const from = {
    flag: '--project',
    env: 'ZAMU_PROJECT',
    file: project.from ? relative(context.io.cwd, project.from) || project.from : '.zamu.json',
    remote: `git remote ${parseRepositoryUrl(project.from ?? '')?.short ?? project.from ?? ''}`,
  }[project.source];
  return `${project.key} (from ${from})`;
}

/** How the login was picked, for whoami and zamu workspaces. */
function sourceLabel(context: CommandContext, source: CliWorkspaceSource): string {
  return {
    flag: '--workspace',
    env: envKeyName(context.io),
    clone: "the login for this clone's git remote",
    default: 'the default login',
  }[source];
}

/** "2 writes wait for the server (zamu queue)", for whoami (M6). */
function queuedLabel(queued: number): string {
  if (queued === 0) return 'nothing';
  return `${queued === 1 ? '1 write waits' : `${queued} writes wait`} for the server (zamu queue)`;
}

function meFields(
  context: CommandContext,
  me: Me,
  url: string,
  extra: { source?: CliWorkspaceSource; project?: CliResolvedProject | null; queued?: number } = {},
): string {
  const { source, project, queued } = extra;
  return fields(
    [
      ['Workspace', `${me.workspace.name} (${me.workspace.slug})`],
      ...(source === undefined
        ? []
        : [['Login', `from ${sourceLabel(context, source)}`] as [string, string]]),
      ['Role', me.role],
      ['Access', me.auth.scope ? `API key: ${scopeLabel(me.auth.scope)}` : 'Session: full member rights'],
      ['Server', url],
      ...(project === undefined ? [] : [['Project', projectLabel(context, project)] as [string, string]]),
      ...(queued === undefined ? [] : [['Queued', queuedLabel(queued)] as [string, string]]),
    ],
    context.style,
  );
}

const view = (login: KnownLogin): CliLoginView => ({
  url: login.url,
  workspace: login.workspace,
  default: login.default,
});

/**
 * Logins of 0.9 files have no workspace yet. Before a login is added next to one, ask the server
 * for it; a login the server refuses or that gets no answer can't be kept in the new file.
 */
async function convertOld(context: CommandContext, logins: Login[], key: string): Promise<KnownLogin[]> {
  const converted: KnownLogin[] = [];
  for (const login of logins) {
    if (isKnown(login) || login.key === key) continue;
    try {
      const client = await context.makeClient(login);
      const me = MeSchema.parse(await client.me.get());
      converted.push({ ...login, workspace: me.workspace });
    } catch {
      context.io.stderr(
        `zamu: the login stored by an earlier zamu for ${login.url} could not be checked, so it was not kept. Run zamu login again for it.\n`,
      );
    }
  }
  return converted;
}

export async function login(context: CommandContext, options: LoginOptions): Promise<void> {
  const { io } = context;
  const key = options.key === '-' ? (await io.readStdin()).trim() : options.key.trim();
  const parsedKey = ApiKeySecret.safeParse(key);
  if (!parsedKey.success) {
    throw usageError('That is not a zamu API key.', toProblemIssues(parsedKey.error.issues), [
      'Keys start with zamu_live_. Create one in Settings > API keys.',
    ]);
  }
  const before = await readLogins(io).catch(() => [] as Login[]);
  const storedUrl = (before.find((stored) => stored.default) ?? before[0])?.url;
  const url = normalizeUrl(options.url ?? (io.env.ZAMU_URL || storedUrl || DEFAULT_URL));
  context.url = url;

  // No workspace header: the key tells which workspace it is for.
  const client = await context.makeClient({ url, key: parsedKey.data, workspace: null });
  const me = MeSchema.parse(await client.me.get());
  const converted = await convertOld(context, before, parsedKey.data);

  const added: KnownLogin = { url, key: parsedKey.data, workspace: me.workspace, default: false };
  let replaced = false;
  const written = await updateLogins(io, (stored) => {
    const known = [
      ...stored.filter(isKnown),
      ...converted.filter((old) => !stored.some((other) => sameLogin(other, old))),
    ];
    const index = known.findIndex((other) => sameLogin(other, added));
    replaced = index !== -1;
    const alone = known.length === (replaced ? 1 : 0);
    added.default = options.default === true || alone || (replaced && known[index]?.default === true);
    const next = known.map((other) => (added.default ? { ...other, default: false } : other));
    // A new key for a stored login keeps its place in the list.
    if (replaced) next[index] = added;
    else next.push(added);
    return next;
  });
  const isDefault = written.find((stored) => sameLogin(stored, added))?.default ?? false;
  const defaultLogin = written.find((stored) => stored.default);
  const path = configPath(io);

  if (envKey(io) && envKey(io) !== parsedKey.data) {
    io.stderr(`zamu: ${envKeyName(io)} is set in this shell and takes precedence over the stored logins.\n`);
  }
  emit(context, 'login', { url, me, replaced, default: isDefault }, (data) => {
    const { style } = context;
    const slug = data.me.workspace.slug;
    const lines = [
      `Logged in as ${style.bold(whoLine(data.me))}`,
      meFields(context, data.me, data.url).trimEnd(),
      style.dim(
        `${data.replaced ? 'Replaced the stored key' : 'Key stored'} for ${slug} in ${path}${data.default ? ' (the default login)' : ''}.`,
      ),
    ];
    if (!data.default && defaultLogin) {
      lines.push(
        style.dim(
          `The default login stays ${defaultLogin.workspace.slug}. Clones linked to a project of ${slug} pick ${slug}; ` +
            `elsewhere pass --workspace ${slug}, or run zamu workspaces --default ${slug}.`,
        ),
      );
    }
    return `${lines.join('\n')}\n`;
  });
}

/** The login `zamu logout` without --all removes: --workspace, else the one this clone uses. */
async function loginToRemove(context: CommandContext, logins: Login[]): Promise<Login> {
  const { io } = context;
  // A 0.9 file holds a single login with no workspace yet: it is the one.
  const old = logins.find((stored) => !isKnown(stored));
  if (old) return old;
  const url = envUrl(io);
  const candidates = url ? logins.filter((stored) => stored.url === url) : logins;
  const flag = context.workspaceFlag;
  if (flag !== undefined) {
    const named = loginsNamed(candidates, flag);
    if (named.length === 1) return named[0] as KnownLogin;
    if (named.length > 1) throw ambiguousError(named, `--workspace ${flag} matches ${named.length} logins.`);
    throw usageError(
      `No login for workspace ${flag}.`,
      [{ path: 'workspace', message: 'No such login' }],
      ['zamu workspaces lists the stored logins.'],
    );
  }
  const result = await pickLogin(io, { env: false, ambiguous: 'return', makeClient: context.makeClient });
  if ('ambiguous' in result) {
    const failure = ambiguousError(result.ambiguous, `This clone matches ${result.ambiguous.length} logins.`);
    failure.lines?.push('  zamu logout --all removes every login.');
    throw failure;
  }
  if (result.offline && candidates.length > 1) {
    throw usageError(
      "The server didn't answer, so zamu can't tell which login this clone uses.",
      [{ path: 'workspace', message: 'Pass --workspace' }],
      ['Pass --workspace <slug>, or --all to remove every login.'],
    );
  }
  return result.stored as Login;
}

export async function logout(context: CommandContext, options: LogoutOptions = {}): Promise<void> {
  const { io } = context;
  const path = configPath(io);
  let removed: Login[];
  if (options.all) {
    removed = await deleteConfig(io);
  } else {
    const logins = await readLogins(io).catch(() => null);
    if (logins === null) {
      // An unreadable file: logging out removes it, as before.
      removed = await deleteConfig(io);
    } else if (logins.length === 0) {
      removed = [];
    } else {
      const target = await loginToRemove(context, logins);
      await updateLogins(io, (stored) =>
        stored.filter(isKnown).filter((other) => isKnown(target) && !sameLogin(other, target)),
      );
      removed = [target];
    }
  }
  const known = removed.filter(isKnown);
  await forgetClonesOf(io, known);
  const left = (await readLogins(io).catch(() => [] as Login[])).filter(isKnown);
  const nextDefault = left.find((stored) => stored.default);

  emit(context, 'logout', { url: removed[0]?.url ?? null, removed: known.map(view) }, (data) => {
    if (removed.length === 0) return 'Not logged in; nothing to remove.\n';
    const lines =
      removed.length === 1
        ? [`Logged out of ${loginLabel(removed[0] as Login)}.`]
        : [
            `Logged out of ${removed.length} logins: ${data.removed?.map((one) => one.workspace.slug).join(', ')}.`,
          ];
    if (left.length === 0) lines.push(`Removed ${path}.`);
    else if (nextDefault && known.some((one) => one.default)) {
      lines.push(`${nextDefault.workspace.slug} is the default login now.`);
    }
    if (envKey(io)) lines.push(`${envKeyName(io)} is still set in this shell, so commands keep using it.`);
    return `${lines.join('\n')}\n`;
  });
}

export async function whoami(context: CommandContext): Promise<void> {
  const client = await context.client();
  const me = MeSchema.parse(await client.me.get());
  const url = context.url as string;
  const login = context.login;
  await refreshStored(context, login, me);
  const project = await resolveProject(context);
  // Counted after the client sent what it could: what still waits for this server and workspace.
  const queued = await countQueued(context.io, url, me.workspace.id).catch(() => undefined);
  const source = login?.source;
  emit(
    context,
    'whoami',
    {
      ...me,
      project,
      ...(queued === undefined ? {} : { queued }),
      ...(source ? { workspaceSource: source } : {}),
    },
    (data) =>
      `${context.style.bold(whoLine(data))}\n${meFields(context, data, url, {
        ...(data.workspaceSource ? { source: data.workspaceSource } : {}),
        project: data.project ?? null,
        ...(data.queued === undefined ? {} : { queued: data.queued }),
      })}`,
  );
}

/** A renamed workspace (or a new slug) updates the stored login, so messages and the header follow. */
async function refreshStored(context: CommandContext, login: PickedLogin | undefined, me: Me): Promise<void> {
  const stored = login?.stored;
  if (!stored || !isKnown(stored) || stored.workspace.id !== me.workspace.id) return;
  if (stored.workspace.name === me.workspace.name && stored.workspace.slug === me.workspace.slug) return;
  await updateLogins(context.io, (logins) =>
    logins
      .filter(isKnown)
      .map((other) => (sameLogin(other, stored) ? { ...other, workspace: me.workspace } : other)),
  ).catch(() => {});
}

// ---------------------------------------------------------------------------
// zamu workspaces
// ---------------------------------------------------------------------------

/** Converts a 0.9 login if there is one, so it can be listed. Offline it stays as it is. */
async function convertedLogins(context: CommandContext): Promise<Login[]> {
  const logins = await readLogins(context.io);
  if (logins.every(isKnown)) return logins;
  await pickLogin(context.io, { env: false, makeClient: context.makeClient }).catch(() => null);
  return readLogins(context.io);
}

export async function workspaces(context: CommandContext, options: WorkspacesOptions = {}): Promise<void> {
  const { io } = context;
  let logins = await convertedLogins(context);
  if (options.default !== undefined) {
    const wanted = options.default;
    const url = envUrl(io);
    const named = loginsNamed(url ? logins.filter((stored) => stored.url === url) : logins, wanted);
    if (named.length > 1) throw ambiguousError(named, `${wanted} matches ${named.length} logins.`);
    const chosen = named[0];
    if (!chosen) {
      throw usageError(
        `No login for workspace ${wanted}.`,
        [{ path: 'default', message: 'No such login' }],
        ['zamu workspaces lists the stored logins; zamu login --key <key> adds one.'],
      );
    }
    await updateLogins(io, (stored) =>
      stored.filter(isKnown).map((other) => ({ ...other, default: sameLogin(other, chosen) })),
    );
    logins = await readLogins(io);
  }

  const known = logins.filter(isKnown);
  let source: CliWorkspaceSource | null = null;
  let current: KnownLogin | null = null;
  let ambiguous = false;
  if (envKey(io)) source = 'env';
  else if (known.length > 0) {
    const result = await pickLogin(io, {
      env: false,
      flag: context.workspaceFlag,
      ambiguous: 'return',
      makeClient: context.makeClient,
    }).catch(() => null);
    if (result && 'ambiguous' in result) ambiguous = true;
    else if (result?.stored && isKnown(result.stored)) {
      current = result.stored;
      source = result.source;
    }
  }
  const items = known.map((stored) => ({
    ...view(stored),
    current: current !== null && sameLogin(stored, current),
  }));
  const pending = logins.find((stored) => !isKnown(stored));

  emit(context, 'workspaces', { items, source }, (data) => {
    const { style } = context;
    const lines: string[] = [];
    if (data.items.length === 0) {
      lines.push(
        pending
          ? `The login stored by an earlier zamu for ${pending.url} gets its workspace on the next command that reaches the server.`
          : 'No stored logins. Run zamu login --key <key> once per workspace.',
      );
      return `${lines.join('\n')}\n`;
    }
    lines.push(
      table(
        data.items,
        [
          { header: ' ', value: (item) => (item.current ? '*' : ' ') },
          { header: 'WORKSPACE', value: (item) => item.workspace.slug },
          { header: 'NAME', value: (item) => item.workspace.name },
          { header: 'SERVER', value: (item) => item.url },
          { header: 'DEFAULT', value: (item) => (item.default ? 'yes' : '') },
        ],
        style,
        io.isTTY ? io.columns : undefined,
      ).trimEnd(),
    );
    const here = data.items.find((item) => item.current);
    if (data.source === 'env') {
      lines.push('', `${envKeyName(io)} is set in this shell, so commands use it instead of these logins.`);
    } else if (ambiguous) {
      lines.push('', 'Several logins match this clone, so commands here need --workspace <slug>.');
    } else if (here && data.source) {
      lines.push('', `* used here: ${here.workspace.slug}, from ${sourceLabel(context, data.source)}.`);
    }
    return `${lines.join('\n')}\n`;
  });
}
