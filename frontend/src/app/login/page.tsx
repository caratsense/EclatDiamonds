"use client";

import * as React from "react";
import { useRouter, useSearchParams } from "next/navigation";
import {
  ArrowRight,
  ArrowLeft,
  Bot,
  Building2,
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
import { GoogleButtonShell } from "@/components/auth/google-button-shell";
import { InstallAppButton } from "@/components/pwa/install-app-button";
import { homeForRole } from "@/lib/navigation";
import { clearAttendanceHandled } from "@/lib/attendance-gate";
import {
  useLogin,
  useGoogleLogin,
  useCreateOrganisation,
  usePublicIndustries,
  useSignup,
  useSignupStores,
  type AuthMeResponse,
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
 * Organisation slugs, as the server mints them: lowercase, alphanumeric, single
 * hyphens between segments, no leading or trailing hyphen. "eclat" and
 * "sunrise-clinic-3ebcb7d2" are both real examples.
 */
const ORG_SLUG_PATTERN = /^[a-z0-9](?:[a-z0-9-]{0,62}[a-z0-9])?$/;

/**
 * Trim and lowercase, and nothing else.
 *
 * Deliberately non-destructive: a code with a space or a slash in it is left
 * visibly wrong rather than silently rewritten into a different tenant's slug.
 * Turning "Sunrise Clinic" into "sunrise-clinic" would be a guess, and a guess
 * that happened to hit an existing organisation would show a stranger's
 * branches.
 */
export function normaliseOrgSlug(raw: string | null | undefined): string {
  return (raw ?? "").trim().toLowerCase();
}

/** Could this string name a real organisation? Two characters minimum. */
export function isUsableOrgSlug(raw: string | null | undefined): boolean {
  const slug = normaliseOrgSlug(raw);
  return slug.length >= 2 && ORG_SLUG_PATTERN.test(slug);
}

/**
 * The organisation this deployment is for, or "" — never a hardcoded tenant.
 *
 * The signup form used to open on `NEXT_PUBLIC_DEFAULT_ORG_SLUG ?? "eclat"`, so
 * a clinic's new receptionist, on a generic deployment with nothing configured,
 * was shown a jeweller's branch list and pointed at their organisation. The
 * fallback is gone: absent configuration now means an empty field and no
 * request, which is the honest state — the product does not know which tenant
 * this person belongs to, and asking is the only correct move.
 *
 * A single-tenant deployment can still pin itself by setting the variable, but
 * the value is validated first. A malformed one is ignored rather than sent to
 * the directory endpoint, because a build-time typo should degrade to "ask the
 * user", never to "query something arbitrary".
 *
 * Nothing here reads the hostname. Inferring a tenant from the URL would make
 * the answer depend on which domain someone happened to load, including
 * localhost and any domain later pointed at this app.
 */
export function configuredOrgSlug(
  raw: string | undefined = process.env.NEXT_PUBLIC_DEFAULT_ORG_SLUG,
): string {
  const slug = normaliseOrgSlug(raw);
  return isUsableOrgSlug(slug) ? slug : "";
}

/**
 * Self-registration card. Creates a PENDING request (never a live session): the
 * applicant picks a store + the role they are asking for, and on submit sees a
 * "waiting for approval" screen. Head office approves store/area managers; a
 * store/area manager approves salespeople in their store. The backend grants no
 * access until then.
 */
function SignupCard({ onBackToSignin }: { onBackToSignin: () => void }) {
  const signup = useSignup();
  const [organisationCode, setOrganisationCode] = React.useState(configuredOrgSlug());

  // The slug is normalised before it is used for anything, and the directory is
  // requested only once it could name a real tenant. Passing "" keeps the query
  // disabled, so an empty or half-typed code makes no request at all — there is
  // no tenant to guess at, and guessing is what this screen used to do.
  const slug = normaliseOrgSlug(organisationCode);
  const slugUsable = isUsableOrgSlug(slug);
  const storesQuery = useSignupStores(slugUsable ? slug : "");
  const stores = slugUsable ? storesQuery.data ?? [] : [];

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
    // Checked before the store, because with no usable code the store list was
    // never fetched and "Choose your store" would be the wrong thing to say.
    if (!slugUsable)
      return toast.error("Enter your organisation code — ask your administrator.");
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
        requestedRole: requestedRole as "salesperson" | "store_manager",
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
        <Label className="text-xs text-[#f6f3ed]/80">Organisation code</Label>
        <input
          className={inputCls}
          value={organisationCode}
          onChange={(e) => {
            setOrganisationCode(e.target.value);
            setRequestedStoreId("");
          }}
          placeholder="e.g. your-company"
          required
        />
        <p className="text-[11px] text-[#f6f3ed]/45">
          Ask your administrator for your organisation code.
        </p>
      </div>
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
        <Label className="text-xs text-[#f6f3ed]/80">Location / store</Label>
        <select
          className={inputCls}
          value={requestedStoreId}
          onChange={(e) => setRequestedStoreId(e.target.value)}
          required
        >
          <option value="" className="bg-[#071e16]">
            {!slugUsable
              ? "Enter your organisation code first"
              : storesQuery.isLoading
                ? "Loading stores…"
                : "Select your store"}
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

function OrganisationSignupCard({
  onCreated,
}: {
  onCreated: (session: AuthMeResponse) => void;
}) {
  const createOrganisation = useCreateOrganisation();
  const industriesQuery = usePublicIndustries();
  const industries = industriesQuery.data?.packs ?? [];

  const [organisationName, setOrganisationName] = React.useState("");
  /*
   * Starts EMPTY, and the empty option is what a fresh form shows.
   *
   * It used to default to "retail", which meant the commonest path through this
   * form was to never look at the question — a clinic could sign up and be
   * provisioned as a shop, then wonder why the product used the wrong words.
   * The industry decides this tenant's vocabulary, fields, pipeline and which
   * modules exist, so it is a decision the owner should make once, deliberately,
   * rather than a default they can miss.
   */
  const [industryCode, setIndustryCode] = React.useState("");
  const [ownerName, setOwnerName] = React.useState("");
  const [email, setEmail] = React.useState("");
  const [password, setPassword] = React.useState("");
  const [phone, setPhone] = React.useState("");
  const [primaryLocationName, setPrimaryLocationName] =
    React.useState("Main location");
  const [city, setCity] = React.useState("");
  const [showPw, setShowPw] = React.useState(false);

  const selectedIndustry = industries.find(
    (industry) => industry.code === industryCode,
  );

  function submit(e: React.FormEvent) {
    e.preventDefault();
    if (organisationName.trim().length < 2)
      return toast.error("Enter your organisation name.");
    if (ownerName.trim().length < 2)
      return toast.error("Enter the owner's full name.");
    if (!/^\S+@\S+\.\S+$/.test(email))
      return toast.error("Enter a valid work email.");
    if (password.length < 8)
      return toast.error("Password must be at least 8 characters.");
    if (!industryCode)
      return toast.error("Choose your industry.", {
        description:
          "It sets the words, fields and workflow your team starts with. You can change it later.",
      });
    if (primaryLocationName.trim().length < 2 || city.trim().length < 2)
      return toast.error("Enter your first location and city.");

    createOrganisation.mutate(
      {
        organisationName: organisationName.trim(),
        industryCode,
        ownerName: ownerName.trim(),
        email: email.trim(),
        password,
        phone: phone.trim() || undefined,
        primaryLocationName: primaryLocationName.trim(),
        city: city.trim(),
      },
      {
        onSuccess: onCreated,
        onError: (err) =>
          toast.error(
            apiMessage(err, "Couldn't set up your organisation. Try again."),
          ),
      },
    );
  }

  return (
    <form
      onSubmit={submit}
      className="space-y-3.5 rounded-2xl border border-[#c8a24f]/35 bg-[#0c261c]/80 p-5 shadow-xl"
    >
      <div className="grid gap-3 sm:grid-cols-2">
        <div className="space-y-1.5">
          <Label className="text-xs text-[#f6f3ed]/80">
            Organisation name
          </Label>
          <input
            className={inputCls}
            value={organisationName}
            onChange={(e) => setOrganisationName(e.target.value)}
            placeholder="e.g. Acme Health"
            required
          />
        </div>
        <div className="space-y-1.5">
          <Label className="text-xs text-[#f6f3ed]/80">
            What industry do you cater to?
          </Label>
          <select
            className={inputCls}
            value={industryCode}
            onChange={(e) => setIndustryCode(e.target.value)}
            disabled={industriesQuery.isLoading}
            required
          >
            {/*
              An unselectable prompt, so "no answer" is visibly no answer rather
              than a plausible-looking industry the user never chose. The list
              itself is the server's — nothing here hardcodes a pack code, so
              adding or renaming a pack needs no frontend release.
            */}
            <option value="" disabled className="bg-[#071e16]">
              {industriesQuery.isLoading
                ? "Loading industries…"
                : industriesQuery.isError
                  ? "Could not load industries — retry in a moment"
                  : "Select your industry…"}
            </option>
            {industries.map((industry) => (
              <option
                key={industry.code}
                value={industry.code}
                className="bg-[#071e16]"
              >
                {industry.name}
              </option>
            ))}
          </select>
        </div>
      </div>

      {selectedIndustry ? (
        <div className="flex gap-2.5 rounded-lg border border-[#1b3a2c] bg-[#071e16]/70 p-3">
          <Bot className="mt-0.5 h-4 w-4 shrink-0 text-[#c8a24f]" />
          <div>
            <p className="text-xs font-medium text-[#f6f3ed]">
              Industry-ready CRM setup
            </p>
            <p className="mt-0.5 text-[11px] leading-relaxed text-[#f6f3ed]/55">
              {selectedIndustry.description}
            </p>
          </div>
        </div>
      ) : null}

      <div className="grid gap-3 sm:grid-cols-2">
        <div className="space-y-1.5">
          <Label className="text-xs text-[#f6f3ed]/80">Owner name</Label>
          <input
            className={inputCls}
            value={ownerName}
            onChange={(e) => setOwnerName(e.target.value)}
            placeholder="Full name"
            required
          />
        </div>
        <div className="space-y-1.5">
          <Label className="text-xs text-[#f6f3ed]/80">
            Work email / login
          </Label>
          <input
            type="email"
            autoComplete="email"
            className={inputCls}
            value={email}
            onChange={(e) => setEmail(e.target.value)}
            placeholder="owner@company.com"
            required
          />
        </div>
      </div>

      <div className="grid gap-3 sm:grid-cols-2">
        <div className="space-y-1.5">
          <Label className="text-xs text-[#f6f3ed]/80">Password</Label>
          <div className="relative">
            <input
              type={showPw ? "text" : "password"}
              autoComplete="new-password"
              className={inputCls + " pr-10"}
              value={password}
              onChange={(e) => setPassword(e.target.value)}
              placeholder="8+ characters"
              required
            />
            <button
              type="button"
              onClick={() => setShowPw((value) => !value)}
              aria-label={showPw ? "Hide password" : "Show password"}
              tabIndex={-1}
              className="absolute right-2 top-1/2 -translate-y-1/2 text-[#f6f3ed]/50 hover:text-[#f6f3ed]"
            >
              {showPw ? (
                <EyeOff className="h-4 w-4" />
              ) : (
                <Eye className="h-4 w-4" />
              )}
            </button>
          </div>
        </div>
        <div className="space-y-1.5">
          <Label className="text-xs text-[#f6f3ed]/80">
            Phone <span className="text-[#f6f3ed]/40">(optional)</span>
          </Label>
          <input
            type="tel"
            autoComplete="tel"
            className={inputCls}
            value={phone}
            onChange={(e) => setPhone(e.target.value.slice(0, 21))}
            placeholder="+91 98765 43210"
          />
        </div>
      </div>

      <div className="grid gap-3 sm:grid-cols-2">
        <div className="space-y-1.5">
          <Label className="text-xs text-[#f6f3ed]/80">
            First location
          </Label>
          <input
            className={inputCls}
            value={primaryLocationName}
            onChange={(e) => setPrimaryLocationName(e.target.value)}
            placeholder="Main location"
            required
          />
        </div>
        <div className="space-y-1.5">
          <Label className="text-xs text-[#f6f3ed]/80">City</Label>
          <input
            className={inputCls}
            value={city}
            onChange={(e) => setCity(e.target.value)}
            placeholder="e.g. Mumbai"
            required
          />
        </div>
      </div>

      <p className="text-[11px] leading-relaxed text-[#f6f3ed]/50">
        Omnichannel CRM, AI catalogue, attendance, imports and integrations are
        included. AI qualification and draft assistance start enabled; automatic
        sending stays off until you connect and approve a provider.
      </p>

      <Button
        type="submit"
        className="w-full bg-[#c8a24f] font-semibold text-[#071e16] hover:bg-[#b8903c]"
        disabled={createOrganisation.isPending || industriesQuery.isLoading}
      >
        {createOrganisation.isPending ? (
          <>
            <Loader2 className="mr-2 h-4 w-4 animate-spin" /> Setting up…
          </>
        ) : (
          <>
            Create organisation <ArrowRight className="ml-1 h-4 w-4" />
          </>
        )}
      </Button>
    </form>
  );
}

/**
 * The route entry.
 *
 * `useSearchParams()` opts a page out of static prerendering unless it sits
 * inside a Suspense boundary — this page IS prerendered, so without the wrapper
 * the build fails outright rather than degrading. The fallback is null because
 * the boundary resolves on the client immediately; there is no server fetch
 * behind it to wait on, and a spinner that flashes for one frame is worse than
 * nothing.
 */
export default function LoginRoute() {
  return (
    <React.Suspense fallback={null}>
      <LoginPage />
    </React.Suspense>
  );
}

function LoginPage() {
  const router = useRouter();
  const hydrate = useSession((s) => s.hydrate);
  const login = useLogin();
  const googleLogin = useGoogleLogin();

  const [email, setEmail] = React.useState("");
  const [password, setPassword] = React.useState("");
  const [showPassword, setShowPassword] = React.useState(false);
  /*
   * Where the visitor asked to start.
   *
   * The landing page has a "Create your organisation" button, and it used to
   * land here on the sign-IN tab — two hidden steps away from what it promised,
   * because this screen read no query string at all. `?start=create` opens on
   * the create-organisation form; anything else keeps the default.
   *
   * Read once, as the initial state, so the person can still switch tabs
   * afterwards without the URL yanking them back.
   */
  const startAt = useSearchParams().get("start");
  const [mode, setMode] = React.useState<"signin" | "signup">(
    startAt === "create" || startAt === "join" ? "signup" : "signin",
  );
  const [signupKind, setSignupKind] = React.useState<"join" | "organisation">(
    startAt === "create" ? "organisation" : "join",
  );

  function finishLogin(me: AuthMeResponse) {
    hydrate(me);
    toast.success(`Welcome, ${me.user.name}`);
    clearAttendanceHandled();
    router.replace(
      me.role === "salesperson"
        ? "/check-in"
        : homeForRole(me.role, me.productProfile?.enabledNavigation),
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
              ? "No account for this Google email."
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

  const creatingOrganisation =
    mode === "signup" && signupKind === "organisation";

  return (
    <div className="grid min-h-dvh bg-[#071e16] text-[#f6f3ed] lg:grid-cols-[1.1fr_1fr]">
      {/* ── Left Realistic Luxury Showroom Panel ───────────────────── */}
      <aside className="relative hidden flex-col justify-between overflow-hidden p-10 lg:flex xl:p-14">
        {/*
          A generated ground rather than a photograph. The panel used to carry a
          jewellery hero image, which quietly told a clinic, a mill and a
          school that this product was not for them. Two soft radial washes cost
          nothing to ship and belong to no industry.
        */}
        <div
          className="absolute inset-0 z-0"
          style={{
            backgroundImage:
              "radial-gradient(60rem 40rem at 15% 10%, rgba(200,162,79,0.16), transparent 60%)," +
              "radial-gradient(50rem 36rem at 85% 85%, rgba(16,120,86,0.22), transparent 62%)",
          }}
        />
        {/* Soft luxury emerald gradient overlay */}
        <div className="absolute inset-0 z-0 bg-gradient-to-b from-[#071e16]/80 via-[#071e16]/95 to-[#031a13]" />

        {/* Top Header */}
        <div className="relative z-10 flex items-center justify-between">
          {creatingOrganisation ? (
            <div className="flex items-center gap-2 text-[#c8a24f]">
              <div className="flex h-9 w-9 items-center justify-center rounded-xl border border-[#c8a24f]/40 bg-[#c8a24f]/10">
                <Bot className="h-5 w-5" />
              </div>
              <span className="font-display text-xl font-bold">CaratSense</span>
            </div>
          ) : (
            <Logo className="h-10 w-auto" />
          )}
          <span className="inline-flex items-center gap-2 rounded-full border border-[#c8a24f]/30 bg-[#c8a24f]/10 px-3.5 py-1 text-xs font-medium text-[#c8a24f]">
            <Sparkles className="h-3.5 w-3.5 text-[#c8a24f]" />
            {creatingOrganisation ? "Universal AI CRM" : "Omnichannel AI CRM"}
          </span>
        </div>

        {/* Middle Content & Live Glassmorphism Widgets */}
        <div className="relative z-10 my-auto max-w-lg space-y-7 py-8">
          <div>
            <span className="text-xs font-medium uppercase tracking-[0.2em] text-[#c8a24f]">
              {creatingOrganisation ? "Built for every industry" : "CaratSense"}
            </span>
            <h1 className="mt-2 font-display text-4xl font-bold leading-[1.1] text-[#f6f3ed] xl:text-5xl">
              {creatingOrganisation ? (
                <>
                  One AI CRM, shaped around{" "}
                  <span className="italic text-[#c8a24f]">your business.</span>
                </>
              ) : (
                <>
                  One place for{" "}
                  <span className="italic text-[#c8a24f]">every enquiry.</span>
                </>
              )}
            </h1>
            <p className="mt-4 text-base leading-relaxed text-[#f6f3ed]/75">
              {creatingOrganisation
                ? "Start with industry-specific fields and workflows, while omnichannel CRM, AI cataloguing, attendance and integrations stay at the core."
                : "Every enquiry, visit and follow-up your team handles, in one place — whichever channel it arrived on."}
            </p>
          </div>

          {/* Live Interactive Widgets */}
          <div className="grid gap-3.5">
            {/* Widget 1: Multi-Store Live Pulse */}
            <div className="flex items-center gap-3.5 rounded-2xl border border-[#1b3a2c] bg-[#0c261c]/80 p-4 shadow-lg backdrop-blur-md">
              <div className="relative flex h-10 w-10 shrink-0 items-center justify-center rounded-xl bg-[#c8a24f]/15 text-[#c8a24f]">
                {creatingOrganisation ? (
                  <Bot className="h-5 w-5" />
                ) : (
                  <Store className="h-5 w-5" />
                )}
                <span className="absolute -right-0.5 -top-0.5 flex h-3 w-3">
                  <span className="absolute inline-flex h-full w-full animate-ping rounded-full bg-emerald-400 opacity-75" />
                  <span className="relative inline-flex h-3 w-3 rounded-full bg-emerald-500" />
                </span>
              </div>
              <div className="flex-1">
                <div className="flex items-center justify-between">
                  <p className="text-sm font-semibold text-[#f6f3ed]">
                    {creatingOrganisation
                      ? "Industry-ready from signup"
                      : "Every branch, one view"}
                  </p>
                  <span className="text-[11px] font-mono text-emerald-400">
                    {creatingOrganisation ? "AI Ready" : "Multi-branch"}
                  </span>
                </div>
                <p className="mt-0.5 text-xs text-[#f6f3ed]/65">
                  {creatingOrganisation
                    ? "CRM · AI catalogue · attendance · integrations"
                    : "Leads · visits · follow-ups · attendance"}
                </p>
              </div>
            </div>

            {/* Widget 2: Security & Role Isolation */}
            <div className="flex items-center gap-3.5 rounded-2xl border border-[#1b3a2c] bg-[#0c261c]/80 p-4 shadow-lg backdrop-blur-md">
              <div className="flex h-10 w-10 shrink-0 items-center justify-center rounded-xl bg-[#c8a24f]/15 text-[#c8a24f]">
                <ShieldCheck className="h-5 w-5" />
              </div>
              <div className="flex-1">
                <p className="text-sm font-semibold text-[#f6f3ed]">
                  {creatingOrganisation
                    ? "Tenant-isolated from day one"
                    : "Role-Aware Security & Cost Protection"}
                </p>
                <p className="mt-0.5 text-xs text-[#f6f3ed]/65">
                  {creatingOrganisation
                    ? "Your data, users and connection credentials stay inside your organisation."
                    : "Each person sees their own branch and their own customers; cost and margin stay with the people who set them."}
                </p>
              </div>
            </div>
          </div>
        </div>

        {/* Bottom Footer */}
        <div className="relative z-10 flex items-center justify-between border-t border-[#1b3a2c] pt-5 text-xs text-[#f6f3ed]/50">
          {/*
            The name, and no version number. "v2.4" was typed here once and no
            process has updated it since — a release number on a public page
            that nothing increments is worse than no release number, because
            people quote it.
          */}
          <span className="font-mono uppercase tracking-[0.16em]">CaratSense OS</span>
          <span>
            {creatingOrganisation
              ? "Universal CRM · Isolated workspaces"
              : "© 2026 CaratSense. All rights reserved."}
          </span>
        </div>
      </aside>

      {/* ── Right Live Interactive Sign-in Form ─────────────────────── */}
      <main className="relative flex flex-col justify-between bg-[#071e16] px-6 py-10 sm:px-12 lg:px-16">
        <div className="mx-auto my-auto w-full max-w-xl space-y-7">
          {/* Mobile Logo */}
          <div className="mb-4 lg:hidden">
            {creatingOrganisation ? (
              <div className="flex items-center gap-2 text-[#c8a24f]">
                <Bot className="h-6 w-6" />
                <span className="font-display text-xl font-bold">CaratSense</span>
              </div>
            ) : (
              <Logo className="h-9 w-auto" />
            )}
          </div>

          <div>
            <h2 className="font-display text-3xl font-bold tracking-tight text-[#f6f3ed]">
              {mode === "signin"
                ? "Sign in to your workspace"
                : signupKind === "organisation"
                  ? "Set up your organisation"
                  : "Join your organisation"}
            </h2>
            <p className="mt-1.5 text-sm text-[#f6f3ed]/70">
              {mode === "signin"
                ? "Enter your email and password to start the session."
                : signupKind === "organisation"
                  ? "Choose your industry and start with the right CRM, fields and workflow."
                  : "Request access to an existing team. Your manager will approve you."}
            </p>
          </div>

          {mode === "signin" ? (
          <>
          {/*
            Google sign-in is always on the page, in one of its two real states.

            It used to be wrapped in a check for NEXT_PUBLIC_GOOGLE_CLIENT_ID,
            and the button itself ALSO returns null without one — so on a
            workspace where nobody had set the variable there was no button and
            no explanation, which reads as "this product has no Google sign-in"
            rather than "this workspace has not turned it on".

            Configured: the working Google control. Unconfigured: the same
            control, disabled, with the reason attached to it — which is the
            ordinary way an interface says "this exists and is not available
            to you". There is deliberately no third state where it appears to
            work: with no client id there is nothing to verify an identity
            against, and a button that signed someone in anyway would be an
            authentication hole wearing Google's logo.
          */}
          <div>
            {process.env.NEXT_PUBLIC_GOOGLE_CLIENT_ID ? (
              <GoogleSignInButton onCredential={onGoogle} />
            ) : (
              <GoogleButtonShell reason="Not set up for this workspace yet — use your email and password below." />
            )}
            <div className="mt-4 flex items-center gap-3 text-xs text-[#f6f3ed]/40">
              <div className="h-px flex-1 bg-[#1b3a2c]" />
              or continue with credentials
              <div className="h-px flex-1 bg-[#1b3a2c]" />
            </div>
          </div>

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
            <div className="space-y-3.5">
              <div className="grid grid-cols-2 gap-2 rounded-xl border border-[#1b3a2c] bg-[#061a13] p-1.5">
                <button
                  type="button"
                  onClick={() => setSignupKind("join")}
                  className={
                    "flex items-center justify-center gap-2 rounded-lg px-3 py-2 text-xs font-medium transition-colors " +
                    (signupKind === "join"
                      ? "bg-[#c8a24f] text-[#071e16]"
                      : "text-[#f6f3ed]/65 hover:bg-white/5")
                  }
                >
                  <UserPlus className="h-3.5 w-3.5" /> Join a team
                </button>
                <button
                  type="button"
                  onClick={() => setSignupKind("organisation")}
                  className={
                    "flex items-center justify-center gap-2 rounded-lg px-3 py-2 text-xs font-medium transition-colors " +
                    (signupKind === "organisation"
                      ? "bg-[#c8a24f] text-[#071e16]"
                      : "text-[#f6f3ed]/65 hover:bg-white/5")
                  }
                >
                  <Building2 className="h-3.5 w-3.5" /> Create organisation
                </button>
              </div>
              {signupKind === "organisation" ? (
                <OrganisationSignupCard onCreated={finishLogin} />
              ) : (
                <SignupCard onBackToSignin={() => setMode("signin")} />
              )}
            </div>
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
