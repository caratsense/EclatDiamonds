import Image from "next/image";
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
  Gem,
  HandCoins,
  Heart,
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
  { label: "Collections", href: "#collections" },
  { label: "Modules", href: "#modules" },
  { label: "Security", href: "#security" },
  { label: "Company", href: "#company" },
];

const CHIPS = [
  { icon: Layers, label: "17+ Operational Modules" },
  { icon: Store, label: "Multi Store & Branch Sync" },
  { icon: ScanSearch, label: "AI Visual & Attribute Search" },
  { icon: LockKeyhole, label: "Role-Aware Cost Protection" },
  { icon: ShieldCheck, label: "100% BIS & GIA Compliant" },
];

const FEATURED_COLLECTION = [
  {
    name: "Lumière Teardrop",
    metal: "18K White Gold · VVS Diamond",
    price: "₹1,42,000",
    image: "/images/diamond_pendant_hero.png",
    tag: "Solitaire",
  },
  {
    name: "Eternal Temple Lakshmi",
    metal: "22K Antique Gold · 62.4g",
    price: "₹4,98,000",
    image: "/images/jewelry_editorial_hero.png",
    tag: "Bridal",
  },
  {
    name: "Blush Rose-Gold Bangles",
    metal: "18K Rose Gold · 1.20 ct Pavé",
    price: "₹1,68,000",
    image: "/images/luxury_jewelry_hero.png",
    tag: "Bangles",
  },
  {
    name: "Aurora Solitaire Ring",
    metal: "Platinum · 0.75 ct VS Diamond",
    price: "₹1,21,000",
    image: "/images/diamond_pendant_hero.png",
    tag: "Rings",
  },
];

const LUXURY_GUARANTEES = [
  {
    icon: Gem,
    title: "PREMIUM MATERIALS",
    desc: "Crafted with 22K/18K Gold and VVS-VS Certified Diamonds.",
  },
  {
    icon: ShieldCheck,
    title: "LIFETIME WARRANTY",
    desc: "100% BIS Hallmarked & GIA/IGI Authenticated.",
  },
  {
    icon: Store,
    title: "LUXURY PACKAGING",
    desc: "Delivered in signature Éclat velvet vaults.",
  },
  {
    icon: RefreshCcw,
    title: "EASY EXCHANGE",
    desc: "100% Gold value credit on trade-in & buyback.",
  },
];

const FEATURES = [
  {
    icon: Users,
    title: "CRM & Pipeline",
    body: "Capture every enquiry across walk-in, phone, WhatsApp and web, and move it from lead to custom order on one unified board.",
  },
  {
    icon: ScanSearch,
    title: "Catalogue & AI Search",
    body: "Unified design index across branches — upload a customer's reference photo or sketch and surface visually similar pieces in seconds.",
  },
  {
    icon: Boxes,
    title: "Inventory & Stock Aging",
    body: "Live stock levels across branches, dead-stock flags, aging bands, scrap recovery, and reorder signals.",
  },
  {
    icon: Banknote,
    title: "Finance & DSR",
    body: "Automated daily sales reports, budget-vs-actual tracking, and cash-flow forecasting — ready before shutters close.",
  },
  {
    icon: Fingerprint,
    title: "HRMS & Geo-Attendance",
    body: "Shift-aware geo-attendance, rosters, 3x late flags, sales leaderboards, and auto-computed commissions.",
  },
  {
    icon: PiggyBank,
    title: "Loyalty & Referral Wallet",
    body: "Referral wallet ledger tracking 5% referee diamond discount + 5% referrer credit per Referral Program.xlsx.",
  },
];

const PLATFORM_PREVIEWS = [
  {
    Preview: CrmPreview,
    eyebrow: "CRM & pipeline",
    title: "From first enquiry to closed custom order.",
    body: "Every walk-in, call, and WhatsApp message lands on one board. Watch each lead move from inquiry to quotation to order — nothing slips between counters.",
  },
  {
    Preview: InventoryPreview,
    eyebrow: "Inventory & aging",
    title: "Know what's moving — and what isn't.",
    body: "Live stock across every branch, with aging bands and dead-stock flags surfaced automatically so capital never quietly sits in a display case.",
  },
  {
    Preview: FinancePreview,
    eyebrow: "Finance & DSR",
    title: "The day's numbers, every evening.",
    body: "A daily sales report that writes itself — gross sales, collections, new orders, and target progress ready before pulling shutters down.",
  },
];

const ROLES = [
  {
    icon: UserRound,
    title: "Salesperson",
    summary: "Their counter, their customers.",
    points: [
      "Own leads & follow-up reminders",
      "Build quotes & custom orders in seconds",
      "Geo check-in & selling-price-only view",
    ],
  },
  {
    icon: Store,
    title: "Store Manager",
    summary: "The whole store at a glance.",
    points: [
      "Store DSR & discount approvals (≤5%/10%)",
      "Team attendance & manual mark",
      "Add & manage store sales staff",
    ],
  },
  {
    icon: MapPinned,
    title: "Area Manager",
    summary: "Every store in the region.",
    points: [
      "Multi-store side-by-side comparison",
      "Cost Price & Margin transparency",
      "Regional finance & escalated approvals",
    ],
  },
  {
    icon: Building2,
    title: "Head Office",
    summary: "One view of the business.",
    points: [
      "Every store, every metric, pan-India",
      "@ Kaccha rough estimate (0 GST) mode",
      "Full audit trail & global discount caps",
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
  { icon: PiggyBank, name: "Loyalty & Referral" },
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
    body: "Every approval, edit, and override is recorded and attributable to a specific staff member.",
  },
  {
    icon: ShieldCheck,
    title: "Store-scoped isolation",
    body: "Data stays partitioned by store — no branch ever sees another's internal books.",
  },
  {
    icon: MapPin,
    title: "Geo-verified attendance",
    body: "Check-ins are validated against the store's physical coordinates within a 50–100m radius.",
  },
];

const STATS = [
  { value: "17", label: "Operational modules" },
  { value: "4", label: "Role tiers, store-scoped" },
  { value: "100%", label: "BIS & GIA Compliant" },
];

export default function LandingPage() {
  return (
    <div className="landing min-h-dvh bg-[#071e16] text-[#f6f3ed] font-sans selection:bg-[#c8a24f] selection:text-[#071e16]">
      {/* ── Floating Pill Navigation (Reference Image 1 Style) ──────────────────────── */}
      <header className="fixed inset-x-0 top-4 z-50 flex justify-center px-4">
        <div className="flex h-14 w-full max-w-5xl items-center justify-between rounded-full border border-[#c8a24f]/30 bg-[#0c261c]/80 px-6 backdrop-blur-md shadow-2xl">
          <Link href="/" aria-label="Éclat Diamonds" className="flex items-center gap-2">
            <Logo className="h-7 w-auto" />
          </Link>
          <nav className="hidden items-center gap-8 md:flex">
            {NAV_LINKS.map((l) => (
              <a
                key={l.label}
                href={l.href}
                className="text-xs font-medium uppercase tracking-wider text-[#f6f3ed]/70 transition-colors hover:text-[#c8a24f]"
              >
                {l.label}
              </a>
            ))}
          </nav>
          <Button
            asChild
            size="sm"
            className="rounded-full bg-[#c8a24f] px-5 text-xs font-semibold text-[#071e16] shadow-md hover:bg-[#b8903c]"
          >
            <Link href="/login">Sign in</Link>
          </Button>
        </div>
      </header>

      {/* ── High-Fashion Editorial Hero (Reference Image 1 & 2 Style) ───────────────── */}
      <section className="relative overflow-hidden pt-28 pb-20 lg:pt-36 lg:pb-28">
        {/* Subtle Silk Glow & Background Texture */}
        <div className="absolute inset-0 z-0 opacity-25">
          <Image
            src="/images/luxury_jewelry_hero.png"
            alt="Jewelry backdrop"
            fill
            className="object-cover object-center"
            priority
          />
        </div>
        <div className="absolute inset-0 z-0 bg-gradient-to-b from-[#071e16] via-[#071e16]/90 to-[#071e16]" />

        <div className="relative z-10 mx-auto max-w-6xl px-5 sm:px-8">
          <div className="grid grid-cols-1 items-center gap-12 lg:grid-cols-12 lg:gap-8">
            {/* Left — High-Fashion Copy & Headline */}
            <div className="lg:col-span-7 space-y-6">
              <span className="inline-flex items-center gap-2 rounded-full border border-[#c8a24f]/30 bg-[#c8a24f]/10 px-4 py-1.5 text-xs font-mono text-[#c8a24f]">
                <Sparkles className="h-3.5 w-3.5" />
                ÉCLAT DIAMONDS · CARATSENSE OPERATING SYSTEM
              </span>

              <h1 className="font-display text-4xl font-semibold leading-[1.05] tracking-[-0.02em] text-[#f6f3ed] sm:text-6xl lg:text-7xl">
                delicate <br />
                <span className="italic text-[#c8a24f] font-serif">jewelry</span> & operations.
              </h1>

              <p className="max-w-lg text-lg font-normal leading-[1.7] text-[#f6f3ed]/75">
                The unified front-of-house platform for Éclat Diamonds — managing sales, inventory, custom orders, finance, and team in one serene luxury workspace.
              </p>

              <div className="flex flex-wrap items-center gap-4 pt-2">
                <Button
                  asChild
                  size="lg"
                  className="rounded-full bg-[#c8a24f] px-8 text-sm font-semibold text-[#071e16] shadow-lg hover:bg-[#b8903c]"
                >
                  <Link href="/login">
                    Sign in to counter <ArrowRight className="h-4 w-4 ml-1" />
                  </Link>
                </Button>
                <Button
                  asChild
                  size="lg"
                  variant="outline"
                  className="rounded-full border-[#1b3a2c] bg-transparent text-sm font-medium text-[#f6f3ed] hover:border-[#c8a24f]/50 hover:bg-[#0c261c]"
                >
                  <a href="#collections">Explore Collections</a>
                </Button>
              </div>
            </div>

            {/* Right — Capsule Arch Photo Mask & Floating Cards (Reference Image 1 & 2 Style) */}
            <div className="lg:col-span-5 relative flex justify-center">
              <div className="relative w-full max-w-sm">
                {/* Capsule Arch Image Container */}
                <div className="relative aspect-[3/4] w-full overflow-hidden rounded-[140px] border-2 border-[#c8a24f]/30 shadow-2xl">
                  <Image
                    src="/images/jewelry_editorial_hero.png"
                    alt="Editorial Diamond Model"
                    fill
                    className="object-cover object-center"
                    priority
                  />
                  <div className="absolute inset-0 bg-gradient-to-t from-[#071e16]/80 via-transparent to-transparent" />
                </div>

                {/* Floating Glassmorphism Cards */}
                <div className="absolute -bottom-6 -left-6 z-20 rounded-2xl border border-[#c8a24f]/40 bg-[#0c261c]/90 p-4 shadow-2xl backdrop-blur-md">
                  <p className="text-xs font-mono uppercase tracking-wider text-[#c8a24f]">Live Showroom Status</p>
                  <p className="mt-1 text-sm font-semibold text-[#f6f3ed]">Surat Main · Bandra · CG Road</p>
                  <p className="mt-0.5 text-[11px] text-emerald-400">3 Stores Synced & Active</p>
                </div>

                <div className="absolute -top-4 -right-4 z-20 rounded-2xl border border-[#c8a24f]/40 bg-[#0c261c]/90 p-3.5 shadow-2xl backdrop-blur-md">
                  <div className="flex items-center gap-2">
                    <span className="flex h-8 w-8 items-center justify-center rounded-lg bg-[#c8a24f]/20 text-[#c8a24f]">
                      <Gem className="h-4 w-4" />
                    </span>
                    <div>
                      <p className="text-xs font-semibold text-[#f6f3ed]">100% BIS Hallmarked</p>
                      <p className="text-[10px] text-[#f6f3ed]/60">GIA Certified Solitaires</p>
                    </div>
                  </div>
                </div>
              </div>
            </div>
          </div>
        </div>

        {/* ── Feature Chips Row ──────────────────────────────────────── */}
        <div className="relative z-10 mx-auto max-w-6xl px-5 pt-16 sm:px-8">
          <div className="grid grid-cols-2 gap-px overflow-hidden rounded-2xl border border-[#1b3a2c] bg-[#1b3a2c] sm:grid-cols-3 lg:grid-cols-5">
            {CHIPS.map(({ icon: Icon, label }) => (
              <div
                key={label}
                className="flex items-center gap-3 bg-[#0c261c] px-4 py-4 transition-colors hover:bg-[#071e16]"
              >
                <span className="flex h-8 w-8 shrink-0 items-center justify-center rounded-lg bg-[#c8a24f]/15 text-[#c8a24f]">
                  <Icon className="h-4 w-4" />
                </span>
                <span className="text-xs font-medium leading-tight text-[#f6f3ed]/90">
                  {label}
                </span>
              </div>
            ))}
          </div>
        </div>
      </section>

      {/* ── Editorial Quote Section (Reference Image 2 Style) ────────────────────────── */}
      <section className="border-y border-[#1b3a2c] bg-[#0c261c] py-16 text-center">
        <div className="mx-auto max-w-3xl px-6">
          <p className="font-serif italic text-2xl sm:text-3xl font-normal leading-relaxed text-[#f6f3ed]/90">
            &ldquo;Jewelry is the most transformative thing you can wear. Crafted with precision, worn with confidence.&rdquo;
          </p>
          <div className="mt-4 flex items-center justify-center gap-2">
            <span className="h-px w-8 bg-[#c8a24f]" />
            <span className="text-xs font-mono uppercase tracking-[0.2em] text-[#c8a24f]">
              Éclat Diamonds Philosophy
            </span>
            <span className="h-px w-8 bg-[#c8a24f]" />
          </div>
        </div>
      </section>

      {/* ── Deep Emerald Silk Showcase & Glassmorphism Cards (Reference Image 3 Style) ── */}
      <section id="collections" className="relative scroll-mt-24 py-24 bg-[#071e16]">
        <div className="mx-auto max-w-6xl px-5 sm:px-8">
          {/* Section Header */}
          <div className="flex flex-col md:flex-row md:items-end justify-between gap-4 mb-14">
            <div>
              <span className="text-xs font-mono uppercase tracking-[0.2em] text-[#c8a24f]">
                Featured Masterpieces
              </span>
              <h2 className="mt-2 font-display text-3xl sm:text-4xl font-semibold text-[#f6f3ed]">
                Diamond & Gold <span className="italic text-[#c8a24f]">Collections</span>
              </h2>
            </div>
            <p className="max-w-md text-sm text-[#f6f3ed]/70">
              Live catalogue synchronized across Surat, Mumbai, and Ahmedabad stores with real-time stock status and AI visual lookup.
            </p>
          </div>

          {/* Dark Glassmorphism Featured Grid (Reference Image 3 Style) */}
          <div className="grid grid-cols-1 gap-6 sm:grid-cols-2 lg:grid-cols-4">
            {FEATURED_COLLECTION.map((item) => (
              <div
                key={item.name}
                className="group relative overflow-hidden rounded-2xl border border-[#1b3a2c] bg-[#0c261c] p-4 transition-all duration-300 hover:-translate-y-1 hover:border-[#c8a24f]/50 hover:shadow-2xl"
              >
                {/* Image Container */}
                <div className="relative aspect-square w-full overflow-hidden rounded-xl bg-[#071e16]">
                  <Image
                    src={item.image}
                    alt={item.name}
                    fill
                    className="object-cover object-center transition-transform duration-500 group-hover:scale-105"
                  />
                  <span className="absolute top-3 left-3 rounded-full bg-[#071e16]/80 px-2.5 py-0.5 text-[10px] font-mono text-[#c8a24f] border border-[#c8a24f]/30">
                    {item.tag}
                  </span>
                  <button
                    type="button"
                    aria-label="Save to wishlist"
                    className="absolute top-3 right-3 flex h-8 w-8 items-center justify-center rounded-full bg-[#071e16]/80 text-[#f6f3ed]/70 transition-colors hover:text-[#c8a24f]"
                  >
                    <Heart className="h-4 w-4" />
                  </button>
                </div>

                {/* Content */}
                <div className="mt-4 space-y-1">
                  <h3 className="font-display text-lg font-semibold text-[#f6f3ed]">
                    {item.name}
                  </h3>
                  <p className="text-xs text-[#f6f3ed]/60">{item.metal}</p>
                  <div className="pt-2 flex items-center justify-between">
                    <span className="font-mono text-base font-bold text-[#c8a24f]">
                      {item.price}
                    </span>
                    <Link
                      href="/catalogue"
                      className="inline-flex items-center gap-1 text-xs font-medium text-[#f6f3ed]/80 hover:text-[#c8a24f]"
                    >
                      View in Store <ArrowRight className="h-3.5 w-3.5" />
                    </Link>
                  </div>
                </div>
              </div>
            ))}
          </div>

          {/* Floating Luxury Guarantee Bar (Reference Image 3 Style) */}
          <div className="mt-16 grid grid-cols-1 gap-px overflow-hidden rounded-2xl border border-[#1b3a2c] bg-[#1b3a2c] sm:grid-cols-2 lg:grid-cols-4">
            {LUXURY_GUARANTEES.map(({ icon: Icon, title, desc }) => (
              <div key={title} className="bg-[#0c261c] p-6 text-center">
                <span className="mx-auto flex h-10 w-10 items-center justify-center rounded-full bg-[#c8a24f]/15 text-[#c8a24f]">
                  <Icon className="h-5 w-5" />
                </span>
                <h4 className="mt-3 font-mono text-xs font-bold tracking-wider text-[#f6f3ed]">
                  {title}
                </h4>
                <p className="mt-1 text-xs text-[#f6f3ed]/60">{desc}</p>
              </div>
            ))}
          </div>
        </div>
      </section>

      {/* ── Interactive Platform Preview ─────────────────────────────── */}
      <section id="platform" className="scroll-mt-24 py-24 bg-[#071e16] border-t border-[#1b3a2c]">
        <div className="mx-auto max-w-6xl px-5 sm:px-8">
          <div className="max-w-2xl">
            <span className="text-xs font-mono uppercase tracking-[0.2em] text-[#c8a24f]">
              Shop Floor Parity
            </span>
            <h2 className="mt-2 font-display text-3xl sm:text-4xl font-semibold text-[#f6f3ed]">
              A platform built for every counter.
            </h2>
            <p className="mt-3 text-base text-[#f6f3ed]/70">
              Not another dashboard of charts nobody reads. Real workflows — the pipeline, the stock room, and the day-book — in one calm, connected place.
            </p>
          </div>

          <div className="mt-14 w-full">
            <DashboardPreview />
          </div>

          <div className="mt-20 space-y-20">
            {PLATFORM_PREVIEWS.map(({ Preview, eyebrow, title, body }, i) => {
              const textFirst = i % 2 === 1;
              return (
                <div
                  key={eyebrow}
                  className="grid items-center gap-10 lg:grid-cols-2 lg:gap-16"
                >
                  <div className={textFirst ? "lg:order-2" : "lg:order-1"}>
                    <span className="text-xs font-mono uppercase tracking-wider text-[#c8a24f]">
                      {eyebrow}
                    </span>
                    <h3 className="mt-2 font-display text-2xl font-semibold leading-snug text-[#f6f3ed]">
                      {title}
                    </h3>
                    <p className="mt-3 text-sm leading-relaxed text-[#f6f3ed]/70">
                      {body}
                    </p>
                  </div>
                  <div className={textFirst ? "lg:order-1" : "lg:order-2"}>
                    <Preview />
                  </div>
                </div>
              );
            })}
          </div>
        </div>
      </section>

      {/* ── Roles Section ───────────────────────────────────────────── */}
      <section className="py-24 bg-[#0c261c] border-t border-[#1b3a2c]">
        <div className="mx-auto max-w-6xl px-5 sm:px-8">
          <div className="max-w-2xl">
            <span className="text-xs font-mono uppercase tracking-[0.2em] text-[#c8a24f]">
              Role-Based Access Control
            </span>
            <h2 className="mt-2 font-display text-3xl sm:text-4xl font-semibold text-[#f6f3ed]">
              Tailored to who is looking.
            </h2>
            <p className="mt-3 text-sm text-[#f6f3ed]/70">
              Access follows hierarchy — each role sees exactly its own scope, and nothing it shouldn&apos;t.
            </p>
          </div>

          <div className="mt-12 grid gap-6 sm:grid-cols-2 lg:grid-cols-4">
            {ROLES.map((r) => {
              const Icon = r.icon;
              return (
                <div
                  key={r.title}
                  className="rounded-2xl border border-[#1b3a2c] bg-[#071e16] p-6 transition-all hover:border-[#c8a24f]/40"
                >
                  <span className="flex h-11 w-11 items-center justify-center rounded-xl bg-[#c8a24f]/15 text-[#c8a24f]">
                    <Icon className="h-5 w-5" />
                  </span>
                  <h3 className="mt-4 font-display text-xl font-semibold text-[#f6f3ed]">
                    {r.title}
                  </h3>
                  <p className="mt-1 text-xs text-[#f6f3ed]/60">{r.summary}</p>
                  <ul className="mt-4 space-y-2">
                    {r.points.map((p) => (
                      <li
                        key={p}
                        className="flex items-start gap-2 text-xs text-[#f6f3ed]/75"
                      >
                        <span className="mt-1 h-1.5 w-1.5 shrink-0 rounded-full bg-[#c8a24f]" />
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

      {/* ── All 17 Operational Modules ───────────────────────────────── */}
      <section id="modules" className="py-24 bg-[#071e16] border-t border-[#1b3a2c]">
        <div className="mx-auto max-w-6xl px-5 sm:px-8">
          <div className="max-w-2xl">
            <span className="text-xs font-mono uppercase tracking-[0.2em] text-[#c8a24f]">
              Full System Scope
            </span>
            <h2 className="mt-2 font-display text-3xl sm:text-4xl font-semibold text-[#f6f3ed]">
              Seventeen modules, one source of truth.
            </h2>
          </div>

          <div className="mt-12 grid grid-cols-2 gap-px overflow-hidden rounded-2xl border border-[#1b3a2c] bg-[#1b3a2c] sm:grid-cols-3 lg:grid-cols-4">
            {MODULES.map(({ icon: Icon, name }) => (
              <div
                key={name}
                className="flex items-center gap-3 bg-[#0c261c] px-4 py-4 transition-colors hover:bg-[#071e16]"
              >
                <span className="flex h-9 w-9 shrink-0 items-center justify-center rounded-lg bg-[#c8a24f]/15 text-[#c8a24f]">
                  <Icon className="h-4 w-4" />
                </span>
                <span className="text-xs font-medium text-[#f6f3ed]/90">{name}</span>
              </div>
            ))}
          </div>
        </div>
      </section>

      {/* ── Footer ──────────────────────────────────────────────────── */}
      <footer id="company" className="border-t border-[#1b3a2c] bg-[#071e16] py-14">
        <div className="mx-auto max-w-6xl px-5 sm:px-8 text-center sm:text-left">
          <div className="flex flex-col sm:flex-row items-center justify-between gap-6">
            <Logo className="h-8 w-auto" />
            <div className="flex items-center gap-6 text-xs text-[#f6f3ed]/70">
              <Link href="/login" className="hover:text-[#c8a24f]">Sign in</Link>
              <a href="#platform" className="hover:text-[#c8a24f]">Platform</a>
              <a href="#collections" className="hover:text-[#c8a24f]">Collections</a>
              <a href="#modules" className="hover:text-[#c8a24f]">Modules</a>
            </div>
          </div>
          <div className="mt-8 border-t border-[#1b3a2c] pt-6 flex flex-col sm:flex-row items-center justify-between text-xs text-[#f6f3ed]/50 gap-3">
            <span>© 2026 Éclat Diamonds / Ratanlall Jewellery. All rights reserved.</span>
            <span className="font-mono">CaratSense Operational System</span>
          </div>
        </div>
      </footer>
    </div>
  );
}
