/**
 * Why a message did not reach the customer, said to the person who sent it.
 *
 * Its own module so the sentence can be asserted without rendering the inbox:
 * this is copy a store manager acts on with a customer waiting, and it is the
 * difference between attaching the photograph again and ringing the shop.
 *
 * The stored error is prefixed with the engineer's code — `content_missing: The
 * queued message has neither text nor an attachment to send.` The sentence
 * after the colon is already written for a person; the code in front of it only
 * makes a manager think they have broken something. Anything that does not
 * follow that shape is kept in full, because an unrecognised refusal is still
 * better read as it stands than summarised into "something went wrong".
 */
export function sendFailureReason(error: string | null | undefined): string {
  const reason = (error ?? "").trim();
  if (!reason) return "WhatsApp did not accept it. Try again, or ring the customer.";
  const coded = /^[a-z][a-z0-9_]*:\s*([\s\S]+)$/.exec(reason);
  return coded ? coded[1] : reason;
}
