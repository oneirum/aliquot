# The Aliquot app image: the worker, the web door, the kb command and a production studio build.
# compose.yaml builds it; nothing here holds a secret (they come from .env at run time).
FROM node:26-bookworm-slim@sha256:bc0a2afd3b74ce12222fc8bab99271e66257f021078f5f4a5d687a77d280c1d9 AS base
RUN npm install -g pnpm@10.20.0 && npm cache clean --force
WORKDIR /app
COPY package.json pnpm-lock.yaml pnpm-workspace.yaml ./
COPY packages/core/package.json packages/core/
COPY packages/studio/package.json packages/studio/

FROM base AS build
RUN pnpm install --frozen-lockfile
COPY . .
# next build reads payload.config.ts, which wants both values; neither is used for anything at build time.
RUN cd packages/studio && NODE_ENV=production PAYLOAD_SECRET=build-only DATABASE_URL=postgres://build-only@localhost/none pnpm exec next build

FROM base
ENV NODE_ENV=production
RUN pnpm install --frozen-lockfile --prod && pnpm store prune
COPY . .
COPY --from=build /app/packages/studio/.next packages/studio/.next
COPY deploy/bin/ /usr/local/bin/
RUN chown -R node:node packages/studio/.next
USER node
