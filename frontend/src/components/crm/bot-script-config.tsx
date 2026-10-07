"use client";

import { useState } from "react";
import { Loader2, MessageSquareText, RotateCcw } from "lucide-react";
import { toast } from "sonner";

import { Button } from "@/components/ui/button";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Skeleton } from "@/components/ui/skeleton";
import {
  useBotScript,
  useSaveBotScript,
  type BotScriptInput,
  type BotScriptSetup,
} from "@/lib/queries/crm-ai";
import { apiErrorMessage } from "@/lib/utils";

/**
 * What the customer bot says.
 *
 * The questions used to live only in the backend, so rewording one was a code
 * change and a deploy. A jeweller should decide how their own shop greets
 * somebody.
 *
 * Only the WORDING is editable, and that is deliberate rather than unfinished.
 * Every answer carries a stored value the rest of the system reads back —
 * branching, the free-text parser, lead scoring, the customer record — so a
 * renamed label is harmless while a renamed value would break the flow and
 * orphan every answer already recorded against the old one. Hence: boxes for
 * the words, nothing for the plumbing.
 *
 * Every box is empty by default and shows the built-in wording as placeholder
 * text. Empty means "use the default", so clearing a box is how you undo —
 * and an untouched question keeps improving when the product's wording does.
 */
export function BotScriptConfig() {
  const { data, isLoading } = useBotScript();
  const save = useSaveBotScript();
  const [draft, setDraft] = useState<BotScriptInput>({});
  const [touched, setTouched] = useState(false);

  const greetingOn = draft.greeting ?? data?.greeting.enabled ?? true;

  if (isLoading || !data) {
    return (
      <Card>
        <CardHeader>
          <CardTitle>What the bot says</CardTitle>
        </CardHeader>
        <CardContent className="space-y-3">
          <Skeleton className="h-9 w-full" />
          <Skeleton className="h-9 w-full" />
          <Skeleton className="h-9 w-2/3" />
        </CardContent>
      </Card>
    );
  }

  /** The current value of a box: what is being edited, else what is stored. */
  const stepValue = (key: string, field: "prompt" | "hint") =>
    draft.steps?.[key]?.[field] ?? data.steps.find((s) => s.key === key)?.[field] ?? "";

  const optionValue = (key: string, value: string) =>
    draft.steps?.[key]?.options?.[value] ??
    data.steps.find((s) => s.key === key)?.options.find((o) => o.value === value)?.label ??
    "";

  const setStep = (key: string, field: "prompt" | "hint", value: string) => {
    setTouched(true);
    setDraft((d) => ({
      ...d,
      steps: { ...d.steps, [key]: { ...d.steps?.[key], [field]: value } },
    }));
  };

  const setOption = (key: string, value: string, label: string) => {
    setTouched(true);
    setDraft((d) => ({
      ...d,
      steps: {
        ...d.steps,
        [key]: {
          ...d.steps?.[key],
          options: { ...d.steps?.[key]?.options, [value]: label },
        },
      },
    }));
  };

  /**
   * Send the whole script, not a patch.
   *
   * A cleared box has to mean "go back to the default", and in a patch that is
   * indistinguishable from "leave this one alone". So the current state of
   * every box is sent and the server drops the blanks.
   */
  const build = (): BotScriptInput => {
    const steps: NonNullable<BotScriptInput["steps"]> = {};
    for (const step of data.steps) {
      const options: Record<string, string> = {};
      for (const option of step.options) options[option.value] = optionValue(step.key, option.value);
      steps[step.key] = {
        prompt: stepValue(step.key, "prompt"),
        hint: stepValue(step.key, "hint"),
        options,
      };
    }
    return {
      greeting: greetingOn,
      intro: draft.intro ?? data.intro.value ?? "",
      introHint: draft.introHint ?? data.introHint.value ?? "",
      steps,
    };
  };

  const onSave = async () => {
    try {
      await save.mutateAsync(build());
      setDraft({});
      setTouched(false);
      toast.success("Saved. New conversations will use this wording.");
    } catch (error) {
      toast.error(apiErrorMessage(error, "Could not save the bot's wording."));
    }
  };

  const onResetAll = async () => {
    try {
      await save.mutateAsync({});
      setDraft({});
      setTouched(false);
      toast.success("Back to the built-in wording.");
    } catch (error) {
      toast.error(apiErrorMessage(error, "Could not reset the bot's wording."));
    }
  };

  return (
    <div className="space-y-4">
      <Card>
        <CardHeader>
          <CardTitle className="flex items-center gap-2">
            <MessageSquareText className="h-4 w-4" /> What the bot says
          </CardTitle>
        </CardHeader>
        <CardContent className="space-y-5">
          <p className="text-sm text-muted-foreground">
            The questions a customer is asked after they tap an advert or message you.
            Leave a box empty to use the wording shown in grey. Changes apply to new
            conversations; one already part-way through keeps the questions it started with.
          </p>

          <div className="space-y-3 rounded-lg border p-3">
            <div className="flex items-center justify-between gap-3">
              <h3 className="text-sm font-semibold">The opening message</h3>
              {/* Off/On pills, the same control as People &amp; Access — a bot
                  that opens straight with question 1 is a wording decision,
                  and it lives beside the wording it replaces. */}
              <div role="radiogroup" aria-label="Opening greeting" className="flex rounded-md border p-0.5">
                {([
                  { on: false, label: "Off" },
                  { on: true, label: "On" },
                ] as const).map((o) => (
                  <button
                    key={o.label}
                    type="button"
                    role="radio"
                    aria-checked={greetingOn === o.on}
                    onClick={() => {
                      setTouched(true);
                      setDraft((d) => ({ ...d, greeting: o.on }));
                    }}
                    className={
                      greetingOn === o.on
                        ? o.on
                          ? "rounded bg-primary px-4 py-1 text-xs font-medium text-primary-foreground"
                          : "rounded bg-muted px-4 py-1 text-xs font-medium text-foreground"
                        : "rounded px-4 py-1 text-xs font-medium text-muted-foreground hover:bg-muted/60"
                    }
                  >
                    {o.label}
                  </button>
                ))}
              </div>
            </div>
            {!greetingOn ? (
              <p className="text-xs text-muted-foreground">
                The bot skips the greeting and opens with question 1 directly.
                The questions themselves are always asked.
              </p>
            ) : null}
            <div className="space-y-1.5">
              <Label htmlFor="bot-intro">First line</Label>
              <Input
                id="bot-intro"
                disabled={!greetingOn}
                value={draft.intro ?? data.intro.value ?? ""}
                placeholder={data.intro.default}
                maxLength={data.limits.prompt}
                onChange={(e) => {
                  setTouched(true);
                  setDraft((d) => ({ ...d, intro: e.target.value }));
                }}
              />
            </div>
            <div className="space-y-1.5">
              <Label htmlFor="bot-intro-hint">Line underneath</Label>
              <Input
                id="bot-intro-hint"
                disabled={!greetingOn}
                value={draft.introHint ?? data.introHint.value ?? ""}
                placeholder={data.introHint.default}
                maxLength={data.limits.hint}
                onChange={(e) => {
                  setTouched(true);
                  setDraft((d) => ({ ...d, introHint: e.target.value }));
                }}
              />
            </div>
            <p className="text-xs text-muted-foreground">
              A greeting with the customer&rsquo;s name is added above this automatically
              when the advert gave us one.
            </p>
          </div>

          {data.steps.map((step, index) => (
            <StepEditor
              key={step.key}
              index={index + 1}
              step={step}
              limits={data.limits}
              promptValue={stepValue(step.key, "prompt")}
              hintValue={stepValue(step.key, "hint")}
              optionValue={(value) => optionValue(step.key, value)}
              onPrompt={(v) => setStep(step.key, "prompt", v)}
              onHint={(v) => setStep(step.key, "hint", v)}
              onOption={(value, label) => setOption(step.key, value, label)}
            />
          ))}

          <div className="flex items-center justify-between gap-3 pt-1">
            <Button
              variant="ghost"
              size="sm"
              onClick={onResetAll}
              disabled={save.isPending}
              className="text-muted-foreground"
            >
              <RotateCcw className="mr-1.5 h-3.5 w-3.5" /> Reset everything to default
            </Button>
            <Button onClick={onSave} disabled={save.isPending || !touched}>
              {save.isPending && <Loader2 className="mr-2 h-4 w-4 animate-spin" />}
              Save wording
            </Button>
          </div>
        </CardContent>
      </Card>
    </div>
  );
}

function StepEditor({
  index,
  step,
  limits,
  promptValue,
  hintValue,
  optionValue,
  onPrompt,
  onHint,
  onOption,
}: {
  index: number;
  step: BotScriptSetup["steps"][number];
  limits: BotScriptSetup["limits"];
  promptValue: string;
  hintValue: string;
  optionValue: (value: string) => string;
  onPrompt: (value: string) => void;
  onHint: (value: string) => void;
  onOption: (value: string, label: string) => void;
}) {
  return (
    <div className="space-y-3 rounded-lg border p-3">
      <h3 className="text-sm font-semibold">Question {index}</h3>

      <div className="space-y-1.5">
        <Label htmlFor={`bot-${step.key}-prompt`}>What the bot asks</Label>
        <Input
          id={`bot-${step.key}-prompt`}
          value={promptValue}
          placeholder={step.defaultPrompt}
          maxLength={limits.prompt}
          onChange={(e) => onPrompt(e.target.value)}
        />
      </div>

      <div className="space-y-1.5">
        <Label htmlFor={`bot-${step.key}-hint`}>Smaller line underneath (optional)</Label>
        <Input
          id={`bot-${step.key}-hint`}
          value={hintValue}
          placeholder={step.defaultHint ?? "Nothing shown"}
          maxLength={limits.hint}
          onChange={(e) => onHint(e.target.value)}
        />
      </div>

      <div className="space-y-1.5">
        <Label>The answers they can tap</Label>
        <div className="grid gap-2 sm:grid-cols-2">
          {step.options.map((option) => (
            <Input
              key={option.value}
              aria-label={`Answer: ${option.defaultLabel}`}
              value={optionValue(option.value)}
              placeholder={option.defaultLabel}
              maxLength={limits.optionLabel}
              onChange={(e) => onOption(option.value, e.target.value)}
            />
          ))}
        </div>
        <p className="text-xs text-muted-foreground">
          Up to {limits.optionLabel} characters each &mdash; WhatsApp cuts a longer one off
          mid-word. You can reword an answer, but not add or remove one: the rest of the
          system records which answer was given, and an answer that stopped existing would
          orphan every lead that chose it.
        </p>
      </div>
    </div>
  );
}
