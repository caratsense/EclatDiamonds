"use client";

import { useMemo, useState } from "react";
import { CheckCircle2, ShieldCheck, ShieldOff, Users } from "lucide-react";
import { toast } from "sonner";

import { LoadFailed, LoadingBlock, when } from "@/components/integrations/admin-shell";
import { SectionHeader } from "@/components/section/section-header";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { EmptyState } from "@/components/ui/empty-state";
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
import { api } from "@/lib/api";
import { useConsent, useRecordConsent } from "@/lib/queries/meta-admin";
import { useParties } from "@/lib/queries/parties";
import { apiErrorMessage } from "@/lib/utils";
import { useQuery } from "@tanstack/react-query";

const CONSENT_TYPES = "consent.granted,consent.revoked";

interface ActivityRow {
  id: string;
  type: string;
  summary: string;
  channel: string | null;
  occurredAt: string;
  partyId: string | null;
  metadata: Record<string, unknown> | null;
  actorUser?: { id: string; name: string } | null;
  store?: { id: string; name: string } | null;
}

/**
 * Screen 5 — who has agreed to be contacted, and when they said so.
 *
 * Consent is an event, not a checkbox: the record is what someone did and when,
 * and the current answer is whichever event is newest. That is why this screen
 * shows a history rather than a toggle — a customer who opted out, then opted
 * back in at the counter, has two facts and only one of them is current.
 *
 * Revocation always wins over a grant of the same age, and an unrecorded state
 * reads as "not recorded" rather than as permission.
 */
export default function ConsentPage() {
  const [search, setSearch] = useState("");
  const [partyId, setPartyId] = useState<string | null>(null);
  const [channel, setChannel] = useState("whatsapp");

  const parties = useParties({ page: 1, pageSize: 8, q: search.trim() || undefined, type: "customer" });
  const marketing = useConsent(partyId, channel, "marketing");
  const service = useConsent(partyId, channel, "service");
  const record = useRecordConsent();

  const history = useQuery({
    queryKey: ["crm", "activity", "consent", partyId],
    queryFn: async () =>
      partyId
        ? (
            await api.get<{ events: ActivityRow[] }>(`/crm/customers/${partyId}/timeline`, {
              params: { types: CONSENT_TYPES, limit: 50 },
            })
          ).data.events
        : (await api.get<ActivityRow[]>("/crm/activity", { params: { types: CONSENT_TYPES, limit: 50 } }))
            .data,
  });

  const selected = useMemo(
    () => parties.data?.items.find((p) => p.id === partyId) ?? null,
    [parties.data, partyId],
  );

  return (
    <>
      <SectionHeader
        title="Messaging consent"
        purpose="Who has agreed to be contacted, on which channel, and when they said so."
      />

      <div className="grid gap-6 lg:grid-cols-[320px_1fr]">
        <Card>
          <CardHeader>
            <CardTitle className="text-base">Find a customer</CardTitle>
          </CardHeader>
          <CardContent className="space-y-3">
            <Input
              placeholder="Name, phone or email"
              value={search}
              onChange={(e) => setSearch(e.target.value)}
            />
            {parties.isLoading ? (
              <LoadingBlock rows={3} />
            ) : (parties.data?.items ?? []).length === 0 ? (
              <p className="py-6 text-center text-xs text-muted-foreground">
                No customer matches that.
              </p>
            ) : (
              <ul className="space-y-1">
                {parties.data!.items.map((p) => (
                  <li key={p.id}>
                    <button
                      type="button"
                      onClick={() => setPartyId(p.id)}
                      className={`w-full rounded-md px-3 py-2 text-left text-sm transition-colors hover:bg-accent ${
                        partyId === p.id ? "bg-accent" : ""
                      }`}
                    >
                      <span className="block font-medium">{p.name}</span>
                      <span className="block text-xs text-muted-foreground">
                        {p.phone ?? p.email ?? "No contact recorded"}
                      </span>
                    </button>
                  </li>
                ))}
              </ul>
            )}
          </CardContent>
        </Card>

        <div className="space-y-6">
          {!partyId ? (
            <EmptyState
              icon={Users}
              title="Choose a customer"
              description="Consent is recorded per customer and per channel. Pick someone to see what they have agreed to."
            />
          ) : (
            <Card>
              <CardHeader className="flex flex-row items-start justify-between gap-3">
                <div className="space-y-1">
                  <CardTitle className="text-base">{selected?.name ?? "Customer"}</CardTitle>
                  <p className="text-xs text-muted-foreground">
                    A grant covers only the purpose it was given for. Marketing needs an explicit
                    one; a reply to an enquiry does not.
                  </p>
                </div>
                <select
                  className="h-8 rounded-md border border-input bg-background px-2 text-xs"
                  value={channel}
                  onChange={(e) => setChannel(e.target.value)}
                >
                  {["whatsapp", "sms", "email"].map((c) => (
                    <option key={c} value={c}>
                      {c}
                    </option>
                  ))}
                </select>
              </CardHeader>
              <CardContent className="space-y-4">
                <div className="grid gap-3 sm:grid-cols-2">
                  <ConsentCard
                    title="Marketing"
                    state={marketing.data?.state}
                    occurredAt={marketing.data?.occurredAt}
                    source={marketing.data?.source}
                  />
                  <ConsentCard
                    title="Service replies"
                    state={service.data?.state}
                    occurredAt={service.data?.occurredAt}
                    source={service.data?.source}
                  />
                </div>

                <div className="space-y-2 rounded-lg border p-4">
                  <Label>Record what the customer told you</Label>
                  <div className="flex flex-wrap gap-2">
                    {(["marketing", "service", "all"] as const).map((purpose) => (
                      <div key={purpose} className="flex gap-2">
                        <Button
                          size="sm"
                          variant="outline"
                          disabled={record.isPending}
                          onClick={() =>
                            record.mutate(
                              { partyId, channel, purpose, status: "granted", source: "staff" },
                              {
                                onSuccess: () => toast.success(`Recorded: ${purpose} agreed.`),
                                onError: (e) => toast.error(apiErrorMessage(e, "That did not work. Nothing was changed.")),
                              },
                            )
                          }
                        >
                          <ShieldCheck className="h-3.5 w-3.5" />
                          {purpose} agreed
                        </Button>
                        <Button
                          size="sm"
                          variant="outline"
                          disabled={record.isPending}
                          onClick={() =>
                            record.mutate(
                              { partyId, channel, purpose, status: "revoked", source: "staff" },
                              {
                                onSuccess: () => toast.success(`Recorded: ${purpose} withdrawn.`),
                                onError: (e) => toast.error(apiErrorMessage(e, "That did not work. Nothing was changed.")),
                              },
                            )
                          }
                        >
                          <ShieldOff className="h-3.5 w-3.5" />
                          {purpose} withdrawn
                        </Button>
                      </div>
                    ))}
                  </div>
                  <p className="text-xs text-muted-foreground">
                    Each of these writes a dated event. Nothing is overwritten, so a customer who
                    changes their mind twice leaves both facts behind.
                  </p>
                </div>
              </CardContent>
            </Card>
          )}

          <Card>
            <CardHeader>
              <CardTitle className="text-base">
                {partyId ? "This customer's consent history" : "Recent consent activity"}
              </CardTitle>
            </CardHeader>
            <CardContent className="px-0 sm:px-6">
              {history.isLoading ? (
                <div className="px-6 sm:px-0">
                  <LoadingBlock rows={3} />
                </div>
              ) : history.isError ? (
                <div className="px-6 sm:px-0">
                  <LoadFailed message={apiErrorMessage(history.error, "The consent history could not be read.")} />
                </div>
              ) : (history.data ?? []).length === 0 ? (
                <p className="px-6 pb-6 text-sm text-muted-foreground sm:px-0">
                  Nothing recorded yet. Until a customer tells you, their answer is unknown — which
                  is not the same as yes.
                </p>
              ) : (
                <Table>
                  <TableHeader>
                    <TableRow>
                      <TableHead>What happened</TableHead>
                      <TableHead>Channel</TableHead>
                      <TableHead>Recorded by</TableHead>
                      <TableHead>When</TableHead>
                    </TableRow>
                  </TableHeader>
                  <TableBody>
                    {history.data!.map((event) => (
                      <TableRow key={event.id}>
                        <TableCell>
                          <div className="flex items-center gap-2">
                            {event.type === "consent.granted" ? (
                              <Badge variant="success">Agreed</Badge>
                            ) : (
                              <Badge variant="destructive">Withdrawn</Badge>
                            )}
                            <span className="text-xs text-muted-foreground">{event.summary}</span>
                          </div>
                        </TableCell>
                        <TableCell className="whitespace-nowrap text-xs">
                          {event.channel ?? "—"}
                        </TableCell>
                        <TableCell className="whitespace-nowrap text-xs text-muted-foreground">
                          {event.actorUser?.name ?? "Automatic"}
                        </TableCell>
                        <TableCell className="whitespace-nowrap text-xs text-muted-foreground">
                          {when(event.occurredAt)}
                        </TableCell>
                      </TableRow>
                    ))}
                  </TableBody>
                </Table>
              )}
            </CardContent>
          </Card>
        </div>
      </div>
    </>
  );
}

function ConsentCard({
  title,
  state,
  occurredAt,
  source,
}: {
  title: string;
  state?: "granted" | "revoked" | "unknown";
  occurredAt?: string;
  source?: string;
}) {
  return (
    <div className="rounded-lg border p-4">
      <p className="text-xs text-muted-foreground">{title}</p>
      <div className="mt-1 flex items-center gap-2">
        {state === "granted" ? (
          <Badge variant="success">
            <CheckCircle2 className="mr-1 h-3 w-3" />
            Agreed
          </Badge>
        ) : state === "revoked" ? (
          <Badge variant="destructive">Withdrawn</Badge>
        ) : (
          <Badge variant="outline">Not recorded</Badge>
        )}
      </div>
      <p className="mt-2 text-xs text-muted-foreground">
        {state === "unknown" || !state
          ? "Nobody has recorded an answer. That is not permission."
          : `${when(occurredAt)}${source ? ` · via ${source}` : ""}`}
      </p>
    </div>
  );
}
