"use client";

import * as React from "react";
import { Gift } from "lucide-react";

import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";
import { formatINR } from "@/lib/format";
import { SCHEME_PLANS, getPlan } from "@/lib/mock/loyalty";

/**
 * Maturity calculator (Module 17):
 * customer pays `installment` for `tenureMonths`; the store adds
 * `bonusMonths` worth of installments as buying power at maturity.
 */
export function MaturityCalculator() {
  const [planId, setPlanId] = React.useState(SCHEME_PLANS[0].id);
  const [installment, setInstallment] = React.useState(10000);

  const plan = getPlan(planId) ?? SCHEME_PLANS[0];

  const paidIn = installment * plan.tenureMonths;
  const bonus = installment * plan.bonusMonths;
  const maturityValue = paidIn + bonus;
  const bonusPct = paidIn > 0 ? (bonus / paidIn) * 100 : 0;

  return (
    <div className="space-y-4">
      <div className="grid gap-4 sm:grid-cols-2">
        <div className="space-y-1.5">
          <Label htmlFor="plan">Plan</Label>
          <Select value={planId} onValueChange={setPlanId}>
            <SelectTrigger id="plan">
              <SelectValue />
            </SelectTrigger>
            <SelectContent>
              {SCHEME_PLANS.map((p) => (
                <SelectItem key={p.id} value={p.id}>
                  {p.name}
                </SelectItem>
              ))}
            </SelectContent>
          </Select>
          <p className="text-[11px] text-muted-foreground">{plan.bonusLabel}</p>
        </div>

        <div className="space-y-1.5">
          <Label htmlFor="installment">Monthly installment (₹)</Label>
          <Input
            id="installment"
            type="number"
            min={0}
            step={500}
            value={installment}
            onChange={(e) => setInstallment(Number(e.target.value) || 0)}
          />
        </div>
      </div>

      <div className="rounded-lg border bg-muted/40 p-4">
        <dl className="space-y-2 text-sm">
          <div className="flex items-center justify-between">
            <dt className="text-muted-foreground">
              <span className="num">{formatINR(installment)}</span> ×{" "}
              <span className="num">{plan.tenureMonths}</span> months paid
            </dt>
            <dd className="num font-medium">{formatINR(paidIn)}</dd>
          </div>
          <div className="flex items-center justify-between">
            <dt className="flex items-center gap-1.5 text-emerald-700 dark:text-emerald-400">
              <Gift className="h-3.5 w-3.5" />
              Store bonus ({plan.bonusMonths} month
              {plan.bonusMonths === 1 ? "" : "s"})
            </dt>
            <dd className="num font-medium text-emerald-700 dark:text-emerald-400">
              + {formatINR(bonus)}
            </dd>
          </div>
          <div className="flex items-center justify-between border-t pt-2">
            <dt className="font-semibold">Maturity buying power</dt>
            <dd className="num text-lg font-semibold">
              {formatINR(maturityValue)}
            </dd>
          </div>
        </dl>
        <p className="mt-2 text-xs text-muted-foreground">
          Effective benefit ≈ <span className="num">{bonusPct.toFixed(1)}%</span>{" "}
          over the tenure.
        </p>
      </div>
    </div>
  );
}
