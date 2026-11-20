"use client";

import { useEffect } from "react";

/**
 * Registers the PWA service worker (public/sw.js) so the app shell works
 * offline on phones and in-store terminals.
 *
 * - Production only: the SW would otherwise cache dev/HMR assets and interfere
 *   with fast refresh.
 * - SSR-safe: everything runs inside useEffect on the client and is guarded
 *   with `typeof navigator` + a `serviceWorker` feature check.
 * - Registration failures are swallowed — they must never break the app.
 */
export function ServiceWorkerRegister() {
  useEffect(() => {
    if (process.env.NODE_ENV !== "production") return;
    if (typeof navigator === "undefined" || !("serviceWorker" in navigator)) {
      return;
    }

    const register = () => {
      navigator.serviceWorker.register("/sw.js").catch(() => {
        /* non-fatal: offline support simply won't be available */
      });
    };

    // Register after load so the SW never competes with first paint.
    if (document.readyState === "complete") {
      register();
    } else {
      window.addEventListener("load", register);
      return () => window.removeEventListener("load", register);
    }
  }, []);

  return null;
}
