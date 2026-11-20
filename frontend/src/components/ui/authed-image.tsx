"use client";

import { useEffect, useState } from "react";
import { ImageOff, Loader2, Paperclip } from "lucide-react";

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

/**
 * The fetch itself, shared by every authenticated attachment.
 *
 * One copy because the revoke is the part that is easy to lose: a second
 * component that fetched its own blob and forgot to release it would leak a
 * conversation's worth of photographs for as long as the tab stayed open. The
 * blob's own media type comes back with it — the server states it on the
 * response, and that is more trustworthy than the row, where an outbound quote
 * PDF is recorded only as "document".
 */
function useAuthedBlob(src: string) {
  const [objectUrl, setObjectUrl] = useState<string | null>(null);
  const [blobType, setBlobType] = useState<string>("");
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
        setBlobType(res.data.type ?? "");
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

  return { objectUrl, blobType, state };
}

function AuthedImageFrame({ src, alt, className }: AuthedImageProps) {
  const { objectUrl, state } = useAuthedBlob(src);

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

interface AuthedAttachmentProps extends AuthedImageProps {
  /**
   * What the message row says this is. Used only until the bytes arrive and
   * state their own type, and for the label on something no browser can play.
   */
  mediaType?: string | null;
}

/**
 * An attachment on a conversation, whatever kind it is.
 *
 * A photograph belongs in the bubble, and so does a video or a voice note: a
 * manager checking what a customer was shown — or what they sent — should not
 * have to take the word of a line of text reading "video/mp4". Anything a
 * browser cannot play is named rather than faked, which is the same contract
 * the rest of this file keeps: a refusal is shown as a refusal.
 *
 * Keyed on `src` for the reason `AuthedImage` is: a bubble switched to another
 * attachment must not show the previous one while the new fetch runs.
 */
export function AuthedAttachment(props: AuthedAttachmentProps) {
  return <AuthedAttachmentFrame key={props.src} {...props} />;
}

function AuthedAttachmentFrame({ src, alt, className, mediaType }: AuthedAttachmentProps) {
  const { objectUrl, blobType, state } = useAuthedBlob(src);
  const type = blobType || mediaType || "";

  if (state === "ready" && objectUrl) {
    if (type.startsWith("image/")) {
      // eslint-disable-next-line @next/next/no-img-element
      return <img src={objectUrl} alt={alt} className={className} />;
    }
    if (type.startsWith("video/")) {
      return <video src={objectUrl} controls className={className} aria-label={alt} />;
    }
    if (type.startsWith("audio/")) {
      return <audio src={objectUrl} controls className="w-full" aria-label={alt} />;
    }
    /*
     * A PDF in a chat bubble is a row, not a page. Opened in a tab of its own
     * from the object URL already in hand, so the file never needs a public
     * link and the bytes are not fetched a second time.
     */
    return (
      <a
        href={objectUrl}
        target="_blank"
        rel="noopener noreferrer"
        className="flex items-center gap-1.5 text-[12px] underline underline-offset-2 opacity-80"
      >
        <Paperclip className="h-3.5 w-3.5" aria-hidden />
        <span>{attachmentLabel(type)}</span>
      </a>
    );
  }

  return (
    <span className="flex items-center gap-1.5 text-[12px] opacity-80">
      {state === "loading" ? (
        <Loader2 className="h-3.5 w-3.5 animate-spin" aria-hidden />
      ) : (
        <ImageOff className="h-3.5 w-3.5" aria-hidden />
      )}
      <span>
        {state === "loading"
          ? attachmentLabel(type)
          : state === "denied"
            ? "Not yours to view"
            : state === "missing"
              ? `${attachmentLabel(type)} — no longer stored`
              : `${attachmentLabel(type)} — could not load`}
      </span>
    </span>
  );
}

/** What to call an attachment in front of a shop-floor user. */
export function attachmentLabel(mediaType?: string | null): string {
  const type = (mediaType ?? "").toLowerCase();
  if (type.startsWith("image/")) return "Photo";
  if (type.startsWith("video/")) return "Video";
  if (type.startsWith("audio/")) return "Voice note";
  if (type === "application/pdf") return "PDF document";
  // 'document' is what the outbound quote path records, the mime type having
  // never reached the row.
  if (type === "document" || type.startsWith("application/")) return "Document";
  return "Attachment";
}
