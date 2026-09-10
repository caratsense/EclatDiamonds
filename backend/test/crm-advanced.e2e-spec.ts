import { INestApplication, ValidationPipe } from '@nestjs/common';
import { Test } from '@nestjs/testing';
import * as bcrypt from 'bcryptjs';
import request = require('supertest');

import { AppModule } from '../src/app.module';
import { openQrPayload, sealQrPayload } from '../src/crm/advanced-crm.service';
import { PrismaService } from '../src/prisma/prisma.service';

const PASSWORD = 'password123';
const A = {
  org: 'org_crm_advanced_a', slug: 'crm-advanced-a',
  north: 'store_crm_advanced_north', south: 'store_crm_advanced_south',
  ho: 'ho@crm-advanced-a.local', manager: 'manager@crm-advanced-a.local',
  rep1: 'rep1@crm-advanced-a.local', rep2: 'rep2@crm-advanced-a.local',
};
const X = {
  org: 'org_crm_advanced_x', slug: 'crm-advanced-x', store: 'store_crm_advanced_x',
  ho: 'ho@crm-advanced-x.local',
};

describe('Advanced CRM: merge, segments, ageing, round-robin and QR (e2e)', () => {
  let app: INestApplication;
  let prisma: PrismaService;
  let hoToken: string;
  let managerToken: string;
  let repToken: string;
  let xToken: string;
  let hoId: string;
  let rep1Id: string;
  let rep2Id: string;

  const http = () => request(app.getHttpServer());
  const auth = (token: string) => ({ Authorization: `Bearer ${token}` });

  beforeAll(async () => {
    process.env.CRM_QR_SECRET = 'crm-advanced-test-secret-at-least-32-characters';
    const mod = await Test.createTestingModule({ imports: [AppModule] }).compile();
    app = mod.createNestApplication();
    app.useGlobalPipes(new ValidationPipe({
      whitelist: true,
      forbidNonWhitelisted: true,
      transform: true,
      transformOptions: { enableImplicitConversion: true },
    }));
    await app.init();
    prisma = app.get(PrismaService);
    await teardown(prisma);

    const passwordHash = await bcrypt.hash(PASSWORD, 10);
    await prisma.organisation.create({
      data: { id: A.org, name: 'Advanced CRM A', slug: A.slug, industryPackCode: 'healthcare' },
    });
    await prisma.store.createMany({ data: [
      { id: A.north, name: 'North', city: 'Delhi', timezone: 'Asia/Kolkata', organisationId: A.org },
      { id: A.south, name: 'South', city: 'New York', timezone: 'America/New_York', organisationId: A.org },
    ] });
    const makeUser = async (
      email: string,
      name: string,
      role: 'head_office' | 'store_manager' | 'salesperson',
      storeId: string,
    ) => prisma.user.create({ data: {
      email, name, role, passwordHash, isActive: true, approvalStatus: 'approved',
      organisationId: A.org, userStores: { create: { storeId, isPrimary: true } },
    } });
    hoId = (await makeUser(A.ho, 'Head Office', 'head_office', A.north)).id;
    await makeUser(A.manager, 'North Manager', 'store_manager', A.north);
    rep1Id = (await makeUser(A.rep1, 'Rep One', 'salesperson', A.north)).id;
    rep2Id = (await makeUser(A.rep2, 'Rep Two', 'salesperson', A.north)).id;

    await prisma.organisation.create({
      data: { id: X.org, name: 'Advanced CRM X', slug: X.slug, industryPackCode: 'healthcare' },
    });
    await prisma.store.create({
      data: { id: X.store, name: 'X Store', city: 'X', organisationId: X.org },
    });
    await prisma.user.create({ data: {
      email: X.ho, name: 'X Head', role: 'head_office', passwordHash, isActive: true,
      approvalStatus: 'approved', organisationId: X.org,
      userStores: { create: { storeId: X.store, isPrimary: true } },
    } });

    const login = async (email: string) => {
      const response = await http().post('/auth/login').send({ email, password: PASSWORD });
      expect(response.status).toBe(201);
      return response.body.token as string;
    };
    hoToken = await login(A.ho);
    managerToken = await login(A.manager);
    repToken = await login(A.rep1);
    xToken = await login(X.ho);
  });

  afterAll(async () => {
    await teardown(prisma);
    await app?.close();
    delete process.env.CRM_QR_SECRET;
  });

  describe('saved and dynamic lead segments', () => {
    it('saves a bounded query and evaluates it dynamically inside tenant/store scope', async () => {
      await lead('segment-a-1', A.north, rep1Id, { source: 'website', value: 2000, outcome: 'open' });
      await lead('segment-a-2', A.north, rep2Id, { source: 'walk_in', value: 100, outcome: 'won' });
      await lead('segment-x-1', X.store, null, { organisationId: X.org, source: 'website', value: 9000 });

      const saved = await http().post('/crm/segments').set(auth(hoToken)).send({
        name: 'Website enquiries', filters: { storeIds: [A.north], sources: ['website'], outcomes: ['open'] },
      });
      expect(saved.status).toBe(201);

      const first = await http().get(`/crm/segments/${saved.body.id}/results`).set(auth(hoToken));
      expect(first.status).toBe(200);
      expect(first.body.results.map((r: { ref: string }) => r.ref)).toContain('ADV-segment-a-1');
      expect(first.body.results.map((r: { ref: string }) => r.ref)).not.toContain('ADV-segment-x-1');

      await lead('segment-a-3', A.north, rep1Id, { source: 'website', value: 3500, outcome: 'open' });
      const second = await http().get(`/crm/segments/${saved.body.id}/results`).set(auth(hoToken));
      expect(second.body.total).toBe(first.body.total + 1);

      const otherTenant = await http().get('/crm/segments').set(auth(xToken));
      expect(otherTenant.status).toBe(200);
      expect(otherTenant.body).toEqual([]);
    });

    it('cannot widen a manager or salesperson through body-supplied stores/owners', async () => {
      const foreignStore = await http().post('/crm/segments').set(auth(managerToken)).send({
        name: 'South records', filters: { storeIds: [A.south] },
      });
      expect(foreignStore.status).toBe(403);

      const otherOwner = await http().post('/crm/segments/preview').set(auth(repToken)).send({
        filters: { ownerIds: [rep2Id] },
      });
      expect(otherOwner.status).toBe(400);
    });
  });

  describe('timezone-aware lead ageing', () => {
    it('uses tenant SLA policy, distinct untouched state, and each store timezone', async () => {
      const policy = await http().put('/crm/leads/ageing/policy').set(auth(hoToken)).send({
        defaultHours: 12, byStage: { inquiry: 8, quotation: 24 },
      });
      expect(policy.status).toBe(200);

      await lead('age-breached', A.north, rep1Id, {
        lastActivity: new Date(Date.now() - 10 * 3_600_000), stage: 'inquiry',
      });
      await lead('age-untouched', A.south, rep2Id, { lastActivity: null, stage: 'inquiry' });

      const report = await http().get('/crm/leads/ageing').query({ outcome: 'open' }).set(auth(hoToken));
      expect(report.status).toBe(200);
      const breached = report.body.results.find((r: { ref: string }) => r.ref === 'ADV-age-breached');
      const untouched = report.body.results.find((r: { ref: string }) => r.ref === 'ADV-age-untouched');
      expect(breached).toMatchObject({ ageBucket: 'breached', slaBreached: true, slaHours: 8, timezone: 'Asia/Kolkata' });
      expect(untouched).toMatchObject({ ageBucket: 'untouched', timezone: 'America/New_York' });
      expect(report.body.summary.breached).toBeGreaterThanOrEqual(1);
      expect(report.body.summary.untouched).toBeGreaterThanOrEqual(1);
    });

    it('rejects made-up stage keys instead of silently accepting dead policy', async () => {
      const response = await http().put('/crm/leads/ageing/policy').set(auth(hoToken)).send({
        defaultHours: 24, byStage: { imaginary: 2 },
      });
      expect(response.status).toBe(400);
    });
  });

  describe('fair round-robin assignment', () => {
    it('serializes concurrent assignments, rotates fairly, and is idempotent per record', async () => {
      const configured = await http().put('/crm/round-robin/policy').set(auth(hoToken)).send({
        enabled: true,
        stores: [{ storeId: A.north, eligibleUserIds: [rep2Id, rep1Id] }],
      });
      expect(configured.status).toBe(200);

      const first = await lead('rr-1', A.north, null);
      const second = await lead('rr-2', A.north, null);
      const assign = (id: string) => http().post('/crm/round-robin/assign').set(auth(managerToken)).send({ entity: 'lead', entityId: id });
      const [a, b] = await Promise.all([assign(first.id), assign(second.id)]);
      expect(a.status).toBe(201);
      expect(b.status).toBe(201);
      expect(new Set([a.body.assignedUserId, b.body.assignedUserId])).toEqual(new Set([rep1Id, rep2Id]));
      expect(new Set([a.body.sequence, b.body.sequence])).toEqual(new Set([1, 2]));

      const again = await assign(first.id);
      expect(again.status).toBe(201);
      expect(again.body.assignedUserId).toBe(a.body.assignedUserId);
      expect(again.body.idempotent).toBe(true);
    });

    it('denies cross-store and cross-tenant targets without advancing the cursor', async () => {
      const south = await lead('rr-south', A.south, null);
      const denied = await http().post('/crm/round-robin/assign').set(auth(managerToken)).send({ entity: 'lead', entityId: south.id });
      expect(denied.status).toBe(403);

      const foreign = await lead('rr-x', X.store, null, { organisationId: X.org });
      const hidden = await http().post('/crm/round-robin/assign').set(auth(hoToken)).send({ entity: 'lead', entityId: foreign.id });
      expect(hidden.status).toBe(404);
    });

    it('refuses configuration by a salesperson', async () => {
      const response = await http().put('/crm/round-robin/policy').set(auth(repToken)).send({ enabled: false, stores: [] });
      expect(response.status).toBe(403);
    });
  });

  describe('opaque and replay-safe QR capture', () => {
    it('hides tenant ids, creates one assigned lead, and returns that lead on replay', async () => {
      const issued = await http().post('/crm/lead-qr').set(auth(managerToken)).send({
        storeId: A.north, label: 'Front desk', defaultInterest: 'General enquiry', expiresInHours: 24,
      });
      expect(issued.status).toBe(201);
      expect(issued.body.token).not.toContain(A.org);
      expect(issued.body.token).not.toContain(A.north);

      const submission = {
        submissionId: 'a5398cf4-e552-4c9c-9f86-e549337a3664',
        customerName: 'QR Visitor', phone: '+919811112222', consent: true,
      };
      const first = await http().post(`/crm/qr/capture/${issued.body.token}`).send(submission);
      expect(first.status).toBe(201);
      expect(first.body).toMatchObject({ accepted: true, duplicate: false });
      expect([rep1Id, rep2Id]).toContain(first.body.assigned.userId);

      const replay = await http().post(`/crm/qr/capture/${issued.body.token}`).send(submission);
      expect(replay.status).toBe(201);
      expect(replay.body).toMatchObject({ accepted: true, duplicate: true, leadId: first.body.leadId });
      expect(await prisma.lead.count({ where: { id: first.body.leadId, organisationId: A.org } })).toBe(1);
    });

    it('rejects tampering, expiry, body-supplied tenant ids, and QR issuance below manager', async () => {
      const issued = await http().post('/crm/lead-qr').set(auth(hoToken)).send({ storeId: A.north, defaultInterest: 'Visit' });
      const token = issued.body.token as string;
      const at = Math.floor(token.length / 2);
      const tampered = `${token.slice(0, at)}${token[at] === 'A' ? 'B' : 'A'}${token.slice(at + 1)}`;
      const body = {
        submissionId: '6596645e-4be3-4bb7-8e0b-24605b8603dd', customerName: 'Tamper Test',
        phone: '+919811113333', interest: 'Appointment', consent: true,
      };
      expect((await http().post(`/crm/qr/capture/${tampered}`).send(body)).status).toBe(400);
      expect((await http().post(`/crm/qr/capture/${token}`).send({ ...body, organisationId: X.org })).status).toBe(400);
      expect((await http().post('/crm/lead-qr').set(auth(repToken)).send({ storeId: A.north })).status).toBe(403);

      const expired = sealQrPayload({
        v: 1, organisationId: A.org, storeId: A.north, exp: Date.now() - 1,
        nonce: 'expired-token-nonce', label: null, defaultInterest: 'Visit',
      }, process.env.CRM_QR_SECRET!);
      expect(openQrPayload(expired, process.env.CRM_QR_SECRET!)).not.toBeNull();
      expect((await http().post(`/crm/qr/capture/${expired}`).send(body)).status).toBe(400);
    });
  });

  describe('reviewed duplicate merge', () => {
    it('requires a fresh exact plan, moves history atomically, and keeps an audit record', async () => {
      const primary = await prisma.party.create({
        data: { organisationId: A.org, storeId: A.north, name: 'Primary Person', types: ['customer'], phone: '9811110001' },
      });
      const duplicate = await prisma.party.create({
        data: { organisationId: A.org, storeId: A.north, name: 'Duplicate Person', types: ['customer'], email: 'duplicate@example.test' },
      });
      await prisma.contactPoint.createMany({ data: [
        { organisationId: A.org, partyId: primary.id, kind: 'phone', value: '9811110001', valueNormalized: '919811110001', isPrimary: true },
        { organisationId: A.org, partyId: duplicate.id, kind: 'email', value: 'duplicate@example.test', valueNormalized: 'duplicate@example.test', isPrimary: true },
      ] });
      const movedLead = await lead('merge-lead', A.north, rep1Id, { partyId: duplicate.id });
      await prisma.conversation.create({ data: {
        organisationId: A.org, storeId: A.north, partyId: duplicate.id,
        channel: 'web', externalThreadId: 'adv-merge-thread',
      } });
      const candidate = await prisma.mergeCandidate.create({ data: {
        organisationId: A.org, primaryPartyId: primary.id, duplicatePartyId: duplicate.id,
        matchKind: 'phone', matchValue: '919811110001', confidence: 1,
      } });

      const firstPlan = await http().get(`/crm/identity/merge-candidates/${candidate.id}/plan`).set(auth(hoToken));
      expect(firstPlan.status).toBe(200);
      expect(firstPlan.body).toMatchObject({ executable: true, moves: { leads: 1, conversations: 1, contactPoints: 1 } });

      // Any intervening profile edit invalidates the approval hash.
      await prisma.party.update({ where: { id: duplicate.id }, data: { city: 'Changed after review' } });
      const stale = await http().post(`/crm/identity/merge-candidates/${candidate.id}/merge`)
        .set(auth(hoToken)).send({ planHash: firstPlan.body.planHash });
      expect(stale.status).toBe(409);

      const fresh = await http().get(`/crm/identity/merge-candidates/${candidate.id}/plan`).set(auth(hoToken));
      const merged = await http().post(`/crm/identity/merge-candidates/${candidate.id}/merge`)
        .set(auth(hoToken)).send({ planHash: fresh.body.planHash });
      expect(merged.status).toBe(201);
      expect(await prisma.party.findUnique({ where: { id: duplicate.id } })).toBeNull();
      expect((await prisma.lead.findUnique({ where: { id: movedLead.id } }))!.partyId).toBe(primary.id);
      expect(await prisma.contactPoint.count({ where: { partyId: primary.id } })).toBe(2);
      expect(await prisma.mergeCandidate.findUnique({ where: { id: candidate.id } })).toMatchObject({ status: 'merged', duplicatePartyId: null });
      expect(await prisma.auditLog.count({ where: { organisationId: A.org, action: 'crm.customers_merged', entityId: primary.id } })).toBe(1);
    });

    it('blocks divergent import identities, cross-tenant access, and non-head-office execution', async () => {
      const p = await prisma.party.create({ data: {
        organisationId: A.org, name: 'Imported One', types: ['customer'], legacyId: 'legacy-adv-1',
      } });
      const d = await prisma.party.create({ data: {
        organisationId: A.org, name: 'Imported Two', types: ['customer'], legacyId: 'legacy-adv-2',
      } });
      const c = await prisma.mergeCandidate.create({ data: {
        organisationId: A.org, primaryPartyId: p.id, duplicatePartyId: d.id,
        matchKind: 'email', matchValue: 'same@example.test', confidence: 1,
      } });
      const plan = await http().get(`/crm/identity/merge-candidates/${c.id}/plan`).set(auth(hoToken));
      expect(plan.body.executable).toBe(false);
      expect(plan.body.blockers.join(' ')).toMatch(/import identities/i);
      expect((await http().get(`/crm/identity/merge-candidates/${c.id}/plan`).set(auth(xToken))).status).toBe(404);
      expect((await http().post(`/crm/identity/merge-candidates/${c.id}/merge`).set(auth(managerToken)).send({ planHash: plan.body.planHash })).status).toBe(403);
    });
  });

  async function lead(
    suffix: string,
    storeId: string,
    ownerId: string | null,
    extra: {
      organisationId?: string;
      source?: 'walk_in' | 'phone' | 'whatsapp' | 'website' | 'instagram' | 'referral';
      stage?: 'inquiry' | 'quotation' | 'order_placed';
      outcome?: string;
      value?: number;
      lastActivity?: Date | null;
      partyId?: string;
    } = {},
  ) {
    return prisma.lead.create({ data: {
      organisationId: extra.organisationId ?? A.org,
      ref: `ADV-${suffix}`,
      storeId,
      ownerId,
      customerName: `Customer ${suffix}`,
      phone: '9812345678',
      source: extra.source ?? 'phone',
      stage: extra.stage ?? 'inquiry',
      outcome: extra.outcome ?? 'open',
      value: extra.value,
      interest: 'General enquiry',
      lastActivity: extra.lastActivity === undefined ? new Date() : extra.lastActivity,
      partyId: extra.partyId,
    } });
  }
});

async function teardown(prisma: PrismaService) {
  for (const organisationId of [A.org, X.org]) {
    await prisma.aiDraftRecord.deleteMany({ where: { organisationId } }).catch(() => undefined);
    await prisma.leadQualification.deleteMany({ where: { organisationId } }).catch(() => undefined);
    await prisma.conversationRoutingConflict.deleteMany({ where: { organisationId } }).catch(() => undefined);
    await prisma.attributionTouch.deleteMany({ where: { organisationId } }).catch(() => undefined);
    await prisma.message.deleteMany({ where: { organisationId } }).catch(() => undefined);
    await prisma.conversation.deleteMany({ where: { organisationId } }).catch(() => undefined);
    await prisma.activityEvent.deleteMany({ where: { organisationId } }).catch(() => undefined);
    await prisma.leadFollowUp.deleteMany({ where: { lead: { organisationId } } }).catch(() => undefined);
    await prisma.leadNote.deleteMany({ where: { lead: { organisationId } } }).catch(() => undefined);
    await prisma.lead.deleteMany({ where: { organisationId } }).catch(() => undefined);
    await prisma.mergeCandidate.deleteMany({ where: { organisationId } }).catch(() => undefined);
    await prisma.contactPoint.deleteMany({ where: { organisationId } }).catch(() => undefined);
    await prisma.task.deleteMany({ where: { organisationId } }).catch(() => undefined);
    await prisma.party.deleteMany({ where: { organisationId } }).catch(() => undefined);
    await prisma.auditLog.deleteMany({ where: { organisationId } }).catch(() => undefined);
    await prisma.userStore.deleteMany({ where: { store: { organisationId } } }).catch(() => undefined);
    await prisma.user.deleteMany({ where: { organisationId } }).catch(() => undefined);
    await prisma.store.deleteMany({ where: { organisationId } }).catch(() => undefined);
    await prisma.organisation.deleteMany({ where: { id: organisationId } }).catch(() => undefined);
  }
}

