import type { RecipientStatus } from './campaign-delivery';

/**
 * Re-sending to the people a broadcast did not reach, and the one rule that
 * stops a re-send making things worse.
 *
 * Pure on purpose: the figure a manager reads before pressing the button is
 * decided here, so it can be tested without a database and cannot drift from
 * the figure the re-send actually acts on.
 */

/**
 * The statuses behind the "Did not arrive" tab, and therefore the exact group
 * its re-send button acts on.
 *
 * `dead` as well as `failed`. A recipient is marked dead once its attempts are
 * spent and `attempts` is never reset, so a row that failed twice could never
 * be tried again however thoroughly the cause had been fixed — that is why
 * scripts/retry-campaign.mjs had to exist at all, and why 125 people of the
 * nails-event broadcast were stranded where the screen's own button could not
 * reach them. A button that says it re-sends to the tab it sits on has to mean
 * the whole tab.
 */
export const DID_NOT_ARRIVE: RecipientStatus[] = ['failed', 'dead'];

/**
 * How recently a person must NOT have been messaged for a re-send to include
 * them, in hours.
 *
 * Meta caps how much marketing one person receives (error 131049), per
 * recipient, over a rolling window. Re-sending the same template to the same
 * list is therefore not free: it spends that allowance, and the people it burns
 * are refused for hours afterwards.
 *
 * This is not theoretical. On the nails-event broadcast the outcome tracked the
 * number of attempts almost exactly — 80% of the people tried twice got it, 9%
 * of the people tried three times did, and nobody tried four times did. The
 * retries were debugging a delivery bug, and they made the delivery worse.
 *
 *   attempts  reached  refused
 *     2         143      36
 *     3           2      21
 *     4           0       2
 *
 * 24 hours is the window scripts/retry-campaign.mjs holds back on, and this is
 * deliberately the same number rather than a second opinion about it.
 */
export const RETRY_COOLDOWN_HOURS = 24;

/** The instant a recipient's last send has to predate to be eligible again. */
export function retryCooldownSince(now: Date, hours: number = RETRY_COOLDOWN_HOURS): Date {
  return new Date(now.getTime() - hours * 3600_000);
}

export interface RetryPlan {
  cooldownHours: number;
  /** Rows on the "Did not arrive" tab — everything a re-send could touch. */
  retryable: number;
  /** Of those, the ones inside the cooldown and therefore left out. */
  heldBack: number;
  /** What the button will ACTUALLY send to. */
  willSend: number;
  /** What it would send to if somebody deliberately overrides the cooldown. */
  willSendWithOverride: number;
}

/**
 * What a re-send would do, counted before the click rather than reported after
 * it.
 *
 * The screen used to offer "Retry failed" with no number at all, so the only
 * way to find out how many people a re-send spent was to spend them. A figure
 * that ignores the hold-back is just as bad: it is the figure somebody plans
 * around and then has to explain.
 */
export function retryPlan(input: {
  retryable: number;
  /** Of the retryable, how many were last messaged inside the cooldown. */
  messagedRecently: number;
  includeRecentlyMessaged?: boolean;
  cooldownHours?: number;
}): RetryPlan {
  const retryable = Math.max(input.retryable, 0);
  // Clamped against `retryable`, not trusted: the two numbers come from two
  // counts, and a hold-back larger than the group it is held back from would
  // make the sendable figure negative.
  const recent = Math.min(Math.max(input.messagedRecently, 0), retryable);
  const heldBack = input.includeRecentlyMessaged ? 0 : recent;
  return {
    cooldownHours: input.cooldownHours ?? RETRY_COOLDOWN_HOURS,
    retryable,
    heldBack,
    willSend: retryable - heldBack,
    willSendWithOverride: retryable,
  };
}
