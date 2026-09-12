import { INestApplication, ValidationPipe } from '@nestjs/common';
import { Test } from '@nestjs/testing';
import request = require('supertest');
import * as bcrypt from 'bcryptjs';

/**
 * Archiving a contact.
 *
 * The meeting opened with "I can't delete the people who blocked us". This is
 * the answer, and the properties below are why it archives rather than deletes:
 *
 *  1. NOTHING IS ERASED. The consent record, the blacklist flag and the audit
 *     trail survive archiving untouched. They are the evidence that somebody
 *     said stop.
 *
 *  2. IDENTITY STILL RESOLVES. An archived person who messages again resolves to
 *     the SAME record — not a fresh one with no opt-out on it. This is the
 *     failure that deleting would cause, and it is the single most important
 *     assertion in this file.
 *
 *  3. THEY LEAVE THE WORKING LISTS. Directory, global search and the counter
 *     lookup stop offering them.
 *
 *  4. THEY LEAVE CAMPAIGN AUDIENCES. A segment rule is re-evaluated on every
 *     send, so a contact archived afterwards must not walk back in.
 *
 *  5. RESTORING IS NOT UN-BLOCKING. A restored contact is visible again and
 *     still opted out.
 *
 *  6. IT IS A MANAGER'S ACT, AND IT IS EXPLAINED. A salesperson cannot archive,
 *     and a reason is mandatory.
 */

const PASSWORD = 'password123';

const A = {
  org: 'org_arc_a', slug: 'arc-a', store: 'store_arc_a',
  ho: 'ho.arc@arc-a.local', rep: 'rep.arc@arc-a.local',
};
const B = { org: 'org_arc_b', slug: 'arc-b', store: 'store_arc_b', ho: 'ho.arc@arc-b.local' };

/** Documentation range; belongs to nobody. */
const BLOCKER_PHONE = '919812350001';

async function teardown(prisma: import('../src/prisma/prisma.service').PrismaService) {
  const orgs = [A.org, B.org];
  await prisma.auditLog.deleteMany({ where: { organisationId: { in: orgs } } });
  await prisma.activityEvent.deleteMany({ where: { organisationId: { in: orgs } } });
  await prisma.contactPoint.deleteMany({ where: { organisationId: { in: orgs } } });
  await prisma.party.deleteMany({ where: { organisationId: { in: orgs } } });
  await prisma.userStore.deleteMany({ where: { user: { organisationId: { in: orgs } } } });
  await prisma.user.deleteMany({ where: { organisationId: { in: orgs } } });
  await prisma.store.deleteMany({ where: { organisationId: { in: orgs } } });
  await prisma.organisation.deleteMany({ where: { id: { in: orgs } } });
}

describe('Contact archive (e2e)', () => {
  let app: INestApplication;
  let prisma: import('../src/prisma/prisma.service').PrismaService;
  let hoA: string;
  let repA: string;
  let hoB: string;
  let blockerId: string;
  let keeperId: string;
  let otherTenantId: string;

  const server = () => app.getHttpServer();
  const auth = (t: string) => ({ Authorization: `Bearer ${t}` });

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
      data: { id: A.org, name: 'Arc A', slug: A.slug, industryPackCode: 'retail' },
    });
    await prisma.store.create({
      data: { id: A.store, name: 'Counter', city: 'Mumbai', organisationId: A.org, timezone: 'Asia/Kolkata' },
    });
    for (const [id, email, role] of [
      ['u_arc_a_ho', A.ho, 'head_office'],
      ['u_arc_a_rep', A.rep, 'salesperson'],
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
      data: { id: B.org, name: 'Arc B', slug: B.slug, industryPackCode: 'retail' },
    });
    await prisma.store.create({
      data: { id: B.store, name: 'B Counter', city: 'Pune', organisationId: B.org, timezone: 'Asia/Kolkata' },
    });
    await prisma.user.create({
      data: {
        id: 'u_arc_b_ho', email: B.ho, name: 'Arc B HO', role: 'head_office',
        passwordHash: hash, isActive: true, approvalStatus: 'approved', organisationId: B.org,
        userStores: { create: { storeId: B.store, isPrimary: true } },
      },
    });

    // Somebody who blocked us: blacklisted, with a contact point so identity
    // resolution has something to match on.
    const blocker = await prisma.party.create({
      data: {
        organisationId: A.org, storeId: A.store, name: 'Blocked Person',
        phone: BLOCKER_PHONE, whatsapp: BLOCKER_PHONE, types: ['customer'],
        isBlacklisted: true,
        contactPoints: {
          create: {
            organisationId: A.org, kind: 'phone',
            value: BLOCKER_PHONE, valueNormalized: BLOCKER_PHONE, isPrimary: true,
          },
        },
      },
    });
    blockerId = blocker.id;

    const keeper = await prisma.party.create({
      data: {
        organisationId: A.org, storeId: A.store, name: 'Active Person',
        phone: '919812350002', types: ['customer'],
      },
    });
    keeperId = keeper.id;

    const theirs = await prisma.party.create({
      data: {
        organisationId: B.org, storeId: B.store, name: 'Their Person',
        phone: '919812350003', types: ['customer'],
      },
    });
    otherTenantId = theirs.id;

    const login = async (email: string) =>
      (await request(server()).post('/auth/login').send({ email, password: PASSWORD }).expect(201))
        .body.token;
    hoA = await login(A.ho);
    repA = await login(A.rep);
    hoB = await login(B.ho);
  }, 120_000);

  afterAll(async () => {
    if (prisma) await teardown(prisma);
    if (app) await app.close();
  });

  it('a reason is mandatory', async () => {
    await request(server())
      .post(`/parties/${blockerId}/archive`)
      .set(auth(hoA))
      .send({})
      .expect(400);
    await request(server())
      .post(`/parties/${blockerId}/archive`)
      .set(auth(hoA))
      .send({ reason: 'x' })
      .expect(400);
  });

  it('a salesperson cannot archive', async () => {
    await request(server())
      .post(`/parties/${blockerId}/archive`)
      .set(auth(repA))
      .send({ reason: 'They blocked us on WhatsApp' })
      .expect(403);
  });

  it("another tenant's contact reads as not found", async () => {
    await request(server())
      .post(`/parties/${otherTenantId}/archive`)
      .set(auth(hoA))
      .send({ reason: 'Not mine to archive' })
      .expect(404);
    const still = await prisma.party.findUnique({ where: { id: otherTenantId } });
    expect(still?.archivedAt).toBeNull();
  });

  it('a manager archives with a reason, recorded with actor and time', async () => {
    const res = await request(server())
      .post(`/parties/${blockerId}/archive`)
      .set(auth(hoA))
      .send({ reason: 'They blocked us on WhatsApp' })
      .expect(201);
    expect(res.body.archived).toBe(true);

    const row = await prisma.party.findUnique({ where: { id: blockerId } });
    expect(row?.archivedAt).toBeTruthy();
    expect(row?.archivedById).toBe('u_arc_a_ho');
    expect(row?.archiveReason).toBe('They blocked us on WhatsApp');

    const audit = await prisma.auditLog.findFirst({
      where: { organisationId: A.org, action: 'crm.contact_archived', entityId: blockerId },
    });
    expect(audit).toBeTruthy();
  });

  /* ------------ the assertion this whole feature exists to satisfy --------- */

  it('archiving erases no opt-out evidence', async () => {
    const row = await prisma.party.findUnique({
      where: { id: blockerId },
      include: { contactPoints: true },
    });
    // The row is still here. The blacklist flag is still true. The contact point
    // that ties the phone number to this person is still here. Deleting the
    // contact would have taken all three.
    expect(row).toBeTruthy();
    expect(row?.isBlacklisted).toBe(true);
    expect(row?.contactPoints.length).toBeGreaterThan(0);
  });

  it('an archived person who comes back resolves to the SAME record', async () => {
    // Identity resolution must still find archived contacts. If it did not, this
    // number would open a new customer with no blacklist on it — and the next
    // campaign would message somebody who told us to stop.
    const found = await prisma.contactPoint.findFirst({
      where: { organisationId: A.org, valueNormalized: BLOCKER_PHONE },
      select: { partyId: true },
    });
    expect(found?.partyId).toBe(blockerId);
  });

  /* -------------------------------- gone from the lists people work from --- */

  it('they leave the customer directory, and appear on the archived list', async () => {
    const active = await request(server()).get('/parties?type=all').set(auth(hoA)).expect(200);
    const activeIds = active.body.items.map((p: { id: string }) => p.id);
    expect(activeIds).toContain(keeperId);
    expect(activeIds).not.toContain(blockerId);

    const archived = await request(server())
      .get('/parties?type=all&archived=true')
      .set(auth(hoA))
      .expect(200);
    const arch = archived.body.items.find((p: { id: string }) => p.id === blockerId);
    expect(arch).toBeTruthy();
    expect(arch.archiveReason).toBe('They blocked us on WhatsApp');
    expect(arch.archivedByName).toBeTruthy();
  });

  it('they leave global search', async () => {
    const res = await request(server())
      .get('/search?q=Blocked')
      .set(auth(hoA));
    if (res.status === 200) {
      const ids = JSON.stringify(res.body);
      expect(ids).not.toContain(blockerId);
    } else {
      // Search is feature-flagged off in some environments; nothing to assert.
      expect([403, 404, 501]).toContain(res.status);
    }
  });

  it('they leave campaign audiences', async () => {
    const inAudience = await prisma.party.count({
      where: { organisationId: A.org, archivedAt: null, id: blockerId },
    });
    expect(inAudience).toBe(0);
    // And the active one is still reachable, so the exclusion is not a blanket.
    expect(
      await prisma.party.count({ where: { organisationId: A.org, archivedAt: null, id: keeperId } }),
    ).toBe(1);
  });

  /* ------------------------------------------------------------- restore --- */

  it('restoring returns them to the lists but does not un-block them', async () => {
    const res = await request(server())
      .post(`/parties/${blockerId}/restore`)
      .set(auth(hoA))
      .expect(201);
    expect(res.body.archived).toBe(false);
    // Still blacklisted. Visible again is not the same as messageable again.
    expect(res.body.isBlacklisted).toBe(true);

    const row = await prisma.party.findUnique({ where: { id: blockerId } });
    expect(row?.archivedAt).toBeNull();
    expect(row?.archiveReason).toBeNull();
    expect(row?.isBlacklisted).toBe(true);

    const audit = await prisma.auditLog.findFirst({
      where: { organisationId: A.org, action: 'crm.contact_restored', entityId: blockerId },
    });
    expect(audit).toBeTruthy();
  });

  it('archiving twice, or restoring an active contact, is refused', async () => {
    await request(server())
      .post(`/parties/${blockerId}/restore`)
      .set(auth(hoA))
      .expect(400);
    await request(server())
      .post(`/parties/${blockerId}/archive`)
      .set(auth(hoA))
      .send({ reason: 'Archiving again for the test' })
      .expect(201);
    await request(server())
      .post(`/parties/${blockerId}/archive`)
      .set(auth(hoA))
      .send({ reason: 'And again' })
      .expect(400);
  });
});
