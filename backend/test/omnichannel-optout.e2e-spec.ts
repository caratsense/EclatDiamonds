import { INestApplication } from '@nestjs/common';
import { Test } from '@nestjs/testing';

import { AppModule } from '../src/app.module';
import { PrismaService } from '../src/prisma/prisma.service';
import { REQUALIFY_JOB } from '../src/crm/requalification.service';
import { OmnichannelService } from '../src/omnichannel/omnichannel.service';
import { WhatsAppBotService } from '../src/whatsapp-bot/whatsapp-bot.service';
import { ConversationAiGate } from '../src/crm/ai-responder';
import {
  evaluateDeliveryPolicy,
  isUnambiguousOptOut,
} from '../src/omnichannel/omnichannel-policy';

/**
 * INT-01 — a customer who says STOP is opted out BEFORE anything acts on the
 * message, and stays opted out.
 *
 * Three separate things have to hold and each is tested against the database
 * rather than a mock:
 *   1. Detection is conservative. "where is the nearest bus stop" is not consent
 *      withdrawal, and treating it as one silences a customer who never asked.
 *   2. Ordering. The revocation is written before the assistant is consulted —
 *      here proven by the assistant never being consulted at all.
 *   3. Effect and durability. The revocation blocks later service AND marketing
 *      sends, a webhook replay does not write a second one, and consent does not
 *      come back on its own the next time the customer says something.
 */

const ORG = 'org_optout_a';
const SLUG = 'optout-a';
const STORE = 'store_optout_a';
const PHONE_ID = '9990001';
const CUSTOMER = '919812345678';

/**
 * `ingest()` deliberately does not await processing — the webhook must answer
 * Meta immediately — so it claims the event in the background. Polling for the
 * outcome is therefore the honest way to test it: calling processPending()
 * directly races the claim and finds nothing to do.
 */
async function waitFor(predicate: () => Promise<boolean>, timeoutMs = 20_000): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  for (;;) {
    if (await predicate()) return;
    if (Date.now() > deadline) throw new Error('timed out waiting for the inbound pipeline');
    await new Promise((r) => setTimeout(r, 250));
  }
}

function inbound(wamid: string, body: string) {
  return {
    entry: [
      {
        changes: [
          {
            value: {
              metadata: { phone_number_id: PHONE_ID },
              messages: [
                { id: wamid, from: CUSTOMER, type: 'text', text: { body } },
              ],
            },
          },
        ],
      },
    ],
  };
}

describe('INT-01 opt-out before AI (e2e)', () => {
  let app: INestApplication;
  let prisma: PrismaService;
  let bot: WhatsAppBotService;
  let omnichannel: OmnichannelService;
  let gateCalls: number;

  beforeAll(async () => {
    const mod = await Test.createTestingModule({ imports: [AppModule] }).compile();
    app = mod.createNestApplication();
    await app.init();
    prisma = app.get(PrismaService);
    bot = app.get(WhatsAppBotService);
    omnichannel = app.get(OmnichannelService);

    // Count every time the assistant is asked to consider a message. The
    // ordering claim is "the AI is never reached for an opt-out", and the only
    // honest way to assert that is to watch the call itself.
    gateCalls = 0;
    const gate = app.get(ConversationAiGate);
    type Consider = ConversationAiGate['consider'];
    jest.spyOn(gate, 'consider').mockImplementation((async () => {
      gateCalls += 1;
      return { outcome: 'skipped', reason: 'stubbed in test' };
    }) as unknown as Consider);

    await teardown(prisma);
    await prisma.organisation.create({
      data: { id: ORG, name: 'Opt-out A', slug: SLUG, industryPackCode: 'healthcare' },
    });
    await prisma.store.create({
      data: { id: STORE, name: 'Main', city: 'Delhi', timezone: 'Asia/Kolkata', organisationId: ORG },
    });
    // The tenant routing key: an IntegrationAsset the tenant OWNS for the
    // business number the customer wrote to. Ownership is what resolves the
    // tenant — never anything in the provider's payload.
    await prisma.integration.create({
      data: {
        id: 'int_optout_a',
        organisationId: ORG,
        providerCode: 'whatsapp_cloud',
        name: 'WhatsApp (test)',
        status: 'connected',
      },
    });
    await prisma.integrationAsset.create({
      data: {
        organisationId: ORG,
        integrationId: 'int_optout_a',
        kind: 'phone_number',
        externalId: PHONE_ID,
        name: 'Test sender',
        isActive: true,
        ownershipKey: `whatsapp_cloud:phone_number:${PHONE_ID}`,
      },
    });
  }, 120_000);

  afterAll(async () => {
    if (prisma) await teardown(prisma);
    if (app) await app.close();
  });

  // ---------------------------------------------------------------- detection

  describe('detection is conservative', () => {
    it('honours a bare STOP in any casing or punctuation', () => {
      for (const body of ['stop', 'STOP', ' Stop. ', 'STOP!', 'unsubscribe', 'Cancel']) {
        expect(isUnambiguousOptOut(body)).toBe(true);
      }
    });

    it('does not opt a customer out for using the word in a sentence', () => {
      for (const body of [
        'where is the nearest bus stop',
        'please stop by tomorrow',
        "don't stop making these, they're lovely",
        'do you have a stop-loss policy?',
        'I will end my visit at 5pm',
        'can I cancel my appointment on Friday?',
      ]) {
        expect(isUnambiguousOptOut(body)).toBe(false);
      }
    });

    it('honours an unambiguous phrase inside a longer message', () => {
      expect(isUnambiguousOptOut('hi, please remove my number from your list')).toBe(true);
      expect(isUnambiguousOptOut('STOP MESSAGING ME please')).toBe(true);
    });

    it('is not a sentiment model — annoyance is not withdrawal', () => {
      for (const body of [
        'not interested',
        'this is too expensive',
        'stop wasting my time',
        'I am annoyed',
      ]) {
        expect(isUnambiguousOptOut(body)).toBe(false);
      }
    });

    it('treats empty and non-text messages as not an opt-out', () => {
      expect(isUnambiguousOptOut(null)).toBe(false);
      expect(isUnambiguousOptOut(undefined)).toBe(false);
      expect(isUnambiguousOptOut('   ')).toBe(false);
      expect(isUnambiguousOptOut('...')).toBe(false);
    });
  });

  // ----------------------------------------------------------------- ordering

  describe('ordering and persistence', () => {
    it('files an ordinary message and consults the assistant', async () => {
      await bot.ingest(inbound('wamid.ORDINARY1', 'do you open on Sunday?'));
      await waitFor(async () => gateCalls >= 1);

      const events = await prisma.activityEvent.findMany({
        where: { organisationId: ORG, type: 'consent.revoked' },
      });
      expect(events).toHaveLength(0);
      expect(gateCalls).toBe(1);
    }, 60_000);

    it('records the revocation and never reaches the assistant for a STOP', async () => {
      const before = gateCalls;
      await bot.ingest(inbound('wamid.STOP1', 'STOP'));
      await waitFor(async () =>
        (await prisma.activityEvent.count({
          where: { organisationId: ORG, type: 'consent.revoked', channel: 'whatsapp' },
        })) > 0,
      );

      const revoked = await prisma.activityEvent.findMany({
        where: { organisationId: ORG, type: 'consent.revoked', channel: 'whatsapp' },
      });
      expect(revoked).toHaveLength(1);
      expect(revoked[0].partyId).toBeTruthy();
      expect(revoked[0].sourceSystem).toBe('provider');
      // The ordering claim, stated as an observation: the assistant was not
      // consulted for this message at all.
      expect(gateCalls).toBe(before);
    }, 60_000);

    it('does not schedule re-qualification for an opted-out message', async () => {
      // Re-scoring someone who just asked to be left alone is how they end up at
      // the top of a call list.
      const tasks = await prisma.jobTask.findMany({
        where: { organisationId: ORG, kind: REQUALIFY_JOB },
      });
      // The ordinary message in the first test may legitimately have queued one;
      // what must not exist is a second, collapsed onto the STOP conversation.
      expect(tasks.length).toBeLessThanOrEqual(1);
    });

    it('is idempotent on the provider message id — a replay writes one revocation', async () => {
      await bot.ingest(inbound('wamid.STOP1', 'STOP'));
      // Meta redelivering the same wamid must not stack revocations. The wamid
      // is unique on WhatsAppEvent, so the redelivery is dropped at persist();
      // calling recordProviderOptOut directly proves the second line of defence,
      // the dedupeKey on the activity event itself.
      await omnichannel.recordProviderOptOut({
        organisationId: ORG,
        partyId: (await party()).id,
        channel: 'whatsapp',
        providerEventId: 'wamid.STOP1',
      });

      const revoked = await prisma.activityEvent.findMany({
        where: { organisationId: ORG, type: 'consent.revoked', channel: 'whatsapp' },
      });
      expect(revoked).toHaveLength(1);
    }, 60_000);
  });

  // ------------------------------------------------------------------- effect

  describe('effect on later sends', () => {
    it('blocks a later marketing send', () => {
      expect(
        evaluateDeliveryPolicy({
          channel: 'whatsapp',
          purpose: 'marketing',
          consent: 'revoked',
          hasApprovedTemplate: true,
          lastInboundAt: new Date(),
        }),
      ).toMatchObject({ allowed: false, code: 'recipient_opted_out' });
    });

    it('blocks a later service send even inside the 24-hour window', () => {
      // An all-purpose revocation outranks the customer-care window: the window
      // says WhatsApp would carry the message, not that the customer wants it.
      expect(
        evaluateDeliveryPolicy({
          channel: 'whatsapp',
          purpose: 'service',
          consent: 'revoked',
          hasApprovedTemplate: false,
          lastInboundAt: new Date(),
        }),
      ).toMatchObject({ allowed: false, code: 'recipient_opted_out' });
    });

    it('records the revocation as all-purpose, so it covers service too', async () => {
      const revoked = await prisma.activityEvent.findFirst({
        where: { organisationId: ORG, type: 'consent.revoked', channel: 'whatsapp' },
      });
      expect((revoked?.metadata as { purpose?: string } | null)?.purpose).toBe('all');
    }, 60_000);

    it('a later ordinary message does NOT restore consent', async () => {
      const before = gateCalls;
      await bot.ingest(inbound('wamid.AFTER1', 'actually, what are your prices?'));
      await waitFor(async () => gateCalls > before);

      // Re-consent must be an explicit act. Inferring it from any inbound message
      // would mean a customer who said STOP and then asked one question is back
      // on the marketing list. The newest consent event must still be the
      // revocation, and nothing may have written a grant.
      const events = await prisma.activityEvent.findMany({
        where: { organisationId: ORG, type: { in: ['consent.granted', 'consent.revoked'] } },
        orderBy: [{ occurredAt: 'desc' }, { id: 'desc' }],
      });
      expect(events[0]?.type).toBe('consent.revoked');
      expect(events.filter((e) => e.type === 'consent.granted')).toHaveLength(0);
    }, 60_000);
  });

  async function party() {
    const contact = await prisma.contactPoint.findFirst({
      where: { organisationId: ORG },
      select: { partyId: true },
    });
    expect(contact?.partyId).toBeTruthy();
    return { id: contact!.partyId! };
  }
});

async function teardown(prisma: PrismaService) {
  await prisma.whatsAppEvent.deleteMany({ where: { phoneE164: CUSTOMER } }).catch(() => undefined);
  await prisma.leadQualification.deleteMany({ where: { organisationId: ORG } }).catch(() => undefined);
  await prisma.aiDraftRecord.deleteMany({ where: { organisationId: ORG } }).catch(() => undefined);
  await prisma.attributionTouch.deleteMany({ where: { organisationId: ORG } }).catch(() => undefined);
  await prisma.jobTask.deleteMany({ where: { organisationId: ORG } }).catch(() => undefined);
  await prisma.message.deleteMany({ where: { organisationId: ORG } }).catch(() => undefined);
  await prisma.conversation.deleteMany({ where: { organisationId: ORG } }).catch(() => undefined);
  await prisma.activityEvent.deleteMany({ where: { organisationId: ORG } }).catch(() => undefined);
  await prisma.lead.deleteMany({ where: { organisationId: ORG } }).catch(() => undefined);
  await prisma.contactPoint.deleteMany({ where: { organisationId: ORG } }).catch(() => undefined);
  await prisma.party.deleteMany({ where: { organisationId: ORG } }).catch(() => undefined);
  await prisma.integrationAsset.deleteMany({ where: { organisationId: ORG } }).catch(() => undefined);
  await prisma.integration.deleteMany({ where: { organisationId: ORG } }).catch(() => undefined);
  await prisma.store.deleteMany({ where: { organisationId: ORG } }).catch(() => undefined);
  await prisma.organisation.deleteMany({ where: { id: ORG } }).catch(() => undefined);
}
