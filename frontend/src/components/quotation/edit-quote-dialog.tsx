"use client";

import { useState } from "react";
import { Trash2, X } from "lucide-react";
import { toast } from "sonner";

import { Button } from "@/components/ui/button";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Separator } from "@/components/ui/separator";
import { formatINR, formatPercent } from "@/lib/format";
import { GST_RATE, type Quote, type QuoteLine } from "@/lib/mock/quotation";
import { num, pct, round2 } from "@/components/quotation/quote-item-editor";
import { useUpdateQuote } from "@/lib/queries/quotes";
import { apiErrorMessage } from "@/lib/utils";

/**
 * The client's 10 Oct ask: a saved quote had no way to change its items — only
 * the bill-to/payments edit existed. This edits the PRICE: weights, rates,
 * making, each stone and every discount, over the lines exactly as they were
 * stored. It PATCHes /quotes/:id, which re-prices on the server, bumps the
 * revision and withdraws any manager approval (the gate must judge the new
 * price). The full builder is not reused here: its state is keyed to the
 * materials master (item-type and metal codes), which a stored line no longer
 * carries losslessly — adding a brand-new item still means raising a new quote.
 */

interface EditStone {
  type: "D" | "C";
  code: string;
  name?: string;
  size?: string;
  pieces?: number;
  /** Pre-30 Sep 2026 staff lever — preserved verbatim or the amount would change. */
  multiplier?: number;
  carats: string;
  ratePerCt: string;
  discount: string;
}

/** How a line's stones were stored — mirrored so the server re-prices the same way. */
type StoneMode = "stones" | "perCarat" | "flat";

interface EditLine {
  /** Original line id — only a stable React key; the server rewrites all lines. */
  key: string;
  description: string;
  karat: number;
  styleNumber?: string;
  size?: string;
  metalCode?: string;
  weight: string;
  goldRate: string;
  /** Lines priced by a flat making ₹ (repairs, older quotes) vs ₹/g x weight. */
  flatMaking: boolean;
  makingRate: string;
  makingCharges: string;
  metalDiscount: string;
  makingDiscount: string;
  stoneMode: StoneMode;
  stones: EditStone[];
  carats: string;
  perCaratRate: string;
  stoneCharges: string;
  /** Display-only carat weight for a flat-priced line; echoed back unchanged. */
  caratWeight: number;
  remark: string;
}

function toEditLine(l: QuoteLine): EditLine {
  const stones = l.stones ?? [];
  const stoneMode: StoneMode = stones.length
    ? "stones"
    : l.perCaratRate != null && l.perCaratRate > 0
      ? "perCarat"
      : "flat";
  return {
    key: l.id,
    description: l.description,
    karat: l.karat,
    styleNumber: l.styleNumber ?? undefined,
    size: l.size ?? undefined,
    metalCode: l.metalCode ?? undefined,
    weight: l.weightGrams > 0 ? String(l.weightGrams) : "",
    goldRate: l.goldRatePerGram > 0 ? String(l.goldRatePerGram) : "",
    flatMaking: l.makingRatePerGram == null,
    makingRate: l.makingRatePerGram != null ? String(l.makingRatePerGram) : "",
    makingCharges: l.makingCharges > 0 ? String(l.makingCharges) : "",
    // Blank means "no % of its own": the quote-level % keeps applying, the way
    // quotes made before per-line discounts stored theirs.
    metalDiscount: l.metalDiscountPercent != null ? String(l.metalDiscountPercent) : "",
    makingDiscount: l.makingDiscountPercent != null ? String(l.makingDiscountPercent) : "",
    stoneMode,
    stones: stones.map((s) => ({
      type: s.type,
      code: s.code,
      name: s.name,
      size: s.size,
      pieces: s.pieces,
      multiplier: s.multiplier,
      carats: String(s.carats),
      ratePerCt: String(s.ratePerCt),
      discount: s.discountPercent != null ? String(s.discountPercent) : "",
    })),
    carats: stoneMode === "perCarat" ? String(l.caratWeight) : "",
    perCaratRate: l.perCaratRate != null ? String(l.perCaratRate) : "",
    stoneCharges: stoneMode === "flat" && l.stoneCharges > 0 ? String(l.stoneCharges) : "",
    caratWeight: l.caratWeight,
    remark: l.remark ?? "",
  };
}

/** carats x rate x multiplier, before the stone's own discount — the server's amount. */
const stoneAmount = (st: EditStone) =>
  round2((num(st.carats) ?? 0) * (num(st.ratePerCt) ?? 0) * (st.multiplier ?? 1));

interface EditQuoteDialogProps {
  quote: Quote;
  open: boolean;
  onOpenChange: (open: boolean) => void;
}

export function EditQuoteDialog({ quote, open, onOpenChange }: EditQuoteDialogProps) {
  const updateQuote = useUpdateQuote();
  const repair = quote.kind === "repair";
  const [lines, setLines] = useState<EditLine[]>(() => quote.lines.map(toEditLine));
  // A repair's making discount lives on the quote, not the line (as the builder
  // saves it); a sale's discounts are per line, per stone.
  const [makingDiscount, setMakingDiscount] = useState(() =>
    repair && quote.makingDiscountPercent ? String(quote.makingDiscountPercent) : "",
  );
  const [additionalDiscount, setAdditionalDiscount] = useState(() =>
    quote.additionalDiscount ? String(quote.additionalDiscount) : "",
  );

  const patchLine = (i: number, patch: Partial<EditLine>) =>
    setLines((list) => list.map((l, j) => (j === i ? { ...l, ...patch } : l)));
  const patchStone = (i: number, j: number, patch: Partial<EditStone>) =>
    setLines((list) =>
      list.map((l, k) =>
        k === i
          ? { ...l, stones: l.stones.map((s, m) => (m === j ? { ...s, ...patch } : s)) }
          : l,
      ),
    );

  // Quote-level fallbacks a line without its own % takes — kept as stored for a
  // sale (this dialog does not resend them, so the server keeps them too).
  const quoteMaking = repair ? pct(makingDiscount) : quote.makingDiscountPercent ?? 0;
  const quoteStone = repair ? 0 : quote.stoneDiscountPercent ?? 0;

  /** One line's money, exactly as the server's linePrice works it out. */
  function priceLine(l: EditLine) {
    const weight = num(l.weight) ?? 0;
    const metal = repair ? 0 : weight * (num(l.goldRate) ?? 0);
    const making = l.flatMaking
      ? num(l.makingCharges) ?? 0
      : round2((num(l.makingRate) ?? 0) * weight);
    const stones = repair
      ? 0
      : l.stoneMode === "stones"
        ? round2(l.stones.reduce((s, st) => s + stoneAmount(st), 0))
        : l.stoneMode === "perCarat"
          ? (num(l.perCaratRate) ?? 0) * (num(l.carats) ?? 0)
          : num(l.stoneCharges) ?? 0;
    return { metal, making, stones };
  }

  // Live totals, mirroring the server rollup (discounts before GST; kaccha has
  // no GST; the bill is settled in whole rupees).
  const preview = (() => {
    let metal = 0;
    let making = 0;
    let stones = 0;
    let metalOff = 0;
    let makingOff = 0;
    let stoneOff = 0;
    for (const l of lines) {
      const p = priceLine(l);
      metal += p.metal;
      making += p.making;
      stones += p.stones;
      makingOff +=
        (p.making * (l.makingDiscount.trim() !== "" ? pct(l.makingDiscount) : quoteMaking)) / 100;
      if (!repair) {
        metalOff += (p.metal * pct(l.metalDiscount)) / 100;
        stoneOff +=
          l.stoneMode === "stones"
            ? l.stones.reduce(
                (s, st) =>
                  s +
                  (stoneAmount(st) * (st.discount.trim() !== "" ? pct(st.discount) : quoteStone)) /
                    100,
                0,
              )
            : (p.stones * quoteStone) / 100;
      }
    }
    const additional = Math.max(num(additionalDiscount) ?? 0, 0);
    const discount = round2(metalOff + makingOff + stoneOff + additional);
    const taxable = metal + making + stones - discount;
    const gst = quote.isKaccha ? 0 : taxable * GST_RATE;
    return {
      metal,
      making,
      stones,
      metalOff: round2(metalOff),
      makingOff: round2(makingOff),
      stoneOff: round2(stoneOff),
      additional,
      // The flat amount may not reach into the gold — the server refuses it.
      overDiscount: additional > round2(making + stones - makingOff - stoneOff) + 0.001,
      taxable,
      gst,
      grand: Math.round(taxable + gst),
    };
  })();

  /** The full replacement lines array the PATCH body carries. */
  function payloadLines(): Omit<QuoteLine, "id">[] {
    return lines.map((l) => {
      const p = priceLine(l);
      const base = {
        description: l.description.trim(),
        karat: l.karat,
        weightGrams: num(l.weight) ?? 0,
        goldRatePerGram: num(l.goldRate) ?? 0,
        makingCharges: p.making,
        ...(l.flatMaking ? {} : { makingRatePerGram: num(l.makingRate) ?? 0 }),
        styleNumber: l.styleNumber,
        size: l.size,
        metalCode: l.metalCode,
        metalDiscountPercent: l.metalDiscount.trim() === "" ? undefined : pct(l.metalDiscount),
        makingDiscountPercent: l.makingDiscount.trim() === "" ? undefined : pct(l.makingDiscount),
        remark: l.remark.trim() || undefined,
      };
      if (l.stoneMode === "stones" && l.stones.length) {
        return {
          ...base,
          stoneCharges: p.stones,
          caratWeight: round2(l.stones.reduce((s, st) => s + (num(st.carats) ?? 0), 0)),
          stones: l.stones.map((st) => ({
            type: st.type,
            code: st.code,
            ...(st.name ? { name: st.name } : {}),
            ...(st.size ? { size: st.size } : {}),
            ...(st.pieces != null ? { pieces: st.pieces } : {}),
            ...(st.multiplier != null ? { multiplier: st.multiplier } : {}),
            carats: num(st.carats) ?? 0,
            ratePerCt: num(st.ratePerCt) ?? 0,
            ...(st.discount.trim() !== "" ? { discountPercent: pct(st.discount) } : {}),
          })),
        };
      }
      if (l.stoneMode === "perCarat") {
        return {
          ...base,
          stoneCharges: p.stones,
          caratWeight: num(l.carats) ?? 0,
          perCaratRate: num(l.perCaratRate) ?? 0,
        };
      }
      // A "stones" line whose every stone was removed falls through to here:
      // its carat weight is gone with them, not echoed from before.
      return {
        ...base,
        stoneCharges: p.stones,
        caratWeight: l.stoneMode === "stones" ? 0 : l.caratWeight,
      };
    });
  }

  function onSave() {
    for (const [i, l] of lines.entries()) {
      const d = l.description.trim();
      // Mirrors the backend's IsRealName: a description that is only digits,
      // spaces or symbols would be refused — say so next to the field count.
      if (!d || !/[^\d\s]/.test(d)) {
        toast.error(`Item ${i + 1} needs a description (letters, not just numbers).`);
        return;
      }
    }
    if (preview.overDiscount) {
      toast.error("The additional discount is more than the making and diamonds that are left.");
      return;
    }
    const prevStatus = quote.status;
    updateQuote.mutate(
      {
        id: quote.id,
        lines: payloadLines(),
        additionalDiscount: preview.additional,
        ...(repair ? { makingDiscountPercent: pct(makingDiscount) } : {}),
      },
      {
        onSuccess: (updated) => {
          // The server resets an approved / awaiting quote to draft — the
          // returned status is how it says the approval was withdrawn.
          const withdrawn =
            (prevStatus === "approved" || prevStatus === "pending_approval") &&
            updated.status === "draft";
          toast.success(`Quote ${updated.ref} updated — now revision ${updated.revision}`, {
            description: withdrawn
              ? prevStatus === "approved"
                ? "The manager approval was withdrawn: the new price must be approved again before it can be sent."
                : "The pending approval request was withdrawn: request approval again for the new price."
              : `New total ${formatINR(updated.totals?.grandTotal ?? preview.grand)}.`,
            duration: withdrawn ? 8000 : undefined,
          });
          onOpenChange(false);
        },
        onError: (e) => toast.error(apiErrorMessage(e, "Could not save the quote. Please try again.")),
      },
    );
  }

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="max-h-[88vh] overflow-y-auto sm:max-w-xl">
        <DialogHeader>
          <DialogTitle>Edit {quote.ref}</DialogTitle>
          <DialogDescription>
            Change the weights, rates and discounts. Saving re-prices the quote and
            bumps it to revision {(quote.revision ?? 1) + 1}.
          </DialogDescription>
        </DialogHeader>

        {quote.status === "approved" || quote.status === "pending_approval" ? (
          <p className="rounded-lg border bg-muted/30 p-2.5 text-xs text-muted-foreground">
            {quote.status === "approved"
              ? "This quote is approved. Saving a new price withdraws that approval — a manager must approve it again."
              : "This quote is awaiting approval. Saving a new price withdraws the request — ask again afterwards."}
          </p>
        ) : null}

        <div className="space-y-3">
          {lines.map((l, i) => (
            <div key={l.key} className="rounded-lg border p-3">
              <div className="flex items-end gap-2">
                <div className="grid flex-1 gap-1.5">
                  <Label htmlFor={`eq-${i}-desc`}>
                    Item {i + 1}
                    {l.metalCode ? ` · ${l.metalCode}` : l.karat > 0 ? ` · ${l.karat}K` : ""}
                    {l.styleNumber ? ` · Style ${l.styleNumber}` : ""}
                  </Label>
                  <Input
                    id={`eq-${i}-desc`}
                    value={l.description}
                    maxLength={200}
                    onChange={(e) => patchLine(i, { description: e.target.value })}
                  />
                </div>
                {lines.length > 1 ? (
                  <Button
                    type="button"
                    variant="ghost"
                    size="icon"
                    className="shrink-0 text-destructive hover:text-destructive"
                    title="Remove this item from the quote"
                    onClick={() => setLines((list) => list.filter((_, j) => j !== i))}
                  >
                    <Trash2 className="h-4 w-4" />
                    <span className="sr-only">Remove item {i + 1}</span>
                  </Button>
                ) : null}
              </div>

              {l.karat > 0 ? (
                <div className="mt-3 grid grid-cols-3 gap-3">
                  <NumField
                    id={`eq-${i}-w`}
                    label="Weight (g)"
                    value={l.weight}
                    onChange={(v) => patchLine(i, { weight: v })}
                  />
                  <NumField
                    id={`eq-${i}-rate`}
                    label="Gold rate (₹/g)"
                    value={l.goldRate}
                    onChange={(v) => patchLine(i, { goldRate: v })}
                  />
                  <NumField
                    id={`eq-${i}-mdisc`}
                    label="Gold discount %"
                    value={l.metalDiscount}
                    onChange={(v) => patchLine(i, { metalDiscount: v })}
                  />
                </div>
              ) : null}

              <div className="mt-3 grid grid-cols-3 gap-3">
                {l.flatMaking ? (
                  <NumField
                    id={`eq-${i}-mk`}
                    label={repair ? "Making / labour (₹)" : "Making (₹)"}
                    value={l.makingCharges}
                    onChange={(v) => patchLine(i, { makingCharges: v })}
                  />
                ) : (
                  <NumField
                    id={`eq-${i}-mkr`}
                    label="Making (₹/g)"
                    value={l.makingRate}
                    onChange={(v) => patchLine(i, { makingRate: v })}
                  />
                )}
                {!repair ? (
                  <NumField
                    id={`eq-${i}-mkdisc`}
                    label="Making discount %"
                    value={l.makingDiscount}
                    onChange={(v) => patchLine(i, { makingDiscount: v })}
                  />
                ) : null}
              </div>

              {!repair && l.stoneMode === "stones" && l.stones.length > 0 ? (
                <div className="mt-3 space-y-2">
                  {l.stones.map((st, j) => (
                    <div key={`${st.code}-${j}`} className="flex items-end gap-2">
                      <p className="w-28 shrink-0 pb-2.5 text-xs text-muted-foreground">
                        <span className="font-mono">{st.type}</span> {st.code}
                        {st.size ? ` · ${st.size}` : ""}
                        {st.pieces ? ` · ${st.pieces} pc` : ""}
                        {st.multiplier && st.multiplier !== 1 ? ` · ×${st.multiplier}` : ""}
                      </p>
                      <NumField
                        id={`eq-${i}-s${j}-ct`}
                        label="Carats"
                        className="flex-1"
                        value={st.carats}
                        onChange={(v) => patchStone(i, j, { carats: v })}
                      />
                      <NumField
                        id={`eq-${i}-s${j}-rate`}
                        label="Rate (₹/ct)"
                        className="flex-1"
                        value={st.ratePerCt}
                        onChange={(v) => patchStone(i, j, { ratePerCt: v })}
                      />
                      <NumField
                        id={`eq-${i}-s${j}-disc`}
                        label="Less %"
                        className="flex-1"
                        value={st.discount}
                        onChange={(v) => patchStone(i, j, { discount: v })}
                      />
                      <Button
                        type="button"
                        variant="ghost"
                        size="icon"
                        className="shrink-0"
                        title="Remove this stone"
                        onClick={() =>
                          patchLine(i, { stones: l.stones.filter((_, m) => m !== j) })
                        }
                      >
                        <X className="h-4 w-4" />
                        <span className="sr-only">Remove stone {st.code}</span>
                      </Button>
                    </div>
                  ))}
                </div>
              ) : null}

              {!repair && l.stoneMode === "perCarat" ? (
                <div className="mt-3 grid grid-cols-3 gap-3">
                  <NumField
                    id={`eq-${i}-ct`}
                    label="Stone carats"
                    value={l.carats}
                    onChange={(v) => patchLine(i, { carats: v })}
                  />
                  <NumField
                    id={`eq-${i}-pcr`}
                    label="Rate (₹/ct)"
                    value={l.perCaratRate}
                    onChange={(v) => patchLine(i, { perCaratRate: v })}
                  />
                </div>
              ) : null}

              {!repair && l.stoneMode === "flat" ? (
                <div className="mt-3 grid grid-cols-3 gap-3">
                  <NumField
                    id={`eq-${i}-st`}
                    label="Diamonds / stones (₹)"
                    value={l.stoneCharges}
                    onChange={(v) => patchLine(i, { stoneCharges: v })}
                  />
                </div>
              ) : null}

              <div className="mt-3 grid gap-1.5">
                <Label htmlFor={`eq-${i}-remark`}>Remark</Label>
                <Input
                  id={`eq-${i}-remark`}
                  value={l.remark}
                  maxLength={500}
                  placeholder="Free text about this item"
                  onChange={(e) => patchLine(i, { remark: e.target.value })}
                />
              </div>
            </div>
          ))}
        </div>

        <div className="grid max-w-md grid-cols-2 gap-3">
          {repair ? (
            <NumField
              id="eq-disc-making"
              label="Making discount %"
              value={makingDiscount}
              onChange={setMakingDiscount}
            />
          ) : null}
          <NumField
            id="eq-disc-extra"
            label="Additional discount (₹)"
            value={additionalDiscount}
            onChange={setAdditionalDiscount}
            invalid={preview.overDiscount}
          />
        </div>

        {/* Live totals, the same formula the server settles the bill with. */}
        <div className="rounded-lg bg-muted/50 p-3">
          <dl className="space-y-1 text-sm">
            {!repair ? (
              <>
                <PreviewRow label="Metal value" value={preview.metal} />
                <PreviewRow label="Making charges" value={preview.making} />
                <PreviewRow label="Diamonds & stones" value={preview.stones} />
              </>
            ) : (
              <PreviewRow label="Making / labour" value={preview.making} />
            )}
            {preview.metalOff > 0 ? <PreviewRow label="Gold discount" value={-preview.metalOff} /> : null}
            {preview.makingOff > 0 ? <PreviewRow label="Making discount" value={-preview.makingOff} /> : null}
            {preview.stoneOff > 0 ? <PreviewRow label="Diamond discount" value={-preview.stoneOff} /> : null}
            {preview.additional > 0 ? (
              <PreviewRow label="Additional discount" value={-preview.additional} />
            ) : null}
            <Separator className="my-1" />
            <PreviewRow label="Taxable value" value={preview.taxable} />
            <PreviewRow
              label={
                quote.isKaccha
                  ? "GST (kaccha — none)"
                  : `GST @ ${formatPercent(GST_RATE * 100, 0)}`
              }
              value={preview.gst}
            />
            <Separator className="my-1" />
            <PreviewRow label="Grand total" value={preview.grand} bold />
          </dl>
        </div>

        <DialogFooter className="gap-2">
          <Button variant="outline" disabled={updateQuote.isPending} onClick={() => onOpenChange(false)}>
            Cancel
          </Button>
          <Button disabled={updateQuote.isPending} onClick={onSave}>
            {updateQuote.isPending ? "Saving…" : "Save changes"}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}

function NumField({
  id,
  label,
  value,
  onChange,
  invalid,
  className,
}: {
  id: string;
  label: string;
  value: string;
  onChange: (v: string) => void;
  invalid?: boolean;
  className?: string;
}) {
  return (
    <div className={`grid gap-1.5 ${className ?? ""}`}>
      <Label htmlFor={id}>{label}</Label>
      <Input
        id={id}
        inputMode="decimal"
        placeholder="0"
        value={value}
        aria-invalid={invalid}
        onChange={(e) => onChange(e.target.value.replace(/[^0-9.]/g, ""))}
      />
    </div>
  );
}

function PreviewRow({
  label,
  value,
  bold,
}: {
  label: React.ReactNode;
  value: number;
  bold?: boolean;
}) {
  return (
    <div className="flex items-center justify-between">
      <dt className={bold ? "font-medium" : "text-muted-foreground"}>{label}</dt>
      <dd className={bold ? "num font-semibold" : "num"}>{formatINR(value)}</dd>
    </div>
  );
}
