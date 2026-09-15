"use client";

import * as React from "react";
import { Calendar, ChevronDown } from "lucide-react";
import { formatINR } from "@/lib/format";
import { cn } from "@/lib/utils";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";

export type MetalType = "Gold" | "Silver" | "Platinum";

export interface RateItem {
  title: string;
  price: number;
  change: number; // positive or negative
  unit?: string;
}

const CITIES = [
  "Mumbai",
  "Delhi",
  "Bengaluru",
  "Chennai",
  "Kolkata",
  "Ahmedabad",
  "Hyderabad",
  "Pune",
];

const CITY_DIFFS: Record<string, number> = {
  Mumbai: 0,
  Delhi: 18,
  Bengaluru: -12,
  Chennai: 25,
  Kolkata: 10,
  Ahmedabad: -5,
  Hyderabad: 8,
  Pune: 2,
};

const BASE_RATES: Record<MetalType, RateItem[]> = {
  Gold: [
    { title: "24K Gold /g", price: 15289, change: -262 },
    { title: "22K Gold /g", price: 14015, change: -240 },
    { title: "18K Gold /g", price: 11467, change: -196 },
  ],
  Silver: [
    { title: "Fine Silver 999 /g", price: 98.5, change: 1.2 },
    { title: "Sterling Silver 925 /g", price: 91.2, change: 0.95 },
    { title: "Silver Bar 100g", price: 9850, change: 120 },
  ],
  Platinum: [
    { title: "Platinum 950 /g", price: 3840, change: -45 },
    { title: "Platinum 900 /g", price: 3630, change: -38 },
    { title: "Platinum 850 /g", price: 3420, change: -32 },
  ],
};

export function MetalRatesWidget({
  className,
  compact = false,
}: {
  className?: string;
  compact?: boolean;
}) {
  const [selectedMetal, setSelectedMetal] = React.useState<MetalType>("Gold");
  const [selectedCity, setSelectedCity] = React.useState<string>("Mumbai");

  // Current formatted date matching live format e.g. "11 September 2026"
  const formattedDate = React.useMemo(() => {
    const d = new Date();
    // Default to the target standard demo date if year is earlier
    if (d.getFullYear() < 2026) {
      return "11 September 2026";
    }
    return d.toLocaleDateString("en-GB", {
      day: "numeric",
      month: "long",
      year: "numeric",
    });
  }, []);

  const cityOffset = CITY_DIFFS[selectedCity] ?? 0;
  const rates = BASE_RATES[selectedMetal].map((item) => ({
    ...item,
    price: item.price + (selectedMetal === "Silver" ? cityOffset * 0.05 : cityOffset),
  }));

  return (
    <div
      className={cn(
        "rounded-2xl border border-border/80 bg-[#0d151c] p-4 text-slate-100 shadow-xl backdrop-blur-md",
        className,
      )}
    >
      {/* Controls Bar */}
      <div className="flex flex-wrap items-center justify-between gap-3">
        <div className="flex items-center gap-3">
          {/* Date pill */}
          <div className="flex items-center gap-2 rounded-lg border border-slate-700/60 bg-slate-900/60 px-3 py-1.5 text-xs font-medium text-slate-300 shadow-xs">
            <Calendar className="h-3.5 w-3.5 text-emerald-400" />
            <span>{formattedDate}</span>
          </div>

          <div className="hidden h-4 w-px bg-slate-800 sm:block" />

          {/* Metal segmented switcher */}
          <div className="flex items-center rounded-lg border border-slate-800 bg-slate-950/80 p-0.5 text-xs">
            {(["Gold", "Silver", "Platinum"] as MetalType[]).map((metal) => {
              const active = selectedMetal === metal;
              return (
                <button
                  key={metal}
                  type="button"
                  onClick={() => setSelectedMetal(metal)}
                  className={cn(
                    "rounded-md px-3.5 py-1 text-xs font-semibold transition-all",
                    active
                      ? "bg-[#059669] text-white shadow-xs"
                      : "text-slate-400 hover:text-slate-200 hover:bg-slate-800/50",
                  )}
                >
                  {metal}
                </button>
              );
            })}
          </div>
        </div>

        {/* City Dropdown */}
        <div className="w-32">
          <Select value={selectedCity} onValueChange={setSelectedCity}>
            <SelectTrigger className="h-8 border-slate-700/70 bg-slate-900/80 text-xs font-medium text-slate-200 focus:ring-1 focus:ring-emerald-500">
              <SelectValue placeholder="City" />
            </SelectTrigger>
            <SelectContent className="border-slate-800 bg-[#0d151c] text-slate-200">
              {CITIES.map((city) => (
                <SelectItem key={city} value={city} className="text-xs hover:bg-slate-800 focus:bg-slate-800">
                  {city}
                </SelectItem>
              ))}
            </SelectContent>
          </Select>
        </div>
      </div>

      {/* Rate Cards Grid */}
      <div
        className={cn(
          "mt-3.5 grid gap-3",
          compact ? "grid-cols-1 sm:grid-cols-3" : "grid-cols-1 sm:grid-cols-3",
        )}
      >
        {rates.map((r) => {
          const isDown = r.change < 0;
          return (
            <div
              key={r.title}
              className="group relative flex flex-col justify-between rounded-xl border border-slate-800/80 bg-[#131f28]/80 p-3.5 transition-all hover:border-slate-700/80 hover:bg-[#16242e]"
            >
              <span className="text-xs font-medium text-slate-400">{r.title}</span>
              <div className="mt-2.5 flex items-center justify-between gap-2">
                <span className="font-display text-2xl font-bold tracking-tight text-white">
                  {selectedMetal === "Silver" && r.price < 500
                    ? `₹${r.price.toFixed(2)}`
                    : formatINR(Math.round(r.price))}
                </span>

                {/* Change Badge */}
                <div
                  className={cn(
                    "inline-flex items-center gap-1 rounded-full px-2 py-0.5 text-xs font-bold shadow-xs",
                    isDown
                      ? "border border-red-800/40 bg-red-950/70 text-red-400"
                      : "border border-emerald-800/40 bg-emerald-950/70 text-emerald-400",
                  )}
                >
                  <span>
                    {isDown ? `- ${Math.abs(r.change)}` : `+ ${r.change}`}
                  </span>
                  <span className="text-[10px] leading-none">
                    {isDown ? "▼" : "▲"}
                  </span>
                </div>
              </div>
            </div>
          );
        })}
      </div>
    </div>
  );
}
