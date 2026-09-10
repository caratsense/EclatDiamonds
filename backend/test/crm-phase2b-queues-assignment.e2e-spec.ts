import { INestApplication, ValidationPipe } from '@nestjs/common';
import { Test } from '@nestjs/testing';
import request = require('supertest');
import * as bcrypt from 'bcryptjs';
import { AppModule } from '../src/app.module';
import { PrismaService } from '../src/prisma/prisma.service';
import { ConversationsService } from '../src/crm/conversations.service';
import { extractMetaReferral } from '../src/integrations/meta-referral';

/**
 * Phase 2B — queues, assignment and routing-conflict resolution.
 *
 * These test the properties an operations screen depends on, not the shape of
 * its JSON:
 *
 *  - a queue tab shows what the SERVER decided is in it, and its badge agrees
 *    with the list under it;
 *  - the central (storeless) queue is head office's alone, by list AND by id;
 *  - rerouting is a supervisory act, refused below store manager, refused into
 *    somebody else's branch, and refused for an owner who does not work there;
 *  - a routing conflict can be decided exactly three ways, exactly once, and
 *    the record of the decision is never destroyed.
 *
 * Two roles that no other CRM spec creates matter here: a STORE MANAGER (so the
 * store-scope check on assign is exercised rather than being short-circuited by
 * the role gate) and a SALESPERSON (so the role gate itself is exercised).
 */
const PW = 'password123';

const O = {
  org: 'org_p2b',
  slug: 'p2b',
  north: 'store_p2b_north',
  south: 'store_p2b_south',
  ho: 'ho.p2b@p2b.local',
  northMgr: 'north.mgr@p2b.local',
  northRep: 'north.rep@p2b.local',
  southMgr: 'south.mgr@p2b.local',
};

/** A second tenant, for the cross-tenant checks. */
const X = { org: 'org_p2b_x', slug: 'p2b-x', store: 'store_p2b_x', user: 'ho.x@p2bx.local' };

function ctwa(adId: string, wamid: string, from: string, clid: string) {
  return {
    from, id: wamid, timestamp: '1757240000', type: 'text',
    text: { body: 'Saw your ad' },
    referral: {
      source_url: 'https://fb.me/x', source_id: adId, source_type: 'ad',
      headline: 'Campaign', body: 'Enquire now', ctwa_clid: clid,
    },
  };
}

describe('CRM Phase 2B — queues, assignment, conflict resolution (e2e)', () => {
  let app: INestApplication;
  let prisma: PrismaService;
  let convos: ConversationsService;

  let hoToken: string;
  let northMgrToken: string;
  let northRepToken: string;
  let southMgrToken: string;
  let xToken: string;

  let northRepId: string;
  let southMgrId: string;

  const auth = (t: string) => ({ Authorization: `Bearer ${t}` });
  const http = () => request(app.getHttpServer());

  beforeAll(async () => {
    const mod = await Test.createTestingModule({ imports: [AppModule] }).compile();
    app = mod.createNestApplication();
    app.useGlobalPipes(new ValidationPipe({ whitelist: true, forbidNonWhitelisted: true, transform: true }));
    await app.init();
    prisma = app.get(PrismaService);
    convos = app.get(ConversationsService);

    await teardown(prisma);
    const hash = await bcrypt.hash(PW, 10);

    await prisma.organisation.create({ data: { id: O.org, name: 'P2B', slug: O.slug } });
    await prisma.store.createMany({ data: [
      { id: O.north, name: 'North', city: 'North', organisationId: O.org },
      { id: O.south, name: 'South', city: 'South', organisationId: O.org },
    ]});

    const mk = async (email: string, name: string, role: 'head_office' | 'store_manager' | 'salesperson', storeId: string) =>
      prisma.user.create({ data: {
        email, name, role, passwordHash: hash, isActive: true, approvalStatus: 'approved',
        organisationId: O.org, userStores: { create: { storeId, isPrimary: true } },
      }});

    await mk(O.ho, 'Head Office', 'head_office', O.north);
    await mk(O.northMgr, 'North Manager', 'store_manager', O.north);
    northRepId = (await mk(O.northRep, 'North Rep', 'salesperson', O.north)).id;
    southMgrId = (await mk(O.southMgr, 'South Manager', 'store_manager', O.south)).id;

    // The other tenant.
    await prisma.organisation.create({ data: { id: X.org, name: 'P2BX', slug: X.slug } });
    await prisma.store.create({ data: { id: X.store, name: 'X', city: 'X', organisationId: X.org } });
    await prisma.user.create({ data: {
      email: X.user, name: 'X HO', role: 'head_office', passwordHash: hash, isActive: true,
      approvalStatus: 'approved', organisationId: X.org,
      userStores: { create: { storeId: X.store, isPrimary: true } },
    }});

    await setRules(prisma, O.org, [
      { id: 'r-north', name: 'North campaign', enabled: true, priority: 50, matchField: 'ad_id',
        matchValue: 'AD_NORTH', storeId: O.north, assignedUserId: null, handling: 'ai' },
      { id: 'r-south', name: 'South campaign', enabled: true, priority: 50, matchField: 'ad_id',
        matchValue: 'AD_SOUTH', storeId: O.south, assignedUserId: null, handling: 'ai' },
    ]);

    const login = async (email: string) =>
      (await http().post('/auth/login').send({ email, password: PW })).body.token as string;

    hoToken = await login(O.ho);
    northMgrToken = await login(O.northMgr);
    northRepToken = await login(O.northRep);
    southMgrToken = await login(O.southMgr);
    xToken = await login(X.user);
  });

  afterAll(async () => { await teardown(prisma); await app?.close(); });

  /* =========================================================== queues */

  describe('queues', () => {
    it('every queue filter reaches the server and returns only rows matching it', async () => {
      // One thread per shape the tabs slice on.
      await ingest(convos, ctwa('AD_NORTH', 'wa.q.1', '919440000001', 'CL_Q1'), 'th-q-ai');
      const humanThread = await ingest(convos, ctwa('AD_NORTH', 'wa.q.2', '919440000002', 'CL_Q2'), 'th-q-human');
      await convos.assign(await actor(prisma, O.ho, true), humanThread.conversationId, {
        storeId: O.north, assignedUserId: northRepId, handling: 'human', reason: 'seed',
      });
      const closed = await ingest(convos, ctwa('AD_NORTH', 'wa.q.3', '919440000003', 'CL_Q3'), 'th-q-closed');
      await prisma.conversation.update({ where: { id: closed.conversationId }, data: { status: 'closed' } });

      const q = async (params: Record<string, string>) => {
        const res = await http().get('/crm/conversations').query(params).set(auth(hoToken));
        expect(res.status).toBe(200);
        return res.body as { id: string; status: string; handling: string; partyId: string | null;
          assignedUser: { id: string } | null; routingReviewRequired: boolean }[];
      };

      expect((await q({ status: 'open' })).every((c) => c.status === 'open')).toBe(true);
      expect((await q({ status: 'closed' })).every((c) => c.status === 'closed')).toBe(true);
      expect((await q({ handling: 'ai' })).every((c) => c.handling === 'ai')).toBe(true);
      expect((await q({ handling: 'human' })).every((c) => c.handling === 'human')).toBe(true);
      expect((await q({ handling: 'unassigned' })).every((c) => c.handling === 'unassigned')).toBe(true);
      expect((await q({ unidentified: 'true' })).every((c) => c.partyId === null)).toBe(true);
      expect((await q({ routingReview: 'true' })).every((c) => c.routingReviewRequired)).toBe(true);

      // "mine" is the caller's own, not a client-side filter over everyone's.
      const mineForRep = await http().get('/crm/conversations').query({ mine: 'true' }).set(auth(northRepToken));
      expect(mineForRep.status).toBe(200);
      expect(mineForRep.body.map((c: { id: string }) => c.id)).toContain(humanThread.conversationId);
      const mineForMgr = await http().get('/crm/conversations').query({ mine: 'true' }).set(auth(northMgrToken));
      expect(mineForMgr.body.map((c: { id: string }) => c.id)).not.toContain(humanThread.conversationId);
    });

    it('the badge for a queue agrees with the list under it', async () => {
      const counts = await http().get('/crm/conversations/queues').set(auth(hoToken));
      expect(counts.status).toBe(200);

      // Checked against the LIST, because a count computed a different way from
      // the list it labels is the whole failure mode worth testing for.
      for (const [key, params] of [
        ['open', { status: 'open' }],
        ['human', { handling: 'human' }],
        ['ai', { handling: 'ai' }],
        ['unassigned', { handling: 'unassigned' }],
        ['closed', { status: 'closed' }],
        ['unknown', { unidentified: 'true' }],
        ['review', { routingReview: 'true' }],
      ] as const) {
        const list = await http().get('/crm/conversations').query(params).set(auth(hoToken));
        expect({ key, n: counts.body[key] }).toEqual({ key, n: list.body.length });
      }
    });

    /**
     * One customer's threads, which is how "Chat" on a lead card, a floor task
     * or a calling row now opens a conversation in one tap.
     *
     * The filter is a NARROWING, and that is what these three cases pin. A
     * party filter that were applied instead of the caller's visibility clause
     * would be a way to read another branch's inbox by guessing an id — the
     * exact shape of the store filter's own comment two lines above it in the
     * service.
     */
    it('filters to one customer, and only within what the caller may already see', async () => {
      const thread = await ingest(
        convos,
        ctwa('AD_NORTH', 'wa.q.party', '919440000021', 'CL_QP'),
        'th-q-party',
      );
      const row = await prisma.conversation.findUniqueOrThrow({
        where: { id: thread.conversationId },
        select: { partyId: true },
      });
      const partyId = row.partyId as string;
      expect(partyId).toBeTruthy();

      const mine = await http()
        .get('/crm/conversations')
        .query({ partyId })
        .set(auth(hoToken));
      expect(mine.status).toBe(200);
      expect(mine.body.length).toBeGreaterThan(0);
      expect(
        mine.body.every((c: { party: { id: string } | null }) => c.party?.id === partyId),
      ).toBe(true);

      // The south manager cannot read a north thread, and asking for the
      // customer by id does not change that.
      const otherBranch = await http()
        .get('/crm/conversations')
        .query({ partyId })
        .set(auth(southMgrToken));
      expect(otherBranch.status).toBe(200);
      expect(otherBranch.body.map((c: { id: string }) => c.id)).not.toContain(
        thread.conversationId,
      );

      // Nor can another tenant.
      const otherTenant = await http()
        .get('/crm/conversations')
        .query({ partyId })
        .set(auth(xToken));
      expect(otherTenant.status).toBe(200);
      expect(otherTenant.body).toEqual([]);
    });

    it('counts are per-caller: a store manager is not told how much work exists elsewhere', async () => {
      await ingest(convos, ctwa('AD_SOUTH', 'wa.q.south', '919440000009', 'CL_QS'), 'th-q-south');

      const ho = await http().get('/crm/conversations/queues').set(auth(hoToken));
      const north = await http().get('/crm/conversations/queues').set(auth(northMgrToken));
      expect(north.status).toBe(200);
      // Head office sees both branches; North's manager sees strictly fewer.
      expect(ho.body.open).toBeGreaterThan(north.body.open);

      const northList = await http().get('/crm/conversations').query({ status: 'open' }).set(auth(northMgrToken));
      expect(northList.body.length).toBe(north.body.open);
      expect(northList.body.every((c: { storeId: string | null }) => c.storeId === O.north)).toBe(true);
    });
  });

  /* ============================================== central queue (1F) */

  describe('the central storeless queue', () => {
    let centralId: string;

    beforeAll(async () => {
      // No rule matches, so nothing routes it: it has no store.
      const r = await ingest(convos, ctwa('AD_NOBODY', 'wa.c.1', '919440000004', 'CL_C1'), 'th-central');
      centralId = r.conversationId;
      const c = await prisma.conversation.findUnique({ where: { id: centralId }, select: { storeId: true } });
      expect(c!.storeId).toBeNull();
    });

    it('head office can see it and open it', async () => {
      const list = await http().get('/crm/conversations').set(auth(hoToken));
      expect(list.body.map((c: { id: string }) => c.id)).toContain(centralId);
      expect((await http().get(`/crm/conversations/${centralId}`).set(auth(hoToken))).status).toBe(200);
    });

    it('a store manager sees neither the row nor the thread behind its id', async () => {
      const list = await http().get('/crm/conversations').set(auth(northMgrToken));
      expect(list.body.map((c: { id: string }) => c.id)).not.toContain(centralId);
      // Hiding it from the list is not enough — opening it by id must 404 too.
      expect((await http().get(`/crm/conversations/${centralId}`).set(auth(northMgrToken))).status).toBe(404);
    });

    it('a salesperson sees neither either', async () => {
      const list = await http().get('/crm/conversations').set(auth(northRepToken));
      expect(list.body.map((c: { id: string }) => c.id)).not.toContain(centralId);
      expect((await http().get(`/crm/conversations/${centralId}`).set(auth(northRepToken))).status).toBe(404);
    });

    it('it is not counted for anyone who cannot see it', async () => {
      const north = await http().get('/crm/conversations/queues').set(auth(northMgrToken));
      const northList = await http().get('/crm/conversations').query({ status: 'open' }).set(auth(northMgrToken));
      expect(north.body.open).toBe(northList.body.length);
      expect(northList.body.map((c: { id: string }) => c.id)).not.toContain(centralId);
    });
  });

  /* ======================================================= assignment */

  describe('assignment', () => {
    let threadId: string;
    let n = 0;

    // A FRESH thread per test. Sharing one conversation made each test depend on
    // the routing the previous one happened to leave behind, which is how a suite
    // starts passing for the wrong reason.
    beforeEach(async () => {
      n += 1;
      const r = await ingest(
        convos,
        ctwa('AD_NORTH', `wa.a.${n}`, `91944000100${n}`, `CL_A${n}`),
        `th-assign-${n}`,
      );
      threadId = r.conversationId;
    });

    it('a store manager can reroute inside their own branch', async () => {
      const res = await http().post(`/crm/conversations/${threadId}/assign`).set(auth(northMgrToken))
        .send({ storeId: O.north, assignedUserId: northRepId, handling: 'human', reason: 'Taking it' });
      expect(res.status).toBe(201);
      expect(res.body).toMatchObject({ storeId: O.north, assignedUserId: northRepId, handling: 'human' });
    });

    it('a salesperson cannot reassign at all — the server refuses, whatever the UI shows', async () => {
      const res = await http().post(`/crm/conversations/${threadId}/assign`).set(auth(northRepToken))
        .send({ storeId: O.north, assignedUserId: northRepId });
      expect(res.status).toBe(403);
    });

    it('a store manager cannot push a thread into a branch they do not run', async () => {
      // Reaches assertStoreAllowed rather than the role gate: this caller HAS the
      // rank, and is refused on scope.
      const res = await http().post(`/crm/conversations/${threadId}/assign`).set(auth(northMgrToken))
        .send({ storeId: O.south });
      expect(res.status).toBe(403);
      const after = await prisma.conversation.findUnique({ where: { id: threadId }, select: { storeId: true } });
      expect(after!.storeId).toBe(O.north);
    });

    it('an owner who does not work at the destination is refused', async () => {
      const res = await http().post(`/crm/conversations/${threadId}/assign`).set(auth(hoToken))
        .send({ storeId: O.north, assignedUserId: southMgrId });
      expect(res.status).toBe(400);
      expect(res.body.message).toMatch(/does not work at the destination/i);
    });

    it('another tenant cannot reach the conversation at all', async () => {
      expect((await http().get(`/crm/conversations/${threadId}`).set(auth(xToken))).status).toBe(404);
      const res = await http().post(`/crm/conversations/${threadId}/assign`).set(auth(xToken))
        .send({ storeId: X.store });
      expect([403, 404]).toContain(res.status);
      const after = await prisma.conversation.findUnique({ where: { id: threadId }, select: { storeId: true } });
      expect(after!.storeId).toBe(O.north);
    });

    it('a double submit converges rather than diverging', async () => {
      const body = { storeId: O.north, assignedUserId: northRepId, handling: 'human' };
      const [a, b] = await Promise.all([
        http().post(`/crm/conversations/${threadId}/assign`).set(auth(northMgrToken)).send(body),
        http().post(`/crm/conversations/${threadId}/assign`).set(auth(northMgrToken)).send(body),
      ]);
      expect([a.status, b.status]).toEqual([201, 201]);
      const after = await prisma.conversation.findUnique({
        where: { id: threadId }, select: { storeId: true, assignedUserId: true, handling: true },
      });
      // Same command twice leaves the same state — the second press cannot
      // half-apply and produce a thread owned in one branch and filed in another.
      expect(after).toMatchObject({ storeId: O.north, assignedUserId: northRepId, handling: 'human' });
    });

    it('ownership cannot be changed through PATCH, which never checked the branch', async () => {
      // The hole that made the rank on /assign decorative: PATCH accepted any
      // active user in the organisation, with no membership check and no role
      // gate. It is rejected outright now rather than silently misrouting work.
      const res = await http().patch(`/crm/conversations/${threadId}`).set(auth(northRepToken))
        .send({ assignedUserId: southMgrId });
      expect(res.status).toBe(400);
      const after = await prisma.conversation.findUnique({ where: { id: threadId }, select: { assignedUserId: true } });
      expect(after!.assignedUserId).not.toBe(southMgrId);
    });
  });

  /* ================================================ routing conflicts */

  describe('routing conflicts', () => {
    /** A thread routed North, then hit by a South ad. */
    async function makeConflict(suffix: string, phone: string) {
      const first = await ingest(convos, ctwa('AD_NORTH', `wa.rc.${suffix}.1`, phone, `CL_RC${suffix}1`), `th-rc-${suffix}`);
      await ingest(convos, ctwa('AD_SOUTH', `wa.rc.${suffix}.2`, phone, `CL_RC${suffix}2`), `th-rc-${suffix}`);
      const conflict = await prisma.conversationRoutingConflict.findFirst({
        where: { conversationId: first.conversationId, resolution: null },
      });
      expect(conflict).toBeTruthy();
      return { conversationId: first.conversationId, conflictId: conflict!.id };
    }

    it('a conflict is listed with both sides named, not as raw ids', async () => {
      const { conversationId } = await makeConflict('display', '919440000006');
      const res = await http().get('/crm/conversations/routing-conflicts')
        .query({ conversationId }).set(auth(hoToken));
      expect(res.status).toBe(200);
      expect(res.body).toHaveLength(1);
      const c = res.body[0];
      // A screen that renders "store_p2b_south" is useless to the person deciding.
      expect(c.original).toMatchObject({ storeId: O.north, storeName: 'North' });
      expect(c.proposed).toMatchObject({ storeId: O.south, storeName: 'South', ruleName: 'South campaign' });
      expect(c.detectedAt).toBeTruthy();
      expect(c.resolution).toBeNull();
      expect(c.conversation).toMatchObject({ id: conversationId, routingReviewRequired: true });
    });

    it('the conflict list never reaches across a tenant boundary', async () => {
      const { conversationId } = await makeConflict('tenant', '919440000007');
      const mine = await http().get('/crm/conversations/routing-conflicts').set(auth(hoToken));
      expect(mine.body.some((c: { conversationId: string }) => c.conversationId === conversationId)).toBe(true);

      // Asking for it by id from the other tenant must be indistinguishable from
      // it not existing — otherwise the filter is an existence oracle.
      const theirs = await http().get('/crm/conversations/routing-conflicts')
        .query({ conversationId }).set(auth(xToken));
      expect(theirs.status).toBe(200);
      expect(theirs.body).toEqual([]);
    });

    it('a salesperson cannot decide one', async () => {
      const { conflictId } = await makeConflict('rep', '919440000008');
      const res = await http().post(`/crm/conversations/routing-conflicts/${conflictId}/resolve`)
        .set(auth(northRepToken)).send({ decision: 'kept_original' });
      expect(res.status).toBe(403);
    });

    it('a manager from another branch cannot decide one about a thread they cannot open', async () => {
      const { conflictId } = await makeConflict('foreign', '919440000011');
      // South's manager has the rank, but the conversation is North's.
      const res = await http().post(`/crm/conversations/routing-conflicts/${conflictId}/resolve`)
        .set(auth(southMgrToken)).send({ decision: 'kept_original' });
      expect(res.status).toBe(404);
      const row = await prisma.conversationRoutingConflict.findUnique({ where: { id: conflictId } });
      expect(row!.resolution).toBeNull();
    });

    it('decision 1 — kept_original changes nothing and records the decision', async () => {
      const { conversationId, conflictId } = await makeConflict('keep', '919440000012');
      const before = await prisma.conversation.findUnique({
        where: { id: conversationId }, select: { storeId: true, assignedUserId: true },
      });

      const res = await http().post(`/crm/conversations/routing-conflicts/${conflictId}/resolve`)
        .set(auth(hoToken)).send({ decision: 'kept_original', note: 'Customer is ours' });
      expect(res.status).toBe(201);

      const after = await prisma.conversation.findUnique({
        where: { id: conversationId }, select: { storeId: true, assignedUserId: true, routingReviewRequired: true },
      });
      expect(after!.storeId).toBe(before!.storeId);
      expect(after!.assignedUserId).toBe(before!.assignedUserId);
      expect(after!.routingReviewRequired).toBe(false);

      const row = await prisma.conversationRoutingConflict.findUnique({ where: { id: conflictId } });
      expect(row!.resolution).toBe('kept_original');
      expect(row!.resolutionNote).toBe('Customer is ours');
      expect(row!.resolvedById).toBeTruthy();
      expect(row!.resolvedAt).toBeInstanceOf(Date);
    });

    it('decision 2 — accepted_proposed moves the thread to the proposed branch', async () => {
      const { conversationId, conflictId } = await makeConflict('accept', '919440000013');
      const res = await http().post(`/crm/conversations/routing-conflicts/${conflictId}/resolve`)
        .set(auth(hoToken)).send({ decision: 'accepted_proposed' });
      expect(res.status).toBe(201);

      const after = await prisma.conversation.findUnique({
        where: { id: conversationId }, select: { storeId: true, routingReviewRequired: true },
      });
      expect(after!.storeId).toBe(O.south);
      expect(after!.routingReviewRequired).toBe(false);
    });

    it('decision 3 — manual sets a destination that is neither side', async () => {
      const { conversationId, conflictId } = await makeConflict('manual', '919440000014');
      const res = await http().post(`/crm/conversations/routing-conflicts/${conflictId}/resolve`)
        .set(auth(hoToken))
        .send({ decision: 'manual', storeId: O.north, assignedUserId: northRepId, handling: 'human', note: 'Rep already knows them' });
      expect(res.status).toBe(201);

      const after = await prisma.conversation.findUnique({
        where: { id: conversationId },
        select: { storeId: true, assignedUserId: true, handling: true, routingReviewRequired: true },
      });
      expect(after).toMatchObject({
        storeId: O.north, assignedUserId: northRepId, handling: 'human', routingReviewRequired: false,
      });
    });

    it('a manual decision that the assignment rules refuse leaves the conflict OPEN', async () => {
      const { conversationId, conflictId } = await makeConflict('reject', '919440000015');
      // South's manager does not work at North.
      const res = await http().post(`/crm/conversations/routing-conflicts/${conflictId}/resolve`)
        .set(auth(hoToken)).send({ decision: 'manual', storeId: O.north, assignedUserId: southMgrId });
      expect(res.status).toBe(400);

      // The claim must have been released: a conflict recorded as decided over a
      // conversation that never moved is worse than an error.
      const row = await prisma.conversationRoutingConflict.findUnique({ where: { id: conflictId } });
      expect(row!.resolution).toBeNull();
      expect(row!.resolvedById).toBeNull();
      const convo = await prisma.conversation.findUnique({
        where: { id: conversationId }, select: { routingReviewRequired: true },
      });
      expect(convo!.routingReviewRequired).toBe(true);
    });

    it('two people deciding at the same instant produce ONE decision', async () => {
      const { conversationId, conflictId } = await makeConflict('race', '919440000016');
      const fire = () => http().post(`/crm/conversations/routing-conflicts/${conflictId}/resolve`)
        .set(auth(hoToken)).send({ decision: 'accepted_proposed' });

      const [a, b] = await Promise.all([fire(), fire()]);
      const statuses = [a.status, b.status].sort();
      // Exactly one winner. Without the compare-and-set both read `resolution:
      // null`, both passed, and both ran the assignment.
      expect(statuses).toEqual([201, 400]);

      const rows = await prisma.conversationRoutingConflict.findMany({ where: { id: conflictId } });
      expect(rows[0].resolution).toBe('accepted_proposed');
      const audits = await prisma.auditLog.count({
        where: { organisationId: O.org, action: 'conversation.routing_conflict_resolved', entityId: conversationId },
      });
      expect(audits).toBe(1);
    });

    it('a resolved conflict stays readable as history and cannot be decided again', async () => {
      const { conversationId, conflictId } = await makeConflict('history', '919440000017');
      await http().post(`/crm/conversations/routing-conflicts/${conflictId}/resolve`)
        .set(auth(hoToken)).send({ decision: 'kept_original', note: 'Stays with North' });

      // Not in the open queue any more...
      const open = await http().get('/crm/conversations/routing-conflicts')
        .query({ conversationId, state: 'open' }).set(auth(hoToken));
      expect(open.body).toHaveLength(0);

      // ...but still there, in full, for anyone reading the conversation.
      const all = await http().get('/crm/conversations/routing-conflicts')
        .query({ conversationId, state: 'all' }).set(auth(hoToken));
      const row = all.body.find((c: { id: string }) => c.id === conflictId);
      expect(row).toBeTruthy();
      expect(row.resolution).toBe('kept_original');
      expect(row.resolutionNote).toBe('Stays with North');
      expect(row.resolvedBy?.name).toBe('Head Office');

      // And a second decision is refused rather than overwriting the first.
      const again = await http().post(`/crm/conversations/routing-conflicts/${conflictId}/resolve`)
        .set(auth(hoToken)).send({ decision: 'accepted_proposed' });
      expect(again.status).toBe(400);
      const unchanged = await prisma.conversationRoutingConflict.findUnique({ where: { id: conflictId } });
      expect(unchanged!.resolution).toBe('kept_original');
    });

    it('the manager of the branch can read the routing history in the audit log', async () => {
      const { conversationId, conflictId } = await makeConflict('audit', '919440000018');
      await http().post(`/crm/conversations/routing-conflicts/${conflictId}/resolve`)
        .set(auth(hoToken)).send({ decision: 'kept_original' });

      // Audit reads only surface null-store rows to head office, so a routing row
      // written without a store was invisible to the one manager it concerned.
      const res = await http().get('/audit')
        .query({ entityType: 'Conversation', entityId: conversationId })
        .set(auth(northMgrToken));
      expect(res.status).toBe(200);
      expect(res.body.items.length).toBeGreaterThan(0);
    });
  });
});

/* ------------------------------------------------------------ helpers */

async function ingest(svc: ConversationsService, raw: ReturnType<typeof ctwa>, thread: string) {
  return svc.ingestInbound({
    organisationId: O.org, channel: 'whatsapp', externalThreadId: thread,
    externalId: raw.id, senderKind: 'whatsapp', senderValue: raw.from,
    body: raw.text.body, payload: raw as never, adReferral: extractMetaReferral(raw),
  });
}

/** An AuthUser for the service-level calls used to build fixtures. */
async function actor(prisma: PrismaService, email: string, allStores: boolean) {
  const u = await prisma.user.findFirst({ where: { email } });
  return {
    id: u!.id, email: u!.email, name: u!.name, role: u!.role,
    organisationId: O.org,
    storeIds: allStores ? [O.north, O.south] : [O.north],
    allStores,
  };
}

async function setRules(prisma: PrismaService, org: string, rules: unknown[]) {
  const o = await prisma.organisation.findUnique({ where: { id: org }, select: { settings: true } });
  await prisma.organisation.update({
    where: { id: org },
    data: { settings: { ...((o?.settings ?? {}) as object), crmAdSetRules: rules } as never },
  });
}

/**
 * Delete order is load-bearing: every FK here is RESTRICT by default, and a
 * teardown that throws leaves the Nest app open and hangs the whole run.
 */
async function teardown(prisma: PrismaService) {
  for (const org of [O.org, X.org]) {
    await prisma.jobTask.deleteMany({ where: { organisationId: org } }).catch(() => undefined);
    await prisma.leadQualification.deleteMany({ where: { organisationId: org } }).catch(() => undefined);
    await prisma.conversationRoutingConflict.deleteMany({ where: { organisationId: org } });
    await prisma.attributionTouch.deleteMany({ where: { organisationId: org } });
    await prisma.message.deleteMany({ where: { organisationId: org } });
    await prisma.conversation.deleteMany({ where: { organisationId: org } });
    await prisma.activityEvent.deleteMany({ where: { organisationId: org } }).catch(() => undefined);
    await prisma.lead.deleteMany({ where: { organisationId: org } });
    await prisma.contactPoint.deleteMany({ where: { organisationId: org } });
    await prisma.party.deleteMany({ where: { organisationId: org } });
    await prisma.auditLog.deleteMany({ where: { organisationId: org } });
    await prisma.userStore.deleteMany({ where: { store: { organisationId: org } } });
    await prisma.user.deleteMany({ where: { organisationId: org } });
    await prisma.store.deleteMany({ where: { organisationId: org } });
    await prisma.organisation.deleteMany({ where: { id: org } });
  }
}
