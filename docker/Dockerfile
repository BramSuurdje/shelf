FROM oven/bun:1.3.13 AS deps
WORKDIR /app
COPY package.json bun.lock turbo.json tsconfig*.json ./
COPY apps ./apps
COPY packages ./packages
RUN bun install --frozen-lockfile

FROM deps AS web-build
RUN bun --filter web build

FROM oven/bun:1.3.13 AS api
WORKDIR /app
ENV NODE_ENV=production
COPY --from=deps /app/node_modules ./node_modules
COPY --from=deps /app/package.json ./package.json
COPY --from=deps /app/apps/api ./apps/api
COPY --from=deps /app/packages ./packages
CMD ["bun", "apps/api/src/index.ts"]

FROM oven/bun:1.3.13 AS worker
WORKDIR /app
ENV NODE_ENV=production
COPY --from=deps /app/node_modules ./node_modules
COPY --from=deps /app/package.json ./package.json
COPY --from=deps /app/apps/worker ./apps/worker
COPY --from=deps /app/packages ./packages
CMD ["bun", "apps/worker/src/index.ts"]

FROM oven/bun:1.3.13 AS web
WORKDIR /app
COPY --from=web-build /app/apps/web/dist ./dist
COPY apps/web/server.ts ./server.ts
CMD ["bun", "server.ts"]
