/**
 * WHO AN OUTBOUND MESSAGE APPEARS TO COME FROM, on the customer's phone.
 *
 * ## Why the customer needs a name at all
 *
 * Every reply leaves from ONE business number — the assistant's answers and
 * four different branch managers' answers all arrive in the same chat bubble.
 * Without a name the customer cannot tell they are talking to the shop they
 * messaged rather than to a stranger who has their number.
 *
 * ## Why it is the BUSINESS's name and never the sender's
 *
 * It used to be the staff account's own name, which is how `*Head Office*` and
 * `*Bot script*` ended up on customers' phones (client, Nov 2026). Both are
 * internal vocabulary: one names a department the customer has no relationship
 * with, the other admits a script wrote the message. Her requirement is that
 * everything leaving the CRM — head office, a store manager or the bot — speaks
 * as the business, and that nothing reveals which of them it was.
 *
 * The staff name is NOT lost: the CRM still records `authorUserId` on the
 * message and shows it as a badge beside the bubble, so a manager can still see
 * who answered. It simply stops being something the customer is shown.
 *
 * ## Why the name is stored, not added at delivery
 *
 * The signed text is what goes into `Message.body`, so the thread is a record
 * of what the customer actually received. Signing later — at the provider call
 * — would make the dashboard show something the customer never saw, and a
 * transcript that differs from reality is worse than no transcript.
 *
 * ## Why only WhatsApp
 *
 * `*name*` is WhatsApp's bold markup. On a channel that does not parse it the
 * asterisks would be shown literally, so every other channel is left alone
 * until it has a format of its own. Media with no caption is left alone too:
 * there is no text to sign, and a bare name would read as a message.
 */

/** The bold first line WhatsApp renders above a signed reply. */
export function signatureLine(name: string): string {
  return `*${name.trim()}*\n`;
}

/**
 * Put the business's name on a reply typed in the dashboard.
 *
 * An empty name signs nothing rather than prefixing `**`: a tenant whose
 * display name is blank should look unsigned, not broken.
 */
export function signAsBusiness(
  body: string | null,
  businessName: string,
  channel: string,
): string | null {
  if (!body || channel !== 'whatsapp') return body;
  if (!businessName.trim()) return body;
  return `${signatureLine(businessName)}${body}`;
}

/**
 * Take the signature line back off a stored body, for anything that displays
 * what was SAID rather than who said it.
 *
 * ## Why this takes a LIST of names
 *
 * Messages sent before the business signature existed are signed with the
 * sender's own name and are still in the inbox. Both shapes have to come off:
 * stripping only the current one would put `*Head Office*` at the top of every
 * historical preview, and stripping only the old one would put the business
 * name there for everything sent from now on.
 *
 * Only an EXACT signature line is removed, and only for display — the stored
 * body is untouched, so the transcript is still what the customer received. A
 * body whose first line is bold for the agent's own reasons ("*Diwali offer*")
 * survives, because it matches none of the names.
 */
export function stripOutboundSignature(
  body: string,
  names: ReadonlyArray<string | null | undefined>,
): string {
  for (const name of names) {
    if (!name?.trim()) continue;
    const line = signatureLine(name);
    if (body.startsWith(line)) return body.slice(line.length);
  }
  return body;
}

/**
 * The name THIS tenant's messages are signed with.
 *
 * `settings.branding.displayName` is where a tenant's own name for itself
 * already lives — signup writes the organisation name into it — so the choice
 * is configurable without inventing a second place to say the same thing. The
 * organisation's name is the fallback, which is what makes this safe for a
 * tenant provisioned before branding existed.
 *
 * Deliberately NOT a constant: hardcoding one client's name into the send path
 * of a multi-tenant product would message every other tenant's customers as
 * them.
 */
export function businessSenderNameFrom(settings: unknown, organisationName: string): string {
  const branding = asRecord(asRecord(settings).branding);
  const configured = typeof branding.displayName === 'string' ? branding.displayName.trim() : '';
  return configured || organisationName.trim();
}

/**
 * Coerce whatever came out of the JSONB column into a plain object.
 *
 * Same reasoning as `org-settings.ts`: the column can legitimately hold null,
 * and a driver may hand back a parsed object or a raw string. Anything else
 * becomes `{}` so a malformed settings bag falls back to the organisation name
 * instead of throwing inside a send.
 */
function asRecord(value: unknown): Record<string, unknown> {
  if (typeof value === 'string') {
    try {
      const parsed: unknown = JSON.parse(value);
      return parsed && typeof parsed === 'object' && !Array.isArray(parsed)
        ? (parsed as Record<string, unknown>)
        : {};
    } catch {
      return {};
    }
  }
  if (value && typeof value === 'object' && !Array.isArray(value)) {
    return value as Record<string, unknown>;
  }
  return {};
}
