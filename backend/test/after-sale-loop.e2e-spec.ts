import { INestApplication, ValidationPipe } from '@nestjs/common';
import { Test } from '@nestjs/testing';
import request = require('supertest');
import * as bcrypt from 'bcryptjs';

import { normalizeIndianMobile } from '../src/common/contact.util';
import { docTypeFromTranType } from '../src/sync/sync.util';

/**
 * What a sale, a quote and a factory order are supposed to set in motion.
 *
 * Every link below was absent while the whole suite passed, because a suite
 * cannot fail on code nobody wrote. These are the tests that would have caught
 * it, and that fail again the day somebody unplugs one.
 *
 *  1. A sale closes the customer's open lead as Won and stops its follow-ups.
 *  2. A sale earns a loyalty member points on the shared ledger.
 *  3. A quote on a lead moves it to the quotation stage — forward only.
 *  4. Pending Orders counts orders imported from the factory system.
 *  5. A branch invoice (BJWSL) is a transfer, not a sale.
 */

const PASSWORD = 'password123';
const O = { org: 'org_asl', slug: 'asl', store: 'store_asl' };
const PHONE = '9812507001';

async function teardown(prisma: import('../src/prisma/prisma.service').PrismaService) {
  const org = O.org;
  await prisma.jobTask.deleteMany({ where: { organisationId: org } });
  await prisma.loyaltyWebhookDelivery.deleteMany({ where: { organisationId: org } });
  await prisma.loyaltyLedgerEntry.deleteMany({ where: { organisationId: org } });
  await prisma.loyaltyAccount.deleteMany({ where: { organisationId: org } });
  await prisma.integration.deleteMany({ where: { organisationId: org } });
  await prisma.auditLog.deleteMany({ where: { organisationId: org } });
  await prisma.notification.deleteMany({ where: { user: { organisationId: org } } });
  await prisma.activityEvent.deleteMany({ where: { organisationId: org } });
  await prisma.productInteraction.deleteMany({ where: { organisationId: org } });
  await prisma.attributionTouch.deleteMany({ where: { organisationId: org } });
  await prisma.payment.deleteMany({ where: { organisationId: org } });
  await prisma.sale.deleteMany({ where: { organisationId: org } });
  await prisma.quote.deleteMany({ where: { organisationId: org } });
  await prisma.leadFollowUp.deleteMany({ where: { lead: { organisationId: org } } });
  await prisma.leadNote.deleteMany({ where: { organisationId: org } });
  await prisma.lead.deleteMany({ where: { organisationId: org } });
  await prisma.manufacturingOrder.deleteMany({ where: { organisationId: org } });
  await prisma.contactPoint.deleteMany({ where: { organisationId: org } });
  await prisma.party.deleteMany({ where: { organisationId: org } });
  await prisma.userStore.deleteMany({ where: { user: { organisationId: org } } });
  await prisma.user.deleteMany({ where: { organisationId: org } });
  await prisma.store.deleteMany({ where: { organisationId: org } });
  await prisma.organisation.deleteMany({ where: { id: org } });
}

describe('After the sale (e2e)', () => {
  let app: INestApplication;
  let prisma: import('../src/prisma/prisma.service').PrismaService;
  let token = '';
  const id: Record<string, string> = {};
  const auth = () => ({ Authorization: `Bearer ${token}`, 'X-Store-Id': O.store });

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

    await prisma.organisation.create({
      data: { id: O.org, name: 'ASL', slug: O.slug, industryPackCode: 'jewellery', country: 'IN' },
    });
    await prisma.store.create({
      data: { id: O.store, name: 'ASL Main', city: 'Mumbai', organisationId: O.org, timezone: 'Asia/Kolkata' },
    });
    await prisma.user.create({
      data: {
        id: 'u_asl_mgr', email: 'u_asl_mgr@asl.local', name: 'ASL Manager', role: 'store_manager',
        passwordHash: await bcrypt.hash(PASSWORD, 10), isActive: true, approvalStatus: 'approved',
        organisationId: O.org, userStores: { create: { storeId: O.store, isPrimary: true } },
      },
    });

    // A customer with two open leads: one to be won by a sale, one to be quoted.
    const party = await prisma.party.create({
      data: {
        organisationId: O.org, storeId: O.store, name: 'Asha Buyer', phone: PHONE, types: ['customer'],
        contactPoints: {
          create: { organisationId: O.org, kind: 'phone', value: PHONE, valueNormalized: `91${PHONE}`, isPrimary: true },
        },
      },
    });
    id.party = party.id;
    const bought = await prisma.lead.create({
      data: {
        organisationId: O.org, storeId: O.store, ref: 'ASL-L1', customerName: 'Asha Buyer', phone: PHONE,
        partyId: party.id, source: 'walk_in', stage: 'inquiry',
        followUps: { create: { storeId: O.store, seq: 1, dueDate: new Date('2026-12-01') } },
      },
      include: { followUps: true },
    });
    id.leadBought = bought.id;
    id.followUp = bought.followUps[0].id;
    id.leadQuoted = (
      await prisma.lead.create({
        data: {
          organisationId: O.org, storeId: O.store, ref: 'ASL-L2', customerName: 'Ravi Quote', phone: '9812507002',
          source: 'walk_in', stage: 'inquiry',
        },
      })
    ).id;

    // A loyalty programme earning 1 point per ₹100, and the customer enrolled.
    await prisma.integration.create({
      data: {
        organisationId: O.org, providerCode: 'loyalty_website', name: 'Website', status: 'connected',
        config: { earnPoints: 1, earnPerAmount: 100 },
      },
    });
    await prisma.loyaltyAccount.create({
      data: { organisationId: O.org, phone: normalizeIndianMobile(PHONE)!, name: 'Asha Buyer', partyId: party.id },
    });

    // One order imported from the factory system, still being made.
    await prisma.manufacturingOrder.create({
      data: { organisationId: O.org, storeId: O.store, orderNo: 'ASL-MO-1', orderDate: new Date(), status: 'booked' },
    });

    token = (
      await request(app.getHttpServer())
        .post('/auth/login')
        .send({ email: 'u_asl_mgr@asl.local', password: PASSWORD })
        .expect(201)
    ).body.token;
  }, 60_000);

  afterAll(async () => {
    await teardown(prisma);
    await app.close();
  });

  it('a sale wins the lead, stops its follow-ups and earns points', async () => {
    await request(app.getHttpServer())
      .post('/sales')
      .set(auth())
      .send({ storeId: O.store, customerName: 'Asha Buyer', phone: PHONE, invoiceNo: 'ASL-INV-1', salesValue: 25_000 })
      .expect(201);

    const lead = await prisma.lead.findUniqueOrThrow({ where: { id: id.leadBought } });
    expect(lead).toMatchObject({ outcome: 'won', stage: 'order_placed' });
    expect(lead.closedAt).not.toBeNull();

    const followUp = await prisma.leadFollowUp.findUniqueOrThrow({ where: { id: id.followUp } });
    expect(followUp.done).toBe(true);
    expect(followUp.note).toContain('ASL-INV-1');

    const account = await prisma.loyaltyAccount.findFirstOrThrow({ where: { organisationId: O.org } });
    expect(account.pointsBalance).toBe(250); // floor(25,000 / 100) × 1
  });

  it('a quote moves its lead to the quotation stage, and only forward', async () => {
    await request(app.getHttpServer())
      .post('/quotes')
      .set(auth())
      .send({
        storeId: O.store, customerName: 'Ravi Quote', phone: '9812507002', leadId: id.leadQuoted,
        lines: [{ description: 'Ring', karat: 18, weightGrams: 4, goldRatePerGram: 7000 }],
      })
      .expect(201);
    expect((await prisma.lead.findUniqueOrThrow({ where: { id: id.leadQuoted } })).stage).toBe('quotation');

    // A won lead is not pulled back to quotation by a later quote.
    await request(app.getHttpServer())
      .post('/quotes')
      .set(auth())
      .send({
        storeId: O.store, customerName: 'Asha Buyer', phone: PHONE, leadId: id.leadBought,
        lines: [{ description: 'Chain', karat: 22, weightGrams: 10, goldRatePerGram: 7000 }],
      })
      .expect(201);
    expect((await prisma.lead.findUniqueOrThrow({ where: { id: id.leadBought } })).stage).toBe('order_placed');
  });

  it('Pending Orders counts an order imported from the factory', async () => {
    const res = await request(app.getHttpServer()).get('/dashboard/kpis').set(auth()).expect(200);
    const pending = (res.body as { id: string; value: number }[]).find((k) => k.id === 'pending');
    expect(pending?.value).toBe(1);
  });

  it('only a customer invoice counts as a sale', () => {
    expect(docTypeFromTranType('JWSL')).toBe('sale');
    expect(docTypeFromTranType('BJWSL')).toBe('branch_transfer');
    expect(docTypeFromTranType('JWSR')).toBe('sale_return');
    expect(docTypeFromTranType('JWAP')).toBe('proforma');
    // A type nobody has mapped must never become revenue.
    expect(docTypeFromTranType('ZZNEW')).not.toBe('sale');
  });
});
