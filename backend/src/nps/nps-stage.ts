/**
 * What stage an NPS ask is at.
 *
 * A pure function over facts, deliberately: the stage is the single thing the
 * client's team reads off the screen, and it has to be derivable from a row
 * without a database, a clock injection or a service. That also makes every
 * precedence rule below testable, which matters because they are easy to get
 * subtly wrong and impossible to notice afterwards.
 *
 * The three facts the client's register keeps apart, and which this must never
 * collapse:
 *   - we SENT something            (sentAt / reminderSentAt)
 *   - the customer REPLIED         (repliedAt, on WhatsApp)
 *   - the customer SUBMITTED       (respondedAt / a matched form response)
 *
 * A reply is not a submission. "Thanks!" on WhatsApp says nothing about the
 * ten questions on the form, and a stage that treated it as completion would
 * quietly close asks nobody ever answered.
 */

export const NPS_STAGES = [
  'pending_initial',
  'initial_sent',
  'awaiting_response',
  'reminder_due',
  'reminder_sent',
  'completed',
  'failed',
] as const;

export type NpsStage = (typeof NPS_STAGES)[number];

export const NPS_STAGE_LABELS: Record<NpsStage, string> = {
  pending_initial: 'Pending initial message',
  initial_sent: 'Initial message sent',
  awaiting_response: 'Awaiting response',
  reminder_due: 'Reminder due',
  reminder_sent: 'Reminder sent',
  completed: 'Response received',
  failed: 'Sending failed',
};

export interface NpsStageFacts {
  /** The request's own status, as FeedbackRequest stores it. */
  status?: string | null;
  sentAt?: Date | null;
  reminderDueAt?: Date | null;
  reminderSentAt?: Date | null;
  repliedAt?: Date | null;
  /** Set when the FORM was submitted — never set from a WhatsApp reply. */
  respondedAt?: Date | null;
  /** True when an NpsResponse row is matched to this ask. */
  hasMatchedResponse?: boolean;
  /** A delivery that will not be retried. */
  failed?: boolean;
}

/**
 * Precedence, highest first. Order is the whole design:
 *
 *  1. completed — terminal. A submitted form outranks everything, including a
 *     failed send: if they answered anyway, the send no longer matters.
 *  2. failed — needs a person, so it must not be hidden behind "awaiting".
 *  3. reminder_sent / reminder_due — the reminder's own two states.
 *  4. awaiting_response — sent, and the customer has since said something on
 *     WhatsApp without filling the form. Distinct from `initial_sent` so the
 *     branch can see who engaged and still did not answer.
 *  5. initial_sent
 *  6. pending_initial — nothing has gone out.
 */
export function npsStage(facts: NpsStageFacts, now: Date = new Date()): NpsStage {
  if (facts.respondedAt || facts.hasMatchedResponse || facts.status === 'responded') {
    return 'completed';
  }
  if (facts.failed || facts.status === 'failed') return 'failed';
  if (facts.reminderSentAt) return 'reminder_sent';
  if (facts.reminderDueAt && facts.reminderDueAt <= now && facts.sentAt) return 'reminder_due';
  // A reply WITHOUT a submission is its own state — engaged but not answered.
  if (facts.repliedAt && facts.sentAt) return 'awaiting_response';
  if (facts.sentAt) return 'initial_sent';
  return 'pending_initial';
}

/**
 * Has the customer told us anything at all, by any route?
 *
 * Separate from the stage because the client's register has separate columns
 * for it, and because "replied on WhatsApp" is the fact a salesperson chasing
 * somebody actually needs.
 */
export function npsReplyState(facts: NpsStageFacts): 'none' | 'replied' | 'submitted' {
  if (facts.respondedAt || facts.hasMatchedResponse) return 'submitted';
  if (facts.repliedAt) return 'replied';
  return 'none';
}
