import { evaluateSendableContent } from './omnichannel-policy';

/**
 * A photograph with no caption.
 *
 * A store manager attached a ring to a thread and pressed send three times in
 * under a minute. All three were refused before they reached WhatsApp —
 * "content_missing: The queued message has no text to send." — because the
 * deliverer asked every message for words and a photograph has none. The
 * customer saw nothing, and the screen showed a timer, so she tried again.
 *
 * What these assertions hold down is the pair that is easy to collapse into one
 * rule: an attachment IS content, and a row that only claims one is still
 * refused. Widening the first without keeping the second would send a bubble
 * with nothing in it and report it as delivered.
 */
const content = (over: Partial<Parameters<typeof evaluateSendableContent>[0]> = {}) =>
  evaluateSendableContent({
    hasApprovedTemplate: false,
    body: null,
    hasAttachmentInstruction: false,
    claimsAttachment: false,
    ...over,
  });

describe('a photograph a salesperson sends', () => {
  it('goes with no caption at all', () => {
    expect(content({ hasAttachmentInstruction: true, claimsAttachment: true })).toEqual({
      sendable: true,
    });
  });

  it('goes with a caption too', () => {
    expect(
      content({ hasAttachmentInstruction: true, claimsAttachment: true, body: 'This one, madam' }),
    ).toEqual({ sendable: true });
  });
});

describe('a message with nothing to show the customer', () => {
  it('is refused when it has no text, no template and no attachment', () => {
    const verdict = content();
    expect(verdict.sendable).toBe(false);
    expect(verdict).toMatchObject({ code: 'content_missing' });
  });

  it('is refused when the body is only whitespace', () => {
    expect(content({ body: '   \n ' })).toMatchObject({ code: 'content_missing' });
  });

  it('is refused when its attachment was never stored', () => {
    const verdict = content({ claimsAttachment: true });
    expect(verdict.sendable).toBe(false);
    expect(verdict).toMatchObject({ code: 'attachment_missing' });
  });

  /*
   * The reason the two codes are kept apart: this one tells the manager to
   * attach the picture again, and "nothing to send" would send her looking for
   * words she never meant to type.
   */
  it('names the missing attachment even when there is no caption either', () => {
    expect(content({ claimsAttachment: true, body: null })).toMatchObject({
      code: 'attachment_missing',
    });
  });
});

describe('the messages that could already send', () => {
  it('a plain reply still sends on its text', () => {
    expect(content({ body: 'We open at eleven.' })).toEqual({ sendable: true });
  });

  it('an approved template still sends with no body of its own', () => {
    expect(content({ hasApprovedTemplate: true })).toEqual({ sendable: true });
  });

  it('a quote PDF still sends as a document with its caption', () => {
    expect(
      content({
        hasApprovedTemplate: true,
        hasAttachmentInstruction: true,
        claimsAttachment: true,
        body: 'Quote QT-2011 from DELHI ROHINI',
      }),
    ).toEqual({ sendable: true });
  });
});
