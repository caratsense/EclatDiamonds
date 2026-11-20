import { mkdtempSync, rmSync, existsSync } from 'fs';
import { tmpdir } from 'os';
import { join } from 'path';

import { INestApplication, ValidationPipe } from '@nestjs/common';
import { Test } from '@nestjs/testing';
import request = require('supertest');
import * as bcrypt from 'bcryptjs';

/**
 * The floor app's own reads: the day's visits, the day's figures, and the
 * capture forms for this counter.
 *
 * Three properties are pinned here, and each of them was wrong before:
 *
 *  1. A VISIT KNOWS ITS OWN ENQUIRIES. `ProductInteraction.checkInId` now
 *     records which visit an item-interest belonged to. Reconstructing it from
 *     partyId and a time window — the only thing possible before — attaches one
 *     customer's enquiries to another customer's visit the moment two people
 *     are at the counter within the same few minutes.
 *
 *  2. THE DAY IS THE BRANCH'S DAY. The window is built from the store's own
 *     timezone, so an API container in another zone does not silently report a
 *     different slice of the day.
 *
 *  3. NOTHING CROSSES A TENANT OR A BRANCH. Including the capture forms, whose
 *     `publicKey` is a capability: whoever holds one can file leads into that
 *     branch, so a list must not hand one out.
 */

const PNG_1PX =
  'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==';

const A = {
  org: 'org_floor_a',
  slug: 'floor-a',
  storeOne: 'store_floor_a1',
  storeTwo: 'store_floor_a2',
  rep: 'rep.floor@floor-a.local',
  ho: 'ho.floor@floor-a.local',
};
const B = { org: 'org_floor_b', slug: 'floor-b', store: 'store_floor_b', rep: 'rep.floor@floor-b.local' };
const PASSWORD = 'password123';

describe('The floor app (e2e)', () => {
  let app: INestApplication;
  let prisma: import('../src/prisma/prisma.service').PrismaService;
  let repToken: string;
  let hoToken: string;
  let otherOrgToken: string;
  let uploadDir: string;
  let visitId: string;

  const server = () => app.getHttpServer();
  const rep = () => ({ Authorization: `Bearer ${repToken}` });
  const ho = () => ({ Authorization: `Bearer ${hoToken}` });

  beforeAll(async () => {
    uploadDir = mkdtempSync(join(tmpdir(), 'eclat-floor-'));
    process.env.UPLOAD_DIR = uploadDir;

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
      data: { id: A.org, name: 'Floor A', slug: A.slug, industryPackCode: 'retail' },
    });
    await prisma.store.createMany({
      data: [
        {
          id: A.storeOne, name: 'Counter One', city: 'Mumbai', organisationId: A.org,
          timezone: 'Asia/Kolkata',
        },
        {
          id: A.storeTwo, name: 'Counter Two', city: 'Surat', organisationId: A.org,
          timezone: 'Asia/Kolkata',
        },
      ],
    });
    await prisma.user.create({
      data: {
        id: 'u_floor_rep', email: A.rep, name: 'Floor Rep', role: 'salesperson',
        passwordHash: hash, isActive: true, approvalStatus: 'approved', organisationId: A.org,
        userStores: { create: { storeId: A.storeOne, isPrimary: true } },
      },
    });
    await prisma.user.create({
      data: {
        id: 'u_floor_ho', email: A.ho, name: 'Floor HO', role: 'head_office',
        passwordHash: hash, isActive: true, approvalStatus: 'approved', organisationId: A.org,
        userStores: { create: { storeId: A.storeOne, isPrimary: true } },
      },
    });

    // A second tenant, so every read below can be shown not to reach it.
    await prisma.organisation.create({
      data: { id: B.org, name: 'Floor B', slug: B.slug, industryPackCode: 'retail' },
    });
    await prisma.store.create({
      data: { id: B.store, name: 'Their Counter', city: 'Pune', organisationId: B.org },
    });
    await prisma.user.create({
      data: {
        id: 'u_floor_b', email: B.rep, name: 'Their Rep', role: 'salesperson',
        passwordHash: hash, isActive: true, approvalStatus: 'approved', organisationId: B.org,
        userStores: { create: { storeId: B.store, isPrimary: true } },
      },
    });

    await prisma.party.createMany({
      data: [
        {
          id: 'p_floor_1', organisationId: A.org, storeId: A.storeOne, name: 'Asha Menon',
          code: 'CUS-9001', types: ['customer'],
        },
        {
          id: 'p_floor_2', organisationId: A.org, storeId: A.storeTwo, name: 'Ravi Patel',
          code: 'CUS-9002', types: ['customer'],
        },
      ],
    });
    await prisma.product.create({
      data: {
        id: 'prod_floor_1', organisationId: A.org, name: 'Consultation slot', sku: 'SKU-FLOOR-1',
        // `category` is the legacy jewellery enum; `categoryLabel` is the
        // neutral field every other industry writes. A retail tenant that has
        // set its own word must see its own word back.
        category: 'other',
        metal: 'unspecified',
        categoryLabel: 'Consultations',
      },
    });

    const login = async (email: string) =>
      (await request(server()).post('/auth/login').send({ email, password: PASSWORD }).expect(201))
        .body.token;
    repToken = await login(A.rep);
    hoToken = await login(A.ho);
    otherOrgToken = await login(B.rep);

    // One visit, recorded through the floor app so it carries a photo, two
    // enquiries and a drop-off reason.
    const recorded = await request(server())
      .post('/instore/visits')
      .set(rep())
      .send({
        partyId: 'p_floor_1',
        storeId: A.storeOne,
        purpose: 'consultation',
        notes: 'Asked about the new range.',
        fields: { counter: 'Bridal desk' },
        photo: `data:image/png;base64,${PNG_1PX}`,
        enquiries: [
          { productId: 'prod_floor_1', converted: true, quantity: 1 },
          { sku: 'UNCATALOGUED-77', converted: false, dropOffReason: 'Wanted a smaller size' },
        ],
      })
      .expect(201);
    visitId = recorded.body.checkInId;
  }, 240_000);

  afterAll(async () => {
    if (prisma) await teardown(prisma);
    if (app) await app.close();
    if (uploadDir && existsSync(uploadDir)) rmSync(uploadDir, { recursive: true, force: true });
    delete process.env.UPLOAD_DIR;
  });

  /* --------------------------------------------------------------- visits */

  describe('the day’s visits', () => {
    it('returns the visit with the enquiries that belong to it', async () => {
      const res = await request(server()).get('/instore/visits').set(rep()).expect(200);
      const visit = res.body.items.find((v: { id: string }) => v.id === visitId);
      expect(visit).toBeDefined();
      expect(visit.customerName).toBe('Asha Menon');
      expect(visit.customerId).toBe('CUS-9001');
      expect(visit.enquiries).toHaveLength(2);

      const converted = visit.enquiries.find((e: { converted: boolean }) => e.converted);
      expect(converted.name).toBe('Consultation slot');
      // The tenant's own vocabulary, never the jewellery enum underneath it.
      expect(converted.category).toBe('Consultations');

      const lost = visit.enquiries.find((e: { converted: boolean }) => !e.converted);
      // The raw code survives even though it matched no catalogue row: an
      // uncatalogued item is still something a customer asked for.
      expect(lost.name).toBe('UNCATALOGUED-77');
      expect(lost.dropOffReason).toBe('Wanted a smaller size');
    });

    it('does not attach one customer’s enquiries to another’s visit', async () => {
      // A second customer at the same counter, minutes apart — the exact case a
      // partyId + time-window reconstruction gets wrong.
      const second = await request(server())
        .post('/instore/visits')
        .set(ho())
        .send({
          partyId: 'p_floor_2',
          storeId: A.storeOne,
          enquiries: [{ sku: 'OTHER-CUSTOMER-ITEM', converted: false }],
        })
        .expect(201);

      // Read as head office: the second visit is head office's, and a
      // salesperson's day lists only the visits they attended.
      const res = await request(server()).get('/instore/visits').set(ho()).expect(200);
      const first = res.body.items.find((v: { id: string }) => v.id === visitId);
      const other = res.body.items.find((v: { id: string }) => v.id === second.body.checkInId);
      const repView = await request(server()).get('/instore/visits').set(rep()).expect(200);
      expect(repView.body.items.map((v: { id: string }) => v.id)).not.toContain(second.body.checkInId);

      expect(first.enquiries).toHaveLength(2);
      expect(other.enquiries.map((e: { name: string }) => e.name)).toEqual([
        'OTHER-CUSTOMER-ITEM',
      ]);
      await prisma.productInteraction.deleteMany({ where: { checkInId: second.body.checkInId } });
      await prisma.checkIn.delete({ where: { id: second.body.checkInId } });
    });

    it('reports the arrival on the branch’s clock, not the server’s', async () => {
      const res = await request(server()).get('/instore/visits').set(rep()).expect(200);
      expect(res.body.timezone).toBe('Asia/Kolkata');
      const visit = res.body.items.find((v: { id: string }) => v.id === visitId);
      expect(visit.timeInLocal).toMatch(/^\d{2}:\d{2}$/);
      // Kolkata is UTC+5:30, so the wall clock must NOT be the UTC one.
      const utc = new Date(visit.timeIn).toISOString().slice(11, 16);
      expect(visit.timeInLocal).not.toBe(utc);
    });

    it('names who attended, as an id rather than a display string', async () => {
      const res = await request(server()).get('/instore/visits').set(rep()).expect(200);
      const visit = res.body.items.find((v: { id: string }) => v.id === visitId);
      expect(visit.attendedBy).toEqual({ id: 'u_floor_rep', name: 'Floor Rep' });
    });

    it('keeps the tenant’s own visit fields as recorded', async () => {
      const res = await request(server()).get('/instore/visits').set(rep()).expect(200);
      const visit = res.body.items.find((v: { id: string }) => v.id === visitId);
      expect(visit.fields).toEqual({ counter: 'Bridal desk' });
      expect(visit.purpose).toBe('consultation');
    });

    it('shows a day with nothing on it as empty, not as an error', async () => {
      const res = await request(server())
        .get('/instore/visits').set(rep()).query({ date: '2020-01-01' }).expect(200);
      expect(res.body.items).toEqual([]);
      expect(res.body.date).toBe('2020-01-01');
    });

    it('refuses a date it cannot read', async () => {
      await request(server())
        .get('/instore/visits').set(rep()).query({ date: 'yesterday' }).expect(400);
    });

    it('pages rather than silently truncating', async () => {
      // Its own second row, so this does not depend on what another test left
      // behind — a paging test that passes only when run in a particular order
      // is not a paging test.
      const extra = await request(server())
        .post('/instore/visits')
        .set(rep())
        .send({ partyId: 'p_floor_1', storeId: A.storeOne })
        .expect(201);

      const first = await request(server())
        .get('/instore/visits').set(rep()).query({ limit: 1 }).expect(200);
      expect(first.body.items).toHaveLength(1);
      expect(first.body.nextCursor).toBeTruthy();

      const second = await request(server())
        .get('/instore/visits').set(rep()).query({ limit: 1, cursor: first.body.nextCursor })
        .expect(200);
      expect(second.body.items).toHaveLength(1);
      expect(second.body.items[0].id).not.toBe(first.body.items[0].id);

      await prisma.checkIn.delete({ where: { id: extra.body.checkInId } });
    });

    it('does not show another tenant’s visits', async () => {
      const res = await request(server())
        .get('/instore/visits')
        .set({ Authorization: `Bearer ${otherOrgToken}` })
        .expect(200);
      expect(res.body.items.map((v: { id: string }) => v.id)).not.toContain(visitId);
    });

    it('refuses a branch the caller does not work at', async () => {
      await request(server())
        .get('/instore/visits').set(rep()).query({ storeId: A.storeTwo }).expect(403);
    });
  });

  /* ------------------------------------------------------- the visit photo */

  describe('the visit photo', () => {
    it('is offered as a route to ask on, never as the object’s own URL', async () => {
      const res = await request(server()).get('/instore/visits').set(rep()).expect(200);
      const visit = res.body.items.find((v: { id: string }) => v.id === visitId);
      expect(visit.photoUrl).toBe(`/instore/visits/${visitId}/photo`);
      // The storage path — which the static handler serves with no guard at all
      // — must not appear anywhere in the response.
      expect(JSON.stringify(res.body)).not.toContain('/uploads/');
    });

    it('hands the bytes to someone who works at that branch', async () => {
      const res = await request(server())
        .get(`/instore/visits/${visitId}/photo`).set(rep()).expect(200);
      expect(res.headers['content-type']).toContain('image/png');
      expect(res.body.length).toBeGreaterThan(0);
    });

    it('refuses another tenant', async () => {
      await request(server())
        .get(`/instore/visits/${visitId}/photo`)
        .set({ Authorization: `Bearer ${otherOrgToken}` })
        .expect(404);
    });

    it('refuses a stranger with no session at all', async () => {
      await request(server()).get(`/instore/visits/${visitId}/photo`).expect(401);
    });

    it('is not reachable on the unguarded static path', async () => {
      const stored = await prisma.checkIn.findUniqueOrThrow({
        where: { id: visitId },
        select: { photoUrl: true },
      });
      // The row still points at a real object — this is about who may fetch it.
      expect(stored.photoUrl).toContain(`org/${A.org}/visits`);
      await request(server()).get(stored.photoUrl!).expect(404);
    });
  });

  /* ------------------------------------------------------ the day’s figures */

  describe('the day’s figures', () => {
    it('counts the branch’s footfall and its outcome mix', async () => {
      const res = await request(server()).get('/instore/today').set(rep()).expect(200);
      expect(res.body.footfall).toBeGreaterThanOrEqual(1);
      expect(res.body.converted).toBeGreaterThanOrEqual(1);
      expect(res.body.timezone).toBe('Asia/Kolkata');
      expect(res.body.storeIds).toEqual([A.storeOne]);
    });

    it('reports no drop-off RATE at all on a day with no visitors', async () => {
      const res = await request(server())
        .get('/instore/today').set(rep()).query({ date: '2020-01-01' }).expect(200);
      expect(res.body.footfall).toBe(0);
      // Null, not 0 — there is no rate of nothing, and 0% reads as "nobody
      // walked out", which is a claim this has no basis for.
      expect(res.body.dropOffRate).toBeNull();
    });

    it('says nothing was logged rather than drawing an empty category chart', async () => {
      const res = await request(server())
        .get('/instore/today').set(rep()).query({ date: '2020-01-01' }).expect(200);
      expect(res.body.topCategories).toBeNull();
    });

    it('groups today’s interest by the catalogue’s own category', async () => {
      const res = await request(server()).get('/instore/today').set(rep()).expect(200);
      expect(res.body.topCategories).toEqual([{ name: 'Consultations', count: 1 }]);
    });

    it('does not count another tenant’s day', async () => {
      const res = await request(server())
        .get('/instore/today')
        .set({ Authorization: `Bearer ${otherOrgToken}` })
        .expect(200);
      expect(res.body.footfall).toBe(0);
    });
  });

  /* ---------------------------------------------------------------- forms */

  describe('the capture forms', () => {
    beforeAll(async () => {
      await prisma.leadForm.createMany({
        data: [
          {
            id: 'lf_floor_mine', organisationId: A.org, storeId: A.storeOne,
            publicKey: 'floorkeymine0000000000000000000a', name: 'Counter One enquiries',
          },
          {
            id: 'lf_floor_other', organisationId: A.org, storeId: A.storeTwo,
            publicKey: 'floorkeyother000000000000000000b', name: 'Counter Two enquiries',
          },
        ],
      });
    });

    it('lists the forms for the counter the caller works at', async () => {
      const res = await request(server()).get('/instore/forms').set(rep()).expect(200);
      expect(res.body.map((f: { id: string }) => f.id)).toEqual(['lf_floor_mine']);
      expect(res.body[0].submitPath).toBe('/enquiry/floorkeymine0000000000000000000a');
    });

    it('does not hand a salesperson another branch’s capability key', async () => {
      const res = await request(server()).get('/instore/forms').set(rep()).expect(200);
      // The publicKey lets anyone holding it file leads into that branch.
      expect(JSON.stringify(res.body)).not.toContain('floorkeyother');
    });

    it('does not list another tenant’s forms', async () => {
      const res = await request(server())
        .get('/instore/forms')
        .set({ Authorization: `Bearer ${otherOrgToken}` })
        .expect(200);
      expect(res.body).toEqual([]);
    });

    it('counts submissions from what the form actually produced', async () => {
      await request(server())
        .post('/public/lead-forms/floorkeymine0000000000000000000a')
        .send({
          // A UUID: the DTO requires one, so a double-tap returns the first
          // lead rather than a second.
          submissionId: '6f1d0b2a-8c3e-4a51-9f2d-7b0c5e4a1d33',
          customerName: 'Nikhil Rao',
          phone: '+919820055011',
          interest: 'A quote',
          consent: true,
        })
        .expect(201);

      const res = await request(server()).get('/instore/forms').set(rep()).expect(200);
      expect(res.body[0].submissions.total).toBe(1);
      expect(res.body[0].submissions.latest.customerName).toBe('Nikhil Rao');
    });

    it('also refuses the manager list to a branch the manager does not cover', async () => {
      /*
       * The same rule on the management endpoint. `publicKey` is authority —
       * whoever holds one can file leads into that branch — so listing must not
       * grant authority the caller does not otherwise have. It used to filter
       * on organisation alone, which handed a single-branch manager every
       * branch's key.
       *
       * A store manager, not head office: head office's scope IS every branch
       * of its organisation, so it seeing both is correct and proves nothing.
       */
      const hash = await bcrypt.hash(PASSWORD, 10);
      await prisma.user.create({
        data: {
          id: 'u_floor_sm', email: 'sm.floor@floor-a.local', name: 'One Branch Manager',
          role: 'store_manager', passwordHash: hash, isActive: true,
          approvalStatus: 'approved', organisationId: A.org,
          userStores: { create: { storeId: A.storeOne, isPrimary: true } },
        },
      });
      const smToken = (
        await request(server())
          .post('/auth/login')
          .send({ email: 'sm.floor@floor-a.local', password: PASSWORD })
          .expect(201)
      ).body.token;

      const res = await request(server())
        .get('/crm/lead-forms')
        .set({ Authorization: `Bearer ${smToken}` })
        .expect(200);
      const keys = res.body.map((f: { publicKey: string }) => f.publicKey);
      expect(keys).toContain('floorkeymine0000000000000000000a');
      expect(keys).not.toContain('floorkeyother000000000000000000b');
    });
  });
});

async function teardown(prisma: import('../src/prisma/prisma.service').PrismaService) {
  const orgs = [A.org, B.org];
  const drop = async (fn: () => Promise<unknown>) => {
    await fn().catch(() => undefined);
  };
  await drop(() => prisma.productInteraction.deleteMany({ where: { organisationId: { in: orgs } } }));
  await drop(() => prisma.activityEvent.deleteMany({ where: { organisationId: { in: orgs } } }));
  await drop(() => prisma.checkIn.deleteMany({ where: { organisationId: { in: orgs } } }));
  await drop(() => prisma.leadFollowUp.deleteMany({ where: { lead: { organisationId: { in: orgs } } } }));
  await drop(() => prisma.leadNote.deleteMany({ where: { lead: { organisationId: { in: orgs } } } }));
  await drop(() => prisma.task.deleteMany({ where: { organisationId: { in: orgs } } }));
  await drop(() => prisma.lead.deleteMany({ where: { organisationId: { in: orgs } } }));
  await drop(() => prisma.leadForm.deleteMany({ where: { organisationId: { in: orgs } } }));
  await drop(() => prisma.contactPoint.deleteMany({ where: { organisationId: { in: orgs } } }));
  await drop(() => prisma.party.deleteMany({ where: { organisationId: { in: orgs } } }));
  await drop(() => prisma.product.deleteMany({ where: { organisationId: { in: orgs } } }));
  await drop(() => prisma.auditLog.deleteMany({ where: { organisationId: { in: orgs } } }));
  await drop(() => prisma.userStore.deleteMany({ where: { store: { organisationId: { in: orgs } } } }));
  await drop(() => prisma.user.deleteMany({ where: { organisationId: { in: orgs } } }));
  await drop(() => prisma.store.deleteMany({ where: { organisationId: { in: orgs } } }));
  await drop(() => prisma.organisation.deleteMany({ where: { id: { in: orgs } } }));
}
