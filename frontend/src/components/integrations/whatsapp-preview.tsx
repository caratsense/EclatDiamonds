"use client";

import { ExternalLink, Reply } from "lucide-react";

import { cn } from "@/lib/utils";

/**
 * A template as the customer receives it.
 *
 * The client could not review her own messages: the template list showed a
 * name, a language and whether Meta had approved it, and nothing else. The
 * body was not displayed anywhere, rows did not open, and the editor took the
 * text into a bare textarea with no rendering at all. Her words were "I am
 * unable to review my message" and "I cannot even see the templates that are
 * created in detail".
 *
 * So this draws the message rather than describing it — the picture at the top,
 * the text with its real values filled in, the footer in its smaller grey, and
 * the buttons as the separate tappable rows WhatsApp actually renders. Shown
 * both in the editor while typing and in the detail view of an existing
 * template, from the same component, so the thing being reviewed and the thing
 * being written cannot look different.
 */

export interface PreviewButton {
  type: "URL" | "QUICK_REPLY";
  text: string;
  url?: string;
}

/** A carousel card, as the composer holds it while building one. */
export interface PreviewCard {
  /** Undefined while a card's picture is still uploading. */
  previewUrl?: string;
  body?: string;
  buttons: { type: "URL" | "QUICK_REPLY"; text: string }[];
}

export interface WhatsAppPreviewProps {
  /** Plain-text header line. Ignored when `headerImageUrl` is set. */
  header?: string | null;
  /** The picture above the message, already uploaded or a local object URL. */
  headerImageUrl?: string | null;
  body: string;
  /** Sample values for `{{1}}`, `{{2}}` … in order. */
  examples?: string[];
  footer?: string | null;
  buttons?: PreviewButton[];
  /** Carousel cards, which sit UNDER the message and scroll sideways. */
  cards?: PreviewCard[];
  className?: string;
}

/**
 * Put the sample values into the message.
 *
 * A placeholder with no sample yet is left visible as `{{2}}` rather than
 * blanked: a gap in the sentence reads as finished text that is simply wrong,
 * while the braces read as "you have not filled this in", which is true.
 */
function fillPlaceholders(body: string, examples: string[]): { text: string; missing: number[] } {
  const missing: number[] = [];
  const text = body.replace(/\{\{(\d+)\}\}/g, (match, raw) => {
    const n = Number(raw);
    const value = examples[n - 1]?.trim();
    if (!value) {
      missing.push(n);
      return match;
    }
    return value;
  });
  return { text, missing: [...new Set(missing)] };
}

export function WhatsAppPreview({
  header,
  headerImageUrl,
  body,
  examples = [],
  footer,
  buttons = [],
  cards = [],
  className,
}: WhatsAppPreviewProps) {
  const { text } = fillPlaceholders(body, examples);
  const headerText = headerImageUrl ? null : header?.trim();

  return (
    <div
      className={cn(
        // The chat ground, so the bubble reads as a message rather than a card.
        "rounded-lg bg-[#e6ddd4] p-3 dark:bg-[#0b141a]",
        className,
      )}
    >
      <div className="mx-auto max-w-[320px]">
        <div className="overflow-hidden rounded-lg bg-white shadow-sm dark:bg-[#202c33]">
          {headerImageUrl ? (
            /*
              1.91:1 — WhatsApp's own header ratio. Fixed here on purpose: an
              image at another shape IS cropped on the phone, and a preview
              that letterboxes it instead would hide exactly that.
            */
            <div className="aspect-[1.91/1] w-full bg-muted">
              {/*
                A plain img, not next/image: the source is Meta's own CDN
                (scontent.whatsapp.net) for an approved template and a local
                object URL while composing. Neither belongs in remotePatterns,
                and the optimiser has nothing to add to a 1200x628 preview.
              */}
              {/* eslint-disable-next-line @next/next/no-img-element */}
              <img src={headerImageUrl} alt="" className="h-full w-full object-cover" />
            </div>
          ) : null}

          <div className="space-y-1.5 p-2.5">
            {headerText ? (
              <p className="text-[13px] font-semibold leading-snug text-foreground">{headerText}</p>
            ) : null}

            {/* `whitespace-pre-wrap`: the blank lines in her message are part of it. */}
            <p className="whitespace-pre-wrap break-words text-[13px] leading-[1.45] text-foreground">
              {text || (
                <span className="italic text-muted-foreground">
                  Your message will appear here.
                </span>
              )}
            </p>

            {footer?.trim() ? (
              <p className="pt-0.5 text-[11px] leading-snug text-muted-foreground">
                {footer.trim()}
              </p>
            ) : null}

            <p className="pt-0.5 text-right text-[10px] text-muted-foreground">
              {new Date().toLocaleTimeString("en-IN", { hour: "2-digit", minute: "2-digit" })}
            </p>
          </div>

          {/*
            The cards sit UNDER the message and scroll sideways, which is the
            part nobody can picture from a form.
          */}
          {cards.length ? (
            <div className="flex snap-x gap-2 overflow-x-auto px-2.5 pb-2.5">
              {cards.map((card, i) => (
                <div
                  key={`${card.previewUrl}-${i}`}
                  className="w-36 shrink-0 snap-start overflow-hidden rounded-lg border bg-background"
                >
                  {card.previewUrl ? (
                    // eslint-disable-next-line @next/next/no-img-element
                    <img src={card.previewUrl} alt="" className="h-20 w-full object-cover" />
                  ) : (
                    <div className="h-20 w-full bg-muted" />
                  )}
                  {card.body?.trim() ? (
                    <p className="px-1.5 pt-1.5 text-[11.5px] leading-snug">{card.body.trim()}</p>
                  ) : null}
                  <div className="p-1.5 pt-1">
                    {card.buttons.map((b, bi) => (
                      <div
                        key={bi}
                        className="mt-1 border-t pt-1 text-center text-[11.5px] font-medium text-[#00a5f4]"
                      >
                        {b.text.trim() || (b.type === "URL" ? "Link" : "Quick reply")}
                      </div>
                    ))}
                  </div>
                </div>
              ))}
            </div>
          ) : null}

          {buttons.length ? (
            <div className="border-t">
              {buttons.map((b, i) => (
                <div
                  key={`${b.text}-${i}`}
                  className={cn(
                    "flex items-center justify-center gap-1.5 px-2 py-2 text-[13px] font-medium text-[#00a5f4]",
                    i > 0 && "border-t",
                  )}
                >
                  {b.type === "URL" ? (
                    <ExternalLink className="h-3.5 w-3.5" />
                  ) : (
                    <Reply className="h-3.5 w-3.5" />
                  )}
                  {b.text || "Button"}
                </div>
              ))}
            </div>
          ) : null}
        </div>
      </div>
    </div>
  );
}
