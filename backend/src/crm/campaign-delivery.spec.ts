import { campaignOutcome, nextRecipientStatus } from './campaign-delivery';

/**
 * The incident this is written against, in the numbers it was reported in: a
 * broadcast of 126 people said "125 of 126 sent" on the campaign screen while
 * Meta had refused all 125 with "(#132012) Parameter format does not match
 * format in the created template". Nobody received anything.
 *
 * So the cases pinned here are the ones a person reads off a screen and acts
 * on: a message that fails later must end as failed, a message that arrives
 * must end as delivered, and a broadcast where every message was refused must
 * not read as a send.
 */

describe('what a recipient becomes when its message settles', () => {
  it('stays queued while the outbox has not called the provider yet', () => {
    expect(
      nextRecipientStatus({ current: 'queued', attempts: 1, messageStatus: 'queued' }),
    ).toBeNull();
  });

  it('becomes sent only once the provider has accepted it', () => {
    expect(nextRecipientStatus({ current: 'queued', attempts: 1, messageStatus: 'sent' })).toBe(
      'sent',
    );
  });

  it('ends as failed when the message fails after it was queued', () => {
    expect(nextRecipientStatus({ current: 'queued', attempts: 1, messageStatus: 'failed' })).toBe(
      'failed',
    );
  });

  it('ends as failed even after the outbox had reported it sent', () => {
    // Meta accepts a message and rejects it on its own side moments later. The
    // recipient row has to be able to move back off a send it did not make.
    expect(nextRecipientStatus({ current: 'sent', attempts: 1, messageStatus: 'failed' })).toBe(
      'failed',
    );
  });

  it('gives up on a recipient that has already been tried twice', () => {
    expect(nextRecipientStatus({ current: 'queued', attempts: 2, messageStatus: 'failed' })).toBe(
      'dead',
    );
  });

  it('ends as delivered when the receipt says it arrived', () => {
    expect(nextRecipientStatus({ current: 'sent', attempts: 1, messageStatus: 'delivered' })).toBe(
      'delivered',
    );
  });

  it('reaches delivered even when the sent receipt never arrived', () => {
    expect(
      nextRecipientStatus({ current: 'queued', attempts: 1, messageStatus: 'delivered' }),
    ).toBe('delivered');
  });

  it('does not let a late sent receipt unsay a read', () => {
    expect(nextRecipientStatus({ current: 'read', attempts: 1, messageStatus: 'sent' })).toBeNull();
  });

  it('does not let a late failure unsay a delivery', () => {
    // The provider cannot un-deliver a message it already delivered, and a
    // customer who has the message on their phone is not a failure to chase.
    expect(
      nextRecipientStatus({ current: 'delivered', attempts: 1, messageStatus: 'failed' }),
    ).toBeNull();
  });

  it('ignores an inbound message status, which belongs to nobody here', () => {
    expect(
      nextRecipientStatus({ current: 'queued', attempts: 1, messageStatus: 'received' }),
    ).toBeNull();
  });
});

describe('what the campaign itself says', () => {
  it('is still sending while any recipient is queued with the provider', () => {
    // The moment the send loop runs out of rows to hand over. Nothing has
    // failed yet BECAUSE nothing has been answered yet; calling this
    // 'completed' is the bug.
    expect(campaignOutcome({ queued: 126 })).toEqual({ settled: false, status: 'sending' });
  });

  it('is still sending while recipients are waiting to be handed over', () => {
    expect(campaignOutcome({ pending: 26, sent: 100 })).toEqual({
      settled: false,
      status: 'sending',
    });
  });

  it('reads as failed when every message was refused', () => {
    // The broadcast that started this: 125 refused by Meta, one that never got
    // out of the door, 78 people deliberately not messaged.
    expect(campaignOutcome({ failed: 126, excluded: 78 })).toEqual({
      settled: true,
      status: 'failed',
    });
  });

  it('reads as failed when every message was given up on', () => {
    expect(campaignOutcome({ dead: 126 })).toEqual({ settled: true, status: 'failed' });
  });

  it('reads as partially failed when some arrived and some did not', () => {
    expect(campaignOutcome({ delivered: 100, failed: 26 })).toEqual({
      settled: true,
      status: 'partially_failed',
    });
  });

  it('completes when every message the provider took was accepted', () => {
    expect(campaignOutcome({ sent: 10, delivered: 90, read: 26, excluded: 4 })).toEqual({
      settled: true,
      status: 'completed',
    });
  });

  it('completes a campaign everybody was excluded from, having sent nothing', () => {
    expect(campaignOutcome({ excluded: 126 })).toEqual({ settled: true, status: 'completed' });
  });
});
