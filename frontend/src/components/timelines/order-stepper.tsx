import { Check } from "lucide-react";

import { cn } from "@/lib/utils";
import { ORDER_STAGES } from "@/lib/mock/timelines";

interface OrderStepperProps {
  /** Index of the stage currently in progress. */
  currentStageIndex: number;
  delayed?: boolean;
}

/**
 * Horizontal stage progression for a custom order:
 * Gold melting → Designing → Stone setting → Polishing → Ready for collection.
 * Completed stages are filled, the current stage is ringed, future stages muted.
 */
export function OrderStepper({ currentStageIndex, delayed }: OrderStepperProps) {
  return (
    <ol className="flex w-full items-start">
      {ORDER_STAGES.map((stage, i) => {
        const isComplete = i < currentStageIndex;
        const isCurrent = i === currentStageIndex;
        const isLast = i === ORDER_STAGES.length - 1;

        return (
          <li
            key={stage}
            className={cn("flex flex-1 flex-col items-center", !isLast && "relative")}
          >
            <div className="flex w-full items-center">
              {/* spacer to center the dot over its label on the ends */}
              <div
                className={cn(
                  "h-0.5 flex-1",
                  i === 0 ? "bg-transparent" : isComplete || isCurrent ? "bg-primary" : "bg-border",
                )}
              />
              <div
                className={cn(
                  "flex h-7 w-7 shrink-0 items-center justify-center rounded-full border-2 text-xs font-semibold",
                  isComplete && "border-primary bg-primary text-primary-foreground",
                  isCurrent && !delayed && "border-primary bg-background text-primary ring-2 ring-primary/30",
                  isCurrent && delayed && "border-destructive bg-background text-destructive ring-2 ring-destructive/30",
                  !isComplete && !isCurrent && "border-border bg-background text-muted-foreground",
                )}
                aria-current={isCurrent ? "step" : undefined}
              >
                {isComplete ? <Check className="h-4 w-4" /> : i + 1}
              </div>
              <div
                className={cn(
                  "h-0.5 flex-1",
                  isLast ? "bg-transparent" : isComplete ? "bg-primary" : "bg-border",
                )}
              />
            </div>
            <span
              className={cn(
                "mt-1.5 max-w-[6.5rem] text-center text-[11px] leading-tight",
                isComplete || isCurrent ? "font-medium text-foreground" : "text-muted-foreground",
              )}
            >
              {stage}
            </span>
          </li>
        );
      })}
    </ol>
  );
}
