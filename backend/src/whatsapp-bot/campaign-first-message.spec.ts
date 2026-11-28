import { firstCustomerMessage } from './campaign-bot.service';

/**
 * The report, 28 November: "the bot is not sending the message as we have set
 * on the bot script".
 *
 * The three live bridal rules have `firstReply: null`, no questions and only a
 * closing message, so the first message every customer receives IS that
 * closing message. The sender was right; the editor was not saying it. These
 * cases are what the editor now shows, so the screen and the sender cannot
 * drift apart without one of them failing here.
 */
describe('the first message a customer receives from a rule', () => {
  it('sends the first reply verbatim when one is written', () => {
    expect(
      firstCustomerMessage({
        firstReply: 'Hi! The solitaire from our ad starts at ₹85,000 for 0.5 carat.',
      }),
    ).toEqual({
      source: 'firstReply',
      text: 'Hi! The solitaire from our ad starts at ₹85,000 for 0.5 carat.',
    });
  });

  it('attaches the first question to that opener', () => {
    // Same rule the sender applies: one message, not two, and only when the
    // opener does not already end by asking something.
    expect(
      firstCustomerMessage({
        firstReply: 'Hi! Our bridal sets start at ₹1,20,000.',
        questions: [{ text: 'Which carat size are you considering?' }],
      }),
    ).toEqual({
      source: 'firstReply',
      text: 'Hi! Our bridal sets start at ₹1,20,000.\n\nWhich carat size are you considering?',
    });
    expect(
      firstCustomerMessage({
        firstReply: 'Hi! What are you shopping for?',
        questions: [{ text: 'Which carat size are you considering?' }],
      }).text,
    ).toBe('Hi! What are you shopping for?');
  });

  it('opens with the CLOSING message when that is all there is', () => {
    // The exact shape of all three bridal campaigns, and the whole of the 28
    // Nov complaint: she receives her closing line as the first message,
    // because there is nothing before it.
    expect(
      firstCustomerMessage({
        firstReply: null,
        questions: [],
        closingMessage: "Hello! Thank you for your interest in Nibhana's bridal collection.",
      }),
    ).toEqual({
      source: 'closingMessage',
      text: "Hello! Thank you for your interest in Nibhana's bridal collection.",
    });
  });

  it('opens with the first question when there is no first reply', () => {
    expect(firstCustomerMessage({ questions: [{ text: 'Which branch is nearest you?' }] })).toEqual({
      source: 'question',
      text: 'Which branch is nearest you?',
    });
    // Choices ride inside the sentence, never as a menu — same phrasing the
    // sender uses, so the preview cannot show a question it would not ask.
    expect(
      firstCustomerMessage({
        questions: [{ text: 'Which carat size?', options: ['under 1', '1 to 1.5', 'above 1.5'] }],
      }),
    ).toEqual({
      source: 'question',
      text: 'Which carat size — under 1, 1 to 1.5, above 1.5?',
    });
  });

  it('cannot promise an exact text once the assistant answers unopened', () => {
    // AI replies on with no opener: the model answers the customer's first
    // message from the brief, so the editor must not print a script.
    expect(
      firstCustomerMessage({ aiReplies: true, questions: [{ text: 'Which carat size?' }] }),
    ).toEqual({ source: 'assistant', text: null });
  });

  it('says nothing goes out when nothing is configured', () => {
    expect(firstCustomerMessage({})).toEqual({ source: 'none', text: null });
    expect(
      firstCustomerMessage({ firstReply: null, questions: [], closingMessage: null }),
    ).toEqual({ source: 'none', text: null });
    // Whitespace is not a configured message, here as in the sender's gate.
    expect(firstCustomerMessage({ firstReply: '', closingMessage: '   ' })).toEqual({
      source: 'none',
      text: null,
    });
  });

  it('says nothing goes out from a rule that is off or human-only', () => {
    // Both carry a written script that will never be sent — the one case where
    // a fully filled-in editor must still read as silent, and for a reason the
    // writer can act on rather than one flat "nothing".
    expect(
      firstCustomerMessage({ enabled: false, firstReply: 'Hi! Our bridal sets start at ₹1,20,000.' }),
    ).toEqual({ source: 'off', text: null });
    expect(
      firstCustomerMessage({
        handling: 'human',
        firstReply: 'Hi! Our bridal sets start at ₹1,20,000.',
      }),
    ).toEqual({ source: 'humanOnly', text: null });
  });

  it('calls out a script whose message would arrive empty', () => {
    // A first reply of nothing but spaces counts as configured (the closing
    // message opted the rule in) and is sent as it stands, so the customer
    // gets a blank WhatsApp message. The editor has to shout about this one.
    expect(
      firstCustomerMessage({ firstReply: '   ', closingMessage: 'Our team will reply here.' }),
    ).toEqual({ source: 'blank', text: '   ' });
  });
});
