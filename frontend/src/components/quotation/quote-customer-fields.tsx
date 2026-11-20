"use client";

import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { customerPhoneInputValue } from "@/lib/utils";
import type { CustomerFields } from "@/components/quotation/quote-validation";

/**
 * Who a quote is for: name, phone, then the address across the full width.
 *
 * One component, so the New-quote modal and the customer edit on a saved quote
 * are the SAME three boxes in the same order at the same size (h-11 — these are
 * typed at a counter terminal, often on a touchscreen). They used to be two
 * hand-written forms: the modal asked for name, phone and address together,
 * while a saved quote let you change only the address, buried in the bill-to
 * panel. A customer whose name was mis-keyed had to have the whole quote raised
 * again, losing the price that had been agreed (client, 14 Oct).
 *
 * Purely the boxes: no mutation, no submit. The caller owns the values, decides
 * what saving means, and passes per-field errors keyed as
 * {@link customerProblems} returns them.
 */
export interface QuoteCustomerFieldsProps {
  value: CustomerFields & { address: string };
  onChange: (patch: Partial<CustomerFields & { address: string }>) => void;
  /** Keyed `customer`, `phone`; shown under the box it belongs to. */
  errors?: Record<string, string>;
  /** Prefix for the input ids, so two of these can share a page. */
  idPrefix: string;
  disabled?: boolean;
}

export function QuoteCustomerFields({
  value,
  onChange,
  errors = {},
  idPrefix,
  disabled,
}: QuoteCustomerFieldsProps) {
  return (
    <>
      <div className="grid gap-3 sm:grid-cols-2">
        <div className="grid gap-1.5">
          <Label htmlFor={`${idPrefix}-cust`}>
            Customer name <span className="text-destructive">*</span>
          </Label>
          <Input
            id={`${idPrefix}-cust`}
            className="h-11"
            value={value.name}
            maxLength={120}
            disabled={disabled}
            aria-invalid={!!errors.customer}
            onChange={(e) => onChange({ name: e.target.value })}
            placeholder="e.g. Meera Iyer"
          />
          {errors.customer ? (
            <p className="mt-1 text-xs text-destructive">{errors.customer}</p>
          ) : null}
        </div>
        <div className="grid gap-1.5">
          <Label htmlFor={`${idPrefix}-phone`}>
            Phone <span className="text-destructive">*</span>
          </Label>
          <Input
            id={`${idPrefix}-phone`}
            className="h-11"
            value={value.phone}
            type="tel"
            inputMode="tel"
            maxLength={16}
            disabled={disabled}
            aria-invalid={!!errors.phone}
            // Kept in the box's own shape while typing; validated on save.
            onChange={(e) => onChange({ phone: customerPhoneInputValue(e.target.value) })}
            placeholder="10-digit mobile or +country number"
          />
          {errors.phone ? <p className="mt-1 text-xs text-destructive">{errors.phone}</p> : null}
        </div>
      </div>
      <div className="grid gap-1.5">
        <Label htmlFor={`${idPrefix}-address`}>Customer address</Label>
        <Input
          id={`${idPrefix}-address`}
          className="h-11"
          value={value.address}
          maxLength={300}
          disabled={disabled}
          onChange={(e) => onChange({ address: e.target.value })}
          placeholder="House / street, area, city — printed under the name on the quote"
        />
      </div>
    </>
  );
}
