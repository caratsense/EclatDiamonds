import axios from "axios";

/**
 * Shared axios instance for the NestJS backend.
 * Base URL from NEXT_PUBLIC_API_URL (default http://localhost:4000).
 * The frontend NEVER reaches the DB directly — always via this API.
 *
 * The request interceptor attaches the JWT (Authorization: Bearer) and the
 * active store (X-Store-Id) so every request is correctly store-scoped
 * server-side. On a 401 we clear the token and bounce to /login.
 */
export const api = axios.create({
  baseURL: process.env.NEXT_PUBLIC_API_URL ?? "http://localhost:4000",
  headers: { "Content-Type": "application/json" },
  timeout: 15000,
});

const TOKEN_KEY = "eclat.token";
const STORE_KEY = "eclat.storeId";

/** Persist / read the JWT (localStorage is the single source of truth). */
export function getStoredToken(): string | null {
  if (typeof window === "undefined") return null;
  return window.localStorage.getItem(TOKEN_KEY);
}

export function setStoredToken(token: string | null) {
  if (typeof window === "undefined") return;
  if (token) window.localStorage.setItem(TOKEN_KEY, token);
  else window.localStorage.removeItem(TOKEN_KEY);
}

/**
 * Is there a stored token that has not expired?
 *
 * Distinct from `getStoredToken()`, which only says whether a string is present.
 * A leftover token from a previous session stays in localStorage until something
 * clears it, so "a token exists" is not the same as "the user is signed in" —
 * treating them as equivalent is what made the login page unreachable.
 *
 * Only the `exp` claim is read, and only to decide what to show; the server
 * re-verifies the signature on every request, so nothing here is a trust
 * decision. Anything unparseable counts as invalid.
 */
export function hasValidSession(): boolean {
  const token = getStoredToken();
  if (!token) return false;
  try {
    const payload = token.split(".")[1];
    if (!payload) return false;
    const json = JSON.parse(
      atob(payload.replace(/-/g, "+").replace(/_/g, "/")),
    ) as { exp?: number };
    if (typeof json.exp !== "number") return false;
    return json.exp * 1000 > Date.now();
  } catch {
    return false;
  }
}

/** Persist / read the active store id used for the X-Store-Id header. */
export function getStoredStoreId(): string | null {
  if (typeof window === "undefined") return null;
  return window.localStorage.getItem(STORE_KEY);
}

export function setStoredStoreId(storeId: string | null) {
  if (typeof window === "undefined") return;
  if (storeId) window.localStorage.setItem(STORE_KEY, storeId);
  else window.localStorage.removeItem(STORE_KEY);
}

/**
 * Resolve a backend asset path to a loadable URL. Relative paths (e.g.
 * "/uploads/products/x.jpg") are prefixed with the API base; absolute CDN URLs
 * (R2 / Cloudinary) are returned as-is.
 */
export function assetUrl(path?: string | null): string | undefined {
  if (!path) return undefined;
  if (/^https?:\/\//.test(path)) return path;
  const base = process.env.NEXT_PUBLIC_API_URL ?? "http://localhost:4000";
  return `${base}${path.startsWith("/") ? "" : "/"}${path}`;
}

// Inject auth token + active-store header on every request.
api.interceptors.request.use((config) => {
  const token = getStoredToken();
  if (token) config.headers.Authorization = `Bearer ${token}`;
  const storeId = getStoredStoreId();
  if (storeId) config.headers["X-Store-Id"] = storeId;
  return config;
});

// On 401, clear the token and redirect to the login page.
api.interceptors.response.use(
  (res) => res,
  (error) => {
    if (error?.response?.status === 401 && typeof window !== "undefined") {
      setStoredToken(null);
      if (!window.location.pathname.startsWith("/login")) {
        window.location.href = "/login";
      }
    }
    return Promise.reject(error);
  },
);
