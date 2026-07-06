import Link from "next/link";
import {
  ArrowRight,
  Boxes,
  Banknote,
  Fingerprint,
  PiggyBank,
  ScanSearch,
  ShieldCheck,
  Sparkles,
  Store,
  Users,
} from "lucide-react";

import { Button } from "@/components/ui/button";
import { Logo } from "@/components/brand/logo";

const TRUST = [
  "17 modules",
  "Multi-store",
  "Real-time DSR",
  "Role-based access",
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
    <div className="min-h-dvh bg-background">
      {/* ── Header ──────────────────────────────────────────────────── */}
      <header className="emerald-panel sticky top-0 z-30">
        <div className="mx-auto flex h-16 w-full max-w-6xl items-center justify-between px-5 sm:px-8">
          <Link href="/" aria-label="Éclat Diamonds">
            <Logo className="h-9 w-auto" />
          </Link>
          <Button asChild variant="gold" size="sm">
            <Link href="/login">Sign in</Link>
          </Button>
        </div>
      </header>

      {/* ── Hero ────────────────────────────────────────────────────── */}
      <section className="emerald-panel relative overflow-hidden">
        <div className="mx-auto w-full max-w-6xl px-5 py-20 sm:px-8 sm:py-28">
          <span className="inline-flex items-center gap-2 rounded-full border border-[color-mix(in_srgb,var(--gold)_45%,transparent)] px-3 py-1 text-[11px] font-semibold uppercase tracking-[0.18em] text-brand-foreground/80">
            <Sparkles className="h-3.5 w-3.5 text-[var(--gold)]" />
            CaratSense operations platform
          </span>
          <h1 className="mt-6 max-w-3xl font-display text-5xl font-medium leading-[1.05] text-brand-foreground sm:text-6xl">
            Run every Éclat Diamonds store from one place.
          </h1>
          <p className="mt-6 max-w-xl text-lg leading-relaxed text-brand-foreground/75">
            Sales, catalogue, inventory, finance and people — unified across
            branches, scoped by role, and built for the pace of a live shop floor.
          </p>
          <div className="mt-9 flex flex-wrap items-center gap-3">
            <Button asChild variant="gold" size="lg">
              <Link href="/login">
                Sign in <ArrowRight className="h-4 w-4" />
              </Link>
            </Button>
            <Button
              asChild
              size="lg"
              className="border border-[color-mix(in_srgb,var(--brand-foreground)_35%,transparent)] bg-transparent text-brand-foreground hover:bg-[color-mix(in_srgb,var(--brand-foreground)_10%,transparent)]"
            >
              <a href="#features">Explore the platform</a>
            </Button>
          </div>

          {/* trust strip */}
          <div className="mt-14 flex flex-wrap items-center gap-x-6 gap-y-3 border-t border-[color-mix(in_srgb,var(--brand-foreground)_15%,transparent)] pt-6">
            {TRUST.map((t) => (
              <span
                key={t}
                className="flex items-center gap-2 text-sm text-brand-foreground/70"
              >
                <ShieldCheck className="h-4 w-4 text-[var(--gold)]" />
                {t}
              </span>
            ))}
          </div>
        </div>
      </section>

      {/* ── Features ────────────────────────────────────────────────── */}
      <section id="features" className="mx-auto w-full max-w-6xl px-5 py-20 sm:px-8 sm:py-24">
        <div className="max-w-2xl">
          <p className="text-[11px] font-semibold uppercase tracking-[0.18em] text-gold-strong">
            One platform, every counter
          </p>
          <h2 className="mt-3 font-display text-4xl font-medium tracking-tight">
            The whole business, quietly in order.
          </h2>
          <p className="mt-4 text-base leading-relaxed text-muted-foreground">
            Seventeen modules that share one source of truth — so a salesperson,
            a store manager and the owner each see exactly what they need.
          </p>
        </div>

        <div className="mt-12 grid gap-5 sm:grid-cols-2 lg:grid-cols-3">
          {FEATURES.map((f) => {
            const Icon = f.icon;
            return (
              <div
                key={f.title}
                className="facet-top group rounded-xl border bg-card p-6 shadow-sm transition-all duration-200 hover:-translate-y-0.5 hover:shadow-md"
              >
                <span className="flex h-11 w-11 items-center justify-center rounded-xl bg-[color-mix(in_srgb,var(--gold)_14%,transparent)] text-gold-strong">
                  <Icon className="h-5 w-5" />
                </span>
                <h3 className="mt-4 font-display text-xl font-medium">{f.title}</h3>
                <p className="mt-2 text-sm leading-relaxed text-muted-foreground">
                  {f.body}
                </p>
              </div>
            );
          })}
        </div>
      </section>

      {/* ── Stats band ──────────────────────────────────────────────── */}
      <section className="emerald-panel">
        <div className="mx-auto grid w-full max-w-6xl gap-8 px-5 py-16 sm:grid-cols-3 sm:px-8">
          {STATS.map((s) => (
            <div key={s.label} className="text-center">
              <div className="font-display text-5xl font-medium text-[var(--gold)]">
                {s.value}
              </div>
              <div className="mt-2 text-sm text-brand-foreground/70">
                {s.label}
              </div>
            </div>
          ))}
        </div>
      </section>

      {/* ── Closing CTA ─────────────────────────────────────────────── */}
      <section className="mx-auto w-full max-w-6xl px-5 py-20 text-center sm:px-8 sm:py-24">
        <Store className="mx-auto h-7 w-7 text-gold-strong" />
        <h2 className="mt-5 font-display text-4xl font-medium tracking-tight">
          Ready when you open the shutters.
        </h2>
        <p className="mx-auto mt-4 max-w-md text-base text-muted-foreground">
          Sign in to your store and pick up the day where you left it.
        </p>
        <div className="mt-8">
          <Button asChild variant="gold" size="lg">
            <Link href="/login">
              Sign in <ArrowRight className="h-4 w-4" />
            </Link>
          </Button>
        </div>
      </section>

      {/* ── Footer ──────────────────────────────────────────────────── */}
      <footer className="emerald-panel">
        <div className="mx-auto flex w-full max-w-6xl flex-col items-center justify-between gap-3 px-5 py-8 text-sm text-brand-foreground/60 sm:flex-row sm:px-8">
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
