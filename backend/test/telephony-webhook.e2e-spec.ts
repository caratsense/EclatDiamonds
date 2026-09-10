import { INestApplication, ValidationPipe } from '@nestjs/common';
import { Test } from '@nestjs/testing';
import request = require('supertest');
import * as bcrypt from 'bcryptjs';

/**
 * The inbound-call door.
 *
 * This endpoint is @Public — a telephony provider carries no session — and it
 * WRITES: a customer, an enquiry, a call log and a task. That combination is
 * the one worth pinning hard, so the properties asserted here are the ones that
 * would each be a serious incident on their own:
 *
 *  1. NO TOKEN, NO WRITE. A missing, wrong or revoked token is refused before
 *     anything is created. An unauthenticated write endpoint on somebody's CRM
 *     is the failure mode this whole file exists to prevent.
 *
 *  2. THE TOKEN IS THE TENANT. Tenant A's token can only ever open records in
 *     tenant A. There is no organisation id in the payload to tamper with,
 *     which is deliberate.
 *
 *  3. A REPLAY IS A NO-OP. Providers retry. A retried missed call must not
 *     become a second enquiry, a second task and a doubled call in the day's
 *     report — the second delivery returns the first delivery's rows.
 *
 *  4. AN UNMAPPED NUMBER IS NOT GUESSED AT. A call to a number no branch owns
 *     is logged, and stops there. It does not pick a branch.
 *
 *  5. THE CALLER IS THE CUSTOMER THEY ALREADY WERE. A number that already has a
 *     contact point resolves to THAT customer, not a second one.
 *
 * Every number below is in a documentation range and belongs to nobody.
 */

const PASSWORD = 'password123';

const A = {
  org: 'org_tel_a',
  slug: 'tel-a',
  storeMain: 'store_tel_a_main',
  storeOther: 'store_tel_a_other',
  ho: 'ho.tel@tel-a.local',
  rep: 'rep.tel@tel-a.local',
  /** The branch DID, as the tenant recorded it on the store. */
  did: '+91 22 4000 0001',
};
const B = {
  org: 'org_tel_b',
  slug: 'tel-b',
  store: 'store_tel_b',
  ho: 'ho.tel@tel-b.local',
  did: '+912240000002',
};

/** Never dialled, never routable. */
const CALLER = '+919000000011';
const KNOWN_CALLER = '+919000000012';
const UNMAPPED_DID = '+912299999999';

const HEADER = 'x-caratos-telephony-token';

describe('Telephony inbound webhook (e2e)', () => {
  let app: INestApplication;
  let prisma: import('../src/prisma/prisma.service').PrismaService;
  let hoToken: string;
  let repToken: string;
  let hoTokenB: string;
  let webhookToken: string;
  let webhookTokenB: string;

  const server = () => app.getHttpServer();

  beforeAll(async () => {
    const { AppModule } = await import('../src/app.module');
    const { PrismaService } = await import('../src/prisma/prisma.service');
    const mod = await Test.createTestingModule({ imports: [AppModule] }).compile();
    app = mod.createNestApplication();
    app.useGlobalPipes(
      new ValidationPipe({
        whitelist: true,
        forbidNonWhitelisted: true,
        transform: true,
        transformOptions: { enableImplicitConversion: true },
      }),
    );
    await app.init();
    prisma = app.get(PrismaService);
    await teardown(prisma);

    const hash = await bcrypt.hash(PASSWORD, 10);

    await prisma.organisation.create({
      data: { id: A.org, name: 'Tel A', slug: A.slug, industryPackCode: 'retail' },
    });
    await prisma.store.createMany({
      data: [
        {
          id: A.storeMain, name: 'Main Counter', city: 'Mumbai', organisationId: A.org,
          timezone: 'Asia/Kolkata', phone: A.did,
        },
        {
          id: A.storeOther, name: 'Second Counter', city: 'Surat', organisationId: A.org,
          timezone: 'Asia/Kolkata',
        },
      ],
    });
    await prisma.user.create({
      data: {
        id: 'u_tel_a_ho', email: A.ho, name: 'Tel A HO', role: 'head_office',
        passwordHash: hash, isActive: true, approvalStatus: 'approved', organisationId: A.org,
        userStores: { create: { storeId: A.storeMain, isPrimary: true } },
      },
    });
    await prisma.user.create({
      data: {
        id: 'u_tel_a_rep', email: A.rep, name: 'Tel A Rep', role: 'salesperson',
        passwordHash: hash, isActive: true, approvalStatus: 'approved', organisationId: A.org,
        userStores: { create: { storeId: A.storeMain, isPrimary: true } },
      },
    });

    await prisma.organisation.create({
      data: { id: B.org, name: 'Tel B', slug: B.slug, industryPackCode: 'retail' },
    });
    await prisma.store.create({
      data: {
        id: B.store, name: 'B Counter', city: 'Pune', organisationId: B.org,
        timezone: 'Asia/Kolkata', phone: B.did,
      },
    });
    await prisma.user.create({
      data: {
        id: 'u_tel_b_ho', email: B.ho, name: 'Tel B HO', role: 'head_office',
        passwordHash: hash, isActive: true, approvalStatus: 'approved', organisationId: B.org,
        userStores: { create: { storeId: B.store, isPrimary: true } },
      },
    });

    const login = async (email: string) =>
      (await request(server()).post('/auth/login').send({ email, password: PASSWORD }).expect(201))
        .body.token;
    hoToken = await login(A.ho);
    repToken = await login(A.rep);
    hoTokenB = await login(B.ho);

    // Each tenant connects the provider and issues its own token.
    await prisma.integration.create({
      data: { id: 'int_tel_a', organisationId: A.org, providerCode: 'telephony', name: 'IVR' },
    });
    await prisma.integration.create({
      data: { id: 'int_tel_b', organisationId: B.org, providerCode: 'telephony', name: 'IVR' },
    });
    webhookToken = (
      await request(server())
        .post('/integrations/telephony/webhook-token')
        .set('Authorization', `Bearer ${hoToken}`)
        .expect(201)
    ).body.token;
    webhookTokenB = (
      await request(server())
        .post('/integrations/telephony/webhook-token')
        .set('Authorization', `Bearer ${hoTokenB}`)
        .expect(201)
    ).body.token;
  }, 180_000);

  afterAll(async () => {
    if (prisma) await teardown(prisma);
    if (app) await app.close();
  });

  /* ------------------------------------------------------------ the token */

  describe('issuing the token', () => {
    it('gives head office a token, once, with the path and header to use it', async () => {
      const res = await request(server())
        .post('/integrations/telephony/webhook-token')
        .set('Authorization', `Bearer ${hoToken}`)
        .expect(201);
      expect(res.body.token).toMatch(/^cs_tel_[0-9a-f]{48}$/);
      expect(res.body.path).toBe('/integrations/telephony/webhook');
      expect(res.body.header).toBe(HEADER);
      // The one just issued replaces the one from beforeAll.
      webhookToken = res.body.token;
    });

    it('stores only the hash, never the token', async () => {
      const row = await prisma.integration.findUniqueOrThrow({ where: { id: 'int_tel_a' } });
      const config = row.config as Record<string, unknown>;
      expect(config.webhookTokenHash).toMatch(/^[0-9a-f]{64}$/);
      // The whole settings bag, serialised: the plaintext must appear nowhere
      // in it, under any key anybody adds later.
      expect(JSON.stringify(config)).not.toContain(webhookToken);
    });

    it('refuses a salesperson', async () => {
      await request(server())
        .post('/integrations/telephony/webhook-token')
        .set('Authorization', `Bearer ${repToken}`)
        .expect(403);
    });

    it('refuses a tenant that has not connected the provider', async () => {
      await prisma.integration.delete({ where: { id: 'int_tel_b' } });
      await request(server())
        .post('/integrations/telephony/webhook-token')
        .set('Authorization', `Bearer ${hoTokenB}`)
        .expect(404);
      // Put it back, with its token, for the isolation test below.
      await prisma.integration.create({
        data: { id: 'int_tel_b', organisationId: B.org, providerCode: 'telephony', name: 'IVR' },
      });
      webhookTokenB = (
        await request(server())
          .post('/integrations/telephony/webhook-token')
          .set('Authorization', `Bearer ${hoTokenB}`)
          .expect(201)
      ).body.token;
    });
  });

  /* ------------------------------------------------------ the closed door */

  describe('the door', () => {
    const call = (extra: Record<string, unknown> = {}) => ({
      fromNumber: CALLER,
      toNumber: A.did,
      callId: `refused-${Math.random().toString(36).slice(2)}`,
      ...extra,
    });

    it('refuses a delivery with no token at all', async () => {
      await request(server()).post('/integrations/telephony/webhook').send(call()).expect(403);
    });

    it('refuses a wrong token', async () => {
      await request(server())
        .post('/integrations/telephony/webhook')
        .set(HEADER, 'cs_tel_' + 'f'.repeat(48))
        .send(call())
        .expect(403);
    });

    it('refuses a token that is merely a prefix of the real one', async () => {
      await request(server())
        .post('/integrations/telephony/webhook')
        .set(HEADER, webhookToken.slice(0, -1))
        .send(call())
        .expect(403);
    });

    it('creates nothing when it refuses', async () => {
      const before = await prisma.callLog.count();
      await request(server())
        .post('/integrations/telephony/webhook')
        .set(HEADER, 'not-a-token')
        .send(call())
        .expect(403);
      expect(await prisma.callLog.count()).toBe(before);
    });

    it('refuses a payload with no call id, which is what makes a replay safe', async () => {
      await request(server())
        .post('/integrations/telephony/webhook')
        .set(HEADER, webhookToken)
        .send({ fromNumber: CALLER, toNumber: A.did })
        .expect(400);
    });

    it('refuses an unexpected field rather than storing it', async () => {
      await request(server())
        .post('/integrations/telephony/webhook')
        .set(HEADER, webhookToken)
        .send({ ...call(), organisationId: B.org })
        .expect(400);
    });

    it('refuses a recording reference that is not https', async () => {
      await request(server())
        .post('/integrations/telephony/webhook')
        .set(HEADER, webhookToken)
        .send({ ...call(), recordingUrl: 'http://recordings.example.com/1.mp3' })
        .expect(400);
    });
  });

  /* --------------------------------------------------------- the happy path */

  describe('an inbound call', () => {
    const callId = 'prov-call-0001';
    let body: Record<string, string | null>;

    it('opens a customer, an enquiry, a call log and a task due today', async () => {
      const res = await request(server())
        .post('/integrations/telephony/webhook')
        .set(HEADER, webhookToken)
        .send({
          fromNumber: CALLER,
          toNumber: A.did,
          callId,
          direction: 'inbound',
          durationSec: 42,
          disposition: 'missed',
          callerName: 'Ravi Kumar',
        })
        .expect(200);
      body = res.body;

      expect(body.storeId).toBe(A.storeMain);
      expect(body.unroutedReason).toBeNull();
      expect(body.partyId).toBeTruthy();
      expect(body.leadId).toBeTruthy();
      expect(body.taskId).toBeTruthy();
      expect(body.leadRef).toMatch(/^LD-/);

      const lead = await prisma.lead.findUniqueOrThrow({ where: { id: body.leadId as string } });
      // `phone`, not a new enum value: the fact recorded is that the enquiry
      // arrived by telephone, which is exactly what this value already means.
      expect(lead.source).toBe('phone');
      expect(lead.storeId).toBe(A.storeMain);
      expect(lead.organisationId).toBe(A.org);
      // Provenance lives on originKey, where the unique index also makes the
      // intake exactly-once.
      expect(lead.originKey).toBe(`ivr:telephony:${callId}`);

      const task = await prisma.task.findUniqueOrThrow({ where: { id: body.taskId as string } });
      expect(task.priority).toBe('high');
      expect(task.status).toBe('open');
      expect(task.storeId).toBe(A.storeMain);
      expect(task.leadId).toBe(body.leadId);
      expect(task.dueDate).not.toBeNull();

      const log = await prisma.callLog.findUniqueOrThrow({ where: { id: body.callLogId as string } });
      expect(log.provider).toBe('telephony');
      expect(log.direction).toBe('inbound');
      expect(log.durationSec).toBe(42);
      expect(log.disposition).toBe('missed');
      // Linked back, so the call, the customer and the enquiry are one story.
      expect(log.partyId).toBe(body.partyId);
      expect(log.leadId).toBe(body.leadId);
      expect(log.taskId).toBe(body.taskId);
    });

    it('puts the follow-up in the calling queue for that branch', async () => {
      const res = await request(server())
        .get('/calling/queue')
        .query({ bucket: 'today' })
        .set('Authorization', `Bearer ${hoToken}`)
        .expect(200);
      expect(res.body.items.map((t: { id: string }) => t.id)).toContain(body.taskId);
    });

    it('treats a redelivery of the same call as a no-op', async () => {
      const before = {
        leads: await prisma.lead.count({ where: { organisationId: A.org } }),
        tasks: await prisma.task.count({ where: { organisationId: A.org } }),
        calls: await prisma.callLog.count({ where: { organisationId: A.org } }),
      };
      const res = await request(server())
        .post('/integrations/telephony/webhook')
        .set(HEADER, webhookToken)
        .send({ fromNumber: CALLER, toNumber: A.did, callId, direction: 'inbound' })
        .expect(200);
      // Either the webhook-event layer or the call-log layer catches it; both
      // are correct, and neither may write a second row.
      expect(res.body.handled).toBe(true);
      expect(await prisma.lead.count({ where: { organisationId: A.org } })).toBe(before.leads);
      expect(await prisma.task.count({ where: { organisationId: A.org } })).toBe(before.tasks);
      expect(await prisma.callLog.count({ where: { organisationId: A.org } })).toBe(before.calls);
    });

    it('recognises a caller who is already a customer', async () => {
      const party = await prisma.party.create({
        data: {
          organisationId: A.org, storeId: A.storeMain, name: 'Existing Customer',
          types: ['customer'], phone: KNOWN_CALLER,
        },
      });
      await prisma.contactPoint.create({
        data: {
          organisationId: A.org, partyId: party.id, kind: 'phone',
          value: KNOWN_CALLER, valueNormalized: '919000000012', source: 'seed',
        },
      });

      const res = await request(server())
        .post('/integrations/telephony/webhook')
        .set(HEADER, webhookToken)
        .send({ fromNumber: KNOWN_CALLER, toNumber: A.did, callId: 'prov-call-0002' })
        .expect(200);
      // The SAME customer. A second party holding the same number is the thing
      // identity resolution exists to prevent.
      expect(res.body.partyId).toBe(party.id);
    });
  });

  /* ------------------------------------------------------ nothing is guessed */

  describe('a number no branch owns', () => {
    it('logs the call and opens no enquiry', async () => {
      const res = await request(server())
        .post('/integrations/telephony/webhook')
        .set(HEADER, webhookToken)
        .send({ fromNumber: CALLER, toNumber: UNMAPPED_DID, callId: 'prov-call-0003' })
        .expect(200);

      expect(res.body.storeId).toBeNull();
      expect(res.body.leadId).toBeNull();
      expect(res.body.taskId).toBeNull();
      expect(res.body.unroutedReason).toMatch(/not mapped to a branch/i);

      // The evidence survives even though the routing did not.
      const log = await prisma.callLog.findUniqueOrThrow({
        where: { id: res.body.callLogId },
      });
      expect(log.organisationId).toBe(A.org);
      expect(log.storeId).toBeNull();
    });

    it('routes through the integration number map when one is configured', async () => {
      await prisma.integration.update({
        where: { id: 'int_tel_a' },
        data: {
          config: {
            ...((
              await prisma.integration.findUniqueOrThrow({ where: { id: 'int_tel_a' } })
            ).config as Record<string, unknown>),
            numberRouting: { [UNMAPPED_DID]: A.storeOther },
          },
        },
      });

      const res = await request(server())
        .post('/integrations/telephony/webhook')
        .set(HEADER, webhookToken)
        .send({ fromNumber: CALLER, toNumber: UNMAPPED_DID, callId: 'prov-call-0004' })
        .expect(200);
      expect(res.body.storeId).toBe(A.storeOther);
    });

    it('matches the same line however the provider formats it', async () => {
      // The branch phone is stored as "+91 22 4000 0001"; the provider sends it
      // with no country code and a trunk zero. Same line, three spellings.
      const res = await request(server())
        .post('/integrations/telephony/webhook')
        .set(HEADER, webhookToken)
        .send({ fromNumber: CALLER, toNumber: '02240000001', callId: 'prov-call-0005' })
        .expect(200);
      expect(res.body.storeId).toBe(A.storeMain);
    });

    it('refuses to route a store id belonging to another tenant', async () => {
      await prisma.integration.update({
        where: { id: 'int_tel_a' },
        data: {
          config: {
            ...((
              await prisma.integration.findUniqueOrThrow({ where: { id: 'int_tel_a' } })
            ).config as Record<string, unknown>),
            // A mapping is data, and data is never a permission.
            numberRouting: { '+912288888888': B.store },
          },
        },
      });
      const res = await request(server())
        .post('/integrations/telephony/webhook')
        .set(HEADER, webhookToken)
        .send({ fromNumber: CALLER, toNumber: '+912288888888', callId: 'prov-call-0006' })
        .expect(200);
      expect(res.body.storeId).toBeNull();
      expect(res.body.unroutedReason).toBeTruthy();
    });
  });

  /* ------------------------------------------------------------- isolation */

  describe('one tenant cannot reach another', () => {
    it("writes tenant B's call into tenant B, whatever number is dialled", async () => {
      const res = await request(server())
        .post('/integrations/telephony/webhook')
        .set(HEADER, webhookTokenB)
        // Tenant A's branch number, presented with tenant B's token.
        .send({ fromNumber: CALLER, toNumber: A.did, callId: 'prov-call-0007' })
        .expect(200);

      const log = await prisma.callLog.findUniqueOrThrow({ where: { id: res.body.callLogId } });
      expect(log.organisationId).toBe(B.org);
      // A's branch is invisible to B's lookup, so the call is unrouted rather
      // than filed into somebody else's showroom.
      expect(res.body.storeId).toBeNull();
    });

    it('leaves no tenant-A lead behind from that call', async () => {
      const leaked = await prisma.lead.findFirst({
        where: { organisationId: A.org, originKey: 'ivr:telephony:prov-call-0007' },
      });
      expect(leaked).toBeNull();
    });
  });
});

async function teardown(prisma: import('../src/prisma/prisma.service').PrismaService) {
  const orgs = [A.org, B.org];
  const drop = async (fn: () => Promise<unknown>) => {
    await fn().catch(() => undefined);
  };
  await drop(() => prisma.callLog.deleteMany({ where: { organisationId: { in: orgs } } }));
  await drop(() => prisma.webhookEvent.deleteMany({ where: { providerCode: 'telephony' } }));
  await drop(() => prisma.activityEvent.deleteMany({ where: { organisationId: { in: orgs } } }));
  await drop(() => prisma.attributionTouch.deleteMany({ where: { organisationId: { in: orgs } } }));
  await drop(() => prisma.task.deleteMany({ where: { organisationId: { in: orgs } } }));
  await drop(() => prisma.leadFollowUp.deleteMany({ where: { lead: { organisationId: { in: orgs } } } }));
  await drop(() => prisma.leadNote.deleteMany({ where: { lead: { organisationId: { in: orgs } } } }));
  await drop(() => prisma.lead.deleteMany({ where: { organisationId: { in: orgs } } }));
  await drop(() => prisma.contactPoint.deleteMany({ where: { organisationId: { in: orgs } } }));
  await drop(() => prisma.party.deleteMany({ where: { organisationId: { in: orgs } } }));
  await drop(() => prisma.integrationCredential.deleteMany({ where: { integration: { organisationId: { in: orgs } } } }));
  await drop(() => prisma.integration.deleteMany({ where: { organisationId: { in: orgs } } }));
  await drop(() => prisma.auditLog.deleteMany({ where: { organisationId: { in: orgs } } }));
  await drop(() => prisma.userStore.deleteMany({ where: { store: { organisationId: { in: orgs } } } }));
  await drop(() => prisma.user.deleteMany({ where: { organisationId: { in: orgs } } }));
  await drop(() => prisma.store.deleteMany({ where: { organisationId: { in: orgs } } }));
  await drop(() => prisma.organisation.deleteMany({ where: { id: { in: orgs } } }));
}
