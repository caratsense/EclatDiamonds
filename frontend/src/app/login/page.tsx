"use client";

import * as React from "react";
import { useRouter } from "next/navigation";
import { Loader2 } from "lucide-react";
import { toast } from "sonner";
import type { AxiosError } from "axios";

import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Logo } from "@/components/brand/logo";
import { GoogleSignInButton } from "@/components/auth/google-sign-in-button";
import { homeForRole } from "@/lib/navigation";
import { getStoredToken } from "@/lib/api";
import {
  useLogin,
  useGoogleLogin,
  useRequestOtp,
  useVerifyOtp,
} from "@/lib/queries/auth";
import { useSession } from "@/store/use-session";

const DEMO_ACCOUNTS = [
  {
    email: "head.office@caratsense.in",
    phone: "9100000001",
    label: "Head Office — all stores",
  },
  {
    email: "neelam.area@caratsense.in",
    phone: "9100000002",
    label: "Area Manager — West region",
  },
  {
    email: "aarav.mehta@caratsense.in",
    phone: "9100000003",
    label: "Store Manager — Surat",
  },
  {
    email: "priya.rep@caratsense.in",
    phone: "9100000004",
    label: "Salesperson — Surat",
  },
];

/** Surface the backend's 4xx message (NestJS: string or string[]) or fall back. */
function apiMessage(err: unknown, fallback: string): string {
  const message = (err as AxiosError<{ message?: string | string[] }>)
    ?.response?.data?.message;
  if (Array.isArray(message)) return message[0] ?? fallback;
  return typeof message === "string" && message ? message : fallback;
}

const HIGHLIGHTS = [
  "Multi-store sales & daily reports in real time",
  "Catalogue with AI image-based search",
  "Role-based access, secure by store",
];

export default function LoginPage() {
  const router = useRouter();
  const hydrate = useSession((s) => s.hydrate);
  const login = useLogin();
  const googleLogin = useGoogleLogin();
  const requestOtp = useRequestOtp();
  const verifyOtp = useVerifyOtp();

  const [email, setEmail] = React.useState("head.office@caratsense.in");
  const [password, setPassword] = React.useState("password123");

  // WhatsApp OTP flow (the primary staff sign-in).
  const [phone, setPhone] = React.useState("");
  const [code, setCode] = React.useState("");
  const [otpStep, setOtpStep] = React.useState<"phone" | "code">("phone");
  const [resendIn, setResendIn] = React.useState(0);
  // Email/password is a fallback until Google + WhatsApp are configured.
  const [showPassword, setShowPassword] = React.useState(false);

  // Live resend countdown — ticks down once per second while > 0.
  React.useEffect(() => {
    if (resendIn <= 0) return;
    const t = setTimeout(() => setResendIn((s) => s - 1), 1000);
    return () => clearTimeout(t);
  }, [resendIn]);

  function finishLogin(me: Parameters<typeof hydrate>[0]) {
    hydrate(me);
    toast.success(`Welcome, ${me.user.name}`);
    // Land each role where their work starts (salesperson has no Dashboards nav).
    router.replace(homeForRole(me.role));
  }

  function onGoogle(credential: string) {
    googleLogin.mutate(credential, {
      onSuccess: finishLogin,
      onError: (err) => {
        const status = (err as AxiosError)?.response?.status;
        toast.error(
          status === 401
            ? "No Éclat account for this Google email."
            : "Google sign-in failed.",
        );
      },
    });
  }

  // Already authenticated? Skip the form.
  React.useEffect(() => {
    if (getStoredToken()) router.replace("/dashboards");
  }, [router]);

  function onSubmit(e: React.FormEvent) {
    e.preventDefault();
    login.mutate(
      { email, password },
      {
        onSuccess: finishLogin,
        onError: (err) => {
          const status = (err as AxiosError)?.response?.status;
          toast.error(
            status === 401
              ? "Invalid email or password."
              : "Couldn't sign in. Check your connection and try again.",
          );
        },
      },
    );
  }

  function sendCode() {
    if (!/^\d{10}$/.test(phone)) {
      toast.error("Enter a valid 10-digit mobile number.");
      return;
    }
    requestOtp.mutate(phone, {
      onSuccess: (res) => {
        toast.success(
          res.dryRun
            ? "Code sent (test mode — ask your administrator)."
            : "Code sent on WhatsApp.",
        );
        setOtpStep("code");
        setCode("");
        setResendIn(60);
      },
      // 429 (cooldown / hourly cap) and 400 carry a human message in the
      // body — surface it verbatim. The countdown is deliberately left
      // untouched on error.
      onError: (err) =>
        toast.error(
          apiMessage(err, "Couldn't send the code. Try again in a moment."),
        ),
    });
  }

  function onSendCode(e: React.FormEvent) {
    e.preventDefault();
    sendCode();
  }

  function onVerify(e: React.FormEvent) {
    e.preventDefault();
    if (!/^\d{6}$/.test(code)) {
      toast.error("Enter the 6-digit code.");
      return;
    }
    verifyOtp.mutate(
      { phone, code },
      {
        onSuccess: finishLogin,
        onError: (err) =>
          toast.error(
            apiMessage(err, "Couldn't verify the code. Try again."),
          ),
      },
    );
  }

  return (
    <div className="grid min-h-dvh lg:grid-cols-[1.05fr_1fr]">
      {/* ── Brand panel ─────────────────────────────────────────────── */}
      <aside className="emerald-panel relative hidden flex-col justify-between overflow-hidden p-10 lg:flex xl:p-14">
        <div className="flex items-center">
          <Logo className="h-14 w-auto" />
        </div>

        <div className="max-w-md">
          <h1 className="font-display text-4xl font-semibold leading-[1.1] xl:text-5xl">
            Where dreams meet diamonds.
          </h1>
          <p className="mt-5 text-[15px] leading-relaxed text-brand-foreground/75">
            The unified operations platform behind every Éclat Diamonds store —
            sales, inventory, finance and people, in one quiet place.
          </p>

          <div className="mt-8 h-px w-28 bg-gradient-to-r from-[var(--gold)] to-transparent" />

          <ul className="mt-7 space-y-3">
            {HIGHLIGHTS.map((h) => (
              <li
                key={h}
                className="flex items-center gap-3 text-sm text-brand-foreground/85"
              >
                <span className="h-1.5 w-1.5 shrink-0 rounded-full bg-[var(--gold)]" />
                {h}
              </li>
            ))}
          </ul>
        </div>

        <div className="flex items-center justify-between text-[11px] text-brand-foreground/55">
          <span className="uppercase tracking-[0.18em]">CaratSense platform</span>
          <span>© 2026 Éclat Diamonds</span>
        </div>
      </aside>

      {/* ── Sign-in form ────────────────────────────────────────────── */}
      <main className="flex items-center justify-center px-5 py-10 sm:px-8">
        <div className="w-full max-w-sm">
          {/* compact brand for mobile (panel hidden < lg) — on an emerald chip
              so the gold logo keeps contrast over the light form background */}
          <div className="mb-8 lg:hidden">
            <span className="inline-flex items-center rounded-xl bg-brand px-3.5 py-2.5">
              <Logo className="h-7 w-auto" />
            </span>
          </div>

          <h2 className="font-display text-3xl font-semibold tracking-tight">
            Sign in
          </h2>
          <p className="mt-1.5 text-sm text-muted-foreground">
            Welcome back. Enter your details to continue.
          </p>

          {/* ── Google — one-tap primary (renders once NEXT_PUBLIC_GOOGLE_CLIENT_ID is configured) ── */}
          {process.env.NEXT_PUBLIC_GOOGLE_CLIENT_ID ? (
            <div className="mt-6">
              <GoogleSignInButton onCredential={onGoogle} />
              <div className="mt-5 flex items-center gap-3 text-xs text-muted-foreground">
                <div className="h-px flex-1 bg-border" />
                or sign in with WhatsApp
                <div className="h-px flex-1 bg-border" />
              </div>
            </div>
          ) : null}

          {/* ── WhatsApp OTP — primary staff flow ─────────────────── */}
          <div className="mt-5">
              {otpStep === "phone" ? (
                <form onSubmit={onSendCode} className="space-y-4">
                  <div className="space-y-1.5">
                    <Label htmlFor="otp-phone">Mobile number</Label>
                    <Input
                      id="otp-phone"
                      type="tel"
                      inputMode="numeric"
                      autoComplete="tel-national"
                      placeholder="10-digit mobile number"
                      maxLength={10}
                      value={phone}
                      onChange={(e) =>
                        setPhone(e.target.value.replace(/\D/g, "").slice(0, 10))
                      }
                      required
                    />
                    <p className="text-xs text-muted-foreground">
                      We&apos;ll send a one-time sign-in code to this number on
                      WhatsApp.
                    </p>
                  </div>
                  <Button
                    type="submit"
                    variant="gold"
                    size="lg"
                    className="w-full"
                    disabled={requestOtp.isPending}
                  >
                    {requestOtp.isPending ? (
                      <>
                        <Loader2 className="h-4 w-4 animate-spin" /> Sending…
                      </>
                    ) : (
                      "Send code"
                    )}
                  </Button>
                </form>
              ) : (
                <form onSubmit={onVerify} className="space-y-4">
                  <div className="flex items-center justify-between rounded-lg border bg-muted/30 px-3 py-2 text-sm">
                    <span>
                      Code sent to{" "}
                      <span className="num font-medium">{phone}</span>
                    </span>
                    <button
                      type="button"
                      onClick={() => setOtpStep("phone")}
                      className="text-xs font-medium underline underline-offset-2 hover:text-foreground"
                    >
                      Change
                    </button>
                  </div>
                  <div className="space-y-1.5">
                    <Label htmlFor="otp-code">6-digit code</Label>
                    <Input
                      id="otp-code"
                      inputMode="numeric"
                      autoComplete="one-time-code"
                      placeholder="6-digit code"
                      maxLength={6}
                      autoFocus
                      className="num tracking-[0.35em]"
                      value={code}
                      onChange={(e) =>
                        setCode(e.target.value.replace(/\D/g, "").slice(0, 6))
                      }
                      required
                    />
                  </div>
                  <Button
                    type="submit"
                    variant="gold"
                    size="lg"
                    className="w-full"
                    disabled={verifyOtp.isPending}
                  >
                    {verifyOtp.isPending ? (
                      <>
                        <Loader2 className="h-4 w-4 animate-spin" /> Verifying…
                      </>
                    ) : (
                      "Verify & sign in"
                    )}
                  </Button>
                  <p className="text-center text-xs text-muted-foreground">
                    Didn&apos;t receive it?{" "}
                    <button
                      type="button"
                      onClick={sendCode}
                      disabled={resendIn > 0 || requestOtp.isPending}
                      className="font-medium underline underline-offset-2 hover:text-foreground disabled:no-underline disabled:opacity-70"
                    >
                      {resendIn > 0 ? (
                        <>
                          Resend in <span className="num">{resendIn}</span>s
                        </>
                      ) : (
                        "Resend code"
                      )}
                    </button>
                  </p>
                </form>
              )}
          </div>

          {/* ── Email + password — kept as an administrative fallback until
                 Google + WhatsApp are fully configured; collapsed by default ── */}
          <p className="mt-5 text-center">
            <button
              type="button"
              onClick={() => setShowPassword((v) => !v)}
              className="text-xs font-medium text-muted-foreground underline underline-offset-2 hover:text-foreground"
            >
              {showPassword
                ? "Hide password sign-in"
                : "Sign in with email and password instead"}
            </button>
          </p>
          {showPassword ? (
            <div className="mt-4">
              <form onSubmit={onSubmit} className="space-y-4">
                <div className="space-y-1.5">
                  <Label htmlFor="email">Email</Label>
                  <Input
                    id="email"
                    type="email"
                    autoComplete="username"
                    value={email}
                    onChange={(e) => setEmail(e.target.value)}
                    required
                  />
                </div>
                <div className="space-y-1.5">
                  <Label htmlFor="password">Password</Label>
                  <Input
                    id="password"
                    type="password"
                    autoComplete="current-password"
                    value={password}
                    onChange={(e) => setPassword(e.target.value)}
                    required
                  />
                </div>
                <Button
                  type="submit"
                  variant="gold"
                  size="lg"
                  className="w-full"
                  disabled={login.isPending}
                >
                  {login.isPending ? (
                    <>
                      <Loader2 className="h-4 w-4 animate-spin" /> Signing in…
                    </>
                  ) : (
                    "Sign in"
                  )}
                </Button>
              </form>
            </div>
          ) : null}

          <div className="mt-7 rounded-xl border bg-card p-3.5 shadow-xs">
            <p className="mb-2 text-xs font-medium text-muted-foreground">
              Demo accounts — password{" "}
              <code className="num rounded bg-muted px-1 py-0.5 text-foreground">
                password123
              </code>{" "}
              · tap one to pre-fill
            </p>
            <ul className="space-y-1">
              {DEMO_ACCOUNTS.map((a) => (
                <li key={a.email}>
                  <button
                    type="button"
                    onClick={() => {
                      setEmail(a.email);
                      setPhone(a.phone);
                      setOtpStep("phone");
                    }}
                    className="w-full rounded-lg px-2 py-1.5 text-left text-xs transition-colors hover:bg-accent"
                  >
                    <span className="font-medium">{a.email}</span>
                    <span className="block text-muted-foreground">
                      {a.label} · <span className="num">{a.phone}</span>
                    </span>
                  </button>
                </li>
              ))}
            </ul>
          </div>
        </div>
      </main>
    </div>
  );
}
