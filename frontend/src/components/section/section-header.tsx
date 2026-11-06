"use client";

import type { ReactNode } from "react";
import { Plus } from "lucide-react";

import { Button } from "@/components/ui/button";
import { useT } from "@/lib/i18n";

interface SectionHeaderProps {
  title: string;
  /**
   * One-line purpose from MODULES.md. Optional: a screen that is a working
   * surface rather than a report — Conversations, where the three panes want
   * every pixel — omits it and spends that band on the content instead.
   */
  purpose?: string;
  /** Label for the primary CTA. */
  primaryAction?: string;
  onPrimaryAction?: () => void;
  /**
   * Secondary controls, rendered to the LEFT of the primary CTA on the header's
   * own row. Without this a page with a second button had nowhere to put it but
   * a right-aligned strip of its own under the header, which read as a floating
   * orphan and cost a band of empty page above the content.
   */
  actions?: ReactNode;
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
  actions,
}: SectionHeaderProps) {
  const t = useT();

  return (
    <div className={purpose ? "mb-8" : "mb-4"}>
      <div className="flex flex-col gap-4 sm:flex-row sm:items-start sm:justify-between">
        <div className="space-y-2">
          <h1 className="font-display text-2xl font-bold leading-tight tracking-tight text-foreground">
            {t(title, title)}
          </h1>
          {purpose ? (
            <p className="max-w-2xl text-[13px] leading-relaxed text-muted-foreground">
              {t(purpose, purpose)}
            </p>
          ) : null}
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

        {actions || primaryAction ? (
          <div className="flex shrink-0 items-center gap-2">
            {actions}
            {primaryAction ? (
              <Button variant="gold" onClick={onPrimaryAction} className="shrink-0">
                <Plus className="h-4 w-4" />
                {t(primaryAction, primaryAction)}
              </Button>
            ) : null}
          </div>
        ) : null}
      </div>
      <div
        className={`${purpose ? "mt-5" : "mt-3"} h-px bg-border`}
      />
    </div>
  );
}
