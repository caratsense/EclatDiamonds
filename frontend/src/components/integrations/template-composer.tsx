"use client";

import { useMemo, useRef, useState } from "react";
import { ImagePlus, Images, Plus, Send, X } from "lucide-react";
import { toast } from "sonner";

import { Button } from "@/components/ui/button";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
  DialogTrigger,
} from "@/components/ui/dialog";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";
import { Textarea } from "@/components/ui/textarea";
import {
  useSubmitTemplate,
  useUploadTemplateImage,
  type TemplateCardInput,
  type TemplateDraftInput,
} from "@/lib/queries/meta-admin";
import { TENANT_NAME } from "@/lib/brand";
import { apiErrorMessage } from "@/lib/utils";

/**
 * Write a WhatsApp template here and put it in for Meta's review.
 *
 * Until this existed, every template had to be typed into WhatsApp Manager by
 * somebody with access to the client's Meta Business account — which meant, in
 * practice, that there were none. The WABA held one template and it was the
 * `hello_world` sample Meta ships, so a reminder campaign had nothing it was
 * allowed to send.
 *
 * ## The preview is the feature
 *
 * A template is written with `{{1}}` placeholders and read by a customer with
 * real values in them. Those are different sentences, and the gap between them
 * is where the embarrassing mistakes live — a trailing comma before a name, a
 * double space, a sentence that only parses if you know what the variable was
 * going to be. The preview below renders what the customer actually receives,
 * updating as you type, so nobody submits on faith and waits a day to find out.
 */
const LANGUAGES = [
  { code: "en_US", label: "English" },
  { code: "hi_IN", label: "Hindi" },
  { code: "gu_IN", label: "Gujarati" },
  { code: "mr_IN", label: "Marathi" },
  { code: "ta_IN", label: "Tamil" },
];

const CATEGORIES = [
  {
    value: "UTILITY" as const,
    label: "Utility",
    hint: "Order updates, appointment reminders, anything the customer is expecting.",
  },
  {
    value: "MARKETING" as const,
    label: "Marketing",
    hint: "Offers, new collections, invitations. Reviewed more strictly and billed higher.",
  },
  {
    value: "AUTHENTICATION" as const,
    label: "Authentication",
    hint: "One-time codes only.",
  },
];

const PLACEHOLDER_RE = /\{\{\s*(\d+)\s*\}\}/g;

/** Which placeholders the body uses, in order, deduplicated. */
function placeholdersIn(text: string): number[] {
  const found = new Set<number>();
  for (const m of text.matchAll(PLACEHOLDER_RE)) found.add(Number(m[1]));
  return [...found].sort((a, b) => a - b);
}

export function TemplateComposer({
  integrationId,
  disabled,
}: {
  integrationId: string;
  disabled?: boolean;
}) {
  const submit = useSubmitTemplate(integrationId);
  const [open, setOpen] = useState(false);

  const [name, setName] = useState("");
  const [languageCode, setLanguageCode] = useState("en_US");
  const [category, setCategory] = useState<TemplateDraftInput["category"]>("UTILITY");
  const [body, setBody] = useState("");
  const [footer, setFooter] = useState("");
  const [examples, setExamples] = useState<string[]>([]);

  /*
   * A picture above the message, and/or a row of product cards.
   *
   * Both carry an asset HANDLE from Meta's resumable upload, never a URL:
   * Meta reviews the real image when approving the template. `previewUrl` is
   * a local blob so somebody can see what they attached, and is never sent.
   */
  const [headerFormat, setHeaderFormat] = useState<"TEXT" | "IMAGE">("TEXT");
  const [header, setHeader] = useState("");
  const [headerImage, setHeaderImage] = useState<{ handle: string; previewUrl: string } | null>(null);
  const [cards, setCards] = useState<TemplateCardInput[]>([]);
  const headerFileRef = useRef<HTMLInputElement>(null);
  const cardFileRef = useRef<HTMLInputElement>(null);
  const upload = useUploadTemplateImage(integrationId);

  const isCarousel = cards.length > 0;

  const pickHeaderImage = async (file?: File) => {
    if (!file) return;
    try {
      const { handle } = await upload.mutateAsync(file);
      setHeaderImage((prev) => {
        if (prev) URL.revokeObjectURL(prev.previewUrl);
        return { handle, previewUrl: URL.createObjectURL(file) };
      });
    } catch (e) {
      toast.error(apiErrorMessage(e, "Could not upload that image."));
    }
  };

  const addCard = async (file?: File) => {
    if (!file) return;
    try {
      const { handle } = await upload.mutateAsync(file);
      setCards((prev) => [
        ...prev,
        {
          headerHandle: handle,
          previewUrl: URL.createObjectURL(file),
          buttons: [{ type: "QUICK_REPLY", text: "Show me more" }],
        },
      ]);
    } catch (e) {
      toast.error(apiErrorMessage(e, "Could not upload that image."));
    }
  };

  const removeCard = (i: number) =>
    setCards((prev) => {
      const card = prev[i];
      if (card?.previewUrl) URL.revokeObjectURL(card.previewUrl);
      return prev.filter((_, n) => n !== i);
    });

  const patchCard = (i: number, patch: Partial<TemplateCardInput>) =>
    setCards((prev) => prev.map((c, n) => (n === i ? { ...c, ...patch } : c)));

  const used = useMemo(() => placeholdersIn(body), [body]);

  /*
   * The gap check runs here as well as on the server.
   *
   * Not duplication for its own sake: Meta rejects "Hi {{1}}, see you at {{3}}"
   * hours later with a message that names the component rather than the gap.
   * Catching it while the cursor is still in the box is the difference between
   * a typo and a lost review cycle.
   */
  const gap = used.find((n, i) => n !== i + 1);
  const missingExamples = used.filter((n) => !examples[n - 1]?.trim());

  const preview = body.replace(PLACEHOLDER_RE, (whole, digits: string) => {
    const value = examples[Number(digits) - 1];
    return value?.trim() ? value.trim() : whole;
  });

  /*
   * Meta's picture and carousel rules, checked while the cursor is still in
   * the box.
   *
   * Every one of these, broken, comes back a DAY later as a rejection naming
   * a component rather than the mistake — "carousel cards must have the same
   * components" is not a sentence that tells you which card you forgot the
   * button on. Kept out of the `problem` chain below because there are enough
   * of them that a nested ternary stops being readable.
   */
  const pictureProblem: string | null = isCarousel
    ? cards.length < 2
      ? "A carousel needs at least 2 cards. One picture is a header, not a carousel."
      : category !== "MARKETING"
        ? "A carousel is a marketing template. Change the category to Marketing."
        : headerImage || header.trim()
          ? "A carousel carries its pictures on the cards, so remove the template's own header."
          : cards.some((c) => c.buttons.length < 1)
            ? "Every card needs at least one button."
            : new Set(cards.map((c) => c.buttons.map((b) => b.type).join(","))).size > 1
              ? "Every card must carry the same buttons."
              : cards.some((c) => c.body?.trim()) && !cards.every((c) => c.body?.trim())
                ? "Either every card has a line of text or none do."
                : cards.some((c) => c.buttons.some((b) => b.type === "URL" && !b.url?.trim()))
                  ? "A link button needs a link."
                  : null
    : headerFormat === "IMAGE" && !headerImage
      ? "Upload the header image."
      : null;

  const problem =
    !name.trim()
      ? "Give the template a name."
      : !/^[a-z0-9_]+$/.test(name.trim())
        ? "Lowercase letters, numbers and underscores only."
        : !body.trim()
          ? "Write the message."
          : gap !== undefined
            ? `Placeholders must run 1, 2, 3 with no gaps — this jumps to {{${gap}}}.`
            : missingExamples.length
              ? `Give a sample value for ${missingExamples.map((n) => `{{${n}}}`).join(", ")}.`
              : pictureProblem;

  const reset = () => {
    setName("");
    setBody("");
    setFooter("");
    setExamples([]);
    setCategory("UTILITY");
    setLanguageCode("en_US");
    setHeaderFormat("TEXT");
    setHeader("");
    setHeaderImage((prev) => {
      if (prev) URL.revokeObjectURL(prev.previewUrl);
      return null;
    });
    setCards((prev) => {
      for (const c of prev) if (c.previewUrl) URL.revokeObjectURL(c.previewUrl);
      return [];
    });
  };

  const send = async () => {
    if (problem) return;
    try {
      const result = await submit.mutateAsync({
        name: name.trim().toLowerCase(),
        languageCode,
        category,
        body: body.trim(),
        ...(footer.trim() ? { footer: footer.trim() } : {}),
        ...(used.length ? { examples: used.map((n) => examples[n - 1]?.trim() ?? "") } : {}),
        // A carousel replaces the template's own header, so the two are
        // mutually exclusive here exactly as they are at Meta.
        ...(isCarousel
          ? { cards: cards.map(({ previewUrl: _preview, ...card }) => card) }
          : headerFormat === "IMAGE" && headerImage
            ? { headerFormat: "IMAGE" as const, headerHandle: headerImage.handle }
            : header.trim()
              ? { header: header.trim() }
              : {}),
      });
      // Never "created" or "approved". It is in a queue at Meta, and saying
      // otherwise is how somebody builds a campaign on a template that is
      // still under review.
      toast.success(`"${result.name}" submitted to Meta`, {
        description: "Under review. It becomes sendable once Meta approves it, usually within a day.",
      });
      reset();
      setOpen(false);
    } catch (e) {
      toast.error(apiErrorMessage(e, "Could not submit that template."));
    }
  };

  return (
    <Dialog
      open={open}
      onOpenChange={(next) => {
        setOpen(next);
        if (!next) reset();
      }}
    >
      <DialogTrigger asChild>
        <Button size="sm" disabled={disabled}>
          <Plus className="size-4" />
          New template
        </Button>
      </DialogTrigger>
      <DialogContent className="max-h-[90vh] overflow-y-auto sm:max-w-2xl">
        <DialogHeader>
          <DialogTitle>New WhatsApp template</DialogTitle>
          <DialogDescription>
            Meta reviews every template before it can be sent. Usually under a day.
          </DialogDescription>
        </DialogHeader>

        <div className="space-y-4">
          <div className="grid gap-3 sm:grid-cols-[1fr_10rem]">
            <div className="space-y-1.5">
              <Label htmlFor="tpl-name" className="text-xs">
                Name
              </Label>
              <Input
                id="tpl-name"
                value={name}
                placeholder="appointment_reminder"
                // Meta's own constraint. Enforced as you type rather than
                // reported back, because the name cannot be changed later.
                onChange={(e) => setName(e.target.value.toLowerCase().replace(/[^a-z0-9_]/g, "_"))}
              />
              <p className="text-[11px] text-muted-foreground">
                Internal only. Customers never see it, and it cannot be changed later.
              </p>
            </div>
            <div className="space-y-1.5">
              <Label className="text-xs">Language</Label>
              <Select value={languageCode} onValueChange={setLanguageCode}>
                <SelectTrigger>
                  <SelectValue />
                </SelectTrigger>
                <SelectContent>
                  {LANGUAGES.map((l) => (
                    <SelectItem key={l.code} value={l.code}>
                      {l.label}
                    </SelectItem>
                  ))}
                </SelectContent>
              </Select>
            </div>
          </div>

          <div className="space-y-1.5">
            <Label className="text-xs">Category</Label>
            <Select
              value={category}
              onValueChange={(v) => setCategory(v as TemplateDraftInput["category"])}
            >
              <SelectTrigger>
                <SelectValue />
              </SelectTrigger>
              <SelectContent>
                {CATEGORIES.map((c) => (
                  <SelectItem key={c.value} value={c.value}>
                    {c.label}
                  </SelectItem>
                ))}
              </SelectContent>
            </Select>
            <p className="text-[11px] text-muted-foreground">
              {CATEGORIES.find((c) => c.value === category)?.hint}
            </p>
          </div>

          <div className="space-y-1.5">
            <Label htmlFor="tpl-body" className="text-xs">
              Message
            </Label>
            <Textarea
              id="tpl-body"
              rows={4}
              value={body}
              onChange={(e) => setBody(e.target.value)}
              placeholder="Hi {{1}}, your order at {{2}} is ready to collect."
            />
            <p className="text-[11px] text-muted-foreground">
              Use <code className="rounded bg-muted px-1">{"{{1}}"}</code>,{" "}
              <code className="rounded bg-muted px-1">{"{{2}}"}</code> for anything that changes per
              customer. {body.length}/1024
            </p>
          </div>

          {used.length > 0 && (
            <div className="space-y-2 rounded-lg border bg-muted/30 p-3">
              <Label className="text-xs">Sample values</Label>
              <p className="text-[11px] text-muted-foreground">
                Meta refuses a template with variables and no examples. These are only for the
                reviewer; real values are filled in per customer at send time.
              </p>
              <div className="grid gap-2 sm:grid-cols-2">
                {used.map((n) => (
                  <div key={n} className="flex items-center gap-2">
                    <span className="w-10 shrink-0 font-mono text-xs text-muted-foreground">
                      {`{{${n}}}`}
                    </span>
                    <Input
                      value={examples[n - 1] ?? ""}
                      placeholder={n === 1 ? "Priya" : "Bandra"}
                      onChange={(e) => {
                        const next = [...examples];
                        next[n - 1] = e.target.value;
                        setExamples(next);
                      }}
                    />
                  </div>
                ))}
              </div>
            </div>
          )}

          {/* ── Picture above the message ───────────────────────────────── */}
          {!isCarousel && (
            <div className="space-y-1.5">
              <Label className="text-xs">Above the message</Label>
              <div className="flex gap-2">
                {(["TEXT", "IMAGE"] as const).map((f) => (
                  <Button
                    key={f}
                    type="button"
                    size="sm"
                    variant={headerFormat === f ? "default" : "outline"}
                    onClick={() => setHeaderFormat(f)}
                  >
                    {f === "TEXT" ? "A line of text" : "A picture"}
                  </Button>
                ))}
              </div>

              {headerFormat === "TEXT" ? (
                <Input
                  value={header}
                  maxLength={60}
                  onChange={(e) => setHeader(e.target.value)}
                  placeholder={`${TENANT_NAME} — new arrivals`}
                />
              ) : (
                <div className="flex items-center gap-3 rounded-lg border border-dashed p-3">
                  {headerImage ? (
                    /* eslint-disable-next-line @next/next/no-img-element -- a blob: preview of a local file */
                    <img
                      src={headerImage.previewUrl}
                      alt="Header"
                      className="h-16 w-16 rounded object-cover"
                    />
                  ) : null}
                  <Button
                    type="button"
                    size="sm"
                    variant="outline"
                    disabled={upload.isPending}
                    onClick={() => headerFileRef.current?.click()}
                  >
                    <ImagePlus className="size-4" />
                    {upload.isPending ? "Uploading…" : headerImage ? "Replace" : "Upload image"}
                  </Button>
                  <p className="text-xs text-muted-foreground">
                    JPEG or PNG, up to 5 MB. Meta reviews this picture with the template.
                  </p>
                </div>
              )}
            </div>
          )}

          {/* ── Carousel ────────────────────────────────────────────────── */}
          <div className="space-y-2 rounded-lg border p-3">
            <div className="flex items-center justify-between gap-3">
              <div>
                <Label className="text-xs">
                  <Images className="mr-1 inline size-3.5" />
                  Product cards {isCarousel ? `(${cards.length} of 10)` : "(optional)"}
                </Label>
                <p className="text-xs text-muted-foreground">
                  A swipeable row under the message. Needs 2 to 10 cards, each with its own
                  picture and at least one button. Marketing templates only.
                </p>
              </div>
              <Button
                type="button"
                size="sm"
                variant="outline"
                disabled={upload.isPending || cards.length >= 10}
                onClick={() => cardFileRef.current?.click()}
              >
                <Plus className="size-4" />
                {upload.isPending ? "Uploading…" : "Add card"}
              </Button>
            </div>

            {cards.map((card, i) => (
              <div key={`${card.headerHandle}-${i}`} className="flex gap-3 rounded-lg border p-2">
                {/* eslint-disable-next-line @next/next/no-img-element -- a blob: preview of a local file */}
                <img
                  src={card.previewUrl}
                  alt={`Card ${i + 1}`}
                  className="h-20 w-20 shrink-0 rounded object-cover"
                />
                <div className="min-w-0 flex-1 space-y-2">
                  <Input
                    value={card.body ?? ""}
                    maxLength={160}
                    onChange={(e) => patchCard(i, { body: e.target.value })}
                    placeholder="Card text (optional — but all cards or none)"
                  />
                  {card.buttons.map((b, bi) => (
                    <div key={bi} className="flex flex-wrap items-center gap-2">
                      <Select
                        value={b.type}
                        onValueChange={(v) =>
                          patchCard(i, {
                            buttons: card.buttons.map((x, n) =>
                              n === bi ? { ...x, type: v as "QUICK_REPLY" | "URL" } : x,
                            ),
                          })
                        }
                      >
                        <SelectTrigger className="h-8 w-[8.5rem]">
                          <SelectValue />
                        </SelectTrigger>
                        <SelectContent>
                          <SelectItem value="QUICK_REPLY">Quick reply</SelectItem>
                          <SelectItem value="URL">Link</SelectItem>
                        </SelectContent>
                      </Select>
                      <Input
                        className="h-8 w-36"
                        value={b.text}
                        maxLength={25}
                        onChange={(e) =>
                          patchCard(i, {
                            buttons: card.buttons.map((x, n) =>
                              n === bi ? { ...x, text: e.target.value } : x,
                            ),
                          })
                        }
                        placeholder="Button label"
                      />
                      {b.type === "URL" ? (
                        <Input
                          className="h-8 min-w-0 flex-1"
                          value={b.url ?? ""}
                          onChange={(e) =>
                            patchCard(i, {
                              buttons: card.buttons.map((x, n) =>
                                n === bi ? { ...x, url: e.target.value } : x,
                              ),
                            })
                          }
                          placeholder="https://…"
                        />
                      ) : null}
                      {card.buttons.length > 1 ? (
                        <Button
                          type="button"
                          size="icon"
                          variant="ghost"
                          className="h-8 w-8"
                          title="Remove this button"
                          onClick={() =>
                            patchCard(i, { buttons: card.buttons.filter((_, n) => n !== bi) })
                          }
                        >
                          <X className="size-3.5" />
                        </Button>
                      ) : null}
                    </div>
                  ))}
                  {card.buttons.length < 2 ? (
                    <Button
                      type="button"
                      size="sm"
                      variant="ghost"
                      className="h-7 text-xs"
                      onClick={() =>
                        patchCard(i, {
                          buttons: [...card.buttons, { type: "QUICK_REPLY", text: "" }],
                        })
                      }
                    >
                      <Plus className="size-3.5" />
                      Second button
                    </Button>
                  ) : null}
                </div>
                <Button
                  type="button"
                  size="icon"
                  variant="ghost"
                  className="h-8 w-8 shrink-0"
                  title={`Remove card ${i + 1}`}
                  onClick={() => removeCard(i)}
                >
                  <X className="size-4" />
                </Button>
              </div>
            ))}
          </div>

          {/* Meta accepts JPEG and PNG as a template image; nothing else. */}
          <input
            ref={headerFileRef}
            type="file"
            accept="image/jpeg,image/png"
            className="hidden"
            onChange={(e) => {
              void pickHeaderImage(e.target.files?.[0]);
              e.target.value = "";
            }}
          />
          <input
            ref={cardFileRef}
            type="file"
            accept="image/jpeg,image/png"
            className="hidden"
            onChange={(e) => {
              void addCard(e.target.files?.[0]);
              e.target.value = "";
            }}
          />

          <div className="space-y-1.5">
            <Label htmlFor="tpl-footer" className="text-xs">
              Footer <span className="text-muted-foreground">(optional)</span>
            </Label>
            <Input
              id="tpl-footer"
              value={footer}
              maxLength={60}
              onChange={(e) => setFooter(e.target.value)}
              placeholder={TENANT_NAME}
            />
          </div>

          {/* What the customer receives, not what was typed. */}
          {body.trim() && (
            <div className="space-y-1.5">
              <Label className="text-xs">What the customer sees</Label>
              <div className="rounded-xl rounded-tl-sm border border-black/[0.04] bg-[#d9fdd3] p-3 text-[13.5px] leading-relaxed text-[#111b21] shadow-xs dark:border-white/[0.04] dark:bg-[#005c4b] dark:text-[#e9edef]">
                <p className="whitespace-pre-wrap">{preview}</p>
                {footer.trim() && (
                  <p className="mt-1.5 text-[11px] opacity-60">{footer.trim()}</p>
                )}
              </div>
            </div>
          )}
        </div>

        <DialogFooter className="flex-col items-stretch gap-2 sm:flex-row sm:items-center sm:justify-between">
          <p className="text-[11px] text-muted-foreground">
            {problem ?? "Ready to submit. Meta decides; nothing is sendable until it approves."}
          </p>
          <Button onClick={send} disabled={!!problem || submit.isPending} size="sm">
            <Send className="size-4" />
            {submit.isPending ? "Submitting…" : "Submit for review"}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}
