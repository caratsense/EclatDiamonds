import { ConfigService } from '@nestjs/config';
import { Prisma } from '@prisma/client';
import { createHmac } from 'node:crypto';

import { MetaAssetOwnershipService } from '../src/integrations/meta-asset-ownership.service';
import { MetaGraphClient } from '../src/integrations/meta-graph.client';
import { META_LEAD_FETCH_JOB, MetaLeadAdsService } from '../src/integrations/meta-lead-ads.service';
import {
  deliveryId,
  extractLeadgenChanges,
  extractWhatsAppDeliveryReceipts,
  MetaWebhookService,
} from '../src/integrations/meta-webhook.service';
import { redactedFailure, WebhookIntakeService } from '../src/integrations/webhook-intake.service';

const ORG = 'org-meta-a';
const INTEGRATION = 'integration-meta-a';
const PAGE = '1234567890123';
const LEAD = '9876543210123';

function config(values: Record<string, string>): ConfigService {
  return { get: (key: string) => values[key] } as ConfigService;
}

function leadWebhook() {
  return {
    object: 'page',
    entry: [
      {
        id: PAGE,
        time: 1_789_000_000,
        changes: [
          {
            field: 'leadgen',
            value: {
              leadgen_id: LEAD,
              page_id: PAGE,
              form_id: '444455556666',
              created_time: 1_789_000_001,
            },
          },
        ],
      },
    ],
  };
}

describe('Meta webhook verification and adapters', () => {
  it('verifies the challenge and raw-body HMAC, and rejects every missing/wrong input', () => {
    const body = Buffer.from(JSON.stringify(leadWebhook()));
    const service = new MetaWebhookService(
      config({ META_WEBHOOK_VERIFY_TOKEN: 'verify-me', META_APP_SECRET: 'app-secret' }),
      {} as never,
      {} as never,
      {} as never,
      {} as never,
      {} as never,
    );
    const signature = `sha256=${createHmac('sha256', 'app-secret').update(body).digest('hex')}`;

    expect(service.verifyLeadAdsChallenge('subscribe', 'verify-me', 'challenge')).toBe('challenge');
    expect(service.verifyLeadAdsChallenge('subscribe', 'wrong', 'challenge')).toBeNull();
    expect(service.verifyLeadAdsSignature(body, signature)).toBe(true);
    expect(service.verifyLeadAdsSignature(body, 'sha256=deadbeef')).toBe(false);
    expect(service.verifyLeadAdsSignature(undefined, signature)).toBe(false);
    expect(
      new MetaWebhookService(config({}), {} as never, {} as never, {} as never, {} as never, {} as never)
        .verifyLeadAdsSignature(body, signature),
    ).toBe(false);
  });

  it('extracts and deduplicates only well-shaped Page leadgen changes', () => {
    const payload = leadWebhook();
    payload.entry[0].changes.push({ ...payload.entry[0].changes[0] });
    expect(extractLeadgenChanges(payload)).toEqual([
      {
        leadgenId: LEAD,
        pageId: PAGE,
        formId: '444455556666',
        createdAt: new Date(1_789_000_001_000),
      },
    ]);
    expect(extractLeadgenChanges({ object: 'user', entry: payload.entry })).toEqual([]);
    expect(extractLeadgenChanges({ object: 'page', entry: [{ id: 'bad', changes: payload.entry[0].changes }] })).toEqual([
      expect.objectContaining({ pageId: PAGE }),
    ]);
  });

  it('normalises delivery receipts without retaining provider error messages', () => {
    const payload = {
      entry: [{ changes: [{ value: { statuses: [{
        id: 'wamid.fixture', status: 'failed', timestamp: '1789000000', recipient_id: '919999999999',
        conversation: { id: 'conversation-provider' }, pricing: { category: 'utility' },
        errors: [{ code: 131047, message: 'customer details must not cross the boundary' }],
      }] } }] }],
    };
    expect(extractWhatsAppDeliveryReceipts(payload)).toEqual([{
      provider: 'whatsapp_cloud',
      externalMessageId: 'wamid.fixture',
      recipientId: '919999999999',
      status: 'failed',
      occurredAt: new Date(1_789_000_000_000),
      conversationId: 'conversation-provider',
      pricingCategory: 'utility',
      providerErrorCodes: ['131047'],
    }]);
    expect(JSON.stringify(extractWhatsAppDeliveryReceipts(payload))).not.toContain('customer details');
  });

  it('uses a deterministic body receipt id without exposing body bytes', () => {
    const body = Buffer.from('{"fixture":"private"}');
    expect(deliveryId(body)).toBe(deliveryId(body));
    expect(deliveryId(body)).toMatch(/^body-sha256:[0-9a-f]{64}$/);
    expect(deliveryId(body)).not.toContain('private');
  });
});

describe('Meta asset ownership', () => {
  const ownerRow = {
    organisationId: ORG,
    integrationId: INTEGRATION,
    integration: { organisationId: ORG },
  };

  it('routes by exactly one active Meta Page owned by its parent integration', async () => {
    const findMany = jest.fn().mockResolvedValue([ownerRow]);
    const service = new MetaAssetOwnershipService(
      { integrationAsset: { findMany } } as never,
      {} as never,
    );
    await expect(service.ownerForPage(PAGE)).resolves.toEqual({
      organisationId: ORG,
      integrationId: INTEGRATION,
    });
    expect(findMany).toHaveBeenCalledWith(expect.objectContaining({
      take: 2,
      where: expect.objectContaining({
        kind: 'page', externalId: PAGE, isActive: true,
        integration: expect.objectContaining({ providerCode: 'meta_ads' }),
      }),
    }));
  });

  it.each([
    [[], 'unowned'],
    [[ownerRow, { ...ownerRow, integrationId: 'other' }], 'ambiguous'],
    [[{ ...ownerRow, organisationId: 'wrong-org' }], 'corrupt'],
  ])('fails closed for %s ownership', async (rows) => {
    const service = new MetaAssetOwnershipService(
      { integrationAsset: { findMany: jest.fn().mockResolvedValue(rows) } } as never,
      {} as never,
    );
    await expect(service.ownerForPage(PAGE)).resolves.toBeNull();
  });

  it('registers an asset with a platform-wide ownership key and no claimed live verification', async () => {
    const upsert = jest.fn().mockResolvedValue({
      id: 'asset-a', kind: 'page', externalId: PAGE, name: 'Main Page', isActive: true,
    });
    const audit = { record: jest.fn().mockResolvedValue(undefined) };
    const service = new MetaAssetOwnershipService(
      {
        integration: { findFirst: jest.fn().mockResolvedValue({ id: INTEGRATION, name: 'Meta' }) },
        $transaction: jest.fn(async (callback) => callback({
          integrationAsset: { findFirst: jest.fn().mockResolvedValue(null), upsert },
        })),
      } as never,
      audit as never,
    );
    await expect(service.register(
      { id: 'user-a', name: 'Owner', organisationId: ORG } as never,
      { integrationId: INTEGRATION, kind: 'page', externalId: PAGE, name: 'Main Page' },
    )).resolves.toMatchObject({ providerOwnershipVerified: false });
    expect(upsert).toHaveBeenCalledWith(expect.objectContaining({
      create: expect.objectContaining({
        organisationId: ORG,
        ownershipKey: `meta_ads:page:${PAGE}`,
        metadata: { providerOwnershipVerified: false },
      }),
    }));
    expect(audit.record).toHaveBeenCalled();
  });
});

describe('Meta Graph client and Lead Ads fetch job', () => {
  afterEach(() => jest.restoreAllMocks());

  it('uses the encrypted registry token only in the Authorization header', async () => {
    const token = 'tenant-token-that-must-not-enter-url';
    const fetchMock = jest.spyOn(global, 'fetch').mockResolvedValue(
      new Response(JSON.stringify({ id: LEAD }), { status: 200 }),
    );
    const client = new MetaGraphClient(
      { integration: { findFirst: jest.fn().mockResolvedValue({ id: INTEGRATION }) } } as never,
      { credentialFor: jest.fn().mockResolvedValue(token) } as never,
      config({ META_GRAPH_API_VERSION: 'v99.0' }),
    );
    await expect(client.getForIntegration(ORG, INTEGRATION, LEAD, { fields: 'id' }))
      .resolves.toEqual({ id: LEAD });
    const [url, options] = fetchMock.mock.calls[0];
    expect(String(url)).toBe(`https://graph.facebook.com/v99.0/${LEAD}?fields=id`);
    expect(String(url)).not.toContain(token);
    expect((options?.headers as Record<string, string>).Authorization).toBe(`Bearer ${token}`);
    expect(options?.redirect).toBe('error');
  });

  it('returns bounded, redacted Graph failures and requires an explicit API version', async () => {
    const client = new MetaGraphClient(
      { integration: { findFirst: jest.fn().mockResolvedValue({ id: INTEGRATION }) } } as never,
      { credentialFor: jest.fn().mockResolvedValue('secret') } as never,
      config({}),
    );
    await expect(client.getForIntegration(ORG, INTEGRATION, LEAD, { fields: 'id' }))
      .rejects.toThrow(/META_GRAPH_API_VERSION/);

    jest.spyOn(global, 'fetch').mockResolvedValue(new Response(JSON.stringify({
      error: { message: 'access_token=do-not-store https://example.test/' + 'A'.repeat(100), code: 190 },
    }), { status: 401 }));
    const configured = new MetaGraphClient(
      { integration: { findFirst: jest.fn().mockResolvedValue({ id: INTEGRATION }) } } as never,
      { credentialFor: jest.fn().mockResolvedValue('secret') } as never,
      config({ META_GRAPH_API_VERSION: 'v99.0' }),
    );
    await expect(configured.getForIntegration(ORG, INTEGRATION, LEAD, { fields: 'id' }))
      .rejects.not.toThrow(/do-not-store|example\.test|AAAA/);
  });

  it('queues one tenant-bound job and maps a fetched form losslessly for the CRM sink', async () => {
    const jobs = { register: jest.fn(), enqueue: jest.fn().mockResolvedValue({ id: 'job-a', deduplicated: false }) };
    const graph = { getForIntegration: jest.fn().mockResolvedValue({
      id: LEAD,
      created_time: '2026-09-09T10:00:00+0000',
      ad_id: '10001', ad_name: 'Appointment campaign', adset_id: '10002',
      adset_name: 'Delhi', campaign_id: '10003', campaign_name: 'September',
      form_id: '444455556666',
      field_data: [
        { name: 'full_name', values: ['Asha Singh'] },
        { name: 'phone_number', values: ['+919876543210'] },
        { name: 'email', values: ['asha@example.test'] },
        { name: 'custom_requirement', values: ['Consultation'] },
      ],
    }) };
    const assets = { ownerForPage: jest.fn().mockResolvedValue({ organisationId: ORG, integrationId: INTEGRATION }) };
    const service = new MetaLeadAdsService(jobs as never, graph as never, assets as never);

    service.onModuleInit();
    expect(jobs.register).toHaveBeenCalledWith(META_LEAD_FETCH_JOB, expect.any(Function));
    await service.enqueue({
      organisationId: ORG, integrationId: INTEGRATION, leadgenId: LEAD,
      pageId: PAGE, formId: '444455556666', webhookCreatedAt: null,
    });
    expect(jobs.enqueue).toHaveBeenCalledWith(expect.objectContaining({
      organisationId: ORG,
      idempotencyKey: `meta-lead:${ORG}:${INTEGRATION}:${LEAD}`,
      maxAttempts: 5,
    }));

    const record = await service.fetchLead({
      organisationId: ORG, integrationId: INTEGRATION, leadgenId: LEAD,
      pageId: PAGE, formId: '444455556666', webhookCreatedAt: null,
    });
    expect(record).toMatchObject({
      fullName: 'Asha Singh', phone: '+919876543210', email: 'asha@example.test',
      adId: '10001', adSetId: '10002', campaignId: '10003',
    });
    expect(record.fields).toContainEqual({ name: 'custom_requirement', values: ['Consultation'] });
  });

  it('revalidates Page ownership before spending a Graph request', async () => {
    const graph = { getForIntegration: jest.fn() };
    const service = new MetaLeadAdsService(
      { register: jest.fn() } as never,
      graph as never,
      { ownerForPage: jest.fn().mockResolvedValue({ organisationId: 'other', integrationId: INTEGRATION }) } as never,
    );
    await expect(service.fetchLead({
      organisationId: ORG, integrationId: INTEGRATION, leadgenId: LEAD,
      pageId: PAGE, formId: null, webhookCreatedAt: null,
    })).rejects.toThrow(/ownership changed/i);
    expect(graph.getForIntegration).not.toHaveBeenCalled();
  });
});

describe('durable webhook intake', () => {
  function uniqueError() {
    return new Prisma.PrismaClientKnownRequestError('duplicate', {
      code: 'P2002', clientVersion: 'fixture', meta: {},
    });
  }

  it('persists and claims before processing, then stamps the resolved tenant', async () => {
    const calls: string[] = [];
    const prisma = {
      webhookEvent: {
        create: jest.fn(async () => { calls.push('persist'); return { id: 'event-a' }; }),
        updateMany: jest.fn(async () => { calls.push('claim'); return { count: 1 }; }),
        update: jest.fn(async ({ data }) => { calls.push(`finish:${data.status}`); return {}; }),
      },
    };
    const service = new WebhookIntakeService(prisma as never);
    await expect(service.intake({
      providerCode: 'meta_ads', externalId: 'delivery-a', signatureVerified: true, payload: {},
    }, async () => { calls.push('process'); return { handled: true, organisationId: ORG, integrationId: INTEGRATION }; }))
      .resolves.toMatchObject({ handled: true, organisationId: ORG });
    expect(calls).toEqual(['persist', 'claim', 'process', 'finish:processed']);
    expect(prisma.webhookEvent.update).toHaveBeenCalledWith(expect.objectContaining({
      data: expect.objectContaining({ organisationId: ORG, integrationId: INTEGRATION }),
    }));
  });

  it('reclaims a failed redelivery, but never reruns a completed delivery', async () => {
    const process = jest.fn().mockResolvedValue({ handled: true });
    const failedPrisma = {
      webhookEvent: {
        create: jest.fn().mockRejectedValue(uniqueError()),
        findUnique: jest.fn().mockResolvedValue({ id: 'event-a', status: 'failed', attempts: 1, processedAt: new Date() }),
        updateMany: jest.fn().mockResolvedValue({ count: 1 }),
        update: jest.fn().mockResolvedValue({}),
      },
    };
    await new WebhookIntakeService(failedPrisma as never).intake({
      providerCode: 'meta_ads', externalId: 'delivery-a', signatureVerified: true, payload: {},
    }, process);
    expect(process).toHaveBeenCalledTimes(1);

    const completePrisma = {
      webhookEvent: {
        create: jest.fn().mockRejectedValue(uniqueError()),
        findUnique: jest.fn().mockResolvedValue({ id: 'event-a', status: 'processed', attempts: 1, processedAt: new Date() }),
        updateMany: jest.fn(),
      },
    };
    await expect(new WebhookIntakeService(completePrisma as never).intake({
      providerCode: 'meta_ads', externalId: 'delivery-a', signatureVerified: true, payload: {},
    }, process)).resolves.toMatchObject({ duplicate: true, reason: 'already processed' });
    expect(process).toHaveBeenCalledTimes(1);
    expect(completePrisma.webhookEvent.updateMany).not.toHaveBeenCalled();
  });

  it('bounds and redacts errors before persistence', () => {
    const safe = redactedFailure(new Error(
      'token=top-secret https://private.example/path ' + 'B'.repeat(200),
    ));
    expect(safe).not.toMatch(/top-secret|private\.example|BBBB/);
    expect(safe.length).toBeLessThanOrEqual(500);
  });
});
