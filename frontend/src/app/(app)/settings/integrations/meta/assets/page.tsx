"use client";

import { useMemo, useState } from "react";
import { BadgeCheck, CircleDashed, Layers } from "lucide-react";
import { toast } from "sonner";

import {
  AdminPageHeader,
  ConnectionPicker,
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
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import {
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
} from "@/components/ui/table";
import {
  META_ASSET_LABEL,
  useMetaHealth,
  useRegisterMetaAsset,
  type MetaAssetKind,
} from "@/lib/queries/meta-admin";
import { useIntegrations } from "@/lib/queries/tenant-config";
import { apiErrorMessage } from "@/lib/utils";

const KINDS: MetaAssetKind[] = ["page", "form", "ad_account"];

/**
 * Screen 2 — which Meta objects this tenant claims.
 *
 * Registering an id is a claim, not a proof, and this screen says so on every
 * row. A Page id typed into a form tells us where to file an inbound lead; it
 * does not tell us the stored token can read that Page. The "Verified" column is
 * the difference, and it stays empty until connection health has actually asked
 * the provider.
 */
export default function MetaAssetsPage() {
  return (
    <>
      <AdminPageHeader
        title="Registered Meta assets"
        purpose="The Pages, lead forms and ad accounts this organisation claims. Inbound leads are filed against these, so exactly one organisation may claim each one."
      />
      <RequiresHeadOffice>
        <MetaAssets />
      </RequiresHeadOffice>
    </>
  );
}

function MetaAssets() {
  const { data: integrations, isLoading } = useIntegrations();
  const connections = useMemo(() => connectionsFor(integrations, "meta_ads"), [integrations]);
  // Derived, not stored-and-synced: the first connection is the default until
  // somebody picks another. An effect that assigned it would re-render for no
  // reason and fight the list arriving.
  const [chosen, setChosen] = useState<string | null>(null);
  const integrationId = chosen ?? connections[0]?.id ?? null;
  const setIntegrationId = setChosen;

  const health = useMetaHealth(integrationId);
  const register = useRegisterMetaAsset();

  const [kind, setKind] = useState<MetaAssetKind>("page");
  const [externalId, setExternalId] = useState("");
  const [name, setName] = useState("");

  if (isLoading) return <LoadingBlock />;
  if (!connections.length) return <NotConnected what="Meta Ads account" icon={Layers} />;

  return (
    <div className="space-y-6">
      <div className="flex justify-end">
        <ConnectionPicker
          connections={connections}
          value={integrationId}
          onChange={setIntegrationId}
        />
      </div>

      <Card>
        <CardHeader>
          <CardTitle className="text-base">Register an asset</CardTitle>
          <p className="text-xs text-muted-foreground">
            Select the Page, form or ad account in Meta first, then paste its numeric id here. Ids
            are 3 to 64 digits. An id already claimed by another connection is refused.
          </p>
        </CardHeader>
        <CardContent>
          <div className="grid gap-3 sm:grid-cols-[160px_1fr_1fr_auto] sm:items-end">
            <div className="space-y-1.5">
              <Label htmlFor="asset-kind">Type</Label>
              <select
                id="asset-kind"
                className="h-10 w-full rounded-md border border-input bg-background px-3 text-sm"
                value={kind}
                onChange={(e) => setKind(e.target.value as MetaAssetKind)}
              >
                {KINDS.map((k) => (
                  <option key={k} value={k}>
                    {META_ASSET_LABEL[k]}
                  </option>
                ))}
              </select>
            </div>
            <div className="space-y-1.5">
              <Label htmlFor="asset-id">Meta id</Label>
              <Input
                id="asset-id"
                inputMode="numeric"
                placeholder="e.g. 102938475610293"
                value={externalId}
                onChange={(e) => setExternalId(e.target.value.replace(/\D/g, ""))}
              />
            </div>
            <div className="space-y-1.5">
              <Label htmlFor="asset-name">Label (optional)</Label>
              <Input
                id="asset-name"
                placeholder="What your team calls it"
                value={name}
                onChange={(e) => setName(e.target.value)}
              />
            </div>
            <Button
              disabled={!integrationId || !/^\d{3,64}$/.test(externalId) || register.isPending}
              onClick={() =>
                register.mutate(
                  {
                    integrationId: integrationId!,
                    kind,
                    externalId,
                    ...(name.trim() ? { name: name.trim() } : {}),
                  },
                  {
                    onSuccess: () => {
                      setExternalId("");
                      setName("");
                      toast.success("Registered. Run a health check to confirm the token can read it.");
                    },
                    onError: (e) => toast.error(apiErrorMessage(e, "That did not work. Nothing was changed.")),
                  },
                )
              }
            >
              Register
            </Button>
          </div>
        </CardContent>
      </Card>

      {health.isLoading ? (
        <LoadingBlock rows={2} />
      ) : health.isError ? (
        <LoadFailed message={apiErrorMessage(health.error, "The connection state could not be read.")} />
      ) : health.data && health.data.assets.length === 0 ? (
        <Card>
          <CardContent className="flex flex-col items-center gap-2 py-12 text-center">
            <CircleDashed className="h-5 w-5 text-muted-foreground" />
            <p className="text-sm font-medium">Nothing registered yet</p>
            <p className="max-w-sm text-xs text-muted-foreground">
              Until a Page is registered here, an inbound lead has no organisation to belong to and
              is refused rather than guessed at.
            </p>
          </CardContent>
        </Card>
      ) : (
        <Card>
          <CardHeader>
            <CardTitle className="text-base">Registered assets</CardTitle>
          </CardHeader>
          <CardContent className="px-0 sm:px-6">
            <Table>
              <TableHeader>
                <TableRow>
                  <TableHead>Type</TableHead>
                  <TableHead>Meta id</TableHead>
                  <TableHead>Label</TableHead>
                  <TableHead>Verified with provider</TableHead>
                  <TableHead>Last checked</TableHead>
                </TableRow>
              </TableHeader>
              <TableBody>
                {health.data?.assets.map((asset) => (
                  <TableRow key={asset.id}>
                    <TableCell className="whitespace-nowrap">
                      {META_ASSET_LABEL[asset.kind as MetaAssetKind] ?? asset.kind}
                    </TableCell>
                    <TableCell className="font-mono text-xs">{asset.externalId}</TableCell>
                    <TableCell className="text-muted-foreground">{asset.name ?? "—"}</TableCell>
                    <TableCell>
                      {asset.verified ? (
                        <Badge variant="success">
                          <BadgeCheck className="mr-1 h-3 w-3" />
                          Confirmed
                        </Badge>
                      ) : (
                        <div className="space-y-1">
                          <Badge variant="outline">Claimed only</Badge>
                          {asset.error ? (
                            <p className="max-w-xs text-xs text-muted-foreground">{asset.error}</p>
                          ) : null}
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
          </CardContent>
        </Card>
      )}
    </div>
  );
}
