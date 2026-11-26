// A second web container on the main stack's database, started with WORKSPACE_CREATION=owners, for the
// workspaces spec: the same people and workspaces, but only people who own a workspace may create one. The
// compose file does not pass that variable, so the container is started with `docker run` on the stack's
// network, from the same image. workspaces.spec.ts starts and removes it; globalSetup and globalTeardown
// remove one left behind by a run that stopped halfway (the stack's network can't go while it is attached).
import { spawnSync } from 'node:child_process';
import { baseURL, betterAuthSecret, composeProject, encryptionKey, image, mainStack } from './stack';

/** Host port of the container. */
export const ownersPort = process.env.E2E_OWNERS_PORT ?? '3102';

/** Same host as the main stack, another port. */
export const ownersURL = (() => {
  const url = new URL(baseURL);
  url.port = ownersPort;
  return url.origin;
})();

export const ownersContainer = `${composeProject}-owners-web`;

function docker(args: string[]): { status: number | null; output: string } {
  const result = spawnSync('docker', args, { encoding: 'utf8' });
  return { status: result.status, output: `${result.stdout ?? ''}${result.stderr ?? ''}` };
}

/** Removes the container if it exists. */
export function removeOwnersWeb(): void {
  docker(['rm', '-f', ownersContainer]);
}

/** Starts the container and waits until /api/healthz answers 200. */
export async function startOwnersWeb(timeoutMs = 90_000): Promise<void> {
  removeOwnersWeb();
  const started = docker([
    'run',
    '-d',
    '--name',
    ownersContainer,
    '--network',
    mainStack.network,
    '-p',
    `${ownersPort}:3000`,
    '-e',
    'DATABASE_URL=postgres://postgres:postgres@db:5432/zamu',
    '-e',
    `BETTER_AUTH_SECRET=${betterAuthSecret}`,
    '-e',
    `BETTER_AUTH_URL=${ownersURL}`,
    '-e',
    `PUBLIC_URL=${ownersURL}`,
    '-e',
    `APP_ENCRYPTION_KEY=${encryptionKey}`,
    '-e',
    'PORT=3000',
    '-e',
    'WORKSPACE_CREATION=owners',
    image,
    'web',
  ]);
  if (started.status !== 0) throw new Error(`docker run ${ownersContainer} failed: ${started.output}`);

  const deadline = Date.now() + timeoutMs;
  let last = '';
  while (Date.now() < deadline) {
    try {
      const response = await fetch(`${ownersURL}/api/healthz`, { signal: AbortSignal.timeout(5_000) });
      if (response.ok) return;
      last = `HTTP ${response.status}`;
    } catch (error) {
      last = error instanceof Error ? error.message : String(error);
    }
    await new Promise((resolve) => setTimeout(resolve, 1_000));
  }
  const logs = docker(['logs', '--tail', '50', ownersContainer]).output;
  throw new Error(
    `${ownersURL}/api/healthz did not answer 200 within ${timeoutMs / 1000} s (last: ${last})\n${logs}`,
  );
}
