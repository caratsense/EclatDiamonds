/**
 * What a broadcast is allowed to claim about one person, and about itself.
 *
 * A campaign hands every message to the outbox and the outbox calls the
 * provider later, so the moment of handover tells you nothing about whether
 * anybody was reached. That gap is where the worst failure this product can
 * have lived: a broadcast of 126 reported "125 sent" on the screen while every
 * one of those messages had been refused by Meta, because the send loop wrote
 * 'sent' the instant the message was queued.
 *
 * So the recipient's status is never decided by the sender. It is decided here,
 * from what the outbox row says, and the outbox row only says 'sent' once the
 * provider has accepted it.
 *
 * Pure on purpose: this is the rule the owner and the client read a number off,
 * and it is worth being able to test it without a database — and worth the
 * backfill script being able to import the same rule rather than restate it.
 */

/** The recipient vocabulary, as the schema documents it. */
export type RecipientStatus =
  | 'pending'
  | 'excluded'
  | 'queued'
  | 'sent'
  | 'delivered'
  | 'read'
  | 'failed'
  | 'dead'
  | 'cancelled';

/** What an outbound Message row can say about itself. */
export type OutboxStatus = 'queued' | 'sent' | 'delivered' | 'read' | 'failed';

/**
 * How far a recipient has got, in order.
 *
 * WhatsApp reports 'sent', 'delivered' and 'read' as separate callbacks that do
 * not always arrive in that order, so progress only ever moves forward: a late
 * 'sent' receipt must not unsay a 'read'.
 *
 * 'failed' and 'dead' sit level with 'sent' for the same reason the outbox ranks
 * them that way — both mean the provider has answered for this attempt — so a
 * stray 'sent' arriving after a refusal cannot dress the refusal up as a send.
 */
const PROGRESS: Record<string, number> = {
  pending: 0,
  queued: 1,
  sent: 2,
  failed: 2,
  dead: 2,
  delivered: 3,
  read: 4,
};

/**
 * How many times a recipient may be handed to the outbox before a failure is
 * final. Matched to the recipient's own `attempts`, which the send loop
 * increments as it claims the row.
 */
const GIVE_UP_AFTER = 2;

/**
 * The status a recipient should hold now that its message says `messageStatus`,
 * or null when nothing should change.
 *
 * Null covers the two cases that must not write: an outbox row still 'queued'
 * (the provider has not answered, and the recipient is already 'queued'), and a
 * receipt that would move the recipient backwards.
 */
export function nextRecipientStatus(input: {
  current: string;
  /** The recipient's own attempt count, which decides failed versus given up. */
  attempts: number;
  messageStatus: string;
}): RecipientStatus | null {
  const mapped = mapOutboxStatus(input.messageStatus, input.attempts);
  if (!mapped) return null;

  // A refusal is accepted over anything except proof of arrival: the provider
  // cannot un-deliver a message it already delivered.
  if (mapped === 'failed' || mapped === 'dead') {
    if (input.current === 'delivered' || input.current === 'read') return null;
    return input.current === mapped ? null : mapped;
  }

  if ((PROGRESS[input.current] ?? 0) >= PROGRESS[mapped]) return null;
  return mapped;
}

/**
 * A recipient status for an outbox status, ignoring where the recipient already
 * is. 'queued' maps to 'queued' so the caller's forward-only check handles it
 * like everything else rather than needing a special case.
 */
function mapOutboxStatus(messageStatus: string, attempts: number): RecipientStatus | null {
  switch (messageStatus) {
    case 'queued':
      return 'queued';
    case 'sent':
      return 'sent';
    case 'delivered':
      return 'delivered';
    case 'read':
      return 'read';
    case 'failed':
      return attempts >= GIVE_UP_AFTER ? 'dead' : 'failed';
    default:
      // 'received' is an inbound message's status and belongs to nobody here.
      return null;
  }
}

export interface RecipientCounts {
  [status: string]: number | undefined;
}

/**
 * What the campaign itself should say, given its recipients.
 *
 * `settled` is the half that was missing. The send loop used to call this the
 * moment it ran out of rows to hand over, with every recipient still queued
 * with the provider: nothing had failed yet, so the campaign was written
 * 'completed' and stamped with a finish time before a single message had left
 * the building. A campaign still holding rows in flight has not finished, and
 * says so.
 */
export function campaignOutcome(counts: RecipientCounts): {
  settled: boolean;
  status: 'sending' | 'completed' | 'partially_failed' | 'failed';
} {
  const n = (key: string) => counts[key] ?? 0;
  const inFlight = n('pending') + n('queued');
  if (inFlight > 0) return { settled: false, status: 'sending' };

  const reached = n('sent') + n('delivered') + n('read');
  const refused = n('failed') + n('dead');
  if (refused === 0) return { settled: true, status: 'completed' };
  // Every message refused reads as a failure, not as a send. This is the line
  // the "125 of 126 sent" screen needed.
  return { settled: true, status: reached === 0 ? 'failed' : 'partially_failed' };
}
