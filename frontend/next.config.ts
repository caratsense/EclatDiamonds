import type { NextConfig } from "next";

/**
 * Where the API actually lives. Server-side only — it is deliberately never
 * shipped to the browser; see the rewrite below for why.
 */
const BACKEND_ORIGIN =
  process.env.BACKEND_ORIGIN ?? "https://backend-production-89dd.up.railway.app";

const nextConfig: NextConfig = {
  // 'standalone' emits a self-contained server in .next/standalone, enabling a small
  // Docker image if the frontend is hosted on Railway instead of Vercel. Vercel ignores
  // this (uses its own adapter) and local `next dev` / `next start` are unaffected.
  output: "standalone",

  /**
   * Serve the API from our own origin.
   *
   * On 2026-07-31 the app loaded and then failed to sign in on a client
   * network: "Couldn't sign in. Check your connection." The API was healthy —
   * `/health` and `/auth/login` both answered normally over the raw IP. The
   * failure was DNS. That network's resolver serves `vercel.app`,
   * `eclat-diamonds-pi.vercel.app` and even `railway.app`, but returns REFUSED
   * for `up.railway.app`, the shared zone Railway puts app subdomains on.
   * Public resolvers all answered correctly, so it is local filtering rather
   * than an outage — the kind that is common on Indian ISP and office networks
   * and that we do not control.
   *
   * Pointing a machine at 1.1.1.1 fixes that machine. It is not something we
   * can ship: if a shop's own connection filters the same zone, Eclat is simply
   * unreachable there, and it looks like our product is broken rather than
   * their DNS. The browser now only ever talks to the origin it already loaded
   * the page from — which, by definition, resolved.
   *
   * `/_api` rather than `/api`: the underscore keeps it clear of any route the
   * app might legitimately want, in the same spirit as `/_next`.
   *
   * Still worth keeping once the client's own `api.eclatdiamonds.in` exists —
   * one fewer hostname for a network to have an opinion about — but it can be
   * bypassed whenever we like by setting NEXT_PUBLIC_API_URL to a real origin.
   */
  async rewrites() {
    return [
      {
        source: "/_api/:path*",
        destination: `${BACKEND_ORIGIN}/:path*`,
      },
    ];
  },
};

export default nextConfig;
