// The shape of one workspace's /api/v1 client and query helpers, without the transport. lib/orpc.ts
// builds the real ones; tests build theirs around a fake client. Every query key starts with
// ['w', slug], so a cached list from one workspace never shows in another and switching needs no reset.
import { createTanstackQueryUtils, type RouterUtils } from '@orpc/tanstack-query';
import type { ApiClient } from '../server/api';

export type { ApiClient };

/** TanStack Query options and keys for every procedure, e.g. orpc.tasks.list.queryOptions({ input }). */
export type ApiUtils = RouterUtils<ApiClient>;

/** The /api/v1 client and query helpers of one workspace. */
export interface WorkspaceApi {
  /** The workspace's current slug, as in /w/<slug>/. */
  slug: string;
  /** Typed /api/v1 client; every call sends x-zamu-workspace: <slug>. */
  client: ApiClient;
  /** Query options and keys under ['w', slug]. */
  orpc: ApiUtils;
}

/** The query key path every query of the workspace starts with. */
export function workspaceKeyPath(slug: string): readonly string[] {
  return ['w', slug];
}

/** Query helpers for `client`, keyed under the workspace `slug`. */
export function workspaceApiOf(slug: string, client: ApiClient): WorkspaceApi {
  return { slug, client, orpc: createTanstackQueryUtils(client, { path: workspaceKeyPath(slug) }) };
}
