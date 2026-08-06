"use client";

import { useCallback, useEffect, useMemo, useRef, useState } from "react";
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
  ChevronDown,
  ChevronUp,
  X,
  type LucideIcon,
} from "lucide-react";

import { Card } from "@/components/ui/card";
import { Button } from "@/components/ui/button";
import { cn } from "@/lib/utils";
import { type Role } from "@/lib/types";
import { useSession } from "@/store/use-session";
import {
  useFinishTour,
  useRecordTourView,
  useTourState,
} from "@/lib/queries/onboarding";

/**
 * Fired by the user menu ("Show the quick guide") to reopen this on demand.
 * The menu dispatches a bare `window` Event with this name; the guide listens.
 * Keep this string in sync with the handler in components/layout/user-menu.tsx.
 */
export const OPEN_TOUR_EVENT = "eclat:open-tour";

/** How long to let the page settle before the guide slides in. */
const OPEN_DELAY_MS = 1200;

/**
 * Screens the guide must never open itself on.
 *
 * `/check-in` is a gate with exactly one job — mark attendance and move on — and
 * its controls sit low on the card. On a phone the guide covered "Skip for now"
 * outright and swallowed the click, so the one screen a salesperson must get
 * past every morning became the one screen the guide could trap them on.
 * Reopening by hand from the user menu still works anywhere.
 */
const NO_AUTO_OPEN = ["/check-in"];

interface TourStep {
  /** Plain-English promise — what this page does for you. */
  title: string;
  /** The menu name, so the step is findable again after the guide is gone. */
  where: string;
  /** Two or three short sentences, no system jargon. */
  body: string;
  /** Page this step is about. Only ever opened when the user asks. */
  route?: string;
  icon: LucideIcon;
}

/**
 * Build the step list for a role. Only pages the role can actually open are
 * included, so nobody is shown a door they cannot walk through.
 *
 * House style for the copy: say what the person gets, in the words they would
 * use at the counter. No "geofence", "funnel", "single source of truth", "DSR"
 * on its own, or "unified index" — those are our words, not theirs.
 */
function buildSteps(role: Role, firstName: string): TourStep[] {
  const welcome: TourStep = {
    title: `Hello ${firstName} — welcome to CaratSense`,
    where: "Everywhere",
    body:
      "Everything the shop does in a day — sales, customers, orders and staff attendance — is kept here in one place, instead of across registers and phones. Press Next and this guide walks you through the handful of pages you will actually use, opening each one for you. It takes about a minute, and you can close it whenever you like.",
    icon: Sparkles,
  };

  const searchTip: TourStep = {
    title: "Finding things quickly",
    where: "The search box at the top",
    body:
      "Hold Ctrl and press K (on a Mac, Command and K) from any page to jump straight to a customer, a piece or an order — no need to hunt through menus. You can open this guide again whenever you want from your name in the top-right corner.",
    icon: Search,
  };

  if (role === "salesperson") {
    return [
      welcome,
      {
        title: "Start your day by marking attendance",
        where: "HRMS & Attendance",
        body:
          "One tap to say you have reached the shop — no register to sign. Your phone confirms you are at the shop when you do it, so your hours are recorded correctly and your day can begin.",
        route: "/check-in",
        icon: Fingerprint,
      },
      {
        title: "Keep every customer in one list",
        where: "CRM & Leads",
        body:
          "Save everyone who walks in, calls, or is sent by a friend. The app then tells you who is due for a call back today, so a customer is never forgotten because the note was on a different pad.",
        route: "/crm",
        icon: Users,
      },
      {
        title: "Give a price, or take a made-to-order piece",
        where: "Quotation & Orders",
        body:
          "Put together a price for a customer in a few taps, or book a piece to be made specially for them. Made-to-order pieces go to the workshop by themselves, and you can see how far along the work is at any time.",
        route: "/quotation",
        icon: FileText,
      },
      {
        title: "See what is in stock, anywhere",
        where: "Catalogue",
        body:
          "Look through the pieces at every one of our shops, not just yours. If a customer shows you a photo of something they like, upload it and the app finds the closest pieces we have.",
        route: "/catalogue",
        icon: Gem,
      },
      {
        title: "Savings plans and customer referrals",
        where: "Loyalty & Referral",
        body:
          "Sign customers up for a monthly gold savings plan and see how much they have put in so far. It also tracks the credit a customer has earned for sending friends to us.",
        route: "/loyalty",
        icon: PiggyBank,
      },
      searchTip,
    ];
  }

  // Store manager and above.
  const steps: TourStep[] = [
    welcome,
    {
      title: "Your day at a glance",
      where: "Dashboards",
      body:
        "The page you land on. Today's sales, how the team is doing against target, and anything that needs you — all without opening five different reports.",
      route: "/dashboards",
      icon: LayoutDashboard,
    },
    {
      title: "Every customer enquiry, in one list",
      where: "CRM & Leads",
      body:
        "Walk-ins, phone calls and referrals from all your shops together. You can see at a glance who has been followed up and who has been left waiting.",
      route: "/crm",
      icon: Users,
    },
    {
      title: "Prices and made-to-order pieces",
      where: "Quotation & Orders",
      body:
        "Look through the prices your team has quoted and the pieces customers have ordered specially. Made-to-order pieces go to the workshop and you can follow them stage by stage, so you always have an honest answer when a customer asks when it will be ready.",
      route: "/quotation",
      icon: FileText,
    },
    {
      title: "Everything waiting on your yes or no",
      where: "Approvals",
      body:
        "Discounts, returns and staff leave all queue up here in one list, each with the background you need. No more decisions made over the phone with half the facts.",
      route: "/approvals",
      icon: ClipboardCheck,
    },
    {
      title: "Your daily sales report, written for you",
      where: "Reporting & DSR",
      body:
        "The day's sales summary is prepared automatically. Read it, download it, or send it on to your team over WhatsApp or email without typing it out again.",
      route: "/reporting",
      icon: BarChart3,
    },
  ];

  if (role === "area_manager" || role === "head_office") {
    steps.push({
      title: "Put the shops side by side",
      where: "Store Comparison",
      body:
        "Compare every shop on sales, orders and staff on one screen, instead of opening each one in turn. Your current shop selection stays as it is.",
      route: "/store-comparison",
      icon: GitCompare,
    });
  }

  steps.push(searchTip);
  return steps;
}

/**
 * The welcome guide — a short, role-aware orientation for someone's first days.
 *
 * ## How it behaves
 *
 * It drives. Pressing Next advances to the next step AND opens that function's
 * page, so a first-time user is walked through the app one screen at a time.
 * Steps with no page (the welcome and the search tip) simply advance.
 *
 * It is not a wall. It sits in the corner (clear of the mobile tab bar),
 * leaves the page behind it fully usable, closes on Escape, moves on the arrow
 * keys, and can be folded down to a small bar while you carry on working.
 *
 * ## When it shows up
 *
 * Ten automatic openings per ACCOUNT, then it retires itself — long enough to
 * learn the app, short enough that it never becomes furniture. Progress lives on
 * the server (`/onboarding/tour`), not in the browser, because shop tablets are
 * shared: a browser flag let the first person to close it hide it from everyone
 * who signed in afterwards. Reopening it by hand from the user menu is always
 * free and never counts against the ten.
 */
export function WelcomeTour() {
  const { user, role, authenticated } = useSession();
  const router = useRouter();
  const pathname = usePathname();

  const { data: tour } = useTourState(authenticated);
  const recordView = useRecordTourView();
  const finishTour = useFinishTour();

  const [open, setOpen] = useState(false);
  const [minimized, setMinimized] = useState(false);
  const [step, setStep] = useState(0);
  /** True when reopened from the user menu — a free refresher, not one of the ten. */
  const [manual, setManual] = useState(false);

  /** Auto-open fires once per page load, never again on a re-render. */
  const autoOpened = useRef(false);
  /** The card itself, measured so the page can leave room for it. */
  const cardRef = useRef<HTMLDivElement | null>(null);

  const firstName = user.name.split(" ")[0] || user.name;
  const steps = useMemo(() => buildSteps(role, firstName), [role, firstName]);

  // Derived, not stored: the role (and so the step count) can change under us.
  const safeStep = Math.min(step, steps.length - 1);
  const current = steps[safeStep];
  const isLast = safeStep === steps.length - 1;

  const close = useCallback(() => {
    setOpen(false);
    setMinimized(false);
  }, []);

  /** "Don't show this again" — retire it for this account, right now. */
  const retire = useCallback(() => {
    finishTour.mutate();
    close();
  }, [finishTour, close]);

  /**
   * Go to a step AND open its page. The guide now DRIVES you through each
   * function as you press Next, rather than only describing it — the welcome and
   * search-tip steps have no page, so those just advance.
   */
  const goToStep = useCallback(
    (index: number) => {
      const clamped = Math.max(0, Math.min(steps.length - 1, index));
      setStep(clamped);
      const route = steps[clamped]?.route;
      if (route && route !== pathname) router.push(route);
    },
    [steps, pathname, router],
  );

  // Open by itself on the first visits, after a beat so the page has settled and
  // the guide slides into a finished screen rather than a half-drawn one.
  useEffect(() => {
    if (!tour?.autoOpen || autoOpened.current) return;
    if (NO_AUTO_OPEN.includes(pathname)) return;
    autoOpened.current = true;
    const timer = setTimeout(() => {
      setStep(0);
      setManual(false);
      setMinimized(false);
      setOpen(true);
      recordView.mutate();
    }, OPEN_DELAY_MS);
    return () => clearTimeout(timer);
    // recordView is a stable mutation object; re-running on it would re-arm the timer.
    // `pathname` is included so that landing on a suppressed screen first (e.g.
    // /check-in) only defers the guide — it opens on the next page, rather than
    // being lost for the session.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [tour?.autoOpen, pathname]);

  // Reopening from the user menu: always allowed, always from the start, and
  // never counted — someone asking for a reminder should not be penalised.
  useEffect(() => {
    function reopen() {
      setStep(0);
      setManual(true);
      setMinimized(false);
      setOpen(true);
    }
    window.addEventListener(OPEN_TOUR_EVENT, reopen);
    return () => window.removeEventListener(OPEN_TOUR_EVENT, reopen);
  }, []);

  /**
   * Publish the card's height as `--tour-inset` so the app shell can pad the
   * page by exactly that much while the guide is on screen.
   *
   * Without this the card is a fixed overlay sitting on top of whatever happens
   * to be at the bottom of the page — and on a phone it covered the check-in
   * screen's "Skip for now" button outright, swallowing the click. A guide that
   * blocks the control the user is reaching for is worse than no guide.
   */
  useEffect(() => {
    const root = document.documentElement;
    if (!open) {
      root.style.removeProperty("--tour-inset");
      return;
    }
    const el = cardRef.current;
    if (!el) return;
    const publish = () =>
      root.style.setProperty("--tour-inset", `${el.offsetHeight + 24}px`);
    publish();
    const ro = new ResizeObserver(publish);
    ro.observe(el);
    return () => {
      ro.disconnect();
      root.style.removeProperty("--tour-inset");
    };
  }, [open, minimized, safeStep]);

  // Escape closes; the arrow keys step through. Skipped while folded down so the
  // keys belong to the page again.
  useEffect(() => {
    if (!open || minimized) return;
    function onKey(e: KeyboardEvent) {
      if (e.key === "Escape") {
        e.preventDefault();
        close();
      } else if (e.key === "ArrowRight") {
        goToStep(safeStep + 1);
      } else if (e.key === "ArrowLeft") {
        goToStep(safeStep - 1);
      }
    }
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [open, minimized, close, goToStep, safeStep]);

  if (!open || !current) return null;

  const StepIcon = current.icon;

  // Sits above the mobile tab bar (h-16) and clear of the phone's home
  // indicator; drops to the bottom-right corner once the desktop sidebar takes
  // over. The wrapper ignores clicks so the page behind stays fully usable.
  const anchor = cn(
    "pointer-events-none fixed inset-x-0 bottom-0 z-50 px-4",
    "pb-[calc(4rem+env(safe-area-inset-bottom)+0.75rem)]",
    "md:inset-x-auto md:right-6 md:px-0 md:pb-[calc(env(safe-area-inset-bottom)+1.5rem)]",
  );

  if (minimized) {
    return (
      <div className={anchor}>
        <div
          ref={cardRef}
          className="pointer-events-auto mx-auto flex w-full max-w-sm items-center gap-2 rounded-full border border-border/80 bg-card px-3 py-2 shadow-lg md:mx-0 duration-200 animate-in fade-in slide-in-from-bottom-2"
        >
          <Sparkles className="h-4 w-4 shrink-0 text-gold-strong" />
          <button
            type="button"
            onClick={() => setMinimized(false)}
            className="min-w-0 flex-1 truncate text-left text-xs font-medium"
          >
            Quick guide — step {safeStep + 1} of {steps.length}
          </button>
          <button
            type="button"
            onClick={() => setMinimized(false)}
            aria-label="Open the guide again"
            className="rounded-full p-1 text-muted-foreground hover:text-foreground"
          >
            <ChevronUp className="h-4 w-4" />
          </button>
          <button
            type="button"
            onClick={close}
            aria-label="Close the guide"
            className="rounded-full p-1 text-muted-foreground hover:text-foreground"
          >
            <X className="h-4 w-4" />
          </button>
        </div>
      </div>
    );
  }

  return (
    <div className={anchor}>
      <Card
        ref={cardRef}
        role="dialog"
        aria-label="Quick guide"
        className="pointer-events-auto mx-auto w-full max-w-sm border-border/80 p-5 shadow-2xl md:mx-0 duration-300 animate-in fade-in slide-in-from-bottom-3"
      >
        <div className="flex items-start gap-3">
          <div className="mt-0.5 flex h-9 w-9 shrink-0 items-center justify-center rounded-full bg-[color-mix(in_srgb,var(--gold)_12%,transparent)] text-gold-strong">
            <StepIcon className="h-5 w-5" />
          </div>
          <div className="min-w-0 flex-1">
            <p className="text-xs font-medium text-muted-foreground">
              Step {safeStep + 1} of {steps.length}
            </p>
            <h2 className="mt-0.5 font-display text-base font-bold leading-tight tracking-tight">
              {current.title}
            </h2>
          </div>
          {/* Fold away / close. Both always reachable, so the guide is never
              something you have to finish before you can get back to work. */}
          <div className="flex shrink-0 items-center gap-0.5">
            <button
              type="button"
              onClick={() => setMinimized(true)}
              aria-label="Fold the guide down"
              className="rounded-md p-1 text-muted-foreground hover:text-foreground"
            >
              <ChevronDown className="h-4 w-4" />
            </button>
            <button
              type="button"
              onClick={close}
              aria-label="Close the guide"
              className="rounded-md p-1 text-muted-foreground hover:text-foreground"
            >
              <X className="h-4 w-4" />
            </button>
          </div>
        </div>

        <p className="mt-2 text-[11px] font-medium uppercase tracking-[0.08em] text-muted-foreground">
          Where to find it: {current.where}
        </p>

        <p className="mt-2 text-sm leading-relaxed text-muted-foreground">
          {current.body}
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

        <div className="mt-4 flex items-center justify-between gap-2">
          <button
            type="button"
            onClick={retire}
            className="text-xs font-medium text-muted-foreground underline-offset-4 hover:text-foreground hover:underline"
          >
            Don&apos;t show this again
          </button>
          <div className="flex gap-2">
            {safeStep > 0 ? (
              <Button
                variant="outline"
                size="sm"
                onClick={() => goToStep(safeStep - 1)}
              >
                Back
              </Button>
            ) : null}
            {isLast ? (
              // Finishing just closes it. Reaching the end is not the same as
              // saying "never again" — that is the link on the left, and the ten
              // automatic openings run their course either way.
              <Button size="sm" onClick={close}>
                Done
              </Button>
            ) : (
              // Next moves on AND opens the page — the guide walks you through
              // each function in turn.
              <Button size="sm" onClick={() => goToStep(safeStep + 1)}>
                Next
              </Button>
            )}
          </div>
        </div>

        {/* Say plainly that this stops on its own — otherwise "will this nag me
            forever?" is a fair thing to wonder, and the honest answer is no. */}
        {!manual && tour && !tour.done ? (
          <p className="mt-3 border-t border-border/60 pt-3 text-[11px] leading-relaxed text-muted-foreground">
            {tour.viewsLeft > 0
              ? `This guide opens by itself ${tour.viewsLeft} more ${
                  tour.viewsLeft === 1 ? "time" : "times"
                }, then stops on its own. You can always bring it back from your name in the top-right corner.`
              : "That was the last time this opens by itself. You can always bring it back from your name in the top-right corner."}
          </p>
        ) : null}
      </Card>
    </div>
  );
}
