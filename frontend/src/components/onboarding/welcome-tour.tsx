"use client";

import { useEffect, useState, type ReactNode } from "react";
import { Compass, Sparkles } from "lucide-react";

import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";
import { Button } from "@/components/ui/button";
import { cn } from "@/lib/utils";
import { ROLE_LABELS, type Role } from "@/lib/types";
import { useSession } from "@/store/use-session";
import { useT } from "@/lib/i18n";

/**
 * Fired by the user menu ("Show welcome tour") to re-open this tour on demand.
 * The menu dispatches a bare `window` Event with this name; the tour listens.
 * Keep this string in sync with the handler in components/layout/user-menu.tsx.
 */
export const OPEN_TOUR_EVENT = "eclat:open-tour";

/** Once dismissed, the tour never auto-opens again (re-open is manual). */
const SEEN_KEY = "eclat.tourSeen";

interface TourStep {
  title: string;
  body: ReactNode;
}

/** Role-aware "start here" line for step 3 — same screen, different first move. */
function startHereFor(role: Role): string {
  switch (role) {
    case "salesperson":
      return "Add a lead in CRM, build a Quote, and mark your attendance for the day.";
    case "store_manager":
      return "Check your dashboard, clear approvals, and file the daily report (DSR).";
    case "area_manager":
    case "head_office":
      return "Open the Dashboards, compare branches in Store Comparison, and action Approvals across stores.";
    default:
      return "Start from your dashboard, then open any module from the sidebar.";
  }
}

/** Translation key for the role's "start here" line (English lives in startHereFor). */
function startHereKeyFor(role: Role): string {
  switch (role) {
    case "salesperson":
      return "tour.start.salesperson";
    case "store_manager":
      return "tour.start.store_manager";
    case "area_manager":
    case "head_office":
      return "tour.start.manager";
    default:
      return "tour.start.default";
  }
}

/**
 * First-run welcome tour (Module: onboarding). A compact, role-aware Dialog
 * shown once on the first authenticated visit and re-openable from the user
 * menu. No tour library — plain step state over a shadcn Dialog.
 */
export function WelcomeTour() {
  const { user, role, currentStore } = useSession();
  const t = useT();
  const [open, setOpen] = useState(false);
  const [step, setStep] = useState(0);

  // First authenticated visit: open once, unless already dismissed.
  useEffect(() => {
    if (typeof window === "undefined") return;
    if (localStorage.getItem(SEEN_KEY) !== "1") {
      setStep(0);
      setOpen(true);
    }
  }, []);

  // Let the user menu ("Show welcome tour") re-open the tour any time.
  useEffect(() => {
    function reopen() {
      setStep(0);
      setOpen(true);
    }
    window.addEventListener(OPEN_TOUR_EVENT, reopen);
    return () => window.removeEventListener(OPEN_TOUR_EVENT, reopen);
  }, []);

  const firstName = user.name.split(" ")[0] || user.name;
  const roleName = ROLE_LABELS[role] ?? t("tour.start.roleFallback", "a team member");

  // Split the (translated) "where you are" body on the {store} placeholder so
  // the current store name stays emphasized in either language.
  const whereBody = t(
    "tour.where.body",
    "Use the store switcher in the top bar to change stores — everything you see is scoped to the selected store (right now, {store}). The sidebar on the left groups your tools by area.",
  ).split("{store}");

  const steps: TourStep[] = [
    {
      title: t("tour.welcome.title", "Welcome, {name}.").replace(
        "{name}",
        firstName,
      ),
      body: t(
        "tour.welcome.body",
        "CaratSense keeps your store's sales, customers, orders and attendance in one place.",
      ),
    },
    {
      title: t("tour.where.title", "Where you are"),
      body: (
        <>
          {whereBody[0]}
          <strong>{currentStore.name}</strong>
          {whereBody[1] ?? ""}
        </>
      ),
    },
    {
      title: t("tour.start.title", "Start here"),
      body: (
        <>
          {t("tour.start.prefix", "As {role}:").replace("{role}", roleName)}{" "}
          {t(startHereKeyFor(role), startHereFor(role))}
        </>
      ),
    },
    {
      title: t("tour.tip.title", "A quick tip"),
      body: t(
        "tour.tip.body",
        "Hover any sidebar item to see what it does. You can reopen this tour any time from the menu under your avatar (top-right).",
      ),
    },
  ];

  const isLast = step === steps.length - 1;
  const current = steps[step];

  function dismiss() {
    if (typeof window !== "undefined") {
      localStorage.setItem(SEEN_KEY, "1");
    }
    setOpen(false);
  }

  return (
    <Dialog
      open={open}
      onOpenChange={(next) => {
        // Any close (X, overlay, Esc, Skip, Get started) counts as "seen".
        if (next) setOpen(true);
        else dismiss();
      }}
    >
      <DialogContent className="sm:max-w-md">
        <DialogHeader>
          <div className="mb-1 flex h-9 w-9 items-center justify-center rounded-full bg-amber-100 text-amber-700 dark:bg-amber-950/40 dark:text-amber-400">
            {isLast ? (
              <Compass className="h-5 w-5" />
            ) : (
              <Sparkles className="h-5 w-5" />
            )}
          </div>
          <DialogTitle>{current.title}</DialogTitle>
          <DialogDescription className="leading-relaxed">
            {current.body}
          </DialogDescription>
        </DialogHeader>

        <div className="flex items-center gap-1.5" aria-hidden="true">
          {steps.map((_, i) => (
            <span
              key={i}
              className={cn(
                "h-1.5 rounded-full transition-all",
                i === step ? "w-5 bg-primary" : "w-1.5 bg-muted-foreground/30",
              )}
            />
          ))}
        </div>

        <DialogFooter className="mt-2 sm:items-center sm:justify-between">
          <Button variant="ghost" size="sm" onClick={dismiss}>
            {t("tour.skip", "Skip")}
          </Button>
          <div className="flex gap-2">
            {step > 0 ? (
              <Button
                variant="outline"
                size="sm"
                onClick={() => setStep((s) => Math.max(0, s - 1))}
              >
                {t("tour.back", "Back")}
              </Button>
            ) : null}
            {isLast ? (
              <Button size="sm" onClick={dismiss}>
                {t("tour.getStarted", "Get started")}
              </Button>
            ) : (
              <Button
                size="sm"
                onClick={() =>
                  setStep((s) => Math.min(steps.length - 1, s + 1))
                }
              >
                {t("tour.next", "Next")}
              </Button>
            )}
          </div>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}
