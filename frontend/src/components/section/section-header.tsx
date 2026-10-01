"use client";

import { Plus } from "lucide-react";

import { Button } from "@/components/ui/button";
import { useT } from "@/lib/i18n";

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
 *
 * The heading and its button run through the tenant's industry vocabulary. This
 * is the only place they can: every page builds its own title from
 * `getNavItem(slug)` at MODULE scope, where no tenant is known and no hook can
 * run, so relabelling at each page would have meant editing all of them. Doing
 * it here means the sidebar and the page it opens always agree — a clinic that
 * clicks "Patients" does not land on a screen headed "Customers".
 */
export function SectionHeader({
  title,
  purpose,
  primaryAction,
  onPrimaryAction,
}: SectionHeaderProps) {
  const t = useT();

  return (
    <div className="mb-8">
      <div className="flex flex-col gap-4 sm:flex-row sm:items-start sm:justify-between">
        <div className="space-y-2">
          <h1 className="font-display text-[30px] font-bold leading-tight tracking-tight text-foreground">
            {t(title, title)}
          </h1>
          <p className="max-w-2xl text-sm leading-relaxed text-muted-foreground">
            {t(purpose, purpose)}
          </p>
          {/*
            The active store and the signed-in role used to be repeated here as
            two chips. The top bar carries both already — `StoreSwitcher` and
            `RoleBadge` sit above every page in the (app) layout — so this was
            the same two facts stated twice, a few centimetres apart, on all 17
            sections.

            Removed rather than restyled: a second copy of a control you cannot
            act on is not reassurance, it is noise, and it pushed the content
            every screen exists to show further down the page.
          */}
        </div>

        {primaryAction ? (
          <Button
            variant="gold"
            onClick={onPrimaryAction}
            className="shrink-0 shadow-sm"
          >
            <Plus className="h-4 w-4" />
            {t(primaryAction, primaryAction)}
          </Button>
        ) : null}
      </div>
      <div className="mt-5 h-px bg-gradient-to-r from-border via-border to-transparent" />
    </div>
  );
}
