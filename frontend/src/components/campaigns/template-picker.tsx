"use client";

import { useMemo } from "react";
import Link from "next/link";
import { AlertCircle, Check, MessageSquareText } from "lucide-react";

import { Badge } from "@/components/ui/badge";
import { Label } from "@/components/ui/label";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";
import { Skeleton } from "@/components/ui/skeleton";
import {
  isTemplateSendable,
  useMessageTemplates,
  type MessageTemplateRow,
  type TemplateVariableDefault,
} from "@/lib/queries/meta-admin";
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
 *
 * ## Two sizes, because the two screens are deciding different things
 *
 * The broadcast composer (`cards`, the default) is choosing what goes to
 * several thousand people in one press, and the wording of every candidate
 * earns its space there: the card list IS the sign-off surface.
 *
 * Feedback Requests is not that. It sets two automations up once and then edits
 * a delay or a time of day, and the same card list took over the whole screen —
 * the client: "i wanted a dropdown picker in a dialog box where we used to
 * manually write names ... not too much enlarged". So `compact` draws one
 * dropdown the size of the two text boxes it replaced, and the wording of the
 * ONE chosen template underneath it, rather than five bodies she did not ask
 * to read. One bubble instead of five, still verbatim, still on screen at the
 * moment she presses Save.
 */
export interface PickedTemplate {
  name: string;
  languageCode: string;
  /** The approved wording, as a customer reads it. Sent to the approver verbatim. */
  preview: string;
  /**
   * How many `{{n}}` the template carries, from Meta's own record of it.
   *
   * Carried out of the picker because the wizard has to ask what fills each
   * one. A broadcast used to send no values at all, so an approved template
   * with a single variable was refused on every recipient.
   */
  variableCount: number;
  /**
   * What the TEMPLATE says normally fills each variable, when its author said so.
   *
   * Carried through so the wizard can pre-select it instead of assuming the
   * first name for every slot. Empty for a template whose author left the
   * choice to each broadcast, which is the default and keeps today's behaviour.
   */
  variableDefaults: TemplateVariableDefault[];
  /** The wording with its placeholders intact, for showing the mapping against. */
  source: string;
}

/** A template's name and language, as the dropdown identifies one option. */
function templateName(row: MessageTemplateRow): string {
  return row.name ?? row.externalId;
}

/**
 * One option's value in the dropdown.
 *
 * Keyed on name AND language, never on name alone: `order_update` is approved
 * in en_US and hi_IN independently, and the send needs both halves. `::` cannot
 * collide — Meta template names are lowercase letters, digits and underscores.
 */
export function templateOptionKey(name: string, languageCode: string): string {
  return `${name}::${languageCode}`;
}

/**
 * Nothing chosen. A sentinel because a Radix `SelectItem` may not carry an
 * empty value, and the same `__all__` trick the catalogue filters use.
 */
const NO_TEMPLATE = "__none__";

/**
 * WHAT HAPPENED TO THE TEMPLATE THIS SETTING WAS SAVED WITH.
 *
 * The dropdown offers only sendable templates, so a saved name that has since
 * been paused by Meta — or that was typed by hand before this list existed —
 * matches no option and leaves the control showing its placeholder. That is the
 * one failure this screen must never be quiet about: an automation configured
 * months ago, a template Meta paused for quality last week, and a settings
 * screen that looks merely un-filled-in. The person reading it has no reason
 * to think anything is wrong, and the customer simply never gets asked.
 *
 * So the state is named, and the remedies differ: `withdrawn` may come back
 * with a synchronise, `unrecognised` has to be replaced.
 */
export type SavedTemplateState =
  | { kind: "empty" }
  | { kind: "offered" }
  | { kind: "withdrawn"; label: string }
  | { kind: "unrecognised"; label: string };

export function savedTemplateState(
  saved: { name: string; languageCode: string } | null,
  all: MessageTemplateRow[],
): SavedTemplateState {
  const name = saved?.name.trim();
  if (!name) return { kind: "empty" };
  const languageCode = saved?.languageCode.trim() ?? "";
  const label = languageCode ? `${name} (${languageCode})` : name;

  const byName = all.filter((row) => templateName(row) === name);
  const offered = byName.some(
    (row) => row.metadata.languageCode === languageCode && isTemplateSendable(row),
  );
  if (offered) return { kind: "offered" };
  /*
   * Matched by name but not offered covers two causes with one remedy: the
   * approval lapsed or was paused, or the language saved here is not the
   * language it is approved in. Both are "synchronise and look at it", and
   * both send nothing today.
   */
  return byName.length ? { kind: "withdrawn", label } : { kind: "unrecognised", label };
}

/**
 * WHY THIS TEMPLATE CANNOT GO OUT RIGHT NOW, IN META'S OWN WORDS.
 *
 * Null for a template that can be sent, so this is the mirror of
 * `isTemplateSendable` rather than a second opinion about it — the verdict
 * itself stays in one place and this only explains the no.
 *
 * 28 Nov: the client edited `newmessage` at Meta, which takes an approved
 * template back to PENDING for re-review, and then went to the thread to send
 * it. Every picker lists only what `isTemplateSendable` allows and said nothing
 * about the rest, so the template she had just saved had simply vanished from
 * the list — and the one sentence that explained it was on the asset, on a
 * settings screen she had no reason to open. A withheld template with no reason
 * beside it costs as much as an unsendable one offered: both end with somebody
 * pressing things and waiting.
 *
 * `lastError` first because it is the provider's sentence about THIS template
 * ("Edited at Meta; awaiting review. Provider reports PENDING."), written by
 * whichever call last heard from Meta. The branches after it are for the states
 * we can see for ourselves when Meta has said nothing — they mirror the
 * server's own `templateSendability` codes, in the order it checks them.
 */
export function templateUnsendableReason(row: MessageTemplateRow): string | null {
  if (isTemplateSendable(row)) return null;
  const stated = row.lastError?.trim();
  if (stated) return stated;
  if (!row.isActive) return "Switched off for this connection.";
  if (!row.lastVerifiedAt) {
    return "Never confirmed with Meta. Synchronise templates to check it.";
  }
  if (row.metadata.providerStatus !== "APPROVED") {
    return `Meta reports this template as ${row.metadata.providerStatus
      .toLowerCase()
      .replace(/_/g, " ")}.`;
  }
  // Nothing left: approved, active, and the verdict is older than a day.
  return "Meta's approval for this is more than a day old. Synchronise templates to confirm it.";
}

/**
 * Everything the broadcast wizard needs out of one approved template.
 *
 * Exported for its test rather than for another screen: `source` is the one
 * field a send substitutes into, and taking it from `bodyPreview` instead of
 * `bodySource` would show a sender Meta's sample name where the customer's
 * belongs — which is the same confusion as 28 Nov, read backwards.
 */
export function pickOf(row: MessageTemplateRow): PickedTemplate {
  return {
    name: templateName(row),
    languageCode: row.metadata.languageCode,
    preview: row.metadata.bodyPreview?.trim() ?? "",
    variableCount: row.metadata.variables?.length ?? 0,
    variableDefaults: row.metadata.variableDefaults ?? [],
    source: row.metadata.bodySource ?? "",
  };
}

export function TemplatePicker({
  value,
  onChange,
  variant = "cards",
  id,
  label = "WhatsApp template",
  noneLabel,
}: {
  value: { name: string; languageCode: string } | null;
  onChange: (picked: PickedTemplate | null) => void;
  /**
   * `cards` is the broadcast composer's full list with every body rendered;
   * `compact` is one dropdown plus the chosen wording. See the note above.
   */
  variant?: "cards" | "compact";
  /** `compact` only: ties the caller's own label text to the dropdown. */
  id?: string;
  /** `compact` only: the field's label, which it draws itself so it lines up
   * with the inputs beside it. */
  label?: string;
  /**
   * `compact` only: offer "no template at all" under this wording.
   *
   * Omitted means the field cannot be cleared. Feedback Requests needs it —
   * a blank first template is a real setting there, and means a colleague asks
   * the customer in person instead.
   */
  noneLabel?: string;
}) {
  const templates = useMessageTemplates();

  const sendable = useMemo(
    () => (templates.data ?? []).filter(isTemplateSendable),
    [templates.data],
  );
  /*
   * The rest, kept rather than discarded. See `templateUnsendableReason`: a
   * template that is on file and cannot go out today is a fact a manager needs,
   * and dropping it here is what made an edited template look deleted.
   */
  const held = useMemo(
    () => (templates.data ?? []).filter((row) => !isTemplateSendable(row)),
    [templates.data],
  );

  if (variant === "compact") {
    return (
      <CompactTemplatePicker
        value={value}
        onChange={onChange}
        id={id}
        label={label}
        noneLabel={noneLabel}
        all={templates.data ?? []}
        sendable={sendable}
        held={held}
        isLoading={templates.isLoading}
      />
    );
  }

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
      <div className="space-y-2">
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
        {/* Not an empty list: every one of them, and Meta's reason for each. */}
        <HeldTemplates rows={held} />
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
              onClick={() => onChange(chosen ? null : pickOf(row))}
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
      <HeldTemplates rows={held} />
    </div>
  );
}

/**
 * TEMPLATES ON FILE THAT CANNOT GO OUT TODAY, AND WHY NOT.
 *
 * Shown, not hidden, and not clickable. The choice is deliberate: hiding them
 * kept the list honest about what can be sent but left a manager hunting for a
 * template that had not gone anywhere (28 Nov — see
 * `templateUnsendableReason`), while offering them for selection would end in a
 * filled-in dialog, a press, and a refusal at the provider minutes later.
 * Disabled with the reason beside it is the only version that answers her
 * question at the moment she asks it.
 *
 * No green bubble here, unlike the cards above: the wording of a template Meta
 * has not approved is not something anybody should be signing off on. A name,
 * its language, and the reason.
 */
function HeldTemplates({ rows }: { rows: MessageTemplateRow[] }) {
  if (!rows.length) return null;
  return (
    <div className="space-y-1.5 rounded-lg border border-dashed p-3">
      <p className="text-xs font-medium">
        {rows.length === 1
          ? "1 template is on file and cannot be sent today"
          : `${rows.length} templates are on file and cannot be sent today`}
      </p>
      <ul className="space-y-1.5">
        {rows.map((row) => (
          <li key={row.id} className="flex flex-wrap items-baseline gap-x-2 gap-y-1 text-xs">
            <span className="font-medium text-muted-foreground">{templateName(row)}</span>
            <Badge variant="outline" className="text-[10px]">
              {row.metadata.languageCode}
            </Badge>
            <span className="text-muted-foreground">{templateUnsendableReason(row)}</span>
          </li>
        ))}
      </ul>
      <Link
        href="/settings/integrations/templates"
        className="inline-block pt-0.5 text-xs font-medium text-primary hover:underline"
      >
        Synchronise with Meta →
      </Link>
    </div>
  );
}

/**
 * ONE DROPDOWN, AND THE WORDING OF THE ONE TEMPLATE IT HAS CHOSEN.
 *
 * ## Why the preview sits under the dropdown and not in the list
 *
 * Three places could carry it, and two of them fail the person using it. In
 * the list, every option grows to the height of a message and we are back to
 * the wall of green bubbles she asked us to take away. On hover, it is absent
 * on the tablets the branches use and absent to the keyboard.
 *
 * Under the dropdown, it costs one bubble no matter how many templates exist,
 * it is the wording of the template this setting will actually send, and it is
 * still on the screen at the moment Save is pressed — which is the moment
 * somebody is signing off on what a customer receives.
 */
function CompactTemplatePicker({
  value,
  onChange,
  id,
  label,
  noneLabel,
  all,
  sendable,
  held,
  isLoading,
}: {
  value: { name: string; languageCode: string } | null;
  onChange: (picked: PickedTemplate | null) => void;
  id?: string;
  label: string;
  noneLabel?: string;
  all: MessageTemplateRow[];
  sendable: MessageTemplateRow[];
  held: MessageTemplateRow[];
  isLoading: boolean;
}) {
  const saved = savedTemplateState(value, all);
  const chosen =
    saved.kind === "offered"
      ? sendable.find(
          (row) =>
            templateName(row) === value?.name &&
            row.metadata.languageCode === value?.languageCode,
        )
      : undefined;
  const preview = chosen?.metadata.bodyPreview?.trim();
  /*
   * A blank setting is drawn as the "none" option SELECTED, not as an empty
   * box, wherever the caller has said blank means something. On Feedback
   * Requests it means "a colleague asks instead", and a placeholder reading
   * "Choose an approved template" would make a deliberate decision look like
   * an unfinished form every time the screen is opened.
   */
  const selected =
    saved.kind === "offered" && value
      ? templateOptionKey(value.name, value.languageCode)
      : saved.kind === "empty" && noneLabel
        ? NO_TEMPLATE
        : "";

  return (
    <div className="grid min-w-[15rem] flex-1 gap-1.5">
      <Label htmlFor={id}>{label}</Label>
      {isLoading ? (
        <Skeleton className="h-9 w-full rounded-md" />
      ) : (
        <Select
          value={selected}
          onValueChange={(key) => {
            if (key === NO_TEMPLATE) return onChange(null);
            const row = sendable.find(
              (r) => templateOptionKey(templateName(r), r.metadata.languageCode) === key,
            );
            onChange(row ? pickOf(row) : null);
          }}
          /*
           * Disabled only when there is genuinely nothing to choose. With
           * nothing approved but "a colleague asks instead" on offer, that
           * option IS the remedy for a template Meta has paused — locking the
           * control would leave the only way out of a dead setting closed.
           */
          disabled={!sendable.length && !noneLabel}
        >
          <SelectTrigger id={id} className="h-9">
            <SelectValue
              placeholder={
                sendable.length ? "Choose an approved template" : "No approved template yet"
              }
            />
          </SelectTrigger>
          <SelectContent>
            {noneLabel ? <SelectItem value={NO_TEMPLATE}>{noneLabel}</SelectItem> : null}
            {sendable.map((row) => {
              const name = templateName(row);
              const language = row.metadata.languageCode;
              return (
                <SelectItem key={row.id} value={templateOptionKey(name, language)}>
                  <span className="font-medium">{name}</span>
                  <span className="ml-2 text-xs text-muted-foreground">{language}</span>
                </SelectItem>
              );
            })}
            {/*
              The rest, named and disabled, each with Meta's reason.

              This used to be a count — "3 other templates are on file but not
              approved to send today" — which kept the list short but named
              none of them, and naming them is the part that was needed: on
              28 Nov the template the client was looking for was one of the
              ones the count was describing. A disabled row is still one line,
              so the dropdown stays the size the client asked for ("not too
              much enlarged"); what it is not is silent.
            */}
            {held.map((row) => (
              <SelectItem
                key={row.id}
                value={templateOptionKey(templateName(row), row.metadata.languageCode)}
                disabled
              >
                <span className="font-medium">{templateName(row)}</span>
                <span className="ml-2 text-xs text-muted-foreground">
                  {templateUnsendableReason(row)}
                </span>
              </SelectItem>
            ))}
          </SelectContent>
        </Select>
      )}

      {/*
        The empty list has two very different causes and the difference decides
        what to do next: nothing has ever been written, or something was written
        and Meta has not approved it. Both roads lead to the same screen, so the
        line names which one it is rather than leaving somebody to find out.
      */}
      {!isLoading && !sendable.length ? (
        <p className="flex flex-wrap items-center gap-1 text-xs text-muted-foreground">
          <AlertCircle className="size-3 shrink-0" />
          {all.length
            ? `${all.length} ${all.length === 1 ? "template is" : "templates are"} recorded, none approved by Meta in the last day.`
            : "WhatsApp only allows an approved template for a message a customer did not ask for."}
          <Link
            href="/settings/integrations/templates"
            className="font-medium text-primary hover:underline"
          >
            {all.length ? "Synchronise with Meta" : "Write one and submit it"} →
          </Link>
        </p>
      ) : null}

      {saved.kind === "withdrawn" || saved.kind === "unrecognised" ? (
        <p className="flex flex-wrap items-center gap-1 text-xs text-destructive">
          <AlertCircle className="size-3 shrink-0" />
          {saved.kind === "withdrawn"
            ? `Saved as ${saved.label}, which Meta does not have approved and ready to send today — so nothing goes out until you pick one that is.`
            : `Saved as ${saved.label}, which is not a template on file for this account — it was typed in before this list existed.`}
          {saved.kind === "withdrawn" ? (
            <Link
              href="/settings/integrations/templates"
              className="font-medium text-primary hover:underline"
            >
              Synchronise with Meta →
            </Link>
          ) : null}
        </p>
      ) : null}

      {chosen ? (
        preview ? (
          <p className="max-w-prose whitespace-pre-line rounded-lg rounded-tl-sm bg-[#d9fdd3] p-2 text-[12px] leading-relaxed text-[#111b21] dark:bg-[#005c4b] dark:text-[#e9edef]">
            {preview}
          </p>
        ) : (
          <p className="flex items-center gap-1.5 text-xs text-muted-foreground">
            <MessageSquareText className="size-3 shrink-0" />
            Approved, but its wording was never recorded here. Synchronise to fetch it.
          </p>
        )
      ) : null}
    </div>
  );
}
