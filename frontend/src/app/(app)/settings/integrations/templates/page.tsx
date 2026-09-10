"use client";

import { useMemo, useState } from "react";
import { MessageSquareText, RefreshCw, ShieldAlert } from "lucide-react";
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
import {
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
} from "@/components/ui/table";
import {
  useMessageTemplates,
  useQueueTemplateSync,
  useSyncTemplates,
  type MessageTemplateRow,
  type ProviderTemplateStatus,
} from "@/lib/queries/meta-admin";
import { useIntegrations } from "@/lib/queries/tenant-config";
import { apiErrorMessage } from "@/lib/utils";

/** Meta's own words, softened for a screen but never re-interpreted. */
const PROVIDER_LABEL: Record<ProviderTemplateStatus, string> = {
  APPROVED: "Approved",
  PENDING: "Under review",
  IN_APPEAL: "Under appeal",
  REJECTED: "Rejected",
  PAUSED: "Paused for quality",
  DISABLED: "Disabled",
  PENDING_DELETION: "Being deleted",
  DELETED: "Deleted",
  REMOVED: "No longer at the provider",
  UNKNOWN: "Never confirmed",
};

/** How long an approval may be relied on. Matches the server's own window. */
const MAX_AGE_MS = 24 * 60 * 60 * 1000;

/**
 * Screen 4 — templates, as the provider sees them.
 *
 * A message template is the thing that lets you write to a customer outside the
 * 24-hour reply window, so whether one is approved is a decision with real
 * consequences. It used to be a word somebody typed into a form here. Now it is
 * whatever the provider last said, and how long ago it said it — because Meta
 * pauses templates for quality without telling anyone, and a week-old approval
 * is a guess.
 */
export default function TemplatesPage() {
  return (
    <>
      <AdminPageHeader
        title="Message templates"
        purpose="Which of your templates the provider has approved, and when it last said so."
      />
      <RequiresHeadOffice>
        <Templates />
      </RequiresHeadOffice>
    </>
  );
}

function Templates() {
  const { data: integrations, isLoading } = useIntegrations();
  const connections = useMemo(() => connectionsFor(integrations, "whatsapp_cloud"), [integrations]);
  // Derived, not stored-and-synced: the first connection is the default until
  // somebody picks another. An effect that assigned it would re-render for no
  // reason and fight the list arriving.
  const [chosen, setChosen] = useState<string | null>(null);
  const integrationId = chosen ?? connections[0]?.id ?? null;
  const setIntegrationId = setChosen;

  const templates = useMessageTemplates(integrationId ?? undefined);
  const syncNow = useSyncTemplates();
  const queueSync = useQueueTemplateSync();

  const connection = connections.find((c) => c.id === integrationId);
  const accountConfigured = Boolean(connection?.config?.whatsappBusinessAccountId);

  if (isLoading) return <LoadingBlock />;
  if (!connections.length) return <NotConnected what="WhatsApp account" icon={MessageSquareText} />;

  const rows = templates.data ?? [];
  const sendable = rows.filter((r) => isSendable(r)).length;

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
          variant="outline"
          disabled={!integrationId || queueSync.isPending}
          onClick={() =>
            queueSync.mutate(integrationId!, {
              onSuccess: () => toast.success("Queued. It will run in the background."),
              onError: (e) => toast.error(apiErrorMessage(e, "That did not work. Nothing was changed.")),
            })
          }
        >
          Queue in background
        </Button>
        <Button
          size="sm"
          disabled={!integrationId || !accountConfigured || syncNow.isPending}
          onClick={() =>
            syncNow.mutate(integrationId!, {
              onSuccess: (r) =>
                toast.success(
                  `${r.providerTemplates} at the provider, ${r.approved} approved, ${r.removed} no longer there, ${r.discovered} newly found.`,
                ),
              onError: (e) => toast.error(apiErrorMessage(e, "That did not work. Nothing was changed.")),
            })
          }
        >
          <RefreshCw className={`h-4 w-4 ${syncNow.isPending ? "animate-spin" : ""}`} />
          Synchronise now
        </Button>
      </div>

      {!accountConfigured ? (
        <Card className="border-warning">
          <CardContent className="flex gap-3 pt-6">
            <ShieldAlert className="mt-0.5 h-4 w-4 shrink-0 text-warning" />
            <div className="space-y-1">
              <p className="text-sm font-medium">No WhatsApp Business Account recorded</p>
              <p className="text-xs text-muted-foreground">
                Synchronisation reads the template list from that account. Add its id on the Meta
                connection screen first — without it nothing here can be confirmed, and nothing may
                be sent outside a 24-hour reply window.
              </p>
            </div>
          </CardContent>
        </Card>
      ) : null}

      <Card>
        <CardHeader className="flex flex-row items-start justify-between gap-3">
          <div className="space-y-1">
            <CardTitle className="text-base">Templates</CardTitle>
            <p className="text-xs text-muted-foreground">
              {rows.length === 0
                ? "Nothing recorded yet."
                : `${sendable} of ${rows.length} can be sent right now.`}
            </p>
          </div>
        </CardHeader>
        <CardContent className="px-0 sm:px-6">
          {templates.isLoading ? (
            <div className="px-6 sm:px-0">
              <LoadingBlock rows={3} />
            </div>
          ) : templates.isError ? (
            <div className="px-6 sm:px-0">
              <LoadFailed message={apiErrorMessage(templates.error, "The template list could not be read.")} />
            </div>
          ) : rows.length === 0 ? (
            <p className="px-6 pb-6 text-sm text-muted-foreground sm:px-0">
              No templates yet. Synchronising will list whatever the provider already holds for this
              account, including ones nobody recorded here.
            </p>
          ) : (
            <Table>
              <TableHeader>
                <TableRow>
                  <TableHead>Template</TableHead>
                  <TableHead>Language</TableHead>
                  <TableHead>Provider says</TableHead>
                  <TableHead>Can be sent</TableHead>
                  <TableHead>Confirmed</TableHead>
                </TableRow>
              </TableHeader>
              <TableBody>
                {rows.map((row) => {
                  const ok = isSendable(row);
                  return (
                    <TableRow key={row.id}>
                      <TableCell>
                        <div className="space-y-0.5">
                          {/* The bare provider name. `externalId` is the local
                              composite identity (name:language) and would read
                              as a typo on screen. */}
                          <p className="font-mono text-xs">{row.name ?? row.externalId}</p>
                          <p className="text-xs text-muted-foreground">{row.metadata.category}</p>
                        </div>
                      </TableCell>
                      <TableCell className="whitespace-nowrap text-xs">
                        {row.metadata.languageCode}
                      </TableCell>
                      <TableCell>
                        <Badge
                          variant={
                            row.metadata.providerStatus === "APPROVED"
                              ? "success"
                              : row.metadata.providerStatus === "UNKNOWN"
                                ? "outline"
                                : "warning"
                          }
                        >
                          {PROVIDER_LABEL[row.metadata.providerStatus]}
                        </Badge>
                      </TableCell>
                      <TableCell>
                        {ok ? (
                          <Badge variant="success">Yes</Badge>
                        ) : (
                          <div className="space-y-1">
                            <Badge variant="outline">No</Badge>
                            <p className="max-w-xs text-xs text-muted-foreground">
                              {reasonNotSendable(row)}
                            </p>
                          </div>
                        )}
                      </TableCell>
                      <TableCell className="whitespace-nowrap text-xs text-muted-foreground">
                        {when(row.lastVerifiedAt)}
                      </TableCell>
                    </TableRow>
                  );
                })}
              </TableBody>
            </Table>
          )}
        </CardContent>
      </Card>
    </div>
  );
}

/** The same rule the server applies, so the screen and the send agree. */
function isSendable(row: MessageTemplateRow): boolean {
  if (!row.isActive) return false;
  if (!row.lastVerifiedAt) return false;
  if (row.metadata.providerStatus !== "APPROVED") return false;
  const age = Date.now() - new Date(row.lastVerifiedAt).getTime();
  return age >= 0 && age <= MAX_AGE_MS;
}

function reasonNotSendable(row: MessageTemplateRow): string {
  if (!row.isActive) return "Switched off for this connection.";
  if (!row.lastVerifiedAt) return "Never confirmed with the provider. Synchronise first.";
  if (row.metadata.providerStatus !== "APPROVED") {
    return row.lastError ?? `The provider reports it as ${PROVIDER_LABEL[row.metadata.providerStatus].toLowerCase()}.`;
  }
  return "The approval is more than a day old. Synchronise to confirm it still stands.";
}
