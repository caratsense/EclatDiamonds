"use client";

import { useState } from "react";
import { CalendarHeart } from "lucide-react";
import { toast } from "sonner";

import { Button } from "@/components/ui/button";
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import {
  type AfterVisitPolicyInput,
  type AfterVisitStep,
  useFeedbackSettings,
  useUpdateFeedbackSettings,
} from "@/lib/queries/feedback";
import { apiErrorMessage, positiveNumberInput } from "@/lib/utils";
import {
  MAX_DELAY_HOURS,
  MIN_DELAY_HOURS,
  afterVisitSteps,
  secondRequestIsSendable,
  stepsAreOrdered,
  whenItGoesOut,
} from "@/components/feedback/after-visit-policy";

/**
 * The automatic "how was your visit?" after a walk-in that booked no follow-up.
 * Off by default. With a provider-approved WhatsApp template and a live sender it
 * goes out through the outbox; without either, the person who served the
 * customer gets a task to ask instead — it is never reported as sent.
 *
 * There are TWO of them, because one was not what the client meant: "there are
 * two templates that will go. One just after a day a customer visits ... and
 * second would go after 48 hours. And there should be an option to set up
 * second as well. Currently in the feedback request if you go, there is just an
 * option to add one." So each has its own template and its own delay, and the
 * screen says in words when each one leaves.
 */

/** Both steps as the screen edits them, with the policy's own switch. */
interface Draft {
  enabled: boolean;
  steps: [AfterVisitStep, AfterVisitStep];
}

export function AfterVisitCard() {
  const settings = useFeedbackSettings();
  const update = useUpdateFeedbackSettings();
  const [draft, setDraft] = useState<Draft | null>(null);

  const current = settings.data?.afterVisit;
  if (!current) return null;

  const v: Draft = draft ?? { enabled: current.enabled, steps: afterVisitSteps(current) };
  const setStep = (index: 0 | 1, patch: Partial<AfterVisitStep>) => {
    const steps: Draft["steps"] = [v.steps[0], v.steps[1]];
    steps[index] = { ...steps[index], ...patch };
    setDraft({ ...v, steps });
  };

  const ordered = stepsAreOrdered(v.steps);
  const sendable = secondRequestIsSendable(v.steps);

  return (
    <Card>
      <CardHeader>
        <CardTitle className="flex items-center gap-2 text-base">
          <CalendarHeart className="h-4 w-4" aria-hidden="true" />
          Ask after a visit
        </CardTitle>
        <CardDescription>
          When a walk-in ends without a follow-up booked, ask the customer how it went. Up to two
          requests go out, each with its own template and its own delay. This is a feedback request,
          not a sales follow-up. Customers who said STOP or were archived are never asked.
        </CardDescription>
      </CardHeader>
      <CardContent className="space-y-5">
        <label className="flex cursor-pointer items-center gap-2 text-sm font-medium">
          <input
            id="after-visit-enabled"
            type="checkbox"
            className="h-4 w-4 accent-[var(--primary)]"
            checked={v.enabled}
            onChange={(e) => setDraft({ ...v, enabled: e.target.checked })}
          />
          Ask automatically
        </label>

        <StepFields
          idPrefix="after-visit"
          title="First request"
          step={v.steps[0]}
          onChange={(patch) => setStep(0, patch)}
        />

        <div className="space-y-4 border-t border-border pt-4">
          <label className="flex cursor-pointer items-center gap-2 text-sm font-medium">
            <input
              id="after-visit-second-enabled"
              type="checkbox"
              className="h-4 w-4 accent-[var(--primary)]"
              checked={v.steps[1].enabled}
              onChange={(e) => setStep(1, { enabled: e.target.checked })}
            />
            Send a second request
          </label>
          <p className="text-xs text-muted-foreground">
            It goes out only if the customer has not answered and has not written back, and only if
            the first request actually reached them. Somebody who has already told us how it went is
            never asked twice.
          </p>
          {v.steps[1].enabled ? (
            <StepFields
              idPrefix="after-visit-second"
              title="Second request"
              step={v.steps[1]}
              onChange={(patch) => setStep(1, patch)}
            />
          ) : null}
        </div>

        {!ordered ? (
          <p className="text-xs text-destructive">
            The second request must go out after the first one. It is currently set to arrive first.
          </p>
        ) : null}
        {!sendable ? (
          <p className="text-xs text-destructive">
            The second request needs a WhatsApp template of its own. Without one it would send
            nothing at all.
          </p>
        ) : null}

        <p className="text-xs text-muted-foreground">
          Each template needs two variables: {"{{1}}"} the customer&apos;s first name and {"{{2}}"}{" "}
          the feedback link. Leave the first one blank to have staff ask in person or by phone — the
          second request is only ever sent on WhatsApp, so it needs a template of its own.
        </p>
        <Button
          size="sm"
          disabled={!draft || !ordered || !sendable || update.isPending}
          onClick={() => {
            const afterVisit: AfterVisitPolicyInput = { enabled: v.enabled, steps: v.steps };
            update.mutate(
              { afterVisit },
              {
                onSuccess: (s) => {
                  const [first, second] = afterVisitSteps(s.afterVisit);
                  toast.success(
                    !s.afterVisit.enabled
                      ? "Automatic visit feedback is off."
                      : second.enabled
                        ? `Customers will be asked ${first.delayHours} hours after a visit, and again after ${second.delayHours}.`
                        : `Customers will be asked ${first.delayHours} hours after a visit.`,
                  );
                  setDraft(null);
                },
                onError: (e) => toast.error(apiErrorMessage(e, "Could not save.")),
              },
            );
          }}
        >
          Save
        </Button>
      </CardContent>
    </Card>
  );
}

/** One step's four fields, and a line saying plainly when it leaves. */
function StepFields({
  idPrefix,
  title,
  step,
  onChange,
}: {
  idPrefix: string;
  title: string;
  step: AfterVisitStep;
  onChange: (patch: Partial<AfterVisitStep>) => void;
}) {
  return (
    <div className="space-y-2">
      <div className="text-sm font-medium">{title}</div>
      <div className="flex flex-wrap items-end gap-3">
        <div className="grid gap-1.5">
          <Label htmlFor={`${idPrefix}-hours`}>Hours after the visit</Label>
          <Input
            id={`${idPrefix}-hours`}
            type="number"
            min={MIN_DELAY_HOURS}
            max={MAX_DELAY_HOURS}
            step={24}
            value={step.delayHours}
            onChange={(e) => onChange({ delayHours: Number(positiveNumberInput(e.target.value)) })}
            className="h-9 w-[8rem]"
          />
        </div>
        <div className="grid gap-1.5">
          <Label htmlFor={`${idPrefix}-time`}>At (branch time)</Label>
          <Input
            id={`${idPrefix}-time`}
            type="time"
            value={step.sendTimeLocal}
            onChange={(e) => onChange({ sendTimeLocal: e.target.value })}
            className="h-9 w-[8rem]"
          />
        </div>
        <div className="grid gap-1.5">
          <Label htmlFor={`${idPrefix}-template`}>WhatsApp template</Label>
          <Input
            id={`${idPrefix}-template`}
            value={step.templateName ?? ""}
            onChange={(e) => onChange({ templateName: e.target.value })}
            placeholder={step.step === 1 ? "visit_feedback" : "visit_feedback_reminder"}
            className="h-9 w-[12rem]"
          />
        </div>
        <div className="grid gap-1.5">
          <Label htmlFor={`${idPrefix}-language`}>Language</Label>
          <Input
            id={`${idPrefix}-language`}
            value={step.templateLanguage ?? ""}
            onChange={(e) => onChange({ templateLanguage: e.target.value })}
            placeholder="en"
            className="h-9 w-[6rem]"
          />
        </div>
      </div>
      <p className="text-xs text-muted-foreground">{whenItGoesOut(step)}</p>
    </div>
  );
}
