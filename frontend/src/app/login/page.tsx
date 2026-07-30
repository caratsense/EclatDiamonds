"use client";

import * as React from "react";
import Image from "next/image";
import { useRouter } from "next/navigation";
import {
  ArrowRight,
  CheckCircle2,
  LockKeyhole,
  Loader2,
  ShieldCheck,
  Sparkles,
  Store,
  Users,
  Smartphone,
  KeyRound,
} from "lucide-react";
import { toast } from "sonner";
import type { AxiosError } from "axios";

import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Logo } from "@/components/brand/logo";
import { GoogleSignInButton } from "@/components/auth/google-sign-in-button";
import { InstallAppButton } from "@/components/pwa/install-app-button";
import { homeForRole } from "@/lib/navigation";
import { clearAttendanceHandled } from "@/lib/attendance-gate";
import { getStoredToken, hasValidSession, setStoredToken } from "@/lib/api";
import {
  useLogin,
  useGoogleLogin,
  useRequestOtp,
  useVerifyOtp,
} from "@/lib/queries/auth";
import { useSession } from "@/store/use-session";
import type { Role } from "@/lib/types";

interface DemoAccount {
  email: string;
  phone: string;
  role: Role;
  roleTitle: string;
  storeLabel: string;
  name: string;
}

const DEMO_ACCOUNTS: DemoAccount[] = [
  {
    email: "priya.rep@caratsense.in",
    phone: "9100000004",
    role: "salesperson",
    roleTitle: "Salesperson",
    storeLabel: "Surat — Main",
    name: "Priya Verma",
  },
  {
    email: "aarav.mehta@caratsense.in",
    phone: "9100000003",
    role: "store_manager",
    roleTitle: "Store Manager",
    storeLabel: "Surat — Main",
    name: "Aarav Mehta",
  },
  {
    email: "neelam.area@caratsense.in",
    phone: "9100000002",
    role: "area_manager",
    roleTitle: "Area Manager",
    storeLabel: "West India Region",
    name: "Neelam Rao",
  },
  {
    email: "head.office@caratsense.in",
    phone: "9100000001",
    role: "head_office",
    roleTitle: "Head Office",
    storeLabel: "Pan-India Admin",
    name: "Head Office",
  },
];

function apiMessage(err: unknown, fallback: string): string {
  const message = (err as AxiosError<{ message?: string | string[] }>)
    ?.response?.data?.message;
  if (Array.isArray(message)) return message[0] ?? fallback;
  return typeof message === "string" && message ? message : fallback;
}

export default function LoginPage() {
  const router = useRouter();
  const hydrate = useSession((s) => s.hydrate);
  const login = useLogin();
  const googleLogin = useGoogleLogin();
  const requestOtp = useRequestOtp();
  const verifyOtp = useVerifyOtp();

  const [selectedDemo, setSelectedDemo] = React.useState<DemoAccount>(DEMO_ACCOUNTS[0]);
  const [email, setEmail] = React.useState(DEMO_ACCOUNTS[0].email);
  const [password, setPassword] = React.useState("password123");

  const [phone, setPhone] = React.useState(DEMO_ACCOUNTS[0].phone);
  const [code, setCode] = React.useState("");
  const [otpStep, setOtpStep] = React.useState<"phone" | "code">("phone");
  const [resendIn, setResendIn] = React.useState(0);
  const [authMethod, setAuthMethod] = React.useState<"whatsapp" | "password">("whatsapp");

  React.useEffect(() => {
    if (resendIn <= 0) return;
    const t = setTimeout(() => setResendIn((s) => s - 1), 1000);
    return () => clearTimeout(t);
  }, [resendIn]);

  function finishLogin(me: Parameters<typeof hydrate>[0]) {
    hydrate(me);
    toast.success(`Welcome, ${me.user.name}`);
    clearAttendanceHandled();
    router.replace(
      me.role === "salesperson" ? "/check-in" : homeForRole(me.role),
    );
  }

  function onGoogle(credential: string, nonce: string) {
    googleLogin.mutate(
      { credential, nonce },
      {
        onSuccess: finishLogin,
        onError: (err) => {
          const status = (err as AxiosError)?.response?.status;
          toast.error(
            status === 401
              ? "No Éclat account for this Google email."
              : "Google sign-in failed.",
          );
        },
      },
    );
  }

  /**
   * If you asked for the login page, you get the login page.
   *
   * This used to be `if (getStoredToken()) router.replace("/dashboards")`, which
   * made the screen unreachable: any leftover token string sent you straight to a
   * dashboard, so you could not sign in as anyone else, and an EXPIRED token
   * bounced you to a dashboard that then 401'd you back here — a redirect loop.
   *
   * Now an existing session is offered, not imposed: a valid one shows a
   * "continue" banner, an expired one is cleared so the form works normally.
   */
  const [resumable, setResumable] = React.useState(false);
  React.useEffect(() => {
    if (hasValidSession()) setResumable(true);
    else if (getStoredToken()) setStoredToken(null);
  }, []);

  function onSubmitPassword(e: React.FormEvent) {
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

  function selectDemo(acc: DemoAccount) {
    setSelectedDemo(acc);
    setEmail(acc.email);
    setPhone(acc.phone);
    setOtpStep("phone");
    setCode("");
  }

  return (
    <div className="grid min-h-dvh bg-[#071e16] text-[#f6f3ed] lg:grid-cols-[1.1fr_1fr]">
      {/* ── Left Realistic Luxury Showroom Panel ───────────────────── */}
      <aside className="relative hidden flex-col justify-between overflow-hidden p-10 lg:flex xl:p-14">
        {/* Rich background image overlay */}
        <div className="absolute inset-0 z-0 opacity-40">
          <Image
            src="/images/luxury_jewelry_hero.png"
            alt="Éclat Luxury Showroom"
            fill
            className="object-cover object-center"
            priority
          />
        </div>
        {/* Soft luxury emerald gradient overlay */}
        <div className="absolute inset-0 z-0 bg-gradient-to-b from-[#071e16]/80 via-[#071e16]/95 to-[#031a13]" />

        {/* Top Header */}
        <div className="relative z-10 flex items-center justify-between">
          <Logo className="h-10 w-auto" />
          <span className="inline-flex items-center gap-2 rounded-full border border-[#c8a24f]/30 bg-[#c8a24f]/10 px-3.5 py-1 text-xs font-medium text-[#c8a24f]">
            <Sparkles className="h-3.5 w-3.5 text-[#c8a24f]" />
            Live Showroom Platform
          </span>
        </div>

        {/* Middle Content & Live Glassmorphism Widgets */}
        <div className="relative z-10 my-auto max-w-lg space-y-7 py-8">
          <div>
            <span className="text-xs font-medium uppercase tracking-[0.2em] text-[#c8a24f]">
              Éclat Diamonds
            </span>
            <h1 className="mt-2 font-display text-4xl font-bold leading-[1.1] text-[#f6f3ed] xl:text-5xl">
              Where dreams meet <span className="italic text-[#c8a24f]">diamonds.</span>
            </h1>
            <p className="mt-4 text-base leading-relaxed text-[#f6f3ed]/75">
              The unified front-of-house operations platform behind every Éclat Diamonds store — sales, inventory, finance, and team in one calm place.
            </p>
          </div>

          {/* Live Interactive Widgets */}
          <div className="grid gap-3.5">
            {/* Widget 1: Multi-Store Live Pulse */}
            <div className="flex items-center gap-3.5 rounded-2xl border border-[#1b3a2c] bg-[#0c261c]/80 p-4 shadow-lg backdrop-blur-md">
              <div className="relative flex h-10 w-10 shrink-0 items-center justify-center rounded-xl bg-[#c8a24f]/15 text-[#c8a24f]">
                <Store className="h-5 w-5" />
                <span className="absolute -right-0.5 -top-0.5 flex h-3 w-3">
                  <span className="absolute inline-flex h-full w-full animate-ping rounded-full bg-emerald-400 opacity-75" />
                  <span className="relative inline-flex h-3 w-3 rounded-full bg-emerald-500" />
                </span>
              </div>
              <div className="flex-1">
                <div className="flex items-center justify-between">
                  <p className="text-sm font-semibold text-[#f6f3ed]">3 Branches Active</p>
                  <span className="text-[11px] font-mono text-emerald-400">Live Sync</span>
                </div>
                <p className="mt-0.5 text-xs text-[#f6f3ed]/65">Surat Main · Mumbai Bandra · Ahmedabad CG</p>
              </div>
            </div>

            {/* Widget 2: Security & Role Isolation */}
            <div className="flex items-center gap-3.5 rounded-2xl border border-[#1b3a2c] bg-[#0c261c]/80 p-4 shadow-lg backdrop-blur-md">
              <div className="flex h-10 w-10 shrink-0 items-center justify-center rounded-xl bg-[#c8a24f]/15 text-[#c8a24f]">
                <ShieldCheck className="h-5 w-5" />
              </div>
              <div className="flex-1">
                <p className="text-sm font-semibold text-[#f6f3ed]">Role-Aware Security & Cost Protection</p>
                <p className="mt-0.5 text-xs text-[#f6f3ed]/65">Sales staff see selling price only; margins masked automatically.</p>
              </div>
            </div>
          </div>
        </div>

        {/* Bottom Footer */}
        <div className="relative z-10 flex items-center justify-between border-t border-[#1b3a2c] pt-5 text-xs text-[#f6f3ed]/50">
          <span className="font-mono uppercase tracking-[0.16em]">CaratSense OS v2.4</span>
          <span>© 2026 Éclat Diamonds. All rights reserved.</span>
        </div>
      </aside>

      {/* ── Right Live Interactive Sign-in Form ─────────────────────── */}
      <main className="relative flex flex-col justify-between bg-[#071e16] px-6 py-10 sm:px-12 lg:px-16">
        <div className="mx-auto w-full max-w-md my-auto space-y-7">
          {/* Mobile Logo */}
          <div className="mb-4 lg:hidden">
            <Logo className="h-9 w-auto" />
          </div>

          <div>
            <h2 className="font-display text-3xl font-bold tracking-tight text-[#f6f3ed]">
              Sign in to your counter
            </h2>
            <p className="mt-1.5 text-sm text-[#f6f3ed]/70">
              Select your role keycard or enter details to start the session.
            </p>
          </div>

          {/* An existing session is offered, never forced — see the note on
              `resumable` above. Signing in below simply replaces it. */}
          {resumable ? (
            <div className="rounded-lg border border-[#c8a24f]/40 bg-[#c8a24f]/10 p-3">
              <p className="text-sm text-[#f6f3ed]">
                You&apos;re already signed in on this device.
              </p>
              <div className="mt-2 flex flex-wrap gap-2">
                <Button
                  type="button"
                  size="sm"
                  onClick={() => router.replace("/dashboards")}
                >
                  Continue where I left off
                </Button>
                <Button
                  type="button"
                  size="sm"
                  variant="ghost"
                  className="text-[#f6f3ed]/80 hover:text-[#f6f3ed]"
                  onClick={() => {
                    setStoredToken(null);
                    clearAttendanceHandled();
                    setResumable(false);
                  }}
                >
                  Sign in as someone else
                </Button>
              </div>
            </div>
          ) : null}

          {/* Role Keycard Pills — 1-Click Demo Selector */}
          <div>
            <Label className="text-xs uppercase tracking-wider text-[#c8a24f] font-mono">
              Select Employee Keycard
            </Label>
            <div className="mt-2.5 grid grid-cols-2 gap-2">
              {DEMO_ACCOUNTS.map((acc) => {
                const active = selectedDemo.email === acc.email;
                return (
                  <button
                    key={acc.email}
                    type="button"
                    onClick={() => selectDemo(acc)}
                    className={`group relative flex flex-col items-start rounded-xl border p-3 text-left transition-all ${
                      active
                        ? "border-[#c8a24f] bg-[#0c261c] text-[#f6f3ed] shadow-md ring-1 ring-[#c8a24f]"
                        : "border-[#1b3a2c] bg-[#071e16]/60 text-[#f6f3ed]/70 hover:border-[#c8a24f]/40 hover:bg-[#0c261c]/50"
                    }`}
                  >
                    <div className="flex w-full items-center justify-between">
                      <span className={`text-xs font-semibold ${active ? "text-[#c8a24f]" : "text-[#f6f3ed]/90"}`}>
                        {acc.roleTitle}
                      </span>
                      {active ? (
                        <CheckCircle2 className="h-3.5 w-3.5 text-[#c8a24f]" />
                      ) : null}
                    </div>
                    <span className="mt-1 text-[11px] font-medium truncate max-w-[130px]">
                      {acc.name}
                    </span>
                    <span className="text-[10px] text-[#f6f3ed]/50 truncate max-w-[130px]">
                      {acc.storeLabel}
                    </span>
                  </button>
                );
              })}
            </div>
          </div>

          {/* Auth Method Switcher (WhatsApp OTP vs Email Password) */}
          <div className="flex rounded-xl border border-[#1b3a2c] bg-[#0c261c] p-1">
            <button
              type="button"
              onClick={() => setAuthMethod("whatsapp")}
              className={`flex-1 flex items-center justify-center gap-2 rounded-lg py-2 text-xs font-medium transition-colors ${
                authMethod === "whatsapp"
                  ? "bg-[#c8a24f] text-[#071e16] font-semibold shadow-xs"
                  : "text-[#f6f3ed]/70 hover:text-[#f6f3ed]"
              }`}
            >
              <Smartphone className="h-3.5 w-3.5" />
              WhatsApp OTP
            </button>
            <button
              type="button"
              onClick={() => setAuthMethod("password")}
              className={`flex-1 flex items-center justify-center gap-2 rounded-lg py-2 text-xs font-medium transition-colors ${
                authMethod === "password"
                  ? "bg-[#c8a24f] text-[#071e16] font-semibold shadow-xs"
                  : "text-[#f6f3ed]/70 hover:text-[#f6f3ed]"
              }`}
            >
              <KeyRound className="h-3.5 w-3.5" />
              Password Login
            </button>
          </div>

          {/* Google Sign-In if configured */}
          {process.env.NEXT_PUBLIC_GOOGLE_CLIENT_ID ? (
            <div>
              <GoogleSignInButton onCredential={onGoogle} />
              <div className="mt-4 flex items-center gap-3 text-xs text-[#f6f3ed]/40">
                <div className="h-px flex-1 bg-[#1b3a2c]" />
                or continue with credentials
                <div className="h-px flex-1 bg-[#1b3a2c]" />
              </div>
            </div>
          ) : null}

          {/* Auth Form Container */}
          <div className="rounded-2xl border border-[#1b3a2c] bg-[#0c261c]/80 p-5 shadow-xl">
            {authMethod === "whatsapp" ? (
              /* WhatsApp OTP Form */
              otpStep === "phone" ? (
                <form onSubmit={onSendCode} className="space-y-4">
                  <div className="space-y-1.5">
                    <Label htmlFor="otp-phone" className="text-xs text-[#f6f3ed]/80">
                      Mobile number
                    </Label>
                    <Input
                      id="otp-phone"
                      type="tel"
                      inputMode="numeric"
                      autoComplete="tel-national"
                      placeholder="10-digit mobile number"
                      maxLength={10}
                      className="border-[#1b3a2c] bg-[#071e16] text-[#f6f3ed] placeholder:text-[#f6f3ed]/30 focus:border-[#c8a24f] focus:ring-[#c8a24f]"
                      value={phone}
                      onChange={(e) =>
                        setPhone(e.target.value.replace(/\D/g, "").slice(0, 10))
                      }
                      required
                    />
                    <p className="text-[11px] text-[#f6f3ed]/55">
                      Sign-in code will be sent to your registered WhatsApp.
                    </p>
                  </div>
                  <Button
                    type="submit"
                    className="w-full bg-[#c8a24f] text-[#071e16] font-semibold hover:bg-[#b8903c]"
                    disabled={requestOtp.isPending}
                  >
                    {requestOtp.isPending ? (
                      <>
                        <Loader2 className="h-4 w-4 animate-spin mr-2" /> Sending OTP…
                      </>
                    ) : (
                      <>
                        Send WhatsApp Code <ArrowRight className="h-4 w-4 ml-1" />
                      </>
                    )}
                  </Button>
                </form>
              ) : (
                <form onSubmit={onVerify} className="space-y-4">
                  <div className="flex items-center justify-between rounded-lg border border-[#1b3a2c] bg-[#071e16] px-3 py-2 text-xs">
                    <span className="text-[#f6f3ed]/80">
                      Code sent to <span className="font-mono font-semibold text-[#c8a24f]">{phone}</span>
                    </span>
                    <button
                      type="button"
                      onClick={() => setOtpStep("phone")}
                      className="text-xs font-medium text-[#c8a24f] hover:underline"
                    >
                      Change
                    </button>
                  </div>
                  <div className="space-y-1.5">
                    <Label htmlFor="otp-code" className="text-xs text-[#f6f3ed]/80">
                      6-digit verification code
                    </Label>
                    <Input
                      id="otp-code"
                      inputMode="numeric"
                      autoComplete="one-time-code"
                      placeholder="6-digit code"
                      maxLength={6}
                      autoFocus
                      className="font-mono tracking-[0.35em] border-[#1b3a2c] bg-[#071e16] text-[#f6f3ed] focus:border-[#c8a24f]"
                      value={code}
                      onChange={(e) =>
                        setCode(e.target.value.replace(/\D/g, "").slice(0, 6))
                      }
                      required
                    />
                  </div>
                  <Button
                    type="submit"
                    className="w-full bg-[#c8a24f] text-[#071e16] font-semibold hover:bg-[#b8903c]"
                    disabled={verifyOtp.isPending}
                  >
                    {verifyOtp.isPending ? (
                      <>
                        <Loader2 className="h-4 w-4 animate-spin mr-2" /> Verifying…
                      </>
                    ) : (
                      "Verify & Sign In"
                    )}
                  </Button>
                  <p className="text-center text-xs text-[#f6f3ed]/60">
                    Didn&apos;t receive it?{" "}
                    <button
                      type="button"
                      onClick={sendCode}
                      disabled={resendIn > 0 || requestOtp.isPending}
                      className="font-medium text-[#c8a24f] hover:underline disabled:opacity-50"
                    >
                      {resendIn > 0 ? `Resend in ${resendIn}s` : "Resend code"}
                    </button>
                  </p>
                </form>
              )
            ) : (
              /* Password Login Form */
              <form onSubmit={onSubmitPassword} className="space-y-4">
                <div className="space-y-1.5">
                  <Label htmlFor="email" className="text-xs text-[#f6f3ed]/80">Email address</Label>
                  <Input
                    id="email"
                    type="email"
                    autoComplete="username"
                    className="border-[#1b3a2c] bg-[#071e16] text-[#f6f3ed] focus:border-[#c8a24f]"
                    value={email}
                    onChange={(e) => setEmail(e.target.value)}
                    required
                  />
                </div>
                <div className="space-y-1.5">
                  <Label htmlFor="password" className="text-xs text-[#f6f3ed]/80">Password</Label>
                  <Input
                    id="password"
                    type="password"
                    autoComplete="current-password"
                    className="border-[#1b3a2c] bg-[#071e16] text-[#f6f3ed] focus:border-[#c8a24f]"
                    value={password}
                    onChange={(e) => setPassword(e.target.value)}
                    required
                  />
                </div>
                <Button
                  type="submit"
                  className="w-full bg-[#c8a24f] text-[#071e16] font-semibold hover:bg-[#b8903c]"
                  disabled={login.isPending}
                >
                  {login.isPending ? (
                    <>
                      <Loader2 className="h-4 w-4 animate-spin mr-2" /> Authenticating…
                    </>
                  ) : (
                    "Sign In"
                  )}
                </Button>
              </form>
            )}
          </div>

          <InstallAppButton label="Install App on Phone" className="mt-4 w-full" />
        </div>
      </main>
    </div>
  );
}
