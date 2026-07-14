"use client";

import { useEffect, useMemo, useState } from "react";
import { usePathname, useRouter } from "next/navigation";
import {
  Sparkles,
  Fingerprint,
  Users,
  FileText,
  Gem,
  PiggyBank,
  LayoutDashboard,
  ClipboardCheck,
  BarChart3,
  GitCompare,
  Search,
  type LucideIcon,
} from "lucide-react";

import { Card } from "@/components/ui/card";
import { Button } from "@/components/ui/button";
import { cn } from "@/lib/utils";
import { type Role } from "@/lib/types";
import { homeForRole } from "@/lib/navigation";
import { useSession } from "@/store/use-session";

/**
 * Fired by the user menu ("Show welcome tour") to re-open this tour on demand.
 * The menu dispatches a bare `window` Event with this name; the tour listens.
 * Keep this string in sync with the handler in components/layout/user-menu.tsx.
 */
export const OPEN_TOUR_EVENT = "eclat:open-tour";

/** Once dismissed, the tour never auto-opens again (re-open is manual). */
const SEEN_KEY = "eclat.tourSeen";

interface TourStep {
  /** Short topic name — the heading of the step. */
  topic: string;
  /** One to two lines describing what the page behind the card does. */
  description: string;
  /** Real route pushed on entering the step, so the page loads behind. */
  route: string;
  icon: LucideIcon;
}

/**
 * Build the role-aware step list. Each step names a topic, describes the
 * screen, and carries the real route the tour navigates to. Only routes the
 * role can actually see are included (mirrors nav visibility in navigation.ts).
 */
function buildSteps(role: Role, firstName: string): TourStep[] {
  const home = homeForRole(role);

  const welcome: TourStep = {
    topic: `Welcome to CaratSense, ${firstName}`,
    description:
      "CaratSense brings your store's sales, customers, orders and attendance together in one workspace. This short tour walks you through the pages you will use most.",
    route: home,
    icon: Sparkles,
  };

  const searchTip: TourStep = {
    topic: "Search anything",
    description:
      "Press Ctrl or Cmd + K at any time to search customers, products and orders from anywhere in the app. You can reopen this tour from the menu under your avatar.",
    route: home,
    icon: Search,
  };

  if (role === "salesperson") {
    return [
      welcome,
      {
        topic: "Attendance",
        description:
          "Mark your attendance by confirming you are at the store. Your location is checked against the store's geofence before the day begins.",
        route: "/check-in",
        icon: Fingerprint,
      },
      {
        topic: "CRM & Leads",
        description:
          "Capture and track every prospective customer — walk-ins, calls and referrals — in a single funnel, so no follow-up is lost.",
        route: "/crm",
        icon: Users,
      },
      {
        topic: "Quotation & Orders",
        description:
          "Build a price quote or place a custom order in one place. Custom orders route to the back office and appear on the production timeline.",
        route: "/quotation",
        icon: FileText,
      },
      {
        topic: "Catalogue",
        description:
          "Browse the unified product index across locations, with AI image search to find a piece directly from a photo.",
        route: "/catalogue",
        icon: Gem,
      },
      {
        topic: "Loyalty & Referral",
        description:
          "Enroll customers in gold-savings schemes and manage the referral wallet credit against their purchases.",
        route: "/loyalty",
        icon: PiggyBank,
      },
      searchTip,
    ];
  }

  // Manager and above: store_manager, area_manager, head_office.
  const steps: TourStep[] = [
    welcome,
    {
      topic: "Dashboards",
      description:
        "Your role dashboard shows store performance at a glance, with tasks and cross-department collaboration in one view.",
      route: "/dashboards",
      icon: LayoutDashboard,
    },
    {
      topic: "CRM & Leads",
      description:
        "The single source of truth for every prospective customer across channels, with each store's funnel and follow-ups in one place.",
      route: "/crm",
      icon: Users,
    },
    {
      topic: "Quotation & Orders",
      description:
        "Review quotes and custom orders raised by your team. Custom orders flow to the back office and the production timeline.",
      route: "/quotation",
      icon: FileText,
    },
    {
      topic: "Approvals",
      description:
        "One queue for everything awaiting your decision — discount, return and leave requests — with the context to act on each.",
      route: "/approvals",
      icon: ClipboardCheck,
    },
    {
      topic: "Reporting & DSR",
      description:
        "Automated daily sales reports and store analytics, ready to review, export or share with your team.",
      route: "/reporting",
      icon: BarChart3,
    },
  ];

  if (role === "area_manager" || role === "head_office") {
    steps.push({
      topic: "Store Comparison",
      description:
        "Compare every store side by side on revenue, orders and staff — without switching the active store.",
      route: "/store-comparison",
      icon: GitCompare,
    });
  }

  steps.push(searchTip);
  return steps;
}

/**
 * First-run welcome tour (Module: onboarding). An interactive, role-aware
 * guide that navigates through the real pages as you advance. It renders as a
 * compact, non-blocking card pinned to the bottom of the screen — the page it
 * describes loads and stays fully visible behind it. No tour library: plain
 * step state, `router.push` per step, and a shadcn Card.
 *
 * Triggers (unchanged): opens once on the first authenticated visit via
 * localStorage["eclat.tourSeen"], and re-opens on the `eclat:open-tour` event
 * dispatched by the user menu.
 */
export function WelcomeTour() {
  const { user, role } = useSession();
  const router = useRouter();
  const pathname = usePathname();
  const [open, setOpen] = useState(false);
  const [step, setStep] = useState(0);

  const firstName = user.name.split(" ")[0] || user.name;
  const steps = useMemo(() => buildSteps(role, firstName), [role, firstName]);

  // Keep the step index in range if the role (and therefore step count) changes.
  const safeStep = Math.min(step, steps.length - 1);
  const current = steps[safeStep];
  const isLast = safeStep === steps.length - 1;

  // First authenticated visit: open once, unless already dismissed.
  useEffect(() => {
    if (typeof window === "undefined") return;
    if (localStorage.getItem(SEEN_KEY) !== "1") {
      setStep(0);
      setOpen(true);
    }
  }, []);

  // Let the user menu ("Show welcome tour") re-open the tour any time,
  // always restarting from step 0.
  useEffect(() => {
    function reopen() {
      setStep(0);
      setOpen(true);
    }
    window.addEventListener(OPEN_TOUR_EVENT, reopen);
    return () => window.removeEventListener(OPEN_TOUR_EVENT, reopen);
  }, []);

  // On entering a step, navigate to its real page so it loads behind the card.
  // Guarded on pathname so a completed navigation does not re-push (no loop).
  useEffect(() => {
    if (!open) return;
    const route = steps[safeStep]?.route;
    if (route && route !== pathname) {
      router.push(route);
    }
  }, [open, safeStep, steps, pathname, router]);

  function dismiss() {
    if (typeof window !== "undefined") {
      localStorage.setItem(SEEN_KEY, "1");
    }
    setOpen(false);
  }

  function finish() {
    router.push(homeForRole(role));
    dismiss();
  }

  if (!open || !current) return null;

  const StepIcon = current.icon;

  return (
    // Outer layer spans the screen but lets clicks pass through, so the page
    // behind stays fully interactive. Only the card itself captures pointers.
    <div className="pointer-events-none fixed inset-x-0 bottom-6 z-50 px-4">
      <Card
        role="dialog"
        aria-label="Welcome tour"
        className="pointer-events-auto mx-auto w-full max-w-md border-border/80 p-5 shadow-2xl"
      >
        <div className="flex items-start gap-3">
          <div className="mt-0.5 flex h-9 w-9 shrink-0 items-center justify-center rounded-full bg-[color-mix(in_srgb,var(--gold)_12%,transparent)] text-gold-strong">
            <StepIcon className="h-5 w-5" />
          </div>
          <div className="min-w-0 flex-1">
            <p className="text-xs font-medium text-muted-foreground">
              Step {safeStep + 1} of {steps.length}
            </p>
            <h2 className="mt-0.5 font-display text-lg font-semibold leading-tight tracking-tight">
              {current.topic}
            </h2>
          </div>
        </div>

        <p className="mt-3 text-sm leading-relaxed text-muted-foreground">
          {current.description}
        </p>

        <div className="mt-4 flex items-center gap-1.5" aria-hidden="true">
          {steps.map((_, i) => (
            <span
              key={i}
              className={cn(
                "h-1.5 rounded-full transition-all",
                i === safeStep
                  ? "w-5 bg-primary"
                  : "w-1.5 bg-muted-foreground/30",
              )}
            />
          ))}
        </div>

        <div className="mt-4 flex items-center justify-between">
          <button
            type="button"
            onClick={dismiss}
            className="text-xs font-medium text-muted-foreground underline-offset-4 hover:text-foreground hover:underline"
          >
            Skip tour
          </button>
          <div className="flex gap-2">
            {safeStep > 0 ? (
              <Button
                variant="outline"
                size="sm"
                onClick={() => setStep((s) => Math.max(0, s - 1))}
              >
                Back
              </Button>
            ) : null}
            {isLast ? (
              <Button size="sm" onClick={finish}>
                Get started
              </Button>
            ) : (
              <Button
                size="sm"
                onClick={() =>
                  setStep((s) => Math.min(steps.length - 1, s + 1))
                }
              >
                Next
              </Button>
            )}
          </div>
        </div>
      </Card>
    </div>
  );
}
