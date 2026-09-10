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
import { IndustryGrid } from "@/components/landing/industries";
import {
  AttendanceSurface,
  AttributionSurface,
  FloorSurface,
  IntentSurface,
  IsolationSurface,
  OmnichannelSurface,
  QueueSurface,
} from "@/components/landing/product-surfaces";

/**
 * The public landing page.
 *
 * ## The rule this page is written under
 *
 * Every claim below is something the application actually does today, and
 * nothing here names a customer, a logo, a metric or a third-party provider we
 * would have to stand behind. Where a capability is real but bounded — imports
 * are reviewed before they land, an industry pack sets words rather than
 * regulated workflow, a photo is evidence rather than identification — the
 * bound is stated rather than smoothed over. A landing page that oversells is
 * the fastest way to make an honest product look dishonest on the first call.
 *
 * ## What is deliberately absent
 *
 * Throughput, accuracy, uptime, customer counts and revenue. Not because they
 * would be unflattering — because nothing in this repository measures them, and
 * the first person to ask "where does 94.8% come from" would get silence.
 *
 * ## Why the screens are drawn rather than photographed
 *
 * A screenshot of a live workspace publishes somebody's customers. See
 * `components/landing/product-surfaces.tsx`.
 *
 * Authenticated branding is a separate question and is unchanged: inside their
 * own workspace, a tenant still sees their own mark (components/brand/logo.tsx).
 */

const CAPABILITIES = [
  {
    icon: MessagesSquare,
    title: "Omnichannel CRM",
    body: "Enquiries from WhatsApp, phone, web forms and walk-ins land as one conversation against one customer record, with assignment, ownership and follow-up reminders.",
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

/**
 * The tour. Each row is a claim beside the screen that makes it — so a reader
 * can check the sentence against the thing rather than take it on faith.
 */
const TOUR = [
  {
    id: "inbox",
    eyebrow: "Every channel",
    title: "One customer, not four inboxes",
    body: "A WhatsApp message, a missed call, a form on your website and somebody walking through the door are the same person asking the same question. They arrive on one timeline, owned by one member of staff, with the follow-up already scheduled.",
    Surface: OmnichannelSurface,
  },
  {
    id: "intent",
    eyebrow: "Explainable intent",
    title: "How warm an enquiry is, and what made it warm",
    body: "Qualification runs over the conversation and produces a score, a band in your own words, and the signals it fired on. An enquiry nobody has assessed says so — it never gets a number somebody made up, because a salesperson acts on that number.",
    Surface: IntentSurface,
  },
  {
    id: "floor",
    eyebrow: "Store operations",
    title: "What happened at the counter, from the counter",
    body: "Search a partial phone number, pull up the customer, record the visit and what they asked about — including the thing they did not buy and why. It is a phone app because it is used standing up, one-handed, with somebody waiting.",
    Surface: FloorSurface,
  },
  {
    id: "queue",
    eyebrow: "Follow-ups",
    title: "The calls owed today, oldest first",
    body: "Overdue, due today, upcoming and done — each count its own query, so the number on the card is the number in the database rather than a count of one page. Contact details are shown to the person who owns the follow-up and to their manager.",
    Surface: QueueSurface,
  },
  {
    id: "attendance",
    eyebrow: "Attendance evidence",
    title: "A punch you can check, without pretending to recognise a face",
    body: "Staff punch in from their own phone. The record carries the distance from the branch, whether the device reported a spoofed location, and optionally a photo taken at that moment — which a manager can open, and which the product never claims to have matched against anyone.",
    Surface: AttendanceSurface,
  },
  {
    id: "attribution",
    eyebrow: "Attribution",
    title: "From the ad click to the person at the counter",
    body: "Click-to-WhatsApp conversations, lead forms and walk-ins are counted through the same funnel, over whichever window you choose. Where a stage cannot be measured for your account, it shows a dash rather than a zero.",
    Surface: AttributionSurface,
  },
  {
    id: "isolation",
    eyebrow: "Tenant isolation",
    title: "Your workspace is yours",
    body: "Every record is scoped to the organisation that owns it, on the server. Your industry pack sets the words your team reads, your branches set who sees what, and the modules you did not set up are not one URL away.",
    Surface: IsolationSurface,
  },
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
    body: "Salesperson, store manager, area manager and head office see progressively more, and a manager's reach stops at the branches they run. Self-signup asks for the first two; the rest are granted by your own administrators.",
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

const NAV = [
  { href: "#tour", label: "Product" },
  { href: "#platform", label: "Platform" },
  { href: "#industries", label: "Industries" },
  { href: "#governance", label: "Governance" },
];

export default function LandingPage() {
  return (
    /*
     * `.landing` carries the emerald/champagne palette, `overflow-x: clip` and
     * the reduced-motion guards. It was written for this page, and this page
     * then re-declared the same six hex values inline on forty elements and
     * never used the class — two copies of one palette, and only one of them
     * with the horizontal-overflow guard.
     */
    <div className="landing min-h-screen antialiased">
      {/* ── Header ───────────────────────────────────────────────────── */}
      <header className="sticky top-0 z-50 border-b border-[var(--l-hairline)] bg-[color-mix(in_srgb,var(--l-bg)_92%,transparent)] backdrop-blur">
        <div className="mx-auto flex h-16 max-w-6xl items-center justify-between gap-4 px-5 sm:px-8">
          <Logo className="h-7 w-auto" />
          <nav className="hidden items-center gap-7 md:flex">
            {NAV.map((n) => (
              <a key={n.href} href={n.href} className="landing-nav-link">
                {n.label}
              </a>
            ))}
          </nav>
          <Button asChild className="shrink-0 bg-[var(--l-gold)] text-[var(--l-bg)] hover:bg-[var(--l-gold-dark)]">
            <Link href="/login">Sign in</Link>
          </Button>
        </div>
      </header>

      {/* ── Hero ─────────────────────────────────────────────────────── */}
      <section className="landing-gradient relative border-b border-[var(--l-hairline)]">
        <div className="mx-auto max-w-6xl px-5 py-16 sm:px-8 sm:py-20 lg:py-24">
          <div className="grid items-center gap-12 lg:grid-cols-[minmax(0,1fr)_minmax(0,440px)]">
            <div>
              {/* The product's shipped neutral name, matching the lockup in the
                  header and the footer inside the app. The platform is called
                  CaratOS in the architecture docs and CaratSense on every screen
                  a customer sees; putting both here would read as two products. */}
              <span className="landing-eyebrow">CaratSense</span>
              <h1 className="mt-4 max-w-2xl text-balance font-display text-4xl font-bold leading-[1.08] sm:text-5xl lg:text-[3.4rem]">
                An AI CRM that speaks your industry&rsquo;s language.
              </h1>
              <p className="mt-6 max-w-xl text-base leading-relaxed text-[var(--l-ivory-70)]">
                One workspace for conversations, customers, your catalogue and your team&rsquo;s
                attendance — across every branch you run. You choose your industry when you sign
                up, and the product configures its vocabulary, its qualification questions and
                its default pipeline to match. Everything it configures, you can change.
              </p>
              <div className="mt-8 flex flex-col gap-3 sm:flex-row">
                <Button
                  asChild
                  size="lg"
                  className="bg-[var(--l-gold)] text-[var(--l-bg)] hover:bg-[var(--l-gold-dark)]"
                >
                  {/*
                    Deep-linked to the form it promises. It used to land on the
                    sign-IN tab, two hidden steps from creating anything.
                  */}
                  <Link href="/login?start=create">
                    Create your organisation
                    <ArrowRight className="ml-2 h-4 w-4" />
                  </Link>
                </Button>
                <Button
                  asChild
                  size="lg"
                  variant="outline"
                  className="border-[var(--l-hairline)] bg-transparent text-[var(--l-ivory)] hover:bg-[var(--l-surface)]"
                >
                  <Link href="/login">Sign in to an existing workspace</Link>
                </Button>
              </div>
              <p className="mt-6 max-w-xl text-sm text-[var(--l-ivory-55)]">
                Staff accounts are created by your own administrators and approved before they
                can do anything. Signing up never grants access to somebody else&rsquo;s
                organisation.
              </p>
            </div>

            {/* The product, in the first viewport — not a gradient. */}
            <div className="lg:pl-4">
              <OmnichannelSurface />
            </div>
          </div>
        </div>
      </section>

      {/* ── Tour ─────────────────────────────────────────────────────── */}
      <section id="tour" className="border-b border-[var(--l-hairline)] bg-[var(--l-bg)]">
        <div className="mx-auto max-w-6xl px-5 py-20 sm:px-8 sm:py-24">
          <div className="max-w-2xl">
            <span className="landing-eyebrow">What it does</span>
            <h2 className="mt-2 text-balance font-display text-3xl font-bold sm:text-4xl">
              Seven things, and the screens that do them.
            </h2>
            <p className="mt-4 text-sm leading-relaxed text-[var(--l-ivory-70)]">
              The views below are the real layouts with example content, drawn rather than
              photographed — a screenshot of a live workspace would publish somebody&rsquo;s
              customers.
            </p>
          </div>

          <div className="mt-14 space-y-16 lg:space-y-20">
            {TOUR.map(({ id, eyebrow, title, body, Surface }, i) => (
              <div
                key={id}
                id={id}
                className="grid items-center gap-8 lg:grid-cols-2 lg:gap-14"
              >
                <div className={i % 2 === 1 ? "lg:order-2" : undefined}>
                  <span className="landing-eyebrow">{eyebrow}</span>
                  <h3 className="mt-2 text-balance font-display text-xl font-semibold sm:text-2xl">
                    {title}
                  </h3>
                  <p className="mt-3 max-w-xl text-sm leading-relaxed text-[var(--l-ivory-70)]">
                    {body}
                  </p>
                </div>
                <div className={i % 2 === 1 ? "lg:order-1" : undefined}>
                  <Surface />
                </div>
              </div>
            ))}
          </div>
        </div>
      </section>

      {/* ── Platform ─────────────────────────────────────────────────── */}
      <section id="platform" className="border-b border-[var(--l-hairline)] bg-[var(--l-surface)]">
        <div className="mx-auto max-w-6xl px-5 py-20 sm:px-8 sm:py-24">
          <div className="max-w-2xl">
            <span className="landing-eyebrow">The platform</span>
            <h2 className="mt-2 text-balance font-display text-3xl font-bold sm:text-4xl">
              What comes with the workspace.
            </h2>
          </div>

          <div className="mt-12 grid gap-px overflow-hidden rounded-xl border border-[var(--l-hairline)] bg-[var(--l-hairline)] sm:grid-cols-2 lg:grid-cols-3">
            {CAPABILITIES.map(({ icon: Icon, title, body }) => (
              <div key={title} className="bg-[var(--l-bg)] p-6">
                <span className="flex h-9 w-9 items-center justify-center rounded-lg bg-[color-mix(in_srgb,var(--l-gold)_15%,transparent)] text-[var(--l-gold)]">
                  <Icon className="h-4 w-4" />
                </span>
                <h3 className="mt-4 font-display text-base font-semibold">{title}</h3>
                <p className="mt-2 text-sm leading-relaxed text-[var(--l-ivory-55)]">{body}</p>
              </div>
            ))}
          </div>
        </div>
      </section>

      {/* ── Industries ───────────────────────────────────────────────── */}
      <section id="industries" className="border-b border-[var(--l-hairline)] bg-[var(--l-bg)]">
        <div className="mx-auto max-w-6xl px-5 py-20 sm:px-8 sm:py-24">
          <div className="max-w-2xl">
            <span className="landing-eyebrow">Industries</span>
            <h2 className="mt-2 text-balance font-display text-3xl font-bold sm:text-4xl">
              Pick the one you are in.
            </h2>
          </div>
          {/*
            Outside the prose column: the sentence wants a comfortable measure,
            the grid of sixteen wants the full width. Nesting the grid in the
            heading's `max-w-2xl` squeezed it into half the page.
            Fetched from the server that owns the packs — see IndustryGrid.
          */}
          <IndustryGrid />
          <p className="mt-8 max-w-2xl text-sm leading-relaxed text-[var(--l-ivory-55)]">
            A pack configures vocabulary, pipelines and qualification questions. It does not
            configure regulated workflow: dispensing rules, clinical records and statutory
            filings are <span className="text-[var(--l-ivory)]">not</span> part of these packs.
          </p>
        </div>
      </section>

      {/* ── Setup ────────────────────────────────────────────────────── */}
      <section id="setup" className="border-b border-[var(--l-hairline)] bg-[var(--l-surface)]">
        <div className="mx-auto max-w-6xl px-5 py-20 sm:px-8 sm:py-24">
          <div className="max-w-2xl">
            <span className="landing-eyebrow">Getting started</span>
            <h2 className="mt-2 text-balance font-display text-3xl font-bold sm:text-4xl">
              Three steps, then your own words.
            </h2>
          </div>

          {/*
            Numbered because this genuinely is a sequence — you cannot get your
            industry's vocabulary before you have said which industry you are in.
          */}
          <ol className="mt-12 grid gap-6 md:grid-cols-3">
            {SETUP_STEPS.map(({ icon: Icon, title, body }, i) => (
              <li key={title} className="rounded-xl border border-[var(--l-hairline)] bg-[var(--l-bg)] p-6">
                <div className="flex items-center gap-3">
                  <span className="flex h-9 w-9 items-center justify-center rounded-lg bg-[color-mix(in_srgb,var(--l-gold)_15%,transparent)] text-[var(--l-gold)]">
                    <Icon className="h-4 w-4" />
                  </span>
                  <span className="font-mono text-xs text-[var(--l-ivory-55)]">
                    {String(i + 1).padStart(2, "0")}
                  </span>
                </div>
                <h3 className="mt-4 font-display text-base font-semibold">{title}</h3>
                <p className="mt-2 text-sm leading-relaxed text-[var(--l-ivory-55)]">{body}</p>
              </li>
            ))}
          </ol>
        </div>
      </section>

      {/* ── Governance ───────────────────────────────────────────────── */}
      <section id="governance" className="border-b border-[var(--l-hairline)] bg-[var(--l-bg)]">
        <div className="mx-auto max-w-6xl px-5 py-20 sm:px-8 sm:py-24">
          <div className="max-w-2xl">
            <span className="landing-eyebrow">Governance</span>
            <h2 className="mt-2 text-balance font-display text-3xl font-bold sm:text-4xl">
              Who can see what, and who did what.
            </h2>
          </div>

          <div className="mt-12 grid gap-6 sm:grid-cols-2">
            {GOVERNANCE.map(({ icon: Icon, title, body }) => (
              <div key={title} className="flex gap-4">
                <span className="flex h-9 w-9 shrink-0 items-center justify-center rounded-lg bg-[color-mix(in_srgb,var(--l-gold)_15%,transparent)] text-[var(--l-gold)]">
                  <Icon className="h-4 w-4" />
                </span>
                <div>
                  <h3 className="font-display text-base font-semibold">{title}</h3>
                  <p className="mt-2 text-sm leading-relaxed text-[var(--l-ivory-55)]">{body}</p>
                </div>
              </div>
            ))}
          </div>
        </div>
      </section>

      {/* ── Close ────────────────────────────────────────────────────── */}
      <section className="landing-gradient border-b border-[var(--l-hairline)]">
        <div className="mx-auto max-w-6xl px-5 py-16 text-center sm:px-8">
          <h2 className="text-balance font-display text-2xl font-bold sm:text-3xl">
            Start with your own branch and your own words.
          </h2>
          <div className="mt-7 flex flex-col justify-center gap-3 sm:flex-row">
            <Button
              asChild
              size="lg"
              className="bg-[var(--l-gold)] text-[var(--l-bg)] hover:bg-[var(--l-gold-dark)]"
            >
              <Link href="/login?start=create">
                Create your organisation
                <ArrowRight className="ml-2 h-4 w-4" />
              </Link>
            </Button>
            <Button
              asChild
              size="lg"
              variant="outline"
              className="border-[var(--l-hairline)] bg-transparent text-[var(--l-ivory)] hover:bg-[var(--l-surface)]"
            >
              <Link href="/login">Sign in</Link>
            </Button>
          </div>
        </div>
      </section>

      {/* ── Footer ───────────────────────────────────────────────────── */}
      <footer className="bg-[var(--l-surface)] py-14">
        <div className="mx-auto max-w-6xl px-5 text-center sm:px-8 sm:text-left">
          <div className="flex flex-col items-center justify-between gap-6 sm:flex-row">
            <Logo className="h-8 w-auto" />
            <div className="flex flex-wrap items-center justify-center gap-6 text-xs text-[var(--l-ivory-70)]">
              <Link href="/login" className="hover:text-[var(--l-gold)]">
                Sign in
              </Link>
              {NAV.map((n) => (
                <a key={n.href} href={n.href} className="hover:text-[var(--l-gold)]">
                  {n.label}
                </a>
              ))}
            </div>
          </div>
          <div className="mt-8 flex flex-col items-center justify-between gap-3 border-t border-[var(--l-hairline)] pt-6 text-xs text-[var(--l-ivory-55)] sm:flex-row">
            <span>© 2026 CaratSense. All rights reserved.</span>
            <span className="font-mono">Multi-industry AI CRM</span>
          </div>
        </div>
      </footer>
    </div>
  );
}
