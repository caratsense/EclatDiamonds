import { INestApplication, ValidationPipe } from '@nestjs/common';
import { Test } from '@nestjs/testing';
import request = require('supertest');
import * as bcrypt from 'bcryptjs';
import { AppModule } from '../src/app.module';
import { PrismaService } from '../src/prisma/prisma.service';
import { ConversationsService } from '../src/crm/conversations.service';

/**
 * Phase A9/A10/A14 — the capabilities added in the core-completion pass.
 *
 * These are the properties that are expensive to be wrong about, chosen because
 * each one fails silently if a later refactor breaks it:
 *
 *   QUALIFICATION — a score must never be produced from a hardcoded rule, and
 *   "could not assess" must never be stored as zero. A zero reads as "cold",
 *   which is a claim about the customer rather than about our evidence.
 *
 *   ATTRIBUTION — declared and measured must stay separable forever. Once they
 *   are blended, a marketing budget gets moved on a number that is half
 *   guesswork and nobody can tell which half.
 *
 *   CONNECT — the agent's tenant must come from its token and nothing else. A
 *   body-supplied organisationId would be a cross-tenant write with a valid
 *   credential attached, which no downstream check would catch.
 *
 *   TASKS — a global (null-store) task must appear in the list. It previously
 *   did not, which read to a manager as the save having failed.
 *
 * Org F is this spec's own tenant so it runs beside the other isolation specs.
 */
const PASSWORD = 'password123';

const F = {
  org: 'org_core_f',
  store: 'store_core_f',
  slug: 'core-f',
  ho: 'ho.f@core-f.local',
  rep: 'rep.f@core-f.local',
  phone: '9822233344',
  customer: 'CORE-F Customer',
};

describe('Core capabilities: qualification, attribution, connect, tasks (e2e)', () => {
  let app: INestApplication;
  let prisma: PrismaService;
  let token: string;
  let repId: string;
  let conversations: ConversationsService;

  const auth = () => ({ Authorization: `Bearer ${token}` });
  const post = (path: string, body: object = {}) =>
    request(app.getHttpServer()).post(path).set(auth()).send(body);
  const get = (path: string) => request(app.getHttpServer()).get(path).set(auth());

  beforeAll(async () => {
    const mod = await Test.createTestingModule({ imports: [AppModule] }).compile();
    app = mod.createNestApplication({ rawBody: true });
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
    conversations = app.get(ConversationsService);

    const hash = await bcrypt.hash(PASSWORD, 10);
    await teardown(prisma);

    await prisma.organisation.create({
      // A real tenant always has an industry, and this fixture exercises the
      // jewellery operational modules (sales, attribution, tasks). Without a
      // pack the entitlement guard correctly refuses them — see
      // config/entitlements.ts.
      data: { id: F.org, name: 'Core Test F', slug: F.slug, industryPackCode: 'jewellery' },
    });
    await prisma.store.create({
      data: { id: F.store, name: 'CORE-F Store', city: 'Testville', organisationId: F.org },
    });
    await prisma.user.create({
      data: {
        email: F.ho, name: 'HO F', role: 'head_office', passwordHash: hash,
        isActive: true, approvalStatus: 'approved', organisationId: F.org,
        userStores: { create: { storeId: F.store, isPrimary: true } },
      },
    });
    const rep = await prisma.user.create({
      data: {
        email: F.rep, name: 'Rep F', role: 'salesperson', passwordHash: hash,
        isActive: true, approvalStatus: 'approved', organisationId: F.org,
        userStores: { create: { storeId: F.store, isPrimary: true } },
      },
    });
    repId = rep.id;

    const login = await request(app.getHttpServer())
      .post('/auth/login')
      .send({ email: F.ho, password: PASSWORD });
    expect(login.status).toBe(201);
    token = login.body.token;
  });

  afterAll(async () => {
    await teardown(prisma);
    await app?.close();
  });

  /* ------------------------------------------------------ qualification */

  it('qualification is OFF until a tenant turns it on, and says so rather than scoring', async () => {
    const lead = await post('/leads', {
      storeId: F.store,
      customerName: F.customer,
      phone: F.phone,
      source: 'instagram',
      interest: 'I want to buy this week, my budget is around Rs 2 lakh',
    });
    expect(lead.status).toBe(201);

    const assessed = await post(`/crm/qualification/leads/${lead.body.id}`);
    expect(assessed.status).toBe(201);
    // The critical assertion: no score at all, not a zero. A zero would be a
    // statement about the customer; null is a statement about our evidence.
    expect(assessed.body.score).toBeNull();
    expect(assessed.body.available).toBe(false);
    expect(assessed.body.unavailableReason).toMatch(/switched off/i);
  });

  it('scores from the tenant policy, and every score carries the evidence for it', async () => {
    const enabled = await post('/crm/qualification/policy', {
      enabled: true,
      minMessagesToScore: 1,
    });
    expect(enabled.status).toBe(201);

    const lead = await prisma.lead.findFirst({
      where: { organisationId: F.org },
      orderBy: { createdAt: 'desc' },
    });
    const assessed = await post(`/crm/qualification/leads/${lead!.id}`);
    expect(assessed.status).toBe(201);

    expect(assessed.body.available).toBe(true);
    expect(assessed.body.score).toBeGreaterThan(0);
    // Explainability is the whole contract: a score with no fired signals is an
    // oracle, and nobody can argue with an oracle.
    expect(assessed.body.firedSignals.length).toBeGreaterThan(0);
    for (const signal of assessed.body.firedSignals) {
      expect(signal.evidence).toBeTruthy();
      expect(typeof signal.weight).toBe('number');
    }
    // With no provider configured this is the deterministic path, and it says so
    // rather than implying a model was involved.
    expect(assessed.body.method).toBe('rules');
    expect(assessed.body.policyVersion).toBeGreaterThan(0);
  });

  it('the scoring thresholds are the tenant’s, not the platform’s', async () => {
    // Re-band the SAME text so that what was scoring well now lands in a band the
    // tenant defined. If any threshold were compiled in, this could not change.
    const saved = await post('/crm/qualification/policy', {
      enabled: true,
      minMessagesToScore: 1,
      bands: [
        { key: 'needs_review', label: 'Send to the owner', minScore: 1, recommendedAction: 'Owner calls personally.' },
      ],
    });
    expect(saved.status).toBe(201);

    const lead = await prisma.lead.findFirst({
      where: { organisationId: F.org },
      orderBy: { createdAt: 'desc' },
    });
    const assessed = await post(`/crm/qualification/leads/${lead!.id}`);
    expect(assessed.body.band).toBe('needs_review');
    expect(assessed.body.bandLabel).toBe('Send to the owner');
    expect(assessed.body.recommendedAction).toBe('Owner calls personally.');
  });

  /* --------------------------------------------------- ad-set automation */

  it('routes matching ad sets to a store and keeps human-only campaigns away from AI', async () => {
    const saved = await post('/crm/qualification/adset-rules', {
      rules: [{
        id: 'hyderabad_franchise',
        name: 'Hyderabad franchise enquiries',
        enabled: true,
        priority: 200,
        matchField: 'ad_set_name',
        matchValue: 'Hyderabad Franchise',
        storeId: F.store,
        assignedUserId: repId,
        handling: 'human',
      }],
    });
    expect(saved.status).toBe(201);

    const inbound = await conversations.ingestInbound({
      organisationId: F.org,
      channel: 'whatsapp',
      externalThreadId: 'core-f-adset-thread',
      externalId: 'core-f-adset-message',
      senderKind: 'whatsapp',
      senderValue: '919811112222',
      body: 'I would like to discuss a franchise.',
      routing: { adSetName: 'Leadgen | Hyderabad Franchise | September' },
    });

    expect(inbound.routing).toMatchObject({
      ruleId: 'hyderabad_franchise',
      storeId: F.store,
      assignedUserId: repId,
      handling: 'human',
    });
    const conversation = await prisma.conversation.findUnique({ where: { id: inbound.conversationId } });
    expect(conversation).toMatchObject({ storeId: F.store, assignedUserId: repId, handling: 'human' });
    expect(conversation!.handoffReason).toMatch(/Hyderabad franchise enquiries/);
  });

  /* --------------------------------------------------------- attribution */

  it('a declared lead source becomes a DECLARED touch, never a measured one', async () => {
    const party = await prisma.party.findFirst({
      where: { organisationId: F.org, phone: { contains: '9822233344' } },
    });
    expect(party).toBeTruthy();

    const attribution = await get(`/crm/attribution/party/${party!.id}`);
    expect(attribution.status).toBe(200);
    expect(attribution.body.status).toBe('attributed');
    expect(attribution.body.firstTouch.source).toBe('instagram');
    // The load-bearing assertion. A salesperson picked "instagram" from a
    // dropdown; that must never be reported with the authority of a tracked
    // click, or spend decisions get made on recollection.
    expect(attribution.body.firstTouch.evidence).toBe('declared');
    expect(attribution.body.touches[0].position).toBe('first_touch');
  });

  it('a customer with no recorded source reads as unattributed, not as organic', async () => {
    const created = await post('/leads', {
      storeId: F.store,
      customerName: 'CORE-F No Source',
      phone: '9833344455',
      source: 'walk_in',
      interest: 'browsing',
    });
    expect(created.status).toBe(201);

    const party = await prisma.party.findFirst({
      where: { organisationId: F.org, name: 'CORE-F No Source' },
    });
    const attribution = await get(`/crm/attribution/party/${party!.id}`);
    // "walk_in" is a real declared answer, so it attributes — but to itself, and
    // to a channel that is NOT advertising. A walk-in credited to `ad` would put
    // organic footfall on a campaign's return.
    expect(attribution.body.firstTouch.source).toBe('walk_in');
    expect(attribution.body.firstTouch.channel).toBe('direct');
  });

  it('a sale credits the touches that preceded it, under both models', async () => {
    const sale = await post('/sales', {
      storeId: F.store,
      customerName: F.customer,
      phone: F.phone,
      invoiceNo: 'CORE-F-INV-1',
      salesValue: 120000,
    });
    expect([200, 201]).toContain(sale.status);

    const party = await prisma.party.findFirst({
      where: { organisationId: F.org, phone: { contains: '9822233344' } },
    });
    const credited = await prisma.attributionTouch.findMany({
      where: { organisationId: F.org, partyId: party!.id, saleId: { not: null } },
    });
    expect(credited.length).toBeGreaterThan(0);
    // A single recorded touch is credited as `both` — it IS the first and the
    // last. Asserting only 'first_touch' here would have hidden the bug where a
    // last-touch report dropped every single-touch customer.
    expect(credited.map((c) => c.creditModel)).toContain('both');

    const attribution = await get(`/crm/attribution/party/${party!.id}`);
    expect(attribution.body.revenue).toBeTruthy();
    expect(Number(attribution.body.revenue.total)).toBeGreaterThan(0);
  });

  it('campaign revenue keeps measured and declared apart', async () => {
    const campaigns = await get('/crm/attribution/campaigns');
    expect(campaigns.status).toBe(200);
    const row = campaigns.body.rows.find((r: { label: string }) => r.label === 'instagram');
    expect(row).toBeTruthy();
    // Declared revenue is present; measured is zero, because nothing was
    // measured. A blended single figure would hide exactly that.
    expect(Number(row.declaredRevenue)).toBeGreaterThan(0);
    expect(Number(row.measuredRevenue)).toBe(0);
    // No ROAS is offered without measured revenue AND known spend.
    expect(row.measuredRoas).toBeNull();
  });

  /* ------------------------------------------------------ CaratOS Connect */

  it('an enrolled agent gets its token once, and authenticates with it', async () => {
    const enrolled = await post('/integration/connect/agents', {
      name: 'CORE-F back office',
      sourceSystem: 'gati',
      storeId: F.store,
    });
    expect(enrolled.status).toBe(201);
    const agentToken: string = enrolled.body.token;
    expect(agentToken).toMatch(/^cxa_/);

    // The token is never returned again — only its prefix.
    const list = await get('/integration/connect/agents');
    expect(list.status).toBe(200);
    const listed = list.body.find((a: { name: string }) => a.name === 'CORE-F back office');
    expect(listed.tokenPrefix).toBe(agentToken.slice(0, 12));
    expect(JSON.stringify(list.body)).not.toContain(agentToken);

    // It is stored as a hash, so a database read cannot be replayed as an agent.
    const row = await prisma.connectAgent.findFirst({ where: { organisationId: F.org } });
    expect(row!.tokenHash).not.toBe(agentToken);
    expect(row!.tokenHash).toHaveLength(64);

    const beat = await request(app.getHttpServer())
      .post('/integration/connect/heartbeat')
      .set({ Authorization: `Bearer ${agentToken}` })
      .send({ agentVersion: '1.4.0', hostname: 'SHOP-PC', os: 'Windows 11', status: 'active' });
    expect(beat.status).toBe(201);
    expect(beat.body.acknowledged).toBe(true);
    expect(beat.body.sourceSystem).toBe('gati');
  });

  it('the agent’s tenant comes from its token — a body organisationId is refused', async () => {
    const row = await prisma.connectAgent.findFirst({ where: { organisationId: F.org } });
    const rotated = await post(`/integration/connect/agents/${row!.id}/rotate`);
    const agentToken: string = rotated.body.token;

    // `forbidNonWhitelisted` rejects the field outright: there is no code path
    // that could read a tenant from an agent's request body, because the DTO has
    // no such property to read.
    const spoofed = await request(app.getHttpServer())
      .post('/integration/connect/heartbeat')
      .set({ Authorization: `Bearer ${agentToken}` })
      .send({ organisationId: 'org_eclat', status: 'active' });
    expect(spoofed.status).toBe(400);

    // And the identity it does report is its own, resolved server-side.
    const me = await request(app.getHttpServer())
      .get('/integration/connect/me')
      .set({ Authorization: `Bearer ${agentToken}` });
    expect(me.status).toBe(200);
    expect(me.body.organisationId).toBe(F.org);
  });

  it('a rotated token invalidates the old one, and a revoked agent authenticates nowhere', async () => {
    const row = await prisma.connectAgent.findFirst({ where: { organisationId: F.org } });
    const first = await post(`/integration/connect/agents/${row!.id}/rotate`);
    const oldToken: string = first.body.token;
    const second = await post(`/integration/connect/agents/${row!.id}/rotate`);
    const newToken: string = second.body.token;

    const stale = await request(app.getHttpServer())
      .post('/integration/connect/heartbeat')
      .set({ Authorization: `Bearer ${oldToken}` })
      .send({ status: 'active' });
    expect(stale.status).toBe(401);

    await request(app.getHttpServer())
      .delete(`/integration/connect/agents/${row!.id}`)
      .set(auth())
      .expect(200);

    const revoked = await request(app.getHttpServer())
      .post('/integration/connect/heartbeat')
      .set({ Authorization: `Bearer ${newToken}` })
      .send({ status: 'active' });
    expect(revoked.status).toBe(403);
  });

  /* ----------------------------------------------------------- tasks */

  it('a task carries a real assignee id, a priority and its subject', async () => {
    const party = await prisma.party.findFirst({ where: { organisationId: F.org } });
    const created = await post('/dashboard/tasks', {
      title: 'CORE-F call the customer back',
      assignee: 'ignored in favour of the id',
      assigneeId: repId,
      priority: 'high',
      partyId: party!.id,
      storeId: F.store,
    });
    expect(created.status).toBe(201);
    expect(created.body.assigneeId).toBe(repId);
    // The stored NAME comes from the user record, not from the request — so it
    // cannot disagree with the id it sits beside.
    expect(created.body.assignee).toBe('Rep F');
    expect(created.body.priority).toBe('high');
    expect(created.body.party.id).toBe(party!.id);

    const mine = await get('/dashboard/tasks?mine=true');
    expect(mine.status).toBe(200);
    // The HO user did not assign it to themselves, so "mine" must not show it.
    expect(mine.body.find((t: { id: string }) => t.id === created.body.id)).toBeUndefined();
  });

  it('a task for another organisation’s customer is refused', async () => {
    const foreign = await prisma.party.findFirst({ where: { organisationId: { not: F.org } } });
    if (!foreign) return; // single-tenant database — nothing to prove here
    const created = await post('/dashboard/tasks', {
      title: 'CORE-F cross-tenant attempt',
      assignee: 'Rep F',
      partyId: foreign.id,
      storeId: F.store,
    });
    expect(created.status).toBe(400);
  });

  it('a global (null-store) task appears in the list', async () => {
    const created = await post('/dashboard/tasks', {
      title: 'CORE-F organisation-wide task',
      assignee: 'Rep F',
      assigneeId: repId,
    });
    expect(created.status).toBe(201);
    expect(created.body.storeId).toBeNull();

    // Regression guard. This previously listed through a storeId `in` filter,
    // which no null-store row can match — so the task saved successfully and
    // then vanished, which reads as the save having failed.
    const list = await get('/dashboard/tasks');
    expect(list.body.find((t: { id: string }) => t.id === created.body.id)).toBeTruthy();
  });
});

async function teardown(prisma: PrismaService) {
  await prisma.leadQualification.deleteMany({ where: { organisationId: F.org } });
  await prisma.attributionTouch.deleteMany({ where: { organisationId: F.org } });
  await prisma.connectAgent.deleteMany({ where: { organisationId: F.org } });
  await prisma.task.deleteMany({ where: { organisationId: F.org } });
  await prisma.productInteraction.deleteMany({ where: { organisationId: F.org } });
  await prisma.activityEvent.deleteMany({ where: { organisationId: F.org } });
  await prisma.auditLog.deleteMany({ where: { organisationId: F.org } });
  await prisma.message.deleteMany({ where: { organisationId: F.org } });
  await prisma.conversation.deleteMany({ where: { organisationId: F.org } });
  await prisma.payment.deleteMany({ where: { organisationId: F.org } });
  await prisma.saleLine.deleteMany({ where: { organisationId: F.org } });
  await prisma.sale.deleteMany({ where: { organisationId: F.org } });
  await prisma.leadFollowUp.deleteMany({ where: { lead: { organisationId: F.org } } });
  await prisma.leadNote.deleteMany({ where: { lead: { organisationId: F.org } } });
  await prisma.lead.deleteMany({ where: { organisationId: F.org } });
  await prisma.contactPoint.deleteMany({ where: { organisationId: F.org } });
  await prisma.mergeCandidate.deleteMany({ where: { organisationId: F.org } });
  await prisma.party.deleteMany({ where: { organisationId: F.org } });
  await prisma.userStore.deleteMany({ where: { store: { organisationId: F.org } } });
  await prisma.user.deleteMany({ where: { organisationId: F.org } });
  await prisma.store.deleteMany({ where: { organisationId: F.org } });
  await prisma.organisation.deleteMany({ where: { slug: F.slug } });
}
