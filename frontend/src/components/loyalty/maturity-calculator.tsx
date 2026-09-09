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
import { Skeleton } from "@/components/ui/skeleton";
import { formatINR } from "@/lib/format";
import { useSchemePlans } from "@/lib/queries/loyalty";
import type { SchemePlan } from "@/lib/mock/loyalty";

/**
 * Maturity calculator (Module 17):
 * customer pays `installment` for `tenureMonths`; the store adds
 * `bonusMonths` worth of installments as buying power at maturity.
 *
 * Plans come live from GET /loyalty/plans (useSchemePlans) so the dropdown
 * always reflects the actual configured schemes — the what-if projection math
 * is unchanged.
 */
export function MaturityCalculator() {
  const { data: plans = [], isLoading } = useSchemePlans();
  const [chosenPlanId, setPlanId] = React.useState<string>("");
  const [installment, setInstallment] = React.useState(10000);

  // Derived, not stored: "the first plan" is what an unmade choice MEANS, and
  // writing it into state from an effect rendered one frame with no selection
  // before correcting itself.
  const planId = chosenPlanId || plans[0]?.id || "";

  if (isLoading) {
    return (
      <div className="space-y-4">
        <div className="grid gap-4 sm:grid-cols-2">
          <Skeleton className="h-16 w-full" />
          <Skeleton className="h-16 w-full" />
        </div>
        <Skeleton className="h-32 w-full" />
      </div>
    );
  }

  const plan: SchemePlan | undefined =
    plans.find((p) => p.id === planId) ?? plans[0];

  if (plans.length === 0 || !plan) {
    return (
      <p className="rounded-lg border border-dashed py-8 text-center text-sm text-muted-foreground">
        No savings-scheme plans are configured yet. Add a plan to project a
        member&apos;s maturity value.
      </p>
    );
  }

  const paidIn = installment * plan.tenureMonths;
  const bonus = installment * plan.bonusMonths;
  const maturityValue = paidIn + bonus;
  const bonusPct = paidIn > 0 ? (bonus / paidIn) * 100 : 0;

  return (
    <div className="space-y-4">
      <div className="grid gap-4 sm:grid-cols-2">
        <div className="space-y-1.5">
          <Label htmlFor="plan">Plan</Label>
          <Select value={plan.id} onValueChange={setPlanId}>
            <SelectTrigger id="plan">
              <SelectValue />
            </SelectTrigger>
            <SelectContent>
              {plans.map((p) => (
                <SelectItem key={p.id} value={p.id}>
                  {p.name}
                </SelectItem>
              ))}
            </SelectContent>
          </Select>
          {plan.bonusLabel ? (
            <p className="text-[11px] text-muted-foreground">
              {plan.bonusLabel}
            </p>
          ) : null}
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
            <dt className="flex items-center gap-1.5 text-muted-foreground">
              <Gift className="h-3.5 w-3.5" />
              Store bonus ({plan.bonusMonths} month
              {plan.bonusMonths === 1 ? "" : "s"})
            </dt>
            <dd className="num font-medium text-success">
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
