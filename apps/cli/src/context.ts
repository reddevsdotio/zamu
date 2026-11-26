// State shared by the commands of one invocation, and the single place that prints results.
import { createHash } from 'node:crypto';
import { type CliData, type CliResultName, type cliDataSchemas, cliOutput } from '@zamu/contracts';
import type { z } from 'zod';
import { type ApiClient, callProcedure, createApiClient, proxyClient } from './client';
import { isKnown, readLogins } from './config';
import type { CliError } from './errors';
import { createStyle, type Style } from './format';
import { type CliIo, useColor } from './io';
import { type RequestSource, requestSource, withSourceHeaders } from './source';
import {
  type ClientFactory,
  forgetClone,
  type PickedLogin,
  pickLogin,
  refusedForClone,
  sameLogin,
} from './workspace';

export interface CommandContext {
  io: CliIo;
  style: Style;
  /** --json was given: print the versioned envelope instead of human output. */
  json: boolean;
  /** Server the command talks to, once known (named in network errors). */
  url?: string;
  /** A fingerprint of the key in use, once known. The offline queue ties each queued write to it. */
  keyId?: string;
  /** The workspace of the login in use, once known (null when the key's workspace is not known). */
  workspaceId?: string | null;
  /** --workspace, set before the command runs. */
  workspaceFlag?: string;
  /** The login in use and how it was picked, once the first client was made. */
  login?: PickedLogin;
  /** Set when a request got no answer before the command's own calls (picking the login). */
  offline?: unknown;
  /** Client with the login picked for this command (workspace.ts: --workspace, ZAMU_KEY, clone, default). */
  client: () => Promise<ApiClient>;
  /** A client without the offline queue for a login, for any server and key. */
  makeClient: ClientFactory;
  /**
   * The stored login a queued write was made with, matched on server, workspace and key
   * fingerprint, with a client for it (no offline queue). Null when no stored login fits.
   */
  loginFor: (target: LoginTarget) => Promise<{ client: ApiClient; keyId: string } | null>;
  /**
   * What the command works on, set by commands before they call the API. A Backlog.md mirror error
   * uses it to name the task's file branch and what is still allowed (see describeFailure).
   */
  target?: CommandTarget;
}

export interface LoginTarget {
  url: string;
  workspaceId?: string | undefined;
  keyId?: string | undefined;
}

export interface CommandTarget {
  /** A task reference as sent: app key or Backlog.md id, with the project that narrows it. */
  task?: { key: string; project?: string };
  /** The project key, when the command names one. */
  project?: string;
  /** The status a task update asks for, so an OPEN_ITEMS refusal can repeat the move (M6). */
  status?: string;
}

/**
 * An API client whose requests carry the machine and branch headers (M6). The source is read once
 * per invocation: pass the promise from an earlier call to reuse it.
 */
export async function apiClient(
  io: CliIo,
  credentials: { url: string; key: string; workspace?: string | null },
  source: Promise<RequestSource> = requestSource(io),
): Promise<ApiClient> {
  return createApiClient({
    url: credentials.url,
    key: credentials.key,
    workspace: credentials.workspace ?? null,
    fetch: withSourceHeaders(await source, io.fetch),
  });
}

/** Names a key without revealing it: the queue stores this, never the key. */
export function keyFingerprint(key: string): string {
  return createHash('sha256').update(key).digest('hex').slice(0, 16);
}

export function createContext(io: CliIo, json: boolean): CommandContext {
  let source: Promise<RequestSource> | undefined;
  let picking: Promise<PickedLogin> | undefined;
  const makeClient: ClientFactory = (login) => {
    source ??= requestSource(io);
    const header = login.header === undefined ? (login.workspace?.slug ?? null) : login.header;
    return apiClient(io, { url: login.url, key: login.key, workspace: header }, source);
  };
  const use = (login: PickedLogin) => {
    context.login = login;
    context.url = login.url;
    context.keyId = keyFingerprint(login.key);
    context.workspaceId = login.workspace?.id ?? null;
    if (login.offline) context.offline ??= login.offline;
  };
  const pick = async (cache = true): Promise<PickedLogin> => {
    const result = await pickLogin(io, { flag: context.workspaceFlag, makeClient, cache });
    if ('ambiguous' in result) throw new Error('unreachable: an ambiguous pick throws');
    return result;
  };

  /**
   * A login taken from the clone cache may be stale (the project moved, the key lost access): on
   * a 403 or 404 the cache entry goes, the clone is matched again, and when that picks another
   * login the call is made once more with it. 403 and 404 mean nothing was changed, so the second
   * call is safe for writes too.
   */
  const rematching = (first: ApiClient, login: PickedLogin): ApiClient => {
    let current = first;
    let retried = false;
    return proxyClient(async (path, args) => {
      try {
        return await callProcedure(current, path, args);
      } catch (error) {
        if (retried || !login.cachedFor || !refusedForClone(error)) throw error;
        retried = true;
        await forgetClone(io, login.cachedFor);
        const next = await pick(false);
        if (sameLogin(next, login)) throw error;
        use(next);
        picking = Promise.resolve(next);
        current = await makeClient(next);
        return callProcedure(current, path, args);
      }
    });
  };

  const context: CommandContext = {
    io,
    json,
    style: createStyle(useColor(io)),
    makeClient,
    client: async () => {
      picking ??= pick();
      const login = await picking;
      use(login);
      const client = await makeClient(login);
      return login.cachedFor ? rematching(client, login) : client;
    },
    loginFor: async (target) => {
      const logins = await readLogins(io).catch(() => []);
      const found = logins.find(
        (login) =>
          login.url === target.url &&
          (target.workspaceId ? isKnown(login) && login.workspace.id === target.workspaceId : true) &&
          (target.keyId ? keyFingerprint(login.key) === target.keyId : true),
      );
      return found ? { client: await makeClient(found), keyId: keyFingerprint(found.key) } : null;
    },
  };
  return context;
}

function printJson(context: CommandContext, value: unknown): void {
  // Indented for people at a terminal, one line when piped (agents pay per token).
  const text = context.io.isTTY ? JSON.stringify(value, null, 2) : JSON.stringify(value);
  context.io.stdout(`${text}\n`);
}

/**
 * Validates data against the CLI output schema and prints it: the envelope with --json, the human
 * rendering otherwise. A server response that does not fit the contract throws (exit code 5).
 */
export function emit<N extends CliResultName>(
  context: CommandContext,
  name: N,
  data: z.input<(typeof cliDataSchemas)[N]>,
  human: (data: CliData<N>) => string,
): void {
  const output = cliOutput(name, data);
  if (context.json) printJson(context, output);
  else context.io.stdout(human((output as { data: CliData<N> }).data));
}

/** Prints a failure: zamu.v1.error on stdout with --json, a message on stderr otherwise. */
export function reportError(context: CommandContext, error: CliError): void {
  if (context.json) {
    printJson(context, cliOutput('error', error.problem));
    return;
  }
  const lines = error.lines ?? [`zamu: ${error.message}`, ...error.hints.map((hint) => `  ${hint}`)];
  context.io.stderr(`${lines.join('\n')}\n`);
}
