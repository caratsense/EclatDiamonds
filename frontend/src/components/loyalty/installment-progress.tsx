import { cn } from "@/lib/utils";

interface InstallmentProgressProps {
  paidMonths: number;
  tenureMonths: number;
  missedMonths: number;
}

/**
 * Installment tracker bar (Module 17): visualises months paid vs. tenure,
 * tinted red when the account has missed payments.
 */
export function InstallmentProgress({
  paidMonths,
  tenureMonths,
  missedMonths,
}: InstallmentProgressProps) {
  const pct = tenureMonths > 0 ? Math.min(100, (paidMonths / tenureMonths) * 100) : 0;
  const atRisk = missedMonths > 0;

  return (
    <div className="space-y-1">
      <div className="flex items-center justify-between text-xs">
        <span className="num">
          {paidMonths} / {tenureMonths} paid
        </span>
        {missedMonths > 0 ? (
          <span className="num text-destructive">
            {missedMonths} missed
          </span>
        ) : null}
      </div>
      <div className="h-2 w-full overflow-hidden rounded-full bg-muted">
        <div
          className={cn(
            "h-full rounded-full transition-all",
            atRisk ? "bg-warning" : "bg-success",
          )}
          style={{ width: `${pct}%` }}
        />
      </div>
    </div>
  );
}
