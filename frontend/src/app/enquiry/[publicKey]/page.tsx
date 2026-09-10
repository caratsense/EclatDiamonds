"use client";

import { useEffect, useRef, useState } from "react";
import { useParams } from "next/navigation";
import { CheckCircle2, Loader2 } from "lucide-react";

import {
  LeadFormError,
  fetchPublicLeadForm,
  submitPublicLeadForm,
  type PublicLeadFormView,
} from "@/lib/queries/lead-forms";

/**
 * The enquiry form a tenant embeds on its own website.
 *
 * Sibling of the QR capture page and public for the same reason: it lives
 * OUTSIDE the `(app)` route group, because everything in that group is wrapped
 * in SessionGate and would bounce a stranger to /login.
 *
 * It shows the tenant nothing about itself beyond the form's own name. The
 * branch, the organisation and the internal ids stay on the server; the
 * unguessable key in the URL is what identifies the form.
 */

/** A v4 UUID, which is what the API validates. */
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
 * Turn whatever went wrong into something a visitor can act on.
 *
 * A 400 carries the server's own wording, which is already written for this
 * reader ("Tell us what you are interested in.") and mentions nothing internal.
 * Guessing a single generic message for all of them told people to give up when
 * the real fix was one empty box.
 */
function visitorMessage(err: unknown): string {
  const e = err instanceof LeadFormError ? err : null;
  if (e?.status === 400) {
    const msg = (e.data as { message?: string | string[] } | null)?.message;
    const first = Array.isArray(msg) ? msg[0] : msg;
    if (typeof first === "string" && first.trim()) return first;
    return "Please check the details and try again.";
  }
  if (e?.status === 404) {
    return "This enquiry form is no longer available. Please contact the business directly.";
  }
  if (e?.status === 429) {
    return "Too many enquiries from this connection just now. Please try again in a minute.";
  }
  if (!e) {
    return "We could not reach the business just now. Check your connection and try again.";
  }
  return "Something went wrong sending your enquiry. Please try again.";
}

const inputCls =
  "h-11 w-full rounded-md border border-border bg-card px-3 text-base outline-none " +
  "focus-visible:ring-2 focus-visible:ring-ring";

export default function PublicEnquiryPage() {
  const params = useParams<{ publicKey: string }>();
  const publicKey = params?.publicKey ?? "";

  const [form, setForm] = useState<PublicLeadFormView | null>(null);
  const [loadError, setLoadError] = useState<string | null>(null);

  const [customerName, setCustomerName] = useState("");
  const [phone, setPhone] = useState("");
  const [email, setEmail] = useState("");
  const [interest, setInterest] = useState("");
  const [consent, setConsent] = useState(false);
  const [honeypot, setHoneypot] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [reference, setReference] = useState<string | null>(null);

  /*
   * One id for the life of this form, minted on first submit rather than during
   * render — a value made while rendering would differ between the prerendered
   * HTML and the browser and React would throw a hydration mismatch. Holding it
   * across retries is the point: a timeout followed by a second tap returns the
   * FIRST lead instead of filing a duplicate.
   */
  const submissionId = useRef<string | null>(null);

  useEffect(() => {
    let cancelled = false;
    if (!publicKey) return;
    fetchPublicLeadForm(publicKey)
      .then((v) => {
        if (!cancelled) setForm(v);
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
    if (!consent) {
      setError("Please tick the box so we know we may contact you.");
      return;
    }
    if (!phone.trim() && !email.trim()) {
      setError("Leave a phone number or an email address so we can reply.");
      return;
    }
    if (!submissionId.current) submissionId.current = newUuid();
    setBusy(true);
    try {
      const res = await submitPublicLeadForm(publicKey, {
        submissionId: submissionId.current,
        customerName: customerName.trim(),
        ...(phone.trim() ? { phone: phone.trim() } : {}),
        ...(email.trim() ? { email: email.trim() } : {}),
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

  if (loadError) {
    return (
      <main className="flex min-h-dvh items-center justify-center bg-background px-5 py-10">
        <p className="max-w-sm text-center text-sm text-muted-foreground">{loadError}</p>
      </main>
    );
  }

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
            We have your enquiry and someone from the team will be in touch
            shortly.
          </p>
          <p className="mt-6 text-xs text-muted-foreground">
            Your reference
            <span className="mt-1 block font-[family-name:var(--font-mono-face)] text-sm text-foreground">
              {reference}
            </span>
          </p>
        </div>
      </main>
    );
  }

  return (
    <main className="flex min-h-dvh items-center justify-center bg-background px-5 py-10">
      <div className="w-full max-w-sm">
        <h1 className="font-[family-name:var(--font-display-face)] text-2xl">
          {form?.name ?? "Send us an enquiry"}
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
              className={inputCls}
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
              maxLength={32}
              className={inputCls}
            />
          </div>

          <div className="space-y-1.5">
            <label htmlFor="email" className="text-sm font-medium">
              Email address
            </label>
            <input
              id="email"
              type="email"
              value={email}
              onChange={(e) => setEmail(e.target.value)}
              autoComplete="email"
              maxLength={160}
              className={inputCls}
            />
            <p className="text-xs text-muted-foreground">
              A phone number or an email address — whichever suits you.
            </p>
          </div>

          <div className="space-y-1.5">
            <label htmlFor="interest" className="text-sm font-medium">
              What are you interested in?{" "}
              {form?.interestOptional ? (
                <span className="font-normal text-muted-foreground">
                  (optional)
                </span>
              ) : null}
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
