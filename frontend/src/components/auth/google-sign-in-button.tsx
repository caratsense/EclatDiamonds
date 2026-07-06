"use client";

import { useEffect, useRef } from "react";

const CLIENT_ID = process.env.NEXT_PUBLIC_GOOGLE_CLIENT_ID;
const GSI_SRC = "https://accounts.google.com/gsi/client";

declare global {
  // eslint-disable-next-line no-var
  var google: any;
}

/**
 * Google Sign-In button via Google Identity Services. Renders only when
 * NEXT_PUBLIC_GOOGLE_CLIENT_ID is configured (otherwise returns null, so the
 * login page is unchanged until Google is set up). On success it hands the
 * Google ID-token credential back to the parent to exchange for a session.
 */
export function GoogleSignInButton({
  onCredential,
}: {
  onCredential: (credential: string) => void;
}) {
  const ref = useRef<HTMLDivElement>(null);

  useEffect(() => {
    if (!CLIENT_ID || !ref.current) return;

    function init() {
      const g = (window as any).google;
      if (!g?.accounts?.id || !ref.current) return;
      g.accounts.id.initialize({
        client_id: CLIENT_ID,
        callback: (resp: { credential?: string }) => {
          if (resp?.credential) onCredential(resp.credential);
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
  }, [onCredential]);

  if (!CLIENT_ID) return null;
  return <div ref={ref} className="flex justify-center" />;
}
