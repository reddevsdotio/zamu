// Nitro plugin: checks the configuration when the server starts and exits 1 with a clear message, before it
// listens, when it is invalid (missing or short BETTER_AUTH_SECRET, PASSWORD_LOGIN=disabled without SSO, a
// malformed OIDC_ISSUER, an unknown WORKSPACE_CREATION, an OIDC_WORKSPACE that names no workspace, ...),
// instead of failing on every request. In `vite dev` it only logs (see checkServerConfig). Registered in
// vite.config.ts (nitro `plugins`).
// The check runs while this module loads (top-level await): Nitro calls plugins without awaiting them, and
// the OIDC_WORKSPACE check reads the database, so awaiting here is what keeps the server from listening first.
import { definePlugin } from 'nitro';
import { checkServerConfigWithDatabase } from '../config';

await checkServerConfigWithDatabase({
  env: process.env,
  logger: console,
  exit: (code) => process.exit(code),
  // The production build inlines NODE_ENV as "production", so a built server always exits.
  nodeEnv: process.env.NODE_ENV,
});

export default definePlugin(() => {});
