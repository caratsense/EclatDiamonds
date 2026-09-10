"use client";

import { useEffect, useState } from "react";
import { useParams } from "next/navigation";
import { CheckCircle2, Loader2, Star } from "lucide-react";

import {
  FeedbackError,
  fetchPublicFeedback,
  submitPublicFeedback,
} from "@/lib/queries/feedback";

/**
 * The customer's side of a feedback request.
 *
 * Outside the `(app)` route group, like the QR capture and the enquiry form,
 * because everything inside that group is wrapped in SessionGate and would
 * bounce a customer to /login.
 *
 * What happens after they answer is decided entirely on the server. This page
 * does not know the tenant's thresholds and does not choose whether to show a
 * review link — it shows one only if the response says so. Putting that decision
 * in the browser would mean a customer could read the rule out of the bundle,
 * and a tenant could not prove an unhappy customer was never invited.
 */

function visitorMessage(err: unknown): string {
  const e = err instanceof FeedbackError ? err : null;
  if (e?.status === 404) {
    return "This feedback link is no longer available.";
  }
  if (e?.status === 409) {
    return "You have already answered this. Thank you.";
  }
  if (e?.status === 400) {
    const msg = (e.data as { message?: string | string[] } | null)?.message;
    const first = Array.isArray(msg) ? msg[0] : msg;
    if (typeof first === "string" && first.trim()) return first;
  }
  if (e?.status === 429) {
    return "Too many attempts just now. Please try again in a minute.";
  }
  if (!e) {
    return "We could not reach the business just now. Check your connection and try again.";
  }
  return "Something went wrong. Please try again.";
}

export default function PublicFeedbackPage() {
  const params = useParams<{ publicKey: string }>();
  const publicKey = params?.publicKey ?? "";

  const [businessName, setBusinessName] = useState<string | null>(null);
  const [loadError, setLoadError] = useState<string | null>(null);
  const [rating, setRating] = useState(0);
  const [hover, setHover] = useState(0);
  const [comment, setComment] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [done, setDone] = useState<{ reviewLink: string | null } | null>(null);

  useEffect(() => {
    let cancelled = false;
    if (!publicKey) return;
    fetchPublicFeedback(publicKey)
      .then((v) => {
        if (cancelled) return;
        setBusinessName(v.businessName);
        if (v.alreadyAnswered) setDone({ reviewLink: null });
      })
      .catch((err) => {
        if (!cancelled) setLoadError(visitorMessage(err));
      });
    return () => {
      cancelled = true;
    };
  }, [publicKey]);

  const submit = async (e: React.FormEvent) => {
    e.preventDefault();
    setError(null);
    if (rating < 1) {
      setError("Please choose a rating.");
      return;
    }
    setBusy(true);
    try {
      const res = await submitPublicFeedback(publicKey, {
        rating,
        ...(comment.trim() ? { comment: comment.trim() } : {}),
      });
      setDone({ reviewLink: res.reviewLink });
    } catch (err) {
      setError(visitorMessage(err));
    } finally {
      setBusy(false);
    }
  };

  if (loadError) {
    return (
      <main className="flex min-h-dvh items-center justify-center bg-background px-5 py-10">
        <p className="max-w-sm text-center text-sm text-muted-foreground">{loadError}</p>
      </main>
    );
  }

  if (done) {
    return (
      <main className="flex min-h-dvh items-center justify-center bg-background px-5 py-10">
        <div className="w-full max-w-sm text-center">
          <div className="mx-auto flex h-14 w-14 items-center justify-center rounded-full bg-[#0F2A1E] text-[#c8a24f]">
            <CheckCircle2 className="h-7 w-7" />
          </div>
          <h1 className="mt-5 font-[family-name:var(--font-display-face)] text-2xl">Thank you</h1>
          <p className="mt-2 text-sm leading-relaxed text-muted-foreground">
            {done.reviewLink
              ? "We are glad it went well. If you have a moment, it would help others to hear it."
              : "Your feedback has reached the team."}
          </p>
          {done.reviewLink ? (
            <a
              href={done.reviewLink}
              target="_blank"
              rel="noopener noreferrer"
              className="mt-6 inline-flex h-11 items-center justify-center rounded-md bg-[#0F2A1E] px-5 text-sm font-medium text-[#f6f3ed]"
            >
              Leave a public review
            </a>
          ) : null}
        </div>
      </main>
    );
  }

  return (
    <main className="flex min-h-dvh items-center justify-center bg-background px-5 py-10">
      <div className="w-full max-w-sm">
        <h1 className="font-[family-name:var(--font-display-face)] text-2xl">
          How did we do?
        </h1>
        <p className="mt-2 text-sm leading-relaxed text-muted-foreground">
          {businessName ? `${businessName} would like to know.` : "Your answer goes to the team."}
        </p>

        <form onSubmit={submit} className="mt-7 space-y-5" noValidate>
          <div>
            <div className="flex justify-center gap-2" role="radiogroup" aria-label="Rating">
              {[1, 2, 3, 4, 5].map((n) => (
                <button
                  key={n}
                  type="button"
                  role="radio"
                  aria-checked={rating === n}
                  aria-label={`${n} out of 5`}
                  onClick={() => setRating(n)}
                  onMouseEnter={() => setHover(n)}
                  onMouseLeave={() => setHover(0)}
                  className="rounded-md p-1 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring"
                >
                  <Star
                    className={`h-9 w-9 transition-colors ${
                      n <= (hover || rating)
                        ? "fill-[#c8a24f] text-[#c8a24f]"
                        : "text-muted-foreground"
                    }`}
                  />
                </button>
              ))}
            </div>
          </div>

          <div className="space-y-1.5">
            <label htmlFor="comment" className="text-sm font-medium">
              Anything you would like to add?
            </label>
            <textarea
              id="comment"
              value={comment}
              onChange={(e) => setComment(e.target.value)}
              rows={4}
              maxLength={2000}
              className="w-full resize-none rounded-md border border-border bg-card px-3 py-2 text-base outline-none focus-visible:ring-2 focus-visible:ring-ring"
            />
          </div>

          {error ? (
            <p
              role="alert"
              className="rounded-md border border-destructive/30 bg-destructive/10 px-3 py-2 text-xs text-destructive"
            >
              {error}
            </p>
          ) : null}

          <button
            type="submit"
            disabled={busy}
            className="flex h-11 w-full items-center justify-center rounded-md bg-[#0F2A1E] text-sm font-medium text-[#f6f3ed] transition-opacity disabled:opacity-60"
          >
            {busy ? (
              <>
                <Loader2 className="mr-2 h-4 w-4 animate-spin" />
                Sending…
              </>
            ) : (
              "Send"
            )}
          </button>
        </form>
      </div>
    </main>
  );
}
