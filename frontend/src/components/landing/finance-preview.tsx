import { Wallet } from "lucide-react";

/**
 * Landing-only, static preview of the Daily Sales Report (DSR).
 * Pure CSS + inline SVG bars — no data fetching, non-interactive,
 * decorative (aria-hidden). Must live inside a `.landing` wrapper.
 */

const FIGURES = [
  { label: "Gross Sales", value: "₹42.6 L" },
  { label: "Collections", value: "₹31.4 L" },
  { label: "New Orders", value: "14" },
];

// last 7 days, relative bar heights (0–1)
const BARS = [0.42, 0.58, 0.5, 0.72, 0.64, 0.86, 0.78];
const DAYS = ["M", "T", "W", "T", "F", "S", "S"];

export function FinancePreview() {
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
              <Wallet className="h-3.5 w-3.5" />
            </span>
            <span className="text-[12px] font-medium text-[var(--l-ivory)]">
              Daily Sales Report
            </span>
            <span className="num ml-auto rounded-full border border-[var(--l-hairline)] px-2 py-0.5 text-[9px] text-[var(--l-ivory-70)]">
              18 Jul 2026
            </span>
          </div>

          <div className="space-y-3 p-3.5">
            {/* figures */}
            <div className="grid grid-cols-3 gap-2">
              {FIGURES.map((f) => (
                <div
                  key={f.label}
                  className="rounded-lg border border-[var(--l-hairline)] bg-[color-mix(in_srgb,#000_10%,var(--l-surface))] p-2.5"
                >
                  <div className="text-[8.5px] uppercase tracking-wide text-[var(--l-ivory-55)]">
                    {f.label}
                  </div>
                  <div className="num mt-1 text-[13px] font-semibold text-[var(--l-ivory)]">
                    {f.value}
                  </div>
                </div>
              ))}
            </div>

            {/* 7-day bar chart */}
            <div className="rounded-lg border border-[var(--l-hairline)] bg-[color-mix(in_srgb,#000_10%,var(--l-surface))] p-3">
              <div className="mb-2 flex items-center justify-between">
                <span className="text-[10px] font-medium text-[var(--l-ivory)]">
                  Sales, last 7 days
                </span>
                <span className="num text-[9px] text-[#7fd0a4]">+9.2%</span>
              </div>
              <div className="flex h-16 items-end gap-1.5">
                {BARS.map((h, i) => (
                  <div key={i} className="flex flex-1 flex-col items-center gap-1">
                    <div
                      className="w-full rounded-t-sm"
                      style={{
                        height: `${h * 100}%`,
                        background:
                          i === BARS.length - 2
                            ? "var(--l-gold)"
                            : "color-mix(in srgb, var(--l-gold) 34%, transparent)",
                      }}
                    />
                    <span className="text-[7.5px] text-[var(--l-ivory-55)]">
                      {DAYS[i]}
                    </span>
                  </div>
                ))}
              </div>
            </div>

            {/* target progress */}
            <div>
              <div className="mb-1.5 flex items-center justify-between text-[10px]">
                <span className="font-medium text-[var(--l-ivory)]">
                  Monthly target
                </span>
                <span className="num text-[var(--l-ivory-70)]">
                  ₹9.8 Cr / ₹12.5 Cr
                </span>
              </div>
              <div className="h-2 w-full overflow-hidden rounded-full bg-[color-mix(in_srgb,#000_18%,var(--l-surface))]">
                <span
                  className="block h-full rounded-full bg-[var(--l-gold)]"
                  style={{ width: "78%" }}
                />
              </div>
            </div>
          </div>
        </div>
      </div>
    </div>
  );
}
