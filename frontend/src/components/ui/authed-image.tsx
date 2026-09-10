"use client";

import { useEffect, useState } from "react";
import { ImageOff, Loader2 } from "lucide-react";

import { api } from "@/lib/api";

/**
 * An image the server will only hand over to someone it has checked.
 *
 * Attendance and counter photos are not served from a public URL any more: the
 * API returns a route on itself, and the bytes come back only after the caller
 * has been checked against the record. A plain `<img src>` cannot carry the
 * Authorization header the rest of the app sends, so the bytes are fetched with
 * the ordinary client and rendered from an object URL.
 *
 * Every object URL created here is revoked — a component that mounts a face
 * photo per row and never revokes leaks the whole page's worth of image data
 * for as long as the tab is open.
 *
 * A refusal is shown as a refusal. "You may not see this" and "this is still
 * loading" are different answers, and a manager reviewing a suspicious punch
 * needs to know which one they got.
 */
interface AuthedImageProps {
  /** An API path, e.g. `/hrms/attendance/<id>/photo/in`. */
  src: string;
  alt: string;
  className?: string;
}

/**
 * Keyed on `src`, so pointing this at a different photo remounts it.
 *
 * That is what keeps the effect below from having to write "loading" back into
 * state synchronously — the fresh mount already starts there. Without it, a card
 * switched from one punch to another would show the previous person's face
 * until the new fetch resolved.
 */
export function AuthedImage(props: AuthedImageProps) {
  return <AuthedImageFrame key={props.src} {...props} />;
}

function AuthedImageFrame({ src, alt, className }: AuthedImageProps) {
  const [objectUrl, setObjectUrl] = useState<string | null>(null);
  const [state, setState] = useState<"loading" | "ready" | "denied" | "missing" | "failed">(
    "loading",
  );

  useEffect(() => {
    let cancelled = false;
    let created: string | null = null;

    api
      .get<Blob>(src, { responseType: "blob" })
      .then((res) => {
        if (cancelled) return;
        created = URL.createObjectURL(res.data);
        setObjectUrl(created);
        setState("ready");
      })
      .catch((err: unknown) => {
        if (cancelled) return;
        const status = (err as { response?: { status?: number } })?.response?.status;
        setState(status === 403 ? "denied" : status === 404 ? "missing" : "failed");
      });

    return () => {
      cancelled = true;
      if (created) URL.revokeObjectURL(created);
    };
  }, [src]);

  if (state === "ready" && objectUrl) {
    return (
      // eslint-disable-next-line @next/next/no-img-element
      <img src={objectUrl} alt={alt} className={className} />
    );
  }

  return (
    <div
      className={`grid place-items-center bg-muted/50 text-center text-xs text-muted-foreground ${className ?? ""}`}
      role="img"
      aria-label={alt}
    >
      {state === "loading" ? (
        <Loader2 className="h-4 w-4 animate-spin" aria-hidden />
      ) : (
        <span className="flex flex-col items-center gap-1 p-2">
          <ImageOff className="h-4 w-4" aria-hidden />
          {state === "denied"
            ? "Not yours to view"
            : state === "missing"
              ? "No photo"
              : "Could not load"}
        </span>
      )}
    </div>
  );
}
