import Link from "next/link";
import {
  ArrowRight,
  Boxes,
  BookOpen,
  Building2,
  ClipboardList,
  Fingerprint,
  GitBranch,
  Languages,
  ListChecks,
  MessagesSquare,
  ScrollText,
  ShieldCheck,
  Sparkles,
  Users,
} from "lucide-react";

import { Button } from "@/components/ui/button";
import { Logo } from "@/components/brand/logo";

/**
 * The public landing page (MM2-02).
 *
 * ## What changed and why
 *
 * This page used to be one customer's marketing site: "Éclat Diamonds
 * Philosophy", signature velvet vaults, a featured collection, "100% BIS & GIA
 * Compliant", and a copyright line naming that company. CaratOS is sold to
 * clinics, factories and distributors, and every one of them met a jeweller's
 * brochure before they met the product.
 *
 * ## The rule this page is written under
 *
 * Every claim below is something the application actually does today, and
 * nothing here names a customer, a logo, a metric or a third-party provider we
 * would have to stand behind. Where a capability is real but bounded — imports
 * are reviewed before they land, an industry pack sets words rather than
 * regulated workflow — the bound is stated rather than smoothed over. A landing
 * page that oversells is the fastest way to make an honest product look
 * dishonest on the first call.
 *
 * Authenticated branding is a separate question and is unchanged: inside their
 * own workspace, Éclat still see their own mark (components/brand/logo.tsx).
 */

const CAPABILITIES = [
  {
    icon: MessagesSquare,
    title: "Omnichannel CRM",
    body: "Enquiries from WhatsApp, phone and walk-ins land as one conversation against one customer record, with assignment, ownership and follow-up reminders.",
  },
  {
    icon: Sparkles,
    title: "An assistant that reads your own data",
    body: "Reply drafting and lead qualification run against this tenant's conversations and documents — not a generic model talking about your business from the outside.",
  },
  {
    icon: BookOpen,
    title: "Tenant knowledge",
    body: "Upload the documents your team answers from. They are indexed per tenant and used to ground the assistant's suggestions.",
  },
  {
    icon: Boxes,
    title: "Catalogue",
    body: "What you sell, with photos, your own categories and your own units — a service, a SKU, a plan or a part. Image search is available where a catalogue supports it.",
  },
  {
    icon: Fingerprint,
    title: "Attendance & visits",
    body: "Geo-tagged staff attendance and customer check-ins, recorded per branch and visible up the reporting line.",
  },
  {
    icon: GitBranch,
    title: "Bring your existing data",
    body: "Spreadsheet imports and on-site connectors, both previewed before anything is written. Nothing changes your records until someone approves the run.",
  },
];

const INDUSTRIES = [
  "Jewellery retail",
  "Retail & e-commerce",
  "Pharmacy",
  "Textile & apparel",
  "Healthcare & clinics",
  "Manufacturing",
  "Professional services",
  "Real estate & construction",
  "Education & training",
  "Hospitality & travel",
  "Automotive",
  "Wholesale & distribution",
  "Financial services",
  "Technology & SaaS",
  "Logistics & transportation",
  "Other / mixed business",
];

const SETUP_STEPS = [
  {
    icon: Building2,
    title: "Create your organisation",
    body: "Name it, add your first branch, and choose the industry you are in. If none of them fit, take the mixed-business option — it configures the neutral vocabulary rather than guessing.",
  },
  {
    icon: Languages,
    title: "Your industry's words appear",
    body: "A clinic gets patients and enquiries; a factory gets accounts and orders; a textile house gets buyers and articles. Same product, your terminology — and you can edit any of it afterwards.",
  },
  {
    icon: ListChecks,
    title: "A pipeline you can change",
    body: "Each industry starts with a three-stage funnel and its own qualification questions. Rename a stage and it stays yours: changing industry later never overwrites wording your team chose.",
  },
];

const GOVERNANCE = [
  {
    icon: ShieldCheck,
    title: "One tenant cannot see another",
    body: "Every record is scoped to the organisation that owns it, and that scoping is enforced on the server, not in the screen you are looking at.",
  },
  {
    icon: Users,
    title: "Roles and branches",
    body: "Salesperson, store manager, area manager and head office see progressively more, and a manager's reach stops at the branches they run.",
  },
  {
    icon: ClipboardList,
    title: "Only the modules you set up",
    body: "Your industry decides which parts of the product exist for you — in the menu and at the API. A module you did not set up is not one URL away.",
  },
  {
    icon: ScrollText,
    title: "An audit trail",
    body: "Approvals, imports, rate changes and administrative actions are recorded with who did them and when.",
  },
];

export default function LandingPage() {
  return (
    <div className="min-h-screen bg-[#0c261c] text-[#f6f3ed] antialiased">
      {/* ── Header ───────────────────────────────────────────────────── */}
      <header className="sticky top-0 z-50 border-b border-[#1b3a2c] bg-[#0c261c]/90 backdrop-blur">
        <div className="mx-auto flex h-16 max-w-6xl items-center justify-between px-5 sm:px-8">
          <Logo className="h-7 w-auto" />
          <nav className="hidden items-center gap-7 text-sm text-[#f6f3ed]/70 md:flex">
            <a href="#platform" className="transition-colors hover:text-[#c8a24f]">
              Platform
            </a>
            <a href="#industries" className="transition-colors hover:text-[#c8a24f]">
              Industries
            </a>
            <a href="#setup" className="transition-colors hover:text-[#c8a24f]">
              Setup
            </a>
            <a href="#governance" className="transition-colors hover:text-[#c8a24f]">
              Governance
            </a>
          </nav>
          <Button asChild className="text-[#071e16]" style={{ backgroundColor: "#c8a24f" }}>
            <Link href="/login">Sign in</Link>
          </Button>
        </div>
      </header>

      {/* ── Hero ─────────────────────────────────────────────────────── */}
      <section className="border-b border-[#1b3a2c] py-24 sm:py-28">
        <div className="mx-auto max-w-6xl px-5 sm:px-8">
          {/* The product's shipped neutral name, matching the lockup in the header
              and the footer inside the app. The platform is called CaratOS in the
              architecture docs and CaratSense on every screen a customer sees;
              putting both on one page would just read as two products. */}
          <span className="font-mono text-xs uppercase tracking-[0.2em] text-[#c8a24f]">
            CaratSense
          </span>
          <h1 className="mt-4 max-w-3xl font-display text-4xl font-bold leading-[1.1] sm:text-5xl lg:text-6xl">
            An AI CRM that speaks your industry&rsquo;s language.
          </h1>
          <p className="mt-6 max-w-2xl text-base leading-relaxed text-[#f6f3ed]/75 sm:text-lg">
            One workspace for conversations, customers, your catalogue and your
            team&rsquo;s attendance — across every branch you run. You choose
            your industry when you sign up, and the product configures its
            vocabulary, its qualification questions and its default pipeline to
            match. Everything it configures, you can change.
          </p>
          <div className="mt-9 flex flex-col gap-3 sm:flex-row">
            <Button
              asChild
              size="lg"
              className="text-[#071e16]"
              style={{ backgroundColor: "#c8a24f" }}
            >
              <Link href="/login">
                Create your organisation
                <ArrowRight className="ml-2 h-4 w-4" />
              </Link>
            </Button>
            <Button
              asChild
              size="lg"
              variant="outline"
              className="border-[#1b3a2c] bg-transparent text-[#f6f3ed] hover:bg-[#071e16]"
            >
              <Link href="/login">Sign in to an existing workspace</Link>
            </Button>
          </div>
          <p className="mt-6 max-w-2xl text-sm text-[#f6f3ed]/45">
            Staff accounts are created by your own administrators and approved
            before they can do anything. Signing up never grants access to
            somebody else&rsquo;s organisation.
          </p>
        </div>
      </section>

      {/* ── Platform ─────────────────────────────────────────────────── */}
      <section id="platform" className="border-b border-[#1b3a2c] bg-[#071e16] py-24">
        <div className="mx-auto max-w-6xl px-5 sm:px-8">
          <div className="max-w-2xl">
            <span className="font-mono text-xs uppercase tracking-[0.2em] text-[#c8a24f]">
              What every workspace includes
            </span>
            <h2 className="mt-2 font-display text-3xl font-bold sm:text-4xl">
              The same suite, whatever you sell.
            </h2>
          </div>

          <div className="mt-12 grid gap-px overflow-hidden rounded-2xl border border-[#1b3a2c] bg-[#1b3a2c] sm:grid-cols-2 lg:grid-cols-3">
            {CAPABILITIES.map(({ icon: Icon, title, body }) => (
              <div key={title} className="bg-[#0c261c] p-6">
                <span className="flex h-10 w-10 items-center justify-center rounded-lg bg-[#c8a24f]/15 text-[#c8a24f]">
                  <Icon className="h-5 w-5" />
                </span>
                <h3 className="mt-4 font-display text-lg font-semibold">{title}</h3>
                <p className="mt-2 text-sm leading-relaxed text-[#f6f3ed]/65">{body}</p>
              </div>
            ))}
          </div>
        </div>
      </section>

      {/* ── Industries ───────────────────────────────────────────────── */}
      <section id="industries" className="border-b border-[#1b3a2c] py-24">
        <div className="mx-auto max-w-6xl px-5 sm:px-8">
          <div className="max-w-2xl">
            <span className="font-mono text-xs uppercase tracking-[0.2em] text-[#c8a24f]">
              Industries
            </span>
            <h2 className="mt-2 font-display text-3xl font-bold sm:text-4xl">
              Sixteen starting points.
            </h2>
            <p className="mt-4 text-sm leading-relaxed text-[#f6f3ed]/65">
              An industry decides the words on your screens, the fields your
              catalogue collects and the questions the assistant asks — not a
              separate application. Regulated workflows such as clinical records,
              statutory accounting or laboratory compliance are deliberately{" "}
              <span className="text-[#f6f3ed]/85">not</span> part of these packs.
            </p>
          </div>

          <div className="mt-12 grid grid-cols-2 gap-px overflow-hidden rounded-2xl border border-[#1b3a2c] bg-[#1b3a2c] sm:grid-cols-3 lg:grid-cols-4">
            {INDUSTRIES.map((name) => (
              <div
                key={name}
                className="bg-[#0c261c] px-4 py-4 text-xs font-medium text-[#f6f3ed]/90 transition-colors hover:bg-[#071e16]"
              >
                {name}
              </div>
            ))}
          </div>
        </div>
      </section>

      {/* ── Setup ────────────────────────────────────────────────────── */}
      <section id="setup" className="border-b border-[#1b3a2c] bg-[#071e16] py-24">
        <div className="mx-auto max-w-6xl px-5 sm:px-8">
          <div className="max-w-2xl">
            <span className="font-mono text-xs uppercase tracking-[0.2em] text-[#c8a24f]">
              Setup
            </span>
            <h2 className="mt-2 font-display text-3xl font-bold sm:text-4xl">
              Configured in minutes, yours to edit after.
            </h2>
          </div>

          <div className="mt-12 grid gap-6 md:grid-cols-3">
            {SETUP_STEPS.map(({ icon: Icon, title, body }, index) => (
              <div
                key={title}
                className="rounded-2xl border border-[#1b3a2c] bg-[#0c261c] p-6"
              >
                <div className="flex items-center gap-3">
                  <span className="flex h-9 w-9 items-center justify-center rounded-lg bg-[#c8a24f]/15 text-[#c8a24f]">
                    <Icon className="h-4 w-4" />
                  </span>
                  <span className="font-mono text-xs text-[#f6f3ed]/40">
                    0{index + 1}
                  </span>
                </div>
                <h3 className="mt-4 font-display text-lg font-semibold">{title}</h3>
                <p className="mt-2 text-sm leading-relaxed text-[#f6f3ed]/65">{body}</p>
              </div>
            ))}
          </div>
        </div>
      </section>

      {/* ── Governance ───────────────────────────────────────────────── */}
      <section id="governance" className="border-b border-[#1b3a2c] py-24">
        <div className="mx-auto max-w-6xl px-5 sm:px-8">
          <div className="max-w-2xl">
            <span className="font-mono text-xs uppercase tracking-[0.2em] text-[#c8a24f]">
              Governance
            </span>
            <h2 className="mt-2 font-display text-3xl font-bold sm:text-4xl">
              Multi-tenant, multi-branch, and strict about both.
            </h2>
          </div>

          <div className="mt-12 grid gap-6 sm:grid-cols-2">
            {GOVERNANCE.map(({ icon: Icon, title, body }) => (
              <div
                key={title}
                className="flex gap-4 rounded-2xl border border-[#1b3a2c] bg-[#071e16] p-6"
              >
                <span className="flex h-10 w-10 shrink-0 items-center justify-center rounded-lg bg-[#c8a24f]/15 text-[#c8a24f]">
                  <Icon className="h-5 w-5" />
                </span>
                <div>
                  <h3 className="font-display text-lg font-semibold">{title}</h3>
                  <p className="mt-2 text-sm leading-relaxed text-[#f6f3ed]/65">{body}</p>
                </div>
              </div>
            ))}
          </div>
        </div>
      </section>

      {/* ── Footer ───────────────────────────────────────────────────── */}
      <footer className="bg-[#071e16] py-14">
        <div className="mx-auto max-w-6xl px-5 text-center sm:px-8 sm:text-left">
          <div className="flex flex-col items-center justify-between gap-6 sm:flex-row">
            <Logo className="h-8 w-auto" />
            <div className="flex items-center gap-6 text-xs text-[#f6f3ed]/70">
              <Link href="/login" className="hover:text-[#c8a24f]">
                Sign in
              </Link>
              <a href="#platform" className="hover:text-[#c8a24f]">
                Platform
              </a>
              <a href="#industries" className="hover:text-[#c8a24f]">
                Industries
              </a>
              <a href="#governance" className="hover:text-[#c8a24f]">
                Governance
              </a>
            </div>
          </div>
          <div className="mt-8 flex flex-col items-center justify-between gap-3 border-t border-[#1b3a2c] pt-6 text-xs text-[#f6f3ed]/50 sm:flex-row">
            <span>© 2026 CaratSense. All rights reserved.</span>
            <span className="font-mono">Multi-industry AI CRM</span>
          </div>
        </div>
      </footer>
    </div>
  );
}
