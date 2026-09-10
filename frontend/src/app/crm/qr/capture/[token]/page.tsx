"use client";

import { useRef, useState } from "react";
import { useParams } from "next/navigation";
import { CheckCircle2, Loader2 } from "lucide-react";

import { CaptureError, captureLead } from "@/lib/queries/lead-qr";

/**
 * The visitor's screen. Reached only by scanning a printed code, so it is
 * built for a stranger holding a phone in a shop: no navigation, no sign-in,
 * no jargon, and one thing to do.
 *
 * It lives OUTSIDE the `(app)` route group deliberately. Everything in that
 * group is wrapped in SessionGate and would bounce an unauthenticated visitor
 * to /login — which is the one screen this person can never get past.
 */

/**
 * A v4 UUID, which is what the API validates.
 *
 * `crypto.randomUUID` needs a secure context. Production is HTTPS and
 * localhost counts as secure, so the fallback is only for a site served over
 * plain HTTP — rare, but a hard crash on the customer-facing screen is a worse
 * outcome than five lines of arithmetic.
 */
function newUuid(): string {
  const c = globalThis.crypto;
  if (typeof c?.randomUUID === "function") return c.randomUUID();
  const b = new Uint8Array(16);
  c.getRandomValues(b);
  b[6] = (b[6] & 0x0f) | 0x40;
  b[8] = (b[8] & 0x3f) | 0x80;
  const hex = [...b].map((n) => n.toString(16).padStart(2, "0")).join("");
  return `${hex.slice(0, 8)}-${hex.slice(8, 12)}-${hex.slice(12, 16)}-${hex.slice(16, 20)}-${hex.slice(20)}`;
}

/**
 * Turn whatever went wrong into something a customer can act on.
 *
 * The API's own message is used where it is safe and specific; the generic
 * fallbacks never mention tokens, signatures or tenants, because none of that
 * is the visitor's problem or their business.
 */
function visitorMessage(err: unknown): string {
  const res = err instanceof CaptureError ? err : null;
  const status = res?.status;
  if (status === 400) {
    /*
     * A 400 here is either "this code is no longer valid" or a field the
     * visitor can still fix, and only the server knows which. Its messages are
     * already written for this reader ("Tell us what you are interested in.",
     * "Invalid or expired QR link.") and mention nothing internal, so they are
     * shown as-is. Guessing "expired" for all of them told people to fetch a
     * new poster when the real fix was one empty box.
     */
    const msg = (res?.data as { message?: string | string[] } | undefined)
      ?.message;
    const first = Array.isArray(msg) ? msg[0] : msg;
    if (typeof first === "string" && first.trim()) return first;
    return "This code is no longer active. Please ask a member of staff for a current one.";
  }
  if (status === 429) {
    return "Too many enquiries from this connection just now. Please try again in a minute.";
  }
  if (status === undefined) {
    return "We could not reach the shop just now. Check your connection and try again.";
  }
  return "Something went wrong sending your enquiry. Please try again, or speak to a member of staff.";
}

export default function QrCapturePage() {
  const params = useParams<{ token: string }>();
  const token = params?.token ?? "";

  const [customerName, setCustomerName] = useState("");
  const [phone, setPhone] = useState("");
  const [interest, setInterest] = useState("");
  const [consent, setConsent] = useState(false);
  const [honeypot, setHoneypot] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [reference, setReference] = useState<string | null>(null);

  /*
   * One id for the life of this form, generated on first submit rather than
   * during render — a value made while rendering would differ between the
   * prerendered HTML and the browser, and React would throw a hydration
   * mismatch. Holding it across retries is the point: a timeout followed by a
   * second tap returns the FIRST lead instead of filing a duplicate.
   */
  const submissionId = useRef<string | null>(null);

  const submit = async (e: React.FormEvent) => {
    e.preventDefault();
    setError(null);
    if (!consent) {
      setError("Please tick the box so we know we may contact you.");
      return;
    }
    if (!submissionId.current) submissionId.current = newUuid();
    setBusy(true);
    try {
      const res = await captureLead(token, {
        submissionId: submissionId.current,
        customerName: customerName.trim(),
        phone: phone.trim(),
        ...(interest.trim() ? { interest: interest.trim() } : {}),
        consent: true,
        ...(honeypot ? { website: honeypot } : {}),
      });
      setReference(res.reference);
    } catch (err) {
      setError(visitorMessage(err));
    } finally {
      setBusy(false);
    }
  };

  if (reference) {
    return (
      <main className="flex min-h-dvh items-center justify-center bg-background px-5 py-10">
        <div className="w-full max-w-sm text-center">
          <div className="mx-auto flex h-14 w-14 items-center justify-center rounded-full bg-[#0F2A1E] text-[#c8a24f]">
            <CheckCircle2 className="h-7 w-7" />
          </div>
          <h1 className="mt-5 font-[family-name:var(--font-display-face)] text-2xl">
            Thank you
          </h1>
          <p className="mt-2 text-sm leading-relaxed text-muted-foreground">
            We have your enquiry and someone from the team will call you
            shortly.
          </p>
          <p className="mt-6 text-xs text-muted-foreground">
            Your reference
            <span className="mt-1 block font-[family-name:var(--font-mono-face)] text-sm text-foreground">
              {reference}
            </span>
          </p>
          <p className="mt-8 text-xs text-muted-foreground">
            You can close this page.
          </p>
        </div>
      </main>
    );
  }

  return (
    <main className="flex min-h-dvh items-center justify-center bg-background px-5 py-10">
      <div className="w-full max-w-sm">
        <h1 className="font-[family-name:var(--font-display-face)] text-2xl">
          Tell us what you are looking for
        </h1>
        <p className="mt-2 text-sm leading-relaxed text-muted-foreground">
          Leave your details and someone from the team will get back to you.
        </p>

        <form onSubmit={submit} className="mt-7 space-y-4" noValidate>
          <div className="space-y-1.5">
            <label htmlFor="name" className="text-sm font-medium">
              Your name
            </label>
            <input
              id="name"
              value={customerName}
              onChange={(e) => setCustomerName(e.target.value)}
              autoComplete="name"
              required
              minLength={2}
              maxLength={120}
              className="h-11 w-full rounded-md border border-border bg-card px-3 text-base outline-none focus-visible:ring-2 focus-visible:ring-ring"
            />
          </div>

          <div className="space-y-1.5">
            <label htmlFor="phone" className="text-sm font-medium">
              Phone number
            </label>
            <input
              id="phone"
              type="tel"
              inputMode="tel"
              value={phone}
              onChange={(e) => setPhone(e.target.value)}
              autoComplete="tel"
              required
              minLength={8}
              maxLength={32}
              className="h-11 w-full rounded-md border border-border bg-card px-3 text-base outline-none focus-visible:ring-2 focus-visible:ring-ring"
            />
            <p className="text-xs text-muted-foreground">
              This is how we will reach you.
            </p>
          </div>

          <div className="space-y-1.5">
            <label htmlFor="interest" className="text-sm font-medium">
              What are you interested in?{" "}
              <span className="font-normal text-muted-foreground">
                (optional)
              </span>
            </label>
            <textarea
              id="interest"
              value={interest}
              onChange={(e) => setInterest(e.target.value)}
              rows={3}
              maxLength={280}
              className="w-full resize-none rounded-md border border-border bg-card px-3 py-2 text-base outline-none focus-visible:ring-2 focus-visible:ring-ring"
            />
          </div>

          {/*
            Honeypot. Hidden from people and from screen readers, left empty by
            every real submission; the API refuses anything that fills it.
          */}
          <div aria-hidden className="absolute left-[-9999px] h-0 w-0 overflow-hidden">
            <label htmlFor="website">Website</label>
            <input
              id="website"
              tabIndex={-1}
              autoComplete="off"
              value={honeypot}
              onChange={(e) => setHoneypot(e.target.value)}
            />
          </div>

          <label className="flex cursor-pointer items-start gap-3 rounded-md border border-border bg-card p-3">
            <input
              type="checkbox"
              checked={consent}
              onChange={(e) => setConsent(e.target.checked)}
              className="mt-0.5 h-4 w-4 shrink-0 accent-[#0F2A1E]"
            />
            <span className="text-xs leading-relaxed text-muted-foreground">
              Yes, please contact me about this enquiry. We will only use your
              details to reply to you.
            </span>
          </label>

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
              "Send enquiry"
            )}
          </button>
        </form>
      </div>
    </main>
  );
}
