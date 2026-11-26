// After the suite: stop the stack and delete its volume, unless E2E_KEEP_STACK=1 (to inspect a failure).
import { forgejoNames, removeForgejo } from './forgejo';
import { removeOwnersWeb } from './owners-web';
import { compose, composeProject, downCommand, mainStack } from './stack';

export default async function globalTeardown(): Promise<void> {
  if (process.env.E2E_KEEP_STACK === '1') {
    console.log(`[e2e] leaving ${composeProject} running. Remove it with:`);
    console.log(`  ${downCommand(mainStack)}`);
    console.log(
      '  (the next pnpm e2e run also removes it, with the Forgejo containers of the Backlog.md specs)',
    );
    return;
  }
  // The Backlog.md specs remove their Forgejo themselves; this catches a run that stopped halfway.
  for (const name of forgejoNames) removeForgejo(name, mainStack.network);
  removeOwnersWeb();
  compose(['down', '-v', '--remove-orphans'], { quiet: true });
}
