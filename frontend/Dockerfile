# Eclat / CaratSense frontend — Next.js 16 (OPTIONAL: only needed if hosting the
# frontend on Railway instead of Vercel. Vercel does not use this file.)
# Relies on `output: "standalone"` in next.config.ts.
#
# NEXT_PUBLIC_API_URL is baked in at BUILD time, so it must be passed as a build arg.

# ---------- Stage 1: build ----------
FROM node:22-slim AS build
WORKDIR /app

COPY package.json package-lock.json ./
RUN npm ci

COPY . .

# Public API URL is inlined into the client bundle at build time.
ARG NEXT_PUBLIC_API_URL
ENV NEXT_PUBLIC_API_URL=$NEXT_PUBLIC_API_URL
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
