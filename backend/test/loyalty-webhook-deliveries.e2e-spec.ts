import { INestApplication, ValidationPipe } from '@nestjs/common';
import { Test } from '@nestjs/testing';
import request = require('supertest');
import * as bcrypt from 'bcryptjs';
import * as http from 'node:http';
import type { AddressInfo } from 'node:net';
import { createHash } from 'node:crypto';

import type { PrismaService } from '../src/prisma/prisma.service';
import type { JobsService } from '../src/jobs/jobs.service';
import type { LoyaltyApiService } from '../src/loyalty/website/loyalty-api.service';
import { SIGNATURE_HEADER, verifyWebhook } from '../src/loyalty/website/webhook-signature';

/**
 * The loyalty announcement delivery log.
 *
 * REAL HTTP, NO FAKE PROVIDER. The tenant's website is a node http server on
 * 127.0.0.1 in this process, answering whatever status the test sets. Every
 * "delivered" below is a 2xx that server actually returned; every "failed" is a
 * non-2xx it actually returned. The queue is driven by calling its own drain, and
 * a backoff is skipped by moving the queue row's runAt — the schedule, not the
 * outcome.
 *
 * The URL is written straight into the integration config because the settings
 * endpoint (rightly) refuses anything but https, and a loopback test server has
 * no certificate. That refusal has its own test in loyalty-website-api.
 *
 *  1. DELIVERED MEANS A 2xx. Signed, with a stable event id, and a digest of the
 *     exact bytes sent.
 *  2. A REPLAY IS NOT A SECOND DELIVERY. Queuing the same movement again, or
 *     replaying the purchase, creates no record and no request.
 *  3. A NON-2xx IS FAILED, THEN DEAD after the last attempt — never delivered.
 *  4. RETRYING A DEAD EVENT RE-QUEUES IT ONCE, however many people press it.
 *  5. ANOTHER TENANT SEES NOTHING, and a store manager can read but not retry.
 *  6. NO SECRET LEAVES — not ours, not the API key, not the receiver's token.
 */

process.env.CREDENTIAL_ENCRYPTION_KEY = Buffer.alloc(32, 7).toString('base64');
process.env.CREDENTIAL_ENCRYPTION_KEY_VERSION = '1';
// The minute drain must not race the test's own.
process.env.SCHEDULER_ENABLED = 'false';

const PASSWORD = 'password123';
const A = { org: 'org_lwd_a', slug: 'lwd-a', store: 'store_lwd_a', ho: 'ho@lwd-a.local', mgr: 'mgr@lwd-a.local' };
const B = { org: 'org_lwd_b', slug: 'lwd-b', store: 'store_lwd_b', ho: 'ho@lwd-b.local' };
const MEMBER = '9876511111';
/** The receiver's own token, as a real website would put in its hook URL. */
const RECEIVER_TOKEN = 'receiver-token-9f2c41';

async function teardown(prisma: PrismaService) {
  for (const org of [A.org, B.org]) {
    await prisma.jobTask.deleteMany({ where: { organisationId: org } });
    await prisma.loyaltyWebhookDelivery.deleteMany({ where: { organisationId: org } });
    await prisma.loyaltyLedgerEntry.deleteMany({ where: { organisationId: org } });
    await prisma.loyaltyAccount.deleteMany({ where: { organisationId: org } });
    await prisma.integrationCredential.deleteMany({ where: { organisationId: org } });
    await prisma.integration.deleteMany({ where: { organisationId: org } });
    await prisma.auditLog.deleteMany({ where: { organisationId: org } });
    await prisma.userStore.deleteMany({ where: { user: { organisationId: org } } });
    await prisma.user.deleteMany({ where: { organisationId: org } });
    await prisma.store.deleteMany({ where: { organisationId: org } });
    await prisma.organisation.deleteMany({ where: { id: org } });
  }
}

describe('Loyalty webhook delivery log (e2e)', () => {
  let app: INestApplication;
  let prisma: PrismaService;
  let jobs: JobsService;
  let loyaltyApi: LoyaltyApiService;

  let hoT = '';
  let mgrT = '';
  let hoBT = '';
  let keyA = '';
  let secretA = '';

  // ── The tenant's website ──────────────────────────────────────────────────
  const received: { headers: http.IncomingHttpHeaders; body: string }[] = [];
  let answer = 204;
  const hook = http.createServer((req, res) => {
    const chunks: Buffer[] = [];
    req.on('data', (c: Buffer) => chunks.push(c));
    req.on('end', () => {
      received.push({ headers: req.headers, body: Buffer.concat(chunks).toString('utf8') });
      res.statusCode = answer;
      res.end(answer >= 300 ? 'the receiver refused this' : '');
    });
  });
  const requestsFor = (eventId: string) =>
    received.filter((r) => r.headers['x-caratos-event-id'] === eventId);

  const server = () => app.getHttpServer();
  const auth = (t: string) => ({ Authorization: `Bearer ${t}` });

  let seq = 0;
  const earn = async (label: string, idempotencyKey = `${label}-${(seq += 1)}-webhook-fixture`) =>
    (
      await request(server())
        .post('/public/loyalty/earn')
        .set({ 'x-caratos-loyalty-key': keyA })
        .send({ phone: MEMBER, amount: 1000, idempotencyKey })
        .expect(200)
    ).body as { entryId: string; idempotent: boolean };

  const deliveryFor = (entryId: string) =>
    prisma.loyaltyWebhookDelivery.findFirstOrThrow({ where: { organisationId: A.org, entryId } });

  beforeAll(async () => {
    await new Promise<void>((resolve) => hook.listen(0, '127.0.0.1', resolve));
    const port = (hook.address() as AddressInfo).port;

    const { AppModule } = await import('../src/app.module');
    const { PrismaService: P } = await import('../src/prisma/prisma.service');
    const { JobsService: J } = await import('../src/jobs/jobs.service');
    const { LoyaltyApiService: L } = await import('../src/loyalty/website/loyalty-api.service');

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
    jobs = app.get(J);
    loyaltyApi = app.get(L);
    await teardown(prisma);

    const hash = await bcrypt.hash(PASSWORD, 10);
    for (const t of [A, B]) {
      await prisma.organisation.create({
        data: { id: t.org, name: t.slug, slug: t.slug, industryPackCode: 'jewellery' },
      });
      await prisma.store.create({
        data: { id: t.store, name: `${t.slug} main`, city: 'Mumbai', organisationId: t.org, timezone: 'Asia/Kolkata' },
      });
      await prisma.integration.create({
        data: { organisationId: t.org, providerCode: 'loyalty_website', name: 'Website', status: 'connected' },
      });
    }
    for (const [id, email, org, store, role] of [
      ['u_lwd_ho', A.ho, A.org, A.store, 'head_office'],
      ['u_lwd_mgr', A.mgr, A.org, A.store, 'store_manager'],
      ['u_lwd_ho_b', B.ho, B.org, B.store, 'head_office'],
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
          userStores: { create: { storeId: store, isPrimary: true } },
        },
      });
    }

    const login = async (email: string) =>
      (await request(server()).post('/auth/login').send({ email, password: PASSWORD }).expect(201)).body
        .token as string;
    hoT = await login(A.ho);
    mgrT = await login(A.mgr);
    hoBT = await login(B.ho);

    keyA = (await request(server()).post('/loyalty/programme/api-key').set(auth(hoT)).expect(201)).body.key;
    secretA = (
      await request(server()).post('/loyalty/programme/signing-secret').set(auth(hoT)).expect(201)
    ).body.secret;
    await request(server())
      .put('/loyalty/programme/settings')
      .set(auth(hoT))
      .send({ earnPoints: 1, earnPerAmount: 100 })
      .expect(200);

    const integration = await prisma.integration.findFirstOrThrow({
      where: { organisationId: A.org, providerCode: 'loyalty_website' },
    });
    await prisma.integration.update({
      where: { id: integration.id },
      data: {
        config: {
          ...(integration.config as Record<string, unknown>),
          webhookUrl: `http://127.0.0.1:${port}/hook?token=${RECEIVER_TOKEN}`,
        },
      },
    });

    await request(server())
      .post('/public/loyalty/members')
      .set({ 'x-caratos-loyalty-key': keyA })
      .send({ phone: MEMBER, name: 'Webhook Member' })
      .expect(201);
  }, 180_000);

  afterAll(async () => {
    if (prisma) await teardown(prisma);
    if (app) await app.close();
    hook.closeAllConnections();
    await new Promise<void>((resolve) => hook.close(() => resolve()));
  });

  // ==========================================================================
  // 1. Delivered
  // ==========================================================================

  let deliveredId = '';
  let deliveredEntry = '';
  let deliveredKey = '';

  it('queues a movement, and a 2xx from the destination is the only thing that marks it delivered', async () => {
    answer = 204;
    deliveredKey = `delivered-${Date.now()}-webhook-fixture`;
    const movement = await earn('delivered', deliveredKey);
    deliveredEntry = movement.entryId;

    const queued = await deliveryFor(movement.entryId);
    // Queued, not sent: nothing has reached the website before the queue runs.
    expect(queued.status).toBe('pending');
    expect(queued.attempts).toBe(0);
    expect(queued.jobId).toBeTruthy();
    deliveredId = queued.id;

    await jobs.drain(20);

    const hits = requestsFor(queued.id);
    expect(hits).toHaveLength(1);
    // Signed with the tenant's secret, over the exact bytes received.
    const signature = hits[0].headers[SIGNATURE_HEADER] as string;
    expect(verifyWebhook(secretA, hits[0].body, signature).valid).toBe(true);
    const sent = JSON.parse(hits[0].body);
    expect(sent.eventId).toBe(queued.id);
    expect(sent.entryId).toBe(movement.entryId);

    const row = await prisma.loyaltyWebhookDelivery.findUniqueOrThrow({ where: { id: queued.id } });
    expect(row.status).toBe('delivered');
    expect(row.responseCode).toBe(204);
    expect(row.attempts).toBe(1);
    expect(row.deliveredAt).toBeTruthy();
    expect(row.nextAttemptAt).toBeNull();
    expect(row.payloadSha256).toBe(createHash('sha256').update(hits[0].body, 'utf8').digest('hex'));
    // The receiver's token lives in the query string, which is never stored.
    expect(row.destination).toMatch(/^http:\/\/127\.0\.0\.1:\d+\/hook$/);

    const entry = await prisma.loyaltyLedgerEntry.findUniqueOrThrow({ where: { id: movement.entryId } });
    expect(entry.webhookedAt).toBeTruthy();
  });

  // ==========================================================================
  // 2. Replays
  // ==========================================================================

  it('replaying the same event creates no second record and no second request', async () => {
    expect(await loyaltyApi.queueAnnouncement(A.org, deliveredEntry)).toBe('exists');

    // The website retrying its own purchase call.
    const replay = await earn('delivered', deliveredKey);
    expect(replay.idempotent).toBe(true);
    expect(replay.entryId).toBe(deliveredEntry);

    const sweep = await request(server())
      .post('/loyalty/programme/announcements/retry')
      .set(auth(hoT))
      .expect(200);
    expect(sweep.body.queued).toBe(0);

    // A delivered event is not retryable.
    const retry = await request(server())
      .post(`/loyalty/programme/webhooks/${deliveredId}/retry`)
      .set(auth(hoT))
      .expect(200);
    expect(retry.body.requeued).toBe(false);
    expect(retry.body.delivery.status).toBe('delivered');

    await jobs.drain(20);
    expect(requestsFor(deliveredId)).toHaveLength(1);
    expect(
      await prisma.loyaltyWebhookDelivery.count({ where: { organisationId: A.org, entryId: deliveredEntry } }),
    ).toBe(1);
  });

  // ==========================================================================
  // 3. Failed, then dead
  // ==========================================================================

  let deadId = '';

  it('a non-2xx is failed with a next retry, then dead after the last attempt — never delivered', async () => {
    const { WEBHOOK_MAX_ATTEMPTS } = await import('../src/loyalty/website/loyalty-api.service');
    answer = 500;
    const movement = await earn('refused');
    deadId = (await deliveryFor(movement.entryId)).id;

    // One job per drain, so each step is exactly one attempt whatever the
    // database's session timezone does to the queue's `runAt <= NOW()`.
    await jobs.drain(1);
    let row = await prisma.loyaltyWebhookDelivery.findUniqueOrThrow({ where: { id: deadId } });
    expect(row.status).toBe('failed');
    expect(row.responseCode).toBe(500);
    expect(row.attempts).toBe(1);
    expect(row.lastError).toContain('HTTP 500');
    expect(row.nextAttemptAt!.getTime()).toBeGreaterThan(Date.now());
    expect(row.deliveredAt).toBeNull();

    for (let attempt = 2; attempt <= WEBHOOK_MAX_ATTEMPTS; attempt++) {
      // Skip the backoff wait, not the attempt: the row becomes due now.
      await prisma.jobTask.update({ where: { id: row.jobId! }, data: { runAt: new Date() } });
      await jobs.drain(1);
      row = await prisma.loyaltyWebhookDelivery.findUniqueOrThrow({ where: { id: deadId } });
    }

    expect(row.status).toBe('dead');
    expect(row.attempts).toBe(WEBHOOK_MAX_ATTEMPTS);
    expect(row.deadAt).toBeTruthy();
    expect(row.nextAttemptAt).toBeNull();
    expect(row.deliveredAt).toBeNull();
    expect(requestsFor(deadId)).toHaveLength(WEBHOOK_MAX_ATTEMPTS);
    expect((await prisma.jobTask.findUniqueOrThrow({ where: { id: row.jobId! } })).status).toBe('dead');

    const entry = await prisma.loyaltyLedgerEntry.findUniqueOrThrow({ where: { id: movement.entryId } });
    expect(entry.webhookedAt).toBeNull();
  });

  it('filters by state and refuses a state that does not exist', async () => {
    const dead = await request(server())
      .get('/loyalty/programme/webhooks?status=dead')
      .set(auth(hoT))
      .expect(200);
    expect(dead.body.items.map((d: { id: string }) => d.id)).toEqual([deadId]);
    expect(dead.body.counts).toMatchObject({ delivered: 1, dead: 1, pending: 0, failed: 0 });

    await request(server()).get('/loyalty/programme/webhooks?status=lost').set(auth(hoT)).expect(400);
  });

  // ==========================================================================
  // 4. Who may see and retry
  // ==========================================================================

  it('a store manager can read the log but not retry', async () => {
    const list = await request(server()).get('/loyalty/programme/webhooks').set(auth(mgrT)).expect(200);
    expect(list.body.items.length).toBe(2);
    await request(server()).post(`/loyalty/programme/webhooks/${deadId}/retry`).set(auth(mgrT)).expect(403);
  });

  it('another tenant cannot list, read or retry', async () => {
    const list = await request(server()).get('/loyalty/programme/webhooks').set(auth(hoBT)).expect(200);
    expect(list.body.items).toEqual([]);
    await request(server()).get(`/loyalty/programme/webhooks/${deadId}`).set(auth(hoBT)).expect(404);
    await request(server()).post(`/loyalty/programme/webhooks/${deadId}/retry`).set(auth(hoBT)).expect(404);

    const row = await prisma.loyaltyWebhookDelivery.findUniqueOrThrow({ where: { id: deadId } });
    expect(row.status).toBe('dead');
  });

  it('never shows a secret, the API key, or the receiver’s token', async () => {
    const list = await request(server()).get('/loyalty/programme/webhooks').set(auth(hoT)).expect(200);
    const detail = await request(server()).get(`/loyalty/programme/webhooks/${deadId}`).set(auth(hoT)).expect(200);
    const credential = await prisma.integrationCredential.findFirstOrThrow({
      where: { organisationId: A.org, kind: 'shared_secret' },
    });

    const everything = JSON.stringify(list.body) + JSON.stringify(detail.body);
    for (const secret of [secretA, keyA, RECEIVER_TOKEN, credential.ciphertext]) {
      expect(everything).not.toContain(secret);
    }
    // Metadata about the payload, never the payload.
    expect(detail.body.payload.sha256).toBe(detail.body.payloadSha256);
    expect(detail.body.payload.fields).toContain('points');
    expect(detail.body).not.toHaveProperty('body');
    expect(detail.body.attemptLog).toHaveLength(5);
    expect(detail.body.attemptLog[4]).toMatchObject({ responseCode: 500 });
  });

  // ==========================================================================
  // 5. Retrying the dead
  // ==========================================================================

  it('retrying a dead event re-queues it once, however many times it is pressed, and delivers once', async () => {
    answer = 200;
    const before = requestsFor(deadId).length;

    const presses = await Promise.all(
      [0, 1, 2].map(() =>
        request(server()).post(`/loyalty/programme/webhooks/${deadId}/retry`).set(auth(hoT)),
      ),
    );
    expect(presses.map((p) => p.status)).toEqual([200, 200, 200]);
    expect(presses.filter((p) => p.body.requeued === true)).toHaveLength(1);

    const pending = await prisma.loyaltyWebhookDelivery.findUniqueOrThrow({ where: { id: deadId } });
    expect(pending.status).toBe('pending');
    expect(pending.manualRetries).toBe(1);

    await jobs.drain(20);
    await jobs.drain(20);

    const hits = requestsFor(deadId);
    expect(hits).toHaveLength(before + 1);
    // The same event id on every attempt, so the receiver can drop a repeat.
    expect(new Set(hits.map((h) => JSON.parse(h.body).eventId))).toEqual(new Set([deadId]));

    const row = await prisma.loyaltyWebhookDelivery.findUniqueOrThrow({ where: { id: deadId } });
    expect(row.status).toBe('delivered');
    expect(row.responseCode).toBe(200);
    expect(row.deadAt).toBeNull();

    const again = await request(server())
      .post(`/loyalty/programme/webhooks/${deadId}/retry`)
      .set(auth(hoT))
      .expect(200);
    expect(again.body.requeued).toBe(false);
    await jobs.drain(20);
    expect(requestsFor(deadId)).toHaveLength(before + 1);

    expect(
      await prisma.auditLog.count({
        where: { organisationId: A.org, action: 'loyalty.webhook_retried', entityId: deadId },
      }),
    ).toBe(1);
  });
});
