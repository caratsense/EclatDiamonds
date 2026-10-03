"use client";

import { useMemo } from "react";
import Link from "next/link";
import { AlertCircle, Check, MessageSquareText } from "lucide-react";

import { Badge } from "@/components/ui/badge";
import { Label } from "@/components/ui/label";
import { Skeleton } from "@/components/ui/skeleton";
import { useMessageTemplates, isTemplateSendable } from "@/lib/queries/meta-admin";
import { cn } from "@/lib/utils";

/**
 * Which approved template this campaign sends.
 *
 * ## What this replaces, and why it was dangerous
 *
 * Three free-text boxes: template name, language, and a textarea headed "What
 * it looks like (optional)" into which somebody pasted the wording by hand.
 *
 * Each of those is a way to send the wrong thing to several thousand people.
 * A typo in the name failed at the provider, after approval, with the campaign
 * already scheduled. A language nobody checked meant an English template
 * standing in for a Hindi one. And the pasted preview is the worst of the
 * three: it is what the APPROVER reads, it is typed by a human, and nothing
 * ever compared it to the template Meta actually approved. Sign-off on wording
 * that was never verified is not sign-off.
 *
 * So the list here is the templates Meta has approved, read from the provider,
 * and the preview is the stored wording rather than anybody's recollection of
 * it. Picking one fills the name and language together, because they are one
 * fact — `order_update` is approved in en_US and hi_IN independently.
 *
 * ## Only sendable templates are offered
 *
 * `isTemplateSendable` is the server's own rule, shared rather than copied: a
 * template is offered only while an APPROVED verdict read within 24 hours says
 * so. The server refuses the rest anyway; the point of matching it here is that
 * a manager never picks something at step four and discovers at step six that
 * it cannot go out.
 */
export interface PickedTemplate {
  name: string;
  languageCode: string;
  /** The approved wording, as a customer reads it. Sent to the approver verbatim. */
  preview: string;
}

export function TemplatePicker({
  value,
  onChange,
}: {
  value: { name: string; languageCode: string } | null;
  onChange: (picked: PickedTemplate | null) => void;
}) {
  const templates = useMessageTemplates();

  const sendable = useMemo(
    () => (templates.data ?? []).filter(isTemplateSendable),
    [templates.data],
  );

  if (templates.isLoading) return <Skeleton className="h-40 w-full rounded-lg" />;

  if (!sendable.length) {
    /*
     * Empty for two very different reasons, and the difference decides what to
     * do next: nothing has ever been written, or something was written and
     * Meta has not approved it. Both roads lead to the same screen, so the
     * message names it rather than leaving somebody to find it.
     */
    const waiting = (templates.data ?? []).length;
    return (
      <div className="flex items-start gap-3 rounded-lg border border-dashed p-4">
        <AlertCircle className="mt-0.5 size-4 shrink-0 text-muted-foreground" />
        <div className="space-y-1 text-sm">
          <p className="font-medium">
            {waiting
              ? "No template is approved and ready to send"
              : "No templates yet"}
          </p>
          <p className="text-muted-foreground">
            {waiting
              ? `${waiting} ${waiting === 1 ? "template is" : "templates are"} recorded, but none has an approval from Meta confirmed in the last day.`
              : "WhatsApp only allows an approved template for a message a customer did not ask for."}
          </p>
          <Link
            href="/settings/integrations/templates"
            className="inline-block pt-1 text-sm font-medium text-primary hover:underline"
          >
            {waiting ? "Synchronise with Meta" : "Write one and submit it for review"} →
          </Link>
        </div>
      </div>
    );
  }

  return (
    <div className="space-y-2">
      <Label className="text-xs">Approved templates</Label>
      <div className="space-y-2">
        {sendable.map((row) => {
          const name = row.name ?? row.externalId;
          const language = row.metadata.languageCode;
          const chosen = value?.name === name && value?.languageCode === language;
          const preview = row.metadata.bodyPreview?.trim();

          return (
            <button
              key={row.id}
              type="button"
              onClick={() =>
                onChange(
                  chosen
                    ? null
                    : { name, languageCode: language, preview: preview ?? "" },
                )
              }
              className={cn(
                "flex w-full items-start gap-3 rounded-lg border p-3 text-left transition hover:border-primary/50",
                chosen && "border-primary bg-primary/5",
              )}
            >
              <span
                className={cn(
                  "mt-0.5 flex size-4 shrink-0 items-center justify-center rounded-full border",
                  chosen ? "border-primary bg-primary text-primary-foreground" : "border-muted-foreground/40",
                )}
              >
                {chosen ? <Check className="size-3" /> : null}
              </span>
              <span className="min-w-0 flex-1 space-y-1.5">
                <span className="flex flex-wrap items-center gap-2">
                  <span className="font-medium">{name}</span>
                  <Badge variant="outline" className="text-[10px]">
                    {language}
                  </Badge>
                  <Badge variant="outline" className="text-[10px] capitalize">
                    {row.metadata.category}
                  </Badge>
                </span>
                {/*
                  The approved wording, not a paraphrase. A template with no
                  stored preview says so rather than showing a blank line —
                  that is a real state for anything recorded before previews
                  existed, and silence would read as "no message".
                */}
                {preview ? (
                  <span className="block rounded-lg rounded-tl-sm bg-[#d9fdd3] p-2.5 text-[13px] leading-relaxed text-[#111b21] dark:bg-[#005c4b] dark:text-[#e9edef]">
                    {preview}
                  </span>
                ) : (
                  <span className="flex items-center gap-1.5 text-xs text-muted-foreground">
                    <MessageSquareText className="size-3" />
                    Approved, but its wording was never recorded here. Synchronise to fetch it.
                  </span>
                )}
              </span>
            </button>
          );
        })}
      </div>
    </div>
  );
}
