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
  useEditTemplate,
  useSubmitTemplate,
  useUploadTemplateImage,
  type TemplateButtonInput,
  type TemplateCardInput,
  type TemplateDraftInput,
  type TemplateVariableDefault,
} from "@/lib/queries/meta-admin";
/*
 * The broadcast's own list of sources, not a second copy of the same four
 * strings. These choices are pre-selected straight into a campaign's variable
 * mapping, so two lists would eventually disagree and the one that was wrong
 * would be the one deciding what a customer reads.
 */
import {
  CAMPAIGN_VARIABLE_SOURCES,
  type CampaignVariableSource,
} from "@/lib/queries/campaigns";
import { Badge } from "@/components/ui/badge";
import { WhatsAppPreview } from "@/components/integrations/whatsapp-preview";
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

/**
 * An existing template, opened for editing.
 *
 * Meta lets a template be changed after approval and reviews it again; we had
 * no way to, so a typo in an approved template meant inventing `..._v2` and
 * leaving the wrong one behind. The client asked for parity: "it gives edit
 * option in template so that is not there".
 *
 * `body` is the SOURCE, with `{{1}}` still in it, never the filled preview —
 * re-submitting the preview would approve a template that greets everybody by
 * the name in the example.
 */
export interface TemplateEditSeed {
  assetId: string;
  name: string;
  languageCode: string;
  category: TemplateDraftInput["category"];
  body: string;
  examples: string[];
  headerFormat: string | null;
  header: string | null;
  footer: string | null;
  buttons: TemplateButtonInput[];
  /**
   * What was recorded as normally filling each variable.
   *
   * Carried through the edit because the submission REPLACES the stored
   * defaults rather than merging into them: opening an approved template to fix
   * a typo and saving it would otherwise quietly forget that `{{1}}` is a
   * customer's first name, and the next broadcast would ask again.
   */
  variableDefaults: TemplateVariableDefault[];
}

/**
 * What normally fills one `{{n}}`, as the composer holds it while typing.
 *
 * Kept in a record keyed by SLOT rather than in an array, so adding or deleting
 * a variable in the middle of the body cannot shift somebody's choice onto a
 * different placeholder. A slot with no entry has no default, which is not the
 * same as having a wrong one.
 */
export interface VariableDefaultRow {
  source: CampaignVariableSource;
  /** The wording itself, when the source is "fixed". */
  text?: string;
  /** What to send when the customer record is empty. */
  fallback?: string;
}

/**
 * The rows a submission carries, out of what the composer is holding.
 *
 * A variable left on "decide on each broadcast" sends NOTHING, rather than a
 * row naming a source nobody picked: a stored default is pre-selected on every
 * future send, so inventing one here would put words in her mouth for as long
 * as the template exists.
 *
 * A "fixed" row carries its wording and no stand-in — its own text is the
 * stand-in, which the server fills in. Sending both would be sending a
 * fallback that can never be reached.
 */
export function variableDefaultsFor(
  used: number[],
  rows: Record<number, VariableDefaultRow>,
): TemplateVariableDefault[] {
  return used.flatMap((n) => {
    const row = rows[n];
    if (!row) return [];
    return [
      row.source === "fixed"
        ? { slot: n, source: row.source, text: row.text?.trim() }
        : { slot: n, source: row.source, fallback: row.fallback?.trim() },
    ];
  });
}

/**
 * The first variable whose default was started and not finished.
 *
 * Both halves matter at send time, not at submission: Meta refuses a parameter
 * that is an empty string, so a broadcast pre-selecting a row with no stand-in
 * would fail on exactly the customers who have no name recorded — per
 * recipient, after the campaign was already running.
 */
export function incompleteDefaultSlot(
  used: number[],
  rows: Record<number, VariableDefaultRow>,
): number | undefined {
  return used.find((n) => {
    const row = rows[n];
    if (!row) return false;
    return row.source === "fixed" ? !row.text?.trim() : !row.fallback?.trim();
  });
}

/** The stand-in offered the moment a customer value is chosen, as the wizard does. */
const SUGGESTED_FALLBACK = "there";

/**
 * The "decide it on each broadcast" row in the dropdown.
 *
 * A Radix select item cannot have the empty string as its value, so the absence
 * of a default needs a word of its own. Nothing is stored for a variable left on
 * this, and the campaign wizard goes on asking exactly as it did before — which
 * is the honest state for the templates that already exist, rather than handing
 * every one of them a choice nobody made.
 */
const NO_DEFAULT = "per_broadcast";

export function TemplateComposer({
  integrationId,
  disabled,
  editing,
  open: openProp,
  onOpenChange,
}: {
  integrationId: string;
  disabled?: boolean;
  /** Present means edit that template rather than write a new one. */
  editing?: TemplateEditSeed | null;
  /** Set both to drive the dialog from elsewhere — the detail view does. */
  open?: boolean;
  onOpenChange?: (open: boolean) => void;
}) {
  const submit = useSubmitTemplate(integrationId);
  const edit = useEditTemplate(integrationId);
  const [open, setOpen] = useState(false);
  const controlled = openProp !== undefined;
  const dialogOpen = controlled ? openProp : open;
  const pending = submit.isPending || edit.isPending;

  const [name, setName] = useState(editing?.name ?? "");
  const [languageCode, setLanguageCode] = useState(editing?.languageCode ?? "en_US");
  const [category, setCategory] = useState<TemplateDraftInput["category"]>(
    editing?.category ?? "UTILITY",
  );
  const [body, setBody] = useState(editing?.body ?? "");
  const [footer, setFooter] = useState(editing?.footer ?? "");
  const [examples, setExamples] = useState<string[]>(editing?.examples ?? []);
  /*
   * What each variable normally is. Seeded from the template being edited, so
   * fixing a typo does not quietly forget that {{1}} is a customer's first
   * name — the submission replaces the stored defaults rather than merging.
   */
  const [variableDefaults, setVariableDefaults] = useState<Record<number, VariableDefaultRow>>(
    () =>
      Object.fromEntries(
        (editing?.variableDefaults ?? []).map((d) => [
          d.slot,
          { source: d.source, text: d.text, fallback: d.fallback },
        ]),
      ),
  );

  /*
   * A picture above the message, and/or a row of product cards.
   *
   * Both carry an asset HANDLE from Meta's resumable upload, never a URL:
   * Meta reviews the real image when approving the template. `previewUrl` is
   * a local blob so somebody can see what they attached, and is never sent.
   */
  /*
   * ONE choice, not two independent controls.
   *
   * It used to be a header format plus an optional list of cards, and adding
   * a card hid the header section while leaving an uploaded header image in
   * state. The picture vanished from the screen, stayed in the submission,
   * and validation then demanded it be removed -- from a control that was no
   * longer rendered. A dead end, reported from production.
   *
   * Meta treats these as three different template shapes, so the UI does too.
   * Switching clears what no longer applies, which is what makes "the picture
   * went somewhere" impossible rather than merely unlikely.
   */
  type HeaderType = "NONE" | "TEXT" | "IMAGE";
  const [headerType, setHeaderTypeState] = useState<HeaderType>(
    editing?.headerFormat === "IMAGE" ? "IMAGE" : editing?.header ? "TEXT" : "NONE",
  );
  const [isCarousel, setIsCarousel] = useState(false);
  const bodyRef = useRef<HTMLTextAreaElement>(null);

  /**
   * Put the next `{{n}}` where the cursor is.
   *
   * Always `used.length + 1`, never a gap: Meta rejects a body that jumps from
   * {{1}} to {{3}}, and the only way to produce one by hand is to delete a
   * variable from the middle. Numbering from what is actually in the text
   * means the next one is always correct, however the body was edited.
   */
  const insertVariable = () => {
    const el = bodyRef.current;
    const next = `{{${placeholdersIn(body).length + 1}}}`;
    const at = el?.selectionStart ?? body.length;
    const to = el?.selectionEnd ?? body.length;
    setBody(body.slice(0, at) + next + body.slice(to));
    // Put the caret after what was just inserted, so typing continues naturally.
    requestAnimationFrame(() => {
      el?.focus();
      el?.setSelectionRange(at + next.length, at + next.length);
    });
  };
  const [header, setHeader] = useState(editing?.header ?? "");
  const [headerImage, setHeaderImage] = useState<{ handle: string; previewUrl: string } | null>(null);
  const [cards, setCards] = useState<TemplateCardInput[]>([]);
  /*
   * Up to two tappable buttons. The client asked for these after reviewing the
   * feedback template: a form link as plain text in the body reads worse than
   * a "Give feedback" button, and WhatsApp renders the button as a control.
   * A carousel carries its buttons per card, so these are hidden there.
   */
  const [buttons, setButtons] = useState<TemplateButtonInput[]>(editing?.buttons ?? []);
  const headerFileRef = useRef<HTMLInputElement>(null);
  const cardFileRef = useRef<HTMLInputElement>(null);
  const upload = useUploadTemplateImage(integrationId);

  /** Changing the header type clears whatever the other types were holding. */
  const setHeaderType = (next: HeaderType) => {
    setHeaderTypeState(next);
    if (next !== "TEXT") setHeader("");
    if (next !== "IMAGE") {
      setHeaderImage((prev) => {
        if (prev) URL.revokeObjectURL(prev.previewUrl);
        return null;
      });
    }
  };

  /**
   * Turning the carousel on drops any header, because Meta refuses a template
   * that has both and the server says so. Doing it here means the refusal is
   * never reached: the two controls agree on screen instead of disagreeing a
   * day later in a rejection.
   */
  const setCarousel = (on: boolean) => {
    setIsCarousel(on);
    if (on) setHeaderType("NONE");
    if (!on) {
      setCards((prev) => {
        for (const c of prev) if (c.previewUrl) URL.revokeObjectURL(c.previewUrl);
        return [];
      });
    }
  };

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

  /**
   * The defaults to store, in slot order.
   *
   * Only the variables the body still has, and only the ones somebody actually
   * chose. A row for a deleted `{{3}}` would be refused by the server with a
   * sentence about a variable that is no longer on the screen.
   */
  const chosenDefaults = variableDefaultsFor(used, variableDefaults);

  /*
   * A default that was half chosen.
   *
   * The server refuses both of these with the same sentences, because a blank
   * value is one Meta rejects per recipient rather than at submission — so a
   * broadcast would pre-select the row, send to several thousand people, and
   * fail on the ones with no name recorded. Asked for here while the cursor is
   * still in the box.
   */
  const incompleteDefault = incompleteDefaultSlot(used, variableDefaults);
  const patchDefault = (slot: number, change: Partial<VariableDefaultRow> | null) =>
    setVariableDefaults((prev) => {
      if (!change) {
        const { [slot]: _cleared, ...rest } = prev;
        return rest;
      }
      return { ...prev, [slot]: { ...(prev[slot] ?? { source: "customer_first_name" }), ...change } };
    });

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
        : cards.some((c) => c.buttons.length < 1)
            ? "Every card needs at least one button."
            : new Set(cards.map((c) => c.buttons.map((b) => b.type).join(","))).size > 1
              ? "Every card must carry the same buttons."
              : cards.some((c) => c.body?.trim()) && !cards.every((c) => c.body?.trim())
                ? "Either every card has a line of text or none do."
                : cards.some((c) => c.buttons.some((b) => b.type === "URL" && !b.url?.trim()))
                  ? "A link button needs a link."
                  : null
    : headerType === "IMAGE" && !headerImage
      ? editing
        ? // Meta reviews the picture as part of the edit and takes it as an
          // upload handle, not as the URL of the one it already approved.
          "Attach the picture again — an edit has to send Meta the image, not a link to it."
        : "Upload the picture that goes above the message."
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
              : incompleteDefault !== undefined
                ? variableDefaults[incompleteDefault]?.source === "fixed"
                  ? `Type the wording that goes in {{${incompleteDefault}}} for everyone.`
                  : `Say what {{${incompleteDefault}}} should read when a customer has no name on record.`
                : pictureProblem;

  const reset = () => {
    setName("");
    setBody("");
    setFooter("");
    setExamples([]);
    setVariableDefaults({});
    setCategory("UTILITY");
    setLanguageCode("en_US");
    setHeaderTypeState("NONE");
    setIsCarousel(false);
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
      const draft: TemplateDraftInput = {
        name: name.trim().toLowerCase(),
        languageCode,
        category,
        body: body.trim(),
        ...(footer.trim() ? { footer: footer.trim() } : {}),
        ...(!isCarousel && buttons.length
          ? {
              buttons: buttons.map((b) => ({
                type: b.type,
                text: b.text.trim(),
                ...(b.type === "URL" ? { url: (b.url ?? "").trim() } : {}),
                ...(b.type === "URL" && (b.urlExample ?? "").trim()
                  ? { urlExample: (b.urlExample ?? "").trim() }
                  : {}),
              })),
            }
          : {}),
        ...(used.length ? { examples: used.map((n) => examples[n - 1]?.trim() ?? "") } : {}),
        /*
         * Sent on every edit, even when empty, so clearing a default actually
         * clears it. The server REPLACES the stored mapping with this; an
         * omitted field there keeps the old one, which would go on
         * pre-selecting a choice she had just removed.
         */
        variableDefaults: chosenDefaults,
        // A carousel replaces the template's own header, so the two are
        // mutually exclusive here exactly as they are at Meta.
        ...(isCarousel
          ? { cards: cards.map(({ previewUrl: _preview, ...card }) => card) }
          : headerType === "IMAGE" && headerImage
            ? { headerFormat: "IMAGE" as const, headerHandle: headerImage.handle }
            : header.trim()
              ? { header: header.trim() }
              : {}),
      };

      // Never "created" or "approved" in either case. It is in a queue at
      // Meta, and saying otherwise is how somebody builds a campaign on a
      // template that is still under review.
      if (editing) {
        const result = await edit.mutateAsync({ assetId: editing.assetId, ...draft });
        toast.success(`"${result.name}" sent back to Meta`, {
          description:
            "Meta reviews an edited template again, so it cannot be sent until that comes back approved.",
        });
      } else {
        const result = await submit.mutateAsync(draft);
        toast.success(`"${result.name}" submitted to Meta`, {
          description: "Under review. It becomes sendable once Meta approves it, usually within a day.",
        });
      }
      reset();
      setOpen(false);
      onOpenChange?.(false);
    } catch (e) {
      toast.error(
        apiErrorMessage(e, editing ? "Could not save that edit." : "Could not submit that template."),
      );
    }
  };

  return (
    <Dialog
      open={dialogOpen}
      onOpenChange={(next) => {
        setOpen(next);
        onOpenChange?.(next);
        if (!next) reset();
      }}
    >
      {/* No trigger when the dialog is driven from elsewhere — the detail
          view opens this from its own Edit button. */}
      {controlled ? null : (
        <DialogTrigger asChild>
          <Button size="sm" disabled={disabled}>
            <Plus className="size-4" />
            New template
          </Button>
        </DialogTrigger>
      )}
      <DialogContent className="max-h-[90vh] overflow-y-auto sm:max-w-2xl">
        <DialogHeader>
          <DialogTitle>
            {editing ? `Edit ${editing.name}` : "New WhatsApp template"}
          </DialogTitle>
          <DialogDescription>
            {editing
              ? "Meta reviews an edited template again. It stops being sendable until that comes back approved."
              : "Meta reviews every template before it can be sent. Usually under a day."}
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
                // The name and the language are what identify a template at
                // Meta, so an edit cannot change either. Locked here rather
                // than refused on save.
                disabled={Boolean(editing)}
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
              <Select
                value={languageCode}
                onValueChange={setLanguageCode}
                disabled={Boolean(editing)}
              >
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
            <div className="flex items-center justify-between">
              <Label htmlFor="tpl-body" className="text-xs">
                Message
              </Label>
              {/*
                Meta puts an "Add variable" control under its body box and the
                client asked for the same. Nobody should have to remember that
                the syntax is two braces and that the numbers must run 1, 2, 3
                with no gaps — this inserts the next one at the cursor and the
                sample box below appears for it immediately.
              */}
              <Button
                type="button"
                size="sm"
                variant="outline"
                className="h-7 px-2 text-xs"
                onClick={insertVariable}
              >
                <Plus className="mr-1 size-3" />
                Add variable
              </Button>
            </div>
            <Textarea
              id="tpl-body"
              ref={bodyRef}
              rows={4}
              value={body}
              onChange={(e) => setBody(e.target.value)}
              placeholder="Hi there, your order is ready to collect."
            />
            <p className="text-[11px] text-muted-foreground">
              {used.length
                ? `${used.length} variable${used.length === 1 ? "" : "s"} — say what fills each below. `
                : "Add a variable for anything that changes per customer, like their name. "}
              {body.length}/1024
            </p>
          </div>

          {/*
            WHAT THE SAMPLE IS FOR, AND WHERE THE REAL VALUE IS CHOSEN.

            The client wrote a template whose whole body was `{{1}}`, put
            "Priya" in the sample box, and asked: "how does the backend know
            when I'm sending that message that a customer name has to be added?
            There should be an option that you want to match this variable to
            customer's name or their gender or something like that. There is no
            such option."

            There was one, and it was on the BROADCAST — which is the right
            place for it to be overridable and the wrong place for it to be
            discovered. From this screen the sample looked like the answer, so
            the honest reading of her template was that every customer would be
            greeted as Priya.

            So both questions are asked here, in one box, in the order she
            thinks about them: what fills this normally, and what Meta's
            reviewer should see. The sample's own line says it is never sent.
          */}
          {used.length > 0 && (
            <div className="space-y-2 rounded-lg border bg-muted/30 p-3">
              <Label className="text-xs">What fills each variable</Label>
              <p className="text-[11px] text-muted-foreground">
                Meta needs a sample to review a variable and nobody is ever sent it — what each
                customer reads is what you choose here, and any broadcast can still override it.
              </p>
              <div className="space-y-2">
                {used.map((n) => {
                  const row = variableDefaults[n];
                  return (
                    <div key={n} className="space-y-1.5 rounded-md border bg-background p-2.5">
                      <div className="flex items-center gap-2">
                        <span className="w-10 shrink-0 font-mono text-xs text-muted-foreground">
                          {`{{${n}}}`}
                        </span>
                        <Select
                          value={row?.source ?? NO_DEFAULT}
                          onValueChange={(next) =>
                            next === NO_DEFAULT
                              ? patchDefault(n, null)
                              : /*
                                 * Switching to a fixed wording drops a stand-in
                                 * that no longer applies; switching away from
                                 * one offers a usable stand-in rather than
                                 * leaving the field empty and the form invalid.
                                 */
                                patchDefault(
                                  n,
                                  next === "fixed"
                                    ? { source: next, fallback: "" }
                                    : {
                                        source: next as CampaignVariableSource,
                                        text: "",
                                        fallback: row?.fallback || SUGGESTED_FALLBACK,
                                      },
                                )
                          }
                        >
                          <SelectTrigger className="h-8 text-xs">
                            <SelectValue />
                          </SelectTrigger>
                          <SelectContent>
                            <SelectItem value={NO_DEFAULT}>Decide on each broadcast</SelectItem>
                            {CAMPAIGN_VARIABLE_SOURCES.map((s) => (
                              <SelectItem key={s.value} value={s.value}>
                                {s.label}
                              </SelectItem>
                            ))}
                          </SelectContent>
                        </Select>
                      </div>
                      <div className="grid gap-2 sm:grid-cols-2">
                        {row ? (
                          <div className="space-y-1">
                            <p className="text-[11px] text-muted-foreground">
                              {row.source === "fixed"
                                ? "The wording everyone gets"
                                : "If we don't know it"}
                            </p>
                            {row.source === "fixed" ? (
                              <Input
                                className="h-8 text-xs"
                                value={row.text ?? ""}
                                placeholder="Diwali collection"
                                onChange={(e) => patchDefault(n, { text: e.target.value })}
                              />
                            ) : (
                              <Input
                                className="h-8 text-xs"
                                value={row.fallback ?? ""}
                                placeholder={SUGGESTED_FALLBACK}
                                onChange={(e) => patchDefault(n, { fallback: e.target.value })}
                              />
                            )}
                          </div>
                        ) : (
                          <p className="self-end text-[11px] text-muted-foreground">
                            Whoever sends the broadcast will be asked what goes here.
                          </p>
                        )}
                        <div className="space-y-1">
                          <p className="text-[11px] text-muted-foreground">
                            Sample for Meta&apos;s reviewer — never sent
                          </p>
                          <Input
                            className="h-8 text-xs"
                            value={examples[n - 1] ?? ""}
                            placeholder={n === 1 ? "Priya" : "Bandra"}
                            onChange={(e) => {
                              const next = [...examples];
                              next[n - 1] = e.target.value;
                              setExamples(next);
                            }}
                          />
                        </div>
                      </div>
                    </div>
                  );
                })}
              </div>
            </div>
          )}

          {/*
            HEADER AND CAROUSEL ARE TWO DIFFERENT QUESTIONS.

            They used to be one three-way choice — "Just words / One picture /
            Product cards" — which is not how Meta models it and not how the
            client thinks about it. In Meta's own editor a Header is its own
            optional section with a media type, and a carousel is a separate
            thing entirely.

            Conflating them had a real consequence: picking "One picture" and
            then "Product cards" put her photograph on a CARD, and Meta does
            crop card media ("automatically cropped to a wide ratio based on
            the WhatsApp user's device"). She reported an image being cut and
            was right about where it came from.

            A carousel genuinely cannot have a template header — Meta's rule,
            enforced in template-draft.ts buildCarousel — so the two sections
            say so to each other rather than hiding one inside the other.
          */}
          <div className="space-y-1.5">
            <Label className="text-xs">
              Header <span className="text-muted-foreground">(optional)</span>
            </Label>
            <div className="flex flex-wrap gap-2">
              {(
                [
                  ["NONE", "None"],
                  ["TEXT", "Text"],
                  ["IMAGE", "Image"],
                ] as const
              ).map(([value, label]) => (
                <Button
                  key={value}
                  type="button"
                  size="sm"
                  disabled={isCarousel}
                  variant={headerType === value ? "default" : "outline"}
                  onClick={() => setHeaderType(value)}
                >
                  {label}
                </Button>
              ))}
            </div>
            <p className="text-xs text-muted-foreground">
              {isCarousel
                ? "A carousel carries its pictures on the cards, so the message itself cannot also have a header."
                : headerType === "NONE"
                  ? "Nothing above the message."
                  : headerType === "TEXT"
                    ? "One short line above the message — usually the shop name."
                    : "One photo above the message, sent whole. Meta reviews it with the template."}
            </p>

            {headerType === "TEXT" ? (
              <Input
                value={header}
                maxLength={60}
                onChange={(e) => setHeader(e.target.value)}
                placeholder={`${TENANT_NAME} — new arrivals`}
              />
            ) : null}

            {headerType === "IMAGE" ? (
              <div className="flex items-center gap-3 rounded-lg border border-dashed p-3">
                {headerImage ? (
                  /* eslint-disable-next-line @next/next/no-img-element -- a blob: preview of a local file */
                  <img
                    src={headerImage.previewUrl}
                    alt="Above the message"
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
                  {upload.isPending ? "Uploading…" : headerImage ? "Replace photo" : "Upload photo"}
                </Button>
                <p className="text-xs text-muted-foreground">JPEG or PNG, up to 5 MB.</p>
              </div>
            ) : null}
          </div>


          {/* ── Carousel ────────────────────────────────────────────────── */}
          {/* Only when chosen: two upload buttons on screen at once is what
              made it unclear which one a photo had gone to. */}
          {/*
            The carousel, as its own question rather than a third value of the
            header's. Always visible so it can be discovered; the cards appear
            under it once it is on.
          */}
          <div className="space-y-1.5">
            <Label className="text-xs">
              Product cards <span className="text-muted-foreground">(optional)</span>
            </Label>
            <div className="flex flex-wrap gap-2">
              <Button
                type="button"
                size="sm"
                variant={isCarousel ? "outline" : "default"}
                onClick={() => setCarousel(false)}
              >
                No cards
              </Button>
              <Button
                type="button"
                size="sm"
                variant={isCarousel ? "default" : "outline"}
                onClick={() => setCarousel(true)}
              >
                Add a carousel
              </Button>
            </div>
            <p className="text-xs text-muted-foreground">
              A swipeable row under the message: 2–10 photos, each with its own
              buttons, and every card carrying the same buttons as the others.
              Meta crops card pictures to suit the reader&apos;s phone — a photo you
              need shown whole belongs in the header instead.
            </p>
          </div>

          {isCarousel ? (
          <div className="space-y-2 rounded-lg border p-3">
            <div className="flex items-center justify-between gap-3">
              <div>
                <Label className="text-xs">
                  <Images className="mr-1 inline size-3.5" />
                  Product cards ({cards.length} of 10)
                </Label>
                <p className="text-xs text-muted-foreground">
                  {cards.length < 2
                    ? `Add ${2 - cards.length} more — a carousel needs at least 2 cards.`
                    : "Each card needs a photo and at least one button, and every card must carry the same buttons."}
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
          ) : null}

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

          {/*
            Buttons. Hidden for a carousel, which puts them on each card and
            where Meta refuses both at once.

            Two is a deliberate floor rather than Meta's ceiling: its combined
            button rules vary by type and change, and two URL-or-quick-reply
            buttons sit inside every variant of them.
          */}
          {!isCarousel ? (
            <div className="space-y-2">
              <div className="flex items-center justify-between">
                <Label className="text-xs">
                  Buttons <span className="text-muted-foreground">(optional, up to 2)</span>
                </Label>
                {buttons.length < 2 ? (
                  <div className="flex gap-1.5">
                    <Button
                      type="button"
                      size="sm"
                      variant="outline"
                      onClick={() =>
                        setButtons((b) => [...b, { type: "URL", text: "", url: "" }])
                      }
                    >
                      Add link button
                    </Button>
                    <Button
                      type="button"
                      size="sm"
                      variant="outline"
                      onClick={() => setButtons((b) => [...b, { type: "QUICK_REPLY", text: "" }])}
                    >
                      Add reply button
                    </Button>
                  </div>
                ) : null}
              </div>

              {buttons.map((b, i) => (
                <div key={i} className="space-y-1.5 rounded-md border p-2.5">
                  <div className="flex items-center gap-2">
                    <Badge variant="secondary" className="text-[11px]">
                      {b.type === "URL" ? "Opens a link" : "Sends a reply"}
                    </Badge>
                    <Button
                      type="button"
                      size="sm"
                      variant="ghost"
                      className="ml-auto h-7 px-2 text-xs"
                      onClick={() => setButtons((list) => list.filter((_, j) => j !== i))}
                    >
                      Remove
                    </Button>
                  </div>
                  <Input
                    aria-label={`Button ${i + 1} label`}
                    value={b.text}
                    maxLength={25}
                    placeholder={b.type === "URL" ? "Give feedback" : "Not now"}
                    onChange={(e) =>
                      setButtons((list) =>
                        list.map((x, j) => (j === i ? { ...x, text: e.target.value } : x)),
                      )
                    }
                  />
                  {b.type === "URL" ? (
                    <Input
                      aria-label={`Button ${i + 1} link`}
                      value={b.url ?? ""}
                      placeholder="https://forms.gle/…"
                      onChange={(e) =>
                        setButtons((list) =>
                          list.map((x, j) => (j === i ? { ...x, url: e.target.value } : x)),
                        )
                      }
                    />
                  ) : null}
                </div>
              ))}
            </div>
          ) : null}

          {/*
            What the customer receives, not what was typed.

            One renderer, shared with the template detail view, so a message
            being written and the same message being reviewed afterwards
            cannot look different. It exists because a template is written
            with {{1}} and read with a name in it, and because the shape is
            easy to get wrong — somebody who can SEE their photo sitting above
            the message rather than on a card never has to wonder where it went.
          */}
          {(body.trim() || headerImage || cards.length > 0 || buttons.length > 0) && (
            <div className="space-y-1.5">
              <Label className="text-xs">What the customer sees</Label>
              <WhatsAppPreview
                headerImageUrl={headerType === "IMAGE" ? headerImage?.previewUrl ?? null : null}
                header={headerType === "TEXT" ? header : null}
                body={preview || " "}
                footer={footer}
                buttons={isCarousel ? [] : buttons.map((b) => ({ type: b.type, text: b.text }))}
                cards={cards.map((c) => ({
                  previewUrl: c.previewUrl,
                  body: c.body,
                  buttons: c.buttons.map((b) => ({ type: b.type, text: b.text })),
                }))}
              />
              {used.length > 0 ? (
                /*
                  Said under the preview because the preview is the thing that
                  misled her. It fills the variables with the samples, and the
                  panel above it is headed "What the customer sees" — so a
                  template whose body was `{{1}}` and whose sample was "Priya"
                  read, on this screen, as a message that greets every customer
                  as Priya. The samples are the only concrete values available
                  here, so they stay; the sentence that was missing is whose
                  they are.
                */
                <p className="text-[11px] text-muted-foreground">
                  Drawn with your sample values. Each customer gets their own.
                </p>
              ) : null}
              {cards.length > 1 ? (
                <p className="text-[11px] text-muted-foreground">
                  Swipe the cards sideways — that is how the customer sees them.
                </p>
              ) : null}
            </div>
          )}
        </div>

        <DialogFooter className="flex-col items-stretch gap-2 sm:flex-row sm:items-center sm:justify-between">
          <p className="text-[11px] text-muted-foreground">
            {problem ??
              (editing
                ? "Ready to send back. Meta reviews it again; it cannot be sent until it approves."
                : "Ready to submit. Meta decides; nothing is sendable until it approves.")}
          </p>
          <Button onClick={send} disabled={!!problem || pending} size="sm">
            <Send className="size-4" />
            {pending
              ? editing
                ? "Saving…"
                : "Submitting…"
              : editing
                ? "Save and send for review"
                : "Submit for review"}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}
