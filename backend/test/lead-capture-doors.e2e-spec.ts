import { INestApplication, ValidationPipe } from '@nestjs/common';
import { Test } from '@nestjs/testing';
import request = require('supertest');
import * as bcrypt from 'bcryptjs';
import { randomUUID } from 'crypto';

import { AppModule } from '../src/app.module';
import { PrismaService } from '../src/prisma/prisma.service';
import { ConversationsService } from '../src/crm/conversations.service';

/**
 * The three lead doors added to close the capture matrix: a website form, an
 * explicit conversation conversion, and opening leads from an import.
 *
 * All three go through LeadIntakeService, so what is really being pinned is that
 * one pipeline — identity, branch, follow-ups, activity, audit, fair queue —
 * applies whichever door was used. A customer must not be treated differently
 * because of how they happened to arrive.
 */
const PASSWORD = 'password123';

const A = {
  org: 'org_doors_a', slug: 'doors-a', store: 'store_doors_a',
  ho: 'ho.doors@doors-a.local', rep: 'rep.doors@doors-a.local',
};
const B = { org: 'org_doors_b', slug: 'doors-b', store: 'store_doors_b' };

describe('Lead capture doors: website form, conversion, import (e2e)', () => {
  let app: INestApplication;
  let prisma: PrismaService;
  let conversations: ConversationsService;
  let token: string;
  let repId: string;
  let publicKey: string;
  let formId: string;

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
    conversations = app.get(ConversationsService);

    await teardown(prisma);
    const hash = await bcrypt.hash(PASSWORD, 10);

    await prisma.organisation.create({ data: { id: A.org, name: 'Doors A', slug: A.slug } });
    await prisma.store.create({
      data: { id: A.store, name: 'Main', city: 'Pune', organisationId: A.org },
    });
    await prisma.user.create({
      data: {
        email: A.ho, name: 'HO', role: 'head_office', passwordHash: hash, isActive: true,
        approvalStatus: 'approved', organisationId: A.org,
        userStores: { create: { storeId: A.store, isPrimary: true } },
      },
    });
    const rep = await prisma.user.create({
      data: {
        email: A.rep, name: 'Rep', role: 'salesperson', passwordHash: hash, isActive: true,
        approvalStatus: 'approved', organisationId: A.org,
        userStores: { create: { storeId: A.store, isPrimary: true } },
      },
    });
    repId = rep.id;

    await prisma.organisation.create({ data: { id: B.org, name: 'Doors B', slug: B.slug } });
    await prisma.store.create({
      data: { id: B.store, name: 'Other', city: 'Mumbai', organisationId: B.org },
    });

    const login = await request(server()).post('/auth/login').send({ email: A.ho, password: PASSWORD });
    token = login.body.token;

    await request(server())
      .put('/crm/round-robin/policy')
      .set(auth())
      .send({ enabled: true, stores: [{ storeId: A.store, eligibleUserIds: [repId] }] })
      .expect(200);
  });

  afterAll(async () => {
    await teardown(prisma);
    await app?.close();
  });

  /* ------------------------------------------------------------ website form */

  describe('website lead form', () => {
    it('publishes a form and returns a key that is not the form id', async () => {
      const res = await request(server())
        .post('/crm/lead-forms')
        .set(auth())
        .send({ name: 'Homepage enquiry', storeId: A.store, defaultInterest: 'General enquiry', campaign: 'spring' })
        .expect(201);

      publicKey = res.body.publicKey;
      formId = res.body.id;
      expect(publicKey).toBeTruthy();
      expect(publicKey).not.toBe(formId);
      // Long enough not to be guessed by trying.
      expect(publicKey.length).toBeGreaterThanOrEqual(24);
      expect(res.body.submitPath).toBe(`/enquiry/${publicKey}`);
    });

    it('will not publish a form against another tenant’s branch', async () => {
      const res = await request(server())
        .post('/crm/lead-forms')
        .set(auth())
        .send({ name: 'Cross tenant', storeId: B.store });
      expect([400, 403]).toContain(res.status);
    });

    it('tells an anonymous visitor only what the page needs to render', async () => {
      const res = await request(server()).get(`/public/lead-forms/${publicKey}`).expect(200);
      expect(res.body.name).toBe('Homepage enquiry');
      expect(res.body.defaultInterest).toBe('General enquiry');
      expect(res.body.interestOptional).toBe(true);
      // No tenant, branch or internal id leaks to the public page.
      expect(JSON.stringify(res.body)).not.toContain(A.org);
      expect(JSON.stringify(res.body)).not.toContain(A.store);
      expect(JSON.stringify(res.body)).not.toContain(formId);
    });

    it('captures a lead, with a branch, follow-ups and an owner', async () => {
      const res = await request(server())
        .post(`/public/lead-forms/${publicKey}`)
        .send({
          submissionId: randomUUID(), customerName: 'Anita Rao',
          phone: '+919812300301', interest: 'Wants a quotation', consent: true,
        })
        .expect(201);

      expect(res.body.accepted).toBe(true);
      expect(res.body.duplicate).toBe(false);
      expect(res.body.reference).toMatch(/^LD-/);

      const lead = await prisma.lead.findFirst({
        where: { organisationId: A.org, ref: res.body.reference },
        select: { id: true, storeId: true, source: true, ownerId: true, partyId: true, interest: true },
      });
      expect(lead!.storeId).toBe(A.store);
      expect(lead!.source).toBe('website');
      expect(lead!.interest).toBe('Wants a quotation');
      // The same pipeline as every other door: a customer, and an owner.
      expect(lead!.partyId).toBeTruthy();
      expect(lead!.ownerId).toBe(repId);

      const followUps = await prisma.leadFollowUp.count({ where: { leadId: lead!.id } });
      expect(followUps).toBe(2);
    });

    it('falls back to the form’s default when the visitor leaves the box empty', async () => {
      const res = await request(server())
        .post(`/public/lead-forms/${publicKey}`)
        .send({ submissionId: randomUUID(), customerName: 'Blank Box', phone: '+919812300302', consent: true })
        .expect(201);
      const lead = await prisma.lead.findFirst({
        where: { organisationId: A.org, ref: res.body.reference },
        select: { interest: true },
      });
      expect(lead!.interest).toBe('General enquiry');
    });

    it('returns the first lead when a submission is replayed', async () => {
      const submissionId = randomUUID();
      const body = { submissionId, customerName: 'Double Tap', phone: '+919812300303', consent: true };
      const first = await request(server()).post(`/public/lead-forms/${publicKey}`).send(body).expect(201);
      const second = await request(server()).post(`/public/lead-forms/${publicKey}`).send(body).expect(201);

      expect(second.body.duplicate).toBe(true);
      expect(second.body.reference).toBe(first.body.reference);
      const count = await prisma.lead.count({ where: { organisationId: A.org, ref: first.body.reference } });
      expect(count).toBe(1);
    });

    it('refuses a filled honeypot, a missing consent tick and no contact detail', async () => {
      const base = { customerName: 'Bot', phone: '+919812300304' };
      const honeypot = await request(server()).post(`/public/lead-forms/${publicKey}`)
        .send({ ...base, submissionId: randomUUID(), consent: true, website: 'http://spam.example' });
      expect(honeypot.status).toBe(400);

      const noConsent = await request(server()).post(`/public/lead-forms/${publicKey}`)
        .send({ ...base, submissionId: randomUUID(), consent: false });
      expect(noConsent.status).toBe(400);

      const noContact = await request(server()).post(`/public/lead-forms/${publicKey}`)
        .send({ submissionId: randomUUID(), customerName: 'No Contact', consent: true });
      expect(noContact.status).toBe(400);
    });

    it('stops accepting the moment the form is turned off, and says nothing more', async () => {
      await request(server())
        .patch(`/crm/lead-forms/${formId}`)
        .set(auth())
        .send({ enabled: false })
        .expect(200);

      const disabled = await request(server()).post(`/public/lead-forms/${publicKey}`)
        .send({ submissionId: randomUUID(), customerName: 'Too Late', phone: '+919812300305', consent: true });
      const neverExisted = await request(server()).post('/public/lead-forms/not-a-real-key')
        .send({ submissionId: randomUUID(), customerName: 'Nobody', phone: '+919812300306', consent: true });

      // Identical refusals: probing keys cannot distinguish a real tenant.
      expect(disabled.status).toBe(404);
      expect(neverExisted.status).toBe(404);
      expect(disabled.body.message).toBe(neverExisted.body.message);

      await request(server()).patch(`/crm/lead-forms/${formId}`).set(auth()).send({ enabled: true }).expect(200);
    });
  });

  /* ------------------------------------------------- conversation conversion */

  describe('converting an organic conversation', () => {
    let conversationId: string;

    it('creates no lead on its own', async () => {
      const result = await conversations.ingestInbound({
        organisationId: A.org, channel: 'whatsapp',
        externalThreadId: '919000000701', externalId: 'wamid.doors.1',
        senderKind: 'whatsapp', senderValue: '919000000701',
        body: 'Do you have this in stock?',
      });
      conversationId = result.conversationId;
      // Organic traffic opens nothing: `leadId` is an explicit null, not an
      // absent field, so the caller can tell "no lead" from "not applicable".
      expect(result.leadId).toBeNull();
    });

    it('refuses to convert while no branch is known', async () => {
      const res = await request(server())
        .post(`/crm/conversations/${conversationId}/convert-to-lead`)
        .set(auth())
        .send({ interest: 'Asked about stock' });
      expect(res.status).toBe(400);
      expect(res.body.message).toMatch(/branch/i);
    });

    it('converts when a person supplies the branch, through the same pipeline', async () => {
      const res = await request(server())
        .post(`/crm/conversations/${conversationId}/convert-to-lead`)
        .set(auth())
        .send({ storeId: A.store, interest: 'Asked about stock', customerName: 'Stock Asker' })
        .expect(201);

      expect(res.body.duplicate).toBe(false);
      const lead = await prisma.lead.findUnique({
        where: { id: res.body.leadId },
        select: { storeId: true, source: true, ownerId: true, partyId: true, customerName: true },
      });
      expect(lead!.storeId).toBe(A.store);
      expect(lead!.source).toBe('whatsapp');
      expect(lead!.customerName).toBe('Stock Asker');
      // Converting IS the moment the thread gets a customer identity.
      expect(lead!.partyId).toBeTruthy();
      expect(lead!.ownerId).toBe(repId);
      expect(await prisma.leadFollowUp.count({ where: { leadId: res.body.leadId } })).toBe(2);
    });

    it('is idempotent: pressing convert again returns the same lead', async () => {
      const again = await request(server())
        .post(`/crm/conversations/${conversationId}/convert-to-lead`)
        .set(auth())
        .send({ storeId: A.store, interest: 'Asked about stock' })
        .expect(201);
      expect(again.body.duplicate).toBe(true);

      const count = await prisma.lead.count({
        where: { organisationId: A.org, originKey: `convo_convert:${conversationId}` },
      });
      expect(count).toBe(1);
    });

    it('records who made the decision', async () => {
      const trail = await prisma.auditLog.findMany({
        where: { organisationId: A.org, entityType: 'Conversation', entityId: conversationId },
        select: { action: true, actorId: true },
      });
      const convert = trail.find((t) => t.action === 'crm.conversation_converted');
      expect(convert).toBeTruthy();
      // A person chose this, so a person is named — not the system actor.
      expect(convert!.actorId).toBeTruthy();
    });
  });

  /* -------------------------------------------------------- import to leads */

  describe('opening leads from an import', () => {
    let batchId: string;

    beforeAll(async () => {
      const batch = await prisma.importBatch.create({
        data: {
          organisationId: A.org, entity: 'customers', sourceSystem: 'csv',
          status: 'completed', targetStoreId: A.store, imported: 2,
        },
        select: { id: true },
      });
      batchId = batch.id;
      await prisma.party.createMany({
        data: [
          { organisationId: A.org, name: 'Imported One', phone: '+919812300401', storeId: A.store, types: ['customer'], importBatchId: batchId },
          { organisationId: A.org, name: 'Imported Two', phone: '+919812300402', storeId: A.store, types: ['customer'], importBatchId: batchId },
          // Not from this batch: must be left alone.
          { organisationId: A.org, name: 'Pre-existing', phone: '+919812300403', storeId: A.store, types: ['customer'] },
        ],
      });
    });

    it('opens a lead per imported customer, and no others', async () => {
      const res = await request(server())
        .post(`/crm/import-batches/${batchId}/leads`)
        .set(auth())
        .send({ interest: 'Re-engagement campaign' })
        .expect(201);

      expect(res.body.opened).toBe(2);
      expect(res.body.considered).toBe(2);
      expect(res.body.failed).toBe(0);

      const leads = await prisma.lead.findMany({
        where: { organisationId: A.org, source: 'imported' },
        select: { customerName: true, ownerId: true, storeId: true },
      });
      expect(leads).toHaveLength(2);
      expect(leads.map((l) => l.customerName).sort()).toEqual(['Imported One', 'Imported Two']);
      // The customer who was already on file is not swept in.
      expect(leads.every((l) => l.storeId === A.store)).toBe(true);
      expect(leads.every((l) => l.ownerId === repId)).toBe(true);
    });

    it('does not invent a marketing source', async () => {
      const lead = await prisma.lead.findFirst({
        where: { organisationId: A.org, source: 'imported' },
        select: { source: true },
      });
      // Not website, not walk_in: the file said nothing about how they found us.
      expect(lead!.source).toBe('imported');
    });

    it('is idempotent: running it again opens nothing new', async () => {
      const again = await request(server())
        .post(`/crm/import-batches/${batchId}/leads`)
        .set(auth())
        .send({ interest: 'Re-engagement campaign' })
        .expect(201);
      expect(again.body.opened).toBe(0);
      expect(again.body.alreadyOpen).toBe(2);

      const total = await prisma.lead.count({ where: { organisationId: A.org, source: 'imported' } });
      expect(total).toBe(2);
    });

    it('cannot reach another tenant’s batch', async () => {
      const other = await prisma.importBatch.create({
        data: { organisationId: B.org, entity: 'customers', sourceSystem: 'csv', status: 'completed' },
        select: { id: true },
      });
      const res = await request(server())
        .post(`/crm/import-batches/${other.id}/leads`)
        .set(auth())
        .send({ interest: 'Should not work' });
      expect(res.status).toBe(404);
    });
  });
});

async function teardown(prisma: PrismaService) {
  for (const org of [A.org, B.org]) {
    await prisma.attributionTouch.deleteMany({ where: { organisationId: org } });
    await prisma.message.deleteMany({ where: { organisationId: org } });
    await prisma.conversation.deleteMany({ where: { organisationId: org } });
    await prisma.activityEvent.deleteMany({ where: { organisationId: org } }).catch(() => undefined);
    await prisma.leadFollowUp.deleteMany({ where: { lead: { organisationId: org } } }).catch(() => undefined);
    await prisma.lead.deleteMany({ where: { organisationId: org } });
    await prisma.leadForm.deleteMany({ where: { organisationId: org } }).catch(() => undefined);
    await prisma.contactPoint.deleteMany({ where: { organisationId: org } });
    await prisma.party.deleteMany({ where: { organisationId: org } });
    await prisma.importBatch.deleteMany({ where: { organisationId: org } }).catch(() => undefined);
    await prisma.auditLog.deleteMany({ where: { organisationId: org } });
    await prisma.userStore.deleteMany({ where: { store: { organisationId: org } } });
    await prisma.user.deleteMany({ where: { organisationId: org } });
    await prisma.store.deleteMany({ where: { organisationId: org } });
    await prisma.organisation.deleteMany({ where: { id: org } });
  }
}
