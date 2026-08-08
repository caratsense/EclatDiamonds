"use client";

import * as React from "react";
import Image from "next/image";
import { useRouter } from "next/navigation";
import {
  ArrowRight,
  ArrowLeft,
  Eye,
  EyeOff,
  Loader2,
  MailCheck,
  ShieldCheck,
  Sparkles,
  Store,
  UserPlus,
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
import {
  useLogin,
  useGoogleLogin,
  useSignup,
  useSignupStores,
} from "@/lib/queries/auth";
import { useSession } from "@/store/use-session";
import type { Role } from "@/lib/types";

function apiMessage(err: unknown, fallback: string): string {
  const message = (err as AxiosError<{ message?: string | string[] }>)
    ?.response?.data?.message;
  if (Array.isArray(message)) return message[0] ?? fallback;
  return typeof message === "string" && message ? message : fallback;
}

const SIGNUP_ROLES: { value: Role; label: string; hint: string }[] = [
  {
    value: "salesperson",
    label: "Salesperson",
    hint: "Join an existing store. Your store manager approves you.",
  },
  {
    value: "store_manager",
    label: "Store Manager",
    hint: "Run a store. Head office approves you.",
  },
];

const inputCls =
  "w-full rounded-md border border-[#1b3a2c] bg-[#071e16] px-3 py-2 text-sm text-[#f6f3ed] placeholder:text-[#f6f3ed]/30 focus:border-[#c8a24f] focus:outline-none focus:ring-1 focus:ring-[#c8a24f]";

/**
 * Self-registration card. Creates a PENDING request (never a live session): the
 * applicant picks a store + the role they are asking for, and on submit sees a
 * "waiting for approval" screen. Head office approves store/area managers; a
 * store/area manager approves salespeople in their store. The backend grants no
 * access until then.
 */
function SignupCard({ onBackToSignin }: { onBackToSignin: () => void }) {
  const signup = useSignup();
  const storesQuery = useSignupStores();
  const stores = storesQuery.data ?? [];

  const [name, setName] = React.useState("");
  const [email, setEmail] = React.useState("");
  const [password, setPassword] = React.useState("");
  const [phone, setPhone] = React.useState("");
  const [requestedRole, setRequestedRole] = React.useState<Role>("salesperson");
  const [requestedStoreId, setRequestedStoreId] = React.useState("");
  const [done, setDone] = React.useState<
    { message: string; loginEmail: string } | null
  >(null);
  const [showPw, setShowPw] = React.useState(false);

  const roleHint = SIGNUP_ROLES.find((r) => r.value === requestedRole)?.hint;

  function submit(e: React.FormEvent) {
    e.preventDefault();
    if (name.trim().length < 2) return toast.error("Enter your full name.");
    if (email && !/^\S+@\S+\.\S+$/.test(email))
      return toast.error("That email doesn't look right (or leave it blank).");
    if (password.length < 8)
      return toast.error("Password must be at least 8 characters.");
    if (!requestedStoreId) return toast.error("Choose your store.");

    signup.mutate(
      {
        name: name.trim(),
        email: email.trim(),
        password,
        phone: phone.trim() || undefined,
        requestedRole: requestedRole as
          | "salesperson"
          | "store_manager"
          | "area_manager",
        requestedStoreId,
      },
      {
        onSuccess: (res) =>
          setDone({ message: res.message, loginEmail: res.loginEmail }),
        onError: (err) =>
          toast.error(apiMessage(err, "Couldn't create your account. Try again.")),
      },
    );
  }

  if (done) {
    return (
      <div className="rounded-2xl border border-[#c8a24f]/40 bg-[#0c261c]/80 p-6 text-center shadow-xl">
        <div className="mx-auto mb-3 flex h-12 w-12 items-center justify-center rounded-full bg-[#c8a24f]/15 text-[#c8a24f]">
          <MailCheck className="h-6 w-6" />
        </div>
        <h3 className="text-lg font-semibold text-[#f6f3ed]">Request sent</h3>
        <p className="mt-2 text-sm text-[#f6f3ed]/75">{done.message}</p>
        <div className="mt-4 rounded-lg border border-[#1b3a2c] bg-[#071e16] p-3 text-left">
          <p className="text-[11px] uppercase tracking-wider text-[#c8a24f]">
            Your sign-in email
          </p>
          <p className="mt-0.5 break-all font-mono text-sm text-[#f6f3ed]">
            {done.loginEmail}
          </p>
        </div>
        <p className="mt-3 text-xs text-[#f6f3ed]/50">
          Save this — you&apos;ll sign in with this email and your password once
          approved.
        </p>
        <Button
          type="button"
          onClick={onBackToSignin}
          className="mt-5 w-full bg-[#c8a24f] text-[#071e16] font-semibold hover:bg-[#b8903c]"
        >
          Back to sign in
        </Button>
      </div>
    );
  }

  return (
    <form
      onSubmit={submit}
      className="space-y-3.5 rounded-2xl border border-[#1b3a2c] bg-[#0c261c]/80 p-5 shadow-xl"
    >
      <div className="space-y-1.5">
        <Label className="text-xs text-[#f6f3ed]/80">Full name</Label>
        <input
          className={inputCls}
          value={name}
          onChange={(e) => setName(e.target.value)}
          placeholder="e.g. Aarav Shah"
          required
        />
      </div>
      <div className="space-y-1.5">
        <Label className="text-xs text-[#f6f3ed]/80">
          Personal email <span className="text-[#f6f3ed]/40">(optional)</span>
        </Label>
        <input
          type="email"
          autoComplete="email"
          className={inputCls}
          value={email}
          onChange={(e) => setEmail(e.target.value)}
          placeholder="name@email.com"
        />
        <p className="text-[11px] text-[#f6f3ed]/45">
          For contact only. We create your unique sign-in email for you.
        </p>
      </div>
      <div className="grid grid-cols-2 gap-3">
        <div className="space-y-1.5">
          <Label className="text-xs text-[#f6f3ed]/80">Password</Label>
          <div className="relative">
            <input
              type={showPw ? "text" : "password"}
              autoComplete="new-password"
              className={`${inputCls} pr-10`}
              value={password}
              onChange={(e) => setPassword(e.target.value)}
              placeholder="8+ characters"
              required
            />
            <button
              type="button"
              onClick={() => setShowPw((s) => !s)}
              aria-label={showPw ? "Hide password" : "Show password"}
              tabIndex={-1}
              className="absolute right-2 top-1/2 -translate-y-1/2 text-[#f6f3ed]/50 transition-colors hover:text-[#f6f3ed]"
            >
              {showPw ? <EyeOff className="h-4 w-4" /> : <Eye className="h-4 w-4" />}
            </button>
          </div>
        </div>
        <div className="space-y-1.5">
          <Label className="text-xs text-[#f6f3ed]/80">Phone (optional)</Label>
          <input
            inputMode="numeric"
            className={inputCls}
            value={phone}
            onChange={(e) => setPhone(e.target.value.replace(/\D/g, "").slice(0, 10))}
            placeholder="10-digit mobile"
          />
        </div>
      </div>
      <div className="space-y-1.5">
        <Label className="text-xs text-[#f6f3ed]/80">I am a…</Label>
        <select
          className={inputCls}
          value={requestedRole}
          onChange={(e) => setRequestedRole(e.target.value as Role)}
        >
          {SIGNUP_ROLES.map((r) => (
            <option key={r.value} value={r.value} className="bg-[#071e16]">
              {r.label}
            </option>
          ))}
        </select>
        {roleHint ? (
          <p className="text-[11px] text-[#f6f3ed]/55">{roleHint}</p>
        ) : null}
      </div>
      <div className="space-y-1.5">
        <Label className="text-xs text-[#f6f3ed]/80">Store</Label>
        <select
          className={inputCls}
          value={requestedStoreId}
          onChange={(e) => setRequestedStoreId(e.target.value)}
          required
        >
          <option value="" className="bg-[#071e16]">
            {storesQuery.isLoading ? "Loading stores…" : "Select your store"}
          </option>
          {stores.map((s) => (
            <option key={s.id} value={s.id} className="bg-[#071e16]">
              {s.name}
              {s.city ? ` — ${s.city}` : ""}
            </option>
          ))}
        </select>
      </div>
      <Button
        type="submit"
        className="w-full bg-[#c8a24f] text-[#071e16] font-semibold hover:bg-[#b8903c]"
        disabled={signup.isPending}
      >
        {signup.isPending ? (
          <>
            <Loader2 className="h-4 w-4 animate-spin mr-2" /> Sending request…
          </>
        ) : (
          <>
            Create account <ArrowRight className="h-4 w-4 ml-1" />
          </>
        )}
      </Button>
    </form>
  );
}

export default function LoginPage() {
  const router = useRouter();
  const hydrate = useSession((s) => s.hydrate);
  const login = useLogin();
  const googleLogin = useGoogleLogin();

  const [email, setEmail] = React.useState("");
  const [password, setPassword] = React.useState("");
  const [showPassword, setShowPassword] = React.useState(false);
  const [mode, setMode] = React.useState<"signin" | "signup">("signin");

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
            sizes="(min-width: 1024px) 55vw, 0px"
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
              {mode === "signup" ? "Create your account" : "Sign in to your counter"}
            </h2>
            <p className="mt-1.5 text-sm text-[#f6f3ed]/70">
              {mode === "signup"
                ? "Register and request access. A manager or head office will approve you."
                : "Enter your email and password to start the session."}
            </p>
          </div>

          {mode === "signin" ? (
          <>
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
                  <div className="relative">
                    <Input
                      id="password"
                      type={showPassword ? "text" : "password"}
                      autoComplete="current-password"
                      className="border-[#1b3a2c] bg-[#071e16] pr-10 text-[#f6f3ed] focus:border-[#c8a24f]"
                      value={password}
                      onChange={(e) => setPassword(e.target.value)}
                      required
                    />
                    <button
                      type="button"
                      onClick={() => setShowPassword((s) => !s)}
                      aria-label={showPassword ? "Hide password" : "Show password"}
                      tabIndex={-1}
                      className="absolute right-2 top-1/2 -translate-y-1/2 text-[#f6f3ed]/50 transition-colors hover:text-[#f6f3ed]"
                    >
                      {showPassword ? (
                        <EyeOff className="h-4 w-4" />
                      ) : (
                        <Eye className="h-4 w-4" />
                      )}
                    </button>
                  </div>
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
          </div>

          </>
          ) : (
            <SignupCard onBackToSignin={() => setMode("signin")} />
          )}

          {/* Sign in ⇄ Create account toggle */}
          <button
            type="button"
            onClick={() => setMode((m) => (m === "signin" ? "signup" : "signin"))}
            className="flex w-full items-center justify-center gap-1.5 text-sm text-[#f6f3ed]/70 transition-colors hover:text-[#c8a24f]"
          >
            {mode === "signin" ? (
              <>
                <UserPlus className="h-3.5 w-3.5" /> New here? Create an account
              </>
            ) : (
              <>
                <ArrowLeft className="h-3.5 w-3.5" /> Already have an account? Sign in
              </>
            )}
          </button>

          <InstallAppButton
            label="Install App on Phone"
            variant="ghost"
            className="mt-2 w-full border border-[#1b3a2c] text-[#f6f3ed]/70 hover:bg-[#0c261c] hover:text-[#f6f3ed]"
          />
        </div>
      </main>
    </div>
  );
}
