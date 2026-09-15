import { INestApplication, ValidationPipe } from '@nestjs/common';
import { Test } from '@nestjs/testing';
import request = require('supertest');
import * as bcrypt from 'bcryptjs';

/**
 * The visit that books a callback.
 *
 * The floor's complaint in the meeting was that what they promised a customer
 * at the counter never reached the system. These are the properties that decide
 * whether it does now:
 *
 *  1. A DATE BECOMES A REAL FOLLOW-UP. Not a note about one — a LeadFollowUp on
 *     the same queue the calling workspace already works from, so it appears
 *     where somebody will actually see it.
 *
 *  2. IT LANDS ON THE EXISTING ENQUIRY. A second visit about the same ring is
 *     the same opportunity. Opening a new lead per visit would inflate every
 *     count the meeting asked to report on.
 *
 *  3. A REMARK IS NOT A FOLLOW-UP. Either can be recorded without the other.
 *     The room argued about this and never settled it; the code takes the
 *     reading where they do not overlap, and this pins it.
 *
 *  4. THE DATE IS A CALENDAR DAY. Stored as a date, so "Tuesday" is Tuesday for
 *     whoever reads it, from wherever.
 *
 *  5. A BAD OWNER FAILS THE WHOLE CHECKOUT. Better than closing the visit with
 *     a follow-up that silently went nowhere.
 *
 *  6. SCOPE HOLDS. Another tenant's staff cannot be handed the callback.
 */

const PASSWORD = 'password123';

const A = {
  org: 'org_cfu_a', slug: 'cfu-a', store: 'store_cfu_a',
  ho: 'ho.cfu@cfu-a.local', rep: 'rep.cfu@cfu-a.local',
};
const B = {
  org: 'org_cfu_b', slug: 'cfu-b', store: 'store_cfu_b', ho: 'ho.cfu@cfu-b.local',
};

async function teardown(prisma: import('../src/prisma/prisma.service').PrismaService) {
  const orgs = [A.org, B.org];
  await prisma.activityEvent.deleteMany({ where: { organisationId: { in: orgs } } });
  await prisma.checkIn.deleteMany({ where: { organisationId: { in: orgs } } });
  await prisma.leadFollowUp.deleteMany({ where: { lead: { organisationId: { in: orgs } } } });
  await prisma.lead.deleteMany({ where: { organisationId: { in: orgs } } });
  await prisma.contactPoint.deleteMany({ where: { organisationId: { in: orgs } } });
  await prisma.party.deleteMany({ where: { organisationId: { in: orgs } } });
  await prisma.userStore.deleteMany({ where: { user: { organisationId: { in: orgs } } } });
  await prisma.user.deleteMany({ where: { organisationId: { in: orgs } } });
  await prisma.store.deleteMany({ where: { organisationId: { in: orgs } } });
  await prisma.organisation.deleteMany({ where: { id: { in: orgs } } });
}

describe('Visit follow-up (e2e)', () => {
  let app: INestApplication;
  let prisma: import('../src/prisma/prisma.service').PrismaService;
  let hoA: string;
  let repA: string;
  let bStaffId: string;

  const server = () => app.getHttpServer();
  const auth = (t: string) => ({ Authorization: `Bearer ${t}` });

  /** A walk-in, returning its id. */
  const walkIn = async (token: string, name: string, phone?: string) => {
    const res = await request(server())
      .post('/checkins')
      .set(auth(token))
      .send({ storeId: A.store, customerName: name, ...(phone ? { phone } : {}) })
      .expect(201);
    return res.body.id as string;
  };

  beforeAll(async () => {
    const { AppModule } = await import('../src/app.module');
    const { PrismaService } = await import('../src/prisma/prisma.service');
    const mod = await Test.createTestingModule({ imports: [AppModule] }).compile();
    app = mod.createNestApplication();
    app.useGlobalPipes(
      new ValidationPipe({
        whitelist: true, forbidNonWhitelisted: true, transform: true,
        transformOptions: { enableImplicitConversion: true },
      }),
    );
    await app.init();
    prisma = app.get(PrismaService);
    await teardown(prisma);

    const hash = await bcrypt.hash(PASSWORD, 10);

    await prisma.organisation.create({
      data: { id: A.org, name: 'CFU A', slug: A.slug, industryPackCode: 'retail' },
    });
    await prisma.store.create({
      data: { id: A.store, name: 'Counter', city: 'Mumbai', organisationId: A.org, timezone: 'Asia/Kolkata' },
    });
    for (const [id, email, role] of [
      ['u_cfu_a_ho', A.ho, 'head_office'],
      ['u_cfu_a_rep', A.rep, 'salesperson'],
    ] as const) {
      await prisma.user.create({
        data: {
          id, email, name: id, role: role as never, passwordHash: hash, isActive: true,
          approvalStatus: 'approved', organisationId: A.org,
          userStores: { create: { storeId: A.store, isPrimary: true } },
        },
      });
    }

    await prisma.organisation.create({
      data: { id: B.org, name: 'CFU B', slug: B.slug, industryPackCode: 'retail' },
    });
    await prisma.store.create({
      data: { id: B.store, name: 'B Counter', city: 'Pune', organisationId: B.org, timezone: 'Asia/Kolkata' },
    });
    const bUser = await prisma.user.create({
      data: {
        id: 'u_cfu_b_ho', email: B.ho, name: 'CFU B HO', role: 'head_office',
        passwordHash: hash, isActive: true, approvalStatus: 'approved', organisationId: B.org,
        userStores: { create: { storeId: B.store, isPrimary: true } },
      },
    });
    bStaffId = bUser.id;

    const login = async (email: string) =>
      (await request(server()).post('/auth/login').send({ email, password: PASSWORD }).expect(201))
        .body.token;
    hoA = await login(A.ho);
    repA = await login(A.rep);
  }, 120_000);

  afterAll(async () => {
    if (prisma) await teardown(prisma);
    if (app) await app.close();
  });

  it('a follow-up date at checkout becomes a real LeadFollowUp', async () => {
    const id = await walkIn(hoA, 'Callback Customer', '9812340001');
    await request(server())
      .patch(`/checkins/${id}`)
      .set(auth(hoA))
      .send({
        outcome: 'left',
        remark: 'Liked the 0.5ct band, wants to bring her mother',
        followUpDate: '2026-10-02',
        preferredAction: 'whatsapp',
      })
      .expect(200);

    const visit = await prisma.checkIn.findUnique({ where: { id } });
    expect(visit?.remark).toContain('bring her mother');
    expect(visit?.preferredAction).toBe('whatsapp');
    expect(visit?.leadId).toBeTruthy();
    // A calendar day, not an instant — the same day wherever it is read.
    expect(visit?.followUpDate?.toISOString().slice(0, 10)).toBe('2026-10-02');
    // Defaulted to whoever served the visit.
    expect(visit?.followUpOwnerId).toBeTruthy();

    const fu = await prisma.leadFollowUp.findMany({ where: { leadId: visit!.leadId! } });
    const booked = fu.find((f) => f.dueDate.toISOString().slice(0, 10) === '2026-10-02');
    expect(booked).toBeTruthy();
    expect(booked?.note).toContain('bring her mother');
    expect(booked?.storeId).toBe(A.store);

    // And the walk-in log can show it: the list returns what was promised.
    const list = await request(server()).get('/checkins').set(auth(hoA)).expect(200);
    const row = list.body.find((c: { id: string }) => c.id === id);
    expect(row).toMatchObject({
      remark: 'Liked the 0.5ct band, wants to bring her mother',
      followUpDate: '2026-10-02',
      preferredAction: 'whatsapp',
    });
  });

  it('a second visit by the same customer reuses the open enquiry', async () => {
    const first = await prisma.checkIn.findFirst({
      where: { organisationId: A.org, customerName: 'Callback Customer' },
      orderBy: { timeIn: 'desc' },
    });
    const leadsBefore = await prisma.lead.count({ where: { organisationId: A.org } });

    const id = await walkIn(hoA, 'Callback Customer', '9812340001');
    await request(server())
      .patch(`/checkins/${id}`)
      .set(auth(hoA))
      .send({ outcome: 'left', followUpDate: '2026-10-09' })
      .expect(200);

    const second = await prisma.checkIn.findUnique({ where: { id } });
    expect(second?.leadId).toBe(first?.leadId);
    // No second opportunity opened for the same person at the same counter.
    expect(await prisma.lead.count({ where: { organisationId: A.org } })).toBe(leadsBefore);
  });

  it('a remark alone records nothing to chase', async () => {
    const id = await walkIn(hoA, 'Just Browsing', '9812340002');
    await request(server())
      .patch(`/checkins/${id}`)
      .set(auth(hoA))
      .send({ outcome: 'left', remark: 'Only comparing prices today' })
      .expect(200);

    const visit = await prisma.checkIn.findUnique({ where: { id } });
    expect(visit?.remark).toBe('Only comparing prices today');
    expect(visit?.followUpDate).toBeNull();
    // No enquiry invented for somebody who asked for nothing.
    expect(visit?.leadId).toBeNull();
  });

  it('a follow-up alone is allowed, with no remark', async () => {
    const id = await walkIn(hoA, 'Silent Type', '9812340003');
    await request(server())
      .patch(`/checkins/${id}`)
      .set(auth(hoA))
      .send({ outcome: 'left', followUpDate: '2026-10-15', preferredAction: 'call' })
      .expect(200);
    const visit = await prisma.checkIn.findUnique({ where: { id } });
    expect(visit?.remark).toBeNull();
    expect(visit?.leadId).toBeTruthy();
    const fu = await prisma.leadFollowUp.findFirst({
      where: { leadId: visit!.leadId!, dueDate: new Date('2026-10-15T00:00:00.000Z') },
    });
    expect(fu?.note).toContain('call');
  });

  it("another tenant's staff cannot be handed the callback", async () => {
    const id = await walkIn(hoA, 'Scope Test', '9812340004');
    await request(server())
      .patch(`/checkins/${id}`)
      .set(auth(hoA))
      .send({ outcome: 'left', followUpDate: '2026-10-20', followUpOwnerId: bStaffId })
      .expect(404);

    // The whole checkout failed — the visit is not closed with a dangling owner.
    const visit = await prisma.checkIn.findUnique({ where: { id } });
    expect(visit?.timeOut).toBeNull();
    expect(visit?.followUpDate).toBeNull();
  });

  it('a malformed date is refused rather than stored as something else', async () => {
    const id = await walkIn(hoA, 'Bad Date', '9812340005');
    await request(server())
      .patch(`/checkins/${id}`)
      .set(auth(hoA))
      .send({ outcome: 'left', followUpDate: '02-10-2026' })
      .expect(400);
  });

  it('the remark reaches the customer timeline, not only the visit row', async () => {
    const events = await prisma.activityEvent.findMany({
      where: { organisationId: A.org, type: 'visit.closed' },
    });
    expect(events.length).toBeGreaterThan(0);
    expect(events.some((e) => e.summary.includes('bring her mother'))).toBe(true);
  });

  it('a salesperson can close and book on their own walk-in', async () => {
    const id = await walkIn(repA, 'Rep Customer', '9812340006');
    await request(server())
      .patch(`/checkins/${id}`)
      .set(auth(repA))
      .send({ outcome: 'left', followUpDate: '2026-10-25', remark: 'Wants a quote' })
      .expect(200);
    const visit = await prisma.checkIn.findUnique({ where: { id } });
    expect(visit?.leadId).toBeTruthy();
  });
});
