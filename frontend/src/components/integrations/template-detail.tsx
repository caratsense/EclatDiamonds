"use client";

import { Pencil } from "lucide-react";

import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";
import { WhatsAppPreview } from "@/components/integrations/whatsapp-preview";
import type { TemplateEditSeed } from "@/components/integrations/template-composer";
import type { MessageTemplateRow } from "@/lib/queries/meta-admin";

/**
 * One template, as the customer receives it and as Meta currently rates it.
 *
 * The list could say a template existed and that Meta had approved it, and
 * nothing more — no wording, no picture, no buttons, and no way to open a row.
 * The client's words: "I cannot even see the templates that are created in
 * detail."
 *
 * The preview is the same component the composer draws while typing, so a
 * template reviewed here and a template being written look identical rather
 * than merely similar.
 */

const when = (iso: string | null | undefined) =>
  iso ? new Date(iso).toLocaleString("en-IN", { dateStyle: "medium", timeStyle: "short" }) : "—";

/**
 * The seed the editor opens from, or the reason this one cannot be edited.
 *
 * Two templates refuse, and both say so rather than offering a button that
 * breaks something: a carousel, whose cards are not recoverable from what Meta
 * returns, and anything recorded before the source was kept, where the only
 * body we hold has the sample values already substituted into it.
 */
function editSeed(row: MessageTemplateRow): TemplateEditSeed | string {
  const m = row.metadata;
  if (m.isCarousel) {
    return "A carousel is edited at Meta for now — its cards cannot be rebuilt from here.";
  }
  if (m.headerFormat && m.headerFormat !== "TEXT" && m.headerFormat !== "IMAGE") {
    /*
     * A DOCUMENT, VIDEO or LOCATION header.
     *
     * The editor offers none, text or picture, so one of these would seed as
     * "none" and the save would silently strip the header off a working
     * template. `quotation_pdf_v1` is exactly that: its header is the
     * quotation PDF, and editing the wording would detach it.
     */
    return `This template's header is a ${m.headerFormat.toLowerCase()}, which this editor cannot carry. Edit it at Meta.`;
  }
  if (!m.bodySource) {
    return "The original wording has not been read from Meta yet. Press Synchronise now, then edit.";
  }
  return {
    assetId: row.id,
    name: row.name ?? row.externalId,
    languageCode: m.languageCode,
    category: m.category.toUpperCase() as TemplateEditSeed["category"],
    body: m.bodySource,
    examples: m.bodyExamples ?? [],
    headerFormat: m.headerFormat ?? null,
    header: m.headerText ?? null,
    footer: m.footerText ?? null,
    buttons: (m.buttons ?? []).map((b) => ({ type: b.type, text: b.text, url: b.url })),
  };
}

export function TemplateDetail({
  row,
  onClose,
  onEdit,
}: {
  row: MessageTemplateRow | null;
  onClose: () => void;
  /** Absent while no connection is chosen, which is when editing has no target. */
  onEdit?: (seed: TemplateEditSeed) => void;
}) {
  if (!row) return null;
  const m = row.metadata;
  const seed = editSeed(row);
  /*
   * `bodyPreview` already carries the sample values substituted in, so the
   * preview is given no separate example list — passing both would fill the
   * placeholders twice and show the sample where a name belongs.
   */
  const body = m.bodyPreview ?? "";

  return (
    <Dialog open={Boolean(row)} onOpenChange={(open) => !open && onClose()}>
      <DialogContent className="max-h-[90vh] overflow-y-auto sm:max-w-2xl">
        <DialogHeader>
          <DialogTitle className="font-mono text-base">{row.name ?? row.externalId}</DialogTitle>
          <DialogDescription>
            {m.category} · {m.languageCode} · last confirmed {when(row.lastVerifiedAt)}
          </DialogDescription>
        </DialogHeader>

        <div className="grid gap-5 sm:grid-cols-[minmax(0,1fr)_auto]">
          <div className="space-y-3">
            <div className="flex flex-wrap gap-2">
              <Badge
                variant={
                  m.providerStatus === "APPROVED"
                    ? "success"
                    : m.providerStatus === "UNKNOWN"
                      ? "outline"
                      : "warning"
                }
              >
                Meta says {m.providerStatus.toLowerCase()}
              </Badge>
              {m.headerFormat ? <Badge variant="secondary">{m.headerFormat} header</Badge> : null}
              {m.buttons?.length ? (
                <Badge variant="secondary">
                  {m.buttons.length} button{m.buttons.length === 1 ? "" : "s"}
                </Badge>
              ) : null}
            </div>

            {body ? (
              <div className="space-y-1">
                <p className="text-xs font-medium text-muted-foreground">Message</p>
                <p className="whitespace-pre-wrap rounded-md border bg-muted/30 p-2.5 text-xs leading-relaxed">
                  {body}
                </p>
              </div>
            ) : (
              /*
                A template recorded before the wording was kept. Say which
                button fixes it rather than leaving an empty panel that reads
                as a broken screen.
              */
              <p className="rounded-md border border-dashed p-3 text-xs text-muted-foreground">
                The wording for this template has not been read from Meta yet. Press{" "}
                <strong>Synchronise now</strong> to fetch it.
              </p>
            )}

            {m.variables?.length ? (
              <div className="space-y-1">
                <p className="text-xs font-medium text-muted-foreground">
                  Fills in per customer
                </p>
                <div className="flex flex-wrap gap-1">
                  {m.variables.map((v, i) => (
                    <Badge key={`${v}-${i}`} variant="outline" className="font-mono text-[11px]">
                      {`{{${i + 1}}}`} {v}
                    </Badge>
                  ))}
                </div>
              </div>
            ) : null}

            {row.lastError ? (
              <p className="rounded-md border border-destructive/40 bg-destructive/5 p-2.5 text-xs text-destructive">
                {row.lastError}
              </p>
            ) : null}

            {onEdit ? (
              typeof seed === "string" ? (
                <p className="text-xs text-muted-foreground">{seed}</p>
              ) : (
                <div className="space-y-1">
                  <Button
                    size="sm"
                    variant="outline"
                    onClick={() => {
                      onEdit(seed);
                      onClose();
                    }}
                  >
                    <Pencil className="size-3.5" />
                    Edit template
                  </Button>
                  <p className="text-[11px] text-muted-foreground">
                    Meta reviews an edited template again, so it stops being sendable until that
                    comes back approved. The name and the language cannot change.
                  </p>
                </div>
              )
            ) : null}
          </div>

          <div className="space-y-1.5">
            <p className="text-xs font-medium text-muted-foreground">What the customer sees</p>
            {/*
              Only a picture is drawn as one. Meta returns a CDN URL for a
              DOCUMENT header too — the quotation PDF — and putting that in an
              img gives a broken image where a document should be.
            */}
            <WhatsAppPreview
              headerImageUrl={m.headerFormat === "IMAGE" ? m.headerImageUrl ?? null : null}
              header={m.headerText ?? null}
              body={body || "—"}
              footer={m.footerText ?? null}
              buttons={m.buttons ?? []}
            />
          </div>
        </div>
      </DialogContent>
    </Dialog>
  );
}
