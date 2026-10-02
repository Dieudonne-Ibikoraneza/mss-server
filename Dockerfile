# syntax=docker/dockerfile:1
FROM node:22-bookworm-slim AS base
WORKDIR /app
RUN apt-get update \
    && apt-get install -y --no-install-recommends ca-certificates openssl \
    && rm -rf /var/lib/apt/lists/*

FROM base AS dependencies
COPY package.json package-lock.json ./
COPY prisma ./prisma
RUN npm ci

FROM dependencies AS build
COPY . .
RUN npm run prisma:generate && npm run build

FROM dependencies AS production-dependencies
RUN npm prune --omit=dev && npm cache clean --force

# Explicitly invoked migration job; never changes the database on API startup.
FROM build AS migrations
COPY --chmod=755 docker-entrypoint.sh /usr/local/bin/magnificat-entrypoint
USER node
ENTRYPOINT ["/usr/local/bin/magnificat-entrypoint"]
CMD ["./node_modules/.bin/prisma", "migrate", "deploy"]

FROM base AS runtime
ENV NODE_ENV=production
COPY --from=production-dependencies --chown=node:node /app/node_modules ./node_modules
COPY --from=build --chown=node:node /app/node_modules/.prisma ./node_modules/.prisma
COPY --from=build --chown=node:node /app/dist ./dist
COPY --chown=node:node package.json package-lock.json ./
RUN mkdir -p /app/uploads && chown node:node /app/uploads
COPY --chmod=755 docker-entrypoint.sh /usr/local/bin/magnificat-entrypoint
USER node
EXPOSE 4000
ENTRYPOINT ["/usr/local/bin/magnificat-entrypoint"]
CMD ["node", "dist/main.js"]
