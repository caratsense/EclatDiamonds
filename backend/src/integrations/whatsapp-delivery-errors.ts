/**
 * What a WhatsApp delivery failure means, in words the person reading it can
 * act on.
 *
 * The outbox stores Meta's numeric codes and nothing else — deliberately, so
 * no echoed customer content reaches a message row or a log line. That is the
 * right thing to store and the wrong thing to show: the client opened her
 * broadcast report, found twenty-two customers marked dead against "Provider
 * error 131049", and asked the only reasonable question — they have a number
 * and they have consent, so why did it fail?
 *
 * Translated at the READ boundary rather than at the write, so the stored
 * value stays clean and a code we learn to explain later explains itself on
 * rows already written.
 *
 * Each sentence says whose decision it was and whether anybody here can do
 * anything about it. "Meta declined" and "our template is wrong" are both
 * failures and they are not the same news.
 */
const EXPLANATIONS: Record<string, string> = {
  /*
   * Meta's per-recipient marketing limit. Its own title is "this message was
   * not delivered to maintain healthy ecosystem engagement" — the customer has
   * had more marketing than Meta allows, or engages with too little of it.
   * Nothing on our side caused it and nothing on our side fixes it.
   */
  '131049':
    'Meta chose not to deliver this one. It caps how much marketing a person receives, and this customer was over that cap. Nothing to fix here — try them again in a later send.',
  /*
   * The recipient is in one of Meta's hold-out groups, which exist to measure
   * what marketing messages do. Those numbers receive none at all.
   */
  '130472':
    'This number is in a Meta test group that receives no marketing messages. Their choice of who is in it, not ours.',
  '131026':
    'This number cannot receive WhatsApp messages — it may not be on WhatsApp, or not on a version that accepts this message.',
  '131047':
    'More than 24 hours have passed since this customer last wrote, so only an approved template can reach them now.',
  '131042':
    'The WhatsApp Business account cannot send right now — this is a billing or eligibility problem on the account itself.',
  '132012':
    'The template was sent in a shape Meta did not accept. This is ours to fix, not the customer’s.',
  '132000':
    'The template was sent with the wrong number of values. This is ours to fix.',
  '131031':
    'The WhatsApp Business account is restricted by Meta. Nothing will send until that is resolved.',
  '133010':
    'The sending number is not registered with WhatsApp.',
  '131000':
    'Meta failed to send this one and gave no reason. Worth trying again.',
};

/**
 * Our OWN refusals, which never reached Meta at all.
 *
 * These are stored as `<code>: <sentence>` by `failPermanently`, and the
 * sentence is already written for a person — so what is added here is only the
 * part it cannot know: whether pressing "Try again" will change anything, and
 * whether a customer saw it.
 *
 * 28 Nov. The client sent `newmessage` from a thread; Meta had the template
 * back under review after an edit, so the worker blocked it and the row read
 * "The provider reports this template as pending." True, and it answered
 * neither of the two questions she actually had. She retried, and concluded
 * from the bubble that a customer had been sent a literal {{1}}. Nobody had
 * been sent anything.
 */
const BLOCK_ADVICE: Record<string, string> = {
  /*
   * The template, not the recipient. Approval is Meta's to give and an edited
   * template goes back into the queue for it, so every retry until then
   * returns this same refusal — which is why the sentence has to say so out
   * loud rather than leave a shop floor pressing the button.
   */
  template_unavailable:
    'Nothing reached the customer — this was stopped here, before it was sent. ' +
    'It is the template that cannot send, not this customer, so trying again gives ' +
    'the same answer: it can go out once the provider has approved the template and ' +
    'templates have been synchronised.',
};

/**
 * Turn a stored delivery error into a sentence, leaving anything else as it is.
 *
 * Ours already read plainly — "That is not a usable WhatsApp number" — and
 * must pass through untouched. Only the `Provider error <codes>` form is
 * rewritten, and an unrecognised code still says plainly that Meta refused it
 * and what the code was, so nobody is left with a blank where a reason was.
 *
 * A `<code>: <sentence>` refusal of our own keeps its stored sentence and gains
 * what to do about it, for the few codes where there IS something to say. One we
 * have nothing to add to passes through with its code prefix exactly as before,
 * because the screen that shows it already strips that prefix itself.
 */
export function explainDeliveryError(error: string | null | undefined): string | null {
  if (!error) return null;
  const match = /^Provider error\s+(.+)$/i.exec(error.trim());
  if (!match) {
    // Lower case opener, so Meta's own "Provider error …" cannot reach here and
    // a provider sentence like "HTTP 400: …" is not mistaken for one of ours.
    const ours = /^([a-z][a-z0-9_]*):\s*([\s\S]+)$/.exec(error.trim());
    if (!ours) return error;
    const advice = BLOCK_ADVICE[ours[1]];
    return advice ? `${ours[2].trim()} ${advice}` : error;
  }

  const codes = match[1]
    .split(',')
    .map((c) => c.trim())
    .filter(Boolean);

  const explained = codes.map((code) => EXPLANATIONS[code]).filter(Boolean);
  if (explained.length) return [...new Set(explained)].join(' ');

  // Unknown to us, but still Meta's refusal and not a mystery about whether it
  // was sent. The code is kept so it can be looked up.
  return `Meta refused this one (code ${codes.join(', ')}). It was sent; they declined to deliver it.`;
}
