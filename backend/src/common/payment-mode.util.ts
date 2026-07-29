import { PaymentMode } from '@prisma/client';

/**
 * Display labels for every `PaymentMode`.
 *
 * Previously this map was copy-pasted into the payments, reporting and finance
 * services. All three copies had drifted the same way: none of them listed
 * `old_gold`, so an old-gold settlement — a routine jewellery transaction —
 * rendered as the raw enum string on the collections ledger and in the daily
 * report the owner sends out. Keeping one map keyed by the enum means a new mode
 * cannot be added without this file failing to compile.
 */
export const PAYMENT_MODE_LABELS: Record<PaymentMode, string> = {
  cash: 'Cash',
  card: 'Card',
  upi: 'UPI',
  net_banking: 'Net Banking',
  online: 'Online',
  cheque: 'Cheque',
  gold_exchange: 'Gold Exchange',
  old_gold: 'Old Gold',
};

/** Label for a mode, tolerating a legacy/unknown string rather than blanking it. */
export function paymentModeLabel(mode: string | null | undefined): string {
  if (!mode) return '—';
  return PAYMENT_MODE_LABELS[mode as PaymentMode] ?? mode;
}
