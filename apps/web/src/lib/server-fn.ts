// Server functions act in the workspace of the page that calls them. The caller passes the page's slug
// next to the input ({ workspace, input }), and the handler resolves its actor with that slug as the
// x-zamu-workspace header, the same way /api/v1 does. Passing it as data, not as a header, works for
// browser calls and for calls made in-process during SSR alike, and TypeScript makes callers say it.
//
//   export const listThingsFn = createServerFn({ method: 'GET' })
//     .validator(inWorkspace())
//     .handler(({ data }) => runInWorkspace(data.workspace, (core, actor) => listThings(core, actor)));
//   await listThingsFn({ data: { workspace: slug } });
import { createServerOnlyFn } from '@tanstack/react-start';
import { getRequestHeaders } from '@tanstack/react-start/server';
import { WORKSPACE_HEADER } from '@zamu/contracts';
import type { Actor, CoreContext } from '@zamu/core';
import { z } from 'zod';
import { runForRequest } from '../features/settings/adapter';
import type { SettingsResult } from '../features/settings/result';
import { getServerContext } from '../server/context';

/** A slug as the URL carries it. Unknown or malformed slugs are refused by the actor lookup. */
const WorkspaceParam = z.string().trim().toLowerCase().min(1).max(255);

/** `{ workspace }`, or `{ workspace, input }` with `input` parsed by the contract schema. */
export function inWorkspace(): z.ZodObject<{ workspace: typeof WorkspaceParam }>;
export function inWorkspace<S extends z.ZodType>(
  input: S,
): z.ZodObject<{ workspace: typeof WorkspaceParam; input: S }>;
export function inWorkspace(input?: z.ZodType) {
  return input ? z.object({ workspace: WorkspaceParam, input }) : z.object({ workspace: WorkspaceParam });
}

/** The current request's headers, naming `workspace` in x-zamu-workspace. Server only. */
export const requestHeadersFor = createServerOnlyFn((workspace: string): Headers => {
  const headers = new Headers(getRequestHeaders());
  headers.set(WORKSPACE_HEADER, workspace);
  return headers;
});

/** Runs a core service as the request's actor in `workspace`, wrapped as a SettingsResult. Server only. */
export const runInWorkspace = createServerOnlyFn(
  <T>(
    workspace: string,
    service: (core: CoreContext, actor: Actor) => Promise<T>,
  ): Promise<SettingsResult<T>> => runForRequest(getServerContext(), requestHeadersFor(workspace), service),
);
