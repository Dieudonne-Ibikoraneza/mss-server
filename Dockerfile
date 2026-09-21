FROM node:22-alpine AS builder
WORKDIR /app
COPY package*.json ./
COPY prisma ./prisma
RUN npm ci
COPY . .
RUN npm run prisma:generate && npm run build

FROM node:22-alpine
WORKDIR /app
ENV NODE_ENV=production
COPY package*.json ./
COPY prisma ./prisma
RUN npm ci --omit=dev && npx prisma generate
COPY --from=builder /app/dist ./dist
EXPOSE 4000
# Applies any pending migrations first (a no-op when there are none) — the Postgres-backed
# fallback for Redis needs its table on hosts that run this image with no separate migrate step.
CMD ["sh", "-c", "npx prisma migrate deploy && node dist/main"]
