// The oRPC implementer of the /api/v1 contract and the middleware every procedure runs:
// error mapping first, then the actor. Both run before input validation, so a request without
// credentials gets 401 even when its input is also wrong. M6: the actor carries the machine and
// branch the CLI sent (requestSource), which core writes on activity rows and comments.
import { implement } from '@orpc/server';
import { getActorFromRequest } from '@zamu/auth';
import { contract } from '@zamu/contracts';
import type { Actor, CoreContext } from '@zamu/core';
import { requestSource } from '../context';
import { toApiError } from './errors';

/** What each call starts with. HTTP handlers and the server-side client build it per request. */
export interface ApiContext {
  /** Database, Better Auth and links, shared by the process. */
  core: CoreContext;
  /** Request headers: the session cookie or `Authorization: Bearer zamu_live_...`. */
  headers: Headers;
  /** Echoed in error bodies and the x-request-id header. */
  requestId?: string;
}

/** Context after the auth middleware. */
export interface AuthedContext extends ApiContext {
  actor: Actor;
}

const os = implement(contract).$context<ApiContext>();

const problems = os.middleware(async ({ context, next }) => {
  try {
    return await next();
  } catch (error) {
    throw toApiError(error, context.requestId);
  }
});

const authenticated = os.middleware(async ({ context, next, errors }) => {
  const actor = await getActorFromRequest(context.core, { headers: context.headers });
  if (!actor) {
    throw errors.UNAUTHORIZED({
      message: 'Sign in, or send an API key as Authorization: Bearer zamu_live_...',
      data: {},
    });
  }
  const source = requestSource(context.headers);
  return next({ context: { actor: source ? { ...actor, source } : actor } });
});

/** Implementer for procedures that need a signed-in user or a valid API key (all of /api/v1). */
export const api = os.use(problems).use(authenticated);
