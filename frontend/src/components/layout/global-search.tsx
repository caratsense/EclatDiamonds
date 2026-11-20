"use client";

import { useEffect, useState } from "react";
import { useRouter } from "next/navigation";
import { Search } from "lucide-react";

import { Button } from "@/components/ui/button";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";
import { Input } from "@/components/ui/input";
import { Skeleton } from "@/components/ui/skeleton";
import { formatINR } from "@/lib/format";
import {
  SEARCH_MIN_CHARS,
  useDebouncedValue,
  useGlobalSearch,
  type SearchBillItem,
  type SearchCustomerItem,
  type SearchDesignItem,
  type SearchGroup,
  type SearchGroupKey,
  type SearchItem,
  type SearchLeadItem,
  type SearchOrderItem,
  type SearchQuoteItem,
  type SearchStockItem,
} from "@/lib/queries/search";

/**
 * Global search palette — one box that finds anything synced from the legacy
 * system (customers, designs, stock, bills) plus Eclat records (leads,
 * orders, quotes). Opens from the topbar trigger or Ctrl/Cmd+K.
 *
 * v1 navigation: there are no per-record detail routes yet, so a row lands on
 * the owning module page (e.g. a bill opens /payments). Deep links can slot in
 * here later without changing the palette.
 */

/** Anything on screen can open the palette by dispatching this on `window`. */
export const OPEN_SEARCH_EVENT = "caratos:open-search";

/** Row click → module landing page (no per-record routes in v1). */
const GROUP_ROUTES: Record<SearchGroupKey, string> = {
  customers: "/crm",
  designs: "/catalogue",
  stock: "/inventory",
  bills: "/payments",
  leads: "/crm",
  orders: "/quotation", // Orders tab lives on the quotation page.
  quotes: "/quotation",
};

function formatDocDate(iso?: string | null): string | undefined {
  if (!iso) return undefined;
  const d = new Date(iso);
  if (Number.isNaN(d.getTime())) return undefined;
  return d.toLocaleDateString("en-IN", {
    day: "numeric",
    month: "short",
    year: "numeric",
  });
}

interface RowContent {
  primary: string;
  /** Muted secondary parts, joined with " · ". */
  secondary?: string;
  /** Right-aligned ₹ amount where the record has one. */
  amount?: number;
}

/** Per-group mapping of API fields → row primary / secondary / amount. */
function rowContent(key: SearchGroupKey, item: SearchItem): RowContent {
  switch (key) {
    case "customers": {
      const c = item as SearchCustomerItem;
      return { primary: c.name, secondary: c.phone ?? undefined };
    }
    case "designs": {
      const d = item as SearchDesignItem;
      return {
        primary: d.name,
        secondary: [d.sku, d.category].filter(Boolean).join(" · ") || undefined,
      };
    }
    case "stock": {
      const s = item as SearchStockItem;
      return {
        primary: s.name || s.sku,
        secondary:
          [s.sku, s.category, s.status].filter(Boolean).join(" · ") ||
          undefined,
        amount: s.tagPrice ?? undefined,
      };
    }
    case "bills": {
      const b = item as SearchBillItem;
      return {
        primary: b.docNo,
        secondary:
          [b.customerName, formatDocDate(b.docDate)]
            .filter(Boolean)
            .join(" · ") || undefined,
        amount: b.totalAmount ?? undefined,
      };
    }
    case "leads": {
      const l = item as SearchLeadItem;
      return {
        primary: l.customerName || l.ref,
        secondary:
          [l.ref, l.stage, l.phone].filter(Boolean).join(" · ") || undefined,
      };
    }
    case "orders": {
      const o = item as SearchOrderItem;
      return {
        primary: o.customerName || o.ref,
        secondary:
          [o.ref, o.item, o.stage].filter(Boolean).join(" · ") || undefined,
      };
    }
    case "quotes": {
      const q = item as SearchQuoteItem;
      return {
        primary: q.customerName || q.ref,
        secondary:
          [q.ref, q.status].filter(Boolean).join(" · ") || undefined,
        amount: q.grandTotal ?? undefined,
      };
    }
  }
}

function ResultRow({
  group,
  item,
  onSelect,
}: {
  group: SearchGroup;
  item: SearchItem;
  onSelect: () => void;
}) {
  const { primary, secondary, amount } = rowContent(group.key, item);
  return (
    <button
      type="button"
      onClick={onSelect}
      className="flex w-full items-center gap-3 rounded-md px-3 py-2 text-left transition-colors hover:bg-accent hover:text-accent-foreground focus-visible:bg-accent focus-visible:outline-none"
    >
      <span className="min-w-0 flex-1">
        <span className="block truncate text-sm font-medium">{primary}</span>
        {secondary ? (
          <span className="block truncate text-xs text-muted-foreground">
            {secondary}
          </span>
        ) : null}
      </span>
      {amount != null ? (
        <span className="num shrink-0 text-sm text-muted-foreground">
          {formatINR(amount)}
        </span>
      ) : null}
    </button>
  );
}

function LoadingRows() {
  return (
    <div className="space-y-2 px-3 py-2" aria-hidden>
      {[0, 1, 2, 3].map((i) => (
        <div key={i} className="space-y-1.5 py-1">
          <Skeleton className="h-4 w-2/5" />
          <Skeleton className="h-3 w-3/5" />
        </div>
      ))}
    </div>
  );
}

export function GlobalSearch() {
  const router = useRouter();
  const [open, setOpen] = useState(false);
  const [q, setQ] = useState("");

  const debouncedQ = useDebouncedValue(q, 300);
  const { data, isLoading } = useGlobalSearch(open ? debouncedQ : "");

  // Global Ctrl+K / Cmd+K opens the palette (skipped while the user is
  // typing in another field). Esc close is handled by the Dialog itself.
  useEffect(() => {
    function onKeyDown(e: KeyboardEvent) {
      if ((e.ctrlKey || e.metaKey) && e.key.toLowerCase() === "k") {
        const target = e.target as HTMLElement | null;
        if (
          target &&
          (target.tagName === "INPUT" ||
            target.tagName === "TEXTAREA" ||
            target.isContentEditable)
        ) {
          return;
        }
        e.preventDefault();
        setOpen(true);
      }
    }
    // The sidebar pill asks for the palette by name rather than by faking a
    // keystroke, so the two entry points share one listener and neither has to
    // know how the other is wired.
    function onRequest() {
      setOpen(true);
    }
    window.addEventListener("keydown", onKeyDown);
    window.addEventListener(OPEN_SEARCH_EVENT, onRequest);
    return () => {
      window.removeEventListener("keydown", onKeyDown);
      window.removeEventListener(OPEN_SEARCH_EVENT, onRequest);
    };
  }, []);

  function handleOpenChange(next: boolean) {
    setOpen(next);
    if (!next) setQ("");
  }

  function handleSelect(key: SearchGroupKey) {
    handleOpenChange(false);
    router.push(GROUP_ROUTES[key]);
  }

  const trimmed = debouncedQ.trim();
  const searching = q.trim().length >= SEARCH_MIN_CHARS;
  const visibleGroups =
    data?.groups.filter((g) => g.total > 0 && g.items.length > 0) ?? [];

  return (
    <>
      {/* Desktop trigger — styled like a quiet search field. */}
      <Button
        type="button"
        variant="outline"
        onClick={() => setOpen(true)}
        className="hidden h-9 w-full max-w-xs justify-start gap-2 border-input bg-background px-3 font-normal text-muted-foreground shadow-none hover:text-foreground md:flex"
      >
        <Search className="h-4 w-4" />
        <span className="truncate">Search anything…</span>
        <kbd className="pointer-events-none ml-auto rounded border bg-muted px-1.5 py-0.5 font-sans text-[10px] font-medium text-muted-foreground">
          Ctrl K
        </kbd>
      </Button>

      {/* Mobile trigger — icon only, keeps the topbar compact. */}
      <Button
        type="button"
        variant="ghost"
        size="icon"
        onClick={() => setOpen(true)}
        className="text-muted-foreground md:hidden"
        aria-label="Search"
      >
        <Search className="h-5 w-5" />
      </Button>

      <Dialog open={open} onOpenChange={handleOpenChange}>
        <DialogContent className="top-[12%] max-w-xl translate-y-0 gap-0 overflow-hidden p-0">
          <DialogHeader className="sr-only">
            <DialogTitle>Global search</DialogTitle>
            <DialogDescription>
              Search customers, designs, stock, bills, leads, orders and
              quotes across the active store.
            </DialogDescription>
          </DialogHeader>

          <div className="flex items-center gap-2 border-b px-4">
            <Search className="h-4 w-4 shrink-0 text-muted-foreground" />
            <Input
              autoFocus
              value={q}
              onChange={(e) => setQ(e.target.value)}
              placeholder="Search anything…"
              className="h-12 border-0 px-0 shadow-none focus-visible:ring-0"
            />
          </div>

          <div className="max-h-[60vh] overflow-y-auto p-2">
            {!searching ? (
              <p className="px-3 py-8 text-center text-sm text-muted-foreground">
                Search customers, bills, designs, stock, leads…
              </p>
            ) : isLoading || trimmed.length < SEARCH_MIN_CHARS ? (
              <LoadingRows />
            ) : visibleGroups.length === 0 ? (
              <p className="px-3 py-8 text-center text-sm text-muted-foreground">
                No matches for &ldquo;{trimmed}&rdquo;.
              </p>
            ) : (
              visibleGroups.map((group) => (
                <div key={group.key} className="pb-1">
                  <p className="px-3 pb-1 pt-2 text-xs font-medium text-muted-foreground">
                    {group.label} · <span className="num">{group.total}</span>
                  </p>
                  {group.items.map((item) => (
                    <ResultRow
                      key={`${group.key}-${item.id}`}
                      group={group}
                      item={item}
                      onSelect={() => handleSelect(group.key)}
                    />
                  ))}
                </div>
              ))
            )}
          </div>

          <p className="border-t px-4 py-2 text-[11px] text-muted-foreground">
            Results open the matching module page.
          </p>
        </DialogContent>
      </Dialog>
    </>
  );
}
