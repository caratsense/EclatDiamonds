import { INestApplication, ValidationPipe } from '@nestjs/common';
import { Test } from '@nestjs/testing';
import * as bcrypt from 'bcryptjs';

import { AppModule } from '../src/app.module';
import { PrismaService } from '../src/prisma/prisma.service';
import { WhatsAppBotService } from '../src/whatsapp-bot/whatsapp-bot.service';
import { WhatsAppIdentityService } from '../src/whatsapp-bot/whatsapp-identity.service';

/**
 * TWO NUMBERS, TWO BOTS, ONE WEBHOOK.
 *
 * The business runs a shopfront line that customers were given in adverts, and
 * a separate operations line that store staff file daily reports on. Meta
 * delivers both to the same callback; the only thing separating them on the way
 * in is `metadata.phone_number_id`.
 *
 * Until there was a second number, the two bots were told apart by WHO was
 * writing: a phone linked to a CaratSense user meant the DSR bot, anybody else
 * meant a customer. That was correct with one line and wrong with two, in both
 * directions. The expensive direction is the first test below.
 *
 * FIXTURE-TESTED. Nothing here contacts Meta. Messages go through
 * `WhatsAppBotService.ingest` exactly as the webhook delivers them, and the
 * assertions are about which bot answered and what was written down.
 */
process.env.CREDENTIAL_ENCRYPTION_KEY = Buffer.alloc(32, 29).toString('base64');
process.env.CREDENTIAL_ENCRYPTION_KEY_VERSION = '1';

const PASSWORD = 'password123';

const ORG = 'org_twoline';
const STORE = 'store_twoline_main';
const INTEGRATION = 'int_twoline';

/** The number in the adverts. */
const CUSTOMER_LINE = '881000000001';
/** The number store teams file reports on. Nobody outside the business has it. */
const INTERNAL_LINE = '881000000002';

const MANAGER = 'mgr.twoline@twoline.local';
/** A linked staff handset. */
const STAFF_PHONE = '919000090001';
/** Someone who is not staff. */
const STRANGER_PHONE = '919000090002';
/** Staff-to-be: a real person whose handset is not yet bound to them. */
const NEWCOMER_PHONE = '919000090004';

describe('two WhatsApp lines, one webhook (e2e)', () => {
  let app: INestApplication;
  let prisma: PrismaService;
  let bot: WhatsAppBotService;
  let identity: WhatsAppIdentityService;
  let wamidSeq = 0;

  const envelope = (phoneNumberId: string, from: string, text: string, wamid: string) => ({
    entry: [
      {
        changes: [
          {
            value: {
              metadata: { phone_number_id: phoneNumberId },
              contacts: [{ wa_id: from, profile: { name: 'Tester' } }],
              messages: [
                { id: wamid, from, timestamp: '1759000000', type: 'text', text: { body: text } },
              ],
            },
          },
        ],
      },
    ],
  });

  /** Deliver one message and drain it, so a scripted exchange cannot race itself. */
  const send = async (phoneNumberId: string, from: string, text: string) => {
    const wamid = `wamid.TWOLINE-${wamidSeq++}`;
    await bot.ingest(envelope(phoneNumberId, from, text, wamid));
    for (let i = 0; i < 100; i += 1) {
      await bot.processPending();
      const ev = await prisma.whatsAppEvent.findUnique({
        where: { wamid },
        select: { status: true },
      });
      if (!ev || (ev.status !== 'received' && ev.status !== 'processing')) break;
      await new Promise((r) => setTimeout(r, 20));
    }
    return wamid;
  };

  const statusOf = async (wamid: string) =>
    (await prisma.whatsAppEvent.findUnique({ where: { wamid }, select: { status: true } }))?.status;

  const conversationFor = async (phone: string) =>
    prisma.conversation.findFirst({
      where: { organisationId: ORG, externalThreadId: phone },
      select: { id: true, handling: true },
    });

  const sessionFor = async (phone: string) =>
    prisma.whatsAppSession.findFirst({
      where: { phoneE164: phone },
      select: { flow: true, step: true },
    });

  beforeAll(async () => {
    const mod = await Test.createTestingModule({ imports: [AppModule] }).compile();
    app = mod.createNestApplication();
    app.useGlobalPipes(
      new ValidationPipe({ whitelist: true, forbidNonWhitelisted: true, transform: true }),
    );
    await app.init();
    prisma = app.get(PrismaService);
    bot = app.get(WhatsAppBotService);
    identity = app.get(WhatsAppIdentityService);

    await teardown(prisma);
    const hash = await bcrypt.hash(PASSWORD, 10);

    await prisma.organisation.create({
      data: { id: ORG, name: 'Two Line', slug: 'twoline', industryPackCode: 'jewellery' },
    });
    await prisma.store.create({
      data: { id: STORE, name: 'Main', city: 'Surat', organisationId: ORG },
    });
    const mgr = await prisma.user.create({
      data: {
        email: MANAGER,
        name: 'Store Manager',
        role: 'store_manager',
        passwordHash: hash,
        isActive: true,
        approvalStatus: 'approved',
        organisationId: ORG,
        userStores: { create: { storeId: STORE, isPrimary: true } },
      },
    });

    await prisma.integration.create({
      data: {
        id: INTEGRATION,
        organisationId: ORG,
        providerCode: 'whatsapp_cloud',
        name: 'Two Line WhatsApp',
        status: 'connected',
      },
    });

    // The shopfront line. `purpose` is null, like every number registered
    // before the field existed.
    await prisma.integrationAsset.create({
      data: {
        organisationId: ORG,
        integrationId: INTEGRATION,
        kind: 'phone_number',
        externalId: CUSTOMER_LINE,
        name: 'Shopfront',
        isActive: true,
        ownershipKey: `whatsapp_cloud:phone_number:${CUSTOMER_LINE}`,
        messagingRoutes: {
          create: {
            organisationId: ORG,
            integrationId: INTEGRATION,
            storeId: STORE,
            channel: 'whatsapp',
          },
        },
      },
    });

    // The operations line.
    await prisma.integrationAsset.create({
      data: {
        organisationId: ORG,
        integrationId: INTEGRATION,
        kind: 'phone_number',
        externalId: INTERNAL_LINE,
        name: 'Operations',
        purpose: 'internal',
        isActive: true,
        ownershipKey: `whatsapp_cloud:phone_number:${INTERNAL_LINE}`,
        // Deliberately NO StoreMessagingRoute. That table is unique on
        // (storeId, channel) because a branch speaks to customers with one
        // voice, and the internal line is not a voice a branch speaks to
        // customers with. Its replies leave on the number the staff member
        // wrote to, which `route()` carries in `replyRoute` from the inbound
        // asset itself.
      },
    });

    // One linked staff handset. This binding is the ONLY path from a phone
    // number to a user; `User.phone` is deliberately not consulted.
    await prisma.whatsAppIdentity.create({
      data: {
        phoneE164: STAFF_PHONE,
        userId: mgr.id,
        status: 'active',
        organisationId: ORG,
      },
    });
  }, 120_000);

  afterAll(async () => {
    await teardown(prisma);
    await app?.close();
  });

  /* ------------------------------------------------ the expensive direction */

  /*
   * A stranger who gets hold of the operations number.
   *
   * Under sender-identity routing this opened a CRM conversation and answered
   * with the qualification script, on a line that exists so a manager can type
   * a revenue figure into it.
   */
  it('says NOTHING to an unknown number that writes to the internal line', async () => {
    const wamid = await send(INTERNAL_LINE, STRANGER_PHONE, 'hi, do you sell rings?');

    expect(await statusOf(wamid)).toBe('ignored');
    // No lead, no thread, no reply. Silence rather than a polite refusal: a
    // reply confirms the number is live and worth messaging again, which is
    // precisely what an internal line must not confirm to a stranger.
    expect(await conversationFor(STRANGER_PHONE)).toBeNull();
    expect(await sessionFor(STRANGER_PHONE)).toBeNull();
  });

  it('still opens a normal customer thread for that same stranger on the shopfront line', async () => {
    // The point of the test above is the LINE, not the person. The identical
    // message to the identical sender is ordinary sales traffic here.
    const wamid = await send(CUSTOMER_LINE, STRANGER_PHONE, 'hi, do you sell rings?');

    expect(await statusOf(wamid)).toBe('processed');
    const convo = await conversationFor(STRANGER_PHONE);
    expect(convo).not.toBeNull();
  });

  /*
   * THE ONE EXCEPTION, AND WITHOUT IT THE LINE IS UNUSABLE.
   *
   * A link code is how somebody BECOMES staff. The first version of this rule
   * refused every unlinked number, which meant the first manager handed the
   * operations number sent their code into silence and could never get on --
   * the line was reachable only by people already on it. Found by trying to
   * onboard a store manager, which is the only way it could have been found.
   */
  it('accepts a link code from an unlinked number, so somebody can get on at all', async () => {
    const mgr = await prisma.user.findFirst({
      where: { email: MANAGER },
      select: { id: true, organisationId: true, name: true, role: true },
    });
    const code = await identity.startLinking({
      id: mgr!.id,
      organisationId: mgr!.organisationId,
      name: mgr!.name,
      role: mgr!.role,
      storeIds: [STORE],
      allStores: false,
    } as never);

    const wamid = await send(INTERNAL_LINE, NEWCOMER_PHONE, code.code);
    expect(await statusOf(wamid)).toBe('processed');

    const bound = await prisma.whatsAppIdentity.findFirst({
      where: { phoneE164: NEWCOMER_PHONE },
      select: { status: true, userId: true },
    });
    expect(bound?.status).toBe('active');
    expect(bound?.userId).toBe(mgr!.id);
  });

  it('still says nothing to an unlinked number that writes anything else', async () => {
    // The exception is narrow on purpose: only a message already shaped like a
    // code is looked at. "hello" from a stranger is as silent as it ever was,
    // so the enumeration risk the rule exists to close is unchanged.
    const wamid = await send(INTERNAL_LINE, '919000090003', 'hello is anyone there');
    expect(await statusOf(wamid)).toBe('ignored');
    expect(await conversationFor('919000090003')).toBeNull();
  });

  /* ------------------------------------------------------- the staff side */

  it('gives a linked staff member the DSR bot on the internal line', async () => {
    const wamid = await send(INTERNAL_LINE, STAFF_PHONE, 'hi');

    expect(await statusOf(wamid)).toBe('processed');
    // The staff menu is a WhatsAppSession, not a CRM conversation. A manager
    // filing a report must never appear in the sales inbox as a lead.
    const session = await sessionFor(STAFF_PHONE);
    expect(session).not.toBeNull();
    expect(await conversationFor(STAFF_PHONE)).toBeNull();
  });

  it('starts the daily report from the internal line', async () => {
    await send(INTERNAL_LINE, STAFF_PHONE, '1');
    const session = await sessionFor(STAFF_PHONE);
    // One store, so no branch question: straight into the questionnaire.
    expect(session?.flow).toBe('dsr');
  });

  /*
   * EACH LINE DOES ITS OWN JOB.
   *
   * Staff used to get the reporting flow on the shopfront number too, so that
   * a manager who had not saved the new one would not silently file nothing.
   * But a phone BECOMES linked by sending its code to the internal line, so
   * every linked person has already used that number -- the manager being
   * protected cannot exist. Meanwhile the person most likely to check the
   * customer experience is somebody who works here, and they could not see it.
   */
  it('answers staff as a CUSTOMER on the customer line, so they can test it', async () => {
    await send(INTERNAL_LINE, STAFF_PHONE, 'cancel');
    const wamid = await send(CUSTOMER_LINE, STAFF_PHONE, 'hi, do you have bangles');

    expect(await statusOf(wamid)).toBe('processed');
    // A real CRM thread, the qualification script, the lot.
    const convo = await conversationFor(STAFF_PHONE);
    expect(convo).not.toBeNull();
  });

  /*
   * AND THE CONDITION THAT MAKES THAT SAFE.
   *
   * Most tenants run ONE number, whose purpose is null because nobody ever had
   * to classify it, and on that number the staff menu and the customer script
   * share a line by necessity. Applying the rule above there would take the
   * daily report away from every one of them at once, silently, and the first
   * anybody would know is a month of missing figures.
   */
  it('keeps the DSR bot on a lone number, where staff have nowhere else to go', async () => {
    const internal = await prisma.integrationAsset.findFirst({
      where: { integrationId: INTEGRATION, externalId: INTERNAL_LINE },
      select: { id: true },
    });
    // Take the internal line away: this tenant now has one number, like most.
    await prisma.integrationAsset.update({
      where: { id: internal!.id },
      data: { isActive: false },
    });
    await prisma.conversation.deleteMany({
      where: { organisationId: ORG, externalThreadId: STAFF_PHONE },
    });

    try {
      const wamid = await send(CUSTOMER_LINE, STAFF_PHONE, 'hi');
      expect(await statusOf(wamid)).toBe('processed');
      // The staff menu, on the only number there is.
      expect(await sessionFor(STAFF_PHONE)).not.toBeNull();
      expect(await conversationFor(STAFF_PHONE)).toBeNull();
    } finally {
      await prisma.integrationAsset.update({
        where: { id: internal!.id },
        data: { isActive: true },
      });
    }
  });

  /* ----------------------------------------------------- the classification */

  it('treats an unclassified number as customer-facing, so nothing in production changes', async () => {
    const asset = await prisma.integrationAsset.findFirst({
      where: { integrationId: INTEGRATION, externalId: CUSTOMER_LINE },
      select: { purpose: true },
    });
    // Null, not 'customer'. Two spellings of one state would mean every routing
    // read had to handle both, and the one already on disk wins.
    expect(asset?.purpose).toBeNull();
  });
});

async function teardown(prisma: PrismaService) {
  const phones = [STAFF_PHONE, STRANGER_PHONE, NEWCOMER_PHONE, '919000090003'];
  await prisma.whatsAppSession.deleteMany({ where: { phoneE164: { in: phones } } });
  await prisma.whatsAppIdentity.deleteMany({ where: { phoneE164: { in: phones } } });
  await prisma.whatsAppLinkCode.deleteMany({ where: { organisationId: ORG } }).catch(() => undefined);
  await prisma.whatsAppEvent.deleteMany({ where: { wamid: { startsWith: 'wamid.TWOLINE-' } } });
  await prisma.attributionTouch.deleteMany({ where: { organisationId: ORG } });
  await prisma.message.deleteMany({ where: { organisationId: ORG } });
  await prisma.conversation.deleteMany({ where: { organisationId: ORG } });
  await prisma.activityEvent.deleteMany({ where: { organisationId: ORG } }).catch(() => undefined);
  await prisma.lead.deleteMany({ where: { organisationId: ORG } });
  await prisma.party.deleteMany({ where: { organisationId: ORG } });
  await prisma.dailyReport.deleteMany({ where: { organisationId: ORG } });
  await prisma.storeMessagingRoute.deleteMany({ where: { organisationId: ORG } });
  await prisma.integrationAsset.deleteMany({ where: { organisationId: ORG } });
  await prisma.integration.deleteMany({ where: { organisationId: ORG } });
  await prisma.userStore.deleteMany({ where: { storeId: STORE } });
  /*
   * Before the users, and this is not optional.
   *
   * Linking a number is an audited act, so the moment this suite started
   * exercising it, every row it wrote pinned the user it names:
   * `AuditLog_actorId_fkey` is RESTRICT, and the delete below fails with 23001
   * rather than cascading. The suite then failed in beforeAll's own teardown
   * and every test in it went red for a reason that had nothing to do with any
   * of them.
   */
  await prisma.auditLog.deleteMany({ where: { organisationId: ORG } }).catch(() => undefined);
  await prisma.user.deleteMany({ where: { organisationId: ORG } });
  await prisma.store.deleteMany({ where: { organisationId: ORG } });
  /*
   * A background job seeds this organisation a metal rate while the suite is
   * running, and it holds the organisation down on the way out. Swept rather
   * than suppressed, so the next run starts from the same clean slate as the
   * first one did.
   */
  await prisma.metalRate.deleteMany({ where: { organisationId: ORG } }).catch(() => undefined);
  await prisma.organisation.deleteMany({ where: { id: ORG } });
}
