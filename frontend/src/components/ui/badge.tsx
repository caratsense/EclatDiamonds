import * as React from "react";
import { cva, type VariantProps } from "class-variance-authority";

import { cn } from "@/lib/utils";

const badgeVariants = cva(
  "inline-flex items-center rounded-full border px-2.5 py-0.5 text-xs font-medium transition-colors focus:outline-none focus:ring-2 focus:ring-ring focus:ring-offset-2",
  {
    variants: {
      // Soft tinted pills — jewel tones, not heavy fills.
      variant: {
        default:
          "border-border bg-secondary text-secondary-foreground",
        gold:
          "border-transparent bg-[color-mix(in_srgb,var(--gold)_14%,transparent)] text-gold-strong",
        secondary:
          "border-border bg-secondary text-secondary-foreground",
        destructive:
          "border-transparent bg-[color-mix(in_srgb,var(--destructive)_14%,transparent)] text-destructive",
        outline: "border-border text-foreground",
        success:
          "border-transparent bg-[color-mix(in_srgb,var(--success)_15%,transparent)] text-success",
        warning:
          "border-transparent bg-[color-mix(in_srgb,var(--warning)_16%,transparent)] text-warning",
      },
    },
    defaultVariants: {
      variant: "default",
    },
  },
);

export interface BadgeProps
  extends React.HTMLAttributes<HTMLSpanElement>,
    VariantProps<typeof badgeVariants> {}

function Badge({ className, variant, ...props }: BadgeProps) {
  return (
    <span className={cn(badgeVariants({ variant }), className)} {...props} />
  );
}

export { Badge, badgeVariants };
