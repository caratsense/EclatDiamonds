import { INestApplication, ValidationPipe } from '@nestjs/common';
import { Test } from '@nestjs/testing';
import request = require('supertest');
import * as bcrypt from 'bcryptjs';

import { AppModule } from '../src/app.module';
import { PrismaService } from '../src/prisma/prisma.service';

/**
 * The floor / field application.
 *
 * The screen this replaced rendered a hardcoded array, so the tests that matter
 * are the ones a fixture cannot fake:
 *
 *   - a partial phone fragment finds the right person, and ONLY inside the
 *     caller's tenant;
 *   - an unknown barcode is an answer, not a 500;
 *   - a visit with several enquiries is one visit, not several;
 *   - a non-jewellery tenant can record a visit without picking a jewellery
 *     purpose.
 *
 * Seeded as MANUFACTURING for that last reason.
 */
const PASSWORD = 'password123';

const A = {
  org: 'org_instore_a',
  slug: 'instore-a',
  store: 'store_instore_a',
  store2: 'store_instore_a2',
  ho: 'ho.instore@instore-a.local',
  rep: 'rep.instore@instore-a.local',
};
const B = { org: 'org_instore_b', slug: 'instore-b', store: 'store_instore_b' };

describe('In-store / field application (e2e)', () => {
  let app: INestApplication;
  let prisma: PrismaService;
  let token: string;
  let repToken: string;
  let productId: string;

  const auth = () => ({ Authorization: `Bearer ${token}` });
  const server = () => app.getHttpServer();

  beforeAll(async () => {
    const mod = await Test.createTestingModule({ imports: [AppModule] }).compile();
    app = mod.createNestApplication();
    app.useGlobalPipes(
      new ValidationPipe({ whitelist: true, forbidNonWhitelisted: true, transform: true }),
    );
    await app.init();
    prisma = app.get(PrismaService);

    await teardown(prisma);
    const hash = await bcrypt.hash(PASSWORD, 10);

    await prisma.organisation.create({
      data: { id: A.org, name: 'InStore A', slug: A.slug, industryPackCode: 'manufacturing' },
    });
    await prisma.store.create({
      data: { id: A.store, name: 'Plant One', city: 'Pune', organisationId: A.org },
    });
    await prisma.store.create({
      data: { id: A.store2, name: 'Plant Two', city: 'Nashik', organisationId: A.org },
    });
    await prisma.user.create({
      data: {
        email: A.ho, name: 'HO', role: 'head_office', passwordHash: hash, isActive: true,
        approvalStatus: 'approved', organisationId: A.org,
        userStores: { create: { storeId: A.store, isPrimary: true } },
      },
    });
    await prisma.user.create({
      data: {
        email: A.rep, name: 'Rep', role: 'salesperson', passwordHash: hash, isActive: true,
        approvalStatus: 'approved', organisationId: A.org,
        userStores: { create: { storeId: A.store, isPrimary: true } },
      },
    });

    await prisma.organisation.create({
      data: { id: B.org, name: 'InStore B', slug: B.slug, industryPackCode: 'healthcare' },
    });
    await prisma.store.create({
      data: { id: B.store, name: 'Other', city: 'Mumbai', organisationId: B.org },
    });

    await prisma.party.create({
      data: {
        id: 'p_is1', organisationId: A.org, storeId: A.store, name: 'Vedant Kothari',
        types: ['customer'], whatsapp: '+919309137416', code: 'CUS-1001', city: 'Pune',
        contactPoints: {
          create: {
            organisationId: A.org, kind: 'whatsapp',
            value: '+919309137416', valueNormalized: '919309137416', isPrimary: true,
          },
        },
      },
    });
    // Same last digits in ANOTHER tenant: must never surface for tenant A.
    await prisma.party.create({
      data: {
        id: 'p_is_b', organisationId: B.org, storeId: B.store, name: 'Other Tenant Person',
        types: ['customer'], whatsapp: '+919309137999',
        contactPoints: {
          create: {
            organisationId: B.org, kind: 'whatsapp',
            value: '+919309137999', valueNormalized: '919309137999', isPrimary: true,
          },
        },
      },
    });

    const product = await prisma.product.create({
      data: {
        organisationId: A.org, sku: 'ITEM-4402', name: 'Bearing Assembly 12mm',
        category: 'other', metal: 'unspecified',
      },
    });
    productId = product.id;

    token = (await login(A.ho)).body.token;
    repToken = (await login(A.rep)).body.token;
  });

  const login = (email: string) =>
    request(server()).post('/auth/login').send({ email, password: PASSWORD });

  afterAll(async () => {
    await teardown(prisma);
    await app?.close();
  });

  /* ------------------------------------------------------------------ search */

  describe('finding a walk-in', () => {
    it('matches on a fragment of the number, the way a counter actually works', async () => {
      const res = await request(server())
        .get('/instore/search')
        .set(auth())
        .query({ q: '930' })
        .expect(200);
      expect(res.body.matchedOn).toBe('contact');
      expect(res.body.items).toHaveLength(1);
      expect(res.body.items[0].name).toBe('Vedant Kothari');
    });

    it('never returns another tenant’s customer with the same digits', async () => {
      const res = await request(server())
        .get('/instore/search')
        .set(auth())
        .query({ q: '9309137' })
        .expect(200);
      const names = res.body.items.map((i: { name: string }) => i.name);
      expect(names).toContain('Vedant Kothari');
      expect(names).not.toContain('Other Tenant Person');
    });

    it('matches on name and on the tenant’s own customer code', async () => {
      const byName = await request(server())
        .get('/instore/search').set(auth()).query({ q: 'Vedant' }).expect(200);
      expect(byName.body.items[0]?.name).toBe('Vedant Kothari');

      const byCode = await request(server())
        .get('/instore/search').set(auth()).query({ q: 'CUS-1001' }).expect(200);
      expect(byCode.body.items[0]?.customerId).toBe('CUS-1001');
    });

    it('refuses a fragment too short to be a search', async () => {
      await request(server()).get('/instore/search').set(auth()).query({ q: '93' }).expect(400);
    });

    it('offers to create rather than 404 when nobody matches', async () => {
      const res = await request(server())
        .get('/instore/search').set(auth()).query({ q: '7770001111' }).expect(200);
      expect(res.body.items).toHaveLength(0);
      expect(res.body.canCreate).toBe(true);
    });

    it('is open to a salesperson, who is the person actually standing there', async () => {
      await request(server())
        .get('/instore/search')
        .set({ Authorization: `Bearer ${repToken}` })
        .query({ q: '930' })
        .expect(200);
    });
  });

  /* -------------------------------------------------------------------- scan */

  describe('scanning', () => {
    it('resolves a catalogue item', async () => {
      const res = await request(server())
        .get('/instore/scan').set(auth()).query({ code: 'ITEM-4402' }).expect(200);
      expect(res.body.found).toBe(true);
      expect(res.body.item.name).toBe('Bearing Assembly 12mm');
    });

    it('answers "not found" instead of failing, because an unknown tag is normal', async () => {
      const res = await request(server())
        .get('/instore/scan').set(auth()).query({ code: 'NO-SUCH-TAG' }).expect(200);
      expect(res.body.found).toBe(false);
      expect(res.body.code).toBe('NO-SUCH-TAG');
    });

    it('does not resolve another tenant’s item', async () => {
      const other = await prisma.product.create({
        data: { organisationId: B.org, sku: 'B-ONLY-1', name: 'Theirs', category: 'other', metal: 'unspecified' },
      });
      const res = await request(server())
        .get('/instore/scan').set(auth()).query({ code: 'B-ONLY-1' }).expect(200);
      expect(res.body.found).toBe(false);
      await prisma.product.delete({ where: { id: other.id } });
    });
  });

  /* ------------------------------------------------------------------ visits */

  describe('recording a visit', () => {
    it('records several enquiries as ONE visit', async () => {
      const res = await request(server())
        .post('/instore/visits')
        .set(auth())
        .send({
          partyId: 'p_is1',
          storeId: A.store,
          notes: 'Asked about lead times',
          enquiries: [
            { productId, converted: true, quantity: 2 },
            { sku: 'NO-SUCH-TAG', converted: false, dropOffReason: 'price' },
          ],
        })
        .expect(201);

      expect(res.body.enquiries).toBe(2);
      expect(res.body.partiallyConverted).toBe(true);

      // One check-in, two interactions. Recording it as two visits would triple
      // the branch's footfall.
      const checkIns = await prisma.checkIn.count({
        where: { organisationId: A.org, partyId: 'p_is1' },
      });
      expect(checkIns).toBe(1);
      const interactions = await prisma.productInteraction.count({
        where: { organisationId: A.org, partyId: 'p_is1' },
      });
      expect(interactions).toBe(2);
    });

    it('keeps the raw code for an item that is not in the catalogue', async () => {
      const row = await prisma.productInteraction.findFirst({
        where: { organisationId: A.org, partyId: 'p_is1', productId: null },
      });
      expect(row?.sku).toBe('NO-SUCH-TAG');
      expect((row?.metadata as { dropOffReason?: string })?.dropOffReason).toBe('price');
    });

    it('does not force a manufacturing tenant to pick a jewellery visit purpose', async () => {
      const checkIn = await prisma.checkIn.findFirst({
        where: { organisationId: A.org, partyId: 'p_is1' },
      });
      // The jewellery enum stays neutral; the tenant's own code column is where
      // a real answer would go.
      expect(checkIn?.purpose).toBe('other');
      expect(checkIn?.notes).toBe('Asked about lead times');
    });

    it('writes the visit to the customer timeline', async () => {
      const events = await prisma.activityEvent.findMany({
        where: { organisationId: A.org, partyId: 'p_is1', type: 'visit.recorded' },
      });
      expect(events).toHaveLength(1);
      expect(events[0].storeId).toBe(A.store);
    });

    it('refuses a visit against another tenant’s customer', async () => {
      const res = await request(server())
        .post('/instore/visits')
        .set(auth())
        .send({ partyId: 'p_is_b', storeId: A.store });
      expect([400, 403, 404]).toContain(res.status);
    });

    it('refuses a branch the caller cannot see', async () => {
      const res = await request(server())
        .post('/instore/visits')
        .set({ Authorization: `Bearer ${repToken}` })
        .send({ partyId: 'p_is1', storeId: A.store2 });
      expect([400, 403]).toContain(res.status);
    });

    it('keeps a counter photo with the visit, and never calls it an identification', async () => {
      const PNG_1PX =
        'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==';
      const res = await request(server())
        .post('/instore/visits')
        .set(auth())
        .send({ partyId: 'p_is1', storeId: A.store, photo: `data:image/png;base64,${PNG_1PX}` })
        .expect(201);

      const row = await prisma.checkIn.findUniqueOrThrow({
        where: { id: res.body.checkInId },
      });
      expect(row.photoUrl).toBeTruthy();
      // A pointer, not the bytes.
      expect(row.photoUrl).not.toContain('base64');
      // Namespaced to this tenant, like every other stored object.
      expect(row.photoUrl).toContain(`org/${A.org}`);
      // Nothing anywhere claims the picture established who walked in.
      const body = JSON.stringify(res.body).toLowerCase();
      expect(body).not.toContain('recognis');
      expect(body).not.toContain('biometric');
      expect(body).not.toContain('confidence');
    });

    it('records the visit anyway when the frame is not a real image', async () => {
      const lie = Buffer.from('definitely not a png').toString('base64');
      const res = await request(server())
        .post('/instore/visits')
        .set(auth())
        .send({ partyId: 'p_is1', storeId: A.store, photo: `data:image/png;base64,${lie}` })
        .expect(201);
      const row = await prisma.checkIn.findUniqueOrThrow({ where: { id: res.body.checkInId } });
      expect(row.photoUrl).toBeNull();
      // The visit is the thing that matters; the photo is beside it.
      expect(row.timeIn).toBeTruthy();
    });

    it('refuses an item belonging to another tenant', async () => {
      const other = await prisma.product.create({
        data: { organisationId: B.org, sku: 'B-ONLY-2', name: 'Theirs', category: 'other', metal: 'unspecified' },
      });
      const res = await request(server())
        .post('/instore/visits')
        .set(auth())
        .send({ partyId: 'p_is1', storeId: A.store, enquiries: [{ productId: other.id }] });
      expect(res.status).toBe(400);
      await prisma.product.delete({ where: { id: other.id } });
    });
  });

  /* --------------------------------------------------------------- lead feed */

  describe('the lead feed', () => {
    it('reports the uncapped total beside the page', async () => {
      // The rep's own lead: a salesperson's feed is the leads they own.
      const rep = await prisma.user.findUniqueOrThrow({ where: { email: A.rep }, select: { id: true } });
      await prisma.lead.create({
        data: {
          organisationId: A.org, storeId: A.store, partyId: 'p_is1', ownerId: rep.id,
          customerName: 'Vedant Kothari', interest: 'Bearings', source: 'walk_in',
          stage: 'inquiry', ref: 'LD-9001',
        },
      });
      const res = await request(server())
        .get('/instore/leads').set(auth()).query({ limit: 1 }).expect(200);
      expect(typeof res.body.total).toBe('number');
      expect(res.body.total).toBeGreaterThanOrEqual(1);
      expect(res.body.items.length).toBeLessThanOrEqual(1);
    });

    it('shows a salesperson only their own branch', async () => {
      await prisma.lead.create({
        data: {
          organisationId: A.org, storeId: A.store2,
          customerName: 'Other Plant', interest: 'Castings', source: 'walk_in',
          stage: 'inquiry', ref: 'LD-9002',
        },
      });
      const res = await request(server())
        .get('/instore/leads')
        .set({ Authorization: `Bearer ${repToken}` })
        .expect(200);
      const refs = res.body.items.map((i: { ref: string }) => i.ref);
      expect(refs).toContain('LD-9001');
      expect(refs).not.toContain('LD-9002');
    });
  });
});

async function teardown(prisma: PrismaService) {
  for (const org of [A.org, B.org]) {
    await prisma.productInteraction.deleteMany({ where: { organisationId: org } }).catch(() => undefined);
    await prisma.checkIn.deleteMany({ where: { organisationId: org } }).catch(() => undefined);
    await prisma.activityEvent.deleteMany({ where: { organisationId: org } }).catch(() => undefined);
    await prisma.leadFollowUp.deleteMany({ where: { lead: { organisationId: org } } }).catch(() => undefined);
    await prisma.lead.deleteMany({ where: { organisationId: org } });
    await prisma.productEmbedding.deleteMany({ where: { product: { organisationId: org } } }).catch(() => undefined);
    await prisma.product.deleteMany({ where: { organisationId: org } }).catch(() => undefined);
    await prisma.contactPoint.deleteMany({ where: { organisationId: org } });
    await prisma.party.deleteMany({ where: { organisationId: org } });
    await prisma.auditLog.deleteMany({ where: { organisationId: org } });
    await prisma.userStore.deleteMany({ where: { store: { organisationId: org } } });
    await prisma.user.deleteMany({ where: { organisationId: org } });
    await prisma.store.deleteMany({ where: { organisationId: org } });
    await prisma.organisation.deleteMany({ where: { id: org } });
  }
}
