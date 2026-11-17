import { CampaignBotService, composeOpener } from './campaign-bot.service';

/**
 * What a lead-form customer is actually sent back.
 *
 * Written to check an instruction before it went to the client: "leave the
 * questions empty and write a reply that uses their details, otherwise the bot
 * asks again for what they just filled in". That is advice about behaviour, so
 * it needed testing rather than asserting.
 *
 * The customer's FIRST message already carries the form:
 *
 *   Hello! I filled in your form and would like to know more about your
 *   business.
 *   Full name: … / When is your wedding?: 3-6 months
 *   Budget: ₹50,000 — ₹1,00,000 / Preferred Store: Nibhana, Bandra Linking
 *
 * so a configured question lands on somebody who has just answered it.
 */

const rule = (over: Record<string, unknown> = {}) =>
  ({
    id: 'rule-1',
    name: '16/11 - bridal lead - Broadway',
    enabled: true,
    handling: 'bot',
    firstReply: 'Thanks Dinesh — we have your details and a consultant is looking at necklace sets now.',
    questions: [],
    closingMessage: null,
    ...over,
  }) as never;

const WEDDING = { text: 'When is your wedding?', options: ['0-3 months', '3-6 months'] };

describe('the opener, when the campaign has no questions', () => {
  it('sends the reply and nothing else', () => {
    const out = composeOpener(
      'Thanks Dinesh — a consultant is looking at necklace sets for you now.',
      [],
    );
    expect(out.text).toBe('Thanks Dinesh — a consultant is looking at necklace sets for you now.');
    expect(out.asksFirstQuestion).toBe(false);
  });

  it('is the same when questions are null or undefined', () => {
    for (const q of [null, undefined]) {
      expect(composeOpener('Thanks — we have your details.', q).asksFirstQuestion).toBe(false);
    }
  });

  it('never appends a question, so nothing is re-asked', () => {
    const out = composeOpener('Thanks — we have everything we need.', []);
    expect(out.text).not.toMatch(/\?/);
  });
});

describe('the opener, when the campaign does have questions', () => {
  it('asks the first one on that same first reply', () => {
    // This is the behaviour the client is being warned about: the customer
    // typed their wedding date into the form and is immediately asked for it.
    const out = composeOpener('Thanks for your enquiry.', [WEDDING]);
    expect(out.asksFirstQuestion).toBe(true);
    expect(out.text).toContain('Thanks for your enquiry.');
    // Rendered with its options inline, which makes the re-ask worse rather
    // than better: the customer is offered the choice they already picked.
    expect(out.text).toContain('When is your wedding');
    expect(out.text).toContain('3-6 months');
  });

  it('separates the question from the opener', () => {
    const out = composeOpener('Thanks for your enquiry.', [WEDDING]);
    expect(out.text.split('\n\n').length).toBe(2);
  });

  it('holds the question back when the opener already ends in one', () => {
    // Not lost — asked on the next turn. The caller only stamps a question
    // when this reports asking one, which is what keeps the count honest.
    const out = composeOpener('Thanks! Which piece caught your eye?', [WEDDING]);
    expect(out.asksFirstQuestion).toBe(false);
    expect(out.text).toBe('Thanks! Which piece caught your eye?');
  });
});

describe('the turn after the opener', () => {
  const scriptedTurn = (r: unknown, asked: number) => {
    const svc = Object.create(CampaignBotService.prototype) as CampaignBotService;
    (svc as unknown as { prisma: unknown }).prisma = { message: { count: async () => asked } };
    return (
      svc as unknown as {
        scriptedTurn: (o: string, c: string, r: unknown) => Promise<Record<string, unknown>>;
      }
    ).scriptedTurn('org1', 'conv1', r);
  };

  it('with no questions, closes and hands to a person', async () => {
    const out = await scriptedTurn(rule({ closingMessage: 'A consultant will message you shortly.' }), 0);
    expect(out.text).toBe('A consultant will message you shortly.');
    expect((out.handoff as { reason: string }).reason).toMatch(/no questions/);
  });

  it('with no questions and no closing message, still hands over', async () => {
    const out = await scriptedTurn(rule(), 0);
    expect(out.text).toBeTruthy();
    expect(out.handoff).toBeDefined();
  });

  it('with questions, asks the next one instead of closing', async () => {
    const out = await scriptedTurn(rule({ questions: [WEDDING, { text: 'Your budget?' }] }), 1);
    expect(out.text).toContain('Your budget?');
    expect(out.handoff).toBeUndefined();
  });

  it('hands over once the questions run out', async () => {
    const out = await scriptedTurn(rule({ questions: [WEDDING] }), 1);
    expect((out.handoff as { reason: string }).reason).toMatch(/asked all 1/);
  });
});
