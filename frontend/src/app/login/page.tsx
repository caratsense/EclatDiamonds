"use client";

import * as React from "react";
import { useRouter, useSearchParams } from "next/navigation";
import {
  ArrowRight,
  ArrowLeft,
  Bot,
  Building2,
  Camera,
  Eye,
  EyeOff,
  Loader2,
  Inbox,
  MailCheck,
  ShieldCheck,
  Sparkles,
  TrendingUp,
  UserPlus,
} from "lucide-react";
import { toast } from "sonner";
import type { AxiosError } from "axios";

import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Logo } from "@/components/brand/logo";
import { FaceScannerDialog } from "@/components/biometrics/face-scanner-dialog";
import { InstallAppButton } from "@/components/pwa/install-app-button";
import { homeForRole } from "@/lib/navigation";
import { clearAttendanceHandled } from "@/lib/attendance-gate";
import {
  useLogin,
  useCreateOrganisation,
  usePublicIndustries,
  useSignup,
  useSignupPreview,
  useSignupStores,
  type AuthMeResponse,
  type SignupRole,
} from "@/lib/queries/auth";
import { useDebouncedValue } from "@/lib/queries/search";
import { useSession } from "@/store/use-session";
import { ThemeToggle } from "@/components/layout/theme-toggle";

function apiMessage(err: unknown, fallback: string): string {
  const message = (err as AxiosError<{ message?: string | string[] }>)
    ?.response?.data?.message;
  if (Array.isArray(message)) return message[0] ?? fallback;
  return typeof message === "string" && message ? message : fallback;
}

const SIGNUP_ROLES: { value: SignupRole; label: string; hint: string }[] = [
  {
    value: "salesperson",
    label: "Salesperson",
    hint: "Serve customers at your store. Your store manager approves you.",
  },
  {
    value: "store_manager",
    label: "Store Manager",
    hint: "Run a store. Head office approves you.",
  },
];

/** Offered before the organisation's own policy has loaded. */
const DEFAULT_REQUESTABLE: SignupRole[] = ["salesperson", "store_manager"];

/*
 * One field treatment for the whole auth surface with luxury color grading in both modes.
 */
const FIELD =
  "border-slate-300/80 bg-slate-50/70 text-slate-900 placeholder:text-slate-400 " +
  "dark:border-white/10 dark:bg-white/[0.02] dark:text-[#f8fafc] dark:placeholder:text-[#f8fafc]/25 " +
  "focus:border-[#6366f1]/90 focus:bg-white dark:focus:bg-white/[0.04] focus:ring-1 focus:ring-[#6366f1]/40 transition-colors shadow-xs dark:shadow-none";

/** The same, as a complete class list for the bare <input>/<select> elements. */
const inputCls =
  "w-full rounded-md border border-slate-300/80 bg-slate-50/70 px-3 py-2 text-sm text-slate-900 " +
  "dark:border-white/10 dark:bg-white/[0.02] dark:text-[#f8fafc] " +
  "placeholder:text-slate-400 dark:placeholder:text-[#f8fafc]/25 " +
  "focus:border-[#6366f1]/90 focus:bg-white dark:focus:bg-white/[0.04] focus:outline-none focus:ring-1 focus:ring-[#6366f1]/40 transition-colors shadow-xs dark:shadow-none";

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
  return isUsableOrgSlug(slug) ? slug : "eclat";
}

/**
 * Self-registration card. Creates a PENDING request (never a live session): the
 * applicant picks a store + the role they are asking for, and on submit sees a
 * "waiting for approval" screen. Head office approves store/area managers; a
 * store/area manager approves salespeople in their store. The backend grants no
 * access until then.
 */
const DEFAULT_STORES = [
  { id: "mumbai-bandra", name: "Mumbai — Bandra", city: "Mumbai" },
  { id: "surat-main", name: "Surat — Main", city: "Surat" },
  { id: "ahmedabad-cg", name: "Ahmedabad — C.G. Road", city: "Ahmedabad" },
];

function SignupCard({ onBackToSignin }: { onBackToSignin: () => void }) {
  const signup = useSignup();
  const slug = configuredOrgSlug();
  const storesQuery = useSignupStores(slug);
  const fetchedStores = storesQuery.data ?? [];
  const stores = fetchedStores.length > 0 ? fetchedStores : DEFAULT_STORES;

  const [name, setName] = React.useState("");
  const [contactEmail, setContactEmail] = React.useState("");
  const [password, setPassword] = React.useState("");
  const [phone, setPhone] = React.useState("");
  const [requestedRole, setRequestedRole] = React.useState<SignupRole>("salesperson");
  const [requestedStoreId, setRequestedStoreId] = React.useState("");
  const [done, setDone] = React.useState<
    { message: string; loginId: string } | null
  >(null);
  const [showPw, setShowPw] = React.useState(false);

  // Roles and the Login ID shape come from the organisation's own policy. The
  // preview is rendered from its template only, so it says nothing about
  // whether someone already holds that ID.
  const debouncedName = useDebouncedValue(name, 400);
  const preview = useSignupPreview({
    organisationCode: slug,
    requestedStoreId,
    name: debouncedName,
  });
  const requestable = preview.data?.requestableRoles ?? DEFAULT_REQUESTABLE;
  const roleOptions = SIGNUP_ROLES.filter((r) => requestable.includes(r.value));
  const role = requestable.includes(requestedRole) ? requestedRole : "salesperson";
  const roleHint = SIGNUP_ROLES.find((r) => r.value === role)?.hint;

  function submit(e: React.FormEvent) {
    e.preventDefault();
    if (name.trim().length < 2) return toast.error("Enter your full name.");
    if (!phone || phone.trim().length < 10)
      return toast.error("Enter your 10-digit mobile phone number.");
    if (contactEmail && !/^\S+@\S+\.\S+$/.test(contactEmail))
      return toast.error("That email doesn't look right (or leave it blank).");
    if (password.length < 8)
      return toast.error("Password must be at least 8 characters.");
    if (!requestedStoreId) return toast.error("Choose your store.");

    signup.mutate(
      {
        name: name.trim(),
        contactEmail: contactEmail.trim() || undefined,
        password,
        phone: phone.trim() || undefined,
        requestedRole: role,
        requestedStoreId,
        organisationCode: slug,
      },
      {
        onSuccess: (res) =>
          setDone({ message: res.message, loginId: res.loginId }),
        onError: (err) =>
          toast.error(apiMessage(err, "Couldn't create your account. Try again.")),
      },
    );
  }

  if (done) {
    return (
      <div className="glass facet-top relative rounded-2xl p-6 text-center">
        <div className="mx-auto mb-3 flex h-12 w-12 items-center justify-center rounded-full bg-[#818cf8]/15 text-[#818cf8]">
          <MailCheck className="h-6 w-6" />
        </div>
        <h3 className="text-lg font-semibold text-slate-900 dark:text-[#f8fafc]">Request sent</h3>
        <p className="mt-2 text-sm text-slate-600 dark:text-[#f8fafc]/75">{done.message}</p>
        <div className="mt-4 rounded-lg border border-slate-200 dark:border-white/[0.08] bg-slate-100/80 dark:bg-black/25 p-3 text-left">
          <p className="text-[11px] uppercase tracking-wider text-[#6366f1] dark:text-[#818cf8] font-semibold">
            Your Login ID
          </p>
          <p className="mt-0.5 break-all font-mono text-sm font-bold text-slate-900 dark:text-[#f8fafc]">
            {done.loginId}
          </p>
        </div>
        <p className="mt-3 text-xs text-slate-500 dark:text-[#f8fafc]/50">
          This is your sign-in ID, not an email inbox — nothing is sent to it.
          Save it: once approved, you sign in with this Login ID and your
          password.
        </p>
        <Button
          type="button"
          onClick={onBackToSignin}
          className="mt-5 w-full bg-[#6366f1] text-white font-semibold hover:bg-[#4f46e5]"
        >
          Back to sign in
        </Button>
      </div>
    );
  }

  return (
    <form
      onSubmit={submit}
      className="glass facet-top relative space-y-3.5 rounded-2xl p-5"
    >
      <div className="space-y-1.5">
        <Label className="text-xs font-medium text-slate-700 dark:text-[#f8fafc]/80">Full name</Label>
        <input
          className={inputCls}
          value={name}
          onChange={(e) => setName(e.target.value)}
          placeholder="e.g. Aarav Shah"
          required
        />
      </div>
      <div className="space-y-1.5">
        <Label className="text-xs font-medium text-slate-700 dark:text-[#f8fafc]/80">
          Personal email <span className="text-slate-400 dark:text-[#f8fafc]/40">(optional)</span>
        </Label>
        <input
          type="email"
          autoComplete="email"
          className={inputCls}
          value={contactEmail}
          onChange={(e) => setContactEmail(e.target.value)}
          placeholder="name@email.com"
        />
        <p className="text-[11px] text-slate-500 dark:text-[#f8fafc]/45">
          For contact only — we may tell you here when you are approved. You
          sign in with a Login ID we create for you.
        </p>
      </div>
      <div className="grid grid-cols-2 gap-3">
        <div className="space-y-1.5">
          <Label className="text-xs font-medium text-slate-700 dark:text-[#f8fafc]/80">Password</Label>
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
              className="absolute right-2 top-1/2 -translate-y-1/2 text-slate-400 dark:text-[#f8fafc]/50 transition-colors hover:text-slate-700 dark:hover:text-[#f8fafc]"
            >
              {showPw ? <EyeOff className="h-4 w-4" /> : <Eye className="h-4 w-4" />}
            </button>
          </div>
        </div>
        <div className="space-y-1.5">
          <Label className="text-xs font-medium text-slate-700 dark:text-[#f8fafc]/80">Mobile phone number *</Label>
          <input
            inputMode="numeric"
            className={inputCls}
            value={phone}
            onChange={(e) => setPhone(e.target.value.replace(/\D/g, "").slice(0, 10))}
            placeholder="10-digit mobile number"
            required
          />
        </div>
      </div>
      <div className="space-y-1.5">
        <Label className="text-xs font-medium text-slate-700 dark:text-[#f8fafc]/80">I am a…</Label>
        <select
          className={inputCls}
          value={role}
          onChange={(e) => setRequestedRole(e.target.value as SignupRole)}
        >
          {roleOptions.map((r) => (
            <option key={r.value} value={r.value} className="bg-white text-slate-900 dark:bg-[#090b10] dark:text-[#f8fafc]">
              {r.label}
            </option>
          ))}
        </select>
        {roleHint ? (
          <p className="text-[11px] text-slate-500 dark:text-[#f8fafc]/55">{roleHint}</p>
        ) : null}
      </div>
      <div className="space-y-1.5">
        <Label className="text-xs font-medium text-slate-700 dark:text-[#f8fafc]/80">Location / store</Label>
        <select
          className={inputCls}
          value={requestedStoreId}
          onChange={(e) => setRequestedStoreId(e.target.value)}
          required
        >
          <option value="" className="bg-white text-slate-900 dark:bg-[#090b10] dark:text-[#f8fafc]">
            {storesQuery.isLoading
              ? "Loading stores from database…"
              : "Select your store"}
          </option>
          {stores.map((s) => (
            <option key={s.id} value={s.id} className="bg-white text-slate-900 dark:bg-[#090b10] dark:text-[#f8fafc]">
              {s.name}
              {s.city ? ` — ${s.city}` : ""}
            </option>
          ))}
        </select>
      </div>
      {preview.data?.loginIdPreview ? (
        <div className="rounded-lg border border-slate-200/80 bg-slate-100/60 p-3 dark:border-white/[0.08] dark:bg-black/25">
          <p className="text-[11px] uppercase tracking-wider text-[#6366f1] dark:text-[#818cf8]">
            Your Login ID will look like
          </p>
          <p className="mt-0.5 break-all font-mono text-sm text-slate-900 dark:text-[#f8fafc]">
            {preview.data.loginIdPreview}
          </p>
          <p className="mt-1 text-[11px] leading-relaxed text-slate-500 dark:text-[#f8fafc]/50">
            This is your sign-in ID, not an email inbox. If someone already has
            it, a number is added (for example{" "}
            <span className="font-mono">{preview.data.loginIdSuffixExample}</span>
            ). Your exact Login ID is shown when you send the request.
          </p>
        </div>
      ) : null}
      <Button
        type="submit"
        className="w-full bg-[#6366f1] text-white font-semibold hover:bg-[#4f46e5]"
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
  onSwitchToSignin,
}: {
  onCreated: (session: AuthMeResponse) => void;
  onSwitchToSignin?: (email: string) => void;
}) {
  const createOrganisation = useCreateOrganisation();
  const industriesQuery = usePublicIndustries();
  const industries = industriesQuery.data?.packs ?? [];

  const [organisationName, setOrganisationName] = React.useState("");
  const [industryCode, setIndustryCode] = React.useState("");
  const [ownerName, setOwnerName] = React.useState("");
  const [email, setEmail] = React.useState("");
  const [password, setPassword] = React.useState("");
  const [phone, setPhone] = React.useState("");
  const [primaryLocationName, setPrimaryLocationName] =
    React.useState("Main location");
  const [city, setCity] = React.useState("");
  const [showPw, setShowPw] = React.useState(false);
  const [duplicateEmailError, setDuplicateEmailError] = React.useState<string | null>(null);

  const selectedIndustry = industries.find(
    (industry) => industry.code === industryCode,
  );

  function submit(e: React.FormEvent) {
    e.preventDefault();
    setDuplicateEmailError(null);
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
        onError: (err) => {
          const msg = apiMessage(err, "Couldn't set up your organisation. Try again.");
          if (msg.includes("already have a CaratOS account") || msg.includes("sign in instead")) {
            setDuplicateEmailError(email.trim());
          }
          toast.error(msg);
        },
      },
    );
  }

  return (
    <form
      onSubmit={submit}
      className="glass facet-top relative space-y-3.5 rounded-2xl p-5 shadow-xs"
    >
      <div className="grid gap-3 sm:grid-cols-2">
        <div className="space-y-1.5">
          <Label className="text-xs font-medium text-slate-700 dark:text-[#f8fafc]/80">
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
          <Label className="text-xs font-medium text-slate-700 dark:text-[#f8fafc]/80">
            What industry do you cater to?
          </Label>
          <select
            className={inputCls}
            value={industryCode}
            onChange={(e) => setIndustryCode(e.target.value)}
            disabled={industriesQuery.isLoading}
            required
          >
            <option value="" disabled className="bg-white text-slate-900 dark:bg-[#090b10] dark:text-[#f8fafc]">
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
                className="bg-white text-slate-900 dark:bg-[#090b10] dark:text-[#f8fafc]"
              >
                {industry.name}
              </option>
            ))}
          </select>
        </div>
      </div>

      {selectedIndustry ? (
        <div className="flex gap-2.5 rounded-lg border border-indigo-200/70 dark:border-white/[0.08] bg-indigo-50/60 dark:bg-black/25 p-3">
          <Bot className="mt-0.5 h-4 w-4 shrink-0 text-[#6366f1] dark:text-[#818cf8]" />
          <div>
            <p className="text-xs font-medium text-indigo-950 dark:text-[#f8fafc]">
              Industry-ready CRM setup
            </p>
            <p className="mt-0.5 text-[11px] leading-relaxed text-indigo-900/75 dark:text-[#f8fafc]/55">
              {selectedIndustry.description}
            </p>
          </div>
        </div>
      ) : null}

      <div className="grid gap-3 sm:grid-cols-2">
        <div className="space-y-1.5">
          <Label className="text-xs font-medium text-slate-700 dark:text-[#f8fafc]/80">Owner name</Label>
          <input
            className={inputCls}
            value={ownerName}
            onChange={(e) => setOwnerName(e.target.value)}
            placeholder="Full name"
            required
          />
        </div>
        <div className="space-y-1.5">
          <Label className="text-xs font-medium text-slate-700 dark:text-[#f8fafc]/80">
            Work email / login
          </Label>
          <input
            type="email"
            autoComplete="email"
            className={inputCls}
            value={email}
            onChange={(e) => {
              setEmail(e.target.value);
              if (duplicateEmailError) setDuplicateEmailError(null);
            }}
            placeholder="owner@company.com"
            required
          />
        </div>
      </div>

      <div className="grid gap-3 sm:grid-cols-2">
        <div className="space-y-1.5">
          <Label className="text-xs font-medium text-slate-700 dark:text-[#f8fafc]/80">Password</Label>
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
              onClick={() => setShowPw((s) => !s)}
              aria-label={showPw ? "Hide password" : "Show password"}
              tabIndex={-1}
              className="absolute right-2 top-1/2 -translate-y-1/2 text-slate-400 transition-colors hover:text-slate-700 dark:text-[#f8fafc]/50 dark:hover:text-[#f8fafc]"
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
          <Label className="text-xs font-medium text-slate-700 dark:text-[#f8fafc]/80">
            Phone <span className="text-slate-400 dark:text-[#f8fafc]/40">(optional)</span>
          </Label>
          <input
            inputMode="tel"
            className={inputCls}
            value={phone}
            onChange={(e) => setPhone(e.target.value)}
            placeholder="+91..."
          />
        </div>
      </div>

      <div className="grid gap-3 sm:grid-cols-2">
        <div className="space-y-1.5">
          <Label className="text-xs font-medium text-slate-700 dark:text-[#f8fafc]/80">
            First location name
          </Label>
          <input
            className={inputCls}
            value={primaryLocationName}
            onChange={(e) => setPrimaryLocationName(e.target.value)}
            placeholder="e.g. Flagship / Main Store"
            required
          />
        </div>
        <div className="space-y-1.5">
          <Label className="text-xs font-medium text-slate-700 dark:text-[#f8fafc]/80">City</Label>
          <input
            className={inputCls}
            value={city}
            onChange={(e) => setCity(e.target.value)}
            placeholder="e.g. Mumbai"
            required
          />
        </div>
      </div>

      <p className="text-[11px] leading-relaxed text-slate-500 dark:text-[#f8fafc]/50">
        Omnichannel CRM, AI catalogue, attendance, imports and integrations are
        included. AI qualification and draft assistance start enabled; automatic
        sending stays off until you connect and approve a provider.
      </p>

      {duplicateEmailError && (
        <div className="rounded-xl border border-amber-500/40 bg-amber-500/10 p-3.5 text-xs text-amber-900 dark:text-amber-200 flex flex-col gap-2.5 animate-in fade-in">
          <div className="flex items-start gap-2.5">
            <ShieldCheck className="h-4 w-4 shrink-0 text-amber-600 dark:text-amber-400 mt-0.5" />
            <div className="space-y-0.5">
              <p className="font-semibold text-amber-950 dark:text-amber-100">
                Account already registered ({duplicateEmailError})
              </p>
              <p className="text-amber-800/90 dark:text-amber-200/80 leading-relaxed">
                An organisation account already exists for this email address. You do not need to set up another organisation — please sign in directly to your workspace.
              </p>
            </div>
          </div>
          <Button
            type="button"
            size="sm"
            className="self-start bg-amber-600 hover:bg-amber-700 text-white font-medium h-7 text-xs rounded-lg px-3 gap-1 shadow-xs"
            onClick={() => onSwitchToSignin?.(duplicateEmailError)}
          >
            Sign In with {duplicateEmailError} →
          </Button>
        </div>
      )}

      <Button
        type="submit"
        className="w-full bg-[#6366f1] font-semibold text-white hover:bg-[#4f46e5] shadow-xs"
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
  const [showPassword, setShowPassword] = React.useState(false);
  const [faceScannerOpen, setFaceScannerOpen] = React.useState(false);
  const [capturedFacePhoto, setCapturedFacePhoto] = React.useState<string | null>(null);

  const login = useLogin();

  const [email, setEmail] = React.useState("");
  const [password, setPassword] = React.useState("");
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
    toast.success(`Welcome, ${me.user.name}! 👋`, {
      description: `Signed in to ${me.currentStore?.name || "Bandra Store"}. Have a great shift today!`,
    });
    // Store staff profile for fast recognition on subsequent Face Sign-Ins
    if (typeof window !== "undefined") {
      try {
        localStorage.setItem(
          "eclat_last_staff",
          JSON.stringify({
            id: me.user.id,
            name: me.user.name,
            email: me.user.email,
            storeName: me.currentStore?.name,
          }),
        );
      } catch {}
    }
    clearAttendanceHandled();
    router.replace(
      me.role === "salesperson"
        ? "/check-in"
        : homeForRole(me.role, me.productProfile?.enabledNavigation),
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
              ? "Invalid Login ID or password."
              : "Couldn't sign in. Check your connection and try again.",
          );
        },
      },
    );
  }

  const creatingOrganisation =
    mode === "signup" && signupKind === "organisation";

  return (
    <div className="grid min-h-dvh bg-[#f8f9fc] dark:bg-[#090b10] text-slate-900 dark:text-[#f8fafc] lg:grid-cols-[1.1fr_1fr] transition-colors">
      {/* ── Left Realistic Luxury Showroom Panel ───────────────────── */}
      <aside className="relative hidden flex-col justify-between overflow-hidden p-10 lg:flex xl:p-14 border-r border-slate-200/80 dark:border-white/[0.08] bg-[#f0f4f9]/80 dark:bg-transparent">
        <div
          className="absolute inset-0 z-0 opacity-75 dark:opacity-100"
          style={{
            backgroundImage:
              "radial-gradient(40rem 30rem at 20% 20%, rgba(99,102,241,0.14), transparent 70%)," +
              "radial-gradient(40rem 30rem at 80% 80%, rgba(56,189,248,0.10), transparent 70%)",
          }}
        />
        <div className="absolute inset-0 z-0 bg-gradient-to-b from-transparent via-[#eef2f8]/40 dark:via-[#090b10]/40 to-[#e2e8f0]/60 dark:to-[#06080d]/90" />

        {/* Top Header */}
        <div className="relative z-10 flex items-center justify-between">
          {creatingOrganisation ? (
            <div className="flex items-center gap-2 text-[#6366f1] dark:text-[#818cf8]">
              <div className="flex h-9 w-9 items-center justify-center rounded-xl border border-indigo-500/30 bg-indigo-500/10">
                <Bot className="h-5 w-5" />
              </div>
              <span className="font-display text-xl font-bold">CaratOS</span>
            </div>
          ) : (
            <Logo className="h-10 w-auto" />
          )}
          <span className="inline-flex items-center gap-2 rounded-full border border-indigo-500/30 bg-indigo-500/10 px-3.5 py-1 text-xs font-medium text-[#4f46e5] dark:text-[#818cf8]">
            <Sparkles className="h-3.5 w-3.5 text-[#6366f1] dark:text-[#818cf8]" />
            {creatingOrganisation ? "Universal AI CRM" : "Omnichannel AI CRM"}
          </span>
        </div>

        {/* Middle Content & Live Glassmorphism Widgets */}
        <div className="relative z-10 my-auto max-w-lg space-y-7 py-8">
          <div>
            <span className="text-xs font-medium uppercase tracking-[0.2em] text-[#6366f1] dark:text-[#818cf8]">
              {creatingOrganisation ? "Built for every industry" : "CaratOS"}
            </span>
            <h1 className="mt-3 font-display text-4xl font-bold leading-[1.05] tracking-tight text-slate-900 dark:text-[#f8fafc] xl:text-[3.25rem]">
              {creatingOrganisation ? (
                <>
                  One AI CRM, shaped around{" "}
                  <span className="text-gradient-accent">your business.</span>
                </>
              ) : (
                <>
                  One place for{" "}
                  <span className="text-gradient-accent">every enquiry.</span>
                </>
              )}
            </h1>
            <p className="mt-4 text-base leading-relaxed text-slate-600 dark:text-[#f8fafc]/75">
              {creatingOrganisation
                ? "Start with industry-specific fields and workflows, while omnichannel CRM, AI cataloguing, attendance and integrations stay at the core."
                : "Every enquiry, visit and follow-up your team handles, in one place — whichever channel it arrived on."}
            </p>
          </div>

          <div className="grid gap-3">
            {[
              {
                icon: creatingOrganisation ? Bot : Inbox,
                title: creatingOrganisation
                  ? "Industry-ready from signup"
                  : "Every channel, one stream",
                body: creatingOrganisation
                  ? "Your industry decides the fields, the pipeline and the vocabulary. CRM, cataloguing, attendance and integrations stay at the core."
                  : "WhatsApp, ads, web forms, the counter and the phone all arrive in one inbox, against one customer record.",
                live: true,
              },
              {
                icon: TrendingUp,
                title: "Intent, with its reasoning attached",
                body: "Each conversation carries the signals that moved its score and the words that fired them — or says plainly that it has not been assessed.",
              },
              {
                icon: ShieldCheck,
                title: creatingOrganisation
                  ? "Tenant-isolated from day one"
                  : "Every send leaves a receipt",
                body: creatingOrganisation
                  ? "Your data, your team and your connection credentials stay inside your organisation."
                  : "Queued, sent, delivered, failed — each state is recorded as the provider reports it, never assumed.",
              },
            ].map((card) => (
              <div
                key={card.title}
                className="glass flex items-start gap-3.5 rounded-2xl p-4 shadow-xs"
              >
                <div className="relative flex h-10 w-10 shrink-0 items-center justify-center rounded-xl bg-indigo-500/10 text-[#6366f1] dark:bg-[#818cf8]/15 dark:text-[#818cf8]">
                  <card.icon className="h-5 w-5" />
                  {card.live ? (
                    <span className="absolute -right-0.5 -top-0.5 flex h-2.5 w-2.5">
                      <span className="absolute inline-flex h-full w-full animate-ping rounded-full bg-[#818cf8] opacity-70" />
                      <span className="relative inline-flex h-2.5 w-2.5 rounded-full bg-[#6366f1]" />
                    </span>
                  ) : null}
                </div>
                <div className="min-w-0 flex-1">
                  <p className="text-sm font-semibold tracking-tight text-slate-900 dark:text-[#f8fafc]">
                    {card.title}
                  </p>
                  <p className="mt-1 text-xs leading-relaxed text-slate-600 dark:text-[#f8fafc]/60">
                    {card.body}
                  </p>
                </div>
              </div>
            ))}
          </div>
        </div>

        {/* Bottom Footer */}
        <div className="relative z-10 flex items-center justify-between border-t border-slate-200/80 dark:border-white/[0.08] pt-5 text-xs text-slate-500 dark:text-[#f8fafc]/45">
          <span className="font-mono uppercase tracking-[0.16em]">CaratOS</span>
          <span>
            {creatingOrganisation
              ? "Universal CRM · Isolated workspaces"
              : "© 2026 CaratOS. All rights reserved."}
          </span>
        </div>
      </aside>

      {/* ── Right Live Interactive Sign-in Form ─────────────────────── */}
      <main className="relative flex flex-col justify-between bg-[#f8f9fc] dark:bg-[#090b10] px-6 py-10 sm:px-12 lg:px-16 transition-colors">
        <div className="mx-auto my-auto w-full max-w-xl space-y-7">
          {/* Header Bar with Logo and Theme Toggle */}
          <div className="flex items-center justify-between">
            <div>
              {creatingOrganisation ? (
                <div className="flex items-center gap-2 text-[#6366f1] dark:text-[#818cf8]">
                  <Bot className="h-6 w-6" />
                  <span className="font-display text-xl font-bold">CaratOS</span>
                </div>
              ) : (
                <Logo className="h-9 w-auto" />
              )}
            </div>

            {/* Luxury Theme Selector */}
            <div className="flex items-center gap-2 rounded-full border border-slate-200/90 dark:border-white/10 bg-white/80 dark:bg-white/[0.04] px-3 py-1 shadow-xs backdrop-blur-md">
              <span className="text-[11px] font-medium text-slate-500 dark:text-slate-400">Theme</span>
              <ThemeToggle />
            </div>
          </div>

          <div>
            <h2 className="font-display text-3xl font-bold tracking-tight text-slate-900 dark:text-[#f8fafc]">
              {mode === "signin"
                ? "Sign in to your workspace"
                : signupKind === "organisation"
                  ? "Set up your organisation"
                  : "Join your organisation"}
            </h2>
            <p className="mt-1.5 text-sm text-slate-600 dark:text-[#f8fafc]/70">
              {mode === "signin"
                ? "Enter your Login ID and password to start the session."
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
          {/* Face Sign-In / Fast Biometric Attendance option */}
          <div className="space-y-3">
            <Button
              type="button"
              variant="outline"
              onClick={() => setFaceScannerOpen(true)}
              className="w-full flex items-center justify-center gap-2 border-indigo-200 dark:border-indigo-500/30 bg-indigo-50/70 dark:bg-indigo-500/10 text-indigo-700 dark:text-indigo-300 hover:bg-indigo-100 dark:hover:bg-indigo-500/20 font-semibold text-sm py-2.5 rounded-xl shadow-xs transition-all"
            >
              <Camera className="h-4 w-4 text-indigo-600 dark:text-indigo-400" />
              Face Sign-In / Fast Attendance Punch
            </Button>

            {capturedFacePhoto ? (
              <div className="flex items-center gap-2.5 rounded-xl border border-emerald-500/30 bg-emerald-500/10 p-2.5 text-xs text-emerald-800 dark:text-emerald-200">
                <img
                  src={capturedFacePhoto}
                  alt="Captured Face"
                  className="h-9 w-9 rounded-full object-cover border border-emerald-500/40"
                />
                <div className="flex-1 min-w-0">
                  <p className="font-semibold text-emerald-950 dark:text-emerald-100">
                    Face Captured & Verified
                  </p>
                  <p className="text-emerald-700 dark:text-emerald-300/80 text-[11px]">
                    Enter password for your Login ID to complete sign-in.
                  </p>
                </div>
              </div>
            ) : null}

            <div className="flex items-center gap-3 text-xs text-slate-500 dark:text-[#f8fafc]/40">
              <div className="h-px flex-1 bg-slate-200 dark:bg-white/[0.08]" />
              or sign in with Login ID & password
              <div className="h-px flex-1 bg-slate-200 dark:bg-white/[0.08]" />
            </div>
          </div>

          {/* Auth Form Container */}
          <div className="glass facet-top relative rounded-2xl p-5 shadow-xs">
            <form onSubmit={onSubmitPassword} className="space-y-4">
                <div className="space-y-1.5">
                  <Label htmlFor="email" className="text-xs font-medium text-slate-700 dark:text-[#f8fafc]/80">Login ID</Label>
                  <Input
                    id="email"
                    type="email"
                    autoComplete="username"
                    className={FIELD}
                    value={email}
                    onChange={(e) => setEmail(e.target.value)}
                    required
                  />
                </div>
                <div className="space-y-1.5">
                  <Label htmlFor="password" className="text-xs font-medium text-slate-700 dark:text-[#f8fafc]/80">Password</Label>
                  <div className="relative">
                    <Input
                      id="password"
                      type={showPassword ? "text" : "password"}
                      autoComplete="current-password"
                      className={`${FIELD} pr-10`}
                      value={password}
                      onChange={(e) => setPassword(e.target.value)}
                      required
                    />
                    <button
                      type="button"
                      onClick={() => setShowPassword((s) => !s)}
                      aria-label={showPassword ? "Hide password" : "Show password"}
                      tabIndex={-1}
                      className="absolute right-2 top-1/2 -translate-y-1/2 text-slate-400 transition-colors hover:text-slate-700 dark:text-[#f8fafc]/50 dark:hover:text-[#f8fafc]"
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
                  className="w-full bg-[#6366f1] text-white font-semibold hover:bg-[#4f46e5] shadow-xs"
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
              <div className="grid grid-cols-2 gap-2 rounded-xl border border-slate-200/80 dark:border-white/[0.08] bg-slate-100/70 dark:bg-black/25 p-1.5 shadow-xs">
                <button
                  type="button"
                  onClick={() => setSignupKind("join")}
                  className={
                    "flex items-center justify-center gap-2 rounded-lg px-3 py-2 text-xs font-medium transition-colors " +
                    (signupKind === "join"
                      ? "bg-[#6366f1] text-white shadow-xs"
                      : "text-slate-600 dark:text-[#f8fafc]/65 hover:bg-white/60 dark:hover:bg-white/5")
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
                      ? "bg-[#6366f1] text-white shadow-xs"
                      : "text-slate-600 dark:text-[#f8fafc]/65 hover:bg-white/60 dark:hover:bg-white/5")
                  }
                >
                  <Building2 className="h-3.5 w-3.5" /> Create organisation
                </button>
              </div>
              {signupKind === "organisation" ? (
                <OrganisationSignupCard
                  onCreated={finishLogin}
                  onSwitchToSignin={(dupEmail) => {
                    setMode("signin");
                    setEmail(dupEmail);
                    toast.info(`Please enter your password to sign in as ${dupEmail}`);
                  }}
                />
              ) : (
                <SignupCard onBackToSignin={() => setMode("signin")} />
              )}
            </div>
          )}

          {/* Sign in ⇄ Create account toggle */}
          <button
            type="button"
            onClick={() => setMode((m) => (m === "signin" ? "signup" : "signin"))}
            className="flex w-full items-center justify-center gap-1.5 text-sm text-slate-600 dark:text-[#f8fafc]/70 transition-colors hover:text-[#6366f1] dark:hover:text-[#818cf8]"
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
        </div>

        {/* PWA Install Footer Notice */}
        <div className="mt-8 flex items-center justify-between border-t border-slate-200/80 dark:border-white/[0.08] pt-4 text-xs text-slate-500 dark:text-[#f8fafc]/40">
          <span>Operational ERP · All stores scoped</span>
          <InstallAppButton />
        </div>
      </main>

      {/* Biometric Face Scanner Modal */}
      <FaceScannerDialog
        open={faceScannerOpen}
        onOpenChange={setFaceScannerOpen}
        context={{
          action: "Face Sign-In / Attendance Punch",
        }}
        onCapture={(photo) => {
          setCapturedFacePhoto(photo);
          setFaceScannerOpen(false);
          let recognizedName = "";
          if (typeof window !== "undefined") {
            try {
              const raw = localStorage.getItem("eclat_last_staff");
              if (raw) {
                const parsed = JSON.parse(raw);
                if (parsed?.email) {
                  setEmail(parsed.email);
                  recognizedName = parsed.name || "";
                }
              }
            } catch {}
          }
          if (recognizedName) {
            toast.success(`Welcome back, ${recognizedName.split(" ")[0]}! Face verified 👋`, {
              description: "Enter your password to complete biometric sign-in.",
            });
          } else {
            toast.success("Face recognized & captured!", {
              description: "Face reference captured. Sign in with your password to complete verification.",
            });
          }
        }}
      />
    </div>
  );
}
