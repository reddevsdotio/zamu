# syntax=docker/dockerfile:1
#
# One image, three roles picked by the command (see docker/entrypoint.sh):
#   web (default)  TanStack Start server on $PORT (3000)
#   worker         pg-boss worker
#   migrate        applies database migrations, then exits
# `zamu` runs the bundled CLI, any other command is executed as is.

ARG NODE_IMAGE=node:24-slim

# ---------------------------------------------------------------------------------------------------------
FROM ${NODE_IMAGE} AS base
ENV CI=true \
    PNPM_STORE_DIR=/pnpm/store
WORKDIR /repo
# Install the pnpm version pinned in package.json ("packageManager": "pnpm@x.y.z").
COPY package.json ./
RUN npm install --global --no-fund --no-audit --allow-scripts=pnpm \
      "pnpm@$(node -p "require('./package.json').packageManager.split('@')[1]")"

# ---------------------------------------------------------------------------------------------------------
FROM base AS build
# Fill the pnpm store from the lockfile alone, so the install below stays offline and fast after source changes.
COPY pnpm-lock.yaml pnpm-workspace.yaml ./
RUN --mount=type=cache,id=pnpm-store,target=/pnpm/store \
    pnpm fetch --store-dir /pnpm/store

COPY . .
RUN --mount=type=cache,id=pnpm-store,target=/pnpm/store \
    pnpm install --frozen-lockfile --offline --store-dir /pnpm/store

# The version `zamu --version` prints inside the image; empty outside a release build.
ARG ZAMU_CLI_VERSION=
RUN pnpm --filter web build && ZAMU_CLI_VERSION=${ZAMU_CLI_VERSION} pnpm --filter @zamu/cli build

# Self-contained production trees. The web server is bundled by Nitro into apps/web/.output.
# The worker (and the migrate role, which reuses its dependencies) runs TypeScript through tsx.
RUN --mount=type=cache,id=pnpm-store,target=/pnpm/store \
    pnpm --filter worker deploy --prod --store-dir /pnpm/store /out/worker \
 && pnpm --filter @zamu/cli deploy --prod --store-dir /pnpm/store /out/cli

# ---------------------------------------------------------------------------------------------------------
FROM ${NODE_IMAGE} AS runtime
ENV NODE_ENV=production \
    PORT=3000
WORKDIR /app

COPY --from=build /repo/apps/web/.output /app/web
COPY --from=build /out/worker /app/worker
COPY --from=build /out/cli /app/cli
COPY docker/migrate.ts /app/worker/migrate.ts
COPY docker/entrypoint.sh /usr/local/bin/zamu-entrypoint
COPY docker/healthcheck.mjs /app/healthcheck.mjs
RUN chmod 0755 /usr/local/bin/zamu-entrypoint \
 && ln -s /app/cli/dist/index.js /usr/local/bin/zamu \
 && chmod 0755 /app/cli/dist/index.js

# The node user of the base image, by number so Kubernetes runAsNonRoot can verify it is not root.
# Runtime writes go to /tmp (role marker) and $HOME=/home/node (zamu CLI config), both writable by it.
USER 1000:1000
EXPOSE 3000

# Probes /api/healthz for the web role; worker and migrate report healthy while their process runs.
HEALTHCHECK --interval=10s --timeout=5s --start-period=20s --retries=3 \
    CMD ["node", "/app/healthcheck.mjs"]

ENTRYPOINT ["zamu-entrypoint"]
CMD ["web"]
