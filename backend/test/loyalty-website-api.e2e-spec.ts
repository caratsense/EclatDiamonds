import { INestApplication, ValidationPipe } from '@nestjs/common';
import { Test } from '@nestjs/testing';
import request = require('supertest');
import * as bcrypt from 'bcryptjs';

import type { PrismaService } from '../src/prisma/prisma.service';
import {
  SIGNATURE_HEADER,
  signWebhook,
  verifyWebhook,
} from '../src/loyalty/website/webhook-signature';

/**
 * The loyalty API a tenant's own website calls.
 *
 * FIXTURE-TESTED. No real website and no real provider is contacted anywhere in
 * this file. The inbound half is driven end to end against the application's own
 * container, which is the honest thing it can be: the caller is somebody's web
 * server and we are the far end, so there is nothing external to provision. The
 * OUTBOUND announcement is the one part that needs a reachable third party, and
 * it is exercised only against a deliberately unreachable URL — so what is
 * proven here is that it records its failure, not that it ever delivered.
 *
 * What each group of tests is defending:
 *
 *  1. THE KEY IS THE TENANT. A website key reaches exactly one organisation. A
 *     missing, wrong or rotated-away key reaches none, and no key can read
 *     another tenant's member however well-formed it is.
 *
 *  2. THE SERVER OWNS THE EARN RATE. The website reports the spend; CaratOS
 *     decides what it is worth. With no rate configured, earning is refused in a
 *     sentence rather than silently awarded at 1:1.
 *
 *  3. A RETRY IS NOT A SECOND TRANSACTION. This is the whole reason the
 *     endpoint takes an idempotency key: the caller is retrying across a network
 *     we do not control, and a replayed redeem is a real customer debited twice.
 *     Tested for the sequential replay AND for two concurrent identical calls,
 *     because only the second proves the database is the guard.
 *
 *  4. POINTS CANNOT BE OVERDRAWN, EVEN CONCURRENTLY. Two simultaneous redeems
 *     of the same balance: exactly one succeeds. An `if (balance >= points)`
 *     would let both through and nothing in the ledger would explain it.
 *
 *  5. A SALE IS REVERSED ONCE. The exact negation of what it gave, never twice,
 *     and a reversal is not itself reversible.
 *
 *  6. THE LEDGER IS THE TRUTH. Summing the signed points column equals the
 *     balance shown, every entry carries the balance that resulted, and the
 *     statement pages stably.
 *
 *  7. A SIGNATURE PROVES WHO AND WHEN. A perfect HMAC with a stale timestamp is
 *     refused, because a replayed `redeem` is a second debit and an observed
 *     request must not stay valid for ever.
 */

/**
 * Set before AppModule is imported, because ConfigService reads the environment
 * once at construction. Without a key, `CredentialCrypto` fails CLOSED and
 * refuses to store the signing secret — which is the behaviour we want in
 * production and would only look like a broken test here.
 */
process.env.CREDENTIAL_ENCRYPTION_KEY = Buffer.alloc(32, 11).toString('base64');
process.env.CREDENTIAL_ENCRYPTION_KEY_VERSION = '1';

const PASSWORD = 'password123';

const A = {
  org: 'org_loy_a',
  slug: 'loy-a',
  store: 'store_loy_a',
  ho: 'ho.loy@loy-a.local',
  mgr: 'mgr.loy@loy-a.local',
};
const B = {
  org: 'org_loy_b',
  slug: 'loy-b',
  store: 'store_loy_b',
  ho: 'ho.loy@loy-b.local',
};

const MEMBER = '9876500011';
const OTHER = '9876500022';
const B_MEMBER = '9876500033';
const STRANGER = '9811100099';

/** Reachable on no network. Used to prove a failed announcement is recorded. */
const DEAD_WEBHOOK = 'https://127.0.0.1:9/loyalty-hook';

async function teardown(prisma: PrismaService) {
  for (const org of [A.org, B.org]) {
    await prisma.loyaltyLedgerEntry.deleteMany({ where: { organisationId: org } });
    await prisma.loyaltyAccount.deleteMany({ where: { organisationId: org } });
    await prisma.integrationCredential.deleteMany({ where: { organisationId: org } });
    await prisma.integrationAsset.deleteMany({ where: { organisationId: org } });
    await prisma.integration.deleteMany({ where: { organisationId: org } });
    await prisma.auditLog.deleteMany({ where: { organisationId: org } });
    await prisma.party.deleteMany({ where: { organisationId: org } });
    await prisma.userStore.deleteMany({ where: { user: { organisationId: org } } });
    await prisma.user.deleteMany({ where: { organisationId: org } });
    await prisma.store.deleteMany({ where: { organisationId: org } });
    await prisma.organisation.deleteMany({ where: { id: org } });
  }
}

describe('Loyalty website API (e2e)', () => {
  let app: INestApplication;
  let prisma: PrismaService;

  let hoT: string;
  let mgrT: string;
  let hoBT: string;
  let keyA = '';
  let keyB = '';

  const server = () => app.getHttpServer();
  const auth = (t: string) => ({ Authorization: `Bearer ${t}` });
  const withKey = (k: string) => ({ 'x-caratos-loyalty-key': k });

  /** A fresh idempotency key. Long enough to satisfy the DTO's 16-char floor. */
  let seq = 0;
  const idem = (label: string) => `${label}-${(seq += 1).toString().padStart(4, '0')}-fixture`;

  beforeAll(async () => {
    const { AppModule } = await import('../src/app.module');
    const { PrismaService: P } = await import('../src/prisma/prisma.service');

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
    prisma = app.get(P);
    await teardown(prisma);

    const hash = await bcrypt.hash(PASSWORD, 10);
    for (const t of [A, B]) {
      await prisma.organisation.create({
        data: { id: t.org, name: t.slug, slug: t.slug, industryPackCode: 'jewellery' },
      });
      await prisma.store.create({
        data: {
          id: t.store,
          name: `${t.slug} main`,
          city: 'Mumbai',
          organisationId: t.org,
          timezone: 'Asia/Kolkata',
        },
      });
      // The integration row is what a key and a signing secret hang off. Created
      // directly: connecting it through the registry is that module's test.
      await prisma.integration.create({
        data: {
          organisationId: t.org,
          providerCode: 'loyalty_website',
          name: 'Website',
          status: 'connected',
        },
      });
    }
    for (const [id, email, org, role] of [
      ['u_loy_ho', A.ho, A.org, 'head_office'],
      ['u_loy_mgr', A.mgr, A.org, 'store_manager'],
      ['u_loy_ho_b', B.ho, B.org, 'head_office'],
    ] as const) {
      await prisma.user.create({
        data: {
          id,
          email,
          name: id,
          role: role as never,
          passwordHash: hash,
          isActive: true,
          approvalStatus: 'approved',
          organisationId: org,
          userStores: {
            create: { storeId: org === A.org ? A.store : B.store, isPrimary: true },
          },
        },
      });
    }

    const login = async (email: string) =>
      (
        await request(server()).post('/auth/login').send({ email, password: PASSWORD }).expect(201)
      ).body.token;
    hoT = await login(A.ho);
    mgrT = await login(A.mgr);
    hoBT = await login(B.ho);

    keyA = (
      await request(server()).post('/loyalty/programme/api-key').set(auth(hoT)).expect(201)
    ).body.key;
    keyB = (
      await request(server()).post('/loyalty/programme/api-key').set(auth(hoBT)).expect(201)
    ).body.key;
  }, 180_000);

  afterAll(async () => {
    if (prisma) await teardown(prisma);
    if (app) await app.close();
  });

  /* ===================================================== 1. the credential */

  describe('the key is the tenant', () => {
    it('refuses a request with no key at all', async () => {
      await request(server()).get(`/public/loyalty/members/${MEMBER}`).expect(403);
    });

    it('refuses a well-formed key that belongs to nobody', async () => {
      await request(server())
        .get(`/public/loyalty/members/${MEMBER}`)
        .set(withKey(`cs_loy_${'a'.repeat(48)}`))
        .expect(403);
    });

    it('shows the key exactly once and never again', async () => {
      const res = await request(server())
        .post('/loyalty/programme/api-key')
        .set(auth(hoBT))
        .expect(201);
      expect(res.body.key).toMatch(/^cs_loy_/);
      expect(res.body.keyPrefix).toBe(res.body.key.slice(0, 14));

      // Nothing readable by an admin screen contains the key itself.
      const integration = await prisma.integration.findFirst({
        where: { organisationId: B.org, providerCode: 'loyalty_website' },
        select: { config: true },
      });
      expect(JSON.stringify(integration?.config)).not.toContain(res.body.key);
      keyB = res.body.key;
    });

    it('stops accepting a key once it has been rotated away', async () => {
      const stale = keyA;
      const res = await request(server())
        .post('/loyalty/programme/api-key')
        .set(auth(hoT))
        .expect(201);
      keyA = res.body.key;

      await request(server())
        .get(`/public/loyalty/members/${MEMBER}`)
        .set(withKey(stale))
        .expect(403);
      await request(server())
        .get(`/public/loyalty/members/${MEMBER}`)
        .set(withKey(keyA))
        .expect(200);
    });

    it('will not let a store manager mint a website key', async () => {
      await request(server()).post('/loyalty/programme/api-key').set(auth(mgrT)).expect(403);
    });
  });

  /* ========================================================= 2. enrolment */

  describe('enrolment', () => {
    it('answers "not a member" rather than 404, because a website renders a join button for it', async () => {
      const res = await request(server())
        .get(`/public/loyalty/members/${STRANGER}`)
        .set(withKey(keyA))
        .expect(200);
      expect(res.body).toEqual({ enrolled: false, phone: STRANGER });
    });

    it('enrols a member and links the CRM customer when one is already on file', async () => {
      await prisma.party.create({
        data: {
          organisationId: A.org,
          storeId: A.store,
          name: 'Existing Customer',
          phone: MEMBER,
          types: ['customer'],
        },
      });

      const res = await request(server())
        .post('/public/loyalty/members')
        .set(withKey(keyA))
        .send({ phone: `+91 ${MEMBER}`, name: 'Existing Customer' })
        .expect(201);
      expect(res.body.created).toBe(true);
      // Normalised on the way in, so the website may send whatever shape it holds.
      expect(res.body.member.phone).toBe(MEMBER);
      expect(res.body.member.partyId).not.toBeNull();
      expect(res.body.member.pointsBalance).toBe(0);
    });

    it('treats a second join as the double-click it is, not a second membership', async () => {
      const res = await request(server())
        .post('/public/loyalty/members')
        .set(withKey(keyA))
        .send({ phone: MEMBER, name: 'Existing Customer' })
        .expect(201);
      expect(res.body.created).toBe(false);

      const count = await prisma.loyaltyAccount.count({
        where: { organisationId: A.org, phone: MEMBER },
      });
      expect(count).toBe(1);
    });

    it('refuses a number that is not a mobile number', async () => {
      await request(server())
        .post('/public/loyalty/members')
        .set(withKey(keyA))
        .send({ phone: '12345' })
        .expect(400);
    });
  });

  /* ====================================== 3. the server owns the earn rate */

  describe('the earn rate belongs to the business, not the website', () => {
    it('refuses to award points before a rate has been set, and says so', async () => {
      const res = await request(server())
        .post('/public/loyalty/earn')
        .set(withKey(keyA))
        .send({ phone: MEMBER, amount: 2550, idempotencyKey: idem('early-earn') })
        .expect(400);
      expect(String(res.body.message)).toContain('No earn rate is configured');
    });

    it('will not store half an earn rate', async () => {
      const res = await request(server())
        .put('/loyalty/programme/settings')
        .set(auth(hoT))
        .send({ earnPoints: 1 })
        .expect(400);
      expect(String(res.body.message)).toContain('both halves');
    });

    it('refuses a plain-http announcement URL, because a movement is customer data', async () => {
      await request(server())
        .put('/loyalty/programme/settings')
        .set(auth(hoT))
        .send({ earnPoints: 1, earnPerAmount: 100, webhookUrl: 'http://example.test/hook' })
        .expect(400);
    });

    it('accepts a complete rate', async () => {
      const res = await request(server())
        .put('/loyalty/programme/settings')
        .set(auth(hoT))
        .send({
          earnPoints: 1,
          earnPerAmount: 100,
          redeemValuePerPoint: 0.5,
          minRedeemPoints: 50,
          maxRedeemPointsPerTransaction: 500,
        })
        .expect(200);
      expect(res.body.configured).toBe(true);
      expect(res.body.earnPoints).toBe(1);
    });

    it('will not let a store manager change the rate', async () => {
      await request(server())
        .put('/loyalty/programme/settings')
        .set(auth(mgrT))
        .send({ earnPoints: 99, earnPerAmount: 1 })
        .expect(403);
    });

    it('floors the points, because rounding up pays for money nobody spent', async () => {
      const res = await request(server())
        .post('/public/loyalty/earn')
        .set(withKey(keyA))
        .send({
          phone: MEMBER,
          amount: 2550,
          idempotencyKey: idem('earn-floor'),
          reference: 'INV-1001',
        })
        .expect(200);
      // 2550 / 100 = 25.5 → 25, not 26.
      expect(res.body.points).toBe(25);
      expect(res.body.balance).toBe(25);
    });

    it('refuses a spend too small to earn anything, rather than writing a zero-point line', async () => {
      const res = await request(server())
        .post('/public/loyalty/earn')
        .set(withKey(keyA))
        .send({ phone: MEMBER, amount: 40, idempotencyKey: idem('earn-tiny') })
        .expect(400);
      expect(String(res.body.message)).toContain('earns no points');
    });
  });

  /* =========================================== 4. a retry is not a purchase */

  describe('idempotency', () => {
    const key = 'replay-key-0001-fixture';

    it('awards the points the first time', async () => {
      const res = await request(server())
        .post('/public/loyalty/earn')
        .set(withKey(keyA))
        .send({ phone: MEMBER, amount: 1000, idempotencyKey: key })
        .expect(200);
      expect(res.body.idempotent).toBe(false);
      expect(res.body.points).toBe(10);
      expect(res.body.balance).toBe(35);
    });

    it('returns the SAME movement on a replay, and the balance does not move', async () => {
      const res = await request(server())
        .post('/public/loyalty/earn')
        .set(withKey(keyA))
        // A retry may legitimately carry a different amount if the caller is
        // confused; the key decides, because the key is what identifies the
        // attempt. Answering with the original is the only safe reading.
        .send({ phone: MEMBER, amount: 9999, idempotencyKey: key })
        .expect(200);
      expect(res.body.idempotent).toBe(true);
      expect(res.body.points).toBe(10);
      expect(res.body.balance).toBe(35);

      const entries = await prisma.loyaltyLedgerEntry.count({
        where: { organisationId: A.org, idempotencyKey: key },
      });
      expect(entries).toBe(1);
    });

    it('writes exactly one entry when two identical calls arrive at once', async () => {
      const concurrent = 'concurrent-earn-0001-fixture';
      const results = await Promise.all(
        Array.from({ length: 4 }, () =>
          request(server())
            .post('/public/loyalty/earn')
            .set(withKey(keyA))
            .send({ phone: MEMBER, amount: 500, idempotencyKey: concurrent }),
        ),
      );
      // Every call answers 200 — a retry is not an error — and exactly one of
      // them created the entry.
      expect(results.every((r) => r.status === 200)).toBe(true);
      expect(results.filter((r) => r.body.idempotent === false)).toHaveLength(1);

      const entries = await prisma.loyaltyLedgerEntry.count({
        where: { organisationId: A.org, idempotencyKey: concurrent },
      });
      expect(entries).toBe(1);

      const account = await prisma.loyaltyAccount.findUnique({
        where: { organisationId_phone: { organisationId: A.org, phone: MEMBER } },
      });
      // 35 + 5, once.
      expect(account?.pointsBalance).toBe(40);
    });

    it('refuses a movement with no idempotency key, because the hurried caller retries hardest', async () => {
      await request(server())
        .post('/public/loyalty/earn')
        .set(withKey(keyA))
        .send({ phone: MEMBER, amount: 1000 })
        .expect(400);
      await request(server())
        .post('/public/loyalty/earn')
        .set(withKey(keyA))
        .send({ phone: MEMBER, amount: 1000, idempotencyKey: '1' })
        .expect(400);
    });
  });

  /* ================================================= 5. redemption limits */

  describe('redemption', () => {
    it('refuses a redemption below the programme floor', async () => {
      const res = await request(server())
        .post('/public/loyalty/redeem')
        .set(withKey(keyA))
        .send({ phone: MEMBER, points: 10, idempotencyKey: idem('too-small') })
        .expect(400);
      expect(String(res.body.message)).toContain('50 points upwards');
    });

    it('refuses more than the per-transaction cap', async () => {
      await request(server())
        .post('/public/loyalty/redeem')
        .set(withKey(keyA))
        .send({ phone: MEMBER, points: 501, idempotencyKey: idem('too-big') })
        .expect(400);
    });

    it('refuses to overdraw, and says what is actually available', async () => {
      const res = await request(server())
        .post('/public/loyalty/redeem')
        .set(withKey(keyA))
        .send({ phone: MEMBER, points: 500, idempotencyKey: idem('overdraw') })
        .expect(400);
      expect(String(res.body.message)).toContain('40 available');
    });

    it('spends the points and reports what they were worth in money', async () => {
      const res = await request(server())
        .post('/public/loyalty/redeem')
        .set(withKey(keyA))
        .send({ phone: MEMBER, points: 50, idempotencyKey: idem('spend') })
        .expect(400);
      // Only 40 on the account: prove the guard, then top up and spend properly.
      expect(res.status).toBe(400);

      await request(server())
        .post('/public/loyalty/earn')
        .set(withKey(keyA))
        .send({ phone: MEMBER, amount: 10_000, idempotencyKey: idem('top-up') })
        .expect(200);

      const spend = await request(server())
        .post('/public/loyalty/redeem')
        .set(withKey(keyA))
        .send({ phone: MEMBER, points: 100, idempotencyKey: idem('spend-ok') })
        .expect(200);
      expect(spend.body.points).toBe(-100);
      // 0.5 per point.
      expect(spend.body.discountValue).toBe(50);
      expect(spend.body.balance).toBe(40);
    });

    it('lets exactly one of two simultaneous redemptions of the whole balance through', async () => {
      // Topped up here rather than inherited from an earlier test: a race test
      // that depends on somebody else's arithmetic fails for the wrong reason.
      await request(server())
        .post('/public/loyalty/earn')
        .set(withKey(keyA))
        .send({ phone: MEMBER, amount: 20_000, idempotencyKey: idem('race-top-up') })
        .expect(200);

      const account = await prisma.loyaltyAccount.findUnique({
        where: { organisationId_phone: { organisationId: A.org, phone: MEMBER } },
      });
      const balance = account!.pointsBalance;
      expect(balance).toBeGreaterThanOrEqual(50);

      const [first, second] = await Promise.all([
        request(server())
          .post('/public/loyalty/redeem')
          .set(withKey(keyA))
          .send({ phone: MEMBER, points: balance, idempotencyKey: idem('race-a') }),
        request(server())
          .post('/public/loyalty/redeem')
          .set(withKey(keyA))
          .send({ phone: MEMBER, points: balance, idempotencyKey: idem('race-b') }),
      ]);

      const codes = [first.status, second.status].sort();
      expect(codes).toEqual([200, 400]);

      const after = await prisma.loyaltyAccount.findUnique({
        where: { organisationId_phone: { organisationId: A.org, phone: MEMBER } },
      });
      // Never negative. Two `if (balance >= points)` checks would both pass.
      expect(after?.pointsBalance).toBe(0);
    });
  });

  /* ================================================ 6. reversal, once only */

  describe('reversal', () => {
    const earnKey = 'reversible-earn-01-fixture';

    it('takes back exactly the points the sale gave', async () => {
      await request(server())
        .post('/public/loyalty/earn')
        .set(withKey(keyA))
        .send({
          phone: MEMBER,
          amount: 3000,
          idempotencyKey: earnKey,
          reference: 'INV-CANCELLED',
        })
        .expect(200);

      const before = await prisma.loyaltyAccount.findUnique({
        where: { organisationId_phone: { organisationId: A.org, phone: MEMBER } },
      });

      const res = await request(server())
        .post('/public/loyalty/reverse')
        .set(withKey(keyA))
        .send({
          idempotencyKey: idem('reversal'),
          originalIdempotencyKey: earnKey,
          reason: 'Sale cancelled',
        })
        .expect(200);
      // The EXACT negation of what that sale gave, whatever the balance is now
      // and whatever the rate has since become.
      expect(res.body.points).toBe(-30);
      expect(res.body.balance).toBe(before!.pointsBalance - 30);
    });

    it('refuses a second reversal of the same sale', async () => {
      const res = await request(server())
        .post('/public/loyalty/reverse')
        .set(withKey(keyA))
        .send({ idempotencyKey: idem('reversal-again'), originalIdempotencyKey: earnKey })
        .expect(400);
      expect(String(res.body.message)).toContain('already been reversed');
    });

    it('takes the points back even when the customer has already spent them', async () => {
      const clawback = 'clawback-earn-001-fixture';
      await request(server())
        .post('/public/loyalty/earn')
        .set(withKey(keyA))
        .send({ phone: MEMBER, amount: 6000, idempotencyKey: clawback })
        .expect(200);

      // Spend everything, so reversing has to overdraw.
      const account = await prisma.loyaltyAccount.findUnique({
        where: { organisationId_phone: { organisationId: A.org, phone: MEMBER } },
      });
      await request(server())
        .post('/public/loyalty/redeem')
        .set(withKey(keyA))
        .send({
          phone: MEMBER,
          points: account!.pointsBalance,
          idempotencyKey: idem('spend-the-lot'),
        })
        .expect(200);

      const res = await request(server())
        .post('/public/loyalty/reverse')
        .set(withKey(keyA))
        .send({
          idempotencyKey: idem('clawback'),
          originalIdempotencyKey: clawback,
          reason: 'Sale cancelled after the points were spent',
        })
        .expect(200);
      // Negative on purpose: that is what a clawback is, and refusing it would
      // leave a ledger that cannot show the sale was cancelled.
      expect(res.body.balance).toBe(-60);

      // And the ordinary guard now does its job — nothing more can be spent.
      const blocked = await request(server())
        .post('/public/loyalty/redeem')
        .set(withKey(keyA))
        .send({ phone: MEMBER, points: 50, idempotencyKey: idem('after-clawback') })
        .expect(400);
      expect(String(blocked.body.message)).toContain('available');

      // Put the account back in credit for the tests that follow.
      await request(server())
        .post('/public/loyalty/earn')
        .set(withKey(keyA))
        .send({ phone: MEMBER, amount: 20_000, idempotencyKey: idem('restore') })
        .expect(200);
    });

    it('refuses to reverse a reversal', async () => {
      const reversal = await prisma.loyaltyLedgerEntry.findFirst({
        where: { organisationId: A.org, kind: 'reversal' },
      });
      const res = await request(server())
        .post('/public/loyalty/reverse')
        .set(withKey(keyA))
        .send({ idempotencyKey: idem('double-reverse'), entryId: reversal!.id })
        .expect(400);
      expect(String(res.body.message)).toContain('cannot itself be reversed');
    });

    it('refuses a reversal that names nothing', async () => {
      await request(server())
        .post('/public/loyalty/reverse')
        .set(withKey(keyA))
        .send({ idempotencyKey: idem('nothing-named') })
        .expect(400);
    });

    it('does not count a reversal as lifetime redemption', async () => {
      const account = await prisma.loyaltyAccount.findUnique({
        where: { organisationId_phone: { organisationId: A.org, phone: MEMBER } },
      });
      // Reversing an earn is not the customer spending anything, and counting it
      // as such would overstate every redemption report the business runs.
      const redeemed = await prisma.loyaltyLedgerEntry.aggregate({
        where: { organisationId: A.org, accountId: account!.id, kind: 'redeem' },
        _sum: { points: true },
      });
      expect(account?.lifetimeRedeemed).toBe(-(redeemed._sum.points ?? 0));
    });
  });

  /* ======================================================= 7. the ledger */

  describe('the ledger is the truth', () => {
    it('sums to the balance it reports', async () => {
      const res = await request(server())
        .get(`/public/loyalty/members/${MEMBER}/ledger`)
        .set(withKey(keyA))
        .query({ limit: 100 })
        .expect(200);

      const sum = res.body.entries.reduce(
        (acc: number, e: { points: number }) => acc + e.points,
        0,
      );
      expect(sum).toBe(res.body.balance);
    });

    it('carries the balance that resulted on every line, so a statement prints without re-summing', async () => {
      const res = await request(server())
        .get(`/public/loyalty/members/${MEMBER}/ledger`)
        .set(withKey(keyA))
        .query({ limit: 100 })
        .expect(200);

      // Walk it oldest-first and rebuild.
      const oldestFirst = [...res.body.entries].reverse();
      let running = 0;
      for (const entry of oldestFirst) {
        running += entry.points;
        expect(entry.balanceAfter).toBe(running);
      }
    });

    it('pages stably, so a reconciling caller cannot skip an entry', async () => {
      const first = await request(server())
        .get(`/public/loyalty/members/${MEMBER}/ledger`)
        .set(withKey(keyA))
        .query({ limit: 2 })
        .expect(200);
      expect(first.body.entries).toHaveLength(2);
      expect(first.body.nextCursor).toBeTruthy();

      const second = await request(server())
        .get(`/public/loyalty/members/${MEMBER}/ledger`)
        .set(withKey(keyA))
        .query({ limit: 2, cursor: first.body.nextCursor })
        .expect(200);

      const ids = new Set(first.body.entries.map((e: { id: string }) => e.id));
      for (const entry of second.body.entries) expect(ids.has(entry.id)).toBe(false);
    });

    it('404s a statement for somebody who is not a member', async () => {
      await request(server())
        .get(`/public/loyalty/members/${STRANGER}/ledger`)
        .set(withKey(keyA))
        .expect(404);
    });
  });

  /* ================================================= 8. tenant isolation */

  describe('one tenant cannot see another', () => {
    it('cannot look up a member of another organisation', async () => {
      await request(server())
        .post('/public/loyalty/members')
        .set(withKey(keyB))
        .send({ phone: B_MEMBER, name: 'B customer' })
        .expect(201);

      // B's member, asked for with A's key.
      const res = await request(server())
        .get(`/public/loyalty/members/${B_MEMBER}`)
        .set(withKey(keyA))
        .expect(200);
      expect(res.body.enrolled).toBe(false);
    });

    it('cannot move points for another organisation’s member', async () => {
      await request(server())
        .post('/public/loyalty/earn')
        .set(withKey(keyA))
        .send({ phone: B_MEMBER, amount: 5000, idempotencyKey: idem('cross-tenant') })
        .expect(404);
    });

    it('cannot file a movement against another organisation’s branch', async () => {
      const res = await request(server())
        .post('/public/loyalty/earn')
        .set(withKey(keyA))
        .send({
          phone: MEMBER,
          amount: 5000,
          storeId: B.store,
          idempotencyKey: idem('cross-store'),
        })
        .expect(400);
      expect(String(res.body.message)).toContain('does not belong to this organisation');
    });

    it('keeps each tenant’s earn rate to itself', async () => {
      // B never configured one, so B's website still cannot earn even though A's
      // is fully set up.
      const res = await request(server())
        .post('/public/loyalty/earn')
        .set(withKey(keyB))
        .send({ phone: B_MEMBER, amount: 5000, idempotencyKey: idem('b-earn') })
        .expect(400);
      expect(String(res.body.message)).toContain('No earn rate is configured');
    });
  });

  /* ============================================== 9. the counter's own door */

  describe('movements made inside CaratOS', () => {
    it('shares the ledger with the website, rather than keeping a second one', async () => {
      await request(server())
        .post('/loyalty/programme/movements')
        .set(auth(mgrT))
        .send({ phone: MEMBER, kind: 'earn', amount: 5000, reference: 'COUNTER-1' })
        .expect(201);

      const entry = await prisma.loyaltyLedgerEntry.findFirst({
        where: { organisationId: A.org, reference: 'COUNTER-1' },
      });
      expect(entry?.source).toBe('store');
      expect(entry?.actorType).toBe('user');
      expect(entry?.points).toBe(50);
      // No idempotency key: there is no network between the counter and here to
      // retry across, and NULLs are distinct so the index does not object.
      expect(entry?.idempotencyKey).toBeNull();
    });

    it('will not let a store manager adjust a balance by hand', async () => {
      const res = await request(server())
        .post('/loyalty/programme/movements')
        .set(auth(mgrT))
        .send({ phone: MEMBER, kind: 'adjustment', points: 1000, reason: 'Goodwill' })
        .expect(403);
      expect(String(res.body.message)).toContain('Only head office');
    });

    it('refuses an adjustment with no reason, because it could not be defended later', async () => {
      await request(server())
        .post('/loyalty/programme/movements')
        .set(auth(hoT))
        .send({ phone: MEMBER, kind: 'adjustment', points: 1000 })
        .expect(400);
    });

    it('records a head-office adjustment in the audit log', async () => {
      const res = await request(server())
        .post('/loyalty/programme/movements')
        .set(auth(hoT))
        .send({
          phone: MEMBER,
          kind: 'adjustment',
          points: 100,
          reason: 'Goodwill after a delayed repair',
        })
        .expect(201);

      const log = await prisma.auditLog.findFirst({
        where: {
          organisationId: A.org,
          action: 'loyalty.points_adjustment',
          entityId: res.body.entryId,
        },
      });
      expect(log).toBeTruthy();
      expect(log?.summary).toContain('Goodwill');
    });

    it('cannot move the points of a suspended membership', async () => {
      await prisma.loyaltyAccount.update({
        where: { organisationId_phone: { organisationId: A.org, phone: MEMBER } },
        data: { status: 'suspended' },
      });
      const res = await request(server())
        .post('/public/loyalty/earn')
        .set(withKey(keyA))
        .send({ phone: MEMBER, amount: 5000, idempotencyKey: idem('suspended') })
        .expect(400);
      expect(String(res.body.message)).toContain('suspended');

      await prisma.loyaltyAccount.update({
        where: { organisationId_phone: { organisationId: A.org, phone: MEMBER } },
        data: { status: 'active' },
      });
    });

    it('lists members including the ones who joined online with no branch', async () => {
      await request(server())
        .post('/public/loyalty/members')
        .set(withKey(keyA))
        .send({ phone: OTHER, name: 'Online Only' })
        .expect(201);
      await prisma.loyaltyAccount.update({
        where: { organisationId_phone: { organisationId: A.org, phone: OTHER } },
        data: { storeId: null },
      });

      const res = await request(server())
        .get('/loyalty/programme/members')
        .set(auth(mgrT))
        .expect(200);
      expect(res.body.map((m: { phone: string }) => m.phone)).toContain(OTHER);
    });

    it('searches members by name without losing the branch filter', async () => {
      const res = await request(server())
        .get('/loyalty/programme/members')
        .set(auth(mgrT))
        .query({ q: 'Online' })
        .expect(200);
      expect(res.body).toHaveLength(1);
      expect(res.body[0].phone).toBe(OTHER);
    });
  });

  /* =============================================== 10. the signed webhook */

  describe('webhook signing', () => {
    const secret = 'a-fixture-signing-secret';
    const body = JSON.stringify({ event: 'loyalty.movement', points: 25 });

    it('verifies what it signed', () => {
      const at = new Date('2026-09-12T10:00:00Z');
      const signed = signWebhook(secret, body, at);
      expect(signed.signature).toMatch(/^t=\d+,v1=[0-9a-f]{64}$/);
      expect(verifyWebhook(secret, body, signed.signature, { now: at })).toEqual({
        valid: true,
        timestamp: signed.timestamp,
      });
    });

    it('refuses a body that changed by one character', () => {
      const at = new Date('2026-09-12T10:00:00Z');
      const signed = signWebhook(secret, body, at);
      const result = verifyWebhook(secret, body.replace('25', '26'), signed.signature, {
        now: at,
      });
      expect(result).toMatchObject({ valid: false, code: 'signature_mismatch' });
    });

    it('refuses the wrong secret', () => {
      const at = new Date('2026-09-12T10:00:00Z');
      const signed = signWebhook(secret, body, at);
      expect(verifyWebhook('not-the-secret', body, signed.signature, { now: at })).toMatchObject({
        valid: false,
        code: 'signature_mismatch',
      });
    });

    it('refuses a perfect signature that is too old to be fresh', () => {
      const signedAt = new Date('2026-09-12T10:00:00Z');
      const signed = signWebhook(secret, body, signedAt);
      // Ten minutes later. The HMAC is still arithmetically correct — this is
      // exactly the replay the timestamp exists to stop.
      const result = verifyWebhook(secret, body, signed.signature, {
        now: new Date('2026-09-12T10:10:00Z'),
      });
      expect(result).toMatchObject({ valid: false, code: 'timestamp_out_of_range' });
      expect((result as { reason: string }).reason).toContain('in the past');
    });

    it('refuses a timestamp from the future, so a wrong clock cannot mint long-lived requests', () => {
      const signed = signWebhook(secret, body, new Date('2026-09-12T10:10:00Z'));
      const result = verifyWebhook(secret, body, signed.signature, {
        now: new Date('2026-09-12T10:00:00Z'),
      });
      expect(result).toMatchObject({ valid: false, code: 'timestamp_out_of_range' });
      expect((result as { reason: string }).reason).toContain('in the future');
    });

    it('names the failure it actually hit, because "invalid signature" has three different fixes', () => {
      expect(verifyWebhook(secret, body, undefined)).toMatchObject({ code: 'missing_header' });
      expect(verifyWebhook(secret, body, 'garbage')).toMatchObject({ code: 'malformed_header' });
      expect(verifyWebhook(secret, body, 't=1789171200')).toMatchObject({
        code: 'no_known_scheme',
      });
    });

    it('accepts either signature while a secret is being rotated', () => {
      const at = new Date('2026-09-12T10:00:00Z');
      const oldSig = signWebhook('old-secret', body, at).signature;
      const newSig = signWebhook('new-secret', body, at).signature;
      // A sender signing with both publishes two v1 values in one header.
      const both = `${oldSig},${newSig.split(',')[1]}`;
      expect(verifyWebhook('new-secret', body, both, { now: at }).valid).toBe(true);
      expect(verifyWebhook('old-secret', body, both, { now: at }).valid).toBe(true);
      expect(verifyWebhook('third-secret', body, both, { now: at }).valid).toBe(false);
    });

    it('refuses to sign with an empty secret rather than producing a signature nobody can trust', () => {
      expect(() => signWebhook('', body)).toThrow(/empty secret/);
    });

    it('exposes the header name it uses, so a settings screen need not hardcode it', () => {
      expect(SIGNATURE_HEADER).toBe('x-caratos-signature');
    });
  });

  /* ========================================== 11. announcement honesty */

  describe('announcing a movement', () => {
    it('marks a movement as needing no announcement when the tenant has set no URL', async () => {
      const res = await request(server())
        .post('/public/loyalty/earn')
        .set(withKey(keyA))
        .send({ phone: OTHER, amount: 1000, idempotencyKey: idem('no-url') })
        .expect(200);

      // The announcement runs after the response, so allow it to land.
      await waitFor(async () => {
        const entry = await prisma.loyaltyLedgerEntry.findUnique({
          where: { id: res.body.entryId },
        });
        return entry?.webhookedAt != null;
      });
      const entry = await prisma.loyaltyLedgerEntry.findUnique({
        where: { id: res.body.entryId },
      });
      // Not retried for ever: the tenant chose to pull the ledger rather than be
      // pushed to.
      expect(entry?.webhookError).toBeNull();
    });

    it('does not clear the earn rate when only the webhook URL is set', async () => {
      await request(server())
        .put('/loyalty/programme/settings')
        .set(auth(hoT))
        .send({ webhookUrl: DEAD_WEBHOOK })
        .expect(200);

      const res = await request(server())
        .get('/loyalty/programme/settings')
        .set(auth(hoT))
        .expect(200);
      // A body carrying one field arrives with every other declared property
      // present and undefined. Spreading that over the stored settings would
      // switch earning off for the whole tenant as a side effect of saving a URL.
      expect(res.body.earnPoints).toBe(1);
      expect(res.body.earnPerAmount).toBe(100);
      expect(res.body.minRedeemPoints).toBe(50);
      expect(res.body.configured).toBe(true);
      expect(res.body.webhookUrl).toBe(DEAD_WEBHOOK);
    });

    it('clears a field only when it is sent as an explicit null', async () => {
      await request(server())
        .put('/loyalty/programme/settings')
        .set(auth(hoT))
        .send({ maxRedeemPointsPerTransaction: null })
        .expect(200);
      const res = await request(server())
        .get('/loyalty/programme/settings')
        .set(auth(hoT))
        .expect(200);
      expect(res.body.maxRedeemPointsPerTransaction).toBeNull();
      expect(res.body.earnPoints).toBe(1);
    });

    it('records WHY an announcement failed instead of quietly claiming delivery', async () => {

      const res = await request(server())
        .post('/public/loyalty/earn')
        .set(withKey(keyA))
        .send({ phone: OTHER, amount: 1000, idempotencyKey: idem('dead-hook') })
        .expect(200);

      await waitFor(async () => {
        const entry = await prisma.loyaltyLedgerEntry.findUnique({
          where: { id: res.body.entryId },
        });
        return (entry?.webhookAttempts ?? 0) > 0;
      }, 15_000);

      const entry = await prisma.loyaltyLedgerEntry.findUnique({
        where: { id: res.body.entryId },
      });
      expect(entry?.webhookedAt).toBeNull();
      expect(entry?.webhookError).toBeTruthy();
      // No signing secret was ever issued for A, so that is the honest reason —
      // and it names the fix.
      expect(entry?.webhookError).toContain('signing secret');

      // The POINTS still moved. An unreachable website must never be the reason
      // a customer's purchase does not earn.
      expect(res.body.points).toBe(10);
    });

    it('retries on demand and reports what it managed, not what it hoped', async () => {
      const res = await request(server())
        .post('/loyalty/programme/announcements/retry')
        .set(auth(hoT))
        .expect(200);
      expect(res.body.sent).toBe(0);
      expect(res.body.failed).toBeGreaterThan(0);
      expect(res.body.considered).toBeGreaterThanOrEqual(res.body.failed);
    });

    it('gives up after a bounded number of attempts rather than hammering for ever', async () => {
      const { WEBHOOK_MAX_ATTEMPTS } = await import(
        '../src/loyalty/website/loyalty-api.service'
      );
      const entry = await prisma.loyaltyLedgerEntry.findFirst({
        where: { organisationId: A.org, webhookedAt: null, webhookError: { not: null } },
      });
      await prisma.loyaltyLedgerEntry.update({
        where: { id: entry!.id },
        data: { webhookAttempts: WEBHOOK_MAX_ATTEMPTS },
      });

      const res = await request(server())
        .post('/loyalty/programme/announcements/retry')
        .set(auth(hoT))
        .expect(200);
      const ids = await prisma.loyaltyLedgerEntry.findMany({
        where: { organisationId: A.org, webhookAttempts: { lt: WEBHOOK_MAX_ATTEMPTS }, webhookedAt: null },
        select: { id: true },
      });
      expect(res.body.considered).toBe(ids.length);
    });

    it('issues a signing secret, encrypted, and shows it exactly once', async () => {
      const res = await request(server())
        .post('/loyalty/programme/signing-secret')
        .set(auth(hoT))
        .expect(201);
      expect(res.body.secret).toBeTruthy();
      expect(res.body.header).toBe(SIGNATURE_HEADER);

      const credential = await prisma.integrationCredential.findFirst({
        where: { organisationId: A.org, kind: 'shared_secret' },
      });
      expect(credential).toBeTruthy();
      // Encrypted at rest, context-bound. Never the plaintext.
      expect(credential?.ciphertext).not.toContain(res.body.secret);
      expect(credential?.ciphertext.startsWith('aad1:')).toBe(true);
    });
  });
});

/** Poll until `check` is true, or give up. For work started after a response. */
async function waitFor(check: () => Promise<boolean>, timeoutMs = 10_000): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (await check()) return;
    await new Promise((r) => setTimeout(r, 100));
  }
}
