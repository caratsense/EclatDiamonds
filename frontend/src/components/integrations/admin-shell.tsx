"use client";

import Link from "next/link";
import { AlertTriangle, ArrowLeft, Lock, type LucideIcon } from "lucide-react";

import { Badge } from "@/components/ui/badge";
import { Card, CardContent } from "@/components/ui/card";
import { Skeleton } from "@/components/ui/skeleton";
import type { ConnectionState } from "@/lib/queries/meta-admin";
import { CONNECTION_STATE_LABEL } from "@/lib/queries/meta-admin";
import type { IntegrationRow } from "@/lib/queries/tenant-config";
import { useSession } from "@/store/use-session";

/**
 * The chrome the connection-administration screens share.
 *
 * These screens all answer the same question in different words — is this
 * connection actually working, and what is it doing? — so they share a header,
 * a state vocabulary and a set of honest empty states. Keeping that in one file
 * means "not set up" reads the same on every one of them, and a new state has
 * one place to be added rather than nine.
 */

export function AdminPageHeader({
  title,
  purpose,
  action,
}: {
  title: string;
  purpose: string;
  action?: React.ReactNode;
}) {
  return (
    <div className="mb-6 space-y-3">
      <Link
        href="/settings/integrations"
        className="inline-flex items-center gap-1.5 text-xs text-muted-foreground hover:text-foreground"
      >
        <ArrowLeft className="h-3.5 w-3.5" />
        Integrations
      </Link>
      <div className="flex flex-col gap-3 sm:flex-row sm:items-start sm:justify-between">
        <div className="space-y-1.5">
          <h1 className="font-display text-[26px] font-bold leading-tight tracking-tight text-foreground">
            {title}
          </h1>
          <p className="max-w-2xl text-sm leading-relaxed text-muted-foreground">{purpose}</p>
        </div>
        {action ? <div className="flex shrink-0 flex-wrap gap-2">{action}</div> : null}
      </div>
    </div>
  );
}

/**
 * Client-side role gate.
 *
 * Convenience, never enforcement: the API refuses the same calls for the same
 * roles, and hiding a screen is not a permission. This exists so a store manager
 * sees a sentence explaining who can do this instead of a wall of failed
 * requests.
 */
export function RequiresHeadOffice({ children }: { children: React.ReactNode }) {
  const role = useSession((s) => s.role);
  if (role === "head_office") return <>{children}</>;
  return (
    <Card>
      <CardContent className="flex flex-col items-center gap-3 py-14 text-center">
        <div className="flex h-11 w-11 items-center justify-center rounded-full bg-muted text-muted-foreground">
          <Lock className="h-5 w-5" />
        </div>
        <div className="space-y-1">
          <p className="text-sm font-medium">Head office only</p>
          <p className="mx-auto max-w-sm text-xs text-muted-foreground">
            Connecting an account, storing its credentials and changing what may be sent are
            organisation-level decisions. Ask a head-office user to make this change.
          </p>
        </div>
      </CardContent>
    </Card>
  );
}

const STATE_VARIANT: Record<ConnectionState, "success" | "warning" | "destructive" | "outline"> = {
  connected: "success",
  needs_attention: "warning",
  failed: "destructive",
  not_configured: "outline",
  disabled: "outline",
};

export function ConnectionStatePill({ state }: { state: ConnectionState }) {
  return <Badge variant={STATE_VARIANT[state]}>{CONNECTION_STATE_LABEL[state]}</Badge>;
}

/** A row that is loading. Kept identical everywhere so a refresh does not jump. */
export function LoadingBlock({ rows = 4 }: { rows?: number }) {
  return (
    <div className="space-y-3">
      <Skeleton className="h-9 w-56" />
      {Array.from({ length: rows }).map((_, i) => (
        <Skeleton key={i} className="h-14 w-full" />
      ))}
    </div>
  );
}

/**
 * The state that matters most on these screens: there is no connection to
 * administer yet. It says what to do rather than only what is missing.
 */
export function NotConnected({
  what,
  icon: Icon = AlertTriangle,
}: {
  what: string;
  icon?: LucideIcon;
}) {
  return (
    <Card>
      <CardContent className="flex flex-col items-center gap-3 py-14 text-center">
        <div className="flex h-11 w-11 items-center justify-center rounded-full bg-muted text-muted-foreground">
          <Icon className="h-5 w-5" />
        </div>
        <div className="space-y-1">
          <p className="text-sm font-medium">No {what} is connected</p>
          <p className="mx-auto max-w-sm text-xs text-muted-foreground">
            Add the connection first. Nothing on this screen can be true until one exists.
          </p>
        </div>
        <Link
          href="/settings/integrations"
          className="mt-1 text-xs font-medium text-gold-strong underline-offset-4 hover:underline"
        >
          Go to Integrations
        </Link>
      </CardContent>
    </Card>
  );
}

/** A failed request, stated plainly with whatever the API was willing to say. */
export function LoadFailed({ message }: { message: string }) {
  return (
    <Card className="border-destructive">
      <CardContent className="flex gap-3 pt-6">
        <AlertTriangle className="mt-0.5 h-4 w-4 shrink-0 text-destructive" />
        <div className="space-y-1">
          <p className="text-sm font-medium">This could not be loaded</p>
          <p className="text-xs text-muted-foreground">{message}</p>
        </div>
      </CardContent>
    </Card>
  );
}

/** Connections of one provider, for the picker every screen starts with. */
export function connectionsFor(
  integrations: IntegrationRow[] | undefined,
  providerCode: string,
): IntegrationRow[] {
  return (integrations ?? []).filter((row) => row.providerCode === providerCode);
}

export function ConnectionPicker({
  connections,
  value,
  onChange,
}: {
  connections: IntegrationRow[];
  value: string | null;
  onChange: (id: string) => void;
}) {
  if (connections.length <= 1) return null;
  return (
    <label className="flex items-center gap-2 text-xs text-muted-foreground">
      Connection
      <select
        className="h-8 rounded-md border border-input bg-background px-2 text-xs text-foreground"
        value={value ?? ""}
        onChange={(e) => onChange(e.target.value)}
      >
        {connections.map((c) => (
          <option key={c.id} value={c.id}>
            {c.name}
          </option>
        ))}
      </select>
    </label>
  );
}

/** A timestamp, or an explicit "never" — never a blank cell. */
export function when(value: string | null | undefined): string {
  if (!value) return "Never";
  const date = new Date(value);
  return Number.isNaN(date.valueOf()) ? "Never" : date.toLocaleString();
}
