"use client";

import { useState } from "react";
import { CalendarHeart } from "lucide-react";
import { toast } from "sonner";

import { Button } from "@/components/ui/button";
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import {
  type AfterVisitPolicy,
  useFeedbackSettings,
  useUpdateFeedbackSettings,
} from "@/lib/queries/feedback";
import { apiErrorMessage, positiveNumberInput } from "@/lib/utils";

/**
 * The automatic "how was your visit?" after a walk-in that booked no follow-up.
 * Off by default. With a provider-approved WhatsApp template and a live sender it
 * goes out through the outbox; without either, the person who served the
 * customer gets a task to ask instead — it is never reported as sent.
 */
export function AfterVisitCard() {
  const settings = useFeedbackSettings();
  const update = useUpdateFeedbackSettings();
  const [draft, setDraft] = useState<Partial<AfterVisitPolicy> | null>(null);

  const current = settings.data?.afterVisit;
  if (!current) return null;
  const v = { ...current, ...(draft ?? {}) };
  const set = (patch: Partial<AfterVisitPolicy>) => setDraft({ ...(draft ?? {}), ...patch });

  return (
    <Card>
      <CardHeader>
        <CardTitle className="flex items-center gap-2 text-base">
          <CalendarHeart className="h-4 w-4" aria-hidden="true" />
          Ask after a visit
        </CardTitle>
        <CardDescription>
          When a walk-in ends without a follow-up booked, ask the customer how it went a few days
          later. This is a feedback request, not a sales follow-up. Customers who said STOP or were
          archived are never asked.
        </CardDescription>
      </CardHeader>
      <CardContent className="space-y-4">
        <label className="flex cursor-pointer items-center gap-2 text-sm font-medium">
          <input
            id="after-visit-enabled"
            type="checkbox"
            className="h-4 w-4 accent-[var(--primary)]"
            checked={v.enabled}
            onChange={(e) => set({ enabled: e.target.checked })}
          />
          Ask automatically
        </label>
        <div className="flex flex-wrap items-end gap-3">
          <div className="grid gap-1.5">
            <Label htmlFor="after-visit-days">Days after the visit</Label>
            <Input
              id="after-visit-days"
              type="number"
              min={1}
              max={60}
              value={v.delayDays}
              onChange={(e) =>
                set({ delayDays: Number(positiveNumberInput(e.target.value)) })
              }
              className="h-9 w-[7rem]"
            />
          </div>
          <div className="grid gap-1.5">
            <Label htmlFor="after-visit-time">At (branch time)</Label>
            <Input
              id="after-visit-time"
              type="time"
              value={v.sendTimeLocal}
              onChange={(e) => set({ sendTimeLocal: e.target.value })}
              className="h-9 w-[8rem]"
            />
          </div>
          <div className="grid gap-1.5">
            <Label htmlFor="after-visit-template">WhatsApp template</Label>
            <Input
              id="after-visit-template"
              value={v.templateName ?? ""}
              onChange={(e) => set({ templateName: e.target.value })}
              placeholder="visit_feedback"
              className="h-9 w-[12rem]"
            />
          </div>
          <div className="grid gap-1.5">
            <Label htmlFor="after-visit-language">Language</Label>
            <Input
              id="after-visit-language"
              value={v.templateLanguage ?? ""}
              onChange={(e) => set({ templateLanguage: e.target.value })}
              placeholder="en"
              className="h-9 w-[6rem]"
            />
          </div>
        </div>
        <p className="text-xs text-muted-foreground">
          The template needs two variables: {"{{1}}"} the customer&apos;s first name and {"{{2}}"} the
          feedback link. Leave it blank to have staff ask in person or by phone.
        </p>
        <Button
          size="sm"
          disabled={!draft || update.isPending}
          onClick={() =>
            update.mutate(
              { afterVisit: draft ?? {} },
              {
                onSuccess: (s) => {
                  toast.success(
                    s.afterVisit.enabled
                      ? `Customers will be asked ${s.afterVisit.delayDays} day(s) after a visit.`
                      : "Automatic visit feedback is off.",
                  );
                  setDraft(null);
                },
                onError: (e) => toast.error(apiErrorMessage(e, "Could not save.")),
              },
            )
          }
        >
          Save
        </Button>
      </CardContent>
    </Card>
  );
}
