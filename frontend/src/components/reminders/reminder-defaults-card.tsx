"use client";

import { useState } from "react";
import { BellRing } from "lucide-react";
import { toast } from "sonner";

import { Button } from "@/components/ui/button";
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import {
  describeDefaultReminder,
  useFollowUpReminderSettings,
  useSaveFollowUpReminderSettings,
} from "@/lib/queries/follow-up-reminders";
import { apiErrorMessage, positiveNumberInput } from "@/lib/utils";

/**
 * When somebody books a follow-up and does not pick a reminder time, this is
 * the time they are reminded — in their branch's own timezone. Managers only.
 */
export function ReminderDefaultsCard() {
  const settings = useFollowUpReminderSettings();
  const save = useSaveFollowUpReminderSettings();
  const [time, setTime] = useState<string | null>(null);
  const [days, setDays] = useState<string | null>(null);

  if (!settings.data) return null;
  const effectiveTime = time ?? settings.data.defaultTimeLocal;
  const effectiveDays = days ?? String(settings.data.defaultDaysBefore);
  const dirty = time !== null || days !== null;

  return (
    <Card className="mb-6">
      <CardHeader>
        <CardTitle className="flex items-center gap-2 text-base">
          <BellRing className="h-4 w-4" aria-hidden="true" />
          Default reminder
        </CardTitle>
        <CardDescription>
          A follow-up booked without a reminder time reminds its owner{" "}
          {describeDefaultReminder(settings.data)}, in the branch&apos;s own time.
        </CardDescription>
      </CardHeader>
      <CardContent className="flex flex-wrap items-end gap-3">
        <div className="grid gap-1.5">
          <Label htmlFor="reminder-default-time">Time</Label>
          <Input
            id="reminder-default-time"
            type="time"
            value={effectiveTime}
            onChange={(e) => setTime(e.target.value)}
            className="h-9 w-[8rem]"
          />
        </div>
        <div className="grid gap-1.5">
          <Label htmlFor="reminder-default-days">Days before</Label>
          <Input
            id="reminder-default-days"
            type="number"
            min={0}
            max={14}
            value={effectiveDays}
            onChange={(e) => setDays(positiveNumberInput(e.target.value))}
            className="h-9 w-[6rem]"
          />
        </div>
        <Button
          size="sm"
          className="h-9"
          disabled={!dirty || save.isPending}
          onClick={() =>
            save.mutate(
              { defaultTimeLocal: effectiveTime, defaultDaysBefore: Number(effectiveDays) },
              {
                onSuccess: (s) => {
                  toast.success(`Reminders now default ${describeDefaultReminder(s)}.`);
                  setTime(null);
                  setDays(null);
                },
                onError: (e) => toast.error(apiErrorMessage(e, "Could not save the default reminder.")),
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
