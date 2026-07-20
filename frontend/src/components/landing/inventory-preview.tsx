import { Boxes } from "lucide-react";

/**
 * Landing-only, static preview of inventory stock + aging.
 * Pure CSS + lucide — no data fetching, non-interactive, decorative
 * (aria-hidden). Must live inside a `.landing` wrapper for `--l-*` tokens.
 */

const ROWS = [
  { item: "Solitaire Ring 1.2 ct", store: "Delhi", age: "42 d", value: "₹3.8 L", dead: false },
  { item: "Gold Necklace 22K", store: "Mumbai", age: "128 d", value: "₹6.2 L", dead: true },
  { item: "Tennis Bracelet", store: "Bengaluru", age: "18 d", value: "₹2.1 L", dead: false },
  { item: "Diamond Studs", store: "Delhi", age: "64 d", value: "₹1.4 L", dead: false },
];

// aging distribution: fresh / watch / dead — sums to 100
const AGING = [
  { label: "0–30 d", pct: 46, color: "#7fd0a4" },
  { label: "31–90 d", pct: 38, color: "var(--l-gold)" },
  { label: "90 d+", pct: 16, color: "#e0a857" },
];

export function InventoryPreview() {
  return (
    <div className="landing-glow relative isolate">
      <div className="relative z-10 overflow-x-auto overflow-y-hidden">
        <div
          aria-hidden
          className="landing-card mx-auto w-[540px] max-w-full overflow-hidden rounded-2xl text-[var(--l-ivory)] shadow-[0_24px_60px_-24px_rgba(0,0,0,0.6)]"
        >
          {/* header */}
          <div className="flex items-center gap-2.5 border-b border-[var(--l-hairline)] bg-[color-mix(in_srgb,var(--l-gold)_5%,var(--l-surface))] px-4 py-2.5">
            <span className="flex h-6 w-6 items-center justify-center rounded-md bg-[color-mix(in_srgb,var(--l-gold)_16%,transparent)] text-[var(--l-gold)]">
              <Boxes className="h-3.5 w-3.5" />
            </span>
            <span className="text-[12px] font-medium text-[var(--l-ivory)]">
              Stock &amp; Aging
            </span>
            <span className="ml-auto rounded-full border border-[color-mix(in_srgb,#e0a857_40%,transparent)] px-2 py-0.5 text-[9px] text-[#e0a857]">
              1 dead-stock
            </span>
          </div>

          <div className="space-y-3 p-3.5">
            {/* table */}
            <div className="overflow-hidden rounded-lg border border-[var(--l-hairline)]">
              <div className="grid grid-cols-[1.6fr_0.9fr_0.7fr_0.9fr] gap-2 border-b border-[var(--l-hairline)] bg-[color-mix(in_srgb,#000_12%,var(--l-surface))] px-2.5 py-1.5 text-[8px] uppercase tracking-wide text-[var(--l-ivory-55)]">
                <span>Item</span>
                <span>Store</span>
                <span>Age</span>
                <span className="text-right">Value</span>
              </div>
              {ROWS.map((r) => (
                <div
                  key={r.item}
                  className="grid grid-cols-[1.6fr_0.9fr_0.7fr_0.9fr] items-center gap-2 border-b border-[var(--l-hairline)] px-2.5 py-1.5 last:border-b-0"
                >
                  <span className="truncate text-[10px] text-[var(--l-ivory)]">
                    {r.item}
                  </span>
                  <span className="truncate text-[9px] text-[var(--l-ivory-70)]">
                    {r.store}
                  </span>
                  <span
                    className="num text-[9px]"
                    style={{ color: r.dead ? "#e0a857" : "var(--l-ivory-70)" }}
                  >
                    {r.age}
                  </span>
                  <span className="num text-right text-[10px] font-medium text-[var(--l-ivory)]">
                    {r.value}
                  </span>
                </div>
              ))}
            </div>

            {/* aging bar */}
            <div>
              <div className="mb-1.5 flex items-center justify-between">
                <span className="text-[10px] font-medium text-[var(--l-ivory)]">
                  Inventory aging
                </span>
                <span className="num text-[9px] text-[var(--l-ivory-55)]">
                  ₹24.75 Cr on hand
                </span>
              </div>
              <div className="flex h-2.5 w-full overflow-hidden rounded-full">
                {AGING.map((a) => (
                  <span
                    key={a.label}
                    style={{ width: `${a.pct}%`, backgroundColor: a.color }}
                  />
                ))}
              </div>
              <div className="mt-1.5 flex flex-wrap gap-x-3 gap-y-1">
                {AGING.map((a) => (
                  <span
                    key={a.label}
                    className="flex items-center gap-1 text-[8.5px] text-[var(--l-ivory-70)]"
                  >
                    <span
                      className="h-2 w-2 rounded-full"
                      style={{ backgroundColor: a.color }}
                    />
                    {a.label}
                    <span className="num text-[var(--l-ivory-55)]">{a.pct}%</span>
                  </span>
                ))}
              </div>
            </div>
          </div>
        </div>
      </div>
    </div>
  );
}
