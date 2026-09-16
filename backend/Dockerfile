# Eclat / CaratSense backend — NestJS + Prisma (production image).
# Multi-stage: (1) install + build + prisma generate, (2) slim runtime that runs
# `prisma migrate deploy` then boots the compiled app on $PORT (Railway injects PORT).
#
# Debian-slim runtime (not Alpine) so Prisma's default glibc engine binaries work
# without adding binaryTargets to schema.prisma. Node 22 matches @types/node ^22.

# ---------- Stage 1: build ----------
FROM node:22-slim AS build
WORKDIR /app

# OpenSSL is required by Prisma engine detection at generate/runtime.
RUN apt-get update -y && apt-get install -y --no-install-recommends openssl \
    && rm -rf /var/lib/apt/lists/*

# Install deps first (better layer caching). Need devDeps to compile (nest build).
COPY package.json package-lock.json ./
RUN npm ci

# Prisma client must be generated against the schema before TS build.
COPY prisma ./prisma
RUN npx prisma generate

# Build the Nest app -> dist/
COPY tsconfig.json nest-cli.json ./
COPY src ./src
RUN npm run build

# NOTE: dev deps are intentionally kept — the runtime start command runs
# `prisma migrate deploy` + the idempotent seed (prisma CLI is a devDependency).

# ---------- Stage 2: runtime ----------
FROM node:22-slim AS runtime
WORKDIR /app
ENV NODE_ENV=production
# Disable Prisma's update "checkpoint" network call — it hangs boot on egress-restricted hosts.
ENV CHECKPOINT_DISABLE=1
ENV PRISMA_HIDE_UPDATE_MESSAGE=1

RUN apt-get update -y && apt-get install -y --no-install-recommends openssl \
    && rm -rf /var/lib/apt/lists/*

# Copy only what production needs.
COPY package.json ./
COPY --from=build /app/node_modules ./node_modules
COPY --from=build /app/dist ./dist
COPY --from=build /app/prisma ./prisma
# The demo-thread seeder, so a staging environment can be filled with the same
# five WhatsApp threads a laptop has. It refuses any database that does not
# prove it is staging, so shipping it costs nothing and running it needs an
# explicit SEED_DEMO_TARGET=staging.
COPY scripts/seed-conversations.mjs ./scripts/seed-conversations.mjs

# NOTE: intentionally NOT dropping to the unprivileged 'node' user. The Railway
# persistent volume mounted at /app/uploads is root-owned at mount time, and a
# non-root process gets EACCES on every upload write (verified live). Running as
# root inside Railway's isolated container is the platform-standard pattern here.

# Railway provides $PORT; the app falls back to 4000 (see src/main.ts).
EXPOSE 4000

# Apply pending migrations, then start the compiled server.
# `migrate deploy` is safe/idempotent: it only runs un-applied migrations.
# Call the Prisma CLI directly (NOT via npx — npx hangs at boot on egress-restricted
# hosts). migrate deploy is idempotent: only un-applied migrations run.
# Migrations are applied out-of-band (Railway pre-deploy / one-off), not on every
# boot — the prisma CLI's direct-node invocation doesn't always exit, which would
# block `&& node` and hang startup. Boot just serves.
CMD ["sh", "-c", "node dist/main.js"]
