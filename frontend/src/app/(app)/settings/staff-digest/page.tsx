"use client";

import { useState } from "react";
import Link from "next/link";
import { ArrowLeft, BellRing, Clock, MessageSquareWarning } from "lucide-react";
import { toast } from "sonner";

import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card";
import { EmptyState } from "@/components/ui/empty-state";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Skeleton } from "@/components/ui/skeleton";
import { StatusPill } from "@/components/ui/status-pill";
import {
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
} from "@/components/ui/table";
import {
  useDigestPreview,
  useDigestSettings,
  useSaveDigestSettings,
} from "@/lib/queries/staff-digest";
import { apiErrorMessage, positiveNumberInput } from "@/lib/utils";
import { useSession } from "@/store/use-session";

/**
 * The morning message, and what it would say to me right now.
 *
 * The preview is the point of the screen. A digest nobody can see before it goes
 * out is a digest nobody trusts, and the first question anybody asks about an
 * automated message is "what exactly does it say?" — so the exact text is shown
 * verbatim, or the reason it would not be sent is, and never a cheerful summary
 * standing in for either.
 *
 * The preview is the signed-in person's OWN list. A manager looking at this sees
 * what they will receive, not their team's customers; the server enforces that,
 * and the screen says so rather than leaving it to be discovered.
 */
export default function StaffDigestPage() {
  const role = useSession((s) => s.role);
  const canManage = role === "store_manager" || role === "area_manager" || role === "head_office";

  const preview = useDigestPreview();
  const settings = useDigestSettings(canManage);
  const save = useSaveDigestSettings();

  const [form, setForm] = useState<Record<string, string>>({});
  const value = (name: string, fallback: unknown) =>
    form[name] ?? (fallback == null ? "" : String(fallback));

  const onSave = (patch: Record<string, unknown>) => {
    save.mutate(patch, {
      onSuccess: () => {
        setForm({});
        toast.success("Saved.");
      },
      onError: (e) => toast.error(apiErrorMessage(e, "Could not save that.")),
    });
  };

  const lines = [...(preview.data?.overdue ?? []), ...(preview.data?.due ?? [])];

  return (
    <div className="space-y-5">
      <div className="space-y-2">
        <Link
          href="/settings"
          className="inline-flex items-center gap-1 text-sm text-muted-foreground hover:text-foreground"
        >
          <ArrowLeft className="size-3.5" /> Settings
        </Link>
        <h1 className="flex items-center gap-2 text-2xl font-semibold tracking-tight">
          <BellRing className="size-5" /> Morning follow-up digest
        </h1>
        <p className="text-sm text-muted-foreground">
          One message each morning telling a salesperson what they owe a customer today.
        </p>
      </div>

      {/* ---------------------------------------------------------------- */}
      {canManage ? (
        settings.isLoading ? (
          <Skeleton className="h-48 w-full" />
        ) : (
          <Card>
            <CardHeader>
              <CardTitle className="flex items-center gap-2 text-base">
                <Clock className="size-4" /> When it goes out
              </CardTitle>
              <CardDescription>
                The hour is read in each branch&rsquo;s own timezone, so a nine o&rsquo;clock
                digest arrives at nine where the person actually is.
              </CardDescription>
            </CardHeader>
            <CardContent className="space-y-4">
              <div className="flex flex-wrap items-end gap-3">
                <label className="flex items-center gap-2 text-sm">
                  <input
                    type="checkbox"
                    checked={settings.data?.enabled ?? false}
                    onChange={(e) => onSave({ enabled: e.target.checked })}
                    disabled={save.isPending}
                  />
                  Send the digest
                </label>
                <div className="space-y-1">
                  <Label htmlFor="hour">Hour (0&ndash;23)</Label>
                  <Input
                    id="hour"
                    className="w-24"
                    inputMode="numeric"
                    value={value("sendHourLocal", settings.data?.sendHourLocal)}
                    onChange={(e) =>
                      setForm((f) => ({
                        ...f,
                        sendHourLocal: positiveNumberInput(e.target.value),
                      }))
                    }
                    onBlur={() => {
                      if (!("sendHourLocal" in form)) return;
                      const n = Number(form.sendHourLocal);
                      if (!Number.isInteger(n) || n < 0 || n > 23) {
                        toast.error("The hour must be a whole number from 0 to 23.");
                        return;
                      }
                      onSave({ sendHourLocal: n });
                    }}
                  />
                </div>
              </div>

              <div className="space-y-2 rounded-md border p-3">
                <label className="flex items-center gap-2 text-sm">
                  <input
                    type="checkbox"
                    checked={settings.data?.whatsappEnabled ?? false}
                    onChange={(e) => onSave({ whatsappEnabled: e.target.checked })}
                    disabled={save.isPending}
                  />
                  Also send it on WhatsApp
                </label>
                <p className="text-xs text-muted-foreground">
                  WhatsApp needs a template the provider has approved, because this goes out
                  long after the last time the person messaged us. Without one it is skipped
                  and the reason is shown below &mdash; it is not silently dropped.
                </p>
                <div className="grid gap-2 sm:grid-cols-2">
                  <div className="space-y-1">
                    <Label htmlFor="template">Template name</Label>
                    <Input
                      id="template"
                      value={value("templateName", settings.data?.templateName)}
                      onChange={(e) => setForm((f) => ({ ...f, templateName: e.target.value }))}
                      onBlur={() =>
                        "templateName" in form
                          ? onSave({ templateName: form.templateName.trim() || null })
                          : undefined
                      }
                    />
                  </div>
                  <div className="space-y-1">
                    <Label htmlFor="lang">Template language</Label>
                    <Input
                      id="lang"
                      placeholder="en"
                      value={value("templateLanguage", settings.data?.templateLanguage)}
                      onChange={(e) =>
                        setForm((f) => ({ ...f, templateLanguage: e.target.value }))
                      }
                      onBlur={() =>
                        "templateLanguage" in form
                          ? onSave({ templateLanguage: form.templateLanguage.trim() || null })
                          : undefined
                      }
                    />
                  </div>
                </div>
              </div>
            </CardContent>
          </Card>
        )
      ) : null}

      {/* ---------------------------------------------------------------- */}
      <Card>
        <CardHeader>
          <CardTitle className="text-base">What mine says right now</CardTitle>
          <CardDescription>
            Your own follow-ups, not your team&rsquo;s. Nothing is sent by opening this.
          </CardDescription>
        </CardHeader>
        <CardContent className="space-y-3">
          {preview.isLoading ? (
            <Skeleton className="h-32 w-full" />
          ) : (
            <>
              {preview.data?.whatsappSkipReason ? (
                <div className="flex items-start gap-2 rounded-md border border-amber-500/40 bg-amber-500/5 p-3">
                  <MessageSquareWarning className="mt-0.5 size-4 shrink-0" />
                  <div>
                    <div className="text-sm font-medium">WhatsApp would not send this</div>
                    <p className="text-xs text-muted-foreground">
                      {preview.data.whatsappSkipReason}
                    </p>
                  </div>
                </div>
              ) : preview.data?.whatsappBody ? (
                <div className="space-y-1 rounded-md border p-3">
                  <div className="text-xs font-medium text-muted-foreground">
                    Exactly what would be sent
                  </div>
                  <pre className="whitespace-pre-wrap break-words font-sans text-sm">
                    {preview.data.whatsappBody}
                  </pre>
                </div>
              ) : null}

              {lines.length === 0 ? (
                <EmptyState
                  icon={BellRing}
                  title="Nothing owed today"
                  description="No follow-up of yours is due or overdue, so there would be nothing to send."
                />
              ) : (
                <div className="overflow-x-auto">
                  <Table>
                    <TableHeader>
                      <TableRow>
                        <TableHead>Customer</TableHead>
                        <TableHead>Due</TableHead>
                        <TableHead>State</TableHead>
                      </TableRow>
                    </TableHeader>
                    <TableBody>
                      {lines.map((l) => (
                        <TableRow key={l.leadId}>
                          <TableCell className="font-medium">{l.customerName}</TableCell>
                          <TableCell className="num text-sm">{l.dueDate}</TableCell>
                          <TableCell>
                            <StatusPill tone={l.overdueDays > 1 ? "bad" : "wait"}>
                              {l.overdueDays > 1 ? `${l.overdueDays - 1} day(s) late` : "Today"}
                            </StatusPill>
                          </TableCell>
                        </TableRow>
                      ))}
                    </TableBody>
                  </Table>
                </div>
              )}
            </>
          )}
        </CardContent>
      </Card>
    </div>
  );
}
