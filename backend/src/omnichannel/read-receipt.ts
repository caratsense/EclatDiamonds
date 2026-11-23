/**
 * WHEN THE CUSTOMER IS TOLD WE HAVE SEEN THEIR MESSAGE.
 *
 * WhatsApp only puts blue ticks on a customer's message if we ask it to, with
 * POST /{phone-number-id}/messages carrying `status: "read"` and their message
 * id. Nothing in the app did that, so a customer who messaged a shop could not
 * tell the difference between "nobody has looked yet" and "they are ignoring
 * me" (client, Nov 2026).
 *
 * ## What the receipt claims, and why that is the most we can honestly say
 *
 * The app has no per-user read tracking: there is no record of which colleague
 * has looked at which message, and no "seen" marker on a Message row. The
 * closest honest signal available is that a signed-in person opened the thread
 * in the CRM — `GET /crm/conversations/:id/thread`, which only the dashboard
 * calls and which carries an authenticated user. So the tick means "somebody at
 * this business opened your conversation", which is what the customer wants to
 * know and is true whenever it is sent.
 *
 * Two things it deliberately does NOT mean:
 *
 *  - NOT "the message arrived". Ticking on webhook arrival would mark every
 *    message read the instant it landed, including the ones nobody opens until
 *    the next morning. A signal that is always on carries no information, and
 *    it would be a small lie to every customer who got one.
 *  - NOT "the bot replied". A script answering a thread is not a person reading
 *    it. The client's objection this week was customers being able to tell a bot
 *    was involved; a blue tick with nobody behind it is the same deception in a
 *    smaller form. The bot path therefore never calls this.
 */

/** An inbound message, as far as acknowledging it is concerned. */
export interface InboundReadCandidate {
  id: string;
  /** The provider's id for the customer's message. Null for anything we made. */
  externalId: string | null;
  /** 'received' until we have acknowledged it, 'read' once we have. */
  status: string;
  sentAt: Date;
}

export type ReadReceiptPlan =
  | {
      acknowledge: {
        /** Our row, so the local status can be moved in step with the receipt. */
        messageId: string;
        /** What Graph is told to mark read. */
        providerMessageId: string;
        /** Everything the customer sent up to here is read as well — see below. */
        sentAt: Date;
      };
    }
  | { acknowledge: null; reason: string };

/**
 * Which one of the customer's messages to acknowledge, if any.
 *
 * ## Why only the newest
 *
 * The Cloud API marks every earlier message in the conversation read alongside
 * the one named, so a thread with nine unacknowledged messages needs ONE call,
 * not nine. That is also why the plan carries `sentAt`: the local rows up to
 * that point are moved to 'read' together, which is both what the customer's
 * phone now shows and what stops the next person opening the thread from
 * acknowledging the same messages again.
 *
 * ## Why a message with no provider id is skipped
 *
 * There is nothing to acknowledge: `externalId` is the provider's own id for
 * their message, and a row without one was composed inside CaratOS or arrived
 * from an adapter that gave us no id. Graph has no way to resolve it.
 */
export function planReadReceipt(input: {
  channel: string;
  /** The customer's number — absent on a thread we have never received on. */
  externalThreadId: string | null;
  inbound: ReadonlyArray<InboundReadCandidate>;
}): ReadReceiptPlan {
  if (input.channel !== 'whatsapp') {
    // Instagram and email have no equivalent call. Saying so is better than a
    // silent no-op that reads as a bug the next time somebody looks.
    return { acknowledge: null, reason: 'Only WhatsApp can show the customer a read receipt.' };
  }
  if (!input.externalThreadId) {
    return {
      acknowledge: null,
      reason: 'This thread has no WhatsApp number, so there is nothing to acknowledge on.',
    };
  }

  let newest: InboundReadCandidate | null = null;
  for (const message of input.inbound) {
    if (!message.externalId) continue;
    if (message.status === 'read') continue;
    if (!newest || message.sentAt.getTime() > newest.sentAt.getTime()) newest = message;
  }
  if (!newest?.externalId) {
    return {
      acknowledge: null,
      reason: 'Everything the customer has sent is already marked read.',
    };
  }

  return {
    acknowledge: {
      messageId: newest.id,
      providerMessageId: newest.externalId,
      sentAt: newest.sentAt,
    },
  };
}
