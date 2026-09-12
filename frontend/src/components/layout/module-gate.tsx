"use client";

import Link from "next/link";
import { usePathname } from "next/navigation";
import { Lock } from "lucide-react";

import { Button } from "@/components/ui/button";
import { Skeleton } from "@/components/ui/skeleton";
import { CORE_NAVIGATION, NAV_ITEMS, homeForRole } from "@/lib/navigation";
import { useEnabledNavigation } from "@/lib/queries/tenant-config";
import { useSession } from "@/store/use-session";

/**
 * One client-side gate for every module, mounted once in the authenticated
 * layout (multi-market phase 2, MM-01; made fail-closed in phase 4, MM3-03).
 *
 * ## Why one gate and not a check per page
 *
 * A check per page is a check somebody forgets. There are thirty-three screens
 * and more arriving; the only version of this that stays true is the one that
 * runs before any of them render. So this sits in the (app) layout, between the
 * session gate and the page, and decides from the route alone.
 *
 * ## It is not the security boundary
 *
 * The server is. `EntitlementGuard` refuses the API regardless of what the
 * browser does, and this gate would be pointless as a defence — anyone able to
 * edit the URL can edit the JavaScript. What it buys is honesty: without it a
 * clinic that types /finance gets a rendered Finance page whose every panel then
 * fails with a 403, which reads as a broken product rather than one they do not
 * have.
 *
 * ## What phase 4 changed
 *
 * The final branch used to read `if (!enabled || enabled.includes(slug))`, which
 * rendered the page whenever the navigation list was absent. The server had
 * already moved the other way — an unresolvable pack is refused a vertical
 * module — so the two disagreed, and the disagreement was on the permissive
 * side. The `||` is gone: there is no input for which this gate now renders a
 * vertical module it cannot positively justify.
 */
export function ModuleGate({ children }: { children: React.ReactNode }) {
  const pathname = usePathname();
  const role = useSession((s) => s.role);
  const enabled = useEnabledNavigation();

  switch (gateDecision(pathname, enabled)) {
    case "render":
      return <>{children}</>;
    case "hold":
      return (
        <div className="space-y-4" aria-busy="true">
          <Skeleton className="h-9 w-72" />
          <Skeleton className="h-64 w-full" />
        </div>
      );
    case "refuse":
      return <NotInYourPlan home={homeForRole(role, enabled)} />;
  }
}

/** What the gate should do with a route. */
export type GateDecision = "render" | "hold" | "refuse";

/**
 * The entire gate policy, as a pure function.
 *
 * `enabled` is the tenant's navigation list, or `undefined` while the bootstrap
 * request is still in flight — that is the only meaning `undefined` carries.
 * Once the request settles, `useEnabledNavigation` supplies the industry-neutral
 * core for a tenant whose pack is missing or unrecognised, so "no answer" and
 * "an answer that happens to be the core list" are genuinely different states
 * here rather than being collapsed into one permissive branch.
 *
 * The three outcomes, in the order they are decided:
 *
 *  - not a module route at all (`/check-in`, `/settings`, an unknown path):
 *    render, because there is nothing to decide;
 *  - a route in `CORE_NAVIGATION`: render immediately and never wait. Every
 *    industry pack contains the core, so no answer can arrive that would take
 *    it away, and making the universal suite — which is nearly every navigation
 *    in practice — sit behind a skeleton would be a delay that buys nothing;
 *  - a vertical route: wait for the answer if it has not arrived, then render
 *    only if the tenant's list actually contains it.
 *
 * The waiting matters: rendering a vertical module first and withdrawing it a
 * moment later is the flash this exists to prevent, and it is also the worst
 * version of the message — the tenant sees Finance appear and then be taken
 * away, which reads as a fault rather than as a setting.
 */
export function gateDecision(
  pathname: string | null,
  enabled: readonly string[] | undefined,
): GateDecision {
  const slug = navSlugForPath(pathname);
  if (!slug) return "render";
  /*
   * A CORE route renders immediately WHILE THE ANSWER IS STILL IN FLIGHT, and
   * only then.
   *
   * The original rule was `if (CORE_NAVIGATION.includes(slug)) return "render"`
   * unconditionally, which was exactly right when the only thing that could
   * remove a module was the industry pack: every pack contains the core, so no
   * answer could arrive that took one away, and making the universal suite —
   * nearly every navigation in practice — sit behind a skeleton bought nothing.
   *
   * A tenant can now switch individual modules off, and most of the core is
   * switchable (the spine that is not is listed in the backend's
   * UNDISABLEABLE_CAPABILITIES). Under the old rule a tenant who turned the
   * catalogue off would still be handed the catalogue shell, whose every panel
   * then 403s — which is precisely the "reads as a broken product rather than
   * one they do not have" failure this gate exists to prevent.
   *
   * So the fast path survives where it earns its keep (no skeleton while
   * loading) and defers to the tenant's own list once there is one.
   */
  if (enabled === undefined) {
    return CORE_NAVIGATION.includes(slug) ? "render" : "hold";
  }
  return enabled.includes(slug) ? "render" : "refuse";
}

function NotInYourPlan({ home }: { home: string }) {
  return (
    <div className="mx-auto flex max-w-md flex-col items-center px-6 py-24 text-center">
      <span className="mb-4 flex h-12 w-12 items-center justify-center rounded-full bg-muted text-muted-foreground">
        <Lock className="h-5 w-5" />
      </span>
      <h1 className="font-display text-2xl font-bold tracking-tight">
        This section is not part of your setup
      </h1>
      <p className="mt-2 text-sm leading-relaxed text-muted-foreground">
        Your industry decides which sections your team sees. Head office can change it
        under Settings → Business configuration.
      </p>
      <Button asChild className="mt-6">
        <Link href={home}>Back to your workspace</Link>
      </Button>
    </div>
  );
}

/**
 * The navigation slug a path belongs to, or null when the path is not a module.
 *
 * Longest match wins so `/settings/rates` resolves to `settings/rates` rather
 * than to nothing, and a detail route like `/crm/lead-123` resolves to `crm`.
 */
export function navSlugForPath(pathname: string | null): string | null {
  const path = (pathname ?? "/").replace(/^\/+|\/+$/g, "");
  if (!path) return null;
  let best: string | null = null;
  for (const item of NAV_ITEMS) {
    if (path !== item.slug && !path.startsWith(`${item.slug}/`)) continue;
    if (!best || item.slug.length > best.length) best = item.slug;
  }
  return best;
}
