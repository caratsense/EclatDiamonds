import { planReadReceipt, type InboundReadCandidate } from './read-receipt';

/**
 * What the blue tick is allowed to claim.
 *
 * The client asked for read receipts so her customers can tell whether anyone
 * has actually seen them. That makes the interesting cases the ones where a tick
 * would be a LIE — a message already acknowledged, a thread with nothing to
 * acknowledge on — rather than the happy path.
 *
 * The other rule held down here is the one that decides how many Graph calls a
 * thread costs: the Cloud API marks earlier messages read alongside the one it
 * is given, so nine waiting messages must produce exactly one receipt naming the
 * newest, never nine.
 */
const inbound = (over: Partial<InboundReadCandidate> = {}): InboundReadCandidate => ({
  id: 'm1',
  externalId: 'wamid.1',
  status: 'received',
  sentAt: new Date('2026-11-16T09:00:00Z'),
  ...over,
});

describe('a customer waiting to see whether anyone looked', () => {
  it('acknowledges the message they sent', () => {
    expect(
      planReadReceipt({ channel: 'whatsapp', externalThreadId: '919812345678', inbound: [inbound()] }),
    ).toEqual({
      acknowledge: {
        messageId: 'm1',
        providerMessageId: 'wamid.1',
        sentAt: new Date('2026-11-16T09:00:00Z'),
      },
    });
  });

  it('acknowledges only the NEWEST of several — Graph ticks the earlier ones with it', () => {
    const plan = planReadReceipt({
      channel: 'whatsapp',
      externalThreadId: '919812345678',
      inbound: [
        inbound({ id: 'm1', externalId: 'wamid.1', sentAt: new Date('2026-11-16T09:00:00Z') }),
        inbound({ id: 'm3', externalId: 'wamid.3', sentAt: new Date('2026-11-16T09:04:00Z') }),
        inbound({ id: 'm2', externalId: 'wamid.2', sentAt: new Date('2026-11-16T09:02:00Z') }),
      ],
    });
    expect(plan.acknowledge?.messageId).toBe('m3');
    expect(plan.acknowledge?.providerMessageId).toBe('wamid.3');
  });

  it('acknowledges the newest UNREAD one when an older tick already went', () => {
    const plan = planReadReceipt({
      channel: 'whatsapp',
      externalThreadId: '919812345678',
      inbound: [
        inbound({ id: 'm1', externalId: 'wamid.1', status: 'read' }),
        inbound({
          id: 'm2',
          externalId: 'wamid.2',
          sentAt: new Date('2026-11-16T09:02:00Z'),
        }),
      ],
    });
    expect(plan.acknowledge?.messageId).toBe('m2');
  });
});

describe('when a tick would say something untrue', () => {
  it('sends nothing for a thread where every message is already marked read', () => {
    expect(
      planReadReceipt({
        channel: 'whatsapp',
        externalThreadId: '919812345678',
        inbound: [inbound({ status: 'read' })],
      }),
    ).toEqual({
      acknowledge: null,
      reason: 'Everything the customer has sent is already marked read.',
    });
  });

  it('sends nothing for a thread the customer has never written on', () => {
    expect(
      planReadReceipt({ channel: 'whatsapp', externalThreadId: '919812345678', inbound: [] })
        .acknowledge,
    ).toBeNull();
  });

  it('skips a message with no provider id — Graph could not resolve it', () => {
    expect(
      planReadReceipt({
        channel: 'whatsapp',
        externalThreadId: '919812345678',
        inbound: [inbound({ externalId: null })],
      }).acknowledge,
    ).toBeNull();
  });

  it('sends nothing on a channel with no such call', () => {
    expect(
      planReadReceipt({ channel: 'instagram', externalThreadId: 'ig-123', inbound: [inbound()] }),
    ).toEqual({
      acknowledge: null,
      reason: 'Only WhatsApp can show the customer a read receipt.',
    });
  });

  it('sends nothing when the thread has no number to acknowledge on', () => {
    expect(
      planReadReceipt({ channel: 'whatsapp', externalThreadId: null, inbound: [inbound()] })
        .acknowledge,
    ).toBeNull();
  });
});
