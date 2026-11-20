"use client";

import { useState } from "react";
import { AlertCircle, CheckCircle2, Info, ShieldAlert, Sparkles, Wand2 } from "lucide-react";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";
import { Button } from "@/components/ui/button";
import { Label } from "@/components/ui/label";
import { Textarea } from "@/components/ui/textarea";

interface ConfigureAiModalProps {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  ruleName: string;
  matchValue: string;
  initialContext?: string | null;
  initialGuardrails?: string | null;
  onSave: (context: string, guardrails: string) => void;
}

/*
 * An EMPTY SCAFFOLD, not example content.
 *
 * This used to preload a paragraph of bridal-jewellery copy — certified
 * diamonds, 22kt hallmarking, wedding language. On a universal product that is
 * worse than an empty box: a clinic or a mill opening this modal would find
 * their AI agent pre-briefed to sell necklaces, and the likeliest outcome is
 * that somebody saves it unread and the assistant then says it to a customer.
 *
 * The headings stay, because they are what makes a blank field answerable. What
 * goes under them is the tenant's own business, in their own words.
 */
const CONTEXT_SCAFFOLD = `Key Messaging:
What we offer:
Campaign Goals:
Pricing Information:
Special Instructions:`;

const GUARDRAILS_SCAFFOLD = `1. Restricted Topics:
2. Policy Restrictions:
3. Approval Requirements:
4. Prohibited Actions:
5. Tone Restrictions:`;

export function ConfigureAiModal({
  open,
  onOpenChange,
  ruleName,
  matchValue,
  initialContext,
  initialGuardrails,
  onSave,
}: ConfigureAiModalProps) {
  const [step, setStep] = useState<1 | 2>(1);
  const [context, setContext] = useState(initialContext || "");
  const [guardrails, setGuardrails] = useState(initialGuardrails || "");

  const contextChars = context.length;
  const contextWords = context.trim() ? context.trim().split(/\s+/).length : 0;
  const isContextValid = contextChars >= 10 && contextChars <= 5000;

  const guardrailsChars = guardrails.length;
  const guardrailsWords = guardrails.trim() ? guardrails.trim().split(/\s+/).length : 0;
  const isGuardrailsValid = guardrailsChars <= 2000;

  const handleUseTemplate = () => {
    if (!context) setContext(CONTEXT_SCAFFOLD);
    if (!guardrails) setGuardrails(GUARDRAILS_SCAFFOLD);
  };

  const handleSave = () => {
    onSave(context.trim(), guardrails.trim());
    onOpenChange(false);
  };

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="max-w-2xl max-h-[90vh] overflow-y-auto">
        <DialogHeader>
          <div className="flex items-center gap-2">
            <Sparkles className="h-5 w-5 text-amber-500" />
            <DialogTitle>Configure AI Sales Agent for {ruleName}</DialogTitle>
          </div>
          <DialogDescription>
            Target Ad Identifier / Match: <span className="font-mono text-foreground font-semibold">{matchValue || "All Matching Traffic"}</span>
          </DialogDescription>
        </DialogHeader>

        {step === 1 ? (
          <div className="space-y-4 py-2 text-sm">
            <div className="rounded-lg border bg-muted/40 p-4 space-y-2">
              <div className="flex items-center gap-2 font-medium text-foreground">
                <Info className="h-4 w-4 text-primary" />
                What to Include in Context:
              </div>
              <ul className="list-disc list-inside space-y-1 text-muted-foreground text-xs pl-2">
                <li><strong>Target Audience:</strong> Who is this ad targeting, and where?</li>
                <li><strong>Key Messaging:</strong> The two or three things you want said every time.</li>
                <li><strong>Product/Service Details:</strong> What is being advertised, and the details customers ask about.</li>
                <li><strong>Campaign Goals:</strong> What should the customer do next — book, visit, call back?</li>
                <li><strong>Pricing Information:</strong> Price ranges, starting prices, making charges policies.</li>
              </ul>
              <div className="rounded-md bg-background/80 border border-primary/20 p-2.5 text-xs text-muted-foreground mt-2">
                <span className="font-medium text-foreground">Example: </span>
                &quot;This ad targets people responding to our seasonal offer. Mention the price range and that appointments are available this week. Encourage them to book a time.&quot;
              </div>
            </div>

            <div className="rounded-lg border border-amber-500/30 bg-amber-500/5 p-4 space-y-2">
              <div className="flex items-center gap-2 font-medium text-amber-700 dark:text-amber-400">
                <ShieldAlert className="h-4 w-4" />
                What to Include in Guardrails:
              </div>
              <p className="text-xs text-muted-foreground">
                Specify what the AI agent must NOT say or do, to protect your business:
              </p>
              <ul className="list-disc list-inside space-y-1 text-muted-foreground text-xs pl-2">
                <li><strong>Restricted Topics:</strong> Competitors, or any claim your team cannot stand behind.</li>
                <li><strong>Policy Restrictions:</strong> Dates, availability or outcomes nobody has confirmed.</li>
                <li><strong>Approval Requirements:</strong> Discounts, waivers or commitments that need a manager.</li>
                <li><strong>Tone Restrictions:</strong> How it should speak, and how it should not.</li>
              </ul>
              <div className="rounded-md bg-background/80 border border-amber-500/20 p-2.5 text-xs text-muted-foreground mt-2">
                <span className="font-medium text-foreground">Example: </span>
                &quot;Do not promise delivery or completion dates. Do not discuss competitor pricing. Do not offer discounts without manager sign-off.&quot;
              </div>
            </div>

            <div className="rounded-lg border bg-emerald-500/5 border-emerald-500/30 p-3 flex items-start gap-2.5 text-xs text-muted-foreground">
              <CheckCircle2 className="h-4 w-4 text-emerald-600 shrink-0 mt-0.5" />
              <div>
                <span className="font-medium text-foreground">Best Practices: </span>
                Keep instructions crisp and grounded in your inventory. Test responses using the simulator after saving.
              </div>
            </div>

            <DialogFooter className="gap-2 sm:justify-between pt-2">
              <Button type="button" variant="outline" onClick={() => onOpenChange(false)}>
                Cancel
              </Button>
              <Button type="button" onClick={() => setStep(2)}>
                I Understand — Continue
              </Button>
            </DialogFooter>
          </div>
        ) : (
          <div className="space-y-4 py-2">
            <div className="flex items-center justify-between">
              <span className="text-xs text-muted-foreground">Define custom prompts for this ad</span>
              <Button
                type="button"
                variant="ghost"
                size="sm"
                className="h-8 gap-1.5 text-xs text-primary"
                onClick={handleUseTemplate}
              >
                <Wand2 className="h-3.5 w-3.5" />
                Insert headings
              </Button>
            </div>

            <div className="space-y-1.5">
              <div className="flex items-center justify-between text-xs">
                <Label htmlFor="ai-context" className="font-medium">
                  Context <span className="text-destructive">*</span>
                </Label>
                <span className="text-muted-foreground">
                  {contextChars} / 5000 characters · {contextWords} / 1000 words
                </span>
              </div>
              <Textarea
                id="ai-context"
                rows={6}
                value={context}
                onChange={(e) => setContext(e.target.value)}
                placeholder="What this ad promises, who it is aimed at, what you want the customer to do next, and anything the agent must always mention."
                className="font-mono text-xs leading-relaxed"
              />
              <div className="flex items-center gap-1.5 text-xs">
                {isContextValid ? (
                  <span className="text-emerald-600 flex items-center gap-1">
                    <CheckCircle2 className="h-3.5 w-3.5" /> Context is valid (minimum 10 chars)
                  </span>
                ) : (
                  <span className="text-amber-600 flex items-center gap-1">
                    <AlertCircle className="h-3.5 w-3.5" /> Provide at least 10 characters of context for the AI agent
                  </span>
                )}
              </div>
            </div>

            <div className="space-y-1.5">
              <div className="flex items-center justify-between text-xs">
                <Label htmlFor="ai-guardrails" className="font-medium">
                  Guardrails (Optional)
                </Label>
                <span className="text-muted-foreground">
                  {guardrailsChars} / 2000 characters · {guardrailsWords} / 400 words
                </span>
              </div>
              <Textarea
                id="ai-guardrails"
                rows={4}
                value={guardrails}
                onChange={(e) => setGuardrails(e.target.value)}
                placeholder="State boundaries: no unapproved discounts, no competitor comparisons, polite escalation to floor manager..."
                className="font-mono text-xs leading-relaxed"
              />
              <div className="flex items-center gap-1.5 text-xs">
                {isGuardrailsValid ? (
                  <span className="text-emerald-600 flex items-center gap-1">
                    <CheckCircle2 className="h-3.5 w-3.5" /> Guardrails within limit
                  </span>
                ) : (
                  <span className="text-destructive flex items-center gap-1">
                    <AlertCircle className="h-3.5 w-3.5" /> Guardrails exceed 2000 characters
                  </span>
                )}
              </div>
            </div>

            <DialogFooter className="gap-2 sm:justify-between pt-2">
              <Button type="button" variant="outline" onClick={() => setStep(1)}>
                ← Back to Guide
              </Button>
              <div className="flex items-center gap-2">
                <Button type="button" variant="ghost" onClick={() => onOpenChange(false)}>
                  Cancel
                </Button>
                <Button
                  type="button"
                  disabled={!isContextValid || !isGuardrailsValid}
                  onClick={handleSave}
                >
                  Save Sales Agent Config
                </Button>
              </div>
            </DialogFooter>
          </div>
        )}
      </DialogContent>
    </Dialog>
  );
}
