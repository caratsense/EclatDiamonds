import { INestApplication, ValidationPipe } from '@nestjs/common';
import { Test } from '@nestjs/testing';
import * as bcrypt from 'bcryptjs';
import request = require('supertest');

import { AppModule } from '../src/app.module';
import { mergeRiskCarry } from '../src/crm/advanced-crm.service';
import { PrismaService } from '../src/prisma/prisma.service';

/**
 * INT-09, INT-10 and INT-11 - three CRM defects that all report something
 * untrue to the person relying on it.
 *
 *   INT-09  A merge dropped `isBlacklisted` and `creditLimit`, so deleting a
 *           blocked duplicate produced a clean survivor. That is a laundering
 *           route, not a data-tidying quirk.
 *   INT-10  The SLA summary counted a 1,000-row page instead of the tenant's
 *           leads, and the page ordering meant the rows it dropped were the
 *           never-touched ones the board exists to surface.
 *   INT-11  Automatic assignment changed ownership with no audit row at all;
 *           only the manual route left evidence.
 */

const PASSWORD = 'password123';
const A = {
  org: 'org_crm_ms_a',
  slug: 'crm-ms-a',
  north: 'store_crm_ms_north',
  south: 'store_crm_ms_south',
  ho: 'ho@crm-ms-a.local',
  manager: 'manager@crm-ms-a.local',
  rep1: 'rep1@crm-ms-a.local',
  rep2: 'rep2@crm-ms-a.local',
};
const X = { org: 'org_crm_ms_x', slug: 'crm-ms-x', store: 'store_crm_ms_x', ho: 'ho@crm-ms-x.local' };

const HOUR = 3_600_000;

describe('CRM merge safety, SLA totals and automation audit (e2e)', () => {
  let app: INestApplication;
  let prisma: PrismaService;
  let hoToken: string;
  let managerToken: string;
  let repToken: string;
  let xToken: string;
  let managerId: string;
  let rep1Id: string;
  let rep2Id: string;

  const http = () => request(app.getHttpServer());
  const auth = (token: string) => ({ Authorization: `Bearer ${token}` });

  beforeAll(async () => {
    process.env.CRM_QR_SECRET = 'crm-merge-sla-test-secret-at-least-32-characters';
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

    const passwordHash = await bcrypt.hash(PASSWORD, 10);
    await prisma.organisation.create({
      data: { id: A.org, name: 'Merge SLA A', slug: A.slug, industryPackCode: 'healthcare' },
    });
    await prisma.store.createMany({
      data: [
        { id: A.north, name: 'North', city: 'Delhi', timezone: 'Asia/Kolkata', organisationId: A.org },
        { id: A.south, name: 'South', city: 'Chennai', timezone: 'Asia/Kolkata', organisationId: A.org },
      ],
    });
    const makeUser = (email: string, name: string, role: string, storeId: string) =>
      prisma.user.create({
        data: {
          email, name, role: role as never, passwordHash, isActive: true, approvalStatus: 'approved',
          organisationId: A.org, userStores: { create: { storeId, isPrimary: true } },
        },
      });
    await makeUser(A.ho, 'Head Office', 'head_office', A.north);
    managerId = (await makeUser(A.manager, 'North Manager', 'store_manager', A.north)).id;
    rep1Id = (await makeUser(A.rep1, 'Rep One', 'salesperson', A.north)).id;
    rep2Id = (await makeUser(A.rep2, 'Rep Two', 'salesperson', A.north)).id;

    await prisma.organisation.create({
      data: { id: X.org, name: 'Merge SLA X', slug: X.slug, industryPackCode: 'healthcare' },
    });
    await prisma.store.create({ data: { id: X.store, name: 'X Store', city: 'X', organisationId: X.org } });
    await prisma.user.create({
      data: {
        email: X.ho, name: 'X Head', role: 'head_office', passwordHash, isActive: true,
        approvalStatus: 'approved', organisationId: X.org,
        userStores: { create: { storeId: X.store, isPrimary: true } },
      },
    });

    const login = async (email: string) => {
      const res = await http().post('/auth/login').send({ email, password: PASSWORD });
      expect(res.status).toBe(201);
      return res.body.token as string;
    };
    hoToken = await login(A.ho);
    managerToken = await login(A.manager);
    repToken = await login(A.rep1);
    xToken = await login(X.ho);
  }, 180_000);

  afterAll(async () => {
    if (prisma) await teardown(prisma);
    if (app) await app.close();
  });

  // ---------------------------------------------------------------------
  // INT-09 - a merge must not launder a blacklist or invent a credit limit
  // ---------------------------------------------------------------------

  describe('INT-09 merge carries blacklist and credit limit', () => {
    let seq = 0;
    async function candidateFor(
      primary: { isBlacklisted?: boolean; creditLimit?: string | null },
      duplicate: { isBlacklisted?: boolean; creditLimit?: string | null },
    ) {
      seq += 1;
      const p = await prisma.party.create({
        data: {
          organisationId: A.org, storeId: A.north, name: `Primary ${seq}`, types: ['customer'],
          isBlacklisted: primary.isBlacklisted ?? false, creditLimit: primary.creditLimit ?? null,
        },
      });
      const d = await prisma.party.create({
        data: {
          organisationId: A.org, storeId: A.north, name: `Duplicate ${seq}`, types: ['customer'],
          isBlacklisted: duplicate.isBlacklisted ?? false, creditLimit: duplicate.creditLimit ?? null,
        },
      });
      const c = await prisma.mergeCandidate.create({
        data: {
          organisationId: A.org, primaryPartyId: p.id, duplicatePartyId: d.id,
          matchKind: 'phone', matchValue: `9800000${1000 + seq}`, confidence: 1,
        },
      });
      return { primaryId: p.id, duplicateId: d.id, candidateId: c.id };
    }

    async function execute(candidateId: string) {
      const plan = await http().get(`/crm/identity/merge-candidates/${candidateId}/plan`).set(auth(hoToken));
      expect(plan.status).toBe(200);
      const merge = await http()
        .post(`/crm/identity/merge-candidates/${candidateId}/merge`)
        .set(auth(hoToken))
        .send({ planHash: plan.body.planHash });
      return { plan: plan.body, merge };
    }

    it('keeps the survivor blacklisted when the DUPLICATE was the blocked record', async () => {
      // The laundering shape: the clean record is the one that survives, so a
      // merge that let "primary wins" decide would clear the block.
      const { primaryId, duplicateId, candidateId } = await candidateFor(
        { isBlacklisted: false },
        { isBlacklisted: true },
      );

      const { plan, merge } = await execute(candidateId);
      expect(plan.riskCarry).toMatchObject({ survivorBlacklisted: true, blacklistSource: 'duplicate' });
      expect(merge.status).toBe(201);

      const survivor = await prisma.party.findUnique({ where: { id: primaryId } });
      expect(survivor!.isBlacklisted).toBe(true);
      expect(await prisma.party.findUnique({ where: { id: duplicateId } })).toBeNull();
    });

    it('keeps the survivor blacklisted when the primary was blocked, and when both were', async () => {
      const one = await candidateFor({ isBlacklisted: true }, { isBlacklisted: false });
      expect((await execute(one.candidateId)).merge.status).toBe(201);
      expect((await prisma.party.findUnique({ where: { id: one.primaryId } }))!.isBlacklisted).toBe(true);

      const both = await candidateFor({ isBlacklisted: true }, { isBlacklisted: true });
      const bothResult = await execute(both.candidateId);
      expect(bothResult.plan.riskCarry.blacklistSource).toBe('both');
      expect(bothResult.merge.status).toBe(201);
      expect((await prisma.party.findUnique({ where: { id: both.primaryId } }))!.isBlacklisted).toBe(true);
    });

    it('leaves a clean survivor clean when neither record was blocked', async () => {
      const { primaryId, candidateId } = await candidateFor({}, {});
      const { plan, merge } = await execute(candidateId);

      expect(plan.riskCarry).toMatchObject({ survivorBlacklisted: false, blacklistSource: 'neither' });
      expect(merge.status).toBe(201);
      expect((await prisma.party.findUnique({ where: { id: primaryId } }))!.isBlacklisted).toBe(false);
    });

    it('preserves the one credit limit that exists, whichever record held it', async () => {
      const fromDuplicate = await candidateFor({ creditLimit: null }, { creditLimit: '50000.00' });
      const first = await execute(fromDuplicate.candidateId);
      expect(first.plan.riskCarry).toMatchObject({
        survivorCreditLimit: '50000.00',
        creditLimitSource: 'duplicate',
      });
      expect(first.merge.status).toBe(201);
      expect(
        (await prisma.party.findUnique({ where: { id: fromDuplicate.primaryId } }))!.creditLimit!.toFixed(2),
      ).toBe('50000.00');

      const fromPrimary = await candidateFor({ creditLimit: '25000.00' }, { creditLimit: null });
      expect((await execute(fromPrimary.candidateId)).merge.status).toBe(201);
      expect(
        (await prisma.party.findUnique({ where: { id: fromPrimary.primaryId } }))!.creditLimit!.toFixed(2),
      ).toBe('25000.00');
    });

    it('merges identical credit limits without changing the number', async () => {
      const { primaryId, candidateId } = await candidateFor(
        { creditLimit: '75000.00' },
        { creditLimit: '75000.00' },
      );
      const { plan, merge } = await execute(candidateId);

      expect(plan.riskCarry).toMatchObject({
        survivorCreditLimit: '75000.00',
        creditLimitSource: 'both_agree',
      });
      expect(merge.status).toBe(201);
      expect((await prisma.party.findUnique({ where: { id: primaryId } }))!.creditLimit!.toFixed(2)).toBe(
        '75000.00',
      );
    });

    it('refuses to merge two different credit limits, and never picks the higher one', async () => {
      const { primaryId, duplicateId, candidateId } = await candidateFor(
        { creditLimit: '10000.00' },
        { creditLimit: '900000.00' },
      );

      const plan = await http().get(`/crm/identity/merge-candidates/${candidateId}/plan`).set(auth(hoToken));
      expect(plan.body.executable).toBe(false);
      expect(plan.body.blockers.join(' ')).toMatch(/different credit limits/i);
      expect(plan.body.riskCarry).toMatchObject({
        creditLimitSource: 'conflict',
        // No number is offered, so nothing can pick one up by accident.
        survivorCreditLimit: null,
      });

      const merge = await http()
        .post(`/crm/identity/merge-candidates/${candidateId}/merge`)
        .set(auth(hoToken))
        .send({ planHash: plan.body.planHash });
      expect(merge.status).toBe(409);

      // Nothing moved and nothing was deleted: a blocked merge leaves both
      // records exactly as they were.
      expect((await prisma.party.findUnique({ where: { id: primaryId } }))!.creditLimit!.toFixed(2)).toBe(
        '10000.00',
      );
      expect((await prisma.party.findUnique({ where: { id: duplicateId } }))!.creditLimit!.toFixed(2)).toBe(
        '900000.00',
      );
    });

    it('records what happened to both protected fields in the audit trail', async () => {
      const { primaryId, candidateId } = await candidateFor(
        { isBlacklisted: false, creditLimit: null },
        { isBlacklisted: true, creditLimit: '40000.00' },
      );
      expect((await execute(candidateId)).merge.status).toBe(201);

      const row = await prisma.auditLog.findFirst({
        where: { organisationId: A.org, action: 'crm.customers_merged', entityId: primaryId },
      });
      expect(row).not.toBeNull();
      expect(row!.metadata).toMatchObject({
        riskCarry: {
          survivorBlacklisted: true,
          blacklistSource: 'duplicate',
          survivorCreditLimit: '40000.00',
          creditLimitSource: 'duplicate',
        },
      });
    });

    it('computes the carry the same way for the plan and the write', () => {
      // The plan a human approves and the row the merge writes come from this
      // one function, so they cannot drift apart.
      const dec = (v: string) => new (require('@prisma/client').Prisma.Decimal)(v);

      expect(mergeRiskCarry({ isBlacklisted: false, creditLimit: null }, null)).toMatchObject({
        survivorBlacklisted: false,
        blacklistSource: 'neither',
        survivorCreditLimit: null,
        creditLimitSource: 'neither',
      });
      expect(
        mergeRiskCarry(
          { isBlacklisted: false, creditLimit: dec('100.00') },
          { isBlacklisted: true, creditLimit: dec('100.000') },
        ),
      ).toMatchObject({
        // Decimal equality, not string equality: 100.00 and 100.000 agree.
        creditLimitSource: 'both_agree',
        survivorCreditLimit: '100.00',
        survivorBlacklisted: true,
      });
      expect(
        mergeRiskCarry(
          { isBlacklisted: false, creditLimit: dec('1.00') },
          { isBlacklisted: false, creditLimit: dec('2.00') },
        ),
      ).toMatchObject({ creditLimitSource: 'conflict', survivorCreditLimit: null });
    });
  });

  // ---------------------------------------------------------------------
  // INT-10 - the SLA summary covers the dataset, not one page of it
  // ---------------------------------------------------------------------

  describe('INT-10 lead ageing summary is counted in the database', () => {
    const UNTOUCHED = 600;
    const BREACHED = 300;
    const DUE_SOON = 51;
    const FRESH = 50;
    const TOTAL = UNTOUCHED + BREACHED + DUE_SOON + FRESH; // 1001 - one past the old cap

    beforeAll(async () => {
      // A 24-hour SLA: breached at >= 24h since last activity, due soon at >= 12h.
      const policy = await http()
        .put('/crm/leads/ageing/policy')
        .set(auth(hoToken))
        .send({ defaultHours: 24 });
      expect(policy.status).toBe(200);

      const now = Date.now();
      const rows: Array<Record<string, unknown>> = [];
      const push = (n: number, lastActivity: Date | null, prefix: string, storeId = A.north, ownerId: string | null = null) => {
        for (let i = 0; i < n; i++) {
          rows.push({
            organisationId: A.org,
            ref: `SLA-${prefix}-${i}`,
            storeId,
            ownerId,
            customerName: `SLA ${prefix} ${i}`,
            phone: '9812345678',
            source: 'phone',
            stage: 'inquiry',
            outcome: 'open',
            interest: 'General enquiry',
            lastActivity,
          });
        }
      };
      push(UNTOUCHED, null, 'untouched');
      push(BREACHED, new Date(now - 100 * HOUR), 'breached');
      push(DUE_SOON, new Date(now - 15 * HOUR), 'duesoon');
      push(FRESH, new Date(now - 1 * HOUR), 'fresh');
      // A different store of the same tenant, and a lead owned by one rep.
      push(7, new Date(now - 100 * HOUR), 'south', A.south);
      push(3, null, 'repowned', A.north, rep1Id);
      await prisma.lead.createMany({ data: rows as never });

      // The other tenant gets leads too, so isolation is proven against data
      // that exists rather than against an empty table.
      await prisma.lead.createMany({
        data: [1, 2, 3, 4].map((i) => ({
          organisationId: X.org, ref: `SLA-X-${i}`, storeId: X.store,
          customerName: `X ${i}`, phone: '9812345678', source: 'phone' as never,
          stage: 'inquiry' as never, outcome: 'open', interest: 'General enquiry',
          lastActivity: null,
        })) as never,
      });
    }, 120_000);

    it('counts every open lead, not the first 1,000 of them', async () => {
      const res = await http().get('/crm/leads/ageing').set(auth(hoToken));

      expect(res.status).toBe(200);
      // 1011 = the four buckets above plus the south store and the rep-owned
      // leads, all of which head office can see.
      expect(res.body.summary).toEqual({
        total: TOTAL + 7 + 3,
        untouched: UNTOUCHED + 3,
        breached: BREACHED + 7,
        due_soon: DUE_SOON,
        fresh: FRESH,
      });
      // The old implementation read at most 1,000 rows and counted those.
      expect(res.body.summary.total).toBeGreaterThan(1000);
      // The page itself stays bounded; only the summary is uncapped.
      expect(res.body.results.length).toBe(100);
      expect(res.body.returned).toBe(100);
    });

    it('adds up: the four buckets partition the counted set', async () => {
      const { body } = await http().get('/crm/leads/ageing').set(auth(hoToken));
      const { total, ...buckets } = body.summary;
      expect(Object.values(buckets).reduce((a: number, b) => a + (b as number), 0)).toBe(total);
    });

    it('filters the list by bucket in the database, and leaves the summary whole', async () => {
      const res = await http().get('/crm/leads/ageing?bucket=untouched&limit=5').set(auth(hoToken));

      expect(res.status).toBe(200);
      expect(res.body.results).toHaveLength(5);
      expect(res.body.results.every((r: { ageBucket: string }) => r.ageBucket === 'untouched')).toBe(true);
      // The summary describes the whole board even when the list is filtered.
      expect(res.body.summary.total).toBe(TOTAL + 7 + 3);
      expect(res.body.summary.untouched).toBe(UNTOUCHED + 3);
    });

    it('shows never-touched leads first instead of sorting them to the very end', async () => {
      const res = await http().get('/crm/leads/ageing?limit=10').set(auth(hoToken));
      expect(res.body.results.every((r: { ageBucket: string }) => r.ageBucket === 'untouched')).toBe(true);
    });

    it('scopes the totals to one store when asked', async () => {
      const res = await http().get(`/crm/leads/ageing?storeId=${A.south}`).set(auth(hoToken));

      expect(res.status).toBe(200);
      expect(res.body.summary).toEqual({ total: 7, untouched: 0, breached: 7, due_soon: 0, fresh: 0 });
    });

    it('never counts another tenant, however large this one is', async () => {
      const res = await http().get('/crm/leads/ageing').set(auth(xToken));

      expect(res.status).toBe(200);
      expect(res.body.summary).toEqual({ total: 4, untouched: 4, breached: 0, due_soon: 0, fresh: 0 });
    });

    it('narrows a salesperson to their own leads, in the summary as well as the list', async () => {
      const res = await http().get('/crm/leads/ageing').set(auth(repToken));

      expect(res.status).toBe(200);
      expect(res.body.summary).toEqual({ total: 3, untouched: 3, breached: 0, due_soon: 0, fresh: 0 });
    });

    it('treats outcome=all as every outcome rather than silently meaning open', async () => {
      await prisma.lead.create({
        data: {
          organisationId: A.org, ref: 'SLA-WON-1', storeId: A.north, customerName: 'Won One',
          phone: '9812345678', source: 'phone', stage: 'order_placed', outcome: 'won',
          interest: 'General enquiry', lastActivity: new Date(Date.now() - 100 * HOUR),
        },
      });

      const open = await http().get('/crm/leads/ageing').set(auth(hoToken));
      const all = await http().get('/crm/leads/ageing?outcome=all').set(auth(hoToken));
      const won = await http().get('/crm/leads/ageing?outcome=won').set(auth(hoToken));

      expect(all.body.summary.total).toBe(open.body.summary.total + 1);
      expect(won.body.summary.total).toBe(1);
    });
  });

  // ---------------------------------------------------------------------
  // INT-11 - automatic ownership changes leave a system-attributed trail
  // ---------------------------------------------------------------------

  describe('INT-11 automatic assignment and QR capture are audited', () => {
    const SUBMISSION = 'b31d0f2a-7b6a-4c1f-9a51-2f1f2a3c4d5e';
    const VISITOR_NAME = 'Ananya Iyer';
    const VISITOR_PHONE = '+919811119999';

    beforeAll(async () => {
      const policy = await http()
        .put('/crm/round-robin/policy')
        .set(auth(managerToken))
        .send({ enabled: true, stores: [{ storeId: A.north, eligibleUserIds: [rep1Id, rep2Id] }] });
      expect(policy.status).toBe(200);
    });

    it('audits an anonymous QR capture and its automatic assignment as system actions', async () => {
      const issued = await http()
        .post('/crm/lead-qr')
        .set(auth(managerToken))
        .send({ storeId: A.north, label: 'Front desk', defaultInterest: 'General enquiry' });
      expect(issued.status).toBe(201);

      const captured = await http()
        .post(`/crm/qr/capture/${issued.body.token}`)
        .send({ submissionId: SUBMISSION, customerName: VISITOR_NAME, phone: VISITOR_PHONE, consent: true });
      expect(captured.status).toBe(201);
      const leadId = captured.body.leadId as string;

      const capture = await prisma.auditLog.findFirst({
        where: { organisationId: A.org, action: 'crm.lead_captured_from_qr', entityId: leadId },
      });
      expect(capture).not.toBeNull();
      // Neither a person nor a Connect agent.
      expect(capture!.actorId).toBeNull();
      expect(capture!.machineActorId).toBeNull();
      expect(capture!.systemActorId).toBe('qr_lead_capture');
      expect(capture!.actorName).toBe('QR lead capture');
      expect(capture!.entityType).toBe('Lead');
      expect(capture!.storeId).toBe(A.north);
      expect(capture!.createdAt).toBeInstanceOf(Date);

      const assign = await prisma.auditLog.findFirst({
        where: { organisationId: A.org, action: 'crm.round_robin_assigned', entityId: leadId },
      });
      expect(assign).not.toBeNull();
      expect(assign!.actorId).toBeNull();
      expect(assign!.machineActorId).toBeNull();
      expect(assign!.systemActorId).toBe('round_robin');
      expect(assign!.actorName).toBe('Automatic assignment');
      expect(assign!.storeId).toBe(A.north);
      expect(assign!.metadata).toMatchObject({
        method: 'automatic_round_robin',
        previousOwnerId: null,
      });
      expect([rep1Id, rep2Id]).toContain((assign!.metadata as { assignedUserId: string }).assignedUserId);
      // The trail matches what actually happened to the record.
      const lead = await prisma.lead.findUnique({ where: { id: leadId } });
      expect(lead!.ownerId).toBe((assign!.metadata as { assignedUserId: string }).assignedUserId);
    });

    it('keeps the visitor and the QR secret out of the audit trail', async () => {
      const rows = await prisma.auditLog.findMany({
        where: { organisationId: A.org, action: { in: ['crm.lead_captured_from_qr', 'crm.round_robin_assigned'] } },
      });
      const dump = JSON.stringify(rows);

      expect(dump).not.toContain(VISITOR_NAME);
      expect(dump).not.toContain(VISITOR_PHONE);
      expect(dump).not.toContain('9811119999');
      expect(dump).not.toContain(process.env.CRM_QR_SECRET);
    });

    it('writes nothing extra when the same submission is replayed', async () => {
      const before = await prisma.auditLog.count({
        where: { organisationId: A.org, action: { in: ['crm.lead_captured_from_qr', 'crm.round_robin_assigned'] } },
      });
      const issued = await http()
        .post('/crm/lead-qr')
        .set(auth(managerToken))
        .send({ storeId: A.north, defaultInterest: 'General enquiry' });
      const submission = {
        submissionId: 'c0ffee00-1111-4222-8333-444444444444',
        customerName: 'Replay Visitor',
        phone: '+919811118888',
        consent: true,
      };

      const first = await http().post(`/crm/qr/capture/${issued.body.token}`).send(submission);
      expect(first.body.duplicate).toBe(false);
      const afterFirst = await prisma.auditLog.count({
        where: { organisationId: A.org, action: { in: ['crm.lead_captured_from_qr', 'crm.round_robin_assigned'] } },
      });
      expect(afterFirst).toBe(before + 2);

      const replay = await http().post(`/crm/qr/capture/${issued.body.token}`).send(submission);
      expect(replay.body).toMatchObject({ duplicate: true, leadId: first.body.leadId });
      const afterReplay = await prisma.auditLog.count({
        where: { organisationId: A.org, action: { in: ['crm.lead_captured_from_qr', 'crm.round_robin_assigned'] } },
      });
      expect(afterReplay).toBe(afterFirst);
    });

    it('still attributes a manual assignment to the person who asked for it', async () => {
      const lead = await prisma.lead.create({
        data: {
          organisationId: A.org, ref: 'RR-MANUAL-1', storeId: A.north, customerName: 'Manual One',
          phone: '9812345678', source: 'phone', stage: 'inquiry', outcome: 'open',
          interest: 'General enquiry', lastActivity: new Date(),
        },
      });

      const res = await http()
        .post('/crm/round-robin/assign')
        .set(auth(managerToken))
        .send({ entity: 'lead', entityId: lead.id });
      expect(res.status).toBe(201);

      const row = await prisma.auditLog.findFirst({
        where: { organisationId: A.org, action: 'crm.round_robin_assigned', entityId: lead.id },
      });
      expect(row!.actorId).toBe(managerId);
      expect(row!.actorName).toBe('North Manager');
      expect(row!.metadata).toMatchObject({ method: 'manual_round_robin' });
    });

    it('reports an automated row as a system actor through GET /audit', async () => {
      const res = await http()
        .get('/audit?action=crm.lead_captured_from_qr')
        .set(auth(hoToken));

      expect(res.status).toBe(200);
      const row = res.body.items[0];
      expect(row).toBeDefined();
      // Not 'user' with a null id, which would read as a corrupt human entry.
      expect(row.actorType).toBe('system');
      // Symmetric with connect_agent: the id column that identifies the actor.
      expect(row.actorId).toBe('qr_lead_capture');
      expect(row.actorName).toBe('QR lead capture');
    });
  });
});

async function teardown(prisma: PrismaService) {
  for (const organisationId of [A.org, X.org]) {
    await prisma.leadQualification.deleteMany({ where: { organisationId } }).catch(() => undefined);
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
