"use client";

import { useMemo, useState } from "react";
import Link from "next/link";
import { KeyRound, Link2, Plug, ShieldCheck } from "lucide-react";
import { toast } from "sonner";

import {
  AdminPageHeader,
  ConnectionStatePill,
  LoadingBlock,
  RequiresHeadOffice,
  connectionsFor,
  when,
} from "@/components/integrations/admin-shell";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { useUpdateIntegrationConfig } from "@/lib/queries/meta-admin";
import {
  useCreateIntegration,
  useIntegrations,
  useProviderCatalogue,
  useSetCredential,
} from "@/lib/queries/tenant-config";
import { apiErrorMessage } from "@/lib/utils";

const META_ADS = "meta_ads";
const WHATSAPP = "whatsapp_cloud";

/**
 * Screen 1 — connect a Meta account and store its token.
 *
 * The token is the only thing on this screen that leaves the browser, and it
 * goes one way. It is typed into a password field, posted once, encrypted
 * server-side, and afterwards the API reports nothing but that one exists. There
 * is no code path here that could render a stored token back, which is why the
 * field below never has a value: an input that could be pre-filled from the
 * server is an input that will be, eventually, by someone in a hurry.
 */
export default function MetaSetupPage() {
  return (
    <>
      <AdminPageHeader
        title="Meta connection"
        purpose="Connect your own Meta app so lead forms, message templates and ad spend belong to your account rather than ours."
        action={
          <>
            <Button variant="outline" size="sm" asChild>
              <Link href="/settings/integrations/meta/assets">Registered assets</Link>
            </Button>
            <Button variant="outline" size="sm" asChild>
              <Link href="/settings/integrations/meta/health">Connection health</Link>
            </Button>
          </>
        }
      />
      <RequiresHeadOffice>
        <MetaSetup />
      </RequiresHeadOffice>
    </>
  );
}

function MetaSetup() {
  const { data: catalogue, isLoading: catalogueLoading } = useProviderCatalogue();
  const { data: integrations, isLoading } = useIntegrations();
  const create = useCreateIntegration();

  const adsConnections = useMemo(() => connectionsFor(integrations, META_ADS), [integrations]);
  const whatsappConnections = useMemo(() => connectionsFor(integrations, WHATSAPP), [integrations]);
  const encryptionReady = catalogue?.encryption.configured !== false;

  if (isLoading || catalogueLoading) return <LoadingBlock />;

  return (
    <div className="space-y-6">
      {!encryptionReady && (
        <Card className="border-destructive">
          <CardContent className="flex gap-3 pt-6">
            <ShieldCheck className="mt-0.5 h-4 w-4 shrink-0 text-destructive" />
            <div className="space-y-1">
              <p className="text-sm font-medium">Credential encryption is not configured</p>
              <p className="text-xs text-muted-foreground">
                {catalogue?.encryption.note ??
                  "The server refuses to store a secret it cannot encrypt, so saving a token will fail until an operator sets the encryption key."}
              </p>
            </div>
          </CardContent>
        </Card>
      )}

      <ProviderSection
        title="Meta Ads and Lead Ads"
        providerCode={META_ADS}
        connections={adsConnections}
        encryptionReady={encryptionReady}
        onCreate={(name) =>
          create.mutate(
            { providerCode: META_ADS, name },
            {
              onSuccess: () => toast.success("Connection created. Store its access token next."),
              onError: (e) => toast.error(apiErrorMessage(e, "That did not work. Nothing was changed.")),
            },
          )
        }
        creating={create.isPending}
        blurb="Needs a long-lived access token from your own reviewed Meta app, with leads_retrieval and ads_read. Nothing is read until you register a Page, form or ad account."
      />

      <ProviderSection
        title="WhatsApp Business Cloud"
        providerCode={WHATSAPP}
        connections={whatsappConnections}
        encryptionReady={encryptionReady}
        onCreate={(name) =>
          create.mutate(
            { providerCode: WHATSAPP, name },
            {
              onSuccess: () => toast.success("Connection created. Store its access token next."),
              onError: (e) => toast.error(apiErrorMessage(e, "That did not work. Nothing was changed.")),
            },
          )
        }
        creating={create.isPending}
        blurb="Sends and receives messages, and reads which of your message templates the provider has approved."
        extra={(id) => <WhatsAppAccountField integrationId={id} />}
      />
    </div>
  );
}

function ProviderSection({
  title,
  providerCode,
  connections,
  encryptionReady,
  onCreate,
  creating,
  blurb,
  extra,
}: {
  title: string;
  providerCode: string;
  connections: ReturnType<typeof connectionsFor>;
  encryptionReady: boolean;
  onCreate: (name: string) => void;
  creating: boolean;
  blurb: string;
  extra?: (integrationId: string) => React.ReactNode;
}) {
  const [name, setName] = useState("");

  return (
    <Card>
      <CardHeader className="flex flex-row items-center justify-between gap-3">
        <div className="space-y-1">
          <CardTitle className="text-base">{title}</CardTitle>
          <p className="text-xs text-muted-foreground">{blurb}</p>
        </div>
        <Plug className="h-4 w-4 shrink-0 text-muted-foreground" />
      </CardHeader>
      <CardContent className="space-y-5">
        {connections.length === 0 ? (
          <div className="flex flex-col gap-2 rounded-lg border border-dashed p-4 sm:flex-row sm:items-end">
            <div className="flex-1 space-y-1.5">
              <Label htmlFor={`name-${providerCode}`}>Name this connection</Label>
              <Input
                id={`name-${providerCode}`}
                placeholder="Main account"
                value={name}
                onChange={(e) => setName(e.target.value)}
              />
            </div>
            <Button
              size="sm"
              disabled={!name.trim() || creating}
              onClick={() => onCreate(name.trim())}
            >
              Create connection
            </Button>
          </div>
        ) : (
          connections.map((connection) => (
            <div key={connection.id} className="space-y-4 rounded-lg border p-4">
              <div className="flex flex-wrap items-center justify-between gap-2">
                <div className="space-y-0.5">
                  <p className="text-sm font-medium">{connection.name}</p>
                  <p className="text-xs text-muted-foreground">{connection.stateReason}</p>
                </div>
                <ConnectionStatePill
                  state={
                    connection.state === "connected"
                      ? "connected"
                      : connection.state === "degraded"
                        ? "needs_attention"
                        : connection.state === "disconnected" || connection.state === "blocked"
                          ? "failed"
                          : "not_configured"
                  }
                />
              </div>
              <CredentialField
                integrationId={connection.id}
                present={connection.credentials.some((c) => c.kind === "access_token" && c.present)}
                lastUsedAt={
                  connection.credentials.find((c) => c.kind === "access_token")?.lastUsedAt ?? null
                }
                disabled={!encryptionReady}
              />
              {extra?.(connection.id)}
            </div>
          ))
        )}
      </CardContent>
    </Card>
  );
}

/**
 * Write-only credential input.
 *
 * `type="password"`, `autoComplete="off"`, and the value is cleared the moment
 * it is accepted. What the screen shows afterwards is a fact about existence and
 * last use — never the secret, and never a masked stand-in that could be mistaken
 * for one and copied.
 */
function CredentialField({
  integrationId,
  present,
  lastUsedAt,
  disabled,
}: {
  integrationId: string;
  present: boolean;
  lastUsedAt: string | null;
  disabled: boolean;
}) {
  const [secret, setSecret] = useState("");
  const save = useSetCredential(integrationId);

  return (
    <div className="space-y-2">
      <div className="flex flex-wrap items-center gap-2">
        <KeyRound className="h-3.5 w-3.5 text-muted-foreground" />
        <span className="text-xs font-medium">Access token</span>
        {present ? (
          <Badge variant="success">Stored, encrypted</Badge>
        ) : (
          <Badge variant="outline">Not stored</Badge>
        )}
        {present ? (
          <span className="text-xs text-muted-foreground">Last used {when(lastUsedAt)}</span>
        ) : null}
      </div>
      <div className="flex flex-col gap-2 sm:flex-row">
        <Input
          type="password"
          autoComplete="off"
          spellCheck={false}
          placeholder={present ? "Replace the stored token" : "Paste the token from your Meta app"}
          value={secret}
          onChange={(e) => setSecret(e.target.value)}
          disabled={disabled}
        />
        <Button
          size="sm"
          disabled={disabled || !secret.trim() || save.isPending}
          onClick={() =>
            save.mutate(
              { kind: "access_token", secret: secret.trim() },
              {
                onSuccess: () => {
                  setSecret("");
                  toast.success("Token stored. It is encrypted and never shown again.");
                },
                onError: (e) => toast.error(apiErrorMessage(e, "That did not work. Nothing was changed.")),
              },
            )
          }
        >
          {present ? "Replace" : "Store"}
        </Button>
      </div>
      <p className="text-xs text-muted-foreground">
        Stored encrypted and never returned by the API. To change it, paste a new one.
      </p>
    </div>
  );
}

/** The WhatsApp Business Account id — a non-secret setting, kept out of the token field. */
function WhatsAppAccountField({ integrationId }: { integrationId: string }) {
  const { data: integrations } = useIntegrations();
  const update = useUpdateIntegrationConfig();
  const current = integrations?.find((i) => i.id === integrationId);
  const stored = current?.config?.whatsappBusinessAccountId;
  const [value, setValue] = useState(stored == null ? "" : String(stored));

  return (
    <div className="space-y-2">
      <div className="flex items-center gap-2">
        <Link2 className="h-3.5 w-3.5 text-muted-foreground" />
        <span className="text-xs font-medium">WhatsApp Business Account ID</span>
      </div>
      <div className="flex flex-col gap-2 sm:flex-row">
        <Input
          inputMode="numeric"
          placeholder="e.g. 102938475610293"
          value={value}
          onChange={(e) => setValue(e.target.value.replace(/\D/g, ""))}
        />
        <Button
          size="sm"
          variant="outline"
          disabled={!/^\d{5,32}$/.test(value) || update.isPending}
          onClick={() =>
            update.mutate(
              { integrationId, config: { whatsappBusinessAccountId: value } },
              {
                onSuccess: () => toast.success("Saved. Templates can now be synchronised."),
                onError: (e) => toast.error(apiErrorMessage(e, "That did not work. Nothing was changed.")),
              },
            )
          }
        >
          Save
        </Button>
      </div>
      <p className="text-xs text-muted-foreground">
        Not a secret — this is the account whose approved templates are read. Template
        synchronisation cannot run without it.
      </p>
    </div>
  );
}
