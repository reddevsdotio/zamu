// Authorization: who may do what. Every service calls authorize() (or can()) before touching data.
// Rules from section 5 "Authorization" of the M1 plan:
// - Read: any workspace member, within key scope.
// - Write tasks and create projects: any member, within key scope, and a key needs write access.
// - Manage members, invitations and agents: admins.
// - Create or revoke an agent's keys: admins and the agent's responsible human. Your own keys: yourself.
// - Agents cannot create other agents or keys.
// M2 (section 5 "Authorization (additions)" of the M2 plan):
// - Milestones, cycles, comments and the timeline: read with project.read, write with task.write.
//   Editing or deleting a comment also needs authorship, which comments.ts checks.
// - Turning milestones or cycles on or off: project.update.
// - Your own preferences (theme): people through a session only; API keys get 403.
// M3 (section 5 "Authorization (additions)" of the M3 plan):
// - Git connections: owners and admins manage them; everyone lists them (workspace.read), never
//   seeing tokens.
// - Backlog.md: set up, edit mappings, show the webhook secret and detach are for owners and
//   admins; refreshing is for them and for agents whose key can write the project; anyone who can
//   read the project reads the source status and its problems.
// 0.6.0 (PM-12): deleting a project is for owners and admins, people only; through an API key only
//   a workspace-wide write key.
// M5: labels follow milestones: read with project.read, create, rename, recolour and delete with
//   task.write. Bulk task changes need task.write on every project they touch.
// M6: a project's task defaults (default done items) are for owners and admins, people only;
//   through an API key only a workspace-wide write key. The request actor also carries the machine
//   and branch the CLI sent, which core writes on activity rows and comments.
import type { Actor as RequestActor, WorkspaceRole } from '@zamu/auth';
import type { EntrySource } from '@zamu/contracts';
import { Forbidden } from './errors';

export type { WorkspaceRole };

/**
 * Who makes a request (see @zamu/auth). M6: `source` holds the CLI's x-zamu-machine and
 * x-zamu-branch headers; it is absent for the web app, jobs and tests that don't set it.
 */
export interface Actor extends RequestActor {
  source?: EntrySource | null;
}

/** The owner of an API key, as needed to decide who may manage it. */
export interface KeyOwner {
  id: string;
  kind: 'person' | 'agent';
  responsibleUserId: string | null;
}

export type Resource =
  | { type: 'workspace' }
  | { type: 'project'; projectId: string }
  | { type: 'apiKeyOwner'; owner: KeyOwner };

export type Action =
  /** See the workspace: members, the caller's own profile. */
  | 'workspace.read'
  /** Change the caller's own preferences, such as the theme. People signed in with a session. */
  | 'profile.update'
  /** Create a project. Keys need write access to every project. */
  | 'project.create'
  /** Read a project and its tasks, activity, milestones, cycles and comments. */
  | 'project.read'
  /** Rename a project or change its key or description. */
  | 'project.update'
  /** Delete a project with everything in it. Owners and admins, people only. */
  | 'project.delete'
  /** Create and update tasks, milestones and cycles in a project, end cycles, comment. */
  | 'task.write'
  /** Invite people, add agents, remove members. */
  | 'member.manage'
  /** See every API key in the workspace. */
  | 'apiKey.listWorkspace'
  /** See the keys owned by `owner`. */
  | 'apiKey.list'
  /** Create an API key for `owner`. */
  | 'apiKey.create'
  /** Revoke an API key owned by `owner`. */
  | 'apiKey.revoke'
  /** Add, change, test and delete git connections. Listing them needs only workspace.read. */
  | 'connection.manage'
  /** Set up a Backlog.md source, edit its mappings, folder and connection, see the webhook secret, detach. */
  | 'backlog.manage'
  /** Ask for a Backlog.md refresh now (Refresh now, zamu backlog refresh). */
  | 'backlog.refresh'
  /** Read a project's Backlog.md source status and problems. */
  | 'backlog.read'
  /** M6: change what new tasks of a project start with (default done items). Owners and admins. */
  | 'project.defaults';

export function isAdmin(actor: Actor): boolean {
  return actor.role === 'owner' || actor.role === 'admin';
}

function keyCoversProject(actor: Actor, projectId: string): boolean {
  if (!actor.scope) return true;
  return actor.scope.projects === 'all' || actor.scope.projects.includes(projectId);
}

function keyCanWrite(actor: Actor): boolean {
  return !actor.scope || actor.scope.access === 'write';
}

/** Workspace-wide writes through a key need write access to all projects. */
function keyCoversWorkspaceWrites(actor: Actor): boolean {
  return !actor.scope || (actor.scope.access === 'write' && actor.scope.projects === 'all');
}

/** Settings actions (members, agents, keys) are for people, and keys must be workspace-wide writers. */
function canManageSettings(actor: Actor): boolean {
  return actor.kind === 'person' && keyCoversWorkspaceWrites(actor);
}

/** True when the actor signed in with a session rather than an API key. */
export function isSession(actor: Actor): boolean {
  return !actor.apiKeyId && !actor.scope;
}

function projectIdOf(resource: Resource | undefined): string | null {
  return resource?.type === 'project' ? resource.projectId : null;
}

/** Whether `actor` may perform `action` on `resource`. Membership of the workspace is a given. */
export function can(actor: Actor, action: Action, resource?: Resource): boolean {
  switch (action) {
    case 'workspace.read':
      return true;
    case 'profile.update':
      return actor.kind === 'person' && isSession(actor);
    case 'project.create':
      return keyCoversWorkspaceWrites(actor);
    case 'project.read': {
      const projectId = projectIdOf(resource);
      return projectId !== null && keyCoversProject(actor, projectId);
    }
    case 'project.update':
    case 'task.write': {
      const projectId = projectIdOf(resource);
      return projectId !== null && keyCoversProject(actor, projectId) && keyCanWrite(actor);
    }
    case 'project.delete': {
      const projectId = projectIdOf(resource);
      return (
        projectId !== null && isAdmin(actor) && canManageSettings(actor) && keyCoversProject(actor, projectId)
      );
    }
    case 'member.manage':
      return isAdmin(actor) && canManageSettings(actor);
    case 'apiKey.listWorkspace':
      return isAdmin(actor) && actor.kind === 'person';
    case 'apiKey.list': {
      if (resource?.type !== 'apiKeyOwner') return false;
      if (resource.owner.id === actor.userId) return true;
      return actor.kind === 'person' && (isAdmin(actor) || resource.owner.responsibleUserId === actor.userId);
    }
    case 'apiKey.create':
    case 'apiKey.revoke': {
      if (resource?.type !== 'apiKeyOwner' || !canManageSettings(actor)) return false;
      const { owner } = resource;
      if (owner.id === actor.userId) return true;
      if (owner.kind === 'agent') return isAdmin(actor) || owner.responsibleUserId === actor.userId;
      // Admins may revoke anyone's key in the workspace (key hygiene); they never create keys for people.
      return action === 'apiKey.revoke' && isAdmin(actor);
    }
    case 'connection.manage':
      return isAdmin(actor) && canManageSettings(actor);
    case 'backlog.manage': {
      const projectId = projectIdOf(resource);
      return (
        projectId !== null && isAdmin(actor) && canManageSettings(actor) && keyCoversProject(actor, projectId)
      );
    }
    case 'backlog.refresh': {
      const projectId = projectIdOf(resource);
      if (projectId === null || !keyCoversProject(actor, projectId) || !keyCanWrite(actor)) return false;
      return isAdmin(actor) || actor.kind === 'agent';
    }
    case 'backlog.read': {
      const projectId = projectIdOf(resource);
      return projectId !== null && keyCoversProject(actor, projectId);
    }
    case 'project.defaults': {
      const projectId = projectIdOf(resource);
      return (
        projectId !== null && isAdmin(actor) && canManageSettings(actor) && keyCoversProject(actor, projectId)
      );
    }
  }
}

const MESSAGES: Record<Action, string> = {
  'workspace.read': 'You cannot read this workspace',
  'profile.update': 'Preferences can be changed only by people signed in to the web app, not with an API key',
  'project.create': 'Creating projects needs a key with write access to all projects',
  'project.read': 'Your API key does not cover this project',
  'project.update': 'You cannot change this project with this API key',
  'project.delete': 'Only owners and admins can delete a project.',
  'task.write': 'You cannot change tasks in this project with this API key',
  'member.manage': 'Only workspace admins can manage members, invitations and agents',
  'apiKey.listWorkspace': 'Only workspace admins can see every API key',
  'apiKey.list': 'You can see only your own keys and keys of agents you are responsible for',
  'apiKey.create': 'You can create keys only for yourself or for agents you are responsible for',
  'apiKey.revoke': 'You can revoke only your own keys or keys of agents you are responsible for',
  'connection.manage': 'Only workspace admins can add, change or delete git connections',
  'backlog.manage': 'Only workspace admins can set up, change or detach Backlog.md',
  'backlog.refresh': 'Only workspace admins and agents with write access can refresh Backlog.md',
  'backlog.read': 'Your API key does not cover this project',
  'project.defaults': 'Only owners and admins can change the task defaults of a project',
};

/** Throws Forbidden unless `actor` may perform `action` on `resource`. */
export function authorize(actor: Actor, action: Action, resource?: Resource): void {
  if (can(actor, action, resource)) return;
  let message = MESSAGES[action];
  if (actor.kind === 'agent' && (action === 'member.manage' || action.startsWith('apiKey.'))) {
    message = 'Agents cannot manage members, agents or API keys';
  } else if (
    actor.scope?.access === 'read' &&
    action !== 'project.read' &&
    action !== 'backlog.read' &&
    action !== 'profile.update'
  ) {
    message = 'This API key is read-only';
  }
  throw new Forbidden(message);
}
