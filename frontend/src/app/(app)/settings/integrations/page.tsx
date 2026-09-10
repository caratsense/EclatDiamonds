"use client";

import { useState } from "react";
import { AlertTriangle, Ban, KeyRound, MessageCircle, Plug, ShieldCheck } from "lucide-react";
import Link from "next/link";
import { toast } from "sonner";

import { SectionHeader } from "@/components/section/section-header";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Skeleton } from "@/components/ui/skeleton";
import {
  useCreateIntegration,
  useIntegrations,
  useJobSummary,
  useProviderCatalogue,
  useRemoveIntegration,
  useSetCredential,
  useSetIntegrationAsset,
  type ProviderRow,
} from "@/lib/queries/tenant-config";
import { useWhatsAppSender } from "@/lib/queries/crm-ai";
import { apiErrorMessage } from "@/lib/utils";

/**
 * Integrations (CaratOS Phase A5/A11).
 *
 * Three things this screen refuses to fake, because each one would cost a real
 * business real money:
 *
 *   1. A provider with no working adapter is shown as unavailable WITH THE
 *      REASON, not as a greyed-out "coming soon" the buyer reads as a promise.
 *   2. When credentials are still deployment-wide rather than per-organisation,
 *      it says so at the top of the page. That is the difference between one
 *      customer and two safely sharing an installation.
 *   3. If credential encryption is not configured, saving a secret is refused —
 *      the API will not store one unencrypted, and the UI explains why.
 */
export default function IntegrationsSettingsPage() {
  const { data: catalogue, isLoading } = useProviderCatalogue();
  const { data: integrations } = useIntegrations();
  const { data: jobs } = useJobSummary();
  const create = useCreateIntegration();
  const remove = useRemoveIntegration();

  if (isLoading) {
    return (
      <div className="space-y-4">
        <Skeleton className="h-9 w-64" />
        <Skeleton className="h-64 w-full" />
      </div>
    );
  }

  const available = catalogue?.providers.filter((p) => p.available) ?? [];
  const blocked = catalogue?.providers.filter((p) => !p.available) ?? [];

  return (
    <div className="space-y-6">
      <SectionHeader
        title="Integrations"
        purpose="Connect the systems and channels your business already uses."
      />

      {catalogue?.encryption.configured === false && (
        <Card className="border-destructive">
          <CardContent className="flex gap-3 pt-6">
            <AlertTriangle className="h-5 w-5 shrink-0 text-destructive" />
            <div>
              <p className="font-medium">Credential storage is not configured</p>
              <p className="text-sm text-muted-foreground">{catalogue.encryption.note}</p>
            </div>
          </CardContent>
        </Card>
      )}

      {catalogue?.platformScopedWarning && (
        <Card className="border-amber-500">
          <CardContent className="flex gap-3 pt-6">
            <AlertTriangle className="h-5 w-5 shrink-0 text-amber-600" />
            <div>
              <p className="font-medium">Some credentials are shared across this installation</p>
              <p className="text-sm text-muted-foreground">
                {catalogue.platformScopedWarning.message}
              </p>
            </div>
          </CardContent>
        </Card>
      )}

      <WhatsAppSenderCard />

      <AdministrationLinks />

      {jobs && jobs.needsAttention > 0 && (
        <Card className="border-amber-500">
          <CardContent className="flex gap-3 pt-6">
            <AlertTriangle className="h-5 w-5 shrink-0 text-amber-600" />
            <div>
              <p className="font-medium">
                {jobs.needsAttention} background job{jobs.needsAttention === 1 ? "" : "s"} stopped
                after repeated failures
              </p>
              <p className="text-sm text-muted-foreground">
                These will not retry on their own. Check the job list before assuming an import or
                sync completed.
              </p>
            </div>
          </CardContent>
        </Card>
      )}

      <Card>
        <CardHeader>
          <CardTitle className="text-base">Your connections</CardTitle>
        </CardHeader>
        <CardContent className="space-y-3">
          {!integrations?.length ? (
            <p className="text-sm text-muted-foreground">
              Nothing connected yet. Add one from the list below.
            </p>
          ) : (
            integrations.map((i) => (
              <IntegrationCard
                key={i.id}
                integration={i}
                provider={catalogue?.providers.find((p) => p.code === i.providerCode)}
                onRemove={() =>
                  remove.mutate(i.id, {
                    onSuccess: () => toast.success(`Disconnected ${i.name}`),
                    onError: (e) => toast.error(apiErrorMessage(e, "Could not save that change.")),
                  })
                }
              />
            ))
          )}
        </CardContent>
      </Card>

      <Card>
        <CardHeader>
          <CardTitle className="text-base">Available to connect</CardTitle>
        </CardHeader>
        <CardContent className="grid gap-3 sm:grid-cols-2">
          {available.map((p) => (
            <div key={p.code} className="rounded-lg border p-3">
              <div className="flex items-start justify-between gap-2">
                <div>
                  <p className="font-medium">{p.name}</p>
                  <p className="text-xs text-muted-foreground">{p.description}</p>
                </div>
                <Badge variant="secondary">{p.category}</Badge>
              </div>
              <div className="mt-2 flex flex-wrap gap-1">
                <ScopeBadge scope={p.credentialScope} />
                {p.webhooks && <Badge variant="outline">webhooks</Badge>}
              </div>
              {p.credentialScope === "on_premise" || p.category === "file" ? (
                <Button asChild size="sm" className="mt-3 w-full">
                  <Link href="/data">
                    {p.category === "file" ? "Upload data" : "Set up Connect agent"}
                  </Link>
                </Button>
              ) : p.credentialScope === "platform_env" ? (
                <Button size="sm" className="mt-3 w-full" disabled>
                  Platform setup required
                </Button>
              ) : (
                <Button
                  size="sm"
                  className="mt-3 w-full"
                  disabled={create.isPending}
                  onClick={() =>
                    create.mutate(
                      { providerCode: p.code, name: p.name },
                      {
                        onSuccess: () => toast.success(`Added ${p.name}`),
                        onError: (e) =>
                          toast.error(apiErrorMessage(e, "Could not save that change.")),
                      },
                    )
                  }
                >
                  Connect
                </Button>
              )}
            </div>
          ))}
        </CardContent>
      </Card>

      {blocked.length > 0 && (
        <Card>
          <CardHeader>
            <CardTitle className="text-base">Not available yet</CardTitle>
          </CardHeader>
          <CardContent className="space-y-3">
            {/* The reason is shown in full. "Coming soon" with no detail is what
                lets a customer plan around something that does not exist. */}
            {blocked.map((p) => (
              <div key={p.code} className="rounded-lg border border-dashed p-3">
                <div className="flex items-center gap-2">
                  <Ban className="h-4 w-4 text-muted-foreground" />
                  <p className="font-medium">{p.name}</p>
                </div>
                <p className="mt-1 text-sm text-muted-foreground">{p.blockedReason}</p>
              </div>
            ))}
          </CardContent>
        </Card>
      )}
    </div>
  );
}

function ScopeBadge({ scope }: { scope: ProviderRow["credentialScope"] }) {
  if (scope === "tenant") {
    return (
      <Badge variant="outline" className="gap-1 border-emerald-500 text-emerald-600">
        <ShieldCheck className="h-3 w-3" />
        your own credentials
      </Badge>
    );
  }
  if (scope === "platform_env") {
    return (
      <Badge variant="outline" className="gap-1 border-amber-500 text-amber-600">
        <AlertTriangle className="h-3 w-3" />
        shared installation account
      </Badge>
    );
  }
  if (scope === "on_premise") {
    return <Badge variant="outline">runs on your server</Badge>;
  }
  return <Badge variant="outline">no credentials needed</Badge>;
}

function IntegrationCard({
  integration,
  provider,
  onRemove,
}: {
  integration: ReturnType<typeof useIntegrations>["data"] extends (infer T)[] | undefined
    ? T
    : never;
  provider?: ProviderRow;
  onRemove: () => void;
}) {
  const setCredential = useSetCredential(integration.id);
  const setAsset = useSetIntegrationAsset(integration.id);
  const [kind, setKind] = useState(provider?.credentialKinds?.[0] ?? "api_key");
  const [secret, setSecret] = useState("");
  const currentPhoneNumberId = integration.assets.find(
    (asset) => asset.kind === "phone_number",
  )?.externalId;
  const [phoneNumberId, setPhoneNumberId] = useState(currentPhoneNumberId ?? "");

  const save = async () => {
    if (!secret.trim()) return;
    try {
      await setCredential.mutateAsync({ kind, secret });
      // Cleared immediately — the value is never echoed back and should not sit
      // in a form field either.
      setSecret("");
      toast.success("Saved and encrypted");
    } catch (e) {
      toast.error(apiErrorMessage(e, "Could not save that change."));
    }
  };

  const savePhoneNumber = async () => {
    if (!/^[1-9]\d{5,31}$/.test(phoneNumberId)) return;
    try {
      await setAsset.mutateAsync({
        kind: "phone_number",
        externalId: phoneNumberId,
        name: "WhatsApp sender",
      });
      toast.success("WhatsApp phone number ID saved");
    } catch (e) {
      toast.error(apiErrorMessage(e, "Could not save the WhatsApp phone number ID."));
    }
  };

  return (
    <div className="rounded-lg border p-3">
      <div className="flex flex-wrap items-center justify-between gap-2">
        <div className="flex items-center gap-2">
          <Plug className="h-4 w-4 text-muted-foreground" />
          <span className="font-medium">{integration.name}</span>
          <Badge variant={integration.state === "connected" ? "default" : "outline"}>
            {integration.state.replace(/_/g, " ")}
          </Badge>
        </div>
        <Button size="sm" variant="ghost" onClick={onRemove}>
          Disconnect
        </Button>
      </div>

      {integration.lastError && (
        <p className="mt-2 text-sm text-destructive">{integration.lastError}</p>
      )}
      <p className="mt-2 text-xs text-muted-foreground">{integration.stateReason}</p>

      {integration.credentials.length > 0 && (
        <div className="mt-2 flex flex-wrap gap-2">
          {integration.credentials.map((c) => (
            <Badge key={c.kind} variant="secondary" className="gap-1">
              <KeyRound className="h-3 w-3" />
              {c.kind} stored
            </Badge>
          ))}
        </div>
      )}

      {provider?.credentialScope === "platform_env" ? (
        <p className="mt-3 rounded-md border border-amber-500/50 bg-amber-500/5 p-2 text-xs text-muted-foreground">
          This connection is configured by the platform operator. Tenant credentials cannot be
          entered or stored here.
        </p>
      ) : null}

      {provider?.credentialScope === "tenant" && provider.credentialKinds?.length ? (
        <div className="mt-3 flex flex-wrap items-end gap-2">
          <div className="space-y-1">
            <Label className="text-xs">Type</Label>
            <select
              className="h-9 rounded-md border bg-background px-3 text-sm"
              value={kind}
              onChange={(e) => setKind(e.target.value)}
            >
              {provider.credentialKinds.map((k) => (
                <option key={k} value={k}>
                  {k}
                </option>
              ))}
            </select>
          </div>
          <div className="min-w-48 flex-1 space-y-1">
            <Label className="text-xs">Secret</Label>
            <Input
              type="password"
              value={secret}
              onChange={(e) => setSecret(e.target.value)}
              placeholder="Paste the value"
              autoComplete="off"
            />
          </div>
          <Button size="sm" onClick={save} disabled={setCredential.isPending || !secret.trim()}>
            Save
          </Button>
          <p className="w-full text-xs text-muted-foreground">
            Encrypted before it is stored. It is never shown again, here or anywhere else.
          </p>
        </div>
      ) : null}

      {integration.providerCode === "whatsapp_cloud" ? (
        <div className="mt-3 flex flex-wrap items-end gap-2 border-t pt-3">
          <div className="min-w-56 flex-1 space-y-1">
            <Label className="text-xs">WhatsApp phone number ID</Label>
            <Input
              inputMode="numeric"
              value={phoneNumberId}
              onChange={(event) => setPhoneNumberId(event.target.value.replace(/\D/g, ""))}
              placeholder="Meta phone number ID"
              maxLength={32}
            />
          </div>
          <Button
            size="sm"
            onClick={savePhoneNumber}
            disabled={setAsset.isPending || !/^[1-9]\d{5,31}$/.test(phoneNumberId)}
          >
            Save sender ID
          </Button>
          <p className="w-full text-xs text-muted-foreground">
            This is the numeric Phone Number ID from WhatsApp Manager, not the visible phone number.
          </p>
        </div>
      ) : null}
    </div>
  );
}


/**
 * Whose WhatsApp number does this organisation send from?
 *
 * A dedicated card because the answer is no longer "the deployment's" — it is a
 * per-tenant fact with three genuinely different states, and the one that most
 * needs saying out loud is the middle one: sending works, but the number belongs
 * to the platform rather than to this business. Reporting that as a plain
 * "connected" tick is what makes a second tenant unsafe to onboard.
 */
function WhatsAppSenderCard() {
  const { data, isLoading } = useWhatsAppSender();
  if (isLoading || !data) return null;

  const tone = !data.usable
    ? "border-muted"
    : data.shared
      ? "border-amber-500"
      : "border-emerald-500/60";

  return (
    <Card className={tone}>
      <CardContent className="flex gap-3 pt-6">
        <MessageCircle className="h-5 w-5 shrink-0 text-muted-foreground" />
        <div className="min-w-0 space-y-1">
          <p className="flex flex-wrap items-center gap-2 font-medium">
            WhatsApp sender
            <Badge variant={data.usable ? "secondary" : "outline"}>
              {data.usable ? (data.shared ? "Shared number" : "Your number") : "Not connected"}
            </Badge>
            {data.phoneNumberIdSuffix ? (
              <span className="text-xs text-muted-foreground">{data.phoneNumberIdSuffix}</span>
            ) : null}
          </p>
          <p className="text-sm text-muted-foreground">
            {data.reason ??
              (data.shared
                ? "Messages go out on a number owned by the platform, not by your business. Connect your own WhatsApp Business number to send as yourself."
                : "Messages go out on your own connected WhatsApp Business number.")}
          </p>
          {/* Stated rather than implied: nothing here claims a Meta connection
              flow exists when it has not been verified against the provider. */}
          <p className="text-xs text-muted-foreground">{data.oauth.note}</p>
        </div>
      </CardContent>
    </Card>
  );
}

/**
 * The screens that answer "is this connection actually doing anything?".
 *
 * Grouped here rather than added to the sidebar: they only make sense once a
 * connection exists, and a nav entry for something a tenant has not connected
 * is an invitation to a dead end.
 */
function AdministrationLinks() {
  const areas = [
    {
      href: "/settings/integrations/meta",
      title: "Meta connection",
      blurb: "Connect your own Meta app and store its access token, encrypted.",
    },
    {
      href: "/settings/integrations/meta/assets",
      title: "Registered assets",
      blurb: "The Pages, lead forms and ad accounts this organisation claims.",
    },
    {
      href: "/settings/integrations/meta/health",
      title: "Connection health",
      blurb: "What the provider said last time we asked, and when.",
    },
    {
      href: "/settings/integrations/templates",
      title: "Message templates",
      blurb: "Which templates the provider has approved, and how fresh that answer is.",
    },
    {
      href: "/crm/consent",
      title: "Messaging consent",
      blurb: "Who has agreed to be contacted, on which channel, and when.",
    },
    {
      href: "/crm/qr",
      title: "Lead QR codes",
      blurb: "Print a code for a counter so a walk-in becomes a lead.",
    },
    {
      href: "/settings/integrations/outbox",
      title: "Outbound messages",
      blurb: "What has left the building, what is waiting, and what failed.",
    },
    {
      href: "/settings/integrations/retries",
      title: "Waiting for a person",
      blurb: "Messages that will not move on their own.",
    },
    {
      href: "/settings/integrations/lead-ads",
      title: "Lead capture failures",
      blurb: "Lead form submissions that never became a customer record.",
    },
    {
      href: "/settings/integrations/ad-performance",
      title: "Spend and return",
      blurb: "Measured spend, how much of the period we have, and what came back.",
    },
  ];

  return (
    <Card>
      <CardHeader>
        <CardTitle className="text-base">Administration</CardTitle>
      </CardHeader>
      <CardContent className="grid gap-3 sm:grid-cols-2 lg:grid-cols-3">
        {areas.map((area) => (
          <Link
            key={area.href}
            href={area.href}
            className="rounded-lg border p-3 transition-colors hover:bg-accent"
          >
            <p className="text-sm font-medium">{area.title}</p>
            <p className="mt-1 text-xs text-muted-foreground">{area.blurb}</p>
          </Link>
        ))}
      </CardContent>
    </Card>
  );
}
