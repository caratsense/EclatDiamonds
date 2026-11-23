"use client";

import { useState } from "react";
import { useRouter } from "next/navigation";
import { MessageSquare } from "lucide-react";

import { Button } from "@/components/ui/button";
import { StartWhatsAppDialog } from "@/components/crm/start-whatsapp-dialog";
import { PRODUCT_NAME } from "@/lib/brand";
import { useConversations } from "@/lib/queries/crm";
import { cn } from "@/lib/utils";

/**
 * Where the WhatsApp button on a customer goes — the whole decision, as one
 * function, so it can be asserted rather than clicked through.
 *
 * `null` means "no destination": open the template composer where the user
 * already is. Everything else is a path inside this product, which is the
 * property that matters most here and the one a `wa.me` link broke.
 */
export function customerConversationHref(input: {
  partyId: string;
  /** The customer's newest thread, or null when they have none. */
  newestThreadId: string | null;
  /** The thread lookup could not be answered. */
  lookupFailed: boolean;
}): string | null {
  const { partyId, newestThreadId, lookupFailed } = input;
  if (newestThreadId) {
    return `/conversations?partyId=${partyId}&thread=${newestThreadId}`;
  }
  /*
   * A FAILED LOOKUP IS NOT THE SAME ANSWER AS "NO THREAD", and conflating the
   * two is how this control would quietly start sending templates to people
   * who are mid-conversation. Send them to the inbox filtered to this
   * customer, where the same question is asked again and the answer is shown.
   */
  if (lookupFailed) return `/conversations?partyId=${partyId}`;
  return null;
}

/**
 * "WhatsApp", on a customer we already have a record for — and it stays inside
 * the product.
 *
 * ## Why this is not a `wa.me` link
 *
 * It used to be one (Customer 360, client 23 Nov: "this whatsapp button in
 * detailed customer view takes to the WhatsApp app. It should take to the
 * conversation tab"). A `wa.me` link hands the customer to whichever WhatsApp
 * account is signed in on the staff member's own machine or phone, so the
 * message goes out FROM THEM. Nothing about it reaches this product: no message
 * on the thread, no SLA clock started, no line in the audit, and the next
 * colleague to open the customer sees somebody nobody has replied to. The
 * button was a hole in the record rather than a shortcut.
 *
 * ## The two destinations
 *
 * One button, because the staff member has one intention — "talk to this
 * person" — and which door WhatsApp allows depends on something they should not
 * have to know:
 *
 *   - THEY HAVE A THREAD → the inbox, with it open. `?partyId=&thread=` is the
 *     deep link the Conversations screen already reads; `partyId` travels
 *     alongside the thread id so that screen still shows its "N threads · show
 *     all threads" header for a customer who has written in more than once.
 *   - THEY HAVE NEVER WRITTEN IN → the template composer, in place. WhatsApp
 *     refuses free text to a number with no open 24-hour customer-care window,
 *     so an approved template is the only thing that can go first — which is
 *     what `StartWhatsAppDialog` enforces, and it lands in the inbox on the new
 *     thread once it sends.
 *
 * Deliberately NOT: navigate to an empty inbox and leave them to find the
 * compose button there. The lookup that would tell them it is empty has already
 * answered by then, so the trip is pure friction.
 *
 * ## The lookup
 *
 * One request per mounted button, so this belongs beside a single named
 * customer and not in a row of a fifty-customer list — use `WhatsAppCta` there,
 * which composes without asking.
 *
 * It runs on mount rather than on the click, so by the time anybody has read
 * the page the button already knows which door it opens. Looking up after the
 * click instead would make the first press do nothing visible while a request
 * is in flight, which is indistinguishable from the dead buttons this release
 * has been spent removing.
 *
 * The lookup is branch-scoped like every other read here, so a salesperson who
 * cannot see the branch that owns this customer's thread is offered the
 * composer. That is the honest outcome: the alternative is telling them a
 * conversation exists and then refusing to show it.
 */
export function CustomerWhatsAppButton({
  partyId,
  name,
  phone,
  className,
}: {
  partyId: string;
  name: string;
  phone?: string | null;
  className?: string;
}) {
  const router = useRouter();
  const [compose, setCompose] = useState(false);

  const threads = useConversations({ partyId });
  const newestThread = threads.data?.[0];

  const open = () => {
    const href = customerConversationHref({
      partyId,
      newestThreadId: newestThread?.id ?? null,
      lookupFailed: threads.isError,
    });
    if (href) router.push(href);
    else setCompose(true);
  };

  // Nothing to message them on. A disabled button that cannot say why reads as
  // broken; no button reads as "we have no number for this person".
  if (!phone?.trim()) return null;

  return (
    <>
      <Button
        size="sm"
        variant="outline"
        className={cn(
          "h-8 gap-1.5 border-emerald-500/30 text-emerald-600 hover:bg-emerald-500/10",
          className,
        )}
        /*
         * Held for the moment the lookup takes, and it says which moment that
         * is. Two things it must not do instead: act on a guess, which sends a
         * template to somebody who is mid-conversation; or sit there enabled
         * and swallow the click, which is the shape of every button in this
         * product that has been reported as doing nothing.
         */
        disabled={threads.isPending}
        title={
          threads.isPending
            ? "Checking whether this customer already has a conversation…"
            : newestThread
              ? `Open ${name}'s conversation in ${PRODUCT_NAME}`
              : `Message ${name} on WhatsApp — the reply comes back into ${PRODUCT_NAME}`
        }
        onClick={open}
      >
        <MessageSquare className="h-3.5 w-3.5 fill-emerald-600/20" />
        {threads.isPending ? "Checking…" : "WhatsApp"}
      </Button>

      {/* Mounted only once needed, so the template query runs for the person
          who asked for it and not on every customer page view. */}
      {compose ? (
        <StartWhatsAppDialog
          open={compose}
          onOpenChange={setCompose}
          phone={phone}
          name={name}
        />
      ) : null}
    </>
  );
}
