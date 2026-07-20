import { Users, ArrowRight } from "lucide-react";

/**
 * Landing-only, static preview of the CRM pipeline (kanban).
 * Pure CSS + lucide — no data fetching, non-interactive, decorative
 * (aria-hidden). Must live inside a `.landing` wrapper so `--l-*` tokens
 * resolve. The parent wraps this in an overflow-safe container.
 */

const COLUMNS = [
  {
    stage: "Inquiry",
    count: 8,
    cards: [
      { name: "Priya Sharma", item: "Solitaire ring", value: "₹2.4 L" },
      { name: "Rahul Mehta", item: "Diamond set", value: "₹5.1 L" },
    ],
  },
  {
    stage: "Quotation",
    count: 5,
    cards: [{ name: "Anita Rao", item: "Quote #Q-1043", value: "₹8.2 L" }],
  },
  {
    stage: "Order",
    count: 3,
    cards: [{ name: "Karan Shah", item: "Bridal set · advance", value: "₹18.5 L" }],
  },
];

export function CrmPreview() {
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
              <Users className="h-3.5 w-3.5" />
            </span>
            <span className="text-[12px] font-medium text-[var(--l-ivory)]">
              Sales Pipeline
            </span>
            <span className="ml-auto rounded-full border border-[var(--l-hairline)] px-2 py-0.5 text-[9px] text-[var(--l-ivory-70)]">
              This week
            </span>
          </div>

          {/* board */}
          <div className="grid grid-cols-3 gap-2 p-3">
            {COLUMNS.map((col) => (
              <div key={col.stage} className="min-w-0">
                <div className="mb-2 flex items-center justify-between">
                  <span className="text-[10px] font-medium text-[var(--l-ivory-70)]">
                    {col.stage}
                  </span>
                  <span className="num flex h-4 min-w-4 items-center justify-center rounded-full bg-[color-mix(in_srgb,var(--l-gold)_16%,transparent)] px-1 text-[8px] font-semibold text-[var(--l-gold)]">
                    {col.count}
                  </span>
                </div>
                <div className="space-y-2">
                  {col.cards.map((c) => (
                    <div
                      key={c.name}
                      className="rounded-lg border border-[var(--l-hairline)] bg-[color-mix(in_srgb,#000_10%,var(--l-surface))] p-2"
                    >
                      <div className="truncate text-[10px] font-medium text-[var(--l-ivory)]">
                        {c.name}
                      </div>
                      <div className="mt-0.5 truncate text-[8.5px] text-[var(--l-ivory-55)]">
                        {c.item}
                      </div>
                      <div className="num mt-1.5 text-[10px] font-semibold text-[var(--l-gold)]">
                        {c.value}
                      </div>
                    </div>
                  ))}
                  {col.stage !== "Order" ? (
                    <div className="flex items-center justify-center gap-1 rounded-lg border border-dashed border-[var(--l-hairline)] py-1.5 text-[8px] text-[var(--l-ivory-55)]">
                      Move stage <ArrowRight className="h-2.5 w-2.5" />
                    </div>
                  ) : null}
                </div>
              </div>
            ))}
          </div>
        </div>
      </div>
    </div>
  );
}
