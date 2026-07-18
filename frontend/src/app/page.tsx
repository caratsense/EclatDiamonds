import Link from "next/link";
import {
  ArrowRight,
  Boxes,
  Banknote,
  Fingerprint,
  Layers,
  LockKeyhole,
  PiggyBank,
  ScanSearch,
  ShieldCheck,
  Sparkles,
  Store,
  Users,
} from "lucide-react";

import { Button } from "@/components/ui/button";
import { Logo } from "@/components/brand/logo";
import { DashboardPreview } from "@/components/landing/dashboard-preview";

const NAV_LINKS = [
  { label: "Platform", href: "#features", caret: true },
  { label: "Modules", href: "#features", caret: false },
  { label: "Security", href: "#security", caret: false },
  { label: "Resources", href: "#features", caret: true },
  { label: "Company", href: "#company", caret: false },
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

const STATS = [
  { value: "17", label: "Operational modules" },
  { value: "4", label: "Role tiers, store-scoped" },
  { value: "1", label: "Platform for every counter" },
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
                  {l.caret ? <span className="ml-1 text-[10px]">▾</span> : null}
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
                <a href="#features">
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

      {/* ── Features ────────────────────────────────────────────────── */}
      <section
        id="features"
        className="bg-[var(--l-bg)] scroll-mt-20"
      >
        <div className="mx-auto w-full max-w-6xl px-5 py-24 sm:px-8">
          <div className="max-w-2xl">
            <p className="text-[12px] font-medium uppercase tracking-[0.18em] text-[var(--l-gold)]">
              One platform, every counter
            </p>
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

      {/* ── Stats band ──────────────────────────────────────────────── */}
      <section id="security" className="landing-gradient scroll-mt-20">
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
      <section
        id="company"
        className="bg-[var(--l-bg)] scroll-mt-20"
      >
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
      <footer className="border-t border-[var(--l-hairline)] bg-[var(--l-bg)]">
        <div className="mx-auto flex w-full max-w-6xl flex-col items-center justify-between gap-3 px-5 py-8 text-sm text-[var(--l-ivory-55)] sm:flex-row sm:px-8">
          <span className="flex items-center gap-2.5">
            <Logo className="h-6 w-auto" />
            <span>· CaratSense</span>
          </span>
          <span>© 2026 Éclat Diamonds. All rights reserved.</span>
        </div>
      </footer>
    </div>
  );
}
