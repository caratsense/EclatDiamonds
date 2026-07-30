"use client";

import { Plus } from "lucide-react";

import { Button } from "@/components/ui/button";
import { ROLE_LABELS } from "@/lib/types";
import { useSession } from "@/store/use-session";

interface SectionHeaderProps {
  title: string;
  /** One-line purpose from MODULES.md. */
  purpose: string;
  /** Label for the primary CTA. */
  primaryAction?: string;
  onPrimaryAction?: () => void;
}

/**
 * Consistent page header for all 17 sections.
 * Shows the active store + role so the user always knows the scope of
 * what they're looking at. role/store-scoped — Phase 2 wires CTAs + filters.
 */
export function SectionHeader({
  title,
  purpose,
  primaryAction,
  onPrimaryAction,
}: SectionHeaderProps) {
  const { currentStore, role } = useSession();

  return (
    <div className="mb-8">
      <div className="flex flex-col gap-4 sm:flex-row sm:items-start sm:justify-between">
        <div className="space-y-2">
          <h1 className="font-display text-[30px] font-bold leading-tight tracking-tight text-foreground">
            {title}
          </h1>
          <p className="max-w-2xl text-sm leading-relaxed text-muted-foreground">
            {purpose}
          </p>
          <div className="flex flex-wrap items-center gap-2 pt-1">
            <span className="inline-flex items-center gap-1.5 rounded-full border bg-card px-2.5 py-1 text-xs font-medium text-foreground shadow-xs">
              <span className="h-1.5 w-1.5 rounded-full bg-[var(--gold)]" />
              {currentStore.name}
            </span>
            <span className="inline-flex items-center gap-1.5 rounded-full border bg-card px-2.5 py-1 text-xs font-medium text-muted-foreground shadow-xs">
              <span className="h-1.5 w-1.5 rounded-full bg-primary" />
              {ROLE_LABELS[role]} view
            </span>
          </div>
        </div>

        {primaryAction ? (
          <Button
            variant="gold"
            onClick={onPrimaryAction}
            className="shrink-0 shadow-sm"
          >
            <Plus className="h-4 w-4" />
            {primaryAction}
          </Button>
        ) : null}
      </div>
      <div className="mt-5 h-px bg-gradient-to-r from-border via-border to-transparent" />
    </div>
  );
}
