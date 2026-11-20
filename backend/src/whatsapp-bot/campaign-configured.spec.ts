import { hasConfiguredConversation } from './campaign-bot.service';

/**
 * The incident, 20 November: three live bridal campaigns, each with a closing
 * message written for it and nothing else. All three were read as
 * unconfigured, so every customer who tapped those adverts fell through to the
 * legacy button questionnaire — "What are you looking for today?", four
 * options — a script the client had removed long before, sent to people who
 * had already filled in her lead form.
 *
 * Her instruction for what should have happened: only the closing message, and
 * then the thread goes to the branch that ad ran for.
 */

describe('whether a campaign conversation counts as configured', () => {
  it('counts a campaign that set only a closing message', () => {
    // The exact shape of all three bridal campaigns.
    expect(
      hasConfiguredConversation({
        firstReply: '',
        questions: [],
        closingMessage: "Hello! Thank you for your interest in Nibhana's bridal collection.",
      }),
    ).toBe(true);
  });

  it('counts a campaign that set only questions', () => {
    expect(hasConfiguredConversation({ questions: [{ prompt: 'Which carat size?' }] })).toBe(true);
  });

  it('counts a campaign that set only a first reply', () => {
    expect(hasConfiguredConversation({ firstReply: 'Hi! The ring from our ad starts at ₹85,000.' })).toBe(
      true,
    );
  });

  it('leaves a rule that predates the editor alone', () => {
    // The whole point of the original narrow test, and still true: a routing
    // rule with none of the editor's fields must keep its old behaviour.
    expect(hasConfiguredConversation({})).toBe(false);
    expect(hasConfiguredConversation({ firstReply: null, questions: null, closingMessage: null })).toBe(
      false,
    );
  });

  it('does not count whitespace as a configured message', () => {
    expect(hasConfiguredConversation({ firstReply: '   ', closingMessage: '\n' })).toBe(false);
  });
});
