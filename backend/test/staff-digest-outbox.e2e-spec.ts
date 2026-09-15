import { INestApplication, ValidationPipe } from '@nestjs/common';
import { Test } from '@nestjs/testing';
import { Role } from '@prisma/client';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import request = require('supertest');
import * as bcrypt from 'bcryptjs';

import { AppModule } from '../src/app.module';
import type { AuthUser } from '../src/common/auth-user';
import { businessDate, dateOnly } from '../src/common/tz.util';
import { StaffDigestService } from '../src/crm/staff-digest.service';
import { WhatsAppService } from '../src/integrations/whatsapp.service';
import { JobsService } from '../src/jobs/jobs.service';
import { OmnichannelService } from '../src/omnichannel/omnichannel.service';
import { PrismaService } from '../src/prisma/prisma.service';

/**
 * The morning digest's WhatsApp half goes through the outbox.
 *
 *  1. THE DIGEST CANNOT REACH THE PROVIDER ITSELF. StaffDigestService has no
 *     WhatsApp client, and running it sends nothing: it leaves an outbox message
 *     and a delivery job, and only the job's worker calls the provider.
 *  2. THE OUTBOX DECIDES. Provider-approved template, the staff member's own
 *     number, the branch's sender, consent — refused with a reason otherwise.
 *  3. A RETRY IS NOT A SECOND DIGEST. Re-running the morning, or resuming a run
 *     that crashed after its claim, yields one message and one job.
 *  4. THE WORKER RE-CHECKS THE PERSON. Deactivated after queuing → not messaged.
 *  5. RECEIPTS AND AUDIT land on the outbox message like any other.
 *  6. A STAFF THREAD IS NOT IN THE CUSTOMER INBOX.
 */

const PASSWORD = 'password123';
const A = { org: 'org_dgo_a', slug: 'dgo-a', store: 'store_dgo_a', integ: 'int_dgo_a' };
const TEMPLATE = 'staff_morning_digest';

class FakeWhatsApp {
  sends: { to: string; name: string; languageCode?: string; route?: { storeId?: string | null } }[] = [];
  nextResult: { delivered: boolean; dryRun: boolean; messageId?: string; error?: string } = {
    delivered: true,
    dryRun: false,
    messageId: 'wamid.digest.1',
  };
  async sendText() {
    throw new Error('a staff digest never sends free text');
  }
  async sendTemplate(
    _org: string,
    to: string,
    name: string,
    languageCode?: string,
    _components?: unknown,
    route?: { storeId?: string | null },
  ) {
    this.sends.push({ to, name, languageCode, route });
    const n = this.sends.length;
    return { ...this.nextResult, messageId: this.nextResult.messageId ? `wamid.digest.${n}` : undefined, to };
  }
  async enabledFor() {
    return true;
  }
}

async function teardown(prisma: PrismaService) {
  const org = A.org;
  await prisma.staffDigestRun.deleteMany({ where: { organisationId: org } });
  await prisma.staffDigestSettings.deleteMany({ where: { organisationId: org } });
  await prisma.notification.deleteMany({ where: { user: { organisationId: org } } });
  await prisma.message.deleteMany({ where: { organisationId: org } });
  await prisma.conversation.deleteMany({ where: { organisationId: org } });
  await prisma.activityEvent.deleteMany({ where: { organisationId: org } });
  await prisma.jobTask.deleteMany({ where: { organisationId: org } });
  await prisma.auditLog.deleteMany({ where: { organisationId: org } });
  await prisma.leadFollowUp.deleteMany({ where: { lead: { organisationId: org } } });
  await prisma.lead.deleteMany({ where: { organisationId: org } });
  await prisma.user.updateMany({ where: { organisationId: org }, data: { partyId: null } });
  await prisma.contactPoint.deleteMany({ where: { organisationId: org } });
  await prisma.party.deleteMany({ where: { organisationId: org } });
  await prisma.integrationAsset.deleteMany({ where: { organisationId: org } });
  await prisma.integration.deleteMany({ where: { organisationId: org } });
  await prisma.userStore.deleteMany({ where: { user: { organisationId: org } } });
  await prisma.user.deleteMany({ where: { organisationId: org } });
  await prisma.store.deleteMany({ where: { organisationId: org } });
  await prisma.organisation.deleteMany({ where: { id: org } });
}

describe('Staff digest through the outbox (e2e)', () => {
  let app: INestApplication;
  let prisma: PrismaService;
  let digest: StaffDigestService;
  let jobs: JobsService;
  let omnichannel: OmnichannelService;
  const whatsapp = new FakeWhatsApp();
  let hoToken = '';

  const ymd = dateOnly(businessDate(new Date(), 'Asia/Kolkata'));
  const nineAmIst = new Date(`${ymd}T03:30:00.000Z`);
  const today = new Date(`${ymd}T00:00:00.000Z`);

  const ho: AuthUser = {
    id: 'u_dgo_ho', name: 'HO', email: 'ho@dgo-a.local', role: Role.head_office,
    organisationId: A.org, storeIds: [A.store], allStores: true,
  };

  const owe = async (ownerId: string, ref: string) =>
    prisma.lead.create({
      data: {
        organisationId: A.org, storeId: A.store, ref, customerName: `Customer ${ref}`,
        source: 'walk_in', stage: 'inquiry', ownerId,
        followUps: { create: { storeId: A.store, seq: 1, dueDate: today } },
      },
    });

  const template = (providerStatus: string) =>
    prisma.integrationAsset.upsert({
      where: { id: 'asset_dgo_digest' },
      create: {
        id: 'asset_dgo_digest', organisationId: A.org, integrationId: A.integ, kind: 'message_template',
        externalId: `${TEMPLATE}:en`, name: TEMPLATE, isActive: true,
        providerOwnershipVerified: providerStatus === 'APPROVED', lastVerifiedAt: new Date(),
        metadata: {
          channel: 'whatsapp', languageCode: 'en', category: 'utility', approvalStatus: 'pending',
          variables: [], recordedAt: new Date().toISOString(), providerStatus,
          providerSyncedAt: new Date().toISOString(),
        },
      },
      update: {
        lastVerifiedAt: new Date(),
        metadata: {
          channel: 'whatsapp', languageCode: 'en', category: 'utility', approvalStatus: 'pending',
          variables: [], recordedAt: new Date().toISOString(), providerStatus,
          providerSyncedAt: new Date().toISOString(),
        },
      },
    });

  const runFor = (userId: string) =>
    prisma.staffDigestRun.findUnique({ where: { userId_businessDate: { userId, businessDate: today } } });

  beforeAll(async () => {
    const mod = await Test.createTestingModule({ imports: [AppModule] })
      .overrideProvider(WhatsAppService)
      .useValue(whatsapp)
      .compile();
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
    jobs = app.get(JobsService);
    omnichannel = app.get(OmnichannelService);
    await teardown(prisma);

    await prisma.organisation.create({
      data: { id: A.org, name: 'Digest Outbox', slug: A.slug, industryPackCode: 'retail', country: 'IN' },
    });
    await prisma.store.create({
      data: { id: A.store, name: 'Main', city: 'Mumbai', timezone: 'Asia/Kolkata', organisationId: A.org },
    });
    await prisma.integration.create({
      data: {
        id: A.integ, organisationId: A.org, providerCode: 'whatsapp_cloud', name: 'WhatsApp',
        status: 'connected', config: { whatsappBusinessAccountId: '110022003300' },
      },
    });
    const hash = await bcrypt.hash(PASSWORD, 10);
    for (const [id, email, role, phone] of [
      ['u_dgo_ho', 'ho@dgo-a.local', 'head_office', null],
      ['u_dgo_r1', 'r1@dgo-a.local', 'salesperson', '9812370001'],
      ['u_dgo_r2', 'r2@dgo-a.local', 'salesperson', '9812370002'],
      ['u_dgo_r3', 'r3@dgo-a.local', 'salesperson', '9812370003'],
      ['u_dgo_r4', 'r4@dgo-a.local', 'salesperson', 'not-a-number'],
    ] as const) {
      await prisma.user.create({
        data: {
          id, email, name: `${id} Person`, role: role as never, passwordHash: hash, isActive: true,
          approvalStatus: 'approved', organisationId: A.org, phone,
          userStores: { create: { storeId: A.store, isPrimary: true } },
        },
      });
    }
    await owe('u_dgo_r1', 'DGO-1');
    await prisma.staffDigestSettings.create({
      data: {
        organisationId: A.org, enabled: true, sendHourLocal: 9, whatsappEnabled: true,
        templateName: TEMPLATE, templateLanguage: 'en',
      },
    });
    await template('APPROVED');
    hoToken = (
      await request(app.getHttpServer()).post('/auth/login').send({ email: 'ho@dgo-a.local', password: PASSWORD }).expect(201)
    ).body.token;
  }, 120_000);

  afterAll(async () => {
    if (prisma) await teardown(prisma);
    if (app) await app.close();
  });

  it('has no WhatsApp client to call', () => {
    // Structural: the only way to the provider is through the outbox.
    const params = (Reflect.getMetadata('design:paramtypes', StaffDigestService) ?? []) as unknown[];
    expect(params).not.toContain(WhatsAppService);
    const source = readFileSync(join(__dirname, '../src/crm/staff-digest.service.ts'), 'utf8');
    expect(source).not.toMatch(/WhatsAppService|sendTemplate\(|sendText\(/);
  });

  it('queues an outbox message and a job, and sends nothing itself', async () => {
    const ran = await digest.runForStore(A.org, A.store, 'Asia/Kolkata', nineAmIst);
    expect(ran.sent).toBe(1);
    expect(whatsapp.sends).toHaveLength(0);

    const run = await runFor('u_dgo_r1');
    expect(run?.whatsappStatus).toBe('queued');
    expect(run?.whatsappMessageId).toBeTruthy();
    expect(run?.inAppNotified).toBe(true);

    const message = await prisma.message.findUniqueOrThrow({
      where: { id: run!.whatsappMessageId! },
      include: { conversation: true },
    });
    expect(message.status).toBe('queued');
    expect(message.direction).toBe('outbound');
    expect(message.conversation.audience).toBe('staff');
    expect(message.conversation.storeId).toBe(A.store);
    // No customer names in the outbox row: it is read on lock screens.
    expect(message.body).not.toContain('Customer');

    const job = await prisma.jobTask.findFirst({ where: { organisationId: A.org, kind: 'omnichannel.deliver' } });
    expect(job?.status).toBe('pending');

    const audit = await prisma.auditLog.findFirst({
      where: { organisationId: A.org, action: 'omnichannel.staff_notice_queued' },
    });
    expect(audit?.systemActorId).toBe('staff_digest');
  });

  it('delivers through the worker, to the staff number, from the branch sender', async () => {
    await jobs.drain(10);
    expect(whatsapp.sends).toHaveLength(1);
    expect(whatsapp.sends[0]).toMatchObject({ to: '919812370001', name: TEMPLATE, languageCode: 'en' });
    expect(whatsapp.sends[0].route?.storeId).toBe(A.store);

    const run = await runFor('u_dgo_r1');
    const message = await prisma.message.findUniqueOrThrow({ where: { id: run!.whatsappMessageId! } });
    expect(message.status).toBe('sent');
    expect(message.externalId).toBe('wamid.digest.1');
  });

  it('applies the delivery receipt to the same outbox message', async () => {
    await omnichannel.applyDeliveryReceipt({
      organisationId: A.org, providerMessageId: 'wamid.digest.1', status: 'delivered',
    });
    const run = await runFor('u_dgo_r1');
    const message = await prisma.message.findUniqueOrThrow({ where: { id: run!.whatsappMessageId! } });
    expect(message.status).toBe('delivered');
  });

  it('a second run the same morning queues nothing and sends nothing', async () => {
    const before = await prisma.message.count({ where: { organisationId: A.org } });
    const ran = await digest.runForStore(A.org, A.store, 'Asia/Kolkata', nineAmIst);
    expect(ran.sent).toBe(0);
    await jobs.drain(10);
    expect(await prisma.message.count({ where: { organisationId: A.org } })).toBe(before);
    expect(whatsapp.sends).toHaveLength(1);
  });

  it('a run that crashed after its claim resumes once, not twice', async () => {
    await owe('u_dgo_r2', 'DGO-2');
    // The claim exists, nothing after it happened.
    await prisma.staffDigestRun.create({
      data: {
        organisationId: A.org, userId: 'u_dgo_r2', storeId: A.store, businessDate: today,
        dueCount: 1, whatsappStatus: 'pending', inAppNotified: false,
      },
    });
    await digest.runForStore(A.org, A.store, 'Asia/Kolkata', nineAmIst);
    await digest.runForStore(A.org, A.store, 'Asia/Kolkata', nineAmIst);

    const run = await runFor('u_dgo_r2');
    expect(run?.whatsappStatus).toBe('queued');
    expect(await prisma.notification.count({ where: { userId: 'u_dgo_r2', kind: 'reminder' } })).toBe(1);
    const staffThreads = await prisma.conversation.findMany({
      where: { organisationId: A.org, audience: 'staff', externalThreadId: { contains: 'u_dgo_r2' } },
      include: { messages: true },
    });
    expect(staffThreads).toHaveLength(1);
    expect(staffThreads[0].messages).toHaveLength(1);
  });

  it('the worker re-checks the person: deactivated after queuing, not messaged', async () => {
    const sendsBefore = whatsapp.sends.length;
    await prisma.user.update({ where: { id: 'u_dgo_r2' }, data: { isActive: false } });
    await jobs.drain(10);
    expect(whatsapp.sends).toHaveLength(sendsBefore);
    const run = await runFor('u_dgo_r2');
    const message = await prisma.message.findUniqueOrThrow({ where: { id: run!.whatsappMessageId! } });
    expect(message.status).toBe('failed');
    expect(message.error).toMatch(/recipient_missing/);
    await prisma.user.update({ where: { id: 'u_dgo_r2' }, data: { isActive: true } });
  });

  it('refuses an unusable staff number with a reason, queuing nothing', async () => {
    await owe('u_dgo_r4', 'DGO-4');
    await digest.runForStore(A.org, A.store, 'Asia/Kolkata', nineAmIst);
    const run = await runFor('u_dgo_r4');
    expect(run?.whatsappStatus).toBe('refused');
    expect(run?.whatsappReason).toMatch(/usable WhatsApp number/i);
    expect(run?.whatsappMessageId).toBeNull();
    expect(run?.inAppNotified).toBe(true);
  });

  it('refuses when the provider has not approved the template', async () => {
    await template('PAUSED');
    const result = await omnichannel.queueStaffNotice({
      organisationId: A.org, storeId: A.store, recipientUserId: 'u_dgo_r3', templateName: TEMPLATE,
      languageCode: 'en', templateComponents: [], idempotencyKey: 'dgo-paused', summary: 'x',
    });
    expect(result).toMatchObject({ queued: false, code: 'template_unavailable' });
    expect((result as { reason: string }).reason).toMatch(/paused/i);
    await template('APPROVED');
  });

  it('refuses a staff member who opted out as a customer', async () => {
    const party = await prisma.party.create({
      data: { organisationId: A.org, storeId: A.store, name: 'Staff Who Shops', phone: '9812370003' },
    });
    await prisma.user.update({ where: { id: 'u_dgo_r3' }, data: { partyId: party.id } });
    await omnichannel.recordConsent(ho, {
      partyId: party.id, channel: 'whatsapp', purpose: 'all', status: 'revoked', source: 'verbal',
    } as never);
    const result = await omnichannel.queueStaffNotice({
      organisationId: A.org, storeId: A.store, recipientUserId: 'u_dgo_r3', templateName: TEMPLATE,
      languageCode: 'en', templateComponents: [], idempotencyKey: 'dgo-optout', summary: 'x',
    });
    expect(result).toMatchObject({ queued: false, code: 'recipient_opted_out' });
  });

  it('refuses a person from outside the organisation', async () => {
    const result = await omnichannel.queueStaffNotice({
      organisationId: A.org, storeId: A.store, recipientUserId: 'someone-else', templateName: TEMPLATE,
      languageCode: 'en', templateComponents: [], idempotencyKey: 'dgo-stranger', summary: 'x',
    });
    expect(result).toMatchObject({ queued: false, code: 'recipient_missing' });
  });

  it('keeps staff threads out of the customer inbox', async () => {
    const staffThread = await prisma.conversation.findFirstOrThrow({
      where: { organisationId: A.org, audience: 'staff' },
    });
    const list = await request(app.getHttpServer())
      .get('/crm/conversations')
      .set({ Authorization: `Bearer ${hoToken}` })
      .expect(200);
    const rows = Array.isArray(list.body) ? list.body : list.body.items ?? list.body.rows ?? [];
    expect(rows.map((r: { id: string }) => r.id)).not.toContain(staffThread.id);
    await request(app.getHttpServer())
      .get(`/crm/conversations/${staffThread.id}`)
      .set({ Authorization: `Bearer ${hoToken}` })
      .expect(404);
  });
});
