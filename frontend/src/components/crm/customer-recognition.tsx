"use client";

import Link from "next/link";
import { Loader2, UserCheck, UserPlus } from "lucide-react";

import { useCustomerLookup, type LookupResult } from "@/lib/queries/crm";
import { normalizeIndianMobile } from "@/lib/utils";

/**
 * "Who just walked in?" — the front of the showroom flow.
 *
 * READ-ONLY BY DESIGN. The lookup endpoint never creates a customer. Someone
 * checking whether a number is known must be able to do that without leaving a
 * half-filled record behind when the answer is no; the customer is created
 * later, by the form that actually has their details.
 *
 * It also refuses to guess. A number that matches nobody says exactly that
 * rather than offering the nearest name — a wrong "is this you?" at the counter
 * is worse than nothing.
 *
 * NO DEBOUNCE IS NEEDED, which is worth stating because adding one is the
 * obvious instinct: `normalizeIndianMobile` returns null until the number is
 * actually complete, so the query is disabled for every partial entry and fires
 * exactly once, on the last digit.
 */
export function CustomerRecognition({
  phone,
  onRecognised,
}: {
  phone: string;
  /** Called with the matched customer, so a form can prefill their name. */
  onRecognised?: (customer: NonNullable<LookupResult["customer"]>) => void;
}) {
  const normalized = normalizeIndianMobile(phone);

  // One lookup implementation, in the queries module — this component renders
  // the answer, it does not own a second way of asking the question.
  const { data: result, isFetching } = useCustomerLookup(normalized, {
    onFound: onRecognised,
  });

  if (!normalized) return null;

  if (isFetching && !result) {
    return (
      <p className="flex items-center gap-2 text-xs text-muted-foreground">
        <Loader2 className="h-3.5 w-3.5 animate-spin" />
        Checking if we know this number…
      </p>
    );
  }

  // A failed lookup renders nothing rather than an error: it must never block
  // the walk-in from being logged, and there is no action the user could take.
  if (!result) return null;

  if (!result.found || !result.customer) {
    return (
      <p className="flex items-center gap-2 rounded-md border border-dashed px-3 py-2 text-xs text-muted-foreground">
        <UserPlus className="h-3.5 w-3.5" />
        New to us — a customer record will be created.
      </p>
    );
  }

  const c = result.customer;
  return (
    <div className="flex flex-wrap items-center justify-between gap-2 rounded-md border border-emerald-500/40 bg-emerald-500/5 px-3 py-2 text-xs">
      <span className="flex items-center gap-2">
        <UserCheck className="h-3.5 w-3.5 text-emerald-600" />
        <span>
          <span className="font-medium">{c.name}</span>
          {c.city ? <span className="text-muted-foreground"> · {c.city}</span> : null}
          <span className="text-muted-foreground">
            {" "}
            · with us since {new Date(c.createdAt).getFullYear()}
          </span>
        </span>
      </span>
      <Link href={`/customers/${c.id}`} className="font-medium underline underline-offset-2">
        Open history
      </Link>
    </div>
  );
}
