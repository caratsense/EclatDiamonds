# Eclat / CaratSense frontend — Next.js 16 (OPTIONAL: only needed if hosting the
# frontend on Railway instead of Vercel. Vercel does not use this file.)
# Relies on `output: "standalone"` in next.config.ts.
#
# Both API targets are baked in at BUILD time, so both must be passed as build args:
#   NEXT_PUBLIC_API_URL — inlined into the client bundle.
#   BACKEND_ORIGIN      — next.config.ts resolves the /_api rewrite during `next
#                         build` and freezes it into routes-manifest.json, so the
#                         runtime environment cannot change it afterwards.

# ---------- Stage 1: build ----------
FROM node:22-slim AS build
WORKDIR /app

COPY package.json package-lock.json ./
RUN npm ci

COPY . .

# Public API URL is inlined into the client bundle at build time.
ARG NEXT_PUBLIC_API_URL
ENV NEXT_PUBLIC_API_URL=$NEXT_PUBLIC_API_URL

# Server-side rewrite target for /_api. next.config.ts reads it during
# `next build` and freezes the result into routes-manifest.json, so this has to
# be stated at build time; setting it in the runtime stage below does nothing.
#
# No default, and the build refuses to proceed without it. The refusal is the
# point. An unset `ARG` still expands to the EMPTY STRING, and next.config.ts
# reads `process.env.BACKEND_ORIGIN ?? "<production>"` — `??` does not fire on
# "", so an image built without this arg would neither inherit the production
# origin nor say so: it would rewrite /_api to itself and 404 every API call at
# runtime, a long way from the mistake. Fail here instead, where the message can
# name the fix.
#
#   --build-arg BACKEND_ORIGIN=http://localhost:4100        (local/test, --network host)
#   --build-arg BACKEND_ORIGIN=https://<the real API origin> (production)
#
# Note for local images: scripts/assert-local-api.mjs accepts only localhost,
# 127.0.0.1 and ::1 as loopback. `host.docker.internal` is NOT on that list, so
# an image built against it cannot be certified by the preflight.
ARG BACKEND_ORIGIN
ENV BACKEND_ORIGIN=$BACKEND_ORIGIN
RUN test -n "$BACKEND_ORIGIN" || { \
      echo "BACKEND_ORIGIN build arg is required."; \
      echo "  docker build --build-arg BACKEND_ORIGIN=<origin> ..."; \
      exit 1; \
    }
RUN npm run build

# ---------- Stage 2: runtime ----------
FROM node:22-slim AS runtime
WORKDIR /app
ENV NODE_ENV=production

# Standalone output bundles only the needed node_modules.
COPY --from=build /app/.next/standalone ./
COPY --from=build /app/.next/static ./.next/static
COPY --from=build /app/public ./public

USER node
EXPOSE 3000
ENV PORT=3000
CMD ["node", "server.js"]
