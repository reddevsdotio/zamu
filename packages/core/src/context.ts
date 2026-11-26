// What core services need from their host. Adapters build one CoreContext at startup and pass it
// (or the subset a service asks for) with the actor of each request.
import type { Auth } from '@zamu/auth';
import type { WorkspaceCreationPolicy } from '@zamu/contracts';
import type { Db } from '@zamu/db';
import type { createProvider, GitProvider, LookupFn } from '@zamu/git-providers';
import type { JobQueue } from './jobs';

export interface DbContext {
  db: Db;
  /** IANA time zone that decides "today" for cycles and milestones (APP_TIME_ZONE). Default UTC. */
  timeZone?: string;
  /** Clock override for tests. Default: the current time. */
  now?: () => Date;
}

/** Services that create API keys go through Better Auth's API-key plugin. */
export interface AuthContext extends DbContext {
  auth: Auth;
}

/** Services that build links (invitations) need the public origin of the web app. */
export interface LinkContext extends DbContext {
  /** PUBLIC_URL, e.g. https://zamu.example.com. No trailing slash needed. */
  publicUrl: string;
}

/** Builds a git provider client. Tests inject a fake; adapters pass @zamu/git-providers' createProvider. */
export type ProviderFactory = (options: Parameters<typeof createProvider>[0]) => GitProvider;

/** Services that read repositories (git connections, Backlog.md mirrors) need these. */
export interface GitContext extends DbContext {
  /** The decoded APP_ENCRYPTION_KEY (32 bytes). Undefined: git connections and mirrors are disabled. */
  encryptionKey?: Uint8Array;
  /** Default: @zamu/git-providers createProvider. */
  providerFactory?: ProviderFactory;
  /**
   * GIT_ALLOW_PRIVATE_HOSTS and GIT_HTTP_HOSTS. Default: public hosts only, HTTPS only. `lookup`
   * replaces DNS resolution in tests; production leaves it unset.
   */
  gitHosts?: { allowPrivate: boolean; httpHosts: string[]; lookup?: LookupFn };
}

/** Services that create workspaces read the creation policy (WORKSPACE_CREATION). */
export interface WorkspaceContext extends DbContext {
  /** Who may create a workspace: any person (`everyone`, the default) or people who own one already. */
  workspaceCreation?: WorkspaceCreationPolicy;
}

export interface CoreContext extends AuthContext, LinkContext, GitContext, WorkspaceContext {
  /** Producer for background jobs. Optional: services that enqueue nothing work without it. */
  jobs?: JobQueue;
}
