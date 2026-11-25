// State shared by the commands of one invocation, and the single place that prints results.
import { createHash } from 'node:crypto';
import { type CliData, type CliResultName, type cliDataSchemas, cliOutput } from '@zamu/contracts';
import type { z } from 'zod';
import { type ApiClient, createApiClient } from './client';
import { resolveCredentials } from './config';
import type { CliError } from './errors';
import { createStyle, type Style } from './format';
import { type CliIo, useColor } from './io';
import { type RequestSource, requestSource, withSourceHeaders } from './source';

export interface CommandContext {
  io: CliIo;
  style: Style;
  /** --json was given: print the versioned envelope instead of human output. */
  json: boolean;
  /** Server the command talks to, once known (named in network errors). */
  url?: string;
  /** A fingerprint of the key in use, once known. The offline queue ties each queued write to it. */
  keyId?: string;
  /** Client with the resolved credentials (ZAMU_URL / ZAMU_KEY, else the config file). */
  client: () => Promise<ApiClient>;
  /**
   * What the command works on, set by commands before they call the API. A Backlog.md mirror error
   * uses it to name the task's file branch and what is still allowed (see describeFailure).
   */
  target?: CommandTarget;
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
  credentials: { url: string; key: string },
  source: Promise<RequestSource> = requestSource(io),
): Promise<ApiClient> {
  return createApiClient({
    url: credentials.url,
    key: credentials.key,
    fetch: withSourceHeaders(await source, io.fetch),
  });
}

/** Names a key without revealing it: the queue stores this, never the key. */
export function keyFingerprint(key: string): string {
  return createHash('sha256').update(key).digest('hex').slice(0, 16);
}

export function createContext(io: CliIo, json: boolean): CommandContext {
  let source: Promise<RequestSource> | undefined;
  const context: CommandContext = {
    io,
    json,
    style: createStyle(useColor(io)),
    client: async () => {
      const credentials = await resolveCredentials(io);
      context.url = credentials.url;
      context.keyId = keyFingerprint(credentials.key);
      source ??= requestSource(io);
      return apiClient(io, credentials, source);
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
