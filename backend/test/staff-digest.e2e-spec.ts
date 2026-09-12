import { INestApplication, ValidationPipe } from '@nestjs/common';
import { Test } from '@nestjs/testing';

import { businessDate, dateOnly } from '../src/common/tz.util';
import request = require('supertest');
import * as bcrypt from 'bcryptjs';

/**
 * The morning call list.
 *
 * From the meeting: staff should get their day's follow-ups on WhatsApp before
 * they open anything. The properties that decide whether that is safe to run
 * unattended every morning:
 *
 *  1. NOBODY GETS IT TWICE. The unique key on (userId, businessDate) is the
 *     guard, so a retry or a second replica loses the race rather than sending
 *     a duplicate. Asserted by running the job twice.
 *
 *  2. THE IN-APP NOTIFICATION ALWAYS ARRIVES. It needs no phone, no template and
 *     no provider, so it is the channel that can be relied on. WhatsApp is the
 *     optional extra.
 *
 *  3. A SKIP SAYS WHY. No phone, WhatsApp off, no approved template, unhealthy
 *     sender — each records its own reason instead of failing silently, because
 *     "why did nobody get a message" is the question teams actually ask.
 *
 *  4. IT RUNS ON THE BRANCH'S CLOCK. The configured hour is read in the store's
 *     timezone, not the server's.
 *
 *  5. NOBODY IS MESSAGED WITH NOTHING TO DO. A person with an empty list gets no
 *     digest at all.
 *
 *  6. THE PREVIEW IS YOUR OWN. It exists so somebody can see what they will get,
 *     not so they can read a colleague's customers.
 */

const PASSWORD = 'password123';

const A = {
  org: 'org_dig_a', slug: 'dig-a', store: 'store_dig_a',
  ho: 'ho.dig@dig-a.local', rep: 'rep.dig@dig-a.local', quiet: 'quiet.dig@dig-a.local',
};

async function teardown(prisma: import('../src/prisma/prisma.service').PrismaService) {
  await prisma.staffDigestRun.deleteMany({ where: { organisationId: A.org } });
  await prisma.staffDigestSettings.deleteMany({ where: { organisationId: A.org } });
  await prisma.notification.deleteMany({
    where: { user: { organisationId: A.org } },
  });
  await prisma.auditLog.deleteMany({ where: { organisationId: A.org } });
  await prisma.leadFollowUp.deleteMany({ where: { lead: { organisationId: A.org } } });
  await prisma.lead.deleteMany({ where: { organisationId: A.org } });
  await prisma.userStore.deleteMany({ where: { user: { organisationId: A.org } } });
  await prisma.user.deleteMany({ where: { organisationId: A.org } });
  await prisma.store.deleteMany({ where: { organisationId: A.org } });
  await prisma.organisation.deleteMany({ where: { id: A.org } });
}

describe('Staff digest (e2e)', () => {
  let app: INestApplication;
  let prisma: import('../src/prisma/prisma.service').PrismaService;
  let digest: import('../src/crm/staff-digest.service').StaffDigestService;
  let hoA: string;
  let repA: string;

  const server = () => app.getHttpServer();
  const auth = (t: string) => ({ Authorization: `Bearer ${t}` });

  /*
   * Anchored to the real today, not a fixed date.
   *
   * The preview endpoint reads the actual clock (it is answering "what do I owe
   * now"), so a fixture pinned to a future month would give the run and the
   * preview two different days and only one of them would find anything.
   */
  /*
   * TODAY IN THE BRANCH'S TIMEZONE, not in UTC.
   *
   * This read `new Date().toISOString()`, which is the UTC date. The branch is
   * Asia/Kolkata (UTC+5:30), so between 18:30Z and midnight — 00:00 to 05:30
   * for anybody actually in the shop — the two disagree by a day. The fixture
   * would then file "due today" against yesterday's date while the preview,
   * which asks the same question in the branch's zone, correctly reported it
   * overdue. The suite went red for five and a half hours out of every
   * twenty-four for reasons nothing in the product had changed.
   */
  const ymd = dateOnly(businessDate(new Date(), 'Asia/Kolkata'));
  /** 09:00 in Asia/Kolkata is 03:30 UTC. */
  const nineAmIst = new Date(`${ymd}T03:30:00.000Z`);
  const daysAgo = (n: number) =>
    new Date(new Date(`${ymd}T00:00:00.000Z`).getTime() - n * 86_400_000);

  beforeAll(async () => {
    const { AppModule } = await import('../src/app.module');
    const { PrismaService } = await import('../src/prisma/prisma.service');
    const { StaffDigestService } = await import('../src/crm/staff-digest.service');
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
    digest = app.get(StaffDigestService);
    await teardown(prisma);

    const hash = await bcrypt.hash(PASSWORD, 10);

    await prisma.organisation.create({
      data: { id: A.org, name: 'Dig A', slug: A.slug, industryPackCode: 'retail' },
    });
    await prisma.store.create({
      data: { id: A.store, name: 'Counter', city: 'Mumbai', organisationId: A.org, timezone: 'Asia/Kolkata' },
    });
    for (const [id, email, role, phone] of [
      ['u_dig_ho', A.ho, 'head_office', null],
      // A phone on file, so the WhatsApp gate can get past the "no number" step.
      ['u_dig_rep', A.rep, 'salesperson', '919812360001'],
      ['u_dig_quiet', A.quiet, 'salesperson', '919812360002'],
    ] as const) {
      await prisma.user.create({
        data: {
          id, email, name: id, role: role as never, passwordHash: hash, isActive: true,
          approvalStatus: 'approved', organisationId: A.org, phone,
          userStores: { create: { storeId: A.store, isPrimary: true } },
        },
      });
    }

    // Two follow-ups owed by the rep: one overdue, one due today. The "quiet"
    // salesperson owns nothing, on purpose.
    const lead = async (id: string, ref: string, name: string, due: string) => {
      await prisma.lead.create({
        data: {
          id, organisationId: A.org, storeId: A.store, ref, customerName: name,
          source: 'walk_in', stage: 'inquiry', ownerId: 'u_dig_rep',
          followUps: { create: { storeId: A.store, seq: 1, dueDate: new Date(due) } },
        },
      });
    };
    await lead('ld_dig_1', 'LD-DIG-1', 'Overdue Customer', daysAgo(4).toISOString());
    await lead('ld_dig_2', 'LD-DIG-2', 'Today Customer', daysAgo(0).toISOString());

    const login = async (email: string) =>
      (await request(server()).post('/auth/login').send({ email, password: PASSWORD }).expect(201))
        .body.token;
    hoA = await login(A.ho);
    repA = await login(A.rep);
  }, 120_000);

  afterAll(async () => {
    if (prisma) await teardown(prisma);
    if (app) await app.close();
  });

  it('is off until a manager turns it on', async () => {
    const res = await request(server()).get('/staff-digest/settings').set(auth(hoA)).expect(200);
    expect(res.body.enabled).toBe(false);

    const ran = await digest.runForStore(A.org, A.store, 'Asia/Kolkata', nineAmIst);
    expect(ran.skipped).toBe('disabled');
    expect(await prisma.staffDigestRun.count({ where: { organisationId: A.org } })).toBe(0);
  });

  it('a salesperson cannot change when the whole team gets messaged', async () => {
    await request(server())
      .put('/staff-digest/settings')
      .set(auth(repA))
      .send({ enabled: true })
      .expect(403);
  });

  it('a manager enables it, and the change is audited', async () => {
    await request(server())
      .put('/staff-digest/settings')
      .set(auth(hoA))
      .send({ enabled: true, sendHourLocal: 9 })
      .expect(200);

    const audit = await prisma.auditLog.findFirst({
      where: { organisationId: A.org, action: 'crm.staff_digest_settings_changed' },
    });
    expect(audit).toBeTruthy();
  });

  it('runs on the branch clock, not the server clock', async () => {
    // 09:00 UTC is 14:30 in Kolkata — not the configured hour.
    const ran = await digest.runForStore(A.org, A.store, 'Asia/Kolkata', new Date(`${ymd}T09:00:00.000Z`));
    expect(ran.skipped).toBe('not-the-hour');
    expect(await prisma.staffDigestRun.count({ where: { organisationId: A.org } })).toBe(0);
  });

  it('sends at nine local, in-app, with the right counts', async () => {
    const ran = await digest.runForStore(A.org, A.store, 'Asia/Kolkata', nineAmIst);
    expect(ran.sent).toBe(1); // only the rep owes anything

    const run = await prisma.staffDigestRun.findFirst({
      where: { organisationId: A.org, userId: 'u_dig_rep' },
    });
    expect(run).toBeTruthy();
    expect(run?.inAppNotified).toBe(true);
    expect(run?.overdueCount).toBe(1);
    expect(run?.dueCount).toBe(1);

    const note = await prisma.notification.findFirst({
      where: { userId: 'u_dig_rep', kind: 'reminder' },
    });
    expect(note).toBeTruthy();
    expect(note?.title).toContain('2 follow-ups');
  });

  it('a salesperson who owes nothing is not messaged at all', async () => {
    const run = await prisma.staffDigestRun.findFirst({
      where: { organisationId: A.org, userId: 'u_dig_quiet' },
    });
    expect(run).toBeNull();
  });

  it('running the same morning twice does not send a second time', async () => {
    const before = await prisma.notification.count({
      where: { userId: 'u_dig_rep', kind: 'reminder' },
    });
    const ran = await digest.runForStore(A.org, A.store, 'Asia/Kolkata', nineAmIst);
    expect(ran.sent).toBe(0);

    expect(
      await prisma.staffDigestRun.count({ where: { organisationId: A.org, userId: 'u_dig_rep' } }),
    ).toBe(1);
    expect(
      await prisma.notification.count({
        where: { userId: 'u_dig_rep', kind: 'reminder' },
      }),
    ).toBe(before);
  });

  it('the WhatsApp half is skipped with a reason, not silently', async () => {
    const run = await prisma.staffDigestRun.findFirst({
      where: { organisationId: A.org, userId: 'u_dig_rep' },
    });
    expect(run?.whatsappStatus).toBe('skipped');
    // WhatsApp is off for this tenant, and that is what it says.
    expect(run?.whatsappReason).toMatch(/off for this organisation/i);
  });

  it('turning WhatsApp on without a template still skips, and names the missing piece', async () => {
    await prisma.staffDigestRun.deleteMany({ where: { organisationId: A.org } });
    await request(server())
      .put('/staff-digest/settings')
      .set(auth(hoA))
      .send({ whatsappEnabled: true })
      .expect(200);

    await digest.runForStore(A.org, A.store, 'Asia/Kolkata', nineAmIst);
    const run = await prisma.staffDigestRun.findFirst({
      where: { organisationId: A.org, userId: 'u_dig_rep' },
    });
    expect(run?.whatsappStatus).toBe('skipped');
    expect(run?.whatsappReason).toMatch(/template/i);
    // And the in-app half still went out regardless.
    expect(run?.inAppNotified).toBe(true);
  });

  it('the preview shows my own list and says why WhatsApp would not send', async () => {
    const res = await request(server()).get('/staff-digest/preview').set(auth(repA)).expect(200);
    expect(res.body.userId).toBe('u_dig_rep');
    expect(res.body.overdue).toHaveLength(1);
    expect(res.body.due).toHaveLength(1);
    expect(res.body.overdue[0].customerName).toBe('Overdue Customer');
    expect(res.body.whatsappBody).toBeNull();
    expect(res.body.whatsappSkipReason).toMatch(/template/i);
  });

  it("the preview never shows somebody else's customers", async () => {
    const res = await request(server()).get('/staff-digest/preview').set(auth(hoA)).expect(200);
    // Head office owns no follow-ups here, so their own preview is empty —
    // it is not a view of the team's.
    expect(res.body.userId).toBe('u_dig_ho');
    expect(res.body.due).toHaveLength(0);
    expect(res.body.overdue).toHaveLength(0);
  });
});
