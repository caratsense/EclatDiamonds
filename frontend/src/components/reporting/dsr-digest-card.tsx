"use client";

import { useState } from "react";
import { Loader2, Plus, Send, Trash2 } from "lucide-react";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { toast } from "sonner";

import { Button } from "@/components/ui/button";
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Skeleton } from "@/components/ui/skeleton";
import { api } from "@/lib/api";
import { apiErrorMessage } from "@/lib/utils";

/**
 * The evening digest: the DSR's new direction.
 *
 * Staff file the day's figures on the dashboard; at the hour set here, head
 * office receives ONE WhatsApp message carrying every store's figures. This
 * card is the whole configuration: who receives it, and when.
 */
interface DigestRecipient {
  name: string;
  phoneE164: string;
}
interface DigestConfig {
  enabled: boolean;
  hourLocal: number;
  recipients: DigestRecipient[];
}

export function DsrDigestCard() {
  const qc = useQueryClient();
  const config = useQuery({
    queryKey: ["reporting", "dsr-digest"],
    queryFn: async () => (await api.get<DigestConfig>("/reporting/dsr-digest")).data,
  });
  const save = useMutation({
    mutationFn: async (input: DigestConfig) =>
      (await api.put<DigestConfig>("/reporting/dsr-digest", input)).data,
    onSuccess: () => void qc.invalidateQueries({ queryKey: ["reporting", "dsr-digest"] }),
  });
  const sendNow = useMutation({
    mutationFn: async () =>
      (
        await api.post<{
          preview: string;
          recipients: { name: string; delivered: boolean; dryRun: boolean }[];
        }>("/reporting/dsr-digest/send-now")
      ).data,
  });

  const [draft, setDraft] = useState<DigestConfig | null>(null);
  const [newName, setNewName] = useState("");
  const [newPhone, setNewPhone] = useState("");

  if (config.isLoading || !config.data) {
    return (
      <Card>
        <CardHeader>
          <CardTitle className="text-base">Evening digest to head office</CardTitle>
        </CardHeader>
        <CardContent>
          <Skeleton className="h-24 w-full" />
        </CardContent>
      </Card>
    );
  }

  const value = draft ?? config.data;
  const edit = (next: Partial<DigestConfig>) => setDraft({ ...value, ...next });

  const persist = (next: DigestConfig, done: string) =>
    save.mutate(next, {
      onSuccess: () => {
        setDraft(null);
        toast.success(done);
      },
      onError: (e) => toast.error(apiErrorMessage(e, "Could not save the digest settings.")),
    });

  const addRecipient = () => {
    const digits = newPhone.replace(/\D/g, "");
    if (digits.length < 10) {
      toast.error("Enter a 10-digit mobile number.");
      return;
    }
    edit({
      recipients: [...value.recipients, { name: newName.trim() || digits, phoneE164: digits }],
    });
    setNewName("");
    setNewPhone("");
  };

  return (
    <Card>
      <CardHeader className="flex flex-row flex-wrap items-start justify-between gap-3 space-y-0">
        <div className="space-y-1">
          <CardTitle className="text-base">Evening digest to head office</CardTitle>
          <CardDescription>
            Once a day, one WhatsApp message with every store&rsquo;s figures — sent to the
            people below, from the staff line. Stores that have not filed are named in it.
          </CardDescription>
        </div>
        <Button
          variant={value.enabled ? "default" : "outline"}
          size="sm"
          aria-pressed={value.enabled}
          onClick={() => edit({ enabled: !value.enabled })}
        >
          {value.enabled ? "On" : "Off"}
        </Button>
      </CardHeader>
      <CardContent className="space-y-4">
        <div className="flex flex-wrap items-end gap-3">
          <div className="space-y-1.5">
            <Label htmlFor="digest-hour">Send after (store-local hour)</Label>
            <Input
              id="digest-hour"
              type="number"
              min={0}
              max={23}
              className="w-24"
              value={value.hourLocal}
              onChange={(e) => edit({ hourLocal: Number(e.target.value) })}
            />
          </div>
          <p className="pb-2 text-xs text-muted-foreground">
            19 means it goes out within a quarter hour of 7&nbsp;PM at the stores.
          </p>
        </div>

        <div className="space-y-2">
          <Label>Recipients</Label>
          {value.recipients.length === 0 ? (
            <p className="text-sm text-muted-foreground">
              Nobody yet. Add the head-office people who should receive the evening summary.
            </p>
          ) : (
            <ul className="space-y-1">
              {value.recipients.map((r, i) => (
                <li
                  key={`${r.phoneE164}-${i}`}
                  className="flex items-center justify-between rounded-md border px-3 py-1.5 text-sm"
                >
                  <span>
                    {r.name} <span className="text-muted-foreground">· {r.phoneE164}</span>
                  </span>
                  <Button
                    variant="ghost"
                    size="sm"
                    aria-label={`Remove ${r.name}`}
                    onClick={() =>
                      edit({ recipients: value.recipients.filter((_, j) => j !== i) })
                    }
                  >
                    <Trash2 className="h-3.5 w-3.5" />
                  </Button>
                </li>
              ))}
            </ul>
          )}
          <div className="flex flex-wrap gap-2">
            <Input
              className="w-40"
              placeholder="Name"
              value={newName}
              onChange={(e) => setNewName(e.target.value)}
            />
            <Input
              className="w-44"
              placeholder="10-digit mobile"
              value={newPhone}
              onChange={(e) => setNewPhone(e.target.value)}
            />
            <Button variant="outline" size="sm" className="self-center" onClick={addRecipient}>
              <Plus className="h-3.5 w-3.5" /> Add
            </Button>
          </div>
        </div>

        <div className="flex flex-wrap items-center justify-between gap-2 border-t pt-3">
          <Button
            variant="outline"
            size="sm"
            disabled={sendNow.isPending || config.data.recipients.length === 0}
            title="Compose today's digest and send it to the saved recipients now"
            onClick={() =>
              sendNow.mutate(undefined, {
                onSuccess: (r) => {
                  const delivered = r.recipients.filter((x) => x.delivered).length;
                  const dry = r.recipients.some((x) => x.dryRun);
                  toast.success(
                    dry
                      ? "Composed — WhatsApp is not connected here, so nothing left the building."
                      : `Sent to ${delivered} of ${r.recipients.length} recipient(s).`,
                    { description: r.preview.split("\n").slice(0, 2).join(" · ") },
                  );
                },
                onError: (e) => toast.error(apiErrorMessage(e, "Could not send the digest.")),
              })
            }
          >
            {sendNow.isPending ? (
              <Loader2 className="h-3.5 w-3.5 animate-spin" />
            ) : (
              <Send className="h-3.5 w-3.5" />
            )}
            Send now
          </Button>
          <Button
            size="sm"
            disabled={!draft || save.isPending}
            onClick={() => persist(value, "Digest settings saved.")}
          >
            {save.isPending ? "Saving…" : "Save"}
          </Button>
        </div>
      </CardContent>
    </Card>
  );
}
