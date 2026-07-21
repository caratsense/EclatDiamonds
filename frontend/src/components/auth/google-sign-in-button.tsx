"use client";

import { useEffect, useRef } from "react";

const CLIENT_ID = process.env.NEXT_PUBLIC_GOOGLE_CLIENT_ID;
const GSI_SRC = "https://accounts.google.com/gsi/client";

declare global {
  // eslint-disable-next-line no-var
  var google: any;
}

let sessionNonce: string | null = null;

/**
 * One nonce per page load, not per mount. google.accounts.id is a global
 * singleton and hands back cached credentials, so a nonce tied to the component
 * lifecycle desyncs from the token GIS actually signed (remounts, Fast Refresh)
 * and the backend rejects it.
 */
function getNonce(): string {
  if (!sessionNonce) {
    sessionNonce =
      typeof crypto !== "undefined" && crypto.randomUUID
        ? crypto.randomUUID()
        : Math.random().toString(36).slice(2) + Date.now().toString(36);
  }
  return sessionNonce;
}

/**
 * Google Sign-In button via Google Identity Services. Renders only when
 * NEXT_PUBLIC_GOOGLE_CLIENT_ID is configured (otherwise returns null, so the
 * login page is unchanged until Google is set up). On success it hands the
 * Google ID-token credential back to the parent to exchange for a session.
 *
 * The nonce is passed to GIS and comes back inside the signed token, so the
 * backend can reject a replayed credential.
 */
export function GoogleSignInButton({
  onCredential,
}: {
  onCredential: (credential: string, nonce: string) => void;
}) {
  const ref = useRef<HTMLDivElement>(null);
  const nonce = getNonce();

  useEffect(() => {
    if (!CLIENT_ID || !ref.current) return;

    function init() {
      const g = (window as any).google;
      if (!g?.accounts?.id || !ref.current) return;
      g.accounts.id.initialize({
        client_id: CLIENT_ID,
        nonce,
        callback: (resp: { credential?: string }) => {
          if (resp?.credential) onCredential(resp.credential, nonce);
        },
      });
      g.accounts.id.renderButton(ref.current, {
        theme: "outline",
        size: "large",
        width: 320,
        text: "signin_with",
        shape: "rectangular",
      });
    }

    if ((window as any).google?.accounts?.id) {
      init();
      return;
    }
    let script = document.querySelector<HTMLScriptElement>(`script[src="${GSI_SRC}"]`);
    if (!script) {
      script = document.createElement("script");
      script.src = GSI_SRC;
      script.async = true;
      script.defer = true;
      document.head.appendChild(script);
    }
    script.addEventListener("load", init);
    return () => script?.removeEventListener("load", init);
  }, [onCredential, nonce]);

  if (!CLIENT_ID) return null;
  return <div ref={ref} className="flex justify-center" />;
}
