import { INestApplication, ValidationPipe } from '@nestjs/common';
import { Test } from '@nestjs/testing';
import request = require('supertest');
import * as bcrypt from 'bcryptjs';

/**
 * Strict salesperson access, proved against the API directly.
 *
 * Two salespeople at one branch. Everything below is asserted as the first of
 * them, against the second's records by id — because the list hiding a record
 * is worth nothing if the id still opens it.
 *
 *  1. OWN BOOK ONLY: leads, conversations, follow-ups, calling tasks, visits,
 *     quotes, bills, returns, customers — list, detail, mutation and search.
 *  2. NO MANAGEMENT SURFACE: KPIs, ledgers, approval queues, member lists,
 *     exports, SLA boards, DSR filing.
 *  3. REASSIGNMENT MOVES ACCESS AT ONCE, and only a manager can reassign.
 *  4. MANAGERS ARE UNAFFECTED.
 *  5. CROSS-TENANT ASSIGNMENT IS REFUSED.
 */

const PASSWORD = 'password123';
const A = { org: 'org_ssc_a', slug: 'ssc-a', s1: 'store_ssc_1', s2: 'store_ssc_2' };
const OTHER = { org: 'org_ssc_b', slug: 'ssc-b', store: 'store_ssc_b' };

async function teardown(prisma: import('../src/prisma/prisma.service').PrismaService) {
  for (const org of [A.org, OTHER.org]) {
    await prisma.auditLog.deleteMany({ where: { organisationId: org } });
    await prisma.notification.deleteMany({ where: { user: { organisationId: org } } });
    await prisma.handoff.deleteMany({ where: { organisationId: org } });
    await prisma.leadQualification.deleteMany({ where: { organisationId: org } });
    await prisma.activityEvent.deleteMany({ where: { organisationId: org } });
    await prisma.returnRecord.deleteMany({ where: { organisationId: org } });
    await prisma.sale.deleteMany({ where: { organisationId: org } });
    await prisma.task.deleteMany({ where: { organisationId: org } });
    await prisma.quote.deleteMany({ where: { organisationId: org } });
    await prisma.checkIn.deleteMany({ where: { organisationId: org } });
    await prisma.message.deleteMany({ where: { organisationId: org } });
    await prisma.conversation.deleteMany({ where: { organisationId: org } });
    await prisma.leadFollowUp.deleteMany({ where: { lead: { organisationId: org } } });
    await prisma.lead.deleteMany({ where: { organisationId: org } });
    await prisma.contactPoint.deleteMany({ where: { organisationId: org } });
    await prisma.party.deleteMany({ where: { organisationId: org } });
    await prisma.attendanceRecord.deleteMany({ where: { organisationId: org } });
    await prisma.userStore.deleteMany({ where: { user: { organisationId: org } } });
    await prisma.user.deleteMany({ where: { organisationId: org } });
    await prisma.store.deleteMany({ where: { organisationId: org } });
    await prisma.organisation.deleteMany({ where: { id: org } });
  }
}

describe('Salesperson scope (e2e)', () => {
  let app: INestApplication;
  let prisma: import('../src/prisma/prisma.service').PrismaService;
  const t: Record<string, string> = {};
  const id: Record<string, string> = {};
  const server = () => app.getHttpServer();
  const as = (who: string) => ({ Authorization: `Bearer ${t[who]}` });
  const get = (who: string, path: string) => request(server()).get(path).set(as(who));
  const listOf = (body: unknown): { id: string }[] =>
    Array.isArray(body) ? body : ((body as { items?: { id: string }[] }).items ?? []);

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
    await prisma.organisation.create({ data: { id: A.org, name: 'SSC', slug: A.slug, industryPackCode: 'jewellery', country: 'IN' } });
    await prisma.organisation.create({ data: { id: OTHER.org, name: 'SSC B', slug: OTHER.slug, industryPackCode: 'jewellery' } });
    await prisma.store.createMany({
      data: [
        { id: A.s1, name: 'One', city: 'Mumbai', organisationId: A.org, timezone: 'Asia/Kolkata' },
        { id: A.s2, name: 'Two', city: 'Pune', organisationId: A.org, timezone: 'Asia/Kolkata' },
        { id: OTHER.store, name: 'Elsewhere', city: 'Delhi', organisationId: OTHER.org, timezone: 'Asia/Kolkata' },
      ],
    });
    for (const [uid, role, store, org] of [
      ['u_ssc_r1', 'salesperson', A.s1, A.org],
      ['u_ssc_r2', 'salesperson', A.s1, A.org],
      ['u_ssc_mgr', 'store_manager', A.s1, A.org],
      ['u_ssc_other', 'salesperson', OTHER.store, OTHER.org],
    ] as const) {
      await prisma.user.create({
        data: {
          id: uid, email: `${uid}@ssc.local`, name: `${uid} Person`, role: role as never, passwordHash: hash,
          isActive: true, approvalStatus: 'approved', organisationId: org,
          userStores: { create: { storeId: store, isPrimary: true } },
        },
      });
    }

    // Each salesperson's book, at the same branch.
    for (const [key, owner, phone] of [['1', 'u_ssc_r1', '9812501001'], ['2', 'u_ssc_r2', '9812501002']] as const) {
      const party = await prisma.party.create({
        data: {
          organisationId: A.org, storeId: A.s1, name: `Customer ${key}`, phone, types: ['customer'],
          contactPoints: { create: { organisationId: A.org, kind: 'phone', value: phone, valueNormalized: `91${phone}`, isPrimary: true } },
        },
        include: { contactPoints: true },
      });
      id[`party${key}`] = party.id;
      id[`cp${key}`] = party.contactPoints[0].id;
      const lead = await prisma.lead.create({
        data: {
          organisationId: A.org, storeId: A.s1, ref: `SSC-L${key}`, customerName: `Customer ${key}`, phone,
          partyId: party.id, ownerId: owner, source: 'walk_in', stage: 'inquiry',
          followUps: { create: { storeId: A.s1, seq: 1, dueDate: new Date('2026-10-01') } },
        },
        include: { followUps: true },
      });
      id[`lead${key}`] = lead.id;
      id[`fu${key}`] = lead.followUps[0].id;
      id[`conv${key}`] = (
        await prisma.conversation.create({
          data: { organisationId: A.org, storeId: A.s1, channel: 'whatsapp', externalThreadId: `91${phone}`, partyId: party.id, assignedUserId: owner, handling: 'human' },
        })
      ).id;
      id[`visit${key}`] = (
        await prisma.checkIn.create({
          data: { organisationId: A.org, storeId: A.s1, customerName: `Customer ${key}`, partyId: party.id, repId: owner, timeIn: new Date() },
        })
      ).id;
      id[`quote${key}`] = (
        await prisma.quote.create({
          data: { organisationId: A.org, storeId: A.s1, ref: `SSC-Q${key}`, customerName: `Customer ${key}`, partyId: party.id, assignedRepId: owner },
        })
      ).id;
      id[`task${key}`] = (
        await prisma.task.create({
          data: { organisationId: A.org, storeId: A.s1, title: `Call ${key}`, assigneeId: owner, partyId: party.id, leadId: lead.id, dueDate: new Date() },
        })
      ).id;
      id[`sale${key}`] = (
        await prisma.sale.create({
          data: { organisationId: A.org, storeId: A.s1, docNo: `SSC-S${key}`, docDate: new Date(), salesPersonId: owner, partyId: party.id, totalAmount: 1000, isManual: true },
        })
      ).id;
      id[`ret${key}`] = (
        await prisma.returnRecord.create({
          data: { organisationId: A.org, storeId: A.s1, ref: `SSC-R${key}`, customerName: `Customer ${key}`, type: 'return', raisedById: owner },
        })
      ).id;
      await prisma.leadQualification.create({
        data: { organisationId: A.org, leadId: lead.id, partyId: party.id, method: 'rules', band: 'warm', score: 40 } as never,
      });
    }
    // An enquiry nobody has been given yet.
    id.convUnassigned = (
      await prisma.conversation.create({
        data: { organisationId: A.org, storeId: A.s1, channel: 'whatsapp', externalThreadId: '919812501009' },
      })
    ).id;

    for (const who of ['u_ssc_r1', 'u_ssc_r2', 'u_ssc_mgr']) {
      t[who] = (await request(server()).post('/auth/login').send({ email: `${who}@ssc.local`, password: PASSWORD }).expect(201)).body.token;
    }
  }, 180_000);

  afterAll(async () => {
    if (prisma) await teardown(prisma);
    if (app) await app.close();
  });

  const R1 = 'u_ssc_r1';

  it('leads: only their own, by list or by id, and no writes to a colleague’s', async () => {
    const leads = await get(R1, '/leads?outcome=all').expect(200);
    expect(leads.body.map((l: { id: string }) => l.id)).toEqual([id.lead1]);
    await get(R1, `/leads/${id.lead2}`).expect(404);
    await request(server()).patch(`/leads/${id.lead2}`).set(as(R1)).send({ interest: 'mine now' }).expect(404);
    await request(server()).post(`/leads/${id.lead2}/activities`).set(as(R1)).send({ kind: 'note', text: 'x' }).expect(404);
    await request(server()).post(`/leads/${id.lead2}/follow-ups`).set(as(R1)).send({ dueDate: '2026-10-09' }).expect(404);
    await request(server()).patch(`/leads/${id.lead2}/outcome`).set(as(R1)).send({ outcome: 'won' }).expect(404);
    // Nor give their own away.
    await request(server()).patch(`/leads/${id.lead1}`).set(as(R1)).send({ ownerId: 'u_ssc_r2' }).expect(403);
    await get(R1, `/lead-tags/lead/${id.lead2}`).expect(404);
  });

  it('follow-ups and reminders: only on their own leads', async () => {
    const rem = await get(R1, '/leads/reminders?scope=all').expect(200);
    expect(rem.body.map((r: { id: string }) => r.id)).toEqual([id.fu1]);
    await request(server()).patch(`/leads/reminders/${id.fu2}`).set(as(R1)).send({ done: true }).expect(403);
  });

  it('conversations: only threads assigned to them — not a colleague’s, not the unassigned queue', async () => {
    const list = await get(R1, '/crm/conversations').expect(200);
    expect(listOf(list.body).map((c) => c.id)).toEqual([id.conv1]);
    await get(R1, `/crm/conversations/${id.conv2}`).expect(404);
    await get(R1, `/crm/conversations/${id.convUnassigned}`).expect(404);
    await request(server()).post(`/crm/conversations/${id.conv2}/messages`).set(as(R1)).send({ body: 'hi' }).expect(404);
    await request(server()).patch(`/crm/conversations/${id.conv2}`).set(as(R1)).send({ status: 'closed' }).expect(404);
    const queues = await get(R1, '/crm/conversations/queues').expect(200);
    expect(queues.body.open).toBe(1);
    expect(queues.body.unassigned).toBe(0);
  });

  it('customers: their own profile; a colleague’s is absent, and a phone lookup reveals no PII', async () => {
    const mine = await get(R1, `/crm/customers/${id.party1}`).expect(200);
    expect(mine.body.leads.map((l: { id: string }) => l.id)).toEqual([id.lead1]);
    expect(mine.body.payments).toEqual([]);
    await get(R1, `/crm/customers/${id.party2}`).expect(404);
    const contacts = await get(R1, `/crm/customers/${id.party2}/contacts`).expect(200);
    expect(contacts.body).toEqual([]);
    await request(server()).post(`/crm/customers/${id.party2}/contacts`).set(as(R1)).send({ kind: 'email', value: 'x@y.in' }).expect(404);
    await request(server()).delete(`/crm/customers/contacts/${id.cp2}`).set(as(R1)).expect(404);
    expect(await prisma.contactPoint.count({ where: { id: id.cp2 } })).toBe(1);

    const lookup = await request(server()).post('/crm/customers/lookup').set(as(R1)).send({ kind: 'phone', value: '9812501002' }).expect(201);
    expect(lookup.body.restricted).toBe(true);
    expect(JSON.stringify(lookup.body)).not.toContain('Customer 2');

    const dir = await get(R1, '/parties?page=1&pageSize=50').expect(200);
    expect(listOf(dir.body).map((p) => p.id)).toEqual([id.party1]);
    await get(R1, `/crm/attribution/party/${id.party2}`).expect((r) => {
      // Either refused or empty — never the colleague's touches.
      if (r.status === 200 && (r.body.touches ?? []).length) throw new Error('attribution leaked');
    });
    await get(R1, `/omnichannel/consents/${id.party2}`).expect(404);
  });

  it('visits: only the walk-ins they served', async () => {
    const visits = await get(R1, '/checkins').expect(200);
    expect(visits.body.map((v: { id: string }) => v.id)).toEqual([id.visit1]);
    await request(server()).patch(`/checkins/${id.visit2}`).set({ ...as(R1), 'X-Store-Id': A.s1 }).send({ outcome: 'left' }).expect(403);
    const instore = await get(R1, '/instore/visits').expect(200);
    expect(listOf(instore.body).every((v) => v.id !== id.visit2)).toBe(true);
  });

  it('quotes: only the ones assigned to them, including the PDF, sharing and the approval state', async () => {
    const quotes = await get(R1, '/quotes').expect(200);
    expect(quotes.body.map((q: { id: string }) => q.id)).toEqual([id.quote1]);
    await get(R1, `/quotes/${id.quote2}`).expect(404);
    await get(R1, `/quotes/${id.quote2}/pdf`).expect(404);
    await get(R1, `/quotes/${id.quote2}/approval`).expect(404);
    await request(server()).post(`/quotes/${id.quote2}/share`).set(as(R1)).expect(404);
    await request(server()).post(`/quotes/${id.quote2}/request-approval`).set(as(R1)).send({}).expect(404);
  });

  it('calling and tasks: their own queue whatever they ask for', async () => {
    const queue = await get(R1, `/calling/queue?assigneeId=u_ssc_r2`).expect(200);
    expect(queue.body.items).toEqual([]);
    const all = await get(R1, `/calling/queue`).expect(200);
    expect(all.body.items.map((i: { id: string }) => i.id)).toEqual([id.task1]);
    await get(R1, `/calling/tasks/${id.task2}`).expect(404);
    await get(R1, `/calling/customers/${id.party2}/calls`).expect(404);
    const tasks = await get(R1, '/dashboard/tasks').expect(200);
    expect(tasks.body.map((x: { id: string }) => x.id)).toEqual([id.task1]);
    await request(server()).patch(`/dashboard/tasks/${id.task2}`).set(as(R1)).send({ status: 'done' }).expect(404);
  });

  it('bills and returns: their own', async () => {
    const sales = await get(R1, '/sales?scope=all').expect(200);
    expect(sales.body.map((s: { id: string }) => s.id)).toEqual([id.sale1]);
    await get(R1, `/sales/${id.sale2}`).expect(404);
    const returns = await get(R1, '/returns').expect(200);
    expect(returns.body.map((r: { id: string }) => r.id)).toEqual([id.ret1]);
    await get(R1, `/returns/${id.ret2}`).expect(404);
  });

  it('search finds nothing of a colleague’s', async () => {
    const res = await get(R1, '/search?q=Customer 2').expect(200);
    expect(JSON.stringify(res.body)).not.toMatch(new RegExp(`${id.lead2}|${id.quote2}|${id.party2}|${id.sale2}`));
  });

  it('qualification reads stay inside their book', async () => {
    const latest = await get(R1, `/crm/qualification/latest?leadId=${id.lead2}`).expect(200);
    expect(latest.body).toEqual({});
    const hist = await get(R1, '/crm/qualification/history').expect(200);
    expect(hist.body.every((h: { leadId?: string }) => h.leadId !== id.lead2)).toBe(true);
    await request(server()).post(`/crm/qualification/leads/${id.lead2}`).set(as(R1)).expect(404);
  });

  it('no management surface at all', async () => {
    for (const path of [
      '/dashboard/kpis', '/dashboard/charts', '/dashboard/assignable-users', '/payments', '/management/kpis',
      '/reporting/dsr', '/reporting/daily', '/hrms/attendance/report', '/hrms/attendance/team', '/hrms/payroll/runs',
      '/feedback/responses', '/feedback/summary', '/crm/omnichannel/summary', '/crm/segments',
      '/crm/round-robin/policy', '/crm/conversations/routing-conflicts', '/loyalty/members', '/loyalty/referral-codes',
      '/omnichannel/outbox', '/stock-transfers', '/users', '/users/pending', '/crm/exports/leads.xlsx',
      '/discounts/limits', '/marketing/campaigns', '/assistant/suggestions',
    ]) {
      const res = await get(R1, path);
      expect({ path, status: res.status }).toEqual({ path, status: 403 });
    }
    await request(server()).post('/reporting/daily').set(as(R1)).send({ storeId: A.s1, reportDate: '2026-09-01' }).expect(403);
    await request(server()).patch('/discounts/any/approve').set(as(R1)).send({}).expect(403);
    // Lead ageing and SLA clocks stay open to a salesperson, narrowed to their own
    // leads and assigned threads (ageing is pinned in crm-merge-sla-automation).
    const ageing = await get(R1, '/crm/leads/ageing').expect(200);
    expect(JSON.stringify(ageing.body)).not.toContain(id.lead2);
    await get(R1, '/crm/sla/clocks').expect(200);
  });

  it('late flags show a salesperson only themselves', async () => {
    await prisma.attendanceRecord.createMany({
      data: [
        { organisationId: A.org, storeId: A.s1, staffId: 'u_ssc_r2', staffName: 'r2', date: new Date('2026-09-02'), status: 'late', isLate: true },
      ] as never,
    });
    const flags = await get(R1, '/hrms/late-flags?month=2026-09').expect(200);
    const staff = Array.isArray(flags.body) ? flags.body : flags.body.staff;
    expect(staff.every((s: { staffId: string }) => s.staffId === 'u_ssc_r1')).toBe(true);
  });

  it('reassignment by a manager moves access immediately', async () => {
    await request(server()).patch(`/leads/${id.lead2}`).set(as('u_ssc_mgr')).send({ ownerId: 'u_ssc_r1' }).expect(200);
    await get(R1, `/leads/${id.lead2}`).expect(200);
    await get('u_ssc_r2', `/leads/${id.lead2}`).expect(404);
    await request(server()).patch(`/leads/${id.lead2}`).set(as('u_ssc_mgr')).send({ ownerId: 'u_ssc_r2' }).expect(200);
    await get(R1, `/leads/${id.lead2}`).expect(404);
    // A manager cannot hand a lead to someone from another organisation.
    await request(server()).patch(`/leads/${id.lead2}`).set(as('u_ssc_mgr')).send({ ownerId: 'u_ssc_other' }).expect(400);
  });

  it('managers keep the whole branch', async () => {
    const leads = await get('u_ssc_mgr', '/leads?outcome=all').expect(200);
    expect(leads.body.map((l: { id: string }) => l.id).sort()).toEqual([id.lead1, id.lead2].sort());
    const convs = await get('u_ssc_mgr', '/crm/conversations').expect(200);
    expect(listOf(convs.body).map((c) => c.id).sort()).toEqual([id.conv1, id.conv2, id.convUnassigned].sort());
    await get('u_ssc_mgr', `/quotes/${id.quote2}`).expect(200);
    await get('u_ssc_mgr', `/crm/customers/${id.party2}`).expect(200);
  });

  it('a hand-off cannot be assigned to another tenant’s user', async () => {
    await request(server())
      .post('/dashboard/handoffs')
      .set(as('u_ssc_mgr'))
      .send({ storeId: A.s1, fromDept: 'sales', toDept: 'inventory', title: 'Check the ring', assignedToId: 'u_ssc_other' })
      .expect(400);
  });
});
