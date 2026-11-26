// Server-side half of the settings server functions: resolve the actor from the request, call one
// core service, and turn core's errors into a SettingsResult. No business rules live here.
// Server-only (imports @zamu/auth and @zamu/core); import it only from server function handlers and tests.
// 0.10: the request's workspace comes from its x-zamu-workspace header (else the one used last), and a
// signed-in person outside it gets NOT_A_MEMBER rather than UNAUTHORIZED, so the screen can send them
// to a workspace of theirs instead of the sign-in page.
import { type ActorResult, resolveActor } from '@zamu/auth';
import { type Actor, type CoreContext, isCoreError, problemCodeOf } from '@zamu/core';
import { failure, type SettingsResult } from './result';

const SIGN_IN_AGAIN = 'Sign in again to continue.';

/**
 * Calls `service` as the actor and wraps the outcome. Takes an actor, null (not signed in), or the
 * result of resolveActor, whose failures keep their code. Errors that are not core's propagate (500).
 */
export async function runAs<T>(
  core: CoreContext,
  actor: Actor | ActorResult | null,
  service: (core: CoreContext, actor: Actor) => Promise<T>,
): Promise<SettingsResult<T>> {
  if (!actor) return failure('UNAUTHORIZED', SIGN_IN_AGAIN);
  if ('ok' in actor && !actor.ok) {
    return failure(actor.code, actor.code === 'UNAUTHORIZED' ? SIGN_IN_AGAIN : actor.message);
  }
  const resolved = 'ok' in actor ? actor.actor : actor;
  try {
    return { ok: true, data: await service(core, resolved) };
  } catch (error) {
    if (isCoreError(error)) {
      // problemCodeOf: the specific code (LABEL_EXISTS, SLUG_TAKEN, ...) over the class's generic one.
      return failure(problemCodeOf(error), error.message, error.issues);
    }
    // The browser only sees a generic failure, so the server log is the one place the cause shows.
    console.error('settings: unhandled error:', error);
    throw error;
  }
}

/**
 * Resolves the actor from the request headers (session cookie or API key, and x-zamu-workspace), then
 * calls `service`.
 */
export async function runForRequest<T>(
  core: CoreContext,
  headers: Headers,
  service: (core: CoreContext, actor: Actor) => Promise<T>,
): Promise<SettingsResult<T>> {
  return runAs(core, await resolveActor(core, { headers }), service);
}
