import { OmnichannelService, OMNICHANNEL_DELIVERY_JOB } from '../src/omnichannel/omnichannel.service';
import { evaluateDeliveryPolicy } from '../src/omnichannel/omnichannel-policy';

describe('omnichannel delivery policy', () => {
  const now = new Date('2026-09-09T12:00:00.000Z');

  it('allows a service reply inside WhatsApp customer-care window', () => {
    expect(evaluateDeliveryPolicy({
      channel: 'whatsapp',
      purpose: 'service',
      consent: 'unknown',
      hasApprovedTemplate: false,
      lastInboundAt: new Date('2026-09-08T12:00:01.000Z'),
      now,
    })).toEqual({ allowed: true, mode: 'free_text' });
  });

  it('requires a template once the 24-hour window has elapsed', () => {
    expect(evaluateDeliveryPolicy({
      channel: 'whatsapp',
      purpose: 'service',
      consent: 'unknown',
      hasApprovedTemplate: false,
      lastInboundAt: new Date('2026-09-08T11:59:59.000Z'),
      now,
    })).toMatchObject({ allowed: false, code: 'template_required' });
  });

  it('does not treat a future inbound timestamp as an open window', () => {
    expect(evaluateDeliveryPolicy({
      channel: 'whatsapp',
      purpose: 'service',
      consent: 'unknown',
      hasApprovedTemplate: false,
      lastInboundAt: new Date('2026-09-09T12:00:01.000Z'),
      now,
    })).toMatchObject({ allowed: false, code: 'template_required' });
  });

  it('requires explicit marketing consent even with an approved template', () => {
    expect(evaluateDeliveryPolicy({
      channel: 'whatsapp',
      purpose: 'marketing',
      consent: 'unknown',
      hasApprovedTemplate: true,
      now,
    })).toMatchObject({ allowed: false, code: 'consent_required' });
  });

  it('lets an opted-out recipient block service and marketing sends', () => {
    for (const purpose of ['service', 'marketing'] as const) {
      expect(evaluateDeliveryPolicy({
        channel: 'whatsapp',
        purpose,
        consent: 'revoked',
        hasApprovedTemplate: true,
        now,
      })).toMatchObject({ allowed: false, code: 'recipient_opted_out' });
    }
  });

  it('allows consented marketing through an approved template', () => {
    expect(evaluateDeliveryPolicy({
      channel: 'whatsapp',
      purpose: 'marketing',
      consent: 'granted',
      hasApprovedTemplate: true,
      now,
    })).toEqual({ allowed: true, mode: 'template' });
  });

  it('refuses channels whose transport is not actually implemented', () => {
    expect(evaluateDeliveryPolicy({
      channel: 'instagram',
      purpose: 'service',
      consent: 'granted',
      hasApprovedTemplate: true,
      now,
    })).toMatchObject({ allowed: false, code: 'channel_not_connected' });
  });
});

describe('omnichannel durable worker', () => {
  const conversation = {
    id: 'conversation-a',
    organisationId: 'org-a',
    partyId: 'party-a',
    storeId: 'store-a',
    channel: 'whatsapp',
    externalThreadId: '919999999999',
    lastInboundAt: new Date(),
    party: {
      id: 'party-a',
      phone: null,
      whatsapp: '919999999999',
      contactPoints: [],
    },
  };

  function harness(sendResult: Record<string, unknown>, messageOverrides: Record<string, unknown> = {}) {
    let handler: ((payload: unknown, ctx: any) => Promise<unknown>) | undefined;
    const updates: any[] = [];
    const prisma = {
      message: {
        findFirst: jest.fn(async () => ({
          id: 'message-a',
          organisationId: 'org-a',
          conversationId: conversation.id,
          direction: 'outbound',
          authorType: 'agent',
          body: 'Hello',
          mediaUrl: null,
          mediaType: null,
          status: 'queued',
          payload: { omnichannel: { purpose: 'service' } },
          conversation,
          ...messageOverrides,
        })),
        update: jest.fn(async (input) => {
          updates.push(input);
          return { id: 'message-a', ...input.data };
        }),
      },
      activityEvent: { findMany: jest.fn(async () => []) },
    };
    const jobs = {
      register: jest.fn((kind, fn) => {
        expect(kind).toBe(OMNICHANNEL_DELIVERY_JOB);
        handler = fn;
      }),
    };
    const whatsapp = {
      sendText: jest.fn(async () => sendResult),
      sendTemplate: jest.fn(async () => sendResult),
    };
    const activity = { record: jest.fn(async () => ({ id: 'activity-a' })) };
    const service = new OmnichannelService(
      prisma as any,
      jobs as any,
      {} as any,
      activity as any,
      {} as any,
      whatsapp as any,
      // Identity resolution is only used by the send-to-a-bare-number path,
      // which this harness never exercises.
      {} as any,
    );
    service.onModuleInit();
    return { handler: () => handler!, updates, prisma, whatsapp, activity };
  }

  it('marks sent only after the provider accepts and returns its message id', async () => {
    const h = harness({
      delivered: true,
      dryRun: false,
      messageId: 'wamid.accepted',
      credentialScope: 'tenant',
    });
    const result = await h.handler()(
      { messageId: 'message-a' },
      { jobId: 'job-a', organisationId: 'org-a', attempt: 1, kind: OMNICHANNEL_DELIVERY_JOB },
    );

    expect(h.whatsapp.sendText).toHaveBeenCalledWith('org-a', '919999999999', 'Hello');
    expect(h.updates.at(-1).data).toMatchObject({ status: 'sent', externalId: 'wamid.accepted', error: null });
    expect(result).toMatchObject({ delivered: true, status: 'sent' });
  });

  it('fails closed without calling a provider outside the free-text window', async () => {
    const h = harness(
      { delivered: true, dryRun: false, messageId: 'should-not-send' },
      { conversation: { ...conversation, lastInboundAt: new Date(Date.now() - 25 * 60 * 60 * 1000) } },
    );
    const result = await h.handler()(
      { messageId: 'message-a' },
      { jobId: 'job-a', organisationId: 'org-a', attempt: 1, kind: OMNICHANNEL_DELIVERY_JOB },
    );

    expect(h.whatsapp.sendText).not.toHaveBeenCalled();
    expect(h.updates.at(-1).data).toMatchObject({ status: 'failed' });
    expect(result).toMatchObject({ delivered: false, blocked: true, code: 'template_required' });
  });

  it('keeps transient failures retryable, then marks the fifth failure failed', async () => {
    const first = harness({ delivered: false, dryRun: false, error: 'HTTP 503' });
    await expect(first.handler()(
      { messageId: 'message-a' },
      { jobId: 'job-a', organisationId: 'org-a', attempt: 1, kind: OMNICHANNEL_DELIVERY_JOB },
    )).rejects.toThrow('HTTP 503');
    expect(first.updates.at(-1).data).toMatchObject({ status: 'queued', error: 'HTTP 503' });

    const last = harness({ delivered: false, dryRun: false, error: 'HTTP 503' });
    await expect(last.handler()(
      { messageId: 'message-a' },
      { jobId: 'job-a', organisationId: 'org-a', attempt: 5, kind: OMNICHANNEL_DELIVERY_JOB },
    )).rejects.toThrow('HTTP 503');
    expect(last.updates.at(-1).data).toMatchObject({ status: 'failed', error: 'HTTP 503' });
  });

  it('always scopes the worker lookup by the tenant carried by the job', async () => {
    const h = harness({ delivered: true, dryRun: false, messageId: 'wamid.1' });
    await h.handler()(
      { messageId: 'message-a' },
      { jobId: 'job-a', organisationId: 'org-a', attempt: 1, kind: OMNICHANNEL_DELIVERY_JOB },
    );
    const firstLookup = (h.prisma.message.findFirst.mock.calls as any[][])[0][0];
    expect(firstLookup.where).toMatchObject({
      id: 'message-a',
      organisationId: 'org-a',
      direction: 'outbound',
    });
  });
});
