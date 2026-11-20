"use client";

import { useState } from "react";
import { Pencil } from "lucide-react";
import { toast } from "sonner";

import { Button } from "@/components/ui/button";
import type { Quote } from "@/lib/mock/quotation";
import { useUpdateQuoteDetails } from "@/lib/queries/quotes";
import { apiErrorMessage, normalizeCustomerPhone } from "@/lib/utils";
import { QuoteCustomerFields } from "@/components/quotation/quote-customer-fields";
import { customerProblems } from "@/components/quotation/quote-validation";

/**
 * Who a saved quote is for — and the way to correct it.
 *
 * The customer used to be frozen at creation apart from the address, which was
 * buried in the bill-to panel. A mis-keyed name or a digit wrong in the number
 * meant raising the quote again and losing the agreed price, or sending the PDF
 * to nobody (client, 14 Oct). All three are editable here, together, in the
 * same order and at the same size as the New-quote modal asks for them.
 *
 * This is NOT the price. It goes through PATCH /quotes/:id/details, which
 * re-costs nothing and leaves the revision alone — deliberately separate from
 * "Edit quote", which replaces the items and does bump the revision. Nothing
 * here waits on anyone's say-so: whoever can open the quote can correct it, on
 * a quote already shared, downloaded or accepted (the server allows all three;
 * only a new PRICE is refused once the quote has become an order).
 */
export function QuoteCustomerPanel({ quote }: { quote: Quote }) {
  const save = useUpdateQuoteDetails();
  const [editing, setEditing] = useState(false);
  const [draft, setDraft] = useState({ name: "", phone: "", address: "" });
  const [errors, setErrors] = useState<Record<string, string>>({});

  const startEdit = () => {
    // Seeded from the quote as it is NOW, every time, so a cancelled edit is
    // never carried into the next one.
    setDraft({
      name: quote.customer ?? "",
      phone: quote.phone ?? "",
      address: quote.customerAddress ?? "",
    });
    setErrors({});
    setEditing(true);
  };

  const onSave = () => {
    const problems = customerProblems(draft);
    if (Object.keys(problems).length > 0) {
      setErrors(problems);
      return;
    }
    save.mutate(
      {
        id: quote.id,
        customerName: draft.name.trim(),
        // Normalised here too, so the box shows what will actually be stored
        // and dialled rather than the spacing somebody happened to type.
        phone: normalizeCustomerPhone(draft.phone) ?? draft.phone.trim(),
        // Empty clears it; the PDF then falls back to the customer's record.
        customerAddress: draft.address.trim(),
      },
      {
        onSuccess: (updated) => {
          toast.success(`${updated.ref}: customer details saved`, {
            description: "The price is unchanged — the next PDF carries the new details.",
          });
          setEditing(false);
        },
        onError: (e) => toast.error(apiErrorMessage(e, "Could not save the customer details.")),
      },
    );
  };

  return (
    <div className="rounded-lg border bg-muted/30 p-3 text-sm">
      <div className="mb-2 flex items-center justify-between gap-2">
        <p className="text-xs font-medium text-muted-foreground">Customer</p>
        {!editing ? (
          <Button
            size="sm"
            variant="ghost"
            onClick={startEdit}
            title="Change the name, phone and address. The price and the revision stay as they are."
          >
            <Pencil className="h-3.5 w-3.5" />
            Edit customer
          </Button>
        ) : null}
      </div>

      {!editing ? (
        <>
          <p className="font-medium">{quote.customer}</p>
          <p className="text-muted-foreground">
            {[quote.phone, quote.customerAddress].filter(Boolean).join(" · ") ||
              "No phone or address on record"}
          </p>
        </>
      ) : (
        <div className="space-y-3">
          <QuoteCustomerFields
            idPrefix="qc"
            value={draft}
            disabled={save.isPending}
            errors={errors}
            onChange={(patch) => {
              setDraft((d) => ({ ...d, ...patch }));
              // Clear only the field being typed in, so the other complaint
              // does not vanish before it has been dealt with.
              setErrors((p) => ({
                ...p,
                ...(patch.name !== undefined ? { customer: "" } : {}),
                ...(patch.phone !== undefined ? { phone: "" } : {}),
              }));
            }}
          />
          <div className="flex justify-end gap-2">
            <Button
              variant="outline"
              size="sm"
              disabled={save.isPending}
              onClick={() => setEditing(false)}
            >
              Cancel
            </Button>
            <Button size="sm" disabled={save.isPending} onClick={onSave}>
              {save.isPending ? "Saving…" : "Save customer"}
            </Button>
          </div>
        </div>
      )}
    </div>
  );
}
