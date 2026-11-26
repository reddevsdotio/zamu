// TanStack Start server functions for the settings screens. Members, invitations, agents and keys are
// not part of /api/v1 in M1, so the screens call @zamu/core through these thin adapters: validate the
// input with the contract schema, build the actor from the request and the page's workspace
// ({ workspace, input }, lib/server-fn.ts), call core, return the result.
// Handler bodies (and the server-only imports they use) are stripped from the client bundle.

import { createServerFn } from '@tanstack/react-start';
import {
  CancelInvitationInput,
  CreateAgentInput,
  CreateApiKeyInput,
  CreateInvitationInput,
  ListApiKeysInput,
  RemoveMemberInput,
  RevokeApiKeyInput,
} from '@zamu/contracts';
import {
  cancelInvitation,
  createAgent,
  createApiKey,
  createInvitation,
  listApiKeys,
  listInvitations,
  removeMember,
  revokeApiKey,
} from '@zamu/core';
import { inWorkspace, runInWorkspace as run } from '../../lib/server-fn';

export const listInvitationsFn = createServerFn({ method: 'GET' })
  .validator(inWorkspace())
  .handler(({ data }) => run(data.workspace, (core, actor) => listInvitations(core, actor)));

export const createInvitationFn = createServerFn({ method: 'POST' })
  .validator(inWorkspace(CreateInvitationInput))
  .handler(({ data }) => run(data.workspace, (core, actor) => createInvitation(core, actor, data.input)));

export const cancelInvitationFn = createServerFn({ method: 'POST' })
  .validator(inWorkspace(CancelInvitationInput))
  .handler(({ data }) => run(data.workspace, (core, actor) => cancelInvitation(core, actor, data.input)));

export const createAgentFn = createServerFn({ method: 'POST' })
  .validator(inWorkspace(CreateAgentInput))
  .handler(({ data }) => run(data.workspace, (core, actor) => createAgent(core, actor, data.input)));

export const removeMemberFn = createServerFn({ method: 'POST' })
  .validator(inWorkspace(RemoveMemberInput))
  .handler(({ data }) => run(data.workspace, (core, actor) => removeMember(core, actor, data.input)));

export const listApiKeysFn = createServerFn({ method: 'GET' })
  .validator(inWorkspace(ListApiKeysInput))
  .handler(({ data }) => run(data.workspace, (core, actor) => listApiKeys(core, actor, data.input)));

export const createApiKeyFn = createServerFn({ method: 'POST' })
  .validator(inWorkspace(CreateApiKeyInput))
  .handler(({ data }) => run(data.workspace, (core, actor) => createApiKey(core, actor, data.input)));

export const revokeApiKeyFn = createServerFn({ method: 'POST' })
  .validator(inWorkspace(RevokeApiKeyInput))
  .handler(({ data }) => run(data.workspace, (core, actor) => revokeApiKey(core, actor, data.input)));
