# syntax=docker/dockerfile:1.7

ARG NODE_VERSION=24.17.0-alpine3.23

FROM node:${NODE_VERSION} AS base
ENV PNPM_HOME=/pnpm
ENV PATH=${PNPM_HOME}:${PATH}
RUN corepack enable && corepack prepare pnpm@10.11.1 --activate
WORKDIR /workspace

FROM base AS manifests
COPY package.json pnpm-lock.yaml pnpm-workspace.yaml ./
COPY apps/server/package.json apps/server/package.json
COPY apps/web/package.json apps/web/package.json
COPY packages/contracts/package.json packages/contracts/package.json
COPY packages/database/package.json packages/database/package.json
COPY packages/mail/package.json packages/mail/package.json
COPY packages/storage/package.json packages/storage/package.json

FROM manifests AS build
RUN --mount=type=cache,id=pnpm,target=/pnpm/store \
    pnpm install --frozen-lockfile
COPY tsconfig.base.json ./
COPY apps/server/tsconfig.json apps/server/tsconfig.build.json apps/server/
COPY apps/server/src apps/server/src
COPY apps/web/index.html apps/web/tsconfig.json apps/web/vite.config.ts apps/web/
COPY apps/web/public apps/web/public
COPY apps/web/src apps/web/src
COPY packages/contracts/tsconfig.json packages/contracts/
COPY packages/contracts/src packages/contracts/src
COPY packages/database/tsconfig.json packages/database/
COPY packages/database/src packages/database/src
COPY packages/database/migrations packages/database/migrations
COPY packages/mail/tsconfig.json packages/mail/
COPY packages/mail/src packages/mail/src
COPY packages/storage/tsconfig.json packages/storage/
COPY packages/storage/src packages/storage/src
RUN pnpm --filter @open-excalidraw/web build
# esbuild is a dev dependency of the server package, so both bundles must be
# produced through that package rather than with a workspace-root pnpm exec.
RUN pnpm --filter @open-excalidraw/server run bundle
RUN pnpm --filter @open-excalidraw/server exec esbuild \
    ../../packages/database/src/migrate-cli.ts \
    --bundle \
    --platform=node \
    --format=esm \
    --target=node22 \
    --packages=external \
    --outfile=/output/packages/database/src/migrate.mjs

FROM manifests AS production-dependencies
RUN --mount=type=cache,id=pnpm,target=/pnpm/store \
    pnpm install --frozen-lockfile --prod \
      --filter @open-excalidraw/server...

FROM node:${NODE_VERSION} AS runtime
ENV NODE_ENV=production
ENV APP_PORT=3000
ENV STORAGE_LOCAL_PATH=/data/assets
WORKDIR /app/apps/server
RUN addgroup -S -g 10001 open-excalidraw \
    && adduser -S -D -H -u 10001 -G open-excalidraw open-excalidraw \
    && mkdir -p /data/assets \
    && chown -R 10001:10001 /data/assets
COPY --from=production-dependencies --chown=10001:10001 /workspace/node_modules /app/node_modules
COPY --from=production-dependencies --chown=10001:10001 /workspace/apps/server/node_modules ./node_modules
COPY --from=production-dependencies --chown=10001:10001 /workspace/packages/database/node_modules /app/packages/database/node_modules
COPY --from=build --chown=10001:10001 /workspace/apps/server/dist/server.mjs ./server.mjs
COPY --from=build --chown=10001:10001 /workspace/apps/web/dist ./public
COPY --from=build --chown=10001:10001 /output/packages/database/src/migrate.mjs /app/packages/database/src/migrate.mjs
COPY --from=build --chown=10001:10001 /workspace/packages/database/migrations /app/packages/database/migrations
COPY --chown=10001:10001 ops/migrate.sh /app/ops/migrate.sh
USER 10001:10001
EXPOSE 3000
ENTRYPOINT ["/app/ops/migrate.sh"]
CMD ["node", "server.mjs"]
