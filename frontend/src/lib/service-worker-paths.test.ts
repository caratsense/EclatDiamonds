import { readFileSync } from "node:fs";
import { createContext, runInContext } from "node:vm";

import { describe, expect, it } from "vitest";

/**
 * WHICH REQUESTS THE SERVICE WORKER TAKES OVER.
 *
 * `public/sw.js` controls every request this app makes, and it decides what to
 * do by matching the start of a path. That is a rule with no types behind it
 * and no compiler watching it: on 28 Nov it was skipping `/auth` and `/api`
 * while the API is served at `/_api`, so every API response reached the
 * caching branches below. The JSON came to no harm — it falls through them —
 * but `assetUrl()` builds `/_api/uploads/….jpg` for catalogue photographs and
 * sale documents, those matched `isStaticAsset`, and API responses were being
 * written into the app-shell cache and served back stale.
 *
 * So these assertions run THE SHIPPED FILE, not a copy of its rules. The file
 * is read off disk, evaluated in a stub worker scope, and asked the only
 * question that matters about a path: did it call `respondWith` — i.e. does the
 * worker answer this request itself, or hand it to the network untouched? A
 * rule restated in the test could drift from the rule in the worker, which is
 * exactly the kind of divergence this is here to catch.
 */

/** The decision the worker made about one request. */
interface Decision {
  /** True when the worker took the request over (cache or its own fetch). */
  claimed: boolean;
}

type Listener = (event: { request: unknown; respondWith: (r: unknown) => void }) => void;

/**
 * Evaluate `public/sw.js` in a scope that records its fetch handler.
 *
 * Everything the worker reaches for is stubbed to resolve: the point is the
 * routing decision, so a branch that goes on to touch the cache must not throw
 * on the way and turn a decision into an error.
 */
function loadWorker(): (req: {
  url: string;
  method?: string;
  mode?: string;
  headers?: Record<string, string>;
}) => Decision {
  const source = readFileSync(new URL("../../public/sw.js", import.meta.url), "utf8");

  const listeners = new Map<string, Listener>();
  const response = { status: 200, clone: () => response };
  const cache = {
    match: () => Promise.resolve(undefined),
    put: () => Promise.resolve(),
    add: () => Promise.resolve(),
    keys: () => Promise.resolve([]),
  };
  const sandbox = {
    URL,
    Promise,
    self: {
      location: { origin: "https://nibhana.vercel.app" },
      addEventListener: (type: string, fn: Listener) => listeners.set(type, fn),
      skipWaiting: () => Promise.resolve(),
      clients: { claim: () => Promise.resolve() },
    },
    caches: {
      open: () => Promise.resolve(cache),
      keys: () => Promise.resolve([]),
      delete: () => Promise.resolve(true),
      match: () => Promise.resolve(undefined),
    },
    fetch: () => Promise.resolve(response),
  };
  runInContext(source, createContext(sandbox));

  const onFetch = listeners.get("fetch");
  if (!onFetch) throw new Error("public/sw.js registered no fetch handler");

  return (req) => {
    let claimed = false;
    const headers = req.headers ?? {};
    onFetch({
      request: {
        url: req.url,
        method: req.method ?? "GET",
        mode: req.mode ?? "cors",
        headers: { get: (name: string) => headers[name] ?? null },
      },
      respondWith: () => {
        claimed = true;
      },
    });
    return { claimed };
  };
}

const ORIGIN = "https://nibhana.vercel.app";
const handle = loadWorker();

describe("the service worker leaves the API alone", () => {
  it("passes every /_api call straight to the network", () => {
    /*
     * `/_api` and not `/api`: next.config.ts rewrites `/_api/:path*` to the
     * backend, and the underscore keeps it clear of the app's own routes. The
     * prefix this file tests is the one the app actually sends.
     */
    for (const path of [
      "/_api/crm/conversations",
      "/_api/crm/conversations/cmxyz123",
      "/_api/crm/conversations/queues",
      "/_api/notifications/summary",
      "/_api/health",
    ]) {
      expect(handle({ url: `${ORIGIN}${path}` })).toEqual({ claimed: false });
    }
  });

  it("does not cache an API response that merely looks like a file", () => {
    /*
     * The failure this test exists for. `assetUrl()` prefixes every backend
     * asset path with the API base, so a catalogue photograph is requested at
     * `/_api/uploads/…jpg` — same origin, GET, and an extension that
     * `isStaticAsset` matches. Measured on 28 Nov with the real worker:
     * `/_api/uploads/products/probe.jpg` was in `caratsense-v1` after one
     * request, stale-while-revalidate and all, which the header of sw.js says
     * never happens to the API.
     */
    for (const path of [
      "/_api/uploads/products/ring.jpg",
      "/_api/uploads/products/ring.png",
      "/_api/uploads/quotes/attachment.webp",
      "/_api/uploads/logos/brand.svg",
      "/_api/stock/dead/export.xlsx",
    ]) {
      expect(handle({ url: `${ORIGIN}${path}` })).toEqual({ claimed: false });
    }
  });

  it("still leaves sign-in and any /api route alone", () => {
    // Untouched behaviour, pinned so the new prefix cannot be added by
    // replacing the two that were already right.
    for (const path of ["/auth/login", "/auth/refresh", "/api/anything"]) {
      expect(handle({ url: `${ORIGIN}${path}` })).toEqual({ claimed: false });
    }
  });

  it("leaves another origin's requests alone, API or not", () => {
    // The backend can be addressed directly by setting NEXT_PUBLIC_API_URL to a
    // real origin, and R2/Cloudinary URLs are returned by assetUrl as-is.
    expect(handle({ url: "https://backend-production-89dd.up.railway.app/health" })).toEqual({
      claimed: false,
    });
    expect(handle({ url: "https://cdn.example.com/ring.jpg" })).toEqual({ claimed: false });
  });

  it("leaves a mutation alone even on a path it would otherwise cache", () => {
    expect(handle({ url: `${ORIGIN}/_api/crm/conversations/cmxyz/messages`, method: "POST" })).toEqual(
      { claimed: false },
    );
  });
});

describe("the service worker still serves the app shell", () => {
  it("takes over the build's own static assets", () => {
    // The reason the worker exists: a shop's terminal opens the app offline.
    for (const path of ["/_next/static/chunks/main-abc123.js", "/icon-192.png", "/eclat-logo.svg"]) {
      expect(handle({ url: `${ORIGIN}${path}` })).toEqual({ claimed: true });
    }
  });

  it("takes over a navigation, so a dropped connection still opens the app", () => {
    expect(handle({ url: `${ORIGIN}/conversations`, mode: "navigate" })).toEqual({ claimed: true });
  });

  it("leaves a React Server Component payload alone, so a page is never stale", () => {
    expect(handle({ url: `${ORIGIN}/conversations?_rsc=abc1`, mode: "navigate" })).toEqual({
      claimed: false,
    });
    expect(handle({ url: `${ORIGIN}/conversations`, headers: { RSC: "1" } })).toEqual({
      claimed: false,
    });
  });
});
