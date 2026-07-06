"use client";

import * as React from "react";

import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";
import { formatGrams, formatINR, formatPurity } from "@/lib/format";
import { GOLD_RATE_PER_GRAM } from "@/lib/mock/returns";

/**
 * Exchange-value calculator (Module 14):
 * net buyback = (old-gold weight × rate/g) − deductions.
 * Pure UI math on mock rates; wired to the live gold feed in a later phase.
 */
export function ExchangeCalculator() {
  const [grams, setGrams] = React.useState(38.42);
  const [karat, setKarat] = React.useState<number>(22);
  const [deductions, setDeductions] = React.useState(4100);

  const rate = GOLD_RATE_PER_GRAM[karat] ?? 0;
  const gross = grams * rate;
  const net = Math.max(0, gross - deductions);

  return (
    <div className="space-y-4">
      <div className="grid gap-4 sm:grid-cols-3">
        <div className="space-y-1.5">
          <Label htmlFor="og-grams">Old-gold weight (g)</Label>
          <Input
            id="og-grams"
            type="number"
            inputMode="decimal"
            step="0.001"
            min={0}
            value={grams}
            onChange={(e) => setGrams(Number(e.target.value) || 0)}
          />
        </div>

        <div className="space-y-1.5">
          <Label htmlFor="og-karat">Purity</Label>
          <Select
            value={String(karat)}
            onValueChange={(v) => setKarat(Number(v))}
          >
            <SelectTrigger id="og-karat">
              <SelectValue />
            </SelectTrigger>
            <SelectContent>
              {Object.keys(GOLD_RATE_PER_GRAM).map((k) => (
                <SelectItem key={k} value={k}>
                  {formatPurity(Number(k))} — {formatINR(GOLD_RATE_PER_GRAM[Number(k)])}/g
                </SelectItem>
              ))}
            </SelectContent>
          </Select>
        </div>

        <div className="space-y-1.5">
          <Label htmlFor="og-deduct">Deductions (₹)</Label>
          <Input
            id="og-deduct"
            type="number"
            inputMode="numeric"
            min={0}
            value={deductions}
            onChange={(e) => setDeductions(Number(e.target.value) || 0)}
          />
          <p className="text-[11px] text-muted-foreground">
            Melting loss, wastage, hallmark
          </p>
        </div>
      </div>

      <div className="rounded-lg border bg-muted/40 p-4">
        <dl className="space-y-2 text-sm">
          <div className="flex items-center justify-between">
            <dt className="text-muted-foreground">
              <span className="num">{formatGrams(grams)}</span>{" "}
              {formatPurity(karat)} ×{" "}
              <span className="num">{formatINR(rate)}</span>/g
            </dt>
            <dd className="num font-medium">{formatINR(gross)}</dd>
          </div>
          <div className="flex items-center justify-between">
            <dt className="text-muted-foreground">Less deductions</dt>
            <dd className="num font-medium text-destructive">
              − {formatINR(deductions)}
            </dd>
          </div>
          <div className="flex items-center justify-between border-t pt-2">
            <dt className="font-semibold">Net buyback value</dt>
            <dd className="num text-lg font-semibold">{formatINR(net)}</dd>
          </div>
        </dl>
      </div>
    </div>
  );
}
