/**
 * What a quick reply may say, and when it may be said.
 *
 * Pure on purpose, like `campaign-variables.ts` beside it. Two of the three
 * rules here decide what a customer reads and the third decides whether a
 * message can leave at all, and all three are worth being able to test without
 * a database.
 */

/** The two kinds of send WhatsApp actually has. */
export const QUICK_REPLY_KINDS = ['free_text', 'template'] as const;
export type QuickReplyKind = (typeof QUICK_REPLY_KINDS)[number];

/**
 * Every placeholder a stored reply may carry, what it means, and what is sent
 * when the value is missing.
 *
 * SMALL and CLOSED on purpose. The hardcoded chips interpolated two things —
 * the customer's name and the branch — so this is those two, the first name on
 * its own (a greeting reads better with it), and the salesperson's own name,
 * which is the one thing they would otherwise retype on every shortcut.
 *
 * `standIn` is not decoration. A reply that read "Hello !" because the customer
 * arrived from an ad with no name is worse than one that read "Hello there!",
 * and a raw `{customer}` sitting in the composer is worse than both: it tells
 * the salesperson the feature is broken, at the moment they are mid-sentence
 * with somebody standing in front of them.
 */
export const QUICK_REPLY_PLACEHOLDERS = [
  { token: 'customer', what: "The customer's name", standIn: 'there' },
  { token: 'first_name', what: "The customer's first name only", standIn: 'there' },
  { token: 'branch', what: 'The branch this conversation belongs to', standIn: 'our showroom' },
  { token: 'me', what: 'Your own first name', standIn: 'our team' },
] as const;

export type QuickReplyPlaceholder = (typeof QUICK_REPLY_PLACEHOLDERS)[number]['token'];

/** Who the reply is being written for, as the inbox knows them. */
export interface QuickReplySubject {
  customerName?: string | null;
  branchName?: string | null;
  /** The signed-in salesperson, for `{me}`. */
  agentName?: string | null;
}

/** Any `{word}` in a body, whether or not we recognise it. */
const TOKEN = /\{([a-zA-Z_]+)\}/g;

/**
 * Meta refuses a parameter containing a newline, a tab or four consecutive
 * spaces, and a pasted customer name can carry all three. Flattened before it
 * is substituted rather than after it has been rejected.
 */
function flatten(value: string): string {
  return value.replace(/\s+/g, ' ').trim();
}

function firstName(full: string): string {
  return flatten(full).split(' ')[0] ?? '';
}

function valueFor(token: string, subject: QuickReplySubject): string | null {
  switch (token) {
    case 'customer':
      return flatten(subject.customerName ?? '');
    case 'first_name':
      return firstName(subject.customerName ?? '');
    case 'branch':
      return flatten(subject.branchName ?? '');
    case 'me':
      return firstName(subject.agentName ?? '');
    default:
      return null;
  }
}

const STAND_IN = new Map<string, string>(
  QUICK_REPLY_PLACEHOLDERS.map((p) => [p.token, p.standIn]),
);

/** The placeholders in a body that this release does not know how to fill. */
export function unknownPlaceholders(body: string): string[] {
  const unknown = new Set<string>();
  for (const match of body.matchAll(TOKEN)) {
    if (!STAND_IN.has(match[1])) unknown.add(match[1]);
  }
  return [...unknown];
}

/**
 * The words as the customer will see them.
 *
 * Every `{token}` is replaced, without exception. A known one becomes its value
 * or its stand-in; an unrecognised one — reachable only by a row written by
 * hand, since saving refuses them — is removed and the gap closed, because the
 * one outcome that must never happen is a literal `{token}` arriving in a
 * customer's chat.
 */
export function fillPlaceholders(body: string, subject: QuickReplySubject): string {
  const filled = body.replace(TOKEN, (whole, token: string) => {
    if (!STAND_IN.has(token)) return '';
    return valueFor(token, subject) || (STAND_IN.get(token) as string);
  });
  // Removing a token leaves "Our  showroom" or a space before a full stop.
  return filled.replace(/[ \t]{2,}/g, ' ').replace(/ ([,.!?])/g, '$1').trim();
}

/**
 * WhatsApp's 24-hour customer-care window.
 *
 * The same rule `evaluateDeliveryPolicy` enforces, asked here as a question
 * rather than as a refusal: the chip row has to decide WHICH replies to offer
 * before anybody presses anything, and "try it and read the error" is not an
 * answer on a shop floor. The constant is duplicated knowingly — it is a
 * published WhatsApp rule, not a tunable — and the policy remains the
 * authority on whether a send is actually allowed.
 */
export const CUSTOMER_CARE_WINDOW_MS = 24 * 60 * 60 * 1000;

export function insideCustomerCareWindow(
  lastInboundAt: Date | null | undefined,
  now: Date = new Date(),
): boolean {
  if (!lastInboundAt) return false;
  const elapsed = now.getTime() - lastInboundAt.getTime();
  return elapsed >= 0 && elapsed < CUSTOMER_CARE_WINDOW_MS;
}

/**
 * Whether a reply of this kind can be used right now.
 *
 * The whole reason the client asked for this. Free text is only sendable inside
 * the window; a template-backed reply is sendable at any time, which is what
 * makes it the answer to "somebody missed their message yesterday". The chip
 * row used to vanish entirely once the window closed, so the one state where a
 * shortcut is most valuable was the one state with no shortcuts.
 */
export function kindUsableNow(kind: QuickReplyKind, windowOpen: boolean): boolean {
  return kind === 'template' ? true : windowOpen;
}
