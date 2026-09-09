"use client";

import { useMemo, useState } from "react";
import { Activity, BadgeCheck, KeyRound, RefreshCw, XCircle } from "lucide-react";
import { toast } from "sonner";

import {
  AdminPageHeader,
  ConnectionPicker,
  ConnectionStatePill,
  LoadFailed,
  LoadingBlock,
  NotConnected,
  RequiresHeadOffice,
  connectionsFor,
  when,
} from "@/components/integrations/admin-shell";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import {
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
} from "@/components/ui/table";
import { META_ASSET_LABEL, useCheckMetaHealth, useMetaHealth } from "@/lib/queries/meta-admin";
import type { MetaAssetKind } from "@/lib/queries/meta-admin";
import { useIntegrations } from "@/lib/queries/tenant-config";
import { apiErrorMessage } from "@/lib/utils";

/**
 * Screen 3 — is this connection actually working?
 *
 * Every word on this screen is backed by evidence or absent. "Connected" appears
 * only after a live call to the provider read back every registered asset by id;
 * an asset shows as confirmed only if the provider answered for that exact id.
 * A screen that inferred "connected" from a stored token would tell an operator
 * to sit and wait for leads that are never coming.
 */
export default function MetaHealthPage() {
  return (
    <>
      <AdminPageHeader
        title="Connection health"
        purpose="What the provider said the last time we asked. Not what was typed into a form."
      />
      <RequiresHeadOffice>
        <MetaHealth />
      </RequiresHeadOffice>
    </>
  );
}

function MetaHealth() {
  const { data: integrations, isLoading } = useIntegrations();
  const connections = useMemo(() => connectionsFor(integrations, "meta_ads"), [integrations]);
  // Derived, not stored-and-synced: the first connection is the default until
  // somebody picks another. An effect that assigned it would re-render for no
  // reason and fight the list arriving.
  const [chosen, setChosen] = useState<string | null>(null);
  const integrationId = chosen ?? connections[0]?.id ?? null;
  const setIntegrationId = setChosen;

  const health = useMetaHealth(integrationId);
  const check = useCheckMetaHealth(integrationId);

  if (isLoading) return <LoadingBlock />;
  if (!connections.length) return <NotConnected what="Meta Ads account" icon={Activity} />;
  if (health.isLoading) return <LoadingBlock />;
  if (health.isError) return <LoadFailed message={apiErrorMessage(health.error, "The connection state could not be read.")} />;
  if (!health.data) return <LoadingBlock />;

  const state = health.data;
  const verified = state.assets.filter((a) => a.verified).length;

  return (
    <div className="space-y-6">
      <div className="flex flex-wrap items-center justify-end gap-3">
        <ConnectionPicker
          connections={connections}
          value={integrationId}
          onChange={setIntegrationId}
        />
        <Button
          size="sm"
          disabled={check.isPending || state.state === "disabled"}
          onClick={() =>
            check.mutate(undefined, {
              onSuccess: (result) =>
                toast.success(
                  result.state === "connected"
                    ? "The provider answered for every registered asset."
                    : (result.error ?? "Check complete."),
                ),
              onError: (e) => toast.error(apiErrorMessage(e, "That did not work. Nothing was changed.")),
            })
          }
        >
          <RefreshCw className={`h-4 w-4 ${check.isPending ? "animate-spin" : ""}`} />
          Check now
        </Button>
      </div>

      <Card>
        <CardHeader className="flex flex-row items-start justify-between gap-3">
          <div className="space-y-1">
            <CardTitle className="text-base">{state.name}</CardTitle>
            <p className="text-xs text-muted-foreground">
              {state.error ?? "The last check found nothing wrong."}
            </p>
          </div>
          <ConnectionStatePill state={state.state} />
        </CardHeader>
        <CardContent className="grid gap-4 sm:grid-cols-3">
          <Fact
            label="Access token"
            value={state.credentialPresent ? "Stored, encrypted" : "Not stored"}
            good={state.credentialPresent}
            icon={KeyRound}
          />
          <Fact
            label="Assets confirmed"
            value={`${verified} of ${state.assets.length}`}
            good={state.assets.length > 0 && verified === state.assets.length}
            icon={BadgeCheck}
          />
          <Fact label="Last checked" value={when(state.lastHealthAt)} icon={Activity} />
        </CardContent>
      </Card>

      {state.state === "disabled" ? (
        <Card>
          <CardContent className="py-8 text-center text-sm text-muted-foreground">
            This connection is switched off. Health checks are skipped so a background sweep cannot
            quietly turn it back on.
          </CardContent>
        </Card>
      ) : null}

      <Card>
        <CardHeader>
          <CardTitle className="text-base">Assets</CardTitle>
          <p className="text-xs text-muted-foreground">
            Confirmed means the provider returned this exact id when asked with your stored token. A
            different id coming back is treated as unconfirmed, because a redirect is not ownership.
          </p>
        </CardHeader>
        <CardContent className="px-0 sm:px-6">
          {state.assets.length === 0 ? (
            <p className="px-6 pb-6 text-sm text-muted-foreground sm:px-0">
              Nothing is registered yet, so there is nothing to check. A stored token with nothing to
              read does nothing.
            </p>
          ) : (
            <Table>
              <TableHeader>
                <TableRow>
                  <TableHead>Type</TableHead>
                  <TableHead>Meta id</TableHead>
                  <TableHead>Result</TableHead>
                  <TableHead>Last checked</TableHead>
                </TableRow>
              </TableHeader>
              <TableBody>
                {state.assets.map((asset) => (
                  <TableRow key={asset.id}>
                    <TableCell className="whitespace-nowrap">
                      {META_ASSET_LABEL[asset.kind as MetaAssetKind] ?? asset.kind}
                    </TableCell>
                    <TableCell className="font-mono text-xs">{asset.externalId}</TableCell>
                    <TableCell>
                      {asset.verified ? (
                        <Badge variant="success">
                          <BadgeCheck className="mr-1 h-3 w-3" />
                          Confirmed
                        </Badge>
                      ) : (
                        <div className="space-y-1">
                          <Badge variant="warning">
                            <XCircle className="mr-1 h-3 w-3" />
                            Not confirmed
                          </Badge>
                          <p className="max-w-md text-xs text-muted-foreground">
                            {asset.error ?? "This asset has not been checked yet."}
                          </p>
                        </div>
                      )}
                    </TableCell>
                    <TableCell className="whitespace-nowrap text-xs text-muted-foreground">
                      {when(asset.lastVerifiedAt)}
                    </TableCell>
                  </TableRow>
                ))}
              </TableBody>
            </Table>
          )}
        </CardContent>
      </Card>
    </div>
  );
}

function Fact({
  label,
  value,
  good,
  icon: Icon,
}: {
  label: string;
  value: string;
  good?: boolean;
  icon: React.ComponentType<{ className?: string }>;
}) {
  return (
    <div className="rounded-lg border p-3">
      <div className="flex items-center gap-1.5 text-xs text-muted-foreground">
        <Icon className="h-3.5 w-3.5" />
        {label}
      </div>
      <p
        className={`mt-1 text-sm font-medium ${
          good === false ? "text-muted-foreground" : "text-foreground"
        }`}
      >
        {value}
      </p>
    </div>
  );
}
