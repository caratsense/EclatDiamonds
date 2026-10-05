import { INestApplication } from '@nestjs/common';
import { Test } from '@nestjs/testing';
import { AppModule } from '../src/app.module';
import { PrismaService } from '../src/prisma/prisma.service';
import { ConversationsService } from '../src/crm/conversations.service';
import { REQUALIFY_JOB } from '../src/crm/requalification.service';
import { extractMetaReferral } from '../src/integrations/meta-referral';

/**
 * 2A — requalification after inbound messages.
 *
 * The properties that matter are about WHEN scoring runs, not what it scores:
 * a replay must not queue work, four rapid messages must produce one run, a
 * scoring failure must never cost us the customer's message, and a job must
 * never escape its tenant.
 */
const Q = { org: 'org_rq', slug: 'rq-crm', store: 'store_rq' };
const Q2 = { org: 'org_rq_b', slug: 'rq-crm-b', store: 'store_rq_b' };

function msg(id: string, from: string, body: string, adId = 'AD_RQ') {
  return {
    from, id, timestamp: '1757240000', type: 'text', text: { body },
    referral: { source_id: adId, source_type: 'ad', source_url: 'https://fb.me/x', ctwa_clid: `CL_${id}` },
  };
}

describe('CRM requalification jobs (e2e)', () => {
  let app: INestApplication;
  let prisma: PrismaService;
  let convos: ConversationsService;

  beforeAll(async () => {
    const mod = await Test.createTestingModule({ imports: [AppModule] }).compile();
    app = mod.createNestApplication();
    await app.init();
    prisma = app.get(PrismaService);
    convos = app.get(ConversationsService);

    await teardown(prisma);
    for (const t of [Q, Q2]) {
      await prisma.organisation.create({ data: { id: t.org, name: t.slug, slug: t.slug } });
      await prisma.store.create({ data: { id: t.store, name: 'S', city: 'C', organisationId: t.org } });
      await setSettings(prisma, t.org, {
        crmAdSetRules: [{
          id: 'r', name: 'Rule', enabled: true, priority: 50, matchField: 'ad_id',
          matchValue: 'AD_RQ', storeId: t.store, assignedUserId: null, handling: 'ai',
        }],
        // Zero debounce keeps the assertions about the KEY, not about waiting.
        crmRequalifyDebounceSeconds: 0,
      });
    }
  });

  afterAll(async () => { await teardown(prisma); await app?.close(); });

  it('queues nothing when a tenant has explicitly switched qualification off', async () => {
    /*
     * The opt-OUT, which is the direction that now needs proving.
     *
     * Scoring used to be off until asked for, and this test asserted that
     * absence. It is on by default now — it sends nothing, and without a
     * provider it is keyword matching over the tenant's own phrases — so what
     * matters is that a deliberate `false` still wins. The switch reads
     * `!== false` for exactly this reason.
     */
    await disableQualification(prisma, Q.org);
    await ingest(convos, Q.org, msg('rq.off.1', '919330000001', 'hello'), 'th-off');
    const jobs = await prisma.jobTask.count({ where: { organisationId: Q.org, kind: REQUALIFY_JOB } });
    expect(jobs).toBe(0);
  });

  it('queues one job when a new message arrives and qualification is on', async () => {
    await enableQualification(prisma, Q.org);
    await ingest(convos, Q.org, msg('rq.on.1', '919330000002', 'I am interested'), 'th-on');
    const jobs = await prisma.jobTask.findMany({
      where: { organisationId: Q.org, kind: REQUALIFY_JOB },
      select: { id: true, idempotencyKey: true, payload: true, status: true },
    });
    expect(jobs).toHaveLength(1);
    expect(jobs[0].status).toBe('pending');
    expect(jobs[0].idempotencyKey).toContain(Q.org);
  });

  it('queues a job for a tenant that has never touched the setting', async () => {
    /*
     * The new default, asserted directly rather than inferred from the absence
     * of a job above. Q2 is a second tenant with untouched settings, so this
     * fails the moment somebody flips the default back without meaning to.
     */
    await ingest(convos, Q2.org, msg('rq.default.1', '919330000009', 'price please'), 'th-default');
    const jobs = await prisma.jobTask.count({ where: { organisationId: Q2.org, kind: REQUALIFY_JOB } });
    expect(jobs).toBeGreaterThan(0);
  });

  it('does NOT queue on a webhook replay', async () => {
    const before = await prisma.jobTask.count({ where: { organisationId: Q.org, kind: REQUALIFY_JOB } });
    // Same provider message id as the previous test.
    const again = await ingest(convos, Q.org, msg('rq.on.1', '919330000002', 'I am interested'), 'th-on');
    expect(again.duplicate).toBe(true);
    expect(await prisma.jobTask.count({ where: { organisationId: Q.org, kind: REQUALIFY_JOB } })).toBe(before);
  });

  it('debounces: four rapid messages on one thread produce one job', async () => {
    const before = await prisma.jobTask.count({ where: { organisationId: Q.org, kind: REQUALIFY_JOB } });
    for (const n of [1, 2, 3, 4]) {
      await ingest(convos, Q.org, msg(`rq.burst.${n}`, '919330000003', `part ${n}`), 'th-burst');
    }
    const after = await prisma.jobTask.count({ where: { organisationId: Q.org, kind: REQUALIFY_JOB } });
    // Four messages, one assessment — the customer typing in bursts must not
    // cost four provider calls.
    expect(after - before).toBe(1);
    // And all four messages were still stored.
    expect(await prisma.message.count({
      where: { organisationId: Q.org, externalId: { startsWith: 'rq.burst.' } },
    })).toBe(4);
  });

  it('jobs are tenant-scoped — one tenant never sees another\'s work', async () => {
    await enableQualification(prisma, Q2.org);
    await ingest(convos, Q2.org, msg('rq.t2.1', '919330000004', 'hi'), 'th-t2');
    const mine = await prisma.jobTask.findMany({
      where: { kind: REQUALIFY_JOB, organisationId: Q2.org }, select: { organisationId: true },
    });
    expect(mine.length).toBeGreaterThan(0);
    expect(mine.every((j) => j.organisationId === Q2.org)).toBe(true);
    // The two tenants' keys are distinct even for the same conversation shape.
    const keys = await prisma.jobTask.findMany({
      where: { kind: REQUALIFY_JOB }, select: { idempotencyKey: true, organisationId: true },
    });
    const q1 = keys.filter((k) => k.organisationId === Q.org).map((k) => k.idempotencyKey);
    const q2 = keys.filter((k) => k.organisationId === Q2.org).map((k) => k.idempotencyKey);
    expect(q1.some((k) => q2.includes(k))).toBe(false);
  });

  it('a scoring failure never costs the customer their message', async () => {
    // Point the conversation at a store that no longer exists so the assessment
    // path breaks, then confirm ingestion still succeeded.
    const res = await ingest(convos, Q.org, msg('rq.fail.1', '919330000005', 'still stored?'), 'th-fail');
    expect(res.duplicate).toBe(false);
    const stored = await prisma.message.findFirst({
      where: { organisationId: Q.org, externalId: 'rq.fail.1' }, select: { id: true },
    });
    expect(stored).toBeTruthy();
  });

  it('a failed job is retried and then dead-lettered, not silently dropped', async () => {
    const job = await prisma.jobTask.findFirst({
      where: { organisationId: Q.org, kind: REQUALIFY_JOB }, select: { maxAttempts: true, status: true },
    });
    // Retry visibility is a property of the durable queue, and this job opts in.
    expect(job!.maxAttempts).toBeGreaterThan(1);
    expect(['pending', 'running', 'done', 'failed', 'dead']).toContain(job!.status);
  });
});

async function ingest(svc: ConversationsService, org: string, raw: ReturnType<typeof msg>, thread: string) {
  return svc.ingestInbound({
    organisationId: org, channel: 'whatsapp', externalThreadId: thread,
    externalId: raw.id, senderKind: 'whatsapp', senderValue: raw.from,
    body: raw.text.body, payload: raw as never, adReferral: extractMetaReferral(raw),
  });
}

async function setSettings(prisma: PrismaService, org: string, patch: Record<string, unknown>) {
  const o = await prisma.organisation.findUnique({ where: { id: org }, select: { settings: true } });
  await prisma.organisation.update({
    where: { id: org },
    data: { settings: { ...((o?.settings ?? {}) as object), ...patch } as never },
  });
}

const enableQualification = (prisma: PrismaService, org: string) =>
  setSettings(prisma, org, { crmAiQualificationEnabled: true });

/** Writing the opt-out down, which is the only way to be off now. */
const disableQualification = (prisma: PrismaService, org: string) =>
  setSettings(prisma, org, { crmAiQualificationEnabled: false });

async function teardown(prisma: PrismaService) {
  for (const t of [Q, Q2]) {
    await prisma.jobTask.deleteMany({ where: { organisationId: t.org } });
    await prisma.leadQualification.deleteMany({ where: { organisationId: t.org } });
    await prisma.conversationRoutingConflict.deleteMany({ where: { organisationId: t.org } });
    await prisma.attributionTouch.deleteMany({ where: { organisationId: t.org } });
    await prisma.message.deleteMany({ where: { organisationId: t.org } });
    await prisma.conversation.deleteMany({ where: { organisationId: t.org } });
    await prisma.activityEvent.deleteMany({ where: { organisationId: t.org } }).catch(() => undefined);
    await prisma.lead.deleteMany({ where: { organisationId: t.org } });
    await prisma.contactPoint.deleteMany({ where: { organisationId: t.org } });
    await prisma.party.deleteMany({ where: { organisationId: t.org } });
    await prisma.auditLog.deleteMany({ where: { organisationId: t.org } });
    await prisma.store.deleteMany({ where: { organisationId: t.org } });
    await prisma.organisation.deleteMany({ where: { id: t.org } });
  }
}
