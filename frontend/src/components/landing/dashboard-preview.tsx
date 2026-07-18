import {
  Bell,
  Search,
  LayoutDashboard,
  TrendingUp,
  ShoppingBag,
  Boxes,
  Users,
  ClipboardList,
  Factory,
  Wallet,
  BarChart3,
  UserCog,
  Settings,
} from "lucide-react";

/**
 * Landing-only, static product preview of the CaratSense "Overview" dashboard.
 *
 * Pure CSS + inline SVG — no data fetching, no chart library, non-interactive.
 * It is purely decorative (aria-hidden) and exists to raise perceived quality
 * on the marketing page. It must live inside a `.landing` wrapper so the
 * `--l-*` design tokens resolve. The parent is responsible for wrapping this in
 * an overflow container; the 3D tilt is flattened under 1024px via `.dash-3d`.
 */

const NAV = [
  { icon: LayoutDashboard, label: "Overview", active: true },
  { icon: TrendingUp, label: "Sales" },
  { icon: Boxes, label: "Catalogue" },
  { icon: ClipboardList, label: "Inventory" },
  { icon: Users, label: "Customers" },
  { icon: ShoppingBag, label: "Orders" },
  { icon: Factory, label: "Manufacturing" },
  { icon: Wallet, label: "Finance" },
  { icon: BarChart3, label: "Reports" },
  { icon: UserCog, label: "People" },
  { icon: Settings, label: "Settings" },
];

const KPIS = [
  { label: "Total Sales", value: "₹8.64 Cr", delta: "+12.4%", up: true },
  { label: "Orders", value: "1,243", delta: "+3.2%", up: true },
  { label: "Inventory Value", value: "₹24.75 Cr", delta: "+5.6%", up: true },
  { label: "Active Stores", value: "17", delta: "All live", up: true },
];

const STORES = [
  { name: "Sarafa Ex, Delhi", value: "₹1.96 Cr", delta: "+18.2%" },
  { name: "MG Road, Bengaluru", value: "₹1.48 Cr", delta: "+14.6%" },
  { name: "Bandra, Mumbai", value: "₹1.26 Cr", delta: "+11.5%" },
];

export function DashboardPreview() {
  return (
    <div className="landing-glow relative isolate">
      {/* horizontal-scroll safety on very small screens; never breaks body */}
      <div className="relative z-10 overflow-x-auto overflow-y-hidden">
        <div
          aria-hidden
          className="dash-3d landing-card mx-auto w-[600px] max-w-full overflow-hidden rounded-2xl text-[var(--l-ivory)]"
        >
          {/* ── window chrome ─────────────────────────────────────────── */}
          <div className="flex items-center gap-3 border-b border-[var(--l-hairline)] bg-[color-mix(in_srgb,var(--l-gold)_5%,var(--l-surface))] px-4 py-2.5">
            <span className="flex h-6 w-6 items-center justify-center rounded-md border border-[color-mix(in_srgb,var(--l-gold)_40%,transparent)] text-[10px] font-bold tracking-tight text-[var(--l-gold)]">
              ÉD
            </span>
            <div className="flex min-w-0 flex-1 items-center gap-2 rounded-md border border-[var(--l-hairline)] bg-[color-mix(in_srgb,#000_18%,var(--l-surface))] px-2.5 py-1.5">
              <Search className="h-3.5 w-3.5 shrink-0 text-[var(--l-ivory-55)]" />
              <span className="truncate text-[11px] text-[var(--l-ivory-55)]">
                Search anything…
              </span>
            </div>
            <Bell className="h-4 w-4 shrink-0 text-[var(--l-ivory-70)]" />
            <span className="flex shrink-0 items-center gap-2 rounded-full border border-[var(--l-hairline)] py-1 pl-1 pr-2.5">
              <span className="flex h-5 w-5 items-center justify-center rounded-full bg-[var(--l-gold)] text-[9px] font-bold text-[#0b1f16]">
                A
              </span>
              <span className="text-[10px] leading-none text-[var(--l-ivory-70)]">
                Admin · Head Office
              </span>
            </span>
          </div>

          <div className="flex">
            {/* ── mini sidebar ────────────────────────────────────────── */}
            <nav className="hidden w-[124px] shrink-0 flex-col gap-0.5 border-r border-[var(--l-hairline)] bg-[color-mix(in_srgb,#000_12%,var(--l-surface))] p-2 sm:flex">
              {NAV.map(({ icon: Icon, label, active }) => (
                <span
                  key={label}
                  className={
                    "flex items-center gap-2 rounded-md px-2 py-1.5 text-[10px] font-medium " +
                    (active
                      ? "bg-[color-mix(in_srgb,var(--l-gold)_16%,transparent)] text-[var(--l-gold)]"
                      : "text-[var(--l-ivory-70)]")
                  }
                >
                  <Icon className="h-3 w-3 shrink-0" />
                  <span className="truncate">{label}</span>
                </span>
              ))}
            </nav>

            {/* ── main area ───────────────────────────────────────────── */}
            <div className="min-w-0 flex-1 space-y-3 p-3.5">
              <div className="flex items-center justify-between gap-2">
                <div>
                  <div className="font-display text-[15px] font-semibold leading-tight">
                    Good morning, Admin
                  </div>
                  <div className="text-[10px] text-[var(--l-ivory-55)]">
                    Here is today across every store.
                  </div>
                </div>
                <span className="shrink-0 rounded-full border border-[var(--l-hairline)] px-2.5 py-1 text-[9px] text-[var(--l-ivory-70)]">
                  Today, 24 May 2025
                </span>
              </div>

              {/* KPI mini-cards */}
              <div className="grid grid-cols-2 gap-2 lg:grid-cols-4">
                {KPIS.map((k) => (
                  <div
                    key={k.label}
                    className="rounded-lg border border-[var(--l-hairline)] bg-[color-mix(in_srgb,#000_10%,var(--l-surface))] p-2.5"
                  >
                    <div className="text-[8.5px] uppercase tracking-wide text-[var(--l-ivory-55)]">
                      {k.label}
                    </div>
                    <div className="num mt-1 text-[13px] font-semibold text-[var(--l-ivory)]">
                      {k.value}
                    </div>
                    <div className="num mt-0.5 text-[9px] font-medium text-[#7fd0a4]">
                      {k.delta}
                    </div>
                  </div>
                ))}
              </div>

              {/* Sales overview chart */}
              <div className="rounded-lg border border-[var(--l-hairline)] bg-[color-mix(in_srgb,#000_10%,var(--l-surface))] p-3">
                <div className="mb-1 flex items-center justify-between">
                  <span className="text-[11px] font-medium text-[var(--l-ivory)]">
                    Sales Overview
                  </span>
                  <span className="num text-[9px] text-[var(--l-ivory-55)]">
                    Last 30 days
                  </span>
                </div>
                <svg
                  viewBox="0 0 320 84"
                  className="h-16 w-full"
                  preserveAspectRatio="none"
                >
                  <defs>
                    <linearGradient id="dashArea" x1="0" y1="0" x2="0" y2="1">
                      <stop offset="0" stopColor="#c8a24f" stopOpacity="0.34" />
                      <stop offset="1" stopColor="#c8a24f" stopOpacity="0" />
                    </linearGradient>
                  </defs>
                  <path
                    d="M0 64 C 26 60 40 40 66 42 C 92 44 104 26 130 30 C 156 34 168 16 196 22 C 224 28 236 40 264 34 C 290 29 304 14 320 10 L 320 84 L 0 84 Z"
                    fill="url(#dashArea)"
                  />
                  <path
                    d="M0 64 C 26 60 40 40 66 42 C 92 44 104 26 130 30 C 156 34 168 16 196 22 C 224 28 236 40 264 34 C 290 29 304 14 320 10"
                    fill="none"
                    stroke="#c8a24f"
                    strokeWidth="2"
                    strokeLinecap="round"
                  />
                </svg>
              </div>

              {/* Top performing stores */}
              <div className="rounded-lg border border-[var(--l-hairline)] bg-[color-mix(in_srgb,#000_10%,var(--l-surface))] p-3">
                <div className="mb-2 text-[11px] font-medium text-[var(--l-ivory)]">
                  Top Performing Stores
                </div>
                <div className="space-y-2">
                  {STORES.map((s, i) => (
                    <div key={s.name} className="flex items-center gap-2.5">
                      <span className="num flex h-4 w-4 shrink-0 items-center justify-center rounded-full bg-[color-mix(in_srgb,var(--l-gold)_18%,transparent)] text-[8px] font-semibold text-[var(--l-gold)]">
                        {i + 1}
                      </span>
                      <span className="min-w-0 flex-1 truncate text-[10px] text-[var(--l-ivory-70)]">
                        {s.name}
                      </span>
                      <span className="num text-[10px] font-medium text-[var(--l-ivory)]">
                        {s.value}
                      </span>
                      <span className="num w-10 text-right text-[9px] text-[#7fd0a4]">
                        {s.delta}
                      </span>
                    </div>
                  ))}
                </div>
              </div>
            </div>
          </div>
        </div>
      </div>

      {/* ── floating stat cards for depth ───────────────────────────────
          Positioned to hang off the OUTER edges (top-right, bottom-left,
          bottom-right) so they never cover the mini-sidebar labels or the
          top-store revenue figures. Decorative + non-interactive; hidden
          under lg to avoid clipping on small screens. */}
      <div
        aria-hidden
        className="pointer-events-none absolute -right-6 top-[11%] z-20 hidden rounded-xl border border-[var(--l-hairline)] bg-[color-mix(in_srgb,#000_30%,var(--l-surface))] px-3 py-2 shadow-[0_16px_40px_-14px_rgba(0,0,0,0.7)] backdrop-blur-sm xl:block">
        <div className="text-[9px] uppercase tracking-wide text-[var(--l-ivory-55)]">
          Pending Orders
        </div>
        <div className="num text-[16px] font-semibold text-[var(--l-ivory)]">68</div>
      </div>

      <div
        aria-hidden
        className="pointer-events-none absolute -left-5 -bottom-4 z-20 hidden rounded-xl border border-[color-mix(in_srgb,#e0a857_40%,transparent)] bg-[color-mix(in_srgb,#000_30%,var(--l-surface))] px-3 py-2 shadow-[0_16px_40px_-14px_rgba(0,0,0,0.7)] backdrop-blur-sm lg:block">
        <div className="text-[9px] uppercase tracking-wide text-[#e0a857]">
          Low Stock Alerts
        </div>
        <div className="num text-[16px] font-semibold text-[#f0b968]">23</div>
      </div>

      <div
        aria-hidden
        className="pointer-events-none absolute -right-5 -bottom-5 z-20 hidden rounded-xl border border-[var(--l-hairline)] bg-[color-mix(in_srgb,#000_30%,var(--l-surface))] px-3 py-2 shadow-[0_16px_40px_-14px_rgba(0,0,0,0.7)] backdrop-blur-sm lg:block">
        <div className="text-[9px] uppercase tracking-wide text-[var(--l-ivory-55)]">
          Today&apos;s Appointments
        </div>
        <div className="num text-[16px] font-semibold text-[var(--l-ivory)]">12</div>
      </div>
    </div>
  );
}
