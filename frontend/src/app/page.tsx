import Link from "next/link";
import {
  ArrowRight,
  BarChart3,
  Banknote,
  Boxes,
  Building2,
  Clock,
  Fingerprint,
  Footprints,
  HandCoins,
  Layers,
  LayoutDashboard,
  LockKeyhole,
  MapPin,
  MapPinned,
  Megaphone,
  Percent,
  PiggyBank,
  ReceiptText,
  RefreshCcw,
  ScanSearch,
  ScrollText,
  ShieldCheck,
  Sparkles,
  Store,
  Ticket,
  UserRound,
  Users,
} from "lucide-react";

import { Button } from "@/components/ui/button";
import { Logo } from "@/components/brand/logo";
import { DashboardPreview } from "@/components/landing/dashboard-preview";
import { CrmPreview } from "@/components/landing/crm-preview";
import { InventoryPreview } from "@/components/landing/inventory-preview";
import { FinancePreview } from "@/components/landing/finance-preview";

const NAV_LINKS = [
  { label: "Platform", href: "#platform" },
  { label: "Modules", href: "#modules" },
  { label: "Security", href: "#security" },
  { label: "Company", href: "#company" },
];

const CHIPS = [
  { icon: Layers, label: "17+ Modules" },
  { icon: Store, label: "Multi Store & Branch" },
  { icon: ScanSearch, label: "Real-time DSR & Analytics" },
  { icon: LockKeyhole, label: "Role-based Access Control" },
  { icon: ShieldCheck, label: "Secure & Compliant" },
];

const FEATURES = [
  {
    icon: Users,
    title: "CRM & Leads",
    body: "Capture every enquiry across walk-in, phone, WhatsApp and web, and move it from lead to order on one pipeline.",
  },
  {
    icon: ScanSearch,
    title: "Catalogue & AI search",
    body: "A unified design index across stores — upload a photo or sketch and surface visually similar pieces in seconds.",
  },
  {
    icon: Boxes,
    title: "Inventory & Stock",
    body: "Live stock across branches, aging and dead-stock control, melting and scrap, with reorder signals.",
  },
  {
    icon: Banknote,
    title: "Finance & DSR",
    body: "Daily sales reports, budget-vs-actual and cash-flow forecasting — the day's numbers, every evening.",
  },
  {
    icon: Fingerprint,
    title: "HRMS & Attendance",
    body: "Geo-tagged attendance, rosters, a sales leaderboard and commissions that calculate themselves.",
  },
  {
    icon: PiggyBank,
    title: "Loyalty & Gold Scheme",
    body: "Recurring gold-savings accounts with collection tracking, maturity and default-risk flags.",
  },
];

const PLATFORM_PREVIEWS = [
  {
    Preview: CrmPreview,
    eyebrow: "CRM & pipeline",
    title: "From first enquiry to closed order.",
    body: "Every walk-in, call and WhatsApp lands on one board. Watch each lead move from inquiry to quotation to order — nothing slips between the counters.",
  },
  {
    Preview: InventoryPreview,
    eyebrow: "Inventory & aging",
    title: "Know what's moving — and what isn't.",
    body: "Live stock across every branch, with aging bands and dead-stock flags surfaced automatically, so capital never quietly sits in a display case.",
  },
  {
    Preview: FinancePreview,
    eyebrow: "Finance & DSR",
    title: "The day's numbers, every evening.",
    body: "A daily sales report that writes itself — gross sales, collections, new orders and target progress, ready before you pull the shutters down.",
  },
];

const ROLES = [
  {
    icon: UserRound,
    title: "Salesperson",
    summary: "Their counter, their customers.",
    points: [
      "Own leads & customers",
      "Build quotes in seconds",
      "Geo check-in & personal targets",
    ],
  },
  {
    icon: Store,
    title: "Store Manager",
    summary: "The whole store at a glance.",
    points: [
      "Store dashboard & approvals",
      "Team & attendance",
      "Add & manage salespeople",
    ],
  },
  {
    icon: MapPinned,
    title: "Area Manager",
    summary: "Every store in the region.",
    points: [
      "Multi-store comparison",
      "Provision store managers",
      "Regional finance & DSR",
    ],
  },
  {
    icon: Building2,
    title: "Head Office",
    summary: "One view of the business.",
    points: [
      "Every store, every metric",
      "Roles, policy & discount caps",
      "Full audit trail",
    ],
  },
];

const MODULES = [
  { icon: Users, name: "CRM & Leads" },
  { icon: ReceiptText, name: "Quotation & Pricing" },
  { icon: LayoutDashboard, name: "Departmental Dashboards" },
  { icon: Banknote, name: "Finance & Fund Planning" },
  { icon: ScanSearch, name: "Catalogue & AI Search" },
  { icon: Fingerprint, name: "HRMS & Geo-Attendance" },
  { icon: Footprints, name: "Check-ins & Footfall" },
  { icon: Clock, name: "Timelines & Status" },
  { icon: Boxes, name: "Inventory & Stock" },
  { icon: BarChart3, name: "Reporting & DSR" },
  { icon: Building2, name: "New-Store Setup" },
  { icon: HandCoins, name: "Payment Collection" },
  { icon: Ticket, name: "Ticketing" },
  { icon: RefreshCcw, name: "Returns & Exchange" },
  { icon: Percent, name: "Discounts" },
  { icon: Megaphone, name: "Marketing" },
  { icon: PiggyBank, name: "Loyalty & Gold Scheme" },
];

const SECURITY = [
  {
    icon: LockKeyhole,
    title: "Role-based access",
    body: "Each tier sees only its own scope — from a salesperson's counter up to head office.",
  },
  {
    icon: ScrollText,
    title: "Complete audit trail",
    body: "Every approval, edit and override is recorded and attributable to a person.",
  },
  {
    icon: ShieldCheck,
    title: "Store-scoped isolation",
    body: "Data stays partitioned by store — no branch ever sees another's books.",
  },
  {
    icon: MapPin,
    title: "Geo-verified attendance",
    body: "Check-ins are validated against the store's real location, not just a tap.",
  },
];

const STATS = [
  { value: "17", label: "Operational modules" },
  { value: "4", label: "Role tiers, store-scoped" },
  { value: "1", label: "Platform for every counter" },
];

const FOOTER_COLUMNS = [
  {
    heading: "Platform",
    links: [
      { label: "Overview", href: "#platform" },
      { label: "Modules", href: "#modules" },
      { label: "Security", href: "#security" },
    ],
  },
  {
    heading: "Company",
    links: [
      { label: "About", href: "#platform" },
      { label: "Contact", href: "mailto:tech@caratsense.in" },
      { label: "Sign in", href: "/login" },
    ],
  },
  {
    heading: "Legal",
    links: [
      { label: "Privacy", href: "#" },
      { label: "Terms", href: "#" },
    ],
  },
];

export default function LandingPage() {
  return (
    <div className="landing min-h-dvh font-sans">
      {/* ── Nav ─────────────────────────────────────────────────────── */}
      <header className="absolute inset-x-0 top-0 z-40">
        <div className="mx-auto flex h-[72px] w-full max-w-6xl items-center justify-between px-5 sm:px-8">
          <div className="flex items-center gap-9">
            <Link href="/" aria-label="Éclat Diamonds">
              <Logo className="h-8 w-auto" />
            </Link>
            <nav className="hidden items-center gap-7 lg:flex">
              {NAV_LINKS.map((l) => (
                <a key={l.label} href={l.href} className="landing-nav-link">
                  {l.label}
                </a>
              ))}
            </nav>
          </div>
          <Button
            asChild
            size="sm"
            className="bg-[var(--l-gold)] text-[#0b1f16] shadow-sm hover:bg-[var(--l-gold-dark)]"
          >
            <Link href="/login">Sign in</Link>
          </Button>
        </div>
      </header>

      {/* ── Hero ────────────────────────────────────────────────────── */}
      <section className="landing-gradient relative overflow-hidden">
        <div className="mx-auto grid w-full max-w-6xl grid-cols-1 items-center gap-14 px-5 pb-20 pt-32 sm:px-8 sm:pb-24 sm:pt-36 lg:grid-cols-[1fr_minmax(0,560px)] lg:gap-8">
          {/* LEFT — copy */}
          <div>
            <span className="landing-pill inline-flex items-center gap-2 rounded-full px-3 py-1 text-[12px] font-medium">
              <Sparkles className="h-3.5 w-3.5 text-[var(--l-gold)]" />
              CaratSense Operations Platform
            </span>

            <h1 className="mt-6 max-w-[700px] font-display text-[2.9rem] font-semibold leading-[1.05] tracking-[-0.02em] text-[var(--l-ivory)] sm:text-6xl">
              Run every Éclat Diamonds store from{" "}
              <span className="italic text-[var(--l-gold)]">one place.</span>
            </h1>

            <p className="mt-6 max-w-xl text-[18px] font-normal leading-[1.7] text-[var(--l-ivory-70)]">
              Manage sales, inventory, customers, finance, manufacturing and
              operations from a single platform built for every Éclat Diamonds
              store.
            </p>

            <div className="mt-9 flex flex-wrap items-center gap-3">
              <Button
                asChild
                size="lg"
                className="bg-[var(--l-gold)] text-[#0b1f16] shadow-sm hover:bg-[var(--l-gold-dark)]"
              >
                <Link href="/login">
                  Sign in <ArrowRight className="h-4 w-4" />
                </Link>
              </Button>
              <Button
                asChild
                size="lg"
                className="border border-[color-mix(in_srgb,var(--l-ivory)_28%,transparent)] bg-transparent text-[var(--l-ivory)] hover:bg-[color-mix(in_srgb,var(--l-ivory)_8%,transparent)]"
              >
                <a href="#platform">
                  Explore the platform <ArrowRight className="h-4 w-4" />
                </a>
              </Button>
            </div>
          </div>

          {/* RIGHT — product preview */}
          <div className="w-full">
            <DashboardPreview />
          </div>
        </div>

        {/* ── Feature chips row ─────────────────────────────────────── */}
        <div className="relative z-10 mx-auto w-full max-w-6xl px-5 pb-16 sm:px-8">
          <div className="grid grid-cols-2 gap-px overflow-hidden rounded-xl border border-[var(--l-hairline)] bg-[var(--l-hairline)] sm:grid-cols-3 lg:grid-cols-5">
            {CHIPS.map(({ icon: Icon, label }) => (
              <div
                key={label}
                className="flex items-center gap-2.5 bg-[color-mix(in_srgb,#000_10%,var(--l-surface))] px-4 py-4"
              >
                <span className="flex h-8 w-8 shrink-0 items-center justify-center rounded-lg bg-[color-mix(in_srgb,var(--l-gold)_14%,transparent)] text-[var(--l-gold)]">
                  <Icon className="h-4 w-4" />
                </span>
                <span className="text-[13px] font-medium leading-tight text-[var(--l-ivory)]">
                  {label}
                </span>
              </div>
            ))}
          </div>
        </div>
      </section>

      {/* ── Platform — see it in action ─────────────────────────────── */}
      <section id="platform" className="scroll-mt-24 bg-[var(--l-bg)]">
        <div className="mx-auto w-full max-w-6xl px-5 py-24 sm:px-8">
          <div className="max-w-2xl">
            <p className="landing-eyebrow">See it in action</p>
            <h2 className="mt-3 font-display text-4xl font-semibold tracking-[-0.02em] text-[var(--l-ivory)] sm:text-[2.75rem]">
              A platform you can actually see the shop floor in.
            </h2>
            <p className="mt-4 text-[17px] leading-[1.7] text-[var(--l-ivory-70)]">
              Not another dashboard of charts nobody reads. Real workflows —
              the pipeline, the stock room and the day-book — in one calm,
              connected place.
            </p>
          </div>

          <div className="mt-16 space-y-20 lg:space-y-24">
            {PLATFORM_PREVIEWS.map(({ Preview, eyebrow, title, body }, i) => {
              const textFirst = i % 2 === 1;
              return (
                <div
                  key={eyebrow}
                  className="grid items-center gap-10 lg:grid-cols-2 lg:gap-16"
                >
                  {/* copy */}
                  <div className={textFirst ? "lg:order-2" : "lg:order-1"}>
                    <p className="landing-eyebrow">{eyebrow}</p>
                    <h3 className="mt-3 max-w-md font-display text-[1.9rem] font-semibold leading-[1.15] tracking-[-0.02em] text-[var(--l-ivory)]">
                      {title}
                    </h3>
                    <p className="mt-4 max-w-md text-[16px] leading-[1.7] text-[var(--l-ivory-70)]">
                      {body}
                    </p>
                  </div>
                  {/* preview */}
                  <div className={textFirst ? "lg:order-1" : "lg:order-2"}>
                    <Preview />
                  </div>
                </div>
              );
            })}
          </div>
        </div>
      </section>

      {/* ── Roles — built for every level ───────────────────────────── */}
      <section className="landing-gradient scroll-mt-24">
        <div className="mx-auto w-full max-w-6xl px-5 py-24 sm:px-8">
          <div className="max-w-2xl">
            <p className="landing-eyebrow">Built for every level</p>
            <h2 className="mt-3 font-display text-4xl font-semibold tracking-[-0.02em] text-[var(--l-ivory)] sm:text-[2.75rem]">
              The same screen, tailored to who's looking.
            </h2>
            <p className="mt-4 text-[17px] leading-[1.7] text-[var(--l-ivory-70)]">
              Access follows the hierarchy — each role sees exactly its own
              scope, and nothing it shouldn't.
            </p>
          </div>

          <div className="mt-12 grid gap-5 sm:grid-cols-2 lg:grid-cols-4">
            {ROLES.map((r) => {
              const Icon = r.icon;
              return (
                <div key={r.title} className="landing-card rounded-2xl p-6">
                  <span className="flex h-11 w-11 items-center justify-center rounded-xl bg-[color-mix(in_srgb,var(--l-gold)_14%,transparent)] text-[var(--l-gold)]">
                    <Icon className="h-5 w-5" />
                  </span>
                  <h3 className="mt-4 font-display text-xl font-semibold text-[var(--l-ivory)]">
                    {r.title}
                  </h3>
                  <p className="mt-1 text-[13px] leading-[1.6] text-[var(--l-ivory-55)]">
                    {r.summary}
                  </p>
                  <ul className="mt-4 space-y-2">
                    {r.points.map((p) => (
                      <li
                        key={p}
                        className="flex items-start gap-2 text-[13.5px] leading-[1.5] text-[var(--l-ivory-70)]"
                      >
                        <span className="mt-[7px] h-1 w-1 shrink-0 rounded-full bg-[var(--l-gold)]" />
                        {p}
                      </li>
                    ))}
                  </ul>
                </div>
              );
            })}
          </div>
        </div>
      </section>

      {/* ── Features ────────────────────────────────────────────────── */}
      <section id="features" className="scroll-mt-24 bg-[var(--l-bg)]">
        <div className="mx-auto w-full max-w-6xl px-5 py-24 sm:px-8">
          <div className="max-w-2xl">
            <p className="landing-eyebrow">One platform, every counter</p>
            <h2 className="mt-3 font-display text-4xl font-semibold tracking-[-0.02em] text-[var(--l-ivory)] sm:text-[2.75rem]">
              The whole business, quietly in order.
            </h2>
            <p className="mt-4 text-[17px] leading-[1.7] text-[var(--l-ivory-70)]">
              Seventeen modules that share one source of truth — so a
              salesperson, a store manager and the owner each see exactly what
              they need.
            </p>
          </div>

          <div className="mt-12 grid gap-5 sm:grid-cols-2 lg:grid-cols-3">
            {FEATURES.map((f) => {
              const Icon = f.icon;
              return (
                <div
                  key={f.title}
                  className="landing-card group rounded-2xl p-6 transition-all duration-200 hover:-translate-y-0.5 hover:border-[color-mix(in_srgb,var(--l-gold)_45%,transparent)]"
                >
                  <span className="flex h-11 w-11 items-center justify-center rounded-xl bg-[color-mix(in_srgb,var(--l-gold)_14%,transparent)] text-[var(--l-gold)]">
                    <Icon className="h-5 w-5" />
                  </span>
                  <h3 className="mt-4 font-display text-xl font-semibold text-[var(--l-ivory)]">
                    {f.title}
                  </h3>
                  <p className="mt-2 text-[14px] leading-[1.7] text-[var(--l-ivory-70)]">
                    {f.body}
                  </p>
                </div>
              );
            })}
          </div>
        </div>
      </section>

      {/* ── Modules — all 17 ────────────────────────────────────────── */}
      <section id="modules" className="landing-gradient scroll-mt-24">
        <div className="mx-auto w-full max-w-6xl px-5 py-24 sm:px-8">
          <div className="max-w-2xl">
            <p className="landing-eyebrow">Everything, in one system</p>
            <h2 className="mt-3 font-display text-4xl font-semibold tracking-[-0.02em] text-[var(--l-ivory)] sm:text-[2.75rem]">
              Seventeen modules, one source of truth.
            </h2>
            <p className="mt-4 text-[17px] leading-[1.7] text-[var(--l-ivory-70)]">
              From the shop floor to the back office — sales, people, inventory
              and finance, all speaking the same language.
            </p>
          </div>

          <div className="mt-12 grid grid-cols-2 gap-px overflow-hidden rounded-2xl border border-[var(--l-hairline)] bg-[var(--l-hairline)] sm:grid-cols-3 lg:grid-cols-4">
            {MODULES.map(({ icon: Icon, name }) => (
              <div
                key={name}
                className="flex items-center gap-3 bg-[var(--l-surface)] px-4 py-4 transition-colors hover:bg-[color-mix(in_srgb,var(--l-gold)_7%,var(--l-surface))]"
              >
                <span className="flex h-9 w-9 shrink-0 items-center justify-center rounded-lg bg-[color-mix(in_srgb,var(--l-gold)_14%,transparent)] text-[var(--l-gold)]">
                  <Icon className="h-[18px] w-[18px]" />
                </span>
                <span className="text-[13.5px] font-medium leading-tight text-[var(--l-ivory)]">
                  {name}
                </span>
              </div>
            ))}
          </div>
        </div>
      </section>

      {/* ── Security ────────────────────────────────────────────────── */}
      <section id="security" className="scroll-mt-24 bg-[var(--l-bg)]">
        <div className="mx-auto w-full max-w-6xl px-5 py-24 sm:px-8">
          <div className="grid gap-12 lg:grid-cols-[minmax(0,380px)_1fr] lg:gap-16">
            <div>
              <span className="flex h-11 w-11 items-center justify-center rounded-xl bg-[color-mix(in_srgb,var(--l-gold)_14%,transparent)] text-[var(--l-gold)]">
                <ShieldCheck className="h-5 w-5" />
              </span>
              <p className="landing-eyebrow mt-6">Secure by design</p>
              <h2 className="mt-3 font-display text-4xl font-semibold tracking-[-0.02em] text-[var(--l-ivory)] sm:text-[2.75rem]">
                Trust, built into the structure.
              </h2>
              <p className="mt-4 max-w-md text-[17px] leading-[1.7] text-[var(--l-ivory-70)]">
                Multi-store retail runs on accountability. Access, records and
                data isolation are part of the foundation — not an afterthought.
              </p>
            </div>

            <div className="grid gap-5 sm:grid-cols-2">
              {SECURITY.map((s) => {
                const Icon = s.icon;
                return (
                  <div key={s.title} className="landing-card rounded-2xl p-6">
                    <span className="flex h-10 w-10 items-center justify-center rounded-lg bg-[color-mix(in_srgb,var(--l-gold)_14%,transparent)] text-[var(--l-gold)]">
                      <Icon className="h-[18px] w-[18px]" />
                    </span>
                    <h3 className="mt-4 font-display text-lg font-semibold text-[var(--l-ivory)]">
                      {s.title}
                    </h3>
                    <p className="mt-2 text-[13.5px] leading-[1.65] text-[var(--l-ivory-70)]">
                      {s.body}
                    </p>
                  </div>
                );
              })}
            </div>
          </div>
        </div>
      </section>

      {/* ── Stats band ──────────────────────────────────────────────── */}
      <section className="landing-gradient">
        <div className="mx-auto grid w-full max-w-6xl gap-8 px-5 py-16 sm:grid-cols-3 sm:px-8">
          {STATS.map((s) => (
            <div key={s.label} className="text-center">
              <div className="num text-[2.75rem] font-semibold text-[var(--l-gold)]">
                {s.value}
              </div>
              <div className="mt-2 text-sm text-[var(--l-ivory-70)]">
                {s.label}
              </div>
            </div>
          ))}
        </div>
      </section>

      {/* ── Closing CTA ─────────────────────────────────────────────── */}
      <section className="bg-[var(--l-bg)]">
        <div className="mx-auto w-full max-w-6xl px-5 py-24 text-center sm:px-8">
          <Store className="mx-auto h-7 w-7 text-[var(--l-gold)]" />
          <h2 className="mt-5 font-display text-4xl font-semibold tracking-[-0.02em] text-[var(--l-ivory)]">
            Ready when you open the shutters.
          </h2>
          <p className="mx-auto mt-4 max-w-md text-[16px] leading-[1.7] text-[var(--l-ivory-70)]">
            Sign in to your store and pick up the day where you left it.
          </p>
          <div className="mt-8">
            <Button
              asChild
              size="lg"
              className="bg-[var(--l-gold)] text-[#0b1f16] shadow-sm hover:bg-[var(--l-gold-dark)]"
            >
              <Link href="/login">
                Sign in <ArrowRight className="h-4 w-4" />
              </Link>
            </Button>
          </div>
        </div>
      </section>

      {/* ── Footer ──────────────────────────────────────────────────── */}
      <footer
        id="company"
        className="scroll-mt-24 border-t border-[var(--l-hairline)] bg-[var(--l-bg)]"
      >
        <div className="mx-auto w-full max-w-6xl px-5 py-16 sm:px-8">
          <div className="grid gap-10 sm:grid-cols-2 lg:grid-cols-[1.5fr_1fr_1fr_1fr]">
            {/* brand blurb */}
            <div className="max-w-xs">
              <Logo className="h-7 w-auto" />
              <p className="mt-4 text-[14px] leading-[1.7] text-[var(--l-ivory-70)]">
                Éclat Diamonds operations, unified — CaratSense.
              </p>
            </div>

            {/* link columns */}
            {FOOTER_COLUMNS.map((col) => (
              <div key={col.heading}>
                <h4 className="text-[12px] font-medium uppercase tracking-[0.16em] text-[var(--l-ivory-55)]">
                  {col.heading}
                </h4>
                <ul className="mt-4 space-y-2.5">
                  {col.links.map((link) => {
                    const isInternal = link.href.startsWith("/");
                    const cls =
                      "text-[14px] text-[var(--l-ivory-70)] transition-colors hover:text-[var(--l-gold)]";
                    return (
                      <li key={link.label}>
                        {isInternal ? (
                          <Link href={link.href} className={cls}>
                            {link.label}
                          </Link>
                        ) : (
                          <a href={link.href} className={cls}>
                            {link.label}
                          </a>
                        )}
                      </li>
                    );
                  })}
                </ul>
              </div>
            ))}
          </div>

          <div className="mt-12 flex flex-col items-center justify-between gap-3 border-t border-[var(--l-hairline)] pt-6 text-[13px] text-[var(--l-ivory-55)] sm:flex-row">
            <span>© 2026 Éclat Diamonds. All rights reserved.</span>
            <span className="flex items-center gap-2">
              CaratSense · Built for the counter
            </span>
          </div>
        </div>
      </footer>
    </div>
  );
}
