"use client";

import Link from "next/link";
import {
  ArrowRight,
  Building2,
  CheckCircle2,
  Circle,
  Database,
  GitBranch,
  Plug,
  SlidersHorizontal,
  UsersRound,
} from "lucide-react";
import type { LucideIcon } from "lucide-react";

import { SectionHeader } from "@/components/section/section-header";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Card, CardContent } from "@/components/ui/card";
import { Skeleton } from "@/components/ui/skeleton";
import { usePipelines } from "@/lib/queries/crm";
import { useImportHistory } from "@/lib/queries/imports";
import { useStoresAdmin } from "@/lib/queries/stores";
import { useStaff } from "@/lib/queries/users";
import {
  useConfigBootstrap,
  useIntegrations,
  useOriginReconciliation,
} from "@/lib/queries/tenant-config";

/**
 * Getting started (Phase A11 / A2).
 *
 * NOT a wizard. A wizard is a sequence someone is trapped in, and it lies the
 * moment a step is completed elsewhere — which every one of these can be.
 * This reads the tenant's ACTUAL state on each visit and says what is and is
 * not done, so it is equally correct on day one, mid-setup, and for someone who
 * imported their data before they ever opened this page.
 *
 * Every step is generic. There is no jewellery branch here and no per-industry
 * variant: a pharmacy, a textile business and a jeweller all complete the same
 * six steps, and what differs between them comes from the industry pack.
 */

interface Step {
  key: string;
  title: string;
  detail: string;
  icon: LucideIcon;
  href: string;
  action: string;
  done: boolean;
  /** Shown once complete — the concrete thing that satisfied the step. */
  evidence?: string;
  /** Blocks nothing, but the setup is not meaningfully usable without it. */
  essential: boolean;
}

export default function OnboardingPage() {
  const { data: config, isLoading: configLoading } = useConfigBootstrap();
  const { data: stores, isLoading: storesLoading } = useStoresAdmin();
  const { data: staff } = useStaff();
  const { data: pipelines } = usePipelines();
  const { data: imports } = useImportHistory();
  const { data: integrations } = useIntegrations();
  const { data: reconcile } = useOriginReconciliation();

  if (configLoading || storesLoading) {
    return (
      <div className="space-y-4">
        <Skeleton className="h-24 w-full" />
        <Skeleton className="h-96 w-full" />
      </div>
    );
  }

  const activeStores = stores?.filter((s) => s.status === "active") ?? [];
  // `state` is the server's derived answer to "can this tenant use it right
  // now", which also accounts for a missing or expired credential and for a
  // provider that is blocked at the platform level.
  const connectedCount = (integrations ?? []).filter((i) => i.state === "connected").length;
  const configuringCount = (integrations ?? []).filter(
    (i) => i.state === "configuring" || i.state === "degraded",
  ).length;
  const importedRows =
    (reconcile ? Object.values(reconcile.byOrigin).reduce((n, c) => n + c.fromCustomer, 0) : 0) ||
    (imports?.reduce((n, b) => n + b.imported + b.updated, 0) ?? 0);

  const steps: Step[] = [
    {
      key: "industry",
      title: "Choose your industry",
      detail:
        "Sets the words your business uses — categories, sources and the fields your team fills in. You can change any of them afterwards.",
      icon: SlidersHorizontal,
      href: "/settings/configuration",
      action: "Choose industry",
      done: !!config?.industry.packCode,
      evidence: config?.industry.packName ?? undefined,
      essential: true,
    },
    {
      key: "stores",
      title: "Add your locations",
      detail:
        "Every record belongs to a branch. Add each one you operate before your team starts entering data against it.",
      icon: Building2,
      href: "/settings/stores",
      action: "Add a location",
      done: activeStores.length > 0,
      evidence:
        activeStores.length > 0
          ? `${activeStores.length} active location${activeStores.length === 1 ? "" : "s"}`
          : undefined,
      essential: true,
    },
    {
      key: "team",
      title: "Invite your team",
      detail:
        "Give each person a role and the branches they work at. What they can see follows from that — there is nothing else to configure.",
      icon: UsersRound,
      href: "/settings/team",
      action: "Add staff",
      done: (staff?.length ?? 0) > 1,
      evidence: staff?.length ? `${staff.length} people` : undefined,
      essential: true,
    },
    {
      key: "data",
      title: "Bring your existing records in",
      detail:
        "Import customers and products from a spreadsheet, or connect the system you already run. Nothing is imported until you have seen the preview.",
      icon: Database,
      href: "/data",
      action: "Import data",
      done: importedRows > 0,
      evidence: importedRows > 0 ? `${importedRows} records from your own system` : undefined,
      essential: true,
    },
    {
      key: "pipeline",
      title: "Match the sales stages to how you sell",
      detail:
        "Rename or add the stages an enquiry moves through. The standard three work as they are if they already fit.",
      icon: GitBranch,
      href: "/settings/configuration",
      action: "Set up stages",
      done: (pipelines?.length ?? 0) > 0,
      evidence: pipelines?.[0]
        ? `${pipelines[0].stages.length} stages in “${pipelines[0].name}”`
        : undefined,
      essential: false,
    },
    {
      key: "integrations",
      title: "Connect your channels",
      detail:
        "Messaging, payments and market data. Anything not connected simply stays off — nothing here is required to start.",
      icon: Plug,
      href: "/settings/integrations",
      action: "Connect",
      // Counting Integration ROWS would have called a half-finished setup
      // "done": a row exists the moment someone starts, before any credential
      // is saved. The server's derived state is what actually says whether the
      // tenant can use it.
      done: connectedCount > 0,
      evidence: connectedCount
        ? `${connectedCount} working`
        : configuringCount
          ? `${configuringCount} started but not finished`
          : undefined,
      essential: false,
    },
  ];

  const doneCount = steps.filter((s) => s.done).length;
  const essentialsLeft = steps.filter((s) => s.essential && !s.done);

  return (
    <div>
      <SectionHeader
        title="Getting started"
        purpose="What is set up, and what is left. This reflects your live settings, so it stays right however you get there."
      />

      <Card className="mb-4">
        <CardContent className="flex flex-wrap items-center justify-between gap-4 pt-6">
          <div>
            <p className="text-2xl font-semibold">
              <span className="num">{doneCount}</span>
              <span className="text-muted-foreground"> of {steps.length} done</span>
            </p>
            <p className="mt-1 text-sm text-muted-foreground">
              {essentialsLeft.length === 0
                ? "The essentials are in place — everything below is optional."
                : `Still needed: ${essentialsLeft.map((s) => s.title.toLowerCase()).join(", ")}.`}
            </p>
          </div>
          <div className="h-2 w-full max-w-xs overflow-hidden rounded-full bg-muted sm:w-48">
            <div
              className="h-full rounded-full bg-[var(--gold)] transition-all"
              style={{ width: `${(doneCount / steps.length) * 100}%` }}
            />
          </div>
        </CardContent>
      </Card>

      <div className="space-y-3">
        {steps.map((step) => (
          <Card key={step.key} className={step.done ? "opacity-70" : undefined}>
            <CardContent className="flex flex-wrap items-start gap-4 pt-6">
              <span
                className={`flex h-9 w-9 shrink-0 items-center justify-center rounded-full ${
                  step.done ? "bg-emerald-500/10 text-emerald-600" : "bg-muted text-muted-foreground"
                }`}
              >
                {step.done ? (
                  <CheckCircle2 className="h-4.5 w-4.5" />
                ) : (
                  <step.icon className="h-4 w-4" />
                )}
              </span>
              <div className="min-w-0 flex-1 space-y-1">
                <p className="flex flex-wrap items-center gap-2 font-medium">
                  {step.title}
                  {!step.essential && (
                    <Badge variant="outline" className="text-[10px] font-normal">
                      Optional
                    </Badge>
                  )}
                </p>
                <p className="text-sm text-muted-foreground">{step.detail}</p>
                {step.done && step.evidence ? (
                  <p className="text-xs text-emerald-600">{step.evidence}</p>
                ) : null}
              </div>
              <Button asChild variant={step.done ? "ghost" : "outline"} size="sm">
                <Link href={step.href}>
                  {step.done ? "Review" : step.action}
                  <ArrowRight className="h-3.5 w-3.5" />
                </Link>
              </Button>
            </CardContent>
          </Card>
        ))}
      </div>

      <p className="mt-4 flex items-start gap-2 text-xs text-muted-foreground">
        <Circle className="mt-0.5 h-3 w-3 shrink-0" />
        Nothing here is a one-time decision. Industry words, stages and fields can all be
        changed later without losing anything you have already recorded.
      </p>
    </div>
  );
}
